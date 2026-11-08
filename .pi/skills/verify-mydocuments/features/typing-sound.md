# タイピング音

## Sub-features

- SND-1: 同梱の部品「タイピング音」（ADR-005 の段 3、R9）。キーを押すたびに、CC0 の打鍵音（Unicae Games の Keyboard Soundpack #1 の単発 10 個）を Web Audio で鳴らす。既定はオフ。設定画面の「外観」の「執筆の補助」にチェック「タイピング音」、新しい「音」の節に音量（小・中・大。既定は中）。コマンド「タイピング音の切り替え」はあるが、ショートカットはない。
- SND-2: 鳴らすキーは、文字の入力になるキー（日本語入力の変換中の keydown、key が Process または keyCode が 229 のものを含む）、Space、Enter、Backspace、Delete、Tab。鳴らさないのは、修飾キーだけ、Cmd または Ctrl を伴うキー、矢印などの移動、Escape、ファンクションキー。押し続けた繰り返しは、全体で 30ms に 1 回に間引く。同時に鳴る音は 8 個まで。
- SND-3: 毎回、10 個から無作為に選ぶ（直前と同じものは続かない）。高さ（再生速度）は ±4%、音量は ±10% 揺れる。Enter は再生速度が 0.8 前後で、少し低い。音量の段階は小 0.25、中 0.5、大 1.0 の gain。
- SND-4: オフの間は、素材の fetch も AudioContext の生成もしない。オンになると素材を fetch する。AudioContext の生成と resume は、最初の鳴らすキーの中で行い、そのキー自身はデコードが終わっていないので鳴らない。keydown は観察だけ（preventDefault しない）。失敗は例外として外へ出ず、鳴らないだけ。部品を外すときに AudioContext を閉じる。

## How to get to it (user POV)

- 設定画面（上部バー右の歯車 settings-button、または Mod+,）の「外観」の「執筆の補助」のチェック「タイピング音」と、「音」の節（settings-sound）のラジオ「小」「中」「大」。
- 本文でのキー入力。日本語入力の変換中のキーも数える。
- 起動時の自動処理: 設定がオンで保存されていれば、起動時に素材の fetch を始める（AudioContext は最初のキーまで作らない）。

## Driving it with Playwright（メモリ bridge）

Preconditions: Launch 済みで Doctor が全 PASS。音の要求の数え方 window.__mdeE2ETypingSound（fetches、contexts、decoded、decodedCount、requests。requests の要素は kind、index、rate、gain）は、e2e のビルドだけにある。本番の dist には入らない（check-probe-absent.mjs が印 `__mdeE2ETypingSound` を見る）。数えるのは「鳴らす要求を出した」ところまでで、実際の音は確かめない。

| シナリオ | user action | 観測できる結果 |
|---|---|---|
| typing-sound.json | 既定（オフ）のまま入力し、設定画面でタイピング音をオンにして音量を大にし、本文でキーを押す。再読み込みして設定画面を開く | オフの間は、fetches、contexts、requests がすべて 0。オンにすると fetches が 1（contexts は 0）。最初のキーで decoded が 1、decodedCount が 10（このキーの要求はない）。次のキーで要求が 1。修飾キーだけ、移動、Escape、Mod+A は要求を増やさない。Enter は kind が enter で rate が 0.8 前後、gain は大の 1.0 前後。本文は `- 一つ目a\n- xb\n- `（オフの間に押した a と Enter、オンのあとの x と b と Enter。リストの継続が変わらない）。再読み込み後も、チェックと音量（大）が残る |

```
node .pi/skills/verify-mydocuments/scripts/drive.mjs --run-id <run-id> --scenario .pi/skills/verify-mydocuments/features/scenarios/typing-sound.json
```

- 間引き（30ms）、同時の上限、無作為の選び方、日本語入力の変換中のキーの数え方は、単体テスト（src/features/typing-sound/）と tests/e2e/typing-sound.spec.ts が確かめる（この Skill のシナリオには含めない。実 IME は未確認）。
- 保存・読み込みの実体は Rust 側（crates/docio）。メモリ bridge は、同じタブでの再読み込みで設定を読み直す。

## Gotchas

- 鳴らす要求を数えるシナリオは、最初に 1 回キーを押して、decoded が 1 になるのを待つ。待たずに数え始めると、最初のキーが鳴らないので、数が 1 つ足りない。
- 要求は 30ms に 1 回までに間引かれる。連続して押すシナリオは、キーの間に wait（60ms 程度）を置く。固定の待ちは間引きの間隔を空けるためだけに使い、結果の待ちには expect の timeout を使う。
- Playwright の chromium は --mute-audio で起動する。音が出ないことは、鳴らす要求が出ていないことを意味しない（requests で見る）。実際に聞こえるかは、Tauri の窓（WKWebView）、Windows と Linux の WebView を含め、この Skill では未確認。
- スピーカーから音を出す確認（afplay、実際の再生）はしない。
- 設定画面を開いたままでは、本文のキーは数えない（数えるのは本文の中の keydown だけ）。設定を変えたら Escape で閉じて、本文にフォーカスを戻してから押す。
