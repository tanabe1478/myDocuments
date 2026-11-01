#!/usr/bin/env node
// read-only の健全性確認。drive の前、特に結果が怪しいときに実行する。
// 使い方: node .pi/skills/verify-mydocuments/scripts/doctor.mjs --run-id <id>
// 確認: node/npm の版、playwright の chromium、state の pid が生きているか、pid がこの run のものか、
//       port の所有者が state の pid か、ページが VITE_E2E ビルドか（html[data-ready="true"] と window.__mdeE2E）。ファイルは書かない。
// ps や lsof が使えない sandbox でも例外で落ちず、確認できない項目を FAIL として出し、残りの項目も評価する。
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, isAlive, listenersOf, loadPlaywright, parseArgs, portOpen, readState, rel, resolveRun, verifyOwnership } from './lib.mjs';

const args = parseArgs(process.argv.slice(2));
const { runDir, statePath } = resolveRun(args);
const state = readState(statePath);
let failed = 0;

/** 1 項目を評価する。fn は { ok, detail } を返す。例外も FAIL にして次へ進む。 */
async function check(name, fn) {
  let result;
  try {
    result = await fn();
  } catch (e) {
    result = { ok: false, detail: `例外: ${String(e.message ?? e).split('\n')[0]}` };
  }
  console.log(`${result.ok ? 'PASS' : 'FAIL'} ${name}${result.detail ? `: ${result.detail}` : ''}`);
  if (!result.ok) failed++;
  return result;
}

await check('node', () => ({ ok: true, detail: process.version }));
await check('npm', () => {
  const r = spawnSync('npm', ['--version'], { encoding: 'utf8', cwd: ROOT });
  return { ok: r.status === 0 && typeof r.stdout === 'string', detail: (r.stdout ?? '').trim() };
});

let chromium = null;
const chromiumPath = (await check('playwright chromium', () => {
  chromium = loadPlaywright().chromium;
  const p = chromium.executablePath();
  return { ok: fs.existsSync(p), detail: fs.existsSync(p) ? 'installed' : 'missing（npx playwright install chromium）', p };
})).p;

await check('state', () => ({ ok: true, detail: `${rel(statePath)} run=${state.runId} port=${state.port} pid=${state.pid}` }));
const alive = await check('preview pid alive', () => ({ ok: isAlive(state.pid), detail: `pid ${state.pid}` }));
const identity = await check('pid はこの run のもの', () => {
  const o = verifyOwnership({ pid: state.pid, kind: 'preview', runDir, port: state.port });
  return { ok: o.ok, detail: `${o.method}: ${o.detail}` };
});
const owner = await check('port owner is this run', () => {
  const owners = listenersOf(state.port);
  if (owners === null) return { ok: false, detail: 'lsof が使えず、port の所有者を確認できない' };
  return { ok: owners.includes(state.pid), detail: `port ${state.port} listeners=[${owners.join(',')}] state.pid=${state.pid}` };
});
const serving = await check('port is serving', async () => {
  const open = await portOpen(state.port);
  return { ok: open, detail: `127.0.0.1:${state.port} に接続${open ? 'できる' : 'できない'}` };
});
await check('run dist exists', () => ({ ok: fs.existsSync(path.join(runDir, 'dist', 'index.html')), detail: rel(path.join(runDir, 'dist')) }));

// ページの確認は、ブラウザがあり、port が応答し、pid がこの run のものと確認できたときだけ行う。
if (chromium && fs.existsSync(chromiumPath) && serving.ok && alive.ok && (identity.ok || owner.ok)) {
  let browser = null;
  try {
    browser = await chromium.launch();
    const page = await browser.newPage();
    await page.goto(state.url);
    await check('html[data-ready="true"]', async () => {
      try {
        await page.waitForSelector('html[data-ready="true"]', { timeout: 10_000, state: 'attached' });
        return { ok: true };
      } catch {
        return { ok: false, detail: '10 秒以内に data-ready にならない' };
      }
    });
    await check('window.__mdeE2E（VITE_E2E ビルド）', async () => ({
      ok: await page.evaluate(() => typeof window.__mdeE2E === 'object' && window.__mdeE2E !== null),
    }));
    await check('doc-title が出ている', async () => {
      const title = await page.getByTestId('doc-title').textContent({ timeout: 3000 }).catch(() => null);
      return { ok: title !== null, detail: String(title) };
    });
  } catch (e) {
    await check('ブラウザでの確認', () => ({ ok: false, detail: `ブラウザを起動できない: ${String(e.message ?? e).split('\n')[0]}` }));
  } finally {
    await browser?.close().catch(() => {});
  }
} else {
  await check('ページの確認（data-ready、window.__mdeE2E）', () => ({ ok: false, detail: '前提の項目が FAIL のため確認していない' }));
}
console.log(failed === 0 ? 'doctor OK' : `doctor: ${failed} 件 FAIL`);
process.exit(failed === 0 ? 0 : 1);
