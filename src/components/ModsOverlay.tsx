import React, { useState, useEffect } from 'react';
import { ApiService } from '../services/api';
import { ConfirmOverlay } from './ConfirmOverlay';
import { onModsChanged } from '../services/events';
import { useSettingsStore } from '../stores/settingsStore';
import type { Environment } from '../types';

interface ModInfo {
  name: string;
  fileName: string;
  path: string;
  version?: string;
  source?: 'local' | 'thunderstore' | 'nexusmods' | 'unknown';
  disabled?: boolean;
}

interface Props {
  isOpen: boolean;
  onClose: () => void;
  environmentId: string;
  onModsChanged?: () => void;
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
  total_downloads: number;
  categories?: string[];
  latest: {
    name: string;
    full_name: string;
    owner: string;
    package_url: string;
    date_created: string;
    date_updated: string;
    uuid4: string;
    rating_score: number;
    is_pinned: boolean;
    is_deprecated: boolean;
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
  };
}

export function ModsOverlay({ isOpen, onClose, environmentId, onModsChanged }: Props) {
  const { settings } = useSettingsStore();
  const [mods, setMods] = useState<ModInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [modsDirectory, setModsDirectory] = useState<string>('');
  const [deletingMod, setDeletingMod] = useState<string | null>(null);
  const [enablingMod, setEnablingMod] = useState<string | null>(null);
  const [disablingMod, setDisablingMod] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [pendingUpload, setPendingUpload] = useState<{ file: File; runtimeMismatch: { detected: 'IL2CPP' | 'Mono' | 'unknown'; environment: 'IL2CPP' | 'Mono'; warning: string } } | null>(null);
  const fileInputRef = React.useRef<HTMLInputElement>(null);
  
  // Search state
  const [environment, setEnvironment] = useState<Environment | null>(null);
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [searchResults, setSearchResults] = useState<ThunderstorePackage[]>([]);
  const [searching, setSearching] = useState(false);
  const [installingPackage, setInstallingPackage] = useState<string | null>(null);
  const [showSearchResults, setShowSearchResults] = useState(false);
  
  // Mod updates state
  const [modUpdates, setModUpdates] = useState<Map<string, { updateAvailable: boolean; currentVersion?: string; latestVersion?: string }>>(new Map());
  
  // S1API state
  const [s1apiStatus, setS1apiStatus] = useState<{
    installed: boolean;
    enabled: boolean;
    version?: string;
  } | null>(null);
  const [s1apiLatestRelease, setS1apiLatestRelease] = useState<{
    tag_name: string;
    name: string;
    published_at: string;
    prerelease: boolean;
    download_url: string | null;
  } | null>(null);
  const [s1apiReleases, setS1apiReleases] = useState<Array<{
    tag_name: string;
    name: string;
    published_at: string;
    prerelease: boolean;
    download_url: string | null;
    body?: string;
  }>>([]);
  const [loadingS1APIReleases, setLoadingS1APIReleases] = useState(false);
  const [showS1APIVersionSelector, setShowS1APIVersionSelector] = useState(false);
  const [selectedS1APIVersion, setSelectedS1APIVersion] = useState<string>('');
  const [installingS1API, setInstallingS1API] = useState(false);
  const [uninstallingS1API, setUninstallingS1API] = useState(false);

  useEffect(() => {
    if (isOpen && environmentId) {
      loadEnvironment();
      loadMods();
      loadS1APIStatus();
      
      // Listen for filesystem changes
      let unlistenModsChanged: (() => void) | null = null;
      
      const setupListener = async () => {
        try {
          unlistenModsChanged = await onModsChanged((data) => {
            if (data.environmentId === environmentId) {
              loadMods();
              loadS1APIStatus();
              if (onModsChanged) {
                onModsChanged();
              }
            }
          });
        } catch (error) {
          console.error('Failed to set up mods changed listener:', error);
        }
      };
      
      setupListener();
      
      return () => {
        if (unlistenModsChanged) unlistenModsChanged();
      };
    } else {
      // Reset state when closing
      setMods([]);
      setError(null);
      setModsDirectory('');
      setEnvironment(null);
      setSearchQuery('');
      setSearchResults([]);
      setShowSearchResults(false);
      setModUpdates(new Map());
      setS1apiStatus(null);
      setS1apiLatestRelease(null);
      setS1apiReleases([]);
      setShowS1APIVersionSelector(false);
      setSelectedS1APIVersion('');
    }
  }, [isOpen, environmentId]);

  const loadEnvironment = async () => {
    try {
      const env = await ApiService.getEnvironment(environmentId);
      setEnvironment(env);
    } catch (err) {
      console.error('Failed to load environment:', err);
    }
  };

  const loadMods = async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await ApiService.getMods(environmentId);
      // Filter out S1API component files on the frontend as well (in case backend filtering fails)
      const filteredMods = result.mods.filter(mod => {
        const lowerName = mod.fileName.toLowerCase();
        return !(lowerName === 's1api.mono.melonloader.dll' ||
                 lowerName === 's1api.il2cpp.melonloader.dll' ||
                 (lowerName.startsWith('s1api') && lowerName.includes('.') && lowerName.endsWith('.dll')));
      });
      setMods(filteredMods);
      setModsDirectory(result.modsDirectory);
      
      // Load update information
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
      } catch (updateErr) {
        // Fail silently - updates are nice to have but not critical
        console.warn('Failed to load mod updates:', updateErr);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load mods');
      setMods([]);
    } finally {
      setLoading(false);
    }
  };

  const loadS1APIStatus = async () => {
    try {
      const status = await ApiService.getS1APIStatus(environmentId);
      setS1apiStatus(status);
      
      // Only check for updates if S1API is installed and we have a version
      if (status.installed && status.version) {
        // Get all releases (including prereleases) to find the actual latest
        try {
          const allReleases = await ApiService.getS1APIReleases(environmentId);
          if (allReleases.length > 0) {
            // Find the release that matches the installed version
            const installedRelease = allReleases.find(r => r.tag_name === status.version);
            // Get the latest release (first in the list, sorted newest first)
            const latestRelease = allReleases[0];
            
            // Only show update available if the latest release is different from installed
            // and the installed version is not the latest
            if (installedRelease && latestRelease.tag_name !== status.version) {
              setS1apiLatestRelease(latestRelease);
            } else {
              setS1apiLatestRelease(null);
            }
          }
        } catch (releaseErr) {
          // Fail silently if release fetch fails
          console.warn('Failed to load S1API releases for update check:', releaseErr);
        }
      } else {
        // If not installed, get the latest release for the install button
        try {
          const latestRelease = await ApiService.getS1APILatestRelease(environmentId);
          setS1apiLatestRelease(latestRelease);
        } catch (releaseErr) {
          // Fail silently
          console.warn('Failed to load latest S1API release:', releaseErr);
        }
      }
    } catch (err) {
      console.warn('Failed to load S1API status:', err);
      // Set default status if API call fails
      setS1apiStatus({ installed: false, enabled: false });
    }
  };

  const loadS1APIReleases = async () => {
    setLoadingS1APIReleases(true);
    try {
      const releases = await ApiService.getS1APIReleases(environmentId);
      setS1apiReleases(releases);
      // Set default selection to latest (first in the list, which is sorted newest first)
      if (releases.length > 0) {
        setSelectedS1APIVersion(releases[0].tag_name);
      }
    } catch (err) {
      console.error('Failed to load S1API releases:', err);
      setError('Failed to load S1API releases');
    } finally {
      setLoadingS1APIReleases(false);
    }
  };

  const handleInstallS1APIClick = () => {
    // Load releases and show version selector
    loadS1APIReleases();
    setShowS1APIVersionSelector(true);
  };

  const handleS1APIVersionSelected = async () => {
    if (!selectedS1APIVersion) {
      setError('Please select a version');
      return;
    }

    setShowS1APIVersionSelector(false);
    setInstallingS1API(true);
    setError(null);
    
    try {
      const result = await ApiService.installS1API(environmentId, selectedS1APIVersion);
      if (result.success) {
        await loadS1APIStatus();
        await loadMods();
        if (onModsChanged) {
          onModsChanged();
        }
        setSelectedS1APIVersion('');
        setS1apiReleases([]); // Clear releases list after installation
      } else {
        setError(result.error || 'Failed to install S1API');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to install S1API');
    } finally {
      setInstallingS1API(false);
    }
  };

  const handleUninstallS1API = async () => {
    if (!confirm('Are you sure you want to uninstall S1API? This will remove all S1API components (Mono, IL2CPP, and plugin).')) {
      return;
    }

    setUninstallingS1API(true);
    setError(null);
    try {
      const result = await ApiService.uninstallS1API(environmentId);
      if (result.success) {
        await loadS1APIStatus();
        await loadMods();
        if (onModsChanged) {
          onModsChanged();
        }
      } else {
        setError(result.error || 'Failed to uninstall S1API');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to uninstall S1API');
    } finally {
      setUninstallingS1API(false);
    }
  };

  const handleDeleteMod = async (mod: ModInfo) => {
    if (!confirm(`Are you sure you want to delete "${mod.name}"?`)) {
      return;
    }

    setDeletingMod(mod.fileName);
    try {
      await ApiService.deleteMod(environmentId, mod.fileName);
      // Reload mods list after deletion
      await loadMods();
      // Notify parent that mods changed (so it can refresh the count)
      if (onModsChanged) {
        onModsChanged();
      }
    } catch (err) {
      alert(`Failed to delete mod: ${err instanceof Error ? err.message : 'Unknown error'}`);
    } finally {
      setDeletingMod(null);
    }
  };

  const handleDisableMod = async (mod: ModInfo) => {
    setDisablingMod(mod.fileName);
    try {
      await ApiService.disableMod(environmentId, mod.fileName);
      // Reload mods list after disabling
      await loadMods();
      if (onModsChanged) {
        onModsChanged();
      }
    } catch (err) {
      alert(`Failed to disable mod: ${err instanceof Error ? err.message : 'Unknown error'}`);
    } finally {
      setDisablingMod(null);
    }
  };

  const handleEnableMod = async (mod: ModInfo) => {
    setEnablingMod(mod.fileName);
    try {
      await ApiService.enableMod(environmentId, mod.fileName);
      // Reload mods list after enabling
      await loadMods();
      if (onModsChanged) {
        onModsChanged();
      }
    } catch (err) {
      alert(`Failed to enable mod: ${err instanceof Error ? err.message : 'Unknown error'}`);
    } finally {
      setEnablingMod(null);
    }
  };

  const handleOpenFolder = async () => {
    try {
      await ApiService.openModsFolder(environmentId);
    } catch (err) {
      alert(`Failed to open mods folder: ${err instanceof Error ? err.message : 'Unknown error'}`);
    }
  };

  const handleUploadClick = () => {
    fileInputRef.current?.click();
  };

  const handleFileChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    setUploading(true);
    setError(null);

    try {
      const result = await ApiService.uploadMod(environmentId, file);
      
      if (result.success) {
        // Check for runtime mismatch - mod is already installed, just show warning
        if (result.runtimeMismatch && result.runtimeMismatch.requiresConfirmation) {
          // Store the mismatch info to show confirmation dialog
          setPendingUpload({ file, runtimeMismatch: result.runtimeMismatch });
          // Mod is already installed, so we can proceed with success handling
          // but show the warning dialog first
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

  const handleUploadSuccess = async () => {
    // Reload mods list after successful upload
    await loadMods();
    // Notify parent that mods changed
    if (onModsChanged) {
      onModsChanged();
    }
    // Clear file input
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
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
      setSearchResults(result.packages || []);
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
      const result = await ApiService.installThunderstoreMod(environmentId, pkg.uuid4);
      
      if (result.success) {
        // Check for runtime mismatch
        if (result.runtimeMismatch && result.runtimeMismatch.requiresConfirmation) {
          // Show confirmation dialog
          if (!confirm(result.runtimeMismatch.warning)) {
            setInstallingPackage(null);
            return;
          }
        }
        
        // Reload mods after installation
        await loadMods();
        if (onModsChanged) {
          onModsChanged();
        }
        
        // Close search results
        setShowSearchResults(false);
        setSearchQuery('');
      } else {
        setError(result.error || 'Failed to install mod');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to install mod');
    } finally {
      setInstallingPackage(null);
    }
  };

  const handleSearchKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      handleSearch();
    }
  };

  const getSourceLabel = (source?: string): string => {
    switch (source) {
      case 'thunderstore':
        return 'ThunderStore';
      case 'nexusmods':
        return 'NexusMods';
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
      case 'local':
        return '#34a853'; // Green
      default:
        return '#888';
    }
  };

  if (!isOpen) return null;

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
      />
      <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content mods-overlay" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>Installed Mods</h2>
          <button className="modal-close" onClick={onClose}>×</button>
        </div>

        <div className="mods-content">
          {error && (
            <div className="error-message" style={{ margin: '0 1.25rem', padding: '0.75rem', backgroundColor: '#dc3545', color: '#fff', borderRadius: '4px' }}>
              {error}
            </div>
          )}

          {/* Thunderstore Search Bar */}
          {environment && (
            <div style={{ padding: '0 1.25rem', marginBottom: '1rem', borderBottom: '1px solid #3a3a3a', paddingBottom: '1rem' }}>
              <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                <div style={{ flex: 1, position: 'relative' }}>
                  <input
                    type="text"
                    placeholder={`Search Thunderstore for ${environment.runtime} mods...`}
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
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
                    onClick={handleSearch}
                  ></i>
                </div>
                <button
                  onClick={handleSearch}
                  className="btn btn-primary"
                  disabled={searching || !searchQuery.trim()}
                  style={{ whiteSpace: 'nowrap' }}
                >
                  {searching ? (
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
                {showSearchResults && (
                  <button
                    onClick={() => {
                      setShowSearchResults(false);
                      setSearchQuery('');
                      setSearchResults([]);
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
                  Filtering mods for Schedule I - <strong>{environment.runtime}</strong> runtime
                </p>
              )}
            </div>
          )}

          {/* Search Results - Loading State */}
          {searching && (
            <div style={{ padding: '2rem', textAlign: 'center', color: '#888' }}>
              <i className="fas fa-spinner fa-spin" style={{ fontSize: '2rem', marginBottom: '1rem' }}></i>
              <p>Searching Thunderstore...</p>
            </div>
          )}

          {/* Search Results */}
          {!searching && showSearchResults && searchResults.length > 0 && (
            <div style={{ padding: '0 1.25rem', marginBottom: '1rem', maxHeight: '400px', overflowY: 'auto' }}>
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
                        {pkg.name || (pkg.latest?.full_name ? pkg.latest.full_name.split('-').slice(1).join('-') : 'Unknown Mod')}
                      </h4>
                      <div style={{ display: 'flex', gap: '1rem', alignItems: 'center', fontSize: '0.875rem', color: '#888', flexWrap: 'wrap', marginBottom: '0.5rem' }}>
                        <span>
                          <i className="fas fa-user" style={{ marginRight: '0.25rem' }}></i>
                          {pkg.owner || 'Unknown'}
                        </span>
                        <span>
                          <i className="fas fa-download" style={{ marginRight: '0.25rem' }}></i>
                          {(pkg.total_downloads || 0).toLocaleString()} downloads
                        </span>
                        {pkg.latest?.versions?.[0]?.version_number && (
                          <span>
                            <i className="fas fa-tag" style={{ marginRight: '0.25rem' }}></i>
                            v{pkg.latest.versions[0].version_number}
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
                      {(pkg.latest?.versions?.[0]?.description && pkg.latest.versions[0].description.trim()) && (
                        <p style={{ margin: '0 0 0.5rem 0', fontSize: '0.875rem', color: '#aaa', lineHeight: '1.4' }}>
                          {pkg.latest.versions[0].description.length > 150 
                            ? pkg.latest.versions[0].description.substring(0, 150) + '...' 
                            : pkg.latest.versions[0].description}
                        </p>
                      )}
                      <div style={{ display: 'flex', gap: '1rem', alignItems: 'center', fontSize: '0.75rem', color: '#888', flexWrap: 'wrap' }}>
                        {pkg.latest?.versions?.[0]?.file_size && (
                          <span>
                            Size: {(pkg.latest.versions[0].file_size / 1024 / 1024).toFixed(2)} MB
                          </span>
                        )}
                        {(pkg.date_updated || pkg.latest?.date_updated) && (() => {
                          const updateDate = new Date(pkg.date_updated || pkg.latest?.date_updated || '');
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
                        title={`Install ${pkg.latest?.full_name || pkg.name || 'mod'}`}
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
                        href={pkg.package_url || pkg.latest?.package_url || '#'}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="btn btn-secondary btn-small"
                        style={{ textDecoration: 'none', textAlign: 'center' }}
                        title="View on Thunderstore"
                        onClick={(e) => {
                          if (!pkg.package_url && !pkg.latest?.package_url) {
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

          <div className="mods-actions" style={{ padding: '0 1.25rem', marginBottom: '1rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '1rem' }}>
            <div style={{ flex: 1 }}>
              {modsDirectory && (
                <p style={{ margin: 0, color: '#888', fontSize: '0.875rem' }}>
                  <i className="fas fa-folder" style={{ marginRight: '0.5rem' }}></i>
                  {modsDirectory}
                </p>
              )}
            </div>
            <div style={{ display: 'flex', gap: '0.5rem' }}>
              <input
                ref={fileInputRef}
                type="file"
                accept=".dll,.zip"
                onChange={handleFileChange}
                style={{ display: 'none' }}
              />
              <button
                onClick={handleUploadClick}
                className="btn btn-primary"
                disabled={uploading}
                title="Upload a mod file (.dll or .zip)"
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
            <div style={{ padding: '0 1.25rem 1.25rem', maxHeight: '500px', overflowY: 'auto' }}>
              <div style={{ display: 'grid', gap: '1rem' }}>
                {/* S1API Special Entry */}
                {s1apiStatus !== null && (
                  <div
                    className="mod-card"
                    style={{
                      backgroundColor: '#2a2a2a',
                      border: '2px solid',
                      borderColor: s1apiStatus.installed && s1apiStatus.enabled ? '#4a90e2' : '#3a3a3a',
                      borderRadius: '8px',
                      padding: '1rem',
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center'
                    }}
                  >
                    <div style={{ flex: 1 }}>
                      <h3 style={{ margin: 0, marginBottom: '0.5rem', fontSize: '1.1rem', color: '#fff', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                        S1API
                        {s1apiStatus.installed && s1apiStatus.enabled && (
                          <span style={{ 
                            fontSize: '0.75rem', 
                            padding: '0.25rem 0.5rem', 
                            backgroundColor: '#4a90e220',
                            color: '#4a90e2',
                            borderRadius: '4px',
                            border: '1px solid #4a90e240'
                          }}>
                            Installed
                          </span>
                        )}
                        {s1apiStatus.installed && !s1apiStatus.enabled && (
                          <span style={{ 
                            fontSize: '0.75rem', 
                            padding: '0.25rem 0.5rem', 
                            backgroundColor: '#88820',
                            color: '#888',
                            borderRadius: '4px',
                            border: '1px solid #88840'
                          }}>
                            Installed (Wrong Runtime)
                          </span>
                        )}
                        {!s1apiStatus.installed && (
                          <span style={{ 
                            fontSize: '0.75rem', 
                            padding: '0.25rem 0.5rem', 
                            backgroundColor: '#88820',
                            color: '#888',
                            borderRadius: '4px',
                            border: '1px solid #88840'
                          }}>
                            Not Installed
                          </span>
                        )}
                      </h3>
                      <div style={{ display: 'flex', gap: '1rem', alignItems: 'center', fontSize: '0.875rem', color: '#888', flexWrap: 'wrap' }}>
                        <span>
                          <i className="fab fa-github" style={{ marginRight: '0.25rem', color: '#6e5494' }}></i>
                          GitHub Release
                        </span>
                        {s1apiStatus.installed && s1apiStatus.version && (
                          <span>
                            <i className="fas fa-tag" style={{ marginRight: '0.25rem', color: '#888' }}></i>
                            <span style={{ color: '#888' }}>
                              Version: {s1apiStatus.version}
                            </span>
                          </span>
                        )}
                        {s1apiStatus.installed && s1apiLatestRelease && s1apiStatus.version && s1apiLatestRelease.tag_name !== s1apiStatus.version && (
                          <span>
                            <i className="fas fa-exclamation-triangle" style={{ marginRight: '0.25rem', color: '#ffd700' }}></i>
                            <span style={{ color: '#ffd700' }}>
                              Update Available: {s1apiLatestRelease.tag_name}
                            </span>
                          </span>
                        )}
                      </div>
                    </div>
                    <div style={{ display: 'flex', gap: '0.5rem', marginLeft: '1rem' }}>
                      {!s1apiStatus.installed ? (
                        <button
                          onClick={handleInstallS1APIClick}
                          className="btn btn-primary btn-small"
                          disabled={installingS1API}
                          title="Install S1API from GitHub"
                        >
                          {installingS1API ? (
                            <i className="fas fa-spinner fa-spin"></i>
                          ) : (
                            <>
                              <i className="fas fa-download"></i>
                              <span style={{ marginLeft: '0.5rem' }}>Install</span>
                            </>
                          )}
                        </button>
                      ) : (
                        <>
                          {s1apiLatestRelease && s1apiStatus.version && s1apiLatestRelease.tag_name !== s1apiStatus.version && (
                            <button
                              onClick={handleInstallS1APIClick}
                              className="btn btn-primary btn-small"
                              disabled={installingS1API}
                              title="Update S1API"
                            >
                              {installingS1API ? (
                                <i className="fas fa-spinner fa-spin"></i>
                              ) : (
                                <>
                                  <i className="fas fa-sync-alt"></i>
                                  <span style={{ marginLeft: '0.5rem' }}>Update</span>
                                </>
                              )}
                            </button>
                          )}
                          <button
                            onClick={handleUninstallS1API}
                            className="btn btn-danger btn-small"
                            disabled={uninstallingS1API}
                            title="Uninstall S1API"
                          >
                            {uninstallingS1API ? (
                              <i className="fas fa-spinner fa-spin"></i>
                            ) : (
                              <>
                                <i className="fas fa-trash"></i>
                                <span style={{ marginLeft: '0.5rem' }}>Uninstall</span>
                              </>
                            )}
                          </button>
                        </>
                      )}
                      <a
                        href="https://github.com/ifBars/S1API"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="btn btn-secondary btn-small"
                        style={{ textDecoration: 'none', textAlign: 'center' }}
                        title="View on GitHub"
                      >
                        <i className="fab fa-github"></i>
                        <span style={{ marginLeft: '0.5rem' }}>View</span>
                      </a>
                    </div>
                  </div>
                )}
                
                {/* Regular Mods List */}
                {mods.length === 0 ? (
                  <div style={{ padding: '2rem', textAlign: 'center', color: '#888' }}>
                    <i className="fas fa-box-open" style={{ fontSize: '2rem', marginBottom: '1rem' }}></i>
                    <p>No other mods found</p>
                    <p style={{ fontSize: '0.875rem', marginTop: '0.5rem' }}>
                      Mods should be placed in the Mods directory as .dll files
                    </p>
                  </div>
                ) : (
                  mods.map((mod) => (
                  <div
                    key={mod.fileName}
                    className="mod-card"
                    style={{
                      backgroundColor: '#2a2a2a',
                      border: '1px solid #3a3a3a',
                      borderRadius: '8px',
                      padding: '1rem',
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center'
                    }}
                  >
                    <div style={{ flex: 1 }}>
                      <h3 style={{ margin: 0, marginBottom: '0.5rem', fontSize: '1.1rem', color: mod.disabled ? '#888' : '#fff', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                        {mod.name}
                        {mod.disabled && (
                          <span style={{ 
                            fontSize: '0.75rem', 
                            padding: '0.25rem 0.5rem', 
                            backgroundColor: '#ff6b6b20',
                            color: '#ff6b6b',
                            borderRadius: '4px',
                            border: '1px solid #ff6b6b40'
                          }}>
                            Disabled
                          </span>
                        )}
                      </h3>
                      <div style={{ display: 'flex', gap: '1rem', alignItems: 'center', fontSize: '0.875rem', color: '#888', flexWrap: 'wrap' }}>
                        <span>
                          <i className="fas fa-file-code" style={{ marginRight: '0.25rem' }}></i>
                          {mod.fileName}
                        </span>
                        {mod.version && (() => {
                          const updateInfo = modUpdates.get(mod.fileName);
                          
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
                        {mod.source && (
                          <span style={{ 
                            display: 'inline-flex', 
                            alignItems: 'center', 
                            padding: '0.25rem 0.5rem', 
                            borderRadius: '4px', 
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
                    <div style={{ display: 'flex', gap: '0.5rem', marginLeft: '1rem' }}>
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
                        onClick={() => handleDeleteMod(mod)}
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
                  ))
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>

    {/* S1API Version Selector Modal */}
    {showS1APIVersionSelector && (
      <div className="modal-overlay" onClick={(e) => {
        if (e.target === e.currentTarget) {
          setShowS1APIVersionSelector(false);
          setSelectedS1APIVersion('');
        }
      }}>
        <div className="modal-content" onClick={(e) => e.stopPropagation()} style={{ maxWidth: '600px' }}>
          <div className="modal-header">
            <h2>Select S1API Version</h2>
            <button className="modal-close" onClick={() => {
              setShowS1APIVersionSelector(false);
              setSelectedS1APIVersion('');
            }}>×</button>
          </div>

          <div style={{ padding: '1.25rem' }}>
            <p style={{ marginBottom: '1rem', color: '#ccc', fontSize: '0.9rem', lineHeight: '1.5' }}>
              S1API is very game version specific, so it's important to select the version that matches your game version. If you're not sure which version to choose, we recommend checking the changelog for each release to see which game version it supports.
            </p>

            {loadingS1APIReleases ? (
              <div style={{ padding: '2rem', textAlign: 'center', color: '#888' }}>
                <i className="fas fa-spinner fa-spin" style={{ fontSize: '2rem', marginBottom: '1rem' }}></i>
                <p>Loading releases...</p>
              </div>
            ) : s1apiReleases.length === 0 ? (
              <div style={{ padding: '2rem', textAlign: 'center', color: '#888' }}>
                <p>No releases found</p>
              </div>
            ) : (
              <>
                <div style={{ marginBottom: '1rem', maxHeight: '400px', overflowY: 'auto' }}>
                  <div style={{ display: 'grid', gap: '0.5rem' }}>
                    {s1apiReleases.map((release) => (
                      <label
                        key={release.tag_name}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          padding: '0.75rem',
                          backgroundColor: selectedS1APIVersion === release.tag_name ? '#3a3a3a' : '#2a2a2a',
                          border: '1px solid',
                          borderColor: selectedS1APIVersion === release.tag_name ? '#4a90e2' : '#3a3a3a',
                          borderRadius: '6px',
                          cursor: 'pointer',
                          transition: 'all 0.2s'
                        }}
                        onMouseEnter={(e) => {
                          if (selectedS1APIVersion !== release.tag_name) {
                            e.currentTarget.style.backgroundColor = '#333';
                          }
                        }}
                        onMouseLeave={(e) => {
                          if (selectedS1APIVersion !== release.tag_name) {
                            e.currentTarget.style.backgroundColor = '#2a2a2a';
                          }
                        }}
                      >
                        <input
                          type="radio"
                          name="s1apiVersion"
                          value={release.tag_name}
                          checked={selectedS1APIVersion === release.tag_name}
                          onChange={(e) => setSelectedS1APIVersion(e.target.value)}
                          style={{ marginRight: '0.75rem', cursor: 'pointer' }}
                        />
                        <div style={{ flex: 1 }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.25rem' }}>
                            <strong style={{ color: '#fff' }}>{release.tag_name}</strong>
                            {release.prerelease && (
                              <span style={{
                                fontSize: '0.7rem',
                                padding: '0.15rem 0.4rem',
                                backgroundColor: '#ffd70020',
                                color: '#ffd700',
                                borderRadius: '4px',
                                border: '1px solid #ffd70040'
                              }}>
                                Beta
                              </span>
                            )}
                          </div>
                          {release.name && (
                            <div style={{ fontSize: '0.85rem', color: '#aaa', marginBottom: '0.25rem' }}>
                              {release.name}
                            </div>
                          )}
                          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' }}>
                            <div style={{ fontSize: '0.75rem', color: '#888' }}>
                              Published: {new Date(release.published_at).toLocaleDateString()}
                            </div>
                            <a
                              href={`https://github.com/ifBars/S1API/releases/tag/${release.tag_name}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              onClick={(e) => e.stopPropagation()}
                              style={{
                                fontSize: '0.75rem',
                                color: '#4a90e2',
                                textDecoration: 'none',
                                display: 'inline-flex',
                                alignItems: 'center',
                                gap: '0.25rem',
                                transition: 'color 0.2s'
                              }}
                              onMouseEnter={(e) => {
                                e.currentTarget.style.color = '#6ba3f5';
                                e.currentTarget.style.textDecoration = 'underline';
                              }}
                              onMouseLeave={(e) => {
                                e.currentTarget.style.color = '#4a90e2';
                                e.currentTarget.style.textDecoration = 'none';
                              }}
                              title="View release page and changelog"
                            >
                              <i className="fas fa-external-link-alt" style={{ fontSize: '0.7rem' }}></i>
                              View Release & Changelog
                            </a>
                          </div>
                        </div>
                      </label>
                    ))}
                  </div>
                </div>

                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.5rem', marginTop: '1rem' }}>
                  <button
                    className="btn btn-secondary"
                    onClick={() => {
                      setShowS1APIVersionSelector(false);
                      setSelectedS1APIVersion('');
                    }}
                  >
                    Cancel
                  </button>
                  <button
                    className="btn btn-primary"
                    onClick={handleS1APIVersionSelected}
                    disabled={!selectedS1APIVersion || installingS1API}
                  >
                    {installingS1API ? (
                      <>
                        <i className="fas fa-spinner fa-spin" style={{ marginRight: '0.5rem' }}></i>
                        Installing...
                      </>
                    ) : (
                      <>
                        <i className="fas fa-download" style={{ marginRight: '0.5rem' }}></i>
                        Install
                      </>
                    )}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    )}
    </>
  );
}

