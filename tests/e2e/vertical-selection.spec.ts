import { expect, type Page } from '@playwright/test';
import { docTitle, launch, test, utf8 } from './helpers';

// 上下キーの補正（verticalMotion.ts）が、CodeMirror 標準の動きと同じであること。
// R1: 範囲選択中の ArrowUp / ArrowDown は、選択の端へ畳む（Shift 付きは head だけを動かす）。
// R2: 低い空行を飛ばさない補正が、行単位の上下移動キー全部（Shift 付き、mac の Ctrl-p / Ctrl-n を含む）に効く。

const DOC = '/docs/vertical.md';

async function open(page: Page, text: string, preferences: Record<string, unknown> = {}): Promise<void> {
  await launch(page, { files: { [DOC]: utf8(text) }, openPath: DOC, preferences: { theme: 'light', ...preferences } });
  await page.keyboard.press('ControlOrMeta+o');
  await expect(docTitle(page)).toHaveText('vertical.md');
  await page.locator('.cm-content').click();
}

/** editor の選択を、通知から追う（初期値は先頭のカーソル）。 */
async function trackSelection(page: Page): Promise<() => Promise<{ anchor: number; head: number }>> {
  await page.evaluate(() => {
    const w = window as unknown as { __sel: { anchor: number; head: number } };
    w.__sel = { anchor: 0, head: 0 };
    window.__mdeE2E!.editor!.onSelectionChange((s) => {
      w.__sel = { anchor: s.anchor, head: s.head };
    });
  });
  return () => page.evaluate(() => (window as unknown as { __sel: { anchor: number; head: number } }).__sel);
}

// ---- R1: 範囲選択中の上下キー ----

const SIMPLE = ['aaaa', 'bbbb', 'cccc', 'dddd', 'eeee'].join('\n');
// 各行の先頭の位置（1 行は 4 文字 + 改行）。
const START = [0, 5, 10, 15, 20];

test.describe('範囲選択中の上下キー（CodeMirror 標準と同じ）', () => {
  test('ArrowDown は、下向きに選んだ範囲を末尾へ畳む', async ({ page }) => {
    await open(page, SIMPLE);
    await page.keyboard.press('ControlOrMeta+Home');
    const sel = await trackSelection(page);
    for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Shift+ArrowUp');
    await page.keyboard.press('Shift+ArrowUp');
    expect(await sel()).toEqual({ anchor: START[3], head: START[1] });
    await page.keyboard.press('ArrowDown');
    // 標準は、選択の末尾（4 行目の行頭）に畳む。head（2 行目）から 1 行下ではない。
    expect(await sel()).toEqual({ anchor: START[3], head: START[3] });
  });

  test('ArrowUp は、下向きに選んだ範囲を先頭へ畳む', async ({ page }) => {
    await open(page, SIMPLE);
    await page.keyboard.press('ControlOrMeta+Home');
    const sel = await trackSelection(page);
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Shift+ArrowDown');
    await page.keyboard.press('Shift+ArrowDown');
    expect(await sel()).toEqual({ anchor: START[1], head: START[3] });
    await page.keyboard.press('ArrowUp');
    expect(await sel()).toEqual({ anchor: START[1], head: START[1] });
  });

  test('ArrowUp は、上向きに選んだ範囲を先頭へ畳む', async ({ page }) => {
    await open(page, SIMPLE);
    await page.keyboard.press('ControlOrMeta+Home');
    const sel = await trackSelection(page);
    for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Shift+ArrowUp');
    await page.keyboard.press('Shift+ArrowUp');
    await page.keyboard.press('ArrowUp');
    expect(await sel()).toEqual({ anchor: START[1], head: START[1] });
  });

  test('Shift+ArrowUp / Shift+ArrowDown は anchor を残して head を 1 行ずつ動かす', async ({ page }) => {
    await open(page, SIMPLE);
    await page.keyboard.press('ControlOrMeta+Home');
    const sel = await trackSelection(page);
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Shift+ArrowDown');
    expect(await sel()).toEqual({ anchor: START[1], head: START[2] });
    await page.keyboard.press('Shift+ArrowDown');
    expect(await sel()).toEqual({ anchor: START[1], head: START[3] });
    await page.keyboard.press('Shift+ArrowUp');
    await page.keyboard.press('Shift+ArrowUp');
    expect(await sel()).toEqual({ anchor: START[1], head: START[1] });
    await page.keyboard.press('Shift+ArrowUp');
    expect(await sel()).toEqual({ anchor: START[1], head: START[0] });
  });

  test('先頭行の ArrowUp は行頭へ、末尾行の ArrowDown は行末へ動く（標準と同じ）', async ({ page }) => {
    await open(page, SIMPLE);
    await page.keyboard.press('ControlOrMeta+Home');
    const sel = await trackSelection(page);
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowUp');
    expect(await sel()).toEqual({ anchor: 0, head: 0 });
    await page.keyboard.press('ControlOrMeta+End');
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('ArrowDown');
    expect(await sel()).toEqual({ anchor: SIMPLE.length, head: SIMPLE.length });
  });
});

// ---- R2: 行単位の上下移動キー全部で、低い行を飛ばさない ----

// 段落間隔を詰めた空行（高さ 4px 前後）、空白だけの行、コードフェンスの中の空行を含む。折り返さない短い行だけ。
const LINES = [
  '# 見出し1',
  '本文の1行目',
  '',
  '',
  '## 見出し2',
  '本文',
  '   ',
  '　',
  '',
  '本文の末尾付近',
  '```',
  'コード',
  '',
  '```',
  '最後の本文',
];
const TEXT = LINES.join('\n');
const LINE_START = LINES.map((_, i) => LINES.slice(0, i).reduce((n, l) => n + l.length + 1, 0));

type KeyPair = { name: string; down: string; up: string; macOnly?: boolean; shift?: boolean };
const KEYS: KeyPair[] = [
  { name: 'ArrowDown / ArrowUp', down: 'ArrowDown', up: 'ArrowUp' },
  { name: 'Shift+ArrowDown / Shift+ArrowUp', down: 'Shift+ArrowDown', up: 'Shift+ArrowUp', shift: true },
  { name: 'Ctrl-n / Ctrl-p', down: 'Control+n', up: 'Control+p', macOnly: true },
  { name: 'Shift-Ctrl-n / Shift-Ctrl-p', down: 'Control+Shift+N', up: 'Control+Shift+P', macOnly: true, shift: true },
];
const SPACINGS = [0, 0.2, 0.6, 3];

for (const keys of KEYS) {
  for (const spacing of SPACINGS) {
    test(`${keys.name} で、先頭から末尾まで 1 行ずつ動く (段落間隔 ${spacing}行)`, async ({ page, platform }) => {
      test.skip(!!keys.macOnly && platform !== 'mac', 'Ctrl-n / Ctrl-p の行移動は mac だけ（defaultKeymap の mac 指定）');
      await open(page, TEXT, { paragraphSpacing: spacing });
      const lineOf = (head: number) => LINE_START.filter((s) => s <= head).length - 1;
      const problems: string[] = [];

      // 下へ: 先頭から。
      await page.keyboard.press('ControlOrMeta+Home');
      let sel = await trackSelection(page);
      let expected = 0;
      for (let i = 0; i < LINES.length - 1; i++) {
        await page.keyboard.press(keys.down);
        expected += 1;
        const s = await sel();
        const actual = lineOf(s.head);
        if (actual !== expected) problems.push(`下 ${i + 1} 回目: 行 ${expected} のはずが行 ${actual}`);
        if (keys.shift && s.anchor !== 0) problems.push(`下 ${i + 1} 回目: anchor が動いた (${s.anchor})`);
        expected = actual;
      }

      // 上へ: 末尾から。
      await page.keyboard.press('ControlOrMeta+End');
      sel = await trackSelection(page);
      await page.evaluate((n) => ((window as unknown as { __sel: { anchor: number; head: number } }).__sel = { anchor: n, head: n }), TEXT.length);
      expected = LINES.length - 1;
      for (let i = 0; i < LINES.length - 1; i++) {
        await page.keyboard.press(keys.up);
        expected -= 1;
        const s = await sel();
        const actual = lineOf(s.head);
        if (actual !== expected) problems.push(`上 ${i + 1} 回目: 行 ${expected} のはずが行 ${actual}`);
        if (keys.shift && s.anchor !== TEXT.length) problems.push(`上 ${i + 1} 回目: anchor が動いた (${s.anchor})`);
        expected = actual;
      }
      expect(problems).toEqual([]);
    });
  }
}
