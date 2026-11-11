import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { ensureSyntaxTree } from '@codemirror/language';
import { EditorSelection, EditorState } from '@codemirror/state';
import { describe, expect, it } from 'vitest';
import { continuationPrefix, languageRangeAt, planFenceEnter, planFenceExit, type FencePlan } from './codeFence';

/** `|` の位置にカーソルを置いた state（`|` は取り除く）。構文解析は最後まで済ませる。 */
function stateOf(marked: string, extra: { readOnly?: boolean; ranges?: Array<[number, number]> } = {}): EditorState {
  const at = marked.indexOf('|');
  const doc = marked.replace('|', '');
  const state = EditorState.create({
    doc,
    selection: extra.ranges ? EditorSelection.create(extra.ranges.map(([a, h]) => EditorSelection.range(a, h))) : EditorSelection.cursor(at),
    extensions: [markdown({ base: markdownLanguage }), EditorState.readOnly.of(extra.readOnly === true), EditorState.allowMultipleSelections.of(true)],
  });
  ensureSyntaxTree(state, state.doc.length, 10_000);
  return state;
}

/** 計画を適用した後の本文（カーソルの位置に `|`）。計画がなければ null。 */
function applied(plan: FencePlan | null, state: EditorState): string | null {
  if (!plan) return null;
  const next = state.update(plan.spec).state;
  const head = next.selection.main.head;
  const doc = next.doc.toString();
  return `${doc.slice(0, head)}|${doc.slice(head)}`;
}

const enter = (marked: string) => {
  const state = stateOf(marked);
  return applied(planFenceEnter(state), state);
};
const exit = (marked: string) => {
  const state = stateOf(marked);
  return applied(planFenceExit(state), state);
};

describe('Enter at the end of an opening fence line (ADR-004 追補（コードブロック）)', () => {
  it('adds an empty line and a closing fence when the block has none, and puts the cursor on the empty line', () => {
    expect(enter('```ts|')).toBe('```ts\n|\n```');
    expect(enter('```|')).toBe('```\n|\n```');
    expect(enter('text\n\n```python|')).toBe('text\n\n```python\n|\n```');
    expect(enter('```ts|\nconst a = 1;')).toBe('```ts\n|\n```\nconst a = 1;');
    expect(enter('```main.py|')).toBe('```main.py\n|\n```');
    expect(enter('```python:main.py|')).toBe('```python:main.py\n|\n```');
  });

  it('uses the same character and the same length for the closing fence (~~~ and four or more backticks)', () => {
    expect(enter('~~~py|')).toBe('~~~py\n|\n~~~');
    expect(enter('~~~~|')).toBe('~~~~\n|\n~~~~');
    expect(enter('````md|')).toBe('````md\n|\n````');
    expect(enter('``````|')).toBe('``````\n|\n``````');
  });

  it('does not add a closing fence when the block already has one (plain newline: the other bindings decide)', () => {
    expect(enter('```ts|\nfoo\n```')).toBeNull();
    expect(enter('~~~|\nfoo\n~~~')).toBeNull();
    expect(enter('````md|\n```\nx\n```\n````')).toBeNull();
  });

  it('only at the end of the line, not in the middle, and not inside or after the code', () => {
    expect(enter('```t|s')).toBeNull();
    expect(enter('``|`ts')).toBeNull();
    expect(enter('|```ts')).toBeNull();
    expect(enter('```ts\nfoo|')).toBeNull();
    expect(enter('```ts\nfoo\n```|\nafter')).toBeNull();
    expect(enter('plain text|')).toBeNull();
    expect(enter('``|')).toBeNull();
    expect(enter('`inline` code|')).toBeNull();
  });

  it('adds the container marks of a blockquote to both lines', () => {
    expect(enter('> ```ts|')).toBe('> ```ts\n> |\n> ```');
    expect(enter('> > ```|')).toBe('> > ```\n> > |\n> > ```');
    expect(enter('> ```ts|\n> foo')).toBe('> ```ts\n> |\n> ```\n> foo');
    // 閉じのある引用の中のコードブロックは、そのまま。
    expect(enter('> ```ts|\n> foo\n> ```')).toBeNull();
  });

  it('indents both lines to the text of a list item', () => {
    expect(enter('- ```ts|')).toBe('- ```ts\n  |\n  ```');
    expect(enter('1. ```ts|')).toBe('1. ```ts\n   |\n   ```');
    expect(enter('* a\n\n  ```sh|')).toBe('* a\n\n  ```sh\n  |\n  ```');
    expect(enter('- a\n  - ```ts|')).toBe('- a\n  - ```ts\n    |\n    ```');
    expect(enter('> - ```ts|')).toBe('> - ```ts\n>   |\n>   ```');
    expect(enter('  ```ts|')).toBe('  ```ts\n  |\n  ```');
    expect(enter('- ```ts|\n  foo\n  ```')).toBeNull();
  });

  it('does not add anything for shapes it cannot continue (a tab before the fence)', () => {
    expect(continuationPrefix('\t')).toBeNull();
    expect(continuationPrefix('-\t')).toBeNull();
    expect(continuationPrefix('')).toBe('');
    expect(continuationPrefix('> ')).toBe('> ');
    expect(continuationPrefix('1. ')).toBe('   ');
    expect(continuationPrefix('> - ')).toBe('>   ');
    expect(continuationPrefix('x ')).toBeNull();
    expect(enter('\t```ts|')).toBeNull();
  });

  it('does nothing for a range selection, several selections, and a read-only document', () => {
    const doc = '```ts';
    for (const state of [
      stateOf('```ts|', { ranges: [[0, 5]] }),
      stateOf('```ts|', { ranges: [[0, 0], [5, 5]] }),
      stateOf('```ts|', { readOnly: true }),
    ]) {
      expect(state.doc.toString()).toBe(doc);
      expect(planFenceEnter(state)).toBeNull();
      expect(planFenceExit(state)).toBeNull();
    }
  });

  it('does nothing while the syntax tree is not complete (a partial tree cannot tell whether the block is closed)', () => {
    const doc = '```ts\n' + 'x\n'.repeat(5);
    const state = EditorState.create({ doc, selection: EditorSelection.cursor(5), extensions: [] });
    // Markdown の言語がない state: 構文木がない。
    expect(planFenceEnter(state)).toBeNull();
  });

  it('is one transaction, an input event', () => {
    const state = stateOf('```ts|');
    const plan = planFenceEnter(state)!;
    expect(plan.spec.userEvent).toBe('input');
    expect(state.update(plan.spec).changes.empty).toBe(false);
  });
});

describe('Enter at the end of a closing fence line: no duplicate fence (ADR-004 追補（コードブロック）)', () => {
  it('removes the old closing fence that became a new opening fence, and puts the cursor on the line after the block', () => {
    // 閉じのフェンスの直前に、ユーザーが閉じのフェンスを打った。元の閉じは、開きのフェンスになっている。
    expect(enter('```ts\nfoo\n```|\n```')).toBe('```ts\nfoo\n```\n|');
    expect(enter('```ts\nfoo\n```|\n```\nafter')).toBe('```ts\nfoo\n```\n|\nafter');
    expect(enter('~~~\nfoo\n~~~|\n~~~\n')).toBe('~~~\nfoo\n~~~\n|\n');
    expect(enter('````\nfoo\n````|\n````')).toBe('````\nfoo\n````\n|');
    expect(enter('> ```ts\n> foo\n> ```|\n> ```')).toBe('> ```ts\n> foo\n> ```\n> |');
    expect(enter('- ```ts\n  foo\n  ```|\n  ```')).toBe('- ```ts\n  foo\n  ```\n  |');
  });

  it('also removes it when the old closing fence swallowed a later block: it took the opening fence of the next block into its code (b), or the fences after it are now odd (c)', () => {
    // (b) 後ろの、情報文字列のあるコードブロックの開きのフェンスを、コードとして巻き込んでいる。
    expect(enter('```ts\nfoo\n```|\n```\n\n```py\nbar\n```')).toBe('```ts\nfoo\n```\n|\n\n```py\nbar\n```');
    // (c) 後ろのコードブロックが、情報文字列のない開きのフェンスで始まる。ずれが最後のコードブロックを閉じのないものにしている。
    expect(enter('```ts\nfoo\n```|\n```\n\n```\nbar\n```')).toBe('```ts\nfoo\n```\n|\n\n```\nbar\n```');
    expect(enter('> ```ts\n> foo\n> ```|\n> ```\n>\n> ```py\n> bar\n> ```')).toBe('> ```ts\n> foo\n> ```\n> |\n>\n> ```py\n> bar\n> ```');
  });

  it('does not remove a line that really is another block (it has an info string, is a well-formed block of its own, or is a different character)', () => {
    expect(enter('```ts\nfoo\n```|\n```js\nbar')).toBeNull();
    expect(enter('```\nfoo\n```|\n```\nbar\n```')).toBeNull();
    expect(enter('```\nfoo\n```|\n```\nbar\n```\n\ntext\n\n```py\nbaz\n```')).toBeNull();
    expect(enter('```\nfoo\n```|\n~~~')).toBeNull();
    expect(enter('```\nfoo\n```|\n> ```')).toBeNull();
    expect(enter('```\nfoo\n```|\nplain')).toBeNull();
    expect(enter('```\nfoo\n```|')).toBeNull();
    expect(enter('```\nfoo\n```|\n\n```')).toBeNull();
  });

  it('does not touch the closing fence line when the cursor is not at its end, or text follows the fence on the next line', () => {
    expect(enter('```ts\nfoo\n``|`\n```')).toBeNull();
    expect(enter('```ts\nfoo\n```|\n``` x')).toBeNull();
  });
});

describe('Mod-Enter leaves the code block (ADR-004 追補（コードブロック）)', () => {
  it('moves to the line after the closing fence', () => {
    expect(exit('```ts\nfo|o\n```\nafter')).toBe('```ts\nfoo\n```\n|after');
    expect(exit('```ts\nfoo\n```|\nafter')).toBe('```ts\nfoo\n```\n|after');
    expect(exit('```ts\nfoo\n```\n\nafter|')).toBeNull();
    expect(exit('~~~\n|\n~~~\nx')).toBe('~~~\n\n~~~\n|x');
    // 開きのフェンスの行からも出られる。
    expect(exit('```ts|\nfoo\n```\nafter')).toBe('```ts\nfoo\n```\n|after');
  });

  it('adds a line after the closing fence when it is the last line', () => {
    expect(exit('```ts\nfo|o\n```')).toBe('```ts\nfoo\n```\n|');
    expect(exit('> ```ts\n> fo|o\n> ```')).toBe('> ```ts\n> foo\n> ```\n> |');
    expect(exit('- ```ts\n  fo|o\n  ```')).toBe('- ```ts\n  foo\n  ```\n  |');
  });

  it('puts the cursor after the container mark of the next line', () => {
    expect(exit('> ```ts\n> fo|o\n> ```\n> after')).toBe('> ```ts\n> foo\n> ```\n> |after');
  });

  it('adds the closing fence of a block that has none, then leaves it', () => {
    expect(exit('```ts\nfo|o')).toBe('```ts\nfoo\n```\n|');
    expect(exit('```ts\nfo|o\n')).toBe('```ts\nfoo\n```\n|');
    expect(exit('````md\n|x')).toBe('````md\nx\n````\n|');
    expect(exit('> ```ts\n> fo|o')).toBe('> ```ts\n> foo\n> ```\n> |');
  });

  it('is not for the outside of a code block, nor an indented code block, nor an HTML block', () => {
    expect(exit('plain| text')).toBeNull();
    expect(exit('- item|')).toBeNull();
    expect(exit('    indented| code')).toBeNull();
    expect(exit('`inline|`')).toBeNull();
    expect(exit('<div>\n```ts\nfo|o\n```\n</div>')).toBeNull();
  });
});

describe('where the language name is completed', () => {
  const at = (marked: string) => {
    const state = stateOf(marked);
    return languageRangeAt(state, state.selection.main.head);
  };

  it('is the first word of the info string of an opening fence, up to the colon', () => {
    expect(at('```|')).toEqual({ from: 3, to: 3 });
    expect(at('```t|')).toEqual({ from: 3, to: 4 });
    expect(at('```ts|')).toEqual({ from: 3, to: 5 });
    expect(at('```t|s')).toEqual({ from: 3, to: 5 });
    expect(at('``` ts|')).toEqual({ from: 4, to: 6 });
    expect(at('```python|:main.py')).toEqual({ from: 3, to: 9 });
    expect(at('```|:main.py')).toEqual({ from: 3, to: 3 });
    expect(at('```py|thon title="x"')).toEqual({ from: 3, to: 9 });
    expect(at('~~~r|')).toEqual({ from: 3, to: 4 });
    expect(at('> ```t|')).toEqual({ from: 5, to: 6 });
    expect(at('- ```t|')).toEqual({ from: 5, to: 6 });
    expect(at('text\n\n```t|\nfoo')).toEqual({ from: 9, to: 10 });
  });

  it('is nowhere else: the file name part, the second word, the fence marks, the code, a closing fence, the body text', () => {
    expect(at('```python:ma|in.py')).toBeNull();
    expect(at('```python:|')).toBeNull();
    expect(at('```ts titl|e')).toBeNull();
    expect(at('``|`ts')).toBeNull();
    expect(at('|```ts')).toBeNull();
    expect(at('```ts\nconst `` a|\n```')).toBeNull();
    expect(at('```ts\nfoo\n```|')).toBeNull();
    expect(at('```ts\n```t|\n```')).toBeNull();
    expect(at('ts|')).toBeNull();
    expect(at('# head```t|')).toBeNull();
    expect(at('`code`|')).toBeNull();
    expect(at('    ```t|')).toBeNull();
  });
});
