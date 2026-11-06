import { defaultKeymap, history } from '@codemirror/commands';
import { search, searchKeymap } from '@codemirror/search';
import { Compartment, EditorState, type Extension, type StateEffect } from '@codemirror/state';
import { EditorView, drawSelection, keymap } from '@codemirror/view';
import type { HostServices, RegisteredEditorExtension, TextKind } from '../../plugin-api';
import type { EditorAdapter, EditorSelection } from '../EditorAdapter';
import { historyKeymap } from './historyKeymap';
import { indentKeymap } from './indentKeymap';
import { keepCursorVisibleExtension } from './keepCursorVisible';
import { readingPositionExtension } from './readingPosition';
import { textKindExtension } from './textKind';
import { editorTheme } from './theme';
import { verticalMotionExtension } from './verticalMotion';

/** 変換中だった場合に、終了後、保留した setText を試し直す間隔。 */
const PENDING_RETRY_MS = 50;
/** 覆う要素（トースト）の上端から、カーソル行を離す余白（px）。 */
const BOTTOM_INSET_GAP_PX = 12;

/** 部品が登録した、設定から作る拡張 1 つ分。Compartment で持ち、設定が変わったら差し替える。 */
interface PluginSlot {
  readonly registration: RegisteredEditorExtension;
  readonly compartment: Compartment;
  value: unknown;
}

export class CodeMirrorAdapter implements EditorAdapter {
  private view: EditorView | null = null;
  /** mount 前の本文。 */
  private initialText = '';
  /** IME の変換中に setText されたとき、変換が終わるまで保留する本文。 */
  private pendingText: string | null = null;
  private pendingTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly changeListeners = new Set<(text: string) => void>();
  private readonly selectionListeners = new Set<(selection: EditorSelection) => void>();
  private textKind: TextKind = 'markdown';
  /** 本文の下側を覆う要素（トースト）の高さ。scrollMargins の下側に使う（レイアウトは変えない）。 */
  private bottomInset = 0;
  // setText は state を作り直すので、モードは Compartment で持ち、作り直しても現在の値で始める。
  private readonly kindCompartment = new Compartment();

  /** 部品の拡張。部品の一覧（PluginRegistry）の順。 */
  private readonly pluginSlots: readonly PluginSlot[];

  /**
   * @param pluginExtensions 部品の拡張。
   * @param services 本体が部品に貸す機能（外部の URL を開く、OS の判定）。部品の拡張を作るときに渡す。
   */
  constructor(
    pluginExtensions: readonly RegisteredEditorExtension[] = [],
    private readonly services: HostServices = DEFAULT_SERVICES,
  ) {
    this.pluginSlots = pluginExtensions.map((registration) => ({
      registration,
      compartment: new Compartment(),
      value: registration.defaultValue,
    }));
  }

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

  goToLineStart(offset: number): void {
    const view = this.view;
    if (!view) return;
    const doc = view.state.doc;
    // 位置は本文の長さに収める（本文が短くなっていても、範囲外にならない）。整数でない値は 0。
    const position = Number.isFinite(offset) ? Math.max(0, Math.min(Math.trunc(offset), doc.length)) : 0;
    const from = doc.lineAt(position).from;
    view.dispatch({
      selection: { anchor: from },
      effects: EditorView.scrollIntoView(from, { y: 'start' }),
      userEvent: 'select',
    });
    view.focus();
  }

  isComposing(): boolean {
    return this.view?.compositionStarted === true;
  }

  getSelection(): EditorSelection {
    const main = this.view?.state.selection.main;
    return main ? { anchor: main.anchor, head: main.head } : { anchor: 0, head: 0 };
  }

  setPluginSetting(key: string, value: unknown): void {
    const effects: StateEffect<unknown>[] = [];
    for (const slot of this.pluginSlots) {
      if (slot.registration.settingKey !== key || Object.is(slot.value, value)) continue;
      slot.value = value;
      effects.push(slot.compartment.reconfigure(this.pluginExtension(slot)));
    }
    if (effects.length > 0) this.view?.dispatch({ effects });
  }

  setTextKind(kind: TextKind): void {
    if (this.textKind === kind) return;
    this.textKind = kind;
    this.view?.dispatch({
      effects: [
        this.kindCompartment.reconfigure(this.kindExtension()),
        // 文書の種類に依存する部品の拡張は、種類が変わったときに作り直す（宣言した部品だけ）。
        ...this.pluginSlots
          .filter((slot) => slot.registration.dependsOnTextKind)
          .map((slot) => slot.compartment.reconfigure(this.pluginExtension(slot))),
      ],
    });
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

  private kindExtension(): Extension {
    return textKindExtension(this.textKind);
  }

  private pluginExtension(slot: PluginSlot): Extension {
    return slot.registration.create(slot.value, { textKind: this.textKind, ...this.services });
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
      this.kindCompartment.of(this.kindExtension()),
      ...this.pluginSlots.map((slot) => slot.compartment.of(this.pluginExtension(slot))),
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

/** 本体が貸す機能が渡されなかったとき（部品を使わないテストなど）。何もしない。 */
const DEFAULT_SERVICES: HostServices = { openExternalUrl: () => {}, isMacPlatform: () => false };

export function createCodeMirrorAdapter(
  pluginExtensions: readonly RegisteredEditorExtension[] = [],
  services: HostServices = DEFAULT_SERVICES,
): EditorAdapter {
  return new CodeMirrorAdapter(pluginExtensions, services);
}
