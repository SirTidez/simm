import { useState, useEffect, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { EnvironmentList, type WorkspaceRoute } from './EnvironmentList';
import { useDiscordPresence } from '../hooks/useDiscordPresence';
import appIcon256 from '../assets/app-icon-256.png';
import { EnvironmentCreationWizard } from './EnvironmentCreationWizard';
import { ModLibraryOverlay } from './ModLibraryOverlay';
import { Settings } from './Settings';
import { SteamAccountOverlay } from './SteamAccountOverlay';
import { HelpOverlay } from './HelpOverlay';
import { WelcomeOverlay } from './WelcomeOverlay';
import { ModsOverlay } from './ModsOverlay';
import { PluginsOverlay } from './PluginsOverlay';
import { UserLibsOverlay } from './UserLibsOverlay';
import { LogsOverlay } from './LogsOverlay';
import { ConfigurationOverlay } from './ConfigurationOverlay';
import { Footer } from './Footer';
import { EnvironmentStoreProvider } from '../stores/environmentStore';
import { SettingsStoreProvider } from '../stores/settingsStore';
import { useEnvironmentStore } from '../stores/environmentStore';
import { interceptConsole } from '../utils/logger';
import { ErrorBoundary } from './ErrorBoundary';

function AppContent() {
  const appWindow = getCurrentWindow();
  const { environments } = useEnvironmentStore();
  const [activeWorkspace, setActiveWorkspace] = useState<WorkspaceRoute>({ view: 'home' });
  const [showStartupSplash, setShowStartupSplash] = useState(true);
  const [isMaximized, setIsMaximized] = useState(false);
  const [lastEnvironmentWorkspaceView, setLastEnvironmentWorkspaceView] = useState<'mods' | 'plugins' | 'userLibs' | 'logs' | 'config'>('mods');
  const [backgroundWorkspace, setBackgroundWorkspace] = useState<WorkspaceRoute | null>(null);
  const [libraryFocusRequest, setLibraryFocusRequest] = useState<{ storageId: string; modTag: string; requestId: number } | null>(null);

  const openWorkspace = useCallback((workspace: Exclude<WorkspaceRoute, { view: 'home' }>) => {
    setBackgroundWorkspace(null);
    setLibraryFocusRequest(null);
    setActiveWorkspace(workspace);
  }, []);

  const goHome = useCallback(() => {
    setBackgroundWorkspace(null);
    setLibraryFocusRequest(null);
    setActiveWorkspace({ view: 'home' });
  }, []);

  const openLibraryFromLogs = useCallback((focus: { storageId: string; modTag: string }) => {
    setBackgroundWorkspace(activeWorkspace);
    setLibraryFocusRequest((previous) => ({
      storageId: focus.storageId,
      modTag: focus.modTag,
      requestId: (previous?.requestId ?? 0) + 1,
    }));
    setActiveWorkspace({ view: 'library' });
  }, [activeWorkspace]);

  const closeLibrary = useCallback(() => {
    if (backgroundWorkspace) {
      setActiveWorkspace(backgroundWorkspace);
      setBackgroundWorkspace(null);
      setLibraryFocusRequest(null);
      return;
    }

    goHome();
  }, [backgroundWorkspace, goHome]);

  const getEnvironmentById = useCallback((environmentId: string) => {
    return environments.find((env) => env.id === environmentId) ?? null;
  }, [environments]);

  const renderWorkspacePanelFor = useCallback((workspace: WorkspaceRoute, onCloseHandler: () => void) => {
    switch (workspace.view) {
      case 'library':
        return (
          <ModLibraryOverlay
            isOpen={true}
            onClose={onCloseHandler}
            focusStorageId={libraryFocusRequest?.storageId ?? null}
            focusRequestId={libraryFocusRequest?.requestId}
            focusModTag={libraryFocusRequest?.modTag ?? null}
          />
        );
      case 'wizard':
        return <EnvironmentCreationWizard onClose={onCloseHandler} />;
      case 'accounts':
        return <SteamAccountOverlay isOpen={true} onClose={onCloseHandler} />;
      case 'help':
        return <HelpOverlay isOpen={true} onClose={onCloseHandler} />;
      case 'settings':
        return <Settings isOpen={true} onClose={onCloseHandler} />;
      case 'welcome':
        return <WelcomeOverlay isOpen={true} onClose={onCloseHandler} />;
      case 'mods':
        return (
          <ModsOverlay
            isOpen={true}
            onClose={onCloseHandler}
            environmentId={workspace.environmentId}
            onOpenAccounts={() => openWorkspace({ view: 'accounts' })}
            onModUpdatesChecked={(count) => {
              window.dispatchEvent(new CustomEvent('mod-updates-checked', { detail: { environmentId: workspace.environmentId, count } }));
            }}
          />
        );
      case 'plugins':
        return (
          <PluginsOverlay
            isOpen={true}
            onClose={onCloseHandler}
            environmentId={workspace.environmentId}
          />
        );
      case 'userLibs':
        return (
          <UserLibsOverlay
            isOpen={true}
            onClose={onCloseHandler}
            environmentId={workspace.environmentId}
          />
        );
      case 'logs': {
        const environment = getEnvironmentById(workspace.environmentId);
        return environment ? (
          <LogsOverlay
            isOpen={true}
            onClose={onCloseHandler}
            environmentId={workspace.environmentId}
            environment={environment}
            onOpenModLibraryView={openLibraryFromLogs}
          />
        ) : null;
      }
      case 'config': {
        const environment = getEnvironmentById(workspace.environmentId);
        return environment ? (
          <ConfigurationOverlay
            isOpen={true}
            onClose={onCloseHandler}
            environmentId={workspace.environmentId}
            environment={environment}
          />
        ) : null;
      }
      case 'home':
      default:
        return null;
    }
  }, [getEnvironmentById, libraryFocusRequest?.requestId, libraryFocusRequest?.storageId, openLibraryFromLogs, openWorkspace]);

  useEffect(() => {
    if (
      activeWorkspace.view === 'mods' ||
      activeWorkspace.view === 'plugins' ||
      activeWorkspace.view === 'userLibs' ||
      activeWorkspace.view === 'logs' ||
      activeWorkspace.view === 'config'
    ) {
      setLastEnvironmentWorkspaceView(activeWorkspace.view);
    }
  }, [activeWorkspace.view]);

  const handleWorkspaceEnvironmentSelect = useCallback((environmentId: string) => {
    setActiveWorkspace((previous) => {
      if (!('environmentId' in previous)) {
        return {
          view: lastEnvironmentWorkspaceView,
          environmentId,
        };
      }

      return {
        ...previous,
        environmentId
      };
    });
  }, [lastEnvironmentWorkspaceView]);

  const handleInitialDetectionComplete = useCallback(() => {
    setShowStartupSplash(false);
  }, []);

  // Discord Rich Presence - automatically initializes and sets presence
  useDiscordPresence();

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
          setActiveWorkspace({ view: 'welcome' });
        }
      } catch (error) {
        console.error('Failed to check if SIMM directory was created:', error);
      }
    };
    checkWelcome();
  }, []);

  useEffect(() => {
    let unlisten: (() => void) | null = null;

    const bindWindowState = async () => {
      try {
        setIsMaximized(await appWindow.isMaximized());
        unlisten = await appWindow.onResized(async () => {
          setIsMaximized(await appWindow.isMaximized());
        });
      } catch (error) {
        console.error('Failed to bind window state:', error);
      }
    };

    bindWindowState();

    return () => {
      if (unlisten) {
        unlisten();
      }
    };
  }, [appWindow]);

  const handleMinimize = async () => {
    try {
      await appWindow.minimize();
    } catch (error) {
      console.error('Failed to minimize window:', error);
    }
  };

  const handleToggleMaximize = async () => {
    try {
      await appWindow.toggleMaximize();
      setIsMaximized(await appWindow.isMaximized());
    } catch (error) {
      console.error('Failed to toggle maximize:', error);
    }
  };

  const handleCloseWindow = async () => {
    try {
      await appWindow.close();
    } catch (error) {
      console.error('Failed to close window:', error);
    }
  };

  const renderWorkspacePanel = () => {
    const activeCloseHandler = activeWorkspace.view === 'library' ? closeLibrary : goHome;
    const activePanel = renderWorkspacePanelFor(activeWorkspace, activeCloseHandler);
    if (activeWorkspace.view === 'library' && backgroundWorkspace) {
      return (
        <>
          <div style={{ display: 'none' }}>
            {renderWorkspacePanelFor(backgroundWorkspace, goHome)}
          </div>
          {activePanel}
        </>
      );
    }
    return activePanel;
  };

  return (
    <div className="app app-desktop-shell">
      <div className="app-window">
        <header className="window-chrome">
          <div className="window-brand" data-tauri-drag-region>
            <img src={appIcon256} alt="SIMM" className="window-brand-icon" />
            <div className="window-brand-text">
              <strong>SIMM</strong>
              <span>Schedule I Mod Manager</span>
            </div>
          </div>

          <div className="window-drag-region" data-tauri-drag-region aria-hidden="true" />

          <div className="window-toolbar-actions">
            <button
              onClick={() => openWorkspace({ view: 'library' })}
              className="btn btn-secondary btn-small"
              title="Open Mod Library"
            >
              <i className="fas fa-layer-group"></i>
              Mod Library
            </button>
            <button
              onClick={() => openWorkspace({ view: 'wizard' })}
              className="btn btn-primary btn-small"
              title="Download/Import New Game"
            >
              <i className="fas fa-plus"></i>
              New Game
            </button>
            <button
              onClick={() => openWorkspace({ view: 'accounts' })}
              className="btn btn-secondary btn-small"
              title="Manage connected accounts"
            >
              <i className="fas fa-user-circle"></i>
              Accounts
            </button>
            <button
              onClick={() => openWorkspace({ view: 'help' })}
              className="btn btn-secondary btn-small"
              title="Open help and guides"
            >
              <i className="fas fa-question-circle"></i>
              Help
            </button>
            <button
              onClick={() => openWorkspace({ view: 'settings' })}
              className="btn btn-secondary btn-small"
              title="Open settings"
            >
              <i className="fas fa-cog"></i>
              Settings
            </button>
          </div>

          <div className="window-controls" aria-label="Window controls">
            <button
              onClick={handleMinimize}
              className="window-control-btn"
              title="Minimize"
              aria-label="Minimize"
            >
              <i className="fas fa-minus"></i>
            </button>
            <button
              onClick={handleToggleMaximize}
              className="window-control-btn"
              title={isMaximized ? 'Restore Down' : 'Maximize'}
              aria-label={isMaximized ? 'Restore Down' : 'Maximize'}
            >
              <i className={`far ${isMaximized ? 'fa-window-restore' : 'fa-square'}`}></i>
            </button>
            <button
              onClick={handleCloseWindow}
              className="window-control-btn window-control-btn-close"
              title="Close"
              aria-label="Close"
            >
              <i className="fas fa-times"></i>
            </button>
          </div>
        </header>

        <div className="app-body">
          <div className={`app-content ${activeWorkspace.view === 'home' ? '' : 'workspace-active'}`}>
            {activeWorkspace.view === 'home' ? (
              <main className="app-main">
                <EnvironmentList
                  onInitialDetectionComplete={handleInitialDetectionComplete}
                  onOpenWorkspace={openWorkspace}
                />
              </main>
            ) : (
              <div className="workspace-layout">
                <aside
                  className="workspace-sidebar"
                >
                  <button onClick={goHome} className="btn btn-secondary" style={{ width: '100%', marginBottom: '1rem' }}>
                    <i className="fas fa-arrow-left"></i>
                    Back to Home
                  </button>
                  <EnvironmentList
                    compactMode={true}
                    activeWorkspace={activeWorkspace}
                    onSelectEnvironment={handleWorkspaceEnvironmentSelect}
                  />
                </aside>
                <main className="app-main workspace-main" style={{ position: 'relative' }}>
                  {renderWorkspacePanel()}
                </main>
              </div>
            )}
          </div>
        </div>

        <Footer />
      </div>

      {showStartupSplash && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 4000 }}>
          <div className="boot-screen" role="status" aria-live="polite">
            <div className="boot-card">
              <div className="boot-title">Schedule I</div>
              <div className="boot-subtitle">Detecting game and MelonLoader versions</div>
              <div className="boot-loader" aria-hidden="true">
                <span className="boot-dot"></span>
                <span className="boot-dot"></span>
                <span className="boot-dot"></span>
              </div>
              <div className="boot-bar"></div>
            </div>
          </div>
        </div>
      )}
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
