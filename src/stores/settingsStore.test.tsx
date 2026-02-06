import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent, cleanup } from '@testing-library/react';
import { SettingsStoreProvider, useSettingsStore } from './settingsStore';
import type { Settings } from '../types';

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
});
