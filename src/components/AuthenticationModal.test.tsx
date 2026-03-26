import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

import { AuthenticationModal } from './AuthenticationModal';

const apiMocks = vi.hoisted(() => ({
  authenticate: vi.fn(),
  saveCredentials: vi.fn(),
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

describe('AuthenticationModal', () => {
  const updateSettings = vi.fn();

  beforeEach(() => {
    apiMocks.authenticate.mockReset();
    apiMocks.saveCredentials.mockReset();
    updateSettings.mockReset();
    settingsStoreMocks.useSettingsStore.mockReturnValue({
      updateSettings,
    });
  });

  afterEach(() => {
    cleanup();
  });

  it('submits credentials and preserves the existing authenticated payload', async () => {
    const onAuthenticated = vi.fn();
    apiMocks.authenticate.mockResolvedValue({ success: true });
    apiMocks.saveCredentials.mockResolvedValue(undefined);
    updateSettings.mockResolvedValue(undefined);

    render(
      <AuthenticationModal
        isOpen={true}
        onClose={() => {}}
        onAuthenticated={onAuthenticated}
        required={false}
      />
    );

    fireEvent.change(screen.getByLabelText('Steam Username'), { target: { value: 'steam-user' } });
    fireEvent.change(screen.getByLabelText('Steam Password'), { target: { value: 'secret-pass' } });
    fireEvent.change(screen.getByLabelText(/Steam Guard Code/), { target: { value: 'ABCDE' } });
    fireEvent.click(screen.getByRole('button', { name: 'Authenticate with Steam' }));

    await waitFor(() => {
      expect(apiMocks.authenticate).toHaveBeenCalledWith('steam-user', 'secret-pass', 'ABCDE', true);
    });

    expect(onAuthenticated).toHaveBeenCalledWith({
      username: 'steam-user',
      password: 'secret-pass',
      steamGuard: 'ABCDE',
      saveCredentials: true,
    });
  });

  it('renders the waiting approval state with the new copy', () => {
    render(
      <AuthenticationModal
        isOpen={true}
        onClose={() => {}}
        onAuthenticated={() => {}}
        required={true}
        waitingForAuth={true}
        authMessage="Approve this login in Steam Guard"
      />
    );

    expect(screen.getByText('Waiting for Steam Approval')).toBeTruthy();
    expect(screen.getByText('Approve the Steam login')).toBeTruthy();
    expect(screen.getByText('Approve this login in Steam Guard')).toBeTruthy();
  });
});
