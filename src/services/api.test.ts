import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ApiService } from './api';
import { invoke } from '@tauri-apps/api/core';

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

  it('getAppUpdateStatus forwards the current app version to the backend', async () => {
    invokeMock.mockResolvedValueOnce({
      currentVersionRaw: '0.7.8',
      currentVersionNormalized: '0.7.8',
      latestVersionRaw: '0.7.9-beta',
      latestVersionNormalized: '0.7.9',
      updateAvailable: true,
      targetUrl: 'https://www.nexusmods.com/schedule1/mods/999?tab=files&file_id=42',
      fallbackFilesUrl: 'https://www.nexusmods.com/schedule1/mods/999?tab=files',
      checkedAt: '2026-03-27T12:00:00Z',
    });

    const result = await ApiService.getAppUpdateStatus('0.7.8');

    expect(invokeMock).toHaveBeenCalledWith('get_app_update_status', {
      currentVersion: '0.7.8',
    });
    expect(result.updateAvailable).toBe(true);
    expect(result.latestVersionNormalized).toBe('0.7.9');
  });

  it('deleteEnvironment wraps boolean response', async () => {
    invokeMock.mockResolvedValueOnce(true);
    const result = await ApiService.deleteEnvironment('env-1');

    expect(invokeMock).toHaveBeenCalledWith('delete_environment', { id: 'env-1' });
    expect(result).toEqual({ success: true });
  });

  it('getProgress throws when download is missing', async () => {
    invokeMock.mockResolvedValueOnce(null);

    await expect(ApiService.getProgress('download-1')).rejects.toThrow('Download not found');
    expect(invokeMock).toHaveBeenCalledWith('get_download_progress', {
      downloadId: 'download-1',
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
        author: 'Tester',
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
        updated_at: '2024-01-01',
        created_at: '2023-01-01',
      })
    );
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
    ['checkModUpdates', () => ApiService.checkModUpdates('env-1'), 'check_mod_updates', { environmentId: 'env-1' }],
    ['getModUpdatesSummary', () => ApiService.getModUpdatesSummary('env-1'), 'get_mod_updates_summary', { environmentId: 'env-1' }],
    ['updateMod', () => ApiService.updateMod('env-1', 'Example.dll'), 'update_mod', { environmentId: 'env-1', modFileName: 'Example.dll' }],
    ['openPath', () => ApiService.openPath('C:/test/file.cfg'), 'open_path', { path: 'C:/test/file.cfg' }],
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
