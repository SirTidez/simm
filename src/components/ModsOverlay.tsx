import {
  useState,
  useEffect,
  useMemo,
  useRef,
  useCallback,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from 'react';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Empty, EmptyHeader, EmptyTitle } from '@/components/ui/empty';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { ApiService } from '../services/api';
import { ConfirmOverlay } from './ConfirmOverlay';
import {
  SecurityScanReportOverlay,
  type SecurityScanReportOption,
} from './SecurityScanReportOverlay';
import { type SecurityReportWorkspaceRequest } from './SecurityScanReportPage';
import { handleCardActivationKeyDown, resolveImageSource, safeExternalUrl } from './modCardHelpers';
import { onModMetadataRefreshStatus, onModsChanged as onModsChangedEvent, onModsSnapshotUpdated } from '../services/events';
import { AnchoredContextMenu, type AnchoredContextMenuItem } from './AnchoredContextMenu';
import { getSecurityBadgeConfig } from './securityScanHelpers';
import { SimmBadge, SimmButton, SimmDialogContent } from './primitives';
import { cn } from '@/lib/utils';
import type {
  Environment,
  LocalModOwnershipCandidate,
  LocalModSourcePreview,
  LocalModSourceVersionOption,
  ModLibraryEntry,
  NexusMod,
  SecurityScanReport,
  SecurityScanSummary,
} from '../types';
import { open } from '@tauri-apps/plugin-dialog';
import { Icon } from './Icon';
import { WorkspacePageHeader } from './WorkspacePageHeader';

interface ModInfo {
  name: string;
  fileName: string;
  path: string;
  version?: string;
  source?: 'local' | 'thunderstore' | 'nexusmods' | 'github' | 'unknown';
  sourceUrl?: string;
  author?: string;
  disabled?: boolean;
  modStorageId?: string;
  managed?: boolean;
  summary?: string;
  iconUrl?: string;
  iconCachePath?: string;
  downloads?: number;
  likesOrEndorsements?: number;
  updatedAt?: string;
  tags?: string[];
  installedAt?: number;
  securityScan?: SecurityScanSummary;
}

type ModUpdateInfo = {
  updateAvailable: boolean;
  currentVersion?: string;
  latestVersion?: string;
};

export interface ModViewState {
  id: string;
  storageId?: string;
  name: string;
  source: string;
  summary?: string;
  iconUrl?: string;
  iconCachePath?: string;
  sourceUrl?: string;
  author?: string;
  downloads?: number;
  likesOrEndorsements?: number;
  updatedAt?: string;
  tags?: string[];
  installedVersion?: string;
  latestVersion?: string;
  installedAt?: number;
  securityScan?: SecurityScanSummary;
  kind: 'installed' | 'library' | 'thunderstore' | 'nexusmods';
}

interface Props {
  isOpen: boolean;
  onClose: () => void;
  environmentId: string;
  onModsChanged?: () => void;
  onModUpdatesChecked?: (count: number) => void;
  onOpenAccounts?: () => void;
  onOpenModLibrary?: () => void;
  onOpenConfig?: () => void;
  onOpenSecurityReport?: (request: SecurityReportWorkspaceRequest) => void;
  navigationState?: ModsOverlayNavigationState;
  onNavigationStateChange?: (state: ModsOverlayNavigationState) => void;
}

export type ModsTab = 'installed' | 'updates';

interface ConfirmDialog {
  title: string;
  message: string;
  confirmText?: string;
  cancelText?: string;
  onConfirm: () => Promise<void> | void;
  readyAt?: number;
}

const getErrorMessage = (error: unknown, fallback: string): string => {
  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }

  if (typeof error === 'string' && error.trim()) {
    return error;
  }

  return fallback;
};

type NexusManualInstallHint = {
  requiresManualDownload?: boolean;
  gameId?: string;
  modId?: number;
  fileId?: number;
  runtime?: string;
  recoveryUrl?: string;
  modUrl?: string;
  error?: string;
};

const normalizeNexusRuntime = (value?: string | null): 'IL2CPP' | 'Mono' | undefined => {
  const normalized = value?.trim().toLowerCase();
  if (normalized === 'il2cpp') {
    return 'IL2CPP';
  }
  if (normalized === 'mono') {
    return 'Mono';
  }
  return undefined;
};

const normalizeNexusId = (value: unknown): number | null => {
  const numeric = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
};

const managedRemoteSources = new Set(['thunderstore', 'nexusmods', 'github']);

const getInstalledModLatestVersion = (mod: ModInfo, update?: ModUpdateInfo): string | undefined => {
  if (update?.latestVersion) {
    return update.latestVersion;
  }

  if (mod.managed && mod.source && managedRemoteSources.has(mod.source) && mod.version) {
    return mod.version;
  }

  return undefined;
};

export interface ModsOverlayNavigationState {
  modsTab?: ModsTab;
  searchSource?: 'thunderstore' | 'nexusmods';
  searchQuery?: string;
  searchResults?: ThunderstorePackage[];
  showSearchResults?: boolean;
  nexusModsSearchQuery?: string;
  nexusModsSearchResults?: NexusMod[];
  showNexusModsResults?: boolean;
  showSearchInOverlay?: boolean;
  modListFilter?: 'all' | 'updates' | 'enabled' | 'disabled';
  installedSearchTerm?: string;
  activeModView?: ModViewState | null;
}

type LocalSourceLinkStage = 'chooseSource' | 'edit' | 'confirmMismatch' | 'pickOwnership' | 'saving';
type LocalSourceLinkStrategy = 'existing' | 'manual' | null;
const LOCAL_SOURCE_VERSION_UNSELECTED = '__select-installed-version__';

interface LocalSourceLinkState {
  modId: string;
  modFileName: string;
  sourceUrl: string;
  sourceUrlTouched: boolean;
  stage: LocalSourceLinkStage;
  strategy: LocalSourceLinkStrategy;
  loadingExistingHint: boolean;
  loadingPreview: boolean;
  loadingOwnership: boolean;
  existingSourceHint?: LocalModSourcePreview | null;
  preview?: LocalModSourcePreview;
  selectedVersion?: string;
  customVersion: string;
  error?: string | null;
  ownershipCandidates: LocalModOwnershipCandidate[];
  selectedOwnershipIds: string[];
}

function CollectionEmpty({ children, tone }: { children: string; tone?: 'error' }) {
  return (
    <Empty className={`workspace-collection__empty${tone === 'error' ? ' workspace-collection__empty--error' : ''}`}>
      <EmptyHeader>
        <EmptyTitle>{children}</EmptyTitle>
      </EmptyHeader>
    </Empty>
  );
}

function InspectorEmpty({ children }: { children: string }) {
  return (
    <Empty className="workspace-collection__inspector-empty">
      <EmptyHeader>
        <EmptyTitle>{children}</EmptyTitle>
      </EmptyHeader>
    </Empty>
  );
}

type WorkspaceBadgeTone = 'source' | 'success' | 'warning' | 'danger';

function WorkspaceBadge({
  children,
  tone,
  className,
  style,
}: {
  children: ReactNode;
  tone?: WorkspaceBadgeTone;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <SimmBadge
      variant="outline"
      className={cn(
        'workspace-pill',
        tone && `workspace-pill--${tone}`,
        className,
      )}
      style={style}
    >
      {children}
    </SimmBadge>
  );
}

function SecurityScanBadge({
  config,
}: {
  config?: ReturnType<typeof getSecurityBadgeConfig>;
}) {
  if (!config) {
    return null;
  }

  return (
    <WorkspaceBadge
      className="workspace-pill--security"
      style={{
        borderColor: config.border,
        background: config.background,
        color: config.color,
      }}
    >
      <Icon name={`fas ${config.icon}`} style={{ fontSize: '0.7rem' }} />
      {config.label}
    </WorkspaceBadge>
  );
}

function InspectorSecurityScanBadge({
  config,
}: {
  config?: ReturnType<typeof getSecurityBadgeConfig>;
}) {
  if (!config) {
    return null;
  }

  return (
    <div className="workspace-inspector-card__badge-row">
      <SecurityScanBadge config={config} />
    </div>
  );
}

function getLocalSourceVersionOptions(
  versions: LocalModSourceVersionOption[] | undefined,
  strategy: LocalSourceLinkStrategy,
  runtime?: string,
) {
  return (versions || []).filter((version) => {
    if (strategy !== 'existing' || !runtime) {
      return true;
    }
    return !version.runtime || version.runtime === runtime;
  });
}

function formatLocalSourceVersionOption(version: LocalModSourceVersionOption) {
  return [
    version.version,
    version.runtime,
    version.isLatest ? 'Latest' : null,
    version.updatedAt ? new Date(version.updatedAt).toLocaleDateString() : null,
  ].filter(Boolean).join(' • ');
}

function LocalSourceVersionSelect({
  value,
  preview,
  strategy,
  runtime,
  loadingPreview,
  onValueChange,
}: {
  value?: string;
  preview?: LocalModSourcePreview;
  strategy: LocalSourceLinkStrategy;
  runtime?: string;
  loadingPreview: boolean;
  onValueChange: (value: string) => void;
}) {
  const options = getLocalSourceVersionOptions(preview?.versions, strategy, runtime);
  const selectedValue = value || LOCAL_SOURCE_VERSION_UNSELECTED;

  return (
    <Select
      value={selectedValue}
      onValueChange={(nextValue) => {
        if (typeof nextValue === 'string') {
          onValueChange(nextValue === LOCAL_SOURCE_VERSION_UNSELECTED ? '' : nextValue);
        }
      }}
      disabled={!preview || loadingPreview}
    >
      <SelectTrigger id="local-source-version" className="workspace-inspector-link-panel__input">
        <SelectValue>
          {(currentValue) => {
            if (currentValue === LOCAL_SOURCE_VERSION_UNSELECTED) {
              return 'Select installed version';
            }
            const selectedOption = options.find((option) => option.version === currentValue);
            return selectedOption ? formatLocalSourceVersionOption(selectedOption) : 'Select installed version';
          }}
        </SelectValue>
      </SelectTrigger>
      <SelectContent className="workspace-inspector-link-panel__select-content" align="start">
        <SelectGroup>
          <SelectItem value={LOCAL_SOURCE_VERSION_UNSELECTED}>Select installed version</SelectItem>
          {options.map((version) => (
            <SelectItem key={version.key} value={version.version}>
              {formatLocalSourceVersionOption(version)}
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  );
}

interface ManualUploadSourceInfo {
  source: 'thunderstore' | 'nexusmods' | 'github' | 'local' | 'unknown';
  sourceUrl?: string;
  modName?: string;
  author?: string;
  sourceId?: string;
  sourceVersion?: string;
}

interface ManualUploadItem {
  filePath: string;
  fileName: string;
}

interface ManualUploadBatchResult {
  fileName: string;
  status: 'success' | 'failed' | 'skipped';
  message: string;
}

interface PendingRuntimeSelectionState extends ManualUploadItem {
  sourceInfo: ManualUploadSourceInfo;
  remainingQueue: ManualUploadItem[];
}

interface RuntimeMismatchWarningState {
  fileName: string;
  remainingQueue: ManualUploadItem[];
  runtimeMismatch: {
    detected: 'IL2CPP' | 'Mono' | 'unknown';
    environment: 'IL2CPP' | 'Mono';
    warning: string;
  };
}

const isSecurityScanReport = (value: unknown): value is SecurityScanReport => {
  return !!value && typeof value === 'object' && 'summary' in (value as Record<string, unknown>) && Array.isArray((value as { files?: unknown[] }).files);
};

export interface ThunderstorePackage {
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

const runtimeSuffixPatterns = [
  /\s*(?:\(|\[)\s*(mono|il2cpp)\s*(?:\)|\])\s*$/i,
  /\s*[_-]\s*(mono|il2cpp)\s*$/i,
  /\s+(mono|il2cpp)\s*$/i,
];

function normalizeModNameKey(name: string): string {
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
  return normalized.toLowerCase();
}

function normalizeVersionToken(value?: string): string {
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
  if (/^v/i.test(normalized)) {
    normalized = normalized.slice(1);
  }
  return normalized.toLowerCase();
}

function mergeModSnapshots(previous: ModInfo[], incoming: ModInfo[]): ModInfo[] {
  const nextByKey = new Map<string, ModInfo>();
  for (const mod of incoming) {
    nextByKey.set(`${mod.fileName}::${mod.path}`, mod);
  }

  const merged: ModInfo[] = [];
  for (const existing of previous) {
    const key = `${existing.fileName}::${existing.path}`;
    const updated = nextByKey.get(key);
    if (updated) {
      merged.push(updated);
      nextByKey.delete(key);
    }
  }

  for (const mod of incoming) {
    const key = `${mod.fileName}::${mod.path}`;
    if (nextByKey.has(key)) {
      merged.push(mod);
      nextByKey.delete(key);
    }
  }

  return merged;
}

export function ModsOverlay({
  isOpen,
  environmentId,
  onModsChanged,
  onModUpdatesChecked,
  onOpenAccounts,
  onOpenModLibrary,
  onOpenConfig,
  onOpenSecurityReport,
  navigationState,
  onNavigationStateChange,
}: Props) {
  type ModListFilter = 'all' | 'updates' | 'enabled' | 'disabled';
  const defaultSearchSource = useMemo<'thunderstore' | 'nexusmods'>(() => {
    if (navigationState?.searchSource) {
      return navigationState.searchSource;
    }
    try {
      const stored = localStorage.getItem('simm:last-mods-search-source');
      return stored === 'thunderstore' ? 'thunderstore' : 'nexusmods';
    } catch {
      return 'nexusmods';
    }
  }, [navigationState?.searchSource]);

  const [mods, setMods] = useState<ModInfo[]>([]);
  const [downloadedMods, setDownloadedMods] = useState<ModLibraryEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [, setModsDirectory] = useState<string>('');
  const [, setDeletingMod] = useState<string | null>(null);
  const [, setEnablingMod] = useState<string | null>(null);
  const [, setDisablingMod] = useState<string | null>(null);
  const [scanningInstalledMod, setScanningInstalledMod] = useState<string | null>(null);
  const [scanningLocalMods, setScanningLocalMods] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadQueue, setUploadQueue] = useState<ManualUploadItem[]>([]);
  const [currentUploadItem, setCurrentUploadItem] = useState<ManualUploadItem | null>(null);
  const [uploadBatchTotal, setUploadBatchTotal] = useState(0);
  const [uploadBatchResults, setUploadBatchResults] = useState<ManualUploadBatchResult[]>([]);
  const [uploadBatchSummary, setUploadBatchSummary] = useState<{ message: string; variant: 'success' | 'mixed' } | null>(null);
  const [pendingUpload, setPendingUpload] = useState<RuntimeMismatchWarningState | null>(null);
  const [pendingRuntimeSelection, setPendingRuntimeSelection] = useState<PendingRuntimeSelectionState | null>(null);
  const [confirmDialog, setConfirmDialog] = useState<ConfirmDialog | null>(null);
  const [activeSecurityReport, setActiveSecurityReport] = useState<SecurityReportWorkspaceRequest | null>(null);
  const [securityActionBusy, setSecurityActionBusy] = useState(false);
  const [, setToastMessage] = useState<string | null>(null);

  // Search state
  const [environment, setEnvironment] = useState<Environment | null>(null);
  const [searchQuery] = useState<string>(() => navigationState?.searchQuery ?? '');
  const [searchResults] = useState<ThunderstorePackage[]>(() => navigationState?.searchResults ?? []);
  const [showSearchResults] = useState(() => navigationState?.showSearchResults ?? false);
  const [searchSource] = useState<'thunderstore' | 'nexusmods'>(defaultSearchSource);

  // NexusMods search state
  const [nexusModsSearchQuery, setNexusModsSearchQuery] = useState<string>(() => navigationState?.nexusModsSearchQuery ?? '');
  const [nexusModsSearchResults] = useState<NexusMod[]>(() => navigationState?.nexusModsSearchResults ?? []);
  const [installingNexusMod, setInstallingNexusMod] = useState<{ modId: number; fileId: number } | null>(null);
  const [showNexusModsResults, setShowNexusModsResults] = useState(() => navigationState?.showNexusModsResults ?? false);
  const [showNexusKeyRequiredModal, setShowNexusKeyRequiredModal] = useState(false);
  const [, setHasNexusDownloadAccess] = useState<boolean>(false);
  const [nexusRequiresSiteConfirmation, setNexusRequiresSiteConfirmation] = useState<boolean>(true);

  // Mod updates state
  const [modUpdates, setModUpdates] = useState<Map<string, ModUpdateInfo>>(new Map());
  const [checkingModUpdates, setCheckingModUpdates] = useState(false);
  const [, setUpdatingMod] = useState<string | null>(null);
  const [showSearchInOverlay] = useState(() => navigationState?.showSearchInOverlay ?? false);
  const [modListFilter, setModListFilter] = useState<ModListFilter>(() => navigationState?.modListFilter ?? 'all');
  const [modsTab, setModsTab] = useState<ModsTab>(() => navigationState?.modsTab ?? 'installed');
  const [installedSearchTerm, setInstalledSearchTerm] = useState(() => navigationState?.installedSearchTerm ?? '');
  const [activeModView, setActiveModView] = useState<ModViewState | null>(() => navigationState?.activeModView ?? null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; items: AnchoredContextMenuItem[] } | null>(null);
  const suppressWatcherReloadUntilRef = useRef(0);
  const modsReloadTimerRef = useRef<number | null>(null);
  const activeLoadRequestRef = useRef(0);
  const modsScrollContainerRef = useRef<HTMLDivElement | null>(null);
  const modsScrollTopRef = useRef(0);
  const metadataRefreshRunningRef = useRef(false);
  const nexusManualTimeoutRef = useRef<number | null>(null);
  const toastTimeoutRef = useRef<number | null>(null);
  const uploadBatchResultsRef = useRef<ManualUploadBatchResult[]>([]);
  const navigationChangeHandlerRef = useRef(onNavigationStateChange);
  const [localSourceLinkState, setLocalSourceLinkState] = useState<LocalSourceLinkState | null>(null);
  const activeModViewSourceUrl = safeExternalUrl(activeModView?.sourceUrl);

  useEffect(() => {
    navigationChangeHandlerRef.current = onNavigationStateChange;
  }, [onNavigationStateChange]);

  const reportedNavigationState = useMemo<ModsOverlayNavigationState>(
    () => ({
      modsTab,
      searchSource,
      searchQuery,
      searchResults,
      showSearchResults,
      nexusModsSearchQuery,
      nexusModsSearchResults,
      showNexusModsResults,
      showSearchInOverlay,
      modListFilter,
      installedSearchTerm,
      activeModView,
    }),
    [
      activeModView,
      installedSearchTerm,
      modListFilter,
      modsTab,
      nexusModsSearchQuery,
      nexusModsSearchResults,
      searchQuery,
      searchResults,
      searchSource,
      showNexusModsResults,
      showSearchInOverlay,
      showSearchResults,
    ],
  );
  const openExternalSourceUrl = useCallback((url?: string) => {
    const safeUrl = safeExternalUrl(url);
    if (!safeUrl) {
      return;
    }
    void ApiService.openExternalUrl(safeUrl).catch((err) => {
      setError(getErrorMessage(err, 'Failed to open source page'));
    });
  }, []);
  const getUpdateDisabledReason = useCallback((mod: ModInfo, updateAvailable?: boolean) => {
    if (!(mod.source === 'thunderstore' || mod.source === 'nexusmods' || mod.source === 'github')) {
      return 'Automatic updates are only available for Thunderstore, Nexus Mods, and GitHub sources.';
    }
    if (!updateAvailable) {
      return 'No update is currently available for this mod.';
    }
    return null;
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem('simm:last-mods-search-source', searchSource);
    } catch {
      // Ignore localStorage failures.
    }
  }, [searchSource]);

  useEffect(() => {
    navigationChangeHandlerRef.current?.(reportedNavigationState);
  }, [reportedNavigationState]);
  const loadEnvironment = async () => {
    try {
      const env = await ApiService.getEnvironment(environmentId);
      setEnvironment(env);
    } catch (err) {
      console.error('Failed to load environment:', err);
    }
  };

  const refreshNexusDownloadAccess = async () => {
    try {
      const status = await ApiService.getNexusOAuthStatus();
      const isConnected = !!status.connected;
      const requiresSiteConfirmation = isConnected && !!status.account?.requiresSiteConfirmation;

      setHasNexusDownloadAccess(isConnected);
      setNexusRequiresSiteConfirmation(requiresSiteConfirmation);
    } catch (err) {
      console.error('Failed to refresh Nexus download access:', err);
      setHasNexusDownloadAccess(false);
      setNexusRequiresSiteConfirmation(true);
    }
  };

  const clearNexusManualTimeout = () => {
    if (nexusManualTimeoutRef.current !== null) {
      window.clearTimeout(nexusManualTimeoutRef.current);
      nexusManualTimeoutRef.current = null;
    }
  };

  const showToast = useCallback((message: string, duration = 6500) => {
    setToastMessage(message);
    if (toastTimeoutRef.current !== null) {
      window.clearTimeout(toastTimeoutRef.current);
    }
    toastTimeoutRef.current = window.setTimeout(() => {
      setToastMessage(null);
      toastTimeoutRef.current = null;
    }, duration);
  }, []);

  useEffect(() => {
    return () => {
      if (toastTimeoutRef.current !== null) {
        window.clearTimeout(toastTimeoutRef.current);
        toastTimeoutRef.current = null;
      }
    };
  }, []);

  const currentUploadProgress = uploading && uploadBatchTotal > 0
    && uploadQueue.length >= 0
    ? Math.min(
        uploadBatchResults.length + (currentUploadItem || pendingRuntimeSelection || pendingUpload ? 1 : 0),
        uploadBatchTotal,
      )
    : 0;

  const uploadButtonBusyLabel = uploadBatchTotal > 1
    ? `Adding ${Math.max(currentUploadProgress, 1)}/${uploadBatchTotal}...`
    : 'Adding...';

  const openSecurityReport = useCallback((request: SecurityReportWorkspaceRequest) => {
    if (onOpenSecurityReport) {
      onOpenSecurityReport(request);
      return;
    }

    setActiveSecurityReport(request);
  }, [onOpenSecurityReport]);

  const closeSecurityReport = () => {
    if (securityActionBusy) {
      return;
    }

    activeSecurityReport?.onDismiss?.();
    setActiveSecurityReport(null);
  };

  const handleSecurityReportConfirm = async () => {
    if (!activeSecurityReport?.onConfirm) {
      return;
    }

    setSecurityActionBusy(true);
    try {
      await activeSecurityReport.onConfirm();
      setActiveSecurityReport(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to continue after reviewing the MLVScan findings.');
    } finally {
      setSecurityActionBusy(false);
    }
  };

  const handleSecurityGateResponse = (
    title: string,
    result: { securityScan?: SecurityScanReport | SecurityScanSummary; securityScanBlocked?: boolean; securityScanConfirmationRequired?: boolean },
    onConfirm: () => Promise<void>,
    onDismiss?: (() => void) | null,
  ): boolean => {
    if (!result.securityScan || !isSecurityScanReport(result.securityScan)) {
      return false;
    }

    if (result.securityScanBlocked) {
      openSecurityReport({ title, report: result.securityScan, onConfirm: null, onDismiss });
      return true;
    }

    if (result.securityScanConfirmationRequired) {
      openSecurityReport({
        title,
        report: result.securityScan,
        confirmLabel: 'Continue Install',
        onConfirm,
        onDismiss,
      });
      return true;
    }

    return false;
  };

  const buildStoredSecurityReportOption = useCallback(
    (entry: ModLibraryEntry | null, storageId: string, report: SecurityScanReport): SecurityScanReportOption => {
      const versionLabel = normalizeVersionToken(entry?.sourceVersion || entry?.installedVersion)
        ? `v${normalizeVersionToken(entry?.sourceVersion || entry?.installedVersion)}`
        : 'Stored scan';
      const explicitRuntimes = Object.entries(entry?.storageIdsByRuntime || {})
        .filter(([, id]) => id === storageId)
        .map(([runtime]) => runtime);
      const fallbackRuntime =
        entry?.storageId === storageId && (entry.availableRuntimes?.length || 0) === 1
          ? entry.availableRuntimes
          : [];
      const runtimeLabel = [...explicitRuntimes, ...fallbackRuntime].join('/') || 'Runtime?';
      const fileCount = report.files.length;
      const description = fileCount === 0
        ? 'Stored security report'
        : fileCount === 1
          ? report.files[0].fileName
          : `${fileCount} scanned files`;

      return {
        key: storageId,
        label: `${versionLabel} • ${runtimeLabel}`,
        description,
        report,
      };
    },
    [],
  );

  const openStoredSecurityReport = async (storageId: string, title: string) => {
    try {
      const matchingEntry = downloadedMods.find(
        (entry) =>
          entry.storageId === storageId ||
          Object.values(entry.storageIdsByRuntime || {}).includes(storageId),
      ) || null;
      const storageIds = Array.from(
        new Set([
          storageId,
          matchingEntry?.storageId,
          ...Object.values(matchingEntry?.storageIdsByRuntime || {}),
        ].filter((value): value is string => Boolean(value))),
      );
      const reports = await Promise.allSettled(
        storageIds.map(async (id) => ({
          storageId: id,
          report: await ApiService.getModSecurityScanReport(id),
        })),
      );
      const reportOptions = reports.flatMap((result) => {
        if (result.status !== 'fulfilled' || !result.value.report) {
          return [];
        }
        return [
          buildStoredSecurityReportOption(
            matchingEntry,
            result.value.storageId,
            result.value.report,
          ),
        ];
      });

      if (reportOptions.length > 0) {
        openSecurityReport({
          title,
          report: reportOptions[0].report,
          reportOptions,
          onConfirm: null,
        });
      } else {
        setError('No security report available for this mod');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load security report');
    }
  };

  const handleScanInstalledMod = async (mod: ModInfo) => {
    const modKey = `${mod.fileName}-${mod.path}`;
    setScanningInstalledMod(modKey);
    setError(null);

    try {
      const report = await ApiService.scanInstalledModForSecurity(environmentId, mod.fileName);
      setMods(previous => previous.map((entry) => (
        `${entry.fileName}-${entry.path}` === modKey
          ? { ...entry, securityScan: report.summary }
          : entry
      )));
      openSecurityReport({
        title: `Security Report - ${mod.name}`,
        report,
        onConfirm: null,
      });
      await loadInstalledMods(false, true);
      if (onModsChanged) {
        onModsChanged();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to scan installed mod');
    } finally {
      setScanningInstalledMod(null);
    }
  };

  const handleScanLocalInstalledMods = async () => {
    const candidates = mods.filter((mod) => !mod.managed && !mod.modStorageId);
    if (candidates.length === 0) {
      showToast('No local installed mods need scanning.');
      return;
    }

    setScanningLocalMods(true);
    setError(null);
    let scannedCount = 0;
    const failures: string[] = [];

    try {
      for (const mod of candidates) {
        try {
          const report = await ApiService.scanInstalledModForSecurity(environmentId, mod.fileName);
          scannedCount += 1;
          setMods(previous => previous.map((entry) => (
            `${entry.fileName}-${entry.path}` === `${mod.fileName}-${mod.path}`
              ? { ...entry, securityScan: report.summary }
              : entry
          )));
        } catch (err) {
          failures.push(`${mod.name}: ${getErrorMessage(err, 'scan failed')}`);
        }
      }

      await loadInstalledMods(false, true);
      if (onModsChanged && scannedCount > 0) {
        onModsChanged();
      }

      if (failures.length > 0) {
        setError(`Scanned ${scannedCount}/${candidates.length} local mods. ${failures[0]}`);
      } else {
        showToast(`Scanned ${scannedCount} local mod${scannedCount === 1 ? '' : 's'}.`);
      }
    } finally {
      setScanningLocalMods(false);
    }
  };

  const startNexusManualTimeout = () => {
    clearNexusManualTimeout();
    nexusManualTimeoutRef.current = window.setTimeout(() => {
      setInstallingNexusMod(null);
      setError('Nexus manual download timed out. Start the download again from the Files page.');
    }, 5 * 60 * 1000);
  };

  const beginManualNexusInstallSession = async (hint: NexusManualInstallHint) => {
    const modId = normalizeNexusId(hint.modId);
    const fileId = normalizeNexusId(hint.fileId);

    if (!modId || !fileId) {
      return false;
    }

    const runtime =
      normalizeNexusRuntime(hint.runtime) ??
      normalizeNexusRuntime(environment?.runtime);

    setInstallingNexusMod({ modId, fileId });
    try {
      await ApiService.beginNexusManualDownloadSession({
        kind: 'install',
        modId,
        fileId,
        gameId: hint.gameId || 'schedule1',
        environmentId,
        runtime,
      });
      startNexusManualTimeout();
      showToast('Opened the Nexus Mods Files tab in your browser. Confirm the download there; SIMM will continue when the nxm link returns.');
      return true;
    } catch (error) {
      setInstallingNexusMod(null);
      throw error;
    }
  };

  const loadInstalledMods = async (showSpinner: boolean = true, refresh: boolean = false) => {
    const requestId = ++activeLoadRequestRef.current;
    if (showSpinner) {
      setLoading(true);
      setError(null);
    }

    try {
      const result = await ApiService.getMods(environmentId, refresh);
      if (requestId !== activeLoadRequestRef.current) {
        return;
      }

      const normalizedMods = result.mods.map(mod => ({
        ...mod,
        source: mod.source as ModInfo['source'],
      }));
      setMods(previous => mergeModSnapshots(previous, normalizedMods));
      setModsDirectory(result.modsDirectory);
    } catch (err) {
      if (requestId !== activeLoadRequestRef.current) {
        return;
      }

      if (showSpinner) {
        setError(err instanceof Error ? err.message : 'Failed to load mods');
      } else {
        console.warn('Failed to refresh installed mods:', err);
      }
    } finally {
      if (showSpinner && requestId === activeLoadRequestRef.current) {
        setLoading(false);
      }
    }
  };

  const loadDownloadedLibrary = async () => {
    try {
      const library = await ApiService.getModLibrary();
      setDownloadedMods(library.downloaded || []);
    } catch (err) {
      console.warn('Failed to load downloaded mod library:', err);
    }
  };

  const loadCachedModUpdates = async () => {
    try {
      const summary = await ApiService.getModUpdatesSummary(environmentId);
      const updatesMap = new Map<string, ModUpdateInfo>();
      for (const update of summary.updates || []) {
        updatesMap.set(update.modFileName, {
          updateAvailable: true,
          currentVersion: update.currentVersion,
          latestVersion: update.latestVersion,
        });
      }
      setModUpdates(updatesMap);
      onModUpdatesChecked?.(summary.count ?? updatesMap.size);
    } catch (err) {
      console.warn('Failed to load cached mod update summary:', err);
    }
  };

  const loadModsPanelData = async () => {
    await loadInstalledMods(true, false);
    await loadDownloadedLibrary();
    void loadCachedModUpdates();
  };

  useEffect(() => {
    if (isOpen && environmentId) {
      void loadEnvironment();
      void loadModsPanelData();
      void refreshNexusDownloadAccess();

      // Listen for filesystem changes
      let unlistenModsChanged: (() => void) | null = null;
      let unlistenModsSnapshot: (() => void) | null = null;

      const scheduleInstalledModsRefresh = () => {
        if (modsReloadTimerRef.current) {
          window.clearTimeout(modsReloadTimerRef.current);
        }

        modsReloadTimerRef.current = window.setTimeout(() => {
          modsReloadTimerRef.current = null;
          if (Date.now() < suppressWatcherReloadUntilRef.current) {
            return;
          }
          void loadInstalledMods(false, true);
          void loadCachedModUpdates();
          onModsChanged?.();
        }, 350);
      };

      const setupListener = async () => {
        try {
          unlistenModsChanged = await onModsChangedEvent((data) => {
            if (data.environmentId === environmentId) {
              scheduleInstalledModsRefresh();
            }
          });

          unlistenModsSnapshot = await onModsSnapshotUpdated((data) => {
            if (data.environmentId !== environmentId || !data.snapshot) {
              return;
            }

            const normalizedMods = (data.snapshot.mods || []).map(mod => ({
              ...mod,
              source: mod.source as ModInfo['source'],
            }));

            setMods(previous => mergeModSnapshots(previous, normalizedMods));
            setModsDirectory(data.snapshot.modsDirectory || '');
          });
        } catch (error) {
          console.error('Failed to set up mods changed listener:', error);
        }
      };

      void setupListener();

      return () => {
        activeLoadRequestRef.current += 1;
        if (modsReloadTimerRef.current) {
          window.clearTimeout(modsReloadTimerRef.current);
          modsReloadTimerRef.current = null;
        }
        if (unlistenModsChanged) unlistenModsChanged();
        if (unlistenModsSnapshot) unlistenModsSnapshot();
      };
    }

    activeLoadRequestRef.current += 1;
    if (modsReloadTimerRef.current) {
      window.clearTimeout(modsReloadTimerRef.current);
      modsReloadTimerRef.current = null;
    }
  }, [isOpen, environmentId]);

  useEffect(() => {
    if (!isOpen || !environmentId) {
      return;
    }

    let disposed = false;
    let unlisten: (() => void) | null = null;
    void onModMetadataRefreshStatus((data) => {
      const running = Boolean(data.running) || (data.activeCount || 0) > 0;
      const wasRunning = metadataRefreshRunningRef.current;
      metadataRefreshRunningRef.current = running;

      if (wasRunning && !running) {
        void loadDownloadedLibrary();
        void loadInstalledMods(false, true);
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
  }, [isOpen, environmentId]);

  const openModView = (nextView: ModViewState) => {
    if (modsScrollContainerRef.current) {
      modsScrollTopRef.current = modsScrollContainerRef.current.scrollTop;
    }
    setActiveModView(nextView);
  };
  // Refresh library when notified (e.g. after download in another view) or when opening
  useEffect(() => {
    if (!isOpen || !environmentId) return;
    const handler = () => void loadDownloadedLibrary();
    window.addEventListener('library-updated', handler);
    // Check if library was updated while we were away (e.g. user downloaded in Library then switched here)
    if (sessionStorage.getItem('library-needs-refresh') === '1') {
      sessionStorage.removeItem('library-needs-refresh');
      void loadDownloadedLibrary();
    }
    return () => window.removeEventListener('library-updated', handler);
  }, [isOpen, environmentId]);

  useEffect(() => {
    const handleManualDownloadResult = async (event: Event) => {
      const detail = (event as CustomEvent<{
        success: boolean;
        result?: {
          kind?: 'library' | 'install';
          requestedKind?: 'library' | 'install';
          environmentId?: string;
          downloadedToLibraryOnly?: boolean;
          installedEnvironmentNames?: string[];
        };
        requestedKind?: 'library' | 'install';
        error?: string;
      }>).detail;
      const requestedKind = detail?.requestedKind ?? detail?.result?.requestedKind;

      if (requestedKind === 'library' || detail?.result?.kind === 'library') {
        return;
      }

      if (!installingNexusMod && requestedKind !== 'install' && detail?.result?.kind !== 'install') {
        return;
      }

      if (detail?.result?.kind === 'install' && detail.result.environmentId && detail.result.environmentId !== environmentId) {
        return;
      }

      clearNexusManualTimeout();
      setInstallingNexusMod(null);

      if (detail?.success) {
        setError(null);
        await loadInstalledMods(false, true);
        await loadDownloadedLibrary();
        await loadCachedModUpdates();
        onModsChanged?.();
        const installedEnvironmentNames =
          detail.result?.installedEnvironmentNames?.filter(Boolean) || [];
        if (detail.result?.downloadedToLibraryOnly) {
          showToast('Downloaded to library only. No compatible branches found.');
        } else if (installedEnvironmentNames.length > 0) {
          showToast(
            `Installed to ${installedEnvironmentNames.join(', ')}.`,
          );
        } else if (detail.result?.environmentId === environmentId && environment?.name) {
          showToast(`Installed to ${environment.name}.`);
        }
        setShowNexusModsResults(false);
        setNexusModsSearchQuery('');
        return;
      }

      if (detail?.error) {
        setError(detail.error);
      }
    };

    window.addEventListener('nexus-manual-download-result', handleManualDownloadResult as EventListener);
    return () => {
      clearNexusManualTimeout();
      window.removeEventListener('nexus-manual-download-result', handleManualDownloadResult as EventListener);
    };
  }, [environment?.name, environmentId, installingNexusMod, onModsChanged, showToast]);

  const checkModUpdates = async (showErrors: boolean = false) => {
    try {
      const updates = await ApiService.checkModUpdates(environmentId);
      const updatesMap = new Map<string, ModUpdateInfo>();
      updates.forEach(update => {
        updatesMap.set(update.modFileName, {
          updateAvailable: update.updateAvailable,
          currentVersion: update.currentVersion,
          latestVersion: update.latestVersion
        });
      });
      setModUpdates(updatesMap);
      const count = Array.from(updatesMap.values()).filter(u => u.updateAvailable).length;
      onModUpdatesChecked?.(count);
    } catch (updateErr) {
      if (showErrors) {
        throw updateErr; // Re-throw if called manually so we can show error
      } else {
        // Fail silently - updates are nice to have but not critical
        console.warn('Failed to check mod updates:', updateErr);
      }
    }
  };

  const handleCheckModUpdates = async () => {
    setCheckingModUpdates(true);
    setError(null);
    try {
      await checkModUpdates(true); // Show errors when manually triggered
      await loadInstalledMods(false, true);
      await loadDownloadedLibrary();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to check for mod updates');
    } finally {
      setCheckingModUpdates(false);
    }
  };

  const handleDeleteMod = async (mod: ModInfo) => {
    setDeletingMod(mod.fileName);
    try {
      await ApiService.deleteMod(environmentId, mod.fileName);
      // Reload mods list after deletion
      await loadInstalledMods(false, true);
      await loadDownloadedLibrary();
      await loadCachedModUpdates();
      // Notify parent that mods changed (so it can refresh the count)
      if (onModsChanged) {
        onModsChanged();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete mod');
    } finally {
      setDeletingMod(null);
    }
  };

  const handleUpdateMod = async (mod: ModInfo) => {
    setUpdatingMod(mod.fileName);
    setError(null);
    try {
      const result = await ApiService.updateMod(environmentId, mod.fileName);
      if (!result.success) {
        if (result.errorCode === 'nexus_auth_required' && onOpenAccounts) {
          setConfirmDialog({
            title: 'Nexus Login Required',
            message: result.error || 'Log into Nexus in Accounts before updating this mod.',
            confirmText: 'Open Accounts',
            cancelText: 'Dismiss',
            onConfirm: () => onOpenAccounts(),
          });
          return;
        }
        if (result.requiresManualDownload) {
          const sessionStarted = await beginManualNexusInstallSession(result);
          if (sessionStarted) {
            return;
          }

          if (!result.recoveryUrl) {
            throw new Error(
              result.error ||
                'Nexus requires website confirmation, but SIMM did not receive the target file details for this update.',
            );
          }

          setConfirmDialog({
            title: 'Manual Download Required',
            message: result.error || 'Open the mod page to complete this update manually.',
            confirmText: 'Open Source Page',
            cancelText: 'Dismiss',
            onConfirm: () => openExternalSourceUrl(result.recoveryUrl),
          });
          return;
        }
        throw new Error(result.error || result.message || 'Failed to update mod');
      }

      await loadInstalledMods(false, true);
      await loadDownloadedLibrary();
      await loadCachedModUpdates();
      if (onModsChanged) {
        onModsChanged();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update mod');
    } finally {
      setUpdatingMod(null);
    }
  };
  const requestDeleteMod = (mod: ModInfo) => {
    const isManagedInstall = Boolean(mod.managed || mod.modStorageId);
    const dialog: ConfirmDialog = {
      title: isManagedInstall ? 'Uninstall Managed Mod?' : 'Delete Installed File?',
      message: isManagedInstall
        ? `Remove "${mod.name}" from this environment? SIMM will delete the managed files from this environment and keep the downloaded library copy.`
        : `Delete "${mod.name}" from this environment? This removes the installed file from the Mods folder.`,
      confirmText: isManagedInstall ? 'Uninstall from Environment' : 'Delete File',
      cancelText: 'Cancel',
      onConfirm: () => handleDeleteMod(mod),
      readyAt: Date.now() + 200,
    };

    window.setTimeout(() => {
      setConfirmDialog(dialog);
    }, 0);
  };

  const handleDisableMod = async (mod: ModInfo) => {
    setDisablingMod(mod.fileName);
    try {
      suppressWatcherReloadUntilRef.current = Date.now() + 1500;
      await ApiService.disableMod(environmentId, mod.fileName);
      // Update the specific mod in-place to avoid a full list reload flash
      setMods(prev => prev.map(m => m.fileName === mod.fileName ? { ...m, disabled: true } : m));
      if (onModsChanged) {
        onModsChanged();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to disable mod');
    } finally {
      setDisablingMod(null);
    }
  };

  const handleEnableMod = async (mod: ModInfo) => {
    setEnablingMod(mod.fileName);
    try {
      suppressWatcherReloadUntilRef.current = Date.now() + 1500;
      await ApiService.enableMod(environmentId, mod.fileName);
      // Update the specific mod in-place to avoid a full list reload flash
      setMods(prev => prev.map(m => m.fileName === mod.fileName ? { ...m, disabled: false } : m));
      if (onModsChanged) {
        onModsChanged();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to enable mod');
    } finally {
      setEnablingMod(null);
    }
  };

  const handleOpenFolder = async () => {
    try {
      await ApiService.openModsFolder(environmentId);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to open mods folder');
    }
  };  const handleConfirmDialog = () => {
    if (!confirmDialog) return;
    if (confirmDialog.readyAt && Date.now() < confirmDialog.readyAt) {
      return;
    }
    const action = confirmDialog.onConfirm;
    setConfirmDialog(null);
    Promise.resolve(action()).catch((err) => {
      console.error('Confirm action failed:', err);
      setError(err instanceof Error ? err.message : 'Action failed');
    });
  };

  const extractModNameFromFileName = (fileName: string): string => {
    let modName = fileName.replace(/\.(dll|zip|rar|7z|tar\.gz|tgz)$/i, '');

    modName = modName.replace(/[-_ ]?v?\d+\.\d+(\.\d+)?([-_ ].*)?$/i, '');
    modName = modName.replace(/[-_ ]?\d+\.\d+\.\d+.*$/i, '');
    modName = modName.replace(/[-_ ]?(il2cpp|mono|beta|alpha|release).*$/i, '');
    modName = modName.replace(/^\d+-/, '');

    modName = modName.trim().replace(/[-_]+/g, ' ').trim();

    return modName || fileName.replace(/\.(dll|zip|rar|7z|tar\.gz|tgz)$/i, '');
  };

  const fuzzyMatchModName = (searchName: string, modName: string): number => {
    const searchLower = searchName.toLowerCase().trim();
    const modLower = modName.toLowerCase().trim();

    if (modLower === searchLower) return 1.0;

    if (modLower.includes(searchLower) || searchLower.includes(modLower)) {
      return 0.8;
    }

    const searchWords = searchLower.split(/\s+/);
    const modWords = modLower.split(/\s+/);
    let matchedWords = 0;

    for (const searchWord of searchWords) {
      if (modWords.some(modWord => modWord.includes(searchWord) || searchWord.includes(modWord))) {
        matchedWords++;
      }
    }

    if (matchedWords > 0) {
      return (matchedWords / Math.max(searchWords.length, modWords.length)) * 0.6;
    }

    return 0;
  };

  const detectModSource = async (fileName: string): Promise<ManualUploadSourceInfo> => {
    const fileNameLower = fileName.toLowerCase();

    // Check for Thunderstore indicators
    // Thunderstore mods often have specific naming patterns or contain manifest.json
    if (fileNameLower.includes('thunderstore') ||
        fileNameLower.includes('thunder') ||
        fileNameLower.match(/^[a-z0-9_-]+-[a-z0-9_-]+-\d+\.\d+\.\d+\.zip$/i)) {
      // Try to extract mod info from filename (format: modname-version.zip)
      const match = fileName.match(/^(.+?)-(\d+\.\d+\.\d+)/);
      if (match) {
        return {
          source: 'thunderstore',
          modName: match[1],
          sourceVersion: match[2],
        };
      }
      return { source: 'thunderstore' };
    }

    // Check for Nexus Mods indicators
    // Nexus mods often have numeric IDs in filename or specific patterns
    if (fileNameLower.includes('nexus') ||
        fileNameLower.match(/^\d+-\d+/) || // Pattern like "12345-67890" (modId-fileId)
        fileNameLower.includes('nexusmods')) {
      // Try to extract mod ID from filename
      const match = fileName.match(/(\d+)-(\d+)/);
      if (match) {
        return {
          source: 'nexusmods',
          sourceId: match[1],
          sourceUrl: `https://www.nexusmods.com/schedule1/mods/${match[1]}`,
        };
      }
      return { source: 'nexusmods' };
    }

    const cleanModName = extractModNameFromFileName(fileName);
    if (cleanModName.length >= 3) {
      try {
        const searchResults = await ApiService.searchNexusMods('schedule1', cleanModName);

        if (searchResults.mods && searchResults.mods.length > 0) {
          let bestMatch: NexusMod | null = null;
          let bestScore = 0;

          for (const mod of searchResults.mods) {
            const score = fuzzyMatchModName(cleanModName, mod.name);
            if (score > bestScore && score >= 0.6) {
              bestScore = score;
              bestMatch = mod;
            }
          }

          if (bestMatch) {
            return {
              source: 'nexusmods',
              sourceId: bestMatch.mod_id.toString(),
              sourceUrl: `https://www.nexusmods.com/schedule1/mods/${bestMatch.mod_id}`,
              modName: bestMatch.name,
              author: bestMatch.author,
              sourceVersion: bestMatch.version,
            };
          }
        }
      } catch (err) {
        console.warn('Failed to search Nexus Mods for mod:', cleanModName, err);
      }
    }

    // Default to unknown for manual uploads
    return { source: 'unknown' };
  };

  const normalizeSelectedUploadItems = (
    selected: string | { path: string; name?: string } | Array<string | { path: string; name?: string }> | null,
  ): ManualUploadItem[] => {
    if (!selected) {
      return [];
    }

    const entries = Array.isArray(selected) ? selected : [selected];
    return entries.map((entry) => {
      if (typeof entry === 'string') {
        return {
          filePath: entry,
          fileName: entry.split(/[/\\]/).pop() || 'unknown',
        };
      }

      return {
        filePath: entry.path,
        fileName: entry.name || entry.path.split(/[/\\]/).pop() || 'unknown',
      };
    });
  };

  const recordUploadBatchResult = (result: ManualUploadBatchResult): ManualUploadBatchResult[] => {
    const nextResults = [...uploadBatchResultsRef.current, result];
    uploadBatchResultsRef.current = nextResults;
    setUploadBatchResults(nextResults);
    return nextResults;
  };

  const buildUploadBatchSummary = (results: ManualUploadBatchResult[]): string | null => {
    if (results.length === 0) {
      return null;
    }

    const successCount = results.filter((result) => result.status === 'success').length;
    const failed = results.filter((result) => result.status === 'failed');
    const skipped = results.filter((result) => result.status === 'skipped');

    const counts = [
      `${successCount} succeeded`,
      `${failed.length} failed`,
      `${skipped.length} skipped`,
    ].join(', ');

    const details: string[] = [];
    if (failed.length > 0) {
      details.push(`Failed: ${failed.map((result) => `${result.fileName} (${result.message})`).join('; ')}`);
    }
    if (skipped.length > 0) {
      details.push(`Skipped: ${skipped.map((result) => `${result.fileName} (${result.message})`).join('; ')}`);
    }

    return [`Add batch finished: ${counts}.`, details.join(' ')].filter(Boolean).join(' ');
  };

  const finalizeUploadBatch = async (results: ManualUploadBatchResult[]) => {
    const successCount = results.filter((result) => result.status === 'success').length;

    if (successCount > 0) {
      await loadInstalledMods(false, true);
      await loadDownloadedLibrary();
      await loadCachedModUpdates();
      if (onModsChanged) {
        onModsChanged();
      }
    }

    const summary = buildUploadBatchSummary(results);
    if (summary) {
      setUploadBatchSummary({
        message: summary,
        variant: results.some((result) => result.status !== 'success') ? 'mixed' : 'success',
      });
      showToast(summary, 9000);
      if (successCount === 0 && results.some((result) => result.status === 'failed')) {
        setError(summary);
      } else {
        setError(null);
      }
    }

    setUploading(false);
    setUploadQueue([]);
    setCurrentUploadItem(null);
    setPendingUpload(null);
    setPendingRuntimeSelection(null);
    setUploadBatchTotal(0);
  };

  const continueUploadBatch = async (remainingQueue: ManualUploadItem[]) => {
    setUploadQueue(remainingQueue);

    if (remainingQueue.length === 0) {
      await finalizeUploadBatch(uploadBatchResultsRef.current);
      return;
    }

    const [nextItem, ...rest] = remainingQueue;
    setCurrentUploadItem(nextItem);
    setUploadQueue(rest);

    try {
      const sourceInfo = await detectModSource(nextItem.fileName);
      const detectedRuntime =
        detectRuntimeFromFileName(nextItem.fileName) ||
        (isArchiveFile(nextItem.fileName) ? environment?.runtime ?? null : null);

      if (!detectedRuntime) {
        setPendingRuntimeSelection({
          ...nextItem,
          sourceInfo,
          remainingQueue: rest,
        });
        return;
      }

      await performUpload(nextItem, detectedRuntime, sourceInfo, rest);
    } catch (err) {
      const results = recordUploadBatchResult({
        fileName: nextItem.fileName,
        status: 'failed',
        message: err instanceof Error ? err.message : 'Failed to prepare upload',
      });
      if (rest.length === 0) {
        await finalizeUploadBatch(results);
        return;
      }

      await continueUploadBatch(rest);
    }
  };

  const completeUploadItem = async (
    result: ManualUploadBatchResult,
    remainingQueue: ManualUploadItem[],
  ) => {
    setPendingRuntimeSelection(null);
    setPendingUpload(null);
    setCurrentUploadItem(null);

    const results = recordUploadBatchResult(result);

    if (remainingQueue.length === 0) {
      await finalizeUploadBatch(results);
      return;
    }

    await continueUploadBatch(remainingQueue);
  };

  const performUpload = async (
    item: ManualUploadItem,
    runtime: 'IL2CPP' | 'Mono',
    sourceInfo: ManualUploadSourceInfo,
    remainingQueue: ManualUploadItem[],
    securityOverride = false,
  ) => {
    setUploading(true);

    try {
      const metadataWithRuntime = {
        ...sourceInfo,
        detectedRuntime: runtime,
      };

      const result = await ApiService.uploadMod(
        environmentId,
        item.filePath,
        item.fileName,
        environment!.runtime,
        metadataWithRuntime,
        securityOverride,
      );

      if (!result.success) {
        const handled = handleSecurityGateResponse(
          `Security Findings - ${item.fileName}`,
          result,
          async () => {
            await performUpload(item, runtime, sourceInfo, remainingQueue, true);
          },
          () => {
            void completeUploadItem(
              {
                fileName: item.fileName,
                status: 'skipped',
                message: 'Security review dismissed.',
              },
              remainingQueue,
            );
          },
        );
        if (handled) {
          return;
        }

        await completeUploadItem(
          {
            fileName: item.fileName,
            status: 'failed',
            message: result.error || 'Failed to add mod',
          },
          remainingQueue,
        );
        return;
      }

      if (result.runtimeMismatch && result.runtimeMismatch.requiresConfirmation) {
        setPendingUpload({
          fileName: item.fileName,
          remainingQueue,
          runtimeMismatch: result.runtimeMismatch,
        });
        return;
      }

      await completeUploadItem(
        {
          fileName: item.fileName,
          status: 'success',
          message: 'Installed successfully.',
        },
        remainingQueue,
      );
    } catch (err) {
      await completeUploadItem(
        {
          fileName: item.fileName,
          status: 'failed',
          message: err instanceof Error ? err.message : 'Failed to add mod',
        },
        remainingQueue,
      );
    }
  };

  const handleUploadClick = async () => {
    if (!environment) {
      setError('Environment not loaded');
      return;
    }

    setUploading(true);
    setError(null);
    setUploadBatchSummary(null);

    try {
      const selected = await open({
        multiple: true,
        filters: [{
          name: 'Mod Files',
          extensions: ['dll', 'zip', 'rar', '7z', 'tar.gz', 'tgz']
        }],
        title: 'Select Mod Files',
      }) as string | { path: string; name?: string } | Array<string | { path: string; name?: string }> | null;

      const selectedItems = normalizeSelectedUploadItems(selected);

      if (selectedItems.length === 0) {
        setUploading(false);
        return;
      }

      uploadBatchResultsRef.current = [];
      setUploadBatchResults([]);
      setUploadBatchTotal(selectedItems.length);
      setUploadQueue(selectedItems);
      setCurrentUploadItem(null);
      setPendingUpload(null);
      setPendingRuntimeSelection(null);
      await continueUploadBatch(selectedItems);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add mod');
      setUploading(false);
    }
  };

  const detectRuntimeFromFileName = (fileName: string): 'IL2CPP' | 'Mono' | null => {
    const lower = fileName.toLowerCase();
    if (lower.includes('mono')) return 'Mono';
    if (lower.includes('il2cpp')) return 'IL2CPP';
    return null;
  };

  const isArchiveFile = (fileName: string): boolean => /\.(zip|rar|7z|tar\.gz|tgz)$/i.test(fileName);

  const handleRuntimeSelectionConfirm = async (selectedRuntime: 'IL2CPP' | 'Mono') => {
    if (!pendingRuntimeSelection) return;
    const { sourceInfo, remainingQueue, ...item } = pendingRuntimeSelection;
    setPendingRuntimeSelection(null);
    await performUpload(item, selectedRuntime, sourceInfo, remainingQueue);
  };

  const handleRuntimeSelectionCancel = () => {
    if (!pendingRuntimeSelection) {
      return;
    }

    const { fileName, remainingQueue } = pendingRuntimeSelection;
    setPendingRuntimeSelection(null);
    void completeUploadItem(
      {
        fileName,
        status: 'skipped',
        message: 'Runtime selection canceled.',
      },
      remainingQueue,
    );
  };

  const handleRuntimeMismatchConfirm = async () => {
    if (!pendingUpload) {
      return;
    }

    const { fileName, remainingQueue } = pendingUpload;
    setPendingUpload(null);
    await completeUploadItem(
      {
        fileName,
        status: 'success',
        message: 'Installed after acknowledging runtime mismatch.',
      },
      remainingQueue,
    );
  };

  const handleRuntimeMismatchCancel = () => {
    if (!pendingUpload) {
      return;
    }

    const { fileName, remainingQueue } = pendingUpload;
    setPendingUpload(null);
    void completeUploadItem(
      {
        fileName,
        status: 'success',
        message: 'Installed; runtime mismatch warning was dismissed.',
      },
      remainingQueue,
    );
  };  const getSourceLabel = (source?: string): string => {
    switch (source) {
      case 'thunderstore':
        return 'ThunderStore';
      case 'nexusmods':
        return 'NexusMods';
      case 'github':
        return 'GitHub';
      case 'local':
        return 'Local';
      default:
        return 'Unknown';
    }
  };
  const isLinkableLocalMod = useCallback((mod?: ModInfo | null) => {
    if (!mod) {
      return false;
    }
    return !mod.managed && (!mod.source || mod.source === 'local' || mod.source === 'unknown');
  }, []);

  const localModRequiresLinkConfirmation = useCallback((mod: ModInfo, preview: LocalModSourcePreview) => {
    const localName = normalizeModNameKey(mod.name || mod.fileName);
    const remoteName = normalizeModNameKey(preview.displayName);
    return !!localName && !!remoteName && localName !== remoteName;
  }, []);

  const closeLocalSourceLink = useCallback(() => {
    setLocalSourceLinkState(null);
  }, []);

  const openLocalSourceLink = useCallback((mod: ModInfo) => {
    setLocalSourceLinkState({
      modId: `${mod.fileName}-${mod.path}`,
      modFileName: mod.fileName,
      sourceUrl: mod.sourceUrl || '',
      sourceUrlTouched: false,
      stage: 'chooseSource',
      strategy: null,
      loadingExistingHint: true,
      loadingPreview: false,
      loadingOwnership: false,
      existingSourceHint: null,
      preview: undefined,
      selectedVersion: undefined,
      customVersion: '',
      error: null,
      ownershipCandidates: [],
      selectedOwnershipIds: [],
    });
    void ApiService.getLocalModExistingSourceHint(environmentId, mod.fileName)
      .then((hint) => {
        setLocalSourceLinkState((current) => {
          if (!current || current.modId !== `${mod.fileName}-${mod.path}`) {
            return current;
          }
          return {
            ...current,
            loadingExistingHint: false,
            existingSourceHint: hint,
            stage: hint ? 'chooseSource' : 'edit',
          };
        });
      })
      .catch((err) => {
        setLocalSourceLinkState((current) => {
          if (!current || current.modId !== `${mod.fileName}-${mod.path}`) {
            return current;
          }
          return {
            ...current,
            loadingExistingHint: false,
            existingSourceHint: null,
            stage: 'edit',
            error: err instanceof Error ? err.message : 'Failed to load existing source hint.',
          };
        });
      });
  }, [environmentId]);

  const requestLocalSourcePreview = useCallback(async (
    mod: ModInfo,
    sourceUrl: string,
  ): Promise<LocalModSourcePreview | null> => {
    const trimmed = sourceUrl.trim();
    if (!trimmed) {
      setLocalSourceLinkState((current) => current ? {
        ...current,
        preview: undefined,
        selectedVersion: undefined,
        error: 'Source URL is required.',
        loadingPreview: false,
      } : current);
      return null;
    }

    setLocalSourceLinkState((current) => current ? {
      ...current,
      loadingPreview: true,
      error: null,
    } : current);

    try {
      const preview = await ApiService.previewLocalModSourceLink(environmentId, mod.fileName, trimmed);
      const exactVersion = mod.version && preview.versions.some((entry) => entry.version === mod.version)
        ? mod.version
        : undefined;
      setLocalSourceLinkState((current) => current ? {
        ...current,
        sourceUrl: preview.sourceUrl,
        preview,
        strategy: current.strategy ?? 'manual',
        selectedVersion: exactVersion
          ?? (current.selectedVersion && preview.versions.some((entry) => entry.version === current.selectedVersion)
            ? current.selectedVersion
            : undefined),
        loadingPreview: false,
        error: null,
      } : current);
      return preview;
    } catch (err) {
      setLocalSourceLinkState((current) => current ? {
        ...current,
        preview: undefined,
        selectedVersion: undefined,
        loadingPreview: false,
        error: err instanceof Error ? err.message : 'Failed to load source preview.',
      } : current);
      return null;
    }
  }, [environmentId]);

  const promoteLocalSourceLink = useCallback(async (
    mod: ModInfo,
    preview: LocalModSourcePreview,
    selectedVersion: string,
    selectedOwnershipIds: string[],
    resumeStage: LocalSourceLinkStage,
  ) => {
    setLocalSourceLinkState((current) => current ? {
      ...current,
      stage: 'saving',
      error: null,
    } : current);

    try {
      await ApiService.promoteLocalModToManaged(
        environmentId,
        mod.fileName,
        preview.sourceUrl,
        selectedVersion,
        selectedOwnershipIds,
      );
      showToast('Mod linked and added to Mod Library.');
      closeLocalSourceLink();
      await loadInstalledMods(false, true);
      await loadDownloadedLibrary();
      await loadCachedModUpdates();
      onModsChanged?.();
    } catch (err) {
      setLocalSourceLinkState((current) => current ? {
        ...current,
        stage: resumeStage,
        error: err instanceof Error ? err.message : 'Failed to link local mod source.',
      } : current);
    }
  }, [closeLocalSourceLink, environmentId, onModsChanged, showToast]);

  const prepareLocalOwnershipStep = useCallback(async (
    mod: ModInfo,
    preview: LocalModSourcePreview,
    resolvedVersion: string,
  ) => {
    setLocalSourceLinkState((current) => current ? {
      ...current,
      loadingOwnership: true,
      error: null,
    } : current);
    try {
      const candidates = await ApiService.getLocalModOwnershipCandidates(
        environmentId,
        mod.fileName,
        preview.displayName,
      );
      if (candidates.length === 0) {
        await promoteLocalSourceLink(mod, preview, resolvedVersion, [], 'edit');
        return;
      }
      setLocalSourceLinkState((current) => current ? {
        ...current,
        preview,
        selectedVersion: resolvedVersion,
        loadingOwnership: false,
        stage: 'pickOwnership',
        ownershipCandidates: candidates,
        selectedOwnershipIds: [],
        error: null,
      } : current);
    } catch (err) {
      setLocalSourceLinkState((current) => current ? {
        ...current,
        loadingOwnership: false,
        error: err instanceof Error ? err.message : 'Failed to load ownership candidates.',
      } : current);
    }
  }, [environmentId, promoteLocalSourceLink]);

  const continueLocalSourceLink = useCallback(async (mod: ModInfo, state: LocalSourceLinkState) => {
    const preview = state.preview ?? await requestLocalSourcePreview(mod, state.sourceUrl);
    if (!preview) {
      return;
    }

    const resolvedVersion = state.customVersion.trim()
      || state.selectedVersion
      || (mod.version && preview.versions.some((entry) => entry.version === mod.version) ? mod.version : undefined);
    if (!resolvedVersion) {
      setLocalSourceLinkState((current) => current ? {
        ...current,
        error: 'Choose the installed version before continuing.',
      } : current);
      return;
    }

    if (localModRequiresLinkConfirmation(mod, preview)) {
      setLocalSourceLinkState((current) => current ? {
        ...current,
        preview,
        selectedVersion: resolvedVersion,
        stage: 'confirmMismatch',
        error: null,
      } : current);
      return;
    }

    await prepareLocalOwnershipStep(mod, preview, resolvedVersion);
  }, [localModRequiresLinkConfirmation, prepareLocalOwnershipStep, requestLocalSourcePreview]);

  const totalUpdatesAvailable = mods.filter((mod) => {
    const updateInfo = modUpdates.get(mod.fileName);
    const canAutoUpdate = mod.source === 'thunderstore' || mod.source === 'nexusmods' || mod.source === 'github';
    return !!updateInfo?.updateAvailable && canAutoUpdate;
  }).length;

  const filteredMods = [...mods]
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
    .filter((mod) => {
      const updateAvailable = !!modUpdates.get(mod.fileName)?.updateAvailable;
      if (modsTab === 'updates' && !updateAvailable) {
        return false;
      }
      if (modsTab === 'updates') {
        return true;
      }
      switch (modListFilter) {
        case 'updates':
          return updateAvailable;
        case 'enabled':
          return !mod.disabled;
        case 'disabled':
          return !!mod.disabled;
        default:
          return true;
      }
    })
    .filter((mod) => {
      const query = installedSearchTerm.trim().toLowerCase();
      if (!query) {
        return true;
      }
      return mod.name.toLowerCase().includes(query)
        || mod.fileName.toLowerCase().includes(query)
        || (mod.summary || '').toLowerCase().includes(query)
        || (mod.version || '').toLowerCase().includes(query);
    });

  const openInstalledModView = (mod: ModInfo) => {
    const update = modUpdates.get(mod.fileName);
    openModView({
      id: `${mod.fileName}-${mod.path}`,
      storageId: mod.modStorageId,
      name: mod.name,
      source: mod.source || 'local',
      summary: mod.summary,
      iconUrl: mod.iconUrl,
      iconCachePath: mod.iconCachePath,
      sourceUrl: mod.sourceUrl,
      author: mod.author,
      downloads: mod.downloads,
      likesOrEndorsements: mod.likesOrEndorsements,
      updatedAt: mod.updatedAt,
      tags: mod.tags,
      installedVersion: mod.version,
      latestVersion: getInstalledModLatestVersion(mod, update),
      installedAt: mod.installedAt,
      securityScan: mod.securityScan,
      kind: 'installed',
    });
  };  const selectedInstalledMod = useMemo(() => {
    if (!isOpen || activeModView?.kind !== 'installed') {
      return null;
    }
    return mods.find((mod) => `${mod.fileName}-${mod.path}` === activeModView.id) || null;
  }, [activeModView, isOpen, mods]);
  const selectedInstalledSecurityBadge = getSecurityBadgeConfig(selectedInstalledMod?.securityScan);

  useEffect(() => {
    if (!isOpen || !localSourceLinkState) {
      return;
    }
    if (!selectedInstalledMod || `${selectedInstalledMod.fileName}-${selectedInstalledMod.path}` !== localSourceLinkState.modId) {
      setLocalSourceLinkState(null);
    }
  }, [isOpen, localSourceLinkState, selectedInstalledMod]);

  useEffect(() => {
    if (!isOpen || filteredMods.length === 0) {
      return;
    }

    const stillValid = activeModView?.kind === 'installed'
      && filteredMods.some((mod) => `${mod.fileName}-${mod.path}` === activeModView.id);

    if (!stillValid) {
      openInstalledModView(filteredMods[0]);
    }
  }, [activeModView, filteredMods, isOpen]);

  if (!isOpen) return null;

  const openContextMenu = (event: ReactMouseEvent, items: AnchoredContextMenuItem[]) => {
    event.preventDefault();
    setContextMenu({ x: event.clientX, y: event.clientY, items });
  };

  const renderCardIcon = (name: string, iconCachePath?: string, iconUrl?: string, variant: 'inline' | 'rail' = 'inline') => {
    const local = resolveImageSource(iconCachePath);
    const remote = resolveImageSource(iconUrl);
    const source = local || remote;
    const className = variant === 'rail' ? 'mod-card-icon-rail' : 'mod-card-icon-inline';

    if (!source) {
      return (
        <div className={`${className} mod-card-icon-fallback`}>
          <Icon name="fas fa-puzzle-piece" />
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
  };


  return (
    <>
      <ConfirmOverlay
        isOpen={showNexusKeyRequiredModal}
        onClose={() => setShowNexusKeyRequiredModal(false)}
        onConfirm={() => {
          setShowNexusKeyRequiredModal(false);
          if (onOpenAccounts) {
            onOpenAccounts();
          } else {
            setError('Nexus Login is required to download files. Open Accounts to continue.');
          }
        }}
        title="Nexus Login Required"
        message={nexusRequiresSiteConfirmation ? 'This Nexus account must confirm downloads on NexusMods website for each file. Open Accounts for details.' : 'Downloading from NexusMods requires Nexus Login. Open Accounts to continue.'}
        confirmText="Open Accounts"
        cancelText="Not Now"
        isNested
      />
      <ConfirmOverlay
        isOpen={!!pendingUpload}
        onClose={handleRuntimeMismatchCancel}
        onConfirm={handleRuntimeMismatchConfirm}
        title="Runtime Mismatch Warning"
        message={pendingUpload?.runtimeMismatch.warning || ''}
        confirmText="Continue Anyway"
        cancelText="Cancel"
        isNested
      />
      <ConfirmOverlay
        isOpen={!!confirmDialog}
        onClose={() => setConfirmDialog(null)}
        onConfirm={handleConfirmDialog}
        title={confirmDialog?.title || ''}
        message={confirmDialog?.message || ''}
        confirmText={confirmDialog?.confirmText}
        cancelText={confirmDialog?.cancelText}
        isNested
      />
      <SecurityScanReportOverlay
        isOpen={!!activeSecurityReport}
        title={activeSecurityReport?.title || 'Security Findings'}
        report={activeSecurityReport?.report || null}
        reportOptions={activeSecurityReport?.reportOptions}
        onClose={closeSecurityReport}
        onConfirm={activeSecurityReport?.onConfirm ? () => { void handleSecurityReportConfirm(); } : undefined}
        confirmLabel={activeSecurityReport?.confirmLabel || 'Continue Install'}
        busy={securityActionBusy}
      />
      {pendingRuntimeSelection && (
        <Dialog open={!!pendingRuntimeSelection} onOpenChange={(open) => {
          if (!open) {
            handleRuntimeSelectionCancel();
          }
        }}>
          <SimmDialogContent
            nested
            className="app-dialog app-dialog--message"
            style={{ maxWidth: '400px' }}
            showCloseButton={false}
          >
            <DialogHeader className="modal-header">
              <DialogTitle>Select Mod Runtime</DialogTitle>
              <SimmButton type="button" variant="ghost" size="icon-sm" className="modal-close" onClick={handleRuntimeSelectionCancel} aria-label="Close runtime selection dialog">×</SimmButton>
            </DialogHeader>
            <div className="app-dialog__body">
              <DialogDescription style={{ marginBottom: '1rem', color: '#ccc' }}>
                Could not determine the runtime for <strong>{pendingRuntimeSelection.fileName}</strong>.
              </DialogDescription>
              <DialogFooter className="app-dialog__footer" style={{ display: 'flex', gap: '0.75rem', justifyContent: 'center' }}>
                <SimmButton type="button" className="btn btn-primary" onClick={() => handleRuntimeSelectionConfirm('Mono')}>Mono</SimmButton>
                <SimmButton type="button" className="btn btn-primary" onClick={() => handleRuntimeSelectionConfirm('IL2CPP')}>IL2CPP</SimmButton>
              </DialogFooter>
            </div>
          </SimmDialogContent>
        </Dialog>
      )}

      <div className="mods-overlay mods-overlay--environment workspace-collection-shell">
        <WorkspacePageHeader
          eyebrow={environment?.name || 'Environment'}
          title="Mods"
          description={`Manage installed mods, updates, source links, and local files for ${environment?.name || 'this environment'}.`}
        />

        <div className="workspace-collection">
          <div className="workspace-collection__main">
            <div className="workspace-collection__header">
              <div className="workspace-collection__nav">
                <div className="workspace-collection__rail-group workspace-collection__rail-group--inline">
                  {([
                    ['installed', 'Installed', 'fas fa-puzzle-piece'],
                    ['updates', 'Updates', 'fas fa-arrow-up'],
                  ] as Array<[ModsTab, string, string]>).map(([tab, label, icon]) => (
                    <SimmButton
                      key={tab}
                      type="button"
                      variant="ghost"
                      className={`workspace-collection__rail-button ${modsTab === tab ? 'workspace-collection__rail-button--active' : ''}`}
                      onClick={() => setModsTab(tab)}
                    >
                      <Icon name={icon} />
                      <span>{label}</span>
                    </SimmButton>
                  ))}
                </div>

                <div className="workspace-collection__summary">
                  <div className="workspace-collection__summary-chip">
                    <span>Installed</span>
                    <strong>{mods.length}</strong>
                  </div>
                  <div className="workspace-collection__summary-chip">
                    <span>Updates</span>
                    <strong>{totalUpdatesAvailable}</strong>
                  </div>
                  <div className="workspace-collection__summary-chip">
                    <span>Runtime</span>
                    <strong>{environment?.runtime || 'Unknown'}</strong>
                  </div>
                </div>
              </div>

              {modsTab === 'installed' && (
                <div className="workspace-collection__rail-group workspace-collection__rail-group--inline workspace-collection__filters-row">
                  {(['all', 'enabled', 'disabled'] as Array<'all' | 'enabled' | 'disabled'>).map((filter) => (
                    <SimmButton
                      key={filter}
                      type="button"
                      variant="ghost"
                      className={`workspace-collection__rail-button workspace-collection__rail-button--subtle ${modListFilter === filter ? 'workspace-collection__rail-button--active' : ''}`}
                      onClick={() => setModListFilter(filter)}
                    >
                      {filter === 'all' ? 'All' : filter === 'enabled' ? 'Enabled' : 'Disabled'}
                    </SimmButton>
                  ))}
                </div>
              )}

              <div className="workspace-collection__toolbar">
                <div className="workspace-collection__toolbar-group workspace-collection__toolbar-group--summary">
                  <strong>{environment?.name || 'Environment'}</strong>
                  <span>{environment?.runtime || 'Unknown'} • {modsTab === 'updates' ? 'Update review' : 'Installed mods'}</span>
                </div>
                <div className="workspace-collection__toolbar-search">
                  <Input
                    type="text"
                    value={installedSearchTerm}
                    onChange={(event) => setInstalledSearchTerm(event.target.value)}
                    placeholder={modsTab === 'updates' ? 'Filter updates' : 'Search installed mods'}
                  />
                </div>
                <div className="workspace-collection__toolbar-group">
                  <SimmButton type="button" variant="secondary" onClick={handleCheckModUpdates} className="btn btn-secondary btn-small" disabled={checkingModUpdates}>
                    {checkingModUpdates ? 'Checking...' : 'Check Updates'}
                  </SimmButton>
                  <SimmButton
                    type="button"
                    variant="secondary"
                    onClick={() => void handleScanLocalInstalledMods()}
                    className="btn btn-secondary btn-small"
                    disabled={scanningLocalMods || mods.length === 0}
                  >
                    {scanningLocalMods ? 'Scanning...' : 'Scan Local Mods'}
                  </SimmButton>
                  <SimmButton
                    type="button"
                    onClick={handleUploadClick}
                    className="btn btn-primary btn-small"
                    disabled={uploading}
                    title="Add one or more mod files (.dll, .zip, .rar, .7z, .tar.gz, or .tgz)"
                  >
                    {uploading ? uploadButtonBusyLabel : 'Add Mod'}
                  </SimmButton>
                  <SimmButton type="button" variant="secondary" className="btn btn-secondary btn-small" onClick={handleOpenFolder}>
                    Open Folder
                  </SimmButton>
                  <SimmButton type="button" variant="secondary" onClick={onOpenModLibrary} className="btn btn-secondary btn-small" disabled={!onOpenModLibrary}>
                    Open Mod Library
                  </SimmButton>
                </div>
              </div>
            </div>

            <div className="workspace-collection__content" ref={modsScrollContainerRef}>
              {uploadBatchSummary && (
                <div
                  style={{
                    marginBottom: '0.85rem',
                    padding: '0.85rem 1rem',
                    borderRadius: '0.9rem',
                    border: uploadBatchSummary.variant === 'success' ? '1px solid rgba(109, 211, 154, 0.35)' : '1px solid rgba(240, 196, 96, 0.35)',
                    background: uploadBatchSummary.variant === 'success' ? 'rgba(21, 53, 40, 0.68)' : 'rgba(74, 53, 17, 0.58)',
                    color: uploadBatchSummary.variant === 'success' ? '#d9f8e6' : '#ffe7b0',
                    boxShadow: '0 14px 28px rgba(0, 0, 0, 0.18)',
                    lineHeight: 1.5,
                  }}
                >
                  {uploadBatchSummary.message}
                </div>
              )}
              {error && <CollectionEmpty tone="error">{error}</CollectionEmpty>}
              {!loading && !error && filteredMods.length === 0 && (
                <CollectionEmpty>
                  {modsTab === 'updates' ? 'No installed mods currently need updates.' : 'No installed mods match this filter.'}
                </CollectionEmpty>
              )}
              {!error && filteredMods.length > 0 && (
                <div className="workspace-collection__list">
                  <div className="workspace-collection__table-head workspace-collection__table-head--installed">
                    <span>Name</span>
                    <span>Source</span>
                    <span>Version</span>
                    <span>Status</span>
                  </div>
                  <div className="workspace-collection__list-body">
                    {filteredMods.map((mod) => {
                      const updateInfo = modUpdates.get(mod.fileName);
                      const isSelected = activeModView?.kind === 'installed' && activeModView.id === `${mod.fileName}-${mod.path}`;
                      const updateDisabledReason = getUpdateDisabledReason(mod, updateInfo?.updateAvailable);
                      const securityBadge = getSecurityBadgeConfig(mod.securityScan);
                      return (
                        <div
                          key={`${mod.fileName}-${mod.path}`}
                          className={`workspace-collection__row ${isSelected ? 'workspace-collection__row--selected' : ''}`}
                          role="button"
                          aria-label={`Open details for ${mod.name}`}
                          tabIndex={0}
                          onClick={() => openInstalledModView(mod)}
                          onKeyDown={(event) => handleCardActivationKeyDown(event, () => openInstalledModView(mod))}
                          onContextMenu={(event) => openContextMenu(event, [
                            {
                              key: mod.disabled ? 'enable' : 'disable',
                              label: mod.disabled ? 'Enable' : 'Disable',
                              icon: mod.disabled ? 'fas fa-check' : 'fas fa-ban',
                              onSelect: () => void (mod.disabled ? handleEnableMod(mod) : handleDisableMod(mod)),
                            },
                            {
                              key: 'update',
                              label: 'Update',
                              icon: 'fas fa-arrow-up',
                              disabled: !!updateDisabledReason,
                              onSelect: () => void handleUpdateMod(mod),
                            },
                            {
                              key: 'config',
                              label: 'Open Config',
                              icon: 'fas fa-sliders-h',
                              disabled: !onOpenConfig,
                              onSelect: () => onOpenConfig?.(),
                            },
                            {
                              key: 'security',
                              label: mod.securityScan ? 'Rescan Security' : 'Scan Security',
                              icon: 'fas fa-shield-halved',
                              disabled: scanningInstalledMod === `${mod.fileName}-${mod.path}`,
                              onSelect: () => void handleScanInstalledMod(mod),
                            },
                            {
                              key: 'library',
                              label: 'Open in Mod Library',
                              icon: 'fas fa-book-open',
                              disabled: !onOpenModLibrary,
                              onSelect: () => onOpenModLibrary?.(),
                            },
                            {
                              key: 'source',
                              label: 'Open Source Page',
                              icon: 'fas fa-arrow-up-right-from-square',
                              disabled: !safeExternalUrl(mod.sourceUrl),
                              onSelect: () => openExternalSourceUrl(mod.sourceUrl),
                            },
                            {
                              key: 'delete',
                              label: 'Uninstall from Environment',
                              icon: 'fas fa-trash',
                              danger: true,
                              onSelect: () => requestDeleteMod(mod),
                            },
                          ])}
                        >
                          {renderCardIcon(mod.name, mod.iconCachePath, mod.iconUrl, 'inline')}
                          <div className="workspace-collection__row-body">
                            <div className="workspace-collection__row-title">{mod.name}</div>
                            <div className="workspace-collection__row-meta">
                              {mod.disabled && <WorkspaceBadge tone="danger">Disabled</WorkspaceBadge>}
                              {updateInfo?.updateAvailable && <WorkspaceBadge tone="warning">Update available</WorkspaceBadge>}
                              {mod.source && <WorkspaceBadge tone="source">{getSourceLabel(mod.source)}</WorkspaceBadge>}
                              {mod.version && <WorkspaceBadge>{mod.version}</WorkspaceBadge>}
                              <SecurityScanBadge config={securityBadge} />
                            </div>
                            <p className="workspace-collection__row-summary">{mod.summary || mod.fileName}</p>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          </div>

          <aside className="workspace-collection__inspector">
            {!selectedInstalledMod && (
              <InspectorEmpty>Select an installed mod to review details and actions.</InspectorEmpty>
            )}
            {selectedInstalledMod && localSourceLinkState && localSourceLinkState.modId === `${selectedInstalledMod.fileName}-${selectedInstalledMod.path}` && (
              <div className="workspace-inspector-link-panel">
                <div className="workspace-inspector-link-panel__header">
                  <div>
                    <h3>Link Mod Source</h3>
                    <p>Connect this local install to a known source so SIMM can track updates and add it to Mod Library.</p>
                  </div>
                  <WorkspaceBadge tone="source">Local</WorkspaceBadge>
                </div>
                <div className="workspace-inspector-link-panel__summary">
                  <strong>{selectedInstalledMod.name}</strong>
                  <span>{selectedInstalledMod.fileName}</span>
                </div>
                {localSourceLinkState.error && (
                  <div className="workspace-inspector-link-panel__error">{localSourceLinkState.error}</div>
                )}
                {localSourceLinkState.stage === 'chooseSource' && (
                  <div className="workspace-inspector-link-panel__step">
                    <h4>Choose source strategy</h4>
                    {localSourceLinkState.loadingExistingHint ? (
                      <p>Checking whether this local file matches an existing linked mod family.</p>
                    ) : localSourceLinkState.existingSourceHint ? (
                      <>
                        <p>
                          This local file appears to match the existing linked source family{' '}
                          <strong>{localSourceLinkState.existingSourceHint.displayName}</strong>.
                        </p>
                        <div className="workspace-inspector-link-panel__actions">
                          <SimmButton
                            type="button"
                            variant="secondary"
                            className="btn btn-secondary"
                            onClick={() => {
                              setLocalSourceLinkState((current) => current ? {
                                ...current,
                                strategy: 'manual',
                                stage: 'edit',
                                preview: undefined,
                                sourceUrl: '',
                                sourceUrlTouched: false,
                                selectedVersion: undefined,
                                customVersion: '',
                                error: null,
                              } : current);
                            }}
                          >
                            Choose Different Source
                          </SimmButton>
                          <SimmButton
                            type="button"
                            className="btn btn-primary"
                            onClick={() => {
                              const preview = localSourceLinkState.existingSourceHint!;
                              const runtimeLabel = environment?.runtime;
                              const matchingRuntimeVersion = runtimeLabel
                                ? preview.versions.find((entry) => !entry.runtime || entry.runtime === runtimeLabel)
                                : undefined;
                              setLocalSourceLinkState((current) => current ? {
                                ...current,
                                strategy: 'existing',
                                stage: 'edit',
                                preview,
                                sourceUrl: preview.sourceUrl,
                                sourceUrlTouched: false,
                                selectedVersion: matchingRuntimeVersion?.version,
                                customVersion: '',
                                error: null,
                              } : current);
                            }}
                          >
                            Use Existing Source Family
                          </SimmButton>
                        </div>
                      </>
                    ) : (
                      <>
                        <p>No existing managed source family confidently matches this local file yet.</p>
                        <div className="workspace-inspector-link-panel__actions">
                          <SimmButton type="button" variant="secondary" className="btn btn-secondary" onClick={closeLocalSourceLink}>Cancel</SimmButton>
                          <SimmButton
                            type="button"
                            className="btn btn-primary"
                            onClick={() => {
                              setLocalSourceLinkState((current) => current ? {
                                ...current,
                                strategy: 'manual',
                                stage: 'edit',
                                preview: undefined,
                                sourceUrl: '',
                                sourceUrlTouched: false,
                                selectedVersion: undefined,
                                customVersion: '',
                                error: null,
                              } : current);
                            }}
                          >
                            Link Different Source
                          </SimmButton>
                        </div>
                      </>
                    )}
                  </div>
                )}
                {localSourceLinkState.stage === 'edit' && (
                  <>
                    <div className="workspace-inspector-card__field">
                      <label htmlFor="local-source-url">Source URL</label>
                      <Input
                        id="local-source-url"
                        className="workspace-inspector-link-panel__input"
                        type="url"
                        value={localSourceLinkState.sourceUrl}
                        placeholder="https://thunderstore.io/... or https://www.nexusmods.com/..."
                        readOnly={localSourceLinkState.strategy === 'existing'}
                        onChange={(event) => {
                          const nextValue = event.target.value;
                          setLocalSourceLinkState((current) => current ? {
                            ...current,
                            strategy: 'manual',
                            sourceUrl: nextValue,
                            sourceUrlTouched: true,
                            preview: undefined,
                            selectedVersion: undefined,
                            customVersion: '',
                            error: null,
                          } : current);
                        }}
                        onBlur={() => {
                          if (localSourceLinkState.strategy === 'existing') {
                            return;
                          }
                          if (!localSourceLinkState.sourceUrlTouched) {
                            return;
                          }
                          void requestLocalSourcePreview(selectedInstalledMod, localSourceLinkState.sourceUrl);
                        }}
                      />
                      <span className="workspace-inspector-link-panel__hint">
                        Paste the full Thunderstore package page or Nexus Mods mod page URL.
                      </span>
                    </div>
                    <div className="workspace-inspector-card__field">
                      <label>Source</label>
                      <div className="workspace-inspector-card__value">
                        {localSourceLinkState.preview ? getSourceLabel(localSourceLinkState.preview.source) : 'Awaiting source URL'}
                      </div>
                    </div>
                    <div className="workspace-inspector-card__field">
                      <label>Remote mod</label>
                      <div className="workspace-inspector-card__value">
                        {localSourceLinkState.preview?.displayName || 'Paste a source URL to load mod details.'}
                      </div>
                    </div>
                    <div className="workspace-inspector-card__field">
                      <label>Author</label>
                      <div className="workspace-inspector-card__value">
                        {localSourceLinkState.preview?.author || 'Author will be filled automatically after source detection.'}
                      </div>
                    </div>
                    <div className="workspace-inspector-card__field">
                      <label htmlFor="local-source-version">Which version do you currently have installed?</label>
                      <LocalSourceVersionSelect
                        value={localSourceLinkState.selectedVersion || ''}
                        preview={localSourceLinkState.preview}
                        strategy={localSourceLinkState.strategy}
                        runtime={environment?.runtime}
                        loadingPreview={localSourceLinkState.loadingPreview}
                        onValueChange={(nextValue) => {
                          setLocalSourceLinkState((current) => current ? {
                            ...current,
                            selectedVersion: nextValue || undefined,
                            customVersion: '',
                            error: null,
                          } : current);
                        }}
                      />
                    </div>
                    <div className="workspace-inspector-card__field">
                      <label htmlFor="local-custom-version">Or enter a custom local version</label>
                      <Input
                        id="local-custom-version"
                        className="workspace-inspector-link-panel__input"
                        type="text"
                        value={localSourceLinkState.customVersion}
                        placeholder="dev, 1.0.7r2+local, custom build"
                        onChange={(event) => {
                          const nextValue = event.target.value;
                          setLocalSourceLinkState((current) => current ? {
                            ...current,
                            customVersion: nextValue,
                            selectedVersion: nextValue.trim() ? undefined : current.selectedVersion,
                            error: null,
                          } : current);
                        }}
                      />
                    </div>
                    {localSourceLinkState.preview && (
                      <div className="workspace-inspector-card__subsection">
                        <div className="workspace-inspector-card__subsection-header">
                          <div>
                            <h4>Available versions</h4>
                            <p>
                              {localSourceLinkState.strategy === 'existing' && environment?.runtime
                                ? `These are the versions already known for ${environment.runtime}.`
                                : 'Pick the remote version that matches this local install.'}
                            </p>
                          </div>
                          <WorkspaceBadge className="workspace-inspector-card__subsection-count">
                            {(localSourceLinkState.preview.versions || []).filter((version) => {
                              if (localSourceLinkState.strategy !== 'existing' || !environment?.runtime) {
                                return true;
                              }
                              return !version.runtime || version.runtime === environment.runtime;
                            }).length} available
                          </WorkspaceBadge>
                        </div>
                        <div className="workspace-version-list">
                          {(localSourceLinkState.preview.versions || [])
                            .filter((version) => {
                              if (localSourceLinkState.strategy !== 'existing' || !environment?.runtime) {
                                return true;
                              }
                              return !version.runtime || version.runtime === environment.runtime;
                            })
                            .map((version) => (
                            <SimmButton
                              key={version.key}
                              type="button"
                              variant="ghost"
                              className={`workspace-version-row${localSourceLinkState.selectedVersion === version.version ? ' workspace-version-row--active' : ''}`}
                              onClick={() => {
                                setLocalSourceLinkState((current) => current ? {
                                  ...current,
                                  selectedVersion: version.version,
                                  customVersion: '',
                                  error: null,
                                } : current);
                              }}
                            >
                              <div className="workspace-version-row__topline">
                                <strong>{version.version}</strong>
                                <div className="workspace-version-row__badges">
                                  {version.runtime && <WorkspaceBadge>{version.runtime}</WorkspaceBadge>}
                                  {version.isLatest && <WorkspaceBadge tone="success">Latest</WorkspaceBadge>}
                                </div>
                              </div>
                              <div className="workspace-version-row__meta">
                                <span>{version.updatedAt ? `Updated ${new Date(version.updatedAt).toLocaleDateString()}` : 'Updated unknown'}</span>
                                {version.label && <span>{version.label}</span>}
                              </div>
                            </SimmButton>
                          ))}
                        </div>
                      </div>
                    )}
                    <div className="workspace-inspector-link-panel__actions">
                      <SimmButton
                        type="button"
                        variant="secondary"
                        className="btn btn-secondary"
                        onClick={() => {
                          if (localSourceLinkState.existingSourceHint) {
                            setLocalSourceLinkState((current) => current ? {
                              ...current,
                              stage: 'chooseSource',
                              error: null,
                            } : current);
                            return;
                          }
                          closeLocalSourceLink();
                        }}
                      >
                        {localSourceLinkState.existingSourceHint ? 'Back' : 'Cancel'}
                      </SimmButton>
                      <SimmButton
                        type="button"
                        className="btn btn-primary"
                        onClick={() => void continueLocalSourceLink(selectedInstalledMod, localSourceLinkState)}
                        disabled={
                          localSourceLinkState.loadingPreview
                          || localSourceLinkState.loadingOwnership
                          || !localSourceLinkState.preview
                          || (!localSourceLinkState.selectedVersion && !localSourceLinkState.customVersion.trim())
                        }
                      >
                        Continue
                      </SimmButton>
                    </div>
                  </>
                )}
                {localSourceLinkState.stage === 'confirmMismatch' && localSourceLinkState.preview && (
                  <div className="workspace-inspector-link-panel__step">
                    <h4>Confirm source link</h4>
                    <p>
                      You are linking local mod <strong>{selectedInstalledMod.fileName}</strong> to remote mod{' '}
                      <strong>{localSourceLinkState.preview.displayName}</strong>.
                    </p>
                    <div className="workspace-inspector-link-panel__actions">
                      <SimmButton
                        type="button"
                        variant="secondary"
                        className="btn btn-secondary"
                        onClick={() => {
                          setLocalSourceLinkState((current) => current ? {
                            ...current,
                            stage: 'edit',
                            error: null,
                          } : current);
                        }}
                      >
                        Back
                      </SimmButton>
                      <SimmButton
                        type="button"
                        className="btn btn-primary"
                        onClick={() => void prepareLocalOwnershipStep(
                          selectedInstalledMod,
                          localSourceLinkState.preview!,
                          localSourceLinkState.customVersion.trim() || localSourceLinkState.selectedVersion!,
                        )}
                      >
                        Confirm Link
                      </SimmButton>
                    </div>
                  </div>
                )}
                {localSourceLinkState.stage === 'pickOwnership' && localSourceLinkState.preview && (
                  <div className="workspace-inspector-link-panel__step">
                    <h4>Associate additional files</h4>
                    <p>Select any additional unowned files that should belong to this promoted mod. Skip this step if the current DLL is the only file that belongs to it.</p>
                    <div className="workspace-inspector-link-panel__candidate-list">
                      {localSourceLinkState.ownershipCandidates.map((candidate) => {
                        const checked = localSourceLinkState.selectedOwnershipIds.includes(candidate.id);
                        return (
                          <label key={candidate.id} className="workspace-inspector-link-panel__candidate">
                            <Checkbox
                              className="workspace-inspector-link-panel__candidate-checkbox"
                              checked={checked}
                              onCheckedChange={(isChecked) => {
                                setLocalSourceLinkState((current) => current ? {
                                  ...current,
                                  selectedOwnershipIds: isChecked
                                    ? [...current.selectedOwnershipIds, candidate.id]
                                    : current.selectedOwnershipIds.filter((id) => id !== candidate.id),
                                } : current);
                              }}
                            />
                            <div>
                              <strong>{candidate.fileName}</strong>
                              <span>{candidate.bucket} • {candidate.relativePath}</span>
                            </div>
                          </label>
                        );
                      })}
                    </div>
                    <div className="workspace-inspector-link-panel__actions">
                      <SimmButton
                        type="button"
                        variant="secondary"
                        className="btn btn-secondary"
                        onClick={() => {
                          setLocalSourceLinkState((current) => current ? {
                            ...current,
                            stage: localModRequiresLinkConfirmation(selectedInstalledMod, current.preview!)
                              ? 'confirmMismatch'
                              : 'edit',
                            error: null,
                          } : current);
                        }}
                      >
                        Back
                      </SimmButton>
                      <SimmButton
                        type="button"
                        variant="secondary"
                        className="btn btn-secondary"
                        onClick={() => void promoteLocalSourceLink(
                          selectedInstalledMod,
                          localSourceLinkState.preview!,
                          localSourceLinkState.customVersion.trim() || localSourceLinkState.selectedVersion!,
                          [],
                          'pickOwnership',
                        )}
                      >
                        Skip extra files
                      </SimmButton>
                      <SimmButton
                        type="button"
                        className="btn btn-primary"
                        onClick={() => void promoteLocalSourceLink(
                          selectedInstalledMod,
                          localSourceLinkState.preview!,
                          localSourceLinkState.customVersion.trim() || localSourceLinkState.selectedVersion!,
                          localSourceLinkState.selectedOwnershipIds,
                          'pickOwnership',
                        )}
                      >
                        Promote Selected Files
                      </SimmButton>
                    </div>
                  </div>
                )}
                {localSourceLinkState.stage === 'saving' && (
                  <div className="workspace-inspector-link-panel__step">
                    <h4>Promoting local mod</h4>
                    <p>SIMM is linking the source, importing the current install into Mod Library, and updating this environment to managed ownership.</p>
                  </div>
                )}
              </div>
            )}
            {selectedInstalledMod && (!localSourceLinkState || localSourceLinkState.modId !== `${selectedInstalledMod.fileName}-${selectedInstalledMod.path}`) && (
              <div className="workspace-inspector-card">
                <div className="workspace-inspector-card__header">
                  {renderCardIcon(selectedInstalledMod.name, selectedInstalledMod.iconCachePath, selectedInstalledMod.iconUrl, 'rail')}
                  <div>
                    <h3>{selectedInstalledMod.name}</h3>
                    <div className="workspace-inspector-card__subtle">
                      {getSourceLabel(selectedInstalledMod.source)}
                      {selectedInstalledMod.author ? ` • ${selectedInstalledMod.author}` : ''}
                      {selectedInstalledMod.version ? ` • ${selectedInstalledMod.version}` : ''}
                    </div>
                    <InspectorSecurityScanBadge config={selectedInstalledSecurityBadge} />
                  </div>
                </div>
                <p className="workspace-inspector-card__summary">{selectedInstalledMod.summary || selectedInstalledMod.fileName}</p>
                <div className="workspace-inspector-card__metrics">
                  <div><span>Status</span><strong>{selectedInstalledMod.disabled ? 'Disabled' : 'Enabled'}</strong></div>
                  <div><span>Installed</span><strong>{selectedInstalledMod.version || 'unknown'}</strong></div>
                  <div><span>Latest</span><strong>{getInstalledModLatestVersion(selectedInstalledMod, modUpdates.get(selectedInstalledMod.fileName)) || 'unknown'}</strong></div>
                </div>
                <div className="workspace-inspector-card__actions workspace-inspector-card__actions--grouped">
                  <div className="workspace-inspector-card__action-row workspace-inspector-card__action-row--primary">
                    {selectedInstalledMod.disabled ? (
                      <SimmButton type="button" className="btn btn-primary" onClick={() => void handleEnableMod(selectedInstalledMod)}>
                        <Icon name="fas fa-check" />
                        <span>Enable</span>
                      </SimmButton>
                    ) : (
                      <SimmButton type="button" variant="secondary" className="btn btn-secondary" onClick={() => void handleDisableMod(selectedInstalledMod)}>
                        <Icon name="fas fa-ban" />
                        <span>Disable</span>
                      </SimmButton>
                    )}
                    <SimmButton
                      type="button"
                      variant="secondary"
                      className="btn btn-secondary"
                      onClick={() => void handleUpdateMod(selectedInstalledMod)}
                      disabled={!!getUpdateDisabledReason(
                        selectedInstalledMod,
                        modUpdates.get(selectedInstalledMod.fileName)?.updateAvailable,
                      )}
                      title={getUpdateDisabledReason(
                        selectedInstalledMod,
                        modUpdates.get(selectedInstalledMod.fileName)?.updateAvailable,
                      ) || undefined}
                    >
                      <Icon name="fas fa-arrow-up" />
                      <span>Update</span>
                    </SimmButton>
                    {isLinkableLocalMod(selectedInstalledMod) && (
                      <SimmButton type="button" className="btn btn-primary" onClick={() => openLocalSourceLink(selectedInstalledMod)}>
                        <Icon name="fas fa-plug" />
                        <span>Link Source</span>
                      </SimmButton>
                    )}
                  </div>
                  <div className="workspace-inspector-card__action-row workspace-inspector-card__action-row--secondary">
                    {selectedInstalledMod.modStorageId && selectedInstalledMod.securityScan && (
                      <SimmButton
                        type="button"
                        variant="secondary"
                        className="btn btn-secondary"
                        aria-label="Security Report"
                        onClick={() => void openStoredSecurityReport(selectedInstalledMod.modStorageId!, `Security Report - ${selectedInstalledMod.name}`)}
                      >
                        <Icon name="fas fa-shield-halved" />
                        <span>Report</span>
                      </SimmButton>
                    )}
                    <SimmButton
                      type="button"
                      variant="secondary"
                      className="btn btn-secondary"
                      aria-label={
                        scanningInstalledMod === `${selectedInstalledMod.fileName}-${selectedInstalledMod.path}`
                          ? 'Scanning...'
                          : selectedInstalledMod.securityScan
                            ? 'Rescan Security'
                            : 'Scan Security'
                      }
                      onClick={() => void handleScanInstalledMod(selectedInstalledMod)}
                      disabled={scanningInstalledMod === `${selectedInstalledMod.fileName}-${selectedInstalledMod.path}`}
                    >
                      <Icon name={scanningInstalledMod === `${selectedInstalledMod.fileName}-${selectedInstalledMod.path}` ? 'fas fa-spinner fa-spin' : 'fas fa-shield-alt'} />
                      <span>
                        {scanningInstalledMod === `${selectedInstalledMod.fileName}-${selectedInstalledMod.path}`
                          ? 'Scanning...'
                          : selectedInstalledMod.securityScan
                            ? 'Rescan'
                            : 'Scan'}
                      </span>
                    </SimmButton>
                    {activeModViewSourceUrl && (
                      <SimmButton type="button" variant="secondary" className="btn btn-secondary" aria-label="Open Source Page" onClick={() => openExternalSourceUrl(activeModViewSourceUrl)}>
                        <Icon name="fas fa-arrow-up-right-from-square" />
                        <span>Source</span>
                      </SimmButton>
                    )}
                    <SimmButton type="button" variant="secondary" className="btn btn-secondary" aria-label="Open Folder" onClick={handleOpenFolder}>
                      <Icon name="fas fa-folder-open" />
                      <span>Folder</span>
                    </SimmButton>
                    <SimmButton type="button" variant="secondary" className="btn btn-secondary" aria-label="Open Config" onClick={() => onOpenConfig?.()} disabled={!onOpenConfig}>
                      <Icon name="fas fa-file-lines" />
                      <span>Config</span>
                    </SimmButton>
                    <SimmButton type="button" variant="secondary" className="btn btn-secondary" aria-label="Open in Mod Library" onClick={() => onOpenModLibrary?.()} disabled={!onOpenModLibrary}>
                      <Icon name="fas fa-box-archive" />
                      <span>Library</span>
                    </SimmButton>
                  </div>
                  <div className="workspace-inspector-card__action-row workspace-inspector-card__action-row--danger">
                    <SimmButton type="button" variant="destructive" className="btn btn-danger" aria-label="Uninstall" onClick={() => requestDeleteMod(selectedInstalledMod)}>
                      <Icon name="fas fa-trash" />
                      <span>Uninstall from Environment</span>
                    </SimmButton>
                  </div>
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
