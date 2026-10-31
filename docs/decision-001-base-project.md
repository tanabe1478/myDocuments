# ADR-001: 基盤プロジェクトの選定（MDE フォークか、新規 Tauri シェルか）

## Status

Proposed（提案）。仕様 §14 のとおり、Phase 0 の証拠に基づく提案であり、承認は人間が行う。承認されるまで Phase 1 の UI 書き換えには着手しない。

日付: 2026-10-31。対象の MDE: `506c1fd938a7ad4dafa0f51910e5c42ac5854369`。

## Context

仕様 §7.3 は MDE（https://github.com/sevenevesai/MDE、MIT）を第一候補として検証し、保存品質・IME・性能・UI 独立性に重大な問題があれば、新規 Tauri シェル + CodeMirror 6 に切り替えると定めている（§12 Phase 0 の判断）。検証した証拠は次のとおり。出典は各文書。

<!-- table:adr-evidence:begin -->
| 基準 | 観測 | 出典 |
| --- | --- | --- |
| 保存品質: 無編集保存 | BOM 付き fixture 2/2 で BOM 欠落、BOM なしは 8/8 でバイト一致（a1） | roundtrip.json a1_noEditSave |
| 保存品質: CodeMirror 経由 | CRLF fixture 2/2 が LF 化（a2）。CM6 の既定 line separator 正規化 | roundtrip.json a2_cmNoEditSave |
| 保存品質: Milkdown | 無編集 serialize で一致 1/10、1 字入力後（X除く）で一致 1/10 | roundtrip.json b1/b3 |
| 保存品質: 書込方式 | plugin-fs の write は truncate して write_all。一時ファイル・fsync・rename なし | architecture-review.md §3 |
| 外部変更検知 | 内容比較は TS 側の文字列等価。ハッシュなし。保存直前の再検査なし | architecture-review.md §3 |
| 性能: 100KB 読込 (B) | webkit: CM6 21 (p95 44) ms / Milkdown 150 (p95 216) ms | benchmark.json |
| 性能: 入力遅延 (B) | webkit: CM6 7 (p95 10) ms / Milkdown 8 (p95 11) ms | benchmark.json |
| 性能: ストレス (D) 読込 | webkit: CM6 93 (p95 107) ms / Milkdown 3097 (p95 3192) ms | benchmark.json |
| ライセンス | npm 585 / cargo 559 パッケージ。MPL-2.0 は npm 12 件（すべて開発スコープ）と cargo 7 件。選択余地のない強いコピーレフトは 0 件 | licenses.json |
<!-- table:adr-evidence:end -->

詳細: [architecture-review.md](architecture-review.md)（構成・保存・round-trip）、[benchmark-baseline.md](benchmark-baseline.md)（性能）、[licensing-audit.md](licensing-audit.md)（ライセンス）。

検証できなかったもの（判断に影響しうる）: 日本語 IME（3 OS とも）、Windows 11、Ubuntu 24.04、Tauri 実機での入力遅延。

## Options

### A. MDE をフォークする

- 得られるもの: 動作する Tauri 2 + React + CodeMirror 6 の土台、約 1.1K 行の再利用可能な小モジュール（外部変更の判定、編集コマンド、diff 表示）、200 件のユニットテスト、macOS でのビルドと起動の実績。
- 持ち込むもの: 保存が `truncate` + `write_all` で、一時ファイル・fsync・rename がない。外部変更検知はハッシュなしで、保存直前の再検査がない。復旧は `localStorage`。権限は `fs:scope: **`、CSP は `null`。Rust 側は 84 行で、仕様 §7.2 の Rust 層が空。これらはすべて、置き換えか新規実装が要る。
- そのほか: `App.tsx` が 988 行の単一コンポーネントで、メニュー・タブ・コマンドパレット・AI 補助・エクスポート・更新が同居する。削除対象は 8 ファイル 871 行に加え、`mermaid`・`katex` など重い依存（`dist` は 7.5 MB）と、updater の鍵設定（`createUpdaterArtifacts: true` により、鍵がないと `tauri build` が exit 1 になる）。ロゴは MDE の識別で再利用できない。

### B. 新規 Tauri シェル + CodeMirror 6（MDE は参考実装）

- 得られるもの: 仕様 §7.2 の層（Rust の File I/O・Watcher・Recovery・Permissions、`EditorAdapter`、執筆キャンバス）を最初から設計に反映できる。不要な機能・依存を持ち込まない。権限を選択したファイルに限定する構成から始められる。
- MDE から移すもの（MIT 表記を保つ）: `decideReload` と親ディレクトリ監視の設計（`fileWatcher.ts`）、`selectAutoSaveTargets`（`autosave.ts`）、`commands.ts`・`frontmatterFold.ts`・`diffView.ts`・`DiffOverlay.tsx`、ユニットテストの該当部分、窓を隠して起動し描画後に表示する方式（`lib.rs:59-69`）。
- 失うもの: MDE の「動く全体」。取り込んだ部品の動作は、新しい構成で改めて検証する必要がある。

### 判断基準（仕様 §12 Phase 0）での比較

| 基準 | A. フォーク | B. 新規シェル | 差を生むか |
| --- | --- | --- | --- |
| 保存品質 | 書き込み・検知・復旧・権限の実装を総入れ替えする（BOM 欠落、CRLF の LF 化、非アトミック書込、ハッシュなし） | 同じものを新規に実装する | 小さい。どちらも書き直し。A は書き直す対象を消す作業が加わる |
| IME | 未検証（3 OS）。CodeMirror 6 が主エンジンで、結果は A・B 共通 | 同じ | なし。Milkdown 側の IME は P1 へ延期するため判断に使わない |
| 性能 | CodeMirror 6 は A〜C で p95 18ms 以下、B の読み込みは中央値 21ms 以下。Milkdown は D で劣る（読み込み 2.6〜3.1 秒、入力 p95 最大 76ms） | CodeMirror 6 だけを持つので同じ数値 | なし。Milkdown を外せば同じ |
| UI 独立性 | 既存 UI が App.tsx に密結合。置き換え 12 ファイル 2,169 行、削除 8 ファイル 871 行 | UI は最初から独立 | 大きい。ただし A でも置き換えは可能で、不可能という証拠はない |

重大な問題の有無（仕様の判定文）: 保存品質について、MDE は要件 FS-03・FS-04 を満たさず、ED-05・ED-06 も満たさない。ただしこの問題は「MDE の部品の質」ではなく「層が未実装」であり、フォーク後に直す対象でもある。

## Decision

B を提案する: 新規 Tauri 2 シェル + CodeMirror 6 とし、MDE は参考実装として扱う。MDE のコードを移す場合は MIT の表記を保つ。

理由（証拠に基づく）:

1. 保存・外部変更検知・復旧・権限という、仕様が最も重視する層は、MDE では置き換え対象に分類される。フォークしても、この層に関して得られる初期状態は「Rust 側が空」であり、書き直す量は A も B も同じ。
2. 再利用できる部品は、純関数や小さなモジュールで、A でも B でも同じく使える（B には移植の手間がある）。フォークだけが得る利点は、ビルド設定と起動確認済みの土台。これは scaffold 作業の 1〜2 日分にとどまると見ている（見積り、実測ではない）。
3. 取り除く側の作業は A に特有。AI 補助・エクスポート・更新・タブ・コマンドパレット・Mermaid の削除と、`App.tsx` の分解、依存の整理（`dist` 7.5 MB の主因は mermaid・katex・cytoscape）、updater 鍵設定の除去。
4. Milkdown は、1 文字の編集で文書全体を正規化し（箇条書き記号、リンク参照定義、表の桁、インデントコード）、frontmatter を壊す。仕様 §5.3 の条件 2・4 を満たさないため、ビジュアル編集は P1 へ延期する。これで Milkdown を持つ理由が MVP から消え、A の持ち込みのうち最大の依存群を捨てることになる。
5. ライセンス面では、どちらの選択肢にも MIT 以外の強いコピーレフトはない。差を生まない。

反対の見方（A を選ぶ根拠）: MDE は動いている完成品で、検証済みの 200 テストと CI がある。タブ・アウトライン・差分表示は仕様 P1 の機能で、将来使える。次の見積りで B の優位が小さいことを示す。優位が不確かさの範囲内なら、保守の簡単さから A を選ぶ判断もありうる。この点は承認者の判断に委ねる。

## Consequences

### 次フェーズ（Phase 1: 執筆キャンバス）の作業量見積り

単位は人日（1 人が集中して作業した 1 日）。LOC（行数）と手元の作業感覚による見積りで、実測ではない。不確かさは ±40% 程度。

| 作業 | B（推奨） | A（フォーク） | 備考 |
| --- | --- | --- | --- |
| シェルの scaffold（Tauri 2、Vite、React/TS、lint、テスト基盤、CI で 3 OS ビルド） | 2 | 1 + 3（機能の削除、依存整理、updater 設定の除去） | A は動く土台が先にあるが、削除と検証が要る |
| `EditorAdapter` と CodeMirror 6 の構成（`commands.ts` などの移植、interface の導入） | 3 | 3 | A は `App.tsx` との密結合を剥がす作業 |
| 執筆キャンバス（本文幅、タイポグラフィ、背景色・画像・オーバーレイ、フォーカス、タイプライター、自動非表示） | 8 | 9 | 新規のコードはほぼ同じ。A は既存の theme・Tailwind を剥がす分 +1 |
| 3 OS の IME・フォントの回帰テストの整備（手動手順 + 可能な自動化） | 4 | 4 | architecture-review.md §6 が出発点 |
| 合計 | 17（14〜20） | 20（17〜25） | 差は主に A の「削除・剥がし」。不確かさの範囲と重なる |

Phase 1 に含まれない保存・復旧・競合処理（仕様 Phase 2）の見積りは、A でも B でも同程度（約 8〜10 人日）。MDE の実装が置き換え対象のため。内訳: Rust のアトミック保存（一時ファイル・fsync・rename）、保存直前の内容ハッシュ検査、ファイル監視、アプリデータ領域への復旧保存、権限スコープの限定。

### 前倒しすべき作業（どちらを選んでも）

1. Windows 11 と Ubuntu 24.04 での Tauri ビルドと起動確認（CI の matrix）。Phase 0 では未検証。
2. 3 OS の日本語 IME の手動テスト（architecture-review.md §6）。結果は編集エンジンの選定に直接効く。
3. 保存の BOM・改行コード保持の方針決定。現状の観測では、BOM は読み込み時に消え、CRLF は CodeMirror を通すと LF になる。保存時に元の BOM・改行コードを復元するのか、元の形式を保持したまま編集するのかを決める。

### 判断を見直す条件

- 手動 IME テストで、CodeMirror 6 が 3 OS のいずれかでデータ整合性に影響する問題を出したとき。B でも A でも主エンジンは同じなので、シェル選定ではなく編集エンジンの再検討になる。
- 承認者が、MDE の機能（タブ、アウトライン、diff、Milkdown）を MVP に含めたいと判断したとき。その場合は A の優位が上がる。
- Windows・Ubuntu のビルドで、B の構成に固有の問題が出たとき（現時点で兆候はなく、未検証）。

### 副作用と注意

- MDE の MIT 表示を、移植したファイルとリポジトリに残す。
- B を選ぶと、MDE のユニットテスト 200 件のうち移植部品の分しか引き継がれない。移植時にテストも移す。
- `phase0/` の検証ハーネスと結果は、判断後も回帰測定の出発点として使える。`phase0/vendor/MDE` はコミットしない。

## 再現コマンド

この ADR の根拠は各文書の再現コマンドで再生成できる。

```sh
node scripts/run-mde-checks.mjs --tauri                  # architecture-review.md
node phase0/roundtrip/run.mjs chromium,webkit            # 同上（round-trip）
node phase0/bench/run.mjs chromium,webkit                # benchmark-baseline.md
RUNS=5 node phase0/bench/tauri-smoke.mjs                 # 同上（Tauri 実機）
node scripts/audit-licenses.mjs                          # licensing-audit.md
node scripts/render-tables.mjs --write                   # 各文書の表を JSON から再生成
node scripts/check-phase0.mjs                            # 4 文書と JSON の整合を検査
```

前提の取得手順（MDE の clone と固定コミット、`npm ci`、harness のビルド）は [architecture-review.md](architecture-review.md) の「再現コマンド」を参照。

## 計測環境

Apple M5（10 コア、32 GiB）、macOS 26.7.2、Node v24.19.0、cargo 1.97.1。ブラウザは Playwright の chromium 156.0.8078.4 と webkit 27.2（headless）。詳細は [benchmark-baseline.md](benchmark-baseline.md) の「測定環境」。作業量の見積りは計測ではなく、上記の観測から立てた推定。

## 未検証

- 日本語 IME（Windows: Microsoft IME、macOS: 日本語入力、Ubuntu: Mozc）の全項目。
- Windows 11（x64）と Ubuntu 24.04（x64）でのビルド・起動・保存・性能。
- Tauri 実機での入力→描画遅延、モード切替、ファイルを開く時間、release ビルドの起動時間・メモリ・サイズ。
- 実ファイルシステムでの保存の失敗系（強制終了、ディスクフル）、外部変更検知の実動作、シンボリックリンク・ネットワークドライブ。
- 依存ライセンスの法的解釈、KaTeX フォントの個別ライセンス、MDE ロゴの権利。
- 作業量の見積り（実装して確かめていない）。
