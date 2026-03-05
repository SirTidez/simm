import React, { useState, useEffect, useMemo, useRef } from 'react';
import { convertFileSrc } from '@tauri-apps/api/core';
import { ApiService } from '../services/api';
import { ConfirmOverlay } from './ConfirmOverlay';
import { onModMetadataRefreshStatus, onModsChanged as onModsChangedEvent, onModsSnapshotUpdated } from '../services/events';
import type { Environment, ModLibraryEntry, NexusMod, NexusModFile } from '../types';
import { open } from '@tauri-apps/plugin-dialog';

interface ModInfo {
  name: string;
  fileName: string;
  path: string;
  version?: string;
  source?: 'local' | 'thunderstore' | 'nexusmods' | 'github' | 'unknown';
  sourceUrl?: string;
  disabled?: boolean;
  modStorageId?: string;
  managed?: boolean;
  summary?: string;
  iconUrl?: string;
  iconCachePath?: string;
  downloads?: number;
  likesOrEndorsements?: number;
  updatedAt?: string;
  tags?: string[];
  installedAt?: number;
}

interface ModViewState {
  id: string;
  name: string;
  source: string;
  summary?: string;
  iconUrl?: string;
  iconCachePath?: string;
  sourceUrl?: string;
  author?: string;
  downloads?: number;
  likesOrEndorsements?: number;
  updatedAt?: string;
  tags?: string[];
  installedVersion?: string;
  latestVersion?: string;
  installedAt?: number;
  kind: 'installed' | 'library' | 'thunderstore' | 'nexusmods';
}

interface Props {
  isOpen: boolean;
  onClose: () => void;
  environmentId: string;
  onModsChanged?: () => void;
  onModUpdatesChecked?: (count: number) => void;
  onOpenAccounts?: () => void;
}

interface ConfirmDialog {
  title: string;
  message: string;
  confirmText?: string;
  cancelText?: string;
  onConfirm: () => Promise<void> | void;
  readyAt?: number;
}

interface ThunderstorePackage {
  uuid4: string;
  name: string;
  owner: string;
  package_url: string;
  date_created: string;
  date_updated: string;
  rating_score: number;
  is_pinned: boolean;
  is_deprecated: boolean;
  categories?: string[];
  full_name: string;
  versions: Array<{
    name: string;
    full_name: string;
    date_created: string;
    date_updated: string;
    uuid4: string;
    version_number: string;
    dependencies: string[];
    download_url: string;
    downloads: number;
    file_size: number;
    description?: string;
    icon?: string;
  }>;
  icon?: string;
  icon_url?: string;
}

function safeExternalUrl(raw: string | null | undefined): string | undefined {
  if (!raw) return undefined;
  try {
    const u = new URL(raw);
    // Prevent javascript:, data:, file:, etc.
    if (u.protocol !== 'https:') return undefined;
    return u.toString();
  } catch {
    return undefined;
  }
}

function resolveImageSource(pathOrUrl?: string): string | undefined {
  const safeDecode = (value: string): string => {
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  };

  if (!pathOrUrl) return undefined;
  if (pathOrUrl.startsWith('asset:')) {
    return pathOrUrl;
  }
  if (pathOrUrl.startsWith('http://') || pathOrUrl.startsWith('https://')) {
    return pathOrUrl;
  }
  if (pathOrUrl.startsWith('file://')) {
    try {
      const url = new URL(pathOrUrl);
      let filePath = safeDecode(url.pathname || '');
      if (/^\/[A-Za-z]:\//.test(filePath)) {
        filePath = filePath.slice(1);
      }
      return convertFileSrc(filePath);
    } catch {
      const fallback = pathOrUrl.replace(/^file:\/\/+/, '');
      return convertFileSrc(safeDecode(fallback));
    }
  }
  const normalized = pathOrUrl.replace(/\\/g, '/');
  if (/^[A-Za-z]:\//.test(normalized)) {
    return convertFileSrc(pathOrUrl);
  }
  if (normalized.startsWith('/')) {
    return convertFileSrc(pathOrUrl);
  }
  return normalized;
}

function normalizeModNameKey(name: string): string {
  return name
    .replace(/\s*[\(\[]\s*(mono|il2cpp)\s*[\)\]]\s*$/i, '')
    .replace(/\s*[_-]\s*(mono|il2cpp)\s*$/i, '')
    .replace(/\s+(mono|il2cpp)\s*$/i, '')
    .trim()
    .toLowerCase();
}

function handleCardActivationKeyDown(
  event: React.KeyboardEvent<HTMLElement>,
  onActivate: () => void
) {
  if (event.target !== event.currentTarget) {
    return;
  }
  if (event.key === 'Enter' || event.key === ' ' || event.key === 'Spacebar') {
    event.preventDefault();
    onActivate();
  }
}

function mergeModSnapshots(previous: ModInfo[], incoming: ModInfo[]): ModInfo[] {
  const nextByKey = new Map<string, ModInfo>();
  for (const mod of incoming) {
    nextByKey.set(`${mod.fileName}::${mod.path}`, mod);
  }

  const merged: ModInfo[] = [];
  for (const existing of previous) {
    const key = `${existing.fileName}::${existing.path}`;
    const updated = nextByKey.get(key);
    if (updated) {
      merged.push(updated);
      nextByKey.delete(key);
    }
  }

  for (const mod of incoming) {
    const key = `${mod.fileName}::${mod.path}`;
    if (nextByKey.has(key)) {
      merged.push(mod);
      nextByKey.delete(key);
    }
  }

  return merged;
}

export function ModsOverlay({ isOpen, onClose, environmentId, onModsChanged, onModUpdatesChecked, onOpenAccounts }: Props) {
  type ModListFilter = 'all' | 'updates' | 'enabled' | 'disabled';

  const [mods, setMods] = useState<ModInfo[]>([]);
  const [downloadedMods, setDownloadedMods] = useState<ModLibraryEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [modsDirectory, setModsDirectory] = useState<string>('');
  const [deletingMod, setDeletingMod] = useState<string | null>(null);
  const [enablingMod, setEnablingMod] = useState<string | null>(null);
  const [disablingMod, setDisablingMod] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [pendingUpload, setPendingUpload] = useState<{ file: null; runtimeMismatch: { detected: 'IL2CPP' | 'Mono' | 'unknown'; environment: 'IL2CPP' | 'Mono'; warning: string } } | null>(null);
  const [pendingRuntimeSelection, setPendingRuntimeSelection] = useState<{ filePath: string; fileName: string; sourceInfo: any } | null>(null);
  const [confirmDialog, setConfirmDialog] = useState<ConfirmDialog | null>(null);
  const [installingDownloaded, setInstallingDownloaded] = useState<string | null>(null);

  // Search state
  const [environment, setEnvironment] = useState<Environment | null>(null);
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [searchResults, setSearchResults] = useState<ThunderstorePackage[]>([]);
  const [searching, setSearching] = useState(false);
  const [installingPackage, setInstallingPackage] = useState<string | null>(null);
  const [showSearchResults, setShowSearchResults] = useState(false);
  const [searchSource, setSearchSource] = useState<'thunderstore' | 'nexusmods'>('thunderstore');

  // NexusMods search state
  const [nexusModsSearchQuery, setNexusModsSearchQuery] = useState<string>('');
  const [nexusModsSearchResults, setNexusModsSearchResults] = useState<NexusMod[]>([]);
  const [searchingNexusMods, setSearchingNexusMods] = useState(false);
  const [installingNexusMod, setInstallingNexusMod] = useState<{ modId: number; fileId: number } | null>(null);
  const [showNexusModsResults, setShowNexusModsResults] = useState(false);
  const [nexusModsFiles, setNexusModsFiles] = useState<Map<number, NexusModFile[]>>(new Map());
  const [showNexusKeyRequiredModal, setShowNexusKeyRequiredModal] = useState(false);
  const [hasNexusDownloadAccess, setHasNexusDownloadAccess] = useState<boolean>(false);

  // Mod updates state
  const [modUpdates, setModUpdates] = useState<Map<string, { updateAvailable: boolean; currentVersion?: string; latestVersion?: string }>>(new Map());
  const [checkingModUpdates, setCheckingModUpdates] = useState(false);
  const [updatingMod, setUpdatingMod] = useState<string | null>(null);
  const [updatingAllMods, setUpdatingAllMods] = useState(false);
  const [showSearchInOverlay, setShowSearchInOverlay] = useState(false);
  const [modListFilter, setModListFilter] = useState<ModListFilter>('all');
  const [activeModView, setActiveModView] = useState<ModViewState | null>(null);
  const suppressWatcherReloadUntilRef = useRef(0);
  const modsReloadTimerRef = useRef<number | null>(null);
  const activeLoadRequestRef = useRef(0);
  const modsScrollContainerRef = useRef<HTMLDivElement | null>(null);
  const modsScrollTopRef = useRef(0);
  const metadataRefreshRunningRef = useRef(false);
  const activeModViewSourceUrl = safeExternalUrl(activeModView?.sourceUrl);

  const libraryVersionCountByName = useMemo(() => {
    const counts = new Map<string, number>();
    for (const entry of downloadedMods) {
      const key = normalizeModNameKey(entry.displayName || '');
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    return counts;
  }, [downloadedMods]);

  const loadEnvironment = async () => {
    try {
      const env = await ApiService.getEnvironment(environmentId);
      setEnvironment(env);
    } catch (err) {
      console.error('Failed to load environment:', err);
    }
  };

  const refreshNexusDownloadAccess = async () => {
    try {
      const hasKey = await ApiService.hasNexusModsApiKey();
      setHasNexusDownloadAccess(hasKey);
    } catch {
      setHasNexusDownloadAccess(false);
    }
  };

  const loadInstalledMods = async (showSpinner: boolean = true, refresh: boolean = false) => {
    const requestId = ++activeLoadRequestRef.current;
    if (showSpinner) {
      setLoading(true);
      setError(null);
    }

    try {
      const result = await ApiService.getMods(environmentId, refresh);
      if (requestId !== activeLoadRequestRef.current) {
        return;
      }

      const normalizedMods = result.mods.map(mod => ({
        ...mod,
        source: mod.source as ModInfo['source'],
      }));
      setMods(previous => mergeModSnapshots(previous, normalizedMods));
      setModsDirectory(result.modsDirectory);
    } catch (err) {
      if (requestId !== activeLoadRequestRef.current) {
        return;
      }

      if (showSpinner) {
        setError(err instanceof Error ? err.message : 'Failed to load mods');
      } else {
        console.warn('Failed to refresh installed mods:', err);
      }
    } finally {
      if (showSpinner && requestId === activeLoadRequestRef.current) {
        setLoading(false);
      }
    }
  };

  const loadDownloadedLibrary = async () => {
    try {
      const library = await ApiService.getModLibrary();
      setDownloadedMods(library.downloaded || []);
    } catch (err) {
      console.warn('Failed to load downloaded mod library:', err);
    }
  };

  const loadCachedModUpdates = async () => {
    try {
      const summary = await ApiService.getModUpdatesSummary(environmentId);
      const updatesMap = new Map<string, { updateAvailable: boolean; currentVersion?: string; latestVersion?: string }>();
      for (const update of summary.updates || []) {
        updatesMap.set(update.modFileName, {
          updateAvailable: true,
          currentVersion: update.currentVersion,
          latestVersion: update.latestVersion,
        });
      }
      setModUpdates(updatesMap);
      onModUpdatesChecked?.(summary.count || updatesMap.size);
    } catch (err) {
      console.warn('Failed to load cached mod update summary:', err);
    }
  };

  const loadModsPanelData = async () => {
    await loadInstalledMods(true, false);
    await loadDownloadedLibrary();
    void loadCachedModUpdates();
  };

  useEffect(() => {
    if (isOpen && environmentId) {
      void loadEnvironment();
      void loadModsPanelData();
      void refreshNexusDownloadAccess();

      // Listen for filesystem changes
      let unlistenModsChanged: (() => void) | null = null;
      let unlistenModsSnapshot: (() => void) | null = null;

      const scheduleInstalledModsRefresh = () => {
        if (modsReloadTimerRef.current) {
          window.clearTimeout(modsReloadTimerRef.current);
        }

        modsReloadTimerRef.current = window.setTimeout(() => {
          modsReloadTimerRef.current = null;
          if (Date.now() < suppressWatcherReloadUntilRef.current) {
            return;
          }
          void loadInstalledMods(false, true);
          void loadCachedModUpdates();
          onModsChanged?.();
        }, 350);
      };

      const setupListener = async () => {
        try {
          unlistenModsChanged = await onModsChangedEvent((data) => {
            if (data.environmentId === environmentId) {
              scheduleInstalledModsRefresh();
            }
          });

          unlistenModsSnapshot = await onModsSnapshotUpdated((data) => {
            if (data.environmentId !== environmentId || !data.snapshot) {
              return;
            }

            const normalizedMods = (data.snapshot.mods || []).map(mod => ({
              ...mod,
              source: mod.source as ModInfo['source'],
            }));

            setMods(previous => mergeModSnapshots(previous, normalizedMods));
            setModsDirectory(data.snapshot.modsDirectory || '');
          });
        } catch (error) {
          console.error('Failed to set up mods changed listener:', error);
        }
      };

      void setupListener();

      return () => {
        activeLoadRequestRef.current += 1;
        if (modsReloadTimerRef.current) {
          window.clearTimeout(modsReloadTimerRef.current);
          modsReloadTimerRef.current = null;
        }
        if (unlistenModsChanged) unlistenModsChanged();
        if (unlistenModsSnapshot) unlistenModsSnapshot();
      };
    }

    activeLoadRequestRef.current += 1;
    if (modsReloadTimerRef.current) {
      window.clearTimeout(modsReloadTimerRef.current);
      modsReloadTimerRef.current = null;
    }

    // Reset state when closing
    setMods([]);
    setError(null);
    setModsDirectory('');
    setEnvironment(null);
    setSearchQuery('');
    setSearchResults([]);
    setShowSearchResults(false);
    setSearchSource('thunderstore');
    setNexusModsSearchQuery('');
    setNexusModsSearchResults([]);
    setShowNexusModsResults(false);
    setNexusModsFiles(new Map());
    setModUpdates(new Map());
    setUpdatingAllMods(false);
    setShowSearchInOverlay(false);
    setModListFilter('all');
    setConfirmDialog(null);
    setPendingRuntimeSelection(null);
    setPendingUpload(null);
    setDownloadedMods([]);
    setActiveModView(null);
  }, [isOpen, environmentId]);

  useEffect(() => {
    if (!isOpen || !environmentId) {
      return;
    }

    let disposed = false;
    let unlisten: (() => void) | null = null;
    void onModMetadataRefreshStatus((data) => {
      const running = Boolean(data.running) || (data.activeCount || 0) > 0;
      const wasRunning = metadataRefreshRunningRef.current;
      metadataRefreshRunningRef.current = running;

      if (wasRunning && !running) {
        void loadDownloadedLibrary();
        void loadInstalledMods(false, true);
      }
    }).then((fn) => {
      if (disposed) {
        fn();
        return;
      }
      unlisten = fn;
    });

    return () => {
      disposed = true;
      unlisten?.();
      metadataRefreshRunningRef.current = false;
    };
  }, [isOpen, environmentId]);

  const openModView = (nextView: ModViewState) => {
    if (modsScrollContainerRef.current) {
      modsScrollTopRef.current = modsScrollContainerRef.current.scrollTop;
    }
    setActiveModView(nextView);
  };

  const closeModView = () => {
    setActiveModView(null);
    window.requestAnimationFrame(() => {
      if (modsScrollContainerRef.current) {
        modsScrollContainerRef.current.scrollTop = modsScrollTopRef.current;
      }
    });
  };

  // Refresh library when notified (e.g. after download in another view) or when opening
  useEffect(() => {
    if (!isOpen || !environmentId) return;
    const handler = () => void loadDownloadedLibrary();
    window.addEventListener('library-updated', handler);
    // Check if library was updated while we were away (e.g. user downloaded in Library then switched here)
    if (sessionStorage.getItem('library-needs-refresh') === '1') {
      sessionStorage.removeItem('library-needs-refresh');
      void loadDownloadedLibrary();
    }
    return () => window.removeEventListener('library-updated', handler);
  }, [isOpen, environmentId]);

  // Auto-load files for NexusMods search results
  useEffect(() => {
    if (showNexusModsResults && nexusModsSearchResults.length > 0) {
      nexusModsSearchResults.forEach((mod) => {
        if (!nexusModsFiles.has(mod.mod_id)) {
          handleLoadNexusModFiles(mod.mod_id);
        }
      });
    }
  }, [showNexusModsResults, nexusModsSearchResults]);

  const checkModUpdates = async (showErrors: boolean = false) => {
    try {
      const updates = await ApiService.checkModUpdates(environmentId);
      const updatesMap = new Map<string, { updateAvailable: boolean; currentVersion?: string; latestVersion?: string }>();
      updates.forEach(update => {
        updatesMap.set(update.modFileName, {
          updateAvailable: update.updateAvailable,
          currentVersion: update.currentVersion,
          latestVersion: update.latestVersion
        });
      });
      setModUpdates(updatesMap);
      const count = Array.from(updatesMap.values()).filter(u => u.updateAvailable).length;
      onModUpdatesChecked?.(count);
    } catch (updateErr) {
      if (showErrors) {
        throw updateErr; // Re-throw if called manually so we can show error
      } else {
        // Fail silently - updates are nice to have but not critical
        console.warn('Failed to check mod updates:', updateErr);
      }
    }
  };

  const handleCheckModUpdates = async () => {
    setCheckingModUpdates(true);
    setError(null);
    try {
      await checkModUpdates(true); // Show errors when manually triggered
      await loadInstalledMods(false, true);
      await loadDownloadedLibrary();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to check for mod updates');
    } finally {
      setCheckingModUpdates(false);
    }
  };

  const handleDeleteMod = async (mod: ModInfo) => {
    setDeletingMod(mod.fileName);
    try {
      await ApiService.deleteMod(environmentId, mod.fileName);
      // Reload mods list after deletion
      await loadInstalledMods(false, true);
      await loadDownloadedLibrary();
      await loadCachedModUpdates();
      // Notify parent that mods changed (so it can refresh the count)
      if (onModsChanged) {
        onModsChanged();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete mod');
    } finally {
      setDeletingMod(null);
    }
  };

  const handleUpdateMod = async (mod: ModInfo) => {
    setUpdatingMod(mod.fileName);
    setError(null);
    try {
      const result = await ApiService.updateMod(environmentId, mod.fileName);
      if (!result.success) {
        throw new Error(result.error || result.message || 'Failed to update mod');
      }

      await loadInstalledMods(false, true);
      await loadDownloadedLibrary();
      await loadCachedModUpdates();
      if (onModsChanged) {
        onModsChanged();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update mod');
    } finally {
      setUpdatingMod(null);
    }
  };

  const handleUpdateAllMods = async () => {
    const updatableMods = mods.filter((mod) => {
      const updateInfo = modUpdates.get(mod.fileName);
      const canAutoUpdate = mod.source === 'thunderstore' || mod.source === 'nexusmods' || mod.source === 'github';
      return !!updateInfo?.updateAvailable && canAutoUpdate;
    });

    if (updatableMods.length === 0) {
      setError('No supported mod updates are currently available');
      return;
    }

    setUpdatingAllMods(true);
    setError(null);

    const failed: string[] = [];
    for (const mod of updatableMods) {
      setUpdatingMod(mod.fileName);
      try {
        const result = await ApiService.updateMod(environmentId, mod.fileName);
        if (!result.success) {
          failed.push(mod.name);
        }
      } catch {
        failed.push(mod.name);
      }
    }

    setUpdatingMod(null);
    setUpdatingAllMods(false);

    await loadInstalledMods(false, true);
    await loadDownloadedLibrary();
    await loadCachedModUpdates();
    if (onModsChanged) {
      onModsChanged();
    }

    if (failed.length > 0) {
      setError(`Updated ${updatableMods.length - failed.length}/${updatableMods.length} mods. Failed: ${failed.join(', ')}`);
    }
  };

  const requestDeleteMod = (mod: ModInfo) => {
    const dialog: ConfirmDialog = {
      title: 'Delete Mod',
      message: `Are you sure you want to delete "${mod.name}"?`,
      confirmText: 'Delete',
      cancelText: 'Cancel',
      onConfirm: () => handleDeleteMod(mod),
      readyAt: Date.now() + 200,
    };

    window.setTimeout(() => {
      setConfirmDialog(dialog);
    }, 0);
  };

  const handleDisableMod = async (mod: ModInfo) => {
    setDisablingMod(mod.fileName);
    try {
      suppressWatcherReloadUntilRef.current = Date.now() + 1500;
      await ApiService.disableMod(environmentId, mod.fileName);
      // Update the specific mod in-place to avoid a full list reload flash
      setMods(prev => prev.map(m => m.fileName === mod.fileName ? { ...m, disabled: true } : m));
      if (onModsChanged) {
        onModsChanged();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to disable mod');
    } finally {
      setDisablingMod(null);
    }
  };

  const handleEnableMod = async (mod: ModInfo) => {
    setEnablingMod(mod.fileName);
    try {
      suppressWatcherReloadUntilRef.current = Date.now() + 1500;
      await ApiService.enableMod(environmentId, mod.fileName);
      // Update the specific mod in-place to avoid a full list reload flash
      setMods(prev => prev.map(m => m.fileName === mod.fileName ? { ...m, disabled: false } : m));
      if (onModsChanged) {
        onModsChanged();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to enable mod');
    } finally {
      setEnablingMod(null);
    }
  };

  const handleOpenFolder = async () => {
    try {
      await ApiService.openModsFolder(environmentId);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to open mods folder');
    }
  };

  const handleInstallDownloaded = async (entry: ModLibraryEntry) => {
    const runtime = environment?.runtime;
    const storageId = runtime
      ? entry.storageIdsByRuntime?.[runtime] || entry.storageId
      : entry.storageId;

    if (!storageId) {
      setError('No compatible storage entry found for this runtime');
      return;
    }

    setInstallingDownloaded(storageId);
    try {
      await ApiService.installDownloadedMod(storageId, [environmentId]);
      await loadInstalledMods(false, true);
      await loadDownloadedLibrary();
      await loadCachedModUpdates();
      if (onModsChanged) {
        onModsChanged();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to install downloaded mod');
    } finally {
      setInstallingDownloaded(null);
    }
  };

  const handleConfirmDialog = () => {
    if (!confirmDialog) return;
    if (confirmDialog.readyAt && Date.now() < confirmDialog.readyAt) {
      return;
    }
    const action = confirmDialog.onConfirm;
    setConfirmDialog(null);
    Promise.resolve(action()).catch((err) => {
      console.error('Confirm action failed:', err);
      setError(err instanceof Error ? err.message : 'Action failed');
    });
  };

  const extractModNameFromFileName = (fileName: string): string => {
    // Remove file extensions
    let modName = fileName.replace(/\.(dll|zip|rar)$/i, '');

    // Remove common version patterns (e.g., "ModName-1.2.3", "ModName_v1.0", "ModName 2.0")
    modName = modName.replace(/[-_ ]?v?\d+\.\d+(\.\d+)?([-_ ].*)?$/i, '');
    modName = modName.replace(/[-_ ]?\d+\.\d+\.\d+.*$/i, '');

    // Remove common suffixes like "-IL2CPP", "-Mono", etc.
    modName = modName.replace(/[-_ ]?(il2cpp|mono|beta|alpha|release).*$/i, '');

    // Remove numeric IDs at the start (e.g., "12345-ModName")
    modName = modName.replace(/^\d+-/, '');

    // Trim and clean up
    modName = modName.trim().replace(/[-_]+/g, ' ').trim();

    return modName || fileName.replace(/\.(dll|zip|rar)$/i, '');
  };

  const fuzzyMatchModName = (searchName: string, modName: string): number => {
    // Simple fuzzy matching score (0-1)
    const searchLower = searchName.toLowerCase().trim();
    const modLower = modName.toLowerCase().trim();

    // Exact match
    if (modLower === searchLower) return 1.0;

    // Contains match
    if (modLower.includes(searchLower) || searchLower.includes(modLower)) {
      return 0.8;
    }

    // Word-based matching
    const searchWords = searchLower.split(/\s+/);
    const modWords = modLower.split(/\s+/);
    let matchedWords = 0;

    for (const searchWord of searchWords) {
      if (modWords.some(modWord => modWord.includes(searchWord) || searchWord.includes(modWord))) {
        matchedWords++;
      }
    }

    if (matchedWords > 0) {
      return matchedWords / Math.max(searchWords.length, modWords.length) * 0.6;
    }

    return 0;
  };

  const detectModSource = async (fileName: string): Promise<{
    source: 'thunderstore' | 'nexusmods' | 'github' | 'local' | 'unknown';
    sourceUrl?: string;
    modName?: string;
    author?: string;
    sourceId?: string;
    sourceVersion?: string;
  }> => {
    const fileNameLower = fileName.toLowerCase();

    // Check for Thunderstore indicators
    // Thunderstore mods often have specific naming patterns or contain manifest.json
    if (fileNameLower.includes('thunderstore') ||
        fileNameLower.includes('thunder') ||
        fileNameLower.match(/^[a-z0-9_-]+-[a-z0-9_-]+-\d+\.\d+\.\d+\.zip$/i)) {
      // Try to extract mod info from filename (format: modname-version.zip)
      const match = fileName.match(/^(.+?)-(\d+\.\d+\.\d+)/);
      if (match) {
        return {
          source: 'thunderstore',
          modName: match[1],
          sourceVersion: match[2],
  };
}
      return { source: 'thunderstore' };
    }

    // Check for Nexus Mods indicators
    // Nexus mods often have numeric IDs in filename or specific patterns
    if (fileNameLower.includes('nexus') ||
        fileNameLower.match(/^\d+-\d+/) || // Pattern like "12345-67890" (modId-fileId)
        fileNameLower.includes('nexusmods')) {
      // Try to extract mod ID from filename
      const match = fileName.match(/(\d+)-(\d+)/);
      if (match) {
        return {
          source: 'nexusmods',
          sourceId: match[1],
          sourceUrl: `https://www.nexusmods.com/schedule1/mods/${match[1]}`,
        };
      }
      return { source: 'nexusmods' };
    }

    // If not clearly Thunderstore or Nexus, try searching Nexus Mods
    // Extract a clean mod name from the filename
    const cleanModName = extractModNameFromFileName(fileName);

    // Only search if we have a reasonable mod name (at least 3 characters)
    if (cleanModName.length >= 3) {
      try {
        // Search Nexus Mods for this mod name (search works without login)
        const searchResults = await ApiService.searchNexusMods('schedule1', cleanModName);

        if (searchResults.mods && searchResults.mods.length > 0) {
          // Find the best matching mod using fuzzy matching
          let bestMatch: NexusMod | null = null;
          let bestScore = 0;

          for (const mod of searchResults.mods) {
            const score = fuzzyMatchModName(cleanModName, mod.name);
            if (score > bestScore && score >= 0.6) { // Require at least 60% match
              bestScore = score;
              bestMatch = mod;
            }
          }

          if (bestMatch) {
            return {
              source: 'nexusmods',
              sourceId: bestMatch.mod_id.toString(),
              sourceUrl: `https://www.nexusmods.com/schedule1/mods/${bestMatch.mod_id}`,
              modName: bestMatch.name,
              author: bestMatch.author,
              sourceVersion: bestMatch.version,
            };
          }
        }
      } catch (err) {
        // If search fails, silently fall through to unknown
        console.warn('Failed to search Nexus Mods for mod:', cleanModName, err);
      }
    }

    // Default to unknown for manual uploads
    return { source: 'unknown' };
  };

  const handleUploadClick = async () => {
    if (!environment) {
      setError('Environment not loaded');
      return;
    }

    setUploading(true);
    setError(null);

    try {
      // Use Tauri dialog to select file
      const selected = await open({
        multiple: false,
        filters: [{
          name: 'Mod Files',
          extensions: ['dll', 'zip', 'rar']
        }],
        title: 'Select Mod File',
      }) as string | { path: string; name?: string } | null;

      if (!selected) {
        // User cancelled
        setUploading(false);
        return;
      }

      // Handle both string path and FileEntry object
      let filePath: string;
      let fileName: string;

      if (typeof selected === 'string') {
        filePath = selected;
        fileName = selected.split(/[/\\]/).pop() || 'unknown';
      } else {
        filePath = selected.path;
        fileName = selected.name || filePath.split(/[/\\]/).pop() || 'unknown';
      }

      // Detect source
      const sourceInfo = await detectModSource(fileName);

      // Detect runtime from filename
      const detectedRuntime = detectRuntimeFromFileName(fileName);

      if (!detectedRuntime) {
        // Couldn't detect runtime - ask user to select
        setPendingRuntimeSelection({ filePath, fileName, sourceInfo });
        setUploading(false);
        return;
      }

      // Proceed with upload using detected runtime
      await performUpload(filePath, fileName, detectedRuntime, sourceInfo);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to upload mod');
      setUploading(false);
    }
  };

  const detectRuntimeFromFileName = (fileName: string): 'IL2CPP' | 'Mono' | null => {
    const lower = fileName.toLowerCase();
    if (lower.includes('mono')) return 'Mono';
    if (lower.includes('il2cpp')) return 'IL2CPP';
    return null;
  };

  const performUpload = async (filePath: string, fileName: string, runtime: 'IL2CPP' | 'Mono', sourceInfo: any) => {
    setUploading(true);
    setError(null);

    try {
      // Include detected runtime in metadata so backend knows
      const metadataWithRuntime = {
        ...sourceInfo,
        detectedRuntime: runtime,
      };

      // Call upload with file path and metadata
      const result = await ApiService.uploadMod(
        environmentId,
        filePath,
        fileName,
        environment!.runtime,
        metadataWithRuntime
      );

      if (result.success) {
        // Check for runtime mismatch
        if (result.runtimeMismatch && result.runtimeMismatch.requiresConfirmation) {
          // Store the mismatch info to show confirmation dialog
          setPendingUpload({
            file: null as any, // Not needed anymore since we use file path
            runtimeMismatch: result.runtimeMismatch
          });
        } else {
          // No mismatch - proceed with success handling
          await handleUploadSuccess();
        }
      } else {
        setError(result.error || 'Failed to upload mod');
        setUploading(false);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to upload mod');
      setUploading(false);
    }
  };

  const handleRuntimeSelectionConfirm = async (selectedRuntime: 'IL2CPP' | 'Mono') => {
    if (!pendingRuntimeSelection) return;
    const { filePath, fileName, sourceInfo } = pendingRuntimeSelection;
    setPendingRuntimeSelection(null);
    await performUpload(filePath, fileName, selectedRuntime, sourceInfo);
  };

  const handleRuntimeSelectionCancel = () => {
    setPendingRuntimeSelection(null);
    setUploading(false);
  };

  const handleUploadSuccess = async () => {
    // Reload mods list after successful upload
    await loadInstalledMods(false, true);
    await loadDownloadedLibrary();
    await loadCachedModUpdates();
    // Notify parent that mods changed
    if (onModsChanged) {
      onModsChanged();
    }
    setUploading(false);
    setPendingUpload(null);
  };

  const handleRuntimeMismatchConfirm = async () => {
    // Mod is already installed, just acknowledge and continue
    setPendingUpload(null);
    await handleUploadSuccess();
  };

  const handleRuntimeMismatchCancel = () => {
    // Mod is already installed, but user canceled acknowledgment
    // Still reload mods since it was installed
    setPendingUpload(null);
    handleUploadSuccess();
  };

  // Filter mods to ensure they are for Schedule I, match the runtime, and match the search query
  const filterModsForScheduleI = (
    packages: ThunderstorePackage[],
    runtime: 'IL2CPP' | 'Mono',
    searchQuery: string
  ): ThunderstorePackage[] => {
    const runtimeLower = runtime.toLowerCase();
    const otherRuntime = runtimeLower === 'il2cpp' ? 'mono' : 'il2cpp';
    const searchLower = searchQuery.toLowerCase().trim();

    return packages.filter((pkg) => {
      // 1. Check if it's for Schedule I - verify package URL contains schedule-i
      // Since we're using the Schedule I endpoint, all results should be for Schedule I,
      // but we verify this client-side as requested
      const packageUrl = (pkg.package_url || '').toLowerCase();
      const isScheduleI =
        packageUrl.includes('schedule-i') ||
        packageUrl.includes('c/schedule-i') ||
        packageUrl.includes('/schedule-i/');

      if (!isScheduleI) {
        // If no URL available, we can't verify, so exclude to be safe
        // (though in practice, if the API endpoint is correct, all results should have the URL)
        return false;
      }

      // 2. Check runtime compatibility
      const name = (pkg.name || '').toLowerCase();
      const fullName = (pkg.full_name || '').toLowerCase();
      const categories = (pkg.categories || []).map(c => c.toLowerCase());

      // Check categories for runtime tags
      const hasTargetRuntimeCategory = categories.some(c => c === runtimeLower);
      const hasOtherRuntimeCategory = categories.some(c => c === otherRuntime);

      // If it has the target runtime category, include it (even if it also has the other)
      if (hasTargetRuntimeCategory) {
        // Package supports this runtime, continue to search query check
      } else if (hasOtherRuntimeCategory) {
        // Has only the other runtime category, exclude
        return false;
      }

      // For name-based checking (when no categories match)
      // Check if explicitly mentions the other runtime in name (exclude)
      const mentionsOtherRuntimeInName =
        name.includes(otherRuntime) ||
        fullName.includes(otherRuntime);

      if (mentionsOtherRuntimeInName && !hasTargetRuntimeCategory) {
        return false;
      }

      // Check if it mentions the target runtime in name or has no runtime specified (assume compatible)
      const mentionsTargetRuntime =
        name.includes(runtimeLower) ||
        fullName.includes(runtimeLower) ||
        hasTargetRuntimeCategory;

      const noRuntimeSpecified =
        !name.includes('il2cpp') &&
        !name.includes('mono') &&
        !fullName.includes('il2cpp') &&
        !fullName.includes('mono') &&
        !categories.some(c => c.includes('il2cpp') || c.includes('mono'));

      // Must either mention target runtime or have no runtime specified
      if (!mentionsTargetRuntime && !noRuntimeSpecified) {
        return false;
      }

      // 3. Check if it matches the search query
      if (searchLower) {
        const matchesSearch =
          name.includes(searchLower) ||
          fullName.includes(searchLower) ||
          (pkg.versions?.[0]?.description || '').toLowerCase().includes(searchLower) ||
          (pkg.owner || '').toLowerCase().includes(searchLower);

        if (!matchesSearch) {
          return false;
        }
      }

      return true;
    });
  };

  const handleSearch = async () => {
    if (!searchQuery.trim() || !environment) {
      return;
    }

    // Use hardcoded game ID for Schedule I
    const gameId = 'schedule-i';

    setSearching(true);
    setError(null);
    setShowSearchResults(false);
    try {
      const result = await ApiService.searchThunderstore(
        gameId,
        searchQuery.trim(),
        environment.runtime
      );

      // Apply client-side filtering to ensure only Schedule I mods for the correct runtime are shown
      const filteredResults = filterModsForScheduleI(
        result.packages || [],
        environment.runtime,
        searchQuery.trim()
      );

      setSearchResults(filteredResults);
      setShowSearchResults(true);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Failed to search Thunderstore';
      setError(errorMessage);
      setSearchResults([]);
      setShowSearchResults(false);
      console.error('Error searching Thunderstore:', err);
    } finally {
      setSearching(false);
    }
  };

  const handleInstallThunderstoreMod = async (pkg: ThunderstorePackage) => {
    if (!environment) return;

    setInstallingPackage(pkg.uuid4);
    setError(null);
    try {
      console.log(`Installing Thunderstore mod: ${pkg.name} (${pkg.uuid4})`);
      const result = await ApiService.installThunderstoreMod(environmentId, pkg.uuid4);

      if (result.success) {
        // Check for runtime mismatch
        if (result.runtimeMismatch && result.runtimeMismatch.requiresConfirmation) {
          setConfirmDialog({
            title: 'Runtime Mismatch Warning',
            message: result.runtimeMismatch.warning,
            confirmText: 'Continue Anyway',
            cancelText: 'Cancel',
            onConfirm: async () => {
              console.log(`Successfully installed mod: ${pkg.name}`);

              // Reload mods after installation
              await loadInstalledMods(false, true);
              await loadDownloadedLibrary();
              await loadCachedModUpdates();
              if (onModsChanged) {
                onModsChanged();
              }

              // Close search results
              setShowSearchResults(false);
              setSearchQuery('');
            }
          });
          return;
        }

        console.log(`Successfully installed mod: ${pkg.name}`);

        // Reload mods after installation
        await loadInstalledMods(false, true);
        await loadDownloadedLibrary();
        await loadCachedModUpdates();
        if (onModsChanged) {
          onModsChanged();
        }

        // Close search results
        setShowSearchResults(false);
        setSearchQuery('');
      } else {
        const errorMsg = result.error || 'Failed to install mod';
        console.error(`Failed to install mod ${pkg.name}:`, errorMsg);
        setError(errorMsg);
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : 'Failed to install mod';
      console.error(`Error installing mod ${pkg.name}:`, err);
      setError(errorMsg);
    } finally {
      setInstallingPackage(null);
    }
  };

  const handleSearchKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      if (searchSource === 'thunderstore') {
        handleSearch();
      } else {
        handleSearchNexusMods();
      }
    }
  };

  const handleSearchNexusMods = async () => {
    if (!nexusModsSearchQuery.trim() || !environment) {
      return;
    }

    const gameId = 'schedule1';
    await refreshNexusDownloadAccess();

    setSearchingNexusMods(true);
    setError(null);
    setShowNexusModsResults(false);
    try {
      const result = await ApiService.searchNexusMods(
        gameId,
        nexusModsSearchQuery.trim()
      );

      setNexusModsSearchResults(result.mods || []);
      setShowNexusModsResults(true);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Failed to search NexusMods';
      setError(errorMessage);
      setNexusModsSearchResults([]);
      setShowNexusModsResults(false);
      console.error('Error searching NexusMods:', err);
    } finally {
      setSearchingNexusMods(false);
    }
  };

  const handleLoadNexusModFiles = async (modId: number) => {
    if (nexusModsFiles.has(modId)) {
      return; // Already loaded
    }

    try {
      const files = await ApiService.getNexusModsModFiles('schedule1', modId);
      setNexusModsFiles(prev => new Map(prev).set(modId, files));
    } catch (err) {
      console.error('Failed to load NexusMods mod files:', err);
    }
  };

  const handleInstallNexusModsMod = async (modId: number, fileId?: number) => {
    if (!environment) return;

    const hasKey = await ApiService.hasNexusModsApiKey();
    setHasNexusDownloadAccess(hasKey);
    if (!hasKey) {
      setShowNexusKeyRequiredModal(true);
      return;
    }

    // Load files if not already loaded
    if (!nexusModsFiles.has(modId)) {
      await handleLoadNexusModFiles(modId);
    }

    const files = nexusModsFiles.get(modId) || [];

    // Filter files by runtime type if fileId not specified
    // NexusMods uses separate files for IL2CPP and Mono, so we filter by file name
    let targetFile;
    if (fileId) {
      targetFile = files.find((f: any) => f.file_id === fileId);
    } else {
      // Filter files by runtime type based on file name
      const runtimeLower = environment.runtime.toLowerCase();
      const otherRuntime = runtimeLower === 'il2cpp' ? 'mono' : 'il2cpp';

      // First, try to find files that match the current runtime
      const runtimeFiles = files.filter((f: any) => {
        const fileName = (f.file_name || f.name || '').toLowerCase();
        return fileName.includes(runtimeLower);
      });

      if (runtimeFiles.length > 0) {
        // Prefer primary file if it matches runtime, otherwise use first match
        targetFile = runtimeFiles.find((f: any) => f.is_primary) || runtimeFiles[0];
      } else {
        // No exact runtime match, exclude files that explicitly mention the other runtime
        const compatibleFiles = files.filter((f: any) => {
          const fileName = (f.file_name || f.name || '').toLowerCase();
          return !fileName.includes(otherRuntime);
        });
        targetFile = compatibleFiles.find((f: any) => f.is_primary) || compatibleFiles[0] || files[0];
      }
    }

    if (!targetFile) {
      setError('No file available to install for your runtime type');
      return;
    }

    setInstallingNexusMod({ modId, fileId: targetFile.file_id });
    setError(null);
    try {
      console.log(`Installing NexusMods mod: ${modId} file: ${targetFile.file_id}`);
      const result = await ApiService.installNexusModsMod(environmentId, modId, targetFile.file_id);

      if (result.success) {
        // Check for runtime mismatch
        if (result.runtimeMismatch && result.runtimeMismatch.requiresConfirmation) {
          setConfirmDialog({
            title: 'Runtime Mismatch Warning',
            message: result.runtimeMismatch.warning,
            confirmText: 'Continue Anyway',
            cancelText: 'Cancel',
            onConfirm: async () => {
              console.log(`Successfully installed mod: ${modId}`);

              // Reload mods after installation
              await loadInstalledMods(false, true);
              await loadDownloadedLibrary();
              await loadCachedModUpdates();
              if (onModsChanged) {
                onModsChanged();
              }

              // Close search results
              setShowNexusModsResults(false);
              setNexusModsSearchQuery('');
            }
          });
          return;
        }

        console.log(`Successfully installed mod: ${modId}`);

        // Reload mods after installation
        await loadInstalledMods(false, true);
        await loadDownloadedLibrary();
        await loadCachedModUpdates();
        if (onModsChanged) {
          onModsChanged();
        }

        // Close search results
        setShowNexusModsResults(false);
        setNexusModsSearchQuery('');
      } else {
        const errorMsg = result.error || 'Failed to install mod';
        console.error(`Failed to install mod ${modId}:`, errorMsg);
        setError(errorMsg);
      }
    } catch (err) {
      // Log the full error object to see its structure
      console.error(`Error installing mod ${modId} - Full error object:`, err);
      console.error(`Error type:`, typeof err);
      console.error(`Error keys:`, err ? Object.keys(err) : 'null');

      const errorMsg = err instanceof Error ? err.message : (typeof err === 'string' ? err : 'Failed to install mod');
      console.error(`Extracted error message:`, errorMsg);
      setError(errorMsg);
    } finally {
      setInstallingNexusMod(null);
    }
  };

  const getSourceLabel = (source?: string): string => {
    switch (source) {
      case 'thunderstore':
        return 'ThunderStore';
      case 'nexusmods':
        return 'NexusMods';
      case 'github':
        return 'GitHub';
      case 'local':
        return 'Local';
      default:
        return 'Unknown';
    }
  };

  const getSourceColor = (source?: string): string => {
    switch (source) {
      case 'thunderstore':
        return '#7c3aed'; // Purple
      case 'nexusmods':
        return '#ea4335'; // Red
      case 'github':
        return '#2ea44f'; // Green
      case 'local':
        return '#34a853'; // Green
      default:
        return '#888';
    }
  };

  if (!isOpen) return null;

  const envRuntime = environment?.runtime;
  const downloadedNotInstalled = downloadedMods.filter(entry => {
    const installedIn = envRuntime ? entry.installedInByRuntime?.[envRuntime] || entry.installedIn : entry.installedIn;
    if (installedIn?.includes(environmentId)) return false;
    // Exclude mods that have declared runtimes but none match the current environment runtime
    if (envRuntime) {
      const runtimeMatch = envRuntime.toUpperCase();
      const hasMatchingRuntime = (entry.availableRuntimes?.length ?? 0) > 0
        ? entry.availableRuntimes.some(r => (r ?? '').toUpperCase() === runtimeMatch)
        : false;
      // Fallback: if we have storage for this runtime, include (handles backend inconsistency / key casing)
      const hasStorageForRuntime = !!entry.storageIdsByRuntime?.[envRuntime]
        || Object.entries(entry.storageIdsByRuntime || {}).some(([k]) => k.toUpperCase() === runtimeMatch);
      if (!hasMatchingRuntime && !hasStorageForRuntime && (entry.availableRuntimes?.length ?? 0) > 0) {
        return false;
      }
    }
    return true;
  });
  const totalUpdatesAvailable = mods.filter((mod) => {
    const updateInfo = modUpdates.get(mod.fileName);
    const canAutoUpdate = mod.source === 'thunderstore' || mod.source === 'nexusmods' || mod.source === 'github';
    return !!updateInfo?.updateAvailable && canAutoUpdate;
  }).length;

  const filteredMods = mods.filter((mod) => {
    const updateAvailable = !!modUpdates.get(mod.fileName)?.updateAvailable;
    switch (modListFilter) {
      case 'updates':
        return updateAvailable;
      case 'enabled':
        return !mod.disabled;
      case 'disabled':
        return !!mod.disabled;
      default:
        return true;
    }
  });

  const openInstalledModView = (mod: ModInfo) => {
    const update = modUpdates.get(mod.fileName);
    openModView({
      id: `${mod.fileName}-${mod.path}`,
      name: mod.name,
      source: mod.source || 'unknown',
      summary: mod.summary,
      iconUrl: mod.iconUrl,
      iconCachePath: mod.iconCachePath,
      sourceUrl: mod.sourceUrl,
      downloads: mod.downloads,
      likesOrEndorsements: mod.likesOrEndorsements,
      updatedAt: mod.updatedAt,
      tags: mod.tags,
      installedVersion: mod.version,
      latestVersion: update?.latestVersion,
      installedAt: mod.installedAt,
      kind: 'installed',
    });
  };

  const openLibraryModView = (entry: ModLibraryEntry) => {
    openModView({
      id: entry.storageId,
      name: entry.displayName,
      source: entry.source || 'unknown',
      summary: entry.summary,
      iconUrl: entry.iconUrl,
      iconCachePath: entry.iconCachePath,
      sourceUrl: entry.sourceUrl,
      downloads: entry.downloads,
      likesOrEndorsements: entry.likesOrEndorsements,
      updatedAt: entry.updatedAt,
      tags: entry.tags,
      installedVersion: entry.installedVersion || entry.sourceVersion,
      installedAt: entry.installedAt,
      kind: 'library',
    });
  };

  const openThunderstoreModView = (pkg: ThunderstorePackage) => {
    const latestVersion = pkg.versions?.[0];
    openModView({
      id: pkg.uuid4,
      name: pkg.name || pkg.full_name,
      source: 'thunderstore',
      summary: latestVersion?.description,
      iconUrl: latestVersion?.icon || pkg.icon || pkg.icon_url,
      sourceUrl: pkg.package_url,
      author: pkg.owner,
      downloads: Array.isArray(pkg.versions)
        ? pkg.versions.reduce((sum, version) => sum + (version.downloads || 0), 0)
        : 0,
      likesOrEndorsements: pkg.rating_score,
      updatedAt: pkg.date_updated,
      tags: pkg.categories,
      installedVersion: latestVersion?.version_number,
      kind: 'thunderstore',
    });
  };

  const openNexusModView = (mod: NexusMod) => {
    openModView({
      id: `nexus-${mod.mod_id}`,
      name: mod.name,
      source: 'nexusmods',
      summary: mod.summary,
      iconUrl: mod.picture_url,
      sourceUrl: `https://www.nexusmods.com/schedule1/mods/${mod.mod_id}`,
      author: mod.author,
      downloads: mod.mod_downloads,
      likesOrEndorsements: mod.endorsement_count,
      updatedAt: mod.updated_time,
      installedVersion: mod.version,
      kind: 'nexusmods',
    });
  };

  const renderCardIcon = (name: string, iconCachePath?: string, iconUrl?: string, variant: 'inline' | 'rail' = 'inline') => {
    const local = resolveImageSource(iconCachePath);
    const remote = resolveImageSource(iconUrl);
    const source = local || remote;
    const className = variant === 'rail' ? 'mod-card-icon-rail' : 'mod-card-icon-inline';

    if (!source) {
      return (
        <div className={`${className} mod-card-icon-fallback`}>
          <i className="fas fa-puzzle-piece"></i>
        </div>
      );
    }

    return (
      <div className={className}>
        <img
          src={source}
          alt={`${name} icon`}
          className="mod-card-icon-image"
          onError={(e) => {
            if (remote && e.currentTarget.src !== remote) {
              e.currentTarget.src = remote;
              return;
            }
            e.currentTarget.style.display = 'none';
          }}
        />
      </div>
    );
  };

  return (
    <>
      <ConfirmOverlay
        isOpen={showNexusKeyRequiredModal}
        onClose={() => setShowNexusKeyRequiredModal(false)}
        onConfirm={() => {
          setShowNexusKeyRequiredModal(false);
          if (onOpenAccounts) {
            onOpenAccounts();
          } else {
            setError('Nexus Login is required to download files. Open Accounts to continue.');
          }
        }}
        title="Nexus Login Required"
        message="Downloading from NexusMods requires Nexus Login. Open Accounts to add your Nexus credentials and continue."
        confirmText="Open Accounts"
        cancelText="Not Now"
        isNested
      />
      <ConfirmOverlay
        isOpen={!!pendingUpload}
        onClose={handleRuntimeMismatchCancel}
        onConfirm={handleRuntimeMismatchConfirm}
        title="Runtime Mismatch Warning"
        message={pendingUpload?.runtimeMismatch.warning || ''}
        confirmText="Continue Anyway"
        cancelText="Cancel"
        isNested
      />
      <ConfirmOverlay
        isOpen={!!confirmDialog}
        onClose={() => setConfirmDialog(null)}
        onConfirm={handleConfirmDialog}
        title={confirmDialog?.title || ''}
        message={confirmDialog?.message || ''}
        confirmText={confirmDialog?.confirmText}
        cancelText={confirmDialog?.cancelText}
        isNested
      />
      {pendingRuntimeSelection && (
        <div className="modal-overlay modal-overlay-nested" onClick={handleRuntimeSelectionCancel}>
          <div className="modal-content modal-content-nested" onClick={(e) => e.stopPropagation()} style={{ maxWidth: '400px' }}>
            <div className="modal-header">
              <h2>Select Mod Runtime</h2>
              <button className="modal-close" onClick={handleRuntimeSelectionCancel}>×</button>
            </div>
            <div style={{ padding: '1.5rem' }}>
              <p style={{ marginBottom: '1rem', color: '#ccc' }}>
                Could not determine the runtime for <strong>{pendingRuntimeSelection.fileName}</strong>.
                Please select which runtime this mod is designed for:
              </p>
              <div style={{ display: 'flex', gap: '0.75rem', justifyContent: 'center', marginBottom: '1.5rem' }}>
                <button
                  className="btn btn-primary"
                  onClick={() => handleRuntimeSelectionConfirm('Mono')}
                  style={{ minWidth: '100px' }}
                >
                  Mono
                </button>
                <button
                  className="btn btn-primary"
                  onClick={() => handleRuntimeSelectionConfirm('IL2CPP')}
                  style={{ minWidth: '100px' }}
                >
                  IL2CPP
                </button>
              </div>
              <p style={{ fontSize: '0.85rem', color: '#888', textAlign: 'center' }}>
                This helps ensure the mod is tagged correctly in your library.
              </p>
            </div>
          </div>
        </div>
      )}
      <div className="mods-overlay mods-overlay--environment" style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, position: 'relative' }}>
        <div className="modal-header">
          <h2>Mods</h2>
          <div style={{ display: 'flex', gap: '0.45rem', alignItems: 'center', justifyContent: 'flex-end', flexWrap: 'wrap' }}>
            <button
              onClick={() => {
                const next = !showSearchInOverlay;
                setShowSearchInOverlay(next);
                if (!next) {
                  setShowSearchResults(false);
                  setShowNexusModsResults(false);
                }
              }}
              className="btn btn-secondary btn-small"
              title="Browse mods from Thunderstore/NexusMods"
            >
              <i className="fas fa-compass" style={{ marginRight: '0.45rem' }}></i>
              {showSearchInOverlay ? 'Hide Browse' : 'Browse Mods'}
            </button>
            <button
              onClick={handleCheckModUpdates}
              className="btn btn-secondary btn-small"
              disabled={checkingModUpdates}
              title="Check for mod and plugin updates"
            >
              {checkingModUpdates ? (
                <>
                  <i className="fas fa-spinner fa-spin" style={{ marginRight: '0.45rem' }}></i>
                  Checking...
                </>
              ) : (
                <>
                  <i className="fas fa-sync-alt" style={{ marginRight: '0.45rem' }}></i>
                  Check Updates
                </>
              )}
            </button>
            <button
              onClick={handleUpdateAllMods}
              className="btn btn-primary btn-small"
              disabled={updatingAllMods || totalUpdatesAvailable === 0}
              title="Update all supported mods with updates"
            >
              {updatingAllMods ? (
                <>
                  <i className="fas fa-spinner fa-spin" style={{ marginRight: '0.45rem' }}></i>
                  Updating...
                </>
              ) : (
                <>
                  <i className="fas fa-arrow-up" style={{ marginRight: '0.45rem' }}></i>
                  Update All ({totalUpdatesAvailable})
                </>
              )}
            </button>
            <button
              onClick={handleUploadClick}
              className="btn btn-primary btn-small"
              disabled={uploading}
              title="Upload a mod file (.dll, .zip, or .rar)"
            >
              {uploading ? (
                <>
                  <i className="fas fa-spinner fa-spin" style={{ marginRight: '0.45rem' }}></i>
                  Uploading...
                </>
              ) : (
                <>
                  <i className="fas fa-upload" style={{ marginRight: '0.45rem' }}></i>
                  Add Mod
                </>
              )}
            </button>
            <button className="btn btn-secondary btn-small" onClick={onClose}>
              <i className="fas fa-arrow-left" style={{ marginRight: '0.45rem' }}></i>
              Back
            </button>
          </div>
        </div>

        <div className="mods-content" ref={modsScrollContainerRef}>
          {error && (
            <div className="error-message" style={{ margin: '0 1.25rem', padding: '0.75rem', backgroundColor: '#dc3545', color: '#fff', borderRadius: '4px' }}>
              {error}
            </div>
          )}

          {/* Mod Search Bar */}
          {showSearchInOverlay && environment && (
            <div className="mods-section" style={{ padding: '0 1.25rem', marginBottom: '1rem', borderBottom: '1px solid #3a3a3a', paddingBottom: '1rem' }}>
              {/* Source Tabs */}
              <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '0.75rem' }}>
                <button
                  onClick={() => {
                    setSearchSource('thunderstore');
                    setShowSearchResults(false);
                    setShowNexusModsResults(false);
                  }}
                  className="btn"
                  style={{
                    flex: 1,
                    backgroundColor: searchSource === 'thunderstore' ? '#4a90e2' : '#2a2a2a',
                    color: searchSource === 'thunderstore' ? '#fff' : '#888',
                    border: `1px solid ${searchSource === 'thunderstore' ? '#4a90e2' : '#3a3a3a'}`,
                    padding: '0.5rem',
                    fontSize: '0.875rem'
                  }}
                >
                  <i className="fas fa-cloud-download-alt" style={{ marginRight: '0.5rem' }}></i>
                  Thunderstore
                </button>
                <button
                  onClick={() => {
                    setSearchSource('nexusmods');
                    setShowSearchResults(false);
                    setShowNexusModsResults(false);
                  }}
                  className="btn"
                  style={{
                    flex: 1,
                    backgroundColor: searchSource === 'nexusmods' ? '#ea4335' : '#2a2a2a',
                    color: searchSource === 'nexusmods' ? '#fff' : '#888',
                    border: `1px solid ${searchSource === 'nexusmods' ? '#ea4335' : '#3a3a3a'}`,
                    padding: '0.5rem',
                    fontSize: '0.875rem'
                  }}
                >
                  <i className="fas fa-download" style={{ marginRight: '0.5rem' }}></i>
                  NexusMods
                </button>
              </div>

              {/* Search Input */}
              <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                <div style={{ flex: 1, position: 'relative' }}>
                  <input
                    type="text"
                    placeholder={searchSource === 'thunderstore'
                      ? `Search Thunderstore for ${environment.runtime} mods...`
                      : `Search NexusMods for ${environment.runtime} mods...`}
                    value={searchSource === 'thunderstore' ? searchQuery : nexusModsSearchQuery}
                    onChange={(e) => {
                      if (searchSource === 'thunderstore') {
                        setSearchQuery(e.target.value);
                      } else {
                        setNexusModsSearchQuery(e.target.value);
                      }
                    }}
                    onKeyDown={handleSearchKeyDown}
                    style={{
                      width: '100%',
                      padding: '0.5rem 2.5rem 0.5rem 0.75rem',
                      backgroundColor: '#1a1a1a',
                      border: '1px solid #3a3a3a',
                      borderRadius: '4px',
                      color: '#fff',
                      fontSize: '0.875rem'
                    }}
                  />
                  <i
                    className="fas fa-search"
                    style={{
                      position: 'absolute',
                      right: '0.75rem',
                      top: '50%',
                      transform: 'translateY(-50%)',
                      color: '#888',
                      cursor: 'pointer'
                    }}
                    onClick={searchSource === 'thunderstore' ? handleSearch : handleSearchNexusMods}
                  ></i>
                </div>
                <button
                  onClick={searchSource === 'thunderstore' ? handleSearch : handleSearchNexusMods}
                  className="btn btn-primary"
                  disabled={(searchSource === 'thunderstore' ? searching : searchingNexusMods) ||
                           (searchSource === 'thunderstore' ? !searchQuery.trim() : !nexusModsSearchQuery.trim())}
                  style={{ whiteSpace: 'nowrap' }}
                >
                  {(searchSource === 'thunderstore' ? searching : searchingNexusMods) ? (
                    <>
                      <i className="fas fa-spinner fa-spin" style={{ marginRight: '0.5rem' }}></i>
                      Searching...
                    </>
                  ) : (
                    <>
                      <i className="fas fa-search" style={{ marginRight: '0.5rem' }}></i>
                      Search
                    </>
                  )}
                </button>
                {(showSearchResults || showNexusModsResults) && (
                  <button
                    onClick={() => {
                      setShowSearchResults(false);
                      setShowNexusModsResults(false);
                      setSearchQuery('');
                      setNexusModsSearchQuery('');
                      setSearchResults([]);
                      setNexusModsSearchResults([]);
                    }}
                    className="btn btn-secondary"
                    style={{ whiteSpace: 'nowrap' }}
                  >
                    <i className="fas fa-times" style={{ marginRight: '0.5rem' }}></i>
                    Close
                  </button>
                )}
              </div>
              {environment && (
                  <p style={{ margin: '0.5rem 0 0 0', fontSize: '0.75rem', color: '#888' }}>
                    Showing Schedule I results for <strong>{environment.runtime}</strong>
                  </p>
                )}
            </div>
          )}

          {/* Search Results - Loading State */}
          {(searching || searchingNexusMods) && (
            <div style={{ padding: '2rem', textAlign: 'center', color: '#888' }}>
              <i className="fas fa-spinner fa-spin" style={{ fontSize: '2rem', marginBottom: '1rem' }}></i>
              <p>Searching {searchSource === 'thunderstore' ? 'Thunderstore' : 'NexusMods'}...</p>
            </div>
          )}

          {/* Thunderstore Search Results */}
          {!searching && showSearchResults && searchResults.length > 0 && (
            <div className="mods-section" style={{ padding: '1rem 1.25rem 1rem', marginBottom: '1rem' }}>
              <h3 style={{ margin: '0 0 1rem 0', fontSize: '1rem', color: '#fff' }}>
                Search Results ({searchResults.length})
              </h3>
              <div className="mods-grid" style={{ display: 'grid', gap: '1rem', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))' }}>
                {searchResults.map((pkg) => {
                  const latestVersion = pkg.versions?.[0];
                  const iconUrl = latestVersion?.icon || pkg.icon || pkg.icon_url;
                  const runtimeText = `${pkg.name} ${pkg.full_name} ${(pkg.categories || []).join(' ')}`.toLowerCase();
                  const runtimes: Array<'IL2CPP' | 'Mono'> = [];
                  if (runtimeText.includes('il2cpp')) runtimes.push('IL2CPP');
                  if (runtimeText.includes('mono')) runtimes.push('Mono');
                  if (runtimes.length === 0 && environment?.runtime) {
                    runtimes.push(environment.runtime);
                  }
                  const summary = latestVersion?.description;
                  const totalDownloads = Array.isArray(pkg.versions)
                    ? pkg.versions.reduce((sum, version) => sum + (version.downloads || 0), 0)
                    : 0;

                  return (
                    <div
                      key={pkg.uuid4}
                      className="mod-card store-card"
                      style={{ padding: '1rem', backgroundColor: '#2a2a2a', borderRadius: '8px', border: '1px solid #3a3a3a', cursor: 'pointer' }}
                      role="button"
                      tabIndex={0}
                      aria-label={`Open details for ${pkg.name || pkg.full_name || 'Unknown Mod'}`}
                      onClick={() => openThunderstoreModView(pkg)}
                      onKeyDown={(event) => handleCardActivationKeyDown(event, () => openThunderstoreModView(pkg))}
                    >
                      <div className="mod-card-row-shell" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'stretch', gap: '1rem' }}>
                        <div className="mod-card-main-shell" style={{ flex: 1, minWidth: 0, alignItems: 'stretch', gap: '1rem' }}>
                          {renderCardIcon(pkg.name || pkg.full_name || 'Unknown Mod', undefined, iconUrl, 'rail')}
                          <div className="mod-card-main-column" style={{ minWidth: 0 }}>
                            <div className="mod-card-title-row" style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', flexWrap: 'wrap' }}>
                              <strong className="mod-card-title-text" style={{ fontSize: '1rem' }}>
                                {pkg.name || (pkg.full_name ? pkg.full_name.split('-').slice(1).join('-') : 'Unknown Mod')}
                              </strong>
                            </div>
                            <div style={{ fontSize: '0.85rem', color: '#9aa4b2' }}>{pkg.owner || 'Unknown'}</div>
                            <div style={{ marginTop: '0.35rem', display: 'flex', gap: '0.35rem', flexWrap: 'wrap' }}>
                              {runtimes.map((runtime) => (
                                <span
                                  key={`${pkg.uuid4}-${runtime}`}
                                  style={{
                                    fontSize: '0.7rem',
                                    padding: '0.15rem 0.4rem',
                                    borderRadius: '4px',
                                    backgroundColor: '#4a90e220',
                                    color: '#4a90e2',
                                    border: '1px solid #4a90e240'
                                  }}
                                >
                                  {runtime}
                                </span>
                              ))}
                            </div>
                            {summary && (
                              <p className="mod-card-summary" title={summary} style={{ marginTop: '0.45rem' }}>
                                {summary}
                              </p>
                            )}
                            <div className="mod-card-meta-row" style={{ marginTop: '0.45rem', fontSize: '0.78rem', color: '#8f9cb0', display: 'flex', gap: '0.6rem', flexWrap: 'wrap' }}>
                              <span><i className="fas fa-download" style={{ marginRight: '0.25rem' }}></i>{totalDownloads.toLocaleString()}</span>
                              <span><i className="fas fa-thumbs-up" style={{ marginRight: '0.25rem' }}></i>{(pkg.rating_score || 0).toLocaleString()}</span>
                              {latestVersion?.version_number && (
                                <span><i className="fas fa-tag" style={{ marginRight: '0.25rem' }}></i>v{latestVersion.version_number}</span>
                              )}
                            </div>
                          </div>
                        </div>
                        <div className="mod-card-actions mod-card-actions--stacked" onClick={(e) => e.stopPropagation()}>
                          <div className="mod-card-actions-buttons">
                            <button
                              onClick={() => handleInstallThunderstoreMod(pkg)}
                              className="btn btn-primary btn-small mod-card-action-button"
                              disabled={installingPackage === pkg.uuid4}
                              title={`Install ${pkg.full_name || pkg.name || 'mod'}`}
                            >
                              {installingPackage === pkg.uuid4 ? 'Installing...' : 'Install'}
                            </button>
                          </div>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {!searching && showSearchResults && searchResults.length === 0 && (
            <div style={{ padding: '2rem', textAlign: 'center', color: '#888' }}>
              <i className="fas fa-search" style={{ fontSize: '2rem', marginBottom: '1rem' }}></i>
              <p>No mods found matching your search</p>
            </div>
          )}

          {/* NexusMods Search Results - Loading State */}
          {searchingNexusMods && (
            <div style={{ padding: '2rem', textAlign: 'center', color: '#888' }}>
              <i className="fas fa-spinner fa-spin" style={{ fontSize: '2rem', marginBottom: '1rem' }}></i>
              <p>Searching NexusMods...</p>
            </div>
          )}

          {/* NexusMods Search Results */}
          {!searchingNexusMods && showNexusModsResults && nexusModsSearchResults.length > 0 && (() => {
            const runtimeLower = environment?.runtime?.toLowerCase() || '';

            // Filter mods to only show those with installable files for current runtime
            const compatibleMods = nexusModsSearchResults.filter((mod) => {
              const files = nexusModsFiles.get(mod.mod_id) || [];

              const runtimeFiles = files.filter((f: any) => {
                const fileName = (f.file_name || f.name || '').toLowerCase();

                // Define runtime-specific keywords:
                // IL2CPP: il2cpp, main, beta
                // Mono: mono, alternate, alternatebeta
                if (runtimeLower === 'il2cpp') {
                  // For IL2CPP, file must contain: il2cpp, main, or beta
                  return fileName.includes('il2cpp') || fileName.includes('main') || fileName.includes('beta');
                } else {
                  // For Mono, file must contain: mono, alternate, or alternatebeta
                  return fileName.includes('mono') || fileName.includes('alternate');
                }
              });

              // Only include mods that have at least one compatible file
              return runtimeFiles.length > 0;
            });

            return compatibleMods.length > 0 ? (
              <div className="mods-section" style={{ padding: '1rem 1.25rem 1rem', marginBottom: '1rem' }}>
                <h3 style={{ margin: '0 0 1rem 0', fontSize: '1rem', color: '#fff' }}>
                  Search Results ({compatibleMods.length})
                </h3>
                {!hasNexusDownloadAccess && (
                  <div style={{
                    marginBottom: '0.75rem',
                    padding: '0.5rem 0.75rem',
                    borderRadius: '6px',
                    backgroundColor: '#3a2a1a',
                    border: '1px solid #6a4a2a',
                    color: '#ffd7a3',
                    fontSize: '0.85rem'
                  }}>
                    <i className="fas fa-info-circle" style={{ marginRight: '0.5rem' }}></i>
                    Browsing is available without login. Downloading requires Nexus Login.
                  </div>
                )}
                <div className="mods-grid" style={{ display: 'grid', gap: '1rem', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))' }}>
                  {compatibleMods.map((mod) => {
                    const files = nexusModsFiles.get(mod.mod_id) || [];

                    // Check if mod is already installed
                    const isAlreadyInstalled = mods.some(installedMod => {
                      // Check by source URL or mod name + author
                      const sourceUrl = `https://www.nexusmods.com/schedule1/mods/${mod.mod_id}`;
                      return installedMod.sourceUrl === sourceUrl ||
                             (installedMod.name === mod.name && installedMod.source === 'nexusmods');
                    });

                    // Filter files to ONLY show runtime-compatible files with valid naming
                    const runtimeFiles = files.filter((f: any) => {
                      const fileName = (f.file_name || f.name || '').toLowerCase();

                      // Define runtime-specific keywords:
                      // IL2CPP: il2cpp, main, beta
                      // Mono: mono, alternate, alternatebeta
                      if (runtimeLower === 'il2cpp') {
                        // For IL2CPP, file must contain: il2cpp, main, or beta
                        return fileName.includes('il2cpp') || fileName.includes('main') || fileName.includes('beta');
                      } else {
                        // For Mono, file must contain: mono, alternate, or alternatebeta
                        return fileName.includes('mono') || fileName.includes('alternate');
                      }
                    });

                  // Find the best matching file for current runtime
                    const bestFile = runtimeFiles.find((f: any) => {
                      const fileName = (f.file_name || f.name || '').toLowerCase();
                      return fileName.includes(runtimeLower);
                    }) || runtimeFiles.find((f: any) => f.is_primary) || runtimeFiles[0];

                    const fileNames = files.map((f: any) => (f.file_name || f.name || '').toLowerCase());
                    const hasIl2cpp = fileNames.some((name: string) => name.includes('il2cpp'));
                    const hasMono = fileNames.some((name: string) => name.includes('mono'));
                    const summaryText = mod.summary || mod.description || '';

                  return (
                    <div
                      key={mod.mod_id}
                      className="mod-card store-card"
                      style={{
                        padding: '1rem',
                        cursor: 'pointer'
                      }}
                      role="button"
                      tabIndex={0}
                      aria-label={`Open details for ${mod.name || 'Unknown Mod'}`}
                      onClick={() => openNexusModView(mod)}
                      onKeyDown={(event) => handleCardActivationKeyDown(event, () => openNexusModView(mod))}
                    >
                      <div className="mod-card-row-shell" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'stretch', gap: '1rem' }}>
                        <div className="mod-card-main-shell" style={{ flex: 1, minWidth: 0, alignItems: 'stretch', gap: '1rem' }}>
                          {renderCardIcon(mod.name || 'Unknown Mod', undefined, mod.picture_url, 'rail')}
                          <div className="mod-card-main-column" style={{ minWidth: 0 }}>
                            <div className="mod-card-title-row" style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', flexWrap: 'wrap' }}>
                              <strong className="mod-card-title-text" style={{ fontSize: '1rem' }}>{mod.name || 'Unknown Mod'}</strong>
                            </div>
                            <div style={{ fontSize: '0.85rem', color: '#9aa4b2' }}>{mod.author || 'Unknown'}</div>
                            <div style={{ marginTop: '0.35rem', display: 'flex', gap: '0.35rem', flexWrap: 'wrap' }}>
                              {hasIl2cpp && (
                                <span style={{ fontSize: '0.7rem', padding: '0.15rem 0.4rem', borderRadius: '4px', backgroundColor: '#4a90e220', color: '#4a90e2', border: '1px solid #4a90e240' }}>
                                  IL2CPP
                                </span>
                              )}
                              {hasMono && (
                                <span style={{ fontSize: '0.7rem', padding: '0.15rem 0.4rem', borderRadius: '4px', backgroundColor: '#4a90e220', color: '#4a90e2', border: '1px solid #4a90e240' }}>
                                  Mono
                                </span>
                              )}
                              {!hasIl2cpp && !hasMono && (
                                <span style={{ fontSize: '0.7rem', padding: '0.15rem 0.4rem', borderRadius: '4px', backgroundColor: '#6c757d', color: '#fff' }}>
                                  Runtime Unknown
                                </span>
                              )}
                            </div>
                            {summaryText && (
                              <p className="mod-card-summary" title={summaryText} style={{ marginTop: '0.45rem' }}>
                                {summaryText.length > 200 ? `${summaryText.substring(0, 200)}...` : summaryText}
                              </p>
                            )}
                            <div className="mod-card-meta-row" style={{ marginTop: '0.45rem', fontSize: '0.78rem', color: '#8f9cb0', display: 'flex', gap: '0.6rem', flexWrap: 'wrap' }}>
                              <span><i className="fas fa-download" style={{ marginRight: '0.25rem' }}></i>{(mod.mod_downloads || 0).toLocaleString()}</span>
                              <span><i className="fas fa-thumbs-up" style={{ marginRight: '0.25rem' }}></i>{(mod.endorsement_count || 0).toLocaleString()}</span>
                              {mod.version && (
                                <span><i className="fas fa-tag" style={{ marginRight: '0.25rem' }}></i>v{mod.version}</span>
                              )}
                            </div>
                          </div>
                        </div>
                        <div className="mod-card-actions mod-card-actions--stacked" onClick={(e) => e.stopPropagation()}>
                          <div className="mod-card-actions-buttons">
                            <button
                              onClick={() => handleInstallNexusModsMod(mod.mod_id, bestFile?.file_id)}
                              className={`${isAlreadyInstalled ? 'btn btn-secondary' : 'btn btn-primary'} btn-small mod-card-action-button`}
                              disabled={installingNexusMod?.modId === mod.mod_id || !bestFile || isAlreadyInstalled || !hasNexusDownloadAccess}
                              title={isAlreadyInstalled
                                ? 'This mod is already installed'
                                : !hasNexusDownloadAccess
                                  ? 'Requires Nexus Login to download'
                                  : bestFile
                                    ? `Install ${bestFile.file_name || bestFile.name || 'mod'}`
                                    : 'Loading files...'}
                            >
                              {installingNexusMod?.modId === mod.mod_id
                                ? 'Installing...'
                                : isAlreadyInstalled
                                  ? 'Installed'
                                  : 'Install'}
                            </button>
                          </div>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
            ) : (
              <div style={{ padding: '2rem', textAlign: 'center', color: '#888' }}>
                <i className="fas fa-search" style={{ fontSize: '2rem', marginBottom: '1rem' }}></i>
                <p>No compatible mods found for {environment?.runtime} runtime</p>
              </div>
            );
          })()}

          {!searchingNexusMods && showNexusModsResults && nexusModsSearchResults.length === 0 && (
            <div style={{ padding: '2rem', textAlign: 'center', color: '#888' }}>
              <i className="fas fa-search" style={{ fontSize: '2rem', marginBottom: '1rem' }}></i>
              <p>No mods found matching your search</p>
            </div>
          )}

          <div className="mods-actions mods-toolbar" style={{ padding: '0 1.25rem', marginBottom: '1rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '0.6rem' }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              {modsDirectory && (
                <p style={{ margin: 0, color: '#888', fontSize: '0.875rem', wordBreak: 'break-all' }}>
                  <i className="fas fa-folder" style={{ marginRight: '0.5rem' }}></i>
                  {modsDirectory}
                </p>
              )}
              <p style={{ margin: '0.35rem 0 0 0', color: '#9aa4b2', fontSize: '0.8rem' }}>
                {mods.length} installed, {mods.filter(m => !!m.disabled).length} disabled, {totalUpdatesAvailable} updates
              </p>
            </div>
            <button
              onClick={handleOpenFolder}
              className="btn btn-secondary btn-small"
              title="Open mods folder in file explorer"
            >
              <i className="fas fa-folder-open"></i>
            </button>
          </div>

          {!showSearchResults && loading ? (
            <div style={{ padding: '2rem', textAlign: 'center', color: '#888' }}>
              <i className="fas fa-spinner fa-spin" style={{ fontSize: '2rem', marginBottom: '1rem' }}></i>
              <p>Loading mods...</p>
            </div>
          ) : !showSearchResults && (
            <div className="mods-section" style={{ padding: '0 1.25rem 1.25rem', flex: 1, minHeight: 0, overflowY: 'auto' }}>
              <div className="mods-env-layout mods-env-layout--grid">
                <section className="mods-env-panel mods-env-panel--library">
                  <div className="mods-env-panel-header">
                    <h3 style={{ margin: 0, fontSize: '1rem' }}>Library Downloads</h3>
                    <div className="mods-panel-controls mods-panel-controls--single">
                      <button
                        type="button"
                        className="btn btn-small mods-panel-control-button"
                        onClick={() => void loadDownloadedLibrary()}
                        title="Refresh library list (e.g. after downloading in Library view)"
                      >
                        <i className="fas fa-sync-alt" style={{ marginRight: '0.25rem' }}></i>
                        Refresh
                      </button>
                    </div>
                  </div>
                  {downloadedNotInstalled.length === 0 ? (
                    <div style={{ padding: '1rem', textAlign: 'center', color: '#888' }}>
                      <p>No downloaded mods waiting to be installed in this environment.</p>
                    </div>
                  ) : (
                    <div className="mods-env-list">
                      {downloadedNotInstalled.map(entry => {
                        const storageId = envRuntime ? entry.storageIdsByRuntime?.[envRuntime] || entry.storageId : entry.storageId;
                        const activeVersion = entry.installedVersion || entry.sourceVersion;
                        const primaryFile = entry.files[0] || entry.displayName;
                        const extraFiles = Math.max(0, entry.files.length - 1);
                        return (
                        <div
                          key={entry.storageId}
                          className="mod-card compact-row library-row-card"
                          style={{
                            backgroundColor: '#2a2a2a',
                            border: '1px solid #3a3a3a',
                            borderRadius: '7px',
                            padding: '0.65rem 0.75rem',
                            cursor: 'pointer'
                          }}
                          role="button"
                          tabIndex={0}
                          aria-label={`Open details for ${entry.displayName}`}
                          onClick={() => openLibraryModView(entry)}
                          onKeyDown={(event) => handleCardActivationKeyDown(event, () => openLibraryModView(entry))}
                        >
                          <div className="mod-card-row-shell" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'stretch', gap: '0.65rem' }}>
                            <div className="mod-card-main-shell" style={{ display: 'flex', alignItems: 'stretch', gap: '0.65rem', minWidth: 0, flex: 1 }}>
                              {renderCardIcon(entry.displayName, entry.iconCachePath, entry.iconUrl, 'rail')}
                              <div className="mod-card-main-column" style={{ minWidth: 0, display: 'grid', gap: '0.3rem', alignContent: 'start' }}>
                              <div className="mod-card-title-row" style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', flexWrap: 'wrap' }}>
                                <strong className="mod-card-title-text" style={{ fontSize: '0.94rem' }}>{entry.displayName}</strong>
                                <span style={{
                                  fontSize: '0.64rem',
                                  padding: '0.1rem 0.38rem',
                                  borderRadius: '999px',
                                  backgroundColor: entry.managed ? '#28a745' : '#6c757d',
                                  color: '#fff'
                                }}>
                                  {entry.managed ? 'Managed' : 'External'}
                                </span>
                              </div>
                              <div className="mod-card-meta-row" style={{ fontSize: '0.74rem', color: '#8d9bb0', marginTop: '0.2rem', display: 'flex', gap: '0.45rem', flexWrap: 'wrap' }}>
                                <span>{entry.files.length} file(s)</span>
                                {entry.availableRuntimes?.map(runtime => (
                                  <span key={`${entry.storageId}-${runtime}`} style={{
                                    fontSize: '0.64rem',
                                    padding: '0.1rem 0.38rem',
                                    borderRadius: '999px',
                                    backgroundColor: '#4a90e220',
                                    color: '#4a90e2',
                                    border: '1px solid #4a90e240'
                                  }}>
                                    {runtime}
                                  </span>
                                ))}
                              </div>
                              {entry.summary && (
                                <p className="mod-card-summary" title={entry.summary}>
                                  {entry.summary}
                                </p>
                              )}
                            </div>
                            </div>
                            <div className="mod-card-actions" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                              <button
                                className="btn btn-primary btn-small"
                                disabled={!storageId || installingDownloaded === storageId}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  handleInstallDownloaded(entry);
                                }}
                                title={storageId ? `Install ${entry.displayName}` : 'No compatible runtime found'}
                              >
                                {installingDownloaded === storageId ? 'Installing...' : 'Install'}
                              </button>
                            </div>
                          </div>
                          <div className="mod-card-meta-row mod-card-meta-row--footer" style={{ fontSize: '0.78rem', color: '#8f9cb0', display: 'flex', gap: '0.65rem', alignItems: 'center', flexWrap: 'wrap' }}>
                            <span>
                              <i className="fas fa-file-code" style={{ marginRight: '0.25rem' }}></i>
                              {primaryFile}{extraFiles > 0 ? ` +${extraFiles}` : ''}
                            </span>
                            {activeVersion && (
                              <span>
                                <i className="fas fa-tag" style={{ marginRight: '0.25rem' }}></i>
                                {activeVersion}
                              </span>
                            )}
                            {entry.source && (
                              <span className="mod-card-source-tag" style={{
                                display: 'inline-flex',
                                alignItems: 'center',
                                padding: '0.12rem 0.42rem',
                                borderRadius: '999px',
                                backgroundColor: `${getSourceColor(entry.source)}20`,
                                color: getSourceColor(entry.source),
                                border: `1px solid ${getSourceColor(entry.source)}40`
                              }}>
                                <i className="fas fa-download" style={{ marginRight: '0.25rem', fontSize: '0.75rem' }}></i>
                                {getSourceLabel(entry.source)}
                              </span>
                            )}
                          </div>
                        </div>
                        );
                      })}
                    </div>
                  )}
                </section>

                <section className="mods-env-panel mods-env-panel--installed">
                <div className="mods-env-panel-header">
                  <h3 style={{ margin: 0, fontSize: '1rem' }}>Installed Here</h3>
                  <div className="mods-panel-controls mods-filter-bar mods-filter-bar--inline">
                    {(['all', 'updates', 'enabled', 'disabled'] as ModListFilter[]).map(filter => (
                      <button
                        key={filter}
                        className={`btn btn-small mods-filter-pill ${modListFilter === filter ? 'mods-filter-pill--active' : ''}`}
                        onClick={() => setModListFilter(filter)}
                      >
                        {filter === 'all' ? 'All' : filter === 'updates' ? 'Updates' : filter === 'enabled' ? 'Enabled' : 'Disabled'}
                      </button>
                    ))}
                  </div>
                </div>

                {filteredMods.length === 0 ? (
                  <div style={{ padding: '2rem', textAlign: 'center', color: '#888' }}>
                    <i className="fas fa-box-open" style={{ fontSize: '2rem', marginBottom: '1rem' }}></i>
                    <p>No mods match this filter</p>
                    <p style={{ fontSize: '0.875rem', marginTop: '0.5rem' }}>
                      Mods should be placed in the Mods directory as .dll files
                    </p>
                  </div>
                ) : (
                  <div className="mods-env-list">
                  {filteredMods.map((mod) => {
                  const updateInfo = modUpdates.get(mod.fileName);
                  const canAutoUpdate = mod.source === 'thunderstore' || mod.source === 'nexusmods' || mod.source === 'github';
                  const updateAvailable = !!updateInfo?.updateAvailable;
                  const libraryVersionCount = mod.managed
                    ? (libraryVersionCountByName.get(normalizeModNameKey(mod.name)) || 0)
                    : 0;

                  return (
                  <div
                    key={`${mod.fileName}-${mod.path}`}
                    className="mod-card compact-row installed-row-card"
                    style={{
                      backgroundColor: '#2a2a2a',
                      border: '1px solid #3a3a3a',
                      borderRadius: '7px',
                      padding: '0.65rem 0.75rem',
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'stretch',
                      cursor: 'pointer'
                    }}
                    role="button"
                    tabIndex={0}
                    aria-label={`Open details for ${mod.name}`}
                    onClick={() => openInstalledModView(mod)}
                    onKeyDown={(event) => handleCardActivationKeyDown(event, () => openInstalledModView(mod))}
                  >
                    <div className="mod-card-row-shell mod-card-row-shell--no-checkbox" style={{ flex: 1, display: 'flex', gap: '0.75rem', minWidth: 0 }}>
                      <div className="mod-card-main-shell" style={{ flex: 1, minWidth: 0, alignItems: 'stretch', gap: '0.75rem' }}>
                        {renderCardIcon(mod.name, mod.iconCachePath, mod.iconUrl, 'rail')}
                        <div className="mod-card-main-column mod-card-main-column--installed" style={{ minWidth: 0 }}>
                          <h3 className="mod-card-title-row" style={{ margin: 0, marginBottom: '0.32rem', fontSize: '0.98rem', color: mod.disabled ? '#93a0b2' : '#fff', display: 'flex', alignItems: 'center', gap: '0.42rem', flexWrap: 'wrap' }}>
                            <span className="mod-card-title-text">{mod.name}</span>
                            {mod.disabled && (
                              <span style={{
                                fontSize: '0.64rem',
                                padding: '0.12rem 0.38rem',
                                backgroundColor: '#ff6b6b20',
                                color: '#ff6b6b',
                                borderRadius: '999px',
                                border: '1px solid #ff6b6b40'
                              }}>
                                Disabled
                              </span>
                            )}
                            {mod.managed !== undefined && (
                              <span style={{
                                fontSize: '0.64rem',
                                padding: '0.12rem 0.38rem',
                                backgroundColor: mod.managed ? '#28a745' : '#6c757d',
                                color: '#fff',
                                borderRadius: '999px'
                              }}>
                                {mod.managed ? 'Managed' : 'External'}
                              </span>
                            )}
                            {libraryVersionCount > 1 && (
                              <span style={{
                                fontSize: '0.64rem',
                                padding: '0.12rem 0.38rem',
                                backgroundColor: '#4a90e220',
                                color: '#8fc0ff',
                                borderRadius: '999px',
                                border: '1px solid #4a90e240'
                              }}>
                                {libraryVersionCount} versions
                              </span>
                            )}
                          </h3>
                          {mod.summary && (
                            <p className="mod-card-summary mod-card-summary--installed" title={mod.summary}>
                              {mod.summary}
                            </p>
                          )}
                        </div>
                      </div>
                     <div className="mod-card-actions mod-card-actions--stacked" onClick={(e) => e.stopPropagation()}>
                      {canAutoUpdate && updateAvailable && (
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            handleUpdateMod(mod);
                          }}
                          className="btn btn-primary btn-small mod-card-action-button"
                          disabled={updatingMod === mod.fileName}
                          title={`Update ${mod.name}`}
                        >
                          {updatingMod === mod.fileName ? (
                            <i className="fas fa-spinner fa-spin"></i>
                          ) : (
                            <>
                              <i className="fas fa-arrow-up"></i>
                              <span style={{ marginLeft: '0.5rem' }}>Update</span>
                            </>
                          )}
                        </button>
                      )}
                      {mod.disabled ? (
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            handleEnableMod(mod);
                          }}
                          className="btn btn-primary btn-small mod-card-action-button"
                          disabled={enablingMod === mod.fileName}
                          title={`Enable ${mod.name}`}
                        >
                          {enablingMod === mod.fileName ? (
                            <i className="fas fa-spinner fa-spin"></i>
                          ) : (
                            <>
                              <i className="fas fa-check"></i>
                              <span style={{ marginLeft: '0.5rem' }}>Enable</span>
                            </>
                          )}
                        </button>
                      ) : (
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            handleDisableMod(mod);
                          }}
                          className="btn btn-secondary btn-small mod-card-action-button"
                          disabled={disablingMod === mod.fileName}
                          title={`Disable ${mod.name}`}
                        >
                          {disablingMod === mod.fileName ? (
                            <i className="fas fa-spinner fa-spin"></i>
                          ) : (
                            <>
                              <i className="fas fa-ban"></i>
                              <span style={{ marginLeft: '0.5rem' }}>Disable</span>
                            </>
                          )}
                        </button>
                      )}
                      <button
                        onClick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          requestDeleteMod(mod);
                        }}
                        className="btn btn-danger btn-small mod-card-action-button"
                        disabled={deletingMod === mod.fileName}
                        title={`Delete ${mod.name}`}
                      >
                        {deletingMod === mod.fileName ? (
                          <i className="fas fa-spinner fa-spin"></i>
                        ) : (
                          <>
                            <i className="fas fa-trash"></i>
                            <span style={{ marginLeft: '0.5rem' }}>Delete</span>
                          </>
                        )}
                      </button>
                    </div>
                    </div>
                    <div className="mod-card-meta-row mod-card-meta-row--footer" style={{ display: 'flex', gap: '0.65rem', alignItems: 'center', fontSize: '0.78rem', color: '#8f9cb0', flexWrap: 'wrap' }}>
                      <span>
                        <i className="fas fa-file-code" style={{ marginRight: '0.25rem' }}></i>
                        {mod.fileName}
                      </span>
                      {mod.version && (() => {
                        let versionColor = '#888';

                        if (updateInfo) {
                          if (!updateInfo.updateAvailable && updateInfo.latestVersion) {
                            versionColor = '#00ff00';
                          } else if (updateInfo.updateAvailable) {
                            versionColor = '#ffd700';
                          }
                        }

                        return (
                          <span>
                            <i className="fas fa-tag" style={{ marginRight: '0.25rem', color: versionColor }}></i>
                            <span style={{ color: versionColor, fontWeight: versionColor !== '#888' ? 'bold' : 'normal' }}>
                              {mod.version}
                            </span>
                          </span>
                        );
                      })()}
                      {updateAvailable && updateInfo?.latestVersion && (
                        <span style={{ color: '#ffd700', fontWeight: 600 }}>
                          Latest {updateInfo.latestVersion}
                        </span>
                      )}
                      {mod.source && (
                        <span className="mod-card-source-tag" style={{
                          display: 'inline-flex',
                          alignItems: 'center',
                          padding: '0.12rem 0.42rem',
                          borderRadius: '999px',
                          backgroundColor: `${getSourceColor(mod.source)}20`,
                          color: getSourceColor(mod.source),
                          border: `1px solid ${getSourceColor(mod.source)}40`
                        }}>
                          <i className="fas fa-download" style={{ marginRight: '0.25rem', fontSize: '0.75rem' }}></i>
                          {getSourceLabel(mod.source)}
                        </span>
                      )}
                    </div>
                  </div>
                  );
                  })
                  }
                  </div>
                )}
                </section>
              </div>
            </div>
          )}
        </div>

        {activeModView && (
          <div
            className="mod-view-overlay"
            style={{
              position: 'absolute',
              inset: 0,
              backgroundColor: 'rgba(9, 14, 24, 0.96)',
              borderRadius: '0.75rem',
              border: '1px solid #344259',
              display: 'flex',
              flexDirection: 'column',
              zIndex: 45
            }}
          >
            <div className="modal-header" style={{ borderBottom: '1px solid #2f3a4f' }}>
              <h2 style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
                <i className="fas fa-cube"></i>
                Mod View
              </h2>
              <button className="btn btn-secondary btn-small" onClick={closeModView}>
                <i className="fas fa-arrow-left" style={{ marginRight: '0.45rem' }}></i>
                Back
              </button>
            </div>

            <div className="mod-view-content" style={{ padding: '1rem 1.25rem 1.25rem', overflowY: 'auto', display: 'grid', gap: '1rem' }}>
              <div className="mod-view-header-grid" style={{ display: 'grid', gridTemplateColumns: '92px 1fr', gap: '1rem', alignItems: 'start' }}>
                <div className="mod-view-icon" style={{ width: '92px', height: '92px', borderRadius: '14px', overflow: 'hidden', border: '1px solid #3a4a66', background: '#172131' }}>
                  {(activeModView.iconCachePath || activeModView.iconUrl) ? (
                    <img
                      src={resolveImageSource(activeModView.iconCachePath) || resolveImageSource(activeModView.iconUrl)}
                      alt={`${activeModView.name} icon`}
                      style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                      onError={(e) => {
                        const remote = resolveImageSource(activeModView.iconUrl);
                        if (remote && e.currentTarget.src !== remote) {
                          e.currentTarget.src = remote;
                        }
                      }}
                    />
                  ) : (
                    <div style={{ width: '100%', height: '100%', display: 'grid', placeItems: 'center', color: '#7d8fa9' }}>
                      <i className="fas fa-puzzle-piece" style={{ fontSize: '1.6rem' }}></i>
                    </div>
                  )}
                </div>
                <div>
                  <h3 style={{ margin: 0 }}>{activeModView.name}</h3>
                  <div style={{ marginTop: '0.35rem', color: '#9ab0cb', fontSize: '0.85rem' }}>
                    Source: {getSourceLabel(activeModView.source)} {activeModView.author ? `• ${activeModView.author}` : ''}
                  </div>
                  {activeModView.summary && (
                    <p style={{ margin: '0.65rem 0 0', color: '#d5dfec', lineHeight: 1.55 }}>
                      {activeModView.summary}
                    </p>
                  )}
                </div>
              </div>

              <div className="mod-view-metrics" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '0.75rem' }}>
                <div className="mod-card mod-view-metric" style={{ padding: '0.7rem 0.8rem' }}>
                  <div style={{ color: '#8ea5c4', fontSize: '0.75rem' }}>Downloads</div>
                  <strong>{(activeModView.downloads || 0).toLocaleString()}</strong>
                </div>
                <div className="mod-card mod-view-metric" style={{ padding: '0.7rem 0.8rem' }}>
                  <div style={{ color: '#8ea5c4', fontSize: '0.75rem' }}>
                    {activeModView.source === 'nexusmods' ? 'Endorsements' : 'Likes'}
                  </div>
                  <strong>{(activeModView.likesOrEndorsements || 0).toLocaleString()}</strong>
                </div>
                <div className="mod-card mod-view-metric" style={{ padding: '0.7rem 0.8rem' }}>
                  <div style={{ color: '#8ea5c4', fontSize: '0.75rem' }}>Installed Version</div>
                  <strong>{activeModView.installedVersion || 'unknown'}</strong>
                </div>
                <div className="mod-card mod-view-metric" style={{ padding: '0.7rem 0.8rem' }}>
                  <div style={{ color: '#8ea5c4', fontSize: '0.75rem' }}>Latest Version</div>
                  <strong>{activeModView.latestVersion || 'unknown'}</strong>
                </div>
              </div>

              {(activeModView.tags || []).length > 0 && (
                <div className="mod-view-tags" style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap' }}>
                  {(activeModView.tags || []).map((tag) => (
                    <span className="mod-view-tag" key={`${activeModView.id}-${tag}`} style={{ padding: '0.2rem 0.45rem', borderRadius: '999px', backgroundColor: '#38537a33', border: '1px solid #38537a66', color: '#a9c1e6', fontSize: '0.72rem' }}>
                      {tag}
                    </span>
                  ))}
                </div>
              )}

              <div className="mod-view-actions" style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                {activeModViewSourceUrl && (
                  <a
                    href={activeModViewSourceUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="btn btn-secondary btn-small"
                    style={{ textDecoration: 'none' }}
                  >
                    <i className="fas fa-external-link-alt" style={{ marginRight: '0.45rem' }}></i>
                    Open Source Page
                  </a>
                )}
                <button className="btn btn-secondary btn-small" onClick={closeModView}>
                  Close
                </button>
              </div>
            </div>
          </div>
        )}
      </div>

    </>
  );
}
