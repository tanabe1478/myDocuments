import { EditorState, type Extension } from '@codemirror/state';
import { matchesShortcut, parseShortcut, type KeyEventLike, type ParsedShortcut } from './shortcut';
import {
  SETTINGS_PLACEMENTS,
  type CommandContext,
  type EditorExtensionEnvironment,
  type EditorExtensionRegistration,
  type Plugin,
  type PluginContext,
  type SettingDefinition,
  type SettingHandle,
  type SettingsPlacement,
} from './types';
import { PLUGIN_API_VERSION } from './version';

/**
 * active: 動いている。
 * stopped: 例外などで止めた（activate の例外なら登録は全部外れる。動作中の例外なら、設定の定義だけ残す）。
 * incompatible: API の版や宣言が合わず、読み込まなかった。
 */
export type PluginStatus = 'active' | 'stopped' | 'incompatible';

export interface PluginRecord {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly status: PluginStatus;
  /** stopped と incompatible の理由。 */
  readonly reason: string | null;
}

/** ホストが読む登録の一覧。コールバックは、例外を出したら部品を止めて既定の結果を返す（呼び出し側で try/catch しなくてよい）。 */
export interface RegisteredEditorExtension {
  readonly pluginId: string;
  readonly settingKey: string;
  readonly defaultValue: unknown;
  /** 文書の種類が変わったとき、ホストが拡張を作り直すか。 */
  readonly dependsOnTextKind: boolean;
  /** 止めた部品、または例外を出したときは、空の拡張。 */
  create(value: unknown, env: EditorExtensionEnvironment): Extension;
}

export interface RegisteredCommand {
  readonly pluginId: string;
  /** `<部品の id>.<コマンドの id>`。 */
  readonly id: string;
  readonly title: string;
  readonly shortcut: ParsedShortcut | null;
  readonly ignoreInTextEntry: boolean;
  /** 止めた部品のコマンドは何もしない。例外を出したら部品を止める。 */
  run(ctx: CommandContext): void;
}

export interface RegisteredSettingsItem {
  readonly pluginId: string;
  readonly placement: SettingsPlacement;
  readonly order: number;
  readonly kind: 'checkbox';
  readonly settingKey: string;
  readonly label: string;
}

export interface PluginRegistry {
  readonly records: readonly PluginRecord[];
  /** 設定の定義（保存ファイルの読み込みで使う）。動作中に止めた部品の分も含む（保存値を落とさないため）。 */
  readonly settings: readonly SettingDefinition<unknown>[];
  readonly editorExtensions: readonly RegisteredEditorExtension[];
  readonly commands: readonly RegisteredCommand[];
  settingsItems(placement: SettingsPlacement): readonly RegisteredSettingsItem[];
  /** キー入力に合うコマンド（なければ null）。ホストの固定のショートカットを先に判定してから呼ぶ。 */
  findCommandByKey(e: KeyEventLike, mac: boolean): RegisteredCommand | null;
  /** 部品の後片付け（activate が返した関数）を呼び、以降は何も登録されていない状態にする。 */
  dispose(): void;
}

export interface PluginRegistryOptions {
  /** 部品が設定のキーに使えない名前（ホスト自身の設定のキー）。 */
  readonly reservedSettingKeys?: Iterable<string>;
  /** 読み込まなかった・止めたことの記録先。既定は console（warn / error）。 */
  readonly report?: (level: 'warn' | 'error', message: string, error?: unknown) => void;
}

const ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
const SETTING_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9]*$/;

interface Registrations {
  settings: SettingDefinition<unknown>[];
  editorExtensions: RegisteredEditorExtension[];
  commands: RegisteredCommand[];
  settingsItems: RegisteredSettingsItem[];
}

const emptyRegistrations = (): Registrations => ({ settings: [], editorExtensions: [], commands: [], settingsItems: [] });

interface Entry {
  id: string;
  name: string;
  version: string;
  status: PluginStatus;
  reason: string | null;
  regs: Registrations;
  cleanup: (() => void) | null;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 宣言を検査する。使えなければ理由（日本語）、使えれば null。API の版は、ほかの項目の形より先に見る。 */
function manifestProblem(manifest: unknown): string | null {
  if (typeof manifest !== 'object' || manifest === null) return '部品の宣言（manifest）がありません';
  const m = manifest as Record<string, unknown>;
  if (typeof m.apiVersion === 'number' && m.apiVersion !== PLUGIN_API_VERSION) {
    return `API の版が合いません（部品: ${m.apiVersion}、本体: ${PLUGIN_API_VERSION}）`;
  }
  if (m.apiVersion !== PLUGIN_API_VERSION) return 'apiVersion が整数ではありません';
  if (typeof m.id !== 'string' || !ID_PATTERN.test(m.id)) return 'id は小文字の英数字とハイフンにしてください';
  if (typeof m.name !== 'string' || m.name.trim() === '') return 'name がありません';
  if (typeof m.version !== 'string' || m.version.trim() === '') return 'version がありません';
  if (m.tier !== 'editor') return `tier は 'editor' だけに対応しています（${String(m.tier)}）`;
  return null;
}

export function createPluginRegistry(plugins: readonly Plugin[], options: PluginRegistryOptions = {}): PluginRegistry {
  const reserved = new Set(options.reservedSettingKeys ?? []);
  const report =
    options.report ??
    ((level, message, error) => (error === undefined ? console[level](message) : console[level](message, error)));
  const entries: Entry[] = [];

  const stop = (entry: Entry, error: unknown): void => {
    if (entry.status !== 'active') return;
    entry.status = 'stopped';
    entry.reason = describe(error);
    report('error', `[plugin] 部品「${entry.id}」を止めました: ${entry.reason}`, error);
    runCleanup(entry);
  };

  const runCleanup = (entry: Entry): void => {
    const cleanup = entry.cleanup;
    entry.cleanup = null;
    if (!cleanup) return;
    try {
      cleanup();
    } catch (error) {
      report('error', `[plugin] 部品「${entry.id}」の後片付けで例外が出ました`, error);
    }
  };

  /** コールバックを、例外で部品を止める形に包む。止めた部品では呼ばず、fallback を返す。 */
  const guard =
    <A extends unknown[], R>(entry: Entry, fn: (...args: A) => R, fallback: () => R) =>
    (...args: A): R => {
      if (entry.status !== 'active') return fallback();
      try {
        return fn(...args);
      } catch (error) {
        stop(entry, error);
        return fallback();
      }
    };

  const allRegistrations = (): Registrations[] => entries.map((e) => e.regs);

  const contextFor = (entry: Entry): PluginContext => {
    const own = (setting: SettingHandle<unknown>): void => {
      if (!entry.regs.settings.some((s) => s.key === setting.key)) {
        throw new Error(`設定「${setting.key}」はこの部品が registerSetting で登録したものではありません`);
      }
    };
    return {
      registerSetting<T>(definition: SettingDefinition<T>): SettingHandle<T> {
        const { key } = definition;
        if (typeof key !== 'string' || !SETTING_KEY_PATTERN.test(key)) throw new Error(`設定のキーが不正です: ${String(key)}`);
        if (reserved.has(key)) throw new Error(`設定のキー「${key}」は本体が使っています`);
        if (allRegistrations().some((r) => r.settings.some((s) => s.key === key))) {
          throw new Error(`設定のキー「${key}」は登録済みです`);
        }
        entry.regs.settings.push({
          key,
          defaultValue: definition.defaultValue,
          // 保存ファイルの読み込みは本体の起動の経路なので、例外で止まらないよう既定値に倒す。
          normalize: guard(entry, (raw: unknown) => definition.normalize(raw), () => definition.defaultValue),
        });
        return { key, defaultValue: definition.defaultValue };
      },

      registerEditorExtension<T>({ setting, create, dependsOnTextKind }: EditorExtensionRegistration<T>): void {
        own(setting);
        entry.regs.editorExtensions.push({
          pluginId: entry.id,
          settingKey: setting.key,
          defaultValue: setting.defaultValue,
          dependsOnTextKind: dependsOnTextKind === true,
          create: guard(
            entry,
            (value: unknown, env: EditorExtensionEnvironment) => {
              const extension = create(value as T, env);
              // 拡張の形が不正なら、state を作るときに例外になり、文書の読み込みごと失敗する。ここで試して止める。
              EditorState.create({ extensions: extension });
              return extension;
            },
            (): Extension => [],
          ),
        });
      },

      registerCommand({ id, title, shortcut, ignoreInTextEntry, run }): void {
        if (typeof id !== 'string' || id === '') throw new Error('コマンドの id がありません');
        if (typeof title !== 'string' || title === '') throw new Error(`コマンド「${id}」の title がありません`);
        const qualified = `${entry.id}.${id}`;
        const parsed = shortcut === undefined ? null : parseShortcut(shortcut);
        for (const r of allRegistrations()) {
          if (r.commands.some((c) => c.id === qualified)) throw new Error(`コマンド「${qualified}」は登録済みです`);
          const clash = parsed && r.commands.find((c) => c.shortcut?.text === parsed.text);
          if (clash) throw new Error(`ショートカット ${parsed.text} は「${clash.id}」が使っています`);
        }
        entry.regs.commands.push({
          pluginId: entry.id,
          id: qualified,
          title,
          shortcut: parsed,
          ignoreInTextEntry: ignoreInTextEntry === true,
          run: guard(entry, (ctx: CommandContext) => run(ctx), () => undefined),
        });
      },

      registerSettingsItem({ placement, order, kind, setting, label }): void {
        if (!SETTINGS_PLACEMENTS.includes(placement)) throw new Error(`設定画面の場所「${String(placement)}」はありません`);
        if (kind !== 'checkbox') throw new Error(`設定画面の項目の種類「${String(kind)}」は使えません`);
        if (typeof order !== 'number' || !Number.isFinite(order)) throw new Error('order は有限の数にしてください');
        if (typeof label !== 'string' || label === '') throw new Error('label がありません');
        own(setting);
        entry.regs.settingsItems.push({ pluginId: entry.id, placement, order, kind, settingKey: setting.key, label });
      },
    };
  };

  for (const plugin of plugins) {
    const manifest = (plugin as { manifest?: unknown } | null)?.manifest;
    const problem = manifestProblem(manifest);
    const m = (manifest ?? {}) as Record<string, unknown>;
    const entry: Entry = {
      id: typeof m.id === 'string' ? m.id : '(不明)',
      name: typeof m.name === 'string' ? m.name : '(不明)',
      version: typeof m.version === 'string' ? m.version : '(不明)',
      status: 'active',
      reason: null,
      regs: emptyRegistrations(),
      cleanup: null,
    };
    entries.push(entry);
    const duplicate = problem === null && entries.some((e) => e !== entry && e.id === entry.id);
    const rejection = problem ?? (duplicate ? `id「${entry.id}」は読み込み済みです` : null);
    if (rejection !== null) {
      entry.status = 'incompatible';
      entry.reason = rejection;
      report('warn', `[plugin] 部品「${entry.id}」を読み込みません: ${rejection}`);
      continue;
    }
    try {
      const cleanup = plugin.activate(contextFor(entry));
      if (typeof cleanup === 'function') entry.cleanup = cleanup;
    } catch (error) {
      // 途中までの登録は全部外す（半端な部品を残さない）。
      entry.regs = emptyRegistrations();
      stop(entry, error);
    }
  }

  const active = () => entries.filter((e) => e.status === 'active');

  return {
    get records() {
      return entries.map(({ id, name, version, status, reason }) => ({ id, name, version, status, reason }));
    },
    get settings() {
      return entries.flatMap((e) => e.regs.settings);
    },
    get editorExtensions() {
      return active().flatMap((e) => e.regs.editorExtensions);
    },
    get commands() {
      return active().flatMap((e) => e.regs.commands);
    },
    settingsItems(placement) {
      return active()
        .flatMap((e) => e.regs.settingsItems)
        .filter((i) => i.placement === placement)
        .sort((a, b) => a.order - b.order);
    },
    findCommandByKey(e, mac) {
      return active().flatMap((x) => x.regs.commands).find((c) => c.shortcut !== null && matchesShortcut(c.shortcut, e, mac)) ?? null;
    },
    dispose() {
      for (const entry of entries) {
        runCleanup(entry);
        if (entry.status === 'active') {
          entry.status = 'stopped';
          entry.reason = '解除しました';
        }
      }
    },
  };
}
