import { expect, test } from '@playwright/test';

test('renders app shell and opens environment wizard', async ({ page }) => {
  await page.addInitScript(() => {
    const callbacks = new Map<number, (payload: unknown) => void>();
    const eventListeners = new Map<string, number[]>();
    let nextCallbackId = 1;
    let nextEventId = 1;

    const defaultSettings = {
      defaultDownloadDir: 'C:/SIMM',
      maxConcurrentDownloads: 2,
      platform: 'windows',
      language: 'english',
      theme: 'modern-blue',
      autoCheckUpdates: false,
      updateCheckInterval: 60,
      autoInstallMelonLoader: false,
      logLevel: 'info',
    };

    const commandMap: Record<string, (args?: Record<string, unknown>) => unknown> = {
      was_simm_directory_just_created: () => false,
      get_settings: () => defaultSettings,
      detect_depot_downloader: () => ({ installed: true, path: 'C:/Tools/DepotDownloader' }),
      get_environments: () => [],
      get_schedule1_config: () => ({
        appId: '3164500',
        name: 'Schedule I',
        branches: [
          {
            name: 'public',
            displayName: 'Public (IL2CPP)',
            runtime: 'IL2CPP',
            requiresAuth: false,
          },
        ],
      }),
      'plugin:event|listen': (args = {}) => {
        const event = String(args.event ?? '');
        const handler = Number(args.handler);
        const listenerIds = eventListeners.get(event) ?? [];
        listenerIds.push(handler);
        eventListeners.set(event, listenerIds);
        return nextEventId++;
      },
      'plugin:event|unlisten': () => null,
    };

    (window as unknown as { isTauri: boolean }).isTauri = true;
    (window as unknown as { __TAURI_INTERNALS__: Record<string, unknown> }).__TAURI_INTERNALS__ = {
      invoke: async (cmd: string, args: Record<string, unknown> = {}) => {
        const handler = commandMap[cmd];
        if (handler) {
          return handler(args);
        }
        return null;
      },
      transformCallback: (cb: (payload: unknown) => void) => {
        const id = nextCallbackId++;
        callbacks.set(id, cb);
        return id;
      },
      unregisterCallback: (id: number) => {
        callbacks.delete(id);
      },
      runCallback: (id: number, payload: unknown) => {
        callbacks.get(id)?.(payload);
      },
      callbacks,
      metadata: {
        currentWindow: { label: 'main' },
        currentWebview: { windowLabel: 'main', label: 'main' },
      },
    };
    (window as unknown as { __TAURI_EVENT_PLUGIN_INTERNALS__: Record<string, unknown> }).__TAURI_EVENT_PLUGIN_INTERNALS__ = {
      unregisterListener: () => {},
    };
  });

  await page.goto('/');

  await expect(page.getByRole('heading', { name: 'Schedule I Mod Manager' })).toBeVisible();
  await expect(page.getByText('No game installs yet. Create one to get started!')).toBeVisible();

  await page.getByRole('button', { name: 'Add New Environment' }).click();
  await expect(page.getByRole('heading', { name: 'Create New Game Install' })).toBeVisible();

  await page.locator('.branch-card').first().click();
  await expect(page.getByRole('heading', { name: 'Configure Environment' })).toBeVisible();

  await page.locator('.modal-header .modal-close').click();
  await expect(page.getByRole('heading', { name: 'Configure Environment' })).toBeHidden();
});
