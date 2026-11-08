// @vitest-environment jsdom
import { EditorState, Prec, type Extension } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPluginRegistry, type CommandContext } from '../../plugin-api';
import { TYPING_SOUND_SETTING_KEY, TYPING_SOUND_VOLUME_SETTING_KEY, typingSoundPlugin } from '.';
import { typingSoundExtension, volumeFacet } from './extension';
import type { TypingSoundPlayer, TypingSoundVolume } from './player';
import { SOUND_URLS } from './sounds';

const ENV = { textKind: 'markdown', openExternalUrl: () => {}, isMacPlatform: () => false } as const;
const registry = () => createPluginRegistry([typingSoundPlugin]);

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
  vi.unstubAllGlobals();
});

describe('typing-sound plugin registration', () => {
  it('declares itself for the current API as an editor-tier plugin', () => {
    expect(registry().records).toEqual([{ id: 'typing-sound', name: 'タイピング音', version: '1.0.0', status: 'active', reason: null }]);
  });

  it('registers typingSound (boolean, off by default) and typingSoundVolume (low | medium | high, medium by default)', () => {
    const settings = registry().settings;
    expect(settings.map((s) => s.key)).toEqual(['typingSound', 'typingSoundVolume']);
    expect(TYPING_SOUND_SETTING_KEY).toBe('typingSound');
    expect(TYPING_SOUND_VOLUME_SETTING_KEY).toBe('typingSoundVolume');
    const [on, volume] = settings;
    expect(on).toMatchObject({ key: 'typingSound', defaultValue: false });
    expect(on?.normalize(true)).toBe(true);
    for (const bad of [undefined, null, 1, 'true', [], {}]) expect(on?.normalize(bad), String(bad)).toBe(false);
    expect(volume).toMatchObject({ key: 'typingSoundVolume', defaultValue: 'medium' });
    for (const ok of ['low', 'medium', 'high']) expect(volume?.normalize(ok)).toBe(ok);
    for (const bad of [undefined, null, 1, 'loud', 'LOW', '', true, {}]) expect(volume?.normalize(bad), String(bad)).toBe('medium');
  });

  it('puts the checkbox in the writing aids section after the host auto-hide item (order 400)', () => {
    expect(registry().settingsItems('appearance.writingAids')).toEqual([
      { pluginId: 'typing-sound', placement: 'appearance.writingAids', order: 400, kind: 'checkbox', settingKey: 'typingSound', label: 'タイピング音' },
    ]);
  });

  it('puts the volume radio (小・中・大) in the new sound section', () => {
    const [item] = registry().settingsItems('sound.body');
    expect(item).toMatchObject({
      pluginId: 'typing-sound',
      placement: 'sound.body',
      kind: 'radio',
      settingKey: 'typingSoundVolume',
      name: 'typing-sound-volume',
      options: [
        { value: 'low', label: '小' },
        { value: 'medium', label: '中' },
        { value: 'high', label: '大' },
      ],
    });
    expect(registry().settingsItems('sound.body')).toHaveLength(1);
  });

  it('registers the toggle command without a shortcut', () => {
    const [command] = registry().commands;
    expect(command).toMatchObject({ id: 'typing-sound.toggle', title: 'タイピング音の切り替え', shortcut: null });
    let value = false;
    const ctx: CommandContext = {
      settings: {
        get: <T,>() => value as T,
        update: <T,>(_setting: unknown, next: (current: T) => T) => {
          value = next(value as T) as boolean;
        },
      },
    };
    command?.run(ctx);
    expect(value).toBe(true);
    command?.run(ctx);
    expect(value).toBe(false);
    expect(registry().commands).toHaveLength(1);
  });

  it('no keyboard event matches a command of this plugin (no shortcut)', () => {
    const r = registry();
    for (const mods of [{}, { ctrlKey: true }, { metaKey: true, shiftKey: true }]) {
      expect(r.findCommandByKey({ key: 't', code: 'KeyT', metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...mods }, false)).toBeNull();
    }
  });

  it('has 10 sound URLs, all different', () => {
    expect(SOUND_URLS).toHaveLength(10);
    expect(new Set(SOUND_URLS).size).toBe(10);
    for (const url of SOUND_URLS) expect(url).toMatch(/keypress-\d{3}.*\.wav$/);
  });
});

/** 記録するだけの player。 */
function spyPlayer() {
  const calls: Array<{ key: string; volume: TypingSoundVolume; prevented: boolean }> = [];
  const player: TypingSoundPlayer = {
    prepare: vi.fn(),
    handleKeyDown: vi.fn((e, volume) => {
      calls.push({ key: e.key, volume, prevented: (e as KeyboardEvent).defaultPrevented });
    }),
    dispose: vi.fn(),
  };
  return { player, calls };
}

function mount(extensions: Extension, doc = 'hello'): EditorView {
  view = new EditorView({ parent: host, state: EditorState.create({ doc, extensions }) });
  return view;
}

const press = (target: Element, key: string, init: KeyboardEventInit = {}) => {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
};

describe('the extension observes keydown in the body only', () => {
  it('calls the player once per keydown, with the volume of the state (medium by default), and starts loading at construction', () => {
    const { player, calls } = spyPlayer();
    const v = mount(typingSoundExtension(player));
    expect(player.prepare).toHaveBeenCalledTimes(1);
    press(v.contentDOM, 'a');
    press(v.contentDOM, 'Enter');
    expect(calls.map((c) => [c.key, c.volume])).toEqual([
      ['a', 'medium'],
      ['Enter', 'medium'],
    ]);
  });

  it('passes the volume from the volume extension, and follows a change (reconfigure) on the next key', () => {
    const { player, calls } = spyPlayer();
    const v = mount([typingSoundExtension(player), volumeFacet.of('low')]);
    press(v.contentDOM, 'a');
    v.setState(EditorState.create({ doc: 'x', extensions: [typingSoundExtension(player), volumeFacet.of('high')] }));
    press(v.contentDOM, 'b');
    expect(calls.map((c) => [c.key, c.volume])).toEqual([
      ['a', 'low'],
      ['b', 'high'],
    ]);
  });

  it('only observes: does not preventDefault or stop the event, and the editor still gets it (an input handler after us still runs)', () => {
    const { player, calls } = spyPlayer();
    const later = vi.fn(() => false);
    const v = mount([typingSoundExtension(player), EditorView.domEventHandlers({ keydown: later })]);
    const event = press(v.contentDOM, 'a');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.prevented).toBe(false);
    expect(event.defaultPrevented).toBe(false);
    expect(later).toHaveBeenCalledTimes(1);
  });

  it('still sounds when another handler takes the key first (a highest-precedence Enter like list continuation)', () => {
    const { player, calls } = spyPlayer();
    const handled = vi.fn(() => true);
    const v = mount([
      typingSoundExtension(player),
      Prec.highest(keymap.of([{ key: 'Enter', run: handled }])),
    ]);
    const event = press(v.contentDOM, 'Enter');
    expect(handled).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true); // 止めたのは keymap。この拡張ではない。
    expect(calls.map((c) => c.key)).toEqual(['Enter']);
    expect(calls[0]?.prevented).toBe(false); // 呼ばれた時点では、まだ止められていない。
  });

  it('does not count keys outside the body (the editor frame, other inputs)', () => {
    const { player, calls } = spyPlayer();
    const v = mount(typingSoundExtension(player));
    const input = document.createElement('input');
    v.dom.append(input);
    press(input, 'a');
    press(v.dom, 'a');
    press(document.body, 'a');
    expect(calls).toEqual([]);
  });

  it('removes the listener when the extension goes away (setting turned off) or the view is destroyed', () => {
    const { player, calls } = spyPlayer();
    const v = mount(typingSoundExtension(player));
    v.setState(EditorState.create({ doc: 'x', extensions: [] }));
    press(v.contentDOM, 'a');
    expect(calls).toEqual([]);

    const second = spyPlayer();
    const v2 = new EditorView({ parent: host, state: EditorState.create({ doc: 'y', extensions: typingSoundExtension(second.player) }) });
    const dom = v2.dom;
    const content = v2.contentDOM;
    v2.destroy();
    dom.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }));
    content.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }));
    expect(second.calls).toEqual([]);
  });

  it('an exception from the player (or prepare) does not escape into the editor', () => {
    const player: TypingSoundPlayer = {
      prepare: () => {
        throw new Error('prepare');
      },
      handleKeyDown: () => {
        throw new Error('handle');
      },
      dispose: () => {},
    };
    const v = mount(typingSoundExtension(player));
    expect(() => press(v.contentDOM, 'a')).not.toThrow();
    expect(v.state.doc.toString()).toBe('hello');
  });

  it('typing still changes the document as usual (IME composition events are untouched)', () => {
    const { player } = spyPlayer();
    const v = mount(typingSoundExtension(player), '');
    press(v.contentDOM, 'Process', { keyCode: 229 });
    v.dispatch({ changes: { from: 0, insert: 'あ' } });
    expect(v.state.doc.toString()).toBe('あ');
  });
});

describe('from the plugin: off means no fetch and no AudioContext', () => {
  function stubAudio() {
    const created: Array<{ close: ReturnType<typeof vi.fn> }> = [];
    class FakeAudioContext {
      state = 'running';
      destination = {};
      close = vi.fn(async () => {
        this.state = 'closed';
      });
      resume = vi.fn(async () => {});
      decodeAudioData = vi.fn(async () => ({ duration: 0.25 }));
      createGain = () => ({ gain: { value: 1 }, connect() {}, disconnect() {} });
      createBufferSource = () => ({ buffer: null, playbackRate: { value: 1 }, onended: null, connect() {}, disconnect() {}, start() {} });
      constructor() {
        created.push(this);
      }
    }
    const fetchMock = vi.fn(async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(100) }));
    vi.stubGlobal('AudioContext', FakeAudioContext);
    vi.stubGlobal('fetch', fetchMock);
    return { created, fetchMock };
  }

  const extensionFor = (r: ReturnType<typeof registry>, on: boolean) => r.editorExtensions.find((e) => e.settingKey === 'typingSound')?.create(on, ENV);

  it('with the setting off (the default): the extension is empty; keys fetch nothing and create nothing', () => {
    const { created, fetchMock } = stubAudio();
    const r = registry();
    const ext = extensionFor(r, false);
    expect(ext).toEqual([]);
    const v = mount(ext!);
    for (const k of ['a', 'Enter', ' ', 'Backspace']) press(v.contentDOM, k);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(created).toEqual([]);
    r.dispose();
  });

  it('with the setting on: fetches the 10 files at once, and creates the AudioContext at the first sounding key only', async () => {
    const { created, fetchMock } = stubAudio();
    const r = registry();
    const v = mount(extensionFor(r, true)!);
    expect(fetchMock).toHaveBeenCalledTimes(10);
    expect(created).toHaveLength(0);
    press(v.contentDOM, 'Shift');
    press(v.contentDOM, 'ArrowLeft');
    expect(created).toHaveLength(0);
    press(v.contentDOM, 'a');
    expect(created).toHaveLength(1);
    press(v.contentDOM, 'b');
    expect(created).toHaveLength(1);
    r.dispose();
  });

  it('turning it off again does not fetch more, and removing the plugin closes the AudioContext', async () => {
    const { created, fetchMock } = stubAudio();
    const r = registry();
    const v = mount(extensionFor(r, true)!);
    press(v.contentDOM, 'a');
    await new Promise((resolve) => setTimeout(resolve, 0));
    v.setState(EditorState.create({ doc: '', extensions: extensionFor(r, false)! }));
    press(v.contentDOM, 'a');
    expect(fetchMock).toHaveBeenCalledTimes(10);
    expect(created).toHaveLength(1);
    expect(created[0]?.close).not.toHaveBeenCalled();
    r.dispose();
    expect(created[0]?.close).toHaveBeenCalledTimes(1);
  });

  it('without AudioContext in the browser (or when fetch fails), keys still do nothing and throw nothing', async () => {
    vi.stubGlobal('AudioContext', undefined);
    vi.stubGlobal('webkitAudioContext', undefined);
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new Error('offline'))));
    const r = registry();
    const v = mount(extensionFor(r, true)!);
    expect(() => press(v.contentDOM, 'a')).not.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(() => press(v.contentDOM, 'a')).not.toThrow();
    expect(v.state.doc.toString()).toBe('hello');
    r.dispose();
  });
});
