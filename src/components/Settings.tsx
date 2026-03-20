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

function extractReleaseApiLastUpdated(health: Record<string, unknown> | null): string | null {
  if (!health) return null;

  const data = (health as { data?: Record<string, unknown> }).data;
  const candidates = [
    health.lastUpdated,
    health.last_updated,
    health.updatedAt,
    health.updated_at,
    health.timestamp,
    data?.lastUpdated,
    data?.last_updated,
    data?.updatedAt,
    data?.updated_at,
  ];

  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim().length > 0) {
      const parsed = new Date(candidate);
      if (!Number.isNaN(parsed.getTime())) {
        return parsed.toLocaleString();
      }
      return candidate;
    }
  }

  return null;
}

export function Settings({ isOpen, onClose }: SettingsProps) {
  const { settings, depotDownloader, loading, updateSettings, refreshDepotDownloader } = useSettingsStore();
  const { environments, checkAllUpdates } = useEnvironmentStore();
  const [checkingAllUpdates, setCheckingAllUpdates] = useState(false);
  const [releaseApiHealth, setReleaseApiHealth] = useState<Record<string, unknown> | null>(null);
  const [releaseApiError, setReleaseApiError] = useState<string | null>(null);
  const [checkingReleaseApi, setCheckingReleaseApi] = useState(false);
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

  const runCheckAllUpdates = async () => {
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
    } catch (err) {
      setError(`Failed to check for updates: ${err instanceof Error ? err.message : 'Unknown error'}`);
    } finally {
      batchUpdateCheckRef.current = false;
      setCheckingAllUpdates(false);
    }
  };

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

  useEffect(() => {
    if (!isOpen) return;

    const loadReleaseApiHealth = async () => {
      setCheckingReleaseApi(true);
      setReleaseApiError(null);
      try {
        const health = await ApiService.getReleaseApiHealth();
        setReleaseApiHealth(health);
      } catch (err) {
        setReleaseApiHealth(null);
        setReleaseApiError(err instanceof Error ? err.message : 'Release API is unavailable');
      } finally {
        setCheckingReleaseApi(false);
      }
    };

    void loadReleaseApiHealth();
  }, [isOpen]);

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

  const completedEnvironmentCount = environments.filter(env => env.status === 'completed').length;
  const depotStatusLabel = depotDownloader ? 'Installed' : 'Missing';
  const depotStatusTone = depotDownloader ? 'success' : 'warning';
  const releaseApiLastUpdated = extractReleaseApiLastUpdated(releaseApiHealth);
  const releaseApiTone = checkingReleaseApi ? 'checking' : releaseApiError ? 'offline' : 'online';
  const releaseApiLabel = checkingReleaseApi ? 'Checking' : releaseApiError ? 'Offline' : 'Online';

  return (
    <>
      {isOpen && (
        <section
          className="modal-content workspace-panel settings-panel"
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

            {error && <div className="settings-error-banner">{error}</div>}

            <div className="settings-content settings-content--desktop">
              <div className="settings-overview">
                <div className="settings-overview__copy">
                  <span className="settings-eyebrow">Application Settings</span>
                  <h3>Adjust appearance, downloads, updates, and tooling.</h3>
                  <p>Changes save automatically. Use this pane to keep SIMM’s environment setup, update cadence, and theme behavior aligned with your workflow.</p>
                </div>
                <div className="settings-overview__stats">
                  <div className="settings-stat-card">
                    <span>Theme</span>
                    <strong>{formData.theme === 'modern-blue' ? 'Modern Blue' : formData.theme === 'custom' ? 'Custom' : formData.theme.charAt(0).toUpperCase() + formData.theme.slice(1)}</strong>
                  </div>
                  <div className="settings-stat-card">
                    <span>Managed Environments</span>
                    <strong>{completedEnvironmentCount}</strong>
                  </div>
                  <div className="settings-stat-card">
                    <span>DepotDownloader</span>
                    <strong>{depotStatusLabel}</strong>
                  </div>
                </div>
              </div>

              <div className="settings-shell">
                <div className="settings-primary">
                  <section className="settings-section settings-section--desktop">
                    <div className="settings-section__header">
                      <div>
                        <span className="settings-section__eyebrow">Appearance</span>
                        <h3><i className="fas fa-palette"></i> Theme & visuals</h3>
                      </div>
                      <p>Keep the desktop shell consistent with the rest of SIMM.</p>
                    </div>

                    <div className="settings-field-grid">
                      <div className="settings-field">
                        <label>Theme preset</label>
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
                        <small>Choose the default surface and accent palette for the app shell.</small>
                      </div>

                      <div className="settings-field settings-field--compact">
                        <label>Custom theme editor</label>
                        <button
                          type="button"
                          onClick={() => setShowThemeEditor(true)}
                          className="btn btn-secondary"
                          disabled={formData.theme !== 'custom'}
                        >
                          <i className="fas fa-paint-brush" style={{ marginRight: '0.5rem' }}></i>
                          Open Theme Editor
                        </button>
                        <small>{formData.theme === 'custom' ? 'Edit the currently selected custom theme.' : 'Switch to the Custom theme preset to enable editing.'}</small>
                      </div>
                    </div>
                  </section>

                  <section className="settings-section settings-section--desktop">
                    <div className="settings-section__header">
                      <div>
                        <span className="settings-section__eyebrow">Downloads</span>
                        <h3><i className="fas fa-folder-open"></i> Storage & throughput</h3>
                      </div>
                      <p>Control where new installs are staged and how aggressively SIMM downloads in parallel.</p>
                    </div>

                    <div className="settings-field-grid">
                      <div className="settings-field settings-field--span">
                        <label>Default download directory</label>
                        <div className="settings-inline-row">
                          <input
                            type="text"
                            value={formData.defaultDownloadDir}
                            onChange={(e) => setFormData({ ...formData, defaultDownloadDir: e.target.value })}
                            placeholder="C:\DevEnvironments"
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
                          >
                            Browse
                          </button>
                        </div>
                        <small>New downloads and extracted install payloads default to this path.</small>
                      </div>

                      <div className="settings-field settings-field--compact">
                        <label>Max concurrent downloads</label>
                        <input
                          type="number"
                          value={formData.maxConcurrentDownloads}
                          onChange={(e) => setFormData({ ...formData, maxConcurrentDownloads: parseInt(e.target.value) || 2 })}
                          min="1"
                          max="10"
                        />
                        <small>Higher values improve throughput but use more bandwidth and disk I/O.</small>
                      </div>
                    </div>
                  </section>

                  <section className="settings-section settings-section--desktop">
                    <div className="settings-section__header">
                      <div>
                        <span className="settings-section__eyebrow">Tooling</span>
                        <h3><i className="fas fa-cubes"></i> MelonLoader & prerequisites</h3>
                      </div>
                      <p>Manage the preferred loader version and verify external tooling required for non-Steam branches.</p>
                    </div>

                    <div className="settings-field-grid">
                      <div className="settings-field">
                        <label>Preferred MelonLoader version</label>
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
                        <small>Use this version when creating new managed environments.</small>
                      </div>

                      <div className="settings-field settings-field--toggle">
                        <label className="settings-toggle">
                          <input
                            type="checkbox"
                            checked={formData.autoInstallMelonLoader || false}
                            onChange={(e) => setFormData({ ...formData, autoInstallMelonLoader: e.target.checked })}
                          />
                          <span className="settings-toggle__control" aria-hidden="true"></span>
                          <span>
                            <strong>Auto-install after download</strong>
                            <small>Apply MelonLoader automatically when an environment finishes downloading.</small>
                          </span>
                        </label>
                      </div>
                    </div>

                    <div className={`settings-callout settings-callout--${depotStatusTone}`}>
                      {depotDownloader ? (
                        <>
                          <div className="settings-callout__header">
                            <strong>DepotDownloader ready</strong>
                            <button onClick={refreshDepotDownloader} className="btn btn-secondary btn-small">Refresh</button>
                          </div>
                          <p><strong>Path:</strong> <span title={depotDownloader.path}>{depotDownloader.path}</span></p>
                          <p><strong>Method:</strong> {depotDownloader.method || 'Unknown'}</p>
                        </>
                      ) : (
                        <>
                          <div className="settings-callout__header">
                            <strong>DepotDownloader is not installed</strong>
                          </div>
                          <p>Re-run the SIMM installer to repair prerequisites, or install it manually with:</p>
                          <code>winget install --exact --id SteamRE.DepotDownloader</code>
                        </>
                      )}
                    </div>
                  </section>

                  <section className="settings-section settings-section--desktop">
                    <div className="settings-section__header">
                      <div>
                        <span className="settings-section__eyebrow">Updates</span>
                        <h3><i className="fas fa-rotate"></i> Automatic checks & cache</h3>
                      </div>
                      <p>Balance update frequency, cache size, and batch operations across your managed environments.</p>
                    </div>

                    <div className="settings-field-grid">
                      <div className="settings-field settings-field--toggle">
                        <label className="settings-toggle">
                          <input
                            type="checkbox"
                            checked={formData.autoCheckUpdates !== false}
                            onChange={(e) => setFormData({ ...formData, autoCheckUpdates: e.target.checked })}
                          />
                          <span className="settings-toggle__control" aria-hidden="true"></span>
                          <span>
                            <strong>Automatically check for updates</strong>
                            <small>Run background update checks using the interval below.</small>
                          </span>
                        </label>
                      </div>

                      <div className="settings-field settings-field--compact">
                        <label>Check interval (minutes)</label>
                        <input
                          type="number"
                          value={formData.updateCheckInterval || 60}
                          onChange={(e) => setFormData({ ...formData, updateCheckInterval: parseInt(e.target.value) || 60 })}
                          min="1"
                          max="1440"
                        />
                        <small>Allowed range: 1 to 1440 minutes.</small>
                      </div>

                      <div className="settings-field settings-field--compact">
                        <label>Mod icon cache limit (MB)</label>
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
                        <small>Disk budget for cached mod icons. Default is 500 MB.</small>
                      </div>

                      <div className="settings-field settings-field--compact">
                        <label>Manual batch actions</label>
                        <button
                          type="button"
                          onClick={() => void runCheckAllUpdates()}
                          disabled={checkingAllUpdates}
                          className="btn btn-secondary"
                        >
                          {checkingAllUpdates ? 'Checking...' : 'Check All Updates'}
                        </button>
                        <small>Run an immediate check across all completed environments.</small>
                      </div>
                    </div>
                  </section>

                  <section className="settings-section settings-section--desktop">
                    <div className="settings-section__header">
                      <div>
                        <span className="settings-section__eyebrow">Logging</span>
                        <h3><i className="fas fa-file-lines"></i> Diagnostics</h3>
                      </div>
                      <p>Control how much detail SIMM writes to its log output.</p>
                    </div>

                    <div className="settings-field-grid">
                      <div className="settings-field settings-field--span">
                        <label>Log level</label>
                        <select
                          value={formData.logLevel || 'info'}
                          onChange={(e) => setFormData({ ...formData, logLevel: e.target.value as any })}
                        >
                          <option value="debug">Debug</option>
                          <option value="info">Info</option>
                          <option value="warn">Warning</option>
                          <option value="error">Error</option>
                        </select>
                        <small>
                          Minimum log level written to disk. Logs are saved to <code>{settings?.defaultDownloadDir || 'your default download directory'}/s1devenvmanager-YYYY-MM-DD.log</code>
                        </small>
                      </div>
                    </div>
                  </section>
                </div>

                <aside className="settings-sidebar">
                  <section className="settings-sidecard">
                    <span className="settings-section__eyebrow">Status</span>
                    <h3>Auto-save</h3>
                    <p>Settings persist automatically after a short delay. You can close this pane at any time.</p>
                    <div className="settings-sidecard__meta">
                      <div>
                        <span>Theme</span>
                        <strong>{formData.theme === 'modern-blue' ? 'Modern Blue' : formData.theme === 'custom' ? 'Custom' : formData.theme.charAt(0).toUpperCase() + formData.theme.slice(1)}</strong>
                      </div>
                      <div>
                        <span>Downloads</span>
                        <strong>{formData.maxConcurrentDownloads} concurrent</strong>
                      </div>
                    </div>
                  </section>

                  <section className="settings-sidecard">
                    <span className="settings-section__eyebrow">Paths</span>
                    <h3>Current storage</h3>
                    <p title={formData.defaultDownloadDir || 'No directory configured'}>{formData.defaultDownloadDir || 'No default download directory configured.'}</p>
                    <button
                      type="button"
                      className="btn btn-secondary btn-small"
                      onClick={async () => {
                        const currentPath = formData.defaultDownloadDir || settings?.defaultDownloadDir || '';
                        setDirectoryPath(currentPath);
                        setShowDirectoryPicker(true);
                        if (currentPath) {
                          await loadDirectory(currentPath);
                        }
                      }}
                    >
                      Browse folders
                    </button>
                  </section>

                  <section className="settings-sidecard">
                    <span className="settings-section__eyebrow">Environment Health</span>
                    <h3>Update posture</h3>
                    <div className="settings-sidecard__meta">
                      <div>
                        <span>Completed installs</span>
                        <strong>{completedEnvironmentCount}</strong>
                      </div>
                      <div>
                        <span>Auto-check</span>
                        <strong>{formData.autoCheckUpdates ? 'Enabled' : 'Disabled'}</strong>
                      </div>
                      <div>
                        <span>Cache budget</span>
                        <strong>{normalizeModIconCacheLimitMb(formData.modIconCacheLimitMb)} MB</strong>
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => void runCheckAllUpdates()}
                      disabled={checkingAllUpdates}
                      className="btn btn-primary btn-small"
                    >
                      {checkingAllUpdates ? 'Checking…' : 'Run update check'}
                    </button>
                  </section>

                  <section className="settings-sidecard">
                    <span className="settings-section__eyebrow">Service Health</span>
                    <h3>Release API</h3>
                    <p>Checks whether SIMM can reach the GitHub-backed release metadata used for updates and tooling version lookups.</p>
                    <div className="settings-service-health">
                      <span className={`settings-status-pill settings-status-pill--${releaseApiTone}`} title={releaseApiError || undefined}>
                        <i className={checkingReleaseApi ? 'fas fa-spinner fa-spin' : releaseApiError ? 'fas fa-exclamation-circle' : 'fas fa-check-circle'}></i>
                        {releaseApiLabel}
                      </span>
                      {releaseApiLastUpdated && !checkingReleaseApi && (
                        <span className="settings-service-health__timestamp">Last updated: {releaseApiLastUpdated}</span>
                      )}
                      {releaseApiError && <span className="settings-service-health__error">{releaseApiError}</span>}
                    </div>
                  </section>
                </aside>
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

