import React, { useState, useEffect } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import { ApiService } from '../services/api';
import { ConfirmOverlay } from './ConfirmOverlay';

interface PluginInfo {
  name: string;
  fileName: string;
  path: string;
  version?: string;
  source?: 'local' | 'thunderstore' | 'nexusmods' | 'unknown';
  relatedMod?: string;
}

interface Props {
  isOpen: boolean;
  onClose: () => void;
  environmentId: string;
  onPluginsChanged?: () => void;
}

export function PluginsOverlay({ isOpen, onClose, environmentId, onPluginsChanged }: Props) {
  const [plugins, setPlugins] = useState<PluginInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pluginsDirectory, setPluginsDirectory] = useState<string>('');
  const [deletingPlugin, setDeletingPlugin] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [pendingUpload, setPendingUpload] = useState<{ file: null; runtimeMismatch: { detected: 'IL2CPP' | 'Mono' | 'unknown'; environment: 'IL2CPP' | 'Mono'; warning: string } } | null>(null);
  const [environment, setEnvironment] = useState<import('../types').Environment | null>(null);
  
  // MLVScan state
  const [mlvscanStatus, setMlvscanStatus] = useState<{
    installed: boolean;
    enabled: boolean;
    version?: string;
  } | null>(null);
  const [mlvscanLatestRelease, setMlvscanLatestRelease] = useState<{
    tag_name: string;
    name: string;
    published_at: string;
    prerelease: boolean;
    download_url: string | null;
  } | null>(null);
  const [mlvscanReleases, setMlvscanReleases] = useState<Array<{
    tag_name: string;
    name: string;
    published_at: string;
    prerelease: boolean;
    download_url: string | null;
    body?: string;
  }>>([]);
  const [showMlvscanVersionSelector, setShowMlvscanVersionSelector] = useState(false);
  const [selectedMlvscanVersion, setSelectedMlvscanVersion] = useState<string>('');
  const [installingMlvscan, setInstallingMlvscan] = useState(false);
  const [uninstallingMlvscan, setUninstallingMlvscan] = useState(false);
  const [loadingMlvscanReleases, setLoadingMlvscanReleases] = useState(false);

  useEffect(() => {
    if (isOpen && environmentId) {
      loadEnvironment();
      loadPlugins();
      loadMlvscanStatus();
    } else {
      // Reset state when closing
      setPlugins([]);
      setError(null);
      setPluginsDirectory('');
      setMlvscanStatus(null);
      setMlvscanLatestRelease(null);
      setMlvscanReleases([]);
      setShowMlvscanVersionSelector(false);
      setSelectedMlvscanVersion('');
      setEnvironment(null);
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

  const loadPlugins = async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await ApiService.getPlugins(environmentId);
      // Filter out MLVScan.dll from the regular plugins list
      const filteredPlugins = result.plugins.filter(plugin => 
        plugin.fileName.toLowerCase() !== 'mlvscan.dll'
      );
      setPlugins(filteredPlugins);
      setPluginsDirectory(result.pluginsDirectory);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load plugins');
      setPlugins([]);
    } finally {
      setLoading(false);
    }
  };

  const loadMlvscanStatus = async () => {
    try {
      const status = await ApiService.getMLVScanStatus(environmentId);
      setMlvscanStatus(status);
      
      // Only check for updates if MLVScan is installed and we have a version
      if (status.installed && status.version) {
        // Get all releases (including prereleases) to find the actual latest
        try {
          const allReleases = await ApiService.getMLVScanReleases(environmentId);
          if (allReleases.length > 0) {
            // Find the release that matches the installed version
            const installedRelease = allReleases.find(r => r.tag_name === status.version);
            // Get the latest release (first in the list, sorted newest first)
            const latestRelease = allReleases[0];
            
            // Only show update available if the latest release is different from installed
            // and the installed version is not the latest
            if (installedRelease && latestRelease.tag_name !== status.version) {
              setMlvscanLatestRelease(latestRelease);
            } else {
              setMlvscanLatestRelease(null);
            }
          }
        } catch (releaseErr) {
          // Fail silently if release fetch fails
          console.warn('Failed to load MLVScan releases for update check:', releaseErr);
        }
      } else {
        // If not installed, get the latest release for the install button
        try {
          const latestRelease = await ApiService.getMLVScanLatestRelease(environmentId);
          setMlvscanLatestRelease(latestRelease);
        } catch (releaseErr) {
          // Fail silently
          console.warn('Failed to load latest MLVScan release:', releaseErr);
        }
      }
    } catch (err) {
      console.warn('Failed to load MLVScan status:', err);
      // Set default status if API call fails
      setMlvscanStatus({ installed: false, enabled: false });
    }
  };

  const loadMlvscanReleases = async () => {
    setLoadingMlvscanReleases(true);
    try {
      const releases = await ApiService.getMLVScanReleases(environmentId);
      setMlvscanReleases(releases);
      // Set default selection to latest (first in the list, which is sorted newest first)
      if (releases.length > 0) {
        setSelectedMlvscanVersion(releases[0].tag_name);
      }
    } catch (err) {
      console.error('Failed to load MLVScan releases:', err);
      setError('Failed to load MLVScan releases');
    } finally {
      setLoadingMlvscanReleases(false);
    }
  };

  const handleInstallMlvscanClick = () => {
    // Load releases and show version selector
    loadMlvscanReleases();
    setShowMlvscanVersionSelector(true);
  };

  const handleMlvscanVersionSelected = async () => {
    if (!selectedMlvscanVersion) {
      setError('Please select a version');
      return;
    }

    setShowMlvscanVersionSelector(false);
    setInstallingMlvscan(true);
    setError(null);
    
    try {
      const result = await ApiService.installMLVScan(environmentId, selectedMlvscanVersion);
      if (result.success) {
        await loadMlvscanStatus();
        await loadPlugins();
        if (onPluginsChanged) {
          onPluginsChanged();
        }
        setSelectedMlvscanVersion('');
        setMlvscanReleases([]); // Clear releases list after installation
      } else {
        setError(result.error || 'Failed to install MLVScan');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to install MLVScan');
    } finally {
      setInstallingMlvscan(false);
    }
  };

  const handleUninstallMlvscan = async () => {
    if (!confirm('Are you sure you want to uninstall MLVScan? This will remove the malware scanning plugin.')) {
      return;
    }

    setUninstallingMlvscan(true);
    setError(null);
    try {
      const result = await ApiService.uninstallMLVScan(environmentId);
      if (result.success) {
        await loadMlvscanStatus();
        await loadPlugins();
        if (onPluginsChanged) {
          onPluginsChanged();
        }
      } else {
        setError(result.error || 'Failed to uninstall MLVScan');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to uninstall MLVScan');
    } finally {
      setUninstallingMlvscan(false);
    }
  };

  const handleDeletePlugin = async (plugin: PluginInfo) => {
    if (!confirm(`Are you sure you want to delete "${plugin.name}"?`)) {
      return;
    }

    setDeletingPlugin(plugin.fileName);
    try {
      await ApiService.deletePlugin(environmentId, plugin.fileName);
      // Reload plugins list after deletion
      await loadPlugins();
      // Notify parent that plugins changed (so it can refresh the count)
      if (onPluginsChanged) {
        onPluginsChanged();
      }
    } catch (err) {
      alert(`Failed to delete plugin: ${err instanceof Error ? err.message : 'Unknown error'}`);
    } finally {
      setDeletingPlugin(null);
    }
  };

  const handleOpenFolder = async () => {
    try {
      await ApiService.openPluginsFolder(environmentId);
    } catch (err) {
      alert(`Failed to open plugins folder: ${err instanceof Error ? err.message : 'Unknown error'}`);
    }
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
          name: 'Plugin Files',
          extensions: ['dll', 'zip']
        }],
        title: 'Select Plugin File',
      });

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
        // FileEntry object
        filePath = selected.path;
        fileName = selected.name || filePath.split(/[/\\]/).pop() || 'unknown';
      }

      // Call upload with file path and runtime
      const result = await ApiService.uploadPlugin(
        environmentId,
        filePath,
        fileName,
        environment.runtime
      );
      
      if (result.success) {
        // Check for runtime mismatch - plugin is already installed, just show warning
        if (result.runtimeMismatch && result.runtimeMismatch.requiresConfirmation) {
          // Store the mismatch info to show confirmation dialog
          setPendingUpload({ file: null, runtimeMismatch: result.runtimeMismatch });
          // Plugin is already installed, so we can proceed with success handling
          // but show the warning dialog first
        } else {
          // No mismatch - proceed with success handling
          await handleUploadSuccess();
        }
      } else {
        setError(result.error || 'Failed to upload plugin');
        setUploading(false);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to upload plugin');
      setUploading(false);
    }
  };

  const handleUploadSuccess = async () => {
    // Reload plugins list after successful upload
    await loadPlugins();
    // Notify parent that plugins changed
    if (onPluginsChanged) {
      onPluginsChanged();
    }
    setUploading(false);
    setPendingUpload(null);
  };

  const handleRuntimeMismatchConfirm = async () => {
    // Plugin is already installed, just acknowledge and continue
    setPendingUpload(null);
    await handleUploadSuccess();
  };

  const handleRuntimeMismatchCancel = () => {
    // Plugin is already installed, but user canceled acknowledgment
    // Still reload plugins since it was installed
    setPendingUpload(null);
    handleUploadSuccess();
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
          <h2>Installed Plugins</h2>
          <button className="modal-close" onClick={onClose}>×</button>
        </div>

        <div className="mods-content">
          {error && (
            <div className="error-message" style={{ margin: '0 1.25rem', padding: '0.75rem', backgroundColor: '#dc3545', color: '#fff', borderRadius: '4px' }}>
              {error}
            </div>
          )}

          <div className="mods-actions" style={{ padding: '0 1.25rem', marginBottom: '1rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '1rem' }}>
            <div style={{ flex: 1 }}>
              {pluginsDirectory && (
                <p style={{ margin: 0, color: '#888', fontSize: '0.875rem' }}>
                  <i className="fas fa-folder" style={{ marginRight: '0.5rem' }}></i>
                  {pluginsDirectory}
                </p>
              )}
            </div>
            <div style={{ display: 'flex', gap: '0.5rem' }}>
              <button
                onClick={handleUploadClick}
                className="btn btn-primary"
                disabled={uploading}
                title="Upload a plugin file (.dll, .zip, or .rar)"
              >
                {uploading ? (
                  <>
                    <i className="fas fa-spinner fa-spin" style={{ marginRight: '0.5rem' }}></i>
                    Uploading...
                  </>
                ) : (
                  <>
                    <i className="fas fa-upload" style={{ marginRight: '0.5rem' }}></i>
                    Add Plugin
                  </>
                )}
              </button>
              <button
                onClick={handleOpenFolder}
                className="btn btn-secondary"
                title="Open plugins folder in file explorer"
              >
                <i className="fas fa-folder-open" style={{ marginRight: '0.5rem' }}></i>
                Open Folder
              </button>
            </div>
          </div>

          {!loading && (
            <div style={{ padding: '0 1.25rem 1.25rem', maxHeight: '500px', overflowY: 'auto' }}>
              <div style={{ display: 'grid', gap: '1rem' }}>
                {/* MLVScan Special Entry */}
                {mlvscanStatus !== null && (
                  <div
                    className="mod-card"
                    style={{
                      backgroundColor: '#2a2a2a',
                      border: '2px solid',
                      borderColor: mlvscanStatus.installed && mlvscanStatus.enabled ? '#4a90e2' : '#3a3a3a',
                      borderRadius: '8px',
                      padding: '1rem',
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center'
                    }}
                  >
                    <div style={{ flex: 1 }}>
                      <h3 style={{ margin: 0, marginBottom: '0.5rem', fontSize: '1.1rem', color: '#fff', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                        <i className="fas fa-shield-alt" style={{ color: '#4a90e2', marginRight: '0.5rem' }}></i>
                        MLVScan
                        {mlvscanStatus.installed && mlvscanStatus.enabled && (
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
                        {mlvscanStatus.installed && !mlvscanStatus.enabled && (
                          <span style={{ 
                            fontSize: '0.75rem', 
                            padding: '0.25rem 0.5rem', 
                            backgroundColor: '#88820',
                            color: '#888',
                            borderRadius: '4px',
                            border: '1px solid #88840'
                          }}>
                            Disabled
                          </span>
                        )}
                        {!mlvscanStatus.installed && (
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
                        {mlvscanStatus.installed && mlvscanStatus.version && (
                          <span>
                            <i className="fas fa-tag" style={{ marginRight: '0.25rem', color: '#888' }}></i>
                            <span style={{ color: '#888' }}>
                              Version: {mlvscanStatus.version}
                            </span>
                          </span>
                        )}
                        {mlvscanStatus.installed && mlvscanLatestRelease && mlvscanStatus.version && mlvscanLatestRelease.tag_name !== mlvscanStatus.version && (
                          <span>
                            <i className="fas fa-exclamation-triangle" style={{ marginRight: '0.25rem', color: '#ffd700' }}></i>
                            <span style={{ color: '#ffd700' }}>
                              Update Available: {mlvscanLatestRelease.tag_name}
                            </span>
                          </span>
                        )}
                      </div>
                    </div>
                    <div style={{ display: 'flex', gap: '0.5rem', marginLeft: '1rem' }}>
                      {!mlvscanStatus.installed ? (
                        <button
                          onClick={handleInstallMlvscanClick}
                          className="btn btn-primary btn-small"
                          disabled={installingMlvscan}
                          title="Install MLVScan from GitHub"
                        >
                          {installingMlvscan ? (
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
                          {mlvscanLatestRelease && mlvscanStatus.version && mlvscanLatestRelease.tag_name !== mlvscanStatus.version && (
                            <button
                              onClick={handleInstallMlvscanClick}
                              className="btn btn-primary btn-small"
                              disabled={installingMlvscan}
                              title="Update MLVScan"
                            >
                              {installingMlvscan ? (
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
                            onClick={handleUninstallMlvscan}
                            className="btn btn-danger btn-small"
                            disabled={uninstallingMlvscan}
                            title="Uninstall MLVScan"
                          >
                            {uninstallingMlvscan ? (
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
                        href="https://github.com/ifBars/MLVScan"
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
                
                {/* Regular Plugins List */}
                {plugins.length === 0 ? (
                  <div style={{ padding: '2rem', textAlign: 'center', color: '#888' }}>
                    <i className="fas fa-box-open" style={{ fontSize: '2rem', marginBottom: '1rem' }}></i>
                    <p>No other plugins found</p>
                    <p style={{ fontSize: '0.875rem', marginTop: '0.5rem' }}>
                      Plugins should be placed in the Plugins directory as .dll files
                    </p>
                  </div>
                ) : (
                  plugins.map((plugin) => (
                    <div
                      key={plugin.fileName}
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
                        <h3 style={{ margin: 0, marginBottom: '0.5rem', fontSize: '1rem', color: '#fff' }}>
                          {plugin.name}
                        </h3>
                        <div style={{ display: 'flex', gap: '1rem', alignItems: 'center', fontSize: '0.875rem', color: '#888', flexWrap: 'wrap' }}>
                          <span>
                            <i className="fas fa-file-code" style={{ marginRight: '0.25rem' }}></i>
                            {plugin.fileName}
                          </span>
                          {plugin.version && (
                            <span>
                              <i className="fas fa-tag" style={{ marginRight: '0.25rem' }}></i>
                              Version: {plugin.version}
                            </span>
                          )}
                          {plugin.source && (
                            <span>
                              <i className="fas fa-download" style={{ marginRight: '0.25rem' }}></i>
                              Source: {plugin.source}
                            </span>
                          )}
                        </div>
                      </div>
                      <div style={{ display: 'flex', gap: '0.5rem' }}>
                        <button
                          onClick={() => handleDeletePlugin(plugin)}
                          className="btn btn-danger btn-small"
                          disabled={deletingPlugin === plugin.fileName}
                          title="Delete plugin"
                        >
                          {deletingPlugin === plugin.fileName ? (
                            <i className="fas fa-spinner fa-spin"></i>
                          ) : (
                            <i className="fas fa-trash"></i>
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

      {/* MLVScan Version Selector Modal */}
      {showMlvscanVersionSelector && (
        <div className="modal-overlay" onClick={(e) => {
          if (e.target === e.currentTarget) {
            setShowMlvscanVersionSelector(false);
            setSelectedMlvscanVersion('');
          }
        }}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()} style={{ maxWidth: '600px' }}>
            <div className="modal-header">
              <h2>Select MLVScan Version</h2>
              <button className="modal-close" onClick={() => {
                setShowMlvscanVersionSelector(false);
                setSelectedMlvscanVersion('');
              }}>×</button>
            </div>

            <div style={{ padding: '1.25rem' }}>
              <p style={{ marginBottom: '1rem', color: '#ccc', fontSize: '0.9rem', lineHeight: '1.5' }}>
                MLVScan is a security-focused MelonLoader plugin that protects your game by scanning mods for malicious patterns before they execute.
              </p>

              {loadingMlvscanReleases ? (
                <div style={{ padding: '2rem', textAlign: 'center', color: '#888' }}>
                  <i className="fas fa-spinner fa-spin" style={{ fontSize: '2rem', marginBottom: '1rem' }}></i>
                  <p>Loading releases...</p>
                </div>
              ) : mlvscanReleases.length === 0 ? (
                <div style={{ padding: '2rem', textAlign: 'center', color: '#888' }}>
                  <p>No releases found</p>
                </div>
              ) : (
                <>
                  <div style={{ marginBottom: '1rem', maxHeight: '400px', overflowY: 'auto' }}>
                    <div style={{ display: 'grid', gap: '0.5rem' }}>
                      {mlvscanReleases.map((release) => (
                        <label
                          key={release.tag_name}
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            padding: '0.75rem',
                            backgroundColor: selectedMlvscanVersion === release.tag_name ? '#3a3a3a' : '#2a2a2a',
                            border: '1px solid',
                            borderColor: selectedMlvscanVersion === release.tag_name ? '#4a90e2' : '#3a3a3a',
                            borderRadius: '6px',
                            cursor: 'pointer',
                            transition: 'all 0.2s'
                          }}
                          onMouseEnter={(e) => {
                            if (selectedMlvscanVersion !== release.tag_name) {
                              e.currentTarget.style.backgroundColor = '#333';
                            }
                          }}
                          onMouseLeave={(e) => {
                            if (selectedMlvscanVersion !== release.tag_name) {
                              e.currentTarget.style.backgroundColor = '#2a2a2a';
                            }
                          }}
                        >
                          <input
                            type="radio"
                            name="mlvscanVersion"
                            value={release.tag_name}
                            checked={selectedMlvscanVersion === release.tag_name}
                            onChange={(e) => setSelectedMlvscanVersion(e.target.value)}
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
                                href={`https://github.com/ifBars/MLVScan/releases/tag/${release.tag_name}`}
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
                        setShowMlvscanVersionSelector(false);
                        setSelectedMlvscanVersion('');
                      }}
                    >
                      Cancel
                    </button>
                    <button
                      className="btn btn-primary"
                      onClick={handleMlvscanVersionSelected}
                      disabled={!selectedMlvscanVersion || installingMlvscan}
                    >
                      {installingMlvscan ? (
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

