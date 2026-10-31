import { describe, expect, it } from 'vitest';
import { focusRange, isBlankText } from './focusRange';

/** 行の配列から、行番号（1 始まり）で空行かを答える関数を作る。 */
function range(lines: string[], cursorLine: number) {
  return focusRange(lines.length, (n) => isBlankText(lines[n - 1] ?? ''), cursorLine);
}

describe('focusRange', () => {
  const doc = ['# 見出し', '', '一段落目の1行目', '一段落目の2行目', '', '- 項目', '', '最後の段落'];

  it('covers the whole block around the cursor, split by blank lines', () => {
    expect(range(doc, 3)).toEqual({ from: 3, to: 4 });
    expect(range(doc, 4)).toEqual({ from: 3, to: 4 });
  });

  it('treats a heading and a list item as a block of their own when blank lines surround them', () => {
    expect(range(doc, 1)).toEqual({ from: 1, to: 1 });
    expect(range(doc, 6)).toEqual({ from: 6, to: 6 });
  });

  it('works on the first and last lines', () => {
    expect(range(doc, 8)).toEqual({ from: 8, to: 8 });
    expect(range(['a', 'b', 'c'], 2)).toEqual({ from: 1, to: 3 });
  });

  it('on a blank line, only the run of blank lines is the range', () => {
    expect(range(doc, 2)).toEqual({ from: 2, to: 2 });
    expect(range(['a', '', '  ', '\t', 'b'], 3)).toEqual({ from: 2, to: 4 });
  });

  it('treats whitespace-only lines as blank', () => {
    expect(range(['a', '   ', 'b'], 1)).toEqual({ from: 1, to: 1 });
    expect(range(['a', '　', 'b'], 3)).toEqual({ from: 3, to: 3 });
  });

  it('handles a single-line and an empty document', () => {
    expect(range(['only'], 1)).toEqual({ from: 1, to: 1 });
    expect(range([''], 1)).toEqual({ from: 1, to: 1 });
  });

  it('clamps an out-of-range cursor line', () => {
    expect(range(doc, 0)).toEqual({ from: 1, to: 1 });
    expect(range(doc, 99)).toEqual({ from: 8, to: 8 });
  });
});
