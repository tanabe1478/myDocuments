import { describe, expect, it, vi } from 'vitest';
import {
  PLUGIN_API_VERSION,
  createPluginRegistry,
  type ActionPlugin,
  type IsolatedPluginHost,
  type IsolatedPluginListener,
  type Plugin,
  type PluginContext,
  type PluginRegistryOptions,
} from '.';

// アプリのログ（ADR-007）に対する、レジストリの口: 部品が止められたこと（plugin.stopped）と、段 3 の部品の ctx.log。

const editor = (id: string, activate: (ctx: PluginContext) => void | (() => void)): Plugin => ({
  manifest: { id, name: id, version: '1', apiVersion: PLUGIN_API_VERSION, tier: 'editor' },
  activate,
});
const logCalls = () => {
  const log = vi.fn<NonNullable<PluginRegistryOptions['log']>>();
  return { log, options: { log, report: vi.fn() } };
};

describe('plugin.stopped', () => {
  it('records the id and the reason when an editor plugin throws in activate', () => {
    const l = logCalls();
    createPluginRegistry(
      [
        editor('broken', () => {
          throw new Error('activate failed');
        }),
      ],
      l.options,
    );
    expect(l.log).toHaveBeenCalledWith('error', 'plugin', 'stopped', { id: 'broken', reason: 'activate failed' });
  });

  it('records it when a command throws later (the plugin is stopped at that moment)', () => {
    const l = logCalls();
    const registry = createPluginRegistry(
      [
        editor('demo', (ctx) =>
          ctx.registerCommand({
            id: 'boom',
            title: 'boom',
            run: () => {
              throw new Error('command failed');
            },
          }),
        ),
      ],
      l.options,
    );
    expect(l.log).not.toHaveBeenCalled();
    registry.commands[0]!.run({} as never);
    expect(l.log).toHaveBeenCalledTimes(1);
    expect(l.log).toHaveBeenCalledWith('error', 'plugin', 'stopped', { id: 'demo', reason: 'command failed' });
    // 止まった部品は、もう一度止めない（記録も 1 回）。
    expect(l.log).toHaveBeenCalledTimes(1);
  });

  it('records the stop of an isolated plugin that the host reports (timeout, bad message) with the reason', () => {
    const l = logCalls();
    const listeners = new Map<string, IsolatedPluginListener>();
    const host = {
      start: vi.fn((id: string, _s: string, listener: IsolatedPluginListener) => void listeners.set(id, listener)),
      run: vi.fn(),
      stop: vi.fn(),
      dispose: vi.fn(),
    } satisfies IsolatedPluginHost;
    const plugin: ActionPlugin = {
      manifest: { id: 'copy-path', name: 'c', version: '1', apiVersion: PLUGIN_API_VERSION, tier: 'action' },
      source: 'api.registerCommand({})',
    };
    createPluginRegistry([plugin], { ...l.options, isolation: host });
    listeners.get('copy-path')!.onStopped('時間切れ（5000ms）');
    expect(l.log).toHaveBeenCalledWith('error', 'plugin', 'stopped', { id: 'copy-path', reason: '時間切れ（5000ms）' });
  });

  it('does not record dispose (a normal shutdown), a plugin that is not loaded, or a healthy plugin', () => {
    const l = logCalls();
    const registry = createPluginRegistry(
      [editor('ok', (ctx) => void ctx.registerCommand({ id: 'c', title: 'c', run: () => {} })), { manifest: { id: 'Bad Id' } } as unknown as Plugin],
      l.options,
    );
    registry.dispose();
    expect(l.log).not.toHaveBeenCalled();
  });

  it('a throwing log function does not break the registry', () => {
    const registry = createPluginRegistry(
      [
        editor('broken', () => {
          throw new Error('x');
        }),
      ],
      {
        report: () => {},
        log: () => {
          throw new Error('log is broken');
        },
      },
    );
    expect(registry.records[0]).toMatchObject({ id: 'broken', status: 'stopped' });
  });

  it('works without a log option', () => {
    expect(() =>
      createPluginRegistry([editor('broken', () => { throw new Error('x'); })], { report: () => {} }),
    ).not.toThrow();
  });
});

describe('ctx.log (for editor-tier plugins)', () => {
  it('records with the plugin id as the source', () => {
    const l = logCalls();
    createPluginRegistry(
      [
        editor('typing-sound', (ctx) => {
          ctx.log('warn', 'clock.stalled', { elapsed_ms: 600 });
          ctx.log('info', 'plain');
        }),
        editor('other', (ctx) => ctx.log('error', 'oops', { a: true, b: null, c: 'text' })),
      ],
      l.options,
    );
    expect(l.log.mock.calls).toEqual([
      ['warn', 'typing-sound', 'clock.stalled', { elapsed_ms: 600 }],
      ['info', 'typing-sound', 'plain', undefined],
      ['error', 'other', 'oops', { a: true, b: null, c: 'text' }],
    ]);
  });

  it('is a no-op when the registry has no log option (a plugin can always call it)', () => {
    let called = false;
    createPluginRegistry([editor('p', (ctx) => { ctx.log('info', 'x'); called = true; })], { report: () => {} });
    expect(called).toBe(true);
  });

  it('never throws into the plugin, even if the host logger throws', () => {
    const registry = createPluginRegistry(
      [editor('p', (ctx) => ctx.log('info', 'x'))],
      { report: () => {}, log: () => { throw new Error('boom'); } },
    );
    expect(registry.records[0]!.status).toBe('active');
  });
});
