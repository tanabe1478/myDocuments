import { EditorState, type Extension } from '@codemirror/state';
import { matchesShortcut, parseShortcut, type KeyEventLike, type ParsedShortcut } from './shortcut';
import {
  SETTINGS_PLACEMENTS,
  SETTINGS_PLACEMENT_KINDS,
  type ActionPlugin,
  type CommandContext,
  type EditorExtensionEnvironment,
  type EditorExtensionRegistration,
  type IsolatedCommandInfo,
  type IsolatedPluginHost,
  type Plugin,
  type PluginContext,
  type RadioOption,
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

interface RegisteredSettingsItemBase {
  readonly pluginId: string;
  readonly placement: SettingsPlacement;
  readonly order: number;
  readonly settingKey: string;
}

export interface RegisteredCheckboxItem extends RegisteredSettingsItemBase {
  readonly kind: 'checkbox';
  readonly label: string;
}

export interface RegisteredRadioItem extends RegisteredSettingsItemBase {
  readonly kind: 'radio';
  /** ラジオの name。設定のキーから規則で作る（`listContinuation` → `list-continuation`）。 */
  readonly name: string;
  readonly legend: string;
  readonly options: readonly RadioOption[];
  readonly hint: string | null;
}

export type RegisteredSettingsItem = RegisteredCheckboxItem | RegisteredRadioItem;

/** 置き場所に置ける項目（SETTINGS_PLACEMENT_KINDS の種類）。 */
export type RegisteredItemAt<P extends SettingsPlacement> = Extract<RegisteredSettingsItem, { readonly kind: (typeof SETTINGS_PLACEMENT_KINDS)[P] }>;

export interface PluginRegistry {
  readonly records: readonly PluginRecord[];
  /** 設定の定義（保存ファイルの読み込みで使う）。動作中に止めた部品の分も含む（保存値を落とさないため）。 */
  readonly settings: readonly SettingDefinition<unknown>[];
  readonly editorExtensions: readonly RegisteredEditorExtension[];
  readonly commands: readonly RegisteredCommand[];
  /** 置き場所の項目（その場所に置ける種類のものだけ）を、order の順に。 */
  settingsItems<P extends SettingsPlacement>(placement: P): readonly RegisteredItemAt<P>[];
  /** キー入力に合うコマンド（なければ null）。ホストの固定のショートカットを先に判定してから呼ぶ。 */
  findCommandByKey(e: KeyEventLike, mac: boolean): RegisteredCommand | null;
  /** 部品の後片付け（activate が返した関数）を呼び、以降は何も登録されていない状態にする。 */
  dispose(): void;
}

export interface PluginRegistryOptions {
  /** 部品が設定のキーに使えない名前（ホスト自身の設定のキー）。 */
  readonly reservedSettingKeys?: Iterable<string>;
  /**
   * 隔離した操作（段 2。tier が 'action'）の部品を動かす仕組み（src/plugin-host/）。なければ、段 2 の部品は読み込まない
   * （incompatible）。段 2 の部品がないときは、渡さない（iframe も Worker も作られない）。
   */
  readonly isolation?: IsolatedPluginHost;
  /** 読み込まなかった・止めたことの記録先。既定は console（warn / error）。 */
  readonly report?: (level: 'warn' | 'error', message: string, error?: unknown) => void;
}

const ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
/** 段 2 の部品のコード（文字列）の大きさの上限。 */
const MAX_ACTION_SOURCE = 1024 * 1024;
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

/** 設定のキーから、ラジオの name を作る規則: 小文字のハイフン区切り（listContinuation → list-continuation）。 */
function radioNameOf(settingKey: string): string {
  return settingKey.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
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
  if (m.tier !== 'editor' && m.tier !== 'action') return `tier は 'editor' か 'action' だけに対応しています（${String(m.tier)}）`;
  // 段 2 の権限の宣言（permissions）は、権限の確認の画面と一緒に R6 で足す。R5 の段 2 は、権限の要らない API（registerCommand）だけ。
  if (m.tier === 'action' && 'permissions' in m && !(Array.isArray(m.permissions) && m.permissions.length === 0)) {
    return '段 2 の部品の permissions は、まだ宣言できません';
  }
  return null;
}

export function createPluginRegistry(plugins: readonly (Plugin | ActionPlugin)[], options: PluginRegistryOptions = {}): PluginRegistry {
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

  /**
   * 部品に渡す CommandContext。update の next は、ホストが描画の仕組みの中（run が戻った後を含む）で呼ぶので、
   * run を包む guard の外で例外が出る。next も同じ止め方で包み、例外なら部品を止めて、設定は前の値のままにする。
   */
  const isolateUpdates = (entry: Entry, ctx: CommandContext): CommandContext => ({
    settings: {
      get: (setting) => ctx.settings.get(setting),
      update: (setting, next) =>
        ctx.settings.update(setting, (current) => {
          if (entry.status !== 'active') return current;
          try {
            return next(current);
          } catch (error) {
            stop(entry, error);
            return current;
          }
        }),
    },
  });

  /**
   * 部品に渡す環境。本体が貸す機能は、部品が止まったあと（例外で止めた、または解除した）に呼ばれても何もしない形に包む
   * （止める前に作った拡張が、エディタに残っていることがある）。本体の側の例外は、部品のせいではないので、部品は止めず記録だけする。
   */
  const serviceEnvironment = (entry: Entry, env: EditorExtensionEnvironment): EditorExtensionEnvironment => ({
    textKind: env.textKind,
    isMacPlatform: () => env.isMacPlatform(),
    openExternalUrl: (url) => {
      if (entry.status !== 'active') return;
      if (typeof url !== 'string') throw new Error('openExternalUrl には、文字列の URL を渡してください');
      try {
        env.openExternalUrl(url);
      } catch (error) {
        report('error', `[plugin] 部品「${entry.id}」が呼んだ『外部の URL を開く』で、本体の側が例外を出しました`, error);
      }
    },
  });

  const allRegistrations = (): Registrations[] => entries.map((e) => e.regs);

  /**
   * コマンドを登録する（段 3 は activate の中、段 2 は Worker からの登録の通知）。id の形、ショートカットの形、
   * コマンドの id とショートカットの重なり（段 3 のコマンドとも検査する）を見て、満たさなければ例外。
   */
  const addCommand = (
    entry: Entry,
    { id, title, shortcut, ignoreInTextEntry }: { id: unknown; title: unknown; shortcut?: unknown; ignoreInTextEntry?: unknown },
    run: RegisteredCommand['run'],
  ): void => {
    if (typeof id !== 'string' || id === '') throw new Error('コマンドの id がありません');
    if (typeof title !== 'string' || title === '') throw new Error(`コマンド「${id}」の title がありません`);
    const qualified = `${entry.id}.${id}`;
    const parsed = shortcut === undefined ? null : parseShortcut(shortcut as string);
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
      run,
    });
  };

  /**
   * 隔離した操作（段 2）の部品を動かし始める。コマンドは、Worker の中の最初の実行の間に、非同期に届く。
   * 登録の検査（id、ショートカット、重なり）に通らなければ、その部品を止める（Worker は terminate される）。
   * 実行（run）は結果を待たない。時間切れ、例外、不正なメッセージは、ホスト（src/plugin-host/）が部品を止めて onStopped で知らせる。
   */
  const startIsolated = (entry: Entry, host: IsolatedPluginHost, source: string): void => {
    entry.cleanup = () => host.stop(entry.id);
    try {
      host.start(entry.id, source, {
        onCommand: (command: IsolatedCommandInfo) => {
          if (entry.status !== 'active') return;
          try {
            addCommand(entry, command, guard(entry, () => host.run(entry.id, command.id), () => undefined));
          } catch (error) {
            stop(entry, error);
          }
        },
        onReady: () => {},
        onStopped: (reason: string) => {
          if (entry.status !== 'active') return;
          entry.regs = emptyRegistrations();
          stop(entry, new Error(reason));
        },
      });
    } catch (error) {
      entry.regs = emptyRegistrations();
      stop(entry, error);
    }
  };

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
              const extension = create(value as T, serviceEnvironment(entry, env));
              // 拡張の形が不正なら、state を作るときに例外になり、文書の読み込みごと失敗する。ここで試して止める。
              EditorState.create({ extensions: extension });
              return extension;
            },
            (): Extension => [],
          ),
        });
      },

      registerCommand({ id, title, shortcut, ignoreInTextEntry, run }): void {
        addCommand(entry, { id, title, shortcut, ignoreInTextEntry }, guard(entry, (ctx: CommandContext) => run(isolateUpdates(entry, ctx)), () => undefined));
      },

      registerSettingsItem(item): void {
        const { placement, order, kind, setting } = item;
        if (!SETTINGS_PLACEMENTS.includes(placement)) throw new Error(`設定画面の場所「${String(placement)}」はありません`);
        if (kind !== 'checkbox' && kind !== 'radio') throw new Error(`設定画面の項目の種類「${String(kind)}」は使えません`);
        if (SETTINGS_PLACEMENT_KINDS[placement] !== kind) {
          throw new Error(`設定画面の場所「${placement}」には、種類「${SETTINGS_PLACEMENT_KINDS[placement]}」の項目だけ置けます（${kind}）`);
        }
        if (typeof order !== 'number' || !Number.isFinite(order)) throw new Error('order は有限の数にしてください');
        own(setting);
        if (item.kind === 'checkbox') {
          if (typeof item.label !== 'string' || item.label === '') throw new Error('label がありません');
          entry.regs.settingsItems.push({ pluginId: entry.id, placement, order, kind: 'checkbox', settingKey: setting.key, label: item.label });
          return;
        }
        const { legend, options, hint } = item;
        const radioSetting = item.setting;
        if (typeof legend !== 'string' || legend === '') throw new Error('legend がありません');
        if (!Array.isArray(options) || options.length === 0) throw new Error('options は 1 つ以上の選択肢にしてください');
        const values = new Set<string>();
        for (const option of options) {
          if (typeof option?.value !== 'string' || typeof option.label !== 'string' || option.label === '') {
            throw new Error('選択肢には、文字列の value と、空でない label が要ります');
          }
          if (values.has(option.value)) throw new Error(`選択肢の value「${option.value}」が重なっています`);
          values.add(option.value);
        }
        if (!values.has(radioSetting.defaultValue)) throw new Error(`設定「${radioSetting.key}」の既定値は、選択肢のどれかにしてください`);
        if (hint !== undefined && typeof hint !== 'string') throw new Error('hint は文字列にしてください');
        const name = radioNameOf(radioSetting.key);
        if (allRegistrations().some((r) => r.settingsItems.some((i) => i.kind === 'radio' && i.name === name))) {
          throw new Error(`ラジオの name「${name}」はほかの項目が使っています`);
        }
        entry.regs.settingsItems.push({
          pluginId: entry.id,
          placement,
          order,
          kind: 'radio',
          settingKey: radioSetting.key,
          name,
          legend,
          options: options.map(({ value, label }) => ({ value, label })),
          hint: hint ?? null,
        });
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
    if (m.tier === 'action') {
      const source = (plugin as ActionPlugin).source;
      const host = options.isolation;
      const unusable =
        typeof source !== 'string' || source.trim() === ''
          ? 'source（Worker で動くコードの文字列）がありません'
          : source.length > MAX_ACTION_SOURCE
            ? 'source が大きすぎます'
            : host === undefined
              ? '隔離した操作の段は、この環境では使えません'
              : null;
      if (unusable !== null || host === undefined) {
        entry.status = 'incompatible';
        entry.reason = unusable;
        report('warn', `[plugin] 部品「${entry.id}」を読み込みません: ${unusable}`);
      } else {
        startIsolated(entry, host, source);
      }
      continue;
    }
    try {
      const cleanup = (plugin as Plugin).activate(contextFor(entry));
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
    settingsItems<P extends SettingsPlacement>(placement: P): readonly RegisteredItemAt<P>[] {
      return active()
        .flatMap((e) => e.regs.settingsItems)
        .filter((i) => i.placement === placement)
        .sort((a, b) => a.order - b.order) as RegisteredItemAt<P>[];
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
