import { EditorState, type Extension } from '@codemirror/state';
import { PERMISSION_DESCRIPTIONS, isDeclarationOnlyPermission, isDeclaredPermission, isPermission, type DeclaredPermission, type Permission, type PermissionGate } from './permissions';
import { matchesShortcut, parseShortcut, type KeyEventLike, type ParsedShortcut } from './shortcut';
import {
  SETTINGS_PLACEMENTS,
  SETTINGS_PLACEMENT_KINDS,
  type ActionPlugin,
  type CommandContext,
  type DocumentSnapshot,
  type EditorExtensionEnvironment,
  type EditorExtensionRegistration,
  type IsolatedCall,
  type IsolatedCallResult,
  type IsolatedCommandInfo,
  type IsolatedItemsUpdate,
  type IsolatedMenuItemInfo,
  type IsolatedPanelInfo,
  type IsolatedPluginHost,
  type IsolatedRun,
  type IsolatedServices,
  type MenuTarget,
  type PanelItem,
  type Plugin,
  type PluginContext,
  type RadioOption,
  type SettingDefinition,
  type SelectionSnapshot,
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

/** ツリーの右クリックに出す、段 2 の部品の項目。 */
export interface RegisteredMenuItem {
  readonly pluginId: string;
  /** `<部品の id>.<項目の id>`。 */
  readonly id: string;
  readonly title: string;
  readonly where: 'tree';
  /**
   * 項目を選んだ。paths.read が許可されていれば（決めていなければ、確認の画面で聞いてから）、部品の run に対象を渡す。
   * 拒否、確認の画面を閉じた、部品が止まったときは、何もしない。Promise は reject しない。
   */
  run(target: MenuTarget): Promise<void>;
}

/**
 * 左サイドバーに出す、段 2 の部品のパネル（項目の木）。部品が項目を送るたびに、別のオブジェクトになる（変わらない間は同じもの）。
 * 項目の文字列は、本体が文字として描く（HTML として解釈しない）。
 */
export interface RegisteredPanel {
  readonly pluginId: string;
  /** `<部品の id>.<パネルの id>`。 */
  readonly id: string;
  /** 節の見出し（部品が決めた文字列。文字として描く）。 */
  readonly title: string;
  /** 部品が項目を 1 回でも送ったか（送る前は、項目も文言も出さない）。 */
  readonly loaded: boolean;
  /** 項目を作った本文の版（送る前は -1）。今の本文の版と違うとき、項目を押しても本体はカーソルを移さない。 */
  readonly version: number;
  readonly items: readonly PanelItem[];
  /** 強調する項目の番号（なければ null）。 */
  readonly current: number | null;
  /** 項目が 0 件のときの文言（部品が渡さなければ null）。 */
  readonly empty: string | null;
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
  /**
   * ツリーの右クリックの項目（動いている段 2 の部品のもの。登録の順）。部品が登録・停止するたびに、別の配列になる
   * （useSyncExternalStore の snapshot として使える）。
   */
  readonly menuItems: readonly RegisteredMenuItem[];
  /** menuItems が変わったときに呼ばれる。戻り値で解除。 */
  subscribe(listener: () => void): () => void;
  /**
   * 左サイドバーに出すパネル（動いている段 2 の部品のもの。登録の順）。部品がパネルを登録・停止し、項目を送るたびに、別の配列になる
   * （useSyncExternalStore の snapshot として使える）。
   */
  readonly panels: readonly RegisteredPanel[];
  /** panels が変わったときに呼ばれる。戻り値で解除。 */
  subscribePanels(listener: () => void): () => void;
  /**
   * パネルが見えているか（サイドバーが開いていて、節がたたまれていない）を伝える。パネルを持つ部品は、見えているときだけ本文を受け取る
   * （見えていない間は届けず、見えたとき、最新を届ける）。知らない id は無視する。
   */
  setPanelVisible(panelId: string, visible: boolean): void;
  /**
   * 本文とカーソルの位置（本体が、入力が止まった後などに決めて渡す）を、受け取ってよい部品に届ける。受け取るのは、権限 document.read を
   * 宣言していて、動いていて、（パネルがあれば）パネルが見えている部品だけ。同じ版は同じ部品に重ねて届けない。最新のものは覚えておき、
   * 部品が動き始めたとき、パネルが見えたときに届ける。
   */
  publishDocument(document: DocumentSnapshot, selection: SelectionSnapshot): void;
  /** カーソルの位置だけが変わったとき。publishDocument と同じ部品に届ける。 */
  publishSelection(selection: SelectionSnapshot): void;
  /**
   * deferStart で作ったレジストリで、段 2 の部品を動かし始める（最初の描画のあと、App が呼ぶ）。何度呼んでもよい。
   * deferStart でなければ、作った時点で動いているので、何もしない。
   */
  startDeferred(): void;
  /**
   * 段 2 の部品が使う、本体の機能（クリップボード、開いている文書のパス）を結ぶ。App が、文書とトーストの持ち主として結ぶ。
   * 結ぶまでの呼び出しは、失敗として返る。戻り値で解除（結んだ相手と同じときだけ）。
   */
  bindServices(services: IsolatedServices): () => void;
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
  /**
   * 段 2 の権限の確認（src/permissions/）。ない環境では、権限（manifest.permissions）を宣言した部品は読み込まない（incompatible）。
   * 宣言のない段 2 の部品は、これがなくても動く。
   */
  readonly permissions?: PermissionGate;
  /**
   * true のとき、段 2 の部品は作った時点では動かさず、startDeferred() で動かす（iframe と Worker を、最初の描画のあとに作るため）。
   * 既定は false（作った時点で動かす）。
   */
  readonly deferStart?: boolean;
  /**
   * アプリのログ（ADR-007）への記録口。部品が止められたこと（source は plugin、event は stopped、data は id と reason）と、
   * 段 3 の部品が ctx.log で記録するもの（source は部品の id）を、ここへ渡す。ない環境では、記録しない。例外は握りつぶす。
   */
  readonly log?: (level: 'info' | 'warn' | 'error', source: string, event: string, data?: Record<string, string | number | boolean | null | undefined>) => void;
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
  menuItems: RegisteredMenuItem[];
  panels: RegisteredPanel[];
}

const emptyRegistrations = (): Registrations => ({ settings: [], editorExtensions: [], commands: [], settingsItems: [], menuItems: [], panels: [] });

interface Entry {
  id: string;
  name: string;
  version: string;
  status: PluginStatus;
  reason: string | null;
  regs: Registrations;
  cleanup: (() => void) | null;
  /** 段 2 の部品が宣言した、確認の要る権限（宣言のない部品、段 3 の部品は空）。 */
  permissions: readonly Permission[];
  /** 宣言だけで使える権限 document.read を宣言した段 2 の部品か（本文とカーソルの位置を受け取る）。 */
  readsDocument: boolean;
  /** 段 2 の部品が動いている（最初の実行が終わった）か。本文は、動き始めてから届ける。 */
  ready: boolean;
  /** パネルが見えているか（setPanelVisible）。パネルを持たない部品には使わない。 */
  panelVisible: boolean;
  /** この部品に届けた、本文の版と種類、カーソルの位置（同じものを重ねて届けない）。 */
  sentDocumentVersion: number | null;
  sentSelection: string | null;
  /** 段 2 の部品を動かし始める（deferStart のとき、startDeferred が呼ぶ）。 */
  starter: (() => void) | null;
}

/** 設定のキーから、ラジオの name を作る規則: 小文字のハイフン区切り（listContinuation → list-continuation）。 */
function radioNameOf(settingKey: string): string {
  return settingKey.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 宣言を検査する。使えなければ理由（日本語）、使えれば null。API の版は、ほかの項目の形より先に見る。canConfirm は、権限の確認の仕組みがあるか。 */
function manifestProblem(manifest: unknown, canConfirm: boolean): string | null {
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
  // 権限の宣言（permissions）は、段 2 の部品だけ。知らない権限、重複、段 3 の部品の宣言は、その部品を読み込まない。
  if (m.permissions !== undefined) {
    if (m.tier !== 'action') return '段 3 の部品は permissions を宣言できません（権限を宣言できるのは段 2 の部品だけです）';
    if (!Array.isArray(m.permissions)) return 'permissions は配列にしてください';
    const seen = new Set<string>();
    for (const permission of m.permissions as unknown[]) {
      if (!isDeclaredPermission(permission)) return `permissions に知らない権限があります: ${String(permission)}`;
      if (seen.has(permission)) return `permissions に重複があります: ${permission}`;
      seen.add(permission);
    }
    // 確認の画面が要る権限（clipboard.write、paths.read）は、確認の仕組みがない環境では宣言できない。宣言だけで使える権限（document.read）は、要らない。
    if ([...seen].some(isPermission) && !canConfirm) return '段 2 の部品の permissions（権限）は、この環境では宣言できません（権限の確認の仕組みがありません）';
  }
  return null;
}

export function createPluginRegistry(plugins: readonly (Plugin | ActionPlugin)[], options: PluginRegistryOptions = {}): PluginRegistry {
  const reserved = new Set(options.reservedSettingKeys ?? []);
  const report =
    options.report ??
    ((level, message, error) => (error === undefined ? console[level](message) : console[level](message, error)));
  const hostLog: NonNullable<PluginRegistryOptions['log']> = (level, source, event, data) => {
    try {
      options.log?.(level, source, event, data);
    } catch {
      // ログの失敗で、部品も本体も止めない。
    }
  };
  const entries: Entry[] = [];
  const gate = options.permissions;
  let services: IsolatedServices | null = null;

  // ツリーの右クリックの項目の一覧。変わるたびに別の配列にして、購読者に知らせる。
  let menuSnapshot: readonly RegisteredMenuItem[] = [];
  const menuListeners = new Set<() => void>();
  const refreshMenus = (): void => {
    const next = entries.filter((e) => e.status === 'active').flatMap((e) => e.regs.menuItems);
    if (next.length === 0 && menuSnapshot.length === 0) return;
    menuSnapshot = next;
    for (const listener of Array.from(menuListeners)) {
      try {
        listener();
      } catch (error) {
        report('error', '[plugin] 項目の一覧の購読者が例外を出しました', error);
      }
    }
  };

  // 左サイドバーのパネルの一覧。変わるたびに別の配列にして、購読者に知らせる（部品が止まったとき、項目を送ったとき）。
  let panelSnapshot: readonly RegisteredPanel[] = [];
  const panelListeners = new Set<() => void>();
  const notifyPanels = (): void => {
    for (const listener of Array.from(panelListeners)) {
      try {
        listener();
      } catch (error) {
        report('error', '[plugin] パネルの一覧の購読者が例外を出しました', error);
      }
    }
  };
  const refreshPanels = (): void => {
    const next = entries.filter((e) => e.status === 'active').flatMap((e) => e.regs.panels);
    if (next.length === panelSnapshot.length && next.every((p, i) => p === panelSnapshot[i])) return;
    panelSnapshot = next;
    notifyPanels();
  };

  // 本体が最後に渡した本文とカーソルの位置。部品が動き始めたとき、パネルが見えたときに、これを届ける。
  let latest: { document: DocumentSnapshot; selection: SelectionSnapshot } | null = null;
  const selectionKey = (s: SelectionSnapshot): string => `${s.version}:${s.anchor}:${s.head}`;
  /** 本文を受け取ってよい部品か（宣言した、動いている、パネルがあれば見えている）。 */
  const wantsDocument = (entry: Entry): boolean =>
    entry.status === 'active' && entry.readsDocument && entry.ready && (entry.regs.panels.length === 0 || entry.panelVisible);
  /** 受け取ってよい部品に、まだ届けていないものを届ける。 */
  const deliverLatest = (entry: Entry, host: IsolatedPluginHost): void => {
    if (latest === null || !wantsDocument(entry)) return;
    const { document, selection } = latest;
    if (entry.sentDocumentVersion !== document.version) {
      if (host.deliverDocument?.(entry.id, document) === true) entry.sentDocumentVersion = document.version;
      else return;
    }
    const key = selectionKey(selection);
    if (entry.sentSelection !== key && host.deliverSelection?.(entry.id, selection) === true) entry.sentSelection = key;
  };

  const stop = (entry: Entry, error: unknown): void => {
    if (entry.status !== 'active') return;
    entry.status = 'stopped';
    entry.reason = describe(error);
    report('error', `[plugin] 部品「${entry.id}」を止めました: ${entry.reason}`, error);
    hostLog('error', 'plugin', 'stopped', { id: entry.id, reason: entry.reason });
    runCleanup(entry);
    refreshMenus();
    refreshPanels();
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
    allowAlt = false,
  ): void => {
    if (typeof id !== 'string' || id === '') throw new Error('コマンドの id がありません');
    if (typeof title !== 'string' || title === '') throw new Error(`コマンド「${id}」の title がありません`);
    const qualified = `${entry.id}.${id}`;
    const parsed = shortcut === undefined ? null : parseShortcut(shortcut as string, { allowAlt });
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
    if (entry.status !== 'active') return;
    entry.cleanup = () => host.stop(entry.id);
    const callFailed = (reason: string): IsolatedCallResult => ({ ok: false, reason });
    /**
     * 利用者の操作で始まった実行を、権限の確認に知らせる。確認の画面は、この実行の中で、1 回まで出せる。
     * 戻り値は、実行が終わった（実行されなかった場合も含む）ことを知らせる関数。
     */
    const beginRun = (): (() => void) => gate?.beginRun?.(entry.id) ?? (() => {});
    const endWhenFinished = (run: IsolatedRun | undefined, end: () => void): void => {
      if (run) void run.finished.then(end, end);
      else end();
    };
    /** 権限を使ってよいか。確認の画面を出しているあいだは、その部品の時間切れの計測を止める。 */
    const authorize = async (needed: Permission): Promise<'granted' | 'denied' | 'dismissed' | 'not-asked' | 'unavailable'> => {
      if (!gate) return 'unavailable';
      const release = host.suspendTimeouts?.(entry.id);
      try {
        return await gate.authorize({ id: entry.id, name: entry.name }, entry.permissions, needed);
      } finally {
        release?.();
      }
    };
    const refusal = (needed: Permission, outcome: 'denied' | 'dismissed' | 'not-asked' | 'unavailable'): IsolatedCallResult =>
      callFailed(
        outcome === 'denied'
          ? `権限 ${needed}（${PERMISSION_DESCRIPTIONS[needed]}）は、利用者が許可していません`
          : outcome === 'dismissed'
            ? `権限 ${needed} の確認の画面が閉じられたため、今回は使えません`
            : outcome === 'not-asked'
              ? `権限 ${needed} は、まだ決まっていません。確認の画面は、利用者の操作で始まった実行の中で、1 回だけ出します（今回は出しません）`
              : `権限 ${needed} の確認の仕組みがありません`,
      );
    const onCall = async (call: IsolatedCall): Promise<IsolatedCallResult> => {
      const needed: Permission = call.method === 'clipboardWriteText' ? 'clipboard.write' : 'paths.read';
      if (entry.status !== 'active') return callFailed('部品は止まっています');
      // 宣言していない権限の API は、確認の画面を出さずに拒否する。
      if (!entry.permissions.includes(needed)) {
        return callFailed(`権限 ${needed}（${PERMISSION_DESCRIPTIONS[needed]}）を manifest.permissions に宣言していません`);
      }
      const outcome = await authorize(needed);
      if (outcome !== 'granted') return refusal(needed, outcome);
      if (entry.status !== 'active') return callFailed('部品は止まっています');
      if (!services) return callFailed('本体の準備ができていません');
      try {
        if (call.method === 'clipboardWriteText') {
          await services.writeClipboardText(call.text);
          return { ok: true, value: null };
        }
        const path = services.currentPath();
        if (path !== null && path.length > 4096) return callFailed('パスが長すぎます');
        return { ok: true, value: path };
      } catch (error) {
        report('error', `[plugin] 部品「${entry.id}」の呼び出しで、本体の側が例外を出しました`, error);
        return callFailed(call.method === 'clipboardWriteText' ? 'クリップボードに書けませんでした' : '本体の側でエラーが起きました');
      }
    };
    try {
      host.start(entry.id, source, {
        onCommand: (command: IsolatedCommandInfo) => {
          if (entry.status !== 'active') return;
          try {
            addCommand(
              entry,
              command,
              guard(
                entry,
                () => {
                  // 利用者の操作（ショートカット）で始まった実行。確認の画面は、この実行の中で 1 回まで。
                  const end = beginRun();
                  try {
                    endWhenFinished(host.run(entry.id, command.id), end);
                  } catch (error) {
                    end();
                    throw error;
                  }
                },
                () => undefined,
              ),
              true,
            );
          } catch (error) {
            stop(entry, error);
          }
        },
        onMenuItem: (item: IsolatedMenuItemInfo) => {
          if (entry.status !== 'active') return;
          // 宣言がなければ、登録を拒否して部品を止める（例外は、ホストが部品を止める理由にする）。
          if (!entry.permissions.includes('paths.read')) {
            throw new Error('registerContextMenuItem には、権限 paths.read の宣言（manifest.permissions）が要ります');
          }
          const qualified = `${entry.id}.${item.id}`;
          if (entries.some((e) => e.regs.menuItems.some((m) => m.id === qualified))) throw new Error(`メニューの項目「${qualified}」は登録済みです`);
          entry.regs.menuItems.push({
            pluginId: entry.id,
            id: qualified,
            title: item.title,
            where: item.where,
            run: async (target: MenuTarget) => {
              if (entry.status !== 'active') return;
              // 利用者の操作（項目の選択）で始まった実行。確認の画面は、この実行（権限の確認から、部品の run の終わりまで）の中で 1 回まで。
              const end = beginRun();
              try {
                // 権限が許可されてから、部品の run に対象を渡す。
                const outcome = await authorize('paths.read');
                if (outcome !== 'granted' || entry.status !== 'active') return end();
                endWhenFinished(host.runMenu?.(entry.id, item.id, target), end);
              } catch (error) {
                end();
                report('error', `[plugin] 部品「${entry.id}」のメニューの項目を実行できませんでした`, error);
              }
            },
          });
          refreshMenus();
        },
        onCall,
        onPanel: (panel: IsolatedPanelInfo) => {
          if (entry.status !== 'active') return;
          const qualified = `${entry.id}.${panel.id}`;
          if (entries.some((e) => e.regs.panels.some((p) => p.id === qualified))) throw new Error(`パネル「${qualified}」は登録済みです`);
          entry.regs.panels.push({ pluginId: entry.id, id: qualified, title: panel.title, loaded: false, version: -1, items: [], current: null, empty: null });
          refreshPanels();
        },
        onItems: (update: IsolatedItemsUpdate) => {
          if (entry.status !== 'active') return;
          const qualified = `${entry.id}.${update.panel}`;
          const index = entry.regs.panels.findIndex((p) => p.id === qualified);
          if (index < 0) throw new Error(`登録していないパネル「${update.panel}」の項目です`);
          const before = entry.regs.panels[index]!;
          entry.regs.panels[index] = { ...before, loaded: true, version: update.version, items: update.items, current: update.current, empty: update.empty };
          refreshPanels();
        },
        onReady: () => {
          entry.ready = true;
          deliverLatest(entry, host);
        },
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
      log: (level, event, data) => hostLog(level, entry.id, event, data),

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
    const problem = manifestProblem(manifest, gate !== undefined);
    const m = (manifest ?? {}) as Record<string, unknown>;
    const entry: Entry = {
      id: typeof m.id === 'string' ? m.id : '(不明)',
      name: typeof m.name === 'string' ? m.name : '(不明)',
      version: typeof m.version === 'string' ? m.version : '(不明)',
      status: 'active',
      reason: null,
      regs: emptyRegistrations(),
      cleanup: null,
      permissions: [],
      readsDocument: false,
      ready: false,
      panelVisible: false,
      sentDocumentVersion: null,
      sentSelection: null,
      starter: null,
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
        const declared: readonly DeclaredPermission[] = Array.isArray(m.permissions) ? (m.permissions as DeclaredPermission[]) : [];
        entry.permissions = declared.filter(isPermission);
        entry.readsDocument = declared.some(isDeclarationOnlyPermission);
        if (options.deferStart) entry.starter = () => startIsolated(entry, host, source);
        else startIsolated(entry, host, source);
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
    get menuItems() {
      return menuSnapshot;
    },
    subscribe(listener) {
      menuListeners.add(listener);
      return () => void menuListeners.delete(listener);
    },
    get panels() {
      return panelSnapshot;
    },
    subscribePanels(listener) {
      panelListeners.add(listener);
      return () => void panelListeners.delete(listener);
    },
    setPanelVisible(panelId, visible) {
      const host = options.isolation;
      const entry = entries.find((e) => e.regs.panels.some((p) => p.id === panelId));
      if (!entry || !host || entry.panelVisible === visible) return;
      entry.panelVisible = visible;
      if (visible) deliverLatest(entry, host);
    },
    publishDocument(document, selection) {
      const host = options.isolation;
      latest = { document, selection };
      if (host) for (const entry of entries) deliverLatest(entry, host);
    },
    publishSelection(selection) {
      const host = options.isolation;
      if (latest === null) return;
      latest = { document: latest.document, selection };
      if (host) for (const entry of entries) deliverLatest(entry, host);
    },
    startDeferred() {
      for (const entry of entries) {
        const starter = entry.starter;
        entry.starter = null;
        starter?.();
      }
    },
    bindServices(next) {
      services = next;
      return () => {
        if (services === next) services = null;
      };
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
        entry.starter = null;
        runCleanup(entry);
        if (entry.status === 'active') {
          entry.status = 'stopped';
          entry.reason = '解除しました';
        }
      }
      refreshMenus();
      refreshPanels();
    },
  };
}
