import { describe, expect, it } from 'vitest';
import { matchesShortcut, parseShortcut } from '../plugin-api';
import { matchShortcut, type KeyLike } from './shortcuts';

const key = (k: string, mods: Partial<KeyLike> = {}): KeyLike => ({
  key: k,
  code: `Key${k.toUpperCase()}`,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  ...mods,
});

describe('matchShortcut', () => {
  it('macOS uses Cmd', () => {
    expect(matchShortcut(key('n', { metaKey: true }), true)).toBe('new');
    expect(matchShortcut(key('o', { metaKey: true }), true)).toBe('open');
    expect(matchShortcut(key('s', { metaKey: true }), true)).toBe('save');
    expect(matchShortcut(key('S', { metaKey: true, shiftKey: true }), true)).toBe('saveAs');
  });

  it('macOS ignores Ctrl', () => {
    expect(matchShortcut(key('s', { ctrlKey: true }), true)).toBeNull();
  });

  it('other platforms use Ctrl and ignore Meta', () => {
    expect(matchShortcut(key('s', { ctrlKey: true }), false)).toBe('save');
    expect(matchShortcut(key('S', { ctrlKey: true, shiftKey: true }), false)).toBe('saveAs');
    expect(matchShortcut(key('s', { metaKey: true }), false)).toBeNull();
  });

  it('requires the modifier, and rejects Alt and other keys', () => {
    expect(matchShortcut(key('s'), false)).toBeNull();
    expect(matchShortcut(key('s', { ctrlKey: true, altKey: true }), false)).toBeNull();
    expect(matchShortcut(key('z', { ctrlKey: true }), false)).toBeNull();
    expect(matchShortcut(key('N', { ctrlKey: true, shiftKey: true }), false)).toBeNull();
  });

  it('ignores keys during IME composition', () => {
    expect(matchShortcut(key('s', { ctrlKey: true, isComposing: true }), false)).toBeNull();
    expect(matchShortcut(key('s', { ctrlKey: true, keyCode: 229 }), false)).toBeNull();
  });

  it('falls back to the physical key when the logical key is not a Latin letter', () => {
    expect(matchShortcut({ ...key('s', { ctrlKey: true }), key: 'ｓ' }, false)).toBe('save');
    expect(matchShortcut({ ...key('s', { ctrlKey: true }), key: 'Process' }, false)).toBe('save');
  });
});

describe('writing canvas shortcuts', () => {
  it('Mod+, opens the settings dialog (Cmd on macOS, Ctrl elsewhere)', () => {
    expect(matchShortcut({ ...key(',', { metaKey: true }), code: 'Comma' }, true)).toBe('settings');
    expect(matchShortcut({ ...key(',', { ctrlKey: true }), code: 'Comma' }, false)).toBe('settings');
    expect(matchShortcut({ ...key(',', { ctrlKey: true }), code: 'Comma' }, true)).toBeNull();
    expect(matchShortcut({ ...key(',', { metaKey: true }), code: 'Comma' }, false)).toBeNull();
    expect(matchShortcut({ ...key(',', { ctrlKey: true, shiftKey: true }), code: 'Comma' }, false)).toBeNull();
  });

  it('Mod+B toggles the sidebar (Cmd on macOS, Ctrl elsewhere)', () => {
    expect(matchShortcut(key('b', { metaKey: true }), true)).toBe('sidebar');
    expect(matchShortcut(key('B', { metaKey: true }), true)).toBe('sidebar');
    expect(matchShortcut(key('b', { ctrlKey: true }), false)).toBe('sidebar');
    expect(matchShortcut(key('b', { ctrlKey: true }), true)).toBeNull();
    expect(matchShortcut(key('b', { metaKey: true }), false)).toBeNull();
  });

  it('Mod+B needs the modifier alone: not plain B, not with Shift or Alt', () => {
    expect(matchShortcut(key('b'), false)).toBeNull();
    expect(matchShortcut(key('B', { ctrlKey: true, shiftKey: true }), false)).toBeNull();
    expect(matchShortcut(key('b', { ctrlKey: true, altKey: true }), false)).toBeNull();
    expect(matchShortcut(key('b', { metaKey: true, ctrlKey: true }), true)).toBeNull();
  });

  it('Mod+B falls back to the physical key when the logical key is not a Latin letter', () => {
    expect(matchShortcut({ ...key('b', { ctrlKey: true }), key: 'ｂ' }, false)).toBe('sidebar');
  });

  it('Mod+B and Mod+, are ignored during IME composition', () => {
    expect(matchShortcut(key('b', { ctrlKey: true, isComposing: true }), false)).toBeNull();
    expect(matchShortcut(key('b', { ctrlKey: true, keyCode: 229 }), false)).toBeNull();
    expect(matchShortcut({ ...key(',', { ctrlKey: true, isComposing: true }), code: 'Comma' }, false)).toBeNull();
    expect(matchShortcut({ ...key(',', { ctrlKey: true, keyCode: 229 }), code: 'Comma' }, false)).toBeNull();
  });

  it('focus mode is Mod+Shift+F', () => {
    expect(matchShortcut(key('F', { metaKey: true, shiftKey: true }), true)).toBe('focusMode');
    expect(matchShortcut(key('F', { ctrlKey: true, shiftKey: true }), false)).toBe('focusMode');
  });

  it('leaves the shortcuts of plugin commands (Mod+Shift+T) to the plugin registry', () => {
    expect(matchShortcut(key('T', { metaKey: true, shiftKey: true }), true)).toBeNull();
    expect(matchShortcut(key('T', { ctrlKey: true, shiftKey: true }), false)).toBeNull();
  });

  it('plugin shortcuts are matched by the same rules as the fixed ones (Mod+Shift+F as the common case)', () => {
    const focus = parseShortcut('Mod+Shift+F');
    const events: Array<[KeyLike, boolean]> = [];
    for (const mac of [true, false]) {
      for (const k of ['F', 'f', 'ｆ', 'a']) {
        for (const m of [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]) {
          events.push([
            {
              ...key(k),
              code: k === 'ｆ' ? 'KeyF' : `Key${k.toUpperCase()}`,
              metaKey: (m & 1) !== 0,
              ctrlKey: (m & 2) !== 0,
              altKey: (m & 4) !== 0,
              shiftKey: (m & 8) !== 0,
            },
            mac,
          ]);
        }
      }
      events.push([key('F', { metaKey: true, shiftKey: true, isComposing: true }), mac]);
      events.push([key('F', { ctrlKey: true, shiftKey: true, keyCode: 229 }), mac]);
    }
    for (const [e, mac] of events) {
      expect(matchesShortcut(focus, e, mac), JSON.stringify([e, mac])).toBe(matchShortcut(e, mac) === 'focusMode');
    }
  });

  it('leaves Mod+F (search) and Mod+T alone', () => {
    expect(matchShortcut(key('f', { metaKey: true }), true)).toBeNull();
    expect(matchShortcut(key('f', { ctrlKey: true }), false)).toBeNull();
    expect(matchShortcut(key('t', { ctrlKey: true }), false)).toBeNull();
  });

  it('fullscreen is Ctrl+Cmd+F on macOS only', () => {
    expect(matchShortcut(key('f', { metaKey: true, ctrlKey: true }), true)).toBe('fullscreen');
    expect(matchShortcut(key('F', { metaKey: true, ctrlKey: true, shiftKey: true }), true)).toBeNull();
    expect(matchShortcut(key('F11'), true)).toBeNull();
    expect(matchShortcut(key('f', { metaKey: true, ctrlKey: true }), false)).toBeNull();
  });

  it('fullscreen is F11 on Windows and Linux only, without modifiers', () => {
    expect(matchShortcut({ ...key('F11'), code: 'F11' }, false)).toBe('fullscreen');
    expect(matchShortcut(key('F11', { ctrlKey: true }), false)).toBeNull();
    expect(matchShortcut(key('F11', { shiftKey: true }), false)).toBeNull();
    expect(matchShortcut(key('F11', { altKey: true }), false)).toBeNull();
  });

  it('ignores the new shortcuts during IME composition', () => {
    expect(matchShortcut(key('F', { ctrlKey: true, shiftKey: true, isComposing: true }), false)).toBeNull();
    expect(matchShortcut({ ...key('F11'), keyCode: 229 }, false)).toBeNull();
  });
});
