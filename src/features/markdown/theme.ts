import { EditorView } from '@codemirror/view';
import { MARKER_WIDGET_EM } from './liveMarkup';

/**
 * Markdown の見た目（見出し、コードフェンスの帯、引用の縦線、隠した行の • とチェックボックス、リンクの準備）。
 * class 名と付く要素は、本体のテーマにあったころと同じ。色は CSS 変数（styles.css と src/preferences/apply.ts）で、明暗テーマに追従する。
 * 空行の高さ（cm-md-blank）は段落間隔の設定で、素のテキストと共通なので、本体のテーマにある。
 */
export const markdownTheme = EditorView.theme({
  // 見出し前の間隔は padding で付ける。CodeMirror は行の高さを getBoundingClientRect().height（margin を含まない）
  // で測るため、行の margin は内部の高さ情報に入らず、上下キーのカーソル移動が行を飛ばす（ED-03）。
  // 見出し前の余白は、空行と同じく段落間隔（--md-paragraph-spacing: 空行 1 つの高さを、行高に対する倍率で）で決める。
  '.cm-md-heading': {
    paddingTop: 'calc(var(--md-paragraph-spacing) * var(--md-line-height) * var(--md-font-size) * 0.8)',
    letterSpacing: 'var(--md-letter-spacing)',
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
  // コードブロックの中身の既定の見た目。言語が分かると、構文木が CodeText を置き換え、tag のない文字は monospace の tag を受け継がない。
  // 行の class は色（tag のある文字の色はその上に重なる）、mark の class は等幅と大きさ（codeHighlight.ts）。フェンスの行には付けない。
  '.cm-line.cm-md-fence-code': { color: 'var(--md-color-code)' },
  '.cm-md-code-text': { fontFamily: 'var(--md-font-family-mono)', fontSize: '0.92em' },
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
  // 記号を隠した行の • とチェックボックス（markdownDecorations.ts）。幅は固定の箱（ぶら下げインデントの計算と合わせる）。
  // 行のぶら下げ（text-indent の負の値）を、箱の中の文字に引き継がない。
  '.cm-md-marker': {
    display: 'inline-block',
    boxSizing: 'border-box',
    width: `${MARKER_WIDGET_EM}em`,
    textAlign: 'center',
    textIndent: '0',
    letterSpacing: '0',
    color: 'var(--md-color-text)',
  },
  '.cm-md-bullet': { opacity: '0.6' },
  // クリックで切り替わる（taskToggle.ts）。ウィジェットは、記号を隠した行にしか出ない。
  '.cm-md-task': { cursor: 'pointer' },
  '.cm-md-task-box': {
    display: 'inline-block',
    boxSizing: 'border-box',
    width: '0.78em',
    height: '0.78em',
    verticalAlign: '-0.08em',
    border: '1.5px solid var(--md-color-quote-bar)',
    borderRadius: '3px',
    position: 'relative',
  },
  '.cm-md-task-done .cm-md-task-box': { backgroundColor: 'var(--md-color-quote-bar)' },
  '.cm-md-task-done .cm-md-task-box::after': {
    content: '""',
    position: 'absolute',
    left: '0.2em',
    top: '0.02em',
    width: '0.2em',
    height: '0.4em',
    borderRight: '2px solid var(--md-color-surface)',
    borderBottom: '2px solid var(--md-color-surface)',
    transform: 'rotate(45deg)',
  },
  // ⌘/Ctrl を押している間、リンクの上でポインタの形を変える（linkOpen.ts。クリックで開く）。
  '&.cm-md-link-ready .cm-md-link': { cursor: 'pointer' },
  '.cm-md-h1': { fontSize: '1.75em', lineHeight: '1.4' },
  '.cm-md-h2': { fontSize: '1.45em', lineHeight: '1.45' },
  '.cm-md-h3': { fontSize: '1.25em', lineHeight: '1.5' },
  '.cm-md-h4, .cm-md-h5, .cm-md-h6': { fontSize: '1.08em', lineHeight: '1.6' },
});
