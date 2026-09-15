import type {
  ModLibraryEntry,
  ModProfileCollectionThunderstoreMatch,
  ModProfileItem,
  NexusCollectionModFile,
  NexusModFile,
  Runtime,
  StoredModProfile,
} from '../types';
import { getNexusFileIdFromTags } from './modLibrarySummary';

export interface CollectionThunderstoreVersion {
  uuid4: string;
  version_number: string;
}

export interface CollectionThunderstorePackage {
  uuid4: string;
  name: string;
  owner: string;
  package_url: string;
  versions?: CollectionThunderstoreVersion[];
}

export interface CollectionThunderstoreMatch extends ModProfileCollectionThunderstoreMatch {
  name: string;
  owner: string;
  version: string;
}

export function normalizeCollectionIdentity(value: string | null | undefined): string {
  return String(value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

export function normalizeCollectionVersion(value: string | null | undefined): string {
  return String(value ?? '').trim().toLowerCase().replace(/^v(?=\d)/, '');
}

export function collectionFileKey(file: NexusCollectionModFile): string {
  return file.collectionRevisionModId || `${file.modId ?? 0}:${file.fileId}`;
}

export type CollectionNexusRuntime = 'IL2CPP' | 'Mono';

export interface ResolvedCollectionNexusFile {
  fileId: number;
  fileName: string;
  version: string;
  isCollectionFile: boolean;
}

export function inferNexusFileRuntime(
  ...values: Array<string | null | undefined>
): CollectionNexusRuntime | null {
  const identity = values.join(' ').toLowerCase();
  if (/il\s*2\s*cpp/.test(identity)) return 'IL2CPP';
  if (/(^|[^a-z0-9])mono([^a-z0-9]|$)/.test(identity)) return 'Mono';
  return null;
}

export function resolveCollectionNexusFileForRuntime(
  collectionFile: NexusCollectionModFile,
  files: NexusModFile[] | null | undefined,
  runtime: CollectionNexusRuntime,
): ResolvedCollectionNexusFile | null {
  const collectionRuntime = inferNexusFileRuntime(
    collectionFile.fileName,
    collectionFile.modName,
  );
  const original = files?.find((file) => file.file_id === collectionFile.fileId);
  const originalRuntime = inferNexusFileRuntime(
    original?.file_name,
    original?.name,
    collectionFile.fileName,
    collectionFile.modName,
  );
  const originalResolution: ResolvedCollectionNexusFile = {
    fileId: collectionFile.fileId,
    fileName: original?.file_name || original?.name || collectionFile.fileName,
    version: original?.version || original?.mod_version || collectionFile.version,
    isCollectionFile: true,
  };

  if ((originalRuntime ?? collectionRuntime) === null || (originalRuntime ?? collectionRuntime) === runtime) {
    return originalResolution;
  }
  if (!files) return null;

  const requestedVersion = normalizeCollectionVersion(collectionFile.version);
  const candidates = files
    .filter((file) => normalizeCollectionVersion(file.version || file.mod_version) === requestedVersion)
    .filter((file) => inferNexusFileRuntime(file.file_name, file.name) === runtime)
    .sort((left, right) => {
      if (left.is_primary !== right.is_primary) return left.is_primary ? -1 : 1;
      return (right.uploaded_timestamp ?? 0) - (left.uploaded_timestamp ?? 0);
    });
  const resolved = candidates[0];
  if (!resolved) return null;
  return {
    fileId: resolved.file_id,
    fileName: resolved.file_name || resolved.name,
    version: resolved.version || resolved.mod_version || collectionFile.version,
    isCollectionFile: resolved.file_id === collectionFile.fileId,
  };
}

function runtimeMatches(entryRuntime: Runtime, runtime: 'IL2CPP' | 'Mono'): boolean {
  return entryRuntime === runtime || (runtime === 'Mono' && entryRuntime === 'MONO');
}

export function resolveCollectionStorageId(
  entry: ModLibraryEntry,
  runtime: 'IL2CPP' | 'Mono',
): string {
  return entry.storageIdsByRuntime[runtime]
    ?? (runtime === 'Mono' ? entry.storageIdsByRuntime.MONO : undefined)
    ?? entry.storageId;
}

export function findExactCollectionLibraryEntry(
  file: NexusCollectionModFile,
  entries: ModLibraryEntry[],
  runtime: 'IL2CPP' | 'Mono',
): ModLibraryEntry | null {
  const exactNexus = entries.find((entry) => {
    if (entry.source !== 'nexusmods') return false;
    const storedFileId = entry.nexusFileId ?? getNexusFileIdFromTags(entry.tags);
    return storedFileId === String(file.fileId)
      && (entry.availableRuntimes.length === 0 || entry.availableRuntimes.some((candidate) => runtimeMatches(candidate, runtime)));
  });
  if (exactNexus) return exactNexus;

  const requestedName = normalizeCollectionIdentity(file.modName);
  const requestedAuthor = normalizeCollectionIdentity(file.author);
  const requestedVersion = normalizeCollectionVersion(file.version);
  if (!requestedName || !requestedAuthor || !requestedVersion) return null;

  return entries.find((entry) => {
    const installedVersion = normalizeCollectionVersion(entry.sourceVersion ?? entry.installedVersion);
    return normalizeCollectionIdentity(entry.displayName) === requestedName
      && normalizeCollectionIdentity(entry.author) === requestedAuthor
      && installedVersion === requestedVersion
      && (entry.availableRuntimes.length === 0 || entry.availableRuntimes.some((candidate) => runtimeMatches(candidate, runtime)));
  }) ?? null;
}

export function findCollectionThunderstoreMatches(
  file: NexusCollectionModFile,
  packagesByRuntime: Partial<Record<'IL2CPP' | 'Mono', CollectionThunderstorePackage[]>>,
): CollectionThunderstoreMatch[] {
  const requestedName = normalizeCollectionIdentity(file.modName);
  const requestedAuthor = normalizeCollectionIdentity(file.author);
  const requestedVersion = normalizeCollectionVersion(file.version);
  if (!requestedName || !requestedAuthor || !requestedVersion) return [];

  const matches: CollectionThunderstoreMatch[] = [];
  for (const runtime of ['IL2CPP', 'Mono'] as const) {
    for (const candidate of packagesByRuntime[runtime] ?? []) {
      if (
        normalizeCollectionIdentity(candidate.name) !== requestedName
        || normalizeCollectionIdentity(candidate.owner) !== requestedAuthor
      ) {
        continue;
      }
      const version = candidate.versions?.find(
        (entry) => normalizeCollectionVersion(entry.version_number) === requestedVersion,
      );
      if (!version) continue;
      matches.push({
        packageUuid: candidate.uuid4,
        versionUuid: version.uuid4,
        sourceId: `${candidate.owner}/${candidate.name}`,
        packageUrl: candidate.package_url,
        runtime,
        name: candidate.name,
        owner: candidate.owner,
        version: version.version_number,
      });
    }
  }
  return matches;
}

export function selectCollectionThunderstoreMatch(
  matches: CollectionThunderstoreMatch[],
  runtime: 'IL2CPP' | 'Mono',
): { match: CollectionThunderstoreMatch | null; runtimeMismatch: boolean } {
  const compatible = matches.find((match) => match.runtime === runtime);
  if (compatible) return { match: compatible, runtimeMismatch: false };
  return { match: matches[0] ?? null, runtimeMismatch: matches.length > 0 };
}

export function updateCollectionProfileFromLibrary(
  profile: StoredModProfile,
  entries: ModLibraryEntry[],
): StoredModProfile {
  const collection = profile.manifest.collection;
  if (!collection) return profile;
  const runtime = profile.runtime === 'IL2CPP' ? 'IL2CPP' : 'Mono';
  let changed = false;
  const items = [...profile.manifest.items];
  const collectionItems = collection.items.map((collectionItem) => {
    const file: NexusCollectionModFile = {
      collectionRevisionModId: collectionItem.key,
      modId: collectionItem.nexusModId ?? undefined,
      fileId: Number(collectionItem.nexusFileId),
      modName: collectionItem.requestedName,
      author: collectionItem.requestedAuthor ?? undefined,
      fileName: '',
      version: collectionItem.requestedVersion,
      optional: collectionItem.optional,
      available: true,
    };
    const entry = findExactCollectionLibraryEntry(file, entries, runtime);
    if (!entry) return collectionItem;
    const itemIndex = items.findIndex((item) => item.nexusFileId === collectionItem.nexusFileId);
    if (itemIndex >= 0) {
      const current = items[itemIndex];
      const storageId = resolveCollectionStorageId(entry, runtime);
      const nextItem: ModProfileItem = {
        ...current,
        name: entry.displayName || current.name,
        fileName: entry.filesByRuntime[runtime]?.[0] ?? entry.files[0] ?? current.fileName,
        source: entry.source ?? 'unknown',
        sourceId: entry.sourceId ?? current.sourceId,
        sourceVersion: entry.sourceVersion ?? entry.installedVersion ?? current.sourceVersion,
        sourceUrl: entry.sourceUrl ?? current.sourceUrl,
        storageId,
        manualReason: null,
      };
      if (JSON.stringify(nextItem) !== JSON.stringify(current)) {
        items[itemIndex] = nextItem;
        changed = true;
      }
    }
    if (collectionItem.status !== 'ready') {
      changed = true;
      return {
        ...collectionItem,
        status: 'ready' as const,
        statusMessage: collectionItem.sourceChoice === 'library'
          ? `Reused ${entry.displayName} ${entry.sourceVersion ?? entry.installedVersion ?? ''} from the library.`
          : `Stored ${entry.displayName} ${entry.sourceVersion ?? entry.installedVersion ?? ''} from ${entry.source ?? collectionItem.sourceChoice}.`,
        runtimeMismatch: false,
      };
    }
    return collectionItem;
  });
  if (!changed) return profile;
  return {
    ...profile,
    manifest: {
      ...profile.manifest,
      items,
      collection: { ...collection, items: collectionItems },
    },
  };
}
