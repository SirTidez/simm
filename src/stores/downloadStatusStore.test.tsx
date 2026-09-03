import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { DownloadStatusStoreProvider, useDownloadStatusStore } from './downloadStatusStore';
import type { DownloadProgress, TrackedDownload } from '../types';

const environmentStoreMocks = vi.hoisted(() => ({
  useEnvironmentStore: vi.fn(),
}));

const eventMocks = vi.hoisted(() => ({
  onProgress: vi.fn(),
  onComplete: vi.fn(),
  onError: vi.fn(),
  onTrackedDownloadUpdated: vi.fn(),
}));
const listenerScopeMocks = vi.hoisted(() => ({
  createAsyncListenerScope: vi.fn((onError?: (error: unknown) => void) => {
    let disposed = false;
    const unlisteners = new Set<() => void>();
    return {
      register: (subscribe: () => Promise<() => void>) => {
        void subscribe().then((unlisten) => {
          if (disposed) {
            unlisten();
            return;
          }
          unlisteners.add(unlisten);
        }).catch(onError);
      },
      dispose: () => {
        disposed = true;
        unlisteners.forEach((unlisten) => unlisten());
        unlisteners.clear();
      },
      isActive: () => !disposed,
    };
  }),
}));

vi.mock('./environmentStore', () => ({
  useEnvironmentStore: environmentStoreMocks.useEnvironmentStore,
}));

vi.mock('../services/events', () => ({
  ...eventMocks,
  createAsyncListenerScope: listenerScopeMocks.createAsyncListenerScope,
}));

function Consumer() {
  const { downloads } = useDownloadStatusStore();
  const summary = downloads.reduce(
    (aggregate, download) => ({
      downloaded: aggregate.downloaded + (download.downloadedFiles ?? 0),
      total: aggregate.total + (download.totalFiles ?? 0),
    }),
    { downloaded: 0, total: 0 }
  );

  return (
    <div>
      <div data-testid="count">{downloads.length}</div>
      <div data-testid="order">{downloads.map((download) => download.id).join(',')}</div>
      <div data-testid="labels">{downloads.map((download) => `${download.label}|${download.contextLabel}`).join(',')}</div>
      <div data-testid="statuses">{downloads.map((download) => `${download.id}:${download.status}`).join(',')}</div>
      <div data-testid="summary">{summary.downloaded}/{summary.total}</div>
    </div>
  );
}

describe('DownloadStatusStore', () => {
  let progressHandler: ((data: DownloadProgress) => void) | null = null;
  let completeHandler: ((data: { downloadId: string; operationId: string; manifestId?: string }) => void) | null = null;
  let errorHandler: ((data: { downloadId: string; operationId: string; error: string }) => void) | null = null;
  let trackedDownloadHandler: ((data: TrackedDownload) => void) | null = null;

  beforeEach(() => {
    progressHandler = null;
    completeHandler = null;
    errorHandler = null;
    trackedDownloadHandler = null;

    environmentStoreMocks.useEnvironmentStore.mockReset();
    environmentStoreMocks.useEnvironmentStore.mockReturnValue({
      environments: [
        {
          id: 'env-1',
          name: 'Main Branch',
        },
      ],
    });

    eventMocks.onProgress.mockReset();
    eventMocks.onComplete.mockReset();
    eventMocks.onError.mockReset();
    eventMocks.onTrackedDownloadUpdated.mockReset();

    eventMocks.onProgress.mockImplementation(async (handler: (data: DownloadProgress) => void) => {
      progressHandler = handler;
      return () => {};
    });
    eventMocks.onComplete.mockImplementation(async (handler: (data: { downloadId: string; operationId: string; manifestId?: string }) => void) => {
      completeHandler = handler;
      return () => {};
    });
    eventMocks.onError.mockImplementation(async (handler: (data: { downloadId: string; operationId: string; error: string }) => void) => {
      errorHandler = handler;
      return () => {};
    });
    eventMocks.onTrackedDownloadUpdated.mockImplementation(async (handler: (data: TrackedDownload) => void) => {
      trackedDownloadHandler = handler;
      return () => {};
    });
  });

  afterEach(() => {
    cleanup();
    if (vi.isFakeTimers()) {
      vi.runOnlyPendingTimers();
    }
    vi.useRealTimers();
  });

  async function flushListeners() {
    await act(async () => {
      await Promise.resolve();
    });
  }

  it('maps depot downloader progress into tracked game rows', async () => {
    render(
      <DownloadStatusStoreProvider>
        <Consumer />
      </DownloadStatusStoreProvider>
    );

    await flushListeners();
    expect(eventMocks.onProgress).toHaveBeenCalled();

    await act(async () => {
      progressHandler?.({
        downloadId: 'env-1',
        operationId: 'operation-1',
        status: 'downloading',
        progress: 35,
        downloadedFiles: 2,
        totalFiles: 10,
        message: 'Downloading depot',
      });
    });

    expect(screen.getByTestId('count').textContent).toBe('1');
    expect(screen.getByTestId('labels').textContent).toContain('Main Branch|Game download');
    expect(screen.getByTestId('summary').textContent).toBe('2/10');
  });

  it('ingests tracked download events and summarizes file totals', async () => {
    render(
      <DownloadStatusStoreProvider>
        <Consumer />
      </DownloadStatusStoreProvider>
    );

    await flushListeners();
    expect(eventMocks.onTrackedDownloadUpdated).toHaveBeenCalled();

    await act(async () => {
      trackedDownloadHandler?.({
        id: 'mod-1',
        kind: 'mod',
        label: 'ExampleMod.zip',
        contextLabel: 'Thunderstore',
        status: 'completed',
        progress: 100,
        downloadedFiles: 1,
        totalFiles: 1,
        message: 'Archive downloaded',
        startedAt: Date.now() - 1000,
        finishedAt: Date.now(),
      });
    });

    expect(screen.getByTestId('labels').textContent).toContain('ExampleMod.zip|Thunderstore');
    expect(screen.getByTestId('summary').textContent).toBe('1/1');
  });

  it('removes terminal rows after the retention window', async () => {
    vi.useFakeTimers();

    render(
      <DownloadStatusStoreProvider>
        <Consumer />
      </DownloadStatusStoreProvider>
    );

    await flushListeners();
    expect(eventMocks.onTrackedDownloadUpdated).toHaveBeenCalled();

    await act(async () => {
      trackedDownloadHandler?.({
        id: 'framework-1',
        kind: 'framework',
        label: 'MelonLoader.zip',
        contextLabel: 'Main Branch',
        status: 'completed',
        progress: 100,
        downloadedFiles: 1,
        totalFiles: 1,
        startedAt: Date.now() - 1000,
        finishedAt: Date.now(),
      });
    });

    expect(screen.getByTestId('count').textContent).toBe('1');

    await act(async () => {
      vi.advanceTimersByTime(10_000);
    });

    expect(screen.getByTestId('count').textContent).toBe('0');
  });

  it('sorts active rows ahead of terminal rows', async () => {
    render(
      <DownloadStatusStoreProvider>
        <Consumer />
      </DownloadStatusStoreProvider>
    );

    await flushListeners();
    expect(eventMocks.onTrackedDownloadUpdated).toHaveBeenCalled();

    await act(async () => {
      trackedDownloadHandler?.({
        id: 'completed-1',
        kind: 'mod',
        label: 'Old.zip',
        contextLabel: 'Thunderstore',
        status: 'completed',
        progress: 100,
        downloadedFiles: 1,
        totalFiles: 1,
        startedAt: Date.now() - 2000,
        finishedAt: Date.now() - 1000,
      });

      trackedDownloadHandler?.({
        id: 'active-1',
        kind: 'plugin',
        label: 'Live.dll',
        contextLabel: 'Main Branch',
        status: 'downloading',
        progress: 0,
        downloadedFiles: 0,
        totalFiles: 1,
        startedAt: Date.now(),
        finishedAt: null,
      });
    });

    expect(screen.getByTestId('order').textContent?.startsWith('active-1')).toBe(true);
  });

  it('disposes a listener that resolves after the status provider unmounts', async () => {
    let resolveProgress: ((unlisten: () => void) => void) | undefined;
    const lateUnlisten = vi.fn();
    eventMocks.onProgress.mockImplementationOnce(() => new Promise((resolve) => {
      resolveProgress = resolve;
    }));

    const view = render(
      <DownloadStatusStoreProvider>
        <Consumer />
      </DownloadStatusStoreProvider>,
    );
    await flushListeners();
    view.unmount();

    await act(async () => {
      resolveProgress?.(lateUnlisten);
    });
    expect(lateUnlisten).toHaveBeenCalledTimes(1);
  });

  it('keeps a completed game download terminal when delayed progress arrives', async () => {
    render(
      <DownloadStatusStoreProvider>
        <Consumer />
      </DownloadStatusStoreProvider>
    );

    await flushListeners();

    await act(async () => {
      progressHandler?.({
        downloadId: 'env-1',
        operationId: 'operation-1',
        status: 'completed',
        progress: 100,
        downloadedFiles: 10,
        totalFiles: 10,
        message: 'Download complete',
      });
      progressHandler?.({
        downloadId: 'env-1',
        operationId: 'operation-1',
        status: 'downloading',
        progress: 50,
        downloadedFiles: 5,
        totalFiles: 10,
        message: 'Late output',
      });
    });

    expect(screen.getByTestId('statuses').textContent).toBe('game:env-1:completed');
    expect(screen.getByTestId('summary').textContent).toBe('10/10');
  });

  it('shows an immediate same-environment retry when the operation generation changes', async () => {
    render(
      <DownloadStatusStoreProvider>
        <Consumer />
      </DownloadStatusStoreProvider>
    );
    await flushListeners();

    await act(async () => {
      progressHandler?.({
        downloadId: 'env-1', operationId: 'operation-1', status: 'completed', progress: 100,
      });
    });
    expect(screen.getByTestId('statuses').textContent).toBe('game:env-1:completed');

    await act(async () => {
      progressHandler?.({
        downloadId: 'env-1', operationId: 'operation-2', status: 'downloading', progress: 0,
        message: 'Retry started',
      });
    });

    expect(screen.getByTestId('statuses').textContent).toBe('game:env-1:downloading');

    await act(async () => {
      completeHandler?.({ downloadId: 'env-1', operationId: 'operation-1' });
      errorHandler?.({ downloadId: 'env-1', operationId: 'operation-1', error: 'Delayed error' });
    });
    expect(screen.getByTestId('statuses').textContent).toBe('game:env-1:downloading');
  });

  it('keeps a tracked terminal row terminal when a stale active event arrives', async () => {
    render(
      <DownloadStatusStoreProvider>
        <Consumer />
      </DownloadStatusStoreProvider>
    );

    await flushListeners();

    await act(async () => {
      trackedDownloadHandler?.({
        id: 'mod-2',
        kind: 'mod',
        label: 'Example.zip',
        contextLabel: 'Nexus Mods',
        status: 'cancelled',
        progress: 20,
        downloadedFiles: 0,
        totalFiles: 1,
        startedAt: Date.now() - 100,
        finishedAt: Date.now(),
      });
      trackedDownloadHandler?.({
        id: 'mod-2',
        kind: 'mod',
        label: 'Example.zip',
        contextLabel: 'Nexus Mods',
        status: 'downloading',
        progress: 80,
        downloadedFiles: 1,
        totalFiles: 1,
        startedAt: Date.now() - 100,
        finishedAt: null,
      });
    });

    expect(screen.getByTestId('statuses').textContent).toBe('mod-2:cancelled');
  });

  it('does not let a stale active event cancel a terminal row removal timer', async () => {
    vi.useFakeTimers();
    render(
      <DownloadStatusStoreProvider>
        <Consumer />
      </DownloadStatusStoreProvider>
    );
    await flushListeners();

    await act(async () => {
      trackedDownloadHandler?.({
        id: 'mod-3', kind: 'mod', label: 'Example.zip', contextLabel: 'Nexus Mods',
        status: 'completed', progress: 100, downloadedFiles: 1, totalFiles: 1,
        startedAt: Date.now() - 100, finishedAt: Date.now(),
      });
      trackedDownloadHandler?.({
        id: 'mod-3', kind: 'mod', label: 'Example.zip', contextLabel: 'Nexus Mods',
        status: 'downloading', progress: 50, downloadedFiles: 0, totalFiles: 1,
        startedAt: Date.now() - 100, finishedAt: null,
      });
      vi.advanceTimersByTime(10_000);
    });

    expect(screen.getByTestId('count').textContent).toBe('0');
  });
});
