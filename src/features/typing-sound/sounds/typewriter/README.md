# タイピング音の素材（タイプライター）

タイピング音の音色「タイプライター」の素材。CC0 のタイプライターの録音 8 個（original/）を、scripts/make-typewriter-sounds.mjs で柔らかく加工した 8 個（このフォルダの typewriter-1.wav から typewriter-8.wav）。original/ はアプリでは import しないので、配布物（dist）には入らない。もう 1 つの音色「キーボード」の素材と出典は ../README.md。

- 出典: https://opengameart.org/content/typewriter-sounds （OpenGameArt）
- 作者: Cassie-OrbitGames（ページの説明は「Recorded these on my phone for one of my games」）
- ライセンス: CC0 1.0（パブリックドメインへの提供。OpenGameArt のページの License(s) 欄）
- 元のファイル（original/）: バイト列は配布されたまま。形式は 22050 Hz、16bit（typewriter1.wav だけ 1ch、ほかは 2ch）。

| 元のファイル（original/） | SHA-256 |
|---|---|
| typewriter1.wav | `f860766aa7922afbf1523ea1a41504c64f3f6362fa03a60b6497c75c1d0d0344` |
| typewriter2.wav | `b40c17fe45c9e3a6ad8a617f7831da5ccb3c8baab1fa0eb368f8ba3ade52c8a4` |
| typewriter3.wav | `c9bb2c6245bdd60b996fe39f2fb74c810309ee03bbe2d8ae1ee6715888df9c69` |
| typewriter4.wav | `28d4c07732fbd6f324f257c27a92d8a3c14ea5c26517972295b288bb75d5a2c3` |
| typewriter5.wav | `f52a889a483985d40ca31ed97ddd86227a776650f4666f5899c86dfec6de2edf` |
| typewriter6.wav | `825b668508448212edbf8ddcff2801b0a6251528aaccdf8ab85427023cf0797f` |
| typewriter7.wav | `113210a80c394cb3ad0d8b7d773ff752b81cb42bb193efb4d11eb8379f736144` |
| typewriter8.wav | `c29966383e602df84db68577758e34f830deb01aff6a208579ee943511217118` |

## 加工

`node scripts/make-typewriter-sounds.mjs` が、元の 8 個（SHA-256 を確かめてから）を加工して、このフォルダの 8 個を書く。`--check` を付けると、作り直した結果が同梱のファイルとバイト列で一致するかを確かめる（違えば exit 1）。依存はない。加工の名前は「M1-mild」。

1. 2ch は平均して 1ch にする。
2. 1 次の IIR のローパス（カットオフ 3500 Hz）を 2 回掛ける。
3. 打撃の尖りを縮める（soften 0.4）。速い包絡（400 Hz のローパス）と遅い包絡（30 Hz）の比が 1 を超える分を、比の -0.4 乗で縮め、そのゲインを 200 Hz のローパスでなだらかにして掛ける。
4. 最初に最大値の 25% を超えた点の 8 ms 前から 0.22 秒を切り出し、最後の 60 ms を二乗のフェードで消す。
5. [-1, 1] に clip して 32767 倍し、int16 に切り捨てる。

出力は 1ch、16bit、22050 Hz、0.22 秒（4851 標本）、9746 バイト。

| 加工後のファイル | SHA-256 |
|---|---|
| typewriter-1.wav | `568933e0fb9b78164eb348ecfa7de2fa0b02c3eb7f6781165fa477e6c7be7da9` |
| typewriter-2.wav | `459233117c4526050b537c86c323688604aa2540314845ee8579bc6ab72b9354` |
| typewriter-3.wav | `bedcaaafcf768a4899b83d8facf77901fa102c9e1821106196b5490aaa61c525` |
| typewriter-4.wav | `af641fc7e0174b1c44cb9ccea94246a19cc33774258e6ee792ab7174f07e1dfc` |
| typewriter-5.wav | `43f903c6244ab4c238e047e98b4baeab0dcdf6796bc57b931c2e926a4e41ccaa` |
| typewriter-6.wav | `1ebdb18e0fe0f84011eb4e1a8e062e0e60d4ae7486bb8298d537465fa24117e0` |
| typewriter-7.wav | `dd71a7a7933de813ee56c649b904f7e83e73f582dd589072834076a234974528` |
| typewriter-8.wav | `599df77088b3cc30f41d3f707d5d764caed2909da2102592cbb42f387f69f61e` |

加工後のファイルは、元の録音を変えた二次的な著作物だが、元が CC0 なので、同じく CC0 として扱える。

## 鳴らし方

素材のファイルは、鳴り始めの位置を飛ばすために変えない。再生側（src/features/typing-sound/player.ts と onset.ts）が、デコードしたあと、素材ごとに「振幅が最大値の 10% を最初に超える点の 2 ms 前」を求め、そこから鳴らす。大きさは、キーボードと同じ音量の段階でそろうよう、音色ごとの gain（player.ts の TIMBRE_GAIN）を掛ける。
