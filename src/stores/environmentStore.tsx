import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import type { Environment, DownloadProgress } from '../types';
import { ApiService } from '../services/api';
import { onProgress, onComplete, onError, onUpdateAvailable, onUpdateCheckComplete } from '../services/events';

interface EnvironmentStoreContextValue {
  environments: Environment[];
  loading: boolean;
  error: string | null;
  progress: Map<string, DownloadProgress>;
  refreshEnvironments: () => Promise<void>;
  createEnvironment: (data: { appId: string; branch: string; outputDir: string; name?: string; description?: string }) => Promise<Environment>;
  updateEnvironment: (id: string, updates: Partial<Environment>) => Promise<void>;
  deleteEnvironment: (id: string) => Promise<void>;
  startDownload: (environmentId: string) => Promise<void>;
  cancelDownload: (downloadId: string) => Promise<void>;
  checkUpdate: (environmentId: string, manual?: boolean) => Promise<void>;
  refreshGameVersion: (environmentId: string) => Promise<string | null>;
  checkAllUpdates: (manual?: boolean) => Promise<void>;
}

const EnvironmentStoreContext = createContext<EnvironmentStoreContextValue | null>(null);

export function EnvironmentStoreProvider({ children }: { children: React.ReactNode }) {
  const [environments, setEnvironments] = useState<Environment[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<Map<string, DownloadProgress>>(new Map());

  const refreshEnvironments = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const envs = await ApiService.getEnvironments();
      setEnvironments(envs);

      // Automatically extract versions for completed environments that don't have one
      const envsNeedingVersion = envs.filter(env =>
        env.status === 'completed' && !env.currentGameVersion
      );

      if (envsNeedingVersion.length > 0) {
        const detectedVersions = await Promise.all(
          envsNeedingVersion.map(async (env) => {
            try {
              const version = await ApiService.extractGameVersion(env.id);
              return version ? { id: env.id, version } : null;
            } catch (err) {
              // Silently fail - version extraction can be done manually later
              console.warn(`Failed to auto-extract version for environment ${env.id}:`, err);
              return null;
            }
          })
        );

        const versionMap = new Map(
          detectedVersions
            .filter((entry): entry is { id: string; version: string } => entry !== null)
            .map(entry => [entry.id, entry.version])
        );

        if (versionMap.size > 0) {
          setEnvironments(prev => prev.map(env => {
            const detectedVersion = versionMap.get(env.id);
            return detectedVersion
              ? { ...env, currentGameVersion: detectedVersion }
              : env;
          }));
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load environments');
    } finally {
      setLoading(false);
    }
  }, []);

  const createEnvironment = useCallback(async (data: { appId: string; branch: string; outputDir: string; name?: string; description?: string }) => {
    try {
      const env = await ApiService.createEnvironment(data);
      setEnvironments(prev => [...prev, env]);
      return env;
    } catch (err) {
      throw err;
    }
  }, []);

  const updateEnvironment = useCallback(async (id: string, updates: Partial<Environment>) => {
    try {
      const updated = await ApiService.updateEnvironment(id, updates);
      setEnvironments(prev => prev.map(env => env.id === id ? updated : env));
    } catch (err) {
      throw err;
    }
  }, []);

  const deleteEnvironment = useCallback(async (id: string) => {
    try {
      await ApiService.deleteEnvironment(id);
      setEnvironments(prev => prev.filter(env => env.id !== id));
      setProgress(prev => {
        const next = new Map(prev);
        next.delete(id);
        return next;
      });
    } catch (err) {
      throw err;
    }
  }, []);

  const startDownload = useCallback(async (environmentId: string) => {
    try {
      await ApiService.startDownload(environmentId);
      await updateEnvironment(environmentId, { status: 'downloading' });
    } catch (err) {
      throw err;
    }
  }, [updateEnvironment]);

  const cancelDownload = useCallback(async (downloadId: string) => {
    try {
      await ApiService.cancelDownload(downloadId);
      await updateEnvironment(downloadId, { status: 'not_downloaded' });
      setProgress(prev => {
        const next = new Map(prev);
        next.delete(downloadId);
        return next;
      });
    } catch (err) {
      throw err;
    }
  }, [updateEnvironment]);

  const checkUpdate = useCallback(async (environmentId: string, manual: boolean = false) => {
    try {
      const result = await ApiService.checkUpdate(environmentId, manual);
      await updateEnvironment(environmentId, {
        lastUpdateCheck: result.checkedAt,
        updateAvailable: result.updateAvailable,
        remoteManifestId: result.remoteManifestId,
        remoteBuildId: result.remoteBuildId,
        ...(result.currentGameVersion ? { currentGameVersion: result.currentGameVersion } : {}),
        ...(result.updateGameVersion ? { updateGameVersion: result.updateGameVersion } : {})
      });
    } catch (err) {
      throw err;
    }
  }, [updateEnvironment]);

  const refreshGameVersion = useCallback(async (environmentId: string) => {
    try {
      const version = await ApiService.extractGameVersion(environmentId);
      await updateEnvironment(environmentId, {
        ...(version ? { currentGameVersion: version } : {})
      });
      return version;
    } catch (err) {
      throw err;
    }
  }, [updateEnvironment]);

  const checkAllUpdates = useCallback(async (manual: boolean = false) => {
    try {
      console.log('EnvironmentStore: checkAllUpdates called');
      const results = await ApiService.checkAllUpdates(manual);
      console.log(`EnvironmentStore: API call completed, got ${results?.length || 0} result(s)`, { results });

      // Update environments in place without triggering loading state
      // This prevents the page from appearing to refresh
      setEnvironments(prev => {
        const updated = prev.map(env => {
          const result = results.find(r => r.environmentId === env.id);
          if (result) {
            return {
              ...env,
              lastUpdateCheck: result.checkedAt,
              updateAvailable: result.updateAvailable,
              remoteManifestId: result.remoteManifestId,
              remoteBuildId: result.remoteBuildId,
              ...(result.currentGameVersion ? { currentGameVersion: result.currentGameVersion } : {}),
              ...(result.updateGameVersion ? { updateGameVersion: result.updateGameVersion } : {})
            };
          }
          return env;
        });
        return updated;
      });

      console.log('EnvironmentStore: Environments updated in place');
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Unknown error';
      console.error(`EnvironmentStore: checkAllUpdates failed - ${errorMessage}`, {
        error: err instanceof Error ? err.stack : String(err),
        errorType: err instanceof Error ? err.constructor.name : typeof err
      });
      throw err;
    }
  }, []);

  // Load environments on mount
  useEffect(() => {
    refreshEnvironments();
  }, [refreshEnvironments]);

  // Set up Tauri event listeners
  useEffect(() => {
    let unlistenProgress: (() => void) | null = null;
    let unlistenComplete: (() => void) | null = null;
    let unlistenError: (() => void) | null = null;
    let unlistenUpdateAvailable: (() => void) | null = null;
    let unlistenUpdateCheckComplete: (() => void) | null = null;

    const setupListeners = async () => {
      try {
        unlistenProgress = await onProgress((data: DownloadProgress) => {
          setProgress(prev => {
            const next = new Map(prev);
            next.set(data.downloadId, data);
            return next;
          });

          // Update environment status based on progress
          if (data.status === 'completed') {
            updateEnvironment(data.downloadId, { status: 'completed' });
          } else if (data.status === 'error') {
            updateEnvironment(data.downloadId, { status: 'error' });
          }
        });

        unlistenComplete = await onComplete(async ({ downloadId, manifestId }: { downloadId: string; manifestId?: string }) => {
          const updates: any = { status: 'completed', lastUpdated: new Date().toISOString() };
          if (manifestId) {
            updates.lastManifestId = manifestId;
          }
          await updateEnvironment(downloadId, updates);
          setProgress(prev => {
            const next = new Map(prev);
            next.delete(downloadId);
            return next;
          });

          // Automatically extract game version when download completes
          try {
            const version = await ApiService.extractGameVersion(downloadId);
            if (version) {
              await updateEnvironment(downloadId, { currentGameVersion: version });
            }
          } catch (err) {
            // Silently fail - version extraction can be done manually later
            console.warn('Failed to auto-extract game version:', err);
          }
        });

        unlistenError = await onError(async ({ downloadId }: { downloadId: string }) => {
          await updateEnvironment(downloadId, { status: 'error' });
        });

        unlistenUpdateAvailable = await onUpdateAvailable(async ({ environmentId, updateResult }: { environmentId: string; updateResult: import('../types').UpdateCheckResult }) => {
          await updateEnvironment(environmentId, {
            lastUpdateCheck: updateResult.checkedAt,
            updateAvailable: updateResult.updateAvailable,
            remoteManifestId: updateResult.remoteManifestId,
            remoteBuildId: updateResult.remoteBuildId,
            ...(updateResult.currentGameVersion ? { currentGameVersion: updateResult.currentGameVersion } : {}),
            ...(updateResult.updateGameVersion ? { updateGameVersion: updateResult.updateGameVersion } : {})
          });
        });

        unlistenUpdateCheckComplete = await onUpdateCheckComplete(async ({ environmentId, updateResult }: { environmentId: string; updateResult: import('../types').UpdateCheckResult }) => {
          await updateEnvironment(environmentId, {
            lastUpdateCheck: updateResult.checkedAt,
            updateAvailable: updateResult.updateAvailable,
            remoteManifestId: updateResult.remoteManifestId,
            remoteBuildId: updateResult.remoteBuildId,
            ...(updateResult.currentGameVersion ? { currentGameVersion: updateResult.currentGameVersion } : {}),
            ...(updateResult.updateGameVersion ? { updateGameVersion: updateResult.updateGameVersion } : {})
          });
        });
      } catch (error) {
        console.error('Failed to set up event listeners:', error);
      }
    };

    setupListeners();

    return () => {
      if (unlistenProgress) unlistenProgress();
      if (unlistenComplete) unlistenComplete();
      if (unlistenError) unlistenError();
      if (unlistenUpdateAvailable) unlistenUpdateAvailable();
      if (unlistenUpdateCheckComplete) unlistenUpdateCheckComplete();
    };
  }, [updateEnvironment]);

  return (
    <EnvironmentStoreContext.Provider
      value={{
        environments,
        loading,
        error,
        progress,
        refreshEnvironments,
        createEnvironment,
        updateEnvironment,
        deleteEnvironment,
        startDownload,
        cancelDownload,
        checkUpdate,
        refreshGameVersion,
        checkAllUpdates
      }}
    >
      {children}
    </EnvironmentStoreContext.Provider>
  );
}

export function useEnvironmentStore() {
  const context = useContext(EnvironmentStoreContext);
  if (!context) {
    throw new Error('useEnvironmentStore must be used within EnvironmentStoreProvider');
  }
  return context;
}
