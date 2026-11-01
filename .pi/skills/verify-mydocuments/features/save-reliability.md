# 保存の信頼性

## Sub-features

- REL-1: 開いている文書が外部で書き換わったとき、未保存の変更がなければ自動で読み直して「読み直しました」と通知する。監視の通知が届かなくても、窓のフォーカス復帰の確認で拾う。
- REL-2: 未保存の変更があるときに外部変更を受けたら、本文に触れず競合バー（data-testid conflict-bar）を出す。選択肢は「差分を見る」「ディスクから読み直す」「自分の版を残す」の 3 つ。
- REL-10: 競合バーの配置。バーは本文に重ならず、上部バーの下・本文の上に専用の場所を取り、表示中は本文の領域がバーの高さだけ縮む。1 行目にメッセージ、2 行目に操作ボタン（状態ごとのボタン）を左揃えで並べ、幅は本文の列（最大幅）に揃う。外観パネルを開いたときの本文の寄せにも追従し、パネルと重ならない。狭い窓ではボタンが折り返す。バーの出現・消失で、見えていたカーソル行は表示領域の中に保たれる。自動非表示の設定でも、競合中はバーが見える。
- REL-3: 差分を見る（conflict-diff）で、自分の本文とディスクの内容を並べて表示する（diff-dialog）。見ただけでは何も変わらない。
- REL-4: ディスクから読み直す（conflict-reload）は、自分の本文を草稿へ退避してから読み込み、退避先を通知する。自分の版を残す（conflict-keep）は、次の保存でディスクの版をバックアップしてから上書きする。
- REL-5: 保存直前の検査。通知が届く前に外部が書き換えていたら、保存は書かずに競合バーを出し、「保存しませんでした」と通知する。
- REL-6: 草稿の自動保存。入力が約 2 秒止まると草稿が書かれ、元の文書には書かない。保存するか、元に戻って未保存でなくなると草稿が消える。
- REL-7: 起動時の復旧。草稿があれば復旧の確認（recovery-dialog）が出て、復元、破棄、あとで（Esc も同じ）を選べる。復元した本文は未保存として開く。
- REL-8: 草稿がなければ、前回の文書を開き直す。
- REL-9: 終了時の確認。未保存の変更がなければ確認せずに終了する。あれば保存、保存しない、キャンセルを選べ、保存が競合したときは終了しない。

## How to get to it (user POV)

- 外部変更: 別のアプリがファイルを書き換える、またはウィンドウへ戻る（フォーカス復帰）。文書を開いている間は自動で監視される。
- 競合バーの 3 つのボタンは、Tab（上部バーの次、本文の前）か、F6（本文、上部バー、競合バー、下部バー、本文の順。競合バーは表示中だけ）で届く。
- 競合バーの 3 つのボタン、差分ダイアログ（Esc で閉じる）、保存直前の検査は Mod+S から届く。
- 草稿は編集して約 2 秒待つだけで書かれる（操作は不要）。
- 復旧の確認と前回の文書の再オープンは、アプリを起動すると自動で働く（草稿があれば確認、なければ再オープン）。
- 終了時の確認は、窓の閉じるボタンか Cmd+Q（macOS）で届く。メモリ bridge では requestClose が代わり。
- ファイルが削除されたときの「作り直す」確認（recreate-ok、recreate-cancel）は、削除の通知と Mod+S で届く（この Skill のシナリオには含めない）。

## Driving it with Playwright（メモリ bridge）

Preconditions: Launch 済みで Doctor が全 PASS。外部のプロセスによる書き換えは、シナリオの externalWrite step で行い、notify が false なら監視の通知を送らず、アプリは気づかない状態を作る。強制終了は、アプリを閉じる代わりに、草稿とディスクの内容だけを持つ新しい seed でページを開き直して模す（reliability-recovery-dialog.json）。

| シナリオ | user action | 観測できる結果 |
|---|---|---|
| reliability-external-change.json | 文書を開き、外部が書き換え（通知あり）、続けて通知なしで書き換えて focusWindow | 1 回目は本文が外部の版になり、toast に「読み直しました」、conflict-bar なし。2 回目は focusWindow の前は変わらず、focusWindow の後に外部の版になる。watched が開いた文書のパス |
| reliability-conflict-bar.json | 追記後に外部が書き換え。差分を見る、Esc、自分の版を残す、Mod+S。さらに追記して外部が再度書き換え、ディスクから読み直す | conflict-bar の data-state が conflict で 3 つのボタンが見え、本文は自分の版のまま。diff-dialog に cm-editor が 2 つ。自分の版を残した直後はバックアップ 0、Mod+S 後はファイルが自分の版、バックアップに外部の版、toast に「バックアップ」。読み直しの後は本文が外部の版で、自分の本文が草稿にあり、toast に「草稿に退避しました」 |
| reliability-save-conflict.json | 追記後、通知なしで外部が書き換え、Mod+S。requestClose して保存を選ぶ | conflict-bar が出て、toast に「保存しませんでした」、physicalWrites 0、conflicts 1、ファイルは外部の版のまま、未保存マークが残る。終了を求めても closed が false のまま |
| reliability-conflict-layout-light.json | 長い文書の先頭に追記し、外部が書き換えて競合バーを出す（1280x800、ライト） | conflict-bar が見え、表示中の .cm-line と bounding box が交差しない（eval が 0）。1 行目が見えている。screenshot は reliability-conflict-layout-light.png。observations.json の barRect、scrollerRect、firstLine で、バーの下端が本文の領域の上端以下 |
| reliability-conflict-layout-dark.json | 同じ操作（1280x800、ダーク） | 同じ判定。ダークでバーの文字と背景のコントラストが保たれていることを、reliability-conflict-layout-dark.png で目視する |
| reliability-conflict-layout-narrow.json | 同じ操作（820x700、ライト） | 同じ判定。バーが窓に収まり、ボタンが折り返しても本文と重ならない（reliability-conflict-layout-narrow.png） |
| reliability-draft-recovery.json | 追記して約 2 秒待つ、Mod+S、1 文字入力して待つ、Backspace | 入力直後は草稿 0 件。約 2 秒後に 1 件で save は 0 回、ファイルは元のまま。Mod+S で草稿 0 件。1 文字入力で草稿 1 件、Backspace で戻して未保存が消え、草稿 0 件 |
| reliability-recovery-dialog.json | 草稿を持つ seed で起動し、復元を選び、Mod+S | recovery-dialog が出て、recovery-name が note.md、本文に「前回の未保存の草稿があります」。復元後の本文は草稿の内容で未保存マークあり、conflict-bar なし。Mod+S 後はファイルが草稿の内容になり、草稿 0 件 |
| reliability-session-close.json | session に前回の文書を持つ seed で起動し、requestClose、reload、追記して requestClose、キャンセル、保存 | 起動直後に note.md が開き recovery-dialog なし。未保存なしの requestClose は確認なしで closed が true。追記後は alertdialog に note.md が出て、キャンセルで closed が false、保存で closed が true かつファイルが保存済み |

```
node .pi/skills/verify-mydocuments/scripts/drive.mjs --run-id <run-id> --scenario .pi/skills/verify-mydocuments/features/scenarios/reliability-external-change.json
node .pi/skills/verify-mydocuments/scripts/drive.mjs --run-id <run-id> --scenario .pi/skills/verify-mydocuments/features/scenarios/reliability-conflict-bar.json
node .pi/skills/verify-mydocuments/scripts/drive.mjs --run-id <run-id> --scenario .pi/skills/verify-mydocuments/features/scenarios/reliability-save-conflict.json
node .pi/skills/verify-mydocuments/scripts/drive.mjs --run-id <run-id> --scenario .pi/skills/verify-mydocuments/features/scenarios/reliability-conflict-layout-light.json
node .pi/skills/verify-mydocuments/scripts/drive.mjs --run-id <run-id> --scenario .pi/skills/verify-mydocuments/features/scenarios/reliability-conflict-layout-dark.json
node .pi/skills/verify-mydocuments/scripts/drive.mjs --run-id <run-id> --scenario .pi/skills/verify-mydocuments/features/scenarios/reliability-conflict-layout-narrow.json
node .pi/skills/verify-mydocuments/scripts/drive.mjs --run-id <run-id> --scenario .pi/skills/verify-mydocuments/features/scenarios/reliability-draft-recovery.json
node .pi/skills/verify-mydocuments/scripts/drive.mjs --run-id <run-id> --scenario .pi/skills/verify-mydocuments/features/scenarios/reliability-recovery-dialog.json
node .pi/skills/verify-mydocuments/scripts/drive.mjs --run-id <run-id> --scenario .pi/skills/verify-mydocuments/features/scenarios/reliability-session-close.json
```

証跡は conflict-bar.png、diff-dialog.png、save-conflict.png、reliability-conflict-layout-light.png、reliability-conflict-layout-dark.png、reliability-conflict-layout-narrow.png、recovery-dialog.png、close-confirm.png と、各 observations.json（draft、backup、files の値）。

## Gotchas

- 競合バーが本文を隠すかどうかは、スクリーンショットだけでなく bounding box の交差で判定する。行は、本文の領域（.cm-scroller）で切り取った見えている部分で数える。領域の外へスクロールされた行や、端で切れた行の外側は数えない。レイアウトのシナリオは、競合バーが本文に重なっていた版では、この判定（eval が 0）で失敗する。
- 競合バーは出現時に 0.2 秒かけて現れる（Reduced Motion では付けない）。expect の visible は不透明度が 0 の間も真になるので、スクリーンショットの前に opacity が 1 になるまで待つ。待たずに撮ると、バーが写らない。
- 競合バーの出現・消失とカーソル行（表示領域の下端のカーソル、バーが短くなる選択後、保存での消失）、外観パネルとの位置関係、420 幅の折り返し、自動非表示、Reduced Motion は、このシナリオの範囲外で、tests/e2e/conflict-bar.spec.ts が確かめる。
- 保存直前の検査（REL-5）の検証は、externalWrite の notify を false にする。通知ありだと、先に競合バーが出て、保存直前の検査を通らない。
- 草稿の書き込みは入力が止まってから約 2 秒後。expect の timeout を 6000ms 程度にし、固定の待ちを足さない。入力直後に「まだ 0 件」を確かめる expect は、短い timeout（500ms）で評価する。
- メモリ bridge の drafts とバックアップは、ページの再読み込みで消える。reliability-session-close.json の reload は、seed を再注入するので前回の文書が開き直る。本物のアプリの再起動（草稿がディスクに残ること）の検証にはならない。実際の草稿の永続化は src-tauri の cargo test が担い、この Skill では未検証。
- 復旧のシナリオは、seed の drafts に baseRevisionOfFile を書いて、草稿の元になったディスクの revision と合わせている。外部で書き換えた後の草稿を復元すると、競合として扱われる（tests/e2e/reliability.spec.ts にある。この Skill のシナリオには含めない）。
- 実際のファイル監視（macOS の FSEvents など）の通知は、メモリ bridge では emitDocumentChanged で代用している。OS の監視が通知を落とす、遅らせる挙動は未検証。
- 窓を閉じる操作は requestClose の代用で、Cmd+Q や閉じるボタンそのものは未検証。Tauri 窓にはキーを送らない。
- 終了確認のシナリオで closed が false のままかを確かめる expect は短い timeout にしてある。長くすると遅くなるだけで、判定は変わらない。
