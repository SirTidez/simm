import { useEffect } from 'react';

export function HelpOverlay({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) {
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
    <section
      className="modal-content help-overlay"
      style={{
        width: '100%',
        height: '100%',
        maxWidth: 'none',
        margin: 0,
        borderRadius: '0.75rem',
        display: 'flex',
        flexDirection: 'column'
      }}
      aria-label="Help panel"
    >
      <div className="modal-header">
        <h2>Help Center</h2>
        <button className="modal-close" onClick={onClose} aria-label="Close help panel">×</button>
      </div>

      <div className="help-content" style={{ flex: 1, overflowY: 'auto' }}>
          <section className="help-section">
            <h3>
              <i className="fas fa-info-circle" style={{ marginRight: '0.5rem', color: '#646cff' }}></i>
              Quick Start
            </h3>
            <p>
              Welcome to Schedule I Mod Manager. Use this workspace to manage installs, mods, and support tools in one place.
            </p>
            <ol>
              <li>Select <i className="fas fa-plus-circle" style={{ color: '#646cff' }}></i> to create a new game install.</li>
              <li>Pick a branch, then confirm your install path.</li>
              <li>Authenticate Steam with <i className="fas fa-user-circle" style={{ color: '#646cff' }}></i> when required.</li>
              <li>Download and manage your install from the environment list.</li>
            </ol>
          </section>

          <section className="help-section">
            <h3>
              <i className="fas fa-download" style={{ marginRight: '0.5rem', color: '#646cff' }}></i>
              Manage Game Installs
            </h3>
            <ul>
              <li><strong>Download:</strong> Pull a branch into the selected directory.</li>
              <li><strong>Check Updates:</strong> Check for newer branch builds.</li>
              <li><strong>Update:</strong> Install the newest version when available.</li>
              <li><strong>Launch Game:</strong> Start the executable from that install.</li>
              <li><strong>Open Folder:</strong> Open install files in File Explorer.</li>
              <li><strong>Delete:</strong> Remove the install entry (downloaded files stay on disk).</li>
              <li><strong>Icon buttons:</strong> Hover action icons for quick tooltips.</li>
            </ul>
          </section>

          <section className="help-section">
            <h3>
              <i className="fas fa-user-cog" style={{ marginRight: '0.5rem', color: '#646cff' }}></i>
              Settings & Authentication
            </h3>
            <ul>
              <li><strong>Settings <i className="fas fa-cog" style={{ color: '#646cff' }}></i>:</strong> Configure directories, tools, updates, and logs.</li>
              <li><strong>Steam Account <i className="fas fa-user-circle" style={{ color: '#646cff' }}></i>:</strong> Verify or refresh account authentication.</li>
              <li>Credentials and API secrets are encrypted and stored locally.</li>
            </ul>
          </section>

          <section className="help-section">
            <h3>
              <i className="fas fa-edit" style={{ marginRight: '0.5rem', color: '#646cff' }}></i>
              Edit Install Details
            </h3>
            <ul>
              <li>Use <i className="fas fa-edit" style={{ color: '#646cff' }}></i> near an install name to rename it.</li>
              <li>Use <i className="fas fa-edit" style={{ color: '#646cff' }}></i> near the description to add context.</li>
              <li>Descriptions make multi-install setups easier to track.</li>
            </ul>
          </section>

          <section className="help-section">
            <h3>
              <i className="fas fa-sync-alt" style={{ marginRight: '0.5rem', color: '#646cff' }}></i>
              Update Checks
            </h3>
            <ul>
              <li>Automatic checks run on your configured interval.</li>
              <li>You can run manual checks with "Check Updates".</li>
              <li>Cards show available update versions when found.</li>
              <li>Use "Update" to download and apply the new build.</li>
            </ul>
          </section>

          <section className="help-section">
            <h3>
              <i className="fas fa-puzzle-piece" style={{ marginRight: '0.5rem', color: '#646cff' }}></i>
              MelonLoader (ML) Management
            </h3>
            <ul>
              <li><strong>Status:</strong> The ML section shows the currently installed version.</li>
              <li><strong>Version selection:</strong> Use <i className="fas fa-download" style={{ color: '#646cff' }}></i> to pick a specific release.</li>
              <li><strong>Releases:</strong> Stable releases are listed first, with optional nightly builds.</li>
              <li><strong>Per install:</strong> Stored version is tracked for each game install.</li>
              <li><strong>Compatibility:</strong> Unsupported versions are excluded automatically.</li>
            </ul>
          </section>

          <section className="help-section">
            <h3>
              <i className="fas fa-boxes" style={{ marginRight: '0.5rem', color: '#646cff' }}></i>
              Mods, Plugins, and UserLibs
            </h3>
            <ul>
              <li><strong>Counts:</strong> Each section shows discovered file totals.</li>
              <li><strong>Details:</strong> Open lists with <i className="fas fa-list" style={{ color: '#646cff' }}></i> to inspect entries.</li>
              <li><strong>Mods:</strong> `.dll` files from the `Mods` directory.</li>
              <li><strong>Plugins:</strong> `.dll` files from the `Plugins` directory.</li>
              <li><strong>UserLibs:</strong> User library files from `UserLibs` (read-only).</li>
            </ul>
          </section>

          <section className="help-section">
            <h3>
              <i className="fas fa-question-circle" style={{ marginRight: '0.5rem', color: '#646cff' }}></i>
              Troubleshooting
            </h3>
            <ul>
              <li><strong>Download fails:</strong> Recheck Steam auth and network connectivity.</li>
              <li><strong>Game won't launch:</strong> Confirm the executable exists in the install folder.</li>
              <li><strong>DepotDownloader missing:</strong> Install with <code>winget install --exact --id SteamRE.DepotDownloader</code>.</li>
              <li><strong>Auth issues:</strong> Re-authenticate in the Steam Account panel.</li>
            </ul>
          </section>
      </div>
    </section>
  );
}

