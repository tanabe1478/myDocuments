import { expect, test } from '@playwright/test';
import {
  bridgeCounters,
  docTitle,
  editorText,
  fileBytes,
  focusEditorEnd,
  launch,
  setDialogPaths,
  toast,
  unsavedMark,
  utf8,
} from './helpers';

const DOC = '/docs/crlf-bom.md';
const ORIGINAL = '# 見出し\n\n本文の1行目\n';

test.describe('開く・編集・保存', () => {
  test('(a) 開く → 入力 → 未保存マーク → 保存 で、BOM と CRLF を保ったまま書かれる', async ({ page }) => {
    await launch(page, {
      files: { [DOC]: utf8(ORIGINAL, { bom: true, crlf: true }) },
      openPath: DOC,
    });
    await expect(docTitle(page)).toHaveText('無題');
    await expect(unsavedMark(page)).toHaveCount(0);

    await page.keyboard.press('ControlOrMeta+o');
    await expect(docTitle(page)).toHaveText('crlf-bom.md');
    expect(await editorText(page)).toBe('# 見出し\n\n本文の1行目\n');
    await expect(unsavedMark(page)).toHaveCount(0);

    await focusEditorEnd(page);
    await page.keyboard.type('追記');
    await expect(unsavedMark(page)).toBeVisible();
    // 保存前は、メモリ上のファイルは元のまま。
    expect(await fileBytes(page, DOC)).toEqual(utf8(ORIGINAL, { bom: true, crlf: true }));

    await page.keyboard.press('ControlOrMeta+s');
    await expect(unsavedMark(page)).toHaveCount(0);

    expect(await fileBytes(page, DOC)).toEqual(utf8('# 見出し\n\n本文の1行目\n追記', { bom: true, crlf: true }));
    const counters = await bridgeCounters(page);
    expect(counters.calls.save).toBe(1);
    expect(counters.log).toEqual([{ kind: 'save', path: DOC, outcome: 'written' }]);
  });

  test('(b) 無変更で保存しても書き込まない。内容が同じ保存は Unchanged になる', async ({ page }) => {
    const bytes = utf8(ORIGINAL, { bom: true, crlf: true });
    await launch(page, { files: { [DOC]: bytes, '/docs/copy.md': bytes }, openPath: DOC });
    await page.keyboard.press('ControlOrMeta+o');
    await expect(docTitle(page)).toHaveText('crlf-bom.md');

    // 無変更の保存: bridge が呼ばれない。
    await page.keyboard.press('ControlOrMeta+s');
    // 入力して消して元に戻すと、未保存ではなくなり、やはり書き込まない。
    await focusEditorEnd(page);
    await page.keyboard.type('X');
    await expect(unsavedMark(page)).toBeVisible();
    await page.keyboard.press('Backspace');
    await expect(unsavedMark(page)).toHaveCount(0);
    await page.keyboard.press('ControlOrMeta+s');

    let counters = await bridgeCounters(page);
    expect(counters.calls.save).toBe(0);
    expect(counters.calls.saveAs).toBe(0);
    expect(counters.physicalWrites).toBe(0);
    expect(await fileBytes(page, DOC)).toEqual(bytes);

    // 既存ファイルと同一のバイト列になる別名保存: bridge は呼ばれるが、書き込みは起きない。
    await setDialogPaths(page, { save: '/docs/copy.md' });
    await page.keyboard.press('ControlOrMeta+Shift+s');
    await expect(toast(page)).toContainText('書き込みませんでした');
    counters = await bridgeCounters(page);
    expect(counters.calls.saveAs).toBe(1);
    expect(counters.log).toEqual([{ kind: 'saveAs', path: '/docs/copy.md', outcome: 'unchanged' }]);
    expect(counters.physicalWrites).toBe(0);
    expect(await fileBytes(page, '/docs/copy.md')).toEqual(bytes);
  });

  test('新規文書は、保存先を選んで保存する（既定は LF、BOM なし）', async ({ page }) => {
    await launch(page, { savePath: '/docs/new.md' });
    await page.locator('.cm-content').click();
    await page.keyboard.type('# 新規');
    await page.keyboard.press('Enter');
    await page.keyboard.type('本文');
    await expect(unsavedMark(page)).toBeVisible();

    await page.keyboard.press('ControlOrMeta+s');
    await expect(docTitle(page)).toHaveText('new.md');
    await expect(unsavedMark(page)).toHaveCount(0);
    expect(await fileBytes(page, '/docs/new.md')).toEqual(utf8('# 新規\n本文'));

    // 保存先が決まった後は、ダイアログなしで上書きできる。
    await page.keyboard.type('。');
    await page.keyboard.press('ControlOrMeta+s');
    await expect(unsavedMark(page)).toHaveCount(0);
    expect(await fileBytes(page, '/docs/new.md')).toEqual(utf8('# 新規\n本文。'));
    expect((await bridgeCounters(page)).calls).toMatchObject({ saveAs: 1, save: 1 });
  });

  test('別名保存で保存先が変わり、元のファイルは変わらない', async ({ page }) => {
    const bytes = utf8(ORIGINAL, { crlf: true });
    await launch(page, { files: { [DOC]: bytes }, openPath: DOC, savePath: '/docs/other.md' });
    await page.keyboard.press('ControlOrMeta+o');
    await focusEditorEnd(page);
    await page.keyboard.type('!');
    await page.keyboard.press('ControlOrMeta+Shift+s');
    await expect(docTitle(page)).toHaveText('other.md');
    expect(await fileBytes(page, '/docs/other.md')).toEqual(utf8(`${ORIGINAL}!`, { crlf: true }));
    expect(await fileBytes(page, DOC)).toEqual(bytes);
  });

  test('保存ダイアログをキャンセルしたら、何も書かれず未保存のまま', async ({ page }) => {
    await launch(page, { savePath: null });
    await page.locator('.cm-content').click();
    await page.keyboard.type('x');
    await page.keyboard.press('ControlOrMeta+s');
    await expect(unsavedMark(page)).toBeVisible();
    expect((await bridgeCounters(page)).physicalWrites).toBe(0);
  });
});

test.describe('改行コード・文字コード', () => {
  test('混在改行は多数派に揃えて保存し、その旨を通知する', async ({ page }) => {
    // CRLF 3 行 + LF 1 行（多数派は CRLF）。
    const mixed = Array.from(new TextEncoder().encode('a\r\nb\r\nc\r\nd\ne'));
    await launch(page, { files: { '/docs/mixed.md': mixed }, openPath: '/docs/mixed.md' });
    await page.keyboard.press('ControlOrMeta+o');
    await expect(docTitle(page)).toHaveText('mixed.md');
    await expect(unsavedMark(page)).toHaveCount(0);

    await focusEditorEnd(page);
    await page.keyboard.type('!');
    await page.keyboard.press('ControlOrMeta+s');

    await expect(toast(page)).toContainText('多数派');
    await expect(toast(page)).toContainText('CRLF');
    expect(await fileBytes(page, '/docs/mixed.md')).toEqual(Array.from(new TextEncoder().encode('a\r\nb\r\nc\r\nd\r\ne!')));
  });

  test('UTF-8 でないファイルは開かず、現在の文書をそのまま残す', async ({ page }) => {
    // Shift_JIS の「あ」。
    await launch(page, { files: { '/docs/sjis.md': [0x82, 0xa0] }, openPath: '/docs/sjis.md' });
    await page.locator('.cm-content').click();
    await page.keyboard.type('書きかけ');
    // 未保存なので、確認ダイアログで「保存しない」を選ぶ。
    await page.keyboard.press('ControlOrMeta+o');
    await page.getByTestId('discard-discard').click();

    await expect(toast(page)).toContainText('UTF-8');
    await expect(docTitle(page)).toHaveText('無題');
    expect(await editorText(page)).toBe('書きかけ');
  });
});

test.describe('未保存の確認', () => {
  async function dirtyDocument(page: Parameters<typeof launch>[0]) {
    await launch(page, { files: { [DOC]: utf8('元') }, openPath: DOC, savePath: '/docs/saved-from-dialog.md' });
    await page.locator('.cm-content').click();
    await page.keyboard.type('編集中');
    await expect(unsavedMark(page)).toBeVisible();
  }

  test('新規: キャンセルすると、そのまま', async ({ page }) => {
    await dirtyDocument(page);
    await page.keyboard.press('ControlOrMeta+n');
    await expect(page.getByRole('alertdialog')).toBeVisible();
    await page.getByTestId('discard-cancel').click();
    await expect(page.getByRole('alertdialog')).toHaveCount(0);
    expect(await editorText(page)).toBe('編集中');
    await expect(unsavedMark(page)).toBeVisible();
  });

  test('新規: Esc はキャンセル', async ({ page }) => {
    await dirtyDocument(page);
    await page.keyboard.press('ControlOrMeta+n');
    await expect(page.getByRole('alertdialog')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('alertdialog')).toHaveCount(0);
    expect(await editorText(page)).toBe('編集中');
  });

  test('新規: 保存しない を選ぶと、空の無題になる', async ({ page }) => {
    await dirtyDocument(page);
    await page.keyboard.press('ControlOrMeta+n');
    await page.getByTestId('discard-discard').click();
    expect(await editorText(page)).toBe('');
    await expect(docTitle(page)).toHaveText('無題');
    await expect(unsavedMark(page)).toHaveCount(0);
    expect((await bridgeCounters(page)).physicalWrites).toBe(0);
  });

  test('新規: 保存 を選ぶと、保存してから空の無題になる', async ({ page }) => {
    await launch(page, { savePath: '/docs/saved-from-dialog.md' });
    await page.locator('.cm-content').click();
    await page.keyboard.type('残したい');
    await page.keyboard.press('ControlOrMeta+n');
    await page.getByTestId('discard-save').click();
    await expect(docTitle(page)).toHaveText('無題');
    expect(await editorText(page)).toBe('');
    expect(await fileBytes(page, '/docs/saved-from-dialog.md')).toEqual(utf8('残したい'));
  });

  test('開く: 未保存なら確認し、保存しない を選ぶと開く', async ({ page }) => {
    await launch(page, { files: { [DOC]: utf8('開いた内容') }, openPath: DOC });
    await page.locator('.cm-content').click();
    await page.keyboard.type('未保存');
    await page.keyboard.press('ControlOrMeta+o');
    await expect(page.getByRole('alertdialog')).toBeVisible();
    await page.getByTestId('discard-discard').click();
    await expect(docTitle(page)).toHaveText('crlf-bom.md');
    expect(await editorText(page)).toBe('開いた内容');
  });

  test('変更がなければ確認しない', async ({ page }) => {
    await launch(page, { files: { [DOC]: utf8('内容') }, openPath: DOC });
    await page.keyboard.press('ControlOrMeta+o');
    await expect(docTitle(page)).toHaveText('crlf-bom.md');
    await page.keyboard.press('ControlOrMeta+n');
    await expect(page.getByRole('alertdialog')).toHaveCount(0);
    await expect(docTitle(page)).toHaveText('無題');
  });
});

test.describe('Undo / Redo (d)', () => {
  test('入力のまとまりごとに戻せて、やり直せる', async ({ page }) => {
    await launch(page);
    await page.locator('.cm-content').click();
    await page.keyboard.type('first');
    // CodeMirror は 500ms 以上あいた入力を別の Undo 単位にする。
    await page.waitForTimeout(700);
    await page.keyboard.type('second');
    expect(await editorText(page)).toBe('firstsecond');

    await page.keyboard.press('ControlOrMeta+z');
    expect(await editorText(page)).toBe('first');
    await page.keyboard.press('ControlOrMeta+z');
    expect(await editorText(page)).toBe('');
    await expect(unsavedMark(page)).toHaveCount(0);

    await page.keyboard.press('ControlOrMeta+Shift+z');
    expect(await editorText(page)).toBe('first');
    await expect(unsavedMark(page)).toBeVisible();
    await page.keyboard.press('ControlOrMeta+Shift+z');
    expect(await editorText(page)).toBe('firstsecond');
  });

  test('文書を開いた後、Undo で前の文書には戻らない', async ({ page }) => {
    await launch(page, { files: { [DOC]: utf8('開いた文書') }, openPath: DOC });
    await page.locator('.cm-content').click();
    await page.keyboard.type('前の文書の入力');
    await page.keyboard.press('ControlOrMeta+o');
    await page.getByTestId('discard-discard').click();
    expect(await editorText(page)).toBe('開いた文書');
    await page.keyboard.press('ControlOrMeta+z');
    expect(await editorText(page)).toBe('開いた文書');
  });
});

test.describe('検索 (ED-03)', () => {
  test('Cmd/Ctrl+F で検索パネルが開く', async ({ page }) => {
    await launch(page, { files: { [DOC]: utf8('apple banana apple') }, openPath: DOC });
    await page.keyboard.press('ControlOrMeta+o');
    await expect(docTitle(page)).toHaveText('crlf-bom.md');
    await page.locator('.cm-content').click();
    await page.keyboard.press('ControlOrMeta+f');
    await expect(page.locator('.cm-search')).toBeVisible();
    await page.keyboard.type('apple');
    await expect(page.locator('.cm-searchMatch')).toHaveCount(2);
  });
});

test.describe('Preferences の反映', () => {
  test('本文の最大幅（既定 680px）と、保存済みの設定', async ({ page }) => {
    await launch(page);
    const width = () => page.locator('.cm-content').evaluate((el) => el.getBoundingClientRect().width);
    await page.setViewportSize({ width: 1400, height: 800 });
    expect(await width()).toBe(680);
    // 中央寄せ: 左右の余白が等しい。
    const margins = await page.locator('.cm-content').evaluate((el) => {
      const r = el.getBoundingClientRect();
      return [r.left, window.innerWidth - r.right];
    });
    expect(Math.abs(margins[0]! - margins[1]!)).toBeLessThan(20);
  });

  test('保存済みの設定が反映され、範囲外の項目だけ既定値に戻る', async ({ page }) => {
    await launch(page, { preferences: { maxWidthPx: 520, fontSizePx: 999, theme: 'dark' } });
    await page.setViewportSize({ width: 1400, height: 800 });
    expect(await page.locator('.cm-content').evaluate((el) => el.getBoundingClientRect().width)).toBe(520);
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    expect(await page.locator('.cm-scroller').evaluate((el) => getComputedStyle(el).fontSize)).toBe('18px');
  });
});

test.describe('Markdown の見た目', () => {
  test('見出しは大きく、記法記号は薄く表示され、非表示にはならない', async ({ page }, testInfo) => {
    await launch(page, {
      files: { [DOC]: utf8('# 見出し1\n\n## 見出し2\n\n本文 **強調** と *斜体* と [リンク](https://example.com) と `code`\n') },
      openPath: DOC,
    });
    await page.keyboard.press('ControlOrMeta+o');
    await expect(docTitle(page)).toHaveText('crlf-bom.md');

    const sizes = await page.evaluate(() => {
      const size = (sel: string) => parseFloat(getComputedStyle(document.querySelector(sel)!).fontSize);
      return { h1: size('.cm-md-h1'), h2: size('.cm-md-h2'), body: size('.cm-scroller') };
    });
    expect(sizes.h1).toBeGreaterThan(sizes.h2);
    expect(sizes.h2).toBeGreaterThan(sizes.body);

    // 記法記号は表示されたまま。
    expect(await editorText(page)).toContain('**強調**');
    expect(await editorText(page)).toContain('# 見出し1');

    // 記法記号の色は、本文より薄い（本文と異なる色）。
    const colors = await page.evaluate(() => {
      const lines = Array.from(document.querySelectorAll('.cm-md-h1 span'));
      const mark = lines.find((s) => s.textContent?.startsWith('#'));
      const text = lines.find((s) => s.textContent?.includes('見出し1'));
      return { mark: getComputedStyle(mark!).color, text: getComputedStyle(text!).color };
    });
    expect(colors.mark).not.toBe(colors.text);

    await page.screenshot({ path: testInfo.outputPath('markdown-decoration.png') });
  });
});
