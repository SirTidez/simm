import { listen } from '@tauri-apps/api/event';
import type { DownloadProgress, UpdateCheckResult } from '../types';

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

export interface MelonLoaderInstallingEvent {
  downloadId: string;
  message: string;
}

export interface MelonLoaderInstalledEvent {
  downloadId: string;
  message: string;
  version?: string;
}

export interface MelonLoaderErrorEvent {
  downloadId: string;
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

export interface ModsChangedEvent {
  environmentId: string;
}

export interface PluginsChangedEvent {
  environmentId: string;
}

export interface UserLibsChangedEvent {
  environmentId: string;
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

export async function onModsChanged(handler: (data: ModsChangedEvent) => void): Promise<() => void> {
  return await listen<ModsChangedEvent>('mods_changed', (event) => {
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
