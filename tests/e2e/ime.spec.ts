import { expect, type CDPSession, type Page } from '@playwright/test';
import { docTitle, editorText, fileBytes, launch, redoKeys, test, unsavedMark, utf8 } from './helpers';

// 日本語 IME の変換を、Chromium の CDP（Input.imeSetComposition / Input.insertText）で再現する。
// これは「変換中状態を作る」ための模擬で、実際の IME（Microsoft IME、macOS の日本語入力、Mozc）ではない。
// 実 IME は未検証（docs/architecture-review.md §6 の手動テスト手順）。

const DOC = '/docs/ime.md';
const BASE = '前の文。\n後の文。';

declare global {
  interface Window {
    __imeLog: Array<[string, string | null]>;
  }
}

async function openBaseDocument(page: Page): Promise<CDPSession> {
  await page.addInitScript(() => {
    window.__imeLog = [];
    for (const type of ['compositionstart', 'compositionupdate', 'compositionend']) {
      document.addEventListener(type, (e) => window.__imeLog.push([type, (e as CompositionEvent).data]), true);
    }
  });
  await launch(page, { files: { [DOC]: utf8(BASE) }, openPath: DOC });
  await page.keyboard.press('ControlOrMeta+o');
  await expect(docTitle(page)).toHaveText('ime.md');
  // 1 行目の末尾にカーソルを置く。
  await page.locator('.cm-content').click();
  await page.keyboard.press('ControlOrMeta+Home');
  await page.keyboard.press('End');
  return page.context().newCDPSession(page);
}

const compose = (client: CDPSession, text: string) =>
  client.send('Input.imeSetComposition', { text, selectionStart: text.length, selectionEnd: text.length });

const imeEvents = (page: Page) => page.evaluate(() => window.__imeLog.map(([type]) => type));

test.describe('日本語 IME の変換 (c)', () => {
  test('変換中も周囲の本文が壊れず、確定で本文に入る', async ({ page }) => {
    const client = await openBaseDocument(page);

    for (const reading of ['に', 'にほ', 'にほん', 'にほんご']) {
      await compose(client, reading);
      // 変換中: 1 行目の末尾に仮の文字が出て、前後の本文はそのまま。
      expect(await editorText(page)).toBe(`前の文。${reading}\n後の文。`);
    }
    // 変換候補（漢字）へ。
    await compose(client, '日本語');
    expect(await editorText(page)).toBe('前の文。日本語\n後の文。');

    // 確定。
    await client.send('Input.insertText', { text: '日本語' });
    expect(await editorText(page)).toBe('前の文。日本語\n後の文。');
    await expect(unsavedMark(page)).toBeVisible();

    // composition イベントが実際に発火している（insertText だけではない）。
    const events = await imeEvents(page);
    expect(events.filter((e) => e === 'compositionstart')).toHaveLength(1);
    expect(events.filter((e) => e === 'compositionupdate').length).toBeGreaterThanOrEqual(5);
    expect(events.filter((e) => e === 'compositionend')).toHaveLength(1);

    // 確定後に続けて入力でき、保存すると入力した UTF-8 だけが書かれる（IME-12）。
    await page.keyboard.type('。');
    await page.keyboard.press('ControlOrMeta+s');
    await expect(unsavedMark(page)).toHaveCount(0);
    expect(await fileBytes(page, DOC)).toEqual(utf8('前の文。日本語。\n後の文。'));
  });

  test('変換を取り消すと、仮の文字だけが消える', async ({ page }) => {
    const client = await openBaseDocument(page);
    await compose(client, 'にほ');
    expect(await editorText(page)).toBe('前の文。にほ\n後の文。');
    await compose(client, '');
    expect(await editorText(page)).toBe(BASE);
    await expect(unsavedMark(page)).toHaveCount(0);
  });

  test('確定した変換は 1 回の Undo で戻り、Redo で復元される', async ({ page, platform }) => {
    const client = await openBaseDocument(page);
    await compose(client, 'にほんご');
    await compose(client, '日本語');
    await client.send('Input.insertText', { text: '日本語' });
    expect(await editorText(page)).toBe('前の文。日本語\n後の文。');

    for (const redoKey of redoKeys(platform)) {
      await page.keyboard.press('ControlOrMeta+z');
      expect(await editorText(page), redoKey).toBe(BASE);
      await page.keyboard.press(redoKey);
      expect(await editorText(page), redoKey).toBe('前の文。日本語\n後の文。');
    }
  });

  test('変換中の外部 setText は適用されず、変換の終了後に適用される', async ({ page }) => {
    const client = await openBaseDocument(page);
    await compose(client, 'にほん');
    expect(await editorText(page)).toBe('前の文。にほん\n後の文。');

    await page.evaluate(() => window.__mdeE2E!.editor!.setText('外から読み込んだ文書'));
    // 変換中は、本文は壊れない（置き換わらない）。
    await page.waitForTimeout(300);
    expect(await editorText(page)).toBe('前の文。にほん\n後の文。');

    await client.send('Input.insertText', { text: '日本' });
    // 変換が終わった後に、保留していた本文が入る。
    await expect.poll(() => editorText(page)).toBe('外から読み込んだ文書');
  });
});
