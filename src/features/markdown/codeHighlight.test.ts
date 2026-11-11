// @vitest-environment jsdom
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { ensureSyntaxTree } from '@codemirror/language';
import { languages } from '@codemirror/language-data';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveCodeLanguage } from '../../plugin-api';
import { markdownDecorations } from './markdownDecorations';

beforeAll(() => {
  const rect = { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON: () => ({}) };
  const rects = Object.assign([], { item: () => null });
  Range.prototype.getClientRects = () => rects as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect = () => rect as DOMRect;
  Element.prototype.getClientRects = () => rects as unknown as DOMRectList;
});

let host: HTMLElement;
let view: EditorView | null = null;

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
});

afterEach(() => {
  view?.destroy();
  view = null;
  host.remove();
  vi.restoreAllMocks();
});

/** 本体と同じ組み立て（情報文字列から言語を選ぶ Markdown の言語と、Markdown の見た目の部品の色）。 */
function mount(doc: string): EditorView {
  view = new EditorView({
    parent: host,
    state: EditorState.create({
      doc,
      extensions: [markdown({ base: markdownLanguage, codeLanguages: resolveCodeLanguage }), markdownDecorations('always')],
    }),
  });
  ensureSyntaxTree(view.state, view.state.doc.length, 10_000);
  view.dispatch({});
  return view;
}

const styleText = () => Array.from(document.querySelectorAll('style'), (s) => s.textContent ?? '').join('\n');

/** span の class（複数）が指す CSS の規則に含まれる、コードの色の CSS 変数。 */
function codeColors(el: Element): string[] {
  const rules = styleText().split('\n');
  const found: string[] = [];
  for (const cls of Array.from(el.classList)) {
    for (const rule of rules.filter((r) => r.startsWith(`.${cls} {`))) for (const m of rule.matchAll(/var\((--md-code-[a-z]+)\)/g)) found.push(m[1]!);
  }
  return found;
}

/** 本文の中で、文字列が text の span（色を付ける最小の単位）のコードの色。見つからなければ null。 */
function colorOf(v: EditorView, text: string): string[] | null {
  const spans = Array.from(v.dom.querySelectorAll('.cm-content span')).filter((s) => s.children.length === 0 && s.textContent === text);
  if (spans.length === 0) return null;
  return codeColors(spans[0]!);
}

async function waitFor(check: () => boolean, ms = 4000): Promise<void> {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() > until) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('colors in a code block (ADR-004 追補（コードブロック）)', () => {
  const DOC = '```ts\nconst a = "x"; // note\n```\n\n```text\nconst b = "y";\n```\n\n```nonexistent\nconst c = "z";\n```\n';

  it('has no color before the language is loaded, then colors keywords, strings and comments once it is', async () => {
    // 読み込みの前: 本文は表示され、色は付かない。
    const v = mount(DOC);
    expect(v.dom.textContent).toContain('const a = "x"; // note');
    expect(colorOf(v, 'const')).toBeNull();
    // 読み込みが済むと、構文木が自動で解析し直され、色が付く。
    await resolveCodeLanguage('ts')!.load();
    await waitFor(() => (colorOf(v, 'const') ?? []).includes('--md-code-keyword'));
    expect(colorOf(v, '"x"')).toContain('--md-code-string');
    expect(colorOf(v, '// note')).toContain('--md-code-comment');
  });

  it('colors numbers, functions, types and attributes in other languages too (Python by file name, JSON keys)', async () => {
    const v = mount('```main.py\ndef f(x: int):\n    return 42\n```\n\n```json\n{"a": 1}\n```\n');
    await resolveCodeLanguage('main.py')!.load();
    await resolveCodeLanguage('json')!.load();
    await waitFor(() => (colorOf(v, 'def') ?? []).includes('--md-code-keyword') && (colorOf(v, '42') ?? []).includes('--md-code-number'));
    expect(colorOf(v, '1')).toContain('--md-code-number');
    expect(colorOf(v, '"a"')).toContain('--md-code-attribute');
  });

  it('adds no color to text, plain names and unknown names, nor to the body text around the code', async () => {
    const v = mount(DOC + '\nconst body = "z";\n');
    await resolveCodeLanguage('ts')!.load();
    await waitFor(() => (colorOf(v, 'const') ?? []).includes('--md-code-keyword'));
    const lines = Array.from(v.dom.querySelectorAll('.cm-line'));
    const plain = lines.filter((l) => /const [bc] = |const body/.test(l.textContent ?? ''));
    expect(plain.length).toBe(3);
    for (const line of plain) for (const span of Array.from(line.querySelectorAll('span'))) expect(codeColors(span), line.textContent ?? '').toEqual([]);
  });

  it('keeps showing and editing when the language fails to load, with no error', async () => {
    const lua = languages.find((l) => l.name === 'Lua')!;
    vi.spyOn(lua, 'load').mockRejectedValue(new Error('chunk failed'));
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const v = mount('```lua\nlocal a = 1\n```\n');
    await resolveCodeLanguage('lua')!.load();
    await new Promise((r) => setTimeout(r, 100));
    v.dispatch({ changes: { from: 13, insert: 'b' } });
    expect(v.state.doc.toString()).toContain('local ba = 1');
    expect(v.dom.textContent).toContain('local ba = 1');
    expect(colorOf(v, 'local')).toBeNull();
    expect(errors).not.toHaveBeenCalled();
  });

  it('keeps the default look of the code (monospace, 0.92em, the code color) on the characters that have no color class, once the language is loaded', async () => {
    // 言語が分かると、構文木が CodeText を置き換え、tag のない文字は monospace の tag を受け継がない。mark と行の class が、それを補う。
    // このファイルの、ほかのテストが読み込んでいない言語（rust）で、読み込みの前と後を比べる。
    const v = mount('```rust\nlet answer = 42;\n```\n\n```text\nconst keyword = 1;\n```\n');
    const textNodeOf = (needle: string): Text => {
      const walker = document.createTreeWalker(v.contentDOM, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) if (n.textContent?.includes(needle)) return n as Text;
      throw new Error(`no text: ${needle}`);
    };
    const marks = (node: Node) => {
      const found: Element[] = [];
      for (let e = node.parentElement; e && e !== v.contentDOM; e = e.parentElement) if (e.classList.contains('cm-md-code-text')) found.push(e);
      return found;
    };
    const lineOf = (node: Node) => node.parentElement!.closest('.cm-line')!;
    // 読み込みの前は、構文解析が飛ばされた範囲（名前のない節）に置き換わる。大きさが二重にならないことは e2e が確かめる。
    expect(marks(textNodeOf('answer')).length).toBeLessThanOrEqual(1);
    await resolveCodeLanguage('rust')!.load();
    await waitFor(() => (colorOf(v, 'let') ?? []).includes('--md-code-keyword'));
    // 色の付かない文字（変数名）: 等幅と 0.92em の mark が 1 つだけ（二重に掛けない）。行は中身の行の class を持つ（コードの色）。
    const answer = textNodeOf('answer');
    expect(marks(answer)).toHaveLength(1);
    expect(lineOf(answer).classList.contains('cm-md-fence-code')).toBe(true);
    // 色の付く文字（キーワード）も、同じ 1 つの mark の中。
    const keyword = [...v.dom.querySelectorAll('.cm-content span')].find((e) => e.children.length === 0 && e.textContent === 'let')!;
    expect(marks(keyword)).toHaveLength(1);
    // フェンスの行には、中身の行の class も mark も付かない。
    const fenceLines = [...v.dom.querySelectorAll('.cm-line.cm-md-fence-start, .cm-line.cm-md-fence-end')];
    expect(fenceLines.length).toBe(4);
    for (const line of fenceLines) {
      expect(line.classList.contains('cm-md-fence-code')).toBe(false);
      expect(line.querySelector('.cm-md-code-text')).toBeNull();
    }
    // text のブロック（言語なし）は、これまでどおり。mark は付かず、monospace の tag の span が効く。
    const plain = textNodeOf('keyword =');
    expect(marks(plain)).toHaveLength(0);
    expect(lineOf(plain).classList.contains('cm-md-fence-code')).toBe(true);
    expect(styleText()).toContain('font-size: 0.92em');
  });

  it('leaves the colors of Markdown itself alone (inline code and the fence marks keep their style)', () => {
    const v = mount('a `code` b\n\n```\nplain\n```\n');
    const code = Array.from(v.dom.querySelectorAll('span')).find((s) => s.textContent === 'code');
    expect(code).toBeDefined();
    expect(codeColors(code!)).toEqual([]);
  });
});
