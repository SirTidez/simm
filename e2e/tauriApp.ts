import { expect, type Browser, type Page, chromium } from '@playwright/test';

const appUrls = ['http://localhost:1420', 'http://127.0.0.1:1420'];

function findAppPage(browser: Browser): Page | undefined {
  return browser
    .contexts()
    .flatMap((context) => context.pages())
    .find((page) => appUrls.some((url) => page.url().startsWith(url)));
}

export async function connectToTauriApp(): Promise<{ browser: Browser; page: Page }> {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');

  try {
    await expect
      .poll(
        async () => {
          const page = findAppPage(browser);
          return page?.url() ?? null;
        },
        {
          message: 'Waiting for the Tauri app page to be available over CDP',
          timeout: 60000,
        },
      )
      .not.toBeNull();

    const page = findAppPage(browser);
    if (!page) {
      throw new Error('Tauri app page was not found after the CDP connection succeeded.');
    }

    await page.bringToFront();
    await expect(page.getByRole('button', { name: 'New Game' })).toBeVisible({ timeout: 30000 });

    return { browser, page };
  } catch (error) {
    await browser.close();
    throw error;
  }
}
