#!/usr/bin/env node
// Phase 0 P0-3: CodeMirror 6 (MDE EditorManager) vs Milkdown (MDE MilkdownManager) in a real browser.
// Output: phase0/results/benchmark.json
// Usage: node phase0/bench/run.mjs [chromium,webkit] [--quick] [--merge]
//   --merge: keep measurements of other browsers already in benchmark.json (same mdeCommit) and replace only the browsers run now.
//   Used to split a long run into one foreground command per browser.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import { createRequire } from 'node:module';
import { serve } from '../lib/serve.mjs';
import { launch } from '../lib/browsers.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const dist = resolve(root, 'phase0/harness/dist');
const quick = process.argv.includes('--quick');
const merge = process.argv.includes('--merge');
const browsersToRun = (process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : 'chromium,webkit').split(',');
if (!existsSync(dist)) { console.error('harness/dist がありません'); process.exit(2); }

const perfDir = resolve(root, 'phase0/fixtures/perf');
const manifest = JSON.parse(readFileSync(resolve(perfDir, 'manifest.json'), 'utf8'));
const datasets = manifest.datasets.map((d) => ({ ...d, b64: readFileSync(resolve(perfDir, d.file)).toString('base64') }));
const mdeCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: resolve(root, 'phase0/vendor/MDE'), encoding: 'utf8' }).trim();

const OP_TIMEOUT = 120_000;
const withTimeout = (p, ms, label) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`timeout ${ms}ms: ${label}`)), ms))]);

function stats(xs) {
  const s = [...xs].sort((a, b) => a - b);
  const q = (p) => s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)];
  const r = (x) => Math.round(x * 100) / 100;
  return { n: s.length, median: r(q(0.5)), p95: r(q(0.95)), min: r(s[0]), max: r(s.at(-1)) };
}

const measurements = [];
const add = (m) => { measurements.push(m); console.log(JSON.stringify(m)); };

async function freshPage(browser, port) {
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.error('pageerror', e.message));
  await page.goto(`http://127.0.0.1:${port}/index.html`);
  await page.waitForFunction('window.__ready === true');
  return page;
}

const iterFor = (id) => (quick ? 1 : id === 'A' || id === 'B' ? 5 : 3);
const keysFor = quick ? 20 : 100;

const { server, port } = await serve(dist);
const envs = {};
for (const bname of browsersToRun) {
  const browser = await launch(bname);
  envs[bname] = { name: bname, version: browser.version(), headless: true };
  const tiny = Buffer.from('# warmup\n\nhello\n').toString('base64');

  // ---- document load (editor creation -> first paint) ----
  for (const engine of ['cm', 'md']) {
    for (const d of datasets) {
      const page = await freshPage(browser, port);
      const fn = engine === 'cm' ? 'cmLoad' : 'mdLoad';
      const metaBase = { browser: bname, engine, dataset: d.id, datasetBytes: d.bytes };
      try {
        if (engine === 'md' && d.id === 'A') {
          // cold: first Crepe creation in a fresh page includes lazy chunk load.
          const cold = await withTimeout(page.evaluate(([f, b]) => window.__h[f](b), [fn, d.b64]), OP_TIMEOUT, 'cold');
          add({ ...metaBase, metric: 'load_cold_first_creation_ms', unit: 'ms', ...stats([cold.toPaintMs]), status: 'ok', note: '新規ページ最初の Milkdown 生成。遅延ロードされる chunk の取得を含む' });
        }
        await withTimeout(page.evaluate(([f, b]) => window.__h[f](b), [fn, tiny]), OP_TIMEOUT, 'warmup');
        const create = [], paint = [];
        let status = 'ok', note = '', sanity = null;
        for (let i = 0; i < iterFor(d.id); i++) {
          try {
            const r = await withTimeout(page.evaluate(([f, b]) => window.__h[f](b), [fn, d.b64]), OP_TIMEOUT, `${engine} load ${d.id}`);
            create.push(r.createMs); paint.push(r.toPaintMs);
            sanity = engine === 'cm' ? { docChars: r.docChars, renderedLines: r.renderedLines } : { docChars: r.docChars, renderedBlocks: r.renderedBlocks };
            if (r.toPaintMs > 60_000) { note = '1 回が 60 秒超のため反復を打ち切り'; break; }
          } catch (e) { status = 'timeout'; note = String(e.message); break; }
        }
        if (paint.length) {
          add({ ...metaBase, metric: 'load_to_first_paint_ms', unit: 'ms', ...stats(paint), status, note, sanity });
          add({ ...metaBase, metric: 'load_sync_create_ms', unit: 'ms', ...stats(create), status, note });
        } else add({ ...metaBase, metric: 'load_to_first_paint_ms', unit: 'ms', n: 0, status, note });
      } catch (e) {
        add({ ...metaBase, metric: 'load_to_first_paint_ms', unit: 'ms', n: 0, status: 'error', note: String(e.message) });
      }
      await page.close().catch(() => {});
    }
  }

  // ---- keystroke -> next frame (post-paint task) ----
  for (const engine of ['plain', 'cm', 'md']) {
    for (const d of engine === 'plain' ? [datasets[0]] : datasets) {
      const page = await freshPage(browser, port);
      const metaBase = { browser: bname, engine: engine === 'plain' ? 'contenteditable-baseline' : engine, dataset: engine === 'plain' ? 'plain-20k-chars' : d.id, datasetBytes: engine === 'plain' ? 20000 : d.bytes };
      let status = 'ok', note = '';
      let lat = [], typedDelta = null;
      try {
        if (engine === 'md') await withTimeout(page.evaluate((b) => window.__h.mdLoad(b), tiny), OP_TIMEOUT, 'md warmup');
        await withTimeout(page.evaluate(([e, b]) => window.__h.prepareTyping(e, b), [engine, d.b64]), OP_TIMEOUT, 'prepare');
        for (let i = 0; i < keysFor; i++) {
          await page.keyboard.press('a');
          try {
            await page.waitForFunction((n) => window.__h.collectLatency().length > n, i, { timeout: 15_000 });
          } catch { status = 'partial'; note = `キー ${i + 1} の描画が 15 秒以内に観測できず打ち切り`; break; }
          await page.waitForTimeout(25);
        }
        lat = await page.evaluate(() => window.__h.collectLatency());
        typedDelta = await page.evaluate(() => window.__h.typingDelta());
      } catch (e) { status = 'error'; note = String(e.message); }
      add({ ...metaBase, metric: 'keydown_to_next_frame_ms', unit: 'ms', ...(lat.length ? stats(lat) : { n: 0 }), status, charsInserted: typedDelta, note: note || 'headless。keydown(capture) から rAF 後の task まで。60Hz フレーム量子化を含む。IME 合成は含まない' });
      await page.close().catch(() => {});
    }
  }

  // ---- mode switch ----
  for (const d of datasets) {
    const page = await freshPage(browser, port);
    const metaBase = { browser: bname, engine: 'cm<->md', dataset: d.id, datasetBytes: d.bytes };
    const acc = { rawToVisualFirstMs: [], visualToRawMs: [], rawToVisualSecondMs: [] };
    let status = 'ok', note = '';
    try {
      await withTimeout(page.evaluate((b) => window.__h.modeSwitch(b, false), tiny), OP_TIMEOUT, 'warmup');
      for (let i = 0; i < iterFor(d.id); i++) {
        const r = await withTimeout(page.evaluate((b) => window.__h.modeSwitch(b, false), d.b64), OP_TIMEOUT, `modeSwitch ${d.id}`);
        for (const k of Object.keys(acc)) acc[k].push(r[k]);
        if (r.rawToVisualFirstMs > 60_000) { note = '1 回が 60 秒超のため反復を打ち切り'; break; }
      }
    } catch (e) { status = 'timeout'; note = String(e.message); }
    for (const [k, v] of Object.entries(acc)) {
      add({ ...metaBase, metric: `mode_switch_${k.replace(/Ms$/, '')}_ms`, unit: 'ms', ...(v.length ? stats(v) : { n: 0 }), status, note: note || 'EditorArea.tsx:82-109 の呼び出し順を再現（React コンポーネント経由ではない）' });
    }
    await page.close().catch(() => {});
  }
  await browser.close();
}
server.close();

const require = createRequire(import.meta.url);
const sh = (c, a) => { try { return execFileSync(c, a, { encoding: 'utf8' }).trim(); } catch { return null; } };
const outPath = resolve(root, 'phase0/results/benchmark.json');
let prev = null;
if (merge && existsSync(outPath)) {
  const p = JSON.parse(readFileSync(outPath, 'utf8'));
  if (p.mdeCommit === mdeCommit) prev = p;
}
const runCmd = `node phase0/bench/run.mjs ${browsersToRun.join(',')}${quick ? ' --quick' : ''}${merge ? ' --merge' : ''}`;
const result = {
  mdeCommit,
  generatedAt: new Date().toISOString(),
  command: prev ? `${prev.command} ; ${runCmd}` : `node scripts/gen-fixtures.mjs && (cd phase0/vendor/MDE && npx vite build --config ../../harness/vite.config.mjs) && ${runCmd}`,
  environment: {
    os: `${os.type()} ${os.release()} (macOS ${sh('sw_vers', ['-productVersion'])})`,
    arch: os.arch(),
    cpu: os.cpus()[0]?.model,
    cpuCores: os.cpus().length,
    memoryGiB: Math.round(os.totalmem() / 2 ** 30),
    node: process.version,
    playwrightCore: require('playwright-core/package.json').version,
    browsers: { ...(prev?.environment?.browsers ?? {}), ...envs },
    loadNote: '計測中は他の自作スクリプトを並行実行していない。ただし OS 上の他アプリ（常駐アプリ、このセッションを動かすエージェントなど）は動いており、バックグラウンド負荷は制御していない。電源・省電力設定は未記録。',
    webviewNote: 'macOS の Tauri は WKWebView。ここでの webkit は Playwright 同梱の WebKit ビルドで、システムの WKWebView と同一ではない（未検証）。',
  },
  datasets: manifest.datasets.map(({ id, file, bytes, chars, paragraphs, sha256 }) => ({ id, file, bytes, chars, paragraphs, sha256 })),
  unmeasured: [
    'Tauri 実機での入力→描画遅延（WKWebView に合成入力を送る手段がなく未計測。ブラウザ計測のみ）',
    'Tauri 実機でのモード切替・文書読み込み時間（同上）',
    'release ビルドでの起動時間・メモリ・パッケージサイズ',
    'Windows 11 / Ubuntu 24.04 の全項目（実機なし）',
    '日本語 IME 確定後の反映遅延（自動化不可。手動手順は docs/architecture-review.md）',
    '長文スクロール中のフレーム時間',
  ],
  measurements: [...(prev?.measurements ?? []).filter((m) => !browsersToRun.includes(m.browser)), ...measurements],
};
if (prev) result.runs = [...(prev.runs ?? [{ browsers: Object.keys(prev.environment.browsers), generatedAt: prev.generatedAt }]), { browsers: browsersToRun, generatedAt: result.generatedAt }];
writeFileSync(outPath, JSON.stringify(result, null, 2) + '\n');
console.log('wrote phase0/results/benchmark.json', result.measurements.length, 'measurements');
