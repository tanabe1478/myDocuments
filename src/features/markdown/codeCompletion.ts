/**
 * コードブロックの言語名の補完（ADR-004 追補（コードブロック））。開きのフェンスの行の、情報文字列の最初の語（`:` の前まで）の位置でだけ出す。
 * - 出す時機: 打ち始めたとき（``` の直後の 1 文字目から）と、Ctrl+Space（mac は Alt+` と Alt+i も）。
 *   すでに名前、別名、短い名前に完全一致している語には、打ち始めでは出さない（Enter が閉じのフェンスの挿入に届く）。
 * - 候補: language-data の名前と別名、短い名前の表（plugin-api の codeLanguages.ts）。選ぶと最初の語（`:` の前まで）だけを置き換え、`:ファイル名` は残す。
 * - 補完の表示中の Enter と Tab は補完が受ける。表示していないときと、受けても何も変わらないとき（選んだ候補が、いまの語と同じ）は、
 *   キーを受けずに閉じる（Enter は閉じのフェンスの挿入や改行に、Tab は今のままに回る）。
 * - 本文のほかの所では出さない（override で、この 1 つの供給元だけを使う。言語の既定の補完は使わない）。
 * - 見た目は明暗のテーマの CSS 変数。動き（遷移とアニメーション）は付けないので、Reduced Motion でも変わらない。
 * - 一覧が開いている間だけ、ホストの視線の位置の余白（表示領域の上下 3 割）を止める。余白の中にカーソルがあると、CodeMirror は一覧を画面の外へ置く。
 */
import {
  acceptCompletion,
  autocompletion,
  closeCompletion,
  completionStatus,
  moveCompletionSelection,
  selectedCompletion,
  startCompletion,
  type CompletionContext,
  type CompletionResult,
} from '@codemirror/autocomplete';
import { Prec, type Extension } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { isKnownLanguageName, languageCandidates, suspendReadingMargins, tabHandlers } from '../../plugin-api';
import { languageRangeAt } from './codeFence';

const OPTIONS = languageCandidates.map((c) => ({ label: c.label, detail: c.detail, boost: c.boost }));

/** 補完の供給元。範囲は、最初の語の、`:` の前まで。 */
export function languageSource(context: CompletionContext): CompletionResult | null {
  const range = languageRangeAt(context.state, context.pos);
  if (!range) return null;
  if (!context.explicit) {
    // 打ち始め: 1 文字以上入っているときだけ。完全に一致する語には出さない。
    if (context.pos === range.from) return null;
    if (isKnownLanguageName(context.state.sliceDoc(range.from, range.to))) return null;
  }
  // validFor は付けない: 打つたびに、供給元を呼び直す（完全一致したら、補完を閉じる）。
  return { from: range.from, to: range.to, options: OPTIONS };
}

/** 補完を受けて何かが変わるか。選んだ候補が、いまの語と同じなら、受けても何も変わらない。 */
function acceptIfChanges(view: EditorView): boolean {
  const selected = selectedCompletion(view.state);
  if (!selected) return false;
  const range = languageRangeAt(view.state, view.state.selection.main.head);
  if (range && view.state.sliceDoc(range.from, range.to) === selected.label) {
    closeCompletion(view);
    return false;
  }
  return acceptCompletion(view);
}

const completionTheme = EditorView.theme({
  '.cm-tooltip.cm-tooltip-autocomplete': {
    backgroundColor: 'var(--md-color-panel)',
    color: 'var(--md-color-text)',
    border: '1px solid var(--md-color-border)',
    borderRadius: '6px',
    boxShadow: '0 4px 16px rgba(0, 0, 0, 0.18)',
  },
  '.cm-tooltip.cm-tooltip-autocomplete > ul': {
    fontFamily: 'var(--md-font-family-mono)',
    fontSize: '14px',
    minWidth: '200px',
    maxHeight: '12em',
  },
  '.cm-tooltip.cm-tooltip-autocomplete > ul > li': { padding: '3px 10px', lineHeight: '1.4' },
  '.cm-tooltip.cm-tooltip-autocomplete > ul > li[aria-selected]': {
    backgroundColor: 'var(--md-color-selection)',
    color: 'var(--md-color-text)',
  },
  '.cm-tooltip.cm-tooltip-autocomplete .cm-completionDetail': {
    color: 'var(--md-color-chrome-text)',
    fontStyle: 'normal',
  },
  '.cm-tooltip.cm-tooltip-autocomplete .cm-completionMatchedText': { textDecoration: 'none', fontWeight: '700' },
});

/** 言語名の補完の拡張。Enter と矢印は補完が先に受ける（部品の中で、ほかの Enter のキー割り当てより前に並べる）。 */
export function codeCompletion(): Extension {
  return [
    autocompletion({
      override: [languageSource],
      defaultKeymap: false,
      icons: false,
      maxRenderedOptions: 60,
      tooltipClass: () => 'cm-md-lang-completion',
    }),
    Prec.highest(
      keymap.of([
        { key: 'Ctrl-Space', run: startCompletion },
        { mac: 'Alt-`', run: startCompletion },
        { mac: 'Alt-i', run: startCompletion },
        { key: 'Escape', run: closeCompletion },
        { key: 'ArrowDown', run: moveCompletionSelection(true) },
        { key: 'ArrowUp', run: moveCompletionSelection(false) },
        { key: 'PageDown', run: moveCompletionSelection(true, 'page') },
        { key: 'PageUp', run: moveCompletionSelection(false, 'page') },
        { key: 'Enter', run: acceptIfChanges },
      ]),
    ),
    // Tab: 補完の表示中だけ受ける（Esc の直後の Tab は、本体が先に本文の外へ回す）。
    tabHandlers.of((view, backward) => !backward && completionStatus(view.state) === 'active' && acceptIfChanges(view)),
    // 一覧が開いている間だけ、視線の位置の余白を止める。候補を待っている間（'pending'）は止めない:
    // 文字を打つたびに、本文のどこでも、補完は候補を待つ状態になる（供給元が null を返すまで）ので、止めると、打つたびに余白が効かなくなる。
    suspendReadingMargins.of((state) => completionStatus(state) === 'active'),
    completionTheme,
  ];
}
