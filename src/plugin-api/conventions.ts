import { Annotation, Facet } from '@codemirror/state';

/*
 * 部品どうしが互いを import しないための、共通の約束。
 * 部品はこれらを介してだけ、ホストや別の部品と協調する（DOM の class など、見えない結びつきを使わない）。
 */

/**
 * IME の変換が終わってから、保留していた再計算（装飾の作り直し）をするまでの待ち（ミリ秒）。
 * CodeMirror が変換の終了を確定する時間より後に取る。変換中は装飾の再計算を保留し、変換が終わったこの時間の後に
 * まとめて行う。ホストの記法の隠し方と、変換の終了に追従する部品（フォーカスモード）が、同じ値を使う。
 */
export const AFTER_COMPOSITION_MS = 60;

/**
 * 「この変更では、カーソルに追従してスクロールしなくてよい」という transaction の印。
 * カーソルも選択も動かさない変更（チェックボックスのクリックでの切り替えなど）が付ける。
 * カーソルを画面の特定の位置に保つ部品は、この印のある変更では保とうとしない。
 */
export const skipCaretFollow = Annotation.define<boolean>();

/**
 * 「カーソルのスクロールは、この部品が受け持つ」という宣言。受け持つ部品が `ownsCaretScroll.of(true)` を
 * 拡張に含める。ホストの既定のスクロールの補助（視線の位置の余白、縮んだ領域でのカーソルの保持）は、
 * いずれかの部品が宣言しているとき、自分の動作を止める。
 */
export const ownsCaretScroll = Facet.define<boolean, boolean>({
  combine: (values) => values.some(Boolean),
});
