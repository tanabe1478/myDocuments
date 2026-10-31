/**
 * フォーカスモードの対象範囲（カーソルのある「段落」）。
 *
 * 段落は、次のものの区切りで分けたブロック。
 * - 空行（空白だけの行を含む）
 * - ATX 見出し行（`#`〜`######`）: 1 行で 1 ブロック。直後の本文は別のブロック
 * - リスト項目の開始行（`-` `*` `+` `1.` `1)`）: 項目ごとに 1 ブロック。続く行（インデントされた継続行）は同じ項目
 * - コードフェンス（``` / ~~~）: 閉じるまでの全体で 1 ブロック（中の空行・見出し風の行も含む）
 * - frontmatter（1 行目の --- から次の --- まで）: 全体で 1 ブロック
 *
 * カーソルが空行にあるときは、直前のブロックが対象。直前がなければ直後のブロック。
 * 文書が空行だけなら対象なし（null）で、何も弱く表示しない。
 * 行番号は 1 始まり。from・to を含む。
 */
export interface LineRange {
  readonly from: number;
  readonly to: number;
}

interface Block extends LineRange {
  readonly blank: boolean;
}

interface Fence {
  readonly char: '`' | '~';
  readonly length: number;
}

export function isBlankText(text: string): boolean {
  return /^\s*$/.test(text);
}

const HEADING = /^ {0,3}#{1,6}(?:\s|$)/;
const LIST_ITEM = /^\s*(?:[-*+]|\d{1,9}[.)])(?:\s|$)/;
const FRONTMATTER_DELIMITER = /^---\s*$/;

function openingFence(text: string): Fence | null {
  const m = /^\s*(`{3,}|~{3,})(.*)$/.exec(text);
  if (m === null) return null;
  const marker = m[1]!;
  const char = marker[0] as '`' | '~';
  // バッククォートのフェンスは、info string にバッククォートを含められない（インラインコードと区別する）。
  if (char === '`' && m[2]!.includes('`')) return null;
  return { char, length: marker.length };
}

function closesFence(text: string, fence: Fence): boolean {
  const m = /^\s*(`{3,}|~{3,})\s*$/.exec(text);
  return m !== null && m[1]![0] === fence.char && m[1]!.length >= fence.length;
}

/** 先頭から順にブロックを返す（呼び出し側が必要なところまで読めるよう、遅延評価）。 */
function* blocks(lineCount: number, lineText: (line: number) => string): Generator<Block> {
  let n = 1;
  if (lineCount >= 1 && FRONTMATTER_DELIMITER.test(lineText(1))) {
    for (let m = 2; m <= lineCount; m++) {
      if (FRONTMATTER_DELIMITER.test(lineText(m))) {
        yield { from: 1, to: m, blank: false };
        n = m + 1;
        break;
      }
    }
  }
  while (n <= lineCount) {
    const text = lineText(n);
    if (isBlankText(text)) {
      let to = n;
      while (to < lineCount && isBlankText(lineText(to + 1))) to++;
      yield { from: n, to, blank: true };
      n = to + 1;
      continue;
    }
    const fence = openingFence(text);
    if (fence !== null) {
      // 閉じなければ文書の終わりまで（CommonMark と同じ）。
      let to = n;
      while (to < lineCount) {
        to++;
        if (closesFence(lineText(to), fence)) break;
      }
      yield { from: n, to, blank: false };
      n = to + 1;
      continue;
    }
    if (HEADING.test(text)) {
      yield { from: n, to: n, blank: false };
      n++;
      continue;
    }
    // 段落・リスト項目: 次の区切りの手前まで。
    let to = n;
    while (to < lineCount) {
      const next = lineText(to + 1);
      if (isBlankText(next) || HEADING.test(next) || LIST_ITEM.test(next) || openingFence(next) !== null) break;
      to++;
    }
    yield { from: n, to, blank: false };
    n = to + 1;
  }
}

/**
 * カーソル行（lineCount の範囲に丸める）に対する対象範囲。対象がなければ null。
 * 先頭から読むので、コードフェンスの内外も正しく判定できる。読むのはカーソルのあるブロックまで。
 */
export function focusRange(
  lineCount: number,
  lineText: (line: number) => string,
  cursorLine: number,
): LineRange | null {
  const line = Math.min(Math.max(cursorLine, 1), Math.max(lineCount, 1));
  let previous: LineRange | null = null;
  let cursorBlock: Block | null = null;
  for (const block of blocks(lineCount, lineText)) {
    if (cursorBlock === null) {
      if (line > block.to) {
        if (!block.blank) previous = { from: block.from, to: block.to };
        continue;
      }
      if (!block.blank) return { from: block.from, to: block.to };
      // 空行にいる。直前があればそれ。
      if (previous !== null) return previous;
      cursorBlock = block;
      continue;
    }
    // 直前がないときだけ、空行の連なりの直後のブロック。
    if (!block.blank) return { from: block.from, to: block.to };
  }
  return null;
}
