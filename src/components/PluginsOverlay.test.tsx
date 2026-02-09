import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { PluginsOverlay } from './PluginsOverlay';
import type { Environment } from '../types';

const apiMocks = vi.hoisted(() => ({
  getEnvironment: vi.fn(),
  getPlugins: vi.fn(),
}));

vi.mock('../services/api', () => ({
  ApiService: apiMocks,
}));

vi.mock('@tauri-apps/plugin-dialog', () => ({
  open: vi.fn(),
}));

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

    expect(await screen.findByText('MLVScan.dll')).toBeInTheDocument();
  });
});
