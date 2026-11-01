// Tauri 実機（macOS）の計測: 起動時間（cold / warm）、全プロセス合計の常駐メモリ、配布物のサイズ。
// HOME と CFFIXED_USER_HOME を計測用の run ディレクトリへ向けて起動する（実ユーザーのアプリデータには触れない）。
// OS へのキー入力・マウス操作は送らない。窓の出現は CGWindowList（Accessibility 権限不要）で観測する。
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { treeSignature } from '../../.pi/skills/verify-mydocuments/scripts/lib.mjs';
import { OUT_DIR, ROOT, dirSize, ensureDir, failedItem, item, rel, sh, sleep, stats } from './util.mjs';

const conf = JSON.parse(fs.readFileSync(path.join(ROOT, 'src-tauri', 'tauri.conf.json'), 'utf8'));
const IDENTIFIER = conf.identifier;
const PRODUCT = conf.productName;
const RELEASE_BIN = path.join(ROOT, 'src-tauri', 'target', 'release', 'immersive-markdown-editor');
const DEBUG_BIN = path.join(ROOT, 'src-tauri', 'target', 'debug', 'immersive-markdown-editor');
const APP_BUNDLE = path.join(ROOT, 'src-tauri', 'target', 'release', 'bundle', 'macos', `${PRODUCT}.app`);
const LAUNCH_TOOL_SRC = path.join(ROOT, 'phase0', 'bench', 'launch-measure.swift');
const LAUNCH_TOOL = path.join(OUT_DIR, 'bin', 'launch-measure');
const CGWINDOWS = path.join(ROOT, '.pi', 'skills', 'verify-mydocuments', 'scripts', 'cgwindows.swift');
const RUNS_DIR = path.join(OUT_DIR, 'tauri-runs');

const MiB = (kib) => Math.round((kib / 1024) * 10) / 10;
const isWebKit = (comm) => /com\.apple\.WebKit\.(WebContent|GPU|Networking)/.test(comm);
const webkitName = (comm) => /com\.apple\.WebKit\.(\w+)/.exec(comm)?.[1] ?? comm;

function psSnapshot() {
  const out = sh('ps', ['-axo', 'pid=,rss=,comm=']);
  if (out === null) throw new Error('ps が使えません（sandbox の制限）');
  return out
    .split('\n')
    .map((l) => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(l))
    .filter(Boolean)
    .map((m) => ({ pid: Number(m[1]), rssKiB: Number(m[2]), comm: m[3] }));
}

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
};

async function stopApp(pid, binPath) {
  // この計測が起動した pid だけを止める（コマンド行が計測対象の実行ファイルであることを確かめてから）。
  const cmd = sh('ps', ['-p', String(pid), '-o', 'command=']);
  if (cmd === null || cmd === '') return;
  if (!cmd.includes(binPath)) throw new Error(`pid ${pid} は計測対象の実行ファイルではありません: ${cmd}`);
  process.kill(pid, 'SIGTERM');
  for (let i = 0; i < 30 && alive(pid); i++) await sleep(100);
  if (alive(pid)) process.kill(pid, 'SIGKILL');
  for (let i = 0; i < 30 && alive(pid); i++) await sleep(100);
}

function ensureLaunchTool() {
  if (fs.existsSync(LAUNCH_TOOL) && fs.statSync(LAUNCH_TOOL).mtimeMs >= fs.statSync(LAUNCH_TOOL_SRC).mtimeMs) return;
  ensureDir(path.dirname(LAUNCH_TOOL));
  const r = spawnSync('swiftc', ['-O', LAUNCH_TOOL_SRC, '-o', LAUNCH_TOOL], { encoding: 'utf8', timeout: 180_000 });
  if (r.status !== 0) throw new Error(`launch-measure のコンパイルに失敗しました: ${(r.stderr || '').slice(-300)}`);
}

/** release の .app と実行ファイルを作る（tauri build --bundles app。beforeBuildCommand が repo の dist/ を作り直す）。 */
export function buildTauri(log) {
  log('npx tauri build --bundles app（差分ビルド。初回は数分）');
  const t = Date.now();
  const r = spawnSync('npx', ['tauri', 'build', '--bundles', 'app'], { cwd: ROOT, encoding: 'utf8', timeout: 1_200_000, maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`tauri build に失敗しました（exit ${r.status}）: ${(r.stderr || r.stdout || '').slice(-500)}`);
  return { seconds: Math.round((Date.now() - t) / 100) / 10 };
}

/** 実ユーザーの Library にある既知の場所の署名（skill の tauri.mjs と同じ場所）。計測の前後で比べる。 */
function realSignatures() {
  const lib = path.join(os.homedir(), 'Library');
  const bin = path.basename(RELEASE_BIN);
  const paths = [
    path.join(lib, 'Application Support', IDENTIFIER),
    path.join(lib, 'WebKit', IDENTIFIER),
    path.join(lib, 'WebKit', bin),
    path.join(lib, 'Caches', IDENTIFIER),
    path.join(lib, 'Caches', bin),
    path.join(lib, 'HTTPStorages', IDENTIFIER),
    path.join(lib, 'Preferences', `${IDENTIFIER}.plist`),
    path.join(lib, 'Saved Application State', `${IDENTIFIER}.savedState`),
  ];
  return Object.fromEntries(paths.map((p) => [p, treeSignature(p)]));
}

function prepareHome(runDir, doc) {
  const home = path.join(runDir, 'home');
  const appDir = path.join(home, 'Library', 'Application Support', IDENTIFIER);
  ensureDir(appDir);
  let docPath = null;
  if (doc) {
    ensureDir(path.join(home, 'docs'));
    docPath = path.join(home, 'docs', doc.name);
    fs.copyFileSync(doc.file, docPath);
    // 前回の文書として開き直させる（アプリのコードは変えない）。
    fs.writeFileSync(path.join(appDir, 'session.json'), `${JSON.stringify({ lastPath: docPath }, null, 2)}\n`);
  }
  return { home, docPath };
}

/**
 * 1 回起動して、窓が出るまでの時間と、settleMs 後の全プロセスの RSS を測り、止める。
 * WebKit の子プロセスは launchd の子（ppid 1）で、アプリとの親子関係では辿れない。
 * 起動前に無かった com.apple.WebKit.{WebContent,GPU,Networking} をこのアプリのものとみなす（推定）。
 */
async function launchOnce({ bin, doc, settleMs, runDir, shotPath }) {
  const { home } = prepareHome(runDir, doc);
  const before = new Set(psSnapshot().filter((p) => isWebKit(p.comm)).map((p) => p.pid));
  const r = spawnSync(LAUNCH_TOOL, [bin, '30'], {
    encoding: 'utf8',
    timeout: 60_000,
    env: { ...process.env, HOME: home, CFFIXED_USER_HOME: home },
  });
  let info;
  try {
    info = JSON.parse(r.stdout.trim());
  } catch {
    throw new Error(`launch-measure の出力が読めません: ${r.stdout || r.stderr}`);
  }
  const pid = info.pid;
  try {
    if (info.windowVisibleMs === null) throw new Error('30 秒以内に窓が出ませんでした');
    await sleep(settleMs);
    if (shotPath) takeShot(pid, shotPath);
    const snap = psSnapshot();
    const main = snap.find((p) => p.pid === pid);
    if (!main) throw new Error('アプリのプロセスが既にありません（クラッシュ？）');
    const kids = snap.filter((p) => isWebKit(p.comm) && !before.has(p.pid));
    const total = main.rssKiB + kids.reduce((s, k) => s + k.rssKiB, 0);
    return {
      windowVisibleMs: info.windowVisibleMs,
      mainMiB: MiB(main.rssKiB),
      webkit: kids.map((k) => ({ name: webkitName(k.comm), miB: MiB(k.rssKiB) })),
      totalMiB: MiB(total),
    };
  } finally {
    await stopApp(pid, bin);
  }
}

/** 窓 1 枚を screencapture -l で撮る（OS へ入力は送らない）。 */
function takeShot(pid, shotPath) {
  const r = spawnSync('swift', [CGWINDOWS], { encoding: 'utf8', timeout: 90_000 });
  if (r.status !== 0) return;
  const win = JSON.parse(r.stdout).find((w) => w.pid === pid && w.layer === 0 && w.width > 200 && w.height > 200 && w.onscreen);
  if (!win) return;
  ensureDir(path.dirname(shotPath));
  spawnSync('screencapture', ['-x', '-o', '-l', String(win.id), shotPath], { timeout: 30_000 });
}

/** 配布物のサイズ。 */
export function measureSizes() {
  const items = [];
  const g = 'size';
  const file = (id, p, metric) => {
    try {
      const bytes = fs.statSync(p).size;
      items.push(item(id, { group: g, unit: 'bytes', median: bytes, n: 1, metric }));
    } catch (e) {
      items.push(failedItem(id, g, `${rel(p)} がありません。先に tauri build --bundles app（npm run perf が実行する）`));
    }
  };
  file('size.release-binary', RELEASE_BIN, 'release ビルドの実行ファイル（strip 済み）のバイト数');
  try {
    const apparent = dirSize(APP_BUNDLE);
    const du = Number(sh('du', ['-sk', APP_BUNDLE])?.split(/\s+/)[0]) * 1024;
    items.push(item('size.app-bundle', { group: g, unit: 'bytes', median: apparent, n: 1, metric: '.app 内の全ファイルのバイト数の合計', diskBytes: Number.isFinite(du) ? du : null }));
  } catch {
    items.push(failedItem('size.app-bundle', g, `${rel(APP_BUNDLE)} がありません`));
  }
  try {
    items.push(item('size.frontend-dist', { group: g, unit: 'bytes', median: dirSize(path.join(ROOT, 'dist')), n: 1, metric: '本番のフロントエンド（repo の dist/。tauri build の beforeBuildCommand の出力）のバイト数の合計' }));
  } catch {
    items.push(failedItem('size.frontend-dist', g, 'dist/ がありません'));
  }
  return items;
}

/**
 * Tauri 実機の計測。plan: { warmRuns, memRuns }。
 * 戻り値: { items, notes }。1 つの失敗が他の場面を止めない。
 */
export async function measureTauri({ fixtures, quick, withDebug, log, shotPath }) {
  const items = [];
  const extra = {};
  const plan = quick ? { warmRuns: 3, memRuns: 2, settle: { empty: 2500, B: 3500, C: 5000 } } : { warmRuns: 7, memRuns: 5, settle: { empty: 3000, B: 4000, C: 6000 } };
  if (process.platform !== 'darwin') return { items: [failedItem('tauri.startup', 'tauri', 'macOS 専用です')], extra };
  if (!fs.existsSync(RELEASE_BIN)) return { items: [failedItem('tauri.startup', 'tauri', `${rel(RELEASE_BIN)} がありません`)], extra };
  ensureLaunchTool();
  fs.rmSync(RUNS_DIR, { recursive: true, force: true });
  const realBefore = realSignatures();
  const runId = (n) => path.join(RUNS_DIR, String(n));
  let n = 0;

  // ---- 起動（空の文書）: 最初の 1 回が cold、続く回が warm ----
  const cold = [];
  const warm = [];
  const emptyRuns = [];
  try {
    for (let i = 0; i < 1 + plan.warmRuns; i++) {
      const r = await launchOnce({ bin: RELEASE_BIN, doc: null, settleMs: plan.settle.empty, runDir: runId(n++) });
      (i === 0 ? cold : warm).push(r.windowVisibleMs);
      emptyRuns.push(r);
      log(`tauri: empty #${i} window=${r.windowVisibleMs}ms total=${r.totalMiB}MiB`);
    }
    const cmetric = 'プロセス開始（spawn 直前）から、窓が画面に出る（CGWindowList で高さ 100px 超）まで。窓は最初の描画と終了確認の受け手の準備の後に表示される（lib.rs の notifyReady）。文書の開き直しの完了は含まない';
    items.push(item('tauri.startup.release.cold', { group: 'startup', unit: 'ms', n: 1, median: cold[0], metric: `${cmetric}。この計測で最初の起動（バイナリは直前のビルド後、OS のキャッシュ状態は制御していない）`, samples: cold }));
    items.push(item('tauri.startup.release.warm', { group: 'startup', unit: 'ms', ...stats(warm, 1), metric: `${cmetric}。2 回目以降の起動`, samples: warm }));
    items.push(item('tauri.memory.release.empty', memItem(emptyRuns, '起動直後の空の文書。全プロセス（アプリ本体 + WebKit の子）の RSS 合計')));
  } catch (e) {
    for (const id of ['tauri.startup.release.cold', 'tauri.startup.release.warm', 'tauri.memory.release.empty']) {
      if (!items.some((x) => x.id === id)) items.push(failedItem(id, id.includes('memory') ? 'memory' : 'startup', e.message));
    }
  }

  // ---- 100KB（B）・1MB（C）を前回の文書として開き直させたときのメモリ ----
  for (const id of ['B', 'C']) {
    const fx = fixtures.find((f) => f.id === id);
    const runs = [];
    try {
      for (let i = 0; i < plan.memRuns; i++) {
        const r = await launchOnce({ bin: RELEASE_BIN, doc: fx, settleMs: plan.settle[id], runDir: runId(n++), shotPath: id === 'B' && i === 0 ? shotPath : null });
        runs.push(r);
        log(`tauri: ${id} #${i} window=${r.windowVisibleMs}ms total=${r.totalMiB}MiB`);
      }
      items.push(item(`tauri.memory.release.${id}`, memItem(runs, `${fx.bytes} バイトの文書（${id}）を前回の文書として起動時に開き直させ、${plan.settle[id]}ms 後の全プロセスの RSS 合計`)));
      items.push(item(`tauri.startup-with-doc.release.${id}`, { group: 'startup', unit: 'ms', ...stats(runs.map((r) => r.windowVisibleMs), 1), metric: `起動から窓が出るまで（前回の文書 ${id} あり。開き直しの完了は含まない）`, samples: runs.map((r) => r.windowVisibleMs) }));
    } catch (e) {
      items.push(failedItem(`tauri.memory.release.${id}`, 'memory', e.message));
    }
  }

  // ---- 任意: debug ビルドとの差（起動のみ） ----
  if (withDebug) {
    try {
      if (!fs.existsSync(DEBUG_BIN)) throw new Error(`${rel(DEBUG_BIN)} がありません（node .pi/skills/verify-mydocuments/scripts/tauri.mjs build）`);
      const xs = [];
      for (let i = 0; i < 1 + plan.warmRuns; i++) xs.push((await launchOnce({ bin: DEBUG_BIN, doc: null, settleMs: 1500, runDir: runId(n++) })).windowVisibleMs);
      items.push(item('tauri.startup.debug.warm', { group: 'startup', unit: 'ms', ...stats(xs.slice(1), 1), metric: 'debug ビルドの起動から窓が出るまで（空の文書、2 回目以降）', samples: xs.slice(1) }));
    } catch (e) {
      items.push(failedItem('tauri.startup.debug.warm', 'startup', e.message));
    }
  }

  // ---- 隔離の確認と後始末 ----
  const realAfter = realSignatures();
  const touched = Object.keys(realBefore).filter((p) => realBefore[p] !== realAfter[p]).map((p) => p.replace(os.homedir(), '~'));
  const created = [];
  const walk = (d) => {
    for (const e of fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }) : []) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else created.push(p);
    }
  };
  walk(path.join(runId(0), 'home', 'Library'));
  extra.isolation = {
    homeIsRunDir: true,
    runHomeLibraryFiles: created.length,
    realHomeKnownPathsChanged: touched,
    note: '実ホーム側は既知の場所（Application Support、WebKit、Caches、HTTPStorages、Preferences、Saved Application State）の署名（サイズと mtime）の前後比較。触れていないことの証明ではない。',
  };
  fs.rmSync(RUNS_DIR, { recursive: true, force: true });
  if (touched.length > 0) items.push(failedItem('tauri.isolation', 'tauri', `実ユーザーの領域が変わっています: ${touched.join(', ')}`));
  return { items, extra };
}

function memItem(runs, metric) {
  const totals = runs.map((r) => r.totalMiB);
  const s = stats(totals, 1);
  const sorted = [...runs].sort((a, b) => a.totalMiB - b.totalMiB);
  const mid = sorted[Math.floor((sorted.length - 1) / 2)];
  return {
    group: 'memory',
    unit: 'MiB',
    ...s,
    metric,
    samples: totals,
    medianRunBreakdown: { main: mid.mainMiB, webkit: mid.webkit },
    mainMedian: stats(runs.map((r) => r.mainMiB), 1).median,
    note: 'WebKit の子プロセスは「起動前に無かった com.apple.WebKit.* 」をこのアプリのものとみなす推定（親子関係では辿れない）。他のアプリが同時に WebKit を起動していれば混入する。',
  };
}
