import { useCallback, useEffect, useRef, useState } from 'react';
import { useEnvironmentStore } from '../stores/environmentStore';
import { useSettingsStore } from '../stores/settingsStore';
import { ApiService } from '../services/api';
import type { AppConfig, BranchConfig } from '../types';
import { resolveExperienceMode, resolveShowAdvancedGameTools } from '../utils/uxSettings';
import { Icon } from './Icon';
import { GameArt } from './media/GameArt';
import {
  Dialog,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Textarea } from '@/components/ui/textarea';
import { SimmButton, SimmDialogContent } from './primitives';

interface Props {
  onClose: () => void;
}

type WizardMode = 'landing' | 'steam-configure' | 'download-select' | 'download-configure' | 'import-configure';
type WizardSource = 'steam' | 'import' | 'download';
type DirectoryPurpose = 'download' | 'import';
type SteamInstallation = { path: string; executablePath: string; appId: string };

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
  const { createEnvironment, startDownload, refreshEnvironments, environments, activeGameDownloadId } = useEnvironmentStore();
  const { settings, refreshDepotDownloader } = useSettingsStore();

  const [wizardMode, setWizardMode] = useState<WizardMode>('landing');
  const [source, setSource] = useState<WizardSource | null>(null);
  const [pendingBranchName, setPendingBranchName] = useState<string | null>(null);
  const [selectedSteamPath, setSelectedSteamPath] = useState('');
  const [appConfig, setAppConfig] = useState<AppConfig | null>(null);
  const [selectedBranch, setSelectedBranch] = useState<BranchConfig | null>(null);
  const [outputDir, setOutputDir] = useState('');
  const [outputDirIsAutoDerived, setOutputDirIsAutoDerived] = useState(true);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const activeGameDownloadName = activeGameDownloadId
    ? environments.find((environment) => environment.id === activeGameDownloadId)?.name ?? 'another environment'
    : null;
  const gameOperationInProgress = Boolean(activeGameDownloadId);

  const [showDirectoryPicker, setShowDirectoryPicker] = useState(false);
  const [directoryPurpose, setDirectoryPurpose] = useState<DirectoryPurpose>('download');
  const [directoryPath, setDirectoryPath] = useState('');
  const [directoryList, setDirectoryList] = useState<Array<{ name: string; path: string }>>([]);
  const [browsing, setBrowsing] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const [creatingFolder, setCreatingFolder] = useState(false);

  const [steamInstallations, setSteamInstallations] = useState<SteamInstallation[]>([]);
  const [detectingSteam, setDetectingSteam] = useState(false);
  const [steamDetectionError, setSteamDetectionError] = useState<string | null>(null);

  const [importPath, setImportPath] = useState('');
  const [importingLocal, setImportingLocal] = useState(false);

  const [depotDownloaderInstalled, setDepotDownloaderInstalled] = useState<boolean | null>(null);
  const [depotDownloaderCanAutoInstall, setDepotDownloaderCanAutoInstall] = useState<boolean | null>(null);
  const [depotDownloaderInstallHint, setDepotDownloaderInstallHint] = useState<string | null>(null);
  const [depotDownloaderInstallHelpUrl, setDepotDownloaderInstallHelpUrl] = useState('https://github.com/SteamRE/DepotDownloader#installation');
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
  const platform = settings?.platform ?? 'windows';
  const canAutoInstallDepotDownloader = depotDownloaderCanAutoInstall ?? (platform === 'windows' || platform === 'linux');

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
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to detect Steam installations');
      setSteamInstallations([]);
      setSteamDetectionError(
        err instanceof Error ? err.message : 'Unable to detect Steam installations right now.'
      );
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

  const handleAutoInstallDepotDownloader = useCallback(async () => {
    if (!canAutoInstallDepotDownloader) {
      setDepotDownloaderPromptError(
        depotDownloaderInstallHint || 'Install DepotDownloader manually, then retry detection.'
      );
      return;
    }

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
      setDepotDownloaderCanAutoInstall(depotInfo.canAutoInstall ?? null);
      setDepotDownloaderInstallHint(depotInfo.installHint ?? null);
      setDepotDownloaderInstallHelpUrl(depotInfo.installHelpUrl ?? 'https://github.com/SteamRE/DepotDownloader#installation');
      setDepotDownloaderDetectionError(null);
    } catch (err) {
      setDepotDownloaderPromptError(
        err instanceof Error
          ? `DepotDownloader installed, but SIMM could not refresh its status: ${err.message}`
          : 'DepotDownloader installed, but SIMM could not refresh its status.'
      );
    }

    setInstallingDepotDownloader(false);
  }, [canAutoInstallDepotDownloader, depotDownloaderInstallHint, refreshDepotDownloader]);

  const handleOpenDepotDownloaderInstructions = () => {
    window.open(depotDownloaderInstallHelpUrl, '_blank', 'noopener,noreferrer');
  };

  const refreshDepotDownloaderStatus = useCallback(async () => {
    setDepotDownloaderInstalled(null);
    setDepotDownloaderDetectionError(null);
    try {
      const depotInfo = await ApiService.detectDepotDownloader();
      setDepotDownloaderInstalled(!!depotInfo.installed);
      setDepotDownloaderCanAutoInstall(depotInfo.canAutoInstall ?? null);
      setDepotDownloaderInstallHint(depotInfo.installHint ?? null);
      setDepotDownloaderInstallHelpUrl(depotInfo.installHelpUrl ?? 'https://github.com/SteamRE/DepotDownloader#installation');
    } catch (err) {
      setDepotDownloaderInstalled(null);
      setDepotDownloaderDetectionError(
        err instanceof Error ? err.message : 'Unable to detect DepotDownloader right now.'
      );
    }
  }, []);

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
      canAutoInstallDepotDownloader &&
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
    canAutoInstallDepotDownloader,
    installingDepotDownloader,
    refreshDepotDownloaderStatus,
    handleAutoInstallDepotDownloader,
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
    if (gameOperationInProgress) {
      setError(`${activeGameDownloadName} is already downloading or updating. Wait for it to finish before creating another game environment.`);
      return;
    }
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

  const steamAvailable = steamDetected && !hasSteamEnvironment;
  const effectiveSource: WizardSource = source ?? (steamAvailable ? 'steam' : 'import');
  const activeSource: WizardSource = wizardMode === 'download-select' || wizardMode === 'download-configure'
    ? 'download'
    : wizardMode === 'import-configure'
      ? 'import'
      : wizardMode === 'steam-configure'
        ? 'steam'
        : effectiveSource;
  const steps = activeSource === 'download'
    ? ['Source', 'Branch', 'Details']
    : activeSource === 'import'
      ? ['Source', 'Folder']
      : ['Source', 'Details'];
  const currentStepIndex = wizardMode === 'landing'
    ? 0
    : wizardMode === 'download-configure'
      ? 2
      : 1;
  const selectedSteamInstallPath = steamInstallations.some((installation) => installation.path === selectedSteamPath)
    ? selectedSteamPath
    : steamInstallations[0]?.path ?? '';
  const pendingBranch = appConfig?.branches.find((branch) => branch.name === pendingBranchName) ?? null;
  const branchBlockReason = (branch: BranchConfig): string | null => {
    if (gameOperationInProgress) return `${activeGameDownloadName} is already downloading or updating. Wait for it to finish first.`;
    if (depotDownloaderInstalled !== true || depotDownloaderDetectionError) {
      return depotDownloaderDetectionError ? 'Fix DepotDownloader detection first.' : 'Needs DepotDownloader.';
    }
    if (branch.requiresAuth && !isSteamAuthenticated) return 'Sign in to Steam in Accounts to download this branch.';
    return null;
  };

  const goToLanding = () => {
    setError(null);
    setWizardMode('landing');
  };

  const continueFromLanding = () => {
    setError(null);
    if (effectiveSource === 'steam') {
      setWizardMode('steam-configure');
    } else if (effectiveSource === 'download') {
      setWizardMode('download-select');
    } else {
      setWizardMode('import-configure');
    }
  };

  const retryDepotDownloaderDetection = () => {
    setDepotDownloaderInstalled(null);
    void ApiService.detectDepotDownloader()
      .then((info) => {
        setDepotDownloaderInstalled(!!info.installed);
        setDepotDownloaderCanAutoInstall(info.canAutoInstall ?? null);
        setDepotDownloaderInstallHint(info.installHint ?? null);
        setDepotDownloaderInstallHelpUrl(info.installHelpUrl ?? 'https://github.com/SteamRE/DepotDownloader#installation');
        setDepotDownloaderDetectionError(null);
      })
      .catch((err) => {
        setDepotDownloaderInstalled(null);
        setDepotDownloaderDetectionError(
          err instanceof Error ? err.message : 'Unable to detect DepotDownloader right now.'
        );
      });
  };

  const steamOptionDescription = hasSteamEnvironment
    ? 'Your Steam install is already added to SIMM.'
    : steamDetectionError
      ? 'SIMM could not check for Steam installs right now.'
      : steamDetected
        ? 'Steam keeps the game updated. No Steam sign-in is needed in SIMM.'
        : 'No Steam install of Schedule I was found on this computer.';

  const renderFooter = (
    back: { label: string; onClick: () => void },
    primary: { label: string; onClick: () => void; disabled?: boolean; busy?: boolean; title?: string },
  ) => (
    <footer className="wizard__footer">
      <SimmButton type="button" variant="secondary" onClick={back.onClick}>
        {back.label}
      </SimmButton>
      <SimmButton type="button" onClick={primary.onClick} disabled={primary.disabled} title={primary.title}>
        {primary.busy && <Icon name="spinner" spin />}
        {primary.label}
      </SimmButton>
    </footer>
  );

  const detailFields = (idPrefix: string, namePlaceholder: string) => (
    <>
      <div className="wizard-field">
        <label htmlFor={`${idPrefix}-name`}>Name</label>
        <Input
          id={`${idPrefix}-name`}
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={namePlaceholder}
        />
      </div>
      <div className="wizard-field">
        <label htmlFor={`${idPrefix}-description`}>
          Description <span className="ui-subtle">(optional)</span>
        </label>
        <Textarea
          id={`${idPrefix}-description`}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="What is this environment for?"
          rows={2}
        />
      </div>
    </>
  );

  return (
    <section className="wizard" aria-label="Add Environment">
      <header className="ui-page-header wizard__header">
        <div className="ui-page-header__titles">
          <h1 className="ui-page-title">Add Environment</h1>
          <p className="ui-page-subtitle">Add a Schedule I install so SIMM can manage its mods.</p>
        </div>
        <ol className="wizard-steps" aria-label="Steps">
          {steps.map((label, index) => (
            <li
              key={label}
              className={`wizard-steps__item${index === currentStepIndex ? ' wizard-steps__item--current' : ''}${index < currentStepIndex ? ' wizard-steps__item--done' : ''}`}
              aria-current={index === currentStepIndex ? 'step' : undefined}
            >
              <span className="wizard-steps__marker" aria-hidden="true">
                {index < currentStepIndex ? <Icon name="check" /> : index + 1}
              </span>
              {label}
            </li>
          ))}
        </ol>
      </header>

      <div className="wizard__body">
        <div className="wizard__content">
          {error && (
            <div className="ui-callout ui-callout--danger" role="alert">
              <span>{error}</span>
            </div>
          )}

          {wizardMode === 'landing' && (
            <>
              <div className="wizard__intro">
                <h2>How do you want to add the game?</h2>
              </div>
              <RadioGroup
                className="wizard-options"
                value={effectiveSource}
                onValueChange={(value) => setSource(value as WizardSource)}
                aria-label="Environment source"
              >
                <label className={`wizard-option${!steamAvailable ? ' wizard-option--disabled' : ''}`}>
                  <RadioGroupItem value="steam" disabled={!steamAvailable} />
                  <span className="ui-thumb wizard-option__icon" aria-hidden="true"><Icon name="steam" /></span>
                  <span className="wizard-option__text">
                    <strong>Use My Steam Install</strong>
                    <span>{steamOptionDescription}</span>
                    {steamAvailable && (
                      <span className="ui-mono ui-truncate wizard-option__path" title={steamInstallations[0].path}>
                        {steamInstallations[0].path}
                        {steamInstallations.length > 1 ? ` (+${steamInstallations.length - 1} more)` : ''}
                      </span>
                    )}
                  </span>
                  {steamAvailable && <GameArt appId={steamInstallations[0].appId} className="wizard-option__art" />}
                </label>
                <label className="wizard-option">
                  <RadioGroupItem value="import" />
                  <span className="ui-thumb wizard-option__icon" aria-hidden="true"><Icon name="folderOpen" /></span>
                  <span className="wizard-option__text">
                    <strong>Import Existing Folder</strong>
                    <span>Use a Schedule I folder that is already on disk. SIMM detects branch, runtime, and version.</span>
                  </span>
                </label>
                {canDownloadBranches && (
                  <label className="wizard-option">
                    <RadioGroupItem value="download" />
                    <span className="ui-thumb wizard-option__icon" aria-hidden="true"><Icon name="cloudDownloadAlt" /></span>
                    <span className="wizard-option__text">
                      <strong>Download Separate Branch</strong>
                      <span>Download a beta or alternate branch into its own folder. SIMM keeps it updated.</span>
                    </span>
                    <span className="ui-tag">Advanced</span>
                  </label>
                )}
              </RadioGroup>
              {!hasSteamEnvironment && (
                <p className="wizard__hint">
                  Installed Schedule I through Steam recently?{' '}
                  <SimmButton type="button" variant="link" onClick={() => void handleDetectSteam()} disabled={detectingSteam}>
                    {detectingSteam ? 'Detecting…' : 'Detect Steam Install'}
                  </SimmButton>
                </p>
              )}
            </>
          )}

          {wizardMode === 'steam-configure' && (
            <>
              <div className="wizard__intro">
                <h2>Name this environment</h2>
                <p>Steam keeps the game updated. SIMM manages mods, plugins, and configs.</p>
              </div>
              {steamInstallations.length > 1 ? (
                <RadioGroup
                  className="wizard-options"
                  value={selectedSteamInstallPath}
                  onValueChange={(value) => setSelectedSteamPath(String(value))}
                  aria-label="Steam install"
                >
                  {steamInstallations.map((installation) => (
                    <label key={installation.path} className="wizard-option">
                      <RadioGroupItem value={installation.path} />
                      <span className="wizard-option__text">
                        <span className="ui-mono ui-truncate" title={installation.path}>{installation.path}</span>
                      </span>
                    </label>
                  ))}
                </RadioGroup>
              ) : (
                <dl className="ui-kv wizard__facts">
                  <dt>Steam install</dt>
                  <dd className="ui-mono">{selectedSteamInstallPath}</dd>
                </dl>
              )}
              {detailFields('wizard-steam', 'Steam Installation')}
            </>
          )}

          {wizardMode === 'download-select' && (
            <>
              <div className="wizard__intro">
                <h2>Choose a branch</h2>
                <p>SIMM downloads the branch with DepotDownloader into a folder you pick in the next step.</p>
              </div>

              {(depotDownloaderInstalled !== true || depotDownloaderDetectionError) && (
                <div className={`ui-callout ${depotDownloaderDetectionError || depotDownloaderPromptError ? 'ui-callout--danger' : 'ui-callout--warn'} wizard__callout`}>
                  <div className="wizard__callout-copy">
                    <strong>
                      {depotDownloaderDetectionError
                        ? 'SIMM could not check for DepotDownloader'
                        : depotDownloaderInstalled === null
                          ? 'Checking for DepotDownloader…'
                          : installingDepotDownloader
                            ? 'Installing DepotDownloader…'
                            : 'DepotDownloader is needed to download branches'}
                    </strong>
                    <span>
                      {depotDownloaderDetectionError
                        ? depotDownloaderDetectionError
                        : canAutoInstallDepotDownloader
                          ? 'SIMM can install it for you, or you can follow the manual instructions.'
                          : depotDownloaderInstallHint || 'Install it manually, then check again.'}
                    </span>
                    {depotDownloaderPromptError && <span>{depotDownloaderPromptError}</span>}
                  </div>
                  <div className="wizard__callout-actions">
                    <SimmButton type="button" variant="ghost" size="sm" onClick={handleOpenDepotDownloaderInstructions}>
                      Manual Instructions
                    </SimmButton>
                    <SimmButton
                      type="button"
                      variant="secondary"
                      size="sm"
                      onClick={() => {
                        if (depotDownloaderDetectionError) {
                          retryDepotDownloaderDetection();
                          return;
                        }
                        if (!canAutoInstallDepotDownloader) {
                          void refreshDepotDownloaderStatus();
                          return;
                        }
                        void handleAutoInstallDepotDownloader();
                      }}
                      disabled={installingDepotDownloader || (!depotDownloaderDetectionError && depotDownloaderInstalled === null)}
                    >
                      {(installingDepotDownloader || (!depotDownloaderDetectionError && depotDownloaderInstalled === null)) && <Icon name="spinner" spin />}
                      {depotDownloaderDetectionError
                        ? 'Check Again'
                        : depotDownloaderInstalled === null
                          ? 'Checking…'
                          : installingDepotDownloader
                            ? 'Installing…'
                            : canAutoInstallDepotDownloader
                              ? 'Install Automatically'
                              : 'Check Again'}
                    </SimmButton>
                  </div>
                </div>
              )}

              {appConfig ? (
                <RadioGroup
                  className="wizard-options"
                  value={pendingBranchName ?? ''}
                  onValueChange={(value) => setPendingBranchName(String(value))}
                  aria-label="Branch"
                >
                  {appConfig.branches.map((branch) => {
                    const blockReason = branchBlockReason(branch);
                    return (
                      <label
                        key={branch.name}
                        className={`wizard-option${blockReason ? ' wizard-option--disabled' : ''}`}
                        title={blockReason ?? undefined}
                      >
                        <RadioGroupItem value={branch.name} disabled={Boolean(blockReason)} />
                        <span className="wizard-option__text">
                          <strong>{branch.displayName}</strong>
                          <span className="ui-meta">
                            <span className="ui-mono">{branch.name}</span>
                            {blockReason && <span>{blockReason}</span>}
                          </span>
                        </span>
                        <span className={branch.runtime === 'IL2CPP' ? 'ui-tag ui-tag--il2cpp' : 'ui-tag ui-tag--mono'}>
                          {branch.runtime}
                        </span>
                      </label>
                    );
                  })}
                </RadioGroup>
              ) : (
                <div className="wizard-options" role="status" aria-label="Loading branches">
                  {[0, 1, 2].map((index) => (
                    <span key={index} className="loading-skeleton wizard__skeleton-row" aria-hidden="true" />
                  ))}
                </div>
              )}
            </>
          )}

          {wizardMode === 'download-configure' && selectedBranch && (
            <>
              <div className="wizard__intro">
                <h2>Name and location</h2>
                <p>
                  {selectedBranch.displayName} · <span className="ui-mono">{selectedBranch.name}</span> · {selectedBranch.runtime}
                </p>
              </div>
              {detailFields('wizard-download', 'Environment name')}
              <div className="wizard-field">
                <label htmlFor="wizard-download-base-dir">Install folder</label>
                <div className="wizard-field__row">
                  <Input
                    id="wizard-download-base-dir"
                    type="text"
                    className="ui-mono"
                    value={outputDir}
                    onChange={(e) => {
                      setOutputDirIsAutoDerived(false);
                      setOutputDir(e.target.value);
                    }}
                    placeholder="C:\\Games\\Schedule I Beta"
                  />
                  <SimmButton type="button" variant="secondary" onClick={() => void openDirectoryPicker('download')}>
                    Browse
                  </SimmButton>
                </div>
                <p className="wizard-field__hint">The branch is downloaded into exactly this folder.</p>
              </div>
            </>
          )}

          {wizardMode === 'import-configure' && (
            <>
              <div className="wizard__intro">
                <h2>Choose the game folder</h2>
                <p>Pick the folder that contains Schedule I.exe. SIMM detects branch, runtime, and version from the files.</p>
              </div>
              <div className="wizard-field">
                <label htmlFor="wizard-import-path">Game folder</label>
                <div className="wizard-field__row">
                  <Input
                    id="wizard-import-path"
                    type="text"
                    className="ui-mono"
                    value={importPath}
                    onChange={(e) => setImportPath(e.target.value)}
                    placeholder="C:\\Games\\Schedule I"
                  />
                  <SimmButton type="button" variant="secondary" onClick={() => void openDirectoryPicker('import')}>
                    Browse
                  </SimmButton>
                </div>
              </div>
              {detailFields('wizard-import', 'My Game Install')}
            </>
          )}
        </div>
      </div>

      {wizardMode === 'landing' && renderFooter(
        { label: 'Cancel', onClick: onClose },
        {
          label: 'Continue',
          onClick: continueFromLanding,
          disabled: effectiveSource === 'steam' && !steamAvailable,
        },
      )}

      {wizardMode === 'steam-configure' && renderFooter(
        { label: 'Back', onClick: goToLanding },
        {
          label: loading ? 'Adding…' : 'Add Environment',
          onClick: () => void handleCreateSteamEnvironment(selectedSteamInstallPath),
          disabled: loading || !selectedSteamInstallPath,
          busy: loading,
        },
      )}

      {wizardMode === 'download-select' && renderFooter(
        { label: 'Back', onClick: goToLanding },
        {
          label: 'Continue',
          onClick: () => {
            if (pendingBranch && !branchBlockReason(pendingBranch)) handleBranchSelect(pendingBranch);
          },
          disabled: !pendingBranch || Boolean(branchBlockReason(pendingBranch)),
        },
      )}

      {wizardMode === 'download-configure' && selectedBranch && renderFooter(
        { label: 'Back', onClick: () => setWizardMode('download-select') },
        {
          label: loading ? 'Creating…' : 'Create Environment',
          onClick: () => void handleCreate(),
          disabled: loading || !outputDir || gameOperationInProgress,
          busy: loading,
          title: gameOperationInProgress ? `${activeGameDownloadName} is already downloading or updating.` : undefined,
        },
      )}

      {wizardMode === 'import-configure' && renderFooter(
        {
          label: 'Back',
          onClick: () => {
            goToLanding();
            setImportPath('');
          },
        },
        {
          label: importingLocal ? 'Importing…' : 'Import Installation',
          onClick: () => void handleImportLocalEnvironment(),
          disabled: importingLocal || !importPath,
          busy: importingLocal,
        },
      )}

      {showDirectoryPicker && (
        <Dialog open={showDirectoryPicker} onOpenChange={(open) => {
          if (!open) {
            setShowDirectoryPicker(false);
          }
        }}>
          <SimmDialogContent
            nested
            className="app-dialog wizard-directory-dialog"
            showCloseButton={false}
          >
            <DialogHeader className="modal-header app-dialog__header">
              <DialogTitle>{directoryPurpose === 'import' ? 'Select Game Folder' : 'Select Install Folder'}</DialogTitle>
              <SimmButton variant="ghost" size="icon-sm" className="modal-close" onClick={() => setShowDirectoryPicker(false)} aria-label="Close directory picker">
                <Icon name="times" />
              </SimmButton>
            </DialogHeader>

            <div className="app-dialog__body wizard-directory-dialog__body">
              <div className="wizard-field">
                <label htmlFor="wizard-directory-path">Current path</label>
                <div className="wizard-field__row">
                  <Input
                    id="wizard-directory-path"
                    type="text"
                    className="ui-mono"
                    value={directoryPath}
                    onChange={(e) => setDirectoryPath(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        void loadDirectory(directoryPath);
                      }
                    }}
                    placeholder="C:\\Users\\YourName"
                  />
                  <SimmButton type="button" variant="secondary" onClick={() => void loadDirectory(directoryPath)} disabled={browsing}>
                    Go
                  </SimmButton>
                </div>
              </div>

              <div className="wizard-directory-dialog__list" role="list" aria-busy={browsing}>
                {browsing ? (
                  [0, 1, 2, 3].map((index) => (
                    <span key={index} className="loading-skeleton wizard__skeleton-row" aria-hidden="true" />
                  ))
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
                          <Icon name="arrowUp" />
                          <span>Parent folder</span>
                        </SimmButton>
                      </div>
                    )}

                    {directoryList.length === 0 ? (
                      <p className="wizard-directory-dialog__empty">This folder has no subfolders.</p>
                    ) : (
                      directoryList.map((dir) => (
                        <div key={dir.path} role="listitem">
                          <SimmButton
                            type="button"
                            variant="ghost"
                            className="wizard-directory-row h-auto"
                            onClick={() => void loadDirectory(dir.path)}
                          >
                            <Icon name="folder" />
                            <span>{dir.name}</span>
                          </SimmButton>
                        </div>
                      ))
                    )}
                  </>
                )}
              </div>

              <div className="wizard-field">
                <label htmlFor="wizard-new-folder">New folder here</label>
                <div className="wizard-field__row">
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
                    variant="secondary"
                    onClick={() => void handleCreateFolder()}
                    disabled={creatingFolder || !newFolderName.trim() || !directoryPath}
                  >
                    {creatingFolder ? 'Creating…' : 'Create Folder'}
                  </SimmButton>
                </div>
              </div>
            </div>

            <DialogFooter className="app-dialog__footer">
              <div className="app-dialog__actions">
                <SimmButton type="button" variant="secondary" onClick={() => setShowDirectoryPicker(false)}>
                  Cancel
                </SimmButton>
                <SimmButton
                  type="button"
                  onClick={() => handleDirectorySelection(directoryPath)}
                  disabled={browsing || !directoryPath}
                >
                  Select Folder
                </SimmButton>
              </div>
            </DialogFooter>
          </SimmDialogContent>
        </Dialog>
      )}
    </section>
  );
}
