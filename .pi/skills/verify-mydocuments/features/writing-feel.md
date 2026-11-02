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

## How to get to it (user POV)

- 本文をクリックして、キーボードで入力・移動する。専用のボタンはない。
- 段落間隔は設定画面の「段落間隔」（Mod+, か設定ボタン）。既定値は起動時に自動で反映される。
- リストの項目で Enter。設定は設定画面（Mod+, か設定ボタン）の「編集」の節の「リストの継続」（ラジオ「空行を入れない」「リストの形に合わせる」）。
- Tab、Shift+Tab、Esc、ArrowUp、ArrowDown、Shift+ArrowUp、Shift+ArrowDown、Mod+Home、Mod+End。
- 記号の表示は設定画面（Mod+, か設定ボタン）の「外観」の節の「記号の表示」（ラジオ「カーソルのある行だけ」「常に表示」）。隠す・見せるは、カーソルや選択を動かすだけで切り替わる。
- リンクを開く操作は、本文のリンクの上での Mod+クリック（macOS は ⌘、Windows と Linux は Ctrl）。drive の click の modifiers: ["ControlOrMeta"] がその OS の Mod キーになる。
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
| feel-link-open.json | インラインリンク・自動リンク・裸の URL・相対パス・javascript: のリンクを、Mod+クリック。最後に普通のクリック | window.__mdeE2E.openedUrls に http/https の 3 つだけが入る。カーソルは動かない。相対パスはトースト「このリンクは開けません」。普通のクリックは開かず、その行の記法が見える。メモリ bridge は URL を記録するだけで、ブラウザは開かない。画像は relative-link-toast.png、plain-click.png |
| feel-tab-indent.json | リスト、番号付き、引用、複数行選択、通常の段落で Tab と Shift+Tab、Esc と Tab | 本文が「- a」「  - b」と変わり、番号付きは「   2. b」、引用は「> > q」。通常の段落は不変でフォーカスも本文のまま。Esc → Tab で char-count、Esc → Shift+Tab で settings-button にフォーカス |
| feel-vertical-motion-default.json、feel-vertical-motion-spacing0.json、feel-vertical-motion-spacing3.json | 30 行の文書（見出し、空行、リスト、引用、フェンス）を、段落間隔 0.6、0、3 で、先頭から ArrowDown ×29、末尾から ArrowUp ×29 | 行の間の隙間が 0.5px 未満。1 押下ごとにカーソルの行がちょうど 1 変わる |
| feel-list-continuation.json | 項目の間に空行のあるリストの末尾で Enter。続けて「次の項目」と入力して保存。Mod+, で「編集」の節を開き「リストの形に合わせる」にして Esc、Enter、Undo。「空行を入れない」へ戻して Enter。最後に「リストの形に合わせる」にして reload | 既定では末尾に「\n- 」だけが入り（空行なし）、保存された本文は「- 次の項目」で終わる。「リストの形に合わせる」では「\n\n- 」が入り、Undo 1 回で戻る。戻すとすぐ「\n- 」になる。保存された設定の listContinuation が preserve になり、reload 後も選ばれている。画像は before-enter.png、after-enter-tight.png、settings-editing-light.png、after-enter-preserve.png、after-enter-tight-again.png、after-reload-preserve.png |
| feel-list-continuation-dark.json | ダークで設定画面を開き、「編集」の節までスクロール | 節の見出しが「外観」「編集」の順。「リストの継続」の既定は「空行を入れない」。画像は settings-editing-dark.png |
| feel-selection-collapse.json | 5 行の文書で、選択して ArrowUp、ArrowDown、Shift+ArrowUp、Shift+ArrowDown | 選択の anchor と head の位置が、下向きの選択は ArrowDown で末尾、ArrowUp で先頭へ畳まれる。上向きの選択も ArrowUp で先頭へ畳まれる。Shift 付きは anchor が動かず head が 1 行ずつ。先頭行の ArrowUp は行頭、末尾行の ArrowDown は行末 |

```
node .pi/skills/verify-mydocuments/scripts/drive.mjs --run-id <run-id> --scenario .pi/skills/verify-mydocuments/features/scenarios/feel-caret-position.json
node .pi/skills/verify-mydocuments/scripts/drive.mjs --run-id <run-id> --scenario .pi/skills/verify-mydocuments/features/scenarios/feel-paragraph-spacing.json
node .pi/skills/verify-mydocuments/scripts/drive.mjs --run-id <run-id> --scenario .pi/skills/verify-mydocuments/features/scenarios/feel-hanging-indent.json
node .pi/skills/verify-mydocuments/scripts/drive.mjs --run-id <run-id> --scenario .pi/skills/verify-mydocuments/features/scenarios/feel-hanging-indent-hidden.json
node .pi/skills/verify-mydocuments/scripts/drive.mjs --run-id <run-id> --scenario .pi/skills/verify-mydocuments/features/scenarios/feel-live-markup.json
node .pi/skills/verify-mydocuments/scripts/drive.mjs --run-id <run-id> --scenario .pi/skills/verify-mydocuments/features/scenarios/feel-live-markup-dark.json
node .pi/skills/verify-mydocuments/scripts/drive.mjs --run-id <run-id> --scenario .pi/skills/verify-mydocuments/features/scenarios/feel-link-open.json --platform windows
node .pi/skills/verify-mydocuments/scripts/drive.mjs --run-id <run-id> --scenario .pi/skills/verify-mydocuments/features/scenarios/feel-tab-indent.json
node .pi/skills/verify-mydocuments/scripts/drive.mjs --run-id <run-id> --scenario .pi/skills/verify-mydocuments/features/scenarios/feel-vertical-motion-default.json
node .pi/skills/verify-mydocuments/scripts/drive.mjs --run-id <run-id> --scenario .pi/skills/verify-mydocuments/features/scenarios/feel-vertical-motion-spacing0.json
node .pi/skills/verify-mydocuments/scripts/drive.mjs --run-id <run-id> --scenario .pi/skills/verify-mydocuments/features/scenarios/feel-vertical-motion-spacing3.json
node .pi/skills/verify-mydocuments/scripts/drive.mjs --run-id <run-id> --scenario .pi/skills/verify-mydocuments/features/scenarios/feel-selection-collapse.json
node .pi/skills/verify-mydocuments/scripts/drive.mjs --run-id <run-id> --scenario .pi/skills/verify-mydocuments/features/scenarios/feel-list-continuation.json
node .pi/skills/verify-mydocuments/scripts/drive.mjs --run-id <run-id> --scenario .pi/skills/verify-mydocuments/features/scenarios/feel-list-continuation-dark.json
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
- 隠した行をクリックすると、その行が見える状態に切り替わり、文字が記号の幅だけ動く。続けてダブルクリックすると、2 回目は動いた後の文字に当たる。座標で位置を決めるシナリオは、切り替え後の位置を測り直す（ADR-004 の限界）。
- ⌘/Ctrl+クリックは、macOS 上の Chromium で、platform を windows や linux に偽装した場合の Ctrl+クリックが、右クリック扱いで語を選んでしまう（アプリの動作ではなくホストの挙動）。この組み合わせでは「カーソルは動かない」の検査が外れる。カーソルが動かないことの確認は、tests/e2e の合成イベントの検査と、ホストと同じ OS のシナリオで行う。feel-link-open.json は、--platform を省略すればホストの OS で動く。
- リンクを開く操作の検証は、メモリ bridge が URL を記録する（openedUrls）ところまで。実際に既定のブラウザが開くこと、ネイティブ側の検査は、src-tauri の cargo test（検査だけ。ブラウザは開かない）。この Skill では、実際のリンクを開かない。
- 実 IME で記号を隠した行の前後を変換する検証は、この Skill のシナリオに含めない（tests/e2e/live-markup.spec.ts が CDP で模擬する）。
