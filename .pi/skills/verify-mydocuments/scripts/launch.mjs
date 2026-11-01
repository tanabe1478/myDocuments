#!/usr/bin/env node
// Web UI（VITE_E2E=1 のビルド）を run 専用ディレクトリへビルドし、空きポートで preview を起動する。
// 使い方: node .pi/skills/verify-mydocuments/scripts/launch.mjs [--run-id <id>] [--port <port>]
// 出力の RUN_ID / RUN_DIR / URL / PID を、以降の script に渡す。
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { ARTIFACTS, ROOT, fail, isAlive, newRunId, parseArgs, readState, rel, sleep, writeState } from './lib.mjs';

const args = parseArgs(process.argv.slice(2));
const runId = typeof args['run-id'] === 'string' ? args['run-id'] : newRunId();
if (!/^[A-Za-z0-9._-]+$/.test(runId)) fail(`run-id に使えない文字があります: ${runId}`);
const runDir = path.join(ARTIFACTS, runId);
const statePath = path.join(runDir, 'state.json');
const distDir = path.join(runDir, 'dist');

if (fs.existsSync(statePath)) {
  const old = readState(statePath);
  if (isAlive(old.pid)) fail(`この run は起動済みです（pid ${old.pid}）。先に cleanup.mjs を実行してください。`);
}
fs.mkdirSync(runDir, { recursive: true });

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

// 1. ビルド。VITE_E2E=1 で、メモリ実装の DocumentBridge を含める。出力は run 専用（repo の dist-e2e は触らない）。
const viteBin = path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js');
if (!fs.existsSync(viteBin)) fail('node_modules/vite がありません。リポジトリのルートで npm ci を実行してください。');
const buildLog = fs.openSync(path.join(runDir, 'build.log'), 'w');
console.log('building (VITE_E2E=1) ...');
const build = spawnSync(process.execPath, [viteBin, 'build', '--outDir', distDir, '--emptyOutDir'], {
  cwd: ROOT,
  env: { ...process.env, VITE_E2E: '1' },
  stdio: ['ignore', buildLog, buildLog],
  timeout: 180_000,
});
if (build.status !== 0) fail(`ビルドに失敗しました（exit ${build.status}）。${rel(path.join(runDir, 'build.log'))} を見てください。`);

// 2. preview を空きポートで起動。pid が vite 自身になるよう、npx を挟まず node で直接起動する。
const port = args.port ? Number(args.port) : await freePort();
const previewLog = fs.openSync(path.join(runDir, 'preview.log'), 'w');
const child = spawn(
  process.execPath,
  [viteBin, 'preview', '--outDir', distDir, '--host', '127.0.0.1', '--port', String(port), '--strictPort'],
  { cwd: ROOT, detached: true, stdio: ['ignore', previewLog, previewLog] },
);
child.unref();
const url = `http://127.0.0.1:${port}/`;
const state = { runId, runDir: rel(runDir), pid: child.pid, port, url, startedAt: new Date().toISOString(), tauri: null };
writeState(statePath, state);

// 3. ready: HTTP 200。html[data-ready="true"] と window.__mdeE2E は doctor.mjs が確かめる。
let ready = false;
for (let i = 0; i < 120 && !ready; i++) {
  if (!isAlive(child.pid)) break;
  try {
    ready = (await fetch(url)).status === 200;
  } catch {
    /* まだ起動中 */
  }
  if (!ready) await sleep(500);
}
if (!ready) {
  console.error(`preview が ready になりませんでした。${rel(path.join(runDir, 'preview.log'))} を見て、cleanup.mjs を実行してください。`);
  process.exit(1);
}
console.log(`RUN_ID=${runId}`);
console.log(`RUN_DIR=${rel(runDir)}`);
console.log(`URL=${url}`);
console.log(`PID=${child.pid}`);
