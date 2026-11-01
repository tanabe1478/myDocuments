#!/usr/bin/env node
// verify-mydocuments Skill の形式検査。Node 標準ライブラリだけで動き、違反があれば exit 1。
// 使い方: node .pi/skills/verify-mydocuments/scripts/check-skill.mjs
// 検査:
//   - SKILL.md の frontmatter（name、description）と、必須の節（Launch / Doctor / Drive / Evidence / Cleanup / Helpers）
//   - features/ の feature ファイル（README.md 以外）が 3〜6 件で、H1 の後に 4 つの H2 だけをこの順で持つこと
//   - Driving 節が `Preconditions:` で始まること
//   - SKILL.md と features が参照する scripts/ のファイルと、features/scenarios/ の JSON が実在し、scripts/ は実行ビットを持つこと
//   - features/README.md が各 feature ファイルへリンクしていること
//   - 生成物に、Markdown の太字（**）とローカルの絶対パス（/Users/ など）がないこと
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const skillDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scriptsDir = path.join(skillDir, 'scripts');
const featuresDir = path.join(skillDir, 'features');
const violations = [];
const bad = (file, message) => violations.push(`${path.relative(skillDir, file) || '.'}: ${message}`);
const read = (file) => fs.readFileSync(file, 'utf8');

/** コードフェンスの中を除いた行（行番号付き）。 */
function proseLines(text) {
  let fenced = false;
  const out = [];
  text.split('\n').forEach((line, i) => {
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced;
      return;
    }
    if (!fenced) out.push({ line, no: i + 1 });
  });
  return out;
}

function headings(text, level) {
  const re = new RegExp(`^#{${level}}\\s+(.*?)\\s*$`);
  return proseLines(text).flatMap(({ line, no }) => {
    const m = re.exec(line);
    return m && !line.startsWith('#'.repeat(level + 1)) ? [{ title: m[1], no }] : [];
  });
}

// ---- SKILL.md ----
const skillFile = path.join(skillDir, 'SKILL.md');
let skillText = '';
if (!fs.existsSync(skillFile)) bad(skillFile, 'SKILL.md がありません');
else {
  skillText = read(skillFile);
  const fm = /^---\n([\s\S]*?)\n---\n/.exec(skillText);
  if (!fm) bad(skillFile, 'frontmatter がありません');
  else {
    if (!/^name:\s*verify-mydocuments\s*$/m.test(fm[1])) bad(skillFile, 'frontmatter の name は verify-mydocuments');
    if (!/^description:\s*\S.{20,}/m.test(fm[1])) bad(skillFile, 'frontmatter の description がない、または短すぎます');
  }
  const h2 = headings(skillText, 2).map((h) => h.title);
  for (const section of ['Launch', 'Doctor', 'Drive', 'Evidence', 'Cleanup', 'Helpers']) {
    if (!h2.some((t) => t === section || t.startsWith(`${section} `) || t.startsWith(`${section}（`))) bad(skillFile, `必須の節 "${section}" がありません`);
  }
}

// ---- features ----
const featureFiles = fs.existsSync(featuresDir)
  ? fs.readdirSync(featuresDir).filter((f) => f.endsWith('.md') && f !== 'README.md').sort()
  : [];
if (!fs.existsSync(path.join(featuresDir, 'README.md'))) bad(featuresDir, 'features/README.md がありません');
if (featureFiles.length < 3 || featureFiles.length > 6) bad(featuresDir, `feature ファイルは 3〜6 件（現在 ${featureFiles.length} 件）`);

const EXPECTED = [/^Sub-features$/, /^How to get to it \(user POV\)$/, /^Driving it with .+$/, /^Gotchas$/];
for (const f of featureFiles) {
  const file = path.join(featuresDir, f);
  const text = read(file);
  const h1 = headings(text, 1);
  const h2 = headings(text, 2);
  if (h1.length !== 1) bad(file, `H1 はちょうど 1 つ（現在 ${h1.length}）`);
  else if (h2.length > 0 && h2[0].no < h1[0].no) bad(file, 'H2 が H1 より前にあります');
  if (h2.length !== EXPECTED.length || EXPECTED.some((re, i) => !h2[i] || !re.test(h2[i].title))) {
    bad(file, `H2 は Sub-features / How to get to it (user POV) / Driving it with <harness> / Gotchas の 4 つだけをこの順で（現在: ${h2.map((h) => h.title).join(' | ') || 'なし'}）`);
  }
  const driving = h2.find((h) => /^Driving it with /.test(h.title));
  if (driving) {
    const lines = text.split('\n');
    const first = lines.slice(driving.no).find((l) => l.trim() !== '');
    if (!first || !first.startsWith('Preconditions:')) bad(file, 'Driving 節は `Preconditions:` で始めてください');
  }
}

// features/README.md のリンク
const readmeFile = path.join(featuresDir, 'README.md');
if (fs.existsSync(readmeFile)) {
  const readme = read(readmeFile);
  for (const f of featureFiles) {
    if (!new RegExp(`\\]\\(\\.?/?${f.replace('.', '\\.')}(#[^)]*)?\\)`).test(readme)) bad(readmeFile, `${f} へのリンクがありません`);
  }
}

// ---- 参照するファイルの実在 ----
const docs = [skillFile, readmeFile, ...featureFiles.map((f) => path.join(featuresDir, f))].filter((f) => fs.existsSync(f));
for (const doc of docs) {
  const text = read(doc);
  for (const m of text.matchAll(/scripts\/([A-Za-z0-9._-]+\.[A-Za-z0-9]+)/g)) {
    const target = path.join(scriptsDir, m[1]);
    if (!fs.existsSync(target)) bad(doc, `参照している scripts/${m[1]} が実在しません`);
    else if ((fs.statSync(target).mode & 0o111) === 0) bad(doc, `scripts/${m[1]} に実行ビットがありません`);
  }
  for (const m of text.matchAll(/scenarios\/([A-Za-z0-9._-]+\.json)/g)) {
    if (!fs.existsSync(path.join(featuresDir, 'scenarios', m[1]))) bad(doc, `参照している features/scenarios/${m[1]} が実在しません`);
  }
}
// scenarios の JSON が壊れていないこと。
const scenarioDir = path.join(featuresDir, 'scenarios');
if (fs.existsSync(scenarioDir)) {
  for (const f of fs.readdirSync(scenarioDir).filter((x) => x.endsWith('.json'))) {
    try {
      const s = JSON.parse(read(path.join(scenarioDir, f)));
      if (!Array.isArray(s.steps)) bad(path.join(scenarioDir, f), 'steps（配列）がありません');
    } catch (e) {
      bad(path.join(scenarioDir, f), `JSON が不正です: ${e.message}`);
    }
  }
}
// 各 scenario がどこかの feature から参照されていること。
if (fs.existsSync(scenarioDir)) {
  const referenced = new Set(docs.flatMap((d) => [...read(d).matchAll(/scenarios\/([A-Za-z0-9._-]+\.json)/g)].map((m) => m[1])));
  for (const f of fs.readdirSync(scenarioDir).filter((x) => x.endsWith('.json'))) {
    if (!referenced.has(f)) bad(path.join(scenarioDir, f), 'どの feature からも参照されていません');
  }
}

// ---- 生成物の体裁（太字なし、ローカル絶対パスなし） ----
function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
}
for (const file of walk(skillDir)) {
  if (path.basename(file) === 'check-skill.mjs') continue; // 検査の正規表現そのものを含む
  if (!/\.(md|mjs|json|swift)$/.test(file)) continue;
  const text = read(file);
  if (file.endsWith('.md') && proseLines(text).some(({ line }) => /\*\*[^*\s][^*]*\*\*/.test(line))) bad(file, 'Markdown の太字（**）を使っています');
  if (/\/(Users|home)\/[A-Za-z0-9._-]+\//.test(text)) bad(file, 'ローカルの絶対パスが含まれています');
}

const unique = [...new Set(violations)];
if (unique.length > 0) {
  console.error(`check-skill: ${unique.length} 件の違反`);
  for (const v of unique) console.error(`  - ${v}`);
  process.exit(1);
}
console.log(`check-skill OK（feature ${featureFiles.length} 件、scenario ${fs.existsSync(scenarioDir) ? fs.readdirSync(scenarioDir).length : 0} 件）`);
