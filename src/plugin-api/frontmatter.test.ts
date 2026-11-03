import { describe, expect, it } from 'vitest';
import { frontmatterEndLine } from './frontmatter';

const end = (lines: string[]) => frontmatterEndLine(lines.length, (n) => lines[n - 1]!);

describe('frontmatterEndLine', () => {
  it('returns the closing --- line (1-based)', () => {
    expect(end(['---', 'title: x', '---', '本文'])).toBe(3);
    expect(end(['---', '---'])).toBe(2);
    // 閉じる --- の手前の空行・keys は frontmatter の中。最初の閉じる --- で終わる。
    expect(end(['---', 'a: 1', '', 'b: 2', '---', '', '---'])).toBe(5);
  });

  it('accepts trailing spaces on the delimiters', () => {
    expect(end(['---  ', 'a: 1', '---\t'])).toBe(3);
  });

  it('is null when the first line is not ---, when it is not closed, or the document is empty', () => {
    expect(end(['本文', '---', 'a: 1', '---'])).toBeNull();
    expect(end(['---', 'a: 1', '本文'])).toBeNull();
    expect(end([' ---', '---'])).toBeNull();
    expect(end(['----', '---'])).toBeNull();
    expect(frontmatterEndLine(0, () => '')).toBeNull();
  });

  it('reads only as far as the closing delimiter', () => {
    const read: number[] = [];
    frontmatterEndLine(1000, (n) => {
      read.push(n);
      return n === 1 || n === 4 ? '---' : 'x';
    });
    expect(read).toEqual([1, 2, 3, 4]);
  });
});
