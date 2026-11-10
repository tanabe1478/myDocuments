import { expect, type Page } from '@playwright/test';
import { docTitle, launch, test, utf8 } from './helpers';

// ADR-006「列幅（Issue #3）」: 表示中の表の列幅と、本文の幅に入らない表の横スクロール。
// 列の最小幅（6em）、折り返し（word-break: normal と overflow-wrap: break-word）、表の囲み（.cm-md-table）だけの横スクロール、スクロールバーの操作。
// 所要時間を抑えるため、ホストの OS（chromium）と Windows の偽装（chromium-windows）だけで動かす。
// 横スクロールバーを実際に出して操作するため、headless の既定の --hide-scrollbars を外して起動する（表のスクロールバーは CSS で非オーバーレイ）。

test.describe.configure({ mode: 'parallel' });
test.use({ launchOptions: { ignoreDefaultArgs: ['--hide-scrollbars'] } });
test.beforeEach(({}, testInfo) => {
  test.skip(['chromium-mac', 'chromium-linux'].includes(testInfo.project.name), 'chromium と chromium-windows だけ');
});

const PATH = '/docs/layout.md';

async function openDoc(page: Page, text: string, preferences: Record<string, unknown> = {}, viewport = { width: 900, height: 800 }): Promise<void> {
  await page.setViewportSize(viewport);
  await launch(page, { files: { [PATH]: utf8(text) }, openPath: PATH, preferences: { theme: 'light', ...preferences } });
  await page.keyboard.press('ControlOrMeta+o');
  await expect(docTitle(page)).toHaveText('layout.md');
  // 文書の先頭にカーソルを置く（最初の行は表ではない）。
  await page.locator('.cm-content').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('ControlOrMeta+Home');
  await expect(page.locator('.cm-md-table')).toHaveCount(1);
}

const selection = (page: Page) => page.evaluate(() => window.__mdeE2E!.editor!.getSelection());
const tables = (page: Page) => page.locator('.cm-md-table');
const settleFrames = (page: Page) =>
  page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));

// Issue の形（合成の文。ユーザーの文書は使わない）: 見出しが日本語で 7 文字の列、コードの語の列、長い日本語の文の列。
const ISSUE = [
  '| ブロックタイプ | 役割 | 内容 | 重要なルール |',
  '|---|---|---|---|',
  '| `text` | アシスタントの返答の文章を表す | 利用者へ見せる説明の文。複数の段落に分かれることがある | 並べ替えてはいけない。順序は返答の順のまま保つ |',
  '| `tool_use` | 道具を呼び出す要求を表す | 道具の名前と引数をまとめた入力 | 直後の結果と対にして扱う。対がないまま次へ進めてはいけない |',
  '| `tool_result` | 道具の実行結果を表す | 呼び出しに対する出力と成功か失敗かの印 | 呼び出しの識別子が一致するものだけを結び付ける |',
  '| `thinking` | 途中の考えを表す | 要約された思考の文 | 利用者へ見せる必要はなく、保存するときだけ残す |',
].join('\n');
const WORDS = ['text', 'tool_use', 'tool_result', 'thinking'];

const columns = (n: number, cell: (i: number) => string) => {
  const row = (f: (i: number) => string) => `| ${Array.from({ length: n }, (_, i) => f(i)).join(' | ')} |`;
  return [row((i) => `列${i + 1}`), `|${'---|'.repeat(n)}`, row(cell)].join('\n');
};
/** 10 列。最小幅を並べても本文の幅に入らない。 */
const MANY = columns(10, (i) => `データの内容${i + 1}`);
/** 4 列。幅 900 のウィンドウでは入り、520 では入らない。 */
const FOUR = columns(4, (i) => `内容${i + 1}`);

const around = (table: string) => `先頭の段落\n\n${table}\n\n後ろの段落`;

/** 表の列幅と折り返しの計測。 */
function measure(page: Page) {
  return page.evaluate((words) => {
    const content = document.querySelector('.cm-content')!;
    const cs = getComputedStyle(content);
    const columnLeft = content.getBoundingClientRect().left + parseFloat(cs.paddingLeft);
    const columnRight = content.getBoundingClientRect().right - parseFloat(cs.paddingRight);
    const wrap = document.querySelector<HTMLElement>('.cm-md-table')!;
    const grid = wrap.querySelector('table')!.getBoundingClientRect();
    const lines = (el: Element) => {
      const range = document.createRange();
      range.selectNodeContents(el);
      return new Set(Array.from(range.getClientRects()).map((r) => Math.round(r.top))).size;
    };
    const cells = Array.from(wrap.querySelectorAll('th, td'));
    const scroller = document.querySelector('.cm-scroller')!;
    return {
      fontSize: parseFloat(cs.fontSize),
      columnLeft,
      columnRight,
      columnWidth: columnRight - columnLeft,
      gridWidth: grid.width,
      gridRight: grid.right,
      wrapRight: wrap.getBoundingClientRect().right,
      wrapClient: wrap.clientWidth,
      wrapScroll: wrap.scrollWidth,
      thickness: wrap.offsetHeight - wrap.clientHeight,
      columnWidths: Array.from(wrap.querySelectorAll('th')).map((th) => th.getBoundingClientRect().width),
      headLines: Array.from(wrap.querySelectorAll('th')).map(lines),
      brokenWords: cells.filter((c) => words.includes(c.textContent ?? '') && lines(c) > 1).map((c) => c.textContent),
      checkedWords: cells.filter((c) => words.includes(c.textContent ?? '')).length,
      pageScroll: scroller.scrollWidth,
      pageClient: scroller.clientWidth,
      rootScroll: document.documentElement.scrollWidth,
      rootClient: document.documentElement.clientWidth,
    };
  }, WORDS);
}

/** 表の囲みの、横スクロールバーの中央の座標（スクロールバーが出ているとき）。 */
const scrollbarBox = (page: Page) =>
  page.evaluate(() => {
    const wrap = document.querySelector<HTMLElement>('.cm-md-table')!;
    const r = wrap.getBoundingClientRect();
    const thickness = wrap.offsetHeight - wrap.clientHeight;
    return { left: r.left, right: r.right, y: r.bottom - thickness / 2, thickness, scrollLeft: wrap.scrollLeft, max: wrap.scrollWidth - wrap.clientWidth };
  });
const scrollLeft = (page: Page) => page.evaluate(() => document.querySelector('.cm-md-table')!.scrollLeft);

// ---- Q1: 列の幅 ----

test.describe('列の幅 (Q1)', () => {
  for (const width of [600, 900]) {
    test(`Issue の形の表（幅 ${width}px）: 列は 6 文字以上の幅、見出しは 2 行以内、語は途中で折れず、ページは横に動かない`, async ({ page }, testInfo) => {
      await openDoc(page, around(ISSUE), {}, { width, height: 900 });
      const m = await measure(page);
      await testInfo.attach(`issue-${width}.json`, { body: JSON.stringify(m, null, 1), contentType: 'application/json' });
      // 最小幅は 6em（中身）に、左右の padding の 1.4em と枠を足した幅。
      for (const w of m.columnWidths) expect(w).toBeGreaterThanOrEqual(7.4 * m.fontSize - 1);
      expect(m.headLines[0]).toBeLessThanOrEqual(2);
      expect(m.checkedWords).toBe(WORDS.length);
      expect(m.brokenWords).toEqual([]);
      // 日本語の長い文は、これまでどおり文字の間で折り返す（セルの中の行が 2 行以上）。
      expect(
        await page.evaluate(() => {
          const cell = document.querySelectorAll('.cm-md-table tbody tr')[0]!.children[3]!;
          const range = document.createRange();
          range.selectNodeContents(cell);
          return new Set(Array.from(range.getClientRects()).map((r) => Math.round(r.top))).size;
        }),
      ).toBeGreaterThanOrEqual(2);
      // ページ（エディタ全体）には、横スクロールが出ない。
      expect(m.pageScroll).toBeLessThanOrEqual(m.pageClient);
      expect(m.rootScroll).toBeLessThanOrEqual(m.rootClient);
      // 囲みは本文の列の中。表が列に入らないときだけ、囲みがスクロールできる。
      expect(m.wrapRight).toBeLessThanOrEqual(m.columnRight + 0.5);
      if (m.gridWidth > m.columnWidth + 0.5) expect(m.wrapScroll).toBeGreaterThan(m.wrapClient);
      else expect(m.wrapScroll).toBeLessThanOrEqual(m.wrapClient);
    });
  }

  test('本文の幅に入る表は、内容に合わせた幅のまま（本文の幅いっぱいに広げず、スクロールもしない）', async ({ page }) => {
    await openDoc(page, around('| 名前 | 数 |\n|---|---|\n| りんご | 3 |'));
    const m = await measure(page);
    expect(m.gridWidth).toBeLessThan(m.columnWidth / 2);
    expect(m.wrapScroll).toBeLessThanOrEqual(m.wrapClient);
    expect(m.thickness).toBe(0);
  });

  test('最小幅を並べても本文の幅に入らない表（10 列）は、囲みだけが横にスクロールし、ページは横に動かない', async ({ page }) => {
    await openDoc(page, around(MANY), {}, { width: 600, height: 800 });
    const m = await measure(page);
    expect(m.gridWidth).toBeGreaterThan(m.columnWidth);
    expect(m.wrapScroll).toBeGreaterThan(m.wrapClient);
    expect(m.wrapRight).toBeLessThanOrEqual(m.columnRight + 0.5);
    expect(m.thickness).toBeGreaterThan(1); // スクロールバーが囲みの下に出ている
    for (const w of m.columnWidths) expect(w).toBeGreaterThanOrEqual(7.4 * m.fontSize - 1);
    expect(m.headLines.every((n) => n === 1)).toBe(true);
    expect(await page.locator('.cm-md-table').evaluate((el) => getComputedStyle(el).overflowX)).toBe('auto');
    expect(m.pageScroll).toBeLessThanOrEqual(m.pageClient);
    expect(m.rootScroll).toBeLessThanOrEqual(m.rootClient);
  });

  test('長い URL や長い英字の語の表（3 列、狭い窓）: 語は折れず、囲みだけが横にスクロールし、ページは横に動かない', async ({ page }) => {
    const long = `https://example.com/${'a'.repeat(160)}`;
    const word = 'x'.repeat(100);
    await openDoc(page, around(`| 名前 | リンク | 備考 |\n|---|---|---|\n| 例 | ${long} | ${word} |`), {}, { width: 520, height: 800 });
    const m = await measure(page);
    expect(m.gridWidth).toBeGreaterThan(m.columnWidth);
    expect(m.wrapScroll).toBeGreaterThan(m.wrapClient);
    expect(m.thickness).toBeGreaterThan(1); // 囲みの下にスクロールバーが出ている
    expect(m.wrapRight).toBeLessThanOrEqual(m.columnRight + 0.5);
    expect(m.pageScroll).toBeLessThanOrEqual(m.pageClient);
    expect(m.rootScroll).toBeLessThanOrEqual(m.rootClient);
    for (const w of m.columnWidths) expect(w).toBeGreaterThanOrEqual(7.4 * m.fontSize - 1);
    // URL と長い英字の語は、途中で折れない（セルの中の行は 1 行）。CodeMirror の .cm-lineWrapping から継承される word-break: break-word は、normal で打ち消してある。
    const cells = await page.evaluate(() => {
      const wrap = document.querySelector('.cm-md-table')!;
      const lines = (el: Element) => {
        const range = document.createRange();
        range.selectNodeContents(el);
        return new Set(Array.from(range.getClientRects()).map((r) => Math.round(r.top))).size;
      };
      const tds = Array.from(wrap.querySelectorAll('tbody td'));
      return { wordBreak: getComputedStyle(tds[0]!).wordBreak, overflowWrap: getComputedStyle(tds[0]!).overflowWrap, lines: tds.map(lines) };
    });
    expect(cells.wordBreak).toBe('normal');
    expect(cells.overflowWrap).toBe('break-word');
    expect(cells.lines).toEqual([1, 1, 1]);
    // 列が多い表に長い URL があっても、同じ。
    await openDoc(page, around(columns(8, (i) => (i === 3 ? long : `内容${i + 1}`))), {}, { width: 520, height: 800 });
    const wide = await measure(page);
    expect(wide.wrapScroll).toBeGreaterThan(wide.wrapClient);
    expect(wide.pageScroll).toBeLessThanOrEqual(wide.pageClient);
    expect(wide.rootScroll).toBeLessThanOrEqual(wide.rootClient);
    expect(wide.wrapRight).toBeLessThanOrEqual(wide.columnRight + 0.5);
  });

  test('列の最小幅は em で決まり、文字の大きさの設定に追従する', async ({ page }) => {
    const ratios: number[] = [];
    for (const fontSizePx of [16, 24]) {
      await openDoc(page, around(MANY), { fontSizePx }, { width: 1200, height: 800 });
      const m = await measure(page);
      expect(m.fontSize).toBe(fontSizePx);
      ratios.push(m.columnWidths[0]! / m.fontSize);
    }
    expect(Math.abs(ratios[0]! - ratios[1]!)).toBeLessThan(0.2);
    expect(ratios[0]!).toBeGreaterThanOrEqual(7.4 - 0.1);
  });

  for (const theme of ['light', 'dark'] as const) {
    test(`${theme} テーマ: スクロールバーの色は枠の色（--md-color-border）に追従する`, async ({ page }) => {
      await openDoc(page, around(MANY), { theme }, { width: 600, height: 800 });
      const m = await page.evaluate(() => {
        const wrap = document.querySelector('.cm-md-table')!;
        const probe = document.createElement('div');
        probe.style.backgroundColor = 'var(--md-color-border)';
        document.body.append(probe);
        const border = getComputedStyle(probe).backgroundColor;
        probe.remove();
        return { thumb: getComputedStyle(wrap, '::-webkit-scrollbar-thumb').backgroundColor, border };
      });
      expect(m.thumb).toBe(m.border);
    });
  }
});

// ---- Q2: 操作 ----

test.describe('横スクロールと操作 (Q2)', () => {
  test('スクロールバーのドラッグで表が横に動き、カーソルは動かず、表は表示のまま', async ({ page }) => {
    await openDoc(page, around(MANY), {}, { width: 600, height: 800 });
    const before = await selection(page);
    const bar = await scrollbarBox(page);
    expect(bar.thickness).toBeGreaterThan(1);
    expect(bar.max).toBeGreaterThan(0);
    // つまみは左端にある。つまみを右へ 150px ドラッグ。
    await page.mouse.move(bar.left + 30, bar.y);
    await page.mouse.down();
    await page.mouse.move(bar.left + 120, bar.y, { steps: 5 });
    await page.mouse.move(bar.left + 180, bar.y, { steps: 5 });
    await page.mouse.up();
    expect(await scrollLeft(page)).toBeGreaterThan(100);
    expect(await selection(page)).toEqual(before);
    await expect(tables(page)).toHaveCount(1);
    // ページ（エディタ全体）は動かない。
    expect(await page.evaluate(() => document.querySelector('.cm-scroller')!.scrollLeft)).toBe(0);
    expect(await page.evaluate(() => window.__mdeE2E!.editor!.getText())).toBe(around(MANY));
  });

  test('スクロールバーの空き（トラック）の押下でも、カーソルは動かず、表は表示のまま。表の上の同じ x の押下は、カーソルを動かす', async ({ page }) => {
    await openDoc(page, around(MANY), {}, { width: 600, height: 800 });
    const before = await selection(page);
    const bar = await scrollbarBox(page);
    await page.mouse.click(bar.right - 20, bar.y);
    expect(await selection(page)).toEqual(before);
    await expect(tables(page)).toHaveCount(1);
    await expect.poll(() => scrollLeft(page)).toBeGreaterThan(0); // トラックの押下は、ページ単位で（なめらかに）動く
    expect(await selection(page)).toEqual(before);
    // スクロールが止まるのを待って、スクロールバーの外（右端の見えているセル）を押す。これまでどおり、カーソルが動いて原文になる。
    await page.waitForFunction(() => {
      const wrap = document.querySelector('.cm-md-table') as HTMLElement & { __last?: number };
      const settled = wrap.__last === wrap.scrollLeft;
      wrap.__last = wrap.scrollLeft;
      return settled;
    });
    const box = await page.evaluate(() => {
      const wrap = document.querySelector('.cm-md-table')!;
      const wr = wrap.getBoundingClientRect();
      const cell = Array.from(wrap.querySelectorAll('th')).find((th) => th.getBoundingClientRect().left >= wr.left && th.getBoundingClientRect().right <= wr.right)!;
      const r = cell.getBoundingClientRect();
      return { x: r.left + 20, y: r.top + r.height / 2 };
    });
    await page.mouse.click(box.x, box.y);
    await expect(tables(page)).toHaveCount(0);
  });

  test('トラックパッドの横スクロール（wheel の deltaX）で表が動く。縦のスクロールはエディタへ渡る', async ({ page }) => {
    const tail = Array.from({ length: 40 }, (_, i) => `後ろの段落 ${i + 1}`).join('\n\n');
    await openDoc(page, `先頭の段落\n\n${MANY}\n\n${tail}`, {}, { width: 600, height: 600 });
    const before = await selection(page);
    const box = (await page.locator('.cm-md-table td').nth(1).boundingBox())!;
    await page.mouse.move(box.x + 40, box.y + box.height / 2);
    await page.mouse.wheel(300, 0);
    await expect.poll(() => scrollLeft(page)).toBeGreaterThan(200);
    expect(await selection(page)).toEqual(before);
    await expect(tables(page)).toHaveCount(1);
    expect(await page.evaluate(() => document.querySelector('.cm-scroller')!.scrollLeft)).toBe(0);
    // 縦のホイールは、表の上でも、エディタがスクロールする。
    await page.mouse.wheel(0, 400);
    await expect.poll(() => page.evaluate(() => document.querySelector('.cm-scroller')!.scrollTop)).toBeGreaterThan(100);
  });

  test('横にスクロールした後のセルのクリックは、見えているセルの中身の末尾にカーソルを置く', async ({ page }) => {
    const text = around(MANY);
    await openDoc(page, text, {}, { width: 600, height: 800 });
    await page.locator('.cm-md-table').evaluate((el) => (el.scrollLeft = el.scrollWidth));
    expect(await scrollLeft(page)).toBeGreaterThan(0);
    // 一番右の列（10 列目）の本文のセルと、見出しのセル。
    const last = await page.evaluate(() => {
      const wrap = document.querySelector<HTMLElement>('.cm-md-table')!;
      const r = wrap.getBoundingClientRect();
      const td = wrap.querySelector('tbody tr')!.children[9]!.getBoundingClientRect();
      const th = wrap.querySelector('thead tr')!.children[9]!.getBoundingClientRect();
      return { wrapRight: r.right, tdLeft: td.left, tdRight: td.right, tdY: td.top + td.height / 2, thLeft: th.left, thY: th.top + th.height / 2 };
    });
    expect(last.tdRight).toBeLessThanOrEqual(last.wrapRight + 0.5); // 一番右が見えている
    await page.mouse.click(last.tdLeft + 20, last.tdY);
    await expect(tables(page)).toHaveCount(0);
    expect((await selection(page)).head).toBe(text.indexOf('データの内容10') + 'データの内容10'.length);
    // 表に戻して、見出しのセルも。
    await page.keyboard.press('ControlOrMeta+Home');
    await expect(tables(page)).toHaveCount(1);
    await page.locator('.cm-md-table').evaluate((el) => (el.scrollLeft = el.scrollWidth));
    const th = await page.evaluate(() => {
      const r = document.querySelector('.cm-md-table thead tr')!.children[9]!.getBoundingClientRect();
      return { x: r.left + 20, y: r.top + r.height / 2 };
    });
    await page.mouse.click(th.x, th.y);
    expect((await selection(page)).head).toBe(text.indexOf('列10') + '列10'.length);
  });

  test('スクロールバーの上（囲みの内側の領域の下端）の押下は、一番近いセルへ（これまでの、セルの外の押下と同じ）', async ({ page }) => {
    const text = around(MANY);
    await openDoc(page, text, {}, { width: 600, height: 800 });
    const y = await page.evaluate(() => {
      const wrap = document.querySelector<HTMLElement>('.cm-md-table')!;
      return wrap.getBoundingClientRect().top + wrap.clientHeight - 2; // 下の padding の中
    });
    const left = (await tables(page).boundingBox())!.x;
    await page.mouse.click(left + 10, y);
    await expect(tables(page)).toHaveCount(0);
    // 一番下の行（本文）の最初のセル。
    expect((await selection(page)).head).toBe(text.indexOf('データの内容1 ') + 'データの内容1'.length);
  });

  test('表の下の行のクリックと上下キーは、横スクロールバーの有無（窓の幅の変更で出入りする）でずれない', async ({ page }) => {
    const tail = ['後ろの段落 A', '後ろの段落 B', '後ろの段落 C'].join('\n\n');
    const text = `先頭の段落\n\n${FOUR}\n\n${tail}`;
    await openDoc(page, text, {}, { width: 900, height: 900 });
    const lineOf = (head: number) => text.slice(0, head).split('\n').length;
    const tableFirstLine = 3;
    const tableLastLine = tableFirstLine + 2;
    const clickEachTail = async () => {
      for (const label of ['後ろの段落 A', '後ろの段落 B', '後ろの段落 C', '先頭の段落']) {
        await page.locator('.cm-line', { hasText: label }).click();
        const head = (await selection(page)).head;
        const from = text.indexOf(label);
        expect(head).toBeGreaterThanOrEqual(from);
        expect(head).toBeLessThanOrEqual(from + label.length);
        await expect(tables(page)).toHaveCount(1);
      }
    };
    const arrows = async () => {
      await page.locator('.cm-line', { hasText: '後ろの段落 A' }).click();
      await page.keyboard.press('ArrowUp'); // 空行
      await page.keyboard.press('ArrowUp'); // 表の最後の行（原文になる）
      expect(lineOf((await selection(page)).head)).toBe(tableLastLine);
      await expect(tables(page)).toHaveCount(0);
      await page.locator('.cm-line', { hasText: '先頭の段落' }).click();
      await page.keyboard.press('ArrowDown'); // 空行
      await page.keyboard.press('ArrowDown'); // 表の見出しの行
      expect(lineOf((await selection(page)).head)).toBe(tableFirstLine);
      await page.keyboard.press('ControlOrMeta+Home');
      await expect(tables(page)).toHaveCount(1);
    };

    expect((await measure(page)).thickness).toBe(0); // 900px: スクロールバーなし
    await clickEachTail();
    await arrows();
    for (const width of [520, 900, 480]) {
      await page.setViewportSize({ width, height: 900 });
      await settleFrames(page);
      const m = await measure(page);
      // スクロールバーがあるのは、表が本文の列より広いときだけ（4 列は、520 と 480 では入らない。
      // 窓を広げて戻したときの列の幅は、アプリの画面の構成（サイドバーなど）にも左右されるので、幅の数字では決めない）。
      const overflowing = m.gridWidth > m.columnWidth + 0.5;
      if (width !== 900) expect(overflowing).toBe(true);
      expect(m.thickness > 1).toBe(overflowing);
      await clickEachTail();
      await arrows();
    }
  });

  test('表のスクロールバーが出ても、表の下の行は表と重ならず、表の高さの分だけ下にある', async ({ page }) => {
    const text = around(FOUR);
    await openDoc(page, text, {}, { width: 900, height: 900 });
    const gap = () =>
      page.evaluate(() => {
        const wrap = document.querySelector('.cm-md-table')!.getBoundingClientRect();
        const line = Array.from(document.querySelectorAll('.cm-line')).find((l) => l.textContent === '後ろの段落')!.getBoundingClientRect();
        return { wrapBottom: wrap.bottom, lineTop: line.top };
      });
    const wide = await gap();
    expect(wide.lineTop).toBeGreaterThanOrEqual(wide.wrapBottom - 0.5);
    await page.setViewportSize({ width: 480, height: 900 });
    await settleFrames(page);
    const narrow = await gap();
    expect((await measure(page)).thickness).toBeGreaterThan(1);
    expect(narrow.lineTop).toBeGreaterThanOrEqual(narrow.wrapBottom - 0.5);
    // 行ごとの隙間は、スクロールバーの有無で変わらない（空行 1 つ分）。
    expect(Math.abs(narrow.lineTop - narrow.wrapBottom - (wide.lineTop - wide.wrapBottom))).toBeLessThanOrEqual(1);
  });
});
