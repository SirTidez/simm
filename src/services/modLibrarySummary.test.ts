import { describe, expect, it } from 'vitest';
import { buildDownloadedGroups, buildEnvironmentModSnapshot, compareVersionTokensDesc } from './modLibrarySummary';
import type { ModLibraryEntry } from '../types';

function makeEntry(overrides: Partial<ModLibraryEntry>): ModLibraryEntry {
  return {
    storageId: 'storage-1',
    displayName: 'Example Mod',
    files: ['Example.dll'],
    attachedUserLibs: [],
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

  it('derives environment updates from the installed runtime entry instead of group maxima', () => {
    const snapshot = buildEnvironmentModSnapshot({
      downloaded: [
        makeEntry({
          storageId: 'storage-il2cpp',
          displayName: 'Split Runtime Mod',
          sourceId: 'split-runtime-mod',
          sourceVersion: '2.0.0',
          remoteVersion: '2.0.0',
          updateAvailable: false,
          availableRuntimes: ['IL2CPP'],
          storageIdsByRuntime: { IL2CPP: 'storage-il2cpp' },
          installedInByRuntime: { IL2CPP: [] },
          filesByRuntime: { IL2CPP: ['SplitRuntimeMod-IL2CPP.dll'] },
          installedIn: [],
        }),
        makeEntry({
          storageId: 'storage-mono',
          displayName: 'Split Runtime Mod',
          sourceId: 'split-runtime-mod',
          sourceVersion: '1.0.0',
          remoteVersion: '1.1.0',
          updateAvailable: true,
          availableRuntimes: ['Mono'],
          storageIdsByRuntime: { Mono: 'storage-mono' },
          installedInByRuntime: { Mono: ['env-mono'] },
          filesByRuntime: { Mono: ['SplitRuntimeMod-Mono.dll'] },
          installedIn: ['env-mono'],
        }),
      ],
    }, 'env-mono');

    expect(snapshot.updateCount).toBe(1);
    expect(snapshot.updates).toEqual([
      {
        modName: 'Split Runtime Mod',
        currentVersion: '1.0.0',
        latestVersion: '1.1.0',
        source: 'nexusmods',
        groupKey: 'nexusmods::split-runtime-mod',
      },
    ]);
  });

  it('includes featured GitHub downloads in environment update summaries', () => {
    const snapshot = buildEnvironmentModSnapshot({
      downloaded: [
        makeEntry({
          storageId: 'mlvscan-storage',
          displayName: 'MLVScan',
          source: 'github',
          sourceId: 'ifBars/MLVScan',
          sourceVersion: 'v2.0.1',
          remoteVersion: 'v2.0.2',
          updateAvailable: true,
          availableRuntimes: ['IL2CPP'],
          storageIdsByRuntime: { IL2CPP: 'mlvscan-storage' },
          installedInByRuntime: { IL2CPP: ['env-main'] },
          filesByRuntime: { IL2CPP: ['MLVScan.dll'] },
          installedIn: ['env-main'],
        }),
      ],
    }, 'env-main');

    expect(snapshot.featuredDownloads).toBe(1);
    expect(snapshot.updateCount).toBe(1);
    expect(snapshot.updates).toEqual([
      {
        modName: 'MLVScan',
        currentVersion: 'v2.0.1',
        latestVersion: 'v2.0.2',
        source: 'github',
        groupKey: 'github::ifbars/mlvscan',
      },
    ]);
  });
});
