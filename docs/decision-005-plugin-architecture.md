# ADR-005: 部品（プラグイン）の仕組み: 3 段の形、権限、変えないこと

## Status

Proposed（2026-11-03、R0）。この時点では案で、実装の Run で確定する。アプリのコードは変えていない。仕様 §7.2 の「編集エンジンを差し替えても UI は変えない」は、この ADR が確定したとき、エディタに関わる部品の範囲で改める（改め方は「未決のこと」）。仕様の文書そのもの（`docs/spec/`）は書き換えない。

R1（2026-11-03）で、段 3 の同梱の部品に限って API v0 を実装した。細部は「R1 で決めた細部」。R2（2026-11-03）で、フォーカスモードを 2 つ目の同梱の部品にした。細部は「R2 で決めた細部」。R3（2026-11-03）で、リストの継続を 3 つ目の同梱の部品にし、設定画面の選択肢の項目と「編集」の置き場所を足した。細部は「R3 で決めた細部」。R4（2026-11-04）で、Markdown の見た目（装飾、記号の表示、チェックボックスのクリック、リンクを開く操作）を 4 つ目の同梱の部品にし、本体が部品に貸す機能（外部の URL を開く、OS の判定）と、設定画面の「外観」の置き場所を足した。細部は「R4 で決めた細部」。

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
- 段: 隔離した表示（段 1）。本文と選択を受け取り、変更を送り返すだけで作れる。1 節だけ広げて書く機能は、エディタの中に CodeMirror を持つ必要があるので、段 3 になる可能性がある（未決。K3 の結果では、本文の受け渡しの速さは問題にならなかった）。
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
5. 隔離した表示の段（段 1）。最初は S1（アウトライン）。
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

R1・R2 と同じく、部品のテーマは CodeMirror が自動で付ける class（`ͼ` で始まる名前）を 1 つ増やすので、Markdown の文書では `.cm-editor` の class の数が 1 つ多い。素のテキストでは、部品が何も足さないので、文書の種類に応じた class の合成が 1 つ減り、`.cm-editor` の class 属性の末尾の空白がなくなる（原因は、変更前にあった、リンクを開く準備の状態を表す属性が足す空の class と考えられるが、未確認）。どちらも CSS に影響しない。変更前後の実ブラウザでの比較で、スクリーンショットの画素と、行・要素の class・位置・属性の記録は、この 2 点を除いて一致した。

### ホストが部品を知らないことの縛りの拡張

`architecture.test.ts` の、ホストのファイルの名前の検査に、`markupDisplay`、`MarkupDisplay`、`liveMarkup`、`taskToggle`、`linkOpen`、`markdownDecorations`、`lineKinds`、`cm-md-`（ただし `cm-md-blank` は除く）を足した（大文字小文字を問わず、コメントを含む）。ホストの一覧から `taskToggle.ts` を外し（部品に移った）、新しく本体に入ったファイル（`textKind.ts`、`RadioSettingsItem.tsx`）を足した。`src/features/markdown/` のファイルが import の縛りの対象になっていること、部品から本体の設定・OS の判定・bridge・画面・エディタを import しないことも確かめている。`EditorAdapter` から `setMarkupDisplay` と `onOpenLink` を外し、`createCodeMirrorAdapter` は本体が貸す機能を受け取る。

### R4 の限界

- 段 1・段 2 に貸す『外部の URL を開く』の「操作のたびに確かめる」の画面は、未実装（段 1・段 2 自体が後の Run）。
- `env` の関数は、段 3 の同期の API。非同期の API として貸す形は、段 2 の Run で決める。
- 部品がなければ、Markdown の文書の空行の高さの設定は効かない（素のテキストでは、本体が付ける）。
- 利用者の操作のときだけ呼ぶ、という規則は、段 3 では強制していない（呼ぶ側の規則）。
- Windows と Linux の実機で、リンクを開く修飾キーの判定を確かめていない（偽装した navigator での e2e のみ。変更前と同じ）。

## 未決のこと

- 部品が新しいファイルの種類（`.org` など）を足せるか。開くダイアログ、エクスプローラー、ネイティブ側の検査（`fileKinds.ts` と Rust 側の拡張子の判定）の両方に関わる。足せるなら、ネイティブの検査の変更が要る。
- 部品の配布と入れ方（フォルダに置くだけか、取り込みの操作か、入れ替えと削除の流れ）。
- 署名や出どころの確認。ほかの人の部品を入れる前提の、信頼の宣言の形。
- 仕様 §7.2 の改め方（エディタに関わる部品の範囲で、CodeMirror への依存を認める書き方）。
- 段 1 の中で、エディタの中に CodeMirror を持つ部品（1 節だけ広げて書く、S1）を、段 1 と段 3 のどちらで作るか。
- Windows（WebView2）と Linux（WebKitGTK）での K1〜K3 の確認。独自プロトコルと IPC の経路が違う（Windows は `http://<プロトコル>.localhost`）ので、結果が同じとは限らない。
- 鍵が漏れたときの `postMessage` の経路を、ネイティブ側で塞げるか（K1 の未検証）。
- セーフモードへの入り方（起動の引数だけか、異常終了の後の確認か）。
