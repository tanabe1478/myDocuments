import type { Logger } from './logger';

/** ネイティブ側のログの入口（DocumentBridge のうち、ログに使う 2 つ）。 */
export interface LogBridge {
  setLogging(enabled: boolean): Promise<void>;
}

export interface LogSwitch {
  /**
   * 設定の値を、ネイティブ側とロガーに伝える。同じ値が続けて来たときは何もしない。
   * 有効にするときは、ネイティブ側が有効になってから、ロガーを有効にする（先に渡すと、ネイティブ側が捨てるため）。
   * 無効にするときは、すぐロガーを止め（ためていた分を捨てる）、そのあとネイティブ側を止める。
   * ネイティブ側の切り替えに失敗したら、ロガーは無効のまま（失敗は投げない）。
   */
  apply(enabled: boolean): Promise<void>;
}

export function createLogSwitch(
  getBridge: () => LogBridge | null,
  logger: Logger,
  /** ロガーが有効になった直後に呼ぶ。initial は、最初の apply による有効化（起動時）。 */
  onEnabled?: (initial: boolean) => void,
): LogSwitch {
  let desired: boolean | null = null;
  let first = true;
  let chain: Promise<void> = Promise.resolve();

  return {
    apply(enabled) {
      if (desired === enabled) return chain;
      const initial = first;
      first = false;
      desired = enabled;
      if (!enabled) logger.setEnabled(false);
      const run = async (): Promise<void> => {
        const bridge = getBridge();
        if (!bridge) return;
        try {
          await bridge.setLogging(enabled);
        } catch {
          if (enabled) logger.setEnabled(false);
          return;
        }
        // 待っているあいだに、設定がまた変わっていたら、最新の値に任せる。
        if (enabled && desired === true) {
          logger.setEnabled(true);
          onEnabled?.(initial);
        }
      };
      chain = chain.then(run, run);
      return chain;
    },
  };
}
