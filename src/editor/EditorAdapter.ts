import type { TextKind } from '../plugin-api';

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
 * - setPluginSetting は、部品（src/plugin-api/）が登録した設定の値を渡す。その設定から作る部品の拡張が、現在の値に差し替わる。
 *   本文・履歴・選択範囲には触れない。setText で文書を読み込み直しても、現在の値で始まる。登録のない key は無視する。
 * - setTextKind は表示だけを変える（markdown: 本体が Markdown の言語を入れる。見た目は部品が付ける。plain: 素のテキスト。空行の高さだけ付く）。本文・履歴・選択範囲には触れない。
 *   setText で文書を読み込み直しても、種類は保たれる。種類を知る部品の拡張（dependsOnTextKind の登録）は、種類が変わると作り直される。
 * - goToLineStart は、本文の位置（UTF-16 のオフセット）の行の先頭へカーソルを移し（範囲選択は解く）、その行が見える位置までスクロールし、
 *   本文にフォーカスを戻す。位置は本文の長さに収める（範囲外でも例外にしない）。本文は変えず、履歴に残さない。
 *   部品（src/plugin-api/）には、この操作を渡さない（部品はカーソルを動かせない。パネルの項目を押したときだけ、本体が呼ぶ）。
 * - isComposing は IME の変換中か。本文を部品に届ける時機を決めるために、本体が読む。
 * - getSelection は今の選択（本文の上の UTF-16 のオフセット）。
 * - setBottomInset は本文のレイアウトを変えない。スクロールの余白（カーソル行を表示領域の端から離す距離）だけを変える。
 */
export interface EditorAdapter {
  mount(el: HTMLElement): void;
  getText(): string;
  /** 本文の文字数（UTF-16）と行数。本文は読まない（ログの量の推移に使う。ADR-007 の R16）。 */
  getDocumentStats(): { chars: number; lines: number };
  setText(text: string): void;
  onChange(cb: (text: string) => void): () => void;
  onSelectionChange(cb: (selection: EditorSelection) => void): () => void;
  focus(): void;
  /** 位置の行の先頭へカーソルを移し、表示し、本文にフォーカスを戻す。 */
  goToLineStart(offset: number): void;
  /** IME の変換中か。 */
  isComposing(): boolean;
  /** 今の選択。 */
  getSelection(): EditorSelection;
  /** 部品が登録した設定の値。 */
  setPluginSetting(key: string, value: unknown): void;
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
