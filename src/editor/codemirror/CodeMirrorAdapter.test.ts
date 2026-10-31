// @vitest-environment jsdom
import { redo, undo } from '@codemirror/commands';
import { EditorView } from '@codemirror/view';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EditorAdapter } from '../EditorAdapter';
import { createCodeMirrorAdapter } from './CodeMirrorAdapter';

// jsdom には、CodeMirror が測定に使う矩形取得 API がない。
beforeAll(() => {
  const rect = { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON: () => ({}) };
  const rects = Object.assign([], { item: () => null });
  Range.prototype.getClientRects = () => rects as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect = () => rect as DOMRect;
  Element.prototype.getClientRects = () => rects as unknown as DOMRectList;
});

let host: HTMLElement;
let adapter: EditorAdapter;

function viewOf(): EditorView {
  const dom = host.querySelector('.cm-editor');
  const view = dom && EditorView.findFromDOM(dom as HTMLElement);
  if (!view) throw new Error('no EditorView');
  return view;
}

/** ユーザーの入力に相当する変更。 */
function typeAtEnd(text: string): void {
  const view = viewOf();
  const end = view.state.doc.length;
  view.dispatch({ changes: { from: end, insert: text }, selection: { anchor: end + text.length }, userEvent: 'input.type' });
}

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  adapter = createCodeMirrorAdapter();
});

afterEach(() => {
  adapter.destroy();
  host.remove();
  vi.useRealTimers();
});

describe('text', () => {
  it('returns what was set, before and after mount', () => {
    adapter.setText('before mount');
    expect(adapter.getText()).toBe('before mount');
    adapter.mount(host);
    expect(adapter.getText()).toBe('before mount');
    adapter.setText('# 見出し\n\n本文');
    expect(adapter.getText()).toBe('# 見出し\n\n本文');
  });

  it('keeps carriage returns that are not part of the LF line breaks', () => {
    adapter.mount(host);
    adapter.setText('a\rb\nc');
    expect(adapter.getText()).toBe('a\rb\nc');
  });

  it('does not call onChange for setText, but does for edits', () => {
    adapter.mount(host);
    const onChange = vi.fn();
    adapter.onChange(onChange);
    adapter.setText('loaded');
    expect(onChange).not.toHaveBeenCalled();
    typeAtEnd('!');
    expect(onChange).toHaveBeenCalledWith('loaded!');
  });

  it('stops notifying after unsubscribe', () => {
    adapter.mount(host);
    const onChange = vi.fn();
    const off = adapter.onChange(onChange);
    off();
    typeAtEnd('x');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('notifies selection changes', () => {
    adapter.mount(host);
    adapter.setText('abcdef');
    const onSelection = vi.fn();
    adapter.onSelectionChange(onSelection);
    viewOf().dispatch({ selection: { anchor: 1, head: 4 } });
    expect(onSelection).toHaveBeenCalledWith({ anchor: 1, head: 4 });
  });

  it('can be destroyed, and removes its DOM', () => {
    adapter.mount(host);
    expect(host.querySelector('.cm-editor')).not.toBeNull();
    adapter.destroy();
    expect(host.querySelector('.cm-editor')).toBeNull();
  });
});

describe('history', () => {
  it('undo and redo follow the edits', () => {
    adapter.mount(host);
    adapter.setText('base');
    typeAtEnd('1');
    expect(adapter.getText()).toBe('base1');
    expect(undo(viewOf())).toBe(true);
    expect(adapter.getText()).toBe('base');
    expect(redo(viewOf())).toBe(true);
    expect(adapter.getText()).toBe('base1');
  });

  it('setText starts a new history: undo cannot go back into the previous document', () => {
    adapter.mount(host);
    typeAtEnd('typed in the old document');
    adapter.setText('new document');
    expect(undo(viewOf())).toBe(false);
    expect(adapter.getText()).toBe('new document');
  });
});

describe('markdown decoration', () => {
  it('assigns heading size classes per line, and styles emphasis and marks', () => {
    adapter.mount(host);
    adapter.setText('# H1\n\n## H2\n\ntext **bold** and *it* and [l](http://x)\n\nSetext\n======');
    // 記法記号（# など）は非表示にせず、行のテキストに残る。
    const h1Lines = Array.from(host.querySelectorAll('.cm-md-h1')).map((n) => n.textContent);
    expect(h1Lines).toEqual(['# H1', 'Setext', '======']);
    expect(host.querySelector('.cm-md-h2')?.textContent).toBe('## H2');
    expect(host.querySelector('.cm-content')?.textContent).toContain('**bold**');
    // 見出し以外の行には見出しクラスが付かない。
    const body = Array.from(host.querySelectorAll('.cm-line')).find((n) => n.textContent?.startsWith('text '));
    expect(body?.className).not.toContain('cm-md-h');
  });
});

describe('IME composition', () => {
  it('defers setText while composing and applies it after the composition ends', () => {
    vi.useFakeTimers();
    adapter.mount(host);
    adapter.setText('original');
    const content = host.querySelector('.cm-content') as HTMLElement;

    content.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    expect(viewOf().compositionStarted).toBe(true);

    adapter.setText('replaced from outside');
    vi.advanceTimersByTime(500);
    expect(adapter.getText()).toBe('original');

    content.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
    vi.advanceTimersByTime(200);
    expect(adapter.getText()).toBe('replaced from outside');
  });

  it('the latest deferred text wins', () => {
    vi.useFakeTimers();
    adapter.mount(host);
    const content = host.querySelector('.cm-content') as HTMLElement;
    content.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    adapter.setText('first');
    adapter.setText('second');
    content.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
    vi.advanceTimersByTime(200);
    expect(adapter.getText()).toBe('second');
  });

  it('applies setText immediately when not composing', () => {
    adapter.mount(host);
    adapter.setText('now');
    expect(adapter.getText()).toBe('now');
  });
});
