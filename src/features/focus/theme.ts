import { EditorView } from '@codemirror/view';

/**
 * 弱く表示する行（class cm-md-dim）の見た目。不透明度の値と、切り替えの遷移の長さ・イージングは変えない。
 * 遷移は Reduced Motion でないときだけ付ける（reduce のときは付けない）。
 */
export const focusTheme = EditorView.theme({
  '.cm-md-dim': { opacity: '0.38' },
  '@media (prefers-reduced-motion: no-preference)': {
    '.cm-md-dim': { transition: 'opacity 0.25s ease' },
  },
});
