// @vitest-environment jsdom
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { ensureSyntaxTree } from '@codemirror/language';
import { EditorState } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPluginRegistry, type TextKind } from '../../plugin-api';
import { LIST_CONTINUATION_SETTING_KEY, listContinuationPlugin } from '.';

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

const registry = () => createPluginRegistry([listContinuationPlugin]);
const ENV = (textKind: TextKind = 'markdown') => ({ textKind, openExternalUrl: () => {}, isMacPlatform: () => false });

describe('list continuation plugin registration', () => {
  it('declares itself for the current API as an editor-tier plugin', () => {
    expect(registry().records).toEqual([{ id: 'list-continuation', name: 'リストの継続', version: '1.0.0', status: 'active', reason: null }]);
  });

  it('registers the setting under the same key as before, as a string that is "tight" by default', () => {
    const [setting] = registry().settings;
    expect(setting).toMatchObject({ key: 'listContinuation', defaultValue: 'tight' });
    expect(LIST_CONTINUATION_SETTING_KEY).toBe('listContinuation');
  });

  it('reads the two valid values, and any other value (wrong case, other types, empty) as the default', () => {
    const [setting] = registry().settings;
    expect(setting?.normalize('tight')).toBe('tight');
    expect(setting?.normalize('preserve')).toBe('preserve');
    for (const bad of ['loose', '', 'Preserve', 'TIGHT', ' tight', 1, 0, true, false, null, undefined, ['preserve'], { value: 'preserve' }]) {
      expect(setting?.normalize(bad), String(bad)).toBe('tight');
    }
  });

  it('puts a radio item in the editing section, with the same legend, choices (values and labels), and hint as before', () => {
    expect(registry().settingsItems('editing.body')).toEqual([
      {
        pluginId: 'list-continuation',
        placement: 'editing.body',
        order: 100,
        kind: 'radio',
        settingKey: 'listContinuation',
        name: 'list-continuation',
        legend: 'リストの継続',
        options: [
          { value: 'tight', label: '空行を入れない' },
          { value: 'preserve', label: 'リストの形に合わせる' },
        ],
        hint: '空行で区切ったリストで Enter を押したとき、次の項目の前にも空行を入れるか',
      },
    ]);
    expect(registry().settingsItems('appearance.writingAids')).toEqual([]);
  });

  it('registers no command (no shortcut is taken)', () => {
    expect(registry().commands).toEqual([]);
  });

  it('does not depend on the document kind (the extension is not rebuilt when the kind changes)', () => {
    const [ext] = registry().editorExtensions;
    expect(ext).toMatchObject({ pluginId: 'list-continuation', settingKey: 'listContinuation', defaultValue: 'tight', dependsOnTextKind: false });
  });
});

describe('list continuation extension', () => {
  const LOOSE = '- a\n\n- b';

  function mount(value: 'tight' | 'preserve', doc = LOOSE, kind: TextKind = 'markdown'): EditorView {
    const [ext] = registry().editorExtensions;
    view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc,
        selection: { anchor: doc.length },
        // ホストでは、本体の記法の拡張（lang-markdown）が先に入っている。
        extensions: [kind === 'markdown' ? markdown({ base: markdownLanguage }) : [], ext?.create(value, ENV(kind)) ?? []],
      }),
    });
    ensureSyntaxTree(view.state, view.state.doc.length, 10_000);
    view.dispatch({});
    return view;
  }

  const pressEnter = (v: EditorView) =>
    v.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true, cancelable: true }));

  const enterBindings = (v: EditorView) =>
    v.state
      .facet(keymap)
      .flat()
      .filter((b) => b.key === 'Enter')
      .map((b) => b.run?.name ?? '');

  it('tight: adds a highest-priority Enter binding that goes before the one of lang-markdown', () => {
    const v = mount('tight');
    const names = enterBindings(v);
    expect(names[0]).toBe('insertNewlineContinueTight');
    expect(names).toHaveLength(2); // 自分の割り当てと、lang-markdown の Enter（この state には defaultKeymap がない）
  });

  it('preserve: adds nothing, so only the Enter binding of lang-markdown is left', () => {
    const v = mount('preserve');
    expect(enterBindings(v)).toEqual(['']);
    expect(registry().editorExtensions[0]?.create('preserve', ENV())).toEqual([]);
  });

  it('tight does not add a blank line to a loose list; preserve does', () => {
    pressEnter(mount('tight'));
    expect(view?.state.doc.toString()).toBe('- a\n\n- b\n- ');
    view?.destroy();
    pressEnter(mount('preserve'));
    expect(view?.state.doc.toString()).toBe('- a\n\n- b\n\n- ');
  });

  it('stays out of the way outside Markdown (plain text keeps the default Enter)', () => {
    const v = mount('tight', LOOSE, 'plain');
    // 言語がないので、継続の対象にならず、次のキー割り当て（この state にはない）に回る。
    expect(enterBindings(v)).toEqual(['insertNewlineContinueTight']);
    const handled = v.state.facet(keymap).flat().find((b) => b.key === 'Enter')?.run?.(v);
    expect(handled).toBe(false);
    expect(v.state.doc.toString()).toBe(LOOSE);
  });

  it('is a valid extension for the host (the registry builds a state with it and keeps the plugin active)', () => {
    const r = registry();
    r.editorExtensions[0]?.create('tight', ENV());
    r.editorExtensions[0]?.create('preserve', ENV());
    expect(r.records[0]?.status).toBe('active');
  });
});
