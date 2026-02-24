import React, { useState, useEffect } from 'react';
import { useEnvironmentStore } from '../stores/environmentStore';
import { logger } from '../services/logger';
import { ApiService } from '../services/api';
import { onModUpdatesChecked } from '../services/events';
import { batchUpdateCheckRef, lastUpdateCheckTimeRef } from './EnvironmentList';

interface ModUpdatesEntry {
  count: number;
  updates: Array<{ modFileName: string; modName: string; currentVersion: string; latestVersion: string; source: string }>;
}

// Version injected at build time by Vite
declare const __APP_VERSION__: string;
const APP_VERSION = __APP_VERSION__;

export function Footer() {
  const { environments, checkAllUpdates } = useEnvironmentStore();
  const [checkingAll, setCheckingAll] = useState(false);
  const [currentTime, setCurrentTime] = useState(Date.now());
  const [modUpdatesByEnv, setModUpdatesByEnv] = useState<Map<string, ModUpdatesEntry>>(new Map());

  const totalModsNeedingUpdate = Array.from(modUpdatesByEnv.values()).reduce((sum, e) => sum + e.count, 0);

  // Update current time every 30 seconds to refresh the "Last check" display
  useEffect(() => {
    const interval = setInterval(() => {
      setCurrentTime(Date.now());
    }, 30000);

    return () => clearInterval(interval);
  }, []);

  // Load mod updates summary for completed environments
  const loadModUpdatesSummary = React.useCallback(async () => {
    try {
      const summary = await ApiService.getAllModUpdatesSummary();
      const map = new Map<string, ModUpdatesEntry>();
      for (const entry of summary) {
        map.set(entry.environmentId, { count: entry.count, updates: entry.updates });
      }
      setModUpdatesByEnv(map);
    } catch (err) {
      console.warn('Failed to load mod updates summary:', err);
    }
  }, []);

  useEffect(() => {
    const completedCount = environments.filter(env => env.status === 'completed').length;
    if (completedCount > 0) {
      loadModUpdatesSummary();
    }
  }, [environments, loadModUpdatesSummary]);

  // Subscribe to mod_updates_checked (from backend) to refresh when mod checks complete
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    onModUpdatesChecked((data) => {
      setModUpdatesByEnv(prev => {
        const next = new Map(prev);
        next.set(data.environmentId, { count: data.count, updates: data.updates });
        return next;
      });
    }).then(fn => { unlisten = fn; });
    return () => { unlisten?.(); };
  }, []);

  // Also refresh when ModsOverlay runs check (custom event from EnvironmentList)
  useEffect(() => {
    const handler = () => loadModUpdatesSummary();
    window.addEventListener('mod-updates-checked', handler);
    return () => window.removeEventListener('mod-updates-checked', handler);
  }, [loadModUpdatesSummary]);

  // Calculate update check statistics
  const completedEnvs = environments.filter(env => env.status === 'completed');
  const envsWithUpdates = completedEnvs.filter(env => env.updateAvailable);
  const envsChecked = completedEnvs.filter(env => env.lastUpdateCheck);

  // Get the most recent update check time
  const mostRecentCheck = envsChecked.length > 0
    ? envsChecked.reduce((latest, env) => {
        if (!env.lastUpdateCheck) return latest;

        let envCheckTime: number;
        if (typeof env.lastUpdateCheck === 'number') {
          envCheckTime = env.lastUpdateCheck < 946684800000
            ? env.lastUpdateCheck * 1000
            : env.lastUpdateCheck;
        } else {
          envCheckTime = new Date(env.lastUpdateCheck).getTime();
        }

        let latestTime: number;
        if (latest) {
          if (typeof latest === 'number') {
            latestTime = latest < 946684800000 ? latest * 1000 : latest;
          } else {
            latestTime = new Date(latest).getTime();
          }
        } else {
          latestTime = 0;
        }

        return envCheckTime > latestTime ? env.lastUpdateCheck : latest;
      }, envsChecked[0].lastUpdateCheck || null)
    : null;

  const formatLastCheck = (dateValue?: string | number) => {
    if (!dateValue) return 'Never';
    try {
      let date: Date;
      if (typeof dateValue === 'number') {
        date = dateValue < 946684800000
          ? new Date(dateValue * 1000)
          : new Date(dateValue);
      } else {
        date = new Date(dateValue);
      }

      if (isNaN(date.getTime())) return 'Invalid date';

      const now = new Date();
      const diffMs = now.getTime() - date.getTime();
      const diffMins = Math.floor(diffMs / 60000);
      const diffHours = Math.floor(diffMs / 3600000);
      const diffDays = Math.floor(diffMs / 86400000);

      if (diffMins < 1) return 'just now';
      if (diffMins < 60) return `${diffMins}m ago`;
      if (diffHours < 24) return `${diffHours}h ago`;
      if (diffDays < 7) return `${diffDays}d ago`;
      return date.toLocaleDateString();
    } catch {
      return 'Invalid date';
    }
  };

  const handleCheckAllUpdates = async (e: React.MouseEvent<HTMLButtonElement>) => {
    e.preventDefault();
    e.stopPropagation();

    logger.info('Footer: Check updates button clicked');

    const allEnvs = environments.filter(env => env.status !== 'error');

    if (checkingAll || allEnvs.length === 0) return;

    try {
      setCheckingAll(true);
      batchUpdateCheckRef.current = true;
      lastUpdateCheckTimeRef.current = Date.now();
      await checkAllUpdates(true);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Unknown error';
      logger.error(`Footer: Update check failed - ${errorMessage}`);
    } finally {
      batchUpdateCheckRef.current = false;
      setCheckingAll(false);
      loadModUpdatesSummary();
    }
  };

  // Suppress unused warning
  void currentTime;

  return (
    <footer className="app-statusbar">
      <div className="statusbar-left">
        {completedEnvs.length > 0 && (
          <span className="statusbar-stat">
            {completedEnvs.length} install{completedEnvs.length !== 1 ? 's' : ''}
          </span>
        )}
        {completedEnvs.length > 0 && (
          <>
            {envsWithUpdates.length === 0 ? (
              <span className="statusbar-stat statusbar-stat-ok">
                &bull; Games up to date
              </span>
            ) : envsWithUpdates.length === 1 ? (
              <span className="statusbar-stat statusbar-stat-warn">
                &bull; 1 Game needs updating
              </span>
            ) : (
              <span className="statusbar-stat statusbar-stat-warn">
                &bull; {envsWithUpdates.length} Games need updating
              </span>
            )}
          </>
        )}
        {completedEnvs.length > 0 && (
          <>
            {totalModsNeedingUpdate === 0 ? (
              <span className="statusbar-stat statusbar-stat-ok">
                &bull; Mods up to date
              </span>
            ) : totalModsNeedingUpdate === 1 ? (
              <span className="statusbar-stat statusbar-stat-warn">
                &bull; 1 Mod needs updating
              </span>
            ) : (
              <span className="statusbar-stat statusbar-stat-warn">
                &bull; {totalModsNeedingUpdate} Mods need updating
              </span>
            )}
          </>
        )}
        {mostRecentCheck ? (
          <span className="statusbar-stat statusbar-check">
            &bull;{' '}
            {checkingAll ? (
              <>Checking<span className="checking-dots"></span></>
            ) : (
              <>Last check: {formatLastCheck(mostRecentCheck)}</>
            )}
          </span>
        ) : checkingAll ? (
          <span className="statusbar-stat statusbar-check">
            Checking<span className="checking-dots"></span>
          </span>
        ) : null}
        {environments.length > 0 && (
          <button
            onClick={handleCheckAllUpdates}
            className="btn btn-icon-small statusbar-refresh-btn"
            disabled={checkingAll}
            title={checkingAll ? 'Checking for updates...' : 'Check for updates'}
            type="button"
            aria-label="Check for updates"
          >
            <i className={`fas ${checkingAll ? 'fa-sync-alt fa-spin' : 'fa-sync-alt'}`}></i>
          </button>
        )}
      </div>
      <div className="statusbar-right">
        <span className="statusbar-version">v{APP_VERSION}</span>
      </div>
    </footer>
  );
}
