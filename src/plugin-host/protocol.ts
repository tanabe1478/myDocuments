/**
 * 本体と仲介のコード（relay.js。sandbox の iframe の中）の間の、postMessage のメッセージ（ADR-005 の R5）。
 * 決めた種類と形だけを通す。relay.js は同じ規則で Worker からのメッセージを検査してから転送するが、本体は iframe を
 * 信用せず、受け取ったものをここでもう一度検査する（relay.js が壊されたときの備え）。
 */

/** メッセージの版。両方向のすべてのメッセージに `v` として付く。 */
export const PROTOCOL_VERSION = 0;

/** 形の上限。relay.js（MAX_*）と同じ値。 */
export const LIMITS = {
  commandsPerPlugin: 32,
  idLength: 64,
  titleLength: 200,
  shortcutLength: 32,
  reasonLength: 300,
  sourceLength: 1024 * 1024,
  /** R6: 1 部品のツリーの右クリックの項目の数。 */
  menuItemsPerPlugin: 8,
  /** R6: 結果待ちの呼び出し（api.clipboard.writeText など）の数。超えた呼び出しは、Worker の中で拒否する（仲介では不正として止める）。 */
  pendingCalls: 16,
  /** R6: api.clipboard.writeText の文字数（Unicode のスカラー値の数ではなく UTF-16 の長さ。ネイティブ側は文字数で 100,000 を検査する）。 */
  clipboardTextLength: 100_000,
  /** R6: パスの長さ。 */
  pathLength: 4096,
  /** R7: 1 部品のパネルの数。 */
  panelsPerPlugin: 1,
  /** R7: panel.setItems で送れる項目の数。 */
  panelItems: 1000,
  /** R7: 項目の文字列と、項目がないときの文言の長さ（UTF-16 の長さ）。 */
  panelTextLength: 200,
  /** R7: 項目の深さの最大（0 から数える）。 */
  panelMaxDepth: 7,
  /** R7: 項目の本文の中の位置の上限（UTF-16 のオフセット）。 */
  offsetMax: 2_147_483_647,
  /** R7: panel.setItems の頻度の上限。window の間に、この回数を超えたら部品を止める。 */
  setItemsPerWindow: 30,
  setItemsWindowMs: 1000,
  /** R7: 部品に届ける本文の長さの上限（UTF-16 の長さ）。超える本文は届けない。 */
  documentTextLength: 16 * 1024 * 1024,
} as const;

export type TargetKind = 'file' | 'folder';
export type DocumentKind = 'markdown' | 'plain';

const ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

/** 本体 → 仲介。 */
export type MainMessage =
  | { readonly v: 0; readonly kind: 'start'; readonly plugin: string; readonly source: string }
  | { readonly v: 0; readonly kind: 'run'; readonly plugin: string; readonly req: number; readonly command: string }
  /** ツリーの右クリックの項目を、対象つきで実行させる。結果は run と同じ done / failed（req で対応）。 */
  | { readonly v: 0; readonly kind: 'runMenu'; readonly plugin: string; readonly req: number; readonly item: string; readonly path: string; readonly targetKind: TargetKind }
  /** R7: 本文を届ける（権限 document.read を宣言した部品だけ。本体が判断する）。version は本体が数える本文の版。 */
  | { readonly v: 0; readonly kind: 'doc'; readonly plugin: string; readonly version: number; readonly textKind: DocumentKind; readonly text: string }
  /** R7: カーソルの位置を届ける。version は、そのときの本文の版。 */
  | { readonly v: 0; readonly kind: 'selection'; readonly plugin: string; readonly version: number; readonly anchor: number; readonly head: number }
  /** 呼び出し（call）の結果。成功は値（文字列か null）、失敗は理由。 */
  | { readonly v: 0; readonly kind: 'result'; readonly plugin: string; readonly call: number; readonly ok: true; readonly value: string | null }
  | { readonly v: 0; readonly kind: 'result'; readonly plugin: string; readonly call: number; readonly ok: false; readonly reason: string }
  | { readonly v: 0; readonly kind: 'stop'; readonly plugin: string };

/** 仲介 → 本体。plugin は部品の id。 */
export type RelayMessage =
  | { readonly kind: 'hello' }
  | { readonly kind: 'command'; readonly plugin: string; readonly id: string; readonly title: string; readonly shortcut?: string; readonly ignoreInTextEntry?: boolean }
  /** ツリーの右クリックの項目の登録（部品のコードの最初の実行の間だけ）。 */
  | { readonly kind: 'menu'; readonly plugin: string; readonly id: string; readonly title: string; readonly where: 'tree' }
  /** R7: パネルの登録（部品のコードの最初の実行の間だけ。1 部品に 1 つ）。 */
  | { readonly kind: 'panel'; readonly plugin: string; readonly id: string; readonly title: string }
  /** R7: パネルの項目（全部を置き換える）。version は、項目を作った本文の版。current は強調する項目の番号、empty は 0 件のときの文言。 */
  | {
      readonly kind: 'items';
      readonly plugin: string;
      readonly panel: string;
      readonly version: number;
      readonly items: readonly { readonly text: string; readonly depth: number; readonly offset: number }[];
      readonly current: number | null;
      readonly empty: string | null;
    }
  /** 本体の機能の呼び出し。call は部品の中の番号（1 から。結果待ちの間は重ならない）。 */
  | { readonly kind: 'call'; readonly plugin: string; readonly call: number; readonly method: 'clipboardWriteText'; readonly text: string }
  | { readonly kind: 'call'; readonly plugin: string; readonly call: number; readonly method: 'currentPath' }
  | { readonly kind: 'ready'; readonly plugin: string }
  | { readonly kind: 'done'; readonly plugin: string; readonly req: number }
  /** 実行が例外を出した（Worker はまだ生きている。本体が止める）。 */
  | { readonly kind: 'failed'; readonly plugin: string; readonly req: number; readonly reason: string }
  /** 仲介が Worker を止めた（script のエラー、不正なメッセージ）。 */
  | { readonly kind: 'stopped'; readonly plugin: string; readonly reason: string };

export type ParseResult = { readonly ok: true; readonly message: RelayMessage } | { readonly ok: false; readonly problem: string };

const fail = (problem: string): ParseResult => ({ ok: false, problem });

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

/** キーの集合が、required をすべて含み、required と optional 以外を含まないこと。 */
function keysOk(object: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  const keys = Object.keys(object);
  return required.every((k) => keys.includes(k)) && keys.every((k) => required.includes(k) || optional.includes(k));
}

const isText = (value: unknown, max: number): value is string => typeof value === 'string' && value.length >= 1 && value.length <= max;
const isPluginId = (value: unknown): value is string => isText(value, LIMITS.idLength) && ID_PATTERN.test(value);
const isReq = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;
const isIntBetween = (value: unknown, min: number, max: number): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;

/** 仲介から届いたデータの形を検査する。決めた形以外（未知の種類、余計な項目、型や長さの違い）はすべて ok: false。 */
export function parseRelayMessage(data: unknown): ParseResult {
  if (!isPlainObject(data)) return fail('メッセージがオブジェクトではありません');
  if (data.v !== PROTOCOL_VERSION) return fail('メッセージの版が違います');
  const { kind } = data;
  switch (kind) {
    case 'hello':
      return keysOk(data, ['v', 'kind']) ? { ok: true, message: { kind } } : fail('hello の項目が違います');
    case 'command': {
      if (!keysOk(data, ['v', 'kind', 'plugin', 'id', 'title'], ['shortcut', 'ignoreInTextEntry'])) return fail('command の項目が違います');
      const { plugin, id, title, shortcut, ignoreInTextEntry } = data;
      if (!isPluginId(plugin)) return fail('command の plugin が不正です');
      if (!isPluginId(id)) return fail('command の id が不正です');
      if (!isText(title, LIMITS.titleLength)) return fail('command の title が不正です');
      if (shortcut !== undefined && !isText(shortcut, LIMITS.shortcutLength)) return fail('command の shortcut が不正です');
      if (ignoreInTextEntry !== undefined && typeof ignoreInTextEntry !== 'boolean') return fail('command の ignoreInTextEntry が不正です');
      return {
        ok: true,
        message: {
          kind,
          plugin,
          id,
          title,
          ...(shortcut !== undefined ? { shortcut } : {}),
          ...(ignoreInTextEntry !== undefined ? { ignoreInTextEntry } : {}),
        },
      };
    }
    case 'menu': {
      if (!keysOk(data, ['v', 'kind', 'plugin', 'id', 'title', 'where'])) return fail('menu の項目が違います');
      const { plugin, id, title, where } = data;
      if (!isPluginId(plugin) || !isPluginId(id)) return fail('menu の plugin か id が不正です');
      if (!isText(title, LIMITS.titleLength)) return fail('menu の title が不正です');
      if (where !== 'tree') return fail('menu の where が不正です');
      return { ok: true, message: { kind, plugin, id, title, where } };
    }
    case 'panel': {
      if (!keysOk(data, ['v', 'kind', 'plugin', 'id', 'title'])) return fail('panel の項目が違います');
      const { plugin, id, title } = data;
      if (!isPluginId(plugin) || !isPluginId(id)) return fail('panel の plugin か id が不正です');
      if (!isText(title, LIMITS.titleLength)) return fail('panel の title が不正です');
      return { ok: true, message: { kind, plugin, id, title } };
    }
    case 'items': {
      if (!keysOk(data, ['v', 'kind', 'plugin', 'panel', 'version', 'items', 'current', 'empty'])) return fail('items の項目が違います');
      const { plugin, panel, version, items, current, empty } = data;
      if (!isPluginId(plugin) || !isPluginId(panel)) return fail('items の plugin か panel が不正です');
      if (!isIntBetween(version, 0, Number.MAX_SAFE_INTEGER)) return fail('items の version が不正です');
      if (!Array.isArray(items)) return fail('items の items が配列ではありません');
      if (items.length > LIMITS.panelItems) return fail(`項目が多すぎます（${LIMITS.panelItems} まで）`);
      const copied: { text: string; depth: number; offset: number }[] = [];
      for (const item of items as unknown[]) {
        if (!isPlainObject(item) || !keysOk(item, ['text', 'depth', 'offset'])) return fail('項目の形が違います');
        if (!isText(item.text, LIMITS.panelTextLength)) return fail('項目の text が不正です');
        if (!isIntBetween(item.depth, 0, LIMITS.panelMaxDepth)) return fail('項目の depth が不正です');
        if (!isIntBetween(item.offset, 0, LIMITS.offsetMax)) return fail('項目の offset が不正です');
        copied.push({ text: item.text, depth: item.depth, offset: item.offset });
      }
      if (current !== null && !isIntBetween(current, 0, copied.length - 1)) return fail('items の current が範囲外です');
      if (empty !== null && !isText(empty, LIMITS.panelTextLength)) return fail('items の empty が不正です');
      return { ok: true, message: { kind, plugin, panel, version, items: copied, current, empty } };
    }
    case 'call': {
      const { plugin, call, method } = data;
      if (!isPluginId(plugin) || !isReq(call)) return fail('call の plugin か番号が不正です');
      if (method === 'clipboardWriteText') {
        if (!keysOk(data, ['v', 'kind', 'plugin', 'call', 'method', 'text'])) return fail('call の項目が違います');
        if (!isText(data.text, LIMITS.clipboardTextLength)) return fail('call の text が不正です');
        return { ok: true, message: { kind, plugin, call, method, text: data.text } };
      }
      if (method === 'currentPath') {
        if (!keysOk(data, ['v', 'kind', 'plugin', 'call', 'method'])) return fail('call の項目が違います');
        return { ok: true, message: { kind, plugin, call, method } };
      }
      return fail('call の method が決めたものではありません');
    }
    case 'ready': {
      if (!keysOk(data, ['v', 'kind', 'plugin']) || !isPluginId(data.plugin)) return fail('ready の項目が違います');
      return { ok: true, message: { kind, plugin: data.plugin } };
    }
    case 'done': {
      if (!keysOk(data, ['v', 'kind', 'plugin', 'req']) || !isPluginId(data.plugin) || !isReq(data.req)) return fail('done の項目が違います');
      return { ok: true, message: { kind, plugin: data.plugin, req: data.req } };
    }
    case 'failed': {
      if (!keysOk(data, ['v', 'kind', 'plugin', 'req', 'reason']) || !isPluginId(data.plugin) || !isReq(data.req) || !isText(data.reason, LIMITS.reasonLength)) {
        return fail('failed の項目が違います');
      }
      return { ok: true, message: { kind, plugin: data.plugin, req: data.req, reason: data.reason } };
    }
    case 'stopped': {
      if (!keysOk(data, ['v', 'kind', 'plugin', 'reason']) || !isPluginId(data.plugin) || !isText(data.reason, LIMITS.reasonLength)) {
        return fail('stopped の項目が違います');
      }
      return { ok: true, message: { kind, plugin: data.plugin, reason: data.reason } };
    }
    default:
      return fail('決めていない種類のメッセージです');
  }
}

export const startMessage = (plugin: string, source: string): MainMessage => ({ v: PROTOCOL_VERSION, kind: 'start', plugin, source });
export const runMenuMessage = (plugin: string, req: number, item: string, path: string, targetKind: TargetKind): MainMessage => ({
  v: PROTOCOL_VERSION,
  kind: 'runMenu',
  plugin,
  req,
  item,
  path,
  targetKind,
});
export const docMessage = (plugin: string, version: number, textKind: DocumentKind, text: string): MainMessage => ({ v: PROTOCOL_VERSION, kind: 'doc', plugin, version, textKind, text });
export const selectionMessage = (plugin: string, version: number, anchor: number, head: number): MainMessage => ({ v: PROTOCOL_VERSION, kind: 'selection', plugin, version, anchor, head });
export const resultMessage = (plugin: string, call: number, result: { readonly ok: true; readonly value: string | null } | { readonly ok: false; readonly reason: string }): MainMessage =>
  result.ok
    ? { v: PROTOCOL_VERSION, kind: 'result', plugin, call, ok: true, value: result.value }
    : { v: PROTOCOL_VERSION, kind: 'result', plugin, call, ok: false, reason: result.reason.slice(0, LIMITS.reasonLength) || 'error' };
export const runMessage = (plugin: string, req: number, command: string): MainMessage => ({ v: PROTOCOL_VERSION, kind: 'run', plugin, req, command });
export const stopMessage = (plugin: string): MainMessage => ({ v: PROTOCOL_VERSION, kind: 'stop', plugin });
