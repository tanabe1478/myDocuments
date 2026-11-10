# タイピング音

## Sub-features

- SND-1: 同梱の部品「タイピング音」（ADR-005 の段 3、R9）。キーを押すたびに、CC0 の打鍵音（既定の音色キーボード: Unicae Games の Keyboard Soundpack #1 の単発 10 個）を Web Audio で鳴らす。既定はオフ。設定画面の「外観」の「執筆の補助」にチェック「タイピング音」、新しい「音」の節に音色（キーボード・タイプライター。既定はキーボード）と、その下に音量（小・中・大。既定は中）。コマンド「タイピング音の切り替え」はあるが、ショートカットはない。
- SND-5: 音色（R10）。「音」の節のラジオ「音色」。キーボードは R9 の音（10 個）、タイプライターは CC0 のタイプライターの録音（Cassie-OrbitGames）を柔らかく加工した 8 個。保存値は typingSoundTimbre（知らない値はキーボード）。鳴らす規則は両方の音色で同じ。オンのときは選んでいる音色の素材だけを fetch とデコードし、切り替えたときに新しい音色の素材を読む（読んだものは保持するので、戻しても読み直さない）。切り替えの直後の、デコード前のキーは鳴らなくてよい。音色ごとに gain（キーボード 1、タイプライター 1.15。素材の RMS を測ってそろえた）を音量の段階に掛ける。
- SND-6: 鳴り始めの位置（R10）。素材の頭の無音を飛ばすため、デコードのあと素材ごとに「振幅が最大値の 10% を最初に超える点の 2 ms 前」を求め、source.start(0, offset) で鳴らす（素材のバイト列は変えない）。AudioContext は latencyHint: 'interactive' で作る。keydown から start までに await、タイマー、requestAnimationFrame はない。
- SND-2: 鳴らすキーは、文字の入力になるキー（日本語入力の変換中の keydown、key が Process または keyCode が 229 のものを含む）、Space、Enter、Backspace、Delete、Tab。鳴らさないのは、修飾キーだけ、Cmd または Ctrl を伴うキー、矢印などの移動、Escape、ファンクションキー。押し続けた繰り返しは、全体で 30ms に 1 回に間引く。同時に鳴る音は 8 個まで。
- SND-3: 毎回、選んでいる音色の素材（キーボード 10 個、タイプライター 8 個）から無作為に選ぶ（直前と同じものは続かない）。高さ（再生速度）は ±4%、音量は ±10% 揺れる。Enter は再生速度が 0.8 前後で、少し低い。音量の段階は小 0.25、中 0.5、大 1.0 の gain。
- SND-4: オフの間は、素材の fetch も AudioContext の生成もしない。オンになると素材を fetch する。AudioContext の生成と resume は、最初の鳴らすキーの中で行い、そのキー自身はデコードが終わっていないので鳴らない。keydown は観察だけ（preventDefault しない）。失敗は例外として外へ出ず、鳴らないだけ。部品を外すときに AudioContext を閉じる。
- SND-7: アプリのログ（ADR-007、R14）への記録。設定「診断」の「ログを記録する」（既定はオフ。appearance-canvas.md の APP-11）がオンの間だけ、source typing-sound で記録する。AudioContext を作った（context.created: sample_rate、base_latency、output_latency、state）、statechange（context.statechange: from、to、current_time）、resume を頼んだ（resume.requested）とその結果（resume.result: ok、state、失敗なら error の名前）、素材の読み込みの失敗（fetch.failed: timbre、status、error）、デコードの結果（decode.result: timbre、ok、failed）、時計の止まりの疑い（clock.stalled: running のまま、前に見たときから 500ms 以上たつのに currentTime の進みが 4 分の 1 未満。続く間は 1 回、進めば clock.recovered）、devicechange（イベントが使える環境だけ）。鳴らすキーごとには書かず、鳴り方と、keydown から start までの同期の経路は変えない（currentTime の読み取りと比較だけを足した）。記録だけで、作り直しはしない。

## How to get to it (user POV)

- 設定画面（上部バー右の歯車 settings-button、または Mod+,）の「外観」の「執筆の補助」のチェック「タイピング音」と、「音」の節（settings-sound）のラジオ「キーボード」「タイプライター」（音色）と、「小」「中」「大」（音量）。
- 本文でのキー入力。日本語入力の変換中のキーも数える。
- 起動時の自動処理: 設定がオンで保存されていれば、起動時に、保存されている音色の素材の fetch を始める（AudioContext は最初のキーまで作らない）。

## Driving it with Playwright（メモリ bridge）

Preconditions: Launch 済みで Doctor が全 PASS。音の要求の数え方 window.__mdeE2ETypingSound（fetches、fetchedTimbres、contexts、decoded、decodedTimbres、decodedOffsets（音色ごとの、素材の鳴り始めの位置の秒）、decodedCount、requests。requests の要素は kind、timbre、index、rate、gain、offset（source.start に渡した位置の秒）、startDelayMs（keydown を受け取ってから start を呼ぶ直前までのミリ秒）、baseLatency、outputLatency）は、e2e のビルドだけにある。本番の dist には入らない（check-probe-absent.mjs が印 `__mdeE2ETypingSound` を見る）。数えるのは「鳴らす要求を出した」ところまでで、実際の音は確かめない。

| シナリオ | user action | 観測できる結果 |
|---|---|---|
| typing-sound.json | 既定（オフ）のまま入力し、設定画面でタイピング音をオンにして音量を大にし、本文でキーを押す。再読み込みして設定画面を開く | オフの間は、fetches、contexts、requests がすべて 0（fetchedTimbres、decodedTimbres は空）。オンにすると fetches が 1（fetchedTimbres は keyboard、contexts は 0）。最初のキーで decoded が 1、decodedCount が 10（このキーの要求はない）。次のキーで要求が 1。修飾キーだけ、移動、Escape、Mod+A は要求を増やさない。Enter は kind が enter で rate が 0.8 前後、gain は大の 1.0 前後。本文は `- 一つ目a\n- xb\n- `（オフの間に押した a と Enter、オンのあとの x と b と Enter。リストの継続が変わらない）。再読み込み後も、チェックと音量（大）が残る |

| typing-sound-timbre.json | オンで起動し（音色は既定のキーボード）、設定画面の「音」の節を開く。キーを押してから、ラジオ「タイプライター」、続けて「キーボード」を選び、そのつどキーを押す。再読み込みして設定画面を開く | 「音」の節の見出しの並びは音色、音量。ラジオは keyboard（選択済み）、typewriter、low、medium（選択済み）、high。起動時の fetchedTimbres は keyboard だけ。最初のキーで decodedCount が 10、次のキーで要求が 1（timbre は keyboard、startDelayMs は 5 未満）。タイプライターを選ぶと typingSoundTimbre が typewriter で保存され、fetchedTimbres が keyboard、typewriter になり（fetches は 2）、decodedCount が 8 になる。次のキーの要求の timbre は typewriter（index は 8 未満）。キーボードに戻すと fetches は 2 のまま、次のキーの timbre は keyboard。再読み込み後の音色はキーボード |

```
node .pi/skills/verify-mydocuments/scripts/drive.mjs --run-id <run-id> --scenario .pi/skills/verify-mydocuments/features/scenarios/typing-sound.json
node .pi/skills/verify-mydocuments/scripts/drive.mjs --run-id <run-id> --scenario .pi/skills/verify-mydocuments/features/scenarios/typing-sound-timbre.json
```

- 間引き（30ms）、同時の上限、無作為の選び方、日本語入力の変換中のキーの数え方は、単体テスト（src/features/typing-sound/）と tests/e2e/typing-sound.spec.ts が確かめる（この Skill のシナリオには含めない。実 IME は未確認）。
- 素材ごとの鳴り始めの位置（decodedOffsets）が、WAV の標本から求めた期待値と一致すること、keydown から start までが 5 ms 未満であること、AudioContext が latencyHint 'interactive' で作られること、タイプライターの素材だけが fetch されること（ネットワークの要求のファイル名）は、tests/e2e/typing-sound.spec.ts が確かめる（Playwright の chromium。WebKit でも同じテストが通ることは、設定のファイルを repo の外に置いて確かめた）。
- 本番の dist には、WAV がちょうど 18 個（キーボード 10、加工後のタイプライター 8）あり、元の録音（sounds/typewriter/original/）は入らない。確かめは check-probe-absent.mjs（dist/assets の WAV の数と名前を見る）、`ls dist/assets/*.wav | wc -l` と、リポジトリ直下の scripts フォルダの make-typewriter-sounds.mjs を `--check` 付きで node に渡す実行（加工後の 8 個が元から作り直せること）。
- 保存・読み込みの実体は Rust 側（crates/docio）。メモリ bridge は、同じタブでの再読み込みで設定を読み直す。
- ログ（SND-7）の確かめ方: seed の preferences に appLog: true と typingSound: true を入れて起動し、最初のキーのあと、window.__mdeE2E.logging.entries の source が typing-sound の行を読む（渡されるまで 1 秒ほど。expect の timeout で待つ）。context.created と decode.result（ok が 10、failed が 0）は、最初のキーのあとに出る。時計の止まり、statechange、resume、devicechange、素材の失敗は、本物の AudioContext に包みを被せたり、route で素材の応答を差し替えたりするので、tests/e2e/app-log.spec.ts が確かめ、シナリオには含めない。appLog がオフ（既定）なら、window.__mdeE2E.logging.appendLogCalls は 0 件のまま。

## Gotchas

- ログ（SND-7）の時計の止まりは、鳴らすキーの間隔が 500ms 以上空いたときに比べる。e2e の chromium では、AudioContext の currentTime を止める包みで模したもので、WKWebView で実際に止まる条件は未確認。

- 鳴らす要求を数えるシナリオは、最初に 1 回キーを押して、decoded が 1 になるのを待つ。待たずに数え始めると、最初のキーが鳴らないので、数が 1 つ足りない。
- 要求は 30ms に 1 回までに間引かれる。連続して押すシナリオは、キーの間に wait（60ms 程度）を置く。固定の待ちは間引きの間隔を空けるためだけに使い、結果の待ちには expect の timeout を使う。
- Playwright の chromium は --mute-audio で起動する。音が出ないことは、鳴らす要求が出ていないことを意味しない（requests で見る）。実際に聞こえるかは、Tauri の窓（WKWebView）、Windows と Linux の WebView を含め、この Skill では未確認。
- 鳴り始めの位置で縮むのは、素材の頭の無音の分だけ。出力の遅延（baseLatency、outputLatency、OS とオーディオ機器）は縮まず、e2e の chromium と webkit では実際の出力に届かないので測れない。Tauri の窓（WKWebView）で耳に分かる遅れが残るかは未確認。
- スピーカーから音を出す確認（afplay、実際の再生）はしない。
- 設定画面を開いたままでは、本文のキーは数えない（数えるのは本文の中の keydown だけ）。設定を変えたら Escape または閉じるボタン（settings-close）で閉じて、本文にフォーカスを戻してから押す。WebKit は、ラジオをクリックしてもフォーカスが移らず、Escape が設定画面に届かないので、閉じるボタンを使う。
- 「音」の節のラジオは、音色と音量の 2 組。checked の取得は name（typing-sound-timbre、typing-sound-volume）で絞る。`input[type=radio]:checked` だと最初の組（音色）になる。
- 音色を切り替えた直後のキーは、新しい音色のデコードが終わるまで鳴らない。decoded（decodedTimbres）が増えるのを待ってから数える。
- decodedOffsets は、ブラウザがデコードで標本化周波数を変えたあとの標本から求める。キーボードの素材は WAV から求めた値と 0.5 ms 以内で一致するが、タイプライターの素材は頭の雑音が最大値の 10% 近くにあり、変換の行き過ぎで最大 2.1 ms 早まる（chromium と webkit で同じ）。
