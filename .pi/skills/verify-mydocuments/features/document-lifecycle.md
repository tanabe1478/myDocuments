# 文書の新規作成・開く・保存

## Sub-features

- DOC-1: 起動直後は無題の空文書。Mod+N で新しい無題の文書になる。
- DOC-2: Mod+O で文書を開く。表示は改行が LF に正規化され、BOM は本文に含まれない。
- DOC-3: Mod+S は、開いた文書の BOM と改行（LF / CRLF）を保ったまま上書きする。
- DOC-4: 無題の文書の Mod+S は、保存先を選んで保存する。既定は LF、BOM なし。保存先が決まった後は、ダイアログなしで上書きする。
- DOC-5: Mod+Shift+S は別名で保存し、保存先が変わる。元のファイルは変わらない。
- DOC-6: 内容が変わらないときは書かない。無変更の保存は bridge を呼ばず、既存ファイルと同一のバイト列になる別名保存は「書き込みませんでした」と通知して書かない。
- DOC-7: 編集すると、上部バーに未保存マークが出る。元の内容に戻ると消える。
- DOC-8: 混在改行のファイルは、多数派に揃えて保存し、その旨（多数派、CRLF など）を通知する。
- DOC-9: 未保存の変更があるとき Mod+N / Mod+O は確認ダイアログを出す。キャンセル、保存しない、保存の 3 択で、Esc はキャンセル。

## How to get to it (user POV)

文書の操作に専用のボタンはない。すべてキーボードショートカットで、窓を開いているだけで届く。

- 起動時: 前回の文書の再オープンと草稿の復旧は自動処理（save-reliability.md）。
- Mod+N（新規）、Mod+O（開く）、Mod+S（保存）、Mod+Shift+S（別名で保存）。Mod は macOS で Cmd、Windows と Linux で Ctrl。
- 窓を閉じる操作の確認は save-reliability.md。
- ファイル選択・保存先のダイアログは OS のネイティブで、このシナリオでは seed の openPath、savePath が戻り値の代わり（実ダイアログは未検証）。

## Driving it with Playwright（メモリ bridge）

Preconditions: Launch 済みで Doctor が全 PASS。run-id を `<run-id>` として使う。シナリオは seed でファイルと次のダイアログの戻り値を与え、毎回無題の空文書から始まる。コマンドの共通部分は `node .pi/skills/verify-mydocuments/scripts/drive.mjs --run-id <run-id> --scenario`。

| シナリオ | user action | 観測できる結果（expect と observe） |
|---|---|---|
| document-open-edit-save.json | Mod+O、末尾へ移動して「追記」と入力、Mod+S | 開いた後の doc-title が crlf-bom.md で、本文は LF 表示。入力で unsaved-mark が出る。保存前の observe では BOM あり、crlf 3、lf 0。保存後は unsaved-mark が消え、BOM あり、crlf 3、lf 0 のまま 42 バイト、log は written 1 件 |
| document-no-write-when-unchanged.json | 無変更で Mod+S、X を入力して Backspace、Mod+S、同一内容の別名保存 Mod+Shift+S | save、saveAs、physicalWrites の合計が 0。別名保存は toast に「書き込みませんでした」、log が outcome unchanged、physicalWrites は 0 のまま |
| document-new-save-as.json | 無題に入力して Mod+S、続けて入力して Mod+S、Mod+Shift+S | doc-title が new.md。ファイルは LF、BOM なしで「# 新規」と「本文」。2 回目はダイアログなしで saveAs 1、save 1 |
| document-mixed-eol.json | 混在改行のファイルを開き、「!」を追記して Mod+S | toast に「多数派」と「CRLF」。ファイルは全行 CRLF になり末尾が e! |
| document-unsaved-confirm.json | 入力後に Mod+N。キャンセル、Esc、保存、保存しない（Mod+O）を順に選ぶ | alertdialog が出る。キャンセルと Esc は本文が残る。保存を選ぶと saved-from-dialog.md に書かれ空の無題になる。保存しないを選ぶと note.md が開き、physicalWrites は 1 のまま |

例:

```
node .pi/skills/verify-mydocuments/scripts/drive.mjs --run-id <run-id> --scenario .pi/skills/verify-mydocuments/features/scenarios/document-open-edit-save.json
node .pi/skills/verify-mydocuments/scripts/drive.mjs --run-id <run-id> --scenario .pi/skills/verify-mydocuments/features/scenarios/document-no-write-when-unchanged.json
node .pi/skills/verify-mydocuments/scripts/drive.mjs --run-id <run-id> --scenario .pi/skills/verify-mydocuments/features/scenarios/document-new-save-as.json
node .pi/skills/verify-mydocuments/scripts/drive.mjs --run-id <run-id> --scenario .pi/skills/verify-mydocuments/features/scenarios/document-mixed-eol.json
node .pi/skills/verify-mydocuments/scripts/drive.mjs --run-id <run-id> --scenario .pi/skills/verify-mydocuments/features/scenarios/document-unsaved-confirm.json
```

Windows と Linux のショートカット（Ctrl）は、同じシナリオに `--platform windows`、`--platform linux` を付けて確かめる（navigator の偽装で、実機ではない）。証跡は evidence/<scenario 名>/observations.json と before-save.png などの画像。

## Gotchas

- 保存先がない無題の文書は、ダイアログを開く。savePath を seed に書かないと、キャンセルされた扱いになり、何も書かれず未保存のままになる（失敗ではなく正しい挙動）。
- 保存は、開いた（または保存先に選んだ）パスにだけできる。seed の files に置いただけのパスへ、開かずに保存することはできない。
- ファイルの本文を確かめるときは、画面ではなく observe の files（バイト列の BOM と改行の数）を見る。画面の本文は常に LF 表示で、BOM と CRLF の保存の検証にならない。
- 起動時に前回の文書を開き直す処理（session）と草稿の復旧は、seed に session と drafts を書いたときだけ動く。この feature のシナリオは書かないので、起動直後は必ず無題。
- メモリ bridge の書き込み規則は crates/docio の save_checked に合わせた実装で、正本は Rust 側。実ファイルへの書き込み（アトミックな置き換え、権限エラー）は、この Skill では確かめない。
- UTF-8 でないファイルを開いたときの拒否は、この feature のシナリオに含めていない（tests/e2e/document.spec.ts にある）。
