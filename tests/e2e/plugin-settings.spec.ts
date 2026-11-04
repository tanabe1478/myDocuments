import { expect, type Page } from '@playwright/test';
import { docTitle, launch, solidPng, test, utf8 } from './helpers';

// 部品が登録した設定（リストの継続・フォーカスモードなど）は、本体のほかの設定の変更（背景画像の取り込み）の後も、
// 保存される設定と設定画面の選択に残る。

const DOC = '/docs/list.md';
const IMG = '/img/bg.png';
const LOOSE = '- a\n\n- b';

const dialog = (page: Page) => page.getByRole('dialog', { name: '設定' });
const savedPreferences = (page: Page) => page.evaluate(() => window.__mdeE2E!.savedPreferences.at(-1) as Record<string, unknown>);

test('背景画像を取り込んでも、リストの継続とフォーカスモードの設定は消えず、Enter の挙動も変わらない', async ({ page }) => {
  await launch(page, {
    files: { [DOC]: utf8(LOOSE), [IMG]: solidPng(8, 8, [20, 60, 120]) },
    openPath: DOC,
    imagePath: IMG,
    preferences: { theme: 'light', autoHideChrome: false, listContinuation: 'preserve', focusMode: true },
  });
  await page.keyboard.press('ControlOrMeta+o');
  await expect(docTitle(page)).toHaveText('list.md');

  await page.getByTestId('settings-button').click();
  await expect(dialog(page)).toBeVisible();
  await dialog(page).getByRole('radio', { name: '画像', exact: true }).check();
  await page.getByTestId('image-pick').click();
  await expect(page.getByTestId('image-status')).toHaveText('取り込み済み');

  await expect.poll(() => savedPreferences(page)).toMatchObject({
    background: { kind: 'image' },
    listContinuation: 'preserve',
    focusMode: true,
  });
  await expect(dialog(page).getByTestId('settings-editing').getByRole('radio', { name: 'リストの形に合わせる' })).toBeChecked();
  await expect(dialog(page).getByRole('checkbox', { name: 'フォーカスモード' })).toBeChecked();

  await page.keyboard.press('Escape');
  await expect(dialog(page)).toHaveCount(0);
  await page.locator('.cm-content').click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.press('Enter');
  expect(await page.evaluate(() => window.__mdeE2E!.editor!.getText())).toBe(`${LOOSE}\n\n- `);
});
