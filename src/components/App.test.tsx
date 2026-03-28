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
  EnvironmentList: ({ onInitialDetectionComplete }: { onInitialDetectionComplete?: () => void }) => (
    <button onClick={onInitialDetectionComplete}>Finish Detection</button>
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
    isOpen ? (
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
    ) : null,
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
  }: {
    isOpen: boolean;
    onClose: () => void;
    onOpenWizard: () => void;
    onOpenSettings: () => void;
  }) =>
    isOpen ? (
      <div>
        <span>Welcome Overlay</span>
        <button onClick={onClose}>Close Welcome</button>
        <button onClick={onOpenWizard}>Open Wizard From Welcome</button>
        <button onClick={onOpenSettings}>Open Settings From Welcome</button>
      </div>
    ) : null,
}));

vi.mock('./Settings', () => ({
  Settings: () => <button>Settings</button>,
}));

vi.mock('./Footer', () => ({
  Footer: () => <div>Footer</div>,
}));

vi.mock('./DownloadsPanel', () => ({
  DownloadsPanel: () => <div>Downloads Panel</div>,
}));

describe('App', () => {
  beforeEach(() => {
    modLibraryOverlayMocks.lastNavigationState = null;
    invokeMock.mockReset();
    invokeMock.mockResolvedValue(false);
    deepLinkMocks.getCurrent.mockReset();
    deepLinkMocks.onOpenUrl.mockReset();
    deepLinkMocks.getCurrent.mockResolvedValue(null);
    deepLinkMocks.onOpenUrl.mockResolvedValue(() => {});

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
      settings: { appUpdate: null },
      updateSettings: vi.fn().mockResolvedValue(undefined),
    });
  });

  afterEach(() => {
    cleanup();
  });

  it('hides startup splash when initial detection completes', async () => {
    render(<App />);

    expect(screen.getByText('Detecting game and MelonLoader versions')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Finish Detection' }));

    await waitFor(() => {
      expect(screen.queryByText('Detecting game and MelonLoader versions')).toBeNull();
    });
  });

  it('opens and closes overlays from sidebar/header controls', async () => {
    render(<App />);

    fireEvent.click(screen.getByRole('button', { name: 'Mod Library' }));
    expect(await screen.findByText('Mod Library Overlay')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Close Mod Library' }));
    await waitFor(() => expect(screen.queryByText('Mod Library Overlay')).toBeNull());

    fireEvent.click(screen.getByRole('button', { name: 'New Game' }));
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

    expect(libraryButton).toHaveAttribute('aria-pressed', 'false');
    expect(accountsButton).toHaveAttribute('aria-pressed', 'false');
    expect(helpButton).toHaveAttribute('aria-pressed', 'false');

    fireEvent.click(libraryButton);
    expect(await screen.findByText('Mod Library Overlay')).toBeTruthy();
    expect(libraryButton).toHaveAttribute('aria-pressed', 'true');
    expect(accountsButton).toHaveAttribute('aria-pressed', 'false');

    fireEvent.click(accountsButton);
    expect(await screen.findByText('Steam Overlay')).toBeTruthy();
    expect(accountsButton).toHaveAttribute('aria-pressed', 'true');
    expect(libraryButton).toHaveAttribute('aria-pressed', 'false');

    fireEvent.click(helpButton);
    expect(await screen.findByText('Help Overlay')).toBeTruthy();
    expect(helpButton).toHaveAttribute('aria-pressed', 'true');
    expect(accountsButton).toHaveAttribute('aria-pressed', 'false');
  });

  it('uses window close for the custom close button', async () => {
    render(<App />);

    fireEvent.click(screen.getByRole('button', { name: 'Close' }));

    await waitFor(() => {
      expect(windowMocks.close).toHaveBeenCalled();
    });
  });
});
