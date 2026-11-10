# ADR-007: アプリのログ基盤（設定で有効にする JSON Lines のログ）

## Status

Accepted（2026-11-10、承認者: プロジェクトオーナー）。実機で、タイピング音がたまに鳴らなくなり、アプリの再起動で戻る、という不具合が出た。コードを読んだだけでは原因を特定できなかった（候補は、WKWebView の AudioContext が running のまま音を出さなくなること、素材の読み込みかデコードの失敗）。次に起きたとき、原因を後から知れるように、ログの基盤を作る。タイピング音の鳴り方の修正（作り直しや再試行）は、この ADR の範囲ではない（次の Run）。

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
| typing-sound | context.created | info | sample_rate、base_latency、output_latency、state |
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
- タイピング音の振る舞いの修正（作り直し、再試行）。この ADR は記録だけで、鳴り方（音色、音量、鳴らすキー、間引き、同時の上限、鳴り始めの位置、latencyHint）と、keydown から source.start までの同期の経路を変えない（currentTime の読み取りと比較だけを足した）。
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

## 限界

- 本物の Tauri の窓で app.log に書かれることは、この Run では未確認。Rust の単体テストと、Web UI のメモリ bridge の e2e を合わせた間接の確認で、窓の中のコマンドの呼び出し（IPC）と実際のファイルへの書き込みを通した確認ではない。
- WKWebView で AudioContext がどう振る舞うか（statechange の来方、currentTime が止まる条件）は、e2e の chromium では再現していない。時計の止まりは、包みで currentTime を止めて模した。
- 時計の止まりの疑いの閾値（500 ms、4 分の 1）は、実機のデータなしで決めた値。誤検出や見落としは、実機のログで見直す。
- 1 秒ごとにまとめて渡すので、アプリが強制終了した直前の最大 1 秒分は残らないことがある（pagehide では、すぐ渡す）。
