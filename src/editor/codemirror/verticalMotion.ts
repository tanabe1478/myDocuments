import { EditorSelection, Prec, type Extension, type SelectionRange } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';

/**
 * 上下キーのカーソル移動で、低い行を飛ばさないようにする（ED-03）。
 *
 * CodeMirror の上下移動は、カーソルの下端（上端）から半行ぶん先の位置を探し、そこにある行へ移る。
 * 段落間隔を詰めた空行（半行より低い行）や、続く低い行は、その探す位置を越えてしまい、飛ばされる。
 * そこで、標準の移動が論理行を 2 行以上動かしたときだけ、隣の行へ移し直す。
 * 折り返した行の中の移動や、標準の移動が正しいときは、標準のままにする。
 */
function moveOneLine(view: EditorView, range: SelectionRange, forward: boolean, extend: boolean): SelectionRange {
  const { doc } = view.state;
  let moved = view.moveVertically(range, forward);
  const startLine = doc.lineAt(range.head).number;
  const movedLine = doc.lineAt(moved.head).number;
  const step = forward ? 1 : -1;
  if ((movedLine - startLine) * step > 1) {
    const target = doc.line(startLine + step);
    const rect = view.contentDOM.getBoundingClientRect();
    const startCoords = view.coordsAtPos(range.head);
    const goal = moved.goalColumn ?? range.goalColumn ?? (startCoords ? startCoords.left - rect.left : 0);
    let pos: number;
    if (/^\s*$/.test(target.text)) {
      // 空白だけの行には、位置を決める文字がない。行の末尾へ。
      pos = target.to;
    } else {
      const block = view.lineBlockAt(target.from);
      const y = view.documentTop + (forward ? block.top + 1 : block.bottom - 1);
      pos = Math.min(Math.max(view.posAtCoords({ x: rect.left + goal, y }, false), target.from), target.to);
    }
    moved = EditorSelection.cursor(pos, forward ? 1 : -1, undefined, goal);
  }
  return extend ? EditorSelection.range(range.anchor, moved.head, moved.goalColumn) : moved;
}

function command(forward: boolean, extend: boolean) {
  return (view: EditorView): boolean => {
    const { state } = view;
    view.dispatch({
      selection: EditorSelection.create(
        state.selection.ranges.map((r) => moveOneLine(view, r, forward, extend)),
        state.selection.mainIndex,
      ),
      scrollIntoView: true,
      userEvent: 'select',
    });
    return true;
  };
}

export function verticalMotionExtension(): Extension {
  return Prec.high(
    keymap.of([
      { key: 'ArrowDown', run: command(true, false), shift: command(true, true) },
      { key: 'ArrowUp', run: command(false, false), shift: command(false, true) },
    ]),
  );
}
