import React, { useState, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { EnvironmentList } from './EnvironmentList';
import { EnvironmentCreationWizard } from './EnvironmentCreationWizard';
import { ModLibraryOverlay } from './ModLibraryOverlay';
import { Settings } from './Settings';
import { SteamAccountOverlay } from './SteamAccountOverlay';
import { HelpOverlay } from './HelpOverlay';
import { WelcomeOverlay } from './WelcomeOverlay';
import { Footer } from './Footer';
import { EnvironmentStoreProvider } from '../stores/environmentStore';
import { SettingsStoreProvider } from '../stores/settingsStore';
import { interceptConsole } from '../utils/logger';
import { ErrorBoundary } from './ErrorBoundary';

function AppContent() {
  const [showWizard, setShowWizard] = useState(false);
  const [showModLibrary, setShowModLibrary] = useState(false);
  const [showSteamAccount, setShowSteamAccount] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [showWelcome, setShowWelcome] = useState(false);

  // Initialize console logging interception after a short delay to avoid blocking startup
  useEffect(() => {
    // Defer console interception to not block initial render
    const timer = setTimeout(() => {
      interceptConsole();
    }, 100); // Small delay to let app render first

    return () => clearTimeout(timer);
  }, []);

  // Check if SIMM directory was just created on app launch
  useEffect(() => {
    const checkWelcome = async () => {
      try {
        const wasCreated = await invoke<boolean>('was_simm_directory_just_created');
        if (wasCreated) {
          setShowWelcome(true);
        }
      } catch (error) {
        console.error('Failed to check if SIMM directory was created:', error);
      }
    };
    checkWelcome();
  }, []);
  return (
    <div className="app">
      <header className="app-header">
        <h1>Schedule I Mod Manager</h1>
        <div className="header-actions">
          <button
            onClick={() => setShowModLibrary(true)}
            className="btn btn-icon"
            title="Mod Library"
            aria-label="Mod Library"
          >
            <i className="fas fa-search"></i>
          </button>
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

      {showModLibrary && (
        <ModLibraryOverlay isOpen={showModLibrary} onClose={() => setShowModLibrary(false)} />
      )}

      <SteamAccountOverlay
        isOpen={showSteamAccount}
        onClose={() => setShowSteamAccount(false)}
      />

      <HelpOverlay
        isOpen={showHelp}
        onClose={() => setShowHelp(false)}
      />

      <WelcomeOverlay
        isOpen={showWelcome}
        onClose={() => setShowWelcome(false)}
      />
    </div>
  );
}

export function App() {
  return (
    <ErrorBoundary>
      <SettingsStoreProvider>
        <EnvironmentStoreProvider>
          <AppContent />
        </EnvironmentStoreProvider>
      </SettingsStoreProvider>
    </ErrorBoundary>
  );
}

