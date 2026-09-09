import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

import { EnvironmentCreationWizard } from './EnvironmentCreationWizard';

const environmentStoreMocks = vi.hoisted(() => ({
  useEnvironmentStore: vi.fn(),
}));

const settingsStoreMocks = vi.hoisted(() => ({
  useSettingsStore: vi.fn(),
}));

const apiMocks = vi.hoisted(() => ({
  getSchedule1Config: vi.fn(),
  detectDepotDownloader: vi.fn(),
  getSecurityScannerStatus: vi.fn(),
  installSecurityScanner: vi.fn(),
  detectSteamInstallations: vi.fn(),
  browseDirectory: vi.fn(),
  getHomeDirectory: vi.fn(),
  createDirectory: vi.fn(),
  installDepotDownloader: vi.fn(),
  createSteamEnvironment: vi.fn(),
  importLocalEnvironment: vi.fn(),
}));

vi.mock('../stores/environmentStore', () => ({
  useEnvironmentStore: environmentStoreMocks.useEnvironmentStore,
}));

vi.mock('../stores/settingsStore', () => ({
  useSettingsStore: settingsStoreMocks.useSettingsStore,
}));

vi.mock('../services/api', () => ({
  ApiService: apiMocks,
}));

describe('EnvironmentCreationWizard', () => {
  const createEnvironment = vi.fn();
  const startDownload = vi.fn();

  beforeEach(() => {
    createEnvironment.mockReset();
    createEnvironment.mockResolvedValue({
      id: 'env-1',
      outputDir: 'D:\\Games\\Custom Install',
    });
    startDownload.mockReset();
    startDownload.mockResolvedValue(undefined);

    environmentStoreMocks.useEnvironmentStore.mockReturnValue({
      createEnvironment,
      startDownload,
      refreshEnvironments: vi.fn().mockResolvedValue(undefined),
      environments: [],
    });

    settingsStoreMocks.useSettingsStore.mockReturnValue({
      settings: {
        defaultDownloadDir: 'C:\\Games\\Default Install',
        steamUsername: 'tester',
        experienceMode: 'powerUser',
        showAdvancedGameTools: true,
        setupGuideCompleted: true,
      },
      refreshDepotDownloader: vi.fn().mockResolvedValue(undefined),
    });

    apiMocks.getSchedule1Config.mockResolvedValue({
      appId: '3164500',
      branches: [
        {
          name: 'beta',
          displayName: 'Beta',
          runtime: 'Mono',
          requiresAuth: false,
        },
        {
          name: 'alternate-beta',
          displayName: 'Alternate Beta',
          runtime: 'Mono',
          requiresAuth: false,
        },
      ],
    });
    apiMocks.detectDepotDownloader.mockResolvedValue({ installed: true });
    apiMocks.getSecurityScannerStatus.mockResolvedValue({
      enabled: true,
      autoInstall: true,
      installed: true,
      installMethod: 'managed',
      installedVersion: '1.0.0',
      latestVersion: '1.0.0',
    });
    apiMocks.installSecurityScanner.mockResolvedValue({
      enabled: true,
      autoInstall: true,
      installed: true,
      installMethod: 'managed',
      installedVersion: '1.0.0',
      latestVersion: '1.0.0',
    });
    apiMocks.detectSteamInstallations.mockResolvedValue([]);
    apiMocks.browseDirectory.mockResolvedValue({
      currentPath: 'D:\\Games\\Custom Install',
      directories: [],
    });
    apiMocks.getHomeDirectory.mockResolvedValue('C:\\Users\\SirTidez');
    apiMocks.createDirectory.mockResolvedValue(undefined);
    apiMocks.installDepotDownloader.mockResolvedValue(undefined);
    apiMocks.createSteamEnvironment.mockResolvedValue(undefined);
    apiMocks.importLocalEnvironment.mockResolvedValue(undefined);
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  const clickBranchCard = async (label: string) => {
    const heading = await screen.findByText(label);
    const button = heading.closest('button');
    expect(button).toBeTruthy();
    await waitFor(() => {
      expect((button as HTMLButtonElement).disabled).toBe(false);
    });
    fireEvent.click(button!);
  };

  const clickConfigureBack = () => {
    const backButtons = screen.getAllByRole('button', { name: /^back$/i });
    fireEvent.click(backButtons[0]);
  };

  it('derives the install folder from the default download directory and environment name', async () => {
    render(<EnvironmentCreationWizard onClose={vi.fn()} />);

    fireEvent.click(await screen.findByRole('button', { name: /download separate branch/i }));
    await clickBranchCard('Beta');

    const installFolderInput = await screen.findByLabelText(/install folder/i);
    expect((installFolderInput as HTMLInputElement).value).toBe('C:\\Games\\Default Install\\beta');

    fireEvent.change(screen.getByLabelText(/^name$/i), {
      target: { value: 'My Custom Install' },
    });

    await waitFor(() => {
      expect((screen.getByLabelText(/install folder/i) as HTMLInputElement).value).toBe(
        'C:\\Games\\Default Install\\my-custom-install'
      );
    });
  });

  it('keeps a manually selected install folder when the user browses for a different location', async () => {
    render(<EnvironmentCreationWizard onClose={vi.fn()} />);

    fireEvent.click(await screen.findByRole('button', { name: /download separate branch/i }));
    await clickBranchCard('Beta');

    expect((await screen.findByLabelText(/install folder/i) as HTMLInputElement).value).toBe(
      'C:\\Games\\Default Install\\beta'
    );

    fireEvent.click(screen.getByRole('button', { name: /^browse$/i }));
    await screen.findByRole('heading', { name: /select install folder/i });

    fireEvent.change(screen.getByLabelText(/current path/i), {
      target: { value: 'D:\\Games\\Custom Install' },
    });
    fireEvent.click(screen.getByRole('button', { name: /select folder/i }));

    await waitFor(() => {
      expect((screen.getByLabelText(/install folder/i) as HTMLInputElement).value).toBe('D:\\Games\\Custom Install');
    });

    fireEvent.click(screen.getByRole('button', { name: /^create environment$/i }));

    await waitFor(() => {
      expect(createEnvironment).toHaveBeenCalledWith(
        expect.objectContaining({
          branch: 'beta',
          outputDir: 'D:\\Games\\Custom Install',
        })
      );
      expect(startDownload).toHaveBeenCalledWith('env-1');
    });
  });

  it('does not surface MLVScan as an Add Game prerequisite', async () => {
    apiMocks.getSecurityScannerStatus.mockResolvedValueOnce({
      enabled: true,
      autoInstall: true,
      installed: false,
    });

    render(<EnvironmentCreationWizard onClose={vi.fn()} />);

    fireEvent.click(await screen.findByRole('button', { name: /download separate branch/i }));

    expect(screen.queryByText(/MLVScan is installed during setup/i)).toBeNull();
    expect(screen.queryByRole('button', { name: /install mlvscan/i })).toBeNull();
    expect(apiMocks.getSecurityScannerStatus).not.toHaveBeenCalled();
    expect(apiMocks.installSecurityScanner).not.toHaveBeenCalled();
  });

  it('automatically installs missing DepotDownloader when branch downloads are opened', async () => {
    apiMocks.detectDepotDownloader.mockResolvedValueOnce({ installed: false });
    apiMocks.getSecurityScannerStatus.mockResolvedValueOnce({
      enabled: true,
      autoInstall: true,
      installed: false,
    });

    render(<EnvironmentCreationWizard onClose={vi.fn()} />);

    fireEvent.click(await screen.findByRole('button', { name: /download separate branch/i }));

    await waitFor(() => {
      expect(apiMocks.installDepotDownloader).toHaveBeenCalledTimes(1);
    });
    expect(apiMocks.installSecurityScanner).not.toHaveBeenCalled();
  });

  it('automatically installs missing DepotDownloader on Linux', async () => {
    settingsStoreMocks.useSettingsStore.mockReturnValue({
      settings: {
        defaultDownloadDir: '/home/tester/SIMM',
        steamUsername: 'tester',
        platform: 'linux',
        experienceMode: 'powerUser',
        showAdvancedGameTools: true,
        setupGuideCompleted: true,
      },
      refreshDepotDownloader: vi.fn().mockResolvedValue(undefined),
    });
    apiMocks.detectDepotDownloader.mockResolvedValueOnce({
      installed: false,
      canAutoInstall: true,
      installHint: 'SIMM can install the latest Linux DepotDownloader release into ~/.local/bin.',
      installHelpUrl: 'https://github.com/SteamRE/DepotDownloader#installation',
    });

    render(<EnvironmentCreationWizard onClose={vi.fn()} />);

    fireEvent.click(await screen.findByRole('button', { name: /download separate branch/i }));

    await waitFor(() => {
      expect(apiMocks.installDepotDownloader).toHaveBeenCalledTimes(1);
    });
  });

  it('refreshes the auto-derived name when switching branches but preserves user edits', async () => {
    render(<EnvironmentCreationWizard onClose={vi.fn()} />);

    fireEvent.click(await screen.findByRole('button', { name: /download separate branch/i }));
    await clickBranchCard('Beta');

    const nameInput = await screen.findByLabelText(/^name$/i);
    expect((nameInput as HTMLInputElement).value).toBe('Beta');

    clickConfigureBack();
    await clickBranchCard('Alternate Beta');
    await waitFor(() => {
      expect((screen.getByLabelText(/^name$/i) as HTMLInputElement).value).toBe('Alternate Beta');
    });

    fireEvent.change(screen.getByLabelText(/^name$/i), {
      target: { value: 'My Custom Install' },
    });

    clickConfigureBack();
    await clickBranchCard('Beta');
    await waitFor(() => {
      expect((screen.getByLabelText(/^name$/i) as HTMLInputElement).value).toBe('My Custom Install');
    });
  });

  it('hides branch downloads in Player mode while keeping import available', async () => {
    settingsStoreMocks.useSettingsStore.mockReturnValue({
      settings: {
        defaultDownloadDir: 'C:\\Games\\Default Install',
        steamUsername: 'tester',
        experienceMode: 'player',
        showAdvancedGameTools: false,
        setupGuideCompleted: true,
      },
      refreshDepotDownloader: vi.fn().mockResolvedValue(undefined),
    });

    render(<EnvironmentCreationWizard onClose={vi.fn()} />);

    expect(await screen.findByRole('button', { name: /import existing folder/i })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /download separate branch/i })).toBeNull();
    expect(apiMocks.detectDepotDownloader).not.toHaveBeenCalled();
  });
});
