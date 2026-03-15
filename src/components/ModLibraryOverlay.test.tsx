import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ModLibraryOverlay } from './ModLibraryOverlay';
import type { ModLibraryEntry } from '../types';

const apiMocks = vi.hoisted(() => ({
  getModLibrary: vi.fn(),
  getS1APILatestRelease: vi.fn(),
  getMLVScanLatestRelease: vi.fn(),
  getS1APIReleases: vi.fn(),
  getMLVScanReleases: vi.fn(),
  downloadS1APIToLibrary: vi.fn(),
  downloadMLVScanToLibrary: vi.fn(),
  searchThunderstore: vi.fn(),
  downloadThunderstoreToLibrary: vi.fn(),
  uninstallDownloadedMod: vi.fn(),
  installDownloadedMod: vi.fn(),
}));

vi.mock('../services/api', () => ({
  ApiService: apiMocks,
}));

const eventMocks = vi.hoisted(() => ({
  onModMetadataRefreshStatus: vi.fn(),
}));

const settingsStoreMocks = vi.hoisted(() => ({
  useSettingsStore: vi.fn(),
}));

function makeEntry(overrides: Partial<ModLibraryEntry>): ModLibraryEntry {
  return {
    storageId: 'storage-1',
    displayName: 'Example Mod',
    files: ['Example.dll'],
    source: 'local',
    managed: true,
    installedIn: [],
    availableRuntimes: ['Mono'],
    storageIdsByRuntime: { Mono: 'storage-1' },
    installedInByRuntime: { Mono: [] },
    filesByRuntime: { Mono: ['Example.dll'] },
    ...overrides,
  };
}

vi.mock('../services/events', () => ({
  onModMetadataRefreshStatus: eventMocks.onModMetadataRefreshStatus,
}));

vi.mock('../stores/settingsStore', () => ({
  useSettingsStore: settingsStoreMocks.useSettingsStore,
}));

describe('ModLibraryOverlay', () => {
  beforeEach(() => {
    apiMocks.getModLibrary.mockReset();
    apiMocks.getS1APILatestRelease.mockReset();
    apiMocks.getMLVScanLatestRelease.mockReset();
    apiMocks.getS1APIReleases.mockReset();
    apiMocks.getMLVScanReleases.mockReset();
    apiMocks.downloadS1APIToLibrary.mockReset();
    apiMocks.downloadMLVScanToLibrary.mockReset();
    apiMocks.searchThunderstore.mockReset();
    apiMocks.downloadThunderstoreToLibrary.mockReset();
    apiMocks.uninstallDownloadedMod.mockReset();
    apiMocks.installDownloadedMod.mockReset();
    eventMocks.onModMetadataRefreshStatus.mockReset();
    settingsStoreMocks.useSettingsStore.mockReset();

    apiMocks.getS1APIReleases.mockResolvedValue([]);
    apiMocks.getMLVScanReleases.mockResolvedValue([]);
    apiMocks.downloadS1APIToLibrary.mockResolvedValue({ success: true });
    apiMocks.downloadMLVScanToLibrary.mockResolvedValue({ success: true });
    apiMocks.searchThunderstore.mockResolvedValue({ packages: [] });
    apiMocks.downloadThunderstoreToLibrary.mockResolvedValue({ success: true });
    apiMocks.uninstallDownloadedMod.mockResolvedValue({ results: [] });
    apiMocks.installDownloadedMod.mockResolvedValue({ results: [] });
    eventMocks.onModMetadataRefreshStatus.mockResolvedValue(() => {});
    settingsStoreMocks.useSettingsStore.mockReturnValue({
      settings: {
        showSecurityScanBadges: true,
      },
    });
    apiMocks.getMLVScanLatestRelease.mockResolvedValue({
      tag_name: 'v1.0.0',
      name: 'v1.0.0',
      published_at: '2025-01-01',
      prerelease: false,
      download_url: 'https://example.com/mlvscan.zip',
    });
  });

  afterEach(() => {
    cleanup();
  });

  it('shows S1API update state in featured downloads when installed version is behind', async () => {
    apiMocks.getModLibrary.mockResolvedValue({
      downloaded: [
        makeEntry({
          displayName: 'S1API',
          source: 'github',
          sourceId: 'ifBars/S1API',
          sourceVersion: 'v1.0.0',
          availableRuntimes: ['Mono', 'IL2CPP'],
          storageIdsByRuntime: { Mono: 's1-mono', IL2CPP: 's1-il2cpp' },
          installedInByRuntime: { Mono: [], IL2CPP: [] },
          filesByRuntime: { Mono: ['S1API.Mono.MelonLoader.dll'], IL2CPP: ['S1API.IL2CPP.MelonLoader.dll'] },
        }),
      ],
    });
    apiMocks.getS1APILatestRelease.mockResolvedValue({
      tag_name: 'v1.1.0',
      name: 'v1.1.0',
      published_at: '2025-01-01',
      prerelease: false,
      download_url: 'https://example.com/s1api.zip',
    });

    render(<ModLibraryOverlay isOpen={true} onClose={() => {}} />);

    expect(await screen.findByText('Installed: v1.0.0')).toBeTruthy();
    expect(await screen.findByText('Latest: v1.1.0')).toBeTruthy();
    expect((await screen.findAllByRole('button', { name: 'Update' })).length).toBeGreaterThan(0);

    await waitFor(() => {
      expect(screen.getAllByText('Update Available').length).toBeGreaterThan(0);
    });
  });

  it('shows author/version/runtime and latest version in downloaded mods cards', async () => {
    apiMocks.getModLibrary.mockResolvedValue({
      downloaded: [
        makeEntry({
          displayName: 'Mono Utility',
          sourceVersion: '1.2.3',
          author: 'TestAuthor',
          updateAvailable: true,
          remoteVersion: '1.3.0',
          availableRuntimes: ['Mono'],
        }),
      ],
    });
    apiMocks.getS1APILatestRelease.mockResolvedValue({
      tag_name: 'v1.0.0',
      name: 'v1.0.0',
      published_at: '2025-01-01',
      prerelease: false,
      download_url: 'https://example.com/s1api.zip',
    });

    render(<ModLibraryOverlay isOpen={true} onClose={() => {}} />);

    expect(await screen.findByText('Mono Utility')).toBeTruthy();
    expect(await screen.findByText('TestAuthor')).toBeTruthy();
    expect(await screen.findByText(/Active\s+v1\.2\.3/i)).toBeTruthy();
    expect(await screen.findByText(/Latest:?\s+v1\.3\.0/i)).toBeTruthy();
    expect(await screen.findByText('Mono')).toBeTruthy();
  });

  it('opens downloaded mod details via keyboard activation', async () => {
    apiMocks.getModLibrary.mockResolvedValue({
      downloaded: [
        makeEntry({
          displayName: 'Keyboard Mod',
          sourceUrl: 'https://example.com/mod',
          sourceVersion: '1.0.0',
        }),
      ],
    });
    apiMocks.getS1APILatestRelease.mockResolvedValue({
      tag_name: 'v1.0.0',
      name: 'v1.0.0',
      published_at: '2025-01-01',
      prerelease: false,
      download_url: 'https://example.com/s1api.zip',
    });

    render(<ModLibraryOverlay isOpen={true} onClose={() => {}} />);

    const card = await screen.findByRole('button', { name: 'Open details for Keyboard Mod' });
    fireEvent.keyDown(card, { key: 'Enter', code: 'Enter' });

    expect(await screen.findByText('Mod View')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Open Source Page' })).toBeTruthy();
  });

  it('suppresses unsafe source links in mod view', async () => {
    apiMocks.getModLibrary.mockResolvedValue({
      downloaded: [
        makeEntry({
          displayName: 'Unsafe Link Mod',
          sourceUrl: 'javascript:alert(1)',
          sourceVersion: '1.0.0',
        }),
      ],
    });
    apiMocks.getS1APILatestRelease.mockResolvedValue({
      tag_name: 'v1.0.0',
      name: 'v1.0.0',
      published_at: '2025-01-01',
      prerelease: false,
      download_url: 'https://example.com/s1api.zip',
    });

    render(<ModLibraryOverlay isOpen={true} onClose={() => {}} />);

    const card = await screen.findByRole('button', { name: 'Open details for Unsafe Link Mod' });
    fireEvent.click(card);

    expect(await screen.findByText('Mod View')).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Open Source Page' })).toBeNull();
  });

  it('shows an error when a Thunderstore library update cannot resolve a package', async () => {
    apiMocks.getModLibrary.mockResolvedValue({
      downloaded: [
        makeEntry({
          displayName: 'Cartel Enforcer',
          source: 'thunderstore',
          sourceId: 'XO_WithSauce/Cartel_Enforcer_MONO',
          sourceVersion: '1.8.3',
          remoteVersion: '1.8.4',
          updateAvailable: true,
          availableRuntimes: ['Mono'],
          installedIn: ['env-1'],
          installedInByRuntime: { Mono: ['env-1'] },
          storageIdsByRuntime: { Mono: 'storage-1' },
          filesByRuntime: { Mono: ['CartelEnforcer.dll'] },
        }),
      ],
    });
    apiMocks.getS1APILatestRelease.mockResolvedValue({
      tag_name: 'v1.0.0',
      name: 'v1.0.0',
      published_at: '2025-01-01',
      prerelease: false,
      download_url: 'https://example.com/s1api.zip',
    });
    apiMocks.searchThunderstore.mockResolvedValue({ packages: [] });

    render(<ModLibraryOverlay isOpen={true} onClose={() => {}} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Update' }));

    expect(await screen.findByText('Mod Update Failed')).toBeTruthy();
    expect(await screen.findByText(/Could not resolve the latest Thunderstore package/i)).toBeTruthy();
  });

  it('shows an error when a downloaded mod is missing update source metadata', async () => {
    apiMocks.getModLibrary.mockResolvedValue({
      downloaded: [
        makeEntry({
          displayName: 'Broken Managed Mod',
          source: 'local',
          sourceVersion: '1.0.0',
          updateAvailable: true,
          remoteVersion: undefined,
          availableRuntimes: ['Mono'],
          installedIn: ['env-1'],
          installedInByRuntime: { Mono: ['env-1'] },
          storageIdsByRuntime: { Mono: 'storage-1' },
          filesByRuntime: { Mono: ['BrokenManagedMod.dll'] },
        }),
      ],
    });
    apiMocks.getS1APILatestRelease.mockResolvedValue({
      tag_name: 'v1.0.0',
      name: 'v1.0.0',
      published_at: '2025-01-01',
      prerelease: false,
      download_url: 'https://example.com/s1api.zip',
    });

    render(<ModLibraryOverlay isOpen={true} onClose={() => {}} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Update' }));

    expect(await screen.findByText('Mod Update Failed')).toBeTruthy();
    expect(await screen.findByText(/missing Thunderstore or Nexus source metadata/i)).toBeTruthy();
  });

  it('switches versions from the dropdown menu', async () => {
    apiMocks.getModLibrary.mockResolvedValue({
      downloaded: [
        makeEntry({
          storageId: 'storage-new',
          displayName: 'Switcher Mod',
          source: 'thunderstore',
          sourceId: 'Author/SwitcherMod',
          sourceVersion: '1.1.0',
          installedVersion: '1.1.0',
          availableRuntimes: ['Mono'],
          installedIn: ['env-1'],
          installedInByRuntime: { Mono: ['env-1'] },
          storageIdsByRuntime: { Mono: 'storage-new' },
          filesByRuntime: { Mono: ['SwitcherMod.dll'] },
        }),
        makeEntry({
          storageId: 'storage-old',
          displayName: 'Switcher Mod',
          source: 'thunderstore',
          sourceId: 'Author/SwitcherMod',
          sourceVersion: '1.0.0',
          installedVersion: '1.0.0',
          availableRuntimes: ['Mono'],
          installedIn: [],
          installedInByRuntime: { Mono: [] },
          storageIdsByRuntime: { Mono: 'storage-old' },
          filesByRuntime: { Mono: ['SwitcherMod.dll'] },
        }),
      ],
    });
    apiMocks.getS1APILatestRelease.mockResolvedValue({
      tag_name: 'v1.0.0',
      name: 'v1.0.0',
      published_at: '2025-01-01',
      prerelease: false,
      download_url: 'https://example.com/s1api.zip',
    });

    render(<ModLibraryOverlay isOpen={true} onClose={() => {}} />);

    fireEvent.click(await screen.findByRole('button', { name: /v1\.1\.0/i }));
    fireEvent.click(await screen.findByRole('button', { name: /v1\.0\.0/i }));

    await waitFor(() => {
      expect(apiMocks.uninstallDownloadedMod).toHaveBeenCalledWith('storage-new', ['env-1']);
    });
    await waitFor(() => {
      expect(apiMocks.installDownloadedMod).toHaveBeenCalledWith('storage-old', ['env-1']);
    });
  });
});
