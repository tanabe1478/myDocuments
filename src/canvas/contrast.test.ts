import { describe, expect, it } from 'vitest';
import { blend, contrastRatio, formatRatio, parseHex, relativeLuminance, toHex } from './contrast';

const c = (hex: string) => parseHex(hex)!;

describe('parseHex / toHex', () => {
  it('reads #rrggbb in either case and rejects other forms', () => {
    expect(parseHex('#ff8000')).toEqual({ r: 255, g: 128, b: 0 });
    expect(parseHex('#FF8000')).toEqual({ r: 255, g: 128, b: 0 });
    for (const bad of ['', 'ff8000', '#fff', '#ff80000', '#gg0000', 'red', '#ff8000 ']) {
      expect(parseHex(bad)).toBeNull();
    }
  });

  it('round-trips and clamps', () => {
    expect(toHex(c('#0a1b2c'))).toBe('#0a1b2c');
    expect(toHex({ r: 300, g: -4, b: 127.6 })).toBe('#ff0080');
  });
});

describe('relativeLuminance', () => {
  it('is 0 for black and 1 for white', () => {
    expect(relativeLuminance(c('#000000'))).toBe(0);
    expect(relativeLuminance(c('#ffffff'))).toBeCloseTo(1, 10);
  });

  it('matches known values', () => {
    // WCAG 2 の定義どおり: 赤 0.2126、緑 0.7152、青 0.0722
    expect(relativeLuminance(c('#ff0000'))).toBeCloseTo(0.2126, 4);
    expect(relativeLuminance(c('#00ff00'))).toBeCloseTo(0.7152, 4);
    expect(relativeLuminance(c('#0000ff'))).toBeCloseTo(0.0722, 4);
    // sRGB 128 の線形化: ((128/255 + 0.055) / 1.055) ** 2.4
    expect(relativeLuminance(c('#808080'))).toBeCloseTo(0.2159, 4);
  });
});

describe('contrastRatio', () => {
  it('is 21 for black on white, and 1 for the same color', () => {
    expect(contrastRatio(c('#000000'), c('#ffffff'))).toBeCloseTo(21, 10);
    expect(contrastRatio(c('#336699'), c('#336699'))).toBe(1);
  });

  it('does not depend on the argument order', () => {
    expect(contrastRatio(c('#112233'), c('#eeddcc'))).toBe(contrastRatio(c('#eeddcc'), c('#112233')));
  });

  it('matches published reference pairs', () => {
    // #777777 on white は 4.48（AA の 4.5 にわずかに届かない定番の例）
    expect(contrastRatio(c('#777777'), c('#ffffff'))).toBeCloseTo(4.48, 2);
    // #767676 on white は 4.54（AA を満たす最も明るい灰色）
    expect(contrastRatio(c('#767676'), c('#ffffff'))).toBeCloseTo(4.54, 2);
    // #595959 on white は 7.00（AAA の境目）
    expect(contrastRatio(c('#595959'), c('#ffffff'))).toBeCloseTo(7.0, 1);
  });
});

describe('blend', () => {
  it('returns top at alpha 1, bottom at alpha 0, and the midpoint at 0.5', () => {
    expect(blend(c('#ff0000'), c('#0000ff'), 1)).toEqual(c('#ff0000'));
    expect(blend(c('#ff0000'), c('#0000ff'), 0)).toEqual(c('#0000ff'));
    expect(blend(c('#ff0000'), c('#0000ff'), 0.5)).toEqual({ r: 128, g: 0, b: 128 });
  });

  it('clamps alpha outside 0..1', () => {
    expect(blend(c('#ff0000'), c('#0000ff'), 2)).toEqual(c('#ff0000'));
    expect(blend(c('#ff0000'), c('#0000ff'), -1)).toEqual(c('#0000ff'));
  });
});

describe('formatRatio', () => {
  it('truncates instead of rounding up, so 4.497 never reads as 4.50', () => {
    expect(formatRatio(4.497)).toBe('4.49');
    expect(formatRatio(21)).toBe('21.00');
    expect(formatRatio(7.004)).toBe('7.00');
  });
});
