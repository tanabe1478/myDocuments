import { expect, type Page } from '@playwright/test';
import {
  bridgeState,
  conflictBar,
  docTitle,
  drafts,
  editorText,
  externalWrite,
  fileBytes,
  launch,
  setDialogPaths,
  test,
  toast,
  unsavedMark,
  utf8,
} from './helpers';

// Run 10: ツリーからの作成・名前の変更・ゴミ箱への移動、外部の変更の自動反映、前回のフォルダの再試行。
// メモリ bridge の結果は DocumentBridge の内側を差し替えたもの。ネイティブ側の規則は src-tauri/src/entries.rs の cargo test が正本。
test.describe.configure({ mode: 'parallel' });

const ROOT = '/work/notes';
const at = (rel: string) => `${ROOT}/${rel}`;

const FILES = {
  [at('a.md')]: utf8('# 見出しA\n\n本文A'),
  [at('b.txt')]: utf8('素のテキスト'),
  [at('c.md')]: utf8('C'),
  [at('docs/guide.md')]: utf8('# ガイド'),
  [at('docs/memo.md')]: utf8('メモ'),
};

const SEED = {
  files: FILES,
  folderPath: ROOT,
  emptyFolders: [at('empty')],
  preferences: { theme: 'light', autoHideChrome: false, sidebarOpen: true },
};

const tree = (page: Page) => page.getByTestId('file-tree');
const item = (page: Page, name: string) => tree(page).getByRole('treeitem', { name, exact: true });
const row = (page: Page, name: string) => item(page, name).locator('> .tree-row');
const nameInput = (page: Page) => page.getByTestId('tree-name-input');
const nameError = (page: Page) => page.getByTestId('tree-name-error');
const menu = (page: Page) => page.getByTestId('tree-context-menu');
const names = (page: Page) =>
  page.getByTestId('tree-item').evaluateAll((els) => els.map((el) => el.getAttribute('aria-label')));
const exists = (page: Page, path: string) => page.evaluate((p) => window.__mdeE2E!.files.has(p), path);
const fileCount = (page: Page) => page.evaluate(() => window.__mdeE2E!.files.size);
const mem = (page: Page) =>
  page.evaluate(() => ({
    trashed: [...window.__mdeE2E!.trashed],
    renames: [...window.__mdeE2E!.renames],
    watchedFolders: [...window.__mdeE2E!.watchedFolders],
    session: { ...window.__mdeE2E!.session },
  }));

async function openFolder(page: Page, seed: Record<string, unknown> = {}) {
  await launch(page, { ...SEED, ...seed });
  await page.getByTestId('open-folder').click();
  await expect(tree(page)).toBeVisible();
}

/** 名前を入力して Enter。 */
async function typeName(page: Page, name: string) {
  await expect(nameInput(page)).toBeFocused();
  await nameInput(page).fill(name);
  await page.keyboard.press('Enter');
}

/** 項目を右クリックして、メニューの項目を選ぶ。 */
async function viaMenu(page: Page, target: string | null, label: string) {
  if (target === null) {
    const area = page.getByTestId('explorer-tree-area');
    const box = (await area.boundingBox())!;
    await area.click({ button: 'right', position: { x: box.width / 2, y: box.height - 8 } });
  } else {
    await row(page, target).click({ button: 'right' });
  }
  await expect(menu(page)).toBeVisible();
  await menu(page).getByRole('menuitem', { name: label, exact: true }).click();
}

test.describe('作成 (a)', () => {
  test('ボタン: 新しいファイル。拡張子がなければ .md になり、作ったファイルが開く', async ({ page }) => {
    await openFolder(page);
    await expect(page.getByTestId('new-file')).toHaveAccessibleName('新しいファイル');
    await expect(page.getByTestId('new-file')).toHaveAttribute('title', '新しいファイル');
    await expect(page.getByTestId('new-folder')).toHaveAccessibleName('新しいフォルダ');

    await page.getByTestId('new-file').click();
    await expect(nameInput(page)).toBeFocused();
    await typeName(page, 'idea');

    await expect(nameInput(page)).toHaveCount(0);
    expect(await fileBytes(page, at('idea.md'))).toEqual([]);
    await expect(item(page, 'idea.md')).toBeVisible();
    await expect(docTitle(page)).toHaveText('idea.md');
    await expect(item(page, 'idea.md')).toHaveAttribute('aria-current', 'true');
    await expect(page.locator('.cm-content')).toBeFocused();
    expect((await bridgeState(page)).session).toMatchObject({ lastPath: at('idea.md') });
  });

  test('ボタン: 拡張子があればそのまま。新しいフォルダは展開して選択する（文書は開かない）', async ({ page }) => {
    await openFolder(page);
    await page.getByTestId('new-file').click();
    await typeName(page, 'plain.txt');
    await expect(docTitle(page)).toHaveText('plain.txt');
    expect(await exists(page, at('plain.txt'))).toBe(true);

    await page.getByTestId('new-folder').click();
    await typeName(page, 'ideas');
    await expect(item(page, 'ideas')).toHaveAttribute('aria-expanded', 'true');
    await expect(item(page, 'ideas')).toHaveAttribute('data-selected', 'true');
    await expect(docTitle(page)).toHaveText('plain.txt');
    // 空のフォルダなので、補足の行が出る。
    await expect(item(page, 'ideas').getByTestId('tree-note')).toHaveText('空のフォルダ');
  });

  test('作成先: 選択中のフォルダ、ファイルが選択中ならその親、何も選んでいなければルート。閉じていれば展開する', async ({ page }) => {
    await openFolder(page);
    // フォルダ（閉じている）を選んで作る。
    await row(page, 'docs').click();
    await row(page, 'docs').click(); // 閉じて、選択だけ残す
    await expect(item(page, 'docs')).toHaveAttribute('aria-expanded', 'false');
    await page.getByTestId('new-file').click();
    await expect(item(page, 'docs')).toHaveAttribute('aria-expanded', 'true');
    await expect(item(page, 'docs').getByTestId('tree-name-input')).toBeVisible();
    await typeName(page, 'child');
    await expect(docTitle(page)).toHaveText('child.md');
    expect(await exists(page, at('docs/child.md'))).toBe(true);

    // ファイルが選択中（開いた文書の child.md）なら、その親（docs）。
    await page.getByTestId('new-folder').click();
    await expect(item(page, 'docs').getByTestId('tree-name-input')).toBeVisible();
    await typeName(page, 'sub');
    expect(await exists(page, at('docs/sub'))).toBe(false); // 空のフォルダは files にない
    await expect(item(page, 'sub')).toBeVisible();
    expect((await names(page)).indexOf('sub')).toBeGreaterThan((await names(page)).indexOf('docs'));

    // 空き領域を押して選択を外すと、ルート。
    const area = page.getByTestId('explorer-tree-area');
    const box = (await area.boundingBox())!;
    await area.click({ position: { x: box.width / 2, y: box.height - 8 } });
    await page.getByTestId('new-file').click();
    await expect(tree(page).locator('> .tree-edit-row')).toBeVisible();
    await typeName(page, 'top');
    expect(await exists(page, at('top.md'))).toBe(true);
  });

  test('右クリック: 項目のメニューと、空き領域のメニューから作る', async ({ page }) => {
    await openFolder(page);
    await row(page, 'docs').click({ button: 'right' });
    await expect(menu(page)).toBeVisible();
    await expect(menu(page)).toHaveAttribute('role', 'menu');
    // 末尾の「パスをコピー」は、同梱の段 2 の部品（本番と同じ構成で入る）の項目。
    await expect(menu(page).getByRole('menuitem')).toHaveText(['新しいファイル', '新しいフォルダ', '名前を変更', 'ゴミ箱に移動', 'パスをコピー']);
    await menu(page).getByRole('menuitem', { name: '新しいフォルダ' }).click();
    await expect(menu(page)).toHaveCount(0);
    await typeName(page, 'viaMenu');
    await expect(item(page, 'viaMenu')).toBeVisible();

    // 空き領域: 作成だけ。作成先はルート。
    const area = page.getByTestId('explorer-tree-area');
    const box = (await area.boundingBox())!;
    await area.click({ button: 'right', position: { x: box.width / 2, y: box.height - 8 } });
    await expect(menu(page).getByRole('menuitem')).toHaveText(['新しいファイル', '新しいフォルダ']);
    await menu(page).getByRole('menuitem', { name: '新しいファイル' }).click();
    await typeName(page, 'rootfile');
    expect(await exists(page, at('rootfile.md'))).toBe(true);
    await expect(docTitle(page)).toHaveText('rootfile.md');
  });

  test('キーボード: ボタンを Enter で押す。メニューキー（Shift+F10）から矢印と Enter で選ぶ。Esc で閉じる', async ({ page }) => {
    await openFolder(page);
    await page.getByTestId('new-file').focus();
    await page.keyboard.press('Enter');
    await expect(nameInput(page)).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(nameInput(page)).toHaveCount(0);
    expect(await fileCount(page)).toBe(Object.keys(FILES).length);

    await page.getByTestId('new-folder').focus();
    await page.keyboard.press('Space');
    await typeName(page, 'kbfolder');
    await expect(item(page, 'kbfolder')).toBeVisible();

    // ツリーの項目からメニューを開く。最初の項目にフォーカスが移り、矢印で動く。
    await item(page, 'a.md').focus();
    await page.keyboard.press('Shift+F10');
    await expect(menu(page)).toBeVisible();
    await expect(menu(page).getByRole('menuitem', { name: '新しいファイル' })).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(menu(page).getByRole('menuitem', { name: '新しいフォルダ' })).toBeFocused();
    await page.keyboard.press('End');
    // 末尾は、同梱の段 2 の部品の項目「パスをコピー」（本番と同じ構成で入る）。
    await expect(menu(page).getByRole('menuitem', { name: 'パスをコピー' })).toBeFocused();
    await page.keyboard.press('ArrowUp');
    await expect(menu(page).getByRole('menuitem', { name: 'ゴミ箱に移動' })).toBeFocused();
    await page.keyboard.press('ArrowUp');
    await expect(menu(page).getByRole('menuitem', { name: '名前を変更' })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(menu(page)).toHaveCount(0);
    await expect(item(page, 'a.md')).toBeFocused();

    await page.keyboard.press('Shift+F10');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await typeName(page, 'viaKeys');
    await expect(item(page, 'viaKeys')).toBeVisible();
  });

  test('Esc は取り消し。フォーカスが外れたとき、有効な名前なら確定、空なら取り消し', async ({ page }) => {
    await openFolder(page);
    await row(page, 'c.md').click();
    await item(page, 'c.md').focus();
    await page.getByTestId('new-file').click();
    await nameInput(page).fill('typed');
    await page.keyboard.press('Escape');
    await expect(nameInput(page)).toHaveCount(0);
    expect(await exists(page, at('typed.md'))).toBe(false);
    // 取り消した後は、ツリーの選択へフォーカスが戻る。
    await expect(item(page, 'c.md')).toBeFocused();
    // 選択を外して（空き領域を押して）作る。
    const area = page.getByTestId('explorer-tree-area');
    const box = (await area.boundingBox())!;
    await area.click({ position: { x: box.width / 2, y: box.height - 8 } });

    await page.getByTestId('new-file').click();
    await nameInput(page).fill('   ');
    await page.getByTestId('refresh-folder').focus();
    await expect(nameInput(page)).toHaveCount(0);
    expect(await fileCount(page)).toBe(Object.keys(FILES).length);

    await page.getByTestId('new-file').click();
    await nameInput(page).fill('blurred');
    await page.getByTestId('refresh-folder').focus();
    await expect(nameInput(page)).toHaveCount(0);
    expect(await exists(page, at('blurred.md'))).toBe(true);
    await expect(docTitle(page)).toHaveText('blurred.md');
  });

  test('未保存の変更がある文書を開いているとき、作ったファイルを開く前に確認が出る（キャンセルで元のまま）', async ({ page }) => {
    await openFolder(page);
    await row(page, 'a.md').click();
    await page.locator('.cm-content').click();
    await page.keyboard.type('編集');
    await page.getByTestId('new-file').click();
    await typeName(page, 'second');
    await expect(page.getByRole('alertdialog')).toBeVisible();
    await page.getByTestId('discard-cancel').click();
    await expect(docTitle(page)).toHaveText('a.md');
    await expect(unsavedMark(page)).toBeVisible();
    // ファイルは作られている。
    expect(await exists(page, at('second.md'))).toBe(true);
    await expect(item(page, 'second.md')).toBeVisible();
  });
});

test.describe('名前の検査 (b)', () => {
  const BAD = ['', '   ', 'a/b', 'a\\b', '.', '..', '.hidden', 'a:b', 'a<b', 'a|b', 'a?b', 'a*b', 'a.', 'a '];

  test('不正な名前は拒否し、入力欄を残して理由を出す。何も作られない', async ({ page }) => {
    await openFolder(page);
    const before = await fileCount(page);
    await page.getByTestId('new-file').click();
    for (const bad of BAD) {
      await nameInput(page).fill(bad);
      await page.keyboard.press('Enter');
      await expect(nameInput(page)).toBeVisible();
      await expect(nameInput(page)).toHaveAttribute('aria-invalid', 'true');
      await expect(nameError(page)).toBeVisible();
      await expect(nameError(page)).not.toHaveText('');
      const describedBy = await nameInput(page).getAttribute('aria-describedby');
      expect(describedBy).toBe(await nameError(page).getAttribute('id'));
      // 理由は入力欄の近く（直下）にある。
      const input = (await nameInput(page).boundingBox())!;
      const error = (await nameError(page).boundingBox())!;
      expect(error.y).toBeGreaterThanOrEqual(input.y + input.height - 1);
      expect(error.y - (input.y + input.height)).toBeLessThan(12);
    }
    expect(await fileCount(page)).toBe(before);
    await expect(docTitle(page)).toHaveText('無題');

    // 打ち直すと理由は消え、有効な名前なら作れる。
    await nameInput(page).fill('valid');
    await expect(nameError(page)).toHaveCount(0);
    await expect(nameInput(page)).not.toHaveAttribute('aria-invalid', 'true');
    await page.keyboard.press('Enter');
    await expect(docTitle(page)).toHaveText('valid.md');
  });

  test('同じ名前（拡張子を足した後の名前、フォルダ名を含む）は拒否する。大文字小文字だけ違う名前も作らない', async ({ page }) => {
    await openFolder(page);
    const before = await fileCount(page);
    await page.getByTestId('new-file').click();
    for (const dup of ['a.md', 'a']) {
      await nameInput(page).fill(dup);
      await page.keyboard.press('Enter');
      await expect(nameError(page)).toContainText('同じ名前');
    }
    // 大文字小文字だけの違いは、ファイルシステムの判断（メモリ bridge は区別しない FS）。入力欄を残して理由を出す。
    await nameInput(page).fill('A.MD');
    await page.keyboard.press('Enter');
    await expect(nameError(page)).toContainText('同じ名前');
    await expect(nameInput(page)).toBeVisible();
    expect(await fileCount(page)).toBe(before);

    await page.keyboard.press('Escape');
    // フォルダは拡張子を足さない。フォルダ名と同じ名前は拒否する。
    await page.getByTestId('new-folder').click();
    for (const dup of ['docs', 'DOCS', 'a.md']) {
      await nameInput(page).fill(dup);
      await page.keyboard.press('Enter');
      await expect(nameError(page)).toContainText('同じ名前');
    }
    expect(await fileCount(page)).toBe(before);
  });

  test('IME の変換中の Enter では確定しない（isComposing、keyCode 229）。変換が終われば確定する', async ({ page }) => {
    await openFolder(page);
    await page.getByTestId('new-file').click();
    await nameInput(page).fill('にほんご');
    await nameInput(page).evaluate((el) => {
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, isComposing: true }));
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 229, bubbles: true, cancelable: true }));
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true, isComposing: true }));
    });
    await expect(nameInput(page)).toBeVisible();
    expect(await exists(page, at('にほんご.md'))).toBe(false);
    await page.keyboard.press('Enter');
    await expect(docTitle(page)).toHaveText('にほんご.md');
    expect(await exists(page, at('にほんご.md'))).toBe(true);
  });
});

test.describe('名前の変更 (c)', () => {
  test('F2: 拡張子の前まで選択された入力欄が出て、変更できる。展開状態と選択は引き継ぐ', async ({ page }) => {
    await openFolder(page);
    await item(page, 'a.md').focus();
    await page.keyboard.press('F2');
    await expect(nameInput(page)).toBeFocused();
    await expect(nameInput(page)).toHaveValue('a.md');
    expect(await nameInput(page).evaluate((el: HTMLInputElement) => [el.selectionStart, el.selectionEnd])).toEqual([0, 1]);
    await typeName(page, 'renamed.md');
    await expect(item(page, 'renamed.md')).toBeVisible();
    await expect(item(page, 'a.md')).toHaveCount(0);
    await expect(item(page, 'renamed.md')).toHaveAttribute('data-selected', 'true');
    expect(await exists(page, at('a.md'))).toBe(false);
    expect((await fileBytes(page, at('renamed.md')))?.length).toBeGreaterThan(0);
    await expect(item(page, 'renamed.md')).toBeFocused();
  });

  test('右クリックの「名前を変更」。フォルダの名前を変えると、展開と中の選択が新しいパスへ移る', async ({ page }) => {
    await openFolder(page);
    await row(page, 'docs').click();
    await row(page, 'guide.md').click();
    await expect(docTitle(page)).toHaveText('guide.md');
    await viaMenu(page, 'docs', '名前を変更');
    expect(await nameInput(page).evaluate((el: HTMLInputElement) => [el.selectionStart, el.selectionEnd])).toEqual([0, 4]);
    await typeName(page, 'manuscripts');
    await expect(item(page, 'manuscripts')).toHaveAttribute('aria-expanded', 'true');
    await expect(item(page, 'guide.md')).toBeVisible();
    expect(await exists(page, at('manuscripts/guide.md'))).toBe(true);
    expect(await exists(page, at('docs/guide.md'))).toBe(false);
  });

  test('自分自身の名前・大文字小文字だけの変更は通り、ほかの項目と同じ名前は拒否する。取り消せる', async ({ page }) => {
    await openFolder(page);
    await item(page, 'c.md').focus();
    await page.keyboard.press('F2');
    await nameInput(page).fill('a.md');
    await page.keyboard.press('Enter');
    await expect(nameError(page)).toContainText('同じ名前');
    await nameInput(page).fill('C.md');
    await page.keyboard.press('Enter');
    await expect(item(page, 'C.md')).toBeVisible();
    expect((await mem(page)).renames).toEqual([{ from: at('c.md'), to: at('C.md') }]);

    await item(page, 'C.md').focus();
    await page.keyboard.press('F2');
    await page.keyboard.press('Enter'); // そのまま確定: 何も変わらない
    await expect(nameInput(page)).toHaveCount(0);
    expect((await mem(page)).renames).toHaveLength(1);

    await item(page, 'C.md').focus();
    await page.keyboard.press('F2');
    await nameInput(page).fill('zzz.md');
    await page.keyboard.press('Escape');
    await expect(item(page, 'C.md')).toBeVisible();
    expect((await mem(page)).renames).toHaveLength(1);
  });

  test('開いている文書（未保存の変更あり）の名前を変えても、本文と未保存の状態が残り、保存先が新しいパスになる', async ({ page }) => {
    await openFolder(page);
    await row(page, 'a.md').click();
    await page.locator('.cm-content').click();
    await page.keyboard.press('ControlOrMeta+End');
    await page.keyboard.type('追記した行');
    await expect(unsavedMark(page)).toBeVisible();
    const textBefore = await editorText(page);

    await item(page, 'a.md').focus();
    await page.keyboard.press('F2');
    await typeName(page, 'renamed.md');

    await expect(docTitle(page)).toHaveText('renamed.md');
    await expect(unsavedMark(page)).toBeVisible();
    expect(await editorText(page)).toBe(textBefore);
    await expect(item(page, 'renamed.md')).toHaveAttribute('aria-current', 'true');
    await expect(conflictBar(page)).toHaveCount(0);
    await expect(page.getByText('ファイルが削除されました')).toHaveCount(0);
    // 監視、前回の文書、草稿が新しいパスへ移る。
    await expect.poll(async () => (await bridgeState(page)).watched).toBe(at('renamed.md'));
    expect((await bridgeState(page)).session).toMatchObject({ lastPath: at('renamed.md') });
    await expect.poll(async () => (await drafts(page)).map((d) => d.path)).toEqual([at('renamed.md')]);

    // 古いパスの通知は届かない（監視が外れている）。外部の確認も古いパスでは起きない。
    await page.evaluate((p) => window.__mdeE2E!.emitDocumentChanged(p), at('a.md'));
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(conflictBar(page)).toHaveCount(0);

    // 保存すると新しいパスに書かれる。
    await page.locator('.cm-content').click();
    await page.keyboard.press('ControlOrMeta+s');
    await expect(unsavedMark(page)).toHaveCount(0);
    const saved = new TextDecoder().decode(Uint8Array.from((await fileBytes(page, at('renamed.md')))!));
    expect(saved).toContain('追記した行');
    expect(await exists(page, at('a.md'))).toBe(false);
  });

  test('開いている文書を含むフォルダの名前を変えても同じ', async ({ page }) => {
    await openFolder(page);
    await row(page, 'docs').click();
    await row(page, 'guide.md').click();
    await page.locator('.cm-content').click();
    await page.keyboard.press('ControlOrMeta+End');
    await page.keyboard.type('!!');
    const textBefore = await editorText(page);

    await item(page, 'docs').focus();
    await page.keyboard.press('F2');
    await typeName(page, 'manuscripts');

    await expect(docTitle(page)).toHaveText('guide.md');
    await expect(unsavedMark(page)).toBeVisible();
    expect(await editorText(page)).toBe(textBefore);
    await expect(item(page, 'guide.md')).toHaveAttribute('aria-current', 'true');
    await expect.poll(async () => (await bridgeState(page)).watched).toBe(at('manuscripts/guide.md'));
    expect((await bridgeState(page)).session).toMatchObject({ lastPath: at('manuscripts/guide.md') });
    await expect(conflictBar(page)).toHaveCount(0);

    await page.locator('.cm-content').click();
    await page.keyboard.press('ControlOrMeta+s');
    await expect(unsavedMark(page)).toHaveCount(0);
    expect(new TextDecoder().decode(Uint8Array.from((await fileBytes(page, at('manuscripts/guide.md')))!))).toContain('!!');
    expect(await exists(page, at('docs/guide.md'))).toBe(false);
  });

  test('名前の変更が失敗したら、文書は古いパスのまま（監視も戻る）', async ({ page }) => {
    await openFolder(page);
    await row(page, 'a.md').click();
    await page.locator('.cm-content').click();
    await page.keyboard.type('x');
    await item(page, 'a.md').focus();
    await page.keyboard.press('F2');
    await nameInput(page).fill('b.txt');
    await page.keyboard.press('Enter');
    await expect(nameError(page)).toContainText('同じ名前');
    await expect(docTitle(page)).toHaveText('a.md');
    await expect(unsavedMark(page)).toBeVisible();
    expect((await bridgeState(page)).watched).toBe(at('a.md'));
    expect((await mem(page)).renames).toEqual([]);
  });
});

test.describe('ゴミ箱 (d)', () => {
  test('Delete: 毎回確認が出る。既定のフォーカスはキャンセルで、Esc でも取り消せる。確定するとツリーから消え、選択が隣へ移る', async ({ page }) => {
    await openFolder(page);
    await item(page, 'b.txt').focus();
    await page.keyboard.press('Delete');
    const dialog = page.getByTestId('confirm-trash');
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveAttribute('role', 'alertdialog');
    await expect(dialog).toContainText('"b.txt" をゴミ箱に移動しますか？');
    await expect(page.getByTestId('trash-cancel')).toBeFocused();
    await expect(page.getByTestId('trash-ok')).toHaveText('ゴミ箱に移動');

    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(item(page, 'b.txt')).toBeVisible();
    expect((await mem(page)).trashed).toEqual([]);
    await expect(item(page, 'b.txt')).toBeFocused();

    await page.keyboard.press('Delete');
    await page.getByTestId('trash-cancel').click();
    expect((await mem(page)).trashed).toEqual([]);

    await page.keyboard.press('Delete');
    await page.getByTestId('trash-ok').click();
    await expect(item(page, 'b.txt')).toHaveCount(0);
    expect((await mem(page)).trashed).toEqual([at('b.txt')]);
    expect(await exists(page, at('b.txt'))).toBe(false);
    // 隣の項目（次の c.md）へ選択が移り、フォーカスもそこにある。
    await expect(item(page, 'c.md')).toHaveAttribute('data-selected', 'true');
    await expect(item(page, 'c.md')).toBeFocused();
  });

  test('macOS は ⌘⌫ でも。ほかの OS では Ctrl+Backspace では何も起きない', async ({ page, platform }) => {
    await openFolder(page);
    await item(page, 'c.md').focus();
    await page.keyboard.press(platform === 'mac' ? 'Control+Backspace' : 'Meta+Backspace');
    await expect(page.getByTestId('confirm-trash')).toHaveCount(0);
    await page.keyboard.press('ControlOrMeta+Backspace');
    if (platform === 'mac') {
      await expect(page.getByTestId('confirm-trash')).toBeVisible();
      await page.getByTestId('trash-cancel').click();
    } else {
      await expect(page.getByTestId('confirm-trash')).toHaveCount(0);
    }
    expect((await mem(page)).trashed).toEqual([]);
  });

  test('右クリックの「ゴミ箱に移動」。フォルダは中身ごと移すと確認の文言が変わる', async ({ page }) => {
    await openFolder(page);
    await viaMenu(page, 'docs', 'ゴミ箱に移動');
    await expect(page.getByTestId('confirm-trash')).toContainText('フォルダ "docs" とその中身をゴミ箱に移動しますか？');
    await page.getByTestId('trash-ok').click();
    await expect(item(page, 'docs')).toHaveCount(0);
    expect((await mem(page)).trashed).toEqual([at('docs')]);
    expect(await exists(page, at('docs/guide.md'))).toBe(false);
  });

  test('開いている文書を移すと、未保存の変更がなければ「削除された」の表示になる', async ({ page }) => {
    await openFolder(page);
    await row(page, 'a.md').click();
    await expect(docTitle(page)).toHaveText('a.md');
    await item(page, 'a.md').focus();
    await page.keyboard.press('Delete');
    await page.getByTestId('trash-ok').click();
    await expect(item(page, 'a.md')).toHaveCount(0);
    // 監視の通知は待たない（メモリ bridge は通知を送っていない）。
    await expect(toast(page)).toContainText('ファイルが削除されました');
    await expect(conflictBar(page)).toBeVisible();
    await expect(conflictBar(page)).toContainText('削除');
    await expect(unsavedMark(page)).toHaveCount(0);
  });

  test('開いている文書を含むフォルダを移すと、未保存の変更があれば競合バーが出て、本文は残る', async ({ page }) => {
    await openFolder(page);
    await row(page, 'docs').click();
    await row(page, 'guide.md').click();
    await page.locator('.cm-content').click();
    await page.keyboard.press('ControlOrMeta+End');
    await page.keyboard.type('未保存の行');
    const text = await editorText(page);
    await viaMenu(page, 'docs', 'ゴミ箱に移動');
    await page.getByTestId('trash-ok').click();
    await expect(item(page, 'docs')).toHaveCount(0);
    await expect(conflictBar(page)).toBeVisible();
    await expect(unsavedMark(page)).toBeVisible();
    expect(await editorText(page)).toBe(text);
  });

  test('移せなかったときは、何も変えずにトーストで知らせる（開いたフォルダ自身は移せない）', async ({ page }) => {
    await openFolder(page);
    await page.evaluate(() => {
      const bridge = window.__mdeE2E!;
      bridge.files.delete('/work/notes/c.md');
    });
    // ツリーの表示が古いまま、すでに無い項目を移そうとする。
    await item(page, 'c.md').focus();
    await page.keyboard.press('Delete');
    await page.getByTestId('trash-ok').click();
    await expect(toast(page)).toContainText('ゴミ箱に移せませんでした');
    await expect(toast(page)).toContainText('見つかりません');
  });
});

test.describe('外部の変更の自動反映 (e)', () => {
  test('外部でファイルやフォルダを足す・消すと、操作しなくてもツリーに反映され、展開状態が保たれる', async ({ page }) => {
    await openFolder(page);
    await row(page, 'docs').click();
    await expect(item(page, 'guide.md')).toBeVisible();
    // 監視はルートと展開中のフォルダだけ。
    await expect.poll(async () => (await mem(page)).watchedFolders).toEqual([ROOT, at('docs')]);

    await externalWrite(page, at('external.md'), '外から');
    await expect(item(page, 'external.md')).toBeVisible();
    await externalWrite(page, at('docs/inside.md'), '中');
    await expect(item(page, 'inside.md')).toBeVisible();
    await expect(item(page, 'docs')).toHaveAttribute('aria-expanded', 'true');

    await externalWrite(page, at('c.md'), null);
    await expect(item(page, 'c.md')).toHaveCount(0);
    await externalWrite(page, at('docs/memo.md'), null);
    await expect(item(page, 'memo.md')).toHaveCount(0);
    await expect(item(page, 'docs')).toHaveAttribute('aria-expanded', 'true');

    await page.evaluate(() => window.__mdeE2E!.externalMkdir('/work/notes/newdir'));
    await expect(item(page, 'newdir')).toBeVisible();
    await page.evaluate(() => window.__mdeE2E!.externalRemove('/work/notes/newdir'));
    await expect(item(page, 'newdir')).toHaveCount(0);
    await expect(toast(page)).toHaveCount(0);
  });

  test('選択は保たれ、展開中のフォルダが外部で消えたら、展開をやめる。監視も外れる', async ({ page }) => {
    await openFolder(page);
    await row(page, 'docs').click();
    await row(page, 'memo.md').click();
    await expect(item(page, 'memo.md')).toHaveAttribute('data-selected', 'true');
    await externalWrite(page, at('zzz.md'), 'z');
    await expect(item(page, 'zzz.md')).toBeVisible();
    await expect(item(page, 'memo.md')).toHaveAttribute('data-selected', 'true');

    await page.evaluate(() => window.__mdeE2E!.externalRemove('/work/notes/docs'));
    await expect(item(page, 'docs')).toHaveCount(0);
    await expect.poll(async () => (await mem(page)).watchedFolders).toEqual([ROOT]);
  });

  test('折りたたんだフォルダの中の変更は、展開したときに新しく読む。自分の操作の後も一覧が更新される', async ({ page }) => {
    await openFolder(page);
    await externalWrite(page, at('docs/late.md'), 'late');
    await row(page, 'docs').click();
    await expect(item(page, 'late.md')).toBeVisible();

    await page.getByTestId('new-file').click();
    await typeName(page, 'mine');
    await expect(item(page, 'mine.md')).toBeVisible();
  });
});

test.describe('前回のフォルダを開けないとき (f)', () => {
  const GONE = '/gone/notes';

  test('記録を消さず、サイドバーに理由と再試行を出す。開けるようになった後の再試行でツリーが出る', async ({ page }) => {
    await launch(page, { ...SEED, files: {}, session: { lastPath: null, lastFolder: GONE } });
    await expect(page.getByTestId('restore-failure')).toContainText('前回のフォルダ「notes」を開けませんでした');
    await expect(page.getByTestId('restore-failure')).toContainText('見つかりません');
    await expect(page.getByTestId('retry-folder')).toBeVisible();
    await expect(page.getByTestId('open-folder')).toBeVisible();
    await expect(toast(page)).toContainText('前回のフォルダを開けませんでした');
    expect((await mem(page)).session).toMatchObject({ lastFolder: GONE });

    // まだ開けない: 記録は残り、再試行はまた理由を出す。
    await page.getByTestId('retry-folder').click();
    await expect(page.getByTestId('restore-failure')).toBeVisible();
    expect((await mem(page)).session).toMatchObject({ lastFolder: GONE });

    // 再読み込み（次回の起動）でも記録は残っている。
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-ready', 'true');
    await expect(page.getByTestId('retry-folder')).toBeVisible();

    // 開けるようになった（ドライブがつながった）後の再試行。
    await externalWrite(page, `${GONE}/back.md`, '戻った');
    await page.getByTestId('retry-folder').click();
    await expect(tree(page)).toBeVisible();
    await expect(item(page, 'back.md')).toBeVisible();
    await expect(page.getByTestId('folder-name')).toHaveText('notes');
    await expect(page.getByTestId('restore-failure')).toHaveCount(0);
    await expect(page.getByTestId('retry-folder')).toHaveCount(0);
    expect((await mem(page)).session).toMatchObject({ lastFolder: GONE });
  });

  test('別のフォルダを開けば、その記録で上書きする', async ({ page }) => {
    await launch(page, { ...SEED, session: { lastPath: null, lastFolder: '/gone/notes' } });
    await expect(page.getByTestId('retry-folder')).toBeVisible();
    await setDialogPaths(page, { folder: ROOT });
    await page.getByTestId('open-folder').click();
    await expect(tree(page)).toBeVisible();
    await expect(page.getByTestId('retry-folder')).toHaveCount(0);
    expect((await mem(page)).session).toMatchObject({ lastFolder: ROOT });
  });

  test('開けないフォルダを選んでも、前回の記録と再試行は残る', async ({ page }) => {
    await launch(page, { ...SEED, session: { lastPath: null, lastFolder: '/gone/notes' } });
    await setDialogPaths(page, { folder: '/nowhere' });
    await page.getByTestId('open-folder').click();
    await expect(toast(page)).toContainText('フォルダを開けませんでした');
    await expect(page.getByTestId('retry-folder')).toBeVisible();
    expect((await mem(page)).session).toMatchObject({ lastFolder: '/gone/notes' });
  });
});
