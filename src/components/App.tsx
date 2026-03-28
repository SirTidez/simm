import { useState, useEffect, useCallback, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { getCurrent as getCurrentDeepLink, onOpenUrl } from '@tauri-apps/plugin-deep-link';
import { EnvironmentList, type WorkspaceRoute } from './EnvironmentList';
import { useDiscordPresence } from '../hooks/useDiscordPresence';
import appIcon256 from '../assets/app-icon-256.png';
import { EnvironmentCreationWizard } from './EnvironmentCreationWizard';
import { ModLibraryOverlay, type ModLibraryNavigationState } from './ModLibraryOverlay';
import { Settings } from './Settings';
import { SteamAccountOverlay } from './SteamAccountOverlay';
import { HelpOverlay } from './HelpOverlay';
import { WelcomeOverlay } from './WelcomeOverlay';
import { ModsOverlay, type ModsOverlayNavigationState } from './ModsOverlay';
import { PluginsOverlay } from './PluginsOverlay';
import { UserLibsOverlay } from './UserLibsOverlay';
import { LogsOverlay } from './LogsOverlay';
import { ConfigurationOverlay } from './ConfigurationOverlay';
import { Footer } from './Footer';
import { EnvironmentStoreProvider } from '../stores/environmentStore';
import { DownloadStatusStoreProvider } from '../stores/downloadStatusStore';
import { SettingsStoreProvider } from '../stores/settingsStore';
import { useEnvironmentStore } from '../stores/environmentStore';
import { ApiService } from '../services/api';
import { ErrorBoundary } from './ErrorBoundary';
import { DownloadsPanel } from './DownloadsPanel';

function AppContent() {
  type PendingNexusRuntimeSelection = {
    nxmUrl: string;
    kind: 'library' | 'install';
    modId?: number;
    fileId?: number;
    modName?: string;
    fileName?: string;
    version?: string;
  };
  type LibraryFocusRequest = {
    storageId: string;
    modTag: string;
    requestId: number;
  };
  type WorkspaceEntry = {
    key: string;
    route: WorkspaceRoute;
    libraryState?: ModLibraryNavigationState;
    modsState?: ModsOverlayNavigationState;
    libraryFocusRequest?: LibraryFocusRequest | null;
  };

  const appWindow = getCurrentWindow();
  const { environments } = useEnvironmentStore();
  const workspaceIdRef = useRef(0);
  const libraryFocusRequestIdRef = useRef(0);
  const createWorkspaceEntry = useCallback((route: WorkspaceRoute, seed?: Partial<WorkspaceEntry>): WorkspaceEntry => ({
    key: `workspace-${workspaceIdRef.current++}`,
    route,
    libraryState: seed?.libraryState,
    modsState: seed?.modsState,
    libraryFocusRequest: seed?.libraryFocusRequest ?? null,
  }), []);
  const [workspaceStack, setWorkspaceStack] = useState<WorkspaceEntry[]>(() => [
    createWorkspaceEntry({ view: 'home' }),
  ]);
  const [showStartupSplash, setShowStartupSplash] = useState(true);
  const [isMaximized, setIsMaximized] = useState(false);
  const [lastEnvironmentWorkspaceView, setLastEnvironmentWorkspaceView] = useState<'mods' | 'plugins' | 'userLibs' | 'logs' | 'config'>('mods');
  const completedNexusCallbackRef = useRef<string | null>(null);
  const inFlightNexusCallbackRef = useRef<string | null>(null);
  const completedNxmCallbackRef = useRef(new Set<string>());
  const inFlightNxmCallbackRef = useRef<string | null>(null);
  const [pendingNexusRuntimeSelection, setPendingNexusRuntimeSelection] = useState<PendingNexusRuntimeSelection | null>(null);
  const [appNotice, setAppNotice] = useState<string | null>(null);
  const activeEntry = workspaceStack[workspaceStack.length - 1];
  const activeWorkspace = activeEntry.route;
  const canGoBack = workspaceStack.length > 1;

  const isSameWorkspaceRoute = useCallback((a: WorkspaceRoute, b: WorkspaceRoute): boolean => {
    if (a.view !== b.view) {
      return false;
    }
    if ('environmentId' in a || 'environmentId' in b) {
      return 'environmentId' in a
        && 'environmentId' in b
        && a.environmentId === b.environmentId
        && a.view === b.view
        && ('initialTab' in a ? a.initialTab : undefined) === ('initialTab' in b ? b.initialTab : undefined);
    }
    if (a.view === 'library' && b.view === 'library') {
      return a.initialTab === b.initialTab;
    }
    return true;
  }, []);

  const pushWorkspace = useCallback((route: Exclude<WorkspaceRoute, { view: 'home' }>, seed?: Partial<WorkspaceEntry>) => {
    setWorkspaceStack((previous) => {
      const current = previous[previous.length - 1];
      if (current && isSameWorkspaceRoute(current.route, route) && !seed?.libraryFocusRequest) {
        return previous;
      }
      return [...previous, createWorkspaceEntry(route, seed)];
    });
  }, [createWorkspaceEntry, isSameWorkspaceRoute]);

  const replaceWorkspace = useCallback((route: WorkspaceRoute, seed?: Partial<WorkspaceEntry>) => {
    setWorkspaceStack((previous) => {
      const next = [...previous];
      next[next.length - 1] = createWorkspaceEntry(route, seed);
      return next;
    });
  }, [createWorkspaceEntry]);

  const popWorkspace = useCallback(() => {
    setWorkspaceStack((previous) => {
      if (previous.length <= 1) {
        return previous;
      }
      return previous.slice(0, -1);
    });
  }, []);

  const goHome = useCallback(() => {
    setWorkspaceStack((previous) => {
      const homeEntry = previous.find((entry) => entry.route.view === 'home');
      return [homeEntry ?? createWorkspaceEntry({ view: 'home' })];
    });
  }, [createWorkspaceEntry]);

  const updateWorkspaceEntry = useCallback((key: string, updater: (entry: WorkspaceEntry) => WorkspaceEntry) => {
    setWorkspaceStack((previous) => previous.map((entry) => entry.key === key ? updater(entry) : entry));
  }, []);

  const openWorkspace = useCallback((workspace: Exclude<WorkspaceRoute, { view: 'home' }>) => {
    pushWorkspace(workspace);
  }, [pushWorkspace]);

  const openLibraryFromLogs = useCallback((focus: { storageId: string; modTag: string }) => {
    const requestId = ++libraryFocusRequestIdRef.current;
    pushWorkspace(
      { view: 'library', initialTab: 'library' },
      {
        libraryState: { libraryTab: 'library' },
        libraryFocusRequest: {
          storageId: focus.storageId,
          modTag: focus.modTag,
          requestId,
        },
      },
    );
  }, [pushWorkspace]);

  const getEnvironmentById = useCallback((environmentId: string) => {
    return environments.find((env) => env.id === environmentId) ?? null;
  }, [environments]);

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
    setWorkspaceStack((previous) => {
      const next = [...previous];
      const current = next[next.length - 1];
      if (!current) {
        return previous;
      }

      if (!('environmentId' in current.route)) {
        next[next.length - 1] = {
          ...current,
          route: {
            view: lastEnvironmentWorkspaceView,
            environmentId,
          },
        };
        return next;
      }

      next[next.length - 1] = {
        ...current,
        route: {
          ...current.route,
          environmentId,
        },
      };
      return next;
    });
  }, [lastEnvironmentWorkspaceView]);

  const handleInitialDetectionComplete = useCallback(() => {
    setShowStartupSplash(false);
  }, []);

  // Discord Rich Presence - automatically initializes and sets presence
  useDiscordPresence();

  // Check if SIMM directory was just created on app launch
  useEffect(() => {
    const checkWelcome = async () => {
      try {
        const wasCreated = await invoke<boolean>('was_simm_directory_just_created');
        if (wasCreated) {
          pushWorkspace({ view: 'welcome' });
        }
      } catch (error) {
        console.error('Failed to check if SIMM directory was created:', error);
      }
    };
    checkWelcome();
  }, [pushWorkspace]);

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

  const dispatchNexusOAuthResult = useCallback((detail: { success: boolean; error?: string }) => {
    window.dispatchEvent(new CustomEvent('nexus-oauth-result', { detail }));
  }, []);

  const dispatchNexusManualDownloadResult = useCallback((detail: {
    success: boolean;
    result?: {
      kind?: 'library' | 'install';
      requestedKind?: 'library' | 'install';
      environmentId?: string;
      storageId?: string;
      modId?: number;
      fileId?: number;
    };
    requestedKind?: 'library' | 'install';
    error?: string;
    nxmUrl?: string;
  }) => {
    window.dispatchEvent(new CustomEvent('nexus-manual-download-result', { detail }));
  }, []);

  useEffect(() => {
    if (!appNotice) {
      return;
    }
    const timer = window.setTimeout(() => {
      setAppNotice(null);
    }, 6000);
    return () => window.clearTimeout(timer);
  }, [appNotice]);

  const handleNexusOAuthCallback = useCallback(async (callbackUrl: string) => {
    if (!callbackUrl.startsWith('simm://oauth/nexus/callback')) {
      return;
    }

    if (
      completedNexusCallbackRef.current === callbackUrl ||
      inFlightNexusCallbackRef.current === callbackUrl
    ) {
      return;
    }
    inFlightNexusCallbackRef.current = callbackUrl;

    pushWorkspace({ view: 'accounts' });

    try {
      const result = await ApiService.completeNexusOAuthCallback(callbackUrl);
      if (!result.success) {
        dispatchNexusOAuthResult({
          success: false,
          error: 'Failed to complete Nexus OAuth login',
        });
        return;
      }
      completedNexusCallbackRef.current = callbackUrl;
      dispatchNexusOAuthResult({ success: true });
    } catch (error) {
      dispatchNexusOAuthResult({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to complete Nexus OAuth login',
      });
      return;
    } finally {
      inFlightNexusCallbackRef.current = null;
    }
  }, [dispatchNexusOAuthResult]);

  const handleNexusManualDownloadCallback = useCallback(async (nxmUrl: string) => {
    if (!nxmUrl.startsWith('nxm://')) {
      return;
    }

    if (
      completedNxmCallbackRef.current.has(nxmUrl) ||
      inFlightNxmCallbackRef.current === nxmUrl
    ) {
      return;
    }

    inFlightNxmCallbackRef.current = nxmUrl;

    try {
      const result = await ApiService.completeNexusManualDownloadSession(nxmUrl);
      if (result.runtimeSelectionRequired) {
        setPendingNexusRuntimeSelection({
          nxmUrl,
          kind: result.kind || 'library',
          modId: result.modId,
          fileId: result.fileId,
          modName: result.modName,
          fileName: result.fileName,
          version: result.version,
        });
        return;
      }
      if (!result.success) {
        dispatchNexusManualDownloadResult({
          success: false,
          error: result.error || 'Failed to complete Nexus manual download',
          requestedKind: result.requestedKind,
          nxmUrl,
        });
        return;
      }
      completedNxmCallbackRef.current.add(nxmUrl);
      dispatchNexusManualDownloadResult({
        success: true,
        result,
        requestedKind: result.requestedKind,
        nxmUrl,
      });
    } catch (error) {
      console.error('Failed to complete Nexus manual download callback:', nxmUrl, error);
      const message = error instanceof Error ? error.message : 'Failed to complete Nexus manual download';
      if (message.includes('Close SIMM to download Nexus mods for other games')) {
        setAppNotice(message);
      }
      dispatchNexusManualDownloadResult({
        success: false,
        error: message,
        nxmUrl,
      });
      return;
    } finally {
      inFlightNxmCallbackRef.current = null;
    }
  }, [dispatchNexusManualDownloadResult]);

  const handleNexusRuntimeSelection = useCallback(async (runtime: 'IL2CPP' | 'Mono' | 'Both') => {
    const pending = pendingNexusRuntimeSelection;
    if (!pending) {
      return;
    }

    setPendingNexusRuntimeSelection(null);
    inFlightNxmCallbackRef.current = pending.nxmUrl;

    try {
      const result = await ApiService.completeNexusManualDownloadSession(pending.nxmUrl, runtime);
      if (!result.success) {
        dispatchNexusManualDownloadResult({
          success: false,
          error: result.error || 'Failed to complete Nexus manual download',
          requestedKind: result.requestedKind ?? pending.kind,
          nxmUrl: pending.nxmUrl,
        });
        return;
      }
      completedNxmCallbackRef.current.add(pending.nxmUrl);
      dispatchNexusManualDownloadResult({
        success: true,
        result,
        requestedKind: result.requestedKind ?? pending.kind,
        nxmUrl: pending.nxmUrl,
      });
    } catch (error) {
      console.error('Failed to complete Nexus manual download after runtime selection:', pending.nxmUrl, error);
      const message = error instanceof Error ? error.message : 'Failed to complete Nexus manual download';
      if (message.includes('Close SIMM to download Nexus mods for other games')) {
        setAppNotice(message);
      }
      dispatchNexusManualDownloadResult({
        success: false,
        error: message,
        nxmUrl: pending.nxmUrl,
      });
    } finally {
      inFlightNxmCallbackRef.current = null;
    }
  }, [dispatchNexusManualDownloadResult, pendingNexusRuntimeSelection]);

  const handleCancelNexusRuntimeSelection = useCallback(async () => {
    setPendingNexusRuntimeSelection(null);
    try {
      await ApiService.cancelNexusManualDownloadSession();
    } catch (error) {
      console.error('Failed to cancel Nexus manual download session:', error);
    }
  }, []);

  const handleExternalProtocolUrl = useCallback(async (url: string) => {
    if (url.startsWith('simm://oauth/nexus/callback')) {
      await handleNexusOAuthCallback(url);
      return;
    }

    if (url.startsWith('nxm://')) {
      await handleNexusManualDownloadCallback(url);
    }
  }, [handleNexusManualDownloadCallback, handleNexusOAuthCallback]);

  useEffect(() => {
    let unlistenDeepLink: (() => void) | null = null;
    let unlistenSingleInstance: (() => void) | null = null;
    let cancelled = false;

    const processPendingDeepLinks = async () => {
      const currentUrls = await getCurrentDeepLink();
      if (!cancelled && currentUrls?.length) {
        for (const url of currentUrls) {
          void handleExternalProtocolUrl(url);
        }
      }
    };

    const initDeepLinkHandling = async () => {
      try {
        await processPendingDeepLinks();

        unlistenDeepLink = await onOpenUrl((urls) => {
          for (const url of urls) {
            void handleExternalProtocolUrl(url);
          }
        });

        unlistenSingleInstance = await listen<{ args?: string[] }>('single-instance-args', (event) => {
          const args = event.payload?.args || [];
          for (const arg of args) {
            if (typeof arg === 'string' && (arg.startsWith('simm://') || arg.startsWith('nxm://'))) {
              void handleExternalProtocolUrl(arg);
            }
          }
        });
      } catch (error) {
        console.error('Failed to initialize deep-link handling:', error);
        dispatchNexusOAuthResult({
          success: false,
          error: error instanceof Error ? error.message : 'Failed to initialize deep-link handling',
        });
      }
    };

    void initDeepLinkHandling();

    const handleWindowFocus = () => {
      void processPendingDeepLinks().catch((error) => {
        console.error('Failed to re-check deep links after focus:', error);
      });
    };
    window.addEventListener('focus', handleWindowFocus);

    return () => {
      cancelled = true;
      window.removeEventListener('focus', handleWindowFocus);
      unlistenDeepLink?.();
      unlistenSingleInstance?.();
    };
  }, [dispatchNexusOAuthResult, handleExternalProtocolUrl]);

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

  const renderWorkspacePanelFor = useCallback((entry: WorkspaceEntry, onCloseHandler: () => void) => {
    const workspace = entry.route;
    switch (workspace.view) {
      case 'library':
        return (
          <ModLibraryOverlay
            isOpen={true}
            onClose={onCloseHandler}
            focusStorageId={entry.libraryFocusRequest?.storageId ?? null}
            focusRequestId={entry.libraryFocusRequest?.requestId}
            focusModTag={entry.libraryFocusRequest?.modTag ?? null}
            navigationState={entry.libraryState ?? (workspace.initialTab ? {
              libraryTab: workspace.initialTab,
            } : undefined)}
            onNavigationStateChange={(navigationState) => {
              updateWorkspaceEntry(entry.key, (current) => ({
                ...current,
                libraryState: navigationState,
              }));
            }}
            onOpenAccounts={() => pushWorkspace({ view: 'accounts' })}
          />
        );
      case 'wizard':
        return <EnvironmentCreationWizard onClose={onCloseHandler} />;
      case 'accounts':
        return <SteamAccountOverlay isOpen={true} onClose={onCloseHandler} />;
      case 'help':
        return (
          <HelpOverlay
            isOpen={true}
            onClose={onCloseHandler}
            onOpenWizard={() => openWorkspace({ view: 'wizard' })}
            onOpenSettings={() => openWorkspace({ view: 'settings' })}
            onOpenAccounts={() => openWorkspace({ view: 'accounts' })}
          />
        );
      case 'settings':
        return <Settings isOpen={true} onClose={onCloseHandler} />;
      case 'welcome':
        return (
          <WelcomeOverlay
            isOpen={true}
            onClose={onCloseHandler}
            onOpenWizard={() => openWorkspace({ view: 'wizard' })}
            onOpenSettings={() => openWorkspace({ view: 'settings' })}
          />
        );
      case 'mods':
        return 'environmentId' in workspace ? (
          <ModsOverlay
            isOpen={true}
            onClose={onCloseHandler}
            environmentId={workspace.environmentId}
            navigationState={entry.modsState ?? (workspace.initialTab ? {
              modsTab: workspace.initialTab,
            } : undefined)}
            onNavigationStateChange={(navigationState) => {
              updateWorkspaceEntry(entry.key, (current) => ({
                ...current,
                modsState: navigationState,
              }));
            }}
            onOpenAccounts={() => pushWorkspace({ view: 'accounts' })}
            onOpenModLibrary={() => pushWorkspace({ view: 'library' })}
            onOpenConfig={() => pushWorkspace({ view: 'config', environmentId: workspace.environmentId })}
            onModUpdatesChecked={(count) => {
              window.dispatchEvent(new CustomEvent('mod-updates-checked', { detail: { environmentId: workspace.environmentId, count } }));
            }}
          />
        ) : null;
      case 'plugins':
        return 'environmentId' in workspace ? (
          <PluginsOverlay
            isOpen={true}
            onClose={onCloseHandler}
            environmentId={workspace.environmentId}
          />
        ) : null;
      case 'userLibs':
        return 'environmentId' in workspace ? (
          <UserLibsOverlay
            isOpen={true}
            onClose={onCloseHandler}
            environmentId={workspace.environmentId}
          />
        ) : null;
      case 'logs':
        return 'environmentId' in workspace && getEnvironmentById(workspace.environmentId) ? (
          <LogsOverlay
            isOpen={true}
            onClose={onCloseHandler}
            environmentId={workspace.environmentId}
            environment={getEnvironmentById(workspace.environmentId)!}
            onOpenModLibraryView={openLibraryFromLogs}
          />
        ) : null;
      case 'config':
        return 'environmentId' in workspace && getEnvironmentById(workspace.environmentId) ? (
          <ConfigurationOverlay
            isOpen={true}
            onClose={onCloseHandler}
            environmentId={workspace.environmentId}
            environment={getEnvironmentById(workspace.environmentId)!}
          />
        ) : null;
      case 'home':
      default:
        return null;
    }
  }, [getEnvironmentById, openLibraryFromLogs, pushWorkspace, updateWorkspaceEntry]);

  const renderWorkspacePanel = () => {
    return renderWorkspacePanelFor(activeEntry, popWorkspace);
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
              onClick={() => openWorkspace({ view: 'library', initialTab: 'discover' })}
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
                  <div style={{ display: 'flex', gap: '0.65rem' }}>
                    <button
                      onClick={popWorkspace}
                      className="btn btn-secondary app-workspace-home-button"
                      disabled={!canGoBack}
                    >
                      <i className="fas fa-arrow-left"></i>
                      Back
                    </button>
                    <button onClick={goHome} className="btn btn-secondary app-workspace-home-button">
                      <i className="fas fa-house"></i>
                      Home
                    </button>
                  </div>
                  <EnvironmentList
                    compactMode={true}
                    activeWorkspace={activeWorkspace}
                    onSelectEnvironment={handleWorkspaceEnvironmentSelect}
                  />
                  <DownloadsPanel />
                </aside>
                <main className="app-main workspace-main app-workspace-main">
                  {renderWorkspacePanel()}
                </main>
              </div>
            )}
          </div>
        </div>

        <Footer onOpenModUpdates={() => pushWorkspace({ view: 'library', initialTab: 'updates' }, {
          libraryState: {
            libraryTab: 'updates',
          },
        })} />
      </div>

      {appNotice && (
        <div className="app-notice app-notice--danger" role="alert" aria-live="assertive">
          <div className="app-notice__header">
            <strong>Nexus Download Blocked</strong>
            <button
              type="button"
              className="window-control-btn app-notice__dismiss"
              onClick={() => setAppNotice(null)}
              aria-label="Dismiss notice"
            >
              <i className="fas fa-times"></i>
            </button>
          </div>
          <span className="app-notice__body">{appNotice}</span>
        </div>
      )}

      {pendingNexusRuntimeSelection && (
        <div className="modal-overlay" onClick={() => void handleCancelNexusRuntimeSelection()}>
          <div className="modal-content app-dialog app-dialog--message app-runtime-dialog" onClick={(event) => event.stopPropagation()}>
            <div className="modal-header">
              <h2>Select Runtime</h2>
              <button className="modal-close" onClick={() => void handleCancelNexusRuntimeSelection()}>×</button>
            </div>
            <div className="app-dialog__body app-runtime-dialog__body">
              <div className="app-dialog__callout app-dialog__callout--info">
                <div className="app-dialog__icon">
                  <i className="fas fa-microchip" aria-hidden="true"></i>
                </div>
                <div className="app-dialog__meta">
                  <strong>Runtime selection required</strong>
                  <p>
                    SIMM could not determine the runtime for this Nexus download. Choose the runtime before it is added to the library or installed.
                  </p>
                </div>
              </div>
              <div className="app-runtime-dialog__details">
                <span><strong>Mod:</strong> {pendingNexusRuntimeSelection.modName || 'Unknown Mod'}</span>
                <span><strong>File:</strong> {pendingNexusRuntimeSelection.fileName || 'Unknown File'}</span>
                {pendingNexusRuntimeSelection.version && (
                  <span><strong>Version:</strong> {pendingNexusRuntimeSelection.version}</span>
                )}
              </div>
            </div>
            <div className="app-dialog__footer">
              <div className="app-runtime-dialog__actions">
                <button className="btn btn-secondary" onClick={() => void handleCancelNexusRuntimeSelection()}>
                  Cancel
                </button>
                <div className="app-runtime-dialog__runtime-actions">
                  <button className="btn btn-secondary" onClick={() => void handleNexusRuntimeSelection('Mono')}>
                    Use Mono
                  </button>
                  <button className="btn btn-secondary" onClick={() => void handleNexusRuntimeSelection('Both')}>
                    Use Both
                  </button>
                  <button className="btn btn-primary" onClick={() => void handleNexusRuntimeSelection('IL2CPP')}>
                    Use IL2CPP
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {showStartupSplash && (
        <div className="boot-screen-shell">
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
          <DownloadStatusStoreProvider>
            <AppContent />
          </DownloadStatusStoreProvider>
        </EnvironmentStoreProvider>
      </SettingsStoreProvider>
    </ErrorBoundary>
  );
}
