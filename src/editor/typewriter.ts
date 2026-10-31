/**
 * タイプライターモードのスクロール位置。カーソル行の中心を、表示領域の縦中央に置く。
 *
 * caretCenter: カーソル行の中心の、表示領域（スクロール領域）上端からの距離。
 * scrollTop: 現在のスクロール位置。viewportHeight: 表示領域の高さ。maxScrollTop: スクロール可能な最大値。
 * 戻り値は新しい scrollTop（0〜maxScrollTop に収める）。
 * 本文の上下には表示領域の半分の余白があるので、先頭・末尾の行でも中央に来る。
 */
export function typewriterScrollTop(input: {
  scrollTop: number;
  caretCenter: number;
  viewportHeight: number;
  maxScrollTop: number;
}): number {
  const target = input.scrollTop + input.caretCenter - input.viewportHeight / 2;
  return Math.min(Math.max(target, 0), Math.max(input.maxScrollTop, 0));
}

/** 本文の上下に付ける余白（表示領域の半分）。 */
export function typewriterPadding(viewportHeight: number): number {
  return Math.round(viewportHeight / 2);
}
