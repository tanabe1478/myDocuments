/**
 * ログに書く文字列の整形。本文とファイルのパスは書かない方針（ADR-007）の、文字列側の備え:
 * メッセージの長さを切り、ホームディレクトリのパスを `~` にする。
 */

/** エラーのメッセージを切る長さ（文字数）。 */
export const MAX_MESSAGE_CHARS = 300;
/** data の文字列の上限（Rust 側と同じ。超えると、Rust がその項目を捨てる）。 */
export const MAX_VALUE_CHARS = 500;

// ホームディレクトリ: /Users/<名前>、/home/<名前>、C:\Users\<名前>（区切りは \ か /）。名前の後ろの区切りは残す（/Users/a/b → ~/b）。
const POSIX_HOME = /\/(?:Users|home)\/[^/\\\s'"`)\]}>]+/g;
const WINDOWS_HOME = /[A-Za-z]:[\\/]Users[\\/][^/\\\s'"`)\]}>]+/gi;

export function scrubHome(text: string): string {
  return text.replace(WINDOWS_HOME, '~').replace(POSIX_HOME, '~');
}

/** ホームのパスを `~` にしてから、max 文字（コードポイント）までに切る。 */
export function clip(text: string, max: number = MAX_MESSAGE_CHARS): string {
  const scrubbed = scrubHome(text);
  const chars = Array.from(scrubbed);
  return chars.length <= max ? scrubbed : chars.slice(0, max).join('');
}

/** URL またはパスの、最後の名前（ファイル名）。クエリとハッシュは除く。空なら null。 */
export function basenameOf(location: string): string | null {
  const path = location.split(/[?#]/)[0] ?? '';
  const name = path.split(/[/\\]/).filter(Boolean).pop();
  return name ? clip(name, 100) : null;
}

/** エラーの種類（Error の name。BridgeError は kind も）。メッセージは含めない。 */
export function errorKind(e: unknown): { error: string; kind?: string } {
  if (e instanceof Error) {
    const kind = (e as { kind?: unknown }).kind;
    return typeof kind === 'string' ? { error: e.name, kind } : { error: e.name };
  }
  return { error: typeof e === 'object' && e !== null ? 'object' : typeof e };
}

/** エラーの種類と、300 文字までに切ったメッセージ（ホームのパスは `~`）。 */
export function errorFields(e: unknown): { error: string; kind?: string; message: string } {
  const message = e instanceof Error ? e.message : typeof e === 'string' ? e : '';
  return { ...errorKind(e), message: clip(message) };
}
