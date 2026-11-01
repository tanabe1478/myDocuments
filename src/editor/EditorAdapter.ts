import type { TextKind } from '../document/fileKinds';

/** 選択範囲。本文（LF 正規化済みの文字列）上の UTF-16 オフセット。 */
export interface EditorSelection {
  readonly anchor: number;
  readonly head: number;
}

/**
 * 編集エンジンの抽象。UI（React）はこの interface だけを知る。
 * 実装は src/editor/codemirror/。将来エンジンを差し替えても UI は変えない（仕様 §7.2）。
 *
 * 規約:
 * - setText は「別の文書を読み込む」操作。履歴（Undo/Redo）をリセットし、onChange は発火しない。
 * - IME の変換中（composition 中）は setText を適用せず、変換の終了後に適用する。
 * - onChange はユーザー操作による本文の変化だけを通知する。
 * - on* は購読解除関数を返す。
 * - setFocusMode / setTypewriterMode は表示だけを変える。本文・履歴・選択範囲には触れない。
 *   setText で文書を読み込み直しても、設定は保たれる。
 * - setTextKind は表示だけを変える（markdown: Markdown の装飾あり、plain: 素のテキスト）。本文・履歴・選択範囲には触れない。
 *   setText で文書を読み込み直しても、種類は保たれる。
 * - setBottomInset は本文のレイアウトを変えない。スクロールの余白（カーソル行を表示領域の端から離す距離）だけを変える。
 */
export interface EditorAdapter {
  mount(el: HTMLElement): void;
  getText(): string;
  setText(text: string): void;
  onChange(cb: (text: string) => void): () => void;
  onSelectionChange(cb: (selection: EditorSelection) => void): () => void;
  focus(): void;
  /** フォーカスモード: カーソルのある段落以外の行を弱く表示する。 */
  setFocusMode(on: boolean): void;
  /** タイプライターモード: カーソル行を表示領域の縦中央に保つ。 */
  setTypewriterMode(on: boolean): void;
  /** 本文の表示の種類。.txt と .text は plain（Markdown の装飾を付けない）。 */
  setTextKind(kind: TextKind): void;
  /**
   * 本文の下側を、重ねて表示する要素（トースト）が覆っている高さ（px。0 で解除）。
   * カーソル行がその下に隠れないよう、スクロールの余白に使う。本文の高さ（レイアウト）は変えない。
   * すでに見えているカーソル行が覆われるときは、見える位置までスクロールする。
   */
  setBottomInset(px: number): void;
  destroy(): void;
}
