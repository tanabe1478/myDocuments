import { PAD_MIN_PX } from '../editor/layout';
import { RANGES } from '../preferences/preferences';

/** 左サイドバーの幅（styles.css の .sidebar の width）。 */
export const SIDEBAR_WIDTH_PX = 260;

/** 本文が潰れない最小の幅: 本文の最大幅の最小値 + 左右の最小の余白。 */
export const MIN_BODY_WIDTH_PX = RANGES.maxWidthPx.min + 2 * PAD_MIN_PX;

/**
 * push: 本文の領域を右へ押し出す（重ねない）。
 * overlay: 窓が狭く、押し出すと本文が最小幅を割るとき。本文は動かさず、サイドバーを本文の上に重ねる。
 */
export type SidebarMode = 'push' | 'overlay';

export function sidebarMode(viewportWidthPx: number): SidebarMode {
  return viewportWidthPx - SIDEBAR_WIDTH_PX >= MIN_BODY_WIDTH_PX ? 'push' : 'overlay';
}

/** 本文の領域の左から空ける幅（px）。閉じているとき、重ねて表示するときは 0。 */
export function sidebarReserve(open: boolean, viewportWidthPx: number): number {
  return open && sidebarMode(viewportWidthPx) === 'push' ? SIDEBAR_WIDTH_PX : 0;
}
