# アウトライン（部品のパネル）

## Sub-features

- OUT-1: 左サイドバーの、エクスプローラーの下に、部品のパネルの節が出る（ADR-005 の R7。フォルダを開いていなくても出る）。同梱の段 2 の部品「アウトライン」が、開いている Markdown の見出し（ATX 見出し # から ######）を、深さ（data-depth。0 から 5）つきの一覧にする。見出しの文字は部品が送り、本体が文字として描く。
- OUT-2: 数える見出しは、行頭の空白 3 つまで、# のあとに空白、閉じの # は文字に含めない。フェンスのコードブロック（``` と ~~~）の中と、先頭の front matter（--- で囲んだ部分）の中は数えない。setext 見出し（下線の = と -）は数えない。素のテキスト（.txt）と、見出しのない Markdown は「見出しはありません」。項目は先頭から 1000 件まで。
- OUT-3: 項目を押す、または Enter で、本体がその見出しの行の先頭へカーソルを移し、その行が見えるまでスクロールし、本文にフォーカスを戻す。部品はカーソルを動かせない（頼む API がない）。項目を作った本文の版が、今の本文の版と違うとき（入力のあと、次の更新を待っている間）は、押しても移らない。
- OUT-4: カーソルのある節の項目が強調される（aria-current="location"）。最初の見出しより前では、強調がない。
- OUT-5: 本文は、権限 document.read を宣言した部品にだけ送られる（確認の画面なし、保存なし）。入力が止まった後（約 200ms）に 1 回、文書を開いた・切り替えたときはすぐ。IME の変換中は送らず、確定の後に送る。パネルが見えていないとき（サイドバーが閉じている、節がたたまれている）は送らず、見えたときに最新を送る。カーソルの位置も同じ規則で、間引いて送る。
- OUT-6: 節の見出し（ボタン。aria-expanded）で、たためる（保存しない）。一覧は名前（`<見出し>の項目`）を持ち、Tab で入る項目は 1 つ（現在の項目、なければ先頭）。上下、Home、End で移り、Enter で選ぶ。閉じたサイドバーでは、パネルもフォーカスを受けない。
- OUT-7: 部品の文字列（節の見出し、項目、項目がないときの文言）は HTML として解釈されない。上限（項目の数、文字列の長さ、深さ、setItems の頻度）を超えた部品と、不正な形のメッセージを送った部品は、その部品だけが止まり、パネルが消える。ほかの部品と入力、保存は動き続ける。

## How to get to it (user POV)

- サイドバーを開く: 上部バー左端の開閉ボタン（sidebar-toggle）か Mod+B。パネルの節は plugin-panels の中の plugin-panel（見出しボタンは plugin-panel-toggle）。
- 項目: plugin-panel-item（role は button、一覧は role list で名前は「アウトラインの項目」）。項目がないとき、plugin-panel-empty。
- 文書を開く（Mod+O、エクスプローラーのツリー）、入力、カーソルの移動（矢印、クリック）、文書の切り替え。
- パネルの項目のクリックと、フォーカスしてからの上下・Home・End・Enter。節の見出しのクリック。
- 起動時の自動処理: 部品は最初の描画のあとに動き始める。サイドバーが開いていれば、開いている文書の見出しが、入力なしで出る。

## Driving it with Playwright（メモリ bridge）

Preconditions: Launch 済みで Doctor が全 PASS。同梱の部品は、seed に isolated を書かなくても、本番と同じく読み込まれる。seed に isolated を書くと、観測の入口 window.__mdeE2EIsolatedTrace（本体の側で見えた panel、items、doc、selection、ready、stopped の記録。doc は本文を部品に届けた記録で、length は本文の長さ）が有効になる。検証用の部品（e2e-panel-evil、e2e-panel-echo、e2e-panel-undeclared、e2e-panel-flood、e2e-panel-many、e2e-panel-bogus、e2e-panel-move、e2e-panel-stale）は、isolated.plugins に名前を書いたときだけ読み込まれる。

| シナリオ | user action | 観測できる結果 |
|---|---|---|
| outline-panel.json | 文書を開き、見出しの項目を押し、本文に書き足し、.txt を開く | 見出しが 3 件（コードブロックの中の # は数えない）で、深さが 0、1、0。項目を押すと、カーソルがその行の先頭へ移り、本文にフォーカスがある。書き足した見出しが一覧に出る（入力が止まった後）。.txt では「見出しはありません」 |
| outline-timing.json | サイドバーを閉じたまま文書を開いて入力し、開く。節をたたんで入力し、戻す。項目を Enter で選ぶ。HTML に見える文字列を送る部品と、document.read を宣言しない部品を載せる | 閉じている間とたたんでいる間は、アウトラインへの doc の記録が増えない。開く・戻すと最新が 1 回届く。Enter でその行へ移る。HTML に見える文字列は文字のまま（img などの要素ができない）。document.read を宣言しない部品には、doc も selection も届かない |

```
node .pi/skills/verify-mydocuments/scripts/drive.mjs --run-id <run-id> --scenario .pi/skills/verify-mydocuments/features/scenarios/outline-panel.json
node .pi/skills/verify-mydocuments/scripts/drive.mjs --run-id <run-id> --scenario .pi/skills/verify-mydocuments/features/scenarios/outline-timing.json
```

- 本文の版（今の本文の版と、項目を作った版）は、画面には出ない。古い項目で移らないことは tests/e2e/outline.spec.ts（e2e-panel-stale）が確かめる。
- IME の変換中に送らないことは、tests/e2e/outline.spec.ts の CDP による変換の模擬が確かめる（この Skill のシナリオには含めない。実 IME は未確認）。
- 部品が上限を超えて止まる記録は、console の `[plugin] 部品「<id>」を止めました: <理由>` と、isolated の記録の stopped。

## Gotchas

- 本文を部品に届ける記録（doc）は、サイドバーが閉じている、または節がたたまれているあいだは増えない。確かめるときは、先に待ち（約 200ms の後ろ寄せ）を置く。expect の timeout の中で増えないことは確かめられないので、wait の後に値を比べる。
- 項目が更新されるのは入力が止まった後なので、入力の直後に一覧を expect するときは、timeout（既定 3000ms）の中で待たせる。固定の待ちを足さない。
- 一覧は文書の切り替えのたびに作り直される。項目の index（data-index）で指すときは、切り替えのあとに件数を expect してから押す。
- 見出しの強調（aria-current）は、カーソルの位置を部品に届けて決まる。カーソルが動いてから約 100ms 後に変わる。
- 部品が止まった後のパネルは、消える（一覧からも、見出しからも）。止まった理由は console に出る。drive.mjs の observations.json の console に載る。
- 隔離（Worker の中から本体へ届かないこと）の取り直しは、Tauri の窓で行う（SKILL.md の「隔離した操作（段 2）の検証」。R7 の経路は isolation-probe.mjs の判定に含まれる）。この feature のシナリオは、ブラウザ版（メモリ bridge）の挙動だけを確かめる。
