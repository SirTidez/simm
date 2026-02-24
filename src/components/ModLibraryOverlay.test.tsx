import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
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
}));

vi.mock('../services/api', () => ({
  ApiService: apiMocks,
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

describe('ModLibraryOverlay', () => {
  beforeEach(() => {
    apiMocks.getModLibrary.mockReset();
    apiMocks.getS1APILatestRelease.mockReset();
    apiMocks.getMLVScanLatestRelease.mockReset();
    apiMocks.getS1APIReleases.mockReset();
    apiMocks.getMLVScanReleases.mockReset();
    apiMocks.downloadS1APIToLibrary.mockReset();
    apiMocks.downloadMLVScanToLibrary.mockReset();

    apiMocks.getS1APIReleases.mockResolvedValue([]);
    apiMocks.getMLVScanReleases.mockResolvedValue([]);
    apiMocks.downloadS1APIToLibrary.mockResolvedValue({ success: true });
    apiMocks.downloadMLVScanToLibrary.mockResolvedValue({ success: true });
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
    expect(await screen.findByRole('button', { name: 'Update' })).toBeTruthy();

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
});
