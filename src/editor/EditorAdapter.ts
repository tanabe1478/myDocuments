import type { TextKind } from '../document/fileKinds';
import type { ListContinuation, MarkupDisplay } from '../preferences/preferences';

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
 * - setFocusMode は表示だけを変える。本文・履歴・選択範囲には触れない。
 *   setText で文書を読み込み直しても、設定は保たれる。
 * - setPluginSetting は、部品（src/plugin-api/）が登録した設定の値を渡す。その設定から作る部品の拡張が、現在の値に差し替わる。
 *   本文・履歴・選択範囲には触れない。setText で文書を読み込み直しても、現在の値で始まる。登録のない key は無視する。
 * - setTextKind は表示だけを変える（markdown: Markdown の装飾あり、plain: 素のテキスト）。本文・履歴・選択範囲には触れない。
 *   setText で文書を読み込み直しても、種類は保たれる。
 * - setListContinuation は Enter でのリストの継続（空行を入れるか）だけを変える。本文・履歴・選択範囲には触れない。
 *   setText で文書を読み込み直しても、設定は保たれる。.txt と .text では Markdown の継続そのものが働かない（今と同じ）。
 * - setMarkupDisplay は Markdown の記号の見せ方だけを変える（cursorLine: カーソルのある行と選択にかかる行だけ記号を見せ、
 *   ほかの行は隠す。always: すべての行で見せる。ADR-004）。本文・履歴・選択範囲には触れない（隠すのは表示だけ）。
 *   setText で文書を読み込み直しても、設定は保たれる。.txt と .text には効かない。
 * - onOpenLink は、本文のリンクを ⌘/Ctrl+クリックしたことの通知（macOS は ⌘、Windows と Linux は Ctrl）。リンク先を書かれたとおりに渡す。
 *   開けるかどうか（http / https だけ）の判断は、受け取った側が行う。カーソルと選択は動かさない。
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
  /** 部品が登録した設定の値。 */
  setPluginSetting(key: string, value: unknown): void;
  /** 本文の表示の種類。.txt と .text は plain（Markdown の装飾を付けない）。 */
  setTextKind(kind: TextKind): void;
  /** Enter でのリストの継続。tight: 項目の間に空行のあるリスト（loose list）でも空行を入れない。preserve: 空行を入れてリストの形に合わせる。 */
  setListContinuation(mode: ListContinuation): void;
  /** 記号の見せ方。 */
  setMarkupDisplay(mode: MarkupDisplay): void;
  /** リンクを開く操作（⌘/Ctrl+クリック）の通知を購読する。解除関数を返す。 */
  onOpenLink(cb: (url: string) => void): () => void;
  /**
   * 本文の下側を、重ねて表示する要素（トースト）が覆っている高さ（px。0 で解除）。
   * カーソル行がその下に隠れないよう、スクロールの余白に使う。本文の高さ（レイアウト）は変えない。
   * すでに見えているカーソル行が覆われるときは、見える位置までスクロールする。
   */
  setBottomInset(px: number): void;
  destroy(): void;
}
