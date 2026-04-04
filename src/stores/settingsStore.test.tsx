import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent, cleanup } from '@testing-library/react';
import { SettingsStoreProvider, useSettingsStore } from './settingsStore';
import type { CustomThemeDefinition, Settings } from '../types';
import { THEME_BASE_STORAGE_KEY, THEME_STORAGE_KEY } from '../utils/theme';

const apiMocks = vi.hoisted(() => ({
  getSettings: vi.fn(),
  saveSettings: vi.fn(),
  detectDepotDownloader: vi.fn(),
  getCustomThemes: vi.fn(),
  getThemesDirectory: vi.fn(),
}));

vi.mock('../services/api', () => ({
  ApiService: apiMocks,
}));

const baseSettings: Settings = {
  defaultDownloadDir: 'C:/Downloads',
  maxConcurrentDownloads: 2,
  platform: 'windows',
  language: 'en',
  theme: 'light',
};

const modernBlueSettings: Settings = {
  ...baseSettings,
  theme: 'modern-blue',
};

const darkSettings: Settings = {
  ...baseSettings,
  theme: 'dark',
};

const sunsetTheme: CustomThemeDefinition = {
  id: 'sunset',
  name: 'Sunset',
  baseTheme: 'dark',
  filePath: 'C:/SIMM/themes/sunset.json',
  variables: {
    '--app-bg-color': '#1b120f',
    '--primary-btn-color': '#d96b3a',
  },
};

const legacyCustomSettings: Settings = {
  ...({
    ...baseSettings,
    theme: 'custom',
    customTheme: { appBgColor: '#ffffff' },
  } as unknown as Settings),
};

function Consumer() {
  const { settings, loading, error, updateSettings } = useSettingsStore();
  return (
    <div>
      <div data-testid="loading">{String(loading)}</div>
      <div data-testid="theme">{settings?.theme ?? 'none'}</div>
      <div data-testid="error">{error ?? ''}</div>
      <button data-testid="update" onClick={() => updateSettings({ theme: 'dark' })}>
        Update
      </button>
    </div>
  );
}

describe('SettingsStore', () => {
  beforeEach(() => {
    apiMocks.getSettings.mockReset();
    apiMocks.saveSettings.mockReset();
    apiMocks.detectDepotDownloader.mockReset();
    apiMocks.getCustomThemes.mockReset();
    apiMocks.getThemesDirectory.mockReset();
    document.documentElement.removeAttribute('data-theme');
    document.documentElement.removeAttribute('data-custom-theme');
    document.documentElement.style.cssText = '';
    document.body.style.cssText = '';
    window.localStorage.removeItem(THEME_STORAGE_KEY);
    window.localStorage.removeItem(THEME_BASE_STORAGE_KEY);
    apiMocks.getCustomThemes.mockResolvedValue([]);
    apiMocks.getThemesDirectory.mockResolvedValue('C:/SIMM/themes');
  });

  afterEach(() => {
    cleanup();
  });

  it('loads settings and applies theme', async () => {
    apiMocks.getSettings.mockResolvedValueOnce(baseSettings);
    apiMocks.detectDepotDownloader.mockResolvedValueOnce({ installed: true });

    render(
      <SettingsStoreProvider>
        <Consumer />
      </SettingsStoreProvider>
    );

    await waitFor(() => {
      expect(screen.getByTestId('loading').textContent).toBe('false');
    });

    expect(screen.getByTestId('theme').textContent).toBe('light');
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    expect(document.documentElement.style.getPropertyValue('color-scheme')).toBe('light');
    expect(document.documentElement.style.getPropertyValue('--card-bg-color')).toBe('#ffffff');
    expect(document.documentElement.style.getPropertyValue('--primary-btn-color')).toBe('#3f74c9');
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('light');
    expect(window.localStorage.getItem(THEME_BASE_STORAGE_KEY)).toBe('light');
  });

  it('updates settings and theme without full refresh', async () => {
    apiMocks.getSettings.mockResolvedValueOnce(baseSettings);
    apiMocks.detectDepotDownloader.mockResolvedValueOnce({ installed: true });
    apiMocks.saveSettings.mockResolvedValueOnce({ success: true });

    render(
      <SettingsStoreProvider>
        <Consumer />
      </SettingsStoreProvider>
    );

    await waitFor(() => {
      expect(screen.getByTestId('loading').textContent).toBe('false');
    });

    fireEvent.click(screen.getByTestId('update'));

    await waitFor(() => {
      expect(screen.getByTestId('theme').textContent).toBe('dark');
    });

    expect(apiMocks.saveSettings).toHaveBeenCalledWith({ theme: 'dark' });
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');
    expect(window.localStorage.getItem(THEME_BASE_STORAGE_KEY)).toBe('dark');
  });

  it('merges nested app update settings without dropping existing fields', async () => {
    apiMocks.getSettings.mockResolvedValueOnce({
      ...baseSettings,
      appUpdate: {
        skippedVersionNormalized: '0.8.0',
        channel: 'stable',
      },
    });
    apiMocks.detectDepotDownloader.mockResolvedValueOnce({ installed: true });
    apiMocks.saveSettings.mockResolvedValueOnce({ success: true });

    function NestedConsumer() {
      const { settings, updateSettings } = useSettingsStore();
      return (
        <div>
          <div data-testid="update-channel">{settings?.appUpdate?.channel ?? 'none'}</div>
          <div data-testid="skipped-version">{settings?.appUpdate?.skippedVersionNormalized ?? 'none'}</div>
          <button
            data-testid="update-channel-button"
            onClick={() => updateSettings({ appUpdate: { channel: 'beta' } })}
          >
            Switch Channel
          </button>
        </div>
      );
    }

    render(
      <SettingsStoreProvider>
        <NestedConsumer />
      </SettingsStoreProvider>
    );

    await waitFor(() => {
      expect(screen.getByTestId('update-channel').textContent).toBe('stable');
    });

    fireEvent.click(screen.getByTestId('update-channel-button'));

    await waitFor(() => {
      expect(screen.getByTestId('update-channel').textContent).toBe('beta');
      expect(screen.getByTestId('skipped-version').textContent).toBe('0.8.0');
    });
  });

  it('surfaces load errors', async () => {
    apiMocks.getSettings.mockRejectedValueOnce(new Error('boom'));
    apiMocks.detectDepotDownloader.mockResolvedValueOnce({ installed: false });

    render(
      <SettingsStoreProvider>
        <Consumer />
      </SettingsStoreProvider>
    );

    await waitFor(() => {
      expect(screen.getByTestId('loading').textContent).toBe('false');
    });

    expect(screen.getByTestId('error').textContent).toBe('boom');
  });

  it('applies the current modern blue preset values', async () => {
    apiMocks.getSettings.mockResolvedValueOnce(modernBlueSettings);
    apiMocks.detectDepotDownloader.mockResolvedValueOnce({ installed: true });

    render(
      <SettingsStoreProvider>
        <Consumer />
      </SettingsStoreProvider>
    );

    await waitFor(() => {
      expect(screen.getByTestId('loading').textContent).toBe('false');
    });

    expect(screen.getByTestId('theme').textContent).toBe('modern-blue');
    expect(document.documentElement.style.getPropertyValue('--app-bg-color')).toBe('#0f141d');
    expect(document.documentElement.style.getPropertyValue('--card-bg-color')).toBe('#1a2433');
    expect(document.documentElement.style.getPropertyValue('--app-text-color-secondary')).toBe('#9aabc6');
    expect(document.documentElement.style.getPropertyValue('--theme-workspace-surface-card')).toBe('#1a2433');
    expect(document.documentElement.style.getPropertyValue('--theme-workspace-icon-surface')).toBe('#4e8ad9');
    expect(document.documentElement.style.getPropertyValue('--bg-gradient')).toContain('#0a0f17');
    expect(document.documentElement.style.getPropertyValue('--bg-pattern')).toContain('circle at 18% -10%');
  });

  it('applies the refined dark preset values', async () => {
    apiMocks.getSettings.mockResolvedValueOnce(darkSettings);
    apiMocks.detectDepotDownloader.mockResolvedValueOnce({ installed: true });

    render(
      <SettingsStoreProvider>
        <Consumer />
      </SettingsStoreProvider>
    );

    await waitFor(() => {
      expect(screen.getByTestId('loading').textContent).toBe('false');
    });

    expect(screen.getByTestId('theme').textContent).toBe('dark');
    expect(document.documentElement.style.getPropertyValue('--app-bg-color')).toBe('#11161d');
    expect(document.documentElement.style.getPropertyValue('--card-bg-color')).toBe('#1d2631');
    expect(document.documentElement.style.getPropertyValue('--badge-blue')).toBe('#5b83d2');
    expect(document.documentElement.style.getPropertyValue('--update-version-bg')).toBe('rgba(225, 164, 77, 0.16)');
  });

  it('applies custom theme files over their base theme', async () => {
    apiMocks.getSettings.mockResolvedValueOnce({ ...baseSettings, theme: 'sunset' });
    apiMocks.getCustomThemes.mockResolvedValueOnce([sunsetTheme]);
    apiMocks.detectDepotDownloader.mockResolvedValueOnce({ installed: true });

    render(
      <SettingsStoreProvider>
        <Consumer />
      </SettingsStoreProvider>
    );

    await waitFor(() => {
      expect(screen.getByTestId('loading').textContent).toBe('false');
    });

    expect(screen.getByTestId('theme').textContent).toBe('sunset');
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(document.documentElement.getAttribute('data-custom-theme')).toBe('sunset');
    expect(document.documentElement.style.getPropertyValue('--app-bg-color')).toBe('#1b120f');
    expect(document.documentElement.style.getPropertyValue('--primary-btn-color')).toBe('#d96b3a');
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('sunset');
    expect(window.localStorage.getItem(THEME_BASE_STORAGE_KEY)).toBe('dark');
  });

  it('falls back legacy custom themes to modern blue', async () => {
    apiMocks.getSettings.mockResolvedValueOnce(legacyCustomSettings);
    apiMocks.detectDepotDownloader.mockResolvedValueOnce({ installed: true });

    render(
      <SettingsStoreProvider>
        <Consumer />
      </SettingsStoreProvider>
    );

    await waitFor(() => {
      expect(screen.getByTestId('loading').textContent).toBe('false');
    });

    expect(screen.getByTestId('theme').textContent).toBe('modern-blue');
    expect(document.documentElement.getAttribute('data-theme')).toBe('modern-blue');
    expect(document.documentElement.style.getPropertyValue('--app-bg-color')).toBe('#0f141d');
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('modern-blue');
  });

  it('loads settings even when optional theme lookups fail', async () => {
    apiMocks.getSettings.mockResolvedValueOnce(baseSettings);
    apiMocks.getCustomThemes.mockRejectedValueOnce(new Error('theme failure'));
    apiMocks.getThemesDirectory.mockRejectedValueOnce(new Error('dir failure'));
    apiMocks.detectDepotDownloader.mockResolvedValueOnce({ installed: true });

    render(
      <SettingsStoreProvider>
        <Consumer />
      </SettingsStoreProvider>
    );

    await waitFor(() => {
      expect(screen.getByTestId('loading').textContent).toBe('false');
    });

    expect(screen.getByTestId('error').textContent).toBe('');
    expect(screen.getByTestId('theme').textContent).toBe('light');
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('light');
    expect(window.localStorage.getItem(THEME_BASE_STORAGE_KEY)).toBe('light');
    expect(screen.queryByText('theme failure')).toBeNull();
  });
});
