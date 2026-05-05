import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { App } from './App';
import type { ReactNode } from 'react';

const invokeMock = vi.hoisted(() => vi.fn());
const listenMock = vi.hoisted(() => vi.fn(async () => () => {}));
const deepLinkMocks = vi.hoisted(() => ({
  getCurrent: vi.fn(),
  onOpenUrl: vi.fn(),
}));
const environmentStoreMocks = vi.hoisted(() => ({
  useEnvironmentStore: vi.fn(),
}));
const settingsStoreMocks = vi.hoisted(() => ({
  useSettingsStore: vi.fn(),
}));
const modLibraryOverlayMocks = vi.hoisted(() => ({
  lastNavigationState: null as any,
  suspendOnRender: false,
  suspendPromise: null as Promise<void> | null,
  resolveSuspend: null as (() => void) | null,
  prepareSuspense() {
    this.suspendOnRender = true;
    this.suspendPromise = new Promise<void>((resolve) => {
      this.resolveSuspend = () => {
        this.suspendOnRender = false;
        this.resolveSuspend = null;
        this.suspendPromise = null;
        resolve();
      };
    });
  },
  releaseSuspense() {
    this.resolveSuspend?.();
  },
}));
const dialogMocks = vi.hoisted(() => ({
  confirm: vi.fn(),
  message: vi.fn(),
}));
const processMocks = vi.hoisted(() => ({
  relaunch: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock,
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: listenMock,
}));

vi.mock('@tauri-apps/plugin-deep-link', () => ({
  getCurrent: deepLinkMocks.getCurrent,
  onOpenUrl: deepLinkMocks.onOpenUrl,
}));

vi.mock('@tauri-apps/plugin-dialog', () => ({
  confirm: dialogMocks.confirm,
  message: dialogMocks.message,
}));

vi.mock('@tauri-apps/plugin-process', () => ({
  relaunch: processMocks.relaunch,
}));

const windowMocks = vi.hoisted(() => ({
  isMaximized: vi.fn(),
  onResized: vi.fn(),
  minimize: vi.fn(),
  toggleMaximize: vi.fn(),
  close: vi.fn(),
}));

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => windowMocks,
}));

vi.mock('../stores/environmentStore', () => ({
  EnvironmentStoreProvider: ({ children }: { children: ReactNode }) => children,
  useEnvironmentStore: environmentStoreMocks.useEnvironmentStore,
}));

vi.mock('../stores/downloadStatusStore', () => ({
  DownloadStatusStoreProvider: ({ children }: { children: ReactNode }) => children,
}));

vi.mock('../stores/settingsStore', () => ({
  SettingsStoreProvider: ({ children }: { children: ReactNode }) => children,
  useSettingsStore: settingsStoreMocks.useSettingsStore,
}));

vi.mock('../utils/logger', () => ({
  interceptConsole: vi.fn(),
}));

vi.mock('./ErrorBoundary', () => ({
  ErrorBoundary: ({ children }: { children: ReactNode }) => children,
}));

vi.mock('./EnvironmentList', () => ({
  EnvironmentList: ({
    onInitialDetectionComplete,
    onOpenWorkspace,
  }: {
    onInitialDetectionComplete?: () => void;
    onOpenWorkspace?: (workspace: { view: 'wizard' }) => void;
  }) => (
    <div>
      <button onClick={onInitialDetectionComplete}>Finish Detection</button>
      <button onClick={() => onOpenWorkspace?.({ view: 'wizard' })}>Add Environment</button>
    </div>
  ),
}));

vi.mock('./EnvironmentCreationWizard', () => ({
  EnvironmentCreationWizard: ({ onClose }: { onClose: () => void }) => (
    <div>
      <span>Wizard Overlay</span>
      <button onClick={onClose}>Close Wizard</button>
    </div>
  ),
}));

vi.mock('./ModLibraryOverlay', () => ({
  ModLibraryOverlay: ({
    isOpen,
    onClose,
    navigationState,
    onNavigationStateChange,
    onOpenSecurityReport,
  }: {
    isOpen: boolean;
    onClose: () => void;
    navigationState?: any;
    onNavigationStateChange?: (state: any) => void;
    onOpenSecurityReport?: (state: any) => void;
  }) =>
    isOpen ? (() => {
      if (modLibraryOverlayMocks.suspendOnRender && modLibraryOverlayMocks.suspendPromise) {
        throw modLibraryOverlayMocks.suspendPromise;
      }

      return (
        <div>
          <span>Mod Library Overlay</span>
          <span>Active Library Tab: {navigationState?.libraryTab ?? 'discover'}</span>
          <button onClick={() => onNavigationStateChange?.({ libraryTab: 'library', searchQuery: 'pack rat' })}>
            Save Library State
          </button>
          <button
            onClick={() =>
              onOpenSecurityReport?.({
                title: 'Security Findings - Pack Rat',
                report: {
                  summary: {
                    state: 'verified',
                    verified: true,
                    totalFindings: 0,
                    threatFamilyCount: 0,
                  },
                  policy: {
                    enabled: true,
                    requiresConfirmation: false,
                    blocked: false,
                    promptOnHighFindings: false,
                    blockCriticalFindings: false,
                  },
                  files: [],
                },
              })
            }
          >
            Open Security Report
          </button>
          <button onClick={onClose}>Close Mod Library</button>
        </div>
      );
    })() : null,
}));

vi.mock('./SecurityScanReportPage', () => ({
  SecurityScanReportPage: ({ title, onReturn }: { title: string; onReturn: () => void }) => (
    <div>
      <span>Security Report Page</span>
      <span>{title}</span>
      <button onClick={onReturn}>Return From Security Report</button>
    </div>
  ),
}));

vi.mock('./SteamAccountOverlay', () => ({
  SteamAccountOverlay: ({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) =>
    isOpen ? (
      <div>
        <span>Steam Overlay</span>
        <button onClick={onClose}>Close Steam</button>
      </div>
    ) : null,
}));

vi.mock('./HelpOverlay', () => ({
  HelpOverlay: ({
    isOpen,
    onClose,
    onOpenWizard,
    onOpenSettings,
    onOpenAccounts,
  }: {
    isOpen: boolean;
    onClose: () => void;
    onOpenWizard: () => void;
    onOpenSettings: () => void;
    onOpenAccounts: () => void;
  }) =>
    isOpen ? (
      <div>
        <span>Help Overlay</span>
        <button onClick={onClose}>Close Help</button>
        <button onClick={onOpenWizard}>Open Wizard From Help</button>
        <button onClick={onOpenSettings}>Open Settings From Help</button>
        <button onClick={onOpenAccounts}>Open Accounts From Help</button>
      </div>
    ) : null,
}));

vi.mock('./WelcomeOverlay', () => ({
  WelcomeOverlay: ({
    isOpen,
    onClose,
    onOpenWizard,
    onOpenSettings,
    onOpenAccounts,
    mode,
    onFinishSetup,
    onSkipSetup,
  }: {
    isOpen: boolean;
    onClose: () => void;
    onOpenWizard: () => void;
    onOpenSettings: () => void;
    onOpenAccounts?: () => void;
    mode?: string;
    onFinishSetup?: (mode: 'player' | 'powerUser') => void;
    onSkipSetup?: () => void;
  }) =>
    isOpen ? (
      <div>
        <span>Welcome Overlay</span>
        <span>Welcome Mode: {mode}</span>
        <button onClick={onClose}>Close Welcome</button>
        <button onClick={onOpenWizard}>Open Wizard From Welcome</button>
        <button onClick={onOpenSettings}>Open Settings From Welcome</button>
        <button onClick={onOpenAccounts}>Open Accounts From Welcome</button>
        <button onClick={() => onFinishSetup?.('player')}>Finish Player Setup</button>
        <button onClick={() => onSkipSetup?.()}>Skip Setup Guide</button>
      </div>
    ) : null,
}));

vi.mock('./Settings', () => ({
  Settings: ({ onRunSetupGuide }: { onRunSetupGuide?: () => void }) => (
    <div>
      <button>Settings</button>
      <button onClick={onRunSetupGuide}>Run setup guide again</button>
    </div>
  ),
}));

vi.mock('./Footer', () => ({
  Footer: ({
    onOpenModUpdates,
    onOpenAppUpdate,
    appUpdateAvailable,
  }: {
    onOpenModUpdates?: () => void;
    onOpenAppUpdate?: () => void;
    appUpdateAvailable?: boolean;
  }) => (
    <div>
      <button onClick={onOpenModUpdates}>Open Mod Updates</button>
      {appUpdateAvailable && (
        <button onClick={onOpenAppUpdate}>Install App Update</button>
      )}
    </div>
  ),
}));

vi.mock('./DownloadsPanel', () => ({
  DownloadsPanel: () => <div>Downloads Panel</div>,
}));

describe('App', () => {
  beforeEach(() => {
    modLibraryOverlayMocks.lastNavigationState = null;
    modLibraryOverlayMocks.suspendOnRender = false;
    modLibraryOverlayMocks.suspendPromise = null;
    modLibraryOverlayMocks.resolveSuspend = null;
    invokeMock.mockReset();
    invokeMock.mockResolvedValue(false);
    deepLinkMocks.getCurrent.mockReset();
    deepLinkMocks.onOpenUrl.mockReset();
    deepLinkMocks.getCurrent.mockResolvedValue(null);
    deepLinkMocks.onOpenUrl.mockResolvedValue(() => {});
    dialogMocks.confirm.mockReset();
    dialogMocks.message.mockReset();
    processMocks.relaunch.mockReset();
    dialogMocks.confirm.mockResolvedValue(true);
    dialogMocks.message.mockResolvedValue(undefined);
    processMocks.relaunch.mockResolvedValue(undefined);
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('/releases')) {
        return {
          ok: true,
          json: async () => [
            {
              tag_name: 'v0.8.4',
              name: 'SIMM 0.8.4',
              body: '- Refined the desktop workspace.',
              published_at: '2026-05-01T00:00:00Z',
              html_url: 'https://github.com/SirTidez/simm/releases/tag/v0.8.4',
              prerelease: false,
            },
          ],
        };
      }

      return {
        ok: true,
        text: async () => '## [0.8.4]\n\n- Refined Home and desktop UI polish.\n\n## [0.8.3]\n\n- Fixed update checks.\n',
      };
    }));

    windowMocks.isMaximized.mockReset();
    windowMocks.onResized.mockReset();
    windowMocks.minimize.mockReset();
    windowMocks.toggleMaximize.mockReset();
    windowMocks.close.mockReset();

    windowMocks.isMaximized.mockResolvedValue(false);
    windowMocks.onResized.mockResolvedValue(() => {});
    windowMocks.minimize.mockResolvedValue(undefined);
    windowMocks.toggleMaximize.mockResolvedValue(undefined);
    windowMocks.close.mockResolvedValue(undefined);

    environmentStoreMocks.useEnvironmentStore.mockReset();
    environmentStoreMocks.useEnvironmentStore.mockReturnValue({
      environments: [],
    });
    settingsStoreMocks.useSettingsStore.mockReset();
    settingsStoreMocks.useSettingsStore.mockReturnValue({
      settings: { appUpdate: { channel: 'beta' }, setupGuideCompleted: true },
      updateSettings: vi.fn().mockResolvedValue(undefined),
    });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('hides startup splash after startup detection resolves', async () => {
    render(<App />);

    await waitFor(() => {
      expect(screen.queryByText('Detecting game and MelonLoader versions')).toBeNull();
    });
    expect(screen.getByRole('heading', { name: 'Welcome back to SIMM' })).toBeTruthy();
  });

  it('shows a release and changelog feed on the Home dashboard', async () => {
    render(<App />);

    expect(await screen.findByRole('heading', { name: 'News & Changes' })).toBeTruthy();
    expect(await screen.findAllByText('SIMM 0.8.4')).toHaveLength(2);
    expect(await screen.findByText('Refined the desktop workspace.')).toBeTruthy();
    expect(screen.getAllByText('Changelog').length).toBeGreaterThan(0);
    expect(screen.queryByText('Recommended next step')).toBeNull();
    expect(screen.queryByText('App channel checked')).toBeNull();
  });

  it('opens Environments when the Home status environment is clicked', async () => {
    environmentStoreMocks.useEnvironmentStore.mockReturnValue({
      environments: [
        {
          id: 'env-update',
          name: 'Il2Cpp',
          appId: '3164500',
          branch: 'main',
          outputDir: 'C:/Games/Schedule I',
          runtime: 'IL2CPP',
          status: 'completed',
          currentGameVersion: '0.4.5f1',
          updateAvailable: true,
        },
      ],
    });

    render(<App />);

    const statusButton = await screen.findByRole('button', { name: 'Open Environments for Il2Cpp' });
    fireEvent.click(statusButton);

    await waitFor(() => {
      expect(screen.getByText('Finish Detection')).toBeTruthy();
    });
  });

  it('opens and closes overlays from sidebar/header controls', async () => {
    render(<App />);

    fireEvent.click(screen.getByRole('button', { name: 'Mod Library' }));
    expect(await screen.findByText('Mod Library Overlay')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Close Mod Library' }));
    await waitFor(() => expect(screen.queryByText('Mod Library Overlay')).toBeNull());

    fireEvent.click(screen.getAllByRole('button', { name: 'Add Environment' })[0]);
    expect(await screen.findByText('Wizard Overlay')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Close Wizard' }));
    await waitFor(() => expect(screen.queryByText('Wizard Overlay')).toBeNull());

    fireEvent.click(screen.getByRole('button', { name: 'Accounts' }));
    expect(await screen.findByText('Steam Overlay')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Close Steam' }));
    await waitFor(() => expect(screen.queryByText('Steam Overlay')).toBeNull());

    fireEvent.click(screen.getByRole('button', { name: 'Help' }));
    expect(await screen.findByText('Help Overlay')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Close Help' }));
    await waitFor(() => expect(screen.queryByText('Help Overlay')).toBeNull());
  });

  it('opens the setup guide on a fresh startup', async () => {
    invokeMock.mockImplementation((command: string) => {
      if (command === 'get_app_startup_state') {
        return Promise.resolve({ simmDirectoryCreated: true, databaseCreated: true });
      }
      return Promise.resolve(false);
    });
    settingsStoreMocks.useSettingsStore.mockReturnValue({
      settings: { appUpdate: { channel: 'beta' }, setupGuideCompleted: false },
      updateSettings: vi.fn().mockResolvedValue(undefined),
    });

    render(<App />);

    expect(await screen.findByText('Welcome Overlay')).toBeTruthy();
    expect(screen.getByText('Welcome Mode: setup')).toBeTruthy();
  });

  it('offers the setup guide once for upgraded settings and preserves power-user layout when skipped', async () => {
    const updateSettings = vi.fn().mockResolvedValue(undefined);
    settingsStoreMocks.useSettingsStore.mockReturnValue({
      settings: { appUpdate: { channel: 'beta' } },
      updateSettings,
    });

    render(<App />);

    expect(await screen.findByText('Welcome Overlay')).toBeTruthy();
    expect(screen.getByText('Welcome Mode: upgradePrompt')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Skip Setup Guide' }));

    await waitFor(() => {
      expect(updateSettings).toHaveBeenCalledWith({
        experienceMode: 'powerUser',
        showAdvancedGameTools: true,
        setupGuideCompleted: true,
      });
    });
  });

  it('keeps the workspace shell interactive while a workspace panel is loading', async () => {
    modLibraryOverlayMocks.prepareSuspense();
    render(<App />);

    fireEvent.click(screen.getByRole('button', { name: 'Mod Library' }));

    expect(await screen.findByText('Loading workspace panel...')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Downloads/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Home' })).toBeTruthy();

    modLibraryOverlayMocks.releaseSuspense();

    expect(await screen.findByText('Mod Library Overlay')).toBeTruthy();
  });

  it('reuses the last mod library navigation state when reopening from the toolbar', async () => {
    render(<App />);

    fireEvent.click(screen.getByRole('button', { name: 'Mod Library' }));
    expect(await screen.findByText('Active Library Tab: discover')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Save Library State' }));
    fireEvent.click(screen.getByRole('button', { name: 'Close Mod Library' }));

    await waitFor(() => expect(screen.queryByText('Mod Library Overlay')).toBeNull());

    fireEvent.click(screen.getByRole('button', { name: 'Mod Library' }));
    expect(await screen.findByText('Active Library Tab: library')).toBeTruthy();
  });

  it('retargets the current mod library workspace when a same-route navigation carries new state', async () => {
    render(<App />);

    fireEvent.click(screen.getByRole('button', { name: 'Mod Library' }));
    expect(await screen.findByText('Active Library Tab: discover')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Save Library State' }));
    expect(await screen.findByText('Active Library Tab: library')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Open Mod Updates' }));
    expect(await screen.findByText('Active Library Tab: updates')).toBeTruthy();
  });

  it('renders the security report workspace page when Mod Library opens a report', async () => {
    render(<App />);

    fireEvent.click(screen.getByRole('button', { name: 'Mod Library' }));
    expect(await screen.findByText('Mod Library Overlay')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Open Security Report' }));

    expect(await screen.findByText('Security Report Page')).toBeTruthy();
    expect(screen.getByText('Security Findings - Pack Rat')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Return From Security Report' }));

    await waitFor(() => {
      expect(screen.getByText('Mod Library Overlay')).toBeTruthy();
    });
  });

  it('marks top-level workspace buttons active when their panel is open', async () => {
    render(<App />);

    const libraryButton = screen.getByRole('button', { name: 'Mod Library' });
    const accountsButton = screen.getByRole('button', { name: 'Accounts' });
    const helpButton = screen.getByRole('button', { name: 'Help' });

    expect(libraryButton).not.toHaveAttribute('aria-current');
    expect(accountsButton).not.toHaveAttribute('aria-current');
    expect(helpButton).not.toHaveAttribute('aria-current');

    fireEvent.click(libraryButton);
    expect(await screen.findByText('Mod Library Overlay')).toBeTruthy();
    expect(libraryButton).toHaveAttribute('aria-current', 'page');
    expect(accountsButton).not.toHaveAttribute('aria-current');

    fireEvent.click(accountsButton);
    expect(await screen.findByText('Steam Overlay')).toBeTruthy();
    expect(accountsButton).toHaveAttribute('aria-current', 'page');
    expect(libraryButton).not.toHaveAttribute('aria-current');

    fireEvent.click(helpButton);
    expect(await screen.findByText('Help Overlay')).toBeTruthy();
    expect(helpButton).toHaveAttribute('aria-current', 'page');
    expect(accountsButton).not.toHaveAttribute('aria-current');
  });

  it('uses window close for the custom close button', async () => {
    render(<App />);

    fireEvent.click(screen.getByRole('button', { name: 'Close' }));

    await waitFor(() => {
      expect(windowMocks.close).toHaveBeenCalled();
    });
  });

  it('installs and relaunches an available app update from the footer action', async () => {
    invokeMock.mockImplementation((command: string) => {
      switch (command) {
        case 'was_simm_directory_just_created':
          return Promise.resolve(false);
        case 'check_app_update':
          return Promise.resolve({
            currentVersion: '0.8.0',
            version: '0.8.1',
            versionNormalized: '0.8.1',
            updateAvailable: true,
            notes: 'Update notes',
            pubDate: '2026-04-03T00:00:00Z',
            channel: 'beta',
            manifestUrl: 'https://raw.githubusercontent.com/SirTidez/simm/main/updater/beta/latest-beta.json',
            checkedAt: '2026-04-03T00:00:00Z',
          });
        case 'install_app_update':
          return Promise.resolve({
            installed: true,
            version: '0.8.1',
            channel: 'beta',
          });
        default:
          return Promise.resolve(false);
      }
    });

    render(<App />);

    const installButton = await screen.findByRole('button', { name: 'Install App Update' });
    fireEvent.click(installButton);

    await waitFor(() => {
      expect(dialogMocks.confirm).toHaveBeenCalled();
      expect(invokeMock).toHaveBeenCalledWith('install_app_update', { channel: 'beta' });
      expect(processMocks.relaunch).toHaveBeenCalled();
    });
  });

  it('does not immediately rerun app update checks when the settings updater identity changes', async () => {
    let updateSettingsVersion = 0;
    const firstUpdateSettings = vi.fn().mockImplementation(async () => {
      updateSettingsVersion = 1;
    });
    const secondUpdateSettings = vi.fn().mockResolvedValue(undefined);

    settingsStoreMocks.useSettingsStore.mockImplementation(() => ({
      settings: { appUpdate: { channel: 'beta' }, setupGuideCompleted: true },
      updateSettings: updateSettingsVersion === 0 ? firstUpdateSettings : secondUpdateSettings,
    }));

    invokeMock.mockImplementation((command: string) => {
      switch (command) {
        case 'was_simm_directory_just_created':
          return Promise.resolve(false);
        case 'check_app_update':
          return Promise.resolve({
            currentVersion: '0.8.0',
            version: '0.8.1',
            versionNormalized: '0.8.1',
            updateAvailable: true,
            notes: 'Update notes',
            pubDate: '2026-04-03T00:00:00Z',
            channel: 'beta',
            manifestUrl: 'https://raw.githubusercontent.com/SirTidez/simm/master/updater/beta/latest-beta.json',
            checkedAt: '2026-04-03T00:00:00Z',
          });
        default:
          return Promise.resolve(false);
      }
    });

    render(<App />);

    await screen.findByRole('button', { name: 'Install App Update' });

    await waitFor(() => {
      expect(firstUpdateSettings).toHaveBeenCalledTimes(1);
    });

    await new Promise((resolve) => window.setTimeout(resolve, 25));

    expect(
      invokeMock.mock.calls.filter(([command]) => command === 'check_app_update'),
    ).toHaveLength(1);
    expect(secondUpdateSettings).not.toHaveBeenCalled();
  });

  it('does not reopen runtime selection after a failed manual Nexus callback is handled', async () => {
    const nxmUrl = 'nxm://schedule1/mods/123/files/456?key=abc&expires=999&user_id=1';
    deepLinkMocks.getCurrent.mockResolvedValue([nxmUrl]);
    invokeMock.mockImplementation((command: string) => {
      if (command === 'complete_nexus_manual_download_session') {
        const completeCalls = invokeMock.mock.calls.filter(
          ([calledCommand]) => calledCommand === command,
        );
        const runtimeOverride =
          completeCalls[completeCalls.length - 1]?.[1]?.runtimeOverride;

        if (!runtimeOverride) {
          return Promise.resolve({
            success: false,
            runtimeSelectionRequired: true,
            kind: 'library',
            modId: 123,
            fileId: 456,
            modName: 'Encoded FOMOD',
            fileName: 'Encoded-FOMOD.zip',
            version: '1.0.0',
          });
        }

        return Promise.resolve({
          success: false,
          requestedKind: 'library',
          error:
            'Failed to store manually downloaded Nexus archive: Failed to read ModuleConfig.xml content',
        });
      }

      return Promise.resolve(false);
    });

    render(<App />);

    expect(await screen.findByRole('heading', { name: 'Select Runtime' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Use IL2CPP' }));

    await waitFor(() => {
      expect(screen.queryByRole('heading', { name: 'Select Runtime' })).toBeNull();
    });

    window.dispatchEvent(new Event('focus'));
    await new Promise((resolve) => window.setTimeout(resolve, 25));

    expect(screen.queryByRole('heading', { name: 'Select Runtime' })).toBeNull();
    expect(
      invokeMock.mock.calls.filter(
        ([command]) => command === 'complete_nexus_manual_download_session',
      ),
    ).toHaveLength(2);
  });
});
