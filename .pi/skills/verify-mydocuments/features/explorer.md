# エクスプローラー（左サイドバーのフォルダツリー）

## Sub-features

- EXP-1: フォルダを選ぶ。未選択のサイドバーには「フォルダを開く」（open-folder）だけがある。ダイアログのキャンセルは何も起こさない。選ぶと、見出し部にフォルダ名（folder-name。フルパスは title）、再読み込み（refresh-folder）、「別のフォルダを開く」（change-folder）が出て、その下にツリーが出る。開けないフォルダを選ぶとトーストで知らせ、いまのツリーを残す。
- EXP-2: ツリー（role tree）。フォルダが先、その中は名前の自然順（file2 が File10 より前。大文字小文字を区別しない）。名前がドットで始まる項目は出ない。フォルダは展開したときに中身を読む（遅延読み込み）。折りたたんでも、読み込み済みの中身と孫の展開状態は保たれる。空のフォルダは「空のフォルダ」の行（tree-note）を出す。
- EXP-3: 項目の種類。開けるのは拡張子（大文字小文字を区別しない）が md、markdown、mdown、mkd、mdx、txt、text のファイル。それ以外は灰色で aria-disabled が true になり、クリックや Enter では何も起こらない。フォルダへのシンボリックリンクは「↪」の印があり、aria-expanded を持たず、展開しない（読みにも行かない）。
- EXP-4: 5000 件を超えるフォルダは、先頭の 5000 件と、末尾の「ほか N 件」の行（クリック不可）。ちょうど 5000 件なら切り捨てない。
- EXP-5: 文書を開く。クリックでも、キーボードの Enter と Space でも開く。「開く」と同じ流れで、未保存の変更があれば確認が出る（キャンセルで元のまま）。開けたら本文にフォーカスが移る。開いている文書のファイルは aria-current が true で強調される。同じファイルをもう一度押しても何もしない。
- EXP-6: キーボード。上下で移動、右で展開（展開済みなら最初の子へ）、左で折りたたみ（折りたたみ済みなら親へ）、Home と End。roving tabindex で、Tab で入る項目は 1 つだけ。
- EXP-7: 復元。開いたフォルダは session に保存され、再読み込み（実アプリでは次回の起動）で復元される。展開状態は復元しない。復元先がない、または読めないときは、未選択の表示に戻り、トーストで短く知らせる（起動は妨げない）。
- EXP-8: .txt と .text は、Markdown の装飾（見出し、記号の薄色、ぶら下げインデントなど）なしの素のテキストで表示される。.md では付く。別名保存で拡張子が変わると表示も切り替わる。保存の BOM と改行は変わらない。フォーカスモードの段落は、.txt では空行だけで分ける。

## How to get to it (user POV)

- 上部バー左端のサイドバーの開閉ボタン（sidebar-toggle）か Mod+B でサイドバーを開く（appearance-canvas.md の APP-9、APP-10）。
- サイドバーの「フォルダを開く」（open-folder）、開いた後は「別のフォルダを開く」（change-folder）。ネイティブのフォルダ選択ダイアログは、メモリ bridge では seed の folderPath が戻り値の代わり。
- ツリーの項目（role treeitem。名前はファイル名、フォルダへのリンクは「名前（リンク）」）。行のクリック、フォーカスしてからの矢印・Home・End・Enter・Space。
- 再読み込みボタン（refresh-folder）。
- 起動時の自動処理: 前回のフォルダ（session.lastFolder）の復元。サイドバーが閉じていても読み込まれ、開くとすぐ見える。

## Driving it with Playwright（メモリ bridge）

Preconditions: Launch 済みで Doctor が全 PASS。フォルダ構造は seed の files のパスから導く（/work/notes/docs/guide.md があれば /work/notes と /work/notes/docs がフォルダ）。空のフォルダ、リンク、大量の項目、読めないフォルダは seed の emptyFolders、symlinkFolders、bulkFolders、unreadableFolders で作る。preferences の sidebarOpen を true にしておく。ツリーの行は css（`[data-testid=file-tree] [role=treeitem][aria-label='名前'] > .tree-row`）で指す。li 自体を押すと、展開中は中央が子の行に当たるので、行（.tree-row）を押す。aria-disabled の行は click に force: true を付ける。

| シナリオ | user action | 観測できる結果 |
|---|---|---|
| explorer-tree.json | 「フォルダを開く」で /work/notes を開く。docs、deep、empty、linked を操作し、折りたたみ、再読み込み | フォルダ名が notes（title はフルパス）。並びが Archive、docs、empty、linked（リンク）、a.md、b.txt、c.text、file2.md、File10.md、img.png、notes.json、Zeta.md で、隠しがない。展開するまで listed は開いたフォルダだけ。docs を展開すると level 2、deep の中が level 3。空のフォルダは「空のフォルダ」。リンクは aria-expanded がなく、読みに行かない。折りたたむと中身が消える。画像は 01-empty.png、02-tree-collapsed.png、03-tree-expanded.png |
| explorer-open.json | a.md、b.txt をクリック。img.png と notes.json を押す。b.txt を編集して a.md を押し、確認をキャンセル、もう一度押して「保存しない」 | 開いたファイルが aria-current。a.md には .cm-md-h1 があり、b.txt にはない（見出し風の行と本文の行が同じ大きさと太さ）。開けないファイルを押しても doc-title は変わらず、bridge の open は 2 回のまま。未保存のときは alertdialog が出て、キャンセルで b.txt と未保存マークが残り、「保存しない」で a.md が開く。画像は 01-md-open.png、02-txt-open.png、03-disabled-item.png、04-discard-confirm.png |
| explorer-keyboard.json | Archive にフォーカスして、下、右、右、左、左、End、Home、下 4 回、Enter。img.png で Enter | 各キーの結果の位置（focused）と aria-expanded が期待どおり。Tab で入る項目は 1 つ。a.md が Enter で開き、本文にフォーカス。img.png は Enter でも開かない。画像は 01-keyboard-focus.png |
| explorer-restore.json | seed の session.lastFolder から起動し、docs を展開して reload | 起動時にフォルダ名が notes で、docs は折りたたまれている。reload 後も復元され、トーストは出ない |
| explorer-restore-missing.json | 存在しないフォルダが session.lastFolder の状態で起動 | 未選択の表示（sidebar-empty、open-folder）に戻り、トーストに「前回のフォルダを開けませんでした」。本文は使え、session.lastFolder は消える。画像は 01-missing.png |
| explorer-many.json | 5003 件のフォルダを展開 | 「ほか 3 件」の行（aria-disabled）。項目は 5002 行（フォルダ、readme.md、先頭 5000 件）。item-05000.md はあり、item-05001.md はない。画像は 01-more-row.png |
| explorer-dark.json | ダークで、前回の文書（b.txt）とフォルダが復元された状態で起動し、docs を展開、a.md をクリック | 文書とフォルダが両方復元される。b.txt が強調され、灰色の項目が読める。画像は 01-dark-tree.png、02-dark-md.png |

```
node .pi/skills/verify-mydocuments/scripts/drive.mjs --run-id <run-id> --scenario .pi/skills/verify-mydocuments/features/scenarios/explorer-tree.json
node .pi/skills/verify-mydocuments/scripts/drive.mjs --run-id <run-id> --scenario .pi/skills/verify-mydocuments/features/scenarios/explorer-open.json
node .pi/skills/verify-mydocuments/scripts/drive.mjs --run-id <run-id> --scenario .pi/skills/verify-mydocuments/features/scenarios/explorer-keyboard.json
node .pi/skills/verify-mydocuments/scripts/drive.mjs --run-id <run-id> --scenario .pi/skills/verify-mydocuments/features/scenarios/explorer-restore.json
node .pi/skills/verify-mydocuments/scripts/drive.mjs --run-id <run-id> --scenario .pi/skills/verify-mydocuments/features/scenarios/explorer-restore-missing.json
node .pi/skills/verify-mydocuments/scripts/drive.mjs --run-id <run-id> --scenario .pi/skills/verify-mydocuments/features/scenarios/explorer-many.json
node .pi/skills/verify-mydocuments/scripts/drive.mjs --run-id <run-id> --scenario .pi/skills/verify-mydocuments/features/scenarios/explorer-dark.json
```

Tauri の窓（secondary）。run ディレクトリの中に見本のフォルダを作り、`tauri.mjs start --folder <見本フォルダ> --prefs <sidebarOpen: true の設定>` で起動して `tauri.mjs shot` で撮る。実際のファイルシステムからツリーが復元されることの確認で、キー入力とクリックは送らない。

## Gotchas

- フォルダ選択ダイアログは seed の folderPath が戻り値の代わり。null だとキャンセル扱いで何も起きない。実際のネイティブのダイアログと、Rust 側の許可（登録したフォルダの配下だけ読める、.. やリンクで外へ出られない）は、この Skill では確かめない（src-tauri の cargo test が正本）。
- メモリ bridge は、再読み込みをまたいで session.lastFolder だけを sessionStorage に保つ（lastPath は保たない）。実アプリの「次回の起動」の代わり。
- bulkFolders の項目は中身のない仮想のファイルで、開くと見つからない。件数の表示の確認用。
- aria-disabled の要素は、Playwright の通常の click が「操作できない」として待ち続ける。シナリオでは force: true を付ける。利用者は押せる（押しても何も起きないことの確認）。
- 行の矢印の回転は 0.12 秒かかる。クリック直後の screenshot では、途中の角度が写る（Reduced Motion ではすぐ最終の形）。
- ツリーの項目は li で、展開中は子の行を内側に含む。li の textContent や aria の名前に子の名前が混ざらないよう、li には aria-label（ファイル名）が付いている。名前で指すときは exact にする。
- 「ほか N 件」と「読み込み中…」「空のフォルダ」は treeitem（aria-disabled）で、testId は tree-note。ファイルの testId は tree-item。
- ネイティブ側の並べ替え（5000 件の切り捨ての基準）と画面の並べ替え（Intl.Collator）の細かい順序は違うことがある。メモリ bridge は画面側と同じ Collator を使うので、この差は再現しない。
