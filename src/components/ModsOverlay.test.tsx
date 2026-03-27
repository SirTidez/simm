import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ModsOverlay } from './ModsOverlay';
import type { Environment } from '../types';
import { open } from '@tauri-apps/plugin-dialog';

const apiMocks = vi.hoisted(() => ({
  getEnvironment: vi.fn(),
  getMods: vi.fn(),
  getModLibrary: vi.fn(),
  checkModUpdates: vi.fn(),
  getModUpdatesSummary: vi.fn(),
  installDownloadedMod: vi.fn(),
  getNexusOAuthStatus: vi.fn(),
  searchThunderstore: vi.fn(),
  searchNexusMods: vi.fn(),
  uploadMod: vi.fn(),
}));

const eventMocks = vi.hoisted(() => ({
  onModsChanged: vi.fn(),
  onModsSnapshotUpdated: vi.fn(),
  onModMetadataRefreshStatus: vi.fn(),
}));

vi.mock('../services/api', () => ({
  ApiService: apiMocks,
}));

vi.mock('../services/events', () => ({
  onModsChanged: eventMocks.onModsChanged,
  onModsSnapshotUpdated: eventMocks.onModsSnapshotUpdated,
  onModMetadataRefreshStatus: eventMocks.onModMetadataRefreshStatus,
}));

vi.mock('@tauri-apps/plugin-dialog', () => ({
  open: vi.fn(),
}));

const openMock = vi.mocked(open);

const baseEnvironment: Environment = {
  id: 'env-1',
  name: 'Test Env',
  appId: '3164500',
  branch: 'main',
  outputDir: 'C:/env',
  runtime: 'IL2CPP',
  status: 'completed',
};

describe('ModsOverlay', () => {
  beforeEach(() => {
    window.localStorage.clear();
    apiMocks.getEnvironment.mockReset();
    apiMocks.getMods.mockReset();
    apiMocks.getModLibrary.mockReset();
    apiMocks.checkModUpdates.mockReset();
    apiMocks.getModUpdatesSummary.mockReset();
    apiMocks.installDownloadedMod.mockReset();
    apiMocks.getNexusOAuthStatus.mockReset();
    apiMocks.searchThunderstore.mockReset();
    apiMocks.searchNexusMods.mockReset();
    apiMocks.uploadMod.mockReset();
    eventMocks.onModsChanged.mockReset();
    eventMocks.onModsSnapshotUpdated.mockReset();
    eventMocks.onModMetadataRefreshStatus.mockReset();
    openMock.mockReset();

    apiMocks.getEnvironment.mockResolvedValue(baseEnvironment);
    apiMocks.getMods.mockResolvedValue({
      mods: [],
      modsDirectory: 'C:/env/Mods',
      count: 0,
    });
    apiMocks.getModLibrary.mockResolvedValue({ downloaded: [] });
    apiMocks.checkModUpdates.mockResolvedValue([]);
    apiMocks.getModUpdatesSummary.mockResolvedValue({ count: 0, updates: [] });
    apiMocks.installDownloadedMod.mockResolvedValue({ results: [] });
    apiMocks.getNexusOAuthStatus.mockResolvedValue({ connected: false, account: { canDirectDownload: false, requiresSiteConfirmation: true } });
    apiMocks.searchThunderstore.mockResolvedValue({ packages: [] });
    apiMocks.searchNexusMods.mockResolvedValue({ mods: [] });
    apiMocks.uploadMod.mockResolvedValue({ success: false, error: 'test' });
    eventMocks.onModsChanged.mockResolvedValue(() => {});
    eventMocks.onModsSnapshotUpdated.mockResolvedValue(() => {});
    eventMocks.onModMetadataRefreshStatus.mockResolvedValue(() => {});
  });

  afterEach(() => {
    window.localStorage.clear();
    cleanup();
  });

  it('displays S1API component files in the installed mods list', async () => {
    apiMocks.getMods.mockResolvedValue({
      mods: [
        {
          name: 'S1API.Mono.MelonLoader',
          fileName: 'S1API.Mono.MelonLoader.dll',
          path: 'C:/env/Mods/S1API.Mono.MelonLoader.dll',
          source: 'local',
          managed: false,
          disabled: false,
        },
      ],
      modsDirectory: 'C:/env/Mods',
      count: 1,
    });

    render(
      <ModsOverlay
        isOpen={true}
        onClose={() => {}}
        environmentId="env-1"
      />
    );

    expect((await screen.findAllByText('S1API.Mono.MelonLoader.dll')).length).toBeGreaterThan(0);
  });

  it('prompts for runtime on ambiguous upload and forwards selected runtime metadata', async () => {
    openMock.mockResolvedValueOnce('C:/mods/Example.dll');

    render(
      <ModsOverlay
        isOpen={true}
        onClose={() => {}}
        environmentId="env-1"
      />
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Upload Mod' }));

    expect(await screen.findByText('Select Mod Runtime')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Mono' }));

    await waitFor(() => {
      expect(apiMocks.uploadMod).toHaveBeenCalledWith(
        'env-1',
        'C:/mods/Example.dll',
        'Example.dll',
        'IL2CPP',
        expect.objectContaining({ detectedRuntime: 'Mono', source: 'unknown' }),
        false,
      );
    });
  });

  it('renders the environment grid layout and no list-mode container', async () => {
    render(
      <ModsOverlay
        isOpen={true}
        onClose={() => {}}
        environmentId="env-1"
      />
    );

    await screen.findByRole('button', { name: 'Installed' });

    expect(document.querySelector('.workspace-collection-shell')).not.toBeNull();
    expect(document.querySelector('.mods-env-layout--grid')).toBeNull();
  });

  it('opens and closes the mod detail view from an installed mod card', async () => {
    apiMocks.getMods.mockResolvedValue({
      mods: [
        {
          name: 'Clickable Mod',
          fileName: 'Clickable.Mod.dll',
          path: 'C:/env/Mods/Clickable.Mod.dll',
          source: 'thunderstore',
          sourceUrl: 'https://thunderstore.io/c/schedule-i/p/author/clickable-mod',
          version: '1.0.0',
          latestVersion: '1.1.0',
          managed: true,
          disabled: false,
        },
      ],
      modsDirectory: 'C:/env/Mods',
      count: 1,
    });

    render(
      <ModsOverlay
        isOpen={true}
        onClose={() => {}}
        environmentId="env-1"
      />
    );

    const card = await screen.findByRole('button', { name: 'Open details for Clickable Mod' });
    fireEvent.click(card);

    await waitFor(() => {
      expect(screen.queryByText('Select an installed mod to review details and actions.')).toBeNull();
    });
    const inspector = document.querySelector('.workspace-collection__inspector') as HTMLElement;
    expect(within(inspector).getByRole('button', { name: 'Uninstall' })).toBeTruthy();
    expect(within(inspector).getByRole('button', { name: 'Open Folder' })).toBeTruthy();
  });
  it('opens installed mod details via keyboard activation', async () => {
    apiMocks.getMods.mockResolvedValue({
      mods: [
        {
          name: 'Keyboard Installed Mod',
          fileName: 'Keyboard.Installed.Mod.dll',
          path: 'C:/env/Mods/Keyboard.Installed.Mod.dll',
          source: 'thunderstore',
          sourceUrl: 'https://thunderstore.io/c/schedule-i/p/author/keyboard-installed-mod',
          version: '1.0.0',
          latestVersion: '1.1.0',
          managed: true,
          disabled: false,
        },
      ],
      modsDirectory: 'C:/env/Mods',
      count: 1,
    });

    render(
      <ModsOverlay
        isOpen={true}
        onClose={() => {}}
        environmentId="env-1"
      />
    );

    const card = await screen.findByRole('button', { name: 'Open details for Keyboard Installed Mod' });
    fireEvent.keyDown(card, { key: ' ', code: 'Space' });

    await waitFor(() => {
      expect(screen.queryByText('Select an installed mod to review details and actions.')).toBeNull();
    });
    const inspector = document.querySelector('.workspace-collection__inspector') as HTMLElement;
    expect(within(inspector).getByRole('button', { name: 'Open in Mod Library' })).toBeTruthy();
    expect(within(inspector).getByRole('button', { name: 'Uninstall' })).toBeTruthy();
  });
});

