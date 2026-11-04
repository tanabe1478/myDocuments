import { markdownLanguage } from '@codemirror/lang-markdown';
import { Text } from '@codemirror/state';
import { describe, expect, it } from 'vitest';
import {
  MARKER_WIDGET_EM,
  activeLines,
  collectMarkup,
  hangPieces,
  isActiveLine,
  linkAt,
  sameActiveLines,
  type MarkupSpan,
} from './liveMarkup';

function parse(source: string) {
  const doc = Text.of(source.split('\n'));
  const tree = markdownLanguage.parser.parse(source);
  const markup = collectMarkup(tree, doc, 0, doc.length);
  return { doc, source, ...markup };
}

/** 隠す範囲を "kind:文字" の並びにする（読みやすさのため）。 */
function describeSpans(source: string): string[] {
  const { spans, source: text } = parse(source);
  return spans.map((s) => `${s.kind}:${text.slice(s.from, s.to)}`);
}

describe('collectMarkup: 見出し', () => {
  it('ATX 見出しの行頭の # と直後の空白を隠す', () => {
    expect(describeSpans('# 見出し')).toEqual(['hide:# ']);
    expect(describeSpans('### 三段')).toEqual(['hide:### ']);
    expect(describeSpans('###### 六段')).toEqual(['hide:###### ']);
  });

  it('閉じる # は隠さない', () => {
    expect(describeSpans('## 見出し ##')).toEqual(['hide:## ']);
  });

  it('Setext 見出しの下線は隠さない', () => {
    expect(describeSpans('見出し\n===')).toEqual([]);
    expect(describeSpans('見出し\n---')).toEqual([]);
  });

  it('見出しの中の強調やリンクも隠す', () => {
    expect(describeSpans('# **太字** と [a](http://x)')).toEqual(['hide:# ', 'hide:**', 'hide:**', 'hide:[', 'hide:](http://x)']);
  });

  it('# の後ろに空白がないものは見出しではない', () => {
    expect(describeSpans('#tag')).toEqual([]);
  });
});

describe('collectMarkup: リスト', () => {
  it('箇条書きの - * + を • に置き換える', () => {
    expect(describeSpans('- a\n* b\n+ c')).toEqual(['bullet:-', 'bullet:*', 'bullet:+']);
  });

  it('入れ子の箇条書きも置き換える', () => {
    const { spans, source } = parse('- a\n  - b\n    * c');
    expect(spans.map((s) => [s.kind, source.slice(s.from, s.to), s.line])).toEqual([
      ['bullet', '-', 1],
      ['bullet', '-', 2],
      ['bullet', '*', 3],
    ]);
  });

  it('番号付きリストはそのまま', () => {
    expect(describeSpans('1. a\n2) b\n10. c')).toEqual([]);
  });

  it('番号付きの中の箇条書きは置き換える', () => {
    expect(describeSpans('1. a\n   - b')).toEqual(['bullet:-']);
  });

  it('タスクは記号とチェックボックスをまとめて置き換える', () => {
    const { spans, source } = parse('- [ ] 未\n- [x] 済\n- [X] 済');
    expect(spans.map((s) => [s.kind, source.slice(s.from, s.to), s.done])).toEqual([
      ['task', '- [ ]', false],
      ['task', '- [x]', true],
      ['task', '- [X]', true],
    ]);
  });

  it('番号付きのタスクと、チェックボックスでない [ ] は置き換えない', () => {
    expect(describeSpans('1. [ ] a')).toEqual([]);
    expect(describeSpans('- [] a')).toEqual(['bullet:-']);
    expect(describeSpans('- a [ ] b')).toEqual(['bullet:-']);
  });

  it('リストでない行頭の - は対象外', () => {
    expect(describeSpans('-a')).toEqual([]);
    expect(describeSpans('---')).toEqual([]);
    expect(describeSpans('***')).toEqual([]);
  });
});

describe('collectMarkup: リンク', () => {
  it('インラインリンクの [ と ](URL "タイトル") を隠す', () => {
    expect(describeSpans('[文字](http://x.example "題")')).toEqual(['hide:[', 'hide:](http://x.example "題")']);
    expect(describeSpans('前 [文字](./a.md) 後')).toEqual(['hide:[', 'hide:](./a.md)']);
  });

  it('リンク先を < > で囲んだ書き方も隠す', () => {
    expect(describeSpans('[文字](<a b.md>)')).toEqual(['hide:[', 'hide:](<a b.md>)']);
  });

  it('自動リンクは < > を隠す', () => {
    expect(describeSpans('<https://e.example/a>')).toEqual(['hide:<', 'hide:>']);
  });

  it('GFM の裸の URL は、隠すものがない', () => {
    expect(describeSpans('https://e.example/a')).toEqual([]);
  });

  it('参照リンク・参照の定義行・画像は対象外', () => {
    expect(describeSpans('[文字][ref]')).toEqual([]);
    expect(describeSpans('[ref]: http://r.example "題"')).toEqual([]);
    expect(describeSpans('[文字]')).toEqual([]);
    expect(describeSpans('![代替](a.png "題")')).toEqual([]);
    expect(describeSpans('![*代替*](a.png)')).toEqual([]);
  });

  it('画像をリンクで包んだ書き方は、リンクの記号だけ隠す', () => {
    expect(describeSpans('[![代替](a.png)](http://x.example)')).toEqual(['hide:[', 'hide:](http://x.example)']);
  });

  it('リンクの文字の中の強調も隠す', () => {
    expect(describeSpans('[**太**](http://x)')).toEqual(['hide:[', 'hide:**', 'hide:**', 'hide:](http://x)']);
  });
});

describe('collectMarkup: 強調・取り消し線・インラインコード', () => {
  it('強調の記号を隠す', () => {
    expect(describeSpans('**太** __太__ *斜* _斜_')).toEqual(['hide:**', 'hide:**', 'hide:__', 'hide:__', 'hide:*', 'hide:*', 'hide:_', 'hide:_']);
  });

  it('入れ子の強調（***）も隠す', () => {
    expect(describeSpans('***両方***').join(',')).toBe('hide:*,hide:**,hide:**,hide:*');
  });

  it('取り消し線を隠す', () => {
    expect(describeSpans('~~消~~')).toEqual(['hide:~~', 'hide:~~']);
  });

  it('インラインコードのバッククォートを隠す（中身は触らない）', () => {
    expect(describeSpans('`code` と ``a`b``')).toEqual(['hide:`', 'hide:`', 'hide:``', 'hide:``']);
    expect(describeSpans('`**x**`')).toEqual(['hide:`', 'hide:`']);
  });

  it('エスケープした記号は対象外', () => {
    expect(describeSpans('\\*not\\*')).toEqual([]);
    expect(describeSpans('\\# a')).toEqual([]);
    expect(describeSpans('a \\`b\\`')).toEqual([]);
  });

  it('対にならない記号は対象外', () => {
    expect(describeSpans('2 * 3 * 4')).toEqual([]);
    expect(describeSpans('snake_case_name')).toEqual([]);
  });
});

describe('collectMarkup: 引用', () => {
  it('引用の > と直後の空白 1 つを隠す', () => {
    expect(describeSpans('> 引用')).toEqual(['hide:> ']);
    expect(describeSpans('>引用')).toEqual(['hide:>']);
    expect(describeSpans('>   引用')).toEqual(['hide:> ']);
  });

  it('入れ子の引用の > を、それぞれ隠す', () => {
    expect(describeSpans('> > 二段\n> > > 三段')).toEqual(['hide:> ', 'hide:> ', 'hide:> ', 'hide:> ', 'hide:> ']);
  });

  it('続く行の > も隠す', () => {
    const { spans } = parse('> 一\n> 二\n\n> 三');
    expect(spans.map((s) => s.line)).toEqual([1, 2, 4]);
  });

  it('引用の中のリストは、引用の記号と箇条書きの記号を別々に扱う', () => {
    expect(describeSpans('> - a\n>   - b')).toEqual(['hide:> ', 'bullet:-', 'hide:> ', 'bullet:-']);
  });
});

describe('collectMarkup: 対象外のブロック', () => {
  it('コードフェンスの中（フェンス行を含む）は何も隠さない', () => {
    expect(describeSpans('```js\n# not heading\n- not list\n**x** [a](b) `c` > q\n```')).toEqual([]);
    expect(describeSpans('~~~\n# x\n~~~')).toEqual([]);
  });

  it('閉じていないフェンスは、文書の終わりまで対象外', () => {
    expect(describeSpans('```\n# x\n- y')).toEqual([]);
  });

  it('フェンスの前後の行は、これまでどおり隠す', () => {
    expect(describeSpans('# a\n```\n# b\n```\n# c')).toEqual(['hide:# ', 'hide:# ']);
    const { spans } = parse('# a\n```\n# b\n```\n# c');
    expect(spans.map((s) => s.line)).toEqual([1, 5]);
  });

  it('リストの項目の中のフェンスも対象外', () => {
    expect(describeSpans('- a\n  ```\n  # x\n  **y**\n  ```\n- b')).toEqual(['bullet:-', 'bullet:-']);
  });

  it('引用の中のフェンス（フェンス行を含む）は、引用の記号も含めて対象外', () => {
    expect(describeSpans('> ```\n> # x\n> ```\n> 後')).toEqual(['hide:> ']);
  });

  it('インデントコードは対象外', () => {
    expect(describeSpans('段落\n\n    # code\n    - x\n    **y**')).toEqual([]);
  });

  it('HTML ブロックは対象外', () => {
    expect(describeSpans('<div>\n**x** [a](b)\n</div>')).toEqual([]);
    expect(describeSpans('<!-- **x** -->')).toEqual([]);
  });

  it('frontmatter は対象外（閉じる --- まで）', () => {
    const source = '---\ntitle: **x**\ntags:\n  - a\n# comment\n---\n# 見出し\n- b';
    const { spans, source: text } = parse(source);
    expect(spans.map((s) => [s.kind, text.slice(s.from, s.to), s.line])).toEqual([
      ['hide', '# ', 7],
      ['bullet', '-', 8],
    ]);
  });

  it('閉じる --- のない先頭の --- は frontmatter ではない', () => {
    expect(describeSpans('---\n# a')).toEqual(['hide:# ']);
  });

  it('先頭以外の --- は frontmatter ではない', () => {
    expect(describeSpans('本文\n---\n- a\n---')).toEqual(['bullet:-']);
  });
});

describe('collectMarkup: 範囲と行の分割', () => {
  it('範囲を指定すると、その範囲に触れる記号だけを返す', () => {
    const source = '# a\n\n**b**\n\n- c';
    const doc = Text.of(source.split('\n'));
    const tree = markdownLanguage.parser.parse(source);
    const { spans } = collectMarkup(tree, doc, doc.line(3).from, doc.line(3).to);
    expect(spans.map((s) => s.line)).toEqual([3, 3]);
  });

  it('範囲は 1 行の中に収める（行をまたぐ記号は、行ごとに分ける）', () => {
    const source = '[文字](http://x.example "題\nつづき")';
    const { spans } = parse(source);
    for (const s of spans) expect(source.slice(s.from, s.to)).not.toContain('\n');
    expect(spans.map((s) => s.line)).toEqual([1, 1, 2]);
  });

  it('範囲は重ならず、昇順', () => {
    const { spans } = parse('> - **a** [b](c) `d` ~~e~~\n> 1. [x](y)');
    for (let i = 1; i < spans.length; i++) expect(spans[i]!.from).toBeGreaterThanOrEqual(spans[i - 1]!.to);
  });

  it('本文を変えない（返すのは範囲だけ）', () => {
    const source = '# a\n- **b** [c](d)';
    const doc = Text.of(source.split('\n'));
    const before = doc.toString();
    collectMarkup(markdownLanguage.parser.parse(source), doc, 0, doc.length);
    expect(doc.toString()).toBe(before);
  });
});

describe('collectMarkup: リンクの範囲', () => {
  it('インラインリンク・自動リンク・裸の URL の範囲と URL を返す', () => {
    const { links, source } = parse('[a](http://x.example "t") <https://y.example> https://z.example/p');
    expect(links.map((l) => [source.slice(l.from, l.to), l.url])).toEqual([
      ['[a](http://x.example "t")', 'http://x.example'],
      ['<https://y.example>', 'https://y.example'],
      ['https://z.example/p', 'https://z.example/p'],
    ]);
  });

  it('相対パスや javascript: も、リンクとして返す（開けるかは呼び出し側が決める）', () => {
    const { links } = parse('[a](./b.md) [c](#d) [e](javascript:alert(1)) [f]()');
    expect(links.map((l) => l.url)).toEqual(['./b.md', '#d', 'javascript:alert(1)', '']);
  });

  it('< > で囲んだリンク先は中身を返す', () => {
    expect(parse('[a](<http://x.example/a b>)').links.map((l) => l.url)).toEqual(['http://x.example/a b']);
  });

  it('参照リンク・画像・定義行・コードの中・frontmatter の中はリンクにしない', () => {
    expect(parse('[a][r]\n\n![i](http://x.example/a.png)\n\n[r]: http://r.example').links).toEqual([]);
    expect(parse('`http://x.example` と [a](b)').links.map((l) => l.url)).toEqual(['b']);
    expect(parse('```\nhttp://x.example\n```').links).toEqual([]);
    expect(parse('---\nurl: http://x.example\n---\n').links).toEqual([]);
  });

  it('linkAt は、位置にあるリンクを返す（端を含む）', () => {
    const { links } = parse('ab [cd](http://x.example) ef');
    expect(linkAt(links, 4)?.url).toBe('http://x.example');
    expect(linkAt(links, 3)?.url).toBe('http://x.example');
    expect(linkAt(links, 25)?.url).toBe('http://x.example');
    expect(linkAt(links, 1)).toBeNull();
    expect(linkAt(links, 27)).toBeNull();
  });
});

describe('カーソルのある行', () => {
  const doc = Text.of(['a', 'b', 'c', 'd', 'e', 'f']);

  it('カーソルのある行だけが、記法を見せる行になる', () => {
    const a = activeLines(doc, [{ from: 2, to: 2 }]);
    expect(a).toEqual([[2, 2]]);
    expect(isActiveLine(a, 2)).toBe(true);
    expect(isActiveLine(a, 1)).toBe(false);
    expect(isActiveLine(a, 3)).toBe(false);
  });

  it('選択にかかるすべての行が対象になる', () => {
    const a = activeLines(doc, [{ from: 1, to: 6 }]); // 行 1 の途中から行 4 の途中
    expect(a).toEqual([[1, 4]]);
    for (const n of [1, 2, 3, 4]) expect(isActiveLine(a, n)).toBe(true);
    expect(isActiveLine(a, 5)).toBe(false);
  });

  it('選択が次の行の頭で終わるときも、その行を含む', () => {
    // doc.line(2).from = 2
    expect(activeLines(doc, [{ from: 0, to: 2 }])).toEqual([[1, 2]]);
  });

  it('複数のカーソルは、それぞれの行（隣り合う行はまとめる）', () => {
    expect(activeLines(doc, [{ from: 0, to: 0 }, { from: 8, to: 8 }])).toEqual([[1, 1], [5, 5]]);
    expect(activeLines(doc, [{ from: 8, to: 8 }, { from: 0, to: 0 }, { from: 2, to: 2 }])).toEqual([[1, 2], [5, 5]]);
  });

  it('同じ行かどうかを比べられる', () => {
    expect(sameActiveLines([[1, 2]], [[1, 2]])).toBe(true);
    expect(sameActiveLines([[1, 2]], [[1, 3]])).toBe(false);
    expect(sameActiveLines([[1, 2]], [[1, 2], [4, 4]])).toBe(false);
  });
});

describe('hangPieces（隠した行のぶら下げの幅）', () => {
  function pieces(line: string) {
    const { doc, spans } = parse(line);
    return hangPieces(line, 0, spans.filter((s) => s.line === 1 && doc.length >= 0));
  }

  it('箇条書き: • の箱と、後ろの空白', () => {
    expect(pieces('- 項目')).toEqual({ texts: [' '], widgets: 1 });
  });

  it('入れ子: 字下げと • の箱と空白', () => {
    expect(pieces('  - 項目')).toEqual({ texts: ['  ', ' '], widgets: 1 });
  });

  it('タスク: チェックボックスの箱と、後ろの空白', () => {
    expect(pieces('- [ ] 項目')).toEqual({ texts: [' '], widgets: 1 });
    expect(pieces('- [x] 項目')).toEqual({ texts: [' '], widgets: 1 });
  });

  it('番号付き: 記号はそのまま文字として測る', () => {
    expect(pieces('1. 項目')).toEqual({ texts: ['1. '], widgets: 0 });
  });

  it('引用だけ: 記号を隠すので幅は 0', () => {
    expect(pieces('> 引用')).toEqual({ texts: [], widgets: 0 });
    expect(pieces('> > 二段')).toEqual({ texts: [], widgets: 0 });
  });

  it('引用の中の箇条書き', () => {
    expect(pieces('> - 項目')).toEqual({ texts: [' '], widgets: 1 });
    expect(pieces('>   - 入れ子')).toEqual({ texts: ['  ', ' '], widgets: 1 });
  });

  it('カーソルのある行（隠す範囲がない）は、記号がすべて見える', () => {
    expect(hangPieces('- 項目', 0, [])).toEqual({ texts: ['- '], widgets: 0 });
    expect(hangPieces('> - 項目', 0, [])).toEqual({ texts: ['> - '], widgets: 0 });
  });

  it('行の途中の範囲（リンクなど）は、ぶら下げの幅に入れない', () => {
    const spans: MarkupSpan[] = [{ kind: 'hide', from: 4, to: 5, line: 1 }];
    expect(hangPieces('- a [b](c)', 0, spans)).toEqual({ texts: ['- '], widgets: 0 });
  });

  it('箱の幅は固定', () => {
    expect(MARKER_WIDGET_EM).toBe(1);
  });
});
