import React, { useState, useEffect, useRef } from 'react';
import { useSettingsStore } from '../stores/settingsStore';
import { useEnvironmentStore } from '../stores/environmentStore';
import { ApiService } from '../services/api';

export function Settings() {
  const { settings, depotDownloader, loading, updateSettings, refreshDepotDownloader } = useSettingsStore();
  const { checkAllUpdates } = useEnvironmentStore();
  const [isOpen, setIsOpen] = useState(false);
  const [checkingAllUpdates, setCheckingAllUpdates] = useState(false);
  const [formData, setFormData] = useState({
    defaultDownloadDir: '',
    maxConcurrentDownloads: 2,
    platform: 'windows' as 'windows' | 'macos' | 'linux',
    language: 'english',
    theme: 'modern-blue' as 'light' | 'dark' | 'modern-blue',
    melonLoaderZipPath: '',
    autoInstallMelonLoader: false,
    updateCheckInterval: 60,
    autoCheckUpdates: true,
    logLevel: 'info' as 'debug' | 'info' | 'warn' | 'error'
  });
  const [error, setError] = useState<string | null>(null);
  const [showDirectoryPicker, setShowDirectoryPicker] = useState(false);
  const [showFilePicker, setShowFilePicker] = useState(false);
  const [directoryPath, setDirectoryPath] = useState('');
  const [filePickerPath, setFilePickerPath] = useState('');
  const [directoryList, setDirectoryList] = useState<Array<{ name: string; path: string }>>([]);
  const [fileList, setFileList] = useState<Array<{ name: string; path: string; type: 'directory' | 'file' }>>([]);
  const [browsing, setBrowsing] = useState(false);
  const saveTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  // Handle escape key to close modal
  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isOpen) {
        setIsOpen(false);
      }
    };
    
    if (isOpen) {
      document.addEventListener('keydown', handleEscape);
      // Prevent body scroll when modal is open
      document.body.style.overflow = 'hidden';
    }
    
    return () => {
      document.removeEventListener('keydown', handleEscape);
      document.body.style.overflow = '';
    };
  }, [isOpen]);

  useEffect(() => {
    if (settings) {
      setFormData({
        defaultDownloadDir: settings.defaultDownloadDir || '',
        maxConcurrentDownloads: settings.maxConcurrentDownloads || 2,
        platform: settings.platform || 'windows',
        language: settings.language || 'english',
        theme: settings.theme || 'modern-blue',
        melonLoaderZipPath: settings.melonLoaderZipPath || '',
        autoInstallMelonLoader: settings.autoInstallMelonLoader || false,
        updateCheckInterval: settings.updateCheckInterval || 60,
        autoCheckUpdates: settings.autoCheckUpdates !== false,
        logLevel: (settings.logLevel as 'debug' | 'info' | 'warn' | 'error') || 'info'
      });
    }
  }, [settings]);

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
        await updateSettings(formData);
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

  const loadFiles = async (path: string) => {
    if (!path) return;
    setBrowsing(true);
    try {
      const result = await ApiService.browseFiles(path, '.zip');
      setFilePickerPath(result.currentPath);
      setFileList(result.items);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to browse files');
      setFileList([]);
    } finally {
      setBrowsing(false);
    }
  };

  const handleDirectorySelect = (selectedPath: string) => {
    setFormData({ ...formData, defaultDownloadDir: selectedPath });
    setShowDirectoryPicker(false);
  };

  const handleFileSelect = (selectedPath: string) => {
    setFormData({ ...formData, melonLoaderZipPath: selectedPath });
    setShowFilePicker(false);
  };
  
  return (
    <>
      <button
        onClick={() => setIsOpen(true)}
        className="btn btn-icon"
        disabled={loading}
        title="Settings"
        aria-label="Settings"
      >
        <i className="fas fa-cog"></i>
      </button>

      {isOpen && (
        <div 
          className="modal-overlay" 
          onClick={() => setIsOpen(false)}
          style={{ 
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            width: '100vw',
            height: '100vh',
            zIndex: 10000
          }}
        >
          <div 
            className="modal-content" 
            onClick={(e) => e.stopPropagation()}
            style={{ zIndex: 10001 }}
          >
            <div className="modal-header">
              <h2>Settings</h2>
              <button className="modal-close" onClick={() => setIsOpen(false)}>×</button>
            </div>

            {error && <div className="error-message" style={{ margin: '0 1.25rem', padding: '0.75rem', backgroundColor: '#dc3545', color: '#fff', borderRadius: '4px' }}>{error}</div>}

            <div className="settings-content">
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
                    <p>Install it using:</p>
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
                <div className="form-group">
                  <label>Platform</label>
                  <select
                    value={formData.platform}
                    onChange={(e) => setFormData({ ...formData, platform: e.target.value as any })}
                  >
                    <option value="windows">Windows</option>
                    <option value="macos">macOS</option>
                    <option value="linux">Linux</option>
                  </select>
                </div>
                <div className="form-group">
                  <label>Language</label>
                  <input
                    type="text"
                    value={formData.language}
                    onChange={(e) => setFormData({ ...formData, language: e.target.value })}
                    placeholder="english"
                  />
                </div>
              </div>

              <div className="settings-section">
                <h3>MelonLoader</h3>
                <div className="form-group">
                  <label>MelonLoader Zip File Path</label>
                  <div style={{ display: 'flex', gap: '0.5rem' }}>
                    <input
                      type="text"
                      value={formData.melonLoaderZipPath || ''}
                      onChange={(e) => setFormData({ ...formData, melonLoaderZipPath: e.target.value })}
                      placeholder="C:\\SirTidez\\Downloads\\MelonLoader.x64 (1).zip"
                      style={{ flex: 1 }}
                    />
                    <button
                      type="button"
                      onClick={async () => {
                        // Extract directory from current path or use default
                        const currentPath = formData.melonLoaderZipPath || '';
                        const dirPath = currentPath ? currentPath.substring(0, currentPath.lastIndexOf('\\') || currentPath.lastIndexOf('/')) : (settings?.defaultDownloadDir || '');
                        setFilePickerPath(dirPath || '');
                        setShowFilePicker(true);
                        if (dirPath) {
                          await loadFiles(dirPath);
                        }
                      }}
                      className="btn btn-secondary"
                      style={{ whiteSpace: 'nowrap' }}
                    >
                      Browse...
                    </button>
                  </div>
                  <small style={{ color: '#888', display: 'block', marginTop: '0.25rem', fontSize: '0.8rem', lineHeight: '1.3' }}>
                    Path to the MelonLoader zip file to automatically install after downloads
                  </small>
                </div>
                <div className="form-group">
                  <label>
                    <input
                      type="checkbox"
                      checked={formData.autoInstallMelonLoader || false}
                      onChange={(e) => setFormData({ ...formData, autoInstallMelonLoader: e.target.checked })}
                    />
                    Automatically install MelonLoader after download completes
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
                    How often to automatically check for game updates (1-1440 minutes)
                  </small>
                </div>
                <div className="form-group">
                  <button
                    type="button"
                    onClick={async () => {
                      try {
                        setCheckingAllUpdates(true);
                        await checkAllUpdates();
                        alert('Update check complete!');
                      } catch (err) {
                        alert(`Failed to check for updates: ${err instanceof Error ? err.message : 'Unknown error'}`);
                      } finally {
                        setCheckingAllUpdates(false);
                      }
                    }}
                    disabled={checkingAllUpdates}
                    className="btn btn-secondary"
                    style={{ opacity: checkingAllUpdates ? 0.6 : 1 }}
                  >
                    {checkingAllUpdates ? 'Checking...' : 'Check All Updates Now'}
                  </button>
                </div>
              </div>

              <div className="settings-section">
                <h3>Appearance</h3>
                <div className="form-group">
                  <label>Theme</label>
                  <select
                    value={formData.theme}
                    onChange={(e) => setFormData({ ...formData, theme: e.target.value as any })}
                  >
                    <option value="light">Light</option>
                    <option value="dark">Dark</option>
                    <option value="modern-blue">Modern Blue</option>
                  </select>
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
          </div>
        </div>
      )}

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

      {/* File Picker Modal */}
      {showFilePicker && (
        <div className="modal-overlay" onClick={() => setShowFilePicker(false)}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()} style={{ maxWidth: '600px' }}>
            <div className="modal-header">
              <h2>Select MelonLoader Zip File</h2>
              <button className="modal-close" onClick={() => setShowFilePicker(false)}>×</button>
            </div>

            <div style={{ padding: '1rem 1.25rem' }}>
              <div style={{ marginBottom: '1rem' }}>
                <label style={{ display: 'block', marginBottom: '0.5rem', fontSize: '0.875rem' }}>Current Path:</label>
                <input
                  type="text"
                  value={filePickerPath}
                  onChange={(e) => setFilePickerPath(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      loadFiles(filePickerPath);
                    }
                  }}
                  style={{ width: '100%', padding: '0.5rem', fontSize: '0.85rem' }}
                  placeholder="C:\Users\YourName\Downloads"
                />
                <button
                  onClick={() => loadFiles(filePickerPath)}
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
                    {getParentPath(filePickerPath) && (
                      <div
                        onClick={() => {
                          const parent = getParentPath(filePickerPath);
                          if (parent) {
                            loadFiles(parent);
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
                    {fileList.length === 0 ? (
                      <p style={{ color: '#888', textAlign: 'center', padding: '2rem' }}>No files or directories found</p>
                    ) : (
                      fileList.map((item) => (
                        <div
                          key={item.path}
                          onClick={() => {
                            if (item.type === 'directory') {
                              loadFiles(item.path);
                            } else {
                              handleFileSelect(item.path);
                            }
                          }}
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
                          <i className={`fas ${item.type === 'directory' ? 'fa-folder' : 'fa-file-archive'}`} style={{ marginRight: '0.5rem', color: item.type === 'directory' ? '#646cff' : '#ffaa00' }}></i>
                          {item.name}
                        </div>
                      ))
                    )}
                  </>
                )}
              </div>

              <div style={{ marginTop: '1rem', display: 'flex', gap: '0.5rem', justifyContent: 'flex-end' }}>
                <button onClick={() => setShowFilePicker(false)} className="btn btn-secondary">
                  Cancel
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
