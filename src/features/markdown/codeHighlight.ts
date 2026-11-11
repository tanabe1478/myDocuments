import { syntaxTree, type TagStyle } from '@codemirror/language';
import { RangeSetBuilder, type Extension } from '@codemirror/state';
import { Decoration, ViewPlugin, type DecorationSet, type EditorView, type ViewUpdate } from '@codemirror/view';
import { tags } from '@lezer/highlight';

/**
 * コードブロックの中の色（ADR-004 追補（コードブロック））。言語の構文木が付ける tag を、少数の分類にまとめて、CSS 変数の色にする。
 * 色は src/styles.css の --md-code-*（明暗のテーマごと）。本文の背景（フェンスの帯）に対する WCAG AA は、
 * src/canvas/markdownColors.test.ts が確かめる。tag は子の tag（controlKeyword など）も含む。
 *
 * 分類: キーワード、文字列、コメント、数値、関数名、型、属性。これ以外（変数名、記号、演算子）は、コードの既定の色（--md-color-code）のまま。
 * 言語が付ける tag と同じ tag を、Markdown の記法も使う（tags.comment は HTML のコメント）が、色は同じ分類で矛盾しない。
 */
export const codeTokenStyles: readonly TagStyle[] = [
  { tag: [tags.keyword, tags.modifier, tags.self], color: 'var(--md-code-keyword)' },
  { tag: [tags.string, tags.special(tags.string), tags.regexp], color: 'var(--md-code-string)' },
  { tag: tags.comment, color: 'var(--md-code-comment)' },
  { tag: [tags.number, tags.bool, tags.atom, tags.null], color: 'var(--md-code-number)' },
  { tag: [tags.function(tags.variableName), tags.function(tags.propertyName), tags.macroName], color: 'var(--md-code-function)' },
  { tag: [tags.typeName, tags.className, tags.namespace], color: 'var(--md-code-type)' },
  { tag: [tags.attributeName, tags.propertyName, tags.tagName], color: 'var(--md-code-attribute)' },
];

/**
 * 言語が分かったコードブロックの、中身の既定の見た目（等幅、0.92em）。
 * 言語を入れた構文解析（codeLanguages）は、FencedCode の中身（CodeText）を、その言語の構文木で置き換える。置き換わった範囲の、
 * tag のない文字（変数名、記号、演算子）は、CodeText の tag（monospace。等幅、0.92em、コードの色）を受け継がず、本文のフォントと色になってしまう。
 * そこで、置き換わった CodeText（resolveInner が、CodeText ではなく言語の節に入るもの）にだけ、等幅と 0.92em の mark を付ける。
 * 置き換わっていない CodeText（言語なし、text、読み込みの前）は、これまでどおり monospace の tag が効くので、付けない（二重に 0.92em を掛けない）。
 * コードの色は、中身の行の class（cm-md-fence-code。markdownDecorations.ts が付ける）が持つ。tag のある文字の色は、その上に重なる。
 */
const codeTextMark = Decoration.mark({ class: 'cm-md-code-text' });

function codeTextMarks(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const tree = syntaxTree(view.state);
  let last = -1;
  for (const { from, to } of view.visibleRanges) {
    tree.iterate({
      from,
      to,
      enter(node) {
        if (node.name !== 'CodeText') return;
        if (node.to > node.from && node.from >= last && tree.resolveInner(node.from, 1).name !== 'CodeText') {
          builder.add(node.from, node.to, codeTextMark);
          last = node.to;
        }
        return false;
      },
    });
  }
  return builder.finish();
}

class CodeTextMarkPlugin {
  decorations: DecorationSet;

  constructor(view: EditorView) {
    this.decorations = codeTextMarks(view);
  }

  update(update: ViewUpdate) {
    if (update.docChanged || update.viewportChanged || syntaxTree(update.startState) !== syntaxTree(update.state)) this.decorations = codeTextMarks(update.view);
  }
}

/** 言語が分かったコードブロックの中身に、等幅と 0.92em を付ける拡張。 */
export function codeTextDefaults(): Extension {
  return ViewPlugin.fromClass(CodeTextMarkPlugin, { decorations: (plugin) => plugin.decorations });
}
