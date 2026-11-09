import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { ensureSyntaxTree } from '@codemirror/language';
import { EditorState } from '@codemirror/state';
import { describe, expect, it } from 'vitest';
import { buildTableModel, tableAtPos, tabTarget, topLevelTables, type TableModel } from './tableModel';

function parse(doc: string) {
  const state = EditorState.create({ doc, extensions: [markdown({ base: markdownLanguage })] });
  const tree = ensureSyntaxTree(state, state.doc.length, 10_000)!;
  return { state, tree, doc: state.doc };
}

function modelOf(text: string): TableModel {
  const { tree, doc } = parse(text);
  const [table] = topLevelTables(tree, doc);
  return buildTableModel(table!, doc)!;
}

/** 位置を、"<" と ">" の間（カーソルの位置）で指定する。 */
function cursorIn(text: string): { text: string; pos: number } {
  const pos = text.indexOf('^');
  return { text: text.replace('^', ''), pos };
}

describe('topLevelTables', () => {
  it('finds the top-level tables only: not those inside a blockquote or a list item, nor inside the frontmatter', () => {
    const text = ['| a |', '|---|', '| 1 |', '', '> | q |', '> |---|', '', '- | l |', '  |---|', '', '| b |', '|---|'].join('\n');
    const { tree, doc } = parse(text);
    expect(topLevelTables(tree, doc).map((t) => [t.firstLine, t.lastLine])).toEqual([
      [1, 3],
      [11, 12],
    ]);
    const fm = parse('---\na | b\n--|--\n---\n\n| c |\n|---|');
    expect(topLevelTables(fm.tree, fm.doc).map((t) => t.firstLine)).toEqual([6]);
  });

  it('takes a table that directly follows a paragraph, and spans whole lines (from the start of the first row to the end of the last)', () => {
    const { tree, doc } = parse('para\n   | a | b |\n  |---|---|\n  | 1 | 2 |  \n\nafter');
    const [table] = topLevelTables(tree, doc);
    expect(table).toMatchObject({ firstLine: 2, lastLine: 4 });
    expect(doc.sliceString(table!.from, table!.to)).toBe('   | a | b |\n  |---|---|\n  | 1 | 2 |  ');
  });

  it('skips a table that touches the end of the parsed range while the tree is incomplete', () => {
    const { tree, doc } = parse('| a |\n|---|\n| 1 |');
    expect(topLevelTables(tree, doc)).toHaveLength(1);
    // 解析が文書の途中までしか届いていない木（長さが短い）では、端に触れる表は候補にしない。
    const short = { ...tree, length: doc.length - 1, iterate: tree.iterate.bind(tree), topNode: tree.topNode } as unknown as typeof tree;
    expect(topLevelTables(short, doc)).toEqual([]);
  });

  it('finds the table of a position by its lines (including the indentation and the line end)', () => {
    const { tree, doc } = parse('x\n\n  | a |\n  |---|\n  | 1 |\n\nz');
    const row = doc.line(5);
    expect(tableAtPos(tree, doc, row.from)?.firstLine).toBe(3);
    expect(tableAtPos(tree, doc, row.to)?.firstLine).toBe(3);
    expect(tableAtPos(tree, doc, doc.line(1).from)).toBeNull();
    expect(tableAtPos(tree, doc, doc.line(6).from)).toBeNull();
    expect(tableAtPos(tree, doc, doc.length)).toBeNull();
  });
});

describe('buildTableModel', () => {
  it('splits cells by the pipes, counting empty cells; the header decides the columns', () => {
    const model = modelOf('| a | b | c |\n|:--|:-:|--:|\n| 1 |  | 3 |\n| x |\n| p | q | r | extra |');
    expect(model.header.cells.map((c) => [c.contentFrom, c.contentTo])).toEqual([
      [2, 3],
      [6, 7],
      [10, 11],
    ]);
    expect(model.aligns).toEqual(['left', 'center', 'right']);
    expect(model.body.map((r) => r.cells.length)).toEqual([3, 1, 4]);
    // 空のセル（2 行目の 2 つ目）は、中身が空で、Tab の位置は左の | の後ろの空白の 1 つ後ろ。
    const empty = model.body[0]!.cells[1]!;
    expect(empty.contentFrom).toBe(empty.contentTo);
    expect(empty.node).toBeNull();
  });

  it('reads alignments without outer pipes, and gives null for columns without a colon', () => {
    expect(modelOf('a | b\n--|:--\n1 | 2').aligns).toEqual([null, 'left']);
    expect(modelOf('| a | b |\n| --- | ---: |\n| 1 | 2 |').aligns).toEqual([null, 'right']);
  });

  it('does not split at an escaped pipe, but does split at a pipe inside inline code (GFM)', () => {
    const model = modelOf('| a \\| b | c |\n|---|---|\n| `x|y` | z |');
    expect(model.header.cells).toHaveLength(2);
    expect(model.body[0]!.cells).toHaveLength(3);
  });

  it('counts the cells of a row without outer pipes, from the start of the line to the end of the line', () => {
    const model = modelOf('a | b\n--|--\n1 | 2');
    expect(model.header.cells.map((c) => [c.contentFrom, c.contentTo])).toEqual([
      [0, 1],
      [4, 5],
    ]);
    expect(model.body[0]!.cells.map((c) => c.start)).toEqual([12, 16]);
  });
});

describe('tabTarget (the head of the content of the next / previous cell)', () => {
  const TABLE = ['| a | b |', '|---|---|', '| 1 |  |', '| x | y |'].join('\n');
  // 各セルの中身の頭。1 行目 2、6。3 行目の 1 つ目 / 空のセル。4 行目の 2 つ。
  const model = modelOf(TABLE);
  const starts = [model.header, ...model.body].flatMap((r) => r.cells.map((c) => c.start));

  it('lists the starts: the delimiter row is not a cell, an empty cell goes one past the space after its left pipe', () => {
    const line = (n: number) => TABLE.split('\n').slice(0, n - 1).join('\n').length + (n > 1 ? 1 : 0);
    expect(starts).toEqual([2, 6, line(3) + 2, line(3) + 6, line(4) + 2, line(4) + 6]);
    // 3 行目 "| 1 |  |" の 2 つ目は "|" の直後が空白（2 つ）。その 1 つ後ろ。
    expect(TABLE.slice(starts[3]! - 2, starts[3]!)).toBe('| ');
  });

  it('moves to the next / previous cell, crossing rows and skipping the delimiter row', () => {
    expect(tabTarget(model, starts[0]!, false)).toBe(starts[1]);
    expect(tabTarget(model, starts[1]!, false)).toBe(starts[2]); // 行をまたぎ、区切りの行を飛ばす
    expect(tabTarget(model, starts[2]!, true)).toBe(starts[1]);
    expect(tabTarget(model, starts[3]!, false)).toBe(starts[4]);
  });

  it('uses the cell the caret is in: from the middle of a cell, the next / previous cell (not the head of the same cell)', () => {
    const { text, pos } = cursorIn('| abc^def | b |\n|---|---|\n| 1 | 2 |');
    const m = modelOf(text);
    expect(tabTarget(m, pos, false)).toBe(m.header.cells[1]!.start);
    const mid = cursorIn('| a | bc^d |\n|---|---|\n| 1 | 2 |');
    const m2 = modelOf(mid.text);
    expect(tabTarget(m2, mid.pos, true)).toBe(m2.header.cells[0]!.start);
  });

  it('stays at the first cell (Shift+Tab) and at the last cell (Tab)', () => {
    expect(tabTarget(model, starts[0]!, true)).toBeNull();
    expect(tabTarget(model, starts.at(-1)!, false)).toBeNull();
  });

  it('from outside any cell: before the left pipe, after the right pipe, on the delimiter row', () => {
    const lineStart = TABLE.indexOf('| x');
    expect(tabTarget(model, lineStart, false)).toBe(starts[4]); // 行頭（| の前）から: その行の最初のセル
    expect(tabTarget(model, lineStart, true)).toBe(starts[3]); // 前の行の最後のセル
    const afterRight = lineStart + '| x | y |'.length;
    expect(tabTarget(model, afterRight, false)).toBeNull(); // 最後の行の末尾から Tab: 動かない
    expect(tabTarget(model, afterRight, true)).toBe(starts[5]); // 末尾から Shift+Tab: その行の最後のセル
    const delimiterRow = TABLE.indexOf('|---|');
    expect(tabTarget(model, delimiterRow + 2, false)).toBe(starts[2]);
    expect(tabTarget(model, delimiterRow + 2, true)).toBe(starts[1]);
  });

  it('counts the cells of each row as written (a short row has fewer cells; a row without outer pipes starts at the line start)', () => {
    const m = modelOf('a | b\n--|--\n1\n2 | 3');
    const all = [m.header, ...m.body].flatMap((r) => r.cells.map((c) => c.start));
    expect(all).toEqual([0, 4, 12, 14, 18]);
    expect(tabTarget(m, 4, false)).toBe(12);
    expect(tabTarget(m, 12, false)).toBe(14);
  });

  it('for an empty cell without a space after the pipe, the start is right after the pipe', () => {
    const m = modelOf('| a | b |\n|---|---|\n|a||');
    // "|a||" の 2 つ目のセルは空で、| の直後に空白がない。
    const row = m.body[0]!;
    expect(row.cells).toHaveLength(2);
    expect(row.cells[1]!.start).toBe(row.cells[1]!.left);
  });
});
