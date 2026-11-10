import { AFTER_COMPOSITION_MS, type DocumentSnapshot, type PluginPerf, type SelectionSnapshot, type TextKind } from '../plugin-api';

/** 入力が止まってから、本文を部品に届けるまでの待ち（ミリ秒。後ろ寄せ）。入力のたびに待ち直す。 */
export const DOCUMENT_DEBOUNCE_MS = 200;
/** カーソルの位置の通知を間引く間隔（ミリ秒）。最初の変化から数えて、この時間に 1 回、最新の位置を届ける。 */
export const SELECTION_THROTTLE_MS = 100;

export interface DocumentFeedDeps {
  /** 本文とカーソルの位置を、部品に届ける（実際に受け取る部品は、レジストリが決める）。 */
  publish(document: DocumentSnapshot, selection: SelectionSnapshot): void;
  /** カーソルの位置だけを届ける。 */
  publishSelection(selection: SelectionSnapshot): void;
  /** IME の変換中か。変換中は届けない（変換の確定の後に届ける）。 */
  isComposing(): boolean;
  /** 今の選択。 */
  getSelection(): { readonly anchor: number; readonly head: number };
  debounceMs?: number;
  selectionMs?: number;
  afterCompositionMs?: number;
  /** 性能の計測（R16）。publish（本文とカーソルの位置を部品に届ける処理）の所要時間を、区間 feed.publish として数える。省略か無効の間は、何もしない。 */
  perf?: PluginPerf;
}

/**
 * 本文を部品に届ける時機を決める（ADR-005 の R7）。入力の速さを守るため、入力のたびには届けない。
 * - 利用者の入力（typed）: 止まってから debounceMs の後に 1 回届ける（入力のたびに待ち直す）。
 * - 文書を開いた・切り替えた・読み直した、種類が変わった（sync）: すぐ届ける。
 * - IME の変換中は届けない。確定の後（変換が終わった後の短い待ち）に届ける。
 * - カーソルの位置は間引く。本文の届け待ちの間と変換中は、本文と一緒に届ける（単独では届けない）。
 * 本文か種類が変わるたびに、版（version）が 1 増える。届けるかどうか（パネルが見えているか、権限）は、受け取る側（レジストリ）が決める。
 */
export interface DocumentFeed {
  /** 今の本文の版。部品の項目の版が、これと違えば、その項目は古い。 */
  readonly version: number;
  /** 利用者の入力で、本文が変わった。コントローラーに渡す前に呼ぶ（そのあとの sync は、同じ本文なので何もしない）。 */
  typed(text: string): void;
  /** 本文と種類を、今の状態に合わせる。変わっていれば（別の文書、読み直し、種類の変更）、すぐ届ける。同じなら何もしない。 */
  sync(text: string, kind: TextKind): void;
  /** カーソルの位置が変わった。 */
  selectionChanged(): void;
  /** 保留を待たず、最新を届ける（変換中は届けず、確定の後に届ける）。パネルが見えたとき、起動のときに呼ぶ。 */
  flush(): void;
  dispose(): void;
}

export function createDocumentFeed(deps: DocumentFeedDeps, initial: { readonly text: string; readonly kind: TextKind }): DocumentFeed {
  const debounceMs = deps.debounceMs ?? DOCUMENT_DEBOUNCE_MS;
  const selectionMs = deps.selectionMs ?? SELECTION_THROTTLE_MS;
  const afterCompositionMs = deps.afterCompositionMs ?? AFTER_COMPOSITION_MS;

  let text = initial.text;
  let kind = initial.kind;
  let version = 0;
  /** まだ届けていない本文の変化がある。 */
  let pending = false;
  let documentTimer: ReturnType<typeof setTimeout> | null = null;
  let selectionTimer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;

  const clearDocumentTimer = (): void => {
    if (documentTimer !== null) clearTimeout(documentTimer);
    documentTimer = null;
  };

  const selectionNow = (): SelectionSnapshot => {
    const { anchor, head } = deps.getSelection();
    return { version, anchor, head };
  };

  /** 変換中なら、確定の後まで待つ。そうでなければ、届ける。 */
  const publishWhenIdle = (): void => {
    documentTimer = null;
    if (disposed) return;
    if (deps.isComposing()) {
      documentTimer = setTimeout(publishWhenIdle, afterCompositionMs);
      return;
    }
    pending = false;
    const end = deps.perf?.span('feed.publish');
    try {
      deps.publish({ version, kind, text }, selectionNow());
    } finally {
      end?.();
    }
  };

  const schedule = (ms: number): void => {
    clearDocumentTimer();
    pending = true;
    documentTimer = setTimeout(publishWhenIdle, ms);
  };

  const onSelectionTimer = (): void => {
    selectionTimer = null;
    if (disposed) return;
    // 本文の届け待ちの間と変換中は、本文と一緒に届く（単独で届けない）。
    if (pending || deps.isComposing()) return;
    deps.publishSelection(selectionNow());
  };

  return {
    get version() {
      return version;
    },
    typed(next) {
      if (disposed || next === text) return;
      text = next;
      version++;
      schedule(debounceMs);
    },
    sync(nextText, nextKind) {
      if (disposed || (nextText === text && nextKind === kind)) return;
      text = nextText;
      kind = nextKind;
      version++;
      // 入力の最中ではない変化（開く、切り替え、読み直し、種類の変更）は、待たずに届ける。変換中は、確定の後。
      schedule(0);
    },
    selectionChanged() {
      if (disposed || selectionTimer !== null) return;
      selectionTimer = setTimeout(onSelectionTimer, selectionMs);
    },
    flush() {
      if (disposed) return;
      clearDocumentTimer();
      pending = true;
      publishWhenIdle();
    },
    dispose() {
      disposed = true;
      clearDocumentTimer();
      if (selectionTimer !== null) clearTimeout(selectionTimer);
      selectionTimer = null;
    },
  };
}
