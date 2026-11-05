import { expect, type Page } from '@playwright/test';
import { docTitle, launch, test, toast, utf8 } from './helpers';

// R6: 隔離した操作（段 2）の権限（宣言、初回の確認、保存、取り消し）と、同梱の段 2 の部品「パスをコピー」（Mod+Alt+C とツリーの右クリック）。
// クリップボードはメモリ bridge の記録（window.__mdeE2E.clipboard）。実際の OS のクリップボードには書かない。
// メモリ bridge の結果は DocumentBridge の内側を差し替えたもの。ネイティブ側の規則は src-tauri の cargo test が正本。

const ROOT = '/work/notes';
const DOC = '/work/notes/a.md';
const OTHER = '/work/notes/b.md';
const DOCS = '/work/notes/docs';
const GUIDE = '/work/notes/docs/guide.md';
const FILES = {
  [DOC]: utf8('# 見出し'),
  [OTHER]: utf8('B'),
  [GUIDE]: utf8('ガイド'),
};
const GRANTED = { version: 1 as const, plugins: { 'copy-path': { 'clipboard.write': 'granted' as const, 'paths.read': 'granted' as const } } };

type Seed = Record<string, unknown>;

const trace = (page: Page) => page.evaluate(() => window.__mdeE2EIsolatedTrace ?? []);
const clipboard = (page: Page) => page.evaluate(() => [...window.__mdeE2E!.clipboard]);
const savedPermissions = (page: Page) => page.evaluate(() => window.__mdeE2E!.savedPluginPermissions.map((p) => JSON.parse(JSON.stringify(p))));
const dialog = (page: Page) => page.getByRole('dialog', { name: '部品の権限の確認' });
const menu = (page: Page) => page.getByTestId('tree-context-menu');
const tree = (page: Page) => page.getByTestId('file-tree');
const row = (page: Page, name: string) => tree(page).getByRole('treeitem', { name, exact: true }).locator('> .tree-row');
const settings = (page: Page) => page.getByRole('dialog', { name: '設定' });
const permissionsSection = (page: Page) => page.getByTestId('settings-plugin-permissions');
const copyLabel = 'パスをコピー';
const consoleLogs = new WeakMap<Page, string[]>();
const stoppedReasons = (page: Page, plugin: string) => {
  const prefix = `[plugin] 部品「${plugin}」を止めました: `;
  return (consoleLogs.get(page) ?? []).filter((t) => t.startsWith(prefix)).map((t) => t.slice(prefix.length).replace(/ Error: [\s\S]*$/, ''));
};

/** 同梱の部品を読み込んで、フォルダを開き、文書を開く。部品が動き出す（コマンドとメニューの項目を登録した）まで待つ。 */
async function start(page: Page, seed: Seed = {}, options: { openDoc?: boolean; isolated?: Record<string, unknown> } = {}) {
  const logs: string[] = [];
  consoleLogs.set(page, logs);
  page.on('console', (m) => logs.push(m.text()));
  await launch(page, {
    files: FILES,
    openPath: DOC,
    folderPath: ROOT,
    preferences: { theme: 'light', autoHideChrome: false, sidebarOpen: true },
    isolated: { plugins: [], bundled: true, activateTimeoutMs: 8000, runTimeoutMs: 8000, ...options.isolated },
    ...seed,
  });
  await page.getByTestId('open-folder').click();
  await expect(tree(page)).toBeVisible();
  if (options.openDoc !== false) {
    await page.keyboard.press('ControlOrMeta+o');
    await expect(docTitle(page)).toHaveText('a.md');
  }
  await expect.poll(async () => (await trace(page)).some((e) => e.type === 'ready' && e.plugin === 'copy-path')).toBe(true);
  await page.locator('.cm-content').click();
}

const copyCurrentPath = (page: Page) => page.keyboard.press('ControlOrMeta+Alt+c');
const results = async (page: Page) => (await trace(page)).filter((e) => e.type === 'result').map((e) => [e.method, e.ok]);

test.describe('Mod+Alt+C: 開いている文書のパスをコピー (a)', () => {
  test('初回は確認の画面が出て、許可すると文書のパスがクリップボードに入り、トーストが出る。次からは聞かない', async ({ page }) => {
    await start(page);
    await copyCurrentPath(page);

    const confirm = dialog(page);
    await expect(confirm).toBeVisible();
    await expect(confirm).toHaveAttribute('aria-modal', 'true');
    await expect(confirm.getByTestId('permission-plugin-name')).toHaveText('パスをコピー');
    await expect(confirm.getByRole('listitem')).toHaveText(['文字列をクリップボードに書き込む', '開いている文書と、ツリーで選んだ項目のパスを知る']);
    await expect(confirm.getByRole('button', { name: '許可しない' })).toBeFocused();
    // 許可するまで、何も書かれない。
    expect(await clipboard(page)).toEqual([]);

    await confirm.getByRole('button', { name: '許可する' }).click();
    await expect(confirm).toHaveCount(0);
    await expect.poll(() => clipboard(page)).toEqual([DOC]);
    await expect(toast(page)).toHaveText('クリップボードにコピーしました');
    // 聞いた 2 つの権限が、まとめて許可として保存される。
    await expect.poll(async () => (await savedPermissions(page)).at(-1)).toEqual(GRANTED);
    // 確認を閉じたら、フォーカスは本文に戻る。
    await expect(page.locator('.cm-content')).toBeFocused();

    // 2 回目: 聞かずに、そのまま書く。
    await copyCurrentPath(page);
    await expect.poll(() => clipboard(page)).toEqual([DOC, DOC]);
    await expect(dialog(page)).toHaveCount(0);
    expect(await savedPermissions(page)).toHaveLength(1);
    expect((await trace(page)).some((e) => e.type === 'stopped')).toBe(false);
  });

  test('保存済みの許可があれば、聞かずに書く。別の文書を開いたら、その文書のパス', async ({ page }) => {
    await start(page, { pluginPermissions: GRANTED });
    await copyCurrentPath(page);
    await expect.poll(() => clipboard(page)).toEqual([DOC]);
    await expect(dialog(page)).toHaveCount(0);
    await page.evaluate((p) => void (window.__mdeE2E!.openPath = p), OTHER);
    await page.keyboard.press('ControlOrMeta+o');
    await expect(docTitle(page)).toHaveText('b.md');
    await copyCurrentPath(page);
    await expect.poll(() => clipboard(page)).toEqual([DOC, OTHER]);
  });

  test('未保存の新規文書では、何も書かず、トーストも出さない（部品は動き続ける）', async ({ page }) => {
    await start(page, { pluginPermissions: GRANTED }, { openDoc: false });
    await expect(docTitle(page)).toHaveText('無題');
    await copyCurrentPath(page);
    await expect.poll(async () => await results(page)).toEqual([['currentPath', true]]);
    await expect.poll(async () => (await trace(page)).some((e) => e.type === 'done')).toBe(true);
    expect(await clipboard(page)).toEqual([]);
    await expect(toast(page)).toHaveCount(0);
    expect((await trace(page)).some((e) => e.type === 'stopped')).toBe(false);
  });

  test('コマンドは、入力欄（設定画面の入力など）にフォーカスがあるときは実行しない', async ({ page }) => {
    await start(page, { pluginPermissions: GRANTED });
    await page.keyboard.press('ControlOrMeta+,');
    await expect(settings(page)).toBeVisible();
    await settings(page).locator('select, input').first().focus();
    await copyCurrentPath(page);
    await page.waitForTimeout(300);
    expect(await clipboard(page)).toEqual([]);
    expect((await trace(page)).some((e) => e.type === 'run')).toBe(false);
  });
});

test.describe('ツリーの右クリック: パスをコピー (b)', () => {
  test('ファイルの行とフォルダの行に「パスをコピー」が、本体の項目のあと、区切りを入れて並ぶ。選ぶとその行のパスが入る', async ({ page }) => {
    await start(page, { pluginPermissions: GRANTED });
    await row(page, 'a.md').click({ button: 'right' });
    await expect(menu(page).getByRole('menuitem')).toHaveText(['新しいファイル', '新しいフォルダ', '名前を変更', 'ゴミ箱に移動', copyLabel]);
    await expect(menu(page).getByRole('separator')).toHaveCount(1);
    // 区切りは、本体の項目と部品の項目の間。
    const order = await menu(page).locator('> *').evaluateAll((els) => els.map((el) => el.getAttribute('role')));
    expect(order).toEqual(['menuitem', 'menuitem', 'menuitem', 'menuitem', 'separator', 'menuitem']);
    await menu(page).getByRole('menuitem', { name: copyLabel }).click();
    await expect(menu(page)).toHaveCount(0);
    await expect.poll(() => clipboard(page)).toEqual([DOC]);
    await expect(toast(page)).toHaveText('クリップボードにコピーしました');

    // フォルダの行（開いた文書とは別の行）。
    await row(page, 'docs').click({ button: 'right' });
    await expect(menu(page).getByRole('menuitem', { name: copyLabel })).toBeVisible();
    await menu(page).getByRole('menuitem', { name: copyLabel }).click();
    await expect.poll(() => clipboard(page)).toEqual([DOC, DOCS]);
    // 文書は開いたまま、本文・保存の経路は何も変わらない。
    await expect(docTitle(page)).toHaveText('a.md');
  });

  test('キーボードだけで選べる: Shift+F10 で開き、上下・End で動き、Enter で実行。Esc で閉じて行へ戻る', async ({ page }) => {
    await start(page, { pluginPermissions: GRANTED });
    const item = tree(page).getByRole('treeitem', { name: 'b.md', exact: true });
    await item.focus();
    await page.keyboard.press('Shift+F10');
    await expect(menu(page)).toBeVisible();
    await expect(menu(page).getByRole('menuitem', { name: '新しいファイル' })).toBeFocused();
    await page.keyboard.press('End');
    await expect(menu(page).getByRole('menuitem', { name: copyLabel })).toBeFocused();
    await page.keyboard.press('ArrowUp');
    await expect(menu(page).getByRole('menuitem', { name: 'ゴミ箱に移動' })).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(menu(page).getByRole('menuitem', { name: copyLabel })).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(menu(page).getByRole('menuitem', { name: '新しいファイル' })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(menu(page)).toHaveCount(0);
    await expect(item).toBeFocused();
    expect(await clipboard(page)).toEqual([]);

    await page.keyboard.press('Shift+F10');
    await page.keyboard.press('End');
    await page.keyboard.press('Enter');
    await expect.poll(() => clipboard(page)).toEqual([OTHER]);
    // 実行したあと、フォーカスは行に戻る。
    await expect(item).toBeFocused();
  });

  test('初回は、項目を選んだときに確認の画面が出る。許可すると、そのまま書く（閉じたあとはメニューを開いた行にフォーカスが戻る）', async ({ page }) => {
    await start(page);
    const item = tree(page).getByRole('treeitem', { name: 'b.md', exact: true });
    await row(page, 'b.md').click({ button: 'right' });
    await menu(page).getByRole('menuitem', { name: copyLabel }).click();
    await expect(dialog(page)).toBeVisible();
    expect(await clipboard(page)).toEqual([]);
    await dialog(page).getByRole('button', { name: '許可する' }).click();
    await expect.poll(() => clipboard(page)).toEqual([OTHER]);
    await expect(dialog(page)).toHaveCount(0);
    await expect(item).toBeFocused();
  });

  test('空き領域のメニューと、補足の行には、部品の項目は出ない', async ({ page }) => {
    await start(page, { pluginPermissions: GRANTED });
    const area = page.getByTestId('explorer-tree-area');
    const box = (await area.boundingBox())!;
    await area.click({ button: 'right', position: { x: box.width / 2, y: box.height - 8 } });
    await expect(menu(page).getByRole('menuitem')).toHaveText(['新しいファイル', '新しいフォルダ']);
    await expect(menu(page).getByRole('separator')).toHaveCount(0);
  });
});

test.describe('許可しない (c)', () => {
  test('書かれず、部品は動き続ける。結果は保存され、再読み込みのあとも残る。設定画面の「取り消す」で、次の使用で再び聞く', async ({ page }) => {
    await start(page);
    await copyCurrentPath(page);
    await dialog(page).getByRole('button', { name: '許可しない' }).click();
    await expect(dialog(page)).toHaveCount(0);
    await expect.poll(async () => (await savedPermissions(page)).at(-1)).toEqual({ version: 1, plugins: { 'copy-path': { 'clipboard.write': 'denied', 'paths.read': 'denied' } } });
    await expect.poll(async () => await results(page)).toEqual([['currentPath', false]]);
    expect(await clipboard(page)).toEqual([]);
    await expect(toast(page)).toHaveCount(0);
    // 部品は止まらず、もう聞かない。呼び出しは、そのつど失敗するだけ。
    await copyCurrentPath(page);
    await expect.poll(async () => (await results(page)).length).toBe(2);
    await expect(dialog(page)).toHaveCount(0);
    expect(await clipboard(page)).toEqual([]);
    expect((await trace(page)).some((e) => e.type === 'stopped')).toBe(false);
    expect(stoppedReasons(page, 'copy-path')).toEqual([]);
    // 入力と保存は動く。
    await page.keyboard.type('追記');
    await expect(page.locator('.cm-content')).toContainText('追記');
    await page.keyboard.press('ControlOrMeta+s');
    await expect.poll(() => page.evaluate(() => window.__mdeE2E!.calls.save)).toBe(1);

    // 再読み込み（同じタブ）のあとも、拒否は残る。
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-ready', 'true');
    // 前回のフォルダは、自動で開き直される（session）。
    await expect(tree(page)).toBeVisible();
    await page.keyboard.press('ControlOrMeta+o');
    await expect(docTitle(page)).toHaveText('a.md');
    await expect.poll(async () => (await trace(page)).some((e) => e.type === 'ready' && e.plugin === 'copy-path')).toBe(true);
    await page.locator('.cm-content').click();
    await copyCurrentPath(page);
    await expect.poll(async () => await results(page)).toEqual([['currentPath', false]]);
    await expect(dialog(page)).toHaveCount(0);
    expect(await clipboard(page)).toEqual([]);

    // 設定画面の「部品の権限」。決めた権限と結果、「取り消す」。
    await page.keyboard.press('ControlOrMeta+,');
    await expect(settings(page)).toBeVisible();
    const entry = permissionsSection(page).getByTestId('plugin-permissions-copy-path');
    await expect(entry).toContainText('パスをコピー');
    await expect(entry.getByRole('listitem')).toHaveText(['文字列をクリップボードに書き込む: 拒否', '開いている文書と、ツリーで選んだ項目のパスを知る: 拒否']);
    await entry.getByRole('button', { name: 'パスをコピーの権限を取り消す' }).click();
    await expect(permissionsSection(page).getByTestId('plugin-permissions-empty')).toHaveText('決めた権限はありません。');
    await expect.poll(async () => (await savedPermissions(page)).at(-1)).toEqual({ version: 1, plugins: {} });
    await page.keyboard.press('Escape');
    await expect(settings(page)).toHaveCount(0);

    // 取り消したあとの使用で、再び確認が出る。許可すると、書かれる。
    await page.locator('.cm-content').click();
    await copyCurrentPath(page);
    await expect(dialog(page)).toBeVisible();
    await dialog(page).getByRole('button', { name: '許可する' }).click();
    await expect.poll(() => clipboard(page)).toEqual([DOC]);
  });

  test('メニューの項目も、拒否なら何も書かれず、メニューの項目は残る。決めたあとは聞かない', async ({ page }) => {
    await start(page);
    await row(page, 'a.md').click({ button: 'right' });
    await menu(page).getByRole('menuitem', { name: copyLabel }).click();
    await dialog(page).getByRole('button', { name: '許可しない' }).click();
    await expect(dialog(page)).toHaveCount(0);
    // paths.read が拒否だったので、部品の run は呼ばれない。
    expect((await trace(page)).filter((e) => e.type === 'run')).toEqual([]);
    expect(await clipboard(page)).toEqual([]);
    await row(page, 'a.md').click({ button: 'right' });
    await expect(menu(page).getByRole('menuitem', { name: copyLabel })).toBeVisible();
    await menu(page).getByRole('menuitem', { name: copyLabel }).click();
    await expect(dialog(page)).toHaveCount(0);
    expect(await clipboard(page)).toEqual([]);
  });

  test('パスは許可、クリップボードは拒否、のように権限ごとに決まっていれば、許可したものだけ使える（部品は止まらない）', async ({ page }) => {
    await start(page, { pluginPermissions: { version: 1, plugins: { 'copy-path': { 'paths.read': 'granted', 'clipboard.write': 'denied' } } } });
    await copyCurrentPath(page);
    await expect.poll(async () => await results(page)).toEqual([
      ['currentPath', true],
      ['clipboardWriteText', false],
    ]);
    expect(await clipboard(page)).toEqual([]);
    await expect(dialog(page)).toHaveCount(0);
    expect((await trace(page)).some((e) => e.type === 'stopped')).toBe(false);
  });
});

test.describe('Esc で閉じる (d)', () => {
  test('Esc と閉じるボタンは、今回だけ断る。書かれず、保存もされず、次の使用で再び確認が出る', async ({ page }) => {
    await start(page);
    await copyCurrentPath(page);
    await expect(dialog(page)).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog(page)).toHaveCount(0);
    await expect(page.locator('.cm-content')).toBeFocused();
    await expect.poll(async () => await results(page)).toEqual([['currentPath', false]]);
    expect(await clipboard(page)).toEqual([]);
    expect(await savedPermissions(page)).toEqual([]);
    expect((await trace(page)).some((e) => e.type === 'stopped')).toBe(false);

    // 次の使用で、再び聞く。今度は閉じるボタン。
    await copyCurrentPath(page);
    await expect(dialog(page)).toBeVisible();
    await dialog(page).getByRole('button', { name: '閉じる（今回だけ断る）' }).click();
    await expect(dialog(page)).toHaveCount(0);
    expect(await clipboard(page)).toEqual([]);
    expect(await savedPermissions(page)).toEqual([]);

    // 3 回目に許可すれば、書かれる。
    await copyCurrentPath(page);
    await dialog(page).getByRole('button', { name: '許可する' }).click();
    await expect.poll(() => clipboard(page)).toEqual([DOC]);
  });

  test('確認の画面を出している間は、その要求の時間切れで部品を止めない（時間切れは 1 秒。2 秒おいてから許可しても、書かれる）', async ({ page }) => {
    await start(page, {}, { isolated: { runTimeoutMs: 1000 } });
    await copyCurrentPath(page);
    await expect(dialog(page)).toBeVisible();
    await page.waitForTimeout(2200);
    await expect(dialog(page)).toBeVisible();
    expect((await trace(page)).some((e) => e.type === 'stopped')).toBe(false);
    await dialog(page).getByRole('button', { name: '許可する' }).click();
    await expect.poll(() => clipboard(page)).toEqual([DOC]);
    await expect.poll(async () => (await trace(page)).filter((e) => e.type === 'done').length).toBe(1);
    expect(stoppedReasons(page, 'copy-path')).toEqual([]);
  });

  test('確認の画面は、Tab がダイアログの中で循環する。同時に重ねて出ない', async ({ page }) => {
    await start(page);
    await copyCurrentPath(page);
    await copyCurrentPath(page);
    await expect(dialog(page)).toHaveCount(1);
    await expect(dialog(page).getByRole('button', { name: '許可しない' })).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(dialog(page).getByRole('button', { name: '許可する' })).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(dialog(page).getByRole('button', { name: '閉じる（今回だけ断る）' })).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(dialog(page).getByRole('button', { name: '許可しない' })).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(dialog(page).getByRole('button', { name: '閉じる（今回だけ断る）' })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(dialog(page)).toHaveCount(0);
  });
});

test.describe('ショートカットの Alt と AltGr (e)', () => {
  /** window に keydown を送る（Playwright の press は、AltGr で入る文字や modifierAltGraph を作れない）。 */
  type KeyInit = { key: string; code: string; ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean; modifierAltGraph?: boolean };
  const send = (page: Page, init: KeyInit) =>
    page.evaluate((i) => {
      const e = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...i });
      document.querySelector('.cm-content')!.dispatchEvent(e);
      return e.defaultPrevented;
    }, init);

  test('AltGr（Ctrl+Alt で文字が入る、または AltGraph）では発火しない。Ctrl+Alt+C（Mac では Cmd+Option+C）は発火する', async ({ page, platform }) => {
    await start(page, { pluginPermissions: GRANTED });
    const mac = platform === 'mac';
    // AltGr: Ctrl+Alt で、英字でない印字できる文字（AltGr+C が ç や © になる配列）。
    for (const key of ['ç', '©', '€']) expect(await send(page, { key, code: 'KeyC', ctrlKey: true, altKey: true }), key).toBe(false);
    // AltGr: AltGraph の状態を持つ（key が英字のままでも発火しない）。mac では Ctrl では発火しないので、この確認は Mod と同じ修飾で行う。
    expect(await send(page, { key: 'c', code: 'KeyC', ctrlKey: !mac, metaKey: mac, altKey: true, modifierAltGraph: true })).toBe(false);
    await page.waitForTimeout(300);
    expect((await trace(page)).filter((e) => e.type === 'run')).toEqual([]);
    expect(await clipboard(page)).toEqual([]);

    // 対照: 発火する形。Windows と Linux は Ctrl+Alt+C、macOS は Cmd+Option+C（key が ç になるので、物理キーで判定される）。
    expect(await send(page, mac ? { key: 'ç', code: 'KeyC', metaKey: true, altKey: true } : { key: 'c', code: 'KeyC', ctrlKey: true, altKey: true })).toBe(true);
    await expect.poll(() => clipboard(page)).toEqual([DOC]);
  });

  test('Alt なしの Mod+C と、Shift つきの Mod+Alt+Shift+C は、部品のコマンドを実行しない', async ({ page }) => {
    await start(page, { pluginPermissions: GRANTED });
    await page.keyboard.press('ControlOrMeta+c');
    await page.keyboard.press('ControlOrMeta+Alt+Shift+c');
    await page.waitForTimeout(300);
    expect((await trace(page)).filter((e) => e.type === 'run')).toEqual([]);
    expect(await clipboard(page)).toEqual([]);
  });

  test('Mod+Alt+C 以外の、既存のショートカットは変わらない（設定 Mod+,、サイドバー Mod+B、新規 Mod+N）', async ({ page }) => {
    await start(page, { pluginPermissions: GRANTED });
    await page.keyboard.press('ControlOrMeta+,');
    await expect(settings(page)).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(settings(page)).toHaveCount(0);
    await page.keyboard.press('ControlOrMeta+b');
    await expect(page.getByTestId('sidebar')).toHaveAttribute('data-open', 'false');
    await page.keyboard.press('ControlOrMeta+b');
    await expect(page.getByTestId('sidebar')).toHaveAttribute('data-open', 'true');
    await page.keyboard.press('ControlOrMeta+n');
    await expect(docTitle(page)).toHaveText('無題');
    await page.keyboard.press('ControlOrMeta+Alt+n');
    await page.waitForTimeout(200);
    expect(await clipboard(page)).toEqual([]);
  });
});

test.describe('部品が止まったとき (f)', () => {
  const stopFromRelay = (page: Page, plugin: string) =>
    page.frames().find((f) => f.url().endsWith('/plug/host.html'))!.evaluate((p) => parent.postMessage({ v: 0, kind: 'stopped', plugin: p, reason: 'テストのための停止' }, '*'), plugin);

  test('止まると、メニューの項目は消え（開いているメニューからも）、ショートカットは何もしない。入力と保存は続く', async ({ page }) => {
    await start(page, { pluginPermissions: GRANTED });
    await row(page, 'a.md').click({ button: 'right' });
    await expect(menu(page).getByRole('menuitem', { name: copyLabel })).toBeVisible();
    // 開いているメニューが、停止に追従する。
    await stopFromRelay(page, 'copy-path');
    await expect(menu(page).getByRole('menuitem', { name: copyLabel })).toHaveCount(0);
    await expect(menu(page).getByRole('separator')).toHaveCount(0);
    await expect(menu(page).getByRole('menuitem')).toHaveText(['新しいファイル', '新しいフォルダ', '名前を変更', 'ゴミ箱に移動']);
    await page.keyboard.press('Escape');
    await expect.poll(() => stoppedReasons(page, 'copy-path')).toEqual(['テストのための停止']);

    await row(page, 'docs').click({ button: 'right' });
    await expect(menu(page).getByRole('menuitem')).toHaveText(['新しいファイル', '新しいフォルダ', '名前を変更', 'ゴミ箱に移動']);
    await page.keyboard.press('Escape');

    await page.locator('.cm-content').click();
    await copyCurrentPath(page);
    await page.waitForTimeout(300);
    expect(await clipboard(page)).toEqual([]);
    expect((await trace(page)).filter((e) => e.type === 'run')).toEqual([]);
    await expect(dialog(page)).toHaveCount(0);

    // 入力と保存は続く。
    await page.keyboard.type('つづき');
    await expect(page.locator('.cm-content')).toContainText('つづき');
    await page.keyboard.press('ControlOrMeta+s');
    await expect.poll(() => page.evaluate(() => window.__mdeE2E!.calls.save)).toBe(1);
    expect(await page.evaluate(() => window.__mdeE2E!.readFile('/work/notes/a.md')?.length)).toBeGreaterThan(0);
  });

  test('確認の画面を出している間に部品が止まっても、画面は残り、答えても何も書かれない（部品は止まったまま）', async ({ page }) => {
    await start(page);
    await copyCurrentPath(page);
    await expect(dialog(page)).toBeVisible();
    await stopFromRelay(page, 'copy-path');
    await expect.poll(() => stoppedReasons(page, 'copy-path')).toEqual(['テストのための停止']);
    await dialog(page).getByRole('button', { name: '許可する' }).click();
    await expect(dialog(page)).toHaveCount(0);
    await page.waitForTimeout(200);
    expect(await clipboard(page)).toEqual([]);
  });
});

test.describe('起動と iframe', () => {
  test('同梱の部品がある（本番と同じ一覧）と、iframe と Worker は、最初の描画（data-ready）のあとに作られる', async ({ page }) => {
    await page.addInitScript(() => {
      const marks: Record<string, number> = {};
      (window as unknown as { __marks: typeof marks }).__marks = marks;
      new MutationObserver(() => {
        if (document.documentElement.dataset.ready === 'true') marks.ready ??= performance.now();
        if (document.querySelector('iframe[data-testid="plugin-host-frame"]')) marks.iframe ??= performance.now();
      }).observe(document, { attributes: true, childList: true, subtree: true });
    });
    await start(page);
    const marks = await page.evaluate(() => (window as unknown as { __marks: Record<string, number> }).__marks);
    expect(marks.ready).toBeDefined();
    expect(marks.iframe).toBeDefined();
    expect(marks.iframe!).toBeGreaterThanOrEqual(marks.ready!);
    await expect(page.locator('iframe[data-testid="plugin-host-frame"]')).toHaveAttribute('sandbox', 'allow-scripts');
    // 文書を開いて、すぐ入力できる。
    await page.keyboard.type('x');
    await expect(page.locator('.cm-content')).toContainText('x');
  });

  test('seed に isolated がなくても（e2e のビルドの既定）、本番と同じく同梱の部品を読み込む。外すのは bundled: false と明示したときだけ', async ({ page }) => {
    await launch(page, { files: FILES, openPath: DOC, folderPath: ROOT, preferences: { sidebarOpen: true } });
    await expect(page.locator('iframe[data-testid="plugin-host-frame"]')).toHaveCount(1);
  });

  test('bundled: false と明示すると、同梱の部品は読み込まれず、iframe も作られない', async ({ page }) => {
    await launch(page, { files: FILES, openPath: DOC, folderPath: ROOT, preferences: { sidebarOpen: true }, isolated: { plugins: [], bundled: false } });
    await expect(page.locator('iframe')).toHaveCount(0);
  });
});

test.describe('権限の API の拒否（検証用の部品）', () => {
  test('宣言していない権限の API は、確認の画面を出さずに拒否される。部品は動き続ける', async ({ page }) => {
    const logs: string[] = [];
    consoleLogs.set(page, logs);
    page.on('console', (m) => logs.push(m.text()));
    await launch(page, { files: FILES, openPath: DOC, isolated: { plugins: ['e2e-undeclared'], activateTimeoutMs: 8000, runTimeoutMs: 8000 } });
    await page.keyboard.press('ControlOrMeta+o');
    await expect(docTitle(page)).toHaveText('a.md');
    await expect.poll(async () => (await trace(page)).some((e) => e.type === 'ready')).toBe(true);
    await page.locator('.cm-content').click();
    await page.keyboard.press('ControlOrMeta+Shift+j');
    await expect.poll(async () => (await trace(page)).filter((e) => e.type === 'done').length).toBe(1);
    expect(await results(page)).toEqual([
      ['clipboardWriteText', false],
      ['currentPath', false],
    ]);
    await expect(dialog(page)).toHaveCount(0);
    expect(await clipboard(page)).toEqual([]);
    expect(await savedPermissions(page)).toEqual([]);
    expect(stoppedReasons(page, 'e2e-undeclared')).toEqual([]);
  });

  test('不正な形の呼び出しは、その部品を止める。権限を宣言せずにメニューの項目を登録すると、その部品を止める。知らない権限の宣言は読み込まない', async ({ page }) => {
    const logs: string[] = [];
    consoleLogs.set(page, logs);
    page.on('console', (m) => logs.push(m.text()));
    await launch(page, { files: FILES, openPath: DOC, isolated: { plugins: ['e2e-bad-call', 'e2e-menu-undeclared', 'e2e-unknown-permission', 'e2e-undeclared'], activateTimeoutMs: 8000, runTimeoutMs: 8000 } });
    await expect.poll(() => stoppedReasons(page, 'e2e-bad-call')).toEqual([expect.stringContaining('不正なメッセージ')]);
    await expect.poll(() => stoppedReasons(page, 'e2e-menu-undeclared')).toEqual([expect.stringContaining('paths.read')]);
    expect(logs.some((t) => t.startsWith('[plugin] 部品「e2e-unknown-permission」を読み込みません: ') && t.includes('network'))).toBe(true);
    // ほかの部品は動き続ける。
    await expect.poll(async () => (await trace(page)).some((e) => e.type === 'ready' && e.plugin === 'e2e-undeclared')).toBe(true);
    expect(await clipboard(page)).toEqual([]);
    await expect(dialog(page)).toHaveCount(0);
  });
});

test.describe('確認の画面を出す条件（R6b）', () => {
  const PART = 'e2e-prompt-abuse';
  /** 確認の画面が出た回数を、ページの中で数える（出てすぐ消えるものも逃さない）。 */
  const countDialogs = (page: Page) =>
    page.addInitScript(() => {
      const w = window as unknown as { __dialogShown: number };
      w.__dialogShown = 0;
      let visible = false;
      new MutationObserver(() => {
        const now = document.querySelector('[data-testid="permission-dialog"]') !== null;
        if (now && !visible) w.__dialogShown++;
        visible = now;
      }).observe(document, { childList: true, subtree: true });
    });
  const shown = (page: Page) => page.evaluate(() => (window as unknown as { __dialogShown: number }).__dialogShown);
  const partResults = async (page: Page) =>
    (await trace(page)).filter((e) => e.type === 'result' && e.plugin === PART).map((e) => [e.method, e.ok]);
  const partDone = async (page: Page) => (await trace(page)).filter((e) => e.type === 'done' && e.plugin === PART).length;
  const startPart = async (page: Page, seed: Seed = {}) => {
    await countDialogs(page);
    await start(page, seed, { isolated: { plugins: [PART] } });
    await expect.poll(async () => (await trace(page)).some((e) => e.type === 'ready' && e.plugin === PART)).toBe(true);
  };

  test('起動時（activate の中）の権限の呼び出しは、確認の画面を出さずに reject される。部品は止まらない', async ({ page }) => {
    await startPart(page);
    await expect.poll(() => partResults(page)).toEqual([['clipboardWriteText', false]]);
    expect(await shown(page)).toBe(0);
    await expect(dialog(page)).toHaveCount(0);
    expect(await clipboard(page)).toEqual([]);
    expect(await savedPermissions(page)).toEqual([]);
    expect(stoppedReasons(page, PART)).toEqual([]);
  });

  test('ショートカットの実行の中では、確認の画面が 1 回だけ出る。Esc で閉じたあとの 2 回目以降の呼び出しは、画面なしで reject される。次のショートカットでは、また 1 回出る', async ({ page }) => {
    await startPart(page);
    await expect.poll(() => partResults(page)).toHaveLength(1);
    await page.locator('.cm-content').click();
    await page.keyboard.press('ControlOrMeta+Shift+k');
    await expect(dialog(page)).toBeVisible();
    await page.keyboard.press('Escape');
    await expect.poll(() => partDone(page)).toBe(1);
    // 3 回の呼び出しのうち、画面が出たのは最初の 1 回だけ。3 回とも断られた（保存もされない）。
    expect(await partResults(page)).toEqual([['clipboardWriteText', false], ['currentPath', false], ['currentPath', false], ['currentPath', false]]);
    expect(await shown(page)).toBe(1);
    await expect(dialog(page)).toHaveCount(0);
    expect(await savedPermissions(page)).toEqual([]);

    await page.keyboard.press('ControlOrMeta+Shift+k');
    await expect(dialog(page)).toBeVisible();
    expect(await shown(page)).toBe(2);
    await dialog(page).getByRole('button', { name: '許可する' }).click();
    await expect.poll(() => partDone(page)).toBe(2);
    // 許可したので、同じ実行の 2 回目以降も通る（聞き直さない）。
    expect((await partResults(page)).slice(4)).toEqual([['currentPath', true], ['currentPath', true], ['currentPath', true]]);
    expect(await shown(page)).toBe(2);
    expect(stoppedReasons(page, PART)).toEqual([]);
  });

  test('実行の外（実行が終わったあとのタイマー）の呼び出しは、画面なしで reject される。部品は止まらない', async ({ page }) => {
    await startPart(page);
    await expect.poll(() => partResults(page)).toHaveLength(1);
    await page.locator('.cm-content').click();
    await page.keyboard.press('ControlOrMeta+Shift+l');
    await expect.poll(() => partDone(page)).toBe(1);
    await expect.poll(() => partResults(page)).toEqual([['clipboardWriteText', false], ['currentPath', false]]);
    expect(await shown(page)).toBe(0);
    await expect(dialog(page)).toHaveCount(0);
    expect(await savedPermissions(page)).toEqual([]);
    expect(stoppedReasons(page, PART)).toEqual([]);
  });

  test('ツリーの項目の選択の実行でも、1 回だけ。保存済みの paths.read は聞かず、未決の clipboard.write の確認が 1 回出て、Esc のあとの呼び出しは画面なしで reject される', async ({ page }) => {
    await startPart(page, { pluginPermissions: { version: 1, plugins: { [PART]: { 'paths.read': 'granted' } } } });
    await expect.poll(() => partResults(page)).toHaveLength(1);
    await row(page, 'b.md').click({ button: 'right' });
    await menu(page).getByRole('menuitem', { name: 'e2e-burst' }).click();
    await expect(dialog(page)).toBeVisible();
    await expect(dialog(page)).toContainText('文字列をクリップボードに書き込む');
    await page.keyboard.press('Escape');
    await expect.poll(() => partDone(page)).toBe(1);
    expect((await partResults(page)).slice(1)).toEqual([['clipboardWriteText', false], ['clipboardWriteText', false], ['clipboardWriteText', false]]);
    expect(await shown(page)).toBe(1);
    expect(await clipboard(page)).toEqual([]);
    expect(await savedPermissions(page)).toEqual([]);
    expect(stoppedReasons(page, PART)).toEqual([]);
  });
});

test.describe('設定画面の「部品の権限」', () => {
  test('決めたものがなければ、その旨を出す。保存済みの決定があれば、部品ごとに出す', async ({ page }) => {
    await start(page);
    await page.keyboard.press('ControlOrMeta+,');
    await expect(permissionsSection(page).getByRole('heading', { name: '部品の権限' })).toBeVisible();
    await expect(permissionsSection(page).getByTestId('plugin-permissions-empty')).toHaveText('決めた権限はありません。');
    await page.keyboard.press('Escape');

  });

  test('保存済みの決定は部品ごとに出る。読み込んでいない部品は id で出る', async ({ page }) => {
    await start(page, { pluginPermissions: { version: 1, plugins: { 'copy-path': { 'paths.read': 'granted' }, 'gone-plugin': { 'clipboard.write': 'denied' } } } });
    await page.keyboard.press('ControlOrMeta+,');
    await expect(permissionsSection(page).getByTestId('plugin-permissions-list').locator('> li')).toHaveCount(2);
    await expect(permissionsSection(page).getByTestId('plugin-permissions-gone-plugin')).toContainText('gone-plugin');
    await expect(permissionsSection(page).getByTestId('plugin-permissions-gone-plugin')).toContainText('文字列をクリップボードに書き込む: 拒否');
    await expect(permissionsSection(page).getByTestId('plugin-permissions-copy-path').getByRole('listitem')).toHaveText(['開いている文書と、ツリーで選んだ項目のパスを知る: 許可']);
  });
});
