import { Fragment, useEffect, useMemo, useState } from 'react';

import { ApiService } from '../services/api';
import type { ExperienceMode, SecurityScannerStatus } from '../types';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Icon } from './Icon';
import { GameArt } from './media/GameArt';
import { SimmButton } from './primitives';

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

const storageRows = [
  { title: 'Downloads', body: 'Game payloads and shared mod files, staged before they are applied.' },
  { title: 'Backups', body: 'Recovery snapshots, so environment changes stay reversible.' },
  { title: 'Logs', body: 'App and troubleshooting logs for support and diagnostics.' },
] as const;

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
  const [steamAppId, setSteamAppId] = useState<string | null>(null);
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
          setSteamAppId(installs[0]?.appId ?? null);
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
      <section className="wizard welcome" aria-label="Setup guide prompt">
        <header className="ui-page-header wizard__header">
          <div className="ui-page-header__titles">
            <h1 className="ui-page-title">Setup Guide</h1>
            <p className="ui-page-subtitle">Optional. You can reopen it from Settings at any time.</p>
          </div>
        </header>

        <div className="wizard__body">
          <div className="wizard__content">
            {error && (
              <div className="ui-callout ui-callout--danger" role="alert">
                <span>{error}</span>
              </div>
            )}
            <div className="wizard__intro">
              <h2>Make SIMM easier to use</h2>
              <p>
                Three short steps: choose a Player or Power User layout, point SIMM at your game, and confirm the
                safety defaults. Your current layout and advanced tools stay as they are unless you change them.
              </p>
            </div>
          </div>
        </div>

        <footer className="wizard__footer">
          <SimmButton type="button" variant="secondary" onClick={() => void handleSkip()} disabled={saving}>
            {saving && <Icon name="spinner" spin />}
            {saving ? 'Saving…' : 'Keep Current Layout'}
          </SimmButton>
          <SimmButton type="button" onClick={() => setSetupStarted(true)}>
            Try Setup Guide
          </SimmButton>
        </footer>
      </section>
    );
  }

  const stepLabels = ['Layout', 'Game', 'Safety'];
  const scannerBusy = installingSecurityScanner || loadingSecurityScannerStatus;
  const scannerTone = scannerBusy
    ? 'info'
    : securityScannerStatus?.installed
      ? 'ok'
      : securityScannerError
        ? 'danger'
        : 'muted';

  return (
    <section className="wizard welcome" aria-label="Setup guide">
      <header className="ui-page-header wizard__header">
        <div className="ui-page-header__titles">
          <h1 className="ui-page-title">Setup Guide</h1>
          <p className="ui-page-subtitle">Choose how SIMM looks and confirm where it keeps its files.</p>
        </div>
        <ol className="wizard-steps" aria-label="Steps">
          {stepLabels.map((label, index) => (
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

          {step === 'mode' && (
            <>
              <div className="wizard__intro">
                <h2>Choose the layout that fits you</h2>
                <p>Power User adds separate Steam branch installs to Add Environment. Everything else is the same in both, and you can switch later in Settings.</p>
              </div>
              <RadioGroup
                className="wizard-options"
                value={experienceMode}
                onValueChange={(value) => chooseExperienceMode(value as ExperienceMode)}
                aria-label="Layout"
              >
                <label className="wizard-option">
                  <RadioGroupItem value="player" />
                  <span className="wizard-option__text">
                    <strong>Player</strong>
                    <span>Everyday mod management: the Mod Library, updates, and the game installs you already have.</span>
                  </span>
                  {initialExperienceMode === 'player' && <span className="ui-tag ui-tag--ok">Recommended</span>}
                </label>
                <label className="wizard-option">
                  <RadioGroupItem value="powerUser" />
                  <span className="wizard-option__text">
                    <strong>Power User</strong>
                    <span>Branch and tooling workflows: separate Steam branch installs and lower-level setup tools in Add Environment.</span>
                  </span>
                  {initialExperienceMode === 'powerUser' && <span className="ui-tag">Current</span>}
                </label>
              </RadioGroup>
            </>
          )}

          {step === 'game' && (
            <>
              <div className="welcome__game">
                {!detectingSteam && steamAppId && steamInstallCount && steamInstallCount > 0 ? (
                  <GameArt appId={steamAppId} className="welcome__game-art" />
                ) : null}
                <div className="wizard__intro">
                  <h2>Point SIMM at your game</h2>
                  <p>
                    {detectingSteam
                      ? 'Looking for Schedule I in Steam…'
                      : steamInstallCount && steamInstallCount > 0
                        ? 'Steam install found. Add Environment can link it; Steam keeps handling game updates, so no Steam sign-in is needed.'
                        : 'No Steam install found yet. Add Environment can also import an existing game folder.'}
                  </p>
                </div>
              </div>

              <section className="welcome__section" aria-labelledby="welcome-after-setup">
                <h3 id="welcome-after-setup" className="ui-section-title">After setup</h3>
                <RadioGroup
                  className="wizard-options"
                  value={finishAction}
                  onValueChange={(value) => setFinishAction(value as FinishAction)}
                  aria-labelledby="welcome-after-setup"
                >
                  <label className="wizard-option">
                    <RadioGroupItem value="none" />
                    <span className="wizard-option__text">
                      <strong>Go to Home</strong>
                    </span>
                  </label>
                  <label className="wizard-option">
                    <RadioGroupItem value="addGame" />
                    <span className="wizard-option__text">
                      <strong>Open Add Environment</strong>
                    </span>
                  </label>
                  {experienceMode === 'powerUser' && (
                    <label className="wizard-option">
                      <RadioGroupItem value="accounts" />
                      <span className="wizard-option__text">
                        <strong>Open Accounts</strong>
                        <span>Sign in to Steam to download separate branches.</span>
                      </span>
                    </label>
                  )}
                </RadioGroup>
              </section>

              <section className="welcome__section" aria-labelledby="welcome-simm-folder">
                <h3 id="welcome-simm-folder" className="ui-section-title">SIMM folder</h3>
                <div className="welcome__folder">
                  <span className="ui-mono welcome__path">{simmPath}</span>
                  <SimmButton type="button" variant="secondary" size="sm" onClick={() => void handleOpenSimmFolder()} disabled={!canOpenSimmFolder}>
                    Open SIMM Folder
                  </SimmButton>
                </div>
                <p className="wizard-field__hint">
                  {homePathLookupFailed
                    ? 'Folder lookup is unavailable right now, but SIMM still created the workspace.'
                    : 'Downloads, backups, and logs live here, outside the game folder.'}
                </p>
              </section>
            </>
          )}

          {step === 'safety' && (
            <>
              <div className="wizard__intro">
                <h2>Keep installs safer by default</h2>
                <p>SIMM scans downloaded mods and keeps high-risk prompts on. You can adjust this in Settings.</p>
              </div>

              <ul className="welcome__checklist">
                <li className="welcome__check">
                  <span className={`ui-status ui-status--${scannerTone}`} aria-hidden="true" />
                  <div className="welcome__check-copy">
                    <strong>
                      {installingSecurityScanner || loadingSecurityScannerStatus
                        ? 'Preparing MLVScan'
                        : securityScannerStatus?.installed
                          ? 'MLVScan ready'
                          : securityScannerError
                            ? 'MLVScan needs attention'
                            : 'Scan mod files'}
                    </strong>
                    <span>
                      {installingSecurityScanner
                        ? 'Installing the security scanner so downloads can be checked after setup.'
                        : loadingSecurityScannerStatus
                          ? 'Checking whether the security scanner is already available.'
                          : securityScannerStatus?.installed
                            ? `Security scanning is ready${securityScannerStatus.installedVersion ? ` with ${securityScannerStatus.installedVersion}` : ''}.`
                            : securityScannerError
                              ? 'Automatic setup did not finish. Retry here, or repair MLVScan later from Settings.'
                              : 'SIMM keeps critical scan blocking and high-risk prompts enabled by default.'}
                    </span>
                    {(securityScannerError || securityScannerStatus?.lastError) && (
                      <span className="welcome__check-error">{securityScannerError || securityScannerStatus?.lastError}</span>
                    )}
                  </div>
                  {(securityScannerError || securityScannerStatus?.installed !== true) && (
                    <SimmButton
                      type="button"
                      variant="secondary"
                      size="sm"
                      onClick={() => void handleInstallSecurityScanner()}
                      disabled={scannerBusy}
                    >
                      {scannerBusy && <Icon name="spinner" spin />}
                      {installingSecurityScanner
                        ? 'Installing…'
                        : loadingSecurityScannerStatus
                          ? 'Checking…'
                          : securityScannerError
                            ? 'Retry Install'
                            : 'Install MLVScan'}
                    </SimmButton>
                  )}
                </li>
                <li className="welcome__check">
                  <span className="ui-status ui-status--muted" aria-hidden="true" />
                  <div className="welcome__check-copy">
                    <strong>Connect Nexus Mods when needed</strong>
                    <span>Sign in from Accounts when you install or update Nexus-hosted mods.</span>
                  </div>
                </li>
                {experienceMode === 'powerUser' && (
                  <li className="welcome__check">
                    <span className="ui-status ui-status--muted" aria-hidden="true" />
                    <div className="welcome__check-copy">
                      <strong>Authenticate with Steam for advanced installs</strong>
                      <span>Only separate branch installs ask you to sign in. Your regular Steam install stays updated by Steam.</span>
                    </div>
                  </li>
                )}
              </ul>

              <section className="welcome__section" aria-labelledby="welcome-storage">
                <h3 id="welcome-storage" className="ui-section-title">What SIMM stores</h3>
                <dl className="ui-kv">
                  {storageRows.map((row) => (
                    <Fragment key={row.title}>
                      <dt>{row.title}</dt>
                      <dd>{row.body}</dd>
                    </Fragment>
                  ))}
                </dl>
              </section>
            </>
          )}
        </div>
      </div>

      <footer className="wizard__footer">
        <div className="welcome__footer-start">
          {currentStepIndex > 0 && (
            <SimmButton type="button" variant="secondary" onClick={goBack} disabled={saving}>
              Back
            </SimmButton>
          )}
          <SimmButton type="button" variant="ghost" onClick={onOpenSettings}>
            Settings
          </SimmButton>
        </div>
        {step !== 'safety' ? (
          <SimmButton type="button" onClick={goNext}>
            Continue
          </SimmButton>
        ) : (
          <SimmButton
            type="button"
            onClick={() => void handleFinish()}
            disabled={saving || scannerBusy}
          >
            {(saving || scannerBusy) && <Icon name="spinner" spin />}
            {saving
              ? 'Saving…'
              : installingSecurityScanner
                ? 'Installing MLVScan…'
                : loadingSecurityScannerStatus
                  ? 'Checking MLVScan…'
                  : 'Finish Setup'}
          </SimmButton>
        )}
      </footer>
    </section>
  );
}
