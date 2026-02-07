import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ModsOverlay } from './ModsOverlay';
import type { Environment, ModLibraryEntry } from '../types';

const apiMocks = vi.hoisted(() => ({
  getEnvironment: vi.fn(),
  getMods: vi.fn(),
  getModLibrary: vi.fn(),
  checkModUpdates: vi.fn(),
  installDownloadedMod: vi.fn(),
}));

const eventMocks = vi.hoisted(() => ({
  onModsChanged: vi.fn(),
}));

vi.mock('../services/api', () => ({
  ApiService: apiMocks,
}));

vi.mock('../services/events', () => ({
  onModsChanged: eventMocks.onModsChanged,
}));

vi.mock('@tauri-apps/plugin-dialog', () => ({
  open: vi.fn(),
}));

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
    apiMocks.installDownloadedMod.mockReset();
    eventMocks.onModsChanged.mockReset();

    apiMocks.getEnvironment.mockResolvedValue(baseEnvironment);
    apiMocks.getMods.mockResolvedValue({
      mods: [],
      modsDirectory: 'C:/env/Mods',
      count: 0,
    });
    apiMocks.getModLibrary.mockResolvedValue({ downloaded: [] });
    apiMocks.checkModUpdates.mockResolvedValue([]);
    apiMocks.installDownloadedMod.mockResolvedValue({ results: [] });
    eventMocks.onModsChanged.mockResolvedValue(() => {});
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

    expect(await screen.findByText('S1API.Mono.MelonLoader.dll')).toBeInTheDocument();
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
});
