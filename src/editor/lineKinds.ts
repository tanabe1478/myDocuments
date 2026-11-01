/**
 * 行の種類の判定（純関数）。CodeMirror に依存しない。
 * 空行の高さ（段落間隔）とぶら下げインデントの対象を決めるのに使う。
 */

/** 空白だけの行（全角空白を含む）か。空の行も含む。 */
export function isBlankLine(text: string): boolean {
  return /^\s*$/.test(text);
}

// 行頭の「ぶら下げる部分」: 空白、引用の記号（> を重ねてよい）、リストの記号（- * + / 1. / 1)）、
// タスクのチェックボックス（[ ] [x]）と、それぞれの後ろの空白。
const HANG_PREFIX = /^[ \t]*(?:>[ \t]*)*(?:(?:[-*+]|\d{1,9}[.)])[ \t]+(?:\[[ xX]\][ \t]+)?)?/;

/**
 * 折り返したとき、2 行目以降を揃える位置までの文字列（行頭からの記号と空白）。なければ空文字。
 * 例: "- 項目" → "- "、"  1. 項目" → "  1. "、"> 引用" → "> "、"> - 項目" → "> - "。
 * 見た目の幅は、この文字列を実際のフォントで測って決める（markdownDecorations.ts）。
 */
export function hangPrefix(text: string): string {
  return HANG_PREFIX.exec(text)?.[0] ?? '';
}

/** 測れないとき（フォントの測定ができない環境）に使う、1 文字あたりの幅（em）。 */
export const FALLBACK_CHAR_EM = 0.6;

/** タブの幅（文字数）。本文のタブ幅（theme.ts の tab-size）と合わせる。 */
export const TAB_SIZE = 4;

/** 測定に渡す文字列。タブは空白に直す（行の tab-size と同じ幅になる）。 */
export function measurableText(prefix: string): string {
  return prefix.replace(/\t/g, ' '.repeat(TAB_SIZE));
}

/** 測れないときの概算の幅（em）。 */
export function fallbackPrefixWidthEm(prefix: string): number {
  return Array.from(measurableText(prefix)).length * FALLBACK_CHAR_EM;
}
