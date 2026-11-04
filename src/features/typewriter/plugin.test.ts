// @vitest-environment jsdom
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPluginRegistry, ownsCaretScroll, skipCaretFollow, type CommandContext } from '../../plugin-api';
import { TYPEWRITER_SETTING_KEY, typewriterPlugin } from '.';
import { typewriterModeExtension } from './typewriterMode';

const ENV = { textKind: 'markdown', openExternalUrl: () => {}, isMacPlatform: () => false } as const;

// jsdom には、CodeMirror が測定に使う矩形取得 API がなく、要素の高さも 0。
beforeAll(() => {
  const rect = { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON: () => ({}) };
  const rects = Object.assign([], { item: () => null });
  Range.prototype.getClientRects = () => rects as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect = () => rect as DOMRect;
  Element.prototype.getClientRects = () => rects as unknown as DOMRectList;
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 500 });
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

const registry = () => createPluginRegistry([typewriterPlugin]);

describe('typewriter plugin registration', () => {
  it('declares itself for the current API as an editor-tier plugin', () => {
    expect(registry().records).toEqual([{ id: 'typewriter', name: 'タイプライターモード', version: '1.0.0', status: 'active', reason: null }]);
  });

  it('registers the setting under the same key, as a boolean that is false by default', () => {
    const [setting] = registry().settings;
    expect(setting).toMatchObject({ key: 'typewriterMode', defaultValue: false });
    expect(TYPEWRITER_SETTING_KEY).toBe('typewriterMode');
    expect(setting?.normalize(true)).toBe(true);
    expect(setting?.normalize(false)).toBe(false);
    for (const bad of [undefined, null, 1, 0, 'true', [], {}]) expect(setting?.normalize(bad), String(bad)).toBe(false);
  });

  it('registers the toggle command: Mod+Shift+T, ignored in text entry fields', () => {
    const [command] = registry().commands;
    expect(command).toMatchObject({ id: 'typewriter.toggle', ignoreInTextEntry: true });
    expect(command?.shortcut?.text).toBe('Mod+Shift+T');
    const key = (mods: object) => ({ key: 'T', code: 'KeyT', metaKey: false, ctrlKey: false, altKey: false, shiftKey: true, ...mods });
    const r = registry();
    expect(r.findCommandByKey(key({ metaKey: true }), true)?.id).toBe('typewriter.toggle');
    expect(r.findCommandByKey(key({ ctrlKey: true }), false)?.id).toBe('typewriter.toggle');
    expect(r.findCommandByKey(key({ ctrlKey: true, shiftKey: false }), false)).toBeNull();
    expect(r.findCommandByKey({ ...key({ ctrlKey: true }), key: 'F', code: 'KeyF' }, false)).toBeNull();
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

  it('puts a checkbox in the writing aids section, between focus mode (100) and auto-hide (300)', () => {
    expect(registry().settingsItems('appearance.writingAids')).toEqual([
      { pluginId: 'typewriter', placement: 'appearance.writingAids', order: 200, kind: 'checkbox', settingKey: 'typewriterMode', label: 'タイプライターモード' },
    ]);
  });

  it('builds the extension from the setting value: nothing when off', () => {
    const [ext] = registry().editorExtensions;
    expect(ext).toMatchObject({ pluginId: 'typewriter', settingKey: 'typewriterMode', defaultValue: false });
    expect(ext?.create(false, ENV)).toEqual([]);
    expect(ext?.create(true, ENV)).not.toEqual([]);
  });
});

describe('typewriter extension', () => {
  function mount(on: boolean): EditorView {
    const [ext] = registry().editorExtensions;
    view = new EditorView({
      parent: host,
      state: EditorState.create({ doc: 'a\n\nb\n\nc', extensions: ext?.create(on, ENV) }),
    });
    return view;
  }

  it('keeps the DOM contract: class cm-typewriter on the editor and the CSS variable --md-typewriter-pad (half the viewport)', () => {
    const v = mount(true);
    expect(v.dom.classList.contains('cm-typewriter')).toBe(true);
    expect(v.dom.style.getPropertyValue('--md-typewriter-pad')).toBe('250px');
    v.destroy();
    expect(v.dom.style.getPropertyValue('--md-typewriter-pad')).toBe('');
    view = null;
  });

  it('adds nothing to the DOM when off', () => {
    const v = mount(false);
    expect(v.dom.classList.contains('cm-typewriter')).toBe(false);
    expect(v.dom.style.getPropertyValue('--md-typewriter-pad')).toBe('');
  });

  it('declares that it owns the caret scroll (the shared convention), only while on', () => {
    expect(EditorState.create({ extensions: typewriterModeExtension() }).facet(ownsCaretScroll)).toBe(true);
    expect(EditorState.create({ extensions: [] }).facet(ownsCaretScroll)).toBe(false);
  });

  it('styles the padding with its own theme, using the same selector and variable as before', () => {
    mount(true);
    const css = Array.from(document.querySelectorAll('style'), (s) => s.textContent ?? '').join('\n');
    expect(css).toMatch(/\.cm-typewriter \.cm-content/);
    expect(css).toContain('var(--md-typewriter-pad, 50vh)');
  });

  describe('follows the caret, except for pointer selections and changes marked with skipCaretFollow', () => {
    function spy(): { count: () => number; v: EditorView } {
      const v = mount(true);
      const requestMeasure = vi.spyOn(v, 'requestMeasure');
      // CodeMirror 自身も引数なしで requestMeasure を呼ぶ。この部品の呼び出しは、測定の定義（read / write）を渡す。
      return { v, count: () => requestMeasure.mock.calls.filter(([request]) => request !== undefined).length };
    }

    it('re-centers on a caret move', () => {
      const { v, count } = spy();
      v.dispatch({ selection: { anchor: 3 } });
      expect(count()).toBeGreaterThan(0);
    });

    it('re-centers on a typed change', () => {
      const { v, count } = spy();
      v.dispatch({ changes: { from: 0, insert: 'x' }, userEvent: 'input.type' });
      expect(count()).toBeGreaterThan(0);
    });

    it('does not re-center on a pointer selection', () => {
      const { v, count } = spy();
      v.dispatch({ selection: { anchor: 3 }, userEvent: 'select.pointer' });
      expect(count()).toBe(0);
    });

    it('does not re-center on a change that carries the skipCaretFollow annotation, and does after it', () => {
      const { v, count } = spy();
      v.dispatch({ changes: { from: 0, to: 1, insert: 'z' }, annotations: skipCaretFollow.of(true) });
      expect(count()).toBe(0);
      v.dispatch({ changes: { from: 0, insert: 'y' } });
      expect(count()).toBeGreaterThan(0);
    });

    it('does not depend on the userEvent of the toggle (the annotation is the contract)', () => {
      const { v, count } = spy();
      v.dispatch({ changes: { from: 0, to: 1, insert: 'z' }, userEvent: 'input.toggle-task' });
      expect(count()).toBeGreaterThan(0);
    });
  });
});
