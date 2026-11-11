import { expect, type CDPSession, type Page } from '@playwright/test';
import { docTitle, launch, test, utf8 } from './helpers';

// ADR-004 追補（コードブロック）: コードブロック。情報文字列からの色（言語は使うときに読み込む）、開きのフェンスの行の Enter で閉じのフェンスを足す、
// 余った閉じのフェンスの重複の防止、⌘/Ctrl+Enter で抜ける、言語名の補完。
// 実 IME ではなく、CDP による変換の模擬。所要時間を抑えるため、ホストの OS（chromium）と Windows の偽装（chromium-windows）だけで動かす。

test.describe.configure({ mode: 'parallel' });
test.beforeEach(({}, testInfo) => {
  test.skip(['chromium-mac', 'chromium-linux'].includes(testInfo.project.name), 'chromium と chromium-windows だけ');
});

const PATH = '/docs/code.md';

async function openDoc(page: Page, text: string, preferences: Record<string, unknown> = {}, path = PATH): Promise<void> {
  await launch(page, { files: { [path]: utf8(text) }, openPath: path, preferences: { theme: 'light', autoHideChrome: false, ...preferences } });
  await page.keyboard.press('ControlOrMeta+o');
  await expect(docTitle(page)).toHaveText(path.split('/').pop()!);
  await page.locator('.cm-content').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('ControlOrMeta+Home');
}

/** 空の文書を開いて、本文にフォーカスを置く。 */
const openEmpty = (page: Page, preferences: Record<string, unknown> = {}) => openDoc(page, '', preferences);

const docText = (page: Page) => page.evaluate(() => window.__mdeE2E!.editor!.getText());
const selection = (page: Page) => page.evaluate(() => window.__mdeE2E!.editor!.getSelection());

/** CSS 変数の色を、描画された色（rgb(...)）にする。 */
const colorOfVar = (page: Page, name: string) =>
  page.evaluate((n) => {
    const probe = document.createElement('span');
    probe.style.color = `var(${n})`;
    document.body.append(probe);
    const color = getComputedStyle(probe).color;
    probe.remove();
    return color;
  }, name);

/** 本文の中で、文字列がちょうど text の span（色を付ける最小の単位）。 */
const token = (page: Page, text: string) => page.locator('.cm-content span').filter({ hasText: new RegExp(`^${text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) }).first();

test.describe('色（言語の選び方と遅延読み込み）', () => {
  test('```ts と Enter で閉じが入り、コードを打つと、キーワード・文字列・コメントに色が付く。明暗のテーマで色が変わる', async ({ page }) => {
    await openEmpty(page);
    await page.keyboard.type('```ts');
    await page.keyboard.press('Enter');
    expect(await docText(page)).toBe('```ts\n\n```');
    await page.keyboard.type("const a = 'x'; // note");
    // 言語は使うときに読み込まれ、読み込みが済むと色が付く。
    await expect(token(page, 'const')).toHaveCSS('color', await colorOfVar(page, '--md-code-keyword'));
    await expect(token(page, "'x'")).toHaveCSS('color', await colorOfVar(page, '--md-code-string'));
    await expect(token(page, '// note')).toHaveCSS('color', await colorOfVar(page, '--md-code-comment'));
    const light = await colorOfVar(page, '--md-code-keyword');
    // 暗いテーマ: 同じ分類で、別の色。
    await openDoc(page, '```ts\nconst a = 1;\n```\n', { theme: 'dark' });
    const dark = await colorOfVar(page, '--md-code-keyword');
    expect(dark).not.toBe(light);
    await expect(token(page, 'const')).toHaveCSS('color', dark);
  });

  test('```main.py は Python の色（ファイル名から選ぶ）。python:main.py も同じ', async ({ page }) => {
    for (const info of ['main.py', 'python:main.py', 'py']) {
      await openDoc(page, `\`\`\`${info}\ndef f():\n    return 42\n\`\`\`\n`);
      await expect(token(page, 'def'), info).toHaveCSS('color', await colorOfVar(page, '--md-code-keyword'));
      await expect(token(page, '42'), info).toHaveCSS('color', await colorOfVar(page, '--md-code-number'));
    }
  });

  test('言語が分かったブロックでも、色の付かない文字（変数名や記号）は、HEAD と同じ等幅・0.92em・コードの色。text のブロックと同じ', async ({ page }) => {
    const code = (fn: string) => `const answer: number = 42;\n${fn}`;
    await openDoc(page, `\`\`\`ts\n${code('function greet(name: string) { return a + b; }')}\n\`\`\`\n\n\`\`\`main.py\ndef add(a, b):\n    return a + b\n\`\`\`\n\n\`\`\`text\nconst keyword = 1;\n\`\`\`\n`);
    // 言語の読み込みが済んで、色が付くまで待つ。
    await expect(token(page, 'def')).toHaveCSS('color', await colorOfVar(page, '--md-code-keyword'));
    await expect(token(page, 'const').first()).toHaveCSS('color', await colorOfVar(page, '--md-code-keyword'));
    const codeColor = await colorOfVar(page, '--md-color-code');
    const style = (needle: string) =>
      page.evaluate((n) => {
        const walker = document.createTreeWalker(document.querySelector('.cm-content')!, NodeFilter.SHOW_TEXT);
        let node: Node | null;
        while ((node = walker.nextNode())) if (node.textContent!.includes(n)) break;
        const cs = getComputedStyle(node!.parentElement!);
        return { family: cs.fontFamily, size: cs.fontSize, color: cs.color };
      }, needle);
    const reference = await style('keyword =');
    expect(reference.family).toContain('monospace');
    expect(reference.color).toBe(codeColor);
    // 18px の 0.92em（HEAD の monospace の tag と同じ。二重に掛けると 15.2px 前後になる）。
    expect(parseFloat(reference.size)).toBeCloseTo(18 * 0.92, 1);
    for (const needle of ['answer', 'name: ', 'a + b']) expect(await style(needle), needle).toEqual(reference);
  });

  test('text と分からない名前と素のテキスト（.txt）には色が付かず、本文の外にも付かない', async ({ page }) => {
    const code = 'const a = "x"; // note';
    await openDoc(page, `\`\`\`ts\n${code}\n\`\`\`\n\n\`\`\`text\n${code}\n\`\`\`\n\n\`\`\`unknownlang\n${code}\n\`\`\`\n\n${code}\n`);
    await expect(token(page, 'const').first()).toHaveCSS('color', await colorOfVar(page, '--md-code-keyword'));
    const colored = await page.locator('.cm-content span').evaluateAll((spans, expected) => spans.filter((s) => s.textContent === 'const' && getComputedStyle(s).color === expected).length, await colorOfVar(page, '--md-code-keyword'));
    expect(colored).toBe(1);
    await openDoc(page, `\`\`\`ts\n${code}\n\`\`\`\n`, {}, '/docs/note.txt');
    await expect(page.locator('.cm-line', { hasText: 'const a' })).toBeVisible();
    expect(await page.locator('.cm-content span').count()).toBe(0);
  });

  test('読み込みの前も本文は読めて、打てる。読み込みが済むと色が付く', async ({ page }) => {
    await launch(page, { files: { [PATH]: utf8('```python\ndef f(): pass\n```\n') }, openPath: PATH, preferences: { theme: 'light', autoHideChrome: false } });
    // アプリが起動した後で、言語の別ファイルの読み込みを保留する。文書を開くと、python の読み込みが始まる（ts、js、css、html は Markdown の言語と同じ塊に入っていて、別ファイルにならない）。
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    let held = 0;
    await page.route(/\/assets\/[^/]+\.js$/, async (route) => {
      held++;
      await gate;
      await route.continue();
    });
    await page.keyboard.press('ControlOrMeta+o');
    await expect(docTitle(page)).toHaveText('code.md');
    await page.locator('.cm-content').click({ position: { x: 5, y: 5 } });
    await expect.poll(() => held).toBeGreaterThan(0);
    await page.keyboard.press('ControlOrMeta+End');
    await page.keyboard.type('abc');
    expect(await docText(page)).toBe('```python\ndef f(): pass\n```\nabc');
    await expect(page.locator('.cm-line', { hasText: 'def f(): pass' })).toBeVisible();
    await expect(token(page, 'def')).toHaveCount(0);
    // 読み込みの前も後も、コードの見た目（等幅、18px の 0.92em、コードの色）は同じ。二重に小さくならない。
    const look = () =>
      page.evaluate(() => {
        const walker = document.createTreeWalker(document.querySelector('.cm-content')!, NodeFilter.SHOW_TEXT);
        let node: Node | null;
        while ((node = walker.nextNode())) if (node.textContent!.includes('(): ')) break;
        const cs = getComputedStyle(node!.parentElement!);
        return { mono: cs.fontFamily.includes('monospace'), size: Math.round(parseFloat(cs.fontSize) * 100) / 100, color: cs.color };
      });
    const codeColor = await colorOfVar(page, '--md-color-code');
    expect(await look()).toEqual({ mono: true, size: 16.56, color: codeColor });
    release();
    await expect(token(page, 'def')).toHaveCSS('color', await colorOfVar(page, '--md-code-keyword'));
    expect(await look()).toEqual({ mono: true, size: 16.56, color: codeColor });
  });

  test('読み込みに失敗しても、本文は読めて、打てる。エラーは出ない', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
    page.on('console', (m) => m.type() === 'error' && errors.push(`console: ${m.text()}`));
    await launch(page, { files: { [PATH]: utf8('```python\ndef f(): pass\n```\n') }, openPath: PATH, preferences: { theme: 'light', autoHideChrome: false } });
    let aborted = 0;
    await page.route(/\/assets\/[^/]+\.js$/, async (route) => {
      aborted++;
      await route.abort();
    });
    await page.keyboard.press('ControlOrMeta+o');
    await expect(docTitle(page)).toHaveText('code.md');
    await page.locator('.cm-content').click({ position: { x: 5, y: 5 } });
    await expect.poll(() => aborted).toBeGreaterThan(0);
    await page.keyboard.press('ControlOrMeta+End');
    await page.keyboard.type('abc');
    expect(await docText(page)).toBe('```python\ndef f(): pass\n```\nabc');
    await expect(token(page, 'def')).toHaveCount(0);
    expect(errors.filter((e) => !/Failed to load resource/.test(e))).toEqual([]);
  });
});

test.describe('閉じのフェンスと Enter', () => {
  test('閉じのあるコードブロックの開きのフェンスの Enter は、ただの改行', async ({ page }) => {
    await openDoc(page, '```ts\nfoo\n```\n');
    await page.keyboard.press('End');
    await page.keyboard.press('Enter');
    expect(await docText(page)).toBe('```ts\n\nfoo\n```\n');
  });

  test('~~~ と 4 つの ` では、同じ記号と長さで閉じる。引用とリストの中では、記号を付ける', async ({ page }) => {
    for (const [open, closed] of [
      ['~~~py', '~~~py\n\n~~~'],
      ['````md', '````md\n\n````'],
      ['> ```ts', '> ```ts\n> \n> ```'],
      ['- ```ts', '- ```ts\n  \n  ```'],
    ] as const) {
      await openEmpty(page);
      await page.keyboard.type(open);
      await page.keyboard.press('Enter');
      expect(await docText(page), open).toBe(closed);
    }
  });

  test('コードの中の Enter は改行（字下げは前の行に合わせる）。2 回押しても抜けず、閉じのフェンスを足さない', async ({ page }) => {
    await openDoc(page, '```ts\n  foo\n```\n');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('End');
    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter');
    // 空白だけの行で Enter を押すと、その行の空白が消え、次の行に字下げが付く（本体の標準の改行。これまでどおり）。
    expect(await docText(page)).toBe('```ts\n  foo\n\n  \n```\n');
  });

  test('重複の防止: コードブロックの直前の行に閉じを自分で打って Enter を押しても、元の閉じのフェンスが新しい開きにならない', async ({ page }) => {
    await openDoc(page, '```ts\nfoo\n```\n');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('End');
    await page.keyboard.press('Enter');
    await page.keyboard.type('```');
    // 元の閉じのフェンスは、ここでは新しい開きのフェンスになっている（本文の最後まで続くコードブロック）。
    expect(await docText(page)).toBe('```ts\nfoo\n```\n```\n');
    await page.keyboard.press('Enter');
    expect(await docText(page)).toBe('```ts\nfoo\n```\n\n');
    const text = await docText(page);
    expect((await selection(page)).head).toBe('```ts\nfoo\n```\n'.length);
    // コードブロックの後ろに戻っているので、続けて書いた文は本文（色もコードの帯もない）。
    await page.keyboard.type('after');
    expect(await docText(page)).toBe(text.replace('```\n\n', '```\nafter\n'));
    await expect(page.locator('.cm-line', { hasText: 'after' })).not.toHaveClass(/cm-md-fence/);
  });

  test('重複の防止: 後ろに別のコードブロックがあっても（元の閉じのフェンスがそのコードブロックの開きを巻き込んでも）、余った閉じのフェンスが取り除かれる', async ({ page }) => {
    await openDoc(page, '```ts\nfoo\n```\n\n```py\nbar\n```\n');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('End');
    await page.keyboard.press('Enter');
    await page.keyboard.type('```');
    expect(await docText(page)).toBe('```ts\nfoo\n```\n```\n\n```py\nbar\n```\n');
    await page.keyboard.press('Enter');
    expect(await docText(page)).toBe('```ts\nfoo\n```\n\n\n```py\nbar\n```\n');
    expect((await selection(page)).head).toBe('```ts\nfoo\n```\n'.length);
    // 後ろのコードブロックは元の形（py のコードブロックの中身の行になる）。
    await expect(page.locator('.cm-line.cm-md-fence-code', { hasText: 'bar' })).toHaveCount(1);
    await expect(page.locator('.cm-line.cm-md-fence-start', { hasText: '```py' })).toHaveCount(1);
  });

  test('きちんと閉じた、隣り合う 2 つのコードブロックの間の Enter は、ただの改行（次の開きのフェンスを取り除かない）', async ({ page }) => {
    await openDoc(page, '```\na\n```\n```\nb\n```\n');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('End');
    await page.keyboard.press('Enter');
    expect(await docText(page)).toBe('```\na\n```\n\n```\nb\n```\n');
  });

  test('変換中の Enter は、開きのフェンスの行でも閉じのフェンスを足さない。確定後の Enter で足す', async ({ page }) => {
    await openEmpty(page);
    await page.keyboard.type('```ts');
    const client: CDPSession = await page.context().newCDPSession(page);
    for (const reading of ['に', 'にほん']) {
      await client.send('Input.imeSetComposition', { text: reading, selectionStart: reading.length, selectionEnd: reading.length });
    }
    await page.locator('.cm-content').evaluate((el) => {
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Process', code: 'Enter', keyCode: 229, isComposing: true, bubbles: true, cancelable: true }));
    });
    expect(await page.locator('.cm-line').count()).toBe(1);
    await client.send('Input.insertText', { text: '日本' });
    expect(await docText(page)).toBe('```ts日本');
    expect(await page.locator('.cm-line').count()).toBe(1);
    await page.keyboard.press('Enter');
    expect(await docText(page)).toBe('```ts日本\n\n```');
  });

  test('範囲選択と複数の選択では、閉じのフェンスを足さない', async ({ page }) => {
    await openEmpty(page);
    await page.keyboard.type('```ts');
    await page.keyboard.press('Shift+Home');
    await page.keyboard.press('Enter');
    // 選択範囲は改行に置き換わる（これまでどおり）。
    expect(await docText(page)).toBe('\n');
  });

  test('リストの継続は今のまま: リストの項目で Enter は次の項目', async ({ page }) => {
    await openDoc(page, '- a\n');
    await page.keyboard.press('ControlOrMeta+End');
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('End');
    await page.keyboard.press('Enter');
    expect(await docText(page)).toBe('- a\n- \n');
  });
});

test.describe('⌘/Ctrl+Enter で抜ける', () => {
  test('コードブロックの中から、閉じのフェンスの次の行へ。次の行がなければ足す', async ({ page }) => {
    await openEmpty(page);
    await page.keyboard.type('```ts');
    await page.keyboard.press('Enter');
    await page.keyboard.type('let a = 1;');
    await page.keyboard.press('ControlOrMeta+Enter');
    expect(await docText(page)).toBe('```ts\nlet a = 1;\n```\n');
    expect((await selection(page)).head).toBe('```ts\nlet a = 1;\n```\n'.length);
    await page.keyboard.type('次の段落');
    expect(await docText(page)).toBe('```ts\nlet a = 1;\n```\n次の段落');
    // 閉じのフェンスの次の行があるときは、その行へ移るだけ（行は足さない）。
    await openDoc(page, '```ts\nfoo\n```\nafter\n');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ControlOrMeta+Enter');
    expect(await docText(page)).toBe('```ts\nfoo\n```\nafter\n');
    expect((await selection(page)).head).toBe('```ts\nfoo\n```\n'.length);
  });

  test('↓ のキーでも閉じのフェンスを越えられる。コードブロックの外の ⌘/Ctrl+Enter は今のまま（空行を足す）', async ({ page }) => {
    await openDoc(page, '```ts\nfoo\n```\nafter\n');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    expect((await selection(page)).head).toBe('```ts\nfoo\n```\n'.length);
    await openDoc(page, 'para\n');
    await page.keyboard.press('ControlOrMeta+Enter');
    expect(await docText(page)).toBe('para\n\n');
  });
});

test.describe('言語名の補完', () => {
  const popup = (page: Page) => page.locator('.cm-tooltip-autocomplete');
  const options = (page: Page) => popup(page).locator('li');
  // 補完を開いてから 75ms は、Enter と Tab を受けない（CodeMirror の interactionDelay。打っている途中の誤選択を防ぐ）。
  const afterInteractionDelay = (page: Page) => page.waitForTimeout(200);

  test('``` の後ろで打ち始めると出て、Enter で選ぶと言語名が置き換わり、色が付く。選んだ後も Enter は閉じのフェンスに届く', async ({ page }) => {
    await openEmpty(page);
    await page.keyboard.type('```pyt');
    await expect(popup(page)).toBeVisible();
    await expect(options(page).first()).toContainText('python');
    await afterInteractionDelay(page);
    await page.keyboard.press('Enter');
    expect(await docText(page)).toBe('```python');
    await expect(popup(page)).toBeHidden();
    await page.keyboard.press('Enter');
    expect(await docText(page)).toBe('```python\n\n```');
    await page.keyboard.type('def f(): pass');
    await expect(token(page, 'def')).toHaveCSS('color', await colorOfVar(page, '--md-code-keyword'));
  });

  test('一覧は画面の中に出る（文書の最初の行でも、長い文書の末尾でも。視線の位置の余白の中にカーソルがあっても隠れない）', async ({ page }) => {
    const inView = async () => {
      await expect(popup(page)).toBeVisible();
      await expect.poll(async () => (await popup(page).boundingBox())?.y ?? -10000).toBeGreaterThan(0);
      const box = (await popup(page).boundingBox())!;
      const size = page.viewportSize()!;
      expect(box.y + box.height).toBeLessThanOrEqual(size.height);
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(size.width);
    };
    // 最初の行（表示領域の上 3 割の中）。
    await openEmpty(page);
    await page.keyboard.type('```pyt');
    await inView();
    // 長い文書の末尾（表示領域の下 3 割の近く）。
    await openDoc(page, Array.from({ length: 60 }, (_, i) => `行 ${i + 1}`).join('\n\n') + '\n\n');
    await page.keyboard.press('ControlOrMeta+End');
    await page.keyboard.type('```pyt');
    await inView();
    // 一覧を閉じると、視線の位置の余白は元に戻る（末尾で書き足しても、カーソルは表示領域の下 3 割より上に保たれる）。
    await page.keyboard.press('Escape');
    await expect(popup(page)).toBeHidden();
    await page.keyboard.press('Enter');
    for (let i = 0; i < 6; i++) await page.keyboard.press('Enter');
    const caretBottom = await page.evaluate(() => {
      const view = document.querySelector('.cm-scroller')!.getBoundingClientRect();
      const sel = window.getSelection()!.getRangeAt(0).getBoundingClientRect();
      return { caret: sel.bottom - view.top, height: view.height };
    });
    expect(caretBottom.caret).toBeLessThanOrEqual(caretBottom.height * 0.72);
  });

  test('Tab でも選べる。:ファイル名は残る', async ({ page }) => {
    await openDoc(page, '```p:main.py\nx = 1\n```\n');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.type('yth');
    await expect(popup(page)).toBeVisible();
    await afterInteractionDelay(page);
    await page.keyboard.press('Tab');
    expect(await docText(page)).toBe('```python:main.py\nx = 1\n```\n');
  });

  test('補完で言語を選び直すと、色が変わる', async ({ page }) => {
    await openDoc(page, '```python\nlet x = 1\n```\n');
    // python では let はキーワードではない。
    await expect(token(page, '1')).toHaveCSS('color', await colorOfVar(page, '--md-code-number'));
    await expect(page.locator('.cm-content span').filter({ hasText: /^let$/ })).toHaveCount(0);
    await page.keyboard.press('End');
    for (let i = 0; i < 'python'.length; i++) await page.keyboard.press('Backspace');
    await page.keyboard.type('typescr');
    await expect(popup(page)).toBeVisible();
    await expect(options(page).first()).toContainText('typescript');
    await afterInteractionDelay(page);
    await page.keyboard.press('Enter');
    expect(await docText(page)).toBe('```typescript\nlet x = 1\n```\n');
    await expect(token(page, 'let')).toHaveCSS('color', await colorOfVar(page, '--md-code-keyword'));
  });

  test('Ctrl+Space で、何も打っていなくても出る。Esc で閉じる。フェンスの行の外では出ない', async ({ page }) => {
    await openEmpty(page);
    await page.keyboard.type('```');
    await page.keyboard.press('Control+Space');
    await expect(popup(page)).toBeVisible();
    expect(await options(page).count()).toBeGreaterThan(5);
    await page.keyboard.press('Escape');
    await expect(popup(page)).toBeHidden();
    // 名前に完全一致したら、打ち始めでは出ない。
    await page.keyboard.type('ts');
    await page.waitForTimeout(400);
    await expect(popup(page)).toBeHidden();
    // 本文のほかの所では出ない。
    await page.keyboard.press('Enter');
    await page.keyboard.type('pyt');
    await page.waitForTimeout(400);
    await expect(popup(page)).toBeHidden();
    await page.keyboard.press('Control+Space');
    await page.waitForTimeout(400);
    await expect(popup(page)).toBeHidden();
  });

  test('暗いテーマでも読める色（選択中の候補が青い既定の色でない）', async ({ page }) => {
    await openEmpty(page, { theme: 'dark' });
    await page.keyboard.type('```pyt');
    await expect(popup(page)).toBeVisible();
    const colors = await popup(page).evaluate((el) => {
      const sel = el.querySelector('li[aria-selected]')!;
      return { bg: getComputedStyle(el).backgroundColor, selected: getComputedStyle(sel).backgroundColor, text: getComputedStyle(sel).color };
    });
    expect(colors.bg).toBe('rgb(42, 45, 48)');
    expect(colors.selected).not.toBe('rgb(17, 119, 204)');
    expect(colors.selected).not.toBe('rgb(51, 68, 119)');
  });
});
