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
    // 字間は em の比で持つ。スクロール領域で決めた値が、本文と記号の幅の測定（markdownDecorations.ts）に継承される。
    letterSpacing: 'var(--md-letter-spacing)',
    overflow: 'auto',
  },
  '.cm-content': {
    boxSizing: 'border-box',
    width: '100%',
    maxWidth: `calc(var(--md-max-width) + 2 * ${PAD_X})`,
    margin: '0 auto',
    padding: `104px ${PAD_X} 45vh`,
    caretColor: 'var(--md-color-caret)',
    // 長い URL や英単語は、本文の幅で折り返す。日本語は禁則を厳しめ（小書きの仮名や長音を行頭に置かない）にする。
    overflowWrap: 'anywhere',
    lineBreak: 'strict',
  },
  '.cm-line': { padding: '0' },
  // フォーカスモード: カーソルのある段落以外を弱く表示する。
  // 切り替えの遷移は styles.css（Reduced Motion のときは付けない）。
  '.cm-md-dim': { opacity: '0.38' },
  // タイプライターモード: 本文の上下に表示領域の半分の余白（値は typewriterMode.ts が設定する）。
  '&.cm-typewriter .cm-content': {
    paddingTop: 'var(--md-typewriter-pad, 50vh)',
    paddingBottom: 'var(--md-typewriter-pad, 50vh)',
  },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--md-color-caret)', borderLeftWidth: '2px' },
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground': {
    background: 'var(--md-color-selection)',
  },
  // 見出し前の間隔は padding で付ける。CodeMirror は行の高さを getBoundingClientRect().height（margin を含まない）
  // で測るため、行の margin は内部の高さ情報に入らず、上下キーのカーソル移動が行を飛ばす（ED-03）。
  // 空行と見出し前の余白は、どちらも段落間隔（--md-paragraph-spacing: 空行 1 つの高さを、行高に対する倍率で）で決める。
  '.cm-md-heading': {
    paddingTop: 'calc(var(--md-paragraph-spacing) * var(--md-line-height) * var(--md-font-size) * 0.8)',
    letterSpacing: 'var(--md-letter-spacing)',
  },
  // 空行（空白だけの行を含む）。行高だけを変える。コードフェンスの中の空行は対象外（markdownDecorations.ts）。
  // 段落間隔が 0 でも 4px は残す: 高さ 0 の行は、カーソルが見えず、クリックでも選べない。
  // 上下キーで低い行を飛ばさない補正は verticalMotion.ts。
  '.cm-md-blank': {
    lineHeight: 'max(calc(var(--md-line-height) * var(--md-paragraph-spacing) * 1em), 4px)',
  },
  // コードフェンス: 開始・終了行を含む行に背景帯。左右に少しはみ出させ、文字を帯の端から離す。
  '.cm-line.cm-md-fence': {
    padding: '0 12px',
    margin: '0 -12px',
    backgroundColor: 'var(--md-color-code-bg)',
  },
  // 帯の上下の余白は、開始・終了行の padding で付ける（margin は CodeMirror が高さに数えず、上下キーが行を飛ばす）。
  '.cm-line.cm-md-fence-start': {
    paddingTop: '0.6em',
    borderTopLeftRadius: '6px',
    borderTopRightRadius: '6px',
  },
  '.cm-line.cm-md-fence-end': {
    paddingBottom: '0.6em',
    borderBottomLeftRadius: '6px',
    borderBottomRightRadius: '6px',
  },
  // 引用: 行の左（本文の余白の中）に細い縦線。続く行で 1 本につながる。
  '.cm-md-quote': { position: 'relative' },
  '.cm-md-quote::before': {
    content: '""',
    position: 'absolute',
    left: '-14px',
    top: '0',
    bottom: '0',
    width: '3px',
    borderRadius: '2px',
    backgroundColor: 'var(--md-color-quote-bar)',
  },
  '.cm-md-h1': { fontSize: '1.75em', lineHeight: '1.4' },
  '.cm-md-h2': { fontSize: '1.45em', lineHeight: '1.45' },
  '.cm-md-h3': { fontSize: '1.25em', lineHeight: '1.5' },
  '.cm-md-h4, .cm-md-h5, .cm-md-h6': { fontSize: '1.08em', lineHeight: '1.6' },
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
