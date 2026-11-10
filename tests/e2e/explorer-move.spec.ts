import { expect, type Locator, type Page, type TestInfo } from '@playwright/test';
import { docTitle, drafts, editorText, externalWrite, fileBytes, launch, test, toast, unsavedMark, utf8 } from './helpers';

// R15: ツリーの項目を、ドラッグアンドドロップと、切り取り・貼り付け（⌘X / ⌘V、Ctrl+X / Ctrl+V、右クリックのメニュー）で別のフォルダへ移す。
// 同じ名前があるときの確認（置き換える / 両方とも残す / 中止）、開いている文書の追従。
// メモリ bridge の結果は DocumentBridge の内側を差し替えたもの。ネイティブ側の規則は src-tauri/src/entries.rs の cargo test が正本。
// 実際の OS のクリップボードには、書かない・読まない（ページ側の記録を差し込んで、呼ばれないことも確かめる）。
// 実行は chromium と chromium-windows だけ（e2e 全体が gate の上限に近いため）。
test.beforeEach(({}, testInfo) => {
  test.skip(['chromium-mac', 'chromium-linux'].includes(testInfo.project.name), 'chromium と chromium-windows だけ');
});

const ROOT = '/work/notes';
const at = (rel: string) => `${ROOT}/${rel}`;

const FILES = {
  [at('a.md')]: utf8('# 見出しA\n\n本文A'),
  [at('b.txt')]: utf8('素のテキスト'),
  [at('c.md')]: utf8('C'),
  [at('same')]: utf8('拡張子のないファイル'),
  [at('docs/guide.md')]: utf8('# ガイド'),
  [at('docs/memo.md')]: utf8('メモ'),
  [at('docs/deep/inner.md')]: utf8('内側'),
  [at('docs/deep/docs/z.md')]: utf8('Z'),
  [at('other/a.md')]: utf8('other の a'),
  [at('other/keep.md')]: utf8('残す'),
  [at('other/same/x.md')]: utf8('同じ名前のフォルダの中'),
};

const SEED = {
  files: FILES,
  folderPath: ROOT,
  emptyFolders: [at('empty')],
  preferences: { theme: 'light', autoHideChrome: false, sidebarOpen: true },
};

const tree = (page: Page) => page.getByTestId('file-tree');
/** 項目の li（パスで指す。同じ名前が複数のフォルダにあるため）。 */
const byPath = (page: Page, path: string) => tree(page).locator(`[role=treeitem][data-path="${path}"]`);
const rowAt = (page: Page, path: string) => byPath(page, path).locator('> .tree-row');
const menu = (page: Page) => page.getByTestId('tree-context-menu');
const dialog = (page: Page) => page.getByTestId('confirm-move-conflict');
const mem = (page: Page) =>
  page.evaluate(() => {
    const s = window.__mdeE2E!;
    return {
      moves: s.moves.map((m) => ({ ...m })),
      moveCalls: s.moveCalls.map((m) => ({ ...m })),
      trashed: [...s.trashed],
      clipboard: [...s.clipboard],
      session: { ...s.session },
    };
  });
const exists = (page: Page, path: string) => page.evaluate((p) => window.__mdeE2E!.files.has(p), path);
const dragLog = (page: Page) =>
  page.evaluate(() => (window as unknown as { __dragLog: Array<{ effect: string }> }).__dragLog.map((e) => ({ ...e })));
const realClipboardCalls = (page: Page) => page.evaluate(() => (window as unknown as { __clipboardCalls: string[] }).__clipboardCalls);
const mod = (platform: string) => (platform === 'mac' ? 'Meta' : 'Control');

/** ドラッグの落とせる・落とせないの記録と、本物のクリップボードの呼び出しの記録を、ページに差し込む（アプリの読み込み前）。 */
async function instrument(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as {
      __dragLog: Array<{ effect: string }>;
      __dragStarts: Array<{ types: string[]; values: string[]; effectAllowed: string }>;
      __clipboardCalls: string[];
    };
    w.__dragLog = [];
    w.__dragStarts = [];
    // ツリーの onDragStart が dataTransfer に入れたもの（document は、ツリーより後の bubbling で受ける）。
    document.addEventListener('dragstart', (e) => {
      const dt = e.dataTransfer!;
      w.__dragStarts.push({ types: [...dt.types], values: dt.types.map((t) => dt.getData(t)), effectAllowed: dt.effectAllowed });
    });
    w.__clipboardCalls = [];
    // ツリーの onDragOver が決めた dropEffect（document は、ツリーより後の bubbling で受ける）。
    document.addEventListener('dragover', (e) => w.__dragLog.push({ effect: e.dataTransfer?.dropEffect ?? 'none' }));
    const clipboard = navigator.clipboard as unknown as Record<string, unknown> | undefined;
    if (clipboard) {
      for (const m of ['writeText', 'readText', 'write', 'read']) {
        clipboard[m] = async () => {
          w.__clipboardCalls.push(m);
          throw new Error('the real clipboard must not be used');
        };
      }
    }
    const exec = document.execCommand.bind(document);
    document.execCommand = (command: string, showUI?: boolean, value?: string) => {
      if (['cut', 'copy', 'paste'].includes(command)) {
        w.__clipboardCalls.push(`exec:${command}`);
        return false;
      }
      return exec(command, showUI, value);
    };
    for (const t of ['cut', 'copy', 'paste']) document.addEventListener(t, () => w.__clipboardCalls.push(`event:${t}`), true);
  });
}

async function openFolder(page: Page, seed: Record<string, unknown> = {}) {
  await instrument(page);
  await launch(page, { ...SEED, ...seed } as Parameters<typeof launch>[1]);
  await page.getByTestId('open-folder').click();
  await expect(tree(page)).toBeVisible();
}

/** 行の中央の座標。 */
async function center(locator: Locator, dx = 0, dy = 0) {
  const box = (await locator.boundingBox())!;
  return { x: box.x + box.width / 2 + dx, y: box.y + box.height / 2 + dy };
}

/** from の行を押してドラッグを始め、to の上まで動かす（落とさない）。 */
async function dragStartOver(page: Page, from: Locator, to: Locator) {
  const start = await center(from);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x + 6, start.y + 6, { steps: 4 });
  const end = await center(to);
  await page.mouse.move(end.x, end.y, { steps: 8 });
  // 動かさなくても dragover は続くが、ツリーの状態の描画を 1 度待つ。
  await page.mouse.move(end.x + 1, end.y, { steps: 2 });
}

async function expandFolder(page: Page, path: string) {
  await rowAt(page, path).click();
  await expect(byPath(page, path)).toHaveAttribute('aria-expanded', 'true');
}

async function shot(page: Page, testInfo: TestInfo, name: string) {
  await page.screenshot({ path: testInfo.outputPath(name) });
}

// ---- コントラスト（ライトとダークで AA） ----

type Rgba = [number, number, number, number];
const parseColor = (css: string): Rgba => {
  const m = css.match(/rgba?\(([^)]+)\)/);
  if (!m) throw new Error(`unexpected color: ${css}`);
  const [r = 0, g = 0, b = 0, a = 1] = m[1]!.split(/[,/\s]+/).filter(Boolean).map(Number);
  return [r, g, b, a];
};
const over = (top: Rgba, bottom: Rgba): Rgba => {
  const a = top[3];
  return [top[0] * a + bottom[0] * (1 - a), top[1] * a + bottom[1] * (1 - a), top[2] * a + bottom[2] * (1 - a), 1];
};
const luminance = ([r, g, b]: Rgba) => {
  const lin = (v: number) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
};
const contrast = (a: Rgba, b: Rgba) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
};

async function styleOf(locator: Locator, props: string[]) {
  return locator.evaluate((el, ps) => {
    const cs = getComputedStyle(el);
    return Object.fromEntries(ps.map((p) => [p, cs.getPropertyValue(p)]));
  }, props);
}

const panelColor = async (page: Page): Promise<Rgba> =>
  parseColor(await page.getByTestId('sidebar').evaluate((el) => getComputedStyle(el).backgroundColor));

// ======================================================================================================

test.describe('ドラッグアンドドロップ (Q2)', () => {
  test('ファイルの行をフォルダの行に落とすと、その中へ移る。フォルダが開き、移した項目が選ばれてフォーカスされる', async ({ page }) => {
    await openFolder(page);
    await rowAt(page, at('b.txt')).dragTo(rowAt(page, at('docs')));
    await expect.poll(async () => (await mem(page)).moves).toEqual([{ from: at('b.txt'), to: at('docs/b.txt'), conflict: 'fail' }]);
    expect(await exists(page, at('docs/b.txt'))).toBe(true);
    expect(await exists(page, at('b.txt'))).toBe(false);
    await expect(byPath(page, at('b.txt'))).toHaveCount(0);
    await expect(byPath(page, at('docs'))).toHaveAttribute('aria-expanded', 'true');
    await expect(byPath(page, at('docs/b.txt'))).toBeVisible();
    await expect(byPath(page, at('docs/b.txt'))).toHaveAttribute('data-selected', 'true');
    await expect(byPath(page, at('docs/b.txt'))).toBeFocused();
    await expect(toast(page)).toHaveCount(0);
  });

  test('フォルダを別のフォルダの中へ。中身ごと移り、展開状態と選択が新しいパスへ引き継がれる', async ({ page }) => {
    await openFolder(page);
    await expandFolder(page, at('docs'));
    await expandFolder(page, at('docs/deep'));
    await rowAt(page, at('docs/deep/inner.md')).click();
    await rowAt(page, at('docs')).dragTo(rowAt(page, at('empty')));
    await expect.poll(async () => (await mem(page)).moves.map((m) => m.to)).toEqual([at('empty/docs')]);
    expect(await exists(page, at('empty/docs/deep/inner.md'))).toBe(true);
    expect(await exists(page, at('docs/guide.md'))).toBe(false);
    // 移し先と、移したフォルダと、その中の展開していたフォルダが開いたまま。
    for (const p of ['empty', 'empty/docs', 'empty/docs/deep']) await expect(byPath(page, at(p))).toHaveAttribute('aria-expanded', 'true');
    await expect(byPath(page, at('empty/docs/deep/inner.md'))).toBeVisible();
    await expect(byPath(page, at('empty/docs'))).toHaveAttribute('data-selected', 'true');
  });

  test('ファイルの行に落とすと、その親フォルダへ移る', async ({ page }) => {
    await openFolder(page);
    await expandFolder(page, at('docs'));
    await rowAt(page, at('c.md')).dragTo(rowAt(page, at('docs/guide.md')));
    await expect.poll(async () => (await mem(page)).moves).toEqual([{ from: at('c.md'), to: at('docs/c.md'), conflict: 'fail' }]);
    await expect(byPath(page, at('docs/c.md'))).toBeVisible();
    await expect(byPath(page, at('c.md'))).toHaveCount(0);
  });

  test('ツリーの空いている所に落とすと、ルートへ移る', async ({ page }) => {
    await openFolder(page);
    await expandFolder(page, at('docs'));
    const area = page.getByTestId('explorer-tree-area');
    const box = (await area.boundingBox())!;
    await rowAt(page, at('docs/memo.md')).dragTo(tree(page), { targetPosition: { x: 40, y: box.height - 12 } });
    await expect.poll(async () => (await mem(page)).moves).toEqual([{ from: at('docs/memo.md'), to: at('memo.md'), conflict: 'fail' }]);
    await expect(byPath(page, at('memo.md'))).toBeVisible();
    await expect(byPath(page, at('docs/memo.md'))).toHaveCount(0);
    // 親が空になっても、フォルダは残る（実際のファイルシステムと同じ）。
    await expect(byPath(page, at('docs'))).toBeVisible();
  });

  test('移らない落とし方: 自分自身、自分の中、同じフォルダ。落とせない先の dropEffect は none で、何も強調されない', async ({ page }) => {
    await openFolder(page);
    await expandFolder(page, at('docs'));
    await expandFolder(page, at('docs/deep'));

    // フォルダを自分自身の上、自分の中のフォルダの上へ。
    await dragStartOver(page, rowAt(page, at('docs')), rowAt(page, at('docs')));
    await expect(page.locator('[data-drop-target=true]')).toHaveCount(0);
    expect((await dragLog(page)).at(-1)).toEqual({ effect: 'none' });
    await dragStartOverMore(page, rowAt(page, at('docs/deep')));
    await expect(page.locator('[data-drop-target=true]')).toHaveCount(0);
    expect((await dragLog(page)).at(-1)).toEqual({ effect: 'none' });
    await page.mouse.up();
    await expect(tree(page)).not.toHaveAttribute('data-dragging', 'true');

    // ルート直下のファイルを、ルート直下の別のファイルの行（親は同じフォルダ）と、空いている所（ルート）へ。
    await dragStartOver(page, rowAt(page, at('c.md')), rowAt(page, at('a.md')));
    expect((await dragLog(page)).at(-1)).toEqual({ effect: 'none' });
    await expect(page.locator('[data-drop-target=true]')).toHaveCount(0);
    await expect(tree(page)).not.toHaveAttribute('data-drop-root', 'true');
    const area = (await page.getByTestId('explorer-tree-area').boundingBox())!;
    await page.mouse.move(area.x + 60, area.y + area.height - 10, { steps: 6 });
    expect((await dragLog(page)).at(-1)).toEqual({ effect: 'none' });
    await expect(tree(page)).not.toHaveAttribute('data-drop-root', 'true');
    await page.mouse.up();

    // フォルダ内のファイルを、その同じフォルダの別の行へ。
    await dragStartOver(page, rowAt(page, at('docs/guide.md')), rowAt(page, at('docs/memo.md')));
    expect((await dragLog(page)).at(-1)).toEqual({ effect: 'none' });
    await page.mouse.up();

    const state = await mem(page);
    expect(state.moveCalls).toEqual([]);
    expect(state.moves).toEqual([]);
    expect(await exists(page, at('c.md'))).toBe(true);
    await expect(toast(page)).toHaveCount(0);
  });

  test('外（Finder など）から落とされたものは受け付けない。ツリーの状態も変わらない', async ({ page }) => {
    await openFolder(page);
    const result = await page.evaluate(() => {
      const target = document.querySelector('[data-testid=file-tree] [data-path="/work/notes/docs"] > .tree-row')!;
      const make = (type: string) => {
        const dt = new DataTransfer();
        dt.items.add(new File(['x'], 'outside.md', { type: 'text/markdown' }));
        dt.setData('text/plain', '/work/notes/c.md');
        return new DragEvent(type, { dataTransfer: dt, bubbles: true, cancelable: true });
      };
      const over = make('dragover');
      target.dispatchEvent(over);
      const drop = make('drop');
      target.dispatchEvent(drop);
      return { overPrevented: over.defaultPrevented, effect: over.dataTransfer!.dropEffect, dropPrevented: drop.defaultPrevented };
    });
    expect(result).toEqual({ overPrevented: false, effect: 'none', dropPrevented: false });
    expect((await mem(page)).moveCalls).toEqual([]);
    await expect(page.locator('[data-drop-target=true]')).toHaveCount(0);
  });

  test('ドラッグ中の dataTransfer には、パスも名前も入らない（外へ漏れても困らない印だけ）', async ({ page }) => {
    await openFolder(page);
    await dragStartOver(page, rowAt(page, at('a.md')), rowAt(page, at('docs')));
    const starts = await page.evaluate(() => (window as unknown as { __dragStarts: Array<{ types: string[]; values: string[]; effectAllowed: string }> }).__dragStarts);
    expect(starts).toHaveLength(1);
    expect(starts[0]!.types).toEqual(['application/x-mde-tree-item']);
    expect(starts[0]!.effectAllowed).toBe('move');
    expect(starts[0]!.values.join('')).not.toMatch(/work|notes|a\.md/);
    // text/plain も、files も入らない。
    expect(starts[0]!.types).not.toContain('text/plain');
    expect(starts[0]!.types).not.toContain('Files');
    // ドラッグが始まっただけで、落とされなければ何も起きない。
    await page.keyboard.press('Escape');
    await page.mouse.up();
    expect((await mem(page)).moveCalls).toEqual([]);
  });

  test('閉じたフォルダの上で 700ms 止まると開く。Esc で取り消すと、何も移らない', async ({ page }) => {
    await openFolder(page);
    await expect(byPath(page, at('docs'))).toHaveAttribute('aria-expanded', 'false');
    await dragStartOver(page, rowAt(page, at('b.txt')), rowAt(page, at('docs')));
    // 700ms より前は閉じたまま。
    await expect(byPath(page, at('docs'))).toHaveAttribute('aria-expanded', 'false');
    await expect(byPath(page, at('docs'))).toHaveAttribute('data-drop-target', 'true');
    const where = await center(rowAt(page, at('docs')));
    await expect
      .poll(
        async () => {
          await page.mouse.move(where.x + 2, where.y, { steps: 2 });
          await page.mouse.move(where.x, where.y, { steps: 2 });
          return byPath(page, at('docs')).getAttribute('aria-expanded');
        },
        { timeout: 4000, intervals: [100] },
      )
      .toBe('true');
    await expect(byPath(page, at('docs/guide.md'))).toBeVisible();

    await page.keyboard.press('Escape');
    await page.mouse.up();
    await expect(tree(page)).not.toHaveAttribute('data-dragging', 'true');
    await expect(page.locator('[data-drop-target=true]')).toHaveCount(0);
    expect((await mem(page)).moveCalls).toEqual([]);
    expect(await exists(page, at('b.txt'))).toBe(true);
  });

  test('上下の端に近づくとスクロールする', async ({ page }) => {
    await openFolder(page, { bulkFolders: [{ path: at('big'), count: 120 }] });
    await expandFolder(page, at('big'));
    const area = page.getByTestId('explorer-tree-area');
    expect(await area.evaluate((el) => el.scrollTop)).toBe(0);
    // 画面に見えている行（big フォルダ自身）を引く。c.md などは、展開した 120 件の下で、画面の外にある。
    await dragStartOver(page, rowAt(page, at('big')), rowAt(page, at('docs')));
    const box = (await area.boundingBox())!;
    // 下の端の近くで保つ。
    await expect
      .poll(
        async () => {
          await page.mouse.move(box.x + 60, box.y + box.height - 6, { steps: 2 });
          await page.mouse.move(box.x + 62, box.y + box.height - 8, { steps: 2 });
          return area.evaluate((el) => el.scrollTop);
        },
        { timeout: 5000, intervals: [100] },
      )
      .toBeGreaterThan(100);
    // 上の端に動かすと、戻る。
    const before = await area.evaluate((el) => el.scrollTop);
    await expect
      .poll(
        async () => {
          await page.mouse.move(box.x + 60, box.y + 4, { steps: 2 });
          await page.mouse.move(box.x + 62, box.y + 6, { steps: 2 });
          return area.evaluate((el) => el.scrollTop);
        },
        { timeout: 5000, intervals: [100] },
      )
      .toBeLessThan(before);
    await page.keyboard.press('Escape');
    await page.mouse.up();
    expect((await mem(page)).moveCalls).toEqual([]);
  });

  test('ドラッグ中の本文と他の UI は変わらない（本文のテキスト、未保存、フォーカス先、サイドバー）', async ({ page }) => {
    await openFolder(page);
    await rowAt(page, at('a.md')).click();
    await expect(docTitle(page)).toHaveText('a.md');
    await page.keyboard.press('ControlOrMeta+End');
    await page.keyboard.type('追記');
    const text = await editorText(page);
    await expect(unsavedMark(page)).toBeVisible();
    await dragStartOver(page, rowAt(page, at('b.txt')), rowAt(page, at('docs')));
    await expect(page.getByTestId('sidebar')).toHaveAttribute('data-open', 'true');
    expect(await editorText(page)).toBe(text);
    await page.keyboard.press('Escape');
    await page.mouse.up();
    await expect(docTitle(page)).toHaveText('a.md');
    await expect(unsavedMark(page)).toBeVisible();
    expect(await editorText(page)).toBe(text);
  });

  for (const theme of ['light', 'dark'] as const) {
    test(`落とせる先の強調は、色だけに頼らない（輪郭の形）。AA を満たす（${theme}）`, async ({ page }, testInfo) => {
      await openFolder(page, { preferences: { ...SEED.preferences, theme } });
      await expandFolder(page, at('docs'));
      const panel = await panelColor(page);

      // フォルダの行: 実線の 2px の枠と、背景。docs の中のファイルを、空のフォルダ empty の上へ。
      await dragStartOver(page, rowAt(page, at('docs/guide.md')), rowAt(page, at('empty')));
      await expect(byPath(page, at('empty'))).toHaveAttribute('data-drop-target', 'true');
      const folderRow = rowAt(page, at('empty'));
      const s = await styleOf(folderRow, ['outline-style', 'outline-width', 'outline-color', 'background-color', 'color']);
      expect(s['outline-style']).toBe('solid');
      expect(s['outline-width']).toBe('2px');
      const rowBackground = over(parseColor(s['background-color']!), panel);
      // 枠は、背景に対して 3:1 以上（UI 部品）、名前の文字は、その背景に対して 4.5:1 以上。
      expect(contrast(parseColor(s['outline-color']!), rowBackground)).toBeGreaterThanOrEqual(3);
      expect(contrast(parseColor(s['color']!), rowBackground)).toBeGreaterThanOrEqual(4.5);
      // 輪郭は、ほかの行にない（強調が 1 か所だけ）。
      await expect(page.locator('[data-drop-target=true]')).toHaveCount(1);
      // 引いている行は、薄い色と斜体（名前の文字は 4.5:1 以上のまま）。
      const dragged = await styleOf(rowAt(page, at('docs/guide.md')), ['font-style', 'color']);
      expect(dragged['font-style']).toBe('italic');
      expect(contrast(parseColor(dragged['color']!), panel)).toBeGreaterThanOrEqual(4.5);
      await shot(page, testInfo, `drag-over-folder-${theme}.png`);

      // 空いている所（ルート）: ツリー全体の破線の枠。
      const area = (await page.getByTestId('explorer-tree-area').boundingBox())!;
      await page.mouse.move(area.x + 60, area.y + area.height - 10, { steps: 6 });
      await page.mouse.move(area.x + 62, area.y + area.height - 12, { steps: 2 });
      await expect(tree(page)).toHaveAttribute('data-drop-root', 'true');
      await expect(page.locator('[data-drop-target=true]')).toHaveCount(0);
      const root = await styleOf(tree(page), ['outline-style', 'outline-width', 'outline-color']);
      expect(root['outline-style']).toBe('dashed');
      expect(root['outline-width']).toBe('2px');
      expect(contrast(parseColor(root['outline-color']!), panel)).toBeGreaterThanOrEqual(3);
      await shot(page, testInfo, `drag-over-root-${theme}.png`);

      // 落とせない先（引いている項目の親と同じフォルダ）は強調しない。
      const memo = await center(rowAt(page, at('docs/memo.md')));
      await page.mouse.move(memo.x, memo.y, { steps: 6 });
      await page.mouse.move(memo.x + 1, memo.y, { steps: 2 });
      await expect(page.locator('[data-drop-target=true]')).toHaveCount(0);
      await expect(tree(page)).not.toHaveAttribute('data-drop-root', 'true');
      expect((await dragLog(page)).at(-1)).toEqual({ effect: 'none' });
      await page.keyboard.press('Escape');
      await page.mouse.up();
      expect((await mem(page)).moveCalls).toEqual([]);
    });
  }

  test('Reduced Motion: 強調に transition も animation も付かない', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await openFolder(page);
    await dragStartOver(page, rowAt(page, at('c.md')), rowAt(page, at('empty')));
    const s = await styleOf(rowAt(page, at('empty')), ['transition-duration', 'animation-name']);
    expect(['0s', '']).toContain(s['transition-duration']);
    expect(s['animation-name']).toBe('none');
    await page.keyboard.press('Escape');
    await page.mouse.up();
  });
});

/** ドラッグの途中で、別の行の上へ動かす。 */
async function dragStartOverMore(page: Page, to: Locator) {
  const end = await center(to);
  await page.mouse.move(end.x, end.y, { steps: 8 });
  await page.mouse.move(end.x + 1, end.y, { steps: 2 });
}

// ======================================================================================================

test.describe('切り取りと貼り付け (Q3)', () => {
  test('⌘X / Ctrl+X で印が付き、⌘V / Ctrl+V でフォーカスのあるフォルダの中へ移る。印は外れ、OS のクリップボードは使わない', async ({ page, platform }) => {
    await openFolder(page);
    await byPath(page, at('b.txt')).focus();
    await page.keyboard.press('ControlOrMeta+x');
    // 名前に「切り取り済み」が付き（支援技術にも分かる）、行は薄く表示される。
    const marked = byPath(page, at('b.txt'));
    await expect(marked).toHaveAttribute('aria-label', 'b.txt（切り取り済み）');
    await expect(marked).toHaveAttribute('data-cut', 'true');
    expect((await styleOf(marked.locator('> .tree-row'), ['font-style']))['font-style']).toBe('italic');
    // 何も移っていない。
    expect((await mem(page)).moveCalls).toEqual([]);

    await byPath(page, at('docs')).focus();
    await page.keyboard.press('ControlOrMeta+v');
    await expect.poll(async () => (await mem(page)).moves).toEqual([{ from: at('b.txt'), to: at('docs/b.txt'), conflict: 'fail' }]);
    await expect(byPath(page, at('docs/b.txt'))).toBeVisible();
    await expect(byPath(page, at('docs/b.txt'))).toHaveAttribute('aria-label', 'b.txt');
    await expect(page.locator('[data-cut=true]')).toHaveCount(0);
    await expect(byPath(page, at('docs/b.txt'))).toBeFocused();

    // 本物のクリップボードは、書かれず、読まれず、cut / paste のイベントも起きない。アプリの記録にも書かれない。
    expect(await realClipboardCalls(page)).toEqual([]);
    expect((await mem(page)).clipboard).toEqual([]);
    expect(mod(platform)).toBeTruthy();
  });

  for (const theme of ['light', 'dark'] as const) {
    test(`切り取りの印の見た目（${theme}）。薄い色でも名前の文字は AA を満たし、色だけでなく斜体と破線でも分かる`, async ({ page }, testInfo) => {
      await openFolder(page, { preferences: { ...SEED.preferences, theme } });
      await expandFolder(page, at('docs'));
      await byPath(page, at('docs/memo.md')).focus();
      await page.keyboard.press('ControlOrMeta+x');
      const marked = rowAt(page, at('docs/memo.md'));
      await expect(byPath(page, at('docs/memo.md'))).toHaveAttribute('data-cut', 'true');
      const panel = await panelColor(page);
      const s = await styleOf(marked, ['color', 'font-style', 'background-image']);
      expect(contrast(parseColor(s['color']!), panel)).toBeGreaterThanOrEqual(4.5);
      expect(s['font-style']).toBe('italic');
      expect(s['background-image']).toContain('repeating-linear-gradient');
      // ほかの行は、通常の見た目のまま。
      expect((await styleOf(rowAt(page, at('docs/guide.md')), ['font-style']))['font-style']).toBe('normal');
      await shot(page, testInfo, `cut-mark-${theme}.png`);
    });
  }

  test('ファイルの行で貼り付けると、その親へ。印の付いた行が消えたあとの貼り付けは何もしない', async ({ page }) => {
    await openFolder(page);
    await expandFolder(page, at('docs'));
    await byPath(page, at('c.md')).focus();
    await page.keyboard.press('ControlOrMeta+x');
    await byPath(page, at('docs/guide.md')).focus();
    await page.keyboard.press('ControlOrMeta+v');
    await expect.poll(async () => (await mem(page)).moves.map((m) => m.to)).toEqual([at('docs/c.md')]);
    // 印がないので、もう一度貼り付けても何もしない。
    await page.keyboard.press('ControlOrMeta+v');
    await page.waitForTimeout(200);
    expect((await mem(page)).moveCalls).toHaveLength(1);
  });

  test('同じフォルダへの貼り付けは何もせず、印を残す。Esc で印が外れる', async ({ page }) => {
    await openFolder(page);
    await byPath(page, at('b.txt')).focus();
    await page.keyboard.press('ControlOrMeta+x');
    await byPath(page, at('c.md')).focus();
    await page.keyboard.press('ControlOrMeta+v');
    await page.waitForTimeout(200);
    expect((await mem(page)).moveCalls).toEqual([]);
    await expect(byPath(page, at('b.txt'))).toHaveAttribute('data-cut', 'true');
    await page.keyboard.press('Escape');
    await expect(page.locator('[data-cut=true]')).toHaveCount(0);
    await expect(byPath(page, at('b.txt'))).toHaveAttribute('aria-label', 'b.txt');
  });

  test('フォルダを自分自身の中へ貼り付けると、移さずに知らせる。印は残る', async ({ page }) => {
    await openFolder(page);
    await byPath(page, at('docs')).focus();
    await page.keyboard.press('ControlOrMeta+x');
    await page.keyboard.press('ControlOrMeta+v');
    await expect(toast(page)).toHaveText('フォルダは、自分自身の中には移せません。');
    expect((await mem(page)).moveCalls).toEqual([]);
    await expect(byPath(page, at('docs'))).toHaveAttribute('data-cut', 'true');
  });

  test('印の付いた項目が消えたら（外部の削除、ゴミ箱）、印が外れる。別のフォルダを開いても外れる', async ({ page }) => {
    await openFolder(page);
    await byPath(page, at('b.txt')).focus();
    await page.keyboard.press('ControlOrMeta+x');
    await expect(page.locator('[data-cut=true]')).toHaveCount(1);
    await externalWrite(page, at('b.txt'), null);
    await expect(byPath(page, at('b.txt'))).toHaveCount(0);
    await expect(page.locator('[data-cut=true]')).toHaveCount(0);

    // ゴミ箱へ移した項目。
    await byPath(page, at('c.md')).focus();
    await page.keyboard.press('ControlOrMeta+x');
    await expect(page.locator('[data-cut=true]')).toHaveCount(1);
    await page.keyboard.press('Delete');
    await page.getByTestId('trash-ok').click();
    await expect(byPath(page, at('c.md'))).toHaveCount(0);
    await expect(page.locator('[data-cut=true]')).toHaveCount(0);

    // 別のフォルダを開く。
    await byPath(page, at('a.md')).focus();
    await page.keyboard.press('ControlOrMeta+x');
    await expect(page.locator('[data-cut=true]')).toHaveCount(1);
    await page.evaluate(() => {
      window.__mdeE2E!.files.set('/work/elsewhere/e.md', new Uint8Array());
      window.__mdeE2E!.folderPath = '/work/elsewhere';
    });
    await page.getByTestId('change-folder').click();
    await expect(page.getByTestId('folder-name')).toHaveText('elsewhere');
    await expect(page.locator('[data-cut=true]')).toHaveCount(0);
  });

  test('名前の入力欄の中と本文の ⌘X / ⌘V は、今のまま（ツリーの操作にならない）', async ({ page, platform }) => {
    await openFolder(page);
    await byPath(page, at('b.txt')).focus();
    await page.keyboard.press('F2');
    const input = page.getByTestId('tree-name-input');
    await expect(input).toBeFocused();
    // 本物の切り取り・貼り付けは起こさず（クリップボードに触れない）、キーイベントの扱いだけを見る。
    const keys = (target: string, key: string) =>
      page.evaluate(
        ([selector, k, isMac]) => {
          const el = document.querySelector(selector)!;
          const ev = new KeyboardEvent('keydown', { key: k, metaKey: isMac, ctrlKey: !isMac, bubbles: true, cancelable: true });
          el.dispatchEvent(ev);
          return ev.defaultPrevented;
        },
        [target, key, platform === 'mac'] as const,
      );
    expect(await keys('[data-testid=tree-name-input]', 'x')).toBe(false);
    expect(await keys('[data-testid=tree-name-input]', 'v')).toBe(false);
    await expect(page.locator('[data-cut=true]')).toHaveCount(0);
    await page.keyboard.press('Escape');

    // 本文。
    await page.locator('.cm-content').click();
    expect(await keys('.cm-content', 'x')).toBe(false);
    expect(await keys('.cm-content', 'v')).toBe(false);
    await expect(page.locator('[data-cut=true]')).toHaveCount(0);
    expect(await realClipboardCalls(page)).toEqual([]);
  });

  test('IME の変換中は、切り取りと貼り付けの対象にしない', async ({ page, platform }) => {
    await openFolder(page);
    await byPath(page, at('b.txt')).focus();
    const prevented = await page.evaluate((isMac) => {
      const el = document.querySelector('[data-path="/work/notes/b.txt"]')!;
      const ev = new KeyboardEvent('keydown', { key: 'x', metaKey: isMac, ctrlKey: !isMac, isComposing: true, bubbles: true, cancelable: true });
      el.dispatchEvent(ev);
      return ev.defaultPrevented;
    }, platform === 'mac');
    expect(prevented).toBe(false);
    await expect(page.locator('[data-cut=true]')).toHaveCount(0);
  });

  test('右クリックのメニュー: 項目の「切り取り」と、フォルダの行の「貼り付け」。印がないあいだ「貼り付け」は選べない', async ({ page }) => {
    await openFolder(page);
    await rowAt(page, at('b.txt')).click({ button: 'right' });
    await expect(menu(page).getByRole('menuitem')).toHaveText(['新しいファイル', '新しいフォルダ', '名前を変更', '切り取り', '貼り付け', 'ゴミ箱に移動', 'パスをコピー']);
    const paste = menu(page).getByRole('menuitem', { name: '貼り付け' });
    await expect(paste).toHaveAttribute('aria-disabled', 'true');
    await paste.click({ force: true });
    // 選べないので、何も起きず、メニューは開いたまま。
    await expect(menu(page)).toBeVisible();
    expect((await mem(page)).moveCalls).toEqual([]);
    await menu(page).getByRole('menuitem', { name: '切り取り' }).click();
    await expect(menu(page)).toHaveCount(0);
    await expect(byPath(page, at('b.txt'))).toHaveAttribute('data-cut', 'true');
    // 行にフォーカスが戻る。
    await expect(byPath(page, at('b.txt'))).toBeFocused();

    await rowAt(page, at('docs')).click({ button: 'right' });
    await expect(menu(page).getByRole('menuitem', { name: '貼り付け' })).not.toHaveAttribute('aria-disabled', 'true');
    await menu(page).getByRole('menuitem', { name: '貼り付け' }).click();
    await expect.poll(async () => (await mem(page)).moves.map((m) => m.to)).toEqual([at('docs/b.txt')]);
    await expect(page.locator('[data-cut=true]')).toHaveCount(0);
    expect(await realClipboardCalls(page)).toEqual([]);
  });

  test('右クリックのメニュー: ファイルの行の「貼り付け」はその親へ、空き領域の「貼り付け」はルートへ', async ({ page }) => {
    await openFolder(page);
    await expandFolder(page, at('docs'));
    await rowAt(page, at('c.md')).click({ button: 'right' });
    await menu(page).getByRole('menuitem', { name: '切り取り' }).click();
    await rowAt(page, at('docs/guide.md')).click({ button: 'right' });
    await menu(page).getByRole('menuitem', { name: '貼り付け' }).click();
    await expect.poll(async () => (await mem(page)).moves.map((m) => m.to)).toEqual([at('docs/c.md')]);

    await rowAt(page, at('docs/c.md')).click({ button: 'right' });
    await menu(page).getByRole('menuitem', { name: '切り取り' }).click();
    const area = page.getByTestId('explorer-tree-area');
    const box = (await area.boundingBox())!;
    await area.click({ button: 'right', position: { x: box.width / 2, y: box.height - 8 } });
    await expect(menu(page).getByRole('menuitem')).toHaveText(['新しいファイル', '新しいフォルダ', '貼り付け']);
    await menu(page).getByRole('menuitem', { name: '貼り付け' }).click();
    await expect.poll(async () => (await mem(page)).moves.map((m) => m.to)).toEqual([at('docs/c.md'), at('c.md')]);
  });

  test('キーボード: メニューを Shift+F10 で開き、「切り取り」を Enter で選べる', async ({ page }) => {
    await openFolder(page);
    await byPath(page, at('c.md')).focus();
    await page.keyboard.press('Shift+F10');
    await expect(menu(page).getByRole('menuitem', { name: '新しいファイル' })).toBeFocused();
    for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowDown');
    await expect(menu(page).getByRole('menuitem', { name: '切り取り' })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(byPath(page, at('c.md'))).toHaveAttribute('data-cut', 'true');
    await expect(byPath(page, at('c.md'))).toBeFocused();
  });
});

// ======================================================================================================

test.describe('同じ名前 (Q4)', () => {
  test('確認が出る。既定は「両方とも残す」。Esc は中止で、何も変えず、フォーカスはツリーへ戻る', async ({ page }) => {
    await openFolder(page);
    await expandFolder(page, at('other'));
    await rowAt(page, at('a.md')).dragTo(rowAt(page, at('other')));
    await expect(dialog(page)).toBeVisible();
    await expect(dialog(page)).toHaveAttribute('role', 'alertdialog');
    await expect(page.getByTestId('move-conflict-message')).toHaveText('“a.md” という名前の項目が “other” にすでにあります。');
    await expect(page.getByTestId('move-conflict-kinds')).toHaveCount(0);
    await expect(page.getByTestId('move-keep-both')).toBeFocused();
    // 最初に fail で試している。
    expect((await mem(page)).moveCalls).toEqual([{ path: at('a.md'), destDir: at('other'), conflict: 'fail' }]);
    await expect(page.getByTestId('move-replace')).toContainText('ゴミ箱');
    await expect(page.getByTestId('move-replace')).not.toHaveAttribute('aria-disabled', 'true');

    await page.keyboard.press('Escape');
    await expect(dialog(page)).toHaveCount(0);
    expect((await mem(page)).moves).toEqual([]);
    expect((await mem(page)).trashed).toEqual([]);
    expect(await exists(page, at('a.md'))).toBe(true);
    expect(await fileBytes(page, at('other/a.md'))).toEqual(utf8('other の a'));
    await expect(toast(page)).toHaveCount(0);
    // フォーカスは、ツリーの中に戻る。
    await expect(tree(page).locator(':focus')).toHaveCount(1);
  });

  test('ダイアログの中で Tab は回る（外のツリーへ出ない）', async ({ page }) => {
    await openFolder(page);
    await rowAt(page, at('a.md')).dragTo(rowAt(page, at('other')));
    await expect(dialog(page)).toBeVisible();
    const order = ['move-keep-both', 'move-cancel', 'move-replace', 'move-keep-both'];
    await expect(page.getByTestId(order[0]!)).toBeFocused();
    for (const id of order.slice(1)) {
      await page.keyboard.press('Tab');
      await expect(page.getByTestId(id)).toBeFocused();
    }
    await page.keyboard.press('Shift+Tab');
    await expect(page.getByTestId('move-replace')).toBeFocused();
    await page.getByTestId('move-cancel').click();
    await expect(dialog(page)).toHaveCount(0);
  });

  test('両方とも残す: 「a 2.md」で移り、既存は残る。移した項目が選ばれる', async ({ page }) => {
    await openFolder(page);
    await rowAt(page, at('a.md')).dragTo(rowAt(page, at('other')));
    await page.getByTestId('move-keep-both').click();
    await expect.poll(async () => (await mem(page)).moves).toEqual([{ from: at('a.md'), to: at('other/a 2.md'), conflict: 'keep-both' }]);
    expect((await mem(page)).moveCalls.map((c) => c.conflict)).toEqual(['fail', 'keep-both']);
    expect(await fileBytes(page, at('other/a 2.md'))).toEqual(utf8('# 見出しA\n\n本文A'));
    expect(await fileBytes(page, at('other/a.md'))).toEqual(utf8('other の a'));
    expect((await mem(page)).trashed).toEqual([]);
    await expect(byPath(page, at('other/a 2.md'))).toHaveAttribute('data-selected', 'true');
    await expect(byPath(page, at('other/a 2.md'))).toBeFocused();
  });

  test('両方とも残す（番号が埋まっているとき）と、拡張子のない名前、フォルダ', async ({ page }) => {
    await openFolder(page, {
      files: { ...FILES, [at('other/a 2.md')]: utf8('2'), [at('other/a 3.md')]: utf8('3') },
    });
    await rowAt(page, at('a.md')).dragTo(rowAt(page, at('other')));
    await page.getByTestId('move-keep-both').click();
    await expect.poll(async () => (await mem(page)).moves.map((m) => m.to)).toEqual([at('other/a 4.md')]);

    // 拡張子のないファイルは末尾に、フォルダも末尾に番号を付ける。
    await rowAt(page, at('same')).dragTo(rowAt(page, at('docs')));
    await expect.poll(async () => (await mem(page)).moves.map((m) => m.to)).toEqual([at('other/a 4.md'), at('docs/same')]);
    await rowAt(page, at('docs/same')).dragTo(rowAt(page, at('other')));
    await expect(dialog(page)).toBeVisible();
    // 種類が違う（移す項目はファイル、すでにある項目はフォルダ）。
    await expect(page.getByTestId('move-conflict-kinds')).toHaveText('移す項目はファイル、すでにある項目はフォルダです。');
    await page.getByTestId('move-keep-both').click();
    await expect.poll(async () => (await mem(page)).moves.map((m) => m.to)).toContain(at('other/same 2'));
  });

  test('置き換える: 既存の項目がゴミ箱へ移り、移した項目がその名前になる', async ({ page }) => {
    await openFolder(page);
    await expandFolder(page, at('other'));
    await rowAt(page, at('a.md')).dragTo(rowAt(page, at('other')));
    await page.getByTestId('move-replace').click();
    await expect.poll(async () => (await mem(page)).moves).toEqual([{ from: at('a.md'), to: at('other/a.md'), conflict: 'replace' }]);
    expect((await mem(page)).trashed).toEqual([at('other/a.md')]);
    expect(await fileBytes(page, at('other/a.md'))).toEqual(utf8('# 見出しA\n\n本文A'));
    expect(await exists(page, at('a.md'))).toBe(false);
    await expect(byPath(page, at('other/a.md'))).toHaveAttribute('data-selected', 'true');
    await expect(byPath(page, at('a.md'))).toHaveCount(0);
  });

  test('切り取りと貼り付けでも同じ確認が出る。中止では印が残り、置き換えを選ぶと移って印が外れる', async ({ page }) => {
    await openFolder(page);
    await byPath(page, at('a.md')).focus();
    await page.keyboard.press('ControlOrMeta+x');
    await byPath(page, at('other')).focus();
    await page.keyboard.press('ControlOrMeta+v');
    await expect(dialog(page)).toBeVisible();
    await page.getByTestId('move-cancel').click();
    await expect(dialog(page)).toHaveCount(0);
    await expect(byPath(page, at('a.md'))).toHaveAttribute('data-cut', 'true');
    await expect(tree(page).locator(':focus')).toHaveCount(1);

    await byPath(page, at('other')).focus();
    await page.keyboard.press('ControlOrMeta+v');
    await page.getByTestId('move-replace').click();
    await expect.poll(async () => (await mem(page)).moves.map((m) => m.conflict)).toEqual(['replace']);
    await expect(page.locator('[data-cut=true]')).toHaveCount(0);
  });

  test('開いている文書を置き換えることになる置き換えは選べず、理由が出る。両方とも残すは選べる', async ({ page }, testInfo) => {
    await openFolder(page);
    await expandFolder(page, at('other'));
    await rowAt(page, at('other/a.md')).click();
    await expect(docTitle(page)).toHaveText('a.md');
    await expect(byPath(page, at('other/a.md'))).toHaveAttribute('aria-current', 'true');
    await rowAt(page, at('a.md')).dragTo(rowAt(page, at('other')));
    await expect(dialog(page)).toBeVisible();
    const replace = page.getByTestId('move-replace');
    await expect(replace).toHaveAttribute('aria-disabled', 'true');
    await expect(page.getByTestId('move-replace-reason')).toHaveText('開いている文書を置き換えることになるため、選べません。');
    await expect(replace).toHaveAccessibleDescription(/開いている文書を置き換える/);
    await shot(page, testInfo, 'conflict-dialog-replace-blocked-light.png');
    // 押せない（aria-disabled。Playwright は force で、利用者が押す操作を送る）。何も起きない。
    await replace.click({ force: true });
    await expect(dialog(page)).toBeVisible();
    expect((await mem(page)).trashed).toEqual([]);
    await page.getByTestId('move-keep-both').click();
    await expect.poll(async () => (await mem(page)).moves.map((m) => m.to)).toEqual([at('other/a 2.md')]);
    // 開いている文書はそのまま。
    await expect(docTitle(page)).toHaveText('a.md');
    expect(await fileBytes(page, at('other/a.md'))).toEqual(utf8('other の a'));
  });

  test('開いている文書を含むフォルダを置き換えることになる置き換えも選べない', async ({ page }) => {
    await openFolder(page, {
      files: { ...FILES, [at('other/docs/open.md')]: utf8('open') },
    });
    await expandFolder(page, at('other'));
    await expandFolder(page, at('other/docs'));
    await rowAt(page, at('other/docs/open.md')).click();
    await expect(docTitle(page)).toHaveText('open.md');
    await rowAt(page, at('docs')).dragTo(rowAt(page, at('other')));
    await expect(dialog(page)).toBeVisible();
    await expect(page.getByTestId('move-replace')).toHaveAttribute('aria-disabled', 'true');
    await expect(page.getByTestId('move-replace-reason')).toContainText('開いている文書');
    await page.keyboard.press('Escape');
  });

  test('移す項目が、置き換える項目の中にあるときも置き換えは選べない（祖先の置き換え）', async ({ page }) => {
    await openFolder(page);
    await expandFolder(page, at('docs'));
    await expandFolder(page, at('docs/deep'));
    // docs/deep/docs を、ルートへ。ルートには docs があり、移す項目はその中にある。
    await rowAt(page, at('docs/deep/docs')).dragTo(tree(page), {
      targetPosition: { x: 40, y: ((await page.getByTestId('explorer-tree-area').boundingBox())!.height) - 12 },
    });
    await expect(dialog(page)).toBeVisible();
    await expect(page.getByTestId('move-replace')).toHaveAttribute('aria-disabled', 'true');
    await expect(page.getByTestId('move-replace-reason')).toHaveText('移す項目が、置き換える項目の中にあるため、選べません。');
    await expect(page.getByTestId('move-conflict-message')).toHaveText('“docs” という名前の項目が “notes” にすでにあります。');
    await page.getByTestId('move-keep-both').click();
    await expect.poll(async () => (await mem(page)).moves.map((m) => m.to)).toEqual([at('docs 2')]);
    expect(await exists(page, at('docs 2/z.md'))).toBe(true);
    expect((await mem(page)).trashed).toEqual([]);
  });

  for (const theme of ['light', 'dark'] as const) {
    test(`確認のダイアログの見た目（${theme}）。文字は AA を満たす`, async ({ page }, testInfo) => {
      await openFolder(page, { preferences: { ...SEED.preferences, theme } });
      await rowAt(page, at('same')).dragTo(rowAt(page, at('other')));
      await expect(dialog(page)).toBeVisible();
      const panel = parseColor(await dialog(page).evaluate((el) => getComputedStyle(el).backgroundColor));
      for (const sel of ['[data-testid=move-conflict-message]', '.move-conflict-note', '.move-conflict-label']) {
        const c = parseColor((await styleOf(dialog(page).locator(sel).first(), ['color']))['color']!);
        expect(contrast(c, panel), sel).toBeGreaterThanOrEqual(4.5);
      }
      await shot(page, testInfo, `conflict-dialog-${theme}.png`);
      await page.keyboard.press('Escape');
    });
  }
});

// ======================================================================================================

test.describe('開いている文書の追従と状態の引き継ぎ (Q4)', () => {
  test('開いている文書のフォルダを移すと、未保存の変更を保ったまま新しいパスに追従し、保存は新しいパスへ書かれる', async ({ page }) => {
    await openFolder(page);
    await expandFolder(page, at('docs'));
    await rowAt(page, at('docs/guide.md')).click();
    await expect(docTitle(page)).toHaveText('guide.md');
    await page.keyboard.press('ControlOrMeta+End');
    await page.keyboard.type('追記した行');
    await expect(unsavedMark(page)).toBeVisible();
    const text = await editorText(page);

    await rowAt(page, at('docs')).dragTo(rowAt(page, at('other')));
    await expect.poll(async () => (await mem(page)).moves.map((m) => m.to)).toEqual([at('other/docs')]);
    await expect(byPath(page, at('other/docs/guide.md'))).toHaveAttribute('aria-current', 'true');
    // 本文と未保存の状態はそのまま。削除扱いにならない（競合バーなし）。
    await expect(docTitle(page)).toHaveText('guide.md');
    await expect(unsavedMark(page)).toBeVisible();
    expect(await editorText(page)).toBe(text);
    await expect(page.getByTestId('conflict-bar')).toHaveCount(0);
    // 草稿のパスと、前回の文書の記録が新しいパス。
    await expect.poll(async () => (await drafts(page)).map((d) => d.path)).toEqual([at('other/docs/guide.md')]);
    expect((await mem(page)).session.lastPath).toBe(at('other/docs/guide.md'));

    await page.locator('.cm-content').click();
    await page.keyboard.press('ControlOrMeta+s');
    await expect(unsavedMark(page)).toHaveCount(0);
    expect(await fileBytes(page, at('other/docs/guide.md'))).toEqual(utf8(text));
    expect(await exists(page, at('docs/guide.md'))).toBe(false);
    expect(await exists(page, at('docs/memo.md'))).toBe(false);
  });

  test('開いている文書そのものを移しても追従する。名前と保存先が変わり、置き換えの確認も追従に影響しない', async ({ page }) => {
    await openFolder(page);
    await rowAt(page, at('c.md')).click();
    await expect(docTitle(page)).toHaveText('c.md');
    await page.keyboard.press('ControlOrMeta+End');
    await page.keyboard.type('X');
    await rowAt(page, at('c.md')).dragTo(rowAt(page, at('empty')));
    await expect.poll(async () => (await mem(page)).moves.map((m) => m.to)).toEqual([at('empty/c.md')]);
    await expect(byPath(page, at('empty/c.md'))).toHaveAttribute('aria-current', 'true');
    await expect(unsavedMark(page)).toBeVisible();
    await page.locator('.cm-content').click();
    await page.keyboard.press('ControlOrMeta+s');
    await expect(unsavedMark(page)).toHaveCount(0);
    expect(await fileBytes(page, at('empty/c.md'))).toEqual(utf8('CX'));
    expect(await exists(page, at('c.md'))).toBe(false);
  });

  test('切り取りと貼り付けで開いている文書を移しても、同じように追従する', async ({ page }) => {
    await openFolder(page);
    await rowAt(page, at('b.txt')).click();
    await page.keyboard.press('ControlOrMeta+End');
    await page.keyboard.type('Y');
    await byPath(page, at('b.txt')).focus();
    await page.keyboard.press('ControlOrMeta+x');
    await byPath(page, at('docs')).focus();
    await page.keyboard.press('ControlOrMeta+v');
    await expect.poll(async () => (await mem(page)).moves.map((m) => m.to)).toEqual([at('docs/b.txt')]);
    await expect(docTitle(page)).toHaveText('b.txt');
    await expect(unsavedMark(page)).toBeVisible();
    await page.locator('.cm-content').click();
    await page.keyboard.press('ControlOrMeta+s');
    await expect(unsavedMark(page)).toHaveCount(0);
    expect(await fileBytes(page, at('docs/b.txt'))).toEqual(utf8('素のテキストY'));
  });
});

// ======================================================================================================

test.describe('失敗と記録 (Q4)', () => {
  test('移せなかったときはトーストで知らせ、アプリのログにはエラーの種類と conflict の値だけを記録する（パスと名前は書かない）', async ({ page }) => {
    await openFolder(page, { preferences: { ...SEED.preferences, appLog: true } });
    await page.evaluate(() => {
      window.__mdeE2E!.failNext.moveEntry = 'io';
    });
    await rowAt(page, at('b.txt')).dragTo(rowAt(page, at('docs')));
    await expect(toast(page)).toContainText('移動できませんでした。');
    expect(await exists(page, at('b.txt'))).toBe(true);
    await expect(byPath(page, at('b.txt'))).toBeVisible();
    await expect
      .poll(() => page.evaluate(() => window.__mdeE2E!.logging.entries.filter((e) => e.source === 'explorer').length), { timeout: 6000 })
      .toBe(1);
    const entries = await page.evaluate(() => window.__mdeE2E!.logging.entries.map((e) => ({ ...e })));
    const failure = entries.find((e) => e.source === 'explorer')!;
    expect(failure.level).toBe('error');
    expect(failure.event).toBe('move-failed');
    expect(failure.data).toEqual({ op: 'move', conflict: 'fail', error: 'BridgeError', kind: 'io' });
    const all = JSON.stringify(entries);
    expect(all).not.toMatch(/b\.txt|secret-path|work\/notes|docs/);
  });

  test('ログを記録しない既定のあいだは、移動の失敗でも appendLog は呼ばれない', async ({ page }) => {
    await openFolder(page);
    await page.evaluate(() => {
      window.__mdeE2E!.failNext.moveEntry = 'not-allowed';
    });
    await rowAt(page, at('b.txt')).dragTo(rowAt(page, at('docs')));
    await expect(toast(page)).toHaveText('移動できませんでした。この場所では操作できません。');
    await page.waitForTimeout(1500);
    expect(await page.evaluate(() => window.__mdeE2E!.logging.appendLogCalls.length)).toBe(0);
  });
});
