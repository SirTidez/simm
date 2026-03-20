import { expect, test } from '@playwright/test';

import { connectToTauriApp } from './tauriApp';

test('opens the real Tauri app shell and reaches environment configuration', async () => {
  const { browser, page } = await connectToTauriApp();

  try {
    const shellModLibraryButton = page.getByTitle('Open Mod Library').first();
    await expect(shellModLibraryButton).toBeVisible();
    await expect(page.getByRole('button', { name: 'New Game' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Accounts' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Help' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Settings' })).toBeVisible();

    const createEnvironmentHeading = page.getByRole('heading', { name: 'Create Environment' });
    if (!(await createEnvironmentHeading.isVisible().catch(() => false))) {
      await page.getByRole('button', { name: 'New Game' }).click();
    }

    await expect(createEnvironmentHeading).toBeVisible();
    await expect(page.getByRole('button', { name: 'Close create environment panel' })).toBeVisible();

    const enabledBranchCards = page.locator('.branch-card:not(.branch-card--disabled)');
    await expect(enabledBranchCards.first()).toBeVisible();
    await enabledBranchCards.first().click();

    await expect(page.getByRole('heading', { name: 'Configure Environment' })).toBeVisible();

    await page.getByRole('button', { name: 'Close create environment panel' }).click();
    await expect(createEnvironmentHeading).toBeHidden();

    await shellModLibraryButton.click();
    await expect(page.locator('.mods-overlay--library')).toBeVisible({ timeout: 30000 });
    await expect(page.locator('.mods-overlay--library .workspace-collection__rail-button', { hasText: 'Discover' }).first()).toBeVisible();
    await expect(page.locator('.mods-overlay--library .workspace-collection__rail-button', { hasText: 'Library' }).first()).toBeVisible();
    await expect(page.locator('.mods-overlay--library .workspace-collection__rail-button', { hasText: 'Updates' }).first()).toBeVisible();

    await page.locator('.mods-overlay--library .modal-header .btn', { hasText: 'Back' }).first().click();

    const openedMods = await page.evaluate(() => {
      const buttons = [...document.querySelectorAll('button,[role=button]')];
      const target = buttons.find((node) => node.getAttribute('title') === 'View installed mods') as HTMLButtonElement | undefined;
      if (!target) {
        return false;
      }
      target.click();
      return true;
    });

    expect(openedMods).toBeTruthy();
    await expect(page.locator('.mods-overlay--environment')).toBeVisible({ timeout: 30000 });
    await expect(page.locator('.mods-overlay--environment .workspace-collection__rail-button', { hasText: 'Installed' }).first()).toBeVisible();
    await expect(page.locator('.mods-overlay--environment .workspace-collection__rail-button', { hasText: 'Updates' }).first()).toBeVisible();
  } finally {
    await browser.close();
  }
});
