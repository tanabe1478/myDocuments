import { describe, expect, it } from 'vitest';
import { soundKindOf, type KeyEventLike } from './keys';

const ev = (key: string, patch: Partial<KeyEventLike> = {}): KeyEventLike => ({
  key,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  ...patch,
});

/** meta、ctrl、alt、shift の 16 通りの組み合わせ。 */
const COMBOS = Array.from({ length: 16 }, (_, i) => ({ metaKey: !!(i & 1), ctrlKey: !!(i & 2), altKey: !!(i & 4), shiftKey: !!(i & 8) }));
const label = (m: object) =>
  Object.entries(m)
    .filter(([, v]) => v)
    .map(([k]) => k.replace('Key', ''))
    .join('+') || 'none';

describe('keys that sound', () => {
  it.each(['a', 'Z', '1', '。', 'あ', '/', ' ', '😀'])('character %j sounds as a normal key', (key) => {
    expect(soundKindOf(ev(key))).toBe('key');
  });

  it.each(['Backspace', 'Delete', 'Tab'])('%s sounds as a normal key', (key) => {
    expect(soundKindOf(ev(key))).toBe('key');
  });

  it('Enter sounds as the Enter kind', () => {
    expect(soundKindOf(ev('Enter'))).toBe('enter');
  });

  it('a dead key (accent before a letter) sounds', () => {
    expect(soundKindOf(ev('Dead'))).toBe('key');
  });

  it('counts a keydown during Japanese IME conversion once: key Process, or keyCode 229 with any key', () => {
    expect(soundKindOf(ev('Process', { keyCode: 229 }))).toBe('key');
    expect(soundKindOf(ev('Process'))).toBe('key');
    expect(soundKindOf(ev('a', { keyCode: 229 }))).toBe('key');
    expect(soundKindOf(ev('Unidentified', { keyCode: 229 }))).toBe('key');
    expect(soundKindOf(ev('Process', { keyCode: 229, shiftKey: true }))).toBe('key');
  });

  it('Enter that confirms a conversion (keyCode 229) is still the Enter kind', () => {
    expect(soundKindOf(ev('Enter', { keyCode: 229 }))).toBe('enter');
  });

  it('a held key (repeat) still counts as a key that sounds (the thinning is the player’s job)', () => {
    expect(soundKindOf(ev('a', { repeat: true }))).toBe('key');
    expect(soundKindOf(ev('Backspace', { repeat: true }))).toBe('key');
  });
});

describe('modifier combinations', () => {
  it.each(COMBOS)('character a with %o: sounds only without Cmd and Ctrl (Shift and Alt alone still type a character)', (mods) => {
    const expected = mods.metaKey || mods.ctrlKey ? null : 'key';
    expect(soundKindOf(ev('a', mods)), label(mods)).toBe(expected);
  });

  it.each(COMBOS)('Enter with %o: sounds only without Cmd and Ctrl', (mods) => {
    const expected = mods.metaKey || mods.ctrlKey ? null : 'enter';
    expect(soundKindOf(ev('Enter', mods)), label(mods)).toBe(expected);
  });

  it.each(COMBOS)('Backspace, Delete, Tab, Space with %o: sound only without Cmd and Ctrl', (mods) => {
    for (const key of ['Backspace', 'Delete', 'Tab', ' ']) {
      expect(soundKindOf(ev(key, mods)), `${key} ${label(mods)}`).toBe(mods.metaKey || mods.ctrlKey ? null : 'key');
    }
  });

  it.each(COMBOS)('an IME key with %o: not with Cmd or Ctrl (IME switching shortcuts)', (mods) => {
    expect(soundKindOf(ev('Process', { keyCode: 229, ...mods })), label(mods)).toBe(mods.metaKey || mods.ctrlKey ? null : 'key');
  });

  it.each(['s', 'z', 'c', 'v', 'a', 'f', ','])('Cmd+%s and Ctrl+%s are shortcuts and do not sound', (key) => {
    expect(soundKindOf(ev(key, { metaKey: true }))).toBeNull();
    expect(soundKindOf(ev(key, { ctrlKey: true }))).toBeNull();
    expect(soundKindOf(ev(key.toUpperCase(), { metaKey: true, shiftKey: true }))).toBeNull();
  });
});

describe('keys that do not sound', () => {
  it.each(['Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'AltGraph', 'Fn', 'NumLock', 'ScrollLock', 'OS'])('modifier key %s alone does not sound', (key) => {
    expect(soundKindOf(ev(key))).toBeNull();
    // 修飾キーは、押した時点で自分の修飾のフラグを立てて届く。
    expect(soundKindOf(ev(key, { shiftKey: key === 'Shift', ctrlKey: key === 'Control', altKey: key === 'Alt', metaKey: key === 'Meta' }))).toBeNull();
  });

  it.each(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'])('movement key %s does not sound (also with Shift or Alt)', (key) => {
    expect(soundKindOf(ev(key))).toBeNull();
    expect(soundKindOf(ev(key, { shiftKey: true }))).toBeNull();
    expect(soundKindOf(ev(key, { altKey: true }))).toBeNull();
  });

  it.each(['Escape', 'F1', 'F5', 'F6', 'F12', 'Insert', 'ContextMenu', 'Pause', 'PrintScreen', 'Convert', 'NonConvert', 'KanaMode', 'Eisu', 'Unidentified'])(
    '%s does not sound',
    (key) => {
      expect(soundKindOf(ev(key))).toBeNull();
    },
  );

  it('an empty key does not sound', () => {
    expect(soundKindOf(ev(''))).toBeNull();
  });
});
