import type { Logger } from './logger';
import { basenameOf, errorFields } from './sanitize';

/** 時計の飛びを見る間隔と、飛びとして記録する大きさ（ミリ秒）。 */
export const CLOCK_CHECK_MS = 10_000;
export const CLOCK_JUMP_MS = 30_000;

export interface DiagnosticsEnvironment {
  readonly window: Pick<Window, 'addEventListener' | 'removeEventListener'>;
  readonly document: Pick<Document, 'addEventListener' | 'removeEventListener' | 'visibilityState'>;
  readonly now: () => number;
  readonly setInterval: (fn: () => void, ms: number) => unknown;
  readonly clearInterval: (handle: unknown) => void;
}

const defaultEnvironment = (): DiagnosticsEnvironment => ({
  window,
  document,
  now: () => Date.now(),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
});

/**
 * 本体のログ（source は app）: 拾われなかった例外、visibilitychange、時計の飛び。pagehide では、ためた分をすぐ渡す。
 * リスナーは最初に付けるが、ロガーが無効の間は何も書かない。時計の見張り（10 秒ごとのタイマー）は、有効の間だけ動かす。
 * 戻り値で、すべて外す（テスト用）。
 */
export function installAppDiagnostics(logger: Logger, env: DiagnosticsEnvironment = defaultEnvironment()): () => void {
  const onError = (event: Event) => {
    const e = event as ErrorEvent;
    const file = typeof e.filename === 'string' && e.filename !== '' ? basenameOf(e.filename) : null;
    logger.error('app', 'uncaught-error', {
      // error が付いていない（別オリジンのスクリプトなど）ときは、ErrorEvent の message の文字列を使う。
      ...errorFields(e.error ?? e.message),
      file,
      line: typeof e.lineno === 'number' && e.lineno > 0 ? e.lineno : null,
      column: typeof e.colno === 'number' && e.colno > 0 ? e.colno : null,
    });
  };
  const onRejection = (event: Event) => {
    logger.error('app', 'unhandled-rejection', errorFields((event as PromiseRejectionEvent).reason));
  };
  const onVisibility = () => {
    logger.info('app', 'visibility', { state: env.document.visibilityState });
  };
  const onPageHide = () => logger.flush({ sync: true });

  env.window.addEventListener('error', onError);
  env.window.addEventListener('unhandledrejection', onRejection);
  env.window.addEventListener('pagehide', onPageHide);
  env.document.addEventListener('visibilitychange', onVisibility);

  // 時計の飛び: 10 秒ごとに今の時刻を見て、前に見た時刻から 10 秒を引いた分が 30 秒以上なら、飛んだ秒数を記録する
  // （スリープからの復帰の目印。窓が隠れてタイマーが間引かれたときも出るので、そのときの visibilityState を添える）。
  let timer: unknown = null;
  let last = 0;
  const startClock = () => {
    if (timer !== null) return;
    last = env.now();
    timer = env.setInterval(() => {
      const t = env.now();
      const elapsed = t - last;
      last = t;
      const jump = elapsed - CLOCK_CHECK_MS;
      if (jump >= CLOCK_JUMP_MS) {
        logger.warn('app', 'clock-jump', {
          jump_seconds: Math.round(jump / 1000),
          elapsed_seconds: Math.round(elapsed / 1000),
          visibility: env.document.visibilityState,
        });
      }
    }, CLOCK_CHECK_MS);
  };
  const stopClock = () => {
    if (timer === null) return;
    env.clearInterval(timer);
    timer = null;
  };
  if (logger.enabled) startClock();
  const offEnabled = logger.onEnabledChange((enabled) => (enabled ? startClock() : stopClock()));

  return () => {
    offEnabled();
    stopClock();
    env.window.removeEventListener('error', onError);
    env.window.removeEventListener('unhandledrejection', onRejection);
    env.window.removeEventListener('pagehide', onPageHide);
    env.document.removeEventListener('visibilitychange', onVisibility);
  };
}
