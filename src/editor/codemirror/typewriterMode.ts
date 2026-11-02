import type { Extension } from '@codemirror/state';
import { EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view';
import { typewriterPadding, typewriterScrollTop } from '../typewriter';
import { TOGGLE_TASK_EVENT } from './taskToggle';

const PAD_VAR = '--md-typewriter-pad';
/** 描画範囲外の行へ飛んだとき、近くまで動かしてから測り直す回数の上限。 */
const MAX_REMEASURE = 3;

interface Measure {
  scrollTop: number;
  caretCenter: number;
  viewportHeight: number;
  maxScrollTop: number;
  /** カーソル行がまだ描画されておらず、推定で中心を求めた。 */
  estimated: boolean;
}

class TypewriterPlugin {
  private readonly observer: ResizeObserver | null;
  private remeasures = 0;

  constructor(private readonly view: EditorView) {
    this.observer =
      typeof ResizeObserver === 'function'
        ? new ResizeObserver(() => {
            this.updatePadding();
            this.schedule();
          })
        : null;
    this.observer?.observe(view.scrollDOM);
    this.updatePadding();
    this.schedule();
  }

  update(update: ViewUpdate): void {
    if (!update.selectionSet && !update.docChanged) return;
    // ポインタでの選択は動かさない（クリックした行が、ポインタの下から動くのを避ける）。
    if (update.transactions.some((tr) => tr.isUserEvent('select.pointer'))) return;
    // チェックボックスのクリックでの切り替えも、カーソルを動かさないので、スクロールしない（taskToggle.ts）。
    if (update.transactions.some((tr) => tr.isUserEvent(TOGGLE_TASK_EVENT))) return;
    this.remeasures = 0;
    this.schedule();
  }

  destroy(): void {
    this.observer?.disconnect();
    this.view.dom.style.removeProperty(PAD_VAR);
  }

  /** 本文の上下に、表示領域の半分の余白を付ける（先頭・末尾の行も中央に置けるように）。 */
  private updatePadding(): void {
    const h = this.view.scrollDOM.clientHeight;
    if (h > 0) this.view.dom.style.setProperty(PAD_VAR, `${typewriterPadding(h)}px`);
  }

  private schedule(): void {
    this.view.requestMeasure<Measure>({
      key: this,
      read: (view) => {
        const head = view.state.selection.main.head;
        const scroller = view.scrollDOM;
        const rect = scroller.getBoundingClientRect();
        const coords = view.coordsAtPos(head);
        let caretCenter: number;
        let estimated = false;
        if (coords) {
          caretCenter = (coords.top + coords.bottom) / 2 - rect.top;
        } else {
          const block = view.lineBlockAt(head);
          caretCenter = block.top + view.documentPadding.top + block.height / 2 - scroller.scrollTop;
          estimated = true;
        }
        return {
          scrollTop: scroller.scrollTop,
          caretCenter,
          viewportHeight: scroller.clientHeight,
          maxScrollTop: scroller.scrollHeight - scroller.clientHeight,
          estimated,
        };
      },
      write: (m, view) => {
        if (m.viewportHeight <= 0) return;
        const next = typewriterScrollTop(m);
        // スクロールにアニメーションは使わない（Reduced Motion でも同じ挙動）。
        if (Math.abs(next - m.scrollTop) >= 0.5) view.scrollDOM.scrollTop = next;
        if (m.estimated && this.remeasures++ < MAX_REMEASURE) this.schedule();
      },
    });
  }
}

/** タイプライターモード（UI-07）: カーソル行を、表示領域の縦中央に保つ。 */
export function typewriterModeExtension(): Extension {
  return [ViewPlugin.fromClass(TypewriterPlugin), EditorView.editorAttributes.of({ class: 'cm-typewriter' })];
}
