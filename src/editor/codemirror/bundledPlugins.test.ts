// @vitest-environment jsdom
import { history, undo } from '@codemirror/commands';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { ensureSyntaxTree } from '@codemirror/language';
import { EditorState } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { bundledPlugins } from '../../features';
import { createPluginRegistry, ownsCaretScroll, skipCaretFollow } from '../../plugin-api';
import type { EditorAdapter } from '../EditorAdapter';
import { createCodeMirrorAdapter } from './CodeMirrorAdapter';
import { readingPositionExtension } from './readingPosition';

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
  vi.useRealTimers();
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

const dim = () =>
  Array.from(host.querySelectorAll('.cm-line')).map((l) => l.classList.contains('cm-md-dim'));

describe('focus mode through the adapter (was setFocusMode)', () => {
  const DOC = 'one\ntwo\n\nthree\n\nfour';
  const setFocusMode = (on: boolean) => adapter.setPluginSetting('focusMode', on);

  it('is off by default, and dims every line outside the cursor paragraph when on', () => {
    adapter.mount(host);
    adapter.setText(DOC);
    expect(dim()).toEqual([false, false, false, false, false, false]);

    setFocusMode(true);
    viewOf().dispatch({ selection: { anchor: 0 } });
    expect(dim()).toEqual([false, false, true, true, true, true]);

    // 4 行目（three）へ
    viewOf().dispatch({ selection: { anchor: DOC.indexOf('three') } });
    expect(dim()).toEqual([true, true, true, false, true, true]);

    setFocusMode(false);
    expect(dim()).toEqual([false, false, false, false, false, false]);
  });

  it('only changes line classes: the text, history and selection are untouched', () => {
    adapter.mount(host);
    adapter.setText(DOC);
    viewOf().dispatch({ selection: { anchor: 2, head: 6 } });
    setFocusMode(true);
    expect(adapter.getText()).toBe(DOC);
    expect(viewOf().state.selection.main).toMatchObject({ anchor: 2, head: 6 });
    expect(undo(viewOf())).toBe(false);
  });

  it('survives setText (loading another document keeps the mode)', () => {
    adapter.mount(host);
    setFocusMode(true);
    adapter.setText('a\n\nb');
    viewOf().dispatch({ selection: { anchor: 0 } });
    expect(dim()).toEqual([false, true, true]);
  });

  it('can be set before mount', () => {
    setFocusMode(true);
    adapter.mount(host);
    adapter.setText('a\n\nb');
    viewOf().dispatch({ selection: { anchor: 0 } });
    expect(dim()).toEqual([false, true, true]);
  });

  it('does not recompute while composing, and reflects the change after compositionend', () => {
    vi.useFakeTimers();
    adapter.mount(host);
    adapter.setText(DOC);
    setFocusMode(true);
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
    setFocusMode(true);
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

  it('splits paragraphs by blank lines only for plain text: the plugin is rebuilt when the kind changes', () => {
    adapter.mount(host);
    adapter.setPluginSetting('focusMode', true);
    adapter.setText('# 見出し\n本文\n\n別段落');
    const dimmed = () => Array.from(host.querySelectorAll('.cm-line'), (l) => l.classList.contains('cm-md-dim'));
    viewOf().dispatch({ selection: { anchor: 0 } });
    expect(dimmed()).toEqual([false, true, true, true]);
    adapter.setTextKind('plain');
    expect(dimmed()).toEqual([false, false, true, true]);
  });
});

describe('list continuation through the adapter (was setListContinuation)', () => {
  const LOOSE = '- a\n\n- b';

  /** 構文解析を最後まで済ませてから、本文に Enter のキー入力を送る（末尾にカーソルを置く）。 */
  function pressEnterAtEnd(): void {
    const view = viewOf();
    view.dispatch({ selection: { anchor: view.state.doc.length } });
    ensureSyntaxTree(view.state, view.state.doc.length, 10_000);
    view.dispatch({});
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
    adapter.setPluginSetting('listContinuation', 'preserve');
    pressEnterAtEnd();
    expect(adapter.getText()).toBe('- a\n\n- b\n\n- ');
    adapter.setPluginSetting('listContinuation', 'tight');
    adapter.setText(LOOSE);
    pressEnterAtEnd();
    expect(adapter.getText()).toBe('- a\n\n- b\n- ');
  });

  it('keeps the mode across setText, and can be set before mount', () => {
    adapter.setPluginSetting('listContinuation', 'preserve');
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
    adapter.setPluginSetting('listContinuation', 'preserve');
    adapter.setText(LOOSE);
    pressEnterAtEnd();
    expect(adapter.getText()).toBe('- a\n\n- b\n');
  });

  /** Enter に結び付いたキー割り当てを、効く順に並べる（キー割り当ての Facet は、優先度の高い順に並ぶ）。 */
  function enterBindings(): Array<{ name: string; hasShift: boolean }> {
    return viewOf()
      .state.facet(keymap)
      .flat()
      .filter((b) => b.key === 'Enter')
      .map((b) => ({ name: b.run?.name ?? '', hasShift: b.shift !== undefined }));
  }

  it('Enter priority is unchanged: tight comes first (highest), then the two bindings that were behind it; preserve leaves only those two', () => {
    // 変更前のコミット（リストの継続を本体が持っていたとき）で、同じ組み立ての state から調べた並び:
    //   tight    = [insertNewlineContinueTight, (lang-markdown の Enter), (defaultKeymap の Enter。shift つき)]
    //   preserve = [(lang-markdown の Enter), (defaultKeymap の Enter。shift つき)]
    adapter.mount(host);
    expect(enterBindings()).toEqual([
      { name: 'insertNewlineContinueTight', hasShift: false },
      { name: '', hasShift: false },
      { name: '', hasShift: true },
    ]);
    adapter.setPluginSetting('listContinuation', 'preserve');
    expect(enterBindings()).toEqual([
      { name: '', hasShift: false },
      { name: '', hasShift: true },
    ]);
  });
});

describe('bundled plugins together', () => {
  it('lists the writing aids as focus mode (100), typewriter mode (200), in that order', () => {
    expect(registry.settingsItems('appearance.writingAids').map((i) => [i.label, i.order, i.settingKey])).toEqual([
      ['フォーカスモード', 100, 'focusMode'],
      ['タイプライターモード', 200, 'typewriterMode'],
    ]);
  });

  it('keeps the extension order of the list (Markdown display, focus mode, list continuation, typewriter mode), and the shortcuts apart', () => {
    expect(registry.editorExtensions.map((e) => e.settingKey)).toEqual(['markupDisplay', 'focusMode', 'listContinuation', 'typewriterMode']);
    expect(registry.commands.map((c) => [c.id, c.shortcut?.text])).toEqual([
      ['focus.toggle', 'Mod+Shift+F'],
      ['typewriter.toggle', 'Mod+Shift+T'],
    ]);
  });

  it('focus mode and typewriter mode can be on at once (the combination of live-markup.spec)', () => {
    adapter.mount(host);
    adapter.setText('a\n\nb');
    adapter.setPluginSetting('focusMode', true);
    adapter.setPluginSetting('typewriterMode', true);
    viewOf().dispatch({ selection: { anchor: 0 } });
    const editor = host.querySelector('.cm-editor') as HTMLElement;
    expect(editor.classList.contains('cm-typewriter')).toBe(true);
    expect(dim()).toEqual([false, true, true]);
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
          // 本体が Markdown の言語を入れ、Markdown の見た目の部品（チェックボックスの切り替えを含む）の拡張を足す。
          markdown({ base: markdownLanguage }),
          registry.editorExtensions.find((e) => e.pluginId === 'markdown')!.create('cursorLine', { textKind: 'markdown', openExternalUrl: () => {}, isMacPlatform: () => false }),
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
