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
  const applyTheme = useCallback((theme: 'light' | 'dark' | 'modern-blue' | 'custom', customTheme?: any) => {
    // Don't apply theme if custom theme editor is open (it manages its own theme)
    if ((window as any).__customThemeEditorOpen && theme === 'custom') {
      return;
    }
    const root = document.documentElement;
    // Set data-theme attribute for CSS targeting
    root.setAttribute('data-theme', theme);
    
    if (theme === 'light') {
      root.style.setProperty('color-scheme', 'light');
      root.style.setProperty('--app-bg-color', '#f0f2f5');
      root.style.setProperty('--app-text-color', '#212529');
      root.style.setProperty('--header-bg-color', 'rgba(255, 255, 255, 0.7)');
      root.style.setProperty('--border-color', 'rgba(222, 226, 230, 0.6)');
      root.style.setProperty('--card-bg-color', 'rgba(255, 255, 255, 0.6)');
      root.style.setProperty('--card-border-color', 'rgba(233, 236, 239, 0.5)');
      root.style.setProperty('--text-secondary', '#6c757d');
      root.style.setProperty('--input-bg-color', 'rgba(255, 255, 255, 0.7)');
      root.style.setProperty('--input-border-color', 'rgba(206, 212, 218, 0.6)');
      root.style.setProperty('--input-text-color', '#212529');
      root.style.setProperty('--btn-secondary-bg', 'rgba(233, 236, 239, 0.6)');
      root.style.setProperty('--btn-secondary-hover', 'rgba(222, 226, 230, 0.8)');
      root.style.setProperty('--btn-secondary-text', '#212529');
      root.style.setProperty('--btn-secondary-border', 'rgba(206, 212, 218, 0.5)');
      root.style.setProperty('--info-box-bg', 'rgba(231, 243, 255, 0.7)');
      root.style.setProperty('--info-box-border', 'rgba(179, 217, 255, 0.6)');
      root.style.setProperty('--warning-box-bg', 'rgba(255, 243, 205, 0.7)');
      root.style.setProperty('--warning-box-border', 'rgba(255, 215, 0, 0.6)');
      root.style.setProperty('--info-panel-bg', 'rgba(248, 249, 250, 0.6)');
      root.style.setProperty('--info-panel-border', 'rgba(233, 236, 239, 0.5)');
      root.style.setProperty('--modal-overlay', 'rgba(0, 0, 0, 0.5)');
      root.style.setProperty('--bg-gradient', 'linear-gradient(135deg, #e0f2fe 0%, #f0f9ff 25%, #fef3c7 50%, #fce7f3 75%, #e0e7ff 100%)');
      root.style.setProperty('--bg-pattern', 'radial-gradient(circle at 20% 50%, rgba(147, 197, 253, 0.3) 0%, transparent 50%), radial-gradient(circle at 80% 80%, rgba(251, 207, 232, 0.3) 0%, transparent 50%), radial-gradient(circle at 40% 20%, rgba(196, 181, 253, 0.2) 0%, transparent 50%)');
    } else if (theme === 'modern-blue') {
      root.style.setProperty('color-scheme', 'dark');
      root.style.setProperty('--app-bg-color', '#0a0e27');
      root.style.setProperty('--app-text-color', '#e0e7ff');
      root.style.setProperty('--header-bg-color', 'rgba(30, 58, 138, 0.6)');
      root.style.setProperty('--border-color', 'rgba(59, 130, 246, 0.5)');
      root.style.setProperty('--card-bg-color', 'rgba(30, 58, 138, 0.4)');
      root.style.setProperty('--card-border-color', 'rgba(59, 130, 246, 0.4)');
      root.style.setProperty('--text-secondary', '#a5b4fc');
      root.style.setProperty('--input-bg-color', 'rgba(15, 23, 42, 0.6)');
      root.style.setProperty('--input-border-color', 'rgba(59, 130, 246, 0.5)');
      root.style.setProperty('--input-text-color', '#e0e7ff');
      root.style.setProperty('--btn-secondary-bg', 'rgba(59, 130, 246, 0.3)');
      root.style.setProperty('--btn-secondary-hover', 'rgba(59, 130, 246, 0.5)');
      root.style.setProperty('--btn-secondary-text', '#e0e7ff');
      root.style.setProperty('--btn-secondary-border', 'rgba(59, 130, 246, 0.6)');
      root.style.setProperty('--info-box-bg', 'rgba(30, 58, 138, 0.5)');
      root.style.setProperty('--info-box-border', 'rgba(59, 130, 246, 0.6)');
      root.style.setProperty('--warning-box-bg', 'rgba(251, 191, 36, 0.3)');
      root.style.setProperty('--warning-box-border', 'rgba(251, 191, 36, 0.6)');
      root.style.setProperty('--info-panel-bg', 'rgba(30, 58, 138, 0.3)');
      root.style.setProperty('--info-panel-border', 'rgba(59, 130, 246, 0.4)');
      root.style.setProperty('--modal-overlay', 'rgba(10, 14, 39, 0.8)');
      root.style.setProperty('--bg-gradient', 'linear-gradient(135deg, #0a0e27 0%, #1e1b4b 25%, #312e81 50%, #1e3a8a 75%, #1e40af 100%)');
      root.style.setProperty('--bg-pattern', 'radial-gradient(circle at 10% 20%, rgba(59, 130, 246, 0.15) 0%, transparent 50%), radial-gradient(circle at 90% 80%, rgba(99, 102, 241, 0.15) 0%, transparent 50%), radial-gradient(circle at 50% 50%, rgba(139, 92, 246, 0.1) 0%, transparent 50%), radial-gradient(circle at 30% 70%, rgba(37, 99, 235, 0.12) 0%, transparent 50%)');
    } else if (theme === 'custom' && customTheme) {
      // Custom theme
      root.style.setProperty('color-scheme', 'dark');
      root.style.setProperty('--app-bg-color', customTheme.appBgColor || '#0f0f0f');
      root.style.setProperty('--app-text-color', customTheme.appTextColor || 'rgba(255, 255, 255, 0.87)');
      root.style.setProperty('--header-bg-color', customTheme.headerBgColor || 'rgba(42, 42, 42, 0.7)');
      root.style.setProperty('--border-color', customTheme.borderColor || 'rgba(58, 58, 58, 0.6)');
      root.style.setProperty('--card-bg-color', customTheme.cardBgColor || 'rgba(42, 42, 42, 0.6)');
      root.style.setProperty('--card-border-color', customTheme.cardBorderColor || 'rgba(58, 58, 58, 0.5)');
      root.style.setProperty('--text-secondary', customTheme.textSecondary || '#cccccc');
      root.style.setProperty('--input-bg-color', customTheme.inputBgColor || 'rgba(26, 26, 26, 0.7)');
      root.style.setProperty('--input-border-color', customTheme.inputBorderColor || 'rgba(58, 58, 58, 0.6)');
      root.style.setProperty('--input-text-color', customTheme.inputTextColor || '#ffffff');
      root.style.setProperty('--btn-secondary-bg', customTheme.btnSecondaryBg || 'rgba(58, 58, 58, 0.6)');
      root.style.setProperty('--btn-secondary-hover', customTheme.btnSecondaryHover || 'rgba(74, 74, 74, 0.8)');
      root.style.setProperty('--btn-secondary-text', customTheme.btnSecondaryText || '#ffffff');
      root.style.setProperty('--btn-secondary-border', customTheme.btnSecondaryBorder || 'rgba(74, 74, 74, 0.5)');
      root.style.setProperty('--info-box-bg', customTheme.infoBoxBg || 'rgba(30, 58, 95, 0.6)');
      root.style.setProperty('--info-box-border', customTheme.infoBoxBorder || 'rgba(42, 74, 111, 0.6)');
      root.style.setProperty('--warning-box-bg', customTheme.warningBoxBg || 'rgba(90, 58, 30, 0.6)');
      root.style.setProperty('--warning-box-border', customTheme.warningBoxBorder || 'rgba(106, 74, 47, 0.6)');
      root.style.setProperty('--info-panel-bg', customTheme.infoPanelBg || 'rgba(26, 26, 26, 0.6)');
      root.style.setProperty('--info-panel-border', customTheme.infoPanelBorder || 'rgba(58, 58, 58, 0.4)');
      root.style.setProperty('--modal-overlay', customTheme.modalOverlay || 'rgba(0, 0, 0, 0.7)');
      root.style.setProperty('--bg-gradient', customTheme.bgGradient || 'linear-gradient(135deg, #0f0f0f 0%, #1a1a2e 25%, #16213e 50%, #0f3460 75%, #1a1a1a 100%)');
      root.style.setProperty('--bg-pattern', customTheme.bgPattern || 'radial-gradient(circle at 20% 30%, rgba(79, 70, 229, 0.08) 0%, transparent 50%)');
      root.style.setProperty('--update-version-color', customTheme.updateVersionColor || '#ff9800');
      root.style.setProperty('--update-version-bg', customTheme.updateVersionBg || 'rgba(255, 152, 0, 0.1)');
      root.style.setProperty('--badge-gray', customTheme.badgeGray || '#4a4a4a');
      root.style.setProperty('--badge-blue', customTheme.badgeBlue || '#0066cc');
      root.style.setProperty('--badge-orange-red', customTheme.badgeOrangeRed || '#cc5500');
      root.style.setProperty('--badge-yellow', customTheme.badgeYellow || '#ffaa00');
      root.style.setProperty('--badge-green', customTheme.badgeGreen || '#28a745');
      root.style.setProperty('--badge-red', customTheme.badgeRed || '#dc3545');
      root.style.setProperty('--badge-orange', customTheme.badgeOrange || '#ff9800');
      root.style.setProperty('--badge-cyan', customTheme.badgeCyan || '#00bcd4');
      root.style.setProperty('--primary-btn-color', customTheme.primaryBtnColor || '#646cff');
      root.style.setProperty('--primary-btn-hover', customTheme.primaryBtnHover || '#535bf2');
    } else {
      // Dark theme (default)
      root.style.setProperty('color-scheme', 'dark');
      root.style.setProperty('--app-bg-color', '#0f0f0f');
      root.style.setProperty('--app-text-color', 'rgba(255, 255, 255, 0.87)');
      root.style.setProperty('--header-bg-color', 'rgba(42, 42, 42, 0.7)');
      root.style.setProperty('--border-color', 'rgba(58, 58, 58, 0.6)');
      root.style.setProperty('--card-bg-color', 'rgba(42, 42, 42, 0.6)');
      root.style.setProperty('--card-border-color', 'rgba(58, 58, 58, 0.5)');
      root.style.setProperty('--text-secondary', '#cccccc');
      root.style.setProperty('--input-bg-color', 'rgba(26, 26, 26, 0.7)');
      root.style.setProperty('--input-border-color', 'rgba(58, 58, 58, 0.6)');
      root.style.setProperty('--input-text-color', '#ffffff');
      root.style.setProperty('--btn-secondary-bg', 'rgba(58, 58, 58, 0.6)');
      root.style.setProperty('--btn-secondary-hover', 'rgba(74, 74, 74, 0.8)');
      root.style.setProperty('--btn-secondary-text', '#ffffff');
      root.style.setProperty('--btn-secondary-border', 'rgba(74, 74, 74, 0.5)');
      root.style.setProperty('--info-box-bg', 'rgba(30, 58, 95, 0.6)');
      root.style.setProperty('--info-box-border', 'rgba(42, 74, 111, 0.6)');
      root.style.setProperty('--warning-box-bg', 'rgba(90, 58, 30, 0.6)');
      root.style.setProperty('--warning-box-border', 'rgba(106, 74, 47, 0.6)');
      root.style.setProperty('--info-panel-bg', 'rgba(26, 26, 26, 0.6)');
      root.style.setProperty('--info-panel-border', 'rgba(58, 58, 58, 0.4)');
      root.style.setProperty('--modal-overlay', 'rgba(0, 0, 0, 0.7)');
      root.style.setProperty('--bg-gradient', 'linear-gradient(135deg, #0f0f0f 0%, #1a1a2e 25%, #16213e 50%, #0f3460 75%, #1a1a1a 100%)');
      root.style.setProperty('--bg-pattern', 'radial-gradient(circle at 20% 30%, rgba(79, 70, 229, 0.08) 0%, transparent 50%), radial-gradient(circle at 80% 70%, rgba(139, 92, 246, 0.08) 0%, transparent 50%), radial-gradient(circle at 50% 50%, rgba(99, 102, 241, 0.06) 0%, transparent 50%)');
    }
    document.body.style.backgroundColor = theme === 'light' ? '#f0f2f5' : theme === 'modern-blue' ? '#0a0e27' : theme === 'custom' ? (customTheme?.appBgColor || '#0f0f0f') : '#0f0f0f';
    document.body.style.color = theme === 'light' ? '#212529' : theme === 'modern-blue' ? '#e0e7ff' : theme === 'custom' ? (customTheme?.appTextColor || 'rgba(255, 255, 255, 0.87)') : 'rgba(255, 255, 255, 0.87)';
  }, []);

  const refreshSettings = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const data = await ApiService.getSettings();
      setSettings(data);
      // Apply theme when settings are loaded (default to modern-blue if not set)
      applyTheme(data.theme || 'modern-blue', data.customTheme);
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
      const newSettings = { ...(settings || {}), ...updates } as Settings;
      setSettings(newSettings);
      
      // Apply theme immediately if it changed (use the updated settings)
      if (updates.theme) {
        applyTheme(updates.theme, updates.customTheme || newSettings.customTheme);
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

