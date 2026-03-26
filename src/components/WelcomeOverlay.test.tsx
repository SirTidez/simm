import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

import { WelcomeOverlay } from './WelcomeOverlay';

const apiMocks = vi.hoisted(() => ({
  getHomeDirectory: vi.fn(),
  openPath: vi.fn(),
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
  });

  afterEach(() => {
    cleanup();
  });

  it('renders the resolved SIMM path and opens the folder action', async () => {
    const onClose = vi.fn();
    const onOpenWizard = vi.fn();
    const onOpenSettings = vi.fn();

    render(
      <WelcomeOverlay
        isOpen={true}
        onClose={onClose}
        onOpenWizard={onOpenWizard}
        onOpenSettings={onOpenSettings}
      />
    );

    expect(await screen.findByText('Welcome to Schedule I Mod Manager')).toBeTruthy();
    expect(screen.getByText('C:\\Users\\Tester\\SIMM')).toBeTruthy();

    fireEvent.click(screen.getAllByRole('button', { name: 'Open SIMM Folder' })[0]);

    await waitFor(() => {
      expect(apiMocks.openPath).toHaveBeenCalledWith('C:\\Users\\Tester\\SIMM');
    });

    fireEvent.click(screen.getByRole('button', { name: 'Create Environment' }));
    expect(onOpenWizard).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: 'Open Settings' }));
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
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
    expect((screen.getAllByRole('button', { name: 'Open SIMM Folder' })[0] as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/Folder lookup is unavailable right now/i)).toBeTruthy();
  });
});
