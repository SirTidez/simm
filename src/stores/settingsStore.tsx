import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import type { Settings, DepotDownloaderInfo } from '../types';
import { ApiService } from '../services/api';

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

export function SettingsStoreProvider({ children }: { children: React.ReactNode }) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [depotDownloader, setDepotDownloader] = useState<DepotDownloaderInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Apply theme to document
  const applyTheme = useCallback((theme: 'light' | 'dark') => {
    const root = document.documentElement;
    if (theme === 'light') {
      root.style.setProperty('color-scheme', 'light');
      root.style.setProperty('--app-bg-color', '#f8f9fa');
      root.style.setProperty('--app-text-color', '#212529');
      root.style.setProperty('--header-bg-color', '#ffffff');
      root.style.setProperty('--border-color', '#dee2e6');
      root.style.setProperty('--card-bg-color', '#ffffff');
      root.style.setProperty('--card-border-color', '#e9ecef');
      root.style.setProperty('--text-secondary', '#6c757d');
      root.style.setProperty('--input-bg-color', '#ffffff');
      root.style.setProperty('--input-border-color', '#ced4da');
      root.style.setProperty('--input-text-color', '#212529');
      root.style.setProperty('--btn-secondary-bg', '#e9ecef');
      root.style.setProperty('--btn-secondary-hover', '#dee2e6');
      root.style.setProperty('--btn-secondary-text', '#212529');
      root.style.setProperty('--btn-secondary-border', '#ced4da');
      root.style.setProperty('--info-box-bg', '#e7f3ff');
      root.style.setProperty('--info-box-border', '#b3d9ff');
      root.style.setProperty('--warning-box-bg', '#fff3cd');
      root.style.setProperty('--warning-box-border', '#ffd700');
      root.style.setProperty('--info-panel-bg', '#f8f9fa');
      root.style.setProperty('--info-panel-border', '#e9ecef');
      root.style.setProperty('--modal-overlay', 'rgba(0, 0, 0, 0.5)');
    } else {
      root.style.setProperty('color-scheme', 'dark');
      root.style.setProperty('--app-bg-color', '#1a1a1a');
      root.style.setProperty('--app-text-color', 'rgba(255, 255, 255, 0.87)');
      root.style.setProperty('--header-bg-color', '#2a2a2a');
      root.style.setProperty('--border-color', '#3a3a3a');
      root.style.setProperty('--card-bg-color', '#2a2a2a');
      root.style.setProperty('--card-border-color', '#3a3a3a');
      root.style.setProperty('--text-secondary', '#cccccc');
      root.style.setProperty('--input-bg-color', '#1a1a1a');
      root.style.setProperty('--input-border-color', '#3a3a3a');
      root.style.setProperty('--input-text-color', '#ffffff');
      root.style.setProperty('--btn-secondary-bg', '#3a3a3a');
      root.style.setProperty('--btn-secondary-hover', '#4a4a4a');
      root.style.setProperty('--btn-secondary-text', '#ffffff');
      root.style.setProperty('--btn-secondary-border', '#4a4a4a');
      root.style.setProperty('--info-box-bg', '#1e3a5f');
      root.style.setProperty('--info-box-border', '#2a4a6f');
      root.style.setProperty('--warning-box-bg', '#5a3a1e');
      root.style.setProperty('--warning-box-border', '#6a4a2f');
      root.style.setProperty('--info-panel-bg', '#1a1a1a');
      root.style.setProperty('--info-panel-border', 'transparent');
      root.style.setProperty('--modal-overlay', 'rgba(0, 0, 0, 0.7)');
    }
    document.body.style.backgroundColor = theme === 'light' ? '#f8f9fa' : '#1a1a1a';
    document.body.style.color = theme === 'light' ? '#212529' : 'rgba(255, 255, 255, 0.87)';
  }, []);

  const refreshSettings = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const data = await ApiService.getSettings();
      setSettings(data);
      // Apply theme when settings are loaded
      if (data.theme) {
        applyTheme(data.theme);
      }
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
      await ApiService.saveSettings(updates);
      // Update local state immediately without full refresh to avoid loading state
      setSettings(prev => prev ? { ...prev, ...updates } : null);
      
      // Apply theme immediately if it changed
      if (updates.theme) {
        applyTheme(updates.theme);
      }
    } catch (err) {
      throw err;
    }
  }, [applyTheme]);

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

