import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { HighlightStyle, syntaxHighlighting, syntaxTree } from '@codemirror/language';
import { RangeSetBuilder, StateEffect, type Extension, type Line } from '@codemirror/state';
import { Decoration, ViewPlugin, type DecorationSet, type EditorView, type ViewUpdate } from '@codemirror/view';
import { tags } from '@lezer/highlight';
import { fallbackPrefixWidthEm, hangPrefix, isBlankLine, measurableText } from '../lineKinds';

/**
 * Markdown の見た目。表示だけを変え、本文には何も加えない。
 * - 見出し: 行ごとに文字サイズを変える（クラス cm-md-h1〜h6、サイズは theme.ts）。
 * - 空行: 高さを段落間隔の設定で決める（クラス cm-md-blank。コードフェンスの中は除く）。
 * - コードフェンス: 開始・終了行を含む行に背景帯（cm-md-fence、-start、-end）。
 * - 引用: 行の左に縦線（cm-md-quote）。
 * - リストと引用: 折り返したとき 2 行目以降を記号の後ろに揃える（ぶら下げインデント。行の style で付ける）。
 * - 強調・リンク・コード・引用: 太字、斜体、下線、等幅などで表示する。
 * - 記法記号（#、*、`、[]、> など）: 薄く表示する。非表示にはしない
 *   （自動非表示は IME と範囲選択への影響を確認してから、仕様 §5.2）。
 * 色は CSS 変数（styles.css）で、明暗テーマに追従する。
 * 行の装飾（class と style）だけを付け、本文には何も加えない。IME の変換中も、装飾の付け替えで
 * 変換中のテキストノードは作り直されない（行の属性だけが変わる）。
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

interface LineSpec {
  classes: Set<string>;
  /** リストか引用の中の行（ぶら下げインデントの候補）。 */
  hangCandidate: boolean;
}

function blockLines(view: EditorView, meter: PrefixMeter): DecorationSet {
  const { doc } = view.state;
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
      const prefix = hangPrefix(doc.lineAt(from).text);
      if (prefix !== '') {
        const em = meter.widthEm(prefix).toFixed(4);
        attributes = { style: `padding-left:${em}em;text-indent:-${em}em` };
      }
    }
    if (spec.classes.size === 0 && !attributes) continue;
    builder.add(from, from, Decoration.line({ class: [...spec.classes].join(' '), attributes }));
  }
  return builder.finish();
}

class BlockLinePlugin {
  decorations: DecorationSet;
  private readonly meter: PrefixMeter;
  private readonly observer: MutationObserver | null;

  constructor(view: EditorView) {
    this.meter = new PrefixMeter(view);
    this.meter.refreshKey();
    this.decorations = blockLines(view, this.meter);
    // フォント・字間の設定は、<html> の style（CSS 変数）で変わる。変わったらぶら下げの幅を測り直す。
    this.observer =
      typeof MutationObserver === 'function'
        ? new MutationObserver(() => {
            if (this.meter.refreshKey()) view.dispatch({ effects: relayout.of(null) });
          })
        : null;
    this.observer?.observe(document.documentElement, { attributes: true, attributeFilter: ['style'] });
  }

  update(update: ViewUpdate) {
    if (
      update.docChanged ||
      update.viewportChanged ||
      syntaxTree(update.startState) !== syntaxTree(update.state) ||
      update.transactions.some((tr) => tr.effects.some((e) => e.is(relayout)))
    ) {
      this.decorations = blockLines(update.view, this.meter);
    }
  }

  destroy() {
    this.observer?.disconnect();
    this.meter.destroy();
  }
}

const blockLineDecorations = ViewPlugin.fromClass(BlockLinePlugin, {
  decorations: (plugin) => plugin.decorations,
});

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
