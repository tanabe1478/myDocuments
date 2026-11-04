import { isolateHistory } from '@codemirror/commands';
import { syntaxTree } from '@codemirror/language';
import type { Extension, Text } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { skipCaretFollow } from '../../plugin-api';
import { activeLines, collectMarkup, isActiveLine } from './liveMarkup';
import { markupDisplayFacet } from './markdownDecorations';

type Tree = ReturnType<typeof syntaxTree>;

/** 切り替えの transaction の userEvent。カーソルへの追従スクロールを避ける判断には使わない（そちらは skipCaretFollow の印）。 */
export const TOGGLE_TASK_EVENT = 'input.toggle-task';

/** チェックボックスの 1 文字の書き換え（[from, to) を insert に置く）。 */
export interface TaskToggle {
  readonly from: number;
  readonly to: number;
  readonly insert: ' ' | 'x';
}

/**
 * pos（チェックボックスのウィジェットの位置 = 隠す範囲 "- [ ]" の先頭）にあるタスクの、書き換える 1 文字を決める。
 * 隠す範囲は liveMarkup.ts（Run 12）と同じものを使うので、対象は表示されるチェックボックスと一致する
 * （入れ子、引用の中、`*` と `+`。番号付きのタスクと、コードや frontmatter の中は、そもそも範囲がない）。
 * 未完了 [ ] → [x]、完了 [x] と [X] → [ ]。ほかの文字は変えない。対象がなければ null。
 */
export function taskToggleAt(tree: Tree, doc: Text, pos: number): TaskToggle | null {
  if (pos < 0 || pos > doc.length) return null;
  const line = doc.lineAt(pos);
  const { spans } = collectMarkup(tree, doc, line.from, line.to);
  const span = spans.find((s) => s.kind === 'task' && s.from === pos);
  if (!span) return null;
  // 範囲の終わりは TaskMarker の終わり。"[ ]" の中の 1 文字は、その 2 つ前。
  const marker = doc.sliceString(span.to - 3, span.to);
  if (!/^\[[ xX]\]$/.test(marker)) return null;
  const done = marker[1] !== ' ';
  return { from: span.to - 2, to: span.to - 1, insert: done ? ' ' : 'x' };
}

/**
 * 記号を隠した行のチェックボックスを、修飾キーなしの左クリックで切り替える（ADR-004、Run 13）。
 * カーソルも選択もスクロールも動かさず（CodeMirror に mousedown を渡さない）、文書の 1 文字だけを書き換える。
 * カーソルに追従してスクロールする部品が走らないよう、transaction に skipCaretFollow の印を付ける。
 * 通常の入力と同じ transaction なので、Undo 1 回で戻り、編集済みの扱いと自動保存も同じ経路を通る。
 * 切り替えないもの（今までどおりの動作）: 本文のクリック、カーソル行の [ ]、設定が「常に表示」、
 * 修飾キー付き、右・中クリック、IME の変換中。
 */
export function taskToggleExtension(): Extension {
  return EditorView.domEventHandlers({
    mousedown(event, view) {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return false;
      if (view.composing || view.compositionStarted) return false;
      if (view.state.facet(markupDisplayFacet) !== 'cursorLine') return false;
      const box = event.target instanceof Element ? event.target.closest('.cm-md-task') : null;
      if (!box) return false;
      const { state } = view;
      // ウィジェットの今の位置（DOM の再利用があっても、表示の木から引くので古くならない）。
      const pos = view.posAtDOM(box);
      // 表示側（カーソルのある行）の記号は、そもそもウィジェットではない。念のため確かめる。
      if (isActiveLine(activeLines(state.doc, state.selection.ranges), state.doc.lineAt(pos).number)) return false;
      const change = taskToggleAt(syntaxTree(state), state.doc, pos);
      if (!change) return false;
      // カーソルも選択も動かさない（CodeMirror に渡さない）。ダブルクリックの語の選択も起きない。
      event.preventDefault();
      // フォーカスが外れているときは、Undo のキーが効くように戻す（選択は state のまま。スクロールもしない）。
      if (!view.hasFocus) view.focus();
      view.dispatch({
        changes: { from: change.from, to: change.to, insert: change.insert },
        userEvent: TOGGLE_TASK_EVENT,
        // 前後の入力と 1 つの Undo にまとめない。
        annotations: [isolateHistory.of('full'), skipCaretFollow.of(true)],
      });
      return true;
    },
  });
}
