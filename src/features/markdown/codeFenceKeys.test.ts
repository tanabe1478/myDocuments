// @vitest-environment jsdom
import { defaultKeymap, history, undo } from '@codemirror/commands';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { ensureSyntaxTree } from '@codemirror/language';
import { EditorState } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPluginRegistry, type EditorExtensionEnvironment } from '../../plugin-api';
import { fenceEnter, fenceExit } from './codeFenceKeys';
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

/** 本体と同じ並び: Markdown の言語、部品（Markdown の見た目）、既定のキー割り当て。`|` の位置にカーソルを置く。 */
function mount(marked: string): EditorView {
  const [ext] = createPluginRegistry([markdownPlugin]).editorExtensions;
  const doc = marked.replace('|', '');
  view = new EditorView({
    parent: host,
    state: EditorState.create({
      doc,
      selection: { anchor: marked.indexOf('|') },
      extensions: [history(), markdown({ base: markdownLanguage }), ext!.create('cursorLine', env), keymap.of(defaultKeymap)],
    }),
  });
  ensureSyntaxTree(view.state, view.state.doc.length, 10_000);
  view.dispatch({});
  return view;
}

const text = (v: EditorView) => v.state.doc.toString();
const caret = (v: EditorView) => v.state.selection.main.head;

function press(v: EditorView, key: string, init: KeyboardEventInit = {}): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key, code: key, keyCode: key === 'Enter' ? 13 : 0, bubbles: true, cancelable: true, ...init });
  v.contentDOM.dispatchEvent(event);
  return event;
}

describe('code block keys (ADR-004 追補（コードブロック）)', () => {
  it('Enter on an opening fence line adds the closing fence, takes the key, and undoes in one step', () => {
    const v = mount('```ts|');
    expect(press(v, 'Enter').defaultPrevented).toBe(true);
    expect(text(v)).toBe('```ts\n\n```');
    expect(caret(v)).toBe(6);
    expect(undo(v)).toBe(true);
    expect(text(v)).toBe('```ts');
  });

  it('Enter does nothing special when the block is closed: the plain newline of the default keymap (the indent follows the previous line)', () => {
    const v = mount('```ts|\nfoo\n```');
    press(v, 'Enter');
    expect(text(v)).toBe('```ts\n\nfoo\n```');
    const w = mount('```ts\n  foo|\n```');
    press(w, 'Enter');
    expect(text(w)).toBe('```ts\n  foo\n  \n```');
  });

  it('Enter inside the code of an unclosed block stays a plain newline (no closing fence is added from there, and no second-Enter exit)', () => {
    const v = mount('```ts\nfoo|');
    press(v, 'Enter');
    expect(text(v)).toBe('```ts\nfoo\n');
    press(v, 'Enter');
    expect(text(v)).toBe('```ts\nfoo\n\n');
  });

  it('Mod-Enter leaves the code block; outside a block it is still the blank line of the default keymap', () => {
    const v = mount('```ts\nfo|o\n```\nafter');
    expect(press(v, 'Enter', { ctrlKey: true }).defaultPrevented).toBe(true);
    expect(text(v)).toBe('```ts\nfoo\n```\nafter');
    expect(caret(v)).toBe(text(v).indexOf('after'));
    const w = mount('plain|\nnext');
    press(w, 'Enter', { ctrlKey: true });
    expect(text(w)).toBe('plain\n\nnext');
  });

  it('does nothing while composing: the key is taken, the document and the caret stay', () => {
    const v = mount('```ts|');
    v.contentDOM.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    expect(v.compositionStarted).toBe(true);
    expect(fenceEnter(v)).toBe(true);
    expect(text(v)).toBe('```ts');
    const w = mount('```ts\nfo|o\n```');
    w.contentDOM.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    expect(fenceExit(w)).toBe(true);
    expect(caret(w)).toBe(8);
  });

  it('does not take the key outside its cases (the command returns false)', () => {
    const v = mount('plain text|');
    expect(fenceEnter(v)).toBe(false);
    expect(fenceExit(v)).toBe(false);
    const w = mount('```ts\nfoo|');
    expect(fenceEnter(w)).toBe(false);
  });

  it('does nothing for a range selection or in a read-only editor', () => {
    const v = mount('```ts|');
    v.dispatch({ selection: { anchor: 0, head: 5 } });
    expect(fenceEnter(v)).toBe(false);
    const w = mount('```ts|');
    w.dispatch({ effects: [] });
    const r = new EditorView({
      parent: host,
      state: EditorState.create({ doc: '```ts', selection: { anchor: 5 }, extensions: [markdown({ base: markdownLanguage }), EditorState.readOnly.of(true)] }),
    });
    ensureSyntaxTree(r.state, 5, 1000);
    expect(fenceEnter(r)).toBe(false);
    r.destroy();
  });

  it('Shift+Enter on an opening fence line is the plain newline', () => {
    const v = mount('```ts|');
    press(v, 'Enter', { shiftKey: true });
    expect(text(v)).toBe('```ts\n');
  });
});
