import { describe, expect, it, vi } from 'vitest';
import type { KeyEventLike } from './keys';
import {
  DEFAULT_TIMBRE,
  ENTER_RATE,
  GAIN_JITTER,
  MAX_VOICES,
  MIN_INTERVAL_MS,
  PITCH_JITTER,
  TIMBRES,
  TIMBRE_GAIN,
  VOLUME_GAIN,
  VOLUME_LEVELS,
  createAudioContext,
  createTypingSoundPlayer,
  isTimbre,
  type SoundBuffer,
  type SoundContext,
  type SoundSource,
  type TypingSoundEvent,
  type TypingSoundPlayerOptions,
} from './player';
import extensionSource from './extension.ts?raw';
import playerSource from './player.ts?raw';

const URLS = Array.from({ length: 10 }, (_, i) => `/s/${i}.wav`);
const TYPEWRITER_URLS = Array.from({ length: 8 }, (_, i) => `/t/${i}.wav`);
const key = (k = 'a', patch: Partial<KeyEventLike> = {}): KeyEventLike => ({ key: k, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...patch });

/** 差し替えられる AudioContext。作った音源と gain を全部記録する。 */
function fakeContext(state = 'running') {
  const sources: Array<SoundSource & { started: number; startArgs: Array<[number | undefined, number | undefined]>; gainNode: { gain: { value: number } } }> = [];
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
        startArgs: [] as Array<[number | undefined, number | undefined]>,
        gainNode: { gain: { value: 1 } },
        connect: vi.fn((target: { gain?: { value: number } }) => {
          if (target?.gain) source.gainNode = target as { gain: { value: number } };
        }),
        disconnect: vi.fn(),
        start: vi.fn((when?: number, offset?: number) => {
          source.started += 1;
          source.startArgs.push([when, offset]);
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
    urls: { keyboard: URLS, typewriter: TYPEWRITER_URLS },
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
  h.player.prepare('keyboard');
  await flush();
  h.player.handleKeyDown(key('a'), 'medium', 'keyboard');
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
    h.player.handleKeyDown(key('a'), 'medium', 'keyboard');
    expect(h.fetchBytes).not.toHaveBeenCalled();
    expect(sounds(h)).toEqual([]);
  });

  it('prepare fetches every file once (not an AudioContext), and is idempotent', async () => {
    const h = setup();
    h.player.prepare('keyboard');
    h.player.prepare('keyboard');
    await flush();
    h.player.prepare('keyboard');
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
    h.player.prepare('keyboard');
    await flush();
    h.player.handleKeyDown(key('a'), 'medium', 'keyboard');
    await flush();
    expect(sounds(h)).toEqual([]);
    fail = false;
    // 2 回目の prepare で読み込み直し、AudioContext がもうあるので、そのままデコードまで進む。次のキーから鳴る。
    h.player.prepare('keyboard');
    await flush();
    h.player.handleKeyDown(key('a'), 'medium', 'keyboard');
    expect(sounds(h)).toHaveLength(1);
  });
});

describe('the AudioContext is created inside a key press, and the first keys wait for decoding', () => {
  it('creates the AudioContext at the first sounding key (not at prepare), decodes all files, and does not sound before decoding ends', async () => {
    const h = setup();
    h.player.prepare('keyboard');
    await flush();
    expect(h.createContext).not.toHaveBeenCalled();
    h.player.handleKeyDown(key('a'), 'medium', 'keyboard');
    expect(h.createContext).toHaveBeenCalledTimes(1);
    expect(sounds(h)).toEqual([]);
    await flush();
    expect(h.ctx.raw.decodeAudioData).toHaveBeenCalledTimes(10);
    expect(h.events).toContainEqual({ type: 'decoded', timbre: 'keyboard', count: 10, offsets: Array(10).fill(0) });
  });

  it('keys that do not sound do not create the AudioContext', async () => {
    const h = setup();
    h.player.prepare('keyboard');
    await flush();
    for (const k of ['Shift', 'ArrowLeft', 'Escape', 'F5']) h.player.handleKeyDown(key(k), 'medium', 'keyboard');
    h.player.handleKeyDown(key('s', { metaKey: true }), 'medium', 'keyboard');
    expect(h.createContext).not.toHaveBeenCalled();
  });

  it('starts decoding when the files arrive after the first key (the key itself does not sound)', async () => {
    const releases: Array<() => void> = [];
    const h = setup({
      fetchBytes: () => new Promise((resolve) => releases.push(() => resolve(new ArrayBuffer(250)))),
    });
    h.player.prepare('keyboard');
    h.player.handleKeyDown(key('a'), 'medium', 'keyboard');
    expect(h.createContext).toHaveBeenCalledTimes(1);
    expect(h.ctx.raw.decodeAudioData).not.toHaveBeenCalled();
    expect(releases).toHaveLength(10);
    for (const release of releases) release();
    await flush();
    expect(h.ctx.raw.decodeAudioData).toHaveBeenCalledTimes(10);
    expect(sounds(h)).toEqual([]);
    h.clock.t += 100;
    h.player.handleKeyDown(key('a'), 'medium', 'keyboard');
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
    expect(h.events).toContainEqual({ type: 'decoded', timbre: 'keyboard', count: 5, offsets: Array(5).fill(0) });
    h.player.handleKeyDown(key('a'), 'medium', 'keyboard');
    expect(sounds(h)).toHaveLength(1);

    const none = setup();
    none.ctx.raw.decodeAudioData.mockRejectedValue(new Error('no codec'));
    await ready(none);
    expect(() => none.player.handleKeyDown(key('a'), 'medium', 'keyboard')).not.toThrow();
    expect(sounds(none)).toEqual([]);
  });
});

describe('one sound request per key', () => {
  it('a sounding key starts exactly one source, connected through a gain node to the destination', async () => {
    const h = setup();
    await ready(h);
    h.player.handleKeyDown(key('a'), 'medium', 'keyboard');
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
      h.player.handleKeyDown(k, 'high', 'keyboard');
    }
    expect(sounds(h)).toEqual([]);
    expect(h.ctx.sources).toEqual([]);
  });

  it.each([key('a'), key(' '), key('Enter'), key('Backspace'), key('Delete'), key('Tab'), key('Process', { keyCode: 229 })])('%o makes exactly one request', async (event) => {
    const h = setup();
    await ready(h);
    h.player.handleKeyDown(event, 'medium', 'keyboard');
    expect(sounds(h)).toHaveLength(1);
    expect(h.ctx.sources).toHaveLength(1);
  });
});

describe('thinning: at most one sound per 30 ms, for held keys too', () => {
  it('drops a key that comes within 30 ms of the last sound, and allows it at 30 ms', async () => {
    const h = setup();
    await ready(h);
    h.player.handleKeyDown(key('a'), 'medium', 'keyboard');
    h.clock.t += MIN_INTERVAL_MS - 1;
    h.player.handleKeyDown(key('b'), 'medium', 'keyboard');
    expect(sounds(h)).toHaveLength(1);
    h.clock.t += 1;
    h.player.handleKeyDown(key('c'), 'medium', 'keyboard');
    expect(sounds(h)).toHaveLength(2);
  });

  it('a held key (repeat events every 5 ms for 300 ms) makes at most 10 sounds', async () => {
    const h = setup();
    await ready(h);
    let count = 0;
    for (let t = 0; t < 300; t += 5) {
      h.clock.t = 5000 + t;
      h.player.handleKeyDown(key('a', { repeat: true }), 'medium', 'keyboard');
      count = sounds(h).length;
    }
    expect(count).toBeLessThanOrEqual(300 / MIN_INTERVAL_MS);
    expect(count).toBeGreaterThanOrEqual(9);
  });

  it('a dropped key does not push the next allowed time back', async () => {
    const h = setup();
    await ready(h);
    h.player.handleKeyDown(key('a'), 'medium', 'keyboard'); // t0
    h.clock.t += 20;
    h.player.handleKeyDown(key('b'), 'medium', 'keyboard'); // 落ちる
    h.clock.t += 10; // t0 + 30
    h.player.handleKeyDown(key('c'), 'medium', 'keyboard');
    expect(sounds(h)).toHaveLength(2);
  });
});

describe('at most 8 sounds at once', () => {
  it('drops the 9th while 8 are still sounding, and sounds again after one ends', async () => {
    const h = setup();
    await ready(h);
    // 0.25 秒の素材（再生速度 ほぼ 1）を 30 ms ごと。9 個目は 240 ms 目で、最初の音（約 270 ms まで）はまだ鳴っている。
    for (let i = 0; i < MAX_VOICES + 1; i++) {
      h.player.handleKeyDown(key('a'), 'medium', 'keyboard');
      h.clock.t += MIN_INTERVAL_MS;
    }
    expect(sounds(h)).toHaveLength(MAX_VOICES);
    // 最初の音が鳴り終わる（約 270 ms）まで進める。
    h.clock.t += 100;
    h.player.handleKeyDown(key('a'), 'medium', 'keyboard');
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
      h.player.handleKeyDown(key('a'), 'medium', 'keyboard');
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
        h.player.handleKeyDown(key('a'), 'medium', 'keyboard');
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
      h.player.handleKeyDown(key('a'), 'medium', 'keyboard');
    }
    const picked = sounds(h).map((s) => s.index);
    expect(new Set(picked).size).toBe(10);
    for (let i = 1; i < picked.length; i++) expect(picked[i]).not.toBe(picked[i - 1]);
  });

  it('with a single file, plays it every time', async () => {
    const h = setup({ urls: { keyboard: ['/only.wav'], typewriter: [] }, random: sequence(0.9, 0.5, 0.5, 0.1, 0.5, 0.5) });
    await ready(h);
    h.clock.t += 100;
    h.player.handleKeyDown(key('a'), 'medium', 'keyboard');
    h.clock.t += 100;
    h.player.handleKeyDown(key('a'), 'medium', 'keyboard');
    expect(sounds(h).map((s) => s.index)).toEqual([0, 0]);
  });
});

describe('pitch and loudness', () => {
  const requestWith = async (random: () => number, k: KeyEventLike, volume: 'low' | 'medium' | 'high') => {
    const h = setup({ random });
    await ready(h);
    h.player.handleKeyDown(k, volume, 'keyboard');
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
    h.player.handleKeyDown(key('a'), 'low', 'keyboard');
    h.clock.t += 100;
    h.player.handleKeyDown(key('a'), 'high', 'keyboard');
    expect(sounds(h).map((s) => s.gain)).toEqual([VOLUME_GAIN.low, VOLUME_GAIN.high]);
  });
});

describe('the AudioContext state (window in the background, sleep)', () => {
  it('a suspended context is resumed by the key press, and that key does not sound; the next one does', async () => {
    const h = setup({}, 'suspended');
    h.player.prepare('keyboard');
    await flush();
    h.player.handleKeyDown(key('a'), 'medium', 'keyboard');
    expect(h.ctx.raw.resume).toHaveBeenCalledTimes(1);
    await flush();
    expect(h.ctx.ctx.state).toBe('running');
    h.clock.t += 100;
    h.player.handleKeyDown(key('a'), 'medium', 'keyboard');
    expect(sounds(h)).toHaveLength(1);
    expect(h.ctx.raw.resume).toHaveBeenCalledTimes(1);
  });

  it('after the context is suspended later (sleep), the next key resumes it and then sound returns', async () => {
    const h = setup();
    await ready(h);
    h.player.handleKeyDown(key('a'), 'medium', 'keyboard');
    h.ctx.raw.state = 'suspended';
    h.clock.t += 100;
    h.player.handleKeyDown(key('a'), 'medium', 'keyboard');
    expect(h.ctx.raw.resume).toHaveBeenCalledTimes(1);
    expect(sounds(h)).toHaveLength(1);
    await flush();
    h.clock.t += 100;
    h.player.handleKeyDown(key('a'), 'medium', 'keyboard');
    expect(sounds(h)).toHaveLength(2);
  });

  it('an interrupted context (Safari) is resumed too', async () => {
    const h = setup();
    await ready(h);
    h.ctx.raw.state = 'interrupted';
    h.player.handleKeyDown(key('a'), 'medium', 'keyboard');
    expect(h.ctx.raw.resume).toHaveBeenCalledTimes(1);
    expect(sounds(h)).toEqual([]);
  });

  it('a context that was closed from outside is created again at the next key', async () => {
    const h = setup();
    await ready(h);
    h.ctx.raw.state = 'closed';
    h.player.handleKeyDown(key('a'), 'medium', 'keyboard');
    expect(h.createContext).toHaveBeenCalledTimes(2);
  });
});

describe('failures never reach the caller', () => {
  it('does not throw when creating the AudioContext fails, and tries again at the next key', async () => {
    const createContext = vi.fn(() => {
      throw new Error('no audio device');
    });
    const h = setup({ createContext });
    h.player.prepare('keyboard');
    await flush();
    expect(() => h.player.handleKeyDown(key('a'), 'medium', 'keyboard')).not.toThrow();
    expect(() => h.player.handleKeyDown(key('b'), 'medium', 'keyboard')).not.toThrow();
    expect(createContext).toHaveBeenCalledTimes(2);
  });

  it('does not throw when resume rejects', async () => {
    const h = setup({}, 'suspended');
    h.ctx.raw.resume.mockRejectedValue(new Error('not allowed'));
    h.player.prepare('keyboard');
    await flush();
    expect(() => h.player.handleKeyDown(key('a'), 'medium', 'keyboard')).not.toThrow();
    await flush();
  });

  it('does not throw when starting the source throws, and does not count it as a sound', async () => {
    const h = setup();
    await ready(h);
    h.ctx.raw.createBufferSource.mockImplementationOnce(() => {
      throw new Error('InvalidStateError');
    });
    expect(() => h.player.handleKeyDown(key('a'), 'medium', 'keyboard')).not.toThrow();
    expect(sounds(h)).toEqual([]);
    // 失敗は間引きの基準にならない。直後のキーは鳴る。
    h.player.handleKeyDown(key('a'), 'medium', 'keyboard');
    expect(sounds(h)).toHaveLength(1);
  });

  it('does not throw when an observer throws, and still plays', async () => {
    const h = setup({
      observe: () => {
        throw new Error('observer bug');
      },
    });
    await ready(h);
    expect(() => h.player.handleKeyDown(key('a'), 'medium', 'keyboard')).not.toThrow();
    expect(h.ctx.sources).toHaveLength(1);
  });

  it('does not throw for a malformed event', () => {
    const h = setup();
    expect(() => h.player.handleKeyDown({} as KeyEventLike, 'medium', 'keyboard')).not.toThrow();
    expect(() => h.player.handleKeyDown(null as unknown as KeyEventLike, 'medium', 'keyboard')).not.toThrow();
  });

  it('a failing onended cleanup does not throw', async () => {
    const h = setup();
    await ready(h);
    h.player.handleKeyDown(key('a'), 'medium', 'keyboard');
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
    h.player.handleKeyDown(key('a'), 'medium', 'keyboard');
    expect(h.ctx.sources).toEqual([]);
    expect(() => h.player.dispose()).not.toThrow();
    expect(h.ctx.raw.close).toHaveBeenCalledTimes(1);
  });

  it('without a context, dispose only stops later work (no AudioContext is created for closing)', () => {
    const h = setup();
    h.player.dispose();
    h.player.prepare('keyboard');
    h.player.handleKeyDown(key('a'), 'medium', 'keyboard');
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

const sounds2 = (h: Harness, timbre: 'keyboard' | 'typewriter') => sounds(h).filter((e) => e.timbre === timbre);

describe('timbres (keyboard, typewriter)', () => {
  it('has the two timbres, keyboard by default, and normalizes anything else to nothing', () => {
    expect(TIMBRES).toEqual(['keyboard', 'typewriter']);
    expect(DEFAULT_TIMBRE).toBe('keyboard');
    expect(isTimbre('keyboard')).toBe(true);
    expect(isTimbre('typewriter')).toBe(true);
    for (const bad of [undefined, null, 1, '', 'Keyboard', 'piano', true, {}, ['keyboard']]) expect(isTimbre(bad), String(bad)).toBe(false);
  });

  it('prepare(typewriter) fetches only the 8 typewriter files; the keyboard files are not fetched', async () => {
    const h = setup();
    h.player.prepare('typewriter');
    h.player.prepare('typewriter');
    await flush();
    expect(h.fetchBytes.mock.calls.map(([url]) => url)).toEqual(TYPEWRITER_URLS);
    expect(h.events.filter((e) => e.type === 'fetch')).toEqual([{ type: 'fetch', timbre: 'typewriter', urls: 8 }]);
    expect(h.createContext).not.toHaveBeenCalled();
  });

  it('a key for a timbre that was never prepared reads nothing and does not sound', async () => {
    const h = setup();
    await ready(h);
    h.clock.t += 100;
    h.player.handleKeyDown(key('a'), 'medium', 'typewriter');
    await flush();
    expect(h.fetchBytes).toHaveBeenCalledTimes(10);
    expect(sounds2(h, 'typewriter')).toEqual([]);
  });

  it('switching reads only the new timbre (the loaded one is kept), decodes it at once when the AudioContext exists, and sounds from the 8 files', async () => {
    const h = setup();
    await ready(h);
    expect(h.fetchBytes).toHaveBeenCalledTimes(10);
    h.player.prepare('typewriter');
    await flush();
    expect(h.fetchBytes).toHaveBeenCalledTimes(18);
    expect(h.fetchBytes.mock.calls.slice(10).map(([url]) => url)).toEqual(TYPEWRITER_URLS);
    expect(h.events).toContainEqual({ type: 'decoded', timbre: 'typewriter', count: 8, offsets: Array(8).fill(0) });
    expect(h.createContext).toHaveBeenCalledTimes(1);

    const seen = new Set<number>();
    for (let i = 0; i < 60; i++) {
      h.clock.t += 400;
      h.player.handleKeyDown(key('a'), 'medium', 'typewriter');
    }
    for (const s of sounds2(h, 'typewriter')) seen.add(s.index);
    expect(sounds2(h, 'typewriter')).toHaveLength(60);
    expect([...seen].every((i) => i >= 0 && i < 8)).toBe(true);
    expect(seen.size).toBe(8);
  });

  it('the first key right after switching (before the decode ends) does not sound; the next one does', async () => {
    const h = setup();
    await ready(h);
    h.clock.t += 100;
    h.player.prepare('typewriter');
    h.player.handleKeyDown(key('a'), 'medium', 'typewriter');
    expect(sounds2(h, 'typewriter')).toEqual([]);
    await flush();
    h.clock.t += 100;
    h.player.handleKeyDown(key('a'), 'medium', 'typewriter');
    expect(sounds2(h, 'typewriter')).toHaveLength(1);
  });

  it('switching back to the keyboard does not fetch again, and sounds from the keyboard files', async () => {
    const h = setup();
    await ready(h);
    h.player.prepare('typewriter');
    await flush();
    h.player.prepare('keyboard');
    await flush();
    expect(h.fetchBytes).toHaveBeenCalledTimes(18);
    h.clock.t += 100;
    h.player.handleKeyDown(key('a'), 'medium', 'keyboard');
    expect(sounds2(h, 'keyboard')).toHaveLength(1);
    expect(h.events.filter((e) => e.type === 'decoded')).toHaveLength(2);
  });

  it('a failed fetch of one timbre is retried at its next prepare, and does not affect the other timbre', async () => {
    let failTypewriter = true;
    const h = setup({
      fetchBytes: async (url) => {
        if (failTypewriter && url.startsWith('/t/')) throw new Error('offline');
        return new ArrayBuffer(250);
      },
    });
    await ready(h);
    h.player.prepare('typewriter');
    await flush();
    h.clock.t += 100;
    h.player.handleKeyDown(key('a'), 'medium', 'typewriter');
    h.player.handleKeyDown(key('a'), 'medium', 'keyboard');
    expect(sounds2(h, 'typewriter')).toEqual([]);
    failTypewriter = false;
    h.player.prepare('typewriter');
    await flush();
    h.clock.t += 100;
    h.player.handleKeyDown(key('a'), 'medium', 'typewriter');
    expect(sounds2(h, 'typewriter')).toHaveLength(1);
  });

  describe('the playing rules are the same for both timbres', () => {
    const readyBoth = async (timbre: 'keyboard' | 'typewriter', over: Partial<TypingSoundPlayerOptions> = {}) => {
      const h = setup(over);
      h.player.prepare(timbre);
      await flush();
      h.player.handleKeyDown(key('a'), 'medium', timbre);
      await flush();
      h.clock.t += 1000;
      return h;
    };

    for (const timbre of TIMBRES) {
      const count = timbre === 'keyboard' ? 10 : 8;

      it(`${timbre}: one request per key, never the same file twice in a row, all ${count} files reached`, async () => {
        const h = await readyBoth(timbre);
        for (let i = 0; i < 200; i++) {
          h.clock.t += 400;
          h.player.handleKeyDown(key('a'), 'medium', timbre);
        }
        const picked = sounds2(h, timbre).map((s) => s.index);
        expect(picked).toHaveLength(200);
        expect(h.ctx.sources).toHaveLength(200);
        expect(new Set(picked).size).toBe(count);
        for (let i = 1; i < picked.length; i++) expect(picked[i]).not.toBe(picked[i - 1]);
      });

      it(`${timbre}: pitch ±4%, loudness ±10% (volume × timbre gain), Enter at 0.8`, async () => {
        const base = VOLUME_GAIN.medium * TIMBRE_GAIN[timbre];
        const lo = await readyBoth(timbre, { random: () => 0 });
        lo.player.handleKeyDown(key('a'), 'medium', timbre);
        const low = sounds2(lo, timbre)[0]!;
        expect(low.rate).toBeCloseTo(1 - PITCH_JITTER, 10);
        expect(low.gain).toBeCloseTo(base * (1 - GAIN_JITTER), 10);
        const hi = await readyBoth(timbre, { random: () => 1 });
        hi.player.handleKeyDown(key('a'), 'medium', timbre);
        const high = sounds2(hi, timbre)[0]!;
        expect(high.rate).toBeCloseTo(1 + PITCH_JITTER, 10);
        expect(high.gain).toBeCloseTo(base * (1 + GAIN_JITTER), 10);
        const mid = await readyBoth(timbre, { random: () => 0.5 });
        mid.player.handleKeyDown(key('Enter'), 'medium', timbre);
        const enter = sounds2(mid, timbre)[0]!;
        expect(enter.kind).toBe('enter');
        expect(enter.rate).toBeCloseTo(ENTER_RATE, 10);
      });

      it(`${timbre}: 30 ms thinning and at most 8 at once`, async () => {
        const h = await readyBoth(timbre);
        h.player.handleKeyDown(key('a'), 'medium', timbre);
        h.clock.t += MIN_INTERVAL_MS - 1;
        h.player.handleKeyDown(key('a'), 'medium', timbre);
        expect(sounds2(h, timbre)).toHaveLength(1);
        h.clock.t += 1;
        h.player.handleKeyDown(key('a'), 'medium', timbre);
        expect(sounds2(h, timbre)).toHaveLength(2);
        h.clock.t += 5000;
        const before = sounds2(h, timbre).length;
        for (let i = 0; i < MAX_VOICES + 1; i++) {
          h.player.handleKeyDown(key('a'), 'medium', timbre);
          h.clock.t += MIN_INTERVAL_MS;
        }
        expect(sounds2(h, timbre).length - before).toBe(MAX_VOICES);
      });
    }

    it('the same volume step is about as loud for both timbres: the timbre gain is the measured RMS difference (1.3 dB), rounded', () => {
      expect(TIMBRE_GAIN.keyboard).toBe(1);
      expect(20 * Math.log10(TIMBRE_GAIN.typewriter)).toBeGreaterThan(1.0);
      expect(20 * Math.log10(TIMBRE_GAIN.typewriter)).toBeLessThan(1.5);
    });

    it('the loudest case (high, +10%) stays below full scale for both timbres (peaks: keyboard 0.662, typewriter 0.297)', () => {
      expect(0.662 * VOLUME_GAIN.high * TIMBRE_GAIN.keyboard * (1 + GAIN_JITTER)).toBeLessThan(1);
      expect(0.297 * VOLUME_GAIN.high * TIMBRE_GAIN.typewriter * (1 + GAIN_JITTER)).toBeLessThan(1);
    });
  });
});

describe('starting from the onset (skipping the silence at the head of a file)', () => {
  /** 先頭に silenceMs の無音があり、そのあとに打撃（0.8）と、小さな前触れ（0.05）がある素材。 */
  const buffer = (silenceMs: number, sampleRate = 44100, channels = 1): SoundBuffer => {
    const frames = Math.round(sampleRate * 0.25);
    const data = Array.from({ length: channels }, () => new Float32Array(frames));
    const at = Math.round((sampleRate * silenceMs) / 1000);
    for (const ch of data) {
      ch[Math.max(0, at - 5)] = 0.05;
      ch[at] = 0.8;
    }
    return { duration: 0.25, sampleRate, numberOfChannels: channels, getChannelData: (c: number) => data[c]! };
  };

  it('starts every source at (0, offset): the offset is the point where the amplitude first exceeds 10% of the peak, minus 2 ms', async () => {
    const silences = [37, 12, 3, 53, 45, 18, 28, 0, 10, 20];
    const h = setup({ random: () => 0.5 });
    let n = 0;
    h.ctx.raw.decodeAudioData.mockImplementation(async () => buffer(silences[n++ % silences.length]!));
    await ready(h);
    const offsets: number[] = [];
    for (let i = 0; i < 20; i++) {
      h.clock.t += 100;
      h.player.handleKeyDown(key('a'), 'medium', 'keyboard');
    }
    for (const source of h.ctx.sources) {
      expect(source.startArgs).toHaveLength(1);
      const [when, offset] = source.startArgs[0]!;
      expect(when).toBe(0);
      offsets.push(offset!);
    }
    const expected = new Set(silences.map((ms) => Math.max(0, Math.round((44100 * ms) / 1000) / 44100 - 0.002)));
    for (const o of offsets) expect([...expected].some((e) => Math.abs(e - o) < 1e-9), String(o)).toBe(true);
    // 立ち上がりの 2 ms 前から始まる（打撃の出だしは削らない）。
    expect(sounds(h).map((s) => s.offset)).toEqual(offsets);
    for (const s of sounds(h)) expect(s.offset).toBeLessThanOrEqual(0.053);
  });

  it('a file without leading silence starts at 0, and a silent file starts at 0 too', async () => {
    const h = setup({ random: () => 0.5 });
    let n = 0;
    const silent: SoundBuffer = { duration: 0.25, sampleRate: 44100, numberOfChannels: 1, getChannelData: () => new Float32Array(11025) };
    h.ctx.raw.decodeAudioData.mockImplementation(async () => (n++ % 2 === 0 ? buffer(0) : silent));
    await ready(h);
    for (let i = 0; i < 6; i++) {
      h.clock.t += 100;
      h.player.handleKeyDown(key('a'), 'medium', 'keyboard');
    }
    for (const source of h.ctx.sources) expect(source.startArgs[0]).toEqual([0, 0]);
  });

  it('works for 2 channels too (the louder channel decides), and the offset is independent of the playback rate', async () => {
    const h = setup({ random: () => 0 });
    h.ctx.raw.decodeAudioData.mockImplementation(async () => buffer(20, 48000, 2));
    await ready(h);
    h.player.handleKeyDown(key('Enter'), 'medium', 'keyboard');
    const s = sounds(h)[0]!;
    expect(s.rate).toBeLessThan(0.8);
    expect(s.offset).toBeCloseTo(0.02 - 0.002, 9);
    expect(h.ctx.sources[0]!.startArgs[0]).toEqual([0, s.offset]);
  });

  it('a buffer that cannot be read (no channel data, or getChannelData throws) starts from the head and still sounds', async () => {
    const h = setup({ random: () => 0.5 });
    let n = 0;
    h.ctx.raw.decodeAudioData.mockImplementation(async () =>
      n++ % 2 === 0
        ? { duration: 0.25 }
        : {
            duration: 0.25,
            sampleRate: 44100,
            numberOfChannels: 1,
            getChannelData: () => {
              throw new Error('detached');
            },
          },
    );
    await ready(h);
    for (let i = 0; i < 4; i++) {
      h.clock.t += 100;
      h.player.handleKeyDown(key('a'), 'medium', 'keyboard');
    }
    expect(h.ctx.sources).toHaveLength(4);
    for (const source of h.ctx.sources) expect(source.startArgs[0]).toEqual([0, 0]);
  });

  it('the voice limit counts only the part that sounds (duration minus offset)', async () => {
    const h = setup({ random: () => 0.5 });
    h.ctx.raw.decodeAudioData.mockImplementation(async () => buffer(150));
    await ready(h);
    // 0.25 秒の素材のうち 0.148 秒が先頭から飛ばされ、鳴るのは約 0.1 秒（+ 余裕 20 ms）。120 ms を過ぎれば鳴り終わる見積もり。
    for (let i = 0; i < MAX_VOICES; i++) {
      h.player.handleKeyDown(key('a'), 'medium', 'keyboard');
      h.clock.t += MIN_INTERVAL_MS;
    }
    h.clock.t += 100;
    h.player.handleKeyDown(key('a'), 'medium', 'keyboard');
    expect(sounds(h)).toHaveLength(MAX_VOICES + 1);
  });

  it('reports the offset, the time from the key to start (now difference), and the context latencies to the observer', async () => {
    let ticks = 0;
    const h = setup({ now: () => 1000 + ticks * 0.5 });
    Object.assign(h.ctx.raw, { baseLatency: 0.01, outputLatency: 0.02 });
    h.ctx.raw.decodeAudioData.mockImplementation(async () => buffer(30));
    h.player.prepare('keyboard');
    await flush();
    h.player.handleKeyDown(key('a'), 'medium', 'keyboard');
    await flush();
    ticks = 100;
    h.player.handleKeyDown(key('b'), 'medium', 'keyboard');
    const [s] = sounds(h);
    expect(s).toMatchObject({ timbre: 'keyboard', offset: expect.any(Number), baseLatency: 0.01, outputLatency: 0.02 });
    expect(s!.offset).toBeGreaterThan(0.027);
    expect(s!.offset).toBeLessThan(0.029);
    expect(s!.startDelayMs).toBe(0);

    // now が呼ぶたびに進む時計: キーを受け取った時刻（1 回目）と、start の直前（2 回目）の差。
    let calls = 0;
    const h2 = setup({ now: () => 5000 + 100 * calls++ * 1000 });
    h2.ctx.raw.decodeAudioData.mockImplementation(async () => buffer(30));
    h2.player.prepare('keyboard');
    await flush();
    h2.player.handleKeyDown(key('a'), 'medium', 'keyboard');
    await flush();
    h2.player.handleKeyDown(key('b'), 'medium', 'keyboard');
    expect(sounds(h2)[0]!.startDelayMs).toBe(100 * 1000);
    // 遅延が分からない環境（latency が無い）は null。
    const h3 = setup();
    await ready(h3);
    h3.player.handleKeyDown(key('a'), 'medium', 'keyboard');
    expect(sounds(h3)[0]).toMatchObject({ baseLatency: null, outputLatency: null });
  });
});

describe('the path from keydown to source.start is synchronous', () => {
  const bodyOf = (source: string, from: string, to: string) => {
    const start = source.indexOf(from);
    const end = source.indexOf(to, start);
    expect(start, from).toBeGreaterThan(-1);
    expect(end, to).toBeGreaterThan(start);
    return source.slice(start, end);
  };
  const FORBIDDEN = /\bawait\b|\basync\b|setTimeout|setInterval|requestAnimationFrame|requestIdleCallback|queueMicrotask|\.then\(/;

  it('handleKeyDown (player.ts) has no await, timer, requestAnimationFrame or promise chain before start', () => {
    const body = bodyOf(playerSource, 'function handleKeyDown(', 'function dispose(');
    expect(body).toContain('source.start(0, sound.offset)');
    // resume は待たない（void で投げ、catch で握りつぶすだけ）。ほかに非同期は入らない。
    expect(body.replace(/void ctx\.resume\(\)\.catch\(\(\) => \{\}\);/, '')).not.toMatch(FORBIDDEN);
  });

  it('the keydown listener (extension.ts) hands the event straight to the player', () => {
    const source = extensionSource;
    const body = bodyOf(source, 'const onKeyDown', "view.dom.addEventListener('keydown'");
    expect(body).not.toMatch(FORBIDDEN);
    expect(source).toContain("addEventListener('keydown', onKeyDown, true)");
  });

  it('start is called before handleKeyDown returns (no flush needed)', async () => {
    const h = setup();
    await ready(h);
    h.player.handleKeyDown(key('a'), 'medium', 'keyboard');
    expect(h.ctx.sources[0]?.started).toBe(1);
  });
});

describe('the AudioContext is made with latencyHint "interactive"', () => {
  it('passes { latencyHint: "interactive" } to the constructor', () => {
    const calls: unknown[][] = [];
    class Fake {
      constructor(...args: unknown[]) {
        calls.push(args);
      }
    }
    const ctx = createAudioContext(Fake as never);
    expect(ctx).toBeInstanceOf(Fake);
    expect(calls).toEqual([[{ latencyHint: 'interactive' }]]);
  });

  it('falls back to the plain constructor when the option makes it throw', () => {
    const calls: unknown[][] = [];
    class Picky {
      constructor(...args: unknown[]) {
        calls.push(args);
        if (args.length > 0) throw new TypeError('unsupported options');
      }
    }
    const ctx = createAudioContext(Picky as never);
    expect(ctx).toBeInstanceOf(Picky);
    expect(calls).toEqual([[{ latencyHint: 'interactive' }], []]);
  });

  it('throws if even the plain constructor fails (the player catches it at the key)', () => {
    class Broken {
      constructor() {
        throw new Error('no audio');
      }
    }
    expect(() => createAudioContext(Broken as never)).toThrow('no audio');
  });
});
