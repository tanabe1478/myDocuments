# タイピング音の素材

このフォルダの WAV ファイル 10 個は、Unicae Games の「Keyboard Soundpack #1」の単発の打鍵音（Single Keys）。バイト列は元のまま（形式の変換、音量の正規化、切り詰めをしていない）。

- 出典: https://opengameart.org/content/keyboard-soundpack-1-typing-and-single-keystrokes （OpenGameArt、node 122745）
- 作者: Unicae Games
- ライセンス: CC0 1.0（パブリックドメインへの提供。OpenGameArt のページの License 欄。配布物の readme.txt にも「Free to use however you like.」とある）
- 録音: キーボードは Cherry KC 1000（メンブレン式）、マイクは Shure SM7B、後処理は iZotope Neutron 2（配布物の readme.txt による）
- 元の配布ファイル（pack.zip）の SHA-256: `935eae2fa5c3742eacdd38c4ea0e9047f3887faa0701996498492c256db1b351`
- 形式: 1ch、44100 Hz、16bit、0.25 秒、25260 バイト

使ったファイル（zip の Single Keys フォルダの中の同名のファイル）と、それぞれの SHA-256:

| ファイル | SHA-256 |
|---|---|
| keypress-001.wav | `7b873548c399b9aa0efbe63052fe1344c5317a9b23455b8be3523f47d434daf1` |
| keypress-003.wav | `d67cf9547d99fc65c815c4c68fa9181e0af71419761cbb1d1f0a10eb8491a8d2` |
| keypress-007.wav | `522834f471e6c2935fd1e6a28042c0864925556efbec32c36d7c7a98026d4bfc` |
| keypress-008.wav | `c2ab8722a81a2f1cab66cd863a09a9ec00392e2ede61362b3707a7bcc0eee506` |
| keypress-010.wav | `3a65bf93ec554b068b0a64d11d2bb521cd54e7a9e7ef3362a670efb1e410f0dc` |
| keypress-011.wav | `72e79b249040bff166be863dd75f5c50d6e22bf904bd7e0adab1b30941e19968` |
| keypress-013.wav | `a73d12a22403fe7b63a3da41ff07f13f956e3a30b397196288262d467f1e28c3` |
| keypress-015.wav | `39df76e16d6daa76619f17b724ed4fdcfacc3d0c311103f6d45dc23ec3634678` |
| keypress-019.wav | `9cdb32c0074eaa114f8740e80bdfc28b1b44b4c6789371e1ec872e185e92d49e` |
| keypress-028.wav | `a324dd279d5422bc2328e49122cdd39d071faccaf109332602f6ede13686ada7` |

選んだ理由: 32 個ある単発の打鍵音のうち、RMS が -34 dB から -30 dB の範囲に収まり、極端に小さいもの・大きいものを除いた 10 個。音量の差は、再生側の gain（src/features/typing-sound/player.ts）で吸収する。
