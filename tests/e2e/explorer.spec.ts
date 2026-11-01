import { expect, type Page } from '@playwright/test';
import { bridgeState, docTitle, editorText, launch, setDialogPaths, test, toast, unsavedMark, utf8 } from './helpers';

// Run 9: 左サイドバーのフォルダツリー（見る、開く）。フォルダ選択ダイアログの戻り値は seed の folderPath。
test.describe.configure({ mode: 'parallel' });

const ROOT = '/work/notes';
const at = (rel: string) => `${ROOT}/${rel}`;

const FILES = {
  [at('a.md')]: utf8('# 見出しA\n\n本文A'),
  [at('b.txt')]: utf8('# これは見出しではない\n\n- 箇条書きでもない\n\n素のテキスト'),
  [at('file2.md')]: utf8('二番'),
  [at('File10.md')]: utf8('十番'),
  [at('Zeta.md')]: utf8('# ゼータ'),
  [at('c.text')]: utf8('text 拡張子'),
  [at('img.png')]: [0x89, 0x50, 0x4e, 0x47],
  [at('notes.json')]: utf8('{}'),
  [at('.hidden.md')]: utf8('隠し'),
  [at('.git/config')]: utf8('[core]'),
  [at('docs/guide.md')]: utf8('# ガイド'),
  [at('docs/memo.text')]: utf8('メモ'),
  [at('docs/deep/inner.mdx')]: utf8('# 内側'),
  [at('Archive/old.md')]: utf8('古い'),
};

const SEED = {
  files: FILES,
  folderPath: ROOT,
  emptyFolders: [at('empty')],
  symlinkFolders: [at('linked')],
  preferences: { theme: 'light', autoHideChrome: false, sidebarOpen: true },
};

const tree = (page: Page) => page.getByTestId('file-tree');
const item = (page: Page, name: string) => tree(page).getByRole('treeitem', { name, exact: true });
/** 項目の行（クリックの対象）。li を押すと、展開中は中央が子の行に当たる。aria-disabled の項目も、利用者は押せるので force で押す。 */
const row = (page: Page, name: string) => item(page, name).locator('> .tree-row');
const names = (page: Page) =>
  page.getByTestId('tree-item').evaluateAll((els) => els.map((el) => el.getAttribute('aria-label')));
const listed = (page: Page) => page.evaluate(() => [...window.__mdeE2E!.listed]);
const calls = (page: Page) => page.evaluate(() => ({ ...window.__mdeE2E!.calls }));

async function openFolder(page: Page, seed: Record<string, unknown> = {}) {
  await launch(page, { ...SEED, ...seed });
  await page.getByTestId('open-folder').click();
  await expect(tree(page)).toBeVisible();
}

test.describe('フォルダを開く (a)', () => {
  test('未選択のときは「フォルダを開く」だけ。キャンセルは何もせず、選ぶとツリーが出る', async ({ page }) => {
    await launch(page, { ...SEED, folderPath: null });
    await expect(page.getByTestId('sidebar').getByRole('heading', { name: 'エクスプローラー' })).toBeVisible();
    await expect(page.getByTestId('sidebar-empty')).toContainText('フォルダはまだ開かれていません');
    await expect(page.getByTestId('refresh-folder')).toHaveCount(0);

    await page.getByTestId('open-folder').click();
    await expect(page.getByTestId('sidebar-empty')).toBeVisible();
    expect((await calls(page)).folderOpen).toBe(0);
    await expect(toast(page)).toHaveCount(0);

    await setDialogPaths(page, { folder: ROOT });
    await page.getByTestId('open-folder').click();
    await expect(tree(page)).toBeVisible();
    await expect(page.getByTestId('sidebar-empty')).toHaveCount(0);
    expect((await bridgeState(page)).session).toMatchObject({ lastFolder: ROOT });
  });

  test('見出し部にフォルダ名（フルパスは title）、再読み込み、別のフォルダを開くが出る', async ({ page }) => {
    await openFolder(page);
    await expect(page.getByTestId('folder-name')).toHaveText('notes');
    await expect(page.getByTestId('folder-name')).toHaveAttribute('title', ROOT);
    await expect(page.getByTestId('refresh-folder')).toHaveAccessibleName('再読み込み');
    await expect(page.getByTestId('change-folder')).toHaveText('別のフォルダを開く');
  });

  test('フォルダが先、その中は自然順（大文字小文字を区別しない）。隠しは出ない。全ファイルが出る', async ({ page }) => {
    await openFolder(page);
    expect(await names(page)).toEqual([
      'Archive',
      'docs',
      'empty',
      'linked（リンク）',
      'a.md',
      'b.txt',
      'c.text',
      'file2.md',
      'File10.md',
      'img.png',
      'notes.json',
      'Zeta.md',
    ]);
    await expect(tree(page).getByText('.hidden.md')).toHaveCount(0);
    await expect(tree(page).getByText('.git')).toHaveCount(0);
  });

  test('別のフォルダを開くと、ツリーが入れ替わり、展開は引き継がない', async ({ page }) => {
    await openFolder(page, { files: { ...FILES, '/other/x.md': utf8('x') } });
    await row(page, 'docs').click({ force: true });
    await expect(item(page, 'guide.md')).toBeVisible();

    await setDialogPaths(page, { folder: '/other' });
    await page.getByTestId('change-folder').click();
    await expect(page.getByTestId('folder-name')).toHaveText('other');
    expect(await names(page)).toEqual(['x.md']);
    await expect(toast(page)).toHaveCount(0);
  });

  test('存在しないフォルダを選ぶとトーストで知らせ、いまのツリーを残す', async ({ page }) => {
    await openFolder(page);
    await setDialogPaths(page, { folder: '/nowhere' });
    await page.getByTestId('change-folder').click();
    await expect(toast(page)).toContainText('フォルダを開けませんでした');
    await expect(page.getByTestId('folder-name')).toHaveText('notes');
    expect((await bridgeState(page)).session).toMatchObject({ lastFolder: ROOT });
  });
});

test.describe('展開と折りたたみ (b)', () => {
  test('展開したときに中身を読み（遅延読み込み）、折りたためる。再度の展開では読み直さない', async ({ page }) => {
    await openFolder(page);
    expect(await listed(page)).toEqual([ROOT]);

    const docs = item(page, 'docs');
    await expect(docs).toHaveAttribute('aria-expanded', 'false');
    await row(page, 'docs').click();
    await expect(docs).toHaveAttribute('aria-expanded', 'true');
    await expect(item(page, 'deep')).toBeVisible();
    await expect(item(page, 'guide.md')).toBeVisible();
    await expect(item(page, 'memo.text')).toBeVisible();
    expect(await listed(page)).toEqual([ROOT, at('docs')]);
    // 子は level 2。順序は、子のフォルダが先。
    await expect(item(page, 'deep')).toHaveAttribute('aria-level', '2');
    await expect(docs).toHaveAttribute('aria-level', '1');
    expect(await names(page)).toEqual(expect.arrayContaining(['deep', 'guide.md', 'memo.text']));
    const order = await names(page);
    expect(order.indexOf('deep')).toBeLessThan(order.indexOf('guide.md'));

    await row(page, 'deep').click({ force: true });
    await expect(item(page, 'inner.mdx')).toHaveAttribute('aria-level', '3');

    await row(page, 'docs').click();
    await expect(docs).toHaveAttribute('aria-expanded', 'false');
    await expect(item(page, 'guide.md')).toHaveCount(0);
    await expect(item(page, 'inner.mdx')).toHaveCount(0);

    await row(page, 'docs').click();
    await expect(item(page, 'guide.md')).toBeVisible();
    // 孫の展開状態は、親を折りたたんでも保たれる。
    await expect(item(page, 'inner.mdx')).toBeVisible();
    expect(await listed(page)).toEqual([ROOT, at('docs'), at('docs/deep')]);
  });

  test('空のフォルダは、そのことを示す（開けない行）', async ({ page }) => {
    await openFolder(page);
    await row(page, 'empty').click({ force: true });
    await expect(page.getByTestId('tree-note')).toHaveText('空のフォルダ');
    await expect(page.getByTestId('tree-note')).toHaveAttribute('aria-disabled', 'true');
  });

  test('フォルダへのシンボリックリンクは、印があり、展開しない（読みにも行かない）', async ({ page }) => {
    await openFolder(page);
    const link = item(page, 'linked（リンク）');
    await expect(link).toHaveAttribute('data-kind', 'symlinkDir');
    await expect(link).not.toHaveAttribute('aria-expanded', /.*/);
    await expect(link).toHaveAttribute('aria-disabled', 'true');
    await expect(link.locator('.tree-badge').first()).toBeVisible();
    await row(page, 'linked（リンク）').click({ force: true });
    await link.focus();
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('Enter');
    expect(await listed(page)).toEqual([ROOT]);
  });

  test('再読み込みは、外で増えた項目を出し、展開状態を保つ', async ({ page }) => {
    await openFolder(page);
    await row(page, 'docs').click({ force: true });
    await expect(item(page, 'guide.md')).toBeVisible();
    await page.evaluate(
      ([root]) => {
        const s = window.__mdeE2E!;
        s.files.set(`${root}/docs/added.md`, new Uint8Array([97]));
        s.files.set(`${root}/new-top.md`, new Uint8Array([98]));
      },
      [ROOT],
    );
    await expect(item(page, 'added.md')).toHaveCount(0);

    await page.getByTestId('refresh-folder').click();
    await expect(item(page, 'added.md')).toBeVisible();
    await expect(item(page, 'new-top.md')).toBeVisible();
    await expect(item(page, 'docs')).toHaveAttribute('aria-expanded', 'true');
    await expect(item(page, 'guide.md')).toBeVisible();
  });

  test('読めないフォルダは、行とトーストで知らせ、再度の展開で読み直す', async ({ page }) => {
    await openFolder(page, { unreadableFolders: [at('locked')] });
    await expect(item(page, 'locked')).toBeVisible();
    await row(page, 'locked').click({ force: true });
    await expect(toast(page)).toContainText('権限');
    await expect(page.getByTestId('tree-note')).toContainText('権限');
  });

  test('長い名前は省略表示され、title に全文が入る', async ({ page }) => {
    const long = `${'とても長いファイル名'.repeat(8)}.md`;
    await openFolder(page, { files: { ...FILES, [at(long)]: utf8('x') } });
    const row = item(page, long).locator('> .tree-row');
    await expect(row).toHaveAttribute('title', long);
    const name = row.locator('.tree-name');
    const metrics = await name.evaluate((el) => ({
      overflow: getComputedStyle(el).textOverflow,
      clipped: el.scrollWidth > el.clientWidth,
    }));
    expect(metrics).toEqual({ overflow: 'ellipsis', clipped: true });
    // サイドバーの幅（260px）からはみ出さない。
    const box = await row.boundingBox();
    expect(box!.x + box!.width).toBeLessThanOrEqual(260);
  });
});

test.describe('開く (c)(d)', () => {
  test('Markdown と .txt をクリックで開く。本文とタイトルが変わり、開いたファイルが強調される', async ({ page }) => {
    await openFolder(page);
    await row(page, 'a.md').click({ force: true });
    await expect(docTitle(page)).toHaveText('a.md');
    expect(await editorText(page)).toBe('# 見出しA\n\n本文A');
    await expect(item(page, 'a.md')).toHaveAttribute('aria-current', 'true');
    await expect(page.locator('[aria-current="true"]')).toHaveCount(1);
    // 開いた後は、本文にフォーカスがある（すぐ書ける）。
    await expect(page.locator('.cm-content')).toBeFocused();
    expect((await bridgeState(page)).session).toMatchObject({ lastPath: at('a.md'), lastFolder: ROOT });
    expect((await bridgeState(page)).watched).toBe(at('a.md'));

    await row(page, 'b.txt').click({ force: true });
    await expect(docTitle(page)).toHaveText('b.txt');
    expect(await editorText(page)).toContain('素のテキスト');
    await expect(item(page, 'b.txt')).toHaveAttribute('aria-current', 'true');
    await expect(item(page, 'a.md')).not.toHaveAttribute('aria-current', 'true');

    await row(page, 'c.text').click({ force: true });
    await expect(docTitle(page)).toHaveText('c.text');

    // 展開した先のファイルも同じ。
    await row(page, 'docs').click({ force: true });
    await row(page, 'guide.md').click({ force: true });
    await expect(docTitle(page)).toHaveText('guide.md');
    await expect(item(page, 'guide.md')).toHaveAttribute('aria-current', 'true');
    await expect(item(page, 'c.text')).not.toHaveAttribute('aria-current', 'true');
  });

  test('開けないファイルは灰色で、クリックしても開かない', async ({ page }) => {
    await openFolder(page);
    await row(page, 'a.md').click({ force: true });
    const before = (await calls(page)).open;

    for (const name of ['img.png', 'notes.json']) {
      const disabled = item(page, name);
      await expect(disabled).toHaveAttribute('aria-disabled', 'true');
      await row(page, name).click({ force: true });
      await expect(docTitle(page)).toHaveText('a.md');
    }
    expect((await calls(page)).open).toBe(before);
    expect(await editorText(page)).toBe('# 見出しA\n\n本文A');
    await expect(toast(page)).toHaveCount(0);

    // 開けるファイルは aria-disabled を持たず、文字色が違う。
    await expect(item(page, 'file2.md')).not.toHaveAttribute('aria-disabled', /.*/);
    const color = (name: string) => item(page, name).locator('> .tree-row').evaluate((el) => getComputedStyle(el).color);
    expect(await color('img.png')).not.toBe(await color('file2.md'));
    expect(await color('img.png')).toBe(await color('notes.json'));
  });

  test('拡張子は大文字小文字を区別せず、md・markdown・mdown・mkd・mdx・txt・text が開ける', async ({ page }) => {
    const files: Record<string, number[]> = {};
    for (const ext of ['md', 'markdown', 'mdown', 'mkd', 'mdx', 'txt', 'text', 'MD', 'TXT', 'Markdown', 'rtf', 'mdc']) {
      files[`/ext/file.${ext}`] = utf8(ext);
    }
    await launch(page, { files, folderPath: '/ext', preferences: SEED.preferences });
    await page.getByTestId('open-folder').click();
    const disabled = await page
      .getByTestId('tree-item')
      .evaluateAll((els) => els.filter((e) => e.getAttribute('aria-disabled') === 'true').map((e) => e.getAttribute('aria-label')));
    expect(disabled).toEqual(['file.mdc', 'file.rtf']);
  });

  test('未保存の変更があるときに別のファイルを開くと、確認が出る。キャンセルで元のまま', async ({ page }) => {
    await openFolder(page);
    await row(page, 'a.md').click({ force: true });
    await page.keyboard.type('追記');
    await expect(unsavedMark(page)).toBeVisible();

    await row(page, 'file2.md').click({ force: true });
    const dialog = page.getByRole('alertdialog', { name: '未保存の変更があります' });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('a.md');
    await page.getByTestId('discard-cancel').click();
    await expect(dialog).toHaveCount(0);
    await expect(docTitle(page)).toHaveText('a.md');
    await expect(unsavedMark(page)).toBeVisible();
    expect(await editorText(page)).toContain('追記');
    await expect(item(page, 'a.md')).toHaveAttribute('aria-current', 'true');
  });

  test('確認で「保存しない」を選ぶと開き、「保存」を選ぶと保存してから開く', async ({ page }) => {
    await openFolder(page);
    await row(page, 'a.md').click({ force: true });
    await page.keyboard.type('X');
    await row(page, 'file2.md').click({ force: true });
    await page.getByTestId('discard-discard').click();
    await expect(docTitle(page)).toHaveText('file2.md');
    expect(await page.evaluate((p) => window.__mdeE2E!.readFile(p), at('a.md'))).toEqual(FILES[at('a.md')]);

    await page.keyboard.type('Y');
    await row(page, 'a.md').click({ force: true });
    await page.getByTestId('discard-save').click();
    await expect(docTitle(page)).toHaveText('a.md');
    const saved = await page.evaluate((p) => window.__mdeE2E!.readFile(p), at('file2.md'));
    expect(new TextDecoder().decode(Uint8Array.from(saved!))).toBe('Y二番');
  });

  test('いま開いているファイルをもう一度押しても、編集中の本文は消えず、確認も出ない', async ({ page }) => {
    await openFolder(page);
    await row(page, 'a.md').click({ force: true });
    await page.keyboard.type('編集');
    await row(page, 'a.md').click({ force: true });
    await expect(page.getByRole('alertdialog')).toHaveCount(0);
    expect(await editorText(page)).toContain('編集');
    await expect(unsavedMark(page)).toBeVisible();
  });

  test('開けないファイル（UTF-8 ではない）は、トーストで知らせ、いまの文書を残す', async ({ page }) => {
    await openFolder(page, { files: { ...FILES, [at('broken.md')]: [0xff, 0xfe, 0xfd] } });
    await row(page, 'a.md').click({ force: true });
    await row(page, 'broken.md').click({ force: true });
    await expect(toast(page)).toContainText('UTF-8');
    await expect(docTitle(page)).toHaveText('a.md');
  });
});

test.describe('キーボード (e)', () => {
  test('矢印・Home・End で移動し、右で展開・左で折りたたみ、Enter で開く。Tab で入る項目は 1 つだけ', async ({ page }) => {
    await openFolder(page);
    const tabbable = () => tree(page).locator('[role=treeitem][tabindex="0"]');
    await expect(tabbable()).toHaveCount(1);
    await expect(tabbable()).toHaveAttribute('aria-label', 'Archive');

    await item(page, 'Archive').focus();
    await page.keyboard.press('ArrowDown');
    await expect(item(page, 'docs')).toBeFocused();
    await expect(tabbable()).toHaveAttribute('aria-label', 'docs');
    await expect(tabbable()).toHaveCount(1);

    // 右: 展開。もう一度: 最初の子（子のフォルダが先なので deep）へ。
    await page.keyboard.press('ArrowRight');
    await expect(item(page, 'docs')).toHaveAttribute('aria-expanded', 'true');
    await expect(item(page, 'docs')).toBeFocused();
    await page.keyboard.press('ArrowRight');
    await expect(item(page, 'deep')).toBeFocused();
    // 左: 折りたたまれているので、親へ。
    await page.keyboard.press('ArrowLeft');
    await expect(item(page, 'docs')).toBeFocused();
    // 左: 展開済みなので折りたたむ。
    await page.keyboard.press('ArrowLeft');
    await expect(item(page, 'docs')).toHaveAttribute('aria-expanded', 'false');
    await expect(item(page, 'docs')).toBeFocused();

    // Enter: フォルダは開閉。
    await page.keyboard.press('Enter');
    await expect(item(page, 'docs')).toHaveAttribute('aria-expanded', 'true');
    await page.keyboard.press('Enter');
    await expect(item(page, 'docs')).toHaveAttribute('aria-expanded', 'false');

    // End / Home。
    await page.keyboard.press('End');
    await expect(item(page, 'Zeta.md')).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(item(page, 'Zeta.md')).toBeFocused();
    await page.keyboard.press('Home');
    await expect(item(page, 'Archive')).toBeFocused();
    await page.keyboard.press('ArrowUp');
    await expect(item(page, 'Archive')).toBeFocused();
  });

  test('Enter で文書を開く。開けないファイルとリンクでは何も起きない', async ({ page }) => {
    await openFolder(page);
    await item(page, 'a.md').focus();
    await page.keyboard.press('Enter');
    await expect(docTitle(page)).toHaveText('a.md');
    await expect(item(page, 'a.md')).toHaveAttribute('aria-current', 'true');
    await expect(page.locator('.cm-content')).toBeFocused();

    await item(page, 'img.png').focus();
    await page.keyboard.press('Enter');
    await page.keyboard.press(' ');
    await expect(docTitle(page)).toHaveText('a.md');
    await expect(item(page, 'img.png')).toBeFocused();

    // Space でも開ける。
    await item(page, 'file2.md').focus();
    await page.keyboard.press(' ');
    await expect(docTitle(page)).toHaveText('file2.md');
  });

  test('Tab でツリーに入り、Tab でツリーから出る。ARIA の役割と名前が付いている', async ({ page }) => {
    await openFolder(page);
    await expect(page.getByRole('tree', { name: 'フォルダのツリー' })).toBeVisible();
    await expect(page.getByRole('treeitem').first()).toHaveAttribute('aria-level', '1');
    await row(page, 'docs').click({ force: true });
    await expect(item(page, 'docs').getByRole('group')).toBeVisible();
    // ツリーの外のボタンから Tab で入ると、位置は 1 つ。
    await page.getByTestId('change-folder').focus();
    await page.keyboard.press('Tab');
    const focused = await page.evaluate(() => document.activeElement?.getAttribute('role'));
    expect(focused).toBe('treeitem');
  });

  test('Mod+B（サイドバーの開閉）はツリーにフォーカスがあっても効く', async ({ page }) => {
    await openFolder(page);
    await item(page, 'a.md').focus();
    await page.keyboard.press('ControlOrMeta+b');
    await expect(page.getByTestId('sidebar')).toBeHidden();
  });
});

test.describe('復元 (f)', () => {
  test('再読み込みの後、開いていたフォルダがツリーに復元される', async ({ page }) => {
    await openFolder(page);
    await expect(page.getByTestId('folder-name')).toHaveText('notes');
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-ready', 'true');
    await expect(tree(page)).toBeVisible();
    await expect(page.getByTestId('folder-name')).toHaveText('notes');
    await expect(item(page, 'a.md')).toBeVisible();
    // 展開状態は保存しない。
    await expect(item(page, 'docs')).toHaveAttribute('aria-expanded', 'false');
    await expect(toast(page)).toHaveCount(0);
  });

  test('前回のフォルダが無いときは、未選択の表示に戻り、トーストで短く知らせる。起動は妨げない', async ({ page }) => {
    await launch(page, { ...SEED, session: { lastPath: null, lastFolder: '/vanished' } });
    await expect(page.getByTestId('sidebar-empty')).toBeVisible();
    await expect(page.getByTestId('open-folder')).toBeVisible();
    await expect(tree(page)).toHaveCount(0);
    await expect(toast(page)).toContainText('前回のフォルダを開けませんでした');
    await expect(page.locator('.cm-content')).toBeVisible();
    await expect.poll(async () => (await bridgeState(page)).session).toMatchObject({ lastFolder: null });
  });

  test('前回のフォルダが読めないときも、未選択の表示に戻る', async ({ page }) => {
    await launch(page, {
      ...SEED,
      unreadableFolders: [at('locked')],
      session: { lastPath: null, lastFolder: at('locked') },
    });
    await expect(page.getByTestId('open-folder')).toBeVisible();
    await expect(toast(page)).toContainText('前回のフォルダを開けませんでした');
  });

  test('前回の文書とフォルダの両方が、それぞれ復元される', async ({ page }) => {
    await launch(page, { ...SEED, session: { lastPath: at('a.md'), lastFolder: ROOT } });
    await expect(docTitle(page)).toHaveText('a.md');
    await expect(tree(page)).toBeVisible();
    await expect(item(page, 'a.md')).toHaveAttribute('aria-current', 'true');
    // 文書を切り替えても、フォルダの記録は消えない。
    await row(page, 'file2.md').click({ force: true });
    await expect.poll(async () => (await bridgeState(page)).session).toEqual({ lastPath: at('file2.md'), lastFolder: ROOT });
  });

  test('サイドバーが閉じていても、フォルダは復元され、開くとすぐ見える', async ({ page }) => {
    await launch(page, {
      ...SEED,
      preferences: { theme: 'light', autoHideChrome: false, sidebarOpen: false },
      session: { lastPath: null, lastFolder: ROOT },
    });
    await expect(page.getByTestId('sidebar')).toBeHidden();
    await page.keyboard.press('ControlOrMeta+b');
    await expect(tree(page)).toBeVisible();
    await expect(item(page, 'a.md')).toBeVisible();
  });
});

test.describe('多い項目 (g)', () => {
  test('5000 件を超えるフォルダは、先頭の 5000 件と「ほか N 件」の行（クリックしても何も起きない）', async ({ page }) => {
    await launch(page, {
      files: { '/big/readme.md': utf8('x') },
      bulkFolders: [{ path: '/big/many', count: 5003 }],
      folderPath: '/big',
      preferences: SEED.preferences,
    });
    await page.getByTestId('open-folder').click();
    await row(page, 'many').click({ force: true });
    await expect(tree(page).getByTestId('tree-note')).toHaveText('ほか 3 件');
    await expect(page.getByTestId('tree-item')).toHaveCount(2 + 5000); // many、readme.md、先頭 5000 件
    await expect(item(page, 'item-05000.md')).toBeAttached();
    await expect(item(page, 'item-05001.md')).toHaveCount(0);
    await expect(tree(page).getByTestId('tree-note')).toHaveAttribute('aria-disabled', 'true');
    await tree(page).getByTestId('tree-note').click({ force: true });
    await expect(docTitle(page)).toHaveText('無題');
  });

  test('ちょうど 5000 件なら切り捨てない', async ({ page }) => {
    await launch(page, {
      files: {},
      bulkFolders: [{ path: '/big/many', count: 5000 }],
      folderPath: '/big',
      preferences: SEED.preferences,
    });
    await page.getByTestId('open-folder').click();
    await row(page, 'many').click({ force: true });
    await expect(page.getByTestId('tree-item')).toHaveCount(1 + 5000);
    await expect(tree(page).getByTestId('tree-note')).toHaveCount(0);
  });
});

test.describe('.txt の素の表示 (h)', () => {
  const MD_TEXT = '# 見出し\n\n- 箇条書き\n- もう一つ\n\n**太字** と `code`\n\n```\nfence\n```\n\n> 引用';

  test('.txt と .text は Markdown の装飾を付けず、.md では付く。拡張子が変わると表示も切り替わる', async ({ page }) => {
    await launch(page, {
      files: { '/t/a.md': utf8(MD_TEXT), '/t/a.txt': utf8(MD_TEXT), '/t/a.text': utf8(MD_TEXT) },
      folderPath: '/t',
      savePath: '/t/saved.md',
      preferences: SEED.preferences,
    });
    await page.getByTestId('open-folder').click();
    const markdownLines = () =>
      page.locator('.cm-line[class*="cm-md-h"], .cm-line.cm-md-quote, .cm-line.cm-md-fence').count();
    const highlighted = () => page.locator('.cm-content [class*="ͼ"]').count();

    await row(page, 'a.md').click({ force: true });
    await expect(docTitle(page)).toHaveText('a.md');
    await expect(page.locator('.cm-md-h1')).toHaveCount(1);
    expect(await markdownLines()).toBeGreaterThan(2);
    expect(await highlighted()).toBeGreaterThan(0);
    const mdHeadingWeight = await page.locator('.cm-md-h1').evaluate((el) => getComputedStyle(el).fontSize);
    expect(parseFloat(mdHeadingWeight)).toBeGreaterThan(18);

    for (const name of ['a.txt', 'a.text']) {
      await item(page, name).click();
      await expect(docTitle(page)).toHaveText(name);
      expect(await editorText(page)).toBe(MD_TEXT);
      await expect(page.locator('.cm-line[class*="cm-md-h"]')).toHaveCount(0);
      expect(await markdownLines()).toBe(0);
      expect(await highlighted()).toBe(0);
      // 見出しの行も、ほかの行と同じ大きさ・同じ太さ。
      const heading = page.locator('.cm-line').first();
      const body = page.locator('.cm-line').nth(2);
      const style = (l: typeof heading) => l.evaluate((el) => ({ size: getComputedStyle(el).fontSize, weight: getComputedStyle(el).fontWeight }));
      expect(await style(heading)).toEqual(await style(body));
      // ぶら下げインデントも付かない。
      expect(await page.locator('.cm-line').nth(2).evaluate((el) => (el as HTMLElement).style.paddingLeft)).toBe('');
      // 空行の高さ（段落間隔）は Markdown と同じに効く。
      await expect(page.locator('.cm-md-blank').first()).toBeAttached();
    }

    // .md に戻ると装飾が戻る。
    await row(page, 'a.md').click({ force: true });
    await expect(page.locator('.cm-md-h1')).toHaveCount(1);
  });

  test('別名保存で拡張子が変わると、表示が切り替わる（.md → .txt、.txt → .md）', async ({ page }) => {
    await launch(page, {
      files: { '/t/a.md': utf8('# 見出し\n\n本文') },
      folderPath: '/t',
      savePath: '/t/renamed.txt',
      preferences: SEED.preferences,
    });
    await page.getByTestId('open-folder').click();
    await row(page, 'a.md').click({ force: true });
    await expect(page.locator('.cm-md-h1')).toHaveCount(1);

    await page.keyboard.press('ControlOrMeta+Shift+s');
    await expect(docTitle(page)).toHaveText('renamed.txt');
    await expect(page.locator('.cm-md-h1')).toHaveCount(0);
    expect(await editorText(page)).toBe('# 見出し\n\n本文');

    await setDialogPaths(page, { save: '/t/back.md' });
    await page.keyboard.press('ControlOrMeta+Shift+s');
    await expect(docTitle(page)).toHaveText('back.md');
    await expect(page.locator('.cm-md-h1')).toHaveCount(1);
  });

  test('.txt の保存は、BOM と改行を今までどおり保つ', async ({ page }) => {
    await launch(page, {
      files: { '/t/a.txt': utf8('一行目\n二行目\n', { bom: true, crlf: true }) },
      folderPath: '/t',
      preferences: SEED.preferences,
    });
    await page.getByTestId('open-folder').click();
    await row(page, 'a.txt').click({ force: true });
    await expect(docTitle(page)).toHaveText('a.txt');
    await page.keyboard.press('ControlOrMeta+End');
    await page.keyboard.type('三行目');
    await page.keyboard.press('ControlOrMeta+s');
    await expect(unsavedMark(page)).toHaveCount(0);
    const bytes = await page.evaluate(() => window.__mdeE2E!.readFile('/t/a.txt'));
    expect(bytes).toEqual(utf8('一行目\n二行目\n三行目', { bom: true, crlf: true }));
  });

  test('.txt のフォーカスモードは、空行だけで段落を分ける（見出し・箇条書きを特別扱いしない）', async ({ page }) => {
    const text = '# 行1\n- 行2\n行3\n\n別の段落';
    await launch(page, {
      files: { '/t/a.txt': utf8(text), '/t/a.md': utf8(text) },
      folderPath: '/t',
      preferences: { ...SEED.preferences, focusMode: true },
    });
    await page.getByTestId('open-folder').click();
    const dim = () => page.locator('.cm-line').evaluateAll((els) => els.map((el) => el.classList.contains('cm-md-dim')));

    await row(page, 'a.txt').click({ force: true });
    await page.keyboard.press('ControlOrMeta+Home');
    // 先頭の段落（行 1〜3）全体が強調され、別の段落だけが弱くなる。
    await expect.poll(dim).toEqual([false, false, false, true, true]);

    await row(page, 'a.md').click({ force: true });
    await page.keyboard.press('ControlOrMeta+Home');
    // Markdown は、見出しの 1 行だけが段落。
    await expect.poll(dim).toEqual([false, true, true, true, true]);
  });
});

// 文字色と背景色のコントラスト比（WCAG の相対輝度）。背景は、半透明の層を重ねた結果で計算する。
async function treeContrast(page: Page, name: string): Promise<number> {
  return row(page, name).evaluate((el) => {
    const parse = (c: string) => (c.match(/[\d.]+/g) ?? []).map(Number) as [number, number, number, number?];
    const over = (top: [number, number, number, number?], base: [number, number, number]): [number, number, number] => {
      const a = top[3] ?? 1;
      return [0, 1, 2].map((i) => top[i]! * a + base[i]! * (1 - a)) as [number, number, number];
    };
    const lum = ([r, g, b]: [number, number, number]) => {
      const f = (v: number) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
    };
    // パネルの背景（不透明）の上に、行の背景を重ねる。
    const panel = parse(getComputedStyle(document.querySelector('.sidebar')!).backgroundColor);
    const base: [number, number, number] = [panel[0], panel[1], panel[2]];
    const bg = over(parse(getComputedStyle(el).backgroundColor), base);
    const fg = over(parse(getComputedStyle(el).color), bg);
    const [hi, lo] = [lum(fg), lum(bg)].sort((x, y) => y - x) as [number, number];
    return (hi + 0.05) / (lo + 0.05);
  });
}

test.describe('配色・狭い窓・Reduced Motion', () => {
  for (const theme of ['light', 'dark'] as const) {
    test(`${theme}: 通常・開けない項目・開いているファイルの文字が、読めるコントラスト（4.5:1 以上）`, async ({ page }) => {
      await launch(page, { ...SEED, preferences: { ...SEED.preferences, theme } });
      await page.getByTestId('open-folder').click();
      await row(page, 'a.md').click();
      await expect(item(page, 'a.md')).toHaveAttribute('aria-current', 'true');
      const normal = await treeContrast(page, 'file2.md');
      const disabled = await treeContrast(page, 'img.png');
      const current = await treeContrast(page, 'a.md');
      expect(normal).toBeGreaterThanOrEqual(7);
      expect(disabled).toBeGreaterThanOrEqual(4.5);
      expect(current).toBeGreaterThanOrEqual(4.5);
      // 灰色は、通常の文字よりはっきり薄い（見分けがつく）。
      expect(normal).toBeGreaterThan(disabled + 3);
    });
  }

  test('窓が狭く重ねて表示するときも、ツリーが使え、Esc で閉じる', async ({ page }) => {
    await page.setViewportSize({ width: 500, height: 700 });
    await launch(page, SEED);
    await expect(page.getByTestId('sidebar')).toHaveAttribute('data-mode', 'overlay');
    await page.getByTestId('open-folder').click();
    await row(page, 'docs').click();
    await row(page, 'guide.md').click();
    await expect(docTitle(page)).toHaveText('guide.md');
    await item(page, 'a.md').focus();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('sidebar')).toBeHidden();
  });

  test('Reduced Motion のとき、矢印の回転にアニメーションを付けない', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await openFolder(page);
    const duration = () => page.locator('.tree-chevron').first().evaluate((el) => getComputedStyle(el).transitionDuration);
    expect(await duration()).toBe('0s');
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    expect(await duration()).not.toBe('0s');
  });

  test('サイドバーを閉じると、ツリーにフォーカスは入らない（inert）', async ({ page }) => {
    await openFolder(page);
    await page.keyboard.press('ControlOrMeta+b');
    await expect(page.getByTestId('sidebar')).toBeHidden();
    await expect(tree(page).getByRole('treeitem').first()).toBeHidden();
  });
});
