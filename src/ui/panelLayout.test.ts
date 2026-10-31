import { describe, expect, it } from 'vitest';
import { PANEL_RESERVE_PX, panelReserve } from './panelLayout';

describe('panelReserve', () => {
  it('reserves the panel width when the body and the panel both fit', () => {
    expect(panelReserve(680, 1280)).toBe(PANEL_RESERVE_PX);
    expect(panelReserve(680, 680 + PANEL_RESERVE_PX)).toBe(PANEL_RESERVE_PX);
  });

  it('reserves nothing (the panel overlaps the body) when they do not fit', () => {
    expect(panelReserve(680, 680 + PANEL_RESERVE_PX - 1)).toBe(0);
    expect(panelReserve(680, 900)).toBe(0);
    expect(panelReserve(1100, 1280)).toBe(0);
  });
});
