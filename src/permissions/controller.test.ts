import { describe, expect, it, vi } from 'vitest';
import type { PluginPermissionsFile } from '../plugin-api';
import { PermissionController } from './controller';

// 権限の決定と確認の画面の状態（R6）。保存は偽の bridge。

const plugin = { id: 'copy-path', name: 'パスをコピー' };
const both = ['clipboard.write', 'paths.read'] as const;

function setup(initial: PluginPermissionsFile = { version: 1, plugins: {} }) {
  const saved: PluginPermissionsFile[] = [];
  const bridge = {
    loadPluginPermissions: vi.fn(async () => initial),
    savePluginPermissions: vi.fn(async (p: PluginPermissionsFile) => void saved.push(structuredClone(p))),
  };
  const notify = vi.fn();
  const controller = new PermissionController({ bridge, notify });
  return { controller, bridge, saved, notify };
}
const flush = () => new Promise((r) => setTimeout(r, 0));

describe('PermissionController', () => {
  it('does not read the saved decisions until it is needed (load is lazy), and reads them once', async () => {
    const t = setup();
    expect(t.bridge.loadPluginPermissions).not.toHaveBeenCalled();
    expect(t.controller.getState().loaded).toBe(false);
    await Promise.all([t.controller.load(), t.controller.load()]);
    expect(t.bridge.loadPluginPermissions).toHaveBeenCalledTimes(1);
    expect(t.controller.getState().loaded).toBe(true);
  });

  it('returns a saved decision without asking', async () => {
    const t = setup({ version: 1, plugins: { 'copy-path': { 'paths.read': 'granted', 'clipboard.write': 'denied' } } });
    expect(await t.controller.authorize(plugin, both, 'paths.read')).toBe('granted');
    expect(await t.controller.authorize(plugin, both, 'clipboard.write')).toBe('denied');
    expect(t.controller.getState().prompt).toBeNull();
  });

  it('asks about all the undecided declared permissions at once, and saves the answer for each', async () => {
    const t = setup({ version: 1, plugins: { 'copy-path': { 'paths.read': 'granted' } } });
    const result = t.controller.authorize(plugin, both, 'clipboard.write');
    await flush();
    expect(t.controller.getState().prompt).toEqual({ pluginId: 'copy-path', pluginName: 'パスをコピー', permissions: ['clipboard.write'] });
    t.controller.answer('granted');
    expect(await result).toBe('granted');
    expect(t.controller.getState().prompt).toBeNull();
    expect(t.saved.at(-1)).toEqual({ version: 1, plugins: { 'copy-path': { 'paths.read': 'granted', 'clipboard.write': 'granted' } } });

    const fresh = setup();
    const first = fresh.controller.authorize(plugin, both, 'paths.read');
    await flush();
    expect(fresh.controller.getState().prompt?.permissions).toEqual(['clipboard.write', 'paths.read']);
    fresh.controller.answer('denied');
    expect(await first).toBe('denied');
    expect(fresh.saved.at(-1)).toEqual({ version: 1, plugins: { 'copy-path': { 'clipboard.write': 'denied', 'paths.read': 'denied' } } });
    // 決めたあとは、聞かない。
    expect(await fresh.controller.authorize(plugin, both, 'clipboard.write')).toBe('denied');
    expect(fresh.controller.getState().prompt).toBeNull();
  });

  it('a dismissed confirmation (Esc, close) saves nothing, leaves the permission undecided, and asks again next time', async () => {
    const t = setup();
    const first = t.controller.authorize(plugin, both, 'paths.read');
    await flush();
    t.controller.answer('dismissed');
    expect(await first).toBe('dismissed');
    expect(t.saved).toEqual([]);
    expect(t.controller.getState().decisions).toEqual({});
    const again = t.controller.authorize(plugin, both, 'paths.read');
    await flush();
    expect(t.controller.getState().prompt).not.toBeNull();
    t.controller.answer('granted');
    expect(await again).toBe('granted');
  });

  it('does not stack a second confirmation for the same part: waiting calls follow the one answer (and a dismissal dismisses them all)', async () => {
    const t = setup();
    const a = t.controller.authorize(plugin, both, 'paths.read');
    const b = t.controller.authorize(plugin, both, 'clipboard.write');
    await flush();
    expect(t.bridge.loadPluginPermissions).toHaveBeenCalledTimes(1);
    t.controller.answer('granted');
    expect(await Promise.all([a, b])).toEqual(['granted', 'granted']);
    expect(t.saved).toHaveLength(1);

    const u = setup();
    const c = u.controller.authorize(plugin, both, 'paths.read');
    const d = u.controller.authorize(plugin, both, 'clipboard.write');
    await flush();
    u.controller.answer('dismissed');
    expect(await Promise.all([c, d])).toEqual(['dismissed', 'dismissed']);
  });

  it('shows the confirmations of different parts one at a time, in order', async () => {
    const t = setup();
    const a = t.controller.authorize({ id: 'one', name: 'one' }, ['paths.read'], 'paths.read');
    const b = t.controller.authorize({ id: 'two', name: 'two' }, ['paths.read'], 'paths.read');
    await flush();
    expect(t.controller.getState().prompt?.pluginId).toBe('one');
    t.controller.answer('granted');
    expect(t.controller.getState().prompt?.pluginId).toBe('two');
    t.controller.answer('denied');
    expect(await Promise.all([a, b])).toEqual(['granted', 'denied']);
    await flush();
    expect(t.saved.at(-1)).toEqual({ version: 1, plugins: { one: { 'paths.read': 'granted' }, two: { 'paths.read': 'denied' } } });
  });

  it('revoke returns the part to undecided, saves, and the next use asks again; revoking an unknown part does nothing', async () => {
    const t = setup({ version: 1, plugins: { 'copy-path': { 'paths.read': 'granted' }, other: { 'paths.read': 'denied' } } });
    await t.controller.load();
    t.controller.revoke('ghost');
    expect(t.saved).toEqual([]);
    t.controller.revoke('copy-path');
    await flush();
    expect(t.saved.at(-1)).toEqual({ version: 1, plugins: { other: { 'paths.read': 'denied' } } });
    const next = t.controller.authorize(plugin, both, 'paths.read');
    await flush();
    expect(t.controller.getState().prompt).not.toBeNull();
    t.controller.answer('dismissed');
    expect(await next).toBe('dismissed');
  });

  it('keeps the decision for this run and tells the user when saving fails; a failed load starts with no decisions', async () => {
    const t = setup();
    t.bridge.savePluginPermissions.mockRejectedValueOnce(new Error('disk'));
    const toast = vi.fn();
    t.controller.bindNotify(toast);
    const first = t.controller.authorize(plugin, both, 'paths.read');
    await flush();
    t.controller.answer('granted');
    await first;
    await flush();
    expect(toast).toHaveBeenCalledWith({ kind: 'error', message: expect.stringContaining('保存できませんでした') });
    expect(await t.controller.authorize(plugin, both, 'paths.read')).toBe('granted');

    const broken = setup();
    broken.bridge.loadPluginPermissions.mockRejectedValueOnce(new Error('unreadable'));
    await broken.controller.load();
    expect(broken.controller.getState()).toMatchObject({ loaded: true, decisions: {} });
  });

  it('notifies subscribers with a new state object on each change, and unbinding the notifier restores the first one', async () => {
    const t = setup();
    const states: unknown[] = [];
    const off = t.controller.subscribe(() => states.push(t.controller.getState()));
    const p = t.controller.authorize(plugin, both, 'paths.read');
    await flush();
    t.controller.answer('granted');
    await p;
    expect(new Set(states).size).toBe(states.length);
    off();
    const before = states.length;
    t.controller.revoke('copy-path');
    expect(states).toHaveLength(before);

    const unbind = t.controller.bindNotify(vi.fn());
    unbind();
  });

  it('ignores an answer when nothing is shown', () => {
    const t = setup();
    expect(() => t.controller.answer('granted')).not.toThrow();
    expect(t.saved).toEqual([]);
  });
});
