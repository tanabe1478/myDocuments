/**
 * 鳴り始めの位置。素材の頭には無音（キーボードの素材では 3 ms から 55 ms、ばらつきも大きい）があり、頭から鳴らすと、その分だけ
 * 打鍵より音が遅れる。デコードしたあと、素材ごとに「振幅が最大値の 10% を最初に超える点の 2 ms 前」を求め、そこから鳴らす
 * （source.start(0, offset)）。素材のファイル（バイト列）は変えない。
 */

/** 最大値のこの割合を最初に超えた点を、音の立ち上がりとみなす。 */
export const ONSET_THRESHOLD_RATIO = 0.1;
/** 立ち上がりより、この秒数だけ前から鳴らす（打撃の出だしを削らないため）。 */
export const ONSET_LEAD_SECONDS = 0.002;

/**
 * 鳴り始めの位置（秒、0 以上）。channels は、各チャンネルの標本（1ch でも 2ch 以上でもよい。長さが違ってもよい）。
 * 振幅は、どのチャンネルでも、その点で最も大きい絶対値で見る。最大値は全チャンネルを通した最大の絶対値。
 * 無音だけ（最大値が 0）、標本がない、標本化周波数が正の有限の数でないときは 0（頭から鳴らす）。
 * 数でない標本（NaN）は無視する。
 */
export function onsetOffsetSeconds(channels: readonly ArrayLike<number>[], sampleRate: number): number {
  if (!(Number.isFinite(sampleRate) && sampleRate > 0)) return 0;
  let peak = 0;
  let frames = 0;
  for (const channel of channels) {
    frames = Math.max(frames, channel.length);
    for (let i = 0; i < channel.length; i++) {
      const v = Math.abs(channel[i] as number);
      if (v > peak) peak = v;
    }
  }
  if (!(peak > 0) || !Number.isFinite(peak)) return 0;
  const threshold = peak * ONSET_THRESHOLD_RATIO;
  for (let i = 0; i < frames; i++) {
    for (const channel of channels) {
      if (i < channel.length && Math.abs(channel[i] as number) > threshold) return Math.max(0, i / sampleRate - ONSET_LEAD_SECONDS);
    }
  }
  return 0;
}
