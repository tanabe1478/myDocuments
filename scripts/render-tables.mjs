#!/usr/bin/env node
// Renders the Markdown tables embedded in docs/*.md from phase0/results/*.json so that
// the documents cannot drift from the measurements.
//   node scripts/render-tables.mjs --write   rewrite <!-- table:NAME:begin/end --> blocks in docs
//   node scripts/render-tables.mjs --print   print every table
// scripts/check-phase0.mjs imports renderAll() and verifies the docs still match (stdlib only).
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const load = (f) => JSON.parse(readFileSync(resolve(root, 'phase0/results', f), 'utf8'));

const md = (rows) => rows.map((r) => `| ${r.join(' | ')} |`).join('\n');
const table = (head, rows) => md([head, head.map(() => '---'), ...rows]);
const stat = (m) => (m && m.n ? `${m.median} (p95 ${m.p95 ?? '-'})` : '未計測');
const find = (ms, f) => ms.find((m) => Object.entries(f).every(([k, v]) => m[k] === v));

export function renderAll() {
  const out = {};
  const bench = load('benchmark.json');
  const rt = load('roundtrip.json');
  const lic = load('licenses.json');
  const build = existsSync(resolve(root, 'phase0/results/mde-build.json')) ? load('mde-build.json') : null;

  // ---- build log ----
  if (build) {
    out['build-log'] = table(
      ['コマンド（cwd: phase0/vendor/MDE）', 'exit code', '所要秒', '備考'],
      build.results.map((r) => [
        '`' + r.command.replace(/\|/g, '\\|') + '`',
        r.exitCode,
        r.durationSec,
        r.exitCode === 0 ? '' : 'updater 署名鍵なし（TAURI_SIGNING_PRIVATE_KEY）で最終段が失敗。`.app` と `.dmg` は生成済み',
      ]),
    );
  }

  // ---- round-trip ----
  const names = [...new Set(rt.cases.map((c) => c.fixture))];
  const pathKeys = ['a1_noEditSave', 'a2_cmNoEditSave', 'a3_cmEditRevertSave', 'b1_milkdownSerialized', 'b2_guardedRawSyncNoEdit', 'b3_afterTypingX'];
  const cell = (k, c) => {
    const p = c.paths[k];
    if (!p.available) return 'n/a';
    if (k === 'b3_afterTypingX') return p.equalIgnoringTypedX ? '一致(X除く)' : `不一致(X除く, Δ${p.deltaBytes - 1 >= 0 ? '+' : ''}${p.deltaBytes - 1}B)`;
    return p.byteEqual ? '一致' : `不一致(Δ${p.deltaBytes >= 0 ? '+' : ''}${p.deltaBytes}B)`;
  };
  const rows = names.map((n) => {
    const cs = rt.cases.filter((c) => c.fixture === n);
    const c = cs[0];
    const same = cs.every((x) => pathKeys.every((k) => x.paths[k].sha256 === c.paths[k].sha256));
    return [`\`${n}\``, `${c.source.eol}${c.source.bom ? '+BOM' : ''} ${c.source.bytes}B`, ...pathKeys.map((k) => cell(k, c)), same ? '同一' : '差あり'];
  });
  out['roundtrip-matrix'] = table(
    ['fixture', '元', 'a1 無編集保存', 'a2 CM経由保存', 'a3 CM 1字入力削除', 'b1 Milkdown直出力', 'b2 MDEガード経由', 'b3 Milkdown 1字入力後', 'chromium/webkit'],
    rows,
  );
  const cnt = (k) => names.filter((n) => rt.cases.filter((c) => c.fixture === n).every((c) => (k === 'b3_afterTypingX' ? c.paths[k].equalIgnoringTypedX : c.paths[k].byteEqual))).length;
  out['roundtrip-counts'] = table(
    ['経路', `バイト一致した fixture 数（全 ${names.length}）`],
    pathKeys.map((k) => [`${k}`, cnt(k)]),
  );

  // ---- benchmark ----
  const b = bench.measurements;
  const e = bench.environment;
  out['bench-env'] = table(
    ['項目', '値'],
    [
      ['OS', e.os],
      ['CPU', `${e.cpu}（${e.cpuCores} コア）`],
      ['メモリ', `${e.memoryGiB} GiB`],
      ['Node / playwright-core', `${e.node} / ${e.playwrightCore}`],
      ...Object.values(e.browsers).map((x) => [`ブラウザ ${x.name}`, `${x.version}（headless）`]),
      ['データ', bench.datasets.map((d) => `${d.id}=${d.bytes}B`).join(', ')],
    ],
  );
  out['bench-datasets'] = table(
    ['ID', 'ファイル', 'バイト', '文字数', '段落数', 'sha256（先頭16桁）'],
    bench.datasets.map((d) => [d.id, `\`${d.file}\``, d.bytes, d.chars, d.paragraphs, d.sha256.slice(0, 16)]),
  );
  const browsers = Object.keys(e.browsers);
  const ds = ['A', 'B', 'C', 'D'];
  out['bench-load'] = table(
    ['データ', ...browsers.flatMap((br) => [`${br} CM6`, `${br} Milkdown`])],
    ds.map((d) => [d, ...browsers.flatMap((br) => ['cm', 'md'].map((en) => stat(find(b, { browser: br, engine: en, dataset: d, metric: 'load_to_first_paint_ms' }))))]),
  );
  out['bench-cold'] = table(
    ['ブラウザ', 'Milkdown 初回生成（遅延 chunk 取得込み, A, ms）'],
    browsers.map((br) => [br, stat(find(b, { browser: br, engine: 'md', dataset: 'A', metric: 'load_cold_first_creation_ms' }))]),
  );
  out['bench-keys'] = table(
    ['データ', ...browsers.flatMap((br) => [`${br} CM6`, `${br} Milkdown`])],
    [
      ['(対照) contenteditable 20k 字', ...browsers.flatMap((br) => [stat(find(b, { browser: br, engine: 'contenteditable-baseline', metric: 'keydown_to_next_frame_ms' })), '-'])],
      ...ds.map((d) => [d, ...browsers.flatMap((br) => ['cm', 'md'].map((en) => stat(find(b, { browser: br, engine: en, dataset: d, metric: 'keydown_to_next_frame_ms' }))))]),
    ],
  );
  const modeCell = (br, d, m) => stat(find(b, { browser: br, engine: 'cm<->md', dataset: d, metric: m }));
  out['bench-mode'] = table(
    ['データ', ...browsers.flatMap((br) => [`${br} raw→visual 初回`, `${br} visual→raw`, `${br} raw→visual 2回目`])],
    ds.map((d) => [d, ...browsers.flatMap((br) => [modeCell(br, d, 'mode_switch_rawToVisualFirst_ms'), modeCell(br, d, 'mode_switch_visualToRaw_ms'), modeCell(br, d, 'mode_switch_rawToVisualSecond_ms')])]),
  );
  const tauriSc = ['empty', 'A-10kb', 'B-100kb', 'C-1mb'];
  const tm = (d, m) => find(b, { engine: 'tauri-app', dataset: d, metric: m });
  if (tm('empty', 'launch_to_window_visible_ms')) {
    out['bench-tauri'] = table(
      ['起動時の文書', '窓表示まで ms 中央値（最小〜最大, n）', '1回目 ms', '合計 RSS MiB 推定 中央値', '本体 RSS MiB 中央値'],
      tauriSc.map((d) => {
        const l = tm(d, 'launch_to_window_visible_ms');
        return [d, `${l.median}（${l.min}〜${l.max}, n=${l.n}）`, l.runsInOrder?.[0] ?? '-', tm(d, 'rss_total_mib_estimate').median, tm(d, 'rss_main_process_mib').median];
      }),
    );
  }
  out['bench-unmeasured'] = (bench.unmeasured ?? []).map((x) => `- ${x}`).join('\n');

  // ---- licenses ----
  const sn = lic.summary.npm;
  const sc = lic.summary.cargo;
  out['lic-summary'] = table(
    ['区分', '総数', '内訳（上位）', '分類'],
    [
      ['npm（推移依存含む, package-lock.json）', `${sn.total}（本番 ${sn.prodScope} / 開発 ${sn.devScope}）`, Object.entries(sn.byLicense).slice(0, 6).map(([k, v]) => `${k}:${v}`).join(', '), Object.entries(sn.byCategory).map(([k, v]) => `${k}:${v}`).join(', ')],
      ['cargo（推移依存含む, 全ターゲット, Cargo.lock）', `${sc.total}（aarch64-apple-darwin で解決 ${sc.macosArm64Resolved}）`, Object.entries(sc.byLicense).slice(0, 6).map(([k, v]) => `${k}:${v}`).join(', '), Object.entries(sc.byCategory).map(([k, v]) => `${k}:${v}`).join(', ')],
    ],
  );
  const groups = new Map();
  for (const f of lic.flagged) {
    const key = `${f.ecosystem}|${f.license}|${f.scope}|${f.category}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(f);
  }
  out['lic-flagged'] = table(
    ['エコシステム', 'ライセンス', 'スコープ', '分類', '件数', '該当（先頭）'],
    [...groups.entries()].map(([k, v]) => {
      const [eco, license, scope, cat] = k.split('|');
      const uniq = [...new Set(v.map((x) => x.name))];
      return [eco, license, scope, cat, v.length, uniq.slice(0, 4).join(', ') + (uniq.length > 4 ? ` ほか${uniq.length - 4}` : '')];
    }),
  );

  // ---- ADR evidence ----
  const med = (br, en, d, m) => find(b, { browser: br, engine: en, dataset: d, metric: m });
  const wk = browsers.includes('webkit') ? 'webkit' : browsers[0];
  const first = (n) => rt.cases.find((c) => c.fixture === n);
  const bomNames = names.filter((n) => first(n).source.bom);
  const nonBomNames = names.filter((n) => !first(n).source.bom);
  const crlfNames = names.filter((n) => first(n).source.eol === 'CRLF');
  const a1BomLost = bomNames.filter((n) => !first(n).paths.a1_noEditSave.bom).length;
  const a1NonBomEqual = nonBomNames.filter((n) => first(n).paths.a1_noEditSave.byteEqual).length;
  const a2CrlfToLf = crlfNames.filter((n) => first(n).paths.a2_cmNoEditSave.eol === 'LF').length;
  out['adr-evidence'] = table(
    ['基準', '観測', '出典'],
    [
      ['保存品質: 無編集保存', `BOM 付き fixture ${a1BomLost}/${bomNames.length} で BOM 欠落、BOM なしは ${a1NonBomEqual}/${nonBomNames.length} でバイト一致（a1）`, 'roundtrip.json a1_noEditSave'],
      ['保存品質: CodeMirror 経由', `CRLF fixture ${a2CrlfToLf}/${crlfNames.length} が LF 化（a2）。CM6 の既定 line separator 正規化`, 'roundtrip.json a2_cmNoEditSave'],
      ['保存品質: Milkdown', `無編集 serialize で一致 ${cnt('b1_milkdownSerialized')}/${names.length}、1 字入力後（X除く）で一致 ${cnt('b3_afterTypingX')}/${names.length}`, 'roundtrip.json b1/b3'],
      ['保存品質: 書込方式', 'plugin-fs の write は truncate して write_all。一時ファイル・fsync・rename なし', 'architecture-review.md §3'],
      ['外部変更検知', '内容比較は TS 側の文字列等価。ハッシュなし。保存直前の再検査なし', 'architecture-review.md §3'],
      ['性能: 100KB 読込 (B)', `${wk}: CM6 ${stat(med(wk, 'cm', 'B', 'load_to_first_paint_ms'))} ms / Milkdown ${stat(med(wk, 'md', 'B', 'load_to_first_paint_ms'))} ms`, 'benchmark.json'],
      ['性能: 入力遅延 (B)', `${wk}: CM6 ${stat(med(wk, 'cm', 'B', 'keydown_to_next_frame_ms'))} ms / Milkdown ${stat(med(wk, 'md', 'B', 'keydown_to_next_frame_ms'))} ms`, 'benchmark.json'],
      ['性能: ストレス (D) 読込', `${wk}: CM6 ${stat(med(wk, 'cm', 'D', 'load_to_first_paint_ms'))} ms / Milkdown ${stat(med(wk, 'md', 'D', 'load_to_first_paint_ms'))} ms`, 'benchmark.json'],
      ['ライセンス', `npm ${sn.total} / cargo ${sc.total} パッケージ。MPL-2.0 は npm ${(lic.flagged.filter((f) => f.ecosystem === 'npm' && f.license === 'MPL-2.0')).length} 件（すべて開発スコープ）と cargo ${(lic.flagged.filter((f) => f.ecosystem === 'cargo' && f.license === 'MPL-2.0')).length} 件。選択余地のない強いコピーレフトは ${(sn.byCategory['strong-copyleft'] ?? 0) + (sc.byCategory['strong-copyleft'] ?? 0)} 件`, 'licenses.json'],
    ],
  );
  return out;
}

const BEGIN = (n) => `<!-- table:${n}:begin -->`;
const END = (n) => `<!-- table:${n}:end -->`;

export function applyToDoc(text, tables) {
  return text.replace(/<!-- table:([\w-]+):begin -->[\s\S]*?<!-- table:\1:end -->/g, (m, name) => {
    if (!(name in tables)) return m;
    return `${BEGIN(name)}\n${tables[name]}\n${END(name)}`;
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const tables = renderAll();
  if (process.argv.includes('--print')) for (const [k, v] of Object.entries(tables)) console.log(`\n## ${k}\n${v}`);
  if (process.argv.includes('--write')) {
    for (const f of ['architecture-review', 'benchmark-baseline', 'licensing-audit', 'decision-001-base-project']) {
      const p = resolve(root, 'docs', `${f}.md`);
      if (!existsSync(p)) continue;
      const before = readFileSync(p, 'utf8');
      const after = applyToDoc(before, tables);
      if (before !== after) writeFileSync(p, after);
      console.log(`${f}.md ${before === after ? 'unchanged' : 'updated'}`);
    }
  }
}
