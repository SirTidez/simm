import React, { useState, useEffect, useMemo, useRef } from 'react';
import { ApiService } from '../services/api';
import { ConfirmOverlay } from './ConfirmOverlay';
import { onModsChanged as onModsChangedEvent, onModsSnapshotUpdated } from '../services/events';
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
}

interface Props {
  isOpen: boolean;
  onClose: () => void;
  environmentId: string;
  onModsChanged?: () => void;
  onModUpdatesChecked?: (count: number) => void;
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
  }>;
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

function normalizeModNameKey(name: string): string {
  return name
    .replace(/\s*[\(\[]\s*(mono|il2cpp)\s*[\)\]]\s*$/i, '')
    .replace(/\s*[_-]\s*(mono|il2cpp)\s*$/i, '')
    .replace(/\s+(mono|il2cpp)\s*$/i, '')
    .trim()
    .toLowerCase();
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

export function ModsOverlay({ isOpen, onClose, environmentId, onModsChanged, onModUpdatesChecked }: Props) {
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

  // Mod updates state
  const [modUpdates, setModUpdates] = useState<Map<string, { updateAvailable: boolean; currentVersion?: string; latestVersion?: string }>>(new Map());
  const [checkingModUpdates, setCheckingModUpdates] = useState(false);
  const [updatingMod, setUpdatingMod] = useState<string | null>(null);
  const [updatingAllMods, setUpdatingAllMods] = useState(false);
  const [showSearchInOverlay, setShowSearchInOverlay] = useState(false);
  const [modListFilter, setModListFilter] = useState<ModListFilter>('all');
  const suppressWatcherReloadUntilRef = useRef(0);
  const modsReloadTimerRef = useRef<number | null>(null);
  const activeLoadRequestRef = useRef(0);

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
  }, [isOpen, environmentId]);

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
        // Check if Nexus Mods API key is available
        const hasApiKey = await ApiService.hasNexusModsApiKey();

        if (hasApiKey) {
          // Search Nexus Mods for this mod name
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

    // Check if API key is set
    const hasKey = await ApiService.hasNexusModsApiKey();
    if (!hasKey) {
      setError('NexusMods API key is not set. Please set it in the Accounts portal.');
      return;
    }

    const gameId = 'schedule1';

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

  return (
    <>
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
      <div className="mods-overlay" style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
        <div className="modal-header">
          <h2>Mods</h2>
          <button className="btn btn-secondary btn-small" onClick={onClose}>
            <i className="fas fa-arrow-left" style={{ marginRight: '0.45rem' }}></i>
            Back
          </button>
        </div>

        <div className="mods-content">
          {error && (
            <div className="error-message" style={{ margin: '0 1.25rem', padding: '0.75rem', backgroundColor: '#dc3545', color: '#fff', borderRadius: '4px' }}>
              {error}
            </div>
          )}

          {/* Mod Search Bar */}
          {showSearchInOverlay && environment && (
            <div style={{ padding: '0 1.25rem', marginBottom: '1rem', borderBottom: '1px solid #3a3a3a', paddingBottom: '1rem' }}>
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
            <div style={{ padding: '0 1.25rem', marginBottom: '1rem' }}>
              <h3 style={{ margin: '0 0 1rem 0', fontSize: '1rem', color: '#fff' }}>
                Search Results ({searchResults.length})
              </h3>
              <div style={{ display: 'grid', gap: '0.75rem' }}>
                {searchResults.map((pkg) => (
                  <div
                    key={pkg.uuid4}
                    style={{
                      backgroundColor: '#2a2a2a',
                      border: '1px solid #3a3a3a',
                      borderRadius: '8px',
                      padding: '1rem',
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'flex-start',
                      gap: '1rem'
                    }}
                  >
                    <div style={{ flex: 1 }}>
                      <h4 style={{ margin: 0, marginBottom: '0.5rem', fontSize: '1rem', color: '#fff' }}>
                        {pkg.name || (pkg.full_name ? pkg.full_name.split('-').slice(1).join('-') : 'Unknown Mod')}
                      </h4>
                      <div style={{ display: 'flex', gap: '1rem', alignItems: 'center', fontSize: '0.875rem', color: '#888', flexWrap: 'wrap', marginBottom: '0.5rem' }}>
                        <span>
                          <i className="fas fa-user" style={{ marginRight: '0.25rem' }}></i>
                          {pkg.owner || 'Unknown'}
                        </span>
                        <span>
                          <i className="fas fa-download" style={{ marginRight: '0.25rem' }}></i>
                          {(() => {
                            // Sum all version downloads (API doesn't provide total_downloads)
                            if (pkg.versions && Array.isArray(pkg.versions)) {
                              const totalDownloads = pkg.versions.reduce((sum: number, v: any) => {
                                return sum + (v.downloads || 0);
                              }, 0);
                              return totalDownloads.toLocaleString();
                            }
                            return '0';
                          })()} downloads
                        </span>
                        {pkg.versions?.[0]?.version_number && (
                          <span>
                            <i className="fas fa-tag" style={{ marginRight: '0.25rem' }}></i>
                            v{pkg.versions[0].version_number}
                          </span>
                        )}
                        <span>
                          <i className="fas fa-thumbs-up" style={{ marginRight: '0.25rem', color: '#4a90e2' }}></i>
                          {pkg.rating_score > 0 ? pkg.rating_score.toLocaleString() : '0'} endorsements
                        </span>
                        {pkg.rating_score > 0 && (
                          <span>
                            <i className="fas fa-star" style={{ marginRight: '0.25rem', color: '#ffd700' }}></i>
                            {pkg.rating_score.toFixed(1)}
                          </span>
                        )}
                        {/* Display categories/tags */}
                        {(pkg.categories && Array.isArray(pkg.categories) && pkg.categories.length > 0) && (() => {
                          // Sort categories so runtime tags (Mono/IL2CPP) appear first
                          const sortedCategories = [...pkg.categories].sort((a, b) => {
                            const aLower = a.toLowerCase();
                            const bLower = b.toLowerCase();
                            const aIsRuntime = aLower.includes('mono') || aLower.includes('il2cpp');
                            const bIsRuntime = bLower.includes('mono') || bLower.includes('il2cpp');

                            if (aIsRuntime && !bIsRuntime) return -1;
                            if (!aIsRuntime && bIsRuntime) return 1;
                            return 0; // Keep original order for non-runtime tags
                          });

                          return (
                            <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                              {sortedCategories.map((cat: string, idx: number) => {
                                const catLower = cat.toLowerCase();
                                let tagColor = '#888'; // Default gray
                                if (catLower.includes('mono')) {
                                  tagColor = '#cc4400'; // Dark orange-red
                                } else if (catLower.includes('il2cpp')) {
                                  tagColor = '#4a90e2'; // Blue
                                }
                                return (
                                  <span
                                    key={idx}
                                    style={{
                                      padding: '0.125rem 0.5rem',
                                      borderRadius: '4px',
                                      backgroundColor: tagColor + '20',
                                      color: tagColor,
                                      fontSize: '0.75rem',
                                      border: `1px solid ${tagColor}40`
                                    }}
                                  >
                                    {cat}
                                  </span>
                                );
                              })}
                            </div>
                          );
                        })()}
                      </div>
                      {/* Description */}
                      {(() => {
                        // Description is in the first version (latest)
                        const description = pkg.versions?.[0]?.description;

                        if (description && typeof description === 'string' && description.trim()) {
                          const maxLength = 200;
                          const truncated = description.length > maxLength
                            ? description.substring(0, maxLength).trim() + '...'
                            : description;
                          return (
                            <p style={{
                              margin: '0.5rem 0 0.75rem 0',
                              fontSize: '0.875rem',
                              color: '#ccc',
                              lineHeight: '1.5',
                              maxWidth: '100%'
                            }}>
                              {truncated}
                            </p>
                          );
                        }
                        return null;
                      })()}
                      <div style={{ display: 'flex', gap: '1rem', alignItems: 'center', fontSize: '0.75rem', color: '#888', flexWrap: 'wrap' }}>
                        {pkg.versions?.[0]?.file_size && (
                          <span>
                            Size: {(pkg.versions[0].file_size / 1024 / 1024).toFixed(2)} MB
                          </span>
                        )}
                        {pkg.date_updated && (() => {
                          const updateDate = new Date(pkg.date_updated);
                          const now = new Date();
                          const diffMs = now.getTime() - updateDate.getTime();
                          const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
                          const diffMonths = Math.floor(diffDays / 30);
                          const diffYears = Math.floor(diffDays / 365);

                          let timeAgo = '';
                          if (diffDays < 1) {
                            timeAgo = 'today';
                          } else if (diffDays === 1) {
                            timeAgo = 'yesterday';
                          } else if (diffDays < 7) {
                            timeAgo = `${diffDays} days ago`;
                          } else if (diffDays < 30) {
                            const weeks = Math.floor(diffDays / 7);
                            timeAgo = `${weeks} week${weeks > 1 ? 's' : ''} ago`;
                          } else if (diffMonths < 12) {
                            timeAgo = `${diffMonths} month${diffMonths > 1 ? 's' : ''} ago`;
                          } else {
                            timeAgo = `${diffYears} year${diffYears > 1 ? 's' : ''} ago`;
                          }

                          return (
                            <span>
                              <i className="fas fa-clock" style={{ marginRight: '0.25rem' }}></i>
                              Updated {timeAgo}
                            </span>
                          );
                        })()}
                      </div>
                    </div>
                    <div style={{ display: 'flex', gap: '0.5rem', flexDirection: 'column' }}>
                      <button
                        onClick={() => handleInstallThunderstoreMod(pkg)}
                        className="btn btn-primary btn-small"
                        disabled={installingPackage === pkg.uuid4}
                        title={`Install ${pkg.full_name || pkg.name || 'mod'}`}
                      >
                        {installingPackage === pkg.uuid4 ? (
                          <>
                            <i className="fas fa-spinner fa-spin"></i>
                            <span style={{ marginLeft: '0.5rem' }}>Installing...</span>
                          </>
                        ) : (
                          <>
                            <i className="fas fa-download"></i>
                            <span style={{ marginLeft: '0.5rem' }}>Install</span>
                          </>
                        )}
                      </button>
                      <a
                        href={safeExternalUrl(pkg.package_url)}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="btn btn-secondary btn-small"
                        style={{ textDecoration: 'none', textAlign: 'center' }}
                        title="View on Thunderstore"
                        onClick={(e) => {
                          if (!safeExternalUrl(pkg.package_url)) {
                            e.preventDefault();
                          }
                        }}
                      >
                        <i className="fas fa-external-link-alt"></i>
                        <span style={{ marginLeft: '0.5rem' }}>View</span>
                      </a>
                    </div>
                  </div>
                ))}
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
              <div style={{ padding: '0 1.25rem', marginBottom: '1rem' }}>
                <h3 style={{ margin: '0 0 1rem 0', fontSize: '1rem', color: '#fff' }}>
                  Search Results ({compatibleMods.length})
                </h3>
                <div style={{ display: 'grid', gap: '0.75rem' }}>
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

                  return (
                    <div
                      key={mod.mod_id}
                      style={{
                        backgroundColor: '#2a2a2a',
                        border: '1px solid #3a3a3a',
                        borderRadius: '8px',
                        padding: '1rem',
                        display: 'flex',
                        flexDirection: 'column',
                        gap: '0.75rem'
                      }}
                    >
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '1rem' }}>
                        <div style={{ flex: 1 }}>
                          <h4 style={{ margin: 0, marginBottom: '0.5rem', fontSize: '1rem', color: '#fff' }}>
                            {mod.name || 'Unknown Mod'}
                          </h4>
                          <div style={{ display: 'flex', gap: '1rem', alignItems: 'center', fontSize: '0.875rem', color: '#888', flexWrap: 'wrap', marginBottom: '0.5rem' }}>
                            <span>
                              <i className="fas fa-user" style={{ marginRight: '0.25rem' }}></i>
                              {mod.author || 'Unknown'}
                            </span>
                            <span>
                              <i className="fas fa-download" style={{ marginRight: '0.25rem' }}></i>
                              {mod.mod_downloads?.toLocaleString() || '0'} downloads
                            </span>
                            {mod.version && (
                              <span>
                                <i className="fas fa-tag" style={{ marginRight: '0.25rem' }}></i>
                                v{mod.version}
                              </span>
                            )}
                            <span>
                              <i className="fas fa-thumbs-up" style={{ marginRight: '0.25rem', color: '#4a90e2' }}></i>
                              {mod.endorsement_count?.toLocaleString() || '0'} endorsements
                            </span>
                          </div>
                          {mod.summary && (
                            <p style={{
                              margin: '0.5rem 0 0.75rem 0',
                              fontSize: '0.875rem',
                              color: '#ccc',
                              lineHeight: '1.5'
                            }}>
                              {mod.summary.length > 200 ? mod.summary.substring(0, 200) + '...' : mod.summary}
                            </p>
                          )}
                        </div>
                        <div style={{ display: 'flex', gap: '0.5rem', flexDirection: 'column' }}>
                          <button
                            onClick={() => handleInstallNexusModsMod(mod.mod_id, bestFile?.file_id)}
                            className={isAlreadyInstalled ? "btn btn-secondary btn-small" : "btn btn-primary btn-small"}
                            disabled={installingNexusMod?.modId === mod.mod_id || !bestFile || isAlreadyInstalled}
                            title={isAlreadyInstalled ? 'This mod is already installed' : bestFile ? `Install ${bestFile.file_name || bestFile.name || 'mod'}` : 'Loading files...'}
                          >
                            {installingNexusMod?.modId === mod.mod_id ? (
                              <>
                                <i className="fas fa-spinner fa-spin"></i>
                                <span style={{ marginLeft: '0.5rem' }}>Installing...</span>
                              </>
                            ) : isAlreadyInstalled ? (
                              <>
                                <i className="fas fa-check"></i>
                                <span style={{ marginLeft: '0.5rem' }}>Installed</span>
                              </>
                            ) : (
                              <>
                                <i className="fas fa-download"></i>
                                <span style={{ marginLeft: '0.5rem' }}>Install</span>
                              </>
                            )}
                          </button>
                          <a
                            href={`https://www.nexusmods.com/schedule1/mods/${mod.mod_id}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="btn btn-secondary btn-small"
                            style={{ textDecoration: 'none', textAlign: 'center' }}
                            title="View on NexusMods"
                          >
                            <i className="fas fa-external-link-alt"></i>
                            <span style={{ marginLeft: '0.5rem' }}>View</span>
                          </a>
                        </div>
                      </div>
                      {runtimeFiles.length > 0 && (
                        <div style={{
                          padding: '0.75rem',
                          backgroundColor: '#1a1a1a',
                          borderRadius: '4px',
                          fontSize: '0.875rem'
                        }}>
                          <div style={{ color: '#888', marginBottom: '0.5rem' }}>
                            <i className="fas fa-file-archive" style={{ marginRight: '0.5rem' }}></i>
                            Available files for {environment?.runtime} ({runtimeFiles.length}):
                          </div>
                          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
                            {runtimeFiles.map((file: any) => {
                              const fileName = file.file_name || file.name || 'Unknown';
                              const isRuntimeMatch = fileName.toLowerCase().includes(runtimeLower);
                              const isBestFile = bestFile?.file_id === file.file_id;
                              return (
                                <div
                                  key={file.file_id}
                                  style={{
                                    display: 'flex',
                                    justifyContent: 'space-between',
                                    alignItems: 'center',
                                    padding: '0.5rem',
                                    backgroundColor: isBestFile ? '#2a4a6a' : 'transparent',
                                    borderRadius: '4px',
                                    border: isBestFile ? '1px solid #4a90e2' : '1px solid transparent'
                                  }}
                                >
                                  <span style={{ color: isRuntimeMatch ? '#4a90e2' : '#ccc', flex: 1 }}>
                                    {fileName}
                                    {isBestFile && (
                                      <span style={{ marginLeft: '0.5rem', color: '#4a90e2', fontSize: '0.75rem' }}>
                                        (Recommended for {environment?.runtime})
                                      </span>
                                    )}
                                  </span>
                                  {file.file_id !== bestFile?.file_id && (
                                    <button
                                      onClick={() => handleInstallNexusModsMod(mod.mod_id, file.file_id)}
                                      className="btn btn-secondary btn-small"
                                      disabled={installingNexusMod?.modId === mod.mod_id}
                                      style={{ padding: '0.25rem 0.5rem', fontSize: '0.75rem' }}
                                    >
                                      Install
                                    </button>
                                  )}
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      )}
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

          <div className="mods-actions" style={{ padding: '0 1.25rem', marginBottom: '1rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '1rem' }}>
            <div style={{ flex: 1 }}>
              {modsDirectory && (
                <p style={{ margin: 0, color: '#888', fontSize: '0.875rem' }}>
                  <i className="fas fa-folder" style={{ marginRight: '0.5rem' }}></i>
                  {modsDirectory}
                </p>
              )}
              <p style={{ margin: '0.35rem 0 0 0', color: '#9aa4b2', fontSize: '0.8rem' }}>
                {mods.length} installed, {mods.filter(m => !!m.disabled).length} disabled, {totalUpdatesAvailable} updates
              </p>
            </div>
            <div style={{ display: 'flex', gap: '0.5rem' }}>
              <button
                onClick={() => {
                  const next = !showSearchInOverlay;
                  setShowSearchInOverlay(next);
                  if (!next) {
                    setShowSearchResults(false);
                    setShowNexusModsResults(false);
                  }
                }}
                className="btn btn-secondary"
                title="Browse mods from Thunderstore/NexusMods"
              >
                <i className="fas fa-compass" style={{ marginRight: '0.5rem' }}></i>
                {showSearchInOverlay ? 'Hide Browse' : 'Browse Mods'}
              </button>
              <button
                onClick={handleCheckModUpdates}
                className="btn btn-secondary"
                disabled={checkingModUpdates}
                title="Check for mod and plugin updates"
              >
                {checkingModUpdates ? (
                  <>
                    <i className="fas fa-spinner fa-spin" style={{ marginRight: '0.5rem' }}></i>
                    Checking...
                  </>
                ) : (
                  <>
                    <i className="fas fa-sync-alt" style={{ marginRight: '0.5rem' }}></i>
                    Check Updates
                  </>
                )}
              </button>
              <button
                onClick={handleUpdateAllMods}
                className="btn btn-primary"
                disabled={updatingAllMods || totalUpdatesAvailable === 0}
                title="Update all supported mods with updates"
              >
                {updatingAllMods ? (
                  <>
                    <i className="fas fa-spinner fa-spin" style={{ marginRight: '0.5rem' }}></i>
                    Updating...
                  </>
                ) : (
                  <>
                    <i className="fas fa-arrow-up" style={{ marginRight: '0.5rem' }}></i>
                    Update All ({totalUpdatesAvailable})
                  </>
                )}
              </button>
              <button
                onClick={handleUploadClick}
                className="btn btn-primary"
                disabled={uploading}
                title="Upload a mod file (.dll, .zip, or .rar)"
              >
                {uploading ? (
                  <>
                    <i className="fas fa-spinner fa-spin" style={{ marginRight: '0.5rem' }}></i>
                    Uploading...
                  </>
                ) : (
                  <>
                    <i className="fas fa-upload" style={{ marginRight: '0.5rem' }}></i>
                    Add Mod
                  </>
                )}
              </button>
              <button
                onClick={handleOpenFolder}
                className="btn btn-secondary"
                title="Open mods folder in file explorer"
              >
                <i className="fas fa-folder-open" style={{ marginRight: '0.5rem' }}></i>
                Open Folder
              </button>
            </div>
          </div>

          {!showSearchResults && loading ? (
            <div style={{ padding: '2rem', textAlign: 'center', color: '#888' }}>
              <i className="fas fa-spinner fa-spin" style={{ fontSize: '2rem', marginBottom: '1rem' }}></i>
              <p>Loading mods...</p>
            </div>
          ) : !showSearchResults && (
            <div style={{ padding: '0 1.25rem 1.25rem', flex: 1, minHeight: 0, overflowY: 'auto' }}>
              <div style={{ display: 'grid', gap: '1rem' }}>
                {/* Regular Mods List */}
                <div style={{ marginBottom: '1.5rem' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem' }}>
                    <h3 style={{ margin: 0, fontSize: '1rem' }}>Library Downloads</h3>
                    <button
                      type="button"
                      className="btn btn-small"
                      onClick={() => void loadDownloadedLibrary()}
                      title="Refresh library list (e.g. after downloading in Library view)"
                      style={{ fontSize: '0.8rem', padding: '0.25rem 0.5rem' }}
                    >
                      <i className="fas fa-sync-alt" style={{ marginRight: '0.25rem' }}></i>
                      Refresh
                    </button>
                  </div>
                  {downloadedNotInstalled.length === 0 ? (
                    <div style={{ padding: '1rem', textAlign: 'center', color: '#888' }}>
                      <p>No downloaded mods waiting to be installed in this environment.</p>
                    </div>
                  ) : (
                    downloadedNotInstalled.map(entry => {
                      const storageId = envRuntime ? entry.storageIdsByRuntime?.[envRuntime] || entry.storageId : entry.storageId;
                      return (
                        <div
                          key={entry.storageId}
                          className="mod-card compact-row"
                          style={{
                            backgroundColor: '#2a2a2a',
                            border: '1px solid #3a3a3a',
                            borderRadius: '7px',
                            padding: '0.65rem 0.75rem',
                            marginBottom: '0.4rem'
                          }}
                        >
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '0.6rem' }}>
                            <div>
                              <strong style={{ fontSize: '0.94rem' }}>{entry.displayName}</strong>
                              <div style={{ fontSize: '0.74rem', color: '#8d9bb0', marginTop: '0.2rem', display: 'flex', gap: '0.45rem', flexWrap: 'wrap' }}>
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
                            </div>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                              <span style={{
                                fontSize: '0.64rem',
                                padding: '0.1rem 0.38rem',
                                borderRadius: '999px',
                                backgroundColor: entry.managed ? '#28a745' : '#6c757d',
                                color: '#fff'
                              }}>
                                {entry.managed ? 'Managed' : 'External'}
                              </span>
                              <button
                                className="btn btn-primary btn-small"
                                disabled={!storageId || installingDownloaded === storageId}
                                onClick={() => handleInstallDownloaded(entry)}
                                title={storageId ? `Install ${entry.displayName}` : 'No compatible runtime found'}
                              >
                                {installingDownloaded === storageId ? 'Installing...' : 'Install'}
                              </button>
                            </div>
                          </div>
                        </div>
                      );
                    })
                  )}
                </div>

                 <h3 style={{ margin: '0 0 0.75rem 0', fontSize: '1rem' }}>Installed Here</h3>
                <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap', marginBottom: '0.75rem' }}>
                  {(['all', 'updates', 'enabled', 'disabled'] as ModListFilter[]).map(filter => (
                    <button
                      key={filter}
                      className="btn btn-small"
                      onClick={() => setModListFilter(filter)}
                      style={{
                        backgroundColor: modListFilter === filter ? '#4a90e2' : '#2a2a2a',
                        border: `1px solid ${modListFilter === filter ? '#4a90e2' : '#3a3a3a'}`,
                        color: modListFilter === filter ? '#fff' : '#ccc'
                      }}
                    >
                      {filter === 'all' ? 'All' : filter === 'updates' ? 'Updates' : filter === 'enabled' ? 'Enabled' : 'Disabled'}
                    </button>
                  ))}
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
                  filteredMods.map((mod) => {
                  const updateInfo = modUpdates.get(mod.fileName);
                  const canAutoUpdate = mod.source === 'thunderstore' || mod.source === 'nexusmods' || mod.source === 'github';
                  const updateAvailable = !!updateInfo?.updateAvailable;
                  const libraryVersionCount = mod.managed
                    ? (libraryVersionCountByName.get(normalizeModNameKey(mod.name)) || 0)
                    : 0;

                  return (
                  <div
                    key={`${mod.fileName}-${mod.path}`}
                    className="mod-card compact-row"
                    style={{
                      backgroundColor: '#2a2a2a',
                      border: '1px solid #3a3a3a',
                      borderRadius: '7px',
                      padding: '0.72rem 0.8rem',
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'flex-start'
                    }}
                  >
                    <div style={{ flex: 1 }}>
                      <h3 style={{ margin: 0, marginBottom: '0.32rem', fontSize: '0.98rem', color: mod.disabled ? '#93a0b2' : '#fff', display: 'flex', alignItems: 'center', gap: '0.42rem', flexWrap: 'wrap' }}>
                        {mod.name}
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
                      <div style={{ display: 'flex', gap: '0.65rem', alignItems: 'center', fontSize: '0.78rem', color: '#8f9cb0', flexWrap: 'wrap' }}>
                        <span>
                          <i className="fas fa-file-code" style={{ marginRight: '0.25rem' }}></i>
                          {mod.fileName}
                        </span>
                        {mod.version && (() => {
                          // Determine color: vibrant green if latest, yellow if needs update, default gray otherwise
                          let versionColor = '#888'; // Default gray

                          if (updateInfo) {
                            // If we have update info, check if it's up to date
                            if (!updateInfo.updateAvailable && updateInfo.latestVersion) {
                              // No update available means it's the latest version
                              versionColor = '#00ff00'; // Vibrant green
                            } else if (updateInfo.updateAvailable) {
                              // Update is available
                              versionColor = '#ffd700'; // Yellow (gold)
                            }
                          }

                          return (
                            <span>
                              <i className="fas fa-tag" style={{ marginRight: '0.25rem', color: versionColor }}></i>
                              <span style={{ color: versionColor, fontWeight: versionColor !== '#888' ? 'bold' : 'normal' }}>
                                Version: {mod.version}
                              </span>
                            </span>
                          );
                        })()}
                        {updateAvailable && updateInfo?.latestVersion && (
                          <span style={{ color: '#ffd700', fontWeight: 600 }}>
                            Update available: {updateInfo.latestVersion}
                          </span>
                        )}
                        {mod.source && (
                          (mod.source === 'thunderstore' || mod.source === 'nexusmods' || mod.source === 'github') && mod.sourceUrl ? (
                            <a
                                href={safeExternalUrl(mod.sourceUrl)}
                                target="_blank"
                                rel="noopener noreferrer"
                                style={{
                                  display: 'inline-flex',
                                  alignItems: 'center',
                                  padding: '0.12rem 0.42rem',
                                  borderRadius: '999px',
                                  backgroundColor: `${getSourceColor(mod.source)}20`,
                                  color: getSourceColor(mod.source),
                                  border: `1px solid ${getSourceColor(mod.source)}40`,
                                textDecoration: 'none',
                                cursor: 'pointer',
                                transition: 'all 0.2s'
                              }}
                              onMouseEnter={(e) => {
                                e.currentTarget.style.backgroundColor = `${getSourceColor(mod.source)}30`;
                                e.currentTarget.style.textDecoration = 'underline';
                              }}
                              onMouseLeave={(e) => {
                                e.currentTarget.style.backgroundColor = `${getSourceColor(mod.source)}20`;
                                e.currentTarget.style.textDecoration = 'none';
                              }}
                              title={`View ${mod.name} on ${getSourceLabel(mod.source)}`}
                              onClick={(e) => {
                                if (!safeExternalUrl(mod.sourceUrl)) {
                                  e.preventDefault();
                                }
                              }}
                            >
                              <i className="fas fa-download" style={{ marginRight: '0.25rem', fontSize: '0.75rem' }}></i>
                              {getSourceLabel(mod.source)}
                            </a>
                          ) : (
                            <span style={{
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
                          )
                        )}
                      </div>
                    </div>
                    <div style={{ display: 'flex', gap: '0.35rem', marginLeft: '0.75rem', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                      {canAutoUpdate && updateAvailable && (
                        <button
                          onClick={() => handleUpdateMod(mod)}
                          className="btn btn-primary btn-small"
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
                          onClick={() => handleEnableMod(mod)}
                          className="btn btn-primary btn-small"
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
                          onClick={() => handleDisableMod(mod)}
                          className="btn btn-secondary btn-small"
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
                        className="btn btn-danger btn-small"
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
                  );
                  })
                )}
              </div>
            </div>
          )}
        </div>
      </div>

    </>
  );
}
