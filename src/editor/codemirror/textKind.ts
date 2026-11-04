import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { RangeSetBuilder, type Extension } from '@codemirror/state';
import { Decoration, ViewPlugin, type DecorationSet, type EditorView, type ViewUpdate } from '@codemirror/view';
import { isBlankLine, type TextKind } from '../../plugin-api';

/*
 * 文書の種類に応じて、本体が入れるもの。
 * - markdown: Markdown の言語（構文木）。リストの継続（Enter）とフォーカスモードの段落の分け方、Markdown の見た目の部品が、
 *   この構文木と言語の Enter のキー割り当てに頼る。「Markdown の文書には、本体が Markdown の言語を入れる」のは、部品との約束（ADR-005 の R4）。
 *   見た目（見出し、強調、記号の隠し方など）は、本体は付けない。
 * - plain: 空行の高さだけ（Markdown の言語は入れない）。
 */

const blankLine = Decoration.line({ class: 'cm-md-blank' });

function plainBlankLines(view: EditorView): DecorationSet {
  const { doc } = view.state;
  const builder = new RangeSetBuilder<Decoration>();
  let lastFrom = -1;
  for (const { from, to } of view.visibleRanges) {
    let pos = from;
    while (pos <= to) {
      const line = doc.lineAt(pos);
      if (line.from > lastFrom && isBlankLine(line.text)) builder.add(line.from, line.from, blankLine);
      lastFrom = Math.max(lastFrom, line.from);
      pos = line.to + 1;
    }
  }
  return builder.finish();
}

class PlainBlankLinePlugin {
  decorations: DecorationSet;

  constructor(view: EditorView) {
    this.decorations = plainBlankLines(view);
  }

  update(update: ViewUpdate) {
    if (update.docChanged || update.viewportChanged) this.decorations = plainBlankLines(update.view);
  }
}

/**
 * 素のテキスト（.txt、.text）の見た目。空行の高さ（段落間隔の設定）だけを付ける。
 * 空行の高さは外観の設定で、Markdown の記法ではないので、Markdown の文書の空行と同じ高さにする。
 */
function plainTextDecorations(): Extension {
  return ViewPlugin.fromClass(PlainBlankLinePlugin, { decorations: (plugin) => plugin.decorations });
}

/** 文書の種類ごとに、本体が入れる拡張。 */
export function textKindExtension(kind: TextKind): Extension {
  return kind === 'plain' ? plainTextDecorations() : markdown({ base: markdownLanguage });
}
