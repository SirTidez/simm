import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { SimmButton } from './primitives';

interface HelpOverlayProps {
  isOpen: boolean;
  onClose: () => void;
  onOpenWizard: () => void;
  onOpenSettings: () => void;
  onOpenAccounts: () => void;
}

type HelpTab = 'start' | 'tasks' | 'reference';
type HelpAction = 'wizard' | 'accounts' | 'settings';

const HELP_TABS: ReadonlyArray<{ id: HelpTab; label: string }> = [
  { id: 'start', label: 'Start' },
  { id: 'tasks', label: 'Tasks' },
  { id: 'reference', label: 'Reference' },
];

const startSteps: ReadonlyArray<{ title: string; body: string; action?: { label: string; target: HelpAction } }> = [
  {
    title: 'Add your game',
    body: 'SIMM usually finds your Steam install on its own. Add it as an environment, or import a folder only if detection misses it.',
    action: { label: 'Add Environment', target: 'wizard' },
  },
  {
    title: 'Sign in only when needed',
    body: 'Your normal Steam install needs no sign-in. Connect Steam for branch installs SIMM downloads itself, and Nexus Mods for Nexus downloads.',
    action: { label: 'Open Accounts', target: 'accounts' },
  },
  {
    title: 'Check your defaults',
    body: 'Pick the download folder, how often SIMM checks for updates, and the theme.',
    action: { label: 'Open Settings', target: 'settings' },
  },
  {
    title: 'Install mods and play',
    body: 'Find mods in the Mod Library and install them into an environment. Home shows what needs updating and starts the game.',
  },
];

const taskSections: ReadonlyArray<{ title: string; items: readonly string[] }> = [
  {
    title: 'Manage game installs',
    items: [
      'Start with the detected Steam install. Import a folder only if detection does not find it.',
      'Steam keeps managing the Steam install and its updates. SIMM manages mods, plugins, and tools around it.',
      'Power User mode adds separate Steam branch installs for test or alternate builds. SIMM updates the installs it creates or imports.',
      'Use Check Updates for an immediate refresh, and Update to apply the newest build to a SIMM-managed install.',
      'Deleting an environment removes it from SIMM. Its files stay on disk.',
    ],
  },
  {
    title: 'Install and update mods',
    items: [
      'The Mod Library is the one place to find, download, and update mods from Thunderstore and Nexus Mods.',
      'Each environment has its own Mods tab to enable, disable, update, and inspect what is installed there.',
      'Plugins and UserLibs tabs list the files in those runtime folders.',
      'Profiles save a set of mods so you can apply it to another environment.',
    ],
  },
  {
    title: 'Change settings and accounts',
    items: [
      'Settings holds download paths, theme, cache size, update checks, security scanning, and logging.',
      'Accounts shows whether Steam and Nexus Mods are connected and what each sign-in is used for.',
      'Credentials and tokens are stored encrypted on this device.',
    ],
  },
  {
    title: 'Fix common problems',
    items: [
      'Steam install missing: refresh detection first, then import the folder if it is still not found.',
      'Branch install fails: check the Steam sign-in, Steam Guard approval, and your network.',
      'Game does not launch: review the executable path and the MelonLoader setup in the environment.',
      'DepotDownloader missing: SIMM can install it before the next branch install.',
      'For deeper diagnosis, open the environment’s Logs and Config tabs side by side.',
    ],
  },
];

const referenceSections: ReadonlyArray<{ title: string; items: readonly string[]; code?: readonly string[] }> = [
  {
    title: 'Environment details',
    items: [
      'Rename environments to keep labels clear.',
      'Add a description to tell test builds and stable builds apart.',
    ],
  },
  {
    title: 'Update checks',
    items: [
      'Automatic checks run on the interval set in Settings.',
      'Manual checks skip the wait and refresh status right away.',
      'Steam updates the Steam install. SIMM only applies game updates to the installs it manages.',
    ],
  },
  {
    title: 'MelonLoader',
    items: [
      'The preferred MelonLoader version for new environments is set in Settings.',
      'SIMM matches the loader to each environment’s runtime where it can and tracks it per environment.',
    ],
  },
  {
    title: 'DepotDownloader',
    items: [
      'DepotDownloader powers Steam branch installs. If SIMM reports it missing, use the automatic install or install the SteamRE release yourself.',
    ],
    code: [
      'Windows: winget install --exact --id SteamRE.DepotDownloader',
      'Linux: SIMM installs DepotDownloader to ~/.local/bin',
    ],
  },
];

export function HelpOverlay({ isOpen, onClose, onOpenWizard, onOpenSettings, onOpenAccounts }: HelpOverlayProps) {
  const [activeTab, setActiveTab] = useState<HelpTab>('start');
  const tabRefs = useRef<Record<HelpTab, HTMLButtonElement | null>>({ start: null, tasks: null, reference: null });

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

  const runAction = (target: HelpAction) => {
    if (target === 'wizard') onOpenWizard();
    else if (target === 'accounts') onOpenAccounts();
    else onOpenSettings();
  };

  const handleTabKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    const index = HELP_TABS.findIndex((tab) => tab.id === activeTab);
    let nextIndex = index;
    if (event.key === 'ArrowRight') nextIndex = (index + 1) % HELP_TABS.length;
    else if (event.key === 'ArrowLeft') nextIndex = (index - 1 + HELP_TABS.length) % HELP_TABS.length;
    else if (event.key === 'Home') nextIndex = 0;
    else if (event.key === 'End') nextIndex = HELP_TABS.length - 1;
    else return;
    event.preventDefault();
    const next = HELP_TABS[nextIndex].id;
    setActiveTab(next);
    tabRefs.current[next]?.focus();
  };

  return (
    <section className="workspace-panel ui-page help-page" aria-label="Help panel">
      <header className="ui-page-header">
        <div className="ui-page-header__titles">
          <h2 className="ui-page-title">Help</h2>
          <p className="ui-page-subtitle">Set up SIMM, find the right place for a task, and fix common problems.</p>
        </div>
      </header>

      <div className="ui-tabs-line" role="tablist" aria-label="Help topics">
        {HELP_TABS.map((tab) => (
          <button
            key={tab.id}
            ref={(node) => { tabRefs.current[tab.id] = node; }}
            type="button"
            role="tab"
            id={`help-tab-${tab.id}`}
            aria-selected={activeTab === tab.id}
            aria-controls={`help-panel-${tab.id}`}
            tabIndex={activeTab === tab.id ? 0 : -1}
            className="ui-tabs-line__tab"
            onClick={() => setActiveTab(tab.id)}
            onKeyDown={handleTabKeyDown}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <div
        className="ui-page-body help-body"
        role="tabpanel"
        id={`help-panel-${activeTab}`}
        aria-labelledby={`help-tab-${activeTab}`}
        tabIndex={0}
      >
        {activeTab === 'start' && (
          <div className="help-content">
            <h3 className="help-heading">Get started</h3>
            <ol className="help-steps">
              {startSteps.map((step, index) => (
                <li key={step.title} className="help-step">
                  <span className="help-step__index" aria-hidden="true">{index + 1}</span>
                  <div className="help-step__copy">
                    <h4>{step.title}</h4>
                    <p>{step.body}</p>
                  </div>
                  {step.action && (
                    <SimmButton
                      type="button"
                      variant="outline"
                      size="sm"
                      className="help-step__action"
                      onClick={() => runAction(step.action!.target)}
                    >
                      {step.action.label}
                    </SimmButton>
                  )}
                </li>
              ))}
            </ol>
          </div>
        )}

        {activeTab === 'tasks' && (
          <div className="help-content help-content--grid">
            {taskSections.map((section) => (
              <section key={section.title} className="help-topic">
                <h3 className="help-heading">{section.title}</h3>
                <ul className="help-list">
                  {section.items.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
        )}

        {activeTab === 'reference' && (
          <div className="help-content help-content--grid">
            {referenceSections.map((section) => (
              <section key={section.title} className="help-topic">
                <h3 className="help-heading">{section.title}</h3>
                <ul className="help-list">
                  {section.items.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
                {section.code?.map((line) => (
                  <code key={line} className="help-code">{line}</code>
                ))}
              </section>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
