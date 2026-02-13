import { useCallback, useEffect, useMemo, useState } from 'react';
import { ApiService } from '../services/api';
import { ConfirmOverlay } from './ConfirmOverlay';
import type { ModLibraryEntry, ModLibraryResult, NexusMod, NexusModFile } from '../types';

interface ThunderstorePackage {
  uuid4: string;
  name: string;
  owner: string;
  package_url: string;
  date_created: string;
  date_updated: string;
  rating_score: number;
  is_pinned: boolean;
  is_deprecated: boolean;
  categories?: string[];
  full_name: string;
  versions: Array<{
    name: string;
    full_name: string;
    date_created: string;
    date_updated: string;
    uuid4: string;
    version_number: string;
    dependencies: string[];
    download_url: string;
    downloads: number;
    file_size: number;
    description?: string;
  }>;
}

type ThunderstoreRuntime = 'IL2CPP' | 'Mono';

interface ThunderstorePackageGroup {
  key: string;
  name: string;
  owner: string;
  packageUrl: string;
  packagesByRuntime: Partial<Record<ThunderstoreRuntime, ThunderstorePackage>>;
}

interface DownloadedModGroup {
  key: string;
  displayName: string;
  managed: boolean;
  entries: ModLibraryEntry[];
  storageIds: string[];
  installedIn: string[];
  availableRuntimes: Array<'IL2CPP' | 'Mono'>;
  author?: string;
  sourceVersion?: string;
  updateAvailable?: boolean;
  remoteVersion?: string;
}

const runtimeSuffixPatterns = [
  /\s*[\(\[]\s*(mono|il2cpp)\s*[\)\]]\s*$/i,
  /\s*[_-]\s*(mono|il2cpp)\s*$/i,
  /\s+(mono|il2cpp)\s*$/i,
];

const normalizeThunderstoreName = (name: string): string => {
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
};

const parseThunderstoreSourceId = (sourceId?: string): { owner: string; name: string } => {
  if (!sourceId) {
    return { owner: '', name: '' };
  }
  const [owner, ...rest] = sourceId.split('/');
  return { owner: owner || '', name: rest.join('/') };
};

const buildDownloadedGroups = (downloaded: ModLibraryEntry[]): DownloadedModGroup[] => {
  const groups = new Map<string, {
    key: string;
    displayName: string;
    entries: ModLibraryEntry[];
    storageIds: string[];
    installedIn: Set<string>;
    availableRuntimes: Set<'IL2CPP' | 'Mono'>;
    managedStates: Set<boolean>;
    authors: Set<string>;
    sourceVersions: Set<string>;
    updateAvailable: boolean;
    remoteVersions: Set<string>;
  }>();

  downloaded.forEach(entry => {
    let key = entry.storageId;
    let displayName = entry.displayName;

    if (entry.source === 'thunderstore') {
      const { owner, name } = parseThunderstoreSourceId(entry.sourceId);
      const baseName = normalizeThunderstoreName(name || entry.displayName);
      const ownerKey = owner.toLowerCase();
      key = `thunderstore::${ownerKey}::${baseName.toLowerCase()}`;
      displayName = baseName || entry.displayName;
    }

    const group = groups.get(key) || {
      key,
      displayName,
      entries: [],
      storageIds: [],
      installedIn: new Set<string>(),
      availableRuntimes: new Set<'IL2CPP' | 'Mono'>(),
      managedStates: new Set<boolean>(),
      authors: new Set<string>(),
      sourceVersions: new Set<string>(),
      updateAvailable: false,
      remoteVersions: new Set<string>(),
    };

    group.entries.push(entry);
    group.storageIds.push(entry.storageId);
    entry.installedIn.forEach(envId => group.installedIn.add(envId));
    entry.availableRuntimes.forEach(runtime => group.availableRuntimes.add(runtime));
    group.managedStates.add(entry.managed);
    if (entry.author) group.authors.add(entry.author);
    if (entry.sourceVersion) group.sourceVersions.add(entry.sourceVersion);
    if (entry.updateAvailable) group.updateAvailable = true;
    if (entry.remoteVersion) group.remoteVersions.add(entry.remoteVersion);

    groups.set(key, group);
  });

  return Array.from(groups.values())
    .map(group => ({
      key: group.key,
      displayName: group.displayName,
      managed: group.managedStates.size === 1 && group.managedStates.has(true),
      entries: group.entries,
      storageIds: group.storageIds,
      installedIn: Array.from(group.installedIn),
      availableRuntimes: Array.from(group.availableRuntimes),
      author: group.authors.size === 1 ? Array.from(group.authors)[0] : undefined,
      sourceVersion: group.sourceVersions.size === 1 ? Array.from(group.sourceVersions)[0] : undefined,
      updateAvailable: group.updateAvailable,
      remoteVersion: group.remoteVersions.size === 1 ? Array.from(group.remoteVersions)[0] : undefined,
    }))
    .sort((a, b) => a.displayName.toLowerCase().localeCompare(b.displayName.toLowerCase()));
};

interface Props {
  isOpen: boolean;
  onClose: () => void;
}

interface RuntimePromptState {
  title: string;
  message: string;
  onSelect: (runtime: 'IL2CPP' | 'Mono' | 'Both') => void;
}

export function ModLibraryOverlay({ isOpen, onClose }: Props) {
  const [library, setLibrary] = useState<ModLibraryResult | null>(null);
  const [loadingLibrary, setLoadingLibrary] = useState(false);
  const [selectedModIds, setSelectedModIds] = useState<Set<string>>(new Set());
  const [confirmOverlay, setConfirmOverlay] = useState<{ isOpen: boolean; title: string; message: string; onConfirm: () => void }>({
    isOpen: false,
    title: '',
    message: '',
    onConfirm: () => {},
  });

  const [searchSource, setSearchSource] = useState<'thunderstore' | 'nexusmods'>('thunderstore');
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<ThunderstorePackageGroup[]>([]);
  const [searching, setSearching] = useState(false);
  const [showSearchResults, setShowSearchResults] = useState(false);

  const [nexusModsSearchQuery, setNexusModsSearchQuery] = useState('');
  const [nexusModsSearchResults, setNexusModsSearchResults] = useState<NexusMod[]>([]);
  const [searchingNexusMods, setSearchingNexusMods] = useState(false);
  const [showNexusModsResults, setShowNexusModsResults] = useState(false);
  const [nexusModsFiles, setNexusModsFiles] = useState<Map<number, NexusModFile[]>>(new Map());
  const [nexusModsLoading, setNexusModsLoading] = useState<Set<number>>(new Set());

  const [downloading, setDownloading] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [runtimePrompt, setRuntimePrompt] = useState<RuntimePromptState | null>(null);

  const [s1apiLatestRelease, setS1apiLatestRelease] = useState<{
    tag_name: string;
    name: string;
    published_at: string;
    prerelease: boolean;
    download_url: string | null;
  } | null>(null);
  const [mlvscanLatestRelease, setMlvscanLatestRelease] = useState<{
    tag_name: string;
    name: string;
    published_at: string;
    prerelease: boolean;
    download_url: string | null;
  } | null>(null);
  const [s1apiReleases, setS1apiReleases] = useState<Array<{
    tag_name: string;
    name: string;
    published_at: string;
    prerelease: boolean;
    download_url: string | null;
    body?: string;
  }>>([]);
  const [mlvscanReleases, setMlvscanReleases] = useState<Array<{
    tag_name: string;
    name: string;
    published_at: string;
    prerelease: boolean;
    download_url: string | null;
    body?: string;
  }>>([]);
  const [loadingS1APIReleases, setLoadingS1APIReleases] = useState(false);
  const [loadingMlvscanReleases, setLoadingMlvscanReleases] = useState(false);
  const [showS1APIVersionSelector, setShowS1APIVersionSelector] = useState(false);
  const [showMlvscanVersionSelector, setShowMlvscanVersionSelector] = useState(false);
  const [selectedS1APIVersion, setSelectedS1APIVersion] = useState('');
  const [selectedMlvscanVersion, setSelectedMlvscanVersion] = useState('');
  const [downloadingS1API, setDownloadingS1API] = useState(false);
  const [downloadingMlvscan, setDownloadingMlvscan] = useState(false);

  const downloadedGroups = useMemo(
    () => buildDownloadedGroups(library?.downloaded ?? []),
    [library]
  );

  const handleLoadNexusModFiles = useCallback(async (modId: number) => {
    setNexusModsLoading(prev => new Set(prev).add(modId));
    try {
      const files = await ApiService.getNexusModsModFiles('schedule1', modId);
      setNexusModsFiles(prev => {
        const next = new Map(prev);
        next.set(modId, files);
        return next;
      });
    } catch (err) {
      console.warn('Failed to load Nexus mod files:', err);
    } finally {
      setNexusModsLoading(prev => {
        const next = new Set(prev);
        next.delete(modId);
        return next;
      });
    }
  }, []);

  useEffect(() => {
    if (!isOpen) return;
    const loadLibrary = async () => {
      setLoadingLibrary(true);
      try {
        const data = await ApiService.getModLibrary();
        setLibrary(data);
      } catch (err) {
        console.error('Failed to load mod library:', err);
        setLibrary({ downloaded: [] });
      } finally {
        setLoadingLibrary(false);
      }
    };
    loadLibrary();
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const loadLatestReleases = async () => {
      try {
        const [s1apiLatest, mlvscanLatest] = await Promise.all([
          ApiService.getS1APILatestRelease(''),
          ApiService.getMLVScanLatestRelease('')
        ]);
        setS1apiLatestRelease(s1apiLatest);
        setMlvscanLatestRelease(mlvscanLatest);
      } catch (err) {
        console.warn('Failed to load S1API/MLVScan latest releases:', err);
      }
    };
    loadLatestReleases();
  }, [isOpen]);

  useEffect(() => {
    if (!showNexusModsResults || nexusModsSearchResults.length === 0) return;
    const toLoad = nexusModsSearchResults.filter(
      modItem => !nexusModsFiles.has(modItem.mod_id) && !nexusModsLoading.has(modItem.mod_id)
    );
    toLoad.forEach(modItem => handleLoadNexusModFiles(modItem.mod_id));
  }, [showNexusModsResults, nexusModsSearchResults, nexusModsFiles, nexusModsLoading, handleLoadNexusModFiles]);

  const toggleGroupSelection = (storageIds: string[]) => {
    setSelectedModIds(prev => {
      const next = new Set(prev);
      const allSelected = storageIds.every(id => next.has(id));
      if (allSelected) {
        storageIds.forEach(id => next.delete(id));
      } else {
        storageIds.forEach(id => next.add(id));
      }
      return next;
    });
  };

  const handleSearch = async () => {
    if (!searchQuery.trim()) return;
    setSearching(true);
    setShowSearchResults(false);
    try {
      const [il2cppResult, monoResult] = await Promise.all([
        ApiService.searchThunderstore('schedule-i', searchQuery.trim(), 'IL2CPP'),
        ApiService.searchThunderstore('schedule-i', searchQuery.trim(), 'Mono'),
      ]);

      const merged = new Map<string, ThunderstorePackageGroup>();
      const addRuntime = (pkg: ThunderstorePackage, runtime: ThunderstoreRuntime) => {
        const baseName = normalizeThunderstoreName(pkg.name || pkg.full_name || '');
        const owner = pkg.owner || '';
        const key = `${owner.toLowerCase()}::${baseName.toLowerCase()}`;
        const existing = merged.get(key);
        if (existing) {
          existing.packagesByRuntime[runtime] = pkg;
          if (!existing.packageUrl && pkg.package_url) {
            existing.packageUrl = pkg.package_url;
          }
          return;
        }

        merged.set(key, {
          key,
          name: baseName || pkg.name || pkg.full_name || 'Unknown Mod',
          owner,
          packageUrl: pkg.package_url || '',
          packagesByRuntime: {
            [runtime]: pkg,
          },
        });
      };

      (il2cppResult.packages || []).forEach((pkg: ThunderstorePackage) => addRuntime(pkg, 'IL2CPP'));
      (monoResult.packages || []).forEach((pkg: ThunderstorePackage) => addRuntime(pkg, 'Mono'));

      setSearchResults(Array.from(merged.values()));
      setShowSearchResults(true);
    } catch (err) {
      console.error('Error searching Thunderstore:', err);
      setSearchResults([]);
    } finally {
      setSearching(false);
    }
  };

  const handleSearchNexusMods = async () => {
    if (!nexusModsSearchQuery.trim()) return;
    setSearchingNexusMods(true);
    setShowNexusModsResults(false);
    try {
      const result = await ApiService.searchNexusMods('schedule1', nexusModsSearchQuery.trim());
      setNexusModsSearchResults(result.mods || []);
      setShowNexusModsResults(true);
    } catch (err) {
      console.error('Error searching NexusMods:', err);
      setNexusModsSearchResults([]);
    } finally {
      setSearchingNexusMods(false);
    }
  };

  const loadS1APIReleases = async () => {
    setLoadingS1APIReleases(true);
    try {
      const releases = await ApiService.getS1APIReleases('');
      setS1apiReleases(releases);
      if (releases.length > 0) {
        setSelectedS1APIVersion(releases[0].tag_name);
      }
    } catch (err) {
      console.error('Failed to load S1API releases:', err);
    } finally {
      setLoadingS1APIReleases(false);
    }
  };

  const loadMlvscanReleases = async () => {
    setLoadingMlvscanReleases(true);
    try {
      const releases = await ApiService.getMLVScanReleases('');
      setMlvscanReleases(releases);
      if (releases.length > 0) {
        setSelectedMlvscanVersion(releases[0].tag_name);
      }
    } catch (err) {
      console.error('Failed to load MLVScan releases:', err);
    } finally {
      setLoadingMlvscanReleases(false);
    }
  };

  const handleDownloadS1APIClick = () => {
    loadS1APIReleases();
    setShowS1APIVersionSelector(true);
  };

  const handleDownloadMlvscanClick = () => {
    loadMlvscanReleases();
    setShowMlvscanVersionSelector(true);
  };

  const handleS1APIVersionSelected = async () => {
    if (!selectedS1APIVersion) {
      return;
    }
    setShowS1APIVersionSelector(false);
    setDownloadingS1API(true);
    try {
      await ApiService.downloadS1APIToLibrary(selectedS1APIVersion);
      const updated = await ApiService.getModLibrary();
      setLibrary(updated);
    } catch (err) {
      console.error('Failed to download S1API:', err);
    } finally {
      setDownloadingS1API(false);
      setSelectedS1APIVersion('');
    }
  };

  const handleMlvscanVersionSelected = async () => {
    if (!selectedMlvscanVersion) {
      return;
    }
    setShowMlvscanVersionSelector(false);
    setDownloadingMlvscan(true);
    try {
      await ApiService.downloadMLVScanToLibrary(selectedMlvscanVersion);
      const updated = await ApiService.getModLibrary();
      setLibrary(updated);
    } catch (err) {
      console.error('Failed to download MLVScan:', err);
    } finally {
      setDownloadingMlvscan(false);
      setSelectedMlvscanVersion('');
    }
  };

  const getEntryStorageIds = (entry: ModLibraryEntry): string[] => {
    const ids = Object.values(entry.storageIdsByRuntime || {}).filter(Boolean) as string[];
    const unique = Array.from(new Set(ids));
    if (unique.length > 0) return unique;
    return entry.storageId ? [entry.storageId] : [];
  };

  const handleDeleteDownloadedGroup = async (group: DownloadedModGroup) => {
    setConfirmOverlay({
      isOpen: true,
      title: 'Delete Downloaded Files',
      message: group.entries.some(entry => entry.installedIn.length > 0)
        ? 'This will remove the mod from all environments and delete the downloaded files. Continue?'
        : 'Delete the downloaded files from the library? This cannot be undone.',
      onConfirm: async () => {
        setConfirmOverlay({ isOpen: false, title: '', message: '', onConfirm: () => {} });
        setDeleting(group.key);
        try {
          for (const entry of group.entries) {
            const storageIds = getEntryStorageIds(entry);
            for (const storageId of storageIds) {
              await ApiService.deleteDownloadedMod(storageId);
            }
          }
          const updated = await ApiService.getModLibrary();
          setLibrary(updated);
          setSelectedModIds(prev => {
            const next = new Set(prev);
            group.storageIds.forEach(id => next.delete(id));
            return next;
          });
        } catch (err) {
          console.error('Failed to delete downloaded mod files:', err);
        } finally {
          setDeleting(null);
        }
      },
    });
  };

  const handleBulkDelete = async () => {
    if (!library || selectedModIds.size === 0) return;
    const selectedEntries = library.downloaded.filter(entry => selectedModIds.has(entry.storageId));
    setConfirmOverlay({
      isOpen: true,
      title: 'Delete Downloaded Files',
      message: selectedEntries.some(entry => entry.installedIn.length > 0)
        ? 'Some selected mods are installed in environments. This will remove them from those environments and delete the downloaded files. Continue?'
        : 'Delete selected downloaded files from the library? This cannot be undone.',
      onConfirm: async () => {
        setConfirmOverlay({ isOpen: false, title: '', message: '', onConfirm: () => {} });
        setDeleting('bulk');
        try {
          for (const entry of selectedEntries) {
            const storageIds = getEntryStorageIds(entry);
            for (const storageId of storageIds) {
              await ApiService.deleteDownloadedMod(storageId);
            }
          }
          const updated = await ApiService.getModLibrary();
          setLibrary(updated);
          setSelectedModIds(new Set());
        } catch (err) {
          console.error('Failed to bulk delete downloaded mods:', err);
        } finally {
          setDeleting(null);
        }
      },
    });
  };

  const handleDownloadThunderstore = async (pkg: ThunderstorePackageGroup) => {
    const hasIl2cpp = Boolean(pkg.packagesByRuntime.IL2CPP);
    const hasMono = Boolean(pkg.packagesByRuntime.Mono);
    const runDownload = async (runtime: 'IL2CPP' | 'Mono' | 'Both') => {
      setDownloading(pkg.key);
      try {
        if (runtime === 'Both') {
          if (pkg.packagesByRuntime.IL2CPP) {
            await ApiService.downloadThunderstoreToLibrary(pkg.packagesByRuntime.IL2CPP.uuid4, 'IL2CPP');
          }
          if (pkg.packagesByRuntime.Mono) {
            await ApiService.downloadThunderstoreToLibrary(pkg.packagesByRuntime.Mono.uuid4, 'Mono');
          }
        } else if (pkg.packagesByRuntime[runtime]) {
          await ApiService.downloadThunderstoreToLibrary(pkg.packagesByRuntime[runtime]!.uuid4, runtime);
        }
        const updated = await ApiService.getModLibrary();
        setLibrary(updated);
      } catch (err) {
        console.error('Failed to download Thunderstore mod:', err);
      } finally {
        setDownloading(null);
      }
    };

    if (!hasIl2cpp && !hasMono) {
      setRuntimePrompt({
        title: 'Select Runtime',
        message: `Select the runtime for ${pkg.name}.`,
        onSelect: runDownload,
      });
      return;
    }

    if (hasIl2cpp && hasMono) {
      runDownload('Both');
      return;
    }

    runDownload(hasIl2cpp ? 'IL2CPP' : 'Mono');
  };

  const selectNexusFileForRuntime = (files: NexusModFile[], runtime: 'IL2CPP' | 'Mono') => {
    const runtimeLower = runtime.toLowerCase();
    const otherRuntime = runtimeLower === 'il2cpp' ? 'mono' : 'il2cpp';
    const runtimeFiles = files.filter((f: any) => {
      const fileName = (f.file_name || f.name || '').toLowerCase();
      return fileName.includes(runtimeLower);
    });

    if (runtimeFiles.length > 0) {
      return runtimeFiles.find((f: any) => f.is_primary) || runtimeFiles[0];
    }

    const compatibleFiles = files.filter((f: any) => {
      const fileName = (f.file_name || f.name || '').toLowerCase();
      return !fileName.includes(otherRuntime);
    });

    return compatibleFiles.find((f: any) => f.is_primary) || compatibleFiles[0] || files[0];
  };

  const handleDownloadNexusMod = async (modId: number) => {
    const files = nexusModsFiles.get(modId) || [];
    if (files.length === 0) {
      await handleLoadNexusModFiles(modId);
      return;
    }

    const fileNames = files.map(file => (file.file_name || file.name || '').toLowerCase());
    const hasIl2cpp = fileNames.some(name => name.includes('il2cpp'));
    const hasMono = fileNames.some(name => name.includes('mono'));

    const runDownload = async (runtime: 'IL2CPP' | 'Mono' | 'Both') => {
      setDownloading(`nexus-${modId}`);
      try {
        if (runtime === 'Both') {
          const il2cppFile = selectNexusFileForRuntime(files, 'IL2CPP');
          const monoFile = selectNexusFileForRuntime(files, 'Mono');
          if (il2cppFile?.file_id) {
            await ApiService.downloadNexusModToLibrary(modId, il2cppFile.file_id, 'IL2CPP');
          }
          if (monoFile?.file_id && monoFile?.file_id !== il2cppFile?.file_id) {
            await ApiService.downloadNexusModToLibrary(modId, monoFile.file_id, 'Mono');
          }
        } else {
          const targetFile = selectNexusFileForRuntime(files, runtime);
          if (!targetFile?.file_id) return;
          await ApiService.downloadNexusModToLibrary(modId, targetFile.file_id, runtime);
        }
        const updated = await ApiService.getModLibrary();
        setLibrary(updated);
      } catch (err) {
        console.error('Failed to download Nexus mod:', err);
      } finally {
        setDownloading(null);
      }
    };

    if (!hasIl2cpp && !hasMono) {
      setRuntimePrompt({
        title: 'Select Runtime',
        message: 'Select the runtime for this Nexus mod download.',
        onSelect: runDownload,
      });
      return;
    }

    if (hasIl2cpp && hasMono) {
      runDownload('Both');
      return;
    }

    runDownload(hasIl2cpp ? 'IL2CPP' : 'Mono');
  };

  const s1apiEntry = library?.downloaded.find(entry =>
    (entry.sourceId && entry.sourceId.toLowerCase() === 'ifbars/s1api') ||
    entry.displayName.toLowerCase() === 's1api'
  );
  const mlvscanEntry = library?.downloaded.find(entry =>
    (entry.sourceId && entry.sourceId.toLowerCase() === 'ifbars/mlvscan') ||
    entry.displayName.toLowerCase() === 'mlvscan'
  );

  const s1apiInLibrary = !!s1apiEntry;
  const mlvscanInLibrary = !!mlvscanEntry;

  const compareVersions = (a: string, b: string): number => {
    const normalize = (v: string) => v.replace(/^v/i, '').split('.').map(n => parseInt(n, 10) || 0);
    const aParts = normalize(a);
    const bParts = normalize(b);
    const maxLen = Math.max(aParts.length, bParts.length);
    for (let i = 0; i < maxLen; i++) {
      const aVal = aParts[i] ?? 0;
      const bVal = bParts[i] ?? 0;
      if (aVal < bVal) return -1;
      if (aVal > bVal) return 1;
    }
    return 0;
  };

  const s1apiInstalledVersion = s1apiEntry?.sourceVersion;
  const s1apiLatestVersion = s1apiLatestRelease?.tag_name;
  const s1apiNeedsUpdate = s1apiInLibrary && s1apiInstalledVersion && s1apiLatestVersion && compareVersions(s1apiInstalledVersion, s1apiLatestVersion) < 0;

  const mlvscanInstalledVersion = mlvscanEntry?.sourceVersion;
  const mlvscanLatestVersion = mlvscanLatestRelease?.tag_name;
  const mlvscanNeedsUpdate = mlvscanInLibrary && mlvscanInstalledVersion && mlvscanLatestVersion && compareVersions(mlvscanInstalledVersion, mlvscanLatestVersion) < 0;

  const s1apiActionLabel = s1apiInLibrary ? (s1apiNeedsUpdate ? 'Update' : 'Downloaded') : 'Download';
  const mlvscanActionLabel = mlvscanInLibrary ? (mlvscanNeedsUpdate ? 'Update' : 'Downloaded') : 'Download';

  if (!isOpen) return null;

  return (
    <>
      <ConfirmOverlay
        isOpen={confirmOverlay.isOpen}
        onClose={() => setConfirmOverlay({ isOpen: false, title: '', message: '', onConfirm: () => {} })}
        onConfirm={confirmOverlay.onConfirm}
        title={confirmOverlay.title}
        message={confirmOverlay.message}
        isNested
      />
      {runtimePrompt && (
        <div className="modal-overlay modal-overlay-nested" onClick={() => setRuntimePrompt(null)}>
          <div
            className="modal-content modal-content-nested"
            onClick={(e) => e.stopPropagation()}
            style={{ maxWidth: '420px' }}
          >
            <div className="modal-header">
              <h2>{runtimePrompt.title}</h2>
              <button className="modal-close" onClick={() => setRuntimePrompt(null)}>×</button>
            </div>
            <div style={{ padding: '1rem 1.25rem 1.25rem' }}>
              <p style={{ marginTop: 0, color: '#ccc' }}>{runtimePrompt.message}</p>
              <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end' }}>
                <button
                  className="btn btn-secondary"
                  onClick={() => {
                    const handler = runtimePrompt.onSelect;
                    setRuntimePrompt(null);
                    handler('Mono');
                  }}
                >
                  Mono
                </button>
                <button
                  className="btn btn-secondary"
                  onClick={() => {
                    const handler = runtimePrompt.onSelect;
                    setRuntimePrompt(null);
                    handler('IL2CPP');
                  }}
                >
                  IL2CPP
                </button>
                <button
                  className="btn btn-primary"
                  onClick={() => {
                    const handler = runtimePrompt.onSelect;
                    setRuntimePrompt(null);
                    handler('Both');
                  }}
                >
                  Both
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
      <div className="modal-overlay" onClick={onClose}>
        <div className="modal-content mods-overlay" onClick={e => e.stopPropagation()}>
          <div className="modal-header">
            <h2>Mod Library</h2>
            <button className="modal-close" onClick={onClose}>×</button>
          </div>

          <div className="mods-content">
            <div style={{ padding: '17px 1.25rem 1rem', borderBottom: '1px solid #3a3a3a' }}>
              <div style={{ marginBottom: '1rem', color: '#888', fontSize: '0.85rem' }}>
                Download mods to the library, then install them from each environment's mod list.
              </div>

              <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '0.75rem' }}>
                <button
                  onClick={() => {
                    setSearchSource('thunderstore');
                    setShowSearchResults(false);
                    setShowNexusModsResults(false);
                  }}
                  className="btn"
                  style={{
                    flex: 1,
                    backgroundColor: searchSource === 'thunderstore' ? '#4a90e2' : '#2a2a2a',
                    color: searchSource === 'thunderstore' ? '#fff' : '#888',
                    border: `1px solid ${searchSource === 'thunderstore' ? '#4a90e2' : '#3a3a3a'}`,
                    padding: '0.5rem',
                    fontSize: '0.875rem'
                  }}
                >
                  <i className="fas fa-cloud-download-alt" style={{ marginRight: '0.5rem' }}></i>
                  Thunderstore
                </button>
                <button
                  onClick={() => {
                    setSearchSource('nexusmods');
                    setShowSearchResults(false);
                    setShowNexusModsResults(false);
                  }}
                  className="btn"
                  style={{
                    flex: 1,
                    backgroundColor: searchSource === 'nexusmods' ? '#ea4335' : '#2a2a2a',
                    color: searchSource === 'nexusmods' ? '#fff' : '#888',
                    border: `1px solid ${searchSource === 'nexusmods' ? '#ea4335' : '#3a3a3a'}`,
                    padding: '0.5rem',
                    fontSize: '0.875rem'
                  }}
                >
                  <i className="fas fa-download" style={{ marginRight: '0.5rem' }}></i>
                  NexusMods
                </button>
              </div>

              <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                <div style={{ flex: 1, position: 'relative' }}>
                  <input
                    type="text"
                    placeholder={searchSource === 'thunderstore'
                      ? 'Search Thunderstore mods...'
                      : 'Search NexusMods mods...'}
                    value={searchSource === 'thunderstore' ? searchQuery : nexusModsSearchQuery}
                    onChange={e => {
                      if (searchSource === 'thunderstore') {
                        setSearchQuery(e.target.value);
                      } else {
                        setNexusModsSearchQuery(e.target.value);
                      }
                    }}
                    style={{
                      width: '100%',
                      padding: '0.5rem 2.5rem 0.5rem 0.75rem',
                      backgroundColor: '#1a1a1a',
                      border: '1px solid #3a3a3a',
                      borderRadius: '4px',
                      color: '#fff',
                      fontSize: '0.875rem'
                    }}
                  />
                  <i
                    className="fas fa-search"
                    style={{
                      position: 'absolute',
                      right: '0.75rem',
                      top: '50%',
                      transform: 'translateY(-50%)',
                      color: '#888',
                      cursor: 'pointer'
                    }}
                    onClick={searchSource === 'thunderstore' ? handleSearch : handleSearchNexusMods}
                  ></i>
                </div>
                <button
                  onClick={searchSource === 'thunderstore' ? handleSearch : handleSearchNexusMods}
                  className="btn btn-primary"
                  disabled={(searchSource === 'thunderstore' ? searching : searchingNexusMods) ||
                           (searchSource === 'thunderstore' ? !searchQuery.trim() : !nexusModsSearchQuery.trim())}
                  style={{ whiteSpace: 'nowrap' }}
                >
                  {(searchSource === 'thunderstore' ? searching : searchingNexusMods) ? (
                    <>
                      <i className="fas fa-spinner fa-spin" style={{ marginRight: '0.5rem' }}></i>
                      Searching...
                    </>
                  ) : (
                    <>
                      <i className="fas fa-search" style={{ marginRight: '0.5rem' }}></i>
                      Search
                    </>
                  )}
                </button>
              </div>
            </div>

            <div style={{ padding: '0 1.25rem 1rem', borderBottom: '1px solid #3a3a3a' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem' }}>
                <h3 style={{ margin: 0 }}>Featured Downloads</h3>
              </div>
              <div style={{ display: 'grid', gap: '0.75rem' }}>
                <div
                  className="mod-card"
                  style={{
                    padding: '0.75rem',
                    backgroundColor: '#2a2a2a',
                    borderRadius: '6px',
                    border: '1px solid #3a3a3a',
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    gap: '1rem'
                  }}
                >
                  <div style={{ flex: 1 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.35rem' }}>
                      <strong style={{ fontSize: '1rem' }}>S1API</strong>
                      {s1apiNeedsUpdate ? (
                        <span style={{
                          fontSize: '0.7rem',
                          padding: '0.2rem 0.45rem',
                          borderRadius: '4px',
                          backgroundColor: 'rgba(255, 170, 0, 0.15)',
                          color: '#ffaa00',
                          border: '1px solid rgba(255, 170, 0, 0.3)'
                        }}>
                          <i className="fas fa-arrow-up" style={{ marginRight: '0.25rem' }}></i>
                          Update Available
                        </span>
                      ) : s1apiInLibrary ? (
                        <span style={{
                          fontSize: '0.7rem',
                          padding: '0.2rem 0.45rem',
                          borderRadius: '4px',
                          backgroundColor: 'rgba(74, 222, 128, 0.15)',
                          color: '#4ade80',
                          border: '1px solid rgba(74, 222, 128, 0.3)'
                        }}>
                          <i className="fas fa-check" style={{ marginRight: '0.25rem' }}></i>
                          Up to Date
                        </span>
                      ) : (
                        <span style={{
                          fontSize: '0.7rem',
                          padding: '0.2rem 0.45rem',
                          borderRadius: '4px',
                          backgroundColor: 'rgba(136,136,136,0.125)',
                          color: '#888',
                          border: '1px solid rgba(136,136,136,0.25)'
                        }}>
                          Not Downloaded
                        </span>
                      )}
                    </div>
                    <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap', fontSize: '0.8rem', color: '#888' }}>
                      <span>
                        <i className="fab fa-github" style={{ marginRight: '0.35rem', color: '#6e5494' }}></i>
                        GitHub Release
                      </span>
                      {s1apiInstalledVersion && (
                        <span>
                          <i className="fas fa-tag" style={{ marginRight: '0.35rem' }}></i>
                          Installed: {s1apiInstalledVersion}
                        </span>
                      )}
                      {s1apiLatestRelease && (
                        <span style={s1apiNeedsUpdate ? { color: '#ffaa00' } : {}}>
                          <i className="fas fa-cloud" style={{ marginRight: '0.35rem' }}></i>
                          Latest: {s1apiLatestRelease.tag_name}
                        </span>
                      )}
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: '0.5rem' }}>
                    <button
                      className={`btn btn-small ${s1apiNeedsUpdate ? 'btn-warning' : 'btn-primary'}`}
                      onClick={handleDownloadS1APIClick}
                      disabled={downloadingS1API}
                      title={s1apiNeedsUpdate ? 'Update S1API to the latest version' : 'Download S1API to the library'}
                    >
                      {downloadingS1API ? (
                        <i className="fas fa-spinner fa-spin"></i>
                      ) : (
                        <>
                          <i className={`fas ${s1apiNeedsUpdate ? 'fa-arrow-up' : 'fa-download'}`}></i>
                          <span style={{ marginLeft: '0.5rem' }}>{s1apiActionLabel}</span>
                        </>
                      )}
                    </button>
                    <a
                      href="https://github.com/ifBars/S1API"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="btn btn-secondary btn-small"
                      style={{ textDecoration: 'none', textAlign: 'center' }}
                      title="View on GitHub"
                    >
                      <i className="fab fa-github"></i>
                      <span style={{ marginLeft: '0.5rem' }}>View</span>
                    </a>
                  </div>
                </div>

                <div
                  className="mod-card"
                  style={{
                    padding: '0.75rem',
                    backgroundColor: '#2a2a2a',
                    borderRadius: '6px',
                    border: '1px solid #3a3a3a',
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    gap: '1rem'
                  }}
                >
                  <div style={{ flex: 1 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.35rem' }}>
                      <strong style={{ fontSize: '1rem' }}>
                        <i className="fas fa-shield-alt" style={{ color: '#4a90e2', marginRight: '0.35rem' }}></i>
                        MLVScan
                      </strong>
                      {mlvscanNeedsUpdate ? (
                        <span style={{
                          fontSize: '0.7rem',
                          padding: '0.2rem 0.45rem',
                          borderRadius: '4px',
                          backgroundColor: 'rgba(255, 170, 0, 0.15)',
                          color: '#ffaa00',
                          border: '1px solid rgba(255, 170, 0, 0.3)'
                        }}>
                          <i className="fas fa-arrow-up" style={{ marginRight: '0.25rem' }}></i>
                          Update Available
                        </span>
                      ) : mlvscanInLibrary ? (
                        <span style={{
                          fontSize: '0.7rem',
                          padding: '0.2rem 0.45rem',
                          borderRadius: '4px',
                          backgroundColor: 'rgba(74, 222, 128, 0.15)',
                          color: '#4ade80',
                          border: '1px solid rgba(74, 222, 128, 0.3)'
                        }}>
                          <i className="fas fa-check" style={{ marginRight: '0.25rem' }}></i>
                          Up to Date
                        </span>
                      ) : (
                        <span style={{
                          fontSize: '0.7rem',
                          padding: '0.2rem 0.45rem',
                          borderRadius: '4px',
                          backgroundColor: 'rgba(136,136,136,0.125)',
                          color: '#888',
                          border: '1px solid rgba(136,136,136,0.25)'
                        }}>
                          Not Downloaded
                        </span>
                      )}
                    </div>
                    <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap', fontSize: '0.8rem', color: '#888' }}>
                      <span>
                        <i className="fab fa-github" style={{ marginRight: '0.35rem', color: '#6e5494' }}></i>
                        GitHub Release
                      </span>
                      {mlvscanInstalledVersion && (
                        <span>
                          <i className="fas fa-tag" style={{ marginRight: '0.35rem' }}></i>
                          Installed: {mlvscanInstalledVersion}
                        </span>
                      )}
                      {mlvscanLatestRelease && (
                        <span style={mlvscanNeedsUpdate ? { color: '#ffaa00' } : {}}>
                          <i className="fas fa-cloud" style={{ marginRight: '0.35rem' }}></i>
                          Latest: {mlvscanLatestRelease.tag_name}
                        </span>
                      )}
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: '0.5rem' }}>
                    <button
                      className={`btn btn-small ${mlvscanNeedsUpdate ? 'btn-warning' : 'btn-primary'}`}
                      onClick={handleDownloadMlvscanClick}
                      disabled={downloadingMlvscan}
                      title={mlvscanNeedsUpdate ? 'Update MLVScan to the latest version' : 'Download MLVScan to the library'}
                    >
                      {downloadingMlvscan ? (
                        <i className="fas fa-spinner fa-spin"></i>
                      ) : (
                        <>
                          <i className={`fas ${mlvscanNeedsUpdate ? 'fa-arrow-up' : 'fa-download'}`}></i>
                          <span style={{ marginLeft: '0.5rem' }}>{mlvscanActionLabel}</span>
                        </>
                      )}
                    </button>
                    <a
                      href="https://github.com/ifBars/MLVScan"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="btn btn-secondary btn-small"
                      style={{ textDecoration: 'none', textAlign: 'center' }}
                      title="View on GitHub"
                    >
                      <i className="fab fa-github"></i>
                      <span style={{ marginLeft: '0.5rem' }}>View</span>
                    </a>
                  </div>
                </div>
              </div>
            </div>

            {(showSearchResults || showNexusModsResults) && (
              <div style={{ padding: '0 1.25rem 1rem' }}>
                {showSearchResults && searchResults.length > 0 && (
                  <div style={{ display: 'grid', gap: '0.75rem' }}>
                    {searchResults.map(pkg => {
                      const runtimes: ThunderstoreRuntime[] = [];
                      if (pkg.packagesByRuntime.IL2CPP) runtimes.push('IL2CPP');
                      if (pkg.packagesByRuntime.Mono) runtimes.push('Mono');
                      return (
                        <div key={pkg.key} className="mod-card" style={{ padding: '0.75rem', backgroundColor: '#2a2a2a', borderRadius: '6px', border: '1px solid #3a3a3a' }}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '1rem' }}>
                            <div>
                              <strong>{pkg.name}</strong>
                              <div style={{ fontSize: '0.8rem', color: '#888' }}>{pkg.owner}</div>
                              <div style={{ marginTop: '0.35rem', display: 'flex', gap: '0.35rem', flexWrap: 'wrap' }}>
                                {runtimes.length > 0 ? runtimes.map(runtime => (
                                  <span key={`${pkg.key}-${runtime}`} style={{
                                    fontSize: '0.7rem',
                                    padding: '0.15rem 0.4rem',
                                    borderRadius: '4px',
                                    backgroundColor: '#4a90e220',
                                    color: '#4a90e2',
                                    border: '1px solid #4a90e240'
                                  }}>
                                    {runtime}
                                  </span>
                                )) : (
                                  <span style={{
                                    fontSize: '0.7rem',
                                    padding: '0.15rem 0.4rem',
                                    borderRadius: '4px',
                                    backgroundColor: '#6c757d',
                                    color: '#fff'
                                  }}>
                                    Runtime Unknown
                                  </span>
                                )}
                              </div>
                            </div>
                            <button
                              className="btn btn-primary btn-small"
                              disabled={downloading === pkg.key}
                              onClick={() => handleDownloadThunderstore(pkg)}
                            >
                              {downloading === pkg.key ? 'Downloading...' : 'Download'}
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}

                {showNexusModsResults && nexusModsSearchResults.length > 0 && (
                  <div style={{ display: 'grid', gap: '0.75rem' }}>
                    {nexusModsSearchResults.map(mod => {
                      const files = nexusModsFiles.get(mod.mod_id) ?? null;
                      const loading = nexusModsLoading.has(mod.mod_id);
                      const fileNames = files ? files.map(file => (file.file_name || file.name || '').toLowerCase()) : [];
                      const hasIl2cpp = fileNames.some(name => name.includes('il2cpp'));
                      const hasMono = fileNames.some(name => name.includes('mono'));
                      return (
                        <div key={mod.mod_id} className="mod-card" style={{ padding: '0.75rem', backgroundColor: '#2a2a2a', borderRadius: '6px', border: '1px solid #3a3a3a' }}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '1rem' }}>
                            <div>
                              <strong>{mod.name}</strong>
                              <div style={{ fontSize: '0.8rem', color: '#888' }}>{mod.author}</div>
                              <div style={{ marginTop: '0.35rem', display: 'flex', gap: '0.35rem', flexWrap: 'wrap' }}>
                                {hasIl2cpp && (
                                  <span style={{
                                    fontSize: '0.7rem',
                                    padding: '0.15rem 0.4rem',
                                    borderRadius: '4px',
                                    backgroundColor: '#4a90e220',
                                    color: '#4a90e2',
                                    border: '1px solid #4a90e240'
                                  }}>
                                    IL2CPP
                                  </span>
                                )}
                                {hasMono && (
                                  <span style={{
                                    fontSize: '0.7rem',
                                    padding: '0.15rem 0.4rem',
                                    borderRadius: '4px',
                                    backgroundColor: '#4a90e220',
                                    color: '#4a90e2',
                                    border: '1px solid #4a90e240'
                                  }}>
                                    Mono
                                  </span>
                                )}
                                {!hasIl2cpp && !hasMono && (
                                  <span style={{
                                    fontSize: '0.7rem',
                                    padding: '0.15rem 0.4rem',
                                    borderRadius: '4px',
                                    backgroundColor: '#6c757d',
                                    color: '#fff'
                                  }}>
                                    Runtime Unknown
                                  </span>
                                )}
                              </div>
                            </div>
                            <button
                              className="btn btn-primary btn-small"
                              disabled={downloading === `nexus-${mod.mod_id}` || loading}
                              onClick={() => handleDownloadNexusMod(mod.mod_id)}
                            >
                              {downloading === `nexus-${mod.mod_id}` ? 'Downloading...' : loading ? 'Loading...' : 'Download'}
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}

            <div style={{ padding: '0.75rem 1.25rem 1rem', borderTop: '1px solid #3a3a3a' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem' }}>
                <h3 style={{ margin: 0 }}>Downloaded Mods</h3>
                <div style={{ display: 'flex', gap: '0.5rem' }}>
                  <button
                    className="btn btn-danger btn-small"
                    disabled={selectedModIds.size === 0 || deleting === 'bulk'}
                    onClick={handleBulkDelete}
                  >
                    {deleting === 'bulk' ? 'Deleting...' : 'Delete Selected'}
                  </button>
                </div>
              </div>
              {loadingLibrary && <div style={{ color: '#888' }}>Loading mod library...</div>}
              {!loadingLibrary && downloadedGroups.length === 0 && (
                <div style={{ color: '#888' }}>No downloaded mods yet.</div>
              )}
              {!loadingLibrary && downloadedGroups.length ? (
                <div style={{ display: 'grid', gap: '0.75rem' }}>
                  {downloadedGroups.map(group => (
                    <div key={group.key} className="mod-card" style={{ padding: '0.75rem', backgroundColor: '#2a2a2a', borderRadius: '6px', border: '1px solid #3a3a3a' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '1rem' }}>
                        <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flex: 1 }}>
                          <input
                            type="checkbox"
                            checked={group.storageIds.every(id => selectedModIds.has(id))}
                            onChange={() => toggleGroupSelection(group.storageIds)}
                          />
                          <strong>{group.displayName}</strong>
                          <span style={{
                            fontSize: '0.7rem',
                            padding: '0.15rem 0.4rem',
                            borderRadius: '4px',
                            backgroundColor: group.managed ? '#28a745' : '#6c757d',
                            color: '#fff'
                          }}>
                            {group.managed ? 'Managed' : 'External'}
                          </span>
                          {group.updateAvailable && (
                            <span style={{
                              fontSize: '0.7rem',
                              padding: '0.15rem 0.4rem',
                              borderRadius: '4px',
                              backgroundColor: 'rgba(255, 170, 0, 0.15)',
                              color: '#ffaa00',
                              border: '1px solid rgba(255, 170, 0, 0.3)'
                            }}>
                              <i className="fas fa-arrow-up" style={{ marginRight: '0.25rem' }}></i>
                              Update Available
                            </span>
                          )}
                        </label>
                        <button
                          className="btn btn-danger btn-small"
                          disabled={deleting === group.key}
                          onClick={() => handleDeleteDownloadedGroup(group)}
                          title="Delete downloaded files from library"
                        >
                          {deleting === group.key ? 'Deleting...' : 'Delete Files'}
                        </button>
                      </div>
                      <div style={{ fontSize: '0.8rem', color: '#888', marginTop: '0.35rem', display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
                        {group.author && (
                          <span>
                            <i className="fas fa-user" style={{ marginRight: '0.25rem', opacity: 0.7 }}></i>
                            {group.author}
                          </span>
                        )}
                        {group.sourceVersion && (
                          <span>
                            <i className="fas fa-tag" style={{ marginRight: '0.25rem', opacity: 0.7 }}></i>
                            v{group.sourceVersion}
                          </span>
                        )}
                        {group.updateAvailable && group.remoteVersion && (
                          <span style={{ color: '#ffaa00' }}>
                            <i className="fas fa-cloud-download-alt" style={{ marginRight: '0.25rem' }}></i>
                            Latest: v{group.remoteVersion}
                          </span>
                        )}
                        <span>
                          <i className="fas fa-folder" style={{ marginRight: '0.25rem', opacity: 0.7 }}></i>
                          {group.installedIn.length ? group.installedIn.length : '0'} env(s)
                        </span>
                        {group.availableRuntimes?.map(runtime => (
                          <span
                            key={`${group.key}-${runtime}`}
                            style={{
                              fontSize: '0.7rem',
                              padding: '0.15rem 0.4rem',
                              borderRadius: '4px',
                              backgroundColor: '#4a90e220',
                              color: '#4a90e2',
                              border: '1px solid #4a90e240'
                            }}
                          >
                            {runtime}
                          </span>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          </div>
        </div>
      </div>

      {showS1APIVersionSelector && (
        <div className="modal-overlay modal-overlay-nested" onClick={(e) => {
          if (e.target === e.currentTarget) {
            setShowS1APIVersionSelector(false);
            setSelectedS1APIVersion('');
          }
        }}>
          <div
            className="modal-content modal-content-nested"
            onClick={(e) => e.stopPropagation()}
            style={{ maxWidth: '600px', maxHeight: '80vh', display: 'flex', flexDirection: 'column' }}
          >
            <div className="modal-header">
              <h2>Select S1API Version</h2>
              <button className="modal-close" onClick={() => {
                setShowS1APIVersionSelector(false);
                setSelectedS1APIVersion('');
              }}>×</button>
            </div>

            <div style={{ padding: '1.25rem', display: 'flex', flexDirection: 'column', gap: '0.75rem', overflow: 'hidden' }}>
              <p style={{ margin: 0, color: '#ccc', fontSize: '0.9rem', lineHeight: '1.5' }}>
                S1API is game version specific. Select the version that matches your game version.
              </p>

              {loadingS1APIReleases ? (
                <div style={{ padding: '2rem', textAlign: 'center', color: '#888' }}>
                  <i className="fas fa-spinner fa-spin" style={{ fontSize: '2rem', marginBottom: '1rem' }}></i>
                  <p>Loading releases...</p>
                </div>
              ) : s1apiReleases.length === 0 ? (
                <div style={{ padding: '2rem', textAlign: 'center', color: '#888' }}>
                  <p>No releases found</p>
                </div>
              ) : (
                <>
                  <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
                    <div style={{ display: 'grid', gap: '0.5rem' }}>
                      {s1apiReleases.map((release) => (
                        <label
                          key={release.tag_name}
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: '0.75rem',
                            padding: '0.75rem',
                            borderRadius: '6px',
                            backgroundColor: selectedS1APIVersion === release.tag_name ? '#2a2a2a' : '#1f1f1f',
                            border: selectedS1APIVersion === release.tag_name ? '1px solid #4a90e2' : '1px solid #3a3a3a',
                            cursor: 'pointer'
                          }}
                        >
                          <input
                            type="radio"
                            name="s1api-version"
                            checked={selectedS1APIVersion === release.tag_name}
                            onChange={() => setSelectedS1APIVersion(release.tag_name)}
                          />
                          <div>
                            <div style={{ fontWeight: 600 }}>{release.tag_name}</div>
                            <div style={{ fontSize: '0.8rem', color: '#888' }}>{release.published_at}</div>
                          </div>
                        </label>
                      ))}
                    </div>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.5rem' }}>
                    <button
                      className="btn btn-secondary"
                      onClick={() => {
                        setShowS1APIVersionSelector(false);
                        setSelectedS1APIVersion('');
                      }}
                    >
                      Cancel
                    </button>
                    <button
                      className="btn btn-primary"
                      disabled={!selectedS1APIVersion || downloadingS1API}
                      onClick={handleS1APIVersionSelected}
                    >
                      {downloadingS1API ? 'Downloading...' : 'Download'}
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {showMlvscanVersionSelector && (
        <div className="modal-overlay modal-overlay-nested" onClick={(e) => {
          if (e.target === e.currentTarget) {
            setShowMlvscanVersionSelector(false);
            setSelectedMlvscanVersion('');
          }
        }}>
          <div
            className="modal-content modal-content-nested"
            onClick={(e) => e.stopPropagation()}
            style={{ maxWidth: '600px', maxHeight: '80vh', display: 'flex', flexDirection: 'column' }}
          >
            <div className="modal-header">
              <h2>Select MLVScan Version</h2>
              <button className="modal-close" onClick={() => {
                setShowMlvscanVersionSelector(false);
                setSelectedMlvscanVersion('');
              }}>×</button>
            </div>

            <div style={{ padding: '1.25rem', display: 'flex', flexDirection: 'column', gap: '0.75rem', overflow: 'hidden' }}>
              {loadingMlvscanReleases ? (
                <div style={{ padding: '2rem', textAlign: 'center', color: '#888' }}>
                  <i className="fas fa-spinner fa-spin" style={{ fontSize: '2rem', marginBottom: '1rem' }}></i>
                  <p>Loading releases...</p>
                </div>
              ) : mlvscanReleases.length === 0 ? (
                <div style={{ padding: '2rem', textAlign: 'center', color: '#888' }}>
                  <p>No releases found</p>
                </div>
              ) : (
                <>
                  <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
                    <div style={{ display: 'grid', gap: '0.5rem' }}>
                      {mlvscanReleases.map((release) => (
                        <label
                          key={release.tag_name}
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: '0.75rem',
                            padding: '0.75rem',
                            borderRadius: '6px',
                            backgroundColor: selectedMlvscanVersion === release.tag_name ? '#2a2a2a' : '#1f1f1f',
                            border: selectedMlvscanVersion === release.tag_name ? '1px solid #4a90e2' : '1px solid #3a3a3a',
                            cursor: 'pointer'
                          }}
                        >
                          <input
                            type="radio"
                            name="mlvscan-version"
                            checked={selectedMlvscanVersion === release.tag_name}
                            onChange={() => setSelectedMlvscanVersion(release.tag_name)}
                          />
                          <div>
                            <div style={{ fontWeight: 600 }}>{release.tag_name}</div>
                            <div style={{ fontSize: '0.8rem', color: '#888' }}>{release.published_at}</div>
                          </div>
                        </label>
                      ))}
                    </div>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.5rem' }}>
                    <button
                      className="btn btn-secondary"
                      onClick={() => {
                        setShowMlvscanVersionSelector(false);
                        setSelectedMlvscanVersion('');
                      }}
                    >
                      Cancel
                    </button>
                    <button
                      className="btn btn-primary"
                      disabled={!selectedMlvscanVersion || downloadingMlvscan}
                      onClick={handleMlvscanVersionSelected}
                    >
                      {downloadingMlvscan ? 'Downloading...' : 'Download'}
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
