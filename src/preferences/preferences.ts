/**
 * 型付き Preferences。保存形式は JSON オブジェクトで、検証はここが唯一の定義
 * （Rust 側は中身を解釈しない）。範囲外・型違いの項目は、その項目だけ既定値に戻す。
 * 設定画面は src/ui/SettingsDialog.tsx。古い保存値（項目が足りない）も、足りない項目だけ既定値になる。
 */
import { DEFAULT_GRADIENT_ID, isGradientId, type GradientId } from '../canvas/gradients';
import type { SettingDefinition } from '../plugin-api';

export type ThemeSetting = 'light' | 'dark' | 'system';

/** 紙（本文面）の幅。fill: 本文領域（サイドバーを除いた領域）いっぱい。text: 本文の最大幅 + 左右の余白に合わせる。 */
export type SurfaceWidth = 'fill' | 'text';

/**
 * リストで Enter を押して次の項目を続けるときの空行の扱い。
 * tight: 空行を入れない。preserve: 項目の間に空行のあるリスト（loose list）では、次の項目の前にも空行を入れる。
 */
export type ListContinuation = 'tight' | 'preserve';

/**
 * Markdown の記号（見出しの #、リンクの []() など）の見せ方。
 * cursorLine: カーソルのある行（と選択にかかる行）だけ記号を見せ、ほかの行は記号を隠して整形して見せる。
 * always: すべての行で記号を薄く表示する（隠さない）。
 */
export type MarkupDisplay = 'cursorLine' | 'always';

export type BackgroundKind = 'color' | 'gradient' | 'image';

export interface BackgroundSetting {
  readonly kind: BackgroundKind;
  /** 単色の色。#rrggbb（小文字）。 */
  readonly color: string;
  readonly gradientId: GradientId;
  /** 取り込んだ背景画像の id（内容の SHA-256 の 16 進 64 文字）。未選択は null。 */
  readonly imageId: string | null;
}

export interface Preferences {
  /** CSS の font-family。 */
  readonly fontFamily: string;
  readonly fontSizePx: number;
  /** 倍率（font-size に対する比）。 */
  readonly lineHeight: number;
  /**
   * 段落間隔。空行 1 つの高さを、本文の行高に対する倍率で表す（1 は本文 1 行分、0 でも 4px は残す）。
   * 見出し前の余白も、この値を基準にする。
   * 以前は em 単位で見出し前の余白にだけ効いていた。値の範囲は変えていないので、旧い保存値は読み込める。
   */
  readonly paragraphSpacing: number;
  /** 字間。em 単位（文字サイズに対する比）。 */
  readonly letterSpacing: number;
  readonly maxWidthPx: number;
  readonly surfaceWidth: SurfaceWidth;
  /** 左サイドバーを開いているか。次の起動で復元する。 */
  readonly sidebarOpen: boolean;
  readonly theme: ThemeSetting;
  /** 執筆中に上部ツールを自動的に隠す（UI-05）。 */
  readonly autoHideChrome: boolean;
  readonly background: BackgroundSetting;
  /** 背景画像の明るさ（1 が元の明るさ）。 */
  readonly imageBrightness: number;
  /** 背景画像に重ねるオーバーレイの濃度。 */
  readonly overlayOpacity: number;
  /** 本文面（本文の下の面）の不透明度。 */
  readonly surfaceOpacity: number;
  /** 背景を描かず、テーマの既定配色だけにする（アクセシビリティ）。 */
  readonly hideBackground: boolean;
  /** リストで Enter を押したときの継続（空行を入れるか）。 */
  readonly listContinuation: ListContinuation;
  /** Markdown の記号の見せ方（.txt、.text には効かない）。 */
  readonly markupDisplay: MarkupDisplay;
}

/**
 * 保存・設定画面で扱う設定の全体。本体の設定（Preferences）と、部品が登録した設定（src/plugin-api/）を、
 * 同じ 1 つの JSON オブジェクト（最上位のキー）に並べたもの。部品の設定の保存の形は、部品の登録の前と変わらない。
 */
export type StoredPreferences = Preferences & { readonly [pluginSetting: string]: unknown };

export const DEFAULT_PREFERENCES: Preferences = {
  fontFamily:
    'system-ui, -apple-system, "Hiragino Sans", "Hiragino Kaku Gothic ProN", "Yu Gothic UI", "Noto Sans CJK JP", "Noto Sans JP", sans-serif',
  fontSizePx: 18,
  lineHeight: 1.9,
  paragraphSpacing: 0.6,
  letterSpacing: 0.02,
  maxWidthPx: 680,
  surfaceWidth: 'fill',
  sidebarOpen: false,
  theme: 'system',
  autoHideChrome: true,
  background: { kind: 'gradient', color: '#e9e4d4', gradientId: DEFAULT_GRADIENT_ID, imageId: null },
  imageBrightness: 0.8,
  overlayOpacity: 0.35,
  surfaceOpacity: 0.85,
  hideBackground: false,
  listContinuation: 'tight',
  markupDisplay: 'cursorLine',
};

export const RANGES = {
  fontSizePx: { min: 12, max: 48 },
  lineHeight: { min: 1.2, max: 3 },
  paragraphSpacing: { min: 0, max: 3 },
  letterSpacing: { min: 0, max: 0.15 },
  maxWidthPx: { min: 320, max: 1600 },
  imageBrightness: { min: 0.2, max: 1 },
  overlayOpacity: { min: 0, max: 0.9 },
  surfaceOpacity: { min: 0, max: 1 },
} as const;

const THEMES: readonly ThemeSetting[] = ['light', 'dark', 'system'];
const SURFACE_WIDTHS: readonly SurfaceWidth[] = ['fill', 'text'];
const LIST_CONTINUATIONS: readonly ListContinuation[] = ['tight', 'preserve'];
const MARKUP_DISPLAYS: readonly MarkupDisplay[] = ['cursorLine', 'always'];
const BACKGROUND_KINDS: readonly BackgroundKind[] = ['color', 'gradient', 'image'];
const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;
const IMAGE_ID = /^[0-9a-f]{64}$/;
const MAX_FONT_FAMILY_LENGTH = 300;
// CSS の宣言やブロックを閉じる・開く文字、タグを含む値は受け付けない。
const FORBIDDEN_FONT_FAMILY_CHARS = /[;{}<>\\\u0000-\u001f]/;

function number(value: unknown, range: { min: number; max: number }, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= range.min && value <= range.max
    ? value
    : fallback;
}

/** CSS の font-family として使える値か。使えなければ null。 */
export function validFontFamily(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed === '' || trimmed.length > MAX_FONT_FAMILY_LENGTH) return null;
  if (FORBIDDEN_FONT_FAMILY_CHARS.test(trimmed)) return null;
  return trimmed;
}

function fontFamily(value: unknown, fallback: string): string {
  return validFontFamily(value) ?? fallback;
}

function boolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function background(value: unknown, fallback: BackgroundSetting): BackgroundSetting {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return fallback;
  const b = value as Record<string, unknown>;
  return {
    kind: BACKGROUND_KINDS.includes(b.kind as BackgroundKind) ? (b.kind as BackgroundKind) : fallback.kind,
    color: typeof b.color === 'string' && HEX_COLOR.test(b.color) ? b.color.toLowerCase() : fallback.color,
    gradientId: isGradientId(b.gradientId) ? b.gradientId : fallback.gradientId,
    imageId: typeof b.imageId === 'string' && IMAGE_ID.test(b.imageId) ? b.imageId : b.imageId === null ? null : fallback.imageId,
  };
}

/**
 * 未検証の値（保存ファイルの中身など）から、常に有効な Preferences を作る。
 * pluginSettings（部品が登録した設定の定義）があれば、その値も同じ最上位に検証して並べる。定義のないキーは捨てる。
 */
export function normalizePreferences(raw: unknown, pluginSettings: readonly SettingDefinition<unknown>[] = []): StoredPreferences {
  const core = normalizeCore(raw);
  if (pluginSettings.length === 0) return core as StoredPreferences;
  const r = typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const stored: Record<string, unknown> = { ...core };
  for (const setting of pluginSettings) stored[setting.key] = setting.normalize(r[setting.key]);
  return stored as StoredPreferences;
}

function normalizeCore(raw: unknown): Preferences {
  const d = DEFAULT_PREFERENCES;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return d;
  const r = raw as Record<string, unknown>;
  return {
    fontFamily: fontFamily(r.fontFamily, d.fontFamily),
    fontSizePx: number(r.fontSizePx, RANGES.fontSizePx, d.fontSizePx),
    lineHeight: number(r.lineHeight, RANGES.lineHeight, d.lineHeight),
    paragraphSpacing: number(r.paragraphSpacing, RANGES.paragraphSpacing, d.paragraphSpacing),
    letterSpacing: number(r.letterSpacing, RANGES.letterSpacing, d.letterSpacing),
    maxWidthPx: number(r.maxWidthPx, RANGES.maxWidthPx, d.maxWidthPx),
    surfaceWidth: SURFACE_WIDTHS.includes(r.surfaceWidth as SurfaceWidth) ? (r.surfaceWidth as SurfaceWidth) : d.surfaceWidth,
    sidebarOpen: boolean(r.sidebarOpen, d.sidebarOpen),
    theme: THEMES.includes(r.theme as ThemeSetting) ? (r.theme as ThemeSetting) : d.theme,
    autoHideChrome: boolean(r.autoHideChrome, d.autoHideChrome),
    background: background(r.background, d.background),
    imageBrightness: number(r.imageBrightness, RANGES.imageBrightness, d.imageBrightness),
    overlayOpacity: number(r.overlayOpacity, RANGES.overlayOpacity, d.overlayOpacity),
    surfaceOpacity: number(r.surfaceOpacity, RANGES.surfaceOpacity, d.surfaceOpacity),
    hideBackground: boolean(r.hideBackground, d.hideBackground),
    listContinuation: LIST_CONTINUATIONS.includes(r.listContinuation as ListContinuation)
      ? (r.listContinuation as ListContinuation)
      : d.listContinuation,
    markupDisplay: MARKUP_DISPLAYS.includes(r.markupDisplay as MarkupDisplay)
      ? (r.markupDisplay as MarkupDisplay)
      : d.markupDisplay,
  };
}
