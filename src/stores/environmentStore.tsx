import React, { createContext, useContext, useState, useEffect, useCallback, useMemo, useRef } from 'react';
import type { Environment, DownloadProgress, ExtractGameVersionResult, OneTimeDownloadCredentials } from '../types';

function partialEnvFromExtractGameVersion(res: ExtractGameVersionResult): Partial<Environment> {
  const out: Partial<Environment> = {};
  if (res.version) {
    out.currentGameVersion = res.version;
  }
  if (res.branch) {
    out.branch = res.branch;
  }
  if (res.runtime === 'IL2CPP' || res.runtime === 'Mono') {
    out.runtime = res.runtime;
  }
  return out;
}

function isTerminalDownloadStatus(status: DownloadProgress['status']) {
  return status === 'completed' || status === 'error' || status === 'cancelled';
}
import { ApiService } from '../services/api';
import { createAsyncListenerScope, onProgress, onComplete, onError, onUpdateAvailable, onUpdateCheckComplete, onRuntimeSwitch } from '../services/events';

interface EnvironmentStoreContextValue {
  environments: Environment[];
  loading: boolean;
  error: string | null;
  progress: Map<string, DownloadProgress>;
  activeGameDownloadId: string | null;
  refreshEnvironments: () => Promise<void>;
  ensureEnvironments: () => Promise<Environment[]>;
  createEnvironment: (data: { appId: string; branch: string; outputDir: string; name?: string; description?: string }) => Promise<Environment>;
  updateEnvironment: (id: string, updates: Partial<Environment>) => Promise<void>;
  deleteEnvironment: (id: string, deleteFiles?: boolean) => Promise<void>;
  startDownload: (environmentId: string, oneTimeCredentials?: OneTimeDownloadCredentials) => Promise<void>;
  cancelDownload: (downloadId: string) => Promise<void>;
  checkUpdate: (environmentId: string, manual?: boolean) => Promise<void>;
  refreshGameVersion: (environmentId: string) => Promise<string | null>;
  checkAllUpdates: (manual?: boolean) => Promise<void>;
}

const EnvironmentStoreContext = createContext<EnvironmentStoreContextValue | null>(null);

function mergeUpdateResultIntoEnvironment(
  env: Environment,
  updateResult: import('../types').UpdateCheckResult
): Environment {
  return {
    ...env,
    branch: updateResult.branch || env.branch,
    runtime: updateResult.runtime === 'IL2CPP'
      ? 'IL2CPP'
      : updateResult.runtime === 'Mono' || updateResult.runtime === 'MONO'
        ? 'Mono'
      : env.runtime,
    lastUpdateCheck: updateResult.checkedAt,
    lastManifestId: updateResult.currentManifestId ?? env.lastManifestId,
    updateAvailable: updateResult.updateAvailable,
    remoteManifestId: updateResult.remoteManifestId ?? env.remoteManifestId,
    remoteBuildId: updateResult.remoteBuildId,
    currentGameVersion: updateResult.currentGameVersion ?? env.currentGameVersion,
    updateGameVersion: updateResult.updateGameVersion,
  };
}

export function EnvironmentStoreProvider({ children }: { children: React.ReactNode }) {
  const [environments, setEnvironments] = useState<Environment[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<Map<string, DownloadProgress>>(new Map());
  const refreshEnvironmentsInFlightRef = useRef<Promise<void> | null>(null);
  const startingGameDownloadRef = useRef<string | null>(null);
  const downloadOperationsRef = useRef<Map<string, {
    operationId: string;
    state: 'active' | 'terminal';
  }>>(new Map());
  const pendingOperationReplacementRef = useRef<Set<string>>(new Set());
  const environmentsRef = useRef<Environment[]>([]);
  const snapshotGenerationRef = useRef(0);
  const commitEnvironmentSnapshot = useCallback((updater: (current: Environment[]) => Environment[]) => {
    const next = updater(environmentsRef.current);
    snapshotGenerationRef.current += 1;
    environmentsRef.current = next;
    setEnvironments(next);
  }, []);
  const invalidateEnvironmentSnapshot = useCallback(() => {
    snapshotGenerationRef.current += 1;
  }, []);
  const acceptProgressOperation = useCallback((data: DownloadProgress) => {
    const nextState = isTerminalDownloadStatus(data.status) ? 'terminal' : 'active';
    const current = downloadOperationsRef.current.get(data.downloadId);
    if (!current) {
      downloadOperationsRef.current.set(data.downloadId, {
        operationId: data.operationId,
        state: nextState,
      });
      pendingOperationReplacementRef.current.delete(data.downloadId);
      return true;
    }

    if (
      pendingOperationReplacementRef.current.has(data.downloadId)
      && current.operationId === data.operationId
    ) {
      return false;
    }

    if (current.operationId === data.operationId) {
      // Active output from a completed operation is necessarily delayed.
      if (current.state === 'terminal' && nextState === 'active') {
        return false;
      }
      current.state = nextState;
      return true;
    }

    const explicitReplacement = pendingOperationReplacementRef.current.has(data.downloadId);
    if (!explicitReplacement && !(current.state === 'terminal' && nextState === 'active')) {
      return false;
    }

    downloadOperationsRef.current.set(data.downloadId, {
      operationId: data.operationId,
      state: nextState,
    });
    pendingOperationReplacementRef.current.delete(data.downloadId);
    // Any environment snapshot already being fetched belongs to the previous
    // operation and must not land after this retry begins.
    invalidateEnvironmentSnapshot();
    return true;
  }, [invalidateEnvironmentSnapshot]);
  const acceptTerminalOperation = useCallback((downloadId: string, operationId: string) => {
    const current = downloadOperationsRef.current.get(downloadId);
    if (!current) {
      downloadOperationsRef.current.set(downloadId, { operationId, state: 'terminal' });
      pendingOperationReplacementRef.current.delete(downloadId);
      return true;
    }
    if (
      pendingOperationReplacementRef.current.has(downloadId)
      && current.operationId === operationId
    ) {
      return false;
    }
    if (current.operationId === operationId) {
      current.state = 'terminal';
      return true;
    }
    if (!pendingOperationReplacementRef.current.has(downloadId)) {
      return false;
    }
    downloadOperationsRef.current.set(downloadId, { operationId, state: 'terminal' });
    pendingOperationReplacementRef.current.delete(downloadId);
    return true;
  }, []);
  const operationIsCurrent = useCallback((downloadId: string, operationId: string) => (
    downloadOperationsRef.current.get(downloadId)?.operationId === operationId
  ), []);

  const activeGameDownloadId = useMemo(() => {
    const activeProgress = Array.from(progress.values()).find(
      (entry) => entry.status === 'downloading' || entry.status === 'validating',
    );
    return activeProgress?.downloadId
      ?? environments.find((environment) => environment.status === 'downloading')?.id
      ?? null;
  }, [environments, progress]);
  const hasLoadedEnvironmentsRef = useRef(false);

  const refreshEnvironments = useCallback(async () => {
    if (refreshEnvironmentsInFlightRef.current) {
      return refreshEnvironmentsInFlightRef.current;
    }

    const isInitialLoad = !hasLoadedEnvironmentsRef.current;
    const requestGeneration = snapshotGenerationRef.current;
    let appliedFetchedSnapshot = false;
    const request = (async () => {
      if (isInitialLoad) {
        setLoading(true);
      }
      setError(null);
      const envs = await ApiService.getEnvironments();
      if (snapshotGenerationRef.current !== requestGeneration) {
        return;
      }
      commitEnvironmentSnapshot(() => envs);
      appliedFetchedSnapshot = true;
      hasLoadedEnvironmentsRef.current = true;

      // Steam installs are also refreshed here even when their game version is known,
      // because Steam can switch the selected branch/runtime outside SIMM.
      const envsNeedingVersion = envs.filter(env =>
        env.status === 'completed' && (
          !env.currentGameVersion
          || env.environmentType === 'Steam'
          || env.environmentType === 'steam'
          || env.id.startsWith('steam-')
        )
      );

      if (envsNeedingVersion.length > 0) {
        const extractionGeneration = snapshotGenerationRef.current;
        const detectedPatches = await Promise.all(
          envsNeedingVersion.map(async (env) => {
            try {
              const extracted = await ApiService.extractGameVersion(env.id);
              const patch = partialEnvFromExtractGameVersion(extracted);
              return Object.keys(patch).length > 0 ? { id: env.id, patch } : null;
            } catch (err) {
              // Silently fail - version extraction can be done manually later
              console.warn(`Failed to auto-extract version for environment ${env.id}:`, err);
              return null;
            }
          })
        );

        const patchMap = new Map(
          detectedPatches
            .filter((entry): entry is { id: string; patch: Partial<Environment> } => entry !== null)
            .map(entry => [entry.id, entry.patch])
        );

        if (patchMap.size > 0 && snapshotGenerationRef.current === extractionGeneration) {
          commitEnvironmentSnapshot(current => current.map(env => {
            const patch = patchMap.get(env.id);
            return patch ? { ...env, ...patch } : env;
          }));
        }
      }
    })();

    const operation = request.catch((err) => {
      setError(err instanceof Error ? err.message : 'Failed to load environments');
    }).finally(() => {
      if (refreshEnvironmentsInFlightRef.current === operation) {
        refreshEnvironmentsInFlightRef.current = null;
      }
      if (!appliedFetchedSnapshot && snapshotGenerationRef.current !== requestGeneration) {
        void refreshEnvironments();
      }
      if (isInitialLoad) {
        setLoading(false);
      }
    });

    refreshEnvironmentsInFlightRef.current = operation;
    return operation;
  }, [commitEnvironmentSnapshot]);

  const ensureEnvironments = useCallback(async () => {
    if (hasLoadedEnvironmentsRef.current) {
      return environmentsRef.current;
    }
    await refreshEnvironments();
    return environmentsRef.current;
  }, [refreshEnvironments]);

  const createEnvironment = useCallback(async (data: { appId: string; branch: string; outputDir: string; name?: string; description?: string }) => {
    try {
      const env = await ApiService.createEnvironment(data);
      commitEnvironmentSnapshot(current => [...current, env]);
      return env;
    } catch (err) {
      throw err;
    }
  }, [commitEnvironmentSnapshot]);

  const updateEnvironment = useCallback(async (id: string, updates: Partial<Environment>) => {
    try {
      const updated = await ApiService.updateEnvironment(id, updates);
      commitEnvironmentSnapshot(current => current.map(env => env.id === id ? updated : env));
    } catch (err) {
      throw err;
    }
  }, [commitEnvironmentSnapshot]);

  const deleteEnvironment = useCallback(async (id: string, deleteFiles?: boolean) => {
    try {
      // Invalidate before awaiting IPC: a pre-delete list response must never
      // be accepted after this mutation.  The refresh coordinator retains one
      // follow-up pass when that older request finishes.
      invalidateEnvironmentSnapshot();
      await ApiService.deleteEnvironment(id, deleteFiles);
      downloadOperationsRef.current.delete(id);
      pendingOperationReplacementRef.current.delete(id);
      commitEnvironmentSnapshot(current => current.filter(env => env.id !== id));
      await refreshEnvironments();
      setProgress(prev => {
        const next = new Map(prev);
        next.delete(id);
        return next;
      });
    } catch (err) {
      throw err;
    }
  }, [commitEnvironmentSnapshot, invalidateEnvironmentSnapshot, refreshEnvironments]);

  const startDownload = useCallback(async (
    environmentId: string,
    oneTimeCredentials?: OneTimeDownloadCredentials,
  ) => {
    const activeDownloadId = activeGameDownloadId ?? startingGameDownloadRef.current;
    if (activeDownloadId && activeDownloadId !== environmentId) {
      throw new Error(`Another game download or update is already running for ${activeDownloadId}.`);
    }

    startingGameDownloadRef.current = environmentId;
    pendingOperationReplacementRef.current.add(environmentId);
    try {
      if (oneTimeCredentials) {
        await ApiService.startDownload(environmentId, oneTimeCredentials);
      } else {
        await ApiService.startDownload(environmentId);
      }
    } catch (err) {
      pendingOperationReplacementRef.current.delete(environmentId);
      throw err;
    } finally {
      if (startingGameDownloadRef.current === environmentId) {
        startingGameDownloadRef.current = null;
      }
    }
  }, [activeGameDownloadId]);

  const cancelDownload = useCallback(async (downloadId: string) => {
    try {
      const result = await ApiService.cancelDownload(downloadId);
      if (!result.success) {
        await refreshEnvironments();
        return;
      }

      setProgress(prev => {
        const next = new Map(prev);
        next.delete(downloadId);
        return next;
      });

      await refreshEnvironments();
    } catch (err) {
      throw err;
    }
  }, [refreshEnvironments]);

  const checkUpdate = useCallback(async (environmentId: string, manual: boolean = false) => {
    try {
      const result = await ApiService.checkUpdate(environmentId, manual);
      commitEnvironmentSnapshot(current => current.map(env => (
        env.id === environmentId ? mergeUpdateResultIntoEnvironment(env, result) : env
      )));
    } catch (err) {
      throw err;
    }
  }, [commitEnvironmentSnapshot]);

  const refreshGameVersion = useCallback(async (environmentId: string) => {
    try {
      const extracted = await ApiService.extractGameVersion(environmentId);
      const patch = partialEnvFromExtractGameVersion(extracted);
      if (Object.keys(patch).length > 0) {
        await updateEnvironment(environmentId, patch);
      }
      return extracted.version ?? null;
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
      commitEnvironmentSnapshot(current => current.map(env => {
          const result = results.find(r => r.environmentId === env.id);
          if (result) {
            return mergeUpdateResultIntoEnvironment(env, result);
          }
          return env;
        }));

      console.log('EnvironmentStore: Environments updated in place');
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Unknown error';
      console.error(`EnvironmentStore: checkAllUpdates failed - ${errorMessage}`, {
        error: err instanceof Error ? err.stack : String(err),
        errorType: err instanceof Error ? err.constructor.name : typeof err
      });
      throw err;
    }
  }, [commitEnvironmentSnapshot]);

  const applyUpdateResultLocally = useCallback((environmentId: string, updateResult: import('../types').UpdateCheckResult) => {
    commitEnvironmentSnapshot(current => current.map(env => {
      if (env.id !== environmentId) {
        return env;
      }

      return mergeUpdateResultIntoEnvironment(env, updateResult);
    }));
  }, [commitEnvironmentSnapshot]);

  // Load environments on mount
  useEffect(() => {
    refreshEnvironments();
  }, [refreshEnvironments]);

  // Set up Tauri event listeners
  useEffect(() => {
    const listeners = createAsyncListenerScope((error) => {
      console.error('Failed to set up event listener:', error);
    });

    listeners.register(() => onProgress((data: DownloadProgress) => {
          if (!listeners.isActive()) return;
          if (!acceptProgressOperation(data)) return;
          setProgress(prev => {
            const next = new Map(prev);
            next.set(data.downloadId, data);
            return next;
          });

          if (data.status === 'error') {
            void updateEnvironment(data.downloadId, { status: 'error' }).catch((err) => {
              console.error('Failed to apply error status update from progress event:', err);
            });
          }
        }));

    listeners.register(() => onComplete(async ({ downloadId, operationId }: { downloadId: string; operationId: string; manifestId?: string }) => {
          if (!listeners.isActive()) return;
          if (!acceptTerminalOperation(downloadId, operationId)) return;
          // DepotDownloader persists completion before emitting this event. Refresh
          // that backend-owned state instead of independently writing manifests here.
          // A response already in flight predates the completion, so discard it
          // and let its completion schedule one fresh snapshot.
          invalidateEnvironmentSnapshot();
          await refreshEnvironments();
          if (!listeners.isActive() || !operationIsCurrent(downloadId, operationId)) return;
          setProgress(prev => {
            const next = new Map(prev);
            next.delete(downloadId);
            return next;
          });

          // Automatically extract game version when download completes
          try {
            const extractionGeneration = snapshotGenerationRef.current;
            const extracted = await ApiService.extractGameVersion(downloadId);
            // The completion refresh immediately above already reconciled the
            // backend-owned branch/runtime. Persist only the detected version
            // here so this follow-up cannot write an older runtime selection
            // back through update_environment.
            const patch: Partial<Environment> = extracted.version
              ? { currentGameVersion: extracted.version }
              : {};
            if (
              Object.keys(patch).length > 0
              && operationIsCurrent(downloadId, operationId)
              && snapshotGenerationRef.current === extractionGeneration
            ) {
              await updateEnvironment(downloadId, patch);
            }
          } catch (err) {
            // Silently fail - version extraction can be done manually later
            console.warn('Failed to auto-extract game version:', err);
          }

        }));

    listeners.register(() => onError(async ({ downloadId, operationId }: { downloadId: string; operationId: string }) => {
          if (!listeners.isActive()) return;
          if (!acceptTerminalOperation(downloadId, operationId)) return;
          try {
            await updateEnvironment(downloadId, { status: 'error' });
          } catch (err) {
            console.error('Failed to apply error status update from event:', err);
          }
        }));

    listeners.register(() => onUpdateAvailable(async ({ environmentId, updateResult }: { environmentId: string; updateResult: import('../types').UpdateCheckResult }) => {
          if (!listeners.isActive()) return;
          try {
            applyUpdateResultLocally(environmentId, updateResult);
          } catch (err) {
            console.error('Failed to apply update-available event state:', err);
          }
        }));

    listeners.register(() => onUpdateCheckComplete(async ({ environmentId, updateResult }: { environmentId: string; updateResult: import('../types').UpdateCheckResult }) => {
          if (!listeners.isActive()) return;
          try {
            applyUpdateResultLocally(environmentId, updateResult);
          } catch (err) {
            console.error('Failed to apply update-check-complete event state:', err);
          }
        }));

    listeners.register(() => onRuntimeSwitch((result) => {
          if (!listeners.isActive()) return;
          commitEnvironmentSnapshot(current => current.map(env => env.id === result.environmentId ? {
            ...env,
            branch: result.branch,
            runtime: (result.runtime === 'Mono' || result.runtime === 'MONO' ? 'Mono' : 'IL2CPP') as Environment['runtime'],
          } : env));
        }));

    return () => {
      listeners.dispose();
    };
  }, [acceptProgressOperation, acceptTerminalOperation, operationIsCurrent, updateEnvironment, applyUpdateResultLocally, commitEnvironmentSnapshot, invalidateEnvironmentSnapshot, refreshEnvironments]);

  return (
    <EnvironmentStoreContext.Provider
      value={{
        environments,
        loading,
        error,
        progress,
        activeGameDownloadId,
        refreshEnvironments,
        ensureEnvironments,
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
