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
  getModSecurityScanReport: vi.fn(),
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
    apiMocks.getModSecurityScanReport.mockReset();
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
    apiMocks.getModSecurityScanReport.mockResolvedValue(null);
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

  it('renders MLVScan disposition badges for installed mods', async () => {
    apiMocks.getMods.mockResolvedValue({
      mods: [
        {
          name: 'Trusted Mod',
          fileName: 'Trusted.Mod.dll',
          path: 'C:/env/Mods/Trusted.Mod.dll',
          source: 'github',
          managed: true,
          disabled: false,
          securityScan: {
            state: 'verified',
            verified: true,
            disposition: {
              classification: 'Clean',
              headline: 'Safe',
              summary: 'No malicious indicators were identified.',
              blockingRecommended: false,
              relatedFindingIds: [],
            },
            totalFindings: 0,
            threatFamilyCount: 0,
          },
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

    expect(await screen.findByText('Safe')).toBeTruthy();
  });

  it('opens the security report overlay for installed mods', async () => {
    apiMocks.getMods.mockResolvedValue({
      mods: [
        {
          name: 'Trusted Mod',
          fileName: 'Trusted.Mod.dll',
          path: 'C:/env/Mods/Trusted.Mod.dll',
          source: 'github',
          managed: true,
          disabled: false,
          modStorageId: 'trusted-storage',
          securityScan: {
            state: 'verified',
            verified: true,
            disposition: {
              classification: 'Clean',
              headline: 'Safe',
              summary: 'No malicious indicators were identified.',
              blockingRecommended: false,
              relatedFindingIds: [],
            },
            totalFindings: 0,
            threatFamilyCount: 0,
          },
        },
      ],
      modsDirectory: 'C:/env/Mods',
      count: 1,
    });
    apiMocks.getModSecurityScanReport.mockResolvedValue({
      summary: {
        state: 'verified',
        verified: true,
        disposition: {
          classification: 'Clean',
          headline: 'Safe',
          summary: 'No malicious indicators were identified.',
          blockingRecommended: false,
          relatedFindingIds: [],
        },
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
      files: [],
    });

    render(
      <ModsOverlay
        isOpen={true}
        onClose={() => {}}
        environmentId="env-1"
      />
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Security Report' }));

    expect(await screen.findByText('Security Report - Trusted Mod')).toBeTruthy();
  });

  it('forwards security reports to the workspace page when requested', async () => {
    const onOpenSecurityReport = vi.fn();

    apiMocks.getMods.mockResolvedValue({
      mods: [
        {
          name: 'Trusted Mod',
          fileName: 'Trusted.Mod.dll',
          path: 'C:/env/Mods/Trusted.Mod.dll',
          source: 'github',
          managed: true,
          disabled: false,
          modStorageId: 'trusted-storage',
          securityScan: {
            state: 'verified',
            verified: true,
            totalFindings: 0,
            threatFamilyCount: 0,
          },
        },
      ],
      modsDirectory: 'C:/env/Mods',
      count: 1,
    });
    apiMocks.getModSecurityScanReport.mockResolvedValue({
      summary: {
        state: 'verified',
        verified: true,
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
      files: [],
    });

    render(
      <ModsOverlay
        isOpen={true}
        onClose={() => {}}
        environmentId="env-1"
        onOpenSecurityReport={onOpenSecurityReport}
      />
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Security Report' }));

    await waitFor(() => {
      expect(onOpenSecurityReport).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Security Report - Trusted Mod',
        }),
      );
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

  it('uploads multiple selected files in order and refreshes collections once after the batch completes', async () => {
    openMock.mockResolvedValueOnce([
      'C:/mods/Alpha-Mono.zip',
      { path: 'C:/mods/Beta-IL2CPP.rar', name: 'Beta-IL2CPP.rar' },
    ]);
    apiMocks.uploadMod.mockResolvedValue({ success: true });
    const onModsChanged = vi.fn();

    render(
      <ModsOverlay
        isOpen={true}
        onClose={() => {}}
        environmentId="env-1"
        onModsChanged={onModsChanged}
      />
    );

    await waitFor(() => {
      expect(apiMocks.getMods).toHaveBeenCalled();
      expect(apiMocks.getModLibrary).toHaveBeenCalled();
      expect(apiMocks.getModUpdatesSummary).toHaveBeenCalled();
    });

    const initialModsCalls = apiMocks.getMods.mock.calls.length;
    const initialLibraryCalls = apiMocks.getModLibrary.mock.calls.length;
    const initialUpdateSummaryCalls = apiMocks.getModUpdatesSummary.mock.calls.length;

    fireEvent.click(await screen.findByRole('button', { name: 'Upload Mod' }));

    await waitFor(() => {
      expect(apiMocks.uploadMod).toHaveBeenNthCalledWith(
        1,
        'env-1',
        'C:/mods/Alpha-Mono.zip',
        'Alpha-Mono.zip',
        'IL2CPP',
        expect.objectContaining({ detectedRuntime: 'Mono', source: 'unknown' }),
        false,
      );
      expect(apiMocks.uploadMod).toHaveBeenNthCalledWith(
        2,
        'env-1',
        'C:/mods/Beta-IL2CPP.rar',
        'Beta-IL2CPP.rar',
        'IL2CPP',
        expect.objectContaining({ detectedRuntime: 'IL2CPP', source: 'unknown' }),
        false,
      );
    });

    await waitFor(() => {
      expect(apiMocks.getMods.mock.calls.length).toBe(initialModsCalls + 1);
      expect(apiMocks.getModLibrary.mock.calls.length).toBe(initialLibraryCalls + 1);
      expect(apiMocks.getModUpdatesSummary.mock.calls.length).toBe(initialUpdateSummaryCalls + 1);
      expect(onModsChanged).toHaveBeenCalledTimes(1);
    });

    expect((await screen.findAllByText(/Upload batch finished: 2 succeeded, 0 failed, 0 skipped\./i)).length).toBeGreaterThan(0);
  });

  it('skips an unresolved file when runtime selection is canceled and continues with the remaining uploads', async () => {
    openMock.mockResolvedValueOnce([
      'C:/mods/UnknownArchive.zip',
      'C:/mods/Known-Mono.dll',
    ]);
    apiMocks.uploadMod.mockResolvedValue({ success: true });

    render(
      <ModsOverlay
        isOpen={true}
        onClose={() => {}}
        environmentId="env-1"
      />
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Upload Mod' }));

    expect(await screen.findByText('Select Mod Runtime')).toBeTruthy();
    fireEvent.click(document.querySelector('.modal-close') as HTMLElement);

    await waitFor(() => {
      expect(apiMocks.uploadMod).toHaveBeenCalledTimes(1);
      expect(apiMocks.uploadMod).toHaveBeenCalledWith(
        'env-1',
        'C:/mods/Known-Mono.dll',
        'Known-Mono.dll',
        'IL2CPP',
        expect.objectContaining({ detectedRuntime: 'Mono', source: 'unknown' }),
        false,
      );
    });

    expect((await screen.findAllByText(/Upload batch finished: 1 succeeded, 0 failed, 1 skipped\./i)).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Skipped: UnknownArchive\.zip \(Runtime selection canceled\.\)/i).length).toBeGreaterThan(0);
  });

  it('continues after an upload failure and reports the failed file in the batch summary', async () => {
    openMock.mockResolvedValueOnce([
      'C:/mods/First-Mono.dll',
      'C:/mods/Second-IL2CPP.zip',
    ]);
    apiMocks.uploadMod
      .mockResolvedValueOnce({ success: false, error: 'broken archive' })
      .mockResolvedValueOnce({ success: true });

    render(
      <ModsOverlay
        isOpen={true}
        onClose={() => {}}
        environmentId="env-1"
      />
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Upload Mod' }));

    await waitFor(() => {
      expect(apiMocks.uploadMod).toHaveBeenCalledTimes(2);
    });

    expect((await screen.findAllByText(/Upload batch finished: 1 succeeded, 1 failed, 0 skipped\./i)).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Failed: First-Mono\.dll \(broken archive\)/i).length).toBeGreaterThan(0);
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

