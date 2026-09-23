import { expect, test } from '@playwright/test';

import { connectToTauriApp } from './tauriApp';

test('uses the full Mod Library workspace for browsing and item details', async () => {
  const { browser, page } = await connectToTauriApp();

  try {
    await page.setViewportSize({ width: 1024, height: 600 });
    await page.getByRole('button', { name: 'Mod Library', exact: true }).first().click();

    const workspace = page.locator('.mods-overlay--library .workspace-collection');
    const browserPage = workspace.locator('.workspace-collection__main');
    await expect(browserPage).toBeVisible({ timeout: 30000 });
    await expect(workspace.locator('.workspace-collection__inspector')).toHaveCount(0);

    const browseGeometry = await workspace.evaluate((element) => {
      const workspaceBounds = element.getBoundingClientRect();
      const main = element.querySelector('.workspace-collection__main');
      const mainBounds = main?.getBoundingClientRect();
      return {
        workspaceWidth: workspaceBounds.width,
        mainWidth: mainBounds?.width ?? 0,
        mainRight: mainBounds?.right ?? 0,
        viewportWidth: window.innerWidth,
      };
    });
    expect(browseGeometry.mainWidth / browseGeometry.workspaceWidth).toBeGreaterThan(0.9);
    expect(browseGeometry.mainRight).toBeLessThanOrEqual(browseGeometry.viewportWidth + 0.5);

    const firstMod = page.locator('.workspace-collection__row--discover').first();
    const hasDiscoverResult = await firstMod
      .waitFor({ state: 'visible', timeout: 15000 })
      .then(() => true)
      .catch(() => false);

    if (hasDiscoverResult) {
      await firstMod.click();
      const detailPage = workspace.locator('.workspace-collection__detail-page');
      await expect(detailPage).toBeVisible();
      await expect(browserPage).toHaveCount(0);
      await expect(detailPage.getByRole('button', { name: 'Back to Discover' })).toBeVisible();

      const detailGeometry = await detailPage.evaluate((element) => {
        const bounds = element.getBoundingClientRect();
        return {
          left: bounds.left,
          right: bounds.right,
          bottom: bounds.bottom,
          viewportWidth: window.innerWidth,
          viewportHeight: window.innerHeight,
        };
      });
      expect(detailGeometry.left).toBeGreaterThanOrEqual(-0.5);
      expect(detailGeometry.right).toBeLessThanOrEqual(detailGeometry.viewportWidth + 0.5);
      expect(detailGeometry.bottom).toBeLessThanOrEqual(detailGeometry.viewportHeight + 0.5);

      await detailPage.getByRole('button', { name: 'Back to Discover' }).click();
      await expect(browserPage).toBeVisible();
    }
  } finally {
    await browser.close();
  }
});
