import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { App, formatDashboardTime, formatDashboardTimeDetail } from './App';
import type { ReactNode } from 'react';

const invokeMock = vi.hoisted(() => vi.fn());
const listenMock = vi.hoisted(() => vi.fn(async (_eventName?: string, _handler?: unknown) => () => {}));
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
const downloadStatusStoreMocks = vi.hoisted(() => ({
  useDownloadStatusStore: vi.fn(),
}));
const appRenderMocks = vi.hoisted(() => ({
  footerRenderCount: 0,
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
  setDecorations: vi.fn(),
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
  useDownloadStatusStore: downloadStatusStoreMocks.useDownloadStatusStore,
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
    focusedEnvironmentId,
    focusedEnvironmentRequestId,
  }: {
    onInitialDetectionComplete?: () => void;
    onOpenWorkspace?: (workspace: { view: 'wizard' }) => void;
    focusedEnvironmentId?: string | null;
    focusedEnvironmentRequestId?: number;
  }) => (
    <div>
      <span>Focused Environment: {focusedEnvironmentId ?? 'none'}</span>
      <span>Focus Request: {focusedEnvironmentRequestId ?? 0}</span>
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
  }) => {
    appRenderMocks.footerRenderCount += 1;

    return (
      <div>
        <button onClick={onOpenModUpdates}>Open Mod Updates</button>
        {appUpdateAvailable && (
          <button onClick={onOpenAppUpdate}>Install App Update</button>
        )}
      </div>
    );
  },
}));

vi.mock('./DownloadsPanel', () => ({
  DownloadsPanel: ({ onClose, presentation }: { onClose?: () => void; presentation?: string }) => (
    <div>
      <span>Downloads Panel</span>
      <span>{presentation}</span>
      {onClose && <button onClick={onClose}>Close downloads</button>}
    </div>
  ),
}));

describe('App', () => {
  it('formats home dashboard check timestamps without seconds or a four-digit year', () => {
    const localTimestampSeconds = Math.floor(new Date(2026, 6, 13, 17, 59, 29).getTime() / 1000);

    expect(formatDashboardTime(localTimestampSeconds)).toBe('07/13/26, 5:59 PM');
    expect(formatDashboardTimeDetail(localTimestampSeconds)).toBe('7/13/2026, 5:59:29 PM');
  });

  beforeEach(() => {
    modLibraryOverlayMocks.lastNavigationState = null;
    modLibraryOverlayMocks.suspendOnRender = false;
    modLibraryOverlayMocks.suspendPromise = null;
    modLibraryOverlayMocks.resolveSuspend = null;
    invokeMock.mockReset();
    invokeMock.mockResolvedValue(false);
    listenMock.mockReset();
    listenMock.mockImplementation(async () => () => {});
    deepLinkMocks.getCurrent.mockReset();
    deepLinkMocks.onOpenUrl.mockReset();
    deepLinkMocks.getCurrent.mockResolvedValue(null);
    deepLinkMocks.onOpenUrl.mockResolvedValue(() => {});
    dialogMocks.confirm.mockReset();
    dialogMocks.message.mockReset();
    processMocks.relaunch.mockReset();
    dialogMocks.confirm.mockResolvedValue(true);
    dialogMocks.message.mockResolvedValue(undefined);
    downloadStatusStoreMocks.useDownloadStatusStore.mockReturnValue({
      downloads: [],
    });
    processMocks.relaunch.mockResolvedValue(undefined);
    localStorage.clear();
    sessionStorage.clear();
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
    windowMocks.setDecorations.mockReset();
    windowMocks.minimize.mockReset();
    windowMocks.toggleMaximize.mockReset();
    windowMocks.close.mockReset();
    appRenderMocks.footerRenderCount = 0;

    windowMocks.isMaximized.mockResolvedValue(false);
    windowMocks.onResized.mockResolvedValue(() => {});
    windowMocks.setDecorations.mockResolvedValue(undefined);
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
    await waitFor(() => expect(windowMocks.setDecorations).toHaveBeenCalledWith(false));
    expect(screen.getByRole('heading', { name: 'Welcome back to SIMM' })).toBeTruthy();
  });

  it('hides telemetry navigation while the telemetry feature flag is disabled', async () => {
    render(<App />);

    await screen.findByRole('heading', { name: 'Welcome back to SIMM' });
    expect(screen.queryByRole('button', { name: 'Telemetry' })).toBeNull();
  });

  it('warns when a Steam runtime switch has no downloaded counterpart', async () => {
    let runtimeSwitchHandler: ((event: { payload: unknown }) => void) | null = null;
    listenMock.mockImplementation(async (eventName?: string, handler?: unknown) => {
      if (eventName === 'steam_runtime_switched') {
        runtimeSwitchHandler = handler as (event: { payload: unknown }) => void;
      }
      return () => {};
    });

    render(<App />);
    await screen.findByRole('heading', { name: 'Welcome back to SIMM' });
    await waitFor(() => expect(runtimeSwitchHandler).not.toBeNull());
    const emitRuntimeSwitch = runtimeSwitchHandler as unknown as (event: { payload: unknown }) => void;
    emitRuntimeSwitch({
      payload: {
        environmentId: 'steam-main',
        environmentName: 'Steam Installation',
        previousBranch: 'closed-beta',
        branch: 'main',
        previousRuntime: 'IL2CPP',
        runtime: 'Mono',
        disabledItems: 2,
        installedItems: 1,
        missingItems: ['Mono Missing Mod'],
        errors: [],
      },
    });

    expect(await screen.findByRole('heading', { name: 'Steam Runtime Changed' })).toBeTruthy();
    expect(screen.getByText(/Mono Missing Mod/)).toBeTruthy();
    expect(screen.getByText(/Those items remain disabled/)).toBeTruthy();
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
    expect(screen.getByText('Focused Environment: env-update')).toBeTruthy();
  });

  it('opens Home status for the currently selected environment and requests focus', async () => {
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
        {
          id: 'steam-main',
          name: 'Steam Installation',
          appId: '3164500',
          branch: 'main',
          outputDir: 'C:/Steam/Schedule I',
          runtime: 'Mono',
          status: 'completed',
          currentGameVersion: '0.4.5f1',
          environmentType: 'Steam',
        },
      ],
    });
    localStorage.setItem('simm:lastEnvId', 'steam-main');

    render(<App />);

    const statusButton = await screen.findByRole('button', { name: 'Open Environments for Steam Installation' });
    fireEvent.click(statusButton);

    expect(await screen.findByText('Focused Environment: steam-main')).toBeTruthy();
    expect(screen.getByText('Focus Request: 1')).toBeTruthy();
  });

  it('changes the focused environment from the sidebar while Environments is open', async () => {
    environmentStoreMocks.useEnvironmentStore.mockReturnValue({
      environments: [
        {
          id: 'env-main',
          name: 'Main',
          appId: '3164500',
          branch: 'main',
          outputDir: 'C:/Games/Main',
          runtime: 'IL2CPP',
          status: 'completed',
        },
        {
          id: 'env-beta',
          name: 'Beta',
          appId: '3164500',
          branch: 'beta',
          outputDir: 'C:/Games/Beta',
          runtime: 'Mono',
          status: 'completed',
        },
      ],
    });

    render(<App />);

    fireEvent.click(screen.getByTitle('Environments'));
    expect(await screen.findByText('Focused Environment: env-main')).toBeTruthy();

    const sidebar = screen.getByLabelText('Primary navigation');
    fireEvent.click(within(sidebar).getByRole('button', { name: /Beta/ }));

    expect(await screen.findByText('Focused Environment: env-beta')).toBeTruthy();
    expect(screen.getByText('Focus Request: 2')).toBeTruthy();
  });

  it('launches the selected non-Steam environment through Steam from the shell action', async () => {
    invokeMock.mockImplementation((command: string) => {
      if (command === 'launch_game') {
        return Promise.resolve({ success: true });
      }
      return Promise.resolve(false);
    });
    environmentStoreMocks.useEnvironmentStore.mockReturnValue({
      environments: [
        {
          id: 'env-main',
          name: 'Main',
          appId: '3164500',
          branch: 'main',
          outputDir: 'C:/Games/Main',
          runtime: 'IL2CPP',
          status: 'completed',
        },
      ],
    });

    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: 'Launch Game' }));

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith('launch_game', {
        environmentId: 'env-main',
        launchMethod: 'steam',
      });
    });
  });

  it('launches the selected Steam-managed environment through Steam from the shell action', async () => {
    invokeMock.mockImplementation((command: string) => {
      if (command === 'launch_game') {
        return Promise.resolve({ success: true });
      }
      return Promise.resolve(false);
    });
    environmentStoreMocks.useEnvironmentStore.mockReturnValue({
      environments: [
        {
          id: 'steam-main',
          name: 'Steam Installation',
          appId: '3164500',
          branch: 'main',
          outputDir: 'C:/Steam/Schedule I',
          runtime: 'Mono',
          status: 'completed',
          environmentType: 'Steam',
        },
      ],
    });

    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: 'Launch Game' }));

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith('launch_game', {
        environmentId: 'steam-main',
        launchMethod: 'steam',
      });
    });
  });

  it('warns when MelonLoader launch verification does not confirm a fresh log', async () => {
    invokeMock.mockImplementation((command: string) => {
      if (command === 'launch_game') {
        return Promise.resolve({ success: true, launchStartedAt: 12345 });
      }
      if (command === 'verify_melonloader_launch') {
        return Promise.resolve({
          status: 'staleLog',
          confirmed: false,
          logPath: 'C:/Games/Main/MelonLoader/Latest.log',
          message: 'MelonLoader log exists, but it has not been refreshed since this launch request.',
        });
      }
      return Promise.resolve(false);
    });
    environmentStoreMocks.useEnvironmentStore.mockReturnValue({
      environments: [
        {
          id: 'env-main',
          name: 'Main',
          appId: '3164500',
          branch: 'main',
          outputDir: 'C:/Games/Main',
          runtime: 'IL2CPP',
          status: 'completed',
        },
      ],
    });

    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: 'Launch Game' }));

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith('verify_melonloader_launch', {
        environmentId: 'env-main',
        launchStartedAt: 12345,
        timeoutMs: 20000,
      });
    });
    await waitFor(() => {
      expect(dialogMocks.message).toHaveBeenCalledWith(
        expect.stringContaining('MelonLoader log exists'),
        {
          title: 'MelonLoader Launch Not Confirmed: Main',
          kind: 'warning',
        },
      );
    });
  });

  it('offers to restart Steam from the shell action when a shortcut reload is required', async () => {
    invokeMock.mockImplementation((command: string) => {
      if (command === 'launch_game') {
        const lastCall = invokeMock.mock.calls.filter(([name]) => name === 'launch_game').length;
        if (lastCall === 1) {
          return Promise.reject("Steam needs to reload SIMM's shortcut for C:/Games/Schedule I Custom before it can launch through Steam.");
        }
        return Promise.resolve({ success: true });
      }
      return Promise.resolve(false);
    });
    environmentStoreMocks.useEnvironmentStore.mockReturnValue({
      environments: [
        {
          id: 'env-main',
          name: 'Il2Cpp',
          appId: '3164500',
          branch: 'main',
          outputDir: 'C:/Games/Il2Cpp',
          runtime: 'IL2CPP',
          status: 'completed',
        },
      ],
    });

    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: 'Launch Game' }));

    await waitFor(() => {
      expect(dialogMocks.confirm).toHaveBeenCalledWith(
        expect.stringContaining("Steam needs to reload SIMM's shortcut"),
        {
          title: 'Restart Steam: Il2Cpp',
          kind: 'warning',
        },
      );
    });

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith('launch_game', {
        environmentId: 'env-main',
        launchMethod: 'steam_restart',
      });
    });
  });

  it('orders shell environments the same way as the environments page', async () => {
    environmentStoreMocks.useEnvironmentStore.mockReturnValue({
      environments: [
        {
          id: 'env-alt',
          name: 'Alternate Beta',
          appId: '3164500',
          branch: 'alternate',
          outputDir: 'C:/Games/Alternate',
          runtime: 'Mono',
          status: 'completed',
        },
        {
          id: 'env-beta',
          name: 'Beta',
          appId: '3164500',
          branch: 'beta',
          outputDir: 'C:/Games/Beta',
          runtime: 'IL2CPP',
          status: 'completed',
        },
        {
          id: 'env-il2cpp',
          name: 'Il2Cpp',
          appId: '3164500',
          branch: 'main',
          outputDir: 'C:/Games/Il2Cpp',
          runtime: 'IL2CPP',
          status: 'completed',
          updateAvailable: true,
        },
        {
          id: 'steam-main',
          name: 'Steam Installation',
          appId: '3164500',
          branch: 'main',
          outputDir: 'C:/Steam/Schedule I',
          runtime: 'Mono',
          status: 'completed',
          environmentType: 'Steam',
        },
      ],
    });

    render(<App />);

    await waitFor(() => {
      expect(document.querySelectorAll('.app-shell-sidebar__environment-item')).toHaveLength(4);
    });
    const environmentButtons = Array.from(
      document.querySelectorAll<HTMLButtonElement>('.app-shell-sidebar__environment-item'),
    );

    expect(environmentButtons.map((button) => button.textContent)).toEqual([
      'Steam InstallationReady',
      'Alternate BetaReady',
      'BetaReady',
      'Il2CppUpdate',
    ]);
  });

  it('hides expanded sidebar content at collapse start while the rail animates', async () => {
    environmentStoreMocks.useEnvironmentStore.mockReturnValue({
      environments: [
        {
          id: 'env-main',
          name: 'Main Environment',
          appId: '3164500',
          branch: 'main',
          outputDir: 'C:/Games/Main',
          runtime: 'Mono',
          status: 'completed',
        },
      ],
    });

    render(<App />);

    const sidebar = screen.getByLabelText('Primary navigation');
    expect(screen.getByRole('button', { name: 'Collapse navigation sidebar' })).toBeTruthy();
    expect(within(sidebar).getByText('Main Environment')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Collapse navigation sidebar' }));

    expect(sidebar.classList.contains('app-shell-sidebar--collapsed')).toBe(true);
    expect(sidebar.classList.contains('app-shell-sidebar--animating')).toBe(true);
    expect(sidebar.classList.contains('app-shell-sidebar--expanded-content-visible')).toBe(false);
    expect(screen.getByRole('button', { name: 'Expand navigation sidebar' })).toBeTruthy();
    expect(within(sidebar).queryByText('Main Environment')).toBeNull();

    fireEvent.transitionEnd(sidebar, { propertyName: 'width' });

    expect(sidebar.classList.contains('app-shell-sidebar--animating')).toBe(false);
    expect(sidebar.classList.contains('app-shell-sidebar--expanded-content-visible')).toBe(false);
    expect(within(sidebar).queryByText('Main Environment')).toBeNull();
  });

  it('restores expanded sidebar content before the expand transition finishes', async () => {
    localStorage.setItem('simm:shellNavCollapsed', 'true');
    environmentStoreMocks.useEnvironmentStore.mockReturnValue({
      environments: [
        {
          id: 'env-main',
          name: 'Main Environment',
          appId: '3164500',
          branch: 'main',
          outputDir: 'C:/Games/Main',
          runtime: 'Mono',
          status: 'completed',
        },
      ],
    });

    render(<App />);

    const sidebar = screen.getByLabelText('Primary navigation');
    expect(sidebar.classList.contains('app-shell-sidebar--collapsed')).toBe(true);
    expect(screen.getByRole('button', { name: 'Expand navigation sidebar' })).toBeTruthy();
    expect(within(sidebar).queryByText('Main Environment')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Expand navigation sidebar' }));

    expect(sidebar.classList.contains('app-shell-sidebar--animating')).toBe(true);
    expect(sidebar.classList.contains('app-shell-sidebar--expanded-content-visible')).toBe(true);
    expect(within(sidebar).getByText('Main Environment')).toBeTruthy();

    await waitFor(() => {
      expect(sidebar.classList.contains('app-shell-sidebar--collapsed')).toBe(false);
    });

    fireEvent.transitionEnd(sidebar, { propertyName: 'width' });

    expect(sidebar.classList.contains('app-shell-sidebar--animating')).toBe(false);
    expect(sidebar.classList.contains('app-shell-sidebar--expanded-content-visible')).toBe(true);
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

  it('opens downloads as a bottom-docked sidebar popup', async () => {
    downloadStatusStoreMocks.useDownloadStatusStore.mockReturnValue({
      downloads: [
        {
          id: 'mod-1',
          kind: 'mod',
          label: 'ExampleMod.zip',
          contextLabel: 'Thunderstore',
          status: 'downloading',
          progress: 0,
          startedAt: Date.now(),
        },
      ],
    });

    render(<App />);

    fireEvent.click(screen.getByRole('button', { name: /Downloads/ }));

    const popup = await screen.findByRole('dialog', { name: 'Downloads' });
    const downloadsButton = screen.getByRole('button', { name: /Downloads/ });
    expect(popup.classList.contains('downloads-popover')).toBe(true);
    await waitFor(() => expect(popup.classList.contains('downloads-popover--open')).toBe(true));
    expect(downloadsButton.classList.contains('app-shell-sidebar__tool-item--active')).toBe(false);
    expect(await within(popup).findByText('Downloads Panel')).toBeTruthy();
    expect(within(popup).getByText('popup')).toBeTruthy();

    fireEvent.click(downloadsButton);
    expect(downloadsButton).toHaveAttribute('aria-expanded', 'false');
    expect(popup.classList.contains('downloads-popover--closing')).toBe(true);
    expect(screen.getByRole('dialog', { name: 'Downloads' })).toBeTruthy();

    fireEvent.transitionEnd(popup, { propertyName: 'opacity' });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Downloads' })).toBeNull());
  });

  it('counts recent completed downloads in the sidebar downloads badge', () => {
    downloadStatusStoreMocks.useDownloadStatusStore.mockReturnValue({
      downloads: [
        {
          id: 'mod-update-1',
          kind: 'mod',
          label: 'UpdatedMod.zip',
          contextLabel: 'Thunderstore',
          status: 'completed',
          progress: 100,
          downloadedFiles: 1,
          totalFiles: 1,
          startedAt: Date.now() - 1000,
          finishedAt: Date.now(),
        },
      ],
    });

    render(<App />);

    expect(screen.getByRole('button', { name: /Downloads\s*1/ })).toBeTruthy();
  });

  it('opens downloads without re-rendering the app shell', async () => {
    downloadStatusStoreMocks.useDownloadStatusStore.mockReturnValue({
      downloads: [
        {
          id: 'mod-1',
          kind: 'mod',
          label: 'ExampleMod.zip',
          contextLabel: 'Thunderstore',
          status: 'downloading',
          progress: 0,
          startedAt: Date.now(),
        },
      ],
    });

    render(<App />);

    await waitFor(() => expect(appRenderMocks.footerRenderCount).toBeGreaterThanOrEqual(3));

    const downloadsButton = screen.getByRole('button', { name: /Downloads/ });
    const renderCountBeforeOpen = appRenderMocks.footerRenderCount;

    fireEvent.click(downloadsButton);

    expect(await screen.findByRole('dialog', { name: 'Downloads' })).toBeTruthy();
    expect(appRenderMocks.footerRenderCount).toBe(renderCountBeforeOpen);
  });

  it('collapses sidebar sections without re-rendering the app shell', async () => {
    render(<App />);

    await waitFor(() => expect(appRenderMocks.footerRenderCount).toBeGreaterThanOrEqual(3));

    const sidebar = screen.getByLabelText('Primary navigation');
    const renderCountBeforeToggle = appRenderMocks.footerRenderCount;

    fireEvent.click(within(sidebar).getByRole('button', { name: 'Tools' }));

    expect(within(sidebar).queryByRole('button', { name: 'Home' })).toBeNull();
    expect(appRenderMocks.footerRenderCount).toBe(renderCountBeforeToggle);
  });

  it('updates window chrome state without re-rendering the app shell', async () => {
    render(<App />);

    await waitFor(() => expect(appRenderMocks.footerRenderCount).toBeGreaterThanOrEqual(3));

    const renderCountBeforeMaximize = appRenderMocks.footerRenderCount;

    fireEvent.click(screen.getByRole('button', { name: 'Maximize' }));

    await waitFor(() => expect(windowMocks.toggleMaximize).toHaveBeenCalled());
    expect(appRenderMocks.footerRenderCount).toBe(renderCountBeforeMaximize);
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

  it('switches directly between top-level panels without falling back to Home', async () => {
    render(<App />);

    fireEvent.click(screen.getByRole('button', { name: 'Help' }));
    expect(await screen.findByText('Help Overlay')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Open Settings From Help' }));

    expect(await screen.findByRole('button', { name: 'Run setup guide again' })).toBeTruthy();
    expect(screen.queryByText('Help Overlay')).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Welcome back to SIMM' })).toBeNull();
  });

  it('opens the downloads tray from another panel without navigating Home', async () => {
    downloadStatusStoreMocks.useDownloadStatusStore.mockReturnValue({
      downloads: [
        {
          id: 'download-1',
          kind: 'mod',
          label: 'Pack Rat.zip',
          contextLabel: 'Mod download',
          status: 'downloading',
          progress: 50,
          startedAt: Date.now(),
        },
      ],
    });

    render(<App />);

    fireEvent.click(screen.getByRole('button', { name: 'Help' }));
    expect(await screen.findByText('Help Overlay')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /^Downloads/ }));

    expect(await screen.findByText('Downloads Panel')).toBeTruthy();
    expect(screen.getByText('Help Overlay')).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Welcome back to SIMM' })).toBeNull();
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

  it('handles Nexus manual download URLs delivered through single-instance args', async () => {
    const nxmUrl = 'nxm://schedule1/mods/123/files/456?key=abc&expires=999&user_id=1';
    type SingleInstanceHandler = (event: { payload?: { args?: string[] } }) => void;
    let singleInstanceHandler: SingleInstanceHandler | null = null;
    listenMock.mockImplementation(async (eventName?: string, handler?: unknown) => {
      if (eventName === 'single-instance-args') {
        singleInstanceHandler = handler as SingleInstanceHandler;
      }
      return () => {};
    });
    invokeMock.mockImplementation((command: string) => {
      if (command === 'complete_nexus_manual_download_session') {
        return Promise.resolve({
          success: true,
          requestedKind: 'library',
          storageId: 'nexus-mod-1-0-0',
        });
      }

      return Promise.resolve(false);
    });

    render(<App />);

    await waitFor(() => {
      expect(singleInstanceHandler).not.toBeNull();
    });

    const handler = singleInstanceHandler as SingleInstanceHandler | null;
    if (!handler) {
      throw new Error('single-instance listener was not registered');
    }

    handler({
      payload: {
        args: ['/usr/bin/simm', nxmUrl],
      },
    });

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith('complete_nexus_manual_download_session', {
        nxmUrl,
        runtimeOverride: null,
      });
    });
  });

  it('consumes a replayed successful Nexus OAuth callback when no pending flow remains', async () => {
    const callbackUrl = 'simm://oauth/nexus/callback?code=abc&state=done';
    const oauthResults: Array<{ success: boolean; error?: string }> = [];
    const handleOAuthResult = ((event: Event) => {
      oauthResults.push((event as CustomEvent<{ success: boolean; error?: string }>).detail);
    }) as EventListener;
    window.addEventListener('nexus-oauth-result', handleOAuthResult);
    deepLinkMocks.getCurrent.mockResolvedValue([callbackUrl]);
    invokeMock.mockImplementation((command: string) => {
      switch (command) {
        case 'complete_nexus_oauth_callback':
          return Promise.reject(new Error('No pending Nexus OAuth login flow'));
        case 'get_nexus_oauth_status':
          return Promise.resolve({ connected: true, account: { name: 'Tester' } });
        default:
          return Promise.resolve(false);
      }
    });

    try {
      render(<App />);

      await waitFor(() => {
        expect(invokeMock).toHaveBeenCalledWith('complete_nexus_oauth_callback', {
          callbackUrl,
        });
        expect(invokeMock).toHaveBeenCalledWith('get_nexus_oauth_status');
      });

      expect(oauthResults).toContainEqual({ success: true });
      expect(oauthResults.some((result) => result.success === false)).toBe(false);

      window.dispatchEvent(new Event('focus'));
      await new Promise((resolve) => window.setTimeout(resolve, 25));

      expect(
        invokeMock.mock.calls.filter(([command]) => command === 'complete_nexus_oauth_callback'),
      ).toHaveLength(1);
    } finally {
      window.removeEventListener('nexus-oauth-result', handleOAuthResult);
    }
  });
});
