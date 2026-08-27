import { listen } from '@tauri-apps/api/event';
import type { DownloadProgress, LiveTelemetryEvent, LiveTelemetryStatus, RuntimeSwitchResult, TrackedDownload, UpdateCheckResult } from '../types';

export type EventUnlisten = () => void;

/**
 * Own asynchronous Tauri listener registration for a React effect.
 *
 * `listen()` resolves asynchronously.  A normal effect cleanup can therefore
 * run before it yields its unlisten callback, leaking a stale listener.  Keep
 * the listener and the callback's liveness in one small scope so callers can
 * safely register several listeners without hand-rolled mutable variables.
 */
export interface AsyncListenerScope {
  register: (subscribe: () => Promise<EventUnlisten>) => void;
  dispose: () => void;
  isActive: () => boolean;
}

export function createAsyncListenerScope(onError?: (error: unknown) => void): AsyncListenerScope {
  let disposed = false;
  const unlisteners = new Set<EventUnlisten>();

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    for (const unlisten of unlisteners) {
      unlisten();
    }
    unlisteners.clear();
  };

  return {
    register: (subscribe) => {
      void subscribe()
        .then((unlisten) => {
          if (disposed) {
            unlisten();
            return;
          }
          unlisteners.add(unlisten);
        })
        .catch((error: unknown) => onError?.(error));
    },
    dispose,
    isActive: () => !disposed,
  };
}

export interface ProgressEvent {
  downloadId: string;
  progress: DownloadProgress;
}

export interface CompleteEvent {
  downloadId: string;
  manifestId?: string;
}

export interface ErrorEvent {
  downloadId: string;
  error: string;
}

export interface AuthWaitingEvent {
  downloadId: string;
  message: string;
}

export interface AuthSuccessEvent {
  downloadId: string;
}

export interface AuthErrorEvent {
  downloadId: string;
  error: string;
}

export interface SteamAuthQrLineEvent {
  line: string;
}

export interface MelonLoaderInstallingEvent {
  downloadId: string;
  environmentId: string;
  message: string;
}

export interface MelonLoaderInstalledEvent {
  downloadId: string;
  environmentId: string;
  message: string;
  version?: string;
}

export interface MelonLoaderErrorEvent {
  downloadId: string;
  environmentId: string;
  message: string;
}

export interface UpdateAvailableEvent {
  environmentId: string;
  updateResult: UpdateCheckResult;
}

export interface UpdateCheckCompleteEvent {
  environmentId: string;
  updateResult: UpdateCheckResult;
}

export type RuntimeSwitchEvent = RuntimeSwitchResult;

export interface ModsChangedEvent {
  environmentId: string;
}

export interface ModsSnapshotUpdatedEvent {
  environmentId: string;
  snapshot: {
    mods: Array<{
      name: string;
      fileName: string;
      path: string;
      version?: string;
      source?: string;
      sourceUrl?: string;
      disabled?: boolean;
      modStorageId?: string;
      managed?: boolean;
    }>;
    modsDirectory: string;
    count: number;
  };
}

export interface PluginsChangedEvent {
  environmentId: string;
}

export interface UserLibsChangedEvent {
  environmentId: string;
}

export interface ModUpdatesCheckedEvent {
  environmentId: string;
  count: number;
  updates: Array<{
    modFileName: string;
    modName: string;
    currentVersion: string;
    latestVersion: string;
    source: string;
  }>;
}

export interface ModMetadataRefreshStatusEvent {
  activeCount: number;
  running: boolean;
}

export type TrackedDownloadUpdatedEvent = TrackedDownload;

export async function onLiveTelemetryEvent(handler: (data: LiveTelemetryEvent) => void): Promise<() => void> {
  return await listen<LiveTelemetryEvent>('live_telemetry_event', (event) => handler(event.payload));
}

export async function onLiveTelemetryStatus(handler: (data: LiveTelemetryStatus) => void): Promise<() => void> {
  return await listen<LiveTelemetryStatus>('live_telemetry_status', (event) => handler(event.payload));
}

export async function onProgress(handler: (data: DownloadProgress) => void): Promise<() => void> {
  return await listen<ProgressEvent>('download_progress', (event) => {
    handler(event.payload.progress);
  });
}

export async function onComplete(handler: (data: CompleteEvent) => void): Promise<() => void> {
  return await listen<CompleteEvent>('download_complete', (event) => {
    handler(event.payload);
  });
}

export async function onError(handler: (data: ErrorEvent) => void): Promise<() => void> {
  return await listen<ErrorEvent>('download_error', (event) => {
    handler(event.payload);
  });
}

export async function onAuthWaiting(handler: (data: AuthWaitingEvent) => void): Promise<() => void> {
  return await listen<AuthWaitingEvent>('auth_waiting', (event) => {
    handler(event.payload);
  });
}

export async function onAuthSuccess(handler: (data: AuthSuccessEvent) => void): Promise<() => void> {
  return await listen<AuthSuccessEvent>('auth_success', (event) => {
    handler(event.payload);
  });
}

export async function onAuthError(handler: (data: AuthErrorEvent) => void): Promise<() => void> {
  return await listen<AuthErrorEvent>('auth_error', (event) => {
    handler(event.payload);
  });
}

export async function onSteamAuthQrLine(handler: (data: SteamAuthQrLineEvent) => void): Promise<() => void> {
  return await listen<SteamAuthQrLineEvent>('steam_auth_qr_line', (event) => {
    handler(event.payload);
  });
}

export async function onMelonLoaderInstalling(handler: (data: MelonLoaderInstallingEvent) => void): Promise<() => void> {
  return await listen<MelonLoaderInstallingEvent>('melonloader_installing', (event) => {
    handler(event.payload);
  });
}

export async function onMelonLoaderInstalled(handler: (data: MelonLoaderInstalledEvent) => void): Promise<() => void> {
  return await listen<MelonLoaderInstalledEvent>('melonloader_installed', (event) => {
    handler(event.payload);
  });
}

export async function onMelonLoaderError(handler: (data: MelonLoaderErrorEvent) => void): Promise<() => void> {
  return await listen<MelonLoaderErrorEvent>('melonloader_error', (event) => {
    handler(event.payload);
  });
}

export async function onUpdateAvailable(handler: (data: UpdateAvailableEvent) => void): Promise<() => void> {
  return await listen<UpdateAvailableEvent>('update_available', (event) => {
    handler(event.payload);
  });
}

export async function onUpdateCheckComplete(handler: (data: UpdateCheckCompleteEvent) => void): Promise<() => void> {
  return await listen<UpdateCheckCompleteEvent>('update_check_complete', (event) => {
    handler(event.payload);
  });
}

export async function onRuntimeSwitch(handler: (data: RuntimeSwitchEvent) => void): Promise<() => void> {
  return await listen<RuntimeSwitchEvent>('steam_runtime_switched', (event) => {
    handler(event.payload);
  });
}

export async function onModsChanged(handler: (data: ModsChangedEvent) => void): Promise<() => void> {
  return await listen<ModsChangedEvent>('mods_changed', (event) => {
    handler(event.payload);
  });
}

export async function onModsSnapshotUpdated(handler: (data: ModsSnapshotUpdatedEvent) => void): Promise<() => void> {
  return await listen<ModsSnapshotUpdatedEvent>('mods_snapshot_updated', (event) => {
    handler(event.payload);
  });
}

export async function onPluginsChanged(handler: (data: PluginsChangedEvent) => void): Promise<() => void> {
  return await listen<PluginsChangedEvent>('plugins_changed', (event) => {
    handler(event.payload);
  });
}

export async function onUserLibsChanged(handler: (data: UserLibsChangedEvent) => void): Promise<() => void> {
  return await listen<UserLibsChangedEvent>('userlibs_changed', (event) => {
    handler(event.payload);
  });
}

export async function onModUpdatesChecked(handler: (data: ModUpdatesCheckedEvent) => void): Promise<() => void> {
  return await listen<ModUpdatesCheckedEvent>('mod_updates_checked', (event) => {
    handler(event.payload);
  });
}

export async function onModMetadataRefreshStatus(
  handler: (data: ModMetadataRefreshStatusEvent) => void
): Promise<() => void> {
  return await listen<ModMetadataRefreshStatusEvent>('mod_metadata_refresh_status', (event) => {
    handler(event.payload);
  });
}

export async function onTrackedDownloadUpdated(
  handler: (data: TrackedDownloadUpdatedEvent) => void
): Promise<() => void> {
  return await listen<TrackedDownloadUpdatedEvent>('tracked_download_updated', (event) => {
    handler(event.payload);
  });
}
