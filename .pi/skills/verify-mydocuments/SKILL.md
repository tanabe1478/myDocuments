---
name: verify-mydocuments
description: Immersive Markdown Editor（Tauri 2 + CodeMirror 6 の没入型 Markdown エディタ）の動作を、実ユーザー面で再現可能に起動・操作・証跡化する。primary は VITE_E2E ビルドの Web UI を Playwright（chromium）で操作する面、secondary は macOS の Tauri debug ビルドの窓の観測。文書の保存、設定画面（外観と編集の節、最後の節「診断」のログの設定）と外観、左サイドバーとエクスプローラー（フォルダツリー、作成・名前の変更・ゴミ箱への移動、移動（ドラッグアンドドロップ、切り取りと貼り付け、同じ名前があるときの確認、開いている文書への追従）、外部の変更の自動反映、同梱の段 2 の部品「パスをコピー」と部品の権限の確認）、右ペインの部品のパネルと同梱の部品「アウトライン」、同梱の部品「タイピング音」（設定画面の「執筆の補助」のチェックと「音」の節の音色と音量、音色の切り替え、鳴り始めの位置、鳴らす要求の数え方、アプリのログへの記録）、アプリのログ基盤（設定「ログを記録する」、本体のロガー、Rust の app.log）、性能の計測（ログがオンの間だけ、区間ごとの所要時間を 1 分ごとにまとめる。ADR-007 の R16）、執筆モード、保存の信頼性、書き心地（Enter でのリストの継続、カーソルのない行で記法を隠す記号の表示、⌘/Ctrl+クリックでリンクを開く操作、隠した行のチェックボックスのクリックでの切り替え、表の表示と列幅・横スクロール、表の中の Tab でのセルの移動、表の入力の支援を含む）を変えたとき、または変更を検証して証跡を残したいときに使う。
---

# verify-mydocuments

このリポジトリの変更を、agent が起動・操作・証跡化して確かめるための Skill。コマンドはすべてリポジトリのルートで実行する。run ごとに独立した build・port・証跡ディレクトリを使うので、同時に複数の run を動かしてもぶつからない。

## Surfaces and limits

- primary: Web UI の e2e ビルド。環境変数 VITE_E2E=1 でビルドすると、本番では Tauri 経由のファイル I/O を担う DocumentBridge（Web UI からネイティブ側への唯一の入口。interface は src/platform/DocumentBridge.ts）が、メモリ実装（src/platform/memory/memoryBridge.ts）に差し替わる。これを Playwright の chromium で操作する。本番のビルドにはメモリ実装は含まれない。
- secondary: macOS の Tauri デスクトップアプリ（debug ビルド）。macOS には tauri-driver（Tauri 用の WebDriver）がなく、OS へのキー入力・マウス操作は送らない方針なので、観測だけを行う。窓を CGWindowList で特定し、screencapture で窓単体を撮る。
- 本番側の保証: DocumentBridge の外側（Rust のファイル I/O）は crates/docio と src-tauri の cargo test が担う。この Skill はそこを再実装しない。
- not covered:
  - 本物のゴミ箱、本物のファイルシステムの監視、登録外・シンボリックリンクのパスの拒否（src-tauri の cargo test が正本）。
  - ネイティブのファイル選択ダイアログとフォルダ選択ダイアログ。メモリ bridge では、seed の openPath、savePath、imagePath、folderPath が「ダイアログの戻り値」の代わりになる。
  - 実 IME（Microsoft IME、macOS の日本語入力、Mozc）。tests/e2e の CDP による変換の模擬（記号を隠した行の前後での変換を含む）はあるが、この Skill のシナリオには含めない。
  - リンクを実際に既定のブラウザで開く操作。メモリ bridge は渡された URL を記録するだけ。ネイティブ側の検査は src-tauri の cargo test（ブラウザは開かない）。Tauri 窓では、リンクを開くクリックを送らない。
  - Windows と Ubuntu の実機。CI では build と test までで、この Skill でも --platform windows、--platform linux は navigator の偽装にとどまる。
  - Tauri の窓で app.log が実際に書かれること（アプリのログ。ADR-007）。Rust の書き込みは src-tauri の cargo test、Web UI の記録はメモリ bridge の window.__mdeE2E.logging で確かめる。窓の中のコマンドの呼び出し（IPC）を通した書き込みは未確認。実ユーザーのログの領域（~/Library/Logs/）には触れない。
  - Tauri の窓（WKWebView）でのドラッグアンドドロップと、⌘X、⌘V のキーの届き方（ADR-003 の R15）。Web UI の drag の step は chromium のマウスの模擬で、実際の OS のドラッグではない。実際のファイルシステム（APFS の大文字小文字を区別しない動き）での同じ名前の判定は、src-tauri の cargo test（一時ディレクトリ）が見る。
  - Tauri 窓へのキー入力・クリック。窓の描画（ツリーと作成ボタンを含む）と、前回の文書・フォルダの再オープン（起動時の自動処理）だけを撮影で確かめる。

## Launch

Web UI を run 専用ディレクトリへビルドし、空きポートで preview を起動する。repo の dist-e2e や 127.0.0.1:4173（npm run serve:e2e が固定で使う）には触れない。

```
node .pi/skills/verify-mydocuments/scripts/launch.mjs            # run-id は自動採番
node .pi/skills/verify-mydocuments/scripts/launch.mjs --run-id my-run --port 4300   # 任意指定（port は省略可）
```

内部では `VITE_E2E=1 node node_modules/vite/bin/vite.js build --outDir artifacts/verify-mydocuments/<run-id>/dist --emptyOutDir` を実行し、続けて `vite preview --outDir ... --host 127.0.0.1 --port <空きポート> --strictPort` を起動する（pid が vite 自身になるよう npx を挟まない）。標準出力に次を出す。

```
RUN_ID=<run-id>
RUN_DIR=artifacts/verify-mydocuments/<run-id>
URL=http://127.0.0.1:<port>/
PID=<pid>
```

以降の script には `--run-id <run-id>` を渡す（環境変数 VERIFY_RUN_ID でも可）。pid、port、URL は `artifacts/verify-mydocuments/<run-id>/state.json` に記録される。ready の判定は、preview が HTTP 200 を返すことと、Doctor が確かめる html[data-ready="true"] の 2 段。ログは build.log と preview.log。

Tauri 版（secondary）は、先に実行ファイルを作る。

```
node .pi/skills/verify-mydocuments/scripts/tauri.mjs build                      # npx tauri build --debug --no-bundle（差分ビルドで十数秒、初回は数分）
node .pi/skills/verify-mydocuments/scripts/tauri.mjs start --run-id <run-id>    # HOME と CFFIXED_USER_HOME を <run-dir>/tauri-home に向けて起動
```

tauri build は beforeBuildCommand（npm run build）で repo の dist/ を作り直す（gitignore 済み）。start は、アプリのデータ領域（`<run-dir>/tauri-home/Library/Application Support/io.github.tanabe1478.immersive-markdown-editor/`）に session.json を書き、起動時に sample.md が開くようにする。`--doc <markdown>` で別の文書、`--prefs <preferences.json>` で設定、`--folder <dir>` で前回のエクスプローラーのフォルダ（session.lastFolder）を渡せる（見本のフォルダは run ディレクトリの中に作る。実ユーザーのフォルダは使わない）。ユーザーの実際のアプリデータ領域と WebKit の保存領域は使わない（stop が実ホーム側の署名で確かめる）。

## Doctor

read-only の健全性確認。drive の前、特に結果が怪しいときに必ず実行する。

```
node .pi/skills/verify-mydocuments/scripts/doctor.mjs --run-id <run-id>
```

node と npm の版、playwright の chromium の有無、state の pid が生きていること、その pid がこの run のものであること（ps が使えれば、コマンド行がこの run の dist を指していること。使えなければ lsof で port の LISTEN 所有者が pid であること）、port の所有者が state の pid であること、port が応答すること、run の dist があること、ページが VITE_E2E ビルドであること（html[data-ready="true"]、window.__mdeE2E、doc-title）を PASS/FAIL で出す。FAIL があれば exit 1。

ps や lsof が使えない sandbox（レビューや quality gate の実行環境では ps が Operation not permitted になる）でも、doctor は例外で落ちない。確認できない項目を FAIL として出し、残りの項目も評価する。port の所有者が違うときは、別の run や別のプロセスのページを操作している可能性があるので drive しない。chromium がなければ `npx playwright install chromium`（公開 npm を使うので、社内プロキシが既定の環境では `--registry https://registry.npmjs.org` を併せて確認する）。

## Drive

シナリオ（JSON）を Playwright で実行する。feature ごとのシナリオは features/scenarios/ にあり、各 feature ファイルの Driving 節が対応を示す。

```
node .pi/skills/verify-mydocuments/scripts/drive.mjs --run-id <run-id> --scenario .pi/skills/verify-mydocuments/features/scenarios/document-open-edit-save.json
```

オプション: `--name <label>`（証跡の保存名。既定はシナリオのファイル名）、`--platform mac|windows|linux`（navigator を偽装し、ControlOrMeta をその OS の修飾キーに読み替える。tests/e2e/helpers.ts と同じ作法。省略時はホスト OS）、`--viewport 1280x800`、`--headed`（ブラウザを表示）。シナリオは { "seed", "steps", "viewport"?, "platform"?, "showScrollbars"? }。showScrollbars: true は、headless の既定の --hide-scrollbars を外し、スクロールバーを描いて場所も取らせる（表の横スクロールバーの撮影用）。

seed は window.__E2E_SEED__ に入る初期状態で、ページを開く前に注入される。

- files: パス → バイト列。値は number[]、または { text, bom?, crlf? }、{ raw }（改行を変換しない文字列）、{ lines: { template, count } }（template の {n} を行番号にする）、{ png: { width, height, rgb } }（単色の PNG）、{ base64 }。パスは仮想（/docs/note.md のように、メモリ上のファイルシステムのキー）。
- openPath、savePath、imagePath、folderPath: 次に「開く」「保存」「画像を選ぶ」「フォルダを開く」ダイアログが返すパス（null はキャンセル）。
- preferences: 保存済みの設定（外観など。範囲外の項目だけ既定値に戻る）。
- emptyFolders、symlinkFolders、bulkFolders、unreadableFolders: フォルダ構造は files のパスから導く（/work/a/b.md があれば /work と /work/a がフォルダ）。そこに足せない場合の手段。emptyFolders は空のフォルダ（パスの配列）、symlinkFolders はフォルダへのリンクに見えるパス、bulkFolders は { path, count } で path の直下に item-00001.md から count 件の（中身のない）ファイル、unreadableFolders は読むと権限エラーになるフォルダ。開けないファイルは、files に .png や .json を置けばよい。名前がドットで始まるものは隠しとして除かれる。
- drafts、session: 前回の強制終了後の草稿、前回の文書とフォルダ（{ lastPath, lastFolder }）。再読み込みをまたいで保たれるのは lastFolder だけ（sessionStorage）。drafts の要素に baseRevisionOfFile（files のそのパスの SHA-256 を baseRevision にする）を書ける。

steps は上から順に実行し、外れたら止めて exit 1 にする。

- 操作: drag（from、to、toPosition?、hold?、screenshot?、cancel?。マウスの down / move / up で実際にドラッグする。from の行を押し、to の上まで動かし、hold ミリ秒そこで止まり、screenshot を撮り、cancel なら Esc を押してから離す。toPosition は to の左上からの座標）、press（key、times?）、type、insertText、click（target に force: true を足すと、aria-disabled の項目も押せる。button: right で右クリック、position で対象内の座標、modifiers: ["ControlOrMeta"] でその OS の Mod キーを押しながらクリック）、focus、fill（target に value を足す）、check、uncheck、select（target に option を足す）、waitFor、wait（ms）、mouseMove、mouseClick、viewport、reload、screenshot（名前）。
- bridge の操作: externalWrite（{ path, text | null, notify? }。外部のプロセスによる書き換え。text が null なら削除）、externalMkdir（{ path, notify? }。空のフォルダを作る）、externalRemove（{ path, notify? }。ファイルまたはフォルダを中身ごと消す）、focusWindow（ウィンドウのフォーカス復帰）、requestClose（窓を閉じる操作）、setPaths（{ open?, save?, image? }）。
- 観測: observe（名前。files に仮想パスを並べると、バイト数、bom、crlf、lf、text を記録）、eval（ページ内で式を評価して記録）。
- 検査: expect。対象は eval（式）か、testId / role+name / label / text / css のいずれか（設定画面の中なら panel: true）。read は text（既定）、count、visible、focused、attr:<name>、css:<prop>。比較は equals、not、contains、matches（正規表現）、gte、lte。timeout（既定 3000ms）まで再試行する。note は報告用の説明。

key の ControlOrMeta はその OS の Mod キー（macOS は Cmd、それ以外は Ctrl）。安定したハンドルは data-testid（doc-title、unsaved-mark、toast、conflict-bar、conflict-diff、conflict-reload、conflict-keep、diff-dialog、recovery-dialog、settings-button、settings-dialog、settings-editing、sidebar、sidebar-toggle、sidebar-close、right-pane、right-pane-toggle、right-pane-close、sidebar-empty、open-folder、retry-folder、restore-failure、change-folder、refresh-folder、new-file、new-folder、folder-name、file-tree、explorer-tree-area、tree-item、tree-note、tree-name-input、tree-name-error、tree-context-menu、confirm-trash、trash-ok、trash-cancel、menu-cut、menu-paste、confirm-move-conflict、move-conflict-message、move-conflict-kinds、move-replace、move-replace-reason、move-keep-both、move-cancel、char-count、canvas-bg、canvas-bg-image、canvas-surface、contrast-ratio、contrast-warning ほか）と、.cm-content、.cm-line、aria の名前（ツリーは role treeitem と名前）（dialog「設定」、radio「単色」「窓いっぱい」など）。観測の入口は window.__mdeE2E（calls、physicalWrites、log、conflicts、drafts、backups、savedPreferences、session、openedFolder、listed、watched、watchedFolders、trashed、renames、moves（別のフォルダへ移した項目と conflict）、moveCalls（moveEntry の呼び出しの記録）、openedUrls（リンクを開く操作で渡された URL。ブラウザは開かない）、clipboard（クリップボードに書かれた文字列の記録。OS のクリップボードには書かない）、savedPluginPermissions（保存された部品の権限の決定）、logging（アプリのログ。enabled、setLoggingCalls、appendLogCalls、entries。ネイティブ側の app.log の代わりで、有効の間の行だけ entries に残る。性能の計測の行は source が perf、perf-slow、perf-system）、failNext（次の 1 回だけ、openDocument、saveDocument、saveDocumentAs、writeDraft、moveEntry を失敗させる。テスト用）、closed、fullscreen、editor.getText()、readFile(path)）。性能の計測のまとめを 1 分を待たずに書かせるのは window.__mdePerf.flush()（e2e のビルドだけ）。タイピング音の音の要求は別に window.__mdeE2ETypingSound（fetches、fetchedTimbres、contexts、decoded、decodedTimbres、decodedOffsets、decodedCount、requests。e2e のビルドだけ）。

## Evidence

証跡は run ディレクトリに置く。cleanup では消えない。

```
artifacts/verify-mydocuments/<run-id>/
  state.json                       pid、port、URL、tauri の pid
  build.log, preview.log, tauri.log
  evidence/<name>/observations.json   シナリオ、全 step の結果、observe の値、最後の状態、console error
  evidence/<name>/*.png               screenshot の画像と final.png（失敗時は failure.png）
  evidence/tauri/<name>.png, .json    窓の撮影と、窓情報・アプリのデータ領域のファイル一覧
```

action の結果だけでなく、副作用も observations.json で確かめる。保存ならバイト列（BOM、改行）、物理的に書いた回数（physicalWrites）、log の outcome（written か unchanged）、草稿、バックアップ、保存された preferences。メモリ bridge は production の境界（DocumentBridge）の内側を差し替えているだけなので、書き込み規則の正本が Rust 側（crates/docio）にあることを報告に添える。$YORISHIRO_EVIDENCE_DIR が設定されているときは、主要な screenshot と observations.json をそこへもコピーする（手動の cp でよい）。

Tauri の撮影:

```
node .pi/skills/verify-mydocuments/scripts/tauri.mjs windows --run-id <run-id>              # この pid の窓の一覧
node .pi/skills/verify-mydocuments/scripts/tauri.mjs shot --run-id <run-id> --name startup  # 窓 1 枚を撮影
```

窓は最初の描画の後に表示される（tauri.conf.json の visible: false と notifyReady）。shot は表示されるまで待つ。撮影には、窓が表示される画面が必要。画面収録の許可が要る環境かどうかは未確認（この run の環境では追加の操作なしで撮影できた）。

## Cleanup

この run が起動したプロセスだけを、state.json の pid で止める。プロセス名では止めない。

```
node .pi/skills/verify-mydocuments/scripts/cleanup.mjs --run-id <run-id>
```

Tauri の pid（記録があれば）と preview の pid を、この run のものと確認できたときだけ SIGTERM で止める。確認の方法は、ps が使えれば、コマンド行が run の dist（preview）または Tauri の実行ファイル（tauri）を指していること。ps が使えない sandbox では lsof で、preview は state の port の LISTEN 所有者が pid であること、tauri は開いている実行ファイルが Tauri の実行ファイルであること。どちらでも確認できない pid は止めず、pid と port を出して exit 1 にする（プロセス名での kill はしない）。run の dist は消す（止められなかったときは消さない）。証跡、ログ、state.json は消さない。最後に port に LISTEN が残っていないことを、lsof と TCP 接続の両方で確かめ（lsof が使えなくても接続できないことで確認する）、残っていれば exit 1。失敗した drive の後も必ず実行する。

Tauri だけ止めるときは `tauri.mjs stop --run-id <run-id>`。止めるときに隔離を確かめ、確認できなければ exit 1 にする。

- 隔離の確認（HOME を run 専用ディレクトリへ向けられていること）は次のどちらか。(1) 起動したプロセスの環境が HOME と CFFIXED_USER_HOME を `<run-dir>/tauri-home` にしていること（ps -E で読む。ps が使えない sandbox では確認不能になる）。(2) アプリ自身が `<run-dir>/tauri-home/Library/` に書いたエントリがあること（start が置く session.json と preferences.json は数えない。WebKit や Caches の保存領域が通常ここにできる）。結果は shot が書く evidence/tauri/<name>.json の isolation と、stop が state.json の tauri.isolation に記録する。
- 補助の検査として、実ユーザーのホームにある次の場所の中身の署名（相対パス、サイズ、mtime）を start と stop で比べ、変わっていれば exit 1: Application Support と WebKit と Caches の識別子ディレクトリ、WebKit と Caches のバイナリ名ディレクトリ、HTTPStorages、Preferences の plist、Saved Application State。HOME だけを付け替えても WebKit が実ホームの ~/Library/WebKit/<バイナリ名> と ~/Library/Caches/<バイナリ名> に書くことがあったので、CFFIXED_USER_HOME も run 専用ディレクトリへ向けている。
- 限界: 実ホーム側の検査は上の既知の場所だけで、署名は mtime とサイズなので、同じサイズで mtime を戻す書き込みや、上記以外の場所への書き込みは検出しない。隔離の根拠は(1)と(2)であり、実ホームの署名が変わらなかったことは「触れていない」の証明ではなく、既知の場所に変化がなかったという観測にとどまる。

## 性能計測（perf/）

性能の基準値を取る、または変更で遅くなっていないか確かめるときの手順。上の Launch から Cleanup とは別の仕組みで、リポジトリ直下の perf/ が持つ。結果の読み方と基準値は docs/perf-baseline.md。

```
npm run perf -- --quick --web-only      # 回数を減らした Web UI だけ（chromium と webkit、約 1.6 分）。sandbox でも動く。結果は perf/out/（gitignore）
npm run perf                            # 全部。macOS 実機で Tauri の release ビルドを作って計測する（約 6 分）。結果は perf/results/<日付>-<コミット>.json
npm run perf:compare -- <base.json> <new.json>   # 悪化した項目を一覧にして exit 1。引数を省くと perf/results/ の最新 2 件
npm run perf:test                       # 比較の仕組み（perf/lib/judge.mjs）の単体テスト（node:test）
npm run perf -- --quick --web-only --inject-input-delay 3   # 計測専用: 全 keydown に 3ms のビジーウェイトを足す。悪化を検出できるかの確認用（結果は perf/out/ だけ）
npm run perf -- --only web --browsers chromium --typing-sound --out perf/out/<name>.json   # 計測専用: 設定「タイピング音」をオンにして計測（chromium は --mute-audio で起動する。webkit では使わない）。結果は perf/out/ だけ
```

- 計測項目: Tauri 実機の起動時間（cold / warm）と全プロセス合計の RSS（空、100KB、1MB）、Web UI の入力から描画まで（A〜D、末尾と中央。フレーム単位）、入力の処理時間（keydown から CodeMirror の更新通知まで。フレームに丸められない）、IME 確定（chromium の CDP による模擬）、1MB のスクロールのフレーム時間、開く操作、フォーカス・タイプライターの切替、docio の読み書き（Rust の example を release で 200 回）、配布物のサイズ。
- 悪化の判定: 20% 以上悪化 かつ 差が標本の揺れ（1.4826 × MAD とブロックブートストラップの大きいほう）の 3 倍を超える かつ 単位ごとの小さな下限以上。標本が 3 件未満（cold）は判定せず参考に出す。p95 は標本 40 件以上で、中央値も悪化したときだけ悪化に数える。標本が無い古い結果との比較は従来の固定の下限（その旨を表示）。式と係数は perf/lib/judge.mjs と docs/perf-baseline.md の「悪化の判定」。
- quick の結果は標本が少なく、判定の根拠にならない（検出の確認とスモーク用）。基準値の比較にはフルの結果を使う。遅延を注入した結果は perf/results/ に置けない。
- Tauri は、この Skill の Launch と同じ作法で HOME と CFFIXED_USER_HOME を計測用の run ディレクトリへ向けて起動し、前回の文書（session.json）に計測データを置いて開き直させる。実ユーザーのアプリデータには触れない。計測の前後で実ホームの既知の場所の署名を比べ、変わっていれば結果に失敗として残す。OS へのキー入力・マウス操作は送らない。
- 失敗した項目は、結果の status と reason に残る（他の項目は続行）。失敗が 1 件でもあれば run は exit 1。
- 測定中は、同じマシンで重い処理（cargo、npm run test:e2e など）を並行して走らせない。結果は環境（負荷、電源）に左右される。
- Web UI の計測はメモリ bridge の上で動く。DocumentBridge の内側（Rust の I/O と IPC）は含まないので、ディスクの読み書きは docio の項目で別に見る。

## 隔離した操作（段 2）の検証

部品の仕組み（ADR-005）の、隔離した操作の段（段 2）を変えたとき、またはその隔離を確かめ直したいときの手順。上の Launch から Cleanup とは別で、macOS の実際の Tauri の窓を使う。OS へのキー入力・マウス操作は送らない。R8 で、仲介の iframe は独自プロトコル plug: をやめ、sandbox の srcdoc の iframe になった（relay.js は本体と同じオリジンの /plugin-host/relay.js）。R6 で、権限（宣言、初回の確認、保存、取り消し）と、権限の要る API（クリップボードへの書き込み、パス、ツリーの右クリックの項目）、同梱の段 2 の部品「パスをコピー」が入った（features/explorer.md の EXP-14）。R7 で、部品がパネル（項目の木。描くのは本体）を足せるようになり（R13 で、パネルの場所は左サイドバーの下から右ペインへ移った。起動時は閉じていて、上部バーのボタンか Option+Cmd+B / Ctrl+Alt+B で開く）、宣言だけで使える権限 document.read（本文とカーソルの位置を受け取る）と、同梱の部品「アウトライン」が入った（features/outline.md）。

- ブラウザ版（primary）: e2e のビルドが、テスト用の段 2 の部品（src/isolated-plugins/e2eFixtures.ts）を、seed の isolated に名前を書いたときだけ読み込む。確かめる内容は tests/e2e/isolated-plugins.spec.ts（`npm run test:e2e`）。Launch と Drive の seed にも `isolated: { plugins: ['e2e-ok'], runTimeoutMs: 1000 }` を書ける。観測の入口は `window.__mdeE2EIsolatedTrace`（本体の側で見えた start、command、menu、panel、items、doc、selection、ready、run、done、stopped の記録。doc と selection は、本文とカーソルの位置を部品に届けた記録）と、console の `[plugin] 部品「<id>」を止めました: <理由>`。同梱の段 2 の部品（パスをコピーとアウトライン）は、seed に isolated がなくても本番と同じく読み込まれる（iframe と Worker がある。ツリーの最上位の項目のメニューは本体の 6 つのあとに「パスをコピー」が付く）。外すのは `isolated: { plugins: [], bundled: false }` と明示したときだけ（そのとき iframe も Worker も作られない）。観測の入口に、`window.__mdeE2E.clipboard`（クリップボードに書かれた文字列の記録。OS のクリップボードには書かない）、`window.__mdeE2E.savedPluginPermissions`（保存された権限の決定）がある。seed の `pluginPermissions` は、保存済みの権限の決定の代わり。
- Tauri の窓（隔離の検証）: Cargo の feature `isolation-probe` と `VITE_ISOLATION_PROBE=1` の両方を有効にしたビルドだけが、記録用のネイティブのコマンドと、検証用の段 2 の部品を持つ。

```
node .pi/skills/verify-mydocuments/scripts/tauri.mjs build --probe          # 別の target ディレクトリ（src-tauri/target/isolation-probe）に作る。通常の実行ファイルは上書きしない
node .pi/skills/verify-mydocuments/scripts/isolation-probe.mjs --run-id <id> # 受け口（127.0.0.1）を立て、Tauri を run 専用の HOME で起動し、検証が終わるのを待ち、窓を撮り、Tauri と受け口を止めて判定する
node .pi/skills/verify-mydocuments/scripts/isolation-probe.mjs --judge-only <dir>   # 記録済みの canary.log、net.log、report.jsonl を判定し直すだけ
node .pi/skills/verify-mydocuments/scripts/check-probe-absent.mjs           # 本番の dist/ と通常の実行ファイルに、検証用のコードがないことの検査
```

- 判定の根拠は、ネイティブ側の記録（canary.log。検証用のコマンドが書く）と、127.0.0.1 の受け口の記録（net.log）。webview 側の自己申告（report.jsonl）は、表に並べるだけ。R6 の権限の API は、clipboard.log（検証用のビルドでは、クリップボードへの書き込みが記録に差し替わる。OS のクリップボードには書かない。本体の対照の 1 行だけが出るはずで、ほかの行があれば FAIL）と、アプリのデータ領域の plugin-permissions.json（確認の画面に答えていないので、できていないはず。できていれば FAIL）で判定する。宣言していない権限の API の拒否、不正な形の呼び出しでの停止、未決の権限での確認の画面（自動では許可されない）、同梱の部品が本物の relay.js（srcdoc の仲介の iframe）の上で ready になりコマンドとメニューの項目を登録したこと、のどれかが記録で確かめられないときは、INCOMPLETE。R7 の経路（パネルの不正な項目、setItems の頻度の上限、カーソルを動かそうとするメッセージが、仲介に止められること。document.read を宣言した部品には本文が届き、宣言していない部品と、パネルが見えていない同梱の部品には届かないこと。同梱のアウトラインが本物の relay.js の上でパネルを登録したこと）も同じ。宣言していない部品に本文が届いたら FAIL、確かめられなければ INCOMPLETE。R8 の経路（仲介と同じ条件の文脈が、自分の iframe を本体のページ、plug:（なくなったプロトコル）、data:、blob: へ移す経路と、子の iframe を作る経路）は、表の「R8」の節に、移れたか、本体の窓と仲介の文脈の CSP の違反、移った先で攻撃のコードが動いたか、data: と blob: の先からの鍵ありの postMessage が canary.log に届いた回数を並べる。届いた回数が 0 でなければ FAIL、試験が動いたと確かめられなければ INCOMPLETE。結果は artifacts/verify-mydocuments/<run-id>/evidence/isolation-probe/（judgement.json、judgement.md、各記録、窓の撮影）。$YORISHIRO_EVIDENCE_DIR があれば、そこにもコピーする。
- exit code: 0 は、本体以外の文脈から、鍵なしでも鍵ありでも届く経路がなく、対照も届いた（PASS）。2 は届く経路があった（FAIL。直さずに報告する）。3 は検証が終わらなかった、または対照が届かなかった（INCOMPLETE）。対照が届かない結果は、届かなかったという結論にしない。
- R8 から、鍵ありで届く経路も FAIL にする（R5 と R6 では、仲介と同じ条件の文脈からの鍵ありの webkit.messageHandlers.ipc.postMessage が届き、FAIL にしなかった）。仲介の iframe は plug: ではなく srcdoc になり、Tauri はその送り元（about:srcdoc）をリモートの扱いにして拒否する（ADR-005 の「R8 で決めた細部」「R8 で確かめた隔離」）。
- 検証用のビルドは、repo の dist/ を検証用のコード入りにする。終わったら、通常の `tauri.mjs build`（--probe なし）か `npm run build` で作り直してから、check-probe-absent.mjs を実行する。
- 届かなかった項目の結論は、その経路が実際に試されたこと（自己申告に、拒否のエラーが出ていること）と、対照が届いたことの両方で支える。

## Helpers

すべて Node で、.pi/skills/verify-mydocuments/scripts/ にある。呼び出し方は上の各節のとおり。

- launch.mjs: ビルドと preview の起動、state の記録。
- doctor.mjs: read-only の健全性確認（ps や lsof が使えなくても落ちない）。
- drive.mjs: シナリオの実行と証跡の保存。
- tauri.mjs: Tauri の build、start、windows、shot、stop（macOS 専用。窓の一覧は cgwindows.swift を swift で実行して得る）。build と start は --probe で、隔離の検証用のビルドと起動（isolation-probe.mjs が使う）。
- cleanup.mjs: この run のプロセスの停止（pid がこの run のものと確認できたときだけ）と dist の削除。
- isolation-probe.mjs: 隔離した操作（段 2）の隔離の検証（受け口の起動、検証用の Tauri の起動と停止、判定。macOS 専用）。
- check-probe-absent.mjs: 本番の dist/ と通常の実行ファイルに、検証用のコードがないことの検査。
- check-skill.mjs: この Skill の形式検査（依存なし。`node .pi/skills/verify-mydocuments/scripts/check-skill.mjs`）。Skill を編集したら実行する。

共通処理は lib.mjs（直接は実行しない）。保守は maintain-verification-skill に引き継ぐ。

## 通しの手順

```
node .pi/skills/verify-mydocuments/scripts/launch.mjs                    # RUN_ID を控える
node .pi/skills/verify-mydocuments/scripts/doctor.mjs --run-id <id>
node .pi/skills/verify-mydocuments/scripts/drive.mjs --run-id <id> --scenario <features の Driving 節にあるシナリオ>
node .pi/skills/verify-mydocuments/scripts/tauri.mjs build && node .pi/skills/verify-mydocuments/scripts/tauri.mjs start --run-id <id> && node .pi/skills/verify-mydocuments/scripts/tauri.mjs shot --run-id <id> --name startup
node .pi/skills/verify-mydocuments/scripts/tauri.mjs stop --run-id <id>    # Tauri を起動した run だけ。隔離の確認が入る
node .pi/skills/verify-mydocuments/scripts/cleanup.mjs --run-id <id>
```

feature の一覧と共通の前提は features/README.md。
