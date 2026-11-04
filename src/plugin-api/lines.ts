/**
 * 行の種類の判定（純関数）。本体の素のテキストの空行の高さと、部品（Markdown の見た目）の空行の判定が共有する。
 */

/** 空白だけの行（全角空白を含む）か。空の行も含む。 */
export function isBlankLine(text: string): boolean {
  return /^\s*$/.test(text);
}
