/**
 * アプリのログ基盤（ADR-007）。設定「ログを記録する」（既定はオフ）で有効にしたときだけ、ブリッジ（appendLog）経由で
 * Rust 側の app.log に書く。本体の各所は、ここの `log`（または `logger`）で記録する。無効の間は何もしない。
 */
import { createLogSwitch, type LogBridge } from './control';
import { createLogger } from './logger';
import { createPerf } from './perf';
import type { LogEntry } from './types';

export { installAppDiagnostics } from './diagnostics';
export { createLogger, type Logger } from './logger';
export { createPerf, type Perf, type PerfController, type PerfEnvironment } from './perf';
export { createLogSwitch, type LogBridge, type LogSwitch } from './control';
export { basenameOf, clip, errorFields, errorKind, scrubHome } from './sanitize';
export type { LogData, LogEntry, LogFn, LogLevel, LogValue } from './types';

/** ログの出し先（ブリッジ）。attachLogBridge で結ぶ。 */
interface LogSink extends LogBridge {
  appendLog(entries: readonly LogEntry[]): Promise<void>;
}

let sink: LogSink | null = null;

/** アプリのロガー（1 つ）。結ぶまでは、有効にしても、渡し先がない。 */
export const logger = createLogger({ append: (entries) => sink?.appendLog(entries) });

/** 性能の計測（R16）。ログがオンの間だけ動く。区間は perf.span / perf.measure / perf.record、使い方は perf.ts。 */
export const perf = createPerf(logger);

/** 本体のログの書き方: log.info('document', 'save-failed', { op: 'save' })。 */
export const log = {
  info: logger.info,
  warn: logger.warn,
  error: logger.error,
};

const logSwitch = createLogSwitch(
  () => sink,
  logger,
  (initial) => {
    // 起動（または、設定でオンにした）ときの 1 件。userAgent で、WebKit の版がわかる。
    logger.info('app', initial ? 'start' : 'logging-enabled', {
      user_agent: typeof navigator === 'undefined' ? null : navigator.userAgent,
      visibility: typeof document === 'undefined' ? null : document.visibilityState,
    });
  },
);

/** ブリッジを結ぶ（起動時に 1 回）。 */
export function attachLogBridge(bridge: LogSink): void {
  sink = bridge;
}

/** 設定の値（ログを記録するか）を、ネイティブ側とロガーに伝える。 */
export const applyLogSetting = logSwitch.apply;
