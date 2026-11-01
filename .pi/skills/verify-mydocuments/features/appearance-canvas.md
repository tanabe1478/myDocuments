# 設定画面・外観・左サイドバー・執筆キャンバス

## Sub-features

- APP-1: 設定画面（窓の中央に出るモーダルの dialog「設定」。中に「外観」の節）を、上部バー右の歯車の「設定」ボタンか Mod+, で開閉する。開くと最初の設定項目（フォントの種類）にフォーカスが入り、Tab は中で循環する。Esc、閉じるボタン、幕のクリックで閉じ、閉じるとフォーカスが開く前の場所（本文ならエディタ）へ戻る。幕は薄く、変更は後ろの本文へ即座に反映される。高さが窓に収まらないときは、見出しを残して中がスクロールする。
- APP-2: 文字サイズ、行高、段落間隔、字間、本文の最大幅を変えると、本文に即時反映され、debounce（連続変更をまとめる遅延）の後に保存され、再読み込み後も維持される。
- APP-3: フォントを選択肢（明朝体など）か自由入力（font-family）で変える。不正な指定は反映されずエラーが出る。
- APP-4: テーマ（ライト、ダーク、OS に従う）を切り替える。html の data-theme に出る。
- APP-5: 背景を単色、グラデーション（和紙、夕暮れ、深い森など）、画像から選ぶ。画像は選ぶと blob URL で表示され、明るさとオーバーレイを調整できる。
- APP-6: 「背景を表示しない」で背景層が消え、テーマの既定配色になる。
- APP-7: 文字と本文面のコントラスト比を表示し、基準（4.5）未満なら警告（role alert）を出す。
- APP-8: 紙の幅（surfaceWidth）。既定の「窓いっぱい」（fill）は、紙（canvas-surface）が本文の領域（サイドバーを除いた領域）いっぱいで、影はない。「本文に合わせる」（text）は、本文の最大幅 + 左右の余白（広い窓で 56px ずつ）の幅で、領域の中央に置き、影がある。どちらも 1 行の長さは本文の最大幅で決まり、本文の列は本文の領域の中央。設定画面の「紙の幅」で切り替え、保存され、再読み込み後も維持される。不正な保存値は fill に戻る。
- APP-9: 左サイドバー（aside、名前「サイドバー」）。既定は閉じている。上部バー左端の開閉ボタンか Mod+B で開閉し、開くと本文の領域を右へ 260px 押し出す（重ねない）。中身は見出し「エクスプローラー」と「フォルダはまだ開かれていません」だけ。開閉は保存され、再読み込み後に復元される。入力中の自動非表示では隠れない。IME の変換中は Mod+B に反応しない。設定画面を開いている間は Mod+B を無視する。
- APP-10: 狭い窓。押し出すと本文が最小幅（本文の最大幅の最小値 320px + 左右の余白 20px ずつ = 360px）を割る窓（幅が 620px 未満）では、サイドバーは本文の上に重なり、本文は動かない。そのとき、サイドバーの中に閉じるボタン（sidebar-close）が出て、Esc でも閉じる。

## How to get to it (user POV)

- 上部バー右の歯車の「設定」ボタン（data-testid settings-button）をクリックする。
- Mod+,（macOS は Cmd+,、Windows と Linux は Ctrl+,）。もう一度押すと閉じる。
- 入力中に上部バーが隠れていても、F6 でバーへフォーカスを移して（最初に届くのは左端のサイドバーの開閉ボタン）、Tab で設定ボタンへ進んで Enter で押せる（writing-modes.md）。
- 上部バー左端のサイドバーの開閉ボタン（data-testid sidebar-toggle。aria-expanded と aria-controls を持つ）をクリックする。Mod+B（macOS は Cmd+B、Windows と Linux は Ctrl+B）でも開閉する。狭い窓で重なって開いたときは、サイドバー内の閉じるボタン（sidebar-close）か Esc。
- 設定画面内の部品は、ラベルの名前（文字サイズ、行高、段落間隔、字間、本文の最大幅、フォントの種類、font-family（自由入力）、単色の色、画像の明るさ、オーバーレイ濃度、本文面の不透明度、背景を表示しない など）とラジオの名前（ライト、ダーク、単色、グラデーション、画像、窓いっぱい、本文に合わせる）で届く。
- 画像の選択は「画像を選ぶ」ボタン（image-pick）。ネイティブのダイアログは、メモリ bridge では seed の imagePath が戻り値の代わり。
- 起動時の自動処理: 保存済みの設定（preferences。sidebarOpen と surfaceWidth を含む）が読み込まれて反映される。

## Driving it with Playwright（メモリ bridge）

Preconditions: Launch 済みで Doctor が全 PASS。画像のシナリオは seed の files に単色の PNG と imagePath を持つ（シナリオに書いてある）。設定画面の部品は `panel: true` を付けた target で、dialog「設定」の中に絞って操作する。

| シナリオ | user action | 観測できる結果 |
|---|---|---|
| appearance-typography.json | 設定ボタンで設定画面を開き、文字サイズ 24、行高 2.5、段落間隔 2、字間 0.1、最大幅 800、ダーク、明朝体に変更。Esc で閉じて reload。Mod+, で開き直し、もう一度 Mod+, で閉じる | .cm-content の font-size が 24px、letter-spacing が 2.4px、.cm-line の line-height が 60px、.cm-scroller の font-family が Mincho を含み、html の data-theme が dark。保存された設定が fontSizePx 24、lineHeight 2.5、maxWidthPx 800、paragraphSpacing 2、letterSpacing 0.1、theme dark。reload 後も 24px。Mod+, で開閉できる |
| layout-sidebar-surface.json | 文書を開き、Mod+B でサイドバーを開く。Mod+, で設定画面を開き、紙の幅を「本文に合わせる」、Esc、Mod+B で閉じる。ダークにして、サイドバー閉・開 × 紙 text・fill の順に切り替える。最後にサイドバーを開いて reload | 既定で data-surface が fill、サイドバーは閉じ（aria-expanded が false）、紙の矩形は窓全体（left 0、幅 1280、影なし）。開くと .workspace が left 260、幅 1020 になり、上部バー・下部バー・本文の左端がサイドバーの右端以上。fill の紙は 260〜1280。text の紙は幅 792 で中心が 770（閉じると 640）。設定画面を閉じるとフォーカスは本文。保存された設定が sidebarOpen true、surfaceWidth fill、theme dark で、reload 後もサイドバーが開いている。画像は light-fill-closed.png、light-fill-open.png、settings-open-light.png、light-text-open.png、light-text-closed.png、dark-text-closed.png、dark-text-open.png、dark-fill-open.png、dark-fill-closed.png、after-reload-open.png |
| layout-sidebar-narrow.json | 560 幅の窓で Mod+B。閉じるボタンで閉じる。700 幅にして Mod+B | 560 幅では data-sidebar-mode が overlay で、.workspace は left 0、幅 560 のまま、本文の列は 320px 以上。sidebar-close が見え、押すと閉じてフォーカスは本文。700 幅では push で、.workspace が left 260、幅 440。画像は narrow-overlay-open.png、narrow-push-open.png |
| appearance-background.json | Mod+, を開き、単色（#336699）、グラデーション（夕暮れ）、画像（選択）、明るさ 0.5、背景を表示しない、暗い単色 + 本文面の不透明度 0 を順に操作 | canvas-bg の data-kind が gradient から color、gradient、image と変わり、色は rgb(51, 102, 153)。画像は blob: の URL で、image-status が「取り込み済み」、filter が brightness(0.5)。背景を表示しないで canvas-bg が 0 件、canvas-surface の opacity が 1。コントラスト警告が出て、不透明度を 1 に戻すと消える |

```
node .pi/skills/verify-mydocuments/scripts/drive.mjs --run-id <run-id> --scenario .pi/skills/verify-mydocuments/features/scenarios/appearance-typography.json
node .pi/skills/verify-mydocuments/scripts/drive.mjs --run-id <run-id> --scenario .pi/skills/verify-mydocuments/features/scenarios/appearance-background.json
node .pi/skills/verify-mydocuments/scripts/drive.mjs --run-id <run-id> --scenario .pi/skills/verify-mydocuments/features/scenarios/layout-sidebar-surface.json
node .pi/skills/verify-mydocuments/scripts/drive.mjs --run-id <run-id> --scenario .pi/skills/verify-mydocuments/features/scenarios/layout-sidebar-narrow.json
```

見た目の確認は、evidence/<scenario 名>/ の settings-open-dark.png、bg-gradient-dusk.png、bg-image.png、contrast-warning.png などの画像で行う。

## Gotchas

- 設定の保存は debounce の後。保存された設定を読む expect は timeout を伸ばす（シナリオは 4000ms）。読む前に評価例外になっても再試行される。
- メモリ bridge は、再読み込みをまたいで設定だけを sessionStorage に保つ。画像本体は保たないので、reload 後の画像の背景は、設定は残るが画像は出ない（本文は使える）。これは仕様どおりで、画像が再読み込みで残ることの検証にはならない。
- 画像の選択が seed の imagePath を使うため、imagePath が null だと何も起きない（キャンセルの扱い）。画像でないファイルは「画像を取り込めませんでした」になる。
- 設定画面を開いている間は、入力中でも上部バーが隠れない。設定画面はモーダルで、幕が本文を覆うので、開いたまま本文をクリックすると幕のクリックとして閉じる。本文の操作は閉じてから行う（Esc で閉じるとフォーカスは本文へ戻る）。バーの自動非表示の検証も閉じてから行う。
- 設定ボタンは歯車のアイコンで、アクセシブルな名前は「設定」（title は「設定（⌘,）」か「設定（Ctrl+,）」）。dialog「設定」と button「設定」は別物なので、ボタンは testId settings-button で指す。サイドバーの開閉ボタンも同様に testId sidebar-toggle（名前は「サイドバー」で、aside の「サイドバー」とは別物）。
- 設定画面を開いている間、Mod+B（サイドバーの開閉）は無視される。サイドバーの開閉は設定画面を閉じてから行う。
- サイドバーは、開閉を動かす間（0.18 秒）に位置が変わる。矩形（.workspace の left など）を読む expect は timeout で待つ（Reduced Motion ではすぐ最終の位置）。
- 紙の幅の既定は fill に変わった。以前の見た目（左右に背景の帯がある）を確かめるシナリオは、seed の preferences に surfaceWidth: text を入れるか、設定画面で「本文に合わせる」を選ぶ。背景画像は fill では紙に隠れ、紙の透け具合（本文面の不透明度）か text でしか見えない。
- 設定画面とサイドバーの Tab 循環、スクロール、幕のクリック、IME 中の無視、ダークのコントラストは tests/e2e/settings-sidebar.spec.ts が確かめ、シナリオの範囲外。
- 背景の見え方やコントラストの値は、テーマと画像の平均色に依存する。値の判定は expect（比や警告の有無）で行い、画像の見た目は screenshot を目で見て確かめる。
- ネイティブのファイル選択ダイアログと、実際の画像ファイルの読み込み（Rust 側の形式判定と 20 MiB の上限）は、この Skill では確かめない。
