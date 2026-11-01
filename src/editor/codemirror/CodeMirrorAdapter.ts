import { defaultKeymap, history } from '@codemirror/commands';
import { search, searchKeymap } from '@codemirror/search';
import { Compartment, EditorState, type Extension } from '@codemirror/state';
import { EditorView, drawSelection, keymap } from '@codemirror/view';
import type { EditorAdapter, EditorSelection } from '../EditorAdapter';
import { focusModeExtension } from './focusMode';
import { historyKeymap } from './historyKeymap';
import { indentKeymap } from './indentKeymap';
import { keepCursorVisibleExtension } from './keepCursorVisible';
import { markdownDecorations } from './markdownDecorations';
import { readingPositionExtension } from './readingPosition';
import { editorTheme } from './theme';
import { typewriterModeExtension } from './typewriterMode';
import { verticalMotionExtension } from './verticalMotion';

/** 変換中だった場合に、終了後、保留した setText を試し直す間隔。 */
const PENDING_RETRY_MS = 50;
/** 覆う要素（トースト）の上端から、カーソル行を離す余白（px）。 */
const BOTTOM_INSET_GAP_PX = 12;

export class CodeMirrorAdapter implements EditorAdapter {
  private view: EditorView | null = null;
  /** mount 前の本文。 */
  private initialText = '';
  /** IME の変換中に setText されたとき、変換が終わるまで保留する本文。 */
  private pendingText: string | null = null;
  private pendingTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly changeListeners = new Set<(text: string) => void>();
  private readonly selectionListeners = new Set<(selection: EditorSelection) => void>();
  private focusMode = false;
  private typewriterMode = false;
  /** 本文の下側を覆う要素（トースト）の高さ。scrollMargins の下側に使う（レイアウトは変えない）。 */
  private bottomInset = 0;
  // setText は state を作り直すので、モードは Compartment で持ち、作り直しても現在の値で始める。
  private readonly focusCompartment = new Compartment();
  private readonly typewriterCompartment = new Compartment();

  mount(el: HTMLElement): void {
    if (this.view) throw new Error('CodeMirrorAdapter is already mounted');
    this.view = new EditorView({ state: this.createState(this.initialText), parent: el });
  }

  getText(): string {
    return this.view ? this.view.state.doc.toString() : this.initialText;
  }

  setText(text: string): void {
    if (!this.view) {
      this.initialText = text;
      return;
    }
    if (this.view.compositionStarted) {
      this.pendingText = text;
      this.schedulePending();
      return;
    }
    this.applyText(this.view, text);
  }

  onChange(cb: (text: string) => void): () => void {
    this.changeListeners.add(cb);
    return () => this.changeListeners.delete(cb);
  }

  onSelectionChange(cb: (selection: EditorSelection) => void): () => void {
    this.selectionListeners.add(cb);
    return () => this.selectionListeners.delete(cb);
  }

  focus(): void {
    this.view?.focus();
  }

  setFocusMode(on: boolean): void {
    if (this.focusMode === on) return;
    this.focusMode = on;
    this.view?.dispatch({ effects: this.focusCompartment.reconfigure(this.focusExtension()) });
  }

  setTypewriterMode(on: boolean): void {
    if (this.typewriterMode === on) return;
    this.typewriterMode = on;
    this.view?.dispatch({ effects: this.typewriterCompartment.reconfigure(this.typewriterExtension()) });
  }

  setBottomInset(px: number): void {
    const previous = this.bottomInset;
    this.bottomInset = Math.max(0, px);
    const view = this.view;
    if (!view || this.bottomInset <= previous) return;
    // すでに見えているカーソル行が、新しく覆われた帯に入るときだけ、見える位置までスクロールする。
    // もともと見えていなかったカーソルは動かさない（離れた位置を、勝手に引き戻さない）。
    const head = view.state.selection.main.head;
    const coords = view.coordsAtPos(head);
    if (!coords) return;
    const area = view.scrollDOM.getBoundingClientRect();
    const wasVisible = coords.top >= area.top && coords.bottom <= area.bottom;
    if (wasVisible && coords.bottom > area.bottom - this.bottomInset) {
      view.dispatch({ effects: EditorView.scrollIntoView(head, { y: 'nearest', yMargin: BOTTOM_INSET_GAP_PX }) });
    }
  }

  destroy(): void {
    if (this.pendingTimer !== null) clearTimeout(this.pendingTimer);
    this.pendingTimer = null;
    this.pendingText = null;
    this.view?.destroy();
    this.view = null;
    this.changeListeners.clear();
    this.selectionListeners.clear();
  }

  /** 別の文書として読み込む。state を作り直すので、Undo/Redo の履歴は空になる。 */
  private applyText(view: EditorView, text: string): void {
    this.pendingText = null;
    view.setState(this.createState(text));
  }

  private schedulePending(): void {
    if (this.pendingTimer !== null) return;
    this.pendingTimer = setTimeout(() => {
      this.pendingTimer = null;
      const view = this.view;
      if (!view || this.pendingText === null) return;
      if (view.compositionStarted) {
        this.schedulePending();
        return;
      }
      this.applyText(view, this.pendingText);
    }, PENDING_RETRY_MS);
  }

  private focusExtension(): Extension {
    return this.focusMode ? focusModeExtension() : [];
  }

  private typewriterExtension(): Extension {
    return this.typewriterMode ? typewriterModeExtension() : [];
  }

  private createState(doc: string): EditorState {
    return EditorState.create({ doc, extensions: this.extensions() });
  }

  private extensions(): Extension[] {
    return [
      history(),
      drawSelection(),
      // 本文は LF だけを改行として扱う（CodeMirror の既定は CR・CRLF も改行として扱い、
      // 孤立した CR が LF に変わってしまう）。CRLF の復元は保存時に docio が行う。
      EditorState.lineSeparator.of('\n'),
      EditorView.lineWrapping,
      markdownDecorations(),
      this.focusCompartment.of(this.focusExtension()),
      this.typewriterCompartment.of(this.typewriterExtension()),
      search({ top: true }),
      readingPositionExtension(),
      keepCursorVisibleExtension(),
      // 下側を覆う要素（トースト）の分。カーソルの移動や入力のスクロールが、その上に収める。
      EditorView.scrollMargins.of(() => (this.bottomInset > 0 ? { bottom: this.bottomInset } : null)),
      indentKeymap(),
      verticalMotionExtension(),
      keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap]),
      editorTheme,
      EditorView.contentAttributes.of({ 'aria-label': '本文', 'aria-multiline': 'true' }),
      EditorView.updateListener.of((update) => {
        if (update.docChanged && this.changeListeners.size > 0) {
          const text = update.state.doc.toString();
          this.changeListeners.forEach((cb) => cb(text));
        }
        if (update.selectionSet && this.selectionListeners.size > 0) {
          const { anchor, head } = update.state.selection.main;
          this.selectionListeners.forEach((cb) => cb({ anchor, head }));
        }
      }),
      EditorView.domEventHandlers({
        compositionend: () => {
          if (this.pendingText !== null) this.schedulePending();
          return false;
        },
      }),
    ];
  }
}

export function createCodeMirrorAdapter(): EditorAdapter {
  return new CodeMirrorAdapter();
}
