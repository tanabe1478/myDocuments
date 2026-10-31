import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { applyPreferences } from './preferences/apply';
import { DEFAULT_PREFERENCES, normalizePreferences } from './preferences/preferences';
import { createBridge } from './platform';
import './styles.css';

async function bootstrap(): Promise<void> {
  const bridge = await createBridge();

  // 設定が読めなくても起動する。値は検証して、範囲外の項目だけ既定値に戻す。
  let prefs = DEFAULT_PREFERENCES;
  try {
    prefs = normalizePreferences(await bridge.loadPreferences());
  } catch {
    // 既定値で続行
  }
  applyPreferences(prefs);

  const root = document.getElementById('root');
  if (!root) throw new Error('#root not found');
  createRoot(root).render(
    <StrictMode>
      <App bridge={bridge} initialPreferences={prefs} />
    </StrictMode>,
  );
}

void bootstrap();
