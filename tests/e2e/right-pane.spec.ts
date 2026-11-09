import { expect, type CDPSession, type Page } from '@playwright/test';
import { charsPerLine } from '../../src/editor/layout';
import { columnBox, conflictBar, externalWrite, launch, test, unsavedMark, utf8, type Platform } from './helpers';

// ADR-005 の R13: 部品のパネル（アウトライン）は、左サイドバーの下ではなく、右ペインに出る。
// 起動時は閉じている。上部バーのボタンか Option+Cmd+B（Windows / Linux は Ctrl+Alt+B）で開閉する。開閉の状態は保存しない。
// 本文は、右ペインが開いていて節がたたまれていないときだけ、部品に届く。狭い窓では右ペインが本文の上に重なる。
// 所要時間を抑えるため、ホストの OS（chromium）と Windows の偽装（chromium-windows）だけで動かす（e2e 全体が gate の上限に近いため）。
// 実 IME ではなく、CDP による変換の模擬。実機（Tauri の窓、WKWebView）で Option+Cmd+B が届くかは、ここでは確かめない。

test.describe.configure({ mode: 'parallel' });
test.beforeEach(({}, testInfo) => {
  test.skip(['chromium-mac', 'chromium-linux'].includes(testInfo.project.name), 'chromium と chromium-windows だけ');
});

const DOC = '/docs/note.md';
const MD = ['# 第一章', '', '本文の段落。', '', '## 第一節', '', 'もう一つの段落。', '', '# 第二章', '', '終わり。'].join('\n');
const LEFT = 260;
const RIGHT = 260;

interface Rect {
  left: number;
  right: number;
  top: number;
  bottom: number;
  width: number;
}

async function rect(page: Page, selector: string): Promise<Rect> {
  return page.locator(selector).first().evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width };
  });
}
const overlaps = (a: Rect, b: Rect) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;

interface OpenOptions {
  width?: number;
  preferences?: Record<string, unknown>;
  isolated?: { plugins: string[]; bundled?: boolean; activateTimeoutMs?: number; runTimeoutMs?: number };
  text?: string;
}

async function openApp(page: Page, options: OpenOptions = {}) {
  await page.setViewportSize({ width: options.width ?? 1280, height: 800 });
  await launch(page, {
    files: { [DOC]: utf8(options.text ?? MD) },
    openPath: DOC,
    preferences: { theme: 'light', autoHideChrome: false, ...options.preferences },
    isolated: options.isolated ?? { plugins: [], activateTimeoutMs: 8000, runTimeoutMs: 8000 },
  });
  await page.keyboard.press('ControlOrMeta+o');
  await expect(page.getByTestId('doc-title')).toHaveText('note.md');
  // 部品は最初の描画のあとに動き始め、パネルを登録するまで、ボタンもショートカットもない（パネルが 1 つもないため）。
  if (options.isolated?.bundled !== false) await expect(page.getByTestId('right-pane-toggle')).toBeVisible();
}

const pane = (page: Page) => page.getByTestId('right-pane');
const toggle = (page: Page) => page.getByTestId('right-pane-toggle');
const sidebar = (page: Page) => page.getByTestId('sidebar');
const items = (page: Page) => pane(page).getByTestId('plugin-panel-item');
const itemTexts = (page: Page) => items(page).allTextContents();
const docTrace = (page: Page) => page.evaluate(() => (window.__mdeE2EIsolatedTrace ?? []).filter((e) => e.plugin === 'outline' && e.type === 'doc').length);
const editorFocused = (page: Page) => page.evaluate(() => document.activeElement?.closest('.cm-content') != null);
const savedPreferences = (page: Page) => page.evaluate(() => window.__mdeE2E!.savedPreferences.slice());

/** この OS の、右ペインの開閉のキー（Playwright の形。物理キーで指す）。 */
const shortcut = (platform: Platform) => (platform === 'mac' ? 'Alt+Meta+KeyB' : 'Control+Alt+KeyB');

async function expectOpen(page: Page, open: boolean) {
  await expect(pane(page)).toHaveAttribute('data-open', open ? 'true' : 'false');
  await expect(toggle(page)).toHaveAttribute('aria-expanded', open ? 'true' : 'false');
  await expect(page.locator('.app')).toHaveAttribute('data-right-pane', open ? 'open' : 'closed');
  if (open) await expect(pane(page)).not.toHaveAttribute('inert', /.*/);
  else await expect(pane(page)).toHaveAttribute('inert', '');
}

/** 本文の領域（.workspace）が、左右のペインのどちらとも重ならず、列が中央にあること。 */
async function expectColumnCentered(page: Page, label: string) {
  await expect
    .poll(async () => {
      const workspace = await rect(page, '.workspace');
      const column = await columnBox(page);
      return Math.abs(column.x + column.width / 2 - (workspace.left + workspace.width / 2)) <= 1;
    }, label)
    .toBe(true);
}

test.describe('起動時は閉じていて、ボタンで開閉できる', () => {
  test('起動直後は閉じていて、inert で、部品に本文が届かない。左サイドバーが開いていても同じ', async ({ page }) => {
    await openApp(page, { preferences: { sidebarOpen: true } });
    await expect(toggle(page)).toBeVisible();
    await expectOpen(page, false);
    await expect(toggle(page)).toHaveAttribute('aria-controls', 'app-right-pane');
    await expect(toggle(page)).toHaveAttribute('aria-label', 'パネル');
    await expect(pane(page)).toHaveAttribute('id', 'app-right-pane');
    await expect(page.getByRole('complementary', { name: 'パネル' })).toBeHidden();
    await expect(sidebar(page)).toHaveAttribute('data-open', 'true');
    // 左サイドバーが開いていても、本文は部品に届かない（右ペインの開閉だけが条件）。
    await page.waitForTimeout(800);
    expect(await docTrace(page)).toBe(0);
    expect(await page.evaluate(() => (window.__mdeE2EIsolatedTrace ?? []).filter((e) => e.plugin === 'outline' && e.type === 'selection').length)).toBe(0);
  });

  test('ボタンのタイトルにショートカットがある。ボタンは歯車の隣（上部バーの右端。歯車の右）にある', async ({ page, platform }) => {
    await openApp(page);
    await expect(toggle(page)).toHaveAttribute('title', platform === 'mac' ? 'パネル（⌥⌘B）' : 'パネル（Ctrl+Alt+B）');
    // 歯車の隣（上部バーの右端。歯車の右）にある。
    const gear = await rect(page, '[data-testid=settings-button]');
    const button = await rect(page, '[data-testid=right-pane-toggle]');
    expect(button.left).toBeGreaterThanOrEqual(gear.right - 1);
    expect(button.left - gear.right).toBeLessThanOrEqual(16);
    expect(Math.abs(button.top - gear.top)).toBeLessThanOrEqual(2);
  });

  test('ボタンで開くと見出しの一覧が出て、項目を押すとその行へ移る。もう一度押すと閉じる', async ({ page }) => {
    await openApp(page);
    await toggle(page).click();
    await expectOpen(page, true);
    await expect(pane(page)).toBeVisible();
    await expect.poll(() => itemTexts(page)).toEqual(['第一章', '第一節', '第二章']);
    // フォーカスは、押したボタンに残る（ペインの中へは移らない）。
    await expect(toggle(page)).toBeFocused();
    await items(page).nth(2).click();
    await expect
      .poll(() =>
        page.evaluate(() => {
          const view = window.__mdeE2E!.editor!;
          const { head } = view.getSelection();
          const text = view.getText();
          return text.slice(head, text.indexOf('\n', head) < 0 ? undefined : text.indexOf('\n', head));
        }),
      )
      .toBe('# 第二章');
    expect(await editorFocused(page)).toBe(true);
    // 項目を押しても、ペインは開いたまま（広い窓では、閉じない）。
    await expectOpen(page, true);
    await toggle(page).click();
    await expectOpen(page, false);
    await expect(items(page).first()).toBeHidden();
  });

  test('開閉の状態は保存しない: 設定は保存されず、再読み込みすると閉じている', async ({ page }) => {
    await openApp(page);
    const before = await savedPreferences(page);
    await toggle(page).click();
    await expectOpen(page, true);
    await page.waitForTimeout(800); // 設定の保存の debounce（300ms）より長く待つ
    expect(await savedPreferences(page)).toEqual(before);
    expect(JSON.stringify(await savedPreferences(page))).not.toMatch(/rightPane|right-pane|panelOpen/i);
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-ready', 'true');
    await expect(toggle(page)).toBeVisible();
    await expectOpen(page, false);
  });
});

test.describe('ショートカット（Option+Cmd+B / Ctrl+Alt+B）', () => {
  test('本文にフォーカスがあっても開閉できて、フォーカスは本文に残る', async ({ page, platform }) => {
    await openApp(page);
    await page.locator('.cm-content').click();
    expect(await editorFocused(page)).toBe(true);
    await page.keyboard.press(shortcut(platform));
    await expectOpen(page, true);
    expect(await editorFocused(page)).toBe(true);
    await expect.poll(() => itemTexts(page)).toEqual(['第一章', '第一節', '第二章']);
    // 本文に打てる（本文に B は入らない）。
    await page.keyboard.type('x');
    expect((await page.evaluate(() => window.__mdeE2E!.editor!.getText())).includes('x')).toBe(true);
    expect((await page.evaluate(() => window.__mdeE2E!.editor!.getText())).includes('b')).toBe(false);
    await page.keyboard.press(shortcut(platform));
    await expectOpen(page, false);
    expect(await editorFocused(page)).toBe(true);
  });

  test('macOS の Option で e.key が別の文字になっても、物理キー KeyB で開閉する', async ({ page, platform }) => {
    test.skip(platform !== 'mac', 'macOS（chromium）だけ');
    await openApp(page);
    await page.locator('.cm-content').click();
    for (const key of ['∫', 'Dead']) {
      await page.evaluate(
        (k) => void document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: k, code: 'KeyB', altKey: true, metaKey: true, bubbles: true, cancelable: true })),
        key,
      );
      await expect(pane(page)).toHaveAttribute('data-open', key === '∫' ? 'true' : 'false');
    }
  });

  test('Shift 付きでは開閉しない。⌘B / Ctrl+B は左サイドバーだけを開閉する', async ({ page, platform }) => {
    await openApp(page);
    await page.locator('.cm-content').click();
    await page.keyboard.press(`Shift+${shortcut(platform)}`);
    await expectOpen(page, false);
    await expect(sidebar(page)).toHaveAttribute('data-open', 'false');
    await page.keyboard.press('ControlOrMeta+b');
    await expect(sidebar(page)).toHaveAttribute('data-open', 'true');
    await expectOpen(page, false);
    await page.keyboard.press(shortcut(platform));
    await expectOpen(page, true);
    await expect(sidebar(page)).toHaveAttribute('data-open', 'true');
    await page.keyboard.press('ControlOrMeta+b');
    await expect(sidebar(page)).toHaveAttribute('data-open', 'false');
    await expectOpen(page, true);
  });

  test('IME の変換中は開閉しない（CDP による変換の模擬と、isComposing / keyCode 229 のキー）', async ({ page, platform }) => {
    await openApp(page);
    await page.locator('.cm-content').click();
    const client: CDPSession = await page.context().newCDPSession(page);
    await client.send('Input.imeSetComposition', { text: 'に', selectionStart: 1, selectionEnd: 1 });
    await page.keyboard.press(shortcut(platform));
    await expectOpen(page, false);
    await client.send('Input.imeSetComposition', { text: 'にほ', selectionStart: 2, selectionEnd: 2 });
    // 変換中を表すキー（isComposing と keyCode 229）を、本文へ送る。
    const mac = platform === 'mac';
    for (const init of [{ isComposing: true }, { keyCode: 229 }]) {
      await page.evaluate(
        ([i, isMac]) =>
          void document.activeElement!.dispatchEvent(
            new KeyboardEvent('keydown', { key: 'b', code: 'KeyB', altKey: true, metaKey: isMac, ctrlKey: !isMac, bubbles: true, cancelable: true, ...(i as object) }),
          ),
        [init, mac] as const,
      );
    }
    // 反映の遅れで取りこぼさないよう、少し待ってから確かめる。
    await page.waitForTimeout(300);
    await expectOpen(page, false);
    await client.send('Input.insertText', { text: '日本' });
    await expectOpen(page, false);
    // 確定した後は、開閉できる。
    await page.keyboard.press(shortcut(platform));
    await expectOpen(page, true);
  });

  test('設定画面（モーダル）を開いている間は、動かさない', async ({ page, platform }) => {
    await openApp(page);
    await page.keyboard.press('ControlOrMeta+,');
    await expect(page.getByRole('dialog', { name: '設定' })).toBeVisible();
    await page.keyboard.press(shortcut(platform));
    await expect(page.locator('.app')).toHaveAttribute('data-right-pane', 'closed');
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: '設定' })).toBeHidden();
    await page.keyboard.press(shortcut(platform));
    await expect(page.locator('.app')).toHaveAttribute('data-right-pane', 'open');
  });

  test('F6 の巡回には入らない（Tab では届く）', async ({ page, platform }) => {
    await openApp(page);
    await page.locator('.cm-content').click();
    await page.keyboard.press(shortcut(platform));
    await expectOpen(page, true);
    await expect.poll(() => itemTexts(page)).toHaveLength(3);
    for (let i = 0; i < 6; i++) {
      await page.keyboard.press('F6');
      expect(await page.evaluate(() => document.activeElement?.closest('[data-testid=right-pane]') != null)).toBe(false);
    }
    // Tab では、ペインの項目に届く（一覧に入る項目は 1 つ）。
    await items(page).first().focus();
    await expect(items(page).first()).toBeFocused();
    expect(await items(page).evaluateAll((els) => els.filter((e) => (e as HTMLElement).tabIndex === 0).length)).toBe(1);
  });
});

test.describe('部品のパネルが 1 つもないとき', () => {
  test('ボタンが出ず、ショートカットも何もしない', async ({ page, platform }) => {
    await openApp(page, { isolated: { plugins: [], bundled: false } });
    await page.waitForTimeout(500);
    await expect(toggle(page)).toHaveCount(0);
    await expect(pane(page)).toHaveCount(0);
    await page.locator('.cm-content').click();
    await page.keyboard.press(shortcut(platform));
    await expect(page.locator('.app')).toHaveAttribute('data-right-pane', 'closed');
    await expect(pane(page)).toHaveCount(0);
    await expect(toggle(page)).toHaveCount(0);
    expect(await editorFocused(page)).toBe(true);
  });
});

test.describe('本文を部品に届ける条件', () => {
  test('届くのは、右ペインが開いていて節がたたまれていないときだけ。左サイドバーの開閉は関係しない', async ({ page }) => {
    await openApp(page, { preferences: { sidebarOpen: true } });
    await page.locator('.cm-content').click();
    await page.keyboard.press('ControlOrMeta+End');
    await page.keyboard.type('\n\n# 閉じている間に書いた');
    await page.waitForTimeout(800);
    expect(await docTrace(page)).toBe(0);
    // 左サイドバーを閉じても開いても、届かない。
    await page.keyboard.press('ControlOrMeta+b');
    await expect(sidebar(page)).toHaveAttribute('data-open', 'false');
    await page.keyboard.press('ControlOrMeta+b');
    await page.waitForTimeout(500);
    expect(await docTrace(page)).toBe(0);
    // 右ペインを開くと、最新が 1 回届く。
    await toggle(page).click();
    await expect.poll(() => itemTexts(page)).toEqual(['第一章', '第一節', '第二章', '閉じている間に書いた']);
    expect(await docTrace(page)).toBe(1);
    // 左サイドバーを閉じても、右ペインが開いていれば届き続ける。
    await page.keyboard.press('ControlOrMeta+b');
    await expect(sidebar(page)).toHaveAttribute('data-open', 'false');
    await page.locator('.cm-content').click();
    await page.keyboard.press('ControlOrMeta+End');
    await page.keyboard.type('\n# 左を閉じた後');
    await expect.poll(() => itemTexts(page)).toContain('左を閉じた後');
    const delivered = await docTrace(page);
    expect(delivered).toBeGreaterThanOrEqual(2);
    // 右ペインを閉じると、また届かない。開くと、最新が届く。
    await toggle(page).click();
    await expectOpen(page, false);
    await page.locator('.cm-content').click();
    await page.keyboard.press('ControlOrMeta+End');
    await page.keyboard.type('\n# 右を閉じた間');
    await page.waitForTimeout(800);
    expect(await docTrace(page)).toBe(delivered);
    await toggle(page).click();
    await expect.poll(() => itemTexts(page)).toContain('右を閉じた間');
    expect(await docTrace(page)).toBe(delivered + 1);
  });

  test('節をたたむと、右ペインが開いていても届かない。戻すと最新が届く', async ({ page }) => {
    await openApp(page);
    await toggle(page).click();
    await expect.poll(() => itemTexts(page)).toHaveLength(3);
    const heading = pane(page).getByRole('button', { name: /アウトライン/ });
    await heading.click();
    await expect(heading).toHaveAttribute('aria-expanded', 'false');
    const before = await docTrace(page);
    await page.locator('.cm-content').click();
    await page.keyboard.press('ControlOrMeta+End');
    await page.keyboard.type('\n# たたんでいる間');
    await page.waitForTimeout(800);
    expect(await docTrace(page)).toBe(before);
    await heading.click();
    await expect.poll(() => itemTexts(page)).toContain('たたんでいる間');
    expect(await docTrace(page)).toBe(before + 1);
  });
});

test.describe('左右のペインと本文の領域', () => {
  test('1280px: 左右とも押し出し、本文の領域は残りの 760px。重ならず、列は中央', async ({ page, platform }) => {
    await openApp(page, { preferences: { sidebarOpen: true } });
    await page.keyboard.press(shortcut(platform));
    await expectOpen(page, true);
    await expect(page.locator('.app')).toHaveAttribute('data-sidebar-mode', 'push');
    await expect(page.locator('.app')).toHaveAttribute('data-right-pane-mode', 'push');
    await expect.poll(async () => (await rect(page, '.workspace')).width).toBe(1280 - LEFT - RIGHT);
    const left = await rect(page, '[data-testid=sidebar]');
    const work = await rect(page, '.workspace');
    const right = await rect(page, '[data-testid=right-pane]');
    expect(left.left).toBe(0);
    expect(left.width).toBe(LEFT);
    expect(work.left).toBe(LEFT);
    expect(right.right).toBe(1280);
    expect(right.width).toBe(RIGHT);
    expect(right.left).toBe(work.right);
    expect(overlaps(work, left) || overlaps(work, right) || overlaps(left, right)).toBe(false);
    // 右ペインは高さをすべて使う。
    expect(right.top).toBe(0);
    expect(right.bottom).toBe(800);
    await expectColumnCentered(page, '左右とも開いた状態で、列が本文の領域の中央にある');
    // 上部バーは本文の領域の中（右ペインにかぶらない）。右端はペインの左端まで。
    const topbar = await rect(page, '.topbar');
    expect(topbar.right).toBeLessThanOrEqual(right.left);
    await expect(toggle(page)).toBeVisible();
  });

  test('1 行の字数（設定画面の目安）は、左右の押し出し分を引いた本文の領域が基準', async ({ page, platform }) => {
    const preferences = { sidebarOpen: true, maxWidthPx: 800, fontSizePx: 18, letterSpacing: 0 };
    await openApp(page, { width: 1280, preferences });
    await page.keyboard.press(shortcut(platform));
    await expectOpen(page, true);
    await expect.poll(async () => (await rect(page, '.workspace')).width).toBe(760);
    const column = await columnBox(page);
    // 本文の領域 760 の中の列（余白は最小 20px）。左右を引かない 1280 - 260 = 1020 なら、列は 800 になる。
    expect(Math.round(column.width)).toBe(720);
    await page.keyboard.press('ControlOrMeta+,');
    const hint = page.getByTestId('chars-per-line');
    await expect(hint).toHaveText(`1 行 約 ${charsPerLine(720, 18, 0)} 字（全角）`);
    expect(charsPerLine(720, 18, 0)).not.toBe(charsPerLine(800, 18, 0));
  });

  test('1800px: トーストは、左右を引いた本文の領域の右の余白に置く（右ペインに重ならない）', async ({ page, platform }) => {
    await openApp(page, { width: 1800, preferences: { sidebarOpen: true } });
    await page.keyboard.press(shortcut(platform));
    await expectOpen(page, true);
    await expect.poll(async () => (await rect(page, '.workspace')).width).toBe(1800 - LEFT - RIGHT);
    // 存在しない文書を開こうとして、エラーのトーストを出す。
    await page.evaluate(() => {
      window.__mdeE2E!.openPath = '/docs/missing.md';
    });
    await page.keyboard.press('ControlOrMeta+o');
    const toast = page.getByTestId('toast');
    await expect(toast).toBeVisible();
    const region = page.locator('.toast-region');
    await expect(region).toHaveAttribute('data-placement', 'margin');
    // 幅は、本文の領域（1280）の列（本文面 792）の外の余白 244 から、左右のマージン 32 を引いた 212。
    await expect(region).toHaveCSS('--md-toast-width', '212px');
    const work = await rect(page, '.workspace');
    const t = await rect(page, '[data-testid=toast]');
    const right = await rect(page, '[data-testid=right-pane]');
    expect(t.right).toBeLessThanOrEqual(work.right);
    expect(t.right).toBeLessThanOrEqual(right.left);
  });

  test('競合バーは、左右を引いた本文の領域の中にあり、どちらのペインとも重ならない', async ({ page, platform }) => {
    await openApp(page, { preferences: { sidebarOpen: true } });
    await page.keyboard.press(shortcut(platform));
    await expectOpen(page, true);
    await page.locator('.cm-content').click();
    await page.keyboard.press('ControlOrMeta+Home');
    await page.keyboard.type('追記');
    await expect(unsavedMark(page)).toBeVisible();
    await externalWrite(page, DOC, '外部の版');
    await expect(conflictBar(page)).toBeVisible();
    const bar = await rect(page, '[data-testid=conflict-bar]');
    const work = await rect(page, '.workspace');
    const left = await rect(page, '[data-testid=sidebar]');
    const right = await rect(page, '[data-testid=right-pane]');
    expect(bar.left).toBeGreaterThanOrEqual(work.left);
    expect(bar.right).toBeLessThanOrEqual(work.right);
    expect(overlaps(bar, left) || overlaps(bar, right)).toBe(false);
    expect(Math.abs((bar.left + bar.right) / 2 - (work.left + work.right) / 2)).toBeLessThanOrEqual(1);
  });

  test('境界: 左右とも押し出すのは 880px から。879px では右ペインだけが本文に重なる', async ({ page, platform }) => {
    await openApp(page, { width: 880, preferences: { sidebarOpen: true } });
    await page.keyboard.press(shortcut(platform));
    await expectOpen(page, true);
    await expect(page.locator('.app')).toHaveAttribute('data-sidebar-mode', 'push');
    await expect(page.locator('.app')).toHaveAttribute('data-right-pane-mode', 'push');
    await expect.poll(async () => (await rect(page, '.workspace')).width).toBe(360);
    await expect.poll(async () => Math.round((await columnBox(page)).width)).toBe(320);

    await page.setViewportSize({ width: 879, height: 800 });
    await expect(page.locator('.app')).toHaveAttribute('data-sidebar-mode', 'push');
    await expect(page.locator('.app')).toHaveAttribute('data-right-pane-mode', 'overlay');
    // 本文の領域は、右ペインの分を引かない（左の分だけ）。右ペインは本文の上に重なる。
    await expect.poll(async () => (await rect(page, '.workspace')).width).toBe(879 - LEFT);
    await expect.poll(async () => (await rect(page, '[data-testid=right-pane]')).right).toBe(879);
    const work = await rect(page, '.workspace');
    const right = await rect(page, '[data-testid=right-pane]');
    expect(overlaps(work, right)).toBe(true);
    await expect(page.getByTestId('right-pane-close')).toBeVisible();
  });

  test('境界: 左サイドバーが閉じているとき、右ペインは 620px から押し出す。619px では重なる', async ({ page, platform }) => {
    await openApp(page, { width: 620 });
    await page.keyboard.press(shortcut(platform));
    await expectOpen(page, true);
    await expect(page.locator('.app')).toHaveAttribute('data-right-pane-mode', 'push');
    await expect.poll(async () => (await rect(page, '.workspace')).width).toBe(360);
    await expect(page.getByTestId('right-pane-close')).toHaveCount(0);
    await page.setViewportSize({ width: 619, height: 800 });
    await expect(page.locator('.app')).toHaveAttribute('data-right-pane-mode', 'overlay');
    await expect.poll(async () => (await rect(page, '.workspace')).width).toBe(619);
  });
});

test.describe('狭い窓: 右ペインは本文に重なる', () => {
  test('閉じるボタンで閉じ、本文にフォーカスが戻る。本文の領域は動かない', async ({ page, platform }) => {
    await openApp(page, { width: 560 });
    const closedWork = await rect(page, '.workspace');
    const closedColumn = await columnBox(page);
    await page.keyboard.press(shortcut(platform));
    await expectOpen(page, true);
    await expect(page.locator('.app')).toHaveAttribute('data-right-pane-mode', 'overlay');
    await expect(pane(page)).toBeVisible();
    await expect.poll(() => itemTexts(page)).toHaveLength(3);
    // 本文の領域も列も動かない（重なるだけ）。
    expect(await rect(page, '.workspace')).toEqual(closedWork);
    expect(await columnBox(page)).toEqual(closedColumn);
    // 重なる動き（位置の変化）が終わってから、矩形を比べる。
    await expect.poll(async () => (await rect(page, '[data-testid=right-pane]')).right).toBe(560);
    expect((await rect(page, '[data-testid=right-pane]')).width).toBe(RIGHT);
    const close = page.getByTestId('right-pane-close');
    await expect(close).toBeVisible();
    await expect(close).toHaveAccessibleName('パネルを閉じる');
    await close.click();
    await expectOpen(page, false);
    expect(await editorFocused(page)).toBe(true);
  });

  test('Esc（フォーカスがペインの中にあるとき）で閉じ、本文にフォーカスが戻る。本文にあるときの Esc では閉じない', async ({ page, platform }) => {
    await openApp(page, { width: 560 });
    await page.locator('.cm-content').click();
    await page.keyboard.press(shortcut(platform));
    await expectOpen(page, true);
    await expect.poll(() => itemTexts(page)).toHaveLength(3);
    // フォーカスが本文にあるときの Esc は、ペインを閉じない。
    await page.keyboard.press('Escape');
    await expectOpen(page, true);
    await items(page).nth(1).focus();
    await expect(items(page).nth(1)).toBeFocused();
    await page.keyboard.press('Escape');
    await expectOpen(page, false);
    expect(await editorFocused(page)).toBe(true);
  });

  test('広い窓（push）では、閉じるボタンはなく、Esc でも閉じない', async ({ page, platform }) => {
    await openApp(page);
    await page.keyboard.press(shortcut(platform));
    await expectOpen(page, true);
    await expect.poll(() => itemTexts(page)).toHaveLength(3);
    await expect(page.getByTestId('right-pane-close')).toHaveCount(0);
    await items(page).first().focus();
    await page.keyboard.press('Escape');
    await expectOpen(page, true);
  });
});

test.describe('閉じている間と、自動非表示', () => {
  test('閉じている間は inert で、中のボタンはフォーカスを受けない', async ({ page, platform }) => {
    await openApp(page);
    await page.keyboard.press(shortcut(platform));
    await expect.poll(() => itemTexts(page)).toHaveLength(3);
    await page.keyboard.press(shortcut(platform));
    await expectOpen(page, false);
    await expect(pane(page)).toHaveCSS('visibility', 'hidden');
    const focusable = await page.evaluate(() => {
      const els = Array.from(document.querySelectorAll<HTMLElement>('[data-testid=right-pane] button'));
      els.forEach((e) => e.focus());
      return { count: els.length, focused: els.some((e) => document.activeElement === e) };
    });
    expect(focusable.count).toBeGreaterThan(0);
    expect(focusable.focused).toBe(false);
  });

  test('自動非表示: 上部バーのボタンは上部バーと一緒に隠れ、ペイン自体は隠れない', async ({ page, platform }) => {
    await openApp(page, { preferences: { autoHideChrome: true } });
    await page.locator('.cm-content').click();
    await page.keyboard.press(shortcut(platform));
    await expectOpen(page, true);
    await expect.poll(() => itemTexts(page)).toHaveLength(3);
    await page.keyboard.type('x');
    await expect(page.locator('.app')).toHaveAttribute('data-chrome', 'hidden');
    await expect(page.locator('.topbar')).toHaveCSS('opacity', '0');
    await expect(toggle(page)).toHaveCSS('pointer-events', 'none');
    await expect(pane(page)).toBeVisible();
    await expect(pane(page)).toHaveCSS('opacity', '1');
    // ショートカットは、バーが隠れていても効く。
    await page.keyboard.press(shortcut(platform));
    await expectOpen(page, false);
  });
});

test.describe('見た目（ペインのスクロール）', () => {
  test('見出しが多いとき、ペインの高さを使い、はみ出る分はペインの中でスクロールする', async ({ page, platform }) => {
    const text = Array.from({ length: 120 }, (_, i) => `# 見出し ${i}\n`).join('\n');
    await openApp(page, { text });
    await page.keyboard.press(shortcut(platform));
    await expectOpen(page, true);
    await expect(items(page)).toHaveCount(120);
    const box = await page.getByTestId('plugin-panels').evaluate((el) => {
      const r = el.getBoundingClientRect();
      const paneRect = el.closest('[data-testid=right-pane]')!.getBoundingClientRect();
      return { height: r.height, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight, paneHeight: paneRect.height, overflowY: getComputedStyle(el).overflowY };
    });
    expect(box.overflowY).toBe('auto');
    expect(box.scrollHeight).toBeGreaterThan(box.clientHeight);
    // 左サイドバーの下の領域の半分ではなく、ペインの高さの大半（見出しの帯と余白を除く）を使う。
    expect(box.height).toBeGreaterThan(box.paneHeight * 0.7);
    // 節の見出しは固定される（スクロールしても、見えている）。
    await page.getByTestId('plugin-panels').evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
    await expect(page.getByTestId('plugin-panel-toggle')).toBeInViewport();
  });
});
