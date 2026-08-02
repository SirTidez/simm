import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ApiService } from './api';
import { invoke } from '@tauri-apps/api/core';
import type { ModProfileManifest } from '../types';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

const invokeMock = vi.mocked(invoke);

describe('ApiService', () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  it('saveSettings passes updates and returns success', async () => {
    invokeMock.mockResolvedValueOnce(undefined);
    const result = await ApiService.saveSettings({ theme: 'dark' });

    expect(invokeMock).toHaveBeenCalledWith('save_settings', {
      updates: { theme: 'dark' },
    });
    expect(result).toEqual({ success: true });
  });

  it('backupDatabase returns created backup path', async () => {
    invokeMock.mockResolvedValueOnce('C:/Users/Test/SIMM/backups/SIMM-db-backup-manual-20260326-034426.db');
    const result = await ApiService.backupDatabase();

    expect(invokeMock).toHaveBeenCalledWith('backup_database');
    expect(result).toEqual({
      success: true,
      path: 'C:/Users/Test/SIMM/backups/SIMM-db-backup-manual-20260326-034426.db',
    });
  });

  it('coalesces concurrent mod library requests', async () => {
    let resolveLibrary: (value: { downloaded: [] }) => void = () => {};
    invokeMock.mockReturnValueOnce(new Promise((resolve) => {
      resolveLibrary = resolve;
    }));

    const firstRequest = ApiService.getModLibrary();
    const secondRequest = ApiService.getModLibrary();

    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledWith('get_mod_library');

    resolveLibrary({ downloaded: [] });

    await expect(Promise.all([firstRequest, secondRequest])).resolves.toEqual([
      { downloaded: [] },
      { downloaded: [] },
    ]);

    invokeMock.mockResolvedValueOnce({ downloaded: [] });
    await ApiService.getModLibrary();

    expect(invokeMock).toHaveBeenCalledTimes(2);
  });

  it('checkAppUpdate forwards the selected channel to the backend', async () => {
    invokeMock.mockResolvedValueOnce({
      currentVersion: '0.7.8',
      version: '0.7.9-beta',
      versionNormalized: '0.7.9',
      updateAvailable: true,
      notes: 'Patch notes',
      channel: 'beta',
      manifestUrl: 'https://raw.githubusercontent.com/SirTidez/simm/main/updater/beta/latest-beta.json',
      checkedAt: '2026-03-27T12:00:00Z',
    });

    const result = await ApiService.checkAppUpdate('beta');

    expect(invokeMock).toHaveBeenCalledWith('check_app_update', {
      channel: 'beta',
    });
    expect(result.updateAvailable).toBe(true);
    expect(result.versionNormalized).toBe('0.7.9');
    expect(result.channel).toBe('beta');
  });

  it('installAppUpdate forwards the selected channel to the backend', async () => {
    invokeMock.mockResolvedValueOnce({
      installed: true,
      version: '0.7.9',
      channel: 'stable',
    });

    const result = await ApiService.installAppUpdate('stable');

    expect(invokeMock).toHaveBeenCalledWith('install_app_update', {
      channel: 'stable',
    });
    expect(result).toEqual({
      installed: true,
      version: '0.7.9',
      channel: 'stable',
    });
  });

  it('deleteEnvironment wraps boolean response', async () => {
    invokeMock.mockResolvedValueOnce(true);
    const result = await ApiService.deleteEnvironment('env-1');

    expect(invokeMock).toHaveBeenCalledWith('delete_environment', { id: 'env-1' });
    expect(result).toEqual({ success: true });
  });

  it('profile commands use the environment profile IPC contract', async () => {
    const manifest: ModProfileManifest = {
      schemaVersion: 1,
      kind: 'simm.profile',
      profile: {
        name: 'Co-op',
        game: 'schedule-i',
        runtime: 'Mono',
        branch: 'alternate',
        exportedAt: '2026-05-31T00:00:00Z',
      },
      items: [],
    };
    const plan = {
      profile: manifest.profile,
      targetEnvironmentId: 'env-2',
      items: [],
      summary: {
        total: 0,
        alreadyInstalled: 0,
        readyToInstall: 0,
        needsDownload: 0,
        manualRequired: 0,
        runtimeMismatches: 0,
        unsupported: 0,
      },
    };

    invokeMock.mockResolvedValueOnce(manifest);
    invokeMock.mockResolvedValueOnce(undefined);
    invokeMock.mockResolvedValueOnce(manifest);
    invokeMock.mockResolvedValueOnce(plan);
    invokeMock.mockResolvedValueOnce({ plan, installed: 0, skipped: 0, unresolved: 0, messages: [] });

    await ApiService.exportEnvironmentProfile('env-1');
    await ApiService.saveModProfileFile(manifest, 'C:\\Profiles\\coop.json');
    await ApiService.readModProfileFile('C:\\Profiles\\coop.json');
    await ApiService.previewModProfileImport(manifest, 'env-2');
    await ApiService.applyModProfileImport({ manifest, targetEnvironmentId: 'env-2' });

    expect(invokeMock).toHaveBeenNthCalledWith(1, 'export_environment_profile', { environmentId: 'env-1' });
    expect(invokeMock).toHaveBeenNthCalledWith(2, 'save_mod_profile_file', {
      manifest,
      destination: 'C:\\Profiles\\coop.json',
    });
    expect(invokeMock).toHaveBeenNthCalledWith(3, 'read_mod_profile_file', {
      source: 'C:\\Profiles\\coop.json',
    });
    expect(invokeMock).toHaveBeenNthCalledWith(4, 'preview_mod_profile_import', {
      manifest,
      targetEnvironmentId: 'env-2',
    });
    expect(invokeMock).toHaveBeenNthCalledWith(5, 'apply_mod_profile_import', {
      request: { manifest, targetEnvironmentId: 'env-2' },
    });
  });

  it('getProgress throws when download is missing', async () => {
    invokeMock.mockResolvedValueOnce(null);

    await expect(ApiService.getProgress('download-1')).rejects.toThrow('Download not found');
    expect(invokeMock).toHaveBeenCalledWith('get_download_progress', {
      downloadId: 'download-1',
    });
  });

  it('uses a Steam account and game slot for explicit Schedule I save management', async () => {
    const restorePreview = {
      steamId: '76561198000000000',
      slotNumber: 2,
      sourceLabel: 'Game backup',
      sourcePath: 'C:/Users/Test/AppData/LocalLow/TVGS/Schedule I/Saves/76561198000000000/backups/SaveGame_2',
      current: {
        slotNumber: 2, organizationName: 'Current', cashBalance: 100, onlineBalance: 200, netWorth: 300,
        rank: 2, tier: 1, totalXp: 250, createdAt: null, lastPlayedAt: null, lastSaveVersion: null,
        path: 'C:/Saves/SaveGame_2', exists: true, sizeBytes: 64, lastModified: null, backup: null, backups: [],
      },
      restored: {
        slotNumber: 2, organizationName: 'Backup', cashBalance: 80, onlineBalance: 180, netWorth: 260,
        rank: 2, tier: 1, totalXp: 220, createdAt: null, lastPlayedAt: null, lastSaveVersion: null,
        path: 'C:/Saves/backups/SaveGame_2', exists: true, sizeBytes: 64, lastModified: null, backup: null, backups: [],
      },
    };
    invokeMock
      .mockResolvedValueOnce({
        available: true,
        sourcePath: 'C:/Users/Test/AppData/LocalLow/TVGS/Schedule I/Saves',
        accounts: [],
        message: null,
      })
      .mockResolvedValueOnce({
        steamId: '76561198000000000',
        slotNumber: 2,
          backup: {
            path: 'C:/Users/Test/AppData/LocalLow/TVGS/Schedule I/Saves/76561198000000000/backups/SaveGame_2',
            sizeBytes: 64,
            lastModified: '2026-07-25T12:00:00Z',
          },
          prunedBackupCount: 0,
      })
      .mockResolvedValueOnce({
        steamId: '76561198000000000',
        slotNumber: 2,
        path: 'C:/Backups/schedule-i-save-2.zip',
        sizeBytes: 512,
      })
      .mockResolvedValueOnce({
        ...restorePreview,
      })
      .mockResolvedValueOnce({
        steamId: '76561198000000000',
        slotNumber: 2,
        path: 'C:/Users/Test/AppData/LocalLow/TVGS/Schedule I/Saves/76561198000000000/SaveGame_2',
        sizeBytes: 64,
      })
      .mockResolvedValueOnce({
        ...restorePreview,
        sourceLabel: 'ZIP: schedule-i-save-2.zip',
        sourcePath: 'C:/Backups/schedule-i-save-2.zip',
      })
      .mockResolvedValueOnce({
        steamId: '76561198000000000',
        slotNumber: 2,
        path: 'C:/Users/Test/AppData/LocalLow/TVGS/Schedule I/Saves/76561198000000000/SaveGame_2',
        sizeBytes: 64,
      });

    await ApiService.getGameSaveBackupStatus();
    await ApiService.createGameSaveBackup('76561198000000000', 2, 5);
    await ApiService.exportGameSaveBackup('76561198000000000', 2, 'C:/Backups/schedule-i-save-2.zip');
    await ApiService.previewGameSaveBackupRestore('76561198000000000', 2, restorePreview.sourcePath);
    await ApiService.restoreGameSaveBackup('76561198000000000', 2, restorePreview.sourcePath);
    await ApiService.previewGameSaveZipRestore('76561198000000000', 2, 'C:/Backups/schedule-i-save-2.zip');
    await ApiService.restoreGameSaveFromZip('76561198000000000', 2, 'C:/Backups/schedule-i-save-2.zip');

    expect(invokeMock).toHaveBeenNthCalledWith(1, 'get_game_save_backup_status');
    expect(invokeMock).toHaveBeenNthCalledWith(2, 'create_game_save_backup', {
      steamId: '76561198000000000',
      slotNumber: 2,
      retentionLimit: 5,
    });
    expect(invokeMock).toHaveBeenNthCalledWith(3, 'export_game_save_backup', {
      steamId: '76561198000000000',
      slotNumber: 2,
      destinationPath: 'C:/Backups/schedule-i-save-2.zip',
    });
    expect(invokeMock).toHaveBeenNthCalledWith(4, 'preview_game_save_backup_restore', {
      steamId: '76561198000000000',
      slotNumber: 2,
      backupPath: restorePreview.sourcePath,
    });
    expect(invokeMock).toHaveBeenNthCalledWith(5, 'restore_game_save_backup', {
      steamId: '76561198000000000',
      slotNumber: 2,
      backupPath: restorePreview.sourcePath,
    });
    expect(invokeMock).toHaveBeenNthCalledWith(6, 'preview_game_save_zip_restore', {
      steamId: '76561198000000000',
      slotNumber: 2,
      zipPath: 'C:/Backups/schedule-i-save-2.zip',
    });
    expect(invokeMock).toHaveBeenNthCalledWith(7, 'restore_game_save_from_zip', {
      steamId: '76561198000000000',
      slotNumber: 2,
      zipPath: 'C:/Backups/schedule-i-save-2.zip',
    });
  });

  it('uses the reviewed telemetry upload IPC contract', async () => {
    const preview = {
      uploadId: '00000000-0000-4000-8000-000000000001',
      payload: '{"schemaVersion":1,"sessions":[]}',
      sessionCount: 0,
      eventCount: 0,
      exclusions: ['Active sessions are excluded.'],
    };
    const receipt = {
      id: 'queue-1', uploadId: '00000000-0000-4000-8000-000000000001',
      state: 'failed' as const, attempts: 1, lastErrorCode: 'failed_before_acceptance',
      createdAt: '2026-07-14T00:00:00Z', updatedAt: '2026-07-14T00:00:00Z',
    };
    invokeMock.mockResolvedValueOnce(preview).mockResolvedValueOnce(receipt).mockResolvedValueOnce([receipt]).mockResolvedValueOnce(receipt);

    await ApiService.previewTelemetryUpload('env-1');
    await ApiService.queueTelemetryUpload(preview.payload);
    await ApiService.listTelemetryUploads();
    await ApiService.retryTelemetryUpload('queue-1');

    expect(receipt).not.toHaveProperty('payload');

    expect(invokeMock).toHaveBeenNthCalledWith(1, 'preview_telemetry_upload', { environmentId: 'env-1' });
    expect(invokeMock).toHaveBeenNthCalledWith(2, 'queue_telemetry_upload', { previewPayload: preview.payload });
    expect(invokeMock).toHaveBeenNthCalledWith(3, 'list_telemetry_uploads');
    expect(invokeMock).toHaveBeenNthCalledWith(4, 'retry_telemetry_upload', { id: 'queue-1' });
  });

  it('uses the telemetry mod-rule IPC contract with an explicit scope', async () => {
    invokeMock.mockResolvedValueOnce([]).mockResolvedValueOnce(undefined);

    await ApiService.listTelemetryModPolicies('env-1');
    await ApiService.saveTelemetryModRule({
      modKey: 'mod-development',
      environmentId: 'env-1',
      mode: 'local_only',
    });

    expect(invokeMock).toHaveBeenNthCalledWith(1, 'list_telemetry_mod_policies', { environmentId: 'env-1' });
    expect(invokeMock).toHaveBeenNthCalledWith(2, 'save_telemetry_mod_rule', {
      update: { modKey: 'mod-development', environmentId: 'env-1', mode: 'local_only' },
    });
  });

  it('searchNexusMods transforms response fields', async () => {
    invokeMock.mockResolvedValueOnce([
      {
        modId: 1,
        name: 'Test Mod',
        summary: 'Summary',
        pictureUrl: 'pic.png',
        thumbnailUrl: 'thumb.png',
        endorsements: 12,
        downloads: 34,
        version: '1.0.0',
        author: 'OriginalCreator',
        uploader: {
          name: 'ActualUploader',
          memberId: 99,
        },
        updatedAt: '2024-01-01',
        createdAt: '2023-01-01',
      },
    ]);

    const result = await ApiService.searchNexusMods('3164500', 'test');
    expect(result.mods[0]).toEqual(
      expect.objectContaining({
        mod_id: 1,
        picture_url: 'pic.png',
        thumbnail_url: 'thumb.png',
        endorsement_count: 12,
        mod_downloads: 34,
        author: 'ActualUploader',
        uploader: 'ActualUploader',
        uploader_member_id: 99,
        original_author: 'OriginalCreator',
        updated_at: '2024-01-01',
        created_at: '2023-01-01',
      })
    );
  });

  it('searchNexusMods preserves legacy snake_case date fields', async () => {
    invokeMock.mockResolvedValueOnce([
      {
        mod_id: 2,
        name: 'Legacy Mod',
        summary: 'Summary',
        picture_url: 'legacy-pic.png',
        thumbnail_url: 'legacy-thumb.png',
        endorsement_count: 8,
        mod_downloads: 21,
        unique_downloads: 18,
        version: '2.0.0',
        author: 'LegacyTester',
        updated_time: '2025-05-06T12:00:00Z',
        uploaded_time: '2025-04-01T12:00:00Z',
      },
    ]);

    const result = await ApiService.searchNexusMods('3164500', 'legacy');
    expect(result.mods[0]).toEqual(
      expect.objectContaining({
        mod_id: 2,
        updated_at: '2025-05-06T12:00:00Z',
        updated_time: '2025-05-06T12:00:00Z',
        created_at: '2025-04-01T12:00:00Z',
        uploaded_time: '2025-04-01T12:00:00Z',
      }),
    );
  });

  it('gets published Nexus dependencies for a selected file', async () => {
    const dependencies = {
      sourceVersionId: 'version-1',
      requirements: [],
    };
    invokeMock.mockResolvedValueOnce(dependencies);

    await expect(
      ApiService.getNexusModFileDependencies('schedule1', 42, 420),
    ).resolves.toEqual(dependencies);
    expect(invokeMock).toHaveBeenCalledWith('get_nexus_mod_file_dependencies', {
      gameId: 'schedule1',
      modId: 42,
      fileId: 420,
    });
  });

  it('uploadMod forwards detectedRuntime metadata', async () => {
    invokeMock.mockResolvedValueOnce({ success: true });

    await ApiService.uploadMod(
      'env-1',
      'C:/mods/Example.dll',
      'Example.dll',
      'IL2CPP',
      {
        source: 'unknown',
        modName: 'Example',
        detectedRuntime: 'Mono',
      }
    );

    expect(invokeMock).toHaveBeenCalledWith('upload_mod', {
      environmentId: 'env-1',
      filePath: 'C:/mods/Example.dll',
      originalFileName: 'Example.dll',
      runtime: 'IL2CPP',
      branch: '',
      metadata: expect.objectContaining({
        source: 'unknown',
        modName: 'Example',
        detectedRuntime: 'Mono',
      }),
    });
  });

  it('getAllModUpdatesSummary invokes backend summary command', async () => {
    invokeMock.mockResolvedValueOnce([
      {
        environmentId: 'env-1',
        environmentName: 'Env One',
        count: 1,
        updates: [],
      },
    ]);

    const result = await ApiService.getAllModUpdatesSummary();

    expect(invokeMock).toHaveBeenCalledWith('get_all_mod_updates_summary', {});
    expect(result).toEqual([
      {
        environmentId: 'env-1',
        environmentName: 'Env One',
        count: 1,
        updates: [],
      },
    ]);
  });

  it('getAvailableModUpdates filters only updateAvailable entries', async () => {
    invokeMock.mockResolvedValueOnce([
      {
        modFileName: 'A.dll',
        updateAvailable: true,
        currentVersion: '1.0.0',
        latestVersion: '1.1.0',
        source: 'thunderstore',
      },
      {
        modFileName: 'B.dll',
        updateAvailable: false,
        currentVersion: '2.0.0',
        latestVersion: '2.0.0',
        source: 'nexusmods',
      },
    ]);

    const result = await ApiService.getAvailableModUpdates('env-1');

    expect(result.count).toBe(1);
    expect(result.updates).toEqual([
      {
        modFileName: 'A.dll',
        updateAvailable: true,
        currentVersion: '1.0.0',
        latestVersion: '1.1.0',
        source: 'thunderstore',
      },
    ]);
  });

  it('downloadThunderstoreToLibrary rejects an invalid selected version UUID instead of falling back', async () => {
    invokeMock.mockResolvedValueOnce({
      package_url: 'https://thunderstore.io/c/schedule-i/p/ifBars/Example/',
      name: 'Example',
      owner: 'ifBars',
      versions: [
        {
          uuid4: 'known-version',
          version_number: '1.0.0',
          downloads: 10,
          date_updated: '2026-03-28T00:00:00Z',
        },
      ],
    });

    await expect(
      ApiService.downloadThunderstoreToLibrary('package-1', 'Mono', undefined, 'missing-version'),
    ).rejects.toThrow('Thunderstore version missing-version was not found for package package-1');
  });

  it('config editor commands use the new document-oriented API', async () => {
    invokeMock.mockResolvedValueOnce([
      {
        name: 'Loader.cfg',
        path: 'C:/Games/Schedule I/MelonLoader/Loader.cfg',
        fileType: 'LoaderConfig',
        format: 'ini',
        relativePath: 'MelonLoader/Loader.cfg',
        groupName: 'Loader',
        sectionCount: 2,
        entryCount: 8,
        supportsStructuredEdit: true,
        supportsRawEdit: true,
      },
    ]);
    invokeMock.mockResolvedValueOnce({
      summary: {
        name: 'Loader.cfg',
        path: 'C:/Games/Schedule I/MelonLoader/Loader.cfg',
        fileType: 'LoaderConfig',
        format: 'ini',
        relativePath: 'MelonLoader/Loader.cfg',
        groupName: 'Loader',
        sectionCount: 2,
        entryCount: 8,
        supportsStructuredEdit: true,
        supportsRawEdit: true,
      },
      rawContent: '[General]\nfoo = bar',
      sections: [],
      parseWarnings: [],
      groups: [],
    });
    invokeMock.mockResolvedValueOnce(undefined);
    invokeMock.mockResolvedValueOnce(undefined);

    const catalog = await ApiService.getConfigCatalog('env-1');
    const document = await ApiService.getConfigDocument('env-1', 'C:/Games/Schedule I/MelonLoader/Loader.cfg');
    await ApiService.applyConfigEdits('env-1', 'C:/Games/Schedule I/MelonLoader/Loader.cfg', [
      { kind: 'setValue', section: 'General', key: 'foo', value: 'baz' },
    ]);
    await ApiService.saveRawConfig('env-1', 'C:/Games/Schedule I/MelonLoader/Loader.cfg', '[General]\nfoo = qux');

    expect(catalog).toHaveLength(1);
    expect(document.summary.name).toBe('Loader.cfg');
    expect(invokeMock).toHaveBeenNthCalledWith(1, 'get_config_catalog', { environmentId: 'env-1' });
    expect(invokeMock).toHaveBeenNthCalledWith(2, 'get_config_document', {
      environmentId: 'env-1',
      filePath: 'C:/Games/Schedule I/MelonLoader/Loader.cfg',
    });
    expect(invokeMock).toHaveBeenNthCalledWith(3, 'apply_config_edits', {
      environmentId: 'env-1',
      filePath: 'C:/Games/Schedule I/MelonLoader/Loader.cfg',
      operations: [{ kind: 'setValue', section: 'General', key: 'foo', value: 'baz' }],
    });
    expect(invokeMock).toHaveBeenNthCalledWith(4, 'save_raw_config', {
      environmentId: 'env-1',
      filePath: 'C:/Games/Schedule I/MelonLoader/Loader.cfg',
      content: '[General]\nfoo = qux',
    });
  });

  it.each([
    ['getReleaseApiHealth', () => ApiService.getReleaseApiHealth(), 'get_release_api_health', undefined],
    ['getLinuxReadinessStatus', () => ApiService.getLinuxReadinessStatus(), 'get_linux_readiness_status', undefined],
    ['repairLinuxDesktopIntegration', () => ApiService.repairLinuxDesktopIntegration(), 'repair_linux_desktop_integration', undefined],
    ['checkModUpdates', () => ApiService.checkModUpdates('env-1'), 'check_mod_updates', { environmentId: 'env-1' }],
    ['getModUpdatesSummary', () => ApiService.getModUpdatesSummary('env-1'), 'get_mod_updates_summary', { environmentId: 'env-1' }],
    ['updateMod', () => ApiService.updateMod('env-1', 'Example.dll'), 'update_mod', { environmentId: 'env-1', modFileName: 'Example.dll' }],
    ['refreshThunderstorePackageCache', () => ApiService.refreshThunderstorePackageCache('schedule-i'), 'refresh_thunderstore_package_cache', { gameId: 'schedule-i' }],
    ['openPath', () => ApiService.openPath('C:/test/file.cfg'), 'open_path', { path: 'C:/test/file.cfg' }],
    ['openExternalUrl', () => ApiService.openExternalUrl('https://example.com/mod'), 'open_external_url', { url: 'https://example.com/mod' }],
    ['revealPath', () => ApiService.revealPath('C:/test/file.cfg'), 'reveal_path', { path: 'C:/test/file.cfg' }],
  ])('%s invokes correct command contract', async (_label, call, command, payload) => {
    invokeMock.mockResolvedValueOnce({ success: true });

    await call();

    if (payload === undefined) {
      expect(invokeMock).toHaveBeenCalledWith(command);
      return;
    }

    expect(invokeMock).toHaveBeenCalledWith(command, payload);
  });
});
