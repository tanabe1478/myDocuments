import { readFileSync } from 'node:fs';
import { expect, type Page } from '@playwright/test';
import { docTitle, launch, test, utf8 } from './helpers';

// 隔離した操作（段 2）の仕組み（ADR-005 の R5）。e2e のビルドだけが入れるテスト用の部品（src/isolated-plugins/e2eFixtures.ts）で、
// sandbox の iframe の中の blob の Worker で動き、postMessage で本体とやりとりすることを確かめる。

const DOC = '/docs/note.md';
const trace = (page: Page) => page.evaluate(() => window.__mdeE2EIsolatedTrace ?? []);

/** console に出た、部品を止めた記録（レジストリが残す）。page ごとに集める。 */
const consoleLogs = new WeakMap<Page, string[]>();
const stopped = async (page: Page, plugin: string) => {
  const prefix = `[plugin] 部品「${plugin}」を止めました: `;
  return (consoleLogs.get(page) ?? []).filter((t) => t.startsWith(prefix)).map((t) => t.slice(prefix.length));
};
const hostFrame = (page: Page) => page.locator('iframe[data-testid="plugin-host-frame"]');

async function open(page: Page, plugins: string[], timeouts: { activateTimeoutMs?: number; runTimeoutMs?: number } = {}) {
  const logs: string[] = [];
  consoleLogs.set(page, logs);
  page.on('console', (m) => logs.push(m.text()));
  await launch(page, { files: { [DOC]: utf8('はじめ') }, openPath: DOC, isolated: { plugins, activateTimeoutMs: 8000, runTimeoutMs: 8000, ...timeouts } });
  await page.keyboard.press('ControlOrMeta+o');
  await expect(docTitle(page)).toHaveText('note.md');
}

test('段 2 の部品がないとき、iframe も Worker の受け口も作られない', async ({ page }) => {
  await launch(page, { files: { [DOC]: utf8('はじめ') }, openPath: DOC });
  await expect(page.locator('iframe')).toHaveCount(0);
  expect(await trace(page)).toEqual([]);
  // 本体のコマンドはそのまま動く（段 2 の仕組みが入っていても、起動と入力に影響しない）。
  await page.keyboard.press('ControlOrMeta+o');
  await expect(docTitle(page)).toHaveText('note.md');
});

test('ブラウザ版が配信するホストのファイルは、元のファイルと同じバイト列で、meta の CSP を持つ', async ({ page }) => {
  await launch(page);
  for (const name of ['host.html', 'relay.js']) {
    const res = await page.request.get(`/plug/${name}`);
    expect(res.status()).toBe(200);
    expect(await res.body()).toEqual(readFileSync(new URL(`../../src/plugin-host/${name}`, import.meta.url)));
  }
  const html = await (await page.request.get('/plug/host.html')).text();
  expect(html).toContain(`<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src plug: 'self'; worker-src blob:" />`);
});

test('ショートカットで部品のコマンドが実行され、本体に結果（done）が届く。本体の入力は止まらない', async ({ page }) => {
  await open(page, ['e2e-ok']);
  await expect(hostFrame(page)).toHaveCount(1);
  await expect(hostFrame(page)).toHaveAttribute('sandbox', 'allow-scripts');
  await expect.poll(async () => (await trace(page)).some((e) => e.type === 'ready' && e.plugin === 'e2e-ok')).toBe(true);
  expect((await trace(page)).filter((e) => e.type === 'command')).toEqual([{ type: 'command', plugin: 'e2e-ok', command: 'record' }]);

  await page.locator('.cm-content').click();
  await page.keyboard.press('ControlOrMeta+Shift+E');
  await expect.poll(async () => (await trace(page)).filter((e) => e.type === 'done')).toEqual([{ type: 'done', plugin: 'e2e-ok', command: 'record', req: 1 }]);
  // 実行は、本体のキー入力を止めない（本体は結果を待たない）。
  await page.keyboard.type('あ');
  await expect(page.locator('.cm-content')).toContainText('あ');
  expect(await stopped(page, 'e2e-ok')).toEqual([]);
});

test('例外を出した部品だけが止まり、ほかの部品とアプリは動き続ける（入力・保存ができる）', async ({ page }) => {
  await open(page, ['e2e-ok', 'e2e-throws']);
  await expect.poll(async () => (await trace(page)).filter((e) => e.type === 'ready').length).toBe(2);

  await page.locator('.cm-content').click();
  await page.keyboard.press('ControlOrMeta+Shift+X');
  await expect.poll(() => stopped(page, 'e2e-throws')).toEqual([expect.stringContaining('boom')]);
  // 止めた部品のショートカットは、もう何も起こさない。
  const runsBefore = (await trace(page)).filter((e) => e.type === 'run').length;
  await page.keyboard.press('ControlOrMeta+Shift+X');
  await page.waitForTimeout(150);
  expect((await trace(page)).filter((e) => e.type === 'run').length).toBe(runsBefore);

  // ほかの部品は動き続ける。
  await page.keyboard.press('ControlOrMeta+Shift+E');
  await expect.poll(async () => (await trace(page)).some((e) => e.type === 'done' && e.plugin === 'e2e-ok')).toBe(true);
  expect(await stopped(page, 'e2e-ok')).toEqual([]);

  // アプリは動き続ける: 入力して保存できる。
  await page.keyboard.type('つづき');
  await expect(page.locator('.cm-content')).toContainText('つづき');
  await page.keyboard.press('ControlOrMeta+s');
  await expect.poll(() => page.evaluate(() => window.__mdeE2E!.calls.save)).toBe(1);
});

test('応答しない部品（無限ループ）が時間切れで止まり、その間も入力が止まらない', async ({ page }) => {
  await open(page, ['e2e-ok', 'e2e-loop'], { runTimeoutMs: 1000 });
  await expect.poll(async () => (await trace(page)).filter((e) => e.type === 'ready').length).toBe(2);
  await page.locator('.cm-content').click();
  const start = Date.now();
  await page.keyboard.press('ControlOrMeta+Shift+M');
  // ループしている間も、本体の入力は止まらない。
  for (const ch of 'abc') await page.keyboard.type(ch);
  await expect(page.locator('.cm-content')).toContainText('abc');
  expect(await stopped(page, 'e2e-loop')).toEqual([]);
  expect(Date.now() - start).toBeLessThan(900);
  // 時間切れで止まる。
  await expect.poll(() => stopped(page, 'e2e-loop'), { timeout: 6000 }).toEqual([expect.stringContaining('終わりませんでした')]);
  // ほかの部品は動き続ける。
  await page.keyboard.press('ControlOrMeta+Shift+E');
  await expect.poll(async () => (await trace(page)).some((e) => e.type === 'done' && e.plugin === 'e2e-ok')).toBe(true);
  await page.keyboard.type('def');
  await expect(page.locator('.cm-content')).toContainText('abcdef');
});

test('最初の実行で例外、決めていない形のメッセージ、本体のコマンドとのショートカットの重なりは、その部品だけを止める', async ({ page }) => {
  await open(page, ['e2e-ok', 'e2e-activate-throws', 'e2e-bogus', 'e2e-clash']);
  await expect.poll(() => stopped(page, 'e2e-activate-throws')).toEqual([expect.stringContaining('activate boom')]);
  await expect.poll(() => stopped(page, 'e2e-bogus')).toEqual([expect.stringContaining('不正なメッセージ')]);
  await expect.poll(() => stopped(page, 'e2e-clash')).toEqual([expect.stringContaining('Mod+Shift+F')]);
  expect(await stopped(page, 'e2e-ok')).toEqual([]);
  // 重なったショートカットは、本体のコマンド（フォーカスモード）のまま。
  await page.locator('.cm-content').click();
  await page.keyboard.press('ControlOrMeta+Shift+F');
  await expect(page.locator('.cm-editor')).toHaveClass(/./);
  expect((await trace(page)).some((e) => e.type === 'run' && e.plugin === 'e2e-clash')).toBe(false);
  await page.keyboard.press('ControlOrMeta+Shift+E');
  await expect.poll(async () => (await trace(page)).some((e) => e.type === 'done' && e.plugin === 'e2e-ok')).toBe(true);
});

test('部品のコードは、本体のページの DOM と window、ネットワーク、保存領域に届かない', async ({ page }) => {
  await open(page, ['e2e-reach']);
  await expect.poll(async () => (await trace(page)).some((e) => e.type === 'ready')).toBe(true);
  await page.evaluate(() => {
    (window as unknown as Record<string, unknown>).__secret = 'main-page-secret';
    localStorage.setItem('secret', 'main-page-secret');
  });
  await page.locator('.cm-content').click();
  await page.keyboard.press('ControlOrMeta+Shift+Y');
  // 届くものがあれば、部品が例外を出して止まる。止まらずに done が届けば、どれにも届かなかった。
  await expect.poll(async () => (await trace(page)).some((e) => e.type === 'done' && e.plugin === 'e2e-reach')).toBe(true);
  expect(await stopped(page, 'e2e-reach')).toEqual([]);

  // 仲介の iframe の中の文脈（部品のコードは動かない）も、本体の DOM と window に届かない。
  const frame = page.frames().find((f) => f.url().endsWith('/plug/host.html'));
  expect(frame).toBeDefined();
  const reach = await frame!.evaluate(() => {
    const attempt = (fn: () => unknown) => {
      try {
        return { value: String(fn()) };
      } catch (e) {
        return { error: (e as Error).name };
      }
    };
    return {
      origin: self.origin,
      parentDocument: attempt(() => parent.document.title),
      parentSecret: attempt(() => (parent as unknown as Record<string, unknown>).__secret),
      parentStorage: attempt(() => parent.localStorage.getItem('secret')),
      topLocation: attempt(() => top!.location.href),
      ownStorage: attempt(() => localStorage.getItem('secret')),
    };
  });
  expect(reach.origin).toBe('null');
  expect(reach.parentDocument).toEqual({ error: 'SecurityError' });
  expect(reach.parentSecret).toEqual({ error: 'SecurityError' });
  expect(reach.parentStorage).toEqual({ error: 'SecurityError' });
  expect(reach.topLocation).toEqual({ error: 'SecurityError' });
  expect(reach.ownStorage).toEqual({ error: 'SecurityError' });
});

test('仲介の iframe から送られた決めていない形のメッセージと、iframe 以外から送られたメッセージは、本体が受け付けない', async ({ page }) => {
  await open(page, ['e2e-ok']);
  await expect.poll(async () => (await trace(page)).some((e) => e.type === 'ready')).toBe(true);
  const before = await trace(page);
  // 本体の窓自身から（iframe ではない送り元）、iframe からのように見せたメッセージ（done や stopped）を送る。
  await page.evaluate(() => {
    window.postMessage({ v: 0, kind: 'stopped', plugin: 'e2e-ok', reason: 'forged' }, '*');
    window.postMessage({ v: 0, kind: 'command', plugin: 'e2e-ok', id: 'forged', title: 'forged', shortcut: 'Mod+Shift+Q' }, '*');
  });
  // iframe の中の文脈から、決めていない形のメッセージを送る。
  const frame = page.frames().find((f) => f.url().endsWith('/plug/host.html'))!;
  await frame.evaluate(() => {
    parent.postMessage({ v: 0, kind: 'stopped', plugin: 'e2e-ok', reason: 'x'.repeat(1000) }, '*');
    parent.postMessage({ v: 0, kind: 'steal', plugin: 'e2e-ok' }, '*');
    parent.postMessage('stopped', '*');
    parent.postMessage({ v: 1, kind: 'ready', plugin: 'e2e-ok' }, '*');
  });
  await page.waitForTimeout(300);
  expect(await trace(page)).toEqual(before);
  expect(await stopped(page, 'e2e-ok')).toEqual([]);
  // 部品は今も動く。
  await page.locator('.cm-content').click();
  await page.keyboard.press('ControlOrMeta+Shift+E');
  await expect.poll(async () => (await trace(page)).some((e) => e.type === 'done')).toBe(true);
});

test('ブラウザ版では、host.html の meta の CSP が効く（blob の Worker だけ許し、inline の script、blob 以外の Worker、ネットワークは止まる）', async ({ page }) => {
  await open(page, ['e2e-ok']);
  await expect.poll(async () => (await trace(page)).some((e) => e.type === 'ready')).toBe(true);
  const frame = page.frames().find((f) => f.url().endsWith('/plug/host.html'))!;
  const result = await frame.evaluate(async () => {
    const violations: string[] = [];
    document.addEventListener('securitypolicyviolation', (e) => violations.push(e.violatedDirective));
    const attempt = async (fn: () => unknown) => {
      try {
        await fn();
        return 'allowed';
      } catch (e) {
        return `blocked:${(e as Error).name}`;
      }
    };
    const out = {
      blobWorker: await attempt(() => {
        const w = new Worker(URL.createObjectURL(new Blob(['postMessage(1)'], { type: 'text/javascript' })));
        w.terminate();
      }),
      fileWorker: await attempt(() => new Worker('/plug/relay.js').terminate()),
      fetch: await attempt(() => fetch('/plug/host.html')),
      inlineScript: await attempt(() => {
        const s = document.createElement('script');
        s.textContent = 'window.__inline = 1';
        document.head.appendChild(s);
        if ((window as unknown as Record<string, unknown>).__inline) throw new Error('ran');
      }),
    };
    await new Promise((r) => setTimeout(r, 200));
    return { out, violations };
  });
  // default-src 'none' のもとで blob の Worker が作れる = meta の worker-src blob: が効いている（効かなければ default-src に落ちて拒否される）。
  expect(result.out.blobWorker).toBe('allowed');
  // 同じオリジンのファイルの Worker は作れない（origin が不透明なので、CSP より先に SecurityError になる）。
  expect(result.out.fileWorker).not.toBe('allowed');
  expect(result.out.fetch).toMatch(/^blocked/);
  // inline の script は、要素は挿入できるが、中身は動かない（動けば attempt が例外にする）。違反の記録で、CSP が止めたことを確かめる。
  // （eval は、DevTools 経由の評価が CSP を免除されるので、ここでは試さない。Worker の中の eval は、e2e-reach の部品が確かめる。）
  expect(result.out.inlineScript).toBe('allowed');
  expect(result.violations).toEqual(expect.arrayContaining(['script-src-elem', 'connect-src']));
});
