/**
 * 本文面の横の余白と、1 行の字数の目安（純関数）。
 * 余白は本文の行長（最大幅）の外側に取る: 余裕があるときは左右 56px、窓が狭いときは行長を保てる範囲で
 * 縮め、最小 20px にする。それでも足りなければ行長のほうを縮める。
 * CSS 側（theme.ts / styles.css の clamp）と同じ式。
 */
export const PAD_MAX_PX = 56;
export const PAD_MIN_PX = 20;

/** 本文の左右の内側余白。available は本文の領域の幅（窓の幅から、サイドバーの占める幅を引いたもの）。 */
export function contentPadding(available: number, maxWidthPx: number): number {
  const room = (available - maxWidthPx) / 2;
  return Math.min(Math.max(room, PAD_MIN_PX), PAD_MAX_PX);
}

/** 実際の本文（行）の幅。最大幅を上限に、余白を除いた幅。 */
export function columnWidth(available: number, maxWidthPx: number): number {
  const pad = contentPadding(available, maxWidthPx);
  return Math.max(Math.min(maxWidthPx, available - pad * 2), 0);
}

/**
 * 1 行に入る全角文字の数の目安。全角 1 文字の幅は、文字サイズ 1em に字間を足したもの。
 * 日本語の禁則（行頭・行末に置けない文字）で、実際は 1 文字ほど前後する。
 */
export function charsPerLine(columnWidthPx: number, fontSizePx: number, letterSpacingEm: number): number {
  const advance = fontSizePx * (1 + letterSpacingEm);
  if (!(advance > 0) || !(columnWidthPx > 0)) return 0;
  return Math.floor(columnWidthPx / advance);
}
