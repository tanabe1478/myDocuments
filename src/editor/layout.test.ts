import { describe, expect, it } from 'vitest';
import { charsPerLine, columnWidth, contentPadding, PAD_MAX_PX, PAD_MIN_PX } from './layout';

describe('contentPadding', () => {
  it('is 56px when the window has room to spare', () => {
    expect(contentPadding(1280, 680)).toBe(PAD_MAX_PX);
    expect(contentPadding(792, 680)).toBe(PAD_MAX_PX);
  });

  it('shrinks gradually, keeping the line length, as the window narrows', () => {
    expect(contentPadding(760, 680)).toBe(40);
    expect(contentPadding(740, 680)).toBe(30);
    expect(contentPadding(721, 680)).toBeCloseTo(20.5, 5);
  });

  it('stops at 20px even when the window is narrower than the line length', () => {
    expect(contentPadding(700, 680)).toBe(PAD_MIN_PX);
    expect(contentPadding(480, 680)).toBe(PAD_MIN_PX);
    expect(contentPadding(0, 680)).toBe(PAD_MIN_PX);
  });
});

describe('columnWidth', () => {
  it('is the max width while the window allows it', () => {
    expect(columnWidth(1280, 680)).toBe(680);
    expect(columnWidth(740, 680)).toBe(680);
    expect(columnWidth(720, 680)).toBe(680);
  });

  it('gives way to the window when the padding is at its minimum', () => {
    expect(columnWidth(700, 680)).toBe(660);
    expect(columnWidth(480, 680)).toBe(440);
    expect(columnWidth(30, 680)).toBe(0);
  });
});

describe('charsPerLine', () => {
  it('counts full-width characters: the font size plus the letter spacing each', () => {
    expect(charsPerLine(680, 18, 0.02)).toBe(37);
    expect(charsPerLine(680, 18, 0)).toBe(37);
    expect(charsPerLine(680, 24, 0.1)).toBe(25);
    expect(charsPerLine(900, 24, 0.1)).toBe(34);
  });

  it('is 0 for a zero or invalid width', () => {
    expect(charsPerLine(0, 18, 0.02)).toBe(0);
    expect(charsPerLine(-5, 18, 0.02)).toBe(0);
    expect(charsPerLine(680, 0, 0.02)).toBe(0);
    expect(charsPerLine(Number.NaN, 18, 0.02)).toBe(0);
  });

  it('matches the default: about 36-37 characters at 18px in a 680px column', () => {
    const n = charsPerLine(columnWidth(1280, 680), 18, 0.02);
    expect(n).toBeGreaterThanOrEqual(36);
    expect(n).toBeLessThanOrEqual(38);
  });
});
