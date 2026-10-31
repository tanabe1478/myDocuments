/**
 * フォーカスモードの対象範囲。空行（空白だけの行）で区切られたブロックのうち、
 * カーソル行を含むもの。見出し・リスト項目も、空行で区切られていれば 1 ブロック。
 * カーソルが空行にあるときは、その空行の連なりだけが対象（どの段落にも属さない）。
 * 行番号は 1 始まり。from・to を含む。
 */
export interface LineRange {
  readonly from: number;
  readonly to: number;
}

export function focusRange(lineCount: number, isBlank: (line: number) => boolean, cursorLine: number): LineRange {
  const line = Math.min(Math.max(cursorLine, 1), Math.max(lineCount, 1));
  const kind = isBlank(line);
  let from = line;
  let to = line;
  while (from > 1 && isBlank(from - 1) === kind) from--;
  while (to < lineCount && isBlank(to + 1) === kind) to++;
  return { from, to };
}

export function isBlankText(text: string): boolean {
  return /^\s*$/.test(text);
}
