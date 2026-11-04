/// <reference types="vite/client" />

// vite.config.ts の define で埋め込まれる。VITE_E2E=1 のビルドでだけ true。
// 本番ビルドでは false の定数になり、メモリ実装の DocumentBridge はバンドルから除かれる。
declare const __E2E__: boolean;

// vite.config.ts の define で埋め込まれる。VITE_ISOLATION_PROBE=1 のビルド（隔離の検証用。ADR-005 の R5）でだけ true。
// 本番ビルドでは false の定数になり、検証用の段 2 の部品はバンドルから除かれる。
declare const __ISOLATION_PROBE__: boolean;
