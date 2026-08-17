import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { ModLibraryResult } from "../types";
import { ApiService } from "../services/api";
import {
  onModMetadataRefreshStatus,
  onModUpdatesChecked,
  onModsChanged,
  onModsSnapshotUpdated,
  onPluginsChanged,
  onUserLibsChanged,
} from "../services/events";
import { normalizeLibraryFeaturedDownloads } from "../services/featuredDownloads";
import { logger } from "../services/logger";

interface ModLibraryStoreContextValue {
  library: ModLibraryResult | null;
  loading: boolean;
  error: string | null;
  /** Increments whenever an external mutation invalidates the shared snapshot. */
  version: number;
  ensureLibrary: () => Promise<ModLibraryResult>;
  refreshLibrary: () => Promise<ModLibraryResult>;
  invalidateLibrary: () => void;
}

const ModLibraryStoreContext =
  createContext<ModLibraryStoreContextValue | null>(null);

function emptyLibrary(): ModLibraryResult {
  return { downloaded: [] };
}

export function ModLibraryStoreProvider({ children }: { children: ReactNode }) {
  const [library, setLibrary] = useState<ModLibraryResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const libraryRef = useRef<ModLibraryResult | null>(null);
  const staleRef = useRef(true);
  const requestRef = useRef<Promise<ModLibraryResult> | null>(null);
  const invalidationVersionRef = useRef(0);

  const invalidateLibrary = useCallback(() => {
    invalidationVersionRef.current += 1;
    staleRef.current = true;
    setVersion((current) => current + 1);
  }, []);

  const refreshLibrary = useCallback(async () => {
    if (requestRef.current) {
      return requestRef.current;
    }

    const requestInvalidationVersion = invalidationVersionRef.current;
    setLoading(true);
    setError(null);
    const request = (async () => {
      try {
        const data = await normalizeLibraryFeaturedDownloads(
          await ApiService.getModLibrary(),
        );
        const next = data ?? emptyLibrary();
        libraryRef.current = next;
        // A change event can arrive while this snapshot is loading. Keep that
        // invalidation instead of treating the older response as current.
        staleRef.current =
          invalidationVersionRef.current !== requestInvalidationVersion;
        setLibrary(next);
        return next;
      } catch (cause) {
        const message =
          cause instanceof Error ? cause.message : "Failed to load mod library";
        setError(message);
        logger.error("Failed to load mod library snapshot", { error: message });
        throw cause;
      } finally {
        setLoading(false);
      }
    })();

    requestRef.current = request;
    try {
      return await request;
    } finally {
      if (requestRef.current === request) {
        requestRef.current = null;
      }
      if (invalidationVersionRef.current !== requestInvalidationVersion) {
        // Collapse any number of in-flight invalidations into one follow-up
        // request, so the latest backend state wins without a polling loop.
        void refreshLibrary().catch(() => {
          // The store exposes the failed refresh through error while retaining
          // the last usable snapshot.
        });
      }
    }
  }, []);

  const ensureLibrary = useCallback(async () => {
    if (libraryRef.current && !staleRef.current) {
      return libraryRef.current;
    }
    return refreshLibrary();
  }, [refreshLibrary]);

  useEffect(() => {
    let disposed = false;
    let metadataWasRunning = false;
    const unlisteners: Array<() => void> = [];

    const refreshAfterInvalidation = () => {
      invalidateLibrary();
      void refreshLibrary().catch(() => {
        // The store retains the last successful snapshot and exposes the error.
      });
    };

    const register = async (subscribe: () => Promise<() => void>) => {
      try {
        const unlisten = await subscribe();
        if (disposed) {
          unlisten();
          return;
        }
        unlisteners.push(unlisten);
      } catch (cause) {
        logger.warn("Failed to register mod library change listener", {
          error: cause instanceof Error ? cause.message : String(cause),
        });
      }
    };

    // Filesystem watchers emit mods_changed before their complete snapshot.
    // Invalidate on the first edge and reload only at the snapshot boundary.
    void register(() => onModsChanged(invalidateLibrary));
    void register(() => onModsSnapshotUpdated(refreshAfterInvalidation));
    void register(() => onPluginsChanged(refreshAfterInvalidation));
    void register(() => onUserLibsChanged(refreshAfterInvalidation));
    void register(() => onModUpdatesChecked(refreshAfterInvalidation));
    void register(() =>
      onModMetadataRefreshStatus((status) => {
        const running =
          Boolean(status.running) || (status.activeCount || 0) > 0;
        if (metadataWasRunning && !running) {
          refreshAfterInvalidation();
        }
        metadataWasRunning = running;
      }),
    );

    return () => {
      disposed = true;
      unlisteners.forEach((unlisten) => unlisten());
    };
  }, [invalidateLibrary, refreshLibrary]);

  return (
    <ModLibraryStoreContext.Provider
      value={{
        library,
        loading,
        error,
        version,
        ensureLibrary,
        refreshLibrary,
        invalidateLibrary,
      }}
    >
      {children}
    </ModLibraryStoreContext.Provider>
  );
}

export function useModLibraryStore() {
  const context = useContext(ModLibraryStoreContext);
  if (!context) {
    throw new Error(
      "useModLibraryStore must be used within ModLibraryStoreProvider",
    );
  }
  return context;
}
