import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { bundledPlugins } from '../features';
import { createPluginRegistry } from '../plugin-api';
import { DEFAULT_PREFERENCES, RANGES, normalizePreferences as normalizeWith } from './preferences';
import { resolveTheme } from './apply';

const IMAGE_ID = 'ab12'.repeat(16);

// 部品（同梱）が登録した設定を含めて検証する。保存の形は、設定が部品の登録に移る前と同じ。
const pluginSettings = createPluginRegistry(bundledPlugins).settings;
const normalizePreferences = (raw: unknown) => normalizeWith(raw, pluginSettings);
/** 部品の設定が加わった既定値（これまで DEFAULT_PREFERENCES にあった項目を含む）。 */
const DEFAULTS_WITH_PLUGINS = { ...DEFAULT_PREFERENCES, typewriterMode: false };

describe('normalizePreferences', () => {
  it('uses the defaults for missing or non-object input', () => {
    expect(normalizePreferences(undefined)).toEqual(DEFAULTS_WITH_PLUGINS);
    expect(normalizePreferences(null)).toEqual(DEFAULTS_WITH_PLUGINS);
    expect(normalizePreferences('x')).toEqual(DEFAULTS_WITH_PLUGINS);
    expect(normalizePreferences([1])).toEqual(DEFAULTS_WITH_PLUGINS);
    expect(normalizePreferences({})).toEqual(DEFAULTS_WITH_PLUGINS);
  });

  it('has the default max width of 680px (UI-01)', () => {
    expect(DEFAULT_PREFERENCES.maxWidthPx).toBe(680);
  });

  it('keeps valid values', () => {
    const valid = {
      fontFamily: '"Noto Serif JP", serif',
      fontSizePx: 20,
      lineHeight: 2,
      paragraphSpacing: 1.5,
      letterSpacing: 0.05,
      maxWidthPx: 720,
      surfaceWidth: 'text',
      sidebarOpen: true,
      theme: 'dark',
      focusMode: true,
      typewriterMode: true,
      autoHideChrome: true,
      background: { kind: 'image', color: '#102030', gradientId: 'forest', imageId: IMAGE_ID },
      imageBrightness: 0.5,
      overlayOpacity: 0.6,
      surfaceOpacity: 0.7,
      hideBackground: true,
      listContinuation: 'preserve',
      markupDisplay: 'always',
    };
    expect(normalizePreferences(valid)).toEqual(valid);
  });

  it('accepts the range boundaries', () => {
    const p = normalizePreferences({
      fontSizePx: RANGES.fontSizePx.min,
      maxWidthPx: RANGES.maxWidthPx.max,
      lineHeight: RANGES.lineHeight.max,
      paragraphSpacing: RANGES.paragraphSpacing.min,
    });
    expect(p.fontSizePx).toBe(RANGES.fontSizePx.min);
    expect(p.maxWidthPx).toBe(RANGES.maxWidthPx.max);
    expect(p.lineHeight).toBe(RANGES.lineHeight.max);
    expect(p.paragraphSpacing).toBe(RANGES.paragraphSpacing.min);
  });

  it('resets out-of-range numbers to the default, only for that field', () => {
    const p = normalizePreferences({
      fontSizePx: 4,
      lineHeight: 99,
      paragraphSpacing: -1,
      maxWidthPx: 100000,
      theme: 'dark',
    });
    expect(p.fontSizePx).toBe(DEFAULT_PREFERENCES.fontSizePx);
    expect(p.lineHeight).toBe(DEFAULT_PREFERENCES.lineHeight);
    expect(p.paragraphSpacing).toBe(DEFAULT_PREFERENCES.paragraphSpacing);
    expect(p.maxWidthPx).toBe(DEFAULT_PREFERENCES.maxWidthPx);
    expect(p.theme).toBe('dark');
  });

  it('rejects wrong types and non-finite numbers', () => {
    const p = normalizePreferences({
      fontSizePx: '20',
      lineHeight: Number.NaN,
      maxWidthPx: Infinity,
      theme: 'blue',
      focusMode: 'yes',
      typewriterMode: 1,
      fontFamily: 42,
    });
    expect(p).toEqual(DEFAULTS_WITH_PLUGINS);
  });

  it('rejects font families that could break out of a CSS declaration', () => {
    for (const bad of ['', '   ', 'a; color: red', 'a } body { x', '<script>', 'a\\b', 'x'.repeat(301), 'a\nb']) {
      expect(normalizePreferences({ fontFamily: bad }).fontFamily).toBe(DEFAULT_PREFERENCES.fontFamily);
    }
  });

  it('trims the font family', () => {
    expect(normalizePreferences({ fontFamily: '  serif  ' }).fontFamily).toBe('serif');
  });

  it('is idempotent', () => {
    const once = normalizePreferences({ fontSizePx: 22, theme: 'light', maxWidthPx: 1 });
    expect(normalizePreferences(once)).toEqual(once);
  });
});

describe('background and accessibility fields (R3-1)', () => {
  it('has defaults inside the allowed ranges', () => {
    const d = DEFAULT_PREFERENCES;
    expect(d.imageBrightness).toBeGreaterThanOrEqual(RANGES.imageBrightness.min);
    expect(d.imageBrightness).toBeLessThanOrEqual(RANGES.imageBrightness.max);
    expect(d.overlayOpacity).toBeLessThanOrEqual(RANGES.overlayOpacity.max);
    expect(d.surfaceOpacity).toBeLessThanOrEqual(RANGES.surfaceOpacity.max);
    expect(d.hideBackground).toBe(false);
    expect(d.background.imageId).toBeNull();
    expect(RANGES.imageBrightness).toEqual({ min: 0.2, max: 1 });
    expect(RANGES.overlayOpacity).toEqual({ min: 0, max: 0.9 });
    expect(RANGES.surfaceOpacity).toEqual({ min: 0, max: 1 });
  });

  it('reads a saved value from before these fields existed (Run 2 format)', () => {
    const old = {
      fontFamily: 'serif',
      fontSizePx: 22,
      lineHeight: 2,
      paragraphSpacing: 1,
      maxWidthPx: 700,
      theme: 'dark',
      focusMode: true,
      typewriterMode: false,
      autoHideChrome: true,
    };
    expect(normalizePreferences(old)).toEqual({
      ...old,
      background: DEFAULT_PREFERENCES.background,
      imageBrightness: DEFAULT_PREFERENCES.imageBrightness,
      overlayOpacity: DEFAULT_PREFERENCES.overlayOpacity,
      surfaceOpacity: DEFAULT_PREFERENCES.surfaceOpacity,
      hideBackground: DEFAULT_PREFERENCES.hideBackground,
      // Run 5 で増えた項目。
      letterSpacing: DEFAULT_PREFERENCES.letterSpacing,
      // Run 8 で増えた項目。
      surfaceWidth: DEFAULT_PREFERENCES.surfaceWidth,
      sidebarOpen: DEFAULT_PREFERENCES.sidebarOpen,
      // Run 11 で増えた項目。
      listContinuation: DEFAULT_PREFERENCES.listContinuation,
      // Run 12 で増えた項目。
      markupDisplay: DEFAULT_PREFERENCES.markupDisplay,
    });
  });

  it('accepts the range boundaries of the new numbers', () => {
    expect(normalizePreferences({ imageBrightness: 0.2, overlayOpacity: 0, surfaceOpacity: 0 })).toMatchObject({
      imageBrightness: 0.2,
      overlayOpacity: 0,
      surfaceOpacity: 0,
    });
    expect(normalizePreferences({ imageBrightness: 1, overlayOpacity: 0.9, surfaceOpacity: 1 })).toMatchObject({
      imageBrightness: 1,
      overlayOpacity: 0.9,
      surfaceOpacity: 1,
    });
  });

  it('resets each out-of-range new number to its own default', () => {
    const d = DEFAULT_PREFERENCES;
    const p = normalizePreferences({
      imageBrightness: 0.19,
      overlayOpacity: 0.91,
      surfaceOpacity: 1.01,
      hideBackground: 'yes',
      theme: 'dark',
    });
    expect(p.imageBrightness).toBe(d.imageBrightness);
    expect(p.overlayOpacity).toBe(d.overlayOpacity);
    expect(p.surfaceOpacity).toBe(d.surfaceOpacity);
    expect(p.hideBackground).toBe(d.hideBackground);
    expect(p.theme).toBe('dark');
    expect(normalizePreferences({ surfaceOpacity: -0.1 }).surfaceOpacity).toBe(d.surfaceOpacity);
    expect(normalizePreferences({ surfaceOpacity: Number.NaN }).surfaceOpacity).toBe(d.surfaceOpacity);
  });

  it('validates each background field on its own', () => {
    const d = DEFAULT_PREFERENCES.background;
    const p = normalizePreferences({
      background: { kind: 'video', color: 'red', gradientId: 'nope', imageId: '../../x' },
    });
    expect(p.background).toEqual(d);
    // 一部だけ有効なら、有効な項目は残る。
    const partial = normalizePreferences({ background: { kind: 'color', color: '#ABCDEF', gradientId: 'nope', imageId: 7 } });
    expect(partial.background).toEqual({ ...d, kind: 'color', color: '#abcdef' });
  });

  it('accepts only the defined gradient ids, and 64-hex image ids', () => {
    for (const id of ['paper', 'dusk', 'forest', 'harbor', 'ember']) {
      expect(normalizePreferences({ background: { gradientId: id } }).background.gradientId).toBe(id);
    }
    expect(normalizePreferences({ background: { imageId: IMAGE_ID } }).background.imageId).toBe(IMAGE_ID);
    for (const bad of ['', 'a'.repeat(63), 'A'.repeat(64), `${'a'.repeat(63)}/`, 'a'.repeat(60) + '.png']) {
      expect(normalizePreferences({ background: { imageId: bad } }).background.imageId).toBeNull();
    }
  });

  it('rejects a background that is not an object', () => {
    for (const bad of [null, 'color', 1, [1], undefined]) {
      expect(normalizePreferences({ background: bad }).background).toEqual(DEFAULT_PREFERENCES.background);
    }
  });

  it('is idempotent with the new fields', () => {
    const once = normalizePreferences({
      background: { kind: 'color', color: '#00ff00' },
      surfaceOpacity: 0.3,
      hideBackground: true,
    });
    expect(normalizePreferences(once)).toEqual(once);
  });
});

describe('listContinuation (Run 11)', () => {
  it('defaults to tight', () => {
    expect(DEFAULT_PREFERENCES.listContinuation).toBe('tight');
    expect(normalizePreferences({}).listContinuation).toBe('tight');
    expect(normalizePreferences(null).listContinuation).toBe('tight');
  });

  it('keeps the two valid values', () => {
    expect(normalizePreferences({ listContinuation: 'tight' }).listContinuation).toBe('tight');
    expect(normalizePreferences({ listContinuation: 'preserve' }).listContinuation).toBe('preserve');
  });

  it('resets any other value to the default, only for that field', () => {
    for (const bad of ['loose', '', 'Preserve', 1, true, null, ['preserve'], {}]) {
      const p = normalizePreferences({ listContinuation: bad, theme: 'dark' });
      expect(p.listContinuation).toBe('tight');
      expect(p.theme).toBe('dark');
    }
  });
});

describe('markupDisplay (Run 12)', () => {
  it('defaults to cursorLine', () => {
    expect(DEFAULT_PREFERENCES.markupDisplay).toBe('cursorLine');
    expect(normalizePreferences({}).markupDisplay).toBe('cursorLine');
    expect(normalizePreferences(null).markupDisplay).toBe('cursorLine');
  });

  it('keeps the two valid values', () => {
    expect(normalizePreferences({ markupDisplay: 'cursorLine' }).markupDisplay).toBe('cursorLine');
    expect(normalizePreferences({ markupDisplay: 'always' }).markupDisplay).toBe('always');
  });

  it('resets any other value to the default, only for that field', () => {
    for (const bad of ['hidden', '', 'Always', 'cursorline', 1, true, null, ['always'], {}]) {
      const p = normalizePreferences({ markupDisplay: bad, theme: 'dark', listContinuation: 'preserve' });
      expect(p.markupDisplay).toBe('cursorLine');
      expect(p.theme).toBe('dark');
      expect(p.listContinuation).toBe('preserve');
    }
  });

  it('is filled in for a saved value that predates the field', () => {
    expect(normalizePreferences({ theme: 'dark', listContinuation: 'preserve' }).markupDisplay).toBe('cursorLine');
  });
});

describe('resolveTheme', () => {
  it('follows the system only for system', () => {
    expect(resolveTheme('system', true)).toBe('dark');
    expect(resolveTheme('system', false)).toBe('light');
    expect(resolveTheme('light', true)).toBe('light');
    expect(resolveTheme('dark', false)).toBe('dark');
  });
});

describe('writing feel (Run 5)', () => {
  it('has the new defaults: paragraph gap 0.6 line, letter spacing 0.02em, auto-hide on', () => {
    const d = DEFAULT_PREFERENCES;
    expect(d.paragraphSpacing).toBe(0.6);
    expect(d.letterSpacing).toBe(0.02);
    expect(d.autoHideChrome).toBe(true);
    expect(RANGES.letterSpacing).toEqual({ min: 0, max: 0.15 });
    expect(RANGES.paragraphSpacing).toEqual({ min: 0, max: 3 });
  });

  it('respects a saved autoHideChrome=false, and turns it on only when nothing was saved', () => {
    expect(normalizePreferences({ autoHideChrome: false }).autoHideChrome).toBe(false);
    expect(normalizePreferences({ autoHideChrome: true }).autoHideChrome).toBe(true);
    expect(normalizePreferences({ theme: 'dark' }).autoHideChrome).toBe(true);
    expect(normalizePreferences({ autoHideChrome: 'no' }).autoHideChrome).toBe(true);
  });

  it('keeps an old saved paragraphSpacing (em in the old format; still inside the range)', () => {
    for (const old of [0, 1, 2, 3]) expect(normalizePreferences({ paragraphSpacing: old }).paragraphSpacing).toBe(old);
    expect(normalizePreferences({ paragraphSpacing: 4 }).paragraphSpacing).toBe(DEFAULT_PREFERENCES.paragraphSpacing);
  });

  it('validates letterSpacing: range boundaries kept, out of range and wrong types reset', () => {
    expect(normalizePreferences({ letterSpacing: 0 }).letterSpacing).toBe(0);
    expect(normalizePreferences({ letterSpacing: 0.15 }).letterSpacing).toBe(0.15);
    for (const bad of [-0.01, 0.16, '0.05', Number.NaN, null]) {
      expect(normalizePreferences({ letterSpacing: bad }).letterSpacing).toBe(DEFAULT_PREFERENCES.letterSpacing);
    }
  });
});

describe('paper width and sidebar (Run 8)', () => {
  it('defaults: the paper fills the body area and the sidebar is closed', () => {
    expect(DEFAULT_PREFERENCES.surfaceWidth).toBe('fill');
    expect(DEFAULT_PREFERENCES.sidebarOpen).toBe(false);
  });

  it('keeps both surfaceWidth values', () => {
    expect(normalizePreferences({ surfaceWidth: 'fill' }).surfaceWidth).toBe('fill');
    expect(normalizePreferences({ surfaceWidth: 'text' }).surfaceWidth).toBe('text');
  });

  it('resets an invalid surfaceWidth to the default, only for that field', () => {
    for (const bad of ['wide', '', 'FILL', 1, true, null, {}, []]) {
      const p = normalizePreferences({ surfaceWidth: bad, theme: 'dark' });
      expect(p.surfaceWidth).toBe('fill');
      expect(p.theme).toBe('dark');
    }
  });

  it('keeps a boolean sidebarOpen and resets other types to closed', () => {
    expect(normalizePreferences({ sidebarOpen: true }).sidebarOpen).toBe(true);
    expect(normalizePreferences({ sidebarOpen: false }).sidebarOpen).toBe(false);
    for (const bad of ['true', 1, 0, null, {}]) expect(normalizePreferences({ sidebarOpen: bad }).sidebarOpen).toBe(false);
  });

  it('reads a value saved before these fields existed: paper fills, sidebar closed', () => {
    const p = normalizePreferences({ fontSizePx: 20, theme: 'dark' });
    expect(p.surfaceWidth).toBe('fill');
    expect(p.sidebarOpen).toBe(false);
    expect(p.fontSizePx).toBe(20);
  });

  it('is idempotent', () => {
    const once = normalizePreferences({ surfaceWidth: 'text', sidebarOpen: true });
    expect(normalizePreferences(once)).toEqual(once);
  });
});

describe('stored shape of plugin settings (R1: the typewriter setting moved into a plugin)', () => {
  interface GoldenCase {
    name: string;
    input: unknown;
    /** 変更前（R1 の前のコミット）の normalizePreferences の結果を、キーを並べ替えて整形した文字列。 */
    expected: string;
  }
  const golden = JSON.parse(readFileSync(new URL('./storedShape.golden.json', import.meta.url), 'utf8')) as GoldenCase[];

  /** Rust 側（serde_json の整形出力）と同じ、キーを並べ替えた整形。保存されるバイト列の形。 */
  const sortKeys = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(sortKeys)
      : v && typeof v === 'object'
        ? Object.fromEntries(
            Object.entries(v)
              .sort(([a], [b]) => (a < b ? -1 : 1))
              .map(([k, x]) => [k, sortKeys(x)]),
          )
        : v;
  const bytes = (prefs: unknown) => JSON.stringify(sortKeys(prefs), null, 2) + '\n';

  it('saves the same bytes as before for every case, including old and broken files', () => {
    expect(golden.length).toBeGreaterThanOrEqual(10);
    for (const c of golden) {
      expect(bytes(normalizePreferences(c.input)), c.name).toBe(c.expected);
    }
  });

  it('keeps the setting as a boolean at the top level, under the same key', () => {
    expect(normalizePreferences({ typewriterMode: true }).typewriterMode).toBe(true);
    expect(Object.keys(normalizePreferences({}))).toContain('typewriterMode');
    for (const bad of [1, 'true', null, [true], {}, undefined]) {
      expect(normalizePreferences({ typewriterMode: bad }).typewriterMode, String(bad)).toBe(false);
    }
  });

  it('drops keys that no loaded plugin defines (as before), and plugin keys when no plugin is loaded', () => {
    expect(normalizePreferences({ someFutureKey: 1 })).not.toHaveProperty('someFutureKey');
    expect(normalizeWith({ typewriterMode: true })).not.toHaveProperty('typewriterMode');
    expect(normalizeWith({ typewriterMode: true })).toEqual(DEFAULT_PREFERENCES);
  });

  it('reads settings of any plugin generically', () => {
    const settings = [{ key: 'demoCount', defaultValue: 3, normalize: (raw: unknown) => (typeof raw === 'number' ? raw : 3) }];
    expect(normalizeWith({ demoCount: 7, theme: 'dark' }, settings)).toMatchObject({ demoCount: 7, theme: 'dark' });
    expect(normalizeWith({ demoCount: 'x' }, settings).demoCount).toBe(3);
    expect(normalizeWith(null, settings).demoCount).toBe(3);
  });
});
