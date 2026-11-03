const FRONTMATTER_DELIMITER = /^---\s*$/;

/**
 * frontmatter（1 行目の --- から次の --- まで）の最後の行（行番号は 1 始まり。閉じる --- の行）。なければ null。
 * 閉じる --- がなければ frontmatter ではない。本体の記法の隠し方と部品の段落の分け方が、この判定を共有する。
 */
export function frontmatterEndLine(lineCount: number, lineText: (line: number) => string): number | null {
  if (lineCount < 1 || !FRONTMATTER_DELIMITER.test(lineText(1))) return null;
  for (let m = 2; m <= lineCount; m++) {
    if (FRONTMATTER_DELIMITER.test(lineText(m))) return m;
  }
  return null;
}
