import { expect, type Page } from '@playwright/test';
import type { E2ESeed } from '../../src/platform/memory/memoryBridge';

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
