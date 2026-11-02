import { expect, type Page } from '@playwright/test';
import { columnBox, launch, test, utf8 } from './helpers';

// Run 8: 設定画面（モーダル）、紙の幅（surfaceWidth）、左サイドバーの枠。
// 位置は要素の矩形で確かめる（見た目の印象ではなく、重ならないこと・中央にあること）。
test.describe.configure({ mode: 'parallel' });

const DOC = '/docs/note.md';
const SIDEBAR = 260;

const dialog = (page: Page) => page.getByRole('dialog', { name: '設定' });
const sidebar = (page: Page) => page.getByTestId('sidebar');
const savedPreferences = (page: Page) => page.evaluate(() => window.__mdeE2E!.savedPreferences.at(-1) as Record<string, unknown> | undefined);

interface Rect {
  left: number;
  right: number;
  top: number;
  bottom: number;
  width: number;
  height: number;
}

async function rect(page: Page, selector: string): Promise<Rect> {
  return page.locator(selector).first().evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height };
  });
}

const overlap = (a: Rect, b: Rect) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;

async function open(page: Page, preferences: Record<string, unknown> = {}) {
  await launch(page, {
    files: { [DOC]: utf8('本文\n\n二つ目') },
    openPath: DOC,
    preferences: { theme: 'light', autoHideChrome: false, ...preferences },
  });
}

/** 本文の領域（サイドバーを除いた領域）の中で、列が中央にあること。 */
async function expectColumnCentered(page: Page, label: string) {
  await expect
    .poll(async () => {
      const workspace = await rect(page, '.workspace');
      const column = await columnBox(page);
      const workspaceCenter = workspace.left + workspace.width / 2;
      return Math.abs(column.x + column.width / 2 - workspaceCenter) <= 1;
    }, label)
    .toBe(true);
}

test.describe('設定画面（モーダル）(a)', () => {
  test('設定ボタンと Mod+, で開き、Esc で閉じ、フォーカスは本文へ戻る', async ({ page, platform }) => {
    await open(page);
    const button = page.getByTestId('settings-button');
    await expect(button).toHaveAttribute('title', platform === 'mac' ? '設定（⌘,）' : '設定（Ctrl+,）');
    await expect(button).toHaveAttribute('aria-label', '設定');
    await expect(dialog(page)).toHaveCount(0);
    await expect(page.getByTestId('appearance-button')).toHaveCount(0);

    // ボタンで開く。モーダルで、最初の設定項目にフォーカスが入る。
    await button.click();
    await expect(dialog(page)).toBeVisible();
    await expect(dialog(page)).toHaveAttribute('aria-modal', 'true');
    await expect(dialog(page).getByRole('heading', { name: '設定', level: 2 })).toBeVisible();
    await expect(dialog(page).getByRole('heading', { name: '外観', level: 3 })).toBeVisible();
    await expect(dialog(page).getByLabel('フォントの種類')).toBeFocused();
    await expect(button).toHaveAttribute('aria-expanded', 'true');

    // Esc で閉じ、ボタンから開いたのでフォーカスはボタンへ戻る。
    await page.keyboard.press('Escape');
    await expect(dialog(page)).toHaveCount(0);
    await expect(button).toBeFocused();

    // 本文から Mod+, で開き、Esc で閉じると、フォーカスは本文へ戻る。
    await page.locator('.cm-content').click();
    await page.keyboard.press('ControlOrMeta+,');
    await expect(dialog(page)).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog(page)).toHaveCount(0);
    await expect(page.locator('.cm-content')).toBeFocused();

    // 閉じるボタンでも閉じる。もう一度 Mod+, で閉じることもできる。
    await page.keyboard.press('ControlOrMeta+,');
    await dialog(page).getByTestId('settings-close').click();
    await expect(dialog(page)).toHaveCount(0);
    await expect(page.locator('.cm-content')).toBeFocused();
    await page.keyboard.press('ControlOrMeta+,');
    await expect(dialog(page)).toBeVisible();
    await page.keyboard.press('ControlOrMeta+,');
    await expect(dialog(page)).toHaveCount(0);
  });

  test('窓の中央に出て、背景の幕は薄く、設定の変更は後ろの本文へ即座に反映される', async ({ page }) => {
    await open(page);
    await page.keyboard.press('ControlOrMeta+,');
    await expect(dialog(page)).toBeVisible();

    const box = await rect(page, '[data-testid=settings-dialog]');
    expect(Math.abs(box.left + box.width / 2 - 640)).toBeLessThanOrEqual(1);
    expect(Math.abs(box.top + box.height / 2 - 400)).toBeLessThanOrEqual(1);

    // 幕は薄い（後ろの本文の変化が見える）。
    const alpha = await page.getByTestId('settings-backdrop').evaluate((el) => {
      const m = /rgba?\(([^)]+)\)/.exec(getComputedStyle(el).backgroundColor)!;
      const parts = m[1]!.split(',').map(Number);
      return parts.length === 4 ? parts[3]! : 1;
    });
    expect(alpha).toBeGreaterThan(0);
    expect(alpha).toBeLessThanOrEqual(0.35);

    await dialog(page).getByLabel('文字サイズ').fill('26');
    await expect(page.locator('.cm-content')).toHaveCSS('font-size', '26px');
    await dialog(page).getByRole('radio', { name: 'ダーク' }).check();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    // 後ろの本文は見えたまま（隠れていない）。
    await expect(page.locator('.cm-content')).toBeVisible();
  });

  test('Tab はダイアログの中で循環する（外へ出ない）', async ({ page }) => {
    await open(page);
    await page.keyboard.press('ControlOrMeta+,');
    await expect(dialog(page)).toBeVisible();
    const insideDialog = () => page.evaluate(() => !!document.activeElement?.closest('[data-testid=settings-dialog]'));

    // 何回か Tab を押して一周する間、フォーカスは常にダイアログの中にあり、最初の項目へ戻ってくる。
    const key = () => page.evaluate(() => document.activeElement!.outerHTML);
    const start = await key();
    let cycle = 0;
    for (let i = 1; i <= 80; i++) {
      await page.keyboard.press('Tab');
      expect(await insideDialog(), `Tab ${i} 回目`).toBe(true);
      if ((await key()) === start) {
        cycle = i;
        break;
      }
    }
    expect(cycle).toBeGreaterThan(10);

    // 最後の項目から Tab で最初へ、最初から Shift+Tab で最後へ。
    const ends = await dialog(page).evaluate((el) => {
      // Tab で止まる要素だけ（同じ名前のラジオは、選択中の 1 つだけ）。
      const items = Array.from(el.querySelectorAll<HTMLInputElement>('button, input, select, textarea')).filter(
        (e) =>
          e.getClientRects().length > 0 &&
          !(e.type === 'radio' && !e.checked && e.name !== '' && el.querySelector(`input[type="radio"][name="${CSS.escape(e.name)}"]:checked`)),
      );
      items[items.length - 1]!.focus();
      return { first: items[0]!.outerHTML, last: items[items.length - 1]!.outerHTML };
    });
    await page.keyboard.press('Tab');
    expect(await page.evaluate(() => document.activeElement!.outerHTML)).toBe(ends.first);
    await page.keyboard.press('Shift+Tab');
    expect(await page.evaluate(() => document.activeElement!.outerHTML)).toBe(ends.last);
  });

  test('高さが窓に収まらないときは、ダイアログ内をスクロールする（見出しと閉じるボタンは残る）', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 420 });
    await open(page);
    await page.keyboard.press('ControlOrMeta+,');
    await expect(dialog(page)).toBeVisible();

    const box = await rect(page, '[data-testid=settings-dialog]');
    expect(box.top).toBeGreaterThanOrEqual(0);
    expect(box.bottom).toBeLessThanOrEqual(420);
    const body = await page.getByTestId('settings-body').evaluate((el) => ({ scroll: el.scrollHeight, client: el.clientHeight, overflowY: getComputedStyle(el).overflowY }));
    expect(body.scroll).toBeGreaterThan(body.client);
    expect(body.overflowY).toBe('auto');

    // 下の項目まで届く（スクロールで見える）。見出しの閉じるボタンは動かない。
    const last = dialog(page).getByLabel('入力中は上下のバーを隠す');
    await last.scrollIntoViewIfNeeded();
    await expect(last).toBeInViewport();
    await expect(dialog(page).getByTestId('settings-close')).toBeInViewport();
  });

  test('幕のクリックで閉じる。スライダーをドラッグして幕の上で離しても閉じない', async ({ page }) => {
    await open(page);
    await page.keyboard.press('ControlOrMeta+,');
    await expect(dialog(page)).toBeVisible();

    const slider = await dialog(page).getByLabel('文字サイズ').boundingBox();
    await page.mouse.move(slider!.x + slider!.width / 2, slider!.y + slider!.height / 2);
    await page.mouse.down();
    await page.mouse.move(8, 8);
    await page.mouse.up();
    await expect(dialog(page)).toBeVisible();

    await page.mouse.click(8, 8);
    await expect(dialog(page)).toHaveCount(0);
  });

  test('設定画面を開いている間は、サイドバーの開閉ショートカットを無視する', async ({ page }) => {
    await open(page);
    await page.keyboard.press('ControlOrMeta+,');
    await expect(dialog(page)).toBeVisible();
    await page.keyboard.press('ControlOrMeta+b');
    await page.keyboard.press('Escape');
    await expect(dialog(page)).toHaveCount(0);
    await expect(sidebar(page)).toBeHidden();
    await expect(page.getByTestId('sidebar-toggle')).toHaveAttribute('aria-expanded', 'false');
  });
});

test.describe('左サイドバー (b)', () => {
  test('既定は閉じている。閉じているとき、見えず、フォーカスも受けず、本文は窓の中央', async ({ page }) => {
    await open(page);
    await expect(sidebar(page)).toBeHidden();
    await expect(sidebar(page)).toHaveAttribute('inert', '');
    const toggle = page.getByTestId('sidebar-toggle');
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    const workspace = await rect(page, '.workspace');
    expect(workspace.left).toBe(0);
    expect(workspace.width).toBe(1280);
    await expectColumnCentered(page, '閉じているとき');
  });

  test('ボタンで開閉できる。開くと本文の領域が右へ押し出され、サイドバー・上部バー・本文・下部バーが重ならない', async ({ page, platform }) => {
    await open(page);
    const toggle = page.getByTestId('sidebar-toggle');
    await expect(toggle).toHaveAttribute('title', platform === 'mac' ? 'サイドバー（⌘B）' : 'サイドバー（Ctrl+B）');
    await expect(toggle).toHaveAttribute('aria-controls', 'app-sidebar');
    const closedColumn = await columnBox(page);

    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(sidebar(page)).toBeVisible();
    await expect(sidebar(page)).toHaveAttribute('id', 'app-sidebar');
    await expect(page.getByRole('complementary', { name: 'サイドバー' })).toBeVisible();
    await expect(sidebar(page).getByRole('heading', { name: 'エクスプローラー' })).toBeVisible();
    await expect(sidebar(page).getByText('フォルダはまだ開かれていません')).toBeVisible();
    // ボタンは「フォルダを開く」だけ（閉じるボタンは重ねて表示するときだけ。Run 9 でフォルダを開く入口が入った）。
    await expect(sidebar(page).getByRole('button')).toHaveCount(1);
    await expect(sidebar(page).getByRole('button', { name: 'フォルダを開く' })).toBeVisible();

    // 動きの終わりを待ってから、矩形を比べる。
    await expect.poll(async () => (await rect(page, '.workspace')).left).toBe(SIDEBAR);
    const side = await rect(page, '[data-testid=sidebar]');
    const workspace = await rect(page, '.workspace');
    expect(side.left).toBe(0);
    expect(side.width).toBe(SIDEBAR);
    expect(side.top).toBe(0);
    expect(side.bottom).toBe(800);
    expect(workspace.right).toBe(1280);
    expect(workspace.width).toBe(1280 - SIDEBAR);

    for (const selector of ['.topbar', '.bottombar', '.editor-host', '[data-testid=canvas-surface]', '.cm-content']) {
      const r = await rect(page, selector);
      expect(overlap(side, r), `${selector} がサイドバーと重なる`).toBe(false);
      expect(r.left, `${selector} はサイドバーの右`).toBeGreaterThanOrEqual(SIDEBAR);
    }
    // 上部バーの左端（開閉ボタン）は、サイドバーのすぐ右にある。
    const toggleBox = await rect(page, '[data-testid=sidebar-toggle]');
    expect(toggleBox.left).toBeGreaterThanOrEqual(SIDEBAR);
    expect(toggleBox.left).toBeLessThan(SIDEBAR + 40);

    // 本文の列は、残りの領域の中央へ移る。
    await expectColumnCentered(page, '開いたとき');
    const openColumn = await columnBox(page);
    expect(Math.round(openColumn.x - closedColumn.x)).toBe(SIDEBAR / 2);
    expect(Math.round(openColumn.width)).toBe(680);

    // 閉じると元の位置へ戻る。
    await toggle.click();
    await expect(sidebar(page)).toBeHidden();
    await expect.poll(async () => Math.round((await columnBox(page)).x)).toBe(Math.round(closedColumn.x));
  });

  test('Mod+B で開閉できる。本文にフォーカスがあっても効き、フォーカスは本文のまま', async ({ page }) => {
    await open(page);
    await page.locator('.cm-content').click();
    await page.keyboard.press('ControlOrMeta+b');
    await expect(sidebar(page)).toBeVisible();
    await expect(page.getByTestId('sidebar-toggle')).toHaveAttribute('aria-expanded', 'true');
    await expect(page.locator('.cm-content')).toBeFocused();
    await page.keyboard.press('ControlOrMeta+b');
    await expect(sidebar(page)).toBeHidden();
    await expect(page.locator('.cm-content')).toBeFocused();
    // 本文の文字は変わらない（B は入力されない）。
    expect(await page.evaluate(() => window.__mdeE2E!.editor!.getText())).toBe('');
  });

  test('IME の変換中は、Mod+B にも Mod+, にも反応しない', async ({ page, platform }) => {
    await open(page);
    await page.locator('.cm-content').click();
    const send = (init: { key: string; code: string; isComposing?: boolean; keyCode?: number }) =>
      page.evaluate(
        ([i, mac]) =>
          window.dispatchEvent(
            new KeyboardEvent('keydown', { ...i, bubbles: true, cancelable: true, metaKey: mac, ctrlKey: !mac }),
          ),
        [init, platform === 'mac'] as const,
      );
    await send({ key: 'b', code: 'KeyB', isComposing: true });
    await send({ key: 'Process', code: 'KeyB', keyCode: 229 });
    await send({ key: ',', code: 'Comma', isComposing: true });
    await page.waitForTimeout(150);
    await expect(sidebar(page)).toBeHidden();
    await expect(dialog(page)).toHaveCount(0);
    // 変換中でなければ効く（同じ経路で届いていることの確認）。
    await send({ key: 'b', code: 'KeyB' });
    await expect(sidebar(page)).toBeVisible();
  });

  test('開閉の状態は保存され、再読み込み後も復元される。紙の幅も同じ', async ({ page }) => {
    await open(page);
    await page.keyboard.press('ControlOrMeta+b');
    await expect(sidebar(page)).toBeVisible();
    await page.keyboard.press('ControlOrMeta+,');
    await dialog(page).getByRole('radio', { name: '本文に合わせる' }).check();
    await expect.poll(() => savedPreferences(page)).toMatchObject({ sidebarOpen: true, surfaceWidth: 'text' });

    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-ready', 'true');
    await expect(sidebar(page)).toBeVisible();
    await expect(page.getByTestId('sidebar-toggle')).toHaveAttribute('aria-expanded', 'true');
    await expect(page.locator('.app')).toHaveAttribute('data-surface', 'text');
    await expect.poll(async () => (await rect(page, '.workspace')).left).toBe(SIDEBAR);

    // 閉じた状態も復元される。
    await page.keyboard.press('ControlOrMeta+b');
    await expect.poll(() => savedPreferences(page)).toMatchObject({ sidebarOpen: false });
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-ready', 'true');
    await expect(sidebar(page)).toBeHidden();
  });

  test('保存済みの設定として sidebarOpen: true で起動すると、最初から開いている', async ({ page }) => {
    await open(page, { sidebarOpen: true });
    await expect(sidebar(page)).toBeVisible();
    await expect.poll(async () => (await rect(page, '.workspace')).left).toBe(SIDEBAR);
  });

  test('不正な保存値は既定に戻る（紙は窓いっぱい、サイドバーは閉じる）', async ({ page }) => {
    await open(page, { surfaceWidth: 'wide', sidebarOpen: 'yes' });
    await expect(page.locator('.app')).toHaveAttribute('data-surface', 'fill');
    await expect(sidebar(page)).toBeHidden();
  });

  test('入力中の自動非表示でも、サイドバーは隠れない', async ({ page }) => {
    await open(page, { autoHideChrome: true, sidebarOpen: true });
    await page.locator('.cm-content').click();
    await page.keyboard.type('x');
    await expect(page.locator('.app')).toHaveAttribute('data-chrome', 'hidden');
    await expect(sidebar(page)).toBeVisible();
    await expect(sidebar(page)).toHaveCSS('opacity', '1');
  });

  test('ダークテーマでも読める（見出しと補足の文字が、サイドバーの背景に対して AA の 4.5 以上）', async ({ page }) => {
    for (const theme of ['light', 'dark']) {
      await open(page, { theme, sidebarOpen: true });
      const ratios = await page.evaluate(() => {
        const parse = (c: string) => (/rgba?\(([^)]+)\)/.exec(c)![1]!.split(',').slice(0, 3).map(Number));
        const lum = ([r, g, b]: number[]) => {
          const f = (v: number) => {
            const s = v / 255;
            return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
          };
          return 0.2126 * f(r!) + 0.7152 * f(g!) + 0.0722 * f(b!);
        };
        const ratio = (fg: string, bg: string) => {
          const a = lum(parse(fg));
          const b = lum(parse(bg));
          return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
        };
        const side = document.querySelector('[data-testid=sidebar]')!;
        const bg = getComputedStyle(side).backgroundColor;
        const color = (sel: string) => getComputedStyle(side.querySelector(sel)!).color;
        return { heading: ratio(color('h2'), bg), empty: ratio(color('[data-testid=sidebar-empty]'), bg) };
      });
      expect(ratios.heading, `${theme} の見出し`).toBeGreaterThanOrEqual(4.5);
      expect(ratios.empty, `${theme} の補足`).toBeGreaterThanOrEqual(4.5);
      await page.reload();
    }
  });
});

test.describe('紙の幅 (d)', () => {
  test('既定は fill: 紙が本文の領域いっぱいで、影はなく、列は 680px で中央', async ({ page }) => {
    await open(page);
    await expect(page.locator('.app')).toHaveAttribute('data-surface', 'fill');
    const surface = await rect(page, '[data-testid=canvas-surface]');
    const workspace = await rect(page, '.workspace');
    expect(surface.left).toBe(workspace.left);
    expect(surface.width).toBe(workspace.width);
    expect(surface.width).toBe(1280);
    await expect(page.getByTestId('canvas-surface')).toHaveCSS('box-shadow', 'none');
    expect(Math.round((await columnBox(page)).width)).toBe(680);
    await expectColumnCentered(page, 'fill');
  });

  test('text: 今までと同じ幅（本文の最大幅 + 左右の余白 56px）で中央、影あり', async ({ page }) => {
    await open(page, { surfaceWidth: 'text' });
    const surface = await rect(page, '[data-testid=canvas-surface]');
    expect(Math.round(surface.width)).toBe(680 + 2 * 56);
    expect(Math.round(surface.left + surface.width / 2)).toBe(640);
    await expect(page.getByTestId('canvas-surface')).not.toHaveCSS('box-shadow', 'none');
    expect(Math.round((await columnBox(page)).width)).toBe(680);
    await expectColumnCentered(page, 'text');
  });

  test('サイドバーを開くと、fill は残りの領域いっぱい、text は残りの領域の中央', async ({ page }) => {
    await open(page, { sidebarOpen: true });
    await expect.poll(async () => (await rect(page, '[data-testid=canvas-surface]')).left).toBe(SIDEBAR);
    const fill = await rect(page, '[data-testid=canvas-surface]');
    expect(fill.width).toBe(1280 - SIDEBAR);
    expect(fill.right).toBe(1280);

    await page.keyboard.press('ControlOrMeta+,');
    await dialog(page).getByRole('radio', { name: '本文に合わせる' }).check();
    const text = await rect(page, '[data-testid=canvas-surface]');
    expect(Math.round(text.width)).toBe(680 + 2 * 56);
    expect(Math.round(text.left + text.width / 2)).toBe(SIDEBAR + (1280 - SIDEBAR) / 2);
    expect(text.left).toBeGreaterThanOrEqual(SIDEBAR);
    // 本文の列は、どちらでも同じ位置。
    await expectColumnCentered(page, 'text + サイドバー');
  });

  test('設定画面の切替で即座に変わり、保存される。1 行の長さは両方とも本文の最大幅で決まる', async ({ page }) => {
    await open(page);
    await page.keyboard.press('ControlOrMeta+,');
    await expect(dialog(page).getByRole('radio', { name: '窓いっぱい' })).toBeChecked();
    await dialog(page).getByLabel('本文の最大幅').fill('500');
    await expect.poll(async () => Math.round((await columnBox(page)).width)).toBe(500);
    const fillColumn = await columnBox(page);
    expect(Math.round((await rect(page, '[data-testid=canvas-surface]')).width)).toBe(1280);

    await dialog(page).getByRole('radio', { name: '本文に合わせる' }).check();
    await expect(page.locator('.app')).toHaveAttribute('data-surface', 'text');
    expect(Math.round((await rect(page, '[data-testid=canvas-surface]')).width)).toBe(500 + 2 * 56);
    const textColumn = await columnBox(page);
    expect(Math.round(textColumn.width)).toBe(Math.round(fillColumn.width));
    expect(Math.round(textColumn.x)).toBe(Math.round(fillColumn.x));
    await expect.poll(() => savedPreferences(page)).toMatchObject({ surfaceWidth: 'text', maxWidthPx: 500 });

    await dialog(page).getByRole('radio', { name: '窓いっぱい' }).check();
    await expect(page.locator('.app')).toHaveAttribute('data-surface', 'fill');
    await expect.poll(() => savedPreferences(page)).toMatchObject({ surfaceWidth: 'fill' });
  });
});

test.describe('狭い窓のサイドバー', () => {
  test('押し出すと本文が最小幅を割る窓では、サイドバーは本文の上に重なる（本文は動かない）', async ({ page }) => {
    await page.setViewportSize({ width: 560, height: 700 });
    await open(page);
    const closed = await columnBox(page);
    await page.getByTestId('sidebar-toggle').click();
    await expect(sidebar(page)).toBeVisible();
    await expect(page.locator('.app')).toHaveAttribute('data-sidebar-mode', 'overlay');
    await expect.poll(async () => (await rect(page, '[data-testid=sidebar]')).left).toBe(0);

    const workspace = await rect(page, '.workspace');
    expect(workspace.left).toBe(0);
    expect(workspace.width).toBe(560);
    const column = await columnBox(page);
    expect(Math.round(column.x)).toBe(Math.round(closed.x));
    expect(Math.round(column.width)).toBe(Math.round(closed.width));
    expect(column.width).toBeGreaterThanOrEqual(320);

    // 上部バーの開閉ボタンが隠れるので、中の閉じるボタンと Esc で閉じられる。
    const close = sidebar(page).getByTestId('sidebar-close');
    await expect(close).toBeVisible();
    await close.click();
    await expect(sidebar(page)).toBeHidden();
    await expect(page.locator('.cm-content')).toBeFocused();

    await page.keyboard.press('ControlOrMeta+b');
    await expect(sidebar(page)).toBeVisible();
    await sidebar(page).getByTestId('sidebar-close').focus();
    await page.keyboard.press('Escape');
    await expect(sidebar(page)).toBeHidden();
  });

  test('境界の幅（260 + 360 = 620px）では押し出し、本文の列は最小の 320px まで縮んでも潰れない', async ({ page }) => {
    await page.setViewportSize({ width: 620, height: 700 });
    await open(page, { sidebarOpen: true });
    await expect(page.locator('.app')).toHaveAttribute('data-sidebar-mode', 'push');
    await expect.poll(async () => (await rect(page, '.workspace')).left).toBe(SIDEBAR);
    await expect.poll(async () => Math.round((await columnBox(page)).width)).toBe(320);
    await expect(sidebar(page).getByRole('button')).toHaveCount(1); // 閉じるボタンはなく、「フォルダを開く」だけ

    await page.setViewportSize({ width: 619, height: 700 });
    await expect(page.locator('.app')).toHaveAttribute('data-sidebar-mode', 'overlay');
    await expect.poll(async () => (await rect(page, '.workspace')).left).toBe(0);
  });
});

test.describe('開閉の動き', () => {
  test('Reduced Motion のときはアニメーションしない。そうでなければ付く', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await open(page);
    await expect(sidebar(page)).toHaveCSS('transition-duration', '0s');
    await page.keyboard.press('ControlOrMeta+b');
    // アニメーションがないので、待たずにすぐ最終の位置にある。
    expect((await rect(page, '.workspace')).left).toBe(SIDEBAR);

    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await expect(sidebar(page)).not.toHaveCSS('transition-duration', '0s');
  });
});
