/** 外観パネルの幅（styles.css の .appearance-panel の width）。 */
export const PANEL_WIDTH_PX = 340;
/** パネルの右端の余白（styles.css の right）。 */
export const PANEL_RIGHT_PX = 16;
/** パネルと本文の間に残す余白。 */
export const PANEL_GAP_PX = 16;

/** パネルが占める幅（パネル + 右端の余白 + 本文との間隔）。 */
export const PANEL_RESERVE_PX = PANEL_WIDTH_PX + PANEL_RIGHT_PX + PANEL_GAP_PX;

/**
 * 外観パネルを開いている間、本文の領域の右側から空ける幅（px）。
 * 本文の最大幅 + パネルの占める幅が窓に収まるときだけ。収まらない狭い窓では 0（今までどおり重ねて表示）。
 */
export function panelReserve(maxWidthPx: number, viewportWidthPx: number): number {
  return maxWidthPx + PANEL_RESERVE_PX <= viewportWidthPx ? PANEL_RESERVE_PX : 0;
}
