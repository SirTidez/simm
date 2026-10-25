import { useCallback, useEffect, useRef, useState, type SetStateAction } from 'react';
import { ApiService } from '../services/api';
import { createAsyncListenerScope, onModsChanged, onPluginsChanged } from '../services/events';
import type { NativeConsoleSnapshot } from '../types';

const INVENTORY_QUIET_MS = 200;

/** Observe the existing session and serialize inventory scans independently of docking. */
export function useNativeConsoleSession(environmentId: string, enabled = true) {
  const [snapshot, setSnapshot] = useState<NativeConsoleSnapshot | null>(null);
  const snapshotRevision = useRef(0);
  const updateSnapshot = useCallback((value: SetStateAction<NativeConsoleSnapshot | null>) => {
    snapshotRevision.current += 1;
    setSnapshot(value);
  }, []);
  const [ready, setReady] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [watchError, setWatchError] = useState<string | null>(null);
  const refreshRef = useRef<() => void>(() => {});
  const refresh = useCallback(() => refreshRef.current(), []);

  useEffect(() => {
    let disposed = false;
    let armed = false;
    let initialized = false;
    let scanning = false;
    let requested = 0;
    let completed = 0;
    let epoch = 0;
    let pollTimer: ReturnType<typeof setTimeout> | undefined;
    let changeTimer: ReturnType<typeof setTimeout> | undefined;
    setSnapshot(null); setReady(false); setError(null); setWatchError(null);
    if (!enabled) return;

    const scan = async () => {
      if (disposed || !armed || scanning) return;
      scanning = true;
      setRefreshing(true);
      try {
        while (!disposed && completed < requested) {
          const generation = requested;
          // A poll begun before this scan must not overwrite its newer inventory.
          epoch += 1;
          try {
            await ApiService.openNativeConsole(environmentId, false);
            if (disposed) return;
            initialized = true;
            setReady(true);
            const revision = snapshotRevision.current;
            const next = await ApiService.getNativeConsoleSnapshot(environmentId);
            if (!disposed && revision === snapshotRevision.current) { setSnapshot(next); setError(null); }
          } catch (error) {
            if (!disposed) setError(String(error));
          }
          completed = generation;
        }
      } finally {
        scanning = false;
        if (!disposed) setRefreshing(false);
      }
    };
    const requestScan = () => {
      if (disposed) return;
      requested += 1;
      void scan();
    };
    refreshRef.current = requestScan;

    const listeners = createAsyncListenerScope((error) => {
      if (!disposed) setWatchError(`Inventory auto-refresh: ${String(error)}`);
    });
    const changed = (event: { environmentId: string }) => {
      if (!listeners.isActive() || event.environmentId !== environmentId) return;
      clearTimeout(changeTimer);
      changeTimer = setTimeout(requestScan, INVENTORY_QUIET_MS);
    };
    const subscriptions = [onModsChanged(changed), onPluginsChanged(changed)];
    subscriptions.forEach((subscription) => listeners.register(() => subscription));

    const poll = async () => {
      const readEpoch = epoch;
      const revision = snapshotRevision.current;
      if (!scanning && initialized) {
        try {
          const next = await ApiService.getNativeConsoleSnapshot(environmentId);
          if (!disposed && readEpoch === epoch && revision === snapshotRevision.current) setSnapshot(next);
        } catch (error) {
          if (!disposed && readEpoch === epoch && revision === snapshotRevision.current) setError(String(error));
        }
      }
      if (!disposed) pollTimer = setTimeout(() => void poll(), 1000);
    };
    // Subscribe before the first read so changes during initialization are retained.
    void Promise.allSettled(subscriptions).then(() => {
      if (disposed) return;
      armed = true;
      requestScan();
      void poll();
    });

    return () => {
      disposed = true;
      listeners.dispose();
      clearTimeout(pollTimer); clearTimeout(changeTimer);
      if (refreshRef.current === requestScan) refreshRef.current = () => {};
    };
  }, [environmentId, enabled]);

  return { snapshot, setSnapshot: updateSnapshot, ready, refreshing, refresh, error: watchError ?? error };
}
