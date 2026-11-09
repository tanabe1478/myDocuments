/**
 * 表のキー操作（ADR-006）。
 * - Tab / Shift+Tab: 原文の表の中（選択が空）で、次と前のセルの中身の頭へカーソルを移す。設定「記号の表示」によらない。
 *   本体の字下げのキー割り当てが、Esc の直後でなければ、先に呼ぶ（plugin-api の tabHandlers）。
 * - ArrowUp / ArrowDown（mac の Ctrl-p / Ctrl-n を含む）: 表示中の表の上と下の行から、表の中へ入る（表を飛ばさない）。
 * どちらも、カーソルを動かすだけで、文書は変えない。
 */
import { syntaxTree } from '@codemirror/language';
import { EditorSelection, Prec, type Extension } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { tabHandlers } from '../../plugin-api';
import { renderedTables } from './tableDisplay';
import { buildTableModel, tableAtPos, tabTarget } from './tableModel';

/** Tab（backward が false）/ Shift+Tab を、表の中なら受ける。受けたら true（動けないときも、キーは受ける）。 */
export function tableTab(view: EditorView, backward: boolean): boolean {
  const { state } = view;
  const { main, ranges } = state.selection;
  if (ranges.length !== 1 || !main.empty) return false;
  const table = tableAtPos(syntaxTree(state), state.doc, main.head);
  if (!table) return false;
  // IME の変換中は何もしない（フォーカスも字下げも動かさない）。
  if (view.composing || view.compositionStarted) return true;
  const model = buildTableModel(table, state.doc);
  const target = model ? tabTarget(model, main.head, backward) : null;
  if (target !== null) {
    view.dispatch({ selection: EditorSelection.cursor(target), scrollIntoView: true, userEvent: 'select' });
  }
  return true;
}

/**
 * 表示中の表の隣の行から、上下キーで表の中へ入る。入る行は、下へなら見出しの行、上へなら最後の行。
 * 桁は、いまの行の桁を、入る行の長さに収めたもの。表を飛ばす標準の移動より先に受けるので、
 * 折り返した行の途中の移動（標準のまま）は、ここで受けない。
 */
function enterTable(view: EditorView, forward: boolean, extend: boolean): boolean {
  const { state } = view;
  const { main, ranges } = state.selection;
  if (ranges.length !== 1 || (!extend && !main.empty)) return false;
  const line = state.doc.lineAt(main.head);
  const next = forward ? line.number + 1 : line.number - 1;
  const table = renderedTables(state).find((t) => (forward ? t.firstLine : t.lastLine) === next);
  if (!table) return false;
  // 折り返した行の途中なら、標準の移動（同じ行の中）に任せる。
  if (state.doc.lineAt(view.moveVertically(EditorSelection.cursor(main.head), forward).head).number === line.number) return false;
  const target = state.doc.line(next);
  const pos = target.from + Math.min(main.head - line.from, target.length);
  view.dispatch({
    selection: extend ? EditorSelection.range(main.anchor, pos) : EditorSelection.cursor(pos),
    scrollIntoView: true,
    userEvent: 'select',
  });
  return true;
}

/** 表のキー操作の拡張。上下の移動は、本体の上下キーより先に受ける（受けなければ標準のまま）。 */
export function tableKeys(): Extension {
  return [
    tabHandlers.of(tableTab),
    Prec.highest(
      keymap.of([
        { key: 'ArrowDown', run: (v) => enterTable(v, true, false), shift: (v) => enterTable(v, true, true) },
        { key: 'ArrowUp', run: (v) => enterTable(v, false, false), shift: (v) => enterTable(v, false, true) },
        { mac: 'Ctrl-n', run: (v) => enterTable(v, true, false), shift: (v) => enterTable(v, true, true) },
        { mac: 'Ctrl-p', run: (v) => enterTable(v, false, false), shift: (v) => enterTable(v, false, true) },
      ]),
    ),
  ];
}
