import { redo, undo } from '@codemirror/commands';
import { describe, expect, it } from 'vitest';
import { historyKeymap } from './historyKeymap';

type Platform = 'mac' | 'win' | 'linux';

/** CodeMirror が buildKeymap で行うのと同じ、platform ごとのキー名の選び方。 */
function keysFor(platform: Platform, command: unknown): string[] {
  return historyKeymap
    .filter((b) => b.run === command)
    .map((b) => b[platform] ?? b.key)
    .filter((k): k is string => typeof k === 'string');
}

describe('historyKeymap (UI-10)', () => {
  it('Undo は全 OS で Mod-z', () => {
    for (const p of ['mac', 'win', 'linux'] as const) expect(keysFor(p, undo)).toEqual(['Mod-z']);
  });

  it('Redo: mac は Cmd+Shift+Z だけ', () => {
    expect(keysFor('mac', redo)).toEqual(['Mod-Shift-z']);
  });

  it('Redo: Windows と Linux は Ctrl+Y と Ctrl+Shift+Z の両方（同じキーの重複なし）', () => {
    for (const p of ['win', 'linux'] as const) {
      const keys = keysFor(p, redo);
      expect(keys.slice().sort()).toEqual(['Ctrl-Shift-z', 'Mod-y']);
      expect(new Set(keys).size).toBe(keys.length);
    }
  });
});
