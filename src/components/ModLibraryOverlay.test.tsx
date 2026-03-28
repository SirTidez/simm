import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ModLibraryOverlay } from './ModLibraryOverlay';
import type { ModLibraryEntry } from '../types';

const apiMocks = vi.hoisted(() => ({
  getModLibrary: vi.fn(),
  getEnvironments: vi.fn(),
  getS1APILatestRelease: vi.fn(),
  getMLVScanLatestRelease: vi.fn(),
  getS1APIReleases: vi.fn(),
  getMLVScanReleases: vi.fn(),
  downloadS1APIToLibrary: vi.fn(),
  downloadMLVScanToLibrary: vi.fn(),
  searchThunderstore: vi.fn(),
  searchNexusMods: vi.fn(),
  getNexusOAuthStatus: vi.fn(),
  getNexusModsModFiles: vi.fn(),
  getNexusModsLatestUpdated: vi.fn(),
  getNexusModsTrending: vi.fn(),
  getNexusModsLatestAdded: vi.fn(),
  downloadNexusModToLibrary: vi.fn(),
  downloadThunderstoreToLibrary: vi.fn(),
  uninstallDownloadedMod: vi.fn(),
  installDownloadedMod: vi.fn(),
  getModSecurityScanReport: vi.fn(),
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

function makeThunderstorePackage(
  name: string,
  version: string,
  runtime: 'IL2CPP' | 'Mono' = 'Mono',
  owner = 'ifBars',
) {
  return {
    uuid4: `${name}-${runtime}-pkg`,
    name,
    owner,
    package_url: `https://thunderstore.io/c/schedule-i/p/${owner}/${name}/`,
    date_created: '2025-01-01T00:00:00Z',
    date_updated: '2025-01-02T00:00:00Z',
    rating_score: 10,
    is_pinned: false,
    is_deprecated: false,
    full_name: `${owner}-${name}`,
    versions: [{
      name,
      full_name: `${owner}-${name}`,
      date_created: '2025-01-01T00:00:00Z',
      date_updated: '2025-01-02T00:00:00Z',
      uuid4: `${name}-${runtime}-ver`,
      version_number: version,
      dependencies: [],
      download_url: `https://example.com/${name}-${runtime}.zip`,
      downloads: 250,
      file_size: 1024,
      description: `${name} package`,
      icon: 'https://example.com/icon.png',
    }],
  };
}

function renderLibraryOverlay({
  libraryTab,
  navigationState,
  onOpenSecurityReport,
}: {
  libraryTab?: 'discover' | 'library' | 'updates';
  navigationState?: Record<string, unknown>;
  onOpenSecurityReport?: (request: { title: string }) => void;
} = {}) {
  return render(
    <ModLibraryOverlay
      isOpen={true}
      onClose={() => {}}
      onOpenSecurityReport={onOpenSecurityReport}
      navigationState={navigationState ?? (libraryTab ? { libraryTab } : undefined)}
    />,
  );
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
    apiMocks.getEnvironments.mockReset();
    apiMocks.getS1APILatestRelease.mockReset();
    apiMocks.getMLVScanLatestRelease.mockReset();
    apiMocks.getS1APIReleases.mockReset();
    apiMocks.getMLVScanReleases.mockReset();
    apiMocks.downloadS1APIToLibrary.mockReset();
    apiMocks.downloadMLVScanToLibrary.mockReset();
    apiMocks.searchThunderstore.mockReset();
    apiMocks.searchNexusMods.mockReset();
    apiMocks.getNexusOAuthStatus.mockReset();
    apiMocks.getNexusModsModFiles.mockReset();
    apiMocks.getNexusModsLatestUpdated.mockReset();
    apiMocks.getNexusModsTrending.mockReset();
    apiMocks.getNexusModsLatestAdded.mockReset();
    apiMocks.downloadNexusModToLibrary.mockReset();
    apiMocks.downloadThunderstoreToLibrary.mockReset();
    apiMocks.uninstallDownloadedMod.mockReset();
    apiMocks.installDownloadedMod.mockReset();
    apiMocks.getModSecurityScanReport.mockReset();
    eventMocks.onModMetadataRefreshStatus.mockReset();
    settingsStoreMocks.useSettingsStore.mockReset();

    apiMocks.getS1APIReleases.mockResolvedValue([]);
    apiMocks.getMLVScanReleases.mockResolvedValue([]);
    apiMocks.getEnvironments.mockResolvedValue([]);
    apiMocks.downloadS1APIToLibrary.mockResolvedValue({ success: true });
    apiMocks.downloadMLVScanToLibrary.mockResolvedValue({ success: true });
    apiMocks.searchThunderstore.mockImplementation(async (_gameId, query, runtime) => {
      if (query === 'S1API_Forked') {
        return { packages: [makeThunderstorePackage('S1API_Forked', '1.1.0', runtime)] };
      }
      if (query === 'MLVScan') {
        return { packages: [makeThunderstorePackage('MLVScan', '1.0.0', runtime)] };
      }
      return { packages: [] };
    });
    apiMocks.searchNexusMods.mockResolvedValue({ mods: [] });
    apiMocks.getNexusOAuthStatus.mockResolvedValue({
      connected: true,
      account: {
        canDirectDownload: true,
        requiresSiteConfirmation: false,
      },
    });
    apiMocks.getNexusModsModFiles.mockResolvedValue([]);
    apiMocks.getNexusModsLatestUpdated.mockResolvedValue({ mods: [] });
    apiMocks.getNexusModsTrending.mockResolvedValue({ mods: [] });
    apiMocks.getNexusModsLatestAdded.mockResolvedValue({ mods: [] });
    apiMocks.downloadNexusModToLibrary.mockResolvedValue({
      success: true,
      storageId: 'downloaded-storage',
    });
    apiMocks.downloadThunderstoreToLibrary.mockResolvedValue({ success: true });
    apiMocks.uninstallDownloadedMod.mockResolvedValue({ results: [] });
    apiMocks.installDownloadedMod.mockResolvedValue({ results: [] });
    apiMocks.getModSecurityScanReport.mockResolvedValue(null);
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

    renderLibraryOverlay();

    expect(await screen.findByText('S1API')).toBeTruthy();

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /S1API/i })).toHaveTextContent('Update');
    });
  });

  it('shows thunderstore search results without auto-selecting the first result', async () => {
    apiMocks.getModLibrary.mockResolvedValue({ downloaded: [] });
    apiMocks.searchThunderstore.mockImplementation(async (_gameId, query, runtime) => {
      if (query === 'map') {
        return {
          packages: [makeThunderstorePackage('MapTools', '1.2.0', runtime, 'Tester')],
        };
      }
      if (query === 'S1API_Forked') {
        return { packages: [makeThunderstorePackage('S1API_Forked', '1.1.0', runtime)] };
      }
      if (query === 'MLVScan') {
        return { packages: [makeThunderstorePackage('MLVScan', '1.0.0', runtime)] };
      }
      return { packages: [] };
    });

    renderLibraryOverlay({ libraryTab: 'discover' });

    fireEvent.change(screen.getByPlaceholderText('Search or browse Nexus Mods...'), {
      target: { value: 'map' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Thunderstore' }));
    fireEvent.change(screen.getByPlaceholderText('Search or browse Thunderstore mods...'), {
      target: { value: 'map' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));

    expect(await screen.findByText('Discover Results')).toBeTruthy();
    expect(await screen.findByText('MapTools')).toBeTruthy();
    expect(screen.getByText('1 result(s)')).toBeTruthy();
    expect(screen.getByText('Select a mod to review details and actions.')).toBeTruthy();
    expect(screen.getByText('Updated Jan 1, 2025')).toBeTruthy();
  });

  it('shows the Thunderstore updated date when package data uses camelCase fields', async () => {
    apiMocks.getModLibrary.mockResolvedValue({ downloaded: [] });

    renderLibraryOverlay({
      navigationState: {
        libraryTab: 'discover',
        showDiscovery: true,
        showSearchResults: true,
        searchResults: [
          {
            key: 'tester::maptools',
            name: 'MapTools',
            owner: 'Tester',
            packageUrl: 'https://thunderstore.io/c/schedule-i/p/Tester/MapTools/',
            packagesByRuntime: {
              Mono: {
                ...makeThunderstorePackage('MapTools', '1.2.0', 'Mono', 'Tester'),
                date_updated: '',
                date_created: '',
                dateUpdated: '2025-01-10T12:00:00Z',
                versions: [
                  {
                    ...makeThunderstorePackage('MapTools', '1.2.0', 'Mono', 'Tester').versions[0],
                    date_updated: '',
                    date_created: '',
                    dateUpdated: '2025-01-10T12:00:00Z',
                  },
                ],
              },
            },
          },
        ],
        activeModView: {
          id: 'tester::maptools',
          name: 'MapTools',
          source: 'thunderstore',
          author: 'Tester',
          summary: 'A mapping helper.',
          kind: 'thunderstore',
        },
      },
    });

    expect(await screen.findByText('Jan 10, 2025')).toBeTruthy();
    expect(screen.getAllByText('Updated Jan 10, 2025').length).toBeGreaterThan(0);
  });

  it('downloads the newest runtime-compatible Nexus file instead of the first matching file', async () => {
    apiMocks.getModLibrary
      .mockResolvedValueOnce({ downloaded: [] })
      .mockResolvedValueOnce({ downloaded: [] });
    apiMocks.getNexusModsModFiles.mockResolvedValue([
      {
        file_id: 100,
        name: 'Pack Rat Mono 1.0.0',
        file_name: 'PackRat-mono-1.0.0.zip',
        version: '1.0.0',
        mod_version: '1.0.0',
        is_primary: true,
        uploaded_timestamp: 1000,
      },
      {
        file_id: 200,
        name: 'Pack Rat Mono 1.0.7r2',
        file_name: 'PackRat-mono-1.0.7r2.zip',
        version: '1.0.7r2',
        mod_version: '1.0.7r2',
        is_primary: false,
        uploaded_timestamp: 2000,
      },
    ]);

    renderLibraryOverlay({
      navigationState: {
        libraryTab: 'discover',
        showDiscovery: true,
        showNexusModsResults: true,
        nexusModsSearchResults: [
          {
            mod_id: 1629,
            name: 'Pack Rat',
            summary: 'Carry more stuff.',
            description: 'Carry more stuff.',
            picture_url: 'https://example.com/packrat.png',
            version: '1.0.7r2',
            author: 'ExampleAuthor',
            uploaded_time: '2025-01-01',
            updated_time: '2025-01-02',
            category_id: 1,
            contains_adult_content: false,
            status: 'published',
            endorsement_count: 42,
            unique_downloads: 100,
            mod_downloads: 250,
          },
        ],
        activeModView: {
          id: '1629',
          name: 'Pack Rat',
          source: 'nexusmods',
          author: 'ExampleAuthor',
          summary: 'Carry more stuff.',
          iconUrl: 'https://example.com/packrat.png',
          installedVersion: '1.0.7r2',
          kind: 'nexusmods',
        },
      },
    });

    fireEvent.click(
      await screen.findByRole('button', { name: 'Download selected version' }),
    );

    expect(screen.getByText('Updated Jan 1, 2025')).toBeTruthy();

    await waitFor(() => {
      expect(apiMocks.downloadNexusModToLibrary).toHaveBeenCalledWith(
        1629,
        200,
        'Mono',
      );
    });
  });

  it('downloads the selected Thunderstore version from the inspector', async () => {
    apiMocks.getModLibrary
      .mockResolvedValueOnce({ downloaded: [] })
      .mockResolvedValueOnce({ downloaded: [] });

    renderLibraryOverlay({
      navigationState: {
        libraryTab: 'discover',
        showDiscovery: true,
        showSearchResults: true,
        searchResults: [
          {
            key: 'ifBars/ScheduleToolbox',
            name: 'ScheduleToolbox',
            owner: 'ifBars',
            packageUrl: 'https://thunderstore.io/c/schedule-i/p/ifBars/ScheduleToolbox/',
            packagesByRuntime: {
              Mono: {
                ...makeThunderstorePackage('ScheduleToolbox', '1.2.0', 'Mono'),
                versions: [
                  {
                    name: 'ScheduleToolbox',
                    full_name: 'ifBars-ScheduleToolbox',
                    date_created: '2025-01-01T00:00:00Z',
                    date_updated: '2025-01-10T00:00:00Z',
                    uuid4: 'mono-1-2-0',
                    version_number: '1.2.0',
                    dependencies: [],
                    download_url: 'https://example.com/toolbox-1.2.0.zip',
                    downloads: 220,
                    file_size: 1024,
                    description: 'Current stable release',
                    icon: 'https://example.com/toolbox.png',
                  },
                  {
                    name: 'ScheduleToolbox',
                    full_name: 'ifBars-ScheduleToolbox',
                    date_created: '2024-12-01T00:00:00Z',
                    date_updated: '2024-12-08T00:00:00Z',
                    uuid4: 'mono-1-1-0',
                    version_number: '1.1.0',
                    dependencies: [],
                    download_url: 'https://example.com/toolbox-1.1.0.zip',
                    downloads: 140,
                    file_size: 900,
                    description: 'Older compatible build',
                    icon: 'https://example.com/toolbox.png',
                  },
                ],
              },
            },
          },
        ],
        activeModView: {
          id: 'ifBars/ScheduleToolbox',
          name: 'ScheduleToolbox',
          source: 'thunderstore',
          author: 'ifBars',
          summary: 'A useful toolbox.',
          iconUrl: 'https://example.com/toolbox.png',
          latestVersion: '1.2.0',
          kind: 'thunderstore',
        },
      },
    });

    fireEvent.click(await screen.findByRole('option', { name: /v1\.1\.0/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Download selected version' }));

    await waitFor(() => {
      expect(apiMocks.downloadThunderstoreToLibrary).toHaveBeenCalledWith(
        'ScheduleToolbox-Mono-pkg',
        'Mono',
        undefined,
        'mono-1-1-0',
      );
    });
  });

  it('downloads the selected Nexus file from the inspector', async () => {
    apiMocks.getModLibrary
      .mockResolvedValueOnce({ downloaded: [] })
      .mockResolvedValueOnce({ downloaded: [] });
    apiMocks.getNexusModsModFiles.mockResolvedValue([
      {
        file_id: 301,
        name: 'Pack Rat Mono 1.0.0',
        file_name: 'PackRat-mono-1.0.0.zip',
        version: '1.0.0',
        mod_version: '1.0.0',
        category_name: 'MAIN',
        is_primary: true,
        uploaded_timestamp: 1000,
      },
      {
        file_id: 401,
        name: 'Pack Rat Mono 1.0.7r2',
        file_name: 'PackRat-mono-1.0.7r2.zip',
        version: '1.0.7r2',
        mod_version: '1.0.7r2',
        category_name: 'MAIN',
        is_primary: false,
        uploaded_timestamp: 2000,
      },
    ]);

    renderLibraryOverlay({
      navigationState: {
        libraryTab: 'discover',
        showDiscovery: true,
        showNexusModsResults: true,
        nexusModsSearchResults: [
          {
            mod_id: 1629,
            name: 'Pack Rat',
            summary: 'Carry more stuff.',
            description: 'Carry more stuff.',
            picture_url: 'https://example.com/packrat.png',
            version: '1.0.7r2',
            author: 'ExampleAuthor',
            uploaded_time: '2025-01-01',
            updated_time: '2025-01-02',
            category_id: 1,
            contains_adult_content: false,
            status: 'published',
            endorsement_count: 42,
            unique_downloads: 100,
            mod_downloads: 250,
          },
        ],
        activeModView: {
          id: '1629',
          name: 'Pack Rat',
          source: 'nexusmods',
          author: 'ExampleAuthor',
          summary: 'Carry more stuff.',
          iconUrl: 'https://example.com/packrat.png',
          installedVersion: '1.0.7r2',
          kind: 'nexusmods',
        },
      },
    });

    fireEvent.click(await screen.findByRole('option', { name: /v1\.0\.0/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Download selected version' }));

    await waitFor(() => {
      expect(apiMocks.downloadNexusModToLibrary).toHaveBeenCalledWith(
        1629,
        301,
        'Mono',
      );
    });
  });

  it('falls back to the Nexus mod updated date when file rows do not expose upload timestamps', async () => {
    apiMocks.getModLibrary.mockResolvedValue({ downloaded: [] });
    apiMocks.getNexusModsModFiles.mockResolvedValue([
      {
        file_id: 301,
        name: 'Pack Rat Mono',
        file_name: 'PackRat-mono-1.0.7r2.zip',
        version: '1.0.7r2',
        mod_version: '1.0.7r2',
        category_name: 'MAIN',
        is_primary: true,
        uploaded_timestamp: 0,
      },
    ]);

    renderLibraryOverlay({
      navigationState: {
        libraryTab: 'discover',
        showDiscovery: true,
        showNexusModsResults: true,
        nexusModsSearchResults: [
          {
            mod_id: 1629,
            name: 'Pack Rat',
            summary: 'Carry more stuff.',
            description: 'Carry more stuff.',
            picture_url: 'https://example.com/packrat.png',
            version: '1.0.7r2',
            author: 'ExampleAuthor',
            updated_time: '2026-03-23T12:00:00Z',
            category_id: 1,
            contains_adult_content: false,
            status: 'published',
            endorsement_count: 42,
            unique_downloads: 100,
            mod_downloads: 250,
          },
        ],
        activeModView: {
          id: '1629',
          name: 'Pack Rat',
          source: 'nexusmods',
          author: 'ExampleAuthor',
          summary: 'Carry more stuff.',
          iconUrl: 'https://example.com/packrat.png',
          installedVersion: '1.0.7r2',
          kind: 'nexusmods',
        },
      },
    });

    expect(await screen.findByText('Uploaded Mar 23, 2026')).toBeTruthy();
  });

  it('de-prioritizes FOMOD installers in the Nexus inspector when direct runtime files exist', async () => {
    apiMocks.getModLibrary
      .mockResolvedValueOnce({ downloaded: [] })
      .mockResolvedValueOnce({ downloaded: [] });
    apiMocks.getNexusModsModFiles.mockResolvedValue([
      {
        file_id: 501,
        name: 'Pack Rat Vortex Installer',
        file_name: 'PackRat-Vortex-Installer-1.0.7r2.zip',
        version: '1.0.7r2',
        mod_version: '1.0.7r2',
        category_name: 'MAIN',
        is_primary: true,
        uploaded_timestamp: 2000,
      },
      {
        file_id: 502,
        name: 'Pack Rat Mono',
        file_name: 'PackRat-Mono-1.0.7r2.zip',
        version: '1.0.7r2',
        mod_version: '1.0.7r2',
        category_name: 'MAIN',
        is_primary: false,
        uploaded_timestamp: 2000,
      },
    ]);

    renderLibraryOverlay({
      navigationState: {
        libraryTab: 'discover',
        showDiscovery: true,
        showNexusModsResults: true,
        nexusModsSearchResults: [
          {
            mod_id: 1629,
            name: 'Pack Rat',
            summary: 'Carry more stuff.',
            description: 'Carry more stuff.',
            picture_url: 'https://example.com/packrat.png',
            version: '1.0.7r2',
            author: 'ExampleAuthor',
            uploaded_time: '2025-01-01',
            updated_time: '2025-01-02',
            category_id: 1,
            contains_adult_content: false,
            status: 'published',
            endorsement_count: 42,
            unique_downloads: 100,
            mod_downloads: 250,
          },
        ],
        activeModView: {
          id: '1629',
          name: 'Pack Rat',
          source: 'nexusmods',
          author: 'ExampleAuthor',
          summary: 'Carry more stuff.',
          iconUrl: 'https://example.com/packrat.png',
          installedVersion: '1.0.7r2',
          kind: 'nexusmods',
        },
      },
    });

    expect(await screen.findByText('FOMOD Installer')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Download selected version' }));

    await waitFor(() => {
      expect(apiMocks.downloadNexusModToLibrary).toHaveBeenCalledWith(
        1629,
        502,
        'Mono',
      );
    });
  });

  it('downloads a selected Nexus FOMOD installer without forcing a runtime', async () => {
    apiMocks.getModLibrary
      .mockResolvedValueOnce({ downloaded: [] })
      .mockResolvedValueOnce({ downloaded: [] });
    apiMocks.getNexusModsModFiles.mockResolvedValue([
      {
        file_id: 501,
        name: 'Pack Rat Vortex Installer',
        file_name: 'PackRat-Vortex-Installer-1.0.7r2.zip',
        version: '1.0.7r2',
        mod_version: '1.0.7r2',
        category_name: 'MAIN',
        is_primary: true,
        uploaded_timestamp: 2000,
      },
    ]);

    renderLibraryOverlay({
      navigationState: {
        libraryTab: 'discover',
        showDiscovery: true,
        showNexusModsResults: true,
        nexusModsSearchResults: [
          {
            mod_id: 1629,
            name: 'Pack Rat',
            summary: 'Carry more stuff.',
            description: 'Carry more stuff.',
            picture_url: 'https://example.com/packrat.png',
            version: '1.0.7r2',
            author: 'ExampleAuthor',
            uploaded_time: '2025-01-01',
            updated_time: '2025-01-02',
            category_id: 1,
            contains_adult_content: false,
            status: 'published',
            endorsement_count: 42,
            unique_downloads: 100,
            mod_downloads: 250,
          },
        ],
        activeModView: {
          id: '1629',
          name: 'Pack Rat',
          source: 'nexusmods',
          author: 'ExampleAuthor',
          summary: 'Carry more stuff.',
          iconUrl: 'https://example.com/packrat.png',
          installedVersion: '1.0.7r2',
          kind: 'nexusmods',
        },
      },
    });

    fireEvent.click(await screen.findByRole('option', { name: /v1\.0\.7r2/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Download selected version' }));

    await waitFor(() => {
      expect(apiMocks.downloadNexusModToLibrary).toHaveBeenCalledWith(
        1629,
        501,
        undefined,
      );
    });
  });

  it('shows version, runtime, and update state in downloaded mod rows', async () => {
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

    renderLibraryOverlay({ libraryTab: 'library' });

    expect((await screen.findAllByText('Mono Utility')).length).toBeGreaterThan(0);
    expect((await screen.findAllByText('v1.2.3')).length).toBeGreaterThan(0);
    expect(await screen.findByText('Update available')).toBeTruthy();
    expect(await screen.findByText('Mono')).toBeTruthy();
  });

  it('renders MLVScan disposition badges for downloaded mods', async () => {
    apiMocks.getModLibrary.mockResolvedValue({
      downloaded: [
        makeEntry({
          displayName: 'Questionable Mod',
          securityScan: {
            state: 'review',
            verified: false,
            disposition: {
              classification: 'Suspicious',
              headline: 'Potentially malicious',
              summary: 'Heuristic checks flagged this download.',
              blockingRecommended: false,
              relatedFindingIds: ['finding-1'],
            },
            highestSeverity: 'High',
            totalFindings: 1,
            threatFamilyCount: 0,
          },
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

    renderLibraryOverlay({ libraryTab: 'library' });

    expect((await screen.findAllByText('Potentially Malicious')).length).toBeGreaterThan(0);
  });

  it('opens the security report overlay for downloaded mods', async () => {
    apiMocks.getModLibrary.mockResolvedValue({
      downloaded: [
        makeEntry({
          displayName: 'Questionable Mod',
          storageId: 'questionable-storage',
          securityScan: {
            state: 'review',
            verified: false,
            disposition: {
              classification: 'Suspicious',
              headline: 'Potentially malicious',
              summary: 'Heuristic checks flagged this download.',
              blockingRecommended: false,
              relatedFindingIds: ['finding-1'],
            },
            highestSeverity: 'High',
            totalFindings: 1,
            threatFamilyCount: 0,
          },
        }),
      ],
    });
    apiMocks.getModSecurityScanReport.mockResolvedValue({
      summary: {
        state: 'review',
        verified: false,
        disposition: {
          classification: 'Suspicious',
          headline: 'Potentially malicious',
          summary: 'Heuristic checks flagged this download.',
          blockingRecommended: false,
          relatedFindingIds: ['finding-1'],
        },
        highestSeverity: 'High',
        totalFindings: 1,
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
    });
    apiMocks.getS1APILatestRelease.mockResolvedValue({
      tag_name: 'v1.0.0',
      name: 'v1.0.0',
      published_at: '2025-01-01',
      prerelease: false,
      download_url: 'https://example.com/s1api.zip',
    });

    renderLibraryOverlay({ libraryTab: 'library' });

    fireEvent.click(await screen.findByRole('button', { name: 'Security Report' }));

    expect(await screen.findByText('Security Findings - Questionable Mod')).toBeTruthy();
  });

  it('forwards downloaded security reports to the workspace page when requested', async () => {
    const onOpenSecurityReport = vi.fn();

    apiMocks.getModLibrary.mockResolvedValue({
      downloaded: [
        makeEntry({
          displayName: 'Questionable Mod',
          storageId: 'questionable-storage',
          securityScan: {
            state: 'review',
            verified: false,
            totalFindings: 1,
            threatFamilyCount: 0,
          },
        }),
      ],
    });
    apiMocks.getModSecurityScanReport.mockResolvedValue({
      summary: {
        state: 'review',
        verified: false,
        totalFindings: 1,
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
    });
    apiMocks.getS1APILatestRelease.mockResolvedValue({
      tag_name: 'v1.0.0',
      name: 'v1.0.0',
      published_at: '2025-01-01',
      prerelease: false,
      download_url: 'https://example.com/s1api.zip',
    });

    renderLibraryOverlay({
      libraryTab: 'library',
      onOpenSecurityReport,
    });

    fireEvent.click(await screen.findByRole('button', { name: 'Security Report' }));

    await waitFor(() => {
      expect(onOpenSecurityReport).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Security Findings - Questionable Mod',
        }),
      );
    });
  });

  it('loads security reports for sibling runtime downloads in the same mod group', async () => {
    apiMocks.getModLibrary.mockResolvedValue({
      downloaded: [
        makeEntry({
          displayName: 'Dual Runtime Mod',
          storageId: 'dual-mono',
          source: 'nexusmods',
          sourceId: '1234',
          sourceVersion: '1.0.0',
          files: ['DualRuntime.Mono.dll'],
          availableRuntimes: ['Mono'],
          storageIdsByRuntime: { Mono: 'dual-mono' },
          installedInByRuntime: { Mono: [] },
          filesByRuntime: { Mono: ['DualRuntime.Mono.dll'] },
          securityScan: {
            state: 'review',
            verified: false,
            highestSeverity: 'Medium',
            totalFindings: 1,
            threatFamilyCount: 0,
          },
        }),
        makeEntry({
          displayName: 'Dual Runtime Mod',
          storageId: 'dual-il2cpp',
          source: 'nexusmods',
          sourceId: '1234',
          sourceVersion: '1.0.0',
          files: ['DualRuntime.IL2CPP.dll'],
          availableRuntimes: ['IL2CPP'],
          storageIdsByRuntime: { IL2CPP: 'dual-il2cpp' },
          installedInByRuntime: { IL2CPP: [] },
          filesByRuntime: { IL2CPP: ['DualRuntime.IL2CPP.dll'] },
          securityScan: {
            state: 'verified',
            verified: true,
            highestSeverity: undefined,
            totalFindings: 0,
            threatFamilyCount: 0,
          },
        }),
      ],
    });
    apiMocks.getModSecurityScanReport.mockImplementation(async (storageId: string) => {
      if (storageId === 'dual-mono') {
        return {
          summary: {
            state: 'review',
            verified: false,
            highestSeverity: 'Medium',
            totalFindings: 1,
            threatFamilyCount: 0,
          },
          policy: {
            enabled: true,
            requiresConfirmation: false,
            blocked: false,
            promptOnHighFindings: false,
            blockCriticalFindings: false,
          },
          files: [
            {
              fileName: 'DualRuntime.Mono.dll',
              displayPath: 'Mods/DualRuntime.Mono.dll',
              totalFindings: 1,
              threatFamilyCount: 0,
              result: {
                findings: [
                  {
                    id: 'mono-finding',
                    severity: 'Medium',
                    description: 'Mono heuristic hit',
                  },
                ],
                input: {
                  sizeBytes: 1024,
                },
              },
            },
          ],
        };
      }

      if (storageId === 'dual-il2cpp') {
        return {
          summary: {
            state: 'verified',
            verified: true,
            highestSeverity: undefined,
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
          files: [
            {
              fileName: 'DualRuntime.IL2CPP.dll',
              displayPath: 'Mods/DualRuntime.IL2CPP.dll',
              totalFindings: 0,
              threatFamilyCount: 0,
              result: {
                findings: [],
                input: {
                  sizeBytes: 2048,
                },
              },
            },
          ],
        };
      }

      return null;
    });
    apiMocks.getS1APILatestRelease.mockResolvedValue({
      tag_name: 'v1.0.0',
      name: 'v1.0.0',
      published_at: '2025-01-01',
      prerelease: false,
      download_url: 'https://example.com/s1api.zip',
    });

    renderLibraryOverlay({ libraryTab: 'library' });

    fireEvent.click(await screen.findByRole('button', { name: 'Security Report' }));

    expect(await screen.findByText('Stored reports')).toBeTruthy();
    expect(screen.getByRole('button', { name: /v1\.0\.0 • Mono/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /v1\.0\.0 • IL2CPP/i })).toBeTruthy();
    expect(apiMocks.getModSecurityScanReport).toHaveBeenCalledWith('dual-mono');
    expect(apiMocks.getModSecurityScanReport).toHaveBeenCalledWith('dual-il2cpp');

    fireEvent.click(screen.getByRole('button', { name: /v1\.0\.0 • IL2CPP/i }));

    expect((await screen.findAllByText('DualRuntime.IL2CPP.dll')).length).toBeGreaterThan(0);
  });

  it('shows downloaded mod details in the preselected inspector state', async () => {
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

    renderLibraryOverlay({ libraryTab: 'library' });

    expect(await screen.findByRole('button', { name: 'Install…' })).toBeTruthy();
    expect(screen.queryByText('Select a mod to review details and actions.')).toBeNull();
    expect(screen.getByRole('button', { name: 'Delete downloaded files' })).toBeTruthy();
  });

  it('does not render unsafe source links for downloaded inspector details', async () => {
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

    renderLibraryOverlay({ libraryTab: 'library' });

    expect(await screen.findByRole('button', { name: 'Install…' })).toBeTruthy();
    expect(screen.queryByText('Select a mod to review details and actions.')).toBeNull();
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

    renderLibraryOverlay({ libraryTab: 'library' });

    fireEvent.click(await screen.findByRole('button', { name: 'Update and activate' }));

    expect(await screen.findByText('Mod Update Failed')).toBeTruthy();
    expect(await screen.findByText(/Could not resolve the latest Thunderstore package/i)).toBeTruthy();
  });

  it('disables update actions when a downloaded mod has no newer remote version', async () => {
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

    renderLibraryOverlay({ libraryTab: 'library' });

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Update and activate' })).toBeDisabled();
    });
  });

  it('offers both Mono and IL2CPP environments for same-version Thunderstore runtime siblings', async () => {
    apiMocks.getEnvironments.mockResolvedValue([
      {
        id: 'env-il2cpp',
        name: 'Main',
        path: 'C:/envs/main',
        branch: 'main',
        runtime: 'IL2CPP',
        modCount: 0,
      },
      {
        id: 'env-mono',
        name: 'Alternate',
        path: 'C:/envs/alternate',
        branch: 'alternate',
        runtime: 'Mono',
        modCount: 0,
      },
    ]);
    apiMocks.getModLibrary.mockResolvedValue({
      downloaded: [
        makeEntry({
          storageId: 'scheduletoolbox-il2cpp',
          displayName: 'ScheduleToolbox',
          source: 'thunderstore',
          sourceId: 'Author/ScheduleToolbox-IL2CPP',
          sourceVersion: '1.2.0-IL2CPP',
          installedVersion: '1.2.0-IL2CPP',
          availableRuntimes: ['IL2CPP'],
          storageIdsByRuntime: { IL2CPP: 'scheduletoolbox-il2cpp' },
          installedInByRuntime: { IL2CPP: [] },
          filesByRuntime: { IL2CPP: ['ScheduleToolbox.IL2CPP.dll'] },
        }),
        makeEntry({
          storageId: 'scheduletoolbox-mono',
          displayName: 'ScheduleToolbox',
          source: 'thunderstore',
          sourceId: 'Author/ScheduleToolbox-Mono',
          sourceVersion: '1.2.0-Mono',
          installedVersion: '1.2.0-Mono',
          availableRuntimes: ['Mono'],
          storageIdsByRuntime: { Mono: 'scheduletoolbox-mono' },
          installedInByRuntime: { Mono: [] },
          filesByRuntime: { Mono: ['ScheduleToolbox.Mono.dll'] },
        }),
      ],
    });

    renderLibraryOverlay({ libraryTab: 'library' });

    fireEvent.click(await screen.findByRole('button', { name: 'Install…' }));

    expect(await screen.findByText('2 compatible environments')).toBeTruthy();
    expect(screen.getByText('Main')).toBeTruthy();
    expect(screen.getByText('Alternate')).toBeTruthy();
    expect(screen.getByText('IL2CPP • main')).toBeTruthy();
    expect(screen.getByText('Mono • alternate')).toBeTruthy();
  });

  it('treats alternate beta environments as Mono install targets in the library dialog', async () => {
    apiMocks.getEnvironments.mockResolvedValue([
      {
        id: 'env-alt-beta',
        name: 'Alternate Beta',
        path: 'C:/envs/alternate-beta',
        branch: 'alternate-beta',
        runtime: 'IL2CPP',
        modCount: 0,
      },
    ]);
    apiMocks.getModLibrary.mockResolvedValue({
      downloaded: [
        makeEntry({
          storageId: 'mono-only-storage',
          displayName: 'Mono Only Mod',
          source: 'nexusmods',
          sourceId: '1234',
          sourceVersion: '1.0.0',
          installedVersion: '1.0.0',
          availableRuntimes: ['Mono'],
          storageIdsByRuntime: { Mono: 'mono-only-storage' },
          installedInByRuntime: { Mono: [] },
          filesByRuntime: { Mono: ['MonoOnlyMod.dll'] },
        }),
      ],
    });

    renderLibraryOverlay({ libraryTab: 'library' });

    fireEvent.click(await screen.findByRole('button', { name: 'Install…' }));

    await waitFor(() => {
      expect(apiMocks.installDownloadedMod).toHaveBeenCalledWith(
        'mono-only-storage',
        ['env-alt-beta'],
      );
    });
  });

  it('shows already-installed compatible environments in a read-only install dialog', async () => {
    apiMocks.getEnvironments.mockResolvedValue([
      {
        id: 'env-mono',
        name: 'Alternate',
        path: 'C:/envs/alternate',
        branch: 'alternate',
        runtime: 'Mono',
        modCount: 1,
      },
    ]);
    apiMocks.getModLibrary.mockResolvedValue({
      downloaded: [
        makeEntry({
          storageId: 'mono-installed-storage',
          displayName: 'Installed Mono Mod',
          source: 'nexusmods',
          sourceId: '5678',
          sourceVersion: '1.0.0',
          installedVersion: '1.0.0',
          availableRuntimes: ['Mono'],
          installedIn: ['env-mono'],
          storageIdsByRuntime: { Mono: 'mono-installed-storage' },
          installedInByRuntime: { Mono: ['env-mono'] },
          filesByRuntime: { Mono: ['InstalledMonoMod.dll'] },
        }),
      ],
    });

    renderLibraryOverlay({ libraryTab: 'library' });

    expect(await screen.findByRole('button', { name: 'Install to more…' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Install to more…' }));

    expect(await screen.findByText('This version is already installed in every compatible environment.')).toBeTruthy();
    expect(screen.getByText('Alternate')).toBeTruthy();
    expect(screen.getByText('Mono • alternate • already installed')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Already installed' })).toBeDisabled();
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

    renderLibraryOverlay({ libraryTab: 'library' });

    fireEvent.change(await screen.findByLabelText('Available versions'), {
      target: { value: 'storage-old' },
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Activate selected version' }));

    await waitFor(() => {
      expect(apiMocks.uninstallDownloadedMod).toHaveBeenCalledWith('storage-new', ['env-1']);
    });
    await waitFor(() => {
      expect(apiMocks.installDownloadedMod).toHaveBeenCalledWith('storage-old', ['env-1']);
    });
  });
});
