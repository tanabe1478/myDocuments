import { columnWidth, contentPadding } from '../editor/layout';

/** 本文の列の外（右側の余白）に置くときの、トーストの最小幅。 */
export const TOAST_MIN_WIDTH_PX = 180;
/** 列の外に置くとき、列・窓の端との間に空ける余白。 */
export const TOAST_MARGIN_PX = 16;
/** 列の外に置くときの、トーストの最大幅。 */
export const TOAST_MAX_WIDTH_PX = 360;

export type ToastPlacement = 'margin' | 'overlay';

export interface ToastLayout {
  /** margin: 本文の列の外（右下）。overlay: 本文に重ねる（列の外に場所がないとき）。 */
  placement: ToastPlacement;
  /** margin のときの、トーストの幅（px）。overlay では 0。 */
  width: number;
}

/**
 * トーストの置き場所。本文の列の右側の余白に、最小幅と左右のマージンが収まるときだけ列の外に置く。
 * 収まらないとき（狭い窓、サイドバーで本文の領域が狭くなって余白が狭いとき）は、本文に重ねる。
 *
 * available: 本文の領域の幅（窓の幅から、サイドバーの占める幅を引いたもの）。
 * 列の位置は styles.css の .canvas-surface と theme.ts の .cm-content と同じ式（本文は available の中央、右の余白は本文の領域の右端まで）。
 */
export function toastLayout(available: number, maxWidthPx: number): ToastLayout {
  const content = columnWidth(available, maxWidthPx) + contentPadding(available, maxWidthPx) * 2;
  const margin = (available - Math.min(content, available)) / 2;
  const room = margin - TOAST_MARGIN_PX * 2;
  if (room < TOAST_MIN_WIDTH_PX) return { placement: 'overlay', width: 0 };
  return { placement: 'margin', width: Math.floor(Math.min(room, TOAST_MAX_WIDTH_PX)) };
}
