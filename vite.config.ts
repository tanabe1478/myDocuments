import { readFileSync } from 'node:fs';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vitest/config';

const PLUGIN_HOST_DIR = new URL('./src/plugin-host/', import.meta.url);
const PLUGIN_HOST_FILES: Record<string, string> = { 'host.html': 'text/html; charset=utf-8', 'relay.js': 'text/javascript; charset=utf-8' };

/**
 * 隔離した操作（段 2）の Worker のホスト（src/plugin-host/host.html と relay.js）を、ブラウザ版の同じオリジンの /plug/ から配信する。
 * Tauri 版は同じファイルを独自プロトコル plug: が返す（src-tauri/src/plug.rs が include_str! で埋め込む）。
 * - dev サーバー: そのまま返す。
 * - ビルド: VITE_E2E=1 のときだけ plug/ に書き出す。本番のビルドには出さない（Tauri 版は plug: から読む）。
 * ファイルは vite を通さず、元のバイト列のまま配信する（Tauri 版と同じ中身にするため）。
 */
function pluginHostFiles(): Plugin {
  return {
    name: 'plugin-host-files',
    configureServer(server) {
      server.middlewares.use('/plug', (req, res, next) => {
        const name = (req.url ?? '').split('?')[0]?.replace(/^\//, '') ?? '';
        const type = Object.hasOwn(PLUGIN_HOST_FILES, name) ? PLUGIN_HOST_FILES[name] : undefined;
        if (!type) return next();
        res.setHeader('Content-Type', type);
        res.setHeader('Cache-Control', 'no-store');
        res.end(readFileSync(new URL(name, PLUGIN_HOST_DIR)));
      });
    },
    generateBundle() {
      if (process.env.VITE_E2E !== '1') return;
      for (const name of Object.keys(PLUGIN_HOST_FILES)) {
        this.emitFile({ type: 'asset', fileName: `plug/${name}`, source: readFileSync(new URL(name, PLUGIN_HOST_DIR)) });
      }
    },
  };
}

// Tauri の dev サーバーは固定ポートを期待する。
export default defineConfig({
  plugins: [react(), pluginHostFiles()],
  // VITE_E2E=1 のビルドでだけ、メモリ実装の DocumentBridge を含める（src/platform/index.ts）。
  define: {
    __E2E__: JSON.stringify(process.env.VITE_E2E === '1'),
    // VITE_ISOLATION_PROBE=1 のビルド（隔離の検証用。Cargo の feature isolation-probe と一緒に使う）でだけ true。
    __ISOLATION_PROBE__: JSON.stringify(process.env.VITE_ISOLATION_PROBE === '1'),
  },
  clearScreen: false,
  server: { port: 1420, strictPort: true },
  build: { target: 'es2022' },
  test: {
    include: ['src/**/*.test.{ts,tsx}'],
    environment: 'node',
    // 測るだけ（しきい値なし）。除外の理由は docs/coverage-baseline.md。
    coverage: {
      provider: 'v8',
      include: ['src/**/*.{ts,tsx}'],
      exclude: ['src/**/*.test.{ts,tsx}', 'src/**/*.d.ts', 'src/main.tsx', 'src/document/testKit.ts'],
      reporter: ['text', 'json-summary'],
      reportsDirectory: 'coverage',
    },
  },
});
