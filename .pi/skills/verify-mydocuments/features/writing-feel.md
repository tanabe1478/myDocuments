# 書き心地

## Sub-features

- FEEL-1: 長文の末尾で書き足しても、カーソルは表示領域の下 25% より上に保たれる。上へ戻るときも、上 25% より下に保たれる（先頭付近を除く）。
- FEEL-2: 空行の高さは段落間隔で決まる（既定 0.6 行、0 は 4px、最大 3 行）。行と行の間に隙間（margin）はない。
- FEEL-3: リスト、番号付き、引用、タスクの折り返した行は、1 行目の本文の左端に揃う（ぶら下げインデント）。記号のない段落は字下げされない。記号を見せている行（設定が「常に表示」、またはカーソルのある行）でも、隠している行（既定）でも成り立つ。
- FEEL-4: Tab と Shift+Tab は、リストと引用の行でインデントを増減する。複数行を選んでいればそろって動く。リストでも引用でもない行では何も入れない。
- FEEL-5: Esc の直後の Tab は、本文の外へフォーカスを移す（Shift+Tab は逆向き）。Esc の後に別のキーを押せば、Tab はまたインデントになる。
- FEEL-6: ArrowDown と ArrowUp は、見出し、空行、リスト、引用、コードフェンスのどこでも、1 回で全行を 1 行ずつ動く。行を飛ばさず、止まらない。
- FEEL-7: 範囲選択中の ArrowUp と ArrowDown は、選択の端へ畳む。Shift 付きは anchor を残して head だけを 1 行ずつ動かす。
- FEEL-8: リストの項目で Enter を押すと、次の項目を続ける（記号、番号付きは次の番号、タスクは `- [ ] `、入れ子はインデントを保つ。引用の中のリストも）。項目の間に空行のあるリスト（loose list）でも、既定（設定画面「編集」の「リストの継続」が「空行を入れない」）では空行を入れない。「リストの形に合わせる」にすると、次の項目の前にも空行を入れる。変更は文書を開き直さずに効き、保存され、再読み込み後も保たれる。空の項目での Enter はリストを終える（入れ子は 1 段戻す）。項目の途中での Enter は後半を次の項目にする。.txt では続けない。空行のないリスト（tight list）の空の 2 項目目での Enter も、既定では空行を入れず、空の項目の記号を取り除いてリストを終える（「リストの形に合わせる」では、これまでどおり空行を入れてリストを loose にする）。
- FEEL-9: 記号の表示。既定（設定画面「外観」の「記号の表示」が「カーソルのある行だけ」）では、カーソルのない行の記法が隠れる（見出しの #、箇条書きは • に置き換え、タスクはチェックボックスの形、リンクの []() と自動リンクの <>、強調・取り消し線・インラインコードの記号、引用の >）。カーソルのある行と選択にかかる行は記号が見える。コードフェンス、frontmatter、参照リンク、画像、番号付きの番号は今のまま。文書のテキストは変わらない。「常に表示」にするとすぐ今までと同じ見た目になり、保存され、再読み込み後も保たれる。.txt には効かない。
- FEEL-10: リンクを開く。⌘+クリック（macOS）、Ctrl+クリック（Windows と Linux）で、リンクの文字・URL・自動リンク・裸の URL を既定のブラウザで開く。開けるのは http と https だけで、それ以外は開かず、トースト「このリンクは開けません」。普通のクリックはカーソルを置くだけ。修飾キーを押している間、リンクの上でポインタの形が変わる。カーソルは動かない。
- FEEL-11: タスクの切り替え。記号を隠した行のチェックボックスを、修飾キーなしの左クリックすると、文書の `[ ]` と `[x]`（`[X]` を含む）の 1 文字だけが切り替わる。カーソル・選択・スクロール位置は動かず、その行は隠したまま。Undo 1 回で戻り、Redo でやり直せる。入れ子、引用の中、`*` と `+` のタスクも同じ。ポインタは pointer、role は checkbox で aria-checked が状態に合う。本文のクリック、カーソル行の `[ ]`、設定「常に表示」、修飾キー付き、右・中クリック、IME の変換中は切り替えない。すばやく 2 回クリックすると元に戻り、語は選択されない。キーボードでの切り替えはない。
- FEEL-12: 表の表示（ADR-006）。既定（「記号の表示」が「カーソルのある行だけ」）では、カーソルが表の外にあるとき、トップレベルの Markdown の表が表の形で表示される（見出しは th、本文は td。区切りの行は出ない。配置は区切りの行の `:` に従い、列の数は見出しのセルの数。空のセルは列に数え、足りないセルは空、余るセルは出ない。セルの中の `\|` は `|` と表示。強調・取り消し線・コード・リンク・自動リンク・裸の URL は、隠した行と同じ見た目で、画像・参照リンク・HTML は原文の文字のまま）。選択が表に触れる（端の一致を含む）と、その表だけが原文に戻る。表をクリックすると、クリックしたセルの中身の末尾にカーソルが入る（セルの外は一番近いセル。Shift+クリックは選択を伸ばす。右・中クリックは何もしない。⌘/Ctrl+クリックと Alt+クリックも同じで、リンクは開かない）。上下キー（mac は Ctrl-n / Ctrl-p も）で、表の上下の行から表に入れる（表を飛ばさない）。検索で表の中の一致に移ると原文になる。表示の切り替え、出入り、Tab の移動で、文書のバイト列は変わらず、Undo の履歴に何も積まない。「常に表示」、.txt、引用やリストの中の表は、原文のまま。列の幅は FEEL-15（セルの最小幅と横スクロール）。色は明暗のテーマに追従する。
- FEEL-13: 表の中の Tab。原文の表の中で、選択が空のとき、Tab は次のセルの中身の頭、Shift+Tab は前のセルの中身の頭へカーソルを移す（区切りの行を飛ばし、行をまたぎ、空のセルにも止まる。外側の `|` のない行の最初のセルは行頭から数える）。最初のセルで Shift+Tab は、動かずにキーを受ける（最後のセルでの Tab は FEEL-14）。設定「常に表示」でも効く。Esc の直後の Tab は本文の外へフォーカスを移す。範囲を選んでいるとき、表の外、引用の中の表は、これまでの字下げのまま。
- FEEL-14: 表の入力の支援（ADR-006 の R12）。キーを押したときだけ本文を変え、1 回の Undo で押す前の文書と選択に戻る。設定「記号の表示」によらず、.txt では働かない。(a) 原文の表の行（見出し、区切り、本文）での Enter は、本文の行の下（見出しと区切りの行では、区切りの行の下）に、見出しの列の数の空の行 `|  |  |` を足し、カーソルをその最初のセルの中身の位置（行頭から 2 文字目）に置く。セルの途中でも文字を分けない。表の最後の行が、セルがすべて空の本文の行のときの Enter は、その行を空の行にして表から出る（最後の行でない空の行は、普通に行を足す）。(b) まだ表でない `| 名前 | 数 |` の行（前後の空白を除いて `|` で始まり `|` で終わる、親が Document の段落の最後の行）の末尾での Enter は、区切りの行 `| --- | --- |` と空の行を足して表にし、カーソルを空の行の最初のセルに置く。行の途中、次の行が区切りの行、コードブロック、HTML ブロック、frontmatter、引用、リストの中は、普通の改行。(c) 原文の表の最後の行（本文がなければ見出しの行）の最後のセルでの Tab は、表の最後に空の行を足して最初のセルへ移る。最初のセルの Shift+Tab、Esc の直後の Tab、表の外、範囲選択は今のまま。IME の変換中の Enter と Tab では何もしない。表の外の Enter、リストの継続、Shift+Enter、Mod+Enter は今のまま。
- FEEL-15: 表の列幅と横スクロール（ADR-006「列幅（Issue #3）」）。表示中の表のセル（th と td）は、中身 6em と左右の padding（約 7.4em）以上の幅を持ち、日本語の短い列が 1〜2 文字に潰れない（見出し「ブロックタイプ」は 2 行以内、コードの語 `text` `tool_use` `tool_result` `thinking` は語の途中で折れない）。折り返しは word-break: normal と overflow-wrap: break-word（CodeMirror の .cm-lineWrapping から継承される word-break: break-word は、列の最小の幅を 1 文字ほどにするので、normal で打ち消す）。日本語の文は文字の間で折り返す。長い URL や長い英字の語は折れず、表が本文の幅より広くなって囲みが横にスクロールする。本文の幅に入る表は内容に合わせた幅のまま（スクロールバーなし）。最小幅を並べても入らない表（列が多い）は、表の囲み（.cm-md-table。overflow-x: auto）だけが横にスクロールし、ページ（エディタ全体）は横に動かない。トラックパッドの横スクロールとスクロールバーのドラッグで表が動き、そのときカーソルは動かず、表は原文にならない。スクロールした後のセルのクリックは、見えているセルの中身の末尾にカーソルを置く。スクロールバーの有無で、表の下の行のクリックと上下キーはずれない。文字の大きさの設定（em）と明暗のテーマ（スクロールバーのつまみは --md-color-border）に追従する。
- FEEL-16: コードブロックの色（ADR-004 追補（コードブロック））。開きのフェンスの情報文字列の最初の語から言語を選び、コードの中に色が付く。選ぶ順は、名前と別名の完全一致（`ts`、`python`、`Dockerfile`。大文字小文字を区別しない）、短い名前の表（`py`、`rs`、`md`、`golang`、`kt`、`ps1` など）、ファイル名か拡張子（`main.py`）、`言語:ファイル名`（`python:main.py`、`:main.py`）。`text`、`txt`、`plain`、`plaintext`、分からない名前、情報文字列なしには色が付かない（あいまい照合はしない）。コードの既定の見た目（等幅、0.92em、コードの色）は、言語が分かったブロックでも、色の付かない文字（変数名、記号）まで、言語なしのブロックと同じ。色は 7 分類（キーワード、文字列、コメント、数値、関数名、型、属性）で、CSS 変数 `--md-code-*` が明暗のテーマに追従し、フェンスの帯の上で AA を満たす。言語は使うときに読み込まれ、読み込みの前と失敗のときは色なしで、表示と入力は止まらない。.txt には何も起きない。本文の外には色が付かない。
- FEEL-17: 閉じのフェンスと Enter（ADR-004 追補（コードブロック））。開きのフェンス（` ``` `、`~~~`、4 つ以上の `` ` ``。任意の情報文字列）の行の末尾で Enter を押すと、そのコードブロックに閉じのフェンスがなければ、空の行と同じ記号・同じ長さの閉じのフェンスが足され、カーソルは空の行に入る（引用の中は `> `、リストの中は項目の本文の幅の空白を、足す 2 行に付ける）。閉じがあるときは、今のとおりの改行。コードの中の Enter は改行で、Enter を 2 回押しても抜けない。重複の防止: コードの最後の行で Enter を押し、閉じのフェンスを自分で打って Enter を押すと、元の閉じのフェンス（新しい開きのフェンスになった行）が取り除かれ、カーソルがコードブロックの後ろに入る（後ろに別のコードブロックがあっても。きちんと閉じた、隣り合う 2 つのコードブロックは触らない）。1 回の Undo で戻る。IME の変換中、範囲選択、複数の選択、読み取り専用では何も足さない。リストの継続、表の Enter と Tab は今のまま。.txt では働かない。
- FEEL-18: コードブロックから抜ける（ADR-004 追補（コードブロック））。コードブロックの中（フェンスの行を含む）で ⌘+Enter（Windows と Linux は Ctrl+Enter）を押すと、閉じのフェンスの次の行へ移る。次の行がなければ空の行が足される。閉じのないコードブロックでは、最後の行の後ろに閉じのフェンスを足してから抜ける。↓ のキーでも閉じのフェンスを越えられる。コードブロックの外の ⌘/Ctrl+Enter は今のまま（空行を足す）。
- FEEL-19: 言語名の補完（ADR-004 追補（コードブロック））。開きのフェンスの行の、情報文字列の最初の語（`:` の前まで）の位置でだけ、補完の一覧（`.cm-tooltip-autocomplete`）が出る。` ``` ` の直後に 1 文字打つと出て、Ctrl+Space（mac は Alt+` と Alt+i も）でも出る。名前、別名、短い名前に完全一致した語には、打ち始めでは出ない。候補は language-data の名前と別名と短い名前の表。選ぶと最初の語だけが置き換わり、`:ファイル名` は残る。一覧の表示中の Enter と Tab は補完が受け、表示していないとき（と、選んだ候補がいまの語と同じとき）は今のとおり。補完を開いてから 75ms は、Enter と Tab を受けない。Esc で閉じる。閉じのフェンスの行、コードの中、本文のほかの所では出ない。一覧は、カーソルが画面の上端や下端の近くにあっても、画面の中に出る。見た目は明暗のテーマに追従し、動き（遷移とアニメーション）はない。

## How to get to it (user POV)

- 本文をクリックして、キーボードで入力・移動する。専用のボタンはない。
- 段落間隔は設定画面の「段落間隔」（Mod+, か設定ボタン）。既定値は起動時に自動で反映される。
- リストの項目で Enter。設定は設定画面（Mod+, か設定ボタン）の「編集」の節の「リストの継続」（ラジオ「空行を入れない」「リストの形に合わせる」）。
- Tab、Shift+Tab、Esc、ArrowUp、ArrowDown、Shift+ArrowUp、Shift+ArrowDown、Mod+Home、Mod+End。
- 記号の表示は設定画面（Mod+, か設定ボタン）の「外観」の節の「記号の表示」（ラジオ「カーソルのある行だけ」「常に表示」）。隠す・見せるは、カーソルや選択を動かすだけで切り替わる。
- リンクを開く操作は、本文のリンクの上での Mod+クリック（macOS は ⌘、Windows と Linux は Ctrl）。drive の click の modifiers: ["ControlOrMeta"] がその OS の Mod キーになる。
- チェックボックスの切り替えは、記号を隠した行のチェックボックス（.cm-md-task）のクリック。drive の click に css で `.cm-line:nth-child(n) .cm-md-task` を指定する。切り替えの Undo は ControlOrMeta+z。
- 表は、表の外にカーソルがあるだけで表の形になる（専用の操作はない）。表のクリック、上下キー（Mac は Ctrl-n / Ctrl-p も）、検索（Mod+f）で表に入る。原文の表の中で Tab と Shift+Tab。drive の click に css で `.cm-md-table tbody tr:nth-child(n) td:nth-child(m)` を指定する。
- 表の横スクロールは、本文の幅に入らない表（列が多い表）の上で、トラックパッドの横スクロールかスクロールバーのドラッグ。専用の操作はない。drive には wheel の step がないので、シナリオは表の囲みの scrollLeft を eval で動かして代わりにする（実際のホイールとスクロールバーのドラッグは tests/e2e/table-layout.spec.ts）。
- 表の入力は、本文の中で、表の行や見出しの行（`| 名前 | 数 |`）の末尾へカーソルを置いて Enter、表の最後のセルで Tab。専用のボタンはない。カーソルは、ArrowDown と End で行の末尾へ動かす。
- コードブロックは、本文の中で ` ``` ` と言語名（`ts`、`main.py`、`python:main.py`）を打つ。色は、言語の読み込みが済むと付く（別ファイルの読み込み）。閉じのフェンスは、開きのフェンスの行の末尾で Enter。抜けるのは、コードブロックの中で Mod+Enter（macOS は ⌘、Windows と Linux は Ctrl。drive の press は ControlOrMeta+Enter）。専用のボタンはない。
- 言語名の補完は、` ``` ` の後ろで文字を打つか、Ctrl+Space。drive の press は Control+Space。一覧は `.cm-tooltip-autocomplete`、選択中の候補は `li[aria-selected]`。
- 折り返しは窓の幅と本文の最大幅で決まる。ぶら下げインデントはリスト等の行を書くだけで働く。

## Driving it with Playwright（メモリ bridge）

Preconditions: Launch 済みで Doctor が全 PASS。カーソルや選択は、ページ内の editor（window.__mdeE2E.editor）の onSelectionChange で追う（シナリオの eval step が設定する）。ぶら下げインデントのシナリオは、折り返した行をすべて描画させるため viewport を 1280x2600 にしてある（シナリオの viewport で指定済み）。

| シナリオ | user action | 観測できる結果 |
|---|---|---|
| feel-caret-position.json | 80 行の文書の末尾で 10 行書き足し、ArrowUp ×30 | 各書き足しの後、カーソルの下端が表示領域の下端から高さの 25% 以上。上へ戻るとき上端から 25% 以上 |
| feel-paragraph-spacing.json | 段落間隔を既定、2、0、3 に変更 | 空行（.cm-line の 2 行目）の高さが 20.5、68.4、4、102.6（px） |
| feel-hanging-indent.json | 設定「常に表示」で、長文のリスト・番号付き・引用・タスクを開く | 9 種類の記号の行で、折り返した行の左端が 1 行目の本文の左端と ±2px 以内。記号なしの段落は字下げなし |
| feel-hanging-indent-hidden.json | 既定（カーソルのある行だけ）で同じ文書を開き、カーソルを末尾の段落に置く（記号を隠した状態） | 9 種類の行で、折り返した行の左端が、1 行目の本文（• やチェックボックス、番号の後ろ）と ±2px 以内。引用だけの行は字下げしない（本文が行の左端から始まる）。箇条書きは • に置き換わる。画像は hanging-indent-hidden.png |
| feel-live-markup.json、feel-live-markup-dark.json | 見出し・強調・リスト・タスク・引用・リンク・フェンスを含む文書を、ライトとダークで開く。末尾へ移動、先頭から 2 行下へ、さらに 4 行下から Shift+ArrowDown ×5。Mod+, で「記号の表示」を「常に表示」にして、「カーソルのある行だけ」へ戻す | 既定では、カーソルのない行の記法が隠れ、• とチェックボックス 2 つ（うち 1 つが完了）が出る。カーソルを動かした行だけ記法が見え、選択にかかる行は全部見える。「常に表示」では全行の記号が見え、保存された設定の markupDisplay が always。戻すとすぐ隠れ、文書のテキストは変わらない。画像は hidden.png、cursor-line.png、selection.png、settings-markup-display.png、always.png |
| feel-task-toggle.json、feel-task-toggle-dark.json | タスク（入れ子と引用の中を含む）のある文書を、ライトとダークで開き、末尾へ移動。1 つ目のチェックボックスをクリック。ライトは、続けて保存、別の 3 つをクリック、Undo、同じチェックボックスの 2 回クリック、本文のクリック | 4 つのチェックボックス（うち 1 つが完了）。ポインタは pointer、role は checkbox、aria-checked は false。クリックで文書の `[ ]` が `[x]` になり（その 1 文字だけ）、選択の通知は 0 回、行の表示は隠したまま。保存した本文は切り替え後のもの。完了は未完了に、入れ子と引用の中も切り替わり、Undo 1 回で最後の切り替えだけが戻る。2 回クリックで元に戻る。本文のクリックは切り替えず、カーソルを置いてその行の記号が見える。画像は before-click.png、after-click.png（ダークは feel-task-toggle-dark の同名）、body-click.png（ライトのみ） |
| feel-task-toggle-typewriter.json | タイプライターモード ON、viewport 1280x700 で、60 段落の後にタスクのある文書を開き、カーソルは先頭のまま末尾へスクロールして、1 つ目と 2 つ目のチェックボックスをクリック | 切り替わり、scrollTop は 2 回のクリックの前後で変わらない（タイプライターモードがカーソル行へ戻さない）。チェックボックスは画面に残る。画像は before-click.png、after-click.png |
| feel-link-open.json | インラインリンク・自動リンク・裸の URL・相対パス・javascript: のリンクを、Mod+クリック。最後に普通のクリック | window.__mdeE2E.openedUrls に http/https の 3 つだけが入る。カーソルは動かない。相対パスはトースト「このリンクは開けません」。普通のクリックは開かず、その行の記法が見える。メモリ bridge は URL を記録するだけで、ブラウザは開かない。画像は relative-link-toast.png、plain-click.png |
| feel-tab-indent.json | リスト、番号付き、引用、複数行選択、通常の段落で Tab と Shift+Tab、Esc と Tab | 本文が「- a」「  - b」と変わり、番号付きは「   2. b」、引用は「> > q」。通常の段落は不変でフォーカスも本文のまま。Esc → Tab で char-count、Esc → Shift+Tab で settings-button にフォーカス |
| feel-vertical-motion-default.json、feel-vertical-motion-spacing0.json、feel-vertical-motion-spacing3.json | 30 行の文書（見出し、空行、リスト、引用、フェンス）を、段落間隔 0.6、0、3 で、先頭から ArrowDown ×29、末尾から ArrowUp ×29 | 行の間の隙間が 0.5px 未満。1 押下ごとにカーソルの行がちょうど 1 変わる |
| feel-list-continuation.json | 項目の間に空行のあるリストの末尾で Enter。続けて「次の項目」と入力して保存。Mod+, で「編集」の節を開き「リストの形に合わせる」にして Esc、Enter、Undo。「空行を入れない」へ戻して Enter。最後に「リストの形に合わせる」にして reload | 既定では末尾に「\n- 」だけが入り（空行なし）、保存された本文は「- 次の項目」で終わる。「リストの形に合わせる」では「\n\n- 」が入り、Undo 1 回で戻る。戻すとすぐ「\n- 」になる。保存された設定の listContinuation が preserve になり、reload 後も選ばれている。画像は before-enter.png、after-enter-tight.png、settings-editing-light.png、after-enter-preserve.png、after-enter-tight-again.png、after-reload-preserve.png |
| feel-list-continuation-dark.json | ダークで設定画面を開き、「編集」の節までスクロール | 節の見出しが「外観」「編集」の順。「リストの継続」の既定は「空行を入れない」。画像は settings-editing-dark.png |
| feel-selection-collapse.json | 5 行の文書で、選択して ArrowUp、ArrowDown、Shift+ArrowUp、Shift+ArrowDown | 選択の anchor と head の位置が、下向きの選択は ArrowDown で末尾、ArrowUp で先頭へ畳まれる。上向きの選択も ArrowUp で先頭へ畳まれる。Shift 付きは anchor が動かず head が 1 行ずつ。先頭行の ArrowUp は行頭、末尾行の ArrowDown は行末 |
| feel-table-display.json | 見出し・表（配置、空のセル、`\|`、強調・コード・リンク・取り消し線）・リストを含む文書を、ライトで開く。表の外（1 行目）から、表の最初のセルをクリック、Tab を 4 回、Shift+Tab、Mod+Home、Mod+s | カーソルが表の外のとき、表が表の形になる（th 3、td 9、2 列目は右寄せ、3 列目は中央、`\|` は縦線 1 文字、区切りの行は出ない）。クリックで表が原文になり、カーソルはりんごの末尾。Tab で、次のセル、赤いの頭、次の行の最初のセル（区切りの行を飛ばす）、空のセルの頭（左の `\|` の後ろの空白の 1 つ後ろ）。Shift+Tab で戻る。フォーカスは本文のまま。表の外へ出ると表示に戻る。physicalWrites は 0（本文は変わらない）。画像は table-display.png、table-source.png、table-after-tab.png |
| feel-table-display-dark.json | 同じ文書をダークで開き、表のセルをクリック | 表が表の形で出る。枠の色は --md-color-border（ダーク）。クリックで原文になる。画像は table-display-dark.png、table-source-dark.png |
| feel-table-layout.json、feel-table-layout-dark.json | Issue の形の 4 列の表（見出し「ブロックタイプ」「役割」「内容」「重要なルール」、1 列目はコードの語）と、10 列の表と、長い URL を含む 3 列の表のある文書を、ライトとダークで、幅 900 で開く（showScrollbars: true で、スクロールバーを描く）。viewport を 600 に。10 列の表を右端までスクロール（scrollLeft）。右端の最後のセルをクリック | 幅 900 と 600 の両方で、見出し「ブロックタイプ」は 2 行以内、4 つの語は折れず、どの列も約 7.4em（18px で 134px）以上、ページは横に動かない（HEAD は幅 600 で見出し 4 行、3 つの語が折れ、最小の列は 75px）。10 列の表は囲みが本文の幅より広く、overflow-x は auto で、右端までスクロールしてもページは動かず、カーソルは動かず、表は原文にならない。長い URL の表は、URL と長い英字の語がセルの中で 1 行（折れない）で、囲みが横にスクロールでき、word-break は normal、ページは横に動かない。右端のセルのクリックで、その表だけが原文になり、カーソルは「データの内容10」の末尾。画像は table-layout-issue-900.png、table-layout-issue-600.png、table-layout-many-scrolled.png、table-layout-many-source.png（ダークは同名に -dark） |
| feel-table-input.json | 表（| a | b |）と、まだ表でない見出しの行（| 名前 | 数 |）のある文書を開く。表の本文の行の末尾で Enter、Undo。見出しの行の末尾で Enter、「りんご」、Tab、「3」、最後のセルで Tab、空の最後の行で Enter、Mod+s、Undo | 本文の行の下に `\|  \|  \|` の空の行が足され、カーソルはその最初のセル（行頭から 2 文字目）。Undo 1 回で文書と選択が戻る。見出しの行の下に `\| --- \| --- \|` と空の行が足されて表になり、カーソルは空の行の最初のセル。セルに入力でき、最後のセルの Tab で空の行が足される。空の最後の行の Enter で、その行が空の行になって表から出て、2 つの表が表の形で出る。保存したバイト列が画面の文書と同じで、physicalWrites は 1。Undo 1 回で空の最後の行のある状態に戻る。画像は table-before-input.png、table-row-added.png、header-line.png、table-made.png、table-tab-added.png、table-exited.png |
| feel-table-always.json | 設定「常に表示」で同じ文書を開き、表の 1 行目へ移って Tab | 表は原文のまま（`.cm-md-table` は 0）。区切りの行が見える。Tab で、最初のセル、次のセル、区切りの行を飛ばして次の行の最初のセルへ。画像は table-always.png |
| feel-code-block.json | ts、main.py、text の 3 つのコードブロックのある文書をライトで開く。末尾で ` ```rs ` と打って Enter、`fn main() { let n = 1; }`、Mod+Enter、文章を打つ。ts のブロックの最後の行で Enter、` ``` ` を打って Enter | ts の `const`（キーワード）、`42`（数値）、`// note`（コメント）、main.py の `def` に、`--md-code-*` の色が付く（読み込みが済むまで待つ）。text のブロックには 7 分類の色が付かない。Enter で、本文の末尾が「` ```rs\n\n``` `」になり、カーソルは空の行、`fn` がキーワードの色。Mod+Enter で、閉じのフェンスの次の行へ出て、書いた文章はコードの帯の外。自分で閉じを打つと、元の閉じのフェンスが後ろの main.py のブロックを巻き込み、Enter で取り除かれて元の形に戻り、カーソルはブロックの後ろ。画像は code-highlight.png、closing-fence-added.png、after-exit.png、duplicate-fence-before-enter.png、duplicate-fence-after-enter.png |
| feel-code-block-dark.json | 同じ文書をダークで開く | 暗いテーマのキーワードの色（`#d49be0`）が ts と Python の両方に付く。画像は code-highlight-dark.png |
| feel-code-completion.json | 空の文書で ` ```pyt ` と打つ。一覧が出たら Enter、続けて Enter、`let n = 1`。先頭の行末で言語名を消して `typescr`、Enter。もう一度言語名を消して Control+Space、Esc | 一覧が出て、先頭の候補が python。Enter で本文が「` ```python `」になり（改行は入らない）、一覧が閉じる。次の Enter で閉じのフェンスが入る。python では `let` に色が付かない。typescript に選び直すと `let` がキーワードの色になる。Control+Space で、何も打っていなくても一覧が出て、Esc で閉じる。画像は completion-open.png、python-colors.png、typescript-colors.png、completion-ctrl-space.png |
| feel-code-completion-dark.json | 同じ操作をダークで行う | 一覧がダークの色（パネルの背景、選択中の候補）で、画面の中に出る。画像は completion-open-dark.png、python-colors-dark.png、typescript-colors-dark.png、completion-ctrl-space-dark.png |

```
node .pi/skills/verify-mydocuments/scripts/drive.mjs --run-id <run-id> --scenario .pi/skills/verify-mydocuments/features/scenarios/feel-caret-position.json
node .pi/skills/verify-mydocuments/scripts/drive.mjs --run-id <run-id> --scenario .pi/skills/verify-mydocuments/features/scenarios/feel-paragraph-spacing.json
node .pi/skills/verify-mydocuments/scripts/drive.mjs --run-id <run-id> --scenario .pi/skills/verify-mydocuments/features/scenarios/feel-hanging-indent.json
node .pi/skills/verify-mydocuments/scripts/drive.mjs --run-id <run-id> --scenario .pi/skills/verify-mydocuments/features/scenarios/feel-hanging-indent-hidden.json
node .pi/skills/verify-mydocuments/scripts/drive.mjs --run-id <run-id> --scenario .pi/skills/verify-mydocuments/features/scenarios/feel-live-markup.json
node .pi/skills/verify-mydocuments/scripts/drive.mjs --run-id <run-id> --scenario .pi/skills/verify-mydocuments/features/scenarios/feel-live-markup-dark.json
node .pi/skills/verify-mydocuments/scripts/drive.mjs --run-id <run-id> --scenario .pi/skills/verify-mydocuments/features/scenarios/feel-task-toggle.json
node .pi/skills/verify-mydocuments/scripts/drive.mjs --run-id <run-id> --scenario .pi/skills/verify-mydocuments/features/scenarios/feel-task-toggle-dark.json
node .pi/skills/verify-mydocuments/scripts/drive.mjs --run-id <run-id> --scenario .pi/skills/verify-mydocuments/features/scenarios/feel-task-toggle-typewriter.json
node .pi/skills/verify-mydocuments/scripts/drive.mjs --run-id <run-id> --scenario .pi/skills/verify-mydocuments/features/scenarios/feel-link-open.json --platform windows
node .pi/skills/verify-mydocuments/scripts/drive.mjs --run-id <run-id> --scenario .pi/skills/verify-mydocuments/features/scenarios/feel-tab-indent.json
node .pi/skills/verify-mydocuments/scripts/drive.mjs --run-id <run-id> --scenario .pi/skills/verify-mydocuments/features/scenarios/feel-vertical-motion-default.json
node .pi/skills/verify-mydocuments/scripts/drive.mjs --run-id <run-id> --scenario .pi/skills/verify-mydocuments/features/scenarios/feel-vertical-motion-spacing0.json
node .pi/skills/verify-mydocuments/scripts/drive.mjs --run-id <run-id> --scenario .pi/skills/verify-mydocuments/features/scenarios/feel-vertical-motion-spacing3.json
node .pi/skills/verify-mydocuments/scripts/drive.mjs --run-id <run-id> --scenario .pi/skills/verify-mydocuments/features/scenarios/feel-selection-collapse.json
node .pi/skills/verify-mydocuments/scripts/drive.mjs --run-id <run-id> --scenario .pi/skills/verify-mydocuments/features/scenarios/feel-list-continuation.json
node .pi/skills/verify-mydocuments/scripts/drive.mjs --run-id <run-id> --scenario .pi/skills/verify-mydocuments/features/scenarios/feel-list-continuation-dark.json
node .pi/skills/verify-mydocuments/scripts/drive.mjs --run-id <run-id> --scenario .pi/skills/verify-mydocuments/features/scenarios/feel-table-display.json
node .pi/skills/verify-mydocuments/scripts/drive.mjs --run-id <run-id> --scenario .pi/skills/verify-mydocuments/features/scenarios/feel-table-display-dark.json
node .pi/skills/verify-mydocuments/scripts/drive.mjs --run-id <run-id> --scenario .pi/skills/verify-mydocuments/features/scenarios/feel-table-layout.json
node .pi/skills/verify-mydocuments/scripts/drive.mjs --run-id <run-id> --scenario .pi/skills/verify-mydocuments/features/scenarios/feel-table-layout-dark.json
node .pi/skills/verify-mydocuments/scripts/drive.mjs --run-id <run-id> --scenario .pi/skills/verify-mydocuments/features/scenarios/feel-table-always.json
node .pi/skills/verify-mydocuments/scripts/drive.mjs --run-id <run-id> --scenario .pi/skills/verify-mydocuments/features/scenarios/feel-table-input.json
node .pi/skills/verify-mydocuments/scripts/drive.mjs --run-id <run-id> --scenario .pi/skills/verify-mydocuments/features/scenarios/feel-code-block.json
node .pi/skills/verify-mydocuments/scripts/drive.mjs --run-id <run-id> --scenario .pi/skills/verify-mydocuments/features/scenarios/feel-code-block-dark.json
node .pi/skills/verify-mydocuments/scripts/drive.mjs --run-id <run-id> --scenario .pi/skills/verify-mydocuments/features/scenarios/feel-code-completion.json
node .pi/skills/verify-mydocuments/scripts/drive.mjs --run-id <run-id> --scenario .pi/skills/verify-mydocuments/features/scenarios/feel-code-completion-dark.json
```

## Gotchas

- 行の高さと折り返しは、フォントの実測に依存する。段落間隔の高さの値（20.5 など）は、既定の文字サイズ 18px と行高 1.9 が前提。seed の preferences でこれらを変えると期待値が変わる。
- CodeMirror は表示範囲の外の行を描画しない。ぶら下げインデントのように全行の位置を測る検証は、viewport を十分に高くしないと、折り返し行が DOM に存在せず、測れない。
- 範囲選択の位置は文字数（オフセット）で比べる。行頭のオフセットは、文書の行の長さで決まる。文書を変えたらシナリオの期待値を作り直す。
- 空行を飛ばさない上下移動は、行と行の間に margin を付けないことに依存する。隙間の検査（0.5px 未満）が先に失敗したら、移動の失敗はその副作用の可能性が高い。
- Tab の検証で、前のキー入力から時間が空いても結果は変わらないが、Esc の直後でなければ Tab はインデントになる。Esc を挟む順序を変えるとシナリオの意味が変わる。
- 実 IME の変換中の挙動（変換中の空行、リストの行）は、この Skill のシナリオに含めない。tests/e2e/writing-feel.spec.ts は CDP で変換を模擬するが、実際の IME ではない。
- Enter でのリストの継続は、本文の末尾にカーソルを置いてから押す（click の後に Mod+End）。設定画面を開いたまま Enter を押すと設定画面の操作になるので、Esc で閉じてフォーカスが本文へ戻ってから押す。入力中は上部バーが隠れるので、設定画面は設定ボタンではなく Mod+, で開く。
- 設定画面は縦に長く、「編集」の節は「外観」の下にある。スクリーンショットには、シナリオの eval で「編集」の節をスクロールして入れる。
- IME の変換中の Enter（変換中は項目が増えない）は、このシナリオの範囲外。実 IME ではなく、CDP の keyboard.press('Enter') は変換を確定して改行してしまうので、模擬にもならない。tests/e2e/list-continuation.spec.ts が keyCode 229 の keydown で確かめる。
- loose list は、項目の間に空行があるリスト（「- a」「空行」「- b」）。「- a」「- b」のように空行がないリスト（tight list）は、項目が続く Enter は設定にかかわらず同じ。空の 2 項目目での Enter だけ、既定では空行を入れずにリストを終え、「リストの形に合わせる」では空行を入れる（Run 12）。
- 見た目（行の隙間、字間の自然さ）は数値では測れない部分がある。screenshot（caret-after-typing.png、hanging-indent.png、spacing-2.png など）を目で見て確かめる。
- 記号の表示（FEEL-9）の既定は「カーソルのある行だけ」。記号が見えていることを前提にしたシナリオ（feel-hanging-indent.json のように、記号の文字数で位置を数えるもの）は、seed の preferences に markupDisplay: "always" を書く。弱めて通さない。隠した状態の配置は、feel-hanging-indent-hidden.json（本文の最初の文字の位置で測る）。
- 記号を隠した行の文字列は、DOM の textContent から記号が消え、箇条書きは • の 1 文字、タスクのチェックボックスは文字なし（空白だけが残る）になる。期待値は、隠した行と見せた行で別に持つ。カーソルのある行と、選択にかかる行は、見せた行になる。選択が残ったまま設定を切り替えても、選択にかかる行は見えたまま。
- コードブロックの色は、言語の別ファイルの読み込みが済んでから付く。expect は timeout まで再試行するので、色の検査には timeout（8000 など）を付ける。ts、js、css、html は Markdown の言語と同じ塊に入っていて、別ファイルの読み込みは要らない（python、rust など、ほかの言語は別ファイル）。
- 色は、span の描画された色（getComputedStyle）と、`--md-code-*` の変数を同じ要素に当てて得た色を比べる。コードの中の字面（`const`、`def`）が 1 つの span になるのは、その字面がキーワードなど、色の付く分類のときだけ。色の付かない字面は、行の文字の中にあり、span にならない（`let` は python では色なし）。
- 言語名の補完は、開いてから 75ms は Enter と Tab を受けない（CodeMirror の interactionDelay）。補完を選ぶ step の前に wait を入れる（シナリオは 200ms）。名前に完全一致した語（`ts`、`py`）は打ち始めでは一覧が出ないので、一覧を出すシナリオは `pyt` のような途中までの語を打つ。
- 閉じのフェンスの重複の防止を見るときは、コードの最後の行に字下げがないものを選ぶ。字下げのある行（Python の `    return`）で Enter を押すと字下げが引き継がれ、`    ```` ` は閉じのフェンスにならない（CommonMark）。
- 補完の一覧が画面の中にあるか（`top: -10000px` でないか）は、expect の visible では分からない（大きさがあれば visible になる）。座標で確かめる（tests/e2e/code-block.spec.ts）。
- 隠した行をクリックすると、その行が見える状態に切り替わり、文字が記号の幅だけ動く。続けてダブルクリックすると、2 回目は動いた後の文字に当たる。座標で位置を決めるシナリオは、切り替え後の位置を測り直す（ADR-004 の限界）。
- ⌘/Ctrl+クリックは、macOS 上の Chromium で、platform を windows や linux に偽装した場合の Ctrl+クリックが、右クリック扱いで語を選んでしまう（アプリの動作ではなくホストの挙動）。この組み合わせでは「カーソルは動かない」の検査が外れる。カーソルが動かないことの確認は、tests/e2e の合成イベントの検査と、ホストと同じ OS のシナリオで行う。feel-link-open.json は、--platform を省略すればホストの OS で動く。
- リンクを開く操作の検証は、メモリ bridge が URL を記録する（openedUrls）ところまで。実際に既定のブラウザが開くこと、ネイティブ側の検査は、src-tauri の cargo test（検査だけ。ブラウザは開かない）。この Skill では、実際のリンクを開かない。
- チェックボックスのクリックは、クリックした行が切り替え後も隠れたままで、選択も動かない。次のクリックの位置は変わらないので、座標を測り直さなくてよい（記号を見せる行のクリックとの違い）。本文のクリックでは、その行が見える状態に変わる。
- 切り替えない操作（修飾キー付き、IME の変換中）の検査は、合成イベントとの組み合わせが必要で、tests/e2e/live-markup.spec.ts (k) が持つ。この Skill のシナリオは、本文のクリックまで。複数カーソルはアプリが有効にしていないので、UI からは確かめられない（単体テストだけ）。
- 実 IME で記号を隠した行の前後を変換する検証は、この Skill のシナリオに含めない（tests/e2e/live-markup.spec.ts が CDP で模擬する）。
- 表の検証は、最初にカーソルを表の外に置く（文書の最初の行を表にしない。click の position を `{ x: 5, y: 5 }` にして、表の上の余白を押し、Mod+Home）。カーソルが表の端（先頭の行頭、最後の行末）にあると、端の一致も「触れている」になり、表は原文になる。Mod+End も、末尾が表なら原文になる。
- CodeMirror は表示範囲の外を描画しないので、遠い表は DOM に `.cm-md-table` がない。数を数えるシナリオは、表が画面に入る位置で行う。
- 表を表示しているとき、`.cm-line` には表の行が存在しない（表は 1 つのブロック）。原文の行の検査は、カーソルを表に入れてから行う。引用の中の表は表示せず、行ごとに `>` を隠す（行の文字列に `>` が出ない）。
- Tab のシナリオは、クリックした位置がセルの中身の末尾であることに依存する。クリックの直後の Tab は、そのセルの次のセルへ移る（同じセルの頭ではない）。Esc の直後の Tab は本文の外へフォーカスを移す（tests/e2e/table-display.spec.ts が確かめる）。
- 表の見た目（列の幅、折り返し）は、フォントの実測に依存する。feel-table-display のシナリオは配置と色と数だけを見る。幅と折り返しは feel-table-layout のシナリオ（em の下限、見出しの行数、語の折れ、ページの横幅）と tests/e2e/table-layout.spec.ts（列の幅と、スクロールバーの操作）が見る。列の幅の絶対値（134px など）は、文字の大きさ 18px と同梱のフォントの前提。
- 表の横スクロールバーは、drive の headless chromium（既定の --hide-scrollbars）では描かれず、場所も取らない。見せるシナリオには showScrollbars: true を書く（drive.mjs が --hide-scrollbars を外す）。スクロールバーの上の押下の検査は、場所を取るスクロールバーが前提なので、tests/e2e/table-layout.spec.ts のように、起動の引数から --hide-scrollbars を外す。アプリの窓（macOS の WKWebView）での見え方と、トラックパッドの手触りは未確認。
- 窓の幅を広げて戻すと、アプリの画面の構成（サイドバーなど）で、本文の列の幅が最初と違うことがある。表がスクロールするかは、幅の数字ではなく、表の幅と本文の列の幅の比較（grid.width > column）で決める。
- 実 IME と実機（WKWebView）での表の出入りは、この Skill のシナリオに含めない。IME の変換中に表の DOM を作り直さないことは、tests/e2e/table-display.spec.ts が CDP の模擬で確かめる。
- 表の入力（FEEL-14）のシナリオは、最初に Mod+Home で文書の先頭（表の外）へ行き、ArrowDown の回数と End で行の末尾へ動かす。表の上の行からの ArrowDown は表に入って原文になり、その後は 1 行ずつ動くので、回数は原文の行数と一致する。足した行の位置は、文書全体の文字列（getText）の一致と、getSelection().head の値で確かめる。
- 最後のセルでの Tab は、カーソルがそのセルの中にあるときだけ行を足す。最後の行の末尾の `|` の後ろ（行末）は、セルの外なので、動かない。空の最後の行の Enter は、表から出て、カーソルが空の行に置かれる（次の Enter は表の外の普通の改行）。
- 実 IME と、WebKit で変換の確定の直後に届く Enter の keydown は、この Skill のシナリオに含めない（chromium では再現できない）。tests/e2e/table-input.spec.ts が、CDP の模擬の変換中の Enter（keyCode 229）で、行が増えないことを確かめる。
