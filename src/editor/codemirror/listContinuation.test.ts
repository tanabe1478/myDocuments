import { insertNewlineContinueMarkup, markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { EditorSelection, EditorState, type StateCommand } from '@codemirror/state';
import { describe, expect, it } from 'vitest';
import { insertNewlineContinueTight } from './listContinuation';

/** `|` をカーソル位置として読み、コマンドを 1 回実行する。結果の文書と、カーソルを `|` で戻した文字列を返す。 */
function run(command: StateCommand, source: string, extensions = [markdown({ base: markdownLanguage })]) {
  // 複数のカーソルは、この設定がないと先頭の 1 つに畳まれる（本体は drawSelection が足す）。
  const parts = source.split('|');
  // カーソルの印がなければ、文書の末尾に置く。
  if (parts.length === 1) parts.push('');
  const doc = parts.join('');
  let pos = 0;
  const cursors: number[] = [];
  parts.slice(0, -1).forEach((part) => {
    pos += part.length;
    cursors.push(pos);
  });
  const state = EditorState.create({
    doc,
    selection: EditorSelection.create(cursors.map((c) => EditorSelection.cursor(c))),
    extensions: [EditorState.allowMultipleSelections.of(true), ...extensions],
  });
  let result: EditorState | null = null;
  const handled = command({ state, dispatch: (tr) => (result = tr.state) });
  if (!result) return { handled, doc, withCursor: source, state };
  const after = result as EditorState;
  const text = after.doc.toString();
  let marked = text;
  [...after.selection.ranges].reverse().forEach((r) => {
    marked = `${marked.slice(0, r.to)}|${marked.slice(r.to)}`;
  });
  return { handled, doc: text, withCursor: marked, state: after };
}

const tight = (source: string) => run(insertNewlineContinueTight, source);
const preserve = (source: string) => run(insertNewlineContinueMarkup, source);

describe('insertNewlineContinueTight: loose list で空行を入れない', () => {
  it('(1) 再現した文書の末尾で、改行と記号だけを入れる', () => {
    const source = '大規模処理\n- パッチ\n  - Batches\n  - 他にも\n\n\n\n- temperature について|';
    expect(tight(source).withCursor).toBe(`${source.slice(0, -1)}\n- |`);
    // 比較: lang-markdown の既定は空行を足す。
    expect(preserve(source).withCursor).toBe(`${source.slice(0, -1)}\n\n- |`);
  });

  it('(2) 項目の間が空行 1 つのリストでも、次の項目だけを入れる', () => {
    expect(tight('- a\n\n- b|').withCursor).toBe('- a\n\n- b\n- |');
    expect(preserve('- a\n\n- b|').withCursor).toBe('- a\n\n- b\n\n- |');
  });

  it('(3) 番号付きの loose list では、次の番号だけが入る', () => {
    expect(tight('1. a\n\n2. b|').withCursor).toBe('1. a\n\n2. b\n3. |');
    expect(preserve('1. a\n\n2. b|').withCursor).toBe('1. a\n\n2. b\n\n3. |');
  });

  it('(3b) 番号付きの途中で続けると、後ろの番号を付け直す', () => {
    expect(tight('1. a|\n\n2. b\n\n3. c').withCursor).toBe('1. a\n2. |\n\n3. b\n\n4. c');
  });

  it('(4) タスクの loose list では、未完了の記号が入る', () => {
    expect(tight('- [x] a\n\n- [ ] b|').withCursor).toBe('- [x] a\n\n- [ ] b\n- [ ] |');
    expect(tight('- [x] a\n\n- [x] b|').withCursor).toBe('- [x] a\n\n- [x] b\n- [ ] |');
  });

  it('(5) 入れ子の loose list では、インデントが保たれる', () => {
    const source = '- a\n  - b\n\n  - c|';
    expect(tight(source).withCursor).toBe('- a\n  - b\n\n  - c\n  - |');
    // 比較: lang-markdown の既定は、入れ子の分のインデントだけの空行を足す。
    expect(preserve(source).doc).toMatch(/^- a\n {2}- b\n\n {2}- c\n[ ]*\n {2}- $/);
  });

  it('(5b) 外側のリストが loose で、入れ子の項目で続ける', () => {
    expect(tight('- a\n\n  - b|\n\n- c').withCursor).toBe('- a\n\n  - b\n  - |\n\n- c');
  });

  it('(6) 空の項目で Enter を押すと、リストを終える（loose list でも）', () => {
    expect(tight('- a\n\n- b\n\n- |').withCursor).toBe('- a\n\n- b\n\n|');
    expect(tight('- a\n\n- b\n\n- |').doc).toBe(preserve('- a\n\n- b\n\n- |').doc);
  });

  it('(6b) 入れ子の空の項目では、1 段戻す', () => {
    const source = '- a\n  - b\n\n  - |';
    expect(tight(source).doc).toBe(preserve(source).doc);
    expect(tight(source).withCursor).toBe('- a\n  - b\n\n- |');
  });

  it('(7) 項目の途中で押すと、後半が次の項目になり、空行は入らない', () => {
    expect(tight('- a\n\n- bb|cc\n\n- d').withCursor).toBe('- a\n\n- bb\n- |cc\n\n- d');
    expect(preserve('- a\n\n- bb|cc\n\n- d').withCursor).toBe('- a\n\n- bb\n\n- |cc\n\n- d');
  });

  it('(8) 引用の中のリストでも、引用の記号を続けて空行を入れない', () => {
    expect(tight('> - a\n>\n> - b|').withCursor).toBe('> - a\n>\n> - b\n> - |');
    expect(preserve('> - a\n>\n> - b|').withCursor).toBe('> - a\n>\n> - b\n>\n> - |');
  });

  it('(8b) 引用そのものの継続は変わらない', () => {
    expect(tight('> a|').withCursor).toBe('> a\n> |');
    expect(tight('> a|').doc).toBe(preserve('> a|').doc);
  });

  it('(9) tight list は lang-markdown と同じ結果になる', () => {
    for (const source of [
      '- a\n- b|',
      '1. a\n2. b|',
      '- [ ] a\n- [ ] b|',
      '- a\n  - b|',
      '- a|',
      '* a\n* b|',
      '10. a\n11. b|',
      '- a\n- |',
      '- a|\n- b',
      '段落|',
      '',
    ]) {
      const a = tight(source);
      const b = preserve(source);
      expect(a.handled, source).toBe(b.handled);
      expect(a.withCursor, source).toBe(b.withCursor);
    }
  });

  it('tight list の空の 2 項目目で Enter を押すと、lang-markdown の既定どおりリストを loose にする（変えない）', () => {
    expect(tight('- a\n- |').withCursor).toBe('- a\n\n- |');
    expect(preserve('- a\n- |').withCursor).toBe('- a\n\n- |');
  });

  it('複数のカーソルでも、それぞれ空行を入れない', () => {
    const source = '- a\n\n- b|\n\n段落\n\n- c\n\n- d|';
    expect(tight(source).withCursor).toBe('- a\n\n- b\n- |\n\n段落\n\n- c\n\n- d\n- |');
  });

  it('リストの外では何もしない（次のキー割り当てに回す）', () => {
    expect(tight('段落|').handled).toBe(false);
    expect(tight('# 見出し|').handled).toBe(false);
  });

  it('範囲選択があるときは何もしない', () => {
    const state = EditorState.create({
      doc: '- a\n\n- b',
      selection: EditorSelection.range(0, 3),
      extensions: [markdown({ base: markdownLanguage })],
    });
    expect(insertNewlineContinueTight({ state, dispatch: () => {} })).toBe(false);
  });

  it('Markdown でない文書（.txt）では何もしない', () => {
    const r = run(insertNewlineContinueTight, '- a\n\n- b|', []);
    expect(r.handled).toBe(false);
  });

  it('1 回の transaction で行われる（Undo 1 回で戻る）', () => {
    const state = EditorState.create({
      doc: '- a\n\n- b',
      selection: EditorSelection.cursor(8),
      extensions: [markdown({ base: markdownLanguage })],
    });
    const trs: unknown[] = [];
    insertNewlineContinueTight({ state, dispatch: (tr) => trs.push(tr) });
    expect(trs).toHaveLength(1);
  });
});
