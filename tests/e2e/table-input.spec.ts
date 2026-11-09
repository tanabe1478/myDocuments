import { expect, type CDPSession, type Page } from '@playwright/test';
import { docTitle, fileBytes, launch, redoKeys, test, unsavedMark, utf8 } from './helpers';

// ADR-006 の R12: 表の入力の支援。表の行での Enter で空の行を足し（最後の空の行では表から出る）、見出しの行（まだ表でない）の
// 末尾での Enter で区切りの行と空の行を足して表にし、最後のセルでの Tab で行を足す。本文を変えるのは、キーを押したときだけ。
// 実 IME ではなく、CDP による変換の模擬。WebKit で変換の確定の直後に届く Enter の keydown は、chromium では再現できない
// （CodeMirror は browser.safari のときだけ、その keydown を捨てる）。
// 所要時間を抑えるため、ホストの OS（chromium）と Windows の偽装（chromium-windows）だけで動かす。

test.describe.configure({ mode: 'parallel' });
test.beforeEach(({}, testInfo) => {
  test.skip(['chromium-mac', 'chromium-linux'].includes(testInfo.project.name), 'chromium と chromium-windows だけ');
});

const PATH = '/docs/input.md';

async function openDoc(page: Page, text: string, preferences: Record<string, unknown> = {}, options: { path?: string; bom?: boolean; crlf?: boolean } = {}): Promise<void> {
  const path = options.path ?? PATH;
  await launch(page, { files: { [path]: utf8(text, options) }, openPath: path, preferences: { theme: 'light', autoHideChrome: false, ...preferences } });
  await page.keyboard.press('ControlOrMeta+o');
  await expect(docTitle(page)).toHaveText(path.split('/').pop()!);
  await page.locator('.cm-content').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('ControlOrMeta+Home');
}

const docText = (page: Page) => page.evaluate(() => window.__mdeE2E!.editor!.getText());
const selection = (page: Page) => page.evaluate(() => window.__mdeE2E!.editor!.getSelection());
const tables = (page: Page) => page.locator('.cm-md-table');
const focusedInEditor = (page: Page) => page.evaluate(() => document.activeElement === document.querySelector('.cm-content'));

/** 位置 offset のある行の先頭へカーソルを移し（本体の操作）、そこから column 文字だけ右へ動かす（キー操作）。 */
async function caretAt(page: Page, text: string, offset: number): Promise<void> {
  await page.evaluate((o) => window.__mdeE2E!.editor!.goToLineStart(o), offset);
  const lineStart = text.lastIndexOf('\n', offset - 1) + 1;
  for (let i = 0; i < offset - lineStart; i++) await page.keyboard.press('ArrowRight');
  expect((await selection(page)).head).toBe(offset);
}

const TABLE = ['| a | b |', '|---|---|', '| 1 | 2 |', '| x | y |'].join('\n');
const DOC = `前の段落\n\n${TABLE}\n\n後ろの段落`;
const T = DOC.indexOf(TABLE);
const ROW1_END = T + TABLE.indexOf('| 1 | 2 |') + '| 1 | 2 |'.length;

test.describe('表の行での Enter (Q1)', () => {
  for (const display of ['cursorLine', 'always']) {
    test(`本文の行の末尾で Enter: 下に空の行 \`|  |  |\` を足し、最初のセルに入る。入力は保存される（記号の表示: ${display}）`, async ({ page }) => {
      await openDoc(page, DOC, { markupDisplay: display });
      await caretAt(page, DOC, ROW1_END);
      await page.keyboard.press('Enter');
      const added = DOC.replace('| 1 | 2 |\n', '| 1 | 2 |\n|  |  |\n');
      expect(await docText(page)).toBe(added);
      expect((await selection(page)).head).toBe(ROW1_END + 1 + 2);
      await page.keyboard.type('新');
      await page.keyboard.press('Tab');
      await page.keyboard.type('規');
      expect(await docText(page)).toBe(DOC.replace('| 1 | 2 |\n', '| 1 | 2 |\n| 新 | 規 |\n'));
      await page.keyboard.press('ControlOrMeta+s');
      await expect(unsavedMark(page)).toBeHidden();
      expect(await fileBytes(page, PATH)).toEqual(utf8(DOC.replace('| 1 | 2 |\n', '| 1 | 2 |\n| 新 | 規 |\n')));
    });
  }

  test('1 回の Undo で、押す前の文書と選択に戻る。Redo でやり直せる', async ({ page, platform }) => {
    await openDoc(page, DOC);
    await caretAt(page, DOC, ROW1_END);
    await page.keyboard.press('Enter');
    expect(await docText(page)).not.toBe(DOC);
    await page.keyboard.press('ControlOrMeta+z');
    expect(await docText(page)).toBe(DOC);
    expect((await selection(page)).head).toBe(ROW1_END);
    await page.keyboard.press(redoKeys(platform)[0]!);
    expect(await docText(page)).toBe(DOC.replace('| 1 | 2 |\n', '| 1 | 2 |\n|  |  |\n'));
  });

  test('セルの途中での Enter は、文字を分けない。見出しの行と区切りの行では、区切りの行の下（本文の 1 行目）に足す', async ({ page }) => {
    await openDoc(page, DOC);
    await caretAt(page, DOC, DOC.indexOf('| 1 | 2 |') + 3); // セル「1」の後ろ
    await page.keyboard.press('Enter');
    expect(await docText(page)).toBe(DOC.replace('| 1 | 2 |\n', '| 1 | 2 |\n|  |  |\n'));
    await page.keyboard.press('ControlOrMeta+z');
    // 見出しの行の途中
    await caretAt(page, DOC, T + 3);
    await page.keyboard.press('Enter');
    expect(await docText(page)).toBe(DOC.replace('|---|---|\n', '|---|---|\n|  |  |\n'));
    expect((await selection(page)).head).toBe(T + '| a | b |\n|---|---|\n'.length + 2);
    await page.keyboard.press('ControlOrMeta+z');
    // 区切りの行
    await caretAt(page, DOC, T + '| a | b |\n|-'.length);
    await page.keyboard.press('Enter');
    expect(await docText(page)).toBe(DOC.replace('|---|---|\n', '|---|---|\n|  |  |\n'));
  });

  test('見出しの列の数だけセルを足す（3 列）。外側の | のない表でも、足す行は外側の | を付ける', async ({ page }) => {
    const text = '| a | b | c |\n|---|---|---|\n| 1 |\n\n後';
    await openDoc(page, text);
    await caretAt(page, text, text.indexOf('| 1 |') + 5);
    await page.keyboard.press('Enter');
    expect(await docText(page)).toBe('| a | b | c |\n|---|---|---|\n| 1 |\n|  |  |  |\n\n後');
  });

  test('最後の行が空の本文の行のとき、Enter でその行を空の行にして表から出る。出ると表の表示に戻る', async ({ page }) => {
    await openDoc(page, DOC);
    await caretAt(page, DOC, DOC.indexOf('| x | y |') + '| x | y |'.length);
    await page.keyboard.press('Enter'); // 空の行を足す
    await page.keyboard.press('Enter'); // 空の最後の行: 表から出る
    const left = DOC.replace('| x | y |\n', '| x | y |\n\n');
    expect(await docText(page)).toBe(left);
    const head = DOC.indexOf('| x | y |') + '| x | y |\n'.length;
    expect((await selection(page)).head).toBe(head);
    // 表の外に出たので、カーソルが表に触れなくなると表の表示に戻る（カーソルは表の下の空の行）。
    await expect(tables(page)).toHaveCount(1);
    // 続けて書くと、表の外の段落になる。
    await page.keyboard.type('次');
    expect(await docText(page)).toBe(left.replace('| x | y |\n\n', '| x | y |\n次\n'));
  });

  test('空の最後の行から出るときも、1 回の Undo で押す前に戻る。最後の行でない空の行は、普通に行を足す', async ({ page }) => {
    const text = '| a |\n|---|\n|  |\n| 1 |\n\n後';
    await openDoc(page, text);
    await caretAt(page, text, text.indexOf('|  |') + 2);
    await page.keyboard.press('Enter');
    expect(await docText(page)).toBe('| a |\n|---|\n|  |\n|  |\n| 1 |\n\n後');
    await page.keyboard.press('ControlOrMeta+z');
    // 最後の行を空にして出る
    const text2 = '| a |\n|---|\n| 1 |\n|  |\n\n後';
    await openDoc(page, text2);
    await caretAt(page, text2, text2.indexOf('|  |') + 2);
    await page.keyboard.press('Enter');
    expect(await docText(page)).toBe('| a |\n|---|\n| 1 |\n\n\n後');
    await page.keyboard.press('ControlOrMeta+z');
    expect(await docText(page)).toBe(text2);
    expect((await selection(page)).head).toBe(text2.indexOf('|  |') + 2);
  });

  test('保存したバイト列: BOM と CRLF の文書で、行を足して保存しても BOM と改行が保たれる', async ({ page }) => {
    await openDoc(page, DOC, {}, { bom: true, crlf: true });
    await caretAt(page, DOC, ROW1_END);
    await page.keyboard.press('Enter');
    await page.keyboard.type('z');
    await page.keyboard.press('ControlOrMeta+s');
    await expect(unsavedMark(page)).toBeHidden();
    expect(await fileBytes(page, PATH)).toEqual(utf8(DOC.replace('| 1 | 2 |\n', '| 1 | 2 |\n| z |  |\n'), { bom: true, crlf: true }));
  });

  test('今のままのもの: 表の外の Enter、Shift+Enter、Mod+Enter、素のテキスト（.txt）、引用の中の表、範囲選択', async ({ page }) => {
    await openDoc(page, DOC);
    // 表の外（後ろの段落の末尾）
    await page.keyboard.press('ControlOrMeta+End');
    await page.keyboard.press('Enter');
    expect(await docText(page)).toBe(`${DOC}\n`);
    await page.keyboard.press('ControlOrMeta+z');
    // Shift+Enter、Mod+Enter は表の行でも、行を足さない
    await caretAt(page, DOC, ROW1_END);
    await page.keyboard.press('Shift+Enter');
    expect(await docText(page)).not.toContain('|  |  |');
    await page.keyboard.press('ControlOrMeta+z');
    await caretAt(page, DOC, ROW1_END);
    await page.keyboard.press('ControlOrMeta+Enter');
    expect(await docText(page)).not.toContain('|  |  |');
    await page.keyboard.press('ControlOrMeta+z');
    expect(await docText(page)).toBe(DOC);
    // 範囲選択
    await caretAt(page, DOC, ROW1_END);
    await page.keyboard.press('Shift+ArrowLeft');
    await page.keyboard.press('Enter');
    expect(await docText(page)).not.toContain('|  |  |');
  });

  test('素のテキスト（.txt）では何もしない（今の Enter のまま）', async ({ page }) => {
    await openDoc(page, DOC, {}, { path: '/docs/input.txt' });
    await caretAt(page, DOC, ROW1_END);
    await page.keyboard.press('Enter');
    expect(await docText(page)).toBe(DOC.replace('| 1 | 2 |\n', '| 1 | 2 |\n\n'));
    // 見出しの行でも同じ
    await page.keyboard.press('ControlOrMeta+z');
    await page.keyboard.press('ControlOrMeta+End');
    await page.keyboard.type('\n| A | B |');
    await page.keyboard.press('Enter');
    expect((await docText(page)).endsWith('| A | B |\n')).toBe(true);
  });

  test('引用とリストの中の表では、行を足さない', async ({ page }) => {
    const text = '> | a |\n> |---|\n> | 1 |\n\n- | c |\n  |---|\n  | 2 |';
    await openDoc(page, text);
    await caretAt(page, text, text.indexOf('> | 1 |') + '> | 1 |'.length);
    await page.keyboard.press('Enter');
    expect(await docText(page)).not.toContain('|  |  |');
    await page.keyboard.press('ControlOrMeta+End');
    await page.keyboard.press('Enter');
    expect(await docText(page)).not.toContain('|  |  |');
  });
});

test.describe('見出しの行での Enter で表にする (Q2)', () => {
  const HEAD_DOC = '前の段落\n\n| 名前 | 数 | 備考 |\n\n後ろの段落';
  const HEAD_END = HEAD_DOC.indexOf('備考 |') + '備考 |'.length;

  for (const display of ['cursorLine', 'always']) {
    test(`行の末尾で Enter: 区切りの行と空の行を足し、空の行の最初のセルに入る。表になる（記号の表示: ${display}）`, async ({ page }) => {
      await openDoc(page, HEAD_DOC, { markupDisplay: display });
      await caretAt(page, HEAD_DOC, HEAD_END);
      await page.keyboard.press('Enter');
      const made = HEAD_DOC.replace('| 名前 | 数 | 備考 |\n', '| 名前 | 数 | 備考 |\n| --- | --- | --- |\n|  |  |  |\n');
      expect(await docText(page)).toBe(made);
      expect((await selection(page)).head).toBe(HEAD_END + 1 + '| --- | --- | --- |'.length + 1 + 2);
      // 続けて書いて、最後のセルの Tab で行を足し、保存する。
      await page.keyboard.type('りんご');
      await page.keyboard.press('Tab');
      await page.keyboard.type('3');
      await page.keyboard.press('Tab');
      await page.keyboard.type('赤');
      await page.keyboard.press('Tab');
      const filled = HEAD_DOC.replace('| 名前 | 数 | 備考 |\n', '| 名前 | 数 | 備考 |\n| --- | --- | --- |\n| りんご | 3 | 赤 |\n|  |  |  |\n');
      expect(await docText(page)).toBe(filled);
      await page.keyboard.press('ControlOrMeta+s');
      await expect(unsavedMark(page)).toBeHidden();
      expect(await fileBytes(page, PATH)).toEqual(utf8(filled));
      // 表の外へ出ると、表の形で表示される（既定の設定のとき）。
      await page.keyboard.press('ControlOrMeta+Home');
      await expect(tables(page)).toHaveCount(display === 'cursorLine' ? 1 : 0);
      if (display === 'cursorLine') await expect(page.locator('.cm-md-table th')).toHaveText(['名前', '数', '備考']);
    });
  }

  test('1 回の Undo で、押す前の文書と選択に戻る。見出しの行の文字は変わらない', async ({ page }) => {
    await openDoc(page, HEAD_DOC);
    await caretAt(page, HEAD_DOC, HEAD_END);
    await page.keyboard.press('Enter');
    expect((await docText(page)).split('\n')[2]).toBe('| 名前 | 数 | 備考 |');
    await page.keyboard.press('ControlOrMeta+z');
    expect(await docText(page)).toBe(HEAD_DOC);
    expect((await selection(page)).head).toBe(HEAD_END);
  });

  test('行の中の `\\|` は区切りに数えない。1 列でも表になる', async ({ page }) => {
    const text = '| a \\| b | c |\n\n| x |';
    await openDoc(page, text);
    await caretAt(page, text, '| a \\| b | c |'.length);
    await page.keyboard.press('Enter');
    expect(await docText(page)).toBe('| a \\| b | c |\n| --- | --- |\n|  |  |\n\n| x |');
  });

  test('最後の行が見出しの行のとき（文書の末尾、末尾の空白の後ろ）も表になる', async ({ page }) => {
    const text = '本文\n| A | B |  ';
    await openDoc(page, text);
    await page.keyboard.press('ControlOrMeta+End');
    await page.keyboard.press('Enter');
    expect(await docText(page)).toBe('本文\n| A | B |  \n| --- | --- |\n|  |  |');
  });

  test('普通の改行になるもの: 行の途中、次の行が区切りの行、| で囲まれていない行、コードブロック、HTML ブロック、frontmatter、引用、リスト', async ({ page }) => {
    const cases: Array<{ text: string; at: (t: string) => number }> = [
      { text: '| A | B |', at: () => 3 }, // 行の途中
      { text: '| A | B', at: (t) => t.length }, // 終わりが | でない
      { text: '| A | B |\n|---|\n| 1 |', at: () => '| A | B |'.length }, // 次の行が区切りの行（列の数が違い、表にならない）
      { text: '```\n| A | B |\n```', at: (t) => t.indexOf('| A | B |') + 9 },
      { text: '<div>\n| A | B |\n</div>', at: (t) => t.indexOf('| A | B |') + 9 },
      { text: '---\ntitle: x\n| A | B |\n---\n\n本文', at: (t) => t.indexOf('| A | B |') + 9 },
      { text: '> | A | B |', at: (t) => t.length },
      { text: '- | A | B |', at: (t) => t.length },
      { text: '    | A | B |', at: (t) => t.length }, // 字下げのコードブロック
    ];
    for (const { text, at } of cases) {
      await openDoc(page, text);
      await caretAt(page, text, at(text));
      const before = await docText(page);
      await page.keyboard.press('Enter');
      const after = await docText(page);
      expect(after, text).not.toContain('--- |');
      // 今の Enter（普通の改行。引用とリストの記号の継続、カーソルの後ろの空白の削除を含む）だけが働いた。
      expect(after.split('\n').length, text).toBe(before.split('\n').length + 1);
      expect(after.replace(/\s+/g, ''), text).toContain(before.replace(/\s+/g, '').slice(0, 3));
    }
  });
});

test.describe('最後のセルでの Tab (Q3)', () => {
  test('最後の行の最後のセルで Tab: 表の最後に空の行を足して最初のセルへ。1 回の Undo で戻る', async ({ page }) => {
    await openDoc(page, DOC);
    await caretAt(page, DOC, DOC.indexOf('| x | y |') + '| x | y '.length);
    await page.keyboard.press('Tab');
    const added = DOC.replace('| x | y |\n', '| x | y |\n|  |  |\n');
    expect(await docText(page)).toBe(added);
    expect((await selection(page)).head).toBe(DOC.indexOf('| x | y |') + '| x | y |\n'.length + 2);
    expect(await focusedInEditor(page)).toBe(true);
    await page.keyboard.press('ControlOrMeta+z');
    expect(await docText(page)).toBe(DOC);
    expect((await selection(page)).head).toBe(DOC.indexOf('| x | y |') + '| x | y '.length);
  });

  test('最初のセルの Shift+Tab、Esc の直後の Tab、最後のセル以外、範囲選択は今のまま', async ({ page }) => {
    await openDoc(page, DOC);
    await caretAt(page, DOC, T + 2);
    await page.keyboard.press('Shift+Tab');
    expect((await selection(page)).head).toBe(T + 2);
    expect(await docText(page)).toBe(DOC);
    // Esc の直後の Tab は、最後のセルでも本文の外へフォーカスを移す。行は足さない。
    await caretAt(page, DOC, DOC.indexOf('| x | y |') + '| x | y '.length);
    await page.keyboard.press('Escape');
    await page.keyboard.press('Tab');
    expect(await focusedInEditor(page)).toBe(false);
    expect(await docText(page)).toBe(DOC);
    // 最後のセル以外
    await page.locator('.cm-content').focus();
    await caretAt(page, DOC, DOC.indexOf('| x | y |') + 3);
    await page.keyboard.press('Tab');
    expect(await docText(page)).toBe(DOC);
    // 範囲選択
    await caretAt(page, DOC, DOC.indexOf('| x | y |') + '| x | y '.length);
    await page.keyboard.press('Shift+ArrowLeft');
    await page.keyboard.press('Tab');
    expect(await docText(page)).toBe(DOC);
  });
});

test.describe('IME の変換中 (Q4)', () => {
  test('変換中の Enter（keyCode 229）では、表の行も見出しの行も行を足さない。確定後の Enter で足す', async ({ page }) => {
    // 変換は、行の最後の `|` の手前に入れる（確定後も、行の末尾が `|` のまま）。確定後は End で末尾へ移って Enter。
    for (const { text, expected } of [
      { text: DOC, expected: DOC.replace('| 1 | 2 |\n', '| 1 | 2日本 |\n|  |  |\n') },
      { text: '| A | B |\n\n後', expected: '| A | B日本 |\n| --- | --- |\n|  |  |\n\n後' },
    ]) {
      await openDoc(page, text);
      const row = text.includes('| 1 | 2 |') ? '| 1 | 2 |' : '| A | B |';
      const pos = text.indexOf(row) + row.length - 2; // 行の最後の空白の手前（最後の `|` の 2 つ前）
      await caretAt(page, text, pos);
      const client: CDPSession = await page.context().newCDPSession(page);
      for (const reading of ['に', 'にほん']) {
        await client.send('Input.imeSetComposition', { text: reading, selectionStart: reading.length, selectionEnd: reading.length });
      }
      // 変換中の Enter は、実 IME では keydown（key は Process、keyCode は 229、isComposing）になる。
      await page.locator('.cm-content').evaluate((el) => {
        el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Process', code: 'Enter', keyCode: 229, isComposing: true, bubbles: true, cancelable: true }));
      });
      expect(await page.locator('.cm-line').count()).toBe(text.split('\n').length);
      await client.send('Input.insertText', { text: '日本' });
      expect(await docText(page)).toBe(text.slice(0, pos) + '日本' + text.slice(pos));
      expect(await page.locator('.cm-line').count()).toBe(text.split('\n').length);
      await page.keyboard.press('End');
      await page.keyboard.press('Enter');
      expect(await docText(page)).toBe(expected);
    }
  });

  test('変換中の Tab（最後のセル）では行を足さない', async ({ page }) => {
    await openDoc(page, DOC);
    const at = DOC.indexOf('| x | y |') + '| x | y '.length;
    await caretAt(page, DOC, at);
    const client: CDPSession = await page.context().newCDPSession(page);
    await client.send('Input.imeSetComposition', { text: 'に', selectionStart: 1, selectionEnd: 1 });
    await page.locator('.cm-content').evaluate((el) => {
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Process', code: 'Tab', keyCode: 229, isComposing: true, bubbles: true, cancelable: true }));
    });
    await client.send('Input.insertText', { text: '日' });
    expect(await docText(page)).toBe(DOC.slice(0, at) + '日' + DOC.slice(at));
    expect(await page.locator('.cm-line').count()).toBe(DOC.split('\n').length);
  });
});

test.describe('リストの継続は今のまま (Q4)', () => {
  test('tight と preserve のどちらでも、リストの項目の Enter は次の項目を続け、空の項目で終える', async ({ page }) => {
    for (const mode of ['tight', 'preserve']) {
      const text = `${DOC}\n\n- a`;
      await openDoc(page, text, { listContinuation: mode });
      await page.keyboard.press('ControlOrMeta+End');
      await page.keyboard.press('Enter');
      expect(await docText(page), mode).toBe(`${text}\n- `);
      await page.keyboard.press('Enter');
      // tight は、空の項目の Enter で記号を取り除いてリストを終える（preserve は、空行を入れてリストを loose にする。これまでどおり）。
      if (mode === 'tight') expect(await docText(page), mode).toBe(`${text}\n`);
    }
  });
});
