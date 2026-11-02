import { expect, type CDPSession, type Page } from '@playwright/test';
import { docTitle, fileBytes, launch, redoKeys, test, toast, unsavedMark, utf8, type Platform } from './helpers';

// Run 12（ADR-004）: カーソルのない行では Markdown の記法を隠して表示し、カーソルのある行（と選択にかかる行）では見せる。
// 設定画面の「記号の表示」で「常に表示」に戻せる。⌘/Ctrl+クリックで http/https のリンクを既定のブラウザで開く。
// 仕様 §5.2 の条件（IME・範囲選択への影響）は、ここで確かめる。IME は CDP による変換の模擬で、実 IME ではない。

test.describe.configure({ mode: 'parallel' });

const DOC = '/docs/live.md';

async function openDoc(page: Page, text: string, preferences: Record<string, unknown> = {}): Promise<void> {
  await launch(page, { files: { [DOC]: utf8(text) }, openPath: DOC, preferences: { theme: 'light', ...preferences } });
  await page.keyboard.press('ControlOrMeta+o');
  await expect(docTitle(page)).toHaveText('live.md');
  await page.locator('.cm-content').click();
}

/** 描画された各行のテキスト（隠した記号は含まれない）。 */
const renderedLines = (page: Page) =>
  page.locator('.cm-line').evaluateAll((els) => els.map((el) => el.textContent ?? ''));

const docText = (page: Page) => page.evaluate(() => window.__mdeE2E!.editor!.getText());

/** 先頭から ArrowDown で n 行目（0 始まり）へ。折り返さない行だけの文書で使う。 */
async function goToLine(page: Page, n: number): Promise<void> {
  await page.keyboard.press('ControlOrMeta+Home');
  for (let i = 0; i < n; i++) await page.keyboard.press('ArrowDown');
}

/** ブラウザ自身のコピーのキー（OS の偽装ではなく、実際のホスト OS に従う）。 */
const HOST_COPY = process.platform === 'darwin' ? 'Meta+c' : 'Control+c';

/** editor の選択を、通知から追う。 */
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

// ---- 対象の文書 ----

const DOC_A = [
  '# 見出し', // 0
  '', // 1
  '- 箇条書き', // 2
  '1. 番号付き', // 3
  '- [ ] 未完了', // 4
  '- [x] 完了', // 5
  '', // 6
  '[リンク](https://example.com "題")', // 7
  '<https://auto.example.com>', // 8
  'https://bare.example.com', // 9
  '**太字** *斜体* ~~消~~ `code`', // 10
  '> 引用', // 11
  '> > 入れ子', // 12
  '', // 13
  '```', // 14
  '# fence', // 15
  '- fence', // 16
  '```', // 17
  '', // 18
  '[ref]: https://ref.example.com', // 19
  '[参照][ref] ![画像](a.png) \\*not\\*', // 20
  '', // 21
  '終わり', // 22
];
const TEXT_A = DOC_A.join('\n');

/** カーソルのない行の表示（記法を隠したもの）。 */
const HIDDEN_A = [
  '見出し',
  '',
  '• 箇条書き',
  '1. 番号付き',
  ' 未完了',
  ' 完了',
  '',
  'リンク',
  'https://auto.example.com',
  'https://bare.example.com',
  '太字 斜体 消 code',
  '引用',
  '入れ子',
  '',
  '```',
  '# fence',
  '- fence',
  '```',
  '',
  '[ref]: https://ref.example.com',
  '[参照][ref] ![画像](a.png) \\*not\\*',
  '',
  '終わり',
];

/** active の行だけ記法を見せた、期待する表示。 */
const expectedLines = (active: number[]) => HIDDEN_A.map((hidden, i) => (active.includes(i) ? DOC_A[i]! : hidden));

// ---- (a) 隠す・見せる ----

test.describe('記法の表示 (a)', () => {
  test('(a) 既定では、カーソルのない行の記法が隠れ、•・チェックボックス・リンクの文字が表示される', async ({ page }) => {
    await openDoc(page, TEXT_A);
    await page.keyboard.press('ControlOrMeta+End');
    expect(await renderedLines(page)).toEqual(expectedLines([22]));

    // 本文は 1 バイトも変わらない。
    expect(await docText(page)).toBe(TEXT_A);
    await expect(unsavedMark(page)).toHaveCount(0);

    // • とチェックボックス（未完了・完了）の形。
    expect(await page.locator('.cm-md-bullet').allTextContents()).toEqual(['•']);
    await expect(page.locator('.cm-md-task')).toHaveCount(2);
    await expect(page.locator('.cm-md-task-done')).toHaveCount(1);

    // リンクの文字は、リンクの色と下線で表示される。
    const link = await page.evaluate(() => {
      const probe = document.createElement('span');
      probe.style.color = 'var(--md-color-link)';
      document.body.append(probe);
      const expectedColor = getComputedStyle(probe).color;
      probe.remove();
      const walker = document.createTreeWalker(document.querySelector('.cm-content')!, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        if (n.textContent === 'リンク') {
          const cs = getComputedStyle(n.parentElement!);
          return { color: cs.color, underline: cs.textDecorationLine, expectedColor };
        }
      }
      return null;
    });
    expect(link).not.toBeNull();
    expect(link!.color).toBe(link!.expectedColor);
    expect(link!.underline).toContain('underline');

    // 見出しの文字サイズと太さは、記号を隠しても変わらない。
    const heading = await page.locator('.cm-md-h1').evaluate((el) => {
      const cs = getComputedStyle(el);
      return { size: parseFloat(cs.fontSize), base: parseFloat(getComputedStyle(document.querySelector('.cm-scroller')!).fontSize) };
    });
    expect(heading.size).toBeGreaterThan(heading.base * 1.5);
  });

  test('(a) カーソルを動かすと、その行だけ記法が表示され、元の行は隠れる', async ({ page }) => {
    await openDoc(page, TEXT_A);
    for (const line of [0, 2, 4, 5, 7, 8, 10, 11, 12, 22]) {
      await goToLine(page, line);
      expect(await renderedLines(page), `行 ${line}`).toEqual(expectedLines([line]));
      expect(await docText(page)).toBe(TEXT_A);
    }
    // カーソル行では • もチェックボックスも出ない（記号が見える）。
    await goToLine(page, 2);
    await expect(page.locator('.cm-md-bullet')).toHaveCount(0);
    await goToLine(page, 4);
    await expect(page.locator('.cm-md-task')).toHaveCount(1);
    await goToLine(page, 7);
    await expect(page.locator('.cm-md-task')).toHaveCount(2);
  });

  test('(a) マウスのクリックでも、クリックした行だけ記法が表示される', async ({ page }) => {
    await openDoc(page, TEXT_A);
    await page.keyboard.press('ControlOrMeta+End');
    await page.locator('.cm-line').nth(10).click();
    expect(await renderedLines(page)).toEqual(expectedLines([10]));
    // チェックボックスの右の本文のクリックは、切り替えではなくカーソルを置く（Run 13: チェックボックス自体の切り替えは (k)）。本文は変わらない。
    await page.keyboard.press('ControlOrMeta+End');
    await page.locator('.cm-line').nth(4).click({ position: { x: 150, y: 8 } });
    expect(await docText(page)).toBe(TEXT_A);
    expect((await renderedLines(page))[4]).toBe('- [ ] 未完了');
    await expect(unsavedMark(page)).toHaveCount(0);
  });

  test('(a) frontmatter・コードフェンス・参照リンク・画像・エスケープは、そのまま表示される', async ({ page }) => {
    const text = '---\ntitle: **x**\ntags:\n  - a\n# comment\n---\n# 見出し\n- b\n\n終わり';
    await openDoc(page, text);
    await page.keyboard.press('ControlOrMeta+End');
    expect(await renderedLines(page)).toEqual(['---', 'title: **x**', 'tags:', '  - a', '# comment', '---', '見出し', '• b', '', '終わり']);
  });

  test('(a) .txt は、記法を隠さない（装飾なし）', async ({ page }) => {
    const path = '/docs/plain.txt';
    await launch(page, { files: { [path]: utf8('# a\n- b\n**c**\n\n終わり') }, openPath: path, preferences: { theme: 'light' } });
    await page.keyboard.press('ControlOrMeta+o');
    await expect(docTitle(page)).toHaveText('plain.txt');
    await page.locator('.cm-content').click();
    await page.keyboard.press('ControlOrMeta+End');
    expect(await renderedLines(page)).toEqual(['# a', '- b', '**c**', '', '終わり']);
    await expect(page.locator('.cm-md-bullet, .cm-md-task')).toHaveCount(0);
  });

  test('(a) 文書を開き直しても、設定どおりに隠す', async ({ page }) => {
    await openDoc(page, TEXT_A);
    await page.evaluate(() => window.__mdeE2E!.editor!.setText('# 一\n\n## 二\n\n- 三'));
    // 新しい文書のカーソルは先頭。
    expect(await renderedLines(page)).toEqual(['# 一', '', '二', '', '• 三']);
  });
});

// ---- (b) 選択にかかる行 ----

test.describe('選択にかかる行 (b)', () => {
  test('(b) 複数行にかかる選択では、選択にかかる全行で記法が表示される', async ({ page }) => {
    await openDoc(page, TEXT_A);
    await page.keyboard.press('ControlOrMeta+Home');
    for (let i = 0; i < 5; i++) await page.keyboard.press('Shift+ArrowDown');
    expect(await renderedLines(page)).toEqual(expectedLines([0, 1, 2, 3, 4, 5]));
    // 選択を縮めると、外れた行が隠れる。
    await page.keyboard.press('Shift+ArrowUp');
    await page.keyboard.press('Shift+ArrowUp');
    expect(await renderedLines(page)).toEqual(expectedLines([0, 1, 2, 3]));
    // 畳むと、カーソルのある行だけになる。
    await page.keyboard.press('ArrowRight');
    expect((await renderedLines(page)).filter((l, i) => l !== HIDDEN_A[i]).length).toBeLessThanOrEqual(1);
    expect(await docText(page)).toBe(TEXT_A);
  });

  test('(b) 選択をすべて選ぶと、全行で記法が表示される', async ({ page }) => {
    await openDoc(page, TEXT_A);
    await page.keyboard.press('ControlOrMeta+a');
    expect(await renderedLines(page)).toEqual(DOC_A);
  });

  test('(b) Shift+Ctrl-n / Shift+Ctrl-p（mac）でも、選択にかかる全行で表示される', async ({ page, platform }) => {
    test.skip(platform !== 'mac', 'Ctrl-n / Ctrl-p の行移動は mac だけ');
    await openDoc(page, TEXT_A);
    await page.keyboard.press('ControlOrMeta+Home');
    await page.keyboard.press('Control+Shift+N');
    await page.keyboard.press('Control+Shift+N');
    await page.keyboard.press('Control+Shift+N');
    expect(await renderedLines(page)).toEqual(expectedLines([0, 1, 2, 3]));
    await page.keyboard.press('Control+Shift+P');
    expect(await renderedLines(page)).toEqual(expectedLines([0, 1, 2]));
  });
});

// ---- (c) 保存されるテキストとコピー ----

test.describe('保存されるテキストとコピー (c)', () => {
  test('(c) 隠した状態で編集して保存しても、記法を含めて 1 バイトも変わらない', async ({ page }) => {
    await openDoc(page, TEXT_A);
    // いくつか行を巡ってから、最後の行に 1 文字足して保存する。
    for (const line of [0, 5, 10, 12, 22]) await goToLine(page, line);
    await page.keyboard.press('End');
    await page.keyboard.type('x');
    expect(await docText(page)).toBe(`${TEXT_A}x`);
    await page.keyboard.press('ControlOrMeta+s');
    await expect(unsavedMark(page)).toHaveCount(0);
    expect(await fileBytes(page, DOC)).toEqual(utf8(`${TEXT_A}x`));
  });

  test('(c) 選択してコピーした文字列に、隠していた記号が入る', async ({ page }) => {
    await openDoc(page, TEXT_A);
    await page.evaluate(() => {
      const w = window as unknown as { __copied: string | null };
      w.__copied = null;
      // CodeMirror の copy ハンドラの後（document の bubble）で、書き込まれた内容を読む。
      document.addEventListener('copy', (e) => (w.__copied = e.clipboardData?.getData('text/plain') ?? null));
    });
    const sel = await trackSelection(page);
    await goToLine(page, 7);
    await page.keyboard.press('Home');
    for (let i = 0; i < 3; i++) await page.keyboard.press('Shift+ArrowDown');
    await page.keyboard.press(HOST_COPY);
    const copied = await page.evaluate(() => (window as unknown as { __copied: string | null }).__copied);
    // 選択した範囲の文字列そのもの（隠していた記号を含む）。行 7〜9 は丸ごと入っている。
    const s = await sel();
    expect(copied).toBe(TEXT_A.slice(Math.min(s.anchor, s.head), Math.max(s.anchor, s.head)));
    expect(copied!.startsWith(`${DOC_A.slice(7, 10).join('\n')}\n`)).toBe(true);
    expect(copied).toContain('[リンク](https://example.com "題")\n<https://auto.example.com>\nhttps://bare.example.com\n');

    await page.keyboard.press('ControlOrMeta+a');
    await page.keyboard.press(HOST_COPY);
    expect(await page.evaluate(() => (window as unknown as { __copied: string | null }).__copied)).toBe(TEXT_A);
  });

  test('(c) 隠した行のあるまま Undo / Redo しても、本文が壊れない', async ({ page }) => {
    await openDoc(page, TEXT_A);
    await goToLine(page, 2);
    await page.keyboard.press('End');
    await page.keyboard.type('追記');
    await goToLine(page, 22);
    await page.keyboard.press('ControlOrMeta+z');
    expect(await docText(page)).toBe(TEXT_A);
    expect(await renderedLines(page)).toEqual(expectedLines([2]));
  });
});

// ---- (d) IME ----

const IME_DOC = ['前の行', '# 見出し', '- 項目', '> 引用', '後の行'].join('\n');
const IME_HIDDEN = ['前の行', '見出し', '• 項目', '引用', '後の行'];

async function imeSession(page: Page): Promise<CDPSession> {
  await openDoc(page, IME_DOC);
  return page.context().newCDPSession(page);
}

const compose = (client: CDPSession, text: string) =>
  client.send('Input.imeSetComposition', { text, selectionStart: text.length, selectionEnd: text.length });

/** 行の DOM 要素を覚えておき、あとで同じ要素のままか（作り直されていないか）を確かめる。 */
async function rememberLines(page: Page): Promise<void> {
  await page.evaluate(() => {
    (window as unknown as { __lineEls: Element[] }).__lineEls = Array.from(document.querySelectorAll('.cm-line'));
  });
}

const sameLineElements = (page: Page, indexes: number[]) =>
  page.evaluate((idx) => {
    const before = (window as unknown as { __lineEls: Element[] }).__lineEls;
    const now = Array.from(document.querySelectorAll('.cm-line'));
    return idx.every((i) => before[i] === now[i] && now[i]!.isConnected);
  }, indexes);

test.describe('IME の変換と記法の表示 (d)', () => {
  test('(d) 記法を隠した行の前の行で変換・確定しても、前後の行は切り替わらず、確定した文字列が正しい位置に入る', async ({ page }) => {
    const client = await imeSession(page);
    await goToLine(page, 0);
    await page.keyboard.press('End');
    expect(await renderedLines(page)).toEqual(['前の行', ...IME_HIDDEN.slice(1)]);
    await rememberLines(page);

    for (const reading of ['に', 'にほ', 'にほんご', '日本語']) {
      await compose(client, reading);
      expect(await renderedLines(page), reading).toEqual([`前の行${reading}`, ...IME_HIDDEN.slice(1)]);
      // 変換中は、ほかの行の DOM に触れない（作り直さない）。
      expect(await sameLineElements(page, [1, 2, 3, 4]), reading).toBe(true);
    }
    await client.send('Input.insertText', { text: '日本語' });
    expect(await docText(page)).toBe(['前の行日本語', '# 見出し', '- 項目', '> 引用', '後の行'].join('\n'));
    await page.waitForTimeout(150);
    expect(await renderedLines(page)).toEqual(['前の行日本語', ...IME_HIDDEN.slice(1)]);
    expect(await sameLineElements(page, [1, 2, 3, 4])).toBe(true);
  });

  test('(d) 見出しの行（記号が見えている）で、記号の直後に変換・確定する', async ({ page }) => {
    const client = await imeSession(page);
    await goToLine(page, 1);
    await page.keyboard.press('Home');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    expect(await renderedLines(page)).toEqual(['前の行', '# 見出し', ...IME_HIDDEN.slice(2)]);
    await rememberLines(page);

    for (const reading of ['に', 'にほん']) {
      await compose(client, reading);
      expect(await renderedLines(page), reading).toEqual(['前の行', `# ${reading}見出し`, ...IME_HIDDEN.slice(2)]);
      expect(await sameLineElements(page, [0, 2, 3, 4]), reading).toBe(true);
    }
    await client.send('Input.insertText', { text: '日本' });
    expect(await docText(page)).toBe(['前の行', '# 日本見出し', '- 項目', '> 引用', '後の行'].join('\n'));
    await page.waitForTimeout(150);
    expect(await renderedLines(page)).toEqual(['前の行', '# 日本見出し', ...IME_HIDDEN.slice(2)]);
  });

  test('(d) リストの行で、記号の直後に変換・確定する。確定後にカーソルを離れると、その行が隠れる', async ({ page }) => {
    const client = await imeSession(page);
    await goToLine(page, 2);
    await page.keyboard.press('Home');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    await rememberLines(page);
    for (const reading of ['に', 'にほん']) {
      await compose(client, reading);
      expect(await renderedLines(page), reading).toEqual(['前の行', '見出し', `- ${reading}項目`, '引用', '後の行']);
      expect(await sameLineElements(page, [0, 1, 3, 4]), reading).toBe(true);
    }
    await client.send('Input.insertText', { text: '日本' });
    expect(await docText(page)).toBe(['前の行', '# 見出し', '- 日本項目', '> 引用', '後の行'].join('\n'));
    await page.waitForTimeout(150);
    // カーソルが離れると、隠れる。
    await page.keyboard.press('ArrowDown');
    expect(await renderedLines(page)).toEqual(['前の行', '見出し', '• 日本項目', '> 引用', '後の行']);
  });

  test('(d) 引用の行・記法を含む行の末尾でも、確定した文字列が正しい位置に入り、変換を取り消すと元に戻る', async ({ page }) => {
    const client = await imeSession(page);
    await goToLine(page, 3);
    await page.keyboard.press('End');
    await compose(client, 'にほ');
    expect(await renderedLines(page)).toEqual(['前の行', '見出し', '• 項目', '> 引用にほ', '後の行']);
    await compose(client, '');
    expect(await docText(page)).toBe(IME_DOC);
    await compose(client, 'ご');
    await client.send('Input.insertText', { text: '語' });
    expect(await docText(page)).toBe(['前の行', '# 見出し', '- 項目', '> 引用語', '後の行'].join('\n'));
  });

  test('(d) 変換中の外部 setText は、表示の切り替えにかかわらず、変換の終了後に適用される', async ({ page }) => {
    const client = await imeSession(page);
    await goToLine(page, 0);
    await page.keyboard.press('End');
    await compose(client, 'にほん');
    await page.evaluate(() => window.__mdeE2E!.editor!.setText('# 外から\n\n- 読み込んだ'));
    await page.waitForTimeout(200);
    expect(await renderedLines(page)).toEqual(['前の行にほん', ...IME_HIDDEN.slice(1)]);
    await client.send('Input.insertText', { text: '日本' });
    await expect.poll(() => renderedLines(page)).toEqual(['# 外から', '', '• 読み込んだ']);
  });
});

// ---- (e) 範囲選択・移動 ----

test.describe('範囲選択と移動 (e)', () => {
  test('(e) Shift+矢印で、隠した記号をまたいで選択でき、選択した文字列が記号を含めて正しい', async ({ page }) => {
    await openDoc(page, TEXT_A);
    const sel = await trackSelection(page);
    await goToLine(page, 2);
    await page.keyboard.press('Home');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    for (let i = 0; i < 3; i++) await page.keyboard.press('Shift+ArrowDown');
    const s = await sel();
    const selected = TEXT_A.slice(Math.min(s.anchor, s.head), Math.max(s.anchor, s.head));
    expect(selected.startsWith('箇条書き\n1. 番号付き\n- [ ] 未完了\n')).toBe(true);
    expect(await renderedLines(page)).toEqual(expectedLines([2, 3, 4, 5]));

    // 左右の矢印で、記号の上を 1 文字ずつ通る（行頭の記号を飛ばさない）。
    await goToLine(page, 4);
    await page.keyboard.press('Home');
    const before = await sel();
    for (let i = 0; i < 6; i++) await page.keyboard.press('ArrowRight');
    const after = await sel();
    expect(after.head - before.head).toBe(6);
    expect(await renderedLines(page)).toEqual(expectedLines([4]));
  });

  test('(e) 左右の矢印で行をまたいでも、行の頭と末尾に正しく入る', async ({ page }) => {
    await openDoc(page, '# 見出し\n- 項目\n> 引用');
    const sel = await trackSelection(page);
    await page.keyboard.press('ControlOrMeta+Home');
    await page.keyboard.press('End');
    expect((await sel()).head).toBe('# 見出し'.length);
    await page.keyboard.press('ArrowRight');
    expect((await sel()).head).toBe('# 見出し\n'.length);
    expect(await renderedLines(page)).toEqual(['見出し', '- 項目', '引用']);
    await page.keyboard.press('ArrowLeft');
    expect((await sel()).head).toBe('# 見出し'.length);
    expect(await renderedLines(page)).toEqual(['# 見出し', '• 項目', '引用']);
  });

  test('(e) マウスのドラッグで、隠した行をまたいで選択でき、選択した文字列が記号を含めて正しい', async ({ page }) => {
    // 文書全体が画面に入る高さ（行 2 と行 5 をマウスで指せるように）。
    await page.setViewportSize({ width: 1280, height: 1500 });
    await openDoc(page, TEXT_A);
    await page.keyboard.press('ControlOrMeta+End');
    const sel = await trackSelection(page);
    // ドラッグ前（隠した状態）の、行 2 の「箇」と行 5 の「完」（行末の文字の 1 つ前）の位置。
    const points = await page.evaluate(() => {
      const charRect = (line: number, from: 'start' | 'end') => {
        const walker = document.createTreeWalker(document.querySelectorAll('.cm-line')[line]!, NodeFilter.SHOW_TEXT);
        const nodes: Text[] = [];
        for (let n = walker.nextNode(); n; n = walker.nextNode()) if ((n as Text).length > 0) nodes.push(n as Text);
        const node = from === 'start' ? nodes[nodes.length - 1]! : nodes[nodes.length - 1]!;
        const i = from === 'start' ? Math.max(node.length - 4, 0) : node.length - 2;
        const range = document.createRange();
        range.setStart(node, i);
        range.setEnd(node, i + 1);
        const r = range.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      };
      return { from: charRect(2, 'start'), to: charRect(5, 'end') };
    });
    await page.mouse.move(points.from.x, points.from.y);
    await page.mouse.down();
    await page.mouse.move(points.to.x, points.from.y + (points.to.y - points.from.y) / 2, { steps: 4 });
    await page.mouse.move(points.to.x, points.to.y, { steps: 4 });
    await page.mouse.up();

    const s = await sel();
    const lineStart = (n: number) => DOC_A.slice(0, n).reduce((sum, l) => sum + l.length + 1, 0);
    const lineOf = (pos: number) => DOC_A.findIndex((_, i) => pos >= lineStart(i) && pos <= lineStart(i) + DOC_A[i]!.length);
    expect(lineOf(s.anchor)).toBe(2);
    expect(lineOf(s.head)).toBe(5);
    const selected = TEXT_A.slice(s.anchor, s.head);
    // 途中の行は、記号を含めて丸ごと入っている。
    expect(selected).toContain('\n1. 番号付き\n- [ ] 未完了\n');
    expect(await renderedLines(page)).toEqual(expectedLines([2, 3, 4, 5]));
    expect(await docText(page)).toBe(TEXT_A);
  });

  test('(e) ダブルクリックで、隠した行の語が選ばれ、その行の記号が表示される', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 1500 });
    await openDoc(page, TEXT_A);
    await page.keyboard.press('ControlOrMeta+End');
    const sel = await trackSelection(page);
    // 行 8 の自動リンク（<https://auto.example.com>。隠した状態では < が見えない）の、"example" の真ん中。
    const target = await page.evaluate(() => {
      const walker = document.createTreeWalker(document.querySelectorAll('.cm-line')[8]!, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const i = (n.textContent ?? '').indexOf('example');
        if (i >= 0) {
          const range = document.createRange();
          range.setStart(n, i + 3);
          range.setEnd(n, i + 4);
          const r = range.getBoundingClientRect();
          return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
        }
      }
      throw new Error('no example');
    });
    await page.mouse.dblclick(target.x, target.y);
    const s = await sel();
    expect(TEXT_A.slice(Math.min(s.anchor, s.head), Math.max(s.anchor, s.head))).toBe('example');
    // その行の記号が表示される。本文は変わらない。
    expect(await renderedLines(page)).toEqual(expectedLines([8]));
    expect(await docText(page)).toBe(TEXT_A);
  });

  test('(e) 上下の移動で、列が大きく飛ばず、行が飛ばない（隠した行へ入っても）', async ({ page }) => {
    await openDoc(page, TEXT_A);
    const sel = await trackSelection(page);
    const lineStart = (n: number) => DOC_A.slice(0, n).reduce((sum, l) => sum + l.length + 1, 0);
    await goToLine(page, 2);
    await page.keyboard.press('Home');
    for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowRight');
    const col0 = (await sel()).head - lineStart(2);
    const lines = [2];
    const cols = [col0];
    // 行 2〜12（記法のある行）を下へ。
    for (let line = 3; line <= 12; line++) {
      await page.keyboard.press('ArrowDown');
      const head = (await sel()).head;
      const l = DOC_A.findIndex((_, i) => head >= lineStart(i) && head <= lineStart(i) + DOC_A[i]!.length);
      lines.push(l);
      cols.push(head - lineStart(l));
    }
    expect(lines).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    // 列は、行の長さの範囲で、記号の長さ程度のずれにとどまる（行頭から大きく飛ばない）。
    for (let i = 0; i < cols.length; i++) {
      expect(cols[i]).toBeLessThanOrEqual(DOC_A[lines[i]!]!.length);
      if (DOC_A[lines[i]!]!.length > 0) expect(Math.abs(cols[i]! - col0)).toBeLessThanOrEqual(10);
    }
    // 上へ戻る。
    for (let line = 11; line >= 2; line--) {
      await page.keyboard.press('ArrowUp');
      const head = (await sel()).head;
      expect(head).toBeGreaterThanOrEqual(lineStart(line));
      expect(head).toBeLessThanOrEqual(lineStart(line) + DOC_A[line]!.length);
    }
  });
});

// ---- (f) ぶら下げインデント ----

const LONG = '朝の光が川面に反射して、遠くの橋が白く霞んでいた。歩きながら考えたことを、帰ってからすぐに書き留めておく。'.repeat(2);
const HANG_DOC = [
  `- ${LONG}`, // 0
  `  - ${LONG}`, // 1
  `1. ${LONG}`, // 2
  `> ${LONG}`, // 3
  `> > ${LONG}`, // 4
  `> - ${LONG}`, // 5
  `- [ ] ${LONG}`, // 6
  `- [x] ${LONG}`, // 7
  `* ${LONG}`, // 8
  LONG, // 9
].join('\n');

/** 行 index の、本文（LONG の最初の文字）の左端と、折り返した各行の左端。 */
async function hangEdgesByText(page: Page, lineIndex: number) {
  return page.evaluate(
    ([index, first]) => {
      const line = document.querySelectorAll('.cm-line')[index!]!;
      const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
      const rects: Array<{ ch: string; left: number; top: number }> = [];
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const text = node as Text;
        for (let i = 0; i < text.length; i++) {
          const range = document.createRange();
          range.setStart(text, i);
          range.setEnd(text, i + 1);
          const r = range.getClientRects()[0];
          if (r) rects.push({ ch: text.data[i]!, left: r.left, top: r.top });
        }
      }
      const start = rects.findIndex((r) => r.ch === first);
      const firstRect = rects[start]!;
      const wrappedLefts: number[] = [];
      let lastTop = firstRect.top;
      for (const r of rects.slice(start)) {
        if (r.top > lastTop + 5) {
          wrappedLefts.push(r.left);
          lastTop = r.top;
        }
      }
      return { firstLeft: firstRect.left, wrappedLefts, contentLeft: line.getBoundingClientRect().left };
    },
    [lineIndex, LONG[0]!] as const,
  );
}

const HANG_NAMES = ['箇条書き（-）', '入れ子の箇条書き', '番号付き', '引用', '入れ子の引用', '引用の中の箇条書き', 'タスク（未完了）', 'タスク（完了）', '箇条書き（*）'];

test.describe('ぶら下げインデント (f)', () => {
  for (const focusMode of [false, true]) {
    test.describe(`記号を隠した行${focusMode ? '（フォーカスモード ON）' : ''}`, () => {
      test.beforeEach(async ({ page }) => {
        // 折り返した行をすべて描画できる高さ。
        await page.setViewportSize({ width: 1280, height: 2600 });
        await openDoc(page, HANG_DOC, { focusMode });
        await page.keyboard.press('ControlOrMeta+End');
        await expect(page.locator('.cm-line')).toHaveCount(10);
      });

      HANG_NAMES.forEach((name, index) => {
        test(`(f) ${name}: 折り返した行の左端が、1 行目の本文の左端に揃う（±2px）`, async ({ page }) => {
          const edges = await hangEdgesByText(page, index);
          expect(edges.wrappedLefts.length, '折り返している').toBeGreaterThanOrEqual(1);
          for (const left of edges.wrappedLefts) expect(Math.abs(left - edges.firstLeft)).toBeLessThanOrEqual(2);
          if (index === 3 || index === 4) {
            // 引用だけの行は、記号を隠すので、本文は行の左端から始まる（縦線は左の余白に出る）。
            expect(Math.abs(edges.firstLeft - edges.contentLeft)).toBeLessThanOrEqual(2);
          } else {
            expect(edges.firstLeft - edges.contentLeft).toBeGreaterThan(5);
          }
        });
      });

      test('(f) 隠した行から記号を見せる行に切り替わっても、折り返した行は 1 行目の本文に揃う', async ({ page }) => {
        for (const index of [0, 5, 6]) {
          await goToLineKeepingWrap(page, index);
          const edges = await hangEdgesByText(page, index);
          expect(edges.wrappedLefts.length).toBeGreaterThanOrEqual(1);
          for (const left of edges.wrappedLefts) expect(Math.abs(left - edges.firstLeft)).toBeLessThanOrEqual(2);
        }
      });
    });
  }

  test('(f) 引用の縦線は、記号を隠しても、行の左の同じ位置に残る', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 2600 });
    await openDoc(page, HANG_DOC);
    const bar = () =>
      page.locator('.cm-line').nth(3).evaluate((el) => {
        const cs = getComputedStyle(el, '::before');
        return { left: cs.left, width: cs.width, color: cs.backgroundColor };
      });
    await goToLineKeepingWrap(page, 3);
    const shown = await bar();
    await page.keyboard.press('ControlOrMeta+End');
    const hidden = await bar();
    expect(hidden).toEqual(shown);
    expect(hidden.width).toBe('3px');
  });
});

/** 折り返した行の文書で、先頭から index 行目の頭へ（ArrowDown は見た目の行を進むので、位置で指定する）。 */
async function goToLineKeepingWrap(page: Page, index: number): Promise<void> {
  const pos = HANG_DOC.split('\n')
    .slice(0, index)
    .reduce((sum, l) => sum + l.length + 1, 0);
  await page.keyboard.press('ControlOrMeta+Home');
  for (let i = 0; i < pos; i++) await page.keyboard.press('ArrowRight');
}

// ---- (g) 設定 ----

const dialog = (page: Page) => page.getByRole('dialog', { name: '設定' });
const savedPreferences = (page: Page) =>
  page.evaluate(() => window.__mdeE2E!.savedPreferences.at(-1) as Record<string, unknown> | undefined);

test.describe('設定「記号の表示」 (g)', () => {
  test('(g) 「常に表示」にするとすぐ今と同じ見た目になり、戻すとまた隠れる。リロード後も保たれる', async ({ page }) => {
    await openDoc(page, TEXT_A);
    await page.keyboard.press('ControlOrMeta+End');
    expect(await renderedLines(page)).toEqual(expectedLines([22]));

    await page.keyboard.press('ControlOrMeta+,');
    await expect(dialog(page)).toBeVisible();
    const radios = dialog(page).getByTestId('settings-appearance');
    await expect(radios.getByRole('radio', { name: 'カーソルのある行だけ' })).toBeChecked();
    await radios.getByRole('radio', { name: '常に表示' }).check();
    expect(await renderedLines(page)).toEqual(DOC_A);
    await expect(page.locator('.cm-md-bullet, .cm-md-task')).toHaveCount(0);
    // 記号は、薄い色で表示される（今までと同じ）。
    const markColor = await page.locator('.cm-md-h1 span').first().evaluate((el) => getComputedStyle(el).color);
    const textColor = await page.locator('.cm-md-h1 span').nth(1).evaluate((el) => getComputedStyle(el).color);
    expect(markColor).not.toBe(textColor);
    await expect.poll(() => savedPreferences(page)).toMatchObject({ markupDisplay: 'always' });

    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-ready', 'true');
    await page.keyboard.press('ControlOrMeta+o');
    await expect(docTitle(page)).toHaveText('live.md');
    await page.locator('.cm-content').click();
    await page.keyboard.press('ControlOrMeta+End');
    expect(await renderedLines(page)).toEqual(DOC_A);

    await page.keyboard.press('ControlOrMeta+,');
    await expect(radios.getByRole('radio', { name: '常に表示' })).toBeChecked();
    await radios.getByRole('radio', { name: 'カーソルのある行だけ' }).check();
    expect(await renderedLines(page)).toEqual(expectedLines([22]));
    await expect.poll(() => savedPreferences(page)).toMatchObject({ markupDisplay: 'cursorLine' });
  });

  test('(g) 保存済みの設定が always なら、起動したときから隠さない。不正な値は既定（カーソルのある行だけ）に戻る', async ({ page }) => {
    await openDoc(page, TEXT_A, { markupDisplay: 'always' });
    await page.keyboard.press('ControlOrMeta+End');
    expect(await renderedLines(page)).toEqual(DOC_A);

    const other = await page.context().newPage();
    await openDoc(other, TEXT_A, { markupDisplay: 'hidden' });
    await other.keyboard.press('ControlOrMeta+End');
    expect(await renderedLines(other)).toEqual(expectedLines([22]));
  });

  test('(g) 設定を切り替えても、本文・カーソルの位置・未保存の状態は変わらない', async ({ page }) => {
    await openDoc(page, TEXT_A);
    const sel = await trackSelection(page);
    await goToLine(page, 10);
    await page.keyboard.press('End');
    const before = await sel();
    await page.keyboard.press('ControlOrMeta+,');
    await dialog(page).getByTestId('settings-appearance').getByRole('radio', { name: '常に表示' }).check();
    await dialog(page).getByTestId('settings-appearance').getByRole('radio', { name: 'カーソルのある行だけ' }).check();
    await page.keyboard.press('Escape');
    expect(await docText(page)).toBe(TEXT_A);
    await expect(unsavedMark(page)).toHaveCount(0);
    expect(await sel()).toEqual(before);
  });
});

// ---- (h) リンクを開く ----

const LINK_DOC = [
  '[公開](https://example.com/a "題")', // 0
  '<https://auto.example.com/b>', // 1
  'https://bare.example.com/c', // 2
  '[相対](./other.md)', // 3
  '[アンカー](#sec)', // 4
  '[メール](mailto:a@example.com)', // 5
  '[スクリプト](javascript:alert(1))', // 6
  '[ファイル](file:///etc/passwd)', // 7
  '[参照][ref]', // 8
  '', // 9
  '[ref]: https://ref.example.com', // 10
  '終わり', // 11
].join('\n');

const modifierKey = (platform: Platform) => (platform === 'mac' ? 'Meta' : 'Control');
const opened = (page: Page) => page.evaluate(() => [...window.__mdeE2E!.openedUrls]);

test.describe('リンクを開く (h)', () => {
  for (const markupDisplay of ['cursorLine', 'always'] as const) {
    test(`(h) 修飾キー+クリックで http/https のリンクが開かれ、カーソルは動かない（記号 ${markupDisplay}）`, async ({ page, platform }) => {
      await openDoc(page, LINK_DOC, { markupDisplay });
      await page.keyboard.press('ControlOrMeta+End');
      const sel = await trackSelection(page);
      await page.keyboard.press('ControlOrMeta+End');
      const before = await sel();
      const mod = modifierKey(platform);

      // インラインリンクの文字（隠した行・表示した行のどちらでも）、自動リンク、裸の URL。
      // macOS 上の Chromium は、Ctrl+クリックを右クリック（コンテキストメニュー）として扱い、クリックした語を選択する。
      // Windows / Linux を偽装した project を macOS で動かすと、これがカーソルの移動に見えるので、その組み合わせだけ
      // カーソルの検査を外す（アプリの動作ではなくホストの挙動。カーソルを動かさないことは、下の合成イベントの検査が全 OS で確かめる）。
      const hostCtrlClickSelects = process.platform === 'darwin' && platform !== 'mac';
      const cursorUnchanged = async () => {
        if (!hostCtrlClickSelects) expect(await sel()).toEqual(before);
      };
      await page.locator('.cm-md-link', { hasText: '公開' }).first().click({ modifiers: [mod] });
      expect(await opened(page)).toEqual(['https://example.com/a']);
      await cursorUnchanged();

      await page.locator('.cm-md-link', { hasText: 'auto.example.com' }).first().click({ modifiers: [mod] });
      await page.locator('.cm-md-link', { hasText: 'bare.example.com' }).first().click({ modifiers: [mod] });
      expect(await opened(page)).toEqual(['https://example.com/a', 'https://auto.example.com/b', 'https://bare.example.com/c']);
      await cursorUnchanged();
      expect(await docText(page)).toBe(LINK_DOC);
      await expect(toast(page)).toHaveCount(0);
    });
  }

  test('(h) 修飾キー付きのクリック（合成イベント）は、カーソルも選択も動かさずに開く。違う修飾キーと修飾キーなしは開かない', async ({ page, platform }) => {
    await openDoc(page, LINK_DOC);
    await page.keyboard.press('ControlOrMeta+End');
    const sel = await trackSelection(page);
    await page.keyboard.press('ControlOrMeta+End');
    const before = await sel();
    const mousedown = (modifier: 'meta' | 'ctrl' | 'none') =>
      page.evaluate((m) => {
        const el = Array.from(document.querySelectorAll('.cm-md-link')).find((e) => e.textContent?.includes('公開'))!;
        const r = el.getBoundingClientRect();
        const event = new MouseEvent('mousedown', {
          bubbles: true,
          cancelable: true,
          button: 0,
          clientX: r.left + r.width / 2,
          clientY: r.top + r.height / 2,
          metaKey: m === 'meta',
          ctrlKey: m === 'ctrl',
        });
        el.dispatchEvent(event);
        return event.defaultPrevented;
      }, modifier);
    const right = platform === 'mac' ? 'meta' : 'ctrl';
    const wrong = platform === 'mac' ? 'ctrl' : 'meta';
    expect(await mousedown(right)).toBe(true);
    expect(await opened(page)).toEqual(['https://example.com/a']);
    expect(await sel()).toEqual(before);
    // 違う修飾キーと、修飾キーなしは、開かない（CodeMirror が普通に処理する）。
    await mousedown(wrong);
    expect(await opened(page)).toEqual(['https://example.com/a']);
    await page.keyboard.press('ControlOrMeta+End');
    await mousedown('none');
    expect(await opened(page)).toEqual(['https://example.com/a']);
    // 修飾キーなしのクリックは、カーソルを置く（リンクの行へ動く）。
    expect((await sel()).head).toBeLessThan(before.head);
  });

  test('(h) 記号を見せている行では、URL の部分をクリックしても開く', async ({ page, platform }) => {
    await openDoc(page, LINK_DOC);
    await goToLine(page, 0);
    expect((await renderedLines(page))[0]).toBe('[公開](https://example.com/a "題")');
    const sel = await trackSelection(page);
    await page.keyboard.press('Home');
    const before = await sel();
    // 行の中の URL の文字（"example.com" の位置）。
    const point = await page.evaluate(() => {
      const walker = document.createTreeWalker(document.querySelector('.cm-line')!, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const i = (n.textContent ?? '').indexOf('example');
        if (i >= 0) {
          const range = document.createRange();
          range.setStart(n, i + 2);
          range.setEnd(n, i + 3);
          const r = range.getBoundingClientRect();
          return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
        }
      }
      throw new Error('no url');
    });
    await page.keyboard.down(modifierKey(platform));
    await page.mouse.click(point.x, point.y);
    await page.keyboard.up(modifierKey(platform));
    expect(await opened(page)).toEqual(['https://example.com/a']);
    // macOS 上の Chromium の Ctrl+クリック（右クリック扱い）が語を選ぶ組み合わせは、ここでは見ない（上の説明と合成イベントの検査を参照）。
    if (!(process.platform === 'darwin' && platform !== 'mac')) expect(await sel()).toEqual(before);
  });

  test('(h) 普通のクリックは、カーソルを置くだけで開かない', async ({ page }) => {
    await openDoc(page, LINK_DOC);
    await page.keyboard.press('ControlOrMeta+End');
    const sel = await trackSelection(page);
    await page.locator('.cm-md-link', { hasText: '公開' }).first().click();
    expect(await opened(page)).toEqual([]);
    expect((await sel()).head).toBeLessThan('[公開](https://example.com/a "題")'.length + 1);
    expect((await renderedLines(page))[0]).toBe('[公開](https://example.com/a "題")');
  });

  test('(h) http/https 以外（相対パス・# ・mailto:・file:・javascript:）は開かず、トーストで知らせる', async ({ page, platform }) => {
    await openDoc(page, LINK_DOC);
    await page.keyboard.press('ControlOrMeta+End');
    const mod = modifierKey(platform);
    for (const text of ['相対', 'アンカー', 'メール', 'スクリプト', 'ファイル']) {
      await page.locator('.cm-md-link', { hasText: text }).first().click({ modifiers: [mod] });
      await expect(toast(page), text).toHaveText('このリンクは開けません');
      await toast(page).click();
      await expect(toast(page)).toHaveCount(0);
    }
    expect(await opened(page)).toEqual([]);
    expect(await docText(page)).toBe(LINK_DOC);
  });

  test('(h) 参照リンク・リンクでない所の修飾キー+クリックは、リンクを開かない', async ({ page, platform }) => {
    await openDoc(page, LINK_DOC);
    await page.keyboard.press('ControlOrMeta+End');
    const mod = modifierKey(platform);
    await page.locator('.cm-line').nth(8).click({ modifiers: [mod] });
    await page.locator('.cm-line').nth(11).click({ modifiers: [mod] });
    expect(await opened(page)).toEqual([]);
  });

  test('(h) 修飾キーを押している間だけ、リンクの上でポインタの形が変わる', async ({ page, platform }) => {
    await openDoc(page, LINK_DOC);
    await page.keyboard.press('ControlOrMeta+End');
    const link = page.locator('.cm-md-link', { hasText: '公開' }).first();
    const cursor = () => link.evaluate((el) => getComputedStyle(el).cursor);
    await link.hover();
    expect(await cursor()).not.toBe('pointer');
    await page.keyboard.down(modifierKey(platform));
    await expect.poll(cursor).toBe('pointer');
    await page.keyboard.up(modifierKey(platform));
    await expect.poll(cursor).not.toBe('pointer');
    // リンクでない所は、修飾キーを押しても変わらない。
    await page.keyboard.down(modifierKey(platform));
    const plain = await page.locator('.cm-line').nth(11).evaluate((el) => getComputedStyle(el).cursor);
    expect(plain).not.toBe('pointer');
    await page.keyboard.up(modifierKey(platform));
  });

  test('(h) その OS の修飾キーではないキー（mac は Ctrl、Windows と Linux は Meta）では開かない', async ({ page, platform }) => {
    test.skip(platform === 'mac', 'mac の Ctrl+クリックは右クリックの扱いなので、押下のしかたを揃えにくい');
    await openDoc(page, LINK_DOC);
    await page.keyboard.press('ControlOrMeta+End');
    await page.locator('.cm-md-link', { hasText: '公開' }).first().click({ modifiers: ['Meta'] });
    expect(await opened(page)).toEqual([]);
  });
});

// ---- (j) タイプライターモード・フォーカスモード ----

const MIXED = Array.from({ length: 30 }, (_, i) => {
  switch (i % 6) {
    case 0:
      return `## 見出し ${i}`;
    case 1:
      return `- 項目 ${i} と [リンク](https://example.com/${i}) と **強調**`;
    case 2:
      return `- [ ] タスク ${i}`;
    case 3:
      return `> 引用 ${i}`;
    case 4:
      return '';
    default:
      return `本文 ${i} の \`code\` と ~~消し~~`;
  }
}).join('\n');

test.describe('タイプライターモード・フォーカスモード (j)', () => {
  test('(j) フォーカスモード: カーソルが行を移っても、各行の位置が飛ばない（隠す・見せるで高さが変わらない）', async ({ page }) => {
    await openDoc(page, MIXED, { focusMode: true });
    // 本文の中での各行の位置（スクロールの量を足す）。隠す・見せるで行の高さが変わらなければ、移動の前後で同じ。
    const tops = () =>
      page.locator('.cm-line').evaluateAll((els) => {
        const scroller = document.querySelector('.cm-scroller')!;
        return els.map((el) => Math.round((el.getBoundingClientRect().top + scroller.scrollTop) * 10) / 10);
      });
    await page.keyboard.press('ControlOrMeta+Home');
    const base = await tops();
    for (let i = 0; i < 28; i++) {
      await page.keyboard.press('ArrowDown');
      expect(await tops(), `${i + 1} 回目`).toEqual(base);
    }
    // 弱く表示するのは、カーソルのある段落以外のまま。
    expect(await page.locator('.cm-md-dim').count()).toBeGreaterThan(20);
  });

  test('(j) タイプライターモード: カーソルが行を移っても、カーソル行が縦中央に保たれ、本文の位置が飛ばない', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 700 });
    await openDoc(page, MIXED, { typewriterMode: true });
    await page.keyboard.press('ControlOrMeta+Home');
    const state = () =>
      page.evaluate(
        () =>
          new Promise<{ caret: number; scrollTop: number }>((resolve) =>
            requestAnimationFrame(() =>
              requestAnimationFrame(() => {
                const scroller = document.querySelector('.cm-scroller')!.getBoundingClientRect();
                const caret = document.querySelector('.cm-cursor-primary, .cm-cursor')!.getBoundingClientRect();
                resolve({
                  caret: (caret.top + caret.bottom) / 2 - (scroller.top + scroller.height / 2),
                  scrollTop: document.querySelector('.cm-scroller')!.scrollTop,
                });
              }),
            ),
          ),
      );
    let previous = (await state()).scrollTop;
    for (let i = 0; i < 28; i++) {
      await page.keyboard.press('ArrowDown');
      const s = await state();
      expect(Math.abs(s.caret), `${i + 1} 回目のカーソル行の位置`).toBeLessThanOrEqual(6);
      // 1 回の移動でスクロールするのは、行 1〜2 本ぶんまで（記号の表示の切り替えで跳ねない）。
      expect(Math.abs(s.scrollTop - previous), `${i + 1} 回目のスクロール`).toBeLessThanOrEqual(80);
      previous = s.scrollTop;
    }
  });

  test('(j) 読む位置の保持: 末尾へ向かって書き足しても、カーソルは画面の下端に張り付かない', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 700 });
    await openDoc(page, MIXED);
    await page.keyboard.press('ControlOrMeta+End');
    for (let i = 0; i < 12; i++) {
      await page.keyboard.press('Enter');
      await page.keyboard.type(i % 2 === 0 ? `- 追記 ${i} [a](b)` : `> 引用 ${i}`);
    }
    const gap = await page.evaluate(() => {
      const scroller = document.querySelector('.cm-scroller')!.getBoundingClientRect();
      const caret = document.querySelector('.cm-cursor-primary, .cm-cursor')!.getBoundingClientRect();
      return { bottom: scroller.bottom - caret.bottom, height: scroller.height };
    });
    expect(gap.bottom).toBeGreaterThanOrEqual(gap.height * 0.25);
  });
});

// ---- (k) チェックボックスのクリックでの切り替え（Run 13） ----

/** 文書の変更を、文字ごとの差の数で数える（同じ長さのときだけ）。 */
function diffPositions(before: string, after: string): number[] {
  expect(after.length).toBe(before.length);
  const out: number[] = [];
  for (let i = 0; i < before.length; i++) if (before[i] !== after[i]) out.push(i);
  return out;
}

/** 選択の通知の回数と、最後の値。 */
async function trackSelectionEvents(page: Page): Promise<() => Promise<{ count: number; anchor: number; head: number }>> {
  await page.evaluate(() => {
    const w = window as unknown as { __selEvents: { count: number; anchor: number; head: number } };
    w.__selEvents = { count: 0, anchor: 0, head: 0 };
    window.__mdeE2E!.editor!.onSelectionChange((s) => {
      w.__selEvents = { count: w.__selEvents.count + 1, anchor: s.anchor, head: s.head };
    });
  });
  return () =>
    page.evaluate(() => (window as unknown as { __selEvents: { count: number; anchor: number; head: number } }).__selEvents);
}

const boxes = (page: Page) => page.locator('.cm-md-task');

/** 描画と測定が落ち着くまで、2 フレーム待つ。 */
const settleFrames = (page: Page) =>
  page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));

/** チェックボックスの位置に、mousedown の合成イベント（修飾キー付き）を送る。 */
const syntheticMousedown = (page: Page, init: { metaKey?: boolean; ctrlKey?: boolean; altKey?: boolean; shiftKey?: boolean }) =>
  page.evaluate((i) => {
    const el = document.querySelector('.cm-md-task')!;
    const r = el.getBoundingClientRect();
    el.dispatchEvent(
      new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, ...i }),
    );
  }, init);

test.describe('チェックボックスのクリックでの切り替え (k)', () => {
  test('(k) 隠した行のチェックボックスのクリックで、完了と未完了が切り替わり、保存したバイト列の差はその 1 文字だけ', async ({ page }) => {
    await openDoc(page, TEXT_A);
    await page.keyboard.press('ControlOrMeta+End');
    const hidden = expectedLines([22]);
    expect(await renderedLines(page)).toEqual(hidden);

    // 未完了 → 完了
    await boxes(page).nth(0).click();
    const afterFirst = TEXT_A.replace('- [ ] 未完了', '- [x] 未完了');
    expect(await docText(page)).toBe(afterFirst);
    expect(diffPositions(TEXT_A, afterFirst)).toHaveLength(1);
    await expect(unsavedMark(page)).toHaveCount(1);
    await expect(page.locator('.cm-md-task-done')).toHaveCount(2);
    // その行は隠したまま、形だけが変わる。
    expect(await renderedLines(page)).toEqual(hidden);
    await page.keyboard.press('ControlOrMeta+s');
    await expect(unsavedMark(page)).toHaveCount(0);
    const saved = await fileBytes(page, DOC);
    expect(saved).toEqual(utf8(afterFirst));
    const original = utf8(TEXT_A);
    expect(saved!.length).toBe(original.length);
    expect(saved!.flatMap((b, i) => (b !== original[i] ? [i] : []))).toHaveLength(1);

    // 完了 → 未完了（2 つ目の、もともと完了のもの。続けてもう 1 つ目を戻す）
    await boxes(page).nth(1).click();
    expect(await docText(page)).toBe(afterFirst.replace('- [x] 完了', '- [ ] 完了'));
    await boxes(page).nth(0).click();
    expect(await docText(page)).toBe(TEXT_A.replace('- [x] 完了', '- [ ] 完了'));
    await boxes(page).nth(1).click();
    expect(await docText(page)).toBe(TEXT_A);
    await page.keyboard.press('ControlOrMeta+s');
    expect(await fileBytes(page, DOC)).toEqual(original);
  });

  test('(k) [X]（大文字）も未完了になる。対象は、入れ子・引用の中・* と + のタスク', async ({ page }) => {
    const text = ['前', '- [ ] a', '  - [x] b', '    - [X] c', '> - [ ] d', '> > * [x] e', '* [ ] f', '+ [X] g', '1. [ ] 番号付き', '終わり'].join('\n');
    await openDoc(page, text);
    await page.keyboard.press('ControlOrMeta+End');
    // 番号付きのタスクは、ウィジェットを出さない。
    await expect(boxes(page)).toHaveCount(7);
    let expected = text;
    const toggles: Array<[number, string, string]> = [
      [0, '- [ ] a', '- [x] a'],
      [1, '  - [x] b', '  - [ ] b'],
      [2, '    - [X] c', '    - [ ] c'],
      [3, '> - [ ] d', '> - [x] d'],
      [4, '> > * [x] e', '> > * [ ] e'],
      [5, '* [ ] f', '* [x] f'],
      [6, '+ [X] g', '+ [ ] g'],
    ];
    for (const [i, from, to] of toggles) {
      await boxes(page).nth(i).click();
      expected = expected.replace(from, to);
      expect(await docText(page), `${i + 1} 個目`).toBe(expected);
    }
    expect(await docText(page)).toBe(
      ['前', '- [x] a', '  - [ ] b', '    - [ ] c', '> - [x] d', '> > * [ ] e', '* [x] f', '+ [ ] g', '1. [ ] 番号付き', '終わり'].join('\n'),
    );
  });

  const MODES: Array<{ name: string; preferences: Record<string, unknown> }> = [
    { name: '通常', preferences: {} },
    { name: 'タイプライターモード', preferences: { typewriterMode: true } },
    { name: 'フォーカスモード', preferences: { focusMode: true } },
    { name: 'タイプライターとフォーカス', preferences: { typewriterMode: true, focusMode: true } },
  ];
  for (const mode of MODES) {
  test(`(k) 選択・スクロール位置・行の表示は変わらない。Undo 1 回で戻り、Redo でやり直せる（${mode.name}）`, async ({ page, platform }) => {
    await page.setViewportSize({ width: 1280, height: 700 });
    const filler = Array.from({ length: 60 }, (_, i) => `段落 ${i}`).join('\n\n');
    const text = `${filler}\n\n- [ ] 一\n- [x] 二\n\n終わり`;
    await openDoc(page, text, mode.preferences);
    await page.keyboard.press('ControlOrMeta+Home');
    const events = await trackSelectionEvents(page);
    await page.keyboard.press('Shift+ArrowDown');
    await page.keyboard.press('Shift+ArrowDown');
    const sel = await events();
    expect(sel.count).toBeGreaterThan(0);
    // 選択はそのままに、タスクが見える位置まで（末尾へ）スクロールする。
    // CodeMirror は描画していない行の高さを推定で持つので、末尾に着くまでスクロールし直す。
    await expect
      .poll(
        async () => {
          await page.locator('.cm-scroller').evaluate((el) => {
            el.scrollTop = el.scrollHeight;
          });
          return boxes(page).count();
        },
        { timeout: 10_000 },
      )
      .toBe(2);
    const scrollBefore = await page.locator('.cm-scroller').evaluate((el) => el.scrollTop);
    const linesBefore = await renderedLines(page);
    const tasksBefore = await page.locator('.cm-md-task').count();

    await boxes(page).nth(0).click();
    expect(await docText(page)).toBe(text.replace('- [ ] 一', '- [x] 一'));
    expect(await events()).toEqual(sel);
    // タイプライターモードの中央合わせは、測定の後（次のフレーム）に動くので、2 フレーム待ってから確かめる。
    await settleFrames(page);
    expect(await page.locator('.cm-scroller').evaluate((el) => el.scrollTop)).toBe(scrollBefore);
    expect(await renderedLines(page)).toEqual(linesBefore);
    expect(await page.locator('.cm-md-task').count()).toBe(tasksBefore);

    // Undo 1 回で戻る。Redo でやり直す。
    await page.keyboard.press('ControlOrMeta+z');
    expect(await docText(page)).toBe(text);
    await page.keyboard.press(redoKeys(platform)[0]!);
    expect(await docText(page)).toBe(text.replace('- [ ] 一', '- [x] 一'));
    await page.keyboard.press('ControlOrMeta+z');
    expect(await docText(page)).toBe(text);
  });
  }

  test('(k) 続けて 2 回切り替えると、Undo 2 回で戻る。切り替えの直後の入力と 1 つの Undo にまとめない', async ({ page }) => {
    await openDoc(page, TEXT_A);
    await page.keyboard.press('ControlOrMeta+End');
    await boxes(page).nth(0).click();
    await boxes(page).nth(1).click();
    const both = TEXT_A.replace('- [ ] 未完了', '- [x] 未完了').replace('- [x] 完了', '- [ ] 完了');
    expect(await docText(page)).toBe(both);
    await page.keyboard.type('!');
    expect(await docText(page)).toBe(`${both}!`);
    await page.keyboard.press('ControlOrMeta+z');
    expect(await docText(page)).toBe(both);
    await page.keyboard.press('ControlOrMeta+z');
    expect(await docText(page)).toBe(TEXT_A.replace('- [ ] 未完了', '- [x] 未完了'));
    await page.keyboard.press('ControlOrMeta+z');
    expect(await docText(page)).toBe(TEXT_A);
  });

  test('(k) すばやく 2 回クリックすると元に戻り、語は選択されない', async ({ page }) => {
    await openDoc(page, TEXT_A);
    await page.keyboard.press('ControlOrMeta+End');
    const events = await trackSelectionEvents(page);
    await boxes(page).nth(0).dblclick();
    expect(await docText(page)).toBe(TEXT_A);
    expect(await page.evaluate(() => window.getSelection()?.toString() ?? '')).toBe('');
    expect((await events()).count).toBe(0);
    expect(await renderedLines(page)).toEqual(expectedLines([22]));
    // triple click でも、カーソルも選択も動かない（奇数回なので、切り替わった状態）。
    await boxes(page).nth(0).click({ clickCount: 3 });
    expect(await docText(page)).toBe(TEXT_A.replace('- [ ] 未完了', '- [x] 未完了'));
    expect((await events()).count).toBe(0);
  });

  test('(k) 切り替えない操作: 本文のクリック、カーソル行の [ ]、Shift・右・中クリック', async ({ page }) => {
    await openDoc(page, TEXT_A);
    await page.keyboard.press('ControlOrMeta+End');
    const events = await trackSelectionEvents(page);

    // 本文（チェックボックスの右）のクリック: カーソルを置く。その行は記号が見える。
    await page.locator('.cm-line').nth(4).click({ position: { x: 150, y: 8 } });
    expect(await docText(page)).toBe(TEXT_A);
    expect((await events()).count).toBeGreaterThan(0);
    expect((await renderedLines(page))[4]).toBe('- [ ] 未完了');
    await expect(unsavedMark(page)).toHaveCount(0);

    // カーソル行の [ ]（記号が文字で見えている）をクリックしても、切り替えない。
    const box = (await page.locator('.cm-line').nth(4).boundingBox())!;
    await page.mouse.click(box.x + 20, box.y + box.height / 2);
    await page.mouse.click(box.x + 28, box.y + box.height / 2);
    expect(await docText(page)).toBe(TEXT_A);
    await expect(unsavedMark(page)).toHaveCount(0);

    // 別の行へ移ってから、Shift+クリック（選択の拡張）、右クリック、中クリック。
    await page.keyboard.press('ControlOrMeta+End');
    await boxes(page).nth(0).click({ modifiers: ['Shift'] });
    expect(await docText(page)).toBe(TEXT_A);
    // Shift+クリックは、選択を伸ばす（カーソルが動く）。選択のかかる行は記号が見える。
    expect((await renderedLines(page))[4]).toBe('- [ ] 未完了');

    await page.keyboard.press('ControlOrMeta+End');
    await expect(boxes(page)).toHaveCount(2);
    await boxes(page).nth(0).click({ button: 'right' });
    expect(await docText(page)).toBe(TEXT_A);
    await page.keyboard.press('Escape');
    await page.keyboard.press('ControlOrMeta+End');
    await expect(boxes(page)).toHaveCount(2);
    await boxes(page).nth(0).click({ button: 'middle' });
    // 中クリックでタスクの記号が切り替わらないこと（全 OS）。「未完了」の行は [ ]、「完了」の行は [x] のまま。
    // 文書が変わっても（下の理由）、この判定は変わらない。ペーストされた文字列の中の記号も同じ規則で見る。
    const markers = [...(await docText(page)).matchAll(/\[( |x)\] (未完了|完了)/g)].map((m) => `${m[1]}|${m[2]}`);
    expect(markers.length).toBeGreaterThanOrEqual(2);
    expect(markers.filter((m) => m === ' |未完了' || m === 'x|完了').length).toBe(markers.length);
    // 文書全体の一致と未保存の印は、Linux 以外だけで確かめる。Linux（X11）の中クリックは、PRIMARY 選択
    // （最後に選んだ文字列。直前の Shift+クリックの範囲など。プロセスをまたいで残りうる）を貼り付けるので、
    // 文書が変わりうる。これはブラウザ・OS の標準の動作で、チェックボックスの切り替えではない。
    if (process.platform !== 'linux') {
      expect(await docText(page)).toBe(TEXT_A);
      await expect(unsavedMark(page)).toHaveCount(0);
    }
  });

  test('(k) 修飾キー付き（⌘・Ctrl・Alt・Shift の合成イベント）は切り替えず、リンクも開かない', async ({ page }) => {
    await openDoc(page, TEXT_A);
    await page.keyboard.press('ControlOrMeta+End');
    for (const init of [{ metaKey: true }, { ctrlKey: true }, { altKey: true }, { shiftKey: true }]) {
      // 修飾キー付きのクリックは、今までどおりカーソルを置く（その行の記号が見える）。次のために末尾へ戻す。
      await page.keyboard.press('ControlOrMeta+End');
      await expectBoxesVisible(page);
      await syntheticMousedown(page, init);
      expect(await docText(page), JSON.stringify(init)).toBe(TEXT_A);
    }
    expect(await opened(page)).toEqual([]);
    await expect(unsavedMark(page)).toHaveCount(0);
  });

  test('(k) 設定が「常に表示」のときは、切り替えない（チェックボックスのウィジェットがない）', async ({ page }) => {
    await openDoc(page, TEXT_A, { markupDisplay: 'always' });
    await page.keyboard.press('ControlOrMeta+End');
    await expect(boxes(page)).toHaveCount(0);
    const box = (await page.locator('.cm-line').nth(4).boundingBox())!;
    await page.mouse.click(box.x + 8, box.y + box.height / 2);
    await page.mouse.click(box.x + 24, box.y + box.height / 2);
    expect(await docText(page)).toBe(TEXT_A);
    await expect(unsavedMark(page)).toHaveCount(0);
  });

  test('(k) ポインタは pointer。role は checkbox で、aria-checked が状態に合う', async ({ page }) => {
    await openDoc(page, TEXT_A);
    await page.keyboard.press('ControlOrMeta+End');
    await expect(page.getByRole('checkbox')).toHaveCount(2);
    await expect(boxes(page).nth(0)).toHaveCSS('cursor', 'pointer');
    await expect(boxes(page).nth(0)).toHaveAttribute('aria-checked', 'false');
    await expect(boxes(page).nth(1)).toHaveAttribute('aria-checked', 'true');
    await boxes(page).nth(0).click();
    await expect(boxes(page).nth(0)).toHaveAttribute('aria-checked', 'true');
    await boxes(page).nth(1).click();
    await expect(boxes(page).nth(1)).toHaveAttribute('aria-checked', 'false');
    await expect(page.locator('.cm-md-task-done')).toHaveCount(1);
    // 本文は pointer にしない。
    await expect(page.locator('.cm-line').nth(2)).not.toHaveCSS('cursor', 'pointer');
  });

  test('(k) フォーカスが本文から外れていても切り替わる。選択は動かず、フォーカスが戻って Undo が効く', async ({ page }) => {
    await openDoc(page, TEXT_A);
    await page.keyboard.press('ControlOrMeta+End');
    const events = await trackSelectionEvents(page);
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await expect(page.locator('.cm-content')).not.toBeFocused();
    await boxes(page).nth(0).click();
    expect(await docText(page)).toBe(TEXT_A.replace('- [ ] 未完了', '- [x] 未完了'));
    expect((await events()).count).toBe(0);
    await expect(page.locator('.cm-content')).toBeFocused();
    await page.keyboard.press('ControlOrMeta+z');
    expect(await docText(page)).toBe(TEXT_A);
    expect(await renderedLines(page)).toEqual(expectedLines([22]));
  });

  test('(k) IME の変換中は切り替えない', async ({ page }) => {
    await openDoc(page, '前の行\n- [ ] 項目\n後の行');
    await page.keyboard.press('ControlOrMeta+Home');
    const client = await page.context().newCDPSession(page);
    await client.send('Input.imeSetComposition', { text: 'あ', selectionStart: 1, selectionEnd: 1 });
    await expect(boxes(page)).toHaveCount(1);
    await syntheticMousedown(page, {});
    expect(await docText(page)).toContain('- [ ] 項目');
    expect(await docText(page)).not.toContain('[x]');
    await client.send('Input.insertText', { text: 'あ' });
    await expect.poll(() => docText(page)).toBe('あ前の行\n- [ ] 項目\n後の行');
    // 変換が終われば、切り替えられる。
    await page.keyboard.press('ControlOrMeta+End');
    await expect(boxes(page)).toHaveCount(1);
    await boxes(page).nth(0).click();
    expect(await docText(page)).toBe('あ前の行\n- [x] 項目\n後の行');
  });
});

async function expectBoxesVisible(page: Page): Promise<void> {
  // 合成イベントの前に、チェックボックスが（カーソルのない行に）あることを確かめる。
  await expect(boxes(page)).toHaveCount(2);
}
