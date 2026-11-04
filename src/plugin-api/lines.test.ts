import { describe, expect, it } from 'vitest';
import { isBlankLine } from '.';

describe('isBlankLine', () => {
  it('is true for empty and whitespace-only lines, including full-width spaces and tabs', () => {
    for (const blank of ['', ' ', '   ', '\t', '　', ' 　\t ']) expect(isBlankLine(blank), JSON.stringify(blank)).toBe(true);
  });

  it('is false when there is any visible character', () => {
    for (const text of ['a', ' a', 'a ', '-', '>', '　あ', '#']) expect(isBlankLine(text), JSON.stringify(text)).toBe(false);
  });
});
