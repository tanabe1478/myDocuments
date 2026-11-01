import { expect, type Page } from '@playwright/test';
import { docTitle, launch, test, toast, utf8 } from './helpers';

// トーストの位置。広い窓では本文の列の外（右下）、狭い窓では本文に重ねるが、カーソル行は隠さない。
test.describe.configure({ mode: 'parallel' });

const DOC = '/docs/note.md';
const COPY = '/docs/copy.md';

/** 最後の段落は 16 文字。文末のカーソルが、トーストの横の範囲（窓の中ほど）に来る。 */
function longText(lines: number): string {
  return [
    ...Array.from({ length: lines }, (_, i) => `${i + 1} 段落目。トーストが出ても、この本文のカーソル行が隠れないことを確かめる。`),
    'あ'.repeat(16),
  ].join('\n\n');
}

async function openDoc(page: Page, text = longText(40), preferences: Record<string, unknown> = {}) {
  // COPY は DOC と同じ内容。別名保存の先に選ぶと、書き込みが起きず「書き込みませんでした」のトーストが出る。
  await launch(page, {
    files: { [DOC]: utf8(text), [COPY]: utf8(text) },
    openPath: DOC,
    savePath: COPY,
    preferences: { theme: 'light', ...preferences },
  });
  await page.keyboard.press('ControlOrMeta+o');
  await expect(docTitle(page)).toHaveText('note.md');
}

interface Box {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

async function box(page: Page, selector: string): Promise<Box> {
  return page.locator(selector).first().evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { top: r.top, bottom: r.bottom, left: r.left, right: r.right };
  });
}

const intersects = (a: Box, b: Box) => a.top < b.bottom && a.bottom > b.top && a.left < b.right && a.right > b.left;

/** 同じ内容のファイルへ別名で保存すると、「書き込みませんでした」のトーストが出る（本文とカーソルには触れない）。 */
async function showToast(page: Page) {
  await page.keyboard.press('ControlOrMeta+Shift+s');
  await expect(toast(page)).toBeVisible();
  // 出現の遷移（opacity）の終わりを待つ。
  await expect(toast(page)).toHaveCSS('opacity', '1');
}

/** 文末のカーソルが、表示領域の下端から 40px 上（トーストが出る帯の中）に来るまでスクロールする。 */
async function scrollCursorNearBottom(page: Page) {
  // 文末へのスクロールが終わるまで待つ（先頭にいる間は、カーソルが 1 行目にある）。
  await expect.poll(() => page.locator('.cm-scroller').evaluate((el) => el.scrollTop)).toBeGreaterThan(1000);
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  await page.locator('.cm-scroller').evaluate((el) => {
    const cursor = document.querySelector('.cm-cursor-primary')!.getBoundingClientRect();
    el.scrollTop += cursor.bottom - (el.getBoundingClientRect().bottom - 40);
  });
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  const cursor = await box(page, '.cm-cursor-primary');
  const scroller = await box(page, '.cm-scroller');
  expect(scroller.bottom - cursor.bottom).toBeGreaterThan(30);
  expect(scroller.bottom - cursor.bottom).toBeLessThan(50);
}

test.describe('広い窓（1280x800）のトースト', () => {
  test('(b) 本文の列の外に出て、列に重ならない', async ({ page }) => {
    await openDoc(page);
    await page.locator('.cm-content').click();
    await showToast(page);

    const t = await box(page, '[data-testid=toast]');
    const content = await box(page, '.cm-content');
    expect(intersects(t, content), JSON.stringify({ t, content })).toBe(false);
    // 右下（文字数表示の上）、窓に収まる。
    expect(t.left).toBeGreaterThanOrEqual(content.right);
    expect(t.right).toBeLessThanOrEqual(1280);
    expect(t.bottom).toBeLessThanOrEqual(800);
    const count = await box(page, '[data-testid=char-count]');
    expect(t.bottom).toBeLessThanOrEqual(count.top);
  });

  test('(b) 外観パネルを開いていても、パネルと重ならない', async ({ page }) => {
    await openDoc(page, longText(40), { autoHideChrome: false });
    await page.locator('.cm-content').click();
    await page.getByTestId('appearance-button').click();
    await expect(page.getByRole('dialog', { name: '外観' })).toBeVisible();
    await expect(page.locator('.app')).toHaveAttribute('data-panel-shift', 'true');
    // 本文が寄るアニメーションの終わりを待つ。
    await expect
      .poll(async () => (await box(page, '.cm-content')).right)
      .toBeLessThanOrEqual((await box(page, '.appearance-panel')).left);
    await page.getByTestId('char-count').focus();
    await showToast(page);

    const t = await box(page, '[data-testid=toast]');
    const panel = await box(page, '.appearance-panel');
    expect(intersects(t, panel), JSON.stringify({ t, panel })).toBe(false);
  });

  test('エラーのトーストも、列の外に出て、クリックで閉じる（role は alert のまま）', async ({ page }) => {
    await openDoc(page);
    // 競合を作って、保存直前の検査のエラーのトーストを出す。
    await page.locator('.cm-content').click();
    await page.keyboard.type('追記');
    await page.evaluate(() => window.__mdeE2E!.externalWrite('/docs/note.md', Array.from(new TextEncoder().encode('外部の版')), { notify: false }));
    await page.keyboard.press('ControlOrMeta+s');
    await expect(toast(page)).toBeVisible();
    await expect(page.getByRole('alert').filter({ has: toast(page) })).toHaveCount(1);

    const t = await box(page, '[data-testid=toast]');
    const content = await box(page, '.cm-content');
    expect(intersects(t, content)).toBe(false);
    await toast(page).click();
    await expect(toast(page)).toHaveCount(0);
  });
});

test.describe('狭い窓（820x700）のトースト', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 820, height: 700 });
  });

  test('(c) 文末で入力しても、カーソル行がトーストに隠れない', async ({ page }) => {
    await openDoc(page);
    await page.locator('.cm-content').click();
    await page.keyboard.press('ControlOrMeta+End');
    await scrollCursorNearBottom(page);
    await showToast(page);

    const t = await box(page, '[data-testid=toast]');
    // 本文の列に重なる配置（列の外に場所がない）。
    expect(intersects(t, await box(page, '.cm-content'))).toBe(true);

    const cursorClear = async () => {
      const cursor = await box(page, '.cm-cursor-primary');
      return !intersects(cursor, await box(page, '[data-testid=toast]'));
    };
    await expect.poll(cursorClear).toBe(true);
    // 入力を続けても、カーソルはトーストの上に残る。
    await page.keyboard.type('あいうえお');
    await page.keyboard.press('Enter');
    await page.keyboard.type('かきくけこ');
    await expect(toast(page)).toBeVisible();
    await expect.poll(cursorClear).toBe(true);
    // カーソルは本文の表示領域の中。
    const cursor = await box(page, '.cm-cursor-primary');
    const scroller = await box(page, '.cm-scroller');
    expect(cursor.top).toBeGreaterThanOrEqual(scroller.top - 1);
    expect(cursor.bottom).toBeLessThanOrEqual(scroller.bottom + 1);
  });

  test('(c) トーストの出現・消失で、本文の領域（.cm-scroller）の高さは変わらない', async ({ page }) => {
    await openDoc(page);
    await page.locator('.cm-content').click();
    await page.keyboard.press('ControlOrMeta+End');
    const before = await box(page, '.cm-scroller');
    await showToast(page);
    expect(await box(page, '.cm-scroller')).toEqual(before);
    await toast(page).click();
    await expect(toast(page)).toHaveCount(0);
    expect(await box(page, '.cm-scroller')).toEqual(before);
  });

  test('トーストは role=status の領域に出る（スクリーンリーダーへの通知）', async ({ page }) => {
    await openDoc(page);
    await page.locator('.cm-content').click();
    await showToast(page);
    await expect(page.getByRole('status').filter({ has: toast(page) })).toHaveCount(1);
  });
});
