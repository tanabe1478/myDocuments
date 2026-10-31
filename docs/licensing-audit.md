# ライセンス監査（Phase 0 / P0-4）

MDE 本体と、npm・cargo の直接依存および推移依存（依存の依存）のライセンスを列挙し、MIT 以外、帰属表示が要るもの、同梱アセットを洗い出す。生データは `phase0/results/licenses.json`（全パッケージのライセンス・スコープ・分類を含む）。

これは自動集計と目視確認による技術的な棚卸しで、法的な判断ではない。配布前に法務の確認が要る項目は「未検証」に挙げる。

## 結論

- MDE 本体は MIT（`LICENSE`、"Copyright (c) 2026 MDE Contributors"）。MDE のコードを取り込む場合は、著作権表示と許諾文を残す必要がある。
- 依存は npm 585 件・cargo 559 件。強いコピーレフト（GPL・AGPL 系）で、選択の余地がないものは 0 件。ライセンス表記がないものも 0 件（`khroma` は `package.json` に欠けていたが、LICENSE ファイルが MIT だった）。
- MIT 以外で注意が要るのは MPL-2.0（ファイル単位のコピーレフト）、CC-BY-4.0（帰属表示）、同梱される KaTeX フォント（個別のライセンス未確認）の 3 点。
- 音声・動画は MDE に含まれない。仕様 §4.3 の環境音は、素材とライセンスの確認を別途行う必要がある。
- MDE のロゴ画像（`src-tauri/icons/`）は MDE の識別そのもので、フォークしても再利用しない。

## 依存の集計

<!-- table:lic-summary:begin -->
| 区分 | 総数 | 内訳（上位） | 分類 |
| --- | --- | --- | --- |
| npm（推移依存含む, package-lock.json） | 585（本番 324 / 開発 260） | MIT:475, ISC:48, Apache-2.0 OR MIT:13, BSD-3-Clause:12, MPL-2.0:12, Apache-2.0:6 | permissive:572, notice-required-other:1, weak-copyleft:12 |
| cargo（推移依存含む, 全ターゲット, Cargo.lock） | 559（aarch64-apple-darwin で解決 324） | MIT OR Apache-2.0:254, MIT:135, Apache-2.0 OR MIT:50, MIT/Apache-2.0:26, Unicode-3.0:18, Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT:15 | permissive:551, weak-copyleft:7, unknown:1 |
<!-- table:lic-summary:end -->

- 「本番／開発」は `package-lock.json` の `dev` フラグによる。「aarch64-apple-darwin で解決」は `cargo metadata --filter-platform aarch64-apple-darwin` の結果で、ビルド専用の依存（`tauri-build` など）を含む。
- 分類（`permissive`・`weak-copyleft` など）は `scripts/audit-licenses.mjs` の簡易判定。SPDX 式の `OR` は選べる中で最も緩いもの、`AND` は最も厳しいものを採る。例: `MIT OR Apache-2.0 OR LGPL-2.1-or-later`（`r-efi`、別ターゲット用）は MIT を選べるので permissive。
- 直接依存は、npm がすべて MIT または Apache-2.0（Tauri 系は `MIT OR Apache-2.0`、`typescript` は Apache-2.0）。cargo の直接依存 11 個はすべて `MIT OR Apache-2.0`。

## MIT 以外で注意が要るもの

<!-- table:lic-flagged:begin -->
| エコシステム | ライセンス | スコープ | 分類 | 件数 | 該当（先頭） |
| --- | --- | --- | --- | --- | --- |
| npm | CC-BY-4.0 | dev | notice-required-other | 1 | caniuse-lite |
| npm | MPL-2.0 | dev | weak-copyleft | 12 | lightningcss, lightningcss-android-arm64, lightningcss-darwin-arm64, lightningcss-darwin-x64 ほか8 |
| cargo | MPL-2.0 | macos-arm64-resolved | weak-copyleft | 5 | cssparser, cssparser-macros, dtoa-short, option-ext ほか1 |
| cargo | MPL-2.0 | other-target-or-dev | weak-copyleft | 2 | cssparser, selectors |
| cargo | CDLA-Permissive-2.0 | other-target-or-dev | unknown | 1 | webpki-root-certs |
<!-- table:lic-flagged:end -->

### MPL-2.0（Mozilla Public License 2.0）

ファイル単位のコピーレフト。MPL のファイルを改変して配布する場合は、そのファイルのソースを公開する必要がある。改変せずに依存として使うだけなら、ライセンス文と入手先の表示が主な義務になる（解釈は未検証）。

- npm: `lightningcss` と各 OS 向けのバイナリ（12 件）。すべて開発スコープ。`@tailwindcss/vite` 経由のビルドツールで、配布物に含まれるかは未確認。
- cargo: `cssparser`（0.29.6、0.36.0）、`cssparser-macros`、`selectors`（0.24.0、0.36.1）、`dtoa-short`、`option-ext`。
  - `cssparser`・`cssparser-macros`・`dtoa-short` は `tauri-macros`（proc macro、コンパイル時にだけ動く）の先にある（`cargo tree -e normal -i` で確認）。`strings` でデバッグバイナリを見ると `cssparser` の文字列は 0 件で、最終バイナリに含まれていない可能性が高いが、確証はない（間接証拠）。
  - `option-ext` は `dirs` 経由で `tauri` 本体の実行時依存。最終バイナリに入る。
  - `0.36.0` と `0.36.1` は別ターゲット側の解決。macOS では使われない。
- npm の本番スコープに MPL-2.0 はない。`dompurify` は `MPL-2.0 OR Apache-2.0` で、Apache-2.0 を選べる。

### CC-BY-4.0（帰属表示が必要）

`caniuse-lite`（開発スコープ、ブラウザ互換データ）。ビルド時にだけ使われ、配布物に含まれるかは未確認。含める場合は帰属表示が必要。

### 帰属表示が必要な寛容系

MIT、BSD-2/3-Clause、ISC、Apache-2.0、Unicode-3.0（`icu_*` など）は、著作権表示とライセンス文を配布物に同梱する義務がある。`licenses.json` の `attributionRequired` が true のもの（帰属表示不要は `0BSD`・`Unlicense`・`CC0-1.0`・`MIT-0` のみ）。リリース前（Phase 3）に、配布物へ入る依存だけを対象に THIRD-PARTY-NOTICES を生成する必要がある。生成ツールは未選定。

### そのほか

- `webpki-root-certs`（cargo、`CDLA-Permissive-2.0`、別ターゲット側）。データのライセンスで、条件は寛容だがこの分類器では判定できなかった（`unknown`）。macOS では使われない。
- `BlueOak-1.0.0`、`MIT-0`、`0BSD`、`Unlicense`、`CC0-1.0`、`Zlib` は寛容系。

## 同梱アセット

| 種別 | 場所 | 状況 |
| --- | --- | --- |
| アイコン・ロゴ | `src-tauri/icons/*`（`icon.png` を目視確認） | 「MDE」の独自ロゴ。リポジトリの `LICENSE`（MIT）以外に権利者の記載がなく、画像の生成元や第三者素材の有無は未確認。フォークでも製品アイコンとして再利用しない |
| 画像 | `public/vite.svg`、`public/tauri.svg` | Vite・Tauri のテンプレートのロゴ。`vite.svg` は `index.html:5` が favicon として参照、`tauri.svg` は参照されていない。削除する |
| フォント（MDE 自身） | なし | `@font-face` やフォントファイルはリポジトリにない。CSS は Inter・Cascadia Code などの名前を指定するだけ（`src/editor/milkdown-dark.css:14,51`）で、同梱していない。外部フォント CDN の URL も、ビルド後の CSS にない（`https://` を検索して 0 件） |
| フォント（依存由来） | `npm run build` の `dist/assets/*` | KaTeX フォント 59 ファイル（20 ファミリ）がビルド成果物に入る。由来は `@milkdown/crepe` と `mermaid` が依存する `katex@0.16.47`。`katex` パッケージは MIT だが、`node_modules/katex/dist/katex.js:6977` に「SIL Open Font License 1.1」と書かれた箇所があり、フォントファイル個別のライセンスは未確認 |
| 音声 | なし | `git ls-files` に音声ファイルなし |
| 動画 | なし | 同上 |

## 取り込む場合の扱い

- MDE のコードを新しいリポジトリへ移す場合は、そのファイルの来歴（MDE の commit と MIT）を残し、MDE の `LICENSE` 全文をリポジトリに含める。
- 依存を継承する場合の方が、上記の棚卸しをそのまま使える。新規に作る場合も、取り込む依存の数だけ同じ監査が要る。
- KaTeX フォントを使う機能（LaTeX 数式、Mermaid）は仕様の MVP にないため、取り込まなければ KaTeX の確認は不要になる。

## 再現コマンド

```sh
# 前提: docs/architecture-review.md の再現コマンドで MDE を取得し npm ci 済み
node scripts/audit-licenses.mjs        # phase0/results/licenses.json を生成
node scripts/render-tables.mjs --write # このドキュメントの表を更新
```

`audit-licenses.mjs` は `cargo metadata --locked`（全ターゲットと `--filter-platform aarch64-apple-darwin`）を実行する。他 OS 向けの crate のメタデータを crates.io から取得するため、ネットワークが必要（取得したのは依存の取得のみ。ソースのビルドはしていない）。

追加の確認に使ったコマンド:

```sh
cd phase0/vendor/MDE
cargo tree --manifest-path src-tauri/Cargo.toml --target aarch64-apple-darwin -e normal -i dtoa-short
cargo tree --manifest-path src-tauri/Cargo.toml --target aarch64-apple-darwin -e normal -i option-ext
git ls-files | grep -v -E '^src/|\.tsx?$'     # ソース以外の追跡ファイル
```

## 計測環境

| 項目 | 値 |
| --- | --- |
| MDE | `506c1fd938a7ad4dafa0f51910e5c42ac5854369`（`package-lock.json`・`Cargo.lock` の版） |
| ツール | Node v24.19.0、npm 11.17.0、cargo 1.97.1 |
| OS | macOS 26.7.2（arm64）。cargo の「解決」は `aarch64-apple-darwin` 向け |
| 実行日 | 2026-10-31 |

npm の件数は `package-lock.json` の全エントリで、`node_modules` の `package.json` の `license` で補った。lock に記載がないとき（`khroma`）は LICENSE ファイル先頭の文言から判断した。

## 未検証

- 法的な解釈（MPL-2.0 の配布条件、CDLA-Permissive-2.0、CC-BY-4.0 の帰属方法）。
- Windows 11・Ubuntu 24.04 向けに解決される依存（`--filter-platform` は `aarch64-apple-darwin` のみ実行）。全ターゲットの一覧は `licenses.json` にあるが、各 OS のバイナリに実際に入る範囲は未確認。
- 最終バイナリ・インストーラーに入る依存の確定（debug ビルドしか作っておらず、release ビルドの依存リンクは未確認）。
- KaTeX フォントファイルの個別ライセンス。
- MDE のロゴ画像の権利（制作者・生成方法）。
- 開発スコープの npm パッケージ（`lightningcss`、`caniuse-lite`）が配布物に入るか。ブラウザ向け成果物 `dist` の中身は検査していない。
- 依存の脆弱性（`npm audit` の指摘 21 件）はこの監査の範囲外。
