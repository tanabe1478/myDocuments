import { describe, expect, it } from 'vitest';
import { MIN_BODY_WIDTH_PX, SIDEBAR_WIDTH_PX, sidebarMode, sidebarReserve } from './sidebarLayout';

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
