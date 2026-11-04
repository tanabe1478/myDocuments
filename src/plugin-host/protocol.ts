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
} as const;

const ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

/** 本体 → 仲介。 */
export type MainMessage =
  | { readonly v: 0; readonly kind: 'start'; readonly plugin: string; readonly source: string }
  | { readonly v: 0; readonly kind: 'run'; readonly plugin: string; readonly req: number; readonly command: string }
  | { readonly v: 0; readonly kind: 'stop'; readonly plugin: string };

/** 仲介 → 本体。plugin は部品の id。 */
export type RelayMessage =
  | { readonly kind: 'hello' }
  | { readonly kind: 'command'; readonly plugin: string; readonly id: string; readonly title: string; readonly shortcut?: string; readonly ignoreInTextEntry?: boolean }
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
export const runMessage = (plugin: string, req: number, command: string): MainMessage => ({ v: PROTOCOL_VERSION, kind: 'run', plugin, req, command });
export const stopMessage = (plugin: string): MainMessage => ({ v: PROTOCOL_VERSION, kind: 'stop', plugin });
