import { useEffect } from 'react';
import { Icon } from './Icon';
import type { IconName } from './icons';
import { SimmBadge, SimmButton } from './primitives';
import { Separator } from '@/components/ui/separator';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { WorkspacePageHeader } from './WorkspacePageHeader';

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
    body: 'SIMM usually finds your Steam install automatically. Use Add Game to link it, or import a folder only if detection misses it.',
  },
  {
    icon: 'userCircle',
    title: 'Authenticate when needed',
    body: 'You do not need to sign in to Steam for your normal Steam install. Authenticate only when SIMM needs authorization for advanced Schedule I installs.',
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
      'Start with the detected Steam install. Import a folder only if automatic detection does not find it.',
      'The Steam install stays managed by Steam. SIMM manages mods, plugins, tools, and support actions around it.',
      'Power User mode can add separate Steam branches when you need test or alternate installs.',
      'Steam handles updates for the Steam install. SIMM updates the separate installs it creates or imports.',
      'Run Check Updates when you want an immediate refresh for SIMM-managed installs.',
      'Use Update to apply the newest available build to a SIMM-managed install.',
      'Use Launch and Folder for quick verification and support work.',
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
      'If your Steam install is missing, refresh detection first. Import the folder only when detection still misses it.',
      'Advanced Steam install failures usually point to Steam sign-in, Steam Guard, or network issues.',
      'Launch failures usually mean the executable path or loader setup needs review.',
      'If DepotDownloader is missing, SIMM can install it automatically before advanced branch installs.',
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
      'Steam installs update through Steam. SIMM only applies game updates to SIMM-managed installs.',
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
    body: 'Link the detected Steam install first, import a folder if needed, or open advanced branch installs in Power User mode.',
    action: 'wizard' as const,
  },
  {
    icon: 'userGear',
    title: 'Open Accounts',
    body: 'Steam sign-in is not needed for the normal Steam install. Use Accounts for advanced Steam authorization or Nexus manager downloads.',
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
      <WorkspacePageHeader
        eyebrow="Workspace"
        title="Help Center"
        description="Find setup guidance, account help, update diagnostics, and common recovery steps."
      />

      <div className="help-pane">
        <div className="help-overview">
          <div className="help-overview__copy">
            <span className="help-eyebrow">Operator Guide</span>
            <h3>Start with setup, then use the focused tabs for maintenance and recovery.</h3>
            <p>Help is grouped around the work SIMM actually does: creating environments, managing mods and support files, and fixing account, update, or loader issues.</p>
          </div>
          <div className="help-overview__badges">
            <SimmBadge variant="outline" className="help-badge">3 setup steps</SimmBadge>
            <SimmBadge variant="outline" className="help-badge">4 task guides</SimmBadge>
            <SimmBadge variant="outline" className="help-badge">Focused reference</SimmBadge>
          </div>
        </div>

        <div className="help-action-grid">
          {quickActions.map((actionCard) => {
            const handleClick = actionCard.action === 'wizard'
              ? onOpenWizard
              : actionCard.action === 'accounts'
                ? onOpenAccounts
                : onOpenSettings;

            return (
              <SimmButton
                key={actionCard.title}
                type="button"
                variant="secondary"
                className="help-action-card"
                onClick={handleClick}
              >
                <Icon name={actionCard.icon} />
                <span>{actionCard.title}</span>
                <Icon name="arrowRight" className="help-action-card__chevron" />
              </SimmButton>
            );
          })}
        </div>

        <Tabs defaultValue="start" className="help-tabs">
          <TabsList className="help-tabs__list" variant="line" aria-label="Help topics">
            <TabsTrigger value="start">Start</TabsTrigger>
            <TabsTrigger value="tasks">Tasks</TabsTrigger>
            <TabsTrigger value="reference">Reference</TabsTrigger>
          </TabsList>

          <TabsContent value="start" className="help-tabs__content">
            <div className="help-layout help-layout--start">
              <section className="help-panel">
                <div className="help-card-header">
                  <div className="help-card-header__icon">
                    <Icon name="circleInfo" />
                  </div>
                  <div>
                    <span className="help-eyebrow">Quick Start</span>
                    <h3>Get from first launch to a managed environment quickly.</h3>
                    <p>These are the first decisions most users need. Everything else is supporting reference.</p>
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

              <section className="help-panel help-panel--quiet">
                <div className="help-reference-card__header">
                  <Icon name="compass" />
                  <h4>Where to Start</h4>
                </div>
                <ul className="help-list help-list--compact">
                  <li>Let SIMM detect your Steam install first.</li>
                  <li>Use Import only when detection does not find the folder.</li>
                  <li>Let Steam update the Steam install; use SIMM updates for SIMM-managed installs.</li>
                  <li>Use Accounts when Steam or Nexus sign-in becomes a blocker.</li>
                  <li>Open Logs and Config together when deeper diagnostics are needed.</li>
                </ul>
              </section>
            </div>
          </TabsContent>

          <TabsContent value="tasks" className="help-tabs__content">
            <div className="help-section-group">
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
                    <Separator className="help-separator" />
                    <ul className="help-list">
                      {card.items.map((item) => (
                        <li key={item}>{item}</li>
                      ))}
                    </ul>
                  </article>
                ))}
              </div>
            </div>
          </TabsContent>

          <TabsContent value="reference" className="help-tabs__content">
            <div className="help-section-group__header">
              <span className="help-eyebrow">Reference</span>
              <h3>Supporting details for common maintenance tasks.</h3>
            </div>

            <div className="help-layout help-layout--reference">
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
              <section className="help-callout-card">
                <div className="help-card-header">
                  <div className="help-card-header__icon">
                    <Icon name="wrench" />
                  </div>
                  <div>
                    <span className="help-eyebrow">Repair Hint</span>
                    <h3>DepotDownloader powers advanced Steam branch installs.</h3>
                    <p>If SIMM reports that DepotDownloader is missing, let SIMM install it automatically or repair prerequisites before retrying the branch install.</p>
                  </div>
                </div>
                <code>winget install --exact --id SteamRE.DepotDownloader</code>
              </section>
            </div>
          </TabsContent>
        </Tabs>
      </div>
    </section>
  );
}
