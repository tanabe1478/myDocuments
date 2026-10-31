import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { HighlightStyle, syntaxHighlighting, syntaxTree } from '@codemirror/language';
import { RangeSetBuilder, type Extension } from '@codemirror/state';
import { Decoration, ViewPlugin, type DecorationSet, type EditorView, type ViewUpdate } from '@codemirror/view';
import { tags } from '@lezer/highlight';

/**
 * Markdown の見た目。表示だけを変え、本文には何も加えない。
 * - 見出し: 行ごとに文字サイズを変える（クラス cm-md-h1〜h6、サイズは theme.ts）。
 * - 強調・リンク・コード・引用: 太字、斜体、下線、等幅などで表示する。
 * - 記法記号（#、*、`、[]、> など）: 薄く表示する。非表示にはしない
 *   （自動非表示は IME と範囲選択への影響を確認してから、仕様 §5.2）。
 * 色は CSS 変数（styles.css）で、明暗テーマに追従する。
 */
export const markdownHighlightStyle = HighlightStyle.define([
  { tag: [tags.heading1, tags.heading2, tags.heading3, tags.heading4, tags.heading5, tags.heading6], fontWeight: '700' },
  { tag: tags.strong, fontWeight: '700' },
  { tag: tags.emphasis, fontStyle: 'italic' },
  { tag: tags.strikethrough, textDecoration: 'line-through', color: 'var(--md-color-muted)' },
  { tag: tags.link, color: 'var(--md-color-link)', textDecoration: 'underline' },
  { tag: tags.url, color: 'var(--md-color-muted)' },
  { tag: tags.monospace, fontFamily: 'var(--md-font-family-mono)', fontSize: '0.92em', color: 'var(--md-color-code)' },
  { tag: tags.quote, color: 'var(--md-color-quote)' },
  { tag: tags.contentSeparator, color: 'var(--md-color-muted)' },
  // 記法記号は最後に置く（リンクや強調の内側にあっても、薄い色が勝つ）。
  { tag: tags.processingInstruction, color: 'var(--md-color-mark)', fontWeight: '400' },
]);

const HEADING_NODE = /^(?:ATXHeading|SetextHeading)([1-6])$/;

function headingLines(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const { doc } = view.state;
  let lastLineFrom = -1;
  for (const { from, to } of view.visibleRanges) {
    syntaxTree(view.state).iterate({
      from,
      to,
      enter(node) {
        const match = HEADING_NODE.exec(node.name);
        if (!match) return;
        const deco = Decoration.line({ class: `cm-md-heading cm-md-h${match[1]}` });
        // Setext 見出しは複数行にまたがる。範囲の重なりで同じ行を二重に登録しない。
        for (let n = doc.lineAt(node.from).number; n <= doc.lineAt(node.to).number; n++) {
          const line = doc.line(n);
          if (line.from > lastLineFrom) {
            builder.add(line.from, line.from, deco);
            lastLineFrom = line.from;
          }
        }
        return false;
      },
    });
  }
  return builder.finish();
}

const headingDecorations = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = headingLines(view);
    }
    update(update: ViewUpdate) {
      if (
        update.docChanged ||
        update.viewportChanged ||
        syntaxTree(update.startState) !== syntaxTree(update.state)
      ) {
        this.decorations = headingLines(update.view);
      }
    }
  },
  { decorations: (plugin) => plugin.decorations },
);

export function markdownDecorations(): Extension {
  return [markdown({ base: markdownLanguage }), syntaxHighlighting(markdownHighlightStyle), headingDecorations];
}
