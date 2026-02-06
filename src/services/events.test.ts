import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  onProgress,
  onUpdateAvailable,
  type ProgressEvent,
  type UpdateAvailableEvent,
} from './events';
import { listen } from '@tauri-apps/api/event';

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(),
}));

const listenMock = vi.mocked(listen);

describe('events', () => {
  beforeEach(() => {
    listenMock.mockReset();
  });

  it('onProgress forwards payload progress', async () => {
    const handler = vi.fn();
    const unlisten = vi.fn();
    listenMock.mockResolvedValueOnce(unlisten);

    await onProgress(handler);

    expect(listenMock).toHaveBeenCalledWith('download_progress', expect.any(Function));
    const callback = listenMock.mock.calls[0]?.[1] as (event: { payload: ProgressEvent }) => void;
    callback({
      payload: {
        downloadId: 'download-1',
        progress: {
          downloadId: 'download-1',
          status: 'downloading',
          progress: 50,
        },
      },
    });

    expect(handler).toHaveBeenCalledWith({
      downloadId: 'download-1',
      status: 'downloading',
      progress: 50,
    });
  });

  it('onUpdateAvailable forwards payload', async () => {
    const handler = vi.fn();
    const unlisten = vi.fn();
    listenMock.mockResolvedValueOnce(unlisten);

    await onUpdateAvailable(handler);
    expect(listenMock).toHaveBeenCalledWith('update_available', expect.any(Function));

    const callback = listenMock.mock.calls[0]?.[1] as (event: { payload: UpdateAvailableEvent }) => void;
    callback({
      payload: {
        environmentId: 'env-1',
        updateResult: {
          updateAvailable: true,
          branch: 'main',
          appId: '3164500',
          checkedAt: 'now',
        },
      },
    });

    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        environmentId: 'env-1',
      })
    );
  });
});
