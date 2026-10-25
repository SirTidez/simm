import { useEffect, useMemo } from 'react';

import { buildEnvironmentModSnapshot } from '../../services/modLibrarySummary';
import { useModLibraryStore } from '../../stores/modLibraryStore';
import type { Environment } from '../../types';

export interface EnvironmentModUpdateCounts {
  /** Updates per environment. */
  byEnvironment: Map<string, number>;
  /** Distinct mods with an update across all environments. */
  distinctTotal: number;
}

/** Mod update counts derived from the shared mod library. */
export function useEnvironmentModUpdateCounts(environments: Environment[]): EnvironmentModUpdateCounts {
  const { library, ensureLibrary } = useModLibraryStore();
  const hasCompletedEnvironment = environments.some((environment) => environment.status === 'completed');

  useEffect(() => {
    if (!library && hasCompletedEnvironment) {
      void ensureLibrary().catch(() => undefined);
    }
  }, [ensureLibrary, hasCompletedEnvironment, library]);

  return useMemo(() => {
    const byEnvironment = new Map<string, number>();
    const distinct = new Set<string>();
    if (!library) {
      return { byEnvironment, distinctTotal: 0 };
    }
    for (const environment of environments) {
      if (environment.status !== 'completed') {
        continue;
      }
      const snapshot = buildEnvironmentModSnapshot(library, environment.id);
      byEnvironment.set(environment.id, snapshot.updateCount);
      snapshot.updates.forEach((update) => distinct.add(update.groupKey));
    }
    return { byEnvironment, distinctTotal: distinct.size };
  }, [environments, library]);
}
