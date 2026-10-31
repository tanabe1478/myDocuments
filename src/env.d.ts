/// <reference types="vite/client" />

// vite.config.ts の define で埋め込まれる。VITE_E2E=1 のビルドでだけ true。
// 本番ビルドでは false の定数になり、メモリ実装の DocumentBridge はバンドルから除かれる。
declare const __E2E__: boolean;
