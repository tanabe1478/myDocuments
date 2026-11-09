import { describe, expect, it } from 'vitest';
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
    // Mod+Alt+B は、サイドバーではなく右ペイン（R13）。サイドバーとしては動かない。
    expect(matchShortcut(key('b', { ctrlKey: true, altKey: true }), false)).toBe('rightPane');
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

  it('leaves the shortcuts of plugin commands (Mod+Shift+T, Mod+Shift+F) to the plugin registry', () => {
    for (const k of ['T', 'F']) {
      expect(matchShortcut(key(k, { metaKey: true, shiftKey: true }), true)).toBeNull();
      expect(matchShortcut(key(k, { ctrlKey: true, shiftKey: true }), false)).toBeNull();
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

describe('右ペインの開閉（ADR-005 の R13）: Option+Cmd+B / Ctrl+Alt+B', () => {
  const mac = (over: Partial<KeyLike> = {}): KeyLike => ({ ...key('b', { metaKey: true, altKey: true }), ...over });
  const win = (over: Partial<KeyLike> = {}): KeyLike => ({ ...key('b', { ctrlKey: true, altKey: true }), ...over });

  it('macOS: Option+Cmd+B（Option で e.key が別の文字になっても、物理キー KeyB で判定する）', () => {
    expect(matchShortcut(mac(), true)).toBe('rightPane');
    expect(matchShortcut(mac({ key: '∫' }), true)).toBe('rightPane');
    expect(matchShortcut(mac({ key: 'Dead' }), true)).toBe('rightPane');
    expect(matchShortcut(mac({ code: 'KeyN', key: 'n' }), true)).toBeNull();
  });

  it('Windows / Linux: Ctrl+Alt+B（論理キーが英字でない配列では物理キー）', () => {
    expect(matchShortcut(win(), false)).toBe('rightPane');
    expect(matchShortcut(win({ key: 'B' }), false)).toBe('rightPane');
    expect(matchShortcut(win({ key: 'Process' }), false)).toBe('rightPane');
  });

  it('Windows / Linux: AltGr による入力には合わない', () => {
    expect(matchShortcut(win({ getModifierState: (k: string) => k === 'AltGraph' }), false)).toBeNull();
    expect(matchShortcut(win({ key: 'ß', code: 'KeyB' }), false)).toBeNull();
  });

  it('Shift 付き、修飾キーが足りない・余る、OS が違う組み合わせは対象にしない', () => {
    expect(matchShortcut(mac({ shiftKey: true }), true)).toBeNull();
    expect(matchShortcut(win({ shiftKey: true }), false)).toBeNull();
    expect(matchShortcut(key('b', { metaKey: true }), true)).toBe('sidebar');
    expect(matchShortcut(key('b', { altKey: true }), true)).toBeNull();
    expect(matchShortcut(key('b', { altKey: true }), false)).toBeNull();
    expect(matchShortcut(mac({ ctrlKey: true }), true)).toBeNull();
    expect(matchShortcut(win({ metaKey: true }), false)).toBeNull();
    expect(matchShortcut(mac(), false)).toBeNull();
    expect(matchShortcut(win(), true)).toBeNull();
  });

  it('IME の変換中は対象にしない', () => {
    expect(matchShortcut(mac({ isComposing: true }), true)).toBeNull();
    expect(matchShortcut(mac({ keyCode: 229 }), true)).toBeNull();
    expect(matchShortcut(win({ isComposing: true }), false)).toBeNull();
    expect(matchShortcut(win({ keyCode: 229 }), false)).toBeNull();
  });

  it('今のショートカットは変わらない（Mod+B はサイドバー、Alt つきのほかの文字は対象外）', () => {
    expect(matchShortcut(key('b', { metaKey: true }), true)).toBe('sidebar');
    expect(matchShortcut(key('b', { ctrlKey: true }), false)).toBe('sidebar');
    expect(matchShortcut(key('c', { metaKey: true, altKey: true }), true)).toBeNull();
    expect(matchShortcut(key('c', { ctrlKey: true, altKey: true }), false)).toBeNull();
    expect(matchShortcut(key('f', { metaKey: true, ctrlKey: true }), true)).toBe('fullscreen');
    expect(matchShortcut(key('S', { metaKey: true, shiftKey: true }), true)).toBe('saveAs');
  });
});
