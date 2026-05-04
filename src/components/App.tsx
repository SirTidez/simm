import {
  Suspense,
  lazy,
  startTransition,
  useState,
  useEffect,
  useCallback,
  useRef,
} from 'react';
import type { ComponentType } from 'react';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { getCurrent as getCurrentDeepLink, onOpenUrl } from '@tauri-apps/plugin-deep-link';
import { confirm, message } from '@tauri-apps/plugin-dialog';
import { relaunch } from '@tauri-apps/plugin-process';
import { EnvironmentList, type WorkspaceRoute } from './EnvironmentList';
import { useDiscordPresence } from '../hooks/useDiscordPresence';
import appIcon256 from '../assets/app-icon-256.png';
import { AppUpdateToast } from './AppUpdateToast';
import { Footer } from './Footer';
import { EnvironmentStoreProvider } from '../stores/environmentStore';
import { DownloadStatusStoreProvider } from '../stores/downloadStatusStore';
import { SettingsStoreProvider, useSettingsStore } from '../stores/settingsStore';
import { useEnvironmentStore } from '../stores/environmentStore';
import { ApiService } from '../services/api';
import { logger } from '../services/logger';
import {
  buildSetupGuideSettings,
  resolveExperienceMode,
  settingsNeedUpgradeSetupPrompt,
} from '../utils/uxSettings';
import type {
  ExperienceMode,
  AppUpdateChannel,
  AppUpdatePreferences,
  AppUpdateStatus,
} from '../types';
import { ErrorBoundary } from './ErrorBoundary';
import { DownloadsPanel } from './DownloadsPanel';
import { Icon } from './Icon';
import type { ModLibraryNavigationState } from './ModLibraryOverlay';
import type { ModsOverlayNavigationState } from './ModsOverlay';
import type { SecurityReportWorkspaceRequest } from './SecurityScanReportPage';

const APP_UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

const lazyNamed = <T,>(
  loader: () => Promise<T>,
  select: (module: T) => ComponentType<any>,
) => lazy(async () => ({
  default: select(await loader()),
}));

const EnvironmentCreationWizard = lazyNamed(
  () => import('./EnvironmentCreationWizard'),
  (module) => module.EnvironmentCreationWizard,
);
const ModLibraryOverlay = lazyNamed(
  () => import('./ModLibraryOverlay'),
  (module) => module.ModLibraryOverlay,
);
const Settings = lazyNamed(
  () => import('./Settings'),
  (module) => module.Settings,
);
const SteamAccountOverlay = lazyNamed(
  () => import('./SteamAccountOverlay'),
  (module) => module.SteamAccountOverlay,
);
const HelpOverlay = lazyNamed(
  () => import('./HelpOverlay'),
  (module) => module.HelpOverlay,
);
const WelcomeOverlay = lazyNamed(
  () => import('./WelcomeOverlay'),
  (module) => module.WelcomeOverlay,
);
const ModsOverlay = lazyNamed(
  () => import('./ModsOverlay'),
  (module) => module.ModsOverlay,
);
const PluginsOverlay = lazyNamed(
  () => import('./PluginsOverlay'),
  (module) => module.PluginsOverlay,
);
const UserLibsOverlay = lazyNamed(
  () => import('./UserLibsOverlay'),
  (module) => module.UserLibsOverlay,
);
const LogsOverlay = lazyNamed(
  () => import('./LogsOverlay'),
  (module) => module.LogsOverlay,
);
const ConfigurationOverlay = lazyNamed(
  () => import('./ConfigurationOverlay'),
  (module) => module.ConfigurationOverlay,
);
const SecurityScanReportPage = lazyNamed(
  () => import('./SecurityScanReportPage'),
  (module) => module.SecurityScanReportPage,
);

function WorkspacePanelFallback() {
  return (
    <div className="workspace-panel-fallback" role="status" aria-live="polite">
      <div className="workspace-panel-fallback__header">
        <strong>Loading workspace panel...</strong>
        <span>Getting this workspace ready.</span>
      </div>
    </div>
  );
}

const normalizeVersionCore = (value: string) => {
  const match = value.trim().match(/\d+(?:\.\d+)*/i);
  return match?.[0] ?? value.trim();
};

const compareVersionCores = (left: string, right: string) => {
  const leftParts = normalizeVersionCore(left).split('.').filter(Boolean).map((segment) => Number(segment) || 0);
  const rightParts = normalizeVersionCore(right).split('.').filter(Boolean).map((segment) => Number(segment) || 0);
  const maxLength = Math.max(leftParts.length, rightParts.length);

  for (let index = 0; index < maxLength; index += 1) {
    const leftValue = leftParts[index] ?? 0;
    const rightValue = rightParts[index] ?? 0;
    if (leftValue > rightValue) {
      return 1;
    }
    if (leftValue < rightValue) {
      return -1;
    }
  }

  return 0;
};

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
    securityReportState?: SecurityReportWorkspaceRequest;
    welcomeMode?: 'setup' | 'upgradePrompt';
  };
  type AppUpdateState =
    | { status: 'idle' | 'checking' | 'upToDate' | 'error'; result: null }
    | { status: 'available'; result: AppUpdateStatus };

  const appWindow = getCurrentWindow();
  const { environments } = useEnvironmentStore();
  const { settings, updateSettings } = useSettingsStore();
  const workspaceIdRef = useRef(0);
  const libraryFocusRequestIdRef = useRef(0);
  const lastLibraryNavigationStateRef = useRef<ModLibraryNavigationState | undefined>(undefined);
  const createWorkspaceEntry = useCallback((route: WorkspaceRoute, seed?: Partial<WorkspaceEntry>): WorkspaceEntry => ({
    key: `workspace-${workspaceIdRef.current++}`,
    route,
    libraryState: seed?.libraryState,
    modsState: seed?.modsState,
    libraryFocusRequest: seed?.libraryFocusRequest ?? null,
    securityReportState: seed?.securityReportState,
    welcomeMode: seed?.welcomeMode,
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
  const [appUpdateState, setAppUpdateState] = useState<AppUpdateState>({ status: 'idle', result: null });
  const [dismissedAppUpdateVersion, setDismissedAppUpdateVersion] = useState<string | null>(null);
  const [installingAppUpdate, setInstallingAppUpdate] = useState(false);
  const appUpdateSettingsRef = useRef(settings?.appUpdate ?? null);
  const updateSettingsRef = useRef(updateSettings);
  const startupSetupCheckedRef = useRef(false);
  const hasSettings = settings !== null;
  const activeEntry = workspaceStack[workspaceStack.length - 1];
  const activeWorkspace = activeEntry.route;
  const canGoBack = workspaceStack.length > 1;
  const isToolbarWorkspaceActive = useCallback(
    (view: WorkspaceRoute['view']) => activeWorkspace.view === view,
    [activeWorkspace.view],
  );

  const isSameWorkspaceRoute = useCallback((a: WorkspaceRoute, b: WorkspaceRoute): boolean => {
    if (a.view !== b.view) {
      return false;
    }
    if (a.view === 'securityReport' && b.view === 'securityReport') {
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
    startTransition(() => {
      setWorkspaceStack((previous) => {
        const current = previous[previous.length - 1];
        if (current && isSameWorkspaceRoute(current.route, route) && !seed?.libraryFocusRequest) {
          if (!seed?.libraryState && !seed?.modsState && !seed?.securityReportState) {
            return previous;
          }
          return [
            ...previous.slice(0, -1),
            {
              ...current,
              route,
              libraryState: seed?.libraryState ?? current.libraryState,
              modsState: seed?.modsState ?? current.modsState,
              securityReportState: seed?.securityReportState ?? current.securityReportState,
            },
          ];
        }
        return [...previous, createWorkspaceEntry(route, seed)];
      });
    });
  }, [createWorkspaceEntry, isSameWorkspaceRoute]);

  const popWorkspace = useCallback(() => {
    startTransition(() => {
      setWorkspaceStack((previous) => {
        if (previous.length <= 1) {
          return previous;
        }
        return previous.slice(0, -1);
      });
    });
  }, []);

  const goHome = useCallback(() => {
    startTransition(() => {
      setWorkspaceStack((previous) => {
        const homeEntry = previous.find((entry) => entry.route.view === 'home');
        return [homeEntry ?? createWorkspaceEntry({ view: 'home' })];
      });
    });
  }, [createWorkspaceEntry]);

  const updateWorkspaceEntry = useCallback((key: string, updater: (entry: WorkspaceEntry) => WorkspaceEntry) => {
    setWorkspaceStack((previous) => previous.map((entry) => entry.key === key ? updater(entry) : entry));
  }, []);

  const openWorkspace = useCallback((workspace: Exclude<WorkspaceRoute, { view: 'home' }>) => {
    pushWorkspace(workspace);
  }, [pushWorkspace]);

  const openSecurityReportWorkspace = useCallback((reportState: SecurityReportWorkspaceRequest) => {
    pushWorkspace(
      { view: 'securityReport' },
      {
        securityReportState: reportState,
      },
    );
  }, [pushWorkspace]);

  const openLibraryWorkspace = useCallback((options?: {
    initialTab?: 'discover' | 'library' | 'updates';
    navigationState?: Partial<ModLibraryNavigationState>;
    focusRequest?: LibraryFocusRequest | null;
  }) => {
    const lastLibraryEntry = [...workspaceStack].reverse().find((entry) => entry.route.view === 'library');
    const persistedLibraryState = lastLibraryNavigationStateRef.current;
    const mergedNavigationState = (
      lastLibraryEntry?.libraryState
      || persistedLibraryState
      || options?.navigationState
      || options?.initialTab
    ) ? {
      ...(lastLibraryEntry?.libraryState ?? persistedLibraryState ?? {}),
      ...(options?.initialTab ? { libraryTab: options.initialTab } : {}),
      ...(options?.navigationState ?? {}),
    } : undefined;

    lastLibraryNavigationStateRef.current = mergedNavigationState;

    pushWorkspace(
      options?.initialTab ? { view: 'library', initialTab: options.initialTab } : { view: 'library' },
      {
        libraryState: mergedNavigationState,
        libraryFocusRequest: options?.focusRequest ?? null,
      },
    );
  }, [pushWorkspace, workspaceStack]);

  const openLibraryFromLogs = useCallback((focus: { storageId: string; modTag: string }) => {
    const requestId = ++libraryFocusRequestIdRef.current;
    openLibraryWorkspace({
      initialTab: 'library',
      navigationState: { libraryTab: 'library' },
      focusRequest: {
        storageId: focus.storageId,
        modTag: focus.modTag,
        requestId,
      },
    });
  }, [openLibraryWorkspace]);

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
    startTransition(() => {
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
    });
  }, [lastEnvironmentWorkspaceView]);

  const handleInitialDetectionComplete = useCallback(() => {
    setShowStartupSplash(false);
  }, []);

  // Discord Rich Presence - automatically initializes and sets presence
  useDiscordPresence();

  // Check if SIMM directory was just created on app launch
  useEffect(() => {
    if (!hasSettings || startupSetupCheckedRef.current) {
      return;
    }

    startupSetupCheckedRef.current = true;

    const checkWelcome = async () => {
      try {
        const startupState = await ApiService.getStartupState();
        const freshInstall = startupState.simmDirectoryCreated || startupState.databaseCreated;
        if (freshInstall || settings?.setupGuideCompleted === false) {
          pushWorkspace({ view: 'welcome' }, { welcomeMode: 'setup' });
          return;
        }

        if (settingsNeedUpgradeSetupPrompt(settings)) {
          pushWorkspace({ view: 'welcome' }, { welcomeMode: 'upgradePrompt' });
        }
      } catch (error) {
        console.error('Failed to check startup setup state:', error);
      }
    };
    checkWelcome();
  }, [hasSettings, pushWorkspace, settings]);

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

  useEffect(() => {
    appUpdateSettingsRef.current = settings?.appUpdate ?? null;
  }, [settings?.appUpdate]);

  useEffect(() => {
    updateSettingsRef.current = updateSettings;
  }, [updateSettings]);

  const persistAppUpdateSettings = useCallback(async (updates: Partial<AppUpdatePreferences>) => {
    const mergedSettings = {
      ...(appUpdateSettingsRef.current ?? {}),
      ...updates,
    };
    appUpdateSettingsRef.current = mergedSettings;
    await updateSettingsRef.current({
      appUpdate: mergedSettings,
    });
  }, []);

  const appUpdateChannel: AppUpdateChannel = settings?.appUpdate?.channel ?? 'beta';

  const completeSetupGuide = useCallback(async (mode: ExperienceMode) => {
    await updateSettings(buildSetupGuideSettings(mode));
  }, [updateSettings]);

  const skipSetupGuide = useCallback(async () => {
    await updateSettings({
      experienceMode: 'powerUser',
      showAdvancedGameTools: true,
      setupGuideCompleted: true,
    });
  }, [updateSettings]);

  useEffect(() => {
    if (!hasSettings || showStartupSplash) {
      return;
    }

    let cancelled = false;

    const runAppUpdateCheck = async () => {
      try {
        setAppUpdateState((previous) =>
          previous.status === 'available' ? previous : { status: 'checking', result: null },
        );

        const result = await ApiService.checkAppUpdate(appUpdateChannel);
        if (cancelled) {
          return;
        }

        const currentAppUpdateSettings = appUpdateSettingsRef.current ?? {};
        const expiredSnooze =
          !!currentAppUpdateSettings.snoozedUntil
          && Number.isFinite(Date.parse(currentAppUpdateSettings.snoozedUntil))
          && Date.parse(currentAppUpdateSettings.snoozedUntil) <= Date.now();
        const skippedVersionNormalized =
          currentAppUpdateSettings.skippedVersionNormalized
            && result.versionNormalized
            && currentAppUpdateSettings.skippedVersionNormalized !== result.versionNormalized
            && compareVersionCores(
              currentAppUpdateSettings.skippedVersionNormalized,
              result.versionNormalized,
            ) < 0
            ? null
            : currentAppUpdateSettings.skippedVersionNormalized ?? null;

        const nextSettings = {
          lastCheckedAt: result.checkedAt,
          lastSeenVersionRaw: result.version,
          lastSeenVersionNormalized: result.versionNormalized,
          lastResolvedUrl: result.manifestUrl,
          snoozedUntil: expiredSnooze ? null : (currentAppUpdateSettings.snoozedUntil ?? null),
          skippedVersionNormalized,
          channel: appUpdateChannel,
        };

        const previousSerialized = JSON.stringify({
          lastCheckedAt: currentAppUpdateSettings.lastCheckedAt ?? null,
          lastSeenVersionRaw: currentAppUpdateSettings.lastSeenVersionRaw ?? null,
          lastSeenVersionNormalized: currentAppUpdateSettings.lastSeenVersionNormalized ?? null,
          lastResolvedUrl: currentAppUpdateSettings.lastResolvedUrl ?? null,
          snoozedUntil: currentAppUpdateSettings.snoozedUntil ?? null,
          skippedVersionNormalized: currentAppUpdateSettings.skippedVersionNormalized ?? null,
          channel: currentAppUpdateSettings.channel ?? null,
        });
        const nextSerialized = JSON.stringify(nextSettings);
        if (previousSerialized !== nextSerialized) {
          void persistAppUpdateSettings(nextSettings).catch((error) => {
            logger.warn('Failed to persist app update settings', error);
          });
        }

        setDismissedAppUpdateVersion((previous) =>
          previous && previous !== result.versionNormalized ? null : previous,
        );
        setAppUpdateState(result.updateAvailable
          ? { status: 'available', result }
          : { status: 'upToDate', result: null });
      } catch (error) {
        logger.warn('Failed to check for SIMM app updates', error);
        if (!cancelled) {
          setAppUpdateState((previous) => (
            previous.status === 'idle' || previous.status === 'checking'
              ? { status: 'error', result: null }
              : previous
          ));
        }
      }
    };

    void runAppUpdateCheck();
    const intervalId = window.setInterval(() => {
      void runAppUpdateCheck();
    }, APP_UPDATE_CHECK_INTERVAL_MS);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [appUpdateChannel, hasSettings, persistAppUpdateSettings, showStartupSplash]);

  const handleSkipAppUpdateVersion = useCallback(() => {
    if (appUpdateState.status !== 'available') {
      return;
    }
    const latestVersionNormalized = appUpdateState.result.versionNormalized;
    setDismissedAppUpdateVersion(latestVersionNormalized);
    void persistAppUpdateSettings({
      skippedVersionNormalized: latestVersionNormalized,
      snoozedUntil: null,
    }).catch((error) => {
      logger.warn('Failed to persist skipped app update version', error);
    });
  }, [appUpdateState, persistAppUpdateSettings]);

  const handleSnoozeAppUpdate = useCallback((days: number) => {
    if (appUpdateState.status !== 'available') {
      return;
    }
    const snoozedUntil = new Date(Date.now() + (days * 24 * 60 * 60 * 1000)).toISOString();
    setDismissedAppUpdateVersion(appUpdateState.result.versionNormalized);
    void persistAppUpdateSettings({
      snoozedUntil,
    }).catch((error) => {
      logger.warn('Failed to persist app update snooze state', error);
    });
  }, [appUpdateState, persistAppUpdateSettings]);

  const handleInstallAppUpdate = useCallback(async () => {
    if (appUpdateState.status !== 'available' || installingAppUpdate) {
      return;
    }

    const releaseChannelLabel = appUpdateState.result.channel === 'beta' ? 'beta' : 'stable';
    const shouldInstall = await confirm(
      `Download and install SIMM ${appUpdateState.result.version} from the ${releaseChannelLabel} channel now?`,
      {
        title: 'Install SIMM Update',
        kind: 'info',
        okLabel: 'Install',
        cancelLabel: 'Cancel',
      },
    );

    if (!shouldInstall) {
      return;
    }

    try {
      setInstallingAppUpdate(true);
      const installResult = await ApiService.installAppUpdate(appUpdateState.result.channel);
      if (!installResult.installed) {
        throw new Error('Updater did not install an update.');
      }

      await relaunch();
    } catch (error) {
      logger.error('Failed to install SIMM app update', error);
      await message(
        error instanceof Error ? error.message : 'Failed to install the SIMM update.',
        {
          title: 'Update Failed',
          kind: 'error',
        },
      );
    } finally {
      setInstallingAppUpdate(false);
    }
  }, [appUpdateState, installingAppUpdate]);

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
        completedNxmCallbackRef.current.add(nxmUrl);
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
      completedNxmCallbackRef.current.add(nxmUrl);
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
        completedNxmCallbackRef.current.add(pending.nxmUrl);
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
      completedNxmCallbackRef.current.add(pending.nxmUrl);
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
            onNavigationStateChange={(navigationState: ModLibraryNavigationState) => {
              lastLibraryNavigationStateRef.current = navigationState;
              updateWorkspaceEntry(entry.key, (current) => ({
                ...current,
                libraryState: navigationState,
              }));
            }}
            onOpenAccounts={() => pushWorkspace({ view: 'accounts' })}
            onOpenSecurityReport={openSecurityReportWorkspace}
          />
        );
      case 'securityReport':
        return entry.securityReportState ? (
          <SecurityScanReportPage
            title={entry.securityReportState.title}
            report={entry.securityReportState.report}
            reportOptions={entry.securityReportState.reportOptions}
            confirmLabel={entry.securityReportState.confirmLabel}
            onConfirm={entry.securityReportState.onConfirm}
            onDismiss={entry.securityReportState.onDismiss}
            onReturn={onCloseHandler}
          />
        ) : null;
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
        return (
          <Settings
            isOpen={true}
            onClose={onCloseHandler}
            onRunSetupGuide={() => pushWorkspace({ view: 'welcome' }, { welcomeMode: 'setup' })}
          />
        );
      case 'welcome':
        return (
          <WelcomeOverlay
            isOpen={true}
            onClose={onCloseHandler}
            onOpenWizard={() => openWorkspace({ view: 'wizard' })}
            onOpenSettings={() => openWorkspace({ view: 'settings' })}
            onOpenAccounts={() => openWorkspace({ view: 'accounts' })}
            mode={entry.welcomeMode ?? 'setup'}
            initialExperienceMode={resolveExperienceMode(settings)}
            onFinishSetup={completeSetupGuide}
            onSkipSetup={skipSetupGuide}
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
            onNavigationStateChange={(navigationState: ModsOverlayNavigationState) => {
              updateWorkspaceEntry(entry.key, (current) => ({
                ...current,
                modsState: navigationState,
              }));
            }}
            onOpenAccounts={() => pushWorkspace({ view: 'accounts' })}
            onOpenModLibrary={() => openLibraryWorkspace()}
            onOpenConfig={() => pushWorkspace({ view: 'config', environmentId: workspace.environmentId })}
            onOpenSecurityReport={openSecurityReportWorkspace}
            onModUpdatesChecked={(count: number) => {
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
  }, [completeSetupGuide, getEnvironmentById, openLibraryFromLogs, openLibraryWorkspace, openSecurityReportWorkspace, pushWorkspace, settings, skipSetupGuide, updateWorkspaceEntry]);

  const renderWorkspacePanel = () => {
    return renderWorkspacePanelFor(activeEntry, popWorkspace);
  };

  const renderWorkspaceSidebar = (showNavigationControls: boolean) => {
    const selectedEnvironmentId =
      'environmentId' in activeWorkspace
        ? activeWorkspace.environmentId
        : null;
    const sortedEnvironments = [...environments].sort((a, b) => a.name.localeCompare(b.name));

    return (
      <aside className="workspace-sidebar">
        {showNavigationControls && (
          <div className="workspace-sidebar__nav">
            <button
              onClick={popWorkspace}
              className="btn btn-secondary app-workspace-home-button"
              disabled={!canGoBack}
            >
              <Icon name="arrowLeft" />
              Back
            </button>
            <button onClick={goHome} className="btn btn-secondary app-workspace-home-button">
              <Icon name="house" />
              Home
            </button>
          </div>
        )}

        <div className="workspace-environment-sidebar">
          <h3 className="workspace-environment-sidebar__title">Environments</h3>
          <p className="workspace-environment-sidebar__copy">
            Select an environment to open its active tools workspace.
          </p>
          <div className="workspace-environment-sidebar__list">
            {sortedEnvironments.length > 0 ? (
              sortedEnvironments.map((env) => (
                <div key={env.id} className="workspace-environment-sidebar__item">
                  <button
                    onClick={() => {
                      localStorage.setItem('simm:lastEnvId', env.id);
                      handleWorkspaceEnvironmentSelect(env.id);
                    }}
                    className={`workspace-environment-sidebar__button ${selectedEnvironmentId === env.id ? 'workspace-environment-sidebar__button--active' : ''}`}
                    title={env.name}
                    aria-current={selectedEnvironmentId === env.id ? 'page' : undefined}
                  >
                    <span className="workspace-environment-sidebar__button-label">{env.name}</span>
                  </button>
                </div>
              ))
            ) : (
              <div className="workspace-environment-sidebar__empty">No game installs yet.</div>
            )}
          </div>
        </div>

        <DownloadsPanel />
      </aside>
    );
  };

  const appUpdatePreferences = settings?.appUpdate ?? null;
  const appUpdateSnoozedUntil = appUpdatePreferences?.snoozedUntil
    && Number.isFinite(Date.parse(appUpdatePreferences.snoozedUntil))
    ? Date.parse(appUpdatePreferences.snoozedUntil)
    : null;
  const isAppUpdateSnoozed = appUpdateState.status === 'available'
    && appUpdateSnoozedUntil !== null
    && appUpdateSnoozedUntil > Date.now();
  const isAppUpdateSkipped = appUpdateState.status === 'available'
    && appUpdatePreferences?.skippedVersionNormalized === appUpdateState.result.versionNormalized;
  const isAppUpdateDismissedForSession = appUpdateState.status === 'available'
    && dismissedAppUpdateVersion === appUpdateState.result.versionNormalized;
  const showAppUpdateToast = appUpdateState.status === 'available'
    && !isAppUpdateSnoozed
    && !isAppUpdateSkipped
    && !isAppUpdateDismissedForSession;

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
              onClick={() => openLibraryWorkspace()}
              className={`btn btn-secondary btn-small app-shell-toolbar-button${isToolbarWorkspaceActive('library') ? ' app-shell-toolbar-button--active' : ''}`}
              title="Open Mod Library"
              aria-pressed={isToolbarWorkspaceActive('library')}
            >
              <Icon name="layerGroup" />
              Mod Library
            </button>
            <button
              onClick={() => openWorkspace({ view: 'wizard' })}
              className={`btn btn-primary btn-small app-shell-toolbar-button${isToolbarWorkspaceActive('wizard') ? ' app-shell-toolbar-button--active' : ''}`}
              title="Add or import a game install"
              aria-pressed={isToolbarWorkspaceActive('wizard')}
            >
              <Icon name="plus" />
              Add Game
            </button>
            <button
              onClick={() => openWorkspace({ view: 'accounts' })}
              className={`btn btn-secondary btn-small app-shell-toolbar-button${isToolbarWorkspaceActive('accounts') ? ' app-shell-toolbar-button--active' : ''}`}
              title="Manage connected accounts"
              aria-pressed={isToolbarWorkspaceActive('accounts')}
            >
              <Icon name="userCircle" />
              Accounts
            </button>
            <button
              onClick={() => openWorkspace({ view: 'help' })}
              className={`btn btn-secondary btn-small app-shell-toolbar-button${isToolbarWorkspaceActive('help') ? ' app-shell-toolbar-button--active' : ''}`}
              title="Open help and guides"
              aria-pressed={isToolbarWorkspaceActive('help')}
            >
              <Icon name="questionCircle" />
              Help
            </button>
            <button
              onClick={() => openWorkspace({ view: 'settings' })}
              className={`btn btn-secondary btn-small app-shell-toolbar-button${isToolbarWorkspaceActive('settings') ? ' app-shell-toolbar-button--active' : ''}`}
              title="Open settings"
              aria-pressed={isToolbarWorkspaceActive('settings')}
            >
              <Icon name="cog" />
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
              <Icon name="minus" />
            </button>
            <button
              onClick={handleToggleMaximize}
              className="window-control-btn"
              title={isMaximized ? 'Restore Down' : 'Maximize'}
              aria-label={isMaximized ? 'Restore Down' : 'Maximize'}
            >
              <Icon name={isMaximized ? 'windowRestore' : 'square'} />
            </button>
            <button
              onClick={handleCloseWindow}
              className="window-control-btn window-control-btn-close"
              title="Close"
              aria-label="Close"
            >
              <Icon name="times" />
            </button>
          </div>
        </header>

        <div className="app-body">
          <div className="app-content workspace-active">
            {activeWorkspace.view === 'home' ? (
              <div className="workspace-layout">
                {renderWorkspaceSidebar(false)}
                <main className="app-main app-home-main">
                  <EnvironmentList
                    onInitialDetectionComplete={handleInitialDetectionComplete}
                    onOpenWorkspace={openWorkspace}
                  />
                </main>
              </div>
            ) : (
              <div className="workspace-layout">
                {renderWorkspaceSidebar(true)}
                <main className="app-main workspace-main app-workspace-main">
                  <Suspense fallback={<WorkspacePanelFallback />}>
                    {renderWorkspacePanel()}
                  </Suspense>
                </main>
              </div>
            )}
          </div>
        </div>

        <Footer
          onOpenModUpdates={() => openLibraryWorkspace({
            initialTab: 'updates',
            navigationState: {
              libraryTab: 'updates',
            },
          })}
          appUpdateAvailable={appUpdateState.status === 'available'}
          onOpenAppUpdate={() => void handleInstallAppUpdate()}
        />
      </div>

      {showAppUpdateToast && appUpdateState.status === 'available' && (
        <AppUpdateToast
          currentVersion={appUpdateState.result.currentVersion}
          latestVersion={appUpdateState.result.version}
          onUpdate={() => void handleInstallAppUpdate()}
          onSkip={handleSkipAppUpdateVersion}
          onSnooze={handleSnoozeAppUpdate}
          onDismiss={() => setDismissedAppUpdateVersion(appUpdateState.result.versionNormalized)}
        />
      )}

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
              <Icon name="times" />
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
                  <Icon name="microchip" />
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
