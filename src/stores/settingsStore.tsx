import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import type { Settings, DepotDownloaderInfo, CustomThemeDefinition } from '../types';
import { ApiService } from '../services/api';
import { logger } from '../services/logger';
import {
  applyThemeSelection,
  persistThemeSelection,
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

  const applyTheme = useCallback((
    theme: Settings['theme'] | undefined,
    availableCustomThemes: CustomThemeDefinition[],
  ) => {
    const resolvedTheme = applyThemeSelection(theme ?? 'modern-blue', availableCustomThemes);
    persistThemeSelection(resolvedTheme);
    return resolvedTheme;
  }, []);

  const refreshSettings = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const [data, nextCustomThemes, nextThemesDirectory] = await Promise.all([
        ApiService.getSettings(),
        ApiService.getCustomThemes(),
        ApiService.getThemesDirectory(),
      ]);
      const sanitizedSettings = sanitizeThemeSettings(data, nextCustomThemes);
      const resolvedTheme = applyTheme(sanitizedSettings.theme, nextCustomThemes);

      setCustomThemes(nextCustomThemes);
      setThemesDirectory(nextThemesDirectory);
      setSettings(sanitizedSettings);
      if (resolvedTheme !== sanitizedSettings.theme) {
        setSettings({ ...sanitizedSettings, theme: resolvedTheme });
      }
    } catch (err) {
      logger.error('Failed to refresh application settings', err);
      setError(err instanceof Error ? err.message : 'Failed to load settings');
    } finally {
      setLoading(false);
    }
  }, [applyTheme]);

  const refreshThemes = useCallback(async () => {
    try {
      setError(null);
      const [nextCustomThemes, nextThemesDirectory] = await Promise.all([
        ApiService.getCustomThemes(),
        ApiService.getThemesDirectory(),
      ]);

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
    try {
      const info = await ApiService.detectDepotDownloader();
      setDepotDownloader(info);
    } catch (err) {
      logger.warn('Failed to detect DepotDownloader', err);
    }
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
      // Update local state immediately without full refresh to avoid loading state
      const newSettings = sanitizeThemeSettings(
        { ...(settings || {}), ...normalizedUpdates } as Settings,
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

