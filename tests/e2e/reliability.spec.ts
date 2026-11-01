import { createHash } from 'node:crypto';
import { expect } from '@playwright/test';
import {
  backups,
  bridgeCounters,
  bridgeState,
  conflictBar,
  docTitle,
  drafts,
  editorText,
  externalWrite,
  fileBytes,
  focusEditorEnd,
  focusWindow,
  launch,
  test,
  toast,
  unsavedMark,
  utf8,
} from './helpers';

// 2 秒の待ちを含むテストが多いので、テストを並列に走らせる（各テストは自分のページを持つ）。
test.describe.configure({ mode: 'parallel' });

const DOC = '/docs/note.md';

/** DOC を開いた状態で始める。 */
async function openDoc(page: Parameters<typeof launch>[0], text = '元の本文', extra: Parameters<typeof launch>[1] = {}) {
  await launch(page, { files: { [DOC]: utf8(text) }, openPath: DOC, ...extra });
  await page.keyboard.press('ControlOrMeta+o');
  await expect(docTitle(page)).toHaveText('note.md');
}

async function typeMore(page: Parameters<typeof launch>[0], text: string) {
  await focusEditorEnd(page);
  await page.keyboard.type(text);
  await expect(unsavedMark(page)).toBeVisible();
}

test.describe('外部変更（FS-05）', () => {
  test('(1) 未保存の変更がなければ、自動で読み直して通知する', async ({ page }) => {
    await openDoc(page);

    await externalWrite(page, DOC, '外部で書き換えた本文');

    await expect.poll(() => editorText(page)).toBe('外部で書き換えた本文');
    await expect(toast(page)).toContainText('読み直しました');
    await expect(conflictBar(page)).toHaveCount(0);
    await expect(unsavedMark(page)).toHaveCount(0);
  });

  test('フォーカスが戻ったときの確認でも、通知が届かなかった変更を拾う', async ({ page }) => {
    await openDoc(page);
    await externalWrite(page, DOC, '通知なしの変更', { notify: false });
    expect(await editorText(page)).toBe('元の本文');

    await focusWindow(page);

    await expect.poll(() => editorText(page)).toBe('通知なしの変更');
    await expect(toast(page)).toContainText('読み直しました');
  });

  test('(7) 自分の保存で起きた変更は通知しない', async ({ page }) => {
    await openDoc(page);
    await typeMore(page, '追記');
    await page.keyboard.press('ControlOrMeta+s');
    await expect(unsavedMark(page)).toHaveCount(0);
    const opens = (await bridgeState(page)).calls.open;

    // 自分の保存に対しても、監視は変更を通知する。revision が一致するので、何も起きない。
    await page.evaluate((p) => window.__mdeE2E!.emitDocumentChanged(p), DOC);
    await focusWindow(page);
    await page.waitForTimeout(300);

    await expect(toast(page)).toHaveCount(0);
    await expect(conflictBar(page)).toHaveCount(0);
    expect(await editorText(page)).toBe('元の本文追記');
    expect((await bridgeState(page)).calls.open).toBe(opens);
    expect((await bridgeState(page)).calls.check).toBeGreaterThan(0);
  });

  test('(2) 未保存の変更があるときは、本文に触れず、競合バーで 3 つの選択肢を出す', async ({ page }) => {
    await openDoc(page);
    await typeMore(page, '追記');

    await externalWrite(page, DOC, '外部の版');

    await expect(conflictBar(page)).toBeVisible();
    await expect(page.getByTestId('conflict-diff')).toBeVisible();
    await expect(page.getByTestId('conflict-reload')).toBeVisible();
    await expect(page.getByTestId('conflict-keep')).toBeVisible();
    expect(await editorText(page)).toBe('元の本文追記');
    await expect(unsavedMark(page)).toBeVisible();
    expect(await fileBytes(page, DOC)).toEqual(utf8('外部の版'));
  });

  test('(2a) 差分を見る: 自分の本文とディスクの内容を並べて表示する', async ({ page }) => {
    await openDoc(page, '一行目\n二行目');
    await typeMore(page, '（自分の追記）');
    await externalWrite(page, DOC, '一行目\n二行目（外部の追記）');
    await expect(conflictBar(page)).toBeVisible();

    await page.getByTestId('conflict-diff').click();

    const diff = page.getByTestId('diff-dialog');
    await expect(diff).toBeVisible();
    const editors = diff.locator('.cm-mergeView .cm-editor');
    await expect(editors).toHaveCount(2);
    await expect(editors.nth(0)).toContainText('二行目（自分の追記）');
    await expect(editors.nth(1)).toContainText('二行目（外部の追記）');
    // 変更箇所が強調される。
    await expect(diff.locator('.cm-changedLine, .cm-changedText').first()).toBeVisible();

    // 差分を見ただけでは、何も変わらない。
    await page.keyboard.press('Escape');
    await expect(diff).toHaveCount(0);
    await expect(conflictBar(page)).toBeVisible();
    expect(await editorText(page)).toBe('一行目\n二行目（自分の追記）');
    expect(await fileBytes(page, DOC)).toEqual(utf8('一行目\n二行目（外部の追記）'));
  });

  test('(2b) ディスクから読み直す: 自分の本文を草稿に退避してから読み込み、退避先を知らせる', async ({ page }) => {
    await openDoc(page);
    await typeMore(page, '追記');
    await externalWrite(page, DOC, '外部の版');
    await expect(conflictBar(page)).toBeVisible();

    await page.getByTestId('conflict-reload').click();

    await expect.poll(() => editorText(page)).toBe('外部の版');
    await expect(conflictBar(page)).toHaveCount(0);
    await expect(unsavedMark(page)).toHaveCount(0);
    const stash = (await drafts(page)).find((d) => d.text === '元の本文追記');
    expect(stash).toBeDefined();
    expect(stash).toMatchObject({ path: DOC });
    await expect(toast(page)).toContainText('草稿に退避しました');
    await expect(toast(page)).toContainText(`memory://drafts/${stash!.draftId}.json`);
    // ファイルには、何も書いていない。
    expect(await fileBytes(page, DOC)).toEqual(utf8('外部の版'));
  });

  test('(2c) 自分の版を残す: 次の保存で、ディスクの版をバックアップしてから上書きする', async ({ page }) => {
    await openDoc(page);
    await typeMore(page, '追記');
    await externalWrite(page, DOC, '外部の版');
    await expect(conflictBar(page)).toBeVisible();

    await page.getByTestId('conflict-keep').click();
    // 選んだだけでは書かない。
    expect(await fileBytes(page, DOC)).toEqual(utf8('外部の版'));
    expect(await backups(page)).toEqual([]);

    await page.keyboard.press('ControlOrMeta+s');

    await expect(unsavedMark(page)).toHaveCount(0);
    expect(await fileBytes(page, DOC)).toEqual(utf8('元の本文追記'));
    const saved = await backups(page);
    expect(saved).toHaveLength(1);
    expect(saved[0]?.text).toBe('外部の版');
    await expect(toast(page)).toContainText('バックアップ');
    await expect(conflictBar(page)).toHaveCount(0);
  });

  test('ファイルが削除されたら、本文と未保存状態を残して通知し、保存すると確認のうえ作り直す', async ({ page }) => {
    await openDoc(page);
    await typeMore(page, '追記');

    await externalWrite(page, DOC, null);

    await expect(toast(page)).toContainText('削除');
    await expect(conflictBar(page)).toHaveAttribute('data-state', 'deleted');
    expect(await editorText(page)).toBe('元の本文追記');
    await expect(unsavedMark(page)).toBeVisible();

    // キャンセルすると、作らない。
    await page.keyboard.press('ControlOrMeta+s');
    await expect(page.getByRole('alertdialog')).toBeVisible();
    await page.getByTestId('recreate-cancel').click();
    expect(await fileBytes(page, DOC)).toBeNull();
    await expect(unsavedMark(page)).toBeVisible();

    await page.keyboard.press('ControlOrMeta+s');
    await page.getByTestId('recreate-ok').click();
    await expect(unsavedMark(page)).toHaveCount(0);
    expect(await fileBytes(page, DOC)).toEqual(utf8('元の本文追記'));
    await expect(conflictBar(page)).toHaveCount(0);
  });
});

test.describe('保存直前の検査（FS-04）', () => {
  test('(3) 通知が届く前に外部が書き換えていたら、保存は書かずに競合バーを出す', async ({ page }) => {
    await openDoc(page);
    await typeMore(page, '追記');
    // 監視の通知なし: アプリは、まだ外部の変更に気づいていない。
    await externalWrite(page, DOC, '保存直前に外部が書いた版', { notify: false });
    await expect(conflictBar(page)).toHaveCount(0);

    await page.keyboard.press('ControlOrMeta+s');

    await expect(conflictBar(page)).toBeVisible();
    await expect(toast(page)).toContainText('保存しませんでした');
    expect(await fileBytes(page, DOC)).toEqual(utf8('保存直前に外部が書いた版'));
    expect((await bridgeCounters(page)).physicalWrites).toBe(0);
    expect((await bridgeState(page)).conflicts).toBe(1);
    expect(await editorText(page)).toBe('元の本文追記');
    await expect(unsavedMark(page)).toBeVisible();
  });
});

test.describe('草稿の自動保存（FS-06）', () => {
  test('(8) 入力が 2 秒止まると草稿が書かれ、元の文書には書かない。保存すると草稿は消える', async ({ page }) => {
    await openDoc(page);
    await focusEditorEnd(page);
    const startedAt = Date.now();
    await page.keyboard.type('草稿になる');
    expect(await drafts(page)).toEqual([]);

    await expect.poll(async () => (await drafts(page)).length, { timeout: 6000 }).toBe(1);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(1800);
    const [draft] = await drafts(page);
    expect(draft).toMatchObject({ path: DOC, text: '元の本文草稿になる', baseRevision: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(await fileBytes(page, DOC)).toEqual(utf8('元の本文'));
    expect((await bridgeCounters(page)).calls.save).toBe(0);

    await page.keyboard.press('ControlOrMeta+s');
    await expect.poll(async () => (await drafts(page)).length).toBe(0);
    expect(await fileBytes(page, DOC)).toEqual(utf8('元の本文草稿になる'));
  });

  test('入力が続いている間は書かず、止まってから書く', async ({ page }) => {
    await launch(page);
    await page.locator('.cm-content').click();
    for (let i = 0; i < 5; i++) {
      await page.keyboard.type('あ');
      await page.waitForTimeout(700);
    }
    // 3.5 秒かけて入力したが、各間隔は 2 秒未満なので、まだ書いていない。
    expect(await drafts(page)).toEqual([]);
    await expect.poll(async () => (await drafts(page)).length, { timeout: 5000 }).toBe(1);
    expect((await drafts(page))[0]).toMatchObject({ path: null, text: 'あ'.repeat(5) });
  });

  test('変更を元に戻して未保存でなくなったら、草稿を消す', async ({ page }) => {
    await openDoc(page);
    await typeMore(page, 'x');
    await expect.poll(async () => (await drafts(page)).length, { timeout: 6000 }).toBe(1);
    await page.keyboard.press('Backspace');
    await expect(unsavedMark(page)).toHaveCount(0);
    await expect.poll(async () => (await drafts(page)).length).toBe(0);
  });
});

test.describe('起動時の復旧（受入基準 5・ユースケース 1）', () => {
  const draftId = '0f8fad5b-d9cb-469f-a165-70867728950e';
  const draft = {
    draftId,
    path: DOC,
    text: '元の本文と、強制終了の前に書いた分',
    format: { bom: false, eol: 'lf' as const, mixedEol: false },
    baseRevision: null as string | null,
    updatedAt: Date.UTC(2026, 9, 15, 3, 4),
  };

  /** ディスクの内容の revision（アプリと同じ、バイト列の SHA-256）。 */
  const revisionOf = (text: string): string => createHash('sha256').update(Uint8Array.from(utf8(text))).digest('hex');

  test('強制終了を模す: 入力して草稿が書かれた後、アプリを作り直すと、復旧の確認から復元できる', async ({ page }) => {
    await openDoc(page);
    await typeMore(page, '強制終了の前に書いた分');
    await expect.poll(async () => (await drafts(page)).length, { timeout: 6000 }).toBe(1);
    // 強制終了: 保存も確認もなく、アプリが消える。ディスクの文書と草稿だけが残る。
    const leftover = await drafts(page);
    const file = await fileBytes(page, DOC);
    expect(file).toEqual(utf8('元の本文'));

    const fresh = await page.context().newPage();
    await page.close();
    await launch(fresh, { files: { [DOC]: file! }, drafts: leftover });
    await expect(fresh.getByTestId('recovery-dialog')).toBeVisible();
    await expect(fresh.getByTestId('recovery-name')).toHaveText('note.md');
    await fresh.getByTestId('recovery-restore').click();

    await expect(docTitle(fresh)).toHaveText('note.md');
    expect(await editorText(fresh)).toBe('元の本文強制終了の前に書いた分');
    await expect(unsavedMark(fresh)).toBeVisible();
    await expect(conflictBar(fresh)).toHaveCount(0);
    // 保存すれば、草稿は消える。
    await fresh.keyboard.press('ControlOrMeta+s');
    await expect(unsavedMark(fresh)).toHaveCount(0);
    expect(await fileBytes(fresh, DOC)).toEqual(utf8('元の本文強制終了の前に書いた分'));
    await expect.poll(async () => (await drafts(fresh)).length).toBe(0);
  });

  test('(4) 復元する: 文書名と時刻を出し、本文を復元する', async ({ page }) => {
    const base = revisionOf('元の本文');
    await launch(page, { files: { [DOC]: utf8('元の本文') }, drafts: [{ ...draft, baseRevision: base }] });

    await expect(page.getByTestId('recovery-dialog')).toBeVisible();
    await expect(page.getByRole('alertdialog')).toContainText('前回の未保存の草稿があります');
    await expect(page.getByTestId('recovery-name')).toHaveText('note.md');
    await expect(page.getByTestId('recovery-time')).toContainText('2026');

    await page.getByTestId('recovery-restore').click();

    await expect(page.getByTestId('recovery-dialog')).toHaveCount(0);
    await expect(docTitle(page)).toHaveText('note.md');
    expect(await editorText(page)).toBe(draft.text);
    await expect(unsavedMark(page)).toBeVisible();
    await expect(conflictBar(page)).toHaveCount(0);
  });

  test('(4) 破棄する: 草稿を消し、空の無題で始まる', async ({ page }) => {
    await launch(page, { files: { [DOC]: utf8('元の本文') }, drafts: [draft], session: { lastPath: DOC } });
    await page.getByTestId('recovery-discard').click();

    await expect(page.getByTestId('recovery-dialog')).toHaveCount(0);
    await expect.poll(async () => (await drafts(page)).length).toBe(0);
    expect(await editorText(page)).toBe('');
    await expect(docTitle(page)).toHaveText('無題');
  });

  test('(4) あとで: 草稿は残り、空の無題で始まる（Esc でも同じ）', async ({ page }) => {
    await launch(page, { files: { [DOC]: utf8('元の本文') }, drafts: [draft] });
    await page.keyboard.press('Escape');

    await expect(page.getByTestId('recovery-dialog')).toHaveCount(0);
    expect((await drafts(page)).map((d) => d.draftId)).toEqual([draftId]);
    expect(await editorText(page)).toBe('');
    await expect(docTitle(page)).toHaveText('無題');
  });

  test('草稿の後で元のファイルが変わっていたら、復元しても競合として扱い、上書きしない', async ({ page }) => {
    const base = revisionOf('元の本文');
    await launch(page, {
      files: { [DOC]: utf8('草稿の後に、外部が書いた版') },
      drafts: [{ ...draft, baseRevision: base }],
    });
    await page.getByTestId('recovery-restore').click();

    await expect(conflictBar(page)).toBeVisible();
    expect(await editorText(page)).toBe(draft.text);
    await page.keyboard.press('ControlOrMeta+s');
    await expect(toast(page)).toContainText('保存しませんでした');
    expect(await fileBytes(page, DOC)).toEqual(utf8('草稿の後に、外部が書いた版'));
  });

  test('複数の草稿があるときは、最も新しいものを出し、ほかの件数を知らせる', async ({ page }) => {
    const older = { ...draft, draftId: '7c9e6679-7425-40de-944b-e07fc1f90ae7', path: null, text: '古い草稿', updatedAt: 1000 };
    await launch(page, { files: { [DOC]: utf8('元の本文') }, drafts: [older, draft] });
    await expect(page.getByTestId('recovery-name')).toHaveText('note.md');
    await expect(page.getByTestId('recovery-others')).toContainText('1 件');
  });

  test('(5) 草稿がなければ、前回の文書を開き直す', async ({ page }) => {
    await launch(page, { files: { [DOC]: utf8('前回の本文') }, session: { lastPath: DOC } });

    await expect(docTitle(page)).toHaveText('note.md');
    expect(await editorText(page)).toBe('前回の本文');
    await expect(unsavedMark(page)).toHaveCount(0);
    await expect(page.getByTestId('recovery-dialog')).toHaveCount(0);
  });

  test('(5) 前回の文書がなくなっていれば、何もしない', async ({ page }) => {
    await launch(page, { files: {}, session: { lastPath: '/docs/gone.md' } });
    await page.waitForTimeout(300);
    await expect(docTitle(page)).toHaveText('無題');
    await expect(toast(page)).toHaveCount(0);
    expect(await editorText(page)).toBe('');
  });

  test('文書を開く・保存先を選ぶと、前回の文書として覚える', async ({ page }) => {
    await openDoc(page);
    expect((await bridgeState(page)).session).toEqual({ lastPath: DOC });
    expect((await bridgeState(page)).watched).toBe(DOC);
  });
});

test.describe('終了時の確認（FS-02）', () => {
  test('(6) 未保存の変更がなければ、確認せずに終了する', async ({ page }) => {
    await openDoc(page);
    await page.evaluate(() => window.__mdeE2E!.requestClose());
    await expect.poll(async () => (await bridgeState(page)).closed).toBe(true);
    await expect(page.getByRole('alertdialog')).toHaveCount(0);
  });

  test('(6) 未保存の変更があれば確認する。キャンセルすると終了しない', async ({ page }) => {
    await openDoc(page);
    await typeMore(page, '追記');

    await page.evaluate(() => window.__mdeE2E!.requestClose());
    await expect(page.getByRole('alertdialog')).toContainText('note.md');
    await page.getByTestId('discard-cancel').click();

    await expect(page.getByRole('alertdialog')).toHaveCount(0);
    expect((await bridgeState(page)).closed).toBe(false);
    await expect(unsavedMark(page)).toBeVisible();
  });

  test('(6) 保存して終了する', async ({ page }) => {
    await openDoc(page);
    await typeMore(page, '追記');
    await page.evaluate(() => window.__mdeE2E!.requestClose());
    await page.getByTestId('discard-save').click();

    await expect.poll(async () => (await bridgeState(page)).closed).toBe(true);
    expect(await fileBytes(page, DOC)).toEqual(utf8('元の本文追記'));
  });

  test('(6) 保存しないで終了する: ファイルは変わらず、草稿も残らない', async ({ page }) => {
    await openDoc(page);
    await typeMore(page, '追記');
    await expect.poll(async () => (await drafts(page)).length, { timeout: 6000 }).toBe(1);

    await page.evaluate(() => window.__mdeE2E!.requestClose());
    await page.getByTestId('discard-discard').click();

    await expect.poll(async () => (await bridgeState(page)).closed).toBe(true);
    expect(await fileBytes(page, DOC)).toEqual(utf8('元の本文'));
    expect(await drafts(page)).toEqual([]);
  });

  test('(6) 保存が競合したときは、終了しない', async ({ page }) => {
    await openDoc(page);
    await typeMore(page, '追記');
    await externalWrite(page, DOC, '外部の版', { notify: false });
    await page.evaluate(() => window.__mdeE2E!.requestClose());
    await page.getByTestId('discard-save').click();

    await expect(conflictBar(page)).toBeVisible();
    expect((await bridgeState(page)).closed).toBe(false);
    expect(await fileBytes(page, DOC)).toEqual(utf8('外部の版'));
  });
});
