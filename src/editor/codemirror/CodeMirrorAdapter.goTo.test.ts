// @vitest-environment jsdom
import { EditorView } from '@codemirror/view';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EditorAdapter } from '../EditorAdapter';
import { createCodeMirrorAdapter } from './CodeMirrorAdapter';

// R7: パネルの項目を押したときの移動（goToLineStart）、変換中の判定（isComposing）、選択の取得（getSelection）。

beforeAll(() => {
  const rect = { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON: () => ({}) };
  const rects = Object.assign([], { item: () => null });
  Range.prototype.getClientRects = () => rects as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect = () => rect as DOMRect;
  Element.prototype.getClientRects = () => rects as unknown as DOMRectList;
});

let host: HTMLElement;
let adapter: EditorAdapter;
const viewOf = (): EditorView => {
  const dom = host.querySelector('.cm-editor');
  const view = dom && EditorView.findFromDOM(dom as HTMLElement);
  if (!view) throw new Error('no EditorView');
  return view;
};

const TEXT = 'intro\n# A\nbody\n## B\n\n# 日本語の見出し\nlast';

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  adapter = createCodeMirrorAdapter();
  adapter.setText(TEXT);
  adapter.mount(host);
});

afterEach(() => {
  adapter.destroy();
  host.remove();
  vi.restoreAllMocks();
});

describe('goToLineStart', () => {
  it('puts the cursor at the start of the line that holds the position, collapsing any range selection', () => {
    viewOf().dispatch({ selection: { anchor: 0, head: 5 } });
    adapter.goToLineStart(TEXT.indexOf('## B') + 3);
    expect(adapter.getSelection()).toEqual({ anchor: TEXT.indexOf('## B'), head: TEXT.indexOf('## B') });
    adapter.goToLineStart(TEXT.indexOf('# A'));
    expect(adapter.getSelection()).toEqual({ anchor: 6, head: 6 });
    adapter.goToLineStart(0);
    expect(adapter.getSelection()).toEqual({ anchor: 0, head: 0 });
  });

  it('works for a heading in Japanese and for the last line (no trailing newline)', () => {
    adapter.goToLineStart(TEXT.indexOf('# 日本語'));
    expect(viewOf().state.doc.lineAt(adapter.getSelection().head).text).toBe('# 日本語の見出し');
    adapter.goToLineStart(TEXT.length - 1);
    expect(viewOf().state.doc.lineAt(adapter.getSelection().head).text).toBe('last');
    expect(adapter.getSelection().head).toBe(TEXT.indexOf('last'));
  });

  it('clamps a position past the end of the text (the text got shorter) and a negative or non-finite one; it never throws', () => {
    adapter.goToLineStart(10_000_000);
    expect(adapter.getSelection().head).toBe(TEXT.indexOf('last'));
    adapter.goToLineStart(-5);
    expect(adapter.getSelection().head).toBe(0);
    adapter.goToLineStart(Number.NaN);
    expect(adapter.getSelection().head).toBe(0);
    adapter.goToLineStart(Number.POSITIVE_INFINITY);
    expect(adapter.getSelection().head).toBe(0);
    adapter.goToLineStart(3.9);
    expect(adapter.getSelection().head).toBe(0);
  });

  it('moves the focus to the editor, scrolls the line into view, and does not change the text or the history', () => {
    const view = viewOf();
    const scroll = vi.spyOn(view, 'dispatch');
    const outside = document.createElement('button');
    document.body.append(outside);
    outside.focus();
    expect(document.activeElement).toBe(outside);
    adapter.goToLineStart(TEXT.indexOf('## B'));
    expect(view.hasFocus).toBe(true);
    const transaction = scroll.mock.calls[0]![0] as { effects?: unknown; userEvent?: string; changes?: unknown };
    expect(transaction.effects).toBeDefined();
    expect(transaction.changes).toBeUndefined();
    expect(adapter.getText()).toBe(TEXT);
    outside.remove();
  });

  it('notifies selection listeners, not change listeners', () => {
    const onSelection = vi.fn();
    const onChange = vi.fn();
    adapter.onSelectionChange(onSelection);
    adapter.onChange(onChange);
    adapter.goToLineStart(TEXT.indexOf('## B'));
    expect(onSelection).toHaveBeenCalledWith({ anchor: TEXT.indexOf('## B'), head: TEXT.indexOf('## B') });
    expect(onChange).not.toHaveBeenCalled();
  });

  it('does nothing before mount and after destroy', () => {
    const fresh = createCodeMirrorAdapter();
    expect(() => fresh.goToLineStart(3)).not.toThrow();
    expect(fresh.getSelection()).toEqual({ anchor: 0, head: 0 });
    expect(fresh.isComposing()).toBe(false);
    adapter.destroy();
    expect(() => adapter.goToLineStart(3)).not.toThrow();
  });
});

describe('isComposing and getSelection', () => {
  it('isComposing follows the view’s composition state', () => {
    expect(adapter.isComposing()).toBe(false);
    vi.spyOn(viewOf(), 'compositionStarted', 'get').mockReturnValue(true);
    expect(adapter.isComposing()).toBe(true);
  });

  it('getSelection returns the main selection (anchor and head, for a range too)', () => {
    viewOf().dispatch({ selection: { anchor: 8, head: 2 } });
    expect(adapter.getSelection()).toEqual({ anchor: 8, head: 2 });
  });
});
