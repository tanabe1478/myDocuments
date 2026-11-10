import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { bundledActionPlugins, bundledPlugins } from './features';
import { loadIsolatedPlugins } from './isolated-plugins';
import { applyLogSetting, attachLogBridge, installAppDiagnostics, logger, perf } from './logging';
import { createPluginRegistry } from './plugin-api';
import { createIsolatedPluginHost } from './plugin-host';
import { applyPreferences } from './preferences/apply';
import { DEFAULT_PREFERENCES, normalizePreferences } from './preferences/preferences';
import { createBridge, instrumentBridge } from './platform';
import { PermissionController } from './permissions/controller';
import './styles.css';

async function bootstrap(): Promise<void> {
  // 性能の計測（R16）のため、ブリッジの往復を数える包みで覆う（appendLog は数えない。ログがオフの間は、元のメソッドをそのまま呼ぶ）。
  const bridge = instrumentBridge(await createBridge(), perf);

  // アプリのログ（ADR-007）。保存済みの設定「ログを記録する」（既定はオフ）を、部品を読み込む前に伝える
  // （部品の読み込みの失敗も記録できるように）。設定が読めないときは、オフのまま。オフの間は、何も書かない。
  let storedPreferences: unknown = null;
  try {
    storedPreferences = await bridge.loadPreferences();
  } catch {
    // 既定値で続行
  }
  attachLogBridge(bridge);
  installAppDiagnostics(logger);
  // e2e のビルドだけ: 1 分を待たずに、計測のまとめを書かせる（本番では、この呼び出しごと取り除かれる）。
  if (__E2E__) (window as unknown as { __mdePerf?: { flush(): void } }).__mdePerf = { flush: () => perf.flush() };
  await applyLogSetting(normalizePreferences(storedPreferences).appLog);

  // 部品の一覧。部品の例外や版の不一致で起動を止めない（その部品だけを外す）。
  // 隔離した操作（段 2）の部品。同梱の部品（bundledActionPlugins）と、検証用の部品（e2e、隔離の検証。本番では空）。
  // 1 つもなければ、iframe も Worker も作らない。あっても、iframe と Worker は、最初の描画のあとに作る（deferStart。App が startDeferred を呼ぶ）。
  const isolated = await loadIsolatedPlugins();
  const actionPlugins = [...(isolated.includeBundled ? bundledActionPlugins : []), ...isolated.plugins];
  const isolation =
    actionPlugins.length > 0
      ? createIsolatedPluginHost({
          ...(isolated.activateTimeoutMs !== undefined ? { activateTimeoutMs: isolated.activateTimeoutMs } : {}),
          ...(isolated.runTimeoutMs !== undefined ? { runTimeoutMs: isolated.runTimeoutMs } : {}),
          ...(isolated.trace ? { trace: isolated.trace } : {}),
          perf,
        })
      : undefined;
  // 段 2 の権限の決定と確認の画面。保存済みの決定は、最初に必要になったときに読む（起動では読まない）。
  const permissions = new PermissionController({ bridge, notify: () => {} });
  const plugins = createPluginRegistry([...bundledPlugins, ...actionPlugins], {
    reservedSettingKeys: Object.keys(DEFAULT_PREFERENCES),
    ...(isolation ? { isolation } : {}),
    permissions,
    deferStart: true,
    log: (level, source, event, data) => logger.log(level, source, event, data),
    perf,
  });
  isolated.afterBoot?.(plugins);

  // 設定が読めなくても起動する。値は検証して、範囲外の項目だけ既定値に戻す。
  const prefs = normalizePreferences(storedPreferences, plugins.settings);
  applyPreferences(prefs);

  const root = document.getElementById('root');
  if (!root) throw new Error('#root not found');
  createRoot(root).render(
    <StrictMode>
      <App bridge={bridge} initialPreferences={prefs} plugins={plugins} permissions={permissions} />
    </StrictMode>,
  );
}

void bootstrap();
