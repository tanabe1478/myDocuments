import { describe, expect, it } from 'vitest';
import { typewriterPadding, typewriterScrollTop } from './typewriter';

describe('typewriterScrollTop', () => {
  const viewportHeight = 600;

  it('moves the scroll position so the caret center lands at the viewport center', () => {
    // カーソルが上端から 500 の位置にあり、中央（300）より 200 下 → 200 下へスクロール
    expect(typewriterScrollTop({ scrollTop: 1000, caretCenter: 500, viewportHeight, maxScrollTop: 5000 })).toBe(1200);
    // 中央より上にあるなら、上へ
    expect(typewriterScrollTop({ scrollTop: 1000, caretCenter: 100, viewportHeight, maxScrollTop: 5000 })).toBe(800);
  });

  it('does not move when the caret is already centered', () => {
    expect(typewriterScrollTop({ scrollTop: 1234, caretCenter: 300, viewportHeight, maxScrollTop: 5000 })).toBe(1234);
  });

  it('stays within 0..maxScrollTop', () => {
    expect(typewriterScrollTop({ scrollTop: 0, caretCenter: 50, viewportHeight, maxScrollTop: 5000 })).toBe(0);
    expect(typewriterScrollTop({ scrollTop: 4900, caretCenter: 590, viewportHeight, maxScrollTop: 5000 })).toBe(5000);
    expect(typewriterScrollTop({ scrollTop: 10, caretCenter: 10, viewportHeight, maxScrollTop: -5 })).toBe(0);
  });

  it('reaches the center on the first line when the content has half a viewport of padding on top', () => {
    // 先頭行の中心は、padding（= viewportHeight / 2）+ 行の半分の位置。scrollTop 0 のとき上端から 300 + 17。
    const pad = typewriterPadding(viewportHeight);
    const lineHalf = 17;
    const caretCenter = pad + lineHalf; // scrollTop = 0
    const top = typewriterScrollTop({ scrollTop: 0, caretCenter, viewportHeight, maxScrollTop: 5000 });
    expect(top).toBe(lineHalf);
    expect(caretCenter - top).toBe(viewportHeight / 2);
  });
});

describe('typewriterPadding', () => {
  it('is half the viewport height', () => {
    expect(typewriterPadding(800)).toBe(400);
    expect(typewriterPadding(601)).toBe(301);
  });
});
