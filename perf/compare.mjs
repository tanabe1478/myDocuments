#!/usr/bin/env node
// 2 つの結果 JSON を比べ、20% 以上悪化した項目を一覧にして exit 1 にする。
//   npm run perf:compare -- <base.json> <new.json>     引数を省くと perf/results/ の最新 2 件（古い方が base）
// 比べる値: 中央値と p95（ある項目のみ）。better が lower の項目は増えたら悪化。
// 揺れとみなして無視するもの（無視した項目は別に表示する。--no-floor で無効、--threshold 0.2 で割合を変える）:
//   - 絶対差が項目の種類ごとの下限未満（FLOOR_BY_GROUP。Web UI の遅延の中央値は 10ms）。Web UI の遅延は 60Hz のフレーム（16.7ms）に量子化され、
//     webkit は 1ms 刻みなので、1 フレーム未満の差は同じ環境の 2 回の計測でも出る（docs/perf-baseline.md の「揺れ」）。
//   - p95 は標本が 20 件未満のとき比べない（事実上の最大値になるため）。
// 環境（CPU、OS、ブラウザの版、WKWebView の版）が違えば警告を出す（比較は参考値になる）。
import fs from 'node:fs';
import path from 'node:path';
import { RESULTS_DIR, parseArgs, rel } from './lib/util.mjs';

const args = parseArgs(process.argv.slice(2));
const threshold = typeof args.threshold === 'string' ? Number(args.threshold) : 0.2;
const useFloor = args['no-floor'] !== true;
const FLOOR_BY_GROUP = { web: 17, typing: 17, ime: 17, open: 17, mode: 17, scroll: 17, startup: 20, memory: 3, docio: 0.5, size: 4096 };
// 中央値は p95 より揺れが小さいので、Web UI の遅延の下限は 10ms にする（同じ環境の 2 回で見えた中央値の差は最大 9ms）。
const MEDIAN_FLOOR_BY_GROUP = { web: 10, typing: 10, ime: 10, open: 10, mode: 10, scroll: 10 };
const FLOOR_BY_UNIT = { ms: 2, MiB: 2, bytes: 4096, frames: 2 };
const MIN_N_FOR_P95 = 20;

function load(p) {
  return JSON.parse(fs.readFileSync(path.resolve(p), 'utf8'));
}

let [basePath, newPath] = args._;
if (!basePath || !newPath) {
  const files = fs.existsSync(RESULTS_DIR) ? fs.readdirSync(RESULTS_DIR).filter((f) => f.endsWith('.json')).map((f) => path.join(RESULTS_DIR, f)) : [];
  const sorted = files.map((f) => ({ f, t: load(f).generatedAt })).sort((a, b) => a.t.localeCompare(b.t));
  if (sorted.length < 2) {
    console.error('perf/results/ に結果が 2 件ありません。引数で 2 つの JSON を渡してください。');
    process.exit(2);
  }
  basePath = sorted.at(-2).f;
  newPath = sorted.at(-1).f;
}
const base = load(basePath);
const next = load(newPath);
console.log(`base: ${rel(path.resolve(basePath))}（${base.commit?.short}, ${base.generatedAt}）`);
console.log(`new : ${rel(path.resolve(newPath))}（${next.commit?.short}, ${next.generatedAt}）`);

// 環境の違い
const envKeys = ['cpu', 'cpuCores', 'memoryGiB', 'osVersion', 'osBuild', 'node', 'wkwebview', 'power', 'lowPowerMode'];
const diffs = envKeys.filter((k) => JSON.stringify(base.environment?.[k]) !== JSON.stringify(next.environment?.[k]));
for (const b of new Set([...Object.keys(base.environment?.browsers ?? {}), ...Object.keys(next.environment?.browsers ?? {})])) {
  if (base.environment?.browsers?.[b]?.version !== next.environment?.browsers?.[b]?.version) diffs.push(`browsers.${b}`);
}
if (base.mode?.quick !== next.mode?.quick) diffs.push('mode.quick（回数が違う）');
if (diffs.length > 0) console.log(`警告: 環境が違います（${diffs.join(', ')}）。比較は参考値です。`);

const baseItems = new Map((base.items ?? []).map((i) => [i.id, i]));
const regressions = [];
const ignored = [];
const improved = [];
const rows = [];
const onlyNew = [];
const unusable = [];

for (const n of next.items ?? []) {
  const b = baseItems.get(n.id);
  baseItems.delete(n.id);
  if (!b) {
    onlyNew.push(n.id);
    continue;
  }
  if (b.status !== 'ok' || n.status !== 'ok') {
    unusable.push(`${n.id}（base: ${b.status}, new: ${n.status}）`);
    continue;
  }
  for (const stat of ['median', 'p95']) {
    const bv = b[stat];
    const nv = n[stat];
    if (typeof bv !== 'number' || typeof nv !== 'number') continue;
    if (stat === 'p95' && !(Math.min(b.n ?? 0, n.n ?? 0) >= MIN_N_FOR_P95)) continue;
    const higherIsBetter = n.better === 'higher';
    const delta = higherIsBetter ? bv - nv : nv - bv; // 正なら悪化
    const ratio = bv === 0 ? (delta > 0 ? Infinity : 0) : delta / Math.abs(bv);
    const row = { id: n.id, stat, unit: n.unit, base: bv, next: nv, ratio };
    rows.push(row);
    if (ratio >= threshold) {
      const floor = useFloor ? ((stat === 'median' ? MEDIAN_FLOOR_BY_GROUP[n.group] : undefined) ?? FLOOR_BY_GROUP[n.group] ?? FLOOR_BY_UNIT[n.unit] ?? 0) : 0;
      (Math.abs(nv - bv) < floor ? ignored : regressions).push(row);
    } else if (ratio <= -threshold) improved.push(row);
  }
}
const onlyBase = [...baseItems.keys()];

const num = (x) => Math.round(x * 10000) / 10000;
const fmt = (r) => `  ${r.id} ${r.stat}: ${num(r.base)} → ${num(r.next)} ${r.unit}（${r.ratio === Infinity ? '+∞' : `${r.ratio >= 0 ? '+' : ''}${(r.ratio * 100).toFixed(1)}%`}）`;
console.log(`\n比較した値: ${rows.length}（しきい値 ${(threshold * 100).toFixed(0)}%、絶対差の下限 ${useFloor ? `${JSON.stringify(FLOOR_BY_GROUP)}、中央値の Web UI 遅延は ${MEDIAN_FLOOR_BY_GROUP.typing}` : 'なし'}、p95 は n≥${MIN_N_FOR_P95} のみ）`);
if (regressions.length > 0) {
  console.log(`\n悪化（${regressions.length}）:`);
  regressions.sort((a, b) => b.ratio - a.ratio).forEach((r) => console.log(fmt(r)));
  console.log('\n注意: 同じコードの 2 回の計測でも、cold（標本 1 件）や docio の一部が 20% を超えて動くことがある（docs/perf-baseline.md の「揺れ」）。悪化が出た項目は、もう一度計測して再現するか確かめる。');
}
if (ignored.length > 0) {
  console.log(`\n割合は超えたが絶対差が下限未満のため無視（${ignored.length}）:`);
  ignored.sort((a, b) => b.ratio - a.ratio).forEach((r) => console.log(fmt(r)));
}
if (improved.length > 0) {
  console.log(`\n改善（${improved.length}）:`);
  improved.sort((a, b) => a.ratio - b.ratio).forEach((r) => console.log(fmt(r)));
}
if (unusable.length > 0) console.log(`\n比較できない（どちらかが計測失敗）: ${unusable.length} 件\n  ${unusable.slice(0, 20).join('\n  ')}`);
if (onlyNew.length > 0) console.log(`\nnew にだけある項目: ${onlyNew.length} 件`);
if (onlyBase.length > 0) console.log(`\nbase にだけある項目: ${onlyBase.length} 件`);
if (regressions.length === 0) console.log('\n20% 以上悪化した項目はありません。');
process.exit(regressions.length > 0 ? 1 : 0);
