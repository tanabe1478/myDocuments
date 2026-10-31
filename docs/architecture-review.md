# アーキテクチャレビュー（Phase 0 / P0-1・P0-2）

仕様: [immersive_markdown_editor_spec_v0.1.md](spec/immersive_markdown_editor_spec_v0.1.md)。判断は [decision-001-base-project.md](decision-001-base-project.md)。

## 結論

- MDE は macOS（Apple Silicon）でビルド・テスト・起動できた。ただし保存・外部変更検知・復旧・権限の各層は、仕様 §6・§10 の要件を満たしていない。
- この層は Rust 側ではなく TypeScript 側にあり、Rust 側は 84 行のプラグイン登録だけ。仕様 §7.2 の「Rust: File I/O / Watcher / Recovery / Permissions」に相当する実装は MDE にない。
- 再利用できるのは、純関数や小さなモジュール（外部変更の判定、CodeMirror のコマンド、diff 表示など）で、合計約 1.1K 行。MDE 全体は非テストコード 5,356 行。
- Milkdown（ビジュアル編集）は、編集すると文書全体が正規化され、frontmatter が壊れる。仕様 §5.3 の採用条件 2・4 を満たさない。
- 日本語 IME、Windows 11、Ubuntu 24.04 は未検証。

対象は MDE `506c1fd938a7ad4dafa0f51910e5c42ac5854369`（2026-10-27 コミット "Rewrite the README"、MIT）。clone 先は `phase0/vendor/MDE`（コミット対象外）。

## 1 ビルドと自動テスト（P0-1）

<!-- table:build-log:begin -->
| コマンド（cwd: phase0/vendor/MDE） | exit code | 所要秒 | 備考 |
| --- | --- | --- | --- |
| `npm ci --registry https://registry.npmjs.org` | 0 | 6.2 |  |
| `npm test` | 0 | 4 |  |
| `npm run typecheck` | 0 | 1.2 |  |
| `npm run build` | 0 | 6.5 |  |
| `npx tauri build --debug` | 1 | 48.1 | updater 署名鍵なし（TAURI_SIGNING_PRIVATE_KEY）で最終段が失敗。`.app` と `.dmg` は生成済み |
| `npx tauri build --debug --config {"bundle":{"createUpdaterArtifacts":false}}` | 0 | 33.6 |  |
<!-- table:build-log:end -->

- `npm test` は 16 ファイル・200 テストが成功（MDE 付属の vitest）。
- `npx tauri build --debug` が exit 1 になる理由は `src-tauri/tauri.conf.json:41` の `createUpdaterArtifacts: true`。updater の署名用秘密鍵（`TAURI_SIGNING_PRIVATE_KEY`）がないと最終段で失敗する。失敗時点で `MDE.app`（51 MB、debug）と `MDE_1.4.0_aarch64.dmg`（16 MB）は生成済みだった。updater 成果物を無効にした再実行は exit 0。
- cargo キャッシュなしの最初の `tauri build --debug` は 105 秒（手元のログによる観測で、`mde-build.json` には含まれない）。上表は cargo キャッシュありの再実行値。
- `npm ci` は 21 件の脆弱性を報告した（low 7 / moderate 4 / high 10）。本番スコープか開発スコープかは未精査。
- MDE の CI（`.github/workflows/ci.yml`）は ubuntu-latest で typecheck・test・web ビルドのみ。リリース（`release.yml`）は macOS arm64・x64、ubuntu-22.04、self-hosted Windows。これらの CI は実行していない（設定を読んだだけ）。
- 起動の実機確認: `src-tauri/target/debug/mde` を 20 回起動し、窓が表示されることを確認した（数値は [benchmark-baseline.md](benchmark-baseline.md)）。キー入力・ファイル操作の GUI 操作は自動化できておらず、未確認。

## 2 構成と仕様 §7.2 の対応

`src/` は非テスト 5,356 行（TS/TSX/CSS）、テスト 1,877 行、`src-tauri/src/` は 90 行。

| 仕様 §7.2 の層 | MDE の実体 | 判定 | 根拠 |
| --- | --- | --- | --- |
| Desktop Shell (Tauri 2) | `src-tauri/src/lib.rs`（84 行） | 再利用: ブートストラップだけ | プラグイン登録、single-instance、起動引数の `.md` 受け渡し（`lib.rs:5-17`）、窓を隠して起動し `frontend-ready` で表示（`lib.rs:59-69`、`App.tsx:648`）。この「隠して起動」は起動時のちらつき対策として参考になる |
| Rust: File I/O | なし | 新規 | ファイル入出力は TS から `@tauri-apps/plugin-fs` を直接呼ぶ（`fileOps.ts:22,30,46`） |
| Rust: Watcher | なし（plugin-fs の `watch` を TS から利用） | 新規または移植 | `fileWatcher.ts:118,145`。Rust 側に処理なし |
| Rust: Recovery | なし。`localStorage` | 新規 | `session.ts:11,25` |
| Rust: Permissions | `capabilities/default.json` | 置き換え | `fs:scope` が `{ "path": "**" }`（`default.json:29-31`）。全パス許可。`tauri.conf.json:27` の CSP は `null` |
| Writing Canvas | `App.tsx`（988 行）ほか | 置き換え | 画面・メニュー・タブ・コマンドパレット・AI 補助・エクスポート・更新が 1 つの巨大コンポーネントに同居 |
| Markdown Engine Adapter | なし（抽象なし） | 新規 | `EditorManager`（CodeMirror）と `MilkdownManager` は具象クラスのまま `App.tsx`・`EditorArea.tsx` から直接参照される。`EditorAdapter` に相当する interface はない |
| CodeMirror 6 | `editor/EditorManager.ts`（416 行）、`commands.ts`（282）、`frontmatterFold.ts`（26） | 再利用（設定は見直し） | 設定は `EditorManager.ts:187-281`。minimap、行番号、補完など仕様にない機能を含む |
| Milkdown（条件付き） | `editor/MilkdownManager.ts`（318 行） | P1 へ延期 | 下記 §4・§5 |
| Ambient Audio Manager | なし | 新規 | 音声ファイルも同梱なし |
| Preferences / Themes | `settings.ts`（70）、`editor/theme.ts`（244）、`index.css` | 置き換え | 仕様の背景・タイポグラフィ設定に対応する概念がない |

### 再利用・置き換え・削除（P0 作業項目 6 の見積り）

| 区分 | ファイル数 | 行数 | 内容 |
| --- | --- | --- | --- |
| そのまま再利用（小修正） | 13 | 1,127 | `commands.ts`、`frontmatterFold.ts`、`diffView.ts`、`DiffOverlay.tsx`、`fileWatcher.ts`、`autosave.ts`、`outline.ts`（P1）、`perf.ts`、`Toast.tsx`、`StatusBar.tsx` ほか |
| 改造して再利用 | 8 | 1,188 | `EditorManager.ts`、`MilkdownManager.ts`、`documentStore.ts`、`fileOps*.ts`、`settings.ts`、`main.tsx` |
| 置き換え | 12 | 2,169 | `App.tsx`、`EditorArea.tsx`、`theme.ts`、`index.css`、`milkdown-dark.css`、`session.ts`、`TitleBar.tsx`、`MenuBar.tsx`、`Toolbar.tsx`、`EmptyState.tsx` ほか |
| 削除 | 8 | 871 | `aiTools.ts`（AI 用のコピー整形）、`export.ts`、`updater.ts`、コマンドパレット、`mermaidRenderer.ts`、`TabBar.tsx`（P1）、`OutlineSidebar.tsx`（P1） |

行数は `wc -l` による。分類は読んだ内容に基づく判断で、実際に差し替えて確かめたものではない。

削除候補の依存: `mermaid`（本番ビルドで 593 KB の chunk、`cytoscape` 443 KB なども同系統）、`@replit/codemirror-minimap`、`marked`、`@tauri-apps/plugin-updater`（`tauri.conf.json:31-35` に公開鍵とエンドポイント）。`dist` は 7.5 MB。

## 3 保存・外部変更検知・復旧（P0 作業項目 4）

### 3.1 保存は一時ファイル→flush→rename か: いいえ

呼び出しの連鎖と、各段の実装は次のとおり。

| 段 | 場所 | 内容 |
| --- | --- | --- |
| UI | `App.tsx:408-427`（`handleSave`） | `saveFile(current.filePath, current.content)` を呼ぶ。dirty でなくても保存する |
| MDE | `fileOps.ts:28-35` | `writeTextFile(path, content)` を呼び、例外は握りつぶして `false` を返す（`:31-33`） |
| plugin-fs JS | `node_modules/@tauri-apps/plugin-fs/dist-js/index.js:682-693` | `new TextEncoder().encode(data)`（`:686`）を IPC で送る |
| plugin-fs Rust 2.4.5 | `src/commands.rs:859-894`、`:906` | `OpenOptions { write: true, truncate: true, create: true }`（`:880-892`）で開き、`file.write_all(&data)`（`:906`） |

- 一時ファイルへの書き込みも、`fsync`（`sync_all`/`sync_data`、OS にディスクへの書き出しを強制する呼び出し）も、`rename`による置換もない。plugin-fs の `src/*.rs` に `sync_all`・`sync_data`・一時ファイルは存在しない（`grep` で確認）。
- 開いた時点で `truncate: true` により元の内容が消える。書き込み途中のクラッシュやディスクフルでは、空または途中までのファイルが残る。仕様 FS-03「失敗時に元ファイルを残す」に不適合。
- エラーは `fileOps.ts:31-33` で例外情報が失われ、UI には「Failed to save」しか出ない（`App.tsx:419`）。

### 3.2 外部変更検知は内容ハッシュか、Rust 側か TS 側か: ハッシュではなく、TS 側

- 判定は `fileWatcher.ts:23-31` の `decideReload`。ディスクの文字列と、保存済み文字列・バッファの文字列を `===` で比べる。ハッシュ（SHA 等）は使わない。mtime・サイズも見ない。
- ファイルの再読込と判定は `App.tsx:158-196`（`reconcileFile`）で、すべて TS 側。Rust 側にウォッチャも比較処理もない。`Cargo.toml:26` で plugin-fs の `watch` 機能を有効にしているだけ。
- 監視は開いているファイルの親ディレクトリに対して行う（`fileWatcher.ts:4-8,118`）。他のエディタが「一時ファイル→rename」で保存すると、ファイル単位の監視が切れるため。デバウンス（連続イベントの間引き）は 400ms（`:61`）。イベントごとにファイルを読み直して比較するため、重複イベントは無害（冪等）。この設計は仕様 FS-05 に沿っていて、再利用する価値がある。
- 保存直前の再検査はない。`handleSave`（`App.tsx:408-427`）は、衝突状態（`conflicts`）を参照せずに書き込む。衝突の旗は監視イベント由来でしか立たない。衝突バナーの操作（再読込・保持・diff）は `App.tsx:212-228,915-` にあるが、バナーを無視して保存するとディスクの内容を上書きする。仕様 FS-04（保存直前に内容ハッシュ等で検出）と §1.1 原則 5（無言で上書きしない）に不適合。
- 自動保存（設定、既定 OFF: `settings.ts:18`）は、衝突中のタブを除外する（`autosave.ts:21-35`）。良い設計だが、書き込み先は元ファイル本体（`App.tsx:288`）で、仕様 FS-06「元の文書へ無断上書きしない」とは別設計。
- 比較は「デコード後の文字列」で行う。UTF-8 BOM は読み込み時に消えるため（§5）、BOM だけが違うファイルは同一に見える。

### 3.3 復旧

- 草稿は `localStorage` に JSON で保存する（`session.ts:22-27`）。10 秒ごと（`App.tsx:353-360`）とウィンドウを閉じるとき（`:506-511`）。次回起動で復元する（`:333-351`）。
- `localStorage` の容量超過は握りつぶされる（`session.ts:26` のコメント「quota — losing a snapshot is acceptable」）。1 MB の文書を複数タブで開いたときに保存できなくなる可能性があるが、WKWebView の上限値は未確認。
- 仕様 FS-06・FS-07 が求める「アプリデータ領域のファイル」「バックアップまたは復元可能な内容」にはなっていない。復旧自体は動く設計だが、容量とプロセス強制終了の挙動は検証していない（未検証）。

### 3.4 そのほか

- `handleSave` は React ストアの `tab.content` を書く。CodeMirror からストアへの反映は 100ms デバウンス（`EditorManager.ts:241-244`）で、自動保存は CodeMirror の現在値を使う（`App.tsx:282`）。最後の入力から 100ms 以内の明示保存が古い内容を書く可能性があるが、コードを読んだ推測で、再現していない（未確認）。
- 起動引数で渡された `.md` を開く処理は `lib.rs:5-17`。引数のパスはそのまま `fs:scope: **` で読まれる。

## 4 エディタ層

- CodeMirror（`EditorManager.ts`）はタブごとに `EditorView` を持ち、内容を 100ms デバウンスで React に通知する（`:238-245`）。1 万行を超える文書では minimap を外す（`:67`）。
- Milkdown（`MilkdownManager.ts`）は Crepe（Milkdown の組み込みエディタ）を `:132-158` の設定で生成する。LaTeX は無効、表・画像・CodeMirror ブロックは有効。
- モード切替だけでバイト列が変わらないのは、`getContentForRawSync`（`:291-296`）が「ユーザーが編集していなければ元の文字列を返す」ガードを持つため。Milkdown の出力そのものはバイト列を保たない（§5）。ガードは `markdownUpdated` の内容比較（`:165-185`）で成り立っており、いったん編集すると文書全体が Milkdown の出力に置き換わる。
- モード切替の処理順は `EditorArea.tsx:82-109`。

## 5 Markdown round-trip 忠実性（P0-2）

round-trip は「読み込んで保存したとき、バイト列が元に戻るか」。

### 方法

- ハーネス: `phase0/harness/`（Vite ページ）と `phase0/roundtrip/run.mjs`（Playwright で駆動）。
- MDE の実コードを使う部分: `@tauri-apps/plugin-fs` の JS、`fileOps.saveFile`、`EditorManager`（CodeMirror）、`MilkdownManager`（Crepe）。置き換えたのは Tauri IPC の Rust 側だけで、読み出しは生バイト、書き込みは生バイトの素通し。この素通しが実物と同じ挙動であることは `commands.rs:365-374`（読み出し）と `:906`（書き込み）を読んで確認した。
- 動かしていない部分: React の `App.tsx`（状態遷移）、実際の Tauri 窓、OS のファイルシステム。
- ブラウザは Playwright の chromium と webkit（macOS）。両方で全ケースが同一の出力（SHA-256 一致）になった。
- fixture 10 個（`phase0/fixtures/`、`phase0/roundtrip/make-fixtures.mjs` で生成）: LF、CRLF、BOM 付き LF、BOM 付き CRLF 日本語、日本語、frontmatter、表、コードブロック、リンク定義、HTML ブロック。

経路:
- a1: 読み込み→無編集で保存（`App.tsx` の保存は `tab.content` をそのまま書く）
- a2: CodeMirror に読み込ませた後、`getContent()` の文字列を保存（無編集）
- a3: CodeMirror で 1 文字挿入→削除し、`onChange` で渡る文字列を保存
- b1: Milkdown に読み込ませ `getMarkdown()`（無編集）
- b2: MDE のガード経由（`getContentForRawSync`、無編集）
- b3: Milkdown 上で文末に `X` を実際にキー入力した後の値。比較では `X` を 1 つ取り除く

### 結果

<!-- table:roundtrip-matrix:begin -->
| fixture | 元 | a1 無編集保存 | a2 CM経由保存 | a3 CM 1字入力削除 | b1 Milkdown直出力 | b2 MDEガード経由 | b3 Milkdown 1字入力後 | chromium/webkit |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `bom-crlf-japanese.md` | CRLF+BOM 532B | 不一致(Δ-3B) | 不一致(Δ-15B) | 不一致(Δ-15B) | 不一致(Δ-14B) | 不一致(Δ-3B) | 不一致(X除く, Δ-14B) | 同一 |
| `bom-lf.md` | LF+BOM 213B | 不一致(Δ-3B) | 不一致(Δ-3B) | 不一致(Δ-3B) | 不一致(Δ-1B) | 不一致(Δ-3B) | 不一致(X除く, Δ-1B) | 同一 |
| `codeblock.md` | LF 190B | 一致 | 一致 | 一致 | 不一致(Δ+5B) | 一致 | 不一致(X除く, Δ+5B) | 同一 |
| `crlf.md` | CRLF 224B | 一致 | 不一致(Δ-14B) | 不一致(Δ-14B) | 不一致(Δ-12B) | 一致 | 不一致(X除く, Δ-12B) | 同一 |
| `frontmatter.md` | LF 144B | 一致 | 一致 | 一致 | 不一致(Δ+7B) | 一致 | 不一致(X除く, Δ+7B) | 同一 |
| `htmlblock.md` | LF 241B | 一致 | 一致 | 一致 | 一致 | 一致 | 一致(X除く) | 同一 |
| `japanese.md` | LF 517B | 一致 | 一致 | 一致 | 不一致(Δ+1B) | 一致 | 不一致(X除く, Δ+1B) | 同一 |
| `lf.md` | LF 210B | 一致 | 一致 | 一致 | 不一致(Δ+2B) | 一致 | 不一致(X除く, Δ+2B) | 同一 |
| `linkdefs.md` | LF 267B | 一致 | 一致 | 一致 | 不一致(Δ-48B) | 一致 | 不一致(X除く, Δ-48B) | 同一 |
| `table.md` | LF 145B | 一致 | 一致 | 一致 | 不一致(Δ+28B) | 一致 | 不一致(X除く, Δ+28B) | 同一 |
<!-- table:roundtrip-matrix:end -->

<!-- table:roundtrip-counts:begin -->
| 経路 | バイト一致した fixture 数（全 10） |
| --- | --- |
| a1_noEditSave | 8 |
| a2_cmNoEditSave | 7 |
| a3_cmEditRevertSave | 7 |
| b1_milkdownSerialized | 1 |
| b2_guardedRawSyncNoEdit | 8 |
| b3_afterTypingX | 1 |
<!-- table:roundtrip-counts:end -->

### 読み取れること

- BOM は最初の保存で消える。原因は `plugin-fs/dist-js/index.js:450` の `new TextDecoder().decode(bytes)`。TextDecoder は既定で BOM を捨てる。仕様 ED-05・ED-06 に不適合（a1）。
- CRLF は、無編集で保存する限り保たれる（a1）。CodeMirror を通すと LF になる（a2・a3）。CodeMirror の文書モデルが改行を `\n` に正規化するため。つまり最初の編集でファイル全体の改行が CRLF から LF に変わる。保存時に元の改行コードへ戻す処理が MDE にない。
- Milkdown の直接出力は、10 個中 1 個（HTML ブロック）しかバイト一致しない（b1）。観測できた書き換え:
  - 箇条書きの `-` が `*` になり、リストが疎（項目間に空行）になる（`lf.md`）
  - インデントのコードブロックがフェンスコードブロックになる（`codeblock.md`）
  - frontmatter の `---` が `***`（水平線）になり、YAML が段落になる（`frontmatter.md`）。frontmatter が壊れる
  - リンク参照定義が消え、リンクがインライン化される（`linkdefs.md`）
  - 表の桁が揃えられる（`table.md`）
  - 日本語の本文そのものは保たれるが、箇条書きは `*` になる（`japanese.md`）
- MDE のガード（b2）は、無編集のモード切替ではバイトを保つ（BOM 欠落を除く）。1 文字でも入力すると全体が Milkdown の出力になり、上記の書き換えがすべて保存される（b3）。
- 仕様 §5.3 の判定: 条件 1（切替だけでは変化しない）はガードにより満たす。条件 2（意味が壊れない、正規化は明示し戻せる）と条件 4（frontmatter などを壊さない）は満たさない。ビジュアル編集は P1 へ延期する。

### 限界

- 混在改行（CRLF と LF の混在）、不正な UTF-8、BOM のみのファイルは試していない。
- 日本語 IME による入力は試していない（Playwright は IME の変換操作を再現できない。`insertText` は変換中状態を作らない）。
- ここまでの結果は macOS 上のブラウザエンジンに限る。Windows 11・Ubuntu 24.04 は未検証。

## 6 日本語 IME 手動テスト手順（3 OS、未実施）

IME（Input Method Editor）は、かな漢字変換などの入力方式。変換中は文字が仮の状態（composition）で、確定すると本文に入る。

### 準備

1. `phase0/vendor/MDE` で `npx tauri build --debug`（署名エラーは §1 の注記のとおり。`--config '{"bundle":{"createUpdaterArtifacts":false}}'` を付けると exit 0）。起動は `src-tauri/target/debug/mde`。
2. テスト用ファイルは `phase0/fixtures/japanese.md`、`phase0/fixtures/perf/A-10kb-ja.md`、`B-100kb-mixed.md`。
3. 次を記録する。

| OS | IME | 記録するもの |
| --- | --- | --- |
| Windows 11 (x64) | Microsoft IME | OS ビルド、IME のバージョン、WebView2 のバージョン |
| macOS (Apple Silicon) | macOS 標準の日本語入力 | macOS バージョン、`ひらがな` モード、Safari/WebKit のバージョン |
| Ubuntu 24.04 (x64, GNOME) | Mozc（IBus または Fcitx） | `echo $XDG_SESSION_TYPE`（Wayland か X11）、`ibus version` または `fcitx5 --version`、WebKitGTK のバージョン |

### 手順（CodeMirror のソースモードで実施。ビジュアルモードは P1 の対象）

| ID | 操作 | 期待 |
| --- | --- | --- |
| IME-1 | 空の文書で「きょうはいいてんきです」と入力し、変換して確定 | 文字が消えない。確定後に二重にならない |
| IME-2 | 200 文字以上を連続入力（途中で変換と確定を繰り返す） | 文字消失・カーソル飛びなし |
| IME-3 | 変換中（下線あり）に Esc | 変換が取り消され、仮の文字だけが消える。既存の本文は残る |
| IME-4 | 変換中に Enter で確定し、続けて Enter で改行 | 確定で改行されない。次の Enter で 1 回だけ改行 |
| IME-5 | 確定後に Undo、Redo（Ctrl/Cmd+Z、Ctrl+Y/Cmd+Shift+Z） | 確定単位で戻る。文字が消失・重複しない |
| IME-6 | 変換中にクリックで別の位置へ移動 | 変換が確定または取り消され、本文が壊れない |
| IME-7 | 確定済みの語を選んで再変換（OS の再変換操作） | 置き換わり、周囲が壊れない |
| IME-8 | テキストを範囲選択した状態で入力開始 | 選択範囲が置き換わる |
| IME-9 | 行頭の `# `、`- `、`1. ` の直後、表のセル内、コードブロック内で入力 | 記法が壊れず、候補ウィンドウが入力位置の近くに出る |
| IME-10 | 文中への挿入（行の途中にカーソルを置いて入力） | カーソル位置が保たれる |
| IME-11 | 全画面切替、別モニターへの移動、拡大率変更の後で入力 | 候補ウィンドウ位置のずれ・入力不能なし |
| IME-12 | 日本語を入力後、保存してバイト列を確認（`xxd` / `Format-Hex`） | 入力した UTF-8 のみ。意図しない改行・BOM の変化なし |

判定の記入形式（OS・IME・ID ごとに 1 行）: `合格 / 不合格 / 不能`、観察、再現条件。

補助: 開発者ツール（デバッグビルドで使えるかは未確認。使えなければブラウザ版 `npm run dev` で代用）で次を貼ると composition の流れを記録できる。

```js
['compositionstart','compositionupdate','compositionend','beforeinput','input'].forEach(t =>
  document.addEventListener(t, e => console.log(t, e.data, e.inputType, performance.now().toFixed(1)), true));
```

不合格の記録は「入力データの整合性に影響する差」（仕様 §8.2 のリリースブロッカー）かどうかを分けて書く。

## 再現コマンド

リポジトリのルートで実行する。

```sh
# MDE を取得して固定コミットに合わせる
git clone https://github.com/sevenevesai/MDE phase0/vendor/MDE
git -C phase0/vendor/MDE checkout 506c1fd938a7ad4dafa0f51910e5c42ac5854369

# P0-1: ビルドとテスト（結果は phase0/results/mde-build.json）
node scripts/run-mde-checks.mjs --tauri

# P0-2: round-trip（結果は phase0/results/roundtrip.json）
(cd phase0 && npm install --registry https://registry.npmjs.org)   # playwright-core のみ
node phase0/roundtrip/make-fixtures.mjs
(cd phase0/vendor/MDE && npx vite build --config ../../harness/vite.config.mjs)
node phase0/roundtrip/run.mjs chromium,webkit

# このドキュメントの表を JSON から再生成して検査
node scripts/render-tables.mjs --write
node scripts/check-phase0.mjs
```

Playwright のブラウザは `~/Library/Caches/ms-playwright` に既にあるものを使った（新規ダウンロードなし）。ない環境では `npx playwright-core install chromium webkit` が必要（未実行）。

## 計測環境

| 項目 | 値 |
| --- | --- |
| マシン | Apple M5、10 コア、32 GiB |
| OS | macOS 26.7.2（Darwin 25.6.0）、arm64 |
| Node / npm | v24.19.0 / 11.17.0（mise 管理） |
| cargo | 1.97.1 |
| ブラウザ | Playwright chromium 156.0.8078.4、webkit 27.2（ともに headless。システムの WKWebView とは別ビルド） |
| 実行日 | 2026-10-31 |

round-trip の結果はファイル内容（バイト列）の比較で、実行時間に依存しない。

## 未検証

- Windows 11（x64）と Ubuntu 24.04 でのビルド・起動・保存・IME（実機がない）。MDE の CI は ubuntu-latest で web ビルドのみで、Tauri の Windows/Ubuntu ビルドは未実行。
- 日本語 IME の全項目（§6 の手順のみ）。
- 保存の GUI 経由の操作（メニュー・ショートカット・ダイアログ）。ハーネスは `fileOps.saveFile` までで、`App.tsx` を経由していない。
- 実際の OS ファイルシステムへの書き込み（強制終了時の中途半端なファイル、ディスクフル、シンボリックリンク、ネットワークドライブ）。
- 外部変更検知の実動作（別プロセスが書き換えたときの衝突バナー）。コードの読解のみ。
- 100ms デバウンスと保存の競合（§3.4）。
- 混在改行、不正な UTF-8 の扱い。
- `npm audit` の指摘 21 件のトリアージ。
- Playwright の WebKit は macOS のシステム WKWebView と同一ではない。
