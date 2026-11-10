// @vitest-environment jsdom
import { EditorView } from '@codemirror/view';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PluginPerf } from '../../plugin-api';
import { createCodeMirrorAdapter } from './CodeMirrorAdapter';
import type { EditorAdapter } from '../EditorAdapter';

// R16: 入力の計測。keydown（capture）から本文の更新（CodeMirror の update が済んだ時点）まで、次の描画まで、IME の変換（compositionupdate）から本文の更新まで。
// 数えるのは、修飾キーなしの 1 文字と Enter、Backspace だけ。perf が無効の間は何もしない。

beforeAll(() => {
  const rect = { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON: () => ({}) };
  const rects = Object.assign([], { item: () => null });
  Range.prototype.getClientRects = () => rects as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect = () => rect as DOMRect;
  Element.prototype.getClientRects = () => rects as unknown as DOMRectList;
});

let host: HTMLElement;
let adapter: EditorAdapter;
let frames: Array<() => void>;
/** アダプターの計測（waitForPaint）が requestAnimationFrame を呼んだ回数。CodeMirror 自身の測定の要求は、呼び出し元で見分けて数えない。 */
let frameRequests = 0;

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  frames = [];
  frameRequests = 0;
  vi.stubGlobal('requestAnimationFrame', (cb: () => void) => {
    if (new Error().stack?.includes('waitForPaint')) frameRequests += 1;
    frames.push(cb);
    return frames.length;
  });
  vi.stubGlobal('cancelAnimationFrame', () => {});
});
afterEach(() => {
  adapter?.destroy();
  host.remove();
  vi.unstubAllGlobals();
});

function recordingPerf(enabled = true) {
  const records: Array<[string, number]> = [];
  const perf: PluginPerf = {
    enabled,
    span: () => () => {},
    measure: (_n, fn) => fn(),
    record: (name, ms) => void records.push([name, ms]),
  };
  return { perf, records, setEnabled: (v: boolean) => ((perf as { enabled: boolean }).enabled = v) };
}

function mount(perf: PluginPerf | null): EditorView {
  adapter = createCodeMirrorAdapter([], undefined, perf);
  adapter.mount(host);
  const dom = host.querySelector('.cm-editor') as HTMLElement;
  return EditorView.findFromDOM(dom)!;
}

const keydown = (view: EditorView, key: string, init: KeyboardEventInit = {}) =>
  view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }));
const type = (view: EditorView, text: string) => view.dispatch({ changes: { from: view.state.doc.length, insert: text }, userEvent: 'input.type' });
const tick = () => new Promise((r) => setTimeout(r, 10));
/** 溜まった描画のコールバックを、全部呼ぶ（CodeMirror 自身のものも含む）。 */
const runFrames = () => frames.splice(0).forEach((cb) => cb());
/** fn を実行して、その間に requestAnimationFrame が呼ばれた回数。 */
const framesRequestedBy = (fn: () => void): number => {
  const before = frameRequests;
  fn();
  return frameRequests - before;
};

describe('keydown to update', () => {
  it('counts the time from a character key (capture) to the update that changes the document', () => {
    const r = recordingPerf();
    const view = mount(r.perf);
    keydown(view, 'a');
    type(view, 'a');
    expect(r.records.map((x) => x[0])).toEqual(['input.keydown-to-update']);
    expect(r.records[0]![1]).toBeGreaterThanOrEqual(0);
  });

  it('counts Enter and Backspace, and a shifted character; not other keys, nor keys with Ctrl, Meta or Alt', () => {
    const r = recordingPerf();
    const view = mount(r.perf);
    const counted = (key: string, init: KeyboardEventInit = {}) => {
      r.records.length = 0;
      keydown(view, key, init);
      type(view, 'x');
      return r.records.filter((x) => x[0] === 'input.keydown-to-update').length;
    };
    expect(counted('Enter')).toBe(1);
    expect(counted('Backspace')).toBe(1);
    expect(counted('A', { shiftKey: true })).toBe(1);
    expect(counted('ArrowLeft')).toBe(0);
    expect(counted('Tab')).toBe(0);
    expect(counted('Shift')).toBe(0);
    expect(counted('z', { ctrlKey: true })).toBe(0);
    expect(counted('s', { metaKey: true })).toBe(0);
    expect(counted('f', { altKey: true })).toBe(0);
    expect(counted('Process')).toBe(0);
  });

  it('does not count a keydown during composition (IME), and counts one key once even if several updates follow', () => {
    const r = recordingPerf();
    const view = mount(r.perf);
    keydown(view, 'a', { isComposing: true });
    type(view, 'あ');
    expect(r.records.filter((x) => x[0] === 'input.keydown-to-update')).toEqual([]);
    keydown(view, 'b');
    type(view, 'b');
    type(view, 'c');
    expect(r.records.filter((x) => x[0] === 'input.keydown-to-update')).toHaveLength(1);
  });

  it('does not tie a keydown that changed nothing to a later, unrelated update', () => {
    const r = recordingPerf();
    const view = mount(r.perf);
    keydown(view, 'a');
    // 更新は来ない。2 秒以上たったことにして、別の更新が来る。
    const now = performance.now();
    vi.spyOn(performance, 'now').mockReturnValue(now + 5000);
    type(view, 'x');
    vi.restoreAllMocks();
    expect(r.records.filter((x) => x[0] === 'input.keydown-to-update')).toEqual([]);
  });

  it('only keydowns inside the editor content count', () => {
    const r = recordingPerf();
    const view = mount(r.perf);
    const outside = document.createElement('input');
    host.append(outside);
    outside.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }));
    type(view, 'a');
    expect(r.records).toEqual([]);
  });
});

describe('keydown to the next paint', () => {
  it('waits for the next frame and the task after it, then counts every keydown that was waiting', async () => {
    const r = recordingPerf();
    const view = mount(r.perf);
    // 2 つの keydown で、描画の要求は 1 回だけ（待っている間は、まとめる）。
    expect(framesRequestedBy(() => {
      keydown(view, 'a');
      keydown(view, 'b');
    })).toBe(1);
    expect(r.records.filter((x) => x[0] === 'input.keydown-to-paint')).toEqual([]);
    runFrames();
    await tick();
    const paints = r.records.filter((x) => x[0] === 'input.keydown-to-paint');
    expect(paints).toHaveLength(2);
    expect(paints.every((p) => p[1] >= 0)).toBe(true);
  });

  it('does not wait for a frame while the window is hidden (the frames do not come)', () => {
    const r = recordingPerf();
    const view = mount(r.perf);
    Object.defineProperty(document, 'visibilityState', { get: () => 'hidden', configurable: true });
    expect(framesRequestedBy(() => keydown(view, 'a'))).toBe(0);
    Object.defineProperty(document, 'visibilityState', { get: () => 'visible', configurable: true });
  });

  it('caps the number of keydowns waiting for a frame', async () => {
    const r = recordingPerf();
    const view = mount(r.perf);
    for (let i = 0; i < 200; i++) keydown(view, 'a');
    runFrames();
    await tick();
    expect(r.records.filter((x) => x[0] === 'input.keydown-to-paint').length).toBe(64);
  });
});

describe('composition to update', () => {
  it('counts the time from compositionupdate to the update that changes the document, as its own span', () => {
    const r = recordingPerf();
    const view = mount(r.perf);
    view.contentDOM.dispatchEvent(new CompositionEvent('compositionupdate', { data: 'に', bubbles: true }));
    type(view, 'に');
    expect(r.records.map((x) => x[0])).toEqual(['input.composition-to-update']);
    type(view, 'x');
    expect(r.records.filter((x) => x[0] === 'input.composition-to-update')).toHaveLength(1);
  });
});

describe('off', () => {
  it('while perf is disabled, no keydown or composition is tracked (no rAF, no record), and it is the same without perf', async () => {
    const r = recordingPerf(false);
    const view = mount(r.perf);
    const disabled = framesRequestedBy(() => {
      keydown(view, 'a');
      view.contentDOM.dispatchEvent(new CompositionEvent('compositionupdate', { data: 'あ', bubbles: true }));
      type(view, 'a');
    });
    await tick();
    expect(r.records).toEqual([]);
    adapter.destroy();
    runFrames();
    const view2 = mount(null);
    runFrames();
    const absent = framesRequestedBy(() => {
      keydown(view2, 'a');
      view2.contentDOM.dispatchEvent(new CompositionEvent('compositionupdate', { data: 'あ', bubbles: true }));
      type(view2, 'a');
    });
    // 計測が無効なら（なければ）、描画を要求しない。
    expect(disabled).toBe(0);
    expect(absent).toBe(0);
  });

  it('a keydown seen while disabled is not counted when it is enabled before the update', () => {
    const r = recordingPerf(false);
    const view = mount(r.perf);
    keydown(view, 'a');
    r.setEnabled(true);
    type(view, 'a');
    expect(r.records).toEqual([]);
  });

  it('destroy removes the probe: no listener stays on the editor and a pending frame is dropped', () => {
    const r = recordingPerf();
    const view = mount(r.perf);
    const dom = view.dom;
    adapter.destroy();
    const before = frameRequests;
    dom.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }));
    expect(frameRequests).toBe(before);
    expect(r.records).toEqual([]);
  });
});

describe('document stats', () => {
  it('reports the length and the number of lines without reading the text elsewhere', () => {
    const r = recordingPerf();
    const view = mount(r.perf);
    expect(adapter.getDocumentStats()).toEqual({ chars: 0, lines: 1 });
    type(view, 'ab\ncd\n');
    expect(adapter.getDocumentStats()).toEqual({ chars: 6, lines: 3 });
  });

  it('works before mount (the initial text)', () => {
    adapter = createCodeMirrorAdapter([], undefined, null);
    adapter.setText('x\ny');
    expect(adapter.getDocumentStats()).toEqual({ chars: 3, lines: 2 });
  });
});
