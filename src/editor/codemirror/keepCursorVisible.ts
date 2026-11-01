import type { Extension } from '@codemirror/state';
import { EditorView, ViewPlugin } from '@codemirror/view';

/** 縮んだ後の表示領域の端から、カーソル行を離す余白（px）。 */
const MARGIN_PX = 24;

/**
 * 本文の表示領域が縮んだとき（競合バーの出現など、本文の外のレイアウトの変化）に、
 * 縮む前に見えていたカーソル行が領域の外へ出るなら、近くまでスクロールして見える位置に保つ。
 * 縮む前から見えていなかったカーソルは動かさない（スクロールで離れた位置を、勝手に引き戻さない）。
 * 領域が広がるとき（バーの消失）は、本文の中の位置が変わらないので何もしない。
 *
 * 併せて、本文の上の余白（.cm-content の padding-top。競合バーの表示中は styles.css が詰める）が変わったとき、
 * 見えている行が画面上で動かないよう、スクロール位置を余白の変化ぶんだけずらす（先頭にいるときは、余白の変化をそのまま見せる）。
 * タイプライターモードは、自分で縦中央に保つので対象外。
 */
class KeepCursorVisiblePlugin {
  private readonly observer: ResizeObserver | null;
  private height: number;
  private padTop: number;
  private typewriter: boolean;

  constructor(private readonly view: EditorView) {
    this.height = view.scrollDOM.clientHeight;
    this.padTop = this.readPadTop();
    this.typewriter = this.isTypewriter();
    this.observer =
      typeof ResizeObserver === 'function'
        ? new ResizeObserver(() => this.onResize())
        : null;
    this.observer?.observe(view.scrollDOM);
    // 余白の変化は、領域の大きさではなく本文の高さの変化として届く。
    this.observer?.observe(view.contentDOM);
  }

  destroy(): void {
    this.observer?.disconnect();
  }

  private readPadTop(): number {
    return parseFloat(getComputedStyle(this.view.contentDOM).paddingTop) || 0;
  }

  private isTypewriter(): boolean {
    return this.view.dom.classList.contains('cm-typewriter');
  }

  /** 本文の上の余白が変わったぶん、スクロール位置をずらして、見えている行を画面上の同じ位置に保つ。 */
  private followPaddingChange(): void {
    const padTop = this.readPadTop();
    const typewriter = this.isTypewriter();
    const delta = padTop - this.padTop;
    const skip = typewriter || this.typewriter;
    this.padTop = padTop;
    this.typewriter = typewriter;
    if (delta === 0) return;
    // CodeMirror は余白を測定のときに読む。CSS だけで変わったときは測り直させないと、カーソルと選択の描画が古い位置に残る。
    this.view.requestMeasure();
    if (skip) return;
    const scroller = this.view.scrollDOM;
    if (scroller.scrollTop > 0) scroller.scrollTop = Math.max(0, scroller.scrollTop + delta);
  }

  private onResize(): void {
    const view = this.view;
    this.followPaddingChange();
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
