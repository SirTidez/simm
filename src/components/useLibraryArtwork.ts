import { useEffect } from 'react';

import { useModLibraryStore } from '../stores/modLibraryStore';
import { useModArtwork } from './media/useModArtwork';

/**
 * `useModArtwork()` for surfaces that may open before anything else loaded the
 * Mod Library (Logs, Config, Profiles, Downloads, Telemetry): it asks the shared
 * store for its snapshot once, so mod names resolve to their library artwork.
 */
export function useLibraryArtwork() {
  const { library, ensureLibrary } = useModLibraryStore();
  useEffect(() => {
    if (!library) {
      void Promise.resolve()
        .then(() => ensureLibrary())
        .catch(() => undefined);
    }
  }, [library, ensureLibrary]);
  return useModArtwork();
}
