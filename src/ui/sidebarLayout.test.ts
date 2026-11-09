import { describe, expect, it } from 'vitest';
import { MIN_BODY_WIDTH_PX, RIGHT_PANE_WIDTH_PX, SIDEBAR_WIDTH_PX, rightPaneMode, rightPaneReserve, sidebarMode, sidebarReserve } from './sidebarLayout';

describe('sidebarMode / sidebarReserve', () => {
  it('pushes the body when the sidebar and the minimum body both fit', () => {
    const boundary = SIDEBAR_WIDTH_PX + MIN_BODY_WIDTH_PX;
    expect(sidebarMode(boundary)).toBe('push');
    expect(sidebarReserve(true, boundary)).toBe(SIDEBAR_WIDTH_PX);
    expect(sidebarReserve(true, 1280)).toBe(SIDEBAR_WIDTH_PX);
  });

  it('overlays the sidebar (reserves nothing) when pushing would squeeze the body', () => {
    const boundary = SIDEBAR_WIDTH_PX + MIN_BODY_WIDTH_PX;
    expect(sidebarMode(boundary - 1)).toBe('overlay');
    expect(sidebarReserve(true, boundary - 1)).toBe(0);
    expect(sidebarReserve(true, 400)).toBe(0);
  });

  it('reserves nothing while closed', () => {
    expect(sidebarReserve(false, 1280)).toBe(0);
    expect(sidebarReserve(false, 400)).toBe(0);
  });

  it('the minimum body is the smallest max width plus the minimum side padding', () => {
    expect(MIN_BODY_WIDTH_PX).toBe(320 + 2 * 20);
  });
});

describe('rightPaneMode / rightPaneReserve（ADR-005 の R13）', () => {
  it('the right pane is 260px wide, like the left sidebar', () => {
    expect(RIGHT_PANE_WIDTH_PX).toBe(260);
  });

  it('with the left sidebar closed: pushes from 620px (260 + 360), overlays at 619px', () => {
    expect(rightPaneMode(620, 0)).toBe('push');
    expect(rightPaneMode(619, 0)).toBe('overlay');
    expect(rightPaneReserve(true, 620, 0)).toBe(RIGHT_PANE_WIDTH_PX);
    expect(rightPaneReserve(true, 619, 0)).toBe(0);
  });

  it('with the left sidebar pushing: both push from 880px (260 + 360 + 260), the right pane overlays at 879px', () => {
    const left = (width: number) => sidebarReserve(true, width);
    expect(left(880)).toBe(SIDEBAR_WIDTH_PX);
    expect(rightPaneMode(880, left(880))).toBe('push');
    expect(rightPaneMode(879, left(879))).toBe('overlay');
    // 左は 879 でも push（右だけが重なる）。
    expect(sidebarMode(879)).toBe('push');
    expect(rightPaneReserve(true, 880, left(880))).toBe(RIGHT_PANE_WIDTH_PX);
    expect(rightPaneReserve(true, 879, left(879))).toBe(0);
    expect(880).toBe(SIDEBAR_WIDTH_PX + MIN_BODY_WIDTH_PX + RIGHT_PANE_WIDTH_PX);
  });

  it('when the left sidebar overlays (reserves nothing), the left does not narrow the right decision', () => {
    // 619px: 左は overlay（押し出し 0）。右も 619 - 260 = 359 < 360 で overlay。
    expect(sidebarReserve(true, 619)).toBe(0);
    expect(rightPaneMode(619, sidebarReserve(true, 619))).toBe('overlay');
  });

  it('reserves nothing while closed', () => {
    expect(rightPaneReserve(false, 1280, 0)).toBe(0);
    expect(rightPaneReserve(false, 1280, SIDEBAR_WIDTH_PX)).toBe(0);
  });

  it('the body area is what is left after both reserves (never below the minimum while both push)', () => {
    for (const width of [880, 900, 1280]) {
      const left = sidebarReserve(true, width);
      const body = width - left - rightPaneReserve(true, width, left);
      expect(body).toBeGreaterThanOrEqual(MIN_BODY_WIDTH_PX);
    }
    expect(1280 - SIDEBAR_WIDTH_PX - RIGHT_PANE_WIDTH_PX).toBe(760);
  });
});
