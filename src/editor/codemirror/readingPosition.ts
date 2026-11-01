import type { Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';

/** カーソルを置いておく、表示領域の上下の余白（表示領域の高さに対する割合）。 */
export const CARET_MARGIN_RATIO = 0.3;

/**
 * 視線の位置: カーソルが表示領域の下 3 割（上 3 割）に入ったら、カーソル行がその境目に来るまでスクロールする。
 * 文末で書き足しても、カーソルが画面の下端に張り付かない。CodeMirror のスクロールの仕組み
 * （scrollMargins）を使うので、スクロールは一度の即時の移動で、Reduced Motion に関係なく動きは付かない。
 * 表示だけの変更で、本文の DOM には触れない。
 * タイプライターモードのときは、typewriterMode.ts が中央に保つので、ここでは余白を足さない。
 */
export function readingPositionExtension(): Extension {
  return EditorView.scrollMargins.of((view) => {
    if (view.dom.classList.contains('cm-typewriter')) return null;
    const margin = Math.round(view.scrollDOM.clientHeight * CARET_MARGIN_RATIO);
    return { top: margin, bottom: margin };
  });
}
