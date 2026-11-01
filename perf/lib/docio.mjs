// docio（Rust）の読み書きの計測。crates/docio/examples/perf.rs を release で走らせる。
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { OUT_DIR, ROOT, failedItem, item, rel } from './util.mjs';

export const DOCIO_ITERS = 200;

const OPS = {
  read: 'fs::read（ページキャッシュ上）',
  decode: 'decode（BOM と改行の判定、LF への正規化）',
  encode: 'encode（記録した形式への復元）',
  revision: 'revision_of（SHA-256）',
  save_atomic_changed: 'save_atomic（内容が変わる。一時ファイル、fsync、rename）',
  save_atomic_unchanged: 'save_atomic（同じ内容。比較して書かない）',
  save_checked_changed: 'save_checked（アプリの保存の経路。競合検査のハッシュ + 原子的保存。内容が変わる）',
};

export function measureDocio({ fixtures, quick, log }) {
  // 1 回が 1ms 未満の操作が多く、50 回では 2 回の計測の中央値が +24% 動いた（docs/perf-baseline.md の「揺れ」）ので、既定は 200 回。
  const iters = quick ? 30 : DOCIO_ITERS;
  const args = ['run', '--release', '--quiet', '--manifest-path', 'crates/docio/Cargo.toml', '--example', 'perf', '--', '--iters', String(iters), '--tmp', rel(path.join(OUT_DIR, 'docio-tmp')), ...fixtures.map((f) => f.file)];
  log(`cargo run --release --example perf（反復 ${iters} 回）`);
  const r = spawnSync('cargo', args, { cwd: ROOT, encoding: 'utf8', timeout: 600_000, maxBuffer: 16 * 1024 * 1024 });
  if (r.status !== 0) return { items: [failedItem('docio.run', 'docio', `cargo run に失敗しました（exit ${r.status}）: ${(r.stderr || '').slice(-400)}`)], profile: null };
  let out;
  try {
    out = JSON.parse(r.stdout.trim().split('\n').pop());
  } catch (e) {
    return { items: [failedItem('docio.run', 'docio', `出力が読めません: ${e.message}`)], profile: null };
  }
  const items = [];
  for (const f of out.files) {
    const id = fixtures.find((x) => x.name === f.file)?.id ?? f.file;
    for (const [op, label] of Object.entries(OPS)) {
      const s = f[op];
      // 内部の単位はマイクロ秒。結果は ms で持つ（Web UI の項目と並べるため）。
      const ms = (x) => Math.round((x / 1000) * 100000) / 100000;
      items.push(item(`docio.${op}.${id}`, { group: 'docio', unit: 'ms', n: s.n, median: ms(s.median), p95: ms(s.p95), min: ms(s.min), max: ms(s.max), samples: s.samples.map(ms), metric: label, bytes: f.bytes, profile: out.profile }));
    }
  }
  return { items, profile: out.profile };
}
