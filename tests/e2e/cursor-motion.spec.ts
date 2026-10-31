import { expect, type Page } from '@playwright/test';
import { docTitle, launch, test, utf8 } from './helpers';

// カーソルの上下移動（ED-03）: 見出し・段落間隔・リスト・コードフェンスのどこでも、
// ArrowDown / ArrowUp は 1 押下でちょうど 1 行動く（行を飛ばさない、止まらない）。

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

for (const spacing of [0, 1, 3]) {
  test.describe(`カーソルの上下移動 (段落間隔 ${spacing}em)`, () => {
    test.beforeEach(async ({ page }) => {
      await launch(page, {
        files: { [DOC]: utf8(TEXT) },
        openPath: DOC,
        preferences: { theme: 'light', paragraphSpacing: spacing },
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
