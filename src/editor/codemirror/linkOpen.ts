import { StateEffect, StateField, type Extension } from '@codemirror/state';
import { EditorView, ViewPlugin } from '@codemirror/view';
import { isMacPlatform } from '../../ui/shortcuts';
import { linkAt } from '../liveMarkup';
import { visibleLinks } from './markdownDecorations';

/** リンクを開く修飾キー（macOS は ⌘、Windows と Linux は Ctrl）を押している間、本文に付ける class（見た目は theme.ts）。 */
export const LINK_READY_CLASS = 'cm-md-link-ready';

const setLinkReady = StateEffect.define<boolean>();

const linkReady = StateField.define<boolean>({
  create: () => false,
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setLinkReady)) value = e.value;
    return value;
  },
  provide: (field) => EditorView.editorAttributes.from(field, (on): { class: string } => ({ class: on ? LINK_READY_CLASS : '' })),
});

/** リンクを開く修飾キーか（macOS は ⌘ だけ。Ctrl+クリックは右クリックの扱いなので使わない）。 */
function hasOpenModifier(e: { metaKey: boolean; ctrlKey: boolean }): boolean {
  return isMacPlatform() ? e.metaKey : e.ctrlKey;
}

/** 修飾キーの状態を追い、本文の class に反映する。window のキー操作とポインタの動きから読む。 */
const modifierTracker = ViewPlugin.fromClass(
  class {
    private readonly onKey = (e: KeyboardEvent) => this.sync(hasOpenModifier(e));
    private readonly onPointer = (e: MouseEvent) => this.sync(hasOpenModifier(e));
    private readonly onBlur = () => this.sync(false);

    constructor(private readonly view: EditorView) {
      window.addEventListener('keydown', this.onKey, true);
      window.addEventListener('keyup', this.onKey, true);
      window.addEventListener('mousemove', this.onPointer, true);
      window.addEventListener('blur', this.onBlur);
    }

    private sync(on: boolean): void {
      if (this.view.state.field(linkReady) !== on) this.view.dispatch({ effects: setLinkReady.of(on) });
    }

    destroy(): void {
      window.removeEventListener('keydown', this.onKey, true);
      window.removeEventListener('keyup', this.onKey, true);
      window.removeEventListener('mousemove', this.onPointer, true);
      window.removeEventListener('blur', this.onBlur);
    }
  },
);

/**
 * ⌘/Ctrl+クリックで、リンク（インラインリンクの文字と URL 部分、自動リンク、裸の URL）を開く。
 * 記号を見せている行でも隠している行でも同じ。リンクの上のクリックだけを受け取り、カーソルは動かさない。
 * 普通のクリックと、リンクでない所の ⌘/Ctrl+クリックは、今までどおり（カーソルを置く）。
 * 開けるかどうか（http / https だけ）は onOpen の側が決める。
 */
export function linkOpenExtension(onOpen: (url: string) => void): Extension {
  return [
    linkReady,
    modifierTracker,
    EditorView.domEventHandlers({
      mousedown(event, view) {
        if (event.button !== 0 || !hasOpenModifier(event)) return false;
        const target = event.target instanceof Element ? event.target : null;
        if (!target?.closest('.cm-md-link')) return false;
        const pos = view.posAtCoords({ x: event.clientX, y: event.clientY }, false);
        const link = linkAt(visibleLinks(view), pos);
        if (!link) return false;
        // カーソルも選択も動かさない（CodeMirror に渡さない）。
        event.preventDefault();
        onOpen(link.url);
        return true;
      },
    }),
  ];
}
