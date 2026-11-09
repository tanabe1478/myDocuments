import { expect, type CDPSession, type Page } from '@playwright/test';
import {
  bridgeState,
  columnBox,
  docTitle,
  externalWrite,
  focusWindow,
  launch,
  test,
  unsavedMark,
  utf8,
} from './helpers';

// 書き心地とレイアウト（Run 5）: 視線の位置、段落間隔、ぶら下げインデント、Tab、字間、自動非表示の既定、
// 閉じる要求の取りこぼし（N1）、無題で終了したときの前回の文書（N4）。

test.describe.configure({ mode: 'parallel' });

const DOC = '/docs/feel.md';

/** DOC を開いた状態で起動する。 */
async function launchWith(page: Page, text: string, preferences: Record<string, unknown> = {}): Promise<void> {
  await launch(page, { files: { [DOC]: utf8(text) }, openPath: DOC, preferences: { theme: 'light', ...preferences } });
  await page.keyboard.press('ControlOrMeta+o');
  await expect(docTitle(page)).toHaveText('feel.md');
}

const editorText = (page: Page) => page.evaluate(() => window.__mdeE2E!.editor!.getText());

const lineHeights = (page: Page) =>
  page.locator('.cm-line').evaluateAll((els) => els.map((el) => el.getBoundingClientRect().height));

const panel = (page: Page) => page.getByRole('dialog', { name: '設定' });

/** 設定画面を開く（モーダル）。 */
async function openPanel(page: Page): Promise<void> {
  await page.getByTestId('settings-button').click();
  await expect(panel(page)).toBeVisible();
}

/** 長い日本語（1 行に収まらず、必ず折り返す）。 */
const LONG = '朝の光が川面に反射して、遠くの橋が白く霞んでいた。歩きながら考えたことを、帰ってからすぐに書き留めておく。'.repeat(2);

// ---- (1) 視線の位置 ----

test.describe('視線の位置 (1)', () => {
  const TEXT = Array.from({ length: 80 }, (_, i) => `${i + 1} 行目の本文です。`).join('\n');

  /** カーソルの下端・上端の、表示領域（.cm-scroller）の下端・上端からの距離。 */
  const caretGap = (page: Page) =>
    page.evaluate(() => {
      const scroller = document.querySelector('.cm-scroller')!.getBoundingClientRect();
      const caret = document.querySelector('.cm-cursor-primary, .cm-cursor')!.getBoundingClientRect();
      return { bottom: scroller.bottom - caret.bottom, top: caret.top - scroller.top, height: scroller.height };
    });

  test('(1) 長文の末尾で 10 行書き足しても、カーソルは表示領域の下 25% より上にある', async ({ page }) => {
    await launchWith(page, TEXT);
    await page.locator('.cm-content').click();
    await page.keyboard.press('ControlOrMeta+End');
    for (let i = 1; i <= 10; i++) {
      await page.keyboard.type(`\n追記 ${i} 行目`);
      const gap = await caretGap(page);
      expect(gap.bottom, `${i} 行目の後`).toBeGreaterThanOrEqual(gap.height * 0.25);
    }
    expect(await editorText(page)).toBe(`${TEXT}${Array.from({ length: 10 }, (_, i) => `\n追記 ${i + 1} 行目`).join('')}`);
  });

  test('(1) 上へ戻るときも、カーソルは表示領域の上 25% より下にある（先頭付近を除く）', async ({ page }) => {
    await launchWith(page, TEXT);
    await page.locator('.cm-content').click();
    await page.keyboard.press('ControlOrMeta+End');
    for (let i = 0; i < 50; i++) {
      await page.keyboard.press('ArrowUp');
      const gap = await caretGap(page);
      expect(gap.top, `${i + 1} 回目`).toBeGreaterThanOrEqual(gap.height * 0.25);
    }
  });

  test('(1) 表示領域の中ほどでの移動では、スクロールしない', async ({ page }) => {
    await launchWith(page, TEXT);
    await page.locator('.cm-content').click();
    await page.keyboard.press('ControlOrMeta+Home');
    for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowDown');
    const before = await page.locator('.cm-scroller').evaluate((el) => el.scrollTop);
    for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowDown');
    expect(await page.locator('.cm-scroller').evaluate((el) => el.scrollTop)).toBe(before);
  });
});

// ---- (2) 段落間隔 ----

test.describe('段落間隔 (2)', () => {
  const heightOfBlank = async (page: Page, text: string, prefs: Record<string, unknown>) => {
    await launchWith(page, text, prefs);
    // 行の装飾は、最初の測定の後に付く。
    await expect(page.locator('.cm-md-blank').first()).toBeVisible();
    return (await lineHeights(page))[1]!;
  };

  test('(2) 空行の高さは段落間隔で決まる: 0 / 既定（0.6 行）/ 最大（3 行）', async ({ page }) => {
    const line = 18 * 1.9;
    // 0: 4px まで詰まる（高さ 0 の行は、カーソルが見えず、選べない）。
    expect(await heightOfBlank(page, 'あ\n\nい', { paragraphSpacing: 0 })).toBeCloseTo(4, 0);
    // 既定（保存された設定なし）。
    const def = await heightOfBlank(page, 'あ\n\nい', {});
    expect(def).toBeCloseTo(line * 0.6, 0);
    expect(await heightOfBlank(page, 'あ\n\nい', { paragraphSpacing: 3 })).toBeCloseTo(line * 3, 0);
    // 全部が段落間隔の値の順になっている。
    expect(4).toBeLessThan(def);
    expect(def).toBeLessThan(line * 3);
  });

  test('(2) 空白だけの行（半角・全角）も空行として同じ高さ。コードフェンスの中の空行は本文 1 行のまま', async ({ page }) => {
    await launchWith(page, 'あ\n   \n　\n\nい\n```\n中\n\n```\n');
    const h = await lineHeights(page);
    const line = 18 * 1.9;
    for (const i of [1, 2, 3]) expect(h[i], `行 ${i}`).toBeCloseTo(line * 0.6, 0);
    expect(h[7], 'フェンスの中の空行').toBeCloseTo(line, 0);
    // 最後の空行（文書の末尾の改行の後）。
    expect(h.at(-1)).toBeCloseTo(line * 0.6, 0);
  });

  test('(2) 設定画面で変えると、空行と見出し前の余白が即座に変わる。行の間に隙間（margin）はない', async ({ page }) => {
    await launchWith(page, '# 見出し\n\n本文\n\n## 次の見出し');
    await expect(page.locator('.cm-md-blank').first()).toBeVisible();
    const headingPadding = () =>
      page.locator('.cm-md-h2').evaluate((el) => parseFloat(getComputedStyle(el).paddingTop));
    const line = 18 * 1.9;
    expect(await headingPadding()).toBeCloseTo(0.6 * line * 0.8, 0);

    await openPanel(page);
    await panel(page).getByLabel('段落間隔').fill('2');
    await expect.poll(async () => (await lineHeights(page))[1]).toBeCloseTo(line * 2, 0);
    expect(await headingPadding()).toBeCloseTo(2 * line * 0.8, 0);

    const gaps = await page.locator('.cm-line').evaluateAll((els) =>
      els.slice(1).map((el, i) => el.getBoundingClientRect().top - els[i]!.getBoundingClientRect().bottom),
    );
    for (const gap of gaps) expect(Math.abs(gap)).toBeLessThan(0.5);
  });

  test('(2) IME の変換中に空行へ書き始めても、変換中の文字が壊れず、確定後に行の高さが本文になる', async ({ page }) => {
    await launchWith(page, 'あ\n\n');
    await page.locator('.cm-content').click();
    await page.keyboard.press('ControlOrMeta+End');
    const client = await page.context().newCDPSession(page);
    for (const reading of ['に', 'にほ', 'にほん']) {
      await client.send('Input.imeSetComposition', { text: reading, selectionStart: reading.length, selectionEnd: reading.length });
      expect(await page.evaluate(() => Array.from(document.querySelectorAll('.cm-line')).map((l) => l.textContent).join('\n'))).toBe(
        `あ\n\n${reading}`,
      );
    }
    await client.send('Input.insertText', { text: '日本' });
    expect(await editorText(page)).toBe('あ\n\n日本');
    await expect.poll(async () => (await lineHeights(page)).at(-1)).toBeCloseTo(18 * 1.9, 0);
  });
});

// ---- (3) ぶら下げインデント ----

/** 行 index の、記号の後ろの本文の左端（1 行目）と、折り返した各行の左端。 */
async function hangEdges(page: Page, lineIndex: number, prefixLength: number) {
  return page.evaluate(
    ([index, prefixLen]) => {
      const line = document.querySelectorAll('.cm-line')[index!]!;
      const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
      const rects: Array<{ left: number; top: number }> = [];
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const text = node as Text;
        for (let i = 0; i < text.length; i++) {
          const range = document.createRange();
          range.setStart(text, i);
          range.setEnd(text, i + 1);
          const r = range.getClientRects()[0];
          if (r) rects.push({ left: r.left, top: r.top });
        }
      }
      const first = rects[prefixLen!]!;
      const lineLefts: number[] = [];
      let lastTop = first.top;
      for (const r of rects.slice(prefixLen!)) {
        if (r.top > lastTop + 5) {
          lineLefts.push(r.left);
          lastTop = r.top;
        }
      }
      return { firstLeft: first.left, wrappedLefts: lineLefts, contentLeft: line.getBoundingClientRect().left };
    },
    [lineIndex, prefixLength] as const,
  );
}

const HANG_DOC = [
  `- ${LONG}`,
  `  - ${LONG}`,
  `1. ${LONG}`,
  `10. ${LONG}`,
  `> ${LONG}`,
  `> > ${LONG}`,
  `> - ${LONG}`,
  `- [ ] ${LONG}`,
  `* ${LONG}`,
  LONG,
].join('\n');

const HANG_CASES: Array<[string, number, number]> = [
  ['箇条書き（-）', 0, 2],
  ['入れ子の箇条書き', 1, 4],
  ['番号付き（1.）', 2, 3],
  ['番号付き（10.）', 3, 4],
  ['引用（>）', 4, 2],
  ['入れ子の引用（> >）', 5, 4],
  ['引用の中の箇条書き', 6, 4],
  ['タスク（- [ ]）', 7, 6],
  ['箇条書き（*）', 8, 2],
];

for (const focusMode of [false, true]) {
  test.describe(`ぶら下げインデント (3)${focusMode ? '（フォーカスモード ON）' : ''}`, () => {
    test.beforeEach(async ({ page }) => {
      // 折り返した行をすべて描画できる高さ（CodeMirror は表示範囲の外の行を描画しない）。
      await page.setViewportSize({ width: 1280, height: 2600 });
      // 記号を見せている行の配置の検査（「常に表示」）。記号を隠した行の配置は live-markup.spec.ts。
      await launchWith(page, HANG_DOC, { focusMode, markupDisplay: 'always' });
      await expect(page.locator('.cm-line')).toHaveCount(10);
    });

    for (const [name, index, prefixLength] of HANG_CASES) {
      test(`(3) ${name}: 折り返した行の左端が、1 行目の本文の左端に揃う（±2px）`, async ({ page }) => {
        const edges = await hangEdges(page, index, prefixLength);
        expect(edges.wrappedLefts.length, '折り返している').toBeGreaterThanOrEqual(1);
        for (const left of edges.wrappedLefts) expect(Math.abs(left - edges.firstLeft)).toBeLessThanOrEqual(2);
        // 記号の分だけ、行の左端より右にある。
        expect(edges.firstLeft - edges.contentLeft).toBeGreaterThan(5);
      });
    }

    test('(3) 記号のない段落は、折り返しても字下げされない', async ({ page }) => {
      const edges = await hangEdges(page, 9, 0);
      for (const left of edges.wrappedLefts) expect(Math.abs(left - edges.contentLeft)).toBeLessThanOrEqual(1);
    });

    test('(3) 折り返した行をクリックすると、その位置にカーソルが入る。選択もずれない', async ({ page }) => {
      await page.locator('.cm-content').click();
      await page.evaluate(() => {
        const w = window as unknown as { __sel: { anchor: number; head: number } };
        w.__sel = { anchor: 0, head: 0 };
        window.__mdeE2E!.editor!.onSelectionChange((s) => (w.__sel = { anchor: s.anchor, head: s.head }));
      });
      // 先頭の項目の 2 行目にある文字（記号の長さ 2 + 1 行目の字数より後ろ）の中心をクリックする。
      const target = await page.evaluate(() => {
        const line = document.querySelectorAll('.cm-line')[0]!;
        const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
        const rects: Array<{ x: number; y: number; top: number }> = [];
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          const text = node as Text;
          for (let i = 0; i < text.length; i++) {
            const range = document.createRange();
            range.setStart(text, i);
            range.setEnd(text, i + 1);
            const r = range.getClientRects()[0]!;
            rects.push({ x: r.left + r.width / 2, y: r.top + r.height / 2, top: r.top });
          }
        }
        const secondLine = rects.findIndex((r) => r.top > rects[2]!.top + 5);
        return { offset: secondLine + 4, ...rects[secondLine + 4]! };
      });
      await page.mouse.click(target.x, target.y);
      const head = () => page.evaluate(() => (window as unknown as { __sel: { head: number } }).__sel.head);
      expect(await head()).toBe(target.offset);

      // Shift+右 で 3 文字選択すると、選択はその 3 文字ぶん。
      await page.keyboard.press('Shift+ArrowRight');
      await page.keyboard.press('Shift+ArrowRight');
      await page.keyboard.press('Shift+ArrowRight');
      const sel = await page.evaluate(() => (window as unknown as { __sel: { anchor: number; head: number } }).__sel);
      expect(sel.head - sel.anchor).toBe(3);
    });
  });
}

test.describe('ぶら下げインデント (3) と IME', () => {
  test('(3)(9) フォーカスモード ON でも、リストの行で IME の変換ができ、変換中の本文が壊れない', async ({ page }) => {
    await launchWith(page, `- ${LONG}\n- 次の項目`, { focusMode: true, markupDisplay: 'always' });
    await page.locator('.cm-content').click();
    // 先頭の項目の、記号の直後。
    await page.keyboard.press('ControlOrMeta+Home');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    const client: CDPSession = await page.context().newCDPSession(page);
    const lineText = () =>
      page.evaluate(() => Array.from(document.querySelectorAll('.cm-line')).map((l) => l.textContent ?? ''));
    for (const reading of ['に', 'にほん', 'にほんご']) {
      await client.send('Input.imeSetComposition', { text: reading, selectionStart: reading.length, selectionEnd: reading.length });
      expect((await lineText())[0]).toBe(`- ${reading}${LONG}`);
      expect((await lineText())[1]).toBe('- 次の項目');
    }
    await client.send('Input.insertText', { text: '日本語' });
    expect(await editorText(page)).toBe(`- 日本語${LONG}\n- 次の項目`);
    // 確定後も、折り返した行は 1 行目の本文に揃っている。
    const edges = await hangEdges(page, 0, 2);
    for (const left of edges.wrappedLefts) expect(Math.abs(left - edges.firstLeft)).toBeLessThanOrEqual(2);
    // フォーカスモード: カーソルのある項目以外は弱く表示されたまま。
    const dim = await page.locator('.cm-line').evaluateAll((els) => els.map((el) => el.classList.contains('cm-md-dim')));
    expect(dim).toEqual([false, true]);
  });
});

// ---- (4) Tab / Shift+Tab ----

test.describe('Tab でのインデント (4)', () => {
  test('(4) リストで Tab を押すとインデントが増え、Shift+Tab で戻る', async ({ page }) => {
    await launch(page);
    await page.locator('.cm-content').click();
    await page.keyboard.type('- a');
    await page.keyboard.press('Enter');
    await page.keyboard.press('Tab');
    await page.keyboard.type('b');
    expect(await editorText(page)).toBe('- a\n  - b');
    await expect(page.locator('.cm-content')).toBeFocused();

    await page.keyboard.press('Shift+Tab');
    expect(await editorText(page)).toBe('- a\n- b');
    // これ以上は戻らない。フォーカスは本文のまま。
    await page.keyboard.press('Shift+Tab');
    expect(await editorText(page)).toBe('- a\n- b');
    await expect(page.locator('.cm-content')).toBeFocused();
  });

  test('(4) 番号付きリストは記号の幅ぶん、引用は段が 1 つ深くなる', async ({ page }) => {
    await launch(page);
    await page.locator('.cm-content').click();
    await page.keyboard.type('1. a');
    await page.keyboard.press('Enter');
    await page.keyboard.press('Tab');
    await page.keyboard.type('b');
    expect(await editorText(page)).toBe('1. a\n   2. b');
    await page.keyboard.press('Shift+Tab');
    expect(await editorText(page)).toBe('1. a\n2. b');

    await page.keyboard.press('ControlOrMeta+a');
    await page.keyboard.type('> q');
    await page.keyboard.press('Tab');
    expect(await editorText(page)).toBe('> > q');
    await page.keyboard.press('Shift+Tab');
    expect(await editorText(page)).toBe('> q');
  });

  test('(4) 複数行を選んで Tab / Shift+Tab すると、選んだ行がそろってインデントされる', async ({ page }) => {
    await launch(page);
    await page.locator('.cm-content').click();
    await page.keyboard.type('- a');
    await page.keyboard.press('Enter');
    await page.keyboard.type('b');
    await page.keyboard.press('Enter');
    await page.keyboard.type('c');
    expect(await editorText(page)).toBe('- a\n- b\n- c');
    await page.keyboard.press('ControlOrMeta+a');
    await page.keyboard.press('Tab');
    expect(await editorText(page)).toBe('  - a\n  - b\n  - c');
    await page.keyboard.press('Shift+Tab');
    expect(await editorText(page)).toBe('- a\n- b\n- c');
    // 一部の行だけ。
    await page.keyboard.press('ControlOrMeta+Home');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Shift+ArrowDown');
    await page.keyboard.press('Shift+End');
    await page.keyboard.press('Tab');
    expect(await editorText(page)).toBe('- a\n  - b\n  - c');
  });

  test('(4) リストでも引用でもない行では、Tab はタブ文字を入れず、フォーカスも動かさない', async ({ page }) => {
    await launch(page);
    await page.locator('.cm-content').click();
    await page.keyboard.type('ふつうの段落');
    await page.keyboard.press('Tab');
    expect(await editorText(page)).toBe('ふつうの段落');
    await expect(page.locator('.cm-content')).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    expect(await editorText(page)).toBe('ふつうの段落');
    await expect(page.locator('.cm-content')).toBeFocused();
  });

  test('(4) Esc の直後の Tab は、本文の外へフォーカスを移す。本文は変わらない', async ({ page }) => {
    await launch(page);
    await page.locator('.cm-content').click();
    await page.keyboard.type('- a');
    await page.keyboard.press('Escape');
    await page.keyboard.press('Tab');
    await expect(page.locator('.cm-content')).not.toBeFocused();
    await expect(page.getByTestId('char-count')).toBeFocused();
    expect(await editorText(page)).toBe('- a');
  });

  test('(4) Esc の後に別のキーを押したら、Tab はまたインデントになる。Esc → Shift+Tab は逆向きに出る', async ({ page }) => {
    await launch(page);
    await page.locator('.cm-content').click();
    await page.keyboard.type('- a');
    await page.keyboard.press('Escape');
    await page.keyboard.type('b');
    await page.keyboard.press('Tab');
    expect(await editorText(page)).toBe('  - ab');
    await expect(page.locator('.cm-content')).toBeFocused();

    // 部品のパネルは最初の描画のあとに登録されるので、ボタンが出るのを待ってから、フォーカスの順序を確かめる。
    await expect(page.getByTestId('right-pane-toggle')).toBeVisible();
    await page.keyboard.press('Escape');
    await page.keyboard.press('Shift+Tab');
    await expect(page.locator('.cm-content')).not.toBeFocused();
    // 本文の直前にフォーカスできるのは、上部バーの最後の部品。部品のパネルがあるとき（同梱のアウトライン）は、
    // 歯車の右にある右ペインの開閉ボタン（R13）。パネルが 1 つもなければ設定ボタン。
    await expect(page.getByTestId('right-pane-toggle')).toBeFocused();
    expect(await editorText(page)).toBe('  - ab');
  });

  test('(4) F6 の移動は今までどおり使える', async ({ page }) => {
    await launch(page);
    await page.locator('.cm-content').click();
    await page.keyboard.press('F6');
    await expect(page.getByTestId('sidebar-toggle')).toBeFocused();
    await page.keyboard.press('F6');
    await expect(page.getByTestId('char-count')).toBeFocused();
    await page.keyboard.press('F6');
    await expect(page.locator('.cm-content')).toBeFocused();
  });
});

// ---- (6) 字間・行長の目安・長い URL ----

test.describe('字間と行長 (6)', () => {
  test('(6) 既定の字間は 0.02em。設定画面で変えると computed style に反映され、保存され、再読み込み後も残る', async ({ page }) => {
    await launch(page, { preferences: { theme: 'light' } });
    await expect(page.locator('.cm-content')).toHaveCSS('letter-spacing', '0.36px');
    await openPanel(page);
    await panel(page).getByLabel('字間').fill('0.1');
    await expect(page.locator('.cm-content')).toHaveCSS('letter-spacing', '1.8px');
    await expect.poll(() => page.evaluate(() => (window.__mdeE2E!.savedPreferences.at(-1) as { letterSpacing?: number } | undefined)?.letterSpacing)).toBe(0.1);

    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-ready', 'true');
    await expect(page.locator('.cm-content')).toHaveCSS('letter-spacing', '1.8px');
  });

  test('(6) 見出しの字間は、見出しの文字サイズに比例する', async ({ page }) => {
    await launchWith(page, '# 見出し\n本文');
    const spacing = (selector: string) => page.locator(selector).evaluate((el) => parseFloat(getComputedStyle(el).letterSpacing));
    expect(await spacing('.cm-md-h1')).toBeCloseTo(0.02 * 18 * 1.75, 2);
    expect(await spacing('.cm-line:not(.cm-md-h1)')).toBeCloseTo(0.36, 2);
  });

  test('(6) 設定画面に「1 行 約 N 字」が出て、実際の行の幅と文字サイズ・字間から求めた値と一致する', async ({ page }) => {
    await launch(page, { preferences: { theme: 'light' } });
    await openPanel(page);
    const shown = async () => {
      const text = await page.getByTestId('chars-per-line').innerText();
      return Number(/約\s*(\d+)\s*字/.exec(text)![1]);
    };
    // 実際の行の幅は、最大幅の変更で動く（描画の途中を測らないよう、poll の中で比べる）。
    const diff = async (fontSize: number, spacing: number) =>
      (await shown()) - Math.floor((await columnBox(page)).width / (fontSize * (1 + spacing)) + 1e-6);

    expect(await diff(18, 0.02)).toBe(0);
    expect(await shown()).toBeGreaterThanOrEqual(35);
    expect(await shown()).toBeLessThanOrEqual(38);

    await panel(page).getByLabel('文字サイズ').fill('24');
    await expect.poll(() => diff(24, 0.02)).toBe(0);
    expect(await shown()).toBe(Math.floor(680 / (24 * 1.02)));
    await panel(page).getByLabel('字間').fill('0.1');
    await expect.poll(() => diff(24, 0.1)).toBe(0);
    await panel(page).getByLabel('本文の最大幅').fill('900');
    // 最大幅 900 は 1280px の窓に収まる。行の幅が 900 になり、表示の字数も追従する。
    await expect.poll(async () => Math.round((await columnBox(page)).width)).toBe(900);
    await expect.poll(() => diff(24, 0.1)).toBe(0);
  });

  test('(6) 長い URL と英単語は、本文の幅で折り返し、はみ出さない', async ({ page }) => {
    const url = `https://example.com/${'a-very-long-path-segment/'.repeat(8)}?q=${'x'.repeat(60)}`;
    await launchWith(page, `見出し\n\n${url}\n\n${'Supercalifragilistic'.repeat(6)}`);
    const overflow = await page.evaluate(() => {
      const content = document.querySelector('.cm-content')!;
      const cs = getComputedStyle(content);
      const right = content.getBoundingClientRect().right - parseFloat(cs.paddingRight);
      const maxLineRight = Math.max(
        ...Array.from(content.querySelectorAll('.cm-line')).flatMap((line) => {
          const range = document.createRange();
          range.selectNodeContents(line);
          return Array.from(range.getClientRects()).map((r) => r.right);
        }),
      );
      return { right, maxLineRight, scrollWidth: document.querySelector('.cm-scroller')!.scrollWidth, clientWidth: document.querySelector('.cm-scroller')!.clientWidth };
    });
    expect(overflow.maxLineRight).toBeLessThanOrEqual(overflow.right + 1);
    expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth);
  });
});

// ---- (7) 自動非表示の既定 ----

test.describe('自動非表示の既定 (7)', () => {
  test('(7) 保存された設定がない初回起動で、入力を始めるとバーが隠れる', async ({ page }) => {
    await launch(page);
    await page.locator('.cm-content').click();
    await expect(page.locator('.app')).toHaveAttribute('data-chrome', 'visible');
    await page.keyboard.type('書き始める');
    await expect(page.locator('.app')).toHaveAttribute('data-chrome', 'hidden');
    await expect.poll(() => page.locator('.topbar').evaluate((el) => getComputedStyle(el).opacity)).toBe('0');
  });

  test('(7) 保存済みの autoHideChrome=false は尊重される（入力しても隠れない）', async ({ page }) => {
    await launch(page, { preferences: { autoHideChrome: false } });
    await page.locator('.cm-content').click();
    await page.keyboard.type('書き始める');
    await page.waitForTimeout(600);
    await expect(page.locator('.app')).toHaveAttribute('data-chrome', 'visible');
  });

  test('(7) ほかの設定だけが保存されていて autoHideChrome が無いときも、既定（隠れる）になる', async ({ page }) => {
    await launch(page, { preferences: { theme: 'dark', fontSizePx: 20 } });
    await page.locator('.cm-content').click();
    await page.keyboard.type('書き始める');
    await expect(page.locator('.app')).toHaveAttribute('data-chrome', 'hidden');
  });
});

// ---- (8) N1 / N4 ----

test.describe('終了まわりの不具合 (8)', () => {
  test('(8) N1: フォーカス時の外部変更の確認と同時に閉じる要求が来ても、確認ダイアログが出る', async ({ page }) => {
    await launchWith(page, '元の本文');
    await page.locator('.cm-content').click();
    await page.keyboard.press('ControlOrMeta+End');
    await page.keyboard.type('追記');
    await expect(unsavedMark(page)).toBeVisible();

    // 確認（checkDocument）に時間がかかる間に、閉じる要求を送る。
    await externalWrite(page, DOC, '外部の版', { notify: false });
    await page.evaluate(() => (window.__mdeE2E!.checkDelayMs = 600));
    await focusWindow(page);
    await page.evaluate(() => window.__mdeE2E!.requestClose());

    await expect(page.getByRole('alertdialog')).toContainText('feel.md');
    expect((await bridgeState(page)).closed).toBe(false);
    await page.getByTestId('discard-cancel').click();
    await expect(page.getByRole('alertdialog')).toHaveCount(0);
    expect((await bridgeState(page)).closed).toBe(false);
  });

  test('(8) N1: 未保存の変更がなければ、確認の後に閉じる', async ({ page }) => {
    await launchWith(page, '元の本文');
    await page.evaluate(() => (window.__mdeE2E!.checkDelayMs = 400));
    await focusWindow(page);
    await page.evaluate(() => window.__mdeE2E!.requestClose());
    await expect.poll(async () => (await bridgeState(page)).closed).toBe(true);
  });

  test('(8) N4: 新規文書に切り替えて終了すると、次回の起動で前の文書が開かない', async ({ page }) => {
    await launchWith(page, '前の文書の本文');
    expect((await bridgeState(page)).session).toEqual({ lastPath: DOC });

    await page.keyboard.press('ControlOrMeta+n');
    await expect(docTitle(page)).toHaveText('無題');
    await expect.poll(async () => (await bridgeState(page)).session).toEqual({ lastPath: null });

    await page.evaluate(() => window.__mdeE2E!.requestClose());
    await expect.poll(async () => (await bridgeState(page)).closed).toBe(true);

    // 次回の起動: 終了時の session を引き継いだ新しいアプリ。
    const session = (await bridgeState(page)).session;
    const next = await page.context().newPage();
    await launch(next, { files: { [DOC]: utf8('前の文書の本文') }, session });
    await next.waitForTimeout(400);
    await expect(docTitle(next)).toHaveText('無題');
    expect(await next.evaluate(() => window.__mdeE2E!.editor!.getText())).toBe('');
    expect((await bridgeState(next)).calls.open).toBe(0);
  });
});

// ---- 本文面 ----

test.describe('本文面 (W5)', () => {
  test('（本文に合わせる）枠線はなく、影がある。左右の内側余白は広い窓で 56px', async ({ page }) => {
    await launch(page, { preferences: { theme: 'light', surfaceWidth: 'text' } });
    const surface = page.getByTestId('canvas-surface');
    const style = await surface.evaluate((el) => {
      const cs = getComputedStyle(el);
      return { shadow: cs.boxShadow, border: cs.borderTopWidth, outline: cs.outlineStyle };
    });
    expect(style.border).toBe('0px');
    expect(style.shadow).not.toBe('none');
    expect(style.shadow).not.toMatch(/0px 0px 0px 1px/);
    const pad = await page.locator('.cm-content').evaluate((el) => parseFloat(getComputedStyle(el).paddingLeft));
    expect(pad).toBe(56);
  });

  test('（本文に合わせる）窓が狭いと、余白は行長を保てる範囲で縮み、最小 20px になる。本文面は本文と同じ幅', async ({ page }) => {
    await launch(page, { preferences: { theme: 'light', surfaceWidth: 'text' } });
    const measure = () =>
      page.evaluate(() => {
        const content = document.querySelector('.cm-content')!;
        const cs = getComputedStyle(content);
        const surface = document.querySelector('[data-testid="canvas-surface"]')!.getBoundingClientRect();
        const box = content.getBoundingClientRect();
        return {
          pad: parseFloat(cs.paddingLeft),
          column: box.width - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight),
          surfaceWidth: surface.width,
          contentWidth: box.width,
        };
      });
    const sizes: Array<[number, number, number]> = [
      // [窓の幅, 期待する余白, 期待する行の幅]
      [1280, 56, 680],
      [820, 56, 680],
      [740, 30, 680],
      [700, 20, 660],
      [480, 20, 440],
    ];
    for (const [width, pad, column] of sizes) {
      await page.setViewportSize({ width, height: 700 });
      await expect.poll(async () => Math.round((await measure()).pad), `${width}px`).toBe(pad);
      const m = await measure();
      expect(Math.round(m.column), `${width}px の行の幅`).toBe(column);
      expect(Math.abs(m.surfaceWidth - m.contentWidth), `${width}px の本文面`).toBeLessThanOrEqual(1);
    }
  });
});
