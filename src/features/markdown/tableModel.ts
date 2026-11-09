/**
 * Markdown の表（GFM のパイプの表）の読み取り（ADR-006）。構文木と文書のテキストだけを読む純関数で、
 * CodeMirror の EditorView には依存しない。表示の組み立ては tableDisplay.ts、Tab の移動の使い方は tableKeys.ts。
 *
 * 構文木の形（@lezer/markdown の GFM で確かめたもの）:
 * - Table の子: TableHeader、TableDelimiter（区切りの行全体）、TableRow。
 * - 行（TableHeader、TableRow）の子: TableDelimiter（行の中の `|` 1 文字ずつ）と TableCell（中身のあるセルだけ。空のセルには出ない）。
 * - インラインコードの中の `|` もセルの区切りになる（GFM の仕様）。`\\|` は区切りにならない（Escape）。
 * セルの境界は、行の TableDelimiter の `|` の位置から求める（空のセルを数えるため）。
 *
 * 対象は、親が Document の表（トップレベルの表）だけ。引用やリストの中の表は、行の頭に `> ` や字下げが付くので扱わない。
 */
import type { syntaxTree } from '@codemirror/language';
import type { Text } from '@codemirror/state';
import { frontmatterEnd } from './liveMarkup';

type Tree = ReturnType<typeof syntaxTree>;
export type SyntaxNode = Tree['topNode'];

export type Align = 'left' | 'center' | 'right' | null;

export interface CellModel {
  /** セルの左端（左の `|` の次、`|` がなければ行頭）と右端（右の `|` の位置、なければ行末）。左端 ≤ 位置 ≤ 右端 が、そのセルの中。 */
  readonly left: number;
  readonly right: number;
  /** 前後の空白を除いた中身の範囲。空のセルでは from == to。 */
  readonly contentFrom: number;
  readonly contentTo: number;
  /** Tab / Shift+Tab で移る位置（中身の頭）。空のセルは、左の `|` の後ろに空白があればその 1 つ後ろ、なければ `|` の直後。 */
  readonly start: number;
  /** 中身の構文木（TableCell）。空のセルは null。 */
  readonly node: SyntaxNode | null;
}

export interface RowModel {
  /** 行の範囲（行頭から行末）。 */
  readonly from: number;
  readonly to: number;
  readonly cells: readonly CellModel[];
}

export interface TableModel {
  /** 表の範囲（最初の行の行頭から、最後の行の行末）。 */
  readonly from: number;
  readonly to: number;
  readonly header: RowModel;
  readonly body: readonly RowModel[];
  /** 見出しのセルの数だけ。区切りの行の `:` に従う。 */
  readonly aligns: readonly Align[];
}

/** トップレベルの表の候補。 */
export interface TableRef {
  readonly node: SyntaxNode;
  /** 表の範囲（最初の行の行頭から、最後の行の行末）。 */
  readonly from: number;
  readonly to: number;
  /** 行番号（1 始まり）。 */
  readonly firstLine: number;
  readonly lastLine: number;
}

const BLANK = /[ \t]/;

function refOf(node: SyntaxNode, doc: Text): TableRef {
  const first = doc.lineAt(node.from);
  const last = doc.lineAt(node.to);
  return { node, from: first.from, to: last.to, firstLine: first.number, lastLine: last.number };
}

/** 構文木の中の、表の探索に使う最小限の形（@lezer/common の Tree の children と positions）。 */
interface TreeLike {
  readonly type: { readonly isAnonymous: boolean; readonly name: string };
  readonly length: number;
  readonly children: ReadonlyArray<unknown>;
  readonly positions: ReadonlyArray<number>;
}

const isTreeLike = (x: unknown): x is TreeLike => typeof x === 'object' && x !== null && Array.isArray((x as TreeLike).children);

/**
 * 文書のトップレベルの表を、先頭から順に集める。frontmatter の中は除く。
 * 構文木が解析済みの範囲（tree.length）まで。表が解析済みの範囲の端に触れているもの（続きがあるかもしれない）は除く。
 *
 * 長い文書でも、1 文字の入力のたびに呼ばれる。ノードの参照を作らず、Document の子（名前のない、釣り合いを取るための入れ物を
 * 通り抜けたもの）の種類だけを、配列のまま読む。表が見つかったものだけ、ノードの参照を作る。
 */
export function topLevelTables(tree: Tree, doc: Text): TableRef[] {
  const fmEnd = frontmatterEnd(doc);
  const complete = tree.length >= doc.length;
  const found: TableRef[] = [];
  const positions: number[] = [];
  const walk = (node: TreeLike, base: number): void => {
    for (let i = 0; i < node.children.length; i++) {
      const child = node.children[i];
      if (!isTreeLike(child)) continue;
      const from = base + node.positions[i]!;
      if (child.type.isAnonymous) walk(child, from);
      else if (child.type.name === 'Table' && (complete || from + child.length < tree.length)) positions.push(from);
    }
  };
  walk(tree as unknown as TreeLike, 0);
  for (const from of positions) {
    const node = tree.topNode.childAfter(from);
    if (!node || node.name !== 'Table' || node.from !== from) continue;
    const table = refOf(node, doc);
    if (fmEnd === null || table.firstLine > fmEnd) found.push(table);
  }
  return found;
}

/** 位置 pos のある行にかかるトップレベルの表。なければ null。 */
export function tableAtPos(tree: Tree, doc: Text, pos: number): TableRef | null {
  const line = doc.lineAt(pos);
  const node = tree.topNode.childAfter(line.from);
  if (!node || node.name !== 'Table' || node.from > line.to) return null;
  const fmEnd = frontmatterEnd(doc);
  const table = refOf(node, doc);
  if (fmEnd !== null && table.firstLine <= fmEnd) return null;
  return table;
}

function buildRow(node: SyntaxNode, doc: Text): RowModel {
  const line = doc.lineAt(node.from);
  const pipes: number[] = [];
  const cellNodes: SyntaxNode[] = [];
  for (let c = node.firstChild; c; c = c.nextSibling) {
    if (c.name === 'TableDelimiter') pipes.push(c.from);
    else if (c.name === 'TableCell') cellNodes.push(c);
  }
  const indent = line.text.length - line.text.trimStart().length;
  const leading = pipes.length > 0 && pipes[0] === line.from + indent;

  // 左端と右端の組。外側の `|` を書かない行は、最初のセルを行頭から、最後のセルを行末まで数える。
  const edges: Array<[number, number]> = [];
  let left = leading ? pipes[0]! + 1 : line.from;
  for (const pipe of leading ? pipes.slice(1) : pipes) {
    edges.push([left, pipe]);
    left = pipe + 1;
  }
  if (/\S/.test(doc.sliceString(left, line.to))) edges.push([left, line.to]);

  const cells = edges.map(([l, r]): CellModel => {
    let from = l;
    while (from < r && BLANK.test(doc.sliceString(from, from + 1))) from++;
    let to = r;
    while (to > from && BLANK.test(doc.sliceString(to - 1, to))) to--;
    const cellNode = cellNodes.find((n) => n.from >= from && n.to <= to) ?? null;
    // 空のセル: 左の `|` の後ろに空白があればその 1 つ後ろ（次の `|` を越えない）、なければ `|` の直後。
    const start = from === to ? (l < r ? l + 1 : l) : from;
    return { left: l, right: r, contentFrom: from, contentTo: to, start, node: cellNode };
  });
  return { from: line.from, to: line.to, cells };
}

function parseAligns(text: string): Align[] {
  let body = text.trim();
  if (body.startsWith('|')) body = body.slice(1);
  if (body.endsWith('|')) body = body.slice(0, -1);
  return body.split('|').map((cell): Align => {
    const c = cell.trim();
    const l = c.startsWith(':');
    const r = c.endsWith(':');
    return l && r ? 'center' : r ? 'right' : l ? 'left' : null;
  });
}

/** 表のノード（Table）から、行とセルの範囲を作る。見出しの行がなければ null。 */
export function buildTableModel(table: TableRef, doc: Text): TableModel | null {
  let header: RowModel | null = null;
  let aligns: Align[] = [];
  const body: RowModel[] = [];
  for (let c = table.node.firstChild; c; c = c.nextSibling) {
    if (c.name === 'TableHeader') header = buildRow(c, doc);
    else if (c.name === 'TableDelimiter') aligns = parseAligns(doc.sliceString(c.from, c.to));
    else if (c.name === 'TableRow') body.push(buildRow(c, doc));
  }
  if (!header) return null;
  // 列の数は見出しのセルの数。
  return { from: table.from, to: table.to, header, body, aligns: header.cells.map((_, i) => aligns[i] ?? null) };
}

/**
 * Tab（backward が false）/ Shift+Tab で移る先の位置。動かない（最初のセルで Shift+Tab、最後のセルで Tab）ときは null。
 * セルは、見出しの行、本文の行の順（区切りの行は数えない）。カーソルがセルの中にあれば、その前後のセル。
 * セルの中にない（行頭の `|` の前、行末の `|` の後ろ、区切りの行）ときは、位置の後ろ（前）で最初（最後）のセルの中身の頭。
 */
export function tabTarget(model: TableModel, pos: number, backward: boolean): number | null {
  const cells = [model.header, ...model.body].flatMap((row) => row.cells);
  const current = cells.findIndex((c) => c.left <= pos && pos <= c.right);
  if (current >= 0) return cells[current + (backward ? -1 : 1)]?.start ?? null;
  if (backward) {
    for (let i = cells.length - 1; i >= 0; i--) if (cells[i]!.start < pos) return cells[i]!.start;
    return null;
  }
  return cells.find((c) => c.start > pos)?.start ?? null;
}
