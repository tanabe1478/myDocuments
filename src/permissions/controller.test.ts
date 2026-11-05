import { describe, expect, it, vi } from 'vitest';
import type { PluginPermissionsFile } from '../plugin-api';
import { PermissionController } from './controller';

// 権限の決定と確認の画面の状態（R6、R6b）。保存は偽の bridge。確認の画面は、利用者の操作で始まった実行（beginRun）の中でだけ出る。

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
/** 利用者の操作で始まった、部品の実行を 1 つ開く（戻り値で終える）。 */
const startRun = (t: ReturnType<typeof setup>, id = 'copy-path') => t.controller.beginRun(id);

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
    startRun(t);
    const result = t.controller.authorize(plugin, both, 'clipboard.write');
    await flush();
    expect(t.controller.getState().prompt).toEqual({ pluginId: 'copy-path', pluginName: 'パスをコピー', permissions: ['clipboard.write'] });
    t.controller.answer('granted');
    expect(await result).toBe('granted');
    expect(t.controller.getState().prompt).toBeNull();
    expect(t.saved.at(-1)).toEqual({ version: 1, plugins: { 'copy-path': { 'paths.read': 'granted', 'clipboard.write': 'granted' } } });

    const fresh = setup();
    startRun(fresh);
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
    const end = startRun(t);
    const first = t.controller.authorize(plugin, both, 'paths.read');
    await flush();
    t.controller.answer('dismissed');
    expect(await first).toBe('dismissed');
    expect(t.saved).toEqual([]);
    expect(t.controller.getState().decisions).toEqual({});
    end();
    startRun(t);
    const again = t.controller.authorize(plugin, both, 'paths.read');
    await flush();
    expect(t.controller.getState().prompt).not.toBeNull();
    t.controller.answer('granted');
    expect(await again).toBe('granted');
  });

  it('does not stack a second confirmation for the same part: waiting calls follow the one answer (and a dismissal dismisses them all)', async () => {
    const t = setup();
    startRun(t);
    const a = t.controller.authorize(plugin, both, 'paths.read');
    const b = t.controller.authorize(plugin, both, 'clipboard.write');
    await flush();
    expect(t.bridge.loadPluginPermissions).toHaveBeenCalledTimes(1);
    t.controller.answer('granted');
    expect(await Promise.all([a, b])).toEqual(['granted', 'granted']);
    expect(t.saved).toHaveLength(1);

    const u = setup();
    startRun(u);
    const c = u.controller.authorize(plugin, both, 'paths.read');
    const d = u.controller.authorize(plugin, both, 'clipboard.write');
    await flush();
    u.controller.answer('dismissed');
    expect(await Promise.all([c, d])).toEqual(['dismissed', 'dismissed']);
  });

  it('shows the confirmations of different parts one at a time, in order', async () => {
    const t = setup();
    startRun(t, 'one');
    startRun(t, 'two');
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
    startRun(t);
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
    startRun(t);
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
    // 読めなかったことは覚えない（loaded は false のまま。次に必要になったとき読み直す）。
    expect(broken.controller.getState()).toMatchObject({ loaded: false, decisions: {} });
  });

  it('notifies subscribers with a new state object on each change, and unbinding the notifier restores the first one', async () => {
    const t = setup();
    const states: unknown[] = [];
    const off = t.controller.subscribe(() => states.push(t.controller.getState()));
    startRun(t);
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

  describe('confirmation only inside a user-initiated run, once per run (R6b)', () => {
    it('refuses (not-asked) without showing the confirmation when no run is open: outside a run, at startup, in activate; decided permissions still answer', async () => {
      const t = setup({ version: 1, plugins: { 'copy-path': { 'paths.read': 'granted' } } });
      expect(await t.controller.authorize(plugin, both, 'clipboard.write')).toBe('not-asked');
      expect(t.controller.getState().prompt).toBeNull();
      expect(await t.controller.authorize(plugin, both, 'paths.read')).toBe('granted');
      expect(t.saved).toEqual([]);
      // 別の部品の実行は、この部品の画面の権利にならない。
      startRun(t, 'other');
      expect(await t.controller.authorize(plugin, both, 'clipboard.write')).toBe('not-asked');
      expect(t.controller.getState().prompt).toBeNull();
    });

    it('shows the confirmation at most once per run: after a dismissal, the same run gets not-asked; the next run asks again', async () => {
      const t = setup();
      const end = startRun(t);
      const first = t.controller.authorize(plugin, both, 'paths.read');
      await flush();
      expect(t.controller.getState().prompt).not.toBeNull();
      t.controller.answer('dismissed');
      expect(await first).toBe('dismissed');
      // Esc のあとに、同じ実行の中で、画面を繰り返し出させられない。
      expect(await t.controller.authorize(plugin, both, 'paths.read')).toBe('not-asked');
      expect(await t.controller.authorize(plugin, both, 'clipboard.write')).toBe('not-asked');
      expect(t.controller.getState().prompt).toBeNull();
      end();
      // 実行が終わったあとの呼び出しは、画面なし。
      expect(await t.controller.authorize(plugin, both, 'paths.read')).toBe('not-asked');
      // 次の利用者の操作では、また聞く。
      startRun(t);
      const next = t.controller.authorize(plugin, both, 'paths.read');
      await flush();
      expect(t.controller.getState().prompt).not.toBeNull();
      t.controller.answer('granted');
      expect(await next).toBe('granted');
    });

    it('a second run of the same part does not add a screen while the first one is showing (calls wait for the one answer); each run has its own single screen', async () => {
      const t = setup();
      startRun(t);
      const a = t.controller.authorize(plugin, both, 'paths.read');
      await flush();
      expect(t.controller.getState().prompt).not.toBeNull();
      // 画面が出ている間に、同じ実行の 2 つ目の呼び出し（Promise.all など）が来ても、画面は重ならず、同じ答えに従う。
      const b = t.controller.authorize(plugin, both, 'clipboard.write');
      t.controller.answer('denied');
      expect(await Promise.all([a, b])).toEqual(['denied', 'denied']);
      expect(t.saved).toHaveLength(1);
    });

    it('a call outside any run does not ride on a screen that a run opened, and does not open one', async () => {
      const t = setup();
      const end = startRun(t);
      const inside = t.controller.authorize(plugin, both, 'paths.read');
      await flush();
      end();
      expect(await t.controller.authorize(plugin, both, 'clipboard.write')).toBe('not-asked');
      t.controller.answer('granted');
      expect(await inside).toBe('granted');
    });

    it('ending a run twice, or ending one of two runs, keeps the other open', async () => {
      const t = setup();
      const one = startRun(t);
      startRun(t);
      one();
      one();
      const result = t.controller.authorize(plugin, both, 'paths.read');
      await flush();
      expect(t.controller.getState().prompt).not.toBeNull();
      t.controller.answer('granted');
      expect(await result).toBe('granted');
    });
  });

  describe('a failed load never overwrites the saved decisions (R6b)', () => {
    it('does not remember the failure: the next authorize reads again, and a successful read lets the next decision be saved together with what the file had', async () => {
      const t = setup({ version: 1, plugins: { other: { 'paths.read': 'denied' } } });
      // 確認の画面に答えたあと、authorize はもう一度読む（決定を確かめ直すため）ので、2 回続けて失敗させる。
      t.bridge.loadPluginPermissions.mockRejectedValueOnce(new Error('unreadable')).mockRejectedValueOnce(new Error('unreadable'));
      startRun(t);
      // 1 回目: 読めない。確認の結果は今回だけのもので、保存しない。
      const toast = vi.fn();
      t.controller.bindNotify(toast);
      const first = t.controller.authorize(plugin, both, 'paths.read');
      await flush();
      expect(t.controller.getState().prompt).not.toBeNull();
      t.controller.answer('granted');
      expect(await first).toBe('granted');
      await flush();
      expect(t.bridge.savePluginPermissions).not.toHaveBeenCalled();
      expect(toast).toHaveBeenCalledWith({ kind: 'error', message: expect.stringContaining('保存しません') });
      expect(t.controller.getState()).toMatchObject({ loaded: false });
      // 今回の起動の間は、決めたとおりに扱う（読み直しても聞き直さない）。
      expect(await t.controller.authorize(plugin, both, 'paths.read')).toBe('granted');
      // 2 回目に読み直して成功した（ファイルの中身が見えた）。
      expect(t.bridge.loadPluginPermissions).toHaveBeenCalledTimes(3);
      expect(t.controller.getState()).toMatchObject({ loaded: true });
      expect(t.controller.getState().decisions).toEqual({ other: { 'paths.read': 'denied' }, 'copy-path': { 'paths.read': 'granted', 'clipboard.write': 'granted' } });
      // 読めなかったあいだの結果は、保存の対象にならない。別の部品の決定は、ファイルの内容に足して保存される。
      startRun(t, 'newer');
      const second = t.controller.authorize({ id: 'newer', name: 'newer' }, ['paths.read'], 'paths.read');
      await flush();
      t.controller.answer('denied');
      expect(await second).toBe('denied');
      await flush();
      expect(t.saved).toEqual([{ version: 1, plugins: { other: { 'paths.read': 'denied' }, newer: { 'paths.read': 'denied' } } }]);
    });

    it('while the load keeps failing, every decision is for this run only and nothing is written; revoking does not write either', async () => {
      const t = setup();
      t.bridge.loadPluginPermissions.mockRejectedValue(new Error('unreadable'));
      startRun(t);
      const first = t.controller.authorize(plugin, both, 'paths.read');
      await flush();
      t.controller.answer('denied');
      expect(await first).toBe('denied');
      expect(await t.controller.authorize(plugin, both, 'clipboard.write')).toBe('denied');
      t.controller.revoke('copy-path');
      await flush();
      expect(t.controller.getState().decisions).toEqual({});
      expect(t.bridge.savePluginPermissions).not.toHaveBeenCalled();
      expect(t.bridge.loadPluginPermissions.mock.calls.length).toBeGreaterThanOrEqual(3);
    });

    it('a missing file and a broken file are read as empty (not a failure), as the native side returns them', async () => {
      const t = setup({ version: 1, plugins: {} });
      t.bridge.loadPluginPermissions.mockResolvedValueOnce({ version: 2, plugins: 'broken' } as unknown as PluginPermissionsFile);
      startRun(t);
      const first = t.controller.authorize(plugin, both, 'paths.read');
      await flush();
      t.controller.answer('granted');
      expect(await first).toBe('granted');
      await flush();
      expect(t.controller.getState().loaded).toBe(true);
      expect(t.saved).toHaveLength(1);
    });
  });

  it('ignores an answer when nothing is shown', () => {
    const t = setup();
    expect(() => t.controller.answer('granted')).not.toThrow();
    expect(t.saved).toEqual([]);
  });
});
