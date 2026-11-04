import { describe, expect, it, vi } from 'vitest';
import {
  PLUGIN_API_VERSION,
  createPluginRegistry,
  type ActionPlugin,
  type IsolatedPluginHost,
  type IsolatedPluginListener,
  type Plugin,
  type PluginManifest,
  type PluginRegistryOptions,
} from '.';

// 隔離した操作（段 2。tier が 'action'）の部品とレジストリ（ADR-005 の R5）。Worker を動かす仕組みは偽物（本物は src/plugin-host/）。

const manifest = (over: Partial<PluginManifest> = {}): PluginManifest => ({ id: 'copy-path', name: 'パスのコピー', version: '1.0.0', apiVersion: PLUGIN_API_VERSION, tier: 'action', ...over });
const action = (over: Partial<PluginManifest> = {}, source = 'api.registerCommand({})'): ActionPlugin => ({ manifest: manifest(over), source });
const editor = (id: string, shortcut?: string): Plugin => ({
  manifest: { id, name: id, version: '1', apiVersion: PLUGIN_API_VERSION, tier: 'editor' },
  activate: (ctx) => ctx.registerCommand({ id: 'c', title: 'c', ...(shortcut ? { shortcut } : {}), run: () => {} }),
});

function fakeHost() {
  const listeners = new Map<string, IsolatedPluginListener>();
  const host = {
    start: vi.fn((id: string, _source: string, l: IsolatedPluginListener) => void listeners.set(id, l)),
    run: vi.fn(),
    stop: vi.fn(),
    dispose: vi.fn(),
  } satisfies IsolatedPluginHost;
  return { host, listeners, listener: (id: string) => listeners.get(id)! };
}
const quiet = () => {
  const report = vi.fn<NonNullable<PluginRegistryOptions['report']>>();
  return { report, options: { report } };
};
const key = (k: string, extra: object = {}) => ({ key: k, code: `Key${k.toUpperCase()}`, metaKey: false, ctrlKey: true, altKey: false, shiftKey: false, ...extra });

describe('loading an action plugin', () => {
  it('starts its Worker with the source; nothing is registered until the Worker says so', () => {
    const f = fakeHost();
    const registry = createPluginRegistry([action({}, 'SOURCE')], { ...quiet().options, isolation: f.host });
    expect(f.host.start).toHaveBeenCalledWith('copy-path', 'SOURCE', expect.any(Object));
    expect(registry.records).toEqual([{ id: 'copy-path', name: 'パスのコピー', version: '1.0.0', status: 'active', reason: null }]);
    expect(registry.commands).toEqual([]);
  });

  it('registers the commands the Worker announces, with the shortcut, and runs them through the host without waiting', () => {
    const f = fakeHost();
    const registry = createPluginRegistry([action()], { ...quiet().options, isolation: f.host });
    f.listener('copy-path').onCommand({ id: 'copy', title: 'パスをコピー', shortcut: 'Mod+Alt+C'.replace('Alt+', ''), ignoreInTextEntry: true });
    const [command] = registry.commands;
    expect(command).toMatchObject({ pluginId: 'copy-path', id: 'copy-path.copy', title: 'パスをコピー', ignoreInTextEntry: true });
    expect(command!.shortcut).toMatchObject({ key: 'c', shift: false, text: 'Mod+C' });
    expect(registry.findCommandByKey(key('c'), false)).toBe(command);
    expect(registry.findCommandByKey(key('c', { ctrlKey: false, metaKey: true }), true)).toBe(command);
    expect(registry.findCommandByKey(key('c', { altKey: true }), false)).toBeNull();
    const result = command!.run({} as never);
    expect(result).toBeUndefined();
    expect(f.host.run).toHaveBeenCalledWith('copy-path', 'copy');
  });

  it('is incompatible when there is no isolation host, no source, a huge source, or declared permissions', () => {
    const { report, options } = quiet();
    const f = fakeHost();
    const withoutHost = createPluginRegistry([action()], options);
    expect(withoutHost.records[0]).toMatchObject({ status: 'incompatible', reason: expect.stringContaining('使えません') });
    const registry = createPluginRegistry(
      [
        action({ id: 'a' }, ''),
        action({ id: 'b' }, '   '),
        { manifest: manifest({ id: 'c' }) } as unknown as ActionPlugin,
        action({ id: 'd' }, 'x'.repeat(1024 * 1024 + 1)),
        { manifest: { ...manifest({ id: 'e' }), permissions: ['clipboard.write'] }, source: 'x' } as unknown as ActionPlugin,
        { manifest: { ...manifest({ id: 'f' }), permissions: [] }, source: 'x' } as unknown as ActionPlugin,
      ],
      { ...options, isolation: f.host },
    );
    expect(registry.records.map((r) => r.status)).toEqual(['incompatible', 'incompatible', 'incompatible', 'incompatible', 'incompatible', 'active']);
    expect(registry.records[4]!.reason).toContain('permissions');
    expect(f.host.start).toHaveBeenCalledTimes(1);
    expect(report).toHaveBeenCalledWith('warn', expect.stringContaining('読み込みません'));
  });

  it('rejects other tiers and checks the API version first', () => {
    const f = fakeHost();
    const registry = createPluginRegistry([action({ tier: 'view' as never }), action({ id: 'x', apiVersion: 99 })], { ...quiet().options, isolation: f.host });
    expect(registry.records.map((r) => r.status)).toEqual(['incompatible', 'incompatible']);
    expect(registry.records[1]!.reason).toContain('API の版');
    expect(f.host.start).not.toHaveBeenCalled();
  });

  it('does not load a second plugin with the same id (editor and action share the id space)', () => {
    const f = fakeHost();
    const registry = createPluginRegistry([editor('copy-path'), action()], { ...quiet().options, isolation: f.host });
    expect(registry.records.map((r) => r.status)).toEqual(['active', 'incompatible']);
    expect(f.host.start).not.toHaveBeenCalled();
  });

  it('a host that throws on start stops that plugin only', () => {
    const f = fakeHost();
    f.host.start.mockImplementationOnce(() => {
      throw new Error('iframe failed');
    });
    const { report, options } = quiet();
    const registry = createPluginRegistry([action({ id: 'a' }), action({ id: 'b' })], { ...options, isolation: f.host });
    expect(registry.records.map((r) => [r.status, r.reason])).toEqual([
      ['stopped', 'iframe failed'],
      ['active', null],
    ]);
    expect(report).toHaveBeenCalledWith('error', expect.stringContaining('「a」を止めました'), expect.any(Error));
  });
});

describe('shortcut and id rules are the same as for editor plugins', () => {
  it('a shortcut that clashes with an editor plugin command stops the action plugin, drops its commands, and terminates its Worker', () => {
    const f = fakeHost();
    const { report, options } = quiet();
    const registry = createPluginRegistry([editor('ed', 'Mod+Shift+F'), action()], { ...options, isolation: f.host });
    const l = f.listener('copy-path');
    l.onCommand({ id: 'first', title: 'first', shortcut: 'Mod+Shift+Y' });
    l.onCommand({ id: 'second', title: 'second', shortcut: 'Mod+Shift+F' });
    expect(registry.records[1]).toMatchObject({ status: 'stopped', reason: 'ショートカット Mod+Shift+F は「ed.c」が使っています' });
    expect(registry.commands.map((c) => c.id)).toEqual(['ed.c']);
    expect(f.host.stop).toHaveBeenCalledWith('copy-path');
    expect(report).toHaveBeenCalledWith('error', expect.stringContaining('「copy-path」を止めました'), expect.any(Error));
    // 止めたあとのコマンドは、キーに応えない。
    expect(registry.findCommandByKey(key('y', { shiftKey: true }), false)).toBeNull();
  });

  it('two action plugins cannot share a shortcut; the later announcement loses', () => {
    const f = fakeHost();
    const registry = createPluginRegistry([action({ id: 'a' }), action({ id: 'b' })], { ...quiet().options, isolation: f.host });
    f.listener('a').onCommand({ id: 'c', title: 'c', shortcut: 'Mod+Shift+Y' });
    f.listener('b').onCommand({ id: 'c', title: 'c', shortcut: 'Mod+Shift+Y' });
    expect(registry.records.map((r) => r.status)).toEqual(['active', 'stopped']);
    expect(registry.commands.map((c) => c.id)).toEqual(['a.c']);
  });

  it.each([
    ['a malformed shortcut', { id: 'c', title: 'c', shortcut: 'Ctrl+C' }],
    ['an empty title', { id: 'c', title: '' }],
    ['a duplicate id', { id: 'dup', title: 'c' }],
  ])('%s stops the plugin', (_name, command) => {
    const f = fakeHost();
    const registry = createPluginRegistry([action()], { ...quiet().options, isolation: f.host });
    f.listener('copy-path').onCommand({ id: 'dup', title: 'first' });
    f.listener('copy-path').onCommand(command);
    expect(registry.records[0]!.status).toBe('stopped');
    expect(registry.commands).toEqual([]);
  });
});

describe('stopping', () => {
  it('when the host stops the plugin (exception, time limit, bad message), its registrations are removed and the reason is recorded', () => {
    const f = fakeHost();
    const { report, options } = quiet();
    const registry = createPluginRegistry([editor('ed', 'Mod+Shift+T'), action({ id: 'a' }), action({ id: 'b' })], { ...options, isolation: f.host });
    f.listener('a').onCommand({ id: 'x', title: 'x', shortcut: 'Mod+Shift+Y' });
    f.listener('b').onCommand({ id: 'x', title: 'x', shortcut: 'Mod+Shift+K' });
    f.listener('a').onStopped('コマンド「x」が 5000 ミリ秒で終わりませんでした');
    expect(registry.records.map((r) => r.status)).toEqual(['active', 'stopped', 'active']);
    expect(registry.records[1]!.reason).toBe('コマンド「x」が 5000 ミリ秒で終わりませんでした');
    expect(registry.commands.map((c) => c.id)).toEqual(['ed.c', 'b.x']);
    expect(report).toHaveBeenCalledWith('error', expect.stringContaining('部品「a」を止めました: コマンド「x」が 5000'), expect.any(Error));
    // 止めた部品の run は何もしない。
    f.host.run.mockClear();
    // 止めたあとに届いた登録の通知は無視する。
    f.listener('a').onCommand({ id: 'late', title: 'late' });
    expect(registry.commands.map((c) => c.id)).toEqual(['ed.c', 'b.x']);
    expect(f.host.run).not.toHaveBeenCalled();
    // ほかの部品は動き続ける。
    registry.commands[1]!.run({} as never);
    expect(f.host.run).toHaveBeenCalledWith('b', 'x');
  });

  it('a command of a stopped plugin does nothing even if a caller kept a reference', () => {
    const f = fakeHost();
    const registry = createPluginRegistry([action()], { ...quiet().options, isolation: f.host });
    f.listener('copy-path').onCommand({ id: 'x', title: 'x' });
    const kept = registry.commands[0]!;
    f.listener('copy-path').onStopped('boom');
    kept.run({} as never);
    expect(f.host.run).not.toHaveBeenCalled();
  });

  it('dispose terminates the Workers of the plugins that are still running', () => {
    const f = fakeHost();
    const registry = createPluginRegistry([action({ id: 'a' }), action({ id: 'b' })], { ...quiet().options, isolation: f.host });
    registry.dispose();
    expect(f.host.stop.mock.calls.map((c) => c[0])).toEqual(['a', 'b']);
  });

  it('without action plugins the isolation host is never touched', () => {
    const f = fakeHost();
    createPluginRegistry([editor('ed')], { ...quiet().options, isolation: f.host });
    expect(f.host.start).not.toHaveBeenCalled();
    expect(f.host.stop).not.toHaveBeenCalled();
  });
});
