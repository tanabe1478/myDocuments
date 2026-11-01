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
function moveOneLine(view: EditorView, range: SelectionRange, forward: boolean): SelectionRange {
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
  return moved;
}

/**
 * @codemirror/commands の cursorLineUp / cursorLineDown（cursorByLine）と同じ動き。
 * 選択範囲があれば、その端（上なら先頭、下なら末尾）へ畳む。空なら 1 行動き、動かなければ（先頭行・末尾行）行の端へ。
 */
function cursorByLine(view: EditorView, forward: boolean): boolean {
  const { state } = view;
  const selection = EditorSelection.create(
    state.selection.ranges.map((range) => {
      if (!range.empty) return EditorSelection.cursor(forward ? range.to : range.from);
      const moved = moveOneLine(view, range, forward);
      return moved.head !== range.head ? moved : view.moveToLineBoundary(range, forward);
    }),
    state.selection.mainIndex,
  );
  if (selection.eq(state.selection, true)) return false;
  view.dispatch({ selection, scrollIntoView: true, userEvent: 'select' });
  return true;
}

/** selectLineUp / selectLineDown（selectByLine）と同じ動き。anchor を残して head を 1 行動かす。 */
function selectByLine(view: EditorView, forward: boolean): boolean {
  const { state } = view;
  const selection = EditorSelection.create(
    state.selection.ranges.map((r) => {
      const range = r.undirectional && r.head >= r.anchor !== forward ? EditorSelection.range(r.head, r.anchor) : r;
      const head = moveOneLine(view, range, forward);
      return EditorSelection.range(range.anchor, head.head, head.goalColumn, head.bidiLevel || undefined, head.assoc);
    }),
    state.selection.mainIndex,
  );
  if (selection.eq(state.selection)) return false;
  view.dispatch({ selection, scrollIntoView: true, userEvent: 'select' });
  return true;
}

/**
 * 行単位の上下移動を担う、defaultKeymap のキーをすべて上書きする。
 * ArrowUp / ArrowDown と、mac の Ctrl-p / Ctrl-n（emacs 風。Shift 付きを含む）。
 * ページ単位（PageUp / PageDown、mac の Ctrl-ArrowUp / Ctrl-ArrowDown）は、1 画面ぶん動くので対象外。
 */
export function verticalMotionExtension(): Extension {
  return Prec.high(
    keymap.of([
      { key: 'ArrowDown', run: (v) => cursorByLine(v, true), shift: (v) => selectByLine(v, true), preventDefault: true },
      { key: 'ArrowUp', run: (v) => cursorByLine(v, false), shift: (v) => selectByLine(v, false), preventDefault: true },
      { mac: 'Ctrl-n', run: (v) => cursorByLine(v, true), shift: (v) => selectByLine(v, true) },
      { mac: 'Ctrl-p', run: (v) => cursorByLine(v, false), shift: (v) => selectByLine(v, false) },
    ]),
  );
}
