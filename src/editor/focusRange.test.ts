import { describe, expect, it } from 'vitest';
import { focusRange, isBlankText } from './focusRange';

/** 行の配列から、行番号（1 始まり）で本文を答える関数を作って呼ぶ。 */
function range(lines: string[], cursorLine: number) {
  return focusRange(lines.length, (n) => lines[n - 1] ?? '', cursorLine);
}

describe('focusRange: paragraphs split by blank lines', () => {
  const doc = ['一段落目の1行目', '一段落目の2行目', '', '二段落目', '', '最後の段落'];

  it('covers the whole block around the cursor', () => {
    expect(range(doc, 1)).toEqual({ from: 1, to: 2 });
    expect(range(doc, 2)).toEqual({ from: 1, to: 2 });
    expect(range(doc, 4)).toEqual({ from: 4, to: 4 });
  });

  it('works on the first and last lines', () => {
    expect(range(doc, 6)).toEqual({ from: 6, to: 6 });
    expect(range(['a', 'b', 'c'], 2)).toEqual({ from: 1, to: 3 });
  });

  it('treats whitespace-only lines (including full-width spaces) as blank', () => {
    expect(range(['a', '   ', 'b'], 1)).toEqual({ from: 1, to: 1 });
    expect(range(['a', '　', 'b'], 3)).toEqual({ from: 3, to: 3 });
    expect(isBlankText('\t　 ')).toBe(true);
    expect(isBlankText('a')).toBe(false);
  });

  it('handles a single-line document and clamps an out-of-range cursor line', () => {
    expect(range(['only'], 1)).toEqual({ from: 1, to: 1 });
    expect(range(doc, 0)).toEqual({ from: 1, to: 2 });
    expect(range(doc, 99)).toEqual({ from: 6, to: 6 });
  });
});

describe('focusRange: the cursor on a blank line', () => {
  it('targets the paragraph just before it', () => {
    const doc = ['一段落目', '続き', '', '二段落目'];
    expect(range(doc, 3)).toEqual({ from: 1, to: 2 });
  });

  it('targets the paragraph before a run of blank lines, however long (whitespace-only included)', () => {
    expect(range(['a', '', '  ', '\t', 'b'], 3)).toEqual({ from: 1, to: 1 });
    expect(range(['a', '', '  ', '\t', 'b'], 4)).toEqual({ from: 1, to: 1 });
  });

  it('targets the paragraph just after when there is nothing before', () => {
    expect(range(['', '', '最初の段落', '続き'], 1)).toEqual({ from: 3, to: 4 });
    expect(range(['', 'x'], 1)).toEqual({ from: 2, to: 2 });
  });

  it('on a trailing blank line, targets the last paragraph', () => {
    expect(range(['a', 'b', ''], 3)).toEqual({ from: 1, to: 2 });
  });

  it('dims nothing (null) when the document is only blank lines', () => {
    expect(range([''], 1)).toBeNull();
    expect(range(['', '  ', ''], 2)).toBeNull();
  });
});

describe('focusRange: headings', () => {
  it('a heading is a block of one line, and the body right after it is a different block', () => {
    const doc = ['# 見出し', '本文の1行目', '本文の2行目', '', '次の段落'];
    expect(range(doc, 1)).toEqual({ from: 1, to: 1 });
    expect(range(doc, 2)).toEqual({ from: 2, to: 3 });
    expect(range(doc, 3)).toEqual({ from: 2, to: 3 });
  });

  it('a heading in the middle of a paragraph splits it', () => {
    const doc = ['前の段落', '## 見出し', '後の段落'];
    expect(range(doc, 1)).toEqual({ from: 1, to: 1 });
    expect(range(doc, 2)).toEqual({ from: 2, to: 2 });
    expect(range(doc, 3)).toEqual({ from: 3, to: 3 });
  });

  it('recognises # to ######, up to 3 spaces of indent, and an empty heading', () => {
    for (const h of ['#', '# a', '## a', '### a', '#### a', '##### a', '###### a', '   # a']) {
      expect(range(['p', h, 'q'], 2), h).toEqual({ from: 2, to: 2 });
    }
  });

  it('does not treat other lines starting with # as headings', () => {
    for (const t of ['####### seven', '#hashtag', '    # indented code']) {
      expect(range(['p', t, 'q'], 1), t).toEqual({ from: 1, to: 3 });
    }
  });
});

describe('focusRange: list items', () => {
  it('each item without blank lines between is its own block', () => {
    const doc = ['- 一つ目', '- 二つ目', '- 三つ目'];
    expect(range(doc, 1)).toEqual({ from: 1, to: 1 });
    expect(range(doc, 2)).toEqual({ from: 2, to: 2 });
    expect(range(doc, 3)).toEqual({ from: 3, to: 3 });
  });

  it('accepts -, *, + and numbered markers (1. and 1))', () => {
    const doc = ['- a', '* b', '+ c', '1. d', '2) e'];
    for (let n = 1; n <= 5; n++) expect(range(doc, n), `line ${n}`).toEqual({ from: n, to: n });
  });

  it('indented continuation lines belong to the item before them', () => {
    const doc = ['- 項目', '  続きの行', '  さらに続き', '- 次の項目'];
    expect(range(doc, 1)).toEqual({ from: 1, to: 3 });
    expect(range(doc, 3)).toEqual({ from: 1, to: 3 });
    expect(range(doc, 4)).toEqual({ from: 4, to: 4 });
  });

  it('a nested item starts its own block', () => {
    const doc = ['- 親', '  - 子', '  - 子その2', '- 親2'];
    expect(range(doc, 1)).toEqual({ from: 1, to: 1 });
    expect(range(doc, 2)).toEqual({ from: 2, to: 2 });
    expect(range(doc, 3)).toEqual({ from: 3, to: 3 });
  });

  it('a list right after a paragraph (no blank line) is separate from it', () => {
    const doc = ['前置きの段落', '- 項目'];
    expect(range(doc, 1)).toEqual({ from: 1, to: 1 });
    expect(range(doc, 2)).toEqual({ from: 2, to: 2 });
  });

  it('does not treat a marker without a following space as a list item', () => {
    for (const t of ['-dash', '*emph*', '1.5 倍', '2024年']) {
      expect(range(['p', t], 1), t).toEqual({ from: 1, to: 2 });
    }
  });
});

describe('focusRange: code fences', () => {
  it('the whole fence is one block, including blank lines, headings and list markers inside', () => {
    const doc = ['前', '```ts', '# コメント', '', '- 項目風', '```', '後'];
    expect(range(doc, 2)).toEqual({ from: 2, to: 6 });
    expect(range(doc, 3)).toEqual({ from: 2, to: 6 });
    expect(range(doc, 4)).toEqual({ from: 2, to: 6 });
    expect(range(doc, 5)).toEqual({ from: 2, to: 6 });
    expect(range(doc, 6)).toEqual({ from: 2, to: 6 });
    expect(range(doc, 1)).toEqual({ from: 1, to: 1 });
    expect(range(doc, 7)).toEqual({ from: 7, to: 7 });
  });

  it('a blank line inside a fence is not a blank-line cursor (the fence is the target)', () => {
    expect(range(['```', 'a', '', 'b', '```'], 3)).toEqual({ from: 1, to: 5 });
  });

  it('supports ~~~ and longer fences, and a shorter inner fence does not close it', () => {
    expect(range(['~~~', 'x', '', 'y', '~~~', 'z'], 3)).toEqual({ from: 1, to: 5 });
    expect(range(['````', '```', 'x', '```', '````'], 3)).toEqual({ from: 1, to: 5 });
    expect(range(['```', 'x', '~~~', 'y', '```'], 4)).toEqual({ from: 1, to: 5 });
  });

  it('an unclosed fence runs to the end of the document', () => {
    expect(range(['p', '', '```', 'a', '', 'b'], 6)).toEqual({ from: 3, to: 6 });
  });

  it('a fence interrupts a paragraph', () => {
    expect(range(['text', '```', 'code', '```'], 1)).toEqual({ from: 1, to: 1 });
  });
});

describe('focusRange: frontmatter', () => {
  it('the leading --- to --- is one block', () => {
    const doc = ['---', 'title: x', '', 'tags: [a]', '---', '', '本文'];
    expect(range(doc, 1)).toEqual({ from: 1, to: 5 });
    expect(range(doc, 3)).toEqual({ from: 1, to: 5 });
    expect(range(doc, 5)).toEqual({ from: 1, to: 5 });
    expect(range(doc, 7)).toEqual({ from: 7, to: 7 });
  });

  it('text right after the closing --- is a different block', () => {
    expect(range(['---', 'a: 1', '---', '本文'], 4)).toEqual({ from: 4, to: 4 });
  });

  it('--- that is not on the first line is not frontmatter', () => {
    expect(range(['本文', '---', 'a: 1', '---'], 3)).toEqual({ from: 1, to: 4 });
  });

  it('an unclosed leading --- is not frontmatter', () => {
    expect(range(['---', 'a', '', 'b'], 4)).toEqual({ from: 4, to: 4 });
  });
});
