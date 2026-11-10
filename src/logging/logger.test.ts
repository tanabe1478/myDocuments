import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FLUSH_INTERVAL_MS, MAX_BUFFERED, RATE_LIMIT, RATE_WINDOW_MS, createLogger, type Logger } from './logger';
import type { LogEntry } from './types';

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-10T00:00:00Z'));
});
afterEach(() => vi.useRealTimers());

function setup(options: { fail?: boolean } = {}) {
  const calls: LogEntry[][] = [];
  const append = vi.fn(async (entries: readonly LogEntry[]) => {
    calls.push([...entries]);
    if (options.fail) throw new Error('write failed');
  });
  const logger = createLogger({ append });
  return { logger, append, calls, all: () => calls.flat() };
}

const flushAll = async () => {
  await vi.advanceTimersByTimeAsync(FLUSH_INTERVAL_MS);
};

describe('while disabled (the default)', () => {
  it('does nothing and keeps nothing: no timer, no append, and enabling later does not release old entries', async () => {
    const { logger, append } = setup();
    expect(logger.enabled).toBe(false);
    logger.info('app', 'start', { a: 1 });
    logger.error('app', 'x');
    logger.log('warn', 'app', 'y');
    expect(vi.getTimerCount()).toBe(0);
    await flushAll();
    logger.flush();
    logger.flush({ sync: true });
    expect(append).not.toHaveBeenCalled();
    logger.setEnabled(true);
    await flushAll();
    expect(append).not.toHaveBeenCalled();
  });
});

describe('batching', () => {
  it('hands the entries over together, one second after the first one (not per entry)', async () => {
    const { logger, append, calls } = setup();
    logger.setEnabled(true);
    logger.info('app', 'start', { user_agent: 'UA', ok: true, n: 1, none: null });
    await vi.advanceTimersByTimeAsync(400);
    logger.warn('app', 'visibility', { state: 'hidden' });
    logger.error('document', 'save-failed', { op: 'save' });
    expect(append).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(FLUSH_INTERVAL_MS - 400);
    expect(append).toHaveBeenCalledTimes(1);
    expect(calls[0]).toEqual([
      { level: 'info', source: 'app', event: 'start', data: { user_agent: 'UA', ok: true, n: 1, none: null } },
      { level: 'warn', source: 'app', event: 'visibility', data: { state: 'hidden' } },
      { level: 'error', source: 'document', event: 'save-failed', data: { op: 'save' } },
    ]);
    // 空の間は、タイマーもない。次の記録からまた 1 秒。
    expect(vi.getTimerCount()).toBe(0);
    logger.info('app', 'again');
    await vi.advanceTimersByTimeAsync(FLUSH_INTERVAL_MS);
    expect(append).toHaveBeenCalledTimes(2);
  });

  it('gives an entry without data an empty data object', async () => {
    const { logger, all } = setup();
    logger.setEnabled(true);
    logger.info('app', 'x');
    await flushAll();
    expect(all()).toEqual([{ level: 'info', source: 'app', event: 'x', data: {} }]);
  });

  it('flush() hands over at once; flush({ sync: true }) does not wait for the previous delivery (pagehide)', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const calls: string[] = [];
    const logger = createLogger({
      append: async (entries) => {
        calls.push(entries.map((e) => e.event).join(','));
        if (calls.length === 1) await gate;
      },
    });
    logger.setEnabled(true);
    logger.info('app', 'a');
    logger.flush();
    expect(calls).toEqual(['a']);
    logger.info('app', 'b');
    logger.flush();
    // 前の渡しが終わっていないので、順番を待つ。
    await Promise.resolve();
    expect(calls).toEqual(['a']);
    logger.info('app', 'c');
    logger.flush({ sync: true });
    expect(calls).toEqual(['a', 'c']);
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toEqual(['a', 'c', 'b']);
  });

  it('splits 200 distinct entries into 100 + 100', async () => {
    const { logger, calls } = setup();
    logger.setEnabled(true);
    for (let i = 0; i < 200; i++) logger.info(`s${i}`, 'e', { i });
    logger.flush();
    await vi.advanceTimersByTimeAsync(0);
    expect(calls.map((c) => c.length)).toEqual([100, 100]);
    expect(calls.flat().map((e) => e.data.i)).toEqual(Array.from({ length: 200 }, (_, i) => i));
  });

  it('a failing append does not throw, does not retry, and later entries still go out', async () => {
    const { logger, append } = setup({ fail: true });
    logger.setEnabled(true);
    logger.info('app', 'a');
    await flushAll();
    expect(append).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5000);
    expect(append).toHaveBeenCalledTimes(1);
    logger.info('app', 'b');
    await flushAll();
    expect(append).toHaveBeenCalledTimes(2);

    const throwsSync = createLogger({
      append: () => {
        throw new Error('sync failure');
      },
    });
    throwsSync.setEnabled(true);
    throwsSync.info('app', 'x');
    expect(() => throwsSync.flush({ sync: true })).not.toThrow();
  });
});

describe('the buffer limit (200)', () => {
  it('keeps the first 200 and reports the number of the rest as one logging.dropped entry in the same delivery', async () => {
    const { logger, calls } = setup();
    logger.setEnabled(true);
    for (let i = 0; i < MAX_BUFFERED + 37; i++) logger.info(`s${i}`, 'e', { i });
    await flushAll();
    const all = calls.flat();
    expect(all).toHaveLength(MAX_BUFFERED + 1);
    expect(all[MAX_BUFFERED - 1]).toMatchObject({ source: `s${MAX_BUFFERED - 1}` });
    expect(all.at(-1)).toEqual({ level: 'warn', source: 'logging', event: 'dropped', data: { count: 37 } });
    // 渡したあとは、また 200 件ためられ、dropped は 1 回だけ。
    for (let i = 0; i < 5; i++) logger.info('app', `after${i}`);
    await flushAll();
    expect(calls.flat().filter((e) => e.event === 'dropped')).toHaveLength(1);
    expect(calls.flat().at(-1)).toMatchObject({ event: 'after4' });
  });

  it('exactly 200 entries make no dropped entry', async () => {
    const { logger, all } = setup();
    logger.setEnabled(true);
    for (let i = 0; i < MAX_BUFFERED; i++) logger.info(`s${i}`, 'e');
    await flushAll();
    expect(all()).toHaveLength(MAX_BUFFERED);
    expect(all().some((e) => e.event === 'dropped')).toBe(false);
  });
});

describe('the rate limit (10 per minute for the same source and event)', () => {
  it('records the first 10 and drops the rest; the next recorded entry carries the number dropped', async () => {
    const { logger, all } = setup();
    logger.setEnabled(true);
    for (let i = 0; i < 25; i++) logger.warn('typing-sound', 'resume.result', { i });
    await flushAll();
    expect(all().map((e) => e.data.i)).toEqual(Array.from({ length: RATE_LIMIT }, (_, i) => i));
    expect(all().every((e) => e.data.suppressed === undefined)).toBe(true);
    // 1 分たつと、また記録できる。そのとき、省いた 15 件を添える（1 回だけ）。
    await vi.advanceTimersByTimeAsync(RATE_WINDOW_MS);
    logger.warn('typing-sound', 'resume.result', { i: 100 });
    logger.warn('typing-sound', 'resume.result', { i: 101 });
    await flushAll();
    const later = all().slice(RATE_LIMIT);
    expect(later).toHaveLength(2);
    expect(later[0]!.data).toEqual({ i: 100, suppressed: 15 });
    expect(later[1]!.data).toEqual({ i: 101 });
  });

  it('counts per source and event: other events and other sources are not affected', async () => {
    const { logger, all } = setup();
    logger.setEnabled(true);
    for (let i = 0; i < 30; i++) logger.info('app', 'visibility');
    for (let i = 0; i < 3; i++) logger.info('app', 'other');
    for (let i = 0; i < 3; i++) logger.info('document', 'visibility');
    await flushAll();
    expect(all().filter((e) => e.source === 'app' && e.event === 'visibility')).toHaveLength(10);
    expect(all().filter((e) => e.event === 'other')).toHaveLength(3);
    expect(all().filter((e) => e.source === 'document')).toHaveLength(3);
  });

  it('the window starts at the first entry: just before 60s the limit still holds, at 60s it resets', async () => {
    const { logger, all } = setup();
    logger.setEnabled(true);
    for (let i = 0; i < 12; i++) logger.info('app', 'x');
    await vi.advanceTimersByTimeAsync(RATE_WINDOW_MS - 1);
    logger.info('app', 'x');
    expect(all().length + 0).toBeLessThanOrEqual(10);
    await vi.advanceTimersByTimeAsync(1);
    logger.info('app', 'x', { late: true });
    await flushAll();
    expect(all().filter((e) => e.event === 'x')).toHaveLength(11);
    expect(all().at(-1)!.data).toEqual({ late: true, suppressed: 3 });
  });

  it('an entry dropped by the rate limit does not count against the buffer', async () => {
    const { logger, all } = setup();
    logger.setEnabled(true);
    for (let i = 0; i < 500; i++) logger.info('app', 'same');
    await flushAll();
    expect(all()).toHaveLength(RATE_LIMIT);
  });
});

describe('turning off and on', () => {
  it('turning off throws away what was kept, cancels the timer, and counts start over when turned on again', async () => {
    const { logger, append } = setup();
    logger.setEnabled(true);
    for (let i = 0; i < 12; i++) logger.info('app', 'x');
    logger.setEnabled(false);
    expect(vi.getTimerCount()).toBe(0);
    await flushAll();
    expect(append).not.toHaveBeenCalled();
    logger.info('app', 'ignored');
    logger.setEnabled(true);
    logger.info('app', 'x');
    await flushAll();
    expect(append).toHaveBeenCalledTimes(1);
    // 数えは捨てたので、省いた件数は添わない。
    expect(append.mock.calls[0]![0]).toEqual([{ level: 'info', source: 'app', event: 'x', data: {} }]);
  });

  it('tells the listeners only when the value changes, and a throwing listener does not stop the switch', () => {
    const { logger } = setup();
    const seen: boolean[] = [];
    const off = logger.onEnabledChange((e) => seen.push(e));
    logger.onEnabledChange(() => {
      throw new Error('bad listener');
    });
    logger.setEnabled(false);
    expect(() => logger.setEnabled(true)).not.toThrow();
    logger.setEnabled(true);
    logger.setEnabled(false);
    off();
    logger.setEnabled(true);
    expect(seen).toEqual([true, false]);
    expect(logger.enabled).toBe(true);
  });
});

describe('what is written: data cleaning', () => {
  async function written(logger: Logger, all: () => LogEntry[], run: () => void) {
    logger.setEnabled(true);
    run();
    await flushAll();
    return all();
  }

  it('replaces the home directory in strings with ~ and cuts a string to 500 characters', async () => {
    const { logger, all } = setup();
    const entries = await written(logger, all, () =>
      logger.error('app', 'e', { message: 'failed to read /Users/alice/Documents/note.md', long: 'x'.repeat(800), win: 'C:\\Users\\carol\\a.md' }),
    );
    const data = entries[0]!.data;
    expect(data.message).toBe('failed to read ~/Documents/note.md');
    expect((data.long as string).length).toBe(500);
    expect(data.win).toBe('~\\a.md');
    expect(JSON.stringify(entries)).not.toMatch(/alice|carol/);
  });

  it('drops undefined values, non-finite numbers and keys that Rust would reject; keeps at most 20 items', async () => {
    const { logger, all } = setup();
    const many = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`k${String(i).padStart(2, '0')}`, i]));
    const entries = await written(logger, all, () => {
      logger.info('app', 'a', { ok: 1, no: undefined, nan: Number.NaN, inf: Infinity, 'Bad-Key': 1, 'has space': 2, '': 3, 日本語: 4, zero: 0, flag: false });
      logger.info('app', 'b', many);
    });
    expect(entries[0]!.data).toEqual({ ok: 1, zero: 0, flag: false });
    expect(Object.keys(entries[1]!.data)).toHaveLength(20);
  });

  it('drops an entry whose source or event Rust would reject', async () => {
    const { logger, all } = setup();
    const entries = await written(logger, all, () => {
      logger.info('App', 'x');
      logger.info('app', 'has space');
      logger.info('', 'x');
      logger.info('app', '');
      logger.info('a'.repeat(65), 'x');
      logger.info('app', 'ok.event_1-2');
    });
    expect(entries.map((e) => e.event)).toEqual(['ok.event_1-2']);
  });

  it('never throws to the caller, whatever it is given', () => {
    const { logger } = setup();
    logger.setEnabled(true);
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => logger.info('app', 'x', circular as never)).not.toThrow();
    expect(() => logger.info('app', 'x', null as never)).not.toThrow();
    expect(() => logger.log('fatal' as never, 'app', 'x')).not.toThrow();
  });
});
