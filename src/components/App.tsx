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
  Environment,
  ExperienceMode,
  AppUpdateChannel,
  AppUpdatePreferences,
  AppUpdateStatus,
} from '../types';
import { ErrorBoundary } from './ErrorBoundary';
import { Icon } from './Icon';
import type { ModLibraryNavigationState } from './ModLibraryOverlay';
import type { ModsOverlayNavigationState } from './ModsOverlay';
import type { SecurityReportWorkspaceRequest } from './SecurityScanReportPage';

const APP_UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const LAST_ENV_KEY = 'simm:lastEnvId';
const SIMM_RELEASES_URL = 'https://api.github.com/repos/SirTidez/simm/releases?per_page=4';
const SIMM_CHANGELOG_URL = 'https://raw.githubusercontent.com/SirTidez/simm/master/CHANGELOG.md';

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

function formatDashboardTime(value: string | number | undefined) {
  if (!value) return 'Not checked yet';
  const date = typeof value === 'number'
    ? new Date(value > 1_000_000_000_000 ? value : value * 1000)
    : new Date(value);

  if (Number.isNaN(date.getTime())) {
    return 'Not checked yet';
  }

  return date.toLocaleString();
}

type HomeFeedItem = {
  id: string;
  source: 'Release' | 'Changelog';
  title: string;
  detail?: string;
  bullets: string[];
  date?: string;
  url?: string;
};

type GitHubReleasePayload = {
  html_url?: string;
  name?: string | null;
  tag_name?: string;
  body?: string | null;
  published_at?: string | null;
  prerelease?: boolean;
};

function cleanFeedText(value: string | null | undefined): string {
  return (value ?? '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/\s+by\s+@\S+(?:\s+in\s*)?$/i, '')
    .replace(/\s+by\s+@\S+\s+in\s*$/i, '')
    .replace(/\s+in\s*$/i, '')
    .replace(/^#+\s*/gm, '')
    .replace(/^[-*]\s+/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function summarizeFeedText(value: string | null | undefined): string {
  const cleaned = cleanFeedText(value);
  if (!cleaned) return '';
  return cleaned.length > 132 ? `${cleaned.slice(0, 129).trimEnd()}...` : cleaned;
}

function formatFeedDate(value: string | undefined): string {
  if (!value) return 'Recent';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Recent';
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function normalizeReleaseTitle(value: string | null | undefined, tag: string | undefined): string {
  return (value?.trim() || tag || 'Release').replace(/^release\s+/i, '');
}

function extractReleaseBullets(body: string | null | undefined): string[] {
  if (!body) return [];

  return body
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^[-*]\s+/.test(line))
    .filter((line) => !/full changelog/i.test(line))
    .map((line) => {
      const withoutMarker = line.replace(/^[-*]\s+/, '');
      const withoutVersionPrefix = withoutMarker.replace(/^\d+(?:\.\d+)+(?:-[\w.-]+)?\s*[-:]\s*/i, '');
      return summarizeFeedText(withoutVersionPrefix);
    })
    .filter((line) => line.length > 0)
    .slice(0, 2);
}

function extractChangelogBullets(body: string): string[] {
  const bullets: string[] = [];
  const lines = body.split(/\r?\n/);

  for (const line of lines) {
    if (/^\s*-\s+contributors\s*:/i.test(line)) break;
    if (/^\s+-\s+`/.test(line)) continue;
    if (!/^\s*-\s+/.test(line)) continue;

    const cleaned = summarizeFeedText(line.replace(/^\s*-\s+/, ''));
    if (cleaned) {
      bullets.push(cleaned);
    }
    if (bullets.length >= 2) break;
  }

  return bullets;
}

function parseChangelogFeed(markdown: string): HomeFeedItem[] {
  const sections: Array<{ version: string; body: string }> = [];
  const headingPattern = /^##\s+\[?([^\]\n]+)\]?\s*$/gm;
  const headings = [...markdown.matchAll(headingPattern)];

  for (let index = 0; index < headings.length; index += 1) {
    const heading = headings[index];
    const nextHeading = headings[index + 1];
    const bodyStart = (heading.index ?? 0) + heading[0].length;
    const bodyEnd = nextHeading?.index ?? markdown.length;
    sections.push({
      version: heading[1].trim(),
      body: markdown.slice(bodyStart, bodyEnd),
    });
  }

  return sections.slice(0, 2).map((section, index) => {
    const version = section.version;
    const body = section.body;
    const bullets = extractChangelogBullets(body);

    return {
      id: `changelog-${version}-${index}`,
      source: 'Changelog' as const,
      title: `SIMM ${version}`,
      detail: 'Project changelog',
      bullets,
      url: 'https://github.com/SirTidez/simm/blob/master/CHANGELOG.md',
    };
  }).filter((item) => item.bullets.length > 0);
}

async function loadHomeFeed(): Promise<HomeFeedItem[]> {
  if (typeof fetch !== 'function') {
    return [];
  }

  const [releaseResult, changelogResult] = await Promise.allSettled([
    fetch(SIMM_RELEASES_URL, { headers: { Accept: 'application/vnd.github+json' } }),
    fetch(SIMM_CHANGELOG_URL),
  ]);

  const feed: HomeFeedItem[] = [];

  if (releaseResult.status === 'fulfilled' && releaseResult.value.ok) {
    const releases = await releaseResult.value.json() as GitHubReleasePayload[];
    for (const release of releases) {
      const tag = release.tag_name ?? 'release';
      const bullets = extractReleaseBullets(release.body);
      if (bullets.length === 0) {
        continue;
      }
      feed.push({
        id: `release-${tag}`,
        source: 'Release',
        title: normalizeReleaseTitle(release.name, tag),
        detail: release.prerelease ? 'Beta release' : 'Stable release',
        bullets,
        date: release.published_at ?? undefined,
        url: release.html_url,
      });
      if (feed.filter((item) => item.source === 'Release').length >= 2) {
        break;
      }
    }
  }

  if (changelogResult.status === 'fulfilled' && changelogResult.value.ok) {
    const markdown = await changelogResult.value.text();
    feed.push(...parseChangelogFeed(markdown));
  }

  return feed.slice(0, 4);
}

function HomeDashboard({
  environments,
  downloadsInProgress,
  appUpdateState,
  onOpenEnvironments,
  onOpenModLibrary,
  onOpenModUpdates,
  onOpenWizard,
  onOpenSettings,
}: {
  environments: Environment[];
  downloadsInProgress: number;
  appUpdateState:
    | { status: 'idle' | 'checking' | 'upToDate' | 'error'; result: null }
    | { status: 'available'; result: AppUpdateStatus };
  onOpenEnvironments: () => void;
  onOpenModLibrary: () => void;
  onOpenModUpdates: () => void;
  onOpenWizard: () => void;
  onOpenSettings: () => void;
}) {
  const completed = environments.filter((env) => env.status === 'completed');
  const updateCount = completed.filter((env) => env.updateAvailable).length;
  const steamCount = completed.filter((env) => env.environmentType === 'Steam' || env.environmentType === 'steam' || env.id.startsWith('steam-')).length;
  const lastChecked = completed
    .map((env) => env.lastUpdateCheck)
    .filter((value): value is string | number => Boolean(value))
    .map((value) => ({
      raw: value,
      time: typeof value === 'number'
        ? (value > 1_000_000_000_000 ? value : value * 1000)
        : Date.parse(value),
    }))
    .filter((entry) => Number.isFinite(entry.time))
    .sort((a, b) => b.time - a.time)[0]?.raw;
  const primaryEnvironment = completed.find((env) => env.updateAvailable) ?? completed[0] ?? environments[0] ?? null;
  const [feedItems, setFeedItems] = useState<HomeFeedItem[]>([]);
  const [feedStatus, setFeedStatus] = useState<'loading' | 'ready' | 'empty'>('loading');

  useEffect(() => {
    let cancelled = false;

    const loadFeed = async () => {
      setFeedStatus('loading');
      try {
        const items = await loadHomeFeed();
        if (cancelled) return;
        setFeedItems(items);
        setFeedStatus(items.length > 0 ? 'ready' : 'empty');
      } catch (error) {
        logger.warn('Failed to load home news feed', { error });
        if (!cancelled) {
          setFeedStatus('empty');
        }
      }
    };

    void loadFeed();

    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <section className="home-dashboard" aria-label="Home dashboard">
      <div className="home-dashboard__header">
        <div>
          <span className="workspace-eyebrow">Home</span>
          <h1>Welcome back to SIMM</h1>
          <p>Review install health, updates, and common mod manager actions from one desktop workspace.</p>
        </div>
        <div className="home-dashboard__header-actions">
          <button type="button" className="btn btn-primary" onClick={onOpenModLibrary} aria-label="Open Mod Library from dashboard">
            <Icon name="boxOpen" />
            Mod Library
          </button>
          <button type="button" className="btn btn-secondary" onClick={onOpenWizard}>
            <Icon name="plus" />
            Add Environment
          </button>
        </div>
      </div>

      <div className="home-dashboard__stats">
        <article className="home-dashboard__stat">
          <span>Installs</span>
          <strong>{completed.length}</strong>
          <small>{steamCount} Steam linked</small>
        </article>
        <article className="home-dashboard__stat">
          <span>Game Updates</span>
          <strong>{updateCount}</strong>
          <small>{updateCount > 0 ? 'Attention needed' : 'Everything current'}</small>
        </article>
        <article className="home-dashboard__stat">
          <span>Downloads</span>
          <strong>{downloadsInProgress}</strong>
          <small>{downloadsInProgress > 0 ? 'In progress' : 'Queue is clear'}</small>
        </article>
        <article className="home-dashboard__stat">
          <span>Last Check</span>
          <strong title={formatDashboardTime(lastChecked)}>{formatDashboardTime(lastChecked)}</strong>
          <small>Environment metadata</small>
        </article>
      </div>

      <div className="home-dashboard__layout">
        <section className="home-dashboard__panel home-dashboard__panel--wide">
          <div className="home-dashboard__panel-header">
            <div>
              <span className="workspace-eyebrow">Status</span>
              <h2>{updateCount > 0 ? 'Updates are waiting' : 'Your installs look ready'}</h2>
            </div>
            <button type="button" className="btn btn-secondary btn-small" onClick={onOpenEnvironments} aria-label="Open Environments from dashboard">
              <Icon name="hardDrive" />
              Environments
            </button>
          </div>
          <button
            type="button"
            className="home-dashboard__focus home-dashboard__focus--action"
            onClick={primaryEnvironment ? onOpenEnvironments : onOpenWizard}
            aria-label={primaryEnvironment ? `Open Environments for ${primaryEnvironment.name}` : 'Add an environment'}
          >
            <div>
              <strong>{primaryEnvironment?.name ?? 'No environments yet'}</strong>
              <p>
                {primaryEnvironment
                  ? `${primaryEnvironment.runtime} ${primaryEnvironment.currentGameVersion ?? primaryEnvironment.updateGameVersion ?? 'version unknown'} on ${primaryEnvironment.branch}.`
                  : 'Add or import a Schedule I install to start managing mods.'}
              </p>
            </div>
            {primaryEnvironment?.updateAvailable && (
              <span className="home-dashboard__badge home-dashboard__badge--warn">
                Update available
              </span>
            )}
          </button>
          <div className="home-dashboard__quick-grid">
            <button type="button" onClick={onOpenModUpdates}>
              <Icon name="arrowUp" />
              Mod Updates
            </button>
            <button type="button" onClick={onOpenModLibrary}>
              <Icon name="boxOpen" />
              Discover Mods
            </button>
            <button type="button" onClick={onOpenSettings}>
              <Icon name="sliders" />
              Preferences
            </button>
          </div>
        </section>

        <aside className="home-dashboard__panel home-dashboard__feed" aria-label="News and changes">
          <div className="home-dashboard__panel-header">
            <div>
              <span className="workspace-eyebrow">Updates</span>
              <h2>News & Changes</h2>
            </div>
          </div>
          <div className="home-dashboard__feed-list">
            {appUpdateState.status === 'available' && (
              <article className="home-dashboard__feed-item home-dashboard__feed-item--action">
                <span>{appUpdateState.result.channel} channel</span>
                <strong>SIMM {appUpdateState.result.version} is available</strong>
                <p>{summarizeFeedText(appUpdateState.result.notes) || 'A new SIMM build is ready to install.'}</p>
              </article>
            )}

            {feedStatus === 'loading' && (
              <article className="home-dashboard__feed-item">
                <span>GitHub</span>
                <strong>Loading project updates</strong>
                <p>Checking recent releases and changelog entries.</p>
              </article>
            )}

            {feedStatus === 'empty' && (
              <article className="home-dashboard__feed-item">
                <span>Offline</span>
                <strong>Project feed unavailable</strong>
                <p>Recent SIMM releases and changelog entries will appear here when GitHub can be reached.</p>
              </article>
            )}

            {feedItems.map((item) => (
              <article className="home-dashboard__feed-item" key={item.id}>
                <span>{item.source}{item.date ? ` / ${formatFeedDate(item.date)}` : ''}</span>
                {item.url ? (
                  <a href={item.url} target="_blank" rel="noreferrer">{item.title}</a>
                ) : (
                  <strong>{item.title}</strong>
                )}
                {item.detail && <p>{item.detail}</p>}
                <ul className="home-dashboard__feed-points">
                  {item.bullets.map((bullet) => (
                    <li key={bullet}>{bullet}</li>
                  ))}
                </ul>
              </article>
            ))}
          </div>
        </aside>
      </div>
    </section>
  );
}

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
  const { environments, loading: environmentsLoading } = useEnvironmentStore();
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

  const handleInitialDetectionComplete = useCallback(() => {
    setShowStartupSplash(false);
  }, []);

  useEffect(() => {
    if (!environmentsLoading) {
      handleInitialDetectionComplete();
    }
  }, [environmentsLoading, handleInitialDetectionComplete]);

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
      case 'environments':
        return (
          <EnvironmentList
            onInitialDetectionComplete={handleInitialDetectionComplete}
            onOpenWorkspace={openWorkspace}
          />
        );
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
  }, [completeSetupGuide, getEnvironmentById, handleInitialDetectionComplete, openLibraryFromLogs, openLibraryWorkspace, openSecurityReportWorkspace, openWorkspace, pushWorkspace, settings, skipSetupGuide, updateWorkspaceEntry]);

  const renderWorkspacePanel = () => {
    return renderWorkspacePanelFor(activeEntry, popWorkspace);
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
  const currentEnvironmentId =
    'environmentId' in activeWorkspace
      ? activeWorkspace.environmentId
      : localStorage.getItem(LAST_ENV_KEY) ?? environments.find((env) => env.status === 'completed')?.id ?? environments[0]?.id ?? null;
  const downloadsInProgress = environments.filter((env) => env.status === 'downloading').length;
  const openEnvironmentsWorkspace = () => openWorkspace({ view: 'environments' });
  const openEnvironmentWorkspace = (view: 'mods' | 'plugins' | 'userLibs' | 'logs' | 'config') => {
    if (!currentEnvironmentId) {
      openWorkspace({ view: 'wizard' });
      return;
    }
    pushWorkspace({ view, environmentId: currentEnvironmentId });
  };
  const primaryNavItems = [
    {
      key: 'home',
      label: 'Home',
      icon: 'house',
      active: activeWorkspace.view === 'home',
      onClick: goHome,
    },
    {
      key: 'environments',
      label: 'Environments',
      icon: 'hardDrive',
      active: activeWorkspace.view === 'environments' || activeWorkspace.view === 'wizard',
      onClick: openEnvironmentsWorkspace,
    },
    {
      key: 'library',
      label: 'Mod Library',
      icon: 'boxOpen',
      active: activeWorkspace.view === 'library',
      onClick: () => openLibraryWorkspace(),
    },
    {
      key: 'mods',
      label: 'Installed Mods',
      icon: 'boxArchive',
      active: activeWorkspace.view === 'mods',
      onClick: () => openEnvironmentWorkspace('mods'),
    },
    {
      key: 'config',
      label: 'Config Files',
      icon: 'fileCode',
      active: activeWorkspace.view === 'config',
      onClick: () => openEnvironmentWorkspace('config'),
    },
    {
      key: 'logs',
      label: 'Logs',
      icon: 'fileLines',
      active: activeWorkspace.view === 'logs',
      onClick: () => openEnvironmentWorkspace('logs'),
    },
  ] as const;
  const secondaryNavItems = [
    {
      key: 'accounts',
      label: 'Accounts',
      icon: 'userCircle',
      active: activeWorkspace.view === 'accounts',
      onClick: () => openWorkspace({ view: 'accounts' }),
    },
    {
      key: 'help',
      label: 'Troubleshooting',
      icon: 'wrench',
      active: activeWorkspace.view === 'help',
      onClick: () => openWorkspace({ view: 'help' }),
    },
  ] as const;

  return (
    <div className="app app-desktop-shell">
      <div className="app-window">
        <header className="window-chrome">
          <div className="window-brand" data-tauri-drag-region>
            <img src={appIcon256} alt="SIMM" className="window-brand-icon" />
            <div className="window-brand-text">
              <strong>SIMM - Schedule I Mod Manager</strong>
            </div>
          </div>

          <div className="window-drag-region" data-tauri-drag-region aria-hidden="true" />

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
          <aside className="app-primary-nav" aria-label="Primary navigation">
            <div className="app-primary-nav__group">
              {primaryNavItems.map((item) => (
                <button
                  key={item.key}
                  type="button"
                  className={`app-primary-nav__item${item.active ? ' app-primary-nav__item--active' : ''}`}
                  onClick={item.onClick}
                  aria-current={item.active ? 'page' : undefined}
                >
                  <Icon name={item.icon} />
                  <span>{item.label}</span>
                </button>
              ))}
              <button
                type="button"
                className="app-primary-nav__item"
                onClick={goHome}
              >
                <Icon name="download" />
                <span>Downloads</span>
                <span className="app-primary-nav__badge">{downloadsInProgress}</span>
              </button>
            </div>
            <div className="app-primary-nav__group app-primary-nav__group--system">
              {secondaryNavItems.map((item) => (
                <button
                  key={item.key}
                  type="button"
                  className={`app-primary-nav__item${item.active ? ' app-primary-nav__item--active' : ''}`}
                  onClick={item.onClick}
                  aria-current={item.active ? 'page' : undefined}
                >
                  <Icon name={item.icon} />
                  <span>{item.label}</span>
                </button>
              ))}
            </div>
            <button
              type="button"
              className={`app-primary-nav__item app-primary-nav__item--settings${activeWorkspace.view === 'settings' ? ' app-primary-nav__item--active' : ''}`}
              onClick={() => openWorkspace({ view: 'settings' })}
              aria-current={activeWorkspace.view === 'settings' ? 'page' : undefined}
            >
              <Icon name="cog" />
              <span>Settings</span>
            </button>
          </aside>
          <div className="app-content workspace-active">
            {activeWorkspace.view === 'home' ? (
              <div className="workspace-layout">
                <main className="app-main app-home-main">
                  <HomeDashboard
                    environments={environments}
                    downloadsInProgress={downloadsInProgress}
                    appUpdateState={appUpdateState}
                    onOpenEnvironments={openEnvironmentsWorkspace}
                    onOpenModLibrary={() => openLibraryWorkspace()}
                    onOpenModUpdates={() => openLibraryWorkspace({
                      initialTab: 'updates',
                      navigationState: {
                        libraryTab: 'updates',
                      },
                    })}
                    onOpenWizard={() => openWorkspace({ view: 'wizard' })}
                    onOpenSettings={() => openWorkspace({ view: 'settings' })}
                  />
                </main>
              </div>
            ) : (
              <div className="workspace-layout">
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
