import { describe, expect, it } from 'vitest';
import { listIndentUnit, planIndentLess, planIndentMore, type LineEdit } from './indent';

/** 行に変更を適用した結果。変更がなければ null。 */
function apply(text: string, edit: LineEdit | null): string | null {
  return edit ? text.slice(0, edit.from) + edit.insert + text.slice(edit.to) : null;
}
const more = (text: string, multi = false) => apply(text, planIndentMore(text, multi));
const less = (text: string) => apply(text, planIndentLess(text));

describe('listIndentUnit', () => {
  it('is 2 for bullets, and the marker width for ordered items', () => {
    expect(listIndentUnit('- a')).toBe(2);
    expect(listIndentUnit('  * a')).toBe(2);
    expect(listIndentUnit('1. a')).toBe(3);
    expect(listIndentUnit('10. a')).toBe(4);
    expect(listIndentUnit('2) a')).toBe(3);
    expect(listIndentUnit('> - a')).toBe(2);
  });

  it('is null for lines that are not list items', () => {
    expect(listIndentUnit('本文')).toBeNull();
    expect(listIndentUnit('> 引用')).toBeNull();
    expect(listIndentUnit('-a')).toBeNull();
  });
});

describe('Tab (planIndentMore)', () => {
  it('indents list items by their own unit', () => {
    expect(more('- a')).toBe('  - a');
    expect(more('  - a')).toBe('    - a');
    expect(more('1. a')).toBe('   1. a');
    expect(more('- ')).toBe('  - ');
  });

  it('indents a list item inside a quote after the quote marks', () => {
    expect(more('> - a')).toBe('>   - a');
  });

  it('nests a quote one level deeper', () => {
    expect(more('> a')).toBe('> > a');
    expect(more('> > a')).toBe('> > > a');
  });

  it('never inserts a tab character', () => {
    for (const text of ['- a', '1. a', '> a', '本文']) {
      for (const multi of [false, true]) expect(more(text, multi) ?? '').not.toContain('\t');
    }
  });

  it('does nothing for plain lines, unless several lines are selected', () => {
    expect(planIndentMore('本文', false)).toBeNull();
    expect(more('本文', true)).toBe('  本文');
  });

  it('skips blank lines', () => {
    expect(planIndentMore('', true)).toBeNull();
    expect(planIndentMore('   ', true)).toBeNull();
  });
});

describe('Shift+Tab (planIndentLess)', () => {
  it('removes one unit of indentation from a list item, and stops at the left edge', () => {
    expect(less('  - a')).toBe('- a');
    expect(less('    - a')).toBe('  - a');
    expect(less('   1. a')).toBe('1. a');
    expect(less(' - a')).toBe('- a');
    expect(less('- a')).toBeNull();
  });

  it('removes one quote level, and stops at a single level', () => {
    expect(less('> > a')).toBe('> a');
    expect(less('> > > a')).toBe('> > a');
    expect(less('> a')).toBeNull();
  });

  it('removes up to two leading spaces from other lines', () => {
    expect(less('    本文')).toBe('  本文');
    expect(less(' 本文')).toBe('本文');
    expect(less('本文')).toBeNull();
  });

  it('undoes Tab for every kind of line', () => {
    for (const text of ['- a', '  - a', '1. a', '10. a', '> a', '> - a']) {
      expect(less(more(text)!), text).toBe(text);
    }
  });
});
