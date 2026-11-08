import { soundKindOf, type KeyEventLike, type SoundKind } from './keys';

/** 音量の段階。設定ファイルには、この文字列で保存する。 */
export const VOLUME_LEVELS = ['low', 'medium', 'high'] as const;
export type TypingSoundVolume = (typeof VOLUME_LEVELS)[number];
export const DEFAULT_VOLUME: TypingSoundVolume = 'medium';

/**
 * 段階ごとの gain（素材に掛ける倍率）。素材のピークは -11 dBFS から -4 dBFS（0.27 から 0.66）で、
 * 小・中・大は 6 dB ずつ離す（振幅が 2 倍ずつ）。大でも、最大のピーク 0.66 に音量の揺れ（+10%）を足して 0.73 で、割れない。
 */
export const VOLUME_GAIN: Readonly<Record<TypingSoundVolume, number>> = { low: 0.25, medium: 0.5, high: 1 };

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

// ---- Web Audio のうち、使う部分だけの形（テストで差し替えるため）。実物の AudioContext は、既定の作り方（defaultCreateContext）で渡す。 ----

export interface SoundBuffer {
  readonly duration: number;
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
  start(when?: number): void;
}
export interface SoundGain extends SoundNode {
  readonly gain: SoundParam;
}
export interface SoundContext {
  readonly state: string;
  readonly destination: unknown;
  resume(): Promise<void>;
  close(): Promise<void>;
  decodeAudioData(data: ArrayBuffer): Promise<SoundBuffer>;
  createBufferSource(): SoundSource;
  createGain(): SoundGain;
}

/** 観測用の出来事（e2e のビルドだけが記録する。本番では受け手がない）。 */
export type TypingSoundEvent =
  | { readonly type: 'fetch'; readonly urls: number }
  | { readonly type: 'context' }
  | { readonly type: 'decoded'; readonly count: number }
  | { readonly type: 'sound'; readonly kind: SoundKind; readonly index: number; readonly rate: number; readonly gain: number };

export interface TypingSoundPlayerOptions {
  /** 素材の URL（本体と同じオリジン）。 */
  readonly urls: readonly string[];
  /** AudioContext の作り方。キー入力の中で、最初に必要になったときに 1 回だけ呼ぶ。 */
  readonly createContext?: () => SoundContext;
  readonly fetchBytes?: (url: string) => Promise<ArrayBuffer>;
  /** 0 以上 1 未満の乱数。テストで決めた値を渡せる。 */
  readonly random?: () => number;
  /** 今の時刻（ミリ秒）。間引きと同時の上限に使う。 */
  readonly now?: () => number;
  readonly observe?: (event: TypingSoundEvent) => void;
}

export interface TypingSoundPlayer {
  /** 設定がオンになった。素材のバイト列の読み込みを始める（AudioContext は作らない）。何度呼んでもよい。 */
  prepare(): void;
  /** 本文の keydown。鳴らすキーなら 1 回だけ鳴らす。例外は外へ出さない（鳴らないだけ）。 */
  handleKeyDown(event: KeyEventLike, volume: TypingSoundVolume): void;
  /** 部品を外す。AudioContext を閉じ、以降は鳴らさない。 */
  dispose(): void;
}

const defaultCreateContext = (): SoundContext => {
  const Ctor = globalThis.AudioContext ?? (globalThis as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) throw new Error('AudioContext がありません');
  return new Ctor() as unknown as SoundContext;
};

async function defaultFetchBytes(url: string): Promise<ArrayBuffer> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`素材を読めません（${res.status}）`);
  return res.arrayBuffer();
}

/**
 * タイピング音の再生。素材の読み込みと AudioContext の生成は、使うときまで遅らせる。
 * - prepare（設定がオン）: 素材のバイト列を fetch する。オフの間は呼ばれないので、fetch も AudioContext もない。
 * - 最初の鳴らすキー: キー入力（利用者の操作）の中で AudioContext を作り、素材をデコードする。ブラウザと WKWebView の自動再生の
 *   制限に合わせるため。デコードが終わる前のキーは鳴らない。
 * - AudioContext が running でない（窓が裏に回った、スリープから戻った）ときは、そのキーで resume を呼び、そのキーは鳴らさない
 *   （resume までに溜めた音を、まとめて鳴らさないため）。
 */
export function createTypingSoundPlayer(options: TypingSoundPlayerOptions): TypingSoundPlayer {
  const { urls, observe } = options;
  const createContext = options.createContext ?? defaultCreateContext;
  const fetchBytes = options.fetchBytes ?? defaultFetchBytes;
  const random = options.random ?? Math.random;
  const now = options.now ?? (() => performance.now());

  let disposed = false;
  let context: SoundContext | null = null;
  let bytes: ArrayBuffer[] | null = null;
  let loading = false;
  let decoding = false;
  let buffers: SoundBuffer[] | null = null;
  let lastIndex = -1;
  let lastAt = Number.NEGATIVE_INFINITY;
  /** 鳴っている音の、鳴り終わる見積もりの時刻（ミリ秒）。 */
  let ends: number[] = [];

  const emit = (event: TypingSoundEvent) => {
    try {
      observe?.(event);
    } catch {
      // 観測は、鳴らす処理を妨げない。
    }
  };

  function startDecode(ctx: SoundContext): void {
    if (decoding || buffers || !bytes) return;
    decoding = true;
    const sources = bytes;
    void Promise.allSettled(sources.map((b) => ctx.decodeAudioData(b.slice(0)))).then((results) => {
      const decoded = results.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []));
      // 1 つも読めなければ、鳴らさない（次のキーで、同じ失敗を繰り返さない）。
      buffers = decoded;
      if (!disposed) emit({ type: 'decoded', count: decoded.length });
    });
  }

  function prepare(): void {
    if (disposed || loading || bytes) return;
    loading = true;
    emit({ type: 'fetch', urls: urls.length });
    void Promise.all(urls.map((u) => fetchBytes(u))).then(
      (loaded) => {
        loading = false;
        bytes = loaded;
        // キーが先に来て AudioContext がもうあるなら、ここからデコードを始める。
        if (context && !disposed) startDecode(context);
      },
      () => {
        // 読めなかった。次に設定がオンになったとき（prepare）、もう一度試す。
        loading = false;
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

  function pickIndex(count: number): number {
    if (count <= 1) return 0;
    // 最初は全部から、2 回目からは、直前と同じものを除いた (count - 1) 個から選ぶ。
    if (lastIndex < 0 || lastIndex >= count) return Math.min(count - 1, Math.floor(random() * count));
    const index = Math.min(count - 2, Math.floor(random() * (count - 1)));
    return index >= lastIndex ? index + 1 : index;
  }

  function handleKeyDown(event: KeyEventLike, volume: TypingSoundVolume): void {
    try {
      if (disposed) return;
      const kind = soundKindOf(event);
      if (!kind) return;
      const t = now();
      if (t - lastAt < MIN_INTERVAL_MS) return;
      const ctx = ensureContext();
      if (!ctx) return;
      startDecode(ctx);
      if (ctx.state !== 'running') {
        // 自動再生の制限、窓が裏に回った、スリープなど。利用者の操作（このキー）の中で resume する。
        void ctx.resume().catch(() => {});
        return;
      }
      if (!buffers || buffers.length === 0) return;
      ends = ends.filter((end) => end > t);
      if (ends.length >= MAX_VOICES) return;

      const index = pickIndex(buffers.length);
      const buffer = buffers[index];
      if (!buffer) return;
      const rate = (kind === 'enter' ? ENTER_RATE : 1) * (1 + (random() * 2 - 1) * PITCH_JITTER);
      const gain = VOLUME_GAIN[volume] * (1 + (random() * 2 - 1) * GAIN_JITTER);

      const source = ctx.createBufferSource();
      const gainNode = ctx.createGain();
      source.buffer = buffer;
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
      source.start();

      lastIndex = index;
      lastAt = t;
      ends.push(t + (buffer.duration / rate) * 1000 + VOICE_MARGIN_MS);
      emit({ type: 'sound', kind, index, rate, gain });
    } catch {
      // 音が鳴らないだけにする。入力は妨げない。
    }
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    const ctx = context;
    context = null;
    buffers = null;
    bytes = null;
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
