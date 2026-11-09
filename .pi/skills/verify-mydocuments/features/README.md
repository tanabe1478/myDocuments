# features: Immersive Markdown Editor の user-facing feature

この index は、verify-mydocuments の feature map。各 feature ファイルは、ユーザーが到達できる entry point、Playwright での駆動方法（シナリオと観測値）、検証を無効にする罠を書く。

## Features

- [document-lifecycle.md](document-lifecycle.md): 文書の新規作成・開く・保存。BOM と改行の維持、内容が変わらないときは書かない、未保存マーク、混在改行の通知、未保存の確認。
- [appearance-canvas.md](appearance-canvas.md): 設定画面（モーダル）、外観と執筆キャンバス、紙の幅（窓いっぱい・本文に合わせる）、左サイドバーの開閉。文字組み、フォント、テーマ、背景（単色・グラデーション・画像）、背景を表示しない、コントラスト表示。
- [writing-modes.md](writing-modes.md): 執筆モード。フォーカスモード、タイプライターモード、入力中のバーの自動非表示と F6、全画面ショートカット。
- [save-reliability.md](save-reliability.md): 保存の信頼性。外部変更の自動読み直し、競合バー、保存直前の検査、草稿、起動時の復旧、前回の文書の再オープン、終了時の確認。
- [explorer.md](explorer.md): 左サイドバーのエクスプローラー。フォルダを開く、ツリー（遅延読み込み、並び、隠し、5000 件、リンク）、クリックとキーボードで文書を開く、開けないファイルの灰色、前回のフォルダの復元と再試行、.txt の素の表示、作成・名前の変更・ゴミ箱への移動（ボタン・右クリック・キーボード）、外部の変更の自動反映、同梱の部品「パスをコピー」（右クリック、Mod+Alt+C、権限の確認と設定画面の取り消し）。
- [outline.md](outline.md): 部品のパネルと、同梱の部品「アウトライン」（ADR-005 の R7、R13）。右ペイン（R13。起動時は閉じていて、上部バーのボタンか Option+Cmd+B / Ctrl+Alt+B で開く。狭い窓では本文に重なる）のパネルの節、Markdown の ATX 見出しの一覧（コードブロックと front matter の中は数えない。素のテキストは「見出しはありません」）、項目を押す・Enter でその行へ移って本文にフォーカスが戻る、カーソルのある節の強調、本文を部品に送る時機（document.read を宣言した部品にだけ。入力が止まった後、IME の変換中は送らない、右ペインが閉じているか節がたたまれているときは送らない。左サイドバーの開閉は関係しない）、部品の文字列は HTML として解釈されない、上限を超えた部品だけが止まる。
- [typing-sound.md](typing-sound.md): 同梱の部品「タイピング音」（ADR-005 の R9、R10）。キーを押すたびに CC0 の打鍵音を鳴らす（既定オフ）。設定画面の「執筆の補助」のチェックと、新しい「音」の節の音色（キーボード・タイプライター）と音量（小・中・大）、音色の切り替えで選んだ音色の素材だけを読むこと、鳴らすキーと鳴らさないキー、Enter は低い音、オフの間は素材の fetch も AudioContext もない、鳴り始めの位置（素材の頭の無音を飛ばす）と keydown から start までの時間、音の要求の数え方（e2e のビルドだけ）。
- [writing-feel.md](writing-feel.md): 書き心地。カーソルの位置、段落間隔、ぶら下げインデント（記号を隠した行も）、Tab / Shift+Tab、上下キーの 1 行ずつの移動、範囲選択の畳み、Enter でのリストの継続（loose list でも、tight list の空の 2 項目目でも空行を入れない。設定画面の「編集」の節で切り替え）、記号の表示（カーソルのない行で記法を隠す。設定画面の「外観」の節で切り替え）、⌘/Ctrl+クリックでリンクを開く、隠した行のチェックボックスのクリックでの切り替え、表の表示（カーソルが表の外のとき表の形。クリック、上下キー、検索で原文に戻る）と、原文の表の中の Tab / Shift+Tab でのセルの移動、表の入力の支援（表の行での Enter で行を足す、最後の空の行の Enter で表から出る、見出しの行の末尾での Enter で表にする、最後のセルでの Tab で行を足す）。

## Baseline preconditions

- リポジトリのルートで、`npm ci` 済み（node_modules に vite と playwright がある）。node は package.json と CI に合わせた 24 系。
- playwright の chromium がある（Doctor が確認する）。
- Launch 済みで、Doctor が全項目 PASS。drive の対象は、その run の VITE_E2E ビルド（メモリ bridge）。
- 起動直後の状態は、文書が無題で未保存マークなし、シナリオの seed で与えたもの以外のファイル・草稿・設定がない。seed の files のパスは仮想で、実ファイルは使わない。
- 時間に依存する項目（草稿の自動保存は入力が約 2 秒止まった後、設定の保存は debounce の後）は、expect の timeout で待つ。固定の待ちを足さない。

## Driving convention

- シナリオは features/scenarios/<name>.json。`node .pi/skills/verify-mydocuments/scripts/drive.mjs --run-id <run-id> --scenario <path>` で実行する。形式は SKILL.md の Drive 節。
- 1 シナリオは 1 つの新しいページで始まる（seed を毎回注入し直す）。シナリオ間で状態を引き継がない。
- 操作は、ユーザーが触る入口（キーボードショートカット、設定ボタン、サイドバーの開閉ボタン、ダイアログのボタン）で行う。bridge の直接操作（externalWrite、requestClose、focusWindow、setPaths）は、OS やファイルシステムの側で起きることの代わりにだけ使う。
- 結果は、画面（doc-title、unsaved-mark、toast など）と副作用（バイト列、physicalWrites、log、草稿、保存された設定）の両方を expect する。
- ショートカットは ControlOrMeta で書く。macOS の全画面（Ctrl+Cmd+F）のように OS 固有のものは、シナリオに platform を書く。

## Proof / skip reporting

- 報告には、実行したシナリオごとに PASS/FAIL、証跡のパス（artifacts/verify-mydocuments/<run-id>/evidence/<name>/）、確認した値を書く。
- 実行しなかった entry point は、skip として理由と一緒に書く（例: 実 IME、ネイティブのダイアログ、Windows 実機）。一部の entry point だけの検証で、feature を検証済みとは言わない。
- seed が前提を満たさずシナリオが失敗したら、シナリオを弱めて通さない。失敗として報告し、理由を該当 feature の Gotchas に足す。
- メモリ bridge の結果は、production の境界（DocumentBridge）の内側を差し替えたものだと明記する。Rust 側の規則は crates/docio と src-tauri の cargo test が正本。

## Feature entry contract

feature ファイルは、H1 の後に次の 4 つの H2 だけを、この順で持つ（check-skill.mjs が検査する）。

1. Sub-features: 短い ID と 1 行の振る舞い。
2. How to get to it (user POV): ユーザーが到達できる全 entry point（ボタン、ショートカット、起動時の自動処理）。
3. Driving it with Playwright（メモリ bridge）: `Preconditions:` で始め、ユーザーの action、exact command、観測できる結果を対応させる。
4. Gotchas: 検証を無効にする罠、共有 state、待ち時間、前提の欠落。

実装の詳細は書かず、user path、安定したハンドル、必要な state、command、observable proof だけを書く。
