import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { PluginsOverlay } from './PluginsOverlay';
import type { Environment } from '../types';
import { open } from '@tauri-apps/plugin-dialog';

const apiMocks = vi.hoisted(() => ({
  getEnvironment: vi.fn(),
  getPlugins: vi.fn(),
  uploadPlugin: vi.fn(),
  deletePlugin: vi.fn(),
  openPluginsFolder: vi.fn(),
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
  runtime: 'IL2CPP',
  status: 'completed',
};

describe('PluginsOverlay', () => {
  beforeEach(() => {
    apiMocks.getEnvironment.mockReset();
    apiMocks.getPlugins.mockReset();
    apiMocks.uploadPlugin.mockReset();
    apiMocks.deletePlugin.mockReset();
    apiMocks.openPluginsFolder.mockReset();
    openMock.mockReset();

    apiMocks.getEnvironment.mockResolvedValue(baseEnvironment);
    apiMocks.getPlugins.mockResolvedValue({
      plugins: [
        {
          name: 'MLVScan',
          fileName: 'MLVScan.dll',
          path: 'C:/env/Plugins/MLVScan.dll',
          source: 'local',
        },
      ],
      pluginsDirectory: 'C:/env/Plugins',
      count: 1,
    });
    apiMocks.uploadPlugin.mockResolvedValue({ success: true });
    apiMocks.deletePlugin.mockResolvedValue({ success: true });
    apiMocks.openPluginsFolder.mockResolvedValue({ success: true });
  });

  afterEach(() => {
    cleanup();
  });

  it('displays MLVScan.dll in the plugins list', async () => {
    render(
      <PluginsOverlay
        isOpen={true}
        onClose={() => {}}
        environmentId="env-1"
      />
    );

    expect(await screen.findByText('MLVScan.dll')).toBeTruthy();
  });

  it('uploads plugin and notifies parent on success', async () => {
    const onPluginsChanged = vi.fn();
    openMock.mockResolvedValueOnce('C:/plugins/NewPlugin.dll');

    render(
      <PluginsOverlay
        isOpen={true}
        onClose={() => {}}
        environmentId="env-1"
        onPluginsChanged={onPluginsChanged}
      />
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Add Plugin' }));

    await waitFor(() => {
      expect(apiMocks.uploadPlugin).toHaveBeenCalledWith(
        'env-1',
        'C:/plugins/NewPlugin.dll',
        'NewPlugin.dll',
        'IL2CPP'
      );
    });

    await waitFor(() => {
      expect(onPluginsChanged).toHaveBeenCalled();
    });
  });

  it('shows runtime mismatch confirmation and continues', async () => {
    const onPluginsChanged = vi.fn();
    openMock.mockResolvedValueOnce('C:/plugins/MismatchPlugin.dll');
    apiMocks.uploadPlugin.mockResolvedValueOnce({
      success: true,
      runtimeMismatch: {
        detected: 'Mono',
        environment: 'IL2CPP',
        warning: 'Runtime mismatch',
        requiresConfirmation: true,
      },
    });

    render(
      <PluginsOverlay
        isOpen={true}
        onClose={() => {}}
        environmentId="env-1"
        onPluginsChanged={onPluginsChanged}
      />
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Add Plugin' }));
    expect(await screen.findByText('Runtime Mismatch Warning')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Continue Anyway' }));

    await waitFor(() => {
      expect(onPluginsChanged).toHaveBeenCalled();
    });
  });
});
