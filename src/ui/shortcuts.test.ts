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
  it('Mod+, opens the appearance panel (Cmd on macOS, Ctrl elsewhere)', () => {
    expect(matchShortcut({ ...key(',', { metaKey: true }), code: 'Comma' }, true)).toBe('appearance');
    expect(matchShortcut({ ...key(',', { ctrlKey: true }), code: 'Comma' }, false)).toBe('appearance');
    expect(matchShortcut({ ...key(',', { ctrlKey: true }), code: 'Comma' }, true)).toBeNull();
    expect(matchShortcut({ ...key(',', { metaKey: true }), code: 'Comma' }, false)).toBeNull();
    expect(matchShortcut({ ...key(',', { ctrlKey: true, shiftKey: true }), code: 'Comma' }, false)).toBeNull();
  });

  it('focus mode is Mod+Shift+F and typewriter mode is Mod+Shift+T', () => {
    expect(matchShortcut(key('F', { metaKey: true, shiftKey: true }), true)).toBe('focusMode');
    expect(matchShortcut(key('F', { ctrlKey: true, shiftKey: true }), false)).toBe('focusMode');
    expect(matchShortcut(key('T', { metaKey: true, shiftKey: true }), true)).toBe('typewriterMode');
    expect(matchShortcut(key('T', { ctrlKey: true, shiftKey: true }), false)).toBe('typewriterMode');
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
