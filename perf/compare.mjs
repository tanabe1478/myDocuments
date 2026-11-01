#!/usr/bin/env node
// 2 つの結果 JSON を比べ、悪化した項目を一覧にして exit 1 にする。
//   npm run perf:compare -- <base.json> <new.json>     引数を省くと perf/results/ の最新 2 件（古い方が base）
// 判定の式と係数は perf/lib/judge.mjs の冒頭（docs/perf-baseline.md の「悪化の判定」にも書いた）。要点:
//   悪化 = 20% 以上悪化 かつ 差が標本の揺れ（1.4826 × MAD）の 3 倍を超える かつ 単位ごとの小さな下限以上。中央値と p95 を比べる。
//   標本が 3 件未満の項目（cold）は判定せず「参考」に出す。p95 は標本が 40 件以上のときだけ比べ、悪化は中央値も悪化したときだけ数える（p95 だけは別に表示）。
//   標本が無い古い結果 JSON との比較は従来の固定の下限で判定し、その旨を表示する。
// オプション: --threshold 0.2（割合）、--sigma 3（揺れの係数）。
// 環境（CPU、OS、ブラウザの版、WKWebView の版）が違えば警告を出す（比較は参考値になる）。
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULTS, compareResults } from './lib/judge.mjs';
import { RESULTS_DIR, parseArgs, rel } from './lib/util.mjs';

const args = parseArgs(process.argv.slice(2));
const options = {
  threshold: typeof args.threshold === 'string' ? Number(args.threshold) : DEFAULTS.threshold,
  sigmaK: typeof args.sigma === 'string' ? Number(args.sigma) : DEFAULTS.sigmaK,
};

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
if ((base.mode?.injectInputDelayMs ?? 0) !== (next.mode?.injectInputDelayMs ?? 0)) diffs.push(`mode.injectInputDelayMs（base ${base.mode?.injectInputDelayMs ?? 0}ms, new ${next.mode?.injectInputDelayMs ?? 0}ms）`);
if (diffs.length > 0) console.log(`警告: 環境か条件が違います（${diffs.join(', ')}）。比較は参考値です。`);

const r = compareResults(base, next, options);
const num = (x) => Math.round(x * 10000) / 10000;
const pct = (x) => (x === Infinity ? '+∞' : `${x >= 0 ? '+' : ''}${(x * 100).toFixed(1)}%`);
const times = (x) => (x.noise === undefined ? '' : x.noise > 0 ? `、揺れ ${num(x.noise)} の ${(x.delta / x.noise).toFixed(1)} 倍${x.k && x.k > options.sigmaK ? `（標本が少ないので ${x.k.toFixed(1)} 倍超が条件）` : ''}` : '、揺れ 0');
const fmt = (x) => `  ${x.id} ${x.stat}: ${num(x.base)} → ${num(x.next)} ${x.unit}（${pct(x.ratio)}${times(x)}）`;
const fmtRef = (x) => `  ${x.id}: ${num(x.base)} → ${num(x.next)} ${x.unit}（${pct(x.ratio)}、標本 base ${x.n.base ?? '?'} 件 / new ${x.n.next ?? '?'} 件）`;

console.log(`\n比較した値: ${r.compared}（悪化 = ${(options.threshold * 100).toFixed(0)}% 以上 かつ 揺れの ${options.sigmaK} 倍超 かつ 単位ごとの下限以上。p95 は標本 ${DEFAULTS.minNForP95} 件以上のみ）`);
if (r.regressions.length > 0) {
  console.log(`\n悪化（${r.regressions.length}）:`);
  r.regressions.sort((a, b) => b.ratio - a.ratio).forEach((x) => console.log(fmt(x)));
}
if (r.tailOnly.length > 0) {
  console.log(`\np95 だけの悪化（${r.tailOnly.length}。中央値は悪化していないので判定対象外。裾だけが悪化したのか、計測中の負荷の山かは、この 2 件からは区別できない）:`);
  r.tailOnly.sort((a, b) => b.ratio - a.ratio).forEach((x) => console.log(fmt(x)));
}
if (r.reference.length > 0) {
  console.log(`\n参考（判定対象外。標本が ${DEFAULTS.minN} 件未満で、揺れを判別できない）: ${r.reference.length} 件`);
  r.reference.forEach((x) => console.log(fmtRef(x)));
}
if (r.ignored.length > 0) {
  console.log(`\n割合は超えたが、揺れの範囲か下限未満のため無視（${r.ignored.length}）:`);
  r.ignored.sort((a, b) => b.ratio - a.ratio).forEach((x) => console.log(fmt(x)));
}
if (r.improved.length > 0) {
  console.log(`\n改善（${r.improved.length}）:`);
  r.improved.sort((a, b) => a.ratio - b.ratio).forEach((x) => console.log(fmt(x)));
}
if (r.legacyItems.length > 0) {
  console.log(`\n標本（samples）が無い結果との比較のため、従来の固定の下限で判定した項目: ${r.legacyItems.length} 件（揺れを使えない。例: ${r.legacyItems.slice(0, 3).join(', ')}）`);
}
if (r.unusable.length > 0) console.log(`\n比較できない（どちらかが計測失敗）: ${r.unusable.length} 件\n  ${r.unusable.slice(0, 20).join('\n  ')}`);
if (r.onlyNew.length > 0) console.log(`\nnew にだけある項目: ${r.onlyNew.length} 件（${r.onlyNew.slice(0, 4).join(', ')}${r.onlyNew.length > 4 ? ' ...' : ''}）`);
if (r.onlyBase.length > 0) console.log(`\nbase にだけある項目: ${r.onlyBase.length} 件`);
if (r.regressions.length === 0) console.log('\n悪化した項目はありません。');
process.exit(r.regressions.length > 0 ? 1 : 0);
