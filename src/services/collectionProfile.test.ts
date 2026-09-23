import { describe, expect, it } from 'vitest';
import type { ModLibraryEntry, NexusCollectionModFile, NexusModFile } from '../types';
import {
  findCollectionThunderstoreMatches,
  findExactCollectionLibraryEntry,
  inferNexusFileRuntime,
  normalizeCollectionIdentity,
  normalizeCollectionVersion,
  resolveCollectionNexusFileForRuntime,
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

function nexusFile(fileId: number, fileName: string, version: string): NexusModFile {
  return {
    file_id: fileId,
    name: fileName,
    version,
    category_id: 1,
    category_name: 'MAIN',
    is_primary: true,
    size: 1024,
    file_name: fileName,
    uploaded_timestamp: fileId,
    mod_version: version,
  };
}

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

  it('resolves a separate runtime file only at the collection-requested version', () => {
    const runtimeFile = {
      ...file,
      fileId: 7588,
      fileName: 'BetterCounterOfferUI IL2CPP',
      modName: 'Better Counter-Offer UI',
      version: '3.4.1',
    };
    const files = [
      nexusFile(7588, 'BetterCounterOfferUI IL2CPP', '3.4.1'),
      nexusFile(7589, 'BetterCounterOffer MONO', '3.4.1'),
      nexusFile(9000, 'BetterCounterOffer MONO', '3.5.0'),
    ];

    expect(resolveCollectionNexusFileForRuntime(runtimeFile, files, 'IL2CPP')).toMatchObject({
      fileId: 7588,
      isCollectionFile: true,
    });
    expect(resolveCollectionNexusFileForRuntime(runtimeFile, files, 'Mono')).toMatchObject({
      fileId: 7589,
      version: '3.4.1',
      isCollectionFile: false,
    });
  });

  it('reports no runtime resolution instead of substituting another version', () => {
    const runtimeFile = {
      ...file,
      fileName: 'Example Mod IL2CPP',
      version: '1.2.3',
    };
    const files = [
      nexusFile(100, 'Example Mod IL2CPP', '1.2.3'),
      nexusFile(101, 'Example Mod Mono', '1.2.4'),
    ];

    expect(resolveCollectionNexusFileForRuntime(runtimeFile, files, 'Mono')).toBeNull();
    expect(inferNexusFileRuntime('Example Mod il2 cpp build')).toBe('IL2CPP');
  });
});
