import { describe, expect, it } from 'vitest';
import { ONSET_LEAD_SECONDS, ONSET_THRESHOLD_RATIO, onsetOffsetSeconds } from './onset';

const SR = 1000; // 1 標本 = 1 ms（計算を見やすくするため）

const wave = (frames: number, points: Record<number, number>): Float32Array => {
  const out = new Float32Array(frames);
  for (const [i, v] of Object.entries(points)) out[Number(i)] = v;
  return out;
};

describe('onsetOffsetSeconds', () => {
  it('uses 10% of the peak and 2 ms before', () => {
    expect(ONSET_THRESHOLD_RATIO).toBe(0.1);
    expect(ONSET_LEAD_SECONDS).toBe(0.002);
  });

  it('is the first point above 10% of the peak, minus 2 ms', () => {
    // 最大値 1.0 → 閾値 0.1。0.05 は超えない。0.2 が最初に超える点（40 ms）。2 ms 前で 38 ms。
    const x = wave(200, { 10: 0.05, 40: 0.2, 45: 1 });
    expect(onsetOffsetSeconds([x], SR)).toBeCloseTo(0.038, 12);
  });

  it('needs to exceed 10% (equal to the threshold does not count)', () => {
    // Float32 では 0.1 が 0.1 より少し大きくなるので、倍精度の配列で確かめる。
    const x = Array.from({ length: 100 }, (_, i) => (i === 20 ? 0.1 : i === 30 ? 1 : 0));
    expect(onsetOffsetSeconds([x], SR)).toBeCloseTo(0.028, 12);
  });

  it('uses the absolute value (a negative swing counts)', () => {
    const x = wave(100, { 25: -0.5, 60: 0.9 });
    expect(onsetOffsetSeconds([x], SR)).toBeCloseTo(0.023, 12);
  });

  it('is 0 for a file with no leading silence', () => {
    expect(onsetOffsetSeconds([wave(100, { 0: 0.9, 10: 1 })], SR)).toBe(0);
  });

  it('never goes below 0: an onset within 2 ms of the head starts at 0', () => {
    expect(onsetOffsetSeconds([wave(100, { 1: 1 })], SR)).toBe(0);
    expect(onsetOffsetSeconds([wave(100, { 2: 1 })], SR)).toBe(0);
    expect(onsetOffsetSeconds([wave(100, { 3: 1 })], SR)).toBeCloseTo(0.001, 12);
  });

  it('is 0 for an all-silent file, and for no samples or no channels', () => {
    expect(onsetOffsetSeconds([new Float32Array(500)], SR)).toBe(0);
    expect(onsetOffsetSeconds([new Float32Array(0)], SR)).toBe(0);
    expect(onsetOffsetSeconds([], SR)).toBe(0);
  });

  it('handles 1 channel, 2 channels and more: the loudest channel at each point decides, the peak is over all channels', () => {
    // 左は 30 ms に小さな音（0.3）、右は 50 ms に大きな音（1.0）。最大値は右の 1.0 → 閾値 0.1。0.3 > 0.1 なので 30 ms が立ち上がり。
    const left = wave(200, { 30: 0.3 });
    const right = wave(200, { 50: 1 });
    expect(onsetOffsetSeconds([left, right], SR)).toBeCloseTo(0.028, 12);
    // 左だけが立ち上がっても、最大値が右にあるので、閾値は右の最大値で決まる（左の 0.05 は 0.1 を超えない）。
    expect(onsetOffsetSeconds([wave(200, { 30: 0.05 }), right], SR)).toBeCloseTo(0.048, 12);
    // 3 チャンネル。
    expect(onsetOffsetSeconds([wave(200, {}), wave(200, { 80: 0.5 }), wave(200, { 60: 0.5 })], SR)).toBeCloseTo(0.058, 12);
    // 1 チャンネルと同じ波形を 2 チャンネルに並べても、位置は変わらない。
    const mono = wave(200, { 70: 0.4, 90: 0.8 });
    expect(onsetOffsetSeconds([mono, mono], SR)).toBe(onsetOffsetSeconds([mono], SR));
  });

  it('tolerates channels of different lengths', () => {
    expect(onsetOffsetSeconds([wave(10, {}), wave(100, { 40: 1 })], SR)).toBeCloseTo(0.038, 12);
  });

  it('ignores NaN samples, and returns 0 for a bad sample rate', () => {
    const x = wave(100, { 20: Number.NaN, 50: 1 });
    expect(onsetOffsetSeconds([x], SR)).toBeCloseTo(0.048, 12);
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) expect(onsetOffsetSeconds([wave(100, { 50: 1 })], bad), String(bad)).toBe(0);
  });

  it('converts the sample index to seconds with the sample rate', () => {
    const x = wave(48000, { 1440: 1 }); // 30 ms（48 kHz）
    expect(onsetOffsetSeconds([x], 48000)).toBeCloseTo(0.028, 12);
  });

  it('works on plain arrays', () => {
    expect(onsetOffsetSeconds([[0, 0, 0, 0, 0, 1, 0]], SR)).toBeCloseTo(0.003, 12);
  });
});
