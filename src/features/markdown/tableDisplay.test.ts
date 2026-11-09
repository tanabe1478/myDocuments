// @vitest-environment jsdom
import { history, undoDepth } from '@codemirror/commands';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { ensureSyntaxTree } from '@codemirror/language';
import { EditorSelection, EditorState, type Extension, type Transaction } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { DIMMED_BLOCK_CLASS, createPluginRegistry, dimExemptLines, type EditorExtensionEnvironment, type TextKind } from '../../plugin-api';
import { markdownPlugin } from '.';

// jsdom には、CodeMirror が測定に使う矩形取得 API がない。
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
  vi.useRealTimers();
});

function env(textKind: TextKind = 'markdown'): EditorExtensionEnvironment {
  return { textKind, openExternalUrl: () => {}, isMacPlatform: () => false };
}

const TABLE = ['| 名前 | 数 | 備考 |', '|:--|--:|:-:|', '| りんご | 3 | **赤** |', '| みかん |', '| a \\| b | 1 | 2 | 余り |'].join('\n');
const DOC = `前の段落\n\n${TABLE}\n\n後ろの段落`;

/** 本体が入れる Markdown の言語に、部品の拡張を足した view。選択は、先頭の行（表の外）。 */
function mount(doc: string, display: 'cursorLine' | 'always' = 'cursorLine', extra: Extension = [], selection = 0): EditorView {
  const [ext] = createPluginRegistry([markdownPlugin]).editorExtensions;
  view = new EditorView({
    parent: host,
    state: EditorState.create({ doc, selection: { anchor: selection }, extensions: [markdown({ base: markdownLanguage }), ext!.create(display, env()), extra] }),
  });
  ensureSyntaxTree(view.state, view.state.doc.length, 10_000);
  view.dispatch({});
  return view;
}

const tables = () => Array.from(host.querySelectorAll<HTMLElement>('.cm-md-table'));
const cellTexts = (table: Element) => Array.from(table.querySelectorAll('tr')).map((tr) => Array.from(tr.children).map((c) => c.textContent));
const lineTexts = () => Array.from(host.querySelectorAll('.cm-line')).map((l) => l.textContent);

function mouseDown(target: Element, init: MouseEventInit = {}): MouseEvent {
  const event = new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0, ...init });
  target.dispatchEvent(event);
  return event;
}

describe('showing a table as a table', () => {
  it('shows a top-level table outside the selection as a table, and the lines around it as they are; the document is the original text', () => {
    const v = mount(DOC);
    expect(tables()).toHaveLength(1);
    expect(lineTexts().filter((l) => l?.includes('|'))).toEqual([]);
    expect(lineTexts()).toContain('前の段落');
    expect(lineTexts()).toContain('後ろの段落');
    expect(v.state.doc.toString()).toBe(DOC);
  });

  it('builds the header cells as th and the rows as td, with the columns of the header: missing cells are empty, extra cells are dropped, empty cells count', () => {
    mount(DOC);
    const [table] = tables();
    expect(table!.querySelectorAll('thead th')).toHaveLength(3);
    expect(cellTexts(table!)).toEqual([
      ['名前', '数', '備考'],
      ['りんご', '3', '赤'],
      ['みかん', '', ''],
      ['a | b', '1', '2'],
    ]);
    expect(table!.querySelectorAll('tbody tr')).toHaveLength(3);
  });

  it('follows the alignments of the delimiter row, and does not show the delimiter row', () => {
    mount(DOC);
    const [table] = tables();
    const aligns = Array.from(table!.querySelectorAll('tbody tr:first-child td')).map((c) => (c as HTMLElement).style.textAlign);
    expect(aligns).toEqual(['left', 'right', 'center']);
    expect(table!.textContent).not.toContain('---');
  });

  it('shows emphasis, strong, strikethrough, inline code and links with classes for the same look as the hidden lines; others stay as the original text', () => {
    mount(
      [
        '| h |',
        '|---|',
        '| *e* **s** ~~d~~ `c` [l](https://x.test "t") <https://auto.test> https://bare.test |',
        '| ![img](a.png) [ref][r] <b>x</b> \\*k\\* |',
      ].join('\n') + '\n\nend',
      'cursorLine',
      [],
      '| h |\n|---|\n| *e* **s** ~~d~~ `c` [l](https://x.test "t") <https://auto.test> https://bare.test |\n| ![img](a.png) [ref][r] <b>x</b> \\*k\\* |\n\n'.length,
    );
    const [table] = tables();
    const first = table!.querySelectorAll('tbody tr')[0]!.firstElementChild!;
    const parts = Array.from(first.children).map((c) => [c.className, c.textContent]);
    expect(parts).toEqual([
      ['cm-md-t-em', 'e'],
      ['cm-md-t-strong', 's'],
      ['cm-md-t-del', 'd'],
      ['cm-md-t-code', 'c'],
      ['cm-md-t-link', 'l'],
      ['cm-md-t-url', 'https://auto.test'],
      ['cm-md-t-url', 'https://bare.test'],
    ]);
    expect(first.textContent).toBe('e s d c l https://auto.test https://bare.test');
    // 画像・参照リンク・HTML・エスケープは、原文の文字のまま（要素は作らない）。
    const second = table!.querySelectorAll('tbody tr')[1]!.firstElementChild!;
    expect(second.children).toHaveLength(0);
    expect(second.textContent).toBe('![img](a.png) [ref][r] <b>x</b> \\*k\\*');
  });

  it('puts the text of the document as text: a <script> or <img onerror> written in a cell makes no element and runs nothing', () => {
    const flag = vi.fn();
    (window as unknown as { __xss: () => void }).__xss = flag;
    mount('x\n\n| a |\n|---|\n| <script>window.__xss()</script> |\n| <img src=x onerror="window.__xss()"> |\n| &lt;b&gt; <svg onload="window.__xss()"> |\n\nend');
    const [table] = tables();
    expect(table!.querySelector('script, img, svg')).toBeNull();
    expect(table!.querySelectorAll('*:not(table, thead, tbody, tr, th, td)')).toHaveLength(0);
    expect(table!.textContent).toContain('<script>window.__xss()</script>');
    expect(table!.textContent).toContain('<img src=x onerror="window.__xss()">');
    expect(table!.textContent).toContain('&lt;b&gt; <svg onload="window.__xss()">');
    expect(flag).not.toHaveBeenCalled();
    delete (window as unknown as { __xss?: unknown }).__xss;
  });

  it('shows nothing special for display "always", and the table stays the original text', () => {
    mount(DOC, 'always');
    expect(tables()).toHaveLength(0);
    expect(lineTexts()).toContain('| 名前 | 数 | 備考 |');
  });

  it('does not touch a table inside a blockquote or a list item, nor in the frontmatter', () => {
    mount('> | a |\n> |---|\n> | 1 |\n\n- | b |\n  |---|\n\n---\nc | d\n--|--\n---\n\nend');
    expect(tables()).toHaveLength(0);
    expect(lineTexts()).toContain('> | a |');
    expect(lineTexts()).toContain('• | b |'); // ADR-004 の • への置き換えは、これまでどおり
  });

  it('shows several tables, each on its own, and a table directly after a paragraph', () => {
    mount('x\n| a |\n|---|\n| 1 |\n\n| b |\n|---|\n| 2 |\n\nend', 'cursorLine', [], 0);
    expect(tables().map((t) => cellTexts(t).flat().join(','))).toEqual(['a,1', 'b,2']);
  });
});

describe('the selection decides: a table the selection touches is the original text', () => {
  const start = DOC.indexOf('| 名前');
  const end = start + TABLE.length;

  it('turns into the original text when the caret is in it, including both end points; the other tables stay', () => {
    const two = `${DOC}\n\n| z |\n|---|\n| 9 |`;
    const v = mount(two);
    expect(tables()).toHaveLength(2);
    for (const pos of [start, start + 3, end]) {
      v.dispatch({ selection: { anchor: pos } });
      expect(tables().map((t) => cellTexts(t).flat().join(','))).toEqual(['z,9']);
      expect(lineTexts()).toContain('| 名前 | 数 | 備考 |');
    }
    // 端の 1 つ外では表示に戻る。
    v.dispatch({ selection: { anchor: start - 1 } });
    expect(tables()).toHaveLength(2);
    v.dispatch({ selection: { anchor: end + 1 } });
    expect(tables()).toHaveLength(2);
  });

  it('turns into the original text when any range of the selection touches it (a range across the table, or only reaching its end)', () => {
    const v = mount(DOC);
    v.dispatch({ selection: { anchor: 0, head: start - 1 } });
    expect(tables()).toHaveLength(1);
    v.dispatch({ selection: { anchor: 0, head: start } });
    expect(tables()).toHaveLength(0);
    v.dispatch({ selection: { anchor: 0, head: DOC.length } });
    expect(tables()).toHaveLength(0);
    v.dispatch({ selection: { anchor: end, head: DOC.length } });
    expect(tables()).toHaveLength(0);
    v.dispatch({ selection: { anchor: end + 1, head: DOC.length } });
    expect(tables()).toHaveLength(1);
  });

  it('with several ranges, any one that touches is enough', () => {
    const v = mount(DOC, 'cursorLine', EditorState.allowMultipleSelections.of(true));
    v.dispatch({ selection: EditorSelection.create([EditorSelection.cursor(0), EditorSelection.cursor(start + 5)]) });
    expect(tables()).toHaveLength(0);
  });

  it('never changes the document nor the undo history when it switches (the only transactions are selections), and reuses the DOM of the tables that did not switch', () => {
    const two = `${DOC}\n\n| z |\n|---|\n| 9 |`;
    let docChanges = 0;
    const v = mount(two, 'cursorLine', [history(), EditorView.updateListener.of((u) => u.docChanged && docChanges++)]);
    const untouched = tables()[1]!;
    for (const pos of [start + 2, 0, end, start + 5, 0]) v.dispatch({ selection: { anchor: pos } });
    mouseDown(tables()[0]!.querySelector('td')!);
    v.dispatch({ selection: { anchor: 0 } });
    expect(docChanges).toBe(0);
    expect(undoDepth(v.state)).toBe(0);
    expect(v.state.doc.toString()).toBe(two);
    expect(tables()[1]).toBe(untouched);
  });

  it('keeps working while the display is rebuilt after a document change (typing in the table, then leaving)', () => {
    const v = mount(DOC);
    v.dispatch({ selection: { anchor: start + 2 } });
    v.dispatch({ changes: { from: start + 2, insert: 'X' }, selection: { anchor: start + 3 } });
    v.dispatch({ selection: { anchor: 0 } });
    const [table] = tables();
    expect(cellTexts(table!)[0]).toEqual(['X名前', '数', '備考']);
  });
});

describe('clicking a table', () => {
  const start = DOC.indexOf('| 名前');
  const cellEnd = (needle: string) => DOC.indexOf(needle) + needle.length;

  it('puts the caret at the end of the content of the clicked cell, which turns the table into the original text; the document is unchanged', () => {
    const v = mount(DOC);
    const change = vi.fn();
    v.dispatch({ effects: [] });
    const cells = Array.from(tables()[0]!.querySelectorAll('td'));
    const event = mouseDown(cells[0]!);
    expect(event.defaultPrevented).toBe(true);
    expect(v.state.selection.main.empty).toBe(true);
    expect(v.state.selection.main.head).toBe(cellEnd('りんご'));
    expect(tables()).toHaveLength(0);
    expect(v.state.doc.toString()).toBe(DOC);
    expect(change).not.toHaveBeenCalled();
  });

  it('puts the caret at the end of a cell whose content is a formatted text, an empty cell, and a cell that is missing in a short row', () => {
    const v = mount(DOC);
    mouseDown(tables()[0]!.querySelectorAll('tbody tr')[0]!.children[2]!);
    expect(v.state.selection.main.head).toBe(cellEnd('**赤**'));
    v.dispatch({ selection: { anchor: 0 } });
    // 3 行目の足りないセル: その行の末尾。
    mouseDown(tables()[0]!.querySelectorAll('tbody tr')[1]!.children[2]!);
    expect(v.state.selection.main.head).toBe(cellEnd('| みかん |'));
  });

  it('puts the caret at the nearest cell when the click is outside the cells, and at the head of the table when it cannot decide', () => {
    const v = mount(DOC);
    // jsdom には座標がないので、「決められない」。表の頭へ。
    mouseDown(tables()[0]!);
    expect(v.state.selection.main.head).toBe(start);
    v.dispatch({ selection: { anchor: 0 } });
    const cells = Array.from(tables()[0]!.querySelectorAll('td'));
    // 一番近いセルは座標で決める（ここでは、セルごとに矩形を与える）。
    const rect = (left: number, top: number): DOMRect => ({ left, right: left + 10, top, bottom: top + 10, width: 10, height: 10, x: left, y: top, toJSON: () => ({}) }) as DOMRect;
    cells.forEach((cell, i) => (cell.getBoundingClientRect = () => rect((i % 3) * 20, Math.floor(i / 3) * 20)));
    const event = new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0, clientX: 41, clientY: 1 });
    tables()[0]!.dispatchEvent(event);
    expect(v.state.selection.main.head).toBe(cellEnd('**赤**'));
  });

  it('treats a Ctrl / Meta / Alt click the same way, does not open a link, and does nothing for the right and middle buttons', () => {
    const openExternalUrl = vi.fn();
    const doc = '| a |\n|---|\n| [l](https://example.com) |\n\nend';
    const [ext] = createPluginRegistry([markdownPlugin]).editorExtensions;
    view = new EditorView({
      parent: host,
      state: EditorState.create({ doc, extensions: [markdown({ base: markdownLanguage }), ext!.create('cursorLine', { ...env(), openExternalUrl, isMacPlatform: () => false })] }),
    });
    ensureSyntaxTree(view.state, view.state.doc.length, 10_000);
    view.dispatch({ selection: { anchor: doc.length } });
    for (const button of [1, 2]) {
      const e = mouseDown(tables()[0]!.querySelector('td')!, { button });
      expect(e.defaultPrevented).toBe(false);
      expect(tables()).toHaveLength(1);
    }
    for (const mods of [{ ctrlKey: true }, { metaKey: true }, { altKey: true }]) {
      view.dispatch({ selection: { anchor: doc.length } });
      mouseDown(tables()[0]!.querySelector('td .cm-md-t-link')!, mods);
      expect(view.state.selection.main.head).toBe(doc.indexOf(' |\n\nend'));
      expect(tables()).toHaveLength(0);
    }
    expect(openExternalUrl).not.toHaveBeenCalled();
  });

  it('uses the current position of the table when its DOM was reused after the text above it changed', () => {
    const v = mount(DOC);
    const before = tables()[0]!;
    v.dispatch({ changes: { from: 0, insert: 'XYZ' } });
    expect(tables()[0]).toBe(before); // 原文が同じなので、DOM は使い回される
    mouseDown(tables()[0]!.querySelectorAll('td')[0]!);
    expect(v.state.selection.main.head).toBe(cellEnd('りんご') + 3);
  });

  it('extends the selection with Shift+click, keeping the anchor', () => {
    const v = mount(DOC, 'cursorLine', [], 2);
    mouseDown(tables()[0]!.querySelectorAll('td')[0]!, { shiftKey: true });
    expect(v.state.selection.main.anchor).toBe(2);
    expect(v.state.selection.main.head).toBe(cellEnd('りんご'));
    expect(v.state.doc.toString()).toBe(DOC);
  });

  it('makes one transaction for a click: a pointer selection that does not change the document', () => {
    const seen: Transaction[] = [];
    mount(DOC, 'cursorLine', EditorView.updateListener.of((u) => seen.push(...u.transactions)));
    seen.length = 0;
    mouseDown(tables()[0]!.querySelector('td')!);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.docChanged).toBe(false);
    expect(seen[0]!.isUserEvent('select.pointer')).toBe(true);
  });
});

describe('IME composition holds the switching', () => {
  const start = DOC.indexOf('| 名前');

  it('does not switch the table (nor the other tables) during composition, and applies it after the composition ends', () => {
    vi.useFakeTimers();
    const two = `${DOC}\n\n| z |\n|---|\n| 9 |`;
    const v = mount(two);
    const before = tables();
    v.contentDOM.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    expect(v.compositionStarted).toBe(true);
    v.dispatch({ selection: { anchor: start + 3 } });
    // 保留: 触れていても、表示のまま。ほかの表の DOM は同じ。
    expect(tables()).toHaveLength(2);
    expect(tables()[0]).toBe(before[0]);
    expect(tables()[1]).toBe(before[1]);
    v.contentDOM.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
    vi.advanceTimersByTime(30);
    expect(tables()).toHaveLength(2);
    vi.advanceTimersByTime(100);
    expect(tables()).toHaveLength(1);
    expect(tables()[0]).toBe(before[1]);
    expect(lineTexts()).toContain('| 名前 | 数 | 備考 |');
  });

  it('keeps the position of a displayed table while the composition changes the document above it, and does not rebuild its DOM', () => {
    vi.useFakeTimers();
    const v = mount(DOC);
    const [table] = tables();
    v.contentDOM.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    v.dispatch({ changes: { from: 2, insert: 'あいう' }, selection: { anchor: 5 } });
    expect(tables()).toHaveLength(1);
    expect(tables()[0]).toBe(table);
    v.contentDOM.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
    vi.advanceTimersByTime(200);
    expect(tables()).toHaveLength(1);
    expect(tables()[0]).toBe(table);
    expect(lineTexts()).toContain('前のあいう段落');
  });
});

describe('dimming (a part that dims lines can dim the displayed table)', () => {
  const exempt = (from: number, to: number) => dimExemptLines.of(() => ({ from, to }));

  it('adds the dimmed class to the table the exempt range does not cover, and removes it when the range moves onto it', () => {
    const v = mount(DOC, 'cursorLine', exempt(1, 1));
    expect(tables()[0]!.classList.contains(DIMMED_BLOCK_CLASS)).toBe(true);
    v.dispatch({ selection: { anchor: 1 } }); // 同期は、選択の変化で走る（提供した範囲は固定なので、ここでは変わらない）
    expect(tables()[0]!.classList.contains(DIMMED_BLOCK_CLASS)).toBe(true);
  });

  it('does not dim when nothing provides an exempt range, or the range covers the table', () => {
    mount(DOC);
    expect(tables()[0]!.classList.contains(DIMMED_BLOCK_CLASS)).toBe(false);
    view?.destroy();
    host.replaceChildren();
    mount(DOC, 'cursorLine', exempt(3, 7));
    expect(tables()[0]!.classList.contains(DIMMED_BLOCK_CLASS)).toBe(false);
  });
});
