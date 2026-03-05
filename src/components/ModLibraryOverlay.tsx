import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import { convertFileSrc } from '@tauri-apps/api/core';
import { ApiService } from '../services/api';
import { ConfirmOverlay } from './ConfirmOverlay';
import { onModMetadataRefreshStatus } from '../services/events';
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
    icon?: string;
  }>;
  icon?: string;
  icon_url?: string;
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
  installedInByRuntime: Partial<Record<'IL2CPP' | 'Mono', string[]>>;
  availableRuntimes: Array<'IL2CPP' | 'Mono'>;
  author?: string;
  sourceVersion?: string;
  updateAvailable?: boolean;
  remoteVersion?: string;
}

type DownloadedFilter = 'all' | 'updates' | 'managed' | 'external' | 'installed';

interface LibraryModViewState {
  id: string;
  name: string;
  source: string;
  author?: string;
  summary?: string;
  iconUrl?: string;
  iconCachePath?: string;
  sourceUrl?: string;
  downloads?: number;
  likesOrEndorsements?: number;
  updatedAt?: string;
  tags?: string[];
  installedVersion?: string;
  latestVersion?: string;
  addedAt?: number;
  installedAt?: number;
  kind: 'downloaded' | 'thunderstore' | 'nexusmods';
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

const safeExternalUrl = (raw?: string): string | undefined => {
  if (!raw) {
    return undefined;
  }

  try {
    const parsed = new URL(raw);
    return parsed.protocol === 'https:' ? parsed.toString() : undefined;
  } catch {
    return undefined;
  }
};

const handleCardActivationKeyDown = (
  event: ReactKeyboardEvent<HTMLElement>,
  onActivate: () => void
) => {
  if (event.key === 'Enter' || event.key === ' ' || event.key === 'Spacebar') {
    event.preventDefault();
    onActivate();
  }
};

const resolveImageSource = (pathOrUrl?: string): string | undefined => {
  if (!pathOrUrl) {
    return undefined;
  }
  if (pathOrUrl.startsWith('asset:')) {
    return pathOrUrl;
  }
  if (pathOrUrl.startsWith('http://') || pathOrUrl.startsWith('https://')) {
    return pathOrUrl;
  }
  if (pathOrUrl.startsWith('file://')) {
    try {
      const url = new URL(pathOrUrl);
      let filePath = decodeURIComponent(url.pathname || '');
      if (/^\/[A-Za-z]:\//.test(filePath)) {
        filePath = filePath.slice(1);
      }
      return convertFileSrc(filePath);
    } catch {
      const fallback = pathOrUrl.replace(/^file:\/\/+/, '');
      return convertFileSrc(decodeURIComponent(fallback));
    }
  }
  const normalized = pathOrUrl.replace(/\\/g, '/');
  if (/^[A-Za-z]:\//.test(normalized)) {
    return convertFileSrc(pathOrUrl);
  }
  if (normalized.startsWith('/')) {
    return convertFileSrc(pathOrUrl);
  }
  return normalized;
};

const normalizeVersionToken = (value?: string): string => {
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
};

const formatVersionTag = (value?: string): string => {
  const normalized = normalizeVersionToken(value);
  return normalized ? `v${normalized}` : 'unknown';
};

const compareVersionTokensDesc = (a?: string, b?: string): number => {
  const aParts = normalizeVersionToken(a).split('.').map(v => parseInt(v, 10) || 0);
  const bParts = normalizeVersionToken(b).split('.').map(v => parseInt(v, 10) || 0);
  const len = Math.max(aParts.length, bParts.length);
  for (let i = 0; i < len; i++) {
    const av = aParts[i] || 0;
    const bv = bParts[i] || 0;
    if (av !== bv) {
      return bv - av;
    }
  }
  return 0;
};

const compareVersions = (a: string, b: string): number => {
  const normalize = (v: string) => normalizeVersionToken(v).split('.').map(n => parseInt(n, 10) || 0);
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

const areVersionsEquivalent = (a?: string, b?: string): boolean => {
  const normalizedA = normalizeVersionToken(a);
  const normalizedB = normalizeVersionToken(b);
  if (!normalizedA || !normalizedB) {
    return false;
  }
  return compareVersionTokensDesc(normalizedA, normalizedB) === 0;
};

const buildDownloadedGroups = (downloaded: ModLibraryEntry[]): DownloadedModGroup[] => {
  const groups = new Map<string, {
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
  }>();

  downloaded.forEach(entry => {
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
    entry.installedIn.forEach(envId => group.installedIn.add(envId));
    (entry.installedInByRuntime?.IL2CPP || []).forEach(envId => group.installedInByRuntime.IL2CPP.add(envId));
    (entry.installedInByRuntime?.Mono || []).forEach(envId => group.installedInByRuntime.Mono.add(envId));
    entry.availableRuntimes.forEach(runtime => group.availableRuntimes.add(runtime));
    group.managedStates.add(entry.managed);
    if (entry.author) group.authors.add(entry.author);
    if (entry.sourceVersion) group.sourceVersions.add(entry.sourceVersion);
    if (entry.updateAvailable) group.updateAvailable = true;
    if (entry.remoteVersion) group.remoteVersions.add(entry.remoteVersion);

    groups.set(key, group);
  });

  return Array.from(groups.values())
    .map(group => {
      const remoteVersions = Array.from(group.remoteVersions).sort((a, b) => compareVersionTokensDesc(a, b));
      const remoteVersion = remoteVersions[0];
      const hasRemoteVersion = normalizeVersionToken(remoteVersion).length > 0;
      const hasRemoteDownloaded = hasRemoteVersion && group.entries.some(entry => {
        return areVersionsEquivalent(entry.sourceVersion || entry.installedVersion, remoteVersion);
      });
      const hasFlaggedUpdate = group.updateAvailable;
      const updateAvailable = hasRemoteVersion ? !hasRemoteDownloaded : hasFlaggedUpdate;

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
        sourceVersion: group.sourceVersions.size === 1 ? Array.from(group.sourceVersions)[0] : undefined,
        updateAvailable,
        remoteVersion,
      };
    })
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
  const [showDiscovery, setShowDiscovery] = useState(true);

  const [nexusModsSearchQuery, setNexusModsSearchQuery] = useState('');
  const [nexusModsSearchResults, setNexusModsSearchResults] = useState<NexusMod[]>([]);
  const [searchingNexusMods, setSearchingNexusMods] = useState(false);
  const [showNexusModsResults, setShowNexusModsResults] = useState(false);
  const [nexusModsFiles, setNexusModsFiles] = useState<Map<number, NexusModFile[]>>(new Map());
  const [nexusModsLoading, setNexusModsLoading] = useState<Set<number>>(new Set());

  const [downloading, setDownloading] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [activatingGroup, setActivatingGroup] = useState<string | null>(null);
  const [updatingGroup, setUpdatingGroup] = useState<string | null>(null);
  const [openVersionMenuGroup, setOpenVersionMenuGroup] = useState<string | null>(null);
  const [selectedStorageByGroup, setSelectedStorageByGroup] = useState<Record<string, string>>({});
  const [runtimePrompt, setRuntimePrompt] = useState<RuntimePromptState | null>(null);
  const [downloadedFilter, setDownloadedFilter] = useState<DownloadedFilter>('all');
  const [downloadedSearch, setDownloadedSearch] = useState('');
  const [activeModView, setActiveModView] = useState<LibraryModViewState | null>(null);
  const libraryScrollContainerRef = useRef<HTMLDivElement | null>(null);
  const libraryScrollTopRef = useRef(0);
  const metadataRefreshRunningRef = useRef(false);

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

  useEffect(() => {
    if (!isOpen) {
      setActiveModView(null);
    }
  }, [isOpen]);

  const closeModView = useCallback(() => {
    setActiveModView(null);
    window.requestAnimationFrame(() => {
      if (libraryScrollContainerRef.current) {
        libraryScrollContainerRef.current.scrollTop = libraryScrollTopRef.current;
      }
    });
  }, []);

  const openModView = useCallback((nextView: LibraryModViewState) => {
    if (libraryScrollContainerRef.current) {
      libraryScrollTopRef.current = libraryScrollContainerRef.current.scrollTop;
    }
    setActiveModView(nextView);
  }, []);

  const getLatestDownloadedVersionForGroup = useCallback((group: DownloadedModGroup | undefined): string | undefined => {
    if (!group) {
      return undefined;
    }

    const sortedByVersion = [...group.entries].sort((a, b) =>
      compareVersionTokensDesc(a.sourceVersion || a.installedVersion, b.sourceVersion || b.installedVersion)
    );

    const latestEntry = sortedByVersion[0];
    return latestEntry?.sourceVersion || latestEntry?.installedVersion || undefined;
  }, []);

  const s1apiGroup = downloadedGroups.find(group => {
    const sourceIds = group.entries
      .map(entry => (entry.sourceId || '').toLowerCase())
      .filter(Boolean);
    return sourceIds.includes('ifbars/s1api') || normalizeThunderstoreName(group.displayName).toLowerCase() === 's1api';
  });

  const mlvscanGroup = downloadedGroups.find(group => {
    const sourceIds = group.entries
      .map(entry => (entry.sourceId || '').toLowerCase())
      .filter(Boolean);
    return sourceIds.includes('ifbars/mlvscan') || normalizeThunderstoreName(group.displayName).toLowerCase() === 'mlvscan';
  });

  const s1apiInLibrary = !!s1apiGroup;
  const mlvscanInLibrary = !!mlvscanGroup;
  const s1apiInstalledVersion = getLatestDownloadedVersionForGroup(s1apiGroup);
  const s1apiLatestVersion = s1apiLatestRelease?.tag_name;
  const s1apiNeedsUpdate = s1apiInLibrary && s1apiInstalledVersion && s1apiLatestVersion && compareVersions(s1apiInstalledVersion, s1apiLatestVersion) < 0;

  const mlvscanInstalledVersion = getLatestDownloadedVersionForGroup(mlvscanGroup);
  const mlvscanLatestVersion = mlvscanLatestRelease?.tag_name;
  const mlvscanNeedsUpdate = mlvscanInLibrary && mlvscanInstalledVersion && mlvscanLatestVersion && compareVersions(mlvscanInstalledVersion, mlvscanLatestVersion) < 0;

  const isGroupUpdateAvailable = useCallback((group: DownloadedModGroup): boolean => {
    const sourceIds = group.entries
      .map(entry => (entry.sourceId || '').toLowerCase())
      .filter(Boolean);
    const normalizedName = normalizeThunderstoreName(group.displayName).toLowerCase();

    const isS1apiGroup = sourceIds.includes('ifbars/s1api') || normalizedName === 's1api';
    if (isS1apiGroup && !!s1apiInstalledVersion && !!s1apiLatestVersion) {
      return !!s1apiNeedsUpdate;
    }

    const isMlvscanGroup = sourceIds.includes('ifbars/mlvscan') || normalizedName === 'mlvscan';
    if (isMlvscanGroup && !!mlvscanInstalledVersion && !!mlvscanLatestVersion) {
      return !!mlvscanNeedsUpdate;
    }

    return !!group.updateAvailable;
  }, [
    mlvscanInstalledVersion,
    mlvscanLatestVersion,
    mlvscanNeedsUpdate,
    s1apiInstalledVersion,
    s1apiLatestVersion,
    s1apiNeedsUpdate,
    getLatestDownloadedVersionForGroup,
  ]);

  const downloadedSummary = useMemo(() => {
    const total = downloadedGroups.length;
    const updates = downloadedGroups.filter(group => isGroupUpdateAvailable(group)).length;
    const installed = downloadedGroups.filter(group => group.installedIn.length > 0).length;
    const managed = downloadedGroups.filter(group => group.managed).length;
    return { total, updates, installed, managed };
  }, [downloadedGroups, isGroupUpdateAvailable]);

  const filteredDownloadedGroups = useMemo(() => {
    const query = downloadedSearch.trim().toLowerCase();
    return downloadedGroups.filter(group => {
      if (downloadedFilter === 'updates' && !isGroupUpdateAvailable(group)) return false;
      if (downloadedFilter === 'managed' && !group.managed) return false;
      if (downloadedFilter === 'external' && group.managed) return false;
      if (downloadedFilter === 'installed' && group.installedIn.length === 0) return false;

      if (!query) return true;
      const author = group.author?.toLowerCase() || '';
      const version = group.sourceVersion?.toLowerCase() || '';
      return (
        group.displayName.toLowerCase().includes(query)
        || author.includes(query)
        || version.includes(query)
      );
    });
  }, [downloadedGroups, downloadedFilter, downloadedSearch, isGroupUpdateAvailable]);

  useEffect(() => {
    setSelectedStorageByGroup(prev => {
      const next: Record<string, string> = { ...prev };

      for (const group of downloadedGroups) {
        const current = next[group.key];
        if (current && group.entries.some(entry => entry.storageId === current)) {
          continue;
        }

        const sorted = [...group.entries].sort((a, b) => compareVersionTokensDesc(a.sourceVersion || a.installedVersion, b.sourceVersion || b.installedVersion));
        const installed = sorted.find(entry => entry.installedIn.length > 0);
        const selected = installed || sorted[0];
        if (selected) {
          next[group.key] = selected.storageId;
        }
      }

      return next;
    });
  }, [downloadedGroups]);

  useEffect(() => {
    if (!openVersionMenuGroup) {
      return;
    }

    const onDocumentMouseDown = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (!target?.closest('[data-version-switcher]')) {
        setOpenVersionMenuGroup(null);
      }
    };

    document.addEventListener('mousedown', onDocumentMouseDown);
    return () => {
      document.removeEventListener('mousedown', onDocumentMouseDown);
    };
  }, [openVersionMenuGroup]);

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

  const refreshLibrary = useCallback(async () => {
    const data = await ApiService.getModLibrary();
    setLibrary(data);
  }, []);

  /** Notify ModsOverlay (and other views) that the library was updated - e.g. after download */
  const notifyLibraryUpdated = useCallback(() => {
    sessionStorage.setItem('library-needs-refresh', '1');
    window.dispatchEvent(new CustomEvent('library-updated'));
  }, []);

  const notifyModUpdateStateChanged = useCallback(() => {
    window.dispatchEvent(new CustomEvent('mod-updates-checked'));
  }, []);

  useEffect(() => {
    if (!isOpen) return;
    const loadLibrary = async () => {
      setLoadingLibrary(true);
      try {
        await refreshLibrary();
      } catch (err) {
        console.error('Failed to load mod library:', err);
        setLibrary({ downloaded: [] });
      } finally {
        setLoadingLibrary(false);
      }
    };
    loadLibrary();
  }, [isOpen, refreshLibrary]);

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

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    let disposed = false;
    let unlisten: (() => void) | null = null;
    void onModMetadataRefreshStatus((data) => {
      const running = Boolean(data.running) || (data.activeCount || 0) > 0;
      const wasRunning = metadataRefreshRunningRef.current;
      metadataRefreshRunningRef.current = running;

      if (wasRunning && !running) {
        void refreshLibrary();
      }
    }).then((fn) => {
      if (disposed) {
        fn();
        return;
      }
      unlisten = fn;
    });

    return () => {
      disposed = true;
      unlisten?.();
      metadataRefreshRunningRef.current = false;
    };
  }, [isOpen, refreshLibrary]);

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

  const runThunderstoreSearch = useCallback(async (query: string) => {
    if (!query.trim()) return;
    setSearching(true);
    setShowSearchResults(false);
    try {
      const [il2cppResult, monoResult] = await Promise.all([
        ApiService.searchThunderstore('schedule-i', query.trim(), 'IL2CPP'),
        ApiService.searchThunderstore('schedule-i', query.trim(), 'Mono'),
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
  }, []);

  const runNexusSearch = useCallback(async (query: string) => {
    if (!query.trim()) return;
    setSearchingNexusMods(true);
    setShowNexusModsResults(false);
    try {
      const result = await ApiService.searchNexusMods('schedule1', query.trim());
      setNexusModsSearchResults(result.mods || []);
      setShowNexusModsResults(true);
    } catch (err) {
      console.error('Error searching NexusMods:', err);
      setNexusModsSearchResults([]);
    } finally {
      setSearchingNexusMods(false);
    }
  }, []);

  const handleSearch = () => runThunderstoreSearch(searchQuery);

  const handleSearchNexusMods = () => runNexusSearch(nexusModsSearchQuery);

  const getEntryVersionLabel = useCallback((entry: ModLibraryEntry): string => {
    return entry.sourceVersion || entry.installedVersion || 'unknown';
  }, []);

  const activateGroupEntry = useCallback(async (group: DownloadedModGroup, targetEntry: ModLibraryEntry) => {
    if (group.installedIn.length === 0) {
      return;
    }

    setActivatingGroup(group.key);
    try {
      const allStorageIds = Array.from(new Set(
        group.entries.flatMap(entry => [
          entry.storageId,
          ...Object.values(entry.storageIdsByRuntime || {}),
        ].filter(Boolean) as string[])
      ));

      const runtimeTargets = (['IL2CPP', 'Mono'] as const)
        .map(runtime => ({ runtime, envIds: group.installedInByRuntime[runtime] || [] }))
        .filter((target): target is { runtime: 'IL2CPP' | 'Mono'; envIds: string[] } => target.envIds.length > 0);

      const handledEnvIds = new Set<string>();

      for (const target of runtimeTargets) {
        target.envIds.forEach(id => handledEnvIds.add(id));

        const selectedStorageId = targetEntry.storageIdsByRuntime?.[target.runtime] || targetEntry.storageId;
        if (!selectedStorageId) {
          continue;
        }

        const previousStorageIds = allStorageIds.filter(id => id !== selectedStorageId);
        for (const oldStorageId of previousStorageIds) {
          await ApiService.uninstallDownloadedMod(oldStorageId, target.envIds);
        }

        await ApiService.installDownloadedMod(selectedStorageId, target.envIds);
      }

      const remainingEnvIds = group.installedIn.filter(id => !handledEnvIds.has(id));
      if (remainingEnvIds.length > 0) {
        const fallbackStorageId = targetEntry.storageId;
        if (fallbackStorageId) {
          const previousStorageIds = allStorageIds.filter(id => id !== fallbackStorageId);
          for (const oldStorageId of previousStorageIds) {
            await ApiService.uninstallDownloadedMod(oldStorageId, remainingEnvIds);
          }
          await ApiService.installDownloadedMod(fallbackStorageId, remainingEnvIds);
        }
      }

      await refreshLibrary();
      setSelectedStorageByGroup(prev => ({ ...prev, [group.key]: targetEntry.storageId }));
      notifyModUpdateStateChanged();
    } finally {
      setActivatingGroup(null);
    }
  }, [refreshLibrary, notifyModUpdateStateChanged]);

  const findThunderstorePackageForRuntime = useCallback(async (
    sourceId: string,
    runtime: 'IL2CPP' | 'Mono'
  ): Promise<ThunderstorePackage | null> => {
    const parsed = parseThunderstoreSourceId(sourceId);
    if (!parsed.owner || !parsed.name) {
      return null;
    }

    const targetOwner = parsed.owner.toLowerCase();
    const targetName = normalizeThunderstoreName(parsed.name).toLowerCase();
    const searchResult = await ApiService.searchThunderstore('schedule-i', parsed.name, runtime);
    const packages = (searchResult?.packages || []) as ThunderstorePackage[];

    const exact = packages.find(pkg => {
      const pkgOwner = (pkg.owner || '').toLowerCase();
      const pkgName = normalizeThunderstoreName(pkg.name || pkg.full_name || '').toLowerCase();
      return pkgOwner === targetOwner && pkgName === targetName;
    });
    if (exact) {
      return exact;
    }

    const ownerMatch = packages.find(pkg => (pkg.owner || '').toLowerCase() === targetOwner);
    return ownerMatch || null;
  }, []);

  const pickNexusFileForVersionAndRuntime = useCallback((
    files: NexusModFile[],
    runtime: 'IL2CPP' | 'Mono',
    targetVersion?: string,
  ): NexusModFile | undefined => {
    if (!files.length) {
      return undefined;
    }

    const runtimeLower = runtime.toLowerCase();
    const runtimeFiles = files.filter(file => {
      const fileName = (file.file_name || file.name || '').toLowerCase();
      return fileName.includes(runtimeLower);
    });

    if (targetVersion) {
      const versionToken = normalizeVersionToken(targetVersion);
      const versionMatchInRuntime = runtimeFiles.find(file => {
        const fileVersion = normalizeVersionToken(file.version || file.mod_version || '');
        return fileVersion === versionToken;
      });
      if (versionMatchInRuntime) {
        return versionMatchInRuntime;
      }

      const versionMatchAny = files.find(file => {
        const fileVersion = normalizeVersionToken(file.version || file.mod_version || '');
        return fileVersion === versionToken;
      });
      if (versionMatchAny) {
        return versionMatchAny;
      }
    }

    return selectNexusFileForRuntime(files, runtime);
  }, []);

  const handleUpdateAndActivateGroup = useCallback(async (group: DownloadedModGroup) => {
    const sourceEntry = group.entries.find(entry => entry.source === 'thunderstore' || entry.source === 'nexusmods');
    if (!sourceEntry || !sourceEntry.source) {
      console.warn('No supported source found for group update');
      return;
    }

    const targetRuntimes = (['IL2CPP', 'Mono'] as const).filter(runtime => {
      return (group.installedInByRuntime[runtime] || []).length > 0;
    });
    const runtimesToUpdate: Array<'IL2CPP' | 'Mono'> = targetRuntimes.length > 0
      ? [...targetRuntimes]
      : (group.availableRuntimes.length > 0 ? [...group.availableRuntimes] : ['IL2CPP']);

    setUpdatingGroup(group.key);
    try {
      const downloadedStorageByRuntime: Partial<Record<'IL2CPP' | 'Mono', string>> = {};

      if (sourceEntry.source === 'thunderstore') {
        if (!sourceEntry.sourceId) {
          throw new Error('Missing Thunderstore source id for update');
        }

        for (const runtime of runtimesToUpdate) {
          const pkg = await findThunderstorePackageForRuntime(sourceEntry.sourceId, runtime);
          if (!pkg) {
            continue;
          }
          const result = await ApiService.downloadThunderstoreToLibrary(pkg.uuid4, runtime);
          if (result.storageId) {
            downloadedStorageByRuntime[runtime] = result.storageId;
          }
        }
      } else if (sourceEntry.source === 'nexusmods') {
        const modId = Number(sourceEntry.sourceId || '0');
        if (!Number.isFinite(modId) || modId <= 0) {
          throw new Error('Missing NexusMods mod id for update');
        }

        const files = await ApiService.getNexusModsModFiles('schedule1', modId);
        for (const runtime of runtimesToUpdate) {
          const file = pickNexusFileForVersionAndRuntime(files, runtime, group.remoteVersion);
          if (!file?.file_id) {
            continue;
          }
          const result = await ApiService.downloadNexusModToLibrary(modId, file.file_id, runtime);
          if (result.storageId) {
            downloadedStorageByRuntime[runtime] = result.storageId;
          }
        }
      }

      const nextLibrary = await ApiService.getModLibrary();
      setLibrary(nextLibrary);
      notifyLibraryUpdated();

      const refreshedGroup = buildDownloadedGroups(nextLibrary.downloaded).find(item => item.key === group.key);
      const selectedEntry = refreshedGroup?.entries.find(entry => {
        return (group.remoteVersion && areVersionsEquivalent(getEntryVersionLabel(entry), group.remoteVersion))
          || Object.values(entry.storageIdsByRuntime || {}).some(id => Object.values(downloadedStorageByRuntime).includes(id));
      })
        || refreshedGroup?.entries[0];

      if (refreshedGroup && selectedEntry) {
        await activateGroupEntry(refreshedGroup, selectedEntry);
      }
    } catch (err) {
      console.error('Failed to update and activate mod version:', err);
    } finally {
      setUpdatingGroup(null);
    }
  }, [activateGroupEntry, findThunderstorePackageForRuntime, getEntryVersionLabel, notifyLibraryUpdated, pickNexusFileForVersionAndRuntime]);

  const handleSelectVersion = useCallback(async (group: DownloadedModGroup, storageId: string) => {
    setSelectedStorageByGroup(prev => ({ ...prev, [group.key]: storageId }));
    setOpenVersionMenuGroup(null);

    const selectedEntry = group.entries.find(entry => entry.storageId === storageId) || group.entries[0];
    if (!selectedEntry) {
      return;
    }

    try {
      await activateGroupEntry(group, selectedEntry);
    } catch (err) {
      console.error('Failed to activate selected mod version:', err);
    }
  }, [activateGroupEntry]);

  const getSortedGroupEntries = useCallback((group: DownloadedModGroup) => {
    return [...group.entries].sort((a, b) =>
      compareVersionTokensDesc(a.sourceVersion || a.installedVersion, b.sourceVersion || b.installedVersion)
    );
  }, []);

  const getActiveEntryForGroup = useCallback((group: DownloadedModGroup) => {
    const sorted = getSortedGroupEntries(group);
    const selectedStorageId = selectedStorageByGroup[group.key];
    return sorted.find(entry => entry.storageId === selectedStorageId)
      || sorted.find(entry => entry.installedIn.length > 0)
      || sorted[0]
      || null;
  }, [getSortedGroupEntries, selectedStorageByGroup]);

  const handleStepGroupVersion = useCallback(async (group: DownloadedModGroup, direction: 'older' | 'newer') => {
    const sorted = getSortedGroupEntries(group);
    if (sorted.length <= 1) {
      return;
    }

    const active = getActiveEntryForGroup(group);
    const currentIndex = active ? sorted.findIndex(entry => entry.storageId === active.storageId) : 0;
    const nextIndex = direction === 'older' ? currentIndex + 1 : currentIndex - 1;
    if (nextIndex < 0 || nextIndex >= sorted.length) {
      return;
    }
    const nextEntry = sorted[nextIndex];

    if (!nextEntry) {
      return;
    }

    await handleSelectVersion(group, nextEntry.storageId);
  }, [getActiveEntryForGroup, getSortedGroupEntries, handleSelectVersion]);

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
      await refreshLibrary();
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
      await refreshLibrary();
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
          await refreshLibrary();
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
          await refreshLibrary();
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
        await refreshLibrary();
        notifyLibraryUpdated();
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
        await refreshLibrary();
        notifyLibraryUpdated();
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

  const openDownloadedModView = useCallback((group: DownloadedModGroup) => {
    const activeEntry = getActiveEntryForGroup(group) || group.entries[0];
    openModView({
      id: group.key,
      name: group.displayName,
      source: activeEntry?.source || 'unknown',
      author: group.author,
      summary: activeEntry?.summary,
      iconUrl: activeEntry?.iconUrl,
      iconCachePath: activeEntry?.iconCachePath,
      sourceUrl: activeEntry?.sourceUrl,
      downloads: activeEntry?.downloads,
      likesOrEndorsements: activeEntry?.likesOrEndorsements,
      updatedAt: activeEntry?.updatedAt,
      tags: activeEntry?.tags,
      installedVersion: activeEntry?.installedVersion || activeEntry?.sourceVersion,
      latestVersion: group.remoteVersion,
      addedAt: activeEntry?.libraryAddedAt,
      installedAt: activeEntry?.installedAt,
      kind: 'downloaded',
    });
  }, [getActiveEntryForGroup, openModView]);

  const openThunderstoreModView = useCallback((pkg: ThunderstorePackageGroup) => {
    const il2cpp = pkg.packagesByRuntime.IL2CPP;
    const mono = pkg.packagesByRuntime.Mono;
    const representative = il2cpp || mono;
    const version = representative?.versions?.[0];
    const downloads = representative?.versions?.reduce((sum, item) => sum + (item.downloads || 0), 0) || 0;

    openModView({
      id: pkg.key,
      name: pkg.name,
      source: 'thunderstore',
      author: pkg.owner,
      summary: version?.description,
      iconUrl: version?.icon || (representative as any)?.icon || (representative as any)?.icon_url,
      sourceUrl: pkg.packageUrl,
      downloads,
      likesOrEndorsements: representative?.rating_score || 0,
      updatedAt: representative?.date_updated,
      tags: representative?.categories || [],
      installedVersion: version?.version_number,
      kind: 'thunderstore',
    });
  }, [openModView]);

  const openNexusModView = useCallback((mod: NexusMod) => {
    openModView({
      id: String(mod.mod_id),
      name: mod.name,
      source: 'nexusmods',
      author: mod.author,
      summary: mod.summary,
      iconUrl: mod.picture_url,
      sourceUrl: `https://www.nexusmods.com/schedule1/mods/${mod.mod_id}`,
      downloads: mod.mod_downloads,
      likesOrEndorsements: mod.endorsement_count,
      updatedAt: mod.updated_time,
      installedVersion: mod.version,
      kind: 'nexusmods',
    });
  }, [openModView]);

  const renderCardIcon = useCallback((name: string, iconCachePath?: string, iconUrl?: string, variant: 'inline' | 'rail' = 'inline') => {
    const local = resolveImageSource(iconCachePath);
    const remote = resolveImageSource(iconUrl);
    const source = local || remote;
    const className = variant === 'rail' ? 'mod-card-icon-rail' : 'mod-card-icon-inline';

    if (!source) {
      return (
        <div className={`${className} mod-card-icon-fallback`}>
          <i className="fas fa-puzzle-piece"></i>
        </div>
      );
    }

    return (
      <div className={className}>
        <img
          src={source}
          alt={`${name} icon`}
          className="mod-card-icon-image"
          onError={(e) => {
            if (remote && e.currentTarget.src !== remote) {
              e.currentTarget.src = remote;
              return;
            }
            e.currentTarget.style.display = 'none';
          }}
        />
      </div>
    );
  }, []);

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
      <div
        className="mods-overlay mods-overlay--library"
        style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, position: 'relative' }}
      >
          <div className="modal-header">
            <h2>Mod Library</h2>
            <button className="btn btn-secondary btn-small" onClick={onClose}>
              <i className="fas fa-arrow-left" style={{ marginRight: '0.45rem' }}></i>
              Back
            </button>
          </div>

          <div className="mods-content" ref={libraryScrollContainerRef}>
            <div className="mods-toolbar" style={{ padding: '0.9rem 1.25rem 0.75rem', borderBottom: '1px solid #3a3a3a', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' }}>
              <div style={{ color: '#9aa4b2', fontSize: '0.85rem' }}>
                {downloadedSummary.total} downloaded, {downloadedSummary.updates} updates, {downloadedSummary.installed} installed, {downloadedSummary.managed} managed
              </div>
              <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                <button
                  className="btn btn-secondary btn-small"
                  onClick={() => setShowDiscovery(prev => !prev)}
                  title="Show or hide discovery results"
                >
                  <i className={`fas ${showDiscovery ? 'fa-chevron-up' : 'fa-chevron-down'}`} style={{ marginRight: '0.4rem' }}></i>
                  {showDiscovery ? 'Hide Browse' : 'Browse Mods'}
                </button>
                <button
                  className="btn btn-secondary btn-small"
                  onClick={refreshLibrary}
                  disabled={loadingLibrary}
                  title="Refresh library entries"
                >
                  <i className={`fas ${loadingLibrary ? 'fa-spinner fa-spin' : 'fa-sync-alt'}`} style={{ marginRight: '0.4rem' }}></i>
                  Refresh
                </button>
              </div>
            </div>

            {showDiscovery && (
            <>
            <div style={{ padding: '17px 1.25rem 1rem', borderBottom: '1px solid #3a3a3a' }}>
              <div style={{ marginBottom: '1rem', color: '#888', fontSize: '0.85rem' }}>
                Download to library, then install from each environment's Mods view.
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
                    onKeyDown={e => {
                      if (e.key === 'Enter') {
                        if (searchSource === 'thunderstore') handleSearch();
                        else handleSearchNexusMods();
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

            <div className="mods-section" style={{ padding: '0 1.25rem 1rem', borderBottom: '1px solid #3a3a3a' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem' }}>
                <h3 style={{ margin: 0 }}>Featured</h3>
              </div>
              <div style={{ display: 'grid', gap: '1rem' }}>
                <div
                  className="mod-card featured-mod-card"
                  style={{
                    padding: '1rem',
                    backgroundColor: '#2a2a2a',
                    borderRadius: '8px',
                    border: '1px solid #3a3a3a',
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'flex-start',
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
                          Installed: {formatVersionTag(s1apiInstalledVersion)}
                        </span>
                      )}
                      {s1apiLatestRelease && (
                        <span style={s1apiNeedsUpdate ? { color: '#ffaa00' } : {}}>
                          <i className="fas fa-cloud" style={{ marginRight: '0.35rem' }}></i>
                          Latest: {formatVersionTag(s1apiLatestRelease.tag_name)}
                        </span>
                      )}
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
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
                  className="mod-card featured-mod-card"
                  style={{
                    padding: '1rem',
                    backgroundColor: '#2a2a2a',
                    borderRadius: '8px',
                    border: '1px solid #3a3a3a',
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'flex-start',
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
                          Installed: {formatVersionTag(mlvscanInstalledVersion)}
                        </span>
                      )}
                      {mlvscanLatestRelease && (
                        <span style={mlvscanNeedsUpdate ? { color: '#ffaa00' } : {}}>
                          <i className="fas fa-cloud" style={{ marginRight: '0.35rem' }}></i>
                          Latest: {formatVersionTag(mlvscanLatestRelease.tag_name)}
                        </span>
                      )}
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
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
              <div className="mods-section" style={{ padding: '1rem 1.25rem 1rem' }}>
                {showSearchResults && searchResults.length > 0 && (
                  <div className="mods-grid" style={{ display: 'grid', gap: '1rem', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))' }}>
                    {searchResults.filter(pkg => {
                      // Hide mods that are already in the downloaded library
                      const tsKey = `thunderstore::${pkg.key}`;
                      return !downloadedGroups.some(g => g.key === tsKey);
                    }).map(pkg => {
                      const runtimes: ThunderstoreRuntime[] = [];
                      if (pkg.packagesByRuntime.IL2CPP) runtimes.push('IL2CPP');
                      if (pkg.packagesByRuntime.Mono) runtimes.push('Mono');
                      const representative = pkg.packagesByRuntime.IL2CPP || pkg.packagesByRuntime.Mono;
                      const latestVersion = representative?.versions?.[0];
                      const iconUrl = latestVersion?.icon || representative?.icon || representative?.icon_url;
                      const summary = latestVersion?.description;
                      const totalDownloads = representative?.versions?.reduce((sum, item) => sum + (item.downloads || 0), 0) || 0;
                      return (
                        <div
                          key={pkg.key}
                          className="mod-card store-card"
                          style={{ padding: '1rem', backgroundColor: '#2a2a2a', borderRadius: '8px', border: '1px solid #3a3a3a', cursor: 'pointer' }}
                          role="button"
                          tabIndex={0}
                          aria-label={`Open details for ${pkg.name}`}
                          onClick={() => openThunderstoreModView(pkg)}
                          onKeyDown={(event) => handleCardActivationKeyDown(event, () => openThunderstoreModView(pkg))}
                        >
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '1rem' }}>
                            <div style={{ flex: 1, minWidth: 0, display: 'flex', gap: '0.7rem' }}>
                              {renderCardIcon(pkg.name, undefined, iconUrl, 'rail')}
                              <div style={{ flex: 1, minWidth: 0 }}>
                              <strong style={{ fontSize: '1rem' }}>{pkg.name}</strong>
                              <div style={{ fontSize: '0.85rem', color: '#9aa4b2' }}>{pkg.owner}</div>
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
                              {summary && (
                                <p className="mod-card-summary" title={summary} style={{ marginTop: '0.45rem' }}>
                                  {summary}
                                </p>
                              )}
                              <div className="mod-card-meta-row" style={{ marginTop: '0.45rem', fontSize: '0.78rem', color: '#8f9cb0', display: 'flex', gap: '0.6rem', flexWrap: 'wrap' }}>
                                <span><i className="fas fa-download" style={{ marginRight: '0.25rem' }}></i>{totalDownloads.toLocaleString()}</span>
                                <span><i className="fas fa-thumbs-up" style={{ marginRight: '0.25rem' }}></i>{(representative?.rating_score || 0).toLocaleString()}</span>
                                {latestVersion?.version_number && (
                                  <span><i className="fas fa-tag" style={{ marginRight: '0.25rem' }}></i>v{latestVersion.version_number}</span>
                                )}
                              </div>
                              </div>
                            </div>
                            <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                              <button
                                className="btn btn-primary btn-small"
                                disabled={downloading === pkg.key}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  handleDownloadThunderstore(pkg);
                                }}
                              >
                                {downloading === pkg.key ? 'Downloading...' : 'Download'}
                              </button>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}

                {showNexusModsResults && nexusModsSearchResults.length > 0 && (
                  <div className="mods-grid" style={{ display: 'grid', gap: '1rem', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))' }}>
                    {nexusModsSearchResults.map(mod => {
                      const files = nexusModsFiles.get(mod.mod_id) ?? null;
                      const loading = nexusModsLoading.has(mod.mod_id);
                      const fileNames = files ? files.map(file => (file.file_name || file.name || '').toLowerCase()) : [];
                      const hasIl2cpp = fileNames.some(name => name.includes('il2cpp'));
                      const hasMono = fileNames.some(name => name.includes('mono'));
                      const summary = mod.summary || mod.description;
                      return (
                        <div
                          key={mod.mod_id}
                          className="mod-card store-card"
                          style={{ padding: '1rem', backgroundColor: '#2a2a2a', borderRadius: '8px', border: '1px solid #3a3a3a', cursor: 'pointer' }}
                          role="button"
                          tabIndex={0}
                          aria-label={`Open details for ${mod.name}`}
                          onClick={() => openNexusModView(mod)}
                          onKeyDown={(event) => handleCardActivationKeyDown(event, () => openNexusModView(mod))}
                        >
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '1rem' }}>
                            <div style={{ flex: 1, minWidth: 0, display: 'flex', gap: '0.7rem' }}>
                              {renderCardIcon(mod.name, undefined, mod.picture_url, 'rail')}
                              <div style={{ flex: 1, minWidth: 0 }}>
                              <strong style={{ fontSize: '1rem' }}>{mod.name}</strong>
                              <div style={{ fontSize: '0.85rem', color: '#9aa4b2' }}>{mod.author}</div>
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
                              {summary && (
                                <p className="mod-card-summary" title={summary} style={{ marginTop: '0.45rem' }}>
                                  {summary}
                                </p>
                              )}
                              <div className="mod-card-meta-row" style={{ marginTop: '0.45rem', fontSize: '0.78rem', color: '#8f9cb0', display: 'flex', gap: '0.6rem', flexWrap: 'wrap' }}>
                                <span><i className="fas fa-download" style={{ marginRight: '0.25rem' }}></i>{(mod.mod_downloads || 0).toLocaleString()}</span>
                                <span><i className="fas fa-thumbs-up" style={{ marginRight: '0.25rem' }}></i>{(mod.endorsement_count || 0).toLocaleString()}</span>
                                {mod.version && (
                                  <span><i className="fas fa-tag" style={{ marginRight: '0.25rem' }}></i>v{mod.version}</span>
                                )}
                              </div>
                              </div>
                            </div>
                            <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                              <button
                                className="btn btn-primary btn-small"
                                disabled={downloading === `nexus-${mod.mod_id}` || loading}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  handleDownloadNexusMod(mod.mod_id);
                                }}
                              >
                                {downloading === `nexus-${mod.mod_id}` ? 'Downloading...' : loading ? 'Loading...' : 'Download'}
                              </button>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
            </>
            )}

            <div className="mods-section" style={{ padding: '0.9rem 1.25rem 1rem', borderTop: '1px solid #3a3a3a' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap', marginBottom: '0.75rem' }}>
                <h3 style={{ margin: 0 }}>Downloaded Mods</h3>
                <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                  <span style={{ color: '#9aa4b2', fontSize: '0.8rem', alignSelf: 'center' }}>
                    {selectedModIds.size} selected
                  </span>
                  <button
                    className="btn btn-danger btn-small"
                    disabled={selectedModIds.size === 0 || deleting === 'bulk'}
                    onClick={handleBulkDelete}
                  >
                    {deleting === 'bulk' ? 'Deleting...' : 'Delete selected'}
                  </button>
                </div>
              </div>

              <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '0.65rem', flexWrap: 'wrap' }}>
                {(['all', 'updates', 'managed', 'external', 'installed'] as DownloadedFilter[]).map((filter) => (
                  <button
                    key={filter}
                    className="btn btn-small"
                    onClick={() => setDownloadedFilter(filter)}
                    style={{
                      backgroundColor: downloadedFilter === filter ? '#4a90e2' : '#2a2a2a',
                      border: `1px solid ${downloadedFilter === filter ? '#4a90e2' : '#3a3a3a'}`,
                      color: downloadedFilter === filter ? '#fff' : '#ccc'
                    }}
                  >
                    {filter === 'all' ? 'All' : filter === 'updates' ? 'Updates' : filter === 'managed' ? 'Managed' : filter === 'external' ? 'External' : 'Installed'}
                  </button>
                ))}
              </div>

              <div style={{ marginBottom: '0.75rem' }}>
                <input
                  type="text"
                  value={downloadedSearch}
                  onChange={(e) => setDownloadedSearch(e.target.value)}
                  placeholder="Filter by mod, author, or version"
                  style={{
                    width: '100%',
                    padding: '0.5rem 0.75rem',
                    backgroundColor: '#1a1a1a',
                    border: '1px solid #3a3a3a',
                    borderRadius: '4px',
                    color: '#fff',
                    fontSize: '0.875rem'
                  }}
                />
              </div>

              {loadingLibrary && <div style={{ color: '#888' }}>Loading mod library...</div>}
              {!loadingLibrary && downloadedGroups.length === 0 && (
                <div style={{ color: '#888' }}>No downloaded mods yet.</div>
              )}
              {!loadingLibrary && downloadedGroups.length > 0 && filteredDownloadedGroups.length === 0 && (
                <div style={{ color: '#888' }}>No downloaded mods match this filter.</div>
              )}
              {!loadingLibrary && filteredDownloadedGroups.length > 0 ? (
                <div className="mods-grid" style={{ display: 'grid', gap: '0.65rem', gridTemplateColumns: 'repeat(auto-fill, minmax(360px, 1fr))' }}>
                  {filteredDownloadedGroups.map(group => {
                    const sortedEntries = getSortedGroupEntries(group);
                    const activeEntry = getActiveEntryForGroup(group);
                    const groupHasUpdate = isGroupUpdateAvailable(group);
                    const activeVersionLabel = activeEntry ? getEntryVersionLabel(activeEntry) : 'unknown';
                    const activeIndex = activeEntry
                      ? sortedEntries.findIndex(entry => entry.storageId === activeEntry.storageId)
                      : -1;
                    const hasOlderVersion = sortedEntries.length > 1 && activeIndex >= 0 && activeIndex < sortedEntries.length - 1;
                    const hasNewerVersion = sortedEntries.length > 1 && activeIndex > 0;

                    return (
                    <div
                      key={group.key}
                      className="mod-card compact-row library-row-card"
                      style={{ padding: '0.68rem 0.75rem', backgroundColor: '#2a2a2a', borderRadius: '7px', border: '1px solid #3a3a3a', cursor: 'pointer' }}
                      role="button"
                      tabIndex={0}
                      aria-label={`Open details for ${group.displayName}`}
                      onClick={() => openDownloadedModView(group)}
                      onKeyDown={(event) => handleCardActivationKeyDown(event, () => openDownloadedModView(group))}
                    >
                      <div className="mod-card-row-shell" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'stretch', gap: '0.7rem' }}>
                        <div className="mod-card-main-shell" style={{ display: 'flex', alignItems: 'stretch', gap: '0.55rem', flex: 1, minWidth: 0 }}>
                          <div className="mod-card-checkbox-zone" onClick={(e) => e.stopPropagation()}>
                            <input
                              type="checkbox"
                              checked={group.storageIds.every(id => selectedModIds.has(id))}
                              onChange={() => toggleGroupSelection(group.storageIds)}
                              style={{ margin: 0 }}
                            />
                          </div>
                          {renderCardIcon(
                            group.displayName,
                            activeEntry?.iconCachePath,
                            activeEntry?.iconUrl,
                            'rail',
                          )}
                          <div className="mod-card-main-column" style={{ flex: 1, minWidth: 0, display: 'grid', gap: '0.3rem', alignContent: 'start' }}>
                            <div className="mod-card-title-row" style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', flexWrap: 'wrap' }}>
                              <strong className="mod-card-title-text" style={{ fontSize: '0.94rem' }}>{group.displayName}</strong>
                              <span style={{
                                fontSize: '0.64rem',
                                padding: '0.1rem 0.35rem',
                                borderRadius: '999px',
                                backgroundColor: group.managed ? '#28a745' : '#6c757d',
                                color: '#fff'
                              }}>
                                {group.managed ? 'Managed' : 'External'}
                              </span>
                              <span style={{
                                fontSize: '0.64rem',
                                padding: '0.1rem 0.35rem',
                                borderRadius: '999px',
                                backgroundColor: '#4a90e220',
                                color: '#8fc0ff',
                                border: '1px solid #4a90e240'
                              }}>
                                {sortedEntries.length} version{sortedEntries.length === 1 ? '' : 's'}
                              </span>
                            </div>
                            {activeEntry?.summary && (
                              <p className="mod-card-summary" title={activeEntry.summary}>
                                {activeEntry.summary}
                              </p>
                            )}
                          </div>
                        </div>
                        <div className="mod-card-actions mod-card-actions--stacked">
                          <div className="mod-card-actions-buttons" onClick={(e) => e.stopPropagation()}>
                            {groupHasUpdate && (
                              <button
                                className="btn btn-warning btn-small mod-card-action-button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  handleUpdateAndActivateGroup(group);
                                }}
                                disabled={updatingGroup === group.key || activatingGroup === group.key}
                                title="Download latest update and make it active"
                              >
                                {updatingGroup === group.key ? (
                                  <>
                                    <i className="fas fa-spinner fa-spin" style={{ marginRight: '0.35rem' }}></i>
                                    Updating...
                                  </>
                                ) : (
                                  <>
                                    <i className="fas fa-arrow-up" style={{ marginRight: '0.35rem' }}></i>
                                    Update
                                  </>
                                )}
                              </button>
                            )}
                            <button
                              className="btn btn-danger btn-small mod-card-action-button"
                              disabled={deleting === group.key || activatingGroup === group.key || updatingGroup === group.key}
                              onClick={(e) => {
                                e.stopPropagation();
                                handleDeleteDownloadedGroup(group);
                              }}
                              title="Delete downloaded files from library"
                            >
                              {deleting === group.key ? 'Deleting...' : 'Delete Files'}
                            </button>
                          </div>
                          <div className="mod-card-version-row" style={{ position: 'relative', zIndex: openVersionMenuGroup === group.key ? 100 : 'auto' }} onClick={(e) => e.stopPropagation()}>
                            <div
                              data-version-switcher
                              style={{
                                display: 'inline-flex',
                                alignItems: 'center',
                                border: '1px solid #3a3a3a',
                                borderRadius: '999px',
                                overflow: 'hidden',
                                backgroundColor: '#131a25'
                              }}
                              title="Cycle active version"
                            >
                              {hasOlderVersion && (
                                <button
                                  className="btn btn-secondary btn-small"
                                  onClick={() => void handleStepGroupVersion(group, 'older')}
                                  disabled={activatingGroup === group.key || updatingGroup === group.key}
                                  style={{
                                    borderRadius: 0,
                                    border: 'none',
                                    borderRight: '1px solid #2d3b52',
                                    padding: '0.08rem 0.32rem',
                                    minHeight: '1.22rem'
                                  }}
                                  title="Older version"
                                >
                                  <i className="fas fa-chevron-left" style={{ fontSize: '0.62rem' }}></i>
                                </button>
                              )}
                              <button
                                className="btn btn-secondary btn-small"
                                onClick={() => {
                                  if (sortedEntries.length > 1) {
                                    setOpenVersionMenuGroup(prev => prev === group.key ? null : group.key);
                                  }
                                }}
                                disabled={activatingGroup === group.key || updatingGroup === group.key}
                                style={{
                                  borderRadius: 0,
                                  border: 'none',
                                  padding: '0.08rem 0.36rem',
                                  minHeight: '1.22rem',
                                  backgroundColor: '#131a25',
                                  color: '#d9e6fb'
                                }}
                                title={sortedEntries.length > 1 ? 'Choose version' : 'Active version'}
                              >
                                <span className="mod-card-version-pill" style={{ fontSize: '0.67rem', minWidth: '94px', textAlign: 'center' }}>
                                  {formatVersionTag(activeVersionLabel)}
                                  {sortedEntries.length > 1 ? ' ▾' : ''}
                                </span>
                              </button>
                              {hasNewerVersion && (
                                <button
                                  className="btn btn-secondary btn-small"
                                  onClick={() => void handleStepGroupVersion(group, 'newer')}
                                  disabled={activatingGroup === group.key || updatingGroup === group.key}
                                  style={{
                                    borderRadius: 0,
                                    border: 'none',
                                    borderLeft: '1px solid #2d3b52',
                                    padding: '0.08rem 0.32rem',
                                    minHeight: '1.22rem'
                                  }}
                                  title="Newer version"
                                >
                                  <i className="fas fa-chevron-right" style={{ fontSize: '0.62rem' }}></i>
                                </button>
                              )}
                            </div>
                            {openVersionMenuGroup === group.key && sortedEntries.length > 1 && (
                              <div style={{
                                position: 'absolute',
                                top: 0,
                                right: 0,
                                minWidth: '180px',
                                backgroundColor: '#172131',
                                border: '1px solid #31445f',
                                borderRadius: '8px',
                                boxShadow: '0 8px 24px rgba(0,0,0,0.45)',
                                zIndex: 1000,
                                padding: '0.25rem'
                              }}>
                                {sortedEntries.map(entry => {
                                  const isActive = activeEntry?.storageId === entry.storageId;
                                  return (
                                    <button
                                      key={`${group.key}-pick-${entry.storageId}`}
                                      onClick={() => void handleSelectVersion(group, entry.storageId)}
                                      style={{
                                        display: 'block',
                                        width: '100%',
                                        textAlign: 'left',
                                        border: 'none',
                                        borderRadius: '6px',
                                        padding: '0.35rem 0.5rem',
                                        marginBottom: '2px',
                                        backgroundColor: isActive ? '#2b4666' : 'transparent',
                                        color: isActive ? '#e8f3ff' : '#c8d8ee',
                                        fontSize: '0.72rem',
                                        cursor: 'pointer',
                                        transition: 'background-color 0.1s'
                                      }}
                                      onMouseEnter={(e) => {
                                        if (!isActive) e.currentTarget.style.backgroundColor = '#1e3048';
                                      }}
                                      onMouseLeave={(e) => {
                                        if (!isActive) e.currentTarget.style.backgroundColor = 'transparent';
                                      }}
                                    >
                                      {`${formatVersionTag(getEntryVersionLabel(entry))} · ${entry.availableRuntimes.length ? entry.availableRuntimes.join('/') : 'Runtime?'}`}
                                    </button>
                                  );
                                })}
                              </div>
                            )}
                          </div>
                        </div>
                      </div>
                      <div className="mod-card-meta-row" style={{ fontSize: '0.74rem', color: '#94a4bb', marginTop: '0.4rem', display: 'flex', alignItems: 'center', gap: '0.45rem', flexWrap: 'wrap', lineHeight: 1.35 }}>
                        {group.author && (
                          <span>
                            <i className="fas fa-user" style={{ marginRight: '0.25rem', opacity: 0.7 }}></i>
                            {group.author}
                          </span>
                        )}
                        <span>
                          <i className="fas fa-tag" style={{ marginRight: '0.25rem', opacity: 0.7 }}></i>
                          Active {formatVersionTag(activeVersionLabel)}
                        </span>
                        {groupHasUpdate && group.remoteVersion && (
                          <span className="mod-card-update-hint-inline">
                            <i className="fas fa-arrow-up" style={{ marginRight: '0.25rem', opacity: 0.8 }}></i>
                            Latest {formatVersionTag(group.remoteVersion)}
                          </span>
                        )}
                        <span>
                          <i className="fas fa-folder" style={{ marginRight: '0.25rem', opacity: 0.7 }}></i>
                          {group.installedIn.length ? group.installedIn.length : '0'} envs
                        </span>
                        {group.availableRuntimes?.map(runtime => (
                          <span
                            key={`${group.key}-${runtime}`}
                            style={{
                              fontSize: '0.62rem',
                              padding: '0.08rem 0.34rem',
                              borderRadius: '999px',
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
                  );
                  })}
                </div>
              ) : null}
            </div>
          </div>

          {activeModView && (
            <div
              className="mod-view-overlay"
              style={{
                position: 'absolute',
                inset: 0,
                backgroundColor: 'rgba(9, 14, 24, 0.96)',
                borderRadius: '0.75rem',
                border: '1px solid #344259',
                display: 'flex',
                flexDirection: 'column',
                zIndex: 40
              }}
            >
              <div className="modal-header" style={{ borderBottom: '1px solid #2f3a4f' }}>
                <h2 style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
                  <i className="fas fa-cube"></i>
                  Mod View
                </h2>
                <button className="btn btn-secondary btn-small" onClick={closeModView}>
                  <i className="fas fa-arrow-left" style={{ marginRight: '0.45rem' }}></i>
                  Back
                </button>
              </div>
              <div className="mod-view-content" style={{ padding: '1rem 1.25rem 1.25rem', overflowY: 'auto', display: 'grid', gap: '1rem' }}>
                <div className="mod-view-header-grid" style={{ display: 'grid', gridTemplateColumns: '92px 1fr', gap: '1rem', alignItems: 'start' }}>
                  <div className="mod-view-icon" style={{ width: '92px', height: '92px', borderRadius: '14px', overflow: 'hidden', border: '1px solid #3a4a66', background: '#172131' }}>
                    {(activeModView.iconCachePath || activeModView.iconUrl) ? (
                      <img
                        src={resolveImageSource(activeModView.iconCachePath) || resolveImageSource(activeModView.iconUrl)}
                        alt={`${activeModView.name} icon`}
                        style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                        onError={(e) => {
                          const target = e.currentTarget;
                          const remoteSource = resolveImageSource(activeModView.iconUrl);
                          if (remoteSource && target.src !== remoteSource) {
                            target.src = remoteSource;
                          }
                        }}
                      />
                    ) : (
                      <div style={{ width: '100%', height: '100%', display: 'grid', placeItems: 'center', color: '#7d8fa9' }}>
                        <i className="fas fa-puzzle-piece" style={{ fontSize: '1.6rem' }}></i>
                      </div>
                    )}
                  </div>
                  <div>
                    <h3 style={{ margin: 0 }}>{activeModView.name}</h3>
                    <div style={{ marginTop: '0.35rem', color: '#9ab0cb', fontSize: '0.85rem' }}>
                      Source: {activeModView.source} {activeModView.author ? `• ${activeModView.author}` : ''}
                    </div>
                    {activeModView.summary && (
                      <p style={{ margin: '0.65rem 0 0', color: '#d5dfec', lineHeight: 1.55 }}>
                        {activeModView.summary}
                      </p>
                    )}
                  </div>
                </div>
                <div className="mod-view-metrics" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '0.75rem' }}>
                  <div className="mod-card mod-view-metric" style={{ padding: '0.7rem 0.8rem' }}>
                    <div style={{ color: '#8ea5c4', fontSize: '0.75rem' }}>Downloads</div>
                    <strong>{(activeModView.downloads || 0).toLocaleString()}</strong>
                  </div>
                  <div className="mod-card mod-view-metric" style={{ padding: '0.7rem 0.8rem' }}>
                    <div style={{ color: '#8ea5c4', fontSize: '0.75rem' }}>
                      {activeModView.source === 'nexusmods' ? 'Endorsements' : 'Likes'}
                    </div>
                    <strong>{(activeModView.likesOrEndorsements || 0).toLocaleString()}</strong>
                  </div>
                  <div className="mod-card mod-view-metric" style={{ padding: '0.7rem 0.8rem' }}>
                    <div style={{ color: '#8ea5c4', fontSize: '0.75rem' }}>Installed Version</div>
                    <strong>{activeModView.installedVersion || 'unknown'}</strong>
                  </div>
                  <div className="mod-card mod-view-metric" style={{ padding: '0.7rem 0.8rem' }}>
                    <div style={{ color: '#8ea5c4', fontSize: '0.75rem' }}>Latest Version</div>
                    <strong>{activeModView.latestVersion || 'unknown'}</strong>
                  </div>
                </div>
                {(activeModView.tags || []).length > 0 && (
                  <div className="mod-view-tags" style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap' }}>
                    {(activeModView.tags || []).map((tag) => (
                      <span className="mod-view-tag" key={`${activeModView.id}-${tag}`} style={{ padding: '0.2rem 0.45rem', borderRadius: '999px', backgroundColor: '#38537a33', border: '1px solid #38537a66', color: '#a9c1e6', fontSize: '0.72rem' }}>
                        {tag}
                      </span>
                    ))}
                  </div>
                )}
                <div className="mod-view-actions" style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                  {safeExternalUrl(activeModView.sourceUrl) && (
                    <a
                      href={safeExternalUrl(activeModView.sourceUrl)}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="btn btn-secondary btn-small"
                      style={{ textDecoration: 'none' }}
                    >
                      <i className="fas fa-external-link-alt" style={{ marginRight: '0.45rem' }}></i>
                      Open Source Page
                    </a>
                  )}
                  <button className="btn btn-secondary btn-small" onClick={closeModView}>
                    Close
                  </button>
                </div>
              </div>
            </div>
          )}
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
