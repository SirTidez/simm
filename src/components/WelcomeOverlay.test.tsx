import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

import { WelcomeOverlay } from './WelcomeOverlay';

const apiMocks = vi.hoisted(() => ({
  getHomeDirectory: vi.fn(),
  openPath: vi.fn(),
  detectSteamInstallations: vi.fn(),
  getSecurityScannerStatus: vi.fn(),
  installSecurityScanner: vi.fn(),
}));

vi.mock('../services/api', () => ({
  ApiService: apiMocks,
}));

describe('WelcomeOverlay', () => {
  beforeEach(() => {
    apiMocks.getHomeDirectory.mockReset();
    apiMocks.openPath.mockReset();
    apiMocks.getHomeDirectory.mockResolvedValue('C:\\Users\\Tester');
    apiMocks.openPath.mockResolvedValue(undefined);
    apiMocks.detectSteamInstallations.mockReset();
    apiMocks.detectSteamInstallations.mockResolvedValue([]);
    apiMocks.getSecurityScannerStatus.mockReset();
    apiMocks.getSecurityScannerStatus.mockResolvedValue({
      enabled: true,
      autoInstall: true,
      installed: true,
      installMethod: 'managed',
      installedVersion: '1.0.0',
      latestVersion: '1.0.0',
    });
    apiMocks.installSecurityScanner.mockReset();
    apiMocks.installSecurityScanner.mockResolvedValue({
      enabled: true,
      autoInstall: true,
      installed: true,
      installMethod: 'managed',
      installedVersion: '1.0.0',
      latestVersion: '1.0.0',
    });
  });

  afterEach(() => {
    cleanup();
  });

  it('renders setup, opens the folder action, and saves Player mode', async () => {
    const onClose = vi.fn();
    const onOpenWizard = vi.fn();
    const onOpenSettings = vi.fn();
    const onFinishSetup = vi.fn().mockResolvedValue(undefined);

    render(
      <WelcomeOverlay
        isOpen={true}
        onClose={onClose}
        onOpenWizard={onOpenWizard}
        onOpenSettings={onOpenSettings}
        onFinishSetup={onFinishSetup}
      />
    );

    expect(await screen.findByText('Choose the layout that fits you')).toBeTruthy();
    expect(await screen.findByText('C:\\Users\\Tester\\SIMM')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /^continue$/i }));
    expect(await screen.findByText('Point SIMM at your game')).toBeTruthy();

    fireEvent.click(screen.getAllByRole('button', { name: 'Open SIMM Folder' })[0]);

    await waitFor(() => {
      expect(apiMocks.openPath).toHaveBeenCalledWith('C:\\Users\\Tester\\SIMM');
    });

    fireEvent.click(screen.getByRole('button', { name: /^continue$/i }));
    expect(await screen.findByText('Keep installs safer by default')).toBeTruthy();

    await waitFor(() => {
      expect(apiMocks.getSecurityScannerStatus).toHaveBeenCalledTimes(1);
    });

    fireEvent.click(screen.getByRole('button', { name: /finish setup/i }));
    await waitFor(() => {
      expect(onFinishSetup).toHaveBeenCalledWith('player');
    });
    expect(onClose).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
  });

  it('prompts Power Users to open Accounts for Steam sign-in during setup', async () => {
    const onClose = vi.fn();
    const onOpenAccounts = vi.fn();
    const onFinishSetup = vi.fn().mockResolvedValue(undefined);

    render(
      <WelcomeOverlay
        isOpen={true}
        onClose={onClose}
        onOpenWizard={() => {}}
        onOpenSettings={() => {}}
        onOpenAccounts={onOpenAccounts}
        onFinishSetup={onFinishSetup}
      />
    );

    fireEvent.click(await screen.findByRole('button', { name: /branch and tooling workflows/i }));
    expect(screen.getByText('Open Accounts')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /^continue$/i }));
    expect(await screen.findByText('Point SIMM at your game')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Open Accounts After Setup' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /^continue$/i }));
    expect(await screen.findByText('Sign in to Steam for advanced downloads')).toBeTruthy();
    await waitFor(() => {
      expect(apiMocks.getSecurityScannerStatus).toHaveBeenCalledTimes(1);
    });

    fireEvent.click(screen.getByRole('button', { name: /finish setup/i }));
    await waitFor(() => {
      expect(onFinishSetup).toHaveBeenCalledWith('powerUser');
    });
    expect(onOpenAccounts).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('installs MLVScan automatically during the setup guide safety step', async () => {
    apiMocks.getSecurityScannerStatus.mockResolvedValueOnce({
      enabled: true,
      autoInstall: true,
      installed: false,
    });

    render(
      <WelcomeOverlay
        isOpen={true}
        onClose={() => {}}
        onOpenWizard={() => {}}
        onOpenSettings={() => {}}
        onFinishSetup={vi.fn().mockResolvedValue(undefined)}
      />
    );

    fireEvent.click(await screen.findByRole('button', { name: /^continue$/i }));
    fireEvent.click(await screen.findByRole('button', { name: /^continue$/i }));

    expect(await screen.findByText(/Preparing MLVScan|MLVScan ready/i)).toBeTruthy();

    await waitFor(() => {
      expect(apiMocks.installSecurityScanner).toHaveBeenCalledTimes(1);
    });
  });

  it('falls back gracefully when the home directory lookup fails', async () => {
    apiMocks.getHomeDirectory.mockRejectedValue(new Error('lookup failed'));

    render(
      <WelcomeOverlay
        isOpen={true}
        onClose={() => {}}
        onOpenWizard={() => {}}
        onOpenSettings={() => {}}
      />
    );

    expect(await screen.findByText('your home directory\\SIMM')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /^continue$/i }));
    expect(await screen.findByText('Point SIMM at your game')).toBeTruthy();
    expect((screen.getAllByRole('button', { name: 'Open SIMM Folder' })[0] as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/Folder lookup is unavailable right now/i)).toBeTruthy();
  });

  it('lets upgraded users keep the current layout', async () => {
    const onSkipSetup = vi.fn().mockResolvedValue(undefined);
    const onClose = vi.fn();

    render(
      <WelcomeOverlay
        isOpen={true}
        onClose={onClose}
        onOpenWizard={() => {}}
        onOpenSettings={() => {}}
        mode="upgradePrompt"
        initialExperienceMode="powerUser"
        onSkipSetup={onSkipSetup}
      />
    );

    expect(await screen.findByText('Make SIMM easier to use')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /keep current layout/i }));

    await waitFor(() => {
      expect(onSkipSetup).toHaveBeenCalledTimes(1);
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
