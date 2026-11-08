import { soundKindOf, type KeyEventLike, type SoundKind } from './keys';
import { onsetOffsetSeconds } from './onset';

/** 音量の段階。設定ファイルには、この文字列で保存する。 */
export const VOLUME_LEVELS = ['low', 'medium', 'high'] as const;
export type TypingSoundVolume = (typeof VOLUME_LEVELS)[number];
export const DEFAULT_VOLUME: TypingSoundVolume = 'medium';

/**
 * 段階ごとの gain（素材に掛ける倍率）。キーボードの素材のピークは -11 dBFS から -4 dBFS（0.27 から 0.66）で、
 * 小・中・大は 6 dB ずつ離す（振幅が 2 倍ずつ）。大でも、最大のピーク 0.66 に音量の揺れ（+10%）を足して 0.73 で、割れない。
 */
export const VOLUME_GAIN: Readonly<Record<TypingSoundVolume, number>> = { low: 0.25, medium: 0.5, high: 1 };

/** 音色。設定ファイルには、この文字列で保存する。keyboard は R9 の音（既定）、typewriter は CC0 のタイプライターの録音を柔らかく加工したもの。 */
export const TIMBRES = ['keyboard', 'typewriter'] as const;
export type TypingSoundTimbre = (typeof TIMBRES)[number];
export const DEFAULT_TIMBRE: TypingSoundTimbre = 'keyboard';

/**
 * 音色ごとの gain（音量の段階に掛ける）。同じ音量の段階で、2 つの音色がほぼ同じ大きさに聞こえるようにそろえる。
 * 素材の鳴り始め以降の RMS（パワー平均）は、キーボード -31.4 dBFS、タイプライター -32.7 dBFS で、差は 1.3 dB（約 1.16 倍）。
 * それを丸めて 1.15 倍（+1.2 dB）にする。タイプライターのピークは最大 0.30 で、大でも 0.30 × 1.15 × 1.1 で 0.38 と、割れない。
 */
export const TIMBRE_GAIN: Readonly<Record<TypingSoundTimbre, number>> = { keyboard: 1, typewriter: 1.15 };

/** Enter の再生速度（1 が元の高さ）。少し低くする。 */
export const ENTER_RATE = 0.8;
/** 高さ（再生速度）の揺れの幅（±4%）。 */
export const PITCH_JITTER = 0.04;
/** 音量の揺れの幅（±10%）。 */
export const GAIN_JITTER = 0.1;
/** 音を鳴らす間隔の下限（ミリ秒）。キーの繰り返しなどで、これより詰まる分は間引く。 */
export const MIN_INTERVAL_MS = 30;
/** 同時に鳴る音の上限。 */
export const MAX_VOICES = 8;
/** 鳴り終わりの見積もりに足す余裕（ミリ秒）。 */
const VOICE_MARGIN_MS = 20;

export const isVolume = (raw: unknown): raw is TypingSoundVolume => typeof raw === 'string' && (VOLUME_LEVELS as readonly string[]).includes(raw);
export const isTimbre = (raw: unknown): raw is TypingSoundTimbre => typeof raw === 'string' && (TIMBRES as readonly string[]).includes(raw);

// ---- Web Audio のうち、使う部分だけの形（テストで差し替えるため）。実物の AudioContext は、既定の作り方（createAudioContext）で渡す。 ----

export interface SoundBuffer {
  readonly duration: number;
  /** 鳴り始めの位置を求めるために読む。無い（テスト用の簡単な素材）ときは、頭から鳴らす。 */
  readonly sampleRate?: number;
  readonly numberOfChannels?: number;
  getChannelData?(channel: number): ArrayLike<number>;
}
interface SoundParam {
  value: number;
}
interface SoundNode {
  connect(destination: unknown): unknown;
  disconnect(): void;
}
export interface SoundSource extends SoundNode {
  buffer: SoundBuffer | null;
  readonly playbackRate: SoundParam;
  onended: (() => void) | null;
  /** when は 0（すぐ）。offset は素材の中の位置（秒。再生速度に左右されない）。 */
  start(when?: number, offset?: number): void;
}
export interface SoundGain extends SoundNode {
  readonly gain: SoundParam;
}
export interface SoundContext {
  readonly state: string;
  readonly destination: unknown;
  /** 観測用（e2e のビルドが記録する）。無い環境もある。 */
  readonly baseLatency?: number;
  readonly outputLatency?: number;
  resume(): Promise<void>;
  close(): Promise<void>;
  decodeAudioData(data: ArrayBuffer): Promise<SoundBuffer>;
  createBufferSource(): SoundSource;
  createGain(): SoundGain;
}

/** 観測用の出来事（e2e のビルドだけが記録する。本番では受け手がない）。 */
export type TypingSoundEvent =
  | { readonly type: 'fetch'; readonly timbre: TypingSoundTimbre; readonly urls: number }
  | { readonly type: 'context' }
  | { readonly type: 'decoded'; readonly timbre: TypingSoundTimbre; readonly count: number; readonly offsets: readonly number[] }
  | {
      readonly type: 'sound';
      readonly kind: SoundKind;
      readonly timbre: TypingSoundTimbre;
      readonly index: number;
      readonly rate: number;
      readonly gain: number;
      /** source.start に渡した、素材の中の位置（秒）。 */
      readonly offset: number;
      /** keydown を受け取ってから source.start を呼ぶ直前までの時間（ミリ秒、now の差）。 */
      readonly startDelayMs: number;
      readonly baseLatency: number | null;
      readonly outputLatency: number | null;
    };

export interface TypingSoundPlayerOptions {
  /** 音色ごとの素材の URL（本体と同じオリジン）。 */
  readonly urls: Readonly<Record<TypingSoundTimbre, readonly string[]>>;
  /** AudioContext の作り方。キー入力の中で、最初に必要になったときに 1 回だけ呼ぶ。 */
  readonly createContext?: () => SoundContext;
  readonly fetchBytes?: (url: string) => Promise<ArrayBuffer>;
  /** 0 以上 1 未満の乱数。テストで決めた値を渡せる。 */
  readonly random?: () => number;
  /** 今の時刻（ミリ秒）。間引きと同時の上限、keydown から start までの時間に使う。 */
  readonly now?: () => number;
  readonly observe?: (event: TypingSoundEvent) => void;
}

export interface TypingSoundPlayer {
  /** 設定がオン、または音色が変わった。その音色の素材のバイト列の読み込みを始める（AudioContext は作らない）。読んだものは保持するので、何度呼んでもよい。 */
  prepare(timbre: TypingSoundTimbre): void;
  /** 本文の keydown。鳴らすキーなら 1 回だけ鳴らす。例外は外へ出さない（鳴らないだけ）。 */
  handleKeyDown(event: KeyEventLike, volume: TypingSoundVolume, timbre: TypingSoundTimbre): void;
  /** 部品を外す。AudioContext を閉じ、以降は鳴らさない。 */
  dispose(): void;
}

/** AudioContext の作り方。遅延の少ない指定（latencyHint: 'interactive'）で作り、作れない環境では指定なしの作り方に戻す。 */
export function createAudioContext(Ctor: new (options?: { latencyHint?: string }) => unknown): SoundContext {
  try {
    return new Ctor({ latencyHint: 'interactive' }) as SoundContext;
  } catch {
    return new Ctor() as SoundContext;
  }
}

const defaultCreateContext = (): SoundContext => {
  const Ctor = globalThis.AudioContext ?? (globalThis as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) throw new Error('AudioContext がありません');
  return createAudioContext(Ctor as unknown as new (options?: { latencyHint?: string }) => unknown);
};

async function defaultFetchBytes(url: string): Promise<ArrayBuffer> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`素材を読めません（${res.status}）`);
  return res.arrayBuffer();
}

/** デコードした素材の、鳴り始めの位置（秒）。読めなければ 0（頭から鳴らす）。 */
function offsetOfBuffer(buffer: SoundBuffer): number {
  try {
    const { numberOfChannels, sampleRate, getChannelData } = buffer;
    if (typeof getChannelData !== 'function' || typeof numberOfChannels !== 'number' || typeof sampleRate !== 'number') return 0;
    const channels = Array.from({ length: numberOfChannels }, (_, c) => getChannelData.call(buffer, c));
    return Math.min(onsetOffsetSeconds(channels, sampleRate), Math.max(0, buffer.duration));
  } catch {
    return 0;
  }
}

/** デコードした素材 1 つと、その鳴り始めの位置。 */
interface Sound {
  readonly buffer: SoundBuffer;
  readonly offset: number;
}

/** 音色ごとの状態（読み込み、デコード、直前に選んだもの）。 */
interface TimbreState {
  bytes: ArrayBuffer[] | null;
  loading: boolean;
  decoding: boolean;
  sounds: Sound[] | null;
  lastIndex: number;
}

/**
 * タイピング音の再生。素材の読み込みと AudioContext の生成は、使うときまで遅らせる。
 * - prepare（設定がオン、音色の変更）: その音色の素材のバイト列だけを fetch する。オフの間は呼ばれないので、fetch も AudioContext もない。
 *   読んだ音色は保持する（切り替えて戻っても、読み直さない）。
 * - 最初の鳴らすキー: キー入力（利用者の操作）の中で AudioContext を作り、素材をデコードする。ブラウザと WKWebView の自動再生の
 *   制限に合わせるため。デコードが終わる前のキーは鳴らない（音色を切り替えた直後も、その音色のデコードが終わるまでは鳴らない）。
 * - AudioContext が running でない（窓が裏に回った、スリープから戻った）ときは、そのキーで resume を呼び、そのキーは鳴らさない
 *   （resume までに溜めた音を、まとめて鳴らさないため）。
 * - 鳴らし方は、keydown から source.start までを同期で行う（await、タイマー、requestAnimationFrame を挟まない）。素材の頭の無音は、
 *   デコードのあとで求めた鳴り始めの位置（onset.ts）から鳴らして飛ばす。
 */
export function createTypingSoundPlayer(options: TypingSoundPlayerOptions): TypingSoundPlayer {
  const { urls, observe } = options;
  const createContext = options.createContext ?? defaultCreateContext;
  const fetchBytes = options.fetchBytes ?? defaultFetchBytes;
  const random = options.random ?? Math.random;
  const now = options.now ?? (() => performance.now());

  let disposed = false;
  let context: SoundContext | null = null;
  const states = new Map<TypingSoundTimbre, TimbreState>();
  let lastAt = Number.NEGATIVE_INFINITY;
  /** 鳴っている音の、鳴り終わる見積もりの時刻（ミリ秒）。 */
  let ends: number[] = [];

  const stateOf = (timbre: TypingSoundTimbre): TimbreState => {
    let state = states.get(timbre);
    if (!state) {
      state = { bytes: null, loading: false, decoding: false, sounds: null, lastIndex: -1 };
      states.set(timbre, state);
    }
    return state;
  };

  const emit = (event: TypingSoundEvent) => {
    try {
      observe?.(event);
    } catch {
      // 観測は、鳴らす処理を妨げない。
    }
  };

  function startDecode(ctx: SoundContext, timbre: TypingSoundTimbre, state: TimbreState): void {
    if (state.decoding || state.sounds || !state.bytes) return;
    state.decoding = true;
    const sources = state.bytes;
    void Promise.allSettled(sources.map((b) => ctx.decodeAudioData(b.slice(0)))).then((results) => {
      const decoded = results.flatMap((r) => (r.status === 'fulfilled' ? [{ buffer: r.value, offset: offsetOfBuffer(r.value) }] : []));
      // 1 つも読めなければ、鳴らさない（次のキーで、同じ失敗を繰り返さない）。
      state.sounds = decoded;
      if (!disposed) emit({ type: 'decoded', timbre, count: decoded.length, offsets: decoded.map((d) => d.offset) });
    });
  }

  function prepare(timbre: TypingSoundTimbre): void {
    if (disposed) return;
    const list = urls[timbre];
    if (!list || list.length === 0) return;
    const state = stateOf(timbre);
    if (state.loading || state.bytes) return;
    state.loading = true;
    emit({ type: 'fetch', timbre, urls: list.length });
    void Promise.all(list.map((u) => fetchBytes(u))).then(
      (loaded) => {
        state.loading = false;
        state.bytes = loaded;
        // キーが先に来て AudioContext がもうあるなら、ここからデコードを始める。
        if (context && !disposed) startDecode(context, timbre, state);
      },
      () => {
        // 読めなかった。次に設定がオンになったとき、または音色が選ばれたとき（prepare）、もう一度試す。
        state.loading = false;
      },
    );
  }

  function ensureContext(): SoundContext | null {
    if (context?.state === 'closed') context = null;
    if (!context) {
      context = createContext();
      emit({ type: 'context' });
    }
    return context;
  }

  function pickIndex(count: number, lastIndex: number): number {
    if (count <= 1) return 0;
    // 最初は全部から、2 回目からは、直前と同じものを除いた (count - 1) 個から選ぶ。
    if (lastIndex < 0 || lastIndex >= count) return Math.min(count - 1, Math.floor(random() * count));
    const index = Math.min(count - 2, Math.floor(random() * (count - 1)));
    return index >= lastIndex ? index + 1 : index;
  }

  function handleKeyDown(event: KeyEventLike, volume: TypingSoundVolume, timbre: TypingSoundTimbre): void {
    try {
      if (disposed) return;
      const kind = soundKindOf(event);
      if (!kind) return;
      const t = now();
      if (t - lastAt < MIN_INTERVAL_MS) return;
      const ctx = ensureContext();
      if (!ctx) return;
      const state = stateOf(timbre);
      startDecode(ctx, timbre, state);
      if (ctx.state !== 'running') {
        // 自動再生の制限、窓が裏に回った、スリープなど。利用者の操作（このキー）の中で resume する。
        void ctx.resume().catch(() => {});
        return;
      }
      const sounds = state.sounds;
      if (!sounds || sounds.length === 0) return;
      ends = ends.filter((end) => end > t);
      if (ends.length >= MAX_VOICES) return;

      const index = pickIndex(sounds.length, state.lastIndex);
      const sound = sounds[index];
      if (!sound) return;
      const rate = (kind === 'enter' ? ENTER_RATE : 1) * (1 + (random() * 2 - 1) * PITCH_JITTER);
      const gain = VOLUME_GAIN[volume] * (TIMBRE_GAIN[timbre] ?? 1) * (1 + (random() * 2 - 1) * GAIN_JITTER);

      const source = ctx.createBufferSource();
      const gainNode = ctx.createGain();
      source.buffer = sound.buffer;
      source.playbackRate.value = rate;
      gainNode.gain.value = gain;
      source.connect(gainNode);
      gainNode.connect(ctx.destination);
      source.onended = () => {
        try {
          source.disconnect();
          gainNode.disconnect();
        } catch {
          // 片付けの失敗は無視する。
        }
      };
      const startDelayMs = observe ? now() - t : 0;
      source.start(0, sound.offset);

      state.lastIndex = index;
      lastAt = t;
      ends.push(t + (Math.max(0, sound.buffer.duration - sound.offset) / rate) * 1000 + VOICE_MARGIN_MS);
      if (observe) {
        emit({
          type: 'sound',
          kind,
          timbre,
          index,
          rate,
          gain,
          offset: sound.offset,
          startDelayMs,
          baseLatency: typeof ctx.baseLatency === 'number' ? ctx.baseLatency : null,
          outputLatency: typeof ctx.outputLatency === 'number' ? ctx.outputLatency : null,
        });
      }
    } catch {
      // 音が鳴らないだけにする。入力は妨げない。
    }
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    const ctx = context;
    context = null;
    states.clear();
    ends = [];
    if (ctx) {
      try {
        void ctx.close().catch(() => {});
      } catch {
        // 閉じられなくても、以降は鳴らさない。
      }
    }
  }

  return { prepare, handleKeyDown, dispose };
}
