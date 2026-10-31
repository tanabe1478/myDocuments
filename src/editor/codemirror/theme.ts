import { EditorView } from '@codemirror/view';

/**
 * 本文の配置と文字組み。値は CSS 変数（Preferences から src/preferences/apply.ts が設定する）。
 * 本文は中央寄せで、最大幅は --md-max-width。スクロールバーは窓の端に置く。
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
    overflow: 'auto',
  },
  '.cm-content': {
    boxSizing: 'border-box',
    width: '100%',
    maxWidth: 'var(--md-max-width)',
    margin: '0 auto',
    padding: '104px 28px 45vh',
    caretColor: 'var(--md-color-caret)',
  },
  '.cm-line': { padding: '0' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--md-color-caret)', borderLeftWidth: '2px' },
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground': {
    background: 'var(--md-color-selection)',
  },
  '.cm-md-heading': { marginTop: 'calc(var(--md-paragraph-spacing) * 0.8)' },
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
