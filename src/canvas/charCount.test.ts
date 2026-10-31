import { describe, expect, it } from 'vitest';
import { countCharacters } from './charCount';

describe('countCharacters', () => {
  it('is 0 for empty and whitespace-only text', () => {
    expect(countCharacters('')).toBe(0);
    expect(countCharacters(' \n\t\r\n　 ')).toBe(0);
  });

  it('counts Latin and Japanese characters, not whitespace or newlines', () => {
    expect(countCharacters('abc')).toBe(3);
    expect(countCharacters('a b\nc')).toBe(3);
    expect(countCharacters('日本語の文章。')).toBe(7);
    expect(countCharacters('前の文。\n\n後の文。')).toBe(8);
    expect(countCharacters('全角　空白')).toBe(4);
  });

  it('counts a surrogate pair as one character', () => {
    expect(countCharacters('😀')).toBe(1);
    expect(countCharacters('𠮷野家')).toBe(3);
    expect(countCharacters('a😀 b😀\n')).toBe(4);
  });

  it('counts a lone surrogate as one character', () => {
    expect(countCharacters('\ud83d')).toBe(1);
    expect(countCharacters('\ude00a')).toBe(2);
  });

  it('counts markdown syntax characters (it is a count of the source text)', () => {
    expect(countCharacters('# 見出し')).toBe(4);
  });
});
