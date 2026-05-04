import { describe, expect, it } from 'vitest';
import {
  applyFeaturedDownloadRemoteVersions,
  areVersionsEquivalentForSource,
  buildDownloadedGroups,
  buildEnvironmentModSnapshot,
  compareVersionTokensDesc,
} from './modLibrarySummary';
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

  it('includes runtime-split SteamNetworkLib packages as featured downloads', () => {
    const snapshot = buildEnvironmentModSnapshot({
      downloaded: [
        makeEntry({
          storageId: 'steamnetworklib-mono-storage',
          displayName: 'SteamNetworkLib',
          source: 'thunderstore',
          sourceId: 'ifBars/SteamNetworkLib_Mono',
          sourceVersion: '1.2.1',
          remoteVersion: '1.2.2',
          updateAvailable: true,
          availableRuntimes: ['Mono'],
          storageIdsByRuntime: { Mono: 'steamnetworklib-mono-storage' },
          installedInByRuntime: { Mono: ['env-main'] },
          filesByRuntime: { Mono: ['SteamNetworkLib.dll'] },
          installedIn: ['env-main'],
        }),
      ],
    }, 'env-main');

    expect(snapshot.featuredDownloads).toBe(1);
    expect(snapshot.updateCount).toBe(1);
    expect(snapshot.updates[0]).toMatchObject({
      modName: 'SteamNetworkLib',
      currentVersion: '1.2.1',
      latestVersion: '1.2.2',
      source: 'thunderstore',
      groupKey: 'thunderstore::steamnetworklib',
    });
  });

  it('treats S1API revision tags as newer featured-download releases', () => {
    const library = applyFeaturedDownloadRemoteVersions({
      downloaded: [
        makeEntry({
          storageId: 's1api-storage',
          displayName: 'S1API',
          source: 'github',
          sourceId: 'ifBars/S1API',
          sourceVersion: '3.0.22',
          installedInByRuntime: { IL2CPP: ['env-main'] },
          filesByRuntime: { IL2CPP: ['S1API.dll'] },
          installedIn: ['env-main'],
        }),
      ],
    }, new Map([['ifbars/s1api', '3.0.3']]));

    const snapshot = buildEnvironmentModSnapshot(library, 'env-main');

    expect(snapshot.updateCount).toBe(1);
    expect(snapshot.updates).toEqual([
      {
        modName: 'S1API',
        currentVersion: '3.0.22',
        latestVersion: '3.0.3',
        source: 'github',
        groupKey: 'github::ifbars/s1api',
      },
    ]);
  });

  it('keeps normal semver ordering for non-S1API featured downloads', () => {
    const library = applyFeaturedDownloadRemoteVersions({
      downloaded: [
        makeEntry({
          storageId: 'featured-storage',
          displayName: 'Example Featured Tool',
          source: 'github',
          sourceId: 'example/tool',
          sourceVersion: '1.0.9',
          installedInByRuntime: { IL2CPP: ['env-main'] },
          filesByRuntime: { IL2CPP: ['ExampleTool.dll'] },
          installedIn: ['env-main'],
        }),
      ],
    }, new Map([['example/tool', '1.0.10']]));

    const snapshot = buildEnvironmentModSnapshot(library, 'env-main');

    expect(snapshot.updateCount).toBe(1);
    expect(snapshot.updates[0]?.latestVersion).toBe('1.0.10');
  });

  it('treats S1API alias source ids as one downloaded group', () => {
    const groups = buildDownloadedGroups([
      makeEntry({
        storageId: 's1api-forked-storage',
        displayName: 'S1API',
        source: 'github',
        sourceId: 'ifBars/S1API_Forked',
        sourceVersion: '3.0.22',
      }),
      makeEntry({
        storageId: 's1api-storage',
        displayName: 'S1API',
        source: 'github',
        sourceId: 'ifBars/S1API',
        sourceVersion: 'v3.0.3',
      }),
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0]?.key).toBe('github::ifbars/s1api');
    expect(groups[0]?.entries).toHaveLength(2);
  });

  it('uses S1API-aware equality for alias source ids', () => {
    expect(
      areVersionsEquivalentForSource('ifBars/S1API_Forked', '3.0.22', '3.0.3'),
    ).toBe(false);
    expect(
      areVersionsEquivalentForSource('ifBars/S1API', 'v3.0.3', '3.0.3'),
    ).toBe(true);
  });
});
