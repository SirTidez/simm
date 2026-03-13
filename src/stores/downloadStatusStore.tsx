import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { TrackedDownload } from '../types';
import { useEnvironmentStore } from './environmentStore';
import { onComplete, onError, onProgress, onTrackedDownloadUpdated } from '../services/events';

interface DownloadStatusStoreContextValue {
  downloads: TrackedDownload[];
}

const DownloadStatusStoreContext = createContext<DownloadStatusStoreContextValue | null>(null);

const TERMINAL_STATUSES = new Set<TrackedDownload['status']>(['completed', 'error', 'cancelled']);
const TERMINAL_ROW_TTL_MS = 10_000;

function isTerminal(status: TrackedDownload['status']) {
  return TERMINAL_STATUSES.has(status);
}

function sortDownloads(a: TrackedDownload, b: TrackedDownload) {
  const aTerminal = isTerminal(a.status);
  const bTerminal = isTerminal(b.status);

  if (aTerminal !== bTerminal) {
    return aTerminal ? 1 : -1;
  }

  const aTime = aTerminal ? (a.finishedAt ?? a.startedAt) : a.startedAt;
  const bTime = bTerminal ? (b.finishedAt ?? b.startedAt) : b.startedAt;
  return bTime - aTime;
}

export function DownloadStatusStoreProvider({ children }: { children: React.ReactNode }) {
  const { environments } = useEnvironmentStore();
  const [downloadsById, setDownloadsById] = useState<Map<string, TrackedDownload>>(new Map());
  const downloadsRef = useRef(downloadsById);
  const removalTimersRef = useRef<Map<string, number>>(new Map());

  useEffect(() => {
    downloadsRef.current = downloadsById;
  }, [downloadsById]);

  const resolveGameLabel = useCallback((downloadId: string) => {
    return environments.find((environment) => environment.id === downloadId)?.name ?? downloadId;
  }, [environments]);

  const updateDownload = useCallback((download: TrackedDownload) => {
    setDownloadsById((previous) => {
      const next = new Map(previous);
      next.set(download.id, download);
      return next;
    });

    const existingTimer = removalTimersRef.current.get(download.id);
    if (existingTimer) {
      window.clearTimeout(existingTimer);
      removalTimersRef.current.delete(download.id);
    }

    if (isTerminal(download.status)) {
      const timeoutId = window.setTimeout(() => {
        setDownloadsById((previous) => {
          const next = new Map(previous);
          next.delete(download.id);
          return next;
        });
        removalTimersRef.current.delete(download.id);
      }, TERMINAL_ROW_TTL_MS);
      removalTimersRef.current.set(download.id, timeoutId);
    }
  }, []);

  const updateGameDownload = useCallback((downloadId: string, patch: Partial<TrackedDownload>) => {
    const trackedId = `game:${downloadId}`;
    setDownloadsById((previous) => {
      const next = new Map(previous);
      const current = next.get(trackedId);
      const now = Date.now();
      const nextDownload: TrackedDownload = {
        id: trackedId,
        kind: 'game',
        label: current?.label ?? resolveGameLabel(downloadId),
        contextLabel: current?.contextLabel ?? 'Game download',
        status: current?.status ?? 'downloading',
        progress: current?.progress ?? 0,
        downloadedFiles: current?.downloadedFiles,
        totalFiles: current?.totalFiles,
        message: current?.message,
        error: current?.error,
        startedAt: current?.startedAt ?? now,
        finishedAt: current?.finishedAt ?? null,
        ...patch,
      };

      if (isTerminal(nextDownload.status) && nextDownload.finishedAt == null) {
        nextDownload.finishedAt = now;
      }

      next.set(trackedId, nextDownload);
      return next;
    });

    const activeTimer = removalTimersRef.current.get(trackedId);
    if (activeTimer) {
      window.clearTimeout(activeTimer);
      removalTimersRef.current.delete(trackedId);
    }

    if (patch.status && isTerminal(patch.status)) {
      const timeoutId = window.setTimeout(() => {
        setDownloadsById((previous) => {
          const next = new Map(previous);
          next.delete(trackedId);
          return next;
        });
        removalTimersRef.current.delete(trackedId);
      }, TERMINAL_ROW_TTL_MS);
      removalTimersRef.current.set(trackedId, timeoutId);
    }
  }, [resolveGameLabel]);

  useEffect(() => {
    setDownloadsById((previous) => {
      if (previous.size === 0) {
        return previous;
      }

      const next = new Map(previous);
      let changed = false;

      for (const [id, download] of previous) {
        if (download.kind !== 'game') {
          continue;
        }

        const environmentId = id.replace(/^game:/, '');
        const label = resolveGameLabel(environmentId);
        if (label !== download.label) {
          next.set(id, {
            ...download,
            label,
          });
          changed = true;
        }
      }

      return changed ? next : previous;
    });
  }, [resolveGameLabel]);

  useEffect(() => {
    let unlistenProgress: (() => void) | null = null;
    let unlistenComplete: (() => void) | null = null;
    let unlistenError: (() => void) | null = null;
    let unlistenTrackedDownload: (() => void) | null = null;

    const bindListeners = async () => {
      unlistenProgress = await onProgress((progress) => {
        updateGameDownload(progress.downloadId, {
          status: progress.status,
          progress: progress.progress,
          downloadedFiles: progress.downloadedFiles,
          totalFiles: progress.totalFiles,
          message: progress.message,
          error: progress.error,
          finishedAt: isTerminal(progress.status) ? Date.now() : null,
        });
      });

      unlistenComplete = await onComplete(({ downloadId }) => {
        const current = downloadsRef.current.get(`game:${downloadId}`);
        updateGameDownload(downloadId, {
          status: 'completed',
          progress: 100,
          downloadedFiles: current?.totalFiles ?? current?.downloadedFiles,
          totalFiles: current?.totalFiles,
          message: current?.message ?? 'Download completed',
          error: undefined,
          finishedAt: Date.now(),
        });
      });

      unlistenError = await onError(({ downloadId, error }) => {
        updateGameDownload(downloadId, {
          status: 'error',
          error,
          message: 'Download failed',
          finishedAt: Date.now(),
        });
      });

      unlistenTrackedDownload = await onTrackedDownloadUpdated((download) => {
        updateDownload(download);
      });
    };

    void bindListeners();

    return () => {
      unlistenProgress?.();
      unlistenComplete?.();
      unlistenError?.();
      unlistenTrackedDownload?.();
      for (const timeoutId of removalTimersRef.current.values()) {
        window.clearTimeout(timeoutId);
      }
      removalTimersRef.current.clear();
    };
  }, [resolveGameLabel, updateDownload, updateGameDownload]);

  const downloads = useMemo(() => {
    return Array.from(downloadsById.values()).sort(sortDownloads);
  }, [downloadsById]);

  return (
    <DownloadStatusStoreContext.Provider value={{ downloads }}>
      {children}
    </DownloadStatusStoreContext.Provider>
  );
}

export function useDownloadStatusStore() {
  const context = useContext(DownloadStatusStoreContext);
  if (!context) {
    throw new Error('useDownloadStatusStore must be used within DownloadStatusStoreProvider');
  }
  return context;
}
