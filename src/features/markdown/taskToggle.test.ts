import { markdownLanguage } from '@codemirror/lang-markdown';
import { Text } from '@codemirror/state';
import { describe, expect, it } from 'vitest';
import { taskToggleAt } from './taskToggle';

/** source の中で、n 番目の（0 始まり）"- [" などの記号の先頭（ウィジェットの位置）。marker は探す文字列。 */
function toggle(source: string, marker: string, nth = 0): string | null {
  const doc = Text.of(source.split('\n'));
  const tree = markdownLanguage.parser.parse(source);
  let pos = -1;
  for (let i = 0; i <= nth; i++) pos = source.indexOf(marker, pos + 1);
  const change = taskToggleAt(tree, doc, pos);
  if (!change) return null;
  return source.slice(0, change.from) + change.insert + source.slice(change.to);
}

describe('taskToggleAt', () => {
  it('未完了 [ ] を完了 [x] にする（1 文字だけ）', () => {
    expect(toggle('- [ ] a', '- [')).toBe('- [x] a');
  });

  it('完了 [x] と [X] を未完了にする', () => {
    expect(toggle('- [x] a', '- [')).toBe('- [ ] a');
    expect(toggle('- [X] a', '- [')).toBe('- [ ] a');
  });

  it('範囲は 1 文字（[ と ] と本文は変えない）', () => {
    const doc = Text.of(['- [ ] a [ ]']);
    const change = taskToggleAt(markdownLanguage.parser.parse('- [ ] a [ ]'), doc, 0);
    expect(change).toEqual({ from: 3, to: 4, insert: 'x' });
  });

  it('入れ子のタスク', () => {
    const src = '- [ ] a\n  - [x] b\n    - [ ] c';
    expect(toggle(src, '- [', 1)).toBe('- [ ] a\n  - [ ] b\n    - [ ] c');
    expect(toggle(src, '- [', 2)).toBe('- [ ] a\n  - [x] b\n    - [x] c');
  });

  it('引用の中のタスク', () => {
    expect(toggle('> - [ ] a', '- [')).toBe('> - [x] a');
    expect(toggle('> > - [x] a', '- [')).toBe('> > - [ ] a');
  });

  it('記号が * と + のタスク', () => {
    expect(toggle('* [ ] a', '* [')).toBe('* [x] a');
    expect(toggle('+ [x] a', '+ [')).toBe('+ [ ] a');
  });

  it('同じ文書の複数のタスクのうち、位置のものだけ', () => {
    expect(toggle('- [ ] a\n- [ ] b\n- [x] c', '- [', 1)).toBe('- [ ] a\n- [x] b\n- [x] c');
  });

  it('番号付きのタスクと、チェックボックスでない [ ] は対象外', () => {
    expect(toggle('1. [ ] a', '1.')).toBeNull();
    expect(toggle('- a [ ] b', '- ')).toBeNull();
    expect(toggle('[ ] a', '[ ]')).toBeNull();
  });

  it('コードフェンスと frontmatter の中は対象外', () => {
    expect(toggle('```\n- [ ] a\n```', '- [')).toBeNull();
    expect(toggle('---\n- [ ] a\n---\ntext', '- [')).toBeNull();
  });

  it('タスクの位置でない pos は対象外', () => {
    const src = '- [ ] a';
    const doc = Text.of([src]);
    const tree = markdownLanguage.parser.parse(src);
    expect(taskToggleAt(tree, doc, 2)).toBeNull();
    expect(taskToggleAt(tree, doc, -1)).toBeNull();
    expect(taskToggleAt(tree, doc, 99)).toBeNull();
  });
});
