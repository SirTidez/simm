import { useEffect, useRef, useState } from 'react';
import { useEnvironmentStore } from '../stores/environmentStore';
import { useSettingsStore } from '../stores/settingsStore';
import { ApiService } from '../services/api';
import type { AppConfig, BranchConfig } from '../types';
import { resolveExperienceMode, resolveShowAdvancedGameTools } from '../utils/uxSettings';
import { Icon } from './Icon';
import {
  Dialog,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { SimmButton, SimmDialogContent } from './primitives';
import { WorkspacePageHeader } from './WorkspacePageHeader';

interface Props {
  onClose: () => void;
}

type WizardMode = 'landing' | 'download-select' | 'download-configure' | 'import-configure';
type DirectoryPurpose = 'download' | 'import';
type SteamInstallation = { path: string; executablePath: string; appId: string };

type WizardEmptyCardProps = {
  icon: string;
  title: string;
  description: string;
  tone?: 'default' | 'info';
};

function WizardEmptyCard({ icon, title, description, tone = 'default' }: WizardEmptyCardProps) {
  return (
    <Empty className={`wizard-empty-card ${tone === 'info' ? 'wizard-empty-card--info' : ''}`}>
      <EmptyMedia>
        <Icon name={icon} />
      </EmptyMedia>
      <EmptyHeader>
        <EmptyTitle>{title}</EmptyTitle>
        <EmptyDescription>{description}</EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}

function deriveBranchName(branch: BranchConfig): string {
  return branch.displayName.replace(/\s*\(IL2CPP\)|\s*\(Mono\)/gi, '').trim();
}

function slugifyEnvironmentName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, '-');
}

function buildDefaultInstallFolder(defaultDownloadDir: string, environmentName: string): string {
  const baseDir = defaultDownloadDir.trim().replace(/[\\/]+$/, '');
  const slug = slugifyEnvironmentName(environmentName) || 'environment';

  if (!baseDir) {
    return slug;
  }

  const separator = baseDir.includes('/') && !baseDir.includes('\\') ? '/' : '\\';
  return `${baseDir}${separator}${slug}`;
}

function getParentPath(currentPath: string): string | null {
  if (!currentPath) return null;
  if (/^[A-Z]:\\?$/i.test(currentPath)) return null;
  if (currentPath === '/' || currentPath === '\\') return null;

  const separator = currentPath.includes('/') ? '/' : '\\';
  const hasLeadingSeparator = separator === '/' && currentPath.startsWith('/');
  const hasUncPrefix = separator === '\\' && currentPath.startsWith('\\\\');
  const parts = currentPath.split(separator).filter(Boolean);

  if (parts.length <= 1 && currentPath.includes(':')) return null;

  parts.pop();

  if (parts.length === 0) {
    if (separator === '/') return '/';
    const drive = currentPath.match(/^[A-Z]:/i)?.[0];
    return drive ? `${drive}\\` : (hasUncPrefix ? '\\\\' : '\\');
  }

  const prefix = hasLeadingSeparator ? '/' : hasUncPrefix ? '\\\\' : '';
  return `${prefix}${parts.join(separator)}${separator === '/' ? '/' : ''}`;
}

export function EnvironmentCreationWizard({ onClose }: Props) {
  const { createEnvironment, startDownload, refreshEnvironments, environments } = useEnvironmentStore();
  const { settings, refreshDepotDownloader } = useSettingsStore();

  const [wizardMode, setWizardMode] = useState<WizardMode>('landing');
  const [appConfig, setAppConfig] = useState<AppConfig | null>(null);
  const [selectedBranch, setSelectedBranch] = useState<BranchConfig | null>(null);
  const [outputDir, setOutputDir] = useState('');
  const [outputDirIsAutoDerived, setOutputDirIsAutoDerived] = useState(true);
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
  const [steamDetectionError, setSteamDetectionError] = useState<string | null>(null);

  const [importPath, setImportPath] = useState('');
  const [importingLocal, setImportingLocal] = useState(false);

  const [depotDownloaderInstalled, setDepotDownloaderInstalled] = useState<boolean | null>(null);
  const [installingDepotDownloader, setInstallingDepotDownloader] = useState(false);
  const [depotDownloaderPromptError, setDepotDownloaderPromptError] = useState<string | null>(null);
  const [depotDownloaderDetectionError, setDepotDownloaderDetectionError] = useState<string | null>(null);
  const previousDerivedNameRef = useRef('');
  const autoDepotInstallAttemptedRef = useRef(false);

  const hasSteamEnvironment = environments.some(
    env => env.environmentType === 'Steam' || env.environmentType === 'steam' || env.id.startsWith('steam-')
  );
  const isSteamAuthenticated = Boolean(settings?.steamUsername);
  const steamDetected = steamInstallations.length > 0 && !steamDetectionError;
  const experienceMode = resolveExperienceMode(settings);
  const showAdvancedGameTools = resolveShowAdvancedGameTools(settings);
  const canDownloadBranches = experienceMode === 'powerUser' && showAdvancedGameTools;

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
        const config = await ApiService.getSchedule1Config();
        setAppConfig(config);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load environment creation data');
      }

    };

    void loadInitialState();
  }, []);

  useEffect(() => {
    if (!outputDirIsAutoDerived || !selectedBranch) {
      return;
    }

    const nextDerivedName = name.trim() || deriveBranchName(selectedBranch);
    setOutputDir(buildDefaultInstallFolder(settings?.defaultDownloadDir || '', nextDerivedName));
  }, [name, outputDirIsAutoDerived, selectedBranch, settings?.defaultDownloadDir]);

  useEffect(() => {
    const detectSteamOnOpen = async () => {
      try {
        const installations = await ApiService.detectSteamInstallations();
        setSteamInstallations(installations);
        setSteamDetectionError(null);
      } catch (err) {
        setSteamInstallations([]);
        setSteamDetectionError(
          err instanceof Error ? err.message : 'Unable to detect Steam installations right now.'
        );
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
    setDirectoryPath('');
    setDirectoryList([]);
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
      setOutputDirIsAutoDerived(false);
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
      setSteamDetectionError(null);
      setShowSteamInstallations(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to detect Steam installations');
      setSteamInstallations([]);
      setSteamDetectionError(
        err instanceof Error ? err.message : 'Unable to detect Steam installations right now.'
      );
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
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create Steam environment');
      setLoading(false);
      return;
    }

    try {
      await refreshEnvironments();
    } catch (err) {
      console.warn('Steam environment created, but SIMM could not refresh the environment list.', err);
    }

    setLoading(false);
    onClose();
  };

  const handleAutoInstallDepotDownloader = async () => {
    setInstallingDepotDownloader(true);
    setDepotDownloaderPromptError(null);
    try {
      await ApiService.installDepotDownloader();
      setDepotDownloaderInstalled(true);
      setDepotDownloaderDetectionError(null);
    } catch (err) {
      setDepotDownloaderPromptError(err instanceof Error ? err.message : 'Failed to install DepotDownloader automatically.');
      setInstallingDepotDownloader(false);
      return;
    }

    try {
      await refreshDepotDownloader();
      const depotInfo = await ApiService.detectDepotDownloader();
      setDepotDownloaderInstalled(!!depotInfo.installed);
      setDepotDownloaderDetectionError(null);
    } catch (err) {
      setDepotDownloaderPromptError(
        err instanceof Error
          ? `DepotDownloader installed, but SIMM could not refresh its status: ${err.message}`
          : 'DepotDownloader installed, but SIMM could not refresh its status.'
      );
    }

    setInstallingDepotDownloader(false);
  };

  const handleOpenDepotDownloaderInstructions = () => {
    window.open('https://github.com/SteamRE/DepotDownloader#installation', '_blank', 'noopener,noreferrer');
  };

  const refreshDepotDownloaderStatus = async () => {
    setDepotDownloaderInstalled(null);
    setDepotDownloaderDetectionError(null);
    try {
      const depotInfo = await ApiService.detectDepotDownloader();
      setDepotDownloaderInstalled(!!depotInfo.installed);
    } catch (err) {
      setDepotDownloaderInstalled(null);
      setDepotDownloaderDetectionError(
        err instanceof Error ? err.message : 'Unable to detect DepotDownloader right now.'
      );
    }
  };

  useEffect(() => {
    if (wizardMode !== 'download-select') {
      return;
    }

    if (depotDownloaderInstalled === null && !depotDownloaderDetectionError) {
      void refreshDepotDownloaderStatus();
      return;
    }

    if (
      depotDownloaderInstalled === false &&
      !depotDownloaderDetectionError &&
      !depotDownloaderPromptError &&
      !installingDepotDownloader &&
      !autoDepotInstallAttemptedRef.current
    ) {
      autoDepotInstallAttemptedRef.current = true;
      void handleAutoInstallDepotDownloader();
    }

  }, [
    wizardMode,
    depotDownloaderInstalled,
    depotDownloaderDetectionError,
    depotDownloaderPromptError,
    installingDepotDownloader,
  ]);

  const handleBranchSelect = (branch: BranchConfig) => {
    if (depotDownloaderInstalled !== true) return;

    const nextDerivedName = deriveBranchName(branch);
    setSelectedBranch(branch);
    setOutputDirIsAutoDerived(true);
    setName((currentName) => {
      if (currentName && currentName !== previousDerivedNameRef.current) {
        return currentName;
      }
      previousDerivedNameRef.current = nextDerivedName;
      return nextDerivedName;
    });
    setOutputDir(buildDefaultInstallFolder(settings?.defaultDownloadDir || '', nextDerivedName));
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
      const environment = await createEnvironment({
        appId: appConfig.appId,
        branch: selectedBranch.name,
        outputDir,
        name: name || undefined,
        description: description.trim() || undefined
      });
      await startDownload(environment.id);
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
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to import local environment');
      setImportingLocal(false);
      return;
    }

    try {
      await refreshEnvironments();
    } catch (err) {
      setError(
        err instanceof Error
          ? `Environment imported, but SIMM could not refresh the environment list: ${err.message}`
          : 'Environment imported, but SIMM could not refresh the environment list.'
      );
      setImportingLocal(false);
      return;
    }

    setImportingLocal(false);
    onClose();
  };

  const wizardStats = [
    {
      label: 'Steam',
      value: hasSteamEnvironment
        ? 'Managed'
        : steamDetectionError
          ? 'Check failed'
          : steamDetected
            ? 'Detected'
            : 'Not linked'
    },
    ...(canDownloadBranches ? [{
      label: 'DepotDownloader',
      value: depotDownloaderDetectionError
        ? 'Check failed'
        : depotDownloaderInstalled === null
          ? 'Not checked'
          : depotDownloaderInstalled
            ? 'Ready'
            : 'Missing'
    }] : []),
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
      <WorkspacePageHeader
        eyebrow="Workspace"
        title="Add Game"
        description="Create or import a Schedule I environment and choose runtime, branch, and install settings."
      />

      {error && <div className="settings-error-banner">{error}</div>}

      <div className="wizard-panel__body">
        <div className="wizard-overview">
          <div className="wizard-overview__copy">
            <span className="settings-eyebrow">Environment Setup</span>
            <h3>Add or import a game install.</h3>
            <p>
              SIMM looks for your Steam install automatically. Import a folder only if detection misses it.
              Power User mode can also add separate Steam branches when needed.
            </p>
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
                <Icon name="fab fa-steam-symbol" />
              </div>
              <div>
                <span className="settings-eyebrow">Steam Detection</span>
                <h3>
                  {hasSteamEnvironment
                    ? 'Steam install already managed'
                    : steamDetectionError
                      ? 'Steam detection is unavailable right now'
                      : steamDetected
                        ? 'Steam install detected'
                        : 'No Steam install detected yet'}
                </h3>
                <p>
                  {hasSteamEnvironment
                    ? 'Your primary Steam install is already linked to SIMM. Steam continues to manage game updates and does not need a Steam login inside SIMM.'
                    : steamDetectionError
                      ? 'SIMM could not verify Steam installations on this machine. Retry detection if you expect an existing install to appear.'
                      : steamDetected
                      ? 'A Schedule I Steam install was found on this machine. Add it to SIMM so Steam keeps handling game updates while SIMM manages mods and tools. No Steam login is needed for this path.'
                      : 'Refresh detection to find your existing Steam install. Use Import only if SIMM still cannot find the folder.'}
                </p>
              </div>
            </div>
          <div className="wizard-steam-card__actions">
              <SimmButton type="button" variant="secondary" className="btn btn-secondary" onClick={() => void handleDetectSteam()} disabled={detectingSteam}>
                <Icon name={detectingSteam ? 'fas fa-spinner fa-spin' : 'fab fa-steam'} />
                {detectingSteam ? 'Detecting…' : steamDetected ? 'Refresh Detection' : 'Detect Steam Install'}
              </SimmButton>
              {!hasSteamEnvironment && steamDetected && (
                <SimmButton type="button" variant="secondary" className="btn btn-secondary" onClick={() => setShowSteamInstallations((value) => !value)}>
                  <Icon name="fas fa-list" />
                  {showSteamInstallations ? 'Hide Detected Installs' : 'Review Detected Installs'}
                </SimmButton>
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
                <WizardEmptyCard
                  icon="fab fa-steam"
                  title="No Steam installation found"
                  description="Make sure Schedule I is installed through Steam, then refresh detection to try again."
                />
              ) : (
                <>
                  <div className="settings-field-grid">
                    <div className="settings-field-card">
                      <label htmlFor="wizard-steam-name">Display name</label>
                      <Input
                        id="wizard-steam-name"
                        type="text"
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                        placeholder="Steam Installation"
                      />
                    </div>

                    <div className="settings-field-card settings-field-card--full">
                      <label htmlFor="wizard-steam-description">Description</label>
                      <Textarea
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
                      <div key={installation.path} role="listitem">
                        <SimmButton
                          type="button"
                          variant="ghost"
                          className="wizard-steam-install-row h-auto"
                          onClick={() => void handleCreateSteamEnvironment(installation.path)}
                          disabled={loading}
                        >
                          <div className="wizard-steam-install-row__icon">
                            <Icon name="fab fa-steam-symbol" />
                          </div>
                          <div className="wizard-steam-install-row__content">
                            <strong>Schedule I Steam install</strong>
                            <span>{installation.path}</span>
                          </div>
                          <span className="wizard-inline-action">
                            {loading ? 'Linking…' : 'Add to SIMM'}
                          </span>
                        </SimmButton>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </div>
          )}
        </section>

        {wizardMode === 'landing' && (
          <section className="wizard-entry-grid" aria-label="Environment creation methods">
            <SimmButton
              type="button"
              variant="ghost"
              className="wizard-entry-card h-auto"
              onClick={() => {
                setError(null);
                setWizardMode('import-configure');
              }}
            >
              <div className="wizard-entry-card__icon wizard-entry-card__icon--success">
                <Icon name="fas fa-folder-open" />
              </div>
              <div className="wizard-entry-card__content">
                <span className="settings-eyebrow">Import</span>
                <h3>Import Existing Folder</h3>
                <p>Use this when automatic Steam detection misses your game, or when you keep a separate local copy on disk.</p>
              </div>
              <span className="wizard-inline-action">Select Folder</span>
            </SimmButton>

            {canDownloadBranches && (
              <SimmButton
                type="button"
                variant="ghost"
                className="wizard-entry-card h-auto"
                onClick={() => {
                  setError(null);
                  setWizardMode('download-select');
                }}
              >
                <div className="wizard-entry-card__icon">
                  <Icon name="fas fa-download" />
                </div>
                <div className="wizard-entry-card__content">
                  <span className="settings-eyebrow">Advanced</span>
                  <h3>Download Separate Branch</h3>
                  <p>Create a separate SIMM-managed Steam branch install for beta, alternate, or runtime-specific testing. SIMM handles updates for these installs.</p>
                </div>
                <span className="wizard-inline-action">Browse Branches</span>
              </SimmButton>
            )}
          </section>
        )}

        {wizardMode === 'download-select' && (
          <section className="wizard-step-card">
            <div className="wizard-step-card__header">
              <div>
                <span className="settings-eyebrow">Step 1</span>
                <h3>Select a branch to download</h3>
                <p>Choose the Steam branch and runtime you need. SIMM will configure the install folder in the next step.</p>
              </div>
              <SimmButton type="button" variant="secondary" className="btn btn-secondary btn-small" onClick={() => setWizardMode('landing')}>
                <Icon name="fas fa-arrow-left" />
                Back
              </SimmButton>
            </div>

            {(depotDownloaderInstalled !== true || depotDownloaderDetectionError) && (
              <div className="wizard-prerequisite-card">
                <div className="wizard-prerequisite-card__copy">
                  <span className="settings-eyebrow">Requirement</span>
                  <h4>{depotDownloaderDetectionError ? 'Unable to verify DepotDownloader status' : 'DepotDownloader is required for separate branch installs'}</h4>
                  <p>
                    {depotDownloaderDetectionError
                      ? 'SIMM could not confirm whether DepotDownloader is installed. Retry the check or open the manual instructions before adding a branch.'
                      : 'SIMM uses DepotDownloader to add and update separate Steam branch installs. You can install it automatically or open the official manual instructions.'}
                  </p>
                  {depotDownloaderDetectionError && <div className="settings-error-banner">{depotDownloaderDetectionError}</div>}
                  {depotDownloaderPromptError && <div className="settings-error-banner">{depotDownloaderPromptError}</div>}
                </div>
                <div className="wizard-inline-actions">
                  <SimmButton
                    type="button"
                    className="btn btn-primary"
                    onClick={() => {
                      if (depotDownloaderDetectionError) {
                        setDepotDownloaderInstalled(null);
                        void ApiService.detectDepotDownloader()
                          .then((info) => {
                            setDepotDownloaderInstalled(!!info.installed);
                            setDepotDownloaderDetectionError(null);
                          })
                          .catch((err) => {
                            setDepotDownloaderInstalled(null);
                            setDepotDownloaderDetectionError(
                              err instanceof Error ? err.message : 'Unable to detect DepotDownloader right now.'
                            );
                          });
                        return;
                      }
                      void handleAutoInstallDepotDownloader();
                    }}
                    disabled={installingDepotDownloader || (!depotDownloaderDetectionError && depotDownloaderInstalled === null)}
                  >
                    <Icon name={installingDepotDownloader ? 'fas fa-spinner fa-spin' : 'fas fa-download'} />
                    {depotDownloaderDetectionError
                      ? 'Retry Detection'
                      : depotDownloaderInstalled === null
                      ? 'Checking…'
                      : installingDepotDownloader
                        ? 'Installing…'
                        : 'Install Automatically'}
                  </SimmButton>
                  <SimmButton type="button" variant="secondary" className="btn btn-secondary" onClick={handleOpenDepotDownloaderInstructions}>
                    <Icon name="fas fa-external-link-alt" />
                    Manual Instructions
                  </SimmButton>
                </div>
              </div>
            )}

            {appConfig ? (
              <div className="wizard-branch-grid" role="list">
                {appConfig.branches.map((branch) => {
                  const authRequired = branch.requiresAuth && !isSteamAuthenticated;
                  const depotRequired = depotDownloaderInstalled !== true || !!depotDownloaderDetectionError;
                  const disabled = authRequired || depotRequired;

                  return (
                    <div key={branch.name} role="listitem">
                      <SimmButton
                        type="button"
                        variant="ghost"
                        className={`wizard-branch-card h-auto ${disabled ? 'wizard-branch-card--disabled' : ''}`}
                        onClick={() => {
                          if (!disabled) handleBranchSelect(branch);
                        }}
                        disabled={disabled}
                        title={
                          authRequired
                            ? 'Authenticate with Steam to authorize SIMM for this Schedule I install'
                            : depotRequired
                              ? depotDownloaderDetectionError
                                ? 'SIMM could not verify DepotDownloader for this branch'
                                : 'DepotDownloader is required to add this branch'
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
                          <span>{authRequired ? 'Authenticate with Steam in Accounts to authorize SIMM for this install.' : depotRequired ? (depotDownloaderDetectionError ? 'Fix DepotDownloader detection before adding this branch.' : 'Install DepotDownloader to unlock branch installs.') : 'Continue to environment configuration.'}</span>
                        </div>
                      </SimmButton>
                    </div>
                  );
                })}
              </div>
            ) : (
              <WizardEmptyCard
                icon="fas fa-spinner fa-spin"
                title="Loading branches"
                description="SIMM is fetching the currently supported game branches."
              />
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
              <SimmButton type="button" variant="secondary" className="btn btn-secondary btn-small" onClick={() => setWizardMode('download-select')}>
                <Icon name="fas fa-arrow-left" />
                Back
              </SimmButton>
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
                  <Input
                    id="wizard-download-name"
                    type="text"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="Environment name"
                  />
                </div>

                <div className="settings-field-card settings-field-card--full">
                  <label htmlFor="wizard-download-description">Description</label>
                  <Textarea
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
                    <Input
                      id="wizard-download-base-dir"
                      type="text"
                      value={outputDir}
                      onChange={(e) => {
                        setOutputDirIsAutoDerived(false);
                        setOutputDir(e.target.value);
                      }}
                      placeholder="C:\\Games\\Schedule I Beta"
                    />
                    <SimmButton type="button" variant="secondary" className="btn btn-secondary" onClick={() => void openDirectoryPicker('download')}>
                      <Icon name="fas fa-folder-open" />
                      Browse
                    </SimmButton>
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
              <SimmButton type="button" variant="secondary" className="btn btn-secondary" onClick={() => setWizardMode('download-select')}>
                Back
              </SimmButton>
              <SimmButton type="button" className="btn btn-primary" onClick={() => void handleCreate()} disabled={loading || !outputDir}>
                <Icon name={loading ? 'fas fa-spinner fa-spin' : 'fas fa-plus'} />
                {loading ? 'Creating…' : 'Create Environment'}
              </SimmButton>
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
              <SimmButton
                type="button"
                variant="secondary"
                className="btn btn-secondary btn-small"
                onClick={() => {
                  setWizardMode('landing');
                  setImportPath('');
                }}
              >
                <Icon name="fas fa-arrow-left" />
                Back
              </SimmButton>
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
                    <Input
                      id="wizard-import-path"
                      type="text"
                      value={importPath}
                      onChange={(e) => setImportPath(e.target.value)}
                      placeholder="C:\\Games\\Schedule I"
                    />
                    <SimmButton type="button" variant="secondary" className="btn btn-secondary" onClick={() => void openDirectoryPicker('import')}>
                      <Icon name="fas fa-folder-open" />
                      Browse
                    </SimmButton>
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
                  <Input
                    id="wizard-import-name"
                    type="text"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="My Game Install"
                  />
                </div>

                <div className="settings-field-card settings-field-card--full">
                  <label htmlFor="wizard-import-description">Description</label>
                  <Textarea
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

            <WizardEmptyCard
              icon="fas fa-circle-info"
              title="Runtime and branch are detected automatically"
              description="Import is only asking for the folder and optional labels. SIMM will identify runtime, branch, version, and installed tooling from disk."
              tone="info"
            />

            <div className="wizard-panel__actions">
              <SimmButton
                type="button"
                variant="secondary"
                className="btn btn-secondary"
                onClick={() => {
                  setWizardMode('landing');
                  setImportPath('');
                }}
              >
                Back
              </SimmButton>
              <SimmButton
                type="button"
                className="btn btn-primary"
                onClick={() => void handleImportLocalEnvironment()}
                disabled={importingLocal || !importPath}
              >
                <Icon name={importingLocal ? 'fas fa-spinner fa-spin' : 'fas fa-folder-plus'} />
                {importingLocal ? 'Importing…' : 'Import Installation'}
              </SimmButton>
            </div>
          </section>
        )}
      </div>

      {showDirectoryPicker && (
        <Dialog open={showDirectoryPicker} onOpenChange={(open) => {
          if (!open) {
            setShowDirectoryPicker(false);
          }
        }}>
          <SimmDialogContent
            nested
            className="wizard-directory-dialog"
            showCloseButton={false}
          >
            <DialogHeader className="modal-header">
              <DialogTitle>{directoryPurpose === 'import' ? 'Select Game Folder' : 'Select Install Folder'}</DialogTitle>
              <SimmButton variant="ghost" size="icon-sm" className="modal-close" onClick={() => setShowDirectoryPicker(false)} aria-label="Close directory picker">×</SimmButton>
            </DialogHeader>

            <div className="wizard-directory-dialog__body">
              <div className="wizard-directory-dialog__overview">
                <span className="settings-eyebrow">Directory Browser</span>
                <h3>{directoryPurpose === 'import' ? 'Choose the local game folder to import' : 'Choose the install folder for this branch install'}</h3>
                <p>Browse folders, create a new subdirectory if needed, and confirm the current location when you are ready.</p>
              </div>

              <div className="settings-field-card settings-field-card--full">
                <label htmlFor="wizard-directory-path">Current path</label>
                <div className="settings-inline-field">
                  <Input
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
                  <SimmButton type="button" className="btn btn-secondary" onClick={() => void loadDirectory(directoryPath)} disabled={browsing}>
                    <Icon name={browsing ? 'fas fa-spinner fa-spin' : 'fas fa-location-crosshairs'} />
                    {browsing ? 'Loading…' : 'Go to Path'}
                  </SimmButton>
                </div>
              </div>

              <div className="settings-field-card settings-field-card--full">
                <label htmlFor="wizard-new-folder">Create a folder in the current location</label>
                <div className="settings-inline-field">
                  <Input
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
                  <SimmButton
                    type="button"
                    className="btn btn-secondary"
                    onClick={() => void handleCreateFolder()}
                    disabled={creatingFolder || !newFolderName.trim() || !directoryPath}
                  >
                    <Icon name={creatingFolder ? 'fas fa-spinner fa-spin' : 'fas fa-folder-plus'} />
                    {creatingFolder ? 'Creating…' : 'Create Folder'}
                  </SimmButton>
                </div>
              </div>

              <div className="wizard-directory-dialog__list" role="list">
                {browsing ? (
                  <WizardEmptyCard
                    icon="fas fa-spinner fa-spin"
                    title="Loading directories"
                    description="SIMM is reading the current folder contents."
                  />
                ) : (
                  <>
                    {getParentPath(directoryPath) && (
                      <div role="listitem">
                        <SimmButton
                          type="button"
                          variant="ghost"
                          className="wizard-directory-row wizard-directory-row--parent h-auto"
                          onClick={() => void loadDirectory(getParentPath(directoryPath) || '')}
                        >
                          <Icon name="fas fa-arrow-up" />
                          <span>Parent Directory</span>
                        </SimmButton>
                      </div>
                    )}

                    {directoryList.length === 0 ? (
                      <WizardEmptyCard
                        icon="fas fa-folder-open"
                        title="No subdirectories found"
                        description="This location does not contain any folders that SIMM can browse into right now."
                      />
                    ) : (
                      directoryList.map((dir) => (
                        <div key={dir.path} role="listitem">
                          <SimmButton
                            type="button"
                            variant="ghost"
                            className="wizard-directory-row h-auto"
                            onClick={() => void loadDirectory(dir.path)}
                          >
                            <Icon name="fas fa-folder" />
                            <span>{dir.name}</span>
                          </SimmButton>
                        </div>
                      ))
                    )}
                  </>
                )}
              </div>

              <div className="wizard-panel__actions wizard-panel__actions--dialog">
                <SimmButton type="button" className="btn btn-secondary" onClick={() => setShowDirectoryPicker(false)}>
                  Cancel
                </SimmButton>
                <SimmButton
                  type="button"
                  className="btn btn-primary"
                  onClick={() => handleDirectorySelection(directoryPath)}
                  disabled={browsing || !directoryPath}
                >
                  <Icon name="fas fa-check" />
                  Select Folder
                </SimmButton>
              </div>
            </div>
          </SimmDialogContent>
        </Dialog>
      )}
    </section>
  );
}
