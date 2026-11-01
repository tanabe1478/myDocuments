// 2 つの結果 JSON の「悪化」の判定。perf/compare.mjs が使い、perf/test/judge.test.mjs が検査する。
//
// 判定の式（項目ごと、中央値と p95 のそれぞれ）:
//   delta = 悪化方向の差（better が lower なら new - base、higher なら base - new）
//   悪化 = delta / |base| >= 20%  かつ  delta > K × noise  かつ  delta >= 単位ごとの下限（FLOOR）
//   K = 3 × max(1, sqrt(20 / n))（n は base と new の標本数の小さいほう）。標本が 20 件未満だと揺れの推定自体が不安定なので、件数が少ないほど大きくする
//     （n = 15 で 3.5、10 で 4.2、5 で 6、3 で 7.7）。quick の遅延なしどうしの比較で、MAD が 0 になる 3 件の標本が悪化と出たため。
//   noise: 標本（item.samples）から求める統計量のぶれ。次の 2 つの大きいほうを、base と new の両方で求めて大きいほうを使う。
//     MAD 由来: sigma = 1.4826 × MAD（中央絶対偏差。正規分布なら標準偏差に一致する。標本の中心の幅）
//     ブートストラップ由来: 標本を、実行順に連続した ceil(sqrt(n)) 件のブロックごとに復元抽出し直して（400 回、固定シード）その統計量（中央値または p95）を求め直したときの標準偏差。
//       MAD は分布の中心の幅しか見ないので、二峰の分布（フレームに量子化された遅延は 0〜3ms と約 16ms の 2 つの山になる。
//       中央値がどちらの山に落ちるかで 3ms と 15ms の間を動く）や、少数の外れ値が p95 を動かす分布（docio）のぶれを過小評価する。
//       遅い反復は時間的に固まって出る（OS の負荷の山）ので、1 件ずつではなくブロックで抽出する。同じコードの 2 回の基準値で、MAD だけだと悪化が 6 件出た（docs/perf-baseline.md の「悪化の判定」）。
//     どちらも標本が決める量で、悪化による位置の移動は含まない（new の裾の広さを揺れに入れると悪化が吸収されるので、裾は使わない）。
//   p95 の悪化は、同じ項目の中央値も悪化と判定されたときだけ悪化に数える。中央値が動かない p95 だけの悪化は「p95 だけ」として別に出し、
//   exit には効かせない。同じコードの 2 回で、中央値は動かないのに p95 だけが 50〜180% 動く項目が 5 件あった（遅い反復は OS の負荷で
//   時間的に固まって出て、その量は 1 回ごとに違う。1 回の標本の中からはこの回間の違いを推定できず、MAD もブロックブートストラップも足りない）。
//   限界: 裾だけが悪化して中央値が動かない変更は、exit では検出できない（出力には残る）。
//   標本が 3 件未満の項目（cold など）は判定しない。「参考（判定対象外）」として別に出す。
//   p95 は両方の標本が 40 件以上のときだけ判定する（20 件では p95 が上から 2 番目の値になり、1 件の外れ値で動く）。
//   FLOOR（量子化の最小単位や計時分解能に相当する小さな値だけ）:
//     単位の既定: ms 2（webkit の performance.now は 1ms 刻み）、MiB 2、bytes 4096、frames 2
//     docio（Rust の Instant。ns 精度で 1 回が 1ms 未満）: 0.002ms
//     Web UI のフレームに量子化された遅延（typing、ime、open、mode、scroll）の p95: 17ms（60Hz の 1 フレーム）
//   標本が無い古い結果 JSON（samples が無い項目）との比較は、従来の固定の下限（LEGACY_FLOOR）で判定し、legacy として別に数える。
//     加えて、結果に残っている p95 と中央値から裾の広さ (p95 - 中央値) / 1.645 を揺れの代用にして、差がその 3 倍を超えることも求める
//     （標本が無くても、1 回の計測の中の広がりは p95 に残っている。これが無いと、1 回目だけが外れ値だった docio の項目が悪化になる）。
//   size（配布物のバイト数）と frames（回数）は標本の揺れが無い決定的な値なので、割合と FLOOR だけで判定する。
export const DEFAULTS = { threshold: 0.2, sigmaK: 3, minN: 3, minNForP95: 40 };

const MAD_TO_SIGMA = 1.4826;
const P95_Z = 1.645;

const FLOOR_BY_UNIT = { ms: 2, MiB: 2, bytes: 4096, frames: 2 };
const FLOOR_BY_GROUP = { docio: 0.002 };
// Web UI のフレームに量子化される遅延の p95 の下限（1 フレーム）。中央値には掛けない（中央値は標本の揺れで判定する）。
const FRAME_QUANTIZED = new Set(['web', 'typing', 'ime', 'open', 'mode', 'scroll']);
const FRAME_P95_FLOOR = 17;

// 標本が無い古い結果 JSON のための、従来の固定の下限（Run 7 の compare.mjs と同じ値）。
const LEGACY_FLOOR_BY_GROUP = { web: 17, typing: 17, ime: 17, open: 17, mode: 17, scroll: 17, startup: 20, memory: 3, docio: 0.5, size: 4096 };
const LEGACY_MEDIAN_FLOOR_BY_GROUP = { web: 10, typing: 10, ime: 10, open: 10, mode: 10, scroll: 10 };

export function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length === 0 ? NaN : s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** 標本の揺れの大きさ（1.4826 × MAD）。 */
export function sigmaOf(samples) {
  const m = median(samples);
  return MAD_TO_SIGMA * median(samples.map((x) => Math.abs(x - m)));
}

const numbers = (xs) => (Array.isArray(xs) ? xs.filter((x) => typeof x === 'number' && Number.isFinite(x)) : []);

/** 標本の件数。samples があればその件数、無ければ n。どちらも無ければ null。 */
export function sampleCount(item) {
  const s = numbers(item.samples);
  if (s.length > 0) return s.length;
  return typeof item.n === 'number' ? item.n : null;
}

/** size と frames は決定的な値（標本の揺れが無い）。 */
export const isFixed = (item) => item.group === 'size' || item.unit === 'frames';

export function floorFor(item, stat) {
  if (stat === 'p95' && FRAME_QUANTIZED.has(item.group)) return FRAME_P95_FLOOR;
  return FLOOR_BY_GROUP[item.group] ?? FLOOR_BY_UNIT[item.unit] ?? 0;
}

export function legacyFloorFor(item, stat) {
  return (stat === 'median' ? LEGACY_MEDIAN_FLOOR_BY_GROUP[item.group] : undefined) ?? LEGACY_FLOOR_BY_GROUP[item.group] ?? FLOOR_BY_UNIT[item.unit] ?? 0;
}

/** 裾の広さからの揺れ（sigma 換算）。p95 と中央値が無ければ null。 */
export function tailSigma(item) {
  return typeof item.p95 === 'number' && typeof item.median === 'number' ? Math.max(0, item.p95 - item.median) / P95_Z : null;
}

const BOOTSTRAP_ROUNDS = 400;

/** 固定シードの疑似乱数（mulberry32）。同じ入力に同じ判定を返すため。 */
function rng(seed) {
  let t = seed >>> 0;
  return () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let x = t;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

const quantileOf = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))];

/**
 * 標本から統計量（median は p50、p95 は p95。どちらも nearest-rank）を求め直したときの標準偏差（ブロックブートストラップ）。
 * 標本は実行順に並んでいる。遅い反復は時間的に固まって出る（OS の負荷の山。同じコードの 2 回で、片方だけ連続して遅かった）ので、
 * 1 件ずつの復元抽出ではなく、実行順に連続した ceil(sqrt(n)) 件のブロックを単位に復元抽出する（標本が互いに独立だという仮定を置かない）。
 */
export function bootstrapSE(samples, stat) {
  const n = samples.length;
  if (n < 2) return 0;
  const rand = rng(0x9e3779b9 ^ n);
  const p = stat === 'p95' ? 0.95 : 0.5;
  const est = [];
  const L = Math.min(n, Math.ceil(Math.sqrt(n)));
  const buf = new Array(n);
  for (let r = 0; r < BOOTSTRAP_ROUNDS; r++) {
    for (let i = 0; i < n; ) {
      const start = Math.floor(rand() * (n - L + 1));
      for (let k = 0; k < L && i < n; k++) buf[i++] = samples[start + k];
    }
    est.push(quantileOf(buf.slice().sort((a, b) => a - b), p));
  }
  const mean = est.reduce((a, b) => a + b, 0) / est.length;
  return Math.sqrt(est.reduce((a, b) => a + (b - mean) ** 2, 0) / (est.length - 1));
}

/** 1 つの結果の、統計 stat の揺れ（標準偏差換算）。標本があれば MAD とブートストラップの大きいほう。無ければ裾の広さから。どちらも無ければ null。 */
export function noiseOf(item, stat) {
  const s = numbers(item.samples);
  return s.length === 0 ? tailSigma(item) : Math.max(sigmaOf(s), bootstrapSE(s, stat));
}

/** 揺れに掛ける係数。標本が 20 件未満のときは件数に応じて大きくする。 */
export function sigmaFor(sigmaK, n) {
  return sigmaK * Math.max(1, Math.sqrt(20 / n));
}

/** base と new の揺れから、判定に使う揺れを求める（大きいほう）。 */
export function noiseBetween(b, n, stat) {
  return Math.max(0, ...[noiseOf(b, stat), noiseOf(n, stat)].filter((x) => x !== null));
}

/**
 * 1 項目の 1 つの統計を判定する。戻り値: { verdict, ... }。
 * verdict: 'regression' | 'ignored'（20% は超えたが揺れか下限の内）| 'improved' | 'ok' | 'reference' | 'skip'
 * mode: 'noise'（標本の揺れで判定）| 'fixed'（決定的な値）| 'legacy'（標本なし。従来の下限）
 */
export function judgeStat(b, n, stat, options = {}) {
  const { threshold, sigmaK, minN, minNForP95 } = { ...DEFAULTS, ...options };
  const bv = b[stat];
  const nv = n[stat];
  if (typeof bv !== 'number' || typeof nv !== 'number') return { verdict: 'skip' };
  const higherIsBetter = n.better === 'higher';
  const delta = higherIsBetter ? bv - nv : nv - bv; // 正なら悪化
  const ratio = bv === 0 ? (delta > 0 ? Infinity : 0) : delta / Math.abs(bv);
  const row = { id: n.id, stat, unit: n.unit, group: n.group, base: bv, next: nv, delta, ratio };
  const bn = sampleCount(b);
  const nn = sampleCount(n);

  if (isFixed(n)) {
    return finish({ ...row, mode: 'fixed' }, ratio >= threshold && Math.abs(nv - bv) >= floorFor(n, stat), ratio, threshold);
  }
  if (stat === 'p95') {
    // p95 の標本数の条件。足りなければ比べない（legacy でも同じ。標本の無い古い結果は n で見る）。
    if (!(Math.min(bn ?? 0, nn ?? 0) >= minNForP95)) return { verdict: 'skip' };
  }
  if ((bn !== null && bn < minN) || (nn !== null && nn < minN)) {
    return { ...row, verdict: 'reference', mode: 'reference', n: { base: bn, next: nn } };
  }
  const hasBase = numbers(b.samples).length > 0;
  const hasNew = numbers(n.samples).length > 0;
  if (!hasBase || !hasNew) {
    const floor = legacyFloorFor(n, stat);
    const noise = noiseBetween(b, n, stat);
    return finish({ ...row, mode: 'legacy', floor, noise }, ratio >= threshold && delta > sigmaK * noise && Math.abs(nv - bv) >= floor, ratio, threshold);
  }
  const noise = noiseBetween(b, n, stat);
  const floor = floorFor(n, stat);
  const k = sigmaFor(sigmaK, Math.min(bn, nn));
  const bad = ratio >= threshold && delta > k * noise && Math.abs(nv - bv) >= floor;
  return finish({ ...row, mode: 'noise', noise, k, floor }, bad, ratio, threshold);
}

function finish(row, bad, ratio, threshold) {
  if (bad) return { ...row, verdict: 'regression' };
  if (ratio >= threshold) return { ...row, verdict: 'ignored' };
  if (ratio <= -threshold) return { ...row, verdict: 'improved' };
  return { ...row, verdict: 'ok' };
}

/** 2 つの結果 JSON を比べる。 */
export function compareResults(base, next, options = {}) {
  const baseItems = new Map((base.items ?? []).map((i) => [i.id, i]));
  const out = { rows: [], tailOnly: [], regressions: [], ignored: [], improved: [], reference: [], onlyNew: [], onlyBase: [], unusable: [], legacyItems: [], compared: 0 };
  for (const n of next.items ?? []) {
    const b = baseItems.get(n.id);
    baseItems.delete(n.id);
    if (!b) {
      out.onlyNew.push(n.id);
      continue;
    }
    if (b.status !== 'ok' || n.status !== 'ok') {
      out.unusable.push(`${n.id}（base: ${b.status}, new: ${n.status}）`);
      continue;
    }
    let legacy = false;
    const judged = [];
    for (const stat of ['median', 'p95']) {
      const r = judgeStat(b, n, stat, options);
      if (r.verdict === 'skip') continue;
      if (r.verdict === 'reference') {
        // 参考は、中央値の 1 行だけ出す（p95 は n<3 では元々比べない）。
        if (stat === 'median') out.reference.push(r);
        continue;
      }
      judged.push(r);
    }
    const medianRegressed = judged.some((r) => r.stat === 'median' && r.verdict === 'regression');
    for (const r of judged) {
      out.rows.push(r);
      out.compared++;
      if (r.mode === 'legacy') legacy = true;
      if (r.verdict === 'regression' && r.stat === 'p95' && !medianRegressed && !isFixed(n)) out.tailOnly.push(r);
      else if (r.verdict === 'regression') out.regressions.push(r);
      else if (r.verdict === 'ignored') out.ignored.push(r);
      else if (r.verdict === 'improved') out.improved.push(r);
    }
    if (legacy) out.legacyItems.push(n.id);
  }
  out.onlyBase = [...baseItems.keys()];
  return out;
}
