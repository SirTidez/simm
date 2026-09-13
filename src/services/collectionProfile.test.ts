import { describe, expect, it } from 'vitest';
import type { ModLibraryEntry, NexusCollectionModFile } from '../types';
import {
  findCollectionThunderstoreMatches,
  findExactCollectionLibraryEntry,
  normalizeCollectionIdentity,
  normalizeCollectionVersion,
  selectCollectionThunderstoreMatch,
} from './collectionProfile';

const file: NexusCollectionModFile = {
  collectionRevisionModId: 'revision-mod-1',
  modId: 42,
  fileId: 100,
  modName: 'Example Mod',
  author: 'Example Author',
  fileName: 'example.zip',
  version: 'v1.2.3',
  optional: false,
  available: true,
};

describe('collection profile matching', () => {
  it('normalizes identity punctuation but keeps exact version semantics', () => {
    expect(normalizeCollectionIdentity('Example_Mod-Name')).toBe('examplemodname');
    expect(normalizeCollectionVersion(' v1.2.3 ')).toBe('1.2.3');
    expect(normalizeCollectionVersion('1.2.4')).not.toBe(normalizeCollectionVersion('1.2.3'));
  });

  it('requires the same normalized name, author, and requested version', () => {
    const matches = findCollectionThunderstoreMatches(file, {
      IL2CPP: [{
        uuid4: 'package-1',
        name: 'Example_Mod',
        owner: 'Example-Author',
        package_url: 'https://thunderstore.io/package/Example-Author/Example_Mod/',
        versions: [
          { uuid4: 'wrong-version', version_number: '1.2.4' },
          { uuid4: 'exact-version', version_number: '1.2.3' },
        ],
      }],
      Mono: [{
        uuid4: 'wrong-author',
        name: 'Example Mod',
        owner: 'Someone Else',
        package_url: 'https://example.invalid',
        versions: [{ uuid4: 'same-version', version_number: '1.2.3' }],
      }],
    });
    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({ versionUuid: 'exact-version', runtime: 'IL2CPP' });
  });

  it('labels an exact match from the other runtime instead of hiding it', () => {
    const selection = selectCollectionThunderstoreMatch([{
      packageUuid: 'package-1',
      versionUuid: 'version-1',
      sourceId: 'Example-Author/Example_Mod',
      packageUrl: 'https://example.invalid',
      runtime: 'Mono',
      name: 'Example_Mod',
      owner: 'Example-Author',
      version: '1.2.3',
    }], 'IL2CPP');
    expect(selection.runtimeMismatch).toBe(true);
    expect(selection.match?.runtime).toBe('Mono');
  });

  it('reuses an exact library copy while retaining its source', () => {
    const entry = {
      storageId: 'stored-1',
      displayName: 'Example_Mod',
      files: ['Example.dll'],
      attachedUserLibs: [],
      source: 'thunderstore',
      sourceVersion: '1.2.3',
      author: 'Example Author',
      managed: true,
      installedIn: [],
      availableRuntimes: ['IL2CPP'],
      storageIdsByRuntime: { IL2CPP: 'stored-1' },
      installedInByRuntime: {},
      filesByRuntime: {},
    } satisfies ModLibraryEntry;
    expect(findExactCollectionLibraryEntry(file, [entry], 'IL2CPP')).toBe(entry);
  });
});
