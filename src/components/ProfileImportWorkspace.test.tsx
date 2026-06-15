import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProfileImportWorkspace } from './ProfileImportWorkspace';

const storeMocks = vi.hoisted(() => ({
  useEnvironmentStore: vi.fn(),
}));

const apiMocks = vi.hoisted(() => ({
  previewModProfileImport: vi.fn(),
  applyModProfileImport: vi.fn(),
  readModProfileFile: vi.fn(),
  getNexusOAuthStatus: vi.fn(),
  searchThunderstore: vi.fn(),
  downloadThunderstoreToLibrary: vi.fn(),
  downloadS1APIToLibrary: vi.fn(),
  downloadMLVScanToLibrary: vi.fn(),
  searchNexusMods: vi.fn(),
  getNexusModsModFiles: vi.fn(),
  downloadNexusModToLibrary: vi.fn(),
  beginNexusManualDownloadSession: vi.fn(),
}));

const dialogMocks = vi.hoisted(() => ({
  open: vi.fn(),
}));

vi.mock('../stores/environmentStore', () => ({
  useEnvironmentStore: storeMocks.useEnvironmentStore,
}));

vi.mock('../services/api', () => ({
  ApiService: apiMocks,
}));

vi.mock('@tauri-apps/plugin-dialog', () => dialogMocks);

const manifest = {
  schemaVersion: 1,
  kind: 'simm.profile',
  profile: {
    name: 'Co-op Main',
    game: 'schedule-i',
    runtime: 'Mono',
    branch: 'alternate',
    exportedAt: '2026-05-31T00:00:00Z',
  },
  items: [
    {
      itemType: 'mod',
      name: 'CustomTV',
      required: true,
      enabled: true,
      source: 'thunderstore',
      sourceId: 'CustomTV/CustomTV',
      sourceVersion: '1.6.4',
      runtime: 'Mono',
    },
  ],
};

const plan = {
  profile: manifest.profile,
  targetEnvironmentId: 'env-1',
  items: [
    {
      item: manifest.items[0],
      status: 'readyToInstall',
      resolvedStorageId: 'storage-1',
      message: 'Downloaded library entry is ready to install.',
    },
  ],
  summary: {
    total: 1,
    alreadyInstalled: 0,
    readyToInstall: 1,
    needsDownload: 0,
    manualRequired: 0,
    runtimeMismatches: 0,
    unsupported: 0,
  },
};

const needsDownloadPlan = {
  ...plan,
  items: [
    {
      item: manifest.items[0],
      status: 'needsDownload',
      resolvedStorageId: null,
      message: 'Supported source is known, but the matching version is not downloaded yet.',
    },
  ],
  summary: {
    total: 1,
    alreadyInstalled: 0,
    readyToInstall: 0,
    needsDownload: 1,
    manualRequired: 0,
    runtimeMismatches: 0,
    unsupported: 0,
  },
};

const thunderstorePackage = {
  uuid4: 'customtv-package',
  owner: 'CustomTV',
  name: 'CustomTV',
  package_url: 'https://thunderstore.io/c/schedule-i/p/CustomTV/CustomTV/',
  versions: [
    {
      uuid4: 'customtv-version-164',
      version_number: '1.6.4',
    },
  ],
};

const nexusManifest = {
  ...manifest,
  items: [
    {
      itemType: 'mod',
      name: 'Nexus Only',
      required: true,
      enabled: true,
      source: 'nexusmods',
      sourceId: '123',
      sourceVersion: '2.0.0',
      nexusFileId: '456',
      runtime: 'Mono',
    },
  ],
};

const nexusNeedsDownloadPlan = {
  ...needsDownloadPlan,
  items: [
    {
      item: nexusManifest.items[0],
      status: 'needsDownload',
      resolvedStorageId: null,
      message: 'Supported source is known, but the matching version is not downloaded yet.',
    },
  ],
};

const nexusThunderstorePackage = {
  uuid4: 'nexus-only-package',
  owner: 'NexusTeam',
  name: 'Nexus_Only',
  package_url: 'https://thunderstore.io/c/schedule-i/p/NexusTeam/Nexus_Only/',
  versions: [
    {
      uuid4: 'nexus-only-version-200',
      version_number: '2.0.0',
    },
  ],
};

describe('ProfileImportWorkspace', () => {
  beforeEach(() => {
    storeMocks.useEnvironmentStore.mockReturnValue({
      environments: [
        {
          id: 'env-1',
          name: 'Mono Env',
          branch: 'alternate',
          runtime: 'Mono',
          status: 'completed',
        },
      ],
    });
    apiMocks.previewModProfileImport.mockResolvedValue(plan);
    apiMocks.applyModProfileImport.mockResolvedValue({
      plan,
      installed: 1,
      skipped: 0,
      unresolved: 0,
      messages: [],
    });
    apiMocks.readModProfileFile.mockResolvedValue(manifest);
    apiMocks.getNexusOAuthStatus.mockResolvedValue({
      connected: false,
      account: { isPremium: false, canDirectDownload: false },
    });
    apiMocks.searchThunderstore.mockResolvedValue({ packages: [] });
    apiMocks.downloadThunderstoreToLibrary.mockResolvedValue({
      success: true,
      storageId: 'storage-downloaded',
    });
    apiMocks.searchNexusMods.mockResolvedValue({ mods: [] });
    apiMocks.getNexusModsModFiles.mockResolvedValue([]);
    apiMocks.downloadNexusModToLibrary.mockResolvedValue({
      success: true,
      storageId: 'nexus-storage',
    });
    apiMocks.beginNexusManualDownloadSession.mockResolvedValue({
      success: true,
      kind: 'install',
      filesPageUrl: 'https://www.nexusmods.com/schedule1/mods/1?tab=files',
      modId: 1,
      fileId: 2,
      gameId: 'schedule1',
    });
    dialogMocks.open.mockResolvedValue('C:\\Profiles\\coop.json');
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('previews pasted profile JSON against the selected environment', async () => {
    render(<ProfileImportWorkspace />);

    fireEvent.change(screen.getByPlaceholderText(/paste a simm profile/i), {
      target: { value: JSON.stringify(manifest) },
    });
    fireEvent.click(screen.getByRole('button', { name: /preview/i }));

    await waitFor(() => {
      expect(apiMocks.previewModProfileImport).toHaveBeenCalledWith(manifest, 'env-1');
    });
    expect(await screen.findByText('CustomTV')).toBeInTheDocument();
    expect(screen.getAllByText('Ready').length).toBeGreaterThan(0);
  });

  it('applies ready profile items after preview', async () => {
    render(<ProfileImportWorkspace />);

    fireEvent.change(screen.getByPlaceholderText(/paste a simm profile/i), {
      target: { value: JSON.stringify(manifest) },
    });
    fireEvent.click(screen.getByRole('button', { name: /preview/i }));
    await screen.findByText('CustomTV');
    fireEvent.click(screen.getByRole('button', { name: /download & apply/i }));

    await waitFor(() => {
      expect(apiMocks.applyModProfileImport).toHaveBeenCalledWith({
        manifest,
        targetEnvironmentId: 'env-1',
      });
    });
    expect(await screen.findByText('Installed 1; 0 unresolved.')).toBeInTheDocument();
  });

  it('downloads a missing Thunderstore profile item before applying it', async () => {
    apiMocks.previewModProfileImport.mockResolvedValue(needsDownloadPlan);
    apiMocks.searchThunderstore.mockResolvedValue({ packages: [thunderstorePackage] });
    render(<ProfileImportWorkspace />);

    fireEvent.change(screen.getByPlaceholderText(/paste a simm profile/i), {
      target: { value: JSON.stringify(manifest) },
    });
    fireEvent.click(screen.getByRole('button', { name: /preview/i }));
    await screen.findByText('Download needed');
    fireEvent.click(screen.getByRole('button', { name: /download & apply/i }));

    await waitFor(() => {
      expect(apiMocks.downloadThunderstoreToLibrary).toHaveBeenCalledWith(
        'customtv-package',
        'Mono',
        undefined,
        'customtv-version-164',
      );
    });
    expect(apiMocks.applyModProfileImport).toHaveBeenCalledWith({
      manifest: expect.objectContaining({
        items: [
          expect.objectContaining({
            source: 'thunderstore',
            sourceId: 'CustomTV/CustomTV',
            sourceVersion: '1.6.4',
            storageId: 'storage-downloaded',
          }),
        ],
      }),
      targetEnvironmentId: 'env-1',
    });
  });

  it('marks searched profile items red when no downloadable match is found', async () => {
    apiMocks.previewModProfileImport.mockResolvedValue(needsDownloadPlan);
    apiMocks.searchThunderstore.mockResolvedValue({ packages: [] });
    apiMocks.searchNexusMods.mockResolvedValue({ mods: [] });
    render(<ProfileImportWorkspace />);

    fireEvent.change(screen.getByPlaceholderText(/paste a simm profile/i), {
      target: { value: JSON.stringify(manifest) },
    });
    fireEvent.click(screen.getByRole('button', { name: /preview/i }));

    expect(await screen.findByText('No match found')).toBeInTheDocument();
    expect(screen.getByText('No match found').closest('article')).toHaveClass('profile-workspace__item--noMatchFound');
  });

  it('uses a matching Thunderstore version for non-premium Nexus profile items', async () => {
    apiMocks.previewModProfileImport.mockResolvedValue(nexusNeedsDownloadPlan);
    apiMocks.searchThunderstore.mockResolvedValue({ packages: [nexusThunderstorePackage] });
    render(<ProfileImportWorkspace />);

    fireEvent.change(screen.getByPlaceholderText(/paste a simm profile/i), {
      target: { value: JSON.stringify(nexusManifest) },
    });
    fireEvent.click(screen.getByRole('button', { name: /preview/i }));
    await screen.findByText(/matched NexusTeam\/Nexus_Only on Thunderstore/i);
    fireEvent.click(screen.getByRole('button', { name: /download & apply/i }));

    await waitFor(() => {
      expect(apiMocks.downloadThunderstoreToLibrary).toHaveBeenCalledWith(
        'nexus-only-package',
        'Mono',
        undefined,
        'nexus-only-version-200',
      );
    });
    expect(apiMocks.applyModProfileImport).toHaveBeenCalledWith({
      manifest: expect.objectContaining({
        items: [
          expect.objectContaining({
            source: 'thunderstore',
            sourceId: 'NexusTeam/Nexus_Only',
            sourceVersion: '2.0.0',
            storageId: 'storage-downloaded',
          }),
        ],
      }),
      targetEnvironmentId: 'env-1',
    });
  });

  it('starts a one-at-a-time Nexus manual import for non-premium matches', async () => {
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);
    apiMocks.previewModProfileImport.mockResolvedValue(nexusNeedsDownloadPlan);
    render(<ProfileImportWorkspace />);

    fireEvent.change(screen.getByPlaceholderText(/paste a simm profile/i), {
      target: { value: JSON.stringify(nexusManifest) },
    });
    fireEvent.click(screen.getByRole('button', { name: /preview/i }));
    fireEvent.click(await screen.findByRole('button', { name: /start nexus import/i }));

    await waitFor(() => {
      expect(apiMocks.beginNexusManualDownloadSession).toHaveBeenCalledWith({
        kind: 'install',
        modId: 123,
        fileId: 456,
        gameId: 'schedule1',
        environmentId: 'env-1',
        runtime: 'Mono',
      });
    });
    expect(openSpy).toHaveBeenCalledWith(
      'https://www.nexusmods.com/schedule1/mods/1?tab=files',
      '_blank',
      'noopener,noreferrer',
    );
    openSpy.mockRestore();
  });

  it('loads and previews a selected profile JSON file', async () => {
    render(<ProfileImportWorkspace />);

    fireEvent.click(screen.getByRole('button', { name: /choose profile json/i }));

    await waitFor(() => {
      expect(dialogMocks.open).toHaveBeenCalledWith({
        multiple: false,
        filters: [{ name: 'SIMM Profile', extensions: ['json'] }],
      });
      expect(apiMocks.readModProfileFile).toHaveBeenCalledWith('C:\\Profiles\\coop.json');
      expect(apiMocks.previewModProfileImport).toHaveBeenCalledWith(manifest, 'env-1');
    });
    expect(await screen.findByText('CustomTV')).toBeInTheDocument();
  });
});
