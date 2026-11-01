import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { WCAG_AA, blend, contrastRatio, parseHex, type Rgb } from './contrast';

// styles.css の配色から、コードの背景帯と引用の縦線が、ライト・ダークそれぞれで読めることを確かめる。
const css = readFileSync(new URL('../styles.css', import.meta.url), 'utf8');

function block(selector: string): string {
  const start = css.indexOf(selector);
  if (start < 0) throw new Error(`no block: ${selector}`);
  return css.slice(start, css.indexOf('}', start));
}

function variable(source: string, name: string): string {
  const m = new RegExp(`${name}:\\s*([^;]+);`).exec(source);
  if (!m) throw new Error(`no variable: ${name}`);
  return m[1]!.trim();
}

function color(value: string): Rgb {
  const hex = parseHex(value);
  if (hex) return hex;
  const m = /^rgba\((\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)$/.exec(value);
  if (!m) throw new Error(`unsupported color: ${value}`);
  return { r: Number(m[1]), g: Number(m[2]), b: Number(m[3]) };
}

function alpha(value: string): number {
  const m = /^rgba\([^)]*,\s*([\d.]+)\)$/.exec(value);
  return m ? Number(m[1]) : 1;
}

for (const [name, selector] of [
  ['light', ':root,\n:root[data-theme=\'light\']'],
  ['dark', ':root[data-theme=\'dark\']'],
] as const) {
  describe(`markdown colors (${name})`, () => {
    const b = block(selector);
    const surface = color(variable(b, '--md-color-surface'));
    const bandValue = variable(b, '--md-color-code-bg');
    const band = blend(color(bandValue), surface, alpha(bandValue));

    it('keeps the code text readable on the code band (AA)', () => {
      expect(contrastRatio(color(variable(b, '--md-color-code')), band)).toBeGreaterThanOrEqual(WCAG_AA);
      expect(contrastRatio(color(variable(b, '--md-color-text')), band)).toBeGreaterThanOrEqual(WCAG_AA);
      expect(contrastRatio(color(variable(b, '--md-color-mark')), band)).toBeGreaterThanOrEqual(1.5);
    });

    it('keeps the quote text readable on the surface (AA)', () => {
      expect(contrastRatio(color(variable(b, '--md-color-quote')), surface)).toBeGreaterThanOrEqual(WCAG_AA);
    });

    it('draws the quote bar visibly against the surface (3:1 for graphics)', () => {
      expect(contrastRatio(color(variable(b, '--md-color-quote-bar')), surface)).toBeGreaterThanOrEqual(3);
    });

    it('makes the code band visible but faint', () => {
      const ratio = contrastRatio(band, surface);
      expect(ratio).toBeGreaterThan(1.03);
      expect(ratio).toBeLessThan(1.4);
    });
  });
}
