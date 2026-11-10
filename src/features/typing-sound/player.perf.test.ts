import { describe, expect, it, vi } from 'vitest';
import type { PluginPerf } from '../../plugin-api';
import type { KeyEventLike } from './keys';
import {
  LATENCY_LOG_INTERVAL_MS,
  LATENCY_SAMPLE_MS,
  LATENCY_WARN_MS,
  STALL_MIN_WALL_MS,
  createTypingSoundPlayer,
  type SoundBuffer,
  type SoundContext,
  type TypingSoundLog,
  type TypingSoundPlayerOptions,
} from './player';

// R16（ADR-007）: タイピング音の計測（sound.start-delay、出力の遅れの見積もり）、N2（時計の止まりのログは source.start のあと）、
// 設定のオフで AudioContext を閉じ、オンで作り直すこと（素材のバイト列は取り直さない）。偽の AudioContext で確かめる。
// 鳴り方（音色、音量、間引き、同時の上限、鳴り始めの位置）は player.test.ts が見る。

const URLS = Array.from({ length: 3 }, (_, i) => `/s/${i}.wav`);
const key = (k = 'a'): KeyEventLike => ({ key: k, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false });
const flush = () => new Promise((r) => setTimeout(r, 0));

type Call = [level: string, event: string, data: Record<string, string | number | boolean | null> | undefined];

function fakeContext(order: string[], state = 'running') {
  const ctx = {
    state,
    currentTime: 0,
    sampleRate: 48000,
    baseLatency: 0.01,
    outputLatency: 0.05,
    destination: {},
    outputStamp: { contextTime: 0, performanceTime: 0 },
    resume: vi.fn(async () => {}),
    close: vi.fn(async () => {
      ctx.state = 'closed';
    }),
    decodeAudioData: vi.fn(async (data: ArrayBuffer): Promise<SoundBuffer> => ({ duration: data.byteLength / 1000 })),
    createGain: vi.fn(() => ({ gain: { value: 1 }, connect: vi.fn(), disconnect: vi.fn() })),
    createBufferSource: vi.fn(() => ({
      buffer: null,
      playbackRate: { value: 1 },
      onended: null,
      connect: vi.fn(),
      disconnect: vi.fn(),
      start: vi.fn(() => void order.push('start')),
    })),
    getOutputTimestamp: vi.fn(() => ctx.outputStamp),
  };
  return ctx;
}

function fakePerf(enabled = true) {
  const records: Array<[string, number]> = [];
  const perf: PluginPerf = {
    enabled,
    span: () => () => {},
    measure: (_name, fn) => fn(),
    record: (name, ms) => void records.push([name, ms]),
  };
  return { perf, records };
}

function setup(over: Partial<TypingSoundPlayerOptions> = {}) {
  const order: string[] = [];
  const contexts: ReturnType<typeof fakeContext>[] = [];
  const clock = { t: 10_000 };
  const calls: Call[] = [];
  const log: TypingSoundLog = (level, event, data) => {
    order.push(`log:${event}`);
    calls.push([level, event, data]);
  };
  const fetchBytes = vi.fn(async () => new ArrayBuffer(250));
  const createContext = vi.fn(() => {
    const ctx = fakeContext(order);
    contexts.push(ctx);
    return ctx as unknown as SoundContext;
  });
  const player = createTypingSoundPlayer({
    urls: { keyboard: URLS, typewriter: URLS },
    createContext,
    fetchBytes,
    now: () => clock.t,
    random: () => 0.5,
    log,
    mediaDevices: null,
    ...over,
  });
  return { player, order, contexts, clock, calls, fetchBytes, createContext, events: () => calls.map((c) => c[1]) };
}
type Harness = ReturnType<typeof setup>;

const press = (h: Harness, k = 'a') => h.player.handleKeyDown(key(k), 'medium', 'keyboard');
async function ready(h: Harness): Promise<void> {
  h.player.prepare('keyboard');
  await flush();
  press(h);
  await flush();
  h.clock.t += 100;
}

describe('N2: the clock-stall log is written after source.start', () => {
  it('writes clock.stalled after source.start of the same key, not before it', async () => {
    const h = setup();
    await ready(h);
    const ctx = h.contexts[0]!;
    ctx.currentTime += 0.5;
    h.clock.t += 500;
    press(h); // 基準を取り直す
    h.order.length = 0;
    h.clock.t += 600; // 壁の時計は進むが currentTime は止まっている
    press(h);
    expect(h.order).toEqual(['start', 'log:clock.stalled']);
    expect(h.calls.at(-1)).toEqual(['warn', 'clock.stalled', { elapsed_ms: 600, advance_ms: 0, state: 'running' }]);
  });

  it('writes clock.recovered after source.start as well', async () => {
    const h = setup();
    await ready(h);
    const ctx = h.contexts[0]!;
    h.clock.t += 500;
    ctx.currentTime += 0.5;
    press(h);
    h.clock.t += 600;
    press(h); // 止まり
    h.order.length = 0;
    h.clock.t += 600;
    ctx.currentTime += 0.6;
    press(h);
    expect(h.order).toEqual(['start', 'log:clock.recovered']);
  });

  it('still writes the stall log when the key is not played (decoded sounds are not ready)', async () => {
    const h = setup({ fetchBytes: async () => new ArrayBuffer(250) });
    h.player.prepare('keyboard');
    await flush();
    press(h); // AudioContext を作る。デコードはまだ（await 前）
    const ctx = h.contexts[0]!;
    // デコードが終わる前に、止まりを見つける。
    h.clock.t += STALL_MIN_WALL_MS + 10;
    press(h); // 基準
    h.clock.t += 600;
    press(h);
    expect(h.events()).toContain('clock.stalled');
    expect(ctx.createBufferSource).not.toHaveBeenCalled();
  });
});

describe('sound.start-delay', () => {
  it('measures with the injected clock: the value is now() at start minus now() at the key', async () => {
    const { perf, records } = fakePerf(true);
    let calls = 0;
    const clock = { t: 5000 };
    const h = setup({
      perf,
      now: () => {
        calls += 1;
        // 1 キーの中で、最初の読み取り（キーの時刻）のあと、2 回目（start の直前）は 4ms 後。
        return calls % 2 === 1 ? clock.t : clock.t + 4;
      },
    });
    h.player.prepare('keyboard');
    await flush();
    press(h);
    await flush();
    clock.t += 1000;
    records.length = 0;
    calls = 0;
    press(h);
    expect(records).toEqual([['sound.start-delay', 4]]);
  });

  it('does nothing when perf is disabled or absent: no record, and now() is read the same number of times as without perf', async () => {
    const reads = async (perf: PluginPerf | undefined): Promise<number> => {
      let n = 0;
      const h = setup({
        ...(perf ? { perf } : {}),
        now: () => {
          n += 1;
          return 10_000 + n * 100;
        },
      });
      await ready(h);
      n = 0;
      press(h);
      return n;
    };
    const off = fakePerf(false);
    const withoutPerf = await reads(undefined);
    const withDisabled = await reads(off.perf);
    expect(off.records).toEqual([]);
    expect(withDisabled).toBe(withoutPerf);
  });
});

describe('output latency estimate (getOutputTimestamp)', () => {
  /** contextTime を、currentTime より lagMs 遅れた位置にして、timestampAge ms 前の時刻にする。 */
  function setStamp(h: Harness, lagMs: number, ageMs = 5) {
    const ctx = h.contexts[0]!;
    ctx.outputStamp = { contextTime: ctx.currentTime - lagMs / 1000, performanceTime: h.clock.t - ageMs };
  }

  it('writes info output.latency once a minute at most, with estimate, timestamp age, base and output latency (ms) and state', async () => {
    const { perf } = fakePerf(true);
    const h = setup({ perf });
    await ready(h);
    h.contexts[0]!.currentTime = 20;
    h.clock.t += 40;
    setStamp(h, 60, 7);
    press(h);
    const latency = h.calls.filter((c) => c[1] === 'output.latency');
    expect(latency).toEqual([['info', 'output.latency', { estimate_ms: 60, timestamp_age_ms: 7, base_latency_ms: 10, output_latency_ms: 50, state: 'running' }]]);
    // 1 分以内は、読んでも書かない。
    for (let i = 0; i < 5; i++) {
      h.clock.t += LATENCY_SAMPLE_MS + 10;
      h.contexts[0]!.currentTime += 1;
      setStamp(h, 80);
      press(h);
    }
    expect(h.calls.filter((c) => c[1] === 'output.latency')).toHaveLength(1);
    // 1 分たつと、また書く。
    h.clock.t += LATENCY_LOG_INTERVAL_MS;
    setStamp(h, 70);
    press(h);
    expect(h.calls.filter((c) => c[1] === 'output.latency')).toHaveLength(2);
  });

  it('writes warn output.latency-high on the spot when the estimate is above 150 ms, once a minute while it continues, after source.start', async () => {
    const { perf } = fakePerf(true);
    const h = setup({ perf });
    await ready(h);
    h.contexts[0]!.currentTime = 30;
    setStamp(h, LATENCY_WARN_MS + 1);
    h.clock.t += 40;
    h.order.length = 0;
    press(h);
    const warn = h.calls.filter((c) => c[1] === 'output.latency-high');
    expect(warn).toHaveLength(1);
    expect(warn[0]![0]).toBe('warn');
    expect(warn[0]![2]).toMatchObject({ estimate_ms: 151, threshold_ms: LATENCY_WARN_MS, state: 'running' });
    expect(h.order.indexOf('start')).toBeLessThan(h.order.indexOf('log:output.latency-high'));
    // 続く間は、1 分に 1 回まで。
    for (let i = 0; i < 10; i++) {
      h.clock.t += LATENCY_SAMPLE_MS + 10;
      h.contexts[0]!.currentTime += 1;
      setStamp(h, 300);
      press(h);
    }
    expect(h.calls.filter((c) => c[1] === 'output.latency-high')).toHaveLength(1);
    h.clock.t += LATENCY_LOG_INTERVAL_MS;
    setStamp(h, 300);
    press(h);
    expect(h.calls.filter((c) => c[1] === 'output.latency-high')).toHaveLength(2);
  });

  it('does not warn at exactly 150 ms or below, and reads the timestamp at most once per sample interval', async () => {
    const { perf } = fakePerf(true);
    const h = setup({ perf });
    await ready(h);
    const ctx = h.contexts[0]!;
    ctx.currentTime = 40;
    setStamp(h, LATENCY_WARN_MS);
    h.clock.t += 40;
    press(h);
    expect(h.events()).not.toContain('output.latency-high');
    const reads = ctx.getOutputTimestamp.mock.calls.length;
    h.clock.t += 40; // 間引きの下限（30ms）は過ぎているが、読む間隔（1 秒）は過ぎていない
    press(h);
    expect(ctx.getOutputTimestamp.mock.calls.length).toBe(reads);
  });

  it('does nothing without getOutputTimestamp, with an unstarted output (0, 0), or when perf is disabled; and never rebuilds the context', async () => {
    const { perf } = fakePerf(true);
    const h = setup({ perf });
    await ready(h);
    const ctx = h.contexts[0]!;
    // まだ出力が始まっていない値。
    ctx.currentTime = 50;
    ctx.outputStamp = { contextTime: 0, performanceTime: 0 };
    h.clock.t += 40;
    press(h);
    expect(h.events()).not.toContain('output.latency');
    // getOutputTimestamp がない。
    delete (ctx as { getOutputTimestamp?: unknown }).getOutputTimestamp;
    h.clock.t += LATENCY_SAMPLE_MS + 10;
    press(h);
    expect(h.events()).not.toContain('output.latency');
    // 計測が無効。
    const off = setup({ perf: fakePerf(false).perf });
    await ready(off);
    off.contexts[0]!.currentTime = 60;
    setStamp(off, 500);
    off.clock.t += 40;
    press(off);
    expect(off.events()).not.toContain('output.latency-high');
    // どの場合も、作り直していない。
    expect(h.createContext).toHaveBeenCalledTimes(1);
    expect(off.createContext).toHaveBeenCalledTimes(1);
  });

  it('is synchronous: the estimate is written by the time handleKeyDown returns (no await between the read and the log)', async () => {
    const { perf } = fakePerf(true);
    const h = setup({ perf });
    await ready(h);
    h.contexts[0]!.currentTime = 70;
    setStamp(h, 200);
    h.clock.t += 40;
    press(h);
    expect(h.events()).toContain('output.latency-high');
  });
});

describe('release (setting off) and re-creation', () => {
  it('closes the AudioContext with a reason, keeps the fetched bytes, and rebuilds on the next sounding key with a reason, decoding again', async () => {
    const h = setup();
    await ready(h);
    expect(h.fetchBytes).toHaveBeenCalledTimes(URLS.length);
    expect(h.contexts).toHaveLength(1);
    const first = h.contexts[0]!;
    expect(first.decodeAudioData).toHaveBeenCalledTimes(URLS.length);

    h.player.release('setting-off');
    expect(first.close).toHaveBeenCalledTimes(1);
    expect(h.calls.find((c) => c[1] === 'context.closed')).toEqual(['info', 'context.closed', { reason: 'setting-off', from: 'running', current_time: 0 }]);
    // 閉じただけでは、作らない。
    await flush();
    expect(h.createContext).toHaveBeenCalledTimes(1);

    // 次に鳴らすキーで作り直す（そのキーは、デコードが終わるまで鳴らない）。素材は取り直さない。
    h.clock.t += 1000;
    press(h);
    expect(h.createContext).toHaveBeenCalledTimes(2);
    expect(h.calls.filter((c) => c[1] === 'context.created').map((c) => c[2]!.reason)).toEqual(['first-key', 'after-setting-off']);
    await flush();
    const second = h.contexts[1]!;
    expect(second.decodeAudioData).toHaveBeenCalledTimes(URLS.length);
    expect(h.fetchBytes).toHaveBeenCalledTimes(URLS.length);

    // デコードのあとは鳴る。
    h.clock.t += 1000;
    press(h);
    const sources = second.createBufferSource.mock.results.length;
    expect(sources).toBe(1);
  });

  it('prepare after release does not fetch again (the bytes are kept), and release without a context does nothing', async () => {
    const h = setup();
    h.player.release('setting-off'); // まだ AudioContext がない
    expect(h.events()).not.toContain('context.closed');
    await ready(h);
    h.player.release('setting-off');
    h.player.prepare('keyboard');
    await flush();
    expect(h.fetchBytes).toHaveBeenCalledTimes(URLS.length);
    // 2 回続けて release しても、閉じるのは 1 回。
    h.player.release('setting-off');
    expect(h.contexts[0]!.close).toHaveBeenCalledTimes(1);
  });

  it('does not log statechange for the close it asked for, and the old context is not used again', async () => {
    const h = setup();
    await ready(h);
    h.player.release('setting-off');
    await flush();
    expect(h.events()).not.toContain('context.statechange');
    h.clock.t += 1000;
    press(h);
    await flush();
    h.clock.t += 1000;
    press(h);
    expect(h.contexts[0]!.createBufferSource).not.toHaveBeenCalled(); // 古い AudioContext では、もう鳴らさない
    expect(h.contexts[1]!.createBufferSource).toHaveBeenCalledTimes(1);
  });

  it('a context closed from the outside is rebuilt with reason after-closed', async () => {
    const h = setup();
    await ready(h);
    h.contexts[0]!.state = 'closed';
    press(h);
    expect(h.calls.filter((c) => c[1] === 'context.created').map((c) => c[2]!.reason)).toEqual(['first-key', 'after-closed']);
  });

  it('dispose closes the context with reason dispose, and nothing sounds afterwards', async () => {
    const h = setup();
    await ready(h);
    h.player.dispose();
    expect(h.calls.find((c) => c[1] === 'context.closed')![2]).toMatchObject({ reason: 'dispose' });
    h.clock.t += 1000;
    press(h);
    expect(h.createContext).toHaveBeenCalledTimes(1);
  });
});
