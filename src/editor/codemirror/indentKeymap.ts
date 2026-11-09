import { Prec, type Extension } from '@codemirror/state';
import { searchPanelOpen } from '@codemirror/search';
import { EditorView, keymap } from '@codemirror/view';
import { tabHandlers } from '../../plugin-api';
import { planIndentLess, planIndentMore, type LineEdit } from '../indent';

/** 選択している行（空でない範囲が次の行の頭で終わるときは、その行を含めない）。 */
function selectedLines(view: EditorView): number[] {
  const { doc, selection } = view.state;
  const numbers = new Set<number>();
  for (const range of selection.ranges) {
    const first = doc.lineAt(range.from).number;
    let last = doc.lineAt(range.to).number;
    if (!range.empty && last > first && doc.line(last).from === range.to) last--;
    for (let n = first; n <= last; n++) numbers.add(n);
  }
  return [...numbers].sort((a, b) => a - b);
}

function indent(view: EditorView, plan: (text: string, multi: boolean) => LineEdit | null): boolean {
  const lines = selectedLines(view);
  const multi = lines.length > 1;
  const changes = [];
  for (const n of lines) {
    const line = view.state.doc.line(n);
    const edit = plan(line.text, multi);
    if (edit) changes.push({ from: line.from + edit.from, to: line.from + edit.to, insert: edit.insert });
  }
  // 変えるものがなくても、Tab は本文の中で受ける（フォーカスは動かさない、タブ文字も入れない）。
  if (changes.length === 0) return true;
  const set = view.state.changes(changes);
  view.dispatch({
    changes: set,
    // 行頭にあるカーソルは、足した字下げの後ろへ動かす。
    selection: view.state.selection.map(set, 1),
    scrollIntoView: true,
    userEvent: 'input.indent',
  });
  return true;
}

const MODIFIER_KEYS = new Set(['Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'Tab']);

/**
 * Tab / Shift+Tab でリストと引用をインデントする（方針は ../indent.ts）。
 * 本文で Tab を受けると、キーボードだけで本文の外へ出られなくなるので、Esc の直後の Tab は本文の外へ
 * フォーカスを移す（CodeMirror の indentWithTab の推奨作法）。F6 での移動も使える。
 */
export function indentKeymap(): Extension {
  // Esc を押した直後か。ほかのキーを押すか、フォーカスが外れると解除する。state ごとに 1 つ。
  let escaped = false;
  const run = (plan: (text: string, multi: boolean) => LineEdit | null, backward: boolean) => (view: EditorView) => {
    if (escaped) {
      escaped = false;
      return false;
    }
    // 部品（表のセルの移動など）が先に受けられる。受けたら字下げはしない。
    if (view.state.facet(tabHandlers).some((handle) => handle(view, backward))) return true;
    return indent(view, plan);
  };
  return [
    EditorView.domEventObservers({
      keydown(event, view) {
        if (event.isComposing || event.keyCode === 229) return;
        if (event.key === 'Escape') {
          // 検索パネルを閉じる Esc は、Tab のための Esc ではない。
          escaped = !searchPanelOpen(view.state);
        } else if (!MODIFIER_KEYS.has(event.key)) {
          escaped = false;
        }
      },
      blur() {
        escaped = false;
      },
    }),
    Prec.high(
      keymap.of([
        { key: 'Tab', run: run(planIndentMore, false) },
        { key: 'Shift-Tab', run: run((text) => planIndentLess(text), true) },
      ]),
    ),
  ];
}
