import { Annotation, Facet } from '@codemirror/state';

/*
 * 部品どうしが互いを import しないための、共通の約束。
 * 部品はこの 2 つを介してだけ、ホストや別の部品と協調する（DOM の class など、見えない結びつきを使わない）。
 */

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
