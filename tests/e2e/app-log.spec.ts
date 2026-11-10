import { expect, type Page } from '@playwright/test';
import { docTitle, launch, test, utf8 } from './helpers';

// R14（ADR-007）: アプリのログ基盤。設定「診断」の「ログを記録する」（既定はオフ）で有効にしたときだけ、本体のロガーが DocumentBridge の
// appendLog へ、まとめて（1 秒ごと）渡す。メモリ bridge は、ネイティブ側（Rust の app.log）の代わりに、有効の間の行を
// window.__mdeE2E.logging に残す。実際の app.log への書き込み（Rust）は、src-tauri の cargo test が見る。この spec は、本体側（Web UI）だけ。
// Playwright の chromium は --mute-audio で起動するので、実際の音は出ない。タイピング音の記録は、本物の AudioContext に、時計を止められる包みを被せて確かめる。

const DOC = '/Users/e2e-user/Documents/secret-folder/diary.md';
const MARKER = 'BODY-MARKER-7f3c9a';

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
const savedPreferences = (page: Page) => page.evaluate(() => window.__mdeE2E!.savedPreferences.at(-1) as Record<string, unknown> | undefined);
/** 渡されるまで（最初の記録から 1 秒）待つ。 */
const seen = (page: Page, source: string, event: string) => expect.poll(async () => (await named(page, source, event)).length, { timeout: 6000 }).toBeGreaterThan(0);

async function launchWith(page: Page, seed: Parameters<typeof launch>[1] = {}, body = ''): Promise<void> {
  await launch(page, { files: { [DOC]: utf8(body) }, openPath: DOC, ...seed, preferences: { theme: 'light', autoHideChrome: false, ...(seed.preferences as object) } });
}

async function openDoc(page: Page): Promise<void> {
  await page.keyboard.press('ControlOrMeta+o');
  await expect(docTitle(page)).toHaveText('diary.md');
}

test.describe('既定はオフ (Q2)', () => {
  test('何をしても appendLog は 1 回も呼ばれない（保存、例外、visibilitychange、部品の停止、タイピング音を含む）', async ({ page }) => {
    await launchWith(page, { preferences: { typingSound: true }, isolated: { plugins: ['e2e-activate-throws'] } }, 'はじめ');
    await openDoc(page);
    await page.locator('.cm-content').click();
    await page.keyboard.press('ControlOrMeta+End');
    await page.keyboard.type(MARKER);
    await page.keyboard.press('ControlOrMeta+s');
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { get: () => 'hidden', configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
      setTimeout(() => {
        throw new Error('uncaught while off');
      });
      void Promise.reject(new TypeError('rejected while off'));
    });
    await page.keyboard.press('ControlOrMeta+,');
    await expect(dialog(page)).toBeVisible();
    await page.keyboard.press('Escape');
    // ためる間隔（1 秒）の 2 倍以上待っても、何も渡されない。
    await page.waitForTimeout(2500);
    expect(await appendCalls(page)).toBe(0);
    expect(await entries(page)).toEqual([]);
    // ネイティブ側へは、オフが伝わっているだけ。
    expect(await setLoggingCalls(page)).toEqual([false]);
    // タイピング音自体は動いている（ログが、音の動作を止めていない）。
    expect(await page.evaluate(() => (window as unknown as { __mdeE2ETypingSound: { contexts: number } }).__mdeE2ETypingSound.contexts)).toBe(1);
  });
});

test.describe('設定「診断」の節 (Q2)', () => {
  test('最後の節「診断」に「ログを記録する」（既定はオフ）、置き場所と、オフにしても残ることの説明がある', async ({ page, platform }) => {
    await launchWith(page);
    await page.keyboard.press('ControlOrMeta+,');
    await expect(dialog(page)).toBeVisible();
    const diagnostics = dialog(page).getByTestId('settings-diagnostics');
    await expect(dialog(page).locator('.settings-section h3').last()).toHaveText('診断');
    await expect(diagnostics.getByRole('heading', { name: '診断' })).toBeVisible();
    const check = diagnostics.getByRole('checkbox', { name: 'ログを記録する' });
    await expect(check).not.toBeChecked();
    await expect(diagnostics.getByRole('checkbox')).toHaveCount(1);
    await expect(diagnostics).toContainText('オフにしても、書いたファイルは残ります');
    await expect(diagnostics).toContainText('本文とファイルのパスは書きません');
    const location = diagnostics.getByTestId('log-location');
    if (platform === 'mac') await expect(location).toContainText('~/Library/Logs/io.github.tanabe1478.immersive-markdown-editor/');
    else {
      await expect(location).toContainText('OS のログのフォルダ');
      await expect(location).not.toContainText('~/Library/Logs');
    }
    // 開いただけでは、保存もされず、渡されもしない。
    expect(await setLoggingCalls(page)).toEqual([false]);
    expect(await appendCalls(page)).toBe(0);
  });

  test('オンにすると保存され、ネイティブ側が有効になり、記録が渡される。オフに戻すと、ためていた分を捨てて止まる', async ({ page }) => {
    await launchWith(page);
    await page.keyboard.press('ControlOrMeta+,');
    const check = dialog(page).getByRole('checkbox', { name: 'ログを記録する' });
    await check.check();
    await expect.poll(() => savedPreferences(page)).toMatchObject({ appLog: true });
    await expect.poll(() => setLoggingCalls(page)).toEqual([false, true]);
    // オンにしたことの記録（userAgent つき）が、まとめて 1 回で渡る。
    await seen(page, 'app', 'logging-enabled');
    const [enabled] = await named(page, 'app', 'logging-enabled');
    expect(enabled!.level).toBe('info');
    expect(enabled!.data.user_agent).toBe(await page.evaluate(() => navigator.userAgent));
    expect(Number.isNaN(Date.parse(enabled!.t))).toBe(false);

    // オフに戻す直前に起きたことは、渡る前なら捨てる。同じ tick の中で、記録してからオフにする。
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { get: () => 'hidden', configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
      document.querySelector<HTMLInputElement>('[data-testid="settings-diagnostics"] input[type="checkbox"]')!.click();
    });
    await expect.poll(() => savedPreferences(page)).toMatchObject({ appLog: false });
    await expect.poll(() => setLoggingCalls(page)).toEqual([false, true, false]);
    const callsAtOff = await appendCalls(page);
    // オフの間は、何が起きても渡さない。
    await page.evaluate(() => {
      document.dispatchEvent(new Event('visibilitychange'));
      setTimeout(() => {
        throw new Error('after off');
      });
    });
    await page.waitForTimeout(2500);
    expect(await appendCalls(page)).toBe(callsAtOff);
    expect(await named(page, 'app', 'visibility')).toEqual([]);
    expect(await named(page, 'app', 'uncaught-error')).toEqual([]);

    // もう一度オンにすると、また記録される（前の数えは捨てている）。
    await page.evaluate(() => document.querySelector<HTMLInputElement>('[data-testid="settings-diagnostics"] input[type="checkbox"]')!.click());
    await expect.poll(() => setLoggingCalls(page)).toEqual([false, true, false, true]);
    await expect.poll(async () => (await named(page, 'app', 'logging-enabled')).length, { timeout: 6000 }).toBe(2);
    expect(await appendCalls(page)).toBeGreaterThan(callsAtOff);
  });

  test('オンのまま再読み込みしても保たれ、起動の記録（userAgent）が最初に出る。ネイティブ側へは、最初から有効が伝わる', async ({ page }) => {
    await launchWith(page, { preferences: { appLog: true } });
    await expect.poll(() => setLoggingCalls(page)).toEqual([true]);
    await seen(page, 'app', 'start');
    const [start] = await named(page, 'app', 'start');
    expect(start!.data.user_agent).toBe(await page.evaluate(() => navigator.userAgent));
    expect(start!.data.visibility).toBe('visible');
    expect(await named(page, 'app', 'logging-enabled')).toEqual([]);
    await page.keyboard.press('ControlOrMeta+,');
    await expect(dialog(page).getByRole('checkbox', { name: 'ログを記録する' })).toBeChecked();

    // 同じタブでの再読み込み（メモリ bridge は保存した設定を読み直す）。
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-ready', 'true');
    await expect.poll(() => setLoggingCalls(page)).toEqual([true]);
    await seen(page, 'app', 'start');
  });
});

test.describe('本体の記録 (Q4)', () => {
  test('拾われなかった例外と、拾われなかった Promise の拒否を、種類、切ったメッセージ、ファイル名と行つきで記録する', async ({ page }) => {
    await launchWith(page, { preferences: { appLog: true } });
    await expect.poll(() => setLoggingCalls(page)).toEqual([true]);
    await page.evaluate(() => {
      setTimeout(() => {
        throw new RangeError(`bad range /Users/alice/Documents/x.md ${'z'.repeat(400)}`);
      });
      void Promise.reject(new TypeError('rejected /home/bob/y'));
    });
    await seen(page, 'app', 'uncaught-error');
    await seen(page, 'app', 'unhandled-rejection');
    const [error] = await named(page, 'app', 'uncaught-error');
    expect(error).toMatchObject({ level: 'error' });
    expect(error!.data.error).toBe('RangeError');
    expect(String(error!.data.message).startsWith('bad range ~/Documents/x.md zzz')).toBe(true);
    expect(String(error!.data.message).length).toBe(300);
    // evaluate で動かしたコードには、ファイルがない（file は null。行はある）。
    expect(error!.data.file).toBeNull();
    expect(typeof error!.data.line).toBe('number');
    const [rejection] = await named(page, 'app', 'unhandled-rejection');
    expect(rejection!.data).toEqual({ error: 'TypeError', message: 'rejected ~/y' });
    expect(JSON.stringify(await entries(page))).not.toMatch(/alice|bob/);
  });

  test('スクリプトのファイルから投げられた例外は、ファイル名（ベース名。URL でもパスでもない）と行を添える', async ({ page }) => {
    await page.route('**/e2e-thrower.js?*', (route) =>
      route.fulfill({ contentType: 'text/javascript', body: "// line 1\n// line 2\nsetTimeout(() => { throw new Error('thrown from a script file'); });\n" }),
    );
    await launchWith(page, { preferences: { appLog: true } });
    await expect.poll(() => setLoggingCalls(page)).toEqual([true]);
    await page.evaluate(() => {
      const script = document.createElement('script');
      script.src = '/assets/e2e-thrower.js?token=abc';
      document.head.append(script);
    });
    await seen(page, 'app', 'uncaught-error');
    const [error] = await named(page, 'app', 'uncaught-error');
    expect(error!.data).toMatchObject({ error: 'Error', file: 'e2e-thrower.js', line: 3 });
    expect(String(error!.data.message)).toContain('thrown from a script file');
    expect(JSON.stringify(error)).not.toMatch(/token|127\.0\.0\.1|\/assets/);
  });

  test('visibilitychange の hidden と visible を記録する', async ({ page }) => {
    await launchWith(page, { preferences: { appLog: true } });
    await expect.poll(() => setLoggingCalls(page)).toEqual([true]);
    await page.evaluate(() => {
      let state = 'hidden';
      Object.defineProperty(document, 'visibilityState', { get: () => state, configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
      state = 'visible';
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await expect.poll(async () => (await named(page, 'app', 'visibility')).map((e) => e.data.state)).toEqual(['hidden', 'visible']);
  });

  test('時計の飛び（スリープからの復帰の目印）を、飛んだ秒数で記録する', async ({ page }) => {
    // 偽の時計（Playwright の clock）を、ページを開く前に入れる。fastForward は、スリープで時間だけが進んだ状態の模擬（タイマーは 1 回だけ動く）。
    await page.clock.install();
    await launchWith(page, { preferences: { appLog: true } });
    await expect.poll(() => setLoggingCalls(page)).toEqual([true]);
    // 普通の 10 秒の間隔では、記録しない。
    await page.clock.runFor(10_000);
    await page.clock.runFor(10_000);
    expect(await named(page, 'app', 'clock-jump')).toEqual([]);
    await page.clock.fastForward(5 * 60_000);
    await page.clock.runFor(2000);
    await seen(page, 'app', 'clock-jump');
    const [jump] = await named(page, 'app', 'clock-jump');
    expect(jump!.level).toBe('warn');
    expect(jump!.data.jump_seconds).toBeGreaterThanOrEqual(285);
    expect(jump!.data.jump_seconds).toBeLessThanOrEqual(300);
    expect(jump!.data.elapsed_seconds).toBeGreaterThan(jump!.data.jump_seconds as number);
    expect(jump!.data.visibility).toBe('visible');
  });

  test('文書を開く・保存・別名保存・草稿の書き込みの失敗を、操作の名前とエラーの種類だけで記録する（本文もパスもメッセージも出ない）', async ({ page }) => {
    await launchWith(page, { preferences: { appLog: true }, savePath: '/Users/e2e-user/Documents/secret-folder/saved-as.md' }, '最初');
    await expect.poll(() => setLoggingCalls(page)).toEqual([true]);

    // 開く（ダイアログ）。
    await page.evaluate(() => (window.__mdeE2E!.failNext.openDocument = 'not-utf8'));
    await page.keyboard.press('ControlOrMeta+o');
    await expect(page.getByTestId('toast')).toBeVisible();
    // 開けた文書で、本文に目印を打つ。
    await openDoc(page);
    await page.locator('.cm-content').click();
    await page.keyboard.press('ControlOrMeta+End');
    await page.keyboard.type(MARKER);
    // 保存。
    await page.evaluate(() => (window.__mdeE2E!.failNext.saveDocument = 'permission-denied'));
    await page.keyboard.press('ControlOrMeta+s');
    // 別名で保存。
    await page.evaluate(() => (window.__mdeE2E!.failNext.saveDocumentAs = 'io'));
    await page.keyboard.press('ControlOrMeta+Shift+s');
    // 草稿の書き込み（入力が止まって約 2 秒後に自動で書く）。
    await page.evaluate(() => (window.__mdeE2E!.failNext.writeDraft = 'io'));
    await page.keyboard.type('x');

    await expect.poll(async () => (await named(page, 'document', 'draft-write-failed')).length, { timeout: 8000 }).toBe(1);
    const failures = (await entries(page)).filter((e) => e.source === 'document');
    expect(failures.map((e) => [e.level, e.event, e.data])).toEqual([
      ['error', 'open-failed', { op: 'open', error: 'BridgeError', kind: 'not-utf8' }],
      ['error', 'save-failed', { op: 'save', error: 'BridgeError', kind: 'permission-denied' }],
      ['error', 'save-as-failed', { op: 'save-as', error: 'BridgeError', kind: 'io' }],
      ['error', 'draft-write-failed', { op: 'draft-write', error: 'BridgeError', kind: 'io' }],
    ]);
  });

  test('部品が止められたことを、部品の id と理由で記録する', async ({ page }) => {
    await launchWith(page, { preferences: { appLog: true }, isolated: { plugins: ['e2e-activate-throws', 'e2e-throws'] } });
    await expect.poll(() => setLoggingCalls(page)).toEqual([true]);
    await seen(page, 'plugin', 'stopped');
    await expect.poll(async () => (await named(page, 'plugin', 'stopped')).map((e) => e.data.id)).toContain('e2e-activate-throws');
    const stopped = await named(page, 'plugin', 'stopped');
    const activate = stopped.find((e) => e.data.id === 'e2e-activate-throws')!;
    expect(activate.level).toBe('error');
    expect(String(activate.data.reason)).toContain('activate boom');
    // 動作中の例外でも（コマンドの実行）。
    await openDoc(page);
    await page.locator('.cm-content').click();
    await page.keyboard.press('ControlOrMeta+Shift+X');
    await expect.poll(async () => (await named(page, 'plugin', 'stopped')).map((e) => e.data.id)).toContain('e2e-throws');
    const thrown = (await named(page, 'plugin', 'stopped')).find((e) => e.data.id === 'e2e-throws')!;
    expect(String(thrown.data.reason)).toContain('boom');
  });
});

test.describe('本文とパスは書かない (Q2)', () => {
  test('本文に打った目印と、開いたファイルのパスが、どの記録にも出ない', async ({ page }) => {
    await launchWith(page, { preferences: { appLog: true, typingSound: true }, isolated: { plugins: ['e2e-activate-throws'] } }, 'はじめ');
    await expect.poll(() => setLoggingCalls(page)).toEqual([true]);
    await openDoc(page);
    await page.locator('.cm-content').click();
    await page.keyboard.press('ControlOrMeta+End');
    await page.keyboard.type(MARKER);
    await page.keyboard.press('ControlOrMeta+s');
    await expect(page.getByTestId('unsaved-mark')).toHaveCount(0);
    // 失敗も起こして、エラーの経路にも目印とパスが出ないことを見る（失敗のメッセージにはパスが入っている）。
    await page.evaluate(() => (window.__mdeE2E!.failNext.saveDocument = 'io'));
    await page.keyboard.type('!');
    await page.keyboard.press('ControlOrMeta+s');
    await page.evaluate(() => {
      setTimeout(() => {
        throw new Error('plain error');
      });
    });
    await page.keyboard.press('ControlOrMeta+,');
    await page.keyboard.press('Escape');
    await expect.poll(async () => (await named(page, 'document', 'save-failed')).length).toBe(1);
    await seen(page, 'app', 'uncaught-error');
    // 渡された分（appendLog に渡された引数の全部）に、本文の目印も、パスの断片も、ホームの名前もない。
    const everything = await page.evaluate(() => JSON.stringify(window.__mdeE2E!.logging.appendLogCalls));
    expect(everything.length).toBeGreaterThan(100);
    for (const secret of [MARKER, 'BODY-MARKER', DOC, 'secret-folder', 'diary', 'e2e-user', 'secret-path', '/Users/', 'はじめ']) {
      expect(everything, secret).not.toContain(secret);
    }
    expect(await page.evaluate(() => window.__mdeE2E!.editor!.getText())).toContain(MARKER);
  });
});

// ---- タイピング音（Q3） ----

/** 本物の AudioContext に被せる包み。currentTime を止められ、作った AudioContext を取り出せる（ページを開く前に入れる）。 */
async function wrapAudioContext(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as { AudioContext: typeof AudioContext; __audioContexts: AudioContext[]; __audioFrozen: boolean; __audioFrozenAt: number | undefined };
    const Real = w.AudioContext;
    w.__audioContexts = [];
    w.__audioFrozen = false;
    class Wrapped extends Real {
      constructor(options?: AudioContextOptions) {
        super(options);
        w.__audioContexts.push(this);
      }
      get currentTime(): number {
        if (!w.__audioFrozen) {
          w.__audioFrozenAt = undefined;
          return super.currentTime;
        }
        w.__audioFrozenAt ??= super.currentTime;
        return w.__audioFrozenAt;
      }
    }
    w.AudioContext = Wrapped;
  });
}

const sound = (page: Page, event: string) => named(page, 'typing-sound', event);
const soundEvents = async (page: Page) => (await entries(page)).filter((e) => e.source === 'typing-sound');

/** 最初の鳴らすキーで AudioContext を作り、デコードが終わるまで待つ。 */
async function warmUp(page: Page): Promise<void> {
  await page.locator('.cm-content').click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.press('x');
  await expect.poll(async () => (await sound(page, 'decode.result')).length, { timeout: 8000 }).toBe(1);
}

test.describe('タイピング音の記録 (Q3)', () => {
  test('AudioContext を作ったこと（sampleRate、遅延、state）とデコードの結果（音色、成功と失敗の数）を記録する', async ({ page }) => {
    await wrapAudioContext(page);
    await launchWith(page, { preferences: { appLog: true, typingSound: true } });
    await expect.poll(() => setLoggingCalls(page)).toEqual([true]);
    // 設定がオンでも、AudioContext は最初の鳴らすキーまで作らない（記録もない）。
    await page.waitForTimeout(300);
    expect(await sound(page, 'context.created')).toEqual([]);
    await warmUp(page);
    await expect.poll(async () => (await sound(page, 'context.created')).length).toBe(1);
    const [created] = await sound(page, 'context.created');
    expect(created!.level).toBe('info');
    expect(created!.data.sample_rate).toBeGreaterThan(8000);
    expect(created!.data.base_latency === null || typeof created!.data.base_latency === 'number').toBe(true);
    expect(created!.data.output_latency === null || typeof created!.data.output_latency === 'number').toBe(true);
    expect(['running', 'suspended']).toContain(created!.data.state);
    const [decoded] = await sound(page, 'decode.result');
    expect(decoded).toMatchObject({ level: 'info', data: { timbre: 'keyboard', ok: 10, failed: 0 } });
    // 鳴らすキーごとには書かない: 20 キー押しても、増えるのは状態が変わったときだけ。
    const before = (await soundEvents(page)).length;
    for (let i = 0; i < 20; i++) {
      await page.waitForTimeout(40);
      await page.keyboard.press('a');
    }
    await page.waitForTimeout(1500);
    const added = (await soundEvents(page)).slice(before).map((e) => e.event);
    // R16: 出力の遅れの見積もり（output.latency）は、1 分に 1 回だけ増える（鳴らすキーごとではない）。
    expect(added.filter((e) => !['context.statechange', 'resume.requested', 'resume.result', 'output.latency'].includes(e))).toEqual([]);
    expect(added.filter((e) => e === 'output.latency').length).toBeLessThanOrEqual(1);
    expect(added.length).toBeLessThan(6);
    // 音の要求は、従来どおり出ている。
    expect(await page.evaluate(() => (window as unknown as { __mdeE2ETypingSound: { requests: unknown[] } }).__mdeE2ETypingSound.requests.length)).toBeGreaterThan(5);
  });

  test('statechange（前と後の状態、currentTime）と、resume を頼んだこととその結果を記録する', async ({ page }) => {
    await wrapAudioContext(page);
    await launchWith(page, { preferences: { appLog: true, typingSound: true } });
    await expect.poll(() => setLoggingCalls(page)).toEqual([true]);
    await warmUp(page);
    await page.keyboard.press('a');
    await expect.poll(() => page.evaluate(() => (window as unknown as { __audioContexts: AudioContext[] }).__audioContexts[0]!.state)).toBe('running');
    // 窓が裏に回った（スリープなど）ことの模擬: suspend() で state を変える。
    await page.evaluate(() => (window as unknown as { __audioContexts: AudioContext[] }).__audioContexts[0]!.suspend());
    await page.waitForTimeout(100);
    await page.keyboard.press('b');
    await expect.poll(async () => (await sound(page, 'resume.result')).length, { timeout: 8000 }).toBeGreaterThan(0);
    const changes = await sound(page, 'context.statechange');
    const toSuspended = changes.find((e) => e.data.to === 'suspended');
    expect(toSuspended).toMatchObject({ level: 'info', data: { from: 'running', to: 'suspended' } });
    expect(typeof toSuspended!.data.current_time).toBe('number');
    expect(changes.some((e) => e.data.from === 'suspended' && e.data.to === 'running')).toBe(true);
    const [request] = await sound(page, 'resume.requested');
    expect(request!.data.state).toBe('suspended');
    const [result] = await sound(page, 'resume.result');
    expect(result).toMatchObject({ level: 'info', data: { ok: true } });
  });

  test('時計の止まりの疑い: state が running のまま currentTime が進まなければ 1 回だけ warn、進み始めたら info で回復を記録する（作り直しはしない）', async ({ page }) => {
    await wrapAudioContext(page);
    await launchWith(page, { preferences: { appLog: true, typingSound: true } });
    await expect.poll(() => setLoggingCalls(page)).toEqual([true]);
    await warmUp(page);
    const contexts = () => page.evaluate(() => (window as unknown as { __mdeE2ETypingSound: { contexts: number } }).__mdeE2ETypingSound.contexts);
    // 正常: 基準を取って、500ms 以上あけて 2 回押しても、止まりとは見ない。
    await page.waitForTimeout(100);
    await page.keyboard.press('a');
    await page.waitForTimeout(650);
    await page.keyboard.press('b');
    expect(await sound(page, 'clock.stalled')).toEqual([]);

    // 止める。state は running のまま。
    await page.evaluate(() => {
      const w = window as unknown as { __audioContexts: AudioContext[]; __audioFrozen: boolean };
      w.__audioFrozen = true;
      void w.__audioContexts[0]!.currentTime; // 止めた値を、この時点で決める
    });
    expect(await page.evaluate(() => (window as unknown as { __audioContexts: AudioContext[] }).__audioContexts[0]!.state)).toBe('running');
    await page.waitForTimeout(700);
    await page.keyboard.press('c');
    await expect.poll(async () => (await sound(page, 'clock.stalled')).length).toBe(1);
    const [stalled] = await sound(page, 'clock.stalled');
    expect(stalled).toMatchObject({ level: 'warn', data: { state: 'running' } });
    expect(stalled!.data.elapsed_ms).toBeGreaterThanOrEqual(500);
    expect(stalled!.data.advance_ms).toBeLessThan((stalled!.data.elapsed_ms as number) / 4);

    // 続く間は、もう記録しない。
    await page.waitForTimeout(700);
    await page.keyboard.press('d');
    await page.waitForTimeout(700);
    await page.keyboard.press('e');
    expect((await sound(page, 'clock.stalled')).length).toBe(1);
    expect(await sound(page, 'clock.recovered')).toEqual([]);

    // 進み始めたら、回復を 1 回。
    await page.evaluate(() => ((window as unknown as { __audioFrozen: boolean }).__audioFrozen = false));
    await page.waitForTimeout(700);
    await page.keyboard.press('f');
    await expect.poll(async () => (await sound(page, 'clock.recovered')).length).toBe(1);
    const [recovered] = await sound(page, 'clock.recovered');
    expect(recovered).toMatchObject({ level: 'info', data: { state: 'running' } });
    expect(recovered!.data.advance_ms).toBeGreaterThanOrEqual((recovered!.data.elapsed_ms as number) / 4);
    // 記録だけで、AudioContext は作り直していない。
    expect(await contexts()).toBe(1);
  });

  test('素材の読み込みの失敗（音色と HTTP の状態）と、デコードの失敗（成功と失敗の数）を記録する', async ({ page }) => {
    await page.route('**/*.wav', (route) => route.fulfill({ status: 404, body: 'not found' }));
    await launchWith(page, { preferences: { appLog: true, typingSound: true } });
    await expect.poll(() => setLoggingCalls(page)).toEqual([true]);
    await seen(page, 'typing-sound', 'fetch.failed');
    const [failed] = await sound(page, 'fetch.failed');
    expect(failed).toMatchObject({ level: 'warn', data: { timbre: 'keyboard', status: 404, error: 'SoundHttpError' } });
    // 本文のログに、素材の URL もメッセージも出ない。
    expect(JSON.stringify(failed)).not.toMatch(/\.wav|assets|not found/);
  });

  test('デコードできない素材（200 で壊れたデータ）は、デコードの結果の warn に、失敗の数とエラーの名前で記録する', async ({ page }) => {
    await page.route('**/*.wav', (route) => route.fulfill({ status: 200, contentType: 'audio/wav', body: Buffer.from('this is not audio data at all') }));
    await launchWith(page, { preferences: { appLog: true, typingSound: true } });
    await expect.poll(() => setLoggingCalls(page)).toEqual([true]);
    await page.locator('.cm-content').click();
    await page.keyboard.press('x');
    await seen(page, 'typing-sound', 'decode.result');
    const [result] = await sound(page, 'decode.result');
    expect(result).toMatchObject({ level: 'warn', data: { timbre: 'keyboard', ok: 0, failed: 10 } });
    expect(typeof result!.data.error).toBe('string');
  });

  test('devicechange（イベントが使える環境だけ）を記録する', async ({ page }) => {
    await wrapAudioContext(page);
    await launchWith(page, { preferences: { appLog: true, typingSound: true } });
    await expect.poll(() => setLoggingCalls(page)).toEqual([true]);
    const available = await page.evaluate(() => typeof navigator.mediaDevices?.addEventListener === 'function');
    test.skip(!available, 'この環境の navigator.mediaDevices は、イベントを送れない');
    await warmUp(page);
    await page.evaluate(() => navigator.mediaDevices.dispatchEvent(new Event('devicechange')));
    await seen(page, 'typing-sound', 'devicechange');
    const [change] = await sound(page, 'devicechange');
    expect(change).toMatchObject({ level: 'info' });
    expect(['running', 'suspended']).toContain(change!.data.state);
  });

  test('ログがオフなら、タイピング音は何も記録せず（appendLog は 0 回）、音の要求は同じように出る', async ({ page }) => {
    await wrapAudioContext(page);
    await launchWith(page, { preferences: { typingSound: true } });
    await page.locator('.cm-content').click();
    await page.keyboard.press('ControlOrMeta+End');
    await page.keyboard.press('x');
    await expect.poll(() => page.evaluate(() => (window as unknown as { __mdeE2ETypingSound: { decoded: number } }).__mdeE2ETypingSound.decoded)).toBe(1);
    await page.waitForTimeout(100);
    for (let i = 0; i < 5; i++) {
      await page.waitForTimeout(60);
      await page.keyboard.press('a');
    }
    await expect.poll(() => page.evaluate(() => (window as unknown as { __mdeE2ETypingSound: { requests: unknown[] } }).__mdeE2ETypingSound.requests.length)).toBeGreaterThan(2);
    await page.waitForTimeout(1500);
    expect(await appendCalls(page)).toBe(0);
  });
});
