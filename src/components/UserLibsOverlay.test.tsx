import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { open } from '@tauri-apps/plugin-dialog';

import { UserLibsOverlay } from './UserLibsOverlay';
import type { Environment } from '../types';

const apiMocks = vi.hoisted(() => ({
  getEnvironment: vi.fn(),
  getUserLibs: vi.fn(),
  uploadUserLib: vi.fn(),
  deleteUserLib: vi.fn(),
  openUserLibsFolder: vi.fn(),
  enableUserLib: vi.fn(),
  disableUserLib: vi.fn(),
}));

vi.mock('../services/api', () => ({
  ApiService: apiMocks,
}));

vi.mock('@tauri-apps/plugin-dialog', () => ({
  open: vi.fn(),
}));

const openMock = vi.mocked(open);

const baseEnvironment: Environment = {
  id: 'env-1',
  name: 'Test Env',
  appId: '3164500',
  branch: 'main',
  outputDir: 'C:/env',
  runtime: 'Mono',
  status: 'completed',
};

describe('UserLibsOverlay', () => {
  beforeEach(() => {
    apiMocks.getEnvironment.mockReset();
    apiMocks.getUserLibs.mockReset();
    apiMocks.uploadUserLib.mockReset();
    apiMocks.deleteUserLib.mockReset();
    apiMocks.openUserLibsFolder.mockReset();
    apiMocks.enableUserLib.mockReset();
    apiMocks.disableUserLib.mockReset();
    openMock.mockReset();

    apiMocks.getEnvironment.mockResolvedValue(baseEnvironment);
    apiMocks.getUserLibs.mockResolvedValue({
      userLibs: [
        {
          name: 'HarmonyX',
          fileName: 'HarmonyX.dll',
          path: 'C:/env/UserLibs/HarmonyX.dll',
          size: 2048,
          isDirectory: false,
          disabled: false,
        },
        {
          name: 'SharedAssets',
          fileName: 'SharedAssets',
          path: 'C:/env/UserLibs/SharedAssets.disabled',
          isDirectory: true,
          disabled: true,
        },
      ],
      userLibsDirectory: 'C:/env/UserLibs',
      count: 2,
    });
    apiMocks.uploadUserLib.mockResolvedValue({ success: true });
    apiMocks.deleteUserLib.mockResolvedValue({ success: true });
    apiMocks.openUserLibsFolder.mockResolvedValue({ success: true });
    apiMocks.enableUserLib.mockResolvedValue({ success: true });
    apiMocks.disableUserLib.mockResolvedValue({ success: true });
  });

  afterEach(() => {
    cleanup();
  });

  it('auto-selects the first user library and renders inspector details', async () => {
    render(
      <UserLibsOverlay
        isOpen={true}
        onClose={() => {}}
        environmentId="env-1"
      />
    );

    expect((await screen.findAllByText('HarmonyX.dll')).length).toBeGreaterThan(0);
    expect(await screen.findByText('C:/env/UserLibs/HarmonyX.dll')).toBeTruthy();
  });

  it('filters user libraries from the toolbar search', async () => {
    render(
      <UserLibsOverlay
        isOpen={true}
        onClose={() => {}}
        environmentId="env-1"
      />
    );

    fireEvent.change(await screen.findByPlaceholderText('Search user libraries'), {
      target: { value: 'shared' },
    });

    await waitFor(() => {
      expect(screen.queryAllByText('HarmonyX.dll')).toHaveLength(0);
      expect(screen.getAllByText('SharedAssets').length).toBeGreaterThan(0);
    });
  });

  it('toggles user library state from the inspector', async () => {
    const onUserLibsChanged = vi.fn();

    render(
      <UserLibsOverlay
        isOpen={true}
        onClose={() => {}}
        environmentId="env-1"
        onUserLibsChanged={onUserLibsChanged}
      />
    );

    fireEvent.click((await screen.findAllByText('SharedAssets'))[0]);
    fireEvent.click(screen.getByRole('button', { name: 'Enable' }));

    await waitFor(() => {
      expect(apiMocks.enableUserLib).toHaveBeenCalledWith('env-1', 'C:/env/UserLibs/SharedAssets.disabled');
      expect(onUserLibsChanged).toHaveBeenCalled();
    });
  });

  it('uploads UserLib and notifies parent on success', async () => {
    const onUserLibsChanged = vi.fn();
    openMock.mockResolvedValueOnce('C:/userlibs/NewSharedLib.dll');

    render(
      <UserLibsOverlay
        isOpen={true}
        onClose={() => {}}
        environmentId="env-1"
        onUserLibsChanged={onUserLibsChanged}
      />
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Add UserLib' }));

    await waitFor(() => {
      expect(apiMocks.uploadUserLib).toHaveBeenCalledWith(
        'env-1',
        'C:/userlibs/NewSharedLib.dll',
        'NewSharedLib.dll',
        'Mono'
      );
    });

    await waitFor(() => {
      expect(onUserLibsChanged).toHaveBeenCalled();
    });
  });

  it('deletes UserLib after confirmation and notifies parent', async () => {
    const onUserLibsChanged = vi.fn();

    render(
      <UserLibsOverlay
        isOpen={true}
        onClose={() => {}}
        environmentId="env-1"
        onUserLibsChanged={onUserLibsChanged}
      />
    );

    fireEvent.click((await screen.findAllByText('HarmonyX.dll'))[0]);
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Delete UserLib' }));

    await waitFor(() => {
      expect(apiMocks.deleteUserLib).toHaveBeenCalledWith('env-1', 'C:/env/UserLibs/HarmonyX.dll');
      expect(onUserLibsChanged).toHaveBeenCalled();
    });
  });
});
