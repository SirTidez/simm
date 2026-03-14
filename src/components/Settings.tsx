import { useState, useEffect, useRef } from 'react';
import { useSettingsStore } from '../stores/settingsStore';
import { useEnvironmentStore } from '../stores/environmentStore';
import { ApiService } from '../services/api';
import { batchUpdateCheckRef, lastUpdateCheckTimeRef, notifyBatchUpdateCheckStarted } from './EnvironmentList';
import { CustomThemeEditor } from './CustomThemeEditor';

type SettingsProps = {
  isOpen: boolean;
  onClose: () => void;
};

const MIN_MOD_ICON_CACHE_LIMIT_MB = 100;
const MAX_MOD_ICON_CACHE_LIMIT_MB = 8192;

export function normalizeModIconCacheLimitMb(value: unknown): number {
  const parsed =
    typeof value === 'number'
      ? value
      : Number.parseInt(String(value ?? ''), 10);

  if (!Number.isFinite(parsed)) {
    return 500;
  }

  const rounded = Math.trunc(parsed as number);
  return Math.min(MAX_MOD_ICON_CACHE_LIMIT_MB, Math.max(MIN_MOD_ICON_CACHE_LIMIT_MB, rounded));
}

export function Settings({ isOpen, onClose }: SettingsProps) {
  const { settings, depotDownloader, loading, updateSettings, refreshDepotDownloader } = useSettingsStore();
  const { environments, checkAllUpdates } = useEnvironmentStore();
  const [checkingAllUpdates, setCheckingAllUpdates] = useState(false);
  const [showThemeEditor, setShowThemeEditor] = useState(false);
  const [formData, setFormData] = useState({
    defaultDownloadDir: '',
    maxConcurrentDownloads: 2,
    platform: 'windows' as 'windows' | 'macos' | 'linux',
    language: 'english',
    theme: 'modern-blue' as 'light' | 'dark' | 'modern-blue' | 'custom',
    melonLoaderVersion: '',
    autoInstallMelonLoader: false,
    updateCheckInterval: 60,
    autoCheckUpdates: true,
    logLevel: 'info' as 'debug' | 'info' | 'warn' | 'error',
    modIconCacheLimitMb: 500,
  });
  const [error, setError] = useState<string | null>(null);
  const [showDirectoryPicker, setShowDirectoryPicker] = useState(false);
  const [directoryPath, setDirectoryPath] = useState('');
  const [directoryList, setDirectoryList] = useState<Array<{ name: string; path: string }>>([]);
  const [browsing, setBrowsing] = useState(false);
  const [melonLoaderVersions, setMelonLoaderVersions] = useState<Array<{ tag: string; name: string }>>([]);
  const [loadingVersions, setLoadingVersions] = useState(false);
  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Keep escape close behavior predictable in docked mode
  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isOpen) {
        if (showThemeEditor) {
          return;
        }
        if (showDirectoryPicker) {
          setShowDirectoryPicker(false);
          return;
        }
        onClose();
      }
    };

    if (isOpen) {
      document.addEventListener('keydown', handleEscape);
    }

    return () => {
      document.removeEventListener('keydown', handleEscape);
    };
  }, [isOpen, onClose, showDirectoryPicker, showThemeEditor]);

  useEffect(() => {
    if (settings) {
      setFormData({
        defaultDownloadDir: settings.defaultDownloadDir || '',
        maxConcurrentDownloads: settings.maxConcurrentDownloads || 2,
        platform: 'windows' as 'windows' | 'macos' | 'linux', // Always Windows
        language: 'english', // Always English
        theme: (settings.theme as 'light' | 'dark' | 'modern-blue' | 'custom') || 'modern-blue',
        melonLoaderVersion: settings.melonLoaderVersion || '',
        autoInstallMelonLoader: settings.autoInstallMelonLoader || false,
        updateCheckInterval: settings.updateCheckInterval || 60,
        autoCheckUpdates: settings.autoCheckUpdates !== false,
        logLevel: (settings.logLevel as 'debug' | 'info' | 'warn' | 'error') || 'info',
        modIconCacheLimitMb: normalizeModIconCacheLimitMb(settings.modIconCacheLimitMb),
      });
    }
  }, [settings]);

  // Load available MelonLoader versions when modal opens
  useEffect(() => {
    if (isOpen && melonLoaderVersions.length === 0) {
      setLoadingVersions(true);
      ApiService.getAvailableMelonLoaderVersions()
        .then(versions => {
          setMelonLoaderVersions(versions);
        })
        .catch(err => {
          console.error('Failed to load MelonLoader versions:', err);
          setError('Failed to load MelonLoader versions');
        })
        .finally(() => {
          setLoadingVersions(false);
        });
    }
  }, [isOpen, melonLoaderVersions.length]);

  // Auto-save with debouncing
  useEffect(() => {
    if (!settings) return; // Don't save on initial load

    // Clear existing timeout
    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current);
    }

    // Set new timeout to save after 500ms of no changes
    saveTimeoutRef.current = setTimeout(async () => {
      try {
        setError(null);
        // Always set platform to 'windows' and language to 'english' since they're not user-configurable
        const normalizedFormData = {
          ...formData,
          modIconCacheLimitMb: normalizeModIconCacheLimitMb(formData.modIconCacheLimitMb),
          platform: 'windows' as const,
          language: 'english',
        };
        await updateSettings(normalizedFormData);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to save settings');
      }
    }, 500);

    // Cleanup on unmount
    return () => {
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current);
      }
    };
  }, [formData, settings, updateSettings]);

  const getParentPath = (currentPath: string): string | null => {
    if (!currentPath) return null;
    // Handle Windows paths (C:\, D:\, etc.)
    const isWindowsRoot = /^[A-Z]:\\?$/i.test(currentPath);
    if (isWindowsRoot) return null;

    // Handle Unix paths (/)
    if (currentPath === '/' || currentPath === '\\') return null;

    // Get parent by removing last segment
    const separator = currentPath.includes('/') ? '/' : '\\';
    const parts = currentPath.split(separator).filter(p => p);

    // If we're at a drive root (C:\), return null
    if (parts.length <= 1 && currentPath.includes(':')) return null;

    // Remove last part
    parts.pop();

    if (parts.length === 0) {
      // Return root
      return separator === '/' ? '/' : (currentPath.match(/^[A-Z]:/i)?.[0] + '\\' || '\\');
    }

    return parts.join(separator) + (separator === '/' ? '/' : '');
  };

  const loadDirectory = async (path: string) => {
    if (!path) return;
    setBrowsing(true);
    try {
      const result = await ApiService.browseDirectory(path);
      setDirectoryPath(result.currentPath);
      setDirectoryList(result.directories);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to browse directory');
      setDirectoryList([]);
    } finally {
      setBrowsing(false);
    }
  };

  const handleDirectorySelect = (selectedPath: string) => {
    setFormData({ ...formData, defaultDownloadDir: selectedPath });
    setShowDirectoryPicker(false);
  };

  return (
    <>
      {isOpen && (
        <section
          className="modal-content"
          style={{
            width: '100%',
            height: '100%',
            maxWidth: 'none',
            margin: 0,
            borderRadius: '0.75rem',
            display: 'flex',
            flexDirection: 'column'
          }}
          aria-label="Settings panel"
        >
            <div className="modal-header">
              <h2>Settings</h2>
              <button className="modal-close" onClick={onClose} aria-label="Close settings panel">×</button>
            </div>

            {error && <div className="error-message" style={{ margin: '0 1.25rem', padding: '0.75rem', backgroundColor: '#dc3545', color: '#fff', borderRadius: '4px' }}>{error}</div>}

            <div className="settings-content" style={{ flex: 1, overflowY: 'auto' }}>
              <div className="settings-section">
                <h3>Appearance</h3>
                <div className="form-group">
                  <label>Theme</label>
                  <select
                    value={formData.theme || 'modern-blue'}
                    onChange={(e) => setFormData({ ...formData, theme: e.target.value as 'light' | 'dark' | 'modern-blue' | 'custom' })}
                    disabled={loading}
                  >
                    <option value="modern-blue">Modern Blue</option>
                    <option value="dark">Dark</option>
                    <option value="light">Light</option>
                    <option value="custom">Custom</option>
                  </select>
                </div>
                {formData.theme === 'custom' && (
                  <div className="form-group">
                    <button
                      type="button"
                      onClick={() => setShowThemeEditor(true)}
                      className="btn btn-secondary"
                    >
                      <i className="fas fa-paint-brush" style={{ marginRight: '0.5rem' }}></i>
                      Open Custom Theme Editor
                    </button>
                  </div>
                )}
              </div>

              <div className="settings-section">
                <h3>DepotDownloader</h3>
                {depotDownloader ? (
                  <div className="info-box">
                    <p><strong>Status:</strong> Installed</p>
                    <p><strong>Path:</strong> <span title={depotDownloader.path} style={{ wordBreak: 'break-all', overflowWrap: 'break-word' }}>{depotDownloader.path}</span></p>
                    <p><strong>Method:</strong> {depotDownloader.method || 'Unknown'}</p>
                    <button onClick={refreshDepotDownloader} className="btn btn-small" style={{ marginTop: '0.5rem' }}>
                      Refresh
                    </button>
                  </div>
                ) : (
                  <div className="warning-box">
                    <p>DepotDownloader is not installed.</p>
                    <p>Install with:</p>
                    <code>winget install --exact --id SteamRE.DepotDownloader</code>
                  </div>
                )}
              </div>

              <div className="settings-section">
                <h3>Download Settings</h3>
                <div className="form-group">
                  <label>Default Download Directory</label>
                  <div style={{ display: 'flex', gap: '0.5rem' }}>
                    <input
                      type="text"
                      value={formData.defaultDownloadDir}
                      onChange={(e) => setFormData({ ...formData, defaultDownloadDir: e.target.value })}
                      placeholder="C:\DevEnvironments"
                      style={{ flex: 1 }}
                    />
                    <button
                      type="button"
                      onClick={async () => {
                        const currentPath = formData.defaultDownloadDir || settings?.defaultDownloadDir || '';
                        setDirectoryPath(currentPath);
                        setShowDirectoryPicker(true);
                        if (currentPath) {
                          await loadDirectory(currentPath);
                        }
                      }}
                      className="btn btn-secondary"
                      style={{ whiteSpace: 'nowrap' }}
                    >
                      Browse...
                    </button>
                  </div>
                </div>
                <div className="form-group">
                  <label>Max Concurrent Downloads</label>
                  <input
                    type="number"
                    value={formData.maxConcurrentDownloads}
                    onChange={(e) => setFormData({ ...formData, maxConcurrentDownloads: parseInt(e.target.value) || 2 })}
                    min="1"
                    max="10"
                  />
                </div>
              </div>

              <div className="settings-section">
                <h3>MelonLoader</h3>
                <div className="form-group">
                  <label>Preferred MelonLoader Version</label>
                  <select
                    value={formData.melonLoaderVersion || ''}
                    onChange={(e) => setFormData({ ...formData, melonLoaderVersion: e.target.value })}
                    disabled={loadingVersions}
                  >
                    <option value="">None (Manual Installation)</option>
                    {loadingVersions ? (
                      <option disabled>Loading versions...</option>
                    ) : (
                      melonLoaderVersions.map(version => (
                        <option key={version.tag} value={version.tag}>
                          {version.name}
                        </option>
                      ))
                    )}
                  </select>
                  <small style={{ color: '#888', display: 'block', marginTop: '0.25rem', fontSize: '0.8rem', lineHeight: '1.3' }}>
                    Automatically install this version for newly created environments.
                  </small>
                </div>
                <div className="form-group">
                  <label>
                    <input
                      type="checkbox"
                      checked={formData.autoInstallMelonLoader || false}
                      onChange={(e) => setFormData({ ...formData, autoInstallMelonLoader: e.target.checked })}
                    />
                    Automatically install MelonLoader after download completion
                  </label>
                </div>
              </div>

              <div className="settings-section">
                <h3>Update Checks</h3>
                <div className="form-group">
                  <label>
                    <input
                      type="checkbox"
                      checked={formData.autoCheckUpdates !== false}
                      onChange={(e) => setFormData({ ...formData, autoCheckUpdates: e.target.checked })}
                    />
                    Automatically check for updates
                  </label>
                </div>
                <div className="form-group">
                  <label>Check Interval (minutes)</label>
                  <input
                    type="number"
                    value={formData.updateCheckInterval || 60}
                    onChange={(e) => setFormData({ ...formData, updateCheckInterval: parseInt(e.target.value) || 60 })}
                    min="1"
                    max="1440"
                  />
                  <small style={{ color: '#888', display: 'block', marginTop: '0.25rem', fontSize: '0.8rem', lineHeight: '1.3' }}>
                    Automatic check interval (1-1440 minutes).
                  </small>
                </div>
                <div className="form-group">
                  <label>Mod Icon Cache Limit (MB)</label>
                  <input
                    type="number"
                    value={formData.modIconCacheLimitMb ?? 500}
                    onChange={(e) => setFormData({
                      ...formData,
                      modIconCacheLimitMb: normalizeModIconCacheLimitMb(e.target.value),
                    })}
                    min="100"
                    max="8192"
                  />
                  <small style={{ color: '#888', display: 'block', marginTop: '0.25rem', fontSize: '0.8rem', lineHeight: '1.3' }}>
                    Maximum disk budget for cached mod icons. Default is 500 MB.
                  </small>
                </div>
                <div className="form-group">
                  <button
                    type="button"
                    onClick={async () => {
                      try {
                        setCheckingAllUpdates(true);
                        lastUpdateCheckTimeRef.current = Date.now();
                        batchUpdateCheckRef.current = true;
                        notifyBatchUpdateCheckStarted(
                          environments
                            .filter(env => env.status === 'completed')
                            .map(env => env.id)
                        );
                        await checkAllUpdates(true);
                        alert('Update check complete!');
                      } catch (err) {
                        alert(`Failed to check for updates: ${err instanceof Error ? err.message : 'Unknown error'}`);
                      } finally {
                        batchUpdateCheckRef.current = false;
                        setCheckingAllUpdates(false);
                      }
                    }}
                    disabled={checkingAllUpdates}
                    className="btn btn-secondary"
                    style={{ opacity: checkingAllUpdates ? 0.6 : 1 }}
                  >
                    {checkingAllUpdates ? 'Checking...' : 'Check All Updates'}
                  </button>
                </div>
              </div>

              <div className="settings-section">
                <h3>Logging</h3>
                <div className="form-group">
                  <label>Log Level</label>
                  <select
                    value={formData.logLevel || 'info'}
                    onChange={(e) => setFormData({ ...formData, logLevel: e.target.value as any })}
                  >
                    <option value="debug">Debug</option>
                    <option value="info">Info</option>
                    <option value="warn">Warning</option>
                    <option value="error">Error</option>
                  </select>
                  <small style={{ color: '#888', display: 'block', marginTop: '0.25rem', fontSize: '0.8rem', lineHeight: '1.3' }}>
                    Minimum log level to write to the log file. Logs are saved to: <code>{settings?.defaultDownloadDir || 'default download directory'}/s1devenvmanager-YYYY-MM-DD.log</code>
                  </small>
                </div>
              </div>
            </div>
        </section>
      )}

      <CustomThemeEditor isOpen={showThemeEditor} onClose={() => setShowThemeEditor(false)} />

      {/* Directory Picker Modal */}
      {showDirectoryPicker && (
        <div className="modal-overlay" onClick={() => setShowDirectoryPicker(false)}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()} style={{ maxWidth: '600px' }}>
            <div className="modal-header">
              <h2>Select Directory</h2>
              <button className="modal-close" onClick={() => setShowDirectoryPicker(false)}>×</button>
            </div>

            <div style={{ padding: '1rem 1.25rem' }}>
              <div style={{ marginBottom: '1rem' }}>
                <label style={{ display: 'block', marginBottom: '0.5rem', fontSize: '0.875rem' }}>Current Path:</label>
                <input
                  type="text"
                  value={directoryPath}
                  onChange={(e) => setDirectoryPath(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      loadDirectory(directoryPath);
                    }
                  }}
                  style={{ width: '100%', padding: '0.5rem', fontSize: '0.85rem' }}
                  placeholder="C:\Users\YourName"
                />
                <button
                  onClick={() => loadDirectory(directoryPath)}
                  className="btn btn-primary"
                  style={{ marginTop: '0.5rem', width: '100%' }}
                  disabled={browsing}
                >
                  {browsing ? 'Loading...' : 'Go to Path'}
                </button>
              </div>

              <div style={{ maxHeight: '400px', overflowY: 'auto', border: '1px solid #3a3a3a', borderRadius: '4px', padding: '0.5rem' }}>
                {browsing ? (
                  <p style={{ color: '#888', textAlign: 'center', padding: '2rem' }}>Loading...</p>
                ) : (
                  <>
                    {getParentPath(directoryPath) && (
                      <div
                        onClick={() => {
                          const parent = getParentPath(directoryPath);
                          if (parent) {
                            loadDirectory(parent);
                          }
                        }}
                        style={{
                          padding: '0.75rem',
                          cursor: 'pointer',
                          borderRadius: '4px',
                          marginBottom: '0.5rem',
                          backgroundColor: '#3a3a3a',
                          border: '1px solid #4a4a4a'
                        }}
                        onMouseEnter={(e) => e.currentTarget.style.backgroundColor = '#4a4a4a'}
                        onMouseLeave={(e) => e.currentTarget.style.backgroundColor = '#3a3a3a'}
                      >
                        <i className="fas fa-arrow-up" style={{ marginRight: '0.5rem', color: '#646cff' }}></i>
                        <strong>.. (Parent Directory)</strong>
                      </div>
                    )}
                    {directoryList.length === 0 ? (
                      <p style={{ color: '#888', textAlign: 'center', padding: '2rem' }}>No directories found</p>
                    ) : (
                      directoryList.map((dir) => (
                        <div
                          key={dir.path}
                          onClick={() => loadDirectory(dir.path)}
                          style={{
                            padding: '0.75rem',
                            cursor: 'pointer',
                            borderRadius: '4px',
                            marginBottom: '0.25rem',
                            backgroundColor: '#3a3a3a'
                          }}
                          onMouseEnter={(e) => e.currentTarget.style.backgroundColor = '#4a4a4a'}
                          onMouseLeave={(e) => e.currentTarget.style.backgroundColor = '#3a3a3a'}
                        >
                          <i className="fas fa-folder" style={{ marginRight: '0.5rem', color: '#646cff' }}></i>
                          {dir.name}
                        </div>
                      ))
                    )}
                  </>
                )}
              </div>

              <div style={{ marginTop: '1rem', display: 'flex', gap: '0.5rem', justifyContent: 'flex-end' }}>
                <button onClick={() => setShowDirectoryPicker(false)} className="btn btn-secondary">
                  Cancel
                </button>
                <button
                  onClick={() => handleDirectorySelect(directoryPath)}
                  className="btn btn-primary"
                  disabled={!directoryPath}
                >
                  Select This Directory
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

