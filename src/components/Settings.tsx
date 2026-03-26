import { useState, useEffect, useRef } from 'react';
import { useSettingsStore } from '../stores/settingsStore';
import { useEnvironmentStore } from '../stores/environmentStore';
import { ApiService } from '../services/api';
import { batchUpdateCheckRef, lastUpdateCheckTimeRef, notifyBatchUpdateCheckStarted } from './EnvironmentList';

type SettingsProps = {
  isOpen: boolean;
  onClose: () => void;
};

const MIN_MOD_ICON_CACHE_LIMIT_MB = 100;
const MAX_MOD_ICON_CACHE_LIMIT_MB = 8192;
const MIN_DATABASE_BACKUP_COUNT = 1;
const MAX_DATABASE_BACKUP_COUNT = 100;

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

export function normalizeDatabaseBackupCount(value: unknown): number {
  const parsed =
    typeof value === 'number'
      ? value
      : Number.parseInt(String(value ?? ''), 10);

  if (!Number.isFinite(parsed)) {
    return 10;
  }

  const rounded = Math.trunc(parsed as number);
  return Math.min(MAX_DATABASE_BACKUP_COUNT, Math.max(MIN_DATABASE_BACKUP_COUNT, rounded));
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
  const [backingUpDatabase, setBackingUpDatabase] = useState(false);
  const [openingBackupsFolder, setOpeningBackupsFolder] = useState(false);
  const [databaseBackupFeedback, setDatabaseBackupFeedback] = useState<{
    tone: 'success' | 'error';
    message: string;
  } | null>(null);
  const [formData, setFormData] = useState({
    defaultDownloadDir: '',
    maxConcurrentDownloads: 2,
    platform: 'windows' as 'windows' | 'macos' | 'linux',
    language: 'english',
    theme: 'modern-blue' as 'light' | 'dark' | 'modern-blue',
    melonLoaderVersion: '',
    autoInstallMelonLoader: false,
    updateCheckInterval: 60,
    autoCheckUpdates: true,
    logLevel: 'info' as 'debug' | 'info' | 'warn' | 'error',
    modIconCacheLimitMb: 500,
    databaseBackupCount: 10,
  });
  const [error, setError] = useState<string | null>(null);
  const [showDirectoryPicker, setShowDirectoryPicker] = useState(false);
  const [directoryPath, setDirectoryPath] = useState('');
  const [directoryList, setDirectoryList] = useState<Array<{ name: string; path: string }>>([]);
  const [browsing, setBrowsing] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const [creatingFolder, setCreatingFolder] = useState(false);
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
  }, [isOpen, onClose, showDirectoryPicker]);

  useEffect(() => {
    if (settings) {
      setFormData({
        defaultDownloadDir: settings.defaultDownloadDir || '',
        maxConcurrentDownloads: settings.maxConcurrentDownloads || 2,
        platform: 'windows' as 'windows' | 'macos' | 'linux', // Always Windows
        language: 'english', // Always English
        theme: (settings.theme === 'light' || settings.theme === 'dark' || settings.theme === 'modern-blue')
          ? settings.theme
          : 'modern-blue',
        melonLoaderVersion: settings.melonLoaderVersion || '',
        autoInstallMelonLoader: settings.autoInstallMelonLoader || false,
        updateCheckInterval: settings.updateCheckInterval || 60,
        autoCheckUpdates: settings.autoCheckUpdates !== false,
        logLevel: (settings.logLevel as 'debug' | 'info' | 'warn' | 'error') || 'info',
        modIconCacheLimitMb: normalizeModIconCacheLimitMb(settings.modIconCacheLimitMb),
        databaseBackupCount: normalizeDatabaseBackupCount(settings.databaseBackupCount),
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
          databaseBackupCount: normalizeDatabaseBackupCount(formData.databaseBackupCount),
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

  const openDirectoryPicker = async () => {
    const currentPath = formData.defaultDownloadDir || settings?.defaultDownloadDir || '';
    setDirectoryPath(currentPath);
    setNewFolderName('');
    setShowDirectoryPicker(true);
    if (currentPath) {
      await loadDirectory(currentPath);
    } else {
      setDirectoryList([]);
    }
  };

  const handleCreateFolder = async () => {
    if (!directoryPath || !newFolderName.trim()) {
      return;
    }

    const separator = directoryPath.includes('/') ? '/' : '\\';
    const basePath = directoryPath.replace(/[\\/]+$/, '');
    const nextPath = `${basePath}${separator}${newFolderName.trim()}`;

    setCreatingFolder(true);
    try {
      await ApiService.createDirectory(nextPath);
      setNewFolderName('');
      await loadDirectory(directoryPath);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create folder');
    } finally {
      setCreatingFolder(false);
    }
  };

  const handleDirectorySelect = (selectedPath: string) => {
    setFormData({ ...formData, defaultDownloadDir: selectedPath });
    setShowDirectoryPicker(false);
    setNewFolderName('');
  };

  const depotStatusLabel = depotDownloader ? 'Installed' : 'Missing';
  const releaseApiLastUpdated = extractReleaseApiLastUpdated(releaseApiHealth);
  const releaseApiTone = checkingReleaseApi ? 'checking' : releaseApiError ? 'offline' : 'online';
  const releaseApiLabel = checkingReleaseApi ? 'Checking' : releaseApiError ? 'Offline' : 'Online';
  const depotStatusDetail = depotDownloader
    ? depotDownloader.method
      ? `Managed via ${depotDownloader.method}`
      : 'Managed automatically for protected branches'
    : 'Installed automatically when protected downloads need it';
  const releaseApiDetail = checkingReleaseApi
    ? 'Checking release metadata'
    : releaseApiError
      ? 'Unable to reach release metadata'
      : releaseApiLastUpdated
        ? `Last updated ${releaseApiLastUpdated}`
        : 'Release metadata available';

  const handleBackupDatabase = async () => {
    try {
      setBackingUpDatabase(true);
      setDatabaseBackupFeedback(null);
      const result = await ApiService.backupDatabase();
      setDatabaseBackupFeedback({
        tone: 'success',
        message: `Backup created at ${result.path}`,
      });
    } catch (err) {
      setDatabaseBackupFeedback({
        tone: 'error',
        message: err instanceof Error ? err.message : 'Failed to back up the database',
      });
    } finally {
      setBackingUpDatabase(false);
    }
  };

  const handleOpenBackupsFolder = async () => {
    try {
      setOpeningBackupsFolder(true);
      const homeDirectory = await ApiService.getHomeDirectory();
      const normalizedHome = homeDirectory.replace(/[\\/]+$/, '');
      await ApiService.openPath(`${normalizedHome}\\backups`);
    } catch (err) {
      setDatabaseBackupFeedback({
        tone: 'error',
        message: err instanceof Error ? err.message : 'Failed to open the backups folder',
      });
    } finally {
      setOpeningBackupsFolder(false);
    }
  };

  return (
    <>
      {isOpen && (
        <section className="modal-content workspace-panel settings-panel" aria-label="Settings panel">
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
                <div className="settings-overview__statusline">
                  <span className={`settings-status-pill settings-status-pill--${releaseApiTone}`} title={releaseApiError || undefined}>
                    <i className={checkingReleaseApi ? 'fas fa-spinner fa-spin' : releaseApiError ? 'fas fa-exclamation-circle' : 'fas fa-check-circle'}></i>
                    GitHub API {releaseApiLabel}
                  </span>
                </div>
              </div>

              <div className="settings-shell settings-shell--single">
                <section className="settings-sheet">
                  <div className="settings-subsection">
                    <div className="settings-subsection__header">
                      <div>
                        <span className="settings-section__eyebrow">Interface</span>
                        <h3><i className="fas fa-sliders"></i> App defaults</h3>
                      </div>
                      <p>Pick the built-in app palette and the amount of diagnostic detail SIMM writes while it runs.</p>
                    </div>

                    <div className="settings-field-grid">
                      <div className="settings-field">
                        <label>Theme preset</label>
                        <select
                          value={formData.theme || 'modern-blue'}
                          onChange={(e) => {
                            const nextTheme = e.target.value as 'light' | 'dark' | 'modern-blue';
                            setFormData({ ...formData, theme: nextTheme });
                          }}
                          disabled={loading}
                        >
                          <option value="modern-blue">Modern Blue</option>
                          <option value="dark">Dark</option>
                          <option value="light">Light</option>
                        </select>
                        <small>Built-in SIMM palettes only. Modern Blue remains the default app theme.</small>
                      </div>

                      <div className="settings-field">
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
                        <small>Minimum log detail written to disk for SIMM troubleshooting.</small>
                      </div>
                    </div>
                  </div>

                  <hr className="settings-divider" />

                  <div className="settings-subsection">
                    <div className="settings-subsection__header">
                      <div>
                        <span className="settings-section__eyebrow">Install Defaults</span>
                        <h3><i className="fas fa-folder-tree"></i> Downloads, storage, and loader setup</h3>
                      </div>
                      <p>Control where installs stage by default, how many transfers SIMM runs at once, and which MelonLoader version new environments prefer.</p>
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
                            onClick={() => void openDirectoryPicker()}
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

                    <div className="settings-inline-status-grid">
                      <div className="settings-inline-status">
                        <span>DepotDownloader</span>
                        <strong>{depotStatusLabel}</strong>
                        <small>{depotStatusDetail}</small>
                      </div>
                      {depotDownloader?.path && (
                        <div className="settings-inline-status settings-inline-status--path">
                          <span>Detected Path</span>
                          <strong title={depotDownloader.path}>{depotDownloader.path}</strong>
                        </div>
                      )}
                      <div className="settings-inline-status settings-inline-status--action">
                        <span>Tooling Check</span>
                        <button onClick={refreshDepotDownloader} className="btn btn-secondary btn-small">
                          Refresh
                        </button>
                      </div>
                    </div>
                  </div>

                  <hr className="settings-divider" />

                  <div className="settings-subsection">
                    <div className="settings-subsection__header">
                      <div>
                        <span className="settings-section__eyebrow">Updates & Maintenance</span>
                        <h3><i className="fas fa-rotate"></i> Cadence, cache, and service state</h3>
                      </div>
                      <p>Balance background checks, cache size, and manual update runs without leaving the main settings sheet.</p>
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
                        <label>Database backups to keep</label>
                        <input
                          type="number"
                          value={formData.databaseBackupCount ?? 10}
                          onChange={(e) => setFormData({
                            ...formData,
                            databaseBackupCount: normalizeDatabaseBackupCount(e.target.value),
                          })}
                          min="1"
                          max="100"
                        />
                        <small>Automatic and manual backups prune the oldest snapshots above this count.</small>
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

                    <div className="settings-inline-status-grid">
                      <div className="settings-inline-status">
                        <span>Release API</span>
                        <strong>
                          <span className={`settings-status-pill settings-status-pill--${releaseApiTone}`} title={releaseApiError || undefined}>
                            <i className={checkingReleaseApi ? 'fas fa-spinner fa-spin' : releaseApiError ? 'fas fa-exclamation-circle' : 'fas fa-check-circle'}></i>
                            {releaseApiLabel}
                          </span>
                        </strong>
                        <small>{releaseApiDetail}</small>
                      </div>
                      <div className="settings-inline-status">
                        <span>Update Checks</span>
                        <strong>{formData.autoCheckUpdates ? 'Enabled' : 'Disabled'}</strong>
                        <small>{formData.autoCheckUpdates ? 'Background checks follow the configured interval.' : 'Checks only run when you trigger them manually.'}</small>
                      </div>
                    </div>

                    <div className="settings-backup-panel">
                      <div className="settings-backup-panel__header">
                        <div>
                          <span className="settings-section__eyebrow">Database Backups</span>
                          <h4>Snapshots before upgrades and migrations</h4>
                        </div>
                        <p>SIMM automatically backs up the SQLite database before app-version upgrades and migration work. You can also create a manual snapshot at any time.</p>
                      </div>

                      <div className="settings-backup-panel__actions">
                        <button
                          type="button"
                          onClick={() => void handleBackupDatabase()}
                          disabled={backingUpDatabase}
                          className="btn btn-secondary"
                        >
                          {backingUpDatabase ? 'Backing Up...' : 'Back Up Database'}
                        </button>
                        <button
                          type="button"
                          onClick={() => void handleOpenBackupsFolder()}
                          disabled={openingBackupsFolder}
                          className="btn btn-secondary"
                        >
                          {openingBackupsFolder ? 'Opening...' : 'Open Backups Folder'}
                        </button>
                      </div>

                      {databaseBackupFeedback && (
                        <div
                          className={`settings-inline-feedback settings-inline-feedback--${databaseBackupFeedback.tone}`}
                          role={databaseBackupFeedback.tone === 'error' ? 'alert' : 'status'}
                        >
                          {databaseBackupFeedback.message}
                        </div>
                      )}
                    </div>
                  </div>
                </section>
              </div>
            </div>
        </section>
      )}

      {/* Directory Picker Modal */}
      {showDirectoryPicker && (
        <div className="modal-overlay modal-overlay-nested" onClick={() => setShowDirectoryPicker(false)}>
          <div className="modal-content modal-content-nested wizard-directory-dialog settings-directory-dialog" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2>Select Download Directory</h2>
              <button className="modal-close" onClick={() => setShowDirectoryPicker(false)} aria-label="Close directory picker">×</button>
            </div>

            <div className="wizard-directory-dialog__body">
              <div className="wizard-directory-dialog__overview">
                <span className="settings-eyebrow">Directory Browser</span>
                <h3>Choose the default download location</h3>
                <p>Browse folders, create a new subdirectory if needed, and confirm the current location when you are ready.</p>
              </div>

              <div className="settings-field-card settings-field-card--full">
                <label htmlFor="settings-directory-path">Current path</label>
                <div className="settings-inline-field">
                  <input
                    id="settings-directory-path"
                    type="text"
                    value={directoryPath}
                    onChange={(e) => setDirectoryPath(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        void loadDirectory(directoryPath);
                      }
                    }}
                    placeholder="C:\\Users\\YourName"
                  />
                  <button
                    type="button"
                    onClick={() => void loadDirectory(directoryPath)}
                    className="btn btn-secondary"
                    disabled={browsing}
                  >
                    <i className={browsing ? 'fas fa-spinner fa-spin' : 'fas fa-location-crosshairs'} aria-hidden="true"></i>
                    {browsing ? 'Loading…' : 'Go to Path'}
                  </button>
                </div>
              </div>

              <div className="settings-field-card settings-field-card--full">
                <label htmlFor="settings-new-folder">Create a folder in the current location</label>
                <div className="settings-inline-field">
                  <input
                    id="settings-new-folder"
                    type="text"
                    value={newFolderName}
                    onChange={(e) => setNewFolderName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && newFolderName.trim()) {
                        void handleCreateFolder();
                      }
                    }}
                    placeholder="Folder name"
                    disabled={creatingFolder || !directoryPath}
                  />
                  <button
                    type="button"
                    className="btn btn-secondary"
                    onClick={() => void handleCreateFolder()}
                    disabled={creatingFolder || !newFolderName.trim() || !directoryPath}
                  >
                    <i className={creatingFolder ? 'fas fa-spinner fa-spin' : 'fas fa-folder-plus'} aria-hidden="true"></i>
                    {creatingFolder ? 'Creating…' : 'Create Folder'}
                  </button>
                </div>
              </div>

              <div className="wizard-directory-dialog__list" role="list">
                {browsing ? (
                  <div className="wizard-empty-card">
                    <i className="fas fa-spinner fa-spin"></i>
                    <strong>Loading directories</strong>
                    <p>SIMM is reading the current folder contents.</p>
                  </div>
                ) : (
                  <>
                    {getParentPath(directoryPath) && (
                      <button
                        type="button"
                        className="wizard-directory-row wizard-directory-row--parent"
                        onClick={() => void loadDirectory(getParentPath(directoryPath) || '')}
                      >
                        <i className="fas fa-arrow-up"></i>
                        <span>Parent Directory</span>
                      </button>
                    )}
                    {directoryList.length === 0 ? (
                      <div className="wizard-empty-card">
                        <i className="fas fa-folder-open"></i>
                        <strong>No subdirectories found</strong>
                        <p>This location does not contain any folders that SIMM can browse into right now.</p>
                      </div>
                    ) : (
                      directoryList.map((dir) => (
                        <button
                          key={dir.path}
                          type="button"
                          className="wizard-directory-row"
                          onClick={() => void loadDirectory(dir.path)}
                        >
                          <i className="fas fa-folder"></i>
                          <span>{dir.name}</span>
                        </button>
                      ))
                    )}
                  </>
                )}
              </div>

              <div className="wizard-panel__actions wizard-panel__actions--dialog">
                <button type="button" onClick={() => setShowDirectoryPicker(false)} className="btn btn-secondary">
                  Cancel
                </button>
                <button
                  type="button"
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

