import { describe, expect, it } from 'vitest';
import { fallbackPrefixWidthEm, hangPrefix, isBlankLine, measurableText, TAB_SIZE } from './lineKinds';

describe('isBlankLine', () => {
  it('is true for empty and whitespace-only lines, including full-width spaces and tabs', () => {
    for (const blank of ['', ' ', '   ', '\t', '　', ' 　\t ']) expect(isBlankLine(blank), JSON.stringify(blank)).toBe(true);
  });

  it('is false when there is any visible character', () => {
    for (const text of ['a', ' a', 'a ', '-', '>', '　あ', '#']) expect(isBlankLine(text), JSON.stringify(text)).toBe(false);
  });
});

describe('hangPrefix', () => {
  it('takes the bullet marker and the spaces after it', () => {
    expect(hangPrefix('- 項目')).toBe('- ');
    expect(hangPrefix('* 項目')).toBe('* ');
    expect(hangPrefix('+ 項目')).toBe('+ ');
    expect(hangPrefix('-   項目')).toBe('-   ');
  });

  it('takes the number and the dot or paren of an ordered item', () => {
    expect(hangPrefix('1. 項目')).toBe('1. ');
    expect(hangPrefix('10. 項目')).toBe('10. ');
    expect(hangPrefix('3) 項目')).toBe('3) ');
  });

  it('includes the indentation of nested items', () => {
    expect(hangPrefix('  - 入れ子')).toBe('  - ');
    expect(hangPrefix('    1. 入れ子')).toBe('    1. ');
  });

  it('takes quote marks, nested quotes, and a list inside a quote', () => {
    expect(hangPrefix('> 引用')).toBe('> ');
    expect(hangPrefix('>引用')).toBe('>');
    expect(hangPrefix('> > 入れ子')).toBe('> > ');
    expect(hangPrefix('> - 項目')).toBe('> - ');
  });

  it('includes a task checkbox', () => {
    expect(hangPrefix('- [ ] やること')).toBe('- [ ] ');
    expect(hangPrefix('- [x] 済み')).toBe('- [x] ');
  });

  it('keeps only the indentation of a continuation line', () => {
    expect(hangPrefix('  続きの行')).toBe('  ');
  });

  it('is empty for plain text, and for a marker that is not followed by a space', () => {
    for (const text of ['', '本文', '-項目', '1.5 倍', '#見出し', '1.項目']) {
      expect(hangPrefix(text), JSON.stringify(text)).toBe('');
    }
  });
});

describe('prefix width helpers', () => {
  it('expands a tab to the tab width before measuring', () => {
    expect(measurableText('\t- ')).toBe(`${' '.repeat(TAB_SIZE)}- `);
  });

  it('falls back to a width proportional to the character count', () => {
    expect(fallbackPrefixWidthEm('- ')).toBeCloseTo(1.2, 5);
    expect(fallbackPrefixWidthEm('10. ')).toBeCloseTo(2.4, 5);
    expect(fallbackPrefixWidthEm('')).toBe(0);
  });
});
