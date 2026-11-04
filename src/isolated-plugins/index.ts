import type { ActionPlugin, PluginRegistry } from '../plugin-api';
import type { HostTrace } from '../plugin-host';

/**
 * 隔離した操作（段 2）の部品の一覧と、その動かし方の設定。
 * R5 では、配布物（本番のビルド）に入る段 2 の部品は 1 つもない（仕組みだけ。最初の部品は R6）。
 * - e2e のビルド（VITE_E2E=1）: seed の isolated に名前を書いたテスト用の部品だけ（e2eFixtures.ts）。
 * - 隔離の検証用のビルド（VITE_ISOLATION_PROBE=1）: 検証用の部品（probe.ts）。
 * どちらも define の定数で囲み、本番のビルドからは import ごと取り除かれる。
 */
export interface IsolatedPluginSet {
  readonly plugins: readonly ActionPlugin[];
  readonly activateTimeoutMs?: number;
  readonly runTimeoutMs?: number;
  /** 観測用の記録の受け口（e2e のビルドだけ）。 */
  readonly trace?: (event: HostTrace) => void;
  /** 部品の一覧（レジストリ）ができた後に呼ばれる（隔離の検証用のビルドだけ。検証を始める）。 */
  readonly afterBoot?: (registry: PluginRegistry) => void;
}

export async function loadIsolatedPlugins(): Promise<IsolatedPluginSet> {
  const plugins: ActionPlugin[] = [];
  let set: Omit<IsolatedPluginSet, 'plugins'> = {};
  if (__E2E__) {
    const seed = window.__E2E_SEED__?.isolated;
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
  return { plugins, ...set };
}
