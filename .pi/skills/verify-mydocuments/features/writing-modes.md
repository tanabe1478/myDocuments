# 執筆モード

## Sub-features

- MODE-1: フォーカスモード。カーソルのある段落以外の行を弱く表示し（行に cm-md-dim が付く）、カーソル移動と入力に追従する。本文は変わらない。
- MODE-2: タイプライターモード。カーソル行を表示領域の中央（±1 行）に保ち、本文の上下に表示領域の半分の余白を付ける。切ると元に戻る。
- MODE-3: 入力中は上下のバーを隠す（自動非表示）。マウス移動で再表示される。外観パネルを開いている間は隠れない。
- MODE-4: F6 で 本文、上部バー、下部バー、本文 の順にフォーカスが移る（Shift+F6 は逆順）。隠れていても届き、バーが再表示される。
- MODE-5: 全画面ショートカット。macOS は Ctrl+Cmd+F、Windows と Linux は F11。他の OS のキーでは切り替わらない。

## How to get to it (user POV)

- フォーカスモード: Mod+Shift+F。外観パネルの「執筆の補助」の「フォーカスモード」チェック。保存済みの設定（focusMode）が起動時に反映される。
- タイプライターモード: Mod+Shift+T。外観パネルの「タイプライターモード」チェック。保存済みの設定（typewriterMode）。
- 自動非表示: 外観パネルの「入力中は上下のバーを隠す」チェック（既定は ON）。入力で隠れ、マウス移動で戻る。
- F6 / Shift+F6、バーへの Tab（隠れていると表示される）、外観ボタンでの Enter。
- 全画面: macOS は Ctrl+Cmd+F、Windows と Linux は F11。
- 入力欄（font-family の自由入力など）にフォーカスがあるときは、Mod+Shift+F と Mod+Shift+T は無視される。本文へ戻れば効く。

## Driving it with Playwright（メモリ bridge）

Preconditions: Launch 済みで Doctor が全 PASS。modes-autohide-fullscreen.json は platform が mac を指定しているので、ホスト OS に関わらず macOS のキー（Cmd）で動く。フォーカスモードのシナリオは autoHideChrome を false にして、バーの自動非表示が操作を邪魔しないようにしてある。

| シナリオ | user action | 観測できる結果 |
|---|---|---|
| modes-focus-typewriter.json | 文書を開き、Mod+Shift+F、ArrowDown ×3、Mod+Shift+F。160 行の文書を開き、Mod+Shift+T、Mod+End、Mod+Home、Mod+Shift+T | dim の並びが、OFF の全部 false から、ON 直後の false が 2 つ続いた後に true が 4 つへ。ArrowDown で段落が入れ替わる。保存された設定の focusMode が true。タイプライターは上の余白が表示領域の半分、末尾と先頭でカーソルが中央 ±1 行、切ると余白が元に戻り typewriterMode が false |
| modes-autohide-fullscreen.json | 入力、マウス移動、F6 ×3、Shift+F6 ×2、Enter、Esc、Ctrl+Cmd+F ×2、F11 | 入力で .app の data-chrome が hidden になり .topbar の opacity が 0。マウス移動で visible。F6 で appearance-button、char-count、本文の順に focused。Enter で外観パネルが開き、Esc で appearance-button に戻る。Ctrl+Cmd+F で fullscreen が true（calls 1）、もう一度で false（calls 2）、F11 では calls が 2 のまま |

```
node .pi/skills/verify-mydocuments/scripts/drive.mjs --run-id <run-id> --scenario .pi/skills/verify-mydocuments/features/scenarios/modes-focus-typewriter.json
node .pi/skills/verify-mydocuments/scripts/drive.mjs --run-id <run-id> --scenario .pi/skills/verify-mydocuments/features/scenarios/modes-autohide-fullscreen.json
```

Windows と Linux の全画面（F11）は、シナリオを複製して platform を windows にし、キーを F11 に変えて確かめる（この Skill には複製を同梱していない）。画像は focus-mode-on.png、typewriter-on-end.png、chrome-hidden.png。

## Gotchas

- 全画面は、メモリ bridge では fullscreen の真偽値と呼ばれた回数が変わるだけで、実際の窓は全画面にならない。窓の全画面化は未検証（Tauri 窓は観測のみで、キーを送らない）。
- マウス移動の再表示は、ポインタが実際に動いたときだけ起きる。mouseMove を 2 回以上、位置を変えて送る（シナリオは 2 回）。
- 自動非表示の既定は ON。バーを操作するシナリオ（外観ボタンのクリックなど）の seed で autoHideChrome を false にしないと、入力後にバーが隠れて pointer-events が無効になる。
- タイプライターモードは、キーボード移動と入力でだけカーソル行を中央へ寄せる。ポインタのクリックでは動かさないので、クリックで位置を作った後の中央判定は失敗する（仕様どおり）。
- スクロールの収束には時間がかかる。中央判定は expect の timeout（既定 3000ms）で待つ。固定の待ちで済ませない。
- OS ごとの全画面キーは、navigator.platform で決まる。Ctrl+Cmd+F の検証には platform の指定が必要で、省略するとホスト OS のキーになる。
- 実 IME でのフォーカスモード、タイプライターモードの挙動（変換中の dim）は、この Skill のシナリオに含まない。
