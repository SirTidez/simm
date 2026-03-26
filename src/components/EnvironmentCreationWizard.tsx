import { useEffect, useState } from 'react';
import { useEnvironmentStore } from '../stores/environmentStore';
import { useSettingsStore } from '../stores/settingsStore';
import { ApiService } from '../services/api';
import type { AppConfig, BranchConfig } from '../types';

interface Props {
  onClose: () => void;
}

type WizardMode = 'landing' | 'download-select' | 'download-configure' | 'import-configure';
type DirectoryPurpose = 'download' | 'import';
type SteamInstallation = { path: string; executablePath: string; appId: string };

function getParentPath(currentPath: string): string | null {
  if (!currentPath) return null;
  if (/^[A-Z]:\\?$/i.test(currentPath)) return null;
  if (currentPath === '/' || currentPath === '\\') return null;

  const separator = currentPath.includes('/') ? '/' : '\\';
  const hasLeadingSeparator = separator === '/' && currentPath.startsWith('/');
  const parts = currentPath.split(separator).filter(Boolean);

  if (parts.length <= 1 && currentPath.includes(':')) return null;

  parts.pop();

  if (parts.length === 0) {
    return separator === '/' ? '/' : (currentPath.match(/^[A-Z]:/i)?.[0] + '\\' || '\\');
  }

  return `${hasLeadingSeparator ? '/' : ''}${parts.join(separator)}${separator === '/' ? '/' : ''}`;
}

export function EnvironmentCreationWizard({ onClose }: Props) {
  const { createEnvironment, refreshEnvironments, environments } = useEnvironmentStore();
  const { settings, refreshDepotDownloader } = useSettingsStore();

  const [wizardMode, setWizardMode] = useState<WizardMode>('landing');
  const [appConfig, setAppConfig] = useState<AppConfig | null>(null);
  const [selectedBranch, setSelectedBranch] = useState<BranchConfig | null>(null);
  const [outputDir, setOutputDir] = useState('');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [showDirectoryPicker, setShowDirectoryPicker] = useState(false);
  const [directoryPurpose, setDirectoryPurpose] = useState<DirectoryPurpose>('download');
  const [directoryPath, setDirectoryPath] = useState('');
  const [directoryList, setDirectoryList] = useState<Array<{ name: string; path: string }>>([]);
  const [browsing, setBrowsing] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const [creatingFolder, setCreatingFolder] = useState(false);

  const [steamInstallations, setSteamInstallations] = useState<SteamInstallation[]>([]);
  const [detectingSteam, setDetectingSteam] = useState(false);
  const [showSteamInstallations, setShowSteamInstallations] = useState(false);

  const [importPath, setImportPath] = useState('');
  const [importingLocal, setImportingLocal] = useState(false);

  const [depotDownloaderInstalled, setDepotDownloaderInstalled] = useState<boolean | null>(null);
  const [installingDepotDownloader, setInstallingDepotDownloader] = useState(false);
  const [depotDownloaderPromptError, setDepotDownloaderPromptError] = useState<string | null>(null);

  const hasSteamEnvironment = environments.some(
    env => env.environmentType === 'steam' || env.id.startsWith('steam-')
  );
  const isSteamAuthenticated = Boolean(settings?.steamUsername);
  const steamDetected = steamInstallations.length > 0;

  useEffect(() => {
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;

      if (showDirectoryPicker) {
        setShowDirectoryPicker(false);
        return;
      }

      onClose();
    };

    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [onClose, showDirectoryPicker]);

  useEffect(() => {
    const loadInitialState = async () => {
      try {
        const [config, depotInfo] = await Promise.all([
          ApiService.getSchedule1Config(),
          ApiService.detectDepotDownloader().catch(() => ({ installed: false })),
        ]);
        setAppConfig(config);
        setDepotDownloaderInstalled(!!depotInfo.installed);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load environment creation data');
      }
    };

    void loadInitialState();
  }, []);

  useEffect(() => {
    const detectSteamOnOpen = async () => {
      try {
        const installations = await ApiService.detectSteamInstallations();
        setSteamInstallations(installations);
      } catch {
        setSteamInstallations([]);
      }
    };

    void detectSteamOnOpen();
  }, []);

  const loadDirectory = async (path: string) => {
    setBrowsing(true);
    try {
      const resolvedPath = path || await ApiService.getHomeDirectory();
      const result = await ApiService.browseDirectory(resolvedPath);
      setDirectoryPath(result.currentPath);
      setDirectoryList(result.directories);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to browse directory');
      setDirectoryList([]);
    } finally {
      setBrowsing(false);
    }
  };

  const openDirectoryPicker = async (purpose: DirectoryPurpose) => {
    setDirectoryPurpose(purpose);
    setShowDirectoryPicker(true);

    if (purpose === 'import') {
      await loadDirectory(importPath);
      return;
    }

    await loadDirectory(outputDir || settings?.defaultDownloadDir || '');
  };

  const handleDirectorySelection = (selectedPath: string) => {
    if (directoryPurpose === 'import') {
      setImportPath(selectedPath);
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
      setShowSteamInstallations(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to detect Steam installations');
      setSteamInstallations([]);
      setShowSteamInstallations(true);
    } finally {
      setDetectingSteam(false);
    }
  };

  const handleCreateSteamEnvironment = async (steamPath: string) => {
    setLoading(true);
    setError(null);
    try {
      await ApiService.createSteamEnvironment(steamPath, name || undefined, description.trim() || undefined);
      await refreshEnvironments();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create Steam environment');
    } finally {
      setLoading(false);
    }
  };

  const handleAutoInstallDepotDownloader = async () => {
    setInstallingDepotDownloader(true);
    setDepotDownloaderPromptError(null);
    try {
      await ApiService.installDepotDownloader();
      await refreshDepotDownloader();
      setDepotDownloaderInstalled(true);
    } catch (err) {
      setDepotDownloaderPromptError(err instanceof Error ? err.message : 'Failed to install DepotDownloader automatically.');
    } finally {
      setInstallingDepotDownloader(false);
    }
  };

  const handleOpenDepotDownloaderInstructions = () => {
    window.open('https://github.com/SteamRE/DepotDownloader#installation', '_blank', 'noopener,noreferrer');
  };

  const handleBranchSelect = (branch: BranchConfig) => {
    if (depotDownloaderInstalled !== true) return;

    setSelectedBranch(branch);
    setName((currentName) => {
      if (currentName) return currentName;
      return branch.displayName.replace(/\s*\(IL2CPP\)|\s*\(Mono\)/gi, '').trim();
    });
    setOutputDir((currentOutput) => currentOutput || settings?.defaultDownloadDir || '');
    setWizardMode('download-configure');
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

  const handleImportLocalEnvironment = async () => {
    if (!importPath) {
      setError('Please select a game folder');
      return;
    }

    setImportingLocal(true);
    setError(null);
    try {
      await ApiService.importLocalEnvironment(importPath, name || undefined, description.trim() || undefined);
      await refreshEnvironments();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to import local environment');
    } finally {
      setImportingLocal(false);
    }
  };

  const wizardStats = [
    { label: 'Steam', value: hasSteamEnvironment ? 'Managed' : steamDetected ? 'Detected' : 'Not linked' },
    { label: 'DepotDownloader', value: depotDownloaderInstalled === null ? 'Checking' : depotDownloaderInstalled ? 'Ready' : 'Missing' },
    { label: 'Default path', value: settings?.defaultDownloadDir ? 'Configured' : 'Unset' },
  ];

  return (
    <section
      className="modal-content workspace-panel wizard-panel"
      style={{
        width: '100%',
        height: '100%',
        maxWidth: 'none',
        margin: 0,
        borderRadius: '0.75rem',
        display: 'flex',
        flexDirection: 'column'
      }}
      aria-label="Create environment panel"
    >
      <div className="modal-header">
        <h2>Create Environment</h2>
        <button className="modal-close" onClick={onClose} aria-label="Close create environment panel">×</button>
      </div>

      {error && <div className="settings-error-banner">{error}</div>}

      <div className="wizard-panel__body">
        <div className="wizard-overview">
          <div className="wizard-overview__copy">
            <span className="settings-eyebrow">Environment Setup</span>
            <h3>Create a new managed branch download or import an existing install.</h3>
            <p>Use SIMM to manage download targets, detect local installs, and keep your environment aligned with branch runtime requirements.</p>
          </div>
          <div className="wizard-overview__stats">
            {wizardStats.map((stat) => (
              <div key={stat.label} className="settings-stat-card">
                <span>{stat.label}</span>
                <strong>{stat.value}</strong>
              </div>
            ))}
          </div>
        </div>

        <section className="wizard-steam-card">
          <div className="wizard-steam-card__header">
            <div className="wizard-steam-card__identity">
              <div className="wizard-steam-card__icon">
                <i className="fab fa-steam-symbol"></i>
              </div>
              <div>
                <span className="settings-eyebrow">Steam Detection</span>
                <h3>{hasSteamEnvironment ? 'Steam install already managed' : steamDetected ? 'Steam install detected' : 'No Steam install detected yet'}</h3>
                <p>
                  {hasSteamEnvironment
                    ? 'Your primary Steam install is already linked to SIMM. Steam continues to manage game updates while SIMM handles mods, plugins, and support tools.'
                    : steamDetected
                      ? 'A Steam installation for Schedule I was found on this machine. You can add it to SIMM without making Steam a primary entry card in this flow.'
                      : 'Detect an existing Steam installation if you want to manage your current install inside SIMM without downloading a separate branch copy.'}
                </p>
              </div>
            </div>
          <div className="wizard-steam-card__actions">
              <button type="button" className="btn btn-secondary" onClick={() => void handleDetectSteam()} disabled={detectingSteam}>
                <i className={detectingSteam ? 'fas fa-spinner fa-spin' : 'fab fa-steam'}></i>
                {detectingSteam ? 'Detecting…' : steamDetected ? 'Refresh Detection' : 'Detect Steam Install'}
              </button>
              {!hasSteamEnvironment && steamDetected && (
                <button type="button" className="btn btn-secondary" onClick={() => setShowSteamInstallations((value) => !value)}>
                  <i className="fas fa-list"></i>
                  {showSteamInstallations ? 'Hide Detected Installs' : 'Review Detected Installs'}
                </button>
              )}
            </div>
          </div>

          {showSteamInstallations && !hasSteamEnvironment && (
            <div className="wizard-steam-card__detected">
              <div className="wizard-step-card__header">
                <div>
                  <span className="settings-eyebrow">Detected Installs</span>
                  <h3>{steamInstallations.length === 0 ? 'No Schedule I Steam install found' : 'Choose a detected Steam install'}</h3>
                </div>
              </div>

              {steamInstallations.length === 0 ? (
                <div className="wizard-empty-card">
                  <i className="fab fa-steam"></i>
                  <strong>No Steam installation found</strong>
                  <p>Make sure Schedule I is installed through Steam, then refresh detection to try again.</p>
                </div>
              ) : (
                <>
                  <div className="settings-field-grid">
                    <div className="settings-field-card">
                      <label htmlFor="wizard-steam-name">Display name</label>
                      <input
                        id="wizard-steam-name"
                        type="text"
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                        placeholder="Steam Installation"
                      />
                    </div>

                    <div className="settings-field-card settings-field-card--full">
                      <label htmlFor="wizard-steam-description">Description</label>
                      <textarea
                        id="wizard-steam-description"
                        className="wizard-textarea"
                        value={description}
                        onChange={(e) => setDescription(e.target.value)}
                        placeholder="Optional notes for this managed Steam install"
                        rows={3}
                      />
                    </div>
                  </div>

                  <div className="wizard-steam-card__list" role="list">
                    {steamInstallations.map((installation) => (
                      <button
                        key={installation.path}
                        type="button"
                        className="wizard-steam-install-row"
                        onClick={() => void handleCreateSteamEnvironment(installation.path)}
                        disabled={loading}
                      >
                        <div className="wizard-steam-install-row__icon">
                          <i className="fab fa-steam-symbol"></i>
                        </div>
                        <div className="wizard-steam-install-row__content">
                          <strong>Schedule I Steam install</strong>
                          <span>{installation.path}</span>
                        </div>
                        <span className="wizard-inline-action">
                          {loading ? 'Linking…' : 'Add to SIMM'}
                        </span>
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>
          )}
        </section>

        {wizardMode === 'landing' && (
          <section className="wizard-entry-grid" aria-label="Environment creation methods">
            <button
              type="button"
              className="wizard-entry-card"
              onClick={() => {
                setError(null);
                setWizardMode('download-select');
              }}
            >
              <div className="wizard-entry-card__icon">
                <i className="fas fa-download"></i>
              </div>
              <div className="wizard-entry-card__content">
                <span className="settings-eyebrow">Download</span>
                <h3>Download New Branch</h3>
                <p>Choose a managed branch, verify runtime/auth requirements, and create a dedicated SIMM environment.</p>
              </div>
              <span className="wizard-inline-action">Browse Branches</span>
            </button>

            <button
              type="button"
              className="wizard-entry-card"
              onClick={() => {
                setError(null);
                setWizardMode('import-configure');
              }}
            >
              <div className="wizard-entry-card__icon wizard-entry-card__icon--success">
                <i className="fas fa-folder-open"></i>
              </div>
              <div className="wizard-entry-card__content">
                <span className="settings-eyebrow">Import</span>
                <h3>Import Existing Folder</h3>
                <p>Add a local installation that already exists on disk. SIMM will detect branch, runtime, and version details automatically.</p>
              </div>
              <span className="wizard-inline-action">Select Folder</span>
            </button>
          </section>
        )}

        {wizardMode === 'download-select' && (
          <section className="wizard-step-card">
            <div className="wizard-step-card__header">
              <div>
                <span className="settings-eyebrow">Step 1</span>
                <h3>Select a branch to download</h3>
                <p>Choose the branch that matches the runtime and access level you need. SIMM will configure the output folder in the next step.</p>
              </div>
              <button type="button" className="btn btn-secondary btn-small" onClick={() => setWizardMode('landing')}>
                <i className="fas fa-arrow-left"></i>
                Back
              </button>
            </div>

            {depotDownloaderInstalled !== true && (
              <div className="wizard-prerequisite-card">
                <div className="wizard-prerequisite-card__copy">
                  <span className="settings-eyebrow">Requirement</span>
                  <h4>DepotDownloader is required for branch downloads</h4>
                  <p>
                    SIMM uses DepotDownloader to install and update non-Steam environments. You can install it automatically or open the
                    official manual instructions.
                  </p>
                  {depotDownloaderPromptError && <div className="settings-error-banner">{depotDownloaderPromptError}</div>}
                </div>
                <div className="wizard-inline-actions">
                  <button
                    type="button"
                    className="btn btn-primary"
                    onClick={() => void handleAutoInstallDepotDownloader()}
                    disabled={installingDepotDownloader || depotDownloaderInstalled === null}
                  >
                    <i className={installingDepotDownloader ? 'fas fa-spinner fa-spin' : 'fas fa-download'}></i>
                    {depotDownloaderInstalled === null
                      ? 'Checking…'
                      : installingDepotDownloader
                        ? 'Installing…'
                        : 'Install Automatically'}
                  </button>
                  <button type="button" className="btn btn-secondary" onClick={handleOpenDepotDownloaderInstructions}>
                    <i className="fas fa-external-link-alt"></i>
                    Manual Instructions
                  </button>
                </div>
              </div>
            )}

            {appConfig ? (
              <div className="wizard-branch-grid" role="list">
                {appConfig.branches.map((branch) => {
                  const authRequired = branch.requiresAuth && !isSteamAuthenticated;
                  const depotRequired = depotDownloaderInstalled !== true;
                  const disabled = authRequired || depotRequired;

                  return (
                    <button
                      key={branch.name}
                      type="button"
                      className={`wizard-branch-card ${disabled ? 'wizard-branch-card--disabled' : ''}`}
                      onClick={() => {
                        if (!disabled) handleBranchSelect(branch);
                      }}
                      disabled={disabled}
                      title={
                        authRequired
                          ? 'Steam authentication required to select this branch'
                          : depotRequired
                            ? 'DepotDownloader is required to download this branch'
                            : undefined
                      }
                    >
                      <div className="wizard-branch-card__header">
                        <div>
                          <h4>{branch.displayName}</h4>
                          <p>{branch.name}</p>
                        </div>
                        <div className="wizard-branch-card__badges">
                          <span className="settings-chip">{branch.runtime}</span>
                          {branch.requiresAuth && (
                            <span className={`auth-badge ${isSteamAuthenticated ? 'auth-badge-ready' : 'auth-badge-required'}`}>
                              {isSteamAuthenticated ? 'Auth Ready' : 'Auth Required'}
                            </span>
                          )}
                        </div>
                      </div>
                      <div className="wizard-branch-card__footer">
                        <span>{authRequired ? 'Sign in to Steam in Accounts to use this branch.' : depotRequired ? 'Install DepotDownloader to unlock downloads.' : 'Continue to environment configuration.'}</span>
                      </div>
                    </button>
                  );
                })}
              </div>
            ) : (
              <div className="wizard-empty-card">
                <i className="fas fa-spinner fa-spin"></i>
                <strong>Loading branches</strong>
                <p>SIMM is fetching the currently supported game branches.</p>
              </div>
            )}
          </section>
        )}

        {wizardMode === 'download-configure' && selectedBranch && (
          <section className="wizard-step-card wizard-configuration-shell">
            <div className="wizard-step-card__header">
              <div>
                <span className="settings-eyebrow">Step 2</span>
                <h3>Configure Environment</h3>
                <p>Set the display details and confirm where the selected branch should be downloaded.</p>
              </div>
              <button type="button" className="btn btn-secondary btn-small" onClick={() => setWizardMode('download-select')}>
                <i className="fas fa-arrow-left"></i>
                Back
              </button>
            </div>

            <div className="settings-section">
              <div className="settings-section__heading">
                <div>
                  <span className="settings-eyebrow">Identity</span>
                  <h4>Environment details</h4>
                </div>
              </div>
              <div className="settings-field-grid">
                <div className="settings-field-card">
                  <label htmlFor="wizard-download-name">Name</label>
                  <input
                    id="wizard-download-name"
                    type="text"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="Environment name"
                  />
                </div>

                <div className="settings-field-card settings-field-card--full">
                  <label htmlFor="wizard-download-description">Description</label>
                  <textarea
                    id="wizard-download-description"
                    className="wizard-textarea"
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    placeholder="Optional notes to explain what this install is for"
                    rows={3}
                  />
                </div>
              </div>
            </div>

            <div className="settings-section">
              <div className="settings-section__heading">
                <div>
                  <span className="settings-eyebrow">Storage</span>
                  <h4>Download location</h4>
                </div>
              </div>
              <div className="settings-field-grid">
                <div className="settings-field-card settings-field-card--full">
                  <label htmlFor="wizard-download-base-dir">Install folder</label>
                  <div className="settings-inline-field">
                    <input
                      id="wizard-download-base-dir"
                      type="text"
                      value={outputDir}
                      onChange={(e) => setOutputDir(e.target.value)}
                      placeholder="C:\\Games\\Schedule I Beta"
                    />
                    <button type="button" className="btn btn-secondary" onClick={() => void openDirectoryPicker('download')}>
                      <i className="fas fa-folder-open"></i>
                      Browse
                    </button>
                  </div>
                </div>
              </div>

              <div className="wizard-path-preview">
                <span className="settings-eyebrow">Install Target</span>
                <strong>{outputDir || 'Choose an install folder to continue'}</strong>
                <p>SIMM downloads this branch into the exact folder shown here. The branch name does not rename the folder automatically.</p>
              </div>
            </div>

            <div className="wizard-panel__actions">
              <button type="button" className="btn btn-secondary" onClick={() => setWizardMode('download-select')}>
                Back
              </button>
              <button type="button" className="btn btn-primary" onClick={() => void handleCreate()} disabled={loading || !outputDir}>
                <i className={loading ? 'fas fa-spinner fa-spin' : 'fas fa-plus'}></i>
                {loading ? 'Creating…' : 'Create Environment'}
              </button>
            </div>
          </section>
        )}

        {wizardMode === 'import-configure' && (
          <section className="wizard-step-card wizard-configuration-shell">
            <div className="wizard-step-card__header">
              <div>
                <span className="settings-eyebrow">Import</span>
                <h3>Import Existing Folder</h3>
                <p>Select a local Schedule I folder and let SIMM detect the branch, runtime, and version details automatically.</p>
              </div>
              <button
                type="button"
                className="btn btn-secondary btn-small"
                onClick={() => {
                  setWizardMode('landing');
                  setImportPath('');
                }}
              >
                <i className="fas fa-arrow-left"></i>
                Back
              </button>
            </div>

            <div className="settings-section">
              <div className="settings-section__heading">
                <div>
                  <span className="settings-eyebrow">Source</span>
                  <h4>Game folder</h4>
                </div>
              </div>
              <div className="settings-field-grid">
                <div className="settings-field-card settings-field-card--full">
                  <label htmlFor="wizard-import-path">Folder path</label>
                  <div className="settings-inline-field">
                    <input
                      id="wizard-import-path"
                      type="text"
                      value={importPath}
                      onChange={(e) => setImportPath(e.target.value)}
                      placeholder="C:\\Games\\Schedule I"
                    />
                    <button type="button" className="btn btn-secondary" onClick={() => void openDirectoryPicker('import')}>
                      <i className="fas fa-folder-open"></i>
                      Browse
                    </button>
                  </div>
                </div>
              </div>

              <div className="wizard-path-preview">
                <span className="settings-eyebrow">Detection Notes</span>
                <strong>{importPath || 'Pick a folder to import'}</strong>
                <p>SIMM will inspect the game files and infer branch, runtime, version, and existing support tool state.</p>
              </div>
            </div>

            <div className="settings-section">
              <div className="settings-section__heading">
                <div>
                  <span className="settings-eyebrow">Identity</span>
                  <h4>Optional labels</h4>
                </div>
              </div>
              <div className="settings-field-grid">
                <div className="settings-field-card">
                  <label htmlFor="wizard-import-name">Name</label>
                  <input
                    id="wizard-import-name"
                    type="text"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="My Game Install"
                  />
                </div>

                <div className="settings-field-card settings-field-card--full">
                  <label htmlFor="wizard-import-description">Description</label>
                  <textarea
                    id="wizard-import-description"
                    className="wizard-textarea"
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    placeholder="Optional notes for this imported installation"
                    rows={3}
                  />
                </div>
              </div>
            </div>

            <div className="wizard-empty-card wizard-empty-card--info">
              <i className="fas fa-circle-info"></i>
              <strong>Runtime and branch are detected automatically</strong>
              <p>Import is only asking for the folder and optional labels. SIMM will identify runtime, branch, version, and installed tooling from disk.</p>
            </div>

            <div className="wizard-panel__actions">
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => {
                  setWizardMode('landing');
                  setImportPath('');
                }}
              >
                Back
              </button>
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => void handleImportLocalEnvironment()}
                disabled={importingLocal || !importPath}
              >
                <i className={importingLocal ? 'fas fa-spinner fa-spin' : 'fas fa-folder-plus'}></i>
                {importingLocal ? 'Importing…' : 'Import Installation'}
              </button>
            </div>
          </section>
        )}
      </div>

      {showDirectoryPicker && (
        <div className="modal-overlay modal-overlay-nested" onClick={() => setShowDirectoryPicker(false)}>
          <div className="modal-content modal-content-nested wizard-directory-dialog" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2>{directoryPurpose === 'import' ? 'Select Game Folder' : 'Select Install Folder'}</h2>
              <button className="modal-close" onClick={() => setShowDirectoryPicker(false)} aria-label="Close directory picker">×</button>
            </div>

            <div className="wizard-directory-dialog__body">
              <div className="wizard-directory-dialog__overview">
                <span className="settings-eyebrow">Directory Browser</span>
                <h3>{directoryPurpose === 'import' ? 'Choose the local game folder to import' : 'Choose the install folder for this branch download'}</h3>
                <p>Browse folders, create a new subdirectory if needed, and confirm the current location when you are ready.</p>
              </div>

              <div className="settings-field-card settings-field-card--full">
                <label htmlFor="wizard-directory-path">Current path</label>
                <div className="settings-inline-field">
                  <input
                    id="wizard-directory-path"
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
                  <button type="button" className="btn btn-secondary" onClick={() => void loadDirectory(directoryPath)} disabled={browsing}>
                    <i className={browsing ? 'fas fa-spinner fa-spin' : 'fas fa-location-crosshairs'}></i>
                    {browsing ? 'Loading…' : 'Go to Path'}
                  </button>
                </div>
              </div>

              <div className="settings-field-card settings-field-card--full">
                <label htmlFor="wizard-new-folder">Create a folder in the current location</label>
                <div className="settings-inline-field">
                  <input
                    id="wizard-new-folder"
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
                    <i className={creatingFolder ? 'fas fa-spinner fa-spin' : 'fas fa-folder-plus'}></i>
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
                <button type="button" className="btn btn-secondary" onClick={() => setShowDirectoryPicker(false)}>
                  Cancel
                </button>
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => handleDirectorySelection(directoryPath)}
                  disabled={!directoryPath}
                >
                  <i className="fas fa-check"></i>
                  Select Folder
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
