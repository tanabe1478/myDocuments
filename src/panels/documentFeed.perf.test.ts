import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PluginPerf } from '../plugin-api';
import { createDocumentFeed, DOCUMENT_DEBOUNCE_MS } from './documentFeed';

// R16: 本文を部品に届ける処理（publish）の所要時間を、区間 feed.publish として数える。

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function recordingPerf(enabled = true) {
  const spans: string[] = [];
  const ended: string[] = [];
  const perf: PluginPerf = {
    enabled,
    span: (name) => {
      spans.push(name);
      return () => void ended.push(name);
    },
    measure: (_n, fn) => fn(),
    record: () => {},
  };
  return { perf, spans, ended };
}

function feedWith(perf: PluginPerf | undefined, publish: () => void = () => {}) {
  return createDocumentFeed(
    { publish, publishSelection: () => {}, isComposing: () => false, getSelection: () => ({ anchor: 0, head: 0 }), ...(perf ? { perf } : {}) },
    { text: '', kind: 'markdown' },
  );
}

describe('feed.publish', () => {
  it('counts the publish that follows typing (after the debounce), and the immediate publish of a sync', () => {
    const r = recordingPerf();
    const feed = feedWith(r.perf);
    feed.typed('a');
    expect(r.spans).toEqual([]);
    vi.advanceTimersByTime(DOCUMENT_DEBOUNCE_MS);
    expect(r.spans).toEqual(['feed.publish']);
    expect(r.ended).toEqual(['feed.publish']);
    feed.sync('opened', 'markdown');
    vi.advanceTimersByTime(0);
    feed.flush();
    expect(r.spans).toEqual(['feed.publish', 'feed.publish', 'feed.publish']);
  });

  it('ends the span even when publish throws', () => {
    const r = recordingPerf();
    const feed = feedWith(r.perf, () => {
      throw new Error('publish failed');
    });
    feed.typed('a');
    expect(() => vi.advanceTimersByTime(DOCUMENT_DEBOUNCE_MS)).toThrow('publish failed');
    expect(r.ended).toEqual(['feed.publish']);
  });

  it('does not count a composing wait (nothing is published) and works without perf', () => {
    const r = recordingPerf();
    let composing = true;
    const feed = createDocumentFeed(
      { publish: () => {}, publishSelection: () => {}, isComposing: () => composing, getSelection: () => ({ anchor: 0, head: 0 }), perf: r.perf },
      { text: '', kind: 'markdown' },
    );
    feed.typed('あ');
    vi.advanceTimersByTime(DOCUMENT_DEBOUNCE_MS);
    expect(r.spans).toEqual([]);
    composing = false;
    vi.advanceTimersByTime(1000);
    expect(r.spans).toEqual(['feed.publish']);
    const plain = feedWith(undefined);
    plain.typed('a');
    expect(() => vi.advanceTimersByTime(DOCUMENT_DEBOUNCE_MS)).not.toThrow();
  });
});
