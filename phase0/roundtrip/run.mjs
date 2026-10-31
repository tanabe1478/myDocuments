#!/usr/bin/env node
// Phase 0 P0-2: Markdown round-trip fidelity. Output: phase0/results/roundtrip.json
// Prereq: harness built (see docs/architecture-review.md "再現コマンド").
// Usage: node phase0/roundtrip/run.mjs [chromium,webkit]
import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import { serve } from '../lib/serve.mjs';
import { launch } from '../lib/browsers.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const dist = resolve(root, 'phase0/harness/dist');
if (!existsSync(dist)) { console.error('harness/dist がありません。先に harness をビルドしてください。'); process.exit(2); }
const browsersToRun = (process.argv[2] ?? 'chromium,webkit').split(',');
const mdeCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: resolve(root, 'phase0/vendor/MDE'), encoding: 'utf8' }).trim();

const sha = (b) => createHash('sha256').update(b).digest('hex');
const eolOf = (buf) => {
  const s = buf.toString('latin1');
  const crlf = (s.match(/\r\n/g) ?? []).length;
  const lf = (s.match(/\n/g) ?? []).length - crlf;
  const cr = (s.match(/\r(?!\n)/g) ?? []).length;
  if (crlf && !lf && !cr) return 'CRLF';
  if (lf && !crlf && !cr) return 'LF';
  if (!crlf && !lf && !cr) return 'none';
  return 'mixed';
};
const hasBom = (b) => b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf;
const esc = (s) => JSON.stringify(s).slice(1, -1);

function compare(src, got) {
  if (got === null || got === undefined) return { available: false };
  const equal = Buffer.compare(src, got) === 0;
  let off = -1;
  if (!equal) {
    const n = Math.min(src.length, got.length);
    off = 0;
    while (off < n && src[off] === got[off]) off++;
  }
  return {
    available: true,
    byteEqual: equal,
    bytes: got.length,
    deltaBytes: got.length - src.length,
    bom: hasBom(got),
    eol: eolOf(got),
    firstDiffOffset: equal ? null : off,
    srcContext: equal ? null : esc(src.subarray(Math.max(0, off - 12), off + 28).toString('utf8')),
    gotContext: equal ? null : esc(got.subarray(Math.max(0, off - 12), off + 28).toString('utf8')),
    sha256: sha(got),
  };
}

const fixturesDir = resolve(root, 'phase0/fixtures');
const names = readdirSync(fixturesDir).filter((f) => f.endsWith('.md')).sort();
const { server, port } = await serve(dist);
const cases = [];
const environments = {};

for (const bname of browsersToRun) {
  const browser = await launch(bname);
  environments[bname] = { name: bname, version: browser.version() };
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.error(`[${bname}] pageerror`, e.message));
  await page.goto(`http://127.0.0.1:${port}/index.html`);
  await page.waitForFunction('window.__ready === true');

  for (const name of names) {
    const src = readFileSync(resolve(fixturesDir, name));
    const b64 = src.toString('base64');
    const r = await page.evaluate((x) => window.__h.roundtrip(x), b64);
    const dec = (k) => (r[k] ? Buffer.from(r[k], 'base64') : null);

    // Real typing in Milkdown (ProseMirror) -> markdown handed back to raw mode.
    await page.evaluate((x) => window.__h.milkdownPrepareForTyping(x), b64);
    await page.locator('#md .ProseMirror').click();
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+ArrowDown' : 'Control+End');
    await page.keyboard.type('X');
    await page.waitForTimeout(300);
    const edited = await page.evaluate(() => window.__h.milkdownAfterEdit());
    const editedGuarded = edited.guarded ? Buffer.from(edited.guarded, 'base64') : null;
    const serialized = dec('b_milkdownSerialized');
    await page.evaluate(() => window.__h.teardownTyping());

    cases.push({
      fixture: name,
      browser: bname,
      source: { bytes: src.length, bom: hasBom(src), eol: eolOf(src), sha256: sha(src) },
      paths: {
        // (a) MDE open -> save without edit, tab.content written as-is.
        a1_noEditSave: compare(src, dec('a1_noEditSave')),
        // (a) same file after CodeMirror holds it (no edit): the string CM returns.
        a2_cmNoEditSave: { ...compare(src, dec('a2_cmNoEditContentSave')), cmEqualsReadString: r.a2_cmContentEqualsReadString },
        // (a) one char typed and deleted in CM -> onChange payload saved.
        a3_cmEditRevertSave: { ...compare(src, dec('a3_cmEditRevertSave')), onChangeFired: r.a3_onChangeFired },
        // (b) Milkdown serialization of the unchanged document.
        b1_milkdownSerialized: compare(src, serialized),
        // (b) MDE's guarded visual->raw sync with no user edit.
        b2_guardedRawSyncNoEdit: compare(src, dec('b_guardedRawSync')),
        // (b) after a real keystroke ("X") in Milkdown: markdown returned to CM.
        b3_afterTypingX: {
          ...compare(src, editedGuarded),
          normalizationOnly: editedGuarded && serialized ? editedGuarded.toString('utf8').replace('X', '') === serialized.toString('utf8') : null,
          // Same as byteEqual but ignoring the single typed 'X' (so only Milkdown's own rewriting remains).
          equalIgnoringTypedX: editedGuarded ? Buffer.compare(Buffer.from(editedGuarded.toString('utf8').replace('X', ''), 'utf8'), src) === 0 : null,
        },
      },
    });
    const p = cases.at(-1).paths;
    console.log(`${bname} ${name}: a1=${p.a1_noEditSave.byteEqual} a2=${p.a2_cmNoEditSave.byteEqual} a3=${p.a3_cmEditRevertSave.byteEqual} b1=${p.b1_milkdownSerialized.byteEqual} b2=${p.b2_guardedRawSyncNoEdit.byteEqual} b3=${p.b3_afterTypingX.byteEqual}`);
  }
  await browser.close();
}
server.close();

const out = {
  mdeCommit,
  generatedAt: new Date().toISOString(),
  command: `node phase0/roundtrip/make-fixtures.mjs && (cd phase0/vendor/MDE && npx vite build --config ../../harness/vite.config.mjs) && node phase0/roundtrip/run.mjs ${browsersToRun.join(',')}`,
  environment: {
    os: `${os.type()} ${os.release()}`, arch: os.arch(), cpu: os.cpus()[0]?.model, node: process.version,
    browsers: environments,
    note: 'Tauri IPC の Rust 側のみバイト素通しのスタブ。plugin-fs JS、fileOps.saveFile、EditorManager、MilkdownManager は MDE の実コード。React の App.tsx は通していない。',
  },
  pathLegend: {
    a1_noEditSave: 'readTextFile -> saveFile (編集なし。App.tsx handleSave が tab.content を書く経路)',
    a2_cmNoEditSave: 'CodeMirror に読み込んだ後 getContent() の文字列を保存（編集なし）',
    a3_cmEditRevertSave: 'CodeMirror で 1 文字挿入→削除し、onChange(doc.toString()) の内容を保存',
    b1_milkdownSerialized: 'Milkdown(Crepe) に読み込み getMarkdown()（編集なし）',
    b2_guardedRawSyncNoEdit: 'MilkdownManager.getContentForRawSync()（編集なし。MDE の正規化ガード経由）',
    b3_afterTypingX: 'Milkdown 上で文末に X を実キー入力した後の getContentForRawSync()',
  },
  cases,
};
writeFileSync(resolve(root, 'phase0/results/roundtrip.json'), JSON.stringify(out, null, 2) + '\n');
console.log('wrote phase0/results/roundtrip.json (', cases.length, 'cases )');
