import { useCallback, useEffect, useState } from 'react';

import { ApiService } from '../../services/api';
import { onModsChanged, onPluginsChanged, onUserLibsChanged } from '../../services/events';
import { getEffectiveLevel } from '../../utils/logLevel';

/** Same window the Logs view reads first, so the badge matches what it shows. */
const LOG_LINE_LIMIT = 4000;

export interface EnvironmentTabCounts {
  mods: number | null;
  plugins: number | null;
  userLibs: number | null;
  /** Errors in the environment's latest log. */
  logErrors: number | null;
}

const EMPTY_COUNTS: EnvironmentTabCounts = { mods: null, plugins: null, userLibs: null, logErrors: null };

// Last known counts per environment, so switching back does not flash empty tabs.
const countsCache = new Map<string, EnvironmentTabCounts>();

const toCount = (result: { count: number }) => result.count;
const unknown = () => null;

async function readLatestLogErrors(environmentId: string): Promise<number | null> {
  const files = await ApiService.getLogFiles(environmentId);
  const latest = files.find((file) => file.isLatest) ?? files[0];
  if (!latest) {
    return null;
  }
  const lines = await ApiService.readLogFile(latest.path, LOG_LINE_LIMIT);
  return lines.reduce((errors, line) => errors + (getEffectiveLevel(line) === 'ERROR' ? 1 : 0), 0);
}

/**
 * Counts behind the environment tab badges. Content counts follow the
 * backend's change events; the log error count is re-read when the window
 * regains focus, which is when a game session has usually just ended.
 */
export function useEnvironmentTabCounts(environmentId: string, enabled: boolean): EnvironmentTabCounts {
  const [counts, setCounts] = useState<EnvironmentTabCounts>(() => countsCache.get(environmentId) ?? EMPTY_COUNTS);

  const merge = useCallback((patch: Partial<EnvironmentTabCounts>) => {
    const next = { ...(countsCache.get(environmentId) ?? EMPTY_COUNTS), ...patch };
    countsCache.set(environmentId, next);
    setCounts(next);
  }, [environmentId]);

  useEffect(() => {
    setCounts(countsCache.get(environmentId) ?? EMPTY_COUNTS);
    if (!enabled) {
      return undefined;
    }

    let disposed = false;
    const apply = (patch: Partial<EnvironmentTabCounts>) => {
      if (!disposed) merge(patch);
    };
    const refreshMods = () => ApiService.getModsCount(environmentId).then(toCount, unknown).then((mods) => apply({ mods }));
    const refreshPlugins = () => ApiService.getPluginsCount(environmentId).then(toCount, unknown).then((plugins) => apply({ plugins }));
    const refreshUserLibs = () => ApiService.getUserLibsCount(environmentId).then(toCount, unknown).then((userLibs) => apply({ userLibs }));
    const refreshLogs = () => readLatestLogErrors(environmentId).catch(unknown).then((logErrors) => apply({ logErrors }));

    void refreshMods();
    void refreshPlugins();
    void refreshUserLibs();
    void refreshLogs();

    const forThisEnvironment = (refresh: () => Promise<void>) => (event: { environmentId: string }) => {
      if (event.environmentId === environmentId) void refresh();
    };
    const subscriptions = [
      onModsChanged(forThisEnvironment(refreshMods)),
      onPluginsChanged(forThisEnvironment(refreshPlugins)),
      onUserLibsChanged(forThisEnvironment(refreshUserLibs)),
    ].map((subscription) => subscription.catch(() => undefined));

    const handleFocus = () => void refreshLogs();
    window.addEventListener('focus', handleFocus);

    return () => {
      disposed = true;
      window.removeEventListener('focus', handleFocus);
      subscriptions.forEach((subscription) => void subscription.then((unlisten) => unlisten?.()));
    };
  }, [enabled, environmentId, merge]);

  return counts;
}
