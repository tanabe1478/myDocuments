import type { Preferences } from '../preferences/preferences';
import { blend, contrastRatio, parseHex, WCAG_AA, type Rgb } from './contrast';
import { gradientCss, gradientVariant, type ThemeMode } from './gradients';
import { themeRgb } from './palette';

/** 背景層に描くもの。none はテーマの既定配色だけ。 */
export type BackgroundLayer =
  | { readonly kind: 'none' }
  | { readonly kind: 'color'; readonly color: string }
  | { readonly kind: 'gradient'; readonly css: string }
  | {
      readonly kind: 'image';
      readonly imageId: string;
      readonly brightness: number;
      readonly overlayColor: string;
      readonly overlayOpacity: number;
    };

export interface ContrastReport {
  /** 文字色と、本文面を背景に重ねた色のコントラスト比。画像の平均色が未取得なら null。 */
  readonly ratio: number | null;
  readonly belowAA: boolean;
}

export interface ResolvedCanvas {
  readonly layer: BackgroundLayer;
  /** 実際に使う本文面の不透明度。背景を表示しないときは 1。 */
  readonly surfaceOpacity: number;
  readonly contrast: ContrastReport;
}

const FALLBACK_AVERAGE: Rgb = { r: 128, g: 128, b: 128 };

/** 取り込んだ画像の平均色に、明るさとオーバーレイを反映した色（背景の代表色）。 */
export function imageRepresentative(
  average: Rgb,
  brightness: number,
  overlayColor: Rgb,
  overlayOpacity: number,
): Rgb {
  const dimmed: Rgb = { r: average.r * brightness, g: average.g * brightness, b: average.b * brightness };
  return blend(overlayColor, dimmed, overlayOpacity);
}

/**
 * Preferences とテーマから、描くべき背景層・本文面の不透明度・コントラストを決める。
 * imageAverage は背景画像の平均色（読み込み前・失敗時は null）。
 *
 * 評価する色は、本文の文字色と、「本文面の色を surfaceOpacity で背景の代表色に重ねた色」。
 * 代表色は、単色はその色、グラデーションはプリセットの代表色、画像は平均色（明るさとオーバーレイ反映）。
 */
export function resolveCanvas(prefs: Preferences, mode: ThemeMode, imageAverage: Rgb | null): ResolvedCanvas {
  const colors = themeRgb(mode);
  const bg = prefs.background;

  let layer: BackgroundLayer = { kind: 'none' };
  let representative: Rgb | null = colors.bg;

  if (!prefs.hideBackground) {
    if (bg.kind === 'color') {
      layer = { kind: 'color', color: bg.color };
      representative = parseHex(bg.color) ?? colors.bg;
    } else if (bg.kind === 'gradient') {
      layer = { kind: 'gradient', css: gradientCss(bg.gradientId, mode) };
      representative = parseHex(gradientVariant(bg.gradientId, mode).representative) ?? colors.bg;
    } else if (bg.imageId !== null) {
      const overlayHex = mode === 'dark' ? '#1d1f21' : '#f7f4ec';
      layer = {
        kind: 'image',
        imageId: bg.imageId,
        brightness: prefs.imageBrightness,
        overlayColor: overlayHex,
        overlayOpacity: prefs.overlayOpacity,
      };
      representative =
        imageAverage === null
          ? null
          : imageRepresentative(imageAverage, prefs.imageBrightness, parseHex(overlayHex)!, prefs.overlayOpacity);
    }
  }

  // 背景を表示しないアクセシビリティ設定では、本文面は不透明（既定配色そのまま）。
  const surfaceOpacity = prefs.hideBackground ? 1 : prefs.surfaceOpacity;
  const ratio =
    representative === null ? null : contrastRatio(colors.text, blend(colors.surface, representative, surfaceOpacity));
  return { layer, surfaceOpacity, contrast: { ratio, belowAA: ratio !== null && ratio < WCAG_AA } };
}

/** 画像の平均色（RGBA のバイト列から）。透明な画素は除き、半透明は不透明度で重みを付ける。 */
export function averageColor(rgba: ArrayLike<number>): Rgb {
  let r = 0;
  let g = 0;
  let b = 0;
  let weight = 0;
  for (let i = 0; i + 3 < rgba.length; i += 4) {
    const a = rgba[i + 3]! / 255;
    if (a === 0) continue;
    r += rgba[i]! * a;
    g += rgba[i + 1]! * a;
    b += rgba[i + 2]! * a;
    weight += a;
  }
  if (weight === 0) return FALLBACK_AVERAGE;
  return { r: Math.round(r / weight), g: Math.round(g / weight), b: Math.round(b / weight) };
}
