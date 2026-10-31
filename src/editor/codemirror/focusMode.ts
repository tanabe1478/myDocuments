import { RangeSetBuilder, StateEffect, type Extension } from '@codemirror/state';
import { Decoration, ViewPlugin, type DecorationSet, type EditorView, type ViewUpdate } from '@codemirror/view';
import { focusRange } from '../focusRange';

/** カーソルのある段落以外の行に付ける class（見た目は theme.ts）。 */
export const DIM_CLASS = 'cm-md-dim';

const dimLine = Decoration.line({ class: DIM_CLASS });

/** 変換の終了後に、保留していた再計算を促す。 */
const refresh = StateEffect.define<null>();

/** IME の変換終了から再計算までの待ち（CodeMirror が変換の終了を確定する時間より後）。 */
const AFTER_COMPOSITION_MS = 60;

function dimDecorations(view: EditorView): DecorationSet {
  const { doc, selection } = view.state;
  const range = focusRange(doc.lines, (n) => doc.line(n).text, doc.lineAt(selection.main.head).number);
  const builder = new RangeSetBuilder<Decoration>();
  let lastFrom = -1;
  for (const { from, to } of view.visibleRanges) {
    let pos = from;
    while (pos <= to) {
      const line = doc.lineAt(pos);
      // range が null（空行だけの文書）のときは、どの行も弱くしない。
      if (range !== null && line.from > lastFrom && (line.number < range.from || line.number > range.to)) {
        builder.add(line.from, line.from, dimLine);
      }
      lastFrom = Math.max(lastFrom, line.from);
      pos = line.to + 1;
    }
  }
  return builder.finish();
}

class FocusModePlugin {
  decorations: DecorationSet;
  /** 変換中に更新を見送った。変換が終わったら再計算する。 */
  private stale = false;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly view: EditorView) {
    this.decorations = dimDecorations(view);
  }

  update(update: ViewUpdate): void {
    const forced = update.transactions.some((tr) => tr.effects.some((e) => e.is(refresh)));
    const changed = update.docChanged || update.selectionSet || update.viewportChanged;
    if (update.view.compositionStarted) {
      // IME の変換中は再計算しない（行の属性を変えると、変換中の DOM に触れるため）。
      // 既存の装飾は、本文の変化に合わせて位置だけ追従させる。
      if (changed) {
        this.stale = true;
        this.decorations = this.decorations.map(update.changes);
      }
      return;
    }
    if (forced || this.stale || changed) {
      this.stale = false;
      this.decorations = dimDecorations(update.view);
    }
  }

  compositionEnded(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.stale) this.view.dispatch({ effects: refresh.of(null) });
    }, AFTER_COMPOSITION_MS);
  }

  destroy(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }
}

/**
 * フォーカスモード（UI-06）: カーソルのある段落（段落の定義は focusRange.ts）以外の行を弱く表示する。
 * 表示（行の class）だけを変え、本文には触れない。
 */
export function focusModeExtension(): Extension {
  return ViewPlugin.fromClass(FocusModePlugin, {
    decorations: (plugin) => plugin.decorations,
    eventHandlers: {
      compositionend(this: FocusModePlugin) {
        this.compositionEnded();
        return false;
      },
    },
  });
}
