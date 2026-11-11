import { describe, expect, it, vi } from 'vitest';
import { createLogger, RATE_LIMIT } from './logger';
import {
  MAX_SLOW_PER_WINDOW,
  MAX_SPANS,
  OTHER_SPAN,
  PERF_SLOW_SOURCE,
  PERF_SOURCE,
  PERF_SYSTEM_SOURCE,
  ACTIVE_WATCH_MS,
  SLOW_FRAME_MS,
  SLOW_MS,
  SUMMARY_INTERVAL_MS,
  createPerf,
  type PerfEnvironment,
} from './perf';
import type { LogEntry } from './types';

// 性能の計測（R16）の単体テスト。偽の時計・タイマー・描画・窓の見え方で、まとめの行の形、分布、50ms の記録とその上限、
// 回数の制限に掛からないこと、区間の数の上限、量の推移、画面の止まり（操作のあと一定の時間だけ見張ること）、オフの間に何も動かないことを確かめる。

interface FakeEnv extends PerfEnvironment {
  t: number;
  visibility: string;
  heap: number | null;
  nodes: number;
  readonly calls: { now: number; setInterval: number; clearInterval: number; requestFrame: number; cancelFrame: number; listen: number; listenActivity: number };
  /** 登録されたタイマーを 1 回発火させる。 */
  tick(): void;
  /** 登録された描画のコールバックを、フレームの時刻 time で呼ぶ。登録がなければ false。 */
  frame(time: number): boolean;
  setVisibility(state: string): void;
  pagehide(): void;
  /** 操作（キー、ポインタなど）の通知を 1 回送る。リスナーが付いていなければ、何も起きない。 */
  activity(): void;
  readonly pending: () => { interval: boolean; frame: boolean; listeners: boolean; activity: boolean };
}

function fakeEnv(): FakeEnv {
  let interval: (() => void) | null = null;
  let frame: ((time: number) => void) | null = null;
  let onVisibility: (() => void) | null = null;
  let onPageHide: (() => void) | null = null;
  let onActivity: (() => void) | null = null;
  const env: FakeEnv = {
    t: 1000,
    visibility: 'visible',
    heap: 5 * 1024 * 1024,
    nodes: 1234,
    calls: { now: 0, setInterval: 0, clearInterval: 0, requestFrame: 0, cancelFrame: 0, listen: 0, listenActivity: 0 },
    now() {
      env.calls.now += 1;
      return env.t;
    },
    setInterval(fn) {
      env.calls.setInterval += 1;
      interval = fn;
      return 1;
    },
    clearInterval() {
      env.calls.clearInterval += 1;
      interval = null;
    },
    requestFrame(fn) {
      env.calls.requestFrame += 1;
      frame = fn;
      return 7;
    },
    cancelFrame() {
      env.calls.cancelFrame += 1;
      frame = null;
    },
    visibilityState: () => env.visibility,
    listen(v, p) {
      env.calls.listen += 1;
      onVisibility = v;
      onPageHide = p;
      return () => {
        onVisibility = null;
        onPageHide = null;
      };
    },
    listenActivity(fn) {
      env.calls.listenActivity += 1;
      onActivity = fn;
      return () => {
        onActivity = null;
      };
    },
    heapUsedBytes: () => env.heap,
    domNodeCount: () => env.nodes,
    tick: () => interval?.(),
    frame(time) {
      const fn = frame;
      if (!fn) return false;
      frame = null;
      fn(time);
      return true;
    },
    setVisibility(state) {
      env.visibility = state;
      onVisibility?.();
    },
    pagehide: () => onPageHide?.(),
    activity: () => onActivity?.(),
    pending: () => ({ interval: interval !== null, frame: frame !== null, listeners: onVisibility !== null, activity: onActivity !== null }),
  };
  return env;
}

function setup() {
  const env = fakeEnv();
  const appended: LogEntry[][] = [];
  const wall = { t: 1_000_000 };
  const logger = createLogger({
    append: (entries) => void appended.push([...entries]),
    now: () => wall.t,
    setTimer: () => 1,
    clearTimer: () => {},
  });
  const perf = createPerf(logger, env);
  /** ロガーのためた分を（順番を待たずに）渡して、これまでに渡された全部の行を返す。 */
  const written = (): LogEntry[] => {
    logger.flush({ sync: true });
    return appended.flat();
  };
  const rows = (source: string, event?: string) => written().filter((e) => e.source === source && (event === undefined || e.event === event));
  return { env, logger, perf, wall, appended, written, rows };
}

/** name の区間を、ms かけたことにして 1 回数える。 */
function took(s: ReturnType<typeof setup>, name: string, ms: number): void {
  const end = s.perf.span(name);
  s.env.t += ms;
  end();
}

describe('off: nothing runs', () => {
  it('while the logger is disabled, span, measure and record do nothing: no clock read, no timer, no listener, no rAF, nothing buffered', () => {
    const s = setup();
    expect(s.perf.enabled).toBe(false);
    const end = s.perf.span('input.keydown-to-update');
    end();
    expect(s.perf.measure('a.b', () => 42)).toBe(42);
    s.perf.record('a.b', 80);
    s.env.tick();
    s.env.activity(); // リスナーが付いていないので、何も起きない
    expect(s.env.frame(2000)).toBe(false);
    expect(s.env.calls).toEqual({ now: 0, setInterval: 0, clearInterval: 0, requestFrame: 0, cancelFrame: 0, listen: 0, listenActivity: 0 });
    expect(s.written()).toEqual([]);
    expect(s.appended).toEqual([]);
  });

  it('the no-op end is one shared function (no allocation per span while off)', () => {
    const s = setup();
    expect(s.perf.span('a')).toBe(s.perf.span('b'));
  });

  it('measure still runs the function and rethrows its exception while off', () => {
    const s = setup();
    expect(() =>
      s.perf.measure('a', () => {
        throw new TypeError('boom');
      }),
    ).toThrow(TypeError);
  });

  it('turning the logger off stops everything (interval cleared, rAF cancelled, listeners removed) and discards the counts', () => {
    const s = setup();
    s.logger.setEnabled(true);
    // オンにしただけでは、描画の見張りは始まらない（操作を待つ）。
    expect(s.env.pending()).toEqual({ interval: true, frame: false, listeners: true, activity: true });
    s.env.activity();
    expect(s.env.pending()).toEqual({ interval: true, frame: true, listeners: true, activity: true });
    took(s, 'a.b', 5);
    s.logger.setEnabled(false);
    expect(s.env.pending()).toEqual({ interval: false, frame: false, listeners: false, activity: false });
    expect(s.perf.enabled).toBe(false);
    const readsAtOff = s.env.calls.now;
    s.perf.span('a.b')();
    expect(s.env.calls.now).toBe(readsAtOff);
    // もう一度オンにしても、前の数えは残らない。
    s.logger.setEnabled(true);
    s.perf.flush();
    expect(s.rows(PERF_SOURCE)).toEqual([]);
  });

  it('starts at once when created with the logger already enabled', () => {
    const env = fakeEnv();
    const logger = createLogger({ append: () => {}, now: () => 0, setTimer: () => 1, clearTimer: () => {} });
    logger.setEnabled(true);
    const perf = createPerf(logger, env);
    expect(perf.enabled).toBe(true);
    expect(env.pending()).toEqual({ interval: true, frame: false, listeners: true, activity: true });
  });
});

describe('spans and the per-minute summary', () => {
  it('writes one info row per span after a minute: count, p50, p95, max, total (ms, one decimal) and slow, with source perf and the span name as the event', () => {
    const s = setup();
    s.logger.setEnabled(true);
    // 1ms を 90 回、10ms を 9 回、30ms を 1 回: p50 は 1ms 付近、p95 は 10ms 付近、max は 30。
    for (let i = 0; i < 90; i++) took(s, 'input.keydown-to-update', 1);
    for (let i = 0; i < 9; i++) took(s, 'input.keydown-to-update', 10);
    took(s, 'input.keydown-to-update', 30);
    s.env.tick();
    const [row, ...rest] = s.rows(PERF_SOURCE);
    expect(rest).toEqual([]);
    expect(row).toMatchObject({ level: 'info', source: 'perf', event: 'input.keydown-to-update' });
    const d = row!.data;
    expect(d.count).toBe(100);
    expect(d.total_ms).toBe(210);
    expect(d.max_ms).toBe(30);
    expect(d.slow).toBe(0);
    // バケツの上端（最大で約 10% 大きい）。
    expect(d.p50_ms as number).toBeGreaterThanOrEqual(1);
    expect(d.p50_ms as number).toBeLessThanOrEqual(1.1);
    expect(d.p95_ms as number).toBeGreaterThanOrEqual(10);
    expect(d.p95_ms as number).toBeLessThanOrEqual(11);
    expect(Object.keys(d)).toEqual(['count', 'p50_ms', 'p95_ms', 'max_ms', 'total_ms', 'slow']);
    // 値は小数 1 桁まで。
    for (const key of ['p50_ms', 'p95_ms', 'max_ms', 'total_ms']) expect(Math.round((d[key] as number) * 10) / 10).toBe(d[key]);
  });

  it('the percentile never exceeds the maximum, and a single sample reports itself', () => {
    const s = setup();
    s.logger.setEnabled(true);
    s.perf.record('a.b', 3.37);
    s.env.tick();
    const [row] = s.rows(PERF_SOURCE);
    expect(row!.data).toMatchObject({ count: 1, p50_ms: 3.4, p95_ms: 3.4, max_ms: 3.4, total_ms: 3.4 });
  });

  it('does not write a span that did not occur in the last minute, and starts counting again from zero each minute', () => {
    const s = setup();
    s.logger.setEnabled(true);
    took(s, 'a.first', 2);
    took(s, 'a.second', 2);
    s.env.tick();
    expect(s.rows(PERF_SOURCE).map((e) => e.event)).toEqual(['a.first', 'a.second']);
    took(s, 'a.first', 4);
    s.env.tick();
    const rows = s.rows(PERF_SOURCE);
    expect(rows.map((e) => e.event)).toEqual(['a.first', 'a.second', 'a.first']);
    expect(rows[2]!.data).toMatchObject({ count: 1, total_ms: 4 });
    // 何も起きなかった 1 分には、区間の行は出ない。
    const before = rows.length;
    s.env.tick();
    expect(s.rows(PERF_SOURCE)).toHaveLength(before);
  });

  it('measure counts the time of a synchronous function and returns its value; an exception is counted and rethrown', () => {
    const s = setup();
    s.logger.setEnabled(true);
    expect(
      s.perf.measure('a.sync', () => {
        s.env.t += 7;
        return 'value';
      }),
    ).toBe('value');
    expect(() =>
      s.perf.measure('a.sync', () => {
        s.env.t += 5;
        throw new RangeError('boom');
      }),
    ).toThrow(RangeError);
    s.env.tick();
    expect(s.rows(PERF_SOURCE, 'a.sync')[0]!.data).toMatchObject({ count: 2, total_ms: 12, max_ms: 7 });
  });

  it('a span can be started and ended separately (an asynchronous round trip), and ending twice counts once', async () => {
    const s = setup();
    s.logger.setEnabled(true);
    const end = s.perf.span('bridge.save_document');
    await Promise.resolve();
    s.env.t += 12;
    end();
    end();
    s.env.tick();
    expect(s.rows(PERF_SOURCE, 'bridge.save_document')[0]!.data).toMatchObject({ count: 1, total_ms: 12 });
  });

  it('a span started while off and ended after turning on is not counted', () => {
    const s = setup();
    const end = s.perf.span('a.b');
    s.logger.setEnabled(true);
    s.env.t += 10;
    end();
    s.env.tick();
    expect(s.rows(PERF_SOURCE)).toEqual([]);
  });

  it('ignores names that do not match [a-z0-9._-]{1,64}, and bad values', () => {
    const s = setup();
    s.logger.setEnabled(true);
    for (const bad of ['', 'Upper', 'has space', 'a/b', 'x'.repeat(65), '日本語']) {
      took(s, bad, 3);
    }
    s.perf.record('a.b', Number.NaN);
    s.perf.record('a.b', -1);
    s.perf.record('a.b', Number.POSITIVE_INFINITY);
    took(s, 'x'.repeat(64), 1);
    s.env.tick();
    expect(s.rows(PERF_SOURCE).map((e) => e.event)).toEqual(['x'.repeat(64)]);
  });
});

describe('50 ms or more: recorded on the spot', () => {
  it('writes one warn with the name and the time as soon as a span takes SLOW_MS or more, and counts it in slow', () => {
    const s = setup();
    s.logger.setEnabled(true);
    took(s, 'markdown.decorations', SLOW_MS - 1);
    expect(s.rows(PERF_SLOW_SOURCE)).toEqual([]);
    took(s, 'markdown.decorations', SLOW_MS);
    expect(s.rows(PERF_SLOW_SOURCE)).toEqual([{ level: 'warn', source: 'perf-slow', event: 'markdown.decorations', data: { ms: 50 } }]);
    s.env.tick();
    expect(s.rows(PERF_SOURCE, 'markdown.decorations')[0]!.data).toMatchObject({ count: 2, slow: 1, max_ms: 50 });
  });

  it('writes at most MAX_SLOW_PER_WINDOW warns per span per minute; the rest only count in slow; a new minute allows more', () => {
    const s = setup();
    s.logger.setEnabled(true);
    for (let i = 0; i < 20; i++) took(s, 'a.slow', 60 + i);
    took(s, 'b.slow', 70);
    expect(s.rows(PERF_SLOW_SOURCE, 'a.slow')).toHaveLength(MAX_SLOW_PER_WINDOW);
    expect(s.rows(PERF_SLOW_SOURCE, 'b.slow')).toHaveLength(1);
    s.env.tick();
    expect(s.rows(PERF_SOURCE, 'a.slow')[0]!.data.slow).toBe(20);
    took(s, 'a.slow', 80);
    expect(s.rows(PERF_SLOW_SOURCE, 'a.slow')).toHaveLength(MAX_SLOW_PER_WINDOW + 1);
  });
});

describe('the logger rate limit does not hit the summary rows', () => {
  it('writes a summary row every minute for 30 minutes (more than the 10 per minute limit of one source and event does not matter: one per minute), without suppressed', () => {
    const s = setup();
    s.logger.setEnabled(true);
    for (let minute = 0; minute < 30; minute++) {
      took(s, 'input.keydown-to-update', 2);
      s.wall.t += SUMMARY_INTERVAL_MS;
      s.env.tick();
    }
    const rows = s.rows(PERF_SOURCE, 'input.keydown-to-update');
    expect(rows).toHaveLength(30);
    expect(rows.every((r) => !('suppressed' in r.data))).toBe(true);
  });

  it('different spans have different events, so one noisy span does not suppress another; the slow rows stay under the logger limit', () => {
    const s = setup();
    s.logger.setEnabled(true);
    for (let i = 0; i < 40; i++) took(s, 'a.noisy', 100);
    took(s, 'a.quiet', 100);
    expect(s.rows(PERF_SLOW_SOURCE, 'a.quiet')).toHaveLength(1);
    expect(MAX_SLOW_PER_WINDOW).toBeLessThan(RATE_LIMIT);
    expect(s.rows(PERF_SLOW_SOURCE, 'a.noisy').some((r) => 'suppressed' in r.data)).toBe(false);
  });
});

describe('the number of spans is capped', () => {
  it('keeps MAX_SPANS names and puts every further name into a single other', () => {
    const s = setup();
    s.logger.setEnabled(true);
    for (let i = 0; i < MAX_SPANS; i++) took(s, `span.n${i}`, 1);
    took(s, 'extra.one', 2);
    took(s, 'extra.two', 3);
    took(s, 'extra.one', 4);
    s.env.tick();
    const rows = s.rows(PERF_SOURCE);
    expect(rows.map((r) => r.event).filter((e) => e.startsWith('span.'))).toHaveLength(MAX_SPANS);
    const other = rows.filter((r) => r.event === OTHER_SPAN);
    expect(other).toHaveLength(1);
    expect(other[0]!.data).toMatchObject({ count: 3, total_ms: 9 });
    expect(rows.some((r) => r.event.startsWith('extra.'))).toBe(false);
    expect(rows).toHaveLength(MAX_SPANS + 1);
  });

  it('a name already known keeps counting under its own name after the cap is reached', () => {
    const s = setup();
    s.logger.setEnabled(true);
    for (let i = 0; i < MAX_SPANS; i++) took(s, `span.n${i}`, 1);
    s.env.tick();
    took(s, 'span.n0', 5);
    took(s, 'extra', 5);
    s.env.tick();
    const rows = s.rows(PERF_SOURCE);
    expect(rows.filter((r) => r.event === 'span.n0')).toHaveLength(2);
    expect(rows.filter((r) => r.event === OTHER_SPAN)).toHaveLength(1);
  });

  it('a slow span over the cap is reported as other, and the other is also bounded', () => {
    const s = setup();
    s.logger.setEnabled(true);
    for (let i = 0; i < MAX_SPANS; i++) took(s, `span.n${i}`, 1);
    took(s, 'unknown.slow', 90);
    expect(s.rows(PERF_SLOW_SOURCE).map((r) => r.event)).toEqual([OTHER_SPAN]);
  });
});

describe('gauges (the quantity trend), once a minute', () => {
  it('writes the document length and lines, the DOM element count and the JS heap (MB), and nothing else', () => {
    const s = setup();
    s.logger.setEnabled(true);
    s.perf.setDocumentStats(() => ({ chars: 12345, lines: 321 }));
    s.env.tick();
    const [row, ...rest] = s.rows(PERF_SYSTEM_SOURCE, 'gauges');
    expect(rest).toEqual([]);
    expect(row).toEqual({ level: 'info', source: 'perf-system', event: 'gauges', data: { doc_chars: 12345, doc_lines: 321, dom_nodes: 1234, heap_used_mb: 5 } });
  });

  it('heap is null where performance.memory is not available, and the document stats are null before an editor exists or when they throw', () => {
    const s = setup();
    s.logger.setEnabled(true);
    s.env.heap = null;
    s.env.tick();
    expect(s.rows(PERF_SYSTEM_SOURCE, 'gauges')[0]!.data).toMatchObject({ doc_chars: null, doc_lines: null, heap_used_mb: null });
    s.perf.setDocumentStats(() => {
      throw new Error('gone');
    });
    s.env.tick();
    expect(s.rows(PERF_SYSTEM_SOURCE, 'gauges')[1]!.data).toMatchObject({ doc_chars: null, doc_lines: null });
  });

  it('one row per minute', () => {
    const s = setup();
    s.logger.setEnabled(true);
    for (let i = 0; i < 3; i++) s.env.tick();
    expect(s.rows(PERF_SYSTEM_SOURCE, 'gauges')).toHaveLength(3);
  });
});

describe('frame stalls (the gaps between frames), watched only for a while after an operation', () => {
  /** ログをオンにして、操作を 1 回送った状態（見張りが始まり、最初のフレームを待っている）。env.t は 1000 のまま。 */
  function watching() {
    const s = setup();
    s.logger.setEnabled(true);
    s.env.activity();
    return s;
  }
  const frameRows = (s: ReturnType<typeof setup>) => s.rows(PERF_SYSTEM_SOURCE, 'frames');

  it('does not request a frame until there is an operation: enabling, a minute passing and a visibility change all leave the rAF alone', () => {
    const s = setup();
    s.logger.setEnabled(true);
    expect(s.env.calls.requestFrame).toBe(0);
    s.env.tick();
    s.env.setVisibility('hidden');
    s.env.setVisibility('visible');
    s.env.t += 10 * 60_000;
    s.env.tick();
    expect(s.env.calls.requestFrame).toBe(0);
    expect(s.env.pending().frame).toBe(false);
    expect(frameRows(s)).toEqual([]);
  });

  it('an operation starts the watch; counts frames, the gaps over SLOW_FRAME_MS and the largest gap, and writes them in the minute summary', () => {
    const s = watching();
    expect(s.env.calls.requestFrame).toBe(1);
    let time = 0;
    for (const gap of [16, 17, 16, 80, 16, SLOW_FRAME_MS, SLOW_FRAME_MS + 1, 16]) {
      time += gap;
      expect(s.env.frame(time)).toBe(true);
    }
    s.env.tick();
    // 最初のフレームは基準だけ（間隔がない）。
    expect(frameRows(s)).toEqual([{ level: 'info', source: 'perf-system', event: 'frames', data: { frames: 7, stalls: 2, max_ms: 80 } }]);
    // 次の 1 分は、数え直す（フレームの基準は、1 分の区切りをまたいで続く）。
    time += 16;
    s.env.frame(time);
    time += 16;
    s.env.frame(time);
    s.env.tick();
    expect(frameRows(s)[1]!.data).toEqual({ frames: 2, stalls: 0, max_ms: 16 });
  });

  it('catches a stall during typing: a gap over 50 ms between frames while operations keep coming counts in stalls and max_ms', () => {
    const s = watching();
    s.env.frame(100);
    s.env.frame(116);
    s.env.t += 300;
    s.env.activity(); // 打鍵
    s.env.frame(116 + 120); // 本文の処理で 120 ms 止まった
    s.env.t += 16;
    s.env.activity();
    s.env.frame(116 + 120 + 16);
    s.env.tick();
    expect(frameRows(s)[0]!.data).toEqual({ frames: 3, stalls: 1, max_ms: 120 });
  });

  it('stops requesting frames once ACTIVE_WATCH_MS has passed since the last operation, and the pending request is not renewed', () => {
    const s = watching();
    s.env.frame(100);
    s.env.t += ACTIVE_WATCH_MS - 1;
    s.env.frame(116);
    expect(s.env.pending().frame).toBe(true); // 締め切りの前: 続く
    s.env.t += 1;
    expect(s.env.frame(132)).toBe(true); // 締め切りになった: このフレームは数えて、次を要求しない
    expect(s.env.pending().frame).toBe(false);
    expect(s.env.calls.requestFrame).toBe(3);
    s.env.tick();
    expect(frameRows(s)[0]!.data).toEqual({ frames: 2, stalls: 0, max_ms: 16 });
  });

  it('keeps watching while operations continue: each operation moves the deadline to its own time + ACTIVE_WATCH_MS', () => {
    const s = watching();
    s.env.frame(100);
    for (let i = 0; i < 5; i++) {
      s.env.t += ACTIVE_WATCH_MS - 100; // 締め切りの手前で、次の操作
      s.env.activity();
      expect(s.env.frame(116 + i * 16)).toBe(true);
      expect(s.env.pending().frame).toBe(true);
    }
    s.env.t += ACTIVE_WATCH_MS; // 最後の操作から ACTIVE_WATCH_MS
    expect(s.env.frame(500)).toBe(true);
    expect(s.env.pending().frame).toBe(false);
  });

  it('an operation while the watch is already running only moves the deadline: no second request', () => {
    const s = watching();
    const before = s.env.calls.requestFrame;
    s.env.activity();
    s.env.activity();
    s.env.activity();
    expect(s.env.calls.requestFrame).toBe(before);
    expect(s.env.calls.cancelFrame).toBe(0);
  });

  it('does not count the time between watches as a stall: the first frame of a new watch is only a baseline', () => {
    const s = watching();
    s.env.frame(100);
    s.env.frame(116);
    s.env.t += ACTIVE_WATCH_MS;
    s.env.frame(132); // ここで見張りが止まる
    expect(s.env.pending().frame).toBe(false);
    s.env.t += 5 * 60_000; // 操作のない 5 分
    s.env.activity();
    expect(s.env.pending().frame).toBe(true);
    s.env.frame(300_000); // 基準だけ
    s.env.frame(300_016);
    s.env.tick();
    expect(frameRows(s)[0]!.data).toEqual({ frames: 3, stalls: 0, max_ms: 16 });
  });

  it('does not count while the window is hidden: the watch stops, and when it is visible again before the deadline the first frame is only a baseline', () => {
    const s = watching();
    s.env.frame(100);
    s.env.frame(116);
    s.env.setVisibility('hidden');
    expect(s.env.pending().frame).toBe(false);
    expect(s.env.frame(60_000)).toBe(false);
    s.env.setVisibility('visible'); // 締め切り（1000 + ACTIVE_WATCH_MS）の前
    expect(s.env.pending().frame).toBe(true);
    s.env.frame(61_000); // 隠れていた間の空白は、止まりと数えない
    s.env.frame(61_016);
    s.env.tick();
    expect(frameRows(s)[0]!.data).toEqual({ frames: 2, stalls: 0, max_ms: 16 });
  });

  it('when it becomes visible after the deadline, the watch does not restart by itself', () => {
    const s = watching();
    s.env.setVisibility('hidden');
    s.env.t += 2 * ACTIVE_WATCH_MS;
    const before = s.env.calls.requestFrame;
    s.env.setVisibility('visible');
    expect(s.env.calls.requestFrame).toBe(before);
    expect(s.env.pending().frame).toBe(false);
  });

  it('does not start the watch for an operation while the window is hidden, but the operation still counts: becoming visible within the time starts it', () => {
    const env = fakeEnv();
    env.visibility = 'hidden';
    const logger = createLogger({ append: () => {}, now: () => 0, setTimer: () => 1, clearTimer: () => {} });
    const perf = createPerf(logger, env);
    logger.setEnabled(true);
    expect(perf.enabled).toBe(true);
    env.activity();
    expect(env.calls.requestFrame).toBe(0);
    env.setVisibility('visible');
    expect(env.calls.requestFrame).toBe(1);
  });

  it('writes no frames row for a minute with no frames (no operation)', () => {
    const s = setup();
    s.logger.setEnabled(true);
    s.env.tick();
    expect(frameRows(s)).toEqual([]);
  });

  it('keeps one frame loop at a time (no duplicate requests when visibility events repeat)', () => {
    const s = watching();
    const before = s.env.calls.requestFrame;
    s.env.setVisibility('visible');
    s.env.setVisibility('visible');
    expect(s.env.calls.requestFrame).toBe(before);
  });

  it('turning the logger off cancels the watch and removes the operation listener; an operation after that does nothing', () => {
    const s = watching();
    s.logger.setEnabled(false);
    expect(s.env.pending()).toEqual({ interval: false, frame: false, listeners: false, activity: false });
    const before = s.env.calls.requestFrame;
    s.env.activity();
    expect(s.env.calls.requestFrame).toBe(before);
    // オンに戻しても、前の締め切りは引き継がない（操作があるまで、見張りは始まらない）。
    s.logger.setEnabled(true);
    expect(s.env.calls.requestFrame).toBe(before);
    expect(s.env.pending().frame).toBe(false);
  });
});

describe('pagehide', () => {
  it('writes the minute so far and hands it over at once (a session shorter than a minute still leaves a row)', () => {
    const s = setup();
    s.logger.setEnabled(true);
    took(s, 'a.b', 3);
    s.env.pagehide();
    const delivered = s.appended.flat();
    expect(delivered.find((e) => e.source === 'perf' && e.event === 'a.b')?.data).toMatchObject({ count: 1 });
    expect(delivered.some((e) => e.event === 'gauges')).toBe(true);
  });
});

describe('what is written', () => {
  it('has only names and numbers: no text, no path, in any row', () => {
    const s = setup();
    s.logger.setEnabled(true);
    s.perf.setDocumentStats(() => ({ chars: 10, lines: 2 }));
    took(s, 'document.save', 70);
    took(s, 'bridge.save_document', 3);
    s.env.activity();
    s.env.frame(10);
    s.env.frame(100);
    s.env.tick();
    const rows = s.written();
    expect(rows.length).toBeGreaterThan(4);
    for (const row of rows) {
      for (const value of Object.values(row.data)) expect(typeof value === 'number' || value === null).toBe(true);
    }
  });

  it('never throws into the caller even when the logger fails', () => {
    const env = fakeEnv();
    const logger = createLogger({ append: () => {}, now: () => 0, setTimer: () => 1, clearTimer: () => {} });
    logger.setEnabled(true);
    vi.spyOn(logger, 'info').mockImplementation(() => {
      throw new Error('log failed');
    });
    const perf = createPerf(logger, env);
    perf.record('a.b', 1);
    expect(() => env.tick()).not.toThrow();
  });
});
