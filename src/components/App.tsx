import React, { useState } from 'react';
import { EnvironmentList } from './EnvironmentList';
import { EnvironmentCreationWizard } from './EnvironmentCreationWizard';
import { Settings } from './Settings';
import { SteamAccountOverlay } from './SteamAccountOverlay';
import { HelpOverlay } from './HelpOverlay';
import { Footer } from './Footer';
import { EnvironmentStoreProvider } from '../stores/environmentStore';
import { SettingsStoreProvider } from '../stores/settingsStore';

function AppContent() {
  const [showWizard, setShowWizard] = useState(false);
  const [showSteamAccount, setShowSteamAccount] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  return (
    <div className="app">
      <header className="app-header">
        <h1>Schedule I Mod Manager</h1>
        <div className="header-actions">
          <button
            onClick={() => setShowHelp(true)}
            className="btn btn-icon"
            title="Help"
            aria-label="Help"
          >
            <i className="fas fa-question-circle"></i>
          </button>
          <button
            onClick={() => setShowWizard(true)}
            className="btn btn-icon"
            title="Create Game Install"
            aria-label="Create Game Install"
          >
            <i className="fas fa-plus-circle"></i>
          </button>
          <button
            onClick={() => setShowSteamAccount(true)}
            className="btn btn-icon"
            title="Steam Account"
            aria-label="Steam Account"
          >
            <i className="fas fa-user-circle"></i>
          </button>
          <Settings />
        </div>
      </header>

      <main className="app-main">
        <EnvironmentList />
      </main>

      <Footer />

      {showWizard && (
        <EnvironmentCreationWizard onClose={() => setShowWizard(false)} />
      )}

      <SteamAccountOverlay
        isOpen={showSteamAccount}
        onClose={() => setShowSteamAccount(false)}
      />

      <HelpOverlay
        isOpen={showHelp}
        onClose={() => setShowHelp(false)}
      />
    </div>
  );
}

export function App() {
  return (
    <SettingsStoreProvider>
      <EnvironmentStoreProvider>
        <AppContent />
      </EnvironmentStoreProvider>
    </SettingsStoreProvider>
  );
}

