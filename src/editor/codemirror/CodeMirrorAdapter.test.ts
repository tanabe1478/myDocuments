// @vitest-environment jsdom
import { history, redo, undo } from '@codemirror/commands';
import { ensureSyntaxTree } from '@codemirror/language';
import { EditorSelection, EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EditorAdapter } from '../EditorAdapter';
import { PLUGIN_API_VERSION, createPluginRegistry } from '../../plugin-api';
import { createCodeMirrorAdapter } from './CodeMirrorAdapter';
import { markdownDecorations } from './markdownDecorations';
import { taskToggleExtension } from './taskToggle';

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

/**
 * 構文解析を最後まで済ませる。state の作成時（mount・setText）の解析は短い時間で打ち切られ、負荷が高いと木が未完成のまま、
 * 木に頼る描画（記号を隠す・タスクの枠・見出し）とコマンド（Enter・チェックボックスのクリック）が何もしない。
 * ensureSyntaxTree は解析を進めるが、state が持つ木は古いままなので、空の transaction で持ち替える
 * （木が変わると、描画も更新される）。文書の種類が plain のときは言語がなく、何も起きない。
 */
function settleSyntax(view: EditorView): void {
  ensureSyntaxTree(view.state, view.state.doc.length, 10_000);
  view.dispatch({});
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
    settleSyntax(viewOf());
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
    settleSyntax(viewOf());
    // カーソルは先頭（1 行目）。1 行目は記号を見せ、ほかの行は隠す。
    expect(renderedLines()).toEqual(['# H1', '', 'H2', '', '\u2022 item', '', 'text bold and l', '', 'quote']);
    // 本文は変わらない。
    expect(adapter.getText()).toBe(DOC);
  });

  it('switches only the line that the cursor enters and leaves', () => {
    adapter.mount(host);
    adapter.setText(DOC);
    settleSyntax(viewOf());
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
    settleSyntax(viewOf());
    const doc = viewOf().state.doc;
    viewOf().dispatch({ selection: { anchor: doc.line(3).from + 1, head: doc.line(7).from + 2 } });
    expect(renderedLines()).toEqual(['H1', '', '## H2', '', '- item', '', 'text **bold** and [l](http://x)', '', 'quote']);
  });

  it('shows everything with markupDisplay always, and follows later changes at once', () => {
    adapter.mount(host);
    adapter.setText(DOC);
    settleSyntax(viewOf());
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
    settleSyntax(viewOf());
    expect(host.querySelectorAll('.cm-md-task')).toHaveLength(2);
    expect(host.querySelectorAll('.cm-md-task-done')).toHaveLength(1);
    expect(adapter.getText()).toBe('first\n\n- [ ] todo\n- [x] done');
  });

  it('defers the switch of the lines during a composition, and applies it after', () => {
    vi.useFakeTimers();
    adapter.mount(host);
    adapter.setText('# H1\n\n## H2\n\ntext');
    settleSyntax(viewOf());
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

describe('plugin editor extensions (setPluginSetting)', () => {
  /** 設定 mark が true の間だけ、エディタに class 'plug-on' を付ける部品。 */
  function markPlugin(onCreate?: (value: unknown) => void) {
    const registry = createPluginRegistry([
      {
        manifest: { id: 'mark', name: 'mark', version: '1.0.0', apiVersion: PLUGIN_API_VERSION, tier: 'editor' },
        activate(ctx) {
          const setting = ctx.registerSetting<boolean>({ key: 'mark', defaultValue: false, normalize: (raw) => raw === true });
          ctx.registerEditorExtension({
            setting,
            create: (on) => {
              onCreate?.(on);
              return on ? EditorView.editorAttributes.of({ class: 'plug-on' }) : [];
            },
          });
        },
      },
    ]);
    return registry.editorExtensions;
  }
  const editorDom = () => host.querySelector('.cm-editor') as HTMLElement;

  it('starts with the default value, and swaps the extension when the setting changes', () => {
    adapter = createCodeMirrorAdapter(markPlugin());
    adapter.mount(host);
    expect(editorDom().classList.contains('plug-on')).toBe(false);
    adapter.setPluginSetting('mark', true);
    expect(editorDom().classList.contains('plug-on')).toBe(true);
    adapter.setPluginSetting('mark', false);
    expect(editorDom().classList.contains('plug-on')).toBe(false);
  });

  it('applies a value set before mount, and rebuilds only when the value changes', () => {
    const created: unknown[] = [];
    adapter = createCodeMirrorAdapter(markPlugin((v) => created.push(v)));
    adapter.setPluginSetting('mark', true);
    adapter.mount(host);
    expect(editorDom().classList.contains('plug-on')).toBe(true);
    const before = created.length;
    adapter.setPluginSetting('mark', true);
    expect(created.length).toBe(before);
  });

  it('survives setText, and leaves the text and history alone', () => {
    adapter = createCodeMirrorAdapter(markPlugin());
    adapter.mount(host);
    adapter.setPluginSetting('mark', true);
    adapter.setText('long\ndocument');
    expect(editorDom().classList.contains('plug-on')).toBe(true);
    expect(adapter.getText()).toBe('long\ndocument');
    expect(undo(viewOf())).toBe(false);
  });

  it('ignores keys that no plugin registered', () => {
    adapter = createCodeMirrorAdapter(markPlugin());
    adapter.mount(host);
    expect(() => adapter.setPluginSetting('unknown', true)).not.toThrow();
    expect(editorDom().classList.contains('plug-on')).toBe(false);
  });

  /** 文書の種類を読む拡張（dependsOnTextKind）と、読まない拡張。作るたびに、渡された種類を記録する。 */
  function kindPlugins(created: string[]) {
    const registry = createPluginRegistry([
      {
        manifest: { id: 'kind', name: 'kind', version: '1.0.0', apiVersion: PLUGIN_API_VERSION, tier: 'editor' },
        activate(ctx) {
          const aware = ctx.registerSetting<boolean>({ key: 'aware', defaultValue: true, normalize: (raw) => raw === true });
          ctx.registerEditorExtension({
            setting: aware,
            dependsOnTextKind: true,
            create: (on, env) => {
              created.push(`aware:${env.textKind}`);
              return on ? EditorView.editorAttributes.of({ class: `kind-${env.textKind}` }) : [];
            },
          });
          const blind = ctx.registerSetting<boolean>({ key: 'blind', defaultValue: true, normalize: (raw) => raw === true });
          ctx.registerEditorExtension({
            setting: blind,
            create: (_on, env) => {
              created.push(`blind:${env.textKind}`);
              return [];
            },
          });
        },
      },
    ]);
    return registry.editorExtensions;
  }

  it('rebuilds only the extensions that depend on the document kind, when the kind changes', () => {
    const created: string[] = [];
    adapter = createCodeMirrorAdapter(kindPlugins(created));
    adapter.mount(host);
    expect(editorDom().classList.contains('kind-markdown')).toBe(true);
    created.length = 0;

    adapter.setTextKind('plain');
    expect(created).toEqual(['aware:plain']);
    expect(editorDom().classList.contains('kind-plain')).toBe(true);
    expect(editorDom().classList.contains('kind-markdown')).toBe(false);

    // 同じ種類をもう一度渡しても、作り直さない。
    adapter.setTextKind('plain');
    expect(created).toEqual(['aware:plain']);

    adapter.setTextKind('markdown');
    expect(created).toEqual(['aware:plain', 'aware:markdown']);
    expect(editorDom().classList.contains('kind-markdown')).toBe(true);
  });

  it('starts with the current kind after setText, and when the kind is set before mount', () => {
    const created: string[] = [];
    adapter = createCodeMirrorAdapter(kindPlugins(created));
    adapter.setTextKind('plain');
    adapter.mount(host);
    expect(editorDom().classList.contains('kind-plain')).toBe(true);
    adapter.setText('other document');
    expect(editorDom().classList.contains('kind-plain')).toBe(true);
  });

  it('keeps working without plugins', () => {
    adapter.mount(host);
    expect(() => adapter.setPluginSetting('mark', true)).not.toThrow();
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
});

describe('task toggle (click on the checkbox of a hidden line)', () => {
  const TASKS = 'first\n\n- [ ] todo\n- [x] done\n\n> - [X] quoted\n\nlast';

  function mousedown(el: Element, init: MouseEventInit = {}): MouseEvent {
    const event = new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0, ...init });
    el.dispatchEvent(event);
    // 切り替えた後の再解析も、短い時間で打ち切られることがある。続けて木に頼る確かめ（枠の数・次のクリック）の前に済ませる。
    settleSyntax(viewOf());
    return event;
  }

  function boxes(): HTMLElement[] {
    return Array.from(host.querySelectorAll<HTMLElement>('.cm-md-task'));
  }

  function setup(text = TASKS): void {
    adapter.mount(host);
    adapter.setText(text);
    settleSyntax(viewOf());
  }

  it('toggles the clicked task and nothing else, without touching the selection', () => {
    setup();
    const view = viewOf();
    view.dispatch({ selection: { anchor: 2, head: 4 } });
    const event = mousedown(boxes()[0]!);
    expect(event.defaultPrevented).toBe(true);
    expect(adapter.getText()).toBe('first\n\n- [x] todo\n- [x] done\n\n> - [X] quoted\n\nlast');
    expect(view.state.selection.main.anchor).toBe(2);
    expect(view.state.selection.main.head).toBe(4);
    expect(boxes()[0]!.classList.contains('cm-md-task-done')).toBe(true);
    expect(boxes()[0]!.getAttribute('aria-checked')).toBe('true');
  });

  it('toggles [x] and [X] to [ ]', () => {
    setup();
    mousedown(boxes()[1]!);
    expect(adapter.getText()).toContain('- [ ] done');
    mousedown(boxes()[2]!);
    expect(adapter.getText()).toContain('> - [ ] quoted');
  });

  // アプリは複数カーソルを有効にしていない（UI からは作れない）。有効にした素の EditorView で、選択に触れないことを確かめる。
  it('keeps multiple cursors when the editor allows them', () => {
    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: TASKS,
        extensions: [
          EditorState.allowMultipleSelections.of(true),
          markdownDecorations(),
          taskToggleExtension(),
          history(),
        ],
      }),
    });
    settleSyntax(view);
    view.dispatch({
      selection: EditorSelection.create([EditorSelection.cursor(1), EditorSelection.range(TASKS.length - 3, TASKS.length)]),
    });
    mousedown(host.querySelector('.cm-md-task')!);
    expect(view.state.doc.toString()).toContain('- [x] todo');
    expect(view.state.selection.ranges.map((r) => [r.anchor, r.head])).toEqual([
      [1, 1],
      [TASKS.length - 3, TASKS.length],
    ]);
    view.destroy();
  });

  it('undoes in one step and redoes', () => {
    setup();
    const view = viewOf();
    mousedown(boxes()[0]!);
    mousedown(boxes()[1]!);
    expect(adapter.getText()).toContain('- [x] todo\n- [ ] done');
    undo(view);
    expect(adapter.getText()).toContain('- [x] todo\n- [x] done');
    undo(view);
    expect(adapter.getText()).toBe(TASKS);
    redo(view);
    expect(adapter.getText()).toContain('- [x] todo\n- [x] done');
  });

  it('is not merged with the typing that follows', () => {
    setup();
    const view = viewOf();
    mousedown(boxes()[0]!);
    const end = view.state.doc.length;
    view.dispatch({ changes: { from: end, insert: '!' }, selection: { anchor: end + 1 }, userEvent: 'input.type' });
    undo(view);
    expect(adapter.getText()).toBe(TASKS.replace('- [ ] todo', '- [x] todo'));
    undo(view);
    expect(adapter.getText()).toBe(TASKS);
  });

  it('goes through the change listeners like typing', () => {
    setup();
    const seen: string[] = [];
    adapter.onChange((t) => seen.push(t));
    mousedown(boxes()[0]!);
    expect(seen).toEqual(['first\n\n- [x] todo\n- [x] done\n\n> - [X] quoted\n\nlast']);
  });

  it('toggles twice back to the original', () => {
    setup();
    mousedown(boxes()[0]!);
    mousedown(boxes()[0]!);
    expect(adapter.getText()).toBe(TASKS);
  });

  it('does not toggle with a modifier key, or with another button', () => {
    setup();
    for (const init of [{ shiftKey: true }, { metaKey: true }, { ctrlKey: true }, { altKey: true }, { button: 1 }, { button: 2 }]) {
      mousedown(boxes()[0]!, init);
      expect(adapter.getText()).toBe(TASKS);
    }
  });

  it('does not toggle while composing', () => {
    setup();
    const content = host.querySelector('.cm-content') as HTMLElement;
    content.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    expect(viewOf().compositionStarted).toBe(true);
    const target = boxes()[0]!;
    mousedown(target);
    expect(adapter.getText()).toBe(TASKS);
  });

  it('does not toggle when the markup is always shown', () => {
    setup();
    adapter.setMarkupDisplay('always');
    expect(boxes()).toHaveLength(0);
    const line = host.querySelectorAll('.cm-line')[2]!;
    mousedown(line);
    expect(adapter.getText()).toBe(TASKS);
  });

  it('does not toggle on the cursor line, or from the text next to the box', () => {
    setup();
    const view = viewOf();
    view.dispatch({ selection: { anchor: view.state.doc.line(3).from + 3 } });
    expect(boxes().map((b) => b.classList.contains('cm-md-task-done'))).toEqual([true, true]);
    const lines = Array.from(host.querySelectorAll('.cm-line'));
    mousedown(lines[2]!);
    mousedown(lines[3]!);
    expect(adapter.getText()).toBe(TASKS);
  });

  it('draws the box as a checkbox that follows the state', () => {
    setup();
    const [todo, done] = boxes();
    expect([todo!.getAttribute('role'), todo!.getAttribute('aria-checked')]).toEqual(['checkbox', 'false']);
    expect([done!.getAttribute('role'), done!.getAttribute('aria-checked')]).toEqual(['checkbox', 'true']);
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
