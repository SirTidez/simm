import type { ModLibraryEntry, ModLibraryResult } from '../types';

const runtimeSuffixPatterns = [
  /\s*[\(\[]\s*(mono|il2cpp)\s*[\)\]]\s*$/i,
  /\s*[_-]\s*(mono|il2cpp)\s*$/i,
  /\s+(mono|il2cpp)\s*$/i,
];

const coreToolSourceIds = new Set([
  'ifbars/s1api',
  'ifbars/s1api_forked',
  'ifbars/mlvscan',
]);

export interface DownloadedModGroup {
  key: string;
  displayName: string;
  managed: boolean;
  entries: ModLibraryEntry[];
  storageIds: string[];
  installedIn: string[];
  installedInByRuntime: Partial<Record<'IL2CPP' | 'Mono', string[]>>;
  availableRuntimes: Array<'IL2CPP' | 'Mono'>;
  author?: string;
  sourceVersion?: string;
  updateAvailable?: boolean;
  remoteVersion?: string;
}

export interface ModUpdateSummaryEntry {
  modName: string;
  currentVersion: string;
  latestVersion: string;
  source: string;
  groupKey: string;
}

export interface EnvironmentModSnapshot {
  userMods: number;
  coreTools: number;
  total: number;
  updateCount: number;
  updates: ModUpdateSummaryEntry[];
}

export function normalizeThunderstoreName(name: string): string {
  let normalized = name;
  let changed = true;
  while (changed) {
    changed = false;
    for (const pattern of runtimeSuffixPatterns) {
      const next = normalized.replace(pattern, '').trim();
      if (next !== normalized) {
        normalized = next;
        changed = true;
      }
    }
  }
  return normalized;
}

export function parseThunderstoreSourceId(sourceId?: string): { owner: string; name: string } {
  if (!sourceId) {
    return { owner: '', name: '' };
  }
  const [owner, ...rest] = sourceId.split('/');
  return { owner: owner || '', name: rest.join('/') };
}

export function normalizeVersionToken(value?: string): string {
  let normalized = (value || '').trim();

  let changed = true;
  while (changed) {
    changed = false;
    for (const pattern of runtimeSuffixPatterns) {
      const next = normalized.replace(pattern, '').trim();
      if (next !== normalized) {
        normalized = next;
        changed = true;
      }
    }
  }

  return normalized.replace(/^v/i, '').toLowerCase();
}

function extractVersionParts(value?: string): number[] {
  const normalized = normalizeVersionToken(value);
  const matches = normalized.match(/\d+/g);
  return (matches || []).map((segment) => Number.parseInt(segment, 10) || 0);
}

function hasPrereleaseMarker(value?: string): boolean {
  const normalized = normalizeVersionToken(value);
  return /(alpha|beta|preview|pre|rc|nightly|experimental|dev|test)/i.test(normalized);
}

export function compareVersionTokensDesc(a?: string, b?: string): number {
  const aParts = extractVersionParts(a);
  const bParts = extractVersionParts(b);
  const len = Math.max(aParts.length, bParts.length);
  for (let i = 0; i < len; i += 1) {
    const av = aParts[i] || 0;
    const bv = bParts[i] || 0;
    if (av !== bv) {
      return bv - av;
    }
  }
  const aPrerelease = hasPrereleaseMarker(a);
  const bPrerelease = hasPrereleaseMarker(b);
  if (aPrerelease !== bPrerelease) {
    return aPrerelease ? 1 : -1;
  }
  return 0;
}

export function areVersionsEquivalent(a?: string, b?: string): boolean {
  const normalizedA = normalizeVersionToken(a);
  const normalizedB = normalizeVersionToken(b);
  if (!normalizedA || !normalizedB) {
    return false;
  }
  return compareVersionTokensDesc(normalizedA, normalizedB) === 0;
}

export function buildDownloadedGroups(downloaded: ModLibraryEntry[]): DownloadedModGroup[] {
  const groups = new Map<
    string,
    {
      key: string;
      displayName: string;
      entries: ModLibraryEntry[];
      storageIds: string[];
      installedIn: Set<string>;
      installedInByRuntime: {
        IL2CPP: Set<string>;
        Mono: Set<string>;
      };
      availableRuntimes: Set<'IL2CPP' | 'Mono'>;
      managedStates: Set<boolean>;
      authors: Set<string>;
      sourceVersions: Set<string>;
      updateAvailable: boolean;
      remoteVersions: Set<string>;
    }
  >();

  downloaded.forEach((entry) => {
    let key = entry.storageId;
    let displayName = entry.displayName;
    const normalizedDisplayName = normalizeThunderstoreName(entry.displayName).toLowerCase();

    if (entry.source === 'thunderstore') {
      const { name } = parseThunderstoreSourceId(entry.sourceId);
      const baseName = normalizeThunderstoreName(name || entry.displayName);
      key = `thunderstore::${normalizeThunderstoreName(baseName).toLowerCase()}`;
      displayName = baseName || entry.displayName;
    } else if ((entry.source === 'nexusmods' || entry.source === 'github') && entry.sourceId) {
      key = `${entry.source}::${entry.sourceId.toLowerCase()}`;
    } else if ((entry.source === 'nexusmods' || entry.source === 'github') && !entry.sourceId) {
      key = `${entry.source}::${normalizedDisplayName}`;
    } else if (entry.managed) {
      key = `managed::${normalizedDisplayName}`;
    }

    const group = groups.get(key) || {
      key,
      displayName,
      entries: [],
      storageIds: [],
      installedIn: new Set<string>(),
      installedInByRuntime: {
        IL2CPP: new Set<string>(),
        Mono: new Set<string>(),
      },
      availableRuntimes: new Set<'IL2CPP' | 'Mono'>(),
      managedStates: new Set<boolean>(),
      authors: new Set<string>(),
      sourceVersions: new Set<string>(),
      updateAvailable: false,
      remoteVersions: new Set<string>(),
    };

    group.entries.push(entry);
    group.storageIds.push(entry.storageId);
    entry.installedIn.forEach((envId) => group.installedIn.add(envId));
    (entry.installedInByRuntime?.IL2CPP || []).forEach((envId) => group.installedInByRuntime.IL2CPP.add(envId));
    (entry.installedInByRuntime?.Mono || []).forEach((envId) => group.installedInByRuntime.Mono.add(envId));
    entry.availableRuntimes.forEach((runtime) => group.availableRuntimes.add(runtime));
    group.managedStates.add(entry.managed);
    if (entry.author) {
      group.authors.add(entry.author);
    }
    if (entry.sourceVersion) {
      group.sourceVersions.add(entry.sourceVersion);
    }
    if (entry.updateAvailable) {
      group.updateAvailable = true;
    }
    if (entry.remoteVersion) {
      group.remoteVersions.add(entry.remoteVersion);
    }

    groups.set(key, group);
  });

  return Array.from(groups.values())
    .map((group) => {
      const remoteVersions = Array.from(group.remoteVersions).sort((a, b) => compareVersionTokensDesc(a, b));
      const sourceVersions = Array.from(group.sourceVersions).sort((a, b) => compareVersionTokensDesc(a, b));
      const highestDownloadedVersion = sourceVersions[0];
      const latestRemoteVersion = remoteVersions[0];
      const hasRemoteVersion = normalizeVersionToken(latestRemoteVersion).length > 0;
      const hasDownloadedVersion = normalizeVersionToken(highestDownloadedVersion).length > 0;
      const effectiveLatestVersion = hasRemoteVersion && hasDownloadedVersion
        ? (compareVersionTokensDesc(latestRemoteVersion, highestDownloadedVersion) < 0
          ? latestRemoteVersion
          : highestDownloadedVersion)
        : (latestRemoteVersion || highestDownloadedVersion);
      const updateAvailable = hasRemoteVersion && hasDownloadedVersion
        ? compareVersionTokensDesc(latestRemoteVersion, highestDownloadedVersion) < 0
        : (hasRemoteVersion ? group.updateAvailable : false);

      return {
        key: group.key,
        displayName: group.displayName,
        managed: group.managedStates.size === 1 && group.managedStates.has(true),
        entries: group.entries,
        storageIds: group.storageIds,
        installedIn: Array.from(group.installedIn),
        installedInByRuntime: {
          IL2CPP: Array.from(group.installedInByRuntime.IL2CPP),
          Mono: Array.from(group.installedInByRuntime.Mono),
        },
        availableRuntimes: Array.from(group.availableRuntimes),
        author: group.authors.size === 1 ? Array.from(group.authors)[0] : undefined,
        sourceVersion: highestDownloadedVersion,
        updateAvailable,
        remoteVersion: effectiveLatestVersion,
      };
    })
    .sort((a, b) => a.displayName.toLowerCase().localeCompare(b.displayName.toLowerCase()));
}

export function getGroupInstalledVersion(group: DownloadedModGroup): string {
  const sortedByVersion = [...group.entries].sort((a, b) =>
    compareVersionTokensDesc(a.sourceVersion || a.installedVersion, b.sourceVersion || b.installedVersion),
  );
  const latestEntry = sortedByVersion[0];
  return latestEntry?.sourceVersion || latestEntry?.installedVersion || 'unknown';
}

export function getGroupSourceLabel(group: DownloadedModGroup): string {
  const source = group.entries[0]?.source || 'unknown';
  return source;
}

export function isCoreToolGroup(group: DownloadedModGroup): boolean {
  return group.entries.some((entry) => {
    const sourceId = (entry.sourceId || '').trim().toLowerCase();
    return coreToolSourceIds.has(sourceId);
  });
}

export function buildEnvironmentModSnapshot(library: ModLibraryResult | null | undefined, environmentId: string): EnvironmentModSnapshot {
  const downloaded = library?.downloaded ?? [];
  const groups = buildDownloadedGroups(downloaded).filter((group) => group.installedIn.includes(environmentId));
  const userGroups = groups.filter((group) => !isCoreToolGroup(group));
  const updates = userGroups
    .filter((group) => Boolean(group.updateAvailable))
    .map((group) => ({
      modName: group.displayName,
      currentVersion: getGroupInstalledVersion(group),
      latestVersion: group.remoteVersion || getGroupInstalledVersion(group),
      source: getGroupSourceLabel(group),
      groupKey: group.key,
    }));

  return {
    userMods: userGroups.length,
    coreTools: groups.length - userGroups.length,
    total: groups.length,
    updateCount: updates.length,
    updates,
  };
}
