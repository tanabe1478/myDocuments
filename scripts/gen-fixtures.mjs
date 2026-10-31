#!/usr/bin/env node
// Phase 0 P0-3: deterministic generator for spec §9.2 test data A/B/C/D.
// Usage: node scripts/gen-fixtures.mjs [--out phase0/fixtures/perf] [--check]
//   --check  generate in memory and compare with manifest.json (exit 1 on mismatch)
// Same script + same Node => same bytes (seeded PRNG, no Date/Math.random).
import { writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const outDir = resolve(root, args.includes('--out') ? args[args.indexOf('--out') + 1] : 'phase0/fixtures/perf');
const checkOnly = args.includes('--check');

// mulberry32: tiny deterministic PRNG.
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = (r, arr) => arr[Math.floor(r() * arr.length)];
const int = (r, lo, hi) => lo + Math.floor(r() * (hi - lo + 1));

const jaClauses = [
  '朝の光が窓から差し込み', '静かな部屋で一杯のコーヒーを淹れる', '遠くで電車の走る音が聞こえる',
  '雨は夜のあいだに上がっていた', '机の上には読みかけの本が積まれている', '言葉を選びながらゆっくりと文章を綴る',
  '昨日の出来事を思い返してみると', '小さな発見が一日の印象を変えることもある', '窓の外では木々が風に揺れていた',
  '焚き火の爆ぜる音に耳を澄ませながら', '余白のある画面は思考を妨げない', '長い文章を書くには持続する集中が要る',
  '変換候補から正しい漢字を選び取る', '句読点の位置ひとつで読み心地は大きく変わる', '誰かに宛てた手紙のように書き始める',
  '午後になって空気がゆるやかに温まった', '古い辞書を引いて意味を確かめる', '夕暮れの街に灯りがともりはじめる',
];
const jaEnds = ['。', '。', '。', 'のである。', 'ように思う。', 'ことにした。', 'かもしれない。'];
const enWords = 'editor markdown buffer cursor render latency document paragraph heading syntax parser widget layout cache stream token'.split(' ');

function jaSentence(r) {
  const n = int(r, 1, 3);
  let s = '';
  for (let i = 0; i < n; i++) s += pick(r, jaClauses) + (i < n - 1 ? '、' : '');
  return s + pick(r, jaEnds);
}
function jaParagraph(r, sentences = int(r, 2, 5)) {
  let s = '';
  for (let i = 0; i < sentences; i++) s += jaSentence(r);
  return s;
}
function enLine(r, words = int(r, 5, 12)) {
  return Array.from({ length: words }, () => pick(r, enWords)).join(' ');
}
const bytes = (s) => Buffer.byteLength(s, 'utf8');

function fillTo(targetBytes, nextBlock) {
  const blocks = [];
  let size = 0;
  for (let i = 0; size < targetBytes; i++) {
    const b = nextBlock(i);
    blocks.push(b);
    size += bytes(b) + 2;
  }
  return blocks.join('\n\n') + '\n';
}

// A: 10KB, ordinary Japanese prose with a few headings.
function genA() {
  const r = rng(0xa001);
  return fillTo(10 * 1024, (i) => (i === 0 ? '# 静かな朝の記録' : i % 6 === 0 ? `## 第${i / 6}節` : jaParagraph(r)));
}

// B: 100KB, headings / lists / links / code blocks mixed.
function genB() {
  const r = rng(0xb002);
  return fillTo(100 * 1024, (i) => {
    switch (i % 8) {
      case 0: return `## セクション ${i / 8 + 1}：${pick(r, jaClauses).slice(0, 10)}`;
      case 1: return jaParagraph(r);
      case 2: return Array.from({ length: int(r, 3, 6) }, (_, k) => `- 項目${k + 1}：${jaSentence(r)}`).join('\n');
      case 3: return `詳細は [参考資料 ${i}](https://example.com/docs/${i}) と [仕様](https://example.com/spec#s${i % 20}) を参照。${jaSentence(r)}`;
      case 4: return '```ts\n' + Array.from({ length: int(r, 4, 9) }, (_, k) => `const ${enWords[k % enWords.length]}${i} = ${int(r, 0, 999)}; // ${enLine(r, 4)}`).join('\n') + '\n```';
      case 5: return Array.from({ length: int(r, 2, 4) }, (_, k) => `${k + 1}. ${jaSentence(r)}`).join('\n');
      case 6: return `> ${jaSentence(r)}\n> ${jaSentence(r)}`;
      default: return jaParagraph(r) + ` **強調${i}** と *斜体* と \`code\` を含む。`;
    }
  });
}

// C: 1MB, long-form text, thousands of paragraphs (mix of JA and EN).
function genC() {
  const r = rng(0xc003);
  return fillTo(1024 * 1024, (i) => (i % 400 === 0 ? `# 章 ${i / 400 + 1}` : i % 7 === 0 ? enLine(r, int(r, 20, 50)) + '.' : jaParagraph(r)));
}

// D: stress — frontmatter, big tables, many code blocks, link definitions, one giant single block.
function genD() {
  const r = rng(0xd004);
  const parts = [];
  parts.push('---\ntitle: "ストレス文書"\ntags: [stress, table, code]\nlist:\n' + Array.from({ length: 60 }, (_, i) => `  - item${i}: value${i}`).join('\n') + '\n---');
  parts.push('# ストレス文書');
  for (let t = 0; t < 6; t++) {
    const cols = 8;
    const head = '| ' + Array.from({ length: cols }, (_, c) => `列${c + 1}`).join(' | ') + ' |';
    const sep = '|' + Array.from({ length: cols }, (_, c) => (c % 3 === 0 ? ':---' : c % 3 === 1 ? '---:' : ':---:')).join('|') + '|';
    const rows = Array.from({ length: 300 }, (_, i) => '| ' + Array.from({ length: cols }, () => (r() < 0.5 ? jaClauses[int(r, 0, 5)].slice(0, 6) : String(int(r, 0, 99999)))).join(' | ') + ' |');
    parts.push([head, sep, ...rows].join('\n'));
  }
  for (let c = 0; c < 40; c++) {
    parts.push('```js\n' + Array.from({ length: 30 }, (_, i) => `function f${c}_${i}(a, b) { return a * ${int(r, 1, 99)} + b; } // ${enLine(r, 5)}`).join('\n') + '\n```');
  }
  const refs = Array.from({ length: 300 }, (_, i) => `[ref${i}]: https://example.com/r/${i} "参照 ${i}"`);
  parts.push(Array.from({ length: 300 }, (_, i) => `[リンク${i}][ref${i}]`).join(' '));
  parts.push(refs.join('\n'));
  // One giant single block: ~200KB paragraph without blank lines.
  let giant = '';
  while (bytes(giant) < 200 * 1024) giant += jaSentence(r);
  parts.push(giant);
  // One very long single line of ASCII (~50KB) to stress wrapping.
  parts.push(Array.from({ length: 5000 }, () => pick(r, enWords)).join(' '));
  return parts.join('\n\n') + '\n';
}

const datasets = [
  { id: 'A', file: 'A-10kb-ja.md', gen: genA, description: '10KB 日本語の通常文章' },
  { id: 'B', file: 'B-100kb-mixed.md', gen: genB, description: '100KB 見出し・箇条書き・リンク・コードブロック混在' },
  { id: 'C', file: 'C-1mb-longform.md', gen: genC, description: '1MB 長文、数千段落（.gitignore 対象、再生成可）' },
  { id: 'D', file: 'D-stress.md', gen: genD, description: 'ストレス：frontmatter・巨大表・コード多数・リンク定義・巨大単一ブロック' },
];

const manifest = { generator: 'scripts/gen-fixtures.mjs', node: process.version, datasets: [] };
for (const d of datasets) {
  const text = d.gen();
  const buf = Buffer.from(text, 'utf8');
  manifest.datasets.push({
    id: d.id, file: d.file, description: d.description, bytes: buf.length,
    chars: [...text].length, lines: text.split('\n').length - 1,
    paragraphs: text.split(/\n\n+/).length, sha256: createHash('sha256').update(buf).digest('hex'),
  });
  if (!checkOnly) {
    mkdirSync(outDir, { recursive: true });
    writeFileSync(resolve(outDir, d.file), buf);
  }
}

const manifestPath = resolve(root, 'phase0/fixtures/perf/manifest.json');
if (checkOnly) {
  const saved = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) : null;
  const bad = manifest.datasets.filter((d) => saved?.datasets.find((s) => s.id === d.id)?.sha256 !== d.sha256);
  for (const d of manifest.datasets) console.log(`${d.id} ${d.file} ${d.bytes}B sha256=${d.sha256.slice(0, 16)}… ${bad.includes(d) ? 'MISMATCH' : 'ok'}`);
  process.exit(bad.length ? 1 : 0);
}
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
for (const d of manifest.datasets) console.log(`${d.id} ${d.file} ${d.bytes}B ${d.paragraphs} paragraphs sha256=${d.sha256.slice(0, 16)}…`);
