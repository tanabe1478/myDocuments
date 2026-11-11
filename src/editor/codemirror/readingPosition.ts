import type { Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { ownsCaretScroll, suspendReadingMargins } from '../../plugin-api';

/** カーソルを置いておく、表示領域の上下の余白（表示領域の高さに対する割合）。 */
export const CARET_MARGIN_RATIO = 0.3;

/**
 * 視線の位置: カーソルが表示領域の下 3 割（上 3 割）に入ったら、カーソル行がその境目に来るまでスクロールする。
 * 文末で書き足しても、カーソルが画面の下端に張り付かない。CodeMirror のスクロールの仕組み
 * （scrollMargins）を使うので、スクロールは一度の即時の移動で、Reduced Motion に関係なく動きは付かない。
 * 表示だけの変更で、本文の DOM には触れない。
 * カーソルのスクロールを受け持つ部品（ownsCaretScroll を宣言した部品）があるときは、その部品が位置を保つので、ここでは余白を足さない。
 * 補完の一覧のようなポップアップが開いている間（suspendReadingMargins）も足さない（余白の中にカーソルがあると、CodeMirror は一覧を描かない）。
 */
export function readingPositionExtension(): Extension {
  return EditorView.scrollMargins.of((view) => {
    if (view.state.facet(ownsCaretScroll) || view.state.facet(suspendReadingMargins).some((suspended) => suspended(view.state))) return null;
    const margin = Math.round(view.scrollDOM.clientHeight * CARET_MARGIN_RATIO);
    return { top: margin, bottom: margin };
  });
}
