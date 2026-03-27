import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';
import { ApiService } from '../services/api';
import { ConfirmOverlay } from './ConfirmOverlay';
import { handleCardActivationKeyDown, resolveImageSource, safeExternalUrl } from './modCardHelpers';
import { onModMetadataRefreshStatus } from '../services/events';
import { useSettingsStore } from '../stores/settingsStore';
import { SecurityScanReportOverlay } from './SecurityScanReportOverlay';
import { AnchoredContextMenu, type AnchoredContextMenuItem } from './AnchoredContextMenu';
import { InstallTargetsDialog } from './InstallTargetsDialog';
import type { Environment, ModLibraryEntry, ModLibraryResult, NexusMod, NexusModFile, SecurityScanReport, SecurityScanSummary } from '../types';

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
type LibraryTab = 'discover' | 'library' | 'updates';

interface LibraryModViewState {
  id: string;
  storageId?: string;
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
  securityScan?: SecurityScanSummary;
  kind: 'downloaded' | 'thunderstore' | 'nexusmods';
}

interface InstallDialogState {
  isOpen: boolean;
  title: string;
  entry: ModLibraryEntry | null;
  compatibleEnvironments: Environment[];
  excludedEnvironments: Environment[];
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

const formatCompactNumber = (value?: number): string => {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return 'unknown';
  }
  return new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(value);
};

const formatInspectorDate = (value?: string): string => {
  if (!value) {
    return 'unknown';
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return 'unknown';
  }
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' }).format(date);
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

const isSecurityScanReport = (value: unknown): value is SecurityScanReport => {
  return !!value && typeof value === 'object' && 'summary' in (value as Record<string, unknown>) && Array.isArray((value as { files?: unknown[] }).files);
};

const getSecurityBadgeConfig = (summary?: SecurityScanSummary) => {
  if (!summary) {
    return null;
  }

  if (summary.state === 'verified') {
    return {
      label: 'Scanned for Viruses',
      icon: 'fa-shield-check',
      background: 'rgba(31, 105, 72, 0.24)',
      border: '#3cc79055',
      color: '#bdf3d8',
    };
  }

  if (summary.state === 'review') {
    const severityLabel = summary.highestSeverity 
      ? `${summary.highestSeverity} Risk`
      : 'Needs Review';
    return {
      label: severityLabel,
      icon: 'fa-shield-exclamation',
      background: 'rgba(104, 72, 27, 0.28)',
      border: '#f0b35e55',
      color: '#ffd9aa',
    };
  }

  if (summary.state === 'unavailable') {
    return {
      label: 'Scan Unavailable',
      icon: 'fa-circle-question',
      background: 'rgba(48, 67, 96, 0.32)',
      border: '#7fa1c855',
      color: '#d2e3fa',
    };
  }

  if (summary.state === 'skipped') {
    return {
      label: 'Scan Not Applicable',
      icon: 'fa-file-circle-question',
      background: 'rgba(48, 67, 96, 0.24)',
      border: '#7fa1c833',
      color: '#c7d8ef',
    };
  }

  return null;
};

const getSourceBadgeLabel = (source?: ModLibraryEntry['source']): string => {
  switch (source) {
    case 'thunderstore':
      return 'Thunderstore';
    case 'nexusmods':
      return 'Nexus Mods';
    case 'github':
      return 'GitHub';
    case 'local':
      return 'Local';
    case 'unknown':
      return 'Unknown';
    default:
      return 'External';
  }
};

const getSourceBadgeStyle = (source?: ModLibraryEntry['source']): { backgroundColor: string; color: string; border?: string } => {
  switch (source) {
    case 'thunderstore':
      return {
        backgroundColor: '#7c3aed22',
        color: '#c4b5fd',
        border: '1px solid #7c3aed55',
      };
    case 'nexusmods':
      return {
        backgroundColor: '#ea433522',
        color: '#ffb4ac',
        border: '1px solid #ea433555',
      };
    case 'github':
      return {
        backgroundColor: '#2ea44f22',
        color: '#95f0ad',
        border: '1px solid #2ea44f55',
      };
    case 'local':
      return {
        backgroundColor: '#2563eb22',
        color: '#93c5fd',
        border: '1px solid #2563eb55',
      };
    default:
      return {
        backgroundColor: '#6c757d',
        color: '#fff',
      };
  }
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
      const updateAvailable = hasRemoteVersion
        ? !hasRemoteDownloaded
        : hasFlaggedUpdate;

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
  focusStorageId?: string | null;
  focusRequestId?: number;
  focusModTag?: string | null;
}

interface RuntimePromptState {
  title: string;
  message: string;
  onSelect: (runtime: 'IL2CPP' | 'Mono' | 'Both') => void;
}

export function ModLibraryOverlay({ isOpen, onClose, focusStorageId, focusRequestId, focusModTag }: Props) {
  const { settings } = useSettingsStore();
  const [library, setLibrary] = useState<ModLibraryResult | null>(null);
  const [loadingLibrary, setLoadingLibrary] = useState(false);
  const [selectedModIds, setSelectedModIds] = useState<Set<string>>(new Set());
  const [environments, setEnvironments] = useState<Environment[]>([]);
  const [confirmOverlay, setConfirmOverlay] = useState<{ isOpen: boolean; title: string; message: string; onConfirm: () => void }>({
    isOpen: false,
    title: '',
    message: '',
    onConfirm: () => {},
  });
  const [libraryTab, setLibraryTab] = useState<LibraryTab>('discover');

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
  const [activeSecurityReport, setActiveSecurityReport] = useState<{
    title: string;
    report: SecurityScanReport;
    confirmLabel?: string;
    onConfirm?: (() => Promise<void>) | null;
  } | null>(null);
  const [securityActionBusy, setSecurityActionBusy] = useState(false);
  const [installDialog, setInstallDialog] = useState<InstallDialogState>({
    isOpen: false,
    title: '',
    entry: null,
    compatibleEnvironments: [],
    excludedEnvironments: [],
  });
  const [selectedInstallEnvironmentIds, setSelectedInstallEnvironmentIds] = useState<Set<string>>(new Set());
  const [installingTargets, setInstallingTargets] = useState(false);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; items: AnchoredContextMenuItem[] } | null>(null);
  const [openedFromLogs, setOpenedFromLogs] = useState<{ active: boolean; modTag: string | null }>({
    active: false,
    modTag: null,
  });
  const libraryScrollContainerRef = useRef<HTMLDivElement | null>(null);
  const libraryScrollTopRef = useRef(0);
  const metadataRefreshRunningRef = useRef(false);
  const nexusManualTimeoutRef = useRef<number | null>(null);
  const pendingNexusManualActionRef = useRef<null | {
    onSuccess: () => Promise<void>;
    onErrorTitle?: string;
  }>(null);
  const lastHandledFocusRequestIdRef = useRef<number | null>(null);

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
      setOpenedFromLogs({ active: false, modTag: null });
    }
  }, [isOpen]);

  const closeModView = useCallback(() => {
    if (openedFromLogs.active) {
      onClose();
      return;
    }

    setActiveModView(null);
    window.requestAnimationFrame(() => {
      if (libraryScrollContainerRef.current) {
        libraryScrollContainerRef.current.scrollTop = libraryScrollTopRef.current;
      }
    });
  }, [onClose, openedFromLogs.active]);

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

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    if (downloadedGroups.length > 0) {
      setLibraryTab((current) => (current === 'discover' ? 'library' : current));
      return;
    }

    setLibraryTab('discover');
  }, [downloadedGroups.length, isOpen]);

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

  const refreshEnvironments = useCallback(async () => {
    try {
      const data = await ApiService.getEnvironments();
      setEnvironments(data);
    } catch (error) {
      console.warn('Failed to load environments for install targets:', error);
      setEnvironments([]);
    }
  }, []);

  const closeConfirmOverlay = useCallback(() => {
    setConfirmOverlay({ isOpen: false, title: '', message: '', onConfirm: () => {} });
  }, []);

  const showLibraryNotice = useCallback((title: string, message: string) => {
    setConfirmOverlay({
      isOpen: true,
      title,
      message,
      onConfirm: () => {
        closeConfirmOverlay();
      },
    });
  }, [closeConfirmOverlay]);

  const closeSecurityReport = useCallback(() => {
    if (securityActionBusy) {
      return;
    }

    setActiveSecurityReport(null);
  }, [securityActionBusy]);

  const handleSecurityReportConfirm = useCallback(async () => {
    if (!activeSecurityReport?.onConfirm) {
      return;
    }

    setSecurityActionBusy(true);
    try {
      await activeSecurityReport.onConfirm();
      setActiveSecurityReport(null);
    } catch (err) {
      console.error('Security action failed:', err);
      showLibraryNotice('MLVScan Action Failed', err instanceof Error ? err.message : 'Unable to continue with this download.');
    } finally {
      setSecurityActionBusy(false);
    }
  }, [activeSecurityReport, showLibraryNotice]);

  const openStoredSecurityReport = useCallback(async (storageId: string, title: string) => {
    try {
      const report = await ApiService.getModSecurityScanReport(storageId);
      if (!report) {
        showLibraryNotice('No Security Report', 'This library entry does not have a stored MLVScan report yet.');
        return;
      }

      setActiveSecurityReport({ title, report, onConfirm: null });
    } catch (err) {
      console.error('Failed to load security report:', err);
      showLibraryNotice('Security Report Error', err instanceof Error ? err.message : 'Failed to load the MLVScan report.');
    }
  }, [showLibraryNotice]);

  const handleSecurityGateResult = useCallback((
    title: string,
    result: { success: boolean; securityScan?: SecurityScanSummary | SecurityScanReport; securityScanConfirmationRequired?: boolean; securityScanBlocked?: boolean; error?: string },
    onConfirm: () => Promise<void>,
  ): boolean => {
    if (!result.securityScan || !isSecurityScanReport(result.securityScan)) {
      return true;
    }

    if (result.securityScanBlocked) {
      setActiveSecurityReport({ title, report: result.securityScan, onConfirm: null });
      return false;
    }

    if (result.securityScanConfirmationRequired) {
      setActiveSecurityReport({
        title,
        report: result.securityScan,
        confirmLabel: 'Continue Download',
        onConfirm,
      });
      return false;
    }

    return true;
  }, []);

  const clearNexusManualTimeout = useCallback(() => {
    if (nexusManualTimeoutRef.current !== null) {
      window.clearTimeout(nexusManualTimeoutRef.current);
      nexusManualTimeoutRef.current = null;
    }
  }, []);

  const startNexusManualTimeout = useCallback(() => {
    clearNexusManualTimeout();
    nexusManualTimeoutRef.current = window.setTimeout(() => {
      pendingNexusManualActionRef.current = null;
      setDownloading(null);
      setUpdatingGroup(null);
      showLibraryNotice('Nexus Download Timed Out', 'The Nexus manual download session timed out. Start the download again from the Files page.');
    }, 5 * 60 * 1000);
  }, [clearNexusManualTimeout, showLibraryNotice]);

  const getEffectiveNexusDownloadAccess = useCallback(async () => {
    const status = await ApiService.getNexusOAuthStatus();
    return {
      connected: !!status.connected,
      canDirectDownload: !!status.connected && !!status.account?.canDirectDownload,
      requiresSiteConfirmation: !!status.connected && !!status.account?.requiresSiteConfirmation,
    };
  }, []);

  const beginManualNexusLibraryDownload = useCallback(async (
    modId: number,
    fileId: number,
    runtime: 'IL2CPP' | 'Mono',
    onSuccess: () => Promise<void>,
    onErrorTitle?: string,
  ) => {
    pendingNexusManualActionRef.current = { onSuccess, onErrorTitle };
    try {
      await ApiService.beginNexusManualDownloadSession({
        kind: 'library',
        modId,
        fileId,
        gameId: 'schedule1',
        runtime,
      });
      startNexusManualTimeout();
    } catch (error) {
      pendingNexusManualActionRef.current = null;
      throw error;
    }
  }, [startNexusManualTimeout]);

  /** Notify ModsOverlay (and other views) that the library was updated - e.g. after download */
  const notifyLibraryUpdated = useCallback(() => {
    sessionStorage.setItem('library-needs-refresh', '1');
    window.dispatchEvent(new CustomEvent('library-updated'));
  }, []);

  const notifyModUpdateStateChanged = useCallback(() => {
    window.dispatchEvent(new CustomEvent('mod-updates-checked'));
  }, []);

  useEffect(() => {
    const handleManualDownloadResult = async (event: Event) => {
      const detail = (event as CustomEvent<{
        success: boolean;
        result?: {
          kind?: 'library' | 'install';
          requestedKind?: 'library' | 'install';
        };
        requestedKind?: 'library' | 'install';
        error?: string;
      }>).detail;
      const pendingAction = pendingNexusManualActionRef.current;
      const requestedKind = detail?.requestedKind ?? detail?.result?.requestedKind;
      const isLibraryResult = detail?.result?.kind === 'library' || requestedKind === 'library';

      if (pendingAction && isLibraryResult) {
        clearNexusManualTimeout();
        pendingNexusManualActionRef.current = null;
        setDownloading(null);
        setUpdatingGroup(null);

        if (detail?.success) {
          try {
            await pendingAction.onSuccess();
          } catch (error) {
            showLibraryNotice(
              pendingAction.onErrorTitle || 'Nexus Download Failed',
              error instanceof Error ? error.message : 'Failed to refresh the mod library after the Nexus download completed.',
            );
          }
          return;
        }

        showLibraryNotice(
          pendingAction.onErrorTitle || 'Nexus Download Failed',
          detail?.error || 'Failed to complete the Nexus manual download.',
        );
        return;
      }

      if (detail?.success && isLibraryResult && isOpen) {
        await refreshLibrary();
        notifyLibraryUpdated();
      }
    };

    window.addEventListener('nexus-manual-download-result', handleManualDownloadResult as EventListener);
    return () => {
      clearNexusManualTimeout();
      window.removeEventListener('nexus-manual-download-result', handleManualDownloadResult as EventListener);
    };
  }, [clearNexusManualTimeout, isOpen, notifyLibraryUpdated, refreshLibrary, showLibraryNotice]);

  useEffect(() => {
    if (!isOpen) return;
    const loadLibrary = async () => {
      setLoadingLibrary(true);
      try {
        await refreshLibrary();
        await refreshEnvironments();
      } catch (err) {
        console.error('Failed to load mod library:', err);
        setLibrary({ downloaded: [] });
      } finally {
        setLoadingLibrary(false);
      }
    };
    loadLibrary();
  }, [isOpen, refreshEnvironments, refreshLibrary]);

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
    })
      .then((fn) => {
        if (disposed) {
          fn();
          return;
        }
        unlisten = fn;
      })
      .catch((error) => {
        console.warn('Failed to register mod metadata refresh listener:', error);
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

  const downloadThunderstoreWithSecurity = useCallback(async (
    packageUuid: string,
    runtime?: 'IL2CPP' | 'Mono',
    title = 'Security Findings',
  ): Promise<Awaited<ReturnType<typeof ApiService.downloadThunderstoreToLibrary>> | null> => {
    const result = await ApiService.downloadThunderstoreToLibrary(packageUuid, runtime);
    if (!result.success) {
      const handled = handleSecurityGateResult(title, result, async () => {
        const retry = await ApiService.downloadThunderstoreToLibrary(packageUuid, runtime, true);
        if (!retry.success) {
          throw new Error(retry.error || 'Failed to continue the download after confirming the MLVScan findings.');
        }
        await refreshLibrary();
        notifyLibraryUpdated();
      });

      if (!handled) {
        return null;
      }

      throw new Error(result.error || 'Failed to download the selected Thunderstore package.');
    }

    await refreshLibrary();
    notifyLibraryUpdated();
    return result;
  }, [handleSecurityGateResult, notifyLibraryUpdated, refreshLibrary]);

  const downloadNexusWithSecurity = useCallback(async (
    modId: number,
    fileId: number,
    runtime?: 'IL2CPP' | 'Mono',
    title = 'Security Findings',
  ): Promise<Awaited<ReturnType<typeof ApiService.downloadNexusModToLibrary>> | null> => {
    const result = await ApiService.downloadNexusModToLibrary(modId, fileId, runtime);
    if (!result.success) {
      const handled = handleSecurityGateResult(title, result, async () => {
        const retry = await ApiService.downloadNexusModToLibrary(modId, fileId, runtime, true);
        if (!retry.success) {
          throw new Error(retry.error || 'Failed to continue the download after confirming the MLVScan findings.');
        }
        await refreshLibrary();
        notifyLibraryUpdated();
      });

      if (!handled) {
        return null;
      }

      throw new Error(result.error || 'Failed to download the selected Nexus mod.');
    }

    await refreshLibrary();
    notifyLibraryUpdated();
    return result;
  }, [handleSecurityGateResult, notifyLibraryUpdated, refreshLibrary]);

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
      showLibraryNotice(
        'Mod Update Failed',
        'This downloaded mod is missing Thunderstore or Nexus source metadata, so SIMM cannot fetch an update for it.',
      );
      return;
    }

    const existingLatestEntry = group.remoteVersion
      ? group.entries.find(entry => areVersionsEquivalent(getEntryVersionLabel(entry), group.remoteVersion))
      : undefined;

    if (existingLatestEntry) {
      const latestAlreadyActive = group.installedIn.length > 0 && group.entries.every(entry => {
        const hasInstallations = entry.installedIn.length > 0;
        if (!hasInstallations) {
          return true;
        }
        return entry.storageId === existingLatestEntry.storageId;
      });

      await activateGroupEntry(group, existingLatestEntry);
      if (latestAlreadyActive) {
        showLibraryNotice(
          'Already Updated',
          `The latest version ${formatVersionTag(group.remoteVersion)} is already downloaded and active for this mod.`,
        );
      }
      return;
    }

    const targetRuntimes = (['IL2CPP', 'Mono'] as const).filter(runtime => {
      return (group.installedInByRuntime[runtime] || []).length > 0;
    });
    const runtimesToUpdate: Array<'IL2CPP' | 'Mono'> = targetRuntimes.length > 0
      ? [...targetRuntimes]
      : (group.availableRuntimes.length > 0 ? [...group.availableRuntimes] : ['IL2CPP']);

    setUpdatingGroup(group.key);
    let keepPendingUpdate = false;
    try {
      const downloadedStorageByRuntime: Partial<Record<'IL2CPP' | 'Mono', string>> = {};
      let downloadedUpdatedRuntime = false;
      const thunderstoreMissingRuntimes: Array<'IL2CPP' | 'Mono'> = [];

      if (sourceEntry.source === 'thunderstore') {
        if (!sourceEntry.sourceId) {
          throw new Error('Missing Thunderstore source id for update');
        }

        for (const runtime of runtimesToUpdate) {
          const pkg = await findThunderstorePackageForRuntime(sourceEntry.sourceId, runtime);
          if (!pkg) {
            thunderstoreMissingRuntimes.push(runtime);
            continue;
          }
          const result = await downloadThunderstoreWithSecurity(pkg.uuid4, runtime, `Security Findings - ${group.displayName}`);
          if (!result) {
            return;
          }
          if (result?.storageId) {
            downloadedStorageByRuntime[runtime] = result.storageId;
            downloadedUpdatedRuntime = true;
          }
        }

        if (Object.keys(downloadedStorageByRuntime).length === 0) {
          if (thunderstoreMissingRuntimes.length > 0) {
            throw new Error(`Could not resolve the latest Thunderstore package for ${thunderstoreMissingRuntimes.join('/')} runtime.`);
          }
          throw new Error('Thunderstore update did not produce a downloadable library entry.');
        }
      } else if (sourceEntry.source === 'nexusmods') {
        const modId = Number(sourceEntry.sourceId || '0');
        if (!Number.isFinite(modId) || modId <= 0) {
          throw new Error('Missing NexusMods mod id for update');
        }

        const access = await getEffectiveNexusDownloadAccess();
        if (!access.connected) {
          throw new Error('Nexus login is required to download Nexus mods.');
        }

        const files = await ApiService.getNexusModsModFiles('schedule1', modId);

        if (!access.canDirectDownload && access.requiresSiteConfirmation) {
          const beginManualUpdateForRuntime = async (runtime: 'IL2CPP' | 'Mono') => {
            const file = pickNexusFileForVersionAndRuntime(files, runtime, group.remoteVersion);
            if (!file?.file_id) {
              throw new Error(`No Nexus file found for ${runtime}.`);
            }

            await beginManualNexusLibraryDownload(
              modId,
              file.file_id,
              runtime,
              async () => {
                await refreshLibrary();

                if (runtimesToUpdate.length > 1) {
                  showLibraryNotice(
                    'One Runtime Updated',
                    'Downloaded one runtime for this Nexus mod. Repeat the update for the other runtime before re-activating the version across all environments.',
                  );
                  return;
                }

                const nextLibrary = await ApiService.getModLibrary();
                setLibrary(nextLibrary);
                notifyLibraryUpdated();

                const refreshedGroup = buildDownloadedGroups(nextLibrary.downloaded).find(item => item.key === group.key);
                const selectedEntry = refreshedGroup?.entries.find(entry => {
                  return group.remoteVersion && areVersionsEquivalent(getEntryVersionLabel(entry), group.remoteVersion);
                }) || refreshedGroup?.entries[0];

                if (refreshedGroup && selectedEntry) {
                  await activateGroupEntry(refreshedGroup, selectedEntry);
                }
              },
              'Nexus Update Failed',
            );
            keepPendingUpdate = true;
          };

          if (runtimesToUpdate.length > 1) {
            setRuntimePrompt({
              title: 'Select Runtime',
              message: 'Free Nexus downloads must be confirmed one file at a time. Choose the runtime to update now.',
              onSelect: (runtime) => {
                if (runtime === 'Both') {
                  showLibraryNotice(
                    'Select One Runtime',
                    'Choose Mono or IL2CPP for this update. Repeat the update for the other runtime separately.',
                  );
                  return;
                }
                setRuntimePrompt(null);
                setUpdatingGroup(group.key);
                void beginManualUpdateForRuntime(runtime).catch((error) => {
                  setUpdatingGroup(null);
                  showLibraryNotice(
                    'Nexus Update Failed',
                    error instanceof Error ? error.message : 'Failed to start the Nexus manual update.',
                  );
                });
              },
            });
            return;
          }

          await beginManualUpdateForRuntime(runtimesToUpdate[0]);
          return;
        }

        for (const runtime of runtimesToUpdate) {
          const file = pickNexusFileForVersionAndRuntime(files, runtime, group.remoteVersion);
          if (!file?.file_id) {
            continue;
          }
          const result = await downloadNexusWithSecurity(modId, file.file_id, runtime, 'Security Findings - Nexus Update');
          if (!result) {
            return;
          }
          if (result?.storageId) {
            downloadedStorageByRuntime[runtime] = result.storageId;
            downloadedUpdatedRuntime = true;
          }
        }
      }

      if (!downloadedUpdatedRuntime) {
        throw new Error('No updated mod package could be downloaded for the selected runtime.');
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

      if (!refreshedGroup) {
        throw new Error('Updated mod entry was not found in the library after download.');
      }

      if (!selectedEntry) {
        throw new Error('Updated mod version could not be selected after download.');
      }

      if (group.remoteVersion && !areVersionsEquivalent(getEntryVersionLabel(selectedEntry), group.remoteVersion)) {
        throw new Error(`Downloaded library entry did not match the expected latest version ${formatVersionTag(group.remoteVersion)}.`);
      }

      await activateGroupEntry(refreshedGroup, selectedEntry);
    } catch (err) {
      console.error('Failed to update and activate mod version:', err);
      showLibraryNotice(
        'Mod Update Failed',
        err instanceof Error ? err.message : 'Failed to update this mod version.',
      );
    } finally {
      if (!keepPendingUpdate) {
        setUpdatingGroup(null);
      }
    }
  }, [activateGroupEntry, beginManualNexusLibraryDownload, downloadNexusWithSecurity, downloadThunderstoreWithSecurity, findThunderstorePackageForRuntime, getEffectiveNexusDownloadAccess, getEntryVersionLabel, notifyLibraryUpdated, pickNexusFileForVersionAndRuntime, refreshLibrary, showLibraryNotice]);

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

  const findDownloadedEntryByStorageIds = useCallback((group: DownloadedModGroup, storageIds: string[]) => {
    if (storageIds.length === 0) {
      return null;
    }

    return group.entries.find((entry) =>
      storageIds.includes(entry.storageId)
      || Object.values(entry.storageIdsByRuntime || {}).some((id) => id ? storageIds.includes(id) : false)
    ) || null;
  }, []);

  const entrySupportsRuntime = useCallback((entry: ModLibraryEntry, runtime: 'IL2CPP' | 'Mono') => {
    if (entry.storageIdsByRuntime?.[runtime]) {
      return true;
    }
    if ((entry.availableRuntimes?.length || 0) > 0) {
      return entry.availableRuntimes.includes(runtime);
    }
    return !!entry.storageId;
  }, []);

  const getEntryStorageIds = useCallback((entry: ModLibraryEntry) => {
    return Array.from(
      new Set(
        [entry.storageId, ...Object.values(entry.storageIdsByRuntime || {})].filter(
          (id): id is string => Boolean(id)
        )
      )
    );
  }, []);

  const getContainingDownloadedGroup = useCallback((entry: ModLibraryEntry) => {
    const entryStorageIds = new Set(getEntryStorageIds(entry));
    return downloadedGroups.find((group) =>
      group.entries.some((candidate) =>
        getEntryStorageIds(candidate).some((storageId) => entryStorageIds.has(storageId))
      )
    ) || null;
  }, [downloadedGroups, getEntryStorageIds]);

  const hasSiblingVersionInstalledInEnvironment = useCallback((
    entry: ModLibraryEntry,
    environment: Environment,
  ) => {
    const containingGroup = getContainingDownloadedGroup(entry);
    if (!containingGroup) {
      return false;
    }

    const targetStorageIds = new Set(getEntryStorageIds(entry));
    return containingGroup.entries.some((candidate) => {
      const candidateStorageIds = getEntryStorageIds(candidate);
      if (candidateStorageIds.some((storageId) => targetStorageIds.has(storageId))) {
        return false;
      }
      const siblingInstalledIds =
        candidate.installedInByRuntime?.[environment.runtime] || candidate.installedIn || [];
      return siblingInstalledIds.includes(environment.id);
    });
  }, [getContainingDownloadedGroup, getEntryStorageIds]);

  const closeInstallDialog = useCallback(() => {
    setInstallDialog({
      isOpen: false,
      title: '',
      entry: null,
      compatibleEnvironments: [],
      excludedEnvironments: [],
    });
    setSelectedInstallEnvironmentIds(new Set());
  }, []);

  const installEntryToEnvironmentIds = useCallback(async (entry: ModLibraryEntry, environmentIds: string[]) => {
    const selectedTargets = environments.filter((environment) => environmentIds.includes(environment.id));
    const runtimeGroups = new Map<'IL2CPP' | 'Mono', string[]>();

    for (const environment of selectedTargets) {
      if (!entrySupportsRuntime(entry, environment.runtime)) {
        continue;
      }
      if (hasSiblingVersionInstalledInEnvironment(entry, environment)) {
        continue;
      }
      const existing = runtimeGroups.get(environment.runtime) || [];
      existing.push(environment.id);
      runtimeGroups.set(environment.runtime, existing);
    }

    for (const [runtime, targetIds] of runtimeGroups.entries()) {
      const storageId = entry.storageIdsByRuntime?.[runtime] || entry.storageId;
      if (!storageId || targetIds.length === 0) {
        continue;
      }
      await ApiService.installDownloadedMod(storageId, targetIds);
    }
  }, [entrySupportsRuntime, environments, hasSiblingVersionInstalledInEnvironment]);

  const promptInstallTargets = useCallback(async (entry: ModLibraryEntry, title: string, installMoreOnly: boolean) => {
    const compatible = environments.filter((environment) => {
      if (!entrySupportsRuntime(entry, environment.runtime)) {
        return false;
      }
      if (hasSiblingVersionInstalledInEnvironment(entry, environment)) {
        return false;
      }
      if (!installMoreOnly) {
        return true;
      }
      const installedIds = entry.installedInByRuntime?.[environment.runtime] || entry.installedIn || [];
      return !installedIds.includes(environment.id);
    });
    const excluded = environments.filter((environment) => !entrySupportsRuntime(entry, environment.runtime));

    if (compatible.length === 0) {
      showLibraryNotice('No Compatible Environments', 'This mod version is not compatible with any currently configured environments.');
      return;
    }

    if (compatible.length === 1) {
      setInstallingTargets(true);
      try {
        await installEntryToEnvironmentIds(entry, [compatible[0].id]);
        await refreshLibrary();
        notifyLibraryUpdated();
        notifyModUpdateStateChanged();
      } catch (error) {
        showLibraryNotice('Install Failed', error instanceof Error ? error.message : 'Failed to install this mod.');
      } finally {
        setInstallingTargets(false);
      }
      return;
    }

    setSelectedInstallEnvironmentIds(new Set());
    setInstallDialog({
      isOpen: true,
      title,
      entry,
      compatibleEnvironments: compatible,
      excludedEnvironments: excluded,
    });
  }, [downloadedGroups, entrySupportsRuntime, environments, hasSiblingVersionInstalledInEnvironment, installEntryToEnvironmentIds, notifyLibraryUpdated, notifyModUpdateStateChanged, refreshLibrary, showLibraryNotice]);

  const handleConfirmInstallTargets = useCallback(async () => {
    if (!installDialog.entry || selectedInstallEnvironmentIds.size === 0) {
      return;
    }

    setInstallingTargets(true);
    try {
      await installEntryToEnvironmentIds(installDialog.entry, Array.from(selectedInstallEnvironmentIds));
      await refreshLibrary();
      notifyLibraryUpdated();
      notifyModUpdateStateChanged();
      closeInstallDialog();
    } catch (error) {
      showLibraryNotice('Install Failed', error instanceof Error ? error.message : 'Failed to install the selected environments.');
    } finally {
      setInstallingTargets(false);
    }
  }, [closeInstallDialog, installDialog.entry, installEntryToEnvironmentIds, notifyLibraryUpdated, notifyModUpdateStateChanged, refreshLibrary, selectedInstallEnvironmentIds, showLibraryNotice]);

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
      const result = await ApiService.downloadS1APIToLibrary(selectedS1APIVersion);
      if (!result.success) {
        const handled = handleSecurityGateResult('Security Findings - S1API', result, async () => {
          const retry = await ApiService.downloadS1APIToLibrary(selectedS1APIVersion, true);
          if (!retry.success) {
            throw new Error(retry.error || 'Failed to continue the S1API download after confirming the MLVScan findings.');
          }
          await refreshLibrary();
        });
        if (!handled) {
          return;
        }

        throw new Error(result.error || 'Failed to download S1API.');
      }

      await refreshLibrary();
    } catch (err) {
      console.error('Failed to download S1API:', err);
      showLibraryNotice('S1API Download Failed', err instanceof Error ? err.message : 'Failed to download S1API.');
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
      const result = await ApiService.downloadMLVScanToLibrary(selectedMlvscanVersion);
      if (!result.success) {
        const handled = handleSecurityGateResult('Security Findings - MLVScan', result, async () => {
          const retry = await ApiService.downloadMLVScanToLibrary(selectedMlvscanVersion, true);
          if (!retry.success) {
            throw new Error(retry.error || 'Failed to continue the MLVScan download after confirming the MLVScan findings.');
          }
          await refreshLibrary();
        });
        if (!handled) {
          return;
        }

        throw new Error(result.error || 'Failed to download MLVScan.');
      }

      await refreshLibrary();
    } catch (err) {
      console.error('Failed to download MLVScan:', err);
      showLibraryNotice('MLVScan Download Failed', err instanceof Error ? err.message : 'Failed to download MLVScan.');
    } finally {
      setDownloadingMlvscan(false);
      setSelectedMlvscanVersion('');
    }
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
        const results: Array<{ success: boolean; storageId?: string; alreadyStored?: boolean }> = [];
        if (runtime === 'Both') {
          if (pkg.packagesByRuntime.IL2CPP) {
            const result = await downloadThunderstoreWithSecurity(pkg.packagesByRuntime.IL2CPP.uuid4, 'IL2CPP', `Security Findings - ${pkg.name}`);
            if (!result) {
              return;
            }
            results.push(result);
          }
          if (pkg.packagesByRuntime.Mono) {
            const result = await downloadThunderstoreWithSecurity(pkg.packagesByRuntime.Mono.uuid4, 'Mono', `Security Findings - ${pkg.name}`);
            if (!result) {
              return;
            }
            results.push(result);
          }
        } else if (pkg.packagesByRuntime[runtime]) {
          const result = await downloadThunderstoreWithSecurity(pkg.packagesByRuntime[runtime]!.uuid4, runtime, `Security Findings - ${pkg.name}`);
          if (!result) {
            return;
          }
          results.push(result);
        }
        const nextLibrary = await ApiService.getModLibrary();
        setLibrary(nextLibrary);
        notifyLibraryUpdated();
        if (results.length > 0 && results.every(result => result.alreadyStored)) {
          showLibraryNotice(
            'Already Downloaded',
            `The latest version of ${pkg.name} is already in your mod library.`,
          );
        } else {
          const refreshedGroup = findDownloadedGroupForThunderstorePackage(pkg, nextLibrary);
          const downloadedStorageIds = results.flatMap((result) => result.storageId ? [result.storageId] : []);
          const selectedEntry = refreshedGroup
            ? findDownloadedEntryByStorageIds(refreshedGroup, downloadedStorageIds)
              || getActiveEntryForGroup(refreshedGroup)
              || refreshedGroup.entries[0]
            : null;
          if (selectedEntry) {
            openDownloadedModView(refreshedGroup!, selectedEntry.storageId);
            await promptInstallTargets(selectedEntry, `Install ${selectedEntry.displayName}`, false);
          }
        }
      } catch (err) {
        console.error('Failed to download Thunderstore mod:', err);
        showLibraryNotice(
          'Thunderstore Download Failed',
          err instanceof Error ? err.message : 'Failed to download this Thunderstore mod.',
        );
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

    const access = await getEffectiveNexusDownloadAccess();
    if (!access.connected) {
      showLibraryNotice('Nexus Login Required', 'Log into Nexus in Accounts before downloading Nexus mods.');
      return;
    }

    const runDownload = async (runtime: 'IL2CPP' | 'Mono' | 'Both') => {
      setDownloading(`nexus-${modId}`);
      let keepPendingDownload = false;
      try {
        const results: Array<{ success: boolean; storageId?: string; alreadyStored?: boolean }> = [];
        if (!access.canDirectDownload && access.requiresSiteConfirmation) {
          if (runtime === 'Both') {
            throw new Error('Manual Nexus download flow requires a single runtime selection.');
          }

          const targetFile = selectNexusFileForRuntime(files, runtime);
          if (!targetFile?.file_id) {
            throw new Error(`No Nexus file found for ${runtime}.`);
          }

          await beginManualNexusLibraryDownload(
            modId,
            targetFile.file_id,
            runtime,
            async () => {
              await refreshLibrary();
              notifyLibraryUpdated();
            },
          );
          keepPendingDownload = true;
          return;
        }

        if (runtime === 'Both') {
          const il2cppFile = selectNexusFileForRuntime(files, 'IL2CPP');
          const monoFile = selectNexusFileForRuntime(files, 'Mono');
          if (il2cppFile?.file_id) {
            const result = await downloadNexusWithSecurity(modId, il2cppFile.file_id, 'IL2CPP', 'Security Findings - Nexus Download');
            if (!result) {
              return;
            }
            results.push(result);
          }
          if (monoFile?.file_id && monoFile?.file_id !== il2cppFile?.file_id) {
            const result = await downloadNexusWithSecurity(modId, monoFile.file_id, 'Mono', 'Security Findings - Nexus Download');
            if (!result) {
              return;
            }
            results.push(result);
          }
        } else {
          const targetFile = selectNexusFileForRuntime(files, runtime);
          if (!targetFile?.file_id) return;
          const result = await downloadNexusWithSecurity(modId, targetFile.file_id, runtime, 'Security Findings - Nexus Download');
          if (!result) {
            return;
          }
          results.push(result);
        }
        const nextLibrary = await ApiService.getModLibrary();
        setLibrary(nextLibrary);
        notifyLibraryUpdated();
        const refreshedGroup = findDownloadedGroupForNexusMod(modId, nextLibrary);
        const selectedEntry = refreshedGroup
          ? findDownloadedEntryByStorageIds(
            refreshedGroup,
            results.flatMap((result) => result.storageId ? [result.storageId] : [])
          ) || getActiveEntryForGroup(refreshedGroup) || refreshedGroup.entries[0]
          : null;
        if (selectedEntry) {
          openDownloadedModView(refreshedGroup!, selectedEntry.storageId);
          await promptInstallTargets(selectedEntry, `Install ${selectedEntry.displayName}`, false);
        }
      } catch (err) {
        console.error('Failed to download Nexus mod:', err);
        showLibraryNotice('Nexus Download Failed', err instanceof Error ? err.message : 'Failed to download Nexus mod.');
      } finally {
        if (!keepPendingDownload) {
          setDownloading(null);
        }
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

    if (!access.canDirectDownload && access.requiresSiteConfirmation && hasIl2cpp && hasMono) {
      setRuntimePrompt({
        title: 'Select Runtime',
        message: 'Free Nexus downloads must be confirmed one file at a time. Choose the runtime to download now.',
        onSelect: (runtime) => {
          if (runtime === 'Both') {
            showLibraryNotice(
              'Select One Runtime',
              'Choose Mono or IL2CPP for this manual Nexus download. Repeat the download for the other runtime separately.',
            );
            return;
          }
          setRuntimePrompt(null);
          void runDownload(runtime);
        },
      });
      return;
    }

    if (hasIl2cpp && hasMono) {
      runDownload('Both');
      return;
    }

    runDownload(hasIl2cpp ? 'IL2CPP' : 'Mono');
  };

  const openDownloadedModView = useCallback((group: DownloadedModGroup, preferredStorageId?: string) => {
    const preferredEntry = preferredStorageId
      ? group.entries.find(entry => {
          if (entry.storageId === preferredStorageId) {
            return true;
          }

          return Object.values(entry.storageIdsByRuntime || {}).includes(preferredStorageId);
        })
      : null;
    const activeEntry = preferredEntry || getActiveEntryForGroup(group) || group.entries[0];
    openModView({
      id: group.key,
      storageId: activeEntry?.storageId,
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
      securityScan: activeEntry?.securityScan,
      kind: 'downloaded',
    });
  }, [getActiveEntryForGroup, openModView]);

  useEffect(() => {
    if (!isOpen || !focusStorageId || !focusRequestId) {
      return;
    }

    if (lastHandledFocusRequestIdRef.current === focusRequestId) {
      return;
    }

    if (downloadedGroups.length === 0) {
      return;
    }

    const targetGroup = downloadedGroups.find(group =>
      group.entries.some(entry =>
        entry.storageId === focusStorageId || Object.values(entry.storageIdsByRuntime || {}).includes(focusStorageId)
      )
    );

    if (!targetGroup) {
      return;
    }

    lastHandledFocusRequestIdRef.current = focusRequestId;
    setOpenedFromLogs({ active: true, modTag: focusModTag ?? null });
    void handleSelectVersion(targetGroup, focusStorageId);
    openDownloadedModView(targetGroup, focusStorageId);
  }, [
    downloadedGroups,
    focusModTag,
    focusRequestId,
    focusStorageId,
    handleSelectVersion,
    isOpen,
    openDownloadedModView,
  ]);

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

  const findDownloadedGroupForThunderstorePackage = useCallback((pkg: ThunderstorePackageGroup, sourceLibrary?: ModLibraryResult | null) => {
    const groups = buildDownloadedGroups(sourceLibrary?.downloaded ?? library?.downloaded ?? []);
    return groups.find((group) => group.entries.some((entry) => {
      if (entry.source !== 'thunderstore') {
        return false;
      }
      const parsed = parseThunderstoreSourceId(entry.sourceId);
      return parsed.owner.toLowerCase() === pkg.owner.toLowerCase()
        && normalizeThunderstoreName(parsed.name).toLowerCase() === normalizeThunderstoreName(pkg.name).toLowerCase();
    })) || null;
  }, [library]);

  const findDownloadedGroupForNexusMod = useCallback((modId: number, sourceLibrary?: ModLibraryResult | null) => {
    const groups = buildDownloadedGroups(sourceLibrary?.downloaded ?? library?.downloaded ?? []);
    return groups.find((group) => group.entries.some((entry) => entry.source === 'nexusmods' && Number(entry.sourceId || '0') === modId)) || null;
  }, [library]);

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

  const displayedDownloadedGroups = useMemo(() => {
    if (libraryTab === 'updates') {
      return filteredDownloadedGroups.filter((group) => isGroupUpdateAvailable(group));
    }
    return filteredDownloadedGroups;
  }, [downloadedGroups, filteredDownloadedGroups, isGroupUpdateAvailable, libraryTab]);

  const selectedDownloadedGroup = useMemo(() => {
    if (activeModView?.kind !== 'downloaded') {
      return null;
    }
    return downloadedGroups.find((group) => group.key === activeModView.id) || null;
  }, [activeModView, downloadedGroups]);

  const selectedDownloadedEntry = useMemo(() => {
    if (!selectedDownloadedGroup) {
      return null;
    }
    return getActiveEntryForGroup(selectedDownloadedGroup) || selectedDownloadedGroup.entries[0] || null;
  }, [getActiveEntryForGroup, selectedDownloadedGroup]);

  const selectedDownloadedGroupEntries = useMemo(() => {
    if (!selectedDownloadedGroup) {
      return [];
    }
    return getSortedGroupEntries(selectedDownloadedGroup);
  }, [getSortedGroupEntries, selectedDownloadedGroup]);

  const selectedThunderstorePackage = useMemo(() => {
    if (activeModView?.kind !== 'thunderstore') {
      return null;
    }
    return searchResults.find((pkg) => pkg.key === activeModView.id) || null;
  }, [activeModView, searchResults]);

  const selectedNexusResult = useMemo(() => {
    if (activeModView?.kind !== 'nexusmods') {
      return null;
    }
    return nexusModsSearchResults.find((mod) => String(mod.mod_id) === activeModView.id) || null;
  }, [activeModView, nexusModsSearchResults]);

  const downloadedGroupForSelectedThunderstore = useMemo(() => {
    if (!selectedThunderstorePackage) {
      return null;
    }
    return findDownloadedGroupForThunderstorePackage(selectedThunderstorePackage);
  }, [findDownloadedGroupForThunderstorePackage, selectedThunderstorePackage]);

  const downloadedGroupForSelectedNexus = useMemo(() => {
    if (!selectedNexusResult) {
      return null;
    }
    return findDownloadedGroupForNexusMod(selectedNexusResult.mod_id);
  }, [findDownloadedGroupForNexusMod, selectedNexusResult]);

  const selectedThunderstoreDownloadedEntry = useMemo(() => {
    if (!downloadedGroupForSelectedThunderstore) {
      return null;
    }
    return getActiveEntryForGroup(downloadedGroupForSelectedThunderstore) || downloadedGroupForSelectedThunderstore.entries[0] || null;
  }, [downloadedGroupForSelectedThunderstore, getActiveEntryForGroup]);

  const selectedNexusDownloadedEntry = useMemo(() => {
    if (!downloadedGroupForSelectedNexus) {
      return null;
    }
    return getActiveEntryForGroup(downloadedGroupForSelectedNexus) || downloadedGroupForSelectedNexus.entries[0] || null;
  }, [downloadedGroupForSelectedNexus, getActiveEntryForGroup]);

  useEffect(() => {
    if (!isOpen || openedFromLogs.active) {
      return;
    }

    if (libraryTab === 'discover') {
      if (activeModView?.kind === 'downloaded') {
        return;
      }

      if (showSearchResults && searchResults.length > 0) {
        const stillValid = activeModView?.kind === 'thunderstore' && searchResults.some((pkg) => pkg.key === activeModView.id);
        if (!stillValid) {
          openThunderstoreModView(searchResults[0]);
        }
        return;
      }

      if (showNexusModsResults && nexusModsSearchResults.length > 0) {
        const stillValid = activeModView?.kind === 'nexusmods' && nexusModsSearchResults.some((mod) => String(mod.mod_id) === activeModView.id);
        if (!stillValid) {
          openNexusModView(nexusModsSearchResults[0]);
        }
        return;
      }

      return;
    }

    if (displayedDownloadedGroups.length === 0) {
      return;
    }

    const stillValid = activeModView?.kind === 'downloaded'
      && displayedDownloadedGroups.some((group) => group.key === activeModView.id);
    if (!stillValid) {
      openDownloadedModView(displayedDownloadedGroups[0]);
    }
  }, [
    activeModView,
    displayedDownloadedGroups,
    isOpen,
    libraryTab,
    nexusModsSearchResults,
    openDownloadedModView,
    openNexusModView,
    openThunderstoreModView,
    openedFromLogs.active,
    searchResults,
    showNexusModsResults,
    showSearchResults,
  ]);

  const openContextMenu = useCallback((event: ReactMouseEvent, items: AnchoredContextMenuItem[]) => {
    event.preventDefault();
    setContextMenu({ x: event.clientX, y: event.clientY, items });
  }, []);

  const downloadedContextMenuItems = useCallback((group: DownloadedModGroup): AnchoredContextMenuItem[] => {
    const entry = getActiveEntryForGroup(group) || group.entries[0];
    return [
      {
        key: 'install',
        label: group.installedIn.length > 0 ? 'Install to more…' : 'Install…',
        icon: 'fas fa-download',
        disabled: !entry,
        onSelect: () => {
          if (entry) {
            void promptInstallTargets(entry, `Install ${entry.displayName}`, group.installedIn.length > 0);
          }
        },
      },
      {
        key: 'update',
        label: 'Update',
        icon: 'fas fa-arrow-up',
        disabled: !isGroupUpdateAvailable(group),
        onSelect: () => {
          void handleUpdateAndActivateGroup(group);
        },
      },
      {
        key: 'activate',
        label: 'Activate version',
        icon: 'fas fa-check',
        disabled: !entry || group.installedIn.length === 0,
        onSelect: () => {
          if (entry) {
            void handleSelectVersion(group, entry.storageId);
          }
        },
      },
      {
        key: 'source',
        label: 'Open source page',
        icon: 'fas fa-arrow-up-right-from-square',
        disabled: !safeExternalUrl(entry?.sourceUrl),
        onSelect: () => {
          const url = safeExternalUrl(entry?.sourceUrl);
          if (url) {
            window.open(url, '_blank', 'noopener,noreferrer');
          }
        },
      },
      {
        key: 'delete',
        label: 'Delete downloaded files',
        icon: 'fas fa-trash',
        danger: true,
        onSelect: () => {
          void handleDeleteDownloadedGroup(group);
        },
      },
    ];
  }, [getActiveEntryForGroup, handleDeleteDownloadedGroup, handleSelectVersion, handleUpdateAndActivateGroup, isGroupUpdateAvailable, promptInstallTargets]);

  const s1apiActionLabel = s1apiInLibrary ? (s1apiNeedsUpdate ? 'Update' : 'Downloaded') : 'Download';
  const mlvscanActionLabel = mlvscanInLibrary ? (mlvscanNeedsUpdate ? 'Update' : 'Downloaded') : 'Download';

  if (!isOpen) return null;

  const legacyLayout = () => (
    <>
      <ConfirmOverlay
        isOpen={confirmOverlay.isOpen}
        onClose={() => setConfirmOverlay({ isOpen: false, title: '', message: '', onConfirm: () => {} })}
        onConfirm={confirmOverlay.onConfirm}
        title={confirmOverlay.title}
        message={confirmOverlay.message}
        isNested
      />
      <SecurityScanReportOverlay
        isOpen={!!activeSecurityReport}
        title={activeSecurityReport?.title || 'Security Findings'}
        report={activeSecurityReport?.report || null}
        onClose={closeSecurityReport}
        onConfirm={activeSecurityReport?.onConfirm ? () => { void handleSecurityReportConfirm(); } : undefined}
        confirmLabel={activeSecurityReport?.confirmLabel || 'Continue Download'}
        busy={securityActionBusy}
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
                    const securityBadge = settings?.showSecurityScanBadges !== false
                      ? getSecurityBadgeConfig(activeEntry?.securityScan)
                      : null;
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
                            <div className="mod-card-title-row">
                              <strong className="mod-card-title-text" style={{ fontSize: '0.94rem' }} title={group.displayName}>
                                {group.displayName}
                              </strong>
                            </div>
                            <div className="mod-card-meta-row" style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', flexWrap: 'wrap' }}>
                              <span style={{
                                fontSize: '0.64rem',
                                padding: '0.1rem 0.35rem',
                                borderRadius: '999px',
                                ...getSourceBadgeStyle(activeEntry?.source),
                              }}>
                                {getSourceBadgeLabel(activeEntry?.source)}
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
                            {securityBadge && activeEntry?.storageId && (
                              <button
                                type="button"
                                onClick={(event) => {
                                  event.stopPropagation();
                                  void openStoredSecurityReport(activeEntry.storageId!, `Security Findings - ${group.displayName}`);
                                }}
                                style={{
                                  alignSelf: 'start',
                                  display: 'inline-flex',
                                  alignItems: 'center',
                                  gap: '0.35rem',
                                  marginTop: '0.1rem',
                                  borderRadius: '4px',
                                  border: `1px solid ${securityBadge.border}`,
                                  background: securityBadge.background,
                                  color: securityBadge.color,
                                  padding: '0.15rem 0.4rem',
                                  fontSize: '0.7rem',
                                  cursor: 'pointer',
                                  whiteSpace: 'nowrap',
                                  lineHeight: 1,
                                }}
                              >
                                <i className={`fas ${securityBadge.icon}`} style={{ fontSize: '0.7rem' }}></i>
                                {securityBadge.label}
                              </button>
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
                          <div
                            className="mod-card-version-row"
                            data-version-switcher
                            style={{ position: 'relative', zIndex: openVersionMenuGroup === group.key ? 100 : 'auto' }}
                            onClick={(e) => e.stopPropagation()}
                          >
                            <div
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
                  {openedFromLogs.active && (
                    <span
                      style={{
                        fontSize: '0.72rem',
                        color: '#9ed0ff',
                        backgroundColor: '#1a2f46',
                        border: '1px solid #335d83',
                        borderRadius: '999px',
                        padding: '0.12rem 0.5rem',
                      }}
                    >
                      <i className="fas fa-file-alt"></i>
                      {' '}
                      Opened from Logs{openedFromLogs.modTag ? `: ${openedFromLogs.modTag}` : ''}
                    </span>
                  )}
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
                    {settings?.showSecurityScanBadges !== false && getSecurityBadgeConfig(activeModView.securityScan) && (
                      <div style={{ marginTop: '0.55rem', display: 'flex', gap: '0.45rem', flexWrap: 'wrap' }}>
                        <span
                          style={{
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: '0.35rem',
                            borderRadius: '999px',
                            border: `1px solid ${getSecurityBadgeConfig(activeModView.securityScan)?.border}`,
                            background: getSecurityBadgeConfig(activeModView.securityScan)?.background,
                            color: getSecurityBadgeConfig(activeModView.securityScan)?.color,
                            padding: '0.1rem 0.4rem',
                            fontSize: '0.72rem',
                            whiteSpace: 'nowrap',
                            lineHeight: 1,
                          }}
                        >
                          <i className={`fas ${getSecurityBadgeConfig(activeModView.securityScan)?.icon}`} style={{ fontSize: '0.7rem' }}></i>
                          {getSecurityBadgeConfig(activeModView.securityScan)?.label}
                        </span>
                      </div>
                    )}
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
                  {activeModView.storageId && activeModView.securityScan && (
                    <button
                      className="btn btn-secondary btn-small"
                      onClick={() => void openStoredSecurityReport(activeModView.storageId!, `Security Findings - ${activeModView.name}`)}
                    >
                      <i className="fas fa-shield-alt" style={{ marginRight: '0.45rem' }}></i>
                      Security Report
                    </button>
                  )}
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

  void legacyLayout;

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
      <InstallTargetsDialog
        isOpen={installDialog.isOpen}
        title={installDialog.title}
        entry={installDialog.entry}
        compatibleEnvironments={installDialog.compatibleEnvironments}
        excludedEnvironments={installDialog.excludedEnvironments}
        selectedEnvironmentIds={selectedInstallEnvironmentIds}
        onToggleEnvironment={(environmentId) => {
          setSelectedInstallEnvironmentIds((previous) => {
            const next = new Set(previous);
            if (next.has(environmentId)) next.delete(environmentId);
            else next.add(environmentId);
            return next;
          });
        }}
        onSelectAllCompatible={() => setSelectedInstallEnvironmentIds(new Set(installDialog.compatibleEnvironments.map((environment) => environment.id)))}
        onSelectRuntime={(runtime) => setSelectedInstallEnvironmentIds(new Set(
          installDialog.compatibleEnvironments.filter((environment) => environment.runtime === runtime).map((environment) => environment.id),
        ))}
        onClear={() => setSelectedInstallEnvironmentIds(new Set())}
        onClose={closeInstallDialog}
        onConfirm={() => void handleConfirmInstallTargets()}
        installing={installingTargets}
      />
      {runtimePrompt && (
        <div className="modal-overlay modal-overlay-nested" onClick={() => setRuntimePrompt(null)}>
          <div className="modal-content modal-content-nested" onClick={(e) => e.stopPropagation()} style={{ maxWidth: '420px' }}>
            <div className="modal-header">
              <h2>{runtimePrompt.title}</h2>
              <button className="modal-close" onClick={() => setRuntimePrompt(null)}>×</button>
            </div>
            <div style={{ padding: '1rem 1.25rem 1.25rem' }}>
              <p style={{ marginTop: 0, color: '#ccc' }}>{runtimePrompt.message}</p>
              <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end' }}>
                <button className="btn btn-secondary" onClick={() => { const handler = runtimePrompt.onSelect; setRuntimePrompt(null); handler('Mono'); }}>Mono</button>
                <button className="btn btn-secondary" onClick={() => { const handler = runtimePrompt.onSelect; setRuntimePrompt(null); handler('IL2CPP'); }}>IL2CPP</button>
                <button className="btn btn-primary" onClick={() => { const handler = runtimePrompt.onSelect; setRuntimePrompt(null); handler('Both'); }}>Both</button>
              </div>
            </div>
          </div>
        </div>
      )}

      <div className="mods-overlay mods-overlay--library workspace-collection-shell">
        <div className="modal-header">
          <h2>Mod Library</h2>
          <button className="btn btn-secondary btn-small" onClick={onClose}>
            <i className="fas fa-arrow-left" style={{ marginRight: '0.45rem' }}></i>
            Back
          </button>
        </div>

        <div className="workspace-collection">
          <div className="workspace-collection__main">
            <div className="workspace-collection__header">
              <div className="workspace-collection__nav">
                <div className="workspace-collection__rail-group workspace-collection__rail-group--inline">
                  {([
                    ['discover', 'Discover', 'fas fa-compass'],
                    ['library', 'Library', 'fas fa-book-open'],
                    ['updates', 'Updates', 'fas fa-arrow-up'],
                  ] as Array<[LibraryTab, string, string]>).map(([tab, label, icon]) => (
                    <button
                      key={tab}
                      type="button"
                      className={`workspace-collection__rail-button ${libraryTab === tab ? 'workspace-collection__rail-button--active' : ''}`}
                      onClick={() => setLibraryTab(tab)}
                    >
                      <i className={icon}></i>
                      <span>{label}</span>
                    </button>
                  ))}
                </div>

                <div className="workspace-collection__summary">
                  <div className="workspace-collection__summary-chip">
                    <span>Downloaded</span>
                    <strong>{downloadedSummary.total}</strong>
                  </div>
                  <div className="workspace-collection__summary-chip">
                    <span>Updates</span>
                    <strong>{downloadedSummary.updates}</strong>
                  </div>
                  <div className="workspace-collection__summary-chip">
                    <span>Installed</span>
                    <strong>{downloadedSummary.installed}</strong>
                  </div>
                </div>
              </div>

              {(libraryTab === 'library' || libraryTab === 'updates') && (
                <div className="workspace-collection__rail-group workspace-collection__rail-group--inline workspace-collection__filters-row">
                  {(['all', 'updates', 'managed', 'external', 'installed'] as DownloadedFilter[]).map((filter) => (
                    <button
                      key={filter}
                      type="button"
                      className={`workspace-collection__rail-button workspace-collection__rail-button--subtle ${downloadedFilter === filter ? 'workspace-collection__rail-button--active' : ''}`}
                      onClick={() => setDownloadedFilter(filter)}
                    >
                      {filter === 'all' ? 'All' : filter === 'updates' ? 'Updates' : filter === 'managed' ? 'Managed' : filter === 'external' ? 'External' : 'Installed'}
                    </button>
                  ))}
                </div>
              )}

              <div className="workspace-collection__toolbar">
                {libraryTab === 'discover' ? (
                  <>
                    <div className="workspace-collection__toolbar-group">
                      <button type="button" className={`btn btn-small ${searchSource === 'thunderstore' ? 'btn-primary' : 'btn-secondary'}`} onClick={() => { setSearchSource('thunderstore'); setShowSearchResults(false); setShowNexusModsResults(false); }}>Thunderstore</button>
                      <button type="button" className={`btn btn-small ${searchSource === 'nexusmods' ? 'btn-primary' : 'btn-secondary'}`} onClick={() => { setSearchSource('nexusmods'); setShowSearchResults(false); setShowNexusModsResults(false); }}>Nexus Mods</button>
                    </div>
                    <div className="workspace-collection__toolbar-search">
                      <input
                        type="text"
                        placeholder={searchSource === 'thunderstore' ? 'Search Thunderstore mods...' : 'Search NexusMods mods...'}
                        value={searchSource === 'thunderstore' ? searchQuery : nexusModsSearchQuery}
                        onChange={(event) => searchSource === 'thunderstore' ? setSearchQuery(event.target.value) : setNexusModsSearchQuery(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') {
                            if (searchSource === 'thunderstore') handleSearch();
                            else handleSearchNexusMods();
                          }
                        }}
                      />
                      <button
                        type="button"
                        className="btn btn-primary btn-small"
                        onClick={searchSource === 'thunderstore' ? handleSearch : handleSearchNexusMods}
                        disabled={(searchSource === 'thunderstore' ? searching : searchingNexusMods) || !(searchSource === 'thunderstore' ? searchQuery.trim() : nexusModsSearchQuery.trim())}
                      >
                        Search
                      </button>
                    </div>
                    <button className="btn btn-secondary btn-small" onClick={refreshLibrary} disabled={loadingLibrary}>
                      <i className={`fas ${loadingLibrary ? 'fa-spinner fa-spin' : 'fa-sync-alt'}`}></i>
                      <span>Refresh</span>
                    </button>
                  </>
                ) : (
                  <>
                    <div className="workspace-collection__toolbar-group workspace-collection__toolbar-group--summary">
                      <strong>{libraryTab === 'updates' ? 'Available Updates' : 'Downloaded Library'}</strong>
                      <span>{displayedDownloadedGroups.length} entries</span>
                    </div>
                    <div className="workspace-collection__toolbar-search">
                      <input type="text" value={downloadedSearch} onChange={(event) => setDownloadedSearch(event.target.value)} placeholder="Filter by mod, author, or version" />
                    </div>
                    <button className="btn btn-secondary btn-small" onClick={refreshLibrary} disabled={loadingLibrary}>
                      <i className={`fas ${loadingLibrary ? 'fa-spinner fa-spin' : 'fa-sync-alt'}`}></i>
                      <span>Refresh</span>
                    </button>
                  </>
                )}
              </div>
            </div>

            <div className="workspace-collection__content">
              {libraryTab === 'discover' && !showSearchResults && !showNexusModsResults && (
                <section className="workspace-collection__section">
                  <div className="workspace-collection__section-header">
                    <h3>Featured</h3>
                    <span>Core tools and recommended downloads</span>
                  </div>
                  <div className="workspace-feature-grid">
                    <button type="button" className="workspace-feature-card" onClick={handleDownloadS1APIClick}>
                      <div>
                        <strong>S1API</strong>
                        <p>Core GitHub release for shared APIs and interoperability.</p>
                      </div>
                      <span>{s1apiActionLabel}</span>
                    </button>
                    <button type="button" className="workspace-feature-card" onClick={handleDownloadMlvscanClick}>
                      <div>
                        <strong>MLVScan</strong>
                        <p>Library scanning and validation tooling.</p>
                      </div>
                      <span>{mlvscanActionLabel}</span>
                    </button>
                  </div>
                </section>
              )}

              {libraryTab === 'discover' && (showSearchResults || showNexusModsResults) && (
                <section className="workspace-collection__section">
                  <div className="workspace-collection__section-header">
                    <h3>{showSearchResults ? 'Discover Results' : 'Nexus Results'}</h3>
                    <span>{showSearchResults ? searchResults.length : nexusModsSearchResults.length} result(s)</span>
                  </div>
                  <div className="workspace-collection__list">
                    {showSearchResults && searchResults.map((pkg) => {
                      const representative = pkg.packagesByRuntime.IL2CPP || pkg.packagesByRuntime.Mono;
                      const latestVersion = representative?.versions?.[0];
                      const downloadedGroup = findDownloadedGroupForThunderstorePackage(pkg);
                      const isSelected = activeModView?.kind === 'thunderstore' && activeModView.id === pkg.key;
                      return (
                        <div
                          key={pkg.key}
                          className={`workspace-collection__row ${isSelected ? 'workspace-collection__row--selected' : ''}`}
                          role="button"
                          tabIndex={0}
                          onClick={() => openThunderstoreModView(pkg)}
                          onKeyDown={(event) => handleCardActivationKeyDown(event, () => openThunderstoreModView(pkg))}
                        >
                          {renderCardIcon(pkg.name, undefined, latestVersion?.icon || representative?.icon || representative?.icon_url, 'inline')}
                          <div className="workspace-collection__row-body">
                            <div className="workspace-collection__row-title">{pkg.name}</div>
                            <div className="workspace-collection__row-meta">
                              <span>{pkg.owner}</span>
                              <span className="workspace-pill workspace-pill--source">Thunderstore</span>
                              {downloadedGroup && <span className="workspace-pill workspace-pill--success">Downloaded</span>}
                              {downloadedGroup && isGroupUpdateAvailable(downloadedGroup) && <span className="workspace-pill workspace-pill--warning">Update available</span>}
                            </div>
                            <p className="workspace-collection__row-summary">{latestVersion?.description || 'No summary provided.'}</p>
                          </div>
                        </div>
                      );
                    })}

                    {showNexusModsResults && nexusModsSearchResults.map((mod) => {
                      const downloadedGroup = findDownloadedGroupForNexusMod(mod.mod_id);
                      const isSelected = activeModView?.kind === 'nexusmods' && activeModView.id === String(mod.mod_id);
                      return (
                        <div
                          key={mod.mod_id}
                          className={`workspace-collection__row ${isSelected ? 'workspace-collection__row--selected' : ''}`}
                          role="button"
                          tabIndex={0}
                          onClick={() => openNexusModView(mod)}
                          onKeyDown={(event) => handleCardActivationKeyDown(event, () => openNexusModView(mod))}
                        >
                          {renderCardIcon(mod.name, undefined, mod.picture_url, 'inline')}
                          <div className="workspace-collection__row-body">
                            <div className="workspace-collection__row-title">{mod.name}</div>
                            <div className="workspace-collection__row-meta">
                              <span>{mod.author}</span>
                              <span className="workspace-pill workspace-pill--source">Nexus Mods</span>
                              {downloadedGroup && <span className="workspace-pill workspace-pill--success">Downloaded</span>}
                              {downloadedGroup && isGroupUpdateAvailable(downloadedGroup) && <span className="workspace-pill workspace-pill--warning">Update available</span>}
                            </div>
                            <p className="workspace-collection__row-summary">{mod.summary || 'No summary provided.'}</p>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </section>
              )}

              {(libraryTab === 'library' || libraryTab === 'updates') && (
                <section className="workspace-collection__section">
                  <div className="workspace-collection__section-header">
                    <h3>{libraryTab === 'updates' ? 'Available Updates' : 'Downloaded Library'}</h3>
                    <span>{displayedDownloadedGroups.length} group(s)</span>
                  </div>
                  {loadingLibrary && <div className="workspace-collection__empty">Loading mod library…</div>}
                  {!loadingLibrary && displayedDownloadedGroups.length === 0 && <div className="workspace-collection__empty">{libraryTab === 'updates' ? 'No downloaded mods currently need updates.' : 'No downloaded mods match this filter.'}</div>}
                  {!loadingLibrary && displayedDownloadedGroups.length > 0 && (
                    <div className="workspace-collection__list">
                      {displayedDownloadedGroups.map((group) => {
                        const activeEntry = getActiveEntryForGroup(group) || group.entries[0];
                        const isSelected = activeModView?.kind === 'downloaded' && activeModView.id === group.key;
                        return (
                          <div
                            key={group.key}
                            className={`workspace-collection__row ${isSelected ? 'workspace-collection__row--selected' : ''}`}
                            role="button"
                            tabIndex={0}
                            onClick={() => openDownloadedModView(group)}
                            onKeyDown={(event) => handleCardActivationKeyDown(event, () => openDownloadedModView(group))}
                            onContextMenu={(event) => openContextMenu(event, downloadedContextMenuItems(group))}
                          >
                            {renderCardIcon(group.displayName, activeEntry?.iconCachePath, activeEntry?.iconUrl, 'inline')}
                            <div className="workspace-collection__row-body">
                              <div className="workspace-collection__row-title">{group.displayName}</div>
                              <div className="workspace-collection__row-meta">
                                <span className="workspace-pill workspace-pill--source">{getSourceBadgeLabel(activeEntry?.source)}</span>
                                <span className="workspace-pill">{formatVersionTag(getEntryVersionLabel(activeEntry!))}</span>
                                <span className="workspace-pill">{`${group.installedIn.length} env${group.installedIn.length === 1 ? '' : 's'}`}</span>
                                {group.availableRuntimes.map((runtime) => <span key={`${group.key}-${runtime}`} className="workspace-pill">{runtime}</span>)}
                                {isGroupUpdateAvailable(group) && <span className="workspace-pill workspace-pill--warning">Update available</span>}
                              </div>
                              <p className="workspace-collection__row-summary">{activeEntry?.summary || 'No summary provided.'}</p>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </section>
              )}
            </div>
          </div>

          <aside className="workspace-collection__inspector">
            {!activeModView && <div className="workspace-collection__inspector-empty">Select a mod to review details and actions.</div>}

            {selectedDownloadedGroup && selectedDownloadedEntry && (
              <div className="workspace-inspector-card">
                <div className="workspace-inspector-card__header">
                  {renderCardIcon(selectedDownloadedGroup.displayName, selectedDownloadedEntry.iconCachePath, selectedDownloadedEntry.iconUrl, 'rail')}
                  <div>
                    <h3>{selectedDownloadedGroup.displayName}</h3>
                    <div className="workspace-inspector-card__subtle">
                      {getSourceBadgeLabel(selectedDownloadedEntry.source)}
                      {selectedDownloadedGroup.author ? ` • ${selectedDownloadedGroup.author}` : ''}
                      {` • ${selectedDownloadedGroupEntries.length} version${selectedDownloadedGroupEntries.length === 1 ? '' : 's'}`}
                    </div>
                  </div>
                </div>
                <p className="workspace-inspector-card__summary">{selectedDownloadedEntry.summary || 'No summary provided.'}</p>
                <div className="workspace-inspector-card__metrics">
                  <div><span>Installed</span><strong>{selectedDownloadedGroup.installedIn.length}</strong></div>
                  <div><span>Versions</span><strong>{selectedDownloadedGroupEntries.length}</strong></div>
                  <div><span>Selected version</span><strong>{formatVersionTag(getEntryVersionLabel(selectedDownloadedEntry))}</strong></div>
                  <div><span>Latest</span><strong>{selectedDownloadedGroup.remoteVersion ? formatVersionTag(selectedDownloadedGroup.remoteVersion) : 'unknown'}</strong></div>
                </div>
                <div className="workspace-inspector-card__field">
                  <label htmlFor={`mod-library-version-${selectedDownloadedGroup.key}`}>Available versions</label>
                  <select
                    id={`mod-library-version-${selectedDownloadedGroup.key}`}
                    value={selectedDownloadedEntry.storageId}
                    onChange={(event) => {
                      const nextStorageId = event.target.value;
                      setSelectedStorageByGroup((prev) => ({ ...prev, [selectedDownloadedGroup.key]: nextStorageId }));
                    }}
                    disabled={selectedDownloadedGroupEntries.length < 2}
                  >
                    {selectedDownloadedGroupEntries.map((entry) => (
                      <option key={entry.storageId} value={entry.storageId}>
                        {`${formatVersionTag(getEntryVersionLabel(entry))} • ${(entry.availableRuntimes?.length ? entry.availableRuntimes.join('/') : 'Runtime?')}`}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="workspace-inspector-card__actions">
                  <button className="btn btn-primary" onClick={() => void promptInstallTargets(selectedDownloadedEntry, `Install ${selectedDownloadedEntry.displayName}`, selectedDownloadedGroup.installedIn.length > 0)}>
                    {selectedDownloadedGroup.installedIn.length > 0 ? 'Install to more…' : 'Install…'}
                  </button>
                  <button
                    className="btn btn-secondary"
                    onClick={() => void handleSelectVersion(selectedDownloadedGroup, selectedDownloadedEntry.storageId)}
                    disabled={selectedDownloadedGroup.installedIn.length === 0 || selectedDownloadedGroupEntries.length < 2 || activatingGroup === selectedDownloadedGroup.key}
                  >
                    {activatingGroup === selectedDownloadedGroup.key ? 'Activating…' : 'Activate selected version'}
                  </button>
                  <button className="btn btn-secondary" onClick={() => void handleUpdateAndActivateGroup(selectedDownloadedGroup)} disabled={!isGroupUpdateAvailable(selectedDownloadedGroup)}>Update and activate</button>
                  <button className="btn btn-danger" onClick={() => void handleDeleteDownloadedGroup(selectedDownloadedGroup)}>Delete downloaded files</button>
                </div>
              </div>
            )}

            {selectedThunderstorePackage && (
              <div className="workspace-inspector-card">
                {(() => {
                  const representativePackage = selectedThunderstorePackage.packagesByRuntime.IL2CPP || selectedThunderstorePackage.packagesByRuntime.Mono;
                  const latestVersion = representativePackage?.versions?.[0];
                  const runtimeLabels = (['IL2CPP', 'Mono'] as const).filter((runtime) => !!selectedThunderstorePackage.packagesByRuntime[runtime]);
                  const categories = representativePackage?.categories || [];
                  return (
                    <>
                      <div className="workspace-inspector-card__header">
                        {renderCardIcon(
                          selectedThunderstorePackage.name,
                          undefined,
                          latestVersion?.icon || representativePackage?.icon || representativePackage?.icon_url,
                          'rail',
                        )}
                        <div>
                          <h3>{selectedThunderstorePackage.name}</h3>
                          <div className="workspace-inspector-card__subtle">
                            Thunderstore • {selectedThunderstorePackage.owner}
                            {downloadedGroupForSelectedThunderstore ? ` • ${downloadedGroupForSelectedThunderstore.installedIn.length} env${downloadedGroupForSelectedThunderstore.installedIn.length === 1 ? '' : 's'}` : ''}
                          </div>
                        </div>
                      </div>
                      <p className="workspace-inspector-card__summary">{latestVersion?.description || 'No description provided for this package.'}</p>
                      <div className="workspace-inspector-card__metrics">
                        <div><span>Latest</span><strong>{formatVersionTag(latestVersion?.version_number)}</strong></div>
                        <div><span>Versions</span><strong>{representativePackage?.versions?.length || 0}</strong></div>
                        <div><span>Downloads</span><strong>{formatCompactNumber(latestVersion?.downloads)}</strong></div>
                        <div><span>Updated</span><strong>{formatInspectorDate(representativePackage?.date_updated || latestVersion?.date_updated)}</strong></div>
                      </div>
                      <div className="workspace-inspector-card__field">
                        <label>Runtime support</label>
                        <div className="workspace-inspector-card__tags">
                          {runtimeLabels.map((runtime) => <span key={`${selectedThunderstorePackage.key}-${runtime}`} className="workspace-pill">{runtime}</span>)}
                          {runtimeLabels.length === 0 && <span className="workspace-pill">Unknown runtime</span>}
                        </div>
                      </div>
                      {categories.length > 0 && (
                        <div className="workspace-inspector-card__field">
                          <label>Categories</label>
                          <div className="workspace-inspector-card__tags">
                            {categories.slice(0, 6).map((category) => (
                              <span key={`${selectedThunderstorePackage.key}-${category}`} className="workspace-pill">{category}</span>
                            ))}
                          </div>
                        </div>
                      )}
                      <div className="workspace-inspector-card__field">
                        <label>Status</label>
                        <div className="workspace-inspector-card__tags">
                          <span className="workspace-pill workspace-pill--source">Thunderstore</span>
                          {downloadedGroupForSelectedThunderstore && <span className="workspace-pill workspace-pill--success">Downloaded</span>}
                          {downloadedGroupForSelectedThunderstore && isGroupUpdateAvailable(downloadedGroupForSelectedThunderstore) && <span className="workspace-pill workspace-pill--warning">Update available</span>}
                          {representativePackage?.is_pinned && <span className="workspace-pill">Pinned</span>}
                          {representativePackage?.is_deprecated && <span className="workspace-pill workspace-pill--danger">Deprecated</span>}
                        </div>
                      </div>
                    </>
                  );
                })()}
                <div className="workspace-inspector-card__actions">
                  {!downloadedGroupForSelectedThunderstore && <button className="btn btn-primary" onClick={() => void handleDownloadThunderstore(selectedThunderstorePackage)}>Download</button>}
                  {downloadedGroupForSelectedThunderstore && selectedThunderstoreDownloadedEntry && (
                    <button className="btn btn-primary" onClick={() => void promptInstallTargets(selectedThunderstoreDownloadedEntry, `Install ${selectedThunderstoreDownloadedEntry.displayName}`, downloadedGroupForSelectedThunderstore.installedIn.length > 0)}>
                      {downloadedGroupForSelectedThunderstore.installedIn.length > 0 ? 'Install to more…' : 'Install…'}
                    </button>
                  )}
                  {safeExternalUrl(selectedThunderstorePackage.packageUrl) && <a className="btn btn-secondary" href={safeExternalUrl(selectedThunderstorePackage.packageUrl)!} target="_blank" rel="noopener noreferrer">Open source page</a>}
                </div>
              </div>
            )}

            {selectedNexusResult && (
              <div className="workspace-inspector-card">
                <div className="workspace-inspector-card__header">
                  {renderCardIcon(selectedNexusResult.name, undefined, selectedNexusResult.picture_url, 'rail')}
                  <div>
                    <h3>{selectedNexusResult.name}</h3>
                    <div className="workspace-inspector-card__subtle">
                      Nexus Mods • {selectedNexusResult.author}
                      {downloadedGroupForSelectedNexus ? ` • ${downloadedGroupForSelectedNexus.installedIn.length} env${downloadedGroupForSelectedNexus.installedIn.length === 1 ? '' : 's'}` : ''}
                    </div>
                  </div>
                </div>
                <p className="workspace-inspector-card__summary">{selectedNexusResult.description || selectedNexusResult.summary || 'No description provided for this mod.'}</p>
                <div className="workspace-inspector-card__metrics">
                  <div><span>Latest</span><strong>{formatVersionTag(selectedNexusResult.version)}</strong></div>
                  <div><span>Endorsements</span><strong>{formatCompactNumber(selectedNexusResult.endorsement_count)}</strong></div>
                  <div><span>Downloads</span><strong>{formatCompactNumber(selectedNexusResult.mod_downloads || selectedNexusResult.unique_downloads)}</strong></div>
                  <div><span>Updated</span><strong>{formatInspectorDate(selectedNexusResult.updated_time || selectedNexusResult.uploaded_time)}</strong></div>
                </div>
                <div className="workspace-inspector-card__field">
                  <label>Status</label>
                  <div className="workspace-inspector-card__tags">
                    <span className="workspace-pill workspace-pill--source">Nexus Mods</span>
                    {downloadedGroupForSelectedNexus && <span className="workspace-pill workspace-pill--success">Downloaded</span>}
                    {downloadedGroupForSelectedNexus && isGroupUpdateAvailable(downloadedGroupForSelectedNexus) && <span className="workspace-pill workspace-pill--warning">Update available</span>}
                    {selectedNexusResult.contains_adult_content && <span className="workspace-pill workspace-pill--danger">Adult content</span>}
                    {selectedNexusResult.status && <span className="workspace-pill">{selectedNexusResult.status}</span>}
                  </div>
                </div>
                <div className="workspace-inspector-card__actions">
                  {!downloadedGroupForSelectedNexus && <button className="btn btn-primary" onClick={() => void handleDownloadNexusMod(selectedNexusResult.mod_id)}>Download</button>}
                  {downloadedGroupForSelectedNexus && selectedNexusDownloadedEntry && (
                    <button className="btn btn-primary" onClick={() => void promptInstallTargets(selectedNexusDownloadedEntry, `Install ${selectedNexusDownloadedEntry.displayName}`, downloadedGroupForSelectedNexus.installedIn.length > 0)}>
                      {downloadedGroupForSelectedNexus.installedIn.length > 0 ? 'Install to more…' : 'Install…'}
                    </button>
                  )}
                  <a className="btn btn-secondary" href={`https://www.nexusmods.com/schedule1/mods/${selectedNexusResult.mod_id}`} target="_blank" rel="noopener noreferrer">Open source page</a>
                </div>
              </div>
            )}
          </aside>
        </div>
      </div>

      {contextMenu && (
        <AnchoredContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          items={contextMenu.items}
          onClose={() => setContextMenu(null)}
        />
      )}
    </>
  );
}

