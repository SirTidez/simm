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
  const createEnvironment = vi.fn().mockResolvedValue({
    id: 'env-1',
    outputDir: 'D:\\Games\\Custom Install',
  });

  beforeEach(() => {
    environmentStoreMocks.useEnvironmentStore.mockReturnValue({
      createEnvironment,
      refreshEnvironments: vi.fn().mockResolvedValue(undefined),
      environments: [],
    });

    settingsStoreMocks.useSettingsStore.mockReturnValue({
      settings: {
        defaultDownloadDir: 'C:\\Games\\Default Install',
        steamUsername: 'tester',
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

  const clickBranchCard = (label: string) => {
    const heading = screen.getByText(label);
    const button = heading.closest('button');
    expect(button).toBeTruthy();
    fireEvent.click(button!);
  };

  const clickConfigureBack = () => {
    const backButtons = screen.getAllByRole('button', { name: /^back$/i });
    fireEvent.click(backButtons[0]);
  };

  it('uses the selected folder as the exact install target instead of appending the branch name', async () => {
    render(<EnvironmentCreationWizard onClose={vi.fn()} />);

    fireEvent.click(await screen.findByRole('button', { name: /download new branch/i }));
    clickBranchCard('Beta');

    const installFolderInput = await screen.findByLabelText(/install folder/i);
    expect((installFolderInput as HTMLInputElement).value).toBe('C:\\Games\\Default Install');

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
    });
  });

  it('refreshes the auto-derived name when switching branches but preserves user edits', async () => {
    render(<EnvironmentCreationWizard onClose={vi.fn()} />);

    fireEvent.click(await screen.findByRole('button', { name: /download new branch/i }));
    clickBranchCard('Beta');

    const nameInput = await screen.findByLabelText(/^name$/i);
    expect((nameInput as HTMLInputElement).value).toBe('Beta');

    clickConfigureBack();
    clickBranchCard('Alternate Beta');
    await waitFor(() => {
      expect((screen.getByLabelText(/^name$/i) as HTMLInputElement).value).toBe('Alternate Beta');
    });

    fireEvent.change(screen.getByLabelText(/^name$/i), {
      target: { value: 'My Custom Install' },
    });

    clickConfigureBack();
    clickBranchCard('Beta');
    await waitFor(() => {
      expect((screen.getByLabelText(/^name$/i) as HTMLInputElement).value).toBe('My Custom Install');
    });
  });
});
