import { describe, expect, it } from 'vitest';
import { DEFAULT_PREFERENCES, RANGES, normalizePreferences } from './preferences';
import { resolveTheme } from './apply';

describe('normalizePreferences', () => {
  it('uses the defaults for missing or non-object input', () => {
    expect(normalizePreferences(undefined)).toEqual(DEFAULT_PREFERENCES);
    expect(normalizePreferences(null)).toEqual(DEFAULT_PREFERENCES);
    expect(normalizePreferences('x')).toEqual(DEFAULT_PREFERENCES);
    expect(normalizePreferences([1])).toEqual(DEFAULT_PREFERENCES);
    expect(normalizePreferences({})).toEqual(DEFAULT_PREFERENCES);
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
      maxWidthPx: 720,
      theme: 'dark',
      focusMode: true,
      typewriterMode: true,
      autoHideChrome: true,
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
    expect(p).toEqual(DEFAULT_PREFERENCES);
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

describe('resolveTheme', () => {
  it('follows the system only for system', () => {
    expect(resolveTheme('system', true)).toBe('dark');
    expect(resolveTheme('system', false)).toBe('light');
    expect(resolveTheme('light', true)).toBe('light');
    expect(resolveTheme('dark', false)).toBe('dark');
  });
});
