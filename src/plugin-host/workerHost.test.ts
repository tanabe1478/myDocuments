import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IsolatedCommandInfo, IsolatedPluginListener } from '../plugin-api';
import type { MainMessage } from './protocol';
import { createWorkerHost, type FrameHandle, type HostTrace } from './workerHost';

const IFRAME_WINDOW = { name: 'the-iframe-window' };
const OTHER_WINDOW = { name: 'another-window' };

function setup(options: { activateTimeoutMs?: number; runTimeoutMs?: number } = {}) {
  const posted: MainMessage[] = [];
  let handler: ((event: { source: unknown; data: unknown }) => void) | null = null;
  const events: HostTrace[] = [];
  const frame: FrameHandle & { disposed: boolean } = {
    disposed: false,
    post: (m) => posted.push(m),
    owns: (source) => source === IFRAME_WINDOW,
    dispose() {
      this.disposed = true;
    },
  };
  const createFrame = vi.fn(() => frame);
  const listen = vi.fn((h: typeof handler) => {
    handler = h;
    return () => {
      handler = null;
    };
  });
  const report = vi.fn();
  const host = createWorkerHost({ createFrame, listen: listen as never, trace: (e) => events.push(e), report, activateTimeoutMs: 1000, runTimeoutMs: 500, ...options });
  const fromIframe = (data: unknown) => handler?.({ source: IFRAME_WINDOW, data });
  const from = (source: unknown, data: unknown) => handler?.({ source, data });
  const listener = () => {
    const commands: IsolatedCommandInfo[] = [];
    const l = { onCommand: vi.fn((c: IsolatedCommandInfo) => void commands.push(c)), onReady: vi.fn(), onStopped: vi.fn() } satisfies IsolatedPluginListener;
    return Object.assign(l, { commands });
  };
  return { host, posted, fromIframe, from, createFrame, listen, frame, events, report, listener, hasHandler: () => handler !== null };
}

const hello = { v: 0, kind: 'hello' };
const ready = (plugin: string) => ({ v: 0, kind: 'ready', plugin });
const command = (plugin: string, id: string, extra: object = {}) => ({ v: 0, kind: 'command', plugin, id, title: id, ...extra });

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('no isolated plugin: nothing is created', () => {
  it('creates no iframe and no message listener until the first start', () => {
    const t = setup();
    expect(t.createFrame).not.toHaveBeenCalled();
    expect(t.listen).not.toHaveBeenCalled();
    expect(t.host.frameCreated).toBe(false);
    t.host.run('a', 'x');
    t.host.stop('a');
    t.host.dispose();
    expect(t.createFrame).not.toHaveBeenCalled();
    expect(t.posted).toEqual([]);
  });
});

describe('start', () => {
  it('creates the iframe once, and sends start after the relay says hello (not before)', () => {
    const t = setup();
    t.host.start('a', 'CODE-A', t.listener());
    t.host.start('b', 'CODE-B', t.listener());
    expect(t.createFrame).toHaveBeenCalledTimes(1);
    expect(t.host.frameCreated).toBe(true);
    expect(t.posted).toEqual([]);
    t.fromIframe(hello);
    expect(t.posted).toEqual([
      { v: 0, kind: 'start', plugin: 'a', source: 'CODE-A' },
      { v: 0, kind: 'start', plugin: 'b', source: 'CODE-B' },
    ]);
    t.fromIframe(hello);
    expect(t.posted).toHaveLength(2);
  });

  it('refuses a duplicate id and an oversized source', () => {
    const t = setup();
    t.host.start('a', 'x', t.listener());
    expect(() => t.host.start('a', 'y', t.listener())).toThrow();
    expect(() => t.host.start('b', 'x'.repeat(1024 * 1024 + 1), t.listener())).toThrow();
  });

  it('passes registered commands to the listener, then ready', () => {
    const t = setup();
    const l = t.listener();
    t.host.start('a', 'c', l);
    t.fromIframe(hello);
    t.fromIframe(command('a', 'copy', { shortcut: 'Mod+Alt+C', ignoreInTextEntry: true }));
    t.fromIframe(ready('a'));
    expect(l.commands).toEqual([{ id: 'copy', title: 'copy', shortcut: 'Mod+Alt+C', ignoreInTextEntry: true }]);
    expect(l.onReady).toHaveBeenCalledTimes(1);
    expect(l.onStopped).not.toHaveBeenCalled();
  });
});

describe('who may talk to the host (the source check)', () => {
  it('ignores messages whose event.source is not the iframe window, even when the shape and origin are right', () => {
    const t = setup();
    const l = t.listener();
    t.host.start('a', 'c', l);
    t.fromIframe(hello);
    t.from(OTHER_WINDOW, command('a', 'forged'));
    t.from(OTHER_WINDOW, ready('a'));
    t.from(null, ready('a'));
    t.from(undefined, ready('a'));
    t.from(IFRAME_WINDOW, ready('a'));
    expect(l.commands).toEqual([]);
    expect(l.onReady).toHaveBeenCalledTimes(1);
    // 偽の hello で、start を前倒しにできない。
    const t2 = setup();
    t2.host.start('a', 'c', t2.listener());
    t2.from(OTHER_WINDOW, hello);
    expect(t2.posted).toEqual([]);
  });

  it('ignores messages of the wrong shape (and does not stop anything: the plugin is not identified)', () => {
    const t = setup();
    const l = t.listener();
    t.host.start('a', 'c', l);
    t.fromIframe(hello);
    for (const data of ['ready', null, { kind: 'ready', plugin: 'a' }, { v: 0, kind: 'steal', plugin: 'a' }, { v: 0, kind: 'ready', plugin: 'a', extra: 1 }]) t.fromIframe(data);
    expect(l.onReady).not.toHaveBeenCalled();
    expect(l.onStopped).not.toHaveBeenCalled();
    expect(t.report).toHaveBeenCalled();
  });

  it('ignores messages about a plugin it does not know', () => {
    const t = setup();
    t.host.start('a', 'c', t.listener());
    t.fromIframe(hello);
    t.fromIframe(ready('ghost'));
    expect(t.events.filter((e) => e.type === 'ready')).toEqual([]);
  });
});

describe('violations stop the plugin (and only that plugin)', () => {
  const started = () => {
    const t = setup();
    const a = t.listener();
    const b = t.listener();
    t.host.start('a', 'ca', a);
    t.host.start('b', 'cb', b);
    t.fromIframe(hello);
    t.fromIframe(command('a', 'x'));
    t.fromIframe(command('b', 'x'));
    t.fromIframe(ready('a'));
    t.fromIframe(ready('b'));
    t.posted.length = 0;
    return { t, a, b };
  };

  it.each([
    ['a command after ready', (t: ReturnType<typeof setup>) => t.fromIframe(command('a', 'late'))],
    ['ready twice', (t: ReturnType<typeof setup>) => t.fromIframe(ready('a'))],
    ['done for a request that was never made', (t: ReturnType<typeof setup>) => t.fromIframe({ v: 0, kind: 'done', plugin: 'a', req: 99 })],
    ['failed for a request that was never made', (t: ReturnType<typeof setup>) => t.fromIframe({ v: 0, kind: 'failed', plugin: 'a', req: 99, reason: 'x' })],
  ])('%s', (_name, act) => {
    const { t, a, b } = started();
    act(t);
    expect(a.onStopped).toHaveBeenCalledTimes(1);
    expect(a.onStopped.mock.calls[0]![0]).toContain('不正なメッセージ');
    // 仲介に terminate させる。
    expect(t.posted).toEqual([{ v: 0, kind: 'stop', plugin: 'a' }]);
    expect(b.onStopped).not.toHaveBeenCalled();
    // 止めたあとは何も通さない。
    const before = t.events.length;
    t.fromIframe(command('a', 'more'));
    t.fromIframe({ v: 0, kind: 'done', plugin: 'a', req: 1 });
    t.host.run('a', 'x');
    expect(t.events.length).toBe(before);
    expect(t.posted).toHaveLength(1);
    expect(a.onStopped).toHaveBeenCalledTimes(1);
  });

  it('a duplicate command id while starting stops the plugin', () => {
    const t = setup();
    const l = t.listener();
    t.host.start('a', 'c', l);
    t.fromIframe(hello);
    t.fromIframe(command('a', 'x'));
    t.fromIframe(command('a', 'x'));
    expect(l.onStopped).toHaveBeenCalledTimes(1);
  });

  it('too many commands stop the plugin', () => {
    const t = setup();
    const l = t.listener();
    t.host.start('a', 'c', l);
    t.fromIframe(hello);
    for (let i = 0; i < 33; i++) t.fromIframe(command('a', `c${i}`));
    expect(l.commands).toHaveLength(32);
    expect(l.onStopped).toHaveBeenCalledTimes(1);
  });

  it('a listener that throws on a command stops the plugin with its message', () => {
    const t = setup();
    const l = t.listener();
    l.onCommand.mockImplementation(() => {
      throw new Error('shortcut clash');
    });
    t.host.start('a', 'c', l);
    t.fromIframe(hello);
    t.fromIframe(command('a', 'x'));
    expect(l.onStopped).toHaveBeenCalledWith('shortcut clash');
    expect(t.posted).toContainEqual({ v: 0, kind: 'stop', plugin: 'a' });
  });

  it('the relay reporting a stopped worker stops the plugin', () => {
    const { t, a, b } = started();
    t.fromIframe({ v: 0, kind: 'stopped', plugin: 'a', reason: '部品のコードで例外が出ました: boom' });
    expect(a.onStopped).toHaveBeenCalledWith('部品のコードで例外が出ました: boom');
    expect(b.onStopped).not.toHaveBeenCalled();
  });
});

describe('run: request numbers and the time limit', () => {
  const ready1 = () => {
    const t = setup();
    const l = t.listener();
    t.host.start('a', 'c', l);
    t.fromIframe(hello);
    t.fromIframe(command('a', 'x'));
    t.fromIframe(ready('a'));
    t.posted.length = 0;
    return { t, l };
  };

  it('numbers each request and clears the timer on done', () => {
    const { t, l } = ready1();
    t.host.run('a', 'x');
    t.host.run('a', 'x');
    expect(t.posted).toEqual([
      { v: 0, kind: 'run', plugin: 'a', req: 1, command: 'x' },
      { v: 0, kind: 'run', plugin: 'a', req: 2, command: 'x' },
    ]);
    t.fromIframe({ v: 0, kind: 'done', plugin: 'a', req: 1 });
    t.fromIframe({ v: 0, kind: 'done', plugin: 'a', req: 2 });
    vi.advanceTimersByTime(10_000);
    expect(l.onStopped).not.toHaveBeenCalled();
    expect(t.events.filter((e) => e.type === 'done')).toEqual([
      { type: 'done', plugin: 'a', command: 'x', req: 1 },
      { type: 'done', plugin: 'a', req: 2, command: 'x' },
    ]);
  });

  it('does not run an unknown command, or a plugin that is not ready, or one that was stopped', () => {
    const { t } = ready1();
    t.host.run('a', 'nope');
    t.host.run('ghost', 'x');
    expect(t.posted).toEqual([]);
    const t2 = setup();
    t2.host.start('a', 'c', t2.listener());
    t2.fromIframe(hello);
    t2.fromIframe(command('a', 'x'));
    t2.posted.length = 0;
    t2.host.run('a', 'x');
    expect(t2.posted).toEqual([]);
  });

  it('stops the plugin when the command does not finish in time, and terminates its worker', () => {
    const { t, l } = ready1();
    t.host.run('a', 'x');
    vi.advanceTimersByTime(499);
    expect(l.onStopped).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(l.onStopped).toHaveBeenCalledTimes(1);
    expect(l.onStopped.mock.calls[0]![0]).toContain('500 ミリ秒');
    expect(t.posted.at(-1)).toEqual({ v: 0, kind: 'stop', plugin: 'a' });
    // 遅れて届いた done は通さない。
    t.fromIframe({ v: 0, kind: 'done', plugin: 'a', req: 1 });
    expect(t.events.some((e) => e.type === 'done')).toBe(false);
  });

  it('stops the plugin when a command throws (failed)', () => {
    const { t, l } = ready1();
    t.host.run('a', 'x');
    t.fromIframe({ v: 0, kind: 'failed', plugin: 'a', req: 1, reason: 'boom' });
    expect(l.onStopped).toHaveBeenCalledWith('コマンド「x」が例外を出しました: boom');
    expect(t.posted.at(-1)).toEqual({ v: 0, kind: 'stop', plugin: 'a' });
  });

  it('drops run requests beyond the number of pending runs (key repeat does not pile up)', () => {
    const { t } = ready1();
    for (let i = 0; i < 40; i++) t.host.run('a', 'x');
    expect(t.posted).toHaveLength(16);
  });
});

describe('the time limit of the first run (activate)', () => {
  it('stops a plugin whose code never says ready', () => {
    const t = setup();
    const l = t.listener();
    t.host.start('a', 'for(;;){}', l);
    t.fromIframe(hello);
    vi.advanceTimersByTime(999);
    expect(l.onStopped).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(l.onStopped).toHaveBeenCalledTimes(1);
    expect(l.onStopped.mock.calls[0]![0]).toContain('最初の実行');
    expect(t.posted.at(-1)).toEqual({ v: 0, kind: 'stop', plugin: 'a' });
  });

  it('stops a plugin even when the relay never loads (no hello), and never sends its start', () => {
    const t = setup();
    const l = t.listener();
    t.host.start('a', 'c', l);
    vi.advanceTimersByTime(1000);
    expect(l.onStopped).toHaveBeenCalledTimes(1);
    t.fromIframe(hello);
    expect(t.posted).toEqual([]);
  });

  it('the activate timer is cleared by ready', () => {
    const t = setup();
    const l = t.listener();
    t.host.start('a', 'c', l);
    t.fromIframe(hello);
    t.fromIframe(ready('a'));
    vi.advanceTimersByTime(60_000);
    expect(l.onStopped).not.toHaveBeenCalled();
  });
});

describe('stop and dispose', () => {
  it('stop(id) terminates through the relay, does not notify the listener, and is idempotent', () => {
    const t = setup();
    const l = t.listener();
    t.host.start('a', 'c', l);
    t.fromIframe(hello);
    t.fromIframe(ready('a'));
    t.posted.length = 0;
    t.host.stop('a');
    t.host.stop('a');
    expect(t.posted).toEqual([{ v: 0, kind: 'stop', plugin: 'a' }]);
    expect(l.onStopped).not.toHaveBeenCalled();
  });

  it('dispose stops everything, removes the listener and the iframe', () => {
    const t = setup();
    t.host.start('a', 'c', t.listener());
    t.fromIframe(hello);
    t.host.dispose();
    expect(t.posted).toContainEqual({ v: 0, kind: 'stop', plugin: 'a' });
    expect(t.frame.disposed).toBe(true);
    expect(t.hasHandler()).toBe(false);
    expect(() => t.host.start('b', 'c', t.listener())).toThrow();
  });
});
