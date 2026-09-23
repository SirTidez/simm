import type { ModLibraryEntry, NexusCollectionModFile } from "../types";
import { getNexusFileIdFromTags } from "./modLibrarySummary";

export function getStoredNexusFileId(entry: ModLibraryEntry): string {
  return (entry.nexusFileId || getNexusFileIdFromTags(entry.tags)).trim();
}

export function findStagedCollectionEntry(
  file: NexusCollectionModFile,
  entries: ModLibraryEntry[],
): ModLibraryEntry | undefined {
  return entries.find(
    (entry) =>
      entry.source === "nexusmods" &&
      Number(entry.sourceId) === file.modId &&
      getStoredNexusFileId(entry) === String(file.fileId),
  );
}

export function findCollectionFileConflicts(
  file: NexusCollectionModFile,
  entries: ModLibraryEntry[],
): ModLibraryEntry[] {
  return entries.filter(
    (entry) =>
      entry.source === "nexusmods" &&
      Number(entry.sourceId) === file.modId &&
      getStoredNexusFileId(entry) !== String(file.fileId),
  );
}
