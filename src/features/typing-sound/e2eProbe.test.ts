// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { createTypingSoundE2EProbe } from './e2eProbe';

afterEach(() => {
  delete window.__mdeE2ETypingSound;
});

describe('the e2e probe (counting sound requests)', () => {
  it('publishes an empty probe at creation, so "zero" can be told from "no probe"', () => {
    createTypingSoundE2EProbe();
    expect(window.__mdeE2ETypingSound).toEqual({ fetches: 0, fetchedTimbres: [], contexts: 0, decoded: 0, decodedTimbres: [], decodedOffsets: {}, decodedCount: 0, requests: [] });
  });

  it('counts fetches, contexts, decodes, and one request per sound event, with the timbre, offset, start delay and latencies', () => {
    const observe = createTypingSoundE2EProbe();
    observe({ type: 'fetch', timbre: 'keyboard', urls: 10 });
    observe({ type: 'context' });
    observe({ type: 'decoded', timbre: 'keyboard', count: 2, offsets: [0.035, 0] });
    observe({ type: 'fetch', timbre: 'typewriter', urls: 8 });
    observe({ type: 'decoded', timbre: 'typewriter', count: 8, offsets: [0.002, 0.005] });
    observe({ type: 'sound', kind: 'enter', timbre: 'keyboard', index: 3, rate: 0.8, gain: 0.5, offset: 0.053, startDelayMs: 0.2, baseLatency: 0.01, outputLatency: null });
    observe({ type: 'sound', kind: 'key', timbre: 'typewriter', index: 4, rate: 1, gain: 0.575, offset: 0, startDelayMs: 0.1, baseLatency: null, outputLatency: 0.02 });
    expect(window.__mdeE2ETypingSound).toEqual({
      fetches: 2,
      fetchedTimbres: ['keyboard', 'typewriter'],
      contexts: 1,
      decoded: 2,
      decodedTimbres: ['keyboard', 'typewriter'],
      decodedOffsets: { keyboard: [0.035, 0], typewriter: [0.002, 0.005] },
      decodedCount: 8,
      requests: [
        { kind: 'enter', timbre: 'keyboard', index: 3, rate: 0.8, gain: 0.5, offset: 0.053, startDelayMs: 0.2, baseLatency: 0.01, outputLatency: null },
        { kind: 'key', timbre: 'typewriter', index: 4, rate: 1, gain: 0.575, offset: 0, startDelayMs: 0.1, baseLatency: null, outputLatency: 0.02 },
      ],
    });
  });
});
