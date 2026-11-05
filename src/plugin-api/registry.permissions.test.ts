import { describe, expect, it, vi } from 'vitest';
import {
  PLUGIN_API_VERSION,
  createPluginRegistry,
  type ActionPlugin,
  type IsolatedPluginHost,
  type IsolatedPluginListener,
  type IsolatedServices,
  type Permission,
  type PermissionGate,
  type PermissionOutcome,
  type Plugin,
} from '.';

// R6: 段 2 の権限（宣言、確認、拒否）、ツリーの右クリックの項目、Alt つきのショートカット、起動の遅らせ方。Worker の仕組みは偽物。

const manifest = (over: Record<string, unknown> = {}) => ({ id: 'copy-path', name: 'パスをコピー', version: '1', apiVersion: PLUGIN_API_VERSION, tier: 'action', permissions: ['clipboard.write', 'paths.read'], ...over });
const action = (over: Record<string, unknown> = {}, source = 'x'): ActionPlugin => ({ manifest: manifest(over) as never, source });

function fakeHost() {
  const listeners = new Map<string, IsolatedPluginListener>();
  const released: string[] = [];
  const suspended: string[] = [];
  const host = {
    start: vi.fn((id: string, _s: string, l: IsolatedPluginListener) => void listeners.set(id, l)),
    run: vi.fn(),
    runMenu: vi.fn(),
    suspendTimeouts: vi.fn((id: string) => {
      suspended.push(id);
      return () => void released.push(id);
    }),
    stop: vi.fn(),
    dispose: vi.fn(),
  } satisfies IsolatedPluginHost;
  return { host, listeners, listener: (id = 'copy-path') => listeners.get(id)!, released, suspended };
}

function fakeGate(outcome: PermissionOutcome | (() => Promise<PermissionOutcome>) = 'granted') {
  const authorize = vi.fn(async (_p: { id: string; name: string }, _declared: readonly Permission[], _needed: Permission): Promise<PermissionOutcome> =>
    typeof outcome === 'function' ? outcome() : outcome,
  );
  return { authorize } satisfies PermissionGate;
}

const services = (over: Partial<IsolatedServices> = {}): IsolatedServices => ({ writeClipboardText: vi.fn(async () => {}), currentPath: () => '/docs/a.md', ...over });
const quiet = () => ({ report: vi.fn() });

function setup(gate = fakeGate(), over: Record<string, unknown> = {}, svc: IsolatedServices | null = services()) {
  const f = fakeHost();
  const registry = createPluginRegistry([action(over)], { ...quiet(), isolation: f.host, permissions: gate });
  if (svc) registry.bindServices(svc);
  return { ...f, registry, gate };
}

describe('declaring permissions', () => {
  it('loads an action plugin that declares known permissions, when a confirmation mechanism exists', () => {
    const t = setup();
    expect(t.registry.records[0]).toMatchObject({ status: 'active', reason: null });
    expect(t.host.start).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['an unknown permission', { permissions: ['clipboard.write', 'network'] }, 'network'],
    ['a duplicate permission', { permissions: ['paths.read', 'paths.read'] }, '重複'],
    ['a non-array', { permissions: 'paths.read' }, '配列'],
    ['a non-string entry', { permissions: [5] }, '知らない権限'],
    ['a permissions field on a tier 3 plugin', { tier: 'editor', permissions: [] }, '段 3'],
    ['a non-empty permissions on a tier 3 plugin', { tier: 'editor', permissions: ['paths.read'] }, '段 3'],
  ] as Array<[string, Record<string, unknown>, string]>)('does not load a plugin with %s, and says why', (_n, over, reason) => {
    const f = fakeHost();
    const report = vi.fn();
    const plugin = over.tier === 'editor' ? ({ manifest: manifest(over), activate: vi.fn() } as unknown as Plugin) : action(over);
    const registry = createPluginRegistry([plugin], { report, isolation: f.host, permissions: fakeGate() });
    expect(registry.records[0]).toMatchObject({ status: 'incompatible', reason: expect.stringContaining(reason) });
    expect(f.host.start).not.toHaveBeenCalled();
    expect(report).toHaveBeenCalledWith('warn', expect.stringContaining('読み込みません'));
    if (over.tier === 'editor') expect((plugin as { activate: unknown }).activate).not.toHaveBeenCalled();
  });

  it('without a confirmation mechanism, a declaration of permissions is refused (an empty declaration is fine)', () => {
    const f = fakeHost();
    const registry = createPluginRegistry([action({ id: 'a' }), action({ id: 'b', permissions: [] }), action({ id: 'c', permissions: undefined })], { ...quiet(), isolation: f.host });
    expect(registry.records.map((r) => r.status)).toEqual(['incompatible', 'active', 'active']);
    expect(registry.records[0]!.reason).toContain('permissions');
  });
});

describe('calling the host from a part (authorize, then the service)', () => {
  it('rejects a call to a permission that was not declared, without asking anyone', async () => {
    const gate = fakeGate();
    const t = setup(gate, { permissions: ['paths.read'] });
    const result = await t.listener().onCall!({ method: 'clipboardWriteText', text: 'x' });
    expect(result).toEqual({ ok: false, reason: expect.stringContaining('宣言していません') });
    expect(gate.authorize).not.toHaveBeenCalled();
    expect(t.suspended).toEqual([]);
    // 宣言のない部品は、どちらも拒否。
    const none = setup(fakeGate(), { permissions: [] });
    expect((await none.listener().onCall!({ method: 'currentPath' })).ok).toBe(false);
    expect(none.gate.authorize).not.toHaveBeenCalled();
  });

  it('after a grant, writes the text through the service and returns null; the permission asked about is clipboard.write', async () => {
    const svc = services();
    const t = setup(fakeGate('granted'), {}, svc);
    expect(await t.listener().onCall!({ method: 'clipboardWriteText', text: '/docs/a.md' })).toEqual({ ok: true, value: null });
    expect(svc.writeClipboardText).toHaveBeenCalledWith('/docs/a.md');
    expect(t.gate.authorize).toHaveBeenCalledWith({ id: 'copy-path', name: 'パスをコピー' }, ['clipboard.write', 'paths.read'], 'clipboard.write');
  });

  it('returns the current path (null for an unsaved document) after a grant of paths.read', async () => {
    let path: string | null = '/docs/a.md';
    const t = setup(fakeGate('granted'), {}, services({ currentPath: () => path }));
    expect(await t.listener().onCall!({ method: 'currentPath' })).toEqual({ ok: true, value: '/docs/a.md' });
    expect(t.gate.authorize).toHaveBeenLastCalledWith(expect.anything(), expect.anything(), 'paths.read');
    path = null;
    expect(await t.listener().onCall!({ method: 'currentPath' })).toEqual({ ok: true, value: null });
    path = `/${'a'.repeat(4096)}`;
    expect(await t.listener().onCall!({ method: 'currentPath' })).toEqual({ ok: false, reason: expect.stringContaining('長すぎ') });
  });

  it.each([
    ['denied', 'denied', '許可していません'],
    ['dismissed', 'dismissed', '閉じられた'],
  ] as const)('fails only that call when the outcome is %s: the service is not called and the part keeps running', async (_n, outcome, reason) => {
    const svc = services();
    const t = setup(fakeGate(outcome), {}, svc);
    expect(await t.listener().onCall!({ method: 'clipboardWriteText', text: 'x' })).toEqual({ ok: false, reason: expect.stringContaining(reason) });
    expect(await t.listener().onCall!({ method: 'currentPath' })).toEqual({ ok: false, reason: expect.stringContaining(reason) });
    expect(svc.writeClipboardText).not.toHaveBeenCalled();
    expect(t.registry.records[0]!.status).toBe('active');
    expect(t.host.stop).not.toHaveBeenCalled();
  });

  it('suspends the part time limits while the confirmation is pending, and resumes after it, also when it fails', async () => {
    let answer: (o: PermissionOutcome) => void = () => {};
    const t = setup(fakeGate(() => new Promise((resolve) => (answer = resolve))));
    const pending = t.listener().onCall!({ method: 'currentPath' });
    expect(t.suspended).toEqual(['copy-path']);
    expect(t.released).toEqual([]);
    answer('granted');
    await pending;
    expect(t.released).toEqual(['copy-path']);

    const failing = setup(fakeGate(() => Promise.reject(new Error('boom'))));
    await expect(failing.listener().onCall!({ method: 'currentPath' })).rejects.toThrow('boom');
    expect(failing.released).toEqual(['copy-path']);
  });

  it('fails when the services are not bound yet, when the service throws (no part stop), and when the part stopped meanwhile', async () => {
    const unbound = setup(fakeGate(), {}, null);
    expect(await unbound.listener().onCall!({ method: 'currentPath' })).toEqual({ ok: false, reason: expect.stringContaining('準備') });

    const throwing = setup(fakeGate(), {}, services({ writeClipboardText: async () => Promise.reject(new Error('/secret/path failed')) }));
    const r = await throwing.listener().onCall!({ method: 'clipboardWriteText', text: 'x' });
    expect(r).toEqual({ ok: false, reason: 'クリップボードに書けませんでした' });
    expect(JSON.stringify(r)).not.toContain('secret');
    expect(throwing.registry.records[0]!.status).toBe('active');

    let answer: (o: PermissionOutcome) => void = () => {};
    const stopping = setup(fakeGate(() => new Promise((resolve) => (answer = resolve))));
    const pending = stopping.listener().onCall!({ method: 'currentPath' });
    stopping.listener().onStopped('x');
    answer('granted');
    expect(await pending).toEqual({ ok: false, reason: expect.stringContaining('止まって') });
    expect(await stopping.listener().onCall!({ method: 'currentPath' })).toEqual({ ok: false, reason: expect.stringContaining('止まって') });
  });

  it('after unbinding, the services are gone (a later call fails)', async () => {
    const f = fakeHost();
    const registry = createPluginRegistry([action()], { ...quiet(), isolation: f.host, permissions: fakeGate() });
    const unbind = registry.bindServices(services());
    const other = registry.bindServices(services({ currentPath: () => '/other' }));
    unbind(); // 古い結びは、新しい結びを外さない
    expect(await f.listener().onCall!({ method: 'currentPath' })).toEqual({ ok: true, value: '/other' });
    other();
    expect((await f.listener().onCall!({ method: 'currentPath' })).ok).toBe(false);
  });
});

describe('context menu items of a part', () => {
  const item = { id: 'copy', title: 'パスをコピー', where: 'tree' as const };

  it('registers an item (needs paths.read declared), lists it after the host, and notifies subscribers with a new array each time', () => {
    const t = setup();
    const seen: unknown[] = [];
    t.registry.subscribe(() => seen.push(t.registry.menuItems));
    expect(t.registry.menuItems).toEqual([]);
    t.listener().onMenuItem!(item);
    expect(t.registry.menuItems).toEqual([expect.objectContaining({ pluginId: 'copy-path', id: 'copy-path.copy', title: 'パスをコピー', where: 'tree' })]);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toBe(t.registry.menuItems);
  });

  it('refuses the registration without a paths.read declaration: the listener throws, which stops the part', () => {
    const t = setup(fakeGate(), { permissions: ['clipboard.write'] });
    expect(() => t.listener().onMenuItem!(item)).toThrow('paths.read');
    expect(t.registry.menuItems).toEqual([]);
    const none = setup(fakeGate(), { permissions: [] });
    expect(() => none.listener().onMenuItem!(item)).toThrow('paths.read');
  });

  it('refuses an item id that another part already registered', () => {
    const f = fakeHost();
    const registry = createPluginRegistry([action(), action({ id: 'other' })], { ...quiet(), isolation: f.host, permissions: fakeGate() });
    f.listener('copy-path').onMenuItem!(item);
    f.listener('other').onMenuItem!(item); // 部品の id が違えば、別の項目
    expect(registry.menuItems.map((m) => m.id)).toEqual(['copy-path.copy', 'other.copy']);
    expect(() => f.listener('copy-path').onMenuItem!(item)).toThrow('登録済み');
  });

  it('runs the item only after paths.read is granted (the host sends runMenu with the target); a refusal or a closed confirmation does nothing', async () => {
    const t = setup(fakeGate('granted'));
    t.listener().onMenuItem!(item);
    const target = { path: '/work/a.md', kind: 'file' as const };
    await t.registry.menuItems[0]!.run(target);
    expect(t.gate.authorize).toHaveBeenCalledWith(expect.anything(), expect.anything(), 'paths.read');
    expect(t.host.runMenu).toHaveBeenCalledWith('copy-path', 'copy', target);
    expect(t.released).toEqual(['copy-path']);

    for (const outcome of ['denied', 'dismissed'] as const) {
      const refused = setup(fakeGate(outcome));
      refused.listener().onMenuItem!(item);
      await refused.registry.menuItems[0]!.run(target);
      expect(refused.host.runMenu).not.toHaveBeenCalled();
      expect(refused.registry.records[0]!.status).toBe('active');
    }
  });

  it('removes the items (and notifies) when the part stops, from a host stop, or from dispose; a stopped part never runs the item', async () => {
    const t = setup();
    t.listener().onMenuItem!(item);
    const stale = t.registry.menuItems[0]!;
    const listener = vi.fn();
    t.registry.subscribe(listener);
    t.listener().onStopped('例外');
    expect(t.registry.menuItems).toEqual([]);
    expect(listener).toHaveBeenCalledTimes(1);
    await stale.run({ path: '/p', kind: 'file' });
    expect(t.host.runMenu).not.toHaveBeenCalled();

    const d = setup();
    d.listener().onMenuItem!(item);
    d.registry.dispose();
    expect(d.registry.menuItems).toEqual([]);
  });

  it('does not throw from run when the gate throws (reported, not a part stop)', async () => {
    const f = fakeHost();
    const report = vi.fn();
    const registry = createPluginRegistry([action()], { report, isolation: f.host, permissions: fakeGate(() => Promise.reject(new Error('gate broke'))) });
    f.listener().onMenuItem!(item);
    await expect(registry.menuItems[0]!.run({ path: '/p', kind: 'folder' })).resolves.toBeUndefined();
    expect(report).toHaveBeenCalledWith('error', expect.stringContaining('メニューの項目'), expect.any(Error));
    expect(registry.records[0]!.status).toBe('active');
  });

  it('lets unsubscribers leave, and a throwing subscriber does not break the others', () => {
    const f = fakeHost();
    const report = vi.fn();
    const registry = createPluginRegistry([action()], { report, isolation: f.host, permissions: fakeGate() });
    const ok = vi.fn();
    registry.subscribe(() => {
      throw new Error('subscriber');
    });
    const off = registry.subscribe(ok);
    f.listener().onMenuItem!(item);
    expect(ok).toHaveBeenCalledTimes(1);
    off();
    f.listener().onStopped('x');
    expect(ok).toHaveBeenCalledTimes(1);
    expect(report).toHaveBeenCalledWith('error', expect.stringContaining('購読者'), expect.any(Error));
  });
});

describe('Alt shortcuts', () => {
  const key = (k: string, extra: object = {}) => ({ key: k, code: `Key${k.toUpperCase()}`, metaKey: false, ctrlKey: true, altKey: false, shiftKey: false, ...extra });

  it('a part command can use Mod+Alt+C; findCommandByKey matches it with Alt only', () => {
    const t = setup();
    t.listener().onCommand({ id: 'copy', title: 'コピー', shortcut: 'Mod+Alt+C' });
    const [command] = t.registry.commands;
    expect(command!.shortcut).toMatchObject({ key: 'c', alt: true, text: 'Mod+Alt+C' });
    expect(t.registry.findCommandByKey(key('c', { altKey: true }), false)).toBe(command);
    expect(t.registry.findCommandByKey(key('c'), false)).toBeNull();
    expect(t.registry.findCommandByKey(key('ç', { code: 'KeyC', altKey: true, ctrlKey: false, metaKey: true }), true)).toBe(command);
    // AltGr では発火しない。
    expect(t.registry.findCommandByKey({ ...key('ç', { code: 'KeyC', altKey: true }), getModifierState: () => true }, false)).toBeNull();
  });

  it('a clash with another Alt shortcut stops the part, and a tier 3 command still cannot use Alt', () => {
    const f = fakeHost();
    const report = vi.fn();
    const editor: Plugin = {
      manifest: { id: 'ed', name: 'ed', version: '1', apiVersion: PLUGIN_API_VERSION, tier: 'editor' },
      activate: (ctx) => ctx.registerCommand({ id: 'c', title: 'c', shortcut: 'Mod+Alt+C', run: () => {} }),
    };
    const registry = createPluginRegistry([editor, action(), action({ id: 'second' })], { report, isolation: f.host, permissions: fakeGate() });
    expect(registry.records[0]).toMatchObject({ status: 'stopped', reason: expect.stringContaining('invalid shortcut') });
    f.listener('copy-path').onCommand({ id: 'copy', title: 'c', shortcut: 'Mod+Alt+C' });
    f.listener('second').onCommand({ id: 'copy', title: 'c', shortcut: 'Mod+Alt+C' });
    expect(registry.records.map((r) => r.status)).toEqual(['stopped', 'active', 'stopped']);
    expect(registry.records[2]!.reason).toContain('Mod+Alt+C');
  });
});

describe('deferStart', () => {
  it('does not start a part until startDeferred, starts it once, and does nothing for a disposed registry', () => {
    const f = fakeHost();
    const registry = createPluginRegistry([action()], { ...quiet(), isolation: f.host, permissions: fakeGate(), deferStart: true });
    expect(f.host.start).not.toHaveBeenCalled();
    expect(registry.records[0]!.status).toBe('active');
    registry.startDeferred();
    registry.startDeferred();
    expect(f.host.start).toHaveBeenCalledTimes(1);

    const g = fakeHost();
    const disposed = createPluginRegistry([action()], { ...quiet(), isolation: g.host, permissions: fakeGate(), deferStart: true });
    disposed.dispose();
    disposed.startDeferred();
    expect(g.host.start).not.toHaveBeenCalled();
  });

  it('without deferStart the part starts when the registry is created (as in R5), and startDeferred does nothing', () => {
    const f = fakeHost();
    const registry = createPluginRegistry([action()], { ...quiet(), isolation: f.host, permissions: fakeGate() });
    expect(f.host.start).toHaveBeenCalledTimes(1);
    registry.startDeferred();
    expect(f.host.start).toHaveBeenCalledTimes(1);
  });
});
