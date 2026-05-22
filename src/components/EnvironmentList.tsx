import { Suspense, lazy, useState, useEffect, useRef, useCallback } from 'react';
import type { ComponentType } from 'react';
import { useEnvironmentStore } from '../stores/environmentStore';
import { useSettingsStore } from '../stores/settingsStore';
import type { Environment } from '../types';
import { AuthenticationModal } from './AuthenticationModal';
import { MessageOverlay } from './MessageOverlay';
import { ConfirmOverlay } from './ConfirmOverlay';
import { AnchoredContextMenu, type AnchoredContextMenuItem } from './AnchoredContextMenu';
import { ApiService } from '../services/api';
import { buildEnvironmentModSnapshot } from '../services/modLibrarySummary';
import { normalizeLibraryFeaturedDownloads } from '../services/featuredDownloads';
import { logger } from '../services/logger';
import { isSteamEnvironment, sortEnvironmentsForDisplay } from '../utils/environmentOrdering';
import { getErrorMessage, isSteamShortcutReloadError } from '../utils/errors';
import { Icon } from './Icon';
import {
  Dialog,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Textarea } from '@/components/ui/textarea';
import { SimmButton, SimmDialogContent } from './primitives';
import {
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
  onModsChanged,
  onModUpdatesChecked,
  onPluginsChanged,
  onUserLibsChanged
} from '../services/events';

type InstalledModsResponse = Awaited<ReturnType<typeof ApiService.getMods>>;
type ModLibraryResponse = Awaited<ReturnType<typeof ApiService.getModLibrary>>;
type LaunchMethod = 'steam' | 'steam_restart' | 'direct';

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
const LogsOverlay = lazyNamed(
  () => import('./LogsOverlay'),
  (module) => module.LogsOverlay,
);
const ConfigurationOverlay = lazyNamed(
  () => import('./ConfigurationOverlay'),
  (module) => module.ConfigurationOverlay,
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

function SteamBadge() {
  return (
    <span
      className="badge badge-blue environment-card__steam-badge"
      title="Steam-managed installation"
    >
      <Icon name="fab fa-steam" />
    </span>
  );
}

function EnvironmentListSkeleton() {
  return (
    <div className="environment-loading-skeleton" role="status" aria-live="polite" aria-label="Loading game installs">
      <section className="environment-loading-skeleton__header">
        <span className="loading-skeleton loading-skeleton--eyebrow" aria-hidden="true" />
        <strong className="loading-skeleton loading-skeleton--heading" aria-hidden="true" />
        <span className="loading-skeleton loading-skeleton--line" aria-hidden="true" />
      </section>
      <div className="environments-grid environments-grid--loading">
        {[0, 1, 2, 3].map((index) => (
          <article key={index} className="environment-card environment-card--skeleton">
            <div className="environment-card-skeleton__top">
              <span className="loading-skeleton loading-skeleton--icon" aria-hidden="true" />
              <div>
                <strong className="loading-skeleton loading-skeleton--title" aria-hidden="true" />
                <span className="loading-skeleton loading-skeleton--text" aria-hidden="true" />
              </div>
            </div>
            <div className="environment-card-skeleton__meta">
              <span className="loading-skeleton loading-skeleton--pill" aria-hidden="true" />
              <span className="loading-skeleton loading-skeleton--pill" aria-hidden="true" />
              <span className="loading-skeleton loading-skeleton--pill" aria-hidden="true" />
            </div>
            <span className="loading-skeleton loading-skeleton--line" aria-hidden="true" />
            <span className="loading-skeleton loading-skeleton--line loading-skeleton--short" aria-hidden="true" />
          </article>
        ))}
      </div>
    </div>
  );
}

function countUnmanagedLocalMods(installedMods: InstalledModsResponse | null | undefined): number {
  return (installedMods?.mods || []).filter((mod) => !mod.managed && (mod.source === 'local' || !mod.source)).length;
}

async function buildEnvironmentCardModSnapshot(
  environmentId: string,
  library: ModLibraryResponse | null | undefined,
  refreshInstalledMods: boolean = false,
) {
  const snapshot = buildEnvironmentModSnapshot(library, environmentId);

  try {
    const installedMods = await ApiService.getMods(environmentId, refreshInstalledMods);
    return {
      ...snapshot,
      userMods: snapshot.userMods + countUnmanagedLocalMods(installedMods),
    };
  } catch {
    return snapshot;
  }
}

// Shared ref to track last update check time (accessible across components)
// This is exported so Footer can update it when doing manual checks
export const lastUpdateCheckTimeRef = { current: null as number | null };
export const batchUpdateCheckRef = { current: false };
export const batchUpdateCheckEventName = 'simm:batch-update-check-started';
const LAST_ENV_KEY = 'simm:lastEnvId';

const environmentCountCache = {
  mods: new Map<string, number>(),
  featuredDownloads: new Map<string, number>(),
  modUpdates: new Map<string, number>(),
  plugins: new Map<string, number>(),
  userLibs: new Map<string, number>(),
  melonLoader: new Map<string, { installed: boolean; version?: string }>(),
};

type MapStateUpdater<T> = Map<string, T> | ((previous: Map<string, T>) => Map<string, T>);

function resolveMapState<T>(previous: Map<string, T>, updater: MapStateUpdater<T>) {
  return typeof updater === 'function' ? updater(previous) : updater;
}

export function notifyBatchUpdateCheckStarted(environmentIds: string[]) {
  window.dispatchEvent(new CustomEvent(batchUpdateCheckEventName, {
    detail: { environmentIds }
  }));
}

interface EnvironmentListProps {
  onInitialDetectionComplete?: () => void;
  compactMode?: boolean;
  activeWorkspace?: WorkspaceRoute;
  focusedEnvironmentId?: string | null;
  focusedEnvironmentRequestId?: number;
  onOpenWorkspace?: (workspace: Exclude<WorkspaceRoute, { view: 'home' }>) => void;
  onSelectEnvironment?: (environmentId: string) => void;
}

export type WorkspaceRoute =
  | { view: 'home' }
  | { view: 'environments' }
  | { view: 'library'; initialTab?: 'discover' | 'library' | 'updates' }
  | { view: 'securityReport' }
  | { view: 'mods'; environmentId: string; initialTab?: 'installed' | 'updates' }
  | { view: 'plugins'; environmentId: string }
  | { view: 'userLibs'; environmentId: string }
  | { view: 'logs'; environmentId: string }
  | { view: 'config'; environmentId: string }
  | { view: 'settings' }
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
  onSelectEnvironment
}: EnvironmentListProps) {
  const { environments, loading, error, progress, startDownload, cancelDownload, deleteEnvironment, checkUpdate, checkAllUpdates, updateEnvironment, refreshGameVersion } = useEnvironmentStore();
  const { settings } = useSettingsStore();
  const autoCheckIntervalRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [authModal, setAuthModal] = useState<{ isOpen: boolean; envId: string | null; waiting: boolean; message?: string }>({ isOpen: false, envId: null, waiting: false });
  const [, setAuthCredentials] = useState<{ username: string; password: string; steamGuard: string; saveCredentials: boolean } | null>(null);
  const [editingDescription, setEditingDescription] = useState<string | null>(null);
  const [descriptionValue, setDescriptionValue] = useState<string>('');
  const [editingName, setEditingName] = useState<string | null>(null);
  const [nameValue, setNameValue] = useState<string>('');
  const [checkingEnvironments, setCheckingEnvironments] = useState<Set<string>>(new Set());
  const checkInProgressRef = useRef(false);
  const environmentCardRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const [modsOverlay, setModsOverlay] = useState<{ isOpen: boolean; envId: string | null }>({ isOpen: false, envId: null });
  const [pluginsOverlay, setPluginsOverlay] = useState<{ isOpen: boolean; envId: string | null }>({ isOpen: false, envId: null });
  const [userLibsOverlay, setUserLibsOverlay] = useState<{ isOpen: boolean; envId: string | null }>({ isOpen: false, envId: null });
  const [logsOverlay, setLogsOverlay] = useState<{ isOpen: boolean; envId: string | null }>({ isOpen: false, envId: null });
  const [configOverlay, setConfigOverlay] = useState<{ isOpen: boolean; envId: string | null }>({ isOpen: false, envId: null });
  const [modsCounts, setModsCountsState] = useState<Map<string, number>>(() => new Map(environmentCountCache.mods));
  const [featuredDownloadCounts, setFeaturedDownloadCountsState] = useState<Map<string, number>>(() => new Map(environmentCountCache.featuredDownloads));
  const [modUpdatesCounts, setModUpdatesCountsState] = useState<Map<string, number>>(() => new Map(environmentCountCache.modUpdates));
  const [pluginsCounts, setPluginsCountsState] = useState<Map<string, number>>(() => new Map(environmentCountCache.plugins));
  const [userLibsCounts, setUserLibsCountsState] = useState<Map<string, number>>(() => new Map(environmentCountCache.userLibs));
  const [melonLoaderStatus, setMelonLoaderStatusState] = useState<Map<string, { installed: boolean; version?: string }>>(() => new Map(environmentCountCache.melonLoader));
  const completedEnvironmentCount = environments.filter(env => env.status === 'completed').length;

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

  const setMelonLoaderStatus = useCallback((updater: MapStateUpdater<{ installed: boolean; version?: string }>) => {
    setMelonLoaderStatusState((previous) => {
      const next = resolveMapState(previous, updater);
      environmentCountCache.melonLoader = new Map(next);
      return next;
    });
  }, []);

  // Debounce timers for filesystem change events
  const modsRefreshTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const pluginsRefreshTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const userLibsRefreshTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  // Use refs to access latest environments without causing effect re-runs
  const environmentsRef = useRef(environments);
  useEffect(() => {
    environmentsRef.current = environments;
  }, [environments]);
  const initialUpdateCheckDoneRef = useRef(false);
  const melonLoaderPrefetchStartedRef = useRef(false);
  const autoInstallMelonLoaderInFlightRef = useRef<Set<string>>(new Set());
  const autoInstallMelonLoaderRef = useRef<((environmentId: string) => Promise<void>) | null>(null);
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
  const [selectedMelonLoaderVersion, setSelectedMelonLoaderVersion] = useState<Map<string, string>>(new Map());
  const [installingMelonLoader, setInstallingMelonLoader] = useState<Set<string>>(new Set());
  const [messageOverlay, setMessageOverlay] = useState<{ isOpen: boolean; title: string; message: string; type: 'success' | 'error' | 'info' }>({ isOpen: false, title: '', message: '', type: 'info' });
  const [confirmOverlay, setConfirmOverlay] = useState<{ isOpen: boolean; title: string; message: string; confirmText?: string; onConfirm: () => void }>({ isOpen: false, title: '', message: '', onConfirm: () => {} });
  const [deleteConfirm, setDeleteConfirm] = useState<{ isOpen: boolean; env: Environment | null; deleteFiles: boolean }>({ isOpen: false, env: null, deleteFiles: false });
  const [environmentMenu, setEnvironmentMenu] = useState<{ envId: string; x: number; y: number } | null>(null);
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

  // Save preferred launch method to localStorage when it changes
  useEffect(() => {
    const obj = Object.fromEntries(preferredLaunchMethod);
    localStorage.setItem('simm-preferred-launch-method', JSON.stringify(obj));
  }, [preferredLaunchMethod]);
  const initialDetectionNotifiedRef = useRef(false);

  useEffect(() => {
    if (!focusedEnvironmentId || compactMode || loading || error) {
      return;
    }

    const card = environmentCardRefs.current.get(focusedEnvironmentId);
    if (!card) {
      return;
    }

    card.scrollIntoView({ block: 'center', behavior: 'smooth' });
    card.focus({ preventScroll: true });
  }, [compactMode, error, focusedEnvironmentId, focusedEnvironmentRequestId, loading, environments]);

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

  const resetDeleteConfirm = useCallback(() => {
    setDeleteConfirm({ isOpen: false, env: null, deleteFiles: false });
  }, []);

  const handleStartDownload = async (env: Environment) => {
    try {
      rememberEnvironment(env.id);
      // Check if we have credentials
      const hasCredentials = settings?.steamUsername;

      if (!hasCredentials) {
        // Show authentication modal
        setAuthModal({ isOpen: true, envId: env.id, waiting: false });
        return;
      }

      // Try to start download
      await startDownload(env.id);
    } catch (err: any) {
      // Check if error indicates authentication is required
      if (err?.response?.data?.requiresAuth || err?.message?.includes('authentication')) {
        setAuthModal({ isOpen: true, envId: env.id, waiting: false });
      } else {
        showMessage('Download Failed', `Failed to start download: ${err instanceof Error ? err.message : 'Unknown error'}`, 'error');
      }
    }
  };

  const handleAuthenticated = async (credentials: { username: string; password: string; steamGuard: string; saveCredentials: boolean }) => {
    if (!authModal.envId) return;

    setAuthCredentials(credentials);
    // Switch to waiting state
    setAuthModal(prev => ({ ...prev, waiting: true, message: 'Authenticating with Steam...' }));

    try {
      // Authenticate first (this stores session via -remember-password)
      // Authentication is handled in the modal's handleSubmit, so by the time we get here,
      // authentication should be complete. Now start the download.
      setAuthModal(prev => ({ ...prev, waiting: true, message: 'Starting download...' }));
      await ApiService.startDownload(authModal.envId);
      // Close modal - download started
      setAuthModal({ isOpen: false, envId: null, waiting: false });
      setAuthCredentials(null);
    } catch (err) {
      setAuthModal(prev => ({ ...prev, waiting: false }));
      showMessage('Download Failed', `Failed to start download: ${err instanceof Error ? err.message : 'Unknown error'}`, 'error');
      setAuthCredentials(null);
    }
  };

  // Perform automatic update check (respects 60-minute interval)
  const performAutoUpdateCheck = useCallback(async (isManual: boolean = false) => {
    batchUpdateCheckRef.current = false;
    const completedEnvironments = environmentsRef.current.filter(env => env.status === 'completed');

    if (completedEnvironments.length === 0) {
      console.log('[EnvironmentList] No completed environments to check for updates');
      return;
    }

    const now = Date.now();
    const checkInterval = (settings?.updateCheckInterval || 60) * 60 * 1000; // Convert minutes to milliseconds

    // If this is not a manual check, enforce the 60-minute minimum interval
    if (!isManual && lastUpdateCheckTimeRef.current !== null) {
      const timeSinceLastCheck = now - lastUpdateCheckTimeRef.current;
      if (timeSinceLastCheck < checkInterval) {
        const minutesRemaining = Math.ceil((checkInterval - timeSinceLastCheck) / 60000);
        console.log(`[EnvironmentList] Skipping automatic update check - last check was ${Math.floor(timeSinceLastCheck / 60000)} minutes ago. Next check in ${minutesRemaining} minute(s)`);
        batchUpdateCheckRef.current = false;
        return;
      }
    }

    console.log(`[EnvironmentList] ${isManual ? 'Manual' : 'Automatic'} update check starting for ${completedEnvironments.length} environment(s)`);
    lastUpdateCheckTimeRef.current = now;

    const dueEnvironmentIds = completedEnvironments
      .filter(env => {
        if (isManual || !env.lastUpdateCheck) return true;

        const lastCheckMs = typeof env.lastUpdateCheck === 'number'
          ? env.lastUpdateCheck * 1000
          : new Date(env.lastUpdateCheck).getTime();

        return Number.isNaN(lastCheckMs) || now - lastCheckMs >= checkInterval;
      })
      .map(env => env.id);

    try {
      batchUpdateCheckRef.current = true;
      notifyBatchUpdateCheckStarted(dueEnvironmentIds);
      await checkAllUpdates(false);
      console.log(`[EnvironmentList] Update check completed successfully`);
    } catch (err) {
      console.error('[EnvironmentList] Failed to check for updates:', err);
      // Reset last check time on error so it can retry sooner
      if (!isManual) {
        lastUpdateCheckTimeRef.current = null;
      }
    } finally {
      batchUpdateCheckRef.current = false;
    }
  }, [settings?.updateCheckInterval, checkAllUpdates]);

  // Check for updates automatically on app launch (after environments are loaded)
  useEffect(() => {
    if (initialUpdateCheckDoneRef.current) {
      return;
    }
    if (environments.length === 0) {
      console.log('[EnvironmentList] Waiting for environments to load...');
      return;
    }

    if (completedEnvironmentCount === 0) {
      console.log('[EnvironmentList] No completed environments to check for updates');
      return;
    }

    // Always run update check on app launch (first time)
    console.log(`[EnvironmentList] Running initial update check on app launch for ${completedEnvironmentCount} environment(s)`);
    initialUpdateCheckDoneRef.current = true;
    performAutoUpdateCheck(false).catch(err => {
      console.error('[EnvironmentList] Failed to check for updates on app launch:', err);
    });
  }, [environments.length, completedEnvironmentCount, performAutoUpdateCheck]); // Run when environments are first loaded

  // Set up automatic update check interval (every 60 minutes or based on settings)
  useEffect(() => {
    // Clear any existing interval
    if (autoCheckIntervalRef.current) {
      clearInterval(autoCheckIntervalRef.current);
    }

    const checkInterval = (settings?.updateCheckInterval || 60) * 60 * 1000; // Convert minutes to milliseconds
    const autoCheckEnabled = settings?.autoCheckUpdates !== false; // Default to true

    if (autoCheckEnabled) {
      console.log(`[EnvironmentList] Setting up automatic update checks every ${settings?.updateCheckInterval || 60} minutes`);

      // Set up interval for automatic checks
      autoCheckIntervalRef.current = setInterval(() => {
        performAutoUpdateCheck(false);
      }, checkInterval);
    } else {
      console.log('[EnvironmentList] Automatic update checks are disabled in settings');
    }

    // Cleanup on unmount
    return () => {
      if (autoCheckIntervalRef.current) {
        clearInterval(autoCheckIntervalRef.current);
        autoCheckIntervalRef.current = null;
      }
    };
  }, [settings?.updateCheckInterval, settings?.autoCheckUpdates, performAutoUpdateCheck]);

  // Listen for Tauri auth events and password prompts
  useEffect(() => {
    let unlistenWaiting: (() => void) | null = null;
    let unlistenSuccess: (() => void) | null = null;
    let unlistenError: (() => void) | null = null;
    let unlistenProgress: (() => void) | null = null;
    let unlistenMelonLoaderInstalling: (() => void) | null = null;
    let unlistenMelonLoaderInstalled: (() => void) | null = null;
    let unlistenMelonLoaderError: (() => void) | null = null;
    let unlistenComplete: (() => void) | null = null;
    let unlistenUpdateAvailable: (() => void) | null = null;
    let unlistenUpdateCheckComplete: (() => void) | null = null;
    let unlistenModsChanged: (() => void) | null = null;
    let unlistenModUpdatesChecked: (() => void) | null = null;
    let unlistenPluginsChanged: (() => void) | null = null;
    let unlistenUserLibsChanged: (() => void) | null = null;

    const handleBatchUpdateCheckStarted = (event: Event) => {
      const customEvent = event as CustomEvent<{ environmentIds?: string[] }>;
      const environmentIds = customEvent.detail?.environmentIds ?? [];
      setCheckingEnvironments(new Set(environmentIds));
      checkInProgressRef.current = environmentIds.length > 0;
    };

    window.addEventListener(batchUpdateCheckEventName, handleBatchUpdateCheckStarted as EventListener);

    const setupListeners = async () => {
      try {
        unlistenWaiting = await onAuthWaiting((data) => {
          const env = environments.find(e => e.id === data.downloadId);
          if (env && authModal.envId === data.downloadId) {
            setAuthModal(prev => ({ ...prev, waiting: true, message: data.message }));
          }
        });

        unlistenSuccess = await onAuthSuccess((data) => {
          if (data.downloadId === authModal.envId) {
            setAuthModal({ isOpen: false, envId: null, waiting: false });
            setAuthCredentials(null);
          }
        });

        unlistenError = await onAuthError((data) => {
          const env = environments.find(e => e.id === data.downloadId);
          if (data.error.toLowerCase().includes('password') || data.error.toLowerCase().includes('credential')) {
            if (env && !authModal.isOpen) {
              setAuthModal({ isOpen: true, envId: data.downloadId, waiting: false });
            } else if (authModal.envId === data.downloadId) {
              setAuthModal(prev => ({ ...prev, waiting: false }));
            }
          } else if (authModal.envId === data.downloadId) {
            setAuthModal(prev => ({ ...prev, waiting: false }));
            showMessage('Authentication Failed', data.error, 'error');
            setAuthCredentials(null);
          }
        });

        unlistenProgress = await onProgressEvent((progress) => {
          if (progress.error && (progress.error.toLowerCase().includes('password') ||
              progress.message?.toLowerCase().includes('enter account password'))) {
            const env = environments.find(e => e.id === progress.downloadId);
            if (env && !authModal.isOpen) {
              setAuthModal({ isOpen: true, envId: progress.downloadId, waiting: false });
            }
          }
        });

        unlistenMelonLoaderInstalling = await onMelonLoaderInstalling((data) => {
          const env = environments.find(e => e.id === data.environmentId);
          if (env) {
            setInstallingMelonLoader((previous) => new Set(previous).add(data.environmentId));
            console.log(`MelonLoader installing for ${data.environmentId}: ${data.message}`);
          }
        });

        unlistenMelonLoaderInstalled = await onMelonLoaderInstalled(async (data) => {
          const env = environments.find(e => e.id === data.environmentId);
          if (env) {
            console.log(`MelonLoader installed for ${data.environmentId}: ${data.message}`);
            try {
              const statusResult = await ApiService.getMelonLoaderStatus(data.environmentId);
              setMelonLoaderStatus(prev => {
                const next = new Map(prev);
                next.set(data.environmentId, { installed: statusResult.installed, version: statusResult.version || data.version });
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
        });

        unlistenMelonLoaderError = await onMelonLoaderError((data) => {
          const env = environments.find(e => e.id === data.environmentId);
          if (env) {
            setInstallingMelonLoader((previous) => {
              const next = new Set(previous);
              next.delete(data.environmentId);
              return next;
            });
            showMessage('MelonLoader Install Failed', data.message, 'error');
          }
        });

        unlistenComplete = await onCompleteEvent(async ({ downloadId }) => {
          const env = environments.find(e => e.id === downloadId);
          if (env) {
            void autoInstallMelonLoaderRef.current?.(downloadId);
          }
          if (env && env.updateAvailable) {
            setTimeout(async () => {
              try {
                const updatedEnvs = await ApiService.getEnvironments();
                const updatedEnv = updatedEnvs.find(e => e.id === downloadId);
                if (updatedEnv) {
                  // Use ConfirmOverlay instead of blocking confirm()
                  setConfirmOverlay({
                    isOpen: true,
                    title: 'Branch Updated',
                    message: 'The branch has been updated. Would you like to update the description to reflect what this new version means?',
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
        });

        const handleUpdateCheckStart = () => {
          const now = Date.now();
          const checkIntervalMs = (settings?.updateCheckInterval || 60) * 60 * 1000;
          const dueEnvironmentIds = environments
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

        unlistenUpdateAvailable = await onUpdateAvailable((data) => {
          handleFirstUpdateEvent();
          handleUpdateEventComplete({ environmentId: data.environmentId });
        });

        unlistenUpdateCheckComplete = await onUpdateCheckComplete((data) => {
          handleFirstUpdateEvent();
          handleUpdateEventComplete({ environmentId: data.environmentId });
        });

        unlistenModUpdatesChecked = await onModUpdatesChecked((data) => {
          void ApiService.getModLibrary()
            .then((library) => normalizeLibraryFeaturedDownloads(library))
            .then((library) => buildEnvironmentCardModSnapshot(data.environmentId, library, true))
            .then((snapshot) => {
              setModsCounts(prev => {
                const next = new Map(prev);
                next.set(data.environmentId, snapshot.userMods);
                return next;
              });
              setFeaturedDownloadCounts(prev => {
                const next = new Map(prev);
                next.set(data.environmentId, snapshot.featuredDownloads);
                return next;
              });
              setModUpdatesCounts(prev => {
                const next = new Map(prev);
                next.set(data.environmentId, snapshot.updateCount);
                return next;
              });
            })
            .catch((error) => {
              logger.warn(
                'Failed to refresh environment mod summary after mod updates check',
                {
                  environmentId: data.environmentId,
                  error: error instanceof Error ? error.message : String(error),
                },
              );
            });
        });

        // Listen for filesystem change events (mods/plugins/userlibs)
        // Debounce to avoid too many API calls when multiple file events fire rapidly
        // Use refs to avoid closure issues and prevent unnecessary effect re-runs
        unlistenModsChanged = await onModsChanged((data) => {
          // Use ref to get latest environments without causing effect dependency
          const env = environmentsRef.current.find(e => e.id === data.environmentId);
          if (env && env.status === 'completed') {
            // Clear existing timer for this environment
            const existingTimer = modsRefreshTimers.current.get(data.environmentId);
            if (existingTimer) {
              clearTimeout(existingTimer);
            }

            // Set new timer to refresh count after 500ms of no events
            const timer = setTimeout(async () => {
              try {
                const library = await ApiService.getModLibrary();
                const normalizedLibrary = await normalizeLibraryFeaturedDownloads(library);
                const snapshot = await buildEnvironmentCardModSnapshot(data.environmentId, normalizedLibrary, true);
                setModsCounts(prev => {
                  const next = new Map(prev);
                  next.set(data.environmentId, snapshot.userMods);
                  return next;
                });
                setFeaturedDownloadCounts(prev => {
                  const next = new Map(prev);
                  next.set(data.environmentId, snapshot.featuredDownloads);
                  return next;
                });
                setModUpdatesCounts(prev => {
                  const next = new Map(prev);
                  next.set(data.environmentId, snapshot.updateCount);
                  return next;
                });
              } catch (err) {
                logger.error('Failed to refresh environment mod counts after filesystem change', {
                  environmentId: data.environmentId,
                  error: err instanceof Error ? err.message : String(err),
                });
              } finally {
                modsRefreshTimers.current.delete(data.environmentId);
              }
            }, 500);

            modsRefreshTimers.current.set(data.environmentId, timer);
          }
        });

        unlistenPluginsChanged = await onPluginsChanged((data) => {
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
        });

        unlistenUserLibsChanged = await onUserLibsChanged((data) => {
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
        });
      } catch (error) {
        console.error('Failed to set up event listeners:', error);
      }
    };

    setupListeners();

    const modsRefreshTimerMap = modsRefreshTimers.current;
    const pluginsRefreshTimerMap = pluginsRefreshTimers.current;
    const userLibsRefreshTimerMap = userLibsRefreshTimers.current;

    return () => {
      window.removeEventListener(batchUpdateCheckEventName, handleBatchUpdateCheckStarted as EventListener);
      if (unlistenWaiting) unlistenWaiting();
      if (unlistenSuccess) unlistenSuccess();
      if (unlistenError) unlistenError();
      if (unlistenProgress) unlistenProgress();
      if (unlistenMelonLoaderInstalling) unlistenMelonLoaderInstalling();
      if (unlistenMelonLoaderInstalled) unlistenMelonLoaderInstalled();
      if (unlistenMelonLoaderError) unlistenMelonLoaderError();
      if (unlistenComplete) unlistenComplete();
      if (unlistenUpdateAvailable) unlistenUpdateAvailable();
      if (unlistenUpdateCheckComplete) unlistenUpdateCheckComplete();
      if (unlistenModsChanged) unlistenModsChanged();
      if (unlistenModUpdatesChecked) unlistenModUpdatesChecked();
      if (unlistenPluginsChanged) unlistenPluginsChanged();
      if (unlistenUserLibsChanged) unlistenUserLibsChanged();

      // Clear all debounce timers
      modsRefreshTimerMap.forEach(timer => clearTimeout(timer));
      pluginsRefreshTimerMap.forEach(timer => clearTimeout(timer));
      userLibsRefreshTimerMap.forEach(timer => clearTimeout(timer));
      modsRefreshTimerMap.clear();
      pluginsRefreshTimerMap.clear();
      userLibsRefreshTimerMap.clear();
    };
  }, [authModal.isOpen, authModal.envId, environments, progress]);

  const handleCancelDownload = async (env: Environment) => {
    try {
      await cancelDownload(env.id);
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

  const handleLaunchGame = async (env: Environment, method: LaunchMethod = 'steam') => {
    try {
      const result = await ApiService.launchGame(env.id, method);
      if (!result.success) {
        showMessage(
          'Launch Failed',
          result.executablePath
            ? `Executable found at ${result.executablePath}, but launch failed.`
            : 'Game executable not found.',
          'error'
        );
      }
    } catch (err) {
      const errorMessage = getErrorMessage(err, 'Unknown error');
      if (method === 'steam' && isSteamShortcutReloadError(errorMessage)) {
        setConfirmOverlay({
          isOpen: true,
          title: 'Restart Steam?',
          message: `${errorMessage} SIMM can restart Steam now and retry the launch.`,
          confirmText: 'Restart Steam',
          onConfirm: () => {
            setConfirmOverlay({ isOpen: false, title: '', message: '', onConfirm: () => {} });
            void handleLaunchGame(env, 'steam_restart');
          },
        });
        return;
      }

      showMessage('Launch Failed', `Failed to launch game: ${errorMessage}`, 'error');
    }
  };

  // Load mods count, plugins count, userlibs count, and MelonLoader status for completed environments
  useEffect(() => {
    const loadCounts = async () => {
      const modCounts = new Map<string, number>();
      const featuredDownloadCountsMap = new Map<string, number>();
      const modUpdatesCountsMap = new Map<string, number>();
      const pluginCounts = new Map<string, number>();
      const userLibsCounts = new Map<string, number>();
      const melonLoaderStatuses = new Map<string, { installed: boolean; version?: string }>();
      const library = await (async () => {
        try {
          return await normalizeLibraryFeaturedDownloads(
            await ApiService.getModLibrary(),
          );
        } catch {
          return null;
        }
      })();
      for (const env of environments) {
        if (env.status === 'completed') {
          const modSnapshot = await buildEnvironmentCardModSnapshot(env.id, library);
          modCounts.set(env.id, modSnapshot.userMods);
          featuredDownloadCountsMap.set(env.id, modSnapshot.featuredDownloads);
          modUpdatesCountsMap.set(env.id, modSnapshot.updateCount);
          try {
            const pluginResult = await ApiService.getPluginsCount(env.id);
            pluginCounts.set(env.id, pluginResult.count);
          } catch {
            pluginCounts.set(env.id, 0);
          }
          try {
            const userLibsResult = await ApiService.getUserLibsCount(env.id);
            userLibsCounts.set(env.id, userLibsResult.count);
          } catch {
            userLibsCounts.set(env.id, 0);
          }
          try {
            const statusResult = await ApiService.getMelonLoaderStatus(env.id);
            melonLoaderStatuses.set(env.id, { installed: statusResult.installed, version: statusResult.version });
          } catch {
            melonLoaderStatuses.set(env.id, { installed: false });
          }
        }
      }
      setModsCounts(modCounts);
      setFeaturedDownloadCounts(featuredDownloadCountsMap);
      setModUpdatesCounts(modUpdatesCountsMap);
      setPluginsCounts(pluginCounts);
      setUserLibsCounts(userLibsCounts);
      setMelonLoaderStatus(melonLoaderStatuses);

      // Load releases for environments with MelonLoader installed (so we can show/hide the Change Version button)
      for (const env of environments) {
        if (
          env.status === 'completed'
          && melonLoaderStatuses.get(env.id)?.installed
          && !melonLoaderPrefetchStartedRef.current
        ) {
          melonLoaderPrefetchStartedRef.current = true;
          loadMelonLoaderReleases(env.id).catch(err => {
            console.error(`Failed to load MelonLoader releases for ${env.id}:`, err);
          });
        }
      }

      notifyInitialDetectionComplete();
    };

    if (loading) {
      return;
    }

    if (error) {
      notifyInitialDetectionComplete();
      return;
    }

    const hasCompletedEnvironment = environments.some(env => env.status === 'completed');
    if (!hasCompletedEnvironment) {
      notifyInitialDetectionComplete();
      return;
    }

    if (environments.length > 0) {
      loadCounts().catch((err) => {
        console.error('Failed to load environment counts during startup detection:', err);
        notifyInitialDetectionComplete();
      });
    }
  }, [loading, error, environments, notifyInitialDetectionComplete]);

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
        ApiService.getModLibrary()
          .then((library) => normalizeLibraryFeaturedDownloads(library))
          .then((library) => buildEnvironmentCardModSnapshot(env.id, library, true))
          .then((snapshot) => {
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

  const handleOpenLogsOverlay = (envId: string) => {
    rememberEnvironment(envId);
    if (onOpenWorkspace) {
      onOpenWorkspace({ view: 'logs', environmentId: envId });
      return;
    }
    setLogsOverlay({ isOpen: true, envId });
  };

  const handleCloseLogsOverlay = () => {
    setLogsOverlay({ isOpen: false, envId: null });
  };

  const handleOpenConfigOverlay = (envId: string) => {
    rememberEnvironment(envId);
    if (onOpenWorkspace) {
      onOpenWorkspace({ view: 'config', environmentId: envId });
      return;
    }
    setConfigOverlay({ isOpen: true, envId });
  };

  const handleCloseConfigOverlay = () => {
    setConfigOverlay({ isOpen: false, envId: null });
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

  const loadMelonLoaderReleases = async (envId: string) => {
    setLoadingMelonLoaderReleases(prev => new Set(prev).add(envId));
    try {
      const releases = await ApiService.getMelonLoaderReleases(envId);
      setMelonLoaderReleases(prev => {
        const next = new Map(prev);
        next.set(envId, releases);
        return next;
      });
      const latestStableTag = getLatestStableMelonLoaderTag(releases);

      // Default to the latest stable tag reported by the Lockwire GitHub release API.
      if (releases.length > 0) {
        const defaultVersion = latestStableTag ?? releases[0].tag_name;

        setSelectedMelonLoaderVersion(prev => {
          const next = new Map(prev);
          next.set(envId, defaultVersion);
          return next;
        });
      }
    } catch (err) {
      console.error('Failed to load MelonLoader releases:', err);
      setMessageOverlay({
        isOpen: true,
        title: 'Error',
        message: 'Failed to load MelonLoader releases',
        type: 'error'
      });
    } finally {
      setLoadingMelonLoaderReleases(prev => {
        const next = new Set(prev);
        next.delete(envId);
        return next;
      });
    }
  };

  const handleInstallMelonLoader = (env: Environment) => {
    // Load releases and show version selector
    loadMelonLoaderReleases(env.id);
    setShowMelonLoaderVersionSelector(env.id);
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
          installed: statusResult.installed,
          version: statusResult.version || result.version || versionTag,
        });
        return next;
      });
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Unknown error';
      console.error(`Failed to auto-install MelonLoader for ${environmentId}:`, err);
      showMessage(
        'MelonLoader Install Failed',
        `Failed to auto-install MelonLoader: ${errorMessage}`,
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
  }, [melonLoaderStatus, settings?.autoInstallMelonLoader, settings?.melonLoaderVersion, showMessage]);

  useEffect(() => {
    autoInstallMelonLoaderRef.current = autoInstallMelonLoader;
  }, [autoInstallMelonLoader]);

  const closeMelonLoaderVersionSelector = useCallback(() => {
    setShowMelonLoaderVersionSelector(null);
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
          next.set(envId, { installed: statusResult.installed, version: statusResult.version || result.version });
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
        setMessageOverlay({
          isOpen: true,
          title: 'Installation Failed',
          message: `Failed to install MelonLoader: ${result.error || 'Unknown error'}`,
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
        title: 'Installation Failed',
        message: `Failed to install MelonLoader: ${errorMessage}`,
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
    if (!value) return 'Never checked';
    const date = typeof value === 'number' ? new Date(value * 1000) : new Date(value);
    if (Number.isNaN(date.getTime())) return 'Unknown';
    return date.toLocaleString();
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

  const getDominantStatus = (env: Environment) => {
    const prog = progress.get(env.id);
    const status = prog?.status || env.status;
    const isCheckingUpdate = checkingEnvironments.has(env.id);

    if (isCheckingUpdate) {
      return { label: 'Checking', tone: 'checking', icon: 'fas fa-spinner fa-spin' };
    }

    if (status === 'downloading') {
      return { label: 'Downloading', tone: 'downloading', icon: 'fas fa-arrow-down' };
    }

    if (status === 'validating') {
      return { label: 'Validating', tone: 'checking', icon: 'fas fa-shield-alt' };
    }

    if (status === 'completed' && env.updateAvailable) {
      return { label: 'Update Available', tone: 'warning', icon: 'fas fa-arrow-up' };
    }

    if (status === 'completed') {
      return { label: 'Healthy', tone: 'healthy', icon: 'fas fa-check-circle' };
    }

    if (status === 'unavailable') {
      return { label: 'Unavailable', tone: 'warning', icon: 'fas fa-ban' };
    }

    if (status === 'error') {
      return { label: 'Needs Attention', tone: 'danger', icon: 'fas fa-exclamation-triangle' };
    }

    if (status === 'cancelled') {
      return { label: 'Cancelled', tone: 'neutral', icon: 'fas fa-pause-circle' };
    }

    return { label: 'Not Downloaded', tone: 'neutral', icon: 'fas fa-download' };
  };

  const openEnvironmentMenu = (envId: string, x: number, y: number) => {
    setEnvironmentMenu({ envId, x, y });
  };

  const buildEnvironmentMenuItems = (env: Environment): AnchoredContextMenuItem[] => {
    const isSteam = isSteamEnvironment(env);
    const currentMethod: LaunchMethod = preferredLaunchMethod.get(env.id) || 'steam';

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
        key: 'launch-steam',
        label: currentMethod === 'steam' ? 'Prefer Steam Launch' : 'Use Steam Launch',
        icon: 'fab fa-steam',
        disabled: currentMethod === 'steam',
        onSelect: () => {
          setPreferredLaunchMethod(prev => {
            const next = new Map(prev);
            next.set(env.id, 'steam');
            return next;
          });
        },
      },
      {
        key: 'launch-direct',
        label: currentMethod === 'direct' ? 'Prefer Local Launch' : 'Use Local Launch',
        icon: 'fas fa-terminal',
        disabled: currentMethod === 'direct',
        onSelect: () => {
          setPreferredLaunchMethod(prev => {
            const next = new Map(prev);
            next.set(env.id, 'direct');
            return next;
          });
        },
      },
      {
        key: 'delete',
        label: isSteam ? 'Clear Environment Records' : 'Delete Environment',
        icon: 'fas fa-trash',
        disabled: false,
        danger: true,
        onSelect: () => handleDelete(env),
      },
    ];
  };

  const renderEnvironmentCard = (env: Environment) => {
    const prog = progress.get(env.id);
    const isDownloading = env.status === 'downloading' || prog?.status === 'downloading';
    const isSteam = isSteamEnvironment(env);
    const isCheckingUpdate = checkingEnvironments.has(env.id);
    const isCompleted = env.status === 'completed';
    const status = getDominantStatus(env);
    const launchMethod: LaunchMethod = preferredLaunchMethod.get(env.id) || 'steam';
    const launchTitle = launchMethod === 'steam'
      ? 'Launch through Steam'
      : 'Launch this local install directly';
    const modCount = modsCounts.get(env.id) ?? 0;
    const featuredDownloadCount = featuredDownloadCounts.get(env.id) ?? 0;
    const totalModCount = modCount + featuredDownloadCount;
    const modUpdateCount = modUpdatesCounts.get(env.id) ?? 0;
    const pluginCount = pluginsCounts.get(env.id) ?? 0;
    const userLibsCount = userLibsCounts.get(env.id) ?? 0;
    const mlStatus = melonLoaderStatus.get(env.id);
    const metrics = [
      { label: 'Version', value: isCompleted ? (env.currentGameVersion || 'Unknown') : 'Not installed' },
      {
        label: 'Mods',
        value: isCompleted
          ? `${totalModCount}${modUpdateCount > 0 ? ` (${modUpdateCount} ${modUpdateCount === 1 ? 'Update' : 'Updates'})` : ''}`
          : 'Unavailable',
        tone: modUpdateCount > 0 ? 'warning' : undefined,
        onClick: isCompleted && modUpdateCount > 0 ? () => handleOpenModUpdatesOverlay(env.id) : undefined,
        title: isCompleted ? `${totalModCount} total mods` : undefined,
      },
      { label: 'Plugins', value: isCompleted ? `${pluginCount}` : 'Unavailable' },
      { label: 'UserLibs', value: isCompleted ? `${userLibsCount}` : 'Unavailable' },
      { label: 'MelonLoader', value: isCompleted ? (mlStatus?.installed ? `Installed${mlStatus.version ? ` (${mlStatus.version})` : ''}` : 'Not installed') : 'Unavailable' },
      { label: 'Last checked', value: isCheckingUpdate ? 'Checking…' : formatLastChecked(env.lastUpdateCheck) },
    ];

    return (
      <div
        key={env.id}
        ref={(node) => {
          if (node) {
            environmentCardRefs.current.set(env.id, node);
          } else {
            environmentCardRefs.current.delete(env.id);
          }
        }}
        className={`environment-card environment-card--workspace${focusedEnvironmentId === env.id ? ' environment-card--focused' : ''}`}
        tabIndex={0}
        onKeyDown={(event) => {
          if (event.key !== 'ContextMenu' && event.key !== 'Enter' && event.key !== ' ') {
            return;
          }
          const target = event.target as HTMLElement;
          if (target.closest('input, textarea, button, a, [contenteditable="true"]')) {
            return;
          }
          event.preventDefault();
          const rect = event.currentTarget.getBoundingClientRect();
          openEnvironmentMenu(env.id, rect.right - 8, rect.bottom + 6);
        }}
        onContextMenu={(event) => {
          const target = event.target as HTMLElement;
          if (target.closest('input, textarea, button, a, [contenteditable="true"]')) {
            return;
          }
          event.preventDefault();
          openEnvironmentMenu(env.id, event.clientX, event.clientY);
        }}
      >
        <div className="environment-card__header">
          {editingName === env.id ? (
            <div className="name-editor environment-card__name-editor">
              <Input
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
                className="name-input"
                autoFocus
              />
              <div className="name-actions">
                <SimmButton onClick={() => handleSaveName(env.id)} className="btn btn-primary btn-small" title="Save name">
                  <Icon name="fas fa-check" />
                </SimmButton>
                <SimmButton variant="secondary" onClick={handleCancelEditName} className="btn btn-secondary btn-small" title="Cancel">
                  <Icon name="fas fa-times" />
                </SimmButton>
              </div>
            </div>
          ) : (
            <>
              <div className="environment-card__title-row">
                <div className="name-display environment-card__title-group">
                  <h3>{env.name}</h3>
                  <SimmButton variant="ghost" size="icon-sm" onClick={() => handleStartEditName(env)} className="btn-edit-name" title="Rename environment">
                    <Icon name="fas fa-edit" />
                  </SimmButton>
                </div>
                <div className="environment-card__header-actions">
                  <span className={`environment-state-pill environment-state-pill--${status.tone}`}>
                    <Icon name={status.icon} />
                    {status.label}
                  </span>
                  <SimmButton
                    type="button"
                    variant="secondary"
                    className="btn btn-secondary btn-small environment-card__overflow-button"
                    onClick={(event) => {
                      const rect = event.currentTarget.getBoundingClientRect();
                      openEnvironmentMenu(env.id, rect.right - 8, rect.bottom + 6);
                    }}
                    aria-label={`More actions for ${env.name}`}
                  >
                    <Icon name="fas fa-ellipsis-h" />
                  </SimmButton>
                </div>
              </div>
              <div className="environment-card__identity-badges">
                <span className={`badge ${env.runtime?.toLowerCase() === 'mono' ? 'badge-orange-red' : 'badge-blue'}`}>
                  {env.branch}
                </span>
                <span className="badge badge-gray">{env.runtime}</span>
                {isSteam && <SteamBadge />}
              </div>
            </>
          )}
        </div>

        <div className="environment-description environment-card__description">
          {editingDescription === env.id ? (
            <div className="description-editor">
              <Textarea
                value={descriptionValue}
                onChange={(e) => setDescriptionValue(e.target.value)}
                placeholder="Describe what this version means..."
                className="description-input"
                rows={2}
                autoFocus
              />
              <div className="description-actions">
                <SimmButton onClick={() => handleSaveDescription(env.id)} className="btn btn-primary btn-small" title="Save description">
                  <Icon name="fas fa-check" />
                </SimmButton>
                <SimmButton variant="secondary" onClick={handleCancelEditDescription} className="btn btn-secondary btn-small" title="Cancel">
                  <Icon name="fas fa-times" />
                </SimmButton>
              </div>
            </div>
          ) : (
            <div className="description-display environment-card__description-display">
              <span className="description-text">
                {env.description || <span className="description-placeholder">No description</span>}
              </span>
              <SimmButton variant="ghost" size="icon-sm" onClick={() => handleStartEditDescription(env)} className="btn-edit-description" title="Edit description">
                <Icon name="fas fa-edit" />
              </SimmButton>
            </div>
          )}
        </div>

        <div className="environment-card__snapshot">
          {metrics.map((metric) => (
            <div
              key={metric.label}
              className={`environment-metric ${metric.tone ? `environment-metric--${metric.tone}` : ''}`}
              role={metric.onClick ? 'button' : undefined}
              tabIndex={metric.onClick ? 0 : undefined}
              aria-label={`${metric.label}: ${metric.value}`}
              onClick={metric.onClick}
              onKeyDown={metric.onClick ? (event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  metric.onClick?.();
                }
              } : undefined}
            >
              <span>{metric.label}</span>
              <strong title={metric.title || metric.value}>{metric.value}</strong>
            </div>
          ))}
          {env.updateAvailable && env.updateGameVersion && (
            <div
              className="environment-metric environment-metric--warning"
              aria-label={`Available update: ${env.updateGameVersion}`}
              title={`Available update: ${env.updateGameVersion}`}
            >
              <span>Available update</span>
              <strong>{env.updateGameVersion}</strong>
            </div>
          )}
        </div>

        <div className="environment-card__action-group">
          {!isDownloading && !isCompleted && (
            <div className="environment-card__action-row environment-card__action-row--single">
              <SimmButton onClick={() => handleStartDownload(env)} className="btn btn-primary">
                <Icon name="fas fa-download" />
                <span>Download</span>
              </SimmButton>
            </div>
          )}

          {isDownloading && (
            <div className="environment-card__action-row environment-card__action-row--single">
              <SimmButton variant="secondary" onClick={() => handleCancelDownload(env)} className="btn btn-secondary">
                <Icon name="fas fa-ban" />
                <span>Cancel Download</span>
              </SimmButton>
            </div>
          )}

          {isCompleted && (
            <>
              <div className="environment-card__action-row environment-card__action-row--primary">
                <SimmButton
                  onClick={() => handleLaunchGame(env, launchMethod)}
                  className="btn btn-primary environment-card__hero-action"
                  title={launchTitle}
                >
                  <Icon name="fas fa-play" />
                  <span>Launch</span>
                </SimmButton>
                <SimmButton
                  variant="secondary"
                  onClick={() => handleOpenModsOverlay(env.id)}
                  className="btn btn-secondary environment-card__hero-action environment-card__hero-action--mods"
                  title="Open installed mods"
                >
                  <Icon name="fas fa-puzzle-piece" />
                  <span>Mods</span>
                </SimmButton>
              </div>

              <div className="environment-card__action-row environment-card__action-row--secondary">
                <SimmButton variant="secondary" onClick={() => handleOpenConfigOverlay(env.id)} className="btn btn-secondary environment-card__command-btn" title="Edit mod configuration">
                  <Icon name="fas fa-cog" />
                  <span>Config</span>
                </SimmButton>
                <SimmButton variant="secondary" onClick={() => handleOpenLogsOverlay(env.id)} className="btn btn-secondary environment-card__command-btn" title="View MelonLoader logs">
                  <Icon name="fas fa-file-alt" />
                  <span>Logs</span>
                </SimmButton>
                <SimmButton variant="secondary" onClick={() => handleOpenPluginsOverlay(env.id)} className="btn btn-secondary environment-card__command-btn" title="View installed plugins">
                  <Icon name="fas fa-plug" />
                  <span>Plugins</span>
                </SimmButton>
                <SimmButton variant="secondary" onClick={() => handleOpenUserLibsOverlay(env.id)} className="btn btn-secondary environment-card__command-btn" title="View UserLibs">
                  <Icon name="fas fa-book" />
                  <span>UserLibs</span>
                </SimmButton>
                <SimmButton variant="secondary" onClick={() => handleOpenFolder(env)} className="btn btn-secondary environment-card__command-btn" title="Open folder in file explorer">
                  <Icon name="fas fa-folder-open" />
                  <span>Folder</span>
                </SimmButton>
                <SimmButton
                  variant="secondary"
                  onClick={() => handleUpdateAction(env)}
                  className={`btn btn-secondary environment-card__command-btn ${env.updateAvailable && !isSteam ? 'environment-card__command-btn--warning' : ''}`}
                  disabled={isCheckingUpdate}
                  title={isSteam ? 'Steam manages updates for this installation' : 'Check for updates and install if available'}
                >
                  <Icon name={isCheckingUpdate ? 'fas fa-spinner fa-spin' : isSteam ? 'fab fa-steam' : 'fas fa-rotate'} />
                  <span>{isCheckingUpdate ? 'Checking…' : 'Update'}</span>
                </SimmButton>
              </div>
            </>
          )}

          {prog && (
            <div className="progress-info environment-card__progress">
              <div className="progress-bar">
                <div className="progress-fill" style={{ width: `${Math.min(100, Math.max(0, prog.progress))}%` }} />
              </div>
              <p><strong>{Math.round(prog.progress)}%</strong>{prog.message ? ` • ${prog.message}` : ''}</p>
              {typeof prog.downloadedFiles === 'number' && typeof prog.totalFiles === 'number' && prog.totalFiles > 0 && (
                <p>Files: {prog.downloadedFiles} / {prog.totalFiles}</p>
              )}
              {prog.speed && <p>Speed: {prog.speed}</p>}
            </div>
          )}

          <div className="environment-card__footer">
            <div className="environment-card__path" title={env.outputDir}>
              <Icon name="fas fa-folder-open" />
              <span>{env.outputDir}</span>
            </div>
            {isCompleted && (
              <div className="environment-card__footer-meta">
                <span className="environment-footer-chip">
                  <Icon name={launchMethod === 'direct' ? 'fas fa-terminal' : 'fab fa-steam'} />
                  {launchMethod === 'direct' ? 'Local launch' : 'Steam launch'}
                </span>
                <SimmButton
                  type="button"
                  className="btn btn-secondary btn-small"
                  onClick={() => handleInstallMelonLoader(env)}
                  disabled={installingMelonLoader.has(env.id)}
                  title={mlStatus?.installed ? 'Change MelonLoader version' : 'Install MelonLoader'}
                >
                  <Icon name={installingMelonLoader.has(env.id) ? 'fas fa-spinner fa-spin' : 'fas fa-download'} />
                  <span>{mlStatus?.installed ? 'MelonLoader' : 'Install ML'}</span>
                </SimmButton>
              </div>
            )}
          </div>
        </div>
      </div>
    );
  };

  if (loading) {
    return <EnvironmentListSkeleton />;
  }

  if (error) {
    return <div className="error">Error: {error}</div>;
  }

  if (environments.length === 0) {
    return (
      <div className="empty-state">
        <p>No game installs yet. Create one to get started!</p>
        {onOpenWorkspace && (
          <SimmButton
            type="button"
            className="btn btn-primary"
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
    <div className="environment-list">
      <AuthenticationModal
        isOpen={authModal.isOpen}
        onClose={() => {
          if (!authModal.waiting) {
            setAuthModal({ isOpen: false, envId: null, waiting: false });
            setAuthCredentials(null);
          }
        }}
        onAuthenticated={handleAuthenticated}
        required={true}
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

        {logsOverlay.envId && (() => {
          const env = environments.find(e => e.id === logsOverlay.envId);
          return env ? (
            <LogsOverlay
              isOpen={logsOverlay.isOpen}
              onClose={handleCloseLogsOverlay}
              environmentId={logsOverlay.envId}
              environment={env}
            />
          ) : null;
        })()}

        {configOverlay.envId && (() => {
          const env = environments.find(e => e.id === configOverlay.envId);
          return env ? (
            <ConfigurationOverlay
              isOpen={configOverlay.isOpen}
              onClose={handleCloseConfigOverlay}
              environmentId={configOverlay.envId}
              environment={env}
            />
          ) : null;
        })()}
      </Suspense>

      <ConfirmOverlay
        isOpen={confirmOverlay.isOpen}
        onClose={() => setConfirmOverlay({ isOpen: false, title: '', message: '', onConfirm: () => {} })}
        onConfirm={confirmOverlay.onConfirm}
        title={confirmOverlay.title}
        message={confirmOverlay.message}
        confirmText={confirmOverlay.confirmText}
      />

      <ConfirmOverlay
        isOpen={deleteConfirm.isOpen && !!deleteConfirm.env}
        onClose={resetDeleteConfirm}
        onConfirm={handleConfirmDelete}
        title={deleteConfirm.env && isSteamEnvironment(deleteConfirm.env) ? 'Clear Environment Records' : 'Remove Environment'}
        message={
          deleteConfirm.env && isSteamEnvironment(deleteConfirm.env)
            ? `Clear tracked mod, plugin, and UserLib records for "${deleteConfirm.env.name}"?`
            : `Remove "${deleteConfirm.env?.name}" from SIMM?`
        }
        confirmText={
          deleteConfirm.env && isSteamEnvironment(deleteConfirm.env)
            ? 'Clear Records'
            : deleteConfirm.deleteFiles
              ? 'Delete Files and Remove'
              : 'Remove from App'
        }
        tone="danger"
        bodyContent={deleteConfirm.env && isSteamEnvironment(deleteConfirm.env) ? (
          <div className="app-dialog__option-copy">
            <span>Steam manages the installation itself. This only clears SIMM tracking for mods, plugins, and runtime files.</span>
          </div>
        ) : (
          <label className="app-dialog__option">
            <Checkbox
              checked={deleteConfirm.deleteFiles}
              onCheckedChange={(checked) => setDeleteConfirm((previous) => ({ ...previous, deleteFiles: !!checked }))}
            />
            <span className="app-dialog__option-copy">
              <strong>Also delete game files from disk</strong>
              <span>Leave this off to remove the environment from SIMM while keeping the files in place.</span>
            </span>
          </label>
        )}
      />

      <MessageOverlay
        isOpen={messageOverlay.isOpen}
        onClose={() => setMessageOverlay({ isOpen: false, title: '', message: '', type: 'info' })}
        title={messageOverlay.title}
        message={messageOverlay.message}
        type={messageOverlay.type}
      />

      {/* MelonLoader Version Selector Modal */}
      {showMelonLoaderVersionSelector && (
        <Dialog open={!!showMelonLoaderVersionSelector} onOpenChange={(open) => {
          if (!open) {
            closeMelonLoaderVersionSelector();
          }
        }}>
          <SimmDialogContent
            className="melonloader-dialog"
            showCloseButton={false}
          >
            <DialogHeader className="modal-header">
              <DialogTitle>Select MelonLoader Version</DialogTitle>
              <SimmButton variant="ghost" size="icon-sm" className="modal-close" onClick={closeMelonLoaderVersionSelector} aria-label="Close MelonLoader version selector">×</SimmButton>
            </DialogHeader>

            <div className="melonloader-dialog__body">
                <div className="melonloader-dialog__overview">
                  <div className="melonloader-dialog__copy">
                    <span className="workspace-section-eyebrow">MelonLoader</span>
                    <h3>{melonLoaderSelectorEnvironment?.name || 'Environment version selection'}</h3>
                    <p>
                      Choose the MelonLoader release to install or switch to for this environment. Stable is based on the latest
                      stable GitHub release tag.
                    </p>
                  </div>
                  <div className="melonloader-dialog__stats">
                    <div className="melonloader-dialog__stat-card">
                      <span className="melonloader-dialog__stat-label">Installed</span>
                      <strong className="melonloader-dialog__stat-value">{currentMelonLoaderVersion}</strong>
                    </div>
                    <div className="melonloader-dialog__stat-card">
                      <span className="melonloader-dialog__stat-label">Selected</span>
                      <strong className="melonloader-dialog__stat-value">{selectedMelonLoaderTag || 'Choose a release'}</strong>
                    </div>
                    <div className="melonloader-dialog__stat-card">
                      <span className="melonloader-dialog__stat-label">Source</span>
                      <strong className="melonloader-dialog__stat-value">GitHub</strong>
                    </div>
                  </div>
                </div>

              {loadingMelonLoaderReleases.has(showMelonLoaderVersionSelector) ? (
                <div className="melonloader-dialog__empty">
                  <Icon name="fas fa-spinner fa-spin melonloader-dialog__empty-icon" />
                  <p>Loading releases...</p>
                </div>
              ) : melonLoaderSelectorReleases.length === 0 ? (
                <div className="melonloader-dialog__empty">
                  <p>No releases found</p>
                </div>
              ) : (
                <>
                  <div className="melonloader-dialog__list">
                    <RadioGroup
                      className="melonloader-dialog__release-grid"
                      value={selectedMelonLoaderTag}
                      onValueChange={(value) => setSelectedMelonLoaderVersion(prev => {
                        const next = new Map(prev);
                        next.set(showMelonLoaderVersionSelector, value);
                        return next;
                      })}
                    >
                      {melonLoaderSelectorReleases.map((release) => (
                        <label
                          key={release.tag_name}
                          className={`melonloader-dialog__release-row ${
                            selectedMelonLoaderTag === release.tag_name ? 'melonloader-dialog__release-row--selected' : ''
                          }`}
                        >
                          <RadioGroupItem
                            value={release.tag_name}
                            className="melonloader-dialog__radio"
                          />
                          <div className="melonloader-dialog__release-content">
                            <div className="melonloader-dialog__release-header">
                              <strong>{release.tag_name}</strong>
                              {/* Show "Stable" tag for the latest stable tag returned by the Lockwire API. */}
                              {release.tag_name === latestStableMelonLoaderTag && (
                                <span className="melonloader-dialog__tag melonloader-dialog__tag--stable">
                                  Stable
                                </span>
                              )}
                              {release.isNightly ? (
                                <span className="melonloader-dialog__tag melonloader-dialog__tag--nightly">
                                  Alpha-Nightly
                                </span>
                              ) : release.prerelease && release.tag_name !== latestStableMelonLoaderTag && (
                                <span className="melonloader-dialog__tag melonloader-dialog__tag--beta">
                                  Beta
                                </span>
                              )}
                            </div>
                            {release.name && (
                              <div className="melonloader-dialog__release-name">
                                {release.name}
                              </div>
                            )}
                            <div className="melonloader-dialog__release-meta">
                              <div>
                                Published: {new Date(release.published_at).toLocaleDateString()}
                              </div>
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
                                title={release.isNightly ? "View GitHub Actions" : "View release page and changelog"}
                              >
                                <Icon name="fas fa-external-link-alt" />
                                {release.isNightly ? 'View Actions' : 'View Release & Changelog'}
                              </a>
                            </div>
                          </div>
                        </label>
                      ))}
                    </RadioGroup>
                  </div>

                  <div className="melonloader-dialog__footer">
                    <SimmButton
                      className="btn btn-secondary"
                      onClick={closeMelonLoaderVersionSelector}
                    >
                      Cancel
                    </SimmButton>
                    <SimmButton
                      className="btn btn-primary"
                      onClick={() => handleMelonLoaderVersionSelected(showMelonLoaderVersionSelector)}
                      disabled={!selectedMelonLoaderVersion.get(showMelonLoaderVersionSelector) || installingMelonLoader.has(showMelonLoaderVersionSelector)}
                    >
                      {installingMelonLoader.has(showMelonLoaderVersionSelector) ? (
                        <>
                          <Icon name="fas fa-spinner fa-spin" />
                          Installing...
                        </>
                      ) : (
                        <>
                          <Icon name="fas fa-download" />
                          {currentMelonLoaderVersion === 'Not installed' ? 'Install' : 'Change Version'}
                        </>
                      )}
                    </SimmButton>
                  </div>
                </>
              )}
            </div>
          </SimmDialogContent>
        </Dialog>
      )}

      <div className="environments-grid">
        {sortEnvironmentsForDisplay(environments).map(renderEnvironmentCard)}
      </div>

      {environmentMenu && (() => {
        const env = environments.find((item) => item.id === environmentMenu.envId);
        if (!env) return null;

        const items = [...buildEnvironmentMenuItems(env)];
        if (env.status === 'completed') {
          items.splice(4, 0, {
            key: 'refresh-version',
            label: 'Refresh Game Version',
            icon: 'fas fa-sync-alt',
            onSelect: async () => {
              try {
                await refreshGameVersion(env.id);
              } catch (err) {
                console.error('Failed to refresh game version:', err);
              }
            },
          });
        }

        return (
          <AnchoredContextMenu
            x={environmentMenu.x}
            y={environmentMenu.y}
            items={items}
            onClose={() => setEnvironmentMenu(null)}
          />
        );
      })()}
    </div>
  );
}
