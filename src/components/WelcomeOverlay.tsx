import { useEffect, useMemo, useState } from 'react';

import { ApiService } from '../services/api';
import type { ExperienceMode, SecurityScannerStatus } from '../types';
import { Icon } from './Icon';
import type { IconName } from './icons';
import { WorkspacePageHeader } from './WorkspacePageHeader';

type WelcomeMode = 'setup' | 'upgradePrompt';
type SetupStep = 'mode' | 'game' | 'safety';
type FinishAction = 'none' | 'addGame' | 'accounts';

interface WelcomeOverlayProps {
  isOpen: boolean;
  onClose: () => void;
  onOpenWizard: () => void;
  onOpenSettings: () => void;
  onOpenAccounts?: () => void;
  mode?: WelcomeMode;
  initialExperienceMode?: ExperienceMode;
  onFinishSetup?: (mode: ExperienceMode) => Promise<void> | void;
  onSkipSetup?: () => Promise<void> | void;
}

const setupSteps: SetupStep[] = ['mode', 'game', 'safety'];

const storageCards = [
  {
    icon: 'download',
    title: 'Downloads',
    body: 'Temporary game payloads and shared mod assets are staged here before they are applied.',
  },
  {
    icon: 'boxArchive',
    title: 'Backups',
    body: 'Recovery snapshots and support files stay here so environment changes remain reversible.',
  },
  {
    icon: 'fileLines',
    title: 'Logs',
    body: 'Application and troubleshooting logs live here for support, diagnostics, and export workflows.',
  },
] as const satisfies ReadonlyArray<{ icon: IconName; title: string; body: string }>;

export function WelcomeOverlay({
  isOpen,
  onClose,
  onOpenWizard,
  onOpenSettings,
  onOpenAccounts,
  mode = 'setup',
  initialExperienceMode = 'player',
  onFinishSetup,
  onSkipSetup,
}: WelcomeOverlayProps) {
  const [homePath, setHomePath] = useState<string | null>(null);
  const [homePathLookupFailed, setHomePathLookupFailed] = useState(false);
  const [step, setStep] = useState<SetupStep>('mode');
  const [setupStarted, setSetupStarted] = useState(mode === 'setup');
  const [experienceMode, setExperienceMode] = useState<ExperienceMode>(initialExperienceMode);
  const [finishAction, setFinishAction] = useState<FinishAction>('none');
  const [steamInstallCount, setSteamInstallCount] = useState<number | null>(null);
  const [detectingSteam, setDetectingSteam] = useState(false);
  const [securityScannerStatus, setSecurityScannerStatus] = useState<SecurityScannerStatus | null>(null);
  const [loadingSecurityScannerStatus, setLoadingSecurityScannerStatus] = useState(false);
  const [installingSecurityScanner, setInstallingSecurityScanner] = useState(false);
  const [securityScannerError, setSecurityScannerError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setSetupStarted(mode === 'setup');
    setStep('mode');
    setExperienceMode(initialExperienceMode);
    setFinishAction(initialExperienceMode === 'powerUser' ? 'accounts' : 'none');
    setSecurityScannerStatus(null);
    setSecurityScannerError(null);
    setError(null);
  }, [initialExperienceMode, mode, isOpen]);

  useEffect(() => {
    if (!isOpen) return;

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
      }
    };

    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [isOpen, onClose]);

  useEffect(() => {
    if (!isOpen) return;

    let cancelled = false;

    void ApiService.getHomeDirectory()
      .then((path) => {
        if (cancelled) return;
        setHomePath(path);
        setHomePathLookupFailed(false);
      })
      .catch(() => {
        if (cancelled) return;
        setHomePath(null);
        setHomePathLookupFailed(true);
      });

    return () => {
      cancelled = true;
    };
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen || !setupStarted || step !== 'game') return;

    let cancelled = false;
    setDetectingSteam(true);
    void ApiService.detectSteamInstallations()
      .then((installs) => {
        if (!cancelled) {
          setSteamInstallCount(installs.length);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setSteamInstallCount(0);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setDetectingSteam(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [isOpen, setupStarted, step]);

  useEffect(() => {
    if (!isOpen || !setupStarted || step !== 'safety') return;

    let cancelled = false;

    const ensureSecurityScanner = async () => {
      setLoadingSecurityScannerStatus(true);
      setSecurityScannerError(null);

      try {
        const currentStatus = await ApiService.getSecurityScannerStatus();
        if (cancelled) return;

        if (currentStatus.installed) {
          setSecurityScannerStatus(currentStatus);
          return;
        }

        setSecurityScannerStatus(currentStatus);
        setInstallingSecurityScanner(true);
        const installedStatus = await ApiService.installSecurityScanner();
        if (cancelled) return;
        setSecurityScannerStatus(installedStatus);
      } catch (scannerError) {
        if (cancelled) return;
        setSecurityScannerError(
          scannerError instanceof Error
            ? scannerError.message
            : 'SIMM could not install MLVScan automatically right now.'
        );
      } finally {
        if (!cancelled) {
          setLoadingSecurityScannerStatus(false);
          setInstallingSecurityScanner(false);
        }
      }
    };

    void ensureSecurityScanner();

    return () => {
      cancelled = true;
    };
  }, [isOpen, setupStarted, step]);

  const simmPath = useMemo(() => {
    if (!homePath) {
      return 'your home directory\\SIMM';
    }

    return `${homePath.replace(/[\\/]*$/, '\\')}SIMM`;
  }, [homePath]);

  const currentStepIndex = setupSteps.indexOf(step);
  const canOpenSimmFolder = Boolean(homePath);
  const nextActionLabel =
    finishAction === 'addGame'
      ? 'Open Add Game'
      : finishAction === 'accounts'
        ? 'Open Accounts'
        : 'Go to Home';

  const chooseExperienceMode = (selectedMode: ExperienceMode) => {
    setExperienceMode(selectedMode);
    if (selectedMode === 'powerUser' && finishAction === 'none') {
      setFinishAction('accounts');
    } else if (selectedMode === 'player' && finishAction === 'accounts') {
      setFinishAction('none');
    }
  };

  const handleOpenSimmFolder = async () => {
    if (!canOpenSimmFolder) {
      return;
    }

    try {
      await ApiService.openPath(simmPath);
    } catch (openError) {
      console.error('Failed to open SIMM folder:', openError);
    }
  };

  const handleInstallSecurityScanner = async () => {
    setInstallingSecurityScanner(true);
    setSecurityScannerError(null);

    try {
      const scannerStatus = await ApiService.installSecurityScanner();
      setSecurityScannerStatus(scannerStatus);
    } catch (scannerError) {
      setSecurityScannerError(
        scannerError instanceof Error
          ? scannerError.message
          : 'SIMM could not install MLVScan automatically right now.'
      );
    } finally {
      setInstallingSecurityScanner(false);
    }
  };

  const handleSkip = async () => {
    setSaving(true);
    setError(null);
    try {
      await onSkipSetup?.();
      onClose();
    } catch (skipError) {
      setError(skipError instanceof Error ? skipError.message : 'Failed to save setup preference');
    } finally {
      setSaving(false);
    }
  };

  const handleFinish = async () => {
    setSaving(true);
    setError(null);
    try {
      await onFinishSetup?.(experienceMode);
      if (finishAction === 'addGame') {
        onOpenWizard();
      } else if (finishAction === 'accounts') {
        onOpenAccounts?.();
      } else {
        onClose();
      }
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Failed to save setup preferences');
    } finally {
      setSaving(false);
    }
  };

  const goNext = () => {
    const nextStep = setupSteps[currentStepIndex + 1];
    if (nextStep) {
      setStep(nextStep);
    }
  };

  const goBack = () => {
    const previousStep = setupSteps[currentStepIndex - 1];
    if (previousStep) {
      setStep(previousStep);
    }
  };

  if (!isOpen) return null;

  if (!setupStarted) {
    return (
      <section className="modal-content workspace-panel welcome-panel" aria-label="Setup guide prompt">
        <WorkspacePageHeader
          eyebrow="Workspace"
          title="Setup Guide"
          description="Choose the default experience mode and confirm the setup path for this install."
        />

        {error && <div className="settings-error-banner">{error}</div>}

        <div className="welcome-panel__body">
          <div className="welcome-panel__overview">
            <div className="welcome-panel__header">
              <span className="welcome-panel__eyebrow">Optional Setup</span>
              <h3>Make SIMM easier to use</h3>
              <p>
                Choose a Player or Power User layout. Your current tools stay available, and this guide can be
                opened again from Settings.
              </p>
            </div>
            <div className="welcome-panel__stats">
              <article className="welcome-panel__stat-card">
                <span>Current Layout</span>
                <strong>Kept unless changed</strong>
              </article>
              <article className="welcome-panel__stat-card">
                <span>Advanced Tools</span>
                <strong>Still available</strong>
              </article>
            </div>
          </div>

          <section className="welcome-panel__content-card">
            <div className="welcome-panel__section-header">
              <span className="welcome-panel__eyebrow">Recommended</span>
              <h4>Player mode keeps the everyday workflow up front.</h4>
            </div>
            <p>
              Add Game starts with your detected Steam install. Import is there if detection misses it, and Power User
              mode keeps separate branch installs visible when you need them.
            </p>
            <div className="welcome-panel__actions">
              <button type="button" className="btn btn-primary" onClick={() => setSetupStarted(true)}>
                <Icon name="sliders" />
                Try Setup Guide
              </button>
              <button type="button" className="btn btn-secondary" onClick={() => void handleSkip()} disabled={saving}>
                <Icon name={saving ? 'spinner' : 'checkCircle'} />
                {saving ? 'Saving...' : 'Keep Current Layout'}
              </button>
            </div>
          </section>
        </div>
      </section>
    );
  }

  return (
    <section className="modal-content workspace-panel welcome-panel" aria-label="Setup guide">
      <WorkspacePageHeader
        eyebrow={`Step ${currentStepIndex + 1} of ${setupSteps.length}`}
        title="Setup Guide"
        description="Choose the default experience mode and confirm the setup path for this install."
      />

      {error && <div className="settings-error-banner">{error}</div>}

      <div className="welcome-panel__body">
        <div className="welcome-panel__overview">
          <div className="welcome-panel__header">
            <span className="welcome-panel__eyebrow">Step {currentStepIndex + 1} of {setupSteps.length}</span>
            <h3>
              {step === 'mode'
                ? 'Choose the layout that fits you'
                : step === 'game'
                  ? 'Point SIMM at your game'
                  : 'Keep installs safer by default'}
            </h3>
            <p>
              {step === 'mode'
                ? 'Player mode keeps the normal mod manager flow clear. Power User mode keeps separate Steam branch installs visible.'
                : step === 'game'
                  ? 'SIMM looks for the Steam install you already use. Open Add Game after setup only if you need to link or import it.'
                  : 'SIMM prepares MLVScan automatically here, then keeps scan behavior adjustable from Settings.'}
            </p>
          </div>
          <div className="welcome-panel__stats">
            <article className="welcome-panel__stat-card">
              <span>SIMM Home</span>
              <strong title={simmPath}>{simmPath}</strong>
            </article>
            <article className="welcome-panel__stat-card">
              <span>Selected Mode</span>
              <strong>{experienceMode === 'player' ? 'Player' : 'Power User'}</strong>
            </article>
            <article className="welcome-panel__stat-card">
              <span>Next Action</span>
              <strong>{nextActionLabel}</strong>
            </article>
          </div>
        </div>

        {step === 'mode' && (
          <div className="wizard-entry-grid" aria-label="App mode choices">
            <button
              type="button"
              className={`wizard-entry-card ${experienceMode === 'player' ? 'wizard-entry-card--selected' : ''}`}
              onClick={() => chooseExperienceMode('player')}
              aria-pressed={experienceMode === 'player'}
            >
              <div className="wizard-entry-card__icon wizard-entry-card__icon--success">
                <Icon name="gamepad" />
              </div>
              <div className="wizard-entry-card__content">
                <span className="settings-eyebrow">Player</span>
                <h3>Everyday mod management</h3>
                <p>Use the mod library, updates, accounts, and existing game installs without advanced install noise.</p>
              </div>
              <span className="wizard-inline-action">Recommended</span>
            </button>

            <button
              type="button"
              className={`wizard-entry-card ${experienceMode === 'powerUser' ? 'wizard-entry-card--selected' : ''}`}
              onClick={() => chooseExperienceMode('powerUser')}
              aria-pressed={experienceMode === 'powerUser'}
            >
              <div className="wizard-entry-card__icon">
                <Icon name="wrench" />
              </div>
              <div className="wizard-entry-card__content">
                <span className="settings-eyebrow">Power User</span>
                <h3>Branch and tooling workflows</h3>
                <p>Keep separate Steam branch installs and lower-level setup tools visible inside Add Game.</p>
              </div>
              <span className="wizard-inline-action">Full controls</span>
            </button>
          </div>
        )}

        {step === 'game' && (
          <div className="welcome-panel__layout">
            <section className="welcome-panel__content-card">
              <div className="welcome-panel__section-header">
                <span className="welcome-panel__eyebrow">Game Install</span>
                <h4>
                  {detectingSteam
                    ? 'Looking for Schedule I in Steam'
                    : steamInstallCount && steamInstallCount > 0
                      ? 'Steam install detected'
                      : 'Add your game when you are ready'}
                </h4>
              </div>
              <p>
                {steamInstallCount && steamInstallCount > 0
                  ? 'Add Game can link the detected Steam install after this guide finishes. Steam keeps handling game updates, so no Steam sign-in is needed in SIMM for that install.'
                  : 'If automatic detection does not find Steam, Add Game can still import the existing folder.'}
              </p>
              <div className="welcome-panel__actions">
                <button
                  type="button"
                  className={finishAction === 'addGame' ? 'btn btn-primary' : 'btn btn-secondary'}
                  onClick={() => setFinishAction('addGame')}
                >
                  <Icon name="folderPlus" />
                  Open Add Game After Setup
                </button>
                <button
                  type="button"
                  className={finishAction === 'none' ? 'btn btn-primary' : 'btn btn-secondary'}
                  onClick={() => setFinishAction('none')}
                >
                  <Icon name="house" />
                  Go to Home First
                </button>
                {experienceMode === 'powerUser' && (
                  <button
                    type="button"
                    className={finishAction === 'accounts' ? 'btn btn-primary' : 'btn btn-secondary'}
                    onClick={() => setFinishAction('accounts')}
                  >
                    <Icon name="userCircle" />
                    Open Accounts After Setup
                  </button>
                )}
              </div>
            </section>

            <aside className="welcome-panel__secondary">
              <section className="welcome-panel__content-card welcome-panel__content-card--quiet">
                <div className="welcome-panel__section-header">
                  <span className="welcome-panel__eyebrow">SIMM Folder</span>
                  <h4>Managed files stay outside the game directory.</h4>
                </div>
                <div className="welcome-panel__path-card">
                  <div className="welcome-panel__path-value">{simmPath}</div>
                  <p>Downloads, backups, logs, and app support files live here.</p>
                </div>
                <div className="welcome-panel__inline-actions">
                  <button type="button" className="btn btn-secondary" onClick={() => void handleOpenSimmFolder()} disabled={!canOpenSimmFolder}>
                    <Icon name="folderOpen" />
                    Open SIMM Folder
                  </button>
                  {homePathLookupFailed && (
                    <span className="welcome-panel__inline-note">
                      Folder lookup is unavailable right now, but SIMM still created the workspace.
                    </span>
                  )}
                </div>
              </section>
            </aside>
          </div>
        )}

        {step === 'safety' && (
          <div className="welcome-panel__layout">
            <section className="welcome-panel__content-card">
              <div className="welcome-panel__section-header">
                <span className="welcome-panel__eyebrow">Safe Defaults</span>
                <h4>Security checks stay on.</h4>
              </div>
              <div className="welcome-panel__storage-grid">
                <article className="welcome-panel__storage-card">
                  <div className="welcome-panel__storage-icon">
                    <Icon name="shieldHalved" />
                  </div>
                  <div>
                    <h5>
                      {installingSecurityScanner || loadingSecurityScannerStatus
                        ? 'Preparing MLVScan'
                        : securityScannerStatus?.installed
                          ? 'MLVScan ready'
                          : securityScannerError
                            ? 'MLVScan needs attention'
                            : 'Scan mod files'}
                    </h5>
                    <p>
                      {installingSecurityScanner
                        ? 'SIMM is installing the security scanner now so downloads can be checked after setup.'
                        : loadingSecurityScannerStatus
                          ? 'SIMM is checking whether the security scanner is already available.'
                          : securityScannerStatus?.installed
                            ? `Security scanning is ready${securityScannerStatus.installedVersion ? ` with ${securityScannerStatus.installedVersion}` : ''}.`
                            : securityScannerError
                              ? 'Automatic setup did not finish. Retry here, or repair MLVScan later from Settings.'
                              : 'SIMM keeps critical scan blocking and high-risk prompts enabled by default.'}
                    </p>
                    {securityScannerError && <div className="settings-error-banner">{securityScannerError}</div>}
                    {securityScannerStatus?.lastError && <div className="settings-error-banner">{securityScannerStatus.lastError}</div>}
                    {(securityScannerError || securityScannerStatus?.installed !== true) && (
                      <div className="welcome-panel__inline-actions">
                        <button
                          type="button"
                          className="btn btn-secondary"
                          onClick={() => void handleInstallSecurityScanner()}
                          disabled={installingSecurityScanner || loadingSecurityScannerStatus}
                        >
                          <Icon name={installingSecurityScanner || loadingSecurityScannerStatus ? 'spinner' : 'shieldHalved'} />
                          {installingSecurityScanner
                            ? 'Installing...'
                            : loadingSecurityScannerStatus
                              ? 'Checking...'
                              : securityScannerError
                                ? 'Retry MLVScan Install'
                                : 'Install MLVScan Now'}
                        </button>
                      </div>
                    )}
                  </div>
                </article>
                <article className="welcome-panel__storage-card">
                  <div className="welcome-panel__storage-icon">
                    <Icon name="userCircle" />
                  </div>
                  <div>
                    <h5>Connect Nexus when needed</h5>
                    <p>Accounts can be connected later when you install or update Nexus-hosted mods.</p>
                  </div>
                </article>
                {experienceMode === 'powerUser' && (
                  <article className="welcome-panel__storage-card">
                    <div className="welcome-panel__storage-icon">
                      <Icon name="steam" />
                    </div>
                    <div>
                      <h5>Authenticate with Steam for advanced installs</h5>
                      <p>Only separate SIMM-managed branch installs may ask you to authorize SIMM. Your regular Steam install stays updated by Steam.</p>
                      <div className="welcome-panel__inline-actions">
                        <button
                          type="button"
                          className={finishAction === 'accounts' ? 'btn btn-primary' : 'btn btn-secondary'}
                          onClick={() => setFinishAction('accounts')}
                        >
                          <Icon name="userCircle" />
                          Open Accounts After Setup
                        </button>
                      </div>
                    </div>
                  </article>
                )}
              </div>
            </section>

            <aside className="welcome-panel__secondary">
              <section className="welcome-panel__content-card welcome-panel__content-card--quiet">
                <div className="welcome-panel__section-header">
                  <span className="welcome-panel__eyebrow">Workspace Files</span>
                  <h4>What SIMM stores</h4>
                </div>
                <div className="welcome-panel__storage-grid">
                  {storageCards.map((card) => (
                    <article key={card.title} className="welcome-panel__storage-card">
                      <div className="welcome-panel__storage-icon">
                        <Icon name={card.icon} />
                      </div>
                      <div>
                        <h5>{card.title}</h5>
                        <p>{card.body}</p>
                      </div>
                    </article>
                  ))}
                </div>
              </section>
            </aside>
          </div>
        )}
      </div>

      <div className="welcome-panel__footer">
        {currentStepIndex > 0 && (
          <button type="button" className="btn btn-secondary" onClick={goBack} disabled={saving}>
            Back
          </button>
        )}
        {step !== 'safety' ? (
          <button type="button" className="btn btn-primary" onClick={goNext}>
            Continue
          </button>
        ) : (
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => void handleFinish()}
            disabled={saving || installingSecurityScanner || loadingSecurityScannerStatus}
          >
            <Icon name={saving || installingSecurityScanner || loadingSecurityScannerStatus ? 'spinner' : 'checkCircle'} />
            {saving
              ? 'Saving...'
              : installingSecurityScanner
                ? 'Installing MLVScan...'
                : loadingSecurityScannerStatus
                  ? 'Checking MLVScan...'
                  : 'Finish Setup'}
          </button>
        )}
        <button type="button" className="btn btn-secondary" onClick={onOpenSettings}>
          <Icon name="sliders" />
          Settings
        </button>
      </div>
    </section>
  );
}
