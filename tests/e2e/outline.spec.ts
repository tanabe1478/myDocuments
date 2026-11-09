import { expect, type CDPSession, type Page } from '@playwright/test';
import { docTitle, editorText, fileBytes, launch, setDialogPaths, test, unsavedMark, utf8 } from './helpers';

// 部品のパネルと、同梱の部品「アウトライン」（ADR-005 の R7）。右ペイン（R13。起動時は閉じている。上部バーのボタンか Option+Cmd+B で開く）の
// パネルに見出しの一覧が出て、項目を押すとその行へ移る。
// 部品の文字列は文字として描かれる。本文は、権限 document.read を宣言した部品にだけ、入力が止まった後に、パネルが見えているとき
// （右ペインが開いていて、節がたたまれていない）だけ届く。右ペインの開閉、狭い窓、ショートカットは right-pane.spec.ts。
// テスト用の部品（src/isolated-plugins/e2eFixtures.ts）は、seed の isolated.plugins に名前を書いたときだけ読み込まれる。

const DOC = '/docs/note.md';
const MD = ['# 第一章', '', '本文の段落。', '', '## 第一節', '', 'もう一つの段落。', '', '# 第二章', '', '終わり。'].join('\n');

const trace = (page: Page) => page.evaluate(() => window.__mdeE2EIsolatedTrace ?? []);
const traceOf = async (page: Page, plugin: string, type: string) => (await trace(page)).filter((e) => e.plugin === plugin && e.type === type);
const panel = (page: Page) => page.getByTestId('plugin-panel').filter({ has: page.getByRole('button', { name: /アウトライン/ }) });
const outlineItems = (page: Page) => panel(page).getByTestId('plugin-panel-item');
const outlineTexts = (page: Page) => outlineItems(page).allTextContents();
const consoleLogs = new WeakMap<Page, string[]>();

/** 右ペインを、上部バーのボタンで開く（起動時は閉じている）。 */
async function openRightPane(page: Page) {
  const toggle = page.getByTestId('right-pane-toggle');
  // 入力のあとは上部バーが自動で隠れている（ポインタを通さない）ので、ポインタを動かして戻してから押す。
  await page.mouse.move(40 + Math.floor(Math.random() * 200), 300);
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByTestId('right-pane')).toHaveAttribute('data-open', 'true');
}

async function open(page: Page, options: { files?: Record<string, number[]>; plugins?: string[]; sidebar?: boolean; rightPane?: boolean; doc?: string } = {}) {
  const logs: string[] = [];
  consoleLogs.set(page, logs);
  page.on('console', (m) => logs.push(m.text()));
  const doc = options.doc ?? DOC;
  await launch(page, {
    files: { [DOC]: utf8(MD), ...options.files },
    openPath: doc,
    preferences: { sidebarOpen: options.sidebar ?? false },
    isolated: { plugins: options.plugins ?? [], activateTimeoutMs: 8000, runTimeoutMs: 8000 },
  });
  await page.keyboard.press('ControlOrMeta+o');
  await expect(docTitle(page)).toHaveText(doc.split('/').at(-1)!);
  if (options.rightPane ?? true) await openRightPane(page);
}
const stoppedReasons = (page: Page, plugin: string) => {
  const prefix = `[plugin] 部品「${plugin}」を止めました: `;
  return (consoleLogs.get(page) ?? []).filter((t) => t.startsWith(prefix)).map((t) => t.slice(prefix.length));
};
const selection = (page: Page) => page.evaluate(() => window.__mdeE2E!.editor!.getSelection());
const cursorLine = (page: Page) => page.evaluate(() => {
  const view = window.__mdeE2E!.editor!;
  const { head } = view.getSelection();
  const text = view.getText();
  const from = text.lastIndexOf('\n', head - 1) + 1;
  const to = text.indexOf('\n', head);
  return { head, line: text.slice(from, to < 0 ? undefined : to), atLineStart: head === from };
});
const editorFocused = (page: Page) => page.evaluate(() => document.activeElement?.closest('.cm-content') !== null && document.activeElement?.closest('.cm-content') !== undefined);

test.describe('アウトライン: 見出しの一覧', () => {
  test('Markdown の見出しが、右ペインのパネルに、深さつきで並ぶ', async ({ page }) => {
    await open(page);
    await expect(panel(page)).toBeVisible();
    await expect(panel(page).getByRole('button', { name: /アウトライン/ })).toHaveAttribute('aria-expanded', 'true');
    await expect.poll(() => outlineTexts(page)).toEqual(['第一章', '第一節', '第二章']);
    await expect(outlineItems(page)).toHaveCount(3);
    expect(await outlineItems(page).evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.depth))).toEqual(['0', '1', '0']);
    await expect(page.getByRole('list', { name: 'アウトラインの項目' })).toBeVisible();
    // 右ペインの中に出る（左サイドバーのエクスプローラーの下ではない。フォルダを開いていなくても出る）。
    await expect(page.getByRole('complementary', { name: 'パネル' }).getByTestId('plugin-panels')).toBeVisible();
    await expect(page.getByTestId('sidebar').getByTestId('plugin-panels')).toHaveCount(0);
    // 開く動き（幅の変化）が終わってから、矩形を比べる。
    await expect
      .poll(async () => {
        const paneBox = (await page.getByTestId('right-pane').boundingBox())!;
        const panelBox = (await panel(page).boundingBox())!;
        return paneBox.width === 260 && panelBox.x >= paneBox.x && panelBox.x + panelBox.width <= paneBox.x + paneBox.width + 1;
      })
      .toBe(true);
    // 部品が登録したパネルで、見出しは部品の title。ペインの見出しは「パネル」。
    await expect(page.getByTestId('right-pane').getByRole('heading', { level: 2, name: 'パネル' })).toBeVisible();
  });

  test('入力で更新される（入力が止まった後）。カーソルのある節が強調される', async ({ page }) => {
    await open(page);
    await expect.poll(() => outlineTexts(page)).toEqual(['第一章', '第一節', '第二章']);
    await page.locator('.cm-content').click();
    await page.keyboard.press('ControlOrMeta+End');
    await page.keyboard.type('\n\n## 追加した節');
    await expect.poll(() => outlineTexts(page)).toEqual(['第一章', '第一節', '第二章', '追加した節']);
    // カーソルは追加した節の中。その項目が現在の項目。
    await expect(outlineItems(page).nth(3)).toHaveAttribute('aria-current', 'location');
    await expect(page.locator('[aria-current=location]')).toHaveCount(1);
    // カーソルを本文の中ほど（第一節）へ移すと、強調が動く。
    await page.keyboard.press('ControlOrMeta+Home');
    for (let i = 0; i < 6; i++) await page.keyboard.press('ArrowDown');
    await expect(outlineItems(page).nth(1)).toHaveAttribute('aria-current', 'location');
    // 最初の見出しより前では、強調がない。
    await page.keyboard.press('ControlOrMeta+Home');
    await page.keyboard.type('前置き\n');
    await page.keyboard.press('ArrowUp');
    await expect.poll(async () => (await selection(page)).head).toBe(0);
    await expect(page.locator('[aria-current=location]')).toHaveCount(0);
  });

  test('コードブロックの中の # と front matter の中は数えない', async ({ page }) => {
    const text = ['---', 'title: x', '# コメント', '---', '# 本物', '', '```sh', '# コードの中', '## これも', '```', '', '~~~', '# チルダの中', '~~~', '', '## 次の節'].join('\n');
    await open(page, { files: { [DOC]: utf8(text) } });
    await expect.poll(() => outlineTexts(page)).toEqual(['本物', '次の節']);
  });

  test('素のテキスト（.txt）では「見出しはありません」と出る。見出しのない Markdown も同じ', async ({ page }) => {
    await open(page, { files: { '/docs/plain.txt': utf8('# 見出しに見える行\n## これも'), '/docs/none.md': utf8('見出しのない文書\n') } });
    await expect.poll(() => outlineTexts(page)).toEqual(['第一章', '第一節', '第二章']);
    await setDialogPaths(page, { open: '/docs/plain.txt' });
    await page.keyboard.press('ControlOrMeta+o');
    await expect(docTitle(page)).toHaveText('plain.txt');
    await expect(panel(page).getByTestId('plugin-panel-empty')).toHaveText('見出しはありません');
    await expect(outlineItems(page)).toHaveCount(0);
    await setDialogPaths(page, { open: '/docs/none.md' });
    await page.keyboard.press('ControlOrMeta+o');
    await expect(docTitle(page)).toHaveText('none.md');
    await expect(panel(page).getByTestId('plugin-panel-empty')).toHaveText('見出しはありません');
  });

  test('文書を切り替えると、一覧が切り替わる', async ({ page }) => {
    await open(page, { files: { '/docs/other.md': utf8('# 別の文書\n\n## 別の節\n') } });
    await expect.poll(() => outlineTexts(page)).toEqual(['第一章', '第一節', '第二章']);
    await setDialogPaths(page, { open: '/docs/other.md' });
    await page.keyboard.press('ControlOrMeta+o');
    await expect(docTitle(page)).toHaveText('other.md');
    await expect.poll(() => outlineTexts(page)).toEqual(['別の文書', '別の節']);
    // 切り替えた文書は、入力を待たずに届いている（入力の待ち 200ms より短い間に出る必要はないが、入力なしで届く）。
    expect((await traceOf(page, 'outline', 'doc')).at(-1)).toMatchObject({ kind: 'markdown', length: '# 別の文書\n\n## 別の節\n'.length });
  });
});

test.describe('アウトライン: 見出しへの移動', () => {
  const manyLines = (n: number) => Array.from({ length: n }, (_, i) => `行 ${i}`).join('\n');
  const long = ['# はじめ', manyLines(80), '## 途中の節', manyLines(80), '# 終わりの章', manyLines(10)].join('\n');

  test('項目を押すと、その行の先頭へカーソルが移り、その行が見え、本文にフォーカスが戻る', async ({ page }) => {
    await open(page, { files: { [DOC]: utf8(long) } });
    await expect.poll(() => outlineTexts(page)).toEqual(['はじめ', '途中の節', '終わりの章']);
    await page.locator('.cm-content').click();
    await page.keyboard.press('ControlOrMeta+Home');
    await outlineItems(page).nth(2).click();
    await expect.poll(() => cursorLine(page)).toMatchObject({ line: '# 終わりの章', atLineStart: true });
    expect(await editorFocused(page)).toBe(true);
    // 見出しの行が、本文の表示領域の中に見える（スクロールは、移動のあとの描画で行われる）。
    await expect
      .poll(() =>
        page.evaluate(() => {
          const line = Array.from(document.querySelectorAll('.cm-line')).find((l) => (l.textContent ?? '').endsWith('終わりの章'));
          const area = document.querySelector('.cm-scroller')!.getBoundingClientRect();
          const r = line?.getBoundingClientRect();
          return r ? r.top >= area.top - 1 && r.bottom <= area.bottom + 1 : false;
        }),
      )
      .toBe(true);
    // 強調も、押した項目に移る（カーソルが、その節にある）。
    await expect(outlineItems(page).nth(2)).toHaveAttribute('aria-current', 'location');
    // そのまま書ける（本文にフォーカスがある）。
    await page.keyboard.type('X');
    expect(await editorText(page)).toContain('X# 終わりの章');
  });

  test('キーボード: 上下・Home・End で項目を移り、Enter でその行へ移って、本文にフォーカスが戻る', async ({ page }) => {
    await open(page, { files: { [DOC]: utf8(long) } });
    await expect.poll(() => outlineTexts(page)).toEqual(['はじめ', '途中の節', '終わりの章']);
    await outlineItems(page).nth(0).focus();
    await page.keyboard.press('ArrowDown');
    await expect(outlineItems(page).nth(1)).toBeFocused();
    await page.keyboard.press('End');
    await expect(outlineItems(page).nth(2)).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(outlineItems(page).nth(2)).toBeFocused();
    await page.keyboard.press('Home');
    await expect(outlineItems(page).nth(0)).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await expect.poll(() => cursorLine(page)).toMatchObject({ line: '## 途中の節', atLineStart: true });
    expect(await editorFocused(page)).toBe(true);
  });

  test('Tab で一覧に入る項目は 1 つだけ（現在の項目）。右ペインを閉じると、パネルはフォーカスを受けない', async ({ page }) => {
    await open(page);
    await expect.poll(() => outlineTexts(page)).toEqual(['第一章', '第一節', '第二章']);
    const tabStops = await outlineItems(page).evaluateAll((els) => els.filter((e) => (e as HTMLElement).tabIndex === 0).length);
    expect(tabStops).toBe(1);
    await page.getByTestId('right-pane-toggle').click();
    await expect(page.getByTestId('right-pane')).toHaveAttribute('data-open', 'false');
    await expect(page.getByTestId('right-pane')).toHaveAttribute('inert', '');
    const focusable = await page.evaluate(() => {
      const els = Array.from(document.querySelectorAll<HTMLElement>('[data-testid=plugin-panels] button'));
      els.forEach((e) => e.focus());
      return els.some((e) => document.activeElement === e);
    });
    expect(focusable).toBe(false);
  });

  test('節をたたむと、項目は出なくなる（aria-expanded が変わる）。もう一度押すと戻る', async ({ page }) => {
    await open(page);
    await expect.poll(() => outlineTexts(page)).toEqual(['第一章', '第一節', '第二章']);
    const toggle = panel(page).getByRole('button', { name: /アウトライン/ });
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(outlineItems(page).first()).toBeHidden();
    await toggle.click();
    await expect(outlineItems(page).first()).toBeVisible();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(outlineItems(page)).toHaveCount(3);
  });

  test('項目の版が今の本文の版と違うとき（版 0 の項目のまま、本文が進んだあと）は、押しても移らない', async ({ page }) => {
    await open(page, { plugins: ['e2e-panel-stale'] });
    const stale = page.getByTestId('plugin-panel').filter({ has: page.getByRole('button', { name: /古い項目/ }) });
    await expect(stale.getByTestId('plugin-panel-item')).toHaveText('先頭へ');
    await page.locator('.cm-content').click();
    await page.keyboard.press('ControlOrMeta+End');
    const before = await selection(page);
    expect(before.head).toBeGreaterThan(0);
    await stale.getByTestId('plugin-panel-item').click();
    // 移らない（カーソルはそのまま）。フォーカスも本文には戻らない。
    expect(await selection(page)).toEqual(before);
    await expect(stale.getByTestId('plugin-panel-item')).toBeFocused();
  });
});

test.describe('アウトライン: 本文を送る時機', () => {
  test('右ペインを閉じている間は本文を送らない。開くと最新を送る。たたんでいる間も送らない', async ({ page }) => {
    await open(page, { rightPane: false });
    await page.waitForTimeout(800);
    expect(await traceOf(page, 'outline', 'doc')).toEqual([]);
    expect(await traceOf(page, 'outline', 'selection')).toEqual([]);
    // 閉じている間の入力も、送らない。
    await page.locator('.cm-content').click();
    await page.keyboard.press('ControlOrMeta+End');
    await page.keyboard.type('\n\n# 閉じている間に書いた');
    await page.waitForTimeout(800);
    expect(await traceOf(page, 'outline', 'doc')).toEqual([]);
    // 開くと、最新を送る。
    await openRightPane(page);
    await expect.poll(() => outlineTexts(page)).toEqual(['第一章', '第一節', '第二章', '閉じている間に書いた']);
    const docs = await traceOf(page, 'outline', 'doc');
    expect(docs).toHaveLength(1);
    expect(docs[0]).toMatchObject({ length: (MD + '\n\n# 閉じている間に書いた').length });
    // たたむと、また送らない。
    const toggle = panel(page).getByRole('button', { name: /アウトライン/ });
    await toggle.click();
    await page.locator('.cm-content').click();
    await page.keyboard.press('ControlOrMeta+End');
    await page.keyboard.type('\n# たたんでいる間');
    await page.waitForTimeout(800);
    expect(await traceOf(page, 'outline', 'doc')).toHaveLength(1);
    await toggle.click();
    await expect.poll(() => outlineTexts(page)).toContain('たたんでいる間');
    expect(await traceOf(page, 'outline', 'doc')).toHaveLength(2);
  });

  test('入力のたびには送らない: 速く打った間は送らず、止まってから 1 回だけ送る', async ({ page }) => {
    await open(page);
    await expect.poll(() => outlineTexts(page)).toEqual(['第一章', '第一節', '第二章']);
    const before = (await traceOf(page, 'outline', 'doc')).length;
    await page.locator('.cm-content').click();
    await page.keyboard.press('ControlOrMeta+End');
    // 1 キーごとの間隔は 200ms より短い。
    await page.keyboard.type('\n# abcdef', { delay: 30 });
    await page.waitForTimeout(900);
    const after = await traceOf(page, 'outline', 'doc');
    expect(after.length - before).toBe(1);
    await expect.poll(() => outlineTexts(page)).toContain('abcdef');
  });

  test('IME の変換中は送らない。確定の後に送る（CDP による変換の模擬）', async ({ page }) => {
    await open(page, { files: { [DOC]: utf8('# 見出し\n') } });
    await expect.poll(() => outlineTexts(page)).toEqual(['見出し']);
    await page.locator('.cm-content').click();
    await page.keyboard.press('ControlOrMeta+Home');
    await page.keyboard.press('End');
    const client: CDPSession = await page.context().newCDPSession(page);
    const docs = async () => (await traceOf(page, 'outline', 'doc')).length;
    const before = await docs();
    for (const reading of ['に', 'にほ', 'にほん']) await client.send('Input.imeSetComposition', { text: reading, selectionStart: reading.length, selectionEnd: reading.length });
    // 変換中は、入力が止まっても（200ms を大きく超えても）送らない。一覧も変わらない。
    await page.waitForTimeout(900);
    expect(await docs()).toBe(before);
    expect(await outlineTexts(page)).toEqual(['見出し']);
    // 確定すると、確定した本文が届く。
    await client.send('Input.insertText', { text: '日本' });
    await expect.poll(() => outlineTexts(page)).toEqual(['見出し日本']);
    expect(await docs()).toBe(before + 1);
  });

  test('document.read を宣言した部品には本文とカーソルの位置が届き、宣言していない部品には届かない', async ({ page }) => {
    await open(page, { plugins: ['e2e-panel-echo', 'e2e-panel-undeclared'] });
    const echo = page.getByTestId('plugin-panel').filter({ has: page.getByRole('button', { name: /エコー/ }) });
    const undeclared = page.getByTestId('plugin-panel').filter({ has: page.getByRole('button', { name: /宣言なし/ }) });
    await expect(echo.getByTestId('plugin-panel-item').first()).toHaveText(new RegExp(`^doc v\\d+ markdown ${MD.length}$`));
    await page.locator('.cm-content').click();
    await page.keyboard.press('ControlOrMeta+End');
    await page.keyboard.type('追加');
    await expect(echo.getByTestId('plugin-panel-item').first()).toContainText(`markdown ${MD.length + 2}`);
    await expect(echo.getByTestId('plugin-panel-item').nth(1)).toHaveText(`sel ${MD.length + 2}-${MD.length + 2}`);
    // 宣言していない部品は、何も受け取っていない（画面の文字も、本体の記録も）。
    await page.waitForTimeout(500);
    await expect(undeclared.getByTestId('plugin-panel-item')).toHaveText('何も受け取っていません');
    expect(await traceOf(page, 'e2e-panel-undeclared', 'doc')).toEqual([]);
    expect(await traceOf(page, 'e2e-panel-undeclared', 'selection')).toEqual([]);
    expect(await traceOf(page, 'e2e-panel-echo', 'doc')).not.toEqual([]);
    // 宣言のない部品は止まっていない（本文が届かないだけ）。
    expect(stoppedReasons(page, 'e2e-panel-undeclared')).toEqual([]);
  });
});

test.describe('パネル: 部品の文字列は HTML として解釈されない', () => {
  test('img の onerror、script、javascript: のリンクに見える文字列が、そのまま文字として出る', async ({ page }) => {
    await page.addInitScript(() => {
      (window as unknown as { __e2ePwned?: number }).__e2ePwned = 0;
    });
    await open(page, { plugins: ['e2e-panel-evil'] });
    const evil = page.getByTestId('plugin-panel').filter({ has: page.getByRole('button', { name: /<img src=x onerror=/ }) });
    await expect(evil).toBeVisible();
    await expect(evil.getByTestId('plugin-panel-item')).toHaveText([
      '<img src=x onerror="window.__e2ePwned = 1">',
      '<script>window.__e2ePwned = 1</script>',
      '<a href="javascript:window.__e2ePwned = 1">link</a>',
      '"><svg onload=window.__e2ePwned=1>',
    ]);
    // 要素ができていない。
    await expect(page.getByTestId('plugin-panels').locator('img, script, a, svg, iframe, style')).toHaveCount(0);
    expect(await evil.getByTestId('plugin-panel-item').evaluateAll((els) => els.map((e) => e.children.length))).toEqual([0, 0, 0, 0]);
    // 解釈されていれば立つ印が立っていない（img の読み込みの失敗を待つ間も置く）。
    await page.waitForTimeout(500);
    expect(await page.evaluate(() => (window as unknown as { __e2ePwned?: number }).__e2ePwned)).toBe(0);
  });
});

test.describe('パネル: 上限と不正な形で、その部品だけが止まる', () => {
  for (const [plugin, reason] of [
    ['e2e-panel-flood', 'setItems が多すぎます'],
    ['e2e-panel-many', '項目が多すぎます'],
    ['e2e-panel-bogus', '不正なメッセージ'],
    ['e2e-panel-move', '決めていない種類のメッセージ'],
  ] as const) {
    test(`${plugin}: 止まる（理由: ${reason}）。ほかの部品とアプリは動き続け、入力と保存ができる`, async ({ page }) => {
      await open(page, { plugins: [plugin] });
      await expect.poll(() => stoppedReasons(page, plugin).length).toBe(1);
      expect(stoppedReasons(page, plugin)[0]).toContain(reason);
      // 止めた部品のパネルは消える。同梱のアウトラインは動き続ける。
      await expect(page.getByTestId('plugin-panel')).toHaveCount(1);
      await expect.poll(() => outlineTexts(page)).toEqual(['第一章', '第一節', '第二章']);
      const before = await selection(page);
      await page.locator('.cm-content').click();
      await page.keyboard.press('ControlOrMeta+End');
      await page.keyboard.type('\n# 止まった後も書ける');
      await expect.poll(() => outlineTexts(page)).toContain('止まった後も書ける');
      await expect(unsavedMark(page)).toBeVisible();
      await page.keyboard.press('ControlOrMeta+s');
      await expect(unsavedMark(page)).toHaveCount(0);
      expect(await fileBytes(page, DOC)).toEqual(utf8(`${MD}\n# 止まった後も書ける`));
      // 部品はカーソルを動かしていない（止まる前も後も、本文の移動は利用者の操作だけ）。
      expect(before.head).toBeGreaterThanOrEqual(0);
      expect(stoppedReasons(page, 'outline')).toEqual([]);
    });
  }

  test('1000 項目ちょうどは通り、本文が 1000 を超える見出しを持っても、アウトラインは止まらない（先頭 1000 件）', async ({ page }) => {
    const text = Array.from({ length: 1100 }, (_, i) => `# 見出し ${i}`).join('\n');
    await open(page, { files: { [DOC]: utf8(text) } });
    await expect(outlineItems(page).first()).toHaveText('見出し 0');
    await expect(outlineItems(page)).toHaveCount(1000);
    expect(stoppedReasons(page, 'outline')).toEqual([]);
  });
});

test.describe('パネルとサイドバー', () => {
  test('フォルダを開いても、パネルは右ペインにあり、左のツリーの下には出ない。サイドバーの開閉（Mod+B）は今まで通り', async ({ page }) => {
    await open(page, { sidebar: true, files: { '/work/a.md': utf8('# A\n'), '/work/b.md': utf8('# B\n') } });
    await setDialogPaths(page, { folder: '/work' });
    await page.getByTestId('open-folder').click();
    await expect(page.getByTestId('file-tree')).toBeVisible();
    await expect(panel(page)).toBeVisible();
    await expect(page.getByTestId('sidebar').getByTestId('plugin-panels')).toHaveCount(0);
    const tree = (await page.getByTestId('explorer-tree-area').boundingBox())!;
    const panelBox = (await panel(page).boundingBox())!;
    expect(panelBox.x).toBeGreaterThanOrEqual(tree.x + tree.width - 1);
    // 開いた文書は、ツリーから別の文書へ切り替えられ、アウトラインも切り替わる。
    await page.getByRole('treeitem', { name: 'b.md' }).click();
    await expect.poll(() => outlineTexts(page)).toEqual(['B']);
    await page.keyboard.press('ControlOrMeta+b');
    await expect(page.getByTestId('sidebar')).toHaveAttribute('data-open', 'false');
    await page.keyboard.press('ControlOrMeta+b');
    await expect(page.getByTestId('sidebar')).toHaveAttribute('data-open', 'true');
  });
});
