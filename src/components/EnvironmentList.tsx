import { useState, useEffect, useRef, useCallback } from 'react';
import { useEnvironmentStore } from '../stores/environmentStore';
import { useSettingsStore } from '../stores/settingsStore';
import type { Environment } from '../types';
import { AuthenticationModal } from './AuthenticationModal';
import { ModsOverlay } from './ModsOverlay';
import { PluginsOverlay } from './PluginsOverlay';
import { UserLibsOverlay } from './UserLibsOverlay';
import { LogsOverlay } from './LogsOverlay';
import { ConfigurationOverlay } from './ConfigurationOverlay';
import { MessageOverlay } from './MessageOverlay';
import { ConfirmOverlay } from './ConfirmOverlay';
import { AnchoredContextMenu, type AnchoredContextMenuItem } from './AnchoredContextMenu';
import { ApiService } from '../services/api';
import { buildEnvironmentModSnapshot } from '../services/modLibrarySummary';
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

function isSteamEnvironment(env: Pick<Environment, 'environmentType' | 'id'>): boolean {
  return env.environmentType === 'Steam' || env.environmentType === 'steam' || env.id.startsWith('steam-');
}

// Shared ref to track last update check time (accessible across components)
// This is exported so Footer can update it when doing manual checks
export const lastUpdateCheckTimeRef = { current: null as number | null };
export const batchUpdateCheckRef = { current: false };
export const batchUpdateCheckEventName = 'simm:batch-update-check-started';
const LAST_ENV_KEY = 'simm:lastEnvId';

export function notifyBatchUpdateCheckStarted(environmentIds: string[]) {
  window.dispatchEvent(new CustomEvent(batchUpdateCheckEventName, {
    detail: { environmentIds }
  }));
}

interface EnvironmentListProps {
  onInitialDetectionComplete?: () => void;
  compactMode?: boolean;
  activeWorkspace?: WorkspaceRoute;
  onOpenWorkspace?: (workspace: Exclude<WorkspaceRoute, { view: 'home' }>) => void;
  onSelectEnvironment?: (environmentId: string) => void;
}

export type WorkspaceRoute =
  | { view: 'home' }
  | { view: 'library'; initialTab?: 'discover' | 'library' | 'updates' }
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
  const [modsOverlay, setModsOverlay] = useState<{ isOpen: boolean; envId: string | null }>({ isOpen: false, envId: null });
  const [pluginsOverlay, setPluginsOverlay] = useState<{ isOpen: boolean; envId: string | null }>({ isOpen: false, envId: null });
  const [userLibsOverlay, setUserLibsOverlay] = useState<{ isOpen: boolean; envId: string | null }>({ isOpen: false, envId: null });
  const [logsOverlay, setLogsOverlay] = useState<{ isOpen: boolean; envId: string | null }>({ isOpen: false, envId: null });
  const [configOverlay, setConfigOverlay] = useState<{ isOpen: boolean; envId: string | null }>({ isOpen: false, envId: null });
  const [modsCounts, setModsCounts] = useState<Map<string, number>>(new Map());
  const [coreToolCounts, setCoreToolCounts] = useState<Map<string, number>>(new Map());
  const [modUpdatesCounts, setModUpdatesCounts] = useState<Map<string, number>>(new Map());
  const [pluginsCounts, setPluginsCounts] = useState<Map<string, number>>(new Map());
  const [userLibsCounts, setUserLibsCounts] = useState<Map<string, number>>(new Map());
  const [melonLoaderStatus, setMelonLoaderStatus] = useState<Map<string, { installed: boolean; version?: string }>>(new Map());
  const completedEnvironmentCount = environments.filter(env => env.status === 'completed').length;

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
  const [confirmOverlay, setConfirmOverlay] = useState<{ isOpen: boolean; title: string; message: string; onConfirm: () => void }>({ isOpen: false, title: '', message: '', onConfirm: () => {} });
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
          const env = environments.find(e => e.id === data.downloadId);
          if (env) {
            console.log(`MelonLoader installing for ${data.downloadId}: ${data.message}`);
          }
        });

        unlistenMelonLoaderInstalled = await onMelonLoaderInstalled(async (data) => {
          const env = environments.find(e => e.id === data.downloadId);
          if (env) {
            console.log(`MelonLoader installed for ${data.downloadId}: ${data.message}`);
            try {
              const statusResult = await ApiService.getMelonLoaderStatus(data.downloadId);
              setMelonLoaderStatus(prev => {
                const next = new Map(prev);
                next.set(data.downloadId, { installed: statusResult.installed, version: statusResult.version || data.version });
                return next;
              });
            } catch (err) {
              console.error('Failed to refresh MelonLoader status:', err);
            }
          }
        });

        unlistenMelonLoaderError = await onMelonLoaderError((data) => {
          const env = environments.find(e => e.id === data.downloadId);
          if (env) {
            showMessage('MelonLoader Install Failed', data.message, 'error');
          }
        });

        unlistenComplete = await onCompleteEvent(async ({ downloadId }) => {
          const env = environments.find(e => e.id === downloadId);
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
            .then((library) => {
              const snapshot = buildEnvironmentModSnapshot(library, data.environmentId);
              setModsCounts(prev => {
                const next = new Map(prev);
                next.set(data.environmentId, snapshot.userMods);
                return next;
              });
              setCoreToolCounts(prev => {
                const next = new Map(prev);
                next.set(data.environmentId, snapshot.coreTools);
                return next;
              });
              setModUpdatesCounts(prev => {
                const next = new Map(prev);
                next.set(data.environmentId, snapshot.updateCount);
                return next;
              });
            })
            .catch(() => {
              // Ignore summary refresh failures; counts will update on the next successful refresh.
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
                const snapshot = buildEnvironmentModSnapshot(library, data.environmentId);
                setModsCounts(prev => {
                  const next = new Map(prev);
                  next.set(data.environmentId, snapshot.userMods);
                  return next;
                });
                setCoreToolCounts(prev => {
                  const next = new Map(prev);
                  next.set(data.environmentId, snapshot.coreTools);
                  return next;
                });
                setModUpdatesCounts(prev => {
                  const next = new Map(prev);
                  next.set(data.environmentId, snapshot.updateCount);
                  return next;
                });
              } catch (err) {
                console.error('Failed to refresh mods count:', err);
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
      modsRefreshTimers.current.forEach(timer => clearTimeout(timer));
      pluginsRefreshTimers.current.forEach(timer => clearTimeout(timer));
      userLibsRefreshTimers.current.forEach(timer => clearTimeout(timer));
      modsRefreshTimers.current.clear();
      pluginsRefreshTimers.current.clear();
      userLibsRefreshTimers.current.clear();
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

  const handleLaunchGame = async (env: Environment, method: 'steam' | 'direct' = 'steam') => {
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
      showMessage('Launch Failed', `Failed to launch game: ${err instanceof Error ? err.message : 'Unknown error'}`, 'error');
    }
  };

  // Load mods count, plugins count, userlibs count, and MelonLoader status for completed environments
  useEffect(() => {
    const loadCounts = async () => {
      const modCounts = new Map<string, number>();
      const coreToolCountsMap = new Map<string, number>();
      const modUpdatesCountsMap = new Map<string, number>();
      const pluginCounts = new Map<string, number>();
      const userLibsCounts = new Map<string, number>();
      const melonLoaderStatuses = new Map<string, { installed: boolean; version?: string }>();
      let library = null;
      try {
        library = await ApiService.getModLibrary();
      } catch {
        library = null;
      }
      for (const env of environments) {
        if (env.status === 'completed') {
          const modSnapshot = buildEnvironmentModSnapshot(library, env.id);
          modCounts.set(env.id, modSnapshot.userMods);
          coreToolCountsMap.set(env.id, modSnapshot.coreTools);
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
      setCoreToolCounts(coreToolCountsMap);
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
          .then((library) => {
            const snapshot = buildEnvironmentModSnapshot(library, env.id);
            setModsCounts(prev => {
              const next = new Map(prev);
              next.set(env.id, snapshot.userMods);
              return next;
            });
            setCoreToolCounts(prev => {
              const next = new Map(prev);
              next.set(env.id, snapshot.coreTools);
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
            setCoreToolCounts(prev => {
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

  // Component for Steam icon with text fallback
  const SteamBadge = () => {
    const iconRef = useRef<HTMLElement>(null);
    const [showFallback, setShowFallback] = useState(false);

    useEffect(() => {
      // Check if FontAwesome icon loaded by verifying it has content/width
      if (iconRef.current) {
        const checkIcon = () => {
          const style = window.getComputedStyle(iconRef.current!);
          const width = parseFloat(style.width);
          const fontFamily = style.fontFamily;
          // FontAwesome icons should have a width > 0 and font-family containing "Font Awesome"
          const faLoaded = (width > 0 || fontFamily.includes('Font Awesome') || fontFamily.includes('FontAwesome'));
          setShowFallback(!faLoaded);
        };

        // Check after a short delay to allow FontAwesome to load
        const timeout = setTimeout(checkIcon, 150);
        return () => clearTimeout(timeout);
      }
    }, []);

    return (
      <span
        className="badge badge-blue environment-card__steam-badge"
        title="Steam-managed installation"
      >
        {!showFallback && <i ref={iconRef} className="fab fa-steam"></i>}
        {showFallback && <span>Steam</span>}
      </span>
    );
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
    const currentMethod = preferredLaunchMethod.get(env.id) || 'steam';
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
    const launchMethod = preferredLaunchMethod.get(env.id) || 'steam';
    const modCount = modsCounts.get(env.id) ?? 0;
    const coreToolCount = coreToolCounts.get(env.id) ?? 0;
    const modUpdateCount = modUpdatesCounts.get(env.id) ?? 0;
    const pluginCount = pluginsCounts.get(env.id) ?? 0;
    const userLibsCount = userLibsCounts.get(env.id) ?? 0;
    const mlStatus = melonLoaderStatus.get(env.id);
    const metrics = [
      { label: 'Version', value: isCompleted ? (env.currentGameVersion || 'Unknown') : 'Not installed' },
      {
        label: 'Mods',
        value: isCompleted
          ? `${modCount}${coreToolCount > 0 ? ` (+${coreToolCount} ${coreToolCount === 1 ? 'Tool' : 'Tools'})` : ''}${modUpdateCount > 0 ? ` (${modUpdateCount} ${modUpdateCount === 1 ? 'Update' : 'Updates'})` : ''}`
          : 'Unavailable',
        tone: modUpdateCount > 0 ? 'warning' : undefined,
        onClick: isCompleted && modUpdateCount > 0 ? () => handleOpenModUpdatesOverlay(env.id) : undefined,
        title: coreToolCount > 0
          ? `${modCount} user mods, ${coreToolCount} SIMM-managed core tool${coreToolCount === 1 ? '' : 's'}`
          : undefined,
      },
      { label: 'Plugins', value: isCompleted ? `${pluginCount}` : 'Unavailable' },
      { label: 'UserLibs', value: isCompleted ? `${userLibsCount}` : 'Unavailable' },
      { label: 'MelonLoader', value: isCompleted ? (mlStatus?.installed ? `Installed${mlStatus.version ? ` (${mlStatus.version})` : ''}` : 'Not installed') : 'Unavailable' },
      { label: 'Last checked', value: isCheckingUpdate ? 'Checking…' : formatLastChecked(env.lastUpdateCheck) },
    ];

    return (
      <div
        key={env.id}
        className="environment-card environment-card--workspace"
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
              <input
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
                <button onClick={() => handleSaveName(env.id)} className="btn btn-primary btn-small" title="Save name">
                  <i className="fas fa-check"></i>
                </button>
                <button onClick={handleCancelEditName} className="btn btn-secondary btn-small" title="Cancel">
                  <i className="fas fa-times"></i>
                </button>
              </div>
            </div>
          ) : (
            <>
              <div className="environment-card__title-row">
                <div className="name-display environment-card__title-group">
                  <h3>{env.name}</h3>
                  <button onClick={() => handleStartEditName(env)} className="btn-edit-name" title="Rename environment">
                    <i className="fas fa-edit"></i>
                  </button>
                </div>
                <div className="environment-card__header-actions">
                  <span className={`environment-state-pill environment-state-pill--${status.tone}`}>
                    <i className={status.icon}></i>
                    {status.label}
                  </span>
                  <button
                    type="button"
                    className="btn btn-secondary btn-small environment-card__overflow-button"
                    onClick={(event) => {
                      const rect = event.currentTarget.getBoundingClientRect();
                      openEnvironmentMenu(env.id, rect.right - 8, rect.bottom + 6);
                    }}
                    aria-label={`More actions for ${env.name}`}
                  >
                    <i className="fas fa-ellipsis-h"></i>
                  </button>
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
              <textarea
                value={descriptionValue}
                onChange={(e) => setDescriptionValue(e.target.value)}
                placeholder="Describe what this version means..."
                className="description-input"
                rows={2}
                autoFocus
              />
              <div className="description-actions">
                <button onClick={() => handleSaveDescription(env.id)} className="btn btn-primary btn-small" title="Save description">
                  <i className="fas fa-check"></i>
                </button>
                <button onClick={handleCancelEditDescription} className="btn btn-secondary btn-small" title="Cancel">
                  <i className="fas fa-times"></i>
                </button>
              </div>
            </div>
          ) : (
            <div className="description-display environment-card__description-display">
              <span className="description-text">
                {env.description || <span className="description-placeholder">No description</span>}
              </span>
              <button onClick={() => handleStartEditDescription(env)} className="btn-edit-description" title="Edit description">
                <i className="fas fa-edit"></i>
              </button>
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
            <div className="environment-metric environment-metric--warning">
              <span>Available update</span>
              <strong>{env.updateGameVersion}</strong>
            </div>
          )}
        </div>

        <div className="environment-card__action-group">
          {!isDownloading && !isCompleted && (
            <div className="environment-card__action-row environment-card__action-row--single">
              <button onClick={() => handleStartDownload(env)} className="btn btn-primary">
                <i className="fas fa-download"></i>
                <span>Download</span>
              </button>
            </div>
          )}

          {isDownloading && (
            <div className="environment-card__action-row environment-card__action-row--single">
              <button onClick={() => handleCancelDownload(env)} className="btn btn-secondary">
                <i className="fas fa-ban"></i>
                <span>Cancel Download</span>
              </button>
            </div>
          )}

          {isCompleted && (
            <>
              <div className="environment-card__action-row environment-card__action-row--primary">
                <button
                  onClick={() => handleLaunchGame(env, launchMethod)}
                  className="btn btn-primary"
                  title={`Launch the game via ${launchMethod === 'direct' ? 'Local Install' : 'Steam'}`}
                >
                  <i className="fas fa-play"></i>
                  <span>Launch</span>
                </button>
                <button onClick={() => handleOpenModsOverlay(env.id)} className="btn btn-secondary" title="Open installed mods">
                  <i className="fas fa-puzzle-piece"></i>
                  <span>Mods</span>
                </button>
                <button onClick={() => handleOpenConfigOverlay(env.id)} className="btn btn-secondary" title="Edit mod configuration">
                  <i className="fas fa-cog"></i>
                  <span>Config</span>
                </button>
                <button onClick={() => handleOpenLogsOverlay(env.id)} className="btn btn-secondary" title="View MelonLoader logs">
                  <i className="fas fa-file-alt"></i>
                  <span>Logs</span>
                </button>
              </div>

              <div className="environment-card__action-row environment-card__action-row--secondary">
                <button onClick={() => handleOpenPluginsOverlay(env.id)} className="btn btn-secondary" title="View installed plugins">
                  <i className="fas fa-plug"></i>
                  <span>Plugins</span>
                </button>
                <button onClick={() => handleOpenUserLibsOverlay(env.id)} className="btn btn-secondary" title="View UserLibs">
                  <i className="fas fa-book"></i>
                  <span>UserLibs</span>
                </button>
                <button onClick={() => handleOpenFolder(env)} className="btn btn-secondary" title="Open folder in file explorer">
                  <i className="fas fa-folder-open"></i>
                  <span>Open Folder</span>
                </button>
                <button
                  onClick={() => handleUpdateAction(env)}
                  className={`btn ${env.updateAvailable && !isSteam ? 'btn-primary' : 'btn-secondary'}`}
                  disabled={isCheckingUpdate}
                  title={isSteam ? 'Steam manages updates for this installation' : 'Check for updates and install if available'}
                >
                  <i className={isCheckingUpdate ? 'fas fa-spinner fa-spin' : isSteam ? 'fab fa-steam' : 'fas fa-rotate'}></i>
                  <span>{isCheckingUpdate ? 'Checking…' : 'Update'}</span>
                </button>
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
              <i className="fas fa-folder-open"></i>
              <span>{env.outputDir}</span>
            </div>
            {isCompleted && (
              <div className="environment-card__footer-meta">
                <span className="environment-footer-chip">
                  <i className={launchMethod === 'direct' ? 'fas fa-terminal' : 'fab fa-steam'}></i>
                  {launchMethod === 'direct' ? 'Local launch' : 'Steam launch'}
                </span>
                <button
                  type="button"
                  className="btn btn-secondary btn-small"
                  onClick={() => handleInstallMelonLoader(env)}
                  disabled={installingMelonLoader.has(env.id)}
                  title={mlStatus?.installed ? 'Change MelonLoader version' : 'Install MelonLoader'}
                >
                  <i className={installingMelonLoader.has(env.id) ? 'fas fa-spinner fa-spin' : 'fas fa-download'}></i>
                  <span>{mlStatus?.installed ? 'MelonLoader' : 'Install ML'}</span>
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    );
  };

  if (loading) {
    return <div className="loading">Loading game installs...</div>;
  }

  if (error) {
    return <div className="error">Error: {error}</div>;
  }

  if (environments.length === 0) {
    return (
      <div className="empty-state">
        <p>No game installs yet. Create one to get started!</p>
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
          {[...environments].sort((a, b) => a.name.localeCompare(b.name)).map((env) => (
            <div
              key={env.id}
              className="workspace-environment-sidebar__item"
            >
              <button
                onClick={() => {
                  rememberEnvironment(env.id);
                  onSelectEnvironment?.(env.id);
                }}
                className={`workspace-environment-sidebar__button ${selectedEnvironmentId === env.id ? 'workspace-environment-sidebar__button--active' : ''}`}
                title={env.name}
                aria-current={selectedEnvironmentId === env.id ? 'page' : undefined}
              >
                <span className="workspace-environment-sidebar__button-label">{env.name}</span>
              </button>
            </div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="environment-list">
      <div className="environment-list__header">
        <h2 className="environment-list__title">Game Installs</h2>
        <div className="environment-list__runtime-strip" aria-label="Supported runtimes">
          <span className="badge badge-orange-red environment-list__runtime-badge">Mono</span>
          <span className="badge badge-blue environment-list__runtime-badge">IL2CPP</span>
        </div>
      </div>

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

      {modsOverlay.envId && (
        <ModsOverlay
          isOpen={modsOverlay.isOpen}
          onClose={handleCloseModsOverlay}
          environmentId={modsOverlay.envId}
          onModsChanged={handleModsChanged}
          onModUpdatesChecked={(count) => {
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

      <ConfirmOverlay
        isOpen={confirmOverlay.isOpen}
        onClose={() => setConfirmOverlay({ isOpen: false, title: '', message: '', onConfirm: () => {} })}
        onConfirm={confirmOverlay.onConfirm}
        title={confirmOverlay.title}
        message={confirmOverlay.message}
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
            <input
              type="checkbox"
              checked={deleteConfirm.deleteFiles}
              onChange={(event) => setDeleteConfirm((previous) => ({ ...previous, deleteFiles: event.target.checked }))}
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
        <div className="modal-overlay" onClick={(e) => {
          if (e.target === e.currentTarget) {
            closeMelonLoaderVersionSelector();
          }
        }}>
          <div className="modal-content melonloader-dialog" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2>Select MelonLoader Version</h2>
              <button className="modal-close" onClick={closeMelonLoaderVersionSelector}>×</button>
            </div>

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
                  <i className="fas fa-spinner fa-spin melonloader-dialog__empty-icon"></i>
                  <p>Loading releases...</p>
                </div>
              ) : melonLoaderSelectorReleases.length === 0 ? (
                <div className="melonloader-dialog__empty">
                  <p>No releases found</p>
                </div>
              ) : (
                <>
                  <div className="melonloader-dialog__list">
                    <div className="melonloader-dialog__release-grid">
                      {melonLoaderSelectorReleases.map((release) => (
                        <label
                          key={release.tag_name}
                          className={`melonloader-dialog__release-row ${
                            selectedMelonLoaderTag === release.tag_name ? 'melonloader-dialog__release-row--selected' : ''
                          }`}
                        >
                          <input
                            type="radio"
                            name="melonLoaderVersion"
                            value={release.tag_name}
                            checked={selectedMelonLoaderTag === release.tag_name}
                            onChange={(e) => setSelectedMelonLoaderVersion(prev => {
                              const next = new Map(prev);
                              next.set(showMelonLoaderVersionSelector, e.target.value);
                              return next;
                            })}
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
                                <i className="fas fa-external-link-alt"></i>
                                {release.isNightly ? 'View Actions' : 'View Release & Changelog'}
                              </a>
                            </div>
                          </div>
                        </label>
                      ))}
                    </div>
                  </div>

                  <div className="melonloader-dialog__footer">
                    <button
                      className="btn btn-secondary"
                      onClick={closeMelonLoaderVersionSelector}
                    >
                      Cancel
                    </button>
                    <button
                      className="btn btn-primary"
                      onClick={() => handleMelonLoaderVersionSelected(showMelonLoaderVersionSelector)}
                      disabled={!selectedMelonLoaderVersion.get(showMelonLoaderVersionSelector) || installingMelonLoader.has(showMelonLoaderVersionSelector)}
                    >
                      {installingMelonLoader.has(showMelonLoaderVersionSelector) ? (
                        <>
                          <i className="fas fa-spinner fa-spin"></i>
                          Installing...
                        </>
                      ) : (
                        <>
                          <i className="fas fa-download"></i>
                          {currentMelonLoaderVersion === 'Not installed' ? 'Install' : 'Change Version'}
                        </>
                      )}
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      )}

      <div className="environments-grid">
        {[...environments].sort((a, b) => {
          const aIsSteam = isSteamEnvironment(a);
          const bIsSteam = isSteamEnvironment(b);
          if (aIsSteam && !bIsSteam) return -1;
          if (!aIsSteam && bIsSteam) return 1;
          return 0;
        }).map(renderEnvironmentCard)}
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
