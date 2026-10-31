#!/usr/bin/env node
// Phase 0 completion check. Node standard library only; no network, no node_modules.
// Usage: node scripts/check-phase0.mjs      Exit 0 when every check passes, 1 otherwise.
//
// Checks
//  1. The 4 Phase 0 documents exist and each has the sections 再現コマンド / 計測環境 / 未検証.
//  2. The ADR has Status / Context / Options / Decision / Consequences sections.
//  3. phase0/results/{roundtrip,benchmark,licenses}.json exist, parse, and have the required keys.
//  4. Numeric tables embedded in the documents equal the tables regenerated from the JSON
//     (scripts/render-tables.mjs), so documents cannot drift from measurements.
//  5. Supporting files: spec copy, .gitignore rules for vendored MDE and 1MB+ fixtures,
//     documents do not use bold markup (project writing rule).
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const failures = [];
let passed = 0;

async function check(name, fn) {
  try {
    const msg = await fn();
    if (msg === false) throw new Error('failed');
    passed++;
    console.log(`ok   ${name}`);
  } catch (e) {
    failures.push(`${name}: ${e.message}`);
    console.log(`FAIL ${name}: ${e.message}`);
  }
}
const read = (rel) => readFileSync(resolve(root, rel), 'utf8');
const need = (cond, msg) => { if (!cond) throw new Error(msg); };

// ---------- 1 & 2: documents ----------
const docs = [
  'docs/architecture-review.md',
  'docs/benchmark-baseline.md',
  'docs/licensing-audit.md',
  'docs/decision-001-base-project.md',
];
const heading = (text, word) => new RegExp(`^#{1,6}\\s+.*${word}`, 'm').test(text);

for (const rel of docs) {
  await check(`${rel} exists and is not empty`, () => {
    need(existsSync(resolve(root, rel)), 'file not found');
    need(read(rel).trim().length > 500, 'file is nearly empty');
  });
  if (!existsSync(resolve(root, rel))) continue;
  const text = read(rel);
  for (const section of ['再現コマンド', '計測環境', '未検証']) {
    await check(`${rel} has section 「${section}」`, () => {
      need(heading(text, section), `heading containing "${section}" not found`);
    });
  }
}
await check('ADR has Status / Context / Options / Decision / Consequences', () => {
  const text = read('docs/decision-001-base-project.md');
  for (const h of ['Status', 'Context', 'Options', 'Decision', 'Consequences']) {
    need(new RegExp(`^##\\s+${h}\\b`, 'm').test(text), `"## ${h}" not found`);
  }
});

// ---------- 3: results JSON ----------
const results = {};
const required = {
  'roundtrip.json': (j) => {
    need(typeof j.mdeCommit === 'string' && /^[0-9a-f]{40}$/.test(j.mdeCommit), 'mdeCommit must be a 40-hex commit SHA');
    need(Array.isArray(j.cases) && j.cases.length > 0, 'cases must be a non-empty array');
    need(j.cases.every((c) => c.fixture && c.paths && typeof c.paths === 'object'), 'every case needs fixture and paths');
  },
  'benchmark.json': (j) => {
    need(j.environment && typeof j.environment === 'object', 'environment object required');
    need(typeof j.environment.cpu === 'string' && typeof j.environment.os === 'string', 'environment.cpu and environment.os required');
    need(j.environment.browsers && Object.keys(j.environment.browsers).length > 0, 'environment.browsers required');
    need(typeof j.command === 'string' && j.command.length > 0, 'command (measurement command) required');
    need(Array.isArray(j.measurements) && j.measurements.length > 0, 'measurements must be a non-empty array');
    need(j.measurements.every((m) => m.metric && m.engine && m.dataset !== undefined), 'every measurement needs metric/engine/dataset');
  },
  'licenses.json': (j) => {
    need(Array.isArray(j.packages) && j.packages.length > 0, 'packages must be a non-empty array');
    need(j.packages.every((p) => p.name && p.ecosystem && 'license' in p), 'every package needs name/ecosystem/license');
  },
};
for (const [file, validate] of Object.entries(required)) {
  await check(`phase0/results/${file} exists, is valid JSON, has required keys`, () => {
    const p = `phase0/results/${file}`;
    need(existsSync(resolve(root, p)), 'file not found');
    results[file] = JSON.parse(read(p));
    validate(results[file]);
  });
}
await check('mdeCommit is the same in roundtrip.json, benchmark.json and licenses.json', () => {
  const shas = ['roundtrip.json', 'benchmark.json', 'licenses.json'].map((f) => results[f]?.mdeCommit);
  need(shas.every(Boolean), 'mdeCommit missing in one of the files');
  need(new Set(shas).size === 1, `differs: ${shas.join(' / ')}`);
});

// ---------- 4: tables in docs == tables rendered from JSON ----------
await check('tables embedded in documents match phase0/results/*.json', () => {
  return import(pathToFileURL(resolve(root, 'scripts/render-tables.mjs')).href).then((m) => {
    const tables = m.renderAll();
    const bad = [];
    let blocks = 0;
    for (const rel of docs) {
      if (!existsSync(resolve(root, rel))) continue;
      const text = read(rel);
      for (const mt of text.matchAll(/<!-- table:([\w-]+):begin -->\n([\s\S]*?)\n?<!-- table:\1:end -->/g)) {
        blocks++;
        const [, name, body] = mt;
        if (!(name in tables)) bad.push(`${rel}: unknown table "${name}"`);
        else if (body.trim() !== String(tables[name]).trim()) bad.push(`${rel}: table "${name}" is stale (run node scripts/render-tables.mjs --write)`);
        else if (!body.trim()) bad.push(`${rel}: table "${name}" is empty`);
      }
      const opens = (text.match(/<!-- table:[\w-]+:begin -->/g) ?? []).length;
      const closes = (text.match(/<!-- table:[\w-]+:end -->/g) ?? []).length;
      if (opens !== closes) bad.push(`${rel}: unbalanced table markers (${opens} begin / ${closes} end)`);
    }
    if (blocks === 0) bad.push('no table blocks found in documents');
    if (bad.length) throw new Error(bad.join('; '));
    return true;
  });
});

// ---------- 5: supporting files ----------
await check('spec copy exists at docs/spec/immersive_markdown_editor_spec_v0.1.md', () => {
  const t = read('docs/spec/immersive_markdown_editor_spec_v0.1.md');
  need(t.startsWith('# 没入型Markdownエディタ 仕様書（Draft v0.1）'), 'unexpected first line');
  need(/## 14\. コーディングエージェントへの初回指示/.test(t), 'section 14 missing');
});
await check('.gitignore excludes vendored MDE, node_modules and 1MB fixtures', () => {
  const g = read('.gitignore');
  need(/^phase0\/vendor\/$/m.test(g), 'phase0/vendor/ not ignored');
  need(/^node_modules\/$/m.test(g), 'node_modules/ not ignored');
  need(/^phase0\/fixtures\/perf\/C-\*\.md$/m.test(g), 'C (1MB) fixture not ignored');
});
await check('documents do not use bold markup', () => {
  const offenders = [];
  for (const rel of docs) {
    if (!existsSync(resolve(root, rel))) continue;
    const stripped = read(rel).replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, '');
    if (/\*\*[^*\n]+\*\*/.test(stripped)) offenders.push(rel);
  }
  need(offenders.length === 0, `bold found in ${offenders.join(', ')}`);
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
