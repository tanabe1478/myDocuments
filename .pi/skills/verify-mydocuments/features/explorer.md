# エクスプローラー（左サイドバーのフォルダツリー）

## Sub-features

- EXP-1: フォルダを選ぶ。未選択のサイドバーには「フォルダを開く」（open-folder）だけがある。ダイアログのキャンセルは何も起こさない。選ぶと、見出し部にフォルダ名（folder-name。フルパスは title）、再読み込み（refresh-folder）、「別のフォルダを開く」（change-folder）が出て、その下にツリーが出る。開けないフォルダを選ぶとトーストで知らせ、いまのツリーを残す。
- EXP-2: ツリー（role tree）。フォルダが先、その中は名前の自然順（file2 が File10 より前。大文字小文字を区別しない）。名前がドットで始まる項目は出ない。フォルダは展開したときに中身を読む（遅延読み込み）。折りたたんでも、読み込み済みの中身と孫の展開状態は保たれる。空のフォルダは「空のフォルダ」の行（tree-note）を出す。
- EXP-3: 項目の種類。開けるのは拡張子（大文字小文字を区別しない）が md、markdown、mdown、mkd、mdx、txt、text のファイル。それ以外は灰色で aria-disabled が true になり、クリックや Enter では何も起こらない。フォルダへのシンボリックリンクは「↪」の印があり、aria-expanded を持たず、展開しない（読みにも行かない）。
- EXP-4: 5000 件を超えるフォルダは、先頭の 5000 件と、末尾の「ほか N 件」の行（クリック不可）。ちょうど 5000 件なら切り捨てない。
- EXP-5: 文書を開く。クリックでも、キーボードの Enter と Space でも開く。「開く」と同じ流れで、未保存の変更があれば確認が出る（キャンセルで元のまま）。開けたら本文にフォーカスが移る。開いている文書のファイルは aria-current が true で強調される。同じファイルをもう一度押しても何もしない。
- EXP-6: キーボード。上下で移動、右で展開（展開済みなら最初の子へ）、左で折りたたみ（折りたたみ済みなら親へ）、Home と End。roving tabindex で、Tab で入る項目は 1 つだけ。
- EXP-7: 復元。開いたフォルダは session に保存され、再読み込み（実アプリでは次回の起動）で復元される。展開状態は復元しない。復元先がない、または読めないときは、未選択の表示に戻り、トーストで短く知らせる（起動は妨げない）。session の記録は消さない（N2）。空の状態に「前回のフォルダ「名前」を開けませんでした（理由）」（restore-failure）、「再試行」（retry-folder）、「フォルダを開く」が出る。開けるようになった後の再試行でツリーが出る。別のフォルダを開けば、その記録で上書きする。
- EXP-8: .txt と .text は、Markdown の装飾（見出し、記号の薄色、ぶら下げインデントなど）なしの素のテキストで表示される。.md では付く。別名保存で拡張子が変わると表示も切り替わる。保存の BOM と改行は変わらない。フォーカスモードの段落は、.txt では空行だけで分ける。
- EXP-9: 作成。見出し部の「新しいファイル」（new-file）と「新しいフォルダ」（new-folder）、ツリーの項目と空き領域の右クリックメニュー（tree-context-menu。role menu、項目は menuitem）。作成先は、選択中のフォルダ、ファイルが選択中ならその親、何も選んでいなければルート（閉じていれば展開する）。名前はツリーの中の入力欄（tree-name-input）。Enter で確定、Esc で取り消し、フォーカスが外れたら有効な名前なら確定・空なら取り消し。IME の変換中の Enter では確定しない。ファイルは拡張子がなければ .md が付き、作ったファイルが開く。フォルダは展開して選択する。
- EXP-10: 名前の検査。拒否するのは、空・空白だけ、/ や \ を含む、. と ..、ドットで始まる、同じフォルダの同名（大文字小文字だけの違いはファイルシステムの判断）、< > : " | ? * と制御文字、末尾のドットと空白。拒否したら入力欄を残し、理由（tree-name-error）を入力欄の直下に出す（aria-invalid、aria-describedby）。何も作られない。
- EXP-11: 名前の変更。F2 か右クリックの「名前を変更」。入力欄の選択は拡張子の前まで。自分自身の名前と大文字小文字だけの変更は通る。開いている文書（またはそれを含むフォルダ）の名前を変えると、文書は新しいパスへ移る（上部バーの名前、監視、前回の文書、草稿のパス）。本文と未保存の状態は残り、保存は新しいパスに書かれ、削除扱いにならない。失敗したら文書は古いパスのまま。展開状態と選択は新しいパスへ引き継ぐ。
- EXP-12: ゴミ箱への移動。Delete（macOS は ⌘⌫ も）か右クリックの「ゴミ箱に移動」。毎回、確認（confirm-trash。role alertdialog。既定のフォーカスはキャンセル、Esc で取り消し）。確定するとツリーから消え、選択は隣へ移る。開いている文書（またはそれを含むフォルダ）を移すと、監視の通知を待たずに外部変更の確認が走り、未保存の変更がなければ「削除された」の表示、あれば競合バー。
- EXP-13: 外部の変更の自動反映。ルートと展開中のフォルダは監視され、外部で項目が増減・名前の変更をされると、操作なしでツリーに反映される。展開状態と選択は保たれ、消えたフォルダは展開をやめる。通知の読み直しはトーストを出さない。
- EXP-14: 同梱の段 2 の部品「パスをコピー」（ADR-005 の R6）。ファイルとフォルダの行（ツリーの最上位の行。入れ子の行には出ない）の右クリックメニュー（と Shift+F10）に、本体の 6 項目（EXP-16 で足した切り取りと貼り付けを含む）のあと、区切り（role separator）を入れて「パスをコピー」が並ぶ（testId は menu-plugin-copy-path.copy-path）。空き領域のメニューには出ない。選ぶと、その行のパスがクリップボードに入り、トースト「クリップボードにコピーしました」が出る。Mod+Alt+C は開いている文書のパス（未保存の新規文書では何もしない）。初回は、確認の画面（permission-dialog。role dialog。部品の名前と権限ごとの説明、「許可しない」が既定のフォーカス、「許可する」）が出る。Esc と閉じるは今回だけ断る（保存せず、次の使用で再び聞く）。確認の画面は、利用者の操作で始まった実行（ショートカット、メニューの項目の選択）の中で、その実行につき 1 回まで（起動時、実行の外、同じ実行の 2 回目以降の未決の呼び出しは、画面なしで断られる）。結果は設定画面の「部品の権限」（settings-plugin-permissions）に出て、「取り消す」で未決に戻る。部品が止まると、メニューの項目は消える。
- EXP-15: 移動（ドラッグアンドドロップ。ADR-003 の R15）。ファイルとフォルダの行を引いて、フォルダの行（その中）、ファイルの行（その親）、ツリーの空いている所（ルート）に落とすと移る。移し先のフォルダが開き、移した項目が選ばれてフォーカスされ、展開状態は新しいパスへ引き継がれる。自分自身・自分の中のフォルダ・いまいるフォルダには落とせない（dropEffect は none、強調しない）。外（Finder など）から来たものは受け付けない。閉じたフォルダの上で 700ms 止まると開く。ツリーの上下の端に近づくとスクロールする。Esc で取り消すと何も移らない。落とせるフォルダの行は 2px の実線の枠（data-drop-target）、ルートはツリー全体の 2px の破線の枠（data-drop-root）で、色だけに頼らない。dataTransfer にはパスも名前も入らない。
- EXP-16: 切り取りと貼り付け。項目の行にフォーカスして Mod+X（macOS は Cmd、ほかは Ctrl）で切り取りの印（data-cut。名前が「…（切り取り済み）」になり、薄い色・斜体・破線）、フォーカスのある行で Mod+V でその場所（フォルダならその中、ファイルならその親）へ移る。右クリックのメニューにも「切り取り」「貼り付け」（menu-cut、menu-paste。印がないあいだ「貼り付け」は aria-disabled）。空き領域のメニューの「貼り付け」はルートへ。Esc、項目の消失（外部の削除、ゴミ箱）、別のフォルダを開くことで印が外れる。同じフォルダへの貼り付けは何もせず、フォルダを自分自身の中へは移さずに知らせる。名前の入力欄の中と本文の Mod+X、Mod+V は、今のまま。IME の変換中は対象にしない。OS のクリップボードには、書かず、読まない（window.__mdeE2E.clipboard にも書かれない）。
- EXP-17: 移し先に同じ名前があるとき。まず fail で試し（moveCalls の最初の conflict が fail）、確認（confirm-move-conflict。role alertdialog）が出る。「置き換える」（move-replace。既存の項目はゴミ箱へ移る）、「両方とも残す」（move-keep-both。既定のフォーカス。拡張子の前に番号、`a 2.md`、拡張子のない名前とフォルダは末尾、`same 2`）、「中止」（move-cancel。Esc もこれ。何も変えない）。種類が違うとき（move-conflict-kinds）は一言が出る。開いている文書（またはそれを含むフォルダ）を置き換えることになるとき、移す項目が既存の項目の中にあるとき（祖先の置き換え）は、「置き換える」が aria-disabled になり、理由（move-replace-reason）が出る。開いている文書（またはそれを含むフォルダ）を移すと、未保存の変更を保ったまま新しいパスに追従し、保存は新しいパスへ書かれる。失敗はトースト「移動できませんでした。…」で、ログを記録する設定がオンなら、explorer の move-failed に、エラーの種類と conflict の値だけが残る。

## How to get to it (user POV)

- 上部バー左端のサイドバーの開閉ボタン（sidebar-toggle）か Mod+B でサイドバーを開く（appearance-canvas.md の APP-9、APP-10）。
- サイドバーの「フォルダを開く」（open-folder）、開いた後は「別のフォルダを開く」（change-folder）。ネイティブのフォルダ選択ダイアログは、メモリ bridge では seed の folderPath が戻り値の代わり。
- ツリーの項目（role treeitem。名前はファイル名、フォルダへのリンクは「名前（リンク）」）。行のクリック、フォーカスしてからの矢印・Home・End・Enter・Space。
- 再読み込みボタン（refresh-folder）。
- 作成: new-file、new-folder（ボタン。キーボードは focus して Enter か Space）。項目の右クリック、空き領域の右クリック、項目にフォーカスして Shift+F10 かメニューキー。メニュー内は上下・Home・End・Enter・Esc。
- 名前の変更: 項目にフォーカスして F2、右クリックの「名前を変更」。ゴミ箱: 項目にフォーカスして Delete（macOS は ⌘⌫）、右クリックの「ゴミ箱に移動」。
- 移動: 行を引いてフォルダの行、ファイルの行、ツリーの空いている所に落とす。項目にフォーカスして Mod+X のあと、移し先の行にフォーカスして Mod+V。右クリックの「切り取り」と、移し先の行または空き領域の右クリックの「貼り付け」。同じ名前があるときの確認の画面（move-replace、move-keep-both、move-cancel、Esc、Tab）。
- 前回のフォルダを開けなかったときの「再試行」（retry-folder）。
- 起動時の自動処理: 前回のフォルダ（session.lastFolder）の復元。サイドバーが閉じていても読み込まれ、開くとすぐ見える。
- 「パスをコピー」: ファイルまたはフォルダの行の右クリック、または行にフォーカスして Shift+F10 のあと、End と Enter。Mod+Alt+C（macOS は Cmd+Option+C）。初回の確認の画面の「許可する」「許可しない」、Esc、閉じるボタン。設定画面（Mod+,）の「部品の権限」と「取り消す」。

## Driving it with Playwright（メモリ bridge）

Preconditions: Launch 済みで Doctor が全 PASS。フォルダ構造は seed の files のパスから導く（/work/notes/docs/guide.md があれば /work/notes と /work/notes/docs がフォルダ）。空のフォルダ、リンク、大量の項目、読めないフォルダは seed の emptyFolders、symlinkFolders、bulkFolders、unreadableFolders で作る。preferences の sidebarOpen を true にしておく。ツリーの行は css（`[data-testid=file-tree] [role=treeitem][aria-label='名前'] > .tree-row`）で指す。li 自体を押すと、展開中は中央が子の行に当たるので、行（.tree-row）を押す。aria-disabled の行は click に force: true を付ける。

| シナリオ | user action | 観測できる結果 |
|---|---|---|
| explorer-tree.json | 「フォルダを開く」で /work/notes を開く。docs、deep、empty、linked を操作し、折りたたみ、再読み込み | フォルダ名が notes（title はフルパス）。並びが Archive、docs、empty、linked（リンク）、a.md、b.txt、c.text、file2.md、File10.md、img.png、notes.json、Zeta.md で、隠しがない。展開するまで listed は開いたフォルダだけ。docs を展開すると level 2、deep の中が level 3。空のフォルダは「空のフォルダ」。リンクは aria-expanded がなく、読みに行かない。折りたたむと中身が消える。画像は 01-empty.png、02-tree-collapsed.png、03-tree-expanded.png |
| explorer-open.json | a.md、b.txt をクリック。img.png と notes.json を押す。b.txt を編集して a.md を押し、確認をキャンセル、もう一度押して「保存しない」 | 開いたファイルが aria-current。a.md には .cm-md-h1 があり、b.txt にはない（見出し風の行と本文の行が同じ大きさと太さ）。開けないファイルを押しても doc-title は変わらず、bridge の open は 2 回のまま。未保存のときは alertdialog が出て、キャンセルで b.txt と未保存マークが残り、「保存しない」で a.md が開く。画像は 01-md-open.png、02-txt-open.png、03-disabled-item.png、04-discard-confirm.png |
| explorer-keyboard.json | Archive にフォーカスして、下、右、右、左、左、End、Home、下 4 回、Enter。img.png で Enter | 各キーの結果の位置（focused）と aria-expanded が期待どおり。Tab で入る項目は 1 つ。a.md が Enter で開き、本文にフォーカス。img.png は Enter でも開かない。画像は 01-keyboard-focus.png |
| explorer-restore.json | seed の session.lastFolder から起動し、docs を展開して reload | 起動時にフォルダ名が notes で、docs は折りたたまれている。reload 後も復元され、トーストは出ない |
| explorer-restore-missing.json | 存在しないフォルダが session.lastFolder の状態で起動 | 未選択の表示（sidebar-empty、open-folder）に戻り、トーストに「前回のフォルダを開けませんでした」。restore-failure と retry-folder が出る。本文は使え、session.lastFolder は消えずに残る。画像は 01-missing.png |
| explorer-many.json | 5003 件のフォルダを展開 | 「ほか 3 件」の行（aria-disabled）。項目は 5002 行（フォルダ、readme.md、先頭 5000 件）。item-05000.md はあり、item-05001.md はない。画像は 01-more-row.png |
| explorer-dark.json | ダークで、前回の文書（b.txt）とフォルダが復元された状態で起動し、docs を展開、a.md をクリック | 文書とフォルダが両方復元される。b.txt が強調され、灰色の項目が読める。画像は 01-dark-tree.png、02-dark-md.png |
| explorer-create.json（-dark あり） | 新しいファイルのボタン、区切り文字を含む名前、「idea」、項目の右クリックから新しいフォルダ、空き領域のメニュー、Esc、ボタンを Enter | 入力欄がフォーカスされ、不正な名前は aria-invalid と理由が出て何も作られない。idea.md が作られて開く。メニューは項目で 7 つ（本体の 6 つ（R15 で切り取りと貼り付けが入った）と、同梱の部品の「パスをコピー」）、空き領域で 3 つ（作成 2 つと貼り付け）。作ったフォルダは展開・選択。画像は 01-invalid-name.png、02-created-and-opened.png、03-context-menu.png（ダークは -dark 付き） |
| explorer-rename.json（-dark あり） | a.md を開いて追記、F2 で renamed.md、保存。docs を開いた guide.md を右クリックで docs の名前変更 | 選択が [0, 1]。上部バーが renamed.md、未保存マーク・本文・監視・lastPath・草稿のパスが新しいパス。保存は新しいパスだけに書かれる。フォルダの名前変更でも guide.md が追従。画像は 01-rename-input.png、02-after-rename.png、03-after-folder-rename.png |
| explorer-trash.json（-dark あり） | b.txt で Delete、Esc、Delete して確定。未保存の guide.md を含む docs を右クリックで移す | 確認は alertdialog でフォーカスはキャンセル。Esc では何も起きない。確定で消え、選択は c.md。docs を移すと競合バーが出て本文が残る。画像は 01-confirm-trash.png、02-trashed-open-document.png |
| explorer-external.json | docs を展開し、外部でファイル・フォルダを足す・消す、docs ごと消す | 操作なしでツリーに反映され、展開は保たれる。watchedFolders がルートと展開中のフォルダ。docs が消えると展開と監視も外れる。トーストなし。画像は 01-external-changes.png |
| explorer-copy-path.json | 同梱の部品が読み込まれた既定の構成で、a.md を開き、Mod+Alt+C、確認の画面で「許可する」。docs を右クリックして「パスをコピー」。設定画面で「取り消す」 | 初回は permission-dialog が出て、許可するまで clipboard は空。許可後に /work/notes/a.md が入り、トースト。メニューは 7 項目と区切り 1 つで、docs を選ぶと /work/notes/docs が入る。設定画面の「部品の権限」に結果が出て、取り消すと「決めた権限はありません。」になり、保存された決定が空になる。画像は 01-permission-dialog.png、02-copied-toast.png、03-context-menu.png、04-settings-permissions.png |
| explorer-restore-retry.json（-dark あり） | 存在しない前回のフォルダで起動し、再試行、フォルダができた後に再試行 | restore-failure に「前回のフォルダ「notes」を開けませんでした」、retry-folder と open-folder。記録は残る。再試行でツリーが出る。画像は 01-restore-failed.png、02-retry-opened.png |

| explorer-move.json（-dark あり） | b.txt をフォルダ empty の上まで引いて Esc で取り消す。b.txt を閉じたフォルダ other の上で止めてから落とす。c.md をファイルの行 docs/guide.md に落とす。docs/memo.md をツリーの空いている所に落とす。docs を自分の中の docs/deep の上まで引く | Esc の取り消しでは moveCalls が 0。other は 700ms 止まると開いてから、その中へ b.txt が移り、移した項目が選ばれる。ファイルの行への落下は docs/c.md、空いている所への落下はルートの memo.md。自分の中への移動は bridge も呼ばれず、強調（data-drop-target）もない。画像は 01-drag-over-folder.png、02-hover-opens-folder.png、03-drag-over-root.png、04-drag-into-itself.png、05-final.png（ダークは -dark 付き） |
| explorer-cut-paste.json（-dark あり） | b.txt にフォーカスして Mod+X、docs にフォーカスして Mod+V。a.md を切り取って Esc。c.md、入れ子の guide.md、空き領域を右クリックして、切り取りと貼り付けを選ぶ | 印（data-cut、aria-label に「切り取り済み」）が付き、moveCalls は 0、clipboard も空。Mod+V で docs/b.txt へ移り、印が外れる。Esc で印が外れる。メニューは最上位のファイルの行で 7 項目（本体の 6 つと「パスをコピー」。印がないあいだ「貼り付け」は aria-disabled）、入れ子の行で 6 項目、空き領域で 3 項目。空き領域の「貼り付け」で guide.md がルートへ移る。画像は 01-cut-mark.png、02-context-menu-paste.png |
| explorer-move-conflict.json（-dark あり） | a.md を同じ名前のある other に引く。Esc、もう一度引いて「両方とも残す」。c.md を引いて「置き換える」。other/keep.md を開いてから、ルートの keep.md を other へ引く | 確認が出て、メッセージが「“a.md” という名前の項目が “other” にすでにあります。」、既定のフォーカスは「両方とも残す」、最初は fail で試している。Esc では何も移らない。両方とも残すは other/a 2.md、置き換えは既存の other/c.md が trashed に入って移した内容になる。開いている文書の keep.md への置き換えは aria-disabled で理由が出て、押しても何も起きない。画像は 01-conflict-dialog.png、02-replace-blocked.png |

```
node .pi/skills/verify-mydocuments/scripts/drive.mjs --run-id <run-id> --scenario .pi/skills/verify-mydocuments/features/scenarios/explorer-tree.json
node .pi/skills/verify-mydocuments/scripts/drive.mjs --run-id <run-id> --scenario .pi/skills/verify-mydocuments/features/scenarios/explorer-open.json
node .pi/skills/verify-mydocuments/scripts/drive.mjs --run-id <run-id> --scenario .pi/skills/verify-mydocuments/features/scenarios/explorer-keyboard.json
node .pi/skills/verify-mydocuments/scripts/drive.mjs --run-id <run-id> --scenario .pi/skills/verify-mydocuments/features/scenarios/explorer-restore.json
node .pi/skills/verify-mydocuments/scripts/drive.mjs --run-id <run-id> --scenario .pi/skills/verify-mydocuments/features/scenarios/explorer-restore-missing.json
node .pi/skills/verify-mydocuments/scripts/drive.mjs --run-id <run-id> --scenario .pi/skills/verify-mydocuments/features/scenarios/explorer-many.json
node .pi/skills/verify-mydocuments/scripts/drive.mjs --run-id <run-id> --scenario .pi/skills/verify-mydocuments/features/scenarios/explorer-dark.json
node .pi/skills/verify-mydocuments/scripts/drive.mjs --run-id <run-id> --scenario .pi/skills/verify-mydocuments/features/scenarios/explorer-create.json
node .pi/skills/verify-mydocuments/scripts/drive.mjs --run-id <run-id> --scenario .pi/skills/verify-mydocuments/features/scenarios/explorer-create-dark.json
node .pi/skills/verify-mydocuments/scripts/drive.mjs --run-id <run-id> --scenario .pi/skills/verify-mydocuments/features/scenarios/explorer-rename.json
node .pi/skills/verify-mydocuments/scripts/drive.mjs --run-id <run-id> --scenario .pi/skills/verify-mydocuments/features/scenarios/explorer-rename-dark.json
node .pi/skills/verify-mydocuments/scripts/drive.mjs --run-id <run-id> --scenario .pi/skills/verify-mydocuments/features/scenarios/explorer-trash.json
node .pi/skills/verify-mydocuments/scripts/drive.mjs --run-id <run-id> --scenario .pi/skills/verify-mydocuments/features/scenarios/explorer-trash-dark.json
node .pi/skills/verify-mydocuments/scripts/drive.mjs --run-id <run-id> --scenario .pi/skills/verify-mydocuments/features/scenarios/explorer-external.json
node .pi/skills/verify-mydocuments/scripts/drive.mjs --run-id <run-id> --scenario .pi/skills/verify-mydocuments/features/scenarios/explorer-copy-path.json
node .pi/skills/verify-mydocuments/scripts/drive.mjs --run-id <run-id> --scenario .pi/skills/verify-mydocuments/features/scenarios/explorer-restore-retry.json
node .pi/skills/verify-mydocuments/scripts/drive.mjs --run-id <run-id> --scenario .pi/skills/verify-mydocuments/features/scenarios/explorer-restore-retry-dark.json
node .pi/skills/verify-mydocuments/scripts/drive.mjs --run-id <run-id> --scenario .pi/skills/verify-mydocuments/features/scenarios/explorer-move.json
node .pi/skills/verify-mydocuments/scripts/drive.mjs --run-id <run-id> --scenario .pi/skills/verify-mydocuments/features/scenarios/explorer-move-dark.json
node .pi/skills/verify-mydocuments/scripts/drive.mjs --run-id <run-id> --scenario .pi/skills/verify-mydocuments/features/scenarios/explorer-cut-paste.json
node .pi/skills/verify-mydocuments/scripts/drive.mjs --run-id <run-id> --scenario .pi/skills/verify-mydocuments/features/scenarios/explorer-cut-paste-dark.json
node .pi/skills/verify-mydocuments/scripts/drive.mjs --run-id <run-id> --scenario .pi/skills/verify-mydocuments/features/scenarios/explorer-move-conflict.json
node .pi/skills/verify-mydocuments/scripts/drive.mjs --run-id <run-id> --scenario .pi/skills/verify-mydocuments/features/scenarios/explorer-move-conflict-dark.json
```

Tauri の窓（secondary）。作成・名前の変更・ゴミ箱は窓へのキー入力・クリックが要るので撮らない（窓はボタンとツリーの描画だけ）。run ディレクトリの中に見本のフォルダを作り、`tauri.mjs start --folder <見本フォルダ> --prefs <sidebarOpen: true の設定>` で起動して `tauri.mjs shot` で撮る。実際のファイルシステムからツリーが復元されることの確認で、キー入力とクリックは送らない。

## Gotchas

- フォルダ選択ダイアログは seed の folderPath が戻り値の代わり。null だとキャンセル扱いで何も起きない。実際のネイティブのダイアログと、Rust 側の許可（登録したフォルダの配下だけ読める、.. やリンクで外へ出られない）は、この Skill では確かめない（src-tauri の cargo test が正本）。
- メモリ bridge は、再読み込みをまたいで session.lastFolder だけを sessionStorage に保つ（lastPath は保たない）。実アプリの「次回の起動」の代わり。
- bulkFolders の項目は中身のない仮想のファイルで、開くと見つからない。件数の表示の確認用。
- aria-disabled の要素は、Playwright の通常の click が「操作できない」として待ち続ける。シナリオでは force: true を付ける。利用者は押せる（押しても何も起きないことの確認）。
- 行の矢印の回転は 0.12 秒かかる。クリック直後の screenshot では、途中の角度が写る（Reduced Motion ではすぐ最終の形）。
- ツリーの項目は li で、展開中は子の行を内側に含む。li の textContent や aria の名前に子の名前が混ざらないよう、li には aria-label（ファイル名）が付いている。名前で指すときは exact にする。
- 「ほか N 件」と「読み込み中…」「空のフォルダ」は treeitem（aria-disabled）で、testId は tree-note。ファイルの testId は tree-item。
- ネイティブ側の並べ替え（5000 件の切り捨ての基準）と画面の並べ替え（Intl.Collator）の細かい順序は違うことがある。メモリ bridge は画面側と同じ Collator を使うので、この差は再現しない。
- 作成・名前の変更・ゴミ箱・外部の変更の結果は、メモリ bridge の仮想ファイルシステム（window.__mdeE2E.files、trashed、renames、watchedFolders）で確かめる。本物のゴミ箱、本物のファイルの監視、シンボリックリンクと登録外のパスの拒否は、この Skill では確かめない（src-tauri の cargo test が正本。本物のゴミ箱は CI だけ IME_TEST_REAL_TRASH=1 で動く）。
- メモリ bridge の同名の判定は、大文字小文字を区別しないファイルシステム（macOS、Windows）の振る舞い。区別する FS での扱いは Rust 側の判断。
- ツリーの右クリックは click に button: right。空き領域は testId explorer-tree-area に position を付ける（項目が少ないとき、下のほうの y を指す）。キー入力で F2、Delete は、項目に focus してから press する（入力欄の中のキーはツリーに届かない）。
- 外部の変更の通知は、監視しているフォルダ（watchedFolders）のときだけ届く。展開していないフォルダへの externalWrite は、通知なし。
- 名前の変更の直後は、開いている文書のディスクの確認が一度走る。直後の保存の操作は、その確認が終わるまで受け付けない（expect の timeout で待つ）。
- 前回のフォルダの再試行は、memory bridge では files にそのフォルダの下のファイルを externalWrite で置くと「開けるようになった」状態になる。
- 同梱の段 2 の部品は、e2e のビルドでも既定で（seed に isolated がなくても）読み込まれる（本番と同じ構成。iframe があり、ツリーの最上位の項目のメニューは本体の 6 つのあとに「パスをコピー」が付く）。外すのは、seed の isolated に bundled: false を書いたときだけ（isolated には plugins が要る。空の配列でよい）。部品が動き出す（最初の描画のあと）まで、window.__mdeE2EIsolatedTrace に ready（plugin が copy-path）が出るのを待ってからキーを押す。
- クリップボードはメモリ bridge の記録（window.__mdeE2E.clipboard）。実際の OS のクリップボードには書かない。権限の保存は window.__mdeE2E.savedPluginPermissions（再読み込みをまたいで保たれるのは sessionStorage の分。seed の pluginPermissions は、保存済みの決定の代わり）。
- 確認の画面は、宣言した権限のうち決めていないものをまとめて 1 回聞く。「許可する」「許可しない」は聞いた権限すべてに保存される。許可後に部品が止まっていないことは、trace に stopped がないこと（コンソールの「部品「…」を止めました」もない）で確かめる。
- Mod+Alt+C は、Playwright の press で Alt を付けて送る（macOS の Option の文字合成は再現しない。物理キー code で判定する経路は単体テストが正本）。AltGr の入力は、press では作れない（window へ KeyboardEvent を dispatch して確かめる。tests/e2e/copy-path.spec.ts）。
- 移動のドラッグは、drive.mjs の drag の step（マウスの down / move / up。from の行を押し、to の上まで動かし、hold の間止まり、cancel なら Esc を押してから離す）で行う。toPosition は to の左上からの座標で、ツリーの空いている所（testId file-tree の下のほう）を指すのに使う。画面の外にある行（大量の項目の下など）は、boundingBox が画面の外の座標になるので、引く行には画面に見えているものを選ぶ。
- ドラッグの途中の強調は、data-drop-target（フォルダの行の li）、ツリーの data-drop-root、引いている間の data-dragging で読む。hold の間にスクリーンショットを撮らないと、落とした後は強調が消えている。
- 同じ名前の判定は、メモリ bridge では大文字小文字を区別しないファイルシステムのつもり。window.__mdeE2E の moves（別のフォルダへ移した項目。同じフォルダへの移動と失敗は含まない）、moveCalls（呼び出しの記録。conflict は最初が fail）、trashed（置き換えで、ゴミ箱へ移った既存の項目）で結果を読む。失敗を起こすのは failNext.moveEntry。本物のゴミ箱への置き換え、本物のファイルシステム（APFS の大文字小文字、リンク、別のディスク）は、この Skill では確かめない（src-tauri の cargo test が正本）。
- 切り取りと貼り付けのキーは、行（role treeitem）にフォーカスがあるときだけ効く。focus してから press する。OS のクリップボードは、メモリ bridge の記録（clipboard）にも書かれないので、clipboard が空のままであることが、キーが奪われたことの確認になる。名前の入力欄と本文の Mod+X、Mod+V を実際に押すと、ブラウザが本物のクリップボードに書いてしまうので、この Skill のシナリオでは押さない（Playwright の e2e は、キーイベントを dispatch して、既定の動作が妨げられないことだけを見る）。
- ツリーの最上位でない行（入れ子の行）の右クリックメニューには、同梱の部品の項目（パスをコピー）が出ない（nodes を最上位だけから探す既存の挙動。R15 の対象外で、変えていない）。メニューの項目数を数えるシナリオは、最上位の行で数える。部品の項目が並ぶのは、trace に menu が出てから。
