// perf/lib/judge.mjs と perf/compare.mjs の単体テスト（node --test）。作った標本で判定の境目を確かめる。
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { DEFAULTS, bootstrapSE, compareResults, judgeStat, median, noiseOf, sigmaOf } from '../lib/judge.mjs';

const COMPARE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'compare.mjs');

const q = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))];

/** 標本から item を作る（median と p95 は標本から求める）。 */
function mk(id, samples, extra = {}) {
  const s = [...samples].sort((a, b) => a - b);
  return { id, status: 'ok', better: 'lower', group: 'docio', unit: 'ms', n: s.length, median: q(s, 0.5), p95: q(s, 0.95), samples, ...extra };
}

/** 中央 center、振れ幅 spread の決定的な標本（n 件）。MAD = spread 前後になるよう等間隔に置く。 */
function spreadSamples(center, spread, n = 50) {
  return Array.from({ length: n }, (_, i) => center + spread * ((i / (n - 1)) * 2 - 1));
}

const judgeMedian = (b, n, options) => judgeStat(b, n, 'median', options);

test('sigmaOf: MAD を正規分布換算（1.4826 倍）する', () => {
  assert.equal(median([1, 2, 3, 4]), 2.5);
  // 中央値 5、絶対偏差 [2,1,0,1,2]→ MAD 1
  assert.ok(Math.abs(sigmaOf([3, 4, 5, 6, 7]) - 1.4826) < 1e-9);
  assert.equal(sigmaOf([5, 5, 5, 5]), 0);
});

test('20% と揺れの 3 倍の境目: 両方を満たしたときだけ悪化', () => {
  // 揺れ: 標本が 10±2（等間隔）→ MAD は約 1、sigma は約 1.5
  const base = mk('docio.x', spreadSamples(10, 2));
  const sigma = noiseOf(base, 'median');
  assert.ok(sigma > 1 && sigma < 2, `sigma=${sigma}`);
  const shifted = (d) => mk('docio.x', spreadSamples(10 + d, 2));

  // 20% 未満（+1.9 = +19%）: 揺れの 3 倍（約 4.5）も超えない
  assert.equal(judgeMedian(base, shifted(1.9)).verdict, 'ok');
  // 20% 以上だが揺れの 3 倍以内（+3 = +30%、3 sigma は約 4.5）: 無視
  assert.equal(judgeMedian(base, shifted(3)).verdict, 'ignored');
  // 20% 以上かつ揺れの 3 倍超（+6 = +60%）: 悪化
  assert.equal(judgeMedian(base, shifted(6)).verdict, 'regression');
  // 揺れの 3 倍は超えるが 20% 未満: 悪化でない（揺れが小さい標本）
  const tight = mk('docio.x', spreadSamples(100, 0.2));
  const tightShift = mk('docio.x', spreadSamples(110, 0.2)); // +10%、揺れの何十倍
  assert.equal(judgeMedian(tight, tightShift).verdict, 'ok');
  // 20% ちょうど（+2 = +20%）は閾値以上。揺れが小さければ悪化
  assert.equal(judgeMedian(tight, mk('docio.x', spreadSamples(120, 0.2))).verdict, 'regression');
});

test('揺れは両方の結果の大きいほうを使う', () => {
  const quiet = mk('docio.x', spreadSamples(10, 0.1));
  const noisy = mk('docio.x', spreadSamples(14, 6)); // +40% だが標本の揺れが大きい
  assert.equal(judgeMedian(quiet, noisy).verdict, 'ignored');
  assert.equal(judgeMedian(noisy, quiet).verdict, 'improved'); // 改善方向（悪化にならない）
});

test('単位ごとの下限: 揺れも割合も超えても、下限未満の差は悪化にしない', () => {
  // docio は 0.002ms。10µs 台の操作が 2 倍になっても 0.001ms 差なら無視
  const b = mk('docio.encode', spreadSamples(0.001, 0, 50));
  const n = mk('docio.encode', spreadSamples(0.002, 0, 50));
  assert.equal(judgeMedian(b, n).verdict, 'ignored');
  // 0.0035 ms 差なら悪化
  assert.equal(judgeMedian(b, mk('docio.encode', spreadSamples(0.0045, 0, 50))).verdict, 'regression');
  // ms の既定の下限 2ms（web.input-cpu、webkit の 1ms 刻みの 1 段の差は無視、2ms の差は検出）
  const cpuBase = mk('web.input-cpu.webkit.A.end', Array(30).fill(2), { group: 'input-cpu' });
  assert.equal(judgeMedian(cpuBase, mk('web.input-cpu.webkit.A.end', Array(30).fill(3), { group: 'input-cpu' })).verdict, 'ignored');
  assert.equal(judgeMedian(cpuBase, mk('web.input-cpu.webkit.A.end', Array(30).fill(5), { group: 'input-cpu' })).verdict, 'regression');
});

test('フレームに量子化された Web UI の中央値は、揺れが小さければ 3.5ms の悪化（7.1→10.6）を検出する', () => {
  const base = mk('web.typing.chromium.B.end', [...spreadSamples(7.1, 0.5, 90), ...Array(10).fill(19.9)], { group: 'typing' });
  const slow = mk('web.typing.chromium.B.end', [...spreadSamples(10.6, 0.5, 90), ...Array(10).fill(19.9)], { group: 'typing' });
  const r = judgeMedian(base, slow);
  assert.equal(r.verdict, 'regression');
  assert.equal(r.mode, 'noise');
});

test('p95: 標本が 40 件未満なら比べない。40 件以上なら比べる。Web UI のフレームの p95 は 17ms 未満の差を無視する', () => {
  // 滑らかな分布の標本（10±2 と 30±2）。n = 39 は比べず、n = 40 から比べる
  const smooth = (center, n) => mk('docio.x', spreadSamples(center, 2, n));
  const b39 = smooth(10, 39);
  const n39 = smooth(30, 39);
  assert.equal(b39.n, 39);
  assert.equal(judgeStat(b39, n39, 'p95').verdict, 'skip');
  const b40 = smooth(10, 40);
  const n40 = smooth(30, 40);
  assert.equal(b40.n, 40);
  assert.equal(judgeStat(b40, n40, 'p95').verdict, 'regression');
  // 片方が 40 件未満でも比べない
  assert.equal(judgeStat(b40, n39, 'p95').verdict, 'skip');
  // 20% 未満の差は悪化でない
  assert.equal(judgeStat(b40, smooth(11, 40), 'p95').verdict, 'ok');
  // フレームに量子化された p95: 1 フレーム未満（+16ms）の差は無視。1 フレーム以上（+18ms）は悪化
  const frame = (hi) => mk('web.typing.chromium.A.end', [...Array(75).fill(6), ...Array(25).fill(hi)], { group: 'typing' });
  assert.equal(judgeStat(frame(8), frame(24), 'p95').verdict, 'ignored'); // +16ms
  assert.equal(judgeStat(frame(8), frame(26), 'p95').verdict, 'regression'); // +18ms
});

test('標本が 3 件未満（cold）は判定せず参考にする。3 件からは判定する', () => {
  const cold = (v) => ({ id: 'tauri.startup.release.cold', status: 'ok', better: 'lower', group: 'startup', unit: 'ms', n: 1, median: v, samples: [v] });
  const r = judgeMedian(cold(700), cold(1400)); // +100%
  assert.equal(r.verdict, 'reference');
  const res = compareResults({ items: [cold(700)] }, { items: [cold(1400)] });
  assert.equal(res.regressions.length, 0);
  assert.equal(res.reference.length, 1);
  assert.equal(res.reference[0].id, 'tauri.startup.release.cold');
  // n = 2 もまだ参考。n = 3 で判定
  const warm = (xs) => mk('tauri.startup.release.warm', xs, { group: 'startup' });
  assert.equal(judgeMedian(warm([400, 400]), warm([800, 800])).verdict, 'reference');
  assert.equal(judgeMedian(warm([400, 400, 400]), warm([800, 800, 800])).verdict, 'regression');
  assert.equal(DEFAULTS.minN, 3);
});

test('標本が無い古い形式: 従来の固定の下限で判定し、裾の広さを揺れの代用にする。legacy として数える', () => {
  const old = (median, p95, extra = {}) => ({ id: 'docio.revision.D', status: 'ok', better: 'lower', group: 'docio', unit: 'ms', n: 50, median, p95, ...extra });
  // 従来の下限 0.5ms 未満は無視
  assert.equal(judgeMedian(old(0.1, 0.12), old(0.3, 0.32)).verdict, 'ignored');
  // 下限以上、20% 以上、裾が狭ければ悪化（従来どおり）
  const r = judgeMedian(old(1, 1.05), old(2, 2.05));
  assert.equal(r.verdict, 'regression');
  assert.equal(r.mode, 'legacy');
  // 同じ差でも、計測の中の広がり（p95 - 中央値）が大きければ揺れの範囲（Run 7 の docio.revision.D の形）
  assert.equal(judgeMedian(old(1.3, 2.5232), old(2.0776, 3.0581)).verdict, 'ignored');
  // 片方だけ標本があっても legacy（もう片方に揺れが無い）
  const withSamples = mk('docio.revision.D', spreadSamples(1, 0.01));
  assert.equal(judgeMedian(withSamples, old(2, 2.05)).mode, 'legacy');
  const res = compareResults({ items: [old(1, 1.05)] }, { items: [old(2, 2.05)] });
  assert.deepEqual(res.legacyItems, ['docio.revision.D']);
  assert.equal(res.regressions.length, 2); // 中央値と p95（n = 50 なので p95 も比べる）
});

test('決定的な値（size）は標本が 1 件でも、割合と下限で判定する', () => {
  const size = (v) => ({ id: 'size.release-binary', status: 'ok', better: 'lower', group: 'size', unit: 'bytes', n: 1, median: v });
  assert.equal(judgeMedian(size(3_700_000), size(4_700_000)).verdict, 'regression');
  assert.equal(judgeMedian(size(3_700_000), size(3_702_000)).verdict, 'ok');
  assert.equal(judgeMedian(size(10_000), size(13_000)).verdict, 'ignored'); // +30% だが 4096 バイト未満
});

test('better が higher の項目は減ったら悪化。失敗した項目は比べない', () => {
  const hi = (v) => mk('x.throughput', spreadSamples(v, 0.5), { better: 'higher', group: 'web', unit: 'MiB' });
  assert.equal(judgeMedian(hi(100), hi(70)).verdict, 'regression');
  assert.equal(judgeMedian(hi(100), hi(130)).verdict, 'improved');
  const res = compareResults({ items: [mk('a', [1, 2, 3])] }, { items: [{ id: 'a', status: 'failed', group: 'docio', reason: 'x' }] });
  assert.equal(res.unusable.length, 1);
});

test('同じ分布の 2 回（揺れだけの差）は悪化にならない', () => {
  // 決定的な疑似乱数（LCG）で、同じ分布から 2 回、50 件ずつ作る
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
  const draw = () => Array.from({ length: 50 }, () => 1 + rnd() * 1.2); // 1.0〜2.2ms（幅の広い標本）
  for (let k = 0; k < 20; k++) {
    const r = compareResults({ items: [mk('docio.x', draw())] }, { items: [mk('docio.x', draw())] });
    assert.equal(r.regressions.length, 0, `試行 ${k}`);
  }
});

test('compare.mjs の終了コード: 悪化があれば 1、無ければ 0。引数で 2 つの JSON を渡す', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'perf-compare-test-'));
  try {
    const write = (name, items) => {
      const p = path.join(dir, name);
      fs.writeFileSync(p, JSON.stringify({ generatedAt: '2026-01-01T00:00:00Z', commit: { short: 'test' }, environment: {}, mode: {}, items }));
      return p;
    };
    const base = write('base.json', [mk('docio.x', spreadSamples(10, 0.2))]);
    const same = write('same.json', [mk('docio.x', spreadSamples(10.1, 0.2))]);
    const slow = write('slow.json', [mk('docio.x', spreadSamples(20, 0.2))]);
    const run = (a, b) => spawnSync(process.execPath, [COMPARE, a, b], { encoding: 'utf8' });
    assert.equal(run(base, same).status, 0);
    const bad = run(base, slow);
    assert.equal(bad.status, 1);
    assert.match(bad.stdout, /悪化（2）/);
    assert.match(bad.stdout, /docio\.x median/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('二峰の標本（0〜3ms と約 16ms）: MAD は小さくても、ブートストラップで中央値のぶれを捉え、山の乗り換えを悪化にしない', () => {
  // base: 低い山が多数、new: 高い山が過半。どちらも標本は同じ形の二峰で、中央値だけがどちらの山に落ちるかで 3 → 16 と動く
  const bimodal = (low, high) => [...Array(low).fill(3), ...Array(high).fill(16)];
  const b = mk('web.ime-commit.chromium.D.end', bimodal(17, 13), { group: 'ime' }); // 中央値 3
  const n = mk('web.ime-commit.chromium.D.end', bimodal(14, 16), { group: 'ime' }); // 中央値 16
  assert.equal(b.median, 3);
  assert.equal(n.median, 16);
  assert.ok(sigmaOf(b.samples) < 5, 'MAD だけでは揺れが小さく見える');
  assert.ok(bootstrapSE(b.samples, 'median') > 4, `bootstrapSE=${bootstrapSE(b.samples, 'median')}`);
  assert.equal(judgeStat(b, n, 'median').verdict, 'ignored');
  // 全体が一様に +60ms ずれた（山の割合は同じ）なら悪化。揺れの 3 倍（約 18）を十分に超える
  const shifted = mk('web.ime-commit.chromium.D.end', bimodal(17, 13).map((x) => x + 60), { group: 'ime' });
  assert.equal(judgeStat(b, shifted, 'median').verdict, 'regression');
});

test('ブートストラップは同じ入力に同じ値を返す（固定シード）', () => {
  const xs = spreadSamples(5, 3, 60);
  assert.equal(bootstrapSE(xs, 'p95'), bootstrapSE(xs, 'p95'));
  assert.equal(bootstrapSE([1], 'median'), 0);
});

test('p95 だけの悪化は悪化に数えず、tailOnly に出す。中央値も悪化していれば悪化に数える', () => {
  // 中央値は同じで、p95 が裾の外れ値で大きく動く（同じコードの 2 回で出た形）
  const body = Array(160).fill(1);
  const b = mk('docio.x', [...body, ...Array(40).fill(1.5)]);
  const n = mk('docio.x', [...body, ...Array(40).fill(9)]);
  assert.equal(b.median, n.median);
  assert.equal(judgeStat(b, n, 'p95').verdict, 'regression'); // p95 単独の判定は悪化
  const res = compareResults({ items: [b] }, { items: [n] });
  assert.equal(res.regressions.length, 0);
  assert.equal(res.tailOnly.length, 1);
  assert.equal(res.tailOnly[0].stat, 'p95');
  // 全体が遅くなった（中央値も悪化）場合は、中央値と p95 の両方が悪化
  const slow = mk('docio.x', [...body, ...Array(40).fill(1.5)].map((x) => x * 3));
  const res2 = compareResults({ items: [b] }, { items: [slow] });
  assert.equal(res2.tailOnly.length, 0);
  assert.deepEqual(res2.regressions.map((r) => r.stat).sort(), ['median', 'p95']);
});
