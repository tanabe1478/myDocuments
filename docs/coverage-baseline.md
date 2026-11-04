# 単体テストのカバレッジの基準値（B0）

部品（プラグイン）化（docs/decision-005-plugin-architecture.md、ADR-005）に入る前の、単体テスト（vitest）のカバレッジ。リファクタリングで、守られていた部分が守られなくなっていないかを比べる基準にする。測るだけで、しきい値は設けていない。

e2e（tests/e2e/ の Playwright）のカバレッジは測っていない（Playwright で測る仕組みが要る）。そのため、App.tsx や src/ui/ の画面のように、e2e だけで守られている部分は、ここでは 0% に近く出る。数字が低いことは、守られていないことを意味しない。「部品化で触るファイルの守られ方」の節で、単体テストと e2e の守りを書き分ける。

## 測った条件

| 項目 | 値 |
| --- | --- |
| コミット | 1df73d1（作業ツリーに、カバレッジの道具の追加（package.json、package-lock.json、vite.config.ts、.gitignore）の未コミットの変更がある。src/ は HEAD と同じ） |
| コマンド | `npm run test:coverage`（中身は `vitest run --coverage`） |
| vitest / coverage-v8 | 5.0.5 / 5.0.5（provider は v8。V8 の組み込みの実行記録を使う） |
| Node | v24.19.0 |
| 結果 | テストファイル 33、テスト 617、すべて成功 |
| reporter | text（端末に表）と json-summary（coverage/coverage-summary.json。coverage/ は .gitignore 済み） |
| しきい値 | なし |
| 対象 | src/ の .ts と .tsx（vite.config.ts の test.coverage.include）。テストが読み込まないファイルも 0% として含む |

行（lines）は実行された行、分岐（branches）は if や三項演算子などの分かれ道のうち通った数、関数（functions）は呼ばれた関数の数。

### 除外したもの

vite.config.ts の test.coverage.exclude で、次を除いた。

| 除外 | 理由 |
| --- | --- |
| `src/**/*.test.ts`、`src/**/*.test.tsx` | テストそのもの（33 ファイル） |
| `src/**/*.d.ts`（src/env.d.ts） | 型の宣言だけで、実行される文がない |
| src/main.tsx | React を DOM に載せる起点。単体テストの対象にならず、e2e の起動で毎回通る |
| src/document/testKit.ts | controller のテスト用の部品（メモリ上のディスクを持つ bridge）で、製品のコードではない |

src/platform/memory/ と src/platform/index.ts は除外していない。メモリ bridge（memoryBridge.ts）は VITE_E2E=1 のビルドでだけ使われ、e2e が通る。単体テストは通さないので 0% になる（製品のビルドには入らない）。

### 本番のビルドに入らないこと

@vitest/coverage-v8 は devDependencies にだけある。vite build は src/main.tsx から import される範囲だけを束ねるので、テストの道具は出力に入らない。確認した結果は次のとおり。

- package.json の dependencies（製品の実行時の依存）に @vitest/coverage-v8 は無く、devDependencies にある。
- npm run build（tsc と vite build）の出力 dist/ に、coverage-v8、istanbul、v8-coverage、vitest の文字列が無いこと（grep -ri で 0 件）。dist/ の合計は 927,678 バイトで、docs/perf-baseline.md の B0 の計測（frontend dist）と同じ。
- npx tauri build は、同じ npm run build の出力（dist/）と Rust だけを使う。node_modules は同梱しない。

## 全体

| 指標 | 割合 |
| --- | --- |
| 行 | 53.89%（1558/2891） |
| 分岐 | 50.47%（1126/2231） |
| 関数 | 44.4%（377/849） |
| 文（statements） | 52.2%（1811/3469） |

内訳の傾向。

- 純粋関数と状態機械（src/canvas/ の数値、src/document/ と src/explorer/ の controller、state、drafts、src/editor/ の liveMarkup、indent、focusRange ほか）は、行 90〜100%。
- React のコンポーネント（App.tsx と src/ui/ のほぼすべて）、Tauri と メモリの bridge、src/canvas/ の画像の読み込み、src/preferences/ の DOM への反映は 0〜15%。単体テストが jsdom で React を描画しておらず、e2e が守っている。
- src/editor/codemirror/ は、機能ごとに差が大きい（markdownDecorations 89.9%、indentKeymap 26.5%、verticalMotion 2.6%）。

## ファイルごと

「割合（実行された数/全体の数）」。EditorAdapter.ts、historyKeymap.ts の一部のように、全体の数が 0 のものは 0/0（型だけで実行される文がない）。

| ファイル | 行 | 分岐 | 関数 |
| --- | --- | --- | --- |
| `src/App.tsx` | 0% (0/245) | 0% (0/103) | 0% (0/103) |
| `src/canvas/CanvasBackground.tsx` | 0% (0/6) | 0% (0/8) | 0% (0/1) |
| `src/canvas/canvas.ts` | 100% (35/35) | 89.28% (25/28) | 100% (4/4) |
| `src/canvas/charCount.ts` | 100% (15/15) | 93.33% (14/15) | 100% (1/1) |
| `src/canvas/contrast.ts` | 100% (19/19) | 100% (6/6) | 100% (9/9) |
| `src/canvas/gradients.ts` | 100% (7/7) | 50% (1/2) | 100% (6/6) |
| `src/canvas/imageStats.ts` | 0% (0/11) | 0% (0/2) | 0% (0/1) |
| `src/canvas/palette.ts` | 100% (3/3) | - (0/0) | 100% (1/1) |
| `src/canvas/useBackgroundImage.ts` | 0% (0/23) | 0% (0/10) | 0% (0/5) |
| `src/document/controller.ts` | 90.47% (266/294) | 84.3% (145/172) | 84.12% (53/63) |
| `src/document/drafts.ts` | 100% (42/42) | 80.76% (21/26) | 87.5% (14/16) |
| `src/document/external.ts` | 100% (20/20) | 100% (41/41) | 100% (6/6) |
| `src/document/fileKinds.ts` | 100% (8/8) | 87.5% (7/8) | 100% (3/3) |
| `src/document/format.ts` | 100% (2/2) | 100% (2/2) | 100% (1/1) |
| `src/document/recovery.ts` | 100% (12/12) | 100% (14/14) | 100% (4/4) |
| `src/document/state.ts` | 100% (19/19) | 94.11% (16/17) | 100% (12/12) |
| `src/editor/EditorAdapter.ts` | - (0/0) | - (0/0) | - (0/0) |
| `src/editor/focusRange.ts` | 100% (70/70) | 96% (48/50) | 100% (7/7) |
| `src/editor/indent.ts` | 100% (32/32) | 90% (27/30) | 100% (4/4) |
| `src/editor/layout.ts` | 100% (9/9) | 100% (4/4) | 100% (3/3) |
| `src/editor/lineKinds.ts` | 100% (7/7) | 50% (1/2) | 100% (4/4) |
| `src/editor/liveMarkup.ts` | 100% (121/121) | 91.42% (96/105) | 100% (25/25) |
| `src/editor/typewriter.ts` | 100% (3/3) | - (0/0) | 100% (2/2) |
| `src/editor/codemirror/CodeMirrorAdapter.ts` | 83.83% (83/99) | 62.06% (36/58) | 75.75% (25/33) |
| `src/editor/codemirror/focusMode.ts` | 100% (42/42) | 80% (20/25) | 100% (13/13) |
| `src/editor/codemirror/historyKeymap.ts` | 100% (1/1) | - (0/0) | - (0/0) |
| `src/editor/codemirror/indentKeymap.ts` | 26.47% (9/34) | 26.31% (5/19) | 44.44% (4/9) |
| `src/editor/codemirror/keepCursorVisible.ts` | 30.76% (12/39) | 11.11% (3/27) | 62.5% (5/8) |
| `src/editor/codemirror/linkOpen.ts` | 75% (24/32) | 61.11% (11/18) | 84.61% (11/13) |
| `src/editor/codemirror/listContinuation.ts` | 100% (23/23) | 94.11% (16/17) | 100% (8/8) |
| `src/editor/codemirror/markdownDecorations.ts` | 89.86% (204/227) | 78.19% (104/133) | 93.61% (44/47) |
| `src/editor/codemirror/readingPosition.ts` | 40% (2/5) | 0% (0/2) | 50% (1/2) |
| `src/editor/codemirror/taskToggle.ts` | 100% (25/25) | 88.57% (31/35) | 100% (4/4) |
| `src/editor/codemirror/theme.ts` | 100% (2/2) | - (0/0) | - (0/0) |
| `src/editor/codemirror/typewriterMode.ts` | 38.88% (14/36) | 9.09% (2/22) | 45.45% (5/11) |
| `src/editor/codemirror/verticalMotion.ts` | 2.63% (1/38) | 0% (0/31) | 7.14% (1/14) |
| `src/explorer/controller.ts` | 95.39% (269/282) | 83.09% (177/213) | 88.13% (52/59) |
| `src/explorer/names.ts` | 100% (30/30) | 97.91% (47/48) | 100% (11/11) |
| `src/explorer/tree.ts` | 100% (50/50) | 96.92% (63/65) | 100% (18/18) |
| `src/platform/DocumentBridge.ts` | 100% (4/4) | - (0/0) | 100% (1/1) |
| `src/platform/externalUrl.ts` | 100% (7/7) | 100% (10/10) | 100% (1/1) |
| `src/platform/index.ts` | 0% (0/5) | 0% (0/2) | 0% (0/1) |
| `src/platform/tauriBridge.ts` | 0% (0/62) | 0% (0/20) | 0% (0/42) |
| `src/platform/memory/bytes.ts` | 0% (0/32) | 0% (0/30) | 0% (0/10) |
| `src/platform/memory/memoryBridge.ts` | 0% (0/253) | 0% (0/229) | 0% (0/87) |
| `src/preferences/apply.ts` | 12.5% (2/16) | 30.76% (4/13) | 20% (1/5) |
| `src/preferences/fonts.ts` | 0% (0/2) | 0% (0/2) | 0% (0/2) |
| `src/preferences/preferences.ts` | 100% (26/26) | 100% (50/50) | 100% (6/6) |
| `src/preferences/useResolvedTheme.ts` | 0% (0/10) | 0% (0/6) | 0% (0/5) |
| `src/ui/AppearanceSettings.tsx` | 0% (0/73) | 0% (0/40) | 0% (0/42) |
| `src/ui/ConfirmDiscardDialog.tsx` | 0% (0/23) | 0% (0/14) | 0% (0/6) |
| `src/ui/ConfirmRecreateDialog.tsx` | 0% (0/22) | 0% (0/14) | 0% (0/5) |
| `src/ui/ConfirmTrashDialog.tsx` | 0% (0/24) | 0% (0/16) | 0% (0/5) |
| `src/ui/ConflictBar.tsx` | 0% (0/13) | 0% (0/10) | 0% (0/4) |
| `src/ui/DiffDialog.tsx` | 0% (0/22) | 0% (0/6) | 0% (0/7) |
| `src/ui/EditingSettings.tsx` | 0% (0/5) | - (0/0) | 0% (0/3) |
| `src/ui/FileTree.tsx` | 0% (0/82) | 0% (0/167) | 0% (0/16) |
| `src/ui/NameInput.tsx` | 0% (0/23) | 0% (0/22) | 0% (0/6) |
| `src/ui/RecoveryDialog.tsx` | 0% (0/24) | 0% (0/16) | 0% (0/6) |
| `src/ui/SettingsDialog.tsx` | 0% (0/37) | 0% (0/38) | 0% (0/9) |
| `src/ui/Sidebar.tsx` | 0% (0/51) | 0% (0/58) | 0% (0/24) |
| `src/ui/Toast.tsx` | 0% (0/28) | 0% (0/17) | 0% (0/8) |
| `src/ui/TreeContextMenu.tsx` | 0% (0/41) | 0% (0/12) | 0% (0/10) |
| `src/ui/shortcuts.ts` | 100% (26/26) | 97.26% (71/73) | 100% (4/4) |
| `src/ui/sidebarLayout.ts` | 100% (4/4) | 100% (6/6) | 100% (2/2) |
| `src/ui/toastLayout.ts` | 100% (8/8) | 100% (2/2) | 100% (1/1) |
| 全体 | 53.89% (1558/2891) | 50.47% (1126/2231) | 44.4% (377/849) |

## 部品化で触るファイルの守られ方

部品化で触る予定のファイルについて、単体テストが守っている部分と、e2e にだけ頼っている部分を分ける。e2e の spec は tests/e2e/ のファイル名で示す。e2e の欄は、spec の describe とテストの題名から読んだもので、行単位の対応ではない（e2e のカバレッジは未計測）。単体テストの数字は、上の表の行と分岐。

### src/App.tsx（行 0%、分岐 0%）

単体テストは無い。全体が e2e にだけ頼る。App.tsx が呼ぶ文書とエクスプローラーの controller は単体テストで守られている（src/document/controller.ts 行 90.5%、src/explorer/controller.ts 行 95.4%）が、それらを画面とショートカットにつなぐ部分は e2e だけ。

| 部分 | 主に守る e2e の spec |
| --- | --- |
| 開く・編集・保存、改行・文字コード、未保存の確認、Undo / Redo、検索 | document.spec.ts |
| 設定画面、サイドバーの開閉、紙の幅 | settings-sidebar.spec.ts、canvas.spec.ts |
| フォーカスモード、タイプライターモード、自動非表示、全画面、ショートカット | canvas.spec.ts |
| 外部変更、保存直前の検査、草稿、起動時の復旧、終了時の確認 | reliability.spec.ts、conflict-bar.spec.ts |
| エクスプローラー（開く、展開、キーボード、復元、作成・名前の変更・ゴミ箱、外部の変更） | explorer.spec.ts、explorer-edit.spec.ts |
| トースト | toast-layout.spec.ts |

### src/editor/EditorAdapter.ts（0/0）

型（interface）だけで、実行される文がない。守りは tsc（npm run typecheck）。CodeMirrorAdapter.test.ts は、この interface を通して実装を呼ぶ。

### src/editor/codemirror/CodeMirrorAdapter.ts（行 83.8%、分岐 62.1%）

単体テスト（CodeMirrorAdapter.test.ts。jsdom 上の本物の CodeMirror）が守っている部分: setText と getText、onChange と選択の通知とその解除、destroy、undo と redo、見出しなどの装飾、記号の表示の切替（カーソル行と選択にかかる行）、IME 中の setText の保留、フォーカスモード、タイプライターの class、リストの継続の設定、プレーンテキスト（.txt）の扱い、タスクのチェックボックスの切り替え。

未到達の行（src/editor/codemirror/CodeMirrorAdapter.ts の 52、80〜146、167、205、211）は、二重 mount の例外、focus()、設定の同値のときの早期 return、リンクを開く通知の購読、下端の余白（bottomInset）、保留の timer、リンクを開く拡張と視線の位置の拡張の組み込み。e2e にだけ頼る。

| 部分 | 主に守る e2e の spec |
| --- | --- |
| リンクを開く通知（Cmd/Ctrl+クリック） | live-markup.spec.ts（リンクを開く (h)） |
| 視線の位置（scrollMargins） | writing-feel.spec.ts（視線の位置 (1)） |
| 実際のキー入力と IME の変換 | ime.spec.ts、live-markup.spec.ts（IME の変換と記法の表示 (d)） |

### src/preferences/preferences.ts（行 100%、分岐 100%）

単体テスト（preferences.test.ts）が全体を守る。既定値、範囲の境界、型の違い、旧い保存値の読み込み、フォントの文字列の検査、背景の各項目、listContinuation、冪等性（normalizePreferences を 2 回通しても同じ）。e2e にだけ頼る部分は無いが、保存して再読み込みしても維持されること（bridge を通した保存）は単体では見ない。canvas.spec.ts（設定画面の外観 (1)、連続した変更の debounce）と document.spec.ts（Preferences の反映）が守る。

### src/preferences/apply.ts（行 12.5%、分岐 30.8%）

単体テストが守るのは resolveTheme（theme の system を light と dark に解決する関数）だけ。applyPreferences（CSS 変数と data-theme への反映、system 追従の解除）は、vitest の環境が node で、DOM が無いため通らない。e2e が守る: canvas.spec.ts（設定画面の外観 (1)、段落間隔・フォント）、document.spec.ts（Preferences の反映）。theme が system のときの OS の設定への追従（matchMedia の change）は、tests/e2e の grep（'system'、prefers-color-scheme、colorScheme）で見当たらず、単体テストも通っていない。守られていない可能性が高い（e2e の中身を全部は読んでいないので、未確認）。

### src/ui/shortcuts.ts（行 100%、分岐 97.3%）

単体テスト（shortcuts.test.ts、shortcutTarget.test.ts）が、キーの組み合わせと動作の対応（matchShortcut）と、入力欄でのショートカットの扱いを守る。未到達の分岐は 2 つ（26 行と 55 行）。実際の keydown を窓に送って App が反応すること（全画面、設定画面の開閉、保存）は e2e: canvas.spec.ts（全画面 (9) とショートカット、入力欄でのショートカット (d)）、document.spec.ts。

### src/ui/SettingsDialog.tsx、AppearanceSettings.tsx、EditingSettings.tsx（行 すべて 0%）

単体テストは無い。e2e にだけ頼る。

| ファイル | 主に守る e2e の spec |
| --- | --- |
| SettingsDialog.tsx（モーダルの開閉、フォーカスの戻り、Esc、名前） | settings-sidebar.spec.ts（設定画面（モーダル）(a)）、canvas.spec.ts（すべての操作部品に名前があり…） |
| AppearanceSettings.tsx（外観、背景、コントラスト、紙の幅、記号の表示の設定） | canvas.spec.ts（設定画面の外観 (R3-5)、背景 (5)、コントラスト (6)）、settings-sidebar.spec.ts（紙の幅 (d)）、live-markup.spec.ts（設定「記号の表示」 (g)） |
| EditingSettings.tsx（リストの継続の設定） | list-continuation.spec.ts |

### src/editor/codemirror/ の各機能のファイル

単体の数字は行 / 分岐。

| ファイル | 単体テスト | 単体テストで守られている部分 | e2e にだけ頼る部分と、主に守る spec |
| --- | --- | --- | --- |
| markdownDecorations.ts | 89.9% / 78.2% | 見出しの大きさ、強調、記号を隠す装飾の決定（CodeMirrorAdapter.test.ts。範囲の抽出は liveMarkup.test.ts） | 幅の測定のキャッシュ（89〜105 行）、コードフェンスの class 付け（225〜235 行）、IME 中の隠す範囲の位置の追従（298〜310 行）、フォント・字間の変更での幅の測り直し（339 行）、IME 後の timer（399 行）。writing-feel.spec.ts（ぶら下げインデント (3)）、live-markup.spec.ts（ぶら下げインデント (f)、IME の変換と記法の表示 (d)）、document.spec.ts（Markdown の見た目） |
| focusMode.ts | 100% / 80% | 周囲の段落を薄くする、IME 中は再計算しない、編集に位置で追従（CodeMirrorAdapter.test.ts、focusRange.test.ts） | IME 中の保留の timer の後始末（69、72、77 行）。canvas.spec.ts（フォーカスモード (2)、段落判定 (a)(b)、日本語 IME とフォーカスモード (8)） |
| typewriterMode.ts | 38.9% / 9.1% | class の付け外し、setText をまたぐ維持（CodeMirrorAdapter.test.ts）。中央に保つ計算の純粋関数は typewriter.ts が単体で 100% | 実際のスクロールの追従と余白の測り直し（27〜87 行のほとんど）。canvas.spec.ts（タイプライターモード (3)）、live-markup.spec.ts（タイプライターモード・フォーカスモード (j)） |
| keepCursorVisible.ts | 30.8% / 11.1% | 組み込みだけ | 表示領域が縮んだとき（競合バーの出現など）にカーソル行を見える位置に保つ処理の本体（50〜82 行）。conflict-bar.spec.ts（競合バーの出現・消失とカーソル行） |
| indentKeymap.ts | 26.5% / 26.3% | 計画を立てる純粋関数 indent.ts は単体で 100%（indent.test.ts） | Tab と Shift+Tab のキーマップ本体（8〜38、52〜56 行）。writing-feel.spec.ts（Tab でのインデント (4)） |
| verticalMotion.ts | 2.6% / 0% | ほぼ無し | 上下キーの移動の補正の全体（13〜83 行）。cursor-motion.spec.ts、vertical-selection.spec.ts、writing-feel.spec.ts（段落間隔 (2)） |
| readingPosition.ts | 40% / 0% | 組み込みだけ | scrollMargins の計算（16〜18 行）。writing-feel.spec.ts（視線の位置 (1)） |
| linkOpen.ts | 75% / 61.1% | リンクの範囲の判定（liveMarkup.test.ts の linkAt）、URL の検査（platform/externalUrl.test.ts） | 修飾キーを押したクリックで開く動作、押している間の class（30、31、41、68〜74 行）。live-markup.spec.ts（リンクを開く (h)） |
| taskToggle.ts | 100% / 88.6% | クリックでの切り替え、複数カーソル、Undo の 1 手、修飾キーと中ボタンの除外（CodeMirrorAdapter.test.ts、taskToggle.test.ts） | 実際のマウスのクリックの座標（Linux の中ボタンの扱い）。live-markup.spec.ts（チェックボックスのクリックでの切り替え (k)） |
| listContinuation.ts | 100% / 94.1% | Enter でのリストの継続、loose と tight、Undo の 1 手（listContinuation.test.ts、CodeMirrorAdapter.test.ts） | 実際の Enter のキー入力と、設定画面での切り替え。list-continuation.spec.ts |
| historyKeymap.ts | 100% / - | Undo と Redo のキー割り当て（historyKeymap.test.ts） | 実際のキー入力。document.spec.ts（Undo / Redo (d)） |
| theme.ts | 100% / - | 組み込みの実行（CSS の見た目そのものは単体では見ない） | 見た目（色、余白、記号を隠した行の幅）は e2e の画面で確認する。canvas.spec.ts、live-markup.spec.ts、document.spec.ts（Markdown の見た目） |

## その後のファイルの移動

上の表と各節は B0 の時点の記録で、数字とパスは書き換えていない。部品化（ADR-005）でファイルが移ったので、古い場所と新しい場所を並べる。同じコマンドで測り直すときは、この対応で読み替える。中身は、移したとき以外は変えていない（R4 では `markdownDecorations.ts` から素のテキストの空行の部分と Markdown の言語の設定を本体へ分け、`lineKinds.ts` から `isBlankLine` を公開 API へ移した）。

| Run | 古い場所 | 新しい場所 |
|---|---|---|
| R1（タイプライターモード） | `src/editor/typewriter.ts`、`typewriter.test.ts` | `src/features/typewriter/typewriter.ts`、`typewriter.test.ts` |
| R1 | `src/editor/codemirror/typewriterMode.ts` | `src/features/typewriter/typewriterMode.ts` |
| R2（フォーカスモード） | `src/editor/codemirror/focusMode.ts` | `src/features/focus/focusMode.ts` |
| R2 | `src/editor/focusRange.ts`、`focusRange.test.ts` | `src/features/focus/focusRange.ts`、`focusRange.test.ts` |
| R3（リストの継続） | `src/editor/codemirror/listContinuation.ts`、`listContinuation.test.ts` | `src/features/list-continuation/listContinuation.ts`、`listContinuation.test.ts` |
| R4（Markdown の見た目） | `src/editor/liveMarkup.ts`、`liveMarkup.test.ts` | `src/features/markdown/liveMarkup.ts`、`liveMarkup.test.ts` |
| R4 | `src/editor/lineKinds.ts`、`lineKinds.test.ts` | `src/features/markdown/lineKinds.ts`、`lineKinds.test.ts`（`isBlankLine` は `src/plugin-api/lines.ts` と `lines.test.ts`） |
| R4 | `src/editor/codemirror/markdownDecorations.ts` | `src/features/markdown/markdownDecorations.ts`（素のテキストの空行と Markdown の言語は `src/editor/codemirror/textKind.ts`） |
| R4 | `src/editor/codemirror/taskToggle.ts`、`taskToggle.test.ts` | `src/features/markdown/taskToggle.ts`、`taskToggle.test.ts` |
| R4 | `src/editor/codemirror/linkOpen.ts` | `src/features/markdown/linkOpen.ts` |
| R4 | `src/editor/codemirror/theme.ts` の Markdown の見た目（見出し、フェンス、引用、記号のウィジェット、リンクの準備） | `src/features/markdown/theme.ts`（空行の高さ `cm-md-blank` は `theme.ts` に残る） |
| R4 | `src/preferences/preferences.ts` の `markupDisplay` と、`src/ui/AppearanceSettings.tsx` の「記号の表示」 | `src/features/markdown/markupDisplay.ts` と `index.ts`（設定画面の項目は部品が登録する） |

## 限界

- e2e のカバレッジは測っていない。App.tsx、src/ui/ の画面、src/platform/（tauriBridge.ts と memoryBridge.ts）、src/canvas/ の画像まわり、src/editor/codemirror/ のキー入力まわりは、単体テストでは 0〜40% だが、e2e が守っている部分が多い。e2e の守りは、上の表のとおり spec の題名から読んだ対応で、実際に通る行は確認していない。
- カバレッジ（行や分岐が実行されたこと）は、挙動が検証されていることの証明ではない。実行されても、何も確かめていないテストがありうる。
- 単体テストは vitest の node 環境（一部のファイルで jsdom）で動く。実ブラウザのレイアウト（幅の測定、スクロール、IME、見た目）を通らない。
- Rust 側（crates/docio、src-tauri）は cargo test の対象で、ここには含まれない。
- 部品化の前後で比べるときは、同じコマンドで測り、ファイルが移動した場合は表のパスを読み替える。

## 再現コマンド

```
npm ci --registry https://registry.npmjs.org
npm run test:coverage        # 端末に表、coverage/coverage-summary.json に集計
```
