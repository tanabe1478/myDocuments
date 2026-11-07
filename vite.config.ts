import { readFileSync } from 'node:fs';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vitest/config';

const PLUGIN_HOST_DIR = new URL('./src/plugin-host/', import.meta.url);
const PROBE_FRAME_DIR = new URL('./src/isolated-plugins/', import.meta.url);

/**
 * 本体と同じオリジンの決まったパス /plugin-host/ から配信するファイル（名前 → 元のファイルと Content-Type）。
 * 仲介の iframe は sandbox の srcdoc（中身は host.html を ?raw で取り込んだもの）で、仲介のコード relay.js だけを、ここから読む（ADR-005 の R8）。
 * - relay.js: 本番のビルド（dist）にも、e2e のビルドにも、dev サーバーにも、同じバイト列で出す（vite を通さない）。
 * - probe-frame.js: 隔離の検証用（VITE_ISOLATION_PROBE=1 のときだけ。本番の dist には出ない）。
 */
function pluginHostFiles(): Record<string, { source: URL; type: string }> {
  const files: Record<string, { source: URL; type: string }> = {
    'relay.js': { source: new URL('relay.js', PLUGIN_HOST_DIR), type: 'text/javascript; charset=utf-8' },
  };
  if (process.env.VITE_ISOLATION_PROBE === '1') files['probe-frame.js'] = { source: new URL('probe-frame.js', PROBE_FRAME_DIR), type: 'text/javascript; charset=utf-8' };
  return files;
}

/**
 * 隔離した操作（段 2）の仲介のコード（src/plugin-host/relay.js）を、本体と同じオリジンの /plugin-host/relay.js から配信する。
 * Tauri 版は dist/plugin-host/relay.js を、本体のファイルと同じ tauri: のプロトコルが返す（独自プロトコルは使わない）。
 * - dev サーバー: そのまま返す。
 * - ビルド: dist/plugin-host/ に、元のバイト列のまま書き出す（名前にハッシュを付けない）。
 */
function pluginHostPlugin(): Plugin {
  const files = pluginHostFiles();
  return {
    name: 'plugin-host-files',
    configureServer(server) {
      server.middlewares.use('/plugin-host', (req, res, next) => {
        const name = (req.url ?? '').split('?')[0]?.replace(/^\//, '') ?? '';
        const entry = Object.hasOwn(files, name) ? files[name] : undefined;
        if (!entry) return next();
        res.setHeader('Content-Type', entry.type);
        res.setHeader('Cache-Control', 'no-store');
        res.end(readFileSync(entry.source));
      });
    },
    generateBundle() {
      for (const [name, entry] of Object.entries(files)) {
        this.emitFile({ type: 'asset', fileName: `plugin-host/${name}`, source: readFileSync(entry.source) });
      }
    },
  };
}

// Tauri の dev サーバーは固定ポートを期待する。
export default defineConfig({
  plugins: [react(), pluginHostPlugin()],
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
