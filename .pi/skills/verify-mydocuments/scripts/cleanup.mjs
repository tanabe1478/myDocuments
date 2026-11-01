#!/usr/bin/env node
// この run が起動したプロセスだけを止める（state ファイルに記録した pid。プロセス名では止めない）。
// 証跡（evidence/、ログ、state.json）は消さない。ビルド出力 dist は消す。
// 止める前に、pid がこの run のものかを確かめる（ps が使えない sandbox では lsof で確かめる。lib.mjs の verifyOwnership）。
// 確認できない pid は止めず、pid と port を出して exit 1 にする。
// 使い方: node .pi/skills/verify-mydocuments/scripts/cleanup.mjs --run-id <id>
import fs from 'node:fs';
import path from 'node:path';
import {
  TAURI_BIN,
  isAlive,
  listenersOf,
  parseArgs,
  portOpen,
  readState,
  rel,
  resolveRun,
  sleep,
  verifyOwnership,
  writeState,
} from './lib.mjs';

const args = parseArgs(process.argv.slice(2));
const { runDir, statePath } = resolveRun(args);
const state = readState(statePath);

async function stop(label, pid, ownership) {
  if (!pid || !isAlive(pid)) {
    console.log(`${label}: 既に止まっています（pid ${pid ?? '-'}）`);
    return true;
  }
  // pid の再利用で別のプロセスを止めないよう、この run のものと確認できたときだけ止める。
  const owner = verifyOwnership({ pid, ...ownership });
  if (!owner.ok) {
    console.error(`${label}: pid ${pid} を止めません（${owner.method}: ${owner.detail}）。port ${state.port}。手動で確認して止めてください。`);
    return false;
  }
  console.log(`${label}: pid ${pid} はこの run のプロセスです（${owner.method}）`);
  process.kill(pid, 'SIGTERM');
  for (let i = 0; i < 20 && isAlive(pid); i++) await sleep(250);
  if (isAlive(pid)) {
    process.kill(pid, 'SIGKILL');
    for (let i = 0; i < 20 && isAlive(pid); i++) await sleep(100);
  }
  console.log(`${label}: pid ${pid} を止めました`);
  return !isAlive(pid);
}

let ok = true;
if (state.tauri?.pid) ok = (await stop('tauri', state.tauri.pid, { kind: 'tauri', bin: TAURI_BIN })) && ok;
ok = (await stop('preview', state.pid, { kind: 'preview', runDir, port: state.port })) && ok;

const distDir = path.join(runDir, 'dist');
if (ok && fs.existsSync(distDir)) {
  fs.rmSync(distDir, { recursive: true, force: true });
  console.log(`removed ${rel(distDir)}`);
}

// port が空いたこと。lsof が使えなくても、接続を試して確かめる。
const owners = listenersOf(state.port);
const open = await portOpen(state.port);
if ((owners ?? []).length > 0 || open) {
  console.error(`port ${state.port} がまだ使われています（LISTEN=${owners === null ? 'lsof が使えず不明' : `[${owners.join(',')}]`}、接続${open ? 'できる' : 'できない'}）`);
  ok = false;
} else {
  console.log(`port ${state.port}: LISTEN なし${owners === null ? '（lsof は使えず、接続できないことで確認）' : ''}`);
}
state.cleanedUpAt = new Date().toISOString();
state.cleanupOk = ok;
writeState(statePath, state);
console.log(ok ? `cleanup OK（証跡は ${rel(runDir)} に残っています）` : 'cleanup 未完了');
process.exit(ok ? 0 : 1);
