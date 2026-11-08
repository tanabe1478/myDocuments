import { describe, expect, it, vi } from 'vitest';
import type { KeyEventLike } from './keys';
import {
  ENTER_RATE,
  GAIN_JITTER,
  MAX_VOICES,
  MIN_INTERVAL_MS,
  PITCH_JITTER,
  VOLUME_GAIN,
  VOLUME_LEVELS,
  createTypingSoundPlayer,
  type SoundBuffer,
  type SoundContext,
  type SoundSource,
  type TypingSoundEvent,
  type TypingSoundPlayerOptions,
} from './player';

const URLS = Array.from({ length: 10 }, (_, i) => `/s/${i}.wav`);
const key = (k = 'a', patch: Partial<KeyEventLike> = {}): KeyEventLike => ({ key: k, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...patch });

/** 差し替えられる AudioContext。作った音源と gain を全部記録する。 */
function fakeContext(state = 'running') {
  const sources: Array<SoundSource & { started: number; gainNode: { gain: { value: number } } }> = [];
  const ctx = {
    state,
    destination: { name: 'destination' },
    resume: vi.fn(async () => {
      ctx.state = 'running';
    }),
    close: vi.fn(async () => {
      ctx.state = 'closed';
    }),
    decodeAudioData: vi.fn(async (data: ArrayBuffer): Promise<SoundBuffer> => ({ duration: data.byteLength / 1000 })),
    createGain: vi.fn(() => ({ gain: { value: 1 }, connect: vi.fn(), disconnect: vi.fn() })),
    createBufferSource: vi.fn(() => {
      const source = {
        buffer: null as SoundBuffer | null,
        playbackRate: { value: 1 },
        onended: null as (() => void) | null,
        started: 0,
        gainNode: { gain: { value: 1 } },
        connect: vi.fn((target: { gain?: { value: number } }) => {
          if (target?.gain) source.gainNode = target as { gain: { value: number } };
        }),
        disconnect: vi.fn(),
        start: vi.fn(() => {
          source.started += 1;
        }),
      };
      sources.push(source);
      return source;
    }),
  };
  return { ctx: ctx as unknown as SoundContext & { state: string; resume: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> }, sources, raw: ctx };
}

/** 決めた値を順に返す乱数（足りなくなったら 0.5）。 */
const sequence = (...values: number[]) => {
  const queue = [...values];
  return () => queue.shift() ?? 0.5;
};

interface Harness {
  player: ReturnType<typeof createTypingSoundPlayer>;
  ctx: ReturnType<typeof fakeContext>;
  createContext: ReturnType<typeof vi.fn>;
  fetchBytes: ReturnType<typeof vi.fn>;
  events: TypingSoundEvent[];
  clock: { t: number };
}

function setup(over: Partial<TypingSoundPlayerOptions> = {}, state = 'running'): Harness {
  const ctx = fakeContext(state);
  const clock = { t: 1000 };
  const events: TypingSoundEvent[] = [];
  const createContext = vi.fn(() => ctx.ctx);
  // 素材のバイト列の長さ（ミリ秒の長さの 1000 倍）。duration は 250 バイト = 0.25 秒。
  const fetchBytes = vi.fn(async () => new ArrayBuffer(250));
  const player = createTypingSoundPlayer({
    urls: URLS,
    createContext,
    fetchBytes,
    now: () => clock.t,
    observe: (e) => events.push(e),
    ...over,
  });
  return { player, ctx, createContext, fetchBytes, events, clock };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

/** 素材を読み込み、最初のキーで AudioContext を作り、デコードを終えるまで進める（最初のキーは鳴らない）。 */
async function ready(h: Harness): Promise<void> {
  h.player.prepare();
  await flush();
  h.player.handleKeyDown(key('a'), 'medium');
  await flush();
  h.clock.t += 1000;
}

const sounds = (h: Harness) => h.events.filter((e): e is Extract<TypingSoundEvent, { type: 'sound' }> => e.type === 'sound');

describe('nothing happens until the setting is on', () => {
  it('creating the player fetches nothing and creates no AudioContext', () => {
    const h = setup();
    expect(h.fetchBytes).not.toHaveBeenCalled();
    expect(h.createContext).not.toHaveBeenCalled();
  });

  it('a key without prepare (setting off, no extension) creates nothing — the extension is absent, but even a direct call does not fetch', () => {
    const h = setup();
    h.player.handleKeyDown(key('a'), 'medium');
    expect(h.fetchBytes).not.toHaveBeenCalled();
    expect(sounds(h)).toEqual([]);
  });

  it('prepare fetches every file once (not an AudioContext), and is idempotent', async () => {
    const h = setup();
    h.player.prepare();
    h.player.prepare();
    await flush();
    h.player.prepare();
    expect(h.fetchBytes).toHaveBeenCalledTimes(10);
    expect(h.fetchBytes.mock.calls.map(([url]) => url)).toEqual(URLS);
    expect(h.createContext).not.toHaveBeenCalled();
  });

  it('a failed fetch is retried at the next prepare, and does not throw', async () => {
    let fail = true;
    const h = setup({
      fetchBytes: async () => {
        if (fail) throw new Error('offline');
        return new ArrayBuffer(250);
      },
    });
    h.player.prepare();
    await flush();
    h.player.handleKeyDown(key('a'), 'medium');
    await flush();
    expect(sounds(h)).toEqual([]);
    fail = false;
    // 2 回目の prepare で読み込み直し、AudioContext がもうあるので、そのままデコードまで進む。次のキーから鳴る。
    h.player.prepare();
    await flush();
    h.player.handleKeyDown(key('a'), 'medium');
    expect(sounds(h)).toHaveLength(1);
  });
});

describe('the AudioContext is created inside a key press, and the first keys wait for decoding', () => {
  it('creates the AudioContext at the first sounding key (not at prepare), decodes all files, and does not sound before decoding ends', async () => {
    const h = setup();
    h.player.prepare();
    await flush();
    expect(h.createContext).not.toHaveBeenCalled();
    h.player.handleKeyDown(key('a'), 'medium');
    expect(h.createContext).toHaveBeenCalledTimes(1);
    expect(sounds(h)).toEqual([]);
    await flush();
    expect(h.ctx.raw.decodeAudioData).toHaveBeenCalledTimes(10);
    expect(h.events).toContainEqual({ type: 'decoded', count: 10 });
  });

  it('keys that do not sound do not create the AudioContext', async () => {
    const h = setup();
    h.player.prepare();
    await flush();
    for (const k of ['Shift', 'ArrowLeft', 'Escape', 'F5']) h.player.handleKeyDown(key(k), 'medium');
    h.player.handleKeyDown(key('s', { metaKey: true }), 'medium');
    expect(h.createContext).not.toHaveBeenCalled();
  });

  it('starts decoding when the files arrive after the first key (the key itself does not sound)', async () => {
    const releases: Array<() => void> = [];
    const h = setup({
      fetchBytes: () => new Promise((resolve) => releases.push(() => resolve(new ArrayBuffer(250)))),
    });
    h.player.prepare();
    h.player.handleKeyDown(key('a'), 'medium');
    expect(h.createContext).toHaveBeenCalledTimes(1);
    expect(h.ctx.raw.decodeAudioData).not.toHaveBeenCalled();
    expect(releases).toHaveLength(10);
    for (const release of releases) release();
    await flush();
    expect(h.ctx.raw.decodeAudioData).toHaveBeenCalledTimes(10);
    expect(sounds(h)).toEqual([]);
    h.clock.t += 100;
    h.player.handleKeyDown(key('a'), 'medium');
    expect(sounds(h)).toHaveLength(1);
  });

  it('a decode failure of some files keeps the rest; none decoded means no sound and no throw', async () => {
    const h = setup();
    let n = 0;
    h.ctx.raw.decodeAudioData.mockImplementation(async () => {
      if (n++ % 2 === 0) throw new Error('bad data');
      return { duration: 0.25 };
    });
    await ready(h);
    expect(h.events).toContainEqual({ type: 'decoded', count: 5 });
    h.player.handleKeyDown(key('a'), 'medium');
    expect(sounds(h)).toHaveLength(1);

    const none = setup();
    none.ctx.raw.decodeAudioData.mockRejectedValue(new Error('no codec'));
    await ready(none);
    expect(() => none.player.handleKeyDown(key('a'), 'medium')).not.toThrow();
    expect(sounds(none)).toEqual([]);
  });
});

describe('one sound request per key', () => {
  it('a sounding key starts exactly one source, connected through a gain node to the destination', async () => {
    const h = setup();
    await ready(h);
    h.player.handleKeyDown(key('a'), 'medium');
    expect(h.ctx.sources).toHaveLength(1);
    expect(h.ctx.sources[0]?.started).toBe(1);
    expect(sounds(h)).toHaveLength(1);
    const gain = h.ctx.raw.createGain.mock.results[0]?.value as { connect: ReturnType<typeof vi.fn> };
    expect(gain.connect).toHaveBeenCalledWith(h.ctx.raw.destination);
  });

  it('keys that do not sound make no request: modifiers, shortcuts, movement, Escape, function keys', async () => {
    const h = setup();
    await ready(h);
    const none = [
      key('Shift', { shiftKey: true }),
      key('Control', { ctrlKey: true }),
      key('Alt', { altKey: true }),
      key('Meta', { metaKey: true }),
      key('CapsLock'),
      key('c', { metaKey: true }),
      key('c', { ctrlKey: true }),
      key('ArrowDown'),
      key('Home'),
      key('Escape'),
      key('F6'),
    ];
    for (const k of none) {
      h.clock.t += 100;
      h.player.handleKeyDown(k, 'high');
    }
    expect(sounds(h)).toEqual([]);
    expect(h.ctx.sources).toEqual([]);
  });

  it.each([key('a'), key(' '), key('Enter'), key('Backspace'), key('Delete'), key('Tab'), key('Process', { keyCode: 229 })])('%o makes exactly one request', async (event) => {
    const h = setup();
    await ready(h);
    h.player.handleKeyDown(event, 'medium');
    expect(sounds(h)).toHaveLength(1);
    expect(h.ctx.sources).toHaveLength(1);
  });
});

describe('thinning: at most one sound per 30 ms, for held keys too', () => {
  it('drops a key that comes within 30 ms of the last sound, and allows it at 30 ms', async () => {
    const h = setup();
    await ready(h);
    h.player.handleKeyDown(key('a'), 'medium');
    h.clock.t += MIN_INTERVAL_MS - 1;
    h.player.handleKeyDown(key('b'), 'medium');
    expect(sounds(h)).toHaveLength(1);
    h.clock.t += 1;
    h.player.handleKeyDown(key('c'), 'medium');
    expect(sounds(h)).toHaveLength(2);
  });

  it('a held key (repeat events every 5 ms for 300 ms) makes at most 10 sounds', async () => {
    const h = setup();
    await ready(h);
    let count = 0;
    for (let t = 0; t < 300; t += 5) {
      h.clock.t = 5000 + t;
      h.player.handleKeyDown(key('a', { repeat: true }), 'medium');
      count = sounds(h).length;
    }
    expect(count).toBeLessThanOrEqual(300 / MIN_INTERVAL_MS);
    expect(count).toBeGreaterThanOrEqual(9);
  });

  it('a dropped key does not push the next allowed time back', async () => {
    const h = setup();
    await ready(h);
    h.player.handleKeyDown(key('a'), 'medium'); // t0
    h.clock.t += 20;
    h.player.handleKeyDown(key('b'), 'medium'); // 落ちる
    h.clock.t += 10; // t0 + 30
    h.player.handleKeyDown(key('c'), 'medium');
    expect(sounds(h)).toHaveLength(2);
  });
});

describe('at most 8 sounds at once', () => {
  it('drops the 9th while 8 are still sounding, and sounds again after one ends', async () => {
    const h = setup();
    await ready(h);
    // 0.25 秒の素材（再生速度 ほぼ 1）を 30 ms ごと。9 個目は 240 ms 目で、最初の音（約 270 ms まで）はまだ鳴っている。
    for (let i = 0; i < MAX_VOICES + 1; i++) {
      h.player.handleKeyDown(key('a'), 'medium');
      h.clock.t += MIN_INTERVAL_MS;
    }
    expect(sounds(h)).toHaveLength(MAX_VOICES);
    // 最初の音が鳴り終わる（約 270 ms）まで進める。
    h.clock.t += 100;
    h.player.handleKeyDown(key('a'), 'medium');
    expect(sounds(h)).toHaveLength(MAX_VOICES + 1);
  });
});

describe('choosing a file: random, never the same as the last one', () => {
  it('uses the injected random values: first from all files, then from the others', async () => {
    // 乱数の消費は 1 回の音につき 3 つ（ファイル、高さ、音量）。
    const h = setup({ random: sequence(0.95, 0.5, 0.5, 0.0, 0.5, 0.5, 0.0, 0.5, 0.5) });
    await ready(h);
    const play = () => {
      h.clock.t += 100;
      h.player.handleKeyDown(key('a'), 'medium');
    };
    play(); // 0.95 * 10 → 9
    play(); // 0.0 * 9 → 0（9 を除いた中の 0 番目）
    play(); // 0.0 → 0 は直前と同じなので 1 になる
    expect(sounds(h).map((s) => s.index)).toEqual([9, 0, 1]);
  });

  it('never picks the same file twice in a row, for every random value', async () => {
    for (let step = 0; step < 100; step++) {
      const r = step / 100;
      const h = setup({ random: () => r });
      await ready(h);
      for (let i = 0; i < 4; i++) {
        h.clock.t += 100;
        h.player.handleKeyDown(key('a'), 'medium');
      }
      const picked = sounds(h).map((s) => s.index);
      for (let i = 1; i < picked.length; i++) expect(picked[i], `random ${r}`).not.toBe(picked[i - 1]);
      for (const p of picked) expect(p).toBeGreaterThanOrEqual(0), expect(p).toBeLessThan(10);
    }
  });

  it('reaches all 10 files with real random values, and never repeats the last one', async () => {
    const h = setup({ random: Math.random });
    await ready(h);
    for (let i = 0; i < 400; i++) {
      h.clock.t += 100;
      h.player.handleKeyDown(key('a'), 'medium');
    }
    const picked = sounds(h).map((s) => s.index);
    expect(new Set(picked).size).toBe(10);
    for (let i = 1; i < picked.length; i++) expect(picked[i]).not.toBe(picked[i - 1]);
  });

  it('with a single file, plays it every time', async () => {
    const h = setup({ urls: ['/only.wav'], random: sequence(0.9, 0.5, 0.5, 0.1, 0.5, 0.5) });
    await ready(h);
    h.clock.t += 100;
    h.player.handleKeyDown(key('a'), 'medium');
    h.clock.t += 100;
    h.player.handleKeyDown(key('a'), 'medium');
    expect(sounds(h).map((s) => s.index)).toEqual([0, 0]);
  });
});

describe('pitch and loudness', () => {
  const requestWith = async (random: () => number, k: KeyEventLike, volume: 'low' | 'medium' | 'high') => {
    const h = setup({ random });
    await ready(h);
    h.player.handleKeyDown(k, volume);
    const [s] = sounds(h);
    const source = h.ctx.sources[0];
    return { event: s!, rate: source!.playbackRate.value, gain: source!.gainNode.gain.value };
  };

  it('pitch varies by ±4% and loudness by ±10% around the base, with the extremes at random 0 and 1', async () => {
    const low = await requestWith(sequence(0.5, 0, 0), key('a'), 'medium');
    expect(low.rate).toBeCloseTo(1 - PITCH_JITTER, 10);
    expect(low.gain).toBeCloseTo(VOLUME_GAIN.medium * (1 - GAIN_JITTER), 10);
    const high = await requestWith(sequence(0.5, 0.999999, 0.999999), key('a'), 'medium');
    expect(high.rate).toBeCloseTo(1 + PITCH_JITTER, 4);
    expect(high.gain).toBeCloseTo(VOLUME_GAIN.medium * (1 + GAIN_JITTER), 4);
    const mid = await requestWith(sequence(0.5, 0.5, 0.5), key('a'), 'medium');
    expect(mid.rate).toBeCloseTo(1, 10);
    expect(mid.gain).toBeCloseTo(VOLUME_GAIN.medium, 10);
  });

  it('Enter is lower: playback rate around 0.8 (0.8 ± 4%), other keys around 1', async () => {
    const enter = await requestWith(sequence(0.5, 0.5, 0.5), key('Enter'), 'medium');
    expect(enter.rate).toBeCloseTo(ENTER_RATE, 10);
    expect(enter.event.kind).toBe('enter');
    const lowest = await requestWith(sequence(0.5, 0, 0.5), key('Enter'), 'medium');
    const highest = await requestWith(sequence(0.5, 0.999999, 0.5), key('Enter'), 'medium');
    expect(lowest.rate).toBeCloseTo(ENTER_RATE * 0.96, 10);
    expect(highest.rate).toBeCloseTo(ENTER_RATE * 1.04, 4);
    for (const k of [key('a'), key(' '), key('Backspace'), key('Delete'), key('Tab'), key('Process', { keyCode: 229 })]) {
      const r = await requestWith(sequence(0.5, 0.5, 0.5), k, 'medium');
      expect(r.rate, k.key).toBeCloseTo(1, 10);
      expect(r.event.kind).toBe('key');
    }
  });

  it('low, medium and high have clearly different gains (each step is a doubling, 6 dB)', async () => {
    const gains = [];
    for (const level of VOLUME_LEVELS) gains.push((await requestWith(sequence(0.5, 0.5, 0.5), key('a'), level)).gain);
    expect(gains).toEqual([0.25, 0.5, 1]);
    expect(gains[1]! / gains[0]!).toBeCloseTo(2, 10);
    expect(gains[2]! / gains[1]!).toBeCloseTo(2, 10);
    // 揺れを含めても、段階の範囲は重ならない（小の最大 < 中の最小、中の最大 < 大の最小）。
    expect(VOLUME_GAIN.low * (1 + GAIN_JITTER)).toBeLessThan(VOLUME_GAIN.medium * (1 - GAIN_JITTER));
    expect(VOLUME_GAIN.medium * (1 + GAIN_JITTER)).toBeLessThan(VOLUME_GAIN.high * (1 - GAIN_JITTER));
  });

  it('the loudest case (high, +10%) on the loudest file (peak 0.66) stays below full scale', () => {
    expect(0.662 * VOLUME_GAIN.high * (1 + GAIN_JITTER)).toBeLessThan(1);
  });

  it('the volume is read at each key (a change takes effect on the next key)', async () => {
    const h = setup({ random: () => 0.5 });
    await ready(h);
    h.player.handleKeyDown(key('a'), 'low');
    h.clock.t += 100;
    h.player.handleKeyDown(key('a'), 'high');
    expect(sounds(h).map((s) => s.gain)).toEqual([VOLUME_GAIN.low, VOLUME_GAIN.high]);
  });
});

describe('the AudioContext state (window in the background, sleep)', () => {
  it('a suspended context is resumed by the key press, and that key does not sound; the next one does', async () => {
    const h = setup({}, 'suspended');
    h.player.prepare();
    await flush();
    h.player.handleKeyDown(key('a'), 'medium');
    expect(h.ctx.raw.resume).toHaveBeenCalledTimes(1);
    await flush();
    expect(h.ctx.ctx.state).toBe('running');
    h.clock.t += 100;
    h.player.handleKeyDown(key('a'), 'medium');
    expect(sounds(h)).toHaveLength(1);
    expect(h.ctx.raw.resume).toHaveBeenCalledTimes(1);
  });

  it('after the context is suspended later (sleep), the next key resumes it and then sound returns', async () => {
    const h = setup();
    await ready(h);
    h.player.handleKeyDown(key('a'), 'medium');
    h.ctx.raw.state = 'suspended';
    h.clock.t += 100;
    h.player.handleKeyDown(key('a'), 'medium');
    expect(h.ctx.raw.resume).toHaveBeenCalledTimes(1);
    expect(sounds(h)).toHaveLength(1);
    await flush();
    h.clock.t += 100;
    h.player.handleKeyDown(key('a'), 'medium');
    expect(sounds(h)).toHaveLength(2);
  });

  it('an interrupted context (Safari) is resumed too', async () => {
    const h = setup();
    await ready(h);
    h.ctx.raw.state = 'interrupted';
    h.player.handleKeyDown(key('a'), 'medium');
    expect(h.ctx.raw.resume).toHaveBeenCalledTimes(1);
    expect(sounds(h)).toEqual([]);
  });

  it('a context that was closed from outside is created again at the next key', async () => {
    const h = setup();
    await ready(h);
    h.ctx.raw.state = 'closed';
    h.player.handleKeyDown(key('a'), 'medium');
    expect(h.createContext).toHaveBeenCalledTimes(2);
  });
});

describe('failures never reach the caller', () => {
  it('does not throw when creating the AudioContext fails, and tries again at the next key', async () => {
    const createContext = vi.fn(() => {
      throw new Error('no audio device');
    });
    const h = setup({ createContext });
    h.player.prepare();
    await flush();
    expect(() => h.player.handleKeyDown(key('a'), 'medium')).not.toThrow();
    expect(() => h.player.handleKeyDown(key('b'), 'medium')).not.toThrow();
    expect(createContext).toHaveBeenCalledTimes(2);
  });

  it('does not throw when resume rejects', async () => {
    const h = setup({}, 'suspended');
    h.ctx.raw.resume.mockRejectedValue(new Error('not allowed'));
    h.player.prepare();
    await flush();
    expect(() => h.player.handleKeyDown(key('a'), 'medium')).not.toThrow();
    await flush();
  });

  it('does not throw when starting the source throws, and does not count it as a sound', async () => {
    const h = setup();
    await ready(h);
    h.ctx.raw.createBufferSource.mockImplementationOnce(() => {
      throw new Error('InvalidStateError');
    });
    expect(() => h.player.handleKeyDown(key('a'), 'medium')).not.toThrow();
    expect(sounds(h)).toEqual([]);
    // 失敗は間引きの基準にならない。直後のキーは鳴る。
    h.player.handleKeyDown(key('a'), 'medium');
    expect(sounds(h)).toHaveLength(1);
  });

  it('does not throw when an observer throws, and still plays', async () => {
    const h = setup({
      observe: () => {
        throw new Error('observer bug');
      },
    });
    await ready(h);
    expect(() => h.player.handleKeyDown(key('a'), 'medium')).not.toThrow();
    expect(h.ctx.sources).toHaveLength(1);
  });

  it('does not throw for a malformed event', () => {
    const h = setup();
    expect(() => h.player.handleKeyDown({} as KeyEventLike, 'medium')).not.toThrow();
    expect(() => h.player.handleKeyDown(null as unknown as KeyEventLike, 'medium')).not.toThrow();
  });

  it('a failing onended cleanup does not throw', async () => {
    const h = setup();
    await ready(h);
    h.player.handleKeyDown(key('a'), 'medium');
    const source = h.ctx.sources[0]!;
    source.disconnect = () => {
      throw new Error('x');
    };
    expect(() => source.onended?.()).not.toThrow();
  });
});

describe('dispose (the plugin is removed)', () => {
  it('closes the AudioContext, and sounds no more; a second dispose is harmless', async () => {
    const h = setup();
    await ready(h);
    h.player.dispose();
    expect(h.ctx.raw.close).toHaveBeenCalledTimes(1);
    h.clock.t += 100;
    h.player.handleKeyDown(key('a'), 'medium');
    expect(h.ctx.sources).toEqual([]);
    expect(() => h.player.dispose()).not.toThrow();
    expect(h.ctx.raw.close).toHaveBeenCalledTimes(1);
  });

  it('without a context, dispose only stops later work (no AudioContext is created for closing)', () => {
    const h = setup();
    h.player.dispose();
    h.player.prepare();
    h.player.handleKeyDown(key('a'), 'medium');
    expect(h.createContext).not.toHaveBeenCalled();
    expect(h.fetchBytes).not.toHaveBeenCalled();
  });

  it('does not throw when close rejects or throws', async () => {
    const h = setup();
    await ready(h);
    h.ctx.raw.close.mockRejectedValue(new Error('x'));
    expect(() => h.player.dispose()).not.toThrow();
    const h2 = setup();
    await ready(h2);
    h2.ctx.raw.close.mockImplementation(() => {
      throw new Error('y');
    });
    expect(() => h2.player.dispose()).not.toThrow();
  });
});
