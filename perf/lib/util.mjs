// perf/ の各 script が共有する小さな道具（統計、コマンド実行、環境の記録）。
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const PERF_DIR = path.join(ROOT, 'perf');
export const OUT_DIR = path.join(PERF_DIR, 'out');
export const RESULTS_DIR = path.join(PERF_DIR, 'results');

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const rel = (p) => path.relative(ROOT, p).split(path.sep).join('/');

/** `--key value` と `--flag` を読む。 */
export function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) {
      out._.push(a);
      continue;
    }
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) out[key] = true;
    else {
      out[key] = next;
      i++;
    }
  }
  return out;
}

const round = (x, d = 2) => {
  const k = 10 ** d;
  return Math.round(x * k) / k;
};

/** 最近順位（nearest-rank）の分位点。 */
export function quantile(sorted, p) {
  if (sorted.length === 0) return null;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))];
}

/** 標本の要約。median は p50（nearest-rank）。 */
export function stats(xs, digits = 2) {
  const s = xs.filter((x) => typeof x === 'number' && Number.isFinite(x)).sort((a, b) => a - b);
  if (s.length === 0) return { n: 0 };
  return {
    n: s.length,
    median: round(quantile(s, 0.5), digits),
    p95: round(quantile(s, 0.95), digits),
    min: round(s[0], digits),
    max: round(s[s.length - 1], digits),
  };
}

/** 外部コマンドの標準出力（失敗したら null）。 */
export function sh(cmd, args, options = {}) {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 30_000, cwd: ROOT, ...options }).trim();
  } catch {
    return null;
  }
}

export function gitInfo() {
  const sha = sh('git', ['rev-parse', 'HEAD']);
  const short = sh('git', ['rev-parse', '--short=7', 'HEAD']);
  const status = sh('git', ['status', '--porcelain', '--', '.', ':!perf/results', ':!perf/out']);
  return { sha, short: short ?? 'nogit', dirty: status === null ? null : status.length > 0 };
}

/** 結果 JSON の item を作る。 */
export function item(id, fields) {
  return { id, status: 'ok', better: 'lower', ...fields };
}

export function failedItem(id, group, reason, extra = {}) {
  return { id, group, status: 'failed', reason: String(reason).slice(0, 500), better: 'lower', ...extra };
}

/** 計測環境。WKWebView の版は取れれば記録する。 */
export function environment() {
  const require = createRequire(import.meta.url);
  const cpus = os.cpus();
  const env = {
    os: `${os.type()} ${os.release()}`,
    osVersion: process.platform === 'darwin' ? sh('sw_vers', ['-productVersion']) : null,
    osBuild: process.platform === 'darwin' ? sh('sw_vers', ['-buildVersion']) : null,
    arch: os.arch(),
    cpu: cpus[0]?.model ?? null,
    cpuCores: cpus.length,
    memoryGiB: Math.round(os.totalmem() / 2 ** 30),
    node: process.version,
    playwrightCore: (() => {
      try {
        return require('playwright-core/package.json').version;
      } catch {
        return null;
      }
    })(),
    rustc: sh('rustc', ['--version']),
    power: process.platform === 'darwin' ? (sh('pmset', ['-g', 'batt'])?.split('\n')[0] ?? null) : null,
    lowPowerMode: process.platform === 'darwin' ? (sh('pmset', ['-g'])?.match(/lowpowermode\s+(\d)/)?.[1] ?? null) : null,
    loadAverage: os.loadavg().map((x) => round(x, 2)),
    note: '計測中の OS 上のバックグラウンド負荷（常駐アプリ、このセッションを動かすエージェント）は制御していない。loadAverage は計測開始時点の値。',
  };
  if (process.platform === 'darwin') {
    env.wkwebview =
      sh('defaults', ['read', '/System/Library/Frameworks/WebKit.framework/Resources/Info', 'CFBundleVersion']) ??
      sh('defaults', ['read', '/System/Library/Frameworks/WebKit.framework/Versions/A/Resources/Info', 'CFBundleVersion']);
    env.wkwebviewNote = 'システムの WebKit.framework の CFBundleVersion。Tauri の WKWebView はこれを使う。Playwright の webkit は別ビルド。';
  }
  return env;
}

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function dirSize(dir) {
  let total = 0;
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) total += fs.statSync(p).size;
    }
  };
  walk(dir);
  return total;
}
