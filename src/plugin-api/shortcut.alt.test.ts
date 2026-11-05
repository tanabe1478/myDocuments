import { describe, expect, it } from 'vitest';
import { isAltGraphInput, matchesShortcut, parseShortcut, type KeyEventLike } from './shortcut';

// R6: 'Mod+Alt+<英字>' の形。macOS の Option は物理キー、Windows と Linux の AltGr では発火しない。既存の形の判定は shortcut.test.ts が確かめている。

const ev = (over: Partial<KeyEventLike>): KeyEventLike => ({ key: 'c', code: 'KeyC', metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...over });
const copy = parseShortcut('Mod+Alt+C', { allowAlt: true });

describe('parseShortcut with allowAlt', () => {
  it('reads Mod+Alt+letter in any order and case, and normalizes it', () => {
    expect(copy).toEqual({ key: 'c', shift: false, alt: true, text: 'Mod+Alt+C' });
    expect(parseShortcut('Alt+Mod+c', { allowAlt: true }).text).toBe('Mod+Alt+C');
  });
  it('does not add the alt field to the existing forms (their shape is unchanged)', () => {
    expect(parseShortcut('Mod+T', { allowAlt: true })).toEqual({ key: 't', shift: false, text: 'Mod+T' });
    expect(parseShortcut('Mod+Shift+T', { allowAlt: true })).toEqual({ key: 't', shift: true, text: 'Mod+Shift+T' });
  });
  it('still rejects Alt without the option, Alt without Mod, Alt with Shift, Alt with comma or a non-letter', () => {
    expect(() => parseShortcut('Mod+Alt+C')).toThrow(/invalid shortcut/);
    for (const bad of ['Alt+C', 'Mod+Shift+Alt+C', 'Mod+Alt+Shift+C', 'Mod+Alt+,', 'Mod+Alt+1', 'Mod+Alt+Alt+C', 'Mod+Alt+']) {
      expect(() => parseShortcut(bad, { allowAlt: true }), bad).toThrow(/invalid shortcut/);
    }
  });
});

describe('matchesShortcut for an Alt shortcut', () => {
  it('macOS: Cmd+Option+C matches by the physical key, even though key is "ç" (Option composes a character)', () => {
    expect(matchesShortcut(copy, ev({ key: 'ç', metaKey: true, altKey: true }), true)).toBe(true);
    expect(matchesShortcut(copy, ev({ key: 'Dead', code: 'KeyC', metaKey: true, altKey: true }), true)).toBe(true);
    // 物理キーで判定するので、key が別の英字でも、code が合うものに合う（Option では key が配列どおりの英字にならない）。
    expect(matchesShortcut(copy, ev({ key: 'x', code: 'KeyC', metaKey: true, altKey: true }), true)).toBe(true);
    expect(matchesShortcut(copy, ev({ key: 'c', code: 'KeyX', metaKey: true, altKey: true }), true)).toBe(false);
  });
  it('macOS: needs Cmd (not Ctrl), Option, and no Shift', () => {
    expect(matchesShortcut(copy, ev({ key: 'ç', ctrlKey: true, altKey: true }), true)).toBe(false);
    expect(matchesShortcut(copy, ev({ key: 'ç', metaKey: true }), true)).toBe(false);
    expect(matchesShortcut(copy, ev({ key: 'Ç', metaKey: true, altKey: true, shiftKey: true }), true)).toBe(false);
    expect(matchesShortcut(copy, ev({ key: 'ç', metaKey: true, ctrlKey: true, altKey: true }), true)).toBe(false);
  });
  it('Windows and Linux: Ctrl+Alt+C matches by the logical key, falling back to the physical key', () => {
    expect(matchesShortcut(copy, ev({ ctrlKey: true, altKey: true }), false)).toBe(true);
    expect(matchesShortcut(copy, ev({ key: 'C', ctrlKey: true, altKey: true }), false)).toBe(true);
    expect(matchesShortcut(copy, ev({ key: 'Process', code: 'KeyC', ctrlKey: true, altKey: true }), false)).toBe(true);
    expect(matchesShortcut(copy, ev({ key: 'x', code: 'KeyC', ctrlKey: true, altKey: true }), false)).toBe(false);
    expect(matchesShortcut(copy, ev({ metaKey: true, altKey: true }), false)).toBe(false);
  });
  it('does not fire for AltGr: getModifierState("AltGraph"), or Ctrl+Alt with a printable key that is not a letter', () => {
    const altGraph = (v: boolean) => ({ getModifierState: (k: string) => k === 'AltGraph' && v });
    expect(matchesShortcut(copy, ev({ ctrlKey: true, altKey: true, ...altGraph(true) }), false)).toBe(false);
    expect(matchesShortcut(copy, ev({ ctrlKey: true, altKey: true, ...altGraph(false) }), false)).toBe(true);
    // AltGr+C が 'ç' や '©' のような文字を入れる配列（Ctrl+Alt として届く）。
    for (const key of ['ç', '©', '¢', '€', '@']) {
      expect(matchesShortcut(copy, ev({ key, code: 'KeyC', ctrlKey: true, altKey: true }), false), key).toBe(false);
    }
    // getModifierState がなくても、Ctrl+Alt と文字で判定できる。
    expect(isAltGraphInput(ev({ key: 'ç', ctrlKey: true, altKey: true }))).toBe(true);
    // 英字のままなら、Ctrl+Alt+C（AltGr ではない）。Dead や Process のように、1 文字でないものは AltGr とは見なさない。
    expect(isAltGraphInput(ev({ key: 'c', ctrlKey: true, altKey: true }))).toBe(false);
    expect(isAltGraphInput(ev({ key: 'Dead', ctrlKey: true, altKey: true }))).toBe(false);
  });
  it('macOS: Option+C alone is not AltGr (no Ctrl), so it is not excluded by the AltGr rule', () => {
    expect(isAltGraphInput(ev({ key: 'ç', metaKey: true, altKey: true }))).toBe(false);
  });
  it('ignores IME composition', () => {
    expect(matchesShortcut(copy, ev({ ctrlKey: true, altKey: true, isComposing: true }), false)).toBe(false);
    expect(matchesShortcut(copy, ev({ ctrlKey: true, altKey: true, keyCode: 229 }), false)).toBe(false);
  });
});

describe('the existing forms are not changed by Alt support', () => {
  const t = parseShortcut('Mod+T');
  it('still reject any Alt, and match without Alt', () => {
    expect(matchesShortcut(t, ev({ key: 't', ctrlKey: true, altKey: true }), false)).toBe(false);
    expect(matchesShortcut(t, ev({ key: 't', metaKey: true, altKey: true }), true)).toBe(false);
    expect(matchesShortcut(t, ev({ key: 't', ctrlKey: true }), false)).toBe(true);
    expect(matchesShortcut(t, ev({ key: 't', metaKey: true }), true)).toBe(true);
  });
  it('an Alt shortcut does not match the same key without Alt', () => {
    expect(matchesShortcut(copy, ev({ ctrlKey: true }), false)).toBe(false);
    expect(matchesShortcut(copy, ev({ metaKey: true }), true)).toBe(false);
  });
});
