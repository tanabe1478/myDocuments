import { describe, expect, it, vi } from 'vitest';
import { CLIPBOARD_COPIED_MESSAGE, CLIPBOARD_FAILED_MESSAGE, createIsolatedServices } from './hostServices';

describe('createIsolatedServices', () => {
  it('writes through the bridge and shows the toast "クリップボードにコピーしました" only after it succeeded', async () => {
    const order: string[] = [];
    const bridge = { writeClipboardText: vi.fn(async () => void order.push('written')) };
    const notify = vi.fn(() => void order.push('toast'));
    const services = createIsolatedServices({ bridge, notify, currentPath: () => '/docs/a.md' });
    await services.writeClipboardText('/docs/a.md');
    expect(bridge.writeClipboardText).toHaveBeenCalledWith('/docs/a.md');
    expect(notify).toHaveBeenCalledWith({ kind: 'info', message: 'クリップボードにコピーしました' });
    expect(CLIPBOARD_COPIED_MESSAGE).toBe('クリップボードにコピーしました');
    expect(order).toEqual(['written', 'toast']);
  });

  it('shows an error toast and rethrows when the bridge fails (no success toast)', async () => {
    const error = new Error('no clipboard');
    const notify = vi.fn();
    const services = createIsolatedServices({ bridge: { writeClipboardText: async () => Promise.reject(error) }, notify, currentPath: () => null });
    await expect(services.writeClipboardText('x')).rejects.toBe(error);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith({ kind: 'error', message: CLIPBOARD_FAILED_MESSAGE });
  });

  it('returns the current path at the time of the call (null for an unsaved document)', () => {
    let path: string | null = null;
    const services = createIsolatedServices({ bridge: { writeClipboardText: async () => {} }, notify: () => {}, currentPath: () => path });
    expect(services.currentPath()).toBeNull();
    path = '/docs/b.md';
    expect(services.currentPath()).toBe('/docs/b.md');
  });
});
