/**
 * Tab / Shift+Tab による、リストと引用のインデントの増減（純関数）。CodeMirror に依存しない。
 *
 * 方針:
 * - 本文にタブ文字は入れない。
 * - 箇条書きは 2 スペース、番号付きは記号の幅（"1. " なら 3、"10. " なら 4）ずつ字下げする
 *   （番号付きの子の項目は、親の本文の位置より右でないと入れ子にならない）。
 * - 引用は、引用の段を 1 つ深くする（"> " を足す）。Shift+Tab で 1 段戻す。
 * - リストでも引用でもない行は、Tab では何もしない（複数行の選択のときだけ 2 スペース字下げする）。
 *   Shift+Tab は、行頭の空白を 2 つまで消す。
 * 戻り値は、行頭からのオフセットで表した 1 つの変更。変更がなければ null。
 */
export interface LineEdit {
  /** 行頭からの位置。 */
  readonly from: number;
  readonly to: number;
  readonly insert: string;
}

const QUOTE = /^[ \t]*(?:>[ \t]?)+/;
const LIST = /^([ \t]*)([-*+]|\d{1,9}[.)])([ \t]+)/;
const BULLET_UNIT = 2;
const PLAIN_UNIT = 2;

function split(text: string): { quote: string; rest: string } {
  const quote = QUOTE.exec(text)?.[0] ?? '';
  return { quote, rest: text.slice(quote.length) };
}

/** この行を字下げするときの幅（リストの行）。リストの行でなければ null。 */
export function listIndentUnit(text: string): number | null {
  const match = LIST.exec(split(text).rest);
  if (!match) return null;
  const marker = match[2]!;
  if (/^\d/.test(marker)) return Math.min(Math.max(marker.length + 1, BULLET_UNIT), 4);
  return BULLET_UNIT;
}

/** Tab: インデントを 1 段深くする。multi は、複数の行にまたがる選択のとき。 */
export function planIndentMore(text: string, multi: boolean): LineEdit | null {
  if (/^\s*$/.test(text)) return null;
  const { quote } = split(text);
  const unit = listIndentUnit(text);
  if (unit !== null) return { from: quote.length, to: quote.length, insert: ' '.repeat(unit) };
  if (quote !== '') return { from: quote.length, to: quote.length, insert: '> ' };
  return multi ? { from: 0, to: 0, insert: ' '.repeat(PLAIN_UNIT) } : null;
}

/** Shift+Tab: インデントを 1 段浅くする。 */
export function planIndentLess(text: string): LineEdit | null {
  const { quote, rest } = split(text);
  const unit = listIndentUnit(text);
  if (unit !== null) {
    const leading = /^[ \t]*/.exec(rest)![0].length;
    const n = Math.min(leading, unit);
    return n > 0 ? { from: quote.length, to: quote.length + n, insert: '' } : null;
  }
  if (quote !== '') {
    const depth = (quote.match(/>/g) ?? []).length;
    if (depth >= 2) {
      const at = quote.lastIndexOf('>');
      const next = quote[at + 1];
      return { from: at, to: at + 1 + (next === ' ' || next === '\t' ? 1 : 0), insert: '' };
    }
  }
  const leading = /^[ \t]*/.exec(text)![0].length;
  const n = Math.min(leading, PLAIN_UNIT);
  return n > 0 ? { from: 0, to: n, insert: '' } : null;
}
