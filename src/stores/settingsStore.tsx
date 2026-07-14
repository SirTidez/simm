import React, { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react';
import type { Settings, DepotDownloaderInfo, CustomThemeDefinition } from '../types';
import { ApiService } from '../services/api';
import { logger } from '../services/logger';
import {
  applyThemeSelection,
  isBuiltInTheme,
  normalizeThemeSelection,
  resolveThemeSelection,
} from '../utils/theme';

interface SettingsStoreContextValue {
  settings: Settings | null;
  customThemes: CustomThemeDefinition[];
  themesDirectory: string | null;
  depotDownloader: DepotDownloaderInfo | null;
  loading: boolean;
  error: string | null;
  refreshSettings: () => Promise<void>;
  refreshThemes: () => Promise<void>;
  updateSettings: (updates: Partial<Settings>) => Promise<void>;
  refreshDepotDownloader: () => Promise<void>;
}

const SettingsStoreContext = createContext<SettingsStoreContextValue | null>(null);

const sanitizeThemeSettings = (
  settings: Settings,
  customThemes: CustomThemeDefinition[],
): Settings => {
  const normalizedTheme = resolveThemeSelection(settings.theme, customThemes);
  return {
    ...settings,
    theme: normalizedTheme,
  };
};

export function SettingsStoreProvider({ children }: { children: React.ReactNode }) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [customThemes, setCustomThemes] = useState<CustomThemeDefinition[]>([]);
  const [themesDirectory, setThemesDirectory] = useState<string | null>(null);
  const [depotDownloader, setDepotDownloader] = useState<DepotDownloaderInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const customThemesRef = useRef<CustomThemeDefinition[]>([]);
  const themesDirectoryRef = useRef<string | null>(null);
  const refreshSettingsInFlightRef = useRef<Promise<void> | null>(null);
  const refreshDepotDownloaderInFlightRef = useRef<Promise<void> | null>(null);

  const applyTheme = useCallback((
    theme: Settings['theme'] | undefined,
    availableCustomThemes: CustomThemeDefinition[],
  ) => {
    return applyThemeSelection(theme ?? 'modern-blue', availableCustomThemes);
  }, []);

  useEffect(() => {
    customThemesRef.current = customThemes;
  }, [customThemes]);

  useEffect(() => {
    themesDirectoryRef.current = themesDirectory;
  }, [themesDirectory]);

  const refreshSettings = useCallback(async () => {
    if (refreshSettingsInFlightRef.current) {
      return refreshSettingsInFlightRef.current;
    }

    const request = (async () => {
      setLoading(true);
      setError(null);
      const [settingsResult, themesResult, directoryResult] = await Promise.allSettled([
        ApiService.getSettings(),
        ApiService.getCustomThemes(),
        ApiService.getThemesDirectory(),
      ]);
      if (settingsResult.status === 'rejected') {
        throw settingsResult.reason;
      }

      const data = settingsResult.value;
      const nextCustomThemes = themesResult.status === 'fulfilled'
        ? themesResult.value
        : customThemesRef.current;
      const nextThemesDirectory = directoryResult.status === 'fulfilled'
        ? directoryResult.value
        : themesDirectoryRef.current;

      if (themesResult.status === 'rejected') {
        logger.warn('Failed to refresh custom themes during settings load', themesResult.reason);
      }
      if (directoryResult.status === 'rejected') {
        logger.warn('Failed to resolve themes directory during settings load', directoryResult.reason);
      }

      const normalizedTheme = normalizeThemeSelection(data.theme);
      const shouldPreserveUnresolvedCustomTheme =
        themesResult.status === 'rejected' && !isBuiltInTheme(normalizedTheme);
      const sanitizedSettings = shouldPreserveUnresolvedCustomTheme
        ? { ...data, theme: normalizedTheme }
        : sanitizeThemeSettings(data, nextCustomThemes);
      const resolvedTheme = shouldPreserveUnresolvedCustomTheme
        ? sanitizedSettings.theme
        : applyTheme(sanitizedSettings.theme, nextCustomThemes);

      setCustomThemes(nextCustomThemes);
      setThemesDirectory(nextThemesDirectory);
      setSettings(sanitizedSettings);
      if (resolvedTheme !== sanitizedSettings.theme) {
        setSettings({ ...sanitizedSettings, theme: resolvedTheme });
      }
    })();

    const operation = request.catch((err) => {
      logger.error('Failed to refresh application settings', err);
      setError(err instanceof Error ? err.message : 'Failed to load settings');
    }).finally(() => {
      if (refreshSettingsInFlightRef.current === operation) {
        refreshSettingsInFlightRef.current = null;
      }
      setLoading(false);
    });

    refreshSettingsInFlightRef.current = operation;
    return operation;
  }, [applyTheme]);

  const refreshThemes = useCallback(async () => {
    try {
      setError(null);
      const [themesResult, directoryResult] = await Promise.allSettled([
        ApiService.getCustomThemes(),
        ApiService.getThemesDirectory(),
      ]);

      if (themesResult.status === 'rejected') {
        logger.warn('Failed to refresh custom themes', themesResult.reason);
      }
      if (directoryResult.status === 'rejected') {
        logger.warn('Failed to resolve themes directory', directoryResult.reason);
      }
      if (themesResult.status === 'rejected' || directoryResult.status === 'rejected') {
        const reasons = [themesResult, directoryResult]
          .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
          .map((result) =>
            result.reason instanceof Error ? result.reason.message : String(result.reason),
          )
          .filter(Boolean);
        const message = reasons[0] || 'Failed to load custom themes';
        setError(message);
        throw new Error(message);
      }

      const nextCustomThemes = themesResult.status === 'fulfilled' ? themesResult.value : [];
      const nextThemesDirectory = directoryResult.status === 'fulfilled' ? directoryResult.value : null;

      setCustomThemes(nextCustomThemes);
      setThemesDirectory(nextThemesDirectory);

      if (settings) {
        const sanitizedSettings = sanitizeThemeSettings(settings, nextCustomThemes);
        const resolvedTheme = applyTheme(sanitizedSettings.theme, nextCustomThemes);
        setSettings({ ...sanitizedSettings, theme: resolvedTheme });
      }
    } catch (err) {
      logger.error('Failed to refresh custom themes', err);
      setError(err instanceof Error ? err.message : 'Failed to load custom themes');
      throw err;
    }
  }, [applyTheme, settings]);

  const refreshDepotDownloader = useCallback(async () => {
    if (refreshDepotDownloaderInFlightRef.current) {
      return refreshDepotDownloaderInFlightRef.current;
    }

    const request = (async () => {
      const info = await ApiService.detectDepotDownloader();
      setDepotDownloader(info);
    })();

    const operation = request.catch((err) => {
      logger.warn('Failed to detect DepotDownloader', err);
    }).finally(() => {
      if (refreshDepotDownloaderInFlightRef.current === operation) {
        refreshDepotDownloaderInFlightRef.current = null;
      }
    });

    refreshDepotDownloaderInFlightRef.current = operation;
    return operation;
  }, []);

  const updateSettings = useCallback(async (updates: Partial<Settings>) => {
    try {
      const normalizedUpdates: Partial<Settings> = {
        ...updates,
      };

      if (updates.theme) {
        normalizedUpdates.theme = resolveThemeSelection(updates.theme, customThemes);
      }

      await ApiService.saveSettings(normalizedUpdates);
      if (settings === null) {
        const next = await ApiService.getSettings();
        const sanitized = sanitizeThemeSettings(next, customThemes);
        const resolvedTheme = normalizedUpdates.theme
          ? applyTheme(sanitized.theme, customThemes)
          : sanitized.theme;
        setSettings({ ...sanitized, theme: resolvedTheme });
        return;
      }
      // Update local state immediately without full refresh to avoid loading state
      const mergedSettings: Settings = {
        ...settings,
        ...normalizedUpdates,
        appUpdate: normalizedUpdates.appUpdate
          ? {
              ...(settings.appUpdate ?? {}),
              ...normalizedUpdates.appUpdate,
            }
          : settings.appUpdate,
      };
      const newSettings = sanitizeThemeSettings(
        mergedSettings,
        customThemes,
      );
      const resolvedTheme = normalizedUpdates.theme
        ? applyTheme(newSettings.theme, customThemes)
        : newSettings.theme;
      setSettings({ ...newSettings, theme: resolvedTheme });

    } catch (err) {
      logger.error('Failed to persist settings update', err);
      throw err;
    }
  }, [applyTheme, customThemes, settings]);

  useEffect(() => {
    refreshSettings();
    refreshDepotDownloader();
  }, [refreshSettings, refreshDepotDownloader]);

  return (
    <SettingsStoreContext.Provider
      value={{
        settings,
        customThemes,
        themesDirectory,
        depotDownloader,
        loading,
        error,
        refreshSettings,
        refreshThemes,
        updateSettings,
        refreshDepotDownloader
      }}
    >
      {children}
    </SettingsStoreContext.Provider>
  );
}

export function useSettingsStore() {
  const context = useContext(SettingsStoreContext);
  if (!context) {
    throw new Error('useSettingsStore must be used within SettingsStoreProvider');
  }
  return context;
}
