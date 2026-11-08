import type { TypingSoundEvent } from './player';

/**
 * e2e のビルド（VITE_E2E=1）だけが使う、音の要求の数え方（観測用）。呼び出しは index.ts の __E2E__ の中にあり、
 * 本番の dist には入らない（印の文字列 __mdeE2ETypingSound が dist に出ないことを、check-probe-absent.mjs と architecture のテストが見る）。
 * 実際の音は鳴らさない確認のため、数えるのは「鳴らす要求を出した」ところまで（Playwright の chromium は --mute-audio で起動する）。
 */
export interface TypingSoundE2EProbe {
  /** 素材の fetch を始めた回数（設定がオフの間は 0。音色ごとに 1 回）。 */
  fetches: number;
  /** fetch を始めた音色（順）。 */
  fetchedTimbres: string[];
  /** AudioContext を作った回数（設定がオフの間は 0）。 */
  contexts: number;
  /** 素材のデコードが終わった回数と、その音色（順）、最後に読めた素材の数。 */
  decoded: number;
  decodedTimbres: string[];
  /** デコードした素材ごとの鳴り始めの位置（秒）。音色ごと、素材の並び順（読めなかったものは詰める）。 */
  decodedOffsets: Record<string, number[]>;
  decodedCount: number;
  /**
   * 音の要求（1 キーにつき最大 1 つ）。offset は source.start に渡した素材の中の位置（秒）、startDelayMs は keydown を受け取ってから
   * source.start を呼ぶ直前までの時間、baseLatency と outputLatency はその時の AudioContext の値（秒。無ければ null）。
   */
  requests: Array<{
    kind: string;
    timbre: string;
    index: number;
    rate: number;
    gain: number;
    offset: number;
    startDelayMs: number;
    baseLatency: number | null;
    outputLatency: number | null;
  }>;
}

declare global {
  interface Window {
    __mdeE2ETypingSound?: TypingSoundE2EProbe;
  }
}

export function createTypingSoundE2EProbe(): (event: TypingSoundEvent) => void {
  const probe: TypingSoundE2EProbe = { fetches: 0, fetchedTimbres: [], contexts: 0, decoded: 0, decodedTimbres: [], decodedOffsets: {}, decodedCount: 0, requests: [] };
  window.__mdeE2ETypingSound = probe;
  return (event) => {
    if (event.type === 'fetch') {
      probe.fetches += 1;
      probe.fetchedTimbres.push(event.timbre);
    } else if (event.type === 'context') probe.contexts += 1;
    else if (event.type === 'decoded') {
      probe.decoded += 1;
      probe.decodedTimbres.push(event.timbre);
      probe.decodedOffsets[event.timbre] = [...event.offsets];
      probe.decodedCount = event.count;
    } else {
      const { kind, timbre, index, rate, gain, offset, startDelayMs, baseLatency, outputLatency } = event;
      probe.requests.push({ kind, timbre, index, rate, gain, offset, startDelayMs, baseLatency, outputLatency });
    }
  };
}
