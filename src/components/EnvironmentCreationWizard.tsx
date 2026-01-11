import React, { useState, useEffect } from 'react';
import { useEnvironmentStore } from '../stores/environmentStore';
import { useSettingsStore } from '../stores/settingsStore';
import { ApiService } from '../services/api';
import type { AppConfig, BranchConfig } from '../types';

interface Props {
  onClose: () => void;
}

export function EnvironmentCreationWizard({ onClose }: Props) {
  const { createEnvironment } = useEnvironmentStore();
  const { settings } = useSettingsStore();
  const [step, setStep] = useState(1);
  const [appConfig, setAppConfig] = useState<AppConfig | null>(null);
  const [selectedBranch, setSelectedBranch] = useState<BranchConfig | null>(null);
  const [outputDir, setOutputDir] = useState('');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showDirectoryPicker, setShowDirectoryPicker] = useState(false);
  const [directoryPath, setDirectoryPath] = useState('');
  const [directoryList, setDirectoryList] = useState<Array<{ name: string; path: string }>>([]);
  const [browsing, setBrowsing] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [steamInstallations, setSteamInstallations] = useState<Array<{ path: string; executablePath: string; appId: string }>>([]);
  const [detectingSteam, setDetectingSteam] = useState(false);
  const [showSteamDetection, setShowSteamDetection] = useState(false);

  useEffect(() => {
    loadSchedule1Config();
    // Don't auto-set outputDir here - wait for branch selection
  }, [settings]);

  const loadSchedule1Config = async () => {
    try {
      const config = await ApiService.getSchedule1Config();
      setAppConfig(config);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load game configuration');
    }
  };

  const handleBranchSelect = (branch: BranchConfig) => {
    setSelectedBranch(branch);
    if (!name) {
      // Use just the branch name, removing runtime info
      const branchName = branch.displayName.replace(/\s*\(IL2CPP\)|\s*\(Mono\)/gi, '').trim();
      setName(branchName);
    }
    // Auto-generate output directory: baseDir/branchName
    const baseDir = outputDir || settings?.defaultDownloadDir || '';
    if (baseDir) {
      // Use path separator appropriate for the OS
      const separator = baseDir.includes('/') ? '/' : '\\';
      // Remove trailing separator if present
      let cleanBase = baseDir.replace(/[/\\]+$/, '');
      // Remove branch name if it's already at the end
      const branchNameRegex = new RegExp(`[/\\\\]${branch.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`);
      cleanBase = cleanBase.replace(branchNameRegex, '');
      setOutputDir(`${cleanBase}${separator}${branch.name}`);
    } else if (settings?.defaultDownloadDir) {
      const separator = settings.defaultDownloadDir.includes('/') ? '/' : '\\';
      let cleanBase = settings.defaultDownloadDir.replace(/[/\\]+$/, '');
      // Remove branch name if it's already at the end
      const branchNameRegex = new RegExp(`[/\\\\]${branch.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`);
      cleanBase = cleanBase.replace(branchNameRegex, '');
      setOutputDir(`${cleanBase}${separator}${branch.name}`);
    }
    setStep(2);
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
    if (selectedBranch) {
      const separator = selectedPath.includes('/') ? '/' : '\\';
      let cleanPath = selectedPath.replace(/[/\\]+$/, '');
      // Remove branch name if it's already at the end
      const branchNameRegex = new RegExp(`[/\\\\]${selectedBranch.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`);
      cleanPath = cleanPath.replace(branchNameRegex, '');
      setOutputDir(`${cleanPath}${separator}${selectedBranch.name}`);
    } else {
      setOutputDir(selectedPath);
    }
    setShowDirectoryPicker(false);
  };

  const handleCreateFolder = async () => {
    if (!newFolderName.trim() || !directoryPath) return;
    
    setCreatingFolder(true);
    try {
      const separator = directoryPath.includes('/') ? '/' : '\\';
      const cleanPath = directoryPath.replace(/[/\\]+$/, '');
      const newFolderPath = `${cleanPath}${separator}${newFolderName.trim()}`;
      
      await ApiService.createDirectory(newFolderPath);
      setNewFolderName('');
      // Reload directory to show the new folder
      await loadDirectory(directoryPath);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create folder');
    } finally {
      setCreatingFolder(false);
    }
  };

  const handleDetectSteam = async () => {
    setDetectingSteam(true);
    setError(null);
    try {
      const installations = await ApiService.detectSteamInstallations();
      setSteamInstallations(installations);
      setShowSteamDetection(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to detect Steam installations');
    } finally {
      setDetectingSteam(false);
    }
  };

  const handleCreateSteamEnvironment = async (steamPath: string) => {
    setLoading(true);
    setError(null);

    try {
      await ApiService.createSteamEnvironment(steamPath, name || undefined, description.trim() || undefined);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create Steam environment');
    } finally {
      setLoading(false);
    }
  };

  const handleCreate = async () => {
    if (!appConfig || !selectedBranch || !outputDir) {
      setError('Please fill in all required fields');
      return;
    }

    setLoading(true);
    setError(null);

    try {
      await createEnvironment({
        appId: appConfig.appId,
        branch: selectedBranch.name,
        outputDir,
        name: name || undefined,
        description: description.trim() || undefined
      });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create game install');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>Create New Game Install</h2>
          <button className="modal-close" onClick={onClose}>×</button>
        </div>

        {error && <div className="error-message">{error}</div>}

        {!showSteamDetection && step === 1 && (
          <div className="wizard-step">
            <div style={{ marginBottom: '1.5rem', padding: '1rem', backgroundColor: '#2a2a2a', borderRadius: '6px', border: '1px solid #3a3a3a' }}>
              <h4 style={{ marginTop: 0, marginBottom: '0.5rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <i className="fab fa-steam" style={{ color: '#00bcd4' }}></i>
                Steam Installation
              </h4>
              <p style={{ margin: '0 0 0.75rem 0', color: '#aaa', fontSize: '0.9rem' }}>
                Add your existing Steam installation to manage mods, plugins, and view logs. Steam will handle game updates.
              </p>
              <button
                onClick={handleDetectSteam}
                className="btn btn-secondary"
                disabled={detectingSteam}
                style={{ width: '100%' }}
              >
                {detectingSteam ? (
                  <>
                    <i className="fas fa-spinner fa-spin" style={{ marginRight: '0.5rem' }}></i>
                    Detecting...
                  </>
                ) : (
                  <>
                    <i className="fab fa-steam" style={{ marginRight: '0.5rem' }}></i>
                    Detect Steam Installation
                  </>
                )}
              </button>
            </div>
            <div style={{ marginBottom: '1.5rem', textAlign: 'center', color: '#888' }}>
              <span>OR</span>
            </div>
            <h3>Select Branch (DepotDownloader)</h3>
            {appConfig ? (
              <div className="branch-list">
                {appConfig.branches.map(branch => (
                  <div 
                    key={branch.name} 
                    className="branch-card"
                    onClick={() => handleBranchSelect(branch)}
                  >
                    <h4>{branch.displayName}</h4>
                    <p>Runtime: {branch.runtime}</p>
                    {branch.requiresAuth && <span className="auth-badge">Requires Auth</span>}
                  </div>
                ))}
              </div>
            ) : (
              <div className="loading">Loading branches...</div>
            )}
          </div>
        )}

        {step === 2 && selectedBranch && (
          <div className="wizard-step">
            <h3>Configure Environment</h3>
            <div className="form-group">
              <label>Name</label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Environment name"
              />
            </div>
            <div className="form-group">
              <label>Base Directory *</label>
              <div style={{ display: 'flex', gap: '0.5rem' }}>
                <input
                  type="text"
                  value={(() => {
                    if (!selectedBranch || !outputDir) return outputDir;
                    const separator = outputDir.includes('/') ? '/' : '\\';
                    // Remove branch name from the end if present
                    const branchNameRegex = new RegExp(`[/\\\\]${selectedBranch.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`);
                    return outputDir.replace(branchNameRegex, '').replace(/[/\\]+$/, '');
                  })()}
                  onChange={(e) => {
                    // User enters base directory, we'll append branch name
                    // Allow all characters including backslashes
                    const baseDir = e.target.value;
                    if (selectedBranch && baseDir) {
                      const separator = baseDir.includes('/') ? '/' : '\\';
                      let cleanBase = baseDir.replace(/[/\\]+$/, '');
                      // Remove branch name if it's already at the end
                      const branchNameRegex = new RegExp(`[/\\\\]${selectedBranch.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`);
                      cleanBase = cleanBase.replace(branchNameRegex, '');
                      setOutputDir(`${cleanBase}${separator}${selectedBranch.name}`);
                    } else {
                      setOutputDir(baseDir);
                    }
                  }}
                  placeholder={selectedBranch ? `C:\\Users\\YourName\\s1devmanager\\backend` : "C:\\DevEnvironments"}
                  required
                  style={{ flex: 1 }}
                />
                <button
                  type="button"
                  onClick={async () => {
                    let currentBase = outputDir || settings?.defaultDownloadDir || '';
                    if (selectedBranch && currentBase) {
                      // Remove branch name from the end if present
                      const separator = currentBase.includes('/') ? '/' : '\\';
                      const branchNameRegex = new RegExp(`[/\\\\]${selectedBranch.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`);
                      currentBase = currentBase.replace(branchNameRegex, '').replace(/[/\\]+$/, '');
                    }
                    // If no base directory, use the default download directory from settings
                    if (!currentBase && settings?.defaultDownloadDir) {
                      currentBase = settings.defaultDownloadDir;
                    }
                    setDirectoryPath(currentBase);
                    setShowDirectoryPicker(true);
                    if (currentBase) {
                      await loadDirectory(currentBase);
                    } else {
                      // If still no path, loadDirectory will handle the default (home/SIMM) via the API
                      await loadDirectory('');
                    }
                  }}
                  className="btn btn-secondary"
                  style={{ whiteSpace: 'nowrap' }}
                >
                  Browse...
                </button>
              </div>
              {selectedBranch && outputDir && (
                <div style={{ marginTop: '0.5rem', padding: '0.5rem', backgroundColor: '#2a2a2a', borderRadius: '4px' }}>
                  <small style={{ color: '#888', display: 'block' }}>Branch "{selectedBranch.name}" will be downloaded to:</small>
                  <code style={{ color: '#4caf50', fontSize: '0.9rem', wordBreak: 'break-all' }}>{outputDir}</code>
                </div>
              )}
            </div>
            <div className="form-group">
              <label>Description (Optional)</label>
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Describe what this version means..."
                rows={3}
                style={{ 
                  width: '100%', 
                  padding: '0.5rem 0.75rem',
                  backgroundColor: 'var(--input-bg-color, #1a1a1a)',
                  border: '1px solid var(--input-border-color, #3a3a3a)',
                  borderRadius: '6px',
                  color: 'var(--input-text-color, #ffffff)',
                  fontSize: '0.85rem',
                  fontFamily: 'inherit',
                  resize: 'vertical',
                  minHeight: '60px'
                }}
              />
              <small style={{ color: '#888', display: 'block', marginTop: '0.25rem' }}>
                Add a description to help you remember what this version is for
              </small>
            </div>
            <div className="form-actions">
              <button onClick={() => setStep(1)} className="btn btn-secondary">
                Back
              </button>
              <button 
                onClick={handleCreate} 
                className="btn btn-primary"
                disabled={loading || !outputDir}
              >
                {loading ? 'Creating...' : 'Create Game Install'}
              </button>
            </div>
          </div>
        )}

        {showSteamDetection && (
          <div className="wizard-step">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
              <h3>Steam Installation Detected</h3>
              <button
                onClick={() => {
                  setShowSteamDetection(false);
                  setSteamInstallations([]);
                }}
                className="btn btn-secondary btn-small"
              >
                <i className="fas fa-arrow-left" style={{ marginRight: '0.25rem' }}></i>
                Back
              </button>
            </div>
            {steamInstallations.length === 0 ? (
              <div style={{ padding: '2rem', textAlign: 'center', color: '#888' }}>
                <i className="fab fa-steam" style={{ fontSize: '3rem', marginBottom: '1rem', display: 'block', color: '#00bcd4' }}></i>
                <p>No Steam installation found for Schedule I.</p>
                <p style={{ fontSize: '0.9rem', marginTop: '0.5rem' }}>
                  Make sure Schedule I is installed through Steam and try again.
                </p>
              </div>
            ) : (
              <>
                <div className="form-group">
                  <label>Select Steam Installation</label>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                    {steamInstallations.map((installation, index) => (
                      <div
                        key={index}
                        style={{
                          padding: '1rem',
                          backgroundColor: '#2a2a2a',
                          borderRadius: '6px',
                          border: '1px solid #3a3a3a',
                          cursor: 'pointer',
                          transition: 'border-color 0.2s'
                        }}
                        onMouseEnter={(e) => {
                          e.currentTarget.style.borderColor = '#00bcd4';
                        }}
                        onMouseLeave={(e) => {
                          e.currentTarget.style.borderColor = '#3a3a3a';
                        }}
                        onClick={() => handleCreateSteamEnvironment(installation.path)}
                      >
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.5rem' }}>
                          <i className="fab fa-steam" style={{ color: '#00bcd4', fontSize: '1.2rem' }}></i>
                          <strong>Steam Installation</strong>
                        </div>
                        <div style={{ fontSize: '0.85rem', color: '#aaa', fontFamily: 'monospace' }}>
                          {installation.path}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
                <div className="form-group">
                  <label>Name (Optional)</label>
                  <input
                    type="text"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="Steam Installation"
                  />
                </div>
                <div className="form-group">
                  <label>Description (Optional)</label>
                  <textarea
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    placeholder="Describe what this version means..."
                    rows={3}
                    style={{ 
                      width: '100%', 
                      padding: '0.5rem 0.75rem',
                      backgroundColor: 'var(--input-bg-color, #1a1a1a)',
                      border: '1px solid var(--input-border-color, #3a3a3a)',
                      borderRadius: '6px',
                      color: 'var(--input-text-color, #ffffff)',
                      fontSize: '0.85rem',
                      fontFamily: 'inherit',
                      resize: 'vertical',
                      minHeight: '60px'
                    }}
                  />
                </div>
              </>
            )}
          </div>
        )}
      </div>

      {/* Directory Picker Modal */}
      {showDirectoryPicker && (
        <div className="modal-overlay modal-overlay-nested" onClick={() => setShowDirectoryPicker(false)}>
          <div className="modal-content modal-content-nested" onClick={(e) => e.stopPropagation()} style={{ maxWidth: '600px' }}>
            <div className="modal-header">
              <h2>Select Base Directory</h2>
              <button className="modal-close" onClick={() => setShowDirectoryPicker(false)}>×</button>
            </div>

            <div style={{ marginBottom: '1rem' }}>
              <label style={{ display: 'block', marginBottom: '0.5rem' }}>Current Path:</label>
              <input
                type="text"
                value={directoryPath}
                onChange={(e) => setDirectoryPath(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    loadDirectory(directoryPath);
                  }
                }}
                style={{ width: '100%', padding: '0.5rem' }}
                placeholder="C:\Users\YourName"
              />
              <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.5rem' }}>
                <button
                  onClick={() => loadDirectory(directoryPath)}
                  className="btn btn-primary"
                  style={{ flex: 1 }}
                  disabled={browsing}
                >
                  {browsing ? 'Loading...' : 'Go to Path'}
                </button>
              </div>
            </div>

            <div style={{ marginBottom: '1rem', padding: '0.75rem', backgroundColor: '#2a2a2a', borderRadius: '4px' }}>
              <label style={{ display: 'block', marginBottom: '0.5rem' }}>Create New Folder:</label>
              <div style={{ display: 'flex', gap: '0.5rem' }}>
                <input
                  type="text"
                  value={newFolderName}
                  onChange={(e) => setNewFolderName(e.target.value)}
                  onKeyDown={async (e) => {
                    if (e.key === 'Enter' && newFolderName.trim()) {
                      await handleCreateFolder();
                    }
                  }}
                  style={{ flex: 1, padding: '0.5rem' }}
                  placeholder="Folder name"
                  disabled={creatingFolder || !directoryPath}
                />
                <button
                  onClick={handleCreateFolder}
                  className="btn btn-secondary"
                  disabled={creatingFolder || !newFolderName.trim() || !directoryPath}
                >
                  {creatingFolder ? 'Creating...' : 'Create'}
                </button>
              </div>
            </div>

            <div style={{ maxHeight: '400px', overflowY: 'auto', border: '1px solid #3a3a3a', borderRadius: '4px', padding: '0.5rem' }}>
              {browsing ? (
                <div className="loading">Loading directories...</div>
              ) : directoryList.length === 0 ? (
                <div style={{ padding: '1rem', textAlign: 'center', color: '#888' }}>
                  No subdirectories found
                </div>
              ) : (
                <div>
                  {(() => {
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
                    
                    const parentPath = getParentPath(directoryPath);
                    return parentPath ? (
                      <div
                        onClick={() => loadDirectory(parentPath)}
                        style={{
                          padding: '0.75rem',
                          cursor: 'pointer',
                          borderBottom: '1px solid #3a3a3a',
                          display: 'flex',
                          alignItems: 'center',
                          gap: '0.5rem'
                        }}
                        onMouseEnter={(e) => e.currentTarget.style.backgroundColor = '#3a3a3a'}
                        onMouseLeave={(e) => e.currentTarget.style.backgroundColor = 'transparent'}
                      >
                        <i className="fas fa-arrow-up" style={{ color: '#646cff' }}></i>
                        <span style={{ fontWeight: 'bold' }}>.. (Parent Directory)</span>
                      </div>
                    ) : null;
                  })()}
                  {directoryList.map((dir) => (
                    <div
                      key={dir.path}
                      onClick={() => loadDirectory(dir.path)}
                      style={{
                        padding: '0.75rem',
                        cursor: 'pointer',
                        borderBottom: '1px solid #3a3a3a',
                        display: 'flex',
                        alignItems: 'center',
                        gap: '0.5rem'
                      }}
                      onMouseEnter={(e) => e.currentTarget.style.backgroundColor = '#3a3a3a'}
                      onMouseLeave={(e) => e.currentTarget.style.backgroundColor = 'transparent'}
                    >
                      <span style={{ fontSize: '1.2rem' }}>📁</span>
                      <span>{dir.name}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="modal-actions" style={{ marginTop: '1rem' }}>
              <button
                onClick={() => handleDirectorySelect(directoryPath)}
                className="btn btn-primary"
                disabled={!directoryPath}
              >
                Select This Directory
              </button>
              <button
                onClick={() => setShowDirectoryPicker(false)}
                className="btn btn-secondary"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

