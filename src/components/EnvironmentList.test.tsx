import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { EnvironmentList } from './EnvironmentList';
import type { Environment } from '../types';

const storeMocks = vi.hoisted(() => ({
  useEnvironmentStore: vi.fn(),
  useSettingsStore: vi.fn(),
}));

const apiMocks = vi.hoisted(() => ({
  startDownload: vi.fn(),
  getMelonLoaderStatus: vi.fn(),
  getEnvironments: vi.fn(),
  getModsCount: vi.fn(),
  getModUpdatesSummary: vi.fn(),
  getPluginsCount: vi.fn(),
  getUserLibsCount: vi.fn(),
  openFolder: vi.fn(),
  launchGame: vi.fn(),
  getMelonLoaderReleases: vi.fn(),
  installMelonLoader: vi.fn(),
}));

const eventMocks = vi.hoisted(() => ({
  onAuthWaiting: vi.fn(),
  onAuthSuccess: vi.fn(),
  onAuthError: vi.fn(),
  onProgress: vi.fn(),
  onMelonLoaderInstalling: vi.fn(),
  onMelonLoaderInstalled: vi.fn(),
  onMelonLoaderError: vi.fn(),
  onComplete: vi.fn(),
  onUpdateAvailable: vi.fn(),
  onUpdateCheckComplete: vi.fn(),
  onModsChanged: vi.fn(),
  onModUpdatesChecked: vi.fn(),
  onPluginsChanged: vi.fn(),
  onUserLibsChanged: vi.fn(),
}));

vi.mock('../stores/environmentStore', () => ({
  useEnvironmentStore: storeMocks.useEnvironmentStore,
}));

vi.mock('../stores/settingsStore', () => ({
  useSettingsStore: storeMocks.useSettingsStore,
}));

vi.mock('../services/api', () => ({
  ApiService: apiMocks,
}));

vi.mock('../services/events', () => eventMocks);

vi.mock('./AuthenticationModal', () => ({ AuthenticationModal: () => null }));
vi.mock('./ModsOverlay', () => ({ ModsOverlay: () => null }));
vi.mock('./PluginsOverlay', () => ({ PluginsOverlay: () => null }));
vi.mock('./UserLibsOverlay', () => ({ UserLibsOverlay: () => null }));
vi.mock('./LogsOverlay', () => ({ LogsOverlay: () => null }));
vi.mock('./ConfigurationOverlay', () => ({ ConfigurationOverlay: () => null }));
vi.mock('./MessageOverlay', () => ({
  MessageOverlay: ({ isOpen, title, message }: any) =>
    isOpen ? (
      <div data-testid="message-overlay">
        <h2>{title}</h2>
        <p>{message}</p>
      </div>
    ) : null,
}));
vi.mock('./ConfirmOverlay', () => ({
  ConfirmOverlay: ({ isOpen, title, message, confirmText = 'Confirm', onConfirm, bodyContent }: any) =>
    isOpen ? (
      <div data-testid="confirm-overlay">
        <h2>{title}</h2>
        <p>{message}</p>
        {bodyContent}
        <button type="button" onClick={onConfirm}>
          {confirmText}
        </button>
      </div>
    ) : null,
}));

const completedEnv: Environment = {
  id: 'env-1',
  name: 'Env One',
  appId: '3164500',
  branch: 'main',
  outputDir: 'C:/env-1',
  runtime: 'IL2CPP',
  status: 'completed',
};

describe('EnvironmentList', () => {
  const unlistenFns: Array<ReturnType<typeof vi.fn>> = [];
  let modsChangedHandler: ((data: { environmentId: string }) => void) | null = null;

  beforeEach(() => {
    unlistenFns.length = 0;
    modsChangedHandler = null;

    const mkUnlisten = () => {
      const fn = vi.fn();
      unlistenFns.push(fn);
      return Promise.resolve(fn);
    };

    for (const key of Object.keys(eventMocks) as Array<keyof typeof eventMocks>) {
      eventMocks[key].mockReset();
      eventMocks[key].mockImplementation(async (...args: any[]) => {
        if (key === 'onModsChanged') {
          modsChangedHandler = args[0] as (data: { environmentId: string }) => void;
        }
        return mkUnlisten();
      });
    }

    for (const key of Object.keys(apiMocks) as Array<keyof typeof apiMocks>) {
      apiMocks[key].mockReset();
    }

    apiMocks.startDownload.mockResolvedValue({ success: true });
    apiMocks.getMelonLoaderStatus.mockResolvedValue({ installed: false });
    apiMocks.getEnvironments.mockResolvedValue([completedEnv]);
    apiMocks.getModsCount.mockResolvedValue({ count: 2 });
    apiMocks.getModUpdatesSummary.mockResolvedValue({ count: 1, updates: [] });
    apiMocks.getPluginsCount.mockResolvedValue({ count: 0 });
    apiMocks.getUserLibsCount.mockResolvedValue({ count: 0 });
    apiMocks.openFolder.mockResolvedValue({ success: true });
    apiMocks.launchGame.mockResolvedValue({ success: true });
    apiMocks.getMelonLoaderReleases.mockResolvedValue([]);
    apiMocks.installMelonLoader.mockResolvedValue({ success: true });

    storeMocks.useEnvironmentStore.mockReturnValue({
      environments: [completedEnv],
      loading: false,
      error: null,
      progress: new Map(),
      startDownload: vi.fn().mockResolvedValue(undefined),
      cancelDownload: vi.fn().mockResolvedValue(undefined),
      deleteEnvironment: vi.fn().mockResolvedValue(undefined),
      checkUpdate: vi.fn().mockResolvedValue(undefined),
      checkAllUpdates: vi.fn().mockResolvedValue(undefined),
      updateEnvironment: vi.fn().mockResolvedValue(undefined),
      refreshGameVersion: vi.fn().mockResolvedValue(undefined),
    });

    storeMocks.useSettingsStore.mockReturnValue({
      settings: {
        autoCheckUpdates: false,
        updateCheckInterval: 60,
        steamUsername: 'tester',
      },
    });
  });

  afterEach(() => {
    cleanup();
  });

  it('triggers manual update check from card action', async () => {
    const checkUpdate = vi.fn().mockResolvedValue(undefined);
    const baseStore = {
      environments: [completedEnv],
      loading: false,
      error: null,
      progress: new Map(),
      startDownload: vi.fn().mockResolvedValue(undefined),
      cancelDownload: vi.fn().mockResolvedValue(undefined),
      deleteEnvironment: vi.fn().mockResolvedValue(undefined),
      checkAllUpdates: vi.fn().mockResolvedValue(undefined),
      updateEnvironment: vi.fn().mockResolvedValue(undefined),
      refreshGameVersion: vi.fn().mockResolvedValue(undefined),
    };
    storeMocks.useEnvironmentStore.mockReturnValue({
      ...baseStore,
      checkUpdate,
    });

    render(<EnvironmentList />);

    fireEvent.click(await screen.findByRole('button', { name: 'Update' }));

    await waitFor(() => {
      expect(checkUpdate).toHaveBeenCalledWith('env-1', true);
    });
  });

  it('refreshes mod counts when mods_changed event fires for a completed environment', async () => {
    render(<EnvironmentList />);

    await waitFor(() => {
      expect(eventMocks.onModsChanged).toHaveBeenCalled();
      expect(modsChangedHandler).not.toBeNull();
    });

    const initialCalls = apiMocks.getModsCount.mock.calls.length;
    modsChangedHandler?.({ environmentId: 'env-1' });

    await waitFor(() => {
      expect(apiMocks.getModsCount.mock.calls.length).toBeGreaterThan(initialCalls);
      expect(apiMocks.getModUpdatesSummary.mock.calls.length).toBeGreaterThan(0);
    }, { timeout: 2000 });
  });

  it('cleans up all event listeners on unmount', async () => {
    const { unmount } = render(<EnvironmentList />);

    await waitFor(() => {
      expect(eventMocks.onModsChanged).toHaveBeenCalled();
      expect(eventMocks.onUpdateAvailable).toHaveBeenCalled();
    });

    unmount();

    for (const fn of unlistenFns) {
      expect(fn).toHaveBeenCalled();
    }
  });

  it('routes start download failures through the shared message dialog', async () => {
    const queuedEnv: Environment = {
      ...completedEnv,
      id: 'env-download',
      name: 'Queued Install',
      status: 'not_downloaded',
    };
    const startDownload = vi.fn().mockRejectedValue(new Error('Network unavailable'));
    storeMocks.useEnvironmentStore.mockReturnValue({
      environments: [queuedEnv],
      loading: false,
      error: null,
      progress: new Map(),
      startDownload,
      cancelDownload: vi.fn().mockResolvedValue(undefined),
      deleteEnvironment: vi.fn().mockResolvedValue(undefined),
      checkAllUpdates: vi.fn().mockResolvedValue(undefined),
      checkUpdate: vi.fn().mockResolvedValue(undefined),
      updateEnvironment: vi.fn().mockResolvedValue(undefined),
      refreshGameVersion: vi.fn().mockResolvedValue(undefined),
    });

    render(<EnvironmentList />);

    fireEvent.click(await screen.findByRole('button', { name: 'Download' }));

    await waitFor(() => {
      expect(screen.getByText('Download Failed')).toBeTruthy();
      expect(screen.getByText('Failed to start download: Network unavailable')).toBeTruthy();
    });
  });
});
