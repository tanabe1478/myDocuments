import { clip, MAX_VALUE_CHARS } from './sanitize';
import type { LogData, LogEntry, LogLevel, LogValue } from './types';

/** ためたログをブリッジへ渡す間隔。 */
export const FLUSH_INTERVAL_MS = 1000;
/** ためておく件数の上限。あふれた分は、件数だけを logging.dropped の 1 件にする。 */
export const MAX_BUFFERED = 200;
/** 1 回の appendLog に渡す件数（Rust 側の上限と同じ）。 */
export const MAX_PER_CALL = 100;
/** 同じ source と event を、RATE_WINDOW_MS のあいだに記録できる件数。 */
export const RATE_LIMIT = 10;
export const RATE_WINDOW_MS = 60_000;
/** data の項目数の上限（Rust 側と同じ。足す項目の分を残すため、渡す側は 19 まで）。 */
const MAX_DATA_ITEMS = 20;

const NAME = /^[a-z0-9._-]{1,64}$/;

export interface LoggerOptions {
  /** ためた分を渡す先（ブリッジの appendLog）。失敗は無視する（アプリの動作に影響させない）。 */
  readonly append: (entries: readonly LogEntry[]) => Promise<void> | void;
  /** 今の時刻（ミリ秒）。回数の制限の窓に使う。 */
  readonly now?: () => number;
  /** 一定時間後に 1 回呼ぶ。戻り値で取り消す。 */
  readonly setTimer?: (fn: () => void, ms: number) => unknown;
  readonly clearTimer?: (handle: unknown) => void;
}

export interface Logger {
  readonly enabled: boolean;
  /** 有効・無効を切り替える。無効にしたときは、ためていた分と回数の数えを捨てる。 */
  setEnabled(enabled: boolean): void;
  /** 有効・無効が変わったときに呼ばれる。戻り値で解除。 */
  onEnabledChange(listener: (enabled: boolean) => void): () => void;
  /** 無効の間は何もしない（ためない）。 */
  log(level: LogLevel, source: string, event: string, data?: LogData): void;
  info(source: string, event: string, data?: LogData): void;
  warn(source: string, event: string, data?: LogData): void;
  error(source: string, event: string, data?: LogData): void;
  /** ためた分を、いま渡す。sync が true のとき（pagehide）は、前の送信の完了を待たずに、すぐ渡す。 */
  flush(options?: { sync?: boolean }): void;
}

interface RateState {
  windowStart: number;
  count: number;
  suppressed: number;
}

/** data を、渡せる形にする: 使えない値と名前の項目は捨て、文字列はホームのパスを `~` にして 500 文字までに切る。 */
function cleanData(data: LogData | undefined): Record<string, LogValue> {
  const out: Record<string, LogValue> = {};
  if (!data) return out;
  for (const [key, value] of Object.entries(data)) {
    if (Object.keys(out).length >= MAX_DATA_ITEMS) break;
    if (!NAME.test(key) || value === undefined) continue;
    if (typeof value === 'string') out[key] = clip(value, MAX_VALUE_CHARS);
    else if (typeof value === 'number') {
      if (Number.isFinite(value)) out[key] = value;
    } else if (typeof value === 'boolean' || value === null) out[key] = value;
  }
  return out;
}

/**
 * アプリのロガー（ADR-007）。
 * - 無効の間は何もしない（ためない）。有効の間だけ、メモリにためて、1 秒ごと（最初の 1 件から 1 秒後）にまとめて渡す。
 * - ためるのは 200 件まで。あふれた分は捨て、件数だけを、次の渡しに logging.dropped の 1 件として足す。
 * - 同じ source と event は、1 分に 10 件まで。超えた分は捨て、次に記録できたとき、省いた件数を data.suppressed に添える。
 * - 渡すときは 100 件ずつ（Rust 側の上限）。渡すのに失敗しても、投げ直さず、何も起こさない。
 * 本文とパスは、ここでは書かない（呼び出し側が渡さない。文字列の中のホームのパスは `~` になる）。
 */
export function createLogger(options: LoggerOptions): Logger {
  const now = options.now ?? (() => Date.now());
  const setTimer = options.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearTimer = options.clearTimer ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));

  let enabled = false;
  let buffer: LogEntry[] = [];
  let dropped = 0;
  let timer: unknown = null;
  /** 渡し中か、順番を待っている分（定期の渡しは、前の渡しが終わってから、順番に渡す）。 */
  let delivering = false;
  const waiting: LogEntry[][][] = [];
  const rates = new Map<string, RateState>();
  const listeners = new Set<(enabled: boolean) => void>();

  async function deliver(chunks: LogEntry[][]): Promise<void> {
    for (const chunk of chunks) {
      try {
        await options.append(chunk);
      } catch {
        // 渡せなかった分は捨てる。ログの失敗でアプリを止めない。
      }
    }
  }

  function pump(): void {
    if (delivering) return;
    const next = waiting.shift();
    if (!next) return;
    delivering = true;
    // 1 件目の append は、この呼び出しの中で（同期に）始まる。
    void deliver(next).then(() => {
      delivering = false;
      pump();
    });
  }

  function send(entries: LogEntry[], sync: boolean): void {
    const chunks: LogEntry[][] = [];
    for (let i = 0; i < entries.length; i += MAX_PER_CALL) chunks.push(entries.slice(i, i + MAX_PER_CALL));
    if (sync) {
      // ページが閉じるとき: 順番を待たず、すぐ渡す。
      void deliver(chunks);
      return;
    }
    waiting.push(chunks);
    pump();
  }

  function flush(flushOptions: { sync?: boolean } = {}): void {
    if (timer !== null) {
      clearTimer(timer);
      timer = null;
    }
    if (!enabled) return;
    const entries = buffer;
    const lost = dropped;
    buffer = [];
    dropped = 0;
    if (lost > 0) entries.push({ level: 'warn', source: 'logging', event: 'dropped', data: { count: lost } });
    if (entries.length === 0) return;
    send(entries, flushOptions.sync === true);
  }

  function log(level: LogLevel, source: string, event: string, data?: LogData): void {
    if (!enabled) return;
    try {
      if (!NAME.test(source) || !NAME.test(event)) return;
      // 回数の制限。
      const key = `${source}\u0000${event}`;
      const t = now();
      let rate = rates.get(key);
      if (!rate || t - rate.windowStart >= RATE_WINDOW_MS) {
        rate = { windowStart: t, count: 0, suppressed: rate?.suppressed ?? 0 };
        rates.set(key, rate);
      }
      if (rate.count >= RATE_LIMIT) {
        rate.suppressed += 1;
        return;
      }
      rate.count += 1;
      const cleaned = cleanData(data);
      if (rate.suppressed > 0) {
        cleaned.suppressed = rate.suppressed;
        rate.suppressed = 0;
      }
      if (buffer.length >= MAX_BUFFERED) {
        dropped += 1;
      } else {
        buffer.push({ level, source, event, data: cleaned });
      }
      if (timer === null) timer = setTimer(() => flush(), FLUSH_INTERVAL_MS);
    } catch {
      // ログの失敗で、呼び出し元を止めない。
    }
  }

  return {
    get enabled() {
      return enabled;
    },
    setEnabled(next) {
      if (next === enabled) return;
      enabled = next;
      if (!next) {
        if (timer !== null) clearTimer(timer);
        timer = null;
        buffer = [];
        dropped = 0;
        rates.clear();
      }
      for (const listener of Array.from(listeners)) {
        try {
          listener(next);
        } catch {
          // 受け手の失敗は、切り替えを妨げない。
        }
      }
    },
    onEnabledChange(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    log,
    info: (source, event, data) => log('info', source, event, data),
    warn: (source, event, data) => log('warn', source, event, data),
    error: (source, event, data) => log('error', source, event, data),
    flush,
  };
}
