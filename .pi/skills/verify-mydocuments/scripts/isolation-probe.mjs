#!/usr/bin/env node
// 隔離した操作（段 2）の隔離を、実際の Tauri の窓で確かめる（ADR-005 の「R5 で確かめた隔離」）。macOS 専用。OS へのキー入力・マウス操作は送らない。
// 使い方:
//   node .pi/skills/verify-mydocuments/scripts/tauri.mjs build --probe        先に、検証用のビルド（feature isolation-probe）を作る
//   node .pi/skills/verify-mydocuments/scripts/isolation-probe.mjs [--run-id <id>] [--timeout-sec 150]
//   node .pi/skills/verify-mydocuments/scripts/isolation-probe.mjs --judge-only <dir>   記録済みの結果を、判定し直すだけ（Tauri は起動しない）
// 1 つのフォアグラウンドのコマンドの中で、127.0.0.1 の受け口を立て、検証用の Tauri を run 専用の HOME で起動し、検証が終わるのを待ち、
// 窓を撮影し、Tauri と受け口を止めて、判定する。
//
// 届いたかの判定は、webview 側の自己申告ではなく、2 つの記録で行う:
//   - ネイティブ側: 検証用のコマンド（isolation_probe_canary）が書く canary.log。1 行 = 1 回の呼び出しで、行の内容は <文脈>:<経路> の名前。
//   - ネットワーク: この script が立てる 127.0.0.1 の受け口の net.log。1 行 = 1 回の接続要求（ctx= で文脈と経路を区別）。
// webview 側の自己申告（report.jsonl）は、判定には使わず、表に並べる。
// 結果: <run-dir>/evidence/isolation-probe/{judgement.json, judgement.md, canary.log, net.log, report.jsonl, tauri.log}。
// exit code: 0 = 鍵なしで届く経路がなく、対照も届いた / 2 = 鍵なしで届く経路があった（失敗）/ 3 = 検証が完了しなかった、または対照が届かなかった。
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ARTIFACTS, PROBE_BIN, ROOT, fail, newRunId, parseArgs, rel, sleep, writeState } from './lib.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const TAURI = path.join(here, 'tauri.mjs');

// ---- 判定の表（経路の一覧）----
// via: canary = ネイティブ側の記録の who、net = 受け口の記録の ctx。
// key: none = 鍵なし、leaked = 本体が鍵を渡した（漏れたと仮定）、control = 対照（届くはず）。
// needsKey: その経路が届くのに鍵が要るか。net の経路は鍵と無関係なので、届けば鍵の有無にかかわらず失敗。
const worker = 'Worker（仲介の iframe の中の blob の Worker。部品のコード）';
const relay = '仲介と同じ条件の文脈（plug: の sandbox の iframe。仲介のコードが壊された場合の上限）';
const ROWS = [
  { ctx: '本体（鍵を持つ側）', path: 'invoke（対照）', via: 'canary', id: 'main:control-invoke', key: 'control' },
  { ctx: '本体（鍵を持つ側）', path: 'webkit.messageHandlers.ipc.postMessage、鍵あり（対照）', via: 'canary', id: 'main:control-postmessage-key', key: 'control' },
  { ctx: worker, path: 'fetch ipc://localhost、鍵なし', via: 'canary', id: 'worker:fetch-ipc-nokey', key: 'none' },
  { ctx: worker, path: 'XHR ipc://localhost、鍵なし', via: 'canary', id: 'worker:xhr-ipc-nokey', key: 'none' },
  { ctx: worker, path: 'fetch http://ipc.localhost、鍵なし', via: 'canary', id: 'worker:fetch-ipchttp-nokey', key: 'none' },
  { ctx: worker, path: 'postMessage で決めていない形（invoke の形、鍵つき）を仲介へ', via: 'canary', id: 'worker:postmessage-invoke', key: 'leaked' },
  { ctx: worker, path: 'fetch ipc://localhost、鍵あり', via: 'canary', id: 'worker-leaked:fetch-ipc-key', key: 'leaked' },
  { ctx: worker, path: 'XHR ipc://localhost、鍵あり', via: 'canary', id: 'worker-leaked:xhr-ipc-key', key: 'leaked' },
  { ctx: worker, path: 'fetch http://ipc.localhost、鍵あり', via: 'canary', id: 'worker-leaked:fetch-ipchttp-key', key: 'leaked' },
  { ctx: relay, path: 'fetch ipc://localhost、鍵なし', via: 'canary', id: 'relayctx:fetch-ipc-nokey', key: 'none' },
  { ctx: relay, path: 'XHR ipc://localhost、鍵なし', via: 'canary', id: 'relayctx:xhr-ipc-nokey', key: 'none' },
  { ctx: relay, path: 'fetch http://ipc.localhost、鍵なし', via: 'canary', id: 'relayctx:fetch-ipchttp-nokey', key: 'none' },
  { ctx: relay, path: 'webkit.messageHandlers.ipc.postMessage、鍵なし', via: 'canary', id: 'relayctx:postmessage-nokey', key: 'none' },
  { ctx: relay, path: 'fetch ipc://localhost、鍵あり', via: 'canary', id: 'relayctx:fetch-ipc-key', key: 'leaked' },
  { ctx: relay, path: 'XHR ipc://localhost、鍵あり', via: 'canary', id: 'relayctx:xhr-ipc-key', key: 'leaked' },
  { ctx: relay, path: 'fetch http://ipc.localhost、鍵あり', via: 'canary', id: 'relayctx:fetch-ipchttp-key', key: 'leaked' },
  { ctx: relay, path: 'webkit.messageHandlers.ipc.postMessage、鍵あり', via: 'canary', id: 'relayctx:postmessage-key', key: 'leaked' },
  { ctx: relay, path: 'window.ipc.postMessage、鍵あり', via: 'canary', id: 'relayctx:window-ipc-key', key: 'leaked' },
  ...['fetch', 'xhr', 'ws', 'importscripts', 'sse', 'nested-worker-fetch'].map((p) => ({ ctx: worker, path: `ネットワーク: ${p} → 127.0.0.1`, via: 'net', id: `worker-${p}`, key: 'none' })),
  ...['fetch', 'xhr', 'ws', 'importscripts', 'sse', 'nested-worker-fetch'].map((p) => ({ ctx: `${worker}、鍵を渡した部品`, path: `ネットワーク: ${p} → 127.0.0.1`, via: 'net', id: `worker-leaked-${p}`, key: 'leaked', needsKey: false })),
  ...['fetch', 'xhr', 'img', 'beacon', 'ws', 'nested-worker-fetch'].map((p) => ({ ctx: relay, path: `ネットワーク: ${p} → 127.0.0.1`, via: 'net', id: `relayctx-${p}`, key: 'none' })),
];

function readLines(file) {
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean) : [];
}

/** 記録（canary.log、net.log、report.jsonl）から、経路ごとの判定を作る。 */
export function judge({ canary, net, report }) {
  const reports = report.flatMap((l) => {
    try {
      return [JSON.parse(l)];
    } catch {
      return [];
    }
  });
  const control = reports.find((r) => r.ev === 'control');
  const done = reports.some((r) => r.ev === 'done');
  const rows = ROWS.map((row) => {
    const reached =
      row.via === 'canary'
        ? canary.filter((l) => l === row.id).length
        : net.filter((l) => new RegExp(`[?&]ctx=${row.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:&|$| )`).test(l)).length;
    const outcome =
      row.key === 'control'
        ? reached > 0
          ? '届いた（対照として期待どおり）'
          : '届かなかった（対照が届かない: 記録の仕組みか、呼び方が壊れている）'
        : reached === 0
          ? '届かなかった'
          : row.key === 'none' || row.needsKey === false
            ? '届いた【失敗: 鍵なしで届く経路】'
            : '届いた（鍵ありで届く経路）';
    return { context: row.ctx, path: row.path, key: row.key, via: row.via, id: row.id, reached, outcome };
  });
  // (4) 仲介が決めていない形のメッセージを受け付けない（部品を止める）ことと、BroadcastChannel の確認（自己申告ではなく本体側の記録）。
  const workerReports = reports.filter((r) => r.ev === 'worker');
  const postRows = ['probe-post-unknown', 'probe-post-forged', 'probe-post-invoke'].map((id) => {
    const r = workerReports.find((x) => x.plugin === id);
    const rejected = Boolean(r && typeof r.stopped === 'string' && r.stopped.includes('不正なメッセージ'));
    return { plugin: id, stoppedReason: r?.stopped ?? null, status: r?.status ?? null, rejectedByRelay: rejected };
  });
  const broadcast = reports.find((r) => r.ev === 'broadcast');
  const failures = rows.filter((r) => r.outcome.includes('失敗'));
  const controlFailures = rows.filter((r) => r.key === 'control' && r.reached === 0);
  const keyedReached = rows.filter((r) => r.outcome.includes('鍵ありで届く経路'));
  const postFailures = postRows.filter((r) => !r.rejectedByRelay);
  const broadcastHeard = broadcast ? broadcast.heardInMainPage : null;
  const complete = done && Boolean(control) && Boolean(control.keyCaptured) && broadcastHeard !== null;
  const verdict = failures.length > 0 ? 'FAIL' : !complete || controlFailures.length > 0 ? 'INCOMPLETE' : 'PASS';
  return { verdict, complete, keyCaptured: control?.keyCaptured ?? null, rows, postRows, postFailures: postFailures.length, broadcastHeardInMainPage: broadcastHeard, failures: failures.map((r) => `${r.context} / ${r.path}`), keyedReached: keyedReached.map((r) => `${r.context} / ${r.path}`), controlFailures: controlFailures.map((r) => r.path), selfReport: { control, workers: workerReports, relayContext: reports.find((r) => r.ev === 'relay-context') ?? null } };
}

function markdown(j) {
  const lines = [`# 隔離の検証の判定: ${j.verdict}`, '', `完了: ${j.complete}、鍵を取り出せたか: ${j.keyCaptured}`, '', '| 文脈 | 経路 | 鍵 | 判定の記録 | 回数 | 結果 |', '|---|---|---|---|---|---|'];
  for (const r of j.rows) lines.push(`| ${r.context} | ${r.path} | ${r.key} | ${r.via === 'canary' ? 'ネイティブ側の記録' : '受け口の記録'} | ${r.reached} | ${r.outcome} |`);
  lines.push('', '仲介が決めていない形のメッセージを受け付けず、部品を止めたか（本体の記録）:', '');
  for (const r of j.postRows) lines.push(`- ${r.plugin}: ${r.rejectedByRelay ? '止めた' : '止めていない'}（${r.stoppedReason ?? 'なし'}）`);
  lines.push('', `BroadcastChannel（Worker から本体へ）: 本体のページが聞いたメッセージ ${JSON.stringify(j.broadcastHeardInMainPage)}`, '');
  return `${lines.join('\n')}\n`;
}

// ---- 127.0.0.1 の受け口 ----
function startNetCanary(logFile) {
  fs.writeFileSync(logFile, '');
  const server = http.createServer((req, res) => {
    fs.appendFileSync(logFile, `${req.method} ${req.url}\n`);
    res.writeHead(200, { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'text/javascript' });
    res.end('void 0;');
  });
  server.on('upgrade', (req, socket) => {
    fs.appendFileSync(logFile, `UPGRADE ${req.url}\n`);
    socket.destroy();
  });
  return new Promise((resolve) => {
    // 127.0.0.1 だけで待ち受ける（外部のネットワークには出ない）。
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

function runTauri(sub, extra) {
  return spawnSync('node', [TAURI, sub, ...extra], { cwd: ROOT, encoding: 'utf8', timeout: 180_000 });
}

const args = parseArgs(process.argv.slice(2));

if (typeof args['judge-only'] === 'string') {
  const dir = path.resolve(args['judge-only']);
  const j = judge({ canary: readLines(path.join(dir, 'canary.log')), net: readLines(path.join(dir, 'net.log')), report: readLines(path.join(dir, 'report.jsonl')) });
  console.log(markdown(j));
  console.log(`VERDICT=${j.verdict}`);
  process.exit(j.verdict === 'PASS' ? 0 : j.verdict === 'FAIL' ? 2 : 3);
}

if (process.platform !== 'darwin') fail('isolation-probe.mjs は macOS 専用です。');
if (!fs.existsSync(PROBE_BIN)) fail(`検証用の実行ファイルがありません: ${rel(PROBE_BIN)}。先に tauri.mjs build --probe を実行してください。`);

const runId = typeof args['run-id'] === 'string' ? args['run-id'] : `probe-${newRunId()}`;
const runDir = path.join(ARTIFACTS, runId);
const outDir = path.join(runDir, 'evidence', 'isolation-probe');
fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });
writeState(path.join(runDir, 'state.json'), { runId, kind: 'isolation-probe' });
const timeoutSec = Number(args['timeout-sec'] ?? 150);

const { server, port } = await startNetCanary(path.join(outDir, 'net.log'));
let startResult;
let verdictCode = 3;
try {
  // 対照: 受け口の記録が動いていること（この script 自身が 127.0.0.1 に 1 回つなぐ）。
  await fetch(`http://127.0.0.1:${port}/fetch?ctx=node-control`);
  startResult = runTauri('start', ['--run-id', runId, '--probe', '--probe-out', outDir, '--probe-net', `http://127.0.0.1:${port}`]);
  process.stdout.write(startResult.stdout ?? '');
  if (startResult.status !== 0) throw new Error(`tauri start に失敗しました: ${startResult.stderr}`);
  const deadline = Date.now() + timeoutSec * 1000;
  let finished = false;
  while (Date.now() < deadline) {
    if (readLines(path.join(outDir, 'report.jsonl')).some((l) => l.includes('"ev":"done"'))) {
      finished = true;
      break;
    }
    await sleep(1000);
  }
  console.log(`検証の完了: ${finished}（${timeoutSec} 秒まで待つ）`);
  const shot = runTauri('shot', ['--run-id', runId, '--name', 'isolation-probe']);
  console.log(shot.status === 0 ? shot.stdout : `shot に失敗（参考の撮影のため続行）: ${shot.stderr}`);
} catch (e) {
  console.error(String(e));
} finally {
  const stop = runTauri('stop', ['--run-id', runId]);
  process.stdout.write(stop.stdout ?? '');
  process.stderr.write(stop.stderr ?? '');
  // 受け口を止める（run のあいだだけ立てる）。
  await new Promise((r) => server.close(r));
  server.closeAllConnections?.();
}

const tauriLog = path.join(runDir, 'tauri.log');
if (fs.existsSync(tauriLog)) fs.copyFileSync(tauriLog, path.join(outDir, 'tauri.log'));
const records = { canary: readLines(path.join(outDir, 'canary.log')), net: readLines(path.join(outDir, 'net.log')), report: readLines(path.join(outDir, 'report.jsonl')) };
const j = judge(records);
const nodeControl = records.net.some((l) => l.includes('ctx=node-control'));
j.netControlReached = nodeControl;
if (!nodeControl && j.verdict === 'PASS') j.verdict = 'INCOMPLETE';
fs.writeFileSync(path.join(outDir, 'judgement.json'), `${JSON.stringify(j, null, 2)}\n`);
fs.writeFileSync(path.join(outDir, 'judgement.md'), markdown(j));
console.log(markdown(j));
console.log(`受け口の対照（この script から 127.0.0.1 へ）: ${nodeControl}`);
console.log(`VERDICT=${j.verdict}`);
console.log(`EVIDENCE=${rel(outDir)}`);
if (process.env.YORISHIRO_EVIDENCE_DIR) {
  const dest = path.join(process.env.YORISHIRO_EVIDENCE_DIR, 'attempt-1', 'isolation-probe');
  fs.mkdirSync(dest, { recursive: true });
  for (const f of fs.readdirSync(outDir)) fs.copyFileSync(path.join(outDir, f), path.join(dest, f));
  const shotDir = path.join(runDir, 'evidence', 'tauri');
  if (fs.existsSync(shotDir)) for (const f of fs.readdirSync(shotDir)) fs.copyFileSync(path.join(shotDir, f), path.join(dest, `tauri-${f}`));
}
verdictCode = j.verdict === 'PASS' ? 0 : j.verdict === 'FAIL' ? 2 : 3;
process.exit(verdictCode);
