import { Suspense, lazy, useState, useEffect, useRef, useCallback } from 'react';
import type { ComponentType } from 'react';
import { save } from '@tauri-apps/plugin-dialog';
import { useEnvironmentStore } from '../stores/environmentStore';
import { useGameLaunchStore, isLaunchPending, type LaunchMethod } from '../stores/gameLaunchStore';
import { useModLibraryStore } from '../stores/modLibraryStore';
import { useSettingsStore } from '../stores/settingsStore';
import type { Environment, MelonLoaderStatus, ModLibraryResult, ModProfileManifest, ModProfileItem } from '../types';
import { AuthenticationModal } from './AuthenticationModal';
import { MessageOverlay } from './MessageOverlay';
import { ConfirmOverlay } from './ConfirmOverlay';
import { AnchoredContextMenu, type AnchoredContextMenuItem } from './AnchoredContextMenu';
import { ProfileExportDialog } from './ProfileExportDialog';
import { ApiService } from '../services/api';
import { buildEnvironmentModSnapshot } from '../services/modLibrarySummary';
import {
  batchUpdateCheckEventName,
  batchUpdateCheckRef,
} from '../services/updateCheckCoordinator';
import { isSteamEnvironment, sortEnvironmentsForDisplay } from '../utils/environmentOrdering';
import { getErrorMessage } from '../utils/errors';
import { Icon } from './Icon';
import {
  Dialog,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { SimmButton, SimmDialogContent } from './primitives';
import { ModIntegrationDialog } from './ModIntegrationDialog';
import { GameArt } from './media/GameArt';
import {
  createAsyncListenerScope,
  onAuthWaiting,
  onAuthSuccess,
  onAuthError,
  onProgress as onProgressEvent,
  onMelonLoaderInstalling,
  onMelonLoaderInstalled,
  onMelonLoaderError,
  onComplete as onCompleteEvent,
  onUpdateAvailable,
  onUpdateCheckComplete,
  onModsSnapshotUpdated,
  onPluginsChanged,
  onUserLibsChanged
} from '../services/events';

type InstalledModsResponse = Awaited<ReturnType<typeof ApiService.getMods>>;

type EnvironmentLocalProbeSnapshot = {
  unmanagedLocalMods: Map<string, number>;
  plugins: Map<string, number>;
  userLibs: Map<string, number>;
  melonLoader: Map<string, MelonLoaderStatus>;
};
type CompletedEnvironmentProbeKey = Pick<Environment, 'id' | 'outputDir' | 'runtime'>;
type ProfileExportState = {
  isOpen: boolean;
  environmentId: string | null;
  manifest: ModProfileManifest | null;
  selectedItemKeys: Set<string>;
  profileName: string;
  loading: boolean;
  saving: boolean;
};

const emptyProfileExportState: ProfileExportState = {
  isOpen: false,
  environmentId: null,
  manifest: null,
  selectedItemKeys: new Set(),
  profileName: '',
  loading: false,
  saving: false,
};

function safeExternalUrl(raw: string | null | undefined): string | undefined {
  if (!raw) return undefined;
  try {
    const u = new URL(raw);
    if (u.protocol !== 'https:') return undefined;
    return u.toString();
  } catch {
    return undefined;
  }
}

function getLatestStableMelonLoaderTag(
  releases: Array<{ tag_name: string; prerelease: boolean; isNightly?: boolean }>
): string | undefined {
  return releases.find((release) => !release.isNightly && !release.prerelease)?.tag_name ?? releases[0]?.tag_name;
}

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

function formatProgressBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = Math.max(0, bytes);
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const precision = value >= 100 || unitIndex === 0 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(precision)} ${units[unitIndex]}`;
}

const dateTimeFormatter = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
});

const dateFormatter = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
});

function formatDateTime(date: Date): string {
  return dateTimeFormatter.format(date);
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : dateFormatter.format(date);
}

function isLinuxMelonLoaderSetupMessage(message: string): boolean {
  const normalized = message.toLowerCase();
  return normalized.includes('protontricks')
    || normalized.includes('proton prerequisite')
    || normalized.includes('steam must')
    || normalized.includes('restart steam')
    || normalized.includes('launch option')
    || normalized.includes('managed shortcut prefix');
}

const lazyNamed = <T,>(
  loader: () => Promise<T>,
  select: (module: T) => ComponentType<any>,
) => lazy(async () => ({
  default: select(await loader()),
}));

const ModsOverlay = lazyNamed(
  () => import('./ModsOverlay'),
  (module) => module.ModsOverlay,
);
const PluginsOverlay = lazyNamed(
  () => import('./PluginsOverlay'),
  (module) => module.PluginsOverlay,
);
const UserLibsOverlay = lazyNamed(
  () => import('./UserLibsOverlay'),
  (module) => module.UserLibsOverlay,
);

function OverlayFallback() {
  return (
    <div className="workspace-panel-fallback" role="status" aria-live="polite">
      <div className="workspace-panel-fallback__header">
        <strong>Loading workspace panel...</strong>
        <span>Getting this workspace ready.</span>
      </div>
    </div>
  );
}

function EnvironmentListSkeleton() {
  return (
    <div className="env-overview env-overview--page env-overview--skeleton" role="status" aria-live="polite" aria-label="Loading environments">
      <span className="loading-skeleton env-skeleton env-skeleton--line" aria-hidden="true" />
      <span className="loading-skeleton env-skeleton env-skeleton--title" aria-hidden="true" />
      {[0, 1, 2, 3, 4].map((index) => (
        <span key={index} className="loading-skeleton env-skeleton env-skeleton--row" aria-hidden="true" />
      ))}
    </div>
  );
}

function countUnmanagedLocalMods(installedMods: InstalledModsResponse | null | undefined): number {
  return (installedMods?.mods || []).filter((mod) => !mod.managed && (mod.source === 'local' || !mod.source)).length;
}

async function loadEnvironmentLocalProbeSnapshot(
  environmentIds: readonly string[],
): Promise<EnvironmentLocalProbeSnapshot> {
  const unmanagedLocalMods = new Map<string, number>();
  const plugins = new Map<string, number>();
  const userLibs = new Map<string, number>();
  const melonLoader = new Map<string, MelonLoaderStatus>();

  // Bound concurrency while removing the previous 4 x N serial IPC chain.
  const concurrency = 3;
  for (let index = 0; index < environmentIds.length; index += concurrency) {
    await Promise.all(environmentIds.slice(index, index + concurrency).map(async (environmentId) => {
      const [installedMods, pluginsResult, userLibsResult, melonLoaderResult] = await Promise.all([
        ApiService.getMods(environmentId, false).catch(() => null),
        ApiService.getPluginsCount(environmentId).catch(() => ({ count: 0 })),
        ApiService.getUserLibsCount(environmentId).catch(() => ({ count: 0 })),
        ApiService.getMelonLoaderStatus(environmentId).catch(() => ({ installed: false })),
      ]);
      unmanagedLocalMods.set(environmentId, countUnmanagedLocalMods(installedMods));
      plugins.set(environmentId, pluginsResult.count);
      userLibs.set(environmentId, userLibsResult.count);
      melonLoader.set(environmentId, melonLoaderResult);
    }));
  }

  return { unmanagedLocalMods, plugins, userLibs, melonLoader };
}

function getCompletedEnvironmentIds(signature: string): string[] {
  return (JSON.parse(signature) as CompletedEnvironmentProbeKey[]).map(({ id }) => id);
}

async function buildEnvironmentCardModSnapshot(
  environmentId: string,
  library: ModLibraryResult | null | undefined,
  refreshInstalledMods: boolean = false,
) {
  const snapshot = buildEnvironmentModSnapshot(library, environmentId);

  try {
    const installedMods = await ApiService.getMods(environmentId, refreshInstalledMods);
    const unmanagedLocalMods = countUnmanagedLocalMods(installedMods);
    return {
      ...snapshot,
      unmanagedLocalMods,
      userMods: snapshot.userMods + unmanagedLocalMods,
    };
  } catch {
    return { ...snapshot, unmanagedLocalMods: 0 };
  }
}

const LAST_ENV_KEY = 'simm:lastEnvId';

const environmentCountCache = {
  unmanagedLocalMods: new Map<string, number>(),
  mods: new Map<string, number>(),
  featuredDownloads: new Map<string, number>(),
  modUpdates: new Map<string, number>(),
  plugins: new Map<string, number>(),
  userLibs: new Map<string, number>(),
  melonLoader: new Map<string, MelonLoaderStatus>(),
};

type MapStateUpdater<T> = Map<string, T> | ((previous: Map<string, T>) => Map<string, T>);

function resolveMapState<T>(previous: Map<string, T>, updater: MapStateUpdater<T>) {
  return typeof updater === 'function' ? updater(previous) : updater;
}

interface EnvironmentListProps {
  onInitialDetectionComplete?: () => void;
  compactMode?: boolean;
  activeWorkspace?: WorkspaceRoute;
  focusedEnvironmentId?: string | null;
  focusedEnvironmentRequestId?: number;
  onOpenWorkspace?: (workspace: Exclude<WorkspaceRoute, { view: 'home' }>) => void;
  onSelectEnvironment?: (environmentId: string) => void;
  /** Render only this environment (the environment workspace's Overview tab). */
  onlyEnvironmentId?: string | null;
}

export type WorkspaceRoute =
  | { view: 'home' }
  | { view: 'environments' }
  | { view: 'profiles'; profileId?: string | null }
  | { view: 'saveBackups' }
  | { view: 'library'; initialTab?: 'discover' | 'library' | 'updates' }
  | { view: 'securityReport' }
  | { view: 'mods'; environmentId: string; initialTab?: 'installed' | 'updates' }
  | { view: 'plugins'; environmentId: string }
  | { view: 'userLibs'; environmentId: string }
  | { view: 'logs'; environmentId: string }
  | { view: 'config'; environmentId: string }
  | { view: 'settings' }
  | { view: 'telemetry' }
  | { view: 'accounts' }
  | { view: 'help' }
  | { view: 'welcome' }
  | { view: 'wizard' };

export function EnvironmentList({
  onInitialDetectionComplete,
  compactMode = false,
  activeWorkspace,
  focusedEnvironmentId,
  focusedEnvironmentRequestId = 0,
  onOpenWorkspace,
  onSelectEnvironment,
  onlyEnvironmentId = null,
}: EnvironmentListProps) {
  const { environments, loading, error, progress, activeGameDownloadId, startDownload, verifyEnvironmentFiles, cancelDownload, deleteEnvironment, checkUpdate, updateEnvironment, refreshGameVersion, ensureEnvironments } = useEnvironmentStore();
  const { attempts: launchAttempts, requestLaunch } = useGameLaunchStore();
  const { library, ensureLibrary, refreshLibrary } = useModLibraryStore();
  const { settings } = useSettingsStore();
  const [authModal, setAuthModal] = useState<{ isOpen: boolean; envId: string | null; waiting: boolean; message?: string; operation?: 'download' | 'verify' }>({ isOpen: false, envId: null, waiting: false });
  const depotOperationRef = useRef<Map<string, 'download' | 'verify'>>(new Map());
  const [editingDescription, setEditingDescription] = useState<string | null>(null);
  const [descriptionValue, setDescriptionValue] = useState<string>('');
  const [editingName, setEditingName] = useState<string | null>(null);
  const [nameValue, setNameValue] = useState<string>('');
  const [checkingEnvironments, setCheckingEnvironments] = useState<Set<string>>(new Set());
  const checkInProgressRef = useRef(false);
  const environmentCardRefs = useRef<Map<string, HTMLElement>>(new Map());
  const [modsOverlay, setModsOverlay] = useState<{ isOpen: boolean; envId: string | null }>({ isOpen: false, envId: null });
  const [pluginsOverlay, setPluginsOverlay] = useState<{ isOpen: boolean; envId: string | null }>({ isOpen: false, envId: null });
  const [userLibsOverlay, setUserLibsOverlay] = useState<{ isOpen: boolean; envId: string | null }>({ isOpen: false, envId: null });
  const [profileExport, setProfileExport] = useState<ProfileExportState>(emptyProfileExportState);
  const profileExportOperationRef = useRef(0);
  const [unmanagedLocalModsCounts, setUnmanagedLocalModsCountsState] = useState<Map<string, number>>(
    () => new Map(environmentCountCache.unmanagedLocalMods),
  );
  const [ensuredLibrary, setEnsuredLibrary] = useState<ModLibraryResult | null>(null);
  const [modsCounts, setModsCountsState] = useState<Map<string, number>>(() => new Map(environmentCountCache.mods));
  const [featuredDownloadCounts, setFeaturedDownloadCountsState] = useState<Map<string, number>>(() => new Map(environmentCountCache.featuredDownloads));
  const [modUpdatesCounts, setModUpdatesCountsState] = useState<Map<string, number>>(() => new Map(environmentCountCache.modUpdates));
  const [pluginsCounts, setPluginsCountsState] = useState<Map<string, number>>(() => new Map(environmentCountCache.plugins));
  const [userLibsCounts, setUserLibsCountsState] = useState<Map<string, number>>(() => new Map(environmentCountCache.userLibs));
  const [melonLoaderStatus, setMelonLoaderStatusState] = useState<Map<string, MelonLoaderStatus>>(() => new Map(environmentCountCache.melonLoader));
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
  const directLaunchSupported = (settings?.platform ?? 'windows') !== 'linux';

  const setUnmanagedLocalModsCounts = useCallback((updater: MapStateUpdater<number>) => {
    setUnmanagedLocalModsCountsState((previous) => {
      const next = resolveMapState(previous, updater);
      environmentCountCache.unmanagedLocalMods = new Map(next);
      return next;
    });
  }, []);

  const setModsCounts = useCallback((updater: MapStateUpdater<number>) => {
    setModsCountsState((previous) => {
      const next = resolveMapState(previous, updater);
      environmentCountCache.mods = new Map(next);
      return next;
    });
  }, []);

  const setFeaturedDownloadCounts = useCallback((updater: MapStateUpdater<number>) => {
    setFeaturedDownloadCountsState((previous) => {
      const next = resolveMapState(previous, updater);
      environmentCountCache.featuredDownloads = new Map(next);
      return next;
    });
  }, []);

  const setModUpdatesCounts = useCallback((updater: MapStateUpdater<number>) => {
    setModUpdatesCountsState((previous) => {
      const next = resolveMapState(previous, updater);
      environmentCountCache.modUpdates = new Map(next);
      return next;
    });
  }, []);

  const setPluginsCounts = useCallback((updater: MapStateUpdater<number>) => {
    setPluginsCountsState((previous) => {
      const next = resolveMapState(previous, updater);
      environmentCountCache.plugins = new Map(next);
      return next;
    });
  }, []);

  const setUserLibsCounts = useCallback((updater: MapStateUpdater<number>) => {
    setUserLibsCountsState((previous) => {
      const next = resolveMapState(previous, updater);
      environmentCountCache.userLibs = new Map(next);
      return next;
    });
  }, []);

  const setMelonLoaderStatus = useCallback((updater: MapStateUpdater<MelonLoaderStatus>) => {
    setMelonLoaderStatusState((previous) => {
      const next = resolveMapState(previous, updater);
      environmentCountCache.melonLoader = new Map(next);
      return next;
    });
  }, []);

  // Debounce timers for filesystem change events
  const pluginsRefreshTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const userLibsRefreshTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const localProbeGenerationRef = useRef(0);
  const localProbeRequestRef = useRef<{
    signature: string;
    promise: Promise<EnvironmentLocalProbeSnapshot>;
    unmanagedLocalModsEpochs: Map<string, number>;
  } | null>(null);
  const unmanagedLocalModsEpochRef = useRef<Map<string, number>>(new Map());
  const libraryBootstrapRequestRef = useRef<Promise<ModLibraryResult> | null>(null);

  // Use refs to access latest environments without causing effect re-runs
  const environmentsRef = useRef(environments);
  useEffect(() => {
    environmentsRef.current = environments;
  }, [environments]);
  const authModalRef = useRef(authModal);
  useEffect(() => {
    authModalRef.current = authModal;
  }, [authModal]);
  const ensureEnvironmentsRef = useRef(ensureEnvironments);
  useEffect(() => {
    ensureEnvironmentsRef.current = ensureEnvironments;
  }, [ensureEnvironments]);
  const settingsRef = useRef(settings);
  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);
  const melonLoaderPrefetchStartedRef = useRef(false);
  const autoInstallMelonLoaderInFlightRef = useRef<Set<string>>(new Set());
  const autoInstallMelonLoaderRef = useRef<((environmentId: string) => Promise<void>) | null>(null);
  const melonLoaderLaunchRepairPromptedRef = useRef<Set<string>>(new Set());
  const [melonLoaderReleases, setMelonLoaderReleases] = useState<Map<string, Array<{
    tag_name: string;
    name: string;
    published_at: string;
    prerelease: boolean;
    isNightly?: boolean;
    download_url: string | null;
    body?: string;
  }>>>(new Map());
  const [loadingMelonLoaderReleases, setLoadingMelonLoaderReleases] = useState<Set<string>>(new Set());
  const [showMelonLoaderVersionSelector, setShowMelonLoaderVersionSelector] = useState<string | null>(null);
  const [showNightlyMelonLoaderBuilds, setShowNightlyMelonLoaderBuilds] = useState(false);
  const [selectedMelonLoaderVersion, setSelectedMelonLoaderVersion] = useState<Map<string, string>>(new Map());
  const [installingMelonLoader, setInstallingMelonLoader] = useState<Set<string>>(new Set());
  const [messageOverlay, setMessageOverlay] = useState<{ isOpen: boolean; title: string; message: string; type: 'success' | 'error' | 'info' }>({ isOpen: false, title: '', message: '', type: 'info' });
  const [confirmOverlay, setConfirmOverlay] = useState<{ isOpen: boolean; title: string; message: string; confirmText?: string; cancelText?: string; onConfirm: () => void }>({ isOpen: false, title: '', message: '', onConfirm: () => {} });
  const [deleteConfirm, setDeleteConfirm] = useState<{ isOpen: boolean; env: Environment | null; deleteFiles: boolean }>({ isOpen: false, env: null, deleteFiles: false });
  const [environmentMenu, setEnvironmentMenu] = useState<{ envId: string; x: number; y: number } | null>(null);
  const [modIntegrationEnvironmentId, setModIntegrationEnvironmentId] = useState<string | null>(null);
  const [copiedPathEnvId, setCopiedPathEnvId] = useState<string | null>(null);
  const [preferredLaunchMethod, setPreferredLaunchMethod] = useState<Map<string, 'steam' | 'direct'>>(() => {
    // Load from localStorage on init
    try {
      const saved = localStorage.getItem('simm-preferred-launch-method');
      if (saved) {
        const parsed = JSON.parse(saved);
        return new Map(Object.entries(parsed));
      }
    } catch {
      // Ignore parse errors
    }
    return new Map();
  });
  const activeGameDownloadName = activeGameDownloadId
    ? environments.find((environment) => environment.id === activeGameDownloadId)?.name ?? 'another environment'
    : null;
  const completedEnvironmentSignature = JSON.stringify(
    environments
      .filter((environment) => environment.status === 'completed')
      .map(({ id, outputDir, runtime }) => ({ id, outputDir, runtime }))
      .sort((left, right) => left.id.localeCompare(right.id)),
  );

  // Save preferred launch method to localStorage when it changes
  useEffect(() => {
    const obj = Object.fromEntries(preferredLaunchMethod);
    localStorage.setItem('simm-preferred-launch-method', JSON.stringify(obj));
  }, [preferredLaunchMethod]);
  const initialDetectionNotifiedRef = useRef(false);
  const lastHandledFocusRequestIdRef = useRef(0);

  useEffect(() => {
    if (
      !focusedEnvironmentId
      || focusedEnvironmentRequestId <= lastHandledFocusRequestIdRef.current
      || compactMode
      || loading
      || error
    ) {
      return;
    }

    const card = environmentCardRefs.current.get(focusedEnvironmentId);
    if (!card) {
      return;
    }

    lastHandledFocusRequestIdRef.current = focusedEnvironmentRequestId;
    if (!onlyEnvironmentId) {
      card.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
    card.focus({ preventScroll: true });
  }, [compactMode, error, focusedEnvironmentId, focusedEnvironmentRequestId, loading, onlyEnvironmentId]);

  const notifyInitialDetectionComplete = useCallback(() => {
    if (initialDetectionNotifiedRef.current) {
      return;
    }
    initialDetectionNotifiedRef.current = true;
    onInitialDetectionComplete?.();
  }, [onInitialDetectionComplete]);

  const rememberEnvironment = useCallback((envId: string) => {
    localStorage.setItem(LAST_ENV_KEY, envId);
  }, []);

  const showMessage = useCallback((title: string, message: string, type: 'success' | 'error' | 'info' = 'info') => {
    setMessageOverlay({ isOpen: true, title, message, type });
  }, []);

  const handleRepairMelonLoaderLaunchOptions = useCallback(async (environmentId: string) => {
    try {
      const result = await ApiService.repairMelonLoaderLaunchOptions(environmentId);
      const statusResult = await ApiService.getMelonLoaderStatus(environmentId);
      setMelonLoaderStatus((previous) => {
        const next = new Map(previous);
        next.set(environmentId, statusResult);
        return next;
      });

      const shortcutReload = result.shortcut?.requiresClientReload
        ? ' Fully restart Steam once before launching this shortcut.'
        : '';
      const prerequisiteMessage = result.linuxPrerequisiteMessage
        ? ` ${result.linuxPrerequisiteMessage}`
        : '';
      showMessage(
        'Linux MelonLoader Setup Updated',
        `SIMM configured the required Proton setup for MelonLoader.${prerequisiteMessage}${shortcutReload}`,
        'success',
      );
    } catch (err) {
      const errorMessage = getErrorMessage(err, 'Failed to configure Linux MelonLoader setup');
      showMessage(
        'Linux MelonLoader Setup Failed',
        errorMessage,
        'error',
      );
    }
  }, [setMelonLoaderStatus, showMessage]);

  useEffect(() => {
    if (confirmOverlay.isOpen) {
      return;
    }

    const environment = environments.find((env) => {
      const status = melonLoaderStatus.get(env.id);
      return env.status === 'completed'
        && status?.installed
        && status.linuxRequirements?.needsSteamLaunchOptionsRepair
        && status.linuxRequirements?.steamLaunchOptionsRepairable
        && !melonLoaderLaunchRepairPromptedRef.current.has(env.id);
    });

    if (!environment) {
      return;
    }

    melonLoaderLaunchRepairPromptedRef.current.add(environment.id);
    setConfirmOverlay({
      isOpen: true,
      title: 'Repair Steam Launch Options',
      message: `MelonLoader is installed for ${environment.name}, but Steam is missing the required Proton launch option. Allow SIMM to update Steam's Schedule I launch options now.`,
      confirmText: 'Repair',
      onConfirm: () => {
        void handleRepairMelonLoaderLaunchOptions(environment.id);
      },
    });
  }, [confirmOverlay.isOpen, environments, handleRepairMelonLoaderLaunchOptions, melonLoaderStatus]);

  const resetDeleteConfirm = useCallback(() => {
    setDeleteConfirm({ isOpen: false, env: null, deleteFiles: false });
  }, []);

  const handleStartDownload = async (env: Environment) => {
    try {
      if (activeGameDownloadId && activeGameDownloadId !== env.id) {
        showMessage('Game Operation In Progress', `${activeGameDownloadName ?? 'Another environment'} is already downloading, updating, or being verified. Wait for it to finish before starting ${env.name}.`, 'info');
        return;
      }
      rememberEnvironment(env.id);
      depotOperationRef.current.set(env.id, 'download');
      // Check if we have credentials
      const hasCredentials = settings?.steamUsername;

      if (!hasCredentials) {
        // Show authentication modal
        setAuthModal({ isOpen: true, envId: env.id, waiting: false, operation: 'download' });
        return;
      }

      // Try to start download
      await startDownload(env.id);
    } catch (err: any) {
      // Check if error indicates authentication is required
      if (err?.response?.data?.requiresAuth || err?.message?.includes('authentication')) {
        setAuthModal({ isOpen: true, envId: env.id, waiting: false, operation: 'download' });
      } else {
        showMessage('Download Failed', `Failed to start download: ${err instanceof Error ? err.message : 'Unknown error'}`, 'error');
      }
    }
  };

  const handleVerifyEnvironmentFiles = async (env: Environment) => {
    try {
      if (activeGameDownloadId) {
        showMessage(
          'Game Operation In Progress',
          `${activeGameDownloadName ?? 'Another environment'} is already downloading, updating, or being verified. Wait for it to finish before verifying ${env.name}.`,
          'info',
        );
        return;
      }

      rememberEnvironment(env.id);
      depotOperationRef.current.set(env.id, 'verify');
      if (!settings?.steamUsername) {
        setAuthModal({ isOpen: true, envId: env.id, waiting: false, operation: 'verify' });
        return;
      }

      await verifyEnvironmentFiles(env.id);
    } catch (err: any) {
      if (err?.response?.data?.requiresAuth || err?.message?.toLowerCase().includes('authentication')) {
        setAuthModal({ isOpen: true, envId: env.id, waiting: false, operation: 'verify' });
      } else {
        depotOperationRef.current.delete(env.id);
        showMessage('Verification Failed', `Failed to start game file verification: ${err instanceof Error ? err.message : 'Unknown error'}`, 'error');
      }
    }
  };

  const handleVerifyRequest = (env: Environment) => {
    setConfirmOverlay({
      isOpen: true,
      title: `Verify Game Files: ${env.name}`,
      message: 'DepotDownloader will compare this environment with its selected Steam branch and reacquire missing or damaged official game files. Mods, Plugins, UserLibs, and other files that are not part of the Steam depot will remain in place. Close Schedule I before continuing.',
      confirmText: 'Verify Files',
      onConfirm: () => {
        setConfirmOverlay({ isOpen: false, title: '', message: '', onConfirm: () => {} });
        void handleVerifyEnvironmentFiles(env);
      },
    });
  };

  const handleAuthenticated = async (credentials: { username: string; password: string; steamGuard: string; saveCredentials: boolean }) => {
    const environmentId = authModal.envId;
    if (!environmentId) return;
    const operation = authModal.operation ?? depotOperationRef.current.get(environmentId) ?? 'download';

    // Switch to waiting state
    setAuthModal(prev => ({ ...prev, waiting: true, message: 'Authenticating with Steam...' }));

    try {
      // Authenticate first (this stores session via -remember-password)
      // Authentication is handled in the modal's handleSubmit, so by the time we get here,
      // authentication should be complete. Now start the download.
      setAuthModal(prev => ({
        ...prev,
        waiting: true,
        message: operation === 'verify' ? 'Starting game file verification...' : 'Starting download...',
      }));
      if (operation === 'verify') {
        await verifyEnvironmentFiles(environmentId, credentials);
      } else {
        await startDownload(environmentId, credentials);
      }
      // Close modal - download started
      setAuthModal({ isOpen: false, envId: null, waiting: false });
    } catch (err) {
      setAuthModal(prev => ({ ...prev, waiting: false }));
      showMessage(
        operation === 'verify' ? 'Verification Failed' : 'Download Failed',
        operation === 'verify'
          ? `Failed to start game file verification: ${err instanceof Error ? err.message : 'Unknown error'}`
          : `Failed to start download: ${err instanceof Error ? err.message : 'Unknown error'}`,
        'error',
      );
    }
  };

  // Listen for Tauri auth events and password prompts
  useEffect(() => {
    const listeners = createAsyncListenerScope((error) => {
      console.error('Failed to set up event listener:', error);
    });

    const handleBatchUpdateCheckStarted = (event: Event) => {
      const customEvent = event as CustomEvent<{ environmentIds?: string[] }>;
      const environmentIds = customEvent.detail?.environmentIds ?? [];
      setCheckingEnvironments(new Set(environmentIds));
      checkInProgressRef.current = environmentIds.length > 0;
    };

    window.addEventListener(batchUpdateCheckEventName, handleBatchUpdateCheckStarted as EventListener);

        listeners.register(() => onAuthWaiting((data) => {
          const env = environmentsRef.current.find(e => e.id === data.downloadId);
          if (env && authModalRef.current.envId === data.downloadId) {
            setAuthModal(prev => ({ ...prev, waiting: true, message: data.message }));
          }
        }));

        listeners.register(() => onAuthSuccess((data) => {
          if (data.downloadId === authModalRef.current.envId) {
            setAuthModal({ isOpen: false, envId: null, waiting: false });
          }
        }));

        listeners.register(() => onAuthError((data) => {
          const env = environmentsRef.current.find(e => e.id === data.downloadId);
          if (data.error.toLowerCase().includes('password') || data.error.toLowerCase().includes('credential')) {
            if (env && !authModalRef.current.isOpen) {
              setAuthModal({ isOpen: true, envId: data.downloadId, waiting: false, operation: depotOperationRef.current.get(data.downloadId) ?? 'download' });
            } else if (authModalRef.current.envId === data.downloadId) {
              setAuthModal(prev => ({ ...prev, waiting: false }));
            }
          } else if (authModalRef.current.envId === data.downloadId) {
            setAuthModal(prev => ({ ...prev, waiting: false }));
            showMessage('Authentication Failed', data.error, 'error');
          }
        }));

        listeners.register(() => onProgressEvent((progress) => {
          if (progress.error && (progress.error.toLowerCase().includes('password') ||
              progress.message?.toLowerCase().includes('enter account password'))) {
            const env = environmentsRef.current.find(e => e.id === progress.downloadId);
            if (env && !authModalRef.current.isOpen) {
              setAuthModal({ isOpen: true, envId: progress.downloadId, waiting: false, operation: progress.operation ?? depotOperationRef.current.get(progress.downloadId) ?? 'download' });
            }
          }
        }));

        listeners.register(() => onMelonLoaderInstalling((data) => {
          const env = environmentsRef.current.find(e => e.id === data.environmentId);
          if (env) {
            setInstallingMelonLoader((previous) => new Set(previous).add(data.environmentId));
            console.log(`MelonLoader installing for ${data.environmentId}: ${data.message}`);
          }
        }));

        listeners.register(() => onMelonLoaderInstalled(async (data) => {
          const env = environmentsRef.current.find(e => e.id === data.environmentId);
          if (env) {
            console.log(`MelonLoader installed for ${data.environmentId}: ${data.message}`);
            try {
              const statusResult = await ApiService.getMelonLoaderStatus(data.environmentId);
              setMelonLoaderStatus(prev => {
                const next = new Map(prev);
                next.set(data.environmentId, { ...statusResult, version: statusResult.version || data.version });
                return next;
              });
            } catch (err) {
              console.error('Failed to refresh MelonLoader status:', err);
            } finally {
              setInstallingMelonLoader((previous) => {
                const next = new Set(previous);
                next.delete(data.environmentId);
                return next;
              });
            }
          }
        }));

        listeners.register(() => onMelonLoaderError((data) => {
          const env = environmentsRef.current.find(e => e.id === data.environmentId);
          if (env) {
            setInstallingMelonLoader((previous) => {
              const next = new Set(previous);
              next.delete(data.environmentId);
              return next;
            });
            showMessage(
              isLinuxMelonLoaderSetupMessage(data.message)
                ? 'Linux MelonLoader Setup Failed'
                : 'MelonLoader Install Failed',
              data.message,
              'error',
            );
          }
        }));

        listeners.register(() => onCompleteEvent(async ({ downloadId, operation }) => {
          const env = environmentsRef.current.find(e => e.id === downloadId);
          const resolvedOperation = operation ?? depotOperationRef.current.get(downloadId) ?? 'download';
          depotOperationRef.current.delete(downloadId);
          if (resolvedOperation === 'verify') {
            if (env) {
              showMessage(
                'Game Files Verified',
                `${env.name} now matches its selected Steam branch. Any missing or damaged official game files were reacquired; non-depot mod files were left in place.`,
                'success',
              );
            }
            return;
          }
          if (env) {
            void autoInstallMelonLoaderRef.current?.(downloadId);
          }
          if (env && env.updateAvailable) {
            setTimeout(async () => {
              try {
                const updatedEnvs = await ensureEnvironmentsRef.current();
                const updatedEnv = updatedEnvs.find(e => e.id === downloadId);
                if (updatedEnv) {
                  // Use ConfirmOverlay instead of blocking confirm()
                  setConfirmOverlay({
                    isOpen: true,
                    title: 'Branch Updated',
                    message: 'The branch update completed successfully. Choose whether to update its description to explain what this version is for.',
                    confirmText: 'Update Description',
                    cancelText: 'Keep Current Description',
                    onConfirm: () => {
                      setEditingDescription(downloadId);
                      setDescriptionValue(updatedEnv.description || '');
                      setConfirmOverlay({ isOpen: false, title: '', message: '', onConfirm: () => {} });
                    }
                  });
                }
              } catch (err) {
                console.warn('Failed to prompt for description update:', err);
              }
            }, 1000);
          }
        }));

        const handleUpdateCheckStart = () => {
          const now = Date.now();
          const checkIntervalMs = (settingsRef.current?.updateCheckInterval || 60) * 60 * 1000;
          const dueEnvironmentIds = environmentsRef.current
            .filter(env => {
              if (env.status !== 'completed') return false;
              if (!env.lastUpdateCheck) return true;

              const lastCheckMs = typeof env.lastUpdateCheck === 'number'
                ? env.lastUpdateCheck * 1000
                : new Date(env.lastUpdateCheck).getTime();

              if (Number.isNaN(lastCheckMs)) return true;
              return now - lastCheckMs >= checkIntervalMs;
            })
            .map(env => env.id);

          setCheckingEnvironments(new Set(dueEnvironmentIds));

          if (dueEnvironmentIds.length === 0) {
            checkInProgressRef.current = false;
          }
        };

        const handleFirstUpdateEvent = () => {
          if (!checkInProgressRef.current && batchUpdateCheckRef.current) {
            checkInProgressRef.current = true;
            handleUpdateCheckStart();
          }
        };

        const handleUpdateEventComplete = (data: { environmentId: string }) => {
          setCheckingEnvironments(prev => {
            const next = new Set(prev);
            next.delete(data.environmentId);
            if (next.size === 0) {
              checkInProgressRef.current = false;
            }
            return next;
          });
        };

        listeners.register(() => onUpdateAvailable((data) => {
          handleFirstUpdateEvent();
          handleUpdateEventComplete({ environmentId: data.environmentId });
        }));

        listeners.register(() => onUpdateCheckComplete((data) => {
          handleFirstUpdateEvent();
          handleUpdateEventComplete({ environmentId: data.environmentId });
        }));

        listeners.register(() => onModsSnapshotUpdated((data) => {
          const environment = environmentsRef.current.find(({ id }) => id === data.environmentId);
          if (environment?.status !== 'completed') {
            return;
          }

          const nextEpochs = new Map(unmanagedLocalModsEpochRef.current);
          nextEpochs.set(data.environmentId, (nextEpochs.get(data.environmentId) ?? 0) + 1);
          unmanagedLocalModsEpochRef.current = nextEpochs;
          setUnmanagedLocalModsCounts((previous) => {
            const next = new Map(previous);
            next.set(data.environmentId, countUnmanagedLocalMods(data.snapshot));
            return next;
          });
        }));

        listeners.register(() => onPluginsChanged((data) => {
          // Use ref to get latest environments without causing effect dependency
          const env = environmentsRef.current.find(e => e.id === data.environmentId);
          if (env && env.status === 'completed') {
            // Clear existing timer for this environment
            const existingTimer = pluginsRefreshTimers.current.get(data.environmentId);
            if (existingTimer) {
              clearTimeout(existingTimer);
            }

            // Set new timer to refresh count after 500ms of no events
            const timer = setTimeout(async () => {
              try {
                const result = await ApiService.getPluginsCount(data.environmentId);
                // Only update the count state - no other side effects
                setPluginsCounts(prev => {
                  const next = new Map(prev);
                  next.set(data.environmentId, result.count);
                  return next;
                });
              } catch (err) {
                console.error('Failed to refresh plugins count:', err);
              } finally {
                pluginsRefreshTimers.current.delete(data.environmentId);
              }
            }, 500);

            pluginsRefreshTimers.current.set(data.environmentId, timer);
          }
        }));

        listeners.register(() => onUserLibsChanged((data) => {
          // Use ref to get latest environments without causing effect dependency
          const env = environmentsRef.current.find(e => e.id === data.environmentId);
          if (env && env.status === 'completed') {
            // Clear existing timer for this environment
            const existingTimer = userLibsRefreshTimers.current.get(data.environmentId);
            if (existingTimer) {
              clearTimeout(existingTimer);
            }

            // Set new timer to refresh count after 500ms of no events
            const timer = setTimeout(async () => {
              try {
                const result = await ApiService.getUserLibsCount(data.environmentId);
                // Only update the count state - no other side effects
                setUserLibsCounts(prev => {
                  const next = new Map(prev);
                  next.set(data.environmentId, result.count);
                  return next;
                });
              } catch (err) {
                console.error('Failed to refresh userlibs count:', err);
              } finally {
                userLibsRefreshTimers.current.delete(data.environmentId);
              }
            }, 500);

            userLibsRefreshTimers.current.set(data.environmentId, timer);
          }
        }));

      const pluginsRefreshTimerMap = pluginsRefreshTimers.current;
    const userLibsRefreshTimerMap = userLibsRefreshTimers.current;

    return () => {
      window.removeEventListener(batchUpdateCheckEventName, handleBatchUpdateCheckStarted as EventListener);
      listeners.dispose();

      // Clear all debounce timers
      pluginsRefreshTimerMap.forEach(timer => clearTimeout(timer));
      userLibsRefreshTimerMap.forEach(timer => clearTimeout(timer));
      pluginsRefreshTimerMap.clear();
      userLibsRefreshTimerMap.clear();
    };
  }, [
    setMelonLoaderStatus,
    setPluginsCounts,
    setUnmanagedLocalModsCounts,
    setUserLibsCounts,
    showMessage,
  ]);

  const handleCancelDownload = async (env: Environment) => {
    try {
      await cancelDownload(env.id);
      depotOperationRef.current.delete(env.id);
    } catch (err) {
      showMessage('Cancel Failed', `Failed to cancel download: ${err instanceof Error ? err.message : 'Unknown error'}`, 'error');
    }
  };

  const handleDelete = (env: Environment) => {
    setDeleteConfirm({ isOpen: true, env, deleteFiles: false });
  };

  const handleConfirmDelete = async () => {
    if (!deleteConfirm.env) return;
    const env = deleteConfirm.env;
    const deleteFiles = deleteConfirm.deleteFiles;
    resetDeleteConfirm();

    try {
      await deleteEnvironment(env.id, deleteFiles);
    } catch (err) {
      setMessageOverlay({
        isOpen: true,
        title: 'Delete Failed',
        message: `Failed to delete game install: ${err instanceof Error ? err.message : 'Unknown error'}`,
        type: 'error'
      });
    }
  };

  const handleUpdate = async (env: Environment) => {
    // For Steam environments, show message that Steam handles updates
    if (isSteamEnvironment(env)) {
      showMessage('Steam Manages Updates', 'Steam manages updates for this installation. Please update it through Steam.', 'info');
      return;
    }
    // Start the download to update to the latest version
    await handleStartDownload(env);
  };

  const handleUpdateAction = async (env: Environment) => {
    if (checkingEnvironments.has(env.id)) {
      return;
    }

    if (activeGameDownloadId && activeGameDownloadId !== env.id) {
      showMessage('Game Operation In Progress', `${activeGameDownloadName ?? 'Another environment'} is already downloading or updating. Wait for it to finish before starting ${env.name}.`, 'info');
      return;
    }

    rememberEnvironment(env.id);

    if (env.updateAvailable) {
      await handleUpdate(env);
      return;
    }

    if (isSteamEnvironment(env)) {
      showMessage('Steam Manages Updates', 'Steam manages updates for this installation. Please update it through Steam.', 'info');
      return;
    }

    batchUpdateCheckRef.current = false;
    setCheckingEnvironments(prev => new Set(prev).add(env.id));

    try {
      await checkUpdate(env.id, true);

      const refreshedEnv = environmentsRef.current.find(candidate => candidate.id === env.id);
      if (refreshedEnv?.updateAvailable) {
        await handleUpdate(refreshedEnv);
        return;
      }

      showMessage('No Update Available', 'No update is currently available for this environment.', 'info');
    } catch (err) {
      console.error(`Failed to update ${env.id}:`, err);
    } finally {
      setCheckingEnvironments(prev => {
        const next = new Set(prev);
        next.delete(env.id);
        return next;
      });
    }
  };

  const handleStartEditDescription = (env: Environment) => {
    setEditingDescription(env.id);
    setDescriptionValue(env.description || '');
  };

  const handleSaveDescription = async (envId: string) => {
    try {
      await updateEnvironment(envId, { description: descriptionValue.trim() || undefined });
      setEditingDescription(null);
      setDescriptionValue('');
    } catch (err) {
      showMessage('Description Save Failed', `Failed to save description: ${err instanceof Error ? err.message : 'Unknown error'}`, 'error');
    }
  };

  const handleCancelEditDescription = () => {
    setEditingDescription(null);
    setDescriptionValue('');
  };

  const handleStartEditName = (env: Environment) => {
    setEditingName(env.id);
    setNameValue(env.name);
  };

  const handleSaveName = async (envId: string) => {
    try {
      const trimmedName = nameValue.trim();
      if (!trimmedName) {
        showMessage('Name Required', 'Environment name cannot be empty.', 'info');
        return;
      }
      await updateEnvironment(envId, { name: trimmedName });
      setEditingName(null);
      setNameValue('');
    } catch (err) {
      showMessage('Name Save Failed', `Failed to save name: ${err instanceof Error ? err.message : 'Unknown error'}`, 'error');
    }
  };

  const handleCancelEditName = () => {
    setEditingName(null);
    setNameValue('');
  };

  const handleOpenFolder = async (env: Environment) => {
    try {
      await ApiService.openFolder(env.id);
    } catch (err) {
      showMessage('Open Folder Failed', `Failed to open folder: ${err instanceof Error ? err.message : 'Unknown error'}`, 'error');
    }
  };

  const handleLaunchGame = (environment: Environment, method: LaunchMethod = 'steam') => requestLaunch(environment, method);

  const loadMelonLoaderReleases = useCallback(async (envId: string, includeNightly = false) => {
    setLoadingMelonLoaderReleases(prev => new Set(prev).add(envId));
    try {
      const releases = await ApiService.getMelonLoaderReleases(envId, includeNightly);
      setMelonLoaderReleases(prev => {
        const next = new Map(prev);
        next.set(envId, releases);
        return next;
      });
      const latestStableTag = getLatestStableMelonLoaderTag(releases);

      if (releases.length > 0) {
        const defaultVersion = latestStableTag ?? releases[0].tag_name;
        setSelectedMelonLoaderVersion(prev => {
          const next = new Map(prev);
          next.set(envId, defaultVersion);
          return next;
        });
      }
      return true;
    } catch (err) {
      console.error('Failed to load MelonLoader releases:', err);
      setMessageOverlay({
        isOpen: true,
        title: 'Error',
        message: includeNightly
          ? 'Failed to load MelonLoader nightly builds. Stable releases remain available.'
          : 'Failed to load MelonLoader releases',
        type: 'error'
      });
      return false;
    } finally {
      setLoadingMelonLoaderReleases(prev => {
        const next = new Set(prev);
        next.delete(envId);
        return next;
      });
    }
  }, []);

  // Hydrate the shared library once when this workspace is the first library consumer.
  // A later shared-library identity change is handled by the pure derivation below.
  useEffect(() => {
    const completedEnvironmentIds = getCompletedEnvironmentIds(completedEnvironmentSignature);
    if (library || loading || error || completedEnvironmentIds.length === 0) {
      return;
    }

    let disposed = false;
    let request = libraryBootstrapRequestRef.current;
    if (!request) {
      request = ensureLibrary();
      libraryBootstrapRequestRef.current = request;
      void request.then(
        () => {
          if (libraryBootstrapRequestRef.current === request) {
            libraryBootstrapRequestRef.current = null;
          }
        },
        () => {
          if (libraryBootstrapRequestRef.current === request) {
            libraryBootstrapRequestRef.current = null;
          }
        },
      );
    }

    void request.then((snapshot) => {
      if (!disposed) {
        setEnsuredLibrary(snapshot);
      }
    }).catch(() => {
      // The shared store retains and exposes its last library error.
    });

    return () => {
      disposed = true;
    };
  }, [completedEnvironmentSignature, ensureLibrary, error, library, loading]);

  // Environment-local probes are keyed by completed environment IDs and the
  // path/runtime fields that determine their directory and MelonLoader state.
  // Reuse an in-flight pass across StrictMode effect replay and ignore stale completions.
  useEffect(() => {
    const generation = ++localProbeGenerationRef.current;
    let disposed = false;
    const completedEnvironmentIds = getCompletedEnvironmentIds(completedEnvironmentSignature);

    if (loading) {
      return () => {
        disposed = true;
      };
    }

    if (error) {
      notifyInitialDetectionComplete();
      return () => {
        disposed = true;
      };
    }

    if (completedEnvironmentIds.length === 0) {
      unmanagedLocalModsEpochRef.current = new Map();
      setUnmanagedLocalModsCounts(new Map());
      setPluginsCounts(new Map());
      setUserLibsCounts(new Map());
      setMelonLoaderStatus(new Map());
      notifyInitialDetectionComplete();
      return () => {
        disposed = true;
      };
    }

    const hasCompleteCachedSnapshot = completedEnvironmentIds.every((environmentId) =>
      environmentCountCache.unmanagedLocalMods.has(environmentId)
      && environmentCountCache.plugins.has(environmentId)
      && environmentCountCache.userLibs.has(environmentId)
      && environmentCountCache.melonLoader.has(environmentId));
    if (hasCompleteCachedSnapshot) {
      // Cached values already rendered synchronously; keep the freshness pass
      // in the background instead of holding the pane-wide loading gate.
      notifyInitialDetectionComplete();
    }

    let request = localProbeRequestRef.current;
    if (!request || request.signature !== completedEnvironmentSignature) {
      const promise = loadEnvironmentLocalProbeSnapshot(completedEnvironmentIds);
      const unmanagedLocalModsEpochs = new Map(
        completedEnvironmentIds.map((environmentId) => [
          environmentId,
          unmanagedLocalModsEpochRef.current.get(environmentId) ?? 0,
        ]),
      );
      request = { signature: completedEnvironmentSignature, promise, unmanagedLocalModsEpochs };
      localProbeRequestRef.current = request;
      void promise.then(
        () => {
          if (localProbeRequestRef.current?.promise === promise) {
            localProbeRequestRef.current = null;
          }
        },
        () => {
          if (localProbeRequestRef.current?.promise === promise) {
            localProbeRequestRef.current = null;
          }
        },
      );
    }

    void request.promise.then((snapshot) => {
      if (disposed || generation !== localProbeGenerationRef.current) {
        return;
      }

      const completedEnvironmentEpochs = new Map(
        completedEnvironmentIds.map((environmentId) => [
          environmentId,
          unmanagedLocalModsEpochRef.current.get(environmentId) ?? 0,
        ]),
      );
      unmanagedLocalModsEpochRef.current = completedEnvironmentEpochs;
      setUnmanagedLocalModsCounts((previous) => {
        const next = new Map<string, number>();
        for (const environmentId of completedEnvironmentIds) {
          const probeEpoch = request.unmanagedLocalModsEpochs.get(environmentId) ?? 0;
          const currentEpoch = completedEnvironmentEpochs.get(environmentId) ?? 0;
          if (probeEpoch === currentEpoch) {
            next.set(environmentId, snapshot.unmanagedLocalMods.get(environmentId) ?? 0);
          } else if (previous.has(environmentId)) {
            next.set(environmentId, previous.get(environmentId) ?? 0);
          }
        }
        return next;
      });
      setPluginsCounts(snapshot.plugins);
      setUserLibsCounts(snapshot.userLibs);
      setMelonLoaderStatus(snapshot.melonLoader);

      const melonLoaderEnvironmentId = completedEnvironmentIds.find(
        (environmentId) => snapshot.melonLoader.get(environmentId)?.installed,
      );
      if (melonLoaderEnvironmentId && !melonLoaderPrefetchStartedRef.current) {
        melonLoaderPrefetchStartedRef.current = true;
        loadMelonLoaderReleases(melonLoaderEnvironmentId).catch((cause) => {
          console.error(`Failed to load MelonLoader releases for ${melonLoaderEnvironmentId}:`, cause);
        });
      }

      notifyInitialDetectionComplete();
    }).catch((cause) => {
      if (disposed || generation !== localProbeGenerationRef.current) {
        return;
      }
      console.error('Failed to load environment counts during startup detection:', cause);
      notifyInitialDetectionComplete();
    });

    return () => {
      disposed = true;
    };
  }, [
    completedEnvironmentSignature,
    error,
    loadMelonLoaderReleases,
    loading,
    notifyInitialDetectionComplete,
    setMelonLoaderStatus,
    setPluginsCounts,
    setUnmanagedLocalModsCounts,
    setUserLibsCounts,
  ]);

  // Library changes only update derived managed/featured/update counts. They must
  // never restart environment-local probes and their read-driven backend events.
  useEffect(() => {
    const completedEnvironmentIds = getCompletedEnvironmentIds(completedEnvironmentSignature);
    const effectiveLibrary = library ?? ensuredLibrary;
    const modCounts = new Map<string, number>();
    const featuredDownloadCountsMap = new Map<string, number>();
    const modUpdatesCountsMap = new Map<string, number>();

    for (const environmentId of completedEnvironmentIds) {
      const snapshot = buildEnvironmentModSnapshot(effectiveLibrary, environmentId);
      modCounts.set(
        environmentId,
        snapshot.userMods + (unmanagedLocalModsCounts.get(environmentId) ?? 0),
      );
      featuredDownloadCountsMap.set(environmentId, snapshot.featuredDownloads);
      modUpdatesCountsMap.set(environmentId, snapshot.updateCount);
    }

    setModsCounts(modCounts);
    setFeaturedDownloadCounts(featuredDownloadCountsMap);
    setModUpdatesCounts(modUpdatesCountsMap);
  }, [
    completedEnvironmentSignature,
    ensuredLibrary,
    library,
    setFeaturedDownloadCounts,
    setModUpdatesCounts,
    setModsCounts,
    unmanagedLocalModsCounts,
  ]);

  const handleOpenModsOverlay = (envId: string) => {
    rememberEnvironment(envId);
    if (onOpenWorkspace) {
      onOpenWorkspace({ view: 'mods', environmentId: envId });
      return;
    }
    setModsOverlay({ isOpen: true, envId });
  };

  const handleModsChanged = () => {
    // Refresh mods count and mod updates when mods are changed
    if (modsOverlay.envId) {
      const env = environments.find(e => e.id === modsOverlay.envId);
      if (env && env.status === 'completed') {
        refreshLibrary()
          .then((library) => buildEnvironmentCardModSnapshot(env.id, library, true))
          .then((snapshot) => {
            setUnmanagedLocalModsCounts(prev => {
              const next = new Map(prev);
              next.set(env.id, snapshot.unmanagedLocalMods);
              return next;
            });
            setModsCounts(prev => {
              const next = new Map(prev);
              next.set(env.id, snapshot.userMods);
              return next;
            });
            setFeaturedDownloadCounts(prev => {
              const next = new Map(prev);
              next.set(env.id, snapshot.featuredDownloads);
              return next;
            });
            setModUpdatesCounts(prev => {
              const next = new Map(prev);
              next.set(env.id, snapshot.updateCount);
              return next;
            });
          })
          .catch(() => {
            setUnmanagedLocalModsCounts(prev => {
              const next = new Map(prev);
              next.set(env.id, 0);
              return next;
            });
            setModsCounts(prev => {
              const next = new Map(prev);
              next.set(env.id, 0);
              return next;
            });
            setFeaturedDownloadCounts(prev => {
              const next = new Map(prev);
              next.set(env.id, 0);
              return next;
            });
            setModUpdatesCounts(prev => {
              const next = new Map(prev);
              next.set(env.id, 0);
              return next;
            });
          });
      }
    }
  };

  const handleOpenModUpdatesOverlay = (envId: string) => {
    rememberEnvironment(envId);
    if (onOpenWorkspace) {
      onOpenWorkspace({ view: 'mods', environmentId: envId, initialTab: 'updates' });
      return;
    }
    setModsOverlay({ isOpen: true, envId });
  };

  const handleOpenPluginsOverlay = (envId: string) => {
    rememberEnvironment(envId);
    if (onOpenWorkspace) {
      onOpenWorkspace({ view: 'plugins', environmentId: envId });
      return;
    }
    setPluginsOverlay({ isOpen: true, envId });
  };

  const handlePluginsChanged = () => {
    // Refresh plugins count when plugins are deleted
    if (pluginsOverlay.envId) {
      const env = environments.find(e => e.id === pluginsOverlay.envId);
      if (env && env.status === 'completed') {
        ApiService.getPluginsCount(env.id)
          .then(result => {
            setPluginsCounts(prev => {
              const next = new Map(prev);
              next.set(env.id, result.count);
              return next;
            });
          })
          .catch(() => {
            setPluginsCounts(prev => {
              const next = new Map(prev);
              next.set(env.id, 0);
              return next;
            });
          });
      }
    }
  };

  const handleClosePluginsOverlay = () => {
    setPluginsOverlay({ isOpen: false, envId: null });
  };

  const handleOpenUserLibsOverlay = (envId: string) => {
    rememberEnvironment(envId);
    if (onOpenWorkspace) {
      onOpenWorkspace({ view: 'userLibs', environmentId: envId });
      return;
    }
    setUserLibsOverlay({ isOpen: true, envId });
  };

  const handleShareProfile = async (env: Environment) => {
    const operationId = ++profileExportOperationRef.current;
    setProfileExport({
      isOpen: true,
      environmentId: env.id,
      manifest: null,
      selectedItemKeys: new Set(),
      profileName: env.name,
      loading: true,
      saving: false,
    });
    try {
      const manifest = await ApiService.exportEnvironmentProfile(env.id);
      if (operationId !== profileExportOperationRef.current) return;
      setProfileExport({
        isOpen: true,
        environmentId: env.id,
        manifest,
        selectedItemKeys: new Set(manifest.items.map((item, index) => profileItemKey(item, index))),
        profileName: manifest.profile.name,
        loading: false,
        saving: false,
      });
    } catch (err) {
      if (operationId !== profileExportOperationRef.current) return;
      setProfileExport(emptyProfileExportState);
      showMessage('Share Profile Failed', getErrorMessage(err, 'Failed to export profile.'), 'error');
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
      return {
        ...previous,
        selectedItemKeys: nextKeys,
      };
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
      showMessage('Profile Exported', `Profile JSON was saved to ${destination}.`, 'success');
    } catch (err) {
      showMessage('Export Failed', getErrorMessage(err, 'Failed to save profile.'), 'error');
    } finally {
      setProfileExport((previous) => previous.isOpen ? { ...previous, saving: false } : previous);
    }
  };

  const handleUserLibsChanged = () => {
    // Refresh userlibs count when needed
    if (userLibsOverlay.envId) {
      const env = environments.find(e => e.id === userLibsOverlay.envId);
      if (env && env.status === 'completed') {
        ApiService.getUserLibsCount(env.id)
          .then(result => {
            setUserLibsCounts(prev => {
              const next = new Map(prev);
              next.set(env.id, result.count);
              return next;
            });
          })
          .catch(() => {
            setUserLibsCounts(prev => {
              const next = new Map(prev);
              next.set(env.id, 0);
              return next;
            });
          });
      }
    }
  };

  const handleCloseUserLibsOverlay = () => {
    setUserLibsOverlay({ isOpen: false, envId: null });
  };

  const handleInstallMelonLoader = (env: Environment) => {
    // Load releases and show version selector
    setShowNightlyMelonLoaderBuilds(false);
    void loadMelonLoaderReleases(env.id, false);
    setShowMelonLoaderVersionSelector(env.id);
  };

  const handleNightlyMelonLoaderToggle = async (envId: string, checked: boolean) => {
    setShowNightlyMelonLoaderBuilds(checked);
    const loaded = await loadMelonLoaderReleases(envId, checked);
    if (!loaded && checked) {
      setShowNightlyMelonLoaderBuilds(false);
    }
  };

  const autoInstallMelonLoader = useCallback(async (environmentId: string) => {
    if (settings?.autoInstallMelonLoader === false) {
      return;
    }

    if (autoInstallMelonLoaderInFlightRef.current.has(environmentId)) {
      return;
    }

    if (melonLoaderStatus.get(environmentId)?.installed) {
      return;
    }

    autoInstallMelonLoaderInFlightRef.current.add(environmentId);
    setInstallingMelonLoader((previous) => new Set(previous).add(environmentId));

    try {
      let versionTag = settings?.melonLoaderVersion?.trim() || '';
      if (!versionTag) {
        const releases = await ApiService.getMelonLoaderReleases(environmentId);
        versionTag = getLatestStableMelonLoaderTag(releases) ?? releases[0]?.tag_name ?? '';
      }

      if (!versionTag) {
        console.warn(
          `Skipping MelonLoader auto-install for ${environmentId}: no preferred version is configured`,
        );
        return;
      }

      const result = await ApiService.installMelonLoader(environmentId, versionTag);
      if (!result.success) {
        throw new Error(result.error || 'MelonLoader installation failed');
      }

      const statusResult = await ApiService.getMelonLoaderStatus(environmentId);
      setMelonLoaderStatus((previous) => {
        const next = new Map(previous);
        next.set(environmentId, {
          ...statusResult,
          version: statusResult.version || result.version || versionTag,
        });
        return next;
      });
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Unknown error';
      console.error(`Failed to auto-install MelonLoader for ${environmentId}:`, err);
      showMessage(
        isLinuxMelonLoaderSetupMessage(errorMessage)
          ? 'Linux MelonLoader Setup Failed'
          : 'MelonLoader Install Failed',
        isLinuxMelonLoaderSetupMessage(errorMessage)
          ? `SIMM could not complete the required Linux MelonLoader setup: ${errorMessage}`
          : `Failed to auto-install MelonLoader: ${errorMessage}`,
        'error',
      );
    } finally {
      autoInstallMelonLoaderInFlightRef.current.delete(environmentId);
      setInstallingMelonLoader((previous) => {
        const next = new Set(previous);
        next.delete(environmentId);
        return next;
      });
    }
  }, [
    melonLoaderStatus,
    setMelonLoaderStatus,
    settings?.autoInstallMelonLoader,
    settings?.melonLoaderVersion,
    showMessage,
  ]);

  useEffect(() => {
    autoInstallMelonLoaderRef.current = autoInstallMelonLoader;
  }, [autoInstallMelonLoader]);

  const closeMelonLoaderVersionSelector = useCallback(() => {
    setShowMelonLoaderVersionSelector(null);
    setShowNightlyMelonLoaderBuilds(false);
    setSelectedMelonLoaderVersion(prev => {
      const next = new Map(prev);
      if (showMelonLoaderVersionSelector) {
        next.delete(showMelonLoaderVersionSelector);
      }
      return next;
    });
  }, [showMelonLoaderVersionSelector]);

  const handleMelonLoaderVersionSelected = async (envId: string) => {
    const selectedVersion = selectedMelonLoaderVersion.get(envId);
    if (!selectedVersion) {
      setMessageOverlay({
        isOpen: true,
        title: 'Error',
        message: 'Please select a version',
        type: 'error'
      });
      return;
    }

    setShowMelonLoaderVersionSelector(null);
    setInstallingMelonLoader(prev => new Set(prev).add(envId));
    setMessageOverlay({ isOpen: false, title: '', message: '', type: 'info' });

    try {
      const result = await ApiService.installMelonLoader(envId, selectedVersion);
      if (result.success) {
        // Refresh MelonLoader status
        const statusResult = await ApiService.getMelonLoaderStatus(envId);
        setMelonLoaderStatus(prev => {
          const next = new Map(prev);
          next.set(envId, { ...statusResult, version: statusResult.version || result.version });
          return next;
        });
        setMessageOverlay({
          isOpen: true,
          title: 'Success',
          message: `MelonLoader ${result.version || selectedVersion} installed successfully!`,
          type: 'success'
        });
        // Clear releases list after installation
        setMelonLoaderReleases(prev => {
          const next = new Map(prev);
          next.delete(envId);
          return next;
        });
        setSelectedMelonLoaderVersion(prev => {
          const next = new Map(prev);
          next.delete(envId);
          return next;
        });
      } else {
        const errorMessage = result.error || 'Unknown error';
        setMessageOverlay({
          isOpen: true,
          title: isLinuxMelonLoaderSetupMessage(errorMessage)
            ? 'Linux MelonLoader Setup Failed'
            : 'Installation Failed',
          message: isLinuxMelonLoaderSetupMessage(errorMessage)
            ? `SIMM could not complete the required Linux MelonLoader setup: ${errorMessage}`
            : `Failed to install MelonLoader: ${errorMessage}`,
          type: 'error'
        });
      }
    } catch (err: any) {
      // Handle Tauri errors - they may be strings or Error objects
      let errorMessage = 'Unknown error';
      if (typeof err === 'string') {
        errorMessage = err;
      } else if (err instanceof Error) {
        errorMessage = err.message;
      } else if (err && typeof err === 'object' && 'message' in err) {
        errorMessage = String(err.message);
      }

      setMessageOverlay({
        isOpen: true,
        title: isLinuxMelonLoaderSetupMessage(errorMessage)
          ? 'Linux MelonLoader Setup Failed'
          : 'Installation Failed',
        message: isLinuxMelonLoaderSetupMessage(errorMessage)
          ? `SIMM could not complete the required Linux MelonLoader setup: ${errorMessage}`
          : `Failed to install MelonLoader: ${errorMessage}`,
        type: 'error'
      });
    } finally {
      setInstallingMelonLoader(prev => {
        const next = new Set(prev);
        next.delete(envId);
        return next;
      });
    }
  };

  const handleCloseModsOverlay = () => {
    setModsOverlay({ isOpen: false, envId: null });
  };

  const formatLastChecked = (value: Environment['lastUpdateCheck']) => {
    if (!value) return 'Never';
    const date = typeof value === 'number' ? new Date(value * 1000) : new Date(value);
    if (Number.isNaN(date.getTime())) return 'Unknown';
    return formatDateTime(date);
  };

  const melonLoaderSelectorEnvironment = showMelonLoaderVersionSelector
    ? environments.find((environment) => environment.id === showMelonLoaderVersionSelector) ?? null
    : null;
  const melonLoaderSelectorReleases = showMelonLoaderVersionSelector
    ? (melonLoaderReleases.get(showMelonLoaderVersionSelector) ?? [])
    : [];
  const latestStableMelonLoaderTag = getLatestStableMelonLoaderTag(melonLoaderSelectorReleases);
  const selectedMelonLoaderTag = showMelonLoaderVersionSelector
    ? (selectedMelonLoaderVersion.get(showMelonLoaderVersionSelector) ?? '')
    : '';
  const currentMelonLoaderVersion =
    showMelonLoaderVersionSelector && melonLoaderStatus.get(showMelonLoaderVersionSelector)?.installed
      ? (melonLoaderStatus.get(showMelonLoaderVersionSelector)?.version || 'Installed')
      : 'Not installed';

  const getDominantStatus = (env: Environment): { label: string; tone: 'ok' | 'warn' | 'danger' | 'info' | 'muted' } => {
    const prog = progress.get(env.id);
    const status = prog?.status || env.status;

    if (checkingEnvironments.has(env.id)) return { label: 'Checking', tone: 'info' };
    if (status === 'downloading') return { label: 'Downloading', tone: 'info' };
    if (status === 'validating') return { label: 'Validating', tone: 'info' };
    if (status === 'completed' && env.updateAvailable) return { label: 'Game update', tone: 'warn' };
    if (status === 'completed') return { label: 'Ready', tone: 'ok' };
    if (status === 'unavailable') return { label: 'Folder missing', tone: 'danger' };
    if (status === 'error') return { label: 'Needs attention', tone: 'danger' };
    if (status === 'cancelled') return { label: 'Cancelled', tone: 'muted' };
    return { label: 'Not installed', tone: 'muted' };
  };

  const openEnvironmentMenu = (envId: string, x: number, y: number) => {
    setEnvironmentMenu({ envId, x, y });
  };

  const setLaunchMethod = (envId: string, method: 'steam' | 'direct') => {
    setPreferredLaunchMethod((previous) => {
      const next = new Map(previous);
      next.set(envId, method);
      return next;
    });
  };

  const handleCopyPath = async (env: Environment) => {
    try {
      await navigator.clipboard.writeText(env.outputDir);
      setCopiedPathEnvId(env.id);
      window.setTimeout(() => {
        setCopiedPathEnvId((current) => (current === env.id ? null : current));
      }, 1500);
    } catch (err) {
      showMessage('Copy Failed', getErrorMessage(err, 'Could not copy the install folder path.'), 'error');
    }
  };

  const handleRefreshGameVersion = async (env: Environment) => {
    try {
      await refreshGameVersion(env.id);
    } catch (err) {
      console.error('Failed to refresh game version:', err);
    }
  };

  // Share Profile, Verify Game Files, Mod Integration and Refresh Game Version
  // live in the visible Tools row of the Overview; the menu keeps only the
  // object-level actions so the two never duplicate each other.
  const buildEnvironmentMenuItems = (env: Environment): AnchoredContextMenuItem[] => {
    const isSteam = isSteamEnvironment(env);

    return [
      {
        key: 'rename',
        label: 'Rename',
        icon: 'fas fa-edit',
        onSelect: () => handleStartEditName(env),
      },
      {
        key: 'description',
        label: env.description ? 'Edit Description' : 'Add Description',
        icon: 'fas fa-align-left',
        onSelect: () => handleStartEditDescription(env),
      },
      {
        key: 'open-folder',
        label: 'Open Folder',
        icon: 'fas fa-folder-open',
        separatorBefore: true,
        onSelect: () => {
          void handleOpenFolder(env);
        },
      },
      {
        key: 'delete',
        label: isSteam ? 'Clear Environment Records' : 'Delete Environment',
        icon: 'fas fa-trash',
        separatorBefore: true,
        danger: true,
        onSelect: () => handleDelete(env),
      },
    ];
  };

  const renderEnvironmentCard = (env: Environment) => {
    const isPage = Boolean(onlyEnvironmentId);
    const prog = progress.get(env.id);
    const isDownloading = env.status === 'downloading' || prog?.status === 'queued' || prog?.status === 'downloading' || prog?.status === 'validating';
    const showDownloadPercent = prog?.operation === 'verify' || (typeof prog?.totalBytes === 'number' && prog.totalBytes > 0);
    const gameOperationInProgress = Boolean(activeGameDownloadId) && activeGameDownloadId !== env.id;
    const gameOperationTitle = activeGameDownloadName
      ? `${activeGameDownloadName} is already downloading, updating, or being verified.`
      : 'Another game download, update, or verification is already running.';
    const isSteam = isSteamEnvironment(env);
    const isCheckingUpdate = checkingEnvironments.has(env.id);
    const isCompleted = env.status === 'completed';
    const status = getDominantStatus(env);
    const launchMethod: LaunchMethod = directLaunchSupported
      ? preferredLaunchMethod.get(env.id) || 'steam'
      : 'steam';
    const isLaunching = isLaunchPending(launchAttempts.get(env.id));
    const modCount = modsCounts.get(env.id) ?? 0;
    const featuredDownloadCount = featuredDownloadCounts.get(env.id) ?? 0;
    const totalModCount = modCount + featuredDownloadCount;
    const modUpdateCount = modUpdatesCounts.get(env.id) ?? 0;
    const pluginCount = pluginsCounts.get(env.id) ?? 0;
    const userLibsCount = userLibsCounts.get(env.id) ?? 0;
    const mlStatus = melonLoaderStatus.get(env.id);
    const linuxMelonLoaderRequirements = mlStatus?.linuxRequirements;
    const linuxMelonLoaderWarning = linuxMelonLoaderRequirements?.warnings?.[0];
    const linuxNeedsLaunchRepair = Boolean(
      mlStatus?.installed
        && linuxMelonLoaderRequirements?.needsSteamLaunchOptionsRepair
        && linuxMelonLoaderRequirements?.steamLaunchOptionsRepairable,
    );
    const linuxPrerequisitesMissing = linuxMelonLoaderRequirements?.prerequisitesInstalled === false;
    const linuxCanInstallPrerequisites = Boolean(linuxMelonLoaderRequirements?.canInstallPrerequisites);
    const linuxCanRepairSetup = linuxNeedsLaunchRepair || (
      linuxPrerequisitesMissing && linuxCanInstallPrerequisites
    );
    const showLinuxMelonLoaderHint = Boolean(
      linuxMelonLoaderWarning
        && (
          mlStatus?.installed
          || !linuxMelonLoaderRequirements?.protontricksInstalled
          || linuxPrerequisitesMissing
        ),
    );
    const linuxMelonLoaderHint = showLinuxMelonLoaderHint
      ? (
        linuxNeedsLaunchRepair
          ? 'Repair launch'
          : !linuxMelonLoaderRequirements?.protontricksInstalled
            ? 'Protontricks needed'
            : linuxPrerequisitesMissing && linuxCanInstallPrerequisites
              ? 'Install setup'
              : linuxPrerequisitesMissing
                ? 'Proton setup needed'
                : 'Manual Proton setup'
      )
      : null;
    const linuxMelonLoaderTitle = linuxMelonLoaderRequirements
      ? [
          linuxMelonLoaderWarning,
          linuxMelonLoaderRequirements.missingPrerequisites?.length
            ? `Missing: ${linuxMelonLoaderRequirements.missingPrerequisites.join(', ')}`
            : null,
          linuxMelonLoaderRequirements.prerequisiteStatusPath
            ? `Status: ${linuxMelonLoaderRequirements.prerequisiteStatusPath}`
            : null,
          linuxMelonLoaderRequirements.prerequisiteCommands?.join(' | '),
          linuxMelonLoaderRequirements.launchOptions,
        ].filter(Boolean).join(' - ')
      : undefined;
    const currentGameVersion = env.currentGameVersion || 'Unknown';
    const hasGameUpdate = isCompleted && Boolean(env.updateAvailable && env.updateGameVersion);
    const branchKey = env.branch.toLowerCase();
    const branchLabel = isSteam && ['main', 'public'].includes(branchKey)
      ? 'Public'
      : isSteam && !['beta', 'alternate', 'alternate-beta'].includes(branchKey)
        ? `Closed beta (${env.branch})`
        : env.branch;
    const menuOpen = environmentMenu?.envId === env.id;
    const installingMl = installingMelonLoader.has(env.id);
    const progressPercent = prog ? Math.min(prog.status === 'completed' ? 100 : 99, Math.round(prog.progress)) : 0;

    const openMenuFromElement = (element: HTMLElement) => {
      const rect = element.getBoundingClientRect();
      openEnvironmentMenu(env.id, rect.right - 8, rect.bottom + 6);
    };

    return (
      <section
        key={env.id}
        ref={(node) => {
          if (node) {
            environmentCardRefs.current.set(env.id, node);
          } else {
            environmentCardRefs.current.delete(env.id);
          }
        }}
        className={`env-overview ${isPage ? 'env-overview--page' : 'env-overview--card ui-panel'}${focusedEnvironmentId === env.id && !isPage ? ' env-overview--focused' : ''}`}
        aria-label={`${env.name} overview`}
        tabIndex={-1}
        onKeyDown={(event) => {
          const isMenuKey = event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey);
          if (!isMenuKey) return;
          const target = event.target as HTMLElement;
          if (target.closest('input, textarea, [contenteditable="true"]')) return;
          event.preventDefault();
          const trigger = event.currentTarget.querySelector<HTMLElement>('[data-env-menu-trigger]');
          openMenuFromElement(trigger ?? event.currentTarget);
        }}
        onContextMenu={(event) => {
          const target = event.target as HTMLElement;
          if (target.closest('input, textarea, button, a, [contenteditable="true"]')) return;
          event.preventDefault();
          openEnvironmentMenu(env.id, event.clientX, event.clientY);
        }}
      >
        {!isPage && (
          <header className="env-overview__card-header">
            <GameArt appId={env.appId} className="env-overview__card-art" />
            <h3 className="env-overview__card-title ui-truncate" title={env.name}>{env.name}</h3>
            <span className={`ui-status ui-status--${status.tone}`}>{status.label}</span>
            <span className="ui-toolbar__spacer" />
            {isCompleted && !isDownloading && (
              <SimmButton
                onClick={() => handleLaunchGame(env, launchMethod)}
                disabled={isLaunching}
                aria-busy={isLaunching}
              >
                <Icon name={isLaunching ? 'spinner' : 'play'} spin={isLaunching} />
                {isLaunching ? 'Starting…' : 'Play'}
              </SimmButton>
            )}
          </header>
        )}

        {editingName === env.id && (
          <div className="env-overview__editor">
            <label htmlFor={`env-name-${env.id}`} className="ui-section-title">Environment name</label>
            <div className="env-overview__editor-row">
              <Input
                id={`env-name-${env.id}`}
                type="text"
                value={nameValue}
                onChange={(e) => setNameValue(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    handleSaveName(env.id);
                  } else if (e.key === 'Escape') {
                    handleCancelEditName();
                  }
                }}
                autoFocus
              />
              <SimmButton variant="secondary" onClick={handleCancelEditName}>Cancel</SimmButton>
              <SimmButton onClick={() => handleSaveName(env.id)}>Save</SimmButton>
            </div>
          </div>
        )}

        <div className="env-overview__top">
        <div className="env-overview__top-main">
        <div className="env-overview__intro">
          {editingDescription === env.id ? (
            <div className="env-overview__editor">
              <label htmlFor={`env-description-${env.id}`} className="ui-section-title">Description</label>
              <Textarea
                id={`env-description-${env.id}`}
                value={descriptionValue}
                onChange={(e) => setDescriptionValue(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') handleCancelEditDescription();
                }}
                placeholder="What is this environment for?"
                rows={2}
                autoFocus
              />
              <div className="env-overview__editor-actions">
                <SimmButton variant="secondary" onClick={handleCancelEditDescription}>Cancel</SimmButton>
                <SimmButton onClick={() => handleSaveDescription(env.id)}>Save</SimmButton>
              </div>
            </div>
          ) : (
            <div className="env-overview__description">
              {env.description ? (
                <p>{env.description}</p>
              ) : (
                <p className="ui-subtle">No description</p>
              )}
              <SimmButton
                variant="ghost"
                size="icon-sm"
                onClick={() => handleStartEditDescription(env)}
                aria-label={env.description ? 'Edit description' : 'Add description'}
                title={env.description ? 'Edit description' : 'Add description'}
              >
                <Icon name="penToSquare" />
              </SimmButton>
            </div>
          )}
          <SimmButton
            type="button"
            variant="ghost"
            size="icon-sm"
            data-env-menu-trigger=""
            onClick={(event) => openMenuFromElement(event.currentTarget)}
            aria-label={`More actions for ${env.name}`}
            title="More actions"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            aria-controls={menuOpen ? `environment-actions-${env.id}` : undefined}
          >
            <Icon name="ellipsisH" />
          </SimmButton>
        </div>

        {isDownloading && prog && (
          <section className="env-overview__section env-overview__progress" aria-label={prog.operation === 'verify' ? 'Verification progress' : 'Download progress'}>
            <div className="env-overview__progress-head">
              <strong>{prog.operation === 'verify' ? 'Verifying game files' : 'Downloading game files'}</strong>
              <span className="ui-num">{showDownloadPercent ? `${progressPercent}%` : 'Calculating total…'}</span>
              <span className="ui-toolbar__spacer" />
              <SimmButton variant="outline" size="sm" onClick={() => handleCancelDownload(env)}>
                {prog.operation === 'verify' ? 'Cancel Verification' : 'Cancel Download'}
              </SimmButton>
            </div>
            <div
              className={`env-progress${!showDownloadPercent ? ' env-progress--indeterminate' : ''}`}
              role="progressbar"
              aria-label={prog.operation === 'verify' ? 'Verification progress' : 'Download progress'}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={showDownloadPercent ? progressPercent : undefined}
            >
              <div className="env-progress__fill" style={{ width: `${Math.min(100, Math.max(0, prog.progress))}%` }} />
            </div>
            {typeof prog.downloadedBytes === 'number' && prog.downloadedBytes > 0 && (
              <p className="env-overview__progress-meta ui-num">
                Downloaded: {formatProgressBytes(prog.downloadedBytes)}
                {typeof prog.totalBytes === 'number' && prog.totalBytes > 0 ? ` / ${formatProgressBytes(prog.totalBytes)}` : ''}
                {prog.speed ? ` · ${prog.speed}` : ''}
                {prog.eta ? ` · ${prog.eta} remaining` : ''}
              </p>
            )}
            {prog.message && <p className="env-overview__progress-message ui-truncate" title={prog.message}>{prog.message}</p>}
          </section>
        )}

        {!isDownloading && !isCompleted && (
          <div className={`ui-callout ${env.status === 'error' || env.status === 'unavailable' ? 'ui-callout--danger' : 'ui-callout--info'} env-overview__callout`}>
            <div className="env-overview__callout-copy">
              <strong>
                {env.status === 'error'
                  ? 'The last download did not finish'
                  : env.status === 'unavailable'
                    ? 'The install folder is missing'
                    : 'This environment is not downloaded yet'}
              </strong>
              <span>
                {env.status === 'unavailable'
                  ? 'Reconnect the drive or download the branch again into the folder below.'
                  : 'Download the game files to start installing mods and playing.'}
              </span>
            </div>
            <SimmButton
              onClick={() => handleStartDownload(env)}
              disabled={gameOperationInProgress}
              title={gameOperationInProgress ? gameOperationTitle : undefined}
            >
              <Icon name="download" />
              Download
            </SimmButton>
          </div>
        )}

        <section className="env-overview__section" aria-labelledby={`env-details-${env.id}`}>
          <h3 id={`env-details-${env.id}`} className="ui-section-title">Details</h3>
          <dl className="ui-kv env-overview__facts">
            <dt>Install folder</dt>
            <dd className="env-overview__fact-row">
              <span className="ui-mono ui-truncate env-overview__path" title={env.outputDir}>{env.outputDir}</span>
              <SimmButton
                variant="ghost"
                size="icon-xs"
                onClick={() => void handleCopyPath(env)}
                aria-label="Copy install folder path"
                title={copiedPathEnvId === env.id ? 'Copied' : 'Copy path'}
              >
                <Icon name={copiedPathEnvId === env.id ? 'check' : 'copy'} />
              </SimmButton>
              <SimmButton
                variant="ghost"
                size="icon-xs"
                onClick={() => handleOpenFolder(env)}
                aria-label="Open install folder"
                title="Open folder"
              >
                <Icon name="folderOpen" />
              </SimmButton>
            </dd>

            <dt>Branch</dt>
            <dd>{branchLabel}</dd>

            <dt>Runtime</dt>
            <dd>{env.runtime === 'IL2CPP' ? 'IL2CPP' : 'Mono'}</dd>

            <dt>Game version</dt>
            <dd className="env-overview__fact-row">
              {isCompleted ? (
                <>
                  <span className="ui-mono">{currentGameVersion}</span>
                  {hasGameUpdate && (
                    <span className="ui-tag ui-tag--warn" title={`Game update available: ${currentGameVersion} -> ${env.updateGameVersion}`}>
                      {env.updateGameVersion} available
                    </span>
                  )}
                  {isSteam ? (
                    <span className="ui-subtle">Updated by Steam</span>
                  ) : (
                    <SimmButton
                      variant={hasGameUpdate ? 'secondary' : 'ghost'}
                      size="sm"
                      onClick={() => handleUpdateAction(env)}
                      disabled={isCheckingUpdate || gameOperationInProgress}
                      title={gameOperationInProgress ? gameOperationTitle : undefined}
                    >
                      {isCheckingUpdate && <Icon name="spinner" spin />}
                      {isCheckingUpdate ? 'Checking…' : hasGameUpdate ? 'Update Game' : 'Check for Updates'}
                    </SimmButton>
                  )}
                </>
              ) : (
                <span className="ui-subtle">Not installed</span>
              )}
            </dd>

            <dt>MelonLoader</dt>
            <dd className="env-overview__fact-row">
              {isCompleted ? (
                <>
                  {mlStatus?.installed
                    ? <span className="ui-mono">{mlStatus.version || 'Installed'}</span>
                    : <span className="ui-subtle">Not installed</span>}
                  <SimmButton
                    variant="ghost"
                    size="sm"
                    onClick={() => handleInstallMelonLoader(env)}
                    disabled={installingMl}
                    title={mlStatus?.installed ? 'Change MelonLoader version' : 'Install MelonLoader'}
                  >
                    {installingMl && <Icon name="spinner" spin />}
                    {mlStatus?.installed ? 'Change Version' : 'Install MelonLoader'}
                  </SimmButton>
                  {linuxCanRepairSetup ? (
                    <SimmButton
                      type="button"
                      variant="outline"
                      size="sm"
                      className="env-overview__warn-action"
                      onClick={() => void handleRepairMelonLoaderLaunchOptions(env.id)}
                      title={linuxMelonLoaderTitle}
                    >
                      <Icon name="triangleExclamation" />
                      {linuxMelonLoaderHint}
                    </SimmButton>
                  ) : linuxMelonLoaderHint ? (
                    <span className="ui-tag ui-tag--warn" title={linuxMelonLoaderTitle}>{linuxMelonLoaderHint}</span>
                  ) : null}
                </>
              ) : (
                <span className="ui-subtle">Available after download</span>
              )}
            </dd>

            <dt id={`env-launch-${env.id}`}>Launch method</dt>
            <dd>
              {directLaunchSupported ? (
                <RadioGroup
                  className="env-overview__launch-method"
                  value={launchMethod}
                  onValueChange={(value) => setLaunchMethod(env.id, value === 'direct' ? 'direct' : 'steam')}
                  aria-labelledby={`env-launch-${env.id}`}
                >
                  <label className="env-overview__radio">
                    <RadioGroupItem value="steam" />
                    Steam
                  </label>
                  <label className="env-overview__radio">
                    <RadioGroupItem value="direct" />
                    Local (start the game executable directly)
                  </label>
                </RadioGroup>
              ) : (
                <span>Steam <span className="ui-subtle">· Local launch is not available on Linux</span></span>
              )}
            </dd>

            <dt>Last checked</dt>
            <dd className="ui-num">{isCheckingUpdate ? 'Checking…' : formatLastChecked(env.lastUpdateCheck)}</dd>
          </dl>
        </section>
        </div>
        {isPage && <GameArt appId={env.appId} className="env-overview__art" />}
        </div>

        {isCompleted && (
          <section className="env-overview__section" aria-labelledby={`env-content-${env.id}`}>
            <h3 id={`env-content-${env.id}`} className="ui-section-title">Installed content</h3>
            <div className="ui-meta env-overview__summary">
              <SimmButton variant="link" onClick={() => handleOpenModsOverlay(env.id)} title={`${totalModCount} total mods`}>
                <strong>{totalModCount}</strong> {totalModCount === 1 ? 'mod' : 'mods'}
              </SimmButton>
              {modUpdateCount > 0 && (
                <SimmButton variant="link" className="env-overview__summary-warn" onClick={() => handleOpenModUpdatesOverlay(env.id)}>
                  {modUpdateCount} {modUpdateCount === 1 ? 'update' : 'updates'} available
                </SimmButton>
              )}
              <SimmButton variant="link" onClick={() => handleOpenPluginsOverlay(env.id)}>
                {pluginCount} {pluginCount === 1 ? 'plugin' : 'plugins'}
              </SimmButton>
              <SimmButton variant="link" onClick={() => handleOpenUserLibsOverlay(env.id)}>
                {userLibsCount} UserLibs
              </SimmButton>
            </div>
          </section>
        )}

        {(isCompleted || env.status === 'error') && (
          <section className="env-overview__section" aria-labelledby={`env-tools-${env.id}`}>
            <h3 id={`env-tools-${env.id}`} className="ui-section-title">Tools</h3>
            <div className="ui-toolbar">
              {isCompleted && (
                <SimmButton variant="outline" size="sm" onClick={() => void handleShareProfile(env)}>
                  <Icon name="upload" />
                  Share Profile
                </SimmButton>
              )}
              <SimmButton
                variant="outline"
                size="sm"
                onClick={() => handleVerifyRequest(env)}
                disabled={Boolean(activeGameDownloadId)}
                title={activeGameDownloadId ? gameOperationTitle : undefined}
              >
                <Icon name="shieldAlt" />
                Verify Game Files
              </SimmButton>
              {isCompleted && (
                <SimmButton variant="outline" size="sm" onClick={() => setModIntegrationEnvironmentId(env.id)}>
                  <Icon name="plug" />
                  Mod Integration
                </SimmButton>
              )}
              {isCompleted && (
                <SimmButton variant="outline" size="sm" onClick={() => void handleRefreshGameVersion(env)}>
                  <Icon name="syncAlt" />
                  Refresh Game Version
                </SimmButton>
              )}
            </div>
          </section>
        )}

        <section className="ui-danger-zone env-overview__danger" aria-labelledby={`env-danger-${env.id}`}>
          <div className="env-overview__danger-copy">
            <h3 id={`env-danger-${env.id}`} className="ui-section-title">
              {isSteam ? 'Clear environment records' : 'Delete environment'}
            </h3>
            <p className="ui-subtle">
              {isSteam
                ? 'Forget the mods, plugins, and UserLibs SIMM tracks here. Steam keeps the game installed.'
                : 'Remove this environment from SIMM. You choose whether the game files are deleted too.'}
            </p>
          </div>
          <SimmButton variant="destructive" size="sm" onClick={() => handleDelete(env)}>
            <Icon name="trash" />
            {isSteam ? 'Clear Environment Records' : 'Delete Environment'}
          </SimmButton>
        </section>
      </section>
    );
  };

  if (loading) {
    return <EnvironmentListSkeleton />;
  }

  if (error) {
    return (
      <div className="ui-callout ui-callout--danger env-overview__load-error" role="alert">
        <div>
          <strong>Environments could not be loaded</strong>
          <p>{error}</p>
        </div>
      </div>
    );
  }

  if (environments.length === 0) {
    return (
      <div className="ui-empty">
        <span className="ui-empty__emblem" aria-hidden="true"><Icon name="gamepad" /></span>
        <p className="ui-empty__title">No environments yet</p>
        <p className="ui-empty__copy">Add your Steam install, import a game folder, or download a separate branch to get started.</p>
        {onOpenWorkspace && (
          <SimmButton
            type="button"
            onClick={() => onOpenWorkspace({ view: 'wizard' })}
          >
            <Icon name="plus" />
            Add Environment
          </SimmButton>
        )}
      </div>
    );
  }

  if (compactMode) {
    const selectedEnvironmentId =
      activeWorkspace && 'environmentId' in activeWorkspace
        ? activeWorkspace.environmentId
        : null;

    return (
      <div className="workspace-environment-sidebar">
        <h3 className="workspace-environment-sidebar__title">Environments</h3>
        <p className="workspace-environment-sidebar__copy">
          Select an environment to open its active tools workspace.
        </p>
        <div className="workspace-environment-sidebar__list">
          {sortEnvironmentsForDisplay(environments).map((env) => (
            <div
              key={env.id}
              className="workspace-environment-sidebar__item"
            >
              <SimmButton
                type="button"
                variant="ghost"
                onClick={() => {
                  rememberEnvironment(env.id);
                  onSelectEnvironment?.(env.id);
                }}
                className={`workspace-environment-sidebar__button h-auto ${selectedEnvironmentId === env.id ? 'workspace-environment-sidebar__button--active' : ''}`}
                title={env.name}
                aria-current={selectedEnvironmentId === env.id ? 'page' : undefined}
              >
                <span className="workspace-environment-sidebar__button-label">{env.name}</span>
              </SimmButton>
            </div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="env-overview-root">
      <AuthenticationModal
        isOpen={authModal.isOpen}
        onClose={() => {
          if (!authModal.waiting) {
            setAuthModal({ isOpen: false, envId: null, waiting: false });
          }
        }}
        onAuthenticated={handleAuthenticated}
        required={false}
        waitingForAuth={authModal.waiting}
        authMessage={authModal.message}
      />

      <Suspense fallback={<OverlayFallback />}>
        {modsOverlay.envId && (
          <ModsOverlay
            isOpen={modsOverlay.isOpen}
            onClose={handleCloseModsOverlay}
            environmentId={modsOverlay.envId}
            onModsChanged={handleModsChanged}
            onModUpdatesChecked={(count: number) => {
              const envId = modsOverlay.envId!;
              setModUpdatesCounts(prev => {
                const next = new Map(prev);
                next.set(envId, count);
                return next;
              });
              window.dispatchEvent(new CustomEvent('mod-updates-checked', { detail: { environmentId: envId, count } }));
            }}
          />
        )}

        {pluginsOverlay.envId && (
          <PluginsOverlay
            isOpen={pluginsOverlay.isOpen}
            onClose={handleClosePluginsOverlay}
            environmentId={pluginsOverlay.envId}
            onPluginsChanged={handlePluginsChanged}
          />
        )}

        {userLibsOverlay.envId && (
          <UserLibsOverlay
            isOpen={userLibsOverlay.isOpen}
            onClose={handleCloseUserLibsOverlay}
            environmentId={userLibsOverlay.envId}
            onUserLibsChanged={handleUserLibsChanged}
          />
        )}


      </Suspense>

      <ConfirmOverlay
        isOpen={confirmOverlay.isOpen}
        onClose={() => setConfirmOverlay({ isOpen: false, title: '', message: '', onConfirm: () => {} })}
        onConfirm={confirmOverlay.onConfirm}
        title={confirmOverlay.title}
        message={confirmOverlay.message}
        confirmText={confirmOverlay.confirmText}
        cancelText={confirmOverlay.cancelText}
      />

      <ConfirmOverlay
        isOpen={deleteConfirm.isOpen && !!deleteConfirm.env}
        onClose={resetDeleteConfirm}
        onConfirm={handleConfirmDelete}
        title={deleteConfirm.env && isSteamEnvironment(deleteConfirm.env) ? 'Clear Environment Records' : 'Delete Environment'}
        message={
          deleteConfirm.env && isSteamEnvironment(deleteConfirm.env)
            ? `Clear the mod, plugin, and UserLib records SIMM keeps for "${deleteConfirm.env.name}"? Steam keeps the game installed.`
            : `Remove "${deleteConfirm.env?.name}" from SIMM? The game files stay on disk unless you choose otherwise.`
        }
        confirmText={
          deleteConfirm.env && isSteamEnvironment(deleteConfirm.env)
            ? 'Clear Records'
            : deleteConfirm.deleteFiles
              ? 'Delete Files and Remove'
              : 'Remove from SIMM'
        }
        tone="danger"
        bodyContent={deleteConfirm.env && !isSteamEnvironment(deleteConfirm.env) ? (
          <label className="app-dialog__option">
            <Checkbox
              checked={deleteConfirm.deleteFiles}
              onCheckedChange={(checked) => setDeleteConfirm((previous) => ({ ...previous, deleteFiles: !!checked }))}
            />
            <span className="app-dialog__option-copy">
              <strong>Also delete game files from disk</strong>
              <span className="ui-mono ui-truncate" title={deleteConfirm.env.outputDir}>{deleteConfirm.env.outputDir}</span>
            </span>
          </label>
        ) : undefined}
      />

      <MessageOverlay
        isOpen={messageOverlay.isOpen}
        onClose={() => setMessageOverlay({ isOpen: false, title: '', message: '', type: 'info' })}
        title={messageOverlay.title}
        message={messageOverlay.message}
        type={messageOverlay.type}
      />

      {showMelonLoaderVersionSelector && (
        <Dialog open={!!showMelonLoaderVersionSelector} onOpenChange={(open) => {
          if (!open) {
            closeMelonLoaderVersionSelector();
          }
        }}>
          <SimmDialogContent
            className="app-dialog melonloader-dialog"
            showCloseButton={false}
          >
            <DialogHeader className="modal-header app-dialog__header">
              <div className="app-dialog__heading">
                <DialogTitle>Select MelonLoader Version</DialogTitle>
                <div className="ui-meta">
                  <span>{melonLoaderSelectorEnvironment?.name || 'Environment'}</span>
                  <span>Installed: <span className="ui-mono">{currentMelonLoaderVersion}</span></span>
                </div>
              </div>
              <SimmButton variant="ghost" size="icon-sm" className="modal-close" onClick={closeMelonLoaderVersionSelector} aria-label="Close MelonLoader version selector">
                <Icon name="times" />
              </SimmButton>
            </DialogHeader>

            <div className="app-dialog__body melonloader-dialog__body">
              <div className="melonloader-dialog__toolbar">
                <span className="ui-subtle">Releases from GitHub. Latest stable is recommended.</span>
                <label className="melonloader-dialog__nightly" title="Nightly builds are experimental and unreleased.">
                  <Switch
                    size="sm"
                    checked={showNightlyMelonLoaderBuilds}
                    onCheckedChange={(checked) => {
                      void handleNightlyMelonLoaderToggle(showMelonLoaderVersionSelector, Boolean(checked));
                    }}
                    disabled={loadingMelonLoaderReleases.has(showMelonLoaderVersionSelector)}
                  />
                  Show nightly builds
                </label>
              </div>

              {loadingMelonLoaderReleases.has(showMelonLoaderVersionSelector) ? (
                <div className="melonloader-dialog__list" role="status" aria-label="Loading releases">
                  {[0, 1, 2].map((index) => (
                    <span key={index} className="loading-skeleton env-skeleton env-skeleton--row" aria-hidden="true" />
                  ))}
                </div>
              ) : melonLoaderSelectorReleases.length === 0 ? (
                <div className="ui-empty">
                  <span className="ui-empty__emblem" aria-hidden="true"><Icon name="cube" /></span>
                  <p className="ui-empty__title">No releases found</p>
                  <p className="ui-empty__copy">SIMM could not load MelonLoader releases. Check your connection and open this dialog again.</p>
                </div>
              ) : (
                <RadioGroup
                  className="melonloader-dialog__list"
                  value={selectedMelonLoaderTag}
                  aria-label="MelonLoader releases"
                  onValueChange={(value) => setSelectedMelonLoaderVersion(prev => {
                    const next = new Map(prev);
                    next.set(showMelonLoaderVersionSelector, value);
                    return next;
                  })}
                >
                  {melonLoaderSelectorReleases.map((release) => (
                    <label
                      key={release.tag_name}
                      className={`melonloader-dialog__release${selectedMelonLoaderTag === release.tag_name ? ' melonloader-dialog__release--selected' : ''}`}
                    >
                      <RadioGroupItem value={release.tag_name} />
                      <span className="melonloader-dialog__release-main">
                        <span className="melonloader-dialog__release-title">
                          <strong className="ui-mono">{release.tag_name}</strong>
                          {release.tag_name === latestStableMelonLoaderTag ? (
                            <span className="ui-tag ui-tag--ok">Latest stable</span>
                          ) : release.isNightly ? (
                            <span className="ui-tag ui-tag--warn">Nightly</span>
                          ) : release.prerelease ? (
                            <span className="ui-tag ui-tag--warn">Beta</span>
                          ) : null}
                        </span>
                        <span className="ui-meta">
                          {release.name && release.name !== release.tag_name && <span className="ui-truncate">{release.name}</span>}
                          <span className="ui-num">{formatDate(release.published_at)}</span>
                        </span>
                      </span>
                      <a
                        href={safeExternalUrl(
                          release.isNightly
                            ? 'https://github.com/LavaGang/MelonLoader/actions'
                            : `https://github.com/LavaGang/MelonLoader/releases/tag/${encodeURIComponent(release.tag_name)}`
                        )}
                        target="_blank"
                        rel="noopener noreferrer"
                        onClick={(e) => e.stopPropagation()}
                        className="melonloader-dialog__release-link"
                        title={release.isNightly ? 'View GitHub Actions' : 'View release page and changelog'}
                      >
                        {release.isNightly ? 'Actions' : 'Release notes'}
                        <Icon name="externalLinkAlt" />
                      </a>
                    </label>
                  ))}
                </RadioGroup>
              )}
            </div>

            <DialogFooter className="app-dialog__footer">
              <div className="app-dialog__actions">
                <SimmButton variant="secondary" onClick={closeMelonLoaderVersionSelector}>
                  Cancel
                </SimmButton>
                <SimmButton
                  onClick={() => handleMelonLoaderVersionSelected(showMelonLoaderVersionSelector)}
                  disabled={
                    melonLoaderSelectorReleases.length === 0
                    || !selectedMelonLoaderVersion.get(showMelonLoaderVersionSelector)
                    || installingMelonLoader.has(showMelonLoaderVersionSelector)
                  }
                >
                  {installingMelonLoader.has(showMelonLoaderVersionSelector) && <Icon name="spinner" spin />}
                  {installingMelonLoader.has(showMelonLoaderVersionSelector)
                    ? 'Installing…'
                    : currentMelonLoaderVersion === 'Not installed' ? 'Install' : 'Change Version'}
                </SimmButton>
              </div>
            </DialogFooter>
          </SimmDialogContent>
        </Dialog>
      )}

      <ProfileExportDialog
        open={profileExport.isOpen}
        loading={profileExport.loading}
        saving={profileExport.saving}
        manifest={profileExport.manifest}
        profileName={profileExport.profileName}
        selectedItemKeys={profileExport.selectedItemKeys}
        inputId="profile-export-name"
        saveDisabled={profileExport.loading || profileExport.saving || !adjustedProfileManifest || adjustedProfileManifest.items.length === 0}
        onClose={closeProfileExport}
        onProfileNameChange={(profileName) => setProfileExport((previous) => ({
          ...previous,
          profileName,
        }))}
        onToggleItem={handleToggleProfileItem}
        onSave={() => void handleSaveProfile()}
      />

      {modIntegrationEnvironmentId && (() => {
        const environment = environments.find((item) => item.id === modIntegrationEnvironmentId);
        return environment ? (
          <ModIntegrationDialog
            isOpen={true}
            environment={environment}
            onClose={() => setModIntegrationEnvironmentId(null)}
          />
        ) : null;
      })()}

      <div className={onlyEnvironmentId ? 'env-overview-host' : 'env-overview-list'}>
        {sortEnvironmentsForDisplay(environments)
          .filter((env) => !onlyEnvironmentId || env.id === onlyEnvironmentId)
          .map(renderEnvironmentCard)}
      </div>

      {environmentMenu && (() => {
        const env = environments.find((item) => item.id === environmentMenu.envId);
        if (!env) return null;

        return (
          <AnchoredContextMenu
            id={`environment-actions-${env.id}`}
            x={environmentMenu.x}
            y={environmentMenu.y}
            items={buildEnvironmentMenuItems(env)}
            onClose={() => setEnvironmentMenu(null)}
          />
        );
      })()}
    </div>
  );
}
