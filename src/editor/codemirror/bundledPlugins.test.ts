// @vitest-environment jsdom
import { history, undo } from '@codemirror/commands';
import { ensureSyntaxTree } from '@codemirror/language';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { bundledPlugins } from '../../features';
import { createPluginRegistry, ownsCaretScroll, skipCaretFollow } from '../../plugin-api';
import type { EditorAdapter } from '../EditorAdapter';
import { createCodeMirrorAdapter } from './CodeMirrorAdapter';
import { markdownDecorations } from './markdownDecorations';
import { readingPositionExtension } from './readingPosition';
import { taskToggleExtension } from './taskToggle';

// 同梱の部品が、ホスト（CodeMirrorAdapter など）を通して、これまでと同じに働くことの確認。
beforeAll(() => {
  const rect = { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON: () => ({}) };
  const rects = Object.assign([], { item: () => null });
  Range.prototype.getClientRects = () => rects as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect = () => rect as DOMRect;
  Element.prototype.getClientRects = () => rects as unknown as DOMRectList;
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 500 });
});

let host: HTMLElement;
let adapter: EditorAdapter;
const registry = createPluginRegistry(bundledPlugins);

function viewOf(): EditorView {
  const dom = host.querySelector('.cm-editor');
  const view = dom && EditorView.findFromDOM(dom as HTMLElement);
  if (!view) throw new Error('no EditorView');
  return view;
}

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  adapter = createCodeMirrorAdapter(registry.editorExtensions);
});

afterEach(() => {
  adapter.destroy();
  host.remove();
});

describe('typewriter mode through the adapter (was setTypewriterMode)', () => {
  it('adds the typewriter class to the editor while on, and removes it when off', () => {
    adapter.mount(host);
    const editor = host.querySelector('.cm-editor') as HTMLElement;
    expect(editor.classList.contains('cm-typewriter')).toBe(false);
    adapter.setPluginSetting('typewriterMode', true);
    expect(editor.classList.contains('cm-typewriter')).toBe(true);
    adapter.setPluginSetting('typewriterMode', false);
    expect(editor.classList.contains('cm-typewriter')).toBe(false);
  });

  it('survives setText, and leaves the text and history alone', () => {
    adapter.mount(host);
    adapter.setPluginSetting('typewriterMode', true);
    adapter.setText('long\ndocument');
    const editor = host.querySelector('.cm-editor') as HTMLElement;
    expect(editor.classList.contains('cm-typewriter')).toBe(true);
    expect(adapter.getText()).toBe('long\ndocument');
    expect(undo(viewOf())).toBe(false);
  });

  it('starts on when the value is set before mount', () => {
    adapter.setPluginSetting('typewriterMode', true);
    adapter.mount(host);
    expect((host.querySelector('.cm-editor') as HTMLElement).classList.contains('cm-typewriter')).toBe(true);
  });

  it('turns off the default reading-position margins while on (the plugin owns the caret scroll)', () => {
    adapter.mount(host);
    // 視線の位置の余白は、表示領域の高さの 3 割（CARET_MARGIN_RATIO）。高さを 500 にしているので 150。
    const readingMargins = () => {
      const view = viewOf();
      return view.state.facet(EditorView.scrollMargins).filter((f) => f(view)?.top === 150).length;
    };
    expect(readingMargins()).toBe(1);
    adapter.setPluginSetting('typewriterMode', true);
    expect(readingMargins()).toBe(0);
    adapter.setPluginSetting('typewriterMode', false);
    expect(readingMargins()).toBe(1);
  });
});

describe('shared conventions', () => {
  it('the checkbox click marks its transaction with skipCaretFollow (and keeps its userEvent)', () => {
    const seen: Array<{ marked: boolean; userEvent: boolean }> = [];
    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: 'first\n\n- [ ] todo\n',
        extensions: [
          markdownDecorations(),
          taskToggleExtension(),
          history(),
          EditorView.updateListener.of((u) => {
            for (const tr of u.transactions) {
              if (tr.docChanged) seen.push({ marked: tr.annotation(skipCaretFollow) === true, userEvent: tr.isUserEvent('input.toggle-task') });
            }
          }),
        ],
      }),
    });
    // 構文解析は state の作成時に短い時間で打ち切られることがある（負荷が高いとき）。最後まで済ませてから、描画を更新する。
    ensureSyntaxTree(view.state, view.state.doc.length, 10_000);
    view.dispatch({ selection: { anchor: 0 } });
    host.querySelector('.cm-md-task')!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }));
    expect(view.state.doc.toString()).toContain('- [x] todo');
    expect(seen).toEqual([{ marked: true, userEvent: true }]);
  });

  it('readingPositionExtension keeps its margins unless something owns the caret scroll', () => {
    const view = new EditorView({ parent: host, state: EditorState.create({ extensions: readingPositionExtension() }) });
    expect(view.state.facet(EditorView.scrollMargins).map((f) => f(view))).toEqual([{ top: 150, bottom: 150 }]);
    const owned = new EditorView({
      parent: host,
      state: EditorState.create({ extensions: [readingPositionExtension(), ownsCaretScroll.of(true)] }),
    });
    expect(owned.state.facet(EditorView.scrollMargins).map((f) => f(owned))).toEqual([null]);
  });
});
