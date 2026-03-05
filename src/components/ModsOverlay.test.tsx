import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ModsOverlay } from './ModsOverlay';
import type { Environment, ModLibraryEntry } from '../types';
import { open } from '@tauri-apps/plugin-dialog';

const apiMocks = vi.hoisted(() => ({
  getEnvironment: vi.fn(),
  getMods: vi.fn(),
  getModLibrary: vi.fn(),
  checkModUpdates: vi.fn(),
  getModUpdatesSummary: vi.fn(),
  installDownloadedMod: vi.fn(),
  hasNexusModsApiKey: vi.fn(),
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
    apiMocks.getEnvironment.mockReset();
    apiMocks.getMods.mockReset();
    apiMocks.getModLibrary.mockReset();
    apiMocks.checkModUpdates.mockReset();
    apiMocks.getModUpdatesSummary.mockReset();
    apiMocks.installDownloadedMod.mockReset();
    apiMocks.hasNexusModsApiKey.mockReset();
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
    apiMocks.hasNexusModsApiKey.mockResolvedValue(false);
    apiMocks.searchThunderstore.mockResolvedValue({ packages: [] });
    apiMocks.searchNexusMods.mockResolvedValue({ mods: [] });
    apiMocks.uploadMod.mockResolvedValue({ success: false, error: 'test' });
    eventMocks.onModsChanged.mockResolvedValue(() => {});
    eventMocks.onModsSnapshotUpdated.mockResolvedValue(() => {});
    eventMocks.onModMetadataRefreshStatus.mockResolvedValue(() => {});
  });

  afterEach(() => {
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

    expect(await screen.findByText('S1API.Mono.MelonLoader.dll')).toBeTruthy();
  });

  it('uses global storageId when runtime-specific storage id is unavailable', async () => {
    const downloadedEntry: ModLibraryEntry = {
      storageId: 'global-storage-id',
      displayName: 'Fallback Mod',
      files: ['Fallback.dll'],
      managed: true,
      installedIn: [],
      availableRuntimes: ['IL2CPP'],
      storageIdsByRuntime: {},
      installedInByRuntime: {},
      filesByRuntime: {},
    };

    apiMocks.getModLibrary.mockResolvedValue({
      downloaded: [downloadedEntry],
    });

    render(
      <ModsOverlay
        isOpen={true}
        onClose={() => {}}
        environmentId="env-1"
      />
    );

    const modName = await screen.findByText('Fallback Mod');
    const card = modName.closest('.mod-card');
    expect(card).not.toBeNull();

    const installButton = within(card as HTMLElement).getByRole('button', { name: 'Install' });
    fireEvent.click(installButton);

    await waitFor(() => {
      expect(apiMocks.installDownloadedMod).toHaveBeenCalledWith('global-storage-id', ['env-1']);
    });
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

    fireEvent.click(await screen.findByRole('button', { name: 'Add Mod' }));

    expect(await screen.findByText('Select Mod Runtime')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Mono' }));

    await waitFor(() => {
      expect(apiMocks.uploadMod).toHaveBeenCalledWith(
        'env-1',
        'C:/mods/Example.dll',
        'Example.dll',
        'IL2CPP',
        expect.objectContaining({ detectedRuntime: 'Mono' })
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

    await screen.findByText('Library Downloads');
    await screen.findByText('Installed Here');

    expect(document.querySelector('.mods-env-layout--grid')).not.toBeNull();
    expect(document.querySelector('.mods-env-layout--list')).toBeNull();
  });

  it('searches Thunderstore on Enter and filters results by runtime/query', async () => {
    apiMocks.searchThunderstore.mockResolvedValue({
      packages: [
        {
          uuid4: 'pkg-1',
          name: 'Hero IL2CPP Mod',
          full_name: 'author-Hero-IL2CPP-Mod',
          owner: 'Author',
          package_url: 'https://thunderstore.io/c/schedule-i/p/author/hero-il2cpp-mod',
          categories: ['il2cpp'],
          versions: [{ version_number: '1.0.0', downloads: 100, description: 'hero runtime mod' }],
          rating_score: 10,
        },
        {
          uuid4: 'pkg-2',
          name: 'Hero Mono Mod',
          full_name: 'author-Hero-Mono-Mod',
          owner: 'Author',
          package_url: 'https://thunderstore.io/c/schedule-i/p/author/hero-mono-mod',
          categories: ['mono'],
          versions: [{ version_number: '1.0.0', downloads: 60, description: 'hero mono only' }],
          rating_score: 6,
        },
        {
          uuid4: 'pkg-3',
          name: 'Something Else',
          full_name: 'author-Something-Else',
          owner: 'Author',
          package_url: 'https://thunderstore.io/c/schedule-i/p/author/something-else',
          categories: ['il2cpp'],
          versions: [{ version_number: '1.0.0', downloads: 40, description: 'different query' }],
          rating_score: 2,
        },
      ],
    });

    render(
      <ModsOverlay
        isOpen={true}
        onClose={() => {}}
        environmentId="env-1"
      />
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Browse Mods' }));

    const searchInput = await screen.findByPlaceholderText('Search Thunderstore for IL2CPP mods...');
    fireEvent.change(searchInput, { target: { value: 'hero' } });
    fireEvent.keyDown(searchInput, { key: 'Enter', code: 'Enter' });

    await waitFor(() => {
      expect(apiMocks.searchThunderstore).toHaveBeenCalledWith('schedule-i', 'hero', 'IL2CPP');
    });

    expect(await screen.findByText('Hero IL2CPP Mod')).toBeTruthy();
    expect(screen.queryByText('Hero Mono Mod')).toBeNull();
    expect(screen.queryByText('Something Else')).toBeNull();
  });

  it('searches NexusMods on Enter when Nexus tab is active', async () => {
    apiMocks.searchNexusMods.mockResolvedValue({ mods: [] });

    render(
      <ModsOverlay
        isOpen={true}
        onClose={() => {}}
        environmentId="env-1"
      />
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Browse Mods' }));
    fireEvent.click(screen.getByRole('button', { name: 'NexusMods' }));

    const searchInput = await screen.findByPlaceholderText('Search NexusMods for IL2CPP mods...');
    fireEvent.change(searchInput, { target: { value: 'cool mod' } });
    fireEvent.keyDown(searchInput, { key: 'Enter', code: 'Enter' });

    await waitFor(() => {
      expect(apiMocks.searchNexusMods).toHaveBeenCalledWith('schedule1', 'cool mod');
    });

    expect(await screen.findByText('No mods found matching your search')).toBeTruthy();
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

    const modName = await screen.findByText('Clickable Mod');
    fireEvent.click(modName);

    expect(await screen.findByText('Mod View')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));

    await waitFor(() => {
      expect(screen.queryByText('Mod View')).toBeNull();
    });
    expect(screen.getByText('Clickable Mod')).toBeTruthy();
  });
});