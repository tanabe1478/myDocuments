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
  it('assigns heading size classes per line, and styles emphasis and marks (markup shown always)', () => {
    adapter.mount(host);
    adapter.setMarkupDisplay('always');
    adapter.setText('# H1\n\n## H2\n\ntext **bold** and *it* and [l](http://x)\n\nSetext\n======');
    // 記法記号（# など）は、「常に表示」では隠さず、行のテキストに残る。
    const h1Lines = Array.from(host.querySelectorAll('.cm-md-h1')).map((n) => n.textContent);
    expect(h1Lines).toEqual(['# H1', 'Setext', '======']);
    expect(host.querySelector('.cm-md-h2')?.textContent).toBe('## H2');
    expect(host.querySelector('.cm-content')?.textContent).toContain('**bold**');
    // 見出し以外の行には見出しクラスが付かない。
    const body = Array.from(host.querySelectorAll('.cm-line')).find((n) => n.textContent?.startsWith('text '));
    expect(body?.className).not.toContain('cm-md-h');
  });
});

/** 描画された行のテキスト（隠した記号は含まれない）。 */
function renderedLines(): string[] {
  return Array.from(host.querySelectorAll('.cm-line')).map((n) => n.textContent ?? '');
}

function moveCursorTo(pos: number): void {
  viewOf().dispatch({ selection: { anchor: pos } });
}

describe('live markup (ADR-004)', () => {
  const DOC = '# H1\n\n## H2\n\n- item\n\ntext **bold** and [l](http://x)\n\n> quote';

  it('hides the markup on lines without the cursor, and shows it on the cursor line', () => {
    adapter.mount(host);
    adapter.setText(DOC);
    // カーソルは先頭（1 行目）。1 行目は記号を見せ、ほかの行は隠す。
    expect(renderedLines()).toEqual(['# H1', '', 'H2', '', '\u2022 item', '', 'text bold and l', '', 'quote']);
    // 本文は変わらない。
    expect(adapter.getText()).toBe(DOC);
  });

  it('switches only the line that the cursor enters and leaves', () => {
    adapter.mount(host);
    adapter.setText(DOC);
    const doc = viewOf().state.doc;
    moveCursorTo(doc.line(3).from + 3);
    expect(renderedLines()).toEqual(['H1', '', '## H2', '', '\u2022 item', '', 'text bold and l', '', 'quote']);
    moveCursorTo(doc.line(7).from + 5);
    expect(renderedLines()).toEqual(['H1', '', 'H2', '', '\u2022 item', '', 'text **bold** and [l](http://x)', '', 'quote']);
    expect(adapter.getText()).toBe(DOC);
  });

  it('shows the markup on every line that a selection touches', () => {
    adapter.mount(host);
    adapter.setText(DOC);
    const doc = viewOf().state.doc;
    viewOf().dispatch({ selection: { anchor: doc.line(3).from + 1, head: doc.line(7).from + 2 } });
    expect(renderedLines()).toEqual(['H1', '', '## H2', '', '- item', '', 'text **bold** and [l](http://x)', '', 'quote']);
  });

  it('shows everything with markupDisplay always, and follows later changes at once', () => {
    adapter.mount(host);
    adapter.setText(DOC);
    adapter.setMarkupDisplay('always');
    expect(renderedLines()).toEqual(DOC.split('\n'));
    adapter.setMarkupDisplay('cursorLine');
    expect(renderedLines()[2]).toBe('H2');
  });

  it('keeps the setting when a new document is set', () => {
    adapter.mount(host);
    adapter.setMarkupDisplay('always');
    adapter.setText(DOC);
    expect(renderedLines()).toEqual(DOC.split('\n'));
  });

  it('does not hide anything in plain text', () => {
    adapter.mount(host);
    adapter.setTextKind('plain');
    adapter.setText(DOC);
    expect(renderedLines()).toEqual(DOC.split('\n'));
  });

  it('draws the task box and keeps the text of the document', () => {
    adapter.mount(host);
    adapter.setText('first\n\n- [ ] todo\n- [x] done');
    expect(host.querySelectorAll('.cm-md-task')).toHaveLength(2);
    expect(host.querySelectorAll('.cm-md-task-done')).toHaveLength(1);
    expect(adapter.getText()).toBe('first\n\n- [ ] todo\n- [x] done');
  });

  it('defers the switch of the lines during a composition, and applies it after', () => {
    vi.useFakeTimers();
    adapter.mount(host);
    adapter.setText('# H1\n\n## H2\n\ntext');
    const content = host.querySelector('.cm-content') as HTMLElement;
    const before = renderedLines();

    content.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    expect(viewOf().compositionStarted).toBe(true);
    moveCursorTo(viewOf().state.doc.line(3).from + 3);
    // 変換中は、どの行も切り替えない。
    expect(renderedLines()).toEqual(before);

    content.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
    vi.advanceTimersByTime(300);
    expect(renderedLines()).toEqual(['H1', '', '## H2', '', 'text']);
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

const dim = () =>
  Array.from(host.querySelectorAll('.cm-line')).map((l) => l.classList.contains('cm-md-dim'));

describe('focus mode', () => {
  const DOC = 'one\ntwo\n\nthree\n\nfour';

  it('is off by default, and dims every line outside the cursor paragraph when on', () => {
    adapter.mount(host);
    adapter.setText(DOC);
    expect(dim()).toEqual([false, false, false, false, false, false]);

    adapter.setFocusMode(true);
    viewOf().dispatch({ selection: { anchor: 0 } });
    expect(dim()).toEqual([false, false, true, true, true, true]);

    // 4 行目（three）へ
    viewOf().dispatch({ selection: { anchor: DOC.indexOf('three') } });
    expect(dim()).toEqual([true, true, true, false, true, true]);

    adapter.setFocusMode(false);
    expect(dim()).toEqual([false, false, false, false, false, false]);
  });

  it('only changes line classes: the text, history and selection are untouched', () => {
    adapter.mount(host);
    adapter.setText(DOC);
    viewOf().dispatch({ selection: { anchor: 2, head: 6 } });
    adapter.setFocusMode(true);
    expect(adapter.getText()).toBe(DOC);
    expect(viewOf().state.selection.main).toMatchObject({ anchor: 2, head: 6 });
    expect(undo(viewOf())).toBe(false);
  });

  it('survives setText (loading another document keeps the mode)', () => {
    adapter.mount(host);
    adapter.setFocusMode(true);
    adapter.setText('a\n\nb');
    viewOf().dispatch({ selection: { anchor: 0 } });
    expect(dim()).toEqual([false, true, true]);
  });

  it('can be set before mount', () => {
    adapter.setFocusMode(true);
    adapter.mount(host);
    adapter.setText('a\n\nb');
    viewOf().dispatch({ selection: { anchor: 0 } });
    expect(dim()).toEqual([false, true, true]);
  });

  it('does not recompute while composing, and reflects the change after compositionend', () => {
    vi.useFakeTimers();
    adapter.mount(host);
    adapter.setText(DOC);
    adapter.setFocusMode(true);
    viewOf().dispatch({ selection: { anchor: 0 } });
    expect(dim()).toEqual([false, false, true, true, true, true]);
    const content = host.querySelector('.cm-content') as HTMLElement;

    content.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    // 変換中にカーソルが別の段落へ移っても、行の属性は変えない。
    viewOf().dispatch({ selection: { anchor: DOC.indexOf('three') } });
    expect(dim()).toEqual([false, false, true, true, true, true]);
    vi.advanceTimersByTime(500);
    expect(dim()).toEqual([false, false, true, true, true, true]);

    content.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
    vi.advanceTimersByTime(200);
    expect(dim()).toEqual([true, true, true, false, true, true]);
  });

  it('follows edits made while composing, by position, then settles afterwards', () => {
    vi.useFakeTimers();
    adapter.mount(host);
    adapter.setText('abc\n\ndef');
    adapter.setFocusMode(true);
    viewOf().dispatch({ selection: { anchor: 3 } });
    const content = host.querySelector('.cm-content') as HTMLElement;
    content.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    viewOf().dispatch({ changes: { from: 3, insert: 'に' }, selection: { anchor: 4 } });
    expect(adapter.getText()).toBe('abcに\n\ndef');
    expect(dim()).toEqual([false, true, true]);
    content.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
    vi.advanceTimersByTime(200);
    expect(dim()).toEqual([false, true, true]);
  });
});

describe('typewriter mode', () => {
  it('adds the typewriter class to the editor while on, and removes it when off', () => {
    adapter.mount(host);
    const editor = host.querySelector('.cm-editor') as HTMLElement;
    expect(editor.classList.contains('cm-typewriter')).toBe(false);
    adapter.setTypewriterMode(true);
    expect(editor.classList.contains('cm-typewriter')).toBe(true);
    adapter.setTypewriterMode(false);
    expect(editor.classList.contains('cm-typewriter')).toBe(false);
  });

  it('survives setText, and leaves the text and history alone', () => {
    adapter.mount(host);
    adapter.setTypewriterMode(true);
    adapter.setText('long\ndocument');
    const editor = host.querySelector('.cm-editor') as HTMLElement;
    expect(editor.classList.contains('cm-typewriter')).toBe(true);
    expect(adapter.getText()).toBe('long\ndocument');
    expect(undo(viewOf())).toBe(false);
  });
});

describe('list continuation on Enter', () => {
  const LOOSE = '- a\n\n- b';

  /** 末尾にカーソルを置いて、本文に Enter のキー入力を送る。 */
  function pressEnterAtEnd(): void {
    const view = viewOf();
    view.dispatch({ selection: { anchor: view.state.doc.length } });
    view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true, cancelable: true }));
  }

  it('does not add a blank line to a loose list by default', () => {
    adapter.mount(host);
    adapter.setText(LOOSE);
    pressEnterAtEnd();
    expect(adapter.getText()).toBe('- a\n\n- b\n- ');
  });

  it('adds the blank line in preserve mode, and takes effect at once (no reload)', () => {
    adapter.mount(host);
    adapter.setText(LOOSE);
    adapter.setListContinuation('preserve');
    pressEnterAtEnd();
    expect(adapter.getText()).toBe('- a\n\n- b\n\n- ');
    adapter.setListContinuation('tight');
    adapter.setText(LOOSE);
    pressEnterAtEnd();
    expect(adapter.getText()).toBe('- a\n\n- b\n- ');
  });

  it('keeps the mode across setText, and can be set before mount', () => {
    adapter.setListContinuation('preserve');
    adapter.mount(host);
    adapter.setText(LOOSE);
    pressEnterAtEnd();
    expect(adapter.getText()).toBe('- a\n\n- b\n\n- ');
    adapter.setText(LOOSE);
    pressEnterAtEnd();
    expect(adapter.getText()).toBe('- a\n\n- b\n\n- ');
  });

  it('undoes in one step', () => {
    adapter.mount(host);
    adapter.setText(LOOSE);
    pressEnterAtEnd();
    expect(undo(viewOf())).toBe(true);
    expect(adapter.getText()).toBe(LOOSE);
  });

  it('does not continue Markdown in a plain text document (same as before)', () => {
    adapter.mount(host);
    adapter.setTextKind('plain');
    adapter.setText(LOOSE);
    pressEnterAtEnd();
    expect(adapter.getText()).toBe('- a\n\n- b\n');
    adapter.setListContinuation('preserve');
    adapter.setText(LOOSE);
    pressEnterAtEnd();
    expect(adapter.getText()).toBe('- a\n\n- b\n');
  });
});

describe('text kind (.txt and .text are shown as plain text)', () => {
  const MARKDOWN = '# 見出し\n\n- 項目\n\n本文';

  const lineClasses = () => Array.from(host.querySelectorAll('.cm-line'), (l) => l.className);

  it('decorates Markdown by default, and not plain text', () => {
    adapter.mount(host);
    adapter.setText(MARKDOWN);
    expect(host.querySelector('.cm-md-h1')).not.toBeNull();
    expect(host.querySelector('.cm-md-blank')).not.toBeNull();

    adapter.setTextKind('plain');
    expect(host.querySelector('.cm-md-h1')).toBeNull();
    // 空行の高さ（段落間隔）は、素のテキストでも効く。
    expect(host.querySelectorAll('.cm-md-blank')).toHaveLength(2);
    expect(lineClasses().some((c) => /cm-md-(h\d|quote|fence)/.test(c))).toBe(false);
    expect(Array.from(host.querySelectorAll<HTMLElement>('.cm-line')).every((l) => l.style.paddingLeft === '')).toBe(true);
  });

  it('switches back to Markdown, and leaves the text, selection and history alone', () => {
    adapter.mount(host);
    adapter.setText(MARKDOWN);
    adapter.setTextKind('plain');
    typeAtEnd('追記');
    const selection = viewOf().state.selection.main.head;
    adapter.setTextKind('markdown');
    expect(adapter.getText()).toBe(`${MARKDOWN}追記`);
    expect(viewOf().state.selection.main.head).toBe(selection);
    expect(host.querySelector('.cm-md-h1')).not.toBeNull();
    expect(undo(viewOf())).toBe(true);
    expect(adapter.getText()).toBe(MARKDOWN);
  });

  it('keeps the kind across setText (loading another document)', () => {
    adapter.mount(host);
    adapter.setTextKind('plain');
    adapter.setText(MARKDOWN);
    expect(host.querySelector('.cm-md-h1')).toBeNull();
    adapter.setTextKind('markdown');
    adapter.setText('# 別の文書');
    expect(host.querySelector('.cm-md-h1')).not.toBeNull();
  });

  it('can be set before mount', () => {
    adapter.setTextKind('plain');
    adapter.setText(MARKDOWN);
    adapter.mount(host);
    expect(host.querySelector('.cm-md-h1')).toBeNull();
  });

  it('splits focus-mode paragraphs by blank lines only for plain text', () => {
    adapter.mount(host);
    adapter.setFocusMode(true);
    adapter.setText('# 見出し\n本文\n\n別段落');
    const dimmed = () => Array.from(host.querySelectorAll('.cm-line'), (l) => l.classList.contains('cm-md-dim'));
    viewOf().dispatch({ selection: { anchor: 0 } });
    expect(dimmed()).toEqual([false, true, true, true]);
    adapter.setTextKind('plain');
    expect(dimmed()).toEqual([false, false, true, true]);
  });
});

describe('accessibility', () => {
  it('labels the editable area', () => {
    adapter.mount(host);
    const content = host.querySelector('.cm-content');
    expect(content?.getAttribute('aria-label')).toBe('本文');
    expect(content?.getAttribute('aria-multiline')).toBe('true');
  });
});
