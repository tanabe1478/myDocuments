import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, type Page } from '@playwright/test';
import { docTitle, drafts, launch, test, utf8 } from './helpers';

// R16（ADR-007）: 性能の計測。ログがオンの間だけ、区間ごとの所要時間を 1 分ごとにまとめて appendLog へ渡す
// （メモリ bridge が、ネイティブ側の app.log の代わりに window.__mdeE2E.logging に残す）。
// 1 分を待たずに、e2e のビルドだけにある window.__mdePerf.flush() でまとめを書かせる（1 分ごとのタイマーそのものは、偽の時計の 1 件と単体テストで見る）。
// Playwright の chromium は --mute-audio で起動するので、実際の音は出ない。実機（WKWebView）の値は、ここでは確かめられない。

const DOC = '/Users/e2e-user/Documents/secret-folder/perf-note.md';
const MARKER = 'PERF-BODY-MARKER-4e1d7b';
const TABLE = '| a | b |\n| - | - |\n| 1 | 2 |\n';
const BODY = `# 見出し\n\n本文の *強調* と [リンク](https://example.com/)。\n\n${TABLE}\n終わり\n`;

test.beforeEach(({}, testInfo) => {
  test.skip(['chromium-mac', 'chromium-linux'].includes(testInfo.project.name), 'chromium と chromium-windows だけ');
});

interface Entry {
  t: string;
  level: string;
  source: string;
  event: string;
  data: Record<string, string | number | boolean | null>;
}

const dialog = (page: Page) => page.getByRole('dialog', { name: '設定' });
const entries = (page: Page) => page.evaluate(() => window.__mdeE2E!.logging.entries.map((e) => ({ ...e }))) as Promise<Entry[]>;
const named = async (page: Page, source: string, event: string) => (await entries(page)).filter((e) => e.source === source && e.event === event);
const appendCalls = (page: Page) => page.evaluate(() => window.__mdeE2E!.logging.appendLogCalls.length);
const setLoggingCalls = (page: Page) => page.evaluate(() => [...window.__mdeE2E!.logging.setLoggingCalls]);
const flushPerf = (page: Page) => page.evaluate(() => (window as unknown as { __mdePerf: { flush(): void } }).__mdePerf.flush());
const seen = (page: Page, source: string, event: string) => expect.poll(async () => (await named(page, source, event)).length, { timeout: 8000 }).toBeGreaterThan(0);
const soundProbe = (page: Page) =>
  page.evaluate(
    () => (window as unknown as { __mdeE2ETypingSound: { fetches: number; contexts: number; decoded: number; requests: unknown[] } }).__mdeE2ETypingSound,
  );

async function launchWith(page: Page, seed: Parameters<typeof launch>[1] = {}, body = BODY): Promise<void> {
  await launch(page, { files: { [DOC]: utf8(body) }, openPath: DOC, ...seed, preferences: { theme: 'light', autoHideChrome: false, ...(seed.preferences as object) } });
  await page.keyboard.press('ControlOrMeta+o');
  await expect(docTitle(page)).toHaveText('perf-note.md');
}

async function focusEnd(page: Page): Promise<void> {
  await page.locator('.cm-content').click();
  await page.keyboard.press('ControlOrMeta+End');
}

test.describe('既定はオフ (Q1, Q4)', () => {
  test('入力、保存、草稿、部品の実行をしても、appendLog は 1 回も呼ばれない。まとめを書かせても何も出ない', async ({ page }) => {
    await launchWith(page, { isolated: { plugins: ['e2e-ok'] } });
    await focusEnd(page);
    await page.keyboard.type('abc');
    await page.keyboard.press('Enter');
    await page.keyboard.press('Backspace');
    await page.keyboard.press('ControlOrMeta+s');
    await page.keyboard.press('ControlOrMeta+Shift+E');
    await page.waitForTimeout(2400); // 草稿（約 2 秒）と、ためる間隔（1 秒）の両方を過ぎる
    await flushPerf(page);
    await page.waitForTimeout(1500);
    expect(await appendCalls(page)).toBe(0);
    expect(await entries(page)).toEqual([]);
    expect(await setLoggingCalls(page)).toEqual([false]);
  });
});

test.describe('各計測点の行 (Q2)', () => {
  test('入力、IME の変換、Markdown の装飾と表、部品への配信、Worker の往復、ブリッジ、保存、草稿の区間が、まとめの行として出る', async ({ page }) => {
    await launchWith(page, { preferences: { appLog: true }, isolated: { plugins: ['e2e-ok'], runTimeoutMs: 8000 } });
    await expect.poll(() => setLoggingCalls(page)).toEqual([true]);
    await expect.poll(() => page.evaluate(() => window.__mdeE2E!.logging.enabled)).toBe(true);
    // 右ペイン（アウトライン）を開く（本文を部品へ届ける経路）。届けること自体は、パネルが見えていなくても feed の publish として数える。
    await focusEnd(page);
    for (const ch of 'abc') await page.keyboard.press(ch);
    await page.keyboard.press('Enter');
    await page.keyboard.press('Backspace');
    // IME の変換: compositionupdate から本文の更新まで。
    const client = await page.context().newCDPSession(page);
    await client.send('Input.imeSetComposition', { text: 'に', selectionStart: 1, selectionEnd: 1 });
    await client.send('Input.imeSetComposition', { text: 'にほん', selectionStart: 3, selectionEnd: 3 });
    await client.send('Input.insertText', { text: '日本' });
    // 表の中へ入って、出る（表の組み立て）。
    await page.keyboard.press('ControlOrMeta+Home');
    for (let i = 0; i < 6; i++) await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ControlOrMeta+End');
    // 保存（ブリッジの往復と文書の保存）、草稿の書き込み（約 2 秒後）、部品の実行（e2e-ok は 250ms で終わる）。
    await page.keyboard.type('x');
    await page.keyboard.press('ControlOrMeta+s');
    await expect(page.getByTestId('unsaved-mark')).toHaveCount(0);
    await page.keyboard.type('y');
    await expect.poll(async () => (await drafts(page)).length, { timeout: 6000 }).toBeGreaterThan(0);
    await page.keyboard.press('ControlOrMeta+Shift+E');
    await expect.poll(async () => (await page.evaluate(() => window.__mdeE2EIsolatedTrace ?? [])).some((e) => e.type === 'done' && e.plugin === 'e2e-ok')).toBe(true);
    await page.waitForTimeout(300); // 描画の 1〜2 フレームを待つ

    await flushPerf(page);
    await seen(page, 'perf-system', 'gauges');
    await expect.poll(async () => (await named(page, 'perf', 'plugin-host.run')).length, { timeout: 8000 }).toBeGreaterThan(0);

    const rows = (await entries(page)).filter((e) => e.source === 'perf');
    const byName = new Map(rows.map((r) => [r.event, r]));
    const expected = [
      'input.keydown-to-update',
      'input.keydown-to-paint',
      'input.composition-to-update',
      'markdown.decorations',
      'markdown.live-markup',
      'markdown.table-display',
      'feed.publish',
      'plugin-host.run',
      'bridge.save_document',
      'bridge.write_draft',
      'document.save',
      'document.draft-write',
    ];
    for (const name of expected) expect(byName.has(name), `${name} の行がある`).toBe(true);

    // 行の形: info、source は perf、event は区間の名前。件数、p50、p95、max、total（ms）。
    for (const row of rows) {
      expect(row.level).toBe('info');
      expect(row.event).toMatch(/^[a-z0-9._-]{1,64}$/);
      expect(Object.keys(row.data)).toEqual(['count', 'p50_ms', 'p95_ms', 'max_ms', 'total_ms', 'slow']);
      const d = row.data as Record<string, number>;
      expect(d.count).toBeGreaterThanOrEqual(1);
      expect(d.p50_ms).toBeLessThanOrEqual(d.p95_ms!);
      expect(d.p95_ms).toBeLessThanOrEqual(d.max_ms! + 1e-9);
      expect(d.total_ms).toBeGreaterThanOrEqual(d.max_ms! - 1e-9);
      expect(Math.round(d.total_ms! * 10) / 10).toBe(d.total_ms);
    }
    // 入力: 修飾キーなしの 1 文字と Enter、Backspace の分（abc、Enter、Backspace、x、y ほか）。
    expect((byName.get('input.keydown-to-update')!.data.count as number)).toBeGreaterThanOrEqual(5);
    expect((byName.get('input.keydown-to-paint')!.data.count as number)).toBeGreaterThanOrEqual(5);

    // 量の推移と画面の止まり。本文もパスも書かない（数値と null だけ）。
    const [gauges] = await named(page, 'perf-system', 'gauges');
    expect(gauges!.level).toBe('info');
    expect(Object.keys(gauges!.data)).toEqual(['doc_chars', 'doc_lines', 'dom_nodes', 'heap_used_mb']);
    expect(gauges!.data.doc_chars).toBeGreaterThan(BODY.length);
    expect(gauges!.data.doc_lines).toBeGreaterThan(8);
    expect(gauges!.data.dom_nodes).toBeGreaterThan(20);
    expect(gauges!.data.heap_used_mb === null || typeof gauges!.data.heap_used_mb === 'number').toBe(true);
    // 見張りは操作（上の入力）のあと 1 秒ほどだけ動き、その分の frames が、まとめに入る（R20）。
    await expect.poll(async () => (await named(page, 'perf-system', 'frames')).length).toBeGreaterThan(0);
    const [frames] = await named(page, 'perf-system', 'frames');
    expect(Object.keys(frames!.data)).toEqual(['frames', 'stalls', 'max_ms']);
    expect(frames!.data.frames).toBeGreaterThan(0);
    expect(frames!.data.stalls).toBeLessThanOrEqual(frames!.data.frames as number);

    // ブリッジの区間は、コマンドの名前ごと。appendLog 自身は数えない。
    const names = rows.map((r) => r.event);
    expect(names.filter((n) => n.startsWith('bridge.')).sort()).toEqual(expect.arrayContaining(['bridge.save_document', 'bridge.write_draft']));
    expect(names).not.toContain('bridge.append_log');
    // 区間の数の上限（32）の内側。
    expect(new Set(names).size).toBeLessThanOrEqual(33);
  });

  test('50ms 以上かかった区間は、その場で warn が 1 件出る（名前と時間だけ）', async ({ page }) => {
    await launchWith(page, { preferences: { appLog: true } });
    await expect.poll(() => page.evaluate(() => window.__mdeE2E!.logging.enabled)).toBe(true);
    // 本文の更新の中を重くする: update listener が走る前の同じ tick で、60ms のビジーウェイトを入れる（keydown の capture の中）。
    await page.evaluate(() => {
      document.addEventListener(
        'keydown',
        (e) => {
          if (e.key !== 'q') return;
          const end = performance.now() + 60;
          while (performance.now() < end) {
            /* busy wait */
          }
        },
        true,
      );
    });
    await focusEnd(page);
    await page.keyboard.press('q');
    await seen(page, 'perf-slow', 'input.keydown-to-update');
    const [slow] = await named(page, 'perf-slow', 'input.keydown-to-update');
    expect(slow).toMatchObject({ level: 'warn', source: 'perf-slow', event: 'input.keydown-to-update' });
    expect(Object.keys(slow!.data)).toEqual(['ms']);
    expect(slow!.data.ms).toBeGreaterThanOrEqual(50);
  });

  test('1 分ごとのタイマーで、まとめが書かれる（偽の時計。59 秒では書かれず、60 秒で書かれる）', async ({ page }) => {
    await page.clock.install();
    await launchWith(page, { preferences: { appLog: true } });
    await expect.poll(() => setLoggingCalls(page)).toEqual([true]);
    await expect.poll(() => page.evaluate(() => window.__mdeE2E!.logging.enabled)).toBe(true);
    await page.clock.runFor(1000);
    await focusEnd(page);
    await page.keyboard.press('a');
    // fastForward は、時間だけを進めて、タイマーを 1 回だけ動かす（60 秒ぶんの描画のコールバックを全部は回さない）。
    await page.clock.fastForward(55_000);
    await page.clock.runFor(1500);
    expect(await named(page, 'perf-system', 'gauges')).toEqual([]);
    await page.clock.fastForward(8_000);
    await page.clock.runFor(1500);
    await seen(page, 'perf-system', 'gauges');
    expect(await named(page, 'perf', 'input.keydown-to-update')).not.toEqual([]);
  });
});

test.describe('画面の止まりの見張りは、操作のあとだけ (R20)', () => {
  test('操作がない間は rAF の見張りが動かず（フレームの行が増えない）、操作のあと 1 秒ほどだけ動く（偽の時計。見張りが続けば 6 秒で約 370 フレーム）', async ({ page }) => {
    await page.clock.install();
    await launchWith(page, { preferences: { appLog: true } });
    await expect.poll(() => setLoggingCalls(page)).toEqual([true]);
    await expect.poll(() => page.evaluate(() => window.__mdeE2E!.logging.enabled)).toBe(true);
    /** まとめを書かせ、ロガーが渡す（1 秒ごと。偽の時計）まで進めて、これまでのフレームの行を返す。 */
    const framesSoFar = async () => {
      await flushPerf(page);
      await page.clock.runFor(1500);
      return (await named(page, 'perf-system', 'frames')).map((e) => e.data);
    };

    // 文書を開く操作のあと 1 秒ほどは見張る。そのあとの 20 秒は操作がないので、フレームの行は 1 行も増えない。
    await page.clock.runFor(2000);
    const before = (await framesSoFar()).length;
    await page.clock.runFor(20_000);
    expect((await framesSoFar()).length).toBe(before);

    // 打鍵のあと: 見張りが始まり、フレームの行が 1 行出る。6 秒進めても、数えるのは操作のあとの 1 秒ほど（60 フレーム前後）だけ。
    await focusEnd(page);
    await page.keyboard.press('a');
    await page.clock.runFor(6000);
    const rows = await framesSoFar();
    expect(rows.length).toBe(before + 1);
    const last = rows.at(-1)!;
    expect(Object.keys(last)).toEqual(['frames', 'stalls', 'max_ms']);
    expect(last.frames).toBeGreaterThanOrEqual(20);
    expect(last.frames).toBeLessThanOrEqual(120);

    // 見張りが止まったあとは、また増えない。
    await page.clock.runFor(10_000);
    expect((await framesSoFar()).length).toBe(before + 1);
  });
});

test.describe('本文とパスは書かない (Q4)', () => {
  test('本文に打った目印と、開いたファイルのパスが、計測の行にも出ない', async ({ page }) => {
    await launchWith(page, { preferences: { appLog: true }, isolated: { plugins: ['e2e-ok'] } });
    await expect.poll(() => page.evaluate(() => window.__mdeE2E!.logging.enabled)).toBe(true);
    await focusEnd(page);
    await page.keyboard.type(MARKER);
    await page.keyboard.press('ControlOrMeta+s');
    await expect(page.getByTestId('unsaved-mark')).toHaveCount(0);
    await page.keyboard.type('!');
    await expect.poll(async () => (await drafts(page)).length, { timeout: 6000 }).toBeGreaterThan(0);
    await flushPerf(page);
    await seen(page, 'perf', 'bridge.save_document');
    await seen(page, 'perf-system', 'gauges');
    const everything = await page.evaluate(() => JSON.stringify(window.__mdeE2E!.logging.appendLogCalls));
    expect(everything).toContain('bridge.save_document');
    for (const secret of [MARKER, 'PERF-BODY', DOC, 'secret-folder', 'perf-note', 'e2e-user', '/Users/', '見出し', 'リンク']) {
      expect(everything, secret).not.toContain(secret);
    }
    expect(await page.evaluate(() => window.__mdeE2E!.editor!.getText())).toContain(MARKER);
  });
});

test.describe('タイピング音 (Q3)', () => {
  /** 鳴る（要求が出る）まで、間引きを避けて 1 キーずつ押す。 */
  async function pressUntilSound(page: Page, beforeRequests: number): Promise<void> {
    await expect
      .poll(
        async () => {
          await page.waitForTimeout(60);
          await page.keyboard.press('a');
          return (await soundProbe(page)).requests.length;
        },
        { timeout: 10_000 },
      )
      .toBeGreaterThan(beforeRequests);
  }

  test('キーから source.start までの区間（sound.start-delay）と、出力の遅れの見積もりが記録される', async ({ page }) => {
    await launchWith(page, { preferences: { appLog: true, typingSound: true } });
    await expect.poll(() => page.evaluate(() => window.__mdeE2E!.logging.enabled)).toBe(true);
    await focusEnd(page);
    await pressUntilSound(page, 0);
    await page.waitForTimeout(1100); // 出力の遅れを読む間隔（1 秒）
    await pressUntilSound(page, (await soundProbe(page)).requests.length);
    await flushPerf(page);
    await seen(page, 'perf', 'sound.start-delay');
    const [delay] = await named(page, 'perf', 'sound.start-delay');
    expect(delay!.data.count).toBeGreaterThanOrEqual(1);
    expect(delay!.data.max_ms).toBeLessThan(50); // keydown から start までは同期の処理だけ
    // Chromium は getOutputTimestamp を持つ。1 分に 1 回の info。
    await seen(page, 'typing-sound', 'output.latency');
    const latency = await named(page, 'typing-sound', 'output.latency');
    expect(latency).toHaveLength(1);
    expect(latency[0]!.level).toBe('info');
    expect(Object.keys(latency[0]!.data)).toEqual(['estimate_ms', 'timestamp_age_ms', 'base_latency_ms', 'output_latency_ms', 'state']);
    expect(typeof latency[0]!.data.estimate_ms).toBe('number');
    // 見積もりが 150ms 以下なら、warn は出ない（この環境では、遅れは小さい）。
    if ((latency[0]!.data.estimate_ms as number) <= 150) expect(await named(page, 'typing-sound', 'output.latency-high')).toEqual([]);
  });

  test('設定のオフで AudioContext が閉じ、オンで作り直される。素材は取り直さず、デコードはやり直す。理由がログに残る', async ({ page }) => {
    const wavRequests: string[] = [];
    page.on('request', (request) => {
      if (new URL(request.url()).pathname.endsWith('.wav')) wavRequests.push(path.basename(request.url()));
    });
    await launchWith(page, { preferences: { appLog: true, typingSound: true } });
    await expect.poll(() => page.evaluate(() => window.__mdeE2E!.logging.enabled)).toBe(true);
    await focusEnd(page);
    await pressUntilSound(page, 0);
    const first = await soundProbe(page);
    expect(first.contexts).toBe(1);
    expect(first.fetches).toBe(1);
    expect(first.decoded).toBe(1);
    const wavsBefore = wavRequests.length;
    expect(wavsBefore).toBeGreaterThan(0);

    // オフ: AudioContext を閉じる（次のキーまで作り直さない）。
    await page.keyboard.press('ControlOrMeta+,');
    await expect(dialog(page)).toBeVisible();
    await dialog(page).getByRole('checkbox', { name: 'タイピング音' }).uncheck();
    await expect.poll(async () => (await named(page, 'typing-sound', 'context.closed')).length, { timeout: 8000 }).toBe(1);
    const [closed] = await named(page, 'typing-sound', 'context.closed');
    expect(closed).toMatchObject({ level: 'info', data: { reason: 'setting-off' } });
    expect((await soundProbe(page)).contexts).toBe(1);
    // オフの間は、キーを押しても鳴らず、作り直さない。
    await page.keyboard.press('Escape');
    await focusEnd(page);
    const requestsWhileOff = (await soundProbe(page)).requests.length;
    for (const key of ['b', 'c', 'd']) {
      await page.waitForTimeout(60);
      await page.keyboard.press(key);
    }
    expect((await soundProbe(page)).requests.length).toBe(requestsWhileOff);
    expect((await soundProbe(page)).contexts).toBe(1);

    // オン: 最初に鳴らすキーで作り直す。
    await page.keyboard.press('ControlOrMeta+,');
    await dialog(page).getByRole('checkbox', { name: 'タイピング音' }).check();
    await page.keyboard.press('Escape');
    await focusEnd(page);
    await pressUntilSound(page, requestsWhileOff);
    const again = await soundProbe(page);
    expect(again.contexts).toBe(2);
    expect(again.decoded).toBe(2);
    // 素材のバイト列は取り直していない（fetch も、ネットワークの要求も増えない）。
    expect(again.fetches).toBe(1);
    expect(wavRequests.length).toBe(wavsBefore);
    await expect.poll(async () => (await named(page, 'typing-sound', 'context.created')).length, { timeout: 8000 }).toBe(2);
    expect((await named(page, 'typing-sound', 'context.created')).map((e) => e.data.reason)).toEqual(['first-key', 'after-setting-off']);
    // 音色・音量の切り替えでは、作り直さない（今のまま）。
    await page.keyboard.press('ControlOrMeta+,');
    await dialog(page).getByTestId('settings-sound').getByRole('radio', { name: '大' }).check();
    await page.keyboard.press('Escape');
    expect((await soundProbe(page)).contexts).toBe(2);
    expect((await named(page, 'typing-sound', 'context.closed')).length).toBe(1);
  });
});

test.describe('入力の処理時間: ログのオンとオフ (Q4)', () => {
  /** keydown（capture）の timeStamp から、本文の更新の通知の直後（マイクロタスク）までの時間（perf/lib/inpage.mjs の入力の処理時間と同じ定義）。 */
  async function measure(page: Page, count: number): Promise<number[]> {
    await page.evaluate(() => {
      const w = window as unknown as { __inputSamples: number[]; __inputOff: () => void };
      w.__inputSamples = [];
      let t0 = 0;
      const onKey = (e: KeyboardEvent) => {
        t0 = e.timeStamp;
      };
      document.addEventListener('keydown', onKey, true);
      const off = window.__mdeE2E!.editor!.onChange(() => {
        const started = t0;
        queueMicrotask(() => w.__inputSamples.push(performance.now() - started));
      });
      w.__inputOff = () => {
        document.removeEventListener('keydown', onKey, true);
        off();
      };
    });
    for (let i = 0; i < count; i++) await page.keyboard.press('a');
    return page.evaluate(() => {
      const w = window as unknown as { __inputSamples: number[]; __inputOff: () => void };
      w.__inputOff();
      return w.__inputSamples;
    });
  }

  async function setLogging(page: Page, on: boolean): Promise<void> {
    await page.keyboard.press('ControlOrMeta+,');
    await expect(dialog(page)).toBeVisible();
    await dialog(page).getByTestId('settings-diagnostics').getByRole('checkbox', { name: 'ログを記録する' }).setChecked(on);
    await expect.poll(() => page.evaluate(() => window.__mdeE2E!.logging.enabled)).toBe(on);
    await page.keyboard.press('Escape');
    await focusEnd(page);
  }

  const quantile = (values: number[], q: number) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(q * values.length))]!;
  const summary = (values: number[]) => ({ n: values.length, median_ms: round(quantile(values, 0.5)), p95_ms: round(quantile(values, 0.95)), max_ms: round(Math.max(...values)) });
  const round = (v: number) => Math.round(v * 100) / 100;

  test('オフ、オン、オフ、オンの順に同じページで測り、入力の処理時間が大きく増えない（数字は testInfo と証跡に残る）', async ({ page }, testInfo) => {
    test.setTimeout(120_000);
    const BIG = Array.from({ length: 400 }, (_, i) => `行 ${i} の本文。*強調* と [リンク](https://example.com/${i}) を含む。`).join('\n') + '\n\n' + TABLE;
    await launchWith(page, {}, BIG);
    await focusEnd(page);
    // 暖機（JIT、最初の描画）。
    await measure(page, 40);
    const off: number[] = [];
    const on: number[] = [];
    for (const state of [false, true, false, true]) {
      if (state !== (await page.evaluate(() => window.__mdeE2E!.logging.enabled))) await setLogging(page, state);
      await measure(page, 20); // 切り替え直後の揺れを捨てる
      (state ? on : off).push(...(await measure(page, 150)));
    }
    const result = { project: testInfo.project.name, off: summary(off), on: summary(on), delta_median_ms: round(quantile(on, 0.5) - quantile(off, 0.5)), delta_p95_ms: round(quantile(on, 0.95) - quantile(off, 0.95)) };
    testInfo.annotations.push({ type: 'input-processing-time', description: JSON.stringify(result) });
    console.log(`input processing time (keydown to update): ${JSON.stringify(result)}`);
    const dir = process.env.YORISHIRO_EVIDENCE_DIR;
    if (dir) {
      const out = path.join(dir, 'attempt-1');
      mkdirSync(out, { recursive: true });
      writeFileSync(path.join(out, `input-processing-on-off-${testInfo.project.name}.json`), JSON.stringify(result, null, 2));
    }
    expect(on.length).toBe(300);
    expect(off.length).toBe(300);
    // 大きく増えない: 中央値で 3ms 未満、p95 で 10ms 未満の増加（計測は、打鍵ごとに数回の時刻の読み取りと、数の更新だけ）。
    expect(result.delta_median_ms).toBeLessThan(3);
    expect(result.delta_p95_ms).toBeLessThan(10);
  });
});
