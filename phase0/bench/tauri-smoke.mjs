#!/usr/bin/env node
// Phase 0 P0-3: Tauri real-app launch time and memory (macOS only).
// Launch -> window visible (frontend-ready makes the hidden window visible, App.tsx:648 / lib.rs:62-69).
// Memory: RSS of the app process, plus WebKit helper processes that newly appeared after launch (estimate).
// Output: phase0/results/tauri-smoke.json, and the same numbers merged into phase0/results/benchmark.json
// (run phase0/bench/run.mjs first; this script replaces earlier engine="tauri-app" entries).
import { spawnSync, execFileSync } from 'node:child_process';
import { existsSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const bin = resolve(root, 'phase0/vendor/MDE/src-tauri/target/debug/mde');
if (!existsSync(bin)) { console.error('debug binary がありません（npx tauri build --debug）'); process.exit(2); }
const tool = resolve(os.tmpdir(), 'phase0-launch-measure');
const swiftc = spawnSync('swiftc', ['-O', resolve(here, 'launch-measure.swift'), '-o', tool], { encoding: 'utf8' });
if (swiftc.status !== 0) { console.error(swiftc.stderr); process.exit(2); }

const N = Number(process.env.RUNS ?? 5);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ps = () => execFileSync('ps', ['-axo', 'pid=,rss=,comm='], { encoding: 'utf8' }).split('\n').filter(Boolean).map((l) => {
  const m = l.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/); return m ? { pid: +m[1], rssKiB: +m[2], comm: m[3] } : null;
}).filter(Boolean);
const isWebKit = (c) => /com\.apple\.WebKit\.(WebContent|GPU|Networking)/.test(c);

const perf = resolve(root, 'phase0/fixtures/perf');
const scenarios = [
  { id: 'empty', args: [] },
  { id: 'A-10kb', args: [resolve(perf, 'A-10kb-ja.md')] },
  { id: 'B-100kb', args: [resolve(perf, 'B-100kb-mixed.md')] },
  { id: 'C-1mb', args: [resolve(perf, 'C-1mb-longform.md')] },
];
const results = [];
for (const sc of scenarios) {
  if (sc.args[0] && !existsSync(sc.args[0])) { results.push({ scenario: sc.id, status: 'skipped', note: 'fixture なし。node scripts/gen-fixtures.mjs' }); continue; }
  const runs = [];
  for (let i = 0; i < N; i++) {
    const before = new Set(ps().filter((p) => isWebKit(p.comm)).map((p) => p.pid));
    const r = spawnSync(tool, [bin, '30', ...sc.args], { encoding: 'utf8' });
    let info; try { info = JSON.parse(r.stdout.trim()); } catch { runs.push({ error: r.stderr || r.stdout }); continue; }
    const pid = info.pid;
    await sleep(sc.args.length ? 4000 : 3000); // let the document load and settle
    const snap = ps();
    const main = snap.find((p) => p.pid === pid);
    const kids = snap.filter((p) => isWebKit(p.comm) && !before.has(p.pid));
    runs.push({
      windowVisibleMs: info.windowVisibleMs,
      mainRssMiB: main ? Math.round(main.rssKiB / 1024 * 10) / 10 : null,
      newWebKitProcs: kids.map((k) => ({ name: k.comm.split('/').pop(), rssMiB: Math.round(k.rssKiB / 1024 * 10) / 10 })),
      totalRssMiB: main ? Math.round((main.rssKiB + kids.reduce((s, k) => s + k.rssKiB, 0)) / 1024 * 10) / 10 : null,
    });
    try { process.kill(pid, 'SIGTERM'); } catch {}
    await sleep(1500);
    try { process.kill(pid, 'SIGKILL'); } catch {}
    await sleep(500);
  }
  results.push({ scenario: sc.id, runs });
  console.log(sc.id, JSON.stringify(runs.map((r) => [r.windowVisibleMs, r.mainRssMiB, r.totalRssMiB])));
}
const sh = (c, a) => { try { return execFileSync(c, a, { encoding: 'utf8' }).trim(); } catch { return null; } };
writeFileSync(resolve(root, 'phase0/results/tauri-smoke.json'), JSON.stringify({
  generatedAt: new Date().toISOString(),
  command: 'RUNS=5 node phase0/bench/tauri-smoke.mjs',
  binary: 'phase0/vendor/MDE/src-tauri/target/debug/mde (debug build, unoptimized)',
  environment: { os: `macOS ${sh('sw_vers', ['-productVersion'])}`, cpu: os.cpus()[0]?.model, memoryGiB: Math.round(os.totalmem() / 2 ** 30) },
  notes: [
    'debug ビルドであり release ビルドの数値ではない',
    'cold/warm は制御していない（page cache の purge は sudo が必要なため行わない）。1 回目と 2 回目以降は runs の順で区別できる',
    'windowVisibleMs は spawn から CGWindowList で高さ 100px 超の窓が出るまで。フロントエンドの frontend-ready で表示される設計（lib.rs）のため、編集可能状態の近似。ファイル引数の読み込み完了時刻は含まない',
    'WebKit 子プロセスは「起動前に存在しなかった com.apple.WebKit.* プロセス」を当該アプリ分と推定した値。他アプリが同時に WebKit を起動していれば混入する',
    '起動時引数でファイルを渡している（lib.rs:5-17 extract_file_args）。キー入力・IME 後のメモリは未計測',
  ],
  scenarios: results,
}, null, 2) + '\n');

// ---- merge into benchmark.json ----
const benchPath = resolve(root, 'phase0/results/benchmark.json');
if (existsSync(benchPath)) {
  const bench = JSON.parse(readFileSync(benchPath, 'utf8'));
  bench.measurements = bench.measurements.filter((m) => m.engine !== 'tauri-app');
  const q = (xs) => { const a = xs.filter((x) => typeof x === 'number').sort((x, y) => x - y); return a.length ? { n: a.length, median: a[Math.floor((a.length - 1) / 2)], min: a[0], max: a.at(-1) } : { n: 0 }; };
  const smoke = JSON.parse(readFileSync(resolve(root, 'phase0/results/tauri-smoke.json'), 'utf8'));
  for (const sc of smoke.scenarios) {
    if (!sc.runs) continue;
    const base = { browser: 'WKWebView (Tauri debug build)', engine: 'tauri-app', dataset: sc.scenario };
    bench.measurements.push({ ...base, metric: 'launch_to_window_visible_ms', unit: 'ms', ...q(sc.runs.map((r) => r.windowVisibleMs)), runsInOrder: sc.runs.map((r) => r.windowVisibleMs), status: 'ok', note: 'debug ビルド。cold/warm 未制御。1 回目が最も cold に近い' });
    bench.measurements.push({ ...base, metric: 'rss_total_mib_estimate', unit: 'MiB', ...q(sc.runs.map((r) => r.totalRssMiB)), status: 'ok', note: 'アプリ本体 RSS + 起動後に新規出現した WebKit 子プロセスの RSS（推定）。起動 3〜4 秒後の値' });
    bench.measurements.push({ ...base, metric: 'rss_main_process_mib', unit: 'MiB', ...q(sc.runs.map((r) => r.mainRssMiB)), status: 'ok', note: 'アプリ本体プロセスのみ' });
  }
  bench.unmeasured = [
    'Tauri 実機での入力→描画遅延（WKWebView に合成入力を送る手段がなく未計測。ブラウザ計測のみ）',
    'Tauri 実機でのモード切替・文書読み込み時間（同上）',
    'release ビルドでの起動時間・メモリ・パッケージサイズ',
    'Windows 11 / Ubuntu 24.04 の全項目（実機なし）',
    '日本語 IME 確定後の反映遅延（自動化不可。手動手順は docs/architecture-review.md）',
    '長文スクロール中のフレーム時間',
  ];
  writeFileSync(benchPath, JSON.stringify(bench, null, 2) + '\n');
}
