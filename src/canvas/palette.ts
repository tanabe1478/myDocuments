import type { Rgb } from './contrast';
import { parseHex } from './contrast';
import type { ThemeMode } from './gradients';

/**
 * 明暗テーマの、本文の文字・本文面・ページ背景の色。
 * src/styles.css の --md-color-text / --md-color-surface / --md-color-bg と同じ値
 * （一致は palette.test.ts が確かめる）。コントラストの評価はこの値を使う。
 */
export const THEME_COLORS: Record<ThemeMode, { text: string; surface: string; bg: string }> = {
  light: { text: '#2a2824', surface: '#fbf8f0', bg: '#f7f4ec' },
  dark: { text: '#dcd8ce', surface: '#202326', bg: '#1d1f21' },
};

export function themeRgb(mode: ThemeMode): { text: Rgb; surface: Rgb; bg: Rgb } {
  const c = THEME_COLORS[mode];
  return { text: parseHex(c.text)!, surface: parseHex(c.surface)!, bg: parseHex(c.bg)! };
}
