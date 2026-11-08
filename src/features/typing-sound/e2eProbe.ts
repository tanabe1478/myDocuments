import type { TypingSoundEvent } from './player';

/**
 * e2e のビルド（VITE_E2E=1）だけが使う、音の要求の数え方（観測用）。呼び出しは index.ts の __E2E__ の中にあり、
 * 本番の dist には入らない（印の文字列 __mdeE2ETypingSound が dist に出ないことを、check-probe-absent.mjs と architecture のテストが見る）。
 * 実際の音は鳴らさない確認のため、数えるのは「鳴らす要求を出した」ところまで（Playwright の chromium は --mute-audio で起動する）。
 */
export interface TypingSoundE2EProbe {
  /** 素材の fetch を始めた回数（設定がオフの間は 0）。 */
  fetches: number;
  /** AudioContext を作った回数（設定がオフの間は 0）。 */
  contexts: number;
  /** 素材のデコードが終わった回数と、読めた素材の数。 */
  decoded: number;
  decodedCount: number;
  /** 音の要求（1 キーにつき最大 1 つ）。 */
  requests: Array<{ kind: string; index: number; rate: number; gain: number }>;
}

declare global {
  interface Window {
    __mdeE2ETypingSound?: TypingSoundE2EProbe;
  }
}

export function createTypingSoundE2EProbe(): (event: TypingSoundEvent) => void {
  const probe: TypingSoundE2EProbe = { fetches: 0, contexts: 0, decoded: 0, decodedCount: 0, requests: [] };
  window.__mdeE2ETypingSound = probe;
  return (event) => {
    if (event.type === 'fetch') probe.fetches += 1;
    else if (event.type === 'context') probe.contexts += 1;
    else if (event.type === 'decoded') {
      probe.decoded += 1;
      probe.decodedCount = event.count;
    } else probe.requests.push({ kind: event.kind, index: event.index, rate: event.rate, gain: event.gain });
  };
}
