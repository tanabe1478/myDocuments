/**
 * Worker のホストのページの URL。
 * - ブラウザ版（e2e のビルドと dev サーバー）: 同じオリジンの /plug/host.html（vite.config.ts が src/plugin-host/ から配信する）。
 * - Tauri 版: 独自プロトコル plug:（src-tauri/src/plug.rs）。macOS と Linux は plug://localhost/、Windows は http://plug.localhost/
 *   （Windows と Linux は未確認）。
 */
export function pluginHostUrl(): string {
  if (__E2E__ || import.meta.env.DEV) return '/plug/host.html';
  const windows = typeof navigator !== 'undefined' && /Windows/i.test(navigator.userAgent);
  return windows ? 'http://plug.localhost/host.html' : 'plug://localhost/host.html';
}
