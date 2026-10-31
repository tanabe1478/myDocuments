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
