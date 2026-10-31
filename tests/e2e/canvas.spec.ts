import { expect, type CDPSession, type Page } from '@playwright/test';
import { docTitle, launch, solidPng, test, toast, utf8 } from './helpers';

// 執筆キャンバス（Phase 1 後半）: 外観パネル、背景、コントラスト、フォーカス・タイプライター・自動非表示、
// 全画面、Reduced Motion、アクセシビリティ。

const DOC = '/docs/canvas.md';

/** 文書を開いた状態で起動する（preferences は memory bridge の保存済み設定として渡す）。 */
async function launchWithDoc(page: Page, text: string, preferences: Record<string, unknown> = {}): Promise<void> {
  await launch(page, { files: { [DOC]: utf8(text) }, openPath: DOC, preferences: { theme: 'light', ...preferences } });
  await page.keyboard.press('ControlOrMeta+o');
  await expect(docTitle(page)).toHaveText('canvas.md');
}

const panel = (page: Page) => page.getByRole('dialog', { name: '外観' });

async function openPanel(page: Page): Promise<void> {
  await page.getByTestId('appearance-button').click();
  await expect(panel(page)).toBeVisible();
}

/** 各 .cm-line に cm-md-dim が付いているか。 */
const dimFlags = (page: Page) =>
  page.locator('.cm-line').evaluateAll((els) => els.map((el) => el.classList.contains('cm-md-dim')));

const savedPreferences = (page: Page) => page.evaluate(() => window.__mdeE2E!.savedPreferences.at(-1) as Record<string, unknown>);

const opacity = (page: Page, testId: string) =>
  page.getByTestId(testId).evaluate((el) => getComputedStyle(el).opacity);

test.describe('外観パネル (R3-5)', () => {
  test('(1) 文字サイズ・行高・最大幅・テーマの変更が本文に即時反映され、保存され、再読み込み後も維持される', async ({ page }) => {
    await launch(page, { preferences: { theme: 'light' } });
    await openPanel(page);

    await panel(page).getByLabel('文字サイズ').fill('24');
    await panel(page).getByLabel('行高').fill('2.5');
    await panel(page).getByLabel('本文の最大幅').fill('900');
    await panel(page).getByRole('radio', { name: 'ダーク' }).check();

    // 即時反映（保存を待たずに computed style が変わる）
    const content = page.locator('.cm-content');
    await expect(content).toHaveCSS('font-size', '24px');
    await expect(page.locator('.cm-line').first()).toHaveCSS('line-height', '60px');
    await expect(content).toHaveCSS('max-width', '900px');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');

    // debounce 後に bridge へ保存される
    await expect
      .poll(() => savedPreferences(page))
      .toMatchObject({ fontSizePx: 24, lineHeight: 2.5, maxWidthPx: 900, theme: 'dark' });

    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-ready', 'true');
    await expect(page.locator('.cm-content')).toHaveCSS('font-size', '24px');
    await expect(page.locator('.cm-content')).toHaveCSS('max-width', '900px');
    await expect(page.locator('.cm-line').first()).toHaveCSS('line-height', '60px');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  });

  test('連続した変更は debounce され、保存は 1 回にまとまる', async ({ page }) => {
    await launch(page, { preferences: { theme: 'light' } });
    await openPanel(page);
    const size = panel(page).getByLabel('文字サイズ');
    for (const v of ['20', '21', '22', '23']) await size.fill(v);
    await expect.poll(() => page.evaluate(() => window.__mdeE2E!.savedPreferences.length)).toBeGreaterThan(0);
    await page.waitForTimeout(600);
    const saved = await page.evaluate(() => window.__mdeE2E!.savedPreferences as Array<{ fontSizePx: number }>);
    expect(saved.at(-1)?.fontSizePx).toBe(23);
    expect(saved.length).toBeLessThanOrEqual(2);
  });

  test('段落間隔・フォント（選択肢と自由入力）を変えられ、不正なフォント指定は反映されない', async ({ page }) => {
    await launch(page, { preferences: { theme: 'light' } });
    await openPanel(page);

    await panel(page).getByLabel('フォントの種類').selectOption({ label: '明朝体' });
    await expect(page.locator('.cm-scroller')).toHaveCSS('font-family', /Mincho/);

    await panel(page).getByLabel('フォントの種類').selectOption('custom');
    const free = panel(page).getByLabel('font-family（自由入力）');
    await free.fill('"Courier New", monospace');
    await expect(page.locator('.cm-scroller')).toHaveCSS('font-family', /Courier New/);

    await free.fill('a; color: red');
    await expect(panel(page).getByRole('alert')).toContainText('使えない指定');
    await expect(page.locator('.cm-scroller')).toHaveCSS('font-family', /Courier New/);

    await panel(page).getByLabel('段落間隔').fill('2');
    await expect
      .poll(() => page.evaluate(() => document.documentElement.style.getPropertyValue('--md-paragraph-spacing')))
      .toBe('2em');
    await expect.poll(() => savedPreferences(page)).toMatchObject({
      fontFamily: '"Courier New", monospace',
      paragraphSpacing: 2,
    });
  });

  test('すべての操作部品に名前があり、キーボードだけで操作でき、Esc で閉じる', async ({ page }) => {
    await launch(page, { preferences: { theme: 'light', background: { kind: 'image' } } });
    await openPanel(page);

    // すべての input / select / button に、アクセシブルな名前がある
    const unnamed = await panel(page)
      .locator('input, select, button')
      .evaluateAll((els) =>
        els
          .filter((el) => {
            const labelled = (el as HTMLInputElement).labels?.length ? true : false;
            return !labelled && !el.getAttribute('aria-label') && !el.textContent?.trim();
          })
          .map((el) => el.outerHTML),
      );
    expect(unnamed).toEqual([]);

    // 最初の部品にフォーカスが入っていて、Tab で順に進める
    await expect(panel(page).getByLabel('フォントの種類')).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(panel(page).getByLabel('文字サイズ')).toBeFocused();
    // スライダーを矢印キーで動かす
    await page.keyboard.press('ArrowRight');
    await expect(page.locator('.cm-content')).toHaveCSS('font-size', '19px');
    // テーマのラジオを矢印キーで切り替える
    await panel(page).getByRole('radio', { name: 'ライト' }).focus();
    await page.keyboard.press('ArrowRight');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');

    await page.keyboard.press('Escape');
    await expect(panel(page)).toHaveCount(0);
  });

  test('非モーダルの dialog で、開閉のたびにフォーカスが元の場所へ戻る', async ({ page }) => {
    await launch(page, { preferences: { theme: 'light' } });
    await expect(panel(page)).toHaveCount(0);

    // 本文から ショートカット → 開く → Esc → 本文へ戻る
    await page.locator('.cm-content').click();
    await page.keyboard.press('ControlOrMeta+,');
    await expect(panel(page)).toBeVisible();
    await expect(panel(page)).toHaveAttribute('aria-modal', 'false');
    await expect(panel(page).locator(':focus')).toHaveCount(1);
    await page.keyboard.press('Escape');
    await expect(panel(page)).toHaveCount(0);
    await expect(page.locator('.cm-content')).toBeFocused();

    // もう一度ショートカットで開き、ショートカットで閉じる
    await page.keyboard.press('ControlOrMeta+,');
    await expect(panel(page)).toBeVisible();
    await page.keyboard.press('ControlOrMeta+,');
    await expect(panel(page)).toHaveCount(0);
    await expect(page.locator('.cm-content')).toBeFocused();

    // ボタンで開く → 閉じるボタン → ボタンへ戻る
    const button = page.getByTestId('appearance-button');
    await button.focus();
    await button.press('Enter');
    await expect(panel(page)).toBeVisible();
    await expect(button).toHaveAttribute('aria-expanded', 'true');
    await panel(page).getByRole('button', { name: '外観パネルを閉じる' }).click();
    await expect(panel(page)).toHaveCount(0);
    await expect(button).toBeFocused();
  });

  test('本文・ボタン・バーに名前がある（アクセシビリティ）', async ({ page }) => {
    await launch(page);
    await expect(page.getByRole('textbox', { name: '本文' })).toBeVisible();
    await expect(page.getByRole('button', { name: '外観' })).toBeVisible();
    await expect(page.getByRole('banner', { name: '上部バー' })).toBeVisible();
    await expect(page.getByRole('contentinfo', { name: '下部バー' })).toBeVisible();
    // 背景層と本文面は装飾（支援技術には見せない）
    await expect(page.getByTestId('canvas-surface')).toHaveAttribute('aria-hidden', 'true');
    await expect(page.getByTestId('canvas-bg')).toHaveAttribute('aria-hidden', 'true');
  });
});

test.describe('下部バー: 文字数 (R3-8)', () => {
  test('空白・改行を除いた文字数で、サロゲートペアは 1 文字。環境音の置き場所がある', async ({ page }) => {
    await launch(page);
    const count = page.getByTestId('char-count');
    await expect(count).toHaveText('0 文字');
    await expect(page.locator('[data-slot="ambient"]')).toHaveCount(1);

    await page.locator('.cm-content').click();
    await page.keyboard.type('日本語 abc');
    await page.keyboard.press('Enter');
    await page.keyboard.insertText('😀');
    await expect(count).toHaveText('7 文字');
  });

  test('文書を開くと、その文書の文字数になる', async ({ page }) => {
    await launchWithDoc(page, '前の文。\n\n後の文。\n');
    await expect(page.getByTestId('char-count')).toHaveText('8 文字');
  });
});

test.describe('フォーカスモード (2)', () => {
  const TEXT = '最初の段落\n続きの行\n\n二番目の段落\n\n三番目';

  test('(2) カーソル段落の行には dim がなく、他の段落の行にある。カーソル移動で入れ替わる', async ({ page }) => {
    await launchWithDoc(page, TEXT, { focusMode: true });
    await page.locator('.cm-content').click();
    await page.keyboard.press('ControlOrMeta+Home');
    // 行: 0 最初の段落 / 1 続きの行 / 2 空行 / 3 二番目の段落 / 4 空行 / 5 三番目
    await expect.poll(() => dimFlags(page)).toEqual([false, false, true, true, true, true]);

    await page.keyboard.press('ArrowDown');
    await expect.poll(() => dimFlags(page)).toEqual([false, false, true, true, true, true]);
    await page.keyboard.press('ArrowDown'); // 空行
    await page.keyboard.press('ArrowDown'); // 二番目の段落
    await expect.poll(() => dimFlags(page)).toEqual([true, true, true, false, true, true]);
    await page.keyboard.press('ControlOrMeta+End');
    await expect.poll(() => dimFlags(page)).toEqual([true, true, true, true, true, false]);
  });

  test('Mod+Shift+F で切り替わり、保存され、本文は変わらない', async ({ page }) => {
    await launchWithDoc(page, TEXT);
    await page.locator('.cm-content').click();
    await page.keyboard.press('ControlOrMeta+Home');
    expect(await dimFlags(page)).toEqual([false, false, false, false, false, false]);

    await page.keyboard.press('ControlOrMeta+Shift+F');
    await expect.poll(() => dimFlags(page)).toEqual([false, false, true, true, true, true]);
    await expect.poll(() => savedPreferences(page)).toMatchObject({ focusMode: true });

    await page.keyboard.press('ControlOrMeta+Shift+F');
    await expect.poll(() => dimFlags(page)).toEqual([false, false, false, false, false, false]);
    expect(await page.evaluate(() => window.__mdeE2E!.editor!.getText())).toBe(TEXT);
  });

  test('入力した行・段落でも追従する（dim は行の属性だけで、本文は変わらない）', async ({ page }) => {
    await launchWithDoc(page, TEXT, { focusMode: true });
    await page.locator('.cm-content').click();
    await page.keyboard.press('ControlOrMeta+End');
    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter');
    await page.keyboard.type('新しい段落');
    await expect.poll(() => dimFlags(page)).toEqual([true, true, true, true, true, true, true, false]);
    expect(await page.evaluate(() => window.__mdeE2E!.editor!.getText())).toBe(`${TEXT}\n\n新しい段落`);
  });
});

test.describe('タイプライターモード (3)', () => {
  const LINES = Array.from({ length: 160 }, (_, i) => `第${i + 1}行の本文です`);
  const TEXT = LINES.join('\n');

  const caretOffsetFromCenter = (page: Page) =>
    page.evaluate(() => {
      const scroller = document.querySelector('.cm-scroller')!.getBoundingClientRect();
      const cursor = document.querySelector('.cm-cursor')!.getBoundingClientRect();
      const line = parseFloat(getComputedStyle(document.querySelector('.cm-line')!).lineHeight);
      return { diff: (cursor.top + cursor.bottom) / 2 - (scroller.top + scroller.bottom) / 2, line };
    });

  async function expectCentered(page: Page): Promise<void> {
    await expect
      .poll(async () => {
        const { diff, line } = await caretOffsetFromCenter(page);
        return Math.abs(diff) <= line;
      })
      .toBe(true);
  }

  test('(3) 長文の末尾付近・先頭付近でも、カーソル行の中心が表示領域の中央 ±1 行以内', async ({ page }) => {
    await launchWithDoc(page, TEXT, { typewriterMode: true });
    await page.locator('.cm-content').click();

    await page.keyboard.press('ControlOrMeta+End');
    await expectCentered(page);
    for (let i = 0; i < 3; i++) {
      await page.keyboard.press('ArrowUp');
      await expectCentered(page);
    }
    await page.keyboard.press('ControlOrMeta+Home');
    await expectCentered(page);
    // 途中で 1 行ずつ動かしても中央に保たれ、スクロール位置は行高ずつ動く
    for (let i = 0; i < 40; i++) await page.keyboard.press('ArrowDown');
    await expectCentered(page);
    expect(await page.evaluate(() => window.__mdeE2E!.editor!.getText())).toBe(TEXT);
  });

  test('モードを切ると本文の上下に表示領域の半分の余白が付き、切ると元に戻る', async ({ page }) => {
    await launchWithDoc(page, TEXT);
    await page.locator('.cm-content').click();
    const padding = () =>
      page.evaluate(() => {
        const cs = getComputedStyle(document.querySelector('.cm-content')!);
        return { top: parseFloat(cs.paddingTop), bottom: parseFloat(cs.paddingBottom), viewport: document.querySelector('.cm-scroller')!.clientHeight };
      });
    const before = await padding();
    expect(before.top).toBe(104);

    await page.keyboard.press('ControlOrMeta+Shift+T');
    await expect.poll(async () => Math.abs((await padding()).top - before.viewport / 2) <= 1).toBe(true);
    const on = await padding();
    expect(Math.abs(on.bottom - on.viewport / 2)).toBeLessThanOrEqual(1);
    await expect.poll(() => savedPreferences(page)).toMatchObject({ typewriterMode: true });

    await page.keyboard.press('ControlOrMeta+Shift+T');
    await expect.poll(async () => (await padding()).top).toBe(104);
  });

  test('ポインタでのクリックでは動かさない', async ({ page }) => {
    await launchWithDoc(page, TEXT, { typewriterMode: true });
    await page.locator('.cm-content').click();
    await page.keyboard.press('ControlOrMeta+End');
    const scrollTop = () => page.evaluate(() => document.querySelector('.cm-scroller')!.scrollTop);
    // 末尾の行が中央に来るまでスクロールしている
    await expect.poll(scrollTop).toBeGreaterThan(1000);
    await expectCentered(page);
    const before = await scrollTop();

    // 表示領域の上のほうの行を、座標でクリックする（要素のクリックは、Playwright 自身がスクロールするため使わない）
    const y = await page.evaluate(() => document.querySelector('.cm-scroller')!.getBoundingClientRect().top + 90);
    await page.mouse.click(640, y);
    await page.waitForTimeout(200);
    expect(await scrollTop()).toBe(before);
    const { diff, line } = await caretOffsetFromCenter(page);
    expect(Math.abs(diff)).toBeGreaterThan(line);
  });
});

test.describe('自動非表示 (4)', () => {
  test('(4) 入力でバーが隠れ、マウス移動で再表示される。F6 でバーへ移ると表示される', async ({ page }) => {
    await launch(page, { preferences: { theme: 'light', autoHideChrome: true } });
    await page.locator('.cm-content').click();
    expect(await opacity(page, 'doc-title')).toBe('1');

    await page.keyboard.type('書き始める');
    await expect(page.locator('.app')).toHaveAttribute('data-chrome', 'hidden');
    await expect.poll(() => page.locator('.topbar').evaluate((el) => getComputedStyle(el).opacity)).toBe('0');
    await expect.poll(() => page.locator('.bottombar').evaluate((el) => getComputedStyle(el).opacity)).toBe('0');

    // 何もしなければ（ポインタが動かなければ）隠れたまま
    await page.waitForTimeout(700);
    await expect(page.locator('.app')).toHaveAttribute('data-chrome', 'hidden');

    await page.mouse.move(200, 200);
    await page.mouse.move(260, 240);
    await expect(page.locator('.app')).toHaveAttribute('data-chrome', 'visible');
    await expect.poll(() => page.locator('.topbar').evaluate((el) => getComputedStyle(el).opacity)).toBe('1');
    await expect.poll(() => page.locator('.bottombar').evaluate((el) => getComputedStyle(el).opacity)).toBe('1');

    // 入力でまた隠れ、F6 で上部バーへフォーカスが移ると表示される
    await page.locator('.cm-content').click();
    await page.keyboard.type('続き');
    await expect(page.locator('.app')).toHaveAttribute('data-chrome', 'hidden');
    await page.keyboard.press('F6');
    await expect(page.getByTestId('appearance-button')).toBeFocused();
    await expect(page.locator('.app')).toHaveAttribute('data-chrome', 'visible');
    await expect.poll(() => page.locator('.topbar').evaluate((el) => getComputedStyle(el).opacity)).toBe('1');
  });

  test('隠れていても F6 で 本文 → 上部バー → 下部バー → 本文 の順に届く（Shift+F6 は逆順）', async ({ page }) => {
    await launch(page, { preferences: { theme: 'light', autoHideChrome: true } });
    await page.locator('.cm-content').click();
    await page.keyboard.type('x');
    await expect(page.locator('.app')).toHaveAttribute('data-chrome', 'hidden');

    await page.keyboard.press('F6');
    await expect(page.getByTestId('appearance-button')).toBeFocused();
    await page.keyboard.press('F6');
    await expect(page.getByTestId('char-count')).toBeFocused();
    await expect(page.locator('.app')).toHaveAttribute('data-chrome', 'visible');
    await page.keyboard.press('F6');
    await expect(page.locator('.cm-content')).toBeFocused();
    await page.keyboard.press('Shift+F6');
    await expect(page.getByTestId('char-count')).toBeFocused();
    await page.keyboard.press('Shift+F6');
    await expect(page.getByTestId('appearance-button')).toBeFocused();
  });

  test('隠れている間に Tab でバーへ入ると表示され、そこで Enter で外観パネルを開ける', async ({ page }) => {
    await launch(page, { preferences: { theme: 'light', autoHideChrome: true } });
    await page.locator('.cm-content').click();
    await page.keyboard.type('x');
    await expect(page.locator('.app')).toHaveAttribute('data-chrome', 'hidden');

    await page.keyboard.press('F6');
    await page.keyboard.press('Enter');
    await expect(panel(page)).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('appearance-button')).toBeFocused();
  });

  test('隠れている間、バーの部品はポインタの操作を受けない', async ({ page }) => {
    await launch(page, { preferences: { theme: 'light', autoHideChrome: true } });
    await page.locator('.cm-content').click();
    await page.keyboard.type('x');
    await expect(page.locator('.app')).toHaveAttribute('data-chrome', 'hidden');
    await expect(page.getByTestId('appearance-button')).toHaveCSS('pointer-events', 'none');
  });

  test('外観パネルを開いている間は隠れない', async ({ page }) => {
    await launch(page, { preferences: { theme: 'light', autoHideChrome: true } });
    await openPanel(page);
    await page.locator('.cm-content').click();
    await page.keyboard.type('x');
    await page.waitForTimeout(200);
    await expect(page.locator('.app')).toHaveAttribute('data-chrome', 'visible');
  });

  test('設定が OFF なら、入力しても隠れない', async ({ page }) => {
    await launch(page, { preferences: { theme: 'light', autoHideChrome: false } });
    await page.locator('.cm-content').click();
    await page.keyboard.type('書く');
    await page.waitForTimeout(600);
    await expect(page.locator('.app')).toHaveAttribute('data-chrome', 'visible');
    expect(await opacity(page, 'doc-title')).toBe('1');
  });

  test('パネルのスイッチで切り替えられる', async ({ page }) => {
    await launch(page, { preferences: { theme: 'light' } });
    await openPanel(page);
    await panel(page).getByLabel('入力中は上下のバーを隠す').check();
    await page.keyboard.press('Escape'); // パネルを開いている間は隠れない
    await page.locator('.cm-content').click();
    await page.keyboard.type('x');
    await expect(page.locator('.app')).toHaveAttribute('data-chrome', 'hidden');
  });
});

test.describe('背景 (5)', () => {
  const IMG = '/img/bg.png';
  const IMG2 = '/img/bg2.png';

  test('(5) 画像を選ぶと背景層に blob URL の画像が表示され、差し替えで旧 URL が revoke され、背景を表示しないで消える', async ({ page }) => {
    await launch(page, {
      preferences: { theme: 'light' },
      files: { [IMG]: solidPng(8, 8, [20, 60, 120]), [IMG2]: solidPng(8, 8, [120, 60, 20]) },
      imagePath: IMG,
    });
    await openPanel(page);
    await panel(page).getByRole('radio', { name: '画像', exact: true }).check();
    await expect(page.getByTestId('image-status')).toHaveText('画像は未選択です');

    await page.getByTestId('image-pick').click();
    const img = page.getByTestId('canvas-bg-image');
    await expect(img).toBeVisible();
    const src1 = await img.getAttribute('src');
    expect(src1).toMatch(/^blob:/);
    expect(await img.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth)).toBe(8);
    await expect(img).toHaveCSS('filter', 'brightness(0.8)');
    await expect(page.getByTestId('image-status')).toHaveText('取り込み済み');
    expect(await page.evaluate(() => window.__mdeE2E!.calls.imageImport)).toBe(1);

    // 保存される imageId は内容ハッシュ（64 桁の 16 進）
    await expect.poll(() => savedPreferences(page)).toMatchObject({ background: { kind: 'image' } });
    const saved = (await savedPreferences(page)) as { background: { imageId: string } };
    expect(saved.background.imageId).toMatch(/^[0-9a-f]{64}$/);

    // 明るさとオーバーレイの調整が背景層に効く
    await panel(page).getByLabel('画像の明るさ').fill('0.5');
    await expect(img).toHaveCSS('filter', 'brightness(0.5)');
    await panel(page).getByLabel('オーバーレイ濃度').fill('0.7');
    await expect(page.locator('.canvas-bg-overlay')).toHaveCSS('opacity', '0.7');

    // 別の画像へ差し替える → 旧 blob URL は revoke される
    await page.evaluate((p) => (window.__mdeE2E!.imagePath = p), IMG2);
    await page.getByTestId('image-pick').click();
    await expect.poll(() => img.getAttribute('src')).not.toBe(src1);
    expect(await page.evaluate((u) => fetch(u!).then(() => true, () => false), src1)).toBe(false);
    expect(await page.evaluate(() => window.__mdeE2E!.images.size)).toBe(2);

    // 背景を表示しない → 背景層が消え、本文面は不透明
    await panel(page).getByLabel('背景を表示しない').check();
    await expect(page.getByTestId('canvas-bg')).toHaveCount(0);
    await expect(page.getByTestId('canvas-bg-image')).toHaveCount(0);
    await expect(page.getByTestId('canvas-surface')).toHaveCSS('opacity', '1');
    await panel(page).getByLabel('背景を表示しない').uncheck();
    await expect(page.getByTestId('canvas-bg-image')).toBeVisible();
  });

  test('再読み込み後に画像が読めなくても、設定は保たれ、本文は使える', async ({ page }) => {
    await launch(page, {
      preferences: { theme: 'light' },
      files: { [IMG]: solidPng(4, 4, [10, 10, 10]) },
      imagePath: IMG,
    });
    await openPanel(page);
    await panel(page).getByRole('radio', { name: '画像', exact: true }).check();
    await page.getByTestId('image-pick').click();
    await expect(page.getByTestId('canvas-bg-image')).toBeVisible();
    await expect.poll(() => savedPreferences(page)).toMatchObject({ background: { kind: 'image' } });
    const { background } = (await savedPreferences(page)) as { background: { imageId: string } };

    // メモリ bridge は画像を再読み込みで保持しない（設定だけ保持する）。
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-ready', 'true');
    await expect(page.getByTestId('canvas-bg')).toHaveAttribute('data-kind', 'image');
    expect(background.imageId).toMatch(/^[0-9a-f]{64}$/);
    // 画像本体は無いので読み込めず、背景層の画像は出ない（本文は読める）。
    await expect(page.getByTestId('canvas-bg-image')).toHaveCount(0);
    await expect(page.locator('.cm-content')).toBeVisible();
  });

  test('画像でないファイルは取り込まず、設定も変えない', async ({ page }) => {
    await launch(page, {
      preferences: { theme: 'light' },
      files: { '/img/fake.png': utf8('これは画像ではありません') },
      imagePath: '/img/fake.png',
    });
    await openPanel(page);
    await panel(page).getByRole('radio', { name: '画像', exact: true }).check();
    await page.getByTestId('image-pick').click();
    await expect(toast(page)).toContainText('画像を取り込めませんでした');
    await expect(page.getByTestId('canvas-bg-image')).toHaveCount(0);
    await expect(page.getByTestId('image-status')).toHaveText('画像は未選択です');
  });

  test('ダイアログをキャンセルしても何も起きない', async ({ page }) => {
    await launch(page, { preferences: { theme: 'light' }, imagePath: null });
    await openPanel(page);
    await panel(page).getByRole('radio', { name: '画像', exact: true }).check();
    await page.getByTestId('image-pick').click();
    expect(await page.evaluate(() => window.__mdeE2E!.calls.imageImport)).toBe(0);
    await expect(page.getByTestId('image-status')).toHaveText('画像は未選択です');
  });

  test('単色・グラデーションが背景層に出て、本文面の不透明度が反映される', async ({ page }) => {
    await launch(page, { preferences: { theme: 'light' } });
    await openPanel(page);
    await expect(page.getByTestId('canvas-bg')).toHaveAttribute('data-kind', 'gradient');

    await panel(page).getByRole('radio', { name: '単色' }).check();
    await panel(page).getByLabel('単色の色').fill('#336699');
    await expect(page.getByTestId('canvas-bg')).toHaveAttribute('data-kind', 'color');
    await expect(page.getByTestId('canvas-bg')).toHaveCSS('background-color', 'rgb(51, 102, 153)');

    await panel(page).getByRole('radio', { name: 'グラデーション', exact: true }).check();
    await panel(page).getByRole('radio', { name: '夕暮れ' }).check();
    await expect(page.getByTestId('canvas-bg')).toHaveCSS('background-image', /linear-gradient/);

    await panel(page).getByLabel('本文面の不透明度').fill('0.4');
    await expect(page.getByTestId('canvas-surface')).toHaveCSS('opacity', '0.4');
    await expect.poll(() => savedPreferences(page)).toMatchObject({
      surfaceOpacity: 0.4,
      background: { kind: 'gradient', gradientId: 'dusk', color: '#336699' },
    });
  });
});

test.describe('コントラスト (6)', () => {
  const ratioOf = async (page: Page): Promise<number> => {
    const text = (await page.getByTestId('contrast-ratio').textContent()) ?? '';
    return Number(/^([\d.]+) : 1/.exec(text)?.[1]);
  };

  test('既定の配色は、ライト・ダークとも 7 以上で、警告が出ない', async ({ page }) => {
    await launch(page, { preferences: { theme: 'light' } });
    await openPanel(page);
    expect(await ratioOf(page)).toBeGreaterThanOrEqual(7);
    await expect(page.getByTestId('contrast-warning')).toHaveCount(0);

    await panel(page).getByRole('radio', { name: 'ダーク' }).check();
    await expect.poll(() => ratioOf(page)).toBeGreaterThanOrEqual(7);
    await expect(page.getByTestId('contrast-warning')).toHaveCount(0);
  });

  test('(6) 本文面の不透明度を下げて暗い背景にすると、警告が表示され、戻すと消える', async ({ page }) => {
    await launch(page, { preferences: { theme: 'light' } });
    await openPanel(page);
    await panel(page).getByRole('radio', { name: '単色' }).check();
    await panel(page).getByLabel('単色の色').fill('#000000');
    await panel(page).getByLabel('本文面の不透明度').fill('0');

    await expect(page.getByTestId('contrast-warning')).toBeVisible();
    await expect(page.getByTestId('contrast-warning')).toHaveAttribute('role', 'alert');
    expect(await ratioOf(page)).toBeLessThan(4.5);
    await expect(page.getByTestId('contrast-ratio')).toContainText('基準 4.5 未満');

    await panel(page).getByLabel('本文面の不透明度').fill('1');
    await expect(page.getByTestId('contrast-warning')).toHaveCount(0);
    expect(await ratioOf(page)).toBeGreaterThanOrEqual(7);
  });

  test('「背景を表示しない」で、警告が消えて既定配色になる（アクセシビリティ）', async ({ page }) => {
    await launch(page, {
      preferences: { theme: 'light', background: { kind: 'color', color: '#000000' }, surfaceOpacity: 0 },
    });
    await openPanel(page);
    await expect(page.getByTestId('contrast-warning')).toBeVisible();
    await panel(page).getByLabel('背景を表示しない').check();
    await expect(page.getByTestId('contrast-warning')).toHaveCount(0);
    expect(await ratioOf(page)).toBeGreaterThanOrEqual(7);
    await expect(page.getByTestId('canvas-bg')).toHaveCount(0);
  });

  test('画像の平均色（明るさ・オーバーレイ反映）で評価される', async ({ page }) => {
    // 真っ黒な画像、オーバーレイなし、本文面なし → ライトテーマの暗い文字は読めない
    await launch(page, {
      preferences: { theme: 'light', surfaceOpacity: 0, overlayOpacity: 0, imageBrightness: 1 },
      files: { '/img/black.png': solidPng(8, 8, [0, 0, 0]) },
      imagePath: '/img/black.png',
    });
    await openPanel(page);
    await panel(page).getByRole('radio', { name: '画像', exact: true }).check();
    await page.getByTestId('image-pick').click();
    await expect(page.getByTestId('contrast-warning')).toBeVisible();

    // オーバーレイ（ライトテーマでは明るい色）を最大にすると、読める色に近づく
    await panel(page).getByLabel('オーバーレイ濃度').fill('0.9');
    await expect(page.getByTestId('contrast-warning')).toHaveCount(0);
  });
});

test.describe('Reduced Motion (7)', () => {
  test('(7) reduce では、バーとフォーカスモードの transition が無効', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await launchWithDoc(page, '一つ目\n\n二つ目', { focusMode: true, autoHideChrome: true });
    await expect(page.locator('.topbar')).toHaveCSS('transition-duration', '0s');
    await expect(page.locator('.bottombar')).toHaveCSS('transition-duration', '0s');
    await expect(page.locator('.cm-md-dim').first()).toHaveCSS('transition-duration', '0s');
  });

  test('(7) 比較: reduce でなければ transition がある', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await launchWithDoc(page, '一つ目\n\n二つ目', { focusMode: true, autoHideChrome: true });
    await expect(page.locator('.topbar')).not.toHaveCSS('transition-duration', '0s');
    await expect(page.locator('.cm-md-dim').first()).not.toHaveCSS('transition-duration', '0s');
  });

  test('reduce でも、自動非表示は即座に切り替わる', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await launch(page, { preferences: { theme: 'light', autoHideChrome: true } });
    await page.locator('.cm-content').click();
    await page.keyboard.type('x');
    expect(await page.locator('.topbar').evaluate((el) => getComputedStyle(el).opacity)).toBe('0');
  });
});

test.describe('日本語 IME とフォーカスモード (8)', () => {
  const BASE = '前の文。\n\n後の文。';

  const compose = (client: CDPSession, text: string) =>
    client.send('Input.imeSetComposition', { text, selectionStart: text.length, selectionEnd: text.length });
  const lines = (page: Page) => page.locator('.cm-line').evaluateAll((els) => els.map((l) => l.textContent ?? ''));

  test('(8) フォーカスモード ON で、変換中→確定しても本文が壊れず、dim も崩れない', async ({ page }) => {
    await launchWithDoc(page, BASE, { focusMode: true });
    await page.locator('.cm-content').click();
    await page.keyboard.press('ControlOrMeta+Home');
    await page.keyboard.press('End');
    await expect.poll(() => dimFlags(page)).toEqual([false, true, true]);

    // 変換中の class 属性の変化を記録する（変換中は再計算しない）
    await page.evaluate(() => {
      const w = window as unknown as { __classMutations: number };
      w.__classMutations = 0;
      new MutationObserver((records) => {
        w.__classMutations += records.length;
      }).observe(document.querySelector('.cm-content')!, { attributes: true, attributeFilter: ['class'], subtree: true });
    });

    const client = await page.context().newCDPSession(page);
    for (const reading of ['に', 'にほ', 'にほん', 'にほんご']) {
      await compose(client, reading);
      expect(await lines(page)).toEqual([`前の文。${reading}`, '', '後の文。']);
      expect(await dimFlags(page)).toEqual([false, true, true]);
    }
    await compose(client, '日本語');
    expect(await lines(page)).toEqual(['前の文。日本語', '', '後の文。']);
    expect(await page.evaluate(() => (window as unknown as { __classMutations: number }).__classMutations)).toBe(0);

    // 確定
    await client.send('Input.insertText', { text: '日本語' });
    expect(await lines(page)).toEqual(['前の文。日本語', '', '後の文。']);
    await expect.poll(() => dimFlags(page)).toEqual([false, true, true]);
    expect(await page.evaluate(() => window.__mdeE2E!.editor!.getText())).toBe('前の文。日本語\n\n後の文。');

    // 確定後に改行して次の段落へ書くと、フォーカスが移る
    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter');
    await page.keyboard.type('次');
    // 改行 2 回で 3 行目（新しい空行）へ。そこに書いた段落だけが dim でない。
    await expect.poll(() => dimFlags(page)).toEqual([true, true, false, true, true]);
  });

  test('フォーカスモード ON でも、変換の取り消しで仮の文字だけが消える', async ({ page }) => {
    await launchWithDoc(page, BASE, { focusMode: true });
    await page.locator('.cm-content').click();
    await page.keyboard.press('ControlOrMeta+Home');
    await page.keyboard.press('End');
    const client = await page.context().newCDPSession(page);
    await compose(client, 'にほ');
    expect(await lines(page)).toEqual(['前の文。にほ', '', '後の文。']);
    await compose(client, '');
    expect(await lines(page)).toEqual(['前の文。', '', '後の文。']);
    await expect.poll(() => dimFlags(page)).toEqual([false, true, true]);
  });

  test('タイプライターモード ON でも、変換中→確定で本文が壊れない', async ({ page }) => {
    const text = Array.from({ length: 80 }, (_, i) => `行${i + 1}`).join('\n');
    await launchWithDoc(page, text, { typewriterMode: true });
    await page.locator('.cm-content').click();
    await page.keyboard.press('ControlOrMeta+End');
    const client = await page.context().newCDPSession(page);
    await compose(client, 'にほんご');
    await compose(client, '日本語');
    await client.send('Input.insertText', { text: '日本語' });
    expect(await page.evaluate(() => window.__mdeE2E!.editor!.getText())).toBe(`${text}日本語`);
    await expect
      .poll(() =>
        page.evaluate(() => {
          const scroller = document.querySelector('.cm-scroller')!.getBoundingClientRect();
          const cursor = document.querySelector('.cm-cursor')!.getBoundingClientRect();
          const line = parseFloat(getComputedStyle(document.querySelector('.cm-line')!).lineHeight);
          return Math.abs((cursor.top + cursor.bottom) / 2 - (scroller.top + scroller.bottom) / 2) <= line;
        }),
      )
      .toBe(true);
  });
});

test.describe('全画面 (9) とショートカット', () => {
  test('(9) OS 標準の全画面ショートカットが、bridge の全画面切替を呼ぶ', async ({ page, platform }) => {
    await launch(page);
    await page.locator('.cm-content').click();
    const fullscreenKey = platform === 'mac' ? 'Control+Meta+f' : 'F11';
    const state = () => page.evaluate(() => ({ on: window.__mdeE2E!.fullscreen, calls: window.__mdeE2E!.calls.fullscreen }));

    await page.keyboard.press(fullscreenKey);
    await expect.poll(state).toEqual({ on: true, calls: 1 });
    await page.keyboard.press(fullscreenKey);
    await expect.poll(state).toEqual({ on: false, calls: 2 });
  });

  test('他の OS の全画面キーでは切り替わらない', async ({ page, platform }) => {
    await launch(page);
    await page.locator('.cm-content').click();
    const other = platform === 'mac' ? 'F11' : 'Control+Meta+f';
    await page.keyboard.press(other);
    await page.waitForTimeout(150);
    expect(await page.evaluate(() => window.__mdeE2E!.calls.fullscreen)).toBe(0);
  });

  test('既存のショートカット（検索・保存・Undo）と衝突しない', async ({ page }) => {
    await launchWithDoc(page, 'abc');
    await page.locator('.cm-content').click();
    await page.keyboard.press('ControlOrMeta+f');
    await expect(page.locator('.cm-search')).toBeVisible();
    await expect(panel(page)).toHaveCount(0);
    await page.keyboard.press('Escape');

    await page.locator('.cm-content').click();
    await page.keyboard.press('ControlOrMeta+End');
    await page.keyboard.type('X');
    await page.keyboard.press('ControlOrMeta+z');
    expect(await page.evaluate(() => window.__mdeE2E!.editor!.getText())).toBe('abc');
    // Mod+Shift+F / T はモードの切替で、検索パネルは開かない
    await page.keyboard.press('ControlOrMeta+Shift+F');
    await expect(page.locator('.cm-search')).toHaveCount(0);
  });
});
