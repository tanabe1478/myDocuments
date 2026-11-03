// @vitest-environment jsdom
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPluginRegistry, type CommandContext, type KeyEventLike, type TextKind } from '../../plugin-api';
import { FOCUS_SETTING_KEY, focusPlugin } from '.';

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
});

const registry = () => createPluginRegistry([focusPlugin]);

describe('focus plugin registration', () => {
  it('declares itself for the current API as an editor-tier plugin', () => {
    expect(registry().records).toEqual([{ id: 'focus', name: 'フォーカスモード', version: '1.0.0', status: 'active', reason: null }]);
  });

  it('registers the setting under the same key as before, as a boolean that is false by default', () => {
    const [setting] = registry().settings;
    expect(setting).toMatchObject({ key: 'focusMode', defaultValue: false });
    expect(FOCUS_SETTING_KEY).toBe('focusMode');
    expect(setting?.normalize(true)).toBe(true);
    expect(setting?.normalize(false)).toBe(false);
    for (const bad of [undefined, null, 1, 0, 'true', 'yes', [], {}]) expect(setting?.normalize(bad), String(bad)).toBe(false);
  });

  it('registers the toggle command: Mod+Shift+F, ignored in text entry fields', () => {
    const [command] = registry().commands;
    expect(command).toMatchObject({ id: 'focus.toggle', ignoreInTextEntry: true });
    expect(command?.shortcut?.text).toBe('Mod+Shift+F');
  });

  it('toggles the setting through the command context', () => {
    let value = false;
    const ctx: CommandContext = {
      settings: {
        get: <T,>() => value as T,
        update: <T,>(_setting: unknown, next: (current: T) => T) => {
          value = next(value as T) as boolean;
        },
      },
    };
    const [command] = registry().commands;
    command?.run(ctx);
    expect(value).toBe(true);
    command?.run(ctx);
    expect(value).toBe(false);
  });

  it('puts the first checkbox in the writing aids section (order 100, labelled フォーカスモード)', () => {
    expect(registry().settingsItems('appearance.writingAids')).toEqual([
      { pluginId: 'focus', placement: 'appearance.writingAids', order: 100, kind: 'checkbox', settingKey: 'focusMode', label: 'フォーカスモード' },
    ]);
  });

  it('asks the host to rebuild the extension when the document kind changes (it splits paragraphs by kind)', () => {
    const [ext] = registry().editorExtensions;
    expect(ext).toMatchObject({ pluginId: 'focus', settingKey: 'focusMode', defaultValue: false, dependsOnTextKind: true });
  });
});

/**
 * 本体の固定のショートカットだったころの、フォーカスモードのキー判定（変更前の matchShortcut の focusMode の分岐を
 * そのまま書き写したもの）。部品のショートカット Mod+Shift+F が、これと同じ入力で同じ結果になることを確かめる。
 */
function legacyFocusModeKey(e: KeyEventLike & { isComposing?: boolean; keyCode?: number }, mac: boolean): boolean {
  if (e.isComposing || e.keyCode === 229) return false;
  const letter = /^[a-z]$/i.test(e.key) ? e.key.toLowerCase() : /^Key([A-Z])$/.exec(e.code)?.[1]?.toLowerCase();
  const primary = mac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
  if (!primary || e.altKey) return false;
  return letter === 'f' && e.shiftKey;
}

describe('the shortcut matches exactly the inputs the fixed focus mode shortcut matched', () => {
  const key = (k: string, mods: Partial<KeyEventLike> = {}) => ({
    key: k,
    code: `Key${k.toUpperCase()}`,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    ...mods,
  });

  it('over every modifier combination, letters, a full-width letter (physical key fallback), and IME composition', () => {
    const r = registry();
    const events: Array<[KeyEventLike & { isComposing?: boolean; keyCode?: number }, boolean]> = [];
    for (const mac of [true, false]) {
      for (const k of ['F', 'f', 'ｆ', 'a', ',']) {
        for (let m = 0; m < 16; m++) {
          events.push([
            {
              ...key(k),
              code: k === 'ｆ' ? 'KeyF' : k === ',' ? 'Comma' : `Key${k.toUpperCase()}`,
              metaKey: (m & 1) !== 0,
              ctrlKey: (m & 2) !== 0,
              altKey: (m & 4) !== 0,
              shiftKey: (m & 8) !== 0,
            },
            mac,
          ]);
        }
      }
      events.push([{ ...key('F', { metaKey: true, shiftKey: true }), isComposing: true }, mac]);
      events.push([{ ...key('F', { ctrlKey: true, shiftKey: true }), keyCode: 229 }, mac]);
    }
    let matched = 0;
    for (const [e, mac] of events) {
      const found = r.findCommandByKey(e, mac)?.id === 'focus.toggle';
      expect(found, JSON.stringify([e, mac])).toBe(legacyFocusModeKey(e, mac));
      if (found) matched++;
    }
    expect(matched).toBeGreaterThan(0);
  });
});

describe('focus mode extension', () => {
  const DOC = '# 見出し\n本文\n\n別段落';
  const dim = () => Array.from(host.querySelectorAll('.cm-line'), (l) => l.classList.contains('cm-md-dim'));

  function mount(on: boolean, kind: TextKind): EditorView {
    const [ext] = registry().editorExtensions;
    view = new EditorView({
      parent: host,
      state: EditorState.create({ doc: DOC, selection: { anchor: 0 }, extensions: ext?.create(on, { textKind: kind }) }),
    });
    return view;
  }

  it('adds nothing when off', () => {
    mount(false, 'markdown');
    expect(dim()).toEqual([false, false, false, false]);
  });

  it('dims the lines outside the cursor paragraph; markdown treats a heading as its own paragraph', () => {
    mount(true, 'markdown');
    expect(dim()).toEqual([false, true, true, true]);
  });

  it('splits by blank lines only for plain text', () => {
    mount(true, 'plain');
    expect(dim()).toEqual([false, false, true, true]);
  });

  it('only changes line classes: the text and the selection are untouched', () => {
    const v = mount(true, 'markdown');
    v.dispatch({ selection: { anchor: 2, head: 6 } });
    expect(v.state.doc.toString()).toBe(DOC);
    expect(v.state.selection.main).toMatchObject({ anchor: 2, head: 6 });
  });

  it('keeps the dim class name and carries its own theme (opacity 0.38, set where the extension is built)', () => {
    const v = mount(true, 'markdown');
    expect(host.querySelector('.cm-md-dim')).not.toBeNull();
    // テーマは拡張に含まれる。オフなら、テーマも付かない（エディタの class の数が 1 つ減る）。
    const classes = (el: HTMLElement) => el.className.split(/\s+/).filter(Boolean).length;
    const withTheme = classes(v.dom);
    v.destroy();
    mount(false, 'markdown');
    expect(withTheme).toBe(classes((view as EditorView).dom) + 1);
  });
});
