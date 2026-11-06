# ADR-005: 部品（プラグイン）の仕組み: 3 段の形、権限、変えないこと

## Status

Proposed（2026-11-03、R0）。この時点では案で、実装の Run で確定する。アプリのコードは変えていない。仕様 §7.2 の「編集エンジンを差し替えても UI は変えない」は、この ADR が確定したとき、エディタに関わる部品の範囲で改める（改め方は「未決のこと」）。仕様の文書そのもの（`docs/spec/`）は書き換えない。

R1（2026-11-03）で、段 3 の同梱の部品に限って API v0 を実装した。細部は「R1 で決めた細部」。R2（2026-11-03）で、フォーカスモードを 2 つ目の同梱の部品にした。細部は「R2 で決めた細部」。R3（2026-11-03）で、リストの継続を 3 つ目の同梱の部品にし、設定画面の選択肢の項目と「編集」の置き場所を足した。細部は「R3 で決めた細部」。R4（2026-11-04）で、Markdown の見た目（装飾、記号の表示、チェックボックスのクリック、リンクを開く操作）を 4 つ目の同梱の部品にし、本体が部品に貸す機能（外部の URL を開く、OS の判定）と、設定画面の「外観」の置き場所を足した。細部は「R4 で決めた細部」。R5（2026-11-04）で、隔離した操作の段（段 2）の土台（独自プロトコル `plug:`、sandbox の iframe の中の blob の Worker、postMessage の仲介）を作り、実際の Tauri の窓で隔離を確かめた。段 2 の部品は配布物に 1 つも入れていない。細部は「R5 で決めた細部」と「R5 で確かめた隔離」。R6（2026-11-05）で、段 2 に権限の仕組み（宣言、初回の確認、保存、取り消し）と、権限の要る API（クリップボードへの書き込み、パス、ツリーの右クリックの項目）を足し、最初の同梱の段 2 の部品「パスをコピー」（S2）を入れた。細部は「R6 で決めた細部」、隔離の取り直しは「R6 で確かめた隔離」、限界は「R6 の限界」。R7（2026-11-07）で、段 2 の Worker の部品が左サイドバーにパネル（項目の木）を足せるようにし、宣言だけで使える権限 document.read（本文とカーソルの位置を受け取る）と、同梱の部品「アウトライン」（S1 の最初の段）を入れた。見える iframe で部品が自由に描く段 1 は、今回は作らなかった。細部は「R7 で決めた細部」、確かめたことは「R7 で確かめたこと」、限界は「R7 の限界」。

実験（K1〜K3）は、macOS（WKWebView）の Tauri debug ビルドだけで確かめた。Windows（WebView2）と Linux（WebKitGTK）は未確認。

## Context

### 利用者の目標

自己修正型のソフトウェアにする。執筆に集中できる UI を、利用者自身が考えて形にし、変えたり足したりできるエディタにしたい。例はアウトラインエディタ（エディタの横のパネルと、エディタに代わる表示の両方）。Markdown に限らずテキスト系のファイルを一通り開けるようにしたいのは、このため。UI のほかに、コンテキストメニュー・コマンド・ショートカットも足せるようにしたい（例: ファイルパスの取得）。部品は、将来ほかの人が書いたものを入れることも想定する。形は pi（コーディングエージェント）の拡張に近いものを考える。default export の関数が API を受け取り、`register*` で登録する。決まったフォルダから読み込み、reload できる。

利用者と合意した方針:

- 実行中に部品を読み込む（作り直し不要）。今ある機能も、同じ API を使う同梱の部品に作り替える（後の Run）。
- エディタに関わる部品が CodeMirror（本体が使っているエディタ部品）に依存することを認める。そのかわり「変えないこと」をこの ADR で定義する。CodeMirror のメジャーバージョンも契約の一部になる。

### コーディングエージェントとの違い

守るものが違う。エージェントの拡張は、ファイルやシェルを広く触る前提で、守るのは環境。このエディタが守るのは、利用者の私的で取り戻せない原稿。ほとんどの部品が必要とするのは、今の文書と画面だけ。だから既定は「何も触れない」で、必要なものを宣言させ、危ないものは確かめる。

### 今のアプリの守り

- ネイティブのコマンドは `src-tauri/src/lib.rs` の `generate_handler` に列挙したものだけ。`capabilities/default.json`（権限の定義。窓の単位）が `main` 窓に許可する。ファイル操作は、開いた文書（`documents.rs` の `KnownPaths`）と開いたフォルダ（`folders.rs` と `entries.rs` の `OpenFolders`）の中に限る。
- CSP（Content Security Policy。webview が読み込める・接続できる先の制限）は `tauri.conf.json` で `script-src 'self'`、`connect-src 'self' ipc: http://ipc.localhost`、`default-src 'self'`。eval と inline script は使えない。
- 外へ出る口は `open_external_url`（http と https だけ。`external.rs`）だけ。ネットワークの API は、Rust 側にも capabilities にもない。
- 開ける種類は `src/document/fileKinds.ts`（Markdown と `.txt`、`.text`）。

## シナリオ

各シナリオで、要る権限、要らない権限、作る段（次の節の 3 段）、何が守るかを書く。

### S1 アウトライン

パネル（エディタの横）と、エディタに代わる表示の両方。見出しは `.md` の `#`、org の `*`、プレーンテキストの字下げ。折りたたみ、ドラッグでの並べ替え、1 節だけ広げて書く。

- 要る権限: 今の文書を読む、今の文書を Undo できる形で書き換える（並べ替えは、範囲の移動の 1 回の変更）、自分の設定（折りたたみの状態）、画面の場所（パネル、表示）。
- 要らない権限: ほかのファイル、クリップボード、リンクを開く、ネットワーク、ネイティブ。
- 段: 隔離した表示（段 1）。本文と選択を受け取り、変更を送り返すだけで作れる。1 節だけ広げて書く機能は、エディタの中に CodeMirror を持つ必要があるので、段 3 になる可能性がある（未決。K3 の結果では、本文の受け渡しの速さは問題にならなかった）。R7 で決めたこと: 見出しの一覧と見出しへの移動（折りたたみ、並べ替え、1 節だけ広げて書く機能は含まない）は、段 1 ではなく、段 2 の Worker の部品がパネルに項目の木を送り、描くのは本体、という形で作った（「R7 で決めた細部」）。
- 守るもの: 並べ替えが文書を壊さないこと（変更は Undo できる形だけ。表示の部品は文書のバイト列を変えない）。部品が本文を外へ出せないこと（ネットワークなし、IPC なし）。

### S2 ファイルパスのコピー

ツリーの右クリックのメニューと、コマンド（パレットとショートカット）。

- 要る権限: コマンドと右クリックのメニューの登録（宣言だけ）、パスを読む（初回に確かめる）、クリップボードに書く（初回に確かめる）。
- 要らない権限: 文書の本文、ほかのファイルの読み書き、ネットワーク。
- 段: 隔離した操作（段 2）。
- 守るもの: パスは機微な情報なので、権限の一覧に出し、初回に確かめる。クリップボードに書くだけで、読めない。

### S3 フォルダの中の一括置換

開いたフォルダのファイルを、実行のたびに内容を見せて確かめてから書き換える。

- 要る権限: 開いたフォルダのほかのファイルを読む（初回）、ほかのファイルを書く（操作のたびに、差分を見せて確かめる）。
- 要らない権限: ネットワーク、フォルダの外、ゴミ箱、名前の変更。
- 段: 隔離した操作（段 2）。書き込みは、本体が差分の画面を出し、利用者が承認したものだけをネイティブの検査（開いたフォルダの中だけ）を通して書く。部品は書き込みを「要求」するだけで、承認の画面は本体が持つ。
- 守るもの: 部品が確認なしに複数のファイルを書き換えないこと。確認の画面を部品が差し替えられないこと。

### S4 間違った部品と悪意のある部品

- 間違った部品: 入力のたびに本文を書き換える（無限に書き換える、IME の変換中に書き換える、など）。
- 悪意のある部品: 本文をリンクの URL に入れて開く（外へ持ち出す）。

- 要る権限: 間違った部品は、今の文書を書き換える（宣言だけで使える権限なので、これで起きうる）。悪意のある部品は、リンクを開く（操作のたびに確かめる）、またはネットワーク（与えない）。
- 段: どの段でも起きうる。段 1 と段 2 は、本文を外へ出す経路（ネットワーク、IPC、リンク）を塞ぐ。段 3 は塞げない（同じ JavaScript の空間）。
- 守るもの: 間違った部品は、書き換えの頻度と量の上限（本体が持つ。書き換えが連続したら、その部品を止める）、IME の変換中は書き換えを保留（ADR-004）、すべて Undo できる、部品の一覧から止められる、セーフモード。悪意のある部品は、リンクを開く前に毎回、URL を見せて確かめる（本文が入っていれば利用者に見える）。段 3 は、信頼した部品だけに限る。

## Decision

### 3 段の形

| 段 | 動く場所 | 部品ができること | 入れられる部品 |
|---|---|---|---|
| 1 隔離した表示 | 隔離した iframe（sandbox 属性は allow-scripts のみ。allow-same-origin なし） | パネルと、エディタに代わる表示。本文と選択を受け取り、変更（Undo できる形）を送り返す | 誰の部品でも |
| 2 隔離した操作 | Web Worker | コマンド、右クリックのメニュー、ショートカット。権限の表に従う | 誰の部品でも |
| 3 エディタの中の拡張 | 本体と同じ JavaScript の空間 | CodeMirror の拡張 | 同梱の部品と、自分で書いた部品だけ。ほかの人の部品は、強い警告のうえで明示的に信頼したときだけ |

段 1 と段 2 は、本体の JavaScript の空間と、ネイティブのコマンドと、ネットワークに、直接は届かない。届くのは、本体が `postMessage` で仲介する API だけ。段 3 は隔離がなく、守りは「入れる前の確認」と「信頼の宣言」だけ。

実験（K1〜K3）の結果、この形は成り立つ。ただし、段 1 と段 2 の作り方に、実験で分かった条件がある（「実験の結果」と「結果を受けた案」）。

### 権限の表（案）

| 区分 | 権限 |
|---|---|
| 宣言だけで使える | 画面の場所（パネル、表示）、コマンド、ショートカット、右クリックのメニュー、自分の設定、今の文書を読む、今の文書を Undo できる形で書き換える |
| 初回に確かめる | クリップボードに書く、パスを読む、開いたフォルダのほかのファイルを読む |
| 操作のたびに確かめる | ほかのファイルを書く・名前を変える・ゴミ箱に入れる、リンクを開く |
| 与えない | ネットワーク、開いたフォルダの外、シェル、ネイティブのコマンドの直接の呼び出し、ほかの部品の設定 |

「確かめる」は、本体が画面を出して利用者に聞く。確かめた結果は、初回のものだけ保存する（部品ごと、権限ごと。部品の一覧から取り消せる）。「操作のたびに」は保存しない。段 3 は、権限の表を強制できない（同じ空間で何でも呼べる）。段 3 の部品は、宣言が「何を使うつもりか」の申告にとどまる。

### 部品の形（草案）

pi の拡張に倣う。部品は、default export の関数で、API を受け取り、`register*` で登録する。

```ts
// plugin.json（部品の宣言。manifest）
{
  "id": "outline",                 // 一意。小文字と数字とハイフン
  "name": "アウトライン",
  "version": "0.1.0",              // 部品の版
  "apiVersion": 1,                 // 対応する API の版
  "tier": "view",                  // "view"（段 1）| "action"（段 2）| "editor"（段 3）
  "permissions": ["doc.read", "doc.edit", "settings.self", "clipboard.write"]
}
```

```ts
// 段 2（action）の例。ファイルパスのコピー
export default function (api: PluginApi) {
  api.registerCommand({ id: 'copy-path', title: 'パスをコピー', run: async (ctx) => {
    const path = await api.fs.currentPath();          // 権限 path.read（初回に確かめる）
    await api.clipboard.write(path);                  // 権限 clipboard.write（初回に確かめる）
  } });
  api.registerContextMenuItem({ target: 'explorer-entry', command: 'copy-path' });
  api.registerShortcut({ keys: 'Mod+Alt+C', command: 'copy-path' });
}
```

```ts
// 段 3（editor）の例。CodeMirror は api.cm から受け取る
export default function (api: PluginApi) {
  const { ViewPlugin, Decoration } = api.cm.view;
  api.registerEditorExtension(() => [ /* CodeMirror の Extension */ ]);
}
```

API の草案（名前と形は R1 で決める）:

- 登録: `registerCommand`、`registerShortcut`、`registerContextMenuItem`、`registerPanel`（段 1）、`registerView`（段 1。エディタに代わる表示）、`registerEditorExtension`（段 3）、`registerSetting`（自分の設定の項目）。
- 読み書き: `doc.read()`（本文と選択）、`doc.applyChanges(changes)`（Undo できる 1 回の変更。CodeMirror の `ChangeSpec` と同じ形。段 1 と段 2 では `postMessage` の向こうで、本体が 1 つのトランザクションにして適用する）、`settings.get/set`（自分の分だけ）。
- 段 1 と段 2 の API は、すべて非同期（`postMessage` の往復）。段 3 は、同じ API の同期版も使える。
- 解除: 部品を止める、reload する、セーフモードのときは、登録を全部外す。部品の `register*` は、解除の関数を返す。

API の版の扱い: 本体が持つ API の版（整数）より新しい `apiVersion` の部品は読み込まない。古い版は、本体がその版を残している間だけ読み込む（残す期間は、R1 で決める）。合わない部品は、一覧に理由つきで出し、動かさない。

CodeMirror を API 経由で渡す: 段 3 の部品は、CodeMirror を自分で持ち込まず、`api.cm`（`state`、`view`、`language`、`commands` など）から受け取る。部品が自分で `@codemirror/state` を同梱すると、本体のものと 2 つ読み込まれ、`instanceof` の判定や Facet（拡張を束ねる仕組み）が別物になって動かない。バンドルするときは、これらを external にする。段 1 と段 2 は、CodeMirror に触れない。

### 変えないこと（契約）

部品に対して、次を約束する。変えるときは、API の版を上げる。

- API とその版。
- CodeMirror のメジャーバージョン（段 3 の部品の契約の一部。上げるときは、段 3 の部品の再確認が要る）。
- 保存済みの設定が読めること。
- 表示の部品（段 1）は、文書のバイト列を変えない（BOM、改行コードの維持を含む。変えられるのは、`doc.applyChanges` の結果だけ）。
- 書き換えは、必ず Undo できる形。
- IME の変換中の決まり（ADR-004。変換中は、他の行の表示を切り替えない、書き換えを保留する）。
- 保存、競合、草稿の扱いは、部品から変えられない（保存は本体が持つ。部品は、保存の経路に割り込めない）。
- ネイティブの検査（開いた文書とフォルダの中だけ。`open_external_url` の検査を含む）。部品は、ネイティブのコマンドを直接呼べない。

## 脅威の整理

守るもの: 原稿（文書の本文と、フォルダの中のファイル）、パス（利用者のフォルダ構成）、設定（部品ごとの設定を含む）。

守る相手: 間違った部品（悪意はないが壊す）、悪意のある部品、ほかの人の部品（悪意の有無が分からない）。

| 段 | 守れること | 守れないこと |
|---|---|---|
| 1 隔離した表示 | ネイティブのコマンド、ネットワーク、親のページの DOM に、直接届かない（K1）。本文の外への持ち出しは、本体が仲介する API（リンクを開く）だけ。間違った書き換えは、本体の上限と Undo で受ける | 渡した本文を、表示の中で見られる（読む権限そのもの）。見せた内容で利用者を騙すこと（偽の確認画面など）。CPU の占有（iframe の中の無限ループ。止めるのは、部品の一覧から） |
| 2 隔離した操作 | 同上。権限の表は、仲介する API が強制する。Worker は DOM を持たない | 作り方によっては、ネットワークに届く（K1。Worker を本体のファイルから作ると、CSP が効かない）。許可した権限の範囲での悪用（クリップボードに書く権限で、書き換えること） |
| 3 エディタの中の拡張 | 守れない。本体と同じ JavaScript の空間で、IPC の鍵（K1）を含め、すべてに届く。入れる前の確認と、信頼の宣言だけ | すべて。ほかの人の部品は、強い警告のうえで、利用者が明示的に信頼したときだけ |

守りの前提: ネイティブの検査（開いた文書とフォルダの中だけ）は、どの段でも残る。ただし段 3 は、検査を通る範囲（開いている文書、開いたフォルダ）なら、何でもできる。

K1 で分かった、隔離の前提: ネイティブのコマンドを呼ぶには、起動ごとに作られる鍵が要る。この鍵が漏れると、一部の経路で隔離が破れる（K1）。鍵は、本体（メインフレーム）だけが持ち、段 1 と段 2 には、渡さない、`postMessage` で転送しない、を厳守する。

## 安全装置

- セーフモード: 部品を全部止めて起動する。起動の引数と、前回の起動が異常終了したときの確認で入る（後者は未決）。セーフモードでも、文書の編集、保存、設定は使える。
- 入れるときの権限の一覧の表示: 部品を入れる（または版が上がる）とき、宣言された権限を、権限の表の区分ごとに見せ、同意した部品だけ有効にする。段 3 は、強い警告を出す。
- 読み込んだ部品の一覧: 名前、版、段、使っている権限、状態（動作中、止まった、読み込めなかった理由）。個別に止める、取り消す、reload できる。
- 部品の例外は、その部品だけを止める。段 1 は、iframe を作り直せば足りる（React のエラー境界で、その部品の表示だけを差し替える）。段 2 は、Worker を `terminate` する。段 3 は、拡張の読み込みで例外が出たら、その部品を外して再構成する（実行中の例外は、完全には隔離できない。限界は脅威の表に書いた）。
- 書き換えの上限: 本体が、部品ごとの書き換えの頻度と量を見る。超えたら、その部品を止め、通知する。

## 実験の結果（K1〜K3）

方法: リポジトリの外の一時的な複製（`git archive HEAD` を展開。リポジトリの `.git` と作業ツリーは変えていない）で、実験用のページに差し替えた Tauri アプリを macOS で起動した。ネイティブ側は、コマンド `exp_canary`（呼ばれた印をファイルに書く）などと、独自プロトコル `plug`（`register_uri_scheme_protocol`。ディレクトリのファイルを返し、パスが `csp/` のものには CSP のヘッダーを付ける）を足した。それ以外は、今のアプリの `capabilities` と CSP のまま。起動は debug ビルド、Tauri 2.12.5、wry 0.57.1、macOS の WKWebView。ネイティブへ届いたかは、ネイティブ側の `canary.log` に行が出たかで判定した（webview 側の自己申告にしない）。ネットワークは、127.0.0.1 の受け口（`net.log`）に届いたかで判定した。

CSP の 3 つの組み合わせで、同じ実験を走らせた。

- A: 今の CSP そのまま。
- B: A に `frame-src plug: blob:` と `worker-src 'self' blob:` を足したもの。
- C: B に、`script-src` の `plug: blob:` と `connect-src` の `plug:` を足したもの。

証跡（リポジトリには入れず、run の証跡ディレクトリにある）: `logs/csp-A`、`logs/csp-B`、`logs/csp-C` の `report.jsonl`（webview の結果）、`canary.log`（ネイティブに届いた呼び出し）、`net.log`（ネットワークに届いた通信）、`plug-requests.log`、`summary.txt`。実験のコードは `code/`（`exp-main.js`、`probe.js`、`frame-glue.js`、`native-patch.diff` など）。スクリーンショットは撮っていない（結果はすべてログ）。

### K1: 隔離した iframe と Worker から、ネイティブのコマンドに届くか

Tauri 2.12.5 のソースを読んだ内容（実験の前提）: `ipc://localhost/<コマンド>` への fetch には、ヘッダー `Tauri-Invoke-Key`（起動ごとの乱数。メインフレームの注入スクリプトの中の定数）と、妥当な `Origin` が要る。`Origin` が自分の URL（`tauri://localhost` や、登録した独自プロトコル）なら「ローカル」として capabilities で判定され、それ以外は、`remote` の capability がなければ拒否される。注入スクリプト（`__TAURI_INTERNALS__`）は、既定ではメインフレームだけに入る。

観測（macOS）:

| 経路 | 結果 |
|---|---|
| `__TAURI_INTERNALS__`、`__TAURI__`、`isTauri`、`window.ipc` | Worker と iframe のすべてで undefined（メインフレームだけにある）。`webkit.messageHandlers.ipc` は、iframe にはあり（srcdoc も独自プロトコルも）、Worker にはない |
| `ipc://localhost` への fetch と XHR、鍵なし | どの文脈も届かない。本体から作った Worker、srcdoc の iframe、独自プロトコルの iframe は、`500 missing Tauri-Invoke-Key header` でネイティブに拒否され、`canary.log` に出ない。CSP のヘッダーを付けた iframe（`default-src 'none'`）は、CSP で止まる |
| `http://ipc.localhost` への fetch | すべての文脈で `Load failed`。macOS では、この経路は使われていない（Windows と Android の経路。WebView2 は未確認） |
| `parent`、`top`、`opener` からの到達 | `sandbox="allow-scripts"` の iframe は、`parent.__TAURI_INTERNALS__`、`parent.document`、`top.location` が SecurityError。`opener` は null。`postMessage` は送れる（本体が受けて処理する側）。対照: `allow-same-origin` を付けた iframe と、sandbox なしの iframe は、`parent.__TAURI_INTERNALS__.invoke` でネイティブのコマンドを呼べた（`canary.log` に出た） |
| 鍵が漏れたと仮定して、鍵を `postMessage` で渡した場合（実験のための模擬） | 下の 3 行 |
| 本体から作った Worker（ファイル、blob） | fetch と XHR で、ネイティブのコマンドに届いた（実コマンド `load_preferences` も成功）。Origin が `tauri://localhost` で、ローカル扱いになるため。鍵の秘匿だけが壁 |
| `sandbox="allow-scripts"` の iframe（srcdoc、独自プロトコルの両方）と、その中から作った blob の Worker | fetch と XHR は、`500 Origin header is not a valid URL`（Origin が `null`）で拒否。届かない |
| `webkit.messageHandlers.ipc.postMessage`（鍵つき。本体からは成功した対照あり） | srcdoc の iframe（sandbox あり、`allow-same-origin` あり、sandbox なしのいずれも）は、届かなかった（原因は未確認。`about:srcdoc` が、ローカルの URL として扱われないためと推測）。独自プロトコルの iframe は、`sandbox="allow-scripts"` のみでも、CSP のヘッダーで `default-src 'none'` にしても、届いた（`canary.log` に出た）。Tauri が、登録した独自プロトコルの URL をローカルと扱うため（ソースで確認） |

結果の読み方:

- 鍵を渡さない限り、段 1 と段 2 の文脈（Worker、iframe）から、ネイティブのコマンドに届く経路は見つからなかった。鍵が漏れないことが、隔離の前提。
- 鍵が漏れた場合の壁は、文脈で違う。sandbox の iframe は、fetch と XHR が Origin で止まるが、独自プロトコルから読み込んだ iframe は `postMessage` の経路で破られる。srcdoc の iframe は、この経路でも届かなかった。本体から作る Worker は、鍵があれば届く。つまり、鍵を渡さないことを、コードの規則にする。独自プロトコルの iframe では、鍵の秘匿だけが壁になる。
- 塞ぎ方で試せたもの: sandbox 属性（`allow-same-origin` を付けない）で、親の DOM と `__TAURI_INTERNALS__` に届かない。iframe の中に Worker を作ると、Origin が `null` になり、本体から作る Worker より固い。CSP のヘッダーで、iframe の fetch、XHR、ネットワークを止められるが、`postMessage` の経路は止められない。capabilities の `windows` と `webviews` の指定は試していない（iframe は別の webview ではなく、同じ webview の中なので、指定の単位にならないと考えられるが、未確認）。
- ネットワーク: `sandbox="allow-scripts"` でも、CSP のヘッダーがない独自プロトコルの iframe（F3）と、対照の `allow-same-origin` つき（N3）は、127.0.0.1 に fetch、画像、`navigator.sendBeacon`、WebSocket のいずれでも届いた（B と C の `net.log` に記録がある。WebSocket は、webview 側は `error` だったが、接続要求は受け口に届いた）。F3 の中から作った Worker も、fetch と WebSocket の接続要求が届いた（Worker に `sendBeacon` はない）。srcdoc の iframe と、blob の Worker は、本体の CSP を継承して届かなかった。CSP のヘッダーを付けた独自プロトコルの iframe（F4）と、その中の Worker も、届かなかった。`sendBeacon` は、届かなかった文脈（srcdoc の iframe、F4）でも `true` を返したが、受け口には記録がない。`true` は送信の成功ではなく、キューに入ったことを示すだけなので、`true` を届いた証拠にしない。
- 本体の配信するファイルの Worker（`/probe-worker.js`）は、本体の CSP の `connect-src` が効かず、127.0.0.1 に fetch と WebSocket の接続要求が届いた（A、B、C のすべて）。本体の `tauri://localhost/` のレスポンスで、HTML には CSP のヘッダーが付くが、`.js` には付かないことを確かめた。つまり、本体のファイルから作った Worker は、ネットワークに届く。

### K2: CSP のもとで、外から入れた部品のコードを読み込む方法

本体の空間（段 3）に読み込む場合:

| 方法 | A（今の CSP） | 要る CSP の変更 |
|---|---|---|
| `<script src="plug://...">` | 拒否（script-src-elem） | `script-src` に `plug:` を足す（C で成功） |
| `import('plug://...')`（ESM） | 拒否 | 同上。ESM は CORS が要るので、プロトコルの応答に `Access-Control-Allow-Origin` を付けた（C で成功） |
| `fetch('plug://...')` でテキストを取る | 拒否 | `connect-src` に `plug:`（C で成功） |
| blob の script と `import(blob:)` | 拒否 | `script-src` に `blob:`（C で成功） |
| `new Function` と eval | 拒否 | 足さない（C でも拒否） |
| inline の script | 拒否 | 足さない（C でも拒否） |

Worker に読み込む場合:

| 方法 | 結果 |
|---|---|
| `new Worker('plug://...')`（直接） | 失敗（本体と別のオリジンのため）。A、B、C のすべて |
| 本体のファイルの classic Worker から `importScripts('plug://...')` | 成功（A、B、C のすべて。CSP の変更なし） |
| 本体のファイルの module Worker から `import('plug://...')` | 成功（A、B、C のすべて。応答に `Access-Control-Allow-Origin` を付けた場合） |
| ホストが部品のテキストを渡し、blob の Worker にする | A は `worker-src` で拒否、B と C で成功。`worker-src` に `blob:` を足す |

iframe で読み込む場合:

- `srcdoc` の iframe は、本体の CSP を継承する。inline の script は動かない（拒否を確認）。`<script src="本体の絶対 URL">` の外部ファイルは動く。
- `plug://` の iframe と blob の iframe は、A では `frame-src` で拒否（`default-src 'self'` に落ちるため）。B で、独自プロトコルの iframe は起動した。
- 独自プロトコルの iframe は、自分のレスポンスの CSP ヘッダーを持つ（本体の CSP は継承しない）。ヘッダーで `script-src 'self'` と書いたとき、iframe は起動しなかった（初回の試行で、iframe の `probe.js` が要求されなかったことを確認。`sandbox` によるオリジンの不透明化で `'self'` が一致しないためと推測。ログは、その後の再実行で上書きしたため証跡なし）。`script-src plug:` に直すと動いた（B、C の `F4`）。
- blob の iframe は、`sandbox="allow-scripts"` で、B と C でも起動しなかった（`F2`、`F2b`。原因は未確認。CSP の拒否を、親のイベントでは観測できなかった）。blob の iframe は、現時点では使えるとは言えない。

本体の CSP をどこまで保てるか:

- 段 1 を独自プロトコルの iframe で作る: 本体の CSP に足すのは、`frame-src plug:` だけ（B）。`script-src` は変えず、本体の空間は、eval、inline、外部の script を拒否したまま。
- 段 2 を Worker で作る: ホストがテキストを渡して blob の Worker にするなら、足すのは `worker-src blob:` だけ。本体のファイルから `importScripts` するなら CSP の変更は要らないが、その Worker には本体の CSP が効かない（K1）。
- 段 3: `script-src` に `plug:`（または `blob:`）を足す必要がある。本体の空間全体の `script-src` が広がる。独自プロトコルが返すファイルが、すべて本体の空間で実行できる。保てる範囲は、独自プロトコルが返すファイルを、部品の置き場所に限ることと、段 3 の部品を信頼したものに限ること。ハッシュによる許可（SRI の `integrity` つきの外部 script）は、試していない。
- アセットプロトコル（Tauri の `asset:`、`convertFileSrc`）は試していない。

### K3: iframe との本文のやり取りの速さ

対象: `phase0/fixtures/perf/C-1mb-longform.md`（1,048,862 バイト、422,152 文字、sha256 は manifest と一致）。本体の窓と、`sandbox="allow-scripts"` の iframe（srcdoc と、CSP のヘッダーつきの独自プロトコルの 2 通り）の間で `postMessage`。実験は、窓を表示した状態（前面かどうかは未確認）の debug ビルドで、入力のない状態（本体のスレッドは空き）。`performance.now()` は WebKit で 1ms に丸められるので、5 往復（変更だけの場合は 20 往復）をまとめた時間を件数で割ったバッチ平均で測った。バッチ数は 20（変更だけは 30）。下の値は `logs/csp-B` のもので、バッチ平均の中央値と最大。

| 渡し方 | 往復（1 件あたり） 中央値 / 最大 | 本体側の `postMessage` 呼び出し（送信側のブロック） 中央値 |
|---|---|---|
| 全文（文字列）を送り、ack だけ受ける | 0.4 / 0.6 ms | 0.2 ms |
| 全文を毎回組み直して（`split`/`join`。`doc.toString()` に近い）送り、ack だけ受ける | 0.8 / 1.2 ms | 0.4〜0.6 ms |
| 全文を毎回新しい文字列にして送り、全文を返してもらう | 0.8〜1.0 / 1.2〜1.4 ms | 0.2〜0.4 ms |
| 全文を送り、iframe が見出しを数える（アウトラインの計算の代わり） | 1.0 / 1.6〜3.6 ms | 0.2 ms |
| UTF-8 の ArrayBuffer を移譲（エンコードとデコードを含む）して往復 | 5.2〜6.0 / 8.2〜8.6 ms | 1.8〜2.0 ms |
| 変更だけ（位置と挿入文字）を送り、iframe が自分の全文に反映して、変更を返す | 0.15 / 0.35〜0.8 ms | 0〜0.05 ms |
| 変更だけを送り、iframe は反映せずに記録だけ | 0.1 / 0.2〜0.45 ms | 0〜0.05 ms |

読み方:

- この条件では、1MB の全文を毎回渡しても、往復は数 ms 以内で、仕様 §9.2 の目安（入力から描画まで 50ms）に対して十分に小さい。変更だけを渡すと、さらに 1 桁小さい。入力の邪魔になる速さではない。
- ArrayBuffer への変換は、文字列より遅かった（エンコードとデコードの分）。文字列のまま渡す方が速い。
- `logs/csp-A` と `logs/csp-C` の K3 は、計測の初版（文字列を使い回す。全文のバッチも 1 件ずつ）で、傾向は同じ。例外として、`logs/csp-C` の独自プロトコルの iframe の ArrayBuffer だけ、1 バッチで往復が 109.8ms（バッチ平均）だった。原因は未確認で、`logs/csp-B` の再実行では出なかった。
- 限界: 本体の窓は空いていて、CodeMirror の描画や入力と同時ではない。実際の `doc.toString()` と CodeMirror のトランザクションの組み立ては含めていない。debug ビルドの結果（webview の JavaScript は debug の影響を受けにくいが、未確認）。同じプロセスの中の受け渡しで、WKWebView が文字列を共有している可能性がある（未確認）。Windows と Linux は未確認。Chromium（Playwright）での比較はしていない。

### 結果を受けた案

3 段の形そのものは、成り立つ（段 1 と段 2 から、ネイティブのコマンドに鍵なしで届く経路は見つからず、本文の受け渡しは速い）。ただし、作り方に次の条件がつく。どれを選ぶかは、親と利用者が決める。

1. 鍵の扱い（必須）: `Tauri-Invoke-Key` は、段 1 と段 2 に、どの形でも渡さない。本体の空間に入る部品（段 3）は、鍵に届くので、段 3 を信頼した部品に限る理由の 1 つ。
2. 段 2 の Worker の作り方:
   - 案 2a: 本体のファイルから Worker を作らない。ホストが部品のテキストを持ち、`sandbox="allow-scripts"` で CSP のヘッダーつきの iframe（ワーカーのホスト）の中で blob の Worker にする。K1 で、Origin が `null`、ネットワークなし、IPC なしだった。足す CSP は `frame-src plug:`（と、iframe 側のヘッダーの `worker-src blob:`）。
   - 案 2b: 本体の空間から blob の Worker にする（本体の `worker-src blob:` を足す）。ネットワークは本体の CSP を継承して止まるが、Origin がローカルなので、鍵が漏れたら届く。
   - 案 2c: 本体のファイルを使う Worker は、ネットワークに届くので選ばない。
   - 推奨は 2a。
3. 段 1 の iframe の作り方:
   - 案 1a: 独自プロトコルから、CSP のヘッダーつきで読み込む。足す CSP は `frame-src plug:` だけ。部品のコードを、本体の CSP を広げずに読み込める。ただし、鍵が漏れたときは `postMessage` の経路で破られる（K1）。
   - 案 1b: `srcdoc`。鍵が漏れても `postMessage` の経路は届かなかった（原因は未確認）。ただし、本体の CSP を継承するので、部品の script を読み込むには、本体の `script-src` を広げる必要がある（inline と eval は拒否のまま）。
   - 案 1c: blob の iframe。K2 のとおり、起動しなかった。原因を調べるまで選ばない。
   - 推奨は 1a。ただし、鍵が漏れたときの `postMessage` の経路を、ネイティブ側の検査で塞げるかを、実装の Run の最初に確かめる（未検証。呼び出し元のフレームを判別できないなら、1a は鍵の秘匿だけが壁になり、1b を再検討する）。
4. 段 3 を入れるときは、本体の `script-src` に `plug:` を足す必要がある。段 1 と段 2 の独自プロトコルとは別の、段 3 専用のプロトコル（または別の置き場所）に分け、段 3 の部品だけを返すようにする案。
5. 独自プロトコルの応答は、CSP のヘッダーと、`Access-Control-Allow-Origin` を、段ごとに決める。iframe 用の `script-src` は、`'self'` ではなく `plug:` のように書く（K2）。

## この先の Run の順序（案）

1. 基準値のとり直しとカバレッジ（`docs/perf-baseline.md` の基準値を、部品の仕組みを入れる前の状態でとり直す。単体テストのカバレッジを測る）。
2. R1: API の v0 と登録の仕組み（段 3 の同梱の部品から）。タイプライターモードを、最初の同梱の部品にする。
3. R2 以降: 今ある機能を、1 つずつ同梱の部品にする。
4. 隔離した操作の段（段 2）。最初は S2（ファイルパスのコピー）。その前に、案 2a の Worker のホストと、鍵が漏れたときの `postMessage` の経路の確認（K1 の未検証）。
5. 隔離した表示の段（段 1）。最初は S1（アウトライン）。R7 で、S1 のうち「見出しの一覧と見出しへの移動」だけを、段 2 の部品（項目の木を送り、本体が描く）として先に作った。部品が iframe の中で DOM を自由に描く段 1 は、まだ作っていない。作るときは、最初に、Tauri の窓で、sandbox の iframe が本体と同じスレッドで動くか（iframe の中の無限ループで、本体の描画と入力が止まるか）を測る（「R7 で決めた細部」の「段 1 を後回しにした理由」）。折りたたみ、並べ替え（`doc.applyChanges`）、1 節だけ広げて書く機能、エディタに代わる表示（`registerView`）は、その後。
6. 外からの読み込み、セーフモード、部品の一覧、権限の確認の画面。
7. S3（フォルダの中の一括置換）。ネイティブの検査の拡張（ほかのファイルの読み書き）が要るので、最後。

## R1 で決めた細部

R1（2026-11-03）で、API v0 と登録の仕組みを入れ、タイプライターモードを最初の同梱の部品にした。外からの読み込み、隔離（段 1・段 2）、権限は R1 の対象外。振る舞い、設定ファイルの形、DOM は変えていない。

### API v0 の実際の形

公開 API は `src/plugin-api/`。部品はこのフォルダの index だけを import する。`PLUGIN_API_VERSION` は 0。

- 部品は `{ manifest, activate(ctx) }`。manifest は `id`、`name`、`version`、`apiVersion`、`tier`（R1 は `'editor'` だけ）。草案の plugin.json と default export の関数ではなく、TypeScript のオブジェクトにした（同梱の部品で、外から読み込まないため。外から読み込む Run で manifest の置き方を決め直す）。
- 登録は activate の中で ctx に対して行う。activate の中でタイマー・リスナー・購読を始めない。後片付けは、activate が返す関数に書く（草案の「register* が解除の関数を返す」は取らなかった）。
- ctx の登録は 4 つ。`registerSetting`（キー、既定値、正規化。登録した設定への参照を返す）、`registerEditorExtension`（設定への参照と、設定の値から CodeMirror の Extension を作る関数）、`registerCommand`（id、表示名、ショートカット、入力欄では無視するか、実行の関数）、`registerSettingsItem`（置く場所、並び順、種類、設定への参照、表示名）。
- 拡張の差し替え: ホストが、部品の拡張ごとに Compartment を持ち、設定の値が変わると差し替える。setText で state を作り直しても、現在の値で始まる。拡張は設定 1 つに結び付く形だけで、複数の設定に依存する拡張は、必要になったときに足す（未決）。文書の種類に依存する拡張は、R2 で足した（「R2 で決めた細部」）。
- コマンドのショートカットは `Mod+T`、`Mod+Shift+T`、`Mod+,` の形（Mod は macOS で Cmd、それ以外で Ctrl）。論理キーを優先し、英字でない配列では物理キーで判定する。Alt つきと IME の変換中は対象にしない。判定は本体の固定のショートカット（`matchShortcut`）と同じ規則で、同じ入力で同じ結果になることを単体テストで比べている。固定のショートカット（新規、開く、保存、設定、サイドバー、フォーカスモード、全画面）が先に判定され、合わなければ部品のコマンドを探す。
- 設定画面の置き場所は名前で指す。R1 は `appearance.writingAids`（外観の「執筆の補助」）だけ。並び順は数で、本体の項目が 100 刻み（フォーカスモード 100、入力中は上下のバーを隠す 300）、タイプライターモードは 200。種類は `checkbox` だけ。
- API の版の検査: `apiVersion` が本体の版と違う部品は、新しくても古くても読み込まず、理由を記録する（v0 は実験の版で、古い版を残す期間は v1 で決める）。宣言の形の検査（id、name、version、tier）と id の重複も、同じく読み込まない理由になる。
- 例外の隔離: activate の例外は、その部品の登録を全部外して止める。拡張を作る関数の例外、拡張の形が不正なとき（試しに state を作って確かめる）、コマンドや正規化の関数の例外は、その部品を止める。ほかの部品とアプリは動き続ける。止めたことは console に出す。部品の一覧の画面は後の Run。CodeMirror の ViewPlugin の動作中の例外は、CodeMirror がその ViewPlugin だけを止める（ホストでは受けていない）。
- 登録の名前の衝突（設定のキー、コマンドの id、ショートカット）は、後から登録した部品の activate が例外になり、止まる。設定のキーは、本体の設定のキーとも重ならない。

### 設定の保存の扱い

設定ファイルの形は変えていない。タイプライターモードは、これまでと同じ最上位のキー `typewriterMode`（真偽値）のまま。

- 本体の設定の型 `Preferences` から `typewriterMode` を外し、保存と設定画面で扱う全体を `StoredPreferences`（本体の設定と、部品の設定を同じ最上位に並べたもの）とした。`normalizePreferences(raw, pluginSettings)` が、本体の項目を今までどおり検証し、部品が登録した設定を、その部品の正規化の関数で検証して同じ最上位に並べる。定義のないキーは、今までどおり捨てる。
- 同じ値なら保存されるバイト列は変更前と同じ。Rust 側は `serde_json::Value` を整形して書く。serde_json に preserve_order の機能は入っていない（`cargo tree` で確認）ので、キーは並べ替えて書かれ、JS 側のキーの順は影響しない。変更前のコミットの `normalizePreferences` の出力を、キーを並べ替えて整形した文字列として `src/preferences/storedShape.golden.json` に置き、13 の入力（設定なし、全項目あり、`typewriterMode` なし・型違い、旧い形、ほかの項目が範囲外、未知のキー）で新しい経路の出力と文字列が一致することを単体テストで確かめる。
- 読み込まなかった部品（版の不一致、activate の例外）の設定のキーは、定義がないので、次の保存で消える。動作中に止めた部品の定義は残すので、保存値は消えない。読み込めなかった部品の保存値を残すか、部品ごとの名前空間（例: `plugins.<id>`）へ移すかは未決。移すときは、保存の形が変わるので、移行の読み込みが要る。

### 共通の約束（部品どうしの見えない結びつきの置き換え）

どちらも `src/plugin-api/` にあり、部品とホストは、互いを import せず、これだけで協調する。

- `skipCaretFollow`（CodeMirror の Annotation）: 「この変更では、カーソルに追従してスクロールしなくてよい」。カーソルも選択も動かさない変更（チェックボックスのクリックでの切り替え。`taskToggle.ts`）が付け、カーソルを画面の位置に保つ部品（タイプライターモード）が見る。`input.toggle-task` の userEvent は、そのまま残してあるが、判断には使わない。
- `ownsCaretScroll`（CodeMirror の Facet。いずれかが true なら true）: 「カーソルのスクロールは、この部品が受け持つ」。タイプライターモードが宣言する。`keepCursorVisible.ts` と `readingPosition.ts` は、これまでは `view.dom` の class `cm-typewriter` を見て止まっていたが、この宣言を読む。

DOM の class `cm-typewriter` と CSS 変数 `--md-typewriter-pad` の名前は変えていない（余白の指定は、部品の `theme.ts` に移した）。ただし、部品の theme は CodeMirror が自動で付ける class（`ͼ` で始まる名前）を 1 つ増やすので、タイプライターモードがオンの間だけ、`.cm-editor` の class の数が 1 つ多い。

### ホストが部品を知らないことの縛り方

単体テスト `src/plugin-api/architecture.test.ts` が、ファイルの import と名前を読んで確かめる。

- `src/features/` のファイルは、`src/plugin-api/`、`@codemirror/*`、`@lezer/*`、react だけを import する。相対 import は自分の部品のフォルダの中だけ（`src/plugin-api/` への相対 import は許す。ここに alias を足さないため）。部品どうしの import はしない。テストのファイルは vitest も許す。
- 本体のファイル（App、CodeMirrorAdapter、EditorAdapter、shortcuts、AppearanceSettings、preferences、keepCursorVisible、readingPosition、theme、taskToggle）に、typewriter の名前（大文字小文字を問わず、コメントを含む）が出てこない。
- 同梱の部品は `src/features/index.ts` の一覧からだけ読み込まれる。`src/features/` の外から import してよいのは、その index だけ。一覧が import するのは、部品のフォルダ全部と、それだけ。アプリが一覧を読むのは `main.tsx` の 1 か所で、そこで作った部品の一覧（レジストリ）を App に渡す。

### R1 の限界

- 段 3 の部品は、CodeMirror を `api.cm` ではなく直接 import している（同梱の部品はバンドルが同じなので、`instanceof` と Facet の問題は起きない）。外から読み込む Run で `api.cm` に切り替える。
- 複数の設定に依存する拡張、静的な（設定に結び付かない）拡張の登録口は、まだない（文書の種類を渡す口は R2 で足した）。
- 止めた部品の一覧の画面、再読み込み、セーフモードは、後の Run。

## R2 で決めた細部

R2（2026-11-03）で、フォーカスモードを 2 つ目の同梱の部品（`src/features/focus/`）にした。振る舞い、設定ファイルの形、DOM は変えていない。API の版は 0 のまま（実験の版。互換性は約束しない）。外からの読み込み、隔離、権限は対象外。

### 文書の種類を部品に伝える口

フォーカスモードは、段落の分け方が文書の種類で変わる（Markdown は見出し・リスト項目・コードフェンス・frontmatter でも区切る。`.txt` と `.text` は空行だけ）。

- `EditorExtensionRegistration` に、2 つ足した。`create(value, env)` の第 2 引数 `env.textKind`（`'markdown' | 'plain'`）と、`dependsOnTextKind`（省略は false）。`create` が `env.textKind` を読むなら true にする。
- true の登録は、文書の種類が変わると、ホストが `create` を呼び直して Compartment で差し替える。差し替えの時点は、これまでと同じ（`setTextKind` の同じ transaction の中で、本体の記法の装飾と一緒に）。false の登録は作り直さない（タイプライターモードのように、種類を見ない拡張の ViewPlugin を、種類の切り替えのたびに作り直さないため）。
- 種類の型 `TextKind` は `src/plugin-api/` に置いた。`src/document/fileKinds.ts` はそこから再公開する（定義は 1 つ）。部品は `fileKinds` を import しない。
- 取らなかった案: (1) 拡張が種類の変化を購読する口（ViewPlugin の中で別経路を持つことになり、差し替えの時点が部品ごとにずれる）。(2) 種類が変わるたびに全部の部品の拡張を作り直す（種類を見ない部品の状態を、無駄に失う）。(3) `create` が `env.textKind` を読んだかを実行時に検出して自動で印を付ける（動くが暗黙で、条件によって読んだり読まなかったりする拡張で、挙動が読みにくい）。宣言を明示にした。
- `dependsOnTextKind` を付け忘れると、種類が変わっても拡張は作り直されず、`env.textKind` は拡張を作った時点の値のままになる。API の文書（`types.ts`）に書いた。
- 種類の変化に対する単体テスト: 種類を読む拡張だけが、種類が変わったときに作り直される・同じ種類を渡し直しても作り直さない・mount の前に決めた種類と `setText` の後でも現在の種類で始まる（`CodeMirrorAdapter.test.ts`）。実際のフォーカスモードの、種類の切り替えでの段落の分け直しは `bundledPlugins.test.ts`。

### 共通の道具の置き場所

`frontmatterEndLine`（1 行目の `---` から次の `---` までの、最後の行）は、本体の記法の隠し方（`liveMarkup.ts`）と、フォーカスモードの段落の分け方（部品）の両方が使う。部品がホストを import せず、ホストが部品を import しない（ADR の縛り）ので、両方が読める場所は `src/plugin-api/` になる。`src/plugin-api/frontmatter.ts` に置き、公開 API の index から出す。判定は変更前と同じ（コードは移しただけ。単体テストを足した）。

`focusRange`（段落の求め方）は、ほかに使う人がいないので、部品の中（`src/features/focus/`）に移した。

### 見た目の置き場所

`.cm-md-dim` の不透明度（0.38）は、これまで本体のエディタのテーマにあった。部品のテーマ（`src/features/focus/theme.ts`）に移した。切り替えの遷移（0.25s ease。Reduced Motion でないときだけ）は、これまで `styles.css` にあった。同じく部品のテーマに移し、`@media (prefers-reduced-motion: no-preference)` を CodeMirror のテーマの中に書いた。ホストに残すと、部品の class 名がホストの CSS に残り、部品を外してもホストに指定が残るため。class 名 `cm-md-dim` と、付く行は変えていない。

R1 のタイプライターモードと同じく、部品のテーマは CodeMirror が自動で付ける class（`ͼ` で始まる名前）を 1 つ増やすので、フォーカスモードがオンの間だけ、`.cm-editor` の class の数が 1 つ多い。

### 設定・コマンド・設定画面

- 設定のキー `focusMode`（真偽値）は、これまでと同じ最上位のまま。本体の設定の型 `Preferences` と既定値から外し、部品が `registerSetting` で登録する。保存されるバイト列は変更前と同じ（R1 の `storedShape.golden.json` に、`focusMode` を含む変更前の出力がある。既存の 13 の入力が、そのまま一致する）。`focusMode` がない・型が違う古い設定ファイルは、オフとして読む（単体テストで確かめた）。
- `preferences.ts` に `focusMode` の文字列は残らない。R1 が `typewriterMode` で行った扱いと同じで、保存の形を保つのは、部品の `normalize` と、テスト側の golden（`preferences.test.ts` と JSON）。ホストのファイルに避けられない文字列はなかった。
- コマンド `focus.toggle`（`Mod+Shift+F`、入力欄では無視）。本体の固定のショートカット（`matchShortcut`）から `focusMode` を外した。判定は、`Mod+Shift+F` が固定のショートカットだったころの規則を書き写した判定と、全部の修飾キーの組み合わせ・全角の英字・IME の変換中で一致することを、部品の単体テストで確かめた。入力欄で無視する判定は、本体の `shouldRunPluginCommand`（`shouldHandleShortcut` を置き換えた）に置き、単体テストを移した。ほかの固定のショートカットが先に判定される順序は変えていない（`Mod+Shift+F` と重なる固定のショートカットはない。macOS の全画面は Ctrl+Cmd+F で、Shift を含まない）。
- 設定画面の「執筆の補助」は、`appearance.writingAids` に order 100 で置く。並びは、フォーカスモード（100）、タイプライターモード（200）、入力中は上下のバーを隠す（300）のまま。

### N1: commandContext.update の直し方

`commandContext.settings.update` は、描画済みの設定（`prefsRef.current`）から次の値を作ってから `setPrefs` していたので、同じ tick に 2 回呼ぶと、2 回目が 1 回目の結果を見ず、1 回目を打ち消した。`setPrefs((prev) => ...)` の更新関数の中で、直前の値から次の値を計算する形にした。`src/preferences/commandContext.ts`（`createCommandContext`、`updateStoredSetting`）に切り出し、React の更新の順序を写した単体テストで、同じ tick の 2 回の更新が両方効くことを確かめた（修正前の形に戻すと、このテストは落ちる）。`get` は、呼んだ時点の描画済みの値を返す（変えていない）。

### ホストが部品を知らないことの縛りの拡張

`architecture.test.ts` の、ホストのファイルの名前の検査に、`focusMode`、`focusRange`、`cm-md-dim`、`setFocusMode` を足した（大文字小文字を問わず、コメントを含む。対象のファイルは R1 の一覧と同じ）。`src/features/focus/` のファイルが、import の縛り（`plugin-api`、`@codemirror/*`、`@lezer/*`、react、自分のフォルダだけ。部品どうしの import なし）の対象になっていることも、確かめている。`EditorAdapter` から `setFocusMode` を外した。

### R2 の限界

- `dependsOnTextKind` は、文書の種類 1 つだけを対象にしている。文書のパス、文書の長さなど、ほかの文書の情報に依存する拡張が出てきたら、`env` に足す（そのとき、再作成の条件の宣言の形を決め直す）。
- 設定 1 つに結び付く拡張だけで、複数の設定に依存する拡張の登録口はまだない。

## R3 で決めた細部

R3（2026-11-03）で、リストの継続を 3 つ目の同梱の部品（`src/features/list-continuation/`）にした。振る舞い、設定ファイルの形、DOM は変えていない。API の版は 0 のまま。外からの読み込み、隔離、権限は対象外。あわせて、R2 のレビューの注記 3 件（N-R2-1〜3）を直した。

### 設定画面の選択肢の項目

`registerSettingsItem` の `kind` に `'radio'` を足した。種類ごとに、登録の形が違う（`SettingsItemRegistration` は `kind` で分かれる）。

- `kind: 'radio'`: `setting`（`SettingHandle<string>`。値は選択肢の `value` のどれか）、`legend`（枠の見出し）、`options`（`{ value, label }` が 1 つ以上）、`hint`（選択肢の下の補足の文。省略可）。
- 描く DOM は、変更前の `EditingSettings.tsx` と同じ: `fieldset > legend`、`div.choices > label.choice > input[type=radio] + 文字`、`p.hint`（`hint` を省いたときは `p` を出さない）。選ばれるのは、保存された値と `value` が等しい選択肢。保存された値がどの選択肢でもなければ、どれも選ばれない（設定の読み込みで、範囲外の値は既定値になるので、通常は起きない）。選ぶと、`onChange({ [設定のキー]: value })`（本体の設定と同じ経路。検証と保存を通る）。
- 登録の検査（満たさなければ activate の例外になり、その部品は止まる）: `legend` が空でない、`options` が 1 つ以上で、各 `value` が文字列で重ならず、各 `label` が空でない、設定の既定値が選択肢のどれか、`hint` は文字列、`order` は有限の数。
- 取らなかった案: 選択肢の `value` を `string` の組み合わせ型にする（型は実行時に消えるので、検査は結局要る。設定の型は部品が持つ）。真偽値以外を全部「選択肢」にまとめる（数値の範囲など、別の描き方が要る項目は、種類を足して扱う）。

### 「編集」の置き場所の名前

`editing.body`。名前は `<節>.<節の中の置き場>`（R1 の `appearance.writingAids` と同じ形）。「外観」の節の「執筆の補助」は、ホストが枠（fieldset と legend）を持ち、その中にチェックボックスが並ぶので、枠の名前を置き場所にした。「編集」の節は、見出し（h3）だけをホストが持ち、枠（fieldset）は選択肢の項目が自分で持つ。置き場所が指すのは「節の本文」そのものなので、`body` にした（`settings`、`items` は節の名前と紛らわしいので取らなかった）。

置き場所ごとに、置ける種類を決めてある（`SETTINGS_PLACEMENT_KINDS`: `appearance.writingAids` は `checkbox`、`editing.body` は `radio`）。その場所でホストが描けない種類の登録は、activate の例外にする（登録されたのに何も出ない、をなくす）。`settingsItems(placement)` の戻り値の型も、置き場所で決まる。「編集」の節には、ほかの種類（チェックボックスなど）の描き方を決めていないので置けない。必要になったときに足す。

### ラジオの name の決め方

規則で作る。設定のキーを、小文字のハイフン区切りにする（`listContinuation` → `list-continuation`。小文字・数字の次の大文字の前にハイフンを入れ、全体を小文字にする）。変更前の name `list-continuation` と一致する。登録で指定させる案は取らなかった: 部品が別の部品や本体の name を重ねられる。キーはすでに部品の間で一意なので、規則なら重なりの検査は、大文字小文字だけが違うキー（`Mode` と `mode`）の 1 通りで済み、登録の例外にする。限界: 本体自身のラジオの name（`background-kind`、`gradient`）との重なりは検査していない（`surface-width`、`markup-display`、`theme` は、本体の設定のキーと重ならない検査で、部品のキーにならない）。

### Enter の優先順位の確かめ方

リストの継続の拡張は、`tight` のときだけ `Prec.highest` の Enter のキー割り当てを足し、`preserve` は何も足さない（lang-markdown の `Prec.high` の Enter と、`defaultKeymap` の Enter が残る）。優先度は `Prec` が決めるので、部品の一覧の並びには左右されない（同じ優先度の拡張どうしだけ、並びが効く。ほかの `Prec.highest` の拡張はない。`indentKeymap` と `verticalMotion` は `Prec.high` で、Enter を持たない）。

確かめ方は 2 つ。(1) 変更前のコミットを展開した複製で、部品の拡張と同じ組み立ての state（`createCodeMirrorAdapter` と、そのときの `setListContinuation`）から、`keymap` の Facet の中の Enter のキー割り当てを効く順に取り出した（tight: `insertNewlineContinueTight`、lang-markdown の Enter、`defaultKeymap` の Enter（shift つき）の 3 つ。preserve: 後ろの 2 つ）。(2) 変更後は、同じ並びになることを単体テスト（`bundledPlugins.test.ts` の「Enter priority is unchanged」）で確かめている。`tight` と `preserve` の切り替えは、`setPluginSetting` が部品の Compartment を差し替える（R1 の仕組み）。

### 設定の保存

設定のキー `listContinuation`（文字列 `'tight'` または `'preserve'`）は、これまでと同じ最上位のまま。`preferences.ts` から `ListContinuation` の型、`Preferences.listContinuation`、既定値、正規化を外し、部品が `registerSetting` で登録する（正規化は同じ: 2 つの値以外は `'tight'`）。保存されるバイト列は変更前と同じ。`storedShape.golden.json` に、変更前のコミットの出力から作った 8 つの入力（`listContinuation` が tight、preserve、範囲外の文字列、大文字違い、数値、null、配列、キーなし）を足し、R1・R2 の 13 の入力と合わせて、新しい経路の出力と文字列が一致することを確かめる。`preferences.ts` に `listContinuation` の文字列は残らない（R1・R2 と同じ。保存の形を保つのは部品の `normalize` と、テスト側の golden）。ホストのファイルに避けられない文字列はなかった。

### 設定画面の「編集」の節

見出し（`section[data-testid=settings-editing] > h3`）だけをホストの `EditingSettings.tsx` に残し、`editing.body` の項目を `order` の順に並べる。部品が止まったとき（または外したとき）は、その項目も消える。変更前後の DOM（要素、class、`data-testid`、name、value、文言、並び、属性）の同一性は、単体テスト（`EditingSettings.test.tsx`）と、変更前後の実ブラウザでの比較で確かめた。

### 見つけた不具合（R1 から）

背景画像を取り込む処理（`App.tsx` の `pickImage`）が、設定を検証し直すときに、部品の設定の定義を渡していなかった。そのため、取り込みの後、部品の設定（R1 のタイプライターモード、R2 のフォーカスモード）が保存の形から落ちていた（変更前のコミットで、`focusMode: true` で取り込むと、保存された設定から `focusMode` が消えることを確認）。リストの継続は、変更前は本体の設定だったので落ちなかった。部品にすると同じ経路で落ちて、振る舞いが変わるので、R3 で定義を渡すように直した（タイプライターモード、フォーカスモードの同じ不具合も同時に直る）。e2e（`tests/e2e/plugin-settings.spec.ts`）で、取り込みの後も設定が保たれることを確かめる。

### N-R2-1: next の例外

`settings.update` の `next` は、`setPrefs` の更新関数の中で呼ばれる（`run` が戻った後のことがある）ので、`run` を包む例外の隔離（レジストリの `guard`）に捕まらなかった。レジストリが、部品に渡す `CommandContext` の `update` を包み、`next` を、例外なら部品を止めて今の値を返す関数に差し替えた（止め方は、`run` の例外と同じ `stop`。止めた部品の `next` は呼ばない）。ホスト側の `updateStoredSetting` は、`next` が今の値をそのまま返したとき、設定を検証し直さずに直前の設定をそのまま返す（止めた部品の検証の関数は既定値を返すので、検証し直すと設定が前の値から変わってしまう。同じ値の更新は、再描画も保存も起こさない）。単体テスト: `registry.test.ts`（`next` が遅れて例外、すぐ例外、止めた部品の後片付け、止めた後は `next` を呼ばない）と、`commandContext.test.ts`（本体の更新の写しの上で、設定が前の値のまま・描画が例外にならない・StrictMode の 2 回呼びでも止めるのは 1 回）。

限界（変更前からのこと）: 部品が止まった後は、その部品の検証の関数が既定値を返すので、次に本体の別の設定を変えて検証し直すと、止めた部品の設定の値は既定値に戻る（定義は残すので、キーは保存から消えない）。止めた部品の保存値をそのまま残すかは未決。

### N-R2-2: next の文書

`types.ts` の `CommandContext.settings.update` に書いた: `next` は副作用を持たない純粋な関数にする。ホストは `next` を React の更新関数の中で呼ぶので、2 回以上呼ばれうる（StrictMode の開発ビルド）。`update` を呼んだ時点では呼ばれず、遅れて呼ばれうる（`update` が戻った時点で設定が変わっているとは限らない）。例外は、その部品を止める。

### N-R2-3: 変換の確定後の待ち

IME の変換が終わってから、保留した再計算をするまでの待ち（60 ms）の定数 `AFTER_COMPOSITION_MS` を、`src/plugin-api/conventions.ts`（共通の約束）に置き、公開 API の index から出した。本体の記法の隠し方（`markdownDecorations.ts`）とフォーカスモードの部品（`focusMode.ts`）が、そこから使う。値は 60 のまま。単体テスト（`conventions.test.ts`）が、定義が 1 か所だけであること、2 つのファイルが import していること、60 が残っていないことを確かめる。

### ホストが部品を知らないことの縛りの拡張

`architecture.test.ts` の、ホストのファイルの名前の検査に、`listContinuation`、`ListContinuation`、`insertNewlineContinue`、`setListContinuation` を足した（大文字小文字を問わず、コメントを含む）。対象のファイルに、`ui/EditingSettings.tsx` と `ui/SettingsDialog.tsx` を足した。`src/features/list-continuation/` のファイルが import の縛りの対象になっていること、本体の設定の型（`src/preferences/`）を import しないことも確かめている。`EditorAdapter` から `setListContinuation` を外した。

### R3 の限界

- 選択肢の項目は、「編集」の節の本文にだけ置ける。置き場所ごとの種類の対応（`SETTINGS_PLACEMENT_KINDS`）は、置き場所を足すたびに決める。
- 選択肢の項目の値は文字列だけ。値の型を保証するのは、部品の `normalize`。
- ラジオの name は、本体のラジオとの重なりを検査していない（上記）。

## R4 で決めた細部

R4（2026-11-04）で、Markdown の見た目を 4 つ目の同梱の部品（`src/features/markdown/`）にした。見出し・強調・リンクなどの装飾、記法記号の隠し方（ADR-004）、チェックボックスのクリックでの切り替え、⌘/Ctrl+クリックでリンクを開く操作、設定「記号の表示」とその設定画面の項目を、この部品が持つ。振る舞い、設定ファイルの形、DOM（`.cm-md-*` の class と付く要素）は変えていない。API の版は 0 のまま。外からの読み込み、隔離（段 1・段 2）、権限の画面は対象外。

### 本体が残すもの: 約束「Markdown の文書には、本体が Markdown の言語を入れる」

本体は、文書の種類に応じた言語の設定だけを持つ（`src/editor/codemirror/textKind.ts`）。Markdown の文書には `markdown({ base: markdownLanguage })`（構文木と、lang-markdown の Enter のキー割り当て）を入れ、素のテキストには空行の高さ（class `cm-md-blank`）だけを付ける。

- 言語を本体に残した理由: 構文木と lang-markdown の Enter は、Markdown の見た目の部品だけでなく、リストの継続（Enter の優先順位）とフォーカスモード（段落の分け方）の部品も頼る。見た目の部品に入れると、その部品を止めたとき（またはなくしたとき）に、ほかの 2 つの部品が動かなくなる。
- 部品との約束（変えないこと）: Markdown の文書には、本体が Markdown の言語を入れる。部品は言語を入れず、構文木を読むだけにする。素のテキストには入れない。この約束を変えるときは、API の版を上げる。契約の表（「変えないこと」）に準じる。
- 空行の高さを本体に残した理由: 段落間隔は外観の設定で、Markdown の記法ではないので。素のテキストの空行には本体が `cm-md-blank` を付ける。Markdown の文書の空行（コードフェンスの中を除く）には、部品が同じ class を付ける。class の指定（高さ）は本体のテーマに 1 つだけある。
- 拡張の順序: 言語は、これまでと同じ位置（文書の種類の Compartment。部品の拡張より前）に入れる。lang-markdown の Enter は自分で `Prec.high` を付けるので、キー割り当ての順は変わらない。Enter の優先順位は、単体テスト（`bundledPlugins.test.ts` の「Enter priority is unchanged」。変更前のコミットで調べた並びと同じ）が変更後も通ることで確かめた。部品の一覧では、Markdown の見た目を先頭に置く（これまで、装飾が言語と一緒に、ほかの部品の拡張より前にあったので、行の装飾の重なりの順を変えないため）。
- N-R4-2（R4 のレビューの注記。ソースで確かめた範囲）: リンクを開く操作（`linkOpen.ts`）とチェックボックスの切り替え（`taskToggle.ts`）の `mousedown` の処理は、R4 の前は本体が決めた位置（文書の種類と部品の拡張のあと、検索のパネルの前）に常に入っていたが、R4 のあとは Markdown の見た目の部品の拡張の中（部品の Compartment の中。`index.ts` の並びは、装飾、リンクを開く操作、チェックボックスの切り替え、テーマ）に入る。確かめられたことは 3 つ。(1) 2 つの処理の前後は変わっていない（R4 の前の `CodeMirrorAdapter.ts` は `linkOpenExtension`、`taskToggleExtension` の順で、部品の中も `linkOpenExtension`、`taskToggleExtension` の順。どちらもリンクを開く操作が先に受けて、リンクの上の ⌘/Ctrl+クリックなら CodeMirror に渡さずに止める）。(2) 変わったのは、ほかの拡張との前後。R4 の前は、ほかの 3 つの部品（フォーカスモード、リストの継続、タイプライターモード）の拡張の後ろにあったが、R4 のあとは、それらより前（部品の一覧の先頭）にある。ただし `src/` で `mousedown`、`pointerdown`、`domEventHandlers` を持つのは、この 2 つと、本体の `compositionend`（`CodeMirrorAdapter.ts`）だけで、ほかの 3 つの部品は `mousedown` を扱わないので、この前後の変化で処理の結果が変わる組み合わせは、ソースの上では見つからなかった。(3) 部品の Compartment の中にあるため、設定「記号の表示」や文書の種類が変わると、この 2 つの処理は作り直される（R4 の前は、作り直されなかった）。位置が同じなので、順序は変わらない。R4 の前後で結果が違う操作は、ソースの読みだけでは特定できていない（リンクとチェックボックスのクリックを扱う e2e の `live-markup.spec.ts` は、R4 のあとも通っている）。
- N-R4-1（R4 のレビューの注記。ソースで確定）: `.txt` と `.text` で、`cm-md-link-ready`（⌘/Ctrl を押している間、本文に付く class）が付かなくなった。原因は、この class を付ける `linkReady` の StateField が `linkOpen.ts` の中にあり、`linkOpen.ts` が Markdown の見た目の部品の拡張（`create` が、素のテキストでは `[]` を返す）の中に移ったため。R4 の前は、本体が文書の種類によらず `linkOpenExtension` を入れていたので、`.txt` でも StateField があり、修飾キーを押すと class が付いた。いま `.txt` には StateField がないので、class が付かない。見た目の影響はない: class に結び付く指定は `&.cm-md-link-ready .cm-md-link`（`theme.ts`）だけで、`.cm-md-link` は素のテキストには付かない。
- 部品がないときの見え方: 本体は「素のテキストのエディタ」になる。Markdown の文書でも、見出し・強調・記号の隠し方・チェックボックス・リンクの操作がなく、本文は書かれたとおりに出る（Markdown の言語は入るので、Enter でのリストの継続は動く。空行の高さの設定も、Markdown の文書では部品が付けるので効かない）。部品が止まったとき（例外）も同じ見え方になる。設定「記号の表示」の項目は、部品がなければ設定画面に出ない（保存された値は、部品が読み込まれない間は次の保存で消える。R1 の「設定の保存の扱い」と同じ限界）。

### 共通の道具: `isBlankLine`

空白だけの行の判定は、本体（素のテキストの空行の高さ）と部品（Markdown の空行の高さ）の両方が使う。R2 の `frontmatterEndLine` と同じく、`src/plugin-api/lines.ts` に置き、公開 API の index から出した（判定は変更前と同じ。単体テストを `lines.test.ts` に移した）。ぶら下げインデントの判定など、部品だけが使う `lineKinds.ts` は部品の中に移した。

### 本体が部品に貸す機能（`HostServices`）

`EditorExtensionEnvironment`（拡張を作る関数 `create(value, env)` の第 2 引数）に、2 つの関数を足した。`HostServices` として、型は `src/plugin-api/types.ts`。

- `openExternalUrl(url)`: 外部の URL を既定のブラウザで開く。本体の今の経路を通る。`http` と `https` だけを開き、ほかの URL（`javascript:`、相対パス、`file:` など）と、開くのに失敗したときは、トースト「このリンクは開けません」で知らせる（実装は `src/platform/hostServices.ts`。App が `createHostServices` で作って、エディタに渡す。ネイティブ側の `open_external_url` の検査は、これまでどおり残る）。戻り値はない。
- `isMacPlatform()`: 使っている OS が macOS か。判定は変更前の `isMacPlatform`（`src/ui/shortcuts.ts`）と同じ。呼んだ時点で判定する（リンクを開く修飾キー ⌘ と Ctrl の切り替えに使う）。

形を `env` に置いた理由（`ctx` でなく）: (1) `ctx` は、activate の中で登録するための口で、activate の中では何も始めない（登録だけ）という規則がある。副作用のある関数を `ctx` に置くと、activate の中で呼べてしまい、「利用者の操作のときだけ呼ぶ」が守りにくい。`env` は、拡張を作る関数の中だけで受け取り、拡張の中のイベント処理（クリックなど）が持ち歩く形になる。(2) 文書の種類（`textKind`）と同じく、ホストが今の編集の場について渡す情報で、エディタの拡張だけが使う。(3) 止めた部品の呼び出しを止める場所が 1 か所（レジストリ）で済む。取らなかった案: `ctx` に置く（上の理由）、部品が `bridge` やプラットフォームの判定を直接 import する（隔離できない。architecture.test.ts が、部品から `preferences`・`shortcuts`・`platform`・`ui`・`editor` を import しないことを確かめる）。

権限の扱い（権限の表との関係）:

- 権限の表の「操作のたびに確かめる」にある「リンクを開く」の、最初の例。段 3（同梱の部品と、信頼した部品）だけに貸す。段 3 は、権限の表を強制できない（同じ空間で何でも呼べる）ので、ここでの扱いは「何を使うつもりか」の申告と、規則による縛りにとどまる。
- 規則: 利用者の操作（⌘/Ctrl を押しながらのクリックなど）に応えるときだけ呼ぶ。起動時、タイマー、文書の変更への反応から呼ばない。呼ぶのは、本体が確かめて開ける URL（http と https）に限られる。ネットワークの API ではないが、本文を URL に入れて開けば外へ持ち出せる（S4 の悪意のある部品）ので、貸す相手は信頼した部品に限る。
- 段 1・段 2 に貸すときは、「操作のたびに確かめる」を実装する必要がある。部品が呼ぶたびに、本体が URL を見せて利用者に確かめ、確かめた結果は保存しない。段 1・段 2 には、`postMessage` の向こうの非同期の API として貸し、同期の `env` の関数は渡さない（今回は実装しない）。
- 部品が止まった後（例外で止めた、解除した）は、呼んでも何もしない（止める前に作った拡張がエディタに残っていても、レジストリが包んだ関数が何もしない）。URL が文字列でないときは、呼んだ部品の側に例外を返す。本体の側の例外は、部品のせいではないので部品は止めず、記録だけする。
- 単体テスト: `registry.test.ts`（呼び出しが本体の関数に届く、OS の判定、止めた後・解除後は何もしない、文字列でない URL、本体の側の例外）、`hostServices.test.ts`（http・https は bridge へ、開けない URL とブリッジの失敗はトースト「このリンクは開けません」、部品の呼び出しが同じ経路に届く）、`features/markdown/plugin.test.ts`（クリックで部品が URL を本体に渡す。macOS は ⌘ だけ、ほかは Ctrl だけ）。

### 設定画面の「外観」の置き場所

置き場所 `appearance.body`（「外観」の節の本文。`editing.body` と同じ命名: `<節>.<節の中の置き場>`）を足した。種類は `radio` だけ（`SETTINGS_PLACEMENT_KINDS`）。項目は自分の枠（fieldset と legend）を持つ。ラジオの DOM と name の規則は R3 と同じ（共通のコンポーネント `src/ui/RadioSettingsItem.tsx` に切り出し、「編集」の節と共有した）。

順序の決め方: 本体の枠も、部品の項目と同じ `order` の尺度に載せる。本体の枠は 100 刻みで、描く順に、フォント 100、文字組み 200、紙の幅 300、テーマ 400、背景 500、コントラスト 600、執筆の補助 700（`HOST_APPEARANCE_ORDER`。公開 API から出す）。部品の項目は、この間の数を選ぶ（「記号の表示」は、紙の幅とテーマの間の 350）。同じ数のときは、本体の枠が先、部品の登録の順（安定した並べ替え）。変更前の並び（フォント、文字組み、紙の幅、記号の表示、テーマ、背景、コントラスト、執筆の補助）と DOM は同じになる。

「執筆の補助」の枠の中（`appearance.writingAids`）は、これまでどおりチェックボックスの並びで、枠は本体が持つ。取らなかった案: 本体の枠どうしの間に名前つきの置き場所を並べる（枠が増えるたびに置き場所が増える）、部品が「どの枠の前・後」と指定する（枠の名前が部品の契約になり、本体の枠の並べ替えで壊れる）。

### 設定の保存

設定のキー `markupDisplay`（文字列 `'cursorLine'` または `'always'`）は、これまでと同じ最上位のまま。`preferences.ts` から `MarkupDisplay` の型、`Preferences.markupDisplay`、既定値、正規化を外し、部品が `registerSetting` で登録する（正規化は同じ: 2 つの値以外は `'cursorLine'`）。保存されるバイト列は変更前と同じ。`storedShape.golden.json` に、変更前のコミットの出力から作った 12 の入力（`markupDisplay` が `cursorLine`、`always`、範囲外の文字列、大文字違い、空文字、数値、真偽値、null、配列、オブジェクト、キーなし、`always` と範囲外のほかの項目）を足し、既存の 21 と合わせて、新しい経路の出力と文字列が一致することを確かめる。ホストのファイルに避けられない文字列はなかった（R1〜R3 と同じ。保存の形を保つのは、部品の `normalize` と、テスト側の golden）。

### 見た目の置き場所

Markdown の見た目（見出し、コードフェンスの帯、引用の縦線、記号を隠した行の • とチェックボックス、リンクの準備）は、これまで本体のエディタのテーマにあった。部品のテーマ（`src/features/markdown/theme.ts`）に移した。class 名と付く要素は変えていない。`styles.css` には、`.cm-md-*` の指定はもともとなく、移したものはない（色は CSS 変数で、本体が決める）。空行の高さ（`cm-md-blank`）だけ、本体のテーマに残る。

R1・R2 と同じく、部品のテーマは CodeMirror が自動で付ける class（`ͼ` で始まる名前）を 1 つ増やすので、Markdown の文書では `.cm-editor` の class の数が 1 つ多い。素のテキストでは、部品が何も足さないので、文書の種類に応じた class の合成が 1 つ減り、`.cm-editor` の class 属性の末尾の空白がなくなる。原因は、変更前にあった、リンクを開く準備の状態（`linkReady`）が、`editorAttributes` として class `''`（空）を足していたこと（R6 でソースで確定した。`@codemirror/view` の `combineAttrs` は、すでに class があれば `target.class += " " + source.class` と足すので、空の class でも区切りの空白だけが付く。`.txt` では `linkReady` がなくなったので、その空白もなくなる。N-R4-1 と同じ原因）。どちらも CSS に影響しない。変更前後の実ブラウザでの比較で、スクリーンショットの画素と、行・要素の class・位置・属性の記録は、この 2 点を除いて一致した。

### ホストが部品を知らないことの縛りの拡張

`architecture.test.ts` の、ホストのファイルの名前の検査に、`markupDisplay`、`MarkupDisplay`、`liveMarkup`、`taskToggle`、`linkOpen`、`markdownDecorations`、`lineKinds`、`cm-md-`（ただし `cm-md-blank` は除く）を足した（大文字小文字を問わず、コメントを含む）。ホストの一覧から `taskToggle.ts` を外し（部品に移った）、新しく本体に入ったファイル（`textKind.ts`、`RadioSettingsItem.tsx`）を足した。`src/features/markdown/` のファイルが import の縛りの対象になっていること、部品から本体の設定・OS の判定・bridge・画面・エディタを import しないことも確かめている。`EditorAdapter` から `setMarkupDisplay` と `onOpenLink` を外し、`createCodeMirrorAdapter` は本体が貸す機能を受け取る。

### R4 の限界

- 段 1・段 2 に貸す『外部の URL を開く』の「操作のたびに確かめる」の画面は、未実装（段 1・段 2 自体が後の Run）。
- `env` の関数は、段 3 の同期の API。非同期の API として貸す形は、段 2 の Run で決める。
- 部品がなければ、Markdown の文書の空行の高さの設定は効かない（素のテキストでは、本体が付ける）。
- 利用者の操作のときだけ呼ぶ、という規則は、段 3 では強制していない（呼ぶ側の規則）。
- Windows と Linux の実機で、リンクを開く修飾キーの判定を確かめていない（偽装した navigator での e2e のみ。変更前と同じ）。

## R5 で決めた細部

R5（2026-11-04）で、隔離した操作の段（段 2）の土台を作った（案 2a）。配布物に入るのは仕組みだけで、段 2 の部品は 1 つも入れていない（利用者に見える機能は足していない。最初の部品 S2 と、権限の確認の画面は R6）。API の版は 0 のまま。

### plug: の形と、返すファイル

Rust 側（`src-tauri/src/plug.rs`）が、独自プロトコル `plug` を `register_uri_scheme_protocol` で登録する。返すのは、ビルド時に `include_str!` で埋め込んだ 2 つのファイルだけ。ファイルシステムから読まない。

- `/host.html`: Worker のホストのページ（`text/html; charset=utf-8`）。
- `/relay.js`: 仲介のコード（`text/javascript; charset=utf-8`）。

名前の解釈（`..`、パーセントエンコード、大文字小文字、先頭の `/` の補完）はしない。決めた文字列と完全に一致するパスだけが 200、それ以外はすべて 404（空、`/`、`..`、`%2e%2e`、`%2f`、絶対パス、`//`、大文字違い、末尾の `/`、`;` を含む）。クエリは名前の判定に使わない。GET と HEAD 以外は 405。単体テストは `plug.rs`（9 件）。

応答のヘッダー（200 も 404 も同じ）: `Content-Security-Policy: default-src 'none'; script-src plug:; worker-src blob:`、`X-Content-Type-Options: nosniff`、`Content-Type`（200 のみ `Cache-Control: no-store`）。CSP は K2 の結果どおり `'self'` ではなく `plug:` と書いた。そのまま動いた（変更は不要だった）。

本体の CSP に足したのは `frame-src plug:` だけ（`script-src` などは変えていない）。`architecture` の単体テストが、本体の CSP の全指令を列挙して縛っている。新しい crate は足していない（`Cargo.lock` は変わらない）。

### 元は 1 か所、配信は 2 通り

ホストのページと仲介のコードの元は `src/plugin-host/`（`host.html`、`relay.js`）の 1 か所。vite を通さず、元のバイト列のまま配信する。

- Tauri 版: `plug.rs` が埋め込んで返す。
- ブラウザ版（e2e のビルドと dev サーバー）: `vite.config.ts` の小さな plugin が、同じファイルを同じオリジンの `/plug/` から返す。ビルドでは `VITE_E2E=1` のときだけ `plug/` に書き出す（本番の `dist` には出さない。CI が見る）。
- 同じ中身であることの縛り: Rust のテスト（埋め込んだ文字列とディスクのファイルが一致）、e2e（配信されたバイト列と元のファイルが一致）、`architecture` の単体テスト（`plug.rs` と `vite.config.ts` が同じ元と名前を指す）。

ブラウザ版はヘッダーがないので、`host.html` の `meta` で CSP を指定する。meta の CSP は `default-src 'none'; script-src plug: 'self'; worker-src blob:`。ヘッダー（Tauri 版）との違いは `script-src` の `'self'` だけで、理由は、ブラウザ版の `relay.js` が http のオリジンから読まれるため（`plug:` は一致しない）。Tauri 版は、同じ meta も効くが、ヘッダーの `script-src plug:` との積になるので、`plug:` だけが通る。`worker-src blob:` と `script-src` が meta で効くことは、e2e（Chromium）で、Worker が動くことと、本体の origin へのネットワークが止まることから確かめた。

### 構造

本体は `sandbox="allow-scripts"` の iframe（`allow-same-origin` なし）を 1 つ作る。iframe の中で、`relay.js` が、部品ごとに、部品のコードの文字列から blob の Worker を作る。`relay.js`（iframe の主の文脈）は部品のコードを評価しない（`eval`、`new Function`、script の挿入、`importScripts` をしない。`architecture` が `relay.js` を読んで確かめる）。部品のコードは、Blob にして Worker に渡すだけで、Worker の中でだけ動く。iframe は、最初の段 2 の部品を起動するときに作る。段 2 の部品がないときは、iframe も `message` の受け口も作らない（`main.tsx` は、部品が 1 つもなければホストを作らない）。

部品の Worker は 1 部品 1 Worker。iframe は共有する（部品の隔離は Worker の境界で、iframe は仲介のコードの置き場）。

### メッセージの形（postMessage だけ）

すべてのメッセージに版 `v: 0` が付く。決めた種類と形（項目の集合、型、長さ）だけを通す。形の検査は、`relay.js`（Worker からのもの）と本体の `protocol.ts`（iframe からのもの）の両方でする（`relay.js` が壊されたときに備え、本体は iframe を信用しない）。

| 向き | 種類 | 項目 |
|---|---|---|
| 本体 → 仲介 | `start` | `plugin`、`source` |
| 本体 → 仲介 | `run` | `plugin`、`req`（1 から増える整数）、`command` |
| 本体 → 仲介 | `stop` | `plugin` |
| 仲介 → 本体 | `hello` | なし（仲介のコードの準備ができた合図。本体は、これを受けるまで `start` を送らず溜める） |
| 仲介 → 本体 | `command` | `plugin`、`id`、`title`、`shortcut?`、`ignoreInTextEntry?` |
| 仲介 → 本体 | `ready` | `plugin`（部品のコードの最初の実行が終わった） |
| 仲介 → 本体 | `done` | `plugin`、`req` |
| 仲介 → 本体 | `failed` | `plugin`、`req`、`reason`（実行が例外を出した） |
| 仲介 → 本体 | `stopped` | `plugin`、`reason`（仲介が Worker を止めた） |
| 仲介 ↔ Worker | `init`、`run` / `command`、`ready`、`done`、`failed` | 上の `command` などから `plugin` と `v` を除いたもの |

上限: 1 部品のコマンドは 32 個まで、`id` は 64 文字（小文字の英数字とハイフン）、`title` は 200 文字、`shortcut` は 32 文字、`reason` は 300 文字、`source` は 1 MiB、結果待ちの実行は 1 部品 16 個まで（超えた要求は捨てる。キーの連打で積み上げない）。

状態機械（部品ごと。仲介と本体の両方で見る）: `starting` → `ready` → `stopped`。`command` は `starting` の間だけ。`ready` は 1 回だけ。`done` と `failed` は、本体が `run` で要求した番号のものだけ。外れたメッセージは不正として、その部品を止める。要求の番号は、本体が付ける。

送り元の確認: 本体は、受けた `message` イベントの `event.source` が、その iframe の `contentWindow` と同一であることを確かめる（`origin` は `'null'` になるので、判定に使わない）。仲介も、`event.source` が `window.parent` であることを確かめる。e2e で、本体の窓自身から送った偽のメッセージ（`stopped`、`command`）が無視されることを確かめた。

MessageChannel は使わない。理由: iframe の中の仲介のコードは、本体が書いた信頼するコードで、部品ごとの分離は Worker の境界が受け持つ。ポートを部品ごとに渡しても、本体と仲介の間は、最初の受け渡し（`hello` と、ポートの移譲）に `event.source` の確認が要り、それ以後の検査（形、状態機械）は同じ。ポートごとに分けても、`relay.js` が壊されたときの上限は変わらない。取らなかった案であり、部品ごとの iframe に分けるときに、あらためて検討する。

### 時間切れと止め方

- 部品のコードの最初の実行（トップレベル）が `ready` を返すまで: 既定 5000 ms（`start` から。iframe の読み込みを含む）。
- コマンドの実行が `done` を返すまで: 既定 5000 ms。本体は結果を待たない（`run` は戻り値なしで返り、本体の入力は止まらない）。
- どちらも、e2e のビルドは seed で短くできる。

止める契機は、(1) 部品の例外（トップレベルの例外は Worker の `error` イベント、実行の例外は `failed`）、(2) 時間切れ（無限ループ）、(3) 不正なメッセージ、(4) 登録の検査（ショートカットの形、コマンドの id の重なり、ショートカットの重なり。段 3 のコマンドとも検査する）に通らない。止めるときは、仲介に `stop` を送って Worker を `terminate` し、Blob の URL を取り消し、以降その部品のメッセージは何も通さない（仲介も本体も捨てる）。レジストリは、その部品の登録を全部外し、状態を `stopped`、`reason` に理由を残し、`console.error` に `[plugin] 部品「<id>」を止めました: <理由>` を出す（段 3 の部品と同じ記録）。ほかの部品とアプリは動き続ける。

限界: 無限ループの部品は、時間切れまでの間（既定 5 秒）、Worker の中で CPU を使い続ける（別スレッドなので、本体の入力は止まらない）。その間に出した別の実行の要求は、Worker の中で順番待ちになり、それぞれが時間切れで部品を止める。仲介の iframe 自体が応答しなくなった場合の検出（`terminate` が届かない場合に iframe ごと作り直す）は、していない。

### 段 2 の部品の渡し方と API

形は `{ manifest, source }`（`ActionPlugin`）。R1 の `Plugin`（`{ manifest, activate }`）の隣に並べ、`manifest.tier` で分ける（`'editor'` は `activate`、`'action'` は `source`）。レジストリは `Plugin | ActionPlugin` の一覧を受け取る。`source` は、Worker で動くクラシックスクリプトの文字列。Worker のグローバルに `api`（凍結したオブジェクト）があり、R5 の API は `api.registerCommand({ id, title, shortcut?, ignoreInTextEntry?, run })` だけ。登録は `source` の最初の実行の間（トップレベル）だけ。`run` は非同期でよく、引数も戻り値もない（R5 は、本体のデータを読む API も、結果を返す API もない）。ショートカットの判定と重なりの検査は、段 3 のコマンドと同じ規則（`parseShortcut` と `matchesShortcut`。登録されたコマンドは、同じ `findCommandByKey` で引かれる）。ショートカットは、CodeMirror の既定のキー（`Mod+Shift+K` の行削除など）と重なると、先にエディタが処理する（段 3 のコマンドと同じ。R5 で見つけたこと。e2e の部品は、重ならないキーを使う）。

`manifest.permissions` は R5 では宣言できない（空の配列以外は読み込まない。`incompatible`）。権限の確認の画面と一緒に R6 で足す。段 2 は、権限の表の「宣言だけで使える」もののうち、R5 ではコマンドとショートカットだけが使える。

レジストリは、`IsolatedPluginHost`（`plugin-api` が型だけ持つ口）を、オプションで受け取る。実装は `src/plugin-host/` で、レジストリはこれを import しない。ホストを渡さずに段 2 の部品を渡すと、その部品は `incompatible`（「この環境では使えません」）になる。

### 鍵の縛り

段 2 の仕組みのコード（`src/plugin-host/` のテストを除く全部と、`src/isolated-plugins/index.ts`、`src/plugin-api/registry.ts`、`src/plugin-api/types.ts`、`src/main.tsx`）に、`Tauri-Invoke-Key`、`__TAURI_INTERNALS__`、`__TAURI__`、`invoke`、`ipc:` の文字列が出てこないことを、`src/plugin-host/architecture.test.ts` が縛る（コメントを含む）。除くのは検証用のコードだけ: `src/isolated-plugins/e2eFixtures.ts`（本体への到達を試す e2e 用の部品）と `src/isolated-plugins/probe.ts`（隔離の検証用。鍵を扱う）。どちらも本番のビルドに入らない。除外が空振りしていないこと（除いたファイルに、実際にそれらの文字列があること）も同じテストで確かめる。`src/plugin-host/` は、`src/plugin-api/` と自分のファイルだけを import する（`features`、`platform`、`bridge` を import しない）。

### 検証用のコードが配布物に入らない縛り

- フロントエンド: `VITE_ISOLATION_PROBE=1` の define（`__ISOLATION_PROBE__`）と `__E2E__` の中だけで `import()` する。本番の `dist` に、印 `__mdeIsolationProbe`、記録用のコマンド名 `isolation_probe_`、段 2 のテスト用の部品の印 `__mdeE2EActionFixture` が出ないことを、`.github/workflows/ci.yml`（既存の grep の検査に足した）と、`check-probe-absent.mjs` が見る。`dist/plug/` が出ないことも見る。
- Rust: Cargo の feature `isolation-probe`（既定では無効）。記録用のコマンド（`src/probe.rs`）、検証用のページを返す `plug.rs` の項目、`build.rs` のコマンドの一覧、`lib.rs` の `generate_handler` への追加、`main` 窓への許可（実行時に `add_capability`。`capabilities/` のファイルには書かない）は、すべて feature のときだけ。feature 付きのビルドが書く許可のファイル（`permissions/autogenerated/isolation_probe_*.toml`）は、`build.rs` が、ビルドの前と後に消す（残ると feature なしのビルドにも許可が入る。実際に起きたので、そのテストを足した）。
- 検査: `lib.rs` の `probe_gate_tests` が、ビルドが出力した ACL の生成物（`OUT_DIR`）に、feature なしのときは記録用のコマンドも許可もなく、feature のときはある（対照）ことを確かめる。feature なしの `plug.rs` が検証用のページに 404 を返すことも、テストで確かめる。実行ファイルについては、`check-probe-absent.mjs` が、通常の debug ビルドに印がなく、検証用のビルドにはある（対照）ことを確かめた。

## R5 で確かめた隔離

方法: Cargo の feature `isolation-probe` と `VITE_ISOLATION_PROBE=1` の両方を有効にした debug ビルド（`tauri.mjs build --probe`。通常の実行ファイルとは別の target ディレクトリ）を、macOS の実際の Tauri の窓として、run 専用の HOME で起動した（`isolation-probe.mjs`。OS のキー入力・マウス操作は送らない）。起動すると、検証用の段 2 の部品（`src/isolated-plugins/probe.ts`）が、本物の `plug:` と本物の `relay.js` の上で動く。Tauri 2.12.5、wry 0.57.1、WKWebView、macOS のみ。release ビルド、Windows（WebView2）、Linux（WebKitGTK）は未確認。

届いたかの判定は、webview 側の自己申告ではなく、2 つの記録による:

- ネイティブ側: 記録用のコマンド `isolation_probe_canary` が、呼ばれるたびに、環境変数 `MDE_PROBE_OUT` のディレクトリの `canary.log` に 1 行（`<文脈>:<経路>`）を書く。
- ネットワーク: 127.0.0.1 の受け口（`isolation-probe.mjs` が run のあいだだけ立てて止める。宛先は 127.0.0.1 だけ）の `net.log`。

対照（届くはずの経路が、実際に届くこと）: 本体の `invoke`、本体の `webkit.messageHandlers.ipc.postMessage`（鍵あり）、`isolation-probe.mjs` 自身から受け口への接続。3 つとも記録に出た。したがって、記録の仕組みと、呼び方の形は正しい。

結果（判定は `PASS`: 鍵なしで届く経路は、なかった）:

| 文脈 | 経路 | 鍵 | 記録 | 届いたか |
|---|---|---|---|---|
| Worker（部品のコード） | `fetch` と XHR で `ipc://localhost`、`fetch` で `http://ipc.localhost` | なし | `canary.log` | 届かない（3 経路とも） |
| Worker | 同じ 3 経路 | 漏れたと仮定（本体が部品に渡した） | `canary.log` | 届かない（3 経路とも） |
| Worker | `fetch`、XHR、WebSocket、`importScripts`、`EventSource`、入れ子の blob の Worker から 127.0.0.1 | 鍵なし／あり | `net.log` | 届かない（6 経路 × 2） |
| Worker | `postMessage` で決めていない 3 つの形（未知の種類、要求していない `done`、鍵つきの `invoke` の形）を仲介へ | あり（1 つ） | `canary.log` と本体の記録 | 届かない。仲介が Worker を止め、本体の記録に「不正なメッセージ」と出た（3 つとも） |
| Worker | 本体と同じ名前の BroadcastChannel | - | 本体のページが聞いたか | 聞こえない |
| Worker | `__TAURI_INTERNALS__`、`__TAURI__`、`isTauri`、`webkit`、`ipc`、`origin`（自己申告） | - | - | `undefined` が 5 つ、`origin` は `null` |
| 仲介と同じ条件の文脈（`plug:` の sandbox の iframe、同じ CSP のヘッダー。仲介のコードが壊された場合の上限） | `fetch` と XHR で `ipc://localhost`、`fetch` で `http://ipc.localhost` | なし／あり | `canary.log` | 届かない（6 経路） |
| 同上 | `webkit.messageHandlers.ipc.postMessage` | なし | `canary.log` | 届かない（`posted` は返るが、記録なし） |
| 同上 | `webkit.messageHandlers.ipc.postMessage` | 漏れたと仮定 | `canary.log` | 届いた（1 行） |
| 同上 | `window.ipc.postMessage` | 漏れたと仮定 | - | 存在しない（`window.ipc` は `undefined`） |
| 同上 | `fetch`、XHR、画像、`sendBeacon`、WebSocket、入れ子の blob の Worker から 127.0.0.1 | - | `net.log` | 届かない（6 経路） |
| 同上 | `parent.document`、`parent.__TAURI_INTERNALS__`、`top.location` | - | - | 3 つとも `SecurityError`（自己申告） |

読み方:

- 鍵なしで届く経路は、Worker にも、仲介と同じ条件の文脈にも、見つからなかった。鍵ありで届いたのは、1 つだけ: 仲介と同じ条件の文脈からの `webkit.messageHandlers.ipc.postMessage`。これは、R0 の K1 の「独自プロトコルの iframe は `postMessage` の経路で破られる」を、製品の構成（`plug:`、sandbox、同じ CSP のヘッダー）で再確認したもの。K1 の未検証の項目だった「鍵が漏れたときの `postMessage` の経路を、ネイティブ側で塞げるか」は、この構成では塞がっていない（鍵が漏れた場合）、が答え。
- Worker は、鍵を渡しても届かなかった。`webkit` が Worker にない（`undefined`）ので、`postMessage` の経路がない。`ipc://` と `http://ipc.localhost` は、鍵があっても記録に出なかった。止めている層は、Worker では特定できていない: iframe の CSP（`default-src 'none'` の `connect-src`）と、`Origin` が `null` であることによる、ネイティブ側の拒否の両方が考えられる。WebKit の Worker は `securitypolicyviolation` を出さず（自己申告の `csp` が空）、CSP だけを外した対照は取っていない。仲介と同じ条件の文脈では、`securitypolicyviolation` で、`ipc://`、`http://ipc.localhost`、127.0.0.1 の接続が CSP の `connect-src` と `img-src` に止められたことが見えた。
- 仲介のコードが壊されても、鍵がなければ届かない。鍵は、本体（メインフレーム）の定数で、段 1・段 2 の文脈には存在しない。この検証で鍵を渡したのは、検証用のビルドだけの模擬。製品のコードは、鍵を取り出さず、渡さない（architecture の縛り）。

鍵が漏れた場合に塞ぐ手立ての提案（R5 では直さない。どれも未検証）:

1. 鍵の秘匿を、今のとおりコードの規則と単体テストで守る（鍵を扱う文字列が、段 2 の仕組みのコードに出ない）。仲介のコードが壊されるには、`relay.js`（固定の約 249 行。コメントを含む）の不具合が要る。
2. 案 1b / 2a の変形: 仲介のページを `plug:` ではなく `srcdoc` の iframe にする。K1 では、`srcdoc` の iframe は、鍵ありの `postMessage` も届かなかった（原因は未確認）。代償は、`srcdoc` が本体の CSP を継承するので、`relay.js` を読む `script-src` と、Worker を作る `worker-src blob:` を、本体の CSP に足す必要があること（本体の空間の CSP が広がる）。この構成での `postMessage` と、本体の CSP の広がりを、実装して確かめてから決める。
3. ネイティブ側で、`postMessage` の経路を、送り元のフレームの URL で拒否する。Tauri と wry が、メッセージの送り元のフレームを判別できるか、`plug:` を「ローカルでない」と扱えるかを、ソース（`webview/mod.rs` の鍵と origin の検査）で調べる。判別できないなら、上流への提案になる。
4. 検証用のページの、鍵ありの `postMessage` が届いた記録を、R6 の前に、2 の構成でも取る（R6 で最初の部品を入れる前に決める）。

未検証のまま残るもの:

- Windows（WebView2。`http://plug.localhost/` と IPC の経路が違う）、Linux（WebKitGTK）、release ビルドでの同じ確認。`hostUrl.ts` の Windows の URL は、書いただけで動かしていない。Windows では独自プロトコルが `http://plug.localhost/` になるので、本体の CSP の `frame-src plug:` と、ホストのページの CSP の `script-src plug:` が、そのままでは一致しない可能性がある（未確認。Windows に対応するときに、CSP の書き方を決め直す）。
- 窓の中でのショートカットの実行（OS のキー入力を送らない方針）。ショートカットから部品のコマンドを実行する経路は、Chromium の e2e だけ。Tauri の窓では、検証用の部品が、`start`、`command`、`ready`、`run`（`report` の実行）、`failed`、不正なメッセージの停止まで、本物の `plug:` と `relay.js` の上で動くことを確かめた。
- Worker の中で、`ipc://` と `http://ipc.localhost` を止めている層（CSP か `Origin` の検査か）。
- Worker の自己申告は、止めた理由（300 文字まで）に載せるので、鍵ありの部品の報告の末尾は切れた。判定には使っていない。
- 画像: Worker には `Image` がないので、Worker からの画像の読み込みは試していない（仲介と同じ条件の文脈では試した）。

## R5 の限界

- 段 2 の API は `registerCommand` だけ。本体のデータを読む API、設定、クリップボード、リンクを開く、は R6 以降。権限の宣言（`manifest.permissions`）と、確認の画面は R6。
- 1 つの iframe を全部の部品で共有する。仲介のコードが壊されたときの上限は、全部の段 2 の部品に及ぶ。
- Worker を止めても、実行中の `fetch` などは Worker とともに消えるが、本体の側の副作用の取り消しはない（R5 は副作用のある API がない）。
- ショートカットの重なりは、起動した順（Worker が `command` を送った順）で決まる。段 3 のコマンドは、同期の起動で先に登録されるので、段 3 が常に先。

## R6 で決めた細部

R6（2026-11-05）で、段 2 に権限の仕組みと、権限の要る API を足し、最初の同梱の段 2 の部品「パスをコピー」を入れた。API の版は 0 のまま。段 3 の部品と、既存の振る舞い（設定の形、DOM、固定のショートカット）は変えていない。

### 権限の種類と説明の文言

宣言は `manifest.permissions`（任意。段 2 の部品だけ）。権限の表の「初回に確かめる」のうち、次の 2 つ。

| 権限 | 説明（確認の画面と設定画面に出す文言） | 使う API |
|---|---|---|
| `clipboard.write` | 文字列をクリップボードに書き込む | `api.clipboard.writeText` |
| `paths.read` | 開いている文書と、ツリーで選んだ項目のパスを知る | `api.document.currentPath`、`api.registerContextMenuItem` |

「開いたフォルダのほかのファイルを読む」は、R6 の対象外（S3 の Run）。

その部品を読み込まない場合（レジストリが `incompatible` にし、理由を `reason` と `console.warn` に残す）: 知らない権限、重複、配列でない、段 3 の部品の `permissions`（空の配列でも）。権限の確認の仕組み（`PluginRegistryOptions.permissions`）がない環境で、空でない宣言のある段 2 の部品も読み込まない（R5 の「permissions は宣言できない」は、この環境の挙動として残り、理由に `permissions` を含む）。

### 確認の流れ

- いつ出すか: 部品が、宣言した権限のうち、まだ決めていないものの API を初めて使うとき。具体的には、(1) Worker の API の呼び出しを本体が受けたとき、(2) ツリーのメニューの項目を選んだとき（`paths.read`。許可されてから、部品の `run` に対象を渡す）。宣言していない権限の API は、確認の画面を出さずに、その呼び出しを拒否する。R6b で、画面を出す時機を、利用者の操作で始まった実行の中の 1 回に限った（「R6b で直したこと」）。
- 画面: `role=dialog`（`aria-modal`）。部品の名前、権限ごとの説明、「許可しない」（最初のフォーカス）、「許可する」、閉じるボタン。Tab はダイアログの中で循環する。閉じたあとのフォーカスは、開く前の場所（本文、またはメニューを開いた行）に戻る。
- 聞く範囲: 宣言した権限のうち、決めていないものを、まとめて 1 回聞く。「許可する」「許可しない」は、聞いた権限すべてに同じ結果を保存する。理由は、「パスをコピー」の初回の使用で画面が 2 回続くのを避け、部品が宣言した全体を利用者に見せるため。取らなかった案: 使う権限だけを 1 つずつ聞く。代償: 聞いたが、まだ使っていない権限も、許可すれば許可される（宣言した範囲の中）。
- Esc と閉じるボタン: 今回だけ断る。決定は保存せず（未決のまま）、その呼び出しは失敗する（理由は「確認の画面が閉じられたため、今回は使えません」）。次の使用で、再び聞く。
- 同時に出す画面は 1 つ。同じ部品の確認が出ている間に来た呼び出しは、その答えを待つ（画面を重ねない。閉じたなら、待っている呼び出しもすべて断る）。別の部品の確認は、順番を待つ。
- 時間切れ: 確認の画面を出している間は、その部品の時間切れ（最初の実行、コマンドとメニューの項目の実行）の計測を止める（`IsolatedPluginHost.suspendTimeouts`。確認の画面が出ている間は、重ねて呼んでよい）。再開すると、残りの時間から数え直す（確認を何度も出させて、時間切れを先延ばしにできない）。確認の画面が出ていない呼び出し（保存済みの結果の読み出し）では、止めている時間は一瞬。
- 拒否と、確認の画面を閉じたとき: その呼び出しだけが Worker の中で失敗する（`Promise` の reject）。部品は止めない。R5 の規則（コマンドの `run` が例外を出すと、その部品を止める）は変えていないので、部品は reject を受けて握りつぶす（同梱の部品は、そう作ってある）。拒否の理由は、部品の側で見える文（どの権限を、宣言していない、または許可されていない）。

### 保存の形と場所、取り消し

- 場所: アプリのデータ領域の `plugin-permissions.json`（`session.json` と同じ場所。設定の `preferences.json` とは別のファイル）。
- 形: `{ "version": 1, "plugins": { "<部品の id>": { "<権限>": "granted" | "denied" } } }`。決めていない権限は、キーがない。
- ネイティブ側（`src-tauri/src/plugin_permissions.rs`。自前のコマンド `load_plugin_permissions`、`save_plugin_permissions`）が、保存のたびに形と大きさを検査する: 版が 1、部品の数が 64 以下、部品の id が小文字の英数字とハイフンで 64 文字まで、権限の名前が `clipboard.write` と `paths.read` のどちらか、値が `granted` か `denied`、未知の項目がない、ファイルが 16 KiB 以下。壊れているファイル（JSON でない、形が違う、大きすぎる）は、空として読む（起動を止めない）。書き込みは原子的（`docio::save_atomic`）。
- 本体: `src/permissions/controller.ts`。起動では読まない（最初に権限が要るとき、または設定画面を開いたときに読む）。読めなければ、決定がないものとして続ける（R6b で、読めなかったあとの保存の扱いを直した）。保存は順番に行い、失敗したときは、今回の起動の間は決めたとおりに扱い、トーストで知らせる。e2e 用のメモリ実装は、再読み込みをまたいで残る（`sessionStorage`）。
- 取り消し: 設定画面の「部品の権限」の節（`settings-plugin-permissions`）に、部品ごとに、決めた権限と結果（許可、拒否）と「取り消す」を並べる（その部品の結果を、すべて未決に戻す。保存する）。決めたものがなければ「決めた権限はありません。」。読み込んでいない部品（保存済みの id）は、id を出す。取り消しは、動いている部品を止めない（次の呼び出しから、再び聞く）。節の class は `settings-permissions`（`settings-section` ではない。既存の e2e が、`.settings-section` の見出しを「外観」「編集」の 2 つと数えているため。見た目の指定は同じ）。

### API とメッセージの形

Worker の中の `api`（R5 の `registerCommand` に足す）:

- `api.clipboard.writeText(text)`: `clipboard.write`。本体が、権限を確かめてから、自前のネイティブのコマンドを呼ぶ。書けたら、本体がトースト「クリップボードにコピーしました」を出す（書けなかったときは「クリップボードに書けませんでした」）。引数の誤り（空、文字列でない、100000 文字を超える）は、メッセージを送らずに Worker の中で reject する。
- `api.document.currentPath()`: `paths.read`。開いている文書のパス。未保存の新規文書は `null`。
- `api.registerContextMenuItem({ id, title, where: 'tree', run(target) })`: `paths.read` の宣言が要る（宣言がなければ、登録を拒否して部品を止める）。`target` は `{ path, kind: 'file' | 'folder' }`。登録は、コマンドと同じく、部品のコードの最初の実行の間だけ。1 部品 8 項目まで。
- `api` の列挙できる項目は、R5 のまま `registerCommand` だけで、R6 の 3 つは列挙されなかった。R6b で、4 つとも普通に列挙される形に戻した（「R6b で直したこと」）。凍結は変わらない。

メッセージ（R5 の表に足す。すべて版 `v: 0`。形と上限は、`relay.js` と本体の `protocol.ts` の両方で検査する）:

| 向き | 種類 | 項目 |
|---|---|---|
| 仲介 → 本体 | `menu` | `plugin`、`id`、`title`、`where`（`'tree'` だけ） |
| 仲介 → 本体 | `call` | `plugin`、`call`（部品の中の番号。結果待ちの間は重ならない）、`method`（`clipboardWriteText` は `text` も、`currentPath` は項目なし） |
| 本体 → 仲介 | `runMenu` | `plugin`、`req`、`item`、`path`、`targetKind`（`'file'` か `'folder'`）。結果は、コマンドと同じ `done` / `failed`（`req` で対応） |
| 本体 → 仲介 | `result` | `plugin`、`call`、`ok`。成功は `value`（文字列か `null`）、失敗は `reason` |
| 仲介 ↔ Worker | `menu`、`call`、`runMenu`、`result` | 上の表から `plugin` と `v` を除いたもの（`runMenu` の `targetKind` は Worker では `target`） |

method の名前が `document.currentPath` ではなく `currentPath` なのは、`relay.js` に `document.` の文字列を置かない縛り（R5 の `architecture` の単体テスト）を守るため（`clipboardWriteText` も、同じ形に揃えた）。

上限: 1 部品のメニューの項目は 8 個まで、結果待ちの呼び出しは 16 個まで（Worker の中の API は、17 個目を reject する。仲介へ直接 17 個送れば、不正として部品を止める）、`text` は 1 文字以上 100000 文字（UTF-16 の長さ。ネイティブ側は、文字数で同じ上限を検査する）、パスは 4096 文字まで、`reason` は 300 文字まで。

不正の扱い: 不正な形の呼び出し（知らない method、余計な項目、空または長すぎる `text`、番号の誤りや重なり、上限超え）と、不正な形のメニューの項目（`where` が `'tree'` でない、最初の実行のあとの登録、id の重なり、9 個目）は、その部品を止める。`result` は、仲介が、結果待ちの番号のものだけを Worker に通す（本体が仲介を信用せず、仲介も本体の結果を検査する）。

ネイティブ（`src-tauri/src/clipboard.rs`、`plugin_permissions.rs`）:

- `write_clipboard_text(text)`: 空と、100000 文字を超える文字列を、Rust 側でも拒否する（`InvalidInput`）。書き込みは `tauri-plugin-clipboard-manager` 2.5.0 の Rust の API（`ClipboardExt::write_text`）だけを使う。書き込みの処理は差し替えられる形（`write_with`）で、単体テストは、検査と、差し替えた書き込みだけを呼ぶ（本物のクリップボードには書かない）。
- `capabilities/default.json` に足したのは、自前のコマンドの許可（`allow-write-clipboard-text`、`allow-load-plugin-permissions`、`allow-save-plugin-permissions`）だけ。clipboard-manager の JavaScript 向けの許可と、npm の `@tauri-apps/plugin-clipboard-manager` は入れない（`opener` と同じ作り。`architecture.r6.test.ts` と、`lib.rs` の単体テストが縛る）。
- 隔離の検証用のビルド（feature `isolation-probe`）は、書き込みを記録（`clipboard.log`）に差し替え、プラグインも入れない（OS のクリップボードには書かない）。

ツリーの右クリック: ファイルとフォルダの行のメニューに、本体の項目のあと、区切り（`role=separator`）を入れて、部品の項目を並べる。空き領域と補足の行、壊れたリンクには出さない。上下・Home・End・Enter・Esc は、本体の項目と同じ。部品が止まると、その項目は消える（開いているメニューからも消える）。項目を選ぶと、メニューを開いた行にフォーカスを戻してから、`paths.read` の確認と部品の `run` に進む。

### ショートカットの Alt と AltGr

- 形: `Mod+Alt+<英字>`。Shift とは組み合わせない（macOS の Option+Shift は、Option だけのときとは別の文字になり、既存の割り当てと重なりやすいので選ばなかった）。`,` や数字とも組み合わせない。
- 使えるのは、段 2 のコマンドだけ（`parseShortcut(text, { allowAlt: true })`。既定は、これまでどおり Alt つきの形を拒否する。段 3 のコマンドと、本体の固定のショートカットは、Alt つきを使わない）。重なりの検査は、これまでの規則（正規化した表記 `Mod+Alt+C` の比較。`Mod+C` とは別）。
- macOS の Option つき: `e.key` が英字にならない（Option+C は `ç`、Option+E は `Dead`）ので、`e.code`（`KeyC`）だけで判定する。Cmd と Option が押され、Shift と Ctrl は押されていないこと。
- Windows と Linux: Ctrl と Alt が押され、論理キー（なければ物理キー）が合う。AltGr（`getModifierState('AltGraph')` が true、または Ctrl+Alt で `e.key` が英字でない印字できる 1 文字）では発火しない。
- 既存の形（`Mod+T`、`Mod+Shift+T`、`Mod+,`）の判定は変えない（Alt が押されていれば、これまでどおり合わない）。

### 同梱の段 2 の部品「パスをコピー」の作り方

- 置き場所: `src/features/copy-path/`（`index.ts` と、Worker で動くコード `worker.js`）。`index.ts` は、`worker.js` を `?raw` で文字列として読み込み、`ActionPlugin` の `source` にする（Vite が、文字列としてバンドルに入れる）。一覧は `src/features/index.ts` の `bundledActionPlugins`（段 3 の `bundledPlugins` とは別の配列）。ホストは `main.tsx` で、この一覧だけを読む。ホストのファイルに部品の名前（`copy-path`、`パスをコピー`）が出てこないことを、単体テスト（`architecture.r6.test.ts`）が縛る。`worker.js` は、`api` だけを使い、ネットワークや保存領域、評価、`import` を持たない（同じテストが読んで確かめる）。
- 宣言: `permissions: ['clipboard.write', 'paths.read']`。コマンド「開いている文書のパスをコピー」（`Mod+Alt+C`、入力欄では実行しない）と、ツリーの「パスをコピー」。未保存の新規文書（パスが `null`）では、何もしない（ただし、初回は、パスを知る権限の確認が先に出る）。権限の拒否、確認の画面を閉じた、書けなかった、のどれでも、reject を握りつぶし、実行は成功として終わる（部品を止めない）。
- 本番では、常に読み込む。e2e のビルドは、R6 では seed の `isolated.bundled: true` のときだけ読み込んだ（既存の e2e を変えないため）が、R6b で既定を本番と同じにした（「R6b で直したこと」）。
- 検証用のコード（`probe.ts`、`e2eFixtures.ts`）の扱いは R5 のまま（本番の `dist` に入らない。`ci.yml` の検査と `check-probe-absent.mjs`）。`e2eFixtures.ts` に、権限の拒否の試験用の部品（宣言なしで API を呼ぶ、不正な形の呼び出し、`paths.read` なしのメニュー、知らない権限）を足した。

### iframe を作る時機

本番でも起動時に iframe が作られるようになるので、文書を開いて入力できるまでの経路を待たせないよう、段 2 の部品は、最初の描画のあとに動かす。レジストリを `deferStart: true` で作ると、段 2 の部品は作った時点では動かず、`startDeferred()` を呼んだときに動き始める（それまで、iframe も Worker も作られない）。App が、窓を表示した知らせ（`notifyReady`）のあと、次のタスク（`setTimeout(0)`）で呼ぶ。`requestAnimationFrame` は、非表示の窓では止まる（App のコメントのとおり）ので使わず、`requestIdleCallback` は WebKit にないので使わなかった。確かめたこと: e2e（iframe が作られた時刻が、`data-ready` が付いた時刻より後）、Tauri の窓（検証用のビルドで、同梱の部品が本物の `plug:` の上で `ready` になった）。

### 鍵が漏れたときの経路の方針

鍵が漏れたときに、`plug:` の iframe から `webkit.messageHandlers.ipc.postMessage` で、ネイティブのコマンドに届く経路（R5 で確認。R6 の取り直しでも同じ）は、今の規則（鍵を段 2 に、どの形でも渡さない。`architecture.test.ts` と `architecture.r6.test.ts` が、段 2 の仕組みのコードと R6 のコードに、鍵と入口の文字列が出ないことを縛る）で守る。この経路を塞ぐこと（R5 の提案の 2 つ目の `srcdoc` の変形と、3 つ目のネイティブ側での送り元の判別）は、ほかの人の部品を外から読み込む Run の前提とする。R6 では、自前のコマンドが 3 つ増えた（`write_clipboard_text`、`load_plugin_permissions`、`save_plugin_permissions`）ので、鍵が漏れたときに届くコマンドも増えた。権限の判断は本体の画面の側にあり、ネイティブのコマンド自体は、呼ぶ部品の権限を確かめない（「R6 の限界」）。

### ホストが部品を知らないことの縛りの拡張

`architecture.r6.test.ts`（新規。既存の縛りのテストは変えていない）が、R6 で足したコード（権限、確認の画面、`hostServices.ts`、ツリーのメニュー、同梱の部品、`shortcut.ts` ほか）と、`src/plugin-host/` の全部に、鍵と入口の文字列（`Tauri-Invoke-Key`、`__TAURI_INTERNALS__`、`__TAURI__`、`invoke`、`ipc:`）が出ないこと、ホストのファイルに同梱の段 2 の部品の名前が出ないこと、クリップボードの許可が自前のコマンドだけで npm の依存がないことを確かめる。

### 取らなかった案

- 権限の判断を Worker の仲介（`relay.js`）に持たせる案: 仲介が壊されたときに、判断も壊れる。判断は本体が、呼び出しのたびに持つ（仲介は形と番号だけを見る）。
- `api` に、宣言した権限の分だけ API を生やす案: 宣言のない API の呼び出しが、確認なしの拒否（reject）ではなく、`TypeError` になり、部品が止まる。
- クリップボードに JavaScript から書く（clipboard-manager の JavaScript 向けのコマンドを許可する）案: 本体の窓のどの文脈（鍵があれば、iframe も）からも、権限の確認なしに書ける入口が増える。自前のコマンドだけにして、検査（空、長さ）をネイティブ側で持つ。

## R6 で確かめた隔離

方法は R5 と同じ（`isolation-probe.mjs`。macOS の実際の Tauri の窓、run 専用の HOME、OS のキー入力・マウス操作なし、受け口は 127.0.0.1 だけで run のあいだだけ）。足したもの: クリップボードの記録（`clipboard.log`。検証用のビルドは、書き込みを記録に差し替え、OS のクリップボードには書かない）と、権限の保存ファイル（`plugin-permissions.json`）の有無。確認の画面を自動で許可するコードは、検証用のビルドにも入れていない（画面に答えるコードがない）。Tauri 2.12.5、wry 0.57.1、WKWebView、macOS のみ。

結果: 判定は `PASS`（終了コード 0）。R5 の 36 の経路は、R5 と同じ結果（鍵なしで届く経路はなく、対照の 2 つは届いた。鍵ありで届いたのは、R5 と同じ 1 つ: 仲介と同じ条件の文脈からの `webkit.messageHandlers.ipc.postMessage`）。R5 で提案した、鍵の漏れを塞ぐ手立ては、R6 でも入れていない。

R6 で足した経路（届いたかの判定は、ネイティブ側の `clipboard.log` と、`plugin-permissions.json` の有無。自己申告は、その経路が試されたことの確認に使う）:

| 経路 | 結果 |
|---|---|
| 対照: 本体（鍵を持つ側）から `write_clipboard_text` | `clipboard.log` に 1 行（記録の仕組みと、呼び方の形は正しい） |
| 宣言していない権限の API。仲介へ直接 `call`（書き込みと `currentPath`）と、`api.clipboard.writeText`、`api.document.currentPath`（宣言のない部品） | 4 つとも拒否（`result` が `ok: false`、理由に「宣言していません」。API 経由は reject）。確認の画面は出ず、`clipboard.log` に行は増えない |
| 不正な形の呼び出し: 知らない `method`、`currentPath` に余計な `text`、100001 文字の `text`、`where` が `'tree'` でない `menu` | 4 つとも、仲介が部品を止めた（本体の記録に「不正なメッセージ」）。`clipboard.log` に行は増えない |
| 未決の権限の呼び出し（`clipboard.write` を宣言し、未決の部品が `writeText`） | 確認の画面（`role=dialog`）が出た（部品の名前、権限 `clipboard.write` の説明。窓の撮影に写っている）。画面に答えないので、呼び出しは待ったまま。`clipboard.log` に行は増えず、`plugin-permissions.json` もできていない（自動では許可されない） |
| 同梱の「パスをコピー」の未決の呼び出し（確認の画面は上の部品の分が先に出ているので、順番を待つ） | `clipboard.log` に行は増えない |
| 同梱の「パスをコピー」が、本物の `plug:` と `relay.js` の上で動くか | `start`、コマンド `copy-path.copy-current-path`、メニューの項目 `copy-path.copy-path`、`ready` が、本体の記録にある。状態は `active` |

`clipboard.log` の行は、対照の 1 行だけ。検証中に、OS のクリップボードには書いていない（検証用のビルドは、書き込みを記録に差し替えている。本番のビルドの `ClipboardExt::write_text` の経路は、この検証では動かしていない）。

R6 では動かしていないもの: OS のキー入力を送らないので、ショートカット `Mod+Alt+C` と、ツリーの右クリックの実際の操作は、Tauri の窓では確かめていない（Chromium の e2e だけ）。同梱の部品のコマンドを、窓の中で、検証用のコードが呼び出して実行した（未決の確認の画面を出す経路）。Windows と Linux は未確認（R5 と同じ）。

## R6 の限界

- 権限の判断は、本体の画面（JavaScript）の側にあり、ネイティブのコマンドは、呼ぶ部品の権限を確かめない。鍵が漏れたとき（段 2 には渡さない規則で守っている）は、`plug:` の iframe から、`write_clipboard_text`（検査は空と長さだけ）と `save_plugin_permissions`（形の検査だけ。部品の権限を勝手に `granted` にできる）に届く。外から部品を読み込む Run の前に、塞ぎ方（R5 の提案の 2 と 3）を決める。
- 確認の画面は、宣言した権限のうち、決めていないものをまとめて許可する。使っていない権限も許可される（宣言の範囲）。部品の名前は `manifest.name` で、同梱の部品だけが対象のため、名前の偽装は考えていない（外から読み込む Run で決める）。
- 確認の画面を閉じる（Esc）と、その呼び出しが失敗する。部品が、reject を握りつぶさずに例外にすると、その部品が止まる（R5 の規則）。同梱の部品は、握りつぶす。
- 取り消しは、動いている部品を止めず、次の呼び出しから効く。確認の画面が出ている間に取り消す操作は、確かめていない（設定画面は、確認の画面の後ろに隠れる）。
- 保存は、本体の画面が決めた結果を書く。ネイティブ側が検査するのは形と大きさだけ（権限の名前と値の範囲）。ファイルが壊れていれば、空として扱うので、すべての権限が未決に戻り、再び聞く。読み込みの失敗（権限の拒否など、ファイルの読み取りの失敗）も、R6 では決定がないものとして続け、次の保存で上書きした。R6b で直した（読めなかったあとは保存せず、次に権限が要るとき読み直す。壊れているファイルを空として読む扱いは、R6 のまま）。
- 同梱の部品の `Object.keys(api)` に、R6 の 3 つが出ない（上のとおり）。R6b で直した。
- ショートカット `Mod+Alt+C` の、macOS の Option（`e.code` で判定）と、AltGr（Windows と Linux）は、合成した `KeyboardEvent`（`key`、`code`、`modifierAltGraph`）と、単体テストで確かめた。実機の入力（macOS の Option+Cmd+C、Windows と Linux の AltGr 配列）は未確認。macOS の Cmd+Option+C は、WKWebView の開発者ツールの既定のキーと重なる可能性があるが、未確認。
- 本番の Tauri の窓の、起動時間（iframe と Worker を、最初の描画のあとに作る）は、perf の Tauri の項目では計測していない（`npm run perf -- --only web`）。Web UI の計測は、R6 では同梱の部品が入らない構成（e2e のビルドの既定）で、HEAD と変わらなかった。iframe と Worker の作成が、最初の描画のあとの入力に与える影響は、計測していなかった。R6b で、同梱の部品が入る構成と HEAD を比べた（「R6b で直したこと」の計測）。
- クリップボードへの実際の書き込み（`ClipboardExt::write_text`）は、単体テストでも検証でも動かしていない（本物のクリップボードに書かない方針）。呼び出しの形は、コンパイルと、書き込みを差し替えた単体テストだけで確かめている。
- 1 つの iframe を全部の部品で共有する（R5 と同じ）。

## R6b で直したこと

R6 の Reviewer の注記のうち、4 点を直した（新しい機能は足していない。API の版は 0 のまま）。

### e2e と perf の既定を本番と同じ構成にした

- e2e のビルドも、既定で同梱の段 2 の部品（`bundledActionPlugins`）を読み込む。外すのは、seed の `isolated.bundled` が `false` のときだけ（`src/isolated-plugins/index.ts`。`includeBundled = seed?.bundled !== false`）。`seed.isolated` がなくても読み込む。
- R5 の e2e「段 2 の部品がないとき、iframe も Worker の受け口も作られない」は、`isolated: { plugins: [], bundled: false }` を書く形に直した。既定が変わったので、「部品がない」構成は明示が要るため。`copy-path.spec.ts` の、既定では同梱の部品を読み込まないことを確かめていたテストは、既定で iframe が 1 つあること、`bundled: false` で iframe がないこと、の 2 つに分けた。
- 同梱の部品が入ったことで、本番でも変わる値だけを直した: ツリーの項目のメニューは 4 項目から 5 項目（末尾に「パスをコピー」。`explorer-edit.spec.ts` の項目の一覧と、End キーで最後の項目へ、上矢印で 1 つ戻る確認）、`isolated-plugins.spec.ts` の記録の数え方（command は e2e-ok のものだけを、ready は同梱の部品を除いた 2 つを数える）。テストの意図は変えていない。
- 設定画面の「部品の権限」の節の class は `settings-permissions` のまま（`settings-section` にそろえると、見出しを 2 つと数える既存のテストを変えることになる。R6b の目的の外なので、変えなかった）。
- 本番の振る舞いは変わらない（本番は R6 から常に読み込む）。`perf/` は変えていない。perf の Web の計測は VITE_E2E=1 のビルドなので、この変更で、同梱の部品（iframe と Worker）が入った構成を計測するようになった。

### 権限の読み込みの失敗

- ネイティブからの読み込みが失敗した（ファイルがない、は失敗ではない。ネイティブが空として返す）とき、`PermissionController.load()` は失敗を覚えない。次に権限が要るとき（`authorize`）に、読み直す。
- 読めていないあいだに、確認の画面の答え（許可する、許可しない）が出たら、その結果は今回の起動の間だけのもの（`session`）として扱い、ファイルには書かず、トーストで知らせる。読み直しに成功しても、その結果は保存しない（保存するのは、読めたあとに決めたものだけ。保存する内容は、読んだ内容に足したもの）。読めていないあいだの取り消しも、保存しない。
- ファイルがないとき、壊れていて空として読んだときの扱いは、R6 のまま（ネイティブが空を返し、本体は読めたものとして続ける）。壊れたファイルを空として読んだ後の最初の保存は、壊れたファイルを上書きする（R6 と同じ）。

### 確認の画面を出す条件

- 確認の画面は、利用者の操作で始まった実行（段 2 のコマンドのショートカット、ツリーのメニューの項目の選択）の中でだけ、その実行につき 1 回まで出す。それ以外の時機（起動時、activate の中、実行の外、同じ実行の 2 回目以降）の、決めていない権限の呼び出しは、画面を出さずに reject する（`PermissionAuthorization` の `'not-asked'`。理由は「確認の画面は、利用者の操作で始まった実行の中で、1 回だけ出します（今回は出しません）」）。部品は止めない。決めている権限は、これまでどおり、どの時機でも答える。
- 実装: `PermissionGate.beginRun(pluginId)`（任意）が、実行の枠を開き、実行が終わったときに呼ぶ関数を返す。レジストリが、コマンドの `run`（ショートカット）と、メニューの項目の選択で呼ぶ。メニューの項目は、権限の確認（`paths.read`）の前に開き、部品の `run` が終わるまで閉じない（確認から実行までを、1 回の実行として数える）。実行の終わりは、`IsolatedPluginHost.run` と `runMenu` が返す `{ finished }`（done、部品の停止、時間切れのどれでも resolve。reject はしない）で知る。実行されなかったとき（止まった部品、登録のないコマンド）は、すぐに閉じる。
- 同じ部品の実行が続いている間は、確認の画面が出ている間に来た、その部品の実行の中の呼び出しは、その答えを待つ（画面を重ねない。R6 と同じ）。実行の外の呼び出しは、画面が出ている間でも、待たずに断る。
- 限界: 呼び出しは、どの実行のものかを持たない（Worker のメッセージに、実行の番号がない）。同じ部品の実行が続いている間の呼び出しは、タイマーで遅らせたものでも、その実行の画面を使える。利用者の操作 1 回につき、画面は 1 回までである点は変わらない。同じ部品の実行が重なる（ショートカットの連打で、前の実行が終わる前に次を始める）と、その分だけ画面を出せる（操作 1 回につき 1 回）。

### 段 2 の API を列挙される形に戻した

`relay.js` の `api` は、`registerCommand`、`registerContextMenuItem`、`clipboard`、`document` を、普通の（列挙される）プロパティとして持つ（`Object.keys(api)` で 4 つ。`Object.defineProperty` による隠しはやめた）。`api` と、`clipboard`、`document` は凍結のまま。`relay.test.ts` と `relay.api.test.ts` の期待値を、この 4 つの一覧に直した。

### 計測: 同梱の段 2 の部品が、起動と入力に与える影響

方法: `npm run perf -- --only web`（chromium 156.0.8078.4、webkit 27.2。Playwright の chromium と webkit。標本は既定の数）を、同じ時間帯に、HEAD（コミット 7a7640e を `git archive` で別のディレクトリに展開し、`node_modules` はシンボリックリンク。同梱の部品が入らない構成）と、変更後（同梱の部品が入る構成）で走らせ、`npm run perf:compare` で比べた。HEAD → 変更後の順で 1 組、変更後 → HEAD の順で 1 組（計 2 組）。結果の JSON は `perf/out/` に出した（`perf/results/` には置いていない）。環境: Apple M5、AC 電源、計測中は重い処理を並行させていない（ただし、このセッションのエージェントなど、OS 上のバックグラウンド負荷は制御していない）。変更後の計測に iframe が 1 つあり、HEAD の計測にはないことは、それぞれのビルドを開いて確かめた。

結果: 2 組とも、悪化と判定された項目はなかった（`perf:compare` の終了コード 0）。測り直しが要る項目はなかった。

| 項目（中央値、ms） | HEAD（1 組目、2 組目） | 変更後（1 組目、2 組目） |
|---|---|---|
| web.chromium.ready（起動） | 146.5、153.2 | 144.2、148.7 |
| web.webkit.ready（起動） | 140、137 | 127、126 |
| web.typing.chromium.B.middle（入力から描画） | 7.1、7.4 | 7.1、7.3 |
| web.typing.webkit.B.middle | 5、5 | 5、6 |
| web.input-cpu.chromium.B.middle（入力の処理時間） | 2.4、2.9 | 2.5、2.7 |
| web.input-cpu.webkit.B.middle | 3、3 | 3、4 |

割合は超えたが、揺れの範囲か下限未満のため無視された項目が、1 組目で 14、2 組目で 15 あった。2 組の両方に出たのは `web.ime-commit.chromium.C.middle`（IME 確定。中央値が 1.8 → 4 と 1.4 → 3.5 ms。揺れの 0.5〜0.6 倍で、差は 2〜2.6 ms）。小さい値の変動で、判定の条件（揺れの 3 倍超）を満たさないが、2 組とも同じ向きだったので、同梱の部品の影響がゼロとは言い切れない。ほかの項目は、組によって向きが違った（例: `web.typing.chromium.D.middle` は HEAD の 2 組目が 18.5 ms で、HEAD どうしでも 8.2 と 18.5 の差がある）。

未確認: Tauri の実機の起動時間（`--only tauri`。この Run では測っていない）、本番の Tauri の窓での入力。

### 取らなかった案

- 確認の画面の回数を、部品の全体で数える案（起動からの通算）: 利用者の操作ごとに聞き直せなくなる。実行ごとの方が、「操作したから聞く」の対応が分かりやすい。
- 呼び出しに実行の番号を持たせる案: Worker のメッセージの形（`relay.js`、`protocol.ts`）を変える。R6b の範囲（形は変えない）の外で、画面の回数の上限は、実行の枠だけで守れる。
- 読み込みの失敗のあと、今回の起動の間の結果を、読み直しに成功したあとで保存する案: 読めなかった間の画面の答えが、後から、利用者の知らないうちにファイルに入る。「今回だけ」の約束を守るため、保存しない。

## R7 で決めた細部

R7（2026-11-07）で、段 2 の Worker の部品が左サイドバーにパネル（項目の木）を足せるようにし、本文とカーソルの位置を受け取る権限 document.read（宣言だけで使える）と、最初の同梱の部品「アウトライン」（S1 の最初の段）を入れた。API の版は 0 のまま。新しい iframe、`plug:` の新しいファイル、本体の CSP の変更はない（`plug:` が返すのは `host.html` と `relay.js` の 2 つのまま。本体の CSP は R5 の値のまま。どちらも `architecture.r7.test.ts` と既存の `architecture.test.ts` が縛る）。ネイティブ側（`src-tauri/`）、保存・競合・草稿の扱い、設定ファイルの形は変えていない。

### 段 1 を後回しにした理由

ADR の当初の案は、段 1（sandbox の iframe の中で部品が DOM を自由に描く）でパネルを作ることだった。R7 では作らず、部品のコードを、段 2 と同じ Worker（`plug:` の iframe の中の blob の Worker）で動かし、部品は「項目の木」（文字列、深さ、本文の中の位置）を送るだけ、描くのは本体（React の決まった部品）、にした。

- 理由: 見える iframe は、Tauri の窓（WKWebView）で、本体と同じスレッドで動く可能性がある（未確認。Chromium では、origin が不透明な iframe が別のプロセスになるかどうかも、環境と設定による）。同じスレッドなら、部品の無限ループで本体の描画と入力も止まり、本体からは止められない（`terminate` できるのは Worker だけ。iframe は、応答しなければ作り直すこともできない）。Worker は別のスレッドなので、無限ループの間も本体の入力は止まらず、時間切れで `terminate` できる（R5）。
- 取らなかった案: (1) 段 1 を先に作り、スレッドの共有は後で測る（測った結果が悪ければ、作った表示の仕組みを捨てることになる）。(2) iframe の中の部品に DOM を描かせ、無限ループは利用者が部品の一覧から止める（一覧の画面がまだなく、本体ごと固まると、止める操作もできない）。
- 段 1 を作るときの最初の作業: Tauri の窓で、sandbox の iframe の中で `for (;;) {}` を走らせ、その間の本体の `requestAnimationFrame` の間隔と、本文の入力の応答を測る（OS のキー入力は送らず、本体の側のタイマーで測る）。止まるなら、iframe の応答の監視と作り直し（R5 の限界に書いた、`terminate` が届かない場合の検出）を先に作る。止まらないなら、そのまま作れる。
- 代償: パネルの見た目は、本体が決めた形（一覧）に限られる。部品は、ボタンも入力欄も自由な配置も作れない。エディタに代わる表示（`registerView`）と、1 節だけ広げて書く機能は、段 1 が要る。

`manifest.tier` は `'action'` のまま、API を足す形にした。別の tier（`'view'`）を足さなかった理由: tier は「どこで動くか」の区分で、パネルの部品も段 2 と同じ Worker で動く。`'view'` は、見える iframe で自由に描く段の名前として残す。

### API（Worker の中の `api`）

`api` の列挙できる項目は、`registerCommand`、`registerContextMenuItem`、`registerPanel`、`clipboard`、`document` の 5 つ（凍結は R6 のまま）。

- `api.registerPanel({ id, title })`: 部品のコードの最初の実行の間（トップレベル）だけ。1 部品に 1 つ（2 つ目は部品が止まる。上限は `LIMITS.panelsPerPlugin`）。`id` は小文字の英数字とハイフン（64 文字まで）、`title` は 1〜200 文字。本体の側では `<部品の id>.<パネルの id>` として扱い、節の見出しは `title`。戻り値は凍結した `{ setItems }` だけ。宣言（権限）は要らない（権限の表の「画面の場所」）。
- `panel.setItems(items, { version, current?, emptyText? })`: 項目の全部を置き換える。
  - 項目 `{ text, depth, offset }`: `text` は 1〜200 文字、`depth` は 0〜7 の整数、`offset` は本文の中の位置（UTF-16 のオフセット。0〜2,147,483,647 の整数）。余計な項目（URL、スタイル、id）は拒否する。
  - `version`（必須。0 以上の整数）: 項目を作った本文の版。`current`（任意）: 強調する項目の番号（0〜項目の数 - 1）か `null`。`emptyText`（任意）: 項目が 0 件のときに出す文言（1〜200 文字）。
  - 引数の誤りは、メッセージを送らずに Worker の中で例外にする（部品が呼んだ関数が例外を出すので、部品の最初の実行の例外か、コールバックの例外として、部品が止まる）。
- `api.document.onDidChange(callback)`: 本文を受け取る。`callback({ text, kind, version })`。`kind` は `'markdown'` か `'plain'`、`version` は本体が数える本文の版（本文か種類が変わるたびに増える）。
- `api.document.onDidChangeSelection(callback)`: カーソルの位置。`callback({ anchor, head, version })`（`version` は、そのときの本文の版）。
- 2 つの `on*` は、最初の実行の間だけ登録でき、それぞれ 8 つまで。登録は、権限（document.read）の宣言がなくても拒否しない（Worker の側は宣言を知らない。判断は、R6 と同じく本体がする。宣言がなければ、呼ばれないだけ）。コールバックが例外を出すと、Worker の `error` として、仲介がその部品を止める。
- 部品がカーソルを動かす API とメッセージはない。移動を頼めるのは、本体のパネルの項目の操作だけ（「移動の規則」）。

強調する項目（カーソルのある節）は、部品が `current` で示す（本体が位置から決める案は取らなかった）。理由: 部品の公開 API（本文と選択を受け取って、項目を返す）が段 1 でも同じ形で使え、本体が見出しの構造（どの項目が節の先頭か）を知らずに済む。代償: カーソルを動かしてから強調が変わるまで、選択の通知の間引き（100 ms）と、部品の計算の分だけ遅れる（e2e は、強調を待って確かめる）。

### メッセージ（版 `v: 0`）

| 向き | 種類 | 項目 |
|---|---|---|
| 仲介 → 本体 | `panel` | `plugin`、`id`、`title` |
| 仲介 → 本体 | `items` | `plugin`、`panel`、`version`、`items`（`{ text, depth, offset }` の配列）、`current`（番号か `null`）、`empty`（文言か `null`） |
| 本体 → 仲介 | `doc` | `plugin`、`version`、`textKind`（`'markdown'` か `'plain'`）、`text` |
| 本体 → 仲介 | `selection` | `plugin`、`version`、`anchor`、`head` |
| 仲介 ↔ Worker | `panel`、`items`、`doc`、`selection` | 上の表から `plugin` と `v` を除いたもの（`doc` は Worker では `{ kind: 'doc', version, textKind, text }`） |

形と上限は、`relay.js`（Worker からのもの）と `protocol.ts`（本体が受けるもの）の両方で検査する。`doc` と `selection` は、`relay.js` も形を検査してから Worker に渡す（`ready` の前、止めた後は渡さない）。

状態機械: `panel` は `starting` の間だけ（1 部品に 1 つ）。`items` は、登録したパネルの id のものだけ（`starting` の間と `ready` のあと。トップレベルで最初の項目を送ってよい）。外れたメッセージは不正として、その部品を止める。

上限（`LIMITS` と `relay.js` の `MAX_*`。同じ値）: 項目 1000 個（超えたら、Worker の API が例外、仲介と本体は不正として部品を止める）、項目の文字列と項目がないときの文言は 200 文字（UTF-16 の長さ）、深さは 7 まで、`offset` は 2,147,483,647 まで、`setItems` の頻度は 1000 ms の間に 30 回まで（滑る窓。超えた部品を止め、理由は「不正なメッセージ: setItems が多すぎます」。仲介と本体の両方で数える）、本文は 16 MiB（UTF-16 の長さで 16,777,216）まで（超える本文は、本体が部品に届けない）。止めるときの扱いは R5 と同じ（Worker を `terminate` し、`[plugin] 部品「<id>」を止めました: <理由>` を残し、ほかの部品とアプリは動き続ける）。

### 権限 document.read

権限の表の「宣言だけで使える」の「今の文書を読む」。`manifest.permissions` に `'document.read'` を書く。確認の画面は出さず、決定の保存もしない。

- 型と定数: `src/plugin-api/permissions.ts` の `DECLARATION_ONLY_PERMISSIONS`（`['document.read']`）。確認と保存の対象の `PERMISSIONS`（`clipboard.write`、`paths.read`）には入れない。したがって `plugin-permissions.json`（版 1 のまま）と、`src-tauri/src/plugin_permissions.rs` の `KNOWN_PERMISSIONS` は変えていない（`architecture.r7.test.ts` が、Rust の定数が 2 つのままで `document.read` を含まないことを確かめる）。
- 確認の仕組み（`PluginRegistryOptions.permissions`）がない環境でも、`document.read` だけを宣言した部品は読み込まれる（確認の要る権限を宣言した部品は、R6 のとおり読み込まれない）。確認の画面には、宣言した権限のうち、確認の要るものだけが渡る。
- 本文とカーソルの位置を受け取るのは、`document.read` を宣言した部品だけ。レジストリが、部品ごとに、(1) 宣言している、(2) 動いている（最初の実行が終わった）、(3) パネルを持つなら、パネルが見えている、の 3 つが揃うときだけ、`deliverDocument` と `deliverSelection` を呼ぶ。同じ版は同じ部品に重ねて届けない。宣言していない部品は、`on*` を登録しても何も届かず、止まりもしない。
- 設定画面の「部品の権限」には出さない（決める権限ではないため）。宣言の一覧の画面は、部品の一覧の Run（未決）。

### 本文を届ける時機（入力の速さを守る）

`src/panels/documentFeed.ts`（本体の側。部品を知らない）が決める。規則:

- 利用者の入力: 入力が止まってから 200 ms の後に、1 回届ける（入力のたびに待ち直す。後ろ寄せ）。
- 文書を開いた、切り替えた、ディスクから読み直した、種類（`markdown` と `plain`）が変わった: 待たずに届ける（次のタスク）。
- IME の変換中は届けない。変換が終わってから、`AFTER_COMPOSITION_MS`（60 ms。R2 の共通の値）の間隔で確かめ、確定の後に届ける（`EditorAdapter.isComposing()`）。
- パネルが見えていない（サイドバーが閉じている、節がたたまれている）間は届けない。見えたときに、最新を届ける（レジストリが、見えた時点で、覚えている最新を届け、本体は保留中の分を待たずに最新へ進める）。
- カーソルの位置は、最初の変化から 100 ms に 1 回、最新の位置を届ける。本文の届け待ちの間と変換中は、単独では届けず、本文と一緒に届ける。
- 部品が動き始めた（`ready`）とき、覚えている最新を届ける（サイドバーが開いていて、パネルが見えているときだけ）。

本文の版は、本文か種類が変わるたびに本体が 1 増やす（届けたかどうかによらない）。届けた本文は、コントローラーがすでに持っている文字列（`DocumentController` の `text`）で、届けるために `doc.toString()` を増やしてはいない。

### パネルの場所と見た目

- 場所: 左サイドバーの中、エクスプローラーの下の、部品のパネルの節（`src/ui/PluginPanels.tsx`）。フォルダを開いていなくても出る。サイドバーの開閉（Mod+B）、push と overlay、`inert` の扱いは変えていない（パネルもサイドバーの中なので、閉じたサイドバーではフォーカスを受けない）。
- 節の見出し（`h3` の中のボタン。`aria-expanded`）で、たためる。たたんだ状態は保存しない（起動のたびにすべて開く）。理由: 保存すると設定ファイルの形（`storedShape.golden.json` が縛る）が変わるため。
- 一覧は、名前（`<見出し>の項目`）を持つ `ul`、項目は `button`。現在の項目は `aria-current="location"`。Tab で入る項目は 1 つ（現在の項目、なければ先頭）、上下・Home・End で移り、Enter（または Space。ボタンの標準の動き）で選ぶ。
- 部品の文字列（節の見出し、項目、項目がないときの文言）は、React のテキストとして描き、HTML として解釈しない。`dangerouslySetInnerHTML`、`innerHTML` を使わず、部品が決める属性・URL・スタイルを使わない（深さは整数で、`data-depth` と CSS の決まった指定になる）。`architecture.r7.test.ts` が、描画のコードにこれらがないことと、部品の文字列が出る場所が、子の文字と `aria-label` だけであることを縛る。e2e で、`<img src=x onerror=...>` などの文字列が文字のまま出ることを確かめる。
- 複数のパネルがあるとき、パネルの領域（サイドバーの高さの半分まで）の全体がスクロールし、節の見出しは固定される（各節は縮まない）。

### 移動の規則

項目を押す、または Enter で、`EditorAdapter.goToLineStart(offset)` を、本体（`App`）が呼ぶ。`CodeMirrorAdapter` が、位置を本文の長さに収め（範囲外、負、整数でない値でも例外にしない）、その位置を含む行の先頭へカーソルを移し（範囲選択は解く）、`scrollIntoView`（行を表示領域の先頭に。読書位置の余白は CodeMirror のスクロールの余白の仕組みが付ける）で表示し、本文にフォーカスを戻す。本文は変えず、履歴にも残さない（`userEvent: 'select'`）。CodeMirror に依存するのは `src/editor/codemirror/` だけ。

- 項目を作った本文の版（`items` の `version`）が、今の本文の版（`feed.version`）と違うときは、移さない（入力のあと、次の更新を待っている間）。このとき、フォーカスも動かさない。
- 部品には、この操作を渡さない。公開 API（`src/plugin-api/`）、レジストリ、`relay.js`、`protocol.ts`、`workerHost.ts` に、移動に関する名前がないこと、`goToLineStart` を呼ぶのが `App` の 1 か所だけであることを、`architecture.r7.test.ts` が縛る。部品が、決めていない種類のメッセージ（例: カーソルを動かすつもりのもの）を送ると、仲介が部品を止める。

### 同梱の部品「アウトライン」

`src/features/outline/`（`index.ts` と `worker.js`。`worker.js` は `?raw` で文字列にして `ActionPlugin.source` に渡す。R6 の「パスをコピー」と同じ作り）。宣言は `permissions: ['document.read']`。ホストのファイルに部品の名前が出ないことと、部品のフォルダが公開 API と `worker.js` だけを使うことを、`architecture.r7.test.ts` が縛る。

- 数える見出し: CommonMark の ATX 見出し（`#` から `######`）。行頭の空白は 3 つまで（4 つ以上、タブは数えない）、`#` は 1〜6 個で、あとに空白かタブ（または行末）、閉じの `#` の並び（前に空白がある）は文字に含めず、前後の空白を除く。中身が空の見出しは数えない。深さは `#` の数 - 1（0〜5）、`offset` は見出しの行の先頭。
- 数えないもの: フェンスのコードブロック（バッククォートとチルダ。開始と同じ文字で、同じかそれ以上の長さの行で閉じる。閉じがなければ末尾まで。バッククォートのフェンスの info string にバッククォートがあれば開始ではない）の中、先頭の front matter（1 行目の `---` から次の `---` まで。閉じがなければ front matter ではない。判定は `frontmatterEndLine` と同じ `/^---\s*$/`）の中。対象外（数えない）: setext 見出し（下線の `=` と `-`）、引用やリストの項目の中のフェンス（コンテナの中は追わない）、見出しの文字の中の強調やリンクの記法の処理（書かれたままの文字で出す）。
- 素のテキスト（`plain`）は項目なしで、文言は「見出しはありません」。見出しのない Markdown も同じ。項目は先頭から 1000 件で切る。
- カーソルのある節: 位置（`head`）以前にある最後の見出し。最初の見出しより前は強調なし。本文の通知と選択の通知を、1 回の `setTimeout(0)` にまとめて、1 つの `setItems` で送る。版・項目・強調が前回と同じなら送らない。

### 取らなかった案

- 本文を、入力のたびに差分で届ける案: 部品の側に本文の複製を持たせ、差分を適用させる仕組みが要る。全文は 1 MB でも、K3 では往復が数 ms で、入力が止まった後に 1 回なら十分に小さい（「R7 で確かめたこと」の計測も、入力の速さに差は出なかった）。
- 本文をパネルが見えていなくても届け、部品の側で捨てさせる案: 本文が、権限を宣言した部品の Worker に、使われないまま出る。見えているときだけ届ける方が、部品に渡す量が最小になる。
- パネルを、Worker の部品ではなく、本体が見出しを数えて出す案: S1 の目的は、部品として作ること。見出しの規則の変更が、本体の変更になる。
- 部品が `current` を決めず、本体が位置から決める案（上の「強調する項目」）。

## R7 で確かめたこと

方法: 単体テスト（`npm test`）、e2e（`npm run test:e2e`。4 つの project）、`npm run perf -- --only web` と `perf:compare`、実際の Tauri の窓での `isolation-probe.mjs`、Skill のシナリオ（`features/outline.md` の `outline-panel.json` と `outline-timing.json`。メモリ bridge の Web UI）。OS のキー入力・マウス操作は送っていない（Tauri の窓でのパネルの操作は、確かめていない）。

- 単体テスト: 形と上限（`protocol.panel.test.ts`、`relay.panel.test.ts`、`workerHost.panel.test.ts`。不正な形、上限ちょうどと超過、状態外のメッセージ、頻度の窓が滑ること）、レジストリ（`registry.panels.test.ts`。document.read の宣言、見えているときだけ届く、同じ版を重ねない、宣言のない部品には届かない）、本文を届ける時機（`documentFeed.test.ts`）、見出しの抽出（`outline.test.ts`。部品の `worker.js` を、Worker の前置きの上で動かし、公開 API を通して確かめる。C の 1 MB の文書（422,152 文字）から 7 つの見出しを数える。数えるだけの時間は、Node（V8）で 30 回の中央値 0.3 ms、最大 1.3 ms。WKWebView の Worker の中では測っていない。計算は Worker の中で、本体の入力は待たない）、移動（`CodeMirrorAdapter.goTo.test.ts`）、パネルの描画とキーボード（`PluginPanels.test.tsx`）、縛り（`architecture.r7.test.ts`）。
- e2e（`tests/e2e/outline.spec.ts`。4 つの project すべて）: 見出しの一覧、入力での更新、強調、コードブロックと front matter、素のテキスト、文書の切り替え、項目の押下と Enter での移動と本文へのフォーカス、キーボード、閉じたサイドバーでフォーカスを受けない、節をたたむ、古い版の項目では移らない、サイドバーを閉じている間とたたんでいる間は本文を送らない（本体の記録で確かめる）、入力のたびには送らない、IME の変換中は送らない（CDP による模擬）、document.read を宣言していない部品には届かない、HTML に見える文字列が文字のまま、上限と不正な形で止まる部品（頻度、項目の数、登録していないパネル、カーソルを動かそうとするメッセージ）だけが止まり入力と保存が続く。Worker の中から本体の origin に fetch が届かないことは、R5 の既存の e2e（`isolated-plugins.spec.ts` の「部品のコードは、本体のページの DOM と window、ネットワーク、保存領域に届かない」）がそのまま確かめている。
- 既存の e2e の期待値の変更（本番の画面が変わった値だけ。意図は変えていない）: `isolated-plugins.spec.ts` の 2 件（動き出した部品を数える `ready` の記録から、同梱の部品が 1 つ増えた分（`outline`）を除く）、`settings-sidebar.spec.ts` の 2 件（サイドバーの中のボタンの数が、パネルの見出しの分 1 つ増えて 1 から 2）。
- 隔離の取り直し（`isolation-probe.mjs`。macOS、WKWebView、Tauri 2.12.5、wry 0.57.1、debug ビルド）: 判定は PASS（終了コード 0）。鍵なしで届く経路は、36 の経路のうち 0。対照（本体の `invoke`、`postMessage`（鍵あり）、受け口への接続）は届いた。鍵ありで届く経路は、R5・R6 と同じ 1 つ（仲介と同じ条件の文脈からの `webkit.messageHandlers.ipc.postMessage`）。R7 で足した経路（検証用の部品が、本物の `plug:` と `relay.js` の上で試した）: 不正な項目（深さが範囲外）、登録していないパネルの項目、`setItems` の連打、カーソルを動かそうとするメッセージは、4 つとも仲介が部品を止めた（理由はそれぞれ「項目の depth が不正です」「登録していないパネルの items です」「setItems が多すぎます」「決めていない種類のメッセージです」）。document.read を宣言した部品（対照）は本文を 1 件、選択を 2 件受け取り、宣言していない部品は 0 件だった。同梱のアウトラインは、本物の `plug:` の上で `ready` になり、パネルを登録した。サイドバーは閉じているので、本文は 0 件しか届いていない。窓の撮影はない。`check-probe-absent.mjs` は、通常のビルドに検証用のコードがないことを確かめた。
- 性能（Web UI。Playwright の chromium 156.0.8078.4 と webkit 27.2、Apple M5、AC 電源。計測中は、この作業から重い処理を並行させていない。ユーザーの既存のアプリ（ブラウザなど）の負荷は制御していない）。HEAD（コミット 6254ad1 を `git archive` で別のディレクトリに展開し、`node_modules` はシンボリックリンク）と変更後を、同じ時間帯に走らせた。結果は `perf/out/r7-*.json`（`perf/results/` には置いていない）。
  - 既定の計測（`npm run perf -- --only web`。78 項目）: HEAD → 変更後で 2 組。1 組目は、`web.open.chromium.B`（B 文書を開く）の中央値が 9.3 → 22.7 ms（標本 7 件）で、悪化と判定された。2 組目（HEAD → 変更後、同じ手順）では再現せず、悪化の判定はなかった（ほかの項目は、どちらの組も、揺れの範囲か下限未満）。1 組目の悪化は、再現しなかったので、偶然の揺れと見ているが、原因は特定していない。
  - サイドバーを開いてアウトラインを表示した状態の C（1 MB）（`--open-sidebar --datasets C`。HEAD は、サイドバーを開いただけで、アウトラインはない。新しい perf のスクリプトを HEAD の複製に重ねて走らせた）: 3 組（HEAD → 変更後、変更後 → HEAD、変更後 → HEAD）。どの組も、悪化の判定はなかった。入力から描画まで（中央値、ms。HEAD / 変更後。3 組の順）: chromium 末尾 18.1 / 21.7、17 / 22、18.2 / 17.1。chromium 中央 17 / 17.7、17.2 / 17.1、18.1 / 17.6。webkit 末尾 12 / 13、9 / 14、9 / 9。IME の確定（chromium、末尾）3.8 / 9.5、2.6 / 2.0、3.6 / 3.3。変更後の方が高い組と低い組があり、サイドバーを閉じた C（HEAD 21.3、変更後 17.1）でも、同じ HEAD の中で 17 から 21.3 まで動いた。この計測の揺れ（同じコードの組の間で 4 から 5 ms）の範囲で、アウトラインを表示したことによる差は、見分けられなかった。
  - 限界: 標本は既定の数（入力は 100 件）。揺れが大きいので、数 ms の差は見分けられない。IME の確定は、chromium の CDP による模擬だけ（webkit は計測していない）。Tauri の実機は計測していない。

## R7 の限界

- 段 1（見える iframe で部品が自由に描く表示）は作っていない。折りたたみ、並べ替え（`doc.applyChanges`）、1 節だけ広げて書く機能、エディタに代わる表示、org、素のテキストの字下げの見出しも作っていない。
- 本文は、全文を文字列で届ける（差分ではない）。16 MiB を超える本文は、本体が部品に届けない（部品の項目は古いままで、項目の版が本文の版と違うので、押しても移らない）。`setItems` は項目の全置換で、1000 件まで（アウトラインは先頭 1000 件で切る）。
- 本文とカーソルの通知のコールバック（`onDidChange` など）の無限ループには、時間切れがない（コマンドの実行にはある）。Worker は別のスレッドなので、本体の入力は止まらないが、その部品のパネルは更新されなくなる。止めるのは、現時点では、部品の一覧（未決）か、アプリの再起動。
- 1 つの部品に、パネルは 1 つ。たたんだ状態は、保存しない。
- 強調が変わるのは、カーソルを動かしてから 100 ms 以上あとになる。入力のあと、一覧が更新されるまで（約 200 ms と、部品の計算）は、古い項目が出ており、その間に押しても移らない（次の更新を待つ）。
- アウトラインの見出しの規則は、CommonMark の ATX 見出しの範囲の一部で、引用やリストの中のコードブロックを追わず、見出しの文字の中の記法をそのまま出す。
- 窓が狭く、サイドバーが本文の上に重なっている（overlay）とき、項目を押して本文にフォーカスが移っても、サイドバーは閉じない（エクスプローラーでファイルを開いたときと同じ）。
- Tauri の窓での、パネルの実際の操作（クリック、キー）は、OS のキー入力・マウス操作を送らない方針のため、確かめていない。窓では、検証用の部品と同梱の部品が、本物の `plug:` と `relay.js` の上で動くこと（パネルの登録、不正な呼び出しでの停止、document.read の有無による本文の配信の違い）まで。パネルの描画、移動、IME は、Chromium の e2e だけ（実 IME は未検証）。Windows と Linux は未確認。
- 性能は Web UI（メモリ bridge）の計測だけ。Tauri の実機の起動時間と入力は計測していない。
- 鍵が漏れたときの経路は、R5・R6 のまま（塞いでいない）。R7 で、ネイティブのコマンドは増えていない。
- 設定画面の「部品の権限」には、document.read を出していない（決める権限ではないため）。宣言した権限の一覧は、部品の一覧の Run。


## 未決のこと

- 部品が新しいファイルの種類（`.org` など）を足せるか。開くダイアログ、エクスプローラー、ネイティブ側の検査（`fileKinds.ts` と Rust 側の拡張子の判定）の両方に関わる。足せるなら、ネイティブの検査の変更が要る。
- 部品の配布と入れ方（フォルダに置くだけか、取り込みの操作か、入れ替えと削除の流れ）。
- 署名や出どころの確認。ほかの人の部品を入れる前提の、信頼の宣言の形。
- 仕様 §7.2 の改め方（エディタに関わる部品の範囲で、CodeMirror への依存を認める書き方）。
- 段 1 の中で、エディタの中に CodeMirror を持つ部品（1 節だけ広げて書く、S1）を、段 1 と段 3 のどちらで作るか。
- 段 1（見える iframe で部品が自由に描く表示）を作るか。作るなら、先に、Tauri の窓（WKWebView）で、sandbox の iframe の中の無限ループが本体のスレッドを止めるかを測る。止まるなら、段 1 は、iframe の応答の監視と作り直し（R5 の限界にある、仲介の iframe が応答しないときの検出と同じ仕組み）が前提になる。止まらないなら、段 1 を作れる。R7 のパネルは、この測定の結果によらず、段 2 の Worker だけで動く。
- Windows（WebView2）と Linux（WebKitGTK）での K1〜K3 の確認。独自プロトコルと IPC の経路が違う（Windows は `http://<プロトコル>.localhost`）ので、結果が同じとは限らない。
- 鍵が漏れたときの `postMessage` の経路を、ネイティブ側で塞げるか。R5 で、この構成（`plug:` の sandbox の iframe）では塞がっていないことを確かめ、R6 の取り直しでも同じだった（「R6 で確かめた隔離」）。塞ぐ手立て（R5 の提案の 2 と 3）は、ほかの人の部品を外から読み込む Run の前提とする（「R6 で決めた細部」の「鍵が漏れたときの経路の方針」）。それまでは、鍵を段 2 に渡さない規則で守る。
- セーフモードへの入り方（起動の引数だけか、異常終了の後の確認か）。
