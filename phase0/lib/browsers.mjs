import { chromium, webkit } from 'playwright-core';
export const engines = { chromium, webkit };
export async function launch(name) {
  const browser = await engines[name].launch({ headless: true });
  return browser;
}
