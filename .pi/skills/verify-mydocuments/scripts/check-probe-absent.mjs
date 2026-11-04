#!/usr/bin/env node
// 配布物に、隔離の検証用のコードと、段 2 のテスト用の部品が入っていないことを確かめる（ADR-005 の R5）。
// 使い方（リポジトリのルートで）:
//   node .pi/skills/verify-mydocuments/scripts/check-probe-absent.mjs                       dist/ と通常の debug 実行ファイル（target/debug）を検査（どちらかが無ければ飛ばす）
//   node .pi/skills/verify-mydocuments/scripts/check-probe-absent.mjs --expect-present <file>   対照: 検証用のビルド（実行ファイル、またはその dist）には印が出ること
// 印: __mdeIsolationProbe（検証用のコードの印）、isolation_probe_（記録用のネイティブのコマンド名）、__mdeE2EActionFixture（段 2 のテスト用の部品の印）。
// dist/plug/ は、ブラウザ版（e2e）だけが配信する Worker のホスト。本番の dist には出ない（Tauri 版は plug: から返す）。
// dist のビルドは npm run build、実行ファイルは tauri.mjs build（--probe なし）。どちらも検証用のビルドをした後に、通常のビルドをし直してから使う。
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, TAURI_BIN, parseArgs, rel } from './lib.mjs';

const MARKS = ['__mdeIsolationProbe', 'isolation_probe_', '__mdeE2EActionFixture'];
const args = parseArgs(process.argv.slice(2));

function filesUnder(p) {
  if (!fs.existsSync(p)) return [];
  if (fs.statSync(p).isFile()) return [p];
  return fs.readdirSync(p, { recursive: true }).map((f) => path.join(p, f)).filter((f) => fs.statSync(f).isFile());
}
const hits = (file) => {
  const buf = fs.readFileSync(file);
  return MARKS.filter((m) => buf.includes(m));
};

if (typeof args['expect-present'] === 'string') {
  const target = path.resolve(args['expect-present']);
  const found = new Set(filesUnder(target).flatMap(hits));
  console.log(`${rel(target)}: ${[...found].join(', ') || '(印なし)'}`);
  const ok = found.has('__mdeIsolationProbe') && found.has('isolation_probe_');
  console.log(ok ? 'OK: 検証用のビルドには印が出る（検査が空振りしていない）' : 'NG: 検証用のビルドなのに印が出ない（検査が空振りしている）');
  process.exit(ok ? 0 : 1);
}

let bad = 0;
const check = (label, p) => {
  const files = filesUnder(p);
  if (files.length === 0) {
    console.log(`SKIP ${label}: ${rel(p)} がありません`);
    return;
  }
  const found = files.flatMap((f) => hits(f).map((m) => `${rel(f)}: ${m}`));
  console.log(`${found.length === 0 ? 'OK  ' : 'NG  '} ${label}: ${files.length} ファイルを検査`);
  for (const f of found) console.log(`     ${f}`);
  bad += found.length;
};
check('dist/（本番のフロントエンド）', path.join(ROOT, 'dist'));
check('通常の debug 実行ファイル', TAURI_BIN);
if (fs.existsSync(path.join(ROOT, 'dist', 'plug'))) {
  console.log('NG   dist/plug/ が出力されています（e2e のビルドだけが出すもの）');
  bad++;
}
process.exit(bad === 0 ? 0 : 1);
