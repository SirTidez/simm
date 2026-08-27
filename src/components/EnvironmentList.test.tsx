import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { StrictMode } from 'react';
import { EnvironmentList } from './EnvironmentList';
import type { Environment, ModLibraryResult } from '../types';
import { normalizeLibraryFeaturedDownloads } from '../services/featuredDownloads';

const storeMocks = vi.hoisted(() => ({
  useEnvironmentStore: vi.fn(),
  useSettingsStore: vi.fn(),
  useModLibraryStore: vi.fn(),
}));

const apiMocks = vi.hoisted(() => ({
  startDownload: vi.fn(),
  getMelonLoaderStatus: vi.fn(),
  getEnvironments: vi.fn(),
  getModLibrary: vi.fn(),
  searchThunderstore: vi.fn(),
  searchThunderstoreByRuntime: vi.fn(),
  getMods: vi.fn(),
  getModsCount: vi.fn(),
  getModUpdatesSummary: vi.fn(),
  getPluginsCount: vi.fn(),
  getUserLibsCount: vi.fn(),
  openFolder: vi.fn(),
  launchGame: vi.fn(),
  verifyMelonLoaderLaunch: vi.fn(),
  getMelonLoaderReleases: vi.fn(),
  installMelonLoader: vi.fn(),
  repairMelonLoaderLaunchOptions: vi.fn(),
  exportEnvironmentProfile: vi.fn(),
  saveModProfileFile: vi.fn(),
}));

const dialogMocks = vi.hoisted(() => ({
  save: vi.fn(),
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
  onModsSnapshotUpdated: vi.fn(),
  onModUpdatesChecked: vi.fn(),
  onPluginsChanged: vi.fn(),
  onUserLibsChanged: vi.fn(),
}));
const listenerScopeMocks = vi.hoisted(() => ({
  createAsyncListenerScope: vi.fn((onError?: (error: unknown) => void) => {
    let disposed = false;
    const unlisteners = new Set<() => void>();
    return {
      register: (subscribe: () => Promise<() => void>) => {
        void subscribe().then((unlisten) => {
          if (disposed) {
            unlisten();
            return;
          }
          unlisteners.add(unlisten);
        }).catch(onError);
      },
      dispose: () => {
        disposed = true;
        unlisteners.forEach((unlisten) => unlisten());
        unlisteners.clear();
      },
      isActive: () => !disposed,
    };
  }),
}));

vi.mock('../stores/environmentStore', () => ({
  useEnvironmentStore: storeMocks.useEnvironmentStore,
}));

vi.mock('../stores/settingsStore', () => ({
  useSettingsStore: storeMocks.useSettingsStore,
}));

vi.mock('../stores/modLibraryStore', () => ({
  useModLibraryStore: storeMocks.useModLibraryStore,
}));

vi.mock('../services/api', () => ({
  ApiService: apiMocks,
}));

vi.mock('@tauri-apps/plugin-dialog', () => dialogMocks);

vi.mock('../services/events', () => ({
  ...eventMocks,
  createAsyncListenerScope: listenerScopeMocks.createAsyncListenerScope,
}));

vi.mock('./AuthenticationModal', () => ({
  AuthenticationModal: ({ isOpen, onAuthenticated }: {
    isOpen: boolean;
    onAuthenticated: (credentials: { username: string; password: string; steamGuard: string; saveCredentials: boolean }) => void;
  }) => isOpen ? (
    <button
      type="button"
      onClick={() => onAuthenticated({
        username: 'steam-user',
        password: 'one-time-password',
        steamGuard: '12345',
        saveCredentials: false,
      })}
    >
      Complete one-time authentication
    </button>
  ) : null,
}));
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

const secondCompletedEnv: Environment = {
  ...completedEnv,
  id: 'env-2',
  name: 'Env Two',
  outputDir: 'C:/env-2',
};

function createLibraryEntry(
  storageId: string,
  displayName: string,
  environmentId: string = completedEnv.id,
): ModLibraryResult['downloaded'][number] {
  return {
    storageId,
    displayName,
    files: [],
    attachedUserLibs: [],
    source: 'thunderstore',
    sourceId: `author/${storageId}`,
    sourceVersion: '1.0.0',
    managed: false,
    installedIn: [environmentId],
    availableRuntimes: ['IL2CPP'],
    storageIdsByRuntime: { IL2CPP: storageId },
    installedInByRuntime: { IL2CPP: [environmentId] },
    filesByRuntime: { IL2CPP: [] },
  };
}

describe('EnvironmentList', () => {
  const unlistenFns: Array<ReturnType<typeof vi.fn>> = [];
  let completeHandler: ((data: { downloadId: string; manifestId?: string }) => Promise<void> | void) | null = null;

  beforeEach(() => {
    unlistenFns.length = 0;
    completeHandler = null;
    localStorage.clear();
    listenerScopeMocks.createAsyncListenerScope.mockClear();

    const mkUnlisten = () => {
      const fn = vi.fn();
      unlistenFns.push(fn);
      return Promise.resolve(fn);
    };

    for (const key of Object.keys(eventMocks) as Array<keyof typeof eventMocks>) {
      eventMocks[key].mockReset();
      eventMocks[key].mockImplementation(async (...args: any[]) => {
        if (key === 'onComplete') {
          completeHandler = args[0] as (data: { downloadId: string; manifestId?: string }) => Promise<void> | void;
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
    apiMocks.getModLibrary.mockResolvedValue({
      downloaded: [
        {
          storageId: 'mod-1',
          displayName: 'Example Mod',
          files: [],
          source: 'thunderstore',
          sourceId: 'author/examplemod',
          sourceVersion: '1.0.0',
          managed: false,
          installedIn: ['env-1'],
          availableRuntimes: ['IL2CPP'],
          storageIdsByRuntime: { IL2CPP: 'mod-1' },
          installedInByRuntime: { IL2CPP: ['env-1'] },
          filesByRuntime: { IL2CPP: [] },
          updateAvailable: true,
          remoteVersion: '1.1.0',
        },
      ],
    });
    apiMocks.searchThunderstore.mockResolvedValue({ packages: [] });
    apiMocks.searchThunderstoreByRuntime.mockResolvedValue({
      packagesByRuntime: { IL2CPP: [], Mono: [] },
    });
    apiMocks.getMods.mockResolvedValue({
      mods: [
        {
          name: 'Example Mod',
          fileName: 'Example Mod.dll',
          path: 'C:/env-1/Mods/Example Mod.dll',
          source: 'thunderstore',
          managed: true,
          modStorageId: 'mod-1',
        },
      ],
      modsDirectory: 'C:/env-1/Mods',
      count: 1,
    });
    apiMocks.getModsCount.mockResolvedValue({ count: 2 });
    apiMocks.getModUpdatesSummary.mockResolvedValue({ count: 1, updates: [] });
    apiMocks.getPluginsCount.mockResolvedValue({ count: 0 });
    apiMocks.getUserLibsCount.mockResolvedValue({ count: 0 });
    apiMocks.openFolder.mockResolvedValue({ success: true });
    apiMocks.launchGame.mockResolvedValue({ success: true });
    apiMocks.verifyMelonLoaderLaunch.mockResolvedValue({
      status: 'notInstalled',
      confirmed: false,
      logPath: 'C:/env-1/MelonLoader/Latest.log',
      message: 'MelonLoader is not installed for this environment.',
    });
    apiMocks.getMelonLoaderReleases.mockResolvedValue([]);
    apiMocks.installMelonLoader.mockResolvedValue({ success: true });
    apiMocks.repairMelonLoaderLaunchOptions.mockResolvedValue({ success: true });
    apiMocks.saveModProfileFile.mockResolvedValue(undefined);
    dialogMocks.save.mockResolvedValue('C:\\Profiles\\steam-installation.json');
    apiMocks.exportEnvironmentProfile.mockResolvedValue({
      schemaVersion: 1,
      kind: 'simm.profile',
      profile: {
        name: 'Env One',
        game: 'schedule-i',
        runtime: 'IL2CPP',
        branch: 'main',
        exportedAt: '2026-05-31T00:00:00Z',
      },
      items: [
        {
          itemType: 'mod',
          name: 'CustomTV',
          fileName: 'CustomTV.dll',
          required: true,
          source: 'thunderstore',
          sourceId: 'CustomTV/CustomTV',
          sourceVersion: '1.6.4',
          runtime: 'IL2CPP',
        },
      ],
    });

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
      ensureEnvironments: vi.fn().mockResolvedValue([completedEnv]),
    });

    storeMocks.useModLibraryStore.mockReturnValue({
      library: null,
      ensureLibrary: async () =>
        normalizeLibraryFeaturedDownloads(await apiMocks.getModLibrary()),
      refreshLibrary: async () =>
        normalizeLibraryFeaturedDownloads(await apiMocks.getModLibrary()),
    });

    storeMocks.useSettingsStore.mockReturnValue({
      settings: {
        autoCheckUpdates: false,
        updateCheckInterval: 60,
        steamUsername: 'tester',
        autoInstallMelonLoader: true,
        melonLoaderVersion: 'v1.0.0',
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

  it('only scrolls to a focused environment for a new focus request', async () => {
    const originalScrollIntoView = HTMLElement.prototype.scrollIntoView;
    const scrollIntoView = vi.fn();
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: scrollIntoView,
    });

    try {
      const { rerender } = render(
        <EnvironmentList focusedEnvironmentId="env-1" focusedEnvironmentRequestId={1} />,
      );

      await screen.findByText('Env One');
      expect(scrollIntoView).toHaveBeenCalledTimes(1);

      const currentStore = storeMocks.useEnvironmentStore.mock.results[
        storeMocks.useEnvironmentStore.mock.results.length - 1
      ]?.value;
      storeMocks.useEnvironmentStore.mockReturnValue({
        ...currentStore,
        environments: [{ ...completedEnv, lastUpdateCheck: '2026-08-01T00:00:00Z' }],
      });
      rerender(<EnvironmentList focusedEnvironmentId="env-1" focusedEnvironmentRequestId={1} />);

      expect(scrollIntoView).toHaveBeenCalledTimes(1);

      rerender(<EnvironmentList focusedEnvironmentId="env-1" focusedEnvironmentRequestId={2} />);

      await waitFor(() => {
        expect(scrollIntoView).toHaveBeenCalledTimes(2);
      });
    } finally {
      Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
        configurable: true,
        value: originalScrollIntoView,
      });
    }
  });

  it('does not register an independent mods_changed projection listener', async () => {
    render(<EnvironmentList />);

    await waitFor(() => {
      expect(screen.getByText('Env One')).toBeTruthy();
    });
    expect(eventMocks.onModsChanged).not.toHaveBeenCalled();
  });

  it('derives repeated library snapshot identities without repeating environment-local probes', async () => {
    let currentLibrary: ModLibraryResult = {
      downloaded: [createLibraryEntry('mod-1', 'Example Mod')],
    };
    const ensureLibrary = vi.fn(async () => currentLibrary);
    storeMocks.useModLibraryStore.mockImplementation(() => ({
      library: currentLibrary,
      ensureLibrary,
      refreshLibrary: vi.fn(async () => currentLibrary),
    }));

    const { rerender } = render(<EnvironmentList />);

    await waitFor(() => {
      expect(apiMocks.getMods).toHaveBeenCalledTimes(1);
      expect(apiMocks.getPluginsCount).toHaveBeenCalledTimes(1);
      expect(apiMocks.getUserLibsCount).toHaveBeenCalledTimes(1);
      expect(apiMocks.getMelonLoaderStatus).toHaveBeenCalledTimes(1);
    });

    currentLibrary = {
      downloaded: [
        createLibraryEntry('mod-1', 'Example Mod'),
        createLibraryEntry('mod-2', 'Second Mod'),
      ],
    };
    rerender(<EnvironmentList />);
    expect(await screen.findByTitle('2 total mods')).toBeInTheDocument();

    for (let snapshotIndex = 0; snapshotIndex < 3; snapshotIndex += 1) {
      currentLibrary = {
        downloaded: [...currentLibrary.downloaded],
      };
      rerender(<EnvironmentList />);
    }

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(apiMocks.getMods).toHaveBeenCalledTimes(1);
    expect(apiMocks.getPluginsCount).toHaveBeenCalledTimes(1);
    expect(apiMocks.getUserLibsCount).toHaveBeenCalledTimes(1);
    expect(apiMocks.getMelonLoaderStatus).toHaveBeenCalledTimes(1);
    expect(ensureLibrary).not.toHaveBeenCalled();
  });

  it('updates unmanaged counts from an external mod snapshot without issuing another probe pass', async () => {
    render(<EnvironmentList />);

    await waitFor(() => {
      expect(apiMocks.getMods).toHaveBeenCalledTimes(1);
      expect(apiMocks.getPluginsCount).toHaveBeenCalledTimes(1);
      expect(apiMocks.getUserLibsCount).toHaveBeenCalledTimes(1);
      expect(apiMocks.getMelonLoaderStatus).toHaveBeenCalledTimes(1);
      expect(eventMocks.onModsSnapshotUpdated).toHaveBeenCalledTimes(1);
    });
    expect(await screen.findByTitle('1 total mods')).toBeInTheDocument();

    const snapshotHandler = eventMocks.onModsSnapshotUpdated.mock.calls[0]?.[0] as (
      data: {
        environmentId: string;
        snapshot: {
          mods: Array<{
            name: string;
            fileName: string;
            path: string;
            source?: string;
            managed?: boolean;
          }>;
          modsDirectory: string;
          count: number;
        };
      },
    ) => void;
    act(() => {
      snapshotHandler({
        environmentId: completedEnv.id,
        snapshot: {
          mods: [
            {
              name: 'Local One',
              fileName: 'Local One.dll',
              path: 'C:/env-1/Mods/Local One.dll',
              source: 'local',
              managed: false,
            },
            {
              name: 'Local Two',
              fileName: 'Local Two.dll',
              path: 'C:/env-1/Mods/Local Two.dll',
              managed: false,
            },
          ],
          modsDirectory: 'C:/env-1/Mods',
          count: 2,
        },
      });
    });

    expect(await screen.findByTitle('3 total mods')).toBeInTheDocument();
    expect(apiMocks.getMods).toHaveBeenCalledTimes(1);
    expect(apiMocks.getPluginsCount).toHaveBeenCalledTimes(1);
    expect(apiMocks.getUserLibsCount).toHaveBeenCalledTimes(1);
    expect(apiMocks.getMelonLoaderStatus).toHaveBeenCalledTimes(1);
    expect(eventMocks.onModsSnapshotUpdated).toHaveBeenCalledTimes(1);
  });

  it('preserves a newer snapshot count when an older local probe completes later', async () => {
    let resolvePlugins: ((value: { count: number }) => void) | undefined;
    const onInitialDetectionComplete = vi.fn();
    apiMocks.getMods.mockResolvedValueOnce({
      mods: [],
      modsDirectory: 'C:/env-1/Mods',
      count: 0,
    });
    apiMocks.getPluginsCount.mockReturnValueOnce(new Promise((resolve) => {
      resolvePlugins = resolve;
    }));

    render(<EnvironmentList onInitialDetectionComplete={onInitialDetectionComplete} />);

    await waitFor(() => {
      expect(apiMocks.getMods).toHaveBeenCalledTimes(1);
      expect(apiMocks.getPluginsCount).toHaveBeenCalledTimes(1);
      expect(eventMocks.onModsSnapshotUpdated).toHaveBeenCalledTimes(1);
    });
    expect(apiMocks.getUserLibsCount).not.toHaveBeenCalled();
    expect(apiMocks.getMelonLoaderStatus).not.toHaveBeenCalled();

    const snapshotHandler = eventMocks.onModsSnapshotUpdated.mock.calls[0]?.[0] as (
      data: {
        environmentId: string;
        snapshot: {
          mods: Array<{
            name: string;
            fileName: string;
            path: string;
            source?: string;
            managed?: boolean;
          }>;
          modsDirectory: string;
          count: number;
        };
      },
    ) => void;
    act(() => {
      snapshotHandler({
        environmentId: completedEnv.id,
        snapshot: {
          mods: [
            {
              name: 'New Local One',
              fileName: 'New Local One.dll',
              path: 'C:/env-1/Mods/New Local One.dll',
              source: 'local',
              managed: false,
            },
            {
              name: 'New Local Two',
              fileName: 'New Local Two.dll',
              path: 'C:/env-1/Mods/New Local Two.dll',
              source: 'local',
              managed: false,
            },
          ],
          modsDirectory: 'C:/env-1/Mods',
          count: 2,
        },
      });
    });
    expect(await screen.findByTitle('3 total mods')).toBeInTheDocument();

    await act(async () => {
      resolvePlugins?.({ count: 0 });
    });
    await waitFor(() => {
      expect(apiMocks.getUserLibsCount).toHaveBeenCalledTimes(1);
      expect(apiMocks.getMelonLoaderStatus).toHaveBeenCalledTimes(1);
      expect(onInitialDetectionComplete).toHaveBeenCalledTimes(1);
    });

    expect(screen.getByTitle('3 total mods')).toBeInTheDocument();
    expect(apiMocks.getMods).toHaveBeenCalledTimes(1);
    expect(apiMocks.getPluginsCount).toHaveBeenCalledTimes(1);
    expect(apiMocks.getUserLibsCount).toHaveBeenCalledTimes(1);
    expect(apiMocks.getMelonLoaderStatus).toHaveBeenCalledTimes(1);
    expect(eventMocks.onModsSnapshotUpdated).toHaveBeenCalledTimes(1);
  });

  it('coalesces the environment-local probe pass across StrictMode effect replay', async () => {
    const currentStore = storeMocks.useEnvironmentStore();
    storeMocks.useEnvironmentStore.mockReturnValue({
      ...currentStore,
      environments: [completedEnv, secondCompletedEnv],
      ensureEnvironments: vi.fn().mockResolvedValue([completedEnv, secondCompletedEnv]),
    });

    render(
      <StrictMode>
        <EnvironmentList />
      </StrictMode>,
    );

    await waitFor(() => {
      expect(apiMocks.getMods).toHaveBeenCalledTimes(2);
      expect(apiMocks.getPluginsCount).toHaveBeenCalledTimes(2);
      expect(apiMocks.getUserLibsCount).toHaveBeenCalledTimes(2);
      expect(apiMocks.getMelonLoaderStatus).toHaveBeenCalledTimes(2);
    });

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(apiMocks.getMods).toHaveBeenCalledTimes(2);
    expect(apiMocks.getPluginsCount).toHaveBeenCalledTimes(2);
    expect(apiMocks.getUserLibsCount).toHaveBeenCalledTimes(2);
    expect(apiMocks.getMelonLoaderStatus).toHaveBeenCalledTimes(2);
  });

  it('counts S1API alongside other mods on the home card instead of as a separate tool', async () => {
    apiMocks.getModLibrary.mockResolvedValue({
      downloaded: [
        {
          storageId: 'tool-1',
          displayName: 'S1API',
          files: [],
          source: 'github',
          sourceId: 'ifbars/s1api',
          sourceVersion: '1.0.0',
          managed: true,
          installedIn: ['env-1'],
          availableRuntimes: ['IL2CPP'],
          storageIdsByRuntime: { IL2CPP: 'tool-1' },
          installedInByRuntime: { IL2CPP: ['env-1'] },
          filesByRuntime: { IL2CPP: [] },
          updateAvailable: false,
        },
      ],
    });
    apiMocks.getMods.mockResolvedValue({
      mods: [
        {
          name: 'S1API',
          fileName: 'S1API.dll',
          path: 'C:/env-1/Mods/S1API.dll',
          source: 'github',
          managed: true,
          modStorageId: 'tool-1',
        },
        {
          name: 'Local Steam Mod',
          fileName: 'Local Steam Mod.dll',
          path: 'C:/env-1/Mods/Local Steam Mod.dll',
          source: 'local',
          managed: false,
        },
      ],
      modsDirectory: 'C:/env-1/Mods',
      count: 2,
    });

    render(<EnvironmentList />);

    expect(await screen.findByText('2')).toBeTruthy();
    expect(
      await screen.findByTitle('2 total mods'),
    ).toBeTruthy();
    await waitFor(() => {
      expect(screen.queryByText('2 (+1 Tool)')).toBeNull();
      expect(screen.queryByTitle('1 SIMM-managed mod, 1 user mod')).toBeNull();
      expect(screen.queryByTitle('1 user mods, 1 SIMM-managed core tool')).toBeNull();
      expect(screen.queryByText('1 (+1 Featured)')).toBeNull();
    });
  });

  it('exports a share profile from an environment card', async () => {
    render(<EnvironmentList />);

    const shareButton = await screen.findByRole('button', { name: /share/i });
    fireEvent.click(shareButton);

    await waitFor(() => {
      expect(apiMocks.exportEnvironmentProfile).toHaveBeenCalledWith('env-1');
    });
    expect(await screen.findByText('Export Profile')).toBeInTheDocument();
    expect(screen.getByDisplayValue('Env One')).toBeInTheDocument();
    expect(screen.getByText('CustomTV')).toBeInTheDocument();
  });

  it('keeps a dismissed profile export closed when a delayed export resolves', async () => {
    let resolveExport: ((value: Awaited<ReturnType<typeof apiMocks.exportEnvironmentProfile>>) => void) | undefined;
    apiMocks.exportEnvironmentProfile.mockReturnValueOnce(new Promise((resolve) => {
      resolveExport = resolve;
    }));

    render(<EnvironmentList />);
    fireEvent.click(await screen.findByRole('button', { name: /share/i }));
    expect(await screen.findByText(/preparing profile/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /close profile export/i }));

    await act(async () => {
      resolveExport?.({
        schemaVersion: 1,
        kind: 'simm.profile',
        profile: { name: 'Late profile', game: 'schedule-i', runtime: 'IL2CPP', branch: 'main', exportedAt: '2026-05-31T00:00:00Z' },
        items: [],
      });
    });

    expect(screen.queryByText('Export Profile')).toBeNull();
  });

  it('saves an adjusted share profile to a json file', async () => {
    render(<EnvironmentList />);

    fireEvent.click(await screen.findByRole('button', { name: /share/i }));
    await screen.findByText('Export Profile');
    fireEvent.change(screen.getByLabelText(/profile name/i), {
      target: { value: 'Friday Co-op' },
    });
    fireEvent.click(screen.getByRole('button', { name: /export json/i }));

    await waitFor(() => {
      expect(dialogMocks.save).toHaveBeenCalledWith({
        defaultPath: 'friday-co-op.json',
        filters: [{ name: 'SIMM Profile', extensions: ['json'] }],
      });
      expect(apiMocks.saveModProfileFile).toHaveBeenCalledWith(
        expect.objectContaining({
          profile: expect.objectContaining({ name: 'Friday Co-op' }),
        }),
        'C:\\Profiles\\steam-installation.json',
      );
    });
  });

  it('does not render a duplicate profiles action above the environments', async () => {
    render(<EnvironmentList onOpenWorkspace={vi.fn()} />);

    await screen.findByText('Env One');
    expect(screen.queryByRole('button', { name: /profiles/i })).toBeNull();
  });

  it('launches non-Steam environments through Steam by default', async () => {
    render(<EnvironmentList />);

    expect(await screen.findByText('Steam launch')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Launch' }));

    await waitFor(() => {
      expect(apiMocks.launchGame).toHaveBeenCalledWith('env-1', 'steam');
    });
  });

  it('coalesces rapid repeated launches for the same environment card', async () => {
    let resolveLaunch: ((value: { success: boolean }) => void) | undefined;
    apiMocks.launchGame.mockReturnValueOnce(new Promise((resolve) => {
      resolveLaunch = resolve;
    }));

    render(<EnvironmentList />);
    const launchButton = await screen.findByRole('button', { name: 'Launch' });
    fireEvent.click(launchButton);
    fireEvent.click(launchButton);

    expect(apiMocks.launchGame).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: /launching/i })).toBeDisabled();

    await act(async () => {
      resolveLaunch?.({ success: true });
    });

    expect(await screen.findByRole('button', { name: 'Launch' })).toBeEnabled();
  });

  it('verifies MelonLoader startup after a card launch returns a start timestamp', async () => {
    apiMocks.launchGame.mockResolvedValueOnce({
      success: true,
      launchStartedAt: 12345,
    });
    apiMocks.verifyMelonLoaderLaunch.mockResolvedValueOnce({
      status: 'confirmed',
      confirmed: true,
      logPath: 'C:/env-1/MelonLoader/Latest.log',
      message: 'MelonLoader wrote a fresh launch log.',
    });

    render(<EnvironmentList />);

    fireEvent.click(await screen.findByRole('button', { name: 'Launch' }));

    await waitFor(() => {
      expect(apiMocks.verifyMelonLoaderLaunch).toHaveBeenCalledWith('env-1', 12345, 20000);
    });
  });

  it('warns when card launch verification does not confirm a fresh MelonLoader log', async () => {
    apiMocks.launchGame.mockResolvedValueOnce({
      success: true,
      launchStartedAt: 12345,
    });
    apiMocks.verifyMelonLoaderLaunch.mockResolvedValueOnce({
      status: 'staleLog',
      confirmed: false,
      logPath: 'C:/env-1/MelonLoader/Latest.log',
      message: 'MelonLoader log exists, but it has not been refreshed since this launch request.',
    });

    render(<EnvironmentList />);

    fireEvent.click(await screen.findByRole('button', { name: 'Launch' }));

    expect(await screen.findByTestId('message-overlay')).toHaveTextContent(
      'MelonLoader Launch Not Confirmed: Env One',
    );
    expect(screen.getByTestId('message-overlay')).toHaveTextContent(
      'MelonLoader log exists, but it has not been refreshed since this launch request.',
    );
    expect(screen.getByTestId('message-overlay')).toHaveTextContent(
      'C:/env-1/MelonLoader/Latest.log',
    );
  });

  it('installs missing Linux MelonLoader Proton setup from the environment chip', async () => {
    apiMocks.getMelonLoaderStatus.mockResolvedValueOnce({
      installed: true,
      version: 'v0.7.2',
      linuxRequirements: {
        appId: '3164500',
        protontricksInstalled: true,
        protontricksCommand: 'protontricks',
        canInstallPrerequisites: true,
        prerequisiteCommands: ['protontricks 3164500 dotnet6', 'protontricks 3164500 vcrun2015'],
        requiredPrerequisites: ['dotnet6', 'vcrun2015'],
        installedPrerequisites: ['dotnet6'],
        missingPrerequisites: ['vcrun2015'],
        prerequisitesInstalled: false,
        prerequisiteStatus: 'missing',
        launchOptions: 'WINEDLLOVERRIDES="version=n,b" %command%',
        steamLaunchOptionsConfigured: true,
        steamLaunchOptionsRepairable: true,
        needsSteamLaunchOptionsRepair: false,
        warnings: ['Schedule I Proton prefix is missing required MelonLoader prerequisites: vcrun2015.'],
      },
    });
    apiMocks.repairMelonLoaderLaunchOptions.mockResolvedValueOnce({
      success: true,
      linuxPrerequisiteMessage: 'Installed Linux prerequisites with protontricks for Steam app 3164500',
      linuxRequirements: {
        appId: '3164500',
        protontricksInstalled: true,
        protontricksCommand: 'protontricks',
        canInstallPrerequisites: true,
        prerequisiteCommands: ['protontricks 3164500 dotnet6', 'protontricks 3164500 vcrun2015'],
        missingPrerequisites: [],
        prerequisitesInstalled: true,
        launchOptions: 'WINEDLLOVERRIDES="version=n,b" %command%',
        warnings: [],
      },
    });
    apiMocks.getMelonLoaderStatus.mockResolvedValueOnce({
      installed: true,
      version: 'v0.7.2',
      linuxRequirements: {
        appId: '3164500',
        protontricksInstalled: true,
        protontricksCommand: 'protontricks',
        canInstallPrerequisites: true,
        prerequisiteCommands: ['protontricks 3164500 dotnet6', 'protontricks 3164500 vcrun2015'],
        missingPrerequisites: [],
        prerequisitesInstalled: true,
        launchOptions: 'WINEDLLOVERRIDES="version=n,b" %command%',
        warnings: [],
      },
    });

    render(<EnvironmentList />);

    const setupButton = await screen.findByRole('button', { name: /Install setup/i });
    fireEvent.click(setupButton);

    await waitFor(() => {
      expect(apiMocks.repairMelonLoaderLaunchOptions).toHaveBeenCalledWith('env-1');
    });
    expect(await screen.findByTestId('message-overlay')).toHaveTextContent(
      'Linux MelonLoader Setup Updated',
    );
    expect(screen.getByTestId('message-overlay')).toHaveTextContent(
      'Installed Linux prerequisites with protontricks for Steam app 3164500',
    );
  });

  it('launches Steam-managed environments through Steam by default', async () => {
    const steamEnv: Environment = {
      ...completedEnv,
      id: 'steam-env-1',
      environmentType: 'Steam',
    };
    storeMocks.useEnvironmentStore.mockReturnValue({
      environments: [steamEnv],
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

    render(<EnvironmentList />);

    expect(await screen.findByText('Public')).toBeTruthy();
    expect(await screen.findByText('Steam launch')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Launch' }));

    await waitFor(() => {
      expect(apiMocks.launchGame).toHaveBeenCalledWith('steam-env-1', 'steam');
    });
  });

  it('offers to restart Steam when a shortcut reload is required', async () => {
    apiMocks.launchGame
      .mockRejectedValueOnce("Steam needs to reload SIMM's shortcut for C:/Games/Schedule I Custom before it can launch through Steam.")
      .mockResolvedValueOnce({ success: true });

    render(<EnvironmentList />);

    fireEvent.click(await screen.findByRole('button', { name: 'Launch' }));

    expect(await screen.findByTestId('confirm-overlay')).toHaveTextContent('Restart Steam?');
    fireEvent.click(screen.getByRole('button', { name: 'Restart Steam' }));

    await waitFor(() => {
      expect(apiMocks.launchGame).toHaveBeenLastCalledWith('env-1', 'steam_restart');
    });
  });

  it('starts MelonLoader auto-install when a completed download finishes and auto-install is enabled', async () => {
    render(<EnvironmentList />);

    await waitFor(() => {
      expect(eventMocks.onComplete).toHaveBeenCalled();
      expect(completeHandler).not.toBeNull();
    });

    apiMocks.installMelonLoader.mockClear();
    apiMocks.getMelonLoaderStatus.mockClear();
    apiMocks.installMelonLoader.mockResolvedValueOnce({ success: true, version: 'v1.0.0' });
    apiMocks.getMelonLoaderStatus.mockResolvedValueOnce({ installed: true, version: 'v1.0.0' });

    await act(async () => {
      await completeHandler?.({ downloadId: 'env-1' });
    });

    await waitFor(() => {
      expect(apiMocks.installMelonLoader).toHaveBeenCalledWith('env-1', 'v1.0.0');
      expect(apiMocks.getMelonLoaderStatus).toHaveBeenCalledWith('env-1');
    });
  });

  it('reports Linux setup blockers without calling the install failed', async () => {
    render(<EnvironmentList />);

    await waitFor(() => {
      expect(eventMocks.onComplete).toHaveBeenCalled();
      expect(completeHandler).not.toBeNull();
    });

    apiMocks.installMelonLoader.mockClear();
    apiMocks.installMelonLoader.mockResolvedValueOnce({
      success: false,
      error: 'Steam must be fully restarted before SIMM can install Proton prerequisites with Protontricks.',
    });

    await act(async () => {
      await completeHandler?.({ downloadId: 'env-1' });
    });

    expect(await screen.findByTestId('message-overlay')).toHaveTextContent(
      'Linux MelonLoader Setup Failed',
    );
    expect(screen.getByTestId('message-overlay')).toHaveTextContent(
      'required Linux MelonLoader setup',
    );
    expect(screen.getByTestId('message-overlay')).not.toHaveTextContent(
      'MelonLoader Install Failed',
    );
  });

  it('uses the latest auto-install settings when a download completes', async () => {
    const { rerender } = render(<EnvironmentList />);

    await waitFor(() => {
      expect(eventMocks.onComplete).toHaveBeenCalled();
      expect(completeHandler).not.toBeNull();
    });

    storeMocks.useSettingsStore.mockReturnValue({
      settings: {
        autoCheckUpdates: false,
        updateCheckInterval: 60,
        steamUsername: 'tester',
        autoInstallMelonLoader: false,
        melonLoaderVersion: 'v9.9.9',
      },
    });

    rerender(<EnvironmentList />);
    apiMocks.installMelonLoader.mockClear();

    await act(async () => {
      await completeHandler?.({ downloadId: 'env-1' });
    });

    await waitFor(() => {
      expect(apiMocks.installMelonLoader).not.toHaveBeenCalled();
    });
  });

  it('cleans up all event listeners on unmount', async () => {
    const { unmount } = render(<EnvironmentList />);

    await waitFor(() => {
      expect(eventMocks.onUpdateAvailable).toHaveBeenCalled();
    });

    unmount();

    for (const fn of unlistenFns) {
      expect(fn).toHaveBeenCalled();
    }
  });

  it('disposes an EnvironmentList listener that resolves after unmount', async () => {
    let resolveAuthWaiting: ((unlisten: () => void) => void) | undefined;
    const lateUnlisten = vi.fn();
    eventMocks.onAuthWaiting.mockImplementationOnce(() => new Promise((resolve) => {
      resolveAuthWaiting = resolve;
    }));

    const { unmount } = render(<EnvironmentList />);
    await waitFor(() => expect(eventMocks.onAuthWaiting).toHaveBeenCalled());
    unmount();

    await act(async () => {
      resolveAuthWaiting?.(lateUnlisten);
    });
    expect(lateUnlisten).toHaveBeenCalledTimes(1);
  });

  it('does not rebuild event subscriptions for progress, environment identity, or authentication state changes', async () => {
    const listenerNames = [
      'onAuthWaiting',
      'onAuthSuccess',
      'onAuthError',
      'onProgress',
      'onMelonLoaderInstalling',
      'onMelonLoaderInstalled',
      'onMelonLoaderError',
      'onComplete',
      'onUpdateAvailable',
      'onUpdateCheckComplete',
      'onModsSnapshotUpdated',
      'onPluginsChanged',
      'onUserLibsChanged',
    ] as const;
    const initialStore = storeMocks.useEnvironmentStore();
    const { rerender } = render(<EnvironmentList />);

    await waitFor(() => {
      for (const listenerName of listenerNames) {
        expect(eventMocks[listenerName]).toHaveBeenCalledTimes(1);
      }
    });

    storeMocks.useEnvironmentStore.mockReturnValue({
      ...initialStore,
      environments: [{ ...completedEnv, description: 'New object identity' }],
      progress: new Map([[
        completedEnv.id,
        { downloadId: completedEnv.id, progress: 25, message: 'Downloading' },
      ]]),
    });
    rerender(<EnvironmentList />);

    const authErrorHandler = eventMocks.onAuthError.mock.calls[0]?.[0] as (
      data: { downloadId: string; error: string },
    ) => void;
    act(() => {
      authErrorHandler({ downloadId: completedEnv.id, error: 'Password required' });
    });
    expect(await screen.findByRole('button', { name: 'Complete one-time authentication' })).toBeInTheDocument();

    for (const listenerName of listenerNames) {
      expect(eventMocks[listenerName]).toHaveBeenCalledTimes(1);
    }
    expect(listenerScopeMocks.createAsyncListenerScope).toHaveBeenCalledTimes(1);
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

  it('passes the authentication callback credentials to the requested download without retaining them in component state', async () => {
    const queuedEnv: Environment = {
      ...completedEnv,
      id: 'env-auth-download',
      name: 'Authenticated Install',
      status: 'not_downloaded',
    };
    const startDownload = vi.fn().mockResolvedValue(undefined);
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
      ensureEnvironments: vi.fn().mockResolvedValue([queuedEnv]),
    });
    storeMocks.useSettingsStore.mockReturnValue({
      settings: {
        autoCheckUpdates: false,
        updateCheckInterval: 60,
        steamUsername: '',
      },
    });

    render(<EnvironmentList />);
    fireEvent.click(await screen.findByRole('button', { name: 'Download' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Complete one-time authentication' }));

    await waitFor(() => {
      expect(startDownload).toHaveBeenCalledWith('env-auth-download', {
        username: 'steam-user',
        password: 'one-time-password',
        steamGuard: '12345',
        saveCredentials: false,
      });
    });
  });

  it('renders compact workspace rows as an active tab stack and preserves environment selection behavior', async () => {
    const onSelectEnvironment = vi.fn();
    storeMocks.useEnvironmentStore.mockReturnValue({
      environments: [completedEnv, secondCompletedEnv],
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

    const { container } = render(
      <EnvironmentList
        compactMode={true}
        activeWorkspace={{ view: 'mods', environmentId: 'env-1' }}
        onSelectEnvironment={onSelectEnvironment}
      />,
    );

    const activeButton = screen.getByRole('button', { name: 'Env One' });
    const inactiveButton = screen.getByRole('button', { name: 'Env Two' });

    expect(activeButton.className).toContain('workspace-environment-sidebar__button--active');
    expect(inactiveButton.className).not.toContain('workspace-environment-sidebar__button--active');
    expect(activeButton.getAttribute('aria-current')).toBe('page');
    expect(container.querySelector('.workspace-environment-sidebar__item--active')).toBeNull();

    fireEvent.click(inactiveButton);

    expect(onSelectEnvironment).toHaveBeenCalledWith('env-2');
  });
});
