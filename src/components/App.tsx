import {
  Suspense,
  lazy,
  memo,
  useState,
  useEffect,
  useCallback,
  useRef,
} from 'react';
import type { ComponentType, ReactNode, TransitionEvent } from 'react';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow, UserAttentionType } from '@tauri-apps/api/window';
import { getCurrent as getCurrentDeepLink, onOpenUrl } from '@tauri-apps/plugin-deep-link';
import { AppDialogProvider, useAppDialogs } from './AppDialogProvider';
import { GameLaunchStoreProvider, isLaunchPending, useGameLaunchStore } from '../stores/gameLaunchStore';
import { GameLaunchStatus } from './GameLaunchStatus';
import { relaunch } from '@tauri-apps/plugin-process';
import type { WorkspaceRoute } from './EnvironmentList';
import { useDiscordPresence } from '../hooks/useDiscordPresence';
import appIcon256 from '../assets/app-icon-256.png';
import { AppUpdateToast } from './AppUpdateToast';
import { MelonLoaderUpdateToast } from './MelonLoaderUpdateToast';
import { Footer } from './Footer';
import { EnvironmentStoreProvider } from '../stores/environmentStore';
import { ModLibraryStoreProvider } from '../stores/modLibraryStore';
import { DownloadStatusStoreProvider, useDownloadStatusStore } from '../stores/downloadStatusStore';
import { SettingsStoreProvider, useSettingsStore } from '../stores/settingsStore';
import { useEnvironmentStore } from '../stores/environmentStore';
import { ApiService } from '../services/api';
import {
  createAsyncListenerScope,
  onMelonLoaderUpdateAvailable,
  onModIntegrationRequestsChanged,
  onRuntimeSwitch,
} from '../services/events';
import { logger } from '../services/logger';
import {
  buildSetupGuideSettings,
  resolveExperienceMode,
  settingsNeedUpgradeSetupPrompt,
} from '../utils/uxSettings';
import { getErrorMessage } from '../utils/errors';
import { sortEnvironmentsForDisplay } from '../utils/environmentOrdering';
import { readPreferredLaunchMethod } from '../utils/launchPreferences';
import {
  environmentGameVersion,
  environmentSourceLabel,
  runtimeLabel,
  runtimeTagClass,
  summarizeEnvironmentStatus,
} from './shell/environmentPresentation';
import { useEnvironmentModUpdateCounts } from './shell/useEnvironmentModUpdateCounts';
import { GameArt } from './media/GameArt';
import { EnvironmentWorkspaceHeader, type EnvironmentWorkspaceTab } from './shell/EnvironmentWorkspaceHeader';
import type {
  Environment,
  ExperienceMode,
  AppUpdateChannel,
  AppUpdateChannelPreferences,
  AppUpdatePreferences,
  AppUpdateStatus,
  MelonLoaderUpdateNotice,
  ModIntegrationRequestRecord,
  RuntimeSwitchResult,
} from '../types';
import { ErrorBoundary } from './ErrorBoundary';
import { Icon } from './Icon';
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Checkbox } from '@/components/ui/checkbox';
import { Skeleton } from '@/components/ui/skeleton';
import { SimmButton, SimmDialogContent, SimmIconButton } from './primitives';
import type { IconName } from './icons';
import type { ModLibraryNavigationState } from './ModLibraryOverlay';
import type { ModsOverlayNavigationState } from './ModsOverlay';
import type { SecurityReportWorkspaceRequest } from './SecurityScanReportPage';

const APP_UPDATE_CHECK_REQUEST_EVENT = 'simm:check-app-update';
const MIN_APP_UPDATE_CHECK_INTERVAL_MINUTES = 1;
const MAX_APP_UPDATE_CHECK_INTERVAL_MINUTES = 1440;
const LAST_ENV_KEY = 'simm:lastEnvId';
const SHELL_NAV_COLLAPSED_KEY = 'simm:shellNavCollapsed';
const CONSUMED_NEXUS_OAUTH_CALLBACKS_KEY = 'simm:consumedNexusOAuthCallbacks';
const SIMM_RELEASES_URL = 'https://api.github.com/repos/SirTidez/simm/releases?per_page=4';
const SIMM_CHANGELOG_URL = 'https://raw.githubusercontent.com/SirTidez/simm/master/CHANGELOG.md';

const runtimeDisplayName = (runtime: RuntimeSwitchResult['runtime']) => (
  runtime === 'Mono' || runtime === 'MONO' ? 'Mono' : 'IL2CPP'
);

const readConsumedNexusOAuthCallbacks = () => {
  try {
    const parsed = JSON.parse(sessionStorage.getItem(CONSUMED_NEXUS_OAUTH_CALLBACKS_KEY) || '[]');
    return Array.isArray(parsed)
      ? new Set(parsed.filter((value): value is string => typeof value === 'string'))
      : new Set<string>();
  } catch {
    return new Set<string>();
  }
};

const rememberConsumedNexusOAuthCallback = (callbackUrl: string) => {
  try {
    const callbacks = readConsumedNexusOAuthCallbacks();
    callbacks.add(callbackUrl);
    sessionStorage.setItem(
      CONSUMED_NEXUS_OAUTH_CALLBACKS_KEY,
      JSON.stringify(Array.from(callbacks).slice(-12)),
    );
  } catch {
    // Ignore storage failures; the in-memory replay guard still works for this session.
  }
};

const readStoredShellNavCollapsed = () => {
  try {
    return localStorage.getItem(SHELL_NAV_COLLAPSED_KEY) === 'true';
  } catch {
    return false;
  }
};

const prefersReducedShellMotion = () => (
  typeof window !== 'undefined'
  && typeof window.matchMedia === 'function'
  && window.matchMedia('(prefers-reduced-motion: reduce)').matches
);

const requestShellAnimationFrame = (callback: FrameRequestCallback) => {
  if (typeof window.requestAnimationFrame === 'function') {
    return window.requestAnimationFrame(callback);
  }

  return window.setTimeout(() => callback(typeof performance !== 'undefined' ? performance.now() : Date.now()), 0);
};

const cancelShellAnimationFrame = (handle: number) => {
  if (typeof window.cancelAnimationFrame === 'function') {
    window.cancelAnimationFrame(handle);
    return;
  }

  window.clearTimeout(handle);
};

const lazyNamed = <T,>(
  loader: () => Promise<T>,
  select: (module: T) => ComponentType<any>,
) => lazy(async () => ({
  default: select(await loader()),
}));

const EnvironmentList = lazyNamed(
  () => import('./EnvironmentList'),
  (module) => module.EnvironmentList,
);
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
const TelemetryWorkspace = lazyNamed(
  () => import('./TelemetryWorkspace'),
  (module) => module.TelemetryWorkspace,
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
const SaveBackupsWorkspace = lazyNamed(
  () => import('./SaveBackupsWorkspace'),
  (module) => module.SaveBackupsWorkspace,
);
const ConfigurationOverlay = lazyNamed(
  () => import('./ConfigurationOverlay'),
  (module) => module.ConfigurationOverlay,
);
const SecurityScanReportPage = lazyNamed(
  () => import('./SecurityScanReportPage'),
  (module) => module.SecurityScanReportPage,
);
const DownloadsPanel = lazyNamed(
  () => import('./DownloadsPanel'),
  (module) => module.DownloadsPanel,
);
const ProfilesWorkspace = lazyNamed(
  () => import('./ProfilesWorkspace'),
  (module) => module.ProfilesWorkspace,
);
const ModIntegrationDialog = lazyNamed(
  () => import('./ModIntegrationDialog'),
  (module) => module.ModIntegrationDialog,
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

type StartupPhase = 'directories' | 'database' | 'services' | 'ready';

const startupSteps: ReadonlyArray<{ phase: StartupPhase; label: string }> = [
  { phase: 'directories', label: 'Preparing SIMM folders' },
  { phase: 'database', label: 'Checking database, backups, and migrations' },
  { phase: 'services', label: 'Starting workspace services' },
  { phase: 'ready', label: 'Opening workspace' },
];

function waitForStartupFrame() {
  return new Promise<void>((resolve) => {
    if (typeof window.requestAnimationFrame !== 'function') {
      window.setTimeout(resolve, 0);
      return;
    }

    window.requestAnimationFrame(() => resolve());
  });
}

function StartupLoadingScreen({
  phase,
  error,
  onRetry,
}: {
  phase: StartupPhase;
  error: string | null;
  onRetry: () => void;
}) {
  const activeIndex = startupSteps.findIndex((step) => step.phase === phase);

  return (
    <div className="boot-screen" role={error ? 'alert' : 'status'} aria-live={error ? 'assertive' : 'polite'}>
      <div className="boot-card">
        <div className="boot-title">Schedule I</div>
        <div className="boot-subtitle">
          {error ? 'Startup needs your attention' : 'Preparing the dev environment'}
        </div>
        {!error && (
          <div className="boot-loader" aria-hidden="true">
            <span className="boot-dot" />
            <span className="boot-dot" />
            <span className="boot-dot" />
          </div>
        )}
        <div className="boot-startup-steps">
          {startupSteps.map((step, index) => {
            const isActive = index === activeIndex;
            const isComplete = activeIndex > index;
            return (
              <div
                key={step.phase}
                className={`boot-startup-step${isActive ? ' boot-startup-step--active' : ''}${isComplete ? ' boot-startup-step--complete' : ''}`}
              >
                <span className="boot-startup-step__marker" aria-hidden="true" />
                <span>{step.label}</span>
              </div>
            );
          })}
        </div>
        {error ? (
          <>
            <p className="boot-error">{error}</p>
            <button className="btn btn-primary" type="button" onClick={onRetry}>
              Retry startup
            </button>
          </>
        ) : (
          <div className="boot-bar" />
        )}
      </div>
    </div>
  );
}

function StartupGate({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const [phase, setPhase] = useState<StartupPhase>('directories');
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;

    const prepare = async () => {
      setReady(false);
      setError(null);
      setPhase('directories');

      await waitForStartupFrame();
      if (cancelled) return;

      setPhase('database');
      await waitForStartupFrame();
      if (cancelled) return;

      try {
        await ApiService.prepareApp();
        if (cancelled) return;
        setPhase('services');
        await waitForStartupFrame();
        if (cancelled) return;
        setPhase('ready');
        setReady(true);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'Failed to prepare SIMM startup');
      }
    };

    void prepare();

    return () => {
      cancelled = true;
    };
  }, [attempt]);

  if (!ready) {
    return (
      <StartupLoadingScreen
        phase={phase}
        error={error}
        onRetry={() => setAttempt((value) => value + 1)}
      />
    );
  }

  return <>{children}</>;
}

const getAppUpdateChannelPreferences = (
  preferences: AppUpdatePreferences | null | undefined,
  channel: AppUpdateChannel,
): AppUpdateChannelPreferences => {
  const channelPreferences = preferences?.byChannel?.[channel];
  if (channelPreferences) {
    return channelPreferences;
  }

  // Existing settings stored one flat record. Treat that record as belonging
  // only to its recorded channel so it can never suppress the other feed.
  const legacyChannel = preferences?.channel ?? 'beta';
  return legacyChannel === channel
    ? {
        lastCheckedAt: preferences?.lastCheckedAt ?? null,
        lastSeenVersionRaw: preferences?.lastSeenVersionRaw ?? null,
        lastResolvedUrl: preferences?.lastResolvedUrl ?? null,
        lastSeenVersionNormalized: preferences?.lastSeenVersionNormalized ?? null,
        snoozedUntil: preferences?.snoozedUntil ?? null,
        skippedVersionNormalized: preferences?.skippedVersionNormalized ?? null,
      }
    : {};
};

const appUpdateReleaseIdentity = (result: AppUpdateStatus) => result.version.trim();

const appUpdateIntervalMs = (value: number | undefined) => {
  const minutes = Number.isFinite(value)
    ? Math.min(
        MAX_APP_UPDATE_CHECK_INTERVAL_MINUTES,
        Math.max(MIN_APP_UPDATE_CHECK_INTERVAL_MINUTES, Math.trunc(value as number)),
      )
    : 60;
  return minutes * 60 * 1000;
};

function parseDashboardTime(value: string | number | undefined) {
  if (!value) return null;
  const date = typeof value === 'number'
    ? new Date(value > 1_000_000_000_000 ? value : value * 1000)
    : new Date(value);

  if (Number.isNaN(date.getTime())) {
    return null;
  }

  return date;
}

export function formatDashboardTime(value: string | number | undefined) {
  const date = parseDashboardTime(value);
  if (!date) return 'Not checked yet';

  return date.toLocaleString('en-US', {
    month: '2-digit',
    day: '2-digit',
    year: '2-digit',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
}

export function formatDashboardTimeDetail(value: string | number | undefined) {
  const date = parseDashboardTime(value);
  return date ? date.toLocaleString('en-US') : 'Not checked yet';
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

async function loadHomeFeed(signal?: AbortSignal): Promise<HomeFeedItem[]> {
  if (typeof fetch !== 'function') {
    return [];
  }

  const [releaseResult, changelogResult] = await Promise.allSettled([
    fetch(SIMM_RELEASES_URL, { headers: { Accept: 'application/vnd.github+json' }, signal }),
    fetch(SIMM_CHANGELOG_URL, { signal }),
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

  const seen = new Set<string>();
  return feed.filter((item) => {
    const match = item.title.match(/(\d+\.\d+\.\d+)(?:\D*beta\D*(\d+))?/i);
    const version = match ? `${match[1]}${match[2] ? `-beta.${match[2]}` : ''}` : item.title;
    if (seen.has(version)) return false;
    seen.add(version);
    return true;
  }).slice(0, 3);
}

function HomeEnvironmentRow({
  environment,
  modUpdateCount,
  primary,
  launching,
  onLaunch,
  onOpenEnvironment,
  onOpenModUpdates,
}: {
  environment: Environment;
  modUpdateCount: number;
  primary: boolean;
  launching: boolean;
  onLaunch: (environment: Environment) => void;
  onOpenEnvironment: (environmentId: string) => void;
  onOpenModUpdates: (environmentId: string) => void;
}) {
  const status = summarizeEnvironmentStatus(environment, modUpdateCount);
  const playable = environment.status === 'completed';
  const gameVersion = environmentGameVersion(environment);
  const nextStep = !playable
    ? {
        label: environment.status === 'not_downloaded' || environment.status === 'downloading' ? 'Set Up' : 'Review',
        onClick: () => onOpenEnvironment(environment.id),
      }
    : environment.updateAvailable
      ? { label: 'Update Game', onClick: () => onOpenEnvironment(environment.id) }
      : modUpdateCount > 0
        ? {
            label: modUpdateCount === 1 ? 'Review 1 Update' : `Review ${modUpdateCount} Updates`,
            onClick: () => onOpenModUpdates(environment.id),
          }
        : null;

  return (
    <li className={`home-env${primary ? ' home-env--primary' : ''}`}>
      {primary && <GameArt appId={environment.appId} className="home-env__art" />}
      <button
        type="button"
        className="home-env__identity"
        onClick={() => onOpenEnvironment(environment.id)}
        aria-label={`Open ${environment.name}`}
      >
        <span className="home-env__name">{environment.name}</span>
        <span className="ui-meta home-env__meta">
          <span className={runtimeTagClass(environment.runtime)}>{runtimeLabel(environment.runtime)}</span>
          <span>{environmentSourceLabel(environment)}</span>
          {gameVersion && <span className="ui-num">Game {gameVersion}</span>}
          {environment.melonLoaderVersion && <span className="ui-num">MelonLoader {environment.melonLoaderVersion}</span>}
        </span>
      </button>
      <span className={`ui-status ui-status--${status.tone} home-env__status`}>{status.label}</span>
      <div className="home-env__actions">
        {nextStep && (
          <SimmButton type="button" variant="secondary" onClick={nextStep.onClick}>
            {nextStep.label}
          </SimmButton>
        )}
        <SimmButton
          type="button"
          variant={primary ? 'default' : 'secondary'}
          className="home-env__play"
          onClick={() => onLaunch(environment)}
          disabled={!playable || launching}
          aria-label={`Play ${environment.name}`}
        >
          <Icon name={launching ? 'spinner' : 'play'} spin={launching} />
          {launching ? 'Starting…' : 'Play'}
        </SimmButton>
      </div>
    </li>
  );
}

function HomeDashboard({
  environments,
  environmentsLoading,
  appUpdateState,
  selectedEnvironmentId,
  platform,
  onOpenEnvironment,
  onOpenModUpdates,
  onOpenWizard,
  onOpenModLibrary,
}: {
  environments: Environment[];
  environmentsLoading: boolean;
  appUpdateState:
    | { status: 'idle' | 'checking' | 'upToDate' | 'error'; result: null }
    | { status: 'available'; result: AppUpdateStatus };
  selectedEnvironmentId?: string | null;
  platform?: string;
  onOpenEnvironment: (environmentId: string) => void;
  onOpenModUpdates: (environmentId: string) => void;
  onOpenWizard: () => void;
  onOpenModLibrary: () => void;
}) {
  const { attempts: launchAttempts, requestLaunch } = useGameLaunchStore();
  const { byEnvironment: modUpdateCounts } = useEnvironmentModUpdateCounts(environments);
  const sorted = sortEnvironmentsForDisplay(environments);
  const primaryEnvironment = (selectedEnvironmentId ? sorted.find((env) => env.id === selectedEnvironmentId) : null)
    ?? sorted.find((env) => env.status === 'completed')
    ?? sorted[0]
    ?? null;
  const otherEnvironments = sorted.filter((env) => env.id !== primaryEnvironment?.id);
  const attentionCount = environments.filter((env) => (
    env.updateAvailable || (modUpdateCounts.get(env.id) ?? 0) > 0 || env.status === 'error' || env.status === 'unavailable'
  )).length;
  const [feedItems, setFeedItems] = useState<HomeFeedItem[]>([]);
  const [feedStatus, setFeedStatus] = useState<'loading' | 'ready' | 'empty'>('loading');

  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;
    const timeoutId = window.setTimeout(() => controller.abort(), 10_000);

    const loadFeed = async () => {
      setFeedStatus('loading');
      try {
        const items = await loadHomeFeed(controller.signal);
        if (cancelled) return;
        setFeedItems(items);
        setFeedStatus(items.length > 0 ? 'ready' : 'empty');
      } catch (error) {
        if (cancelled) return;
        logger.warn('Failed to load home news feed', { error });
        setFeedStatus('empty');
      }
    };

    void loadFeed();

    return () => {
      cancelled = true;
      window.clearTimeout(timeoutId);
      controller.abort();
    };
  }, []);

  const handleLaunch = (environment: Environment) => {
    void requestLaunch(environment, readPreferredLaunchMethod(environment.id, platform));
  };

  const renderRow = (environment: Environment, primary: boolean) => (
    <HomeEnvironmentRow
      key={environment.id}
      environment={environment}
      modUpdateCount={modUpdateCounts.get(environment.id) ?? 0}
      primary={primary}
      launching={isLaunchPending(launchAttempts.get(environment.id))}
      onLaunch={handleLaunch}
      onOpenEnvironment={onOpenEnvironment}
      onOpenModUpdates={onOpenModUpdates}
    />
  );

  const heading = environmentsLoading
    ? 'Checking your game installs'
    : environments.length === 0
      ? 'Set up your first game install'
      : attentionCount > 0
        ? (attentionCount === 1 ? '1 install needs attention' : `${attentionCount} installs need attention`)
        : 'Ready to play';

  return (
    <section className="home" aria-label="Home">
      <header className="home__header">
        <h1 className="home__title">{heading}</h1>
        {!environmentsLoading && environments.length > 0 && (
          <SimmButton type="button" variant="ghost" onClick={onOpenModLibrary}>
            <Icon name="boxOpen" />
            Find Mods
          </SimmButton>
        )}
      </header>

      {environmentsLoading ? (
        <div className="home__loading" role="status" aria-live="polite" aria-label="Loading environments">
          <Skeleton className="home__skeleton home__skeleton--primary" />
          <Skeleton className="home__skeleton" />
        </div>
      ) : environments.length === 0 ? (
        <div className="ui-empty home__empty">
          <p className="ui-empty__title">No game installs yet</p>
          <p className="ui-empty__copy">
            Import your Steam copy of Schedule I or add another folder. SIMM keeps mods for each install separate.
          </p>
          <SimmButton type="button" onClick={onOpenWizard}>
            <Icon name="plus" />
            Add Environment
          </SimmButton>
        </div>
      ) : (
        <>
          <ul className="home__list home__list--primary" aria-label="Selected environment">
            {primaryEnvironment && renderRow(primaryEnvironment, true)}
          </ul>
          {otherEnvironments.length > 0 && (
            <section className="home__section" aria-labelledby="home-other-envs">
              <h2 className="ui-section-title" id="home-other-envs">Other environments</h2>
              <ul className="home__list">
                {otherEnvironments.map((environment) => renderRow(environment, false))}
              </ul>
            </section>
          )}
        </>
      )}

      <section className="home__section home__news" aria-labelledby="home-news">
        <h2 className="ui-section-title" id="home-news">What&apos;s new in SIMM</h2>
        {appUpdateState.status === 'available' && (
          <p className="home__news-update">
            SIMM {appUpdateState.result.version} is available on the {appUpdateState.result.channel} channel.
          </p>
        )}
        {feedStatus === 'loading' && <p className="ui-subtle">Loading recent releases…</p>}
        {feedStatus === 'empty' && <p className="ui-subtle">Release notes appear here when GitHub can be reached.</p>}
        {feedStatus === 'ready' && (
          <ul className="home__news-list">
            {feedItems.slice(0, 2).map((item) => (
              <li key={item.id} className="home__news-item">
                <div className="home__news-heading">
                  {item.url ? (
                    <a href={item.url} target="_blank" rel="noreferrer">{item.title}</a>
                  ) : (
                    <strong>{item.title}</strong>
                  )}
                  {item.date && <span className="ui-subtle ui-num">{formatFeedDate(item.date)}</span>}
                </div>
                <p className="home__news-summary">{item.bullets.slice(0, 2).join(' · ')}</p>
              </li>
            ))}
          </ul>
        )}
      </section>
    </section>
  );
}

function AppShellDownloadsDock({
  activeCount,
  totalCount,
  onOpenProfile,
}: {
  activeCount: number;
  totalCount: number;
  onOpenProfile: (profileId: string) => void;
}) {
  const [downloadsPanelMounted, setDownloadsPanelMounted] = useState(false);
  const [downloadsPanelVisible, setDownloadsPanelVisible] = useState(false);
  const downloadsPanelDismissTimerRef = useRef<number | null>(null);
  const downloadsPanelAnimationFrameRef = useRef<number | null>(null);

  const clearDownloadsPanelAnimationFrame = useCallback(() => {
    if (downloadsPanelAnimationFrameRef.current !== null) {
      cancelShellAnimationFrame(downloadsPanelAnimationFrameRef.current);
      downloadsPanelAnimationFrameRef.current = null;
    }
  }, []);

  const clearDownloadsPanelDismissTimer = useCallback(() => {
    if (downloadsPanelDismissTimerRef.current !== null) {
      window.clearTimeout(downloadsPanelDismissTimerRef.current);
      downloadsPanelDismissTimerRef.current = null;
    }
  }, []);

  const openDownloadsPanel = useCallback(() => {
    clearDownloadsPanelAnimationFrame();
    setDownloadsPanelMounted(true);

    if (prefersReducedShellMotion()) {
      setDownloadsPanelVisible(true);
      return;
    }

    downloadsPanelAnimationFrameRef.current = requestShellAnimationFrame(() => {
      downloadsPanelAnimationFrameRef.current = null;
      setDownloadsPanelVisible(true);
    });
  }, [clearDownloadsPanelAnimationFrame]);

  const closeDownloadsPanel = useCallback(() => {
    clearDownloadsPanelDismissTimer();
    clearDownloadsPanelAnimationFrame();

    if (prefersReducedShellMotion()) {
      setDownloadsPanelVisible(false);
      setDownloadsPanelMounted(false);
      return;
    }

    setDownloadsPanelVisible(false);
  }, [clearDownloadsPanelAnimationFrame, clearDownloadsPanelDismissTimer]);

  const scheduleDownloadsPanelDismiss = useCallback(() => {
    clearDownloadsPanelDismissTimer();
    downloadsPanelDismissTimerRef.current = window.setTimeout(() => {
      downloadsPanelDismissTimerRef.current = null;
      closeDownloadsPanel();
    }, 850);
  }, [clearDownloadsPanelDismissTimer, closeDownloadsPanel]);

  const toggleDownloadsPanel = useCallback(() => {
    clearDownloadsPanelDismissTimer();
    if (downloadsPanelVisible) {
      closeDownloadsPanel();
      return;
    }

    openDownloadsPanel();
  }, [clearDownloadsPanelDismissTimer, closeDownloadsPanel, downloadsPanelVisible, openDownloadsPanel]);

  const handleDownloadsPanelTransitionEnd = useCallback((event: TransitionEvent<HTMLDivElement>) => {
    if (event.currentTarget !== event.target || event.propertyName !== 'opacity' || downloadsPanelVisible) {
      return;
    }

    setDownloadsPanelMounted(false);
  }, [downloadsPanelVisible]);

  useEffect(() => () => {
    clearDownloadsPanelDismissTimer();
    clearDownloadsPanelAnimationFrame();
  }, [clearDownloadsPanelAnimationFrame, clearDownloadsPanelDismissTimer]);

  return (
    <>
      <div
        className="statusbar-downloads"
        onPointerEnter={clearDownloadsPanelDismissTimer}
        onPointerLeave={scheduleDownloadsPanelDismiss}
      >
        <button
          type="button"
          className={`statusbar-downloads__button${activeCount > 0 ? ' statusbar-downloads__button--active' : ''}`}
          onClick={toggleDownloadsPanel}
          aria-expanded={downloadsPanelVisible}
          aria-controls="downloads-popover"
          aria-label={activeCount > 0 ? `Downloads, ${activeCount} active` : `Downloads ${totalCount}`}
        >
          <Icon name={activeCount > 0 ? 'spinner' : 'download'} spin={activeCount > 0} />
          <span>{activeCount > 0 ? `${activeCount} downloading` : 'Downloads'}</span>
          {activeCount === 0 && totalCount > 0 && <span className="statusbar-downloads__count">{totalCount}</span>}
        </button>
      </div>
      {downloadsPanelMounted && (
        <div
          className={[
            'downloads-popover',
            'downloads-popover--statusbar',
            downloadsPanelVisible ? 'downloads-popover--open' : 'downloads-popover--closing',
          ].join(' ')}
          id="downloads-popover"
          role="dialog"
          aria-label="Downloads"
          onPointerEnter={clearDownloadsPanelDismissTimer}
          onPointerLeave={scheduleDownloadsPanelDismiss}
          onTransitionEnd={handleDownloadsPanelTransitionEnd}
        >
          <Suspense fallback={<WorkspacePanelFallback />}>
            <DownloadsPanel
              presentation="popup"
              onClose={closeDownloadsPanel}
              onOpenProfile={(profileId: string) => {
                closeDownloadsPanel();
                onOpenProfile(profileId);
              }}
            />
          </Suspense>
        </div>
      )}
    </>
  );
}

const ENVIRONMENT_SCOPED_VIEWS = new Set<WorkspaceRoute['view']>(['environments', 'mods', 'plugins', 'userLibs', 'logs', 'config']);

function ShellNavItem({
  label,
  icon,
  active,
  onClick,
  count,
  countTone,
  showLabel,
}: {
  label: string;
  icon: IconName;
  active: boolean;
  onClick: () => void;
  count?: number;
  countTone?: 'attention';
  showLabel: boolean;
}) {
  return (
    <button
      type="button"
      className={`shell-nav__item${active ? ' shell-nav__item--active' : ''}`}
      onClick={onClick}
      aria-current={active ? 'page' : undefined}
      title={label}
    >
      <Icon name={icon} />
      {showLabel && <span className="shell-nav__label">{label}</span>}
      {showLabel && count !== undefined && count > 0 && (
        <span className={`shell-nav__count${countTone === 'attention' ? ' shell-nav__count--attention' : ''}`}>{count}</span>
      )}
    </button>
  );
}

const AppShellSidebar = memo(function AppShellSidebar({
  activeWorkspace,
  currentEnvironmentId,
  environments,
  environmentsLoading,
  modUpdateCounts,
  totalModUpdates,
  telemetryAvailable,
  onEnvironmentSelect,
  onOpenWorkspace,
  onOpenHome,
  onOpenLibrary,
  onShellNavTransitionEnd,
  onToggleShellNavigation,
  shellNavAnimating,
  shellNavCollapsed,
  shellNavExpandedContentVisible,
}: {
  activeWorkspace: WorkspaceRoute;
  currentEnvironmentId: string | null;
  environments: Environment[];
  environmentsLoading: boolean;
  modUpdateCounts: Map<string, number>;
  totalModUpdates: number;
  telemetryAvailable: boolean;
  onEnvironmentSelect: (environmentId: string) => void;
  onOpenWorkspace: (route: Exclude<WorkspaceRoute, { view: 'home' }>) => void;
  onOpenHome: () => void;
  onOpenLibrary: () => void;
  onShellNavTransitionEnd: (event: TransitionEvent<HTMLElement>) => void;
  onToggleShellNavigation: () => void;
  shellNavAnimating: boolean;
  shellNavCollapsed: boolean;
  shellNavExpandedContentVisible: boolean;
}) {
  const sortedEnvironments = sortEnvironmentsForDisplay(environments);
  const environmentScoped = ENVIRONMENT_SCOPED_VIEWS.has(activeWorkspace.view);
  const view = activeWorkspace.view;
  const shellSidebarClassName = [
    'app-shell-sidebar',
    shellNavCollapsed ? 'app-shell-sidebar--collapsed' : '',
    shellNavAnimating ? 'app-shell-sidebar--animating' : '',
    shellNavExpandedContentVisible ? 'app-shell-sidebar--expanded-content-visible' : '',
  ].filter(Boolean).join(' ');

  return (
    <aside className={shellSidebarClassName} aria-label="Primary navigation" onTransitionEnd={onShellNavTransitionEnd}>
      <nav className="shell-nav shell-nav--primary" aria-label="Workspaces">
        <ShellNavItem showLabel={shellNavExpandedContentVisible} label="Home" icon="house" active={view === 'home'} onClick={onOpenHome} />
        <ShellNavItem
          showLabel={shellNavExpandedContentVisible}
          label="Mod Library"
          icon="boxOpen"
          active={view === 'library' || view === 'securityReport'}
          onClick={onOpenLibrary}
          count={totalModUpdates}
          countTone="attention"
        />
        <ShellNavItem showLabel={shellNavExpandedContentVisible} label="Profiles" icon="userGear" active={view === 'profiles'} onClick={() => onOpenWorkspace({ view: 'profiles' })} />
        <ShellNavItem showLabel={shellNavExpandedContentVisible} label="Saves" icon="save" active={view === 'saveBackups'} onClick={() => onOpenWorkspace({ view: 'saveBackups' })} />
      </nav>

      <section className="shell-envs" aria-labelledby="shell-envs-title">
        <div className="shell-envs__header">
          <h2 className="shell-envs__title" id="shell-envs-title">{shellNavExpandedContentVisible ? 'Environments' : <span className="sr-only">Environments</span>}</h2>
          <button
            type="button"
            className={`shell-envs__add${view === 'wizard' ? ' shell-envs__add--active' : ''}`}
            onClick={() => onOpenWorkspace({ view: 'wizard' })}
            aria-label="Add Environment"
            title="Add Environment"
          >
            <Icon name="plus" />
          </button>
        </div>
        {environmentsLoading && sortedEnvironments.length === 0 ? (
          <div className="shell-envs__list" role="status" aria-live="polite" aria-label="Loading environments">
            {[0, 1, 2].map((index) => (
              <div key={index} className="shell-env shell-env--skeleton">
                <Skeleton className="shell-env__skeleton" aria-hidden="true" />
              </div>
            ))}
          </div>
        ) : sortedEnvironments.length > 0 ? (
          <ul className="shell-envs__list">
            {sortedEnvironments.map((environment) => {
              const active = environmentScoped && currentEnvironmentId === environment.id;
              const status = summarizeEnvironmentStatus(environment, modUpdateCounts.get(environment.id) ?? 0);
              return (
                <li key={environment.id}>
                  <button
                    type="button"
                    className={`shell-env${active ? ' shell-env--active' : ''}`}
                    onClick={() => onEnvironmentSelect(environment.id)}
                    aria-current={active ? 'page' : undefined}
                    title={`${environment.name} · ${runtimeLabel(environment.runtime)} · ${status.label}`}
                  >
                    <span className={`shell-env__dot shell-env__dot--${status.tone}`} aria-hidden="true" />
                    {shellNavExpandedContentVisible && (
                      <span className="shell-env__text">
                        <span className="shell-env__name">{environment.name}</span>
                        <span className="shell-env__meta">
                          {runtimeLabel(environment.runtime)} · {status.label}
                        </span>
                      </span>
                    )}
                    <span className="shell-env__initial" aria-hidden="true">{environment.name.trim().charAt(0).toUpperCase()}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="shell-envs__empty">No environments yet.</p>
        )}
      </section>

      <nav className="shell-nav shell-nav--secondary" aria-label="App">
        <ShellNavItem showLabel={shellNavExpandedContentVisible} label="Accounts" icon="userCircle" active={view === 'accounts'} onClick={() => onOpenWorkspace({ view: 'accounts' })} />
        {telemetryAvailable && (
          <ShellNavItem showLabel={shellNavExpandedContentVisible} label="Telemetry" icon="waveSquare" active={view === 'telemetry'} onClick={() => onOpenWorkspace({ view: 'telemetry' })} />
        )}
        <ShellNavItem showLabel={shellNavExpandedContentVisible} label="Help" icon="circleQuestion" active={view === 'help'} onClick={() => onOpenWorkspace({ view: 'help' })} />
        <ShellNavItem showLabel={shellNavExpandedContentVisible} label="Settings" icon="cog" active={view === 'settings'} onClick={() => onOpenWorkspace({ view: 'settings' })} />
        <button
          type="button"
          className="shell-nav__item shell-nav__collapse"
          onClick={onToggleShellNavigation}
          aria-label={shellNavCollapsed ? 'Expand navigation sidebar' : 'Collapse navigation sidebar'}
          title={shellNavCollapsed ? 'Expand navigation sidebar' : 'Collapse navigation sidebar'}
        >
          <Icon name={shellNavCollapsed ? 'anglesRight' : 'anglesLeft'} />
          {shellNavExpandedContentVisible && <span className="shell-nav__label">Collapse</span>}
        </button>
      </nav>
    </aside>
  );
});

function AppWindowChrome() {
  const appWindow = getCurrentWindow();
  const [isMaximized, setIsMaximized] = useState(false);

  useEffect(() => {
    let disposed = false;

    const enforceCustomChrome = async () => {
      try {
        await appWindow.setDecorations(false);
      } catch (error) {
        if (!disposed) {
          console.error('Failed to disable native window decorations:', error);
        }
      }
    };

    void enforceCustomChrome();
    window.addEventListener('focus', enforceCustomChrome);

    return () => {
      disposed = true;
      window.removeEventListener('focus', enforceCustomChrome);
    };
  }, [appWindow]);

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

  return (
    <header className="window-chrome">
      <div className="window-brand" data-tauri-drag-region>
        <img src={appIcon256} alt="SIMM" className="window-brand-icon" />
        <div className="window-brand-text">
          <strong>SIMM</strong>
          <span>Schedule I Mod Manager</span>
        </div>
      </div>

      <div className="window-drag-region" data-tauri-drag-region aria-hidden="true" />

      <div className="window-controls" aria-label="Window controls">
        <SimmIconButton
          onClick={handleMinimize}
          className="window-control-btn"
          title="Minimize"
          aria-label="Minimize"
        >
          <Icon name="minus" />
        </SimmIconButton>
        <SimmIconButton
          onClick={handleToggleMaximize}
          className="window-control-btn"
          title={isMaximized ? 'Restore Down' : 'Maximize'}
          aria-label={isMaximized ? 'Restore Down' : 'Maximize'}
        >
          <Icon name={isMaximized ? 'windowRestore' : 'square'} />
        </SimmIconButton>
        <SimmIconButton
          onClick={handleCloseWindow}
          className="window-control-btn window-control-btn-close"
          title="Close"
          aria-label="Close"
        >
          <Icon name="times" />
        </SimmIconButton>
      </div>
    </header>
  );
}

function AppContent() {
  const { confirm, message } = useAppDialogs();
  const { attempts: launchAttempts, requestLaunch } = useGameLaunchStore();
  const [appWindow] = useState(() => getCurrentWindow());
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

  const { environments, loading: environmentsLoading } = useEnvironmentStore();
  const { downloads } = useDownloadStatusStore();
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
  const completedNexusCallbackRef = useRef<string | null>(null);
  const inFlightNexusCallbackRef = useRef<string | null>(null);
  const completedNxmCallbackRef = useRef(new Set<string>());
  const inFlightNxmCallbackRef = useRef<string | null>(null);
  const [pendingNexusRuntimeSelection, setPendingNexusRuntimeSelection] = useState<PendingNexusRuntimeSelection | null>(null);
  const [runtimeSwitchNotice, setRuntimeSwitchNotice] = useState<RuntimeSwitchResult | null>(null);
  const [appNotice, setAppNotice] = useState<string | null>(null);
  const [modIntegrationNotice, setModIntegrationNotice] = useState<ModIntegrationRequestRecord | null>(null);
  const [modIntegrationReviewEnvironmentId, setModIntegrationReviewEnvironmentId] = useState<string | null>(null);
  const [appUpdateState, setAppUpdateState] = useState<AppUpdateState>({ status: 'idle', result: null });
  const [melonLoaderUpdateNotice, setMelonLoaderUpdateNotice] = useState<MelonLoaderUpdateNotice | null>(null);
  const [dismissedMelonLoaderVersion, setDismissedMelonLoaderVersion] = useState<string | null>(null);
  const [dismissedAppUpdateVersions, setDismissedAppUpdateVersions] = useState<Partial<Record<AppUpdateChannel, string>>>({});
  const [installingAppUpdate, setInstallingAppUpdate] = useState(false);
  const [selectedEnvironmentId, setSelectedEnvironmentId] = useState<string | null>(null);
  const [environmentFocusRequestId, setEnvironmentFocusRequestId] = useState(0);
  const [telemetryAvailable, setTelemetryAvailable] = useState(false);
  const [shellNavCollapsed, setShellNavCollapsed] = useState(readStoredShellNavCollapsed);
  const [shellNavAnimating, setShellNavAnimating] = useState(false);
  const [shellNavExpandedContentVisible, setShellNavExpandedContentVisible] = useState(() => !readStoredShellNavCollapsed());
  const [closePrompt, setClosePrompt] = useState({ isOpen: false, remember: false });
  const closeRequestInFlightRef = useRef(false);
  const dismissedModIntegrationRequestsRef = useRef(new Set<string>());
  const notifiedModIntegrationRequestsRef = useRef(new Set<string>());
  const modIntegrationRefreshGenerationRef = useRef(0);
  const appUpdateSettingsRef = useRef(settings?.appUpdate ?? null);
  const updateSettingsRef = useRef(updateSettings);
  const startupSetupCheckedRef = useRef(false);
  const shellNavAnimationFrameRef = useRef<number | null>(null);
  const hasSettings = settings !== null;
  const activeEntry = workspaceStack[workspaceStack.length - 1];
  const activeWorkspace = activeEntry.route;
  const persistShellNavCollapsed = useCallback((collapsed: boolean) => {
    try {
      localStorage.setItem(SHELL_NAV_COLLAPSED_KEY, String(collapsed));
    } catch {
      // Ignore storage failures; the in-session state still updates.
    }
  }, []);
  const toggleShellNavigation = useCallback(() => {
    if (shellNavAnimationFrameRef.current !== null) {
      cancelShellAnimationFrame(shellNavAnimationFrameRef.current);
      shellNavAnimationFrameRef.current = null;
    }

    const nextCollapsed = !shellNavCollapsed;
    const reducedMotion = prefersReducedShellMotion();
    persistShellNavCollapsed(nextCollapsed);
    setShellNavAnimating(!reducedMotion);

    if (nextCollapsed) {
      setShellNavExpandedContentVisible(false);
      setShellNavCollapsed(true);
      return;
    }

    setShellNavExpandedContentVisible(true);
    if (reducedMotion) {
      setShellNavCollapsed(false);
      return;
    }

    shellNavAnimationFrameRef.current = requestShellAnimationFrame(() => {
      shellNavAnimationFrameRef.current = null;
      setShellNavCollapsed(false);
    });
  }, [persistShellNavCollapsed, shellNavCollapsed]);
  const handleShellNavTransitionEnd = useCallback((event: TransitionEvent<HTMLElement>) => {
    if (event.currentTarget !== event.target || event.propertyName !== 'width') {
      return;
    }

    setShellNavAnimating(false);
    if (shellNavCollapsed) {
      setShellNavExpandedContentVisible(false);
    }
  }, [shellNavCollapsed]);
  useEffect(() => () => {
    if (shellNavAnimationFrameRef.current !== null) {
      cancelShellAnimationFrame(shellNavAnimationFrameRef.current);
    }
  }, []);
  useEffect(() => {
    let disposed = false;
    void ApiService.getTelemetryCapability()
      .then((capability) => {
        if (!disposed) setTelemetryAvailable(capability.available);
      })
      .catch((error) => {
        if (!disposed) {
          setTelemetryAvailable(false);
          logger.warn('Telemetry capability lookup failed', {
            error: getErrorMessage(error, 'backend capability lookup failed'),
          });
        }
      });
    return () => { disposed = true; };
  }, []);
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    void onRuntimeSwitch((result) => {
      if (result.missingItems.length > 0 || result.errors.length > 0) {
        setRuntimeSwitchNotice(result);
      }
    }).then((dispose) => {
      unlisten = dispose;
    }).catch((error) => {
      logger.warn('Failed to listen for Steam runtime switches', {
        error: getErrorMessage(error, 'listener setup failed'),
      });
    });
    return () => unlisten?.();
  }, []);
  useEffect(() => {
    const listeners = createAsyncListenerScope((error) => {
      logger.warn('Failed to listen for MelonLoader stable updates', {
        error: getErrorMessage(error, 'listener setup failed'),
      });
    });
    listeners.register(() => onMelonLoaderUpdateAvailable((notice) => {
      setMelonLoaderUpdateNotice(notice);
    }));
    return listeners.dispose;
  }, []);
  const refreshPendingModIntegrationRequest = useCallback(async (preferredEnvironmentId?: string) => {
    const environmentIds = environments
      .filter((environment) => environment.status === 'completed')
      .map((environment) => environment.id);
    if (preferredEnvironmentId && !environmentIds.includes(preferredEnvironmentId)) {
      environmentIds.unshift(preferredEnvironmentId);
    } else if (preferredEnvironmentId) {
      environmentIds.splice(environmentIds.indexOf(preferredEnvironmentId), 1);
      environmentIds.unshift(preferredEnvironmentId);
    }

    const generation = ++modIntegrationRefreshGenerationRef.current;
    const requestGroups = await Promise.all(environmentIds.map(async (environmentId) => {
      try {
        const requests = await ApiService.listModIntegrationRequests(environmentId);
        return Array.isArray(requests) ? requests : [];
      } catch (error) {
        logger.warn('Failed to load pending mod integration requests', {
          environmentId,
          error: getErrorMessage(error, 'request lookup failed'),
        });
        return [];
      }
    }));

    if (generation !== modIntegrationRefreshGenerationRef.current) return null;

    const pendingRequests = requestGroups
      .flat()
      .filter((request) => (
        request.status === 'awaiting-user-approval' || request.status === 'awaiting-user-source'
      ))
      .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
    const visibleRequests = pendingRequests.filter(
      (request) => !dismissedModIntegrationRequestsRef.current.has(request.id),
    );
    setModIntegrationNotice((current) => {
      if (
        current
        && !dismissedModIntegrationRequestsRef.current.has(current.id)
        && pendingRequests.some((request) => request.id === current.id)
      ) {
        return current;
      }
      return visibleRequests[0] ?? null;
    });
    return preferredEnvironmentId
      ? visibleRequests.find((request) => request.environmentId === preferredEnvironmentId) ?? null
      : visibleRequests[0] ?? null;
  }, [environments]);
  useEffect(() => {
    const listeners = createAsyncListenerScope((error) => {
      logger.warn('Failed to listen for mod integration requests', {
        error: getErrorMessage(error, 'listener setup failed'),
      });
    });

    void refreshPendingModIntegrationRequest();
    listeners.register(async () => {
      const unlisten = await onModIntegrationRequestsChanged(({ environmentId }) => {
        void refreshPendingModIntegrationRequest(environmentId).then((request) => {
          if (!request || notifiedModIntegrationRequestsRef.current.has(request.id)) return;
          notifiedModIntegrationRequestsRef.current.add(request.id);
          void appWindow.requestUserAttention(UserAttentionType.Informational).catch((error) => {
            logger.warn('Failed to request attention for a mod update approval', {
              environmentId,
              error: getErrorMessage(error, 'attention request failed'),
            });
          });
        });
      });
      // Take a second snapshot after the subscription is active so a request cannot
      // fall between the initial database read and listener registration.
      void refreshPendingModIntegrationRequest();
      return unlisten;
    });

    return listeners.dispose;
  }, [appWindow, refreshPendingModIntegrationRequest]);
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
    if (a.view === 'profiles' && b.view === 'profiles') {
      return a.profileId === b.profileId;
    }
    return true;
  }, []);

  const pushWorkspace = useCallback((route: Exclude<WorkspaceRoute, { view: 'home' }>, seed?: Partial<WorkspaceEntry>) => {
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
  }, [createWorkspaceEntry, isSameWorkspaceRoute]);

  const replaceWorkspace = useCallback((route: Exclude<WorkspaceRoute, { view: 'home' }>, seed?: Partial<WorkspaceEntry>) => {
    setWorkspaceStack((previous) => {
      const current = previous[previous.length - 1];
      if (!current || current.route.view === 'home') {
        return [...previous, createWorkspaceEntry(route, seed)];
      }
      if (isSameWorkspaceRoute(current.route, route) && !seed?.libraryFocusRequest) {
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
      return [...previous.slice(0, -1), createWorkspaceEntry(route, seed)];
    });
  }, [createWorkspaceEntry, isSameWorkspaceRoute]);

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
    const activeIsEnvironmentWorkspace = 'environmentId' in activeWorkspace;
    const nextIsEnvironmentWorkspace = 'environmentId' in workspace;
    const shouldReplaceCurrent =
      !activeIsEnvironmentWorkspace
      && !nextIsEnvironmentWorkspace
      && activeWorkspace.view !== 'home';

    if (shouldReplaceCurrent) {
      replaceWorkspace(workspace);
      return;
    }

    pushWorkspace(workspace);
  }, [activeWorkspace, pushWorkspace, replaceWorkspace]);

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

    const route = options?.initialTab ? { view: 'library' as const, initialTab: options.initialTab } : { view: 'library' as const };
    const seed = {
      libraryState: mergedNavigationState,
      libraryFocusRequest: options?.focusRequest ?? null,
    };

    if (!('environmentId' in activeWorkspace) && activeWorkspace.view !== 'home') {
      replaceWorkspace(route, seed);
      return;
    }

    pushWorkspace(route, seed);
  }, [activeWorkspace, pushWorkspace, replaceWorkspace, workspaceStack]);

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
    if ('environmentId' in activeWorkspace) {
      setSelectedEnvironmentId(activeWorkspace.environmentId);
      localStorage.setItem(LAST_ENV_KEY, activeWorkspace.environmentId);
      return;
    }

    setSelectedEnvironmentId((previous) => {
      if (previous && environments.some((environment) => environment.id === previous)) {
        return previous;
      }

      const storedEnvironmentId = localStorage.getItem(LAST_ENV_KEY);
      if (storedEnvironmentId && environments.some((environment) => environment.id === storedEnvironmentId)) {
        return storedEnvironmentId;
      }

      return environments.find((environment) => environment.status === 'completed')?.id
        ?? environments[0]?.id
        ?? null;
    });
  }, [activeWorkspace, environments]);

  // Discord Rich Presence - automatically initializes and sets presence
  useDiscordPresence();

  const dismissClosePrompt = useCallback(() => {
    setClosePrompt({ isOpen: false, remember: false });
    closeRequestInFlightRef.current = false;
  }, []);

  const resolveClosePrompt = useCallback(async (behavior: 'tray' | 'quit') => {
    const remember = closePrompt.remember;
    setClosePrompt({ isOpen: false, remember: false });

    try {
      if (remember) {
        try {
          await updateSettings({ windowCloseBehavior: behavior });
        } catch (error) {
          logger.error('Failed to remember SIMM close behavior', {
            error: getErrorMessage(error, 'unknown error'),
          });
        }
      }

      if (behavior === 'tray') {
        await ApiService.hideMainWindow();
      } else {
        await ApiService.quitSimm();
      }
    } catch (error) {
      logger.error('Failed to apply SIMM close behavior', {
        error: getErrorMessage(error, 'unknown error'),
      });
    } finally {
      closeRequestInFlightRef.current = false;
    }
  }, [closePrompt.remember, updateSettings]);

  useEffect(() => {
    let unlistenCloseRequest: (() => void) | undefined;
    void listen('simm_close_requested', async () => {
      if (closeRequestInFlightRef.current) {
        return;
      }
      closeRequestInFlightRef.current = true;
      let awaitingChoice = false;

      try {
        setClosePrompt({ isOpen: true, remember: false });
        awaitingChoice = true;
      } catch (error) {
        logger.error('Failed to handle SIMM close request', { error: getErrorMessage(error, 'unknown error') });
      } finally {
        if (!awaitingChoice) {
          closeRequestInFlightRef.current = false;
        }
      }
    }).then((unlisten) => { unlistenCloseRequest = unlisten; });
    return () => unlistenCloseRequest?.();
  }, []);

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
    securityScan?: unknown;
    securityScanConfirmationRequired?: boolean;
    securityScanBlocked?: boolean;
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

  const persistAppUpdateSettings = useCallback(async (
    channel: AppUpdateChannel,
    updates: Partial<AppUpdateChannelPreferences>,
  ) => {
    const currentSettings = appUpdateSettingsRef.current ?? {};
    const mergedSettings: AppUpdatePreferences = {
      ...currentSettings,
      channel,
      byChannel: {
        ...(currentSettings.byChannel ?? {}),
        [channel]: {
          ...getAppUpdateChannelPreferences(currentSettings, channel),
          ...updates,
        },
      },
    };
    appUpdateSettingsRef.current = mergedSettings;
    await updateSettingsRef.current({
      appUpdate: mergedSettings,
    });
  }, []);

  const appUpdateChannel: AppUpdateChannel = settings?.appUpdate?.channel ?? 'stable';

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
    if (!hasSettings || environmentsLoading) {
      return;
    }

    let cancelled = false;
    const automaticChecksEnabled = settings?.autoCheckUpdates !== false;

    const runAppUpdateCheck = async () => {
      try {
        // Never retain an available result while a selected-channel check is
        // in flight: the result belongs to the currently selected feed only.
        setAppUpdateState({ status: 'checking', result: null });

        const result = await ApiService.checkAppUpdate(appUpdateChannel);
        if (cancelled || result.channel !== appUpdateChannel) {
          return;
        }

        const currentAppUpdateSettings = appUpdateSettingsRef.current ?? {};
        const currentChannelPreferences = getAppUpdateChannelPreferences(
          currentAppUpdateSettings,
          appUpdateChannel,
        );
        const expiredSnooze =
          !!currentChannelPreferences.snoozedUntil
          && Number.isFinite(Date.parse(currentChannelPreferences.snoozedUntil))
          && Date.parse(currentChannelPreferences.snoozedUntil) <= Date.now();
        const releaseIdentity = appUpdateReleaseIdentity(result);
        const skippedVersionNormalized = currentChannelPreferences.skippedVersionNormalized;
        const skipMatchesRelease = skippedVersionNormalized === releaseIdentity
          || skippedVersionNormalized === result.versionNormalized;

        const nextChannelPreferences = {
          lastCheckedAt: result.checkedAt,
          lastSeenVersionRaw: result.version,
          lastSeenVersionNormalized: result.versionNormalized,
          lastResolvedUrl: result.manifestUrl,
          snoozedUntil: expiredSnooze ? null : (currentChannelPreferences.snoozedUntil ?? null),
          skippedVersionNormalized: skipMatchesRelease ? (skippedVersionNormalized ?? null) : null,
        };

        const previousSerialized = JSON.stringify(currentChannelPreferences);
        const nextSerialized = JSON.stringify(nextChannelPreferences);
        if (previousSerialized !== nextSerialized) {
          void persistAppUpdateSettings(appUpdateChannel, nextChannelPreferences).catch((error) => {
            logger.warn('Failed to persist app update settings', error);
          });
        }

        setDismissedAppUpdateVersions((previous) => (
          previous[appUpdateChannel] && previous[appUpdateChannel] !== releaseIdentity
            ? { ...previous, [appUpdateChannel]: undefined }
            : previous
        ));
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

    const handleManualCheck = () => {
      void runAppUpdateCheck();
    };
    window.addEventListener(APP_UPDATE_CHECK_REQUEST_EVENT, handleManualCheck);

    let intervalId: number | null = null;
    if (automaticChecksEnabled) {
      void runAppUpdateCheck();
      intervalId = window.setInterval(() => {
        void runAppUpdateCheck();
      }, appUpdateIntervalMs(settings?.updateCheckInterval));
    } else {
      setAppUpdateState({ status: 'idle', result: null });
    }

    return () => {
      cancelled = true;
      window.removeEventListener(APP_UPDATE_CHECK_REQUEST_EVENT, handleManualCheck);
      if (intervalId !== null) {
        window.clearInterval(intervalId);
      }
    };
  }, [
    appUpdateChannel,
    environmentsLoading,
    hasSettings,
    persistAppUpdateSettings,
    settings?.autoCheckUpdates,
    settings?.updateCheckInterval,
  ]);

  const handleSkipAppUpdateVersion = useCallback(() => {
    if (
      appUpdateState.status !== 'available'
      || appUpdateState.result.channel !== appUpdateChannel
    ) {
      return;
    }
    const channel = appUpdateState.result.channel;
    const releaseIdentity = appUpdateReleaseIdentity(appUpdateState.result);
    setDismissedAppUpdateVersions((previous) => ({
      ...previous,
      [channel]: releaseIdentity,
    }));
    void persistAppUpdateSettings(channel, {
      skippedVersionNormalized: releaseIdentity,
      snoozedUntil: null,
    }).catch((error) => {
      logger.warn('Failed to persist skipped app update version', error);
    });
  }, [appUpdateChannel, appUpdateState, persistAppUpdateSettings]);

  const handleSnoozeAppUpdate = useCallback((days: number) => {
    if (
      appUpdateState.status !== 'available'
      || appUpdateState.result.channel !== appUpdateChannel
    ) {
      return;
    }
    const channel = appUpdateState.result.channel;
    const snoozedUntil = new Date(Date.now() + (days * 24 * 60 * 60 * 1000)).toISOString();
    setDismissedAppUpdateVersions((previous) => ({
      ...previous,
      [channel]: appUpdateReleaseIdentity(appUpdateState.result),
    }));
    void persistAppUpdateSettings(channel, {
      snoozedUntil,
    }).catch((error) => {
      logger.warn('Failed to persist app update snooze state', error);
    });
  }, [appUpdateChannel, appUpdateState, persistAppUpdateSettings]);

  const handleInstallAppUpdate = useCallback(async () => {
    if (
      appUpdateState.status !== 'available'
      || installingAppUpdate
      || appUpdateState.result.channel !== appUpdateChannel
    ) {
      return;
    }

    const result = appUpdateState.result;
    const releaseChannelLabel = result.channel === 'beta' ? 'beta' : 'stable';
    const shouldInstall = await confirm(
      `Download and install SIMM ${result.version} from the ${releaseChannelLabel} channel now?`,
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

    // Re-read the persisted selection after confirmation. A channel switch
    // while the dialog is open must not install the now-stale result.
    const currentChannel = appUpdateSettingsRef.current?.channel ?? 'stable';
    if (currentChannel !== result.channel) {
      return;
    }

    try {
      setInstallingAppUpdate(true);
      const installResult = await ApiService.installAppUpdate(result.channel);
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
  }, [appUpdateChannel, appUpdateState, installingAppUpdate, confirm, message]);

  const handleNexusOAuthCallback = useCallback(async (callbackUrl: string) => {
    if (!callbackUrl.startsWith('simm://oauth/nexus/callback')) {
      return;
    }

    const consumedCallbacks = readConsumedNexusOAuthCallbacks();
    if (
      consumedCallbacks.has(callbackUrl) ||
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
      rememberConsumedNexusOAuthCallback(callbackUrl);
      dispatchNexusOAuthResult({ success: true });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Failed to complete Nexus OAuth login';
      if (errorMessage.includes('No pending Nexus OAuth login flow')) {
        try {
          const status = await ApiService.getNexusOAuthStatus();
          if (status.connected) {
            completedNexusCallbackRef.current = callbackUrl;
            rememberConsumedNexusOAuthCallback(callbackUrl);
            dispatchNexusOAuthResult({ success: true });
            return;
          }
        } catch {
          // Fall through to the original callback failure below.
        }
      }

      dispatchNexusOAuthResult({
        success: false,
        error: errorMessage,
      });
      return;
    } finally {
      inFlightNexusCallbackRef.current = null;
    }
  }, [dispatchNexusOAuthResult, pushWorkspace]);

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
        const securityGateResponse = Boolean(
          result.securityScanConfirmationRequired || result.securityScanBlocked,
        );
        if (!securityGateResponse) {
          completedNxmCallbackRef.current.add(nxmUrl);
        }
        dispatchNexusManualDownloadResult({
          success: false,
          result,
          error: result.error || 'Failed to complete Nexus manual download',
          requestedKind: result.requestedKind,
          nxmUrl,
          securityScan: result.securityScan,
          securityScanConfirmationRequired: result.securityScanConfirmationRequired,
          securityScanBlocked: result.securityScanBlocked,
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
      const errorMessage = error instanceof Error ? error.message : 'Failed to complete Nexus manual download';
      completedNxmCallbackRef.current.add(nxmUrl);
      if (errorMessage.includes('Close SIMM to download Nexus mods for other games')) {
        setAppNotice(errorMessage);
      }
      dispatchNexusManualDownloadResult({
        success: false,
        error: errorMessage,
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
        const securityGateResponse = Boolean(
          result.securityScanConfirmationRequired || result.securityScanBlocked,
        );
        if (!securityGateResponse) {
          completedNxmCallbackRef.current.add(pending.nxmUrl);
        }
        dispatchNexusManualDownloadResult({
          success: false,
          result,
          error: result.error || 'Failed to complete Nexus manual download',
          requestedKind: result.requestedKind ?? pending.kind,
          nxmUrl: pending.nxmUrl,
          securityScan: result.securityScan,
          securityScanConfirmationRequired: result.securityScanConfirmationRequired,
          securityScanBlocked: result.securityScanBlocked,
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
      const errorMessage = error instanceof Error ? error.message : 'Failed to complete Nexus manual download';
      completedNxmCallbackRef.current.add(pending.nxmUrl);
      if (errorMessage.includes('Close SIMM to download Nexus mods for other games')) {
        setAppNotice(errorMessage);
      }
      dispatchNexusManualDownloadResult({
        success: false,
        error: errorMessage,
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
    const reportDeepLinkError = (error: unknown) => {
      console.error('Failed to initialize deep-link handling:', error);
      dispatchNexusOAuthResult({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to initialize deep-link handling',
      });
    };
    const listeners = createAsyncListenerScope(reportDeepLinkError);

    const processPendingDeepLinks = async () => {
      const currentUrls = await getCurrentDeepLink();
      if (listeners.isActive() && currentUrls?.length) {
        for (const url of currentUrls) {
          void handleExternalProtocolUrl(url);
        }
      }
    };

    void processPendingDeepLinks().catch(reportDeepLinkError);
    listeners.register(() => onOpenUrl((urls) => {
      if (!listeners.isActive()) return;
      for (const url of urls) {
        void handleExternalProtocolUrl(url);
      }
    }));
    listeners.register(() => listen<{ args?: string[] }>('single-instance-args', (event) => {
      if (!listeners.isActive()) return;
      const args = event.payload?.args || [];
      for (const arg of args) {
        if (typeof arg === 'string' && (arg.startsWith('simm://') || arg.startsWith('nxm://'))) {
          void handleExternalProtocolUrl(arg);
        }
      }
    }));

    const handleWindowFocus = () => {
      void processPendingDeepLinks().catch((error) => {
        console.error('Failed to re-check deep links after focus:', error);
      });
    };
    window.addEventListener('focus', handleWindowFocus);

    return () => {
      window.removeEventListener('focus', handleWindowFocus);
      listeners.dispose();
    };
  }, [dispatchNexusOAuthResult, handleExternalProtocolUrl]);

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
            onOpenProfile={(profileId: string) => openWorkspace({ view: 'profiles', profileId })}
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
            onOpenWorkspace={openWorkspace}
            onlyEnvironmentId={selectedEnvironmentId}
            focusedEnvironmentId={selectedEnvironmentId}
            focusedEnvironmentRequestId={environmentFocusRequestId}
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
      case 'telemetry':
        return telemetryAvailable ? <TelemetryWorkspace onClose={onCloseHandler} /> : null;
      case 'profiles':
        return (
          <ProfilesWorkspace
            preferredEnvironmentId={selectedEnvironmentId}
            initialProfileId={workspace.profileId}
          />
        );
      case 'saveBackups':
        return <SaveBackupsWorkspace onClose={onCloseHandler} />;
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
  }, [completeSetupGuide, environmentFocusRequestId, getEnvironmentById, openLibraryFromLogs, openLibraryWorkspace, openSecurityReportWorkspace, openWorkspace, pushWorkspace, selectedEnvironmentId, settings, skipSetupGuide, telemetryAvailable, updateWorkspaceEntry]);

  const renderWorkspacePanel = () => {
    return renderWorkspacePanelFor(activeEntry, popWorkspace);
  };

  const appUpdatePreferences = settings?.appUpdate ?? null;
  const appUpdateChannelPreferences = getAppUpdateChannelPreferences(
    appUpdatePreferences,
    appUpdateChannel,
  );
  const appUpdateSnoozedUntil = appUpdateChannelPreferences.snoozedUntil
    && Number.isFinite(Date.parse(appUpdateChannelPreferences.snoozedUntil))
    ? Date.parse(appUpdateChannelPreferences.snoozedUntil)
    : null;
  const isAppUpdateSnoozed = appUpdateState.status === 'available'
    && appUpdateSnoozedUntil !== null
    && appUpdateSnoozedUntil > Date.now();
  const isAppUpdateSkipped = appUpdateState.status === 'available'
    && (
      appUpdateChannelPreferences.skippedVersionNormalized === appUpdateReleaseIdentity(appUpdateState.result)
      || appUpdateChannelPreferences.skippedVersionNormalized === appUpdateState.result.versionNormalized
    );
  const isAppUpdateDismissedForSession = appUpdateState.status === 'available'
    && dismissedAppUpdateVersions[appUpdateState.result.channel]
      === appUpdateReleaseIdentity(appUpdateState.result);
  const showAppUpdateToast = appUpdateState.status === 'available'
    && !isAppUpdateSnoozed
    && !isAppUpdateSkipped
    && !isAppUpdateDismissedForSession;
  const availableMelonLoaderUpdate = melonLoaderUpdateNotice
    ?? settings?.melonLoaderUpdate?.available
    ?? null;
  const showMelonLoaderUpdateToast = availableMelonLoaderUpdate !== null
    && availableMelonLoaderUpdate.latestVersion !== dismissedMelonLoaderVersion
    && availableMelonLoaderUpdate.latestVersion !== settings?.melonLoaderUpdate?.dismissedVersion
    && !showAppUpdateToast
    && !modIntegrationNotice;
  const currentEnvironmentId =
    'environmentId' in activeWorkspace
      ? activeWorkspace.environmentId
      : selectedEnvironmentId
        ?? localStorage.getItem(LAST_ENV_KEY)
        ?? environments.find((env) => env.status === 'completed')?.id
        ?? environments[0]?.id
        ?? null;
  const currentEnvironment = currentEnvironmentId ? getEnvironmentById(currentEnvironmentId) : null;
  const downloadsInProgress = downloads.filter((download) => (
    download.status === 'queued'
    || download.status === 'downloading'
    || download.status === 'validating'
  )).length;
  const downloadsBadgeCount = downloads.length;
  const selectEnvironmentForShell = useCallback((environmentId: string) => {
    setSelectedEnvironmentId(environmentId);
    setEnvironmentFocusRequestId((previous) => previous + 1);
    localStorage.setItem(LAST_ENV_KEY, environmentId);
  }, []);

  const openEnvironmentsWorkspace = useCallback((environmentId?: string | null) => {
    const targetEnvironmentId = environmentId ?? currentEnvironmentId;
    if (targetEnvironmentId) {
      selectEnvironmentForShell(targetEnvironmentId);
    }
    openWorkspace({ view: 'environments' });
  }, [currentEnvironmentId, openWorkspace, selectEnvironmentForShell]);
  const openLibraryWorkspaceFromShell = useCallback(() => {
    openLibraryWorkspace();
  }, [openLibraryWorkspace]);
  const handleShellEnvironmentSelect = useCallback((environmentId: string) => {
    switch (activeWorkspace.view) {
      case 'mods':
        selectEnvironmentForShell(environmentId);
        openWorkspace({
          view: 'mods',
          environmentId,
          initialTab: activeWorkspace.initialTab,
        });
        return;
      case 'plugins':
        selectEnvironmentForShell(environmentId);
        openWorkspace({ view: 'plugins', environmentId });
        return;
      case 'userLibs':
        selectEnvironmentForShell(environmentId);
        openWorkspace({ view: 'userLibs', environmentId });
        return;
      case 'logs':
        selectEnvironmentForShell(environmentId);
        openWorkspace({ view: 'logs', environmentId });
        return;
      case 'config':
        selectEnvironmentForShell(environmentId);
        openWorkspace({ view: 'config', environmentId });
        return;
      case 'home':
      case 'environments':
      case 'wizard':
        openEnvironmentsWorkspace(environmentId);
        return;
      default:
        openEnvironmentsWorkspace(environmentId);
        return;
    }
  }, [activeWorkspace, openEnvironmentsWorkspace, openWorkspace, selectEnvironmentForShell]);

  const { byEnvironment: modUpdateCounts, distinctTotal: distinctModUpdateCount } = useEnvironmentModUpdateCounts(environments);
  const environmentWorkspaceTab: EnvironmentWorkspaceTab | null = (() => {
    switch (activeWorkspace.view) {
      case 'environments':
        return 'overview';
      case 'mods':
      case 'plugins':
      case 'userLibs':
      case 'config':
      case 'logs':
        return activeWorkspace.view;
      default:
        return null;
    }
  })();
  const workspaceEnvironment = environmentWorkspaceTab ? currentEnvironment : null;

  const launchEnvironment = useCallback((environment: Environment) => {
    void requestLaunch(environment, readPreferredLaunchMethod(environment.id, settings?.platform));
  }, [requestLaunch, settings?.platform]);

  const selectEnvironmentWorkspaceTab = useCallback((tab: EnvironmentWorkspaceTab) => {
    if (!currentEnvironmentId) {
      return;
    }
    selectEnvironmentForShell(currentEnvironmentId);
    const route: Exclude<WorkspaceRoute, { view: 'home' }> = tab === 'overview'
      ? { view: 'environments' }
      : { view: tab, environmentId: currentEnvironmentId };
    if (environmentWorkspaceTab) {
      replaceWorkspace(route);
      return;
    }
    openWorkspace(route);
  }, [currentEnvironmentId, environmentWorkspaceTab, openWorkspace, replaceWorkspace, selectEnvironmentForShell]);

  const workspacePanel = (
    <Suspense fallback={<WorkspacePanelFallback />}>
      {renderWorkspacePanel()}
    </Suspense>
  );

  return (
    <div className="app app-desktop-shell">
      <div className="app-window">
        <AppWindowChrome />
        <div className={`app-body ${shellNavCollapsed ? 'app-body--nav-collapsed' : ''}`}>
          <AppShellSidebar
            activeWorkspace={activeWorkspace}
            currentEnvironmentId={currentEnvironmentId}
            environments={environments}
            environmentsLoading={environmentsLoading}
            modUpdateCounts={modUpdateCounts}
            totalModUpdates={distinctModUpdateCount}
            telemetryAvailable={telemetryAvailable}
            onEnvironmentSelect={handleShellEnvironmentSelect}
            onOpenWorkspace={openWorkspace}
            onOpenHome={goHome}
            onOpenLibrary={openLibraryWorkspaceFromShell}
            onShellNavTransitionEnd={handleShellNavTransitionEnd}
            onToggleShellNavigation={toggleShellNavigation}
            shellNavAnimating={shellNavAnimating}
            shellNavCollapsed={shellNavCollapsed}
            shellNavExpandedContentVisible={shellNavExpandedContentVisible}
          />
          <div className="app-content workspace-active">
            {activeWorkspace.view === 'home' ? (
              <div className="workspace-layout">
                <main className="app-main app-home-main">
                  <HomeDashboard
                    environments={environments}
                    environmentsLoading={environmentsLoading}
                    appUpdateState={appUpdateState}
                    selectedEnvironmentId={currentEnvironmentId}
                    platform={settings?.platform}
                    onOpenEnvironment={(environmentId) => openEnvironmentsWorkspace(environmentId)}
                    onOpenModUpdates={(environmentId) => {
                      selectEnvironmentForShell(environmentId);
                      openWorkspace({ view: 'mods', environmentId, initialTab: 'updates' });
                    }}
                    onOpenWizard={() => openWorkspace({ view: 'wizard' })}
                    onOpenModLibrary={() => openLibraryWorkspace()}
                  />
                </main>
              </div>
            ) : workspaceEnvironment && environmentWorkspaceTab ? (
              <div className="workspace-layout">
                <main className="app-main workspace-main app-workspace-main env-workspace">
                  <EnvironmentWorkspaceHeader
                    environment={workspaceEnvironment}
                    activeTab={environmentWorkspaceTab}
                    modUpdateCount={modUpdateCounts.get(workspaceEnvironment.id) ?? 0}
                    launching={isLaunchPending(launchAttempts.get(workspaceEnvironment.id))}
                    onSelectTab={selectEnvironmentWorkspaceTab}
                    onLaunch={() => launchEnvironment(workspaceEnvironment)}
                  />
                  <div className={`env-workspace__body env-workspace__body--${environmentWorkspaceTab}`}>
                    {workspacePanel}
                  </div>
                </main>
              </div>
            ) : (
              <div className="workspace-layout">
                <main className="app-main workspace-main app-workspace-main">
                  {workspacePanel}
                </main>
              </div>
            )}
          </div>
        </div>

        <GameLaunchStatus onViewLogs={(environmentId) => openWorkspace({ view: 'logs', environmentId })} />
        <Footer
          onOpenModUpdates={() => openLibraryWorkspace({
            initialTab: 'updates',
            navigationState: {
              libraryTab: 'updates',
            },
          })}
          appUpdateAvailable={appUpdateState.status === 'available'}
          onOpenAppUpdate={() => void handleInstallAppUpdate()}
          downloads={(
            <AppShellDownloadsDock
              activeCount={downloadsInProgress}
              totalCount={downloadsBadgeCount}
              onOpenProfile={(profileId) => openWorkspace({ view: 'profiles', profileId })}
            />
          )}
        />
      </div>

      {showAppUpdateToast && appUpdateState.status === 'available' && (
        <AppUpdateToast
          currentVersion={appUpdateState.result.currentVersion}
          latestVersion={appUpdateState.result.version}
          onUpdate={() => void handleInstallAppUpdate()}
          onSkip={handleSkipAppUpdateVersion}
          onSnooze={handleSnoozeAppUpdate}
          onDismiss={() => setDismissedAppUpdateVersions((previous) => ({
            ...previous,
            [appUpdateState.result.channel]: appUpdateReleaseIdentity(appUpdateState.result),
          }))}
        />
      )}

      {showMelonLoaderUpdateToast && availableMelonLoaderUpdate && (
        <MelonLoaderUpdateToast
          notice={availableMelonLoaderUpdate}
          onReview={() => {
            const firstTarget = availableMelonLoaderUpdate.targets[0];
            setDismissedMelonLoaderVersion(availableMelonLoaderUpdate.latestVersion);
            setMelonLoaderUpdateNotice(null);
            void updateSettings({
              melonLoaderUpdate: {
                ...(settings?.melonLoaderUpdate ?? {}),
                dismissedVersion: availableMelonLoaderUpdate.latestVersion,
              },
            });
            openEnvironmentsWorkspace(firstTarget?.environmentId);
          }}
          onDismiss={() => {
            setDismissedMelonLoaderVersion(availableMelonLoaderUpdate.latestVersion);
            setMelonLoaderUpdateNotice(null);
            void updateSettings({
              melonLoaderUpdate: {
                ...(settings?.melonLoaderUpdate ?? {}),
                dismissedVersion: availableMelonLoaderUpdate.latestVersion,
              },
            });
          }}
        />
      )}

      {modIntegrationNotice && !modIntegrationReviewEnvironmentId && (() => {
        const environment = environments.find(
          (item) => item.id === modIntegrationNotice.environmentId,
        );
        return (
          <section
            className="mod-integration-notice"
            role="status"
            aria-live="assertive"
            aria-labelledby="mod-integration-notice-title"
          >
            <header className="mod-integration-notice__header">
              <div>
                <strong id="mod-integration-notice-title">
                  {modIntegrationNotice.operation === 'requestManagement'
                    ? 'Mod management request'
                    : 'Mod update request'}
                </strong>
              </div>
              <SimmIconButton
                className="window-control-btn mod-integration-notice__dismiss"
                onClick={() => {
                  dismissedModIntegrationRequestsRef.current.add(modIntegrationNotice.id);
                  setModIntegrationNotice(null);
                  void refreshPendingModIntegrationRequest();
                }}
                aria-label="Remind me about this mod update later"
                title="Remind me later"
              >
                <Icon name="times" />
              </SimmIconButton>
            </header>
            <p>
              <strong>{modIntegrationNotice.modName}</strong>{' '}
              {modIntegrationNotice.operation === 'requestManagement'
                ? 'asked SIMM to manage its existing local installation'
                : 'requested an update'}
              {modIntegrationNotice.operation !== 'requestManagement'
                && modIntegrationNotice.currentVersion
                && modIntegrationNotice.targetVersion
                ? ` from ${modIntegrationNotice.currentVersion} to ${modIntegrationNotice.targetVersion}`
                : ''}
              {environment ? ` for ${environment.name}` : ''}.
            </p>
            <div className="mod-integration-notice__actions">
              <SimmButton
                variant="secondary"
                className="btn btn-secondary btn-small"
                onClick={() => {
                  dismissedModIntegrationRequestsRef.current.add(modIntegrationNotice.id);
                  setModIntegrationNotice(null);
                  void refreshPendingModIntegrationRequest();
                }}
              >
                Later
              </SimmButton>
              <SimmButton
                className="btn btn-primary btn-small"
                onClick={() => setModIntegrationReviewEnvironmentId(modIntegrationNotice.environmentId)}
                disabled={!environment}
              >
                Review Request
              </SimmButton>
            </div>
          </section>
        );
      })()}

      {modIntegrationReviewEnvironmentId && (() => {
        const environment = environments.find(
          (item) => item.id === modIntegrationReviewEnvironmentId,
        );
        return environment ? (
          <Suspense fallback={null}>
            <ModIntegrationDialog
              isOpen={true}
              environment={environment}
              onClose={() => setModIntegrationReviewEnvironmentId(null)}
              onManageRequest={(request: ModIntegrationRequestRecord) => {
                dismissedModIntegrationRequestsRef.current.add(request.id);
                setModIntegrationNotice(null);
                setModIntegrationReviewEnvironmentId(null);
                pushWorkspace(
                  { view: 'mods', environmentId: request.environmentId },
                  {
                    modsState: {
                      modsTab: 'installed',
                      localSourceLinkRequest: {
                        requestId: request.id,
                        fileName: request.modFileName,
                        currentVersion: request.currentVersion,
                      },
                    },
                  },
                );
              }}
            />
          </Suspense>
        ) : null;
      })()}

      {appNotice && (
        <div className="app-notice app-notice--danger" role="alert" aria-live="assertive">
          <div className="app-notice__header">
            <strong>Nexus Download Blocked</strong>
            <SimmIconButton
              className="window-control-btn app-notice__dismiss"
              onClick={() => setAppNotice(null)}
              aria-label="Dismiss notice"
            >
              <Icon name="times" />
            </SimmIconButton>
          </div>
          <span className="app-notice__body">{appNotice}</span>
        </div>
      )}

      {pendingNexusRuntimeSelection && (
        <Dialog open={!!pendingNexusRuntimeSelection} onOpenChange={(open) => {
          if (!open) {
            void handleCancelNexusRuntimeSelection();
          }
        }}>
          <SimmDialogContent
            className="app-dialog app-dialog--message app-runtime-dialog"
            showCloseButton={false}
          >
            <DialogHeader className="modal-header">
              <DialogTitle>Select Runtime</DialogTitle>
              <SimmButton variant="ghost" size="icon-sm" className="modal-close" onClick={() => void handleCancelNexusRuntimeSelection()} aria-label="Close runtime selection dialog"><Icon name="times" /></SimmButton>
            </DialogHeader>
            <div className="app-dialog__body app-runtime-dialog__body">
              <div className="app-dialog__callout app-dialog__callout--info">
                <div className="app-dialog__icon">
                  <Icon name="microchip" />
                </div>
                <div className="app-dialog__meta">
                  <strong>Runtime selection required</strong>
                  <DialogDescription>
                    SIMM could not determine the runtime for this Nexus download. Choose the runtime before it is added to the library or installed.
                  </DialogDescription>
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
            <DialogFooter className="app-dialog__footer">
              <div className="app-runtime-dialog__actions">
                <SimmButton className="btn btn-secondary" onClick={() => void handleCancelNexusRuntimeSelection()}>
                  Cancel
                </SimmButton>
                <div className="app-runtime-dialog__runtime-actions">
                  <SimmButton className="btn btn-secondary" onClick={() => void handleNexusRuntimeSelection('Mono')}>
                    Use Mono
                  </SimmButton>
                  <SimmButton className="btn btn-secondary" onClick={() => void handleNexusRuntimeSelection('Both')}>
                    Use Both
                  </SimmButton>
                  <SimmButton className="btn btn-primary" onClick={() => void handleNexusRuntimeSelection('IL2CPP')}>
                    Use IL2CPP
                  </SimmButton>
                </div>
              </div>
            </DialogFooter>
          </SimmDialogContent>
        </Dialog>
      )}

      <Dialog open={!!runtimeSwitchNotice} onOpenChange={(open) => {
        if (!open) setRuntimeSwitchNotice(null);
      }}>
        <SimmDialogContent className="app-dialog app-dialog--message app-runtime-dialog" showCloseButton={false}>
          <DialogHeader className="modal-header app-dialog__header">
            <DialogTitle>Steam Runtime Changed</DialogTitle>
            <SimmButton variant="ghost" size="icon-sm" className="modal-close" onClick={() => setRuntimeSwitchNotice(null)} aria-label="Close runtime switch notice">
              <Icon name="times" />
            </SimmButton>
          </DialogHeader>
          {runtimeSwitchNotice && (
            <div className="app-dialog__body app-runtime-dialog__body">
              <div className="app-dialog__callout app-dialog__callout--warning">
                <div className="app-dialog__icon"><Icon name="triangleExclamation" /></div>
                <div className="app-dialog__meta">
                  <strong>{runtimeSwitchNotice.environmentName} changed from {runtimeDisplayName(runtimeSwitchNotice.previousRuntime)} to {runtimeDisplayName(runtimeSwitchNotice.runtime)}</strong>
                  <DialogDescription>
                    SIMM disabled {runtimeSwitchNotice.disabledItems} {runtimeDisplayName(runtimeSwitchNotice.previousRuntime)} item(s) and installed {runtimeSwitchNotice.installedItems} downloaded {runtimeDisplayName(runtimeSwitchNotice.runtime)} replacement(s).
                  </DialogDescription>
                </div>
              </div>
              {runtimeSwitchNotice.missingItems.length > 0 && (
                <div className="app-runtime-dialog__details">
                  <strong>No downloaded {runtimeDisplayName(runtimeSwitchNotice.runtime)} version was found for:</strong>
                  <span>{runtimeSwitchNotice.missingItems.join(', ')}</span>
                  <span>Those items remain disabled. Download their {runtimeDisplayName(runtimeSwitchNotice.runtime)} versions before enabling them.</span>
                </div>
              )}
              {runtimeSwitchNotice.errors.length > 0 && (
                <div className="app-runtime-dialog__details">
                  <strong>SIMM also encountered:</strong>
                  {runtimeSwitchNotice.errors.map((error) => <span key={error}>{error}</span>)}
                </div>
              )}
            </div>
          )}
          <DialogFooter className="app-dialog__footer">
            <SimmButton className="btn btn-primary" onClick={() => setRuntimeSwitchNotice(null)} autoFocus>OK</SimmButton>
          </DialogFooter>
        </SimmDialogContent>
      </Dialog>

      <Dialog open={closePrompt.isOpen} onOpenChange={(open) => {
        if (!open) {
          dismissClosePrompt();
        }
      }}>
        <SimmDialogContent className="app-dialog app-dialog--message app-close-behavior-dialog" showCloseButton={false}>
          <DialogHeader className="modal-header app-dialog__header">
            <DialogTitle>Close SIMM</DialogTitle>
            <SimmButton variant="ghost" size="icon-sm" className="modal-close" onClick={dismissClosePrompt} aria-label="Close close behavior dialog">
              <Icon name="times" />
            </SimmButton>
          </DialogHeader>
          <div className="app-dialog__body">
            <div className="app-dialog__callout app-dialog__callout--info">
              <div className="app-dialog__icon"><Icon name="circleQuestion" /></div>
              <div className="app-dialog__meta">
                <strong>Keep SIMM available in the tray?</strong>
                <DialogDescription>Tray mode keeps monitoring and configured update checks running while the window is hidden.</DialogDescription>
              </div>
            </div>
            <label className="app-dialog__option">
              <Checkbox checked={closePrompt.remember} onCheckedChange={(checked) => setClosePrompt((current) => ({ ...current, remember: Boolean(checked) }))} />
              <span className="app-dialog__option-copy"><strong>Remember my choice</strong></span>
            </label>
          </div>
          <DialogFooter className="app-dialog__footer">
            <div className="app-dialog__actions">
              <SimmButton variant="secondary" className="btn btn-secondary" onClick={() => void resolveClosePrompt('quit')}>Quit SIMM</SimmButton>
              <SimmButton className="btn btn-primary" onClick={() => void resolveClosePrompt('tray')} autoFocus>Hide to Tray</SimmButton>
            </div>
          </DialogFooter>
        </SimmDialogContent>
      </Dialog>
    </div>
  );
}

export function App() {
  const appContent = (
    <SettingsStoreProvider>
      <EnvironmentStoreProvider>
        <ModLibraryStoreProvider>
          <DownloadStatusStoreProvider>
            <AppDialogProvider><GameLaunchStoreProvider><AppContent /></GameLaunchStoreProvider></AppDialogProvider>
          </DownloadStatusStoreProvider>
        </ModLibraryStoreProvider>
      </EnvironmentStoreProvider>
    </SettingsStoreProvider>
  );

  return (
    <ErrorBoundary>
      {import.meta.env.MODE === 'test' ? appContent : (
        <StartupGate>
          {appContent}
        </StartupGate>
      )}
    </ErrorBoundary>
  );
}
