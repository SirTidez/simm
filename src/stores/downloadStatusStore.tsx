import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { TrackedDownload } from '../types';
import { useEnvironmentStore } from './environmentStore';
import { createAsyncListenerScope, onComplete, onError, onProgress, onTrackedDownloadUpdated } from '../services/events';

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
    const normalizedDownload = isTerminal(download.status) && download.finishedAt == null
      ? { ...download, finishedAt: Date.now() }
      : download;

    setDownloadsById((previous) => {
      const current = previous.get(normalizedDownload.id);
      // A backend completion, cancellation, or failure is final for this
      // operation. Late progress events must never turn that row active again.
      const isNewOperation = current && isTerminal(current.status)
        && normalizedDownload.startedAt > (current.finishedAt ?? current.startedAt);
      if (current && isTerminal(current.status) && !isNewOperation) {
        return previous;
      }

      const next = new Map(previous);
      next.set(normalizedDownload.id, normalizedDownload);
      return next;
    });

    const current = downloadsRef.current.get(normalizedDownload.id);
    const startsNewOperation = current && isTerminal(current.status)
      && normalizedDownload.startedAt > (current.finishedAt ?? current.startedAt);
    if (!isTerminal(normalizedDownload.status) && startsNewOperation) {
      const existingTimer = removalTimersRef.current.get(normalizedDownload.id);
      if (existingTimer) {
        window.clearTimeout(existingTimer);
        removalTimersRef.current.delete(normalizedDownload.id);
      }
    }

    if (isTerminal(normalizedDownload.status)) {
      const existingTimer = removalTimersRef.current.get(normalizedDownload.id);
      if (existingTimer) {
        window.clearTimeout(existingTimer);
        removalTimersRef.current.delete(normalizedDownload.id);
      }
      const terminalFinishedAt = normalizedDownload.finishedAt;
      const timeoutId = window.setTimeout(() => {
        setDownloadsById((previous) => {
          const current = previous.get(normalizedDownload.id);
          if (!current || !isTerminal(current.status) || current.finishedAt !== terminalFinishedAt) {
            return previous;
          }
          const next = new Map(previous);
          next.delete(normalizedDownload.id);
          return next;
        });
        removalTimersRef.current.delete(normalizedDownload.id);
      }, TERMINAL_ROW_TTL_MS);
      removalTimersRef.current.set(normalizedDownload.id, timeoutId);
    }
  }, []);

  const updateGameDownload = useCallback((downloadId: string, patch: Partial<TrackedDownload>) => {
    const trackedId = `game:${downloadId}`;
    const terminalFinishedAt = patch.status && isTerminal(patch.status)
      ? (patch.finishedAt ?? Date.now())
      : undefined;
    const normalizedPatch = terminalFinishedAt == null
      ? patch
      : { ...patch, finishedAt: terminalFinishedAt };
    setDownloadsById((previous) => {
      const next = new Map(previous);
      const current = next.get(trackedId);
      const incomingOperationId = normalizedPatch.operationId;
      const operationChanged = Boolean(
        incomingOperationId
        && current?.operationId
        && incomingOperationId !== current.operationId
      );
      // DepotDownloader serializes operations. A different generation can
      // start only after the current row is terminal; otherwise it is delayed
      // output from the superseded run.
      if (current && !isTerminal(current.status) && operationChanged) {
        return previous;
      }
      const isNewOperation = Boolean(current && isTerminal(current.status) && operationChanged);
      if (current && isTerminal(current.status) && !isNewOperation) {
        return previous;
      }
      const now = Date.now();
      const currentOperation = isNewOperation ? undefined : current;
      const nextDownload: TrackedDownload = {
        id: trackedId,
        kind: 'game',
        label: currentOperation?.label ?? resolveGameLabel(downloadId),
        contextLabel: currentOperation?.contextLabel ?? 'Game download',
        status: currentOperation?.status ?? 'downloading',
        progress: currentOperation?.progress ?? 0,
        downloadedFiles: currentOperation?.downloadedFiles,
        totalFiles: currentOperation?.totalFiles,
        message: currentOperation?.message,
        error: currentOperation?.error,
        startedAt: currentOperation?.startedAt ?? now,
        finishedAt: currentOperation?.finishedAt ?? null,
        ...normalizedPatch,
      };

      if (isTerminal(nextDownload.status) && nextDownload.finishedAt == null) {
        nextDownload.finishedAt = now;
      }

      next.set(trackedId, nextDownload);
      return next;
    });

    const current = downloadsRef.current.get(trackedId);
    if (
      !patch.status || !isTerminal(patch.status)
    ) {
      const startsNewOperation = Boolean(
        patch.operationId
        && current?.operationId
        && patch.operationId !== current.operationId
      );
      if (startsNewOperation) {
        const activeTimer = removalTimersRef.current.get(trackedId);
        if (activeTimer) {
          window.clearTimeout(activeTimer);
          removalTimersRef.current.delete(trackedId);
        }
      }
    }

    if (terminalFinishedAt != null) {
      const activeTimer = removalTimersRef.current.get(trackedId);
      if (activeTimer) {
        window.clearTimeout(activeTimer);
        removalTimersRef.current.delete(trackedId);
      }
      const timeoutId = window.setTimeout(() => {
        setDownloadsById((previous) => {
          const current = previous.get(trackedId);
          if (!current || !isTerminal(current.status) || current.finishedAt !== terminalFinishedAt) {
            return previous;
          }
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
    const listeners = createAsyncListenerScope((error) => {
      console.error('Failed to set up download status listener:', error);
    });

    listeners.register(() => onProgress((progress) => {
        updateGameDownload(progress.downloadId, {
          operationId: progress.operationId,
          status: progress.status,
          progress: progress.progress,
          downloadedFiles: progress.downloadedFiles,
          totalFiles: progress.totalFiles,
          message: progress.message,
          error: progress.error,
          finishedAt: isTerminal(progress.status) ? Date.now() : null,
        });
      }));

    listeners.register(() => onComplete(({ downloadId, operationId }) => {
        const current = downloadsRef.current.get(`game:${downloadId}`);
        updateGameDownload(downloadId, {
          operationId,
          status: 'completed',
          progress: 100,
          downloadedFiles: current?.totalFiles ?? current?.downloadedFiles,
          totalFiles: current?.totalFiles,
          message: current?.message ?? 'Download completed',
          error: undefined,
          finishedAt: Date.now(),
        });
      }));

    listeners.register(() => onError(({ downloadId, operationId, error }) => {
        updateGameDownload(downloadId, {
          operationId,
          status: 'error',
          error,
          message: 'Download failed',
          finishedAt: Date.now(),
        });
      }));

    listeners.register(() => onTrackedDownloadUpdated((download) => {
        updateDownload(download);
      }));

    const removalTimers = removalTimersRef.current;

    return () => {
      listeners.dispose();
      for (const timeoutId of removalTimers.values()) {
        window.clearTimeout(timeoutId);
      }
      removalTimers.clear();
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
