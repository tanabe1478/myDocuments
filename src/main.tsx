import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { bundledPlugins } from './features';
import { createPluginRegistry } from './plugin-api';
import { applyPreferences } from './preferences/apply';
import { DEFAULT_PREFERENCES, normalizePreferences } from './preferences/preferences';
import { createBridge } from './platform';
import './styles.css';

async function bootstrap(): Promise<void> {
  const bridge = await createBridge();

  // 部品の一覧。部品の例外や版の不一致で起動を止めない（その部品だけを外す）。
  const plugins = createPluginRegistry(bundledPlugins, { reservedSettingKeys: Object.keys(DEFAULT_PREFERENCES) });

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
