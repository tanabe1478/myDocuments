import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { search, searchKeymap } from '@codemirror/search';
import { EditorState, type Extension } from '@codemirror/state';
import { EditorView, drawSelection, keymap } from '@codemirror/view';
import type { EditorAdapter, EditorSelection } from '../EditorAdapter';
import { markdownDecorations } from './markdownDecorations';
import { editorTheme } from './theme';

/** 変換中だった場合に、終了後、保留した setText を試し直す間隔。 */
const PENDING_RETRY_MS = 50;

export class CodeMirrorAdapter implements EditorAdapter {
  private view: EditorView | null = null;
  /** mount 前の本文。 */
  private initialText = '';
  /** IME の変換中に setText されたとき、変換が終わるまで保留する本文。 */
  private pendingText: string | null = null;
  private pendingTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly changeListeners = new Set<(text: string) => void>();
  private readonly selectionListeners = new Set<(selection: EditorSelection) => void>();

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
      search({ top: true }),
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
