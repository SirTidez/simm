import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

import { SteamAccountOverlay } from './SteamAccountOverlay';

const apiMocks = vi.hoisted(() => ({
  getNexusOAuthStatus: vi.fn(),
  beginNexusOAuthLogin: vi.fn(),
  completeNexusOAuthCallback: vi.fn(),
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

vi.mock('./AuthenticationModal', () => ({
  AuthenticationModal: (props: { isOpen: boolean; initialMode?: string }) => (
    props.isOpen ? <div data-testid="steam-auth-modal">{props.initialMode}</div> : null
  ),
}));

describe('SteamAccountOverlay', () => {
  const refreshSettings = vi.fn();

  beforeEach(() => {
    apiMocks.getNexusOAuthStatus.mockReset();
    apiMocks.beginNexusOAuthLogin.mockReset();
    apiMocks.completeNexusOAuthCallback.mockReset();
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
      redirectUri: 'http://localhost:8089/callback',
    });
    apiMocks.completeNexusOAuthCallback.mockResolvedValue({ success: false, pending: true });
  });

  afterEach(() => {
    cleanup();
  });

  it('starts the Nexus OAuth flow and shows the waiting state', async () => {
    render(<SteamAccountOverlay isOpen={true} onClose={() => {}} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Login with Nexus' }));

    await waitFor(() => {
      expect(apiMocks.beginNexusOAuthLogin).toHaveBeenCalledWith(true);
    });

    expect(screen.getByRole('button', { name: 'Waiting for Nexus authorization...' })).toBeTruthy();
  });

  it('completes a localhost Nexus callback while the account panel is waiting', async () => {
    apiMocks.completeNexusOAuthCallback.mockResolvedValue({
      success: true,
      status: { connected: true },
    });
    apiMocks.getNexusOAuthStatus
      .mockResolvedValueOnce({ connected: false })
      .mockResolvedValue({
        connected: true,
        account: { name: 'Test Nexus User', isPremium: true, canDirectDownload: true },
      });

    render(<SteamAccountOverlay isOpen={true} onClose={() => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Login with Nexus' }));

    await waitFor(() => {
      expect(apiMocks.completeNexusOAuthCallback).toHaveBeenCalledWith();
    }, { timeout: 2000 });
    expect(await screen.findByText('Test Nexus User')).toBeTruthy();
  });

  it('shows Steam QR login as the primary account action', async () => {
    render(<SteamAccountOverlay isOpen={true} onClose={() => {}} />);

    expect(await screen.findByRole('button', { name: 'Login with Steam QR' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Password Login' })).toBeTruthy();
  });

  it('shows Steam QR refresh for an already connected account', async () => {
    settingsStoreMocks.useSettingsStore.mockReturnValue({
      settings: { steamUsername: 'steam-user' },
      refreshSettings,
    });

    render(<SteamAccountOverlay isOpen={true} onClose={() => {}} />);

    expect(await screen.findByRole('button', { name: 'Refresh with QR Login' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Refresh Steam Access' })).toBeNull();
  });

  it('opens Steam auth modal in the selected login mode', async () => {
    render(<SteamAccountOverlay isOpen={true} onClose={() => {}} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Login with Steam QR' }));
    expect(screen.getByTestId('steam-auth-modal').textContent).toBe('qr');

    fireEvent.click(screen.getByRole('button', { name: 'Password Login' }));
    expect(screen.getByTestId('steam-auth-modal').textContent).toBe('password');
  });
});
