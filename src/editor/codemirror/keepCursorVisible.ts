import type { Extension } from '@codemirror/state';
import { EditorView, ViewPlugin } from '@codemirror/view';

/** 縮んだ後の表示領域の端から、カーソル行を離す余白（px）。 */
const MARGIN_PX = 24;

/**
 * 本文の表示領域が縮んだとき（競合バーの出現など、本文の外のレイアウトの変化）に、
 * 縮む前に見えていたカーソル行が領域の外へ出るなら、近くまでスクロールして見える位置に保つ。
 * 縮む前から見えていなかったカーソルは動かさない（スクロールで離れた位置を、勝手に引き戻さない）。
 * 領域が広がるとき（バーの消失）は、本文の中の位置が変わらないので何もしない。
 */
class KeepCursorVisiblePlugin {
  private readonly observer: ResizeObserver | null;
  private height: number;

  constructor(private readonly view: EditorView) {
    this.height = view.scrollDOM.clientHeight;
    this.observer =
      typeof ResizeObserver === 'function'
        ? new ResizeObserver(() => this.onResize())
        : null;
    this.observer?.observe(view.scrollDOM);
  }

  destroy(): void {
    this.observer?.disconnect();
  }

  private onResize(): void {
    const view = this.view;
    const previous = this.height;
    const height = view.scrollDOM.clientHeight;
    this.height = height;
    if (previous <= 0 || height <= 0 || height >= previous) return;

    const head = view.state.selection.main.head;
    const coords = view.coordsAtPos(head);
    if (!coords) return; // 描画範囲の外（もともと見えていない）
    // 領域の上端を基準にした位置。縮む前後で、本文の中の位置（スクロール量）は変わらない。
    const top = coords.top - view.scrollDOM.getBoundingClientRect().top;
    const bottom = coords.bottom - view.scrollDOM.getBoundingClientRect().top;
    const wasVisible = top >= 0 && bottom <= previous;
    const isVisible = top >= 0 && bottom <= height;
    if (wasVisible && !isVisible) {
      view.dispatch({ effects: EditorView.scrollIntoView(head, { y: 'nearest', yMargin: MARGIN_PX }) });
    }
  }
}

export function keepCursorVisibleExtension(): Extension {
  return ViewPlugin.fromClass(KeepCursorVisiblePlugin);
}
