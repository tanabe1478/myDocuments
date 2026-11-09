// @vitest-environment jsdom
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { ensureSyntaxTree } from '@codemirror/language';
import { EditorState, type Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPluginRegistry, type EditorExtensionEnvironment } from '../../plugin-api';
import { tableTab } from './tableKeys';
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

const env: EditorExtensionEnvironment = { textKind: 'markdown', openExternalUrl: () => {}, isMacPlatform: () => false };

function mount(doc: string, display: 'cursorLine' | 'always', anchor: number, extra: Extension = []): EditorView {
  const [ext] = createPluginRegistry([markdownPlugin]).editorExtensions;
  view = new EditorView({
    parent: host,
    state: EditorState.create({ doc, selection: { anchor }, extensions: [markdown({ base: markdownLanguage }), ext!.create(display, env), extra] }),
  });
  ensureSyntaxTree(view.state, view.state.doc.length, 10_000);
  view.dispatch({});
  return view;
}

const TABLE = ['| a | b |', '|---|---|', '| 1 |  |', '| x | y |'].join('\n');
const DOC = `before\n\n${TABLE}\n\nafter`;
const at = (needle: string, offset = 0) => DOC.indexOf(needle) + offset;
/** 表の先頭からの位置。 */
const T = DOC.indexOf(TABLE);

describe('Tab / Shift+Tab in the original text of a table', () => {
  it('moves to the head of the content of the next / previous cell, crossing rows, with an empty selection, whatever the display setting', () => {
    for (const display of ['cursorLine', 'always'] as const) {
      const v = mount(DOC, display, T + 2);
      const trace: number[] = [];
      for (let i = 0; i < 5; i++) {
        expect(tableTab(v, false)).toBe(true);
        trace.push(v.state.selection.main.head);
      }
      expect(trace).toEqual([T + 6, T + 22, T + 26, T + 31, T + 35]);
      for (let i = 0; i < 5; i++) {
        expect(tableTab(v, true)).toBe(true);
      }
      expect(v.state.selection.main.head).toBe(T + 2);
      v.destroy();
      view = null;
      host.replaceChildren();
    }
  });

  it('accepts the key without moving at the first cell (Shift+Tab) and the last cell (Tab), changing nothing', () => {
    const v = mount(DOC, 'always', T + 2);
    expect(tableTab(v, true)).toBe(true);
    expect(v.state.selection.main.head).toBe(T + 2);
    v.dispatch({ selection: { anchor: T + 35 } });
    expect(tableTab(v, false)).toBe(true);
    expect(v.state.selection.main.head).toBe(T + 35);
    expect(v.state.doc.toString()).toBe(DOC);
  });

  it('does nothing for a range selection, outside a table, and in a table inside a blockquote or a list item', () => {
    const v = mount(DOC, 'always', T + 2);
    v.dispatch({ selection: { anchor: T + 2, head: T + 6 } });
    expect(tableTab(v, false)).toBe(false);
    v.dispatch({ selection: { anchor: 2 } });
    expect(tableTab(v, false)).toBe(false);
    v.destroy();
    view = null;
    host.replaceChildren();
    const nested = mount('> | a | b |\n> |---|---|\n> | 1 | 2 |\n\n- | c |\n  |---|', 'always', 4);
    expect(tableTab(nested, false)).toBe(false);
    nested.dispatch({ selection: { anchor: nested.state.doc.length - 3 } });
    expect(tableTab(nested, false)).toBe(false);
  });

  it('does nothing while composing (accepts the key, keeps the caret)', () => {
    const v = mount(DOC, 'always', T + 2);
    v.contentDOM.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    expect(v.compositionStarted).toBe(true);
    expect(tableTab(v, false)).toBe(true);
    expect(v.state.selection.main.head).toBe(T + 2);
  });

  it('does not make a transaction that changes the document or adds an undo step', () => {
    const v = mount(DOC, 'always', T + 2);
    const seen: boolean[] = [];
    v.dispatch({ effects: [] });
    const spy = vi.spyOn(v, 'dispatch');
    tableTab(v, false);
    expect(spy).toHaveBeenCalledTimes(1);
    const spec = spy.mock.calls[0]![0] as { changes?: unknown; userEvent?: string };
    expect(spec.changes).toBeUndefined();
    expect(spec.userEvent).toBe('select');
    expect(seen).toEqual([]);
  });
});

describe('arrow keys enter a displayed table from the lines above and below', () => {
  const press = (v: EditorView, key: string, init: KeyboardEventInit = {}) =>
    v.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key, code: key, bubbles: true, cancelable: true, ...init }));

  it('ArrowDown from the line above goes to the header row, ArrowUp from the line below goes to the last row; the table turns into the original text', () => {
    const v = mount(DOC, 'cursorLine', at('before', 3));
    // 空行（表の 1 行上）へ。
    v.dispatch({ selection: { anchor: at('\n\n| a', 1) } });
    expect(v.dom.querySelectorAll('.cm-md-table')).toHaveLength(1);
    press(v, 'ArrowDown');
    expect(v.state.doc.lineAt(v.state.selection.main.head).number).toBe(3);
    expect(v.dom.querySelectorAll('.cm-md-table')).toHaveLength(0);
    // 表の下の空行から ArrowUp。
    v.dispatch({ selection: { anchor: 0 } });
    expect(v.dom.querySelectorAll('.cm-md-table')).toHaveLength(1);
    v.dispatch({ selection: { anchor: at('\n\nafter', 1) } });
    press(v, 'ArrowUp');
    expect(v.state.doc.lineAt(v.state.selection.main.head).number).toBe(6);
    expect(v.dom.querySelectorAll('.cm-md-table')).toHaveLength(0);
    expect(v.state.doc.toString()).toBe(DOC);
  });

  it('works with Ctrl-n and Ctrl-p on macOS, and extends the selection with Shift', () => {
    const v = mount(DOC, 'cursorLine', at('\n\n| a', 1));
    press(v, 'ArrowDown', { shiftKey: true });
    const { anchor, head } = v.state.selection.main;
    expect(anchor).toBe(at('\n\n| a', 1));
    expect(v.state.doc.lineAt(head).number).toBe(3);
  });

  it('does not take the key when the table is not displayed (always), when the lines are not adjacent, or with a range selection', () => {
    const v = mount(DOC, 'always', at('\n\n| a', 1));
    press(v, 'ArrowDown');
    expect(v.state.selection.main.head).toBe(at('\n\n| a', 1)); // この view には標準の移動がないので、動かない（部品は受けない）
    v.destroy();
    view = null;
    host.replaceChildren();
    const w = mount(DOC, 'cursorLine', 0);
    press(w, 'ArrowDown');
    expect(w.state.selection.main.head).toBe(0);
    w.dispatch({ selection: { anchor: at('\n\n| a', 1), head: at('\n\n| a', 1) - 1 } });
    press(w, 'ArrowDown');
    expect(w.state.selection.main.anchor).toBe(at('\n\n| a', 1));
    expect(w.dom.querySelectorAll('.cm-md-table')).toHaveLength(1);
  });
});
