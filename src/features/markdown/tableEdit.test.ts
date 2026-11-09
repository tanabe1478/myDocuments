// @vitest-environment jsdom
import { history, undo, redo } from '@codemirror/commands';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { ensureSyntaxTree } from '@codemirror/language';
import { EditorState, type Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPluginRegistry, type EditorExtensionEnvironment } from '../../plugin-api';
import { emptyRowText, headerCellCount, isDelimiterRowText, separatorRowText } from './tableEdit';
import { tableEnter, tableTab } from './tableKeys';
import { markdownPlugin } from '.';

beforeAll(() => {
  const rect = { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON: () => ({}) };
  const rects = Object.assign([], { item: () => null });
  Range.prototype.getClientRects = () => rects as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect = () => rect as DOMRect;
  Element.prototype.getClientRects = () => rects as unknown as DOMRectList;
});

let host: HTMLElement;
let view: EditorView | null = null;

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
});

afterEach(() => {
  view?.destroy();
  view = null;
  host.remove();
});

const env = (textKind: 'markdown' | 'plain'): EditorExtensionEnvironment => ({ textKind, openExternalUrl: () => {}, isMacPlatform: () => false });

/** カーソルを `^` で示した文書から、表のキー操作を載せた view を作る（`^` は取り除く）。 */
function mount(source: string, display: 'cursorLine' | 'always' = 'cursorLine', extra: Extension = [], textKind: 'markdown' | 'plain' = 'markdown'): EditorView {
  const anchor = source.indexOf('^');
  const doc = source.replace('^', '');
  const [ext] = createPluginRegistry([markdownPlugin]).editorExtensions;
  view = new EditorView({
    parent: host,
    state: EditorState.create({
      doc,
      selection: { anchor },
      extensions: [markdown({ base: markdownLanguage }), history(), ext!.create(display, env(textKind)), extra],
    }),
  });
  ensureSyntaxTree(view.state, view.state.doc.length, 10_000);
  view.dispatch({});
  return view;
}

function key(v: EditorView, name: string, init: KeyboardEventInit = {}): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key: name, code: name, keyCode: name === 'Enter' ? 13 : name === 'Tab' ? 9 : 0, bubbles: true, cancelable: true, ...init });
  v.contentDOM.dispatchEvent(event);
  ensureSyntaxTree(v.state, v.state.doc.length, 10_000);
  return event;
}

const docOf = (v: EditorView) => v.state.doc.toString();
/** 文書とカーソルを、カーソルを `^` にした 1 つの文字列で見る。 */
const shown = (v: EditorView) => {
  const d = docOf(v);
  const h = v.state.selection.main.head;
  return `${d.slice(0, h)}^${d.slice(h)}`;
};

describe('row text helpers', () => {
  it('builds the empty row and the separator row from the number of columns', () => {
    expect(emptyRowText(2)).toBe('|  |  |');
    expect(emptyRowText(1)).toBe('|  |');
    expect(emptyRowText(3)).toBe('|  |  |  |');
    expect(separatorRowText(2)).toBe('| --- | --- |');
    expect(separatorRowText(1)).toBe('| --- |');
  });

  it('counts the cells of a header line like GFM: outer pipes are required, `\\|` does not separate', () => {
    expect(headerCellCount('| A | B |')).toBe(2);
    expect(headerCellCount('  | A | B |  ')).toBe(2);
    expect(headerCellCount('|a|')).toBe(1);
    expect(headerCellCount('||')).toBe(1);
    expect(headerCellCount('| | | |')).toBe(3);
    expect(headerCellCount('| a \\| b | c |')).toBe(2);
    expect(headerCellCount('| a \\\\| b |')).toBe(2); // `\\` はバックスラッシュ 1 つ。続く `|` は区切り（セルは `a \\` と `b`）
    expect(headerCellCount('| `a|b` | c |')).toBe(3); // インラインコードの中の `|` も区切り（GFM と R11 の規則）
    expect(headerCellCount('| a | b')).toBeNull();
    expect(headerCellCount('a | b |')).toBeNull();
    expect(headerCellCount('|')).toBeNull();
    expect(headerCellCount('| a \\|')).toBeNull(); // 最後の `|` がエスケープされている
    expect(headerCellCount('')).toBeNull();
  });

  it('recognises a delimiter row', () => {
    for (const t of ['|---|---|', '| --- | :-: |', '--|--', ':--|--:', '| - |', ' |:--| ']) expect(isDelimiterRowText(t), t).toBe(true);
    for (const t of ['---', '| a | b |', '- | a', '| --- | x |', '']) expect(isDelimiterRowText(t), t).toBe(false);
  });
});

describe('Enter in a table row adds an empty row', () => {
  const T3 = ['| a | b |', '|---|---|', '| 1 | 2 |', '| x | y |'].join('\n');

  it('on a body row: adds an empty row below, with the caret in its first cell, whatever the display setting', () => {
    for (const display of ['cursorLine', 'always'] as const) {
      const v = mount(`before\n\n${T3.replace('| 1 | 2 |', '| 1 | 2 |^')}\n\nafter`, display);
      expect(key(v, 'Enter').defaultPrevented).toBe(true);
      expect(shown(v)).toBe(`before\n\n| a | b |\n|---|---|\n| 1 | 2 |\n| ^ |  |\n| x | y |\n\nafter`);
      v.destroy();
      view = null;
      host.replaceChildren();
    }
  });

  it('the new row is `|  |  |` with the caret after the first space (R11 start of an empty cell)', () => {
    const v = mount('| a | b |\n|---|---|\n| 1 | 2 |^\n\nafter');
    key(v, 'Enter');
    expect(docOf(v)).toBe('| a | b |\n|---|---|\n| 1 | 2 |\n|  |  |\n\nafter');
    const rowStart = docOf(v).indexOf('|  |  |');
    expect(v.state.selection.main.head).toBe(rowStart + 2);
    expect(v.state.selection.main.empty).toBe(true);
  });

  it('does not split the text of a cell when the caret is in the middle of it', () => {
    const v = mount('| a | b |\n|---|---|\n| 1^23 | 2 |\n| x | y |');
    key(v, 'Enter');
    expect(docOf(v)).toBe('| a | b |\n|---|---|\n| 123 | 2 |\n|  |  |\n| x | y |');
    expect(v.state.selection.main.head).toBe(docOf(v).indexOf('|  |  |') + 2);
  });

  it('the number of cells is the number of the header cells (not the row the caret is on)', () => {
    const v = mount('| a | b | c |\n|---|---|---|\n| 1^ |\n');
    key(v, 'Enter');
    expect(docOf(v)).toBe('| a | b | c |\n|---|---|---|\n| 1 |\n|  |  |  |\n');
  });

  it('on the header row and on the delimiter row: adds below the delimiter row (the first body row)', () => {
    for (const start of ['| a^ | b |\n|---|---|\n| 1 | 2 |', '| a | b |^\n|---|---|\n| 1 | 2 |', '| a | b |\n|-^--|---|\n| 1 | 2 |', '| a | b |\n|---|---|^\n| 1 | 2 |']) {
      const v = mount(start);
      key(v, 'Enter');
      expect(docOf(v), start).toBe('| a | b |\n|---|---|\n|  |  |\n| 1 | 2 |');
      expect(v.state.selection.main.head).toBe(docOf(v).indexOf('|  |  |') + 2);
      v.destroy();
      view = null;
      host.replaceChildren();
    }
  });

  it('on a table with only the header row and the delimiter row: adds the first body row', () => {
    const v = mount('| a | b |^\n|---|---|\n\nafter');
    key(v, 'Enter');
    expect(shown(v)).toBe('| a | b |\n|---|---|\n| ^ |  |\n\nafter');
  });

  it('works for a table without outer pipes', () => {
    const v = mount('a | b\n--|--\n1 | 2^');
    key(v, 'Enter');
    expect(docOf(v)).toBe('a | b\n--|--\n1 | 2\n|  |  |');
  });

  it('on an empty last body row: clears the row, leaves it as an empty line, and puts the caret there (leaves the table)', () => {
    const v = mount('| a | b |\n|---|---|\n| 1 | 2 |\n|  |  |^\n\nafter');
    key(v, 'Enter');
    expect(shown(v)).toBe('| a | b |\n|---|---|\n| 1 | 2 |\n^\n\nafter');
    // 空の行のカーソルから、もう一度 Enter: 表の外なので、表の支援は働かない（この view には標準の改行がないので、何も起きない）。
    expect(key(v, 'Enter').defaultPrevented).toBe(false);
    expect(docOf(v)).toBe('| a | b |\n|---|---|\n| 1 | 2 |\n\n\nafter');
  });

  it('an empty last row is cleared even with the caret in the middle of it, and also when it has odd spacing', () => {
    for (const row of ['| ^ |  |', '|^|', '| |^ |', '|    |   ^|']) {
      const v = mount(`| a | b |\n|---|---|\n| 1 | 2 |\n${row}\n\nafter`);
      key(v, 'Enter');
      expect(shown(v), row).toBe('| a | b |\n|---|---|\n| 1 | 2 |\n^\n\nafter');
      v.destroy();
      view = null;
      host.replaceChildren();
    }
  });

  it('on an empty row that is not the last row: adds a row as usual', () => {
    const v = mount('| a | b |\n|---|---|\n|  |^  |\n| x | y |');
    key(v, 'Enter');
    expect(docOf(v)).toBe('| a | b |\n|---|---|\n|  |  |\n|  |  |\n| x | y |');
    expect(v.state.selection.main.head).toBe(docOf(v).lastIndexOf('|  |  |\n| x') + 2);
  });

  it('on an empty row at the end of a table that has only an empty body row: clears it', () => {
    const v = mount('| a |\n|---|\n|  |^\n');
    key(v, 'Enter');
    expect(shown(v)).toBe('| a |\n|---|\n^\n');
  });

  it('a last row with some content is not cleared: a row is added', () => {
    const v = mount('| a | b |\n|---|---|\n|  | 2 |^');
    key(v, 'Enter');
    expect(docOf(v)).toBe('| a | b |\n|---|---|\n|  | 2 |\n|  |  |');
  });

  it('is one transaction (user event input): one Undo restores the document and the selection; Redo repeats', () => {
    const source = '| a | b |\n|---|---|\n| 1 | 2^ |\n| x | y |';
    const v = mount(source);
    const before = shown(v);
    key(v, 'Enter');
    const after = shown(v);
    expect(after).not.toBe(before);
    undo(v);
    expect(shown(v)).toBe(before);
    redo(v);
    expect(docOf(v)).toBe(after.replace('^', ''));
    undo(v);
    expect(shown(v)).toBe(before);
  });

  it('also for the empty-last-row exit and for header creation: one Undo restores the document and the selection', () => {
    const exit = mount('| a |\n|---|\n| 1 |\n|  |^\n\nz');
    const beforeExit = shown(exit);
    key(exit, 'Enter');
    expect(shown(exit)).not.toBe(beforeExit);
    undo(exit);
    expect(shown(exit)).toBe(beforeExit);
    exit.destroy();
    view = null;
    host.replaceChildren();
    const create = mount('| A | B |^\n\nz');
    const beforeCreate = shown(create);
    key(create, 'Enter');
    undo(create);
    expect(shown(create)).toBe(beforeCreate);
  });

  it('does not run in a plain text (.txt): the table keys are absent, Enter is not taken', () => {
    const v = mount('| a | b |\n|---|---|\n| 1 | 2 |^', 'cursorLine', [], 'plain');
    const event = key(v, 'Enter');
    expect(event.defaultPrevented).toBe(false);
    expect(docOf(v)).toBe('| a | b |\n|---|---|\n| 1 | 2 |');
  });

  it('does nothing for a range selection, multiple carets, and a table inside a blockquote or a list', () => {
    const range = mount('| a | b |\n|---|---|\n| 1 | 2 |\n| x | y |');
    range.dispatch({ selection: { anchor: 21, head: 24 } });
    expect(key(range, 'Enter').defaultPrevented).toBe(false);
    expect(docOf(range)).toBe('| a | b |\n|---|---|\n| 1 | 2 |\n| x | y |');
    range.destroy();
    view = null;
    host.replaceChildren();
    for (const nested of ['> | a | b |\n> |---|---|\n> | 1 | 2 |^', '- | a | b |\n  |---|---|\n  | 1 | 2 |^']) {
      const v = mount(nested);
      const before = docOf(v);
      key(v, 'Enter');
      // 表の支援はしない（足されるのは、引用やリストの標準の継続だけ。`|  |  |` の行は足されない）。
      expect(docOf(v), nested).not.toContain('|  |  |');
      expect(docOf(v).startsWith(before)).toBe(true);
      v.destroy();
      view = null;
      host.replaceChildren();
    }
  });
});

describe('Enter at the end of a header line makes a table', () => {
  it('adds the separator row and an empty row below, and puts the caret in the first cell of the empty row; the header text is unchanged', () => {
    const v = mount('before\n\n| A | B |^\n\nafter');
    const e = key(v, 'Enter');
    expect(e.defaultPrevented).toBe(true);
    expect(shown(v)).toBe('before\n\n| A | B |\n| --- | --- |\n| ^ |  |\n\nafter');
    expect(docOf(v).split('\n')[2]).toBe('| A | B |');
    // 表として解析される。
    ensureSyntaxTree(v.state, v.state.doc.length, 10_000);
    let table = false;
    ensureSyntaxTree(v.state, v.state.doc.length, 10_000)!.iterate({ enter: (n) => void (table ||= n.name === 'Table') });
    expect(table).toBe(true);
  });

  it('counts the cells like GFM: three columns, one column, and `\\|` is not a separator', () => {
    const cases: Array<[string, string]> = [
      ['| a | b | c |^', '| a | b | c |\n| --- | --- | --- |\n|  |  |  |'],
      ['|a|^', '|a|\n| --- |\n|  |'],
      ['| a \\| b | c |^', '| a \\| b | c |\n| --- | --- |\n|  |  |'],
    ];
    for (const [src, out] of cases) {
      const v = mount(src);
      key(v, 'Enter');
      expect(docOf(v), src).toBe(out);
      expect(v.state.selection.main.head, src).toBe(docOf(v).lastIndexOf('\n') + 1 + 2);
      v.destroy();
      view = null;
      host.replaceChildren();
    }
  });

  it('works with trailing spaces after the closing pipe when the caret is at the end of the line, and keeps the header line as written', () => {
    const v = mount('| A | B |  ^\n\nz');
    key(v, 'Enter');
    expect(docOf(v)).toBe('| A | B |  \n| --- | --- |\n|  |  |\n\nz');
  });

  it('works on the last line of a multi-line paragraph, on the last line of the document, and with an indent of up to 3 spaces', () => {
    const v = mount('text\n| A | B |^');
    key(v, 'Enter');
    expect(docOf(v)).toBe('text\n| A | B |\n| --- | --- |\n|  |  |');
    v.destroy();
    view = null;
    host.replaceChildren();
    const w = mount('  | A | B |^\n');
    key(w, 'Enter');
    expect(docOf(w)).toBe('  | A | B |\n| --- | --- |\n|  |  |\n');
  });

  it('is a plain newline when the caret is in the middle of the line (also before trailing spaces)', () => {
    const mid = mount('| A |^ B |\n\nz');
    expect(key(mid, 'Enter').defaultPrevented).toBe(false);
    expect(docOf(mid)).toBe('| A | B |\n\nz');
    mid.destroy();
    view = null;
    host.replaceChildren();
    const beforeSpaces = mount('| A | B |^  ');
    expect(key(beforeSpaces, 'Enter').defaultPrevented).toBe(false);
    expect(docOf(beforeSpaces)).toBe('| A | B |  ');
  });

  it('is a plain newline when the line is not a header line: no outer pipes, one pipe, blank', () => {
    for (const src of ['| A | B^', 'A | B |^', '|^', 'plain text^', '^']) {
      const v = mount(src);
      expect(key(v, 'Enter').defaultPrevented, src).toBe(false);
      expect(docOf(v), src).toBe(src.replace('^', ''));
      v.destroy();
      view = null;
      host.replaceChildren();
    }
  });

  it('is a plain newline when the next line is a delimiter row (even if it does not make a table: the column counts differ)', () => {
    const v = mount('| A | B |^\n|---|\n| 1 |');
    expect(key(v, 'Enter').defaultPrevented).toBe(false);
    expect(docOf(v)).toBe('| A | B |\n|---|\n| 1 |');
  });

  it('is a plain newline when the line is already part of a table (header, body, or with a delimiter row)', () => {
    const v = mount('| A | B |^\n|---|---|\n');
    key(v, 'Enter');
    // 既に表の見出しの行なので、表の行での Enter になる（区切りの行の下に空の行）。
    expect(docOf(v)).toBe('| A | B |\n|---|---|\n|  |  |\n');
  });

  it('is a plain newline in a fenced code block, an indented code block, an HTML block, front matter, a blockquote and a list item', () => {
    const cases = [
      '```\n| A | B |^\n```',
      '    | A | B |^',
      '<div>\n| A | B |^\n</div>',
      '---\ntitle: x\n| A | B |^\n---\n\nbody',
      '---\n| A | B |^\n---\n\nbody',
      '> | A | B |^',
      '- | A | B |^',
      '- item\n| A | B |^',
      '1. | A | B |^',
    ];
    for (const src of cases) {
      const v = mount(src);
      const before = docOf(v);
      key(v, 'Enter');
      expect(docOf(v), src).not.toContain('--- |');
      expect(docOf(v).startsWith(before), src).toBe(true);
      v.destroy();
      view = null;
      host.replaceChildren();
    }
  });

  it('does not run in a plain text (.txt)', () => {
    const v = mount('| A | B |^', 'cursorLine', [], 'plain');
    expect(key(v, 'Enter').defaultPrevented).toBe(false);
    expect(docOf(v)).toBe('| A | B |');
  });

  it('is not affected by the display setting', () => {
    for (const display of ['cursorLine', 'always'] as const) {
      const v = mount('| A | B |^', display);
      key(v, 'Enter');
      expect(docOf(v)).toBe('| A | B |\n| --- | --- |\n|  |  |');
      v.destroy();
      view = null;
      host.replaceChildren();
    }
  });

  it('a line break in the document is kept (lineSeparator CRLF)', () => {
    const v = mount('| A | B |^', 'cursorLine', EditorState.lineSeparator.of('\r\n'));
    key(v, 'Enter');
    // 足した改行は state の改行（CRLF）で入るが、Text は行に分けて持つ。
    expect(v.state.lineBreak).toBe('\r\n');
    expect(v.state.doc.lines).toBe(3);
    expect(docOf(v)).toBe('| A | B |\n| --- | --- |\n|  |  |');
  });
});

describe('Enter elsewhere is unchanged: outside a table, Shift+Enter, Mod+Enter (the list continuation is checked in bundledPlugins.test.ts)', () => {
  it('Shift+Enter and Mod+Enter in a table row, and Enter outside a table, are not taken', () => {
    const doc = '| a | b |\n|---|---|\n| 1 | 2 |^\n\nafter';
    for (const init of [{ shiftKey: true }, { ctrlKey: true }, { metaKey: true }, { altKey: true }]) {
      const v = mount(doc);
      expect(key(v, 'Enter', init).defaultPrevented).toBe(false);
      expect(docOf(v)).toBe(doc.replace('^', ''));
      v.destroy();
      view = null;
      host.replaceChildren();
    }
    const outside = mount('| a | b |\n|---|---|\n| 1 | 2 |\n\nafter^');
    expect(key(outside, 'Enter').defaultPrevented).toBe(false);
  });
});

describe('Tab at the last cell adds a row', () => {
  const doc = (caret: string) => `before\n\n| a | b |\n|---|---|\n| 1 | 2${caret} |\n\nafter`;

  it('adds an empty row at the end of the table and moves to its first cell; one Undo restores the document and the selection', () => {
    for (const display of ['cursorLine', 'always'] as const) {
      const v = mount(doc('^'), display);
      const before = shown(v);
      expect(tableTab(v, false)).toBe(true);
      expect(shown(v)).toBe('before\n\n| a | b |\n|---|---|\n| 1 | 2 |\n| ^ |  |\n\nafter');
      undo(v);
      expect(shown(v)).toBe(before);
      v.destroy();
      view = null;
      host.replaceChildren();
    }
  });

  it('works from the head of the last cell, and when the last row has fewer cells than the header', () => {
    const v = mount('| a | b |\n|---|---|\n| 1 | ^2 |');
    tableTab(v, false);
    expect(docOf(v)).toBe('| a | b |\n|---|---|\n| 1 | 2 |\n|  |  |');
    v.destroy();
    view = null;
    host.replaceChildren();
    const w = mount('| a | b | c |\n|---|---|---|\n| 1 ^|');
    tableTab(w, false);
    expect(docOf(w)).toBe('| a | b | c |\n|---|---|---|\n| 1 |\n|  |  |  |');
  });

  it('uses the header row when the table has no body row (the row is added after the delimiter row)', () => {
    const v = mount('| a | b^ |\n|---|---|\n\nafter');
    expect(tableTab(v, false)).toBe(true);
    expect(shown(v)).toBe('| a | b |\n|---|---|\n| ^ |  |\n\nafter');
  });

  it('is repeatable: the new first cell moves on with Tab, and the last cell adds the next row', () => {
    const v = mount(doc('^'));
    tableTab(v, false);
    tableTab(v, false);
    expect(shown(v)).toBe('before\n\n| a | b |\n|---|---|\n| 1 | 2 |\n|  | ^ |\n\nafter');
    tableTab(v, false);
    expect(docOf(v)).toBe('before\n\n| a | b |\n|---|---|\n| 1 | 2 |\n|  |  |\n|  |  |\n\nafter');
  });

  it('does not add a row at the first cell with Shift+Tab, away from the last cell, after the closing pipe, with a range selection, outside a table, or in a nested table', () => {
    const v = mount(doc('').replace('| a |', '| ^a |'));
    const before = docOf(v);
    expect(tableTab(v, true)).toBe(true);
    expect(docOf(v)).toBe(before);
    v.destroy();
    view = null;
    host.replaceChildren();

    const mid = mount(doc('').replace('| 1 |', '| ^1 |'));
    tableTab(mid, false);
    expect(docOf(mid)).toBe(doc('').replace('| 1 |', '| 1 |'));
    mid.destroy();
    view = null;
    host.replaceChildren();

    const afterPipe = mount('| a | b |\n|---|---|\n| 1 | 2 |^');
    expect(tableTab(afterPipe, false)).toBe(true);
    expect(docOf(afterPipe)).toBe('| a | b |\n|---|---|\n| 1 | 2 |');
    afterPipe.destroy();
    view = null;
    host.replaceChildren();

    const range = mount(doc('^'));
    range.dispatch({ selection: { anchor: range.state.selection.main.head - 1, head: range.state.selection.main.head } });
    expect(tableTab(range, false)).toBe(false);
    expect(docOf(range)).toBe(doc(''));
    range.destroy();
    view = null;
    host.replaceChildren();

    const outside = mount('^before\n\n| a |\n|---|\n| 1 |');
    expect(tableTab(outside, false)).toBe(false);
    outside.destroy();
    view = null;
    host.replaceChildren();

    const nested = mount('> | a |\n> |---|\n> | 1^ |');
    expect(tableTab(nested, false)).toBe(false);
    expect(docOf(nested)).toBe('> | a |\n> |---|\n> | 1 |');
  });

  it('is not done while composing (the key is taken, nothing changes)', () => {
    const v = mount(doc('^'));
    v.contentDOM.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    expect(tableTab(v, false)).toBe(true);
    expect(docOf(v)).toBe(doc(''));
  });
});

describe('IME: Enter while composing does not add a row', () => {
  it('a keydown during a composition (isComposing, keyCode 229) adds nothing, in a table row and at a header line', () => {
    for (const src of ['| a | b |\n|---|---|\n| 1 | 2 |^', '| A | B |^']) {
      const v = mount(src);
      v.contentDOM.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
      expect(v.compositionStarted).toBe(true);
      const event = new KeyboardEvent('keydown', { key: 'Process', code: 'Enter', keyCode: 229, isComposing: true, bubbles: true, cancelable: true });
      v.contentDOM.dispatchEvent(event);
      expect(docOf(v), src).toBe(src.replace('^', ''));
      v.destroy();
      view = null;
      host.replaceChildren();
    }
  });

  it('the command itself also does nothing while a composition has started, and takes the key (a table row, a header line)', () => {
    for (const src of ['| a | b |\n|---|---|\n| 1 | 2 |^', '| A | B |^']) {
      const v = mount(src);
      v.contentDOM.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
      // CodeMirror がキーを捨てる前の経路が、万一届いても、変えない（キーは受ける）。
      expect(v.compositionStarted).toBe(true);
      expect(tableEnter(v)).toBe(true);
      expect(docOf(v)).toBe(src.replace('^', ''));
      v.destroy();
      view = null;
      host.replaceChildren();
    }
  });
});
