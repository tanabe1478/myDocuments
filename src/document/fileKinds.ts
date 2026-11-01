/**
 * 開けるファイルの種類（拡張子の一覧）の唯一の定義。
 * ファイルを開く・保存するダイアログの絞り込み（tauriBridge）、エクスプローラーの灰色表示、
 * 本文の表示（Markdown の装飾を付けるか）の判定が、すべてここを使う。
 */

/** Markdown として開く拡張子（小文字、ドットなし）。 */
export const MARKDOWN_EXTENSIONS: readonly string[] = ['md', 'markdown', 'mdown', 'mkd', 'mdx'];

/** 素のテキストとして開く拡張子。Markdown の装飾を付けずに表示する。 */
export const PLAIN_TEXT_EXTENSIONS: readonly string[] = ['txt', 'text'];

/** 開ける拡張子の全部。 */
export const OPENABLE_EXTENSIONS: readonly string[] = [...MARKDOWN_EXTENSIONS, ...PLAIN_TEXT_EXTENSIONS];

/** 本文の表示の種類。markdown は装飾あり、plain は素のテキスト。 */
export type TextKind = 'markdown' | 'plain';

/** ファイル名（またはパス）の拡張子を、小文字・ドットなしで返す。なければ空文字。先頭のドットだけの名前（.md）は拡張子なし。 */
export function extensionOf(nameOrPath: string): string {
  const name = nameOrPath.split(/[\\/]/).pop() ?? '';
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}

/** エクスプローラーからクリックや Enter で開けるファイルか。 */
export function isOpenableFile(nameOrPath: string): boolean {
  return OPENABLE_EXTENSIONS.includes(extensionOf(nameOrPath));
}

/**
 * 文書の表示の種類。.txt と .text だけが plain で、それ以外（無題の文書、拡張子のないファイルを含む）は markdown。
 * 無題の文書は、これから Markdown を書くものとして装飾を付ける。
 */
export function textKindOf(path: string | null): TextKind {
  return path !== null && PLAIN_TEXT_EXTENSIONS.includes(extensionOf(path)) ? 'plain' : 'markdown';
}
