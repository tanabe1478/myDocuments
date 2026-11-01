#!/usr/bin/env node
// macOS の Tauri デスクトップアプリ（debug ビルド）を、観測だけの範囲で扱う。OS へのキー入力・マウス操作は送らない。
// 使い方（いずれも --run-id は launch.mjs の出力）:
//   node .pi/skills/verify-mydocuments/scripts/tauri.mjs build                       debug ビルド（数分かかる）。実行ファイルを作る
//   node .pi/skills/verify-mydocuments/scripts/tauri.mjs start --run-id <id> [--doc <markdown>] [--prefs <preferences.json>]
//   node .pi/skills/verify-mydocuments/scripts/tauri.mjs windows --run-id <id>        この run の窓の一覧（CGWindowList）
//   node .pi/skills/verify-mydocuments/scripts/tauri.mjs shot --run-id <id> --name <name>   窓 1 枚を screencapture -l で撮る
//   node .pi/skills/verify-mydocuments/scripts/tauri.mjs stop --run-id <id>           この run が起動した pid だけを止める
// HOME と CFFIXED_USER_HOME（Cocoa の NSHomeDirectory が従う。WebKit の保存領域用）は run 専用ディレクトリへ向ける（アプリのデータ領域は <run>/tauri-home/Library/Application Support/<identifier>/）。
// 隔離の確認は 2 つ: (1) 起動したプロセスの環境が run 専用 HOME か（ps -E。ps が使えなければ確認不能）、
// (2) アプリ自身が run 側の Library に書いたエントリがあるか（start が置いた session.json と preferences.json は除く）。どちらかが成立しなければ stop は exit 1。
// 加えて、実ユーザーの Library にある既知の場所の署名が start と stop で同じことも見る（既知の場所だけ。限界は SKILL.md の Cleanup 節）。
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOT, TAURI_BIN, appCreatedUnder, fail, homeEnvOf, isAlive, parseArgs, readState, rel, resolveRun, sleep, treeSignature, verifyOwnership, writeState } from './lib.mjs';

if (process.platform !== 'darwin') fail('tauri.mjs は macOS 専用です（窓の特定に CGWindowList、撮影に screencapture を使います）。');
const here = path.dirname(fileURLToPath(import.meta.url));
const args = parseArgs(process.argv.slice(2));
const sub = args._[0];
const BIN = TAURI_BIN;
const conf = JSON.parse(fs.readFileSync(path.join(ROOT, 'src-tauri', 'tauri.conf.json'), 'utf8'));
const IDENTIFIER = conf.identifier;
// HOME を付け替えても、実ユーザーのホームに作られうる場所（識別子またはバイナリ名で決まるもの）。start と stop で中身の署名を比べる。
const BIN_NAME = path.basename(BIN);
const realLibrary = path.join(os.homedir(), 'Library');
const REAL_PATHS = [
  path.join(realLibrary, 'Application Support', IDENTIFIER),
  path.join(realLibrary, 'WebKit', IDENTIFIER),
  path.join(realLibrary, 'WebKit', BIN_NAME),
  path.join(realLibrary, 'Caches', IDENTIFIER),
  path.join(realLibrary, 'Caches', BIN_NAME),
  path.join(realLibrary, 'HTTPStorages', IDENTIFIER),
  path.join(realLibrary, 'Preferences', `${IDENTIFIER}.plist`),
  path.join(realLibrary, 'Saved Application State', `${IDENTIFIER}.savedState`),
];
const realSignatures = () => Object.fromEntries(REAL_PATHS.map((p) => [p, treeSignature(p)]));

function windowsOf(pid) {
  const r = spawnSync('swift', [path.join(here, 'cgwindows.swift')], { encoding: 'utf8', timeout: 60_000 });
  if (r.status !== 0) fail(`cgwindows.swift に失敗しました: ${r.stderr}`);
  return JSON.parse(r.stdout).filter((w) => w.pid === pid);
}

function tauriOf(statePath) {
  const state = readState(statePath);
  if (!state.tauri?.pid) fail('この run では Tauri を start していません。');
  return state;
}

if (sub === 'build') {
  console.log('npx tauri build --debug --no-bundle ...（フロントエンドは repo の dist/ に出力されます）');
  const r = spawnSync('npx', ['tauri', 'build', '--debug', '--no-bundle'], { cwd: ROOT, stdio: 'inherit', timeout: 600_000 });
  if (r.status !== 0) fail(`tauri build に失敗しました（exit ${r.status}）`);
  console.log(`BIN=${rel(BIN)}`);
} else if (sub === 'start') {
  const { runDir, statePath } = resolveRun(args);
  const state = readState(statePath);
  if (state.tauri?.pid && isAlive(state.tauri.pid)) fail(`この run の Tauri は起動済みです（pid ${state.tauri.pid}）。`);
  if (!fs.existsSync(BIN)) fail(`実行ファイルがありません: ${rel(BIN)}。先に tauri.mjs build を実行してください。`);
  const home = path.join(runDir, 'tauri-home');
  const appDir = path.join(home, 'Library', 'Application Support', IDENTIFIER);
  fs.mkdirSync(appDir, { recursive: true });
  // 起動時に文書が開くよう、session.json（前回の文書）を run 専用の領域へ置く。
  const docPath = path.resolve(typeof args.doc === 'string' ? args.doc : path.join(home, 'sample.md'));
  if (typeof args.doc !== 'string') {
    fs.writeFileSync(docPath, '# 窓の確認\n\n没入型 Markdown エディタの Tauri 版を、run 専用の HOME で起動しています。\n\n- 一つ目の項目\n- 二つ目の項目\n');
  }
  fs.writeFileSync(path.join(appDir, 'session.json'), `${JSON.stringify({ lastPath: docPath }, null, 2)}\n`);
  if (typeof args.prefs === 'string') fs.copyFileSync(path.resolve(args.prefs), path.join(appDir, 'preferences.json'));
  const realBefore = realSignatures();
  const log = fs.openSync(path.join(runDir, 'tauri.log'), 'w');
  const child = spawn(BIN, [], { cwd: ROOT, detached: true, stdio: ['ignore', log, log], env: { ...process.env, HOME: home, CFFIXED_USER_HOME: home } });
  child.unref();
  state.tauri = { pid: child.pid, home: rel(home), docPath: rel(docPath).startsWith('..') ? docPath : rel(docPath), startedAt: new Date().toISOString(), realSignaturesBefore: realBefore };
  writeState(statePath, state);
  await sleep(1500);
  console.log(isAlive(child.pid) ? `TAURI_PID=${child.pid}` : 'Tauri がすぐに終了しました。tauri.log を見てください。');
  console.log(`TAURI_HOME=${rel(home)}`);
  if (!isAlive(child.pid)) process.exit(1);
} else if (sub === 'windows') {
  const { statePath } = resolveRun(args);
  const state = tauriOf(statePath);
  console.log(JSON.stringify(windowsOf(state.tauri.pid), null, 2));
} else if (sub === 'shot') {
  const { runDir, statePath } = resolveRun(args);
  const state = tauriOf(statePath);
  if (!isAlive(state.tauri.pid)) fail('Tauri のプロセスが既に終了しています。');
  const name = typeof args.name === 'string' ? args.name : 'window';
  let win = null;
  // 窓は notifyReady（最初の描画の後）まで非表示。表示されるまで待つ。
  for (let i = 0; i < 40 && !win; i++) {
    win = windowsOf(state.tauri.pid).find((w) => w.layer === 0 && w.width > 200 && w.height > 200 && w.onscreen);
    if (!win) await sleep(750);
  }
  if (!win) fail('この run の Tauri の窓が見つかりません（表示されていない、または画面が使えない環境）。');
  await sleep(1500); // 描画の安定を待つ
  const outDir = path.join(runDir, 'evidence', 'tauri');
  fs.mkdirSync(outDir, { recursive: true });
  const png = path.join(outDir, `${name}.png`);
  const r = spawnSync('screencapture', ['-x', '-o', '-l', String(win.id), png], { encoding: 'utf8' });
  if (r.status !== 0 || !fs.existsSync(png) || fs.statSync(png).size === 0) fail(`screencapture に失敗しました: ${r.stderr}`);
  const appDir = path.join(ROOT, state.tauri.home, 'Library', 'Application Support', IDENTIFIER);
  const home = path.join(ROOT, state.tauri.home);
  const isolation = { homeEnvIsRunHome: homeEnvOf(state.tauri.pid, home), appCreatedUnderRunHome: appCreatedUnder(home, IDENTIFIER) };
  const info = { window: win, png: rel(png), appDataFiles: fs.existsSync(appDir) ? fs.readdirSync(appDir) : [], isolation, pid: state.tauri.pid, capturedAt: new Date().toISOString() };
  fs.writeFileSync(path.join(outDir, `${name}.json`), `${JSON.stringify(info, null, 2)}\n`);
  console.log(`window id=${win.id} ${win.width}x${win.height} name=${JSON.stringify(win.name)}`);
  console.log(`isolation: homeEnvIsRunHome=${isolation.homeEnvIsRunHome} appCreatedUnderRunHome=${isolation.appCreatedUnderRunHome.length} 件`);
  console.log(`evidence: ${rel(png)} (+ .json)`);
} else if (sub === 'stop') {
  const { statePath } = resolveRun(args);
  const state = tauriOf(statePath);
  const pid = state.tauri.pid;
  const home = path.join(ROOT, state.tauri.home);
  let stopped = !isAlive(pid);
  // 止める前に、起動したプロセスの環境が run 専用 HOME であることを確かめる（生きている間だけ読める）。
  const envIsRunHome = stopped ? null : homeEnvOf(pid, home);
  if (!stopped) {
    // この run が起動した pid かを確かめてから止める（ps が使えなければ lsof で確かめる）。確認できなければ止めない。
    const owner = verifyOwnership({ pid, kind: 'tauri', bin: BIN });
    if (!owner.ok) fail(`pid ${pid} を止めません（${owner.method}: ${owner.detail}）。手動で確認して止めてください。`);
    process.kill(pid, 'SIGTERM');
    for (let i = 0; i < 20 && isAlive(pid); i++) await sleep(250);
    if (isAlive(pid)) process.kill(pid, 'SIGKILL');
    await sleep(200);
    stopped = !isAlive(pid);
  }
  // 実ユーザーのデータ領域に触れていないこと（start 時と同じ署名。ファイルの追加・変更・サイズ変更があれば検出する）。
  const before = state.tauri.realSignaturesBefore ?? {};
  const now = realSignatures();
  const touched = REAL_PATHS.filter((p) => before[p] !== now[p]);
  const created = appCreatedUnder(home, IDENTIFIER);
  // 隔離の確認: 環境が run 専用 HOME（ps -E）か、アプリが run 側に書いたエントリがある。shot が先に記録していればそれも使う。
  const confirmed = envIsRunHome === true || created.length > 0;
  console.log(`tauri pid ${pid} stopped=${stopped}; real data paths untouched=${touched.length === 0}`);
  console.log(`isolation: homeEnvIsRunHome=${envIsRunHome === null ? 'unknown（ps が使えない、または既に終了）' : envIsRunHome} appCreatedUnderRunHome=${created.length} 件${created.length ? ` (例: ${created.slice(0, 3).join(', ')})` : ''} confirmed=${confirmed}`);
  state.tauri.isolation = { checkedAt: new Date().toISOString(), homeEnvIsRunHome: envIsRunHome, appCreatedUnderRunHome: created, confirmed };
  writeState(statePath, state);
  if (touched.length > 0) console.error(`実ユーザーの領域が変わっています: ${touched.join(', ')}`);
  if (!confirmed) console.error('Tauri が run 専用 HOME で動いた証拠がありません（環境の確認も、run 側に書かれたデータもない）。隔離できていない可能性があります。');
  process.exit(stopped && touched.length === 0 && confirmed ? 0 : 1);
} else {
  fail('サブコマンドは build / start / windows / shot / stop のいずれか。');
}
