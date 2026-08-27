import React from 'react';
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
  createAsyncListenerScope: () => {
    let active = true;
    const unlisteners = new Set<() => void>();
    return {
      register: (subscribe: () => Promise<() => void>) => {
        void subscribe().then((unlisten) => {
          if (active) unlisteners.add(unlisten);
          else unlisten();
        });
      },
      dispose: () => {
        active = false;
        unlisteners.forEach((unlisten) => unlisten());
        unlisteners.clear();
      },
      isActive: () => active,
    };
  },
  onProgress: vi.fn(),
  onComplete: vi.fn(),
  onError: vi.fn(),
  onUpdateAvailable: vi.fn(),
  onUpdateCheckComplete: vi.fn(),
  onRuntimeSwitch: vi.fn(),
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
  updateAvailable: true,
  remoteManifestId: '122',
};

function Consumer() {
  const { environments, loading, progress, startDownload, cancelDownload, checkAllUpdates, ensureEnvironments, createEnvironment, deleteEnvironment } = useEnvironmentStore();
  const [cachedRuntime, setCachedRuntime] = React.useState('none');
  return (
    <div>
      <div data-testid="loading">{String(loading)}</div>
      <div data-testid="env-status">{environments[0]?.status ?? 'none'}</div>
      <div data-testid="env-version">{environments[0]?.currentGameVersion ?? 'none'}</div>
      <div data-testid="env-branch">{environments[0]?.branch ?? 'none'}</div>
      <div data-testid="env-runtime">{environments[0]?.runtime ?? 'none'}</div>
      <div data-testid="update-available">{String(environments[0]?.updateAvailable ?? false)}</div>
      <div data-testid="progress-count">{progress.size}</div>
      <div data-testid="cached-runtime">{cachedRuntime}</div>
      <button
        data-testid="start-download"
        onClick={() => environments[0] && startDownload(environments[0].id)}
      >
        Start
      </button>
      <button
        data-testid="start-download-one-time"
        onClick={() => environments[0] && startDownload(environments[0].id, {
          username: 'steam-user',
          password: 'one-time-password',
          steamGuard: '12345',
          saveCredentials: false,
        })}
      >
        Start one-time
      </button>
      <button
        data-testid="cancel-download"
        onClick={() => environments[0] && void cancelDownload(environments[0].id)}
      >
        Cancel
      </button>
      <button data-testid="check-all" onClick={() => checkAllUpdates(true)}>
        CheckAll
      </button>
      <button
        data-testid="ensure-environments"
        onClick={() => void ensureEnvironments().then((snapshot) => {
          setCachedRuntime(snapshot[0]?.runtime ?? 'none');
        })}
      >
        Ensure environments
      </button>
      <button
        data-testid="create-environment"
        onClick={() => void createEnvironment({ appId: '3164500', branch: 'main', outputDir: 'C:/env' })}
      >
        Create environment
      </button>
      <button
        data-testid="delete-environment"
        onClick={() => void deleteEnvironment('env-1')}
      >
        Delete environment
      </button>
    </div>
  );
}

describe('EnvironmentStore', () => {
  let progressHandler: ((data: DownloadProgress) => void) | null = null;
  let completeHandler: ((data: { downloadId: string; manifestId?: string }) => void) | null = null;
  let runtimeSwitchHandler: ((data: import('../types').RuntimeSwitchResult) => void) | null = null;

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
    apiMocks.extractGameVersion.mockResolvedValue({ version: null });

    eventMocks.onProgress.mockReset();
    eventMocks.onComplete.mockReset();
    eventMocks.onError.mockReset();
    eventMocks.onUpdateAvailable.mockReset();
    eventMocks.onUpdateCheckComplete.mockReset();
    eventMocks.onRuntimeSwitch.mockReset();

    progressHandler = null;
    completeHandler = null;
    runtimeSwitchHandler = null;

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
    eventMocks.onRuntimeSwitch.mockImplementation(async (handler: (data: import('../types').RuntimeSwitchResult) => void) => {
      runtimeSwitchHandler = handler;
      return () => {};
    });
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

  it('passes one-time credentials, including an explicit no-save consent signal, to the download API', async () => {
    apiMocks.getEnvironments.mockResolvedValueOnce([baseEnv]);
    apiMocks.startDownload.mockResolvedValueOnce({ success: true, downloadId: 'env-1' });
    apiMocks.updateEnvironment.mockResolvedValueOnce({ ...baseEnv, status: 'downloading' });

    render(
      <EnvironmentStoreProvider>
        <Consumer />
      </EnvironmentStoreProvider>
    );

    await waitFor(() => {
      expect(screen.getByTestId('loading').textContent).toBe('false');
    });
    fireEvent.click(screen.getByTestId('start-download-one-time'));

    await waitFor(() => {
      expect(apiMocks.startDownload).toHaveBeenCalledWith('env-1', {
        username: 'steam-user',
        password: 'one-time-password',
        steamGuard: '12345',
        saveCredentials: false,
      });
    });
  });

  it('keeps an ordinary download API call free of credential arguments', async () => {
    apiMocks.getEnvironments.mockResolvedValueOnce([baseEnv]);
    apiMocks.startDownload.mockResolvedValueOnce({ success: true, downloadId: 'env-1' });
    apiMocks.updateEnvironment.mockResolvedValueOnce({ ...baseEnv, status: 'downloading' });

    render(
      <EnvironmentStoreProvider>
        <Consumer />
      </EnvironmentStoreProvider>
    );

    await waitFor(() => {
      expect(screen.getByTestId('loading').textContent).toBe('false');
    });
    fireEvent.click(screen.getByTestId('start-download'));

    await waitFor(() => {
      expect(apiMocks.startDownload).toHaveBeenCalledWith('env-1');
    });
  });

  it('does not regress a completed event when start resolves afterwards', async () => {
    let resolveStart: (() => void) | undefined;
    apiMocks.getEnvironments
      .mockResolvedValueOnce([{ ...baseEnv, status: 'downloading' }])
      .mockResolvedValueOnce([{ ...baseEnv, status: 'completed' }]);
    apiMocks.startDownload.mockImplementationOnce(() => new Promise<void>((resolve) => {
      resolveStart = resolve;
    }));

    render(
      <EnvironmentStoreProvider>
        <Consumer />
      </EnvironmentStoreProvider>
    );

    await waitFor(() => expect(completeHandler).not.toBeNull());
    fireEvent.click(screen.getByTestId('start-download'));
    await waitFor(() => expect(apiMocks.startDownload).toHaveBeenCalledWith('env-1'));

    void completeHandler?.({ downloadId: 'env-1' });
    await waitFor(() => expect(screen.getByTestId('env-status').textContent).toBe('completed'));

    resolveStart?.();
    await waitFor(() => expect(apiMocks.startDownload).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId('env-status').textContent).toBe('completed');
    expect(apiMocks.updateEnvironment).not.toHaveBeenCalledWith(
      'env-1',
      expect.objectContaining({ status: 'downloading' }),
    );
  });

  it('retains progress and refreshes the completed backend state when cancellation is rejected', async () => {
    apiMocks.getEnvironments
      .mockResolvedValueOnce([{ ...baseEnv, status: 'downloading' }])
      .mockResolvedValueOnce([{ ...baseEnv, status: 'completed' }]);
    apiMocks.cancelDownload.mockResolvedValueOnce({ success: false });

    render(
      <EnvironmentStoreProvider>
        <Consumer />
      </EnvironmentStoreProvider>
    );

    await waitFor(() => expect(screen.getByTestId('loading').textContent).toBe('false'));
    progressHandler?.({ downloadId: 'env-1', status: 'downloading', progress: 95 });
    await waitFor(() => expect(screen.getByTestId('progress-count').textContent).toBe('1'));

    fireEvent.click(screen.getByTestId('cancel-download'));

    await waitFor(() => {
      expect(apiMocks.cancelDownload).toHaveBeenCalledWith('env-1');
      expect(screen.getByTestId('env-status').textContent).toBe('completed');
    });
    expect(screen.getByTestId('progress-count').textContent).toBe('1');
    expect(apiMocks.updateEnvironment).not.toHaveBeenCalledWith(
      'env-1',
      expect.objectContaining({ status: 'not_downloaded' }),
    );
  });

  it('coalesces duplicate initial environment refreshes while one request is pending', async () => {
    let resolveEnvironments: (value: Environment[]) => void = () => {};
    apiMocks.getEnvironments.mockReturnValueOnce(new Promise<Environment[]>((resolve) => {
      resolveEnvironments = resolve;
    }));

    render(
      <React.StrictMode>
        <EnvironmentStoreProvider>
          <Consumer />
        </EnvironmentStoreProvider>
      </React.StrictMode>
    );

    await waitFor(() => {
      expect(apiMocks.getEnvironments).toHaveBeenCalledTimes(1);
    });

    resolveEnvironments([{ ...baseEnv, currentGameVersion: '1.0.0' }]);

    await waitFor(() => {
      expect(screen.getByTestId('loading').textContent).toBe('false');
    });
    expect(screen.getByTestId('env-version').textContent).toBe('1.0.0');
  });

  it('updates the progress map without persisting completion from progress events', async () => {
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

    expect(apiMocks.updateEnvironment).not.toHaveBeenCalled();
  });

  it('refreshes backend-owned completion state and clears progress', async () => {
    apiMocks.getEnvironments.mockResolvedValue([baseEnv]);
    apiMocks.updateEnvironment.mockImplementation(async (id: string, updates: Partial<Environment>) => ({
      ...baseEnv,
      id,
      ...updates,
    }));
    apiMocks.extractGameVersion.mockReset();
    apiMocks.extractGameVersion
      .mockResolvedValueOnce({ version: null })
      .mockResolvedValueOnce({ version: '2.0.0' });

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

    expect(apiMocks.getEnvironments).toHaveBeenCalledTimes(2);
    expect(apiMocks.updateEnvironment).not.toHaveBeenCalledWith(
      'env-1',
      expect.objectContaining({ status: 'completed' }),
    );
  });

  it('keeps the existing environment list visible during a completion refresh', async () => {
    let resolveCompletionRefresh: (value: Environment[]) => void = () => {};
    apiMocks.getEnvironments
      .mockResolvedValueOnce([baseEnv])
      .mockReturnValueOnce(new Promise<Environment[]>((resolve) => {
        resolveCompletionRefresh = resolve;
      }));

    render(
      <EnvironmentStoreProvider>
        <Consumer />
      </EnvironmentStoreProvider>
    );

    await waitFor(() => {
      expect(screen.getByTestId('loading').textContent).toBe('false');
      expect(completeHandler).not.toBeNull();
    });

    void completeHandler?.({ downloadId: 'env-1' });

    await waitFor(() => {
      expect(apiMocks.getEnvironments).toHaveBeenCalledTimes(2);
    });
    expect(screen.getByTestId('loading').textContent).toBe('false');
    expect(screen.getByTestId('env-status').textContent).toBe('completed');

    resolveCompletionRefresh([{ ...baseEnv, currentGameVersion: '2.0.0' }]);

    await waitFor(() => {
      expect(screen.getByTestId('env-version').textContent).toBe('2.0.0');
    });
  });

  it('refreshes completion state even when the completion payload omits a manifest', async () => {
    apiMocks.getEnvironments.mockResolvedValue([baseEnv]);
    apiMocks.updateEnvironment.mockImplementation(async (id: string, updates: Partial<Environment>) => ({
      ...baseEnv,
      id,
      ...updates,
    }));
    apiMocks.extractGameVersion.mockReset();
    apiMocks.extractGameVersion
      .mockResolvedValueOnce({ version: null })
      .mockResolvedValueOnce({ version: '2.0.0' });
    render(
      <EnvironmentStoreProvider>
        <Consumer />
      </EnvironmentStoreProvider>
    );

    await waitFor(() => {
      expect(screen.getByTestId('loading').textContent).toBe('false');
    });

    completeHandler?.({ downloadId: 'env-1' });

    await waitFor(() => {
      expect(screen.getByTestId('progress-count').textContent).toBe('0');
    });

    expect(apiMocks.checkUpdate).not.toHaveBeenCalled();
    expect(apiMocks.getEnvironments).toHaveBeenCalledTimes(2);
    expect(apiMocks.updateEnvironment).not.toHaveBeenCalledWith(
      'env-1',
      expect.objectContaining({
        status: 'completed',
      }),
    );
  });

  it('checkAllUpdates updates environments in place', async () => {
    apiMocks.getEnvironments.mockResolvedValueOnce([baseEnv]);
    apiMocks.checkAllUpdates.mockResolvedValueOnce([
      {
        environmentId: 'env-1',
        updateAvailable: true,
        remoteManifestId: '456',
        branch: 'alternate',
        runtime: 'Mono',
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
      expect(screen.getByTestId('env-branch').textContent).toBe('alternate');
      expect(screen.getByTestId('env-runtime').textContent).toBe('Mono');
    });
  });

  it('refreshes a known Steam install version so external branch switches are detected', async () => {
    apiMocks.getEnvironments.mockResolvedValueOnce([{
      ...baseEnv,
      currentGameVersion: '1.0.0',
      environmentType: 'Steam',
    }]);
    apiMocks.extractGameVersion.mockResolvedValueOnce({
      version: '1.0.0',
      branch: 'alternate',
      runtime: 'Mono',
    });

    render(
      <EnvironmentStoreProvider>
        <Consumer />
      </EnvironmentStoreProvider>
    );

    await waitFor(() => {
      expect(screen.getByTestId('env-branch').textContent).toBe('alternate');
      expect(screen.getByTestId('env-runtime').textContent).toBe('Mono');
    });
    expect(apiMocks.extractGameVersion).toHaveBeenCalledWith('env-1');

    fireEvent.click(screen.getByTestId('ensure-environments'));
    await waitFor(() => {
      expect(screen.getByTestId('cached-runtime').textContent).toBe('Mono');
    });
    expect(apiMocks.getEnvironments).toHaveBeenCalledTimes(1);
  });

  it('applies a launch-time Steam runtime switch event immediately', async () => {
    apiMocks.getEnvironments.mockResolvedValueOnce([baseEnv]);
    render(
      <EnvironmentStoreProvider>
        <Consumer />
      </EnvironmentStoreProvider>
    );
    await waitFor(() => expect(runtimeSwitchHandler).not.toBeNull());

    const emitRuntimeSwitch = runtimeSwitchHandler as unknown as (data: import('../types').RuntimeSwitchResult) => void;
    emitRuntimeSwitch({
      environmentId: 'env-1',
      environmentName: 'Env',
      previousBranch: 'closed-beta',
      branch: 'main',
      previousRuntime: 'IL2CPP',
      runtime: 'MONO',
      disabledItems: 1,
      installedItems: 0,
      missingItems: ['Example'],
      errors: [],
    });

    await waitFor(() => {
      expect(screen.getByTestId('env-branch').textContent).toBe('main');
      expect(screen.getByTestId('env-runtime').textContent).toBe('Mono');
    });

    fireEvent.click(screen.getByTestId('ensure-environments'));
    await waitFor(() => {
      expect(screen.getByTestId('cached-runtime').textContent).toBe('Mono');
    });
    expect(apiMocks.getEnvironments).toHaveBeenCalledTimes(1);
  });

  it('does not let an in-flight environment fetch overwrite a newer mutation', async () => {
    let resolveInitialFetch: (value: Environment[]) => void = () => {};
    apiMocks.getEnvironments
      .mockReturnValueOnce(new Promise<Environment[]>((resolve) => {
        resolveInitialFetch = resolve;
      }))
      .mockResolvedValueOnce([{ ...baseEnv, runtime: 'Mono' }]);
    apiMocks.createEnvironment.mockResolvedValueOnce({ ...baseEnv, runtime: 'Mono' });

    render(
      <EnvironmentStoreProvider>
        <Consumer />
      </EnvironmentStoreProvider>
    );

    await waitFor(() => expect(apiMocks.getEnvironments).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByTestId('create-environment'));
    await waitFor(() => expect(screen.getByTestId('env-runtime').textContent).toBe('Mono'));

    resolveInitialFetch([{ ...baseEnv, runtime: 'IL2CPP' }]);
    await waitFor(() => expect(apiMocks.getEnvironments).toHaveBeenCalledTimes(2));
    expect(screen.getByTestId('env-runtime').textContent).toBe('Mono');
  });

  it('does not resurrect a deleted environment from an older in-flight refresh', async () => {
    let resolveInitialFetch: (value: Environment[]) => void = () => {};
    apiMocks.getEnvironments
      .mockReturnValueOnce(new Promise<Environment[]>((resolve) => {
        resolveInitialFetch = resolve;
      }))
      .mockResolvedValueOnce([]);
    apiMocks.deleteEnvironment.mockResolvedValueOnce(true);

    render(
      <EnvironmentStoreProvider>
        <Consumer />
      </EnvironmentStoreProvider>
    );

    await waitFor(() => expect(apiMocks.getEnvironments).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByTestId('delete-environment'));
    resolveInitialFetch([baseEnv]);

    await waitFor(() => {
      expect(apiMocks.getEnvironments).toHaveBeenCalledTimes(2);
      expect(screen.getByTestId('env-status').textContent).toBe('none');
    });
  });

  it('retries once when a completion event invalidates an in-flight environment fetch', async () => {
    let resolveInitialFetch: (value: Environment[]) => void = () => {};
    apiMocks.getEnvironments
      .mockReturnValueOnce(new Promise<Environment[]>((resolve) => {
        resolveInitialFetch = resolve;
      }))
      .mockResolvedValueOnce([{ ...baseEnv, status: 'completed', currentGameVersion: '2.0.0' }]);

    render(
      <EnvironmentStoreProvider>
        <Consumer />
      </EnvironmentStoreProvider>
    );

    await waitFor(() => {
      expect(apiMocks.getEnvironments).toHaveBeenCalledTimes(1);
      expect(completeHandler).not.toBeNull();
    });

    void completeHandler?.({ downloadId: 'env-1' });
    resolveInitialFetch([{ ...baseEnv, status: 'downloading', currentGameVersion: '1.0.0' }]);

    await waitFor(() => {
      expect(apiMocks.getEnvironments).toHaveBeenCalledTimes(2);
      expect(screen.getByTestId('env-status').textContent).toBe('completed');
      expect(screen.getByTestId('env-version').textContent).toBe('2.0.0');
    });
    expect(apiMocks.getEnvironments).toHaveBeenCalledTimes(2);
  });

  it('cleans up all event listeners on unmount', async () => {
    apiMocks.getEnvironments.mockResolvedValueOnce([baseEnv]);

    const unlistenProgress = vi.fn();
    const unlistenComplete = vi.fn();
    const unlistenError = vi.fn();
    const unlistenUpdateAvailable = vi.fn();
    const unlistenUpdateCheckComplete = vi.fn();
    const unlistenRuntimeSwitch = vi.fn();

    eventMocks.onProgress.mockResolvedValueOnce(unlistenProgress);
    eventMocks.onComplete.mockResolvedValueOnce(unlistenComplete);
    eventMocks.onError.mockResolvedValueOnce(unlistenError);
    eventMocks.onUpdateAvailable.mockResolvedValueOnce(unlistenUpdateAvailable);
    eventMocks.onUpdateCheckComplete.mockResolvedValueOnce(unlistenUpdateCheckComplete);
    eventMocks.onRuntimeSwitch.mockResolvedValueOnce(unlistenRuntimeSwitch);

    const { unmount } = render(
      <EnvironmentStoreProvider>
        <Consumer />
      </EnvironmentStoreProvider>
    );

    await waitFor(() => {
      expect(screen.getByTestId('loading').textContent).toBe('false');
    });

    unmount();

    expect(unlistenProgress).toHaveBeenCalled();
    expect(unlistenComplete).toHaveBeenCalled();
    expect(unlistenError).toHaveBeenCalled();
    expect(unlistenUpdateAvailable).toHaveBeenCalled();
    expect(unlistenUpdateCheckComplete).toHaveBeenCalled();
    expect(unlistenRuntimeSwitch).toHaveBeenCalled();
  });
});
