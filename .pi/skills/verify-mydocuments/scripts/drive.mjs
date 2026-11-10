#!/usr/bin/env node
// Web UI（VITE_E2E ビルド）を Playwright（chromium）で操作し、スクリーンショットと観測値（JSON）を run ディレクトリへ保存する。
// 使い方:
//   node .pi/skills/verify-mydocuments/scripts/drive.mjs --run-id <id> --scenario <scenario.json> [--name <label>] [--platform mac|windows|linux] [--viewport 1280x800] [--headed]
// scenario.json は { "seed": {...}, "steps": [...], "viewport"?: {...}, "platform"?: "..." }。形式は SKILL.md の Drive 節を参照。
// 保存先: artifacts/verify-mydocuments/<run-id>/evidence/<name>/（observations.json、*.png）。assert が 1 つでも外れたら exit 1。
import { crc32, deflateSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, fail, loadPlaywright, parseArgs, readState, rel, resolveRun } from './lib.mjs';

const args = parseArgs(process.argv.slice(2));
const { runDir, statePath } = resolveRun(args);
const state = readState(statePath);
if (typeof args.scenario !== 'string') fail('--scenario <scenario.json> が必要です。');
const scenarioPath = path.resolve(ROOT, args.scenario);
if (!fs.existsSync(scenarioPath)) fail(`scenario がありません: ${args.scenario}`);
const scenario = JSON.parse(fs.readFileSync(scenarioPath, 'utf8'));
const name = typeof args.name === 'string' ? args.name : path.basename(scenarioPath, '.json');
const outDir = path.join(runDir, 'evidence', name);
fs.mkdirSync(outDir, { recursive: true });

// ---- OS の偽装（tests/e2e/helpers.ts と同じ値。アプリは navigator.platform で Cmd / Ctrl を切り替える） ----
const PLATFORMS = {
  mac: { platform: 'MacIntel', uaPlatform: 'macOS', ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36' },
  windows: { platform: 'Win32', uaPlatform: 'Windows', ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36' },
  linux: { platform: 'Linux x86_64', uaPlatform: 'Linux', ua: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36' },
};
const hostPlatform = process.platform === 'darwin' ? 'mac' : process.platform === 'win32' ? 'windows' : 'linux';
const spoof = typeof args.platform === 'string' ? args.platform : scenario.platform;
if (spoof && !PLATFORMS[spoof]) fail(`--platform は mac / windows / linux のいずれか: ${spoof}`);
const platform = spoof ?? hostPlatform;
const primary = platform === 'mac' ? 'Meta' : 'Control';

let viewport = scenario.viewport ?? { width: 1280, height: 800 };
if (typeof args.viewport === 'string') {
  const m = /^(\d+)x(\d+)$/.exec(args.viewport);
  if (!m) fail('--viewport は 1280x800 の形式');
  viewport = { width: Number(m[1]), height: Number(m[2]) };
}

// ---- seed の組み立て（JSON で書きやすい形 → E2ESeed） ----
function solidPng(width, height, [r, g, b]) {
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const out = Buffer.alloc(8 + data.length + 4);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc32(body), 8 + data.length);
    return out;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: width }, () => [r, g, b]).flat())]);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Array.from(
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk('IHDR', ihdr),
      chunk('IDAT', deflateSync(raw)),
      chunk('IEND', Buffer.alloc(0)),
    ]),
  );
}

/** files の値: number[]（そのまま）/ { text | lines | raw | png | base64, bom?, crlf? } */
function encodeFile(v) {
  if (Array.isArray(v)) return v;
  if (v.png) return solidPng(v.png.width, v.png.height, v.png.rgb);
  if (v.base64) return Array.from(Buffer.from(v.base64, 'base64'));
  let text;
  if (typeof v.raw === 'string') text = v.raw;
  else {
    text =
      typeof v.text === 'string'
        ? v.text
        : Array.from({ length: v.lines.count }, (_, i) => v.lines.template.replaceAll('{n}', String(i + 1))).join('\n');
    if (v.crlf) text = text.replace(/\n/g, '\r\n');
  }
  const body = Array.from(Buffer.from(text, 'utf8'));
  return v.bom ? [0xef, 0xbb, 0xbf, ...body] : body;
}

function buildSeed(raw = {}) {
  const seed = { ...raw };
  seed.files = Object.fromEntries(Object.entries(raw.files ?? {}).map(([p, v]) => [p, encodeFile(v)]));
  // drafts[].baseRevisionOfFile: seed.files のそのパスのバイト列の SHA-256（アプリの revision と同じ）。
  seed.drafts = (raw.drafts ?? []).map((d) => {
    const { baseRevisionOfFile, ...rest } = d;
    if (baseRevisionOfFile) {
      const bytes = seed.files[baseRevisionOfFile];
      if (!bytes) fail(`baseRevisionOfFile のファイルが files にありません: ${baseRevisionOfFile}`);
      rest.baseRevision = createHash('sha256').update(Uint8Array.from(bytes)).digest('hex');
    }
    return rest;
  });
  return seed;
}

// ---- 対象の指定 ----
function locate(page, t) {
  const scope = t.panel ? page.getByRole('dialog', { name: '設定' }) : page;
  if (typeof t === 'string') return page.locator(t);
  if (t.testId) return scope.getByTestId(t.testId);
  if (t.role) return scope.getByRole(t.role, { name: t.name, exact: t.exact });
  if (t.label) return scope.getByLabel(t.label, { exact: t.exact });
  if (t.text) return scope.getByText(t.text, { exact: t.exact });
  if (t.css) return scope.locator(t.css);
  throw new Error(`対象の指定が不正です: ${JSON.stringify(t)}`);
}

function deepEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function compare(actual, spec) {
  if ('equals' in spec) return deepEqual(actual, spec.equals);
  if ('not' in spec) return !deepEqual(actual, spec.not);
  if ('contains' in spec) return Array.isArray(actual) ? actual.some((x) => deepEqual(x, spec.contains)) : String(actual).includes(spec.contains);
  if ('matches' in spec) return new RegExp(spec.matches).test(String(actual));
  if ('gte' in spec && !(actual >= spec.gte)) return false;
  if ('lte' in spec && !(actual <= spec.lte)) return false;
  return 'gte' in spec || 'lte' in spec;
}

async function readValue(page, spec) {
  if (typeof spec.eval === 'string') return page.evaluate(spec.eval);
  const loc = locate(page, spec);
  const read = spec.read ?? 'text';
  if (read === 'count') return loc.count();
  if (read === 'visible') return loc.first().isVisible();
  if (read === 'text') return (await loc.first().textContent({ timeout: 1000 }).catch(() => null));
  if (read === 'focused') return loc.first().evaluate((el) => el === document.activeElement).catch(() => false);
  if (read.startsWith('attr:')) return loc.first().getAttribute(read.slice(5), { timeout: 1000 }).catch(() => null);
  if (read.startsWith('css:')) return loc.first().evaluate((el, prop) => getComputedStyle(el).getPropertyValue(prop), read.slice(4)).catch(() => null);
  throw new Error(`read の指定が不正です: ${read}`);
}

// ---- 観測 ----
function describeBytes(bytes) {
  if (!bytes) return null;
  const u8 = Uint8Array.from(bytes);
  const bom = u8[0] === 0xef && u8[1] === 0xbb && u8[2] === 0xbf;
  const text = Buffer.from(bom ? u8.slice(3) : u8).toString('utf8');
  const crlf = (text.match(/\r\n/g) ?? []).length;
  const lf = (text.match(/\n/g) ?? []).length - crlf;
  return { length: u8.length, bom, crlf, lf, text };
}

async function snapshot(page, extra = {}) {
  const base = await page.evaluate(() => {
    const s = window.__mdeE2E;
    const q = (id) => document.querySelector(`[data-testid="${id}"]`);
    const lines = Array.from(document.querySelectorAll('.cm-line'));
    const dec = (b) => new TextDecoder().decode(Uint8Array.from(b));
    return {
      docTitle: q('doc-title')?.textContent ?? null,
      unsavedMark: q('unsaved-mark') !== null,
      editorText: s?.editor?.getText?.() ?? lines.map((l) => l.textContent ?? '').join('\n'),
      dimFlags: lines.map((l) => l.classList.contains('cm-md-dim')),
      toast: q('toast')?.textContent ?? null,
      conflictBar: q('conflict-bar') ? { state: q('conflict-bar').getAttribute('data-state'), text: q('conflict-bar').textContent } : null,
      dialogs: Array.from(document.querySelectorAll('[role="dialog"], [role="alertdialog"]')).map((d) => ({ role: d.getAttribute('role'), text: (d.textContent ?? '').slice(0, 160) })),
      charCount: q('char-count')?.textContent ?? null,
      explorer: q('file-tree') || q('open-folder') ? {
        folderName: q('folder-name')?.textContent ?? null,
        folderTitle: q('folder-name')?.getAttribute('title') ?? null,
        items: Array.from(document.querySelectorAll('[data-testid="tree-item"], [data-testid="tree-note"]')).map((e) => ({
          label: e.getAttribute('aria-label'),
          level: Number(e.getAttribute('aria-level')),
          kind: e.getAttribute('data-kind'),
          expanded: e.getAttribute('aria-expanded'),
          disabled: e.getAttribute('aria-disabled') === 'true',
          current: e.getAttribute('aria-current') === 'true',
        })),
      } : null,
      chrome: document.querySelector('.app')?.getAttribute('data-chrome') ?? null,
      theme: document.documentElement.getAttribute('data-theme'),
      bridge: s && {
        calls: { ...s.calls },
        physicalWrites: s.physicalWrites,
        conflicts: s.conflicts,
        closed: s.closed,
        fullscreen: s.fullscreen,
        watched: s.watched,
        session: { ...s.session },
        openedFolder: s.openedFolder,
        listed: [...s.listed],
        log: [...s.log],
        drafts: s.readDrafts().map((d) => ({ draftId: d.draftId, path: d.path, text: d.text, baseRevision: d.baseRevision })),
        backups: s.readBackups().map((b) => ({ path: b.path, text: dec(b.bytes) })),
        lastSavedPreferences: s.savedPreferences.at(-1) ?? null,
        savedPreferencesCount: s.savedPreferences.length,
      },
    };
  });
  if (extra.files?.length) {
    const raws = await page.evaluate((paths) => paths.map((p) => window.__mdeE2E.readFile(p)), extra.files);
    base.files = Object.fromEntries(extra.files.map((p, i) => [p, describeBytes(raws[i])]));
  }
  if (extra.eval) {
    base.eval = {};
    for (const [k, expr] of Object.entries(extra.eval)) base.eval[k] = await page.evaluate(expr);
  }
  return base;
}

// ---- 実行 ----
const { chromium } = loadPlaywright();
// 既定の headless は --hide-scrollbars で、スクロールバーを描かない。シナリオの showScrollbars: true で外す（表の横スクロールバーの撮影用）。
const browser = await chromium.launch({ headless: !args.headed, ...(scenario.showScrollbars === true ? { ignoreDefaultArgs: ['--hide-scrollbars'] } : {}) });
const context = await browser.newContext({ viewport });
const page = await context.newPage();
const consoleErrors = [];
page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));
page.on('console', (m) => m.type() === 'error' && consoleErrors.push(`console.error: ${m.text()}`));
page.setDefaultTimeout(5000);

if (spoof) {
  await page.addInitScript((s) => {
    const define = (target, key, value) => Object.defineProperty(target, key, { get: () => value, configurable: true });
    define(Navigator.prototype, 'platform', s.platform);
    define(Navigator.prototype, 'userAgent', s.ua);
    define(Navigator.prototype, 'userAgentData', { platform: s.uaPlatform, mobile: false, brands: [] });
  }, PLATFORMS[spoof]);
}
const keyboardPress = page.keyboard.press.bind(page.keyboard);
const press = (key) => keyboardPress(key.replaceAll('ControlOrMeta', primary));

const seed = buildSeed(scenario.seed);
await page.addInitScript((s) => {
  window.__E2E_SEED__ = s;
}, seed);

const results = [];
let ok = true;
let failure = null;
try {
  await page.goto(state.url);
  await page.waitForSelector('html[data-ready="true"]', { state: 'attached', timeout: 15_000 });
  await page.locator('.cm-content').waitFor({ state: 'visible' });

  for (const [index, step] of (scenario.steps ?? []).entries()) {
    const record = { index, step };
    try {
      if ('press' in step) for (let i = 0; i < (step.times ?? 1); i++) await press(step.press);
      else if ('type' in step) await page.keyboard.type(step.type, { delay: step.delay ?? 0 });
      else if ('insertText' in step) await page.keyboard.insertText(step.insertText);
      else if ('click' in step) {
        // button: 'right' で右クリック（ツリーのメニュー）。position は対象の左上からの座標（空き領域の右クリックなど）。modifiers は押しておく修飾キー。
        await locate(page, step.click)
          .first()
          .click({
            force: step.click.force === true,
            button: step.click.button ?? 'left',
            position: step.click.position,
            // modifiers: ['ControlOrMeta'] は、その OS の Mod キー（リンクを開く ⌘/Ctrl+クリック）。
            modifiers: step.click.modifiers?.map((m) => (m === 'ControlOrMeta' ? primary : m)),
          });
      }
      else if ('focus' in step) await locate(page, step.focus).first().focus();
      else if ('fill' in step) await locate(page, step.fill).fill(String(step.fill.value));
      else if ('check' in step) await locate(page, step.check).check();
      else if ('uncheck' in step) await locate(page, step.uncheck).uncheck();
      else if ('select' in step) await locate(page, step.select).selectOption(step.select.option);
      else if ('waitFor' in step) await locate(page, step.waitFor).first().waitFor({ state: step.waitFor.state ?? 'visible' });
      else if ('wait' in step) await page.waitForTimeout(step.wait);
      else if ('drag' in step) {
        // マウスの down / move / up で実際にドラッグする（HTML5 のドラッグアンドドロップ）。from の行を押し、to の上まで動かし、
        // hold（ミリ秒）の間そこで止まり、screenshot があれば撮り、cancel なら Esc を押してから、離す（cancel でなければ落とす）。
        // toPosition は、to の左上からの座標（ツリーの空いている所など）。
        const d = step.drag;
        const pointOf = async (target, position) => {
          const box = await locate(page, target).first().boundingBox();
          if (!box) throw new Error(`ドラッグの対象が見えません: ${JSON.stringify(target)}`);
          return position ? { x: box.x + position.x, y: box.y + position.y } : { x: box.x + box.width / 2, y: box.y + box.height / 2 };
        };
        const from = await pointOf(d.from);
        await page.mouse.move(from.x, from.y);
        await page.mouse.down();
        await page.mouse.move(from.x + 6, from.y + 6, { steps: 4 });
        const to = await pointOf(d.to, d.toPosition);
        await page.mouse.move(to.x, to.y, { steps: 8 });
        await page.mouse.move(to.x + 1, to.y, { steps: 2 });
        // 止まっている間も、dragover は続く（わずかに動かして、確実に届ける）。
        for (let waited = 0; waited < (d.hold ?? 0); waited += 100) {
          await page.mouse.move(to.x + ((waited / 100) % 2), to.y);
          await page.waitForTimeout(100);
        }
        if (d.screenshot) {
          const file = path.join(outDir, `${d.screenshot}.png`);
          await page.screenshot({ path: file });
          record.file = rel(file);
        }
        if (d.cancel) await page.keyboard.press('Escape');
        await page.mouse.up();
      }
      else if ('mouseMove' in step) await page.mouse.move(step.mouseMove.x, step.mouseMove.y);
      else if ('mouseClick' in step) await page.mouse.click(step.mouseClick.x, step.mouseClick.y);
      else if ('viewport' in step) await page.setViewportSize(step.viewport);
      else if ('reload' in step) {
        await page.reload();
        await page.waitForSelector('html[data-ready="true"]', { state: 'attached', timeout: 15_000 });
      } else if ('externalWrite' in step) {
        const w = step.externalWrite;
        await page.evaluate(([p, bytes, notify]) => window.__mdeE2E.externalWrite(p, bytes, { notify }), [w.path, w.text === null ? null : encodeFile({ text: w.text }), w.notify ?? true]);
      } else if ('externalMkdir' in step) {
        const m = step.externalMkdir;
        await page.evaluate(([p, notify]) => window.__mdeE2E.externalMkdir(p, { notify }), [m.path, m.notify ?? true]);
      } else if ('externalRemove' in step) {
        const r = step.externalRemove;
        await page.evaluate(([p, notify]) => window.__mdeE2E.externalRemove(p, { notify }), [r.path, r.notify ?? true]);
      } else if ('focusWindow' in step) await page.evaluate(() => window.dispatchEvent(new Event('focus')));
      else if ('requestClose' in step) await page.evaluate(() => window.__mdeE2E.requestClose());
      else if ('setPaths' in step) await page.evaluate((p) => Object.assign(window.__mdeE2E, p), Object.fromEntries(Object.entries(step.setPaths).map(([k, v]) => [k === 'image' ? 'imagePath' : `${k}Path`, v])));
      else if ('screenshot' in step) {
        const file = path.join(outDir, `${step.screenshot}.png`);
        await page.screenshot({ path: file });
        record.file = rel(file);
      } else if ('observe' in step) record.observation = await snapshot(page, step);
      else if (typeof step.eval === 'string') record.result = await page.evaluate(step.eval);
      else if ('expect' in step) {
        const spec = step.expect;
        const deadline = Date.now() + (spec.timeout ?? 3000);
        let actual;
        let pass = false;
        do {
          try {
            actual = await readValue(page, spec);
            pass = compare(actual, spec);
          } catch (e) {
            actual = `評価エラー: ${String(e.message ?? e).split('\n')[0]}`; // 保存の debounce 待ちなど、まだ値がない間は再試行する
            pass = false;
          }
          if (!pass) await page.waitForTimeout(100);
        } while (!pass && Date.now() < deadline);
        record.actual = actual;
        if (!pass) throw new Error(`expect が外れました: ${step.note ?? ''} actual=${JSON.stringify(actual)} spec=${JSON.stringify(spec)}`);
      } else throw new Error(`未知の step です: ${JSON.stringify(step)}`);
      record.ok = true;
    } catch (e) {
      record.ok = false;
      record.error = String(e.message ?? e);
      ok = false;
      failure = record;
    }
    results.push(record);
    if (!ok) break;
  }
} catch (e) {
  ok = false;
  failure = { error: String(e.message ?? e) };
}

let final = null;
try {
  await page.screenshot({ path: path.join(outDir, ok ? 'final.png' : 'failure.png') });
  final = await snapshot(page);
} catch {
  /* ページが閉じている場合は final なし */
}
await browser.close();

const report = { scenario: rel(scenarioPath), name, url: state.url, platform, viewport, ok, failure, consoleErrors, steps: results, final };
const reportPath = path.join(outDir, 'observations.json');
fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
const shots = fs.readdirSync(outDir).filter((f) => f.endsWith('.png'));
console.log(`${ok ? 'PASS' : 'FAIL'} ${name}: ${results.filter((r) => r.ok).length}/${scenario.steps?.length ?? 0} steps`);
console.log(`evidence: ${rel(outDir)}/ (observations.json, ${shots.join(', ')})`);
if (!ok) console.error(`first failure: ${JSON.stringify(failure)}`);
process.exit(ok ? 0 : 1);
