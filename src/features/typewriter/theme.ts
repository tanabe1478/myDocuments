import { EditorView } from '@codemirror/view';

/**
 * 本文の上下に、表示領域の半分の余白（値は CSS 変数 --md-typewriter-pad。typewriterMode.ts が設定する）。
 * 競合バーの表示中も、こちらを優先する（セレクタがより具体的なので、styles.css の上の余白の指定に勝つ）。
 */
export const typewriterTheme = EditorView.theme({
  '&.cm-typewriter .cm-content': {
    paddingTop: 'var(--md-typewriter-pad, 50vh)',
    paddingBottom: 'var(--md-typewriter-pad, 50vh)',
  },
});
