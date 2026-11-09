/**
 * 記法の表示（ADR-004）。カーソルのない行で隠す記号を決める純関数。CodeMirror の EditorView には依存しない
 * （構文木と文書のテキストだけを読む）。装飾の付け方は markdownDecorations.ts。
 *
 * 隠す・置き換える対象（Markdown だけ。.txt には使わない）:
 * - 見出し（ATX）: 行頭の # と直後の空白。閉じる # と、Setext 見出しの下線（=== / ---）は隠さない
 * - 箇条書き（- * +）: 記号を • に置き換える。番号付き（1. 1)）はそのまま
 * - タスク（- [ ] / - [x]）: 記号とチェックボックスを、チェックボックスの形に置き換える（箇条書きのときだけ）
 * - リンク: [ と ](URL "タイトル") を隠す（文字だけ残す）。自動リンク <https://...> は < > を隠す
 * - 強調・取り消し線: ** __ * _ ~~
 * - インラインコード: バッククォート
 * - 引用: 行頭の > と、直後の空白 1 つ（入れ子の > > も）
 * 対象外（今のまま）: コードフェンス（フェンス行を含む）、インデントコード、HTML ブロック、frontmatter、
 * 参照リンク [文字][ref] と参照の定義行、画像 ![alt](src)、エスケープ \*、GFM の裸の URL（もともと記号がない）。
 *
 * 本文は変えない。ここが返すのは「表示で隠す範囲」だけで、保存されるテキストにも、コピーされる文字列にも影響しない。
 */
import type { Text } from '@codemirror/state';
import type { syntaxTree } from '@codemirror/language';
import { frontmatterEndLine } from '../../plugin-api';
import { hangPrefix } from './lineKinds';

type Tree = ReturnType<typeof syntaxTree>;

/**
 * hide: 範囲を隠す。bullet: 範囲（- * + の 1 文字）を • に置き換える。
 * task: 範囲（記号とチェックボックス。"- [ ]"）をチェックボックスの形に置き換える。
 * 範囲は 1 行の中に収まる（行をまたぐ範囲は、行ごとに分けてある）。
 */
export interface MarkupSpan {
  readonly kind: 'hide' | 'bullet' | 'task';
  readonly from: number;
  readonly to: number;
  /** 範囲のある行（1 始まり）。 */
  readonly line: number;
  /** task のとき、完了（[x]）か。 */
  readonly done?: boolean;
}

/** リンクの範囲（装飾の class と、⌘/Ctrl+クリックで開く URL に使う）。 */
export interface LinkRange {
  readonly from: number;
  readonly to: number;
  /** リンク先（書かれたとおり。<> で囲んだ書き方は中身）。インラインリンクで URL が空のときは空文字。 */
  readonly url: string;
}

export interface Markup {
  /** 隠す・置き換える範囲。from の昇順で、重ならない。 */
  readonly spans: MarkupSpan[];
  /** リンクの範囲。from の昇順で、入れ子にしない。 */
  readonly links: LinkRange[];
}

/** 中の記法を見ない（隠さず、リンクにもしない）ブロック。 */
const OPAQUE_BLOCKS = new Set(['FencedCode', 'CodeBlock', 'HTMLBlock', 'CommentBlock', 'ProcessingInstructionBlock']);
/** 中を見ない要素（画像と、参照の定義行。HTML のタグ）。 */
const OPAQUE_INLINES = new Set(['Image', 'LinkReference', 'HTMLTag', 'Comment', 'ProcessingInstruction']);

const ATX_HEADING = /^ATXHeading[1-6]$/;

/** 同じ文書の frontmatter の判定を使い回す（選択だけが変わる更新で、先頭から読み直さない）。 */
const frontmatterCache = new WeakMap<Text, number | null>();

export function frontmatterEnd(doc: Text): number | null {
  let end = frontmatterCache.get(doc);
  if (end === undefined) {
    end = frontmatterEndLine(doc.lines, (n) => doc.line(n).text);
    frontmatterCache.set(doc, end);
  }
  return end;
}

/**
 * [from, to] の範囲（文書上の位置）に触れる記法を集める。構文木は、その範囲まで解析済みのもの。
 * カーソルのある行かどうかは見ない（呼び出し側が、行ごとに選ぶ）。
 */
export function collectMarkup(tree: Tree, doc: Text, from: number, to: number): Markup {
  const spans: MarkupSpan[] = [];
  const links: LinkRange[] = [];
  /** 記法を見ない行の範囲（行番号。両端を含む）。 */
  const opaque: Array<[number, number]> = [];
  const fmEnd = frontmatterEnd(doc);
  if (fmEnd !== null) opaque.push([1, fmEnd]);

  const lineOf = (pos: number) => doc.lineAt(pos).number;

  /** 範囲を行ごとに分けて足す。 */
  const add = (kind: MarkupSpan['kind'], start: number, end: number, extra?: { done: boolean }) => {
    if (end <= start) return;
    const last = lineOf(end - 1);
    for (let n = lineOf(start); n <= last; n++) {
      const line = doc.line(n);
      const f = Math.max(start, line.from);
      const t = Math.min(end, line.to);
      if (t > f) spans.push({ kind, from: f, to: t, line: n, ...extra });
    }
  };

  /** 直後の空白（max 文字まで）を足した終端。 */
  const withTrailingBlanks = (pos: number, max: number): number => {
    const line = doc.lineAt(pos);
    let end = pos;
    while (end < line.to && end - pos < max && /[ \t]/.test(doc.sliceString(end, end + 1))) end++;
    return end;
  };

  tree.iterate({
    from,
    to,
    enter(ref) {
      const name = ref.name;
      if (OPAQUE_BLOCKS.has(name)) {
        opaque.push([lineOf(ref.from), lineOf(Math.max(ref.from, ref.to - 1))]);
        return false;
      }
      if (OPAQUE_INLINES.has(name)) return false;

      switch (name) {
        case 'HeaderMark': {
          const node = ref.node;
          const parent = node.parent;
          // 行頭の # だけ（閉じる # は parent の最初の子ではない。Setext の下線は ATX ではない）。
          if (parent && ATX_HEADING.test(parent.name) && node.prevSibling === null) {
            add('hide', ref.from, withTrailingBlanks(ref.to, Infinity));
          }
          return;
        }
        case 'ListMark': {
          const node = ref.node;
          const item = node.parent;
          if (item?.name !== 'ListItem' || item.parent?.name !== 'BulletList') return;
          const task = node.nextSibling;
          const marker = task?.name === 'Task' ? task.firstChild : null;
          if (marker?.name === 'TaskMarker') {
            add('task', ref.from, marker.to, { done: /[xX]/.test(doc.sliceString(marker.from, marker.to)) });
          } else {
            add('bullet', ref.from, ref.to);
          }
          return;
        }
        case 'QuoteMark':
          add('hide', ref.from, withTrailingBlanks(ref.to, 1));
          return;
        case 'Link': {
          const marks: Array<{ from: number; to: number }> = [];
          let url = '';
          for (let c = ref.node.firstChild; c; c = c.nextSibling) {
            if (c.name === 'LinkMark') marks.push({ from: c.from, to: c.to });
            else if (c.name === 'URL' && url === '') url = doc.sliceString(c.from, c.to);
          }
          // インラインリンク: [ ] ( ... )。参照リンク [文字][ref] と、[文字] だけのものは対象外。
          const [open, close, paren] = marks;
          const end = marks[marks.length - 1];
          if (
            marks.length < 4 ||
            !open ||
            !close ||
            !paren ||
            !end ||
            doc.sliceString(open.from, open.to) !== '[' ||
            doc.sliceString(close.from, close.to) !== ']' ||
            doc.sliceString(paren.from, paren.to) !== '(' ||
            doc.sliceString(end.from, end.to) !== ')'
          ) {
            return;
          }
          add('hide', open.from, open.to);
          add('hide', close.from, ref.to);
          links.push({ from: ref.from, to: ref.to, url: url.replace(/^<(.*)>$/s, '$1') });
          return;
        }
        case 'Autolink': {
          let url = '';
          for (let c = ref.node.firstChild; c; c = c.nextSibling) {
            if (c.name === 'LinkMark') add('hide', c.from, c.to);
            else if (c.name === 'URL') url = doc.sliceString(c.from, c.to);
          }
          links.push({ from: ref.from, to: ref.to, url });
          return false;
        }
        case 'URL': {
          // 親が Link・Image・Autolink・LinkReference の URL は、それぞれが扱う。ここに来るのは GFM の裸の URL。
          const parent = ref.node.parent?.name;
          if (parent !== 'Link' && parent !== 'Autolink' && parent !== 'Image' && parent !== 'LinkReference') {
            links.push({ from: ref.from, to: ref.to, url: doc.sliceString(ref.from, ref.to) });
          }
          return;
        }
        case 'EmphasisMark':
        case 'StrikethroughMark':
          add('hide', ref.from, ref.to);
          return;
        case 'CodeMark':
          if (ref.node.parent?.name === 'InlineCode') add('hide', ref.from, ref.to);
          return;
      }
    },
  });

  const inOpaque = (line: number) => opaque.some(([a, b]) => line >= a && line <= b);
  const keptSpans = spans.filter((s) => !inOpaque(s.line)).sort((a, b) => a.from - b.from || a.to - b.to);
  // 重なる範囲は捨てる（隠す範囲を重ねて置き換えない）。
  const result: MarkupSpan[] = [];
  for (const s of keptSpans) {
    if (result.length > 0 && s.from < result[result.length - 1]!.to) continue;
    result.push(s);
  }
  const keptLinks = links
    .filter((l) => !inOpaque(lineOf(l.from)))
    .sort((a, b) => a.from - b.from || b.to - a.to);
  const flatLinks: LinkRange[] = [];
  for (const l of keptLinks) {
    if (flatLinks.length > 0 && l.from < flatLinks[flatLinks.length - 1]!.to) continue;
    flatLinks.push(l);
  }
  return { spans: result, links: flatLinks };
}

/** 位置 pos にあるリンク（装飾の class のある要素の上で呼ぶ）。端（直前・直後）も含む。なければ null。 */
export function linkAt(links: readonly LinkRange[], pos: number): LinkRange | null {
  return (
    links.find((l) => pos > l.from && pos < l.to) ?? links.find((l) => pos >= l.from && pos <= l.to) ?? null
  );
}

// ---- カーソルのある行（記法を見せる行） ----

/** 行番号（1 始まり）の範囲 [first, last] の並び。from の昇順で、重ならない。 */
export type ActiveLines = ReadonlyArray<readonly [number, number]>;

/**
 * 記法を見せる行: 選択（複数カーソルならそれぞれ）の端と、選択にかかるすべての行。
 * 範囲選択が行の頭で終わっているときも、その行を含む（カーソルがその行にあるので）。
 */
export function activeLines(doc: Text, ranges: ReadonlyArray<{ from: number; to: number }>): ActiveLines {
  const intervals = ranges
    .map((r): [number, number] => [doc.lineAt(r.from).number, doc.lineAt(r.to).number])
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged: Array<[number, number]> = [];
  for (const [first, last] of intervals) {
    const prev = merged[merged.length - 1];
    if (prev && first <= prev[1] + 1) prev[1] = Math.max(prev[1], last);
    else merged.push([first, last]);
  }
  return merged;
}

export function isActiveLine(active: ActiveLines, line: number): boolean {
  return active.some(([first, last]) => line >= first && line <= last);
}

export function sameActiveLines(a: ActiveLines, b: ActiveLines): boolean {
  return a.length === b.length && a.every(([f, l], i) => f === b[i]![0] && l === b[i]![1]);
}

// ---- ぶら下げインデントの幅（隠した行） ----

/** 箇条書きの • とチェックボックスの幅（em）。文字でなく、固定の幅の箱で描くので、フォントによらない（theme.ts）。 */
export const MARKER_WIDGET_EM = 1;

/**
 * 隠した行の、ぶら下げインデントを揃える位置までの、実際に見える幅の部品。
 * 行頭の記号（hangPrefix）から、隠す範囲を除き、置き換えた • とチェックボックスの数を数える。
 * texts は、文字として見える部分（実際のフォントで測る）。widgets は、固定の幅（MARKER_WIDGET_EM）の箱の数。
 */
export function hangPieces(
  lineText: string,
  lineFrom: number,
  spans: readonly MarkupSpan[],
): { texts: string[]; widgets: number } {
  const prefix = hangPrefix(lineText);
  const texts: string[] = [];
  let widgets = 0;
  let pos = 0;
  const flush = (end: number) => {
    if (end > pos) texts.push(prefix.slice(pos, end));
  };
  for (const s of spans) {
    const from = s.from - lineFrom;
    const to = s.to - lineFrom;
    if (from >= prefix.length) break;
    flush(from);
    if (s.kind !== 'hide') widgets++;
    pos = Math.min(Math.max(pos, to), prefix.length);
  }
  flush(prefix.length);
  return { texts, widgets };
}
