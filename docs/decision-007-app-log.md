# ADR-007: アプリのログ基盤（設定で有効にする JSON Lines のログ）

## Status

Accepted（2026-11-10、承認者: プロジェクトオーナー）。実機で、タイピング音がたまに鳴らなくなり、アプリの再起動で戻る、という不具合が出た。コードを読んだだけでは原因を特定できなかった（候補は、WKWebView の AudioContext が running のまま音を出さなくなること、素材の読み込みかデコードの失敗）。次に起きたとき、原因を後から知れるように、ログの基盤を作る。タイピング音の鳴り方の修正（作り直しや再試行）は、この ADR の範囲ではない（次の Run）。

R16（2026-11-11）で、「性能の計測」の節を足した。実機で、時間がたつと重い感じがし、タイピング音だけが打鍵から遅れて鳴る（文字の表示は遅れない。再起動で直る）という不具合が出た。R14 のログは、失敗と状態の変化しか書かないので、どこが遅くなったかは分からなかった。

## Context

この ADR の前には、ログの仕組みがなかった。`src/` に `console` の呼び出しは 0 件で、Rust 側にもログの crate がない。失敗を `catch {}` で捨てている箇所が 20 ある。実機の窓（WKWebView）には、利用者が開発者ツールを開いて見る習慣もない。不具合の瞬間の状態（AudioContext の state、素材の読み込み、時計）は、再起動すると消える。

## Decision

### 目的

実機での不具合の原因を、あとから知る。リアルタイムの監視や、利用状況の収集ではない。

### 有効にする方法

設定画面の最後の節「診断」の「ログを記録する」。既定はオフ。オフの間、本体のロガーは何もためず、ネイティブ側へ appendLog を呼ばない。ネイティブ側も、オフの間に呼ばれても何も書かない（二重の守り）。

保存は、ほかの設定と同じ preferences.json の最上位の真偽値 `appLog`。起動時に、保存済みの値を、部品を読み込む前にネイティブ側（`set_logging`）と本体のロガーへ伝える。設定を変えたときも同じ。オフにしたときは、ためていた分を捨てる。ネイティブ側が有効になる前にログを渡すと捨てられるので、有効にするときは、ネイティブ側の切り替えが済んでから本体のロガーを有効にする。

### 置き場所

Tauri の `app_log_dir()`の下の `app.log`。macOS では `~/Library/Logs/io.github.tanabe1478.immersive-markdown-editor/app.log`。ほかの OS は、OS のログのフォルダ（識別子の名前のフォルダ）で、設定画面は、その言い方で案内する（Windows と Linux の実際のパスは、この Run では確かめていない）。ディレクトリがなければ作る。

### 形式

JSON Lines。1 行 1 件で、キーの並びは固定。

```
{"t":"2026-11-10T04:47:40.375Z","level":"warn","source":"typing-sound","event":"clock.stalled","data":{"advance_ms":0,"elapsed_ms":612,"state":"running"}}
```

- t: UTC の ISO 8601（ミリ秒まで）。Rust が書く時に付ける。本体のロガーは 1 秒ごとにまとめて渡すので、本体の出来事の時刻は、実際より最大 1 秒ほど遅い。
- level: info、warn、error のどれか。
- source と event: `[a-z0-9._-]` の 1 から 64 文字。
- data: 20 項目までのオブジェクト。値は数値、真偽値、null、500 文字までの文字列だけ。キーも source と同じ規則（このため、キーは `elapsed_ms` のように小文字と `_` で書く）。

入力の検査は Rust 側でも行う。1 回に 100 件まで。level、source、event が合わない項目は捨て、data は、合わない項目だけを捨てる（エラーで止めない）。

### 残す量

app.log が 1 MiB 以上なら、書く前に app.log.1 へ移す（既存の app.log.1 は置き換える）。残るのは app.log と app.log.1 の 2 世代、合わせて約 2 MiB まで。

本体のロガーは、次の守りを持つ。

- 1 秒ごと（最初の 1 件から 1 秒後）に、まとめて渡す。pagehide のときは、すぐ渡す。
- ためるのは 200 件まで。あふれた分は捨て、件数だけを `logging.dropped`（count）の 1 件にして、次の渡しに足す。
- 同じ source と event は、1 分に 10 件まで。超えた分は捨て、次に記録できたとき、省いた件数を `suppressed` で添える。

書き込みの失敗は無視する。コマンドは常に成功を返し、アプリの動作に影響しない。

### 書かないもの

- 本文（文書の中身）。
- ファイルのパス。文書の失敗は、操作の名前とエラーの種類（`BridgeError` の kind、Error の name）だけで、メッセージも書かない。
- 例外の記録は、種類と、300 文字までに切ったメッセージ、発生したファイル名（ベース名。URL でもパスでもない）と行。メッセージなどの文字列の中の、ホームディレクトリ（`/Users/<名前>/`、`/home/<名前>/`、`C:\Users\<名前>\`）は `~` に置き換える。
- 鳴らすキーごとの記録。タイピング音は、状態が変わったとき、失敗、疑いのときだけ書く。キーの内容は書かない。

### 記録するもの（有効のときだけ）

| source | event | level | data |
| --- | --- | --- | --- |
| rust | start | info | version、os、arch。無効から有効になったとき、Rust が 1 行書く |
| rust | panic | error | message、file、line。有効の間だけ。既定のパニックの処理は残す（ホームのパスは `~`） |
| app | start | info | user_agent（WebKit の版がわかる）、visibility。起動時にオンだったとき |
| app | logging-enabled | info | 同上。設定でオンにしたとき |
| app | uncaught-error | error | error、message、file、line、column。window の error |
| app | unhandled-rejection | error | error、message。unhandledrejection |
| app | visibility | info | state（hidden、visible） |
| app | clock-jump | warn | jump_seconds、elapsed_seconds、visibility。10 秒ごとに時刻を見て、予定より 30 秒以上進んでいたとき（スリープからの復帰の目印。窓が隠れてタイマーが間引かれたときも出るので visibility を添える。有効の間だけ動く） |
| document | open-failed、save-failed、save-as-failed、draft-write-failed | error | op、error、kind |
| plugin | stopped | error | id、reason。部品が止められたとき（例外、時間切れ、不正なメッセージ。解除は含めない） |
| typing-sound | context.created | info | sample_rate、base_latency、output_latency、state、reason（R16。first-key、after-setting-off、after-closed） |
| typing-sound | context.closed | info | reason（setting-off、dispose）、from（閉じる前の state）、current_time（R16） |
| typing-sound | output.latency | info | estimate_ms、timestamp_age_ms、base_latency_ms、output_latency_ms、state。1 分に 1 回まで（R16） |
| typing-sound | output.latency-high | warn | 上と同じ項目と threshold_ms。見積もりが 150 ms を超えたとき、続く間は 1 分に 1 回まで（R16） |
| typing-sound | context.statechange | info | from、to、current_time |
| typing-sound | resume.requested | info | state、skipped。running でないキーで resume を頼んだとき。状態が続く間は、最初の 1 回と、以後 5 秒に 1 回 |
| typing-sound | resume.result | info、warn | ok、state、失敗なら error（名前）。成功しても state が running でないことがあるので、state を残す |
| typing-sound | fetch.failed | warn | timbre、status（HTTP の状態。なければ null）、error |
| typing-sound | decode.result | info、warn | timbre、ok、failed、失敗があれば error（最初の名前） |
| typing-sound | clock.stalled | warn | elapsed_ms、advance_ms、state |
| typing-sound | clock.recovered | info | elapsed_ms、advance_ms、state |
| typing-sound | devicechange | info | state、output_latency |

時計の止まりの疑いは、鳴らすキーのとき、state が running で、前に見たときから 500 ms 以上たっているのに、currentTime の進みがその経過の 4 分の 1 に満たなければ、warn を 1 回書く。止まりが続く間は書かず、進むようになったら clock.recovered を書く。state が running でなくなったとき（resume のあとを含む）は、比べ直しの基準を取り直す。記録だけで、AudioContext の作り直しはしない。壁の時計には、既存の `now`（`performance.now`）を使う。スリープ中に進まないので、復帰直後を止まりと見違えにくい。

### 見方

```
tail -f ~/Library/Logs/io.github.tanabe1478.immersive-markdown-editor/app.log
jq -c 'select(.level != "info")' ~/Library/Logs/io.github.tanabe1478.immersive-markdown-editor/app.log
jq -c 'select(.source == "typing-sound")' app.log
```

タイピング音が鳴らなくなったときは、まず `context.statechange`（running のあとに suspended や interrupted があるか）、`resume.result`（ok でも state が running に戻らないか）、`clock.stalled`（running のまま時計が止まったか）、`fetch.failed` と `decode.result`（素材が読めたか）の順に見る。

### 部品がロガーを使う形

同梱の段 3 の部品（エディタの中の拡張）だけが使える。plugin-api の `PluginContext` に `log(level, event, data?)` を足した。source は、レジストリが部品の id に固定する。段 2 の部品（Worker）には貸さない（`IsolatedServices` に足していない。隔離した iframe は、ネイティブのコマンドも呼べない。capabilities は main の窓だけ）。

`src/features/` の部品が `src/logging/` を直接 import する形は取らなかった。既存の縛り（部品は plugin-api と CodeMirror だけを import する。architecture テスト）を緩めずに済み、ロガーの置き場所も部品が知らなくてよい。ログが無効の間や、レジストリにログの受け口がない環境では、`ctx.log` は何もしない。例外は出さない。

### やらないこと

- ログを外へ送る（ネットワークへ出さない）。
- 設定画面に、ログを開くボタンや、ログを見る画面を付ける。
- タイピング音の振る舞いの修正（作り直し、再試行）。この ADR は記録だけで（R16 で、設定のオフとオンでの作り直しだけを入れた。下の「性能の計測（R16）」）、鳴り方（音色、音量、鳴らすキー、間引き、同時の上限、鳴り始めの位置、latencyHint）と、keydown から source.start までの同期の経路を変えない（currentTime の読み取りと比較だけを足した）。
- ログの検索、集計、古いファイルの自動削除（2 世代で上限が決まる）。

### 依存を足さなかった理由（tauri-plugin-log と比べて）

tauri-plugin-log（Rust の `log` crate と、JavaScript 向けの `@tauri-apps/plugin-log`）を使う案もあった。この Run では crate の中身を読んでおらず、比べたのは、公開されている説明からの理解にとどまる（未確認）。

- この用途に必要なのは、JSON Lines の追記、1 MiB で 2 世代、入力の検査、有効・無効の切り替えで、自前では 1 つのファイル（`src-tauri/src/logging.rs`）で書ける。時刻の整形も、std の SystemTime から行える。
- プラグインの JavaScript 向けのコマンドは、capabilities に許可を足す必要があり、本体の窓から広い書き込みの口が開く。このアプリは、自前のコマンドだけを許可し、opener や clipboard-manager も Rust の API だけを使う方針（ADR-005 の R6）を取っている。ログも、同じ作りにそろえた。
- 無効の間に何も書かない、検査に外れた項目を捨てる、という規則を、依存の設定に頼らず、自分のテストで縛れる。
- Cargo.toml、Cargo.lock、package.json、package-lock.json は変えていない（検査は deps-unchanged）。

## 確かめたこと

- Rust の単体テスト（一時ディレクトリだけに書く）: 追記、時刻の整形（うるう日、年の境）、1 MiB での移し替えと 2 世代、検査で捨てる項目、無効の間は書かない、書けない場所でも Err にならない、有効になったときの起動の行、パニックのフック（既定のフックも呼ばれる）、許可の作り（capabilities と生成物）。
- TypeScript の単体テスト: ロガーのまとめ、上限、回数の制限、ホームのパスの置き換え、無効の間は何もしないこと、切り替えの順序、例外・visibilitychange・時計の飛び、タイピング音の各記録（偽の AudioContext）、文書の失敗の記録、部品の停止、architecture（コマンドの呼び出しはブリッジだけ、依存なし、隔離した部品に口がない）。
- e2e（chromium と chromium-windows）: 既定では appendLog が 1 回も呼ばれないこと、設定の節とオン・オフ、起動と例外と visibilitychange と時計の飛び（Playwright の clock）、文書の失敗、部品の停止、本文の目印とパスが出ないこと、タイピング音の各記録（本物の AudioContext に、時計を止められる包みを被せる）。メモリ bridge が、ネイティブ側の代わりに、渡された値を window.__mdeE2E.logging に残す。

## 性能の計測（R16）

### 目的

どこの処理が、いつから重くなったかを、あとで知る。APM（アプリケーション性能の監視）のように、区間ごとの所要時間を残す。リアルタイムの表示や、外への送信ではない。ログ（設定「ログを記録する」）がオンの間だけ動く。

### 区間の使い方と一覧

本体は `perf.span(名前)`（戻り値を呼ぶと終わる。非同期の往復にも使える）、`perf.measure(名前, 関数)`（同期。例外はそのまま投げ直す）、`perf.record(名前, ms)` で区間を数える（src/logging/perf.ts）。名前は `[a-z0-9._-]` の 1 から 64 文字で、合わない名前は数えない。同梱の段 3 の部品には、R14 の ctx.log と同じく、PluginContext の `ctx.perf` として貸す（部品は本体の内部を import しない。段 2 の Worker と隔離した iframe には貸さない）。

| 区間 | 始まりと終わり |
| --- | --- |
| input.keydown-to-update | 本文の中の keydown（capture）から、本文を変える CodeMirror の更新が済むまで。数えるのは、修飾キーなしの 1 文字（Shift は可）と Enter、Backspace だけ。起点は、ブラウザがイベントを受けた時刻（event.timeStamp。使えない値なら今）で、処理の前に待たされた分も含む |
| input.keydown-to-paint | 同じ keydown から、次のフレームの描画のあとの最初のタスクまで（rAF のあとに MessageChannel で 1 回待つ。perf/ の入力から描画までと同じ定義）。窓が隠れているとき（描画が止まる）は数えない。待つ keydown は 64 件まで |
| input.composition-to-update | IME の変換中の compositionupdate から、本文の更新が済むまで。変換中の keydown は、上の 2 つに数えない |
| markdown.decorations | Markdown の見た目の部品の、行の装飾と記号の隠し方の組み立て全体（ViewPlugin の update） |
| markdown.live-markup | そのうち、隠す記号とリンクの範囲を決める部分（構文木を読む） |
| markdown.table-display | 表の表示（表の検出と装飾）の組み立て |
| feed.publish | 本文とカーソルの位置を部品に届ける処理（documentFeed の publish。入力が止まって 200 ms 後、文書の切り替え） |
| plugin-host.run | Worker の部品への実行の要求（コマンド、メニュー）から、done が返るまでの往復。止まった、時間切れの実行は数えない。確認の画面を出している間の時間も入る（時間切れの計測は止まるが、この区間は止まらない）。本文やカーソルの位置を届ける一方向のメッセージと、部品が本体を呼ぶ call（確認の画面の待ちが入る）は数えない |
| bridge.<コマンド名> | DocumentBridge のコマンドの往復。名前はメソッド名のスネークケース（saveDocument は bridge.save_document）。引数と戻り値は読まない。数えないのは、appendLog 自身（ログを書くたびに区間が増えないように）、ファイルや画像を選ぶダイアログ、通知の購読、窓の操作。saveSession は、読んでから書くので 2 つのコマンドの合計。メモリ bridge（e2e）も同じ名前で数える |
| document.save | 保存（書き込みの要求から、結果を状態に反映するまで。別名保存は、ダイアログのあと） |
| document.draft-write | 草稿の書き込み（writeDraft の往復のみ。順番待ちは含めない） |
| sound.start-delay | タイピング音。鳴らすキーを受け取ってから、source.start を呼ぶ直前まで（player の now の差。keydown のイベントの時刻ではなく、player が受け取った時刻から） |

### まとめの行

1 分ごとに、その間に 1 回でも起きた区間ごとに 1 行。区間の数は 32 まで（超えた名前は other にまとまる）。

```
{"t":"2026-11-11T01:01:03.100Z","level":"info","source":"perf","event":"input.keydown-to-update","data":{"count":98,"p50_ms":1.0,"p95_ms":3.3,"max_ms":9.9,"total_ms":120.5,"slow":0}}
```

- event は区間の名前そのもの。既存のロガーの回数の制限（同じ source と event は 1 分に 10 件）は source と event ごとなので、区間どうしで数えが混ざらず、1 区間のまとめは 1 分に 1 行で、制限に掛からない。
- p50_ms と p95_ms は、固定のバケツ（0.1 ms から 1.1 倍ずつ、141 個。標本は全部ためない）の上端で、最大を超えない。実際の値より最大で約 10% 大きく出る。max_ms と total_ms は実測。値は小数 1 桁。slow は、その 1 分に 50 ms 以上かかった回数。
- 1 分の間に 1 回も起きなかった区間は書かない。窓が隠れてタイマーが間引かれると、行の間隔は 1 分より長くなる。
- pagehide のときは、その時点までの分を書いて、すぐ渡す（1 分に満たない起動でも、行が残る）。

### 50 ms 以上の記録

1 回で 50 ms 以上かかった区間は、その場で warn を 1 件（`{"source":"perf-slow","event":"<区間の名前>","data":{"ms":61.4}}`）。区間ごとに 1 分に 5 件まで（回数の制限 10 より小さくしてある）。残りは、まとめの行の slow に数だけ残る。名前が上限を超えた区間は、event が other になる。

### 量の推移と画面の止まり

1 分ごとに 1 行ずつ（source は perf-system）。

- gauges: doc_chars（本文の文字数）、doc_lines（行数）、dom_nodes（DOM の要素の数）、heap_used_mb（JS のメモリ。performance.memory がある環境だけで、なければ null。WKWebView にあるかは未確認）。本文とパスは書かない。
- frames: requestAnimationFrame で見た描画の間隔。frames（数えたフレームの数）、stalls（間隔が 50 ms を超えた回数）、max_ms（最大の間隔）。窓が隠れている間は、見張りを止め、戻ったあとの最初のフレームは基準にするだけで数えない。フレームを 1 つも数えなかった 1 分は書かない。

### オフの間のふるまい

ログがオフの間（既定）は、`perf.enabled` が false で、span は何もしない共通の関数を返し、measure は関数をそのまま呼ぶだけ。時計（performance.now）は読まず、ためず、1 分のタイマー、窓の見え方と pagehide のリスナー、requestAnimationFrame の見張りも動かさない。入力の計測（keydown、compositionupdate のリスナー）は、リスナー自体は付くが、最初に `perf.enabled` を見て戻るだけ。ブリッジの包みも、無効の間は元のメソッドをそのまま呼ぶ（Promise も足さない）。ログがオンになったときに始まり、オフになったときに全部止めて、ためていた分を捨てる（単体テストで確かめている）。

### 負荷の確かめ

オンにしたときの入力の処理時間（keydown の timeStamp から、本文の更新の通知の直後まで。perf/lib/inpage.mjs の入力の処理時間と同じ定義）を、tests/e2e/perf-log.spec.ts が、同じページで、オフ、オン、オフ、オンの順に 150 打鍵ずつ測って比べる（暖機 40 打鍵、切り替え直後の 20 打鍵は捨てる。400 行の文書。Playwright の chromium、macOS）。この Run の測定では、オフとオンの差は、中央値で 0 から 0.2 ms、p95 で -0.1 から 0.5 ms だった（例: 中央値 0.9 ms 対 1.1 ms、p95 1.4 ms 対 1.9 ms）。テストは、増加が中央値で 3 ms 未満、p95 で 10 ms 未満であることを見る。1 回の実行の数字で、環境の負荷で揺れる。WKWebView での増加は未確認。

### 音の遅れの見積もり

タイピング音の遅れは、文字の表示とは別に、AudioContext の出力側で起きていると疑っている。確かめる手がかりとして、鳴らすキーのとき、`getOutputTimestamp()` があれば、1 秒に 1 回まで読む。

- estimate_ms: `(currentTime - contextTime) * 1000`。AudioContext が描いている位置と、いま出力されている位置の差。
- timestamp_age_ms: `performance.now() - performanceTime`。その出力の位置が、どれだけ古いか。estimate_ms には、この古さの分も入っているので、一緒に読む。
- base_latency_ms、output_latency_ms: AudioContext が自己申告する値（ms）。
- 1 分に 1 回、output.latency（info）。見積もりが 150 ms を超えたら、その場で output.latency-high（warn。続く間は 1 分に 1 回まで）。
- 読み取りと計算だけで、await を挟まない。ログの書き込みは source.start のあと。作り直しはしない。出力がまだ始まっていない値（contextTime と performanceTime が 0）は、見積もらない。

限界: Playwright の chromium で値が出ることは確かめた（音は --mute-audio で出ない）。Playwright の WebKit で getOutputTimestamp が返ることは、計画の段階で、音を鳴らさずに確かめてある（この Run では再確認していない）。実機の WKWebView で、この値が聞こえる遅れを反映するかは未確認。150 ms は、実機のデータなしで決めた値。

### R14 の注記の修正

- N1: ロガーが、data に suppressed を足すとき、渡された項目が 20 あると 21 項目になり、Rust 側の上限（20）を超えていた。足す分を 1 項目残して切る（渡された項目は 19 まで。残りの 1 つが suppressed）。
- N2: 時計の止まりの検査のログの書き込みが source.start より前にあった。検査（currentTime の読み取りと比較）は今のままで、ログの書き込みだけを、source.start のあとに回した（鳴らさずに戻る場合も、戻る前に書く）。

### 手で直す手段（設定のオフとオン）

設定のタイピング音をオフにすると、AudioContext を閉じる（context.closed、reason は setting-off）。オンにして最初に鳴らすキーで、作り直す（context.created、reason は after-setting-off）。素材のバイト列は取り直さず、デコードだけを、新しい AudioContext でやり直す。拡張が state から外れたことで見分ける（文書を開き直したときの state の作り直しでは、拡張が残るので閉じない）。音色と音量の切り替えでは、作り直さない。最初の AudioContext の context.created の reason は first-key、外から閉じられた AudioContext を作り直したときは after-closed。自動の回復（しばらく打たなかったら作り直す、など）は、この ADR の範囲ではない。

### ログの読み方

区間ごとの p95 の推移（jq）:

```
jq -r 'select(.source=="perf") | "\(.t[11:16]) \(.event) p95=\(.data.p95_ms) n=\(.data.count)"' app.log
```

Python の 1 行（区間ごとに、時刻=p95 を並べる）:

```
python3 -c "import json,sys,collections as c; d=c.defaultdict(list); [d[e['event']].append(e['t'][11:16]+'='+str(e['data']['p95_ms'])) for e in map(json.loads, sys.stdin) if e['source']=='perf']; [print(k, *v) for k,v in sorted(d.items())]" < app.log
```

50 ms 以上の記録、量の推移、画面の止まり、音の遅れの見積もり:

```
jq -c 'select(.source=="perf-slow")' app.log
jq -r 'select(.event=="gauges") | "\(.t[11:16]) dom=\(.data.dom_nodes) heap=\(.data.heap_used_mb) lines=\(.data.doc_lines)"' app.log
jq -r 'select(.event=="frames") | "\(.t[11:16]) stalls=\(.data.stalls)/\(.data.frames) max=\(.data.max_ms)"' app.log
jq -c 'select(.event=="output.latency" or .event=="output.latency-high")' app.log
```

見る順番: 時間がたつにつれて、どの区間の p95 と max が伸びるか。伸びるのが入力の区間（input.*）なら本文の処理、bridge.* なら Rust との往復、markdown.* なら見た目の組み立て。dom_nodes と heap_used_mb が増え続けていないか。frames の stalls が増えていないか。入力の区間は伸びず、タイピング音の遅れだけがあるなら、output.latency の estimate_ms と clock.stalled を見る。

### やらないこと

- 計測を外へ送る（ネットワークへ出さない）。
- 画面での表示（計測を見る画面、グラフ）。
- 自動の回復（しばらく打たなかったら AudioContext を作り直す、など）。ログを見てから、R17 で決める。
- タイピング音の鳴り方（音色、音量、鳴らすキー、間引き、同時の上限、鳴り始めの位置、latencyHint）の変更。

### この節で確かめたこと

- 単体テスト: まとめの行の形と分布、50 ms の記録と上限、回数の制限に掛からないこと、区間の数の上限と other、量の推移、画面の止まり（窓が隠れる間を含む）、オフの間に時計もタイマーもリスナーも rAF も動かないこと、pagehide（src/logging/perf.test.ts）。各計測点（アダプターの入力、Markdown の装飾と表、documentFeed、controller と草稿、workerHost、ブリッジの包み）、ctx.perf（レジストリ）、音の区間と遅れの見積もりと warn、N1、N2、オフとオンでの作り直しと素材を取り直さないこと、architecture（段 2 に口がないこと、部品が logging を import しないこと）。
- e2e（chromium と chromium-windows。tests/e2e/perf-log.spec.ts）: 既定では appendLog が 1 回も呼ばれないこと、各計測点の行、50 ms の warn、1 分のタイマー（偽の時計）、本文の目印とパスが出ないこと、sound.start-delay と output.latency（chromium は --mute-audio）、設定のオフとオンでの作り直しと素材を取り直さないこと、オンとオフの入力の処理時間の比較。
- verify Skill のシナリオ performance-log.json と performance-log-off.json。

### 未確認

- 実機の Tauri の窓（WKWebView）で、計測の行が app.log に書かれること（Rust の書き込みは cargo test、Web UI の記録はメモリ bridge で確かめた間接の確認）。
- 実機の WKWebView で、getOutputTimestamp の値が聞こえる遅れを反映するか。設定のオフとオンの作り直しで、遅れが消えるか。
- WKWebView で performance.memory が使えるか（使えなければ heap_used_mb は null）。
- 実機での、計測のオンによる入力の処理時間の増加。

## 限界

- 本物の Tauri の窓で app.log に書かれることは、この Run では未確認。Rust の単体テストと、Web UI のメモリ bridge の e2e を合わせた間接の確認で、窓の中のコマンドの呼び出し（IPC）と実際のファイルへの書き込みを通した確認ではない。
- WKWebView で AudioContext がどう振る舞うか（statechange の来方、currentTime が止まる条件）は、e2e の chromium では再現していない。時計の止まりは、包みで currentTime を止めて模した。
- 時計の止まりの疑いの閾値（500 ms、4 分の 1）は、実機のデータなしで決めた値。誤検出や見落としは、実機のログで見直す。
- 1 秒ごとにまとめて渡すので、アプリが強制終了した直前の最大 1 秒分は残らないことがある（pagehide では、すぐ渡す）。
