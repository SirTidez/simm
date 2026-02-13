import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  onProgress,
  onComplete,
  onError,
  onAuthWaiting,
  onAuthSuccess,
  onAuthError,
  onMelonLoaderInstalling,
  onMelonLoaderInstalled,
  onMelonLoaderError,
  onUpdateAvailable,
  onUpdateCheckComplete,
  onModsChanged,
  onPluginsChanged,
  onUserLibsChanged,
  onModUpdatesChecked,
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

  it.each([
    ['onComplete', onComplete, 'download_complete', { downloadId: 'd-1' }],
    ['onError', onError, 'download_error', { downloadId: 'd-1', error: 'boom' }],
    ['onAuthWaiting', onAuthWaiting, 'auth_waiting', { downloadId: 'd-1', message: 'wait' }],
    ['onAuthSuccess', onAuthSuccess, 'auth_success', { downloadId: 'd-1' }],
    ['onAuthError', onAuthError, 'auth_error', { downloadId: 'd-1', error: 'bad' }],
    ['onMelonLoaderInstalling', onMelonLoaderInstalling, 'melonloader_installing', { downloadId: 'd-1', message: 'installing' }],
    ['onMelonLoaderInstalled', onMelonLoaderInstalled, 'melonloader_installed', { downloadId: 'd-1', message: 'done', version: '1.0.0' }],
    ['onMelonLoaderError', onMelonLoaderError, 'melonloader_error', { downloadId: 'd-1', message: 'err' }],
    ['onUpdateCheckComplete', onUpdateCheckComplete, 'update_check_complete', { environmentId: 'env-1', updateResult: { updateAvailable: false, branch: 'main', appId: '3164500', checkedAt: 'now' } }],
    ['onModsChanged', onModsChanged, 'mods_changed', { environmentId: 'env-1' }],
    ['onPluginsChanged', onPluginsChanged, 'plugins_changed', { environmentId: 'env-1' }],
    ['onUserLibsChanged', onUserLibsChanged, 'userlibs_changed', { environmentId: 'env-1' }],
    ['onModUpdatesChecked', onModUpdatesChecked, 'mod_updates_checked', { environmentId: 'env-1', count: 1, updates: [] }],
  ])('%s wires %s and forwards payload', async (_name, subscribe, eventName, payload) => {
    const handler = vi.fn();
    const unlisten = vi.fn();
    listenMock.mockResolvedValueOnce(unlisten);

    const result = await (subscribe as (h: (p: any) => void) => Promise<() => void>)(handler);

    expect(result).toBe(unlisten);
    expect(listenMock).toHaveBeenCalledWith(eventName, expect.any(Function));

    const callback = listenMock.mock.calls[0]?.[1] as (event: { payload: unknown }) => void;
    callback({ payload });
    expect(handler).toHaveBeenCalledWith(payload);
  });
});
