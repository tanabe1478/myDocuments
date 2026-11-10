// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CLOCK_CHECK_MS, CLOCK_JUMP_MS, installAppDiagnostics } from './diagnostics';
import { createLogger } from './logger';
import type { LogEntry } from './types';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function setup(enabled = true) {
  const calls: LogEntry[][] = [];
  const logger = createLogger({ append: async (e) => void calls.push([...e]) });
  if (enabled) logger.setEnabled(true);
  const clock = { t: 1_000_000 };
  const timers: Array<{ fn: () => void; ms: number; id: number }> = [];
  let nextId = 1;
  const doc = document.implementation.createHTMLDocument('x');
  const target = new EventTarget();
  const docTarget = new EventTarget();
  let visibility: DocumentVisibilityState = 'visible';
  const env = {
    window: target as unknown as Window,
    document: Object.defineProperty(docTarget, 'visibilityState', { get: () => visibility }) as unknown as Document,
    now: () => clock.t,
    setInterval: (fn: () => void, ms: number) => {
      const id = nextId++;
      timers.push({ fn, ms, id });
      return id;
    },
    clearInterval: (handle: unknown) => {
      const i = timers.findIndex((t) => t.id === handle);
      if (i >= 0) timers.splice(i, 1);
    },
  };
  void doc;
  const dispose = installAppDiagnostics(logger, env);
  /** 前に取った後に、渡された分。 */
  let taken = 0;
  const entries = () => {
    logger.flush();
    const all = calls.flat();
    const fresh = all.slice(taken);
    taken = all.length;
    return fresh;
  };
  return { logger, target, docTarget, clock, timers, dispose, entries, setVisibility: (v: DocumentVisibilityState) => (visibility = v) };
}

function errorEvent(init: { message?: string; filename?: string; lineno?: number; colno?: number; error?: unknown }): Event {
  return Object.assign(new Event('error'), init);
}

describe('uncaught errors', () => {
  it('records an uncaught exception: the error name, the message cut to 300 chars, the file base name and the line', async () => {
    const h = setup();
    h.target.dispatchEvent(
      errorEvent({
        message: 'Uncaught Error: boom',
        filename: 'tauri://localhost/assets/index-AbC123.js?x=1',
        lineno: 120,
        colno: 7,
        error: new RangeError(`boom at /Users/alice/Documents/a.md ${'z'.repeat(400)}`),
      }),
    );
    await vi.advanceTimersByTimeAsync(0);
    const [entry] = h.entries();
    expect(entry).toMatchObject({ level: 'error', source: 'app', event: 'uncaught-error' });
    expect(entry!.data).toMatchObject({ error: 'RangeError', file: 'index-AbC123.js', line: 120, column: 7 });
    expect((entry!.data.message as string).startsWith('boom at ~/Documents/a.md')).toBe(true);
    expect((entry!.data.message as string).length).toBe(300);
    expect(JSON.stringify(entry)).not.toContain('alice');
    expect(JSON.stringify(entry)).not.toContain('tauri://');
  });

  it('uses the event message when no error object is attached, and null for the missing file and line', () => {
    const h = setup();
    h.target.dispatchEvent(errorEvent({ message: 'Script error.', filename: '', lineno: 0 }));
    expect(h.entries()[0]!.data).toMatchObject({ error: 'string', message: 'Script error.', file: null, line: null, column: null });
  });

  it('records an unhandled promise rejection with the reason kind and the cut message', () => {
    const h = setup();
    h.target.dispatchEvent(Object.assign(new Event('unhandledrejection'), { reason: new TypeError('nope /home/bob/x') }));
    h.target.dispatchEvent(Object.assign(new Event('unhandledrejection'), { reason: 'plain reason' }));
    const [a, b] = h.entries();
    expect(a).toMatchObject({ level: 'error', source: 'app', event: 'unhandled-rejection', data: { error: 'TypeError', message: 'nope ~/x' } });
    expect(b!.data).toEqual({ error: 'string', message: 'plain reason' });
  });
});

describe('visibilitychange', () => {
  it('records hidden and visible', () => {
    const h = setup();
    h.setVisibility('hidden');
    h.docTarget.dispatchEvent(new Event('visibilitychange'));
    h.setVisibility('visible');
    h.docTarget.dispatchEvent(new Event('visibilitychange'));
    expect(h.entries().map((e) => [e.level, e.source, e.event, e.data])).toEqual([
      ['info', 'app', 'visibility', { state: 'hidden' }],
      ['info', 'app', 'visibility', { state: 'visible' }],
    ]);
  });
});

describe('clock jump (every 10 s; 30 s or more beyond the expected interval)', () => {
  it('checks every 10 seconds and records the jump in seconds when the wall clock moved 30 s or more beyond', () => {
    const h = setup();
    expect(h.timers).toHaveLength(1);
    expect(h.timers[0]!.ms).toBe(CLOCK_CHECK_MS);
    const tick = () => h.timers[0]!.fn();
    // 普通の間隔、少し遅れた間隔は記録しない。
    h.clock.t += CLOCK_CHECK_MS;
    tick();
    h.clock.t += CLOCK_CHECK_MS + CLOCK_JUMP_MS - 1;
    tick();
    expect(h.entries()).toEqual([]);
    // スリープから戻った: 10 分たっていた。
    h.setVisibility('visible');
    h.clock.t += 10 * 60_000;
    tick();
    const [entry] = h.entries();
    expect(entry).toEqual({ level: 'warn', source: 'app', event: 'clock-jump', data: { jump_seconds: 590, elapsed_seconds: 600, visibility: 'visible' } });
    // 戻った後は、また普通の間隔が基準。
    h.clock.t += CLOCK_CHECK_MS;
    tick();
    expect(h.entries()).toEqual([]);
  });

  it('records the boundary: exactly 30 s beyond is a jump', () => {
    const h = setup();
    h.clock.t += CLOCK_CHECK_MS + CLOCK_JUMP_MS;
    h.timers[0]!.fn();
    expect(h.entries()[0]!.data).toMatchObject({ jump_seconds: 30 });
  });

  it('runs the timer only while the logger is enabled (none while disabled)', () => {
    const h = setup(false);
    expect(h.timers).toHaveLength(0);
    h.logger.setEnabled(true);
    expect(h.timers).toHaveLength(1);
    h.logger.setEnabled(false);
    expect(h.timers).toHaveLength(0);
    h.logger.setEnabled(true);
    h.logger.setEnabled(true);
    expect(h.timers).toHaveLength(1);
  });
});

describe('pagehide and removal', () => {
  it('hands over what is kept on pagehide, without waiting for the timer', async () => {
    const append = vi.fn(async () => {});
    const logger = createLogger({ append });
    logger.setEnabled(true);
    const target = new EventTarget();
    installAppDiagnostics(logger, { window: target as unknown as Window, document: new EventTarget() as unknown as Document, now: () => 0, setInterval: () => 1, clearInterval: () => {} });
    logger.info('app', 'last');
    target.dispatchEvent(new Event('pagehide'));
    expect(append).toHaveBeenCalledTimes(1);
  });

  it('writes nothing while the logger is disabled, whatever happens', async () => {
    const h = setup(false);
    h.target.dispatchEvent(errorEvent({ message: 'x', error: new Error('x') }));
    h.target.dispatchEvent(Object.assign(new Event('unhandledrejection'), { reason: new Error('x') }));
    h.docTarget.dispatchEvent(new Event('visibilitychange'));
    h.target.dispatchEvent(new Event('pagehide'));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.entries()).toEqual([]);
  });

  it('removes every listener and the timer', () => {
    const h = setup();
    h.dispose();
    h.target.dispatchEvent(errorEvent({ message: 'x', error: new Error('x') }));
    h.docTarget.dispatchEvent(new Event('visibilitychange'));
    expect(h.timers).toHaveLength(0);
    expect(h.entries()).toEqual([]);
  });
});
