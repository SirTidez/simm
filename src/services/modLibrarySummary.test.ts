import { describe, expect, it } from 'vitest';
import { buildDownloadedGroups, compareVersionTokensDesc } from './modLibrarySummary';
import type { ModLibraryEntry } from '../types';

function makeEntry(overrides: Partial<ModLibraryEntry>): ModLibraryEntry {
  return {
    storageId: 'storage-1',
    displayName: 'Example Mod',
    files: ['Example.dll'],
    source: 'nexusmods',
    sourceId: '1234',
    sourceVersion: '1.0.0',
    managed: true,
    installedIn: [],
    availableRuntimes: ['IL2CPP'],
    storageIdsByRuntime: { IL2CPP: 'storage-1' },
    installedInByRuntime: { IL2CPP: [] },
    filesByRuntime: { IL2CPP: ['Example.dll'] },
    ...overrides,
  };
}

describe('modLibrarySummary', () => {
  it('treats a newer beta as newer than an older stable version', () => {
    expect(compareVersionTokensDesc('1.1.0-beta', '1.0.2')).toBeLessThan(0);
  });

  it('does not mark a downloaded newer beta as updateable against an older remote stable version', () => {
    const groups = buildDownloadedGroups([
      makeEntry({
        displayName: 'Unicorns Custom Seeds',
        sourceVersion: '1.1.0-beta',
        remoteVersion: '1.0.2',
        updateAvailable: true,
      }),
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0].sourceVersion).toBe('1.1.0-beta');
    expect(groups[0].remoteVersion).toBe('1.1.0-beta');
    expect(groups[0].updateAvailable).toBe(false);
  });
});
