import { EditorView } from '@codemirror/view';

/**
 * 本文の左右の内側余白。行長（--md-max-width）の外側に取り、余裕があるときは 56px。
 * 窓が狭いときは、行長を保てる範囲で縮め、最小 20px にする（src/editor/layout.ts と同じ式）。
 * % は、本文を置く領域（スクロール領域）の幅に対する割合。
 */
const PAD_X = 'clamp(20px, calc((100% - var(--md-max-width)) / 2), 56px)';

/**
 * 本文の配置と文字組み。値は CSS 変数（Preferences から src/preferences/apply.ts が設定する）。
 * 本文は中央寄せで、最大幅は --md-max-width（左右の余白を除いた、行の長さ）。スクロールバーは窓の端に置く。
 */
export const editorTheme = EditorView.theme({
  '&': {
    height: '100%',
    color: 'var(--md-color-text)',
    backgroundColor: 'transparent',
    fontSize: 'var(--md-font-size)',
  },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': {
    fontFamily: 'var(--md-font-family)',
    lineHeight: 'var(--md-line-height)',
    // 字間は em の比で持つ。スクロール領域で決めた値が、本文と、部品が測る記号の幅に継承される。
    letterSpacing: 'var(--md-letter-spacing)',
    overflow: 'auto',
  },
  '.cm-content': {
    boxSizing: 'border-box',
    width: '100%',
    maxWidth: `calc(var(--md-max-width) + 2 * ${PAD_X})`,
    margin: '0 auto',
    // 上の余白は、浮動の上部バーの下に最初の行を置く 104px。競合バーの表示中は、バーが本文の領域の上に専用の行を取るので、
    // styles.css が --md-content-top を段落間隔程度に詰める。
    padding: `var(--md-content-top, 104px) ${PAD_X} 45vh`,
    caretColor: 'var(--md-color-caret)',
    // 長い URL や英単語は、本文の幅で折り返す。日本語は禁則を厳しめ（小書きの仮名や長音を行頭に置かない）にする。
    overflowWrap: 'anywhere',
    lineBreak: 'strict',
  },
  '.cm-line': { padding: '0' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--md-color-caret)', borderLeftWidth: '2px' },
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground': {
    background: 'var(--md-color-selection)',
  },
  // 空行（空白だけの行を含む）の高さは、段落間隔（--md-paragraph-spacing: 空行 1 つの高さを、行高に対する倍率で）で決める。
  // 素のテキストの空行には本体が、Markdown の文書の空行（コードフェンスの中を除く）には Markdown の見た目の部品が、この class を付ける。
  // 段落間隔が 0 でも 4px は残す: 高さ 0 の行は、カーソルが見えず、クリックでも選べない。
  // 上下キーで低い行を飛ばさない補正は verticalMotion.ts。
  '.cm-md-blank': {
    lineHeight: 'max(calc(var(--md-line-height) * var(--md-paragraph-spacing) * 1em), 4px)',
  },
  '.cm-panels': {
    backgroundColor: 'var(--md-color-panel)',
    color: 'var(--md-color-text)',
    borderColor: 'var(--md-color-border)',
    fontFamily: 'var(--md-font-family)',
    fontSize: '14px',
    lineHeight: '1.4',
  },
  '.cm-panels input, .cm-panels button': { fontFamily: 'inherit', fontSize: 'inherit' },
  '.cm-searchMatch': { backgroundColor: 'var(--md-color-match)' },
  '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: 'var(--md-color-match-selected)' },
});
