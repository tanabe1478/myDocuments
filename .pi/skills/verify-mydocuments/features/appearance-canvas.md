# 外観と執筆キャンバス

## Sub-features

- APP-1: 外観パネル（非モーダルの dialog「外観」）を、上部バーの「外観」ボタンか Mod+, で開閉する。Esc でも閉じ、閉じるとフォーカスが元の場所へ戻る。
- APP-2: 文字サイズ、行高、段落間隔、字間、本文の最大幅を変えると、本文に即時反映され、debounce（連続変更をまとめる遅延）の後に保存され、再読み込み後も維持される。
- APP-3: フォントを選択肢（明朝体など）か自由入力（font-family）で変える。不正な指定は反映されずエラーが出る。
- APP-4: テーマ（ライト、ダーク、OS に従う）を切り替える。html の data-theme に出る。
- APP-5: 背景を単色、グラデーション（和紙、夕暮れ、深い森など）、画像から選ぶ。画像は選ぶと blob URL で表示され、明るさとオーバーレイを調整できる。
- APP-6: 「背景を表示しない」で背景層が消え、テーマの既定配色になる。
- APP-7: 文字と本文面のコントラスト比を表示し、基準（4.5）未満なら警告（role alert）を出す。

## How to get to it (user POV)

- 上部バー右の「外観」ボタン（data-testid appearance-button）をクリックする。
- Mod+,（macOS は Cmd+,、Windows と Linux は Ctrl+,）。もう一度押すと閉じる。
- 入力中に上部バーが隠れていても、F6 でバーへフォーカスを移して Enter でボタンを押せる（writing-modes.md）。
- パネル内の部品は、ラベルの名前（文字サイズ、行高、段落間隔、字間、本文の最大幅、フォントの種類、font-family（自由入力）、単色の色、画像の明るさ、オーバーレイ濃度、本文面の不透明度、背景を表示しない など）とラジオの名前（ライト、ダーク、単色、グラデーション、画像）で届く。
- 画像の選択は「画像を選ぶ」ボタン（image-pick）。ネイティブのダイアログは、メモリ bridge では seed の imagePath が戻り値の代わり。
- 起動時の自動処理: 保存済みの設定（preferences）が読み込まれて反映される。

## Driving it with Playwright（メモリ bridge）

Preconditions: Launch 済みで Doctor が全 PASS。画像のシナリオは seed の files に単色の PNG と imagePath を持つ（シナリオに書いてある）。パネルの部品は `panel: true` を付けた target で、dialog「外観」の中に絞って操作する。

| シナリオ | user action | 観測できる結果 |
|---|---|---|
| appearance-typography.json | 外観ボタンでパネルを開き、文字サイズ 24、行高 2.5、段落間隔 2、字間 0.1、最大幅 800、ダーク、明朝体に変更。Esc で閉じて reload。Mod+, で開き直し、もう一度 Mod+, で閉じる | .cm-content の font-size が 24px、letter-spacing が 2.4px、.cm-line の line-height が 60px、.cm-scroller の font-family が Mincho を含み、html の data-theme が dark。保存された設定が fontSizePx 24、lineHeight 2.5、maxWidthPx 800、paragraphSpacing 2、letterSpacing 0.1、theme dark。reload 後も 24px。Mod+, で開閉できる |
| appearance-background.json | Mod+, を開き、単色（#336699）、グラデーション（夕暮れ）、画像（選択）、明るさ 0.5、背景を表示しない、暗い単色 + 本文面の不透明度 0 を順に操作 | canvas-bg の data-kind が gradient から color、gradient、image と変わり、色は rgb(51, 102, 153)。画像は blob: の URL で、image-status が「取り込み済み」、filter が brightness(0.5)。背景を表示しないで canvas-bg が 0 件、canvas-surface の opacity が 1。コントラスト警告が出て、不透明度を 1 に戻すと消える |

```
node .pi/skills/verify-mydocuments/scripts/drive.mjs --run-id <run-id> --scenario .pi/skills/verify-mydocuments/features/scenarios/appearance-typography.json
node .pi/skills/verify-mydocuments/scripts/drive.mjs --run-id <run-id> --scenario .pi/skills/verify-mydocuments/features/scenarios/appearance-background.json
```

見た目の確認は、evidence/<scenario 名>/ の panel-open-dark.png、bg-gradient-dusk.png、bg-image.png、contrast-warning.png などの画像で行う。

## Gotchas

- 設定の保存は debounce の後。保存された設定を読む expect は timeout を伸ばす（シナリオは 4000ms）。読む前に評価例外になっても再試行される。
- メモリ bridge は、再読み込みをまたいで設定だけを sessionStorage に保つ。画像本体は保たないので、reload 後の画像の背景は、設定は残るが画像は出ない（本文は使える）。これは仕様どおりで、画像が再読み込みで残ることの検証にはならない。
- 画像の選択が seed の imagePath を使うため、imagePath が null だと何も起きない（キャンセルの扱い）。画像でないファイルは「画像を取り込めませんでした」になる。
- パネルを開いている間は、入力中でも上部バーが隠れない。バーの自動非表示の検証はパネルを閉じてから行う。
- 外観ボタンは日本語の「外観」。role の name で指すときは dialog の「外観」と button の「外観」が別物であることに注意し、ボタンは testId appearance-button で指す。
- 背景の見え方やコントラストの値は、テーマと画像の平均色に依存する。値の判定は expect（比や警告の有無）で行い、画像の見た目は screenshot を目で見て確かめる。
- ネイティブのファイル選択ダイアログと、実際の画像ファイルの読み込み（Rust 側の形式判定と 20 MiB の上限）は、この Skill では確かめない。
