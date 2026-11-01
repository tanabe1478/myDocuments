// Web UI（VITE_E2E ビルド。DocumentBridge がメモリ実装）の計測。chromium と webkit（Playwright 同梱）で動かす。
// 計測の定義は docs/perf-baseline.md の「測り方」。各 item は失敗しても他を続ける。
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { chromium, webkit } from 'playwright-core';
import { serve } from '../../phase0/lib/serve.mjs';
import { inPageSourceFor } from './inpage.mjs';
import { OUT_DIR, ROOT, ensureDir, failedItem, item, rel, sleep, stats } from './util.mjs';

const ENGINES = { chromium, webkit };
const DIST = path.join(OUT_DIR, 'web-dist');
const VIEWPORT = { width: 1280, height: 800 };
const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';
const TINY = { path: '/perf/tiny.md', text: '# tiny\n\nreset document\n', title: 'tiny.md', firstLine: '# tiny' };

/** VITE_E2E=1 の Web UI を perf/out/web-dist へビルドする（repo の dist や dist-e2e には触れない）。 */
export function buildWeb(log) {
  ensureDir(OUT_DIR);
  log(`VITE_E2E=1 vite build --outDir ${rel(DIST)}`);
  const r = spawnSync(process.execPath, [path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js'), 'build', '--outDir', DIST, '--emptyOutDir'], {
    cwd: ROOT,
    env: { ...process.env, VITE_E2E: '1' },
    encoding: 'utf8',
    timeout: 180_000,
  });
  if (r.status !== 0) throw new Error(`vite build に失敗しました（exit ${r.status}）: ${(r.stderr || r.stdout || '').slice(-400)}`);
}

/** 条件の定義（回数）。--quick は回数を減らす。 */
export function webPlan(quick) {
  return quick
    ? { keys: 40, imeRounds: 5, openReps: 2, scrollMs: 2500, modeReps: 3, warmupKeys: 3 }
    : { keys: 100, imeRounds: 30, openReps: 7, scrollMs: 8000, modeReps: 10, warmupKeys: 10 };
}

const SCROLL_SPEED_PX_PER_SEC = 2400;

async function newPage(browser, url, injectDelayMs = 0) {
  const context = await browser.newContext({ viewport: VIEWPORT });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript(inPageSourceFor(injectDelayMs));
  await page.goto(url);
  await page.waitForSelector('html[data-ready="true"]', { timeout: 15_000 });
  await page.waitForSelector('.cm-content', { timeout: 15_000 });
  const attached = await page.evaluate(() => window.__perf.attach());
  if (!attached) throw new Error('window.__mdeE2E.editor がありません（VITE_E2E ビルドではない）');
  return { context, page, errors };
}

async function putFile(page, p, bytesB64) {
  await page.evaluate(
    ([file, b64]) => {
      const bin = atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      window.__mdeE2E.files.set(file, bytes);
    },
    [p, bytesB64],
  );
}

/** Mod+O で開き、keydown から本文（先頭行とタイトル）が画面に出た次のフレームの後までの ms。 */
async function openAndMeasure(page, target) {
  await page.evaluate((p) => { window.__mdeE2E.openPath = p; }, target.path);
  const armed = page.evaluate(
    ([title, firstLine]) =>
      new Promise((resolve) => {
        const onKey = (e) => {
          if (e.key.toLowerCase() !== 'o') return;
          document.removeEventListener('keydown', onKey, true);
          const t0 = e.timeStamp;
          window.__perf
            .frameWhen(() => {
              const t = document.querySelector('[data-testid="doc-title"]');
              const l = document.querySelector('.cm-line');
              return !!t && t.textContent.includes(title) && !!l && l.textContent === firstLine;
            }, 15000)
            .then((t1) => resolve(t1 === null ? null : t1 - t0));
        };
        document.addEventListener('keydown', onKey, true);
      }),
    [target.title, target.firstLine],
  );
  await sleep(20);
  await page.keyboard.press(`${MOD}+o`);
  return armed;
}

function datasetTarget(d) {
  const text = fs.readFileSync(d.file, 'utf8');
  return {
    id: d.id,
    path: `/perf/${d.name}`,
    title: d.name,
    firstLine: text.split('\n')[0],
    b64: fs.readFileSync(d.file).toString('base64'),
    bytes: d.bytes,
  };
}

async function openDataset(page, target, { reps = 1 } = {}) {
  await putFile(page, TINY.path, Buffer.from(TINY.text).toString('base64'));
  await putFile(page, target.path, target.b64);
  const samples = [];
  for (let i = 0; i < reps; i++) {
    // 別の文書へ切り替える測定にするため、毎回、小さい文書を挟む。
    const r = await openAndMeasure(page, TINY);
    if (r === null) throw new Error('小さい文書を開けませんでした');
    await sleep(100);
    samples.push(await openAndMeasure(page, target));
    await sleep(150);
  }
  return samples;
}

async function caretAt(page, where) {
  const scroller = page.locator('.cm-scroller');
  const box = await scroller.boundingBox();
  if (where === 'end') {
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await page.keyboard.press(`${MOD}+End`);
  } else {
    await page.evaluate(() => {
      const s = document.querySelector('.cm-scroller');
      s.scrollTop = (s.scrollHeight - s.clientHeight) / 2;
    });
    await sleep(400);
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  }
  await sleep(500);
}

const docLength = (page) => page.evaluate(() => window.__mdeE2E.editor.getText().length);

async function typeKeys(page, count, warmup) {
  await page.evaluate(() => { window.__perf.typingOn = true; window.__perf.typing.length = 0; window.__perf.typingCpu.length = 0; window.__perf.cpuWait = null; });
  const total = count + warmup;
  const lenBefore = await docLength(page);
  for (let i = 0; i < total; i++) {
    await page.keyboard.press('a');
    const ok = await page.evaluate((n) => window.__perf.waitCount('typing', n), i + 1);
    if (!ok) break;
    await sleep(25);
  }
  const all = await page.evaluate(() => window.__perf.typing.slice());
  const allCpu = await page.evaluate(() => window.__perf.typingCpu.slice());
  const inserted = (await docLength(page)) - lenBefore;
  await page.evaluate(() => { window.__perf.typingOn = false; });
  const measured = all.slice(warmup);
  const measuredCpu = allCpu.slice(warmup);
  return { samples: measured.filter((x) => x !== null), timeouts: measured.filter((x) => x === null).length, cpu: measuredCpu.filter((x) => x !== null), cpuTimeouts: measuredCpu.filter((x) => x === null).length, inserted, total };
}

async function imeRounds(page, rounds) {
  const client = await page.context().newCDPSession(page);
  const compose = (text) => client.send('Input.imeSetComposition', { text, selectionStart: text.length, selectionEnd: text.length });
  await page.evaluate(() => { window.__perf.imeOn = true; window.__perf.ime.length = 0; window.__perf.imeCommit.length = 0; });
  const readings = ['ゐ', 'ゐゑ', 'ゐゑゐ', 'ゐゑゐゑ'];
  let updates = 0;
  for (let r = 0; r < rounds + 1; r++) {
    // 本文に無い字（CJK 拡張 A）の 2 文字を、1 回ごとに変えて確定する。
    const final = String.fromCodePoint(0x3400 + r * 2, 0x3401 + r * 2);
    for (const t of [...readings, final]) {
      await compose(t);
      updates++;
      await page.evaluate((n) => window.__perf.waitCount('ime', n), updates);
      await sleep(10);
    }
    await page.evaluate(() => { window.__perf.committing = true; });
    await client.send('Input.insertText', { text: final });
    const ok = await page.evaluate((n) => window.__perf.waitCount('imeCommit', n), r + 1);
    await page.evaluate(() => { window.__perf.committing = false; });
    if (!ok) break;
    await sleep(40);
  }
  const ime = await page.evaluate(() => window.__perf.ime.slice());
  const commit = await page.evaluate(() => window.__perf.imeCommit.slice());
  await page.evaluate(() => { window.__perf.imeOn = false; });
  await client.detach().catch(() => {});
  // 最初の 1 回（5 件の変換更新と 1 回の確定）は暖機として捨てる。
  return {
    update: ime.slice(5).filter((x) => x !== null),
    commit: commit.slice(1).filter((x) => x !== null),
    timeouts: ime.slice(5).filter((x) => x === null).length + commit.slice(1).filter((x) => x === null).length,
  };
}

async function scrollRun(page, ms) {
  await page.evaluate(() => { document.querySelector('.cm-scroller').scrollTop = 0; });
  await sleep(500);
  // 暖機（1 秒）を捨ててから測る。
  await page.evaluate(([speed]) => window.__perf.scroll('.cm-scroller', speed, 1000), [SCROLL_SPEED_PX_PER_SEC]);
  const r = await page.evaluate(([speed, dur]) => window.__perf.scroll('.cm-scroller', speed, dur), [SCROLL_SPEED_PX_PER_SEC, ms]);
  return r;
}

async function modeToggle(page, key, onPred, offPred, reps) {
  const run = async (shortcut, pred) => {
    const armed = page.evaluate(
      ([k, predSrc]) =>
        new Promise((resolve) => {
          const onKey = (e) => {
            if (e.key.toLowerCase() !== k) return;
            document.removeEventListener('keydown', onKey, true);
            const t0 = e.timeStamp;
            const fn = new Function(`return (${predSrc})`);
            window.__perf.frameWhen(() => fn(), 5000).then((t1) => resolve(t1 === null ? null : t1 - t0));
          };
          document.addEventListener('keydown', onKey, true);
        }),
      [key, pred],
    );
    await sleep(20);
    await page.keyboard.press(shortcut);
    return armed;
  };
  const on = [];
  const off = [];
  for (let i = 0; i < reps + 1; i++) {
    const a = await run(`${MOD}+Shift+${key.toUpperCase()}`, onPred);
    await sleep(250);
    const b = await run(`${MOD}+Shift+${key.toUpperCase()}`, offPred);
    await sleep(250);
    if (i > 0) { on.push(a); off.push(b); } // 最初の 1 往復は暖機
  }
  return { on, off };
}

const FOCUS_ON = `!!document.querySelector('.cm-md-dim')`;
const FOCUS_OFF = `!document.querySelector('.cm-md-dim')`;
const TW_ON = `!!document.querySelector('.cm-editor.cm-typewriter') && !!document.querySelector('.cm-editor').style.getPropertyValue('--md-typewriter-pad')`;
const TW_OFF = `!document.querySelector('.cm-editor.cm-typewriter')`;

function pushStats(items, id, group, samples, extra = {}) {
  const s = stats(samples);
  if (s.n === 0) items.push(failedItem(id, group, '有効な標本が 0 件（描画の観測が時間切れ）', extra));
  else items.push(item(id, { group, unit: 'ms', ...s, ...extra, samples: samples.map((x) => Math.round(x * 10) / 10) }));
}

/**
 * Web UI の全項目を計測する。戻り値は item の配列と、環境（ブラウザの版）。
 * opts: { browsers, fixtures, quick, log, injectInputDelayMs }
 * injectInputDelayMs: 計測専用。全 keydown に足すビジーウェイト（ms）。検出の確認に使う（docs/perf-baseline.md）。
 */
export async function measureWeb({ browsers, fixtures, quick, log, injectInputDelayMs = 0 }) {
  const plan = webPlan(quick);
  const items = [];
  const versions = {};
  const targets = fixtures.map(datasetTarget);
  const { server, port } = await serve(DIST);
  const url = `http://127.0.0.1:${port}/`;
  try {
    for (const name of browsers) {
      let browser;
      try {
        browser = await ENGINES[name].launch({ headless: true });
        versions[name] = { version: browser.version(), headless: true };
      } catch (e) {
        items.push(failedItem(`web.${name}.launch`, 'web', `ブラウザを起動できません: ${e.message}`));
        continue;
      }
      log(`web: ${name} ${versions[name].version}`);

      // ---- ページの準備（空の状態で data-ready まで） ----
      try {
        const times = [];
        for (let i = 0; i < (quick ? 2 : 5); i++) {
          const context = await browser.newContext({ viewport: VIEWPORT });
          const page = await context.newPage();
          await page.addInitScript(() => { window.__t0 = performance.now(); });
          await page.goto(url);
          await page.waitForSelector('html[data-ready="true"]');
          times.push(await page.evaluate(() => performance.now()));
          await context.close();
        }
        pushStats(items, `web.${name}.ready`, 'web', times, { metric: 'ページの読み込み開始から data-ready まで（ページ内 performance.now、ローカルの preview サーバー、空の文書）' });
      } catch (e) {
        items.push(failedItem(`web.${name}.ready`, 'web', e.message));
      }

      for (const t of targets) {
        // ---- 読み込み（開く操作 → 本文の表示） ----
        let leftOpen = null;
        try {
          leftOpen = await newPage(browser, url, injectInputDelayMs);
          const samples = await openDataset(leftOpen.page, t, { reps: plan.openReps });
          const valid = samples.filter((x) => x !== null);
          pushStats(items, `web.open.${name}.${t.id}`, 'open', valid, { metric: 'Mod+O の keydown から本文の先頭行とタイトルが画面に出た次のフレームの後まで', bytes: t.bytes, timeouts: samples.length - valid.length });
        } catch (e) {
          items.push(failedItem(`web.open.${name}.${t.id}`, 'open', e.message));
        }
        if (leftOpen) await leftOpen.context.close().catch(() => {});

        // ---- キー入力（末尾・中央）と IME ----
        for (const where of ['end', 'middle']) {
          let ctx = null;
          try {
            ctx = await newPage(browser, url, injectInputDelayMs);
            const { page } = ctx;
            await openDataset(page, t, { reps: 1 });
            await caretAt(page, where);
            const r = await typeKeys(page, plan.keys, plan.warmupKeys);
            pushStats(items, `web.typing.${name}.${t.id}.${where}`, 'typing', r.samples, {
              metric: 'keydown から、本文が変わった次のフレームの描画の後まで',
              bytes: t.bytes,
              timeouts: r.timeouts,
              charsInserted: r.inserted,
              keysSent: r.total,
            });
            if (r.inserted !== r.total && r.timeouts === 0) items.at(-1).note = `本文の増加 ${r.inserted} 文字が送信数 ${r.total} と一致しない`;
            pushStats(items, `web.input-cpu.${name}.${t.id}.${where}`, 'input-cpu', r.cpu, {
              metric: 'keydown（capture）の timeStamp から、CodeMirror が本文の DOM を更新し終えて update listener（onChange）が呼ばれた直後（マイクロタスク）まで。描画フレームを待たないので、60Hz のフレームには丸められない',
              bytes: t.bytes,
              timeouts: r.cpuTimeouts,
            });

            if (name === 'chromium') {
              try {
                // 同じページで、続けて IME（CDP）。キャレットは同じ場所。
                const ime = await imeRounds(page, plan.imeRounds);
                pushStats(items, `web.ime-update.${name}.${t.id}.${where}`, 'ime', ime.update, { metric: 'compositionupdate から、変換中の文字が本文に入った次のフレームの描画の後まで（CDP の模擬 IME）', bytes: t.bytes, timeouts: ime.timeouts });
                pushStats(items, `web.ime-commit.${name}.${t.id}.${where}`, 'ime', ime.commit, { metric: 'compositionend（確定）から、確定した文字が本文にある次のフレームの描画の後まで（CDP の模擬 IME）', bytes: t.bytes, timeouts: ime.timeouts });
              } catch (e) {
                items.push(failedItem(`web.ime-update.${name}.${t.id}.${where}`, 'ime', e.message));
                items.push(failedItem(`web.ime-commit.${name}.${t.id}.${where}`, 'ime', e.message));
              }
            }
          } catch (e) {
            items.push(failedItem(`web.typing.${name}.${t.id}.${where}`, 'typing', e.message));
          }
          if (ctx) await ctx.context.close().catch(() => {});
        }
        log(`web: ${name} ${t.id} done`);
      }

      // ---- 長文スクロール（C） ----
      const c = targets.find((t) => t.id === 'C');
      if (c) {
        let ctx = null;
        try {
          ctx = await newPage(browser, url, injectInputDelayMs);
          await openDataset(ctx.page, c, { reps: 1 });
          const r = await scrollRun(ctx.page, plan.scrollMs);
          const f = stats(r.frames);
          const over50 = r.frames.filter((x) => x > 50).length;
          const over33 = r.frames.filter((x) => x > 33.4).length;
          if (r.scrolled < 1000) throw new Error(`スクロールが進んでいません（${r.scrolled}px）`);
          items.push(item(`web.scroll.${name}.C`, { group: 'scroll', unit: 'ms', ...f, metric: `一定速度（${SCROLL_SPEED_PX_PER_SEC}px/秒、scrollTop を rAF ごとに更新）で 1MB 文書をスクロールしたときの rAF の間隔`, framesOver50ms: over50, framesOver33ms: over33, scrolledPx: Math.round(r.scrolled), durationMs: plan.scrollMs }));
          items.push(item(`web.scroll-over50.${name}.C`, { group: 'scroll', unit: 'frames', median: over50, metric: '50ms を超えたフレーム数（上の計測と同じ走査）', n: f.n }));
        } catch (e) {
          items.push(failedItem(`web.scroll.${name}.C`, 'scroll', e.message));
        }
        if (ctx) await ctx.context.close().catch(() => {});
      }

      // ---- モード切替（B・C。キャレットは文書の中央） ----
      for (const t of targets.filter((x) => x.id === 'B' || x.id === 'C')) {
        let ctx = null;
        try {
          ctx = await newPage(browser, url, injectInputDelayMs);
          await openDataset(ctx.page, t, { reps: 1 });
          await caretAt(ctx.page, 'middle');
          const f = await modeToggle(ctx.page, 'f', FOCUS_ON, FOCUS_OFF, plan.modeReps);
          const w = await modeToggle(ctx.page, 't', TW_ON, TW_OFF, plan.modeReps);
          const mk = (key, samples, metric) => {
            const valid = samples.filter((x) => x !== null);
            pushStats(items, `web.mode.${name}.${t.id}.${key}`, 'mode', valid, { metric, bytes: t.bytes, timeouts: samples.length - valid.length });
          };
          mk('focus-on', f.on, 'Mod+Shift+F の keydown から、周囲の段落が薄くなった（.cm-md-dim ができた）次のフレームの描画の後まで');
          mk('focus-off', f.off, 'Mod+Shift+F（OFF）の keydown から、.cm-md-dim が無くなった次のフレームの描画の後まで');
          mk('typewriter-on', w.on, 'Mod+Shift+T の keydown から、.cm-typewriter と余白の CSS 変数ができた次のフレームの描画の後まで');
          mk('typewriter-off', w.off, 'Mod+Shift+T（OFF）の keydown から、.cm-typewriter が無くなった次のフレームの描画の後まで');
        } catch (e) {
          for (const k of ['focus-on', 'focus-off', 'typewriter-on', 'typewriter-off']) items.push(failedItem(`web.mode.${name}.${t.id}.${k}`, 'mode', e.message));
        }
        if (ctx) await ctx.context.close().catch(() => {});
      }
      await browser.close().catch(() => {});
    }
  } finally {
    server.close();
  }
  return { items, versions };
}
