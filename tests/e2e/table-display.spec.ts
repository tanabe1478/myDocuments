import { expect, type CDPSession, type Page } from '@playwright/test';
import { docTitle, fileBytes, launch, test, unsavedMark, utf8 } from './helpers';

// ADR-006: カーソルが表の外にあるとき、Markdown の表を表の形で表示する。原文の表の中では Tab / Shift+Tab でセルを移る。
// 本文のバイト列は変えない。実 IME ではなく、CDP による変換の模擬。
// 所要時間を抑えるため、ホストの OS（chromium）と Windows の偽装（chromium-windows）だけで動かす。

test.describe.configure({ mode: 'parallel' });
test.beforeEach(({}, testInfo) => {
  test.skip(['chromium-mac', 'chromium-linux'].includes(testInfo.project.name), 'chromium と chromium-windows だけ');
});

const PATH = '/docs/table.md';

async function openDoc(
  page: Page,
  text: string,
  preferences: Record<string, unknown> = {},
  options: { path?: string; bom?: boolean; crlf?: boolean } = {},
): Promise<void> {
  const path = options.path ?? PATH;
  await launch(page, { files: { [path]: utf8(text, options) }, openPath: path, preferences: { theme: 'light', ...preferences } });
  await page.keyboard.press('ControlOrMeta+o');
  await expect(docTitle(page)).toHaveText(path.split('/').pop()!);
  // 文書の先頭にカーソルを置く（最初の行は、表ではない）。
  await page.locator('.cm-content').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('ControlOrMeta+Home');
}

const docText = (page: Page) => page.evaluate(() => window.__mdeE2E!.editor!.getText());
const selection = (page: Page) => page.evaluate(() => window.__mdeE2E!.editor!.getSelection());
const tables = (page: Page) => page.locator('.cm-md-table');
const settleFrames = (page: Page) =>
  page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
const focusedInEditor = (page: Page) => page.evaluate(() => document.activeElement === document.querySelector('.cm-content'));

const TABLE = [
  '| 名前 | 数 | 備考 |',
  '|:-----|---:|:----:|',
  '| りんご | 3 | **赤** と `code` |',
  '| みかん |  | [リンク](https://example.com) |',
  '| a \\| b | 1 | 2 | 余り |',
].join('\n');
const HEAD = '# 表の見本\n\n前の段落\n\n';
const TAIL = '\n\n後ろの段落\n\n**太字** *斜体* ~~消~~ `code` [リンク](https://example.com) <https://auto.example.com> https://bare.example.com';
const DOC = `${HEAD}${TABLE}${TAIL}`;
const T = HEAD.length; // 表の先頭の位置

/** 表の中のセルの中身の頭（Tab の行き先）を、原文から求める。 */
function cellStarts(): number[] {
  const rows = TABLE.split('\n');
  const rowStart = (i: number) => T + rows.slice(0, i).reduce((n, r) => n + r.length + 1, 0);
  const at = (row: number, text: string, after = 0) => rowStart(row) + rows[row]!.indexOf(text, after);
  return [
    at(0, '名前'), at(0, '数'), at(0, '備考'),
    at(2, 'りんご'), at(2, '3'), at(2, '**赤**'),
    at(3, 'みかん'), at(3, '|  |') + 2, at(3, '[リンク]'),
    at(4, 'a \\| b'), at(4, '1'), at(4, '2'), at(4, '余り'),
  ];
}
const STARTS = cellStarts();
/** セルの中身の末尾（クリックの行き先）。 */
const cellEnd = (row: number, text: string) => {
  const rows = TABLE.split('\n');
  return T + rows.slice(0, row).reduce((n, r) => n + r.length + 1, 0) + rows[row]!.indexOf(text) + text.length;
};

// ---- 表示 ----

test.describe('表の形での表示 (Q1)', () => {
  test('カーソルが表の外のとき、表の形で表示される（見出し、本文、区切りの行は出ない、配置は区切りの行に従う、本文は原文のまま）', async ({ page }) => {
    await openDoc(page, DOC);
    await expect(tables(page)).toHaveCount(1);
    await expect(page.locator('.cm-md-table th')).toHaveText(['名前', '数', '備考']);
    // 列の数は見出しのセルの数。足りないセルは空、余るセル（余り）は出ない。空のセルも列に数える。
    const rows = await page.locator('.cm-md-table tbody tr').evaluateAll((trs) => trs.map((tr) => Array.from(tr.children).map((c) => c.textContent)));
    expect(rows).toEqual([
      ['りんご', '3', '赤 と code'],
      ['みかん', '', 'リンク'],
      ['a | b', '1', '2'],
    ]);
    const aligns = await page.locator('.cm-md-table tbody tr:first-child td').evaluateAll((tds) => tds.map((td) => getComputedStyle(td).textAlign));
    expect(aligns).toEqual(['left', 'right', 'center']);
    // 区切りの行と `|` は画面にない。本文は原文のまま。
    expect(await page.locator('.cm-content').innerText()).not.toContain('---');
    expect(await docText(page)).toBe(DOC);
  });

  test('原文のままにするもの: 設定「常に表示」、素のテキスト、引用とリストの中の表、frontmatter の中', async ({ page }) => {
    await openDoc(page, DOC, { markupDisplay: 'always' });
    await expect(tables(page)).toHaveCount(0);
    await expect(page.locator('.cm-line', { hasText: '|:-----|---:|:----:|' })).toHaveCount(1);

    const nested = ['x', '', '> | a |', '> |---|', '> | 1 |', '', '- | b |', '  |---|', '', '---', 'c | d', '--|--', '---', '', 'end'].join('\n');
    await openDoc(page, nested);
    await expect(tables(page)).toHaveCount(0);
    // 引用の中の表は、表示せず、これまでどおり行ごとに記号を隠す（> が隠れた原文の行）。
    await expect(page.locator('.cm-line', { hasText: /^\| a \|$/ })).toHaveCount(1);
    await expect(page.locator('.cm-line', { hasText: /^\|---\|$/ })).toHaveCount(1);
    await expect(page.locator('.cm-line', { hasText: /\|---\|$/ })).toHaveCount(2);

    await openDoc(page, DOC, {}, { path: '/docs/plain.txt' });
    await expect(tables(page)).toHaveCount(0);
    await expect(page.locator('.cm-line', { hasText: '|:-----|---:|:----:|' })).toHaveCount(1);
  });

  test('セルの中の見た目は、ほかの行で記号を隠したときと同じ（太さ、斜体、取り消し線、コード、リンク、自動リンク、裸の URL）', async ({ page }) => {
    const cells = '**太字** *斜体* ~~消~~ `code` [リンク](https://example.com) <https://auto.example.com> https://bare.example.com';
    await openDoc(page, `先頭\n\n| h |\n|---|\n| ${cells} |\n\n${cells}`);
    const probe = (scope: string) =>
      page.evaluate((root) => {
        const pick = (text: string) => {
          const el = Array.from(document.querySelectorAll(`${root} span`)).filter((e) => e.textContent === text).pop();
          if (!el) return null;
          const cs = getComputedStyle(el);
          return [cs.fontWeight, cs.fontStyle, cs.textDecorationLine, cs.color, cs.fontFamily, cs.fontSize];
        };
        return ['太字', '斜体', '消', 'code', 'リンク', 'https://auto.example.com', 'https://bare.example.com'].map(pick);
      }, scope);
    const inTable = await probe('.cm-md-table td');
    const inLine = await probe('.cm-line');
    expect(inTable.every((p) => p !== null)).toBe(true);
    expect(inTable).toEqual(inLine);
    // 取り消し線とリンクの下線は、実際に付いている。
    expect(inTable[2]![2]).toBe('line-through');
    expect(inTable[4]![2]).toBe('underline');
    expect(inTable[0]![0]).toBe('700');
  });

  test('画像、参照リンク、HTML は原文の文字のまま。文書に書いた <script> と <img onerror> は動かない', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await openDoc(
      page,
      [
        '先頭',
        '',
        '| a |',
        '|---|',
        '| ![画像](a.png) [参照][r] <b>x</b> |',
        '| <script>window.__xss = 1</script> |',
        '| <img src="x" onerror="window.__xss = 2"> |',
        '| <svg onload="window.__xss = 3"> |',
        '',
        '[r]: https://example.com',
      ].join('\n'),
    );
    await settleFrames(page);
    const cell = page.locator('.cm-md-table tbody td');
    await expect(cell.nth(0)).toHaveText('![画像](a.png) [参照][r] <b>x</b>');
    await expect(cell.nth(1)).toHaveText('<script>window.__xss = 1</script>');
    await expect(cell.nth(2)).toHaveText('<img src="x" onerror="window.__xss = 2">');
    await expect(cell.nth(3)).toHaveText('<svg onload="window.__xss = 3">');
    expect(await page.locator('.cm-md-table script, .cm-md-table img, .cm-md-table svg, .cm-md-table b').count()).toBe(0);
    expect(await page.evaluate(() => (window as unknown as { __xss?: number }).__xss)).toBeUndefined();
    expect(errors).toEqual([]);
  });

  test('表の幅は本文の幅を超えない。長い語はセルの中で折り返し、横スクロールは出ない（狭い窓でも）', async ({ page }) => {
    await page.setViewportSize({ width: 520, height: 700 });
    const long = 'x'.repeat(120);
    await openDoc(page, `先頭\n\n| 列 1 | 列 2 | 列 3 |\n|---|---|---|\n| ${long} | https://example.com/${'a'.repeat(80)} | 短い |\n| あ | い | う |\n\n終わり`);
    const m = await page.evaluate(() => {
      const content = document.querySelector('.cm-content')!;
      const cs = getComputedStyle(content);
      const contentRect = content.getBoundingClientRect();
      const grid = document.querySelector('.cm-md-table-grid')!.getBoundingClientRect();
      const scroller = document.querySelector('.cm-scroller')!;
      return {
        columnLeft: contentRect.left + parseFloat(cs.paddingLeft),
        columnRight: contentRect.right - parseFloat(cs.paddingRight),
        gridLeft: grid.left,
        gridRight: grid.right,
        scrollWidth: scroller.scrollWidth,
        clientWidth: scroller.clientWidth,
      };
    });
    expect(m.gridRight).toBeLessThanOrEqual(m.columnRight + 0.5);
    expect(m.gridLeft).toBeGreaterThanOrEqual(m.columnLeft - 0.5);
    expect(m.scrollWidth).toBeLessThanOrEqual(m.clientWidth);
  });

  for (const theme of ['light', 'dark'] as const) {
    test(`色は CSS 変数で、${theme} テーマに追従する（文字、枠、見出しの背景）`, async ({ page }) => {
      await openDoc(page, DOC, { theme });
      const m = await page.evaluate(() => {
        const resolve = (v: string, prop: 'color' | 'backgroundColor') => {
          const probe = document.createElement('div');
          probe.style[prop] = `var(${v})`;
          document.body.append(probe);
          const value = getComputedStyle(probe)[prop];
          probe.remove();
          return value;
        };
        const th = document.querySelector('.cm-md-table th')!;
        const td = document.querySelector('.cm-md-table td')!;
        return {
          text: [getComputedStyle(td).color, resolve('--md-color-text', 'color')],
          border: [getComputedStyle(td).borderTopColor, resolve('--md-color-border', 'color')],
          headBg: [getComputedStyle(th).backgroundColor, resolve('--md-color-code-bg', 'backgroundColor')],
        };
      });
      expect(m.text[0]).toBe(m.text[1]);
      expect(m.border[0]).toBe(m.border[1]);
      expect(m.headBg[0]).toBe(m.headBg[1]);
    });
  }
});

// ---- 出入り ----

test.describe('表への出入り (Q2)', () => {
  test('セルのクリックで、そのセルの中身の末尾にカーソルが入り、表は原文に戻る。文書は変わらず、未保存にならない', async ({ page }) => {
    await openDoc(page, DOC);
    await page.locator('.cm-md-table tbody tr').nth(0).locator('td').nth(0).click();
    await expect(tables(page)).toHaveCount(0);
    expect(await selection(page)).toEqual({ anchor: cellEnd(2, 'りんご'), head: cellEnd(2, 'りんご') });
    expect(await docText(page)).toBe(DOC);
    await expect(unsavedMark(page)).toBeHidden();
    // 原文の表の行が見える。
    await expect(page.locator('.cm-line', { hasText: '|:-----|---:|:----:|' })).toHaveCount(1);
    // 表の外へ出ると、表示に戻る。
    await page.keyboard.press('ControlOrMeta+Home');
    await expect(tables(page)).toHaveCount(1);
  });

  test('書式のあるセル、空のセル、足りないセルをクリックしたときの位置', async ({ page }) => {
    await openDoc(page, DOC);
    const click = async (row: number, col: number) => {
      await page.locator('.cm-md-table tbody tr').nth(row).locator('td').nth(col).click();
      const s = await selection(page);
      await page.keyboard.press('ControlOrMeta+Home');
      await expect(tables(page)).toHaveCount(1);
      return s.head;
    };
    expect(await click(0, 2)).toBe(cellEnd(2, '**赤** と `code`'));
    // 空のセル: 中身の頭（左の | の後ろの空白の 1 つ後ろ）。
    expect(await click(1, 1)).toBe(STARTS[7]);
    expect(await click(1, 2)).toBe(cellEnd(3, '[リンク](https://example.com)'));
  });

  test('セルの外（表の右の余白）のクリックは、一番近いセルへ', async ({ page }) => {
    await openDoc(page, DOC);
    const box = (await page.locator('.cm-md-table tbody tr').nth(0).locator('td').nth(2).boundingBox())!;
    const wrap = (await tables(page).boundingBox())!;
    // 表（グリッド）の右端より右、ブロックの中。1 行目（りんご）の高さで。
    const gridRight = (await page.locator('.cm-md-table-grid').boundingBox())!;
    const x = Math.min(gridRight.x + gridRight.width + 20, wrap.x + wrap.width - 2);
    expect(x).toBeGreaterThan(gridRight.x + gridRight.width);
    await page.mouse.click(x, box.y + box.height / 2);
    await expect(tables(page)).toHaveCount(0);
    expect(await selection(page)).toEqual({ anchor: cellEnd(2, '**赤** と `code`'), head: cellEnd(2, '**赤** と `code`') });
  });

  test('Shift+クリックは、選択の anchor を保ったまま head を伸ばす。Ctrl/Meta/Alt+クリックは普通のクリックと同じで、リンクは開かない', async ({ page }) => {
    await openDoc(page, DOC);
    await page.keyboard.press('End'); // 1 行目の末尾
    const anchor = (await selection(page)).anchor;
    await page.locator('.cm-md-table tbody tr').nth(0).locator('td').nth(0).click({ modifiers: ['Shift'] });
    expect(await selection(page)).toEqual({ anchor, head: cellEnd(2, 'りんご') });
    expect(await docText(page)).toBe(DOC);

    for (const modifier of ['ControlOrMeta', 'Alt'] as const) {
      await page.keyboard.press('ControlOrMeta+Home');
      await expect(tables(page)).toHaveCount(1);
      await page.locator('.cm-md-table .cm-md-t-link').click({ modifiers: [modifier] });
      await expect(tables(page)).toHaveCount(0);
      expect(await selection(page)).toEqual({ anchor: cellEnd(3, '[リンク](https://example.com)'), head: cellEnd(3, '[リンク](https://example.com)') });
    }
    expect(await page.evaluate(() => window.__mdeE2E!.openedUrls)).toEqual([]);
  });

  test('右クリックと中クリックは何もしない', async ({ page }) => {
    await openDoc(page, DOC);
    const before = await selection(page);
    const cell = page.locator('.cm-md-table tbody td').nth(0);
    await cell.click({ button: 'middle' });
    await cell.click({ button: 'right' });
    await expect(tables(page)).toHaveCount(1);
    expect(await selection(page)).toEqual(before);
    expect(await docText(page)).toBe(DOC);
  });

  test('上下キー（mac は Ctrl-n / Ctrl-p も）で、表の上と下の行から表に入れる。表を飛ばさず、入ると原文になり、出ると表示に戻る', async ({ page, platform }) => {
    const text = '前\n\n| a |\n|---|\n| 1 |\n\n後';
    await openDoc(page, text);
    const line = async () => page.evaluate(() => {
      const sel = window.__mdeE2E!.editor!.getSelection();
      return window.__mdeE2E!.editor!.getText().slice(0, sel.head).split('\n').length;
    });
    await page.keyboard.press('ArrowDown'); // 空行（2 行目）
    expect(await line()).toBe(2);
    await expect(tables(page)).toHaveCount(1);
    await page.keyboard.press('ArrowDown'); // 表の見出しの行（3 行目）
    expect(await line()).toBe(3);
    await expect(tables(page)).toHaveCount(0);
    // 表の中は 1 行ずつ。
    for (const expected of [4, 5, 6]) {
      await page.keyboard.press('ArrowDown');
      expect(await line()).toBe(expected);
    }
    await expect(tables(page)).toHaveCount(1);
    await page.keyboard.press('ArrowDown'); // 後（7 行目）
    expect(await line()).toBe(7);
    // 上へ: 表の下の空行から、表の最後の行へ。
    await page.keyboard.press('ArrowUp');
    expect(await line()).toBe(6);
    await page.keyboard.press('ArrowUp');
    expect(await line()).toBe(5);
    await expect(tables(page)).toHaveCount(0);
    for (const expected of [4, 3, 2]) {
      await page.keyboard.press('ArrowUp');
      expect(await line()).toBe(expected);
    }
    await expect(tables(page)).toHaveCount(1);
    expect(await docText(page)).toBe(text);

    if (platform === 'mac') {
      await page.keyboard.press('Control+n');
      expect(await line()).toBe(3);
      await expect(tables(page)).toHaveCount(0);
      await page.keyboard.press('ControlOrMeta+Home');
      await page.keyboard.press('ArrowDown');
      await page.keyboard.press('ArrowDown');
      await page.keyboard.press('Control+p');
      expect(await line()).toBe(2);
    }
  });

  test('折り返した長い行の途中の上下キーは、これまでどおり（表へは、その行の最後の折り返しからだけ入る）', async ({ page }) => {
    const long = 'あ'.repeat(200);
    await openDoc(page, `${long}\n| a |\n|---|\n| 1 |\n\n終わり`);
    await page.keyboard.press('ControlOrMeta+Home');
    await page.keyboard.press('ArrowDown');
    // 折り返した 1 行目の 2 行目へ（まだ同じ論理行）。
    expect((await selection(page)).head).toBeLessThan(201);
    await expect(tables(page)).toHaveCount(1);
    for (let i = 0; i < 6 && (await tables(page).count()) === 1; i++) await page.keyboard.press('ArrowDown');
    await expect(tables(page)).toHaveCount(0);
    expect(await page.evaluate(() => {
      const sel = window.__mdeE2E!.editor!.getSelection();
      return window.__mdeE2E!.editor!.getText().slice(0, sel.head).split('\n').length;
    })).toBe(2);
  });

  test('検索で表の中の一致に移ると、表は原文になる', async ({ page }) => {
    await openDoc(page, DOC);
    await page.keyboard.press('ControlOrMeta+f');
    await page.keyboard.type('みかん');
    // 検索パネルは、入力の確定の後の Enter で一致へ移る（表とは関係のない、これまでの挙動）。選択が動くまで押す。
    await expect.poll(async () => {
      await page.keyboard.press('Enter');
      return (await selection(page)).head;
    }).toBeGreaterThan(0);
    await expect(tables(page)).toHaveCount(0);
    const s = await selection(page);
    expect(DOC.slice(Math.min(s.anchor, s.head), Math.max(s.anchor, s.head))).toBe('みかん');
    expect(s.head).toBeGreaterThan(T);
    expect(s.head).toBeLessThan(T + TABLE.length);
    expect(await docText(page)).toBe(DOC);
  });

  test('IME の変換中は、ほかの表の DOM を作り直さず、変換と確定は壊れない', async ({ page }) => {
    const two = `前の文。\n\n${TABLE}\n\n間の文。\n\n| x | y |\n|---|---|\n| 1 | 2 |\n\n終わり`;
    await openDoc(page, two);
    await page.keyboard.press('ControlOrMeta+Home');
    await page.keyboard.press('End');
    await page.evaluate(() => document.querySelectorAll('.cm-md-table').forEach((t, i) => ((t as HTMLElement & { __mark?: number }).__mark = i + 1)));
    const client: CDPSession = await page.context().newCDPSession(page);
    const marks = () => page.evaluate(() => Array.from(document.querySelectorAll('.cm-md-table')).map((t) => (t as HTMLElement & { __mark?: number }).__mark ?? 0));
    for (const reading of ['に', 'にほん', 'にほんご']) {
      await client.send('Input.imeSetComposition', { text: reading, selectionStart: reading.length, selectionEnd: reading.length });
      expect(await marks()).toEqual([1, 2]);
    }
    await client.send('Input.imeSetComposition', { text: '日本語', selectionStart: 3, selectionEnd: 3 });
    await client.send('Input.insertText', { text: '日本語' });
    expect(await docText(page)).toBe(two.replace('前の文。', '前の文。日本語'));
    await expect(page.locator('.cm-line', { hasText: '前の文。日本語' })).toHaveCount(1);
    await settleFrames(page);
    expect(await marks()).toEqual([1, 2]);
  });
});

// ---- 本文を変えない ----

test.describe('本文のバイト列を変えない (Q3)', () => {
  test('表示の切り替え、出入り、Tab の移動のあとで、保存したバイト列は元と同じ。書き込みもなく、Undo の履歴も積まない', async ({ page }) => {
    const original = utf8(DOC);
    await openDoc(page, DOC);
    await page.locator('.cm-md-table tbody td').nth(4).click();
    for (let i = 0; i < 4; i++) await page.keyboard.press('Tab');
    for (let i = 0; i < 2; i++) await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('ControlOrMeta+Home');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ControlOrMeta+End');
    await page.keyboard.press('ControlOrMeta+z'); // 積まれていない履歴を戻しても、何も起きない
    expect(await docText(page)).toBe(DOC);
    await expect(unsavedMark(page)).toBeHidden();
    await page.keyboard.press('ControlOrMeta+s');
    expect(await page.evaluate(() => window.__mdeE2E!.physicalWrites)).toBe(0);
    expect(await fileBytes(page, PATH)).toEqual(original);
  });

  test('BOM と CRLF の文書で、操作のあとに 1 文字足して保存しても、表の部分のバイト列は変わらない', async ({ page }) => {
    await openDoc(page, DOC, {}, { bom: true, crlf: true });
    await page.locator('.cm-md-table tbody td').nth(1).click();
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
    await page.keyboard.press('ControlOrMeta+End');
    await page.keyboard.type('!');
    await page.keyboard.press('ControlOrMeta+s');
    await expect(unsavedMark(page)).toBeHidden();
    expect(await fileBytes(page, PATH)).toEqual(utf8(`${DOC}!`, { bom: true, crlf: true }));
  });

  test('コピーした文字列は原文（表の記号を含む）。全体を選ぶと、表は原文になる', async ({ page }) => {
    await openDoc(page, DOC);
    await page.evaluate(() => {
      const w = window as unknown as { __copied: string | null };
      w.__copied = null;
      document.addEventListener('copy', (e) => (w.__copied = e.clipboardData?.getData('text/plain') ?? null));
    });
    await page.keyboard.press('ControlOrMeta+a');
    await expect(tables(page)).toHaveCount(0);
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+c' : 'Control+c');
    expect(await page.evaluate(() => (window as unknown as { __copied: string | null }).__copied)).toBe(DOC);
    // 表の手前から表の途中までを選んでコピーしても、原文。
    await page.keyboard.press('ControlOrMeta+Home');
    for (let i = 0; i < 6; i++) await page.keyboard.press('Shift+ArrowDown');
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+c' : 'Control+c');
    const copied = await page.evaluate(() => (window as unknown as { __copied: string | null }).__copied);
    expect(copied!.startsWith('# 表の見本\n\n前の段落\n\n| 名前 | 数 | 備考 |\n|:-----|---:|:----:|')).toBe(true);
  });
});

// ---- Tab ----

test.describe('Tab / Shift+Tab でセルを移る (Q4)', () => {
  test('次のセル、前のセルの中身の頭へ。区切りの行を飛ばし、行をまたぎ、空のセルにも止まる。文書は変わらず、フォーカスは本文のまま', async ({ page }) => {
    await openDoc(page, DOC);
    await page.locator('.cm-md-table th').nth(0).click();
    expect((await selection(page)).head).toBe(cellEnd(0, '名前'));
    // 最初のセルの末尾から Tab: 2 つ目のセルの頭。以降、順に。
    const trace: number[] = [];
    for (let i = 0; i < 12; i++) {
      await page.keyboard.press('Tab');
      trace.push((await selection(page)).head);
    }
    expect(trace).toEqual(STARTS.slice(1));
    // 最後のセルで Tab（R12）: 表の最後に空の行を足し、その最初のセルへ移る（フォーカスは本文のまま）。Undo 1 回で戻る。
    // 最後の行は、見出しの列の数（3）より多いセルを持つ（余り）。足す行のセルの数は、見出しの列の数。
    await page.keyboard.press('Tab');
    expect(await docText(page)).toBe(DOC.replace(TABLE, `${TABLE}\n|  |  |  |`));
    expect((await selection(page)).head).toBe(T + TABLE.length + 1 + 2);
    expect(await focusedInEditor(page)).toBe(true);
    await page.keyboard.press('ControlOrMeta+z');
    expect(await docText(page)).toBe(DOC);
    expect((await selection(page)).head).toBe(STARTS[12]);
    // 戻る。
    const back: number[] = [];
    for (let i = 0; i < 12; i++) {
      await page.keyboard.press('Shift+Tab');
      back.push((await selection(page)).head);
    }
    expect(back).toEqual(STARTS.slice(0, 12).reverse());
    await page.keyboard.press('Shift+Tab');
    expect((await selection(page)).head).toBe(STARTS[0]);
    expect(await focusedInEditor(page)).toBe(true);
    expect(await docText(page)).toBe(DOC);
    await expect(unsavedMark(page)).toBeHidden();
    await expect(tables(page)).toHaveCount(0);
  });

  test('設定「常に表示」でも効く（表は原文のまま）', async ({ page }) => {
    await openDoc(page, DOC, { markupDisplay: 'always' });
    await page.keyboard.press('ControlOrMeta+Home');
    for (let i = 0; i < 4; i++) await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Home'); // 表の 1 行目の頭（| の前）
    expect((await selection(page)).head).toBe(T);
    await page.keyboard.press('Tab');
    expect((await selection(page)).head).toBe(STARTS[0]);
    await page.keyboard.press('Tab');
    expect((await selection(page)).head).toBe(STARTS[1]);
    expect(await docText(page)).toBe(DOC);
  });

  test('外側の | のない行は、行頭から最初のセルを数える', async ({ page }) => {
    const text = '前\n\na | b\n--|--\n1 | 2\n\n後';
    await openDoc(page, text, { markupDisplay: 'always' });
    await page.keyboard.press('ControlOrMeta+Home');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Home');
    const t = text.indexOf('a | b');
    const heads: number[] = [];
    for (let i = 0; i < 4; i++) {
      await page.keyboard.press('Tab');
      heads.push((await selection(page)).head);
    }
    // 行頭（最初のセルの中）から Tab: 2 つ目のセル、次の行の最初のセル、その行の 2 つ目。最後のセルでの Tab（R12）は、
    // 外側の `|` のある空の行を足して、その最初のセルへ移る（4 回目）。
    const added = text.indexOf('1 | 2') + '1 | 2'.length + 1;
    expect(heads).toEqual([t + 4, text.indexOf('1 | 2'), text.indexOf('1 | 2') + 4, added + 2]);
    expect(await docText(page)).toBe(text.replace('1 | 2', '1 | 2\n|  |  |'));
  });

  test('Esc の直後の Tab は、表の中でも本文の外へフォーカスを移す。Esc の後に別のキーを押せば、また Tab はセルを移る', async ({ page }) => {
    await openDoc(page, DOC);
    await page.locator('.cm-md-table th').nth(0).click();
    await page.keyboard.press('Escape');
    await page.keyboard.press('Tab');
    expect(await focusedInEditor(page)).toBe(false);
    expect(await docText(page)).toBe(DOC);
    await page.locator('.cm-content').focus();
    await page.keyboard.press('Escape');
    await page.keyboard.press('ArrowRight');
    const before = (await selection(page)).head;
    await page.keyboard.press('Tab');
    expect(await focusedInEditor(page)).toBe(true);
    expect((await selection(page)).head).not.toBe(before);
  });

  test('範囲を選んでいるとき、表の外、引用の中の表は、これまでの字下げのまま', async ({ page }) => {
    const text = `前の段落\n\n${TABLE}\n\n> | q |\n> |---|\n> | 1 |\n\n- 項目`;
    await openDoc(page, text);
    // 表の外（通常の段落）: 何も入らない。
    await page.keyboard.press('Tab');
    expect(await docText(page)).toBe(text);
    expect(await focusedInEditor(page)).toBe(true);
    // 範囲を選んだ 1 行（表の中）: 何も入らず、選択も変わらない。
    await page.locator('.cm-md-table td').nth(0).click();
    await page.keyboard.press('Home');
    await page.keyboard.press('Shift+End');
    const sel = await selection(page);
    await page.keyboard.press('Tab');
    expect(await selection(page)).toEqual(sel);
    expect(await docText(page)).toBe(text);
    // 複数行の選択（表の中）: 2 字下げ（これまでどおり）。
    await page.keyboard.press('Shift+ArrowDown');
    await page.keyboard.press('Tab');
    expect(await docText(page)).toBe(text.replace('| りんご |', '  | りんご |').replace('| みかん |', '  | みかん |'));
    await page.keyboard.press('ControlOrMeta+z');
    expect(await docText(page)).toBe(text);
    // 引用の中の表: 引用の段が深くなる（これまでどおり）。
    await page.locator('.cm-line', { hasText: /^\| 1 \|$/ }).click();
    await page.keyboard.press('Tab');
    expect(await docText(page)).toBe(text.replace('> | 1 |', '> > | 1 |'));
  });
});

// ---- 他の機能との組み合わせ ----

const caretState = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<{ caret: number; top: number; bottom: number; scrollerTop: number; scrollerBottom: number }>((resolve) =>
        requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            const scroller = document.querySelector('.cm-scroller')!.getBoundingClientRect();
            const caret = document.querySelector('.cm-cursor-primary, .cm-cursor')!.getBoundingClientRect();
            resolve({
              caret: (caret.top + caret.bottom) / 2 - (scroller.top + scroller.height / 2),
              top: caret.top,
              bottom: caret.bottom,
              scrollerTop: scroller.top,
              scrollerBottom: scroller.bottom,
            });
          }),
        ),
      ),
  );

const FILLER = Array.from({ length: 30 }, (_, i) => `段落 ${i}`).join('\n\n');
const LONG_DOC = `${FILLER}\n\n${TABLE}\n\n間の段落\n\n${FILLER}`;

test.describe('ほかの機能との組み合わせ (Q5)', () => {
  test('タイプライターモード: 表への出入りの後も、カーソルの行が中央に戻る', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 700 });
    await openDoc(page, LONG_DOC, { typewriterMode: true });
    // 表の 1 行上（空行）まで下がる（段落 30 個と、間の空行で 59 行。その次が空行、その次が表）。
    for (let i = 0; i < 59; i++) await page.keyboard.press('ArrowDown');
    await settleFrames(page);
    await expect(tables(page)).toHaveCount(1);
    expect(Math.abs((await caretState(page)).caret)).toBeLessThanOrEqual(6);
    // 入る（空行 → 見出しの行）。
    await page.keyboard.press('ArrowDown');
    await expect(tables(page)).toHaveCount(0);
    expect(Math.abs((await caretState(page)).caret), '入った直後').toBeLessThanOrEqual(6);
    // 表の中を下へ（Tab も）。1 回ごとに中央。
    for (const key of ['ArrowDown', 'ArrowDown', 'Tab', 'Tab']) {
      await page.keyboard.press(key);
      expect(Math.abs((await caretState(page)).caret), key).toBeLessThanOrEqual(6);
    }
    // 出る。
    for (let i = 0; i < 4; i++) await page.keyboard.press('ArrowDown');
    await expect(tables(page)).toHaveCount(1);
    expect(Math.abs((await caretState(page)).caret), '出た直後').toBeLessThanOrEqual(6);
    // 戻る。
    for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowUp');
    await expect(tables(page)).toHaveCount(0);
    expect(Math.abs((await caretState(page)).caret), '上から入った直後').toBeLessThanOrEqual(6);
    expect(await docText(page)).toBe(LONG_DOC);
  });

  test('通常のモード: 表に出入りしたとき、カーソルの行が画面の外へ出ない', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 600 });
    await openDoc(page, LONG_DOC);
    for (let i = 0; i < 55; i++) await page.keyboard.press('ArrowDown');
    await settleFrames(page);
    const inside = async () => {
      const s = await caretState(page);
      return s.top >= s.scrollerTop - 1 && s.bottom <= s.scrollerBottom + 1;
    };
    for (let i = 0; i < 12; i++) {
      await page.keyboard.press('ArrowDown');
      await settleFrames(page);
      expect(await inside(), `下へ ${i + 1} 回目`).toBe(true);
    }
    for (let i = 0; i < 12; i++) {
      await page.keyboard.press('ArrowUp');
      await settleFrames(page);
      expect(await inside(), `上へ ${i + 1} 回目`).toBe(true);
    }
    // クリックで入ったときも、カーソルの行は画面の中。
    await page.locator('.cm-md-table td').nth(4).click();
    await settleFrames(page);
    expect(await inside()).toBe(true);
  });

  test('フォーカスモード: 表示中の表は、カーソルの段落でなければ弱く表示され、カーソルの段落に続く表は弱くならない', async ({ page }) => {
    await openDoc(page, `前の段落\n\n${TABLE}\n\n後ろの段落\n続き\n| x |\n|---|\n| 1 |\n\n終わり`, { focusMode: true });
    const dimmed = () => tables(page).evaluateAll((els) => els.map((el) => [el.classList.contains('cm-dimmed-block'), getComputedStyle(el).opacity]));
    // カーソルは 1 行目。2 つの表は、どちらも別の段落。
    await expect.poll(dimmed).toEqual([
      [true, '0.38'],
      [true, '0.38'],
    ]);
    // カーソルを、2 つ目の表に続く段落（空行を挟まずに表が続く）へ。その表は、その段落の一部なので弱くならない。
    await page.locator('.cm-line', { hasText: '後ろの段落' }).click();
    await expect.poll(dimmed).toEqual([[true, '0.38'], [false, '1']]);
    // 1 つ目の表は弱いまま。フォーカスモードを使わない文書では弱くならない。
    await page.keyboard.press('ControlOrMeta+Home');
    await expect.poll(dimmed).toEqual([[true, '0.38'], [true, '0.38']]);
  });

  test('フォーカスモードを切ると、表は弱くならない', async ({ page }) => {
    await openDoc(page, DOC);
    await expect(tables(page)).toHaveCount(1);
    expect(await tables(page).evaluate((el) => [el.classList.contains('cm-dimmed-block'), getComputedStyle(el).opacity])).toEqual([false, '1']);
  });

  test('アウトライン: 表のある文書でも、見出しの項目を押すとその行へ移り、表は原文のまま', async ({ page }) => {
    const text = `# 見出し A\n\n${TABLE}\n\n## 見出し B\n\n${FILLER}\n\n# 見出し C\n\n${TABLE}\n\n終わり`;
    await openDoc(page, text);
    // 部品のパネルは右ペイン（R13。起動時は閉じている）に出る。上部バーのボタンで開く。
    await page.getByTestId('right-pane-toggle').click();
    await expect(page.getByTestId('right-pane')).toHaveAttribute('data-open', 'true');
    const items = page.getByTestId('plugin-panel-item');
    await expect(items).toHaveText(['見出し A', '見出し B', '見出し C']);
    await items.nth(2).click();
    expect((await selection(page)).head).toBe(text.indexOf('# 見出し C'));
    expect(await docText(page)).toBe(text);
    await expect(tables(page)).toHaveCount(1);
    await expect(unsavedMark(page)).toBeHidden();
  });
});
