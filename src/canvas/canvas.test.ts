/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DEFAULT_PREFERENCES, normalizePreferences, type Preferences } from '../preferences/preferences';
import { averageColor, imageRepresentative, resolveCanvas } from './canvas';
import { blend, contrastRatio, parseHex, WCAG_AA, WCAG_AAA } from './contrast';
import { GRADIENTS, gradientCss, gradientVariant, isGradientId, type ThemeMode } from './gradients';
import { THEME_COLORS, themeRgb } from './palette';

const MODES: ThemeMode[] = ['light', 'dark'];
const prefs = (patch: Partial<Preferences>): Preferences => normalizePreferences({ ...DEFAULT_PREFERENCES, ...patch });

describe('default colors (UI-08)', () => {
  it.each(MODES)('text on the default surface is at least 7:1 in %s', (mode) => {
    const { text, surface } = themeRgb(mode);
    expect(contrastRatio(text, surface)).toBeGreaterThanOrEqual(WCAG_AAA);
  });

  it.each(MODES)('text on the theme background is at least 7:1 in %s', (mode) => {
    const { text, bg } = themeRgb(mode);
    expect(contrastRatio(text, bg)).toBeGreaterThanOrEqual(WCAG_AAA);
  });

  it.each(MODES)('the default Preferences give at least 7:1 on the default background in %s', (mode) => {
    const r = resolveCanvas(DEFAULT_PREFERENCES, mode, null).contrast;
    expect(r.ratio).not.toBeNull();
    expect(r.ratio!).toBeGreaterThanOrEqual(WCAG_AAA);
    expect(r.belowAA).toBe(false);
  });

  it('keeps the palette in sync with styles.css', () => {
    const css = readFileSync(new URL('../styles.css', import.meta.url), 'utf8');
    const block = (selector: string) => {
      const start = css.indexOf(selector);
      return css.slice(start, css.indexOf('}', start));
    };
    const blocks: Record<ThemeMode, string> = {
      light: block(":root,\n:root[data-theme='light'] {"),
      dark: block(":root[data-theme='dark'] {"),
    };
    for (const mode of MODES) {
      for (const [name, key] of [
        ['text', 'text'],
        ['surface', 'surface'],
        ['bg', 'bg'],
      ] as const) {
        expect(blocks[mode], `${mode} ${name}`).toContain(`--md-color-${key}: ${THEME_COLORS[mode][name]};`);
      }
    }
  });
});

describe('gradient presets', () => {
  it('has several presets with unique ids, each with light and dark variants', () => {
    expect(GRADIENTS.length).toBeGreaterThanOrEqual(4);
    expect(new Set(GRADIENTS.map((g) => g.id)).size).toBe(GRADIENTS.length);
    for (const g of GRADIENTS) {
      for (const mode of MODES) {
        for (const color of [g[mode].from, g[mode].to, g[mode].representative]) expect(parseHex(color)).not.toBeNull();
      }
    }
  });

  it('uses the midpoint of its two stops as the representative color', () => {
    for (const g of GRADIENTS) {
      for (const mode of MODES) {
        const from = parseHex(g[mode].from)!;
        const to = parseHex(g[mode].to)!;
        const rep = parseHex(g[mode].representative)!;
        const mid = blend(from, to, 0.5);
        expect(Math.abs(rep.r - mid.r)).toBeLessThanOrEqual(1);
        expect(Math.abs(rep.g - mid.g)).toBeLessThanOrEqual(1);
        expect(Math.abs(rep.b - mid.b)).toBeLessThanOrEqual(1);
      }
    }
  });

  it('keeps text readable (AA) on every preset at the default surface opacity', () => {
    for (const g of GRADIENTS) {
      for (const mode of MODES) {
        const r = resolveCanvas(prefs({ background: { ...DEFAULT_PREFERENCES.background, kind: 'gradient', gradientId: g.id } }), mode, null);
        expect(r.contrast.ratio!, `${g.id} ${mode}`).toBeGreaterThanOrEqual(WCAG_AA);
      }
    }
  });

  it('validates ids and builds css', () => {
    expect(isGradientId('paper')).toBe(true);
    expect(isGradientId('x')).toBe(false);
    expect(gradientCss('paper', 'dark')).toMatch(/^linear-gradient\(/);
    expect(gradientCss('paper', 'light')).not.toBe(gradientCss('paper', 'dark'));
  });
});

describe('resolveCanvas: the evaluated colors', () => {
  it('uses the text color against the surface blended over the representative background', () => {
    // 単色 #000000、本文面の不透明度 0.5（ライト）: 本文面 #fbf8f0 を黒に 50% で重ねた色と、文字色 #2a2824 の比
    const p = prefs({ background: { ...DEFAULT_PREFERENCES.background, kind: 'color', color: '#000000' }, surfaceOpacity: 0.5 });
    const { text, surface } = themeRgb('light');
    const expected = contrastRatio(text, blend(surface, parseHex('#000000')!, 0.5));
    expect(resolveCanvas(p, 'light', null).contrast.ratio).toBeCloseTo(expected, 10);
  });

  it('with an opaque surface, the background does not matter', () => {
    const { text, surface } = themeRgb('light');
    const p = prefs({ background: { ...DEFAULT_PREFERENCES.background, kind: 'color', color: '#000000' }, surfaceOpacity: 1 });
    expect(resolveCanvas(p, 'light', null).contrast.ratio).toBeCloseTo(contrastRatio(text, surface), 10);
  });

  it('warns below 4.5 and not at or above it', () => {
    const dark = prefs({ background: { ...DEFAULT_PREFERENCES.background, kind: 'color', color: '#000000' }, surfaceOpacity: 0 });
    const low = resolveCanvas(dark, 'light', null);
    expect(low.contrast.ratio!).toBeLessThan(WCAG_AA);
    expect(low.contrast.belowAA).toBe(true);
    const ok = resolveCanvas(prefs({ surfaceOpacity: 1 }), 'light', null);
    expect(ok.contrast.belowAA).toBe(false);
  });

  it('uses the preset representative color for a gradient', () => {
    const p = prefs({ background: { ...DEFAULT_PREFERENCES.background, kind: 'gradient', gradientId: 'ember' }, surfaceOpacity: 0 });
    const { text } = themeRgb('dark');
    expect(resolveCanvas(p, 'dark', null).contrast.ratio).toBeCloseTo(
      contrastRatio(text, parseHex(gradientVariant('ember', 'dark').representative)!),
      10,
    );
  });

  it('uses the average color, reflecting brightness and overlay, for an image', () => {
    const id = 'ab'.repeat(32);
    const p = prefs({
      background: { ...DEFAULT_PREFERENCES.background, kind: 'image', imageId: id },
      imageBrightness: 0.5,
      overlayOpacity: 0.4,
      surfaceOpacity: 0,
    });
    const average = { r: 200, g: 100, b: 50 };
    const { text, bg } = themeRgb('light');
    const rep = imageRepresentative(average, 0.5, bg, 0.4);
    expect(rep).toEqual(blend(bg, { r: 100, g: 50, b: 25 }, 0.4));
    const r = resolveCanvas(p, 'light', average);
    expect(r.contrast.ratio).toBeCloseTo(contrastRatio(text, rep), 10);
    expect(r.layer).toMatchObject({ kind: 'image', imageId: id, brightness: 0.5, overlayOpacity: 0.4 });
  });

  it('has no ratio yet while the image average is unknown', () => {
    const p = prefs({ background: { ...DEFAULT_PREFERENCES.background, kind: 'image', imageId: 'ab'.repeat(32) } });
    const r = resolveCanvas(p, 'light', null);
    expect(r.contrast).toEqual({ ratio: null, belowAA: false });
  });

  it('draws nothing for an image kind without an image', () => {
    const r = resolveCanvas(prefs({ background: { ...DEFAULT_PREFERENCES.background, kind: 'image', imageId: null } }), 'light', null);
    expect(r.layer).toEqual({ kind: 'none' });
    expect(r.contrast.ratio).not.toBeNull();
  });
});

describe('resolveCanvas: hide background (accessibility)', () => {
  it.each(MODES)('draws no layer and uses the opaque theme colors in %s', (mode) => {
    const p = prefs({
      background: { ...DEFAULT_PREFERENCES.background, kind: 'color', color: '#000000' },
      surfaceOpacity: 0,
      hideBackground: true,
    });
    const r = resolveCanvas(p, mode, null);
    const { text, surface } = themeRgb(mode);
    expect(r.layer).toEqual({ kind: 'none' });
    expect(r.surfaceOpacity).toBe(1);
    expect(r.contrast.ratio).toBeCloseTo(contrastRatio(text, surface), 10);
    expect(r.contrast.ratio!).toBeGreaterThanOrEqual(WCAG_AAA);
  });
});

describe('averageColor', () => {
  it('averages opaque pixels', () => {
    expect(averageColor([255, 0, 0, 255, 0, 0, 255, 255])).toEqual({ r: 128, g: 0, b: 128 });
  });

  it('ignores fully transparent pixels and weights partial alpha', () => {
    expect(averageColor([10, 20, 30, 255, 200, 200, 200, 0])).toEqual({ r: 10, g: 20, b: 30 });
    // 不透明の黒 1 + 半透明（0.5）の白 1: 白の重みは半分
    const c = averageColor([0, 0, 0, 255, 255, 255, 255, 128]);
    expect(c.r).toBe(Math.round((255 * (128 / 255)) / (1 + 128 / 255)));
  });

  it('falls back to mid gray when nothing is visible', () => {
    expect(averageColor([])).toEqual({ r: 128, g: 128, b: 128 });
    expect(averageColor([1, 2, 3, 0])).toEqual({ r: 128, g: 128, b: 128 });
  });
});
