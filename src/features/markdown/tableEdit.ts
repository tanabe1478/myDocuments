/**
 * 表の入力の支援（ADR-006 の R12）。キーを押したときだけ本文を変える。
 * - 表の行での Enter: 今の行の下（見出しの行と区切りの行では、区切りの行の下）に空の行を足す。最後の行が空の本文の行なら、
 *   その行を空の行にして表から出る。
 * - 見出しの行（`| A | B |`、まだ表でない）の末尾での Enter: 区切りの行と空の行を足して表にする。
 * - 最後のセルでの Tab: 表の最後に空の行を足す（tableKeys.ts の tableTab が呼ぶ）。
 *
 * 計画（何をどこに足し、カーソルをどこに置くか）は state だけから求める純関数。キーへの割り当てと IME の守りは tableKeys.ts。
 * どれも 1 つの transaction（userEvent は input）で、1 回の Undo で押す前の文書と選択に戻る。
 */
import { syntaxTree } from '@codemirror/language';
import { EditorSelection, type EditorState, type TransactionSpec } from '@codemirror/state';
import { frontmatterEnd } from './liveMarkup';
import { buildTableModel, tableAtPos, type SyntaxNode, type TableModel } from './tableModel';

/** 足す行の最初のセルの中身の位置（行頭からの距離）。`|` の直後の空白 1 つの後ろ（R11 の「中身の頭」の決まりと同じ）。 */
const FIRST_CELL_OFFSET = 2;

/** 空の本文の行。外側の `|` を付け、各セルは空白 2 つ（`|  |  |`）。cols は列の数（1 以上）。 */
export function emptyRowText(cols: number): string {
  return `|${'  |'.repeat(Math.max(1, cols))}`;
}

/** 区切りの行（`| --- | --- |`）。 */
export function separatorRowText(cols: number): string {
  return `|${' --- |'.repeat(Math.max(1, cols))}`;
}

/**
 * 見出しの行になりうる行のセルの数。前後の空白を除いて `|` で始まり `|` で終わり、セルが 1 つ以上なければ null。
 * 数え方は R11 の tableModel と同じ GFM の規則: `\|` は区切りにならない（インラインコードの中の `|` は区切りになる）。
 */
export function headerCellCount(text: string): number | null {
  const s = text.trim();
  const pipes: number[] = [];
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\') i++;
    else if (s[i] === '|') pipes.push(i);
  }
  if (pipes.length < 2 || pipes[0] !== 0 || pipes[pipes.length - 1] !== s.length - 1) return null;
  return pipes.length - 1;
}

/** 区切りの行（`|---|:-:|` や `--|--`）に見える行。`|` を 1 つ以上含む。 */
const DELIMITER_ROW = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;
export const isDelimiterRowText = (text: string): boolean => text.includes('|') && DELIMITER_ROW.test(text);

export interface EditPlan {
  readonly spec: TransactionSpec;
}

function insertion(state: EditorState, at: number, lines: readonly string[], cursorLine: number): TransactionSpec {
  const lb = state.lineBreak;
  const insert = lines.map((l) => lb + l).join('');
  // カーソルは、足した行のうち cursorLine 番目（0 始まり）の最初のセルの中身の位置。
  let pos = at;
  for (let i = 0; i <= cursorLine; i++) pos += lb.length + (i < cursorLine ? lines[i]!.length : FIRST_CELL_OFFSET);
  return { changes: { from: at, insert }, selection: EditorSelection.cursor(pos), scrollIntoView: true, userEvent: 'input' };
}

/** 表の最後に空の行を足す（最後のセルでの Tab、表の行での Enter が使う）。 */
export function appendRowSpec(state: EditorState, model: TableModel, at: number): TransactionSpec {
  return insertion(state, at, [emptyRowText(model.header.cells.length)], 0);
}

/** 最後のセル（最後の行の最後のセル。本文の行がなければ見出しの行）の中にカーソルがあるか。 */
export function inLastCell(model: TableModel, pos: number): boolean {
  const row = model.body[model.body.length - 1] ?? model.header;
  const cell = row.cells[row.cells.length - 1];
  return !!cell && cell.left <= pos && pos <= cell.right;
}

/** 表の行での Enter の計画。表の外なら null。 */
function planInTable(state: EditorState, head: number): EditPlan | null {
  const { doc } = state;
  const table = tableAtPos(syntaxTree(state), doc, head);
  const model = table ? buildTableModel(table, doc) : null;
  if (!table || !model) return null;
  const line = doc.lineAt(head);
  const headerLine = doc.lineAt(model.header.from).number;
  // 見出しの行と区切りの行では、区切りの行の下（本文の 1 行目）に足す。
  if (line.number <= headerLine + 1) return { spec: appendRowSpec(state, model, doc.line(headerLine + 1).to) };
  // 最後の行が、セルがすべて空の本文の行なら、その行を空の行にして表から出る。
  const last = model.body[model.body.length - 1];
  if (last && line.number === table.lastLine && last.from === line.from && last.cells.every((c) => c.contentFrom === c.contentTo)) {
    return { spec: { changes: { from: line.from, to: line.to, insert: '' }, selection: EditorSelection.cursor(line.from), scrollIntoView: true, userEvent: 'input' } };
  }
  return { spec: appendRowSpec(state, model, line.to) };
}

/** 見出しの行（まだ表でない）の末尾での Enter の計画。条件に合わなければ null。 */
function planHeader(state: EditorState, head: number): EditPlan | null {
  const { doc } = state;
  const line = doc.lineAt(head);
  if (head !== line.to) return null;
  const cols = headerCellCount(line.text);
  if (cols === null) return null;
  const fmEnd = frontmatterEnd(doc);
  if (fmEnd !== null && line.number <= fmEnd) return null;
  if (line.number < doc.lines && isDelimiterRowText(doc.line(line.number + 1).text)) return null;
  const tree = syntaxTree(state);
  // 行の中身の終わり（末尾の空白の前）が、構文木の解析済みの範囲にあること。
  const contentEnd = line.from + line.text.trimEnd().length;
  if (tree.length < contentEnd) return null;
  // 親が Document の Paragraph の最後の行だけ（コード、HTML、引用、リスト、表の中は対象外）。
  let paragraph: SyntaxNode | null = tree.resolveInner(contentEnd, -1);
  while (paragraph && paragraph.name !== 'Paragraph') paragraph = paragraph.parent;
  if (!paragraph || paragraph.parent?.name !== 'Document') return null;
  if (doc.lineAt(paragraph.to).number !== line.number) return null;
  return { spec: insertion(state, line.to, [separatorRowText(cols), emptyRowText(cols)], 1) };
}

/**
 * Enter での表の入力の支援の計画。選択が 1 つで空のときだけ。対象でなければ null（普通の Enter に回す）。
 * 設定「記号の表示」には依らない。
 */
export function planTableEnter(state: EditorState): EditPlan | null {
  const { main, ranges } = state.selection;
  if (ranges.length !== 1 || !main.empty || state.readOnly) return null;
  return planInTable(state, main.head) ?? planHeader(state, main.head);
}
