import { describe, expect, it } from 'vitest';
import { SIDEBAR_WIDTH_PX, sidebarReserve } from './sidebarLayout';
import { TOAST_MAX_WIDTH_PX, TOAST_MIN_WIDTH_PX, toastLayout } from './toastLayout';

describe('toastLayout', () => {
  it('1280 幅・既定の最大幅（680）では、列の外（右の余白）に置く', () => {
    // 本文面は 680 + 2 * 56 = 792。右の余白は (1280 - 792) / 2 = 244、左右のマージンを除いて 212。
    expect(toastLayout(1280, 680)).toEqual({ placement: 'margin', width: 212 });
  });

  it('820 幅では余白が足りないので、本文に重ねる', () => {
    expect(toastLayout(820, 680)).toEqual({ placement: 'overlay', width: 0 });
  });

  it('幅は最小幅以上、最大幅以下', () => {
    const wide = toastLayout(2400, 680);
    expect(wide.placement).toBe('margin');
    expect(wide.width).toBe(TOAST_MAX_WIDTH_PX);
    for (let available = 700; available <= 2000; available += 10) {
      const layout = toastLayout(available, 680);
      if (layout.placement === 'margin') {
        expect(layout.width).toBeGreaterThanOrEqual(TOAST_MIN_WIDTH_PX);
        expect(layout.width).toBeLessThanOrEqual(TOAST_MAX_WIDTH_PX);
      }
    }
  });

  it('余白の境界: 最小幅 + 左右のマージンが収まる幅から列の外へ移る', () => {
    // 本文面 792 のとき、余白 = (available - 792) / 2 >= 180 + 32 となる available は 1216 以上。
    expect(toastLayout(1215, 680).placement).toBe('overlay');
    expect(toastLayout(1216, 680).placement).toBe('margin');
  });

  it('サイドバーを開いて本文の領域が狭くなると、余白が狭くなり、本文に重ねる（サイドバーには入らない）', () => {
    const reserve = sidebarReserve(true, 1280);
    expect(reserve).toBe(SIDEBAR_WIDTH_PX);
    expect(toastLayout(1280, 680).placement).toBe('margin');
    expect(toastLayout(1280 - reserve, 680).placement).toBe('overlay');
    // 十分広い窓なら、サイドバーを開いたままでも本文の領域の右の余白に置ける。
    const wide = 2000;
    expect(toastLayout(wide - sidebarReserve(true, wide), 680).placement).toBe('margin');
  });

  it('最大幅を狭くすると余白が広がる', () => {
    expect(toastLayout(1000, 680).placement).toBe('overlay');
    expect(toastLayout(1000, 400).placement).toBe('margin');
  });
});
