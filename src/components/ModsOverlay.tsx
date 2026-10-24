import {
  useState,
  useEffect,
  useMemo,
  useRef,
  useCallback,
  type KeyboardEvent as ReactKeyboardEvent,
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
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { ApiService } from '../services/api';
import { ConfirmOverlay } from './ConfirmOverlay';
import { ProfileExportDialog } from './ProfileExportDialog';
import {
  SecurityScanReportOverlay,
  type SecurityScanReportOption,
} from './SecurityScanReportOverlay';
import { type SecurityReportWorkspaceRequest } from './SecurityScanReportPage';
import { safeExternalUrl } from './modCardHelpers';
import { ModThumbnail, ThumbnailStack } from './media/ModThumbnail';
import { onModMetadataRefreshStatus, onModsSnapshotUpdated } from '../services/events';
import { AnchoredContextMenu, type AnchoredContextMenuItem } from './AnchoredContextMenu';
import { getSecurityBadgeConfig } from './securityScanHelpers';
import { SimmButton, SimmDialogContent } from './primitives';
import { cn } from '@/lib/utils';
import type {
  Environment,
  LocalModOwnershipCandidate,
  LocalModSourcePreview,
  LocalModSourceVersionOption,
  ModLibraryEntry,
  ModProfileManifest,
  ModProfileItem,
  NexusMod,
  SecurityScanReport,
  SecurityScanSummary,
} from '../types';
import { open, save } from '@tauri-apps/plugin-dialog';
import { Icon } from './Icon';
import { useModLibraryStore } from '../stores/modLibraryStore';

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

function installedModKey(mod: Pick<ModInfo, 'fileName' | 'path'>): string {
  return `${mod.fileName}-${mod.path}`;
}

/** True when a click landed on a control inside a row (switch, button, link), not on the row itself. */
function isInteractiveTarget(target: EventTarget | null, row: HTMLElement): boolean {
  if (!(target instanceof Element)) return false;
  const control = target.closest('button, a, input, select, textarea, [role="switch"], [role="checkbox"]');
  return Boolean(control && row.contains(control));
}

function isEditableKeyboardTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLElement
    && Boolean(target.closest('input, textarea, select, [contenteditable="true"]'));
}

type ModUpdateInfo = {
  updateAvailable: boolean;
  currentVersion?: string;
  latestVersion?: string;
};

type ProfileExportState = {
  isOpen: boolean;
  manifest: ModProfileManifest | null;
  selectedItemKeys: Set<string>;
  profileName: string;
  loading: boolean;
  saving: boolean;
};

const emptyProfileExportState: ProfileExportState = {
  isOpen: false,
  manifest: null,
  selectedItemKeys: new Set(),
  profileName: '',
  loading: false,
  saving: false,
};

function profileItemKey(item: ModProfileItem, index: number): string {
  return [
    item.itemType,
    item.name,
    item.fileName ?? '',
    item.sourceId ?? '',
    item.sourceVersion ?? '',
    index,
  ].join('|');
}

function profileFileName(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return `${slug || 'simm-profile'}.json`;
}

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
  localSourceLinkRequest?: {
    requestId: string;
    fileName: string;
    currentVersion?: string;
  };
}

type LocalSourceLinkStage = 'chooseSource' | 'edit' | 'confirmMismatch' | 'pickOwnership' | 'saving';
type LocalSourceLinkStrategy = 'existing' | 'discovered' | 'manual' | null;
const LOCAL_SOURCE_VERSION_UNSELECTED = '__select-installed-version__';

interface LocalSourceDiscoveryCandidate {
  id: string;
  source: 'nexusmods' | 'thunderstore';
  displayName: string;
  author: string;
  sourceUrl: string;
  latestVersion?: string;
  exactVersion: boolean;
  highConfidence: boolean;
  runtimes: Array<'IL2CPP' | 'Mono'>;
}

interface LocalSourceLinkState {
  modId: string;
  modFileName: string;
  sourceUrl: string;
  sourceUrlTouched: boolean;
  stage: LocalSourceLinkStage;
  strategy: LocalSourceLinkStrategy;
  loadingExistingHint: boolean;
  loadingDiscovery: boolean;
  loadingPreview: boolean;
  loadingOwnership: boolean;
  existingSourceHint?: LocalModSourcePreview | null;
  discoveredSources: LocalSourceDiscoveryCandidate[];
  managementRequestId?: string;
  preview?: LocalModSourcePreview;
  selectedVersion?: string;
  customVersion: string;
  error?: string | null;
  ownershipCandidates: LocalModOwnershipCandidate[];
  selectedOwnershipIds: string[];
}

type ModException = { label: string; tone: 'danger' | 'warn' | 'neutral' };

function sentenceCase(label: string): string {
  return label ? label.charAt(0) + label.slice(1).toLowerCase() : label;
}

/** Security result as a fact for the inspector ("Safe", "Potentially malicious", "Not scanned"). */
function getSecurityLabel(summary?: SecurityScanSummary): string {
  const config = getSecurityBadgeConfig(summary);
  return config ? sentenceCase(config.label) : 'Not scanned';
}

/** Only scan results that need attention become a tag. "Safe" is the default and gets none. */
function getSecurityException(summary?: SecurityScanSummary): ModException | null {
  if (!summary) return null;
  const classification = summary.disposition?.classification;
  if (classification === 'KnownThreat') return { label: 'Known threat', tone: 'danger' };
  if (classification === 'Suspicious') return { label: 'Potentially malicious', tone: 'danger' };
  if (!classification && summary.state === 'review') {
    return { label: summary.highestSeverity ? `${sentenceCase(summary.highestSeverity)} risk` : 'Needs review', tone: 'warn' };
  }
  if (!classification && summary.state === 'unavailable') return { label: 'Scan unavailable', tone: 'neutral' };
  return null;
}

/** Scan results that need a person's decision keep a mod out of bulk updates. */
function isBulkUpdateFlagged(mod: { securityScan?: SecurityScanSummary }): boolean {
  return Boolean(getSecurityBadgeConfig(mod.securityScan)?.exception);
}

function ExceptionTag({ exception }: { exception: ModException | null }) {
  if (!exception) return null;
  return (
    <span
      className={cn(
        'ui-tag',
        exception.tone === 'danger' && 'ui-tag--danger',
        exception.tone === 'warn' && 'ui-tag--warn',
      )}
    >
      {exception.label}
    </span>
  );
}

function formatShortDate(value?: number | string): string | null {
  if (value === undefined || value === null || value === '') return null;
  const numeric = typeof value === 'number' ? value : Number.NaN;
  const date = Number.isFinite(numeric)
    ? new Date(numeric < 1e12 ? numeric * 1000 : numeric)
    : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function EmptyState({
  icon,
  title,
  children,
  actions,
}: {
  icon: string;
  title: string;
  children?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="ui-empty env-assets-empty">
      <span className="ui-empty__emblem" aria-hidden="true"><Icon name={icon} /></span>
      <h3 className="ui-empty__title">{title}</h3>
      {children && <p className="ui-empty__copy">{children}</p>}
      {actions && <div className="env-assets-empty__actions">{actions}</div>}
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
      <SelectTrigger id="local-source-version">
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
      <SelectContent align="start">
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

function stripRuntimeSuffix(name: string): string {
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

function normalizeModNameKey(name: string): string {
  return stripRuntimeSuffix(name)
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, '');
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

function normalizeAuthorKey(value?: string): string {
  return (value || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
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
  const { library: sharedLibrary, ensureLibrary, refreshLibrary } = useModLibraryStore();
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
  const [hasLoadedMods, setHasLoadedMods] = useState(false);
  const [downloadedMods, setDownloadedMods] = useState<ModLibraryEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [, setModsDirectory] = useState<string>('');
  const [, setDeletingMod] = useState<string | null>(null);
  const [enablingMod, setEnablingMod] = useState<string | null>(null);
  const [disablingMod, setDisablingMod] = useState<string | null>(null);
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
  const securityReportOperationRef = useRef(0);
  const [, setToastMessage] = useState<string | null>(null);
  const [profileExport, setProfileExport] = useState<ProfileExportState>(emptyProfileExportState);
  const profileExportOperationRef = useRef(0);

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
  const [updatingMod, setUpdatingMod] = useState<string | null>(null);
  const [updatingAll, setUpdatingAll] = useState(false);
  const [showSearchInOverlay] = useState(() => navigationState?.showSearchInOverlay ?? false);
  const [modListFilter, setModListFilter] = useState<ModListFilter>(() => navigationState?.modListFilter ?? 'all');
  const [modsTab, setModsTab] = useState<ModsTab>(() => navigationState?.modsTab ?? 'installed');
  const [installedSearchTerm, setInstalledSearchTerm] = useState(() => navigationState?.installedSearchTerm ?? '');
  const [activeModView, setActiveModView] = useState<ModViewState | null>(() => navigationState?.activeModView ?? null);
  const [selectedInstalledModKeys, setSelectedInstalledModKeys] = useState<Set<string>>(() => new Set());
  const [bulkModAction, setBulkModAction] = useState<'enable' | 'disable' | 'uninstall' | null>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; items: AnchoredContextMenuItem[] } | null>(null);
  const activeLoadRequestRef = useRef(0);
  const modsScrollContainerRef = useRef<HTMLDivElement | null>(null);
  const modsScrollTopRef = useRef(0);
  const metadataRefreshRunningRef = useRef(false);
  const nexusManualTimeoutRef = useRef<number | null>(null);
  const toastTimeoutRef = useRef<number | null>(null);
  const uploadBatchResultsRef = useRef<ManualUploadBatchResult[]>([]);
  const installedSelectionAnchorRef = useRef<string | null>(null);
  const handledLocalSourceRequestRef = useRef<string | null>(null);
  const navigationChangeHandlerRef = useRef(onNavigationStateChange);
  const [localSourceLinkState, setLocalSourceLinkState] = useState<LocalSourceLinkState | null>(null);
  const [pendingLocalSourceLinkRequest, setPendingLocalSourceLinkRequest] = useState(
    () => navigationState?.localSourceLinkRequest,
  );
  const adjustedProfileManifest = profileExport.manifest ? {
    ...profileExport.manifest,
    profile: {
      ...profileExport.manifest.profile,
      name: profileExport.profileName.trim() || profileExport.manifest.profile.name,
    },
    items: profileExport.manifest.items.filter((item, index) =>
      profileExport.selectedItemKeys.has(profileItemKey(item, index))
    ),
  } : null;
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

  useEffect(() => {
    const request = navigationState?.localSourceLinkRequest;
    if (request && handledLocalSourceRequestRef.current !== request.requestId) {
      setPendingLocalSourceLinkRequest(request);
    }
  }, [navigationState?.localSourceLinkRequest]);
  const loadEnvironment = useCallback(async () => {
    try {
      const env = await ApiService.getEnvironment(environmentId);
      setEnvironment(env);
    } catch (err) {
      console.error('Failed to load environment:', err);
    }
  }, [environmentId]);

  const refreshNexusDownloadAccess = useCallback(async () => {
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
  }, []);

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
    securityReportOperationRef.current += 1;
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

    securityReportOperationRef.current += 1;
    activeSecurityReport?.onDismiss?.();
    setActiveSecurityReport(null);
  };

  const handleSecurityReportConfirm = async () => {
    const request = activeSecurityReport;
    if (!request?.onConfirm) {
      return;
    }

    const operationId = securityReportOperationRef.current;
    setSecurityActionBusy(true);
    try {
      await request.onConfirm();
      if (operationId === securityReportOperationRef.current) {
        setActiveSecurityReport(null);
      }
    } catch (err) {
      if (operationId === securityReportOperationRef.current) {
        setError(err instanceof Error ? err.message : 'Failed to continue after reviewing the MLVScan findings.');
      }
    } finally {
      if (operationId === securityReportOperationRef.current) {
        setSecurityActionBusy(false);
      }
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

  const loadInstalledMods = useCallback(async (showSpinner: boolean = true, refresh: boolean = false) => {
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
      setHasLoadedMods(true);
    } catch (err) {
      if (requestId !== activeLoadRequestRef.current) {
        return;
      }

      if (showSpinner) {
        setError(err instanceof Error ? err.message : 'Failed to load mods');
      } else {
        console.warn('Failed to refresh installed mods:', err);
      }
      setHasLoadedMods(true);
    } finally {
      if (showSpinner && requestId === activeLoadRequestRef.current) {
        setLoading(false);
      }
    }
  }, [environmentId]);

  const loadDownloadedLibrary = useCallback(async () => {
    try {
      const library = sharedLibrary ?? await ensureLibrary();
      setDownloadedMods(library.downloaded || []);
    } catch (err) {
      console.warn('Failed to load downloaded mod library:', err);
    }
  }, [ensureLibrary, sharedLibrary]);

  const refreshDownloadedLibrary = useCallback(async () => {
    try {
      const library = await refreshLibrary();
      setDownloadedMods(library.downloaded || []);
    } catch (err) {
      console.warn('Failed to refresh downloaded mod library:', err);
    }
  }, [refreshLibrary]);

  useEffect(() => {
    if (sharedLibrary) {
      setDownloadedMods(sharedLibrary.downloaded || []);
    }
  }, [sharedLibrary]);

  const loadCachedModUpdates = useCallback(async () => {
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
  }, [environmentId, onModUpdatesChecked]);

  const loadModsPanelData = useCallback(async () => {
    await loadInstalledMods(true, false);
    await loadDownloadedLibrary();
    void loadCachedModUpdates();
  }, [loadCachedModUpdates, loadDownloadedLibrary, loadInstalledMods]);

  useEffect(() => {
    if (isOpen && environmentId) {
      void loadEnvironment();
      void loadModsPanelData();
      void refreshNexusDownloadAccess();

      // Listen for filesystem changes
      let unlistenModsSnapshot: (() => void) | null = null;

      const setupListener = async () => {
        try {
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
            void loadCachedModUpdates();
          });
        } catch (error) {
          console.error('Failed to set up mods changed listener:', error);
        }
      };

      void setupListener();

      return () => {
        activeLoadRequestRef.current += 1;
        if (unlistenModsSnapshot) unlistenModsSnapshot();
      };
    }

    activeLoadRequestRef.current += 1;
  }, [
    environmentId,
    isOpen,
    loadCachedModUpdates,
    loadEnvironment,
    loadInstalledMods,
    loadModsPanelData,
    refreshNexusDownloadAccess,
  ]);

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
  }, [environmentId, isOpen, loadDownloadedLibrary, loadInstalledMods]);

  const openModView = useCallback((nextView: ModViewState) => {
    if (modsScrollContainerRef.current) {
      modsScrollTopRef.current = modsScrollContainerRef.current.scrollTop;
    }
    setActiveModView(nextView);
  }, []);
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
  }, [environmentId, isOpen, loadDownloadedLibrary]);

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
        await refreshDownloadedLibrary();
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
  }, [
    environment?.name,
    environmentId,
    installingNexusMod,
    loadCachedModUpdates,
    refreshDownloadedLibrary,
    loadInstalledMods,
    onModsChanged,
    showToast,
  ]);

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
      await refreshDownloadedLibrary();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to check for mod updates');
    } finally {
      setCheckingModUpdates(false);
    }
  };

  const handleShareProfile = async () => {
    const operationId = ++profileExportOperationRef.current;
    setProfileExport({
      isOpen: true,
      manifest: null,
      selectedItemKeys: new Set(),
      profileName: environment?.name ?? 'SIMM Profile',
      loading: true,
      saving: false,
    });
    try {
      const manifest = await ApiService.exportEnvironmentProfile(environmentId);
      if (operationId !== profileExportOperationRef.current) return;
      setProfileExport({
        isOpen: true,
        manifest,
        selectedItemKeys: new Set(manifest.items.map((item, index) => profileItemKey(item, index))),
        profileName: manifest.profile.name,
        loading: false,
        saving: false,
      });
      setError(null);
    } catch (err) {
      if (operationId !== profileExportOperationRef.current) return;
      setProfileExport(emptyProfileExportState);
      setError(err instanceof Error ? err.message : 'Failed to export profile.');
    }
  };

  const closeProfileExport = useCallback(() => {
    profileExportOperationRef.current += 1;
    setProfileExport(emptyProfileExportState);
  }, []);

  const handleToggleProfileItem = (item: ModProfileItem, index: number, checked: boolean) => {
    const key = profileItemKey(item, index);
    setProfileExport((previous) => {
      const nextKeys = new Set(previous.selectedItemKeys);
      if (checked) {
        nextKeys.add(key);
      } else {
        nextKeys.delete(key);
      }
      return { ...previous, selectedItemKeys: nextKeys };
    });
  };

  const handleSaveProfile = async () => {
    if (!adjustedProfileManifest) return;
    try {
      setProfileExport((previous) => ({ ...previous, saving: true }));
      const destination = await save({
        defaultPath: profileFileName(adjustedProfileManifest.profile.name),
        filters: [{ name: 'SIMM Profile', extensions: ['json'] }],
      });
      if (!destination) return;

      await ApiService.saveModProfileFile(adjustedProfileManifest, destination);
      setProfileExport(emptyProfileExportState);
      showToast(`Profile exported to ${destination}.`);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save profile.');
    } finally {
      setProfileExport((previous) => previous.isOpen ? { ...previous, saving: false } : previous);
    }
  };

  const handleDeleteMod = async (mod: ModInfo) => {
    setDeletingMod(mod.fileName);
    try {
      await ApiService.deleteMod(environmentId, mod.fileName);
      // Reload mods list after deletion
      await loadInstalledMods(false, true);
      await refreshDownloadedLibrary();
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

  const handleUpdateMod = async (mod: ModInfo, securityOverride = false): Promise<void> => {
    setUpdatingMod(mod.fileName);
    setError(null);
    try {
      const result = await ApiService.updateMod(environmentId, mod.fileName, securityOverride);
      if (!result.success) {
        if (handleSecurityGateResponse(
          `Security Findings - ${mod.name}`,
          result,
          () => handleUpdateMod(mod, true),
        )) {
          return;
        }
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
      await refreshDownloadedLibrary();
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
  const handleUpdateAll = async () => {
    const targets = mods.filter((mod) => (
      !getUpdateDisabledReason(mod, modUpdates.get(mod.fileName)?.updateAvailable) && !isBulkUpdateFlagged(mod)
    ));
    if (targets.length === 0) return;
    setUpdatingAll(true);
    try {
      // Sequential on purpose: each update refreshes the installed list and may open a security or Nexus prompt.
      for (const mod of targets) {
        await handleUpdateMod(mod);
      }
    } finally {
      setUpdatingAll(false);
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
      await refreshDownloadedLibrary();
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
        (isArchiveFile(nextItem.fileName) ? normalizeNexusRuntime(environment?.runtime) ?? null : null);

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
        return 'Thunderstore';
      case 'nexusmods':
        return 'Nexus Mods';
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

  const openLocalSourceLink = useCallback((mod: ModInfo, managementRequestId?: string) => {
    const modId = `${mod.fileName}-${mod.path}`;
    setLocalSourceLinkState({
      modId,
      modFileName: mod.fileName,
      sourceUrl: mod.sourceUrl || '',
      sourceUrlTouched: false,
      stage: 'chooseSource',
      strategy: null,
      loadingExistingHint: true,
      loadingDiscovery: true,
      loadingPreview: false,
      loadingOwnership: false,
      existingSourceHint: null,
      discoveredSources: [],
      managementRequestId,
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
          if (!current || current.modId !== modId) {
            return current;
          }
          return {
            ...current,
            loadingExistingHint: false,
            existingSourceHint: hint,
          };
        });
      })
      .catch((err) => {
        setLocalSourceLinkState((current) => {
          if (!current || current.modId !== modId) {
            return current;
          }
          return {
            ...current,
            loadingExistingHint: false,
            existingSourceHint: null,
            error: err instanceof Error ? err.message : 'Failed to load existing source hint.',
          };
        });
      });

    const cleanName = stripRuntimeSuffix(
      (mod.name || mod.fileName).replace(/\.dll(?:\.disabled)?$/i, '').trim(),
    );
    void Promise.allSettled([
      ApiService.searchNexusMods('schedule1', cleanName),
      ApiService.searchThunderstoreByRuntime('schedule-i', cleanName),
    ]).then(([nexusResult, thunderstoreResult]) => {
      const localName = normalizeModNameKey(cleanName);
      const localAuthor = normalizeAuthorKey(mod.author);
      const installedVersion = normalizeVersionToken(mod.version);
      const candidates: LocalSourceDiscoveryCandidate[] = [];

      if (nexusResult.status === 'fulfilled') {
        for (const remote of nexusResult.value.mods as NexusMod[]) {
          if (normalizeModNameKey(remote.name) !== localName) continue;
          const remoteAuthor = normalizeAuthorKey(remote.author || remote.uploader);
          candidates.push({
            id: `nexusmods:${remote.mod_id}`,
            source: 'nexusmods',
            displayName: remote.name,
            author: remote.author || remote.uploader || 'Unknown author',
            sourceUrl: `https://www.nexusmods.com/schedule1/mods/${remote.mod_id}`,
            latestVersion: remote.version,
            exactVersion: !!installedVersion && normalizeVersionToken(remote.version) === installedVersion,
            highConfidence: !!localAuthor && localAuthor === remoteAuthor,
            runtimes: [],
          });
        }
      }

      if (thunderstoreResult.status === 'fulfilled') {
        const byUrl = new Map<string, LocalSourceDiscoveryCandidate>();
        for (const runtime of ['IL2CPP', 'Mono'] as const) {
          for (const remote of (thunderstoreResult.value.packagesByRuntime[runtime] || []) as ThunderstorePackage[]) {
            if (normalizeModNameKey(remote.name) !== localName) continue;
            const remoteAuthor = normalizeAuthorKey(remote.owner);
            const existing = byUrl.get(remote.package_url);
            if (existing) {
              if (!existing.runtimes.includes(runtime)) existing.runtimes.push(runtime);
              existing.exactVersion ||= remote.versions.some(
                (version) => normalizeVersionToken(version.version_number) === installedVersion,
              );
              continue;
            }
            const latestVersion = remote.versions[0]?.version_number;
            byUrl.set(remote.package_url, {
              id: `thunderstore:${remote.uuid4}`,
              source: 'thunderstore',
              displayName: remote.name,
              author: remote.owner,
              sourceUrl: remote.package_url,
              latestVersion,
              exactVersion: !!installedVersion && remote.versions.some(
                (version) => normalizeVersionToken(version.version_number) === installedVersion,
              ),
              highConfidence: !!localAuthor && localAuthor === remoteAuthor,
              runtimes: [runtime],
            });
          }
        }
        candidates.push(...byUrl.values());
      }

      candidates.sort((left, right) => Number(right.highConfidence) - Number(left.highConfidence)
        || Number(right.exactVersion) - Number(left.exactVersion)
        || Number(right.runtimes.includes(environment?.runtime === 'Mono' ? 'Mono' : 'IL2CPP'))
          - Number(left.runtimes.includes(environment?.runtime === 'Mono' ? 'Mono' : 'IL2CPP'))
        || left.displayName.localeCompare(right.displayName));

      setLocalSourceLinkState((current) => current?.modId === modId ? {
        ...current,
        loadingDiscovery: false,
        discoveredSources: candidates,
        error: candidates.length === 0
          && nexusResult.status === 'rejected'
          && thunderstoreResult.status === 'rejected'
          ? 'SIMM could not search Nexus Mods or Thunderstore. You can still enter a source URL.'
          : current.error,
      } : current);
    });
  }, [environment?.runtime, environmentId]);

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

  const selectDiscoveredSource = useCallback((
    mod: ModInfo,
    candidate: LocalSourceDiscoveryCandidate,
  ) => {
    setLocalSourceLinkState((current) => current ? {
      ...current,
      strategy: 'discovered',
      stage: 'edit',
      sourceUrl: candidate.sourceUrl,
      sourceUrlTouched: false,
      preview: undefined,
      selectedVersion: undefined,
      customVersion: '',
      error: null,
    } : current);
    void requestLocalSourcePreview(mod, candidate.sourceUrl);
  }, [requestLocalSourcePreview]);

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
      let requestResolutionError: string | null = null;
      if (localSourceLinkState?.managementRequestId) {
        try {
          await ApiService.resolveModIntegrationRequest(
            localSourceLinkState.managementRequestId,
            true,
          );
        } catch (err) {
          requestResolutionError = getErrorMessage(
            err,
            'SIMM could not close the original management request.',
          );
        }
      }
      showToast(requestResolutionError
        ? 'Mod linked and added to Mod Library; the original request still needs review.'
        : 'Mod linked and added to Mod Library.');
      closeLocalSourceLink();
      await loadInstalledMods(false, true);
      await refreshDownloadedLibrary();
      await loadCachedModUpdates();
      if (requestResolutionError) {
        setError(requestResolutionError);
      }
      onModsChanged?.();
    } catch (err) {
      setLocalSourceLinkState((current) => current ? {
        ...current,
        stage: resumeStage,
        error: err instanceof Error ? err.message : 'Failed to link local mod source.',
      } : current);
    }
  }, [
    closeLocalSourceLink,
    environmentId,
    loadCachedModUpdates,
    refreshDownloadedLibrary,
    loadInstalledMods,
    onModsChanged,
    showToast,
    localSourceLinkState?.managementRequestId,
  ]);

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

  // Mods with an exception scan result (potentially malicious, known threat, needs review, not
  // scannable) are left out of "Update All"; their own Update action goes through the security gate.
  const updatableMods = mods.filter((mod) => !getUpdateDisabledReason(mod, modUpdates.get(mod.fileName)?.updateAvailable));
  const flaggedUpdateCount = updatableMods.filter(isBulkUpdateFlagged).length;
  const totalUpdatesAvailable = updatableMods.length - flaggedUpdateCount;
  const updateAllTitle = flaggedUpdateCount === 0
    ? undefined
    : totalUpdatesAvailable === 0
      ? `Every available update needs a security review. Update ${flaggedUpdateCount === 1 ? 'it' : 'them'} one at a time from the mod's own Update action.`
      : `${flaggedUpdateCount} ${flaggedUpdateCount === 1 ? 'update needs' : 'updates need'} a security review and ${flaggedUpdateCount === 1 ? 'is' : 'are'} not included. Update ${flaggedUpdateCount === 1 ? 'it' : 'them'} from the mod's own Update action.`;

  const filteredMods = useMemo(() => [...mods]
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
    }), [installedSearchTerm, modListFilter, modUpdates, mods, modsTab]);

  const openInstalledModView = useCallback((mod: ModInfo) => {
    const update = modUpdates.get(mod.fileName);
    openModView({
      id: installedModKey(mod),
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
  }, [modUpdates, openModView]);
  const selectedInstalledMods = useMemo(
    () => filteredMods.filter((mod) => selectedInstalledModKeys.has(installedModKey(mod))),
    [filteredMods, selectedInstalledModKeys],
  );
  const selectedInstalledMod = selectedInstalledMods.length === 1 ? selectedInstalledMods[0] : null;

  useEffect(() => {
    const request = pendingLocalSourceLinkRequest;
    if (!isOpen || !request || !hasLoadedMods || handledLocalSourceRequestRef.current === request.requestId) {
      return;
    }
    const mod = mods.find((entry) => entry.fileName === request.fileName);
    handledLocalSourceRequestRef.current = request.requestId;
    setPendingLocalSourceLinkRequest(undefined);
    if (!mod) {
      setError(`The requesting mod ${request.fileName} is no longer installed in this environment.`);
      return;
    }
    const modWithRequestVersion = request.currentVersion && !mod.version
      ? { ...mod, version: request.currentVersion }
      : mod;
    if (modWithRequestVersion !== mod) {
      setMods((current) => current.map((entry) => (
        installedModKey(entry) === installedModKey(mod) ? modWithRequestVersion : entry
      )));
    }
    setModsTab('installed');
    setInstalledSearchTerm('');
    setSelectedInstalledModKeys(new Set([installedModKey(mod)]));
    installedSelectionAnchorRef.current = installedModKey(mod);
    if (mod.managed) {
      void ApiService.resolveModIntegrationRequest(request.requestId, true)
        .then(() => showToast('This mod is already linked to a managed source.'))
        .catch((err) => setError(getErrorMessage(err, 'Failed to complete the management request.')));
      return;
    }
    openLocalSourceLink(modWithRequestVersion, request.requestId);
  }, [
    hasLoadedMods,
    isOpen,
    mods,
    pendingLocalSourceLinkRequest,
    openLocalSourceLink,
    showToast,
  ]);

  useEffect(() => {
    if (!isOpen || !localSourceLinkState) {
      return;
    }
    if (!selectedInstalledMod || installedModKey(selectedInstalledMod) !== localSourceLinkState.modId) {
      setLocalSourceLinkState(null);
    }
  }, [isOpen, localSourceLinkState, selectedInstalledMod]);

  useEffect(() => {
    if (!isOpen || filteredMods.length === 0) {
      setSelectedInstalledModKeys((current) => current.size === 0 ? current : new Set());
      installedSelectionAnchorRef.current = null;
      return;
    }

    const stillValid = activeModView?.kind === 'installed'
      && filteredMods.some((mod) => installedModKey(mod) === activeModView.id);

    setSelectedInstalledModKeys((current) => {
      const visibleKeys = new Set(filteredMods.map(installedModKey));
      const next = new Set([...current].filter((key) => visibleKeys.has(key)));
      if (next.size === 0) {
        next.add(stillValid ? activeModView.id : installedModKey(filteredMods[0]));
      }
      const unchanged = next.size === current.size && [...next].every((key) => current.has(key));
      return unchanged ? current : next;
    });

    if (!stillValid) {
      openInstalledModView(filteredMods[0]);
    }
  }, [activeModView, filteredMods, isOpen, openInstalledModView]);

  const selectInstalledMod = useCallback((
    mod: ModInfo,
    index: number,
    modifiers: { ctrlKey: boolean; metaKey: boolean; shiftKey: boolean },
  ) => {
    const key = installedModKey(mod);
    const additive = modifiers.ctrlKey || modifiers.metaKey;
    setSelectedInstalledModKeys((current) => {
      if (modifiers.shiftKey && installedSelectionAnchorRef.current) {
        const anchorIndex = filteredMods.findIndex((entry) => installedModKey(entry) === installedSelectionAnchorRef.current);
        if (anchorIndex >= 0) {
          const start = Math.min(anchorIndex, index);
          const end = Math.max(anchorIndex, index);
          const next = additive ? new Set(current) : new Set<string>();
          filteredMods.slice(start, end + 1).forEach((entry) => next.add(installedModKey(entry)));
          return next;
        }
      }

      installedSelectionAnchorRef.current = key;
      if (additive) {
        const next = new Set(current);
        if (next.has(key) && next.size > 1) {
          next.delete(key);
        } else {
          next.add(key);
        }
        return next;
      }
      return new Set([key]);
    });
    openInstalledModView(mod);
  }, [filteredMods, openInstalledModView]);

  const handleInstalledModRowKeyDown = useCallback((
    event: ReactKeyboardEvent<HTMLElement>,
    mod: ModInfo,
    index: number,
  ) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    selectInstalledMod(mod, index, event);
  }, [selectInstalledMod]);

  useEffect(() => {
    if (!isOpen || modsTab !== 'installed') return;
    const handleSelectAll = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 'a') return;
      if (isEditableKeyboardTarget(event.target) || filteredMods.length === 0) return;
      event.preventDefault();
      setSelectedInstalledModKeys(new Set(filteredMods.map(installedModKey)));
      installedSelectionAnchorRef.current = installedModKey(filteredMods[0]);
      if (
        activeModView?.kind !== 'installed'
        || !filteredMods.some((mod) => installedModKey(mod) === activeModView.id)
      ) {
        openInstalledModView(filteredMods[0]);
      }
    };
    window.addEventListener('keydown', handleSelectAll);
    return () => window.removeEventListener('keydown', handleSelectAll);
  }, [activeModView, filteredMods, isOpen, modsTab, openInstalledModView]);

  const applySelectedModState = useCallback(async (disabled: boolean) => {
    const targets = selectedInstalledMods.filter((mod) => Boolean(mod.disabled) !== disabled);
    if (targets.length === 0) return;

    setBulkModAction(disabled ? 'disable' : 'enable');
    setError(null);
    const succeeded = new Set<string>();
    const failed: string[] = [];
    try {
      for (const mod of targets) {
        try {
          if (disabled) {
            await ApiService.disableMod(environmentId, mod.fileName);
          } else {
            await ApiService.enableMod(environmentId, mod.fileName);
          }
          succeeded.add(installedModKey(mod));
        } catch {
          failed.push(mod.name);
        }
      }

      if (succeeded.size > 0) {
        setMods((current) => current.map((mod) =>
          succeeded.has(installedModKey(mod)) ? { ...mod, disabled } : mod
        ));
        onModsChanged?.();
      }

      const actionLabel = disabled ? 'disabled' : 'enabled';
      if (failed.length > 0) {
        setError(`${succeeded.size} mod(s) ${actionLabel}; ${failed.length} failed: ${failed.join(', ')}.`);
      } else {
        showToast(`${succeeded.size} selected mod${succeeded.size === 1 ? '' : 's'} ${actionLabel}.`);
      }
    } finally {
      setBulkModAction(null);
    }
  }, [environmentId, onModsChanged, selectedInstalledMods, showToast]);

  const deleteSelectedMods = useCallback(async (targets: ModInfo[]) => {
    if (targets.length === 0) return;
    setBulkModAction('uninstall');
    setError(null);
    const failed: string[] = [];
    const failedKeys = new Set<string>();
    try {
      for (const mod of targets) {
        try {
          await ApiService.deleteMod(environmentId, mod.fileName);
        } catch {
          failed.push(mod.name);
          failedKeys.add(installedModKey(mod));
        }
      }

      await loadInstalledMods(false, true);
      await refreshDownloadedLibrary();
      await loadCachedModUpdates();
      if (failed.length < targets.length) {
        onModsChanged?.();
      }
      setSelectedInstalledModKeys(failedKeys);
      if (failed.length === 0) {
        setActiveModView(null);
        showToast(`${targets.length} selected mod${targets.length === 1 ? '' : 's'} removed from this environment.`);
      } else {
        setError(`${targets.length - failed.length} mod(s) removed; ${failed.length} failed: ${failed.join(', ')}.`);
      }
    } finally {
      setBulkModAction(null);
    }
  }, [environmentId, loadCachedModUpdates, loadInstalledMods, onModsChanged, refreshDownloadedLibrary, showToast]);

  const requestDeleteSelectedMods = useCallback(() => {
    const targets = [...selectedInstalledMods];
    if (targets.length === 0) return;
    const managedCount = targets.filter((mod) => mod.managed || mod.modStorageId).length;
    const unmanagedCount = targets.length - managedCount;
    const consequences = [
      managedCount > 0
        ? `${managedCount} managed install${managedCount === 1 ? '' : 's'} will be removed from this environment while their shared-library downloads are retained.`
        : null,
      unmanagedCount > 0
        ? `${unmanagedCount} local file${unmanagedCount === 1 ? '' : 's'} will be permanently deleted from the Mods folder.`
        : null,
    ].filter(Boolean).join(' ');
    const dialog: ConfirmDialog = {
      title: `Uninstall ${targets.length} Selected Mods?`,
      message: consequences,
      confirmText: `Uninstall ${targets.length} Mods`,
      cancelText: 'Cancel',
      onConfirm: () => deleteSelectedMods(targets),
      readyAt: Date.now() + 200,
    };
    window.setTimeout(() => setConfirmDialog(dialog), 0);
  }, [deleteSelectedMods, selectedInstalledMods]);

  const collapseInstalledSelection = useCallback(() => {
    const activeKey = activeModView?.kind === 'installed' ? activeModView.id : null;
    const retained = selectedInstalledMods.find((mod) => installedModKey(mod) === activeKey)
      ?? selectedInstalledMods[0];
    if (!retained) return;
    const retainedKey = installedModKey(retained);
    installedSelectionAnchorRef.current = retainedKey;
    setSelectedInstalledModKeys(new Set([retainedKey]));
    openInstalledModView(retained);
  }, [activeModView, openInstalledModView, selectedInstalledMods]);

  if (!isOpen) return null;

  const openContextMenu = (event: ReactMouseEvent, items: AnchoredContextMenuItem[]) => {
    event.preventDefault();
    setContextMenu({ x: event.clientX, y: event.clientY, items });
  };

  const openMenuFromTrigger = (event: ReactMouseEvent<HTMLElement>, items: AnchoredContextMenuItem[]) => {
    const rect = event.currentTarget.getBoundingClientRect();
    setContextMenu({ x: rect.left, y: rect.bottom + 4, items });
  };

  const modsFolderActions = (): AnchoredContextMenuItem[] => [
    {
      key: 'scan-local',
      label: scanningLocalMods ? 'Scanning...' : 'Scan Local Mods',
      icon: 'shieldHalved',
      disabled: scanningLocalMods || mods.length === 0,
      onSelect: () => void handleScanLocalInstalledMods(),
    },
    {
      key: 'share-profile',
      label: 'Share Profile',
      icon: 'arrowUpRightFromSquare',
      onSelect: () => void handleShareProfile(),
    },
    {
      key: 'open-folder',
      label: 'Open Folder',
      icon: 'folderOpen',
      onSelect: () => void handleOpenFolder(),
    },
  ];

  const toolbarMoreItems: AnchoredContextMenuItem[] = modsTab === 'updates'
    ? [
      {
        key: 'add-mod',
        label: uploading ? uploadButtonBusyLabel : 'Add Mod',
        icon: 'plus',
        disabled: uploading,
        onSelect: () => void handleUploadClick(),
      },
      ...modsFolderActions(),
    ]
    : modsFolderActions();

  const buildModMenuItems = (mod: ModInfo, options: { includeToggle: boolean }): AnchoredContextMenuItem[] => {
    const modKey = installedModKey(mod);
    const updateDisabledReason = getUpdateDisabledReason(mod, modUpdates.get(mod.fileName)?.updateAvailable);
    const sourceUrl = safeExternalUrl(mod.sourceUrl);
    const items: AnchoredContextMenuItem[] = [];
    if (options.includeToggle) {
      items.push(
        {
          key: mod.disabled ? 'enable' : 'disable',
          label: mod.disabled ? 'Enable' : 'Disable',
          icon: mod.disabled ? 'toggleOn' : 'toggleOff',
          onSelect: () => void (mod.disabled ? handleEnableMod(mod) : handleDisableMod(mod)),
        },
        {
          key: 'update',
          label: 'Update',
          icon: 'arrowUp',
          disabled: !!updateDisabledReason,
          onSelect: () => void handleUpdateMod(mod),
        },
      );
    }
    if (mod.modStorageId && mod.securityScan) {
      items.push({
        key: 'report',
        label: 'Security Report',
        icon: 'shieldHalved',
        onSelect: () => void openStoredSecurityReport(mod.modStorageId!, `Security Report - ${mod.name}`),
      });
    }
    items.push(
      {
        key: 'security',
        label: scanningInstalledMod === modKey ? 'Scanning...' : mod.securityScan ? 'Rescan Security' : 'Scan Security',
        icon: 'shieldAlt',
        disabled: scanningInstalledMod === modKey,
        onSelect: () => void handleScanInstalledMod(mod),
      },
      {
        key: 'source',
        label: 'Open Source Page',
        icon: 'arrowUpRightFromSquare',
        disabled: !sourceUrl,
        onSelect: () => openExternalSourceUrl(mod.sourceUrl),
      },
      {
        key: 'folder',
        label: 'Open Folder',
        icon: 'folderOpen',
        onSelect: () => void handleOpenFolder(),
      },
      {
        key: 'config',
        label: 'Open Config',
        icon: 'slidersH',
        disabled: !onOpenConfig,
        onSelect: () => onOpenConfig?.(),
      },
      {
        key: 'library',
        label: 'Show in Mod Library',
        icon: 'bookOpen',
        disabled: !onOpenModLibrary,
        onSelect: () => onOpenModLibrary?.(),
      },
    );
    if (options.includeToggle) {
      items.push({
        key: 'delete',
        label: 'Uninstall',
        icon: 'trash',
        danger: true,
        onSelect: () => requestDeleteMod(mod),
      });
    }
    return items;
  };

  const updateCount = mods.filter((mod) => !!modUpdates.get(mod.fileName)?.updateAvailable).length;
  const hasActiveFilter = installedSearchTerm.trim() !== '' || (modsTab === 'installed' && modListFilter !== 'all');
  const isMultiSelect = selectedInstalledMods.length > 1;
  const selectedModKey = selectedInstalledMod ? installedModKey(selectedInstalledMod) : null;
  const linkPanelOpen = Boolean(selectedInstalledMod && localSourceLinkState && localSourceLinkState.modId === selectedModKey);

  const renderLinkPanel = (mod: ModInfo, state: LocalSourceLinkState) => (
    <div className="mods-tab-link">
      <div className="mods-tab-link__head">
        <h3 className="mods-tab-link__title">Link mod source</h3>
        <p className="mods-tab-link__copy">
          Connect this local install to its Thunderstore or Nexus Mods page so SIMM can track updates and keep it in Mod Library.
        </p>
      </div>
      <div className="mods-tab-link__subject">
        <strong>{stripRuntimeSuffix(mod.name)}</strong>
        <span className="ui-mono">{mod.fileName}</span>
      </div>
      {state.error && (
        <div className="ui-callout ui-callout--danger" role="alert">{state.error}</div>
      )}
      {state.stage === 'chooseSource' && (
        <div className="mods-tab-link__step">
          <h4 className="mods-tab-link__step-title">Choose the source SIMM should manage</h4>
          <p className="mods-tab-link__copy">
            SIMM keeps the files already installed. Review the matches and pick the right source.
          </p>
          {(state.loadingExistingHint || state.loadingDiscovery) && (
            <div className="mods-tab-link__searching" role="status">
              <Icon name="fas fa-spinner fa-spin" />
              Searching Nexus Mods, Thunderstore, and your Mod Library…
            </div>
          )}
          {!state.loadingExistingHint && state.existingSourceHint && (
            <button
              type="button"
              className="mods-tab-candidate mods-tab-candidate--high"
              onClick={() => {
                const preview = state.existingSourceHint!;
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
              <span className="mods-tab-candidate__top">
                <strong className="ui-truncate">{state.existingSourceHint.displayName}</strong>
                <span className="ui-tag ui-tag--ok">Existing library match</span>
              </span>
              <span className="ui-meta">
                <span>{getSourceLabel(state.existingSourceHint.source)}</span>
                <span>{state.existingSourceHint.author || 'Unknown author'}</span>
              </span>
            </button>
          )}
          {!state.loadingDiscovery && state.discoveredSources.length > 0 && (
            <div className="mods-tab-candidates">
              {state.discoveredSources.map((candidate) => {
                const currentRuntime = environment?.runtime === 'Mono' ? 'Mono' : 'IL2CPP';
                const runtimeMismatch = candidate.runtimes.length > 0
                  && !candidate.runtimes.includes(currentRuntime);
                return (
                  <button
                    key={`${candidate.id}:${candidate.runtimes.join(',')}`}
                    type="button"
                    className={cn('mods-tab-candidate', candidate.highConfidence && 'mods-tab-candidate--high')}
                    onClick={() => selectDiscoveredSource(mod, candidate)}
                  >
                    <span className="mods-tab-candidate__top">
                      <strong className="ui-truncate">{candidate.displayName}</strong>
                      {runtimeMismatch && <span className="ui-tag ui-tag--warn">Different runtime</span>}
                    </span>
                    <span className="ui-meta">
                      <span>{getSourceLabel(candidate.source)}</span>
                      <span>{candidate.author}</span>
                      {candidate.latestVersion && <span>Latest {candidate.latestVersion}</span>}
                      {candidate.runtimes.length > 0 && <span>{candidate.runtimes.join(' + ')}</span>}
                    </span>
                    {(candidate.highConfidence || candidate.exactVersion) && (
                      <span className="mods-tab-candidate__signals">
                        {candidate.highConfidence && <span className="ui-tag ui-tag--ok">Name + author match</span>}
                        {candidate.exactVersion && <span className="ui-tag ui-tag--ok">Installed version found</span>}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          )}
          {!state.loadingDiscovery
            && !state.loadingExistingHint
            && !state.existingSourceHint
            && state.discoveredSources.length === 0 && (
            <p className="mods-tab-link__copy">No provider match was found by name. Enter the source page yourself.</p>
          )}
          <div className="mods-tab-link__actions">
            <SimmButton type="button" variant="ghost" onClick={closeLocalSourceLink}>Cancel</SimmButton>
            <SimmButton
              type="button"
              variant="secondary"
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
              Enter Source URL
            </SimmButton>
          </div>
        </div>
      )}
      {state.stage === 'edit' && (
        <div className="mods-tab-link__step">
          <div className="mods-tab-field">
            <label htmlFor="local-source-url">Source URL</label>
            <Input
              id="local-source-url"
              type="url"
              value={state.sourceUrl}
              placeholder="https://thunderstore.io/... or https://www.nexusmods.com/..."
              readOnly={state.strategy === 'existing' || state.strategy === 'discovered'}
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
                if (state.strategy === 'existing' || state.strategy === 'discovered') {
                  return;
                }
                if (!state.sourceUrlTouched) {
                  return;
                }
                void requestLocalSourcePreview(mod, state.sourceUrl);
              }}
            />
            <span className="mods-tab-field__hint">Paste the full Thunderstore package page or Nexus Mods mod page URL.</span>
          </div>
          <dl className="ui-kv">
            <dt>Source</dt>
            <dd>{state.preview ? getSourceLabel(state.preview.source) : <span className="ui-subtle">Waiting for a source URL</span>}</dd>
            <dt>Remote mod</dt>
            <dd>{state.preview?.displayName || <span className="ui-subtle">Loaded from the source URL</span>}</dd>
            <dt>Author</dt>
            <dd>{state.preview?.author || <span className="ui-subtle">Loaded from the source URL</span>}</dd>
          </dl>
          <div className="mods-tab-field">
            <label htmlFor="local-source-version">Which version do you have installed?</label>
            <LocalSourceVersionSelect
              value={state.selectedVersion || ''}
              preview={state.preview}
              strategy={state.strategy}
              runtime={environment?.runtime}
              loadingPreview={state.loadingPreview}
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
          <div className="mods-tab-field">
            <label htmlFor="local-custom-version">Or enter a custom local version</label>
            <Input
              id="local-custom-version"
              type="text"
              value={state.customVersion}
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
          {state.preview && (() => {
            const versions = getLocalSourceVersionOptions(state.preview.versions, state.strategy, environment?.runtime);
            return (
              <div className="mods-tab-link__versions">
                <h4 className="ui-section-title">
                  Available versions <span className="ui-subtle">({versions.length})</span>
                </h4>
                <p className="mods-tab-link__copy">
                  {state.strategy === 'existing' && environment?.runtime
                    ? `Versions already known for ${environment.runtime}.`
                    : 'Pick the remote version that matches this local install.'}
                </p>
                <div className="mods-tab-versions">
                  {versions.map((version) => (
                    <button
                      key={version.key}
                      type="button"
                      className="mods-tab-version"
                      aria-pressed={state.selectedVersion === version.version}
                      onClick={() => {
                        setLocalSourceLinkState((current) => current ? {
                          ...current,
                          selectedVersion: version.version,
                          customVersion: '',
                          error: null,
                        } : current);
                      }}
                    >
                      <span className="mods-tab-version__top">
                        <span className="ui-mono">{version.version}</span>
                        {version.isLatest && <span className="ui-tag ui-tag--ok">Latest</span>}
                      </span>
                      <span className="ui-meta">
                        {version.runtime && <span>{version.runtime}</span>}
                        <span>{formatShortDate(version.updatedAt) ? `Updated ${formatShortDate(version.updatedAt)}` : 'Update date unknown'}</span>
                        {version.label && <span>{version.label}</span>}
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            );
          })()}
          <div className="mods-tab-link__actions">
            <SimmButton
              type="button"
              variant="ghost"
              onClick={() => {
                if (state.existingSourceHint || state.discoveredSources.length > 0 || state.managementRequestId) {
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
              {state.existingSourceHint || state.discoveredSources.length > 0 || state.managementRequestId ? 'Back' : 'Cancel'}
            </SimmButton>
            <SimmButton
              type="button"
              variant="secondary"
              onClick={() => void continueLocalSourceLink(mod, state)}
              disabled={
                state.loadingPreview
                || state.loadingOwnership
                || !state.preview
                || (!state.selectedVersion && !state.customVersion.trim())
              }
            >
              Continue
            </SimmButton>
          </div>
        </div>
      )}
      {state.stage === 'confirmMismatch' && state.preview && (
        <div className="mods-tab-link__step">
          <h4 className="mods-tab-link__step-title">Confirm source link</h4>
          <p className="mods-tab-link__copy">
            You are linking local mod <strong>{mod.fileName}</strong> to remote mod{' '}
            <strong>{state.preview.displayName}</strong>.
          </p>
          <div className="mods-tab-link__actions">
            <SimmButton
              type="button"
              variant="ghost"
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
              variant="secondary"
              onClick={() => void prepareLocalOwnershipStep(
                mod,
                state.preview!,
                state.customVersion.trim() || state.selectedVersion!,
              )}
            >
              Confirm Link
            </SimmButton>
          </div>
        </div>
      )}
      {state.stage === 'pickOwnership' && state.preview && (
        <div className="mods-tab-link__step">
          <h4 className="mods-tab-link__step-title">Associate additional files</h4>
          <p className="mods-tab-link__copy">
            Select other unowned files that belong to this mod. Skip this step if the current DLL is its only file.
          </p>
          <div className="mods-tab-owners">
            {state.ownershipCandidates.map((candidate) => {
              const checked = state.selectedOwnershipIds.includes(candidate.id);
              return (
                <label key={candidate.id} className="mods-tab-owner">
                  <Checkbox
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
                  <span className="mods-tab-owner__text">
                    <strong className="ui-truncate">{candidate.fileName}</strong>
                    <span className="ui-mono ui-truncate">{candidate.bucket} / {candidate.relativePath}</span>
                  </span>
                </label>
              );
            })}
          </div>
          <div className="mods-tab-link__actions">
            <SimmButton
              type="button"
              variant="ghost"
              onClick={() => {
                setLocalSourceLinkState((current) => current ? {
                  ...current,
                  stage: localModRequiresLinkConfirmation(mod, current.preview!)
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
              variant="outline"
              onClick={() => void promoteLocalSourceLink(
                mod,
                state.preview!,
                state.customVersion.trim() || state.selectedVersion!,
                [],
                'pickOwnership',
              )}
            >
              Skip Extra Files
            </SimmButton>
            <SimmButton
              type="button"
              variant="secondary"
              onClick={() => void promoteLocalSourceLink(
                mod,
                state.preview!,
                state.customVersion.trim() || state.selectedVersion!,
                state.selectedOwnershipIds,
                'pickOwnership',
              )}
            >
              Link Selected Files
            </SimmButton>
          </div>
        </div>
      )}
      {state.stage === 'saving' && (
        <div className="mods-tab-link__step" role="status">
          <h4 className="mods-tab-link__step-title">Linking local mod</h4>
          <p className="mods-tab-link__copy">
            SIMM is linking the source, importing the current install into Mod Library, and switching this environment to the managed copy.
          </p>
        </div>
      )}
    </div>
  );

  const renderModInspector = (mod: ModInfo) => {
    const modKey = installedModKey(mod);
    const updateInfo = modUpdates.get(mod.fileName);
    const updateDisabledReason = getUpdateDisabledReason(mod, updateInfo?.updateAvailable);
    const latestVersion = getInstalledModLatestVersion(mod, updateInfo);
    const securityException = getSecurityException(mod.securityScan);
    const exception: ModException | null = securityException
      ?? (updateInfo?.updateAvailable ? { label: 'Update available', tone: 'warn' } : null)
      ?? (mod.disabled ? { label: 'Disabled', tone: 'neutral' } : null);
    const installedOn = formatShortDate(mod.installedAt);
    const isManagedInstall = Boolean(mod.managed || mod.modStorageId);
    const isUpdating = updatingMod === mod.fileName;
    const isToggling = enablingMod === mod.fileName || disablingMod === mod.fileName;

    return (
      <>
        <div className="env-assets-inspector__head">
          <ModThumbnail iconCachePath={mod.iconCachePath} iconUrl={mod.iconUrl} name={mod.name} size={48} />
          <div className="env-assets-inspector__titles">
            <h3 className="env-assets-inspector__title">{mod.name}</h3>
            <div className="ui-meta">
              <span>{getSourceLabel(mod.source)}</span>
              {mod.author && mod.author !== 'unknown' && <span>{mod.author}</span>}
            </div>
            <div className="env-assets-inspector__status">
              {exception
                ? <ExceptionTag exception={exception} />
                : <span className="ui-status ui-status--ok">Enabled</span>}
            </div>
          </div>
        </div>

        {mod.summary && <p className="env-assets-inspector__summary">{mod.summary}</p>}

        <div className="env-assets-inspector__actions">
          {!updateDisabledReason ? (
            <SimmButton
              type="button"
              variant="secondary"
              onClick={() => void handleUpdateMod(mod)}
              disabled={isUpdating}
            >
              <Icon name={isUpdating ? 'fas fa-spinner fa-spin' : 'arrowUp'} />
              <span>{isUpdating ? 'Updating...' : 'Update'}</span>
            </SimmButton>
          ) : isLinkableLocalMod(mod) ? (
            <SimmButton type="button" variant="secondary" onClick={() => openLocalSourceLink(mod)}>
              <Icon name="plug" />
              <span>Link Source</span>
            </SimmButton>
          ) : null}
          <SimmButton
            type="button"
            variant="outline"
            onClick={() => void (mod.disabled ? handleEnableMod(mod) : handleDisableMod(mod))}
            disabled={isToggling}
          >
            <Icon name={mod.disabled ? 'toggleOn' : 'toggleOff'} />
            <span>{mod.disabled ? 'Enable' : 'Disable'}</span>
          </SimmButton>
          <SimmButton
            type="button"
            variant="ghost"
            size="icon"
            aria-label="More actions"
            aria-haspopup="menu"
            title="More actions"
            onClick={(event) => openMenuFromTrigger(event, buildModMenuItems(mod, { includeToggle: false }))}
          >
            <Icon name="ellipsisH" />
          </SimmButton>
        </div>

        <section className="ui-inspector__section">
          <h4 className="ui-section-title">Details</h4>
          <dl className="ui-kv">
            <dt>Installed</dt>
            <dd className="ui-mono">{mod.version || 'Unknown'}</dd>
            {latestVersion && (
              <>
                <dt>Latest</dt>
                <dd className="ui-mono">{latestVersion}</dd>
              </>
            )}
            <dt>Source</dt>
            <dd>{getSourceLabel(mod.source)}{isManagedInstall ? '' : ' (not managed)'}</dd>
            <dt>Security</dt>
            <dd>{scanningInstalledMod === modKey ? 'Scanning...' : getSecurityLabel(mod.securityScan)}</dd>
            {installedOn && (
              <>
                <dt>Added</dt>
                <dd>{installedOn}</dd>
              </>
            )}
            <dt>File</dt>
            <dd className="ui-mono">{mod.fileName}</dd>
          </dl>
        </section>

        <div className="ui-danger-zone env-assets-danger">
          <SimmButton
            type="button"
            variant="destructive"
            aria-label="Uninstall"
            onClick={() => requestDeleteMod(mod)}
          >
            <Icon name="trash" />
            <span>Uninstall</span>
          </SimmButton>
          <p className="env-assets-danger__note">
            {isManagedInstall
              ? `Removes it from ${environment?.name || 'this environment'}. The Mod Library copy stays.`
              : `Deletes the file from the Mods folder of ${environment?.name || 'this environment'}.`}
          </p>
        </div>
      </>
    );
  };

  const renderMultiSelectInspector = () => {
    const enabledCount = selectedInstalledMods.filter((mod) => !mod.disabled).length;
    const disabledCount = selectedInstalledMods.length - enabledCount;
    return (
      <div className="env-assets-inspector__head">
        <ThumbnailStack
          className="env-assets-inspector__stack"
          size={32}
          items={selectedInstalledMods.map((mod) => ({
            key: installedModKey(mod),
            name: mod.name,
            iconUrl: mod.iconUrl,
            iconCachePath: mod.iconCachePath,
          }))}
        />
        <div className="env-assets-inspector__titles">
          <h3 className="env-assets-inspector__title">{selectedInstalledMods.length} mods selected</h3>
          <div className="ui-meta">
            <span>{enabledCount} enabled</span>
            <span>{disabledCount} disabled</span>
          </div>
          <p className="env-assets-inspector__summary">
            Use the selection bar above the list to enable, disable, or uninstall them together.
          </p>
        </div>
      </div>
    );
  };

  const renderListBody = () => {
    if (loading && mods.length === 0) {
      return (
        <div className="env-assets-skeleton" aria-busy="true" aria-label="Loading mods">
          {Array.from({ length: 6 }, (_, index) => (
            <div key={index} className="env-assets-skeleton__row">
              <Skeleton className="env-assets-skeleton__icon" />
              <div className="env-assets-skeleton__text">
                <Skeleton className="env-assets-skeleton__line" />
                <Skeleton className="env-assets-skeleton__line env-assets-skeleton__line--short" />
              </div>
            </div>
          ))}
        </div>
      );
    }

    if (filteredMods.length === 0) {
      if (error && !hasLoadedMods) return null;
      if (modsTab === 'updates' && !hasActiveFilter) {
        return (
          <EmptyState
            icon="circleCheck"
            title="All mods are up to date"
            actions={(
              <SimmButton type="button" variant="secondary" onClick={handleCheckModUpdates} disabled={checkingModUpdates}>
                {checkingModUpdates ? 'Checking...' : 'Check Updates'}
              </SimmButton>
            )}
          >
            SIMM checks Thunderstore, Nexus Mods, and GitHub for newer versions of the mods it manages. Local mods are not checked until you link their source.
          </EmptyState>
        );
      }
      if (mods.length === 0) {
        return (
          <EmptyState
            icon="puzzlePiece"
            title="No mods in this environment"
            actions={(
              <>
                <SimmButton type="button" variant="secondary" onClick={handleUploadClick} disabled={uploading}>
                  {uploading ? uploadButtonBusyLabel : 'Add Mod File'}
                </SimmButton>
                {onOpenModLibrary && (
                  <SimmButton type="button" variant="ghost" onClick={onOpenModLibrary}>
                    Browse Mod Library
                  </SimmButton>
                )}
              </>
            )}
          >
            Mods are MelonLoader mods loaded from this environment's Mods folder. Install them from Mod Library, or add a .dll or archive you already have.
          </EmptyState>
        );
      }
      return (
        <EmptyState
          icon="search"
          title="No mods match"
          actions={(
            <SimmButton
              type="button"
              variant="secondary"
              onClick={() => {
                setInstalledSearchTerm('');
                setModListFilter('all');
              }}
            >
              Clear Filters
            </SimmButton>
          )}
        >
          Nothing in this list matches the current search or filter.
        </EmptyState>
      );
    }

    return (
      <table className="ui-table env-assets-table">
        <colgroup>
          <col />
          <col className="env-assets-table__col-source env-assets-table__source" />
          <col className="env-assets-table__col-version" />
          <col className="env-assets-table__col-status" />
          <col className="env-assets-table__col-toggle" />
        </colgroup>
        <thead>
          <tr>
            <th scope="col">Name</th>
            <th scope="col" className="env-assets-table__source">Source</th>
            <th scope="col">Version</th>
            <th scope="col">Status</th>
            <th scope="col" className="env-assets-table__toggle">Enabled</th>
          </tr>
        </thead>
        <tbody>
          {filteredMods.map((mod, index) => {
            const updateInfo = modUpdates.get(mod.fileName);
            const modKey = installedModKey(mod);
            const isSelected = selectedInstalledModKeys.has(modKey);
            const exception: ModException | null = getSecurityException(mod.securityScan)
              ?? (updateInfo?.updateAvailable ? { label: 'Update available', tone: 'warn' } : null)
              ?? (mod.disabled ? { label: 'Disabled', tone: 'neutral' } : null);
            const latestVersion = updateInfo?.updateAvailable ? updateInfo.latestVersion : undefined;
            const isToggling = enablingMod === mod.fileName || disablingMod === mod.fileName;
            return (
              <tr
                key={modKey}
                className={cn('ui-row env-assets-row', mod.disabled && 'env-assets-row--disabled')}
                aria-selected={isSelected}
                onClick={(event) => {
                  if (isInteractiveTarget(event.target, event.currentTarget)) return;
                  selectInstalledMod(mod, index, event);
                }}
                onContextMenu={(event) => openContextMenu(event, buildModMenuItems(mod, { includeToggle: true }))}
              >
                <td>
                  <button
                    type="button"
                    className="env-assets-row__open"
                    aria-label={`Open details for ${mod.name}`}
                    aria-pressed={isSelected}
                    onClick={(event) => selectInstalledMod(mod, index, event)}
                    onKeyDown={(event) => handleInstalledModRowKeyDown(event, mod, index)}
                  >
                    <ModThumbnail iconCachePath={mod.iconCachePath} iconUrl={mod.iconUrl} name={mod.name} size={32} />
                    <span className="env-assets-row__text">
                      <span className="env-assets-row__name">{mod.name}</span>
                      <span className="env-assets-row__desc">
                        <span className="env-assets-row__desc-source">{getSourceLabel(mod.source)} · </span>
                        {mod.summary || mod.fileName}
                      </span>
                    </span>
                  </button>
                </td>
                <td className="env-assets-row__muted env-assets-table__source">{getSourceLabel(mod.source)}</td>
                <td className="env-assets-row__version ui-mono">
                  {mod.version || '—'}
                  {latestVersion && latestVersion !== mod.version && (
                    <>
                      <span className="env-assets-row__arrow" aria-hidden="true"> → </span>
                      <span className="env-assets-row__latest">{latestVersion}</span>
                    </>
                  )}
                </td>
                <td><ExceptionTag exception={exception} /></td>
                <td className="env-assets-table__toggle">
                  <Switch
                    checked={!mod.disabled}
                    disabled={isToggling}
                    aria-label={`${mod.name} enabled`}
                    onCheckedChange={(checked) => {
                      void (checked ? handleEnableMod(mod) : handleDisableMod(mod));
                    }}
                  />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
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
              <SimmButton type="button" variant="ghost" size="icon-sm" className="modal-close" onClick={handleRuntimeSelectionCancel} aria-label="Close runtime selection dialog"><Icon name="times" /></SimmButton>
            </DialogHeader>
            <div className="app-dialog__body">
              <DialogDescription>
                Could not determine the runtime for <strong>{pendingRuntimeSelection.fileName}</strong>.
              </DialogDescription>
              <DialogFooter className="app-dialog__footer">
                <SimmButton type="button" variant="secondary" onClick={() => handleRuntimeSelectionConfirm('Mono')}>Mono</SimmButton>
                <SimmButton type="button" variant="secondary" onClick={() => handleRuntimeSelectionConfirm('IL2CPP')}>IL2CPP</SimmButton>
              </DialogFooter>
            </div>
          </SimmDialogContent>
        </Dialog>
      )}

      <div className={`env-assets ui-split${mods.length === 0 && !loading ? ' env-assets--solo' : ''}`}>
        <section className="env-assets__main" aria-label="Mods">
          <div className="env-assets__head">
            <div className="ui-toolbar env-assets__bar">
              <div className="env-assets-segmented" role="group" aria-label="Mods view">
                {([
                  ['installed', 'Installed', mods.length],
                  ['updates', 'Updates', updateCount],
                ] as Array<[ModsTab, string, number]>).map(([tab, label, count]) => (
                  <button
                    key={tab}
                    type="button"
                    className="env-assets-segmented__item"
                    aria-pressed={modsTab === tab}
                    onClick={() => setModsTab(tab)}
                  >
                    {label}
                    <span
                      className={cn(
                        'ui-tabs-line__count',
                        tab === 'updates' && count > 0 && 'ui-tabs-line__count--attention',
                      )}
                    >
                      {count}
                    </span>
                  </button>
                ))}
              </div>
              <span className="ui-toolbar__spacer" />
              <div className="ui-toolbar__group env-assets__actions">
                <SimmButton type="button" variant="secondary" onClick={handleCheckModUpdates} disabled={checkingModUpdates}>
                  <Icon name={checkingModUpdates ? 'fas fa-spinner fa-spin' : 'rotate'} />
                  {checkingModUpdates ? 'Checking...' : 'Check Updates'}
                </SimmButton>
                {modsTab === 'updates' ? (
                  <>
                    {flaggedUpdateCount > 0 && (
                      <span className="env-assets__note" title={updateAllTitle}>
                        {flaggedUpdateCount} {flaggedUpdateCount === 1 ? 'needs' : 'need'} review
                      </span>
                    )}
                    <SimmButton
                      type="button"
                      variant="default"
                      onClick={() => void handleUpdateAll()}
                      disabled={updatingAll || totalUpdatesAvailable === 0}
                      title={updateAllTitle}
                    >
                      <Icon name={updatingAll ? 'fas fa-spinner fa-spin' : 'arrowUp'} />
                      {updatingAll ? 'Updating...' : `Update All (${totalUpdatesAvailable})`}
                    </SimmButton>
                  </>
                ) : (
                  <SimmButton
                    type="button"
                    variant="default"
                    onClick={handleUploadClick}
                    disabled={uploading}
                    title="Add one or more mod files (.dll, .zip, .rar, .7z, .tar.gz, or .tgz)"
                  >
                    <Icon name={uploading ? 'fas fa-spinner fa-spin' : 'plus'} />
                    {uploading ? uploadButtonBusyLabel : 'Add Mod'}
                  </SimmButton>
                )}
                <SimmButton
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label="More mod actions"
                  aria-haspopup="menu"
                  title="More actions"
                  onClick={(event) => openMenuFromTrigger(event, toolbarMoreItems)}
                >
                  <Icon name="ellipsisH" />
                </SimmButton>
              </div>
            </div>

            <div className="ui-toolbar env-assets__filters">
              <div className="env-assets-search">
                <Icon name="search" className="env-assets-search__icon" />
                <Input
                  type="search"
                  value={installedSearchTerm}
                  onChange={(event) => setInstalledSearchTerm(event.target.value)}
                  placeholder={modsTab === 'updates' ? 'Filter updates' : 'Search installed mods'}
                  aria-label={modsTab === 'updates' ? 'Filter updates' : 'Search installed mods'}
                />
              </div>
              {modsTab === 'installed' && (
                <div className="env-assets-segmented env-assets-segmented--quiet" role="group" aria-label="Filter by state">
                  {(['all', 'enabled', 'disabled'] as Array<'all' | 'enabled' | 'disabled'>).map((filter) => (
                    <button
                      key={filter}
                      type="button"
                      className="env-assets-segmented__item"
                      aria-pressed={modListFilter === filter}
                      onClick={() => setModListFilter(filter)}
                    >
                      {filter === 'all' ? 'All' : filter === 'enabled' ? 'Enabled' : 'Disabled'}
                    </button>
                  ))}
                </div>
              )}
            </div>

            {isMultiSelect && (
              <div className="env-assets-bulk" role="toolbar" aria-label="Selected mod actions">
                <div className="env-assets-bulk__summary">
                  <strong>{selectedInstalledMods.length} mods selected</strong>
                  <span>Ctrl-click to add or remove · Shift-click for a range · Ctrl+A selects this list</span>
                </div>
                <div className="ui-toolbar__group">
                  <SimmButton
                    type="button"
                    variant="secondary"
                    size="sm"
                    aria-label="Enable selected mods"
                    onClick={() => void applySelectedModState(false)}
                    disabled={bulkModAction !== null || !selectedInstalledMods.some((mod) => mod.disabled)}
                  >
                    <Icon name={bulkModAction === 'enable' ? 'fas fa-spinner fa-spin' : 'toggleOn'} />
                    Enable
                  </SimmButton>
                  <SimmButton
                    type="button"
                    variant="secondary"
                    size="sm"
                    aria-label="Disable selected mods"
                    onClick={() => void applySelectedModState(true)}
                    disabled={bulkModAction !== null || !selectedInstalledMods.some((mod) => !mod.disabled)}
                  >
                    <Icon name={bulkModAction === 'disable' ? 'fas fa-spinner fa-spin' : 'toggleOff'} />
                    Disable
                  </SimmButton>
                  <SimmButton
                    type="button"
                    variant="destructive"
                    size="sm"
                    aria-label="Uninstall selected mods"
                    onClick={requestDeleteSelectedMods}
                    disabled={bulkModAction !== null}
                  >
                    <Icon name={bulkModAction === 'uninstall' ? 'fas fa-spinner fa-spin' : 'trash'} />
                    Uninstall
                  </SimmButton>
                  <SimmButton
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={collapseInstalledSelection}
                    disabled={bulkModAction !== null}
                  >
                    Clear Selection
                  </SimmButton>
                </div>
              </div>
            )}
          </div>

          <div className="env-assets__content" ref={modsScrollContainerRef}>
            {(uploadBatchSummary || error) && (
              <div className="env-assets__notices">
                {uploadBatchSummary && (
                  <div
                    className={cn('ui-callout', uploadBatchSummary.variant === 'success' ? 'env-assets-callout--ok' : 'ui-callout--warn')}
                    role="status"
                  >
                    {uploadBatchSummary.message}
                  </div>
                )}
                {error && (
                  <div className="ui-callout ui-callout--danger env-assets-error" role="alert">
                    <span className="env-assets-error__text">{error}</span>
                    <span className="ui-toolbar__group">
                      {!hasLoadedMods || mods.length === 0 ? (
                        <SimmButton type="button" variant="outline" size="sm" onClick={() => void loadModsPanelData()}>
                          Retry
                        </SimmButton>
                      ) : null}
                      <SimmButton type="button" variant="ghost" size="sm" onClick={() => setError(null)}>
                        Dismiss
                      </SimmButton>
                    </span>
                  </div>
                )}
              </div>
            )}
            {renderListBody()}
          </div>
        </section>

        <aside className="ui-inspector env-assets__inspector" aria-label="Mod details">
          {isMultiSelect && renderMultiSelectInspector()}
          {!isMultiSelect && !selectedInstalledMod && (
            <div className="ui-empty env-assets-empty env-assets-empty--inspector">
              <p className="ui-empty__copy">Select an installed mod to review details and actions.</p>
            </div>
          )}
          {selectedInstalledMod && linkPanelOpen && localSourceLinkState
            && renderLinkPanel(selectedInstalledMod, localSourceLinkState)}
          {selectedInstalledMod && !linkPanelOpen && renderModInspector(selectedInstalledMod)}
        </aside>
      </div>

      {contextMenu && (
        <AnchoredContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          items={contextMenu.items}
          onClose={() => setContextMenu(null)}
        />
      )}

      <ProfileExportDialog
        open={profileExport.isOpen}
        loading={profileExport.loading}
        saving={profileExport.saving}
        manifest={profileExport.manifest}
        profileName={profileExport.profileName}
        selectedItemKeys={profileExport.selectedItemKeys}
        inputId="mods-profile-export-name"
        saveDisabled={profileExport.loading || profileExport.saving || !adjustedProfileManifest || adjustedProfileManifest.items.length === 0}
        onClose={closeProfileExport}
        onProfileNameChange={(profileName) => setProfileExport((previous) => ({
          ...previous,
          profileName,
        }))}
        onToggleItem={handleToggleProfileItem}
        onSave={() => void handleSaveProfile()}
      />
    </>
  );
}
