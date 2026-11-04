/**
 * 記号の見せ方（設定「記号の表示」）。
 * cursorLine: カーソルのある行と選択にかかる行だけ記号を見せ、ほかの行は隠す（ADR-004）。always: すべての行で見せる。
 */
export type MarkupDisplay = 'cursorLine' | 'always';

export const MARKUP_DISPLAYS: readonly MarkupDisplay[] = ['cursorLine', 'always'];

/** 設定ファイル（preferences.json）の最上位のキー。これまでと同じ名前・同じ文字列の値のまま保存する。 */
export const MARKUP_DISPLAY_SETTING_KEY = 'markupDisplay';

export const DEFAULT_MARKUP_DISPLAY: MarkupDisplay = 'cursorLine';

/** 未検証の値（保存ファイルの中身）から有効な値を作る。範囲外・型違いは既定値。 */
export function normalizeMarkupDisplay(raw: unknown): MarkupDisplay {
  return MARKUP_DISPLAYS.includes(raw as MarkupDisplay) ? (raw as MarkupDisplay) : DEFAULT_MARKUP_DISPLAY;
}
