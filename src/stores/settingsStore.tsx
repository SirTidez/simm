import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import type { Settings, DepotDownloaderInfo } from '../types';
import { ApiService } from '../services/api';
import {
  applyBuiltInTheme,
  normalizeThemeSelection,
  persistThemeSelection,
} from '../utils/theme';

interface SettingsStoreContextValue {
  settings: Settings | null;
  depotDownloader: DepotDownloaderInfo | null;
  loading: boolean;
  error: string | null;
  refreshSettings: () => Promise<void>;
  updateSettings: (updates: Partial<Settings>) => Promise<void>;
  refreshDepotDownloader: () => Promise<void>;
}

const SettingsStoreContext = createContext<SettingsStoreContextValue | null>(null);

const sanitizeThemeSettings = (settings: Settings): Settings => {
  const normalizedTheme = normalizeThemeSelection(settings.theme);
  return {
    ...settings,
    theme: normalizedTheme,
  };
};

export function SettingsStoreProvider({ children }: { children: React.ReactNode }) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [depotDownloader, setDepotDownloader] = useState<DepotDownloaderInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const applyTheme = useCallback((theme: Settings['theme'] | undefined) => {
    const normalizedTheme = normalizeThemeSelection(theme);
    applyBuiltInTheme(normalizedTheme);
    persistThemeSelection(normalizedTheme);
  }, []);

  const refreshSettings = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const data = await ApiService.getSettings();
      const sanitizedSettings = sanitizeThemeSettings(data);
      setSettings(sanitizedSettings);
      applyTheme(sanitizedSettings.theme);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load settings');
    } finally {
      setLoading(false);
    }
  }, [applyTheme]);

  const refreshDepotDownloader = useCallback(async () => {
    try {
      const info = await ApiService.detectDepotDownloader();
      setDepotDownloader(info);
    } catch (err) {
      console.error('Failed to detect DepotDownloader:', err);
    }
  }, []);

  const updateSettings = useCallback(async (updates: Partial<Settings>) => {
    try {
      const normalizedUpdates: Partial<Settings> = {
        ...updates,
      };

      if (updates.theme) {
        normalizedUpdates.theme = normalizeThemeSelection(updates.theme);
      }

      await ApiService.saveSettings(normalizedUpdates);
      // Update local state immediately without full refresh to avoid loading state
      const newSettings = sanitizeThemeSettings({ ...(settings || {}), ...normalizedUpdates } as Settings);
      setSettings(newSettings);
      
      if (normalizedUpdates.theme) {
        applyTheme(newSettings.theme);
      }
    } catch (err) {
      throw err;
    }
  }, [applyTheme, settings]);

  useEffect(() => {
    refreshSettings();
    refreshDepotDownloader();
  }, [refreshSettings, refreshDepotDownloader]);

  return (
    <SettingsStoreContext.Provider
      value={{
        settings,
        depotDownloader,
        loading,
        error,
        refreshSettings,
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

