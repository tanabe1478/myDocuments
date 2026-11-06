import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDocumentFeed, DOCUMENT_DEBOUNCE_MS, SELECTION_THROTTLE_MS } from './documentFeed';

// R7: 本文を部品に届ける時機。入力が止まった後（後ろ寄せ）、文書の切り替えはすぐ、変換中は確定の後、カーソルの位置は間引く。

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function setup(initial: { text: string; kind: 'markdown' | 'plain' } = { text: '', kind: 'markdown' }) {
  let composing = false;
  let selection = { anchor: 0, head: 0 };
  const published: Array<{ document: { version: number; kind: string; text: string }; selection: { version: number; anchor: number; head: number } }> = [];
  const selections: Array<{ version: number; anchor: number; head: number }> = [];
  const feed = createDocumentFeed(
    {
      publish: (document, sel) => void published.push({ document, selection: sel }),
      publishSelection: (sel) => void selections.push(sel),
      isComposing: () => composing,
      getSelection: () => selection,
    },
    initial,
  );
  return {
    feed,
    published,
    selections,
    setComposing: (v: boolean) => (composing = v),
    setSelection: (anchor: number, head = anchor) => (selection = { anchor, head }),
  };
}

describe('typing: after the input stops (200 ms), once', () => {
  it('waits until the input has been quiet for 200 ms, and restarts the wait on every key', () => {
    expect(DOCUMENT_DEBOUNCE_MS).toBe(200);
    const t = setup();
    t.feed.typed('a');
    vi.advanceTimersByTime(150);
    t.feed.typed('ab');
    vi.advanceTimersByTime(150);
    t.feed.typed('abc');
    vi.advanceTimersByTime(199);
    expect(t.published).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(t.published).toHaveLength(1);
    expect(t.published[0]!.document).toEqual({ version: 3, kind: 'markdown', text: 'abc' });
  });

  it('counts a version for every change, delivered or not; a text that did not change is not a new version', () => {
    const t = setup();
    t.feed.typed('a');
    t.feed.typed('a');
    expect(t.feed.version).toBe(1);
    t.feed.typed('ab');
    expect(t.feed.version).toBe(2);
  });

  it('the sync that follows typed (the controller state catching up) is not a change and does not send early', () => {
    const t = setup();
    t.feed.typed('a');
    t.feed.sync('a', 'markdown');
    vi.advanceTimersByTime(50);
    expect(t.published).toEqual([]);
    expect(t.feed.version).toBe(1);
  });

  it('includes the selection at the time of sending, with the document version', () => {
    const t = setup();
    t.feed.typed('abc');
    t.setSelection(3);
    vi.advanceTimersByTime(200);
    expect(t.published[0]!.selection).toEqual({ version: 1, anchor: 3, head: 3 });
  });
});

describe('opening, switching, reloading and a kind change: at once', () => {
  it('sends a different document without the typing wait (the next task), and a different kind of the same text', () => {
    const t = setup({ text: 'a', kind: 'markdown' });
    t.feed.sync('other document', 'markdown');
    vi.advanceTimersByTime(0);
    expect(t.published).toHaveLength(1);
    expect(t.published[0]!.document).toEqual({ version: 1, kind: 'markdown', text: 'other document' });
    t.feed.sync('other document', 'plain');
    vi.advanceTimersByTime(0);
    expect(t.published).toHaveLength(2);
    expect(t.published[1]!.document).toEqual({ version: 2, kind: 'plain', text: 'other document' });
  });

  it('a switch while a typing wait is pending sends the new document once, and not the typed text afterwards', () => {
    const t = setup();
    t.feed.typed('typing');
    t.feed.sync('opened', 'markdown');
    vi.advanceTimersByTime(1000);
    expect(t.published.map((p) => p.document.text)).toEqual(['opened']);
  });

  it('does not send when nothing changed', () => {
    const t = setup({ text: 'a', kind: 'markdown' });
    t.feed.sync('a', 'markdown');
    vi.advanceTimersByTime(1000);
    expect(t.published).toEqual([]);
  });
});

describe('IME: nothing is sent during composition', () => {
  it('holds the document while composing, and sends it after the composition ends', () => {
    const t = setup();
    t.setComposing(true);
    t.feed.typed('あ');
    vi.advanceTimersByTime(200);
    vi.advanceTimersByTime(2000);
    expect(t.published).toEqual([]);
    t.feed.typed('あい');
    vi.advanceTimersByTime(2000);
    expect(t.published).toEqual([]);
    t.setComposing(false);
    vi.advanceTimersByTime(60);
    expect(t.published).toHaveLength(1);
    expect(t.published[0]!.document.text).toBe('あい');
  });

  it('holds a switch and a flush during composition as well', () => {
    const t = setup();
    t.setComposing(true);
    t.feed.sync('opened', 'markdown');
    t.feed.flush();
    vi.advanceTimersByTime(500);
    expect(t.published).toEqual([]);
    t.setComposing(false);
    vi.advanceTimersByTime(60);
    expect(t.published.map((p) => p.document.text)).toEqual(['opened']);
  });
});

describe('the selection is throttled and travels with the document', () => {
  it('sends the latest position once per 100 ms', () => {
    expect(SELECTION_THROTTLE_MS).toBe(100);
    const t = setup();
    t.setSelection(1);
    t.feed.selectionChanged();
    t.setSelection(2);
    t.feed.selectionChanged();
    t.setSelection(3);
    t.feed.selectionChanged();
    vi.advanceTimersByTime(99);
    expect(t.selections).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(t.selections).toEqual([{ version: 0, anchor: 3, head: 3 }]);
    t.setSelection(4);
    t.feed.selectionChanged();
    vi.advanceTimersByTime(100);
    expect(t.selections).toHaveLength(2);
  });

  it('does not send alone while a document is waiting to be sent or during composition (the document carries it)', () => {
    const t = setup();
    t.feed.typed('a');
    t.setSelection(1);
    t.feed.selectionChanged();
    vi.advanceTimersByTime(100);
    expect(t.selections).toEqual([]);
    vi.advanceTimersByTime(100);
    expect(t.published).toHaveLength(1);
    expect(t.published[0]!.selection.anchor).toBe(1);
    // 変換中。
    t.setComposing(true);
    t.feed.selectionChanged();
    vi.advanceTimersByTime(300);
    expect(t.selections).toEqual([]);
  });
});

describe('flush and dispose', () => {
  it('flush sends the latest at once (not waiting for the typing wait), even if nothing is pending', () => {
    const t = setup({ text: 'x', kind: 'plain' });
    t.feed.flush();
    expect(t.published).toHaveLength(1);
    expect(t.published[0]!.document).toEqual({ version: 0, kind: 'plain', text: 'x' });
    t.feed.typed('xy');
    t.feed.flush();
    expect(t.published).toHaveLength(2);
    vi.advanceTimersByTime(1000);
    expect(t.published).toHaveLength(2);
  });

  it('dispose cancels everything that is pending', () => {
    const t = setup();
    t.feed.typed('a');
    t.feed.selectionChanged();
    t.feed.dispose();
    vi.advanceTimersByTime(1000);
    expect(t.published).toEqual([]);
    expect(t.selections).toEqual([]);
    t.feed.typed('b');
    t.feed.flush();
    vi.advanceTimersByTime(1000);
    expect(t.published).toEqual([]);
  });
});
