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

/** 右ペイン（部品のパネル。ADR-005 の R13）の幅（styles.css の .right-pane の width）。 */
export const RIGHT_PANE_WIDTH_PX = 260;

/**
 * 右ペインの push / overlay。窓の幅から、左の押し出し分（sidebarReserve。左が閉じている・重ねているときは 0）と
 * 右ペインの幅を引いた残りが本文の最小幅以上なら push、足りなければ overlay（本文の上に重ねる）。
 * 左右とも push になるのは、窓の幅が 260 + 360 + 260 = 880px 以上のとき。
 */
export function rightPaneMode(viewportWidthPx: number, leftReservePx: number): SidebarMode {
  return viewportWidthPx - leftReservePx - RIGHT_PANE_WIDTH_PX >= MIN_BODY_WIDTH_PX ? 'push' : 'overlay';
}

/** 本文の領域の右から空ける幅（px）。閉じているとき、重ねて表示するときは 0。 */
export function rightPaneReserve(open: boolean, viewportWidthPx: number, leftReservePx: number): number {
  return open && rightPaneMode(viewportWidthPx, leftReservePx) === 'push' ? RIGHT_PANE_WIDTH_PX : 0;
}
