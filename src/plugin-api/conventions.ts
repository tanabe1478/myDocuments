import { Annotation, Facet, type EditorState } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';

/*
 * 部品どうしが互いを import しないための、共通の約束。
 * 部品はこれらを介してだけ、ホストや別の部品と協調する（DOM の class など、見えない結びつきを使わない）。
 */

/**
 * IME の変換が終わってから、保留していた再計算（装飾の作り直し）をするまでの待ち（ミリ秒）。
 * CodeMirror が変換の終了を確定する時間より後に取る。変換中は装飾の再計算を保留し、変換が終わったこの時間の後に
 * まとめて行う。ホストの記法の隠し方と、変換の終了に追従する部品（フォーカスモード）が、同じ値を使う。
 */
export const AFTER_COMPOSITION_MS = 60;

/**
 * 「この変更では、カーソルに追従してスクロールしなくてよい」という transaction の印。
 * カーソルも選択も動かさない変更（チェックボックスのクリックでの切り替えなど）が付ける。
 * カーソルを画面の特定の位置に保つ部品は、この印のある変更では保とうとしない。
 */
export const skipCaretFollow = Annotation.define<boolean>();

/**
 * 「カーソルのスクロールは、この部品が受け持つ」という宣言。受け持つ部品が `ownsCaretScroll.of(true)` を
 * 拡張に含める。ホストの既定のスクロールの補助（視線の位置の余白、縮んだ領域でのカーソルの保持）は、
 * いずれかの部品が宣言しているとき、自分の動作を止める。
 */
export const ownsCaretScroll = Facet.define<boolean, boolean>({
  combine: (values) => values.some(Boolean),
});

/**
 * 「いま、視線の位置の余白（ホストの scrollMargins。表示領域の上下 3 割）を止めてほしい」という宣言。
 * CodeMirror は、ポップアップ（補完の一覧）を、スクロール領域から scrollMargins を除いた範囲にカーソルがあるときだけ描く。
 * 余白の中（短い文書の最初の行など）にカーソルがあると、一覧が画面の外へ置かれて見えなくなる。
 * true を返す関数がある間、ホストの視線の位置は余白を足さない（一覧が閉じれば、元に戻る）。
 */
export const suspendReadingMargins = Facet.define<(state: EditorState) => boolean, readonly ((state: EditorState) => boolean)[]>({
  combine: (values) => values,
});

/**
 * Tab / Shift+Tab を、文脈に応じて部品が先に受けるための入口（Markdown の表のセルの移動など）。
 * ホストの字下げのキー割り当ては、Esc の直後でなければ、これを順に呼び、true を返したものがあればそこで終える
 * （字下げはしない）。どれも true を返さなければ、これまでどおりの字下げ。backward は Shift+Tab のとき true。
 * Esc の直後の Tab（本文の外へフォーカスを移す決まり）は、ホストがこの前に判断するので、ここには届かない。
 */
export const tabHandlers = Facet.define<(view: EditorView, backward: boolean) => boolean, readonly ((view: EditorView, backward: boolean) => boolean)[]>({
  combine: (values) => values,
});

/** 行番号（1 始まり）の範囲。from・to を含む。 */
export interface LineSpan {
  readonly from: number;
  readonly to: number;
}

/**
 * 弱く表示するブロックの class。行の装飾（行の class）が届かない、行をまたいで置き換えた表示（表など）が、
 * 弱くするべきときに自分の要素へ付ける。見た目（不透明度と遷移）は、弱く表示する部品が決める。
 */
export const DIMMED_BLOCK_CLASS = 'cm-dimmed-block';

/**
 * 「いま弱くしない行の範囲」を答える関数（フォーカスモードのように、行を弱く表示する部品が提供する）。
 * null は、弱くしない（対象なし）。この Facet に何も提供されていなければ、どのブロックも弱くしない。
 */
export const dimExemptLines = Facet.define<(state: EditorState) => LineSpan | null, readonly ((state: EditorState) => LineSpan | null)[]>({
  combine: (values) => values,
});

/**
 * 行 firstLine〜lastLine を占めるブロックを、弱く表示するべきか。提供された範囲のどれかと重ならなければ true。
 */
export function isDimmedBlock(state: EditorState, firstLine: number, lastLine: number): boolean {
  for (const provide of state.facet(dimExemptLines)) {
    const exempt = provide(state);
    if (exempt !== null && (lastLine < exempt.from || firstLine > exempt.to)) return true;
  }
  return false;
}
