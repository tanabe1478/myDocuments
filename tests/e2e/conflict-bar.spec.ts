import { expect, type Page } from '@playwright/test';
import { columnBox, conflictBar, docTitle, externalWrite, launch, test, unsavedMark, utf8 } from './helpers';

// 外部変更の競合バーの配置。本文に重ならず、本文の列に揃い、出入りでカーソル行を見失わない。
test.describe.configure({ mode: 'parallel' });

const DOC = '/docs/note.md';

function longText(lines: number): string {
  return [
    '元の本文',
    '',
    ...Array.from({ length: lines }, (_, i) => `${i + 2} 段落目。外部の変更で競合バーが出ても、この本文が隠れないことを確かめる。`),
  ].join('\n');
}

async function openDoc(page: Page, text: string, preferences: Record<string, unknown> = {}) {
  await launch(page, { files: { [DOC]: utf8(text) }, openPath: DOC, preferences: { theme: 'light', ...preferences } });
  await page.keyboard.press('ControlOrMeta+o');
  await expect(docTitle(page)).toHaveText('note.md');
}

/** 文書の先頭に追記して未保存にし、外部が書き換えて競合バーを出す。 */
async function openWithConflict(page: Page, text = longText(60), preferences: Record<string, unknown> = {}) {
  await openDoc(page, text, preferences);
  await page.locator('.cm-content').click();
  await page.keyboard.press('ControlOrMeta+Home');
  await page.keyboard.type('追記');
  await expect(unsavedMark(page)).toBeVisible();
  await externalWrite(page, DOC, '外部の版');
  await expect(conflictBar(page)).toBeVisible();
}

interface Box {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

/**
 * 競合バーと、本文の行の「見えている部分」（.cm-scroller の領域で切り取った .cm-line）が重なる行の数と位置。
 * 領域の外へスクロールされた行や、領域の端で切れた行の外側は、見えていないので数えない。
 */
async function overlaps(page: Page): Promise<{ count: number; lines: Box[] }> {
  return page.evaluate(() => {
    type Box = { top: number; bottom: number; left: number; right: number };
    const rectOf = (el: Element): Box => {
      const r = el.getBoundingClientRect();
      return { top: r.top, bottom: r.bottom, left: r.left, right: r.right };
    };
    const clip = (a: Box, b: Box): Box => ({
      top: Math.max(a.top, b.top),
      bottom: Math.min(a.bottom, b.bottom),
      left: Math.max(a.left, b.left),
      right: Math.min(a.right, b.right),
    });
    const hit = (a: Box, b: Box) => a.top < b.bottom && a.bottom > b.top && a.left < b.right && a.right > b.left;
    const bar = rectOf(document.querySelector('[data-testid=conflict-bar]')!);
    const scroller = rectOf(document.querySelector('.cm-scroller')!);
    const lines = Array.from(document.querySelectorAll('.cm-line'))
      .map((el) => clip(rectOf(el), scroller))
      .filter((r) => r.bottom > r.top && r.right > r.left && hit(r, bar));
    return { count: lines.length, lines };
  });
}

async function box(page: Page, selector: string): Promise<Box> {
  return page.locator(selector).first().evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { top: r.top, bottom: r.bottom, left: r.left, right: r.right };
  });
}

const BAR = '[data-testid=conflict-bar]';

test.describe('競合バーは本文に重ならない', () => {
  test('(a) 文書の先頭までスクロールした状態で、バーと表示中の行が交差しない', async ({ page }) => {
    await openWithConflict(page);
    await page.locator('.cm-scroller').evaluate((el) => {
      el.scrollTop = 0;
    });

    expect((await overlaps(page)).count).toBe(0);
    // 1 行目は、バーの下に見えている。
    const first = await box(page, '.cm-line');
    const bar = await box(page, BAR);
    expect(first.top).toBeGreaterThanOrEqual(bar.bottom);
    await expect(page.locator('.cm-line').first()).toContainText('追記元の本文');
  });

  test('(a) 途中までスクロールした状態でも、バーと表示中の行が交差しない', async ({ page }) => {
    await openWithConflict(page);
    await page.locator('.cm-scroller').evaluate((el) => {
      el.scrollTop = 700;
    });
    // スクロール後の描画を待つ。
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));

    const result = await overlaps(page);
    expect(result.count, JSON.stringify(result.lines)).toBe(0);
    // 本文の表示領域は、バーの下から始まる。
    const scroller = await box(page, '.cm-scroller');
    const bar = await box(page, BAR);
    expect(scroller.top).toBeGreaterThanOrEqual(bar.bottom);
  });

  test('(a) 削除の通知（作り直し）のバーも、本文に重ならない', async ({ page }) => {
    await openDoc(page, longText(60));
    await page.locator('.cm-content').click();
    await page.keyboard.press('ControlOrMeta+Home');
    await page.keyboard.type('追記');
    await externalWrite(page, DOC, null);
    await expect(conflictBar(page)).toHaveAttribute('data-state', 'deleted');

    expect((await overlaps(page)).count).toBe(0);
    await expect(page.getByTestId('deleted-recreate')).toBeVisible();
  });
});

test.describe('競合バーの表示中の、本文の上の余白', () => {
  const contentPaddingTop = (page: Page) =>
    page.locator('.cm-content').evaluate((el) => parseFloat(getComputedStyle(el).paddingTop));

  /** カーソルの描画（.cm-cursor-primary）が、1 行目の縦の範囲に収まる（余白が変わった後も、描画が古い位置に残らない）。 */
  async function expectCursorOnFirstLine(page: Page) {
    await expect
      .poll(async () => {
        const line = await box(page, '.cm-line');
        const cursor = await box(page, '.cm-cursor-primary');
        return cursor.top >= line.top - 2 && cursor.bottom <= line.bottom + 2;
      })
      .toBe(true);
  }

  test('(a) バーの下端と本文 1 行目の間が、行高の 2 倍以下。バーが消えると元の余白に戻る', async ({ page }) => {
    await openDoc(page, longText(60));
    const normal = await contentPaddingTop(page);
    expect(normal).toBe(104);

    await page.locator('.cm-content').click();
    await page.keyboard.press('ControlOrMeta+Home');
    await page.keyboard.type('追記');
    await expect(unsavedMark(page)).toBeVisible();
    await externalWrite(page, DOC, '外部の版');
    await expect(conflictBar(page)).toBeVisible();
    await page.locator('.cm-scroller').evaluate((el) => {
      el.scrollTop = 0;
    });

    const lineHeight = await page.locator('.cm-line').first().evaluate((el) => parseFloat(getComputedStyle(el).lineHeight));
    const first = await box(page, '.cm-line');
    const bar = await box(page, BAR);
    expect(first.top - bar.bottom).toBeGreaterThan(0);
    expect(first.top - bar.bottom).toBeLessThanOrEqual(lineHeight * 2);
    // 余白が変わっても、カーソルの描画は、そのカーソルの行（1 行目）に付いている。
    await expectCursorOnFirstLine(page);

    // バーを消すと、元の余白に戻る。
    await page.getByTestId('conflict-reload').click();
    await expect(conflictBar(page)).toHaveCount(0);
    expect(await contentPaddingTop(page)).toBe(normal);
    await expectCursorOnFirstLine(page);
  });

  test('(a) タイプライターモードでは、タイプライターの余白（表示領域の半分）を優先する', async ({ page }) => {
    await openDoc(page, longText(60), { typewriterMode: true });
    await page.locator('.cm-content').click();
    await page.keyboard.type('追記');
    await expect(unsavedMark(page)).toBeVisible();
    await externalWrite(page, DOC, '外部の版');
    await expect(conflictBar(page)).toBeVisible();

    await expect
      .poll(async () => {
        const padding = await contentPaddingTop(page);
        const scroller = await box(page, '.cm-scroller');
        return Math.abs(padding - (scroller.bottom - scroller.top) / 2) < 2;
      })
      .toBe(true);
  });

  test('(a) 少しスクロールして先頭近くの行にカーソルがあっても、バーの出現で見えなくならない', async ({ page }) => {
    await openDoc(page, longText(60));
    await page.locator('.cm-content').click();
    await page.keyboard.press('ControlOrMeta+Home');
    await page.keyboard.type('追記');
    await expect(unsavedMark(page)).toBeVisible();
    // 1 行目（カーソルの行）が、表示領域の上端のすぐ下に来るまでスクロールする。
    await page.locator('.cm-scroller').evaluate((el) => {
      el.scrollTop = 90;
    });
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    // カーソルの行（1 行目）が、表示領域に収まっている。カーソルの描画ではなく、行の位置で判定する。
    const inView = async () => {
      const line = await box(page, '.cm-line');
      const scroller = await box(page, '.cm-scroller');
      return line.top >= scroller.top - 1 && line.bottom <= scroller.bottom + 1;
    };
    expect(await inView()).toBe(true);

    await externalWrite(page, DOC, '外部の版');
    await expect(conflictBar(page)).toBeVisible();
    // 本文の上の余白が詰まった後で、カーソル行が表示領域の中にある（詰まるぶん、スクロール位置もずれる）。
    await expect.poll(() => contentPaddingTop(page)).toBeLessThan(60);
    await expect.poll(inView).toBe(true);
    // バーを消して余白が戻っても、カーソル行は見えたまま。
    await page.getByTestId('conflict-reload').click();
    await expect(conflictBar(page)).toHaveCount(0);
    await expect.poll(() => contentPaddingTop(page)).toBe(104);
    await expect.poll(inView).toBe(true);
    await expectCursorOnFirstLine(page);
  });
});

test.describe('競合バーの出現・消失とカーソル行', () => {
  /** カーソル（.cm-cursor-primary）が、本文の表示領域に収まっている。 */
  async function cursorInView(page: Page): Promise<{ inView: boolean; cursor: Box; scroller: Box }> {
    const cursor = await box(page, '.cm-cursor-primary');
    const scroller = await box(page, '.cm-scroller');
    return { inView: cursor.top >= scroller.top - 1 && cursor.bottom <= scroller.bottom + 1, cursor, scroller };
  }

  test('(b) 表示領域の下端にカーソルがあっても、バーの出現・消失で見えなくならない', async ({ page }) => {
    await openDoc(page, longText(80));
    await page.locator('.cm-scroller').evaluate((el) => {
      el.scrollTop = 0;
    });
    // 本文の途中（先頭から 40 行ほど下）にカーソルを置いて入力し、カーソルが表示領域の下端のすぐ上に来るまでスクロールする。
    await page.locator('.cm-content').click();
    await page.keyboard.press('ControlOrMeta+Home');
    for (let i = 0; i < 40; i++) await page.keyboard.press('ArrowDown');
    await page.keyboard.type('追記');
    await expect(unsavedMark(page)).toBeVisible();
    await page.locator('.cm-scroller').evaluate((el) => {
      const cursor = document.querySelector('.cm-cursor-primary')!.getBoundingClientRect();
      el.scrollTop += cursor.bottom - (el.getBoundingClientRect().bottom - 30);
    });
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    expect((await cursorInView(page)).inView).toBe(true);
    const before = await box(page, '.cm-scroller');

    await externalWrite(page, DOC, '外部の版');
    await expect(conflictBar(page)).toBeVisible();

    // バーの分だけ本文の領域が縮んでも、カーソルは領域内に残る。
    const after = await box(page, '.cm-scroller');
    expect(after.bottom - after.top).toBeLessThan(before.bottom - before.top);
    await expect.poll(async () => (await cursorInView(page)).inView).toBe(true);

    // 選択肢を選ぶとバーが短くなり、保存で消える。どの時点でも見えている。
    await page.getByTestId('conflict-keep').click();
    await expect(conflictBar(page)).toHaveAttribute('data-state', 'keep-mine');
    await expect.poll(async () => (await cursorInView(page)).inView).toBe(true);
    await page.keyboard.press('ControlOrMeta+s');
    await expect(conflictBar(page)).toHaveCount(0);
    await expect.poll(async () => (await cursorInView(page)).inView).toBe(true);
    const restored = await box(page, '.cm-scroller');
    expect(restored.bottom - restored.top).toBeCloseTo(before.bottom - before.top, 0);
  });

  test('(b) 文書の末尾にカーソルがあるときも、出現・消失で見えなくならない', async ({ page }) => {
    await openDoc(page, longText(80));
    await page.locator('.cm-content').click();
    await page.keyboard.press('ControlOrMeta+End');
    await page.keyboard.type('追記');
    await externalWrite(page, DOC, '外部の版');
    await expect(conflictBar(page)).toBeVisible();
    await expect.poll(async () => (await cursorInView(page)).inView).toBe(true);

    await page.getByTestId('conflict-reload').click();
    await expect(conflictBar(page)).toHaveCount(0);
    await expect.poll(async () => (await cursorInView(page)).inView).toBe(true);
  });
});

test.describe('競合バーの幅と位置', () => {
  test('(c) サイドバーを開いても、バーは本文の列に揃い、サイドバーと重ならない。閉じると元の中央へ戻る', async ({ page }) => {
    await openDoc(page, longText(20));
    await page.locator('.cm-content').click();
    await page.keyboard.type('追記');
    await page.keyboard.press('ControlOrMeta+b');
    const sidebar = page.getByTestId('sidebar');
    await expect(sidebar).toBeVisible();
    await externalWrite(page, DOC, '外部の版');
    await expect(conflictBar(page)).toBeVisible();
    // 本文が右へ寄る動きの終わりを待つ。
    await expect
      .poll(async () => {
        const column = await columnBox(page);
        const bar = await box(page, BAR);
        return Math.abs(bar.left - column.x) < 16 && Math.abs(bar.right - (column.x + column.width)) < 16;
      })
      .toBe(true);

    const bar = await box(page, BAR);
    const side = await box(page, '[data-testid=sidebar]');
    expect(bar.left).toBeGreaterThanOrEqual(side.right);
    expect((await overlaps(page)).count).toBe(0);

    // 閉じると、本文とバーが中央へ戻り、列に揃ったまま。
    await page.keyboard.press('ControlOrMeta+b');
    await expect(sidebar).toBeHidden();
    await expect
      .poll(async () => {
        const column = await columnBox(page);
        const closed = await box(page, BAR);
        return Math.abs(closed.left - column.x) < 16 && Math.abs(closed.right - (column.x + column.width)) < 16;
      })
      .toBe(true);
  });

  test('バーの幅は本文の列（--md-max-width）を超えない', async ({ page }) => {
    await openWithConflict(page, longText(20), { maxWidthPx: 520 });
    const column = await columnBox(page);
    const bar = await box(page, BAR);
    expect(bar.right - bar.left).toBeLessThanOrEqual(520 + 1);
    expect(Math.abs(bar.left - column.x)).toBeLessThan(16);
  });

  test('(d) 820x700 の狭い窓でも、バーは窓に収まり、ボタンが折り返しても本文と重ならない', async ({ page }) => {
    await page.setViewportSize({ width: 820, height: 700 });
    await openWithConflict(page);

    await expectBarFits(page, 820);
    expect((await overlaps(page)).count).toBe(0);
  });

  test('(d) さらに狭い窓（420x700）では、ボタンが折り返して、1 行目のメッセージの下に並ぶ', async ({ page }) => {
    await page.setViewportSize({ width: 420, height: 700 });
    await openWithConflict(page);

    await expectBarFits(page, 420);
    expect((await overlaps(page)).count).toBe(0);
    // メッセージの下に操作ボタン。
    const message = await box(page, '.conflict-message');
    for (const id of ['conflict-diff', 'conflict-reload', 'conflict-keep']) {
      const b = await box(page, `[data-testid=${id}]`);
      expect(b.top).toBeGreaterThanOrEqual(message.bottom - 1);
    }
  });

  async function expectBarFits(page: Page, width: number) {
    const bar = await box(page, BAR);
    expect(bar.left).toBeGreaterThanOrEqual(0);
    expect(bar.right).toBeLessThanOrEqual(width);
    for (const id of ['conflict-diff', 'conflict-reload', 'conflict-keep']) {
      await expect(page.getByTestId(id)).toBeVisible();
      const b = await box(page, `[data-testid=${id}]`);
      expect(b.left).toBeGreaterThanOrEqual(bar.left);
      expect(b.right).toBeLessThanOrEqual(bar.right + 0.5);
      expect(b.top).toBeGreaterThanOrEqual(bar.top);
      expect(b.bottom).toBeLessThanOrEqual(bar.bottom + 0.5);
    }
  }
});

test.describe('競合バーの表示条件とアクセシビリティ', () => {
  test('(e) 自動非表示の設定でも、競合中はバーが見えて操作できる', async ({ page }) => {
    await openDoc(page, longText(20), { autoHideChrome: true });
    await page.locator('.cm-content').click();
    await page.keyboard.type('追記');
    await expect(page.locator('.app')).toHaveAttribute('data-chrome', 'hidden');

    await externalWrite(page, DOC, '外部の版');

    await expect(conflictBar(page)).toBeVisible();
    await expect(page.locator('.app')).toHaveAttribute('data-chrome', 'hidden');
    await expect(conflictBar(page)).toHaveCSS('opacity', '1');
    await expect(page.getByTestId('conflict-diff')).toHaveCSS('pointer-events', 'auto');
    expect((await overlaps(page)).count).toBe(0);
    await page.getByTestId('conflict-diff').click();
    await expect(page.getByTestId('diff-dialog')).toBeVisible();
  });

  test('バーは名前を持つ alert で、出現がスクリーンリーダーへ伝わる。F6 の巡回にも入る', async ({ page }) => {
    await openWithConflict(page, longText(20));
    const alert = page.getByRole('alert', { name: '外部変更の競合' });
    await expect(alert).toBeVisible();
    await expect(alert).toContainText('外部で変更されています');

    // F6: 本文 → 上部バー → 競合バー → 下部バー → 本文。
    await page.keyboard.press('F6');
    await expect(page.getByTestId('sidebar-toggle')).toBeFocused();
    await page.keyboard.press('F6');
    await expect(page.getByTestId('conflict-diff')).toBeFocused();
    await page.keyboard.press('F6');
    await expect(page.getByTestId('char-count')).toBeFocused();
    await page.keyboard.press('F6');
    await expect(page.locator('.cm-content')).toBeFocused();

    // Tab でも 3 つのボタンへ順に届く。
    await page.getByTestId('conflict-diff').focus();
    await page.keyboard.press('Tab');
    await expect(page.getByTestId('conflict-reload')).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(page.getByTestId('conflict-keep')).toBeFocused();
  });

  test('Reduced Motion では、バーと本文の領域にアニメーションを付けない', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await openWithConflict(page, longText(20));

    for (const selector of [BAR, '.conflict-region', '.editor-host']) {
      const style = await page.locator(selector).first().evaluate((el) => {
        const cs = getComputedStyle(el);
        return { animationName: cs.animationName, transitionDuration: cs.transitionDuration };
      });
      expect(style, selector).toEqual({ animationName: 'none', transitionDuration: '0s' });
    }
  });
});
