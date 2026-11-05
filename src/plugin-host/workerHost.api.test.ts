import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IsolatedCall, IsolatedCallResult, IsolatedMenuItemInfo, IsolatedPluginListener } from '../plugin-api';
import type { MainMessage } from './protocol';
import { createWorkerHost, type FrameHandle, type HostTrace } from './workerHost';

// R6: 本体側の仕組み（workerHost）の、呼び出し（call → onCall → result）、メニューの項目、時間切れの一時停止。

const IFRAME_WINDOW = { name: 'the-iframe-window' };

function setup() {
  const posted: MainMessage[] = [];
  let handler: ((event: { source: unknown; data: unknown }) => void) | null = null;
  const events: HostTrace[] = [];
  const frame: FrameHandle = { post: (m) => posted.push(m), owns: (s) => s === IFRAME_WINDOW, dispose() {} };
  const host = createWorkerHost({
    createFrame: () => frame,
    listen: ((h: typeof handler) => {
      handler = h;
      return () => {};
    }) as never,
    trace: (e) => events.push(e),
    report: vi.fn(),
    activateTimeoutMs: 1000,
    runTimeoutMs: 500,
  });
  const fromIframe = (data: unknown) => handler?.({ source: IFRAME_WINDOW, data });
  let helloSent = false;
  /** 部品を起動する。最初の起動のあとに、仲介の hello を送る（iframe は最初の start で作られる）。 */
  const start = (id: string, source: string, l: IsolatedPluginListener) => {
    host.start(id, source, l);
    if (!helloSent) {
      helloSent = true;
      fromIframe({ v: 0, kind: 'hello' });
    }
  };
  const listener = (over: Partial<IsolatedPluginListener> = {}) => {
    const menu: IsolatedMenuItemInfo[] = [];
    const l: IsolatedPluginListener = { onCommand: vi.fn(), onReady: vi.fn(), onStopped: vi.fn(), onMenuItem: (i) => void menu.push(i), ...over };
    return Object.assign(l, { menu });
  };
  return { host, posted, fromIframe, events, listener, start };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

const ready = (plugin: string) => ({ v: 0, kind: 'ready', plugin });
const callMsg = (plugin: string, call: number, extra: object = { method: 'currentPath' }) => ({ v: 0, kind: 'call', plugin, call, ...extra });

describe('calls from a part', () => {
  it('hands the call to the listener and posts the result (success value, or the reason of a refusal) to the relay', async () => {
    const t = setup();
    const onCall = vi.fn(async (call: IsolatedCall): Promise<IsolatedCallResult> => (call.method === 'currentPath' ? { ok: true, value: '/docs/a.md' } : { ok: false, reason: '許可されていません' }));
    t.start('a', 'c', t.listener({ onCall }));
    t.fromIframe(callMsg('a', 1));
    t.fromIframe(callMsg('a', 2, { method: 'clipboardWriteText', text: '/docs/a.md' }));
    expect(onCall.mock.calls).toEqual([[{ method: 'currentPath' }], [{ method: 'clipboardWriteText', text: '/docs/a.md' }]]);
    await vi.advanceTimersByTimeAsync(0);
    const results = t.posted.filter((m) => m.kind === 'result');
    expect(results).toEqual([
      { v: 0, kind: 'result', plugin: 'a', call: 1, ok: true, value: '/docs/a.md' },
      { v: 0, kind: 'result', plugin: 'a', call: 2, ok: false, reason: '許可されていません' },
    ]);
    expect(t.events.filter((e) => e.type === 'call' || e.type === 'result')).toEqual([
      { type: 'call', plugin: 'a', method: 'currentPath', call: 1 },
      { type: 'call', plugin: 'a', method: 'clipboardWriteText', call: 2 },
      { type: 'result', plugin: 'a', method: 'currentPath', call: 1, ok: true },
      { type: 'result', plugin: 'a', method: 'clipboardWriteText', call: 2, ok: false },
    ]);
  });

  it('answers with a failure when the listener cannot handle calls or throws, without stopping the part', async () => {
    const t = setup();
    const noCalls = t.listener();
    t.start('a', 'c', noCalls);
    const throwing = t.listener({ onCall: () => Promise.reject(new Error('internal path /secret')) });
    t.start('b', 'c', throwing);
    t.fromIframe(callMsg('a', 1));
    t.fromIframe(callMsg('b', 1));
    await vi.advanceTimersByTimeAsync(0);
    const results = t.posted.filter((m) => m.kind === 'result') as Array<Extract<MainMessage, { kind: 'result' }>>;
    expect(results.map((r) => r.ok)).toEqual([false, false]);
    expect(JSON.stringify(results)).not.toContain('/secret');
    expect(noCalls.onStopped).not.toHaveBeenCalled();
    expect(throwing.onStopped).not.toHaveBeenCalled();
  });

  it('does not post a result for a part that was stopped while the call was waiting', async () => {
    const t = setup();
    let finish: (r: IsolatedCallResult) => void = () => {};
    const l = t.listener({ onCall: () => new Promise((resolve) => (finish = resolve)) });
    t.start('a', 'c', l);
    t.fromIframe(callMsg('a', 1));
    t.host.stop('a');
    finish({ ok: true, value: 'x' });
    await vi.advanceTimersByTimeAsync(0);
    expect(t.posted.filter((m) => m.kind === 'result')).toEqual([]);
  });

  it('stops the part on a call number that is still waiting, and on a 17th waiting call', async () => {
    const t = setup();
    const never = () => new Promise<IsolatedCallResult>(() => {});
    const dup = t.listener({ onCall: never });
    t.start('a', 'c', dup);
    t.fromIframe(callMsg('a', 1));
    t.fromIframe(callMsg('a', 1));
    expect(dup.onStopped).toHaveBeenCalledWith(expect.stringContaining('不正なメッセージ'));
    const many = t.listener({ onCall: never });
    t.start('b', 'c', many);
    for (let i = 1; i <= 17; i++) t.fromIframe(callMsg('b', i));
    expect(many.onStopped).toHaveBeenCalledWith(expect.stringContaining('不正なメッセージ'));
  });

  it('frees a number once its result is posted, so it can be used again', async () => {
    const t = setup();
    const l = t.listener({ onCall: async () => ({ ok: true, value: null }) });
    t.start('a', 'c', l);
    t.fromIframe(callMsg('a', 1));
    await vi.advanceTimersByTimeAsync(0);
    t.fromIframe(callMsg('a', 1));
    await vi.advanceTimersByTimeAsync(0);
    expect(l.onStopped).not.toHaveBeenCalled();
    expect(t.posted.filter((m) => m.kind === 'result')).toHaveLength(2);
  });
});

describe('menu items', () => {
  it('passes a registered item to the listener, and sends runMenu with the target only for a registered item after ready', () => {
    const t = setup();
    const l = t.listener();
    t.start('a', 'c', l);
    t.fromIframe({ v: 0, kind: 'menu', plugin: 'a', id: 'copy', title: 'コピー', where: 'tree' });
    expect(l.menu).toEqual([{ id: 'copy', title: 'コピー', where: 'tree' }]);
    t.host.runMenu?.('a', 'copy', { path: '/w/a.md', kind: 'file' });
    expect(t.posted.some((m) => m.kind === 'runMenu')).toBe(false);
    t.fromIframe(ready('a'));
    t.host.runMenu?.('a', 'nope', { path: '/w/a.md', kind: 'file' });
    t.host.runMenu?.('a', 'copy', { path: '', kind: 'file' });
    t.host.runMenu?.('a', 'copy', { path: 'x'.repeat(4097), kind: 'file' });
    expect(t.posted.some((m) => m.kind === 'runMenu')).toBe(false);
    t.host.runMenu?.('a', 'copy', { path: '/w/dir', kind: 'folder' });
    expect(t.posted.at(-1)).toEqual({ v: 0, kind: 'runMenu', plugin: 'a', req: 1, item: 'copy', path: '/w/dir', targetKind: 'folder' });
    // 結果は、コマンドと同じ done。
    t.fromIframe({ v: 0, kind: 'done', plugin: 'a', req: 1 });
    expect(t.events.filter((e) => e.type === 'done')).toEqual([{ type: 'done', plugin: 'a', command: 'menu:copy', req: 1 }]);
    expect(l.onStopped).not.toHaveBeenCalled();
  });

  it('stops the part when the listener cannot take menu items, when an id repeats, or when the listener throws', () => {
    const t = setup();
    const without = t.listener({ onMenuItem: undefined });
    t.start('a', 'c', without);
    t.fromIframe({ v: 0, kind: 'menu', plugin: 'a', id: 'x', title: 't', where: 'tree' });
    expect(without.onStopped).toHaveBeenCalledWith(expect.stringContaining('使えません'));

    const dup = t.listener();
    t.start('b', 'c', dup);
    t.fromIframe({ v: 0, kind: 'menu', plugin: 'b', id: 'x', title: 't', where: 'tree' });
    t.fromIframe({ v: 0, kind: 'menu', plugin: 'b', id: 'x', title: 't', where: 'tree' });
    expect(dup.onStopped).toHaveBeenCalledWith(expect.stringContaining('重なって'));

    const throwing = t.listener({
      onMenuItem: () => {
        throw new Error('paths.read の宣言が要ります');
      },
    });
    t.start('c', 'c', throwing);
    t.fromIframe({ v: 0, kind: 'menu', plugin: 'c', id: 'x', title: 't', where: 'tree' });
    expect(throwing.onStopped).toHaveBeenCalledWith('paths.read の宣言が要ります');
  });

  it('rejects a menu item after ready', () => {
    const t = setup();
    const l = t.listener();
    t.start('a', 'c', l);
    t.fromIframe(ready('a'));
    t.fromIframe({ v: 0, kind: 'menu', plugin: 'a', id: 'x', title: 't', where: 'tree' });
    expect(l.onStopped).toHaveBeenCalledWith(expect.stringContaining('最初の実行のあと'));
  });
});

describe('suspending the time limits while a confirmation is shown', () => {
  it('pauses a pending run and resumes it with the remaining time', () => {
    const t = setup();
    const l = t.listener();
    t.start('a', 'c', l);
    t.fromIframe({ v: 0, kind: 'command', plugin: 'a', id: 'x', title: 'x' });
    t.fromIframe(ready('a'));
    t.host.run('a', 'x');
    vi.advanceTimersByTime(300);
    const release = t.host.suspendTimeouts!('a');
    vi.advanceTimersByTime(60_000);
    expect(l.onStopped).not.toHaveBeenCalled();
    release();
    vi.advanceTimersByTime(199);
    expect(l.onStopped).not.toHaveBeenCalled();
    vi.advanceTimersByTime(2);
    expect(l.onStopped).toHaveBeenCalledWith(expect.stringContaining('500 ミリ秒'));
  });

  it('pauses the first-run limit too, counts nested suspensions, and a release is idempotent', () => {
    const t = setup();
    const l = t.listener();
    t.start('a', 'c', l);
    vi.advanceTimersByTime(900);
    const r1 = t.host.suspendTimeouts!('a');
    const r2 = t.host.suspendTimeouts!('a');
    vi.advanceTimersByTime(10_000);
    r1();
    r1();
    vi.advanceTimersByTime(10_000);
    expect(l.onStopped).not.toHaveBeenCalled();
    r2();
    vi.advanceTimersByTime(99);
    expect(l.onStopped).not.toHaveBeenCalled();
    vi.advanceTimersByTime(2);
    expect(l.onStopped).toHaveBeenCalledWith(expect.stringContaining('最初の実行'));
  });

  it('starts counting a run that was requested while suspended only after the release', () => {
    const t = setup();
    const l = t.listener();
    t.start('a', 'c', l);
    t.fromIframe({ v: 0, kind: 'command', plugin: 'a', id: 'x', title: 'x' });
    t.fromIframe(ready('a'));
    const release = t.host.suspendTimeouts!('a');
    t.host.run('a', 'x');
    vi.advanceTimersByTime(10_000);
    expect(l.onStopped).not.toHaveBeenCalled();
    release();
    vi.advanceTimersByTime(501);
    expect(l.onStopped).toHaveBeenCalled();
  });

  it('does nothing for an unknown or stopped part', () => {
    const t = setup();
    expect(() => t.host.suspendTimeouts!('ghost')()).not.toThrow();
    const l = t.listener();
    t.start('a', 'c', l);
    t.host.stop('a');
    expect(() => t.host.suspendTimeouts!('a')()).not.toThrow();
  });
});
