import type { ActionPlugin, PluginRegistry } from '../plugin-api';
import type { HostTrace } from '../plugin-host';

/**
 * 隔離した操作（段 2）の部品の一覧と、その動かし方の設定。
 * 配布物（本番のビルド）に入る段 2 の部品は、src/features/ の bundledActionPlugins（R6 の最初の部品）。ここに足すのは、検証用の部品だけ（本番では空）。
 * - e2e のビルド（VITE_E2E=1）: seed の isolated に名前を書いたテスト用の部品だけ（e2eFixtures.ts）。
 * - 隔離の検証用のビルド（VITE_ISOLATION_PROBE=1）: 検証用の部品（probe.ts）。
 * どちらも define の定数で囲み、本番のビルドからは import ごと取り除かれる。
 */
export interface IsolatedPluginSet {
  readonly plugins: readonly ActionPlugin[];
  /**
   * 同梱の段 2 の部品（src/features/ の bundledActionPlugins）も読み込むか。本番は常に true。e2e のビルドは、seed の
   * isolated.bundled が true のときだけ（既存のテストが、同梱の部品のメニューの項目や iframe に影響されないため）。
   */
  readonly includeBundled: boolean;
  readonly activateTimeoutMs?: number;
  readonly runTimeoutMs?: number;
  /** 観測用の記録の受け口（e2e のビルドだけ）。 */
  readonly trace?: (event: HostTrace) => void;
  /** 部品の一覧（レジストリ）ができた後に呼ばれる（隔離の検証用のビルドだけ。検証を始める）。 */
  readonly afterBoot?: (registry: PluginRegistry) => void;
}

export async function loadIsolatedPlugins(): Promise<IsolatedPluginSet> {
  const plugins: ActionPlugin[] = [];
  let set: Omit<IsolatedPluginSet, 'plugins' | 'includeBundled'> = {};
  let includeBundled = true;
  if (__E2E__) {
    const seed = window.__E2E_SEED__?.isolated;
    includeBundled = seed?.bundled === true;
    if (seed) {
      const { e2eActionPlugins } = await import('./e2eFixtures');
      const wanted = new Set(seed.plugins);
      plugins.push(...e2eActionPlugins.filter((p) => wanted.has(p.manifest.id)));
      window.__mdeE2EIsolatedTrace = [];
      set = {
        ...(seed.activateTimeoutMs !== undefined ? { activateTimeoutMs: seed.activateTimeoutMs } : {}),
        ...(seed.runTimeoutMs !== undefined ? { runTimeoutMs: seed.runTimeoutMs } : {}),
        trace: (event) => window.__mdeE2EIsolatedTrace?.push(event),
      };
    }
  }
  if (__ISOLATION_PROBE__) {
    const { createProbe } = await import('./probe');
    const probe = await createProbe();
    plugins.push(...probe.plugins);
    const previous = set.trace;
    set = { ...set, trace: (event) => (previous?.(event), probe.trace(event)), afterBoot: probe.afterBoot };
  }
  return { plugins, includeBundled, ...set };
}
