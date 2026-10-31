// Build config for the Phase 0 harness page. Run from phase0/vendor/MDE so that
// MDE's own vite / node_modules are used:
//   cd phase0/vendor/MDE && npx vite build --config ../../harness/vite.config.mjs
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const mdeModules = resolve(here, '../vendor/MDE/node_modules');

export default {
  root: here,
  base: './',
  logLevel: 'warn',
  resolve: {
    alias: {
      // harness.ts lives outside MDE, so point its bare imports at MDE's install.
      '@tauri-apps/plugin-fs': resolve(mdeModules, '@tauri-apps/plugin-fs'),
    },
  },
  server: { fs: { strict: false } },
  build: {
    outDir: resolve(here, 'dist'),
    emptyOutDir: true,
    target: 'es2022',
    chunkSizeWarningLimit: 5000,
  },
};
