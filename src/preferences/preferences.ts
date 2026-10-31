/**
 * 型付き Preferences。保存形式は JSON オブジェクトで、検証はここが唯一の定義
 * （Rust 側は中身を解釈しない）。範囲外・型違いの項目は、その項目だけ既定値に戻す。
 * 設定画面は Run 2 では作らない。
 */
export type ThemeSetting = 'light' | 'dark' | 'system';

export interface Preferences {
  /** CSS の font-family。 */
  readonly fontFamily: string;
  readonly fontSizePx: number;
  /** 倍率（font-size に対する比）。 */
  readonly lineHeight: number;
  /** 段落間隔。em 単位（見出し上の余白などに使う）。 */
  readonly paragraphSpacing: number;
  readonly maxWidthPx: number;
  readonly theme: ThemeSetting;
  readonly focusMode: boolean;
  readonly typewriterMode: boolean;
  /** 執筆中に上部ツールを自動的に隠す（UI-05）。 */
  readonly autoHideChrome: boolean;
}

export const DEFAULT_PREFERENCES: Preferences = {
  fontFamily:
    'system-ui, -apple-system, "Hiragino Sans", "Hiragino Kaku Gothic ProN", "Yu Gothic UI", "Noto Sans CJK JP", "Noto Sans JP", sans-serif',
  fontSizePx: 18,
  lineHeight: 1.9,
  paragraphSpacing: 1,
  maxWidthPx: 680,
  theme: 'system',
  focusMode: false,
  typewriterMode: false,
  autoHideChrome: false,
};

export const RANGES = {
  fontSizePx: { min: 12, max: 48 },
  lineHeight: { min: 1.2, max: 3 },
  paragraphSpacing: { min: 0, max: 3 },
  maxWidthPx: { min: 320, max: 1600 },
} as const;

const THEMES: readonly ThemeSetting[] = ['light', 'dark', 'system'];
const MAX_FONT_FAMILY_LENGTH = 300;
// CSS の宣言やブロックを閉じる・開く文字、タグを含む値は受け付けない。
const FORBIDDEN_FONT_FAMILY_CHARS = /[;{}<>\\\u0000-\u001f]/;

function number(value: unknown, range: { min: number; max: number }, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= range.min && value <= range.max
    ? value
    : fallback;
}

function fontFamily(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim();
  if (trimmed === '' || trimmed.length > MAX_FONT_FAMILY_LENGTH) return fallback;
  if (FORBIDDEN_FONT_FAMILY_CHARS.test(trimmed)) return fallback;
  return trimmed;
}

function boolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

/** 未検証の値（保存ファイルの中身など）から、常に有効な Preferences を作る。 */
export function normalizePreferences(raw: unknown): Preferences {
  const d = DEFAULT_PREFERENCES;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return d;
  const r = raw as Record<string, unknown>;
  return {
    fontFamily: fontFamily(r.fontFamily, d.fontFamily),
    fontSizePx: number(r.fontSizePx, RANGES.fontSizePx, d.fontSizePx),
    lineHeight: number(r.lineHeight, RANGES.lineHeight, d.lineHeight),
    paragraphSpacing: number(r.paragraphSpacing, RANGES.paragraphSpacing, d.paragraphSpacing),
    maxWidthPx: number(r.maxWidthPx, RANGES.maxWidthPx, d.maxWidthPx),
    theme: THEMES.includes(r.theme as ThemeSetting) ? (r.theme as ThemeSetting) : d.theme,
    focusMode: boolean(r.focusMode, d.focusMode),
    typewriterMode: boolean(r.typewriterMode, d.typewriterMode),
    autoHideChrome: boolean(r.autoHideChrome, d.autoHideChrome),
  };
}
