import type { PluginPerf } from '../../plugin-api';
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
  /** アプリのログ用（ADR-007）。無い環境（テスト用の簡単な実装）もある。 */
  readonly sampleRate?: number;
  readonly currentTime?: number;
  /** 出力の遅れの見積もり用（R16）。いま出力されている位置（contextTime）と、そのときの performance.now（performanceTime）。無い環境（WKWebView の版による）もある。 */
  getOutputTimestamp?(): { readonly contextTime?: number; readonly performanceTime?: number };
  addEventListener?(type: 'statechange', listener: () => void): void;
  removeEventListener?(type: 'statechange', listener: () => void): void;
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

/** アプリのログ（ADR-007）への記録口。source は部品の id に固定済み（index.ts が ctx.log を渡す）。無効の間は何もしない。 */
export type TypingSoundLog = (level: 'info' | 'warn' | 'error', event: string, data?: Record<string, string | number | boolean | null>) => void;

/** デバイスの増減の通知元（navigator.mediaDevices）。 */
export interface DeviceEventSource {
  addEventListener(type: 'devicechange', listener: () => void): void;
  removeEventListener(type: 'devicechange', listener: () => void): void;
}

/** 時計の止まりを疑うときの、前に見たときからの最短の経過（ミリ秒）と、currentTime の進みが「止まり」になる、経過に対する割合。 */
export const STALL_MIN_WALL_MS = 500;
export const STALL_ADVANCE_RATIO = 1 / 4;
/** 出力の遅れの見積もり（R16）: 読み取る間隔の下限、記録する間隔、警告にする見積もり（ms）。 */
export const LATENCY_SAMPLE_MS = 1000;
export const LATENCY_LOG_INTERVAL_MS = 60_000;
export const LATENCY_WARN_MS = 150;
/** suspended などで resume を頼み続けるとき、同じ記録を繰り返さない間隔（ミリ秒）。 */
const RESUME_LOG_INTERVAL_MS = 5000;

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
  /** アプリのログ（ADR-007）。observe とは別の受け口。状態が変わったとき、失敗、時計の止まりの疑いのときだけ呼ぶ（鳴らすキーごとには呼ばない）。 */
  readonly log?: TypingSoundLog;
  /** 性能の計測（R16。index.ts が ctx.perf を渡す）。省略、またはログが無効の間は、何も数えない。 */
  readonly perf?: PluginPerf;
  /** デバイスの増減の通知元。省略は navigator.mediaDevices（ない環境、イベントが使えない環境では、記録しない）。null なら使わない。 */
  readonly mediaDevices?: DeviceEventSource | null;
}

export interface TypingSoundPlayer {
  /** 設定がオン、または音色が変わった。その音色の素材のバイト列の読み込みを始める（AudioContext は作らない）。読んだものは保持するので、何度呼んでもよい。 */
  prepare(timbre: TypingSoundTimbre): void;
  /** 本文の keydown。鳴らすキーなら 1 回だけ鳴らす。例外は外へ出さない（鳴らないだけ）。 */
  handleKeyDown(event: KeyEventLike, volume: TypingSoundVolume, timbre: TypingSoundTimbre): void;
  /**
   * 設定がオフになった。AudioContext を閉じ、デコードした素材を捨てる（素材のバイト列は残す。取り直さない）。
   * 次に鳴らすキーで、AudioContext を作り直し、素材をデコードし直す。AudioContext がなければ何もしない。
   */
  release(reason: 'setting-off'): void;
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

/** 素材の取得が、HTTP の失敗の状態で終わった。ログに状態を残すため、status を持つ（メッセージは従来のまま）。 */
export class SoundHttpError extends Error {
  constructor(readonly status: number) {
    super(`素材を読めません（${status}）`);
    this.name = 'SoundHttpError';
  }
}

async function defaultFetchBytes(url: string): Promise<ArrayBuffer> {
  const res = await fetch(url);
  if (!res.ok) throw new SoundHttpError(res.status);
  return res.arrayBuffer();
}

const errorName = (e: unknown): string => (e instanceof Error ? e.name : typeof e === 'object' && e !== null ? 'object' : typeof e);
const finiteOrNull = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);
/** 秒の値を ms にして、小数 1 桁に丸める（有限でなければ null）。 */
const finiteMs = (seconds: unknown): number | null => (typeof seconds === 'number' && Number.isFinite(seconds) ? Math.round(seconds * 10000) / 10 : null);

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
  const logOption = options.log;
  const createContext = options.createContext ?? defaultCreateContext;
  const fetchBytes = options.fetchBytes ?? defaultFetchBytes;
  const random = options.random ?? Math.random;
  const now = options.now ?? (() => performance.now());
  const perfOption = options.perf;

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

  const log: TypingSoundLog = (level, event, data) => {
    try {
      logOption?.(level, event, data);
    } catch {
      // ログは、鳴らす処理を妨げない。
    }
  };

  // ---- アプリのログ（ADR-007）のための状態。鳴らし方には使わない。 ----
  /** 最後に見た AudioContext の state（statechange の前の状態として記録する）。 */
  let lastState = '';
  /** 時計を比べる基準（前に見たときの、時刻と currentTime）。state が running でなくなったら取り直す。 */
  let clockBase: { at: number; time: number } | null = null;
  /** 時計の止まりを記録した後、進むようになるまで true（続く間は 1 回だけ記録する）。 */
  let stalled = false;
  /** resume を頼んだ記録を、同じ状態の間は繰り返さないための印と、最後に記録した時刻、記録しなかった頼みの数。 */
  let resumeLogged = false;
  let resumeLoggedAt = Number.NEGATIVE_INFINITY;
  let resumeSkipped = 0;
  let detachLogging: (() => void) | null = null;
  /** 次に AudioContext を作る理由（context.created に添える）。 */
  let createReason: 'first-key' | 'after-setting-off' | 'after-closed' = 'first-key';
  /** 出力の遅れの見積もり（R16）: 最後に読んだ時刻、最後に info を書いた時刻、最後に warn を書いた時刻。 */
  let lastLatencySampleAt = Number.NEGATIVE_INFINITY;
  let lastLatencyLogAt = Number.NEGATIVE_INFINITY;
  let lastLatencyWarnAt = Number.NEGATIVE_INFINITY;

  /** 作った AudioContext の記録（作ったこと、statechange、devicechange）。記録の失敗は、鳴らす処理に出さない。 */
  function watchContext(ctx: SoundContext, reason: string): void {
    try {
      lastState = ctx.state;
      clockBase = null;
      stalled = false;
      resumeLogged = false;
      log('info', 'context.created', {
        sample_rate: finiteOrNull(ctx.sampleRate),
        base_latency: finiteOrNull(ctx.baseLatency),
        output_latency: finiteOrNull(ctx.outputLatency),
        state: ctx.state,
        reason,
      });
      const onStateChange = () => {
        const to = ctx.state;
        log('info', 'context.statechange', { from: lastState, to, current_time: finiteOrNull(ctx.currentTime) });
        lastState = to;
        // どの状態の変化でも、時計の比べ直しの基準は取り直す（suspended からの resume のあとを含む）。
        clockBase = null;
        if (to === 'running') resumeLogged = false;
      };
      const cleanups: Array<() => void> = [];
      if (typeof ctx.addEventListener === 'function') {
        ctx.addEventListener('statechange', onStateChange);
        cleanups.push(() => ctx.removeEventListener?.('statechange', onStateChange));
      }
      const devices = options.mediaDevices !== undefined ? options.mediaDevices : ((globalThis.navigator as Navigator | undefined)?.mediaDevices ?? null);
      if (devices && typeof devices.addEventListener === 'function') {
        const onDeviceChange = () => log('info', 'devicechange', { state: ctx.state, output_latency: finiteOrNull(ctx.outputLatency) });
        devices.addEventListener('devicechange', onDeviceChange);
        cleanups.push(() => devices.removeEventListener?.('devicechange', onDeviceChange));
      }
      detachLogging = () => {
        for (const cleanup of cleanups) {
          try {
            cleanup();
          } catch {
            // 外せなくても、以降の処理には影響しない。
          }
        }
      };
    } catch {
      // 記録の準備に失敗しても、鳴らす処理は続ける。
    }
  }

  function unwatchContext(): void {
    const detach = detachLogging;
    detachLogging = null;
    detach?.();
  }

  /**
   * state が running のときの、時計の止まりの検査。currentTime の読み取りと比較だけをここで行い（await は挟まない）、
   * 書くべきログがあれば、あとで呼ぶ関数として返す。呼び出し側は、source.start のあとに呼ぶ（R16 の N2: 鳴らす経路にログの書き込みを入れない）。
   */
  function checkClock(ctx: SoundContext, t: number): (() => void) | null {
    const time = ctx.currentTime;
    if (typeof time !== 'number' || !Number.isFinite(time)) return null;
    if (clockBase === null) {
      clockBase = { at: t, time };
      return null;
    }
    const wall = t - clockBase.at;
    if (wall < STALL_MIN_WALL_MS) return null;
    const advance = (time - clockBase.time) * 1000;
    clockBase = { at: t, time };
    if (advance < wall * STALL_ADVANCE_RATIO) {
      if (!stalled) {
        stalled = true;
        const data = { elapsed_ms: Math.round(wall), advance_ms: Math.round(advance), state: ctx.state };
        return () => log('warn', 'clock.stalled', data);
      }
    } else if (stalled) {
      stalled = false;
      const data = { elapsed_ms: Math.round(wall), advance_ms: Math.round(advance), state: ctx.state };
      return () => log('info', 'clock.recovered', data);
    }
    return null;
  }

  /**
   * 出力の遅れの見積もり（R16）。getOutputTimestamp があるときだけ、LATENCY_SAMPLE_MS に 1 回まで読み、
   * currentTime - contextTime（ms。いま描いている位置と、出力されている位置の差）と、performance.now() - performanceTime
   * （ms。その出力の位置の古さ）を求める。読み取りと計算だけ（await なし）。source.start のあとに呼ぶ。
   * 見積もりが LATENCY_WARN_MS を超えたら warn（続く間は 1 分に 1 回まで）、そうでなくても 1 分に 1 回は info を書く。作り直しはしない。
   */
  function sampleOutputLatency(ctx: SoundContext, t: number): void {
    if (typeof ctx.getOutputTimestamp !== 'function') return;
    if (t - lastLatencySampleAt < LATENCY_SAMPLE_MS) return;
    lastLatencySampleAt = t;
    const stamp = ctx.getOutputTimestamp();
    const contextTime = finiteOrNull(stamp?.contextTime);
    const performanceTime = finiteOrNull(stamp?.performanceTime);
    const currentTime = finiteOrNull(ctx.currentTime);
    // 出力がまだ始まっていない（0 が返る）ときは、見積もれない。
    if (contextTime === null || performanceTime === null || currentTime === null || (contextTime === 0 && performanceTime === 0)) return;
    const estimate = (currentTime - contextTime) * 1000;
    const data = {
      estimate_ms: Math.round(estimate),
      timestamp_age_ms: Math.round(now() - performanceTime),
      base_latency_ms: ctx.baseLatency === undefined ? null : finiteMs(ctx.baseLatency),
      output_latency_ms: ctx.outputLatency === undefined ? null : finiteMs(ctx.outputLatency),
      state: ctx.state,
    };
    if (estimate > LATENCY_WARN_MS && t - lastLatencyWarnAt >= LATENCY_LOG_INTERVAL_MS) {
      lastLatencyWarnAt = t;
      log('warn', 'output.latency-high', { ...data, threshold_ms: LATENCY_WARN_MS });
    }
    if (t - lastLatencyLogAt >= LATENCY_LOG_INTERVAL_MS) {
      lastLatencyLogAt = t;
      log('info', 'output.latency', data);
    }
  }

  /** running でないときの resume の頼み。頼み方は従来のまま（結果は待たず、失敗は握りつぶす）。記録は、状態の間に 1 回（続くときは 5 秒に 1 回）。 */
  function requestResume(ctx: SoundContext, t: number): void {
    const record = !resumeLogged || t - resumeLoggedAt >= RESUME_LOG_INTERVAL_MS;
    if (record) {
      log('info', 'resume.requested', { state: ctx.state, skipped: resumeSkipped });
      resumeLogged = true;
      resumeLoggedAt = t;
      resumeSkipped = 0;
    } else {
      resumeSkipped += 1;
    }
    void ctx.resume().then(
      () => {
        if (record) log('info', 'resume.result', { ok: true, state: ctx.state });
      },
      (e: unknown) => log('warn', 'resume.result', { ok: false, error: errorName(e), state: ctx.state }),
    );
  }

  function startDecode(ctx: SoundContext, timbre: TypingSoundTimbre, state: TimbreState): void {
    if (state.decoding || state.sounds || !state.bytes) return;
    state.decoding = true;
    const sources = state.bytes;
    void Promise.allSettled(sources.map((b) => ctx.decodeAudioData(b.slice(0)))).then((results) => {
      const decoded = results.flatMap((r) => (r.status === 'fulfilled' ? [{ buffer: r.value, offset: offsetOfBuffer(r.value) }] : []));
      // 1 つも読めなければ、鳴らさない（次のキーで、同じ失敗を繰り返さない）。
      state.sounds = decoded;
      if (!disposed) {
        emit({ type: 'decoded', timbre, count: decoded.length, offsets: decoded.map((d) => d.offset) });
        const failures = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
        log(failures.length > 0 ? 'warn' : 'info', 'decode.result', {
          timbre,
          ok: decoded.length,
          failed: failures.length,
          ...(failures[0] ? { error: errorName(failures[0].reason) } : {}),
        });
      }
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
      (error: unknown) => {
        // 読めなかった。次に設定がオンになったとき、または音色が選ばれたとき（prepare）、もう一度試す。
        state.loading = false;
        if (!disposed) log('warn', 'fetch.failed', { timbre, status: error instanceof SoundHttpError ? error.status : null, error: errorName(error) });
      },
    );
  }

  function ensureContext(): SoundContext | null {
    if (context?.state === 'closed') {
      unwatchContext();
      context = null;
      // 外から閉じられた（こちらが閉じたのは release と dispose で、そのときは context が null になっている）。
      createReason = 'after-closed';
    }
    if (!context) {
      context = createContext();
      emit({ type: 'context' });
      watchContext(context, createReason);
      createReason = 'after-closed';
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
    // source.start のあとに書くログ（時計の止まりの検査の結果）。鳴らす経路の中には、ログの書き込みを入れない（R16 の N2）。
    let afterStart: (() => void) | null = null;
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
        clockBase = null;
        requestResume(ctx, t);
        return;
      }
      resumeLogged = false;
      afterStart = checkClock(ctx, t);
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
      const measuring = perfOption?.enabled === true;
      const startDelayMs = observe || measuring ? now() - t : 0;
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
      // 計測（R16）: keydown を受け取ってから source.start を呼ぶまでの時間と、出力の遅れの見積もり。start のあとに行う。
      if (measuring) {
        perfOption.record('sound.start-delay', startDelayMs);
        sampleOutputLatency(ctx, t);
      }
    } catch {
      // 音が鳴らないだけにする。入力は妨げない。
    } finally {
      // 時計の止まりのログは、start のあと（鳴らさずに戻ったときも、ここ）で書く。log は例外を出さない。
      afterStart?.();
    }
  }

  /** AudioContext を閉じる。閉じたことを、理由つきで記録する。閉じられなくても、以降の処理には影響しない。 */
  function closeContext(ctx: SoundContext, reason: string): void {
    log('info', 'context.closed', { reason, from: ctx.state, current_time: finiteOrNull(ctx.currentTime) });
    try {
      void ctx.close().catch(() => {});
    } catch {
      // 閉じられなくても、以降は鳴らさない。
    }
  }

  function release(reason: 'setting-off'): void {
    if (disposed) return;
    const ctx = context;
    if (!ctx) return;
    context = null;
    unwatchContext();
    // デコードした素材は、閉じた AudioContext のもの。捨てて、次のキーで作り直した AudioContext でデコードし直す。
    // 素材のバイト列（bytes）は残す（取り直さない）。
    for (const state of states.values()) {
      state.sounds = null;
      state.decoding = false;
    }
    ends = [];
    lastAt = Number.NEGATIVE_INFINITY;
    createReason = 'after-setting-off';
    closeContext(ctx, reason);
  }

  function dispose(): void {
    if (disposed) return;
    const ctx = context;
    context = null;
    unwatchContext();
    states.clear();
    ends = [];
    if (ctx) closeContext(ctx, 'dispose');
    disposed = true;
  }

  return { prepare, handleKeyDown, release, dispose };
}
