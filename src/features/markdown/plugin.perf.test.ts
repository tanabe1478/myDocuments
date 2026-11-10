// @vitest-environment jsdom
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { ensureSyntaxTree } from '@codemirror/language';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPluginRegistry, type EditorExtensionEnvironment, type PluginPerf } from '../../plugin-api';
import { markdownPlugin } from '.';

// R16: Markdown の見た目の計測。markdown.decorations（行の装飾と記号の隠し方の組み立て全体）、markdown.live-markup（隠す記号とリンクの範囲）、
// markdown.table-display（表の表示の組み立て）。部品は本体から貸された ctx.perf を使う（本体の内部を import しない）。

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
});

function recordingPerf(enabled = true) {
  const ended: string[] = [];
  let open = 0;
  const perf: PluginPerf = {
    enabled,
    span: (name) => {
      open += 1;
      return () => {
        open -= 1;
        ended.push(name);
      };
    },
    measure: (_n, fn) => fn(),
    record: () => {},
  };
  return { perf, ended, open: () => open, count: (name: string) => ended.filter((n) => n === name).length };
}

const ENV: EditorExtensionEnvironment = { textKind: 'markdown', openExternalUrl: () => {}, isMacPlatform: () => false };

/** 本体が貸す perf を持つレジストリから、部品の拡張を作って載せた view。 */
function mount(doc: string, perf: PluginPerf, textKind: EditorExtensionEnvironment['textKind'] = 'markdown'): EditorView {
  const registry = createPluginRegistry([markdownPlugin], { perf });
  const extension = registry.editorExtensions[0]!.create('cursorLine', { ...ENV, textKind });
  view = new EditorView({ parent: host, state: EditorState.create({ doc, extensions: [markdown({ base: markdownLanguage }), extension] }) });
  ensureSyntaxTree(view.state, view.state.doc.length, 10_000);
  view.dispatch({});
  return view;
}

const TABLE = '| a | b |\n| - | - |\n| 1 | 2 |\n';

describe('markdown spans', () => {
  it('counts the decorations and the live markup when the plugin builds them, and ends every span it started', () => {
    const r = recordingPerf();
    const v = mount('# Title\n\nsome *text* here\n', r.perf);
    expect(r.count('markdown.decorations')).toBeGreaterThan(0);
    expect(r.count('markdown.live-markup')).toBeGreaterThan(0);
    const before = r.count('markdown.decorations');
    v.dispatch({ changes: { from: v.state.doc.length, insert: 'more' } });
    expect(r.count('markdown.decorations')).toBeGreaterThan(before);
    expect(r.open()).toBe(0);
  });

  it('counts the table display when a table is built, and when the touched table changes', () => {
    const r = recordingPerf();
    const v = mount(`text\n\n${TABLE}\nafter\n`, r.perf);
    const built = r.count('markdown.table-display');
    expect(built).toBeGreaterThan(0);
    // 表の中へカーソルを入れる（原文に戻る）と、装飾を作り直す。
    v.dispatch({ selection: { anchor: v.state.doc.toString().indexOf('| 1') + 2 } });
    expect(r.count('markdown.table-display')).toBeGreaterThan(built);
    expect(r.open()).toBe(0);
  });

  it('counts nothing for plain text (the plugin adds no extension there), and nothing is open after an update', () => {
    const r = recordingPerf();
    mount('plain # text', r.perf, 'plain');
    expect(r.ended).toEqual([]);
  });

  it('works without perf (a registry without the option lends a measurement that never counts)', () => {
    const registry = createPluginRegistry([markdownPlugin]);
    const extension = registry.editorExtensions[0]!.create('cursorLine', ENV);
    view = new EditorView({ parent: host, state: EditorState.create({ doc: '# x\n', extensions: [markdown({ base: markdownLanguage }), extension] }) });
    expect(() => view!.dispatch({ changes: { from: 0, insert: 'y' } })).not.toThrow();
  });

  it('only names are recorded: the span names have no text of the document', () => {
    const r = recordingPerf();
    mount('SECRET-BODY-123\n\n' + TABLE, r.perf);
    for (const name of r.ended) expect(name).toMatch(/^markdown\.(decorations|live-markup|table-display)$/);
  });
});
