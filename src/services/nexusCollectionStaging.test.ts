import { describe, expect, it } from "vitest";
import type { ModLibraryEntry, NexusCollectionModFile } from "../types";
import {
  findCollectionFileConflicts,
  findStagedCollectionEntry,
} from "./nexusCollectionStaging";

const collectionFile: NexusCollectionModFile = {
  collectionRevisionModId: "revision-mod-1",
  modId: 42,
  fileId: 9001,
  gameId: 7381,
  modName: "Example Mod",
  fileName: "Example Mod 2.0",
  version: "2.0.0",
  optional: false,
  available: true,
};

function libraryEntry(
  overrides: Partial<ModLibraryEntry> = {},
): ModLibraryEntry {
  return {
    storageId: "stored-example",
    displayName: "Example Mod",
    files: ["Example.dll"],
    attachedUserLibs: [],
    source: "nexusmods",
    sourceId: "42",
    nexusFileId: "9001",
    sourceVersion: "2.0.0",
    managed: true,
    installedIn: [],
    availableRuntimes: ["Mono"],
    storageIdsByRuntime: { Mono: "stored-example" },
    installedInByRuntime: {},
    filesByRuntime: { Mono: ["Example.dll"] },
    ...overrides,
  };
}

describe("Nexus collection staging identity", () => {
  it("only treats the exact Nexus file as staged", () => {
    const exact = libraryEntry();
    const otherVersion = libraryEntry({
      storageId: "stored-old",
      nexusFileId: "8000",
      sourceVersion: "1.0.0",
    });

    expect(
      findStagedCollectionEntry(collectionFile, [otherVersion, exact]),
    ).toBe(exact);
    expect(findStagedCollectionEntry(collectionFile, [otherVersion])).toBeUndefined();
  });

  it("recognizes a different file of the same Nexus mod as a conflict", () => {
    const installedOldVersion = libraryEntry({
      nexusFileId: undefined,
      tags: ["nexus-file-id:8000"],
      sourceVersion: "1.0.0",
      installedIn: ["main-environment"],
    });
    const unrelatedMod = libraryEntry({
      storageId: "unrelated",
      sourceId: "77",
      nexusFileId: "7000",
    });

    expect(
      findCollectionFileConflicts(collectionFile, [
        installedOldVersion,
        unrelatedMod,
      ]),
    ).toEqual([installedOldVersion]);
  });

  it("does not report the exact staged file as a conflict", () => {
    expect(findCollectionFileConflicts(collectionFile, [libraryEntry()])).toEqual(
      [],
    );
  });
});
