/**
 * コードブロックのキー操作（ADR-004 追補（コードブロック）。計画は codeFence.ts）。
 * - Enter: 開きのフェンスの行の末尾で、閉じのフェンスを足す。閉じのフェンスの行の末尾で、余った閉じのフェンスを取り除く。
 * - ⌘/Ctrl+Enter（Mod-Enter）: コードブロックの中から、閉じのフェンスの次の行へ出る。
 * 対象でなければ false を返し、次のキー割り当て（リストの継続、既定の改行や空行の挿入）に回す。
 * コードブロックの中の Enter は、そのまま改行（字下げは前の行に合わせる）。Enter を 2 回で抜ける動きはない（コードの中の空行と区別できない）。
 * IME の変換中と、WebKit で変換の確定の直後に届く Enter の keydown は、CodeMirror が、キー割り当てを呼ぶ前に捨てる
 * （tableKeys.ts の tableEnter と同じ守り）。念のため、対象の位置では変換中は何もせずキーを受ける。
 */
import { Prec, type Extension } from '@codemirror/state';
import { keymap, type EditorView } from '@codemirror/view';
import { planFenceEnter, planFenceExit, type FencePlan } from './codeFence';

function run(view: EditorView, plan: (state: EditorView['state']) => FencePlan | null): boolean {
  const planned = plan(view.state);
  if (!planned) return false;
  if (view.composing || view.compositionStarted) return true;
  view.dispatch(planned.spec);
  return true;
}

export function fenceEnter(view: EditorView): boolean {
  return run(view, planFenceEnter);
}

export function fenceExit(view: EditorView): boolean {
  return run(view, planFenceExit);
}

/** コードブロックのキー操作の拡張。リストの継続と既定のキー割り当てより先に受ける（受けなければ、そのまま次に回る）。 */
export function codeFenceKeys(): Extension {
  return Prec.highest(
    keymap.of([
      { key: 'Enter', run: fenceEnter },
      { key: 'Mod-Enter', run: fenceExit },
    ]),
  );
}
