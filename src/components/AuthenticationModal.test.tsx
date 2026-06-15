import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

import { AuthenticationModal } from './AuthenticationModal';

const apiMocks = vi.hoisted(() => ({
  authenticate: vi.fn(),
  authenticateQr: vi.fn(),
  saveCredentials: vi.fn(),
}));

const eventMocks = vi.hoisted(() => ({
  onSteamAuthQrLine: vi.fn(),
}));

const settingsStoreMocks = vi.hoisted(() => ({
  useSettingsStore: vi.fn(),
}));

vi.mock('../services/api', () => ({
  ApiService: apiMocks,
}));

vi.mock('../services/events', () => ({
  onSteamAuthQrLine: eventMocks.onSteamAuthQrLine,
}));

vi.mock('../stores/settingsStore', () => ({
  useSettingsStore: settingsStoreMocks.useSettingsStore,
}));

describe('AuthenticationModal', () => {
  const updateSettings = vi.fn();

  beforeEach(() => {
    apiMocks.authenticate.mockReset();
    apiMocks.authenticateQr.mockReset();
    apiMocks.saveCredentials.mockReset();
    eventMocks.onSteamAuthQrLine.mockReset();
    eventMocks.onSteamAuthQrLine.mockResolvedValue(vi.fn());
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

    fireEvent.click(screen.getByRole('tab', { name: /Password/ }));
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

  it('omits a blank Steam Guard code for password auth', async () => {
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

    fireEvent.click(screen.getByRole('tab', { name: /Password/ }));
    fireEvent.change(screen.getByLabelText('Steam Username'), { target: { value: 'steam-user' } });
    fireEvent.change(screen.getByLabelText('Steam Password'), { target: { value: 'secret-pass' } });
    fireEvent.change(screen.getByLabelText(/Steam Guard Code/), { target: { value: '   ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Authenticate with Steam' }));

    await waitFor(() => {
      expect(apiMocks.authenticate).toHaveBeenCalledWith('steam-user', 'secret-pass', undefined, true);
    });
  });

  it('submits QR auth and stores only the returned account name', async () => {
    const onAuthenticated = vi.fn();
    apiMocks.authenticateQr.mockResolvedValue({ success: true, username: 'qr-user' });
    updateSettings.mockResolvedValue(undefined);

    render(
      <AuthenticationModal
        isOpen={true}
        onClose={() => {}}
        onAuthenticated={onAuthenticated}
        required={false}
      />
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Start QR Login' }));

    await waitFor(() => {
      expect(apiMocks.authenticateQr).toHaveBeenCalledWith(true);
    });

    expect(apiMocks.saveCredentials).not.toHaveBeenCalled();
    expect(updateSettings).toHaveBeenCalledWith({ steamUsername: 'qr-user' });
    expect(onAuthenticated).toHaveBeenCalledWith({
      username: 'qr-user',
      password: '',
      steamGuard: '',
      saveCredentials: true,
    });
  });

  it('renders only QR rows from the DepotDownloader QR stream', async () => {
    let qrLineHandler: ((data: { line: string }) => void) | null = null;
    eventMocks.onSteamAuthQrLine.mockImplementation(async (handler) => {
      qrLineHandler = handler;
      return vi.fn();
    });

    render(
      <AuthenticationModal
        isOpen={true}
        onClose={() => {}}
        onAuthenticated={() => {}}
        required={false}
      />
    );

    await waitFor(() => expect(qrLineHandler).not.toBeNull());

    act(() => {
      qrLineHandler?.({ line: 'Use the Steam Mobile App to sign in via QR code:' });
      qrLineHandler?.({ line: '' });
      qrLineHandler?.({ line: '      \u2588\u2588\u2588\u2588 QR ROW 1 \u2588\u2588\u2588\u2588    ' });
      qrLineHandler?.({ line: '        \u2588\u2588 QR ROW 2 \u2588\u2588\u2588\u2588    ' });
    });

    const output = screen.getByTestId('steam-auth-qr-output');
    expect(output.textContent).not.toContain('Use the Steam Mobile App');
    expect(output.textContent?.startsWith('\u2588\u2588\u2588\u2588 QR ROW 1 \u2588\u2588\u2588\u2588')).toBe(true);
    expect(output.textContent).toContain('  \u2588\u2588 QR ROW 2 \u2588\u2588\u2588\u2588');
    expect(output.textContent).not.toContain('    \n');
  });

  it('waits for the QR event listener before starting QR auth', async () => {
    let resolveListener: ((cleanup: () => void) => void) | null = null;
    eventMocks.onSteamAuthQrLine.mockImplementation(() => new Promise((resolve) => {
      resolveListener = resolve;
    }));

    render(
      <AuthenticationModal
        isOpen={true}
        onClose={() => {}}
        onAuthenticated={() => {}}
        required={false}
      />
    );

    expect(screen.getByRole('button', { name: 'Preparing QR Login' })).toBeDisabled();

    act(() => {
      resolveListener?.(vi.fn());
    });

    expect(await screen.findByRole('button', { name: 'Start QR Login' })).not.toBeDisabled();
  });

  it('uses the compact QR output sizing on Windows', async () => {
    const userAgentSpy = vi.spyOn(window.navigator, 'userAgent', 'get')
      .mockReturnValue('Mozilla/5.0 (Windows NT 10.0; Win64; x64)');

    render(
      <AuthenticationModal
        isOpen={true}
        onClose={() => {}}
        onAuthenticated={() => {}}
        required={false}
      />
    );

    await screen.findByRole('button', { name: 'Start QR Login' });
    expect(screen.getByTestId('steam-auth-qr-output').className).toContain('auth-modal__qr-output--windows');

    userAgentSpy.mockRestore();
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

  it('shows backend auth errors from the command contract', async () => {
    apiMocks.authenticate.mockResolvedValue({
      success: false,
      error: 'Authentication failed: Branch main not found',
    });

    render(
      <AuthenticationModal
        isOpen={true}
        onClose={() => {}}
        onAuthenticated={() => {}}
        required={false}
      />
    );

    fireEvent.click(screen.getByRole('tab', { name: /Password/ }));
    fireEvent.change(screen.getByLabelText('Steam Username'), { target: { value: 'steam-user' } });
    fireEvent.change(screen.getByLabelText('Steam Password'), { target: { value: 'secret-pass' } });
    fireEvent.click(screen.getByRole('button', { name: 'Authenticate with Steam' }));

    expect(
      await screen.findByText('Authentication failed: Branch main not found')
    ).toBeTruthy();
  });
});
