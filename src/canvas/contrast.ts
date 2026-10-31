/** WCAG 2 の相対輝度とコントラスト比。純関数。 */
export interface Rgb {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

/** AA（通常の文字）。これを下回ったら警告する。 */
export const WCAG_AA = 4.5;
/** AAA。既定配色が満たす水準。 */
export const WCAG_AAA = 7;

const HEX = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i;

/** `#rrggbb` を読む。それ以外は null。 */
export function parseHex(hex: string): Rgb | null {
  const m = HEX.exec(hex);
  if (!m) return null;
  return { r: parseInt(m[1]!, 16), g: parseInt(m[2]!, 16), b: parseInt(m[3]!, 16) };
}

export function toHex(c: Rgb): string {
  const h = (v: number) => clampChannel(v).toString(16).padStart(2, '0');
  return `#${h(c.r)}${h(c.g)}${h(c.b)}`;
}

function clampChannel(v: number): number {
  return Math.min(255, Math.max(0, Math.round(v)));
}

function linear(channel: number): number {
  const s = channel / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

export function relativeLuminance(c: Rgb): number {
  return 0.2126 * linear(c.r) + 0.7152 * linear(c.g) + 0.0722 * linear(c.b);
}

/** 1 以上 21 以下。引数の順序は問わない。 */
export function contrastRatio(a: Rgb, b: Rgb): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/** `top` を不透明度 `alpha`（0〜1）で `bottom` に重ねた色。 */
export function blend(top: Rgb, bottom: Rgb, alpha: number): Rgb {
  const a = Math.min(1, Math.max(0, alpha));
  return {
    r: clampChannel(top.r * a + bottom.r * (1 - a)),
    g: clampChannel(top.g * a + bottom.g * (1 - a)),
    b: clampChannel(top.b * a + bottom.b * (1 - a)),
  };
}

/** 表示用の比。切り捨てて小数 2 桁（4.497 を 4.50 と表示して警告を隠さないため）。 */
export function formatRatio(ratio: number): string {
  return (Math.floor(ratio * 100) / 100).toFixed(2);
}
