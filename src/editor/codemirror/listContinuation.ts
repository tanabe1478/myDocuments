import { insertNewlineContinueMarkupCommand } from '@codemirror/lang-markdown';
import { EditorSelection, Prec, type ChangeSpec, type Extension, type StateCommand, type Transaction } from '@codemirror/state';
import { keymap } from '@codemirror/view';
import type { ListContinuation } from '../../preferences/preferences';

/** 空白と引用の記号だけの行（継続のために足される空行は、リストの入れ子や引用の分の記号を含むことがある）。 */
const BLANK_SEPARATOR = /^[\s>]*$/;

/**
 * lang-markdown の Enter（insertNewlineContinueMarkup）の結果から、次の項目を続けるために足された空行だけを取り除く。
 *
 * lang-markdown は、項目の間に空行のあるリスト（loose list）で次の項目を続けるとき、リストの形を保つために
 * 次の項目の前にも空行を入れる（改行 + 空行 + 改行 + 記号の 3 行の挿入になる）。ほかの挿入は 1 行か 2 行なので、
 * 3 行の挿入だけが対象になる。空の項目での終了、入れ子を戻す、番号の付け直し、引用の継続は、そのまま通す。
 */
function withoutSeparatorBlankLine(state: Parameters<StateCommand>[0]['state'], tr: Transaction): Transaction {
  const specs: ChangeSpec[] = [];
  // 取り除いた文字数と、その挿入の終わりの位置（変更後の文書での位置）。
  const removed: { end: number; length: number }[] = [];
  tr.changes.iterChanges((fromA, toA, _fromB, toB, inserted) => {
    if (inserted.lines === 3 && inserted.line(1).text === '' && BLANK_SEPARATOR.test(inserted.line(2).text)) {
      const insert = state.lineBreak + inserted.line(3).text;
      specs.push({ from: fromA, to: toA, insert });
      removed.push({ end: toB, length: inserted.length - insert.length });
    } else {
      specs.push({ from: fromA, to: toA, insert: inserted });
    }
  });
  if (removed.length === 0) return tr;

  const selection = tr.selection;
  const shift = (pos: number) => pos - removed.reduce((sum, r) => (r.end <= pos ? sum + r.length : sum), 0);
  return state.update({
    changes: specs,
    selection: selection
      ? EditorSelection.create(
          selection.ranges.map((r) => EditorSelection.range(shift(r.anchor), shift(r.head))),
          selection.mainIndex,
        )
      : undefined,
    scrollIntoView: true,
    userEvent: 'input',
  });
}

/**
 * lang-markdown の既定の Enter。ただし、空行のないリスト（tight list）の空の 2 項目目で Enter を押したとき、
 * その項目の前に空行を入れてリストを loose にする動作（nonTightLists）だけを止める。止めたときは、
 * 空の項目の記号を取り除いてリストを終える（3 項目目以降の空の項目や、1 項目目と同じ扱い）。
 */
const continueWithoutLoosening = insertNewlineContinueMarkupCommand({ nonTightLists: false });

/**
 * Enter: lang-markdown の insertNewlineContinueMarkup と同じ。ただし空行を足さない。
 * - loose list（項目の間に空行のあるリスト）で次の項目を続けるとき、次の項目の前の空行を足さない。
 * - tight list の空の 2 項目目で押しても、空行を入れてリストを loose にしない（空の項目の記号を取り除いて、リストを終える）。
 * Markdown でない文脈（.txt など）や、継続の対象でない位置では false を返し、次のキー割り当てに回す。
 */
export const insertNewlineContinueTight: StateCommand = ({ state, dispatch }) => {
  let captured: Transaction | null = null;
  const handled = continueWithoutLoosening({
    state,
    dispatch: (tr) => {
      captured = tr;
    },
  });
  if (!handled || !captured) return false;
  dispatch(withoutSeparatorBlankLine(state, captured));
  return true;
};

/**
 * リストの継続の設定を、Enter のキー割り当てにする。
 * preserve は lang-markdown 自身の Enter（markdown() の既定のキー割り当て）に任せる。tight だけ、それより先に受ける。
 */
export function listContinuationExtension(mode: ListContinuation): Extension {
  return mode === 'tight' ? Prec.highest(keymap.of([{ key: 'Enter', run: insertNewlineContinueTight }])) : [];
}
