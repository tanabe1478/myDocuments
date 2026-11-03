import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// Tauri の dev サーバーは固定ポートを期待する。
export default defineConfig({
  plugins: [react()],
  // VITE_E2E=1 のビルドでだけ、メモリ実装の DocumentBridge を含める（src/platform/index.ts）。
  define: { __E2E__: JSON.stringify(process.env.VITE_E2E === '1') },
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
