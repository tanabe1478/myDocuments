import { defineConfig } from '@playwright/test';

// VITE_E2E=1 でビルドした Web UI（メモリ実装の DocumentBridge を持つ）に対して実行する。
// 本番ビルド（Tauri）には VITE_E2E を渡さないので、メモリ実装は含まれない。
const PORT = 4173;
const viewport = { width: 1280, height: 800 };

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 30_000,
  expect: { timeout: 5_000 },
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: 'off',
  },
  // devices['Desktop Chrome'] は UA を Windows に上書きする。アプリは navigator.platform で
  // Cmd / Ctrl を切り替えるため、上書きするとテストの ControlOrMeta（ホスト OS 基準）と食い違う。
  // そこで、platform は metadata.platform で明示し、tests/e2e/helpers.ts の page fixture が
  // アプリの読み込み前に navigator.platform などを偽装する（UI-10: OS ごとの標準ショートカット）。
  // chromium はホスト OS のまま。chromium-mac / -windows / -linux は偽装で、どのホストでも 3 OS 分を確認できる。
  projects: [
    { name: 'chromium', use: { browserName: 'chromium', viewport } },
    ...(['mac', 'windows', 'linux'] as const).map((platform) => ({
      name: `chromium-${platform}`,
      metadata: { platform },
      use: { browserName: 'chromium' as const, viewport },
    })),
  ],
  webServer: {
    command: 'npm run build:e2e && npm run serve:e2e',
    url: `http://127.0.0.1:${PORT}`,
    env: { VITE_E2E: '1' },
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
