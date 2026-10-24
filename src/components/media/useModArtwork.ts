import { useCallback, useMemo } from 'react';

import { useModLibraryStore } from '../../stores/modLibraryStore';
import type { ModArtwork } from './ModThumbnail';

/** Lower-case letters and digits only, so "Better Dealers", "BetterDealers.dll" and "betterdealers" meet. */
export function normalizeModKey(value: string): string {
  return value
    .toLowerCase()
    .replace(/\.(dll|zip|json|cfg|ini|toml)$/i, '')
    .replace(/[^a-z0-9]/g, '');
}

/**
 * Looks up a mod's artwork from the shared Mod Library by any name the app sees
 * for it: display name, package/source id, or one of its file names. Log mod
 * tags, config folders and profile items use this to show the same icon as the
 * library.
 */
export function useModArtwork(): (name: string | null | undefined) => ModArtwork | null {
  const { library } = useModLibraryStore();

  const index = useMemo(() => {
    const map = new Map<string, ModArtwork>();
    for (const entry of library?.downloaded ?? []) {
      if (!entry.iconUrl && !entry.iconCachePath) continue;
      const artwork: ModArtwork = { iconUrl: entry.iconUrl, iconCachePath: entry.iconCachePath };
      const keys = [entry.displayName, entry.sourceId?.split('/').pop(), ...(entry.files ?? [])];
      for (const key of keys) {
        if (!key) continue;
        const normalized = normalizeModKey(key);
        if (normalized && !map.has(normalized)) map.set(normalized, artwork);
      }
    }
    return map;
  }, [library]);

  return useCallback((name) => (name ? index.get(normalizeModKey(name)) ?? null : null), [index]);
}
