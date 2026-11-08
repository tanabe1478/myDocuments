import { expect, type CDPSession, type Page } from '@playwright/test';
import { docTitle, launch, test, unsavedMark, utf8 } from './helpers';

// R9: 同梱の部品「タイピング音」。キーを押すたびに打鍵音を鳴らす（既定はオフ）。
// 音の要求の数え方（window.__mdeE2ETypingSound）は e2e のビルドだけにある（本番の dist には入らない）。
// Playwright の chromium は --mute-audio で起動するので、実際の音は出ない。数えるのは「鳴らす要求を出した」ところまで。
// 実際に音が聞こえるか（Tauri の窓、WKWebView）は、このテストでは確かめられない（未確認）。

const DOC = '/docs/sound.md';

interface Probe {
  fetches: number;
  contexts: number;
  decoded: number;
  decodedCount: number;
  requests: Array<{ kind: string; index: number; rate: number; gain: number }>;
}

const dialog = (page: Page) => page.getByRole('dialog', { name: '設定' });
const probe = (page: Page) => page.evaluate(() => (window as unknown as { __mdeE2ETypingSound?: Probe }).__mdeE2ETypingSound ?? null);
const requests = async (page: Page) => (await probe(page))!.requests;
const savedPreferences = (page: Page) => page.evaluate(() => window.__mdeE2E!.savedPreferences.at(-1) as Record<string, unknown> | undefined);
const text = (page: Page) => page.evaluate(() => window.__mdeE2E!.editor!.getText());

async function launchWith(page: Page, body = '', preferences: Record<string, unknown> = {}): Promise<void> {
  await launch(page, { files: { [DOC]: utf8(body) }, openPath: DOC, preferences: { theme: 'light', autoHideChrome: false, ...preferences } });
  await page.keyboard.press('ControlOrMeta+o');
  await expect(docTitle(page)).toHaveText('sound.md');
}

/** 本文にフォーカスして、末尾へ。 */
async function focusEnd(page: Page): Promise<void> {
  await page.locator('.cm-content').click();
  await page.keyboard.press('ControlOrMeta+End');
}

/**
 * 最初の鳴らすキーは AudioContext を作ってデコードを始めるだけで、鳴らない（デコードの前）。
 * ここで 1 キー押し、デコードが終わるのを待ってから、数え始める。
 */
async function warmUp(page: Page): Promise<void> {
  await focusEnd(page);
  await page.keyboard.press('x');
  await expect.poll(async () => (await probe(page))!.decoded).toBe(1);
  expect((await probe(page))!.decodedCount).toBe(10);
  expect(await requests(page)).toEqual([]);
}

/** 間引き（30ms に 1 回）を避けるため、間を置いてから押す。固定の待ちは、間引きの間隔を空けるためだけ。 */
async function pressSpaced(page: Page, key: string): Promise<void> {
  await page.waitForTimeout(45);
  await page.keyboard.press(key);
}

test.describe('設定画面 (Q1)', () => {
  test('「執筆の補助」に「タイピング音」（既定オフ）、新しい「音」の節に音量（小・中・大、既定は中）がある', async ({ page }) => {
    await launchWith(page);
    await page.keyboard.press('ControlOrMeta+,');
    await expect(dialog(page)).toBeVisible();

    const check = dialog(page).getByRole('checkbox', { name: 'タイピング音' });
    await expect(check).not.toBeChecked();
    // 「執筆の補助」の枠の中の、最後の項目。
    const aids = dialog(page).locator('fieldset', { has: page.locator('legend', { hasText: '執筆の補助' }) });
    await expect(aids.getByRole('checkbox')).toHaveCount(4);
    await expect(aids.getByRole('checkbox').last()).toHaveAccessibleName('タイピング音');

    const sound = dialog(page).getByTestId('settings-sound');
    await expect(sound.getByRole('heading', { name: '音' })).toBeVisible();
    await expect(sound.getByRole('radio')).toHaveCount(3);
    await expect(sound.getByRole('radio', { name: '小' })).not.toBeChecked();
    await expect(sound.getByRole('radio', { name: '中' })).toBeChecked();
    await expect(sound.getByRole('radio', { name: '大' })).not.toBeChecked();
    // 節の並び: 外観、編集、音。
    await expect(dialog(page).locator('.settings-section h3')).toHaveText(['外観', '編集', '音']);
  });

  test('チェックと音量を操作すると保存され、再読み込み（起動し直し）のあとも残る', async ({ page }) => {
    await launchWith(page);
    await page.keyboard.press('ControlOrMeta+,');
    await dialog(page).getByRole('checkbox', { name: 'タイピング音' }).check();
    await dialog(page).getByTestId('settings-sound').getByRole('radio', { name: '大' }).check();
    await expect.poll(() => savedPreferences(page)).toMatchObject({ typingSound: true, typingSoundVolume: 'high' });
    const saved = (await savedPreferences(page))!;
    // 保存の形は、ほかの部品の設定と同じ（最上位の真偽値と文字列）。
    expect(saved.typingSound).toBe(true);
    expect(saved.typingSoundVolume).toBe('high');

    // 起動し直し: メモリ bridge は、同じタブでの再読み込みで、保存した設定を読み直す。
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-ready', 'true');
    await page.keyboard.press('ControlOrMeta+,');
    await expect(dialog(page).getByRole('checkbox', { name: 'タイピング音' })).toBeChecked();
    await expect(dialog(page).getByTestId('settings-sound').getByRole('radio', { name: '大' })).toBeChecked();
    // オンで起動したので、素材の読み込みが始まっている（AudioContext はキーまで作らない）。
    await expect.poll(async () => (await probe(page))!.fetches).toBe(1);
    expect((await probe(page))!.contexts).toBe(0);
  });

  test('音量は「小」に変えても保存され、オフのままなら素材も AudioContext も使わない', async ({ page }) => {
    await launchWith(page);
    await page.keyboard.press('ControlOrMeta+,');
    await dialog(page).getByTestId('settings-sound').getByRole('radio', { name: '小' }).check();
    await expect.poll(() => savedPreferences(page)).toMatchObject({ typingSound: false, typingSoundVolume: 'low' });
    await page.keyboard.press('Escape');
    await focusEnd(page);
    await page.keyboard.type('abc');
    expect(await probe(page)).toEqual({ fetches: 0, contexts: 0, decoded: 0, decodedCount: 0, requests: [] });
  });

  test('ショートカットでは、タイピング音は切り替わらない（タイプライターモードの Mod+Shift+T は、これまでどおり切り替わる）', async ({ page }) => {
    await launchWith(page);
    // どのキーの組み合わせも、タイピング音のオンには結びつかない。
    await page.keyboard.press('ControlOrMeta+Shift+S');
    await page.keyboard.press('ControlOrMeta+t');
    await expect.poll(async () => (await savedPreferences(page))?.typingSound ?? false).toBe(false);
    // タイプライターモード（Mod+Shift+T）は、これまでどおり切り替わる。
    await page.keyboard.press('ControlOrMeta+Shift+T');
    await expect.poll(() => savedPreferences(page)).toMatchObject({ typewriterMode: true });
    expect(await probe(page)).toMatchObject({ fetches: 0, contexts: 0 });
  });
});

test.describe('音の要求（e2e のビルドだけの数え方）(Q3)', () => {
  test('オフの間は、キーを押しても素材の fetch も AudioContext も音の要求もない', async ({ page }) => {
    await launchWith(page, 'a');
    expect(await probe(page)).toEqual({ fetches: 0, contexts: 0, decoded: 0, decodedCount: 0, requests: [] });
    await focusEnd(page);
    for (const key of ['b', 'Enter', 'Backspace', 'Tab', 'Delete', ' ']) await pressSpaced(page, key);
    await page.keyboard.type('日本語');
    expect(await probe(page)).toEqual({ fetches: 0, contexts: 0, decoded: 0, decodedCount: 0, requests: [] });
  });

  test('オンで起動すると素材を fetch し、AudioContext は最初のキーまで作らない。デコード後、キー 1 回につき要求が 1 回', async ({ page }) => {
    await launchWith(page, '', { typingSound: true });
    await expect.poll(async () => (await probe(page))!.fetches).toBe(1);
    expect(await probe(page)).toMatchObject({ contexts: 0, requests: [] });

    await warmUp(page);
    expect((await probe(page))!.contexts).toBe(1);

    await pressSpaced(page, 'a');
    expect(await requests(page)).toHaveLength(1);
    await pressSpaced(page, 'b');
    await pressSpaced(page, ' ');
    await pressSpaced(page, 'Backspace');
    await pressSpaced(page, 'Delete');
    await pressSpaced(page, 'Tab');
    const all = await requests(page);
    expect(all).toHaveLength(6);
    // 1 つのキーにつき 1 つ。音は 10 個のどれかで、高さと音量は決めた幅の中（既定の音量は中）。
    for (const r of all) {
      expect(r.kind).toBe('key');
      expect(r.index).toBeGreaterThanOrEqual(0);
      expect(r.index).toBeLessThan(10);
      expect(r.rate).toBeGreaterThanOrEqual(0.96);
      expect(r.rate).toBeLessThanOrEqual(1.04);
      expect(r.gain).toBeGreaterThanOrEqual(0.5 * 0.9);
      expect(r.gain).toBeLessThanOrEqual(0.5 * 1.1);
    }
    // 直前と同じ音は続かない。
    for (let i = 1; i < all.length; i++) expect(all[i]!.index).not.toBe(all[i - 1]!.index);
    // AudioContext は 1 つだけ。
    expect((await probe(page))!.contexts).toBe(1);
  });

  test('鳴らさないキー（修飾キーだけ、Cmd/Ctrl のショートカット、矢印などの移動、Escape、ファンクション）は要求を出さない', async ({ page }) => {
    await launchWith(page, 'abc\ndef', { typingSound: true });
    await warmUp(page);
    for (const key of ['Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'ArrowLeft', 'ArrowUp', 'Home', 'End', 'PageUp', 'Escape', 'F7', 'ControlOrMeta+a', 'ControlOrMeta+ArrowLeft', 'Shift+ArrowRight']) {
      await pressSpaced(page, key);
    }
    expect(await requests(page)).toEqual([]);
    // そのあとでも、文字は 1 回ずつ要求になる。
    await pressSpaced(page, 'z');
    expect(await requests(page)).toHaveLength(1);
  });

  test('Enter は少し低い音（再生速度が 0.8 前後）で、要求の種類が違う', async ({ page }) => {
    await launchWith(page, 'abc', { typingSound: true });
    await warmUp(page);
    await pressSpaced(page, 'Enter');
    const [r] = await requests(page);
    expect(r!.kind).toBe('enter');
    expect(r!.rate).toBeGreaterThanOrEqual(0.8 * 0.96);
    expect(r!.rate).toBeLessThanOrEqual(0.8 * 1.04);
  });

  test('音量の段階（小・中・大）が gain の違いとして要求に出る。変えた次のキーから効く', async ({ page }) => {
    await launchWith(page, '', { typingSound: true });
    await warmUp(page);
    const gains: number[] = [];
    for (const label of ['小', '中', '大'] as const) {
      await page.keyboard.press('ControlOrMeta+,');
      await dialog(page).getByTestId('settings-sound').getByRole('radio', { name: label }).check();
      await page.keyboard.press('Escape');
      await expect(dialog(page)).toHaveCount(0);
      await focusEnd(page);
      const before = (await requests(page)).length;
      await pressSpaced(page, 'a');
      const after = await requests(page);
      expect(after).toHaveLength(before + 1);
      gains.push(after.at(-1)!.gain);
    }
    const [low, medium, high] = gains as [number, number, number];
    expect(low).toBeLessThanOrEqual(0.25 * 1.1);
    expect(medium).toBeGreaterThanOrEqual(0.5 * 0.9);
    expect(medium).toBeLessThanOrEqual(0.5 * 1.1);
    expect(high).toBeGreaterThanOrEqual(1 * 0.9);
    expect(low).toBeLessThan(medium);
    expect(medium).toBeLessThan(high);
  });

  test('設定画面でオンにすると素材の読み込みが始まり、オフにすると以降の要求は出ない', async ({ page }) => {
    await launchWith(page, 'a');
    expect(await probe(page)).toMatchObject({ fetches: 0, contexts: 0 });
    await page.keyboard.press('ControlOrMeta+,');
    await dialog(page).getByRole('checkbox', { name: 'タイピング音' }).check();
    await expect.poll(async () => (await probe(page))!.fetches).toBe(1);
    await page.keyboard.press('Escape');
    await warmUp(page);
    await pressSpaced(page, 'a');
    expect(await requests(page)).toHaveLength(1);

    await page.keyboard.press('ControlOrMeta+,');
    await dialog(page).getByRole('checkbox', { name: 'タイピング音' }).uncheck();
    await page.keyboard.press('Escape');
    await focusEnd(page);
    await pressSpaced(page, 'b');
    await pressSpaced(page, 'Enter');
    expect(await requests(page)).toHaveLength(1);
    // もう一度オンにしても、素材を読み直さない（読み込み済み）。
    expect((await probe(page))!.fetches).toBe(1);
  });

  test('キーの繰り返し（押し続け）は 30ms に 1 回までに間引かれる', async ({ page }) => {
    await launchWith(page, '', { typingSound: true });
    await warmUp(page);
    // 繰り返しの keydown を、本文に短い間隔で送る（実際のキーの繰り返しと同じ repeat: true）。
    const sent = await page.evaluate(async () => {
      const content = document.querySelector('.cm-content')!;
      const start = performance.now();
      let n = 0;
      while (performance.now() - start < 300) {
        content.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', repeat: true, bubbles: true, cancelable: true }));
        n++;
        await new Promise((r) => setTimeout(r, 4));
      }
      return { n, ms: performance.now() - start };
    });
    const count = (await requests(page)).length;
    expect(sent.n).toBeGreaterThan(count);
    expect(count).toBeGreaterThanOrEqual(1);
    expect(count).toBeLessThanOrEqual(Math.floor(sent.ms / 30) + 1);
  });
});

test.describe('入力は変わらない (Q2)', () => {
  test('入力した文字と Backspace がそのまま入る（オンのとき）', async ({ page }) => {
    await launchWith(page, '', { typingSound: true });
    await warmUp(page);
    await page.keyboard.press('Backspace');
    await page.keyboard.type('hello, 世界');
    expect(await text(page)).toBe('hello, 世界');
    await page.keyboard.press('Backspace');
    expect(await text(page)).toBe('hello, 世');
    await expect(unsavedMark(page)).toBeVisible();
  });

  test('Enter でリストの項目が続き、続けて書いた文字が新しい項目に入る（オンのとき）', async ({ page }) => {
    await launchWith(page, '- 一つ目\n  - 入れ子', { typingSound: true });
    await warmUp(page);
    await page.keyboard.press('Backspace');
    await page.keyboard.press('ControlOrMeta+End');
    await pressSpaced(page, 'Enter');
    expect(await text(page)).toBe('- 一つ目\n  - 入れ子\n  - ');
    await page.keyboard.type('次');
    expect(await text(page)).toBe('- 一つ目\n  - 入れ子\n  - 次');
    // Enter はリストの継続が処理しても、音の要求は出る（1 回）。
    const enters = (await requests(page)).filter((r) => r.kind === 'enter');
    expect(enters).toHaveLength(1);
  });

  test('ショートカット（保存、設定画面）の振る舞いは変わらず、要求も出ない', async ({ page }) => {
    await launchWith(page, '', { typingSound: true });
    await warmUp(page);
    await page.keyboard.type('保存する');
    await expect(unsavedMark(page)).toBeVisible();
    const before = (await requests(page)).length;
    await page.waitForTimeout(45);
    await page.keyboard.press('ControlOrMeta+s');
    await expect(unsavedMark(page)).toHaveCount(0);
    await page.keyboard.press('ControlOrMeta+,');
    await expect(dialog(page)).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog(page)).toHaveCount(0);
    expect((await requests(page)).length).toBe(before);
    expect(await page.evaluate(() => window.__mdeE2E!.readFile('/docs/sound.md'))).toEqual(utf8('x保存する'));
  });

  test('日本語入力: 変換中の keydown（key が Process、keyCode が 229）は 1 回の要求になり、変換と確定は壊れない', async ({ page }) => {
    await launchWith(page, '前。', { typingSound: true });
    await warmUp(page);
    await page.keyboard.press('Backspace');
    await page.keyboard.press('ControlOrMeta+End');
    const client: CDPSession = await page.context().newCDPSession(page);
    const before = (await requests(page)).length;

    // 変換中のキー: 実ブラウザの IME が送る keydown（Process、229）を、CDP で本物のキーイベントとして送る。
    await page.waitForTimeout(45);
    await client.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Process', code: 'KeyN', windowsVirtualKeyCode: 229 });
    await client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'n', code: 'KeyN', windowsVirtualKeyCode: 78 });
    expect((await requests(page)).length).toBe(before + 1);

    for (const reading of ['に', 'にほ', 'にほん', 'にほんご']) {
      await client.send('Input.imeSetComposition', { text: reading, selectionStart: reading.length, selectionEnd: reading.length });
      expect(await text(page)).toBe(`前。${reading}`);
    }
    await client.send('Input.insertText', { text: '日本語' });
    expect(await text(page)).toBe('前。日本語');
    // 変換の操作そのもの（imeSetComposition、insertText）は keydown ではないので、要求にならない。
    expect((await requests(page)).length).toBe(before + 1);
  });
});
