import { expect, type Page } from '@playwright/test';
import { docTitle, launch, test, utf8 } from './helpers';

// カーソルの上下移動（ED-03）: 見出し・段落間隔・リスト・引用・コードフェンスのどこでも、
// ArrowDown / ArrowUp は 1 押下でちょうど 1 行動く（行を飛ばさない、止まらない）。
// 空行の高さ（段落間隔で決まる）とぶら下げインデントの行を含む文書を、段落間隔 0 / 既定（0.6）/ 最大（3）で歩く。

const DOC = '/docs/motion.md';

// 行が折り返さない短い行だけで組む。見出しは H1〜H6、見出しの直前・直後に本文・空行・リスト・フェンスを置く。
const LINES = [
  '# 見出し1',
  '本文の1行目',
  '本文の2行目',
  '',
  '## 見出し2',
  '## 見出し2の続き',
  '本文',
  '### 見出し3',
  '',
  '#### 見出し4',
  '- 一つ目',
  '- 二つ目',
  '- 三つ目',
  '  - 入れ子の項目',
  '1. 番号付き',
  '> 引用の1行目',
  '> > 入れ子の引用',
  '   ',
  '\u3000',
  '',
  '##### 見出し5',
  '###### 見出し6',
  '本文の末尾付近',
  '```',
  '# コードの中',
  '',
  'コード',
  '```',
  '# 最後の見出し',
  '最後の本文',
];
const TEXT = LINES.join('\n');

/** カーソルの行番号（0 始まり）を、editor の選択変更通知から追う。 */
async function trackCaretLine(page: Page): Promise<() => Promise<number>> {
  await page.evaluate(() => {
    const w = window as unknown as { __caretHead: number };
    w.__caretHead = 0;
    window.__mdeE2E!.editor!.onSelectionChange((s) => {
      w.__caretHead = s.head;
    });
  });
  return () =>
    page.evaluate(() => {
      const head = (window as unknown as { __caretHead: number }).__caretHead;
      return window.__mdeE2E!.editor!.getText().slice(0, head).split('\n').length - 1;
    });
}

/** 押下ごとに、カーソルの行がちょうど 1 変わったかを集める。期待どおりなら空配列。 */
async function walk(page: Page, key: 'ArrowDown' | 'ArrowUp', from: number, steps: number): Promise<string[]> {
  const caretLine = await trackCaretLine(page);
  const delta = key === 'ArrowDown' ? 1 : -1;
  const problems: string[] = [];
  let expected = from;
  for (let i = 0; i < steps; i++) {
    await page.keyboard.press(key);
    expected += delta;
    const actual = await caretLine();
    if (actual !== expected) {
      problems.push(`${key} ${i + 1} 回目: 行 ${expected} のはずが行 ${actual}（${JSON.stringify(LINES[actual])}）`);
      expected = actual; // 以降は、ずれた位置からの 1 行ずつを見る
    }
  }
  return problems;
}

// [段落間隔, 行高, 文字サイズ]。段落間隔 0 は、行高や文字サイズが違っても、空行を飛ばさない。
const MOTION_CASES: Array<[number, number, number]> = [
  [0, 1.9, 18],
  [0.6, 1.9, 18],
  [3, 1.9, 18],
  [0, 1.4, 18],
  [0, 3, 18],
  [0, 1.9, 32],
  [0, 1.2, 18],
  [0.2, 1.9, 18],
];

for (const [spacing, lineHeight, fontSizePx] of MOTION_CASES) {
  test.describe(`カーソルの上下移動 (段落間隔 ${spacing}行・行高 ${lineHeight}・${fontSizePx}px)`, () => {
    test.beforeEach(async ({ page }) => {
      await launch(page, {
        files: { [DOC]: utf8(TEXT) },
        openPath: DOC,
        preferences: { theme: 'light', paragraphSpacing: spacing, lineHeight, fontSizePx },
      });
      await page.keyboard.press('ControlOrMeta+o');
      await expect(docTitle(page)).toHaveText('motion.md');
      await page.locator('.cm-content').click();
    });

    test('行と行の間に隙間がない（CodeMirror が測れない margin を行に付けていない）', async ({ page }) => {
      // CodeMirror は行の高さを getBoundingClientRect().height で測る（margin は含まれない）。
      // 隣り合う行の間に隙間があると、内部の高さ情報と描画がずれて、上下キーのカーソル移動が行を飛ばす。
      const gaps = await page.locator('.cm-line').evaluateAll((els) =>
        els.slice(1).map((el, i) => el.getBoundingClientRect().top - els[i]!.getBoundingClientRect().bottom),
      );
      expect(gaps.length).toBe(LINES.length - 1);
      for (const gap of gaps) expect(Math.abs(gap)).toBeLessThan(0.5);
    });

    test('ArrowDown で、先頭から末尾まで 1 行ずつ下りられる', async ({ page }) => {
      await page.keyboard.press('ControlOrMeta+Home');
      expect(await walk(page, 'ArrowDown', 0, LINES.length - 1)).toEqual([]);
    });

    test('ArrowUp で、末尾から先頭まで 1 行ずつ上れる', async ({ page }) => {
      await page.keyboard.press('ControlOrMeta+End');
      expect(await walk(page, 'ArrowUp', LINES.length - 1, LINES.length - 1)).toEqual([]);
    });
  });
}

// 折り返した項目の途中でも、ArrowDown は見た目の 1 行ずつ進む（ぶら下げインデントの行を飛ばさない）。
for (const spacing of [0, 0.6, 3]) {
  test(`折り返したリスト項目と引用を、見た目の 1 行ずつ上下できる (段落間隔 ${spacing}行)`, async ({ page }) => {
    const long = 'あいうえおかきくけこさしすせそたちつてとなにぬねのはひふへほまみむめもやゆよらりるれろわをん'.repeat(2);
    const doc = [`- ${long}`, '- 次の項目', '', `> ${long}`, '後の本文'].join('\n');
    await launch(page, { files: { [DOC]: utf8(doc) }, openPath: DOC, preferences: { theme: 'light', paragraphSpacing: spacing } });
    await page.keyboard.press('ControlOrMeta+o');
    await expect(docTitle(page)).toHaveText('motion.md');
    await page.locator('.cm-content').click();
    await page.keyboard.press('ControlOrMeta+Home');

    const visualLines = await page.locator('.cm-line').first().evaluate((el) => {
      const range = document.createRange();
      range.selectNodeContents(el);
      return new Set(Array.from(range.getClientRects()).map((r) => Math.round(r.top / 4))).size;
    });
    expect(visualLines).toBeGreaterThanOrEqual(2);

    const head = async () => page.evaluate(() => {
      const w = window as unknown as { __h: number };
      return w.__h;
    });
    await page.evaluate(() => {
      const w = window as unknown as { __h: number };
      w.__h = 0;
      window.__mdeE2E!.editor!.onSelectionChange((s) => (w.__h = s.head));
    });
    const firstLineEnd = doc.indexOf('\n');
    const seen: number[] = [];
    for (let i = 0; i < visualLines; i++) {
      await page.keyboard.press('ArrowDown');
      seen.push(await head());
    }
    // 見た目の行数だけ押すと、ちょうど次の項目に入る。途中では、同じ項目の中にいて、位置は進み続ける。
    expect(seen.at(-1)).toBeGreaterThan(firstLineEnd);
    for (const h of seen.slice(0, -1)) expect(h).toBeLessThanOrEqual(firstLineEnd);
    for (let i = 1; i < seen.length; i++) expect(seen[i]).toBeGreaterThan(seen[i - 1]!);
  });
}
