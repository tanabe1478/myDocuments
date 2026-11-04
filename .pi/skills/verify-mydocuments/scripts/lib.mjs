// verify-mydocuments の各 script が共有する処理（直接は実行しない）。
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
/** リポジトリのルート（.pi/skills/verify-mydocuments/scripts から 4 つ上）。 */
export const ROOT = path.resolve(here, '..', '..', '..', '..');
export const ARTIFACTS = path.join(ROOT, 'artifacts', 'verify-mydocuments');
/** Tauri の debug ビルドの実行ファイル。 */
export const TAURI_BIN = path.join(ROOT, 'src-tauri', 'target', 'debug', 'immersive-markdown-editor');
/** 隔離の検証用（Cargo の feature isolation-probe）の debug ビルド。通常の実行ファイルを上書きしないよう、別の target ディレクトリに作る。 */
export const PROBE_TARGET_DIR = path.join(ROOT, 'src-tauri', 'target', 'isolation-probe');
export const PROBE_BIN = path.join(PROBE_TARGET_DIR, 'debug', 'immersive-markdown-editor');

/** `--key value` と `--flag` を読む。位置引数は _ に入る。 */
export function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) out[key] = true;
      else {
        out[key] = next;
        i++;
      }
    } else out._.push(a);
  }
  return out;
}

export function newRunId() {
  const t = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  return `${t}-${process.pid}`;
}

/** --run-id か環境変数 VERIFY_RUN_ID から、run の情報を求める。 */
export function resolveRun(args, { mustExist = true } = {}) {
  const runId = args['run-id'] || process.env.VERIFY_RUN_ID;
  if (!runId || runId === true) fail('--run-id（または環境変数 VERIFY_RUN_ID）が必要です。launch の出力にある RUN_ID を渡してください。');
  if (!/^[A-Za-z0-9._-]+$/.test(runId)) fail(`run-id に使えない文字があります: ${runId}`);
  const runDir = path.join(ARTIFACTS, runId);
  const statePath = path.join(runDir, 'state.json');
  if (mustExist && !fs.existsSync(statePath)) fail(`state ファイルがありません: ${path.relative(ROOT, statePath)}`);
  return { runId, runDir, statePath };
}

export function readState(statePath) {
  return JSON.parse(fs.readFileSync(statePath, 'utf8'));
}

export function writeState(statePath, state) {
  fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
}

export function fail(message, code = 1) {
  console.error(`ERROR: ${message}`);
  process.exit(code);
}

export function isAlive(pid) {
  if (!Number.isInteger(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

/**
 * 外部コマンドを実行する。起動できない（sandbox で禁止されている、コマンドがない）ときは null。
 * spawnSync は、起動に失敗しても例外を投げず stdout が undefined の結果を返すので、ここで吸収する。
 */
function tryRun(cmd, args, options = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 15_000, ...options });
  if (r.error || typeof r.stdout !== 'string') return null;
  return r;
}

/** pid の実行コマンド行（ps）。ps が使えない、pid がいない場合は null。 */
export function commandOf(pid) {
  const r = tryRun('ps', ['-p', String(pid), '-o', 'command=']);
  if (!r || r.status !== 0) return null;
  const s = r.stdout.trim();
  return s || null;
}

/**
 * pid が起動時に受け取った環境変数のうち、HOME と CFFIXED_USER_HOME が home を指しているか（ps -E）。
 * 戻り値: true / false、ps が使えない・環境を読めないときは null（確認できない）。
 * 値は「 HOME=<home>」の部分文字列で照合する（パスに空白があっても誤判定しない）。
 */
export function homeEnvOf(pid, home) {
  const r = tryRun('ps', ['-E', '-ww', '-p', String(pid), '-o', 'command=']);
  if (!r || r.status !== 0) return null;
  const s = ` ${r.stdout}`;
  if (!s.includes(' HOME=')) return null; // 環境が出力されていない（権限がない場合など）
  const at = (key) => new RegExp(`[ ]${key}=${home.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?= [A-Za-z_][A-Za-z0-9_]*=|\\s*$)`).test(s);
  return at('HOME') && at('CFFIXED_USER_HOME');
}

/**
 * run 専用 HOME の Library 以下に、アプリ自身が作ったエントリの相対パス一覧。
 * start が置いた session.json と preferences.json は除く。これがあれば、アプリが run 側の HOME を使って書いた証拠になる。
 */
export function appCreatedUnder(home, identifier) {
  const lib = path.join(home, 'Library');
  const seeded = new Set([
    path.join(lib, 'Application Support', identifier, 'session.json'),
    path.join(lib, 'Application Support', identifier, 'preferences.json'),
  ]);
  const out = [];
  const walk = (p) => {
    for (const name of fs.existsSync(p) ? fs.readdirSync(p).sort() : []) {
      const child = path.join(p, name);
      if (seeded.has(child)) continue;
      if (fs.lstatSync(child).isDirectory()) walk(child);
      out.push(path.relative(home, child));
    }
  };
  walk(lib);
  return out.filter((e) => e !== path.join('Library', 'Application Support') && e !== path.join('Library', 'Application Support', identifier));
}

/**
 * TCP port を LISTEN している pid の一覧（lsof）。
 * lsof が使えないときは null（「誰も LISTEN していない」と区別する）。
 */
export function listenersOf(port) {
  const r = tryRun('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fp']);
  if (!r || (r.status !== 0 && r.status !== 1)) return null; // lsof は該当なしのとき exit 1
  return r.stdout
    .split('\n')
    .filter((l) => l.startsWith('p'))
    .map((l) => Number(l.slice(1)));
}

/** pid が開いている実行ファイル（lsof の txt）のパス一覧。lsof が使えない、pid がいない場合は null。 */
export function executablesOf(pid) {
  const r = tryRun('lsof', ['-nP', '-a', '-p', String(pid), '-d', 'txt', '-Fn']);
  if (!r || r.status !== 0) return null;
  return r.stdout
    .split('\n')
    .filter((l) => l.startsWith('n'))
    .map((l) => l.slice(1));
}

/** port に TCP で接続できるか（ps も lsof も使えない環境でも判定できる）。 */
export function portOpen(port) {
  return new Promise((resolve) => {
    const sock = net.connect({ host: '127.0.0.1', port });
    const done = (v) => {
      sock.destroy();
      resolve(v);
    };
    sock.setTimeout(1500, () => done(false));
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
  });
}

/**
 * state に記録した pid が、この run が起動したプロセスかを確かめる。pid の再利用で別のプロセスを止めないための照合。
 * プロセス名では判定しない。ps が使えれば、コマンド行がこの run のパスを含むこと。ps が使えなければ
 * lsof（preview は port の LISTEN 所有者が pid であること、tauri は開いている実行ファイルが BIN であること）。
 * どちらも使えなければ ok は false（確認できないものは止めない）。
 * kind: 'preview'（runDir と port が必要）または 'tauri'（bin が必要）。
 */
export function verifyOwnership({ pid, kind, runDir, port, bin }) {
  const cmd = commandOf(pid);
  if (kind === 'preview') {
    if (cmd !== null) {
      const ok = cmd.includes('preview') && cmd.includes(path.join(runDir, 'dist'));
      return { ok, method: 'ps コマンド行', detail: ok ? 'run の dist を指している' : `コマンド行が run の dist を含まない: ${cmd}` };
    }
    const owners = listenersOf(port);
    if (owners !== null) {
      const ok = owners.includes(pid);
      return { ok, method: 'lsof の port 所有者（ps は使えない）', detail: `port ${port} の LISTEN=[${owners.join(',')}] pid=${pid}` };
    }
  } else if (kind === 'tauri') {
    if (cmd !== null) {
      const ok = cmd.includes(bin);
      return { ok, method: 'ps コマンド行', detail: ok ? 'BIN を実行している' : `コマンド行が BIN と違う: ${cmd}` };
    }
    const exes = executablesOf(pid);
    if (exes !== null) {
      const ok = exes.includes(bin);
      return { ok, method: 'lsof の実行ファイル（ps は使えない）', detail: ok ? 'BIN を開いている' : `実行ファイルが BIN と違う: ${exes.join(', ')}` };
    }
  }
  return { ok: false, method: 'なし', detail: 'ps も lsof も使えず、この run のプロセスか確認できない' };
}

/** ディレクトリまたはファイルの中身の署名（相対パス、サイズ、mtime の一覧の SHA-256）。なければ null。 */
export function treeSignature(target) {
  if (!fs.existsSync(target)) return null;
  const entries = [];
  const walk = (p, relPath) => {
    const st = fs.lstatSync(p);
    entries.push(`${relPath}\t${st.isDirectory() ? 'd' : st.size}\t${Math.round(st.mtimeMs)}`);
    if (st.isDirectory()) for (const name of fs.readdirSync(p).sort()) walk(path.join(p, name), `${relPath}/${name}`);
  };
  walk(target, '.');
  return createHash('sha256').update(entries.join('\n')).digest('hex');
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** リポジトリの node_modules にある playwright を読み込む。 */
export function loadPlaywright() {
  const require = createRequire(path.join(ROOT, 'package.json'));
  try {
    return require('playwright');
  } catch {
    fail('playwright が見つかりません。リポジトリのルートで npm ci を実行してください。');
  }
}

export function rel(p) {
  return path.relative(ROOT, p);
}
