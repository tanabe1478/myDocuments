import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { bundledPlugins } from './features';
import { loadIsolatedPlugins } from './isolated-plugins';
import { createPluginRegistry } from './plugin-api';
import { createIsolatedPluginHost, pluginHostUrl } from './plugin-host';
import { applyPreferences } from './preferences/apply';
import { DEFAULT_PREFERENCES, normalizePreferences } from './preferences/preferences';
import { createBridge } from './platform';
import './styles.css';

async function bootstrap(): Promise<void> {
  const bridge = await createBridge();

  // 部品の一覧。部品の例外や版の不一致で起動を止めない（その部品だけを外す）。
  // 隔離した操作（段 2）の部品。配布物には 1 つも入っていない（R5）。1 つもなければ、iframe も Worker も作らない。
  const isolated = await loadIsolatedPlugins();
  const isolation =
    isolated.plugins.length > 0
      ? createIsolatedPluginHost({
          hostUrl: pluginHostUrl(),
          ...(isolated.activateTimeoutMs !== undefined ? { activateTimeoutMs: isolated.activateTimeoutMs } : {}),
          ...(isolated.runTimeoutMs !== undefined ? { runTimeoutMs: isolated.runTimeoutMs } : {}),
          ...(isolated.trace ? { trace: isolated.trace } : {}),
        })
      : undefined;
  const plugins = createPluginRegistry([...bundledPlugins, ...isolated.plugins], {
    reservedSettingKeys: Object.keys(DEFAULT_PREFERENCES),
    ...(isolation ? { isolation } : {}),
  });
  isolated.afterBoot?.(plugins);

  // 設定が読めなくても起動する。値は検証して、範囲外の項目だけ既定値に戻す。
  let prefs = normalizePreferences(null, plugins.settings);
  try {
    prefs = normalizePreferences(await bridge.loadPreferences(), plugins.settings);
  } catch {
    // 既定値で続行
  }
  applyPreferences(prefs);

  const root = document.getElementById('root');
  if (!root) throw new Error('#root not found');
  createRoot(root).render(
    <StrictMode>
      <App bridge={bridge} initialPreferences={prefs} plugins={plugins} />
    </StrictMode>,
  );
}

void bootstrap();
