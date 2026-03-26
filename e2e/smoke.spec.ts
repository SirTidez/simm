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
    await expect(page.getByRole('heading', { name: 'Download New Branch' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Import Existing Folder' })).toBeVisible();
    await expect(page.getByRole('heading', { name: /Steam install/i }).first()).toBeVisible();

    await page.getByRole('button', { name: /Browse Branches/i }).click();
    const enabledBranchCards = page.locator('.wizard-branch-card:not(.wizard-branch-card--disabled)');
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
    await expect(page.getByRole('button', { name: 'Launch' }).first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'Mods' }).first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'Config' }).first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'Logs' }).first()).toBeVisible();

    await page.getByRole('button', { name: 'Config' }).first().click();
    await expect(page.locator('.config-editor')).toBeVisible({ timeout: 30000 });
    await expect(page.locator('.config-explorer')).toBeVisible();
    await expect(page.getByPlaceholder('Search config files')).toBeVisible();
    await page.locator('.config-editor .modal-header .btn', { hasText: 'Back' }).first().click();

    await page.getByRole('button', { name: 'Logs' }).first().click();
    await expect(page.locator('.logs-panel')).toBeVisible({ timeout: 30000 });
    await expect(page.locator('.logs-panel__rail')).toBeVisible();
    await expect(page.locator('.logs-panel__viewer')).toBeVisible();
    await expect(page.locator('.logs-panel__inspector')).toBeVisible();

    const logSourceButtons = page.locator('.logs-panel__source-button');
    if ((await logSourceButtons.count()) > 0) {
      await logSourceButtons.first().click();
    }

    const logRows = page.locator('.logs-panel__line');
    if ((await logRows.count()) > 0) {
      await logRows.first().click();
      await expect(page.locator('.logs-panel__inspector .logs-panel__inspector-card').first()).toContainText('Line');
    }

    await page.locator('.logs-panel .modal-header .btn', { hasText: 'Back' }).first().click();

    await page.getByRole('button', { name: 'Mods' }).first().click();
    await expect(page.locator('.mods-overlay--environment')).toBeVisible({ timeout: 30000 });
    await expect(page.locator('.mods-overlay--environment .workspace-collection__rail-button', { hasText: 'Installed' }).first()).toBeVisible();
    await expect(page.locator('.mods-overlay--environment .workspace-collection__rail-button', { hasText: 'Updates' }).first()).toBeVisible();
  } finally {
    await browser.close();
  }
});
