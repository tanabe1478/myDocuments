import { describe, expect, it, vi } from 'vitest';
import type { KeyEventLike } from './keys';
import {
  STALL_ADVANCE_RATIO,
  STALL_MIN_WALL_MS,
  SoundHttpError,
  createTypingSoundPlayer,
  type DeviceEventSource,
  type SoundBuffer,
  type SoundContext,
  type TypingSoundLog,
  type TypingSoundPlayerOptions,
} from './player';

// アプリのログ（ADR-007）に出す、タイピング音の記録。偽の AudioContext で、記録の形と、記録しない場面を確かめる。
// 鳴り方（音色、音量、間引き、同時の上限、鳴り始めの位置）は player.test.ts が見る。

const URLS = Array.from({ length: 3 }, (_, i) => `/s/${i}.wav`);
const key = (k = 'a'): KeyEventLike => ({ key: k, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false });
const flush = () => new Promise((r) => setTimeout(r, 0));

type Call = [level: string, event: string, data: Record<string, string | number | boolean | null> | undefined];

/** statechange と currentTime のある偽の AudioContext。 */
function fakeContext(state = 'running') {
  const listeners = new Set<() => void>();
  const sources: Array<{ start: ReturnType<typeof vi.fn> }> = [];
  const ctx = {
    state,
    currentTime: 0,
    sampleRate: 48000,
    baseLatency: 0.01,
    outputLatency: 0.05,
    destination: {},
    resume: vi.fn(async () => {
      ctx.setState('running');
    }),
    close: vi.fn(async () => {
      ctx.setState('closed');
    }),
    decodeAudioData: vi.fn(async (data: ArrayBuffer): Promise<SoundBuffer> => ({ duration: data.byteLength / 1000 })),
    createGain: vi.fn(() => ({ gain: { value: 1 }, connect: vi.fn(), disconnect: vi.fn() })),
    createBufferSource: vi.fn(() => {
      const source = { buffer: null, playbackRate: { value: 1 }, onended: null, connect: vi.fn(), disconnect: vi.fn(), start: vi.fn() };
      sources.push(source);
      return source;
    }),
    addEventListener: vi.fn((_type: string, l: () => void) => void listeners.add(l)),
    removeEventListener: vi.fn((_type: string, l: () => void) => void listeners.delete(l)),
    /** state を変えて、statechange を送る。 */
    setState(next: string) {
      ctx.state = next;
      for (const l of Array.from(listeners)) l();
    },
    listenerCount: () => listeners.size,
  };
  return { ctx, sources };
}

function fakeDevices() {
  const listeners = new Set<() => void>();
  const devices: DeviceEventSource = {
    addEventListener: vi.fn((_t: 'devicechange', l: () => void) => void listeners.add(l)),
    removeEventListener: vi.fn((_t: 'devicechange', l: () => void) => void listeners.delete(l)),
  };
  return { devices, fire: () => listeners.forEach((l) => l()), count: () => listeners.size };
}

function setup(over: Partial<TypingSoundPlayerOptions> = {}, state = 'running') {
  const f = fakeContext(state);
  const clock = { t: 10_000 };
  const calls: Call[] = [];
  const log: TypingSoundLog = (level, event, data) => void calls.push([level, event, data]);
  const player = createTypingSoundPlayer({
    urls: { keyboard: URLS, typewriter: URLS },
    createContext: () => f.ctx as unknown as SoundContext,
    fetchBytes: async () => new ArrayBuffer(250),
    now: () => clock.t,
    random: () => 0.5,
    log,
    mediaDevices: null,
    ...over,
  });
  return { ...f, player, clock, calls, events: () => calls.map((c) => c[1]) };
}
type Harness = ReturnType<typeof setup>;

const press = (h: Harness, k = 'a') => h.player.handleKeyDown(key(k), 'medium', 'keyboard');
/** 素材を読み、最初のキーで AudioContext を作り、デコードを終えるまで進める（最初のキーは鳴らない）。 */
async function ready(h: Harness): Promise<void> {
  h.player.prepare('keyboard');
  await flush();
  press(h);
  await flush();
  h.clock.t += 100;
}

describe('context.created and context.statechange', () => {
  it('records sample_rate, base_latency, output_latency and state when the AudioContext is made (once)', async () => {
    const h = setup();
    expect(h.calls).toEqual([]);
    h.player.prepare('keyboard');
    await flush();
    press(h);
    expect(h.calls[0]).toEqual(['info', 'context.created', { sample_rate: 48000, base_latency: 0.01, output_latency: 0.05, state: 'running' }]);
    h.clock.t += 100;
    press(h);
    expect(h.calls.filter((c) => c[1] === 'context.created')).toHaveLength(1);
  });

  it('records null for the values the environment does not have', () => {
    const h = setup();
    delete (h.ctx as Partial<typeof h.ctx>).sampleRate;
    (h.ctx as { baseLatency?: number }).baseLatency = Number.NaN;
    press(h);
    expect(h.calls[0]![2]).toEqual({ sample_rate: null, base_latency: null, output_latency: 0.05, state: 'running' });
  });

  it('records each state change with the previous state, the new state and currentTime', async () => {
    const h = setup();
    await ready(h);
    h.ctx.currentTime = 3.25;
    h.ctx.setState('suspended');
    h.ctx.currentTime = 3.25;
    h.ctx.setState('running');
    const changes = h.calls.filter((c) => c[1] === 'context.statechange');
    expect(changes).toEqual([
      ['info', 'context.statechange', { from: 'running', to: 'suspended', current_time: 3.25 }],
      ['info', 'context.statechange', { from: 'suspended', to: 'running', current_time: 3.25 }],
    ]);
  });

  it('removes the listeners when the player is disposed, and records nothing after that', async () => {
    const d = fakeDevices();
    const h = setup({ mediaDevices: d.devices });
    await ready(h);
    expect(h.ctx.listenerCount()).toBe(1);
    expect(d.count()).toBe(1);
    h.player.dispose();
    expect(h.ctx.listenerCount()).toBe(0);
    expect(d.count()).toBe(0);
  });

  it('listens again for a new context made after the old one was closed, and removes the old listener', async () => {
    const h = setup();
    await ready(h);
    expect(h.ctx.listenerCount()).toBe(1);
    h.ctx.state = 'closed';
    h.clock.t += 100;
    press(h);
    expect(h.calls.filter((c) => c[1] === 'context.created')).toHaveLength(2);
    // 同じ偽物を返しているので、外して付け直した後の数は 1。
    expect(h.ctx.listenerCount()).toBe(1);
  });

  it('works with a context that has no addEventListener or currentTime (a simple stand-in)', () => {
    const h = setup();
    delete (h.ctx as { addEventListener?: unknown }).addEventListener;
    delete (h.ctx as { currentTime?: unknown }).currentTime;
    expect(() => press(h)).not.toThrow();
    h.clock.t += 2000;
    expect(() => press(h)).not.toThrow();
    expect(h.events()).toEqual(['context.created']);
  });
});

describe('resume.requested and resume.result', () => {
  it('records the request (with the state) and a successful result with the state after it', async () => {
    const h = setup({}, 'suspended');
    h.player.prepare('keyboard');
    await flush();
    press(h);
    await flush();
    expect(h.calls.map((c) => [c[1], c[2]])).toEqual([
      ['context.created', expect.objectContaining({ state: 'suspended' })],
      ['resume.requested', { state: 'suspended', skipped: 0 }],
      ['context.statechange', { from: 'suspended', to: 'running', current_time: 0 }],
      ['resume.result', { ok: true, state: 'running' }],
      ['decode.result', { timbre: 'keyboard', ok: 3, failed: 0 }],
    ]);
    expect(h.calls.find((c) => c[1] === 'resume.result')![0]).toBe('info');
  });

  it('records the error name when resume fails, and still does not throw into the key handler', async () => {
    const h = setup({}, 'suspended');
    const failure = Object.assign(new Error('The AudioContext was not allowed to start.'), { name: 'NotAllowedError' });
    h.ctx.resume.mockImplementation(async () => {
      throw failure;
    });
    expect(() => press(h)).not.toThrow();
    await flush();
    expect(h.calls.find((c) => c[1] === 'resume.result')).toEqual(['warn', 'resume.result', { ok: false, error: 'NotAllowedError', state: 'suspended' }]);
    // メッセージは記録しない。
    expect(JSON.stringify(h.calls)).not.toContain('not allowed to start');
  });

  it('records a resume that succeeded but left the state not running (the case that matters on WKWebView)', async () => {
    const h = setup({}, 'suspended');
    h.ctx.resume.mockImplementation(async () => {});
    press(h);
    await flush();
    expect(h.calls.find((c) => c[1] === 'resume.result')![2]).toEqual({ ok: true, state: 'suspended' });
  });

  it('does not record every key while the state stays not running: once, then at most every 5 seconds, with the skipped count', async () => {
    const h = setup({}, 'suspended');
    h.ctx.resume.mockImplementation(async () => {});
    for (let i = 0; i < 6; i++) {
      press(h);
      h.clock.t += 100;
    }
    await flush();
    expect(h.calls.filter((c) => c[1] === 'resume.requested')).toHaveLength(1);
    // resume 自体は、従来どおり毎回頼む。
    expect(h.ctx.resume).toHaveBeenCalledTimes(6);
    h.clock.t += 5000;
    press(h);
    const requests = h.calls.filter((c) => c[1] === 'resume.requested');
    expect(requests).toHaveLength(2);
    expect(requests[1]![2]).toEqual({ state: 'suspended', skipped: 5 });
  });

  it('records a new request in a later episode (after the state became running again)', async () => {
    const h = setup({}, 'suspended');
    press(h);
    await flush();
    h.clock.t += 100;
    press(h);
    h.ctx.setState('suspended');
    h.clock.t += 100;
    press(h);
    await flush();
    expect(h.calls.filter((c) => c[1] === 'resume.requested')).toHaveLength(2);
  });
});

describe('fetch.failed and decode.result', () => {
  it('records the timbre and the HTTP status of a failed fetch, and keeps the retry behaviour', async () => {
    const fetchBytes = vi.fn(async () => {
      throw new SoundHttpError(404);
    });
    const h = setup({ fetchBytes });
    h.player.prepare('typewriter');
    await flush();
    expect(h.calls).toEqual([['warn', 'fetch.failed', { timbre: 'typewriter', status: 404, error: 'SoundHttpError' }]]);
    // 従来どおり、次の prepare でもう一度読む。
    h.player.prepare('typewriter');
    await flush();
    expect(fetchBytes.mock.calls.length).toBeGreaterThan(URLS.length);
  });

  it('records the error name (and a null status) for a network failure', async () => {
    const h = setup({ fetchBytes: vi.fn(async () => Promise.reject(new TypeError('Failed to fetch'))) });
    h.player.prepare('keyboard');
    await flush();
    expect(h.calls).toEqual([['warn', 'fetch.failed', { timbre: 'keyboard', status: null, error: 'TypeError' }]]);
    expect(JSON.stringify(h.calls)).not.toContain('Failed to fetch');
  });

  it('records the number of decoded and failed materials (info when all decoded)', async () => {
    const h = setup();
    await ready(h);
    expect(h.calls.find((c) => c[1] === 'decode.result')).toEqual(['info', 'decode.result', { timbre: 'keyboard', ok: 3, failed: 0 }]);
  });

  it('records warn with the failed count and the first error name when some or all fail to decode', async () => {
    const h = setup();
    let n = 0;
    h.ctx.decodeAudioData.mockImplementation(async (data: ArrayBuffer) => {
      n += 1;
      if (n <= 2) throw Object.assign(new Error('Unable to decode audio data'), { name: 'EncodingError' });
      return { duration: data.byteLength / 1000 };
    });
    await ready(h);
    expect(h.calls.find((c) => c[1] === 'decode.result')).toEqual(['warn', 'decode.result', { timbre: 'keyboard', ok: 1, failed: 2, error: 'EncodingError' }]);

    const all = setup();
    all.ctx.decodeAudioData.mockImplementation(async () => {
      throw new DOMException('x', 'EncodingError');
    });
    await ready(all);
    expect(all.calls.find((c) => c[1] === 'decode.result')![2]).toMatchObject({ ok: 0, failed: 3, error: 'EncodingError' });
  });

  it('does not record the result of a decode that finishes after dispose', async () => {
    const h = setup();
    h.player.prepare('keyboard');
    await flush();
    press(h);
    h.player.dispose();
    await flush();
    expect(h.events()).not.toContain('decode.result');
  });
});

describe('clock.stalled and clock.recovered', () => {
  /** 壁の時計を進め、currentTime を（壁の時計の何倍の速さで）進めて、1 キー押す。 */
  function tick(h: Harness, wallMs: number, speed: number, k = 'a') {
    h.clock.t += wallMs;
    h.ctx.currentTime += (wallMs / 1000) * speed;
    press(h, k);
  }

  it('records warn once when the state is running but currentTime does not advance (less than a quarter of the wall time), with elapsed, advance and state', async () => {
    const h = setup();
    await ready(h);
    tick(h, 500, 1); // 基準を取り直す（ready の最初のキーで取った基準から 600ms 後。進みは正常）
    const before = h.calls.length;
    tick(h, 600, 0);
    expect(h.calls.slice(before)).toEqual([['warn', 'clock.stalled', { elapsed_ms: 600, advance_ms: 0, state: 'running' }]]);
    // 止まりが続く間は、もう記録しない。
    tick(h, 600, 0);
    tick(h, 3000, 0.1);
    expect(h.calls.filter((c) => c[1] === 'clock.stalled')).toHaveLength(1);
  });

  it('records info clock.recovered when it advances again (once), and warns again for a second stall', async () => {
    const h = setup();
    await ready(h);
    tick(h, 500, 1); // 基準を取り直す（ready の最初のキーで取った基準から 600ms 後。進みは正常）
    tick(h, 600, 0);
    tick(h, 600, 1);
    expect(h.calls.at(-1)).toEqual(['info', 'clock.recovered', { elapsed_ms: 600, advance_ms: 600, state: 'running' }]);
    tick(h, 600, 1);
    expect(h.calls.filter((c) => c[1] === 'clock.recovered')).toHaveLength(1);
    tick(h, 600, 0);
    expect(h.calls.filter((c) => c[1] === 'clock.stalled')).toHaveLength(2);
  });

  it('does not suspect a clock that advances normally, nor one that is slightly slow (exactly a quarter is not a stall)', async () => {
    const h = setup();
    await ready(h);
    tick(h, 500, 1); // 基準を取り直す（ready の最初のキーで取った基準から 600ms 後。進みは正常）
    tick(h, 1000, 1);
    tick(h, 1000, 0.9);
    tick(h, 2000, STALL_ADVANCE_RATIO);
    tick(h, 2000, 0.3);
    expect(h.events().filter((e) => e.startsWith('clock.'))).toEqual([]);
  });

  it('compares only after STALL_MIN_WALL_MS of wall time (shorter gaps accumulate)', async () => {
    const h = setup();
    await ready(h);
    tick(h, 500, 1); // 基準を取り直す（ready の最初のキーで取った基準から 600ms 後。進みは正常）
    // 30ms 未満の間隔のキーは、鳴らさない（間引き）ので、比べもしない。30ms あけて 2 回。
    tick(h, STALL_MIN_WALL_MS - 30, 0);
    expect(h.events()).not.toContain('clock.stalled');
    tick(h, 30, 0);
    expect(h.calls.at(-1)).toEqual(['warn', 'clock.stalled', { elapsed_ms: STALL_MIN_WALL_MS, advance_ms: 0, state: 'running' }]);
  });

  it('takes a new baseline after the state was not running (a resume), so the time spent suspended is not a stall', async () => {
    const h = setup();
    await ready(h);
    tick(h, 500, 1); // 基準を取り直す（ready の最初のキーで取った基準から 600ms 後。進みは正常）
    // 窓が裏に回って suspended。壁の時計は 30 秒進むが、currentTime は止まる。
    h.ctx.setState('suspended');
    h.clock.t += 30_000;
    press(h); // resume を頼む（比べない）
    await flush();
    // resume のあと、すぐの 1 キーは基準を取るだけ。長い間の差で止まりとは見ない。
    h.clock.t += 40;
    h.ctx.currentTime += 0.04;
    press(h);
    expect(h.events()).not.toContain('clock.stalled');
    tick(h, 600, 1);
    expect(h.events()).not.toContain('clock.stalled');
  });

  it('only looks at the keys that play (a key that makes no sound does not move the baseline or record)', async () => {
    const h = setup();
    await ready(h);
    tick(h, 500, 1); // 基準を取り直す（ready の最初のキーで取った基準から 600ms 後。進みは正常）
    h.clock.t += 5000;
    h.player.handleKeyDown(key('Shift'), 'medium', 'keyboard');
    h.player.handleKeyDown(key('ArrowLeft'), 'medium', 'keyboard');
    expect(h.events()).not.toContain('clock.stalled');
    // 次の鳴らすキーは、最後に見たときからの差で比べる。
    h.clock.t += 600;
    press(h);
    expect(h.calls.at(-1)![1]).toBe('clock.stalled');
  });

  it('does not change what is played: the sound is still started with the same arguments while a stall is recorded', async () => {
    const h = setup();
    await ready(h);
    tick(h, 500, 1); // 基準を取り直す（ready の最初のキーで取った基準から 600ms 後。進みは正常）
    const played = h.sources.length;
    tick(h, 600, 0);
    expect(h.sources.length).toBe(played + 1);
    expect(h.sources.at(-1)!.start).toHaveBeenCalledTimes(1);
  });

  it('does not read currentTime for a key that does not play, and never awaits (the sound starts inside the keydown call)', async () => {
    const h = setup();
    await ready(h);
    tick(h, 500, 1); // 基準を取り直す（ready の最初のキーで取った基準から 600ms 後。進みは正常）
    let reads = 0;
    let value = h.ctx.currentTime;
    Object.defineProperty(h.ctx, 'currentTime', { get: () => (reads++, value), set: (v: number) => void (value = v), configurable: true });
    h.player.handleKeyDown(key('Shift'), 'medium', 'keyboard');
    expect(reads).toBe(0);
    h.clock.t += 100;
    const sources = h.sources.length;
    press(h);
    expect(reads).toBe(1);
    // 同じ呼び出しの中で start まで終わっている。
    expect(h.sources.length).toBe(sources + 1);
    expect(h.sources.at(-1)!.start).toHaveBeenCalledTimes(1);
  });
});

describe('devicechange', () => {
  it('records the device change with the state and the output latency, when mediaDevices can send events', async () => {
    const d = fakeDevices();
    const h = setup({ mediaDevices: d.devices });
    // AudioContext を作るまでは、聞かない（オフの間は何もない）。
    expect(d.count()).toBe(0);
    await ready(h);
    expect(d.count()).toBe(1);
    h.ctx.outputLatency = 0.12;
    d.fire();
    expect(h.calls.at(-1)).toEqual(['info', 'devicechange', { state: 'running', output_latency: 0.12 }]);
  });

  it('does nothing when there is no mediaDevices or it cannot send events', async () => {
    const none = setup({ mediaDevices: null });
    await ready(none);
    expect(none.events()).not.toContain('devicechange');
    const noEvents = setup({ mediaDevices: {} as unknown as DeviceEventSource });
    await expect(ready(noEvents)).resolves.toBeUndefined();
  });

  it('uses navigator.mediaDevices when the option is omitted (and skips it where it is missing)', async () => {
    const d = fakeDevices();
    vi.stubGlobal('navigator', { mediaDevices: d.devices });
    try {
      const f = fakeContext();
      const calls: Call[] = [];
      const player = createTypingSoundPlayer({ urls: { keyboard: URLS, typewriter: URLS }, createContext: () => f.ctx as unknown as SoundContext, fetchBytes: async () => new ArrayBuffer(250), log: (l, e, x) => void calls.push([l, e, x]) });
      player.handleKeyDown(key('a'), 'medium', 'keyboard');
      expect(d.count()).toBe(1);
      player.dispose();
      expect(d.count()).toBe(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('the log never gets in the way of the sound', () => {
  it('a log function that throws does not break the key handler, the fetch, the decode or resume', async () => {
    const h = setup({
      log: () => {
        throw new Error('log is broken');
      },
    });
    h.player.prepare('keyboard');
    await flush();
    expect(() => press(h)).not.toThrow();
    await flush();
    h.clock.t += 100;
    press(h);
    expect(h.sources.length).toBe(1);
    expect(h.sources[0]!.start).toHaveBeenCalledTimes(1);

    const suspended = setup(
      {
        log: () => {
          throw new Error('log is broken');
        },
      },
      'suspended',
    );
    press(suspended);
    await flush();
    expect(suspended.ctx.resume).toHaveBeenCalledTimes(1);
  });

  it('records nothing when no log function is given (the existing behaviour)', async () => {
    const h = setup({ log: undefined });
    await ready(h);
    expect(h.calls).toEqual([]);
    expect(h.sources.length).toBe(0);
    h.clock.t += 100;
    press(h);
    expect(h.sources.length).toBe(1);
  });

  it('never records per key: 50 playing keys on a healthy running context make no entries after the setup ones', async () => {
    const h = setup();
    await ready(h);
    const before = h.calls.length;
    for (let i = 0; i < 50; i++) {
      h.clock.t += 100;
      h.ctx.currentTime += 0.1;
      press(h);
    }
    expect(h.calls.length).toBe(before);
  });

  it('never puts text, paths or keys in the data (only numbers, booleans, null and short names)', async () => {
    const h = setup();
    await ready(h);
    h.ctx.setState('suspended');
    press(h, 'q');
    h.clock.t += 600;
    for (const [, event, data] of h.calls) {
      expect(event).toMatch(/^[a-z0-9._-]{1,64}$/);
      for (const [k, v] of Object.entries(data ?? {})) {
        expect(k).toMatch(/^[a-z0-9._-]{1,64}$/);
        expect(['number', 'boolean', 'string', 'object']).toContain(typeof v);
        if (typeof v === 'string') expect(v.length).toBeLessThan(40);
      }
    }
    expect(JSON.stringify(h.calls)).not.toMatch(/"q"|\/s\/|wav/);
  });
});
