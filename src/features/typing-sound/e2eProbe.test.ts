// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { createTypingSoundE2EProbe } from './e2eProbe';

afterEach(() => {
  delete window.__mdeE2ETypingSound;
});

describe('the e2e probe (counting sound requests)', () => {
  it('publishes an empty probe at creation, so "zero" can be told from "no probe"', () => {
    createTypingSoundE2EProbe();
    expect(window.__mdeE2ETypingSound).toEqual({ fetches: 0, contexts: 0, decoded: 0, decodedCount: 0, requests: [] });
  });

  it('counts fetches, contexts, decodes, and one request per sound event', () => {
    const observe = createTypingSoundE2EProbe();
    observe({ type: 'fetch', urls: 10 });
    observe({ type: 'context' });
    observe({ type: 'decoded', count: 10 });
    observe({ type: 'sound', kind: 'enter', index: 3, rate: 0.8, gain: 0.5 });
    observe({ type: 'sound', kind: 'key', index: 4, rate: 1, gain: 0.5 });
    expect(window.__mdeE2ETypingSound).toEqual({
      fetches: 1,
      contexts: 1,
      decoded: 1,
      decodedCount: 10,
      requests: [
        { kind: 'enter', index: 3, rate: 0.8, gain: 0.5 },
        { kind: 'key', index: 4, rate: 1, gain: 0.5 },
      ],
    });
  });
});
