import { describe, expect, it } from 'vitest';
import { matchesShortcut, parseShortcut, type KeyEventLike } from './shortcut';

const key = (k: string, mods: Partial<KeyEventLike> = {}): KeyEventLike => ({
  key: k,
  code: `Key${k.toUpperCase()}`,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  ...mods,
});

describe('parseShortcut', () => {
  it('reads Mod+letter, Mod+Shift+letter and Mod+comma, and normalizes the text', () => {
    expect(parseShortcut('Mod+t')).toEqual({ key: 't', shift: false, text: 'Mod+T' });
    expect(parseShortcut('Mod+Shift+T')).toEqual({ key: 't', shift: true, text: 'Mod+Shift+T' });
    expect(parseShortcut('Shift+Mod+T').text).toBe('Mod+Shift+T');
    expect(parseShortcut('Mod+,')).toEqual({ key: ',', shift: false, text: 'Mod+,' });
  });

  it('rejects anything else', () => {
    for (const bad of ['', 'T', 'Shift+T', 'Mod+', 'Mod+Alt+T', 'Mod+Mod+T', 'Mod+Shift+Shift+T', 'Ctrl+T', 'Mod+1', 'Mod+TT', 'Mod+F11', 'mod+t']) {
      expect(() => parseShortcut(bad), bad).toThrow(/invalid shortcut/);
    }
  });
});

describe('matchesShortcut', () => {
  const t = parseShortcut('Mod+Shift+T');

  it('uses Cmd on macOS and Ctrl elsewhere, and ignores the other one', () => {
    expect(matchesShortcut(t, key('T', { metaKey: true, shiftKey: true }), true)).toBe(true);
    expect(matchesShortcut(t, key('T', { ctrlKey: true, shiftKey: true }), false)).toBe(true);
    expect(matchesShortcut(t, key('T', { ctrlKey: true, shiftKey: true }), true)).toBe(false);
    expect(matchesShortcut(t, key('T', { metaKey: true, shiftKey: true }), false)).toBe(false);
    expect(matchesShortcut(t, key('T', { metaKey: true, ctrlKey: true, shiftKey: true }), true)).toBe(false);
  });

  it('needs the Shift state to match, and rejects Alt', () => {
    expect(matchesShortcut(t, key('t', { ctrlKey: true }), false)).toBe(false);
    expect(matchesShortcut(parseShortcut('Mod+T'), key('t', { ctrlKey: true, shiftKey: true }), false)).toBe(false);
    expect(matchesShortcut(parseShortcut('Mod+T'), key('t', { ctrlKey: true }), false)).toBe(true);
    expect(matchesShortcut(t, key('T', { ctrlKey: true, shiftKey: true, altKey: true }), false)).toBe(false);
  });

  it('falls back to the physical key when the logical key is not a Latin letter', () => {
    expect(matchesShortcut(t, { ...key('T', { ctrlKey: true, shiftKey: true }), key: 'ｔ' }, false)).toBe(true);
    expect(matchesShortcut(t, { ...key('T', { ctrlKey: true, shiftKey: true }), key: 'Process', code: 'KeyT' }, false)).toBe(true);
    // 論理キーが英字なら、物理キーより優先する。
    expect(matchesShortcut(t, { ...key('x', { ctrlKey: true, shiftKey: true }), code: 'KeyT' }, false)).toBe(false);
  });

  it('ignores keys during IME composition', () => {
    expect(matchesShortcut(t, key('T', { ctrlKey: true, shiftKey: true, isComposing: true }), false)).toBe(false);
    expect(matchesShortcut(t, key('T', { ctrlKey: true, shiftKey: true, keyCode: 229 }), false)).toBe(false);
  });

  it('matches Mod+comma by the logical or the physical key', () => {
    const comma = parseShortcut('Mod+,');
    expect(matchesShortcut(comma, { ...key(',', { ctrlKey: true }), code: 'Comma' }, false)).toBe(true);
    expect(matchesShortcut(comma, { ...key('、', { ctrlKey: true }), code: 'Comma' }, false)).toBe(true);
    expect(matchesShortcut(comma, { ...key(',', { ctrlKey: true, shiftKey: true }), code: 'Comma' }, false)).toBe(false);
  });
});
