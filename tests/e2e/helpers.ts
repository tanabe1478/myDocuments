import { expect, test as base, type Page } from '@playwright/test';
import type { E2ESeed } from '../../src/platform/memory/memoryBridge';

export type Platform = 'mac' | 'windows' | 'linux';

const PLATFORMS: Record<Platform, { platform: string; uaPlatform: string; ua: string }> = {
  mac: {
    platform: 'MacIntel',
    uaPlatform: 'macOS',
    ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  },
  windows: {
    platform: 'Win32',
    uaPlatform: 'Windows',
    ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  },
  linux: {
    platform: 'Linux x86_64',
    uaPlatform: 'Linux',
    ua: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  },
};

function hostPlatform(): Platform {
  return process.platform === 'darwin' ? 'mac' : process.platform === 'win32' ? 'windows' : 'linux';
}

/**
 * このテストが動く（偽装を含む）OS。project の metadata.platform が無ければホスト OS。
 */
export const test = base.extend<{ platform: Platform }>({
  platform: async ({}, use, testInfo) => {
    await use((testInfo.project.metadata.platform as Platform | undefined) ?? hostPlatform());
  },
  // project が OS を偽装するときは、アプリ（と CodeMirror）が読み込まれる前に navigator を上書きする。
  // 併せて keyboard.press の 'ControlOrMeta' を、ホストではなくこの OS の修飾キーに読み替える。
  page: async ({ page, platform }, use, testInfo) => {
    if (testInfo.project.metadata.platform) {
      const spoof = PLATFORMS[platform];
      await page.addInitScript((s) => {
        const define = (target: object, key: string, value: unknown) =>
          Object.defineProperty(target, key, { get: () => value, configurable: true });
        define(Navigator.prototype, 'platform', s.platform);
        define(Navigator.prototype, 'userAgent', s.ua);
        define(Navigator.prototype, 'userAgentData', { platform: s.uaPlatform, mobile: false, brands: [] });
      }, spoof);
    }
    const press = page.keyboard.press.bind(page.keyboard);
    const primary = platform === 'mac' ? 'Meta' : 'Control';
    page.keyboard.press = (key, options) => press(key.replace('ControlOrMeta', primary), options);
    await use(page);
  },
});

/**
 * その OS の標準の Redo キー。mac は Cmd+Shift+Z、Windows / Linux は Ctrl+Y と Ctrl+Shift+Z の両方。
 * Shift を押すときは大文字の 'Z' を指定する。小文字 'z' だと key が 'z' のイベントになり、
 * 実ブラウザの Ctrl+Shift+Z（key は 'Z'）と違って、CodeMirror が先に Ctrl+Z（Undo）に一致させてしまう。
 */
export function redoKeys(platform: Platform): string[] {
  return platform === 'mac' ? ['ControlOrMeta+Shift+Z'] : ['ControlOrMeta+y', 'ControlOrMeta+Shift+Z'];
}

export const BOM = [0xef, 0xbb, 0xbf];

export function utf8(text: string, options: { bom?: boolean; crlf?: boolean } = {}): number[] {
  const body = Array.from(new TextEncoder().encode(options.crlf ? text.replace(/\n/g, '\r\n') : text));
  return options.bom ? [...BOM, ...body] : body;
}

/** メモリ bridge に初期状態を渡して、アプリを開く。 */
export async function launch(page: Page, seed: E2ESeed = {}): Promise<void> {
  await page.addInitScript((s) => {
    window.__E2E_SEED__ = s;
  }, seed);
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('data-ready', 'true');
  await expect(page.locator('.cm-content')).toBeVisible();
}

/** 画面（DOM）に表示されている本文。 */
export async function editorText(page: Page): Promise<string> {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('.cm-line'))
      .map((l) => l.textContent ?? '')
      .join('\n'),
  );
}

export async function fileBytes(page: Page, path: string): Promise<number[] | null> {
  return page.evaluate((p) => window.__mdeE2E!.readFile(p), path);
}

export async function bridgeCounters(page: Page) {
  return page.evaluate(() => {
    const s = window.__mdeE2E!;
    return { calls: { ...s.calls }, physicalWrites: s.physicalWrites, log: [...s.log] };
  });
}

/** 先頭にフォーカスを置いてから、末尾へ移動する。 */
export async function focusEditorEnd(page: Page): Promise<void> {
  await page.locator('.cm-content').click();
  await page.keyboard.press('ControlOrMeta+End');
}

/** メモリ bridge の次のダイアログの戻り値を設定する。 */
export async function setDialogPaths(page: Page, paths: { open?: string | null; save?: string | null }): Promise<void> {
  await page.evaluate((p) => {
    if (p.open !== undefined) window.__mdeE2E!.openPath = p.open;
    if (p.save !== undefined) window.__mdeE2E!.savePath = p.save;
  }, paths);
}

export const unsavedMark = (page: Page) => page.getByTestId('unsaved-mark');
export const docTitle = (page: Page) => page.getByTestId('doc-title');
export const toast = (page: Page) => page.getByTestId('toast');
