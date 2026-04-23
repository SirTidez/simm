import { useEffect } from 'react';
import { Icon } from './Icon';
import type { IconName } from './icons';

interface HelpOverlayProps {
  isOpen: boolean;
  onClose: () => void;
  onOpenWizard: () => void;
  onOpenSettings: () => void;
  onOpenAccounts: () => void;
}

const quickStartSteps = [
  {
    icon: 'plusCircle',
    title: 'Add a game',
    body: 'Use Add Game to link your Steam install, import an existing folder, or open Power User branch downloads.',
  },
  {
    icon: 'userCircle',
    title: 'Authenticate when needed',
    body: 'Reconnect Steam for protected branch downloads and link Nexus when you want manager download support.',
  },
  {
    icon: 'download',
    title: 'Download and maintain',
    body: 'Track updates, install mods, and manage support tools from each environment workspace.',
  },
] as const satisfies ReadonlyArray<{ icon: IconName; title: string; body: string }>;

const primaryHelpCards = [
  {
    icon: 'hardDrive',
    title: 'Manage Game Installs',
    copy: 'Use install actions from the Home workspace to keep each environment healthy and easy to launch.',
    items: [
      'Import existing game folders or use Power User branch downloads when enabled.',
      'Run Check Updates when you want an immediate refresh.',
      'Use Update to apply the newest available branch build.',
      'Launch Game and Open Folder for quick verification and support work.',
      'Delete only removes the SIMM entry. Files remain on disk.',
    ],
  },
  {
    icon: 'userGear',
    title: 'Settings and Accounts',
    copy: 'Use the utility panes for environment defaults, tools, update cadence, and linked service access.',
    items: [
      'Settings controls download paths, theme, cache size, update checks, and logging.',
      'Accounts keeps Steam and Nexus links current and shows what each service can do.',
      'Credentials and tokens are stored locally and encrypted.',
    ],
  },
  {
    icon: 'boxesStacked',
    title: 'Mods, Plugins, and UserLibs',
    copy: 'SIMM separates global acquisition from per-environment management so you can browse once and manage locally.',
    items: [
      'Mod Library is the global place to discover, download, and update shared mod assets.',
      'Mods is the environment-specific place to enable, disable, update, and inspect installed mods.',
      'Plugins and UserLibs expose the files found in those runtime folders.',
    ],
  },
  {
    icon: 'triangleExclamation',
    title: 'Troubleshooting',
    copy: 'Start with the most common causes before assuming the install itself is broken.',
    items: [
      'Download failures usually point to Steam auth or network issues.',
      'Launch failures usually mean the executable path or loader setup needs review.',
      'If DepotDownloader is missing, repair prerequisites or install it manually with winget.',
      'Use Logs and Settings together when you need deeper diagnostics.',
    ],
  },
] as const satisfies ReadonlyArray<{ icon: IconName; title: string; copy: string; items: readonly string[] }>;

const referenceCards = [
  {
    icon: 'penToSquare',
    title: 'Edit Install Details',
    items: [
      'Rename installs when you want clearer environment labels.',
      'Add descriptions to keep test builds and stable builds easy to distinguish.',
    ],
  },
  {
    icon: 'rotate',
    title: 'Update Checks',
    items: [
      'Automatic checks run on the interval configured in Settings.',
      'Manual checks bypass the wait and refresh status immediately.',
      'Update badges show when a newer version is available.',
    ],
  },
  {
    icon: 'puzzlePiece',
    title: 'MelonLoader',
    items: [
      'Preferred MelonLoader versions are managed from Settings.',
      'SIMM keeps version handling aligned with the target runtime when possible.',
      'Per-install loader state is tracked with the environment.',
    ],
  },
] as const satisfies ReadonlyArray<{ icon: IconName; title: string; items: readonly string[] }>;

const quickActions = [
  {
    icon: 'plusCircle',
    title: 'Add Game',
    body: 'Link a Steam install, import an existing folder, or open advanced branch downloads.',
    action: 'wizard' as const,
  },
  {
    icon: 'userGear',
    title: 'Open Accounts',
    body: 'Reconnect Steam or Nexus when protected downloads or manager support need attention.',
    action: 'accounts' as const,
  },
  {
    icon: 'sliders',
    title: 'Open Settings',
    body: 'Adjust paths, update cadence, theme, tools, and logging behavior.',
    action: 'settings' as const,
  },
] as const satisfies ReadonlyArray<{ icon: IconName; title: string; body: string; action: 'wizard' | 'accounts' | 'settings' }>;

export function HelpOverlay({ isOpen, onClose, onOpenWizard, onOpenSettings, onOpenAccounts }: HelpOverlayProps) {
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

  if (!isOpen) return null;

  return (
    <section className="modal-content help-overlay workspace-panel" aria-label="Help panel">
      <div className="modal-header">
        <h2>Help Center</h2>
      </div>

      <div className="help-pane">
        <div className="help-overview">
          <div className="help-overview__copy">
            <span className="help-eyebrow">Operator Guide</span>
            <h3>Use SIMM as a desktop workspace for installs, updates, mods, accounts, and support tools.</h3>
            <p>Start with environment creation, then move into account access, updates, mod management, and diagnostics as your install matures.</p>
          </div>
          <div className="help-overview__stats">
            <div className="help-stat-card">
              <span>Quick start</span>
              <strong>3 core steps</strong>
            </div>
            <div className="help-stat-card">
              <span>Primary areas</span>
              <strong>Installs, accounts, mods</strong>
            </div>
            <div className="help-stat-card">
              <span>Support focus</span>
              <strong>Auth, updates, logs</strong>
            </div>
          </div>
        </div>

        <section className="help-action-strip">
          <div className="help-section-group__header">
            <span className="help-eyebrow">Next Actions</span>
            <h3>Jump directly to the workspace you need most often.</h3>
          </div>

          <div className="help-action-grid">
            {quickActions.map((actionCard) => {
              const handleClick = actionCard.action === 'wizard'
                ? onOpenWizard
                : actionCard.action === 'accounts'
                  ? onOpenAccounts
                  : onOpenSettings;

              return (
                <button
                  key={actionCard.title}
                  type="button"
                  className="help-action-card"
                  onClick={handleClick}
                >
                  <div className="help-card-header__icon">
                    <Icon name={actionCard.icon} />
                  </div>
                  <div className="help-action-card__content">
                    <h4>{actionCard.title}</h4>
                    <p>{actionCard.body}</p>
                  </div>
                  <Icon name="arrowRight" className="help-action-card__chevron" />
                </button>
              );
            })}
          </div>
        </section>

        <div className="help-layout">
          <div className="help-layout__primary">
            <section className="help-hero-card">
              <div className="help-card-header">
                <div className="help-card-header__icon">
                  <Icon name="circleInfo" />
                </div>
                <div>
                  <span className="help-eyebrow">Quick Start</span>
                  <h3>Get from first launch to a managed environment quickly.</h3>
                  <p>These are the actions most users need first. Everything else in this pane is supporting reference.</p>
                </div>
              </div>

              <div className="help-step-list">
                {quickStartSteps.map((step, index) => (
                  <div key={step.title} className="help-step-card">
                    <span className="help-step-card__index">{index + 1}</span>
                    <div className="help-step-card__body">
                      <h4>
                        <Icon name={step.icon} />
                        {step.title}
                      </h4>
                      <p>{step.body}</p>
                    </div>
                  </div>
                ))}
              </div>
            </section>

            <section className="help-section-group">
              <div className="help-section-group__header">
                <span className="help-eyebrow">Task Guides</span>
                <h3>Find the right workspace for the job.</h3>
              </div>

              <div className="help-task-grid">
                {primaryHelpCards.map((card) => (
                  <article key={card.title} className="help-task-card">
                    <div className="help-task-card__header">
                      <div className="help-card-header__icon">
                        <Icon name={card.icon} />
                      </div>
                      <div>
                        <h4>{card.title}</h4>
                        <p>{card.copy}</p>
                      </div>
                    </div>
                    <ul className="help-list">
                      {card.items.map((item) => (
                        <li key={item}>{item}</li>
                      ))}
                    </ul>
                  </article>
                ))}
              </div>
            </section>
          </div>

          <aside className="help-layout__secondary">
            <section className="help-reference-card help-reference-card--summary">
              <div className="help-reference-card__header">
                <Icon name="compass" />
                <h4>Where to Start</h4>
              </div>
              <ul className="help-list help-list--compact">
                <li>Create or import an environment first.</li>
                <li>Use Accounts when Steam or Nexus access becomes a blocker.</li>
                <li>Open Logs and Config together when deeper diagnostics are needed.</li>
              </ul>
            </section>

            <section className="help-section-group">
              <div className="help-section-group__header">
                <span className="help-eyebrow">Reference</span>
                <h3>Supporting details for common maintenance tasks.</h3>
              </div>

              <div className="help-reference-grid">
                {referenceCards.map((card) => (
                  <article key={card.title} className="help-reference-card">
                    <div className="help-reference-card__header">
                      <Icon name={card.icon} />
                      <h4>{card.title}</h4>
                    </div>
                    <ul className="help-list help-list--compact">
                      {card.items.map((item) => (
                        <li key={item}>{item}</li>
                      ))}
                    </ul>
                  </article>
                ))}
              </div>
            </section>

            <section className="help-callout-card">
              <div className="help-card-header">
                <div className="help-card-header__icon">
                  <Icon name="wrench" />
                </div>
                <div>
                  <span className="help-eyebrow">Repair Hint</span>
                  <h3>DepotDownloader is required for Steam depot workflows.</h3>
                  <p>If SIMM reports that DepotDownloader is missing, repair prerequisites or install it manually before retrying a protected branch download.</p>
                </div>
              </div>
              <code>winget install --exact --id SteamRE.DepotDownloader</code>
            </section>
          </aside>
        </div>
      </div>
    </section>
  );
}
