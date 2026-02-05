import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent, cleanup } from '@testing-library/react';
import { EnvironmentStoreProvider, useEnvironmentStore } from './environmentStore';
import type { Environment, DownloadProgress } from '../types';

const apiMocks = vi.hoisted(() => ({
  getEnvironments: vi.fn(),
  updateEnvironment: vi.fn(),
  createEnvironment: vi.fn(),
  deleteEnvironment: vi.fn(),
  startDownload: vi.fn(),
  cancelDownload: vi.fn(),
  checkUpdate: vi.fn(),
  checkAllUpdates: vi.fn(),
  extractGameVersion: vi.fn(),
}));

const eventMocks = vi.hoisted(() => ({
  onProgress: vi.fn(),
  onComplete: vi.fn(),
  onError: vi.fn(),
  onUpdateAvailable: vi.fn(),
  onUpdateCheckComplete: vi.fn(),
}));

vi.mock('../services/api', () => ({
  ApiService: apiMocks,
}));

vi.mock('../services/events', () => eventMocks);

const baseEnv: Environment = {
  id: 'env-1',
  name: 'Env',
  appId: '3164500',
  branch: 'main',
  outputDir: 'C:/env',
  runtime: 'IL2CPP',
  status: 'completed',
};

function Consumer() {
  const { environments, loading, progress, startDownload, checkAllUpdates } = useEnvironmentStore();
  return (
    <div>
      <div data-testid="loading">{String(loading)}</div>
      <div data-testid="env-status">{environments[0]?.status ?? 'none'}</div>
      <div data-testid="env-version">{environments[0]?.currentGameVersion ?? 'none'}</div>
      <div data-testid="update-available">{String(environments[0]?.updateAvailable ?? false)}</div>
      <div data-testid="progress-count">{progress.size}</div>
      <button
        data-testid="start-download"
        onClick={() => environments[0] && startDownload(environments[0].id)}
      >
        Start
      </button>
      <button data-testid="check-all" onClick={() => checkAllUpdates(true)}>
        CheckAll
      </button>
    </div>
  );
}

describe('EnvironmentStore', () => {
  let progressHandler: ((data: DownloadProgress) => void) | null = null;
  let completeHandler: ((data: { downloadId: string; manifestId?: string }) => void) | null = null;

  beforeEach(() => {
    apiMocks.getEnvironments.mockReset();
    apiMocks.updateEnvironment.mockReset();
    apiMocks.createEnvironment.mockReset();
    apiMocks.deleteEnvironment.mockReset();
    apiMocks.startDownload.mockReset();
    apiMocks.cancelDownload.mockReset();
    apiMocks.checkUpdate.mockReset();
    apiMocks.checkAllUpdates.mockReset();
    apiMocks.extractGameVersion.mockReset();

    eventMocks.onProgress.mockReset();
    eventMocks.onComplete.mockReset();
    eventMocks.onError.mockReset();
    eventMocks.onUpdateAvailable.mockReset();
    eventMocks.onUpdateCheckComplete.mockReset();

    progressHandler = null;
    completeHandler = null;

    eventMocks.onProgress.mockImplementation(async (handler: (data: DownloadProgress) => void) => {
      progressHandler = handler;
      return () => {};
    });
    eventMocks.onComplete.mockImplementation(async (handler: (data: { downloadId: string; manifestId?: string }) => void) => {
      completeHandler = handler;
      return () => {};
    });
    eventMocks.onError.mockResolvedValue(() => {});
    eventMocks.onUpdateAvailable.mockResolvedValue(() => {});
    eventMocks.onUpdateCheckComplete.mockResolvedValue(() => {});
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('loads environments and clears loading state', async () => {
    apiMocks.getEnvironments.mockResolvedValueOnce([
      { ...baseEnv, currentGameVersion: '1.0.0' },
    ]);

    render(
      <EnvironmentStoreProvider>
        <Consumer />
      </EnvironmentStoreProvider>
    );

    await waitFor(() => {
      expect(screen.getByTestId('loading').textContent).toBe('false');
    });

    expect(screen.getByTestId('env-status').textContent).toBe('completed');
    expect(screen.getByTestId('env-version').textContent).toBe('1.0.0');
  });

  it('updates progress map and status from progress events', async () => {
    apiMocks.getEnvironments.mockResolvedValueOnce([baseEnv]);
    apiMocks.updateEnvironment.mockImplementation(async (id: string, updates: Partial<Environment>) => ({
      ...baseEnv,
      id,
      ...updates,
    }));

    render(
      <EnvironmentStoreProvider>
        <Consumer />
      </EnvironmentStoreProvider>
    );

    await waitFor(() => {
      expect(screen.getByTestId('loading').textContent).toBe('false');
    });

    progressHandler?.({
      downloadId: 'env-1',
      status: 'completed',
      progress: 100,
    });

    await waitFor(() => {
      expect(screen.getByTestId('env-status').textContent).toBe('completed');
      expect(screen.getByTestId('progress-count').textContent).toBe('1');
    });

    expect(apiMocks.updateEnvironment).toHaveBeenCalledWith('env-1', { status: 'completed' });
  });

  it('handles completion events and clears progress', async () => {
    apiMocks.getEnvironments.mockResolvedValueOnce([baseEnv]);
    apiMocks.updateEnvironment.mockImplementation(async (id: string, updates: Partial<Environment>) => ({
      ...baseEnv,
      id,
      ...updates,
    }));
    apiMocks.extractGameVersion.mockResolvedValueOnce('2.0.0');

    render(
      <EnvironmentStoreProvider>
        <Consumer />
      </EnvironmentStoreProvider>
    );

    await waitFor(() => {
      expect(screen.getByTestId('loading').textContent).toBe('false');
    });

    progressHandler?.({
      downloadId: 'env-1',
      status: 'downloading',
      progress: 10,
    });

    completeHandler?.({ downloadId: 'env-1', manifestId: '123' });

    await waitFor(() => {
      expect(screen.getByTestId('progress-count').textContent).toBe('0');
      expect(screen.getByTestId('env-version').textContent).toBe('2.0.0');
    });

    expect(apiMocks.updateEnvironment).toHaveBeenCalledWith(
      'env-1',
      expect.objectContaining({
        status: 'completed',
        lastManifestId: '123',
      })
    );
  });

  it('checkAllUpdates updates environments in place', async () => {
    apiMocks.getEnvironments.mockResolvedValueOnce([baseEnv]);
    apiMocks.checkAllUpdates.mockResolvedValueOnce([
      {
        environmentId: 'env-1',
        updateAvailable: true,
        remoteManifestId: '456',
        branch: 'main',
        appId: '3164500',
        checkedAt: 'now',
      },
    ]);

    render(
      <EnvironmentStoreProvider>
        <Consumer />
      </EnvironmentStoreProvider>
    );

    await waitFor(() => {
      expect(screen.getByTestId('loading').textContent).toBe('false');
    });

    fireEvent.click(screen.getByTestId('check-all'));

    await waitFor(() => {
      expect(screen.getByTestId('update-available').textContent).toBe('true');
    });
  });
});
