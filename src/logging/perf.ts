import type { Logger } from './logger';

/**
 * 性能の計測（ADR-007 の R16）。ログがオンの間だけ、区間（名前のついた処理）の所要時間を数え、1 分ごとに区間ごとの 1 行にまとめて書く。
 *
 * - 区間の使い方: `const end = perf.span('名前'); … end();`（始めと終わりを別に呼べる。非同期の往復にも使う）、
 *   `perf.measure('名前', () => …)`（同期の関数用。例外はそのまま投げ直す）、`perf.record('名前', ms)`（測った値を渡す）。
 *   名前は [a-z0-9._-] の 1〜64 文字。合わない名前は数えない。
 * - オフの間は、真偽値を 1 回見るだけで何もしない（performance.now も呼ばない。ためない。タイマー、リスナー、requestAnimationFrame も動かさない）。
 * - オンの間は、区間ごとに件数・合計・最大と、固定のバケツの分布（標本は全部ためない）を持つ。p50 と p95 は、バケツの上端（最大で約 10% 大きい）。
 * - 1 回で SLOW_MS 以上かかったら、その場で 1 件（warn）。区間ごとに 1 分に MAX_SLOW_PER_WINDOW 件まで（残りは、まとめの slow に数だけ残る）。
 * - 区間の数は MAX_SPANS まで。超えた名前は 'other' 1 つにまとめる。
 * - 1 分ごとに、量の推移（文書の長さと行数、DOM の要素の数、JS のメモリ）と、描画の間隔（SLOW_FRAME_MS を超えた回数と最大）も 1 行ずつ書く。
 * 書くのは名前と数値だけ。本文とパスは扱わない。
 */

/** この時間（ms）以上かかった区間は、その場で warn を書く。 */
export const SLOW_MS = 50;
/** 描画の間隔がこの時間（ms）を超えたら、画面の止まりと数える。 */
export const SLOW_FRAME_MS = 50;
/** まとめを書く間隔。 */
export const SUMMARY_INTERVAL_MS = 60_000;
/** 区間の名前の数の上限（超えた名前は OTHER_SPAN にまとめる）。 */
export const MAX_SPANS = 32;
export const OTHER_SPAN = 'other';
/** 1 つの区間が、1 分の間にその場で書く warn の件数の上限（ロガーの回数の制限 10 より小さい）。 */
export const MAX_SLOW_PER_WINDOW = 5;

/** ログの source。まとめの行の event は、区間の名前そのもの（ロガーの回数の制限は source と event ごとなので、区間どうしで数が混ざらない）。 */
export const PERF_SOURCE = 'perf';
export const PERF_SLOW_SOURCE = 'perf-slow';
export const PERF_SYSTEM_SOURCE = 'perf-system';

const NAME = /^[a-z0-9._-]{1,64}$/;

// 分布のバケツ: 0.1 ms から、1.1 倍ずつ上端が増える 141 個（最後の上端は約 60 秒）。範囲外は両端のバケツに入る。
const BUCKET_BASE_MS = 0.1;
const BUCKET_RATIO = 1.1;
const BUCKETS = 141;
const LOG_RATIO = Math.log(BUCKET_RATIO);

function bucketOf(ms: number): number {
  if (ms <= BUCKET_BASE_MS) return 0;
  return Math.min(BUCKETS - 1, Math.ceil(Math.log(ms / BUCKET_BASE_MS) / LOG_RATIO));
}
const bucketUpper = (index: number): number => BUCKET_BASE_MS * Math.pow(BUCKET_RATIO, index);

const round1 = (value: number): number => Math.round(value * 10) / 10;

const NOOP_END = (): void => {};

/** 区間を数える口。plugin-api の PluginPerf と同じ形（部品には、これを貸す）。 */
export interface Perf {
  /** ログがオンの間だけ true。ホットパスで、計測の準備（時刻の取得など）を省くための印。 */
  readonly enabled: boolean;
  /** 区間を始める。戻り値を呼ぶと終わる（2 回目以降は何もしない）。オフの間は、何もしない関数を返す。 */
  span(name: string): () => void;
  /** 同期の関数 fn の所要時間を数えて、fn の戻り値を返す。fn の例外は、数えたうえでそのまま投げ直す。 */
  measure<T>(name: string, fn: () => T): T;
  /** 測った所要時間（ms）を渡す。 */
  record(name: string, ms: number): void;
}

export interface PerfController extends Perf {
  /** 量の推移に書く、今の文書の文字数と行数の取得元（なければ null を書く）。本文は読まない。 */
  setDocumentStats(provider: (() => { readonly chars: number; readonly lines: number }) | null): void;
  /** いまの 1 分の分を、すぐ書いて区切る（pagehide と、テスト用）。 */
  flush(): void;
}

/** 外の環境（時計、タイマー、描画、窓の見え方）。既定は実際のブラウザ。テストで差し替える。 */
export interface PerfEnvironment {
  now(): number;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
  /** requestAnimationFrame。コールバックには、フレームの時刻（ms）が渡る。 */
  requestFrame(fn: (time: number) => void): unknown;
  cancelFrame(handle: unknown): void;
  visibilityState(): string;
  /** 窓の見え方が変わったときと、pagehide のときの通知を付ける。戻り値で外す。 */
  listen(onVisibility: () => void, onPageHide: () => void): () => void;
  /** JS のヒープの使用量（バイト）。取れない環境は null。 */
  heapUsedBytes(): number | null;
  /** DOM の要素の数。 */
  domNodeCount(): number;
}

function browserEnvironment(): PerfEnvironment {
  return {
    now: () => performance.now(),
    setInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
    requestFrame: (fn) => requestAnimationFrame(fn),
    cancelFrame: (handle) => cancelAnimationFrame(handle as number),
    visibilityState: () => document.visibilityState,
    listen: (onVisibility, onPageHide) => {
      document.addEventListener('visibilitychange', onVisibility);
      window.addEventListener('pagehide', onPageHide);
      return () => {
        document.removeEventListener('visibilitychange', onVisibility);
        window.removeEventListener('pagehide', onPageHide);
      };
    },
    heapUsedBytes: () => {
      const used = (performance as unknown as { memory?: { usedJSHeapSize?: unknown } }).memory?.usedJSHeapSize;
      return typeof used === 'number' && Number.isFinite(used) ? used : null;
    },
    domNodeCount: () => document.getElementsByTagName('*').length,
  };
}

interface SpanStats {
  count: number;
  total: number;
  max: number;
  /** この 1 分に、SLOW_MS 以上かかった回数（その場で書いた分と、上限で書かなかった分の両方）。 */
  slow: number;
  /** この 1 分に、その場で書いた warn の件数。 */
  slowLogged: number;
  readonly histogram: Uint32Array;
}

/** 分布から、q（0〜1）の位置の値（バケツの上端。最大を超えない）。 */
function quantile(stats: SpanStats, q: number): number {
  const rank = Math.max(1, Math.ceil(q * stats.count));
  let seen = 0;
  for (let i = 0; i < BUCKETS; i++) {
    seen += stats.histogram[i]!;
    if (seen >= rank) return Math.min(bucketUpper(i), stats.max);
  }
  return stats.max;
}

/**
 * 計測の仕組み。ロガーが有効になったときに動き出し（1 分ごとのタイマー、描画の間隔の見張り、窓の見え方のリスナー）、
 * 無効になったときに全部止めて、ためていた分を捨てる。ロガーが無効の間は、何も動かない。
 */
export function createPerf(logger: Logger, environment?: PerfEnvironment): PerfController {
  let env: PerfEnvironment | null = environment ?? null;
  let active = false;
  const spans = new Map<string, SpanStats>();
  let documentStats: (() => { readonly chars: number; readonly lines: number }) | null = null;

  let timer: unknown = null;
  let unlisten: (() => void) | null = null;
  let frameHandle: unknown = null;
  let lastFrame: number | null = null;
  let frames = 0;
  let frameStalls = 0;
  let maxFrameGap = 0;

  const newStats = (): SpanStats => ({ count: 0, total: 0, max: 0, slow: 0, slowLogged: 0, histogram: new Uint32Array(BUCKETS) });

  function statsFor(name: string): SpanStats | null {
    const known = spans.get(name);
    if (known) return known;
    if (!NAME.test(name)) return null;
    if (spans.size >= MAX_SPANS && name !== OTHER_SPAN) {
      let other = spans.get(OTHER_SPAN);
      if (!other) {
        other = newStats();
        spans.set(OTHER_SPAN, other);
      }
      return other;
    }
    const created = newStats();
    spans.set(name, created);
    return created;
  }

  function record(name: string, ms: number): void {
    if (!active) return;
    if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return;
    const stats = statsFor(name);
    if (!stats) return;
    stats.count += 1;
    stats.total += ms;
    if (ms > stats.max) stats.max = ms;
    stats.histogram[bucketOf(ms)]! += 1;
    if (ms >= SLOW_MS) {
      stats.slow += 1;
      if (stats.slowLogged < MAX_SLOW_PER_WINDOW) {
        stats.slowLogged += 1;
        logger.warn(PERF_SLOW_SOURCE, spans.get(name) === stats ? name : OTHER_SPAN, { ms: round1(ms) });
      }
    }
  }

  function span(name: string): () => void {
    if (!active) return NOOP_END;
    const started = env!.now();
    let done = false;
    return () => {
      if (done) return;
      done = true;
      if (active) record(name, env!.now() - started);
    };
  }

  function measure<T>(name: string, fn: () => T): T {
    if (!active) return fn();
    const end = span(name);
    try {
      return fn();
    } finally {
      end();
    }
  }

  /** いまの 1 分の分を書いて、数えをやり直す。区間の名前の登録は残す（上限の数え方が、窓ごとに変わらないように）。 */
  function writeWindow(): void {
    if (!active) return;
    try {
      for (const [name, stats] of spans) {
        if (stats.count === 0) continue;
        logger.info(PERF_SOURCE, name, {
          count: stats.count,
          p50_ms: round1(quantile(stats, 0.5)),
          p95_ms: round1(quantile(stats, 0.95)),
          max_ms: round1(stats.max),
          total_ms: round1(stats.total),
          slow: stats.slow,
        });
        stats.count = 0;
        stats.total = 0;
        stats.max = 0;
        stats.slow = 0;
        stats.slowLogged = 0;
        stats.histogram.fill(0);
      }
      let chars: number | null = null;
      let lines: number | null = null;
      try {
        const doc = documentStats?.();
        if (doc) {
          chars = doc.chars;
          lines = doc.lines;
        }
      } catch {
        // 取れなければ null。
      }
      const heap = env!.heapUsedBytes();
      logger.info(PERF_SYSTEM_SOURCE, 'gauges', {
        doc_chars: chars,
        doc_lines: lines,
        dom_nodes: env!.domNodeCount(),
        heap_used_mb: heap === null ? null : round1(heap / (1024 * 1024)),
      });
      if (frames > 0) {
        logger.info(PERF_SYSTEM_SOURCE, 'frames', { frames, stalls: frameStalls, max_ms: round1(maxFrameGap) });
      }
      frames = 0;
      frameStalls = 0;
      maxFrameGap = 0;
    } catch {
      // 計測の失敗で、アプリを止めない。
    }
  }

  function onFrame(time: number): void {
    frameHandle = null;
    if (!active) return;
    if (lastFrame !== null) {
      const gap = time - lastFrame;
      frames += 1;
      if (gap > SLOW_FRAME_MS) frameStalls += 1;
      if (gap > maxFrameGap) maxFrameGap = gap;
    }
    lastFrame = time;
    if (env!.visibilityState() === 'visible') frameHandle = env!.requestFrame(onFrame);
  }

  function startFrames(): void {
    if (frameHandle !== null) return;
    lastFrame = null;
    if (env!.visibilityState() === 'visible') frameHandle = env!.requestFrame(onFrame);
  }

  function stopFrames(): void {
    if (frameHandle !== null) env!.cancelFrame(frameHandle);
    frameHandle = null;
    lastFrame = null;
  }

  function start(): void {
    if (active) return;
    env ??= browserEnvironment();
    active = true;
    timer = env.setInterval(writeWindow, SUMMARY_INTERVAL_MS);
    unlisten = env.listen(
      () => {
        // 窓が隠れている間は、描画の間隔を数えない（隠れる前後の空白を、止まりと見ない）。
        if (env!.visibilityState() === 'visible') startFrames();
        else stopFrames();
      },
      () => {
        writeWindow();
        logger.flush({ sync: true });
      },
    );
    startFrames();
  }

  function stop(): void {
    if (!active) return;
    active = false;
    if (timer !== null) env!.clearInterval(timer);
    timer = null;
    stopFrames();
    unlisten?.();
    unlisten = null;
    spans.clear();
    frames = 0;
    frameStalls = 0;
    maxFrameGap = 0;
  }

  logger.onEnabledChange((enabled) => (enabled ? start() : stop()));
  if (logger.enabled) start();

  return {
    get enabled() {
      return active;
    },
    span,
    measure,
    record,
    setDocumentStats(provider) {
      documentStats = provider;
    },
    flush: writeWindow,
  };
}
