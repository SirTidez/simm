import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

import { SteamAccountOverlay } from './SteamAccountOverlay';

const apiMocks = vi.hoisted(() => ({
  getNexusOAuthStatus: vi.fn(),
  beginNexusOAuthLogin: vi.fn(),
  logoutNexusOAuth: vi.fn(),
}));

const settingsStoreMocks = vi.hoisted(() => ({
  useSettingsStore: vi.fn(),
}));

vi.mock('../services/api', () => ({
  ApiService: apiMocks,
}));

vi.mock('../stores/settingsStore', () => ({
  useSettingsStore: settingsStoreMocks.useSettingsStore,
}));

describe('SteamAccountOverlay', () => {
  const refreshSettings = vi.fn();

  beforeEach(() => {
    apiMocks.getNexusOAuthStatus.mockReset();
    apiMocks.beginNexusOAuthLogin.mockReset();
    apiMocks.logoutNexusOAuth.mockReset();
    refreshSettings.mockReset();

    settingsStoreMocks.useSettingsStore.mockReturnValue({
      settings: { steamUsername: null },
      refreshSettings,
    });

    apiMocks.getNexusOAuthStatus.mockResolvedValue({ connected: false });
    apiMocks.beginNexusOAuthLogin.mockResolvedValue({
      authorizeUrl: 'https://nexusmods.com/oauth/start',
      state: 'state-123',
      redirectUri: 'simm://oauth',
    });
  });

  afterEach(() => {
    cleanup();
  });

  it('starts the Nexus OAuth flow and shows the waiting state', async () => {
    render(<SteamAccountOverlay isOpen={true} onClose={() => {}} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Login with Nexus' }));

    await waitFor(() => {
      expect(apiMocks.beginNexusOAuthLogin).toHaveBeenCalledWith(false);
    });

    expect(screen.getByRole('button', { name: 'Waiting for Nexus authorization...' })).toBeTruthy();
  });
});
