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
  openExternalUrl: vi.fn(),
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
    apiMocks.openExternalUrl.mockResolvedValue(undefined);
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  const clickBranchCard = async (label: string) => {
    const radio = await screen.findByRole('radio', { name: new RegExp(`^${label}`) });
    await waitFor(() => {
      expect(radio).not.toHaveAttribute('aria-disabled', 'true');
    });
    fireEvent.click(radio);
    fireEvent.click(screen.getByRole('button', { name: /^continue$/i }));
  };

  const clickConfigureBack = () => {
    const backButtons = screen.getAllByRole('button', { name: /^back$/i });
    fireEvent.click(backButtons[0]);
  };

  const chooseSource = async (name: RegExp) => {
    fireEvent.click(await screen.findByRole('radio', { name }));
    fireEvent.click(screen.getByRole('button', { name: /^continue$/i }));
  };

  it('derives the install folder from the default download directory and environment name', async () => {
    render(<EnvironmentCreationWizard onClose={vi.fn()} />);

    await chooseSource(/download separate branch/i);
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

    await chooseSource(/download separate branch/i);
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

  it('does not surface MLVScan as an Add Environment prerequisite', async () => {
    apiMocks.getSecurityScannerStatus.mockResolvedValueOnce({
      enabled: true,
      autoInstall: true,
      installed: false,
    });

    render(<EnvironmentCreationWizard onClose={vi.fn()} />);

    await chooseSource(/download separate branch/i);

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

    await chooseSource(/download separate branch/i);

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

    await chooseSource(/download separate branch/i);

    await waitFor(() => {
      expect(apiMocks.installDepotDownloader).toHaveBeenCalledTimes(1);
    });
  });

  it.each([
    'Winget install failed (code 37). Source unavailable.',
    new Error('Winget install failed (code 37). Source unavailable.'),
  ])('displays the actual automatic installation error: %s', async (error) => {
    apiMocks.detectDepotDownloader.mockResolvedValue({ installed: false });
    apiMocks.installDepotDownloader.mockRejectedValueOnce(error);

    render(<EnvironmentCreationWizard onClose={vi.fn()} />);
    await chooseSource(/download separate branch/i);

    expect(await screen.findByText('Winget install failed (code 37). Source unavailable.')).toBeVisible();
    expect(apiMocks.installDepotDownloader).toHaveBeenCalledTimes(1);
    expect(startDownload).not.toHaveBeenCalled();
  });

  it('displays string detection errors and offers another check', async () => {
    apiMocks.detectDepotDownloader.mockRejectedValueOnce('Configured DepotDownloader executable does not exist: C:/Tools/DepotDownloader.exe');

    render(<EnvironmentCreationWizard onClose={vi.fn()} />);
    await chooseSource(/download separate branch/i);

    expect(await screen.findByText('Configured DepotDownloader executable does not exist: C:/Tools/DepotDownloader.exe')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Check Again' })).toBeVisible();
    expect(apiMocks.installDepotDownloader).not.toHaveBeenCalled();
  });

  it('keeps a failed post-install detection visible instead of marking the tool ready', async () => {
    apiMocks.detectDepotDownloader.mockResolvedValueOnce({ installed: false });
    apiMocks.detectDepotDownloader.mockRejectedValueOnce('Cannot read the configured executable.');

    render(<EnvironmentCreationWizard onClose={vi.fn()} />);
    await chooseSource(/download separate branch/i);

    expect(await screen.findByText(/DepotDownloader installed, but SIMM could not refresh its status: Cannot read the configured executable\./)).toBeVisible();
    expect(screen.getByRole('button', { name: 'Check Again' })).toBeVisible();
  });

  it('shows actionable Windows recovery steps after installation fails and opens official downloads', async () => {
    apiMocks.detectDepotDownloader.mockResolvedValue({ installed: false });
    apiMocks.installDepotDownloader.mockRejectedValueOnce('Winget source unavailable.');

    render(<EnvironmentCreationWizard onClose={vi.fn()} />);
    await chooseSource(/download separate branch/i);

    expect(await screen.findByRole('heading', { name: 'Install DepotDownloader manually' })).toBeVisible();
    expect(screen.getByText('DepotDownloader-windows-x64.zip')).toBeVisible();
    expect(screen.getByText('%LOCALAPPDATA%\\SIMM\\tools\\DepotDownloader')).toBeVisible();
    expect(screen.getByText('Winget source unavailable.')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Open official downloads' }));
    await waitFor(() => expect(apiMocks.openExternalUrl).toHaveBeenCalledWith('https://github.com/SteamRE/DepotDownloader/releases/latest'));
    expect(screen.getByRole('button', { name: 'Retry automatic install' })).toBeVisible();
  });

  it('checks for a manual installation without repeating the failed installer', async () => {
    apiMocks.detectDepotDownloader.mockResolvedValueOnce({ installed: false });
    apiMocks.installDepotDownloader.mockRejectedValueOnce('Winget source unavailable.');

    render(<EnvironmentCreationWizard onClose={vi.fn()} />);
    await chooseSource(/download separate branch/i);
    expect(await screen.findByText('Winget source unavailable.')).toBeVisible();

    fireEvent.click(screen.getByRole('button', { name: 'Check Again' }));
    await waitFor(() => expect(screen.queryByText('Winget source unavailable.')).toBeNull());
    expect(screen.queryByRole('heading', { name: 'Install DepotDownloader manually' })).toBeNull();
    expect(apiMocks.detectDepotDownloader).toHaveBeenCalledTimes(2);
    expect(apiMocks.installDepotDownloader).toHaveBeenCalledTimes(1);
  });

  it('keeps actual detection errors visible after a manual recheck', async () => {
    apiMocks.detectDepotDownloader.mockResolvedValueOnce({ installed: false });
    apiMocks.installDepotDownloader.mockRejectedValueOnce('Winget source unavailable.');
    apiMocks.detectDepotDownloader.mockRejectedValueOnce('The selected executable cannot be read.');

    render(<EnvironmentCreationWizard onClose={vi.fn()} />);
    await chooseSource(/download separate branch/i);
    expect(await screen.findByText('Winget source unavailable.')).toBeVisible();

    fireEvent.click(screen.getByRole('button', { name: 'Check Again' }));
    expect(await screen.findByText('The selected executable cannot be read.')).toBeVisible();
    expect(apiMocks.installDepotDownloader).toHaveBeenCalledTimes(1);
  });

  it('shows Linux archive, location, and permission instructions after installation fails', async () => {
    const store = settingsStoreMocks.useSettingsStore();
    settingsStoreMocks.useSettingsStore.mockReturnValue({ ...store, settings: { ...store.settings, platform: 'linux' } });
    apiMocks.detectDepotDownloader.mockResolvedValue({ installed: false, canAutoInstall: true });
    apiMocks.installDepotDownloader.mockRejectedValueOnce('GitHub download unavailable.');

    render(<EnvironmentCreationWizard onClose={vi.fn()} />);
    await chooseSource(/download separate branch/i);

    expect(await screen.findByRole('heading', { name: 'Install DepotDownloader manually' })).toBeVisible();
    expect(screen.getByText('DepotDownloader-linux-x64.zip')).toBeVisible();
    expect(screen.getByText('~/.local/bin')).toBeVisible();
    expect(screen.getByText('chmod +x ~/.local/bin/DepotDownloader')).toBeVisible();
    expect(screen.queryByText('DepotDownloader-windows-x64.zip')).toBeNull();
  });

  it('refreshes the auto-derived name when switching branches but preserves user edits', async () => {
    render(<EnvironmentCreationWizard onClose={vi.fn()} />);

    await chooseSource(/download separate branch/i);
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

    expect(await screen.findByRole('radio', { name: /import existing folder/i })).toBeTruthy();
    expect(screen.queryByRole('radio', { name: /download separate branch/i })).toBeNull();
    expect(apiMocks.detectDepotDownloader).not.toHaveBeenCalled();
  });
});
