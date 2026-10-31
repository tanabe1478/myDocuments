# ベンチマーク基準値（Phase 0 / P0-3）

仕様 §9 の項目のうち、macOS（Apple Silicon）のブラウザ上で測れたものと、Tauri 実機（debug ビルド）で測れたものを記録する。生データは `phase0/results/benchmark.json`。表はこのファイルから `scripts/render-tables.mjs` が生成する。

## 結論

- 同じ MDE の設定で CodeMirror 6 と Milkdown を比べると、通常の文書（A〜C）の入力遅延は両方とも小さい。A〜C の全組み合わせで p95（遅い方から 5% 目の値）は 18.2ms 以下。仕様 §9.2 の仮目標（p95 50ms 未満）を満たしている。
- 読み込みと切替は差が大きい。100KB（B）の読み込みは CodeMirror 6 が 13.6〜21ms（中央値）、Milkdown が 146〜150ms。ストレス文書（D）は CodeMirror 6 が 77〜93ms、Milkdown は 2.6〜3.1 秒。
- D の入力遅延は Milkdown が悪化する（webkit で p95 76ms、仮目標 50ms を超える）。CodeMirror 6 は p95 24ms。
- Tauri debug ビルドは、窓が表示されるまで中央値 368ms（空文書、5 回）。メモリは空文書で約 233 MiB、1MB 文書で約 309 MiB（WebKit 子プロセス込みの推定）。
- 日本語 IME の確定遅延、長文スクロールのフレーム時間、Tauri 実機での入力遅延、Windows と Ubuntu は未計測。

この数値は「現状の実測値」であり、仕様 §9.2 が言うとおり目標値の確定にはまだ使えない。測定条件の限界は下記「測定の限界」を参照。

## 測定方法

測定対象は MDE の実コード。ハーネスは `phase0/harness/`（Vite ページ）で、`EditorManager`（CodeMirror 6、minimap や補完を含む MDE の設定そのまま）と `MilkdownManager`（Crepe）を直接生成する。駆動は `phase0/bench/run.mjs`（Playwright）。React の `App.tsx` は通していない。

| 項目 | 定義 |
| --- | --- |
| 読み込み | エディタ生成の呼び出し開始から、次の描画フレームの後続タスクまで（`requestAnimationFrame` の後に `setTimeout(0)`）。毎回、新しいエディタを作って破棄する。Milkdown は先に小さな文書で一度生成し、遅延ロードされる chunk の取得を除く。除かない値は「初回生成」として別掲 |
| 入力→描画遅延 | Playwright で文字 `a` を 100 回押し、`keydown`（キャプチャ段階）から次フレームの後続タスクまでの時間。キャレットは文書の中央付近。押下ごとに描画観測を待つ。60Hz のフレームに量子化される（下限は 0〜16.7ms の幅を持つ） |
| モード切替 | `EditorArea.tsx:82-109` の呼び出し順を再現（React コンポーネント経由ではない）。raw→visual 初回（Crepe 生成を含む）、visual→raw、raw→visual 2 回目（既存エディタに `setContent`） |
| 対照 | 素の `contenteditable`（20,000 字）に同じ入力をして、測定系自体の下限を見る |
| 検証 | 読み込みでは、描画された行数（CodeMirror）と ブロック数（Milkdown）と文字数を確認した。例: Milkdown は C で 2,786 ブロックを生成。入力では文書の文字数が 100 増えたことを確認した（ただし Milkdown の D は後述） |

### データセット（`scripts/gen-fixtures.mjs`、決定論的）

<!-- table:bench-datasets:begin -->
| ID | ファイル | バイト | 文字数 | 段落数 | sha256（先頭16桁） |
| --- | --- | --- | --- | --- | --- |
| A | `A-10kb-ja.md` | 10522 | 3564 | 32 | e95c97d9271ff25b |
| B | `B-100kb-mixed.md` | 102610 | 46998 | 293 | aada3eb08edad189 |
| C | `C-1mb-longform.md` | 1048862 | 422152 | 2785 | ad18e8261bf92164 |
| D | `D-stress.md` | 579230 | 352496 | 52 | 785dcfced5686957 |
<!-- table:bench-datasets:end -->

乱数は固定シードの mulberry32（Date や Math.random を使わない）。`node scripts/gen-fixtures.mjs --check` で、別プロセスで再生成した内容の SHA-256 が `phase0/fixtures/perf/manifest.json` と一致することを確認できる（実行して一致を確認済み）。C（1MB 超）は `.gitignore` 対象で、`node scripts/gen-fixtures.mjs` で再生成する。

- A: 日本語の通常文章
- B: 見出し・箇条書き・リンク・コードブロック・引用の混在
- C: 日本語と英語の長文、2,785 段落
- D: frontmatter、8 列 300 行の表 6 個、コードブロック 40 個、リンク参照定義 300 個、約 200KB（204,813 バイト）の単一段落、約 37KB の 1 行の英単語列

## 結果（ブラウザ）

数値は ms。形式は「中央値 (p95)」。読み込みとモード切替は反復が少ない（A・B は 5 回、C・D は 3 回）ため、p95 は事実上の最大値。webkit のタイマーは 1ms 精度で、小数が出ない。

### 測定環境

<!-- table:bench-env:begin -->
| 項目 | 値 |
| --- | --- |
| OS | Darwin 25.6.0 (macOS 26.7.2) |
| CPU | Apple M5（10 コア） |
| メモリ | 32 GiB |
| Node / playwright-core | v24.19.0 / 1.64.1 |
| ブラウザ chromium | 156.0.8078.4（headless） |
| ブラウザ webkit | 27.2（headless） |
| データ | A=10522B, B=102610B, C=1048862B, D=579230B |
<!-- table:bench-env:end -->

### 読み込み（エディタ生成→最初の描画後）

<!-- table:bench-load:begin -->
| データ | chromium CM6 | chromium Milkdown | webkit CM6 | webkit Milkdown |
| --- | --- | --- | --- | --- |
| A | 15.2 (p95 24.9) | 14.9 (p95 15.4) | 11 (p95 26) | 10 (p95 14) |
| B | 13.6 (p95 25) | 146.1 (p95 177.3) | 21 (p95 44) | 150 (p95 216) |
| C | 45.2 (p95 49.7) | 238.5 (p95 259.7) | 44 (p95 69) | 161 (p95 204) |
| D | 77.1 (p95 81.5) | 2641.6 (p95 2662.1) | 93 (p95 107) | 3097 (p95 3192) |
<!-- table:bench-load:end -->

Milkdown を新しいページで最初に作る場合（遅延 chunk の取得を含む、A）:

<!-- table:bench-cold:begin -->
| ブラウザ | Milkdown 初回生成（遅延 chunk 取得込み, A, ms） |
| --- | --- |
| chromium | 50.8 (p95 50.8) |
| webkit | 91 (p95 91) |
<!-- table:bench-cold:end -->

- CodeMirror 6 は表示範囲だけを描画するため、読み込み時間は文書サイズにほぼ比例しない（C は 1MB でも 44〜45ms）。描画された行は 41〜53 行だった。
- Milkdown は全ブロックを ProseMirror のノードにする。C（単純な段落が多い）は 161〜239ms、D（巨大な表と巨大な単一段落）は 2.6〜3.1 秒。

### 入力→描画遅延

<!-- table:bench-keys:begin -->
| データ | chromium CM6 | chromium Milkdown | webkit CM6 | webkit Milkdown |
| --- | --- | --- | --- | --- |
| (対照) contenteditable 20k 字 | 3.1 (p95 11.7) | - | 2 (p95 6) | - |
| A | 6.8 (p95 8.1) | 6.4 (p95 7.6) | 7 (p95 18) | 6 (p95 8) |
| B | 6.9 (p95 8.7) | 9.5 (p95 18.2) | 7 (p95 10) | 8 (p95 11) |
| C | 6.9 (p95 9.6) | 8.4 (p95 18.1) | 7 (p95 11) | 7 (p95 9) |
| D | 22.2 (p95 24) | 26.7 (p95 35.8) | 20 (p95 24) | 46 (p95 76) |
<!-- table:bench-keys:end -->

- A〜C は、CodeMirror 6・Milkdown とも p95 が 18.2ms 以下。
- D は CodeMirror 6 が p95 24ms（chromium・webkit とも）、Milkdown が chromium で 35.8ms、webkit で 76ms。
- Milkdown の D では、`a` を 100 回入力した後の Markdown 出力が元より 29,898 文字増えていた（他は 100 文字）。最初の編集で文書全体が正規化され、表の桁揃えの空白などが増えたため（[architecture-review.md](architecture-review.md) §5）。D の Milkdown の入力遅延には、この正規化の影響が混ざっている可能性があるが、切り分けていない。

### モード切替

<!-- table:bench-mode:begin -->
| データ | chromium raw→visual 初回 | chromium visual→raw | chromium raw→visual 2回目 | webkit raw→visual 初回 | webkit visual→raw | webkit raw→visual 2回目 |
| --- | --- | --- | --- | --- | --- | --- |
| A | 13.8 (p95 14.1) | 17.9 (p95 18.5) | 15.5 (p95 15.8) | 13 (p95 23) | 17 (p95 18) | 16 (p95 16) |
| B | 141.9 (p95 180.2) | 7.7 (p95 11.4) | 88.9 (p95 96.3) | 151 (p95 206) | 12 (p95 16) | 62 (p95 70) |
| C | 246.2 (p95 261.7) | 5.8 (p95 6.2) | 241.6 (p95 247.5) | 158 (p95 201) | 8 (p95 10) | 162 (p95 167) |
| D | 2876.3 (p95 3037.3) | 46.5 (p95 50.9) | 2308.5 (p95 2531.1) | 3167 (p95 3180) | 42 (p95 43) | 2902 (p95 3059) |
<!-- table:bench-mode:end -->

- B（100KB）の raw→visual は初回が 142〜151ms、2 回目が 62〜89ms。D は 2.3〜3.2 秒。
- visual→raw は全データで中央値 46.5ms 以下（Milkdown の出力を使わず、無編集なら元の文字列を返すため。ガードの仕組みは architecture-review.md §4）。

## 結果（Tauri 実機、debug ビルド、macOS）

`phase0/bench/tauri-smoke.mjs` が `src-tauri/target/debug/mde` を起動する（`phase0/bench/launch-measure.swift` を `swiftc` でビルドして使う）。各シナリオ 5 回。文書は起動引数で渡す（`lib.rs:5-17`）。窓は非表示で起動し、フロントエンドが描画後に `frontend-ready` を送ると表示される設計（`lib.rs:59-69`）。「窓表示まで」は起動から、そのプロセスの高さ 100px 超の窓が画面に出るまで（`CGWindowList` で 2ms 間隔のポーリング）。

<!-- table:bench-tauri:begin -->
| 起動時の文書 | 窓表示まで ms 中央値（最小〜最大, n） | 1回目 ms | 合計 RSS MiB 推定 中央値 | 本体 RSS MiB 中央値 |
| --- | --- | --- | --- | --- |
| empty | 368.3（363.6〜2037.2, n=5） | 2037.2 | 232.6 | 102.6 |
| A-10kb | 361.6（350.9〜383, n=5） | 360.6 | 252.6 | 105.6 |
| B-100kb | 361.1（342.7〜376.9, n=5） | 342.7 | 286.6 | 105.9 |
| C-1mb | 370.5（339.4〜386.3, n=5） | 371.7 | 309.2 | 105.3 |
<!-- table:bench-tauri:end -->

- 空文書の 1 回目は 2,037ms で、2 回目以降は 364〜370ms。1 回目が cold（OS・WebKit のキャッシュが冷えた状態）に近いと推測できるが、cold の状態は制御していない。
- 合計 RSS（resident set size、プロセスが物理メモリに載せているサイズ）はアプリ本体と、起動後に新規に現れた `com.apple.WebKit.*` プロセスの合計の推定。他アプリが同時に WebKit プロセスを起動していれば混入する。測定は起動の 3〜4 秒後の 1 点で、入力後や長時間後は測っていない。
- A〜C の 1 回目は 343〜372ms で、空文書のような 2 秒級の遅延は出ていない。空文書の 1 回目だけが遅い理由（キャッシュの冷え方など）は調べていない。
- debug ビルドは最適化されていないため、release の値ではない。

## 仮目標との対応（仕様 §9.2）

- 入力→描画遅延 p95 50ms 未満: ブラウザ計測の A〜C は両エンジンで満たす。D は CodeMirror 6 が満たし、Milkdown は webkit で満たさない。Tauri 実機・IME 確定後は未計測のため、目標を満たすとは言えない。
- 100KB 文書の読み込みがおおむね 1 秒以内: ブラウザ計測の B は CodeMirror 6 が 21ms 以下、Milkdown が 150ms 以下。Tauri 実機での文書オープン操作（ファイル読み込み・IPC を含む）は未計測。

## 測定の限界

- 実行中に他のアプリが動いていた。バックグラウンド負荷、電源・省電力設定は制御も記録もしていない。
- ブラウザは headless。実際の窓の GPU 合成、ディスプレイのリフレッシュレート（120Hz など）は反映されない。
- 入力遅延は「キー押下から次フレームの後」までで、画面に表示された時刻ではない。IME の変換・確定は含まない。
- 同条件の比較は、同じ Playwright・同じマシン・同じ harness ビルドで行った値のみ。chromium と webkit の差は、エンジンの差とビルドの差の両方を含む。
- webkit は Playwright 同梱ビルドで、macOS の WKWebView（Tauri が使う）とは同一ではない。
- 計測中、Milkdown を破棄した直後に `Context "editorView" not found` という pageerror がログに出た（chromium 8 件、webkit 2 件）。全計測の status は ok で、測定値の欠損はない。原因は未確認。`MilkdownManager.detach()` が `crepe.destroy()` を await せずに呼ぶ（`MilkdownManager.ts:70-71`）ことと関係すると推測しているが、確かめていない。

## 再現コマンド

```sh
# 前提: docs/architecture-review.md の再現コマンドで MDE を取得し npm ci 済み
(cd phase0 && npm install --registry https://registry.npmjs.org)
node scripts/gen-fixtures.mjs                 # A/B/C/D を生成（manifest.json と同一になる）
node scripts/gen-fixtures.mjs --check         # 別プロセスで再生成して SHA-256 を照合
(cd phase0/vendor/MDE && npx vite build --config ../../harness/vite.config.mjs)
node phase0/bench/run.mjs chromium,webkit     # ブラウザ計測。約 7 分（各ブラウザ約 3 分 20 秒）。phase0/results/benchmark.json。
                                              # 分割する場合: run.mjs chromium; run.mjs webkit --merge（2 本目は 1 本目の結果を残して追記）
(cd phase0/vendor/MDE && npx tauri build --debug --config '{"bundle":{"createUpdaterArtifacts":false}}')
RUNS=5 node phase0/bench/tauri-smoke.mjs      # Tauri 実機。約 2 分。窓が 20 回、画面に出る。benchmark.json に追記（run.mjs を --merge なしで走らせると消えるので、必ず run.mjs の後に実行）
node scripts/render-tables.mjs --write        # このドキュメントの表を更新
```

`--quick` を付けると反復を 1 回、入力を 20 回に減らして動作確認だけできる（基準値には使わない）。`tauri-smoke.mjs` はアプリ起動で `~/Library/Caches/mde` と `~/Library/WebKit/mde` を作る。計測後に削除した。

## 計測環境

上記「測定環境」の表のとおり。Tauri 実機は同じマシン、MDE `506c1fd938a7ad4dafa0f51910e5c42ac5854369` の debug ビルド（rustc/cargo 1.97.1）。実行日は 2026-10-31。

## 未検証

<!-- table:bench-unmeasured:begin -->
- Tauri 実機での入力→描画遅延（WKWebView に合成入力を送る手段がなく未計測。ブラウザ計測のみ）
- Tauri 実機でのモード切替・文書読み込み時間（同上）
- release ビルドでの起動時間・メモリ・パッケージサイズ
- Windows 11 / Ubuntu 24.04 の全項目（実機なし）
- 日本語 IME 確定後の反映遅延（自動化不可。手動手順は docs/architecture-review.md）
- 長文スクロール中のフレーム時間
<!-- table:bench-unmeasured:end -->

- 仮目標の根拠となる、Tauri 実機での「ファイルを開く」操作の時間。
- 全プロセス合計メモリの、入力・長時間使用後の値。
- パッケージサイズ（debug の `.app` は 51 MB、`.dmg` は 16 MB だが release は未計測。architecture-review.md §1）。
- 起動時間の cold と warm の分離（OS キャッシュの purge には管理者権限が必要で、行っていない）。
