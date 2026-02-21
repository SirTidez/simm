import React, { useState, useEffect, useRef, useCallback } from 'react';
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
import { ApiService } from '../services/api';
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

// Shared ref to track last update check time (accessible across components)
// This is exported so Footer can update it when doing manual checks
export const lastUpdateCheckTimeRef = { current: null as number | null };
export const batchUpdateCheckRef = { current: false };
const LAST_ENV_KEY = 'simm:lastEnvId';

interface EnvironmentListProps {
  onInitialDetectionComplete?: () => void;
}

export function EnvironmentList({ onInitialDetectionComplete }: EnvironmentListProps) {
  const { environments, loading, error, progress, startDownload, cancelDownload, deleteEnvironment, checkUpdate, checkAllUpdates, updateEnvironment, refreshGameVersion } = useEnvironmentStore();
  const { settings } = useSettingsStore();
  const autoCheckIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const [authModal, setAuthModal] = useState<{ isOpen: boolean; envId: string | null; waiting: boolean; message?: string }>({ isOpen: false, envId: null, waiting: false });
  const [authCredentials, setAuthCredentials] = useState<{ username: string; password: string; steamGuard: string; saveCredentials: boolean } | null>(null);
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
  const [modUpdatesCounts, setModUpdatesCounts] = useState<Map<string, number>>(new Map());
  const [pluginsCounts, setPluginsCounts] = useState<Map<string, number>>(new Map());
  const [userLibsCounts, setUserLibsCounts] = useState<Map<string, number>>(new Map());
  const [melonLoaderStatus, setMelonLoaderStatus] = useState<Map<string, { installed: boolean; version?: string }>>(new Map());
  const completedEnvironmentCount = environments.filter(env => env.status === 'completed').length;

  // Debounce timers for filesystem change events
  const modsRefreshTimers = useRef<Map<string, NodeJS.Timeout>>(new Map());
  const pluginsRefreshTimers = useRef<Map<string, NodeJS.Timeout>>(new Map());
  const userLibsRefreshTimers = useRef<Map<string, NodeJS.Timeout>>(new Map());

  // Use refs to access latest environments without causing effect re-runs
  const environmentsRef = useRef(environments);
  useEffect(() => {
    environmentsRef.current = environments;
  }, [environments]);
  const initialUpdateCheckDoneRef = useRef(false);
  const [melonLoaderLatestRelease, setMelonLoaderLatestRelease] = useState<Map<string, {
    tag_name: string;
    name: string;
    published_at: string;
    prerelease: boolean;
    download_url: string | null;
  }>>(new Map());
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
  const [launchDropdownOpen, setLaunchDropdownOpen] = useState<string | null>(null);
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

  const handleStartDownload = async (env: Environment) => {
    try {
      rememberEnvironment(env.id);
      // Check if we have credentials
      const hasCredentials = settings?.steamUsername;

      if (!hasCredentials) {
        // Show authentication modal
        setAuthModal({ isOpen: true, envId: env.id });
        return;
      }

      // Try to start download
      await startDownload(env.id);
    } catch (err: any) {
      // Check if error indicates authentication is required
      if (err?.response?.data?.requiresAuth || err?.message?.includes('authentication')) {
        setAuthModal({ isOpen: true, envId: env.id });
      } else {
        alert(`Failed to start download: ${err instanceof Error ? err.message : 'Unknown error'}`);
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
      alert(`Failed to start download: ${err instanceof Error ? err.message : 'Unknown error'}`);
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

    try {
      batchUpdateCheckRef.current = true;
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
            alert(`Authentication failed: ${data.error}`);
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
            alert(`MelonLoader installation failed: ${data.message}`);
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
          const completedEnvIds = environments
            .filter(env => env.status === 'completed')
            .map(env => env.id);
          setCheckingEnvironments(new Set(completedEnvIds));
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
          setModUpdatesCounts(prev => {
            const next = new Map(prev);
            next.set(data.environmentId, data.count);
            return next;
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
                const [result, modUpdatesResult] = await Promise.all([
                  ApiService.getModsCount(data.environmentId),
                  ApiService.getModUpdatesSummary(data.environmentId)
                ]);
                setModsCounts(prev => {
                  const next = new Map(prev);
                  next.set(data.environmentId, result.count);
                  return next;
                });
                setModUpdatesCounts(prev => {
                  const next = new Map(prev);
                  next.set(data.environmentId, modUpdatesResult.count);
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

    // Close dropdown when clicking outside
    const handleClickOutside = (event: MouseEvent) => {
      if (launchDropdownOpen && !(event.target as Element).closest('[data-launch-dropdown]')) {
        setLaunchDropdownOpen(null);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
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
  }, [authModal.isOpen, authModal.envId, environments, progress, launchDropdownOpen]);

  const handleCancelDownload = async (env: Environment) => {
    try {
      await cancelDownload(env.id);
    } catch (err) {
      alert(`Failed to cancel download: ${err instanceof Error ? err.message : 'Unknown error'}`);
    }
  };

  const handleDelete = (env: Environment) => {
    setDeleteConfirm({ isOpen: true, env, deleteFiles: false });
  };

  const handleConfirmDelete = async () => {
    if (!deleteConfirm.env) return;
    const env = deleteConfirm.env;
    const deleteFiles = deleteConfirm.deleteFiles;
    setDeleteConfirm({ isOpen: false, env: null, deleteFiles: false });

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
    if (env.environmentType === 'Steam' || env.environmentType === 'steam' || env.id.startsWith('steam-')) {
      alert('Steam manages updates for this installation. Please update through Steam.');
      return;
    }
    // Start the download to update to the latest version
    await handleStartDownload(env);
  };

  const handleManualUpdateCheck = async (env: Environment) => {
    if (checkingEnvironments.has(env.id)) {
      return;
    }
    rememberEnvironment(env.id);
    batchUpdateCheckRef.current = false;
    setCheckingEnvironments(prev => new Set(prev).add(env.id));
    try {
      await checkUpdate(env.id, true);
    } catch (err) {
      console.error(`Failed to check for updates for ${env.id}:`, err);
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
      alert(`Failed to save description: ${err instanceof Error ? err.message : 'Unknown error'}`);
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
        alert('Environment name cannot be empty');
        return;
      }
      await updateEnvironment(envId, { name: trimmedName });
      setEditingName(null);
      setNameValue('');
    } catch (err) {
      alert(`Failed to save name: ${err instanceof Error ? err.message : 'Unknown error'}`);
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
      alert(`Failed to open folder: ${err instanceof Error ? err.message : 'Unknown error'}`);
    }
  };

  const handleLaunchGame = async (env: Environment, method: 'steam' | 'direct' = 'steam') => {
    try {
      const result = await ApiService.launchGame(env.id, method);
      if (!result.success) {
        alert(`Failed to launch game: ${result.executablePath ? `Executable found at ${result.executablePath} but launch failed.` : 'Game executable not found.'}`);
      }
    } catch (err) {
      alert(`Failed to launch game: ${err instanceof Error ? err.message : 'Unknown error'}`);
    }
  };

  // Load mods count, plugins count, userlibs count, and MelonLoader status for completed environments
  useEffect(() => {
    const loadCounts = async () => {
      const modCounts = new Map<string, number>();
      const modUpdatesCountsMap = new Map<string, number>();
      const pluginCounts = new Map<string, number>();
      const userLibsCounts = new Map<string, number>();
      const melonLoaderStatuses = new Map<string, { installed: boolean; version?: string }>();
      for (const env of environments) {
        if (env.status === 'completed') {
          try {
            const result = await ApiService.getModsCount(env.id);
            modCounts.set(env.id, result.count);
          } catch {
            modCounts.set(env.id, 0);
          }
          try {
            const modUpdatesResult = await ApiService.getModUpdatesSummary(env.id);
            modUpdatesCountsMap.set(env.id, modUpdatesResult.count);
          } catch {
            modUpdatesCountsMap.set(env.id, 0);
          }
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
      setModUpdatesCounts(modUpdatesCountsMap);
      setPluginsCounts(pluginCounts);
      setUserLibsCounts(userLibsCounts);
      setMelonLoaderStatus(melonLoaderStatuses);

      // Load releases for environments with MelonLoader installed (so we can show/hide the Change Version button)
      for (const env of environments) {
        if (env.status === 'completed' && melonLoaderStatuses.get(env.id)?.installed) {
          // Load releases in background (don't await, let it happen async)
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
    setModsOverlay({ isOpen: true, envId });
  };

  const handleModsChanged = () => {
    // Refresh mods count and mod updates when mods are changed
    if (modsOverlay.envId) {
      const env = environments.find(e => e.id === modsOverlay.envId);
      if (env && env.status === 'completed') {
        Promise.all([
          ApiService.getModsCount(env.id),
          ApiService.getModUpdatesSummary(env.id)
        ])
          .then(([result, modUpdatesResult]) => {
            setModsCounts(prev => {
              const next = new Map(prev);
              next.set(env.id, result.count);
              return next;
            });
            setModUpdatesCounts(prev => {
              const next = new Map(prev);
              next.set(env.id, modUpdatesResult.count);
              return next;
            });
          })
          .catch(() => {
            setModsCounts(prev => {
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

  const handleOpenPluginsOverlay = (envId: string) => {
    rememberEnvironment(envId);
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
    setUserLibsOverlay({ isOpen: true, envId });
  };

  const handleOpenLogsOverlay = (envId: string) => {
    rememberEnvironment(envId);
    setLogsOverlay({ isOpen: true, envId });
  };

  const handleCloseLogsOverlay = () => {
    setLogsOverlay({ isOpen: false, envId: null });
  };

  const handleOpenConfigOverlay = (envId: string) => {
    rememberEnvironment(envId);
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
      // Set default selection to stable version (0.7.0) if available, otherwise first in list
      if (releases.length > 0) {
        // Find stable version - check if tag_name is "0.7.0" or starts with "0.7.0" and is not nightly
        const stableVersion = releases.find(r => {
          const tag = r.tag_name || '';
          return (tag === '0.7.0' || tag === 'v0.7.0' || tag.startsWith('0.7.0')) && !r.isNightly;
        });

        const defaultVersion = stableVersion ? stableVersion.tag_name : releases[0].tag_name;

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
        className="badge badge-blue"
        style={{
          marginRight: '0.5rem'
        }}
        title="Steam-managed installation"
      >
        {!showFallback && <i ref={iconRef} className="fab fa-steam"></i>}
        {showFallback && <span>Steam</span>}
      </span>
    );
  };

  const formatLastCheck = (dateValue?: string | number) => {
    if (!dateValue) return 'Never';
    try {
      // Handle both string dates and timestamp numbers (seconds or milliseconds)
      let date: Date;
      if (typeof dateValue === 'number') {
        // If it's a number, check if it's seconds (less than year 2000 in ms) or milliseconds
        // Timestamps after 2000-01-01 in seconds would be > 946684800
        // Timestamps after 2000-01-01 in milliseconds would be > 946684800000
        date = dateValue < 946684800000
          ? new Date(dateValue * 1000) // Convert seconds to milliseconds
          : new Date(dateValue); // Already in milliseconds
      } else {
        date = new Date(dateValue);
      }

      // Check if date is valid
      if (isNaN(date.getTime())) {
        return 'Invalid date';
      }

      const now = new Date();
      const diffMs = now.getTime() - date.getTime();
      const diffMins = Math.floor(diffMs / 60000);
      const diffHours = Math.floor(diffMs / 3600000);
      const diffDays = Math.floor(diffMs / 86400000);

      if (diffMins < 1) return 'Just now';
      if (diffMins < 60) return `${diffMins} minute${diffMins !== 1 ? 's' : ''} ago`;
      if (diffHours < 24) return `${diffHours} hour${diffHours !== 1 ? 's' : ''} ago`;
      return `${diffDays} day${diffDays !== 1 ? 's' : ''} ago`;
    } catch {
      return 'Unknown';
    }
  };

  const getStatusBadge = (env: Environment) => {
    const prog = progress.get(env.id);
    const status = prog?.status || env.status;

    const badges: Record<string, { text: string; className: string }> = {
      'not_downloaded': { text: 'Not Downloaded', className: 'badge-gray' },
      'downloading': { text: 'Downloading', className: 'badge-blue' },
      'validating': { text: 'Validating', className: 'badge-yellow' },
      'completed': { text: 'Ready', className: 'badge-green' },
      'unavailable': { text: 'Unavailable', className: 'badge-orange' },
      'error': { text: 'Error', className: 'badge-red' },
      'cancelled': { text: 'Cancelled', className: 'badge-gray' }
    };

    let badge = badges[status] || badges['not_downloaded'];

    // If status is completed and update is available, replace with update badge
    if (status === 'completed' && env.updateAvailable) {
      badge = { text: 'Update Available', className: 'badge-orange' };
    }

    const statusBadge = <span className={`badge ${badge.className}`}>{badge.text}</span>;

    // Check if this is a Steam environment (handle both 'Steam' and 'steam' cases)
    const isSteam = env.environmentType === 'Steam' || env.environmentType === 'steam' || env.id.startsWith('steam-');

    // Add Steam badge before status badge for Steam environments when completed
    // Show it regardless of update status (but only when showing Ready or Update Available badges)
    if (status === 'completed' && isSteam) {
      return (
        <>
          <SteamBadge />
          {statusBadge}
        </>
      );
    }

    return statusBadge;
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

  return (
    <div className="environment-list">
      <h2>Game Installs</h2>

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

      {/* Delete Confirmation Modal */}
      {deleteConfirm.isOpen && deleteConfirm.env && (
        <div className="modal-overlay" onClick={() => setDeleteConfirm({ isOpen: false, env: null, deleteFiles: false })}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()} style={{ maxWidth: '450px' }}>
            <div className="modal-header">
              <h2>Delete Environment</h2>
              <button className="modal-close" onClick={() => setDeleteConfirm({ isOpen: false, env: null, deleteFiles: false })}>×</button>
            </div>
            <div style={{ padding: '1.5rem' }}>
              <p style={{ marginBottom: '1rem', color: '#cccccc' }}>
                {deleteConfirm.env.environmentType === 'steam'
                  ? <>Clear tracked mod records for <strong>"{deleteConfirm.env.name}"</strong>?</>
                  : <>Are you sure you want to remove <strong>"{deleteConfirm.env.name}"</strong> from the manager?</>}
              </p>

              {(deleteConfirm.env.environmentType === 'depotDownloader' || deleteConfirm.env.environmentType === 'local') && (
                <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '1rem', cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={deleteConfirm.deleteFiles}
                    onChange={(e) => setDeleteConfirm(prev => ({ ...prev, deleteFiles: e.target.checked }))}
                    style={{ width: '18px', height: '18px' }}
                  />
                  <span style={{ color: '#ff6b6b' }}>Also delete game files from disk</span>
                </label>
              )}

              {deleteConfirm.env.environmentType === 'steam' && (
                <p style={{ fontSize: '0.85rem', color: '#888', marginBottom: '1rem' }}>
                  <i className="fas fa-info-circle" style={{ marginRight: '0.5rem' }}></i>
                  Steam manages this installation. This action clears mod/plugin tracking only.
                </p>
              )}

              <div style={{ display: 'flex', gap: '0.75rem', justifyContent: 'flex-end' }}>
                <button className="btn btn-secondary" onClick={() => setDeleteConfirm({ isOpen: false, env: null, deleteFiles: false })}>
                  Cancel
                </button>
                <button
                  className="btn"
                  style={{ backgroundColor: deleteConfirm.deleteFiles ? '#dc3545' : 'var(--primary-btn-color, #646cff)' }}
                  onClick={handleConfirmDelete}
                >
                  {deleteConfirm.env.environmentType === 'steam'
                    ? 'Clear Mod Records'
                    : (deleteConfirm.deleteFiles ? 'Delete Environment & Files' : 'Remove from Manager')}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

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
            setShowMelonLoaderVersionSelector(null);
            setSelectedMelonLoaderVersion(prev => {
              const next = new Map(prev);
              next.delete(showMelonLoaderVersionSelector);
              return next;
            });
          }
        }}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()} style={{ maxWidth: '600px' }}>
            <div className="modal-header">
              <h2>Select MelonLoader Version</h2>
              <button className="modal-close" onClick={() => {
                setShowMelonLoaderVersionSelector(null);
                setSelectedMelonLoaderVersion(prev => {
                  const next = new Map(prev);
                  next.delete(showMelonLoaderVersionSelector!);
                  return next;
                });
              }}>×</button>
            </div>

            <div style={{ padding: '1.25rem' }}>
              {loadingMelonLoaderReleases.has(showMelonLoaderVersionSelector) ? (
                <div style={{ padding: '2rem', textAlign: 'center', color: '#888' }}>
                  <i className="fas fa-spinner fa-spin" style={{ fontSize: '2rem', marginBottom: '1rem' }}></i>
                  <p>Loading releases...</p>
                </div>
              ) : (melonLoaderReleases.get(showMelonLoaderVersionSelector)?.length ?? 0) === 0 ? (
                <div style={{ padding: '2rem', textAlign: 'center', color: '#888' }}>
                  <p>No releases found</p>
                </div>
              ) : (
                <>
                  <div style={{ marginBottom: '1rem', maxHeight: '400px', overflowY: 'auto' }}>
                    <div style={{ display: 'grid', gap: '0.5rem' }}>
                      {melonLoaderReleases.get(showMelonLoaderVersionSelector)?.map((release) => (
                        <label
                          key={release.tag_name}
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            padding: '0.75rem',
                            backgroundColor: selectedMelonLoaderVersion.get(showMelonLoaderVersionSelector) === release.tag_name ? '#3a3a3a' : '#2a2a2a',
                            border: '1px solid',
                            borderColor: selectedMelonLoaderVersion.get(showMelonLoaderVersionSelector) === release.tag_name ? '#4a90e2' : '#3a3a3a',
                            borderRadius: '6px',
                            cursor: 'pointer',
                            transition: 'all 0.2s'
                          }}
                          onMouseEnter={(e) => {
                            if (selectedMelonLoaderVersion.get(showMelonLoaderVersionSelector) !== release.tag_name) {
                              e.currentTarget.style.backgroundColor = '#333';
                            }
                          }}
                          onMouseLeave={(e) => {
                            if (selectedMelonLoaderVersion.get(showMelonLoaderVersionSelector) !== release.tag_name) {
                              e.currentTarget.style.backgroundColor = '#2a2a2a';
                            }
                          }}
                        >
                          <input
                            type="radio"
                            name="melonLoaderVersion"
                            value={release.tag_name}
                            checked={selectedMelonLoaderVersion.get(showMelonLoaderVersionSelector) === release.tag_name}
                            onChange={(e) => setSelectedMelonLoaderVersion(prev => {
                              const next = new Map(prev);
                              next.set(showMelonLoaderVersionSelector, e.target.value);
                              return next;
                            })}
                            style={{ marginRight: '0.75rem', cursor: 'pointer' }}
                          />
                          <div style={{ flex: 1 }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.25rem' }}>
                              <strong style={{ color: '#fff' }}>{release.tag_name}</strong>
                              {/* Show "Stable" tag for v0.7.0 in green */}
                              {(release.tag_name === 'v0.7.0' || release.tag_name === '0.7.0') && (
                                <span style={{
                                  fontSize: '0.7rem',
                                  padding: '0.15rem 0.4rem',
                                  backgroundColor: '#28a74520',
                                  color: '#28a745',
                                  borderRadius: '4px',
                                  border: '1px solid #28a74540',
                                  fontWeight: '600'
                                }}>
                                  Stable
                                </span>
                              )}
                              {release.isNightly ? (
                                <span style={{
                                  fontSize: '0.7rem',
                                  padding: '0.15rem 0.4rem',
                                  backgroundColor: '#ff6b6b20',
                                  color: '#ff6b6b',
                                  borderRadius: '4px',
                                  border: '1px solid #ff6b6b40'
                                }}>
                                  Alpha-Nightly
                                </span>
                              ) : release.prerelease && (release.tag_name !== 'v0.7.0' && release.tag_name !== '0.7.0') && (
                                <span style={{
                                  fontSize: '0.7rem',
                                  padding: '0.15rem 0.4rem',
                                  backgroundColor: '#ffd70020',
                                  color: '#ffd700',
                                  borderRadius: '4px',
                                  border: '1px solid #ffd70040'
                                }}>
                                  Beta
                                </span>
                              )}
                            </div>
                            {release.name && (
                              <div style={{ fontSize: '0.85rem', color: '#aaa', marginBottom: '0.25rem' }}>
                                {release.name}
                              </div>
                            )}
                            <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' }}>
                              <div style={{ fontSize: '0.75rem', color: '#888' }}>
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
                                style={{
                                  fontSize: '0.75rem',
                                  color: '#4a90e2',
                                  textDecoration: 'none',
                                  display: 'inline-flex',
                                  alignItems: 'center',
                                  gap: '0.25rem',
                                  transition: 'color 0.2s'
                                }}
                                onMouseEnter={(e) => {
                                  e.currentTarget.style.color = '#6ba3f5';
                                  e.currentTarget.style.textDecoration = 'underline';
                                }}
                                onMouseLeave={(e) => {
                                  e.currentTarget.style.color = '#4a90e2';
                                  e.currentTarget.style.textDecoration = 'none';
                                }}
                                title={release.isNightly ? "View GitHub Actions" : "View release page and changelog"}
                              >
                                <i className="fas fa-external-link-alt" style={{ fontSize: '0.7rem' }}></i>
                                {release.isNightly ? 'View Actions' : 'View Release & Changelog'}
                              </a>
                            </div>
                          </div>
                        </label>
                      ))}
                    </div>
                  </div>

                  <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.5rem', marginTop: '1rem' }}>
                    <button
                      className="btn btn-secondary"
                      onClick={() => {
                        setShowMelonLoaderVersionSelector(null);
                        setSelectedMelonLoaderVersion(prev => {
                          const next = new Map(prev);
                          next.delete(showMelonLoaderVersionSelector);
                          return next;
                        });
                      }}
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
                          <i className="fas fa-spinner fa-spin" style={{ marginRight: '0.5rem' }}></i>
                          Installing...
                        </>
                      ) : (
                        <>
                          <i className="fas fa-download" style={{ marginRight: '0.5rem' }}></i>
                          Install
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
          const aIsSteam = a.environmentType === 'Steam' || a.environmentType === 'steam' || a.id.startsWith('steam-');
          const bIsSteam = b.environmentType === 'Steam' || b.environmentType === 'steam' || b.id.startsWith('steam-');
          // Steam environments always come first
          if (aIsSteam && !bIsSteam) return -1;
          if (!aIsSteam && bIsSteam) return 1;
          // For same type, maintain original order (by creation time/ID)
          return 0;
        }).map(env => {
          const prog = progress.get(env.id);
          const isDownloading = env.status === 'downloading' || prog?.status === 'downloading';
          const isSteam = env.environmentType === 'Steam' || env.environmentType === 'steam' || env.id.startsWith('steam-');

          return (
            <div key={env.id} className="environment-card">
              <div className="environment-header">
                {editingName === env.id ? (
                  <div className="name-editor">
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
                      <button
                        onClick={() => handleSaveName(env.id)}
                        className="btn btn-primary btn-small"
                        title="Save name"
                      >
                        <i className="fas fa-check"></i>
                      </button>
                      <button
                        onClick={handleCancelEditName}
                        className="btn btn-secondary btn-small"
                        title="Cancel"
                      >
                        <i className="fas fa-times"></i>
                      </button>
                    </div>
                  </div>
                ) : (
                  <>
                    <div className="name-display">
                <h3>{env.name}</h3>
                      <button
                        onClick={() => handleStartEditName(env)}
                        className="btn-edit-name"
                        title="Rename environment"
                      >
                        <i className="fas fa-edit"></i>
                      </button>
                    </div>
                <div className="environment-badges">
                  {getStatusBadge(env)}
                </div>
                  </>
                )}
              </div>
              <div className="environment-description">
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
                      <button
                        onClick={() => handleSaveDescription(env.id)}
                        className="btn btn-primary btn-small"
                        title="Save description"
                      >
                        <i className="fas fa-check"></i>
                      </button>
                      <button
                        onClick={handleCancelEditDescription}
                        className="btn btn-secondary btn-small"
                        title="Cancel"
                      >
                        <i className="fas fa-times"></i>
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="description-display">
                    <span className="description-text">
                      {env.description || <span className="description-placeholder">No description</span>}
                    </span>
                    <button
                      onClick={() => handleStartEditDescription(env)}
                      className="btn-edit-description"
                      title="Edit description"
                    >
                      <i className="fas fa-edit"></i>
                    </button>
                  </div>
                )}
              </div>
              <div className="environment-details">
                <p style={{ marginBottom: '0.75rem', width: '100%' }}><strong>Directory:</strong> <span className="detail-value detail-directory" title={env.outputDir}>{env.outputDir}</span></p>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', width: '100%', alignItems: 'center', marginBottom: '0.75rem', gap: '0.5rem' }}>
                  <span
                    className={`badge ${env.runtime?.toLowerCase() === 'mono' ? 'badge-orange-red' : 'badge-blue'}`}
                    style={{ display: 'inline-block', justifySelf: 'start' }}
                  >
                    {env.branch}
                  </span>
                  <span
                    className={`badge ${env.runtime?.toLowerCase() === 'mono' ? 'badge-orange-red' : 'badge-blue'}`}
                    style={{ display: 'inline-block', justifySelf: 'center' }}
                  >
                    {env.runtime}
                  </span>
                  <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', justifySelf: 'end' }}>
                    {env.status === 'completed' && env.currentGameVersion && (
                      <span
                        className={`badge ${env.updateAvailable === false ? 'badge-green' : env.updateAvailable === true ? 'badge-yellow' : 'badge-gray'}`}
                        style={{
                          display: 'inline-block',
                          fontWeight: env.updateAvailable === false ? 'bold' : 'normal'
                        }}
                      >
                        {env.currentGameVersion}
                      </span>
                    )}
                    {env.status === 'completed' && !env.currentGameVersion && (
                      <span className="badge badge-gray" style={{ display: 'inline-block' }}>
                        Unknown
                      </span>
                    )}
                    {env.updateAvailable && env.updateGameVersion && (
                      <span className="badge badge-yellow" style={{ display: 'inline-block' }}>
                        Update: {env.updateGameVersion}
                      </span>
                    )}
                    {env.status === 'completed' && (
                      <button
                        onClick={async (e) => {
                          e.stopPropagation();
                          try {
                            const version = await refreshGameVersion(env.id);
                            if (version) {
                              console.log(`Game version extracted: ${version}`);
                            } else {
                              console.log('No game version found');
                            }
                          } catch (err) {
                            console.error('Failed to refresh game version:', err);
                          }
                        }}
                        className="btn btn-secondary"
                        style={{
                          padding: '0.25rem 0.5rem',
                          fontSize: '0.75rem',
                          minWidth: 'auto',
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: '0.25rem'
                        }}
                        title="Refresh game version"
                      >
                        <i className="fas fa-sync-alt"></i>
                      </button>
                    )}
                  </div>
                </div>
                {env.status === 'completed' && (
                  <>
                    <div style={{ width: '100%', display: 'flex', alignItems: 'center' }}>
                      <strong>ML:</strong>
                      <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: '0.5rem', justifyContent: 'flex-end' }}>
                        {melonLoaderStatus.get(env.id)?.installed ? (
                          <>
                            <span className="badge badge-green" style={{ marginLeft: '1.25rem', width: '8.5rem', display: 'inline-block', textAlign: 'center', boxSizing: 'border-box', padding: '0.15rem 0.5rem' }}>
                              INSTALLED{melonLoaderStatus.get(env.id)?.version ? (
                                <span style={{ textTransform: 'none', marginLeft: '0.25rem' }}> ({melonLoaderStatus.get(env.id)?.version})</span>
                              ) : ''}
                            </span>
                            {melonLoaderReleases.get(env.id) && melonLoaderReleases.get(env.id)!.length > 0 && (
                              <button
                                onClick={() => handleInstallMelonLoader(env)}
                                className="btn btn-secondary btn-small"
                                disabled={installingMelonLoader.has(env.id)}
                                style={{ padding: '0.4rem', fontSize: '0.85rem', width: '2.25rem', height: '2.25rem', boxSizing: 'border-box', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}
                                title="Update or change MelonLoader version"
                              >
                                {installingMelonLoader.has(env.id) ? (
                                  <i className="fas fa-spinner fa-spin" style={{ fontSize: '0.85rem' }}></i>
                                ) : (
                                  <i className="fas fa-download" style={{ fontSize: '0.85rem' }}></i>
                                )}
                              </button>
                            )}
                          </>
                        ) : (
                          <>
                            <span className="badge badge-gray" style={{ marginLeft: '1.25rem', width: '8.5rem', display: 'inline-block', textAlign: 'center', boxSizing: 'border-box', padding: '0.15rem 0.5rem' }}>Not Installed</span>
                            <button
                              onClick={() => handleInstallMelonLoader(env)}
                              className="btn btn-secondary btn-small"
                              disabled={installingMelonLoader.has(env.id)}
                              style={{ padding: '0.4rem', fontSize: '0.85rem', width: '2.25rem', height: '2.25rem', boxSizing: 'border-box', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}
                              title="Install MelonLoader"
                            >
                              {installingMelonLoader.has(env.id) ? (
                                <i className="fas fa-spinner fa-spin" style={{ fontSize: '0.85rem' }}></i>
                              ) : (
                                <i className="fas fa-download" style={{ fontSize: '0.85rem' }}></i>
                              )}
                            </button>
                          </>
                        )}
                      </div>
                    </div>
                    <div style={{ width: '100%', display: 'flex', alignItems: 'center' }}>
                      <strong>Mods:</strong>
                      <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: '0.5rem', justifyContent: 'flex-end' }}>
                        <span className="badge badge-gray" style={{ marginLeft: '1.25rem', width: '8.5rem', display: 'inline-block', textAlign: 'center', boxSizing: 'border-box', padding: '0.15rem 0.5rem' }}>
                          {modsCounts.get(env.id) ?? 0} Mods found
                        </span>
                        {(modsCounts.get(env.id) ?? 0) > 0 && (
                          (modUpdatesCounts.get(env.id) ?? 0) > 0 ? (
                            <span className="badge badge-orange" style={{ width: 'auto', display: 'inline-block', textAlign: 'center', boxSizing: 'border-box', padding: '0.15rem 0.5rem' }} title="Mods with updates available">
                              {modUpdatesCounts.get(env.id)} update{(modUpdatesCounts.get(env.id) ?? 0) !== 1 ? 's' : ''} available
                            </span>
                          ) : (
                            <span className="badge badge-green" style={{ width: 'auto', display: 'inline-block', textAlign: 'center', boxSizing: 'border-box', padding: '0.15rem 0.5rem' }} title="All mods up to date">
                              Up to date
                            </span>
                          )
                        )}
                        <button
                          onClick={() => handleOpenModsOverlay(env.id)}
                          className="btn btn-secondary btn-small"
                          style={{ padding: '0.4rem', fontSize: '0.85rem', width: '2.25rem', height: '2.25rem', boxSizing: 'border-box', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}
                          title="View installed mods"
                        >
                          <i className="fas fa-list" style={{ fontSize: '0.85rem' }}></i>
                        </button>
                      </div>
                    </div>
                    <div style={{ width: '100%', display: 'flex', alignItems: 'center' }}>
                      <strong>Plugins:</strong>
                      <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: '0.5rem', justifyContent: 'flex-end' }}>
                        <span className="badge badge-gray" style={{ marginLeft: '1.25rem', width: '8.5rem', display: 'inline-block', textAlign: 'center', boxSizing: 'border-box', padding: '0.15rem 0.5rem' }}>
                          {pluginsCounts.get(env.id) ?? 0} Plugins found
                        </span>
                        <button
                          onClick={() => handleOpenPluginsOverlay(env.id)}
                          className="btn btn-secondary btn-small"
                          style={{ padding: '0.4rem', fontSize: '0.85rem', width: '2.25rem', height: '2.25rem', boxSizing: 'border-box', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}
                          title="View installed plugins"
                        >
                          <i className="fas fa-list" style={{ fontSize: '0.85rem' }}></i>
                        </button>
                      </div>
                    </div>
                    <div style={{ width: '100%', display: 'flex', alignItems: 'center' }}>
                      <strong>UserLibs:</strong>
                      <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: '0.5rem', justifyContent: 'flex-end' }}>
                        <span className="badge badge-gray" style={{ marginLeft: '1.25rem', width: '8.5rem', display: 'inline-block', textAlign: 'center', boxSizing: 'border-box', padding: '0.15rem 0.5rem' }}>
                          {userLibsCounts.get(env.id) ?? 0} Libs found
                        </span>
                        <button
                          onClick={() => handleOpenUserLibsOverlay(env.id)}
                          className="btn btn-secondary btn-small"
                          style={{ padding: '0.4rem', fontSize: '0.85rem', width: '2.25rem', height: '2.25rem', boxSizing: 'border-box', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}
                          title="View UserLibs (read-only)"
                        >
                          <i className="fas fa-list" style={{ fontSize: '0.85rem' }}></i>
                        </button>
                      </div>
                    </div>
                    <div style={{ width: '100%', display: 'flex', alignItems: 'center' }}>
                      <strong>Logs:</strong>
                      <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: '0.5rem', justifyContent: 'flex-end' }}>
                        <button
                          onClick={() => handleOpenLogsOverlay(env.id)}
                          className="btn btn-secondary btn-small"
                          style={{ padding: '0.4rem', fontSize: '0.85rem', width: '2.25rem', height: '2.25rem', boxSizing: 'border-box', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', marginLeft: 'auto' }}
                          title="View MelonLoader logs"
                        >
                          <i className="fas fa-file-alt" style={{ fontSize: '0.85rem' }}></i>
                        </button>
                      </div>
                    </div>
                    <div style={{ width: '100%', display: 'flex', alignItems: 'center' }}>
                      <strong>Configuration:</strong>
                      <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: '0.5rem', justifyContent: 'flex-end' }}>
                        <button
                          onClick={() => handleOpenConfigOverlay(env.id)}
                          className="btn btn-secondary btn-small"
                          style={{ padding: '0.4rem', fontSize: '0.85rem', width: '2.25rem', height: '2.25rem', boxSizing: 'border-box', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', marginLeft: 'auto' }}
                          title="Edit mod configuration"
                        >
                          <i className="fas fa-cog" style={{ fontSize: '0.85rem' }}></i>
                        </button>
                      </div>
                    </div>
                  </>
                )}
                {env.status === 'completed' && (
                  <div className="environment-info-panel">
                    <p className="info-panel-text">
                      {checkingEnvironments.has(env.id) ? (
                        <>
                          <strong>Checking</strong><span className="checking-dots"></span>
                        </>
                      ) : (
                        <>
                          <strong>Last checked:</strong> {formatLastCheck(env.lastUpdateCheck)}
                        </>
                      )}
                    </p>
                  </div>
                )}
                {prog && (
                  <div className="progress-info">
                    <div className="progress-bar">
                      <div
                        className="progress-fill"
                        style={{ width: `${Math.min(100, Math.max(0, prog.progress))}%` }}
                      />
                    </div>
                    <p>{Math.round(prog.progress)}% - {prog.message || ''}</p>
                    {prog.downloadedFiles !== undefined && prog.totalFiles !== undefined && (
                      <p>Files: {prog.downloadedFiles} / {prog.totalFiles}</p>
                    )}
                    {prog.speed && <p>Speed: {prog.speed}</p>}
                  </div>
                )}
              </div>
              <div className="environment-actions">
                {!isDownloading && env.status !== 'completed' && (
                  <button onClick={() => handleStartDownload(env)} className="btn btn-primary">
                    Download
                  </button>
                )}
                {isDownloading && (
                  <button onClick={() => handleCancelDownload(env)} className="btn btn-secondary">
                    Cancel
                  </button>
                )}
                {env.status === 'completed' && (
                  <>
                    <div className="environment-actions-primary">
                      <button
                        onClick={() => handleOpenFolder(env)}
                        className="btn btn-secondary"
                        title="Open folder in file explorer"
                      >
                        <i className="fas fa-folder-open"></i>
                        <span>Open Folder</span>
                      </button>
                      <div style={{ position: 'relative', display: 'inline-block' }} data-launch-dropdown>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            setLaunchDropdownOpen(launchDropdownOpen === env.id ? null : env.id);
                          }}
                          className="btn btn-primary"
                          title="Launch the game"
                          style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}
                        >
                          <i className="fas fa-play"></i>
                          <span>Launch Game</span>
                          <i className={`fas fa-chevron-${launchDropdownOpen === env.id ? 'up' : 'down'}`} style={{ fontSize: '0.7rem' }}></i>
                        </button>
                        {launchDropdownOpen === env.id && (
                          <div style={{
                            position: 'absolute',
                            top: '100%',
                            left: 0,
                            marginTop: '0.25rem',
                            backgroundColor: 'var(--card-bg-color, #2a2a2a)',
                            border: '1px solid var(--border-color, #3a3a3a)',
                            borderRadius: '4px',
                            boxShadow: '0 4px 12px rgba(0, 0, 0, 0.3)',
                            zIndex: 1000,
                            minWidth: '100%',
                            overflow: 'hidden'
                          }}>
                            {(env.environmentType === 'Steam' || env.environmentType === 'steam' || env.id.startsWith('steam-')) ? (
                              <>
                                <button
                                  onClick={() => {
                                    handleLaunchGame(env, 'steam');
                                    setLaunchDropdownOpen(null);
                                  }}
                                  className="btn"
                                  style={{
                                    width: '100%',
                                    textAlign: 'left',
                                    padding: '0.5rem 1rem',
                                    background: 'none',
                                    border: 'none',
                                    color: 'var(--app-text-color, #ffffff)',
                                    cursor: 'pointer',
                                    display: 'flex',
                                    alignItems: 'center',
                                    gap: '0.5rem'
                                  }}
                                  onMouseEnter={(e) => {
                                    e.currentTarget.style.backgroundColor = 'var(--border-color, #3a3a3a)';
                                  }}
                                  onMouseLeave={(e) => {
                                    e.currentTarget.style.backgroundColor = 'transparent';
                                  }}
                                >
                                  <i className="fab fa-steam"></i>
                                  <span>Launch via Steam</span>
                                </button>
                                <button
                                  onClick={() => {
                                    handleLaunchGame(env, 'direct');
                                    setLaunchDropdownOpen(null);
                                  }}
                                  className="btn"
                                  style={{
                                    width: '100%',
                                    textAlign: 'left',
                                    padding: '0.5rem 1rem',
                                    background: 'none',
                                    border: 'none',
                                    color: 'var(--app-text-color, #ffffff)',
                                    cursor: 'pointer',
                                    display: 'flex',
                                    alignItems: 'center',
                                    gap: '0.5rem',
                                    borderTop: '1px solid var(--border-color, #3a3a3a)'
                                  }}
                                  onMouseEnter={(e) => {
                                    e.currentTarget.style.backgroundColor = 'var(--border-color, #3a3a3a)';
                                  }}
                                  onMouseLeave={(e) => {
                                    e.currentTarget.style.backgroundColor = 'transparent';
                                  }}
                                >
                                  <i className="fas fa-play"></i>
                                  <span>Launch Directly</span>
                                </button>
                              </>
                            ) : (
                              <>
                                <button
                                  onClick={() => {
                                    handleLaunchGame(env, 'direct');
                                    setLaunchDropdownOpen(null);
                                  }}
                                  className="btn"
                                  style={{
                                    width: '100%',
                                    textAlign: 'left',
                                    padding: '0.5rem 1rem',
                                    background: 'none',
                                    border: 'none',
                                    color: 'var(--app-text-color, #ffffff)',
                                    cursor: 'pointer',
                                    display: 'flex',
                                    alignItems: 'center',
                                    gap: '0.5rem'
                                  }}
                                  onMouseEnter={(e) => {
                                    e.currentTarget.style.backgroundColor = 'var(--border-color, #3a3a3a)';
                                  }}
                                  onMouseLeave={(e) => {
                                    e.currentTarget.style.backgroundColor = 'transparent';
                                  }}
                                >
                                  <i className="fas fa-play"></i>
                                  <span>Launch Directly</span>
                                </button>
                                <button
                                  onClick={() => {
                                    handleLaunchGame(env, 'steam');
                                    setLaunchDropdownOpen(null);
                                  }}
                                  className="btn"
                                  style={{
                                    width: '100%',
                                    textAlign: 'left',
                                    padding: '0.5rem 1rem',
                                    background: 'none',
                                    border: 'none',
                                    color: 'var(--app-text-color, #ffffff)',
                                    cursor: 'pointer',
                                    display: 'flex',
                                    alignItems: 'center',
                                    gap: '0.5rem',
                                    borderTop: '1px solid var(--border-color, #3a3a3a)'
                                  }}
                                  onMouseEnter={(e) => {
                                    e.currentTarget.style.backgroundColor = 'var(--border-color, #3a3a3a)';
                                  }}
                                  onMouseLeave={(e) => {
                                    e.currentTarget.style.backgroundColor = 'transparent';
                                  }}
                                >
                                  <i className="fab fa-steam"></i>
                                  <span>Launch via Steam</span>
                                </button>
                              </>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                    <div className="environment-actions-secondary">
                      {env.status === 'completed' && (
                        <button
                          onClick={() => handleManualUpdateCheck(env)}
                          className="btn btn-secondary"
                          disabled={checkingEnvironments.has(env.id)}
                          title="Check for updates"
                        >
                          <i className={`fas ${checkingEnvironments.has(env.id) ? 'fa-spinner fa-spin' : 'fa-sync-alt'}`}></i>
                          <span>Check Updates</span>
                        </button>
                      )}
                      {env.updateAvailable && !isSteam && (
                      <button
                          onClick={() => handleUpdate(env)}
                          className="btn btn-primary"
                          title="Update to the latest branch version"
                      >
                          <i className="fas fa-arrow-up"></i>
                          <span>Update</span>
                      </button>
                      )}
                      {env.updateAvailable && isSteam && (
                      <button
                          className="btn btn-secondary"
                          disabled
                          title="Steam manages updates for this installation"
                      >
                          <i className="fab fa-steam" style={{ marginRight: '0.25rem' }}></i>
                          <span>Steam Updates</span>
                      </button>
                      )}
                      {!isSteam && (
                        <button onClick={() => handleDelete(env)} className="btn btn-danger">
                          <i className="fas fa-trash"></i>
                          <span>Delete</span>
                        </button>
                      )}
                    </div>
                  </>
                )}
                {env.status !== 'completed' && !isSteam && (
                  <button onClick={() => handleDelete(env)} className="btn btn-danger">
                    <i className="fas fa-trash"></i>
                    <span>Delete</span>
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
