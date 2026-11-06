#!/usr/bin/env node
// 性能計測の入口。仕様 §9.1 の項目を毎回同じ手順で計測し、JSON に記録する。
//   npm run perf                              全部（Tauri 実機を含む。macOS）。結果は perf/results/<YYYYMMDD>-<shortsha>.json
//   npm run perf -- --quick --web-only        回数を減らした Web UI だけ（sandbox でも動く）。結果は perf/out/（gitignore）
// オプション:
//   --quick            回数を減らす（結果は perf/out/ に出し、perf/results/ には置かない）
//   --web-only         Web UI だけ（docio、配布物のサイズ、Tauri 実機は計測しない）
//   --only a,b         group を限定（web, docio, size, tauri）
//   --browsers a,b     既定は chromium,webkit
//   --skip-build       tauri build と Web UI のビルドを省く（既にビルド済みのとき）
//   --with-debug       Tauri の debug ビルドの起動時間も記録する
//   --out <path>       結果の保存先を指定
//   --inject-input-delay <ms>   計測専用: Web UI の全 keydown に ms のビジーウェイトを足す（計測側のページ注入。アプリのコードは変えない）。
//                      悪化の検出の確認に使う。結果は perf/out/ に出し（perf/results/ には置かない）、mode.injectInputDelayMs に記録する。
//   --open-sidebar    計測専用: Web UI を、左サイドバーを開いた状態（部品のパネルが見えている）で計測する。既定は閉じた状態。
//                      結果は perf/out/ に出し（perf/results/ には置かない）、mode.openSidebar に記録する。
//   --datasets a,b     計測専用: Web UI の計測を、指定した文書（A〜D）に限る（例: --datasets C）。結果は perf/out/ に出し、mode.datasets に記録する。
// 各 group は失敗しても他を続け、失敗した item は status: "failed" と reason を結果に残す。
// 終了コード: 失敗した item があれば 1（結果 JSON は書く）。
import fs from 'node:fs';
import path from 'node:path';
import { DOCIO_ITERS, measureDocio } from './lib/docio.mjs';
import { ensureFixtures } from './lib/fixtures.mjs';
import { buildTauri, measureSizes, measureTauri } from './lib/tauri.mjs';
import { OUT_DIR, RESULTS_DIR, ROOT, ensureDir, environment, failedItem, gitInfo, parseArgs, rel } from './lib/util.mjs';
import { buildWeb, measureWeb, webPlan } from './lib/web.mjs';

const args = parseArgs(process.argv.slice(2));
const quick = args.quick === true;
const webOnly = args['web-only'] === true;
const skipBuild = args['skip-build'] === true;
const injectInputDelayMs = args['inject-input-delay'] === undefined ? 0 : Number(args['inject-input-delay']);
if (!Number.isFinite(injectInputDelayMs) || injectInputDelayMs < 0) {
  console.error('--inject-input-delay には 0 以上の ms を渡してください（例: --inject-input-delay 3）');
  process.exit(2);
}
const openSidebar = args['open-sidebar'] === true;
const datasetIds = typeof args.datasets === 'string' ? args.datasets.split(',') : null;
const only = typeof args.only === 'string' ? args.only.split(',') : null;
const browsers = typeof args.browsers === 'string' ? args.browsers.split(',') : ['chromium', 'webkit'];
const want = (g) => (only ? only.includes(g) : webOnly ? g === 'web' : true);
const log = (m) => console.error(`[perf] ${m}`);

const started = Date.now();
const git = gitInfo();
const items = [];
const extra = {};
const notes = [];

let fixtures = [];
try {
  fixtures = ensureFixtures();
  log(`fixtures: ${fixtures.map((f) => `${f.id}=${f.bytes}B`).join(' ')}`);
} catch (e) {
  console.error(`fixtures を用意できません: ${e.message}`);
  process.exit(2);
}

const env = environment();
const browserVersions = {};

if (want('web')) {
  try {
    if (!skipBuild || !fs.existsSync(path.join(OUT_DIR, 'web-dist'))) buildWeb(log);
    const webFixtures = datasetIds ? fixtures.filter((f) => datasetIds.includes(f.id)) : fixtures;
    const r = await measureWeb({ browsers, fixtures: webFixtures, quick, log, injectInputDelayMs, openSidebar });
    items.push(...r.items);
    Object.assign(browserVersions, r.versions);
  } catch (e) {
    items.push(failedItem('web.run', 'web', e.message));
  }
}

if (want('docio')) {
  try {
    items.push(...measureDocio({ fixtures, quick, log }).items);
  } catch (e) {
    items.push(failedItem('docio.run', 'docio', e.message));
  }
}

let tauriBuild = null;
if (want('tauri') || want('size')) {
  if (!skipBuild) {
    try {
      tauriBuild = buildTauri(log);
    } catch (e) {
      items.push(failedItem('tauri.build', 'tauri', e.message));
    }
  }
}
if (want('tauri')) {
  try {
    const r = await measureTauri({ fixtures, quick, withDebug: args['with-debug'] === true, log, shotPath: typeof args.shot === 'string' ? path.resolve(args.shot) : path.join(OUT_DIR, 'shots', 'tauri-B.png') });
    items.push(...r.items);
    Object.assign(extra, r.extra);
  } catch (e) {
    items.push(failedItem('tauri.run', 'tauri', e.message));
  }
}
if (want('size')) {
  try {
    items.push(...measureSizes());
  } catch (e) {
    items.push(failedItem('size.run', 'size', e.message));
  }
}

const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
const cmd = `npm run perf${process.argv.length > 2 ? ` -- ${process.argv.slice(2).join(' ')}` : ''}`;
const plan = webPlan(quick);
const result = {
  schema: 1,
  generatedAt: new Date().toISOString(),
  durationSec: Math.round((Date.now() - started) / 1000),
  command: cmd,
  mode: { quick, webOnly, only, browsers, ...(injectInputDelayMs > 0 ? { injectInputDelayMs } : {}), ...(openSidebar ? { openSidebar } : {}), ...(datasetIds ? { datasets: datasetIds } : {}) },
  commit: git,
  environment: {
    ...env,
    browsers: browserVersions,
    tauriBuildSeconds: tauriBuild?.seconds ?? null,
  },
  plan: quick ? { ...plan, tauri: 'warm 3 回・メモリ 2 回' } : { ...plan, tauri: 'warm 7 回・メモリ 5 回', docio: `反復 ${DOCIO_ITERS} 回` },
  datasets: fixtures.map((f) => ({ id: f.id, name: f.name, bytes: f.bytes, chars: f.chars, sha256: f.sha256 })),
  extra,
  items,
};

let outFile;
if (typeof args.out === 'string') {
  outFile = path.resolve(args.out);
  if (injectInputDelayMs > 0 && outFile.startsWith(`${RESULTS_DIR}${path.sep}`)) {
    console.error('遅延を注入した結果は perf/results/ に置けません（基準値になってしまうため）。');
    process.exit(2);
  }
}
else if (openSidebar || datasetIds) outFile = path.join(OUT_DIR, `variant${openSidebar ? '-sidebar' : ''}${datasetIds ? `-${datasetIds.join('')}` : ''}${quick ? '-quick' : ''}-${date}-${git.short}.json`);
else if (injectInputDelayMs > 0) outFile = path.join(OUT_DIR, `inject-${injectInputDelayMs}ms${quick ? '-quick' : ''}-${date}-${git.short}.json`);
else if (quick) outFile = path.join(OUT_DIR, `quick-${date}-${git.short}.json`);
else {
  ensureDir(RESULTS_DIR);
  outFile = path.join(RESULTS_DIR, `${date}-${git.short}.json`);
  // 同じ日・同じコミットの 2 回目以降は -2, -3 ... を付ける（perf:compare で揺れを見るため上書きしない）。
  for (let i = 2; fs.existsSync(outFile); i++) outFile = path.join(RESULTS_DIR, `${date}-${git.short}-${i}.json`);
}
ensureDir(path.dirname(outFile));
fs.writeFileSync(outFile, `${JSON.stringify(result, null, 2)}\n`);

const failed = items.filter((i) => i.status !== 'ok');
console.log(`perf: ${items.length - failed.length}/${items.length} 項目を計測（${result.durationSec} 秒）→ ${rel(outFile)}`);
for (const f of failed) console.log(`  FAILED ${f.id}: ${f.reason}`);
process.exit(failed.length > 0 ? 1 : 0);
