/**
 * 表の表示（ADR-006）。カーソルが表の外にあるとき、トップレベルの Markdown の表を、表の形で表示する。
 * 表示だけを変え、本文には何も加えない（文書のバイト列も、コピーした文字列も、原文のまま）。
 *
 * - 対象: 設定「記号の表示」が cursorLine のとき、親が Document の表。選択のどの範囲も表の範囲（最初の行の行頭から最後の行の行末。
 *   端の一致も含む）に触れないとき、表全体を 1 つのブロック（Decoration.replace の block）に置き換える。
 *   触れたら原文に戻る（その表だけ）。
 * - 行をまたぐ置き換えは、ViewPlugin からは出せない（CodeMirror の制約）ので、StateField から出す。
 * - 組み立ては createElement と textContent だけ。文書の文字を HTML として解釈しない。
 * - 表示中の表のクリックで、クリックしたセルの中身の末尾にカーソルを置く（その結果、表は原文に戻る）。
 *   本文の幅に入らない表は、表の囲みだけが横にスクロールする。横スクロールバーの上の押下は、カーソルを動かさない。
 * - IME の変換中は、表示と原文の切り替えを（ほかの表も含めて）保留し、変換の終了後（ADR-004 と同じ待ち）に反映する。
 *   保留中は、表示中の表の位置だけを本文の変化に追従させ、DOM は作り直さない。
 * - フォーカスモードなど、行を弱く表示する部品があれば、カーソルの段落でない表を弱く表示する（plugin-api の dimExemptLines）。
 */
import { syntaxTree } from '@codemirror/language';
import {
  EditorSelection,
  RangeSet,
  StateEffect,
  StateField,
  type EditorState,
  type Extension,
  type Range,
  type Text,
  type Transaction,
} from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet, type ViewUpdate } from '@codemirror/view';
import { AFTER_COMPOSITION_MS, DIMMED_BLOCK_CLASS, dimExemptLines, isDimmedBlock } from '../../plugin-api';
import { markupDisplayFacet } from './markdownDecorations';
import { perfFacet } from './perf';
import { buildTableModel, topLevelTables, type CellModel, type RowModel, type SyntaxNode, type TableRef } from './tableModel';

/** 表示中の表の class（見た目は theme.ts）。 */
export const TABLE_CLASS = 'cm-md-table';

// ---- セルの中身（インライン）の組み立て ----

/** 見た目の class。ほかの行で記号を隠したときと同じ見た目になるよう、theme.ts が同じ CSS 変数で付ける。 */
const INLINE_CLASS: Record<string, string> = {
  Emphasis: 'cm-md-t-em',
  StrongEmphasis: 'cm-md-t-strong',
  Strikethrough: 'cm-md-t-del',
  InlineCode: 'cm-md-t-code',
};
/** 記号（表示しない）。 */
const MARK_NODES = new Set(['EmphasisMark', 'StrikethroughMark', 'CodeMark']);

function appendText(parent: Node, text: string): void {
  // セルの中の `\|` は `|` と表示する（それ以外の `\` は、原文のまま）。
  if (text !== '') parent.appendChild(document.createTextNode(text.replace(/\\\|/g, '|')));
}

function span(className: string): HTMLElement {
  const el = document.createElement('span');
  el.className = className;
  return el;
}

/** インラインリンク [文字](URL) の、文字の範囲。参照リンク [文字][ref] と [文字] だけのものは null（原文のまま）。 */
function inlineLinkText(node: SyntaxNode, doc: Text): { from: number; to: number } | null {
  const marks: SyntaxNode[] = [];
  for (let c = node.firstChild; c; c = c.nextSibling) if (c.name === 'LinkMark') marks.push(c);
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
    return null;
  }
  return { from: open.to, to: close.from };
}

/** node の [from, to) を、parent の子として組み立てる。node の子のうち、範囲の中にあるものを順に見る。 */
function appendInline(parent: Node, node: SyntaxNode, from: number, to: number, doc: Text): void {
  let pos = from;
  for (let c = node.firstChild; c; c = c.nextSibling) {
    if (c.from < pos) continue;
    if (c.from >= to) break;
    appendText(parent, doc.sliceString(pos, c.from));
    pos = c.to;
    const name = c.name;
    if (MARK_NODES.has(name)) {
      if (name === 'CodeMark' && c.node.parent?.name !== 'InlineCode') appendText(parent, doc.sliceString(c.from, c.to));
      continue;
    }
    const cls = INLINE_CLASS[name];
    if (cls) {
      const el = span(cls);
      appendInline(el, c.node, c.from, c.to, doc);
      parent.appendChild(el);
    } else if (name === 'Link') {
      const text = inlineLinkText(c.node, doc);
      if (text) {
        const el = span('cm-md-t-link');
        appendInline(el, c.node, text.from, text.to, doc);
        parent.appendChild(el);
      } else {
        appendText(parent, doc.sliceString(c.from, c.to));
      }
    } else if (name === 'Autolink') {
      // <https://...>: < > を表示せず、URL だけ。
      let url: SyntaxNode | null = null;
      for (let u = c.node.firstChild; u; u = u.nextSibling) if (u.name === 'URL') url = u;
      const el = span('cm-md-t-url');
      appendText(el, url ? doc.sliceString(url.from, url.to) : doc.sliceString(c.from, c.to));
      parent.appendChild(el);
    } else if (name === 'URL') {
      // 親が Link・Image・Autolink・LinkReference のものは、それぞれが扱う。ここに来るのは GFM の裸の URL。
      const el = span('cm-md-t-url');
      appendText(el, doc.sliceString(c.from, c.to));
      parent.appendChild(el);
    } else {
      // 画像、参照リンク、HTML、エスケープなど: 原文の文字のまま。
      appendText(parent, doc.sliceString(c.from, c.to));
    }
  }
  appendText(parent, doc.sliceString(pos, to));
}

function appendCell(row: HTMLElement, tag: 'th' | 'td', cell: CellModel | undefined, doc: Text, base: number, rowTo: number, align: string): void {
  const el = document.createElement(tag);
  el.style.textAlign = align;
  if (cell) {
    // 中身を、前後の空白を除いた範囲で組み立てる。TableCell の構文木があれば、強調などの見た目を付ける。
    if (cell.node) appendInline(el, cell.node, cell.contentFrom, cell.contentTo, doc);
    // クリックで、中身の末尾（空のセルは Tab の位置）へ。表の先頭からの相対位置（表示が使い回されても、ずれない）。
    el.dataset.end = String((cell.contentFrom === cell.contentTo ? cell.start : cell.contentTo) - base);
  } else {
    // 見出しより足りない本文のセル: 空。クリックは、その行の末尾へ。
    el.dataset.end = String(rowTo - base);
  }
  row.appendChild(el);
}

function appendRow(section: HTMLElement, row: RowModel, tag: 'th' | 'td', columns: number, aligns: readonly (string | null)[], doc: Text, base: number): void {
  const tr = document.createElement('tr');
  // 列の数は見出しのセルの数。足りないセルは空、余るセルは表示しない。
  for (let i = 0; i < columns; i++) appendCell(tr, tag, row.cells[i], doc, base, row.to, aligns[i] ?? 'left');
  section.appendChild(tr);
}

/** 表全体の DOM。 */
function renderTable(table: TableRef, doc: Text): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = TABLE_CLASS;
  // 原文の行数（弱く表示するかを、表の行の範囲で決めるために使う）。
  wrap.dataset.lines = String(table.lastLine - table.firstLine + 1);
  const model = buildTableModel(table, doc);
  if (!model) return wrap;
  const aligns = model.aligns.map((a) => a ?? 'left');
  const grid = document.createElement('table');
  grid.className = 'cm-md-table-grid';
  const head = document.createElement('thead');
  appendRow(head, model.header, 'th', aligns.length, aligns, doc, table.from);
  const body = document.createElement('tbody');
  for (const row of model.body) appendRow(body, row, 'td', aligns.length, aligns, doc, table.from);
  grid.append(head, body);
  wrap.appendChild(grid);
  return wrap;
}

// ---- クリック ----

/** クリックの位置から一番近いセルの、行き先（表の先頭からの相対位置）。決められなければ null。 */
function nearestCellEnd(wrap: HTMLElement, x: number, y: number): number | null {
  let best: { d: number; end: number } | null = null;
  for (const cell of wrap.querySelectorAll<HTMLElement>('[data-end]')) {
    const r = cell.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    const dx = Math.max(r.left - x, 0, x - r.right);
    const dy = Math.max(r.top - y, 0, y - r.bottom);
    const d = dx * dx + dy * dy;
    if (!best || d < best.d) best = { d, end: Number(cell.dataset.end) };
  }
  return best ? best.end : null;
}

/**
 * 押した位置が、表の囲み（.cm-md-table）の横スクロールバーの上か。囲み自身が押された（target が囲み）うえで、位置が囲みの下端から
 * スクロールバーの太さ（offsetHeight と clientHeight の差。縦スクロールバーは出さない）の中なら、スクロールバー。
 * スクロールバーは theme で非オーバーレイの太さに決めてある（オーバーレイだと、囲みの大きさを取らず、この判定が当たらない）。
 * スクロールバーのないとき（差が 0）は、常に false。
 */
function isOnScrollbar(wrap: HTMLElement, event: MouseEvent): boolean {
  if (event.target !== wrap) return false;
  const thickness = wrap.offsetHeight - wrap.clientHeight;
  return thickness > 1 && event.clientY >= wrap.getBoundingClientRect().bottom - thickness;
}

/**
 * 表示中の表の mousedown。左クリックだけを受ける（修飾キーは、Shift 以外は区別しない。右・中クリックは何もしない）。
 * カーソルを、クリックしたセルの中身の末尾（セルの外は一番近いセル、決められなければ表の頭）に置く。
 * Shift なら、選択の anchor を保ったまま head をその位置まで伸ばす。文書は変えない。
 */
function onTableMouseDown(view: EditorView, wrap: HTMLElement, event: MouseEvent): void {
  if (event.button !== 0) return;
  // 横スクロールバーの上の押下は、スクロールバーに任せる（preventDefault もカーソルの移動もしない）。
  if (isOnScrollbar(wrap, event)) return;
  const cell = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-end]') : null;
  const relative = cell && wrap.contains(cell) ? Number(cell.dataset.end) : nearestCellEnd(wrap, event.clientX, event.clientY);
  // 表示の今の位置（本文が変わっても、使い回された DOM の位置は、表示の木から引くので古くならない）。
  const pos = Math.min(view.posAtDOM(wrap) + (relative ?? 0), view.state.doc.length);
  event.preventDefault();
  if (!view.hasFocus) view.focus();
  view.dispatch({
    selection: event.shiftKey ? EditorSelection.single(view.state.selection.main.anchor, pos) : EditorSelection.cursor(pos),
    userEvent: 'select.pointer',
  });
}

// ---- ウィジェット ----

class TableWidget extends WidgetType {
  constructor(
    private readonly table: TableRef,
    private readonly doc: Text,
  ) {
    super();
  }

  /** 原文が同じなら、DOM を使い回す（位置がずれただけでは、作り直さない）。 */
  eq(other: TableWidget): boolean {
    const length = this.table.to - this.table.from;
    return (
      other.table.to - other.table.from === length &&
      other.doc.sliceString(other.table.from, other.table.to) === this.doc.sliceString(this.table.from, this.table.to)
    );
  }

  toDOM(view: EditorView): HTMLElement {
    const wrap = renderTable(this.table, this.doc);
    const first = Math.min(this.table.firstLine, view.state.doc.lines);
    wrap.classList.toggle(DIMMED_BLOCK_CLASS, isDimmedBlock(view.state, first, first + (this.table.lastLine - this.table.firstLine)));
    wrap.addEventListener('mousedown', (event) => onTableMouseDown(view, wrap, event));
    return wrap;
  }

  // CodeMirror は、表の中のイベントを扱わない（クリックは、上の mousedown が受ける）。
  ignoreEvent(): boolean {
    return true;
  }

  /** 描画する前の高さの見積もり（行数 × 1 行の高さの目安）。描画された後は、実際の高さに置き換わる。 */
  get estimatedHeight(): number {
    return (this.table.lastLine - this.table.firstLine) * 36 + 16;
  }
}

// ---- 状態 ----

const setComposing = StateEffect.define<boolean>();

interface Entry {
  readonly table: TableRef;
  /** 表示するときの装飾（作ったら使い回す）。 */
  deco: Decoration | null;
}

interface TableState {
  /** 候補のトップレベルの表（from の昇順）。設定が cursorLine でないときは空。 */
  readonly entries: readonly Entry[];
  /** 選択に触れている表の番号（原文のまま）。 */
  readonly active: readonly number[];
  readonly decorations: DecorationSet;
  /** 表示中の表。 */
  readonly rendered: readonly TableRef[];
  /** IME の変換中。切り替えを保留する。 */
  readonly composing: boolean;
  /** 変換中に、切り替えを見送った。 */
  readonly stale: boolean;
}

/** 選択のどれかの範囲に触れている（端の一致を含む）表の番号。 */
function touchedTables(entries: readonly Entry[], selection: EditorState['selection']): number[] {
  const hit = new Set<number>();
  for (const range of selection.ranges) {
    // from が range.to 以下の最後の表から、後ろへ数える（entries は from の昇順で、重ならない）。
    let lo = 0;
    let hi = entries.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (entries[mid]!.table.from <= range.to) lo = mid + 1;
      else hi = mid;
    }
    for (let i = lo - 1; i >= 0 && entries[i]!.table.to >= range.from; i--) hit.add(i);
  }
  return [...hit].sort((a, b) => a - b);
}

function decorate(entries: readonly Entry[], active: readonly number[], doc: Text): { decorations: DecorationSet; rendered: TableRef[] } {
  const skip = new Set(active);
  const ranges: Range<Decoration>[] = [];
  const rendered: TableRef[] = [];
  entries.forEach((entry, i) => {
    if (skip.has(i)) return;
    entry.deco ??= Decoration.replace({ block: true, widget: new TableWidget(entry.table, doc) });
    ranges.push(entry.deco.range(entry.table.from, entry.table.to));
    rendered.push(entry.table);
  });
  return { decorations: RangeSet.of(ranges), rendered };
}

/** 表の表示の組み立て（表の検出と、表示する装飾）。区間 markdown.table-display として数える（R16）。 */
function compute(state: EditorState, composing: boolean): TableState {
  const end = state.facet(perfFacet).span('markdown.table-display');
  try {
    return computeInner(state, composing);
  } finally {
    end();
  }
}

function computeInner(state: EditorState, composing: boolean): TableState {
  const entries: Entry[] =
    state.facet(markupDisplayFacet) === 'cursorLine' ? topLevelTables(syntaxTree(state), state.doc).map((table) => ({ table, deco: null })) : [];
  const active = touchedTables(entries, state.selection);
  return { entries, active, ...decorate(entries, active, state.doc), composing, stale: false };
}

const tableField = StateField.define<TableState>({
  create: (state) => compute(state, false),
  update(value, tr: Transaction) {
    let composing = value.composing;
    let forced = false;
    for (const e of tr.effects) {
      if (e.is(setComposing)) {
        composing = e.value;
        forced = !composing;
      }
    }
    const treeChanged = syntaxTree(tr.startState) !== syntaxTree(tr.state);
    const changed = tr.docChanged || treeChanged;
    if (composing) {
      // 変換中: 切り替えは保留する。表示中の表の位置だけを、本文の変化に追従させる（DOM は作り直さない）。
      if (!changed && !tr.selection && composing === value.composing) return value;
      return {
        ...value,
        composing,
        stale: value.stale || changed || tr.selection !== undefined,
        decorations: tr.docChanged ? value.decorations.map(tr.changes) : value.decorations,
      };
    }
    if (changed || forced || value.stale || tr.state.facet(markupDisplayFacet) !== tr.startState.facet(markupDisplayFacet)) {
      return compute(tr.state, composing);
    }
    if (tr.selection) {
      // 選択だけが変わった: 触れている表が変わったときだけ、装飾を作り直す（表の一覧は使い回す）。
      const active = touchedTables(value.entries, tr.state.selection);
      if (active.length !== value.active.length || active.some((n, i) => n !== value.active[i])) {
        const end = tr.state.facet(perfFacet).span('markdown.table-display');
        try {
          return { ...value, active, ...decorate(value.entries, active, tr.state.doc) };
        } finally {
          end();
        }
      }
    }
    return composing === value.composing ? value : { ...value, composing };
  },
  provide: (field) => EditorView.decorations.from(field, (value) => value.decorations),
});

/** いま表示中の表（原文のままの表と、保留中のものは含めない）。上下キーで表へ入るときに使う。 */
export function renderedTables(state: EditorState): readonly TableRef[] {
  const value = state.field(tableField, false);
  return value && !value.composing ? value.rendered : [];
}

// ---- IME の変換中の保留 ----

/** 変換の開始と終了を、state に伝える。終了は、変換が確定する時間（AFTER_COMPOSITION_MS）の後。 */
const compositionGuard = ViewPlugin.fromClass(
  class {
    timer: ReturnType<typeof setTimeout> | null = null;

    clear(): void {
      if (this.timer !== null) clearTimeout(this.timer);
      this.timer = null;
    }

    destroy(): void {
      this.clear();
    }
  },
  {
    eventHandlers: {
      compositionstart(this: { clear(): void }, _event, view) {
        this.clear();
        if (!view.state.field(tableField).composing) view.dispatch({ effects: setComposing.of(true) });
        return false;
      },
      compositionend(this: { clear(): void; timer: ReturnType<typeof setTimeout> | null }, _event, view) {
        this.clear();
        this.timer = setTimeout(() => {
          this.timer = null;
          if (!view.compositionStarted && view.state.field(tableField).composing) view.dispatch({ effects: setComposing.of(false) });
        }, AFTER_COMPOSITION_MS);
        return false;
      },
    },
  },
);

// ---- 弱く表示 ----

/** 表示中の表の「弱く表示」を、選択や本文が変わるたびに合わせ直す（DOM が使い回されても追従する）。 */
const dimSync = ViewPlugin.fromClass(
  class {
    constructor(private readonly view: EditorView) {}

    update(update: ViewUpdate): void {
      if (!update.selectionSet && !update.docChanged && !update.viewportChanged && update.startState.facet(dimExemptLines) === update.state.facet(dimExemptLines)) return;
      const { view } = this;
      for (const wrap of view.contentDOM.querySelectorAll<HTMLElement>(`.${TABLE_CLASS}`)) {
        let first: number;
        try {
          first = view.state.doc.lineAt(view.posAtDOM(wrap)).number;
        } catch {
          continue; // 取り除かれる途中の要素
        }
        const rows = Number(wrap.dataset.lines ?? 1);
        wrap.classList.toggle(DIMMED_BLOCK_CLASS, isDimmedBlock(view.state, first, first + rows - 1));
      }
    }
  },
);

// ---- 見た目 ----

/**
 * 表の見た目。色は CSS 変数で、明暗テーマに追従する。幅の規則（ADR-006「列幅」）:
 * セルに最小幅（6em）を付け、word-break: normal と overflow-wrap: break-word で折り返す。本文の幅に入る表は内容に合わせた幅のまま、
 * 最小幅を並べても入らない表（列が多いなど）は、表の囲み（.cm-md-table）だけが横にスクロールする（エディタ全体は横に動かない）。
 * 最小幅が無いと、列の最小の幅が 1 文字になり、日本語の短い列が縦書きのように潰れた。em だけで決めるので、文字の大きさの設定に追従する。
 */
export const tableTheme = EditorView.theme({
  // 上下の余白は margin ではなく padding（CodeMirror はブロックの高さに margin を数えない）。
  // 横スクロールバーは囲みの下端に付く。その分も囲みの高さ（getBoundingClientRect）に入るので、CodeMirror の高さの計測は狂わない。
  [`.${TABLE_CLASS}`]: { padding: '0.45em 0', textIndent: '0', cursor: 'text', overflowX: 'auto', overflowY: 'hidden' },
  // 非オーバーレイの細いスクロールバー（押した位置が、スクロールバーの上かを、囲みの領域との差で判定するため。onTableMouseDown）。
  [`.${TABLE_CLASS}::-webkit-scrollbar`]: { height: '10px' },
  [`.${TABLE_CLASS}::-webkit-scrollbar-track`]: { backgroundColor: 'transparent' },
  [`.${TABLE_CLASS}::-webkit-scrollbar-thumb`]: { backgroundColor: 'var(--md-color-border)', borderRadius: '5px' },
  '.cm-md-table-grid': {
    borderCollapse: 'collapse',
    // 継承された word-break: break-word（CodeMirror の .cm-lineWrapping が付ける）は、列の最小の幅を 1 文字ほどにする。normal に戻して、
    // 長い語や URL を折らずに最小の幅とする（入らなければ囲みが横スクロール）。日本語の文は、これまでどおり文字の間で折り返す。
    wordBreak: 'normal',
    overflowWrap: 'break-word',
    lineHeight: '1.6',
  },
  '.cm-md-table-grid th, .cm-md-table-grid td': {
    border: '1px solid var(--md-color-border)',
    padding: '0.3em 0.7em',
    verticalAlign: 'top',
    minWidth: '6em',
  },
  '.cm-md-table-grid th': { fontWeight: '700', backgroundColor: 'var(--md-color-code-bg)' },
  // セルの中の強調など: ほかの行で記号を隠したときと同じ見た目（markdownHighlightStyle と同じ CSS 変数）。
  '.cm-md-t-strong': { fontWeight: '700' },
  '.cm-md-t-em': { fontStyle: 'italic' },
  '.cm-md-t-del': { textDecoration: 'line-through', color: 'var(--md-color-muted)' },
  '.cm-md-t-link': { color: 'var(--md-color-link)', textDecoration: 'underline' },
  '.cm-md-t-url': { color: 'var(--md-color-muted)' },
  '.cm-md-t-code': { fontFamily: 'var(--md-font-family-mono)', fontSize: '0.92em', color: 'var(--md-color-code)' },
});

/** 表の表示の拡張一式。記号の見せ方（markupDisplayFacet）を読むので、markdownDecorations と一緒に入れる。 */
export function tableDisplay(): Extension {
  return [tableField, compositionGuard, dimSync, tableTheme];
}
