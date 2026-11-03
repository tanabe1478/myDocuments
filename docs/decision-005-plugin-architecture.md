# ADR-005: 部品（プラグイン）の仕組み: 3 段の形、権限、変えないこと

## Status

Proposed（2026-11-03、R0）。この時点では案で、実装の Run で確定する。アプリのコードは変えていない。仕様 §7.2 の「編集エンジンを差し替えても UI は変えない」は、この ADR が確定したとき、エディタに関わる部品の範囲で改める（改め方は「未決のこと」）。仕様の文書そのもの（`docs/spec/`）は書き換えない。

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

## 未決のこと

- 部品が新しいファイルの種類（`.org` など）を足せるか。開くダイアログ、エクスプローラー、ネイティブ側の検査（`fileKinds.ts` と Rust 側の拡張子の判定）の両方に関わる。足せるなら、ネイティブの検査の変更が要る。
- 部品の配布と入れ方（フォルダに置くだけか、取り込みの操作か、入れ替えと削除の流れ）。
- 署名や出どころの確認。ほかの人の部品を入れる前提の、信頼の宣言の形。
- 仕様 §7.2 の改め方（エディタに関わる部品の範囲で、CodeMirror への依存を認める書き方）。
- 段 1 の中で、エディタの中に CodeMirror を持つ部品（1 節だけ広げて書く、S1）を、段 1 と段 3 のどちらで作るか。
- Windows（WebView2）と Linux（WebKitGTK）での K1〜K3 の確認。独自プロトコルと IPC の経路が違う（Windows は `http://<プロトコル>.localhost`）ので、結果が同じとは限らない。
- 鍵が漏れたときの `postMessage` の経路を、ネイティブ側で塞げるか（K1 の未検証）。
- セーフモードへの入り方（起動の引数だけか、異常終了の後の確認か）。
