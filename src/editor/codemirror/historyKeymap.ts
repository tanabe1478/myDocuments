import { redo, redoSelection, undo, undoSelection } from '@codemirror/commands';
import type { KeyBinding } from '@codemirror/view';

/**
 * Undo / Redo のキー（UI-10: 各 OS の標準に従う）。
 *
 * - Undo: 全 OS で Mod+Z（Mod は mac では Cmd、それ以外は Ctrl）。
 * - Redo: mac は Cmd+Shift+Z。Windows と Linux は Ctrl+Y と Ctrl+Shift+Z の両方。
 *
 * CodeMirror 既定の historyKeymap は Windows の Redo が Ctrl+Y だけで、Ctrl+Shift+Z は Linux 専用。
 * OS ごとに押すキーが一つずつ違う組なので、同じキーに二つの Redo は割り当たらない（二重発火しない）。
 */
export const historyKeymap: readonly KeyBinding[] = [
  { key: 'Mod-z', run: undo, preventDefault: true },
  // mac は Cmd+Shift+Z だけ。それ以外の OS（key のまま）は Ctrl+Y。
  { key: 'Mod-y', mac: 'Mod-Shift-z', run: redo, preventDefault: true },
  // Windows と Linux の二つ目の Redo。mac は対象外（key を持たないので mac には割り当たらない）。
  { win: 'Ctrl-Shift-z', linux: 'Ctrl-Shift-z', run: redo, preventDefault: true },
  { key: 'Mod-u', run: undoSelection, preventDefault: true },
  { key: 'Alt-u', mac: 'Mod-Shift-u', run: redoSelection, preventDefault: true },
];
