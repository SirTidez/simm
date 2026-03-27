import { useEffect, useMemo, useState } from 'react';

import { ApiService } from '../services/api';

interface WelcomeOverlayProps {
  isOpen: boolean;
  onClose: () => void;
  onOpenWizard: () => void;
  onOpenSettings: () => void;
}

const storageCards = [
  {
    icon: 'fas fa-download',
    title: 'Downloads',
    body: 'Temporary game payloads and shared mod assets are staged here before they are applied.',
  },
  {
    icon: 'fas fa-box-archive',
    title: 'Backups',
    body: 'Recovery snapshots and support files stay here so environment changes remain reversible.',
  },
  {
    icon: 'fas fa-file-lines',
    title: 'Logs',
    body: 'Application and troubleshooting logs live here for support, diagnostics, and export workflows.',
  },
  {
    icon: 'fas fa-sliders',
    title: 'App Data',
    body: 'Settings, cache, and supporting SIMM data stay organized outside the game directory.',
  },
];

export function WelcomeOverlay({ isOpen, onClose, onOpenWizard, onOpenSettings }: WelcomeOverlayProps) {
  const [homePath, setHomePath] = useState<string | null>(null);
  const [homePathLookupFailed, setHomePathLookupFailed] = useState(false);

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

  const simmPath = useMemo(() => {
    if (!homePath) {
      return 'your home directory\\SIMM';
    }

    return `${homePath.replace(/[\\/]*$/, '\\')}SIMM`;
  }, [homePath]);

  const canOpenSimmFolder = Boolean(homePath);

  const handleOpenSimmFolder = async () => {
    if (!canOpenSimmFolder) {
      return;
    }

    try {
      await ApiService.openPath(simmPath);
    } catch (error) {
      console.error('Failed to open SIMM folder:', error);
    }
  };

  if (!isOpen) return null;

  return (
    <section className="modal-content workspace-panel welcome-panel" aria-label="Welcome panel">
      <div className="modal-header">
        <h2>Welcome</h2>
        <button className="modal-close" onClick={onClose} aria-label="Close welcome panel">×</button>
      </div>

      <div className="welcome-panel__body">
        <div className="welcome-panel__overview">
          <div className="welcome-panel__header">
            <span className="welcome-panel__eyebrow">First Run</span>
            <h3>Welcome to Schedule I Mod Manager</h3>
            <p>
              SIMM created a dedicated workspace folder for downloads, backups, logs, and app data so your game
              installs stay cleaner and easier to support.
            </p>
          </div>
          <div className="welcome-panel__stats">
            <article className="welcome-panel__stat-card">
              <span>SIMM Home</span>
              <strong>Created</strong>
            </article>
            <article className="welcome-panel__stat-card">
              <span>Storage Ready</span>
              <strong>Downloads, backups, logs</strong>
            </article>
            <article className="welcome-panel__stat-card">
              <span>Settings Adjustable</span>
              <strong>Change paths later</strong>
            </article>
          </div>
        </div>

        <div className="welcome-panel__layout">
          <div className="welcome-panel__primary">
            <section className="welcome-panel__content-card">
              <div className="welcome-panel__section-header">
                <span className="welcome-panel__eyebrow">SIMM Home Directory</span>
                <h4>SIMM is ready to manage its own workspace.</h4>
              </div>

              <div className="welcome-panel__path-card">
                <div className="welcome-panel__path-value">{simmPath}</div>
                <p>
                  This folder keeps SIMM-managed files outside the game directory so installs stay easier to update,
                  recover, and inspect.
                </p>
              </div>

              <div className="welcome-panel__inline-actions">
                <button type="button" className="btn btn-secondary" onClick={() => void handleOpenSimmFolder()} disabled={!canOpenSimmFolder}>
                  <i className="fas fa-folder-open" aria-hidden="true"></i>
                  Open SIMM Folder
                </button>
                {homePathLookupFailed && (
                  <span className="welcome-panel__inline-note">
                    Folder lookup is unavailable right now, but SIMM still created the workspace.
                  </span>
                )}
              </div>
            </section>

            <section className="welcome-panel__content-card">
              <div className="welcome-panel__section-header">
                <span className="welcome-panel__eyebrow">What SIMM Stores Here</span>
                <h4>Core files stay organized in one managed location.</h4>
              </div>

              <div className="welcome-panel__storage-grid">
                {storageCards.map((card) => (
                  <article key={card.title} className="welcome-panel__storage-card">
                    <div className="welcome-panel__storage-icon">
                      <i className={card.icon} aria-hidden="true"></i>
                    </div>
                    <div>
                      <h5>{card.title}</h5>
                      <p>{card.body}</p>
                    </div>
                  </article>
                ))}
              </div>
            </section>

            <section className="welcome-panel__content-card welcome-panel__content-card--quiet">
              <div className="welcome-panel__section-header">
                <span className="welcome-panel__eyebrow">What You Can Change Later</span>
                <h4>SIMM defaults are only a starting point.</h4>
              </div>
              <p>
                You can change download location, update behavior, logging preferences, and supporting tools later from
                the Settings workspace.
              </p>
            </section>
          </div>

          <aside className="welcome-panel__secondary">
            <section className="welcome-panel__content-card">
              <div className="welcome-panel__section-header">
                <span className="welcome-panel__eyebrow">Next Steps</span>
                <h4>Start with the actions most users need first.</h4>
              </div>

              <div className="welcome-panel__actions">
                <button type="button" className="btn btn-primary" onClick={onOpenWizard}>
                  <i className="fas fa-plus-circle" aria-hidden="true"></i>
                  Create Environment
                </button>
                <button type="button" className="btn btn-secondary" onClick={() => void handleOpenSimmFolder()} disabled={!canOpenSimmFolder}>
                  <i className="fas fa-folder-open" aria-hidden="true"></i>
                  Open SIMM Folder
                </button>
                <button type="button" className="btn btn-secondary" onClick={onOpenSettings}>
                  <i className="fas fa-sliders" aria-hidden="true"></i>
                  Open Settings
                </button>
              </div>
            </section>

            <section className="welcome-panel__content-card welcome-panel__content-card--quiet">
              <div className="welcome-panel__section-header">
                <span className="welcome-panel__eyebrow">Workspace Flow</span>
                <h4>What happens next</h4>
              </div>
              <ol className="welcome-panel__step-list">
                <li>Create or import a managed environment.</li>
                <li>Open mods, config, logs, and tools from each environment card.</li>
                <li>Return to Settings later when you want to tune paths and update behavior.</li>
              </ol>
            </section>
          </aside>
        </div>
      </div>

      <div className="welcome-panel__footer">
        <button type="button" className="btn btn-primary" onClick={onClose}>
          Continue
        </button>
      </div>
    </section>
  );
}
