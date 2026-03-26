import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent, cleanup } from '@testing-library/react';
import { SettingsStoreProvider, useSettingsStore } from './settingsStore';
import type { Settings } from '../types';
import { THEME_STORAGE_KEY } from '../utils/theme';

const apiMocks = vi.hoisted(() => ({
  getSettings: vi.fn(),
  saveSettings: vi.fn(),
  detectDepotDownloader: vi.fn(),
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
    document.documentElement.removeAttribute('data-theme');
    window.localStorage.clear();
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
});
