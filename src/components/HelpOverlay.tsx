import React from 'react';

export function HelpOverlay({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) {
  if (!isOpen) return null;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content help-overlay" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>Help</h2>
          <button className="modal-close" onClick={onClose}>×</button>
        </div>

        <div className="help-content">
          <section className="help-section">
            <h3>
              <i className="fas fa-info-circle" style={{ marginRight: '0.5rem', color: '#646cff' }}></i>
              Getting Started
            </h3>
            <p>
              Welcome to the Schedule I Mod Manager. This tool helps you manage multiple game installations and mods for the game.
            </p>
            <ol>
              <li>Click the <i className="fas fa-plus-circle" style={{ color: '#646cff' }}></i> button to create a new game install</li>
              <li>Select a branch and configure your download settings</li>
              <li>Authenticate with Steam using the <i className="fas fa-user-circle" style={{ color: '#646cff' }}></i> button</li>
              <li>Start downloading your game install</li>
            </ol>
          </section>

          <section className="help-section">
            <h3>
              <i className="fas fa-download" style={{ marginRight: '0.5rem', color: '#646cff' }}></i>
              Managing Game Installs
            </h3>
            <ul>
              <li><strong>Download:</strong> Start downloading a game branch to your specified directory</li>
              <li><strong>Check Updates:</strong> Verify if a newer version of the branch is available</li>
              <li><strong>Update:</strong> Download the latest version when an update is available</li>
              <li><strong>Launch Game:</strong> Open the game executable from the downloaded game install</li>
              <li><strong>Open Folder:</strong> Open the game install's directory in your file explorer</li>
              <li><strong>Delete:</strong> Remove a game install (this does not delete the downloaded files)</li>
              <li><strong>Icon Buttons:</strong> Hover over icon buttons (📥, 📋) in the ML, Mods, Plugins, and UserLibs sections to see tooltips explaining their function</li>
            </ul>
          </section>

          <section className="help-section">
            <h3>
              <i className="fas fa-user-cog" style={{ marginRight: '0.5rem', color: '#646cff' }}></i>
              Settings & Authentication
            </h3>
            <ul>
              <li><strong>Settings <i className="fas fa-cog" style={{ color: '#646cff' }}></i>:</strong> Configure download directories, DepotDownloader path, MelonLoader settings, and update check intervals</li>
              <li><strong>Steam Account <i className="fas fa-user-circle" style={{ color: '#646cff' }}></i>:</strong> View your authenticated Steam account and re-authenticate if needed</li>
              <li>Your Steam credentials are encrypted and stored locally for secure authentication</li>
            </ul>
          </section>

          <section className="help-section">
            <h3>
              <i className="fas fa-edit" style={{ marginRight: '0.5rem', color: '#646cff' }}></i>
              Editing Game Installs
            </h3>
            <ul>
              <li>Click the <i className="fas fa-edit" style={{ color: '#646cff' }}></i> button next to a game install name to rename it</li>
              <li>Click the <i className="fas fa-edit" style={{ color: '#646cff' }}></i> button next to the description to add or edit a description</li>
              <li>Descriptions help you remember what each game install is for</li>
            </ul>
          </section>

          <section className="help-section">
            <h3>
              <i className="fas fa-sync-alt" style={{ marginRight: '0.5rem', color: '#646cff' }}></i>
              Update Checks
            </h3>
            <ul>
              <li>The app can automatically check for updates at regular intervals</li>
              <li>You can also manually check for updates using the "Check Updates" button</li>
              <li>When an update is available, the environment card will show the update version</li>
              <li>Use the "Update" button to download the latest version</li>
            </ul>
          </section>

          <section className="help-section">
            <h3>
              <i className="fas fa-puzzle-piece" style={{ marginRight: '0.5rem', color: '#646cff' }}></i>
              MelonLoader (ML) Management
            </h3>
            <ul>
              <li><strong>ML Status:</strong> The ML section shows the currently installed MelonLoader version (e.g., "INSTALLED (v0.7.0)")</li>
              <li><strong>Version Selection:</strong> Click the download icon <i className="fas fa-download" style={{ color: '#646cff' }}></i> to select and install a specific MelonLoader version</li>
              <li><strong>Release Versions:</strong> Choose from official GitHub releases, with v0.7.0 marked as "Stable"</li>
              <li><strong>Nightly Builds:</strong> Optionally select from the top 3 nightly builds (marked as "Alpha-Nightly") for the latest experimental features</li>
              <li><strong>Version Display:</strong> The installed version is displayed in the ML badge and stored per game install</li>
              <li><strong>Changing Versions:</strong> Use the download icon <i className="fas fa-download" style={{ color: '#646cff' }}></i> button to change to a different version at any time</li>
              <li><strong>Compatibility:</strong> Note that version 0.7.1 is not compatible with Schedule I and is excluded from the version list</li>
            </ul>
          </section>

          <section className="help-section">
            <h3>
              <i className="fas fa-boxes" style={{ marginRight: '0.5rem', color: '#646cff' }}></i>
              Mods, Plugins, and UserLibs
            </h3>
            <ul>
              <li><strong>Count Display:</strong> Each section shows how many items are found (e.g., "3 Mods found", "1 Plugins found", "0 Libs found")</li>
              <li><strong>View Items:</strong> Click the list icon <i className="fas fa-list" style={{ color: '#646cff' }}></i> to view detailed information about installed mods, plugins, or user libraries</li>
              <li><strong>Mods:</strong> Dynamic-link library (.dll) files found in the Mods directory</li>
              <li><strong>Plugins:</strong> Dynamic-link library (.dll) files found in the Plugins directory</li>
              <li><strong>UserLibs:</strong> User library files found in the UserLibs directory (read-only)</li>
            </ul>
          </section>

          <section className="help-section">
            <h3>
              <i className="fas fa-question-circle" style={{ marginRight: '0.5rem', color: '#646cff' }}></i>
              Troubleshooting
            </h3>
            <ul>
              <li><strong>Download fails:</strong> Check your Steam authentication and internet connection</li>
              <li><strong>Game won't launch:</strong> Verify the executable exists in the game install directory</li>
              <li><strong>DepotDownloader not found:</strong> Install it using: <code>winget install --exact --id SteamRE.DepotDownloader</code></li>
              <li><strong>Authentication issues:</strong> Re-authenticate through the Steam Account overlay</li>
            </ul>
          </section>
        </div>
      </div>
    </div>
  );
}

