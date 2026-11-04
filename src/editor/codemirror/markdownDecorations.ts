import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { HighlightStyle, syntaxHighlighting, syntaxTree } from '@codemirror/language';
import { Facet, RangeSetBuilder, StateEffect, type Extension, type Line } from '@codemirror/state';
import {
  Decoration,
  EditorView,
  ViewPlugin,
  WidgetType,
  type DecorationSet,
  type ViewUpdate,
} from '@codemirror/view';
import { tags } from '@lezer/highlight';
import { AFTER_COMPOSITION_MS } from '../../plugin-api';
import type { MarkupDisplay } from '../../preferences/preferences';
import { fallbackPrefixWidthEm, hangPrefix, isBlankLine, measurableText } from '../lineKinds';
import {
  MARKER_WIDGET_EM,
  activeLines,
  collectMarkup,
  hangPieces,
  isActiveLine,
  sameActiveLines,
  type ActiveLines,
  type LinkRange,
  type MarkupSpan,
} from '../liveMarkup';

/**
 * Markdown の見た目。表示だけを変え、本文には何も加えない。
 * - 見出し: 行ごとに文字サイズを変える（クラス cm-md-h1〜h6、サイズは theme.ts）。
 * - 空行: 高さを段落間隔の設定で決める（クラス cm-md-blank。コードフェンスの中は除く）。
 * - コードフェンス: 開始・終了行を含む行に背景帯（cm-md-fence、-start、-end）。
 * - 引用: 行の左に縦線（cm-md-quote）。
 * - リストと引用: 折り返したとき 2 行目以降を記号の後ろに揃える（ぶら下げインデント。行の style で付ける）。
 * - 強調・リンク・コード・引用: 太字、斜体、下線、等幅などで表示する。
 * - 記法記号（#、*、`、[]、> など）: 薄く表示する。
 * - 記法の隠し方（ADR-004、設定「記号の表示」）: 既定（cursorLine）では、カーソルのある行と選択にかかる行だけ
 *   記号を薄く表示し、ほかの行では記号を隠す（見出しの #、箇条書きの • への置き換え、リンクの []() など）。
 *   隠す範囲を決めるのは liveMarkup.ts（純関数）。ここは、それを Decoration.replace で表示にするだけで、本文は書き換えない。
 *   always なら、すべての行で記号を薄く表示する（隠さない）。
 * 色は CSS 変数（styles.css）で、明暗テーマに追従する。
 * 行の装飾（class と style）と、隠す範囲（replace）だけを付け、本文には何も加えない。
 * IME の変換中（view.compositionStarted）は、表示の切り替え（隠す・見せる）を、他の行も含めて保留し、
 * 変換が終わってから反映する。隠している範囲は、本文の変化に位置だけ追従させる（変換中のテキストノードを作り直さない）。
 */
export const markdownHighlightStyle = HighlightStyle.define([
  { tag: [tags.heading1, tags.heading2, tags.heading3, tags.heading4, tags.heading5, tags.heading6], fontWeight: '700' },
  { tag: tags.strong, fontWeight: '700' },
  { tag: tags.emphasis, fontStyle: 'italic' },
  { tag: tags.strikethrough, textDecoration: 'line-through', color: 'var(--md-color-muted)' },
  { tag: tags.link, color: 'var(--md-color-link)', textDecoration: 'underline' },
  { tag: tags.url, color: 'var(--md-color-muted)' },
  { tag: tags.monospace, fontFamily: 'var(--md-font-family-mono)', fontSize: '0.92em', color: 'var(--md-color-code)' },
  { tag: tags.quote, color: 'var(--md-color-quote)' },
  { tag: tags.contentSeparator, color: 'var(--md-color-muted)' },
  // 記法記号は最後に置く（リンクや強調の内側にあっても、薄い色が勝つ）。
  { tag: tags.processingInstruction, color: 'var(--md-color-mark)', fontWeight: '400' },
]);

const HEADING_NODE = /^(?:ATXHeading|SetextHeading)([1-6])$/;

/** 再計算を促す（フォントや字間の設定が変わった後）。 */
const relayout = StateEffect.define<null>();

/**
 * 行頭の記号（"- "、"1. "、"> " など）の幅を、実際のフォントで測る。幅は em（文字サイズに対する比）で
 * 持つので、文字サイズが変わっても測り直さない。フォント・字間が変わったら、キャッシュを捨てる。
 * 測るための見えない要素を本文の外（スクロール領域の中）に置く。本文の DOM には触れない。
 */
class PrefixMeter {
  private readonly probe: HTMLElement;
  private readonly cache = new Map<string, number>();
  private cacheKey = '';

  constructor(view: EditorView) {
    const probe = document.createElement('div');
    probe.setAttribute('aria-hidden', 'true');
    probe.style.cssText =
      'position:absolute;top:0;left:0;visibility:hidden;pointer-events:none;white-space:pre;tab-size:4;height:0;overflow:hidden';
    view.scrollDOM.appendChild(probe);
    this.probe = probe;
  }

  /** フォントと字間（em）。変わったら true。 */
  refreshKey(): boolean {
    const cs = getComputedStyle(this.probe);
    const size = parseFloat(cs.fontSize);
    const spacing = cs.letterSpacing === 'normal' ? 0 : parseFloat(cs.letterSpacing);
    const key = `${cs.fontFamily}|${size > 0 && Number.isFinite(spacing) ? (spacing / size).toFixed(4) : '0'}`;
    if (key === this.cacheKey) return false;
    this.cacheKey = key;
    this.cache.clear();
    return true;
  }

  /** 記号の幅（em）。測れないとき（要素が表示されていない、jsdom など）は概算。 */
  widthEm(prefix: string): number {
    const hit = this.cache.get(prefix);
    if (hit !== undefined) return hit;
    this.probe.textContent = measurableText(prefix);
    const width = this.probe.getBoundingClientRect().width;
    const size = parseFloat(getComputedStyle(this.probe).fontSize);
    if (!(width > 0) || !(size > 0)) return fallbackPrefixWidthEm(prefix);
    const em = width / size;
    this.cache.set(prefix, em);
    return em;
  }

  destroy(): void {
    this.probe.remove();
  }
}

/** 記号の見せ方（設定）。Compartment で差し替える（CodeMirrorAdapter.ts）。 */
export const markupDisplayFacet = Facet.define<MarkupDisplay, MarkupDisplay>({
  combine: (values) => values[0] ?? 'cursorLine',
});

/** 隠した行の • とチェックボックス。幅は固定の箱（MARKER_WIDGET_EM）なので、ぶら下げの幅を計算で決められる。 */
class MarkerWidget extends WidgetType {
  constructor(
    private readonly marker: 'bullet' | 'task',
    private readonly done = false,
  ) {
    super();
  }

  eq(other: MarkerWidget): boolean {
    return other.marker === this.marker && other.done === this.done;
  }

  toDOM(): HTMLElement {
    const el = document.createElement('span');
    if (this.marker === 'bullet') {
      el.className = 'cm-md-marker cm-md-bullet';
      el.textContent = '\u2022';
      return el;
    }
    el.className = `cm-md-marker cm-md-task${this.done ? ' cm-md-task-done' : ''}`;
    // クリックで切り替える（taskToggle.ts）。キーボードでの切り替えはない。
    el.setAttribute('role', 'checkbox');
    el.setAttribute('aria-checked', this.done ? 'true' : 'false');
    el.setAttribute('aria-label', 'タスクの完了');
    const box = document.createElement('span');
    box.className = 'cm-md-task-box';
    el.appendChild(box);
    return el;
  }

  // イベントは CodeMirror に渡す（false）。タスクの mousedown は taskToggle.ts が先に受けて切り替える。
  // 本文のクリックと同じく、切り替えない操作（修飾キー付きなど）はカーソルの位置決めになる。
  ignoreEvent(): boolean {
    return false;
  }
}

const hideMark = Decoration.replace({});
const bulletMark = Decoration.replace({ widget: new MarkerWidget('bullet') });
const taskMark = Decoration.replace({ widget: new MarkerWidget('task', false) });
const taskDoneMark = Decoration.replace({ widget: new MarkerWidget('task', true) });
const linkMark = Decoration.mark({ class: 'cm-md-link' });

function hiddenDecorations(spans: readonly MarkupSpan[]): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  for (const s of spans) {
    const deco =
      s.kind === 'hide' ? hideMark : s.kind === 'bullet' ? bulletMark : s.done ? taskDoneMark : taskMark;
    builder.add(s.from, s.to, deco);
  }
  return builder.finish();
}

function linkDecorations(links: readonly LinkRange[]): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  for (const l of links) builder.add(l.from, l.to, linkMark);
  return builder.finish();
}

interface LineSpec {
  classes: Set<string>;
  /** リストか引用の中の行（ぶら下げインデントの候補）。 */
  hangCandidate: boolean;
}

function blockLines(view: EditorView, meter: PrefixMeter, hidden: readonly MarkupSpan[]): DecorationSet {
  const { doc } = view.state;
  // 隠している行ごとの、隠す範囲（行頭の位置で引く）。
  const hiddenByLine = new Map<number, MarkupSpan[]>();
  for (const s of hidden) {
    const key = doc.lineAt(s.from).from;
    const list = hiddenByLine.get(key);
    if (list) list.push(s);
    else hiddenByLine.set(key, [s]);
  }
  const specs = new Map<number, LineSpec>();
  const fenced = new Set<number>();
  const specOf = (from: number): LineSpec => {
    let s = specs.get(from);
    if (!s) specs.set(from, (s = { classes: new Set(), hangCandidate: false }));
    return s;
  };
  /** node の行のうち、描画範囲に入るものを順に渡す。 */
  const eachLine = (nodeFrom: number, nodeTo: number, rangeFrom: number, rangeTo: number, fn: (line: Line) => void) => {
    const from = Math.max(nodeFrom, rangeFrom);
    const to = Math.min(nodeTo, rangeTo);
    for (let n = doc.lineAt(from).number; n <= doc.lineAt(Math.max(from, to)).number; n++) fn(doc.line(n));
  };

  for (const { from, to } of view.visibleRanges) {
    syntaxTree(view.state).iterate({
      from,
      to,
      enter(node) {
        const heading = HEADING_NODE.exec(node.name);
        if (heading) {
          // Setext 見出しは複数行にまたがる。
          eachLine(node.from, node.to, from, to, (line) => {
            const c = specOf(line.from).classes;
            c.add('cm-md-heading');
            c.add(`cm-md-h${heading[1]}`);
          });
          return false;
        }
        switch (node.name) {
          case 'FencedCode': {
            const first = doc.lineAt(node.from).number;
            const last = doc.lineAt(node.to).number;
            const closed = last > first && /^\s*(?:`{3,}|~{3,})\s*$/.test(doc.line(last).text);
            eachLine(node.from, node.to, from, to, (line) => {
              fenced.add(line.from);
              const c = specOf(line.from).classes;
              c.add('cm-md-fence');
              if (line.number === first) c.add('cm-md-fence-start');
              if (closed && line.number === last) c.add('cm-md-fence-end');
            });
            return false;
          }
          case 'Blockquote':
            eachLine(node.from, node.to, from, to, (line) => {
              const s = specOf(line.from);
              s.classes.add('cm-md-quote');
              s.hangCandidate = true;
            });
            return;
          case 'ListItem':
            eachLine(node.from, node.to, from, to, (line) => {
              specOf(line.from).hangCandidate = true;
            });
            return;
        }
      },
    });
    // 空行。コードフェンスの中は、書いたとおりの高さのままにする。
    let pos = from;
    while (pos <= to) {
      const line = doc.lineAt(pos);
      if (!fenced.has(line.from) && isBlankLine(line.text)) specOf(line.from).classes.add('cm-md-blank');
      pos = line.to + 1;
    }
  }

  const builder = new RangeSetBuilder<Decoration>();
  for (const from of [...specs.keys()].sort((a, b) => a - b)) {
    const spec = specs.get(from)!;
    let attributes: { style: string } | undefined;
    if (spec.hangCandidate && !fenced.has(from) && !spec.classes.has('cm-md-blank')) {
      const line = doc.lineAt(from);
      const hiddenHere = hiddenByLine.get(from);
      let width = 0;
      if (hiddenHere) {
        // 隠した行: 実際に見える部分（記号を隠し、• とチェックボックスは固定の幅の箱）の幅に揃える。
        const pieces = hangPieces(line.text, line.from, hiddenHere);
        width = pieces.texts.reduce((sum, t) => sum + meter.widthEm(t), 0) + pieces.widgets * MARKER_WIDGET_EM;
      } else {
        const prefix = hangPrefix(line.text);
        if (prefix !== '') width = meter.widthEm(prefix);
      }
      if (width > 0) {
        const em = width.toFixed(4);
        attributes = { style: `padding-left:${em}em;text-indent:-${em}em` };
      }
    }
    if (spec.classes.size === 0 && !attributes) continue;
    builder.add(from, from, Decoration.line({ class: [...spec.classes].join(' '), attributes }));
  }
  return builder.finish();
}

/** 変換の終了後に、保留していた再計算を促す。 */
const refreshMarkup = StateEffect.define<null>();

/** 本文の変化に、隠している範囲の位置を追従させる（変換中。範囲が消えたものは捨てる）。 */
function mapSpans(spans: readonly MarkupSpan[], update: ViewUpdate): MarkupSpan[] {
  const out: MarkupSpan[] = [];
  for (const s of spans) {
    const from = update.changes.mapPos(s.from, 1);
    const to = update.changes.mapPos(s.to, -1);
    if (to > from) out.push({ ...s, from, to, line: update.state.doc.lineAt(from).number });
  }
  return out;
}

function mapLinks(links: readonly LinkRange[], update: ViewUpdate): LinkRange[] {
  const out: LinkRange[] = [];
  for (const l of links) {
    const from = update.changes.mapPos(l.from, 1);
    const to = update.changes.mapPos(l.to, -1);
    if (to > from) out.push({ ...l, from, to });
  }
  return out;
}

class BlockLinePlugin {
  lineDecorations: DecorationSet;
  hideDecorations: DecorationSet = Decoration.none;
  linkDecorations: DecorationSet = Decoration.none;
  /** いま隠している範囲（カーソルのない行の記号）。 */
  private hidden: MarkupSpan[] = [];
  /** リンクの範囲（クラスを付ける。⌘/Ctrl+クリックの対象）。 */
  links: LinkRange[] = [];
  private active: ActiveLines = [];
  /** 変換中に、表示の切り替えを見送った。変換が終わったら反映する。 */
  private stale = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly meter: PrefixMeter;
  private readonly observer: MutationObserver | null;

  constructor(private readonly view: EditorView) {
    this.meter = new PrefixMeter(view);
    this.meter.refreshKey();
    this.recomputeMarkup(view);
    this.lineDecorations = blockLines(view, this.meter, this.hidden);
    // フォント・字間の設定は、<html> の style（CSS 変数）で変わる。変わったらぶら下げの幅を測り直す。
    this.observer =
      typeof MutationObserver === 'function'
        ? new MutationObserver(() => {
            if (this.meter.refreshKey()) view.dispatch({ effects: relayout.of(null) });
          })
        : null;
    this.observer?.observe(document.documentElement, { attributes: true, attributeFilter: ['style'] });
  }

  /** 隠す範囲とリンクを、いまの構文木と選択から決め直す。 */
  private recomputeMarkup(view: EditorView): void {
    const { state } = view;
    const ranges = view.visibleRanges;
    const from = ranges[0]?.from ?? 0;
    const to = ranges[ranges.length - 1]?.to ?? state.doc.length;
    const markup = collectMarkup(syntaxTree(state), state.doc, from, to);
    this.links = markup.links;
    if (state.facet(markupDisplayFacet) === 'cursorLine') {
      this.active = activeLines(state.doc, state.selection.ranges);
      this.hidden = markup.spans.filter((s) => !isActiveLine(this.active, s.line));
    } else {
      this.active = [];
      this.hidden = [];
    }
    this.hideDecorations = hiddenDecorations(this.hidden);
    this.linkDecorations = linkDecorations(this.links);
  }

  update(update: ViewUpdate) {
    const forced = update.transactions.some((tr) => tr.effects.some((e) => e.is(refreshMarkup)));
    const relaid = update.transactions.some((tr) => tr.effects.some((e) => e.is(relayout)));
    const display = update.state.facet(markupDisplayFacet);
    const displayChanged = display !== update.startState.facet(markupDisplayFacet);
    const treeChanged = syntaxTree(update.startState) !== syntaxTree(update.state);
    const layoutChanged = update.docChanged || update.viewportChanged || treeChanged;

    if (update.view.compositionStarted && !displayChanged) {
      // IME の変換中: 隠す・見せるの切り替えは、他の行も含めて保留する（変換中のテキストノードに触れない）。
      // 隠している範囲は、本文の変化に位置だけ追従させる。
      if (layoutChanged || update.selectionSet) this.stale = true;
      if (update.docChanged) {
        this.hidden = mapSpans(this.hidden, update);
        this.links = mapLinks(this.links, update);
        this.hideDecorations = hiddenDecorations(this.hidden);
        this.linkDecorations = linkDecorations(this.links);
      }
      if (layoutChanged || relaid) this.lineDecorations = blockLines(update.view, this.meter, this.hidden);
      return;
    }

    let recompute = layoutChanged || displayChanged || forced || this.stale;
    if (!recompute && update.selectionSet && display === 'cursorLine') {
      // 行の表示を切り替えるのは、選択のかかる行が変わったときだけ。
      recompute = !sameActiveLines(this.active, activeLines(update.state.doc, update.state.selection.ranges));
    }
    if (recompute) {
      this.stale = false;
      this.recomputeMarkup(update.view);
    }
    if (recompute || relaid) this.lineDecorations = blockLines(update.view, this.meter, this.hidden);
  }

  compositionEnded(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.stale) this.view.dispatch({ effects: refreshMarkup.of(null) });
    }, AFTER_COMPOSITION_MS);
  }

  destroy() {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.observer?.disconnect();
    this.meter.destroy();
  }
}

const blockLineDecorations = ViewPlugin.fromClass(BlockLinePlugin, {
  decorations: (plugin) => plugin.lineDecorations,
  eventHandlers: {
    compositionend(this: BlockLinePlugin) {
      this.compositionEnded();
      return false;
    },
  },
  provide: (plugin) => [
    // 隠す範囲（replace）とリンクの印（mark）は、行の装飾とは別の出所で渡す（並べ替えの制約を避ける）。
    EditorView.decorations.of((view) => view.plugin(plugin)?.hideDecorations ?? Decoration.none),
    EditorView.decorations.of((view) => view.plugin(plugin)?.linkDecorations ?? Decoration.none),
  ],
});

/** いまの画面にあるリンクの範囲（⌘/Ctrl+クリックで開く対象。linkOpen.ts が使う）。 */
export function visibleLinks(view: EditorView): readonly LinkRange[] {
  const plugin = view.plugin(blockLineDecorations);
  if (!plugin) return [];
  return plugin.links;
}

export function markdownDecorations(): Extension {
  return [markdown({ base: markdownLanguage }), syntaxHighlighting(markdownHighlightStyle), blockLineDecorations];
}

const blankLine = Decoration.line({ class: 'cm-md-blank' });

function plainBlankLines(view: EditorView): DecorationSet {
  const { doc } = view.state;
  const builder = new RangeSetBuilder<Decoration>();
  let lastFrom = -1;
  for (const { from, to } of view.visibleRanges) {
    let pos = from;
    while (pos <= to) {
      const line = doc.lineAt(pos);
      if (line.from > lastFrom && isBlankLine(line.text)) builder.add(line.from, line.from, blankLine);
      lastFrom = Math.max(lastFrom, line.from);
      pos = line.to + 1;
    }
  }
  return builder.finish();
}

class PlainBlankLinePlugin {
  decorations: DecorationSet;

  constructor(view: EditorView) {
    this.decorations = plainBlankLines(view);
  }

  update(update: ViewUpdate) {
    if (update.docChanged || update.viewportChanged) this.decorations = plainBlankLines(update.view);
  }
}

/**
 * 素のテキスト（.txt、.text）の見た目。Markdown の言語・色・見出し・ぶら下げインデント・コードフェンスの帯は付けない。
 * 空行の高さ（段落間隔の設定）は Markdown の記法ではないので、Markdown と同じにする。
 */
export function plainTextDecorations(): Extension {
  return ViewPlugin.fromClass(PlainBlankLinePlugin, { decorations: (plugin) => plugin.decorations });
}
