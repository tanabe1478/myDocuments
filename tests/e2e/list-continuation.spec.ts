import { expect, type CDPSession, type Page } from '@playwright/test';
import { docTitle, fileBytes, launch, test, unsavedMark, utf8 } from './helpers';

// Run 11: リストの項目で Enter を押して次の項目を続けるとき、項目の間に空行のあるリスト（loose list）でも
// 空行を入れない（既定）。設定画面の「編集」の節で「リストの形に合わせる」に変えると、空行を入れる。

test.describe.configure({ mode: 'parallel' });

const DOC = '/docs/list.md';
const LOOSE = '大規模処理\n- パッチ\n  - Batches\n  - 他にも\n\n\n\n- temperature について';

const dialog = (page: Page) => page.getByRole('dialog', { name: '設定' });
const savedPreferences = (page: Page) => page.evaluate(() => window.__mdeE2E!.savedPreferences.at(-1) as Record<string, unknown> | undefined);
const text = (page: Page) => page.evaluate(() => window.__mdeE2E!.editor!.getText());

async function launchWith(page: Page, body: string, preferences: Record<string, unknown> = {}): Promise<void> {
  await launch(page, { files: { [DOC]: utf8(body) }, openPath: DOC, preferences: { theme: 'light', ...preferences } });
  await page.keyboard.press('ControlOrMeta+o');
  await expect(docTitle(page)).toHaveText('list.md');
}

/** 本文の末尾にカーソルを置いて Enter を押す。 */
async function enterAtEnd(page: Page): Promise<void> {
  await page.locator('.cm-content').click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.press('Enter');
}

async function setListContinuation(page: Page, label: '空行を入れない' | 'リストの形に合わせる'): Promise<void> {
  // 入力中は上部バーが自動で隠れるので、ボタンではなくショートカットで開く。
  await page.keyboard.press('ControlOrMeta+,');
  await expect(dialog(page)).toBeVisible();
  await dialog(page).getByTestId('settings-editing').getByRole('radio', { name: label }).check();
  await page.keyboard.press('Escape');
  await expect(dialog(page)).toHaveCount(0);
}

test.describe('リストの継続 (Run 11)', () => {
  test('(a) 既定では、loose list の末尾で Enter を押しても空行が入らず、続けて書いた文字が新しい項目に入る（保存される）', async ({ page }) => {
    await launchWith(page, LOOSE);
    await enterAtEnd(page);
    expect(await text(page)).toBe(`${LOOSE}\n- `);
    await page.keyboard.type('次の項目');
    expect(await text(page)).toBe(`${LOOSE}\n- 次の項目`);

    await page.keyboard.press('ControlOrMeta+s');
    await expect(unsavedMark(page)).toHaveCount(0);
    expect(await fileBytes(page, DOC)).toEqual(utf8(`${LOOSE}\n- 次の項目`));
  });

  test('(a) 番号付き・タスク・入れ子・引用の中も、空行を入れずに続ける。空の項目で Enter を押すとリストを終える', async ({ page }) => {
    await launchWith(page, '');
    await page.locator('.cm-content').click();
    // 番号付きの loose list。
    await page.keyboard.insertText('1. a\n\n2. b');
    await page.keyboard.press('Enter');
    expect(await text(page)).toBe('1. a\n\n2. b\n3. ');
    // 空の項目で Enter: リストを終える（番号は消える）。
    await page.keyboard.press('Enter');
    expect(await text(page)).toBe('1. a\n\n2. b\n');

    await page.keyboard.press('ControlOrMeta+a');
    await page.keyboard.insertText('- [x] a\n\n- [ ] b');
    await page.keyboard.press('Enter');
    expect(await text(page)).toBe('- [x] a\n\n- [ ] b\n- [ ] ');

    await page.keyboard.press('ControlOrMeta+a');
    await page.keyboard.insertText('- a\n  - b\n\n  - c');
    await page.keyboard.press('Enter');
    expect(await text(page)).toBe('- a\n  - b\n\n  - c\n  - ');

    await page.keyboard.press('ControlOrMeta+a');
    await page.keyboard.insertText('> - a\n>\n> - b');
    await page.keyboard.press('Enter');
    expect(await text(page)).toBe('> - a\n>\n> - b\n> - ');
  });

  test('(a) 項目の途中で Enter を押すと、後半が次の項目になる', async ({ page }) => {
    await launchWith(page, '- a\n\n- bbcc\n\n- d');
    await page.locator('.cm-content').click();
    await page.keyboard.press('ControlOrMeta+Home');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('End');
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('Enter');
    expect(await text(page)).toBe('- a\n\n- bb\n- cc\n\n- d');
  });

  test('Undo 1 回で Enter の前に戻る', async ({ page }) => {
    await launchWith(page, LOOSE);
    await enterAtEnd(page);
    expect(await text(page)).toBe(`${LOOSE}\n- `);
    await page.keyboard.press('ControlOrMeta+z');
    expect(await text(page)).toBe(LOOSE);
  });

  test('(b)(c) 設定画面の「編集」で「リストの形に合わせる」に変えると空行が入り、戻すとすぐ入らなくなる。再読み込み後も保たれる', async ({ page }) => {
    await launchWith(page, LOOSE);

    // 「編集」の節は「外観」の後にあり、既定は「空行を入れない」。
    await page.keyboard.press('ControlOrMeta+,');
    const sections = dialog(page).locator('.settings-section h3');
    await expect(sections).toHaveText(['外観', '編集']);
    const editing = dialog(page).getByTestId('settings-editing');
    await expect(editing.getByRole('radio', { name: '空行を入れない' })).toBeChecked();
    await expect(editing.getByRole('radio', { name: 'リストの形に合わせる' })).not.toBeChecked();
    await expect(editing).toContainText('空行で区切ったリストで Enter を押したとき、次の項目の前にも空行を入れるか');
    await page.keyboard.press('Escape');

    await setListContinuation(page, 'リストの形に合わせる');
    await enterAtEnd(page);
    expect(await text(page)).toBe(`${LOOSE}\n\n- `);
    await expect.poll(() => savedPreferences(page)).toMatchObject({ listContinuation: 'preserve' });

    // 戻すと、文書を開き直さずに、すぐ空行が入らなくなる（同じ本文のまま、もう 1 回 Enter）。
    await page.keyboard.press('Backspace');
    await page.keyboard.press('Backspace');
    await page.keyboard.press('Backspace');
    await page.keyboard.press('Backspace');
    expect(await text(page)).toBe(LOOSE);
    await setListContinuation(page, '空行を入れない');
    await enterAtEnd(page);
    expect(await text(page)).toBe(`${LOOSE}\n- `);
    await expect.poll(() => savedPreferences(page)).toMatchObject({ listContinuation: 'tight' });

    // 「リストの形に合わせる」を選んで再読み込みしても、保たれる。
    await setListContinuation(page, 'リストの形に合わせる');
    await expect.poll(() => savedPreferences(page)).toMatchObject({ listContinuation: 'preserve' });
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-ready', 'true');
    await page.keyboard.press('ControlOrMeta+o');
    await expect(docTitle(page)).toHaveText('list.md');
    await enterAtEnd(page);
    expect(await text(page)).toBe(`${LOOSE}\n\n- `);
    await page.keyboard.press('ControlOrMeta+,');
    await expect(
      dialog(page).getByTestId('settings-editing').getByRole('radio', { name: 'リストの形に合わせる' }),
    ).toBeChecked();
  });

  test('「編集」の節の最後のラジオでも、Tab は設定画面の中で循環する（選択が「空行を入れない」でも「リストの形に合わせる」でも）', async ({ page }) => {
    for (const mode of ['tight', 'preserve']) {
      const other = await page.context().newPage();
      await launchWith(other, LOOSE, { listContinuation: mode });
      await other.keyboard.press('ControlOrMeta+,');
      const root = dialog(other);
      await expect(root).toBeVisible();
      const insideDialog = () => other.evaluate(() => !!document.activeElement?.closest('[data-testid=settings-dialog]'));
      // 選択中のラジオ（Tab で止まる側）へフォーカスし、Tab で最初の項目（閉じるボタン）へ戻る。
      await root.getByTestId('settings-editing').locator('input[type=radio]:checked').focus();
      await other.keyboard.press('Tab');
      expect(await insideDialog(), mode).toBe(true);
      await expect(root.getByTestId('settings-close'), mode).toBeFocused();
      // 最初の項目から Shift+Tab で、選択中のラジオへ戻る。
      await other.keyboard.press('Shift+Tab');
      await expect(root.getByTestId('settings-editing').locator('input[type=radio]:checked'), mode).toBeFocused();
    }
  });

  test('(b) 保存済みの設定が preserve なら、起動したときから空行を入れる。不正な値は既定（空行を入れない）に戻る', async ({ page }) => {
    await launchWith(page, LOOSE, { listContinuation: 'preserve' });
    await enterAtEnd(page);
    expect(await text(page)).toBe(`${LOOSE}\n\n- `);

    const other = await page.context().newPage();
    await launchWith(other, LOOSE, { listContinuation: 'loose' });
    await enterAtEnd(other);
    expect(await text(other)).toBe(`${LOOSE}\n- `);
  });

  test('.txt では、設定にかかわらずリストを続けない（今と同じ）', async ({ page }) => {
    for (const mode of ['tight', 'preserve']) {
      const txt = await page.context().newPage();
      await launch(txt, { files: { '/docs/plain.txt': utf8('- a\n\n- b') }, openPath: '/docs/plain.txt', preferences: { theme: 'light', listContinuation: mode } });
      await txt.keyboard.press('ControlOrMeta+o');
      await expect(docTitle(txt)).toHaveText('plain.txt');
      await enterAtEnd(txt);
      expect(await text(txt), mode).toBe('- a\n\n- b\n');
    }
  });

  test('(d) IME の変換中の Enter では項目が増えない。確定後の Enter で増える', async ({ page }) => {
    await launchWith(page, LOOSE);
    await page.locator('.cm-content').click();
    await page.keyboard.press('ControlOrMeta+End');
    const client: CDPSession = await page.context().newCDPSession(page);
    for (const reading of ['に', 'にほん']) {
      await client.send('Input.imeSetComposition', { text: reading, selectionStart: reading.length, selectionEnd: reading.length });
    }
    // 変換中の Enter は、実 IME では keydown（key は Process、keyCode は 229、isComposing）になる。
    // CDP の keyboard.press('Enter') は変換を確定して改行してしまい、実 IME の挙動ではないので使わない。
    await page.locator('.cm-content').evaluate((el) => {
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Process', code: 'Enter', keyCode: 229, isComposing: true, bubbles: true, cancelable: true }));
    });
    expect(await text(page)).toBe(`${LOOSE}にほん`);
    await client.send('Input.insertText', { text: '日本' });
    expect(await text(page)).toBe(`${LOOSE}日本`);
    expect(await page.locator('.cm-line').count()).toBe(LOOSE.split('\n').length);

    await page.keyboard.press('Enter');
    expect(await text(page)).toBe(`${LOOSE}日本\n- `);
  });
});

// Run 12 (N4): 空行のないリスト（tight list）の、空の 2 項目目で Enter を押したとき。
// lang-markdown の既定は、空の項目の前に空行を入れてリストを loose にする。設定が「空行を入れない」のときは、これを止める
// （空の項目の記号を取り除いて、リストを終える）。「リストの形に合わせる」では、これまでどおり空行を入れる。
test.describe('tight list の空の 2 項目目 (Run 12, N4)', () => {
  test('(i) 既定（空行を入れない）では、`- a` の次の空の項目で Enter を押しても、空行が入らない', async ({ page }) => {
    await launchWith(page, '');
    await page.locator('.cm-content').click();
    await page.keyboard.insertText('- a');
    await page.keyboard.press('Enter');
    expect(await text(page)).toBe('- a\n- ');
    await page.keyboard.press('Enter');
    expect(await text(page)).toBe('- a\n');
    // 項目と、記号を取り除いた行の間に、空行はない（行は 2 つ）。続けて書くと、その行に入る。
    expect(await page.locator('.cm-line').count()).toBe(2);
    await page.keyboard.type('段落');
    expect(await text(page)).toBe('- a\n段落');

    await page.keyboard.press('ControlOrMeta+s');
    await expect(unsavedMark(page)).toHaveCount(0);
    expect(await fileBytes(page, DOC)).toEqual(utf8('- a\n段落'));
  });

  test('(i) 番号付き・タスク・入れ子でも、空の 2 項目目で空行が入らない（入れ子は 1 段戻る）', async ({ page }) => {
    for (const [source, expected] of [
      ['1. a', '1. a\n'],
      ['- [ ] a', '- [ ] a\n'],
      // 入れ子の空の項目は、1 段戻る（外側の項目の記号になる）。
      ['- a\n  - b', '- a\n  - b\n- '],
    ] as const) {
      await launchWith(page, '');
      await page.locator('.cm-content').click();
      await page.keyboard.insertText(source);
      await page.keyboard.press('Enter');
      await page.keyboard.press('Enter');
      expect(await text(page), source).not.toMatch(/\n[ >]*\n/);
      expect(await text(page), source).toBe(expected);
      await page.reload();
      await expect(page.locator('html')).toHaveAttribute('data-ready', 'true');
    }
  });

  test('(i) 「リストの形に合わせる」では、これまでどおり空行を入れる', async ({ page }) => {
    await launchWith(page, '', { listContinuation: 'preserve' });
    await page.locator('.cm-content').click();
    await page.keyboard.insertText('- a');
    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter');
    expect(await text(page)).toBe('- a\n\n- ');
  });

  test('(i) 3 項目目以降の空の項目は、どちらの設定でもリストを終える（変わらない）', async ({ page }) => {
    for (const mode of ['tight', 'preserve']) {
      const other = await page.context().newPage();
      await launchWith(other, '', { listContinuation: mode });
      await other.locator('.cm-content').click();
      await other.keyboard.insertText('- a\n- b');
      await other.keyboard.press('Enter');
      await other.keyboard.press('Enter');
      expect(await text(other), mode).toBe('- a\n- b\n');
    }
  });
});
