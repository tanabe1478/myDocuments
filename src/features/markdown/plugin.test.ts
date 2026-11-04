// @vitest-environment jsdom
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { ensureSyntaxTree } from '@codemirror/language';
import { EditorState, type Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPluginRegistry, type EditorExtensionEnvironment, type TextKind } from '../../plugin-api';
import { MARKUP_DISPLAY_SETTING_KEY } from './markupDisplay';
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
  vi.restoreAllMocks();
});

const registry = () => createPluginRegistry([markdownPlugin]);

function env(textKind: TextKind = 'markdown', overrides: Partial<EditorExtensionEnvironment> = {}): EditorExtensionEnvironment {
  return { textKind, openExternalUrl: () => {}, isMacPlatform: () => false, ...overrides };
}

/** 本体が文書の種類に応じて入れる Markdown の言語に、部品の拡張を足した view。 */
function mount(doc: string, extension: Extension): EditorView {
  view = new EditorView({
    parent: host,
    state: EditorState.create({ doc, extensions: [markdown({ base: markdownLanguage }), extension] }),
  });
  ensureSyntaxTree(view.state, view.state.doc.length, 10_000);
  view.dispatch({});
  return view;
}

describe('markdown plugin registration', () => {
  it('declares itself for the current API as an editor-tier plugin', () => {
    expect(registry().records).toEqual([{ id: 'markdown', name: 'Markdown の見た目', version: '1.0.0', status: 'active', reason: null }]);
  });

  it('registers markupDisplay under the same top-level key, "cursorLine" by default', () => {
    const [setting] = registry().settings;
    expect(MARKUP_DISPLAY_SETTING_KEY).toBe('markupDisplay');
    expect(setting).toMatchObject({ key: 'markupDisplay', defaultValue: 'cursorLine' });
  });

  it('reads the two valid values, and any other value (wrong case, other types, empty) as the default', () => {
    const [setting] = registry().settings;
    expect(setting?.normalize('cursorLine')).toBe('cursorLine');
    expect(setting?.normalize('always')).toBe('always');
    for (const bad of ['hidden', '', 'Always', 'cursorline', 1, true, null, undefined, ['always'], {}]) {
      expect(setting?.normalize(bad), String(bad)).toBe('cursorLine');
    }
  });

  it('puts the "記号の表示" radio in the appearance body, between the paper width (300) and the theme (400), with the same name, options and hint', () => {
    const [item] = registry().settingsItems('appearance.body');
    expect(item).toMatchObject({
      pluginId: 'markdown',
      placement: 'appearance.body',
      order: 350,
      kind: 'radio',
      settingKey: 'markupDisplay',
      name: 'markup-display',
      legend: '記号の表示',
      options: [
        { value: 'cursorLine', label: 'カーソルのある行だけ' },
        { value: 'always', label: '常に表示' },
      ],
      hint: 'Markdown の # や * などの記号を、どの行で見せるか。「カーソルのある行だけ」では、ほかの行は記号を隠して整形して表示します（文書の中身は変わりません）。',
    });
  });

  it('depends on the text kind, and adds nothing for plain text', () => {
    const [ext] = registry().editorExtensions;
    expect(ext?.dependsOnTextKind).toBe(true);
    expect(ext?.create('always', env('plain'))).toEqual([]);
  });
});

describe('markdown plugin extension', () => {
  const DOC = '# H1\n\ntext [l](https://example.com/a) end\n\n- [ ] todo';

  it('decorates a Markdown document (heading class, blank line class) and follows the display setting', () => {
    const [ext] = registry().editorExtensions;
    const always = mount(DOC, ext!.create('always', env()));
    expect(host.querySelector('.cm-md-h1')?.textContent).toBe('# H1');
    expect(host.querySelector('.cm-md-blank')).not.toBeNull();
    expect(Array.from(host.querySelectorAll('.cm-line')).map((n) => n.textContent)).toEqual(DOC.split('\n'));
    always.destroy();
    view = null;
    host.replaceChildren();
    mount(DOC, ext!.create('cursorLine', env()));
    // カーソルは 1 行目。ほかの行は記号を隠す（チェックボックスは文字ではなく、固定の幅の箱で描く）。
    expect(Array.from(host.querySelectorAll('.cm-line')).map((n) => n.textContent)).toEqual(['# H1', '', 'text l end', '', ' todo']);
  });

  describe('opening a link', () => {
    function clickLink(modifiers: { metaKey?: boolean; ctrlKey?: boolean }, pos = 12): void {
      const link = host.querySelector('.cm-md-link')!;
      expect(link).not.toBeNull();
      // jsdom には座標がないので、クリックの位置は本文の位置で返す。
      vi.spyOn(view!, 'posAtCoords').mockReturnValue(pos);
      link.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0, ...modifiers }));
    }

    it('passes the URL of a Ctrl+clicked link to the host (non-macOS)', () => {
      const [ext] = registry().editorExtensions;
      const opened: string[] = [];
      mount(DOC, ext!.create('cursorLine', env('markdown', { openExternalUrl: (url) => opened.push(url) })));
      clickLink({ ctrlKey: true });
      expect(opened).toEqual(['https://example.com/a']);
    });

    it('needs Cmd on macOS (Ctrl+click is a right click there), and plain clicks never open', () => {
      const [ext] = registry().editorExtensions;
      const opened: string[] = [];
      mount(DOC, ext!.create('cursorLine', env('markdown', { openExternalUrl: (url) => opened.push(url), isMacPlatform: () => true })));
      clickLink({ ctrlKey: true });
      clickLink({});
      expect(opened).toEqual([]);
      clickLink({ metaKey: true });
      expect(opened).toEqual(['https://example.com/a']);
    });

    it('does not open anything for a click outside a link, or when the plugin is stopped (the captured service does nothing)', () => {
      const reg = registry();
      const [ext] = reg.editorExtensions;
      const opened: string[] = [];
      mount(DOC, ext!.create('cursorLine', env('markdown', { openExternalUrl: (url) => opened.push(url) })));
      clickLink({ ctrlKey: true }, 0);
      expect(opened).toEqual([]);
      reg.dispose();
      clickLink({ ctrlKey: true });
      expect(opened).toEqual([]);
    });
  });
});
