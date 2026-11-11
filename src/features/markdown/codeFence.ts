/**
 * コードブロック（フェンス付き）の入力の支援（ADR-004 追補（コードブロック））。キーを押したときだけ本文を変える。
 * - 開きのフェンスの行の末尾での Enter: 閉じのフェンスがなければ、空の行と閉じのフェンスを足して、カーソルを空の行に置く。
 * - 閉じのフェンスの行の末尾での Enter: 直後に、余った閉じのフェンス（新しい開きのフェンスになってしまった行。判定は planDedupe）があれば取り除く（重複の防止）。
 * - ⌘/Ctrl+Enter: コードブロックの中から、閉じのフェンスの次の行へ出る（閉じがなければ足す。次の行がなければ足す）。
 *
 * 計画（何をどこに足し、カーソルをどこに置くか）は state だけから求める純関数。キーへの割り当てと IME の守りは codeFenceKeys.ts。
 * 閉じのフェンスがあるかは、構文木の FencedCode が閉じの CodeMark を持つかで決める（文字列の見た目では決めない）。
 * どれも 1 つの transaction（userEvent は input）で、1 回の Undo で押す前の文書と選択に戻る。
 */
import { ensureSyntaxTree } from '@codemirror/language';
import { EditorSelection, type EditorState, type Line, type TransactionSpec } from '@codemirror/state';
import type { SyntaxNode } from './tableModel';

/** 構文解析を、文書の最後まで済ませるために待つ上限（ミリ秒）。済まなければ、何もしない（普通の改行になる）。 */
const PARSE_BUDGET_MS = 25;

/** コードブロックの入れ物として許す節。これ以外の中のコードブロック（HTML ブロックなど）には、何も足さない。 */
const CONTAINERS = new Set(['Document', 'Blockquote', 'ListItem', 'BulletList', 'OrderedList']);

/** 構文木から読んだ、フェンス付きコードブロック 1 つ。 */
export interface FencedBlock {
  readonly node: SyntaxNode;
  /** 開きのフェンスの行。 */
  readonly openLine: Line;
  /** フェンスの記号（` か ~）と長さ。 */
  readonly char: '`' | '~';
  readonly length: number;
  /** 開きのフェンスの CodeMark の位置。 */
  readonly markFrom: number;
  readonly markTo: number;
  /** 閉じのフェンスの CodeMark。閉じがなければ null。 */
  readonly close: { readonly from: number; readonly to: number } | null;
  /** 閉じのフェンスの行。閉じがなければ null。 */
  readonly closeLine: Line | null;
  /** 情報文字列（CodeInfo）の位置。なければ null。 */
  readonly info: { readonly from: number; readonly to: number } | null;
}

/**
 * 構文木を、文書の最後まで読み終えたものにして返す。時間内に済まなければ null
 * （途中までの木では、閉じのフェンスがあるかを決められない）。
 */
function completeTree(state: EditorState) {
  const tree = ensureSyntaxTree(state, state.doc.length, PARSE_BUDGET_MS);
  return tree && tree.length >= state.doc.length ? tree : null;
}

function fencedBlockOf(state: EditorState, node: SyntaxNode): FencedBlock | null {
  const { doc } = state;
  const marks: SyntaxNode[] = [];
  let info: SyntaxNode | null = null;
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (child.name === 'CodeMark') marks.push(child);
    else if (child.name === 'CodeInfo' && info === null) info = child;
  }
  const open = marks[0];
  if (!open) return null;
  const fence = doc.sliceString(open.from, open.to);
  const char = fence[0];
  if (char !== '`' && char !== '~') return null;
  const close = marks.length >= 2 ? marks[marks.length - 1]! : null;
  return {
    node,
    openLine: doc.lineAt(open.from),
    char,
    length: fence.length,
    markFrom: open.from,
    markTo: open.to,
    close: close ? { from: close.from, to: close.to } : null,
    closeLine: close ? doc.lineAt(close.from) : null,
    info: info ? { from: info.from, to: info.to } : null,
  };
}

/** 位置 pos を含むフェンス付きコードブロック（なければ null）。構文木が文書の最後まで済んでいないときも null。 */
export function fencedBlockAt(state: EditorState, pos: number): FencedBlock | null {
  const tree = completeTree(state);
  if (!tree) return null;
  for (const side of [-1, 1] as const) {
    for (let node: SyntaxNode | null = tree.resolve(pos, side); node; node = node.parent) {
      if (node.name === 'FencedCode') {
        const block = fencedBlockOf(state, node);
        if (block && node.from <= pos && pos <= Math.max(node.to, block.openLine.to)) return block;
        return null;
      }
    }
  }
  return null;
}

/**
 * 継続する行（足す空の行と閉じのフェンス）の行頭に付ける文字。before は、開きのフェンスの行の、フェンスより前の文字。
 * 引用の `>` はそのまま、リストの記号（`- `、`1. `）は同じ幅の空白にする。付けられない形（タブ、見慣れない記号）は null。
 */
export function continuationPrefix(before: string): string | null {
  if (before.includes('\t')) return null;
  let rest = before;
  let out = '';
  while (rest !== '') {
    let m: RegExpExecArray | null;
    if ((m = /^\s*>[ ]?/.exec(rest))) {
      out += m[0];
    } else if ((m = /^\s*(?:[-+*]|\d{1,9}[.)])\s+/.exec(rest))) {
      out += ' '.repeat(m[0].length);
    } else if (/^\s+$/.test(rest)) {
      out += rest;
      break;
    } else {
      return null;
    }
    rest = rest.slice(m[0].length);
  }
  return out;
}

/** コードブロックの入れ物が、引用とリストだけか。 */
function inSupportedContainers(node: SyntaxNode): boolean {
  for (let p = node.parent; p; p = p.parent) if (!CONTAINERS.has(p.name)) return false;
  return true;
}

/** ブロックの継続の行頭の文字。付けられなければ null。 */
function prefixOf(state: EditorState, block: FencedBlock): string | null {
  if (!inSupportedContainers(block.node)) return null;
  return continuationPrefix(state.sliceDoc(block.openLine.from, block.markFrom));
}

export interface FencePlan {
  readonly spec: TransactionSpec;
}

function cursorSpec(changes: TransactionSpec['changes'], cursor: number): TransactionSpec {
  return { changes, selection: EditorSelection.cursor(cursor), scrollIntoView: true, userEvent: 'input' };
}

/** 選択が 1 つで空のときの、カーソルの位置。そうでなければ null（普通のキーに回す）。 */
function plainCursor(state: EditorState): number | null {
  const { main, ranges } = state.selection;
  return ranges.length === 1 && main.empty && !state.readOnly ? main.head : null;
}

/** 閉じのフェンスの文字列（開きと同じ記号、同じ長さ）。 */
function closingFence(block: FencedBlock): string {
  return block.char.repeat(block.length);
}

/**
 * 開きのフェンスの行の末尾での Enter の計画。閉じがない開きのフェンスの行の末尾にカーソルがあるときだけ
 * 「改行、空の行、閉じのフェンス」を足し、カーソルを空の行に置く。対象でなければ null。
 */
function planCloseFence(state: EditorState, head: number): FencePlan | null {
  const line = state.doc.lineAt(head);
  if (head !== line.to) return null;
  const block = fencedBlockAt(state, head);
  if (!block || block.close || block.openLine.number !== line.number) return null;
  const prefix = prefixOf(state, block);
  if (prefix === null) return null;
  const lb = state.lineBreak;
  const insert = `${lb}${prefix}${lb}${prefix}${closingFence(block)}`;
  return { spec: cursorSpec({ from: head, insert }, head + lb.length + prefix.length) };
}

/** 構文木の位置 pos より後ろに、閉じのないフェンス付きコードブロックがあるか（フェンスの数の偶奇がずれている印）。 */
function hasUnclosedFenceAfter(state: EditorState, node: SyntaxNode): boolean {
  const tree = ensureSyntaxTree(state, state.doc.length, PARSE_BUDGET_MS);
  if (!tree) return false;
  let found = false;
  tree.iterate({
    from: node.to,
    enter(n) {
      if (found) return false;
      if (n.name !== 'FencedCode') return;
      if (n.from <= node.from) return;
      let marks = 0;
      for (let c = n.node.firstChild; c; c = c.nextSibling) if (c.name === 'CodeMark') marks++;
      if (marks < 2) found = true;
      return false;
    },
  });
  return found;
}

/** 行の、引用の記号を除いた先頭が、同じ記号のフェンスか。 */
const fenceLike = (char: string) => new RegExp(`^[\\s>]*${char === '`' ? '`' : '~'}{3,}`);

/**
 * 閉じのフェンスの行の末尾での Enter の計画（重複の防止）。いま閉じたコードブロックの次の行が、情報文字列のない同じ記号のフェンスで、
 * 次のどれかに当てはまるとき、その行は、閉じのフェンスをもう 1 つ打ったために開きのフェンスになった、元の閉じのフェンスとみなす。
 * (a) その開きのフェンスにも閉じがない。(b) そのコードブロックの中に、フェンスの行が巻き込まれている（後ろのコードブロックの開きのフェンス）。
 * (c) そのコードブロックの後ろに、閉じのないコードブロックがある（フェンスの数の偶奇がずれている）。
 * きちんと閉じた、隣り合う 2 つのコードブロックは、どれにも当てはまらない（そのままにする）。
 * 余った行の文字を取り除き、その場所を空の行にして、カーソルを置く（いまの行が閉じとなり、新しい行がコードブロックの後ろに続く）。
 * 対象でなければ null。
 */
function planDedupe(state: EditorState, head: number): FencePlan | null {
  const { doc } = state;
  const line = doc.lineAt(head);
  if (head !== line.to || line.number >= doc.lines) return null;
  const block = fencedBlockAt(state, head);
  if (!block?.close || !block.closeLine || block.closeLine.number !== line.number) return null;
  if (state.sliceDoc(block.close.to, line.to).trim() !== '') return null;
  const prefix = prefixOf(state, block);
  if (prefix === null) return null;
  const next = doc.line(line.number + 1);
  const stray = fencedBlockAt(state, next.to);
  if (!stray || stray.openLine.number !== next.number || stray.info) return null;
  // 同じ入れ物（引用とリストの記号が同じ）で、記号も同じ、行にはフェンスしかないこと。
  if (stray.char !== block.char) return null;
  if (state.sliceDoc(next.from, stray.markFrom) !== state.sliceDoc(line.from, block.close.from)) return null;
  if (state.sliceDoc(stray.markTo, next.to).trim() !== '') return null;
  if (stray.close && stray.closeLine) {
    const swallowed = (() => {
      const pattern = fenceLike(stray.char);
      for (let n = next.number + 1; n < stray.closeLine.number; n++) if (pattern.test(doc.line(n).text)) return true;
      return false;
    })();
    if (!swallowed && !hasUnclosedFenceAfter(state, stray.node)) return null;
  }
  const lb = state.lineBreak;
  const insert = `${lb}${prefix}`;
  return { spec: cursorSpec({ from: line.to, to: next.to, insert }, line.to + insert.length) };
}

/** Enter の計画。対象でなければ null（普通の Enter に回す）。 */
export function planFenceEnter(state: EditorState): FencePlan | null {
  const head = plainCursor(state);
  if (head === null) return null;
  return planCloseFence(state, head) ?? planDedupe(state, head);
}

/**
 * ⌘/Ctrl+Enter の計画。カーソルがコードブロックの中（フェンスの行を含む）にあるとき、閉じのフェンスの次の行へ移す。
 * 閉じがなければ、コードブロックの最後の行の後ろに閉じのフェンスを足す。次の行がなければ空の行を足す。
 * コードブロックの外、付けられない形（入れ物が引用とリスト以外）では null（今のまま）。
 */
export function planFenceExit(state: EditorState): FencePlan | null {
  const head = plainCursor(state);
  if (head === null) return null;
  const { doc } = state;
  const block = fencedBlockAt(state, head);
  if (!block) return null;
  const prefix = prefixOf(state, block);
  if (prefix === null) return null;
  const lb = state.lineBreak;
  // コードブロックの最後の行。閉じがなければ、構文木の終わり（末尾の改行を含むことがある）の行。
  let last: Line;
  if (block.closeLine) {
    last = block.closeLine;
  } else {
    const end = block.node.to > block.node.from && doc.sliceString(block.node.to - 1, block.node.to) === '\n' ? block.node.to - 1 : block.node.to;
    last = doc.lineAt(Math.max(end, block.openLine.to));
  }
  const addFence = block.closeLine ? '' : `${lb}${prefix}${closingFence(block)}`;
  if (last.number < doc.lines) {
    const next = doc.line(last.number + 1);
    const at = next.text.startsWith(prefix) ? next.from + prefix.length : next.from;
    if (addFence === '') return { spec: { selection: EditorSelection.cursor(at), scrollIntoView: true, userEvent: 'select' } };
    // 閉じのフェンスを足すと、次の行は 1 行下がる。
    return { spec: cursorSpec({ from: last.to, insert: addFence }, at + addFence.length) };
  }
  const insert = `${addFence}${lb}${prefix}`;
  return { spec: cursorSpec({ from: last.to, insert }, last.to + insert.length) };
}

/**
 * 位置 pos が、開きのフェンスの行の情報文字列の、言語の部分（最初の語の、`:` の前まで）にあるとき、その範囲を返す。
 * 言語名の補完（codeCompletion.ts）が使う。閉じのフェンスの行、コードの中、情報文字列の 2 語目以降、`:` の後ろ（ファイル名）では null。
 */
export function languageRangeAt(state: EditorState, pos: number): { from: number; to: number } | null {
  const line = state.doc.lineAt(pos);
  // 速い見切り: フェンスの記号がない行では、構文木を読まない。
  if (!/`{3,}|~{3,}/.test(line.text)) return null;
  const block = fencedBlockAt(state, pos);
  if (!block || block.openLine.number !== line.number || pos < block.markTo) return null;
  const text = state.sliceDoc(block.markTo, line.to);
  const start = block.markTo + text.length - text.trimStart().length;
  const word = /\S*/.exec(text.trimStart())![0];
  const colon = word.indexOf(':');
  const to = start + (colon < 0 ? word.length : colon);
  return pos >= start && pos <= to ? { from: start, to } : null;
}
