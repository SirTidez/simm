import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { Footer } from './Footer';
import type { Environment } from '../types';

const envStoreMocks = vi.hoisted(() => ({
  useEnvironmentStore: vi.fn(),
}));

const settingsStoreMocks = vi.hoisted(() => ({
  useSettingsStore: vi.fn(),
}));

const apiMocks = vi.hoisted(() => ({
  getAllModUpdatesSummary: vi.fn(),
}));

const eventMocks = vi.hoisted(() => ({
  onModUpdatesChecked: vi.fn(),
  onModMetadataRefreshStatus: vi.fn(),
}));

const loggerMocks = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));

vi.mock('../stores/environmentStore', () => ({
  useEnvironmentStore: envStoreMocks.useEnvironmentStore,
}));

vi.mock('../stores/settingsStore', () => ({
  useSettingsStore: settingsStoreMocks.useSettingsStore,
}));

vi.mock('../services/api', () => ({
  ApiService: apiMocks,
}));

vi.mock('../services/events', () => ({
  onModUpdatesChecked: eventMocks.onModUpdatesChecked,
  onModMetadataRefreshStatus: eventMocks.onModMetadataRefreshStatus,
}));

vi.mock('../services/logger', () => ({
  logger: loggerMocks,
}));

vi.mock('./CustomThemeEditor', () => ({
  CustomThemeEditor: () => null,
}));

const completedEnv: Environment = {
  id: 'env-1',
  name: 'Env One',
  appId: '3164500',
  branch: 'main',
  outputDir: 'C:/env-1',
  runtime: 'IL2CPP',
  status: 'completed',
};

function mockStores(environments: Environment[]) {
  envStoreMocks.useEnvironmentStore.mockReturnValue({
    environments,
    checkAllUpdates: vi.fn().mockResolvedValue(undefined),
  });

  settingsStoreMocks.useSettingsStore.mockReturnValue({
    settings: { theme: 'dark' },
    updateSettings: vi.fn().mockResolvedValue(undefined),
  });
}

describe('Footer', () => {
  beforeEach(() => {
    envStoreMocks.useEnvironmentStore.mockReset();
    settingsStoreMocks.useSettingsStore.mockReset();
    apiMocks.getAllModUpdatesSummary.mockReset();
    eventMocks.onModUpdatesChecked.mockReset();
    eventMocks.onModMetadataRefreshStatus.mockReset();

    eventMocks.onModUpdatesChecked.mockResolvedValue(() => {});
    eventMocks.onModMetadataRefreshStatus.mockResolvedValue(() => {});
    apiMocks.getAllModUpdatesSummary.mockResolvedValue([]);
  });

  afterEach(() => {
    cleanup();
  });

  it('shows global mod updates count when updates exist', async () => {
    mockStores([completedEnv]);
    apiMocks.getAllModUpdatesSummary.mockResolvedValueOnce([
      {
        environmentId: 'env-1',
        environmentName: 'Env One',
        count: 2,
        updates: [],
      },
    ]);

    render(<Footer />);

    expect(await screen.findByText(/2\s+Mods need updating/i)).toBeTruthy();
  });

  it('shows all mods up to date when completed environments have no mod updates', async () => {
    mockStores([completedEnv]);
    apiMocks.getAllModUpdatesSummary.mockResolvedValueOnce([
      {
        environmentId: 'env-1',
        environmentName: 'Env One',
        count: 0,
        updates: [],
      },
    ]);

    render(<Footer />);

    await waitFor(() => {
      expect(screen.getByText(/Mods up to date/i)).toBeTruthy();
    });
  });

  it('does not render global mod status when there are no completed environments', async () => {
    mockStores([
      {
        ...completedEnv,
        id: 'env-2',
        status: 'downloading',
      },
    ]);

    render(<Footer />);

    await waitFor(() => {
      expect(screen.queryByText(/Mods up to date/i)).toBeNull();
      expect(screen.queryByText(/mod(s)? need updating/i)).toBeNull();
    });
  });
});
