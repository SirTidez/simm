import { useState, useEffect, useId, useRef, useCallback, type ReactNode } from "react";
import { useSettingsStore } from "../stores/settingsStore";
import { useEnvironmentStore } from "../stores/environmentStore";
import { ApiService } from "../services/api";
import {
  batchUpdateCheckRef,
  lastUpdateCheckTimeRef,
  notifyBatchUpdateCheckStarted,
} from "../services/updateCheckCoordinator";
import type {
  CustomThemeDefinition,
  LinuxReadinessCheckStatus,
  LinuxReadinessStatus,
  SecurityScannerStatus,
  TelemetryPreferences,
} from "../types";
import type { Settings as AppSettings } from "../types";
import type { ExperienceMode } from "../types";
import { resolveExperienceMode, resolveShowAdvancedGameTools } from "../utils/uxSettings";
import { Icon } from './Icon';
import {
  Dialog,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { SimmButton, SimmDialogContent } from './primitives';

type SettingsProps = {
  isOpen: boolean;
  onClose: () => void;
  onRunSetupGuide?: () => void;
};

type SettingsFormData = {
  defaultDownloadDir: string;
  maxConcurrentDownloads: number;
  platform: "windows" | "macos" | "linux";
  language: string;
  theme: string;
  melonLoaderVersion: string;
  autoInstallMelonLoader: boolean;
  enableSecurityScanner?: boolean;
  autoInstallSecurityScanner?: boolean;
  blockCriticalScans?: boolean;
  promptOnHighScans?: boolean;
  showSecurityScanBadges?: boolean;
  updateCheckInterval: number;
  autoCheckUpdates: boolean;
  appUpdateChannel: "stable" | "beta";
  logLevel: "debug" | "info" | "warn" | "error";
  modIconCacheLimitMb: number;
  databaseBackupCount: number;
  experienceMode: ExperienceMode;
  showAdvancedGameTools: boolean;
};

const MIN_MOD_ICON_CACHE_LIMIT_MB = 100;
const MAX_MOD_ICON_CACHE_LIMIT_MB = 8192;
const MIN_DATABASE_BACKUP_COUNT = 1;
const MAX_DATABASE_BACKUP_COUNT = 100;
const BUILT_IN_THEME_OPTIONS = [
  { id: "modern-blue", label: "Modern Blue" },
  { id: "dark", label: "Dark" },
  { id: "light", label: "Light" },
] as const;

const DATE_TIME_FORMAT = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

function getCustomThemeDescription(theme: CustomThemeDefinition): string {
  const variableCount = Object.keys(theme.variables).length;
  const suffix = variableCount === 1 ? "variable" : "variables";
  return `${theme.baseTheme} base, ${variableCount} ${suffix}`;
}

function getActiveBuiltInTheme(
  selectedThemeId: string,
  customThemes: CustomThemeDefinition[],
): string {
  const activeCustomTheme = customThemes.find((theme) => theme.id === selectedThemeId);
  if (activeCustomTheme) {
    return activeCustomTheme.baseTheme;
  }

  return BUILT_IN_THEME_OPTIONS.find((theme) => theme.id === selectedThemeId)?.id || "modern-blue";
}

function TelemetrySettingsPanel() {
  const [preferences, setPreferences] = useState<TelemetryPreferences | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    const loadPreferences = ApiService.getTelemetryPreferences;
    if (typeof loadPreferences === 'function') {
      void loadPreferences().then(setPreferences).catch((error) => {
        setFeedback(error instanceof Error ? error.message : 'Failed to load telemetry preferences.');
      });
    }
  }, []);
  const save = async (updates: Partial<TelemetryPreferences>) => {
    const savePreferences = ApiService.saveTelemetryPreferences;
    if (typeof savePreferences === 'function') {
      setSaving(true);
      try {
        const next = await savePreferences(updates);
        setPreferences(next);
        setFeedback('Telemetry preference saved.');
      } catch (error) {
        setFeedback(error instanceof Error ? error.message : 'Failed to save telemetry preference.');
      } finally {
        setSaving(false);
      }
    }
  };
  const feedbackIsError = Boolean(feedback && (feedback.includes('Failed') || feedback.includes('not available')));
  return (
    <>
      <SettingsToggle
        label="Collect local telemetry"
        description="Record warnings and errors while a registered environment is running. Nothing leaves this device until you review an export."
        checked={preferences?.collectionEnabled ?? false}
        onChange={(collectionEnabled) => void save({ collectionEnabled })}
      />
      <SettingsToggle
        label="Permit sanitized diagnostic excerpts"
        description="Reviewed uploads may keep a short, sanitized excerpt of each error in addition to its structured identity."
        checked={preferences?.errorExcerptsEnabled ?? false}
        onChange={(errorExcerptsEnabled) => void save({ errorExcerptsEnabled })}
      />
      <SettingRow label="Local retention" help="How long captured telemetry stays on this device.">
        <SettingsSelect
          ariaLabel="Telemetry retention"
          value={String(preferences?.retentionDays ?? 30)}
          onValueChange={(value) => void save({ retentionDays: Number(value) })}
          options={[{ value: '7', label: '7 days' }, { value: '14', label: '14 days' }, { value: '30', label: '30 days' }, { value: '90', label: '90 days' }]}
        />
      </SettingRow>
      {(feedback || saving) && (
        <p
          className={`settings-feedback${feedbackIsError && !saving ? ' settings-feedback--error' : ''}`}
          role={feedbackIsError && !saving ? 'alert' : 'status'}
        >
          {saving ? 'Saving telemetry preference…' : feedback}
        </p>
      )}
    </>
  );
}

function WindowBehaviorSettingsPanel() {
  const { settings, updateSettings, loading } = useSettingsStore();

  return (
    <SettingRow
      label="When the window closes"
      help="Ask each time, keep SIMM running in the tray, or quit the app."
    >
      <SettingsSelect
        ariaLabel="Window close behavior"
        value={settings?.windowCloseBehavior ?? 'ask'}
        onValueChange={(windowCloseBehavior) => void updateSettings({ windowCloseBehavior: windowCloseBehavior as 'ask' | 'tray' | 'quit' })}
        disabled={loading}
        options={[{ value: 'ask', label: 'Ask every time' }, { value: 'tray', label: 'Hide to tray' }, { value: 'quit', label: 'Quit SIMM' }]}
      />
    </SettingRow>
  );
}

export function normalizeModIconCacheLimitMb(value: unknown): number {
  const parsed =
    typeof value === "number"
      ? value
      : Number.parseInt(String(value ?? ""), 10);

  if (!Number.isFinite(parsed)) {
    return 500;
  }

  const rounded = Math.trunc(parsed as number);
  return Math.min(
    MAX_MOD_ICON_CACHE_LIMIT_MB,
    Math.max(MIN_MOD_ICON_CACHE_LIMIT_MB, rounded),
  );
}

export function normalizeDatabaseBackupCount(value: unknown): number {
  const parsed =
    typeof value === "number"
      ? value
      : Number.parseInt(String(value ?? ""), 10);

  if (!Number.isFinite(parsed)) {
    return 10;
  }

  const rounded = Math.trunc(parsed as number);
  return Math.min(
    MAX_DATABASE_BACKUP_COUNT,
    Math.max(MIN_DATABASE_BACKUP_COUNT, rounded),
  );
}

function extractReleaseApiLastUpdated(
  health: Record<string, unknown> | null,
): string | null {
  if (!health) return null;

  const data = (health as { data?: Record<string, unknown> }).data;
  const candidates = [
    health.lastUpdated,
    health.last_updated,
    health.updatedAt,
    health.updated_at,
    health.timestamp,
    data?.lastUpdated,
    data?.last_updated,
    data?.updatedAt,
    data?.updated_at,
  ];

  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      const parsed = new Date(candidate);
      if (!Number.isNaN(parsed.getTime())) {
        return DATE_TIME_FORMAT.format(parsed);
      }
      return candidate;
    }
  }

  return null;
}

function getReadinessStatusLabel(status: LinuxReadinessCheckStatus): string {
  switch (status) {
    case "ready":
      return "Ready";
    case "warning":
      return "Needs review";
    case "missing":
      return "Missing";
    case "unknown":
      return "Unknown";
    case "notApplicable":
      return "Not applicable";
    default:
      return status;
  }
}

type StatusTone = "ok" | "warn" | "danger" | "info" | "muted";

function getReadinessTone(status: LinuxReadinessCheckStatus): StatusTone {
  if (status === "ready") {
    return "ok";
  }

  if (status === "missing") {
    return "danger";
  }

  if (status === "notApplicable") {
    return "muted";
  }

  return "warn";
}

function buildFormDataFromSettings(settings: AppSettings): SettingsFormData {
  return {
    defaultDownloadDir: settings.defaultDownloadDir || "",
    maxConcurrentDownloads: settings.maxConcurrentDownloads || 2,
    platform: settings.platform ?? "windows",
    language: "english",
    theme: settings.theme || "modern-blue",
    melonLoaderVersion: settings.melonLoaderVersion || "",
    autoInstallMelonLoader: settings.autoInstallMelonLoader !== false,
    enableSecurityScanner: settings.enableSecurityScanner ?? true,
    autoInstallSecurityScanner: settings.autoInstallSecurityScanner ?? true,
    blockCriticalScans: settings.blockCriticalScans ?? true,
    promptOnHighScans: settings.promptOnHighScans ?? true,
    showSecurityScanBadges: settings.showSecurityScanBadges ?? true,
    updateCheckInterval: settings.updateCheckInterval || 60,
    autoCheckUpdates: settings.autoCheckUpdates !== false,
    appUpdateChannel: settings.appUpdate?.channel ?? "stable",
    logLevel:
      (settings.logLevel as "debug" | "info" | "warn" | "error") || "info",
    modIconCacheLimitMb: normalizeModIconCacheLimitMb(
      settings.modIconCacheLimitMb,
    ),
    databaseBackupCount: normalizeDatabaseBackupCount(
      settings.databaseBackupCount,
    ),
    experienceMode: resolveExperienceMode(settings),
    showAdvancedGameTools: resolveShowAdvancedGameTools(settings),
  };
}

function areFormDataEqual(
  left: SettingsFormData,
  right: SettingsFormData,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

type SettingsSectionId =
  | "app"
  | "updates"
  | "downloads"
  | "mods"
  | "security"
  | "diagnostics"
  | "window";

const SETTINGS_SECTIONS: ReadonlyArray<{ id: SettingsSectionId; label: string }> = [
  { id: "app", label: "App" },
  { id: "updates", label: "Updates" },
  { id: "downloads", label: "Downloads & storage" },
  { id: "mods", label: "Mods & cache" },
  { id: "security", label: "Security" },
  { id: "diagnostics", label: "Diagnostics" },
  { id: "window", label: "Window" },
];

function SettingsGroup({
  id,
  title,
  children,
}: {
  id: SettingsSectionId;
  title: string;
  children: ReactNode;
}) {
  const headingId = `settings-section-${id}-title`;
  return (
    <section
      className="settings-group"
      data-settings-section={id}
      aria-labelledby={headingId}
    >
      <h3 id={headingId} className="settings-group__title">
        {title}
      </h3>
      <div className="settings-group__rows">{children}</div>
    </section>
  );
}

function SettingRow({
  label,
  help,
  labelFor,
  children,
  stacked = false,
}: {
  label: ReactNode;
  help?: ReactNode;
  labelFor?: string;
  children?: ReactNode;
  stacked?: boolean;
}) {
  return (
    <div className={stacked ? "settings-row settings-row--stacked" : "settings-row"}>
      <div className="settings-row__text">
        {labelFor ? (
          <label className="settings-row__label" htmlFor={labelFor}>
            {label}
          </label>
        ) : (
          <span className="settings-row__label">{label}</span>
        )}
        {help && <div className="settings-row__help">{help}</div>}
      </div>
      {children && <div className="settings-row__control">{children}</div>}
    </div>
  );
}

type SettingsToggleProps = {
  label: string;
  description: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
};

function SettingsToggle({
  label,
  description,
  checked,
  onChange,
  disabled = false,
}: SettingsToggleProps) {
  const id = useId();

  return (
    <div
      className="settings-row settings-row--toggle"
      data-disabled={disabled ? "true" : undefined}
      onClick={(event) => {
        if (disabled) return;
        if ((event.target as HTMLElement).closest('[data-slot="switch"]')) return;
        onChange(!checked);
      }}
    >
      <div className="settings-row__text">
        <span className="settings-row__label">{label}</span>
        <div className="settings-row__help">{description}</div>
      </div>
      <div className="settings-row__control">
        <Switch
          id={id}
          checked={checked}
          onCheckedChange={onChange}
          disabled={disabled}
          aria-label={label}
          className="settings-switch"
        />
      </div>
    </div>
  );
}

type SettingsSelectOption = {
  value: string;
  label: string;
  disabled?: boolean;
};

type SettingsSelectProps = {
  ariaLabel: string;
  value: string;
  options: SettingsSelectOption[];
  onValueChange: (value: string) => void;
  disabled?: boolean;
};

function SettingsSelect({
  ariaLabel,
  value,
  options,
  onValueChange,
  disabled = false,
}: SettingsSelectProps) {
  return (
    <Select
      value={value}
      onValueChange={(nextValue) => {
        if (typeof nextValue === "string") {
          onValueChange(nextValue);
        }
      }}
      disabled={disabled}
    >
      <SelectTrigger className="settings-select" aria-label={ariaLabel}>
        <SelectValue>
          {(selectedValue) =>
            options.find((option) => option.value === selectedValue)?.label ||
            options.find((option) => option.value === value)?.label ||
            ariaLabel
          }
        </SelectValue>
      </SelectTrigger>
      <SelectContent className="settings-select-content" align="start">
        <SelectGroup>
          {options.map((option) => (
            <SelectItem
              key={option.value}
              value={option.value}
              disabled={option.disabled}
            >
              {option.label}
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  );
}

export function Settings({ isOpen, onClose, onRunSetupGuide }: SettingsProps) {
  const {
    settings,
    customThemes,
    themesDirectory,
    depotDownloader,
    loading,
    updateSettings,
    refreshDepotDownloader,
    refreshThemes,
  } = useSettingsStore();
  const { environments, checkAllUpdates } = useEnvironmentStore();
  const [checkingAllUpdates, setCheckingAllUpdates] = useState(false);
  const [releaseApiHealth, setReleaseApiHealth] = useState<Record<
    string,
    unknown
  > | null>(null);
  const [releaseApiError, setReleaseApiError] = useState<string | null>(null);
  const [checkingReleaseApi, setCheckingReleaseApi] = useState(false);
  const [backingUpDatabase, setBackingUpDatabase] = useState(false);
  const [repairingDatabase, setRepairingDatabase] = useState(false);
  const [openingBackupsFolder, setOpeningBackupsFolder] = useState(false);
  const [databaseBackupFeedback, setDatabaseBackupFeedback] = useState<{
    tone: "success" | "error";
    message: string;
  } | null>(null);
  const [themeFeedback, setThemeFeedback] = useState<{
    tone: "success" | "error";
    message: string;
  } | null>(null);
  const [formData, setFormData] = useState<SettingsFormData>({
    defaultDownloadDir: "",
    maxConcurrentDownloads: 2,
    platform: "windows" as "windows" | "macos" | "linux",
    language: "english",
    theme: "modern-blue",
    melonLoaderVersion: "",
    autoInstallMelonLoader: true,
    enableSecurityScanner: true,
    autoInstallSecurityScanner: true,
    blockCriticalScans: true,
    promptOnHighScans: true,
    showSecurityScanBadges: true,
    updateCheckInterval: 60,
    autoCheckUpdates: true,
    appUpdateChannel: "stable",
    logLevel: "info" as "debug" | "info" | "warn" | "error",
    modIconCacheLimitMb: 500,
    databaseBackupCount: 10,
    experienceMode: "powerUser",
    showAdvancedGameTools: true,
  });
  const [error, setError] = useState<string | null>(null);
  const [telemetryAvailable, setTelemetryAvailable] = useState<boolean | null>(null);
  const [showDirectoryPicker, setShowDirectoryPicker] = useState(false);
  const [directoryPath, setDirectoryPath] = useState("");
  const [directoryList, setDirectoryList] = useState<
    Array<{ name: string; path: string }>
  >([]);
  const [browsing, setBrowsing] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [melonLoaderVersions, setMelonLoaderVersions] = useState<
    Array<{ tag: string; name: string }>
  >([]);
  const [loadingVersions, setLoadingVersions] = useState(false);
  const [securityScannerStatus, setSecurityScannerStatus] =
    useState<SecurityScannerStatus | null>(null);
  const [loadingSecurityScannerStatus, setLoadingSecurityScannerStatus] =
    useState(false);
  const [installingSecurityScanner, setInstallingSecurityScanner] =
    useState(false);
  const [linuxReadinessStatus, setLinuxReadinessStatus] =
    useState<LinuxReadinessStatus | null>(null);
  const [loadingLinuxReadiness, setLoadingLinuxReadiness] = useState(false);
  const [repairingLinuxDesktopIntegration, setRepairingLinuxDesktopIntegration] =
    useState(false);
  const [linuxReadinessFeedback, setLinuxReadinessFeedback] = useState<{
    tone: "success" | "error";
    message: string;
  } | null>(null);
  const [openingThemesFolder, setOpeningThemesFolder] = useState(false);
  const [reloadingThemes, setReloadingThemes] = useState(false);
  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saveQueueRef = useRef<Promise<void>>(Promise.resolve());
  const pendingSaveRef = useRef<SettingsFormData | null>(null);
  const persistedFormDataRef = useRef<SettingsFormData | null>(null);
  const skipNextAutoSaveRef = useRef(false);
  const formDataRef = useRef(formData);
  const settingsRef = useRef(settings);
  const isMountedRef = useRef(true);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const programmaticScrollUntilRef = useRef(0);
  const [activeSection, setActiveSection] = useState<SettingsSectionId>("app");

  useEffect(() => {
    formDataRef.current = formData;
  }, [formData]);

  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);

  useEffect(() => () => {
    isMountedRef.current = false;
  }, []);

  useEffect(() => {
    let disposed = false;
    if (!isOpen) return () => { disposed = true; };

    void ApiService.getTelemetryCapability()
      .then((capability) => {
        if (!disposed) setTelemetryAvailable(capability.available);
      })
      .catch(() => {
        // Settings should not expose actions the backend says it cannot serve.
        if (!disposed) setTelemetryAvailable(false);
      });
    return () => { disposed = true; };
  }, [isOpen]);

  const runCheckAllUpdates = async () => {
    try {
      setCheckingAllUpdates(true);
      lastUpdateCheckTimeRef.current = Date.now();
      batchUpdateCheckRef.current = true;
      notifyBatchUpdateCheckStarted(
        environments
          .filter((env) => env.status === "completed")
          .map((env) => env.id),
      );
      await checkAllUpdates(true);
    } catch (err) {
      setError(
        `Failed to check for updates: ${err instanceof Error ? err.message : "Unknown error"}`,
      );
    } finally {
      batchUpdateCheckRef.current = false;
      setCheckingAllUpdates(false);
    }
  };

  // Keep escape close behavior predictable in docked mode
  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape" && isOpen) {
        if (showDirectoryPicker) {
          setShowDirectoryPicker(false);
          return;
        }
        onClose();
      }
    };

    if (isOpen) {
      document.addEventListener("keydown", handleEscape);
    }

    return () => {
      document.removeEventListener("keydown", handleEscape);
    };
  }, [isOpen, onClose, showDirectoryPicker]);

  useEffect(() => {
    if (settings) {
      const nextFormData = buildFormDataFromSettings(settings);
      const currentFormData = formDataRef.current;
      const previousPersisted = persistedFormDataRef.current;

      // A settings-store refresh can arrive after the user has made a newer
      // local edit. Never replace that draft with the older response.
      if (
        previousPersisted
        && !areFormDataEqual(currentFormData, previousPersisted)
        && !areFormDataEqual(currentFormData, nextFormData)
      ) {
        return;
      }

      persistedFormDataRef.current = nextFormData;
      if (!areFormDataEqual(currentFormData, nextFormData)) {
        skipNextAutoSaveRef.current = true;
      }
      setFormData((current) =>
        areFormDataEqual(current, nextFormData) ? current : nextFormData,
      );
    }
  }, [settings]);

  useEffect(() => {
    if (!isOpen) return;

    const loadReleaseApiHealth = async () => {
      setCheckingReleaseApi(true);
      setReleaseApiError(null);
      try {
        const health = await ApiService.getReleaseApiHealth();
        setReleaseApiHealth(health);
      } catch (err) {
        setReleaseApiHealth(null);
        setReleaseApiError(
          err instanceof Error ? err.message : "Release API is unavailable",
        );
      } finally {
        setCheckingReleaseApi(false);
      }
    };

    void loadReleaseApiHealth();
  }, [isOpen]);

  // Load available MelonLoader versions when modal opens
  useEffect(() => {
    if (isOpen && melonLoaderVersions.length === 0) {
      setLoadingVersions(true);
      ApiService.getAvailableMelonLoaderVersions()
        .then((versions) => {
          setMelonLoaderVersions(versions);
        })
        .catch((err) => {
          console.error("Failed to load MelonLoader versions:", err);
          setError("Failed to load MelonLoader versions");
        })
        .finally(() => {
          setLoadingVersions(false);
        });
    }
  }, [isOpen, melonLoaderVersions.length]);

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    setLoadingSecurityScannerStatus(true);
    ApiService.getSecurityScannerStatus()
      .then((status) => {
        setSecurityScannerStatus(status);
      })
      .catch((err) => {
        console.error("Failed to load security scanner status:", err);
        setSecurityScannerStatus(null);
      })
      .finally(() => {
        setLoadingSecurityScannerStatus(false);
      });
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen || settings?.platform !== "linux") {
      setLinuxReadinessStatus(null);
      return;
    }

    setLoadingLinuxReadiness(true);
    setLinuxReadinessFeedback(null);
    ApiService.getLinuxReadinessStatus()
      .then((status) => {
        setLinuxReadinessStatus(status);
      })
      .catch((err) => {
        console.error("Failed to load Linux readiness status:", err);
        setLinuxReadinessStatus(null);
        setLinuxReadinessFeedback({
          tone: "error",
          message:
            err instanceof Error
              ? err.message
              : "Failed to load Linux readiness status",
        });
      })
      .finally(() => {
        setLoadingLinuxReadiness(false);
      });
  }, [isOpen, settings?.platform]);

  const enqueueSettingsSave = useCallback((snapshot: SettingsFormData) => {
    const persisted = persistedFormDataRef.current;
    if (!settingsRef.current || (persisted && areFormDataEqual(snapshot, persisted))) {
      return;
    }

    saveQueueRef.current = saveQueueRef.current
      .catch(() => undefined)
      .then(async () => {
        const settingsSnapshot = settingsRef.current;
        if (!settingsSnapshot) return;

        try {
          if (isMountedRef.current) setError(null);
          // Platform and language are not user-configurable here, but they
          // must preserve the backend defaults for the host OS.
          await updateSettings({
            defaultDownloadDir: snapshot.defaultDownloadDir,
            maxConcurrentDownloads: snapshot.maxConcurrentDownloads,
            theme: snapshot.theme,
            melonLoaderVersion: snapshot.melonLoaderVersion,
            autoInstallMelonLoader: snapshot.autoInstallMelonLoader,
            enableSecurityScanner: snapshot.enableSecurityScanner,
            autoInstallSecurityScanner: snapshot.autoInstallSecurityScanner,
            blockCriticalScans: snapshot.blockCriticalScans,
            promptOnHighScans: snapshot.promptOnHighScans,
            showSecurityScanBadges: snapshot.showSecurityScanBadges,
            updateCheckInterval: snapshot.updateCheckInterval,
            autoCheckUpdates: snapshot.autoCheckUpdates,
            appUpdate: {
              ...(settingsSnapshot.appUpdate ?? {}),
              channel: snapshot.appUpdateChannel,
            },
            logLevel: snapshot.logLevel,
            modIconCacheLimitMb: normalizeModIconCacheLimitMb(snapshot.modIconCacheLimitMb),
            databaseBackupCount: normalizeDatabaseBackupCount(snapshot.databaseBackupCount),
            experienceMode: snapshot.experienceMode,
            showAdvancedGameTools: snapshot.showAdvancedGameTools,
            setupGuideCompleted: true,
            platform: snapshot.platform,
            language: "english",
          });
          persistedFormDataRef.current = snapshot;
        } catch (err) {
          if (isMountedRef.current) {
            setError(err instanceof Error ? err.message : "Failed to save settings");
          }
        }
      });
  }, [updateSettings]);

  const flushPendingSettingsSave = useCallback(() => {
    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current);
      saveTimeoutRef.current = null;
    }
    const snapshot = pendingSaveRef.current;
    pendingSaveRef.current = null;
    if (snapshot) enqueueSettingsSave(snapshot);
  }, [enqueueSettingsSave]);

  // Auto-save with debouncing. Keep the pending snapshot in a ref so closing
  // or unmounting Settings flushes it instead of silently dropping the edit.
  useEffect(() => {
    if (!settings || !isOpen) return;

    if (skipNextAutoSaveRef.current) {
      skipNextAutoSaveRef.current = false;
      return;
    }

    const currentPersistedFormData = persistedFormDataRef.current ?? buildFormDataFromSettings(settings);
    if (areFormDataEqual(formData, currentPersistedFormData)) return;

    pendingSaveRef.current = formData;
    if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
    saveTimeoutRef.current = setTimeout(() => {
      saveTimeoutRef.current = null;
      const snapshot = pendingSaveRef.current;
      pendingSaveRef.current = null;
      if (snapshot) enqueueSettingsSave(snapshot);
    }, 500);

    return () => {
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current);
        saveTimeoutRef.current = null;
      }
    };
  }, [enqueueSettingsSave, formData, isOpen, settings]);

  useEffect(() => {
    if (!isOpen) flushPendingSettingsSave();
  }, [flushPendingSettingsSave, isOpen]);

  useEffect(() => () => {
    flushPendingSettingsSave();
  }, [flushPendingSettingsSave]);

  const getParentPath = (currentPath: string): string | null => {
    if (!currentPath) return null;
    // Handle Windows paths (C:\, D:\, etc.)
    const isWindowsRoot = /^[A-Z]:\\?$/i.test(currentPath);
    if (isWindowsRoot) return null;

    // Handle Unix paths (/)
    if (currentPath === "/" || currentPath === "\\") return null;

    // Get parent by removing last segment
    const separator = currentPath.includes("/") ? "/" : "\\";
    const parts = currentPath.split(separator).filter((p) => p);

    // If we're at a drive root (C:\), return null
    if (parts.length <= 1 && currentPath.includes(":")) return null;

    // Remove last part
    parts.pop();

    if (parts.length === 0) {
      // Return root
      return separator === "/"
        ? "/"
        : currentPath.match(/^[A-Z]:/i)?.[0] + "\\" || "\\";
    }

    return parts.join(separator) + (separator === "/" ? "/" : "");
  };

  const loadDirectory = async (path: string) => {
    if (!path) return;
    setBrowsing(true);
    try {
      const result = await ApiService.browseDirectory(path);
      setDirectoryPath(result.currentPath);
      setDirectoryList(result.directories);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to browse directory",
      );
      setDirectoryList([]);
    } finally {
      setBrowsing(false);
    }
  };

  const openDirectoryPicker = async () => {
    const currentPath =
      formData.defaultDownloadDir || settings?.defaultDownloadDir || "";
    setDirectoryPath(currentPath);
    setNewFolderName("");
    setShowDirectoryPicker(true);
    if (currentPath) {
      await loadDirectory(currentPath);
    } else {
      setDirectoryList([]);
    }
  };

  const handleCreateFolder = async () => {
    if (!directoryPath || !newFolderName.trim()) {
      return;
    }

    const separator = directoryPath.includes("/") ? "/" : "\\";
    const basePath = directoryPath.replace(/[\\/]+$/, "");
    const nextPath = `${basePath}${separator}${newFolderName.trim()}`;

    setCreatingFolder(true);
    try {
      await ApiService.createDirectory(nextPath);
      setNewFolderName("");
      await loadDirectory(directoryPath);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create folder");
    } finally {
      setCreatingFolder(false);
    }
  };

  const handleDirectorySelect = (selectedPath: string) => {
    setFormData({ ...formData, defaultDownloadDir: selectedPath });
    setShowDirectoryPicker(false);
    setNewFolderName("");
  };

  const depotInstalled = depotDownloader?.installed === true;
  const depotStatusLabel = depotInstalled ? "Installed" : "Missing";
  const releaseApiLastUpdated = extractReleaseApiLastUpdated(releaseApiHealth);
  const releaseApiTone: StatusTone = checkingReleaseApi
    ? "muted"
    : releaseApiError
      ? "danger"
      : "ok";
  const releaseApiLabel = checkingReleaseApi
    ? "Checking"
    : releaseApiError
      ? "Offline"
      : "Online";
  const depotStatusDetail = depotInstalled
    ? depotDownloader.method
      ? `Managed via ${depotDownloader.method}`
      : "Managed automatically for advanced branch installs"
    : depotDownloader?.installHint || "Install DepotDownloader before using advanced branch installs";
  const releaseApiDetail = checkingReleaseApi
    ? "Checking release metadata"
    : releaseApiError
      ? "Unable to reach release metadata"
      : releaseApiLastUpdated
        ? `Last updated ${releaseApiLastUpdated}`
        : "Release metadata available";
  const linuxReadinessSummary = linuxReadinessStatus
    ? getReadinessStatusLabel(linuxReadinessStatus.summary)
    : loadingLinuxReadiness
      ? "Checking"
      : "Unavailable";
  const linuxReadinessTone: StatusTone = linuxReadinessStatus
    ? getReadinessTone(linuxReadinessStatus.summary)
    : loadingLinuxReadiness
      ? "muted"
      : "danger";

  const handleBackupDatabase = async () => {
    try {
      setBackingUpDatabase(true);
      setDatabaseBackupFeedback(null);
      const result = await ApiService.backupDatabase();
      setDatabaseBackupFeedback({
        tone: "success",
        message: `Backup created at ${result.path}`,
      });
    } catch (err) {
      setDatabaseBackupFeedback({
        tone: "error",
        message:
          err instanceof Error ? err.message : "Failed to back up the database",
      });
    } finally {
      setBackingUpDatabase(false);
    }
  };

  const handleOpenBackupsFolder = async () => {
    try {
      setOpeningBackupsFolder(true);
      const backupsDirectory = await ApiService.getBackupsDirectory();
      await ApiService.openPath(backupsDirectory);
    } catch (err) {
      setDatabaseBackupFeedback({
        tone: "error",
        message:
          err instanceof Error
            ? err.message
            : "Failed to open the backups folder",
      });
    } finally {
      setOpeningBackupsFolder(false);
    }
  };

  const handleRepairDatabase = async () => {
    try {
      setRepairingDatabase(true);
      setDatabaseBackupFeedback(null);
      const result = await ApiService.repairDatabase();
      setDatabaseBackupFeedback({
        tone: "success",
        message: `Database repair completed. Backup created at ${result.backupPath}`,
      });
    } catch (err) {
      setDatabaseBackupFeedback({
        tone: "error",
        message: err instanceof Error ? err.message : "Failed to repair the database",
      });
    } finally {
      setRepairingDatabase(false);
    }
  };

  const handleOpenThemesFolder = async () => {
    if (!themesDirectory) {
      setThemeFeedback({
        tone: "error",
        message: "Themes folder is unavailable",
      });
      return;
    }

    try {
      setOpeningThemesFolder(true);
      setThemeFeedback(null);
      await ApiService.openPath(themesDirectory);
    } catch (err) {
      setThemeFeedback({
        tone: "error",
        message:
          err instanceof Error ? err.message : "Failed to open the themes folder",
      });
    } finally {
      setOpeningThemesFolder(false);
    }
  };

  const handleReloadThemes = async () => {
    try {
      setReloadingThemes(true);
      setThemeFeedback(null);
      await refreshThemes();
      setThemeFeedback({
        tone: "success",
        message: "Reloaded theme files from disk",
      });
    } catch (err) {
      setThemeFeedback({
        tone: "error",
        message:
          err instanceof Error ? err.message : "Failed to reload theme files",
      });
    } finally {
      setReloadingThemes(false);
    }
  };

  const handleRefreshLinuxReadiness = async () => {
    try {
      setLoadingLinuxReadiness(true);
      setLinuxReadinessFeedback(null);
      const status = await ApiService.getLinuxReadinessStatus();
      setLinuxReadinessStatus(status);
    } catch (err) {
      setLinuxReadinessFeedback({
        tone: "error",
        message:
          err instanceof Error
            ? err.message
            : "Failed to refresh Linux readiness status",
      });
    } finally {
      setLoadingLinuxReadiness(false);
    }
  };

  const handleRepairLinuxDesktopIntegration = async () => {
    try {
      setRepairingLinuxDesktopIntegration(true);
      setLinuxReadinessFeedback(null);
      const status = await ApiService.repairLinuxDesktopIntegration();
      setLinuxReadinessStatus(status);
      setLinuxReadinessFeedback({
        tone: "success",
        message: "Re-registered SIMM desktop links for this executable.",
      });
    } catch (err) {
      setLinuxReadinessFeedback({
        tone: "error",
        message:
          err instanceof Error
            ? err.message
            : "Failed to repair Linux desktop links",
      });
    } finally {
      setRepairingLinuxDesktopIntegration(false);
    }
  };

  const selectedCustomTheme =
    customThemes.find((theme) => theme.id === formData.theme) ?? null;
  const selectedBuiltInTheme = getActiveBuiltInTheme(formData.theme, customThemes);
  const selectedCustomThemeId = selectedCustomTheme?.id || "";
  const scannerTone: StatusTone = loadingSecurityScannerStatus
    ? "muted"
    : securityScannerStatus?.installed
      ? "ok"
      : "warn";
  const scannerLabel = loadingSecurityScannerStatus
    ? "Checking"
    : securityScannerStatus?.installed
      ? "Installed"
      : "Not installed";
  const scannerDetail = [
    securityScannerStatus?.installedVersion
      ? `Version ${securityScannerStatus.installedVersion}`
      : null,
    securityScannerStatus?.latestVersion
      ? `latest ${securityScannerStatus.latestVersion}`
      : "release metadata unavailable",
    securityScannerStatus?.installMethod
      ? `${securityScannerStatus.installMethod} install`
      : null,
  ]
    .filter(Boolean)
    .join(" · ");

  const scrollToSection = (id: SettingsSectionId) => {
    setActiveSection(id);
    const container = scrollRef.current;
    const target = container?.querySelector<HTMLElement>(
      `[data-settings-section="${id}"]`,
    );
    if (!container || !target) return;
    programmaticScrollUntilRef.current = Date.now() + 800;
    const reduceMotion =
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (typeof container.scrollTo === "function") {
      container.scrollTo({
        top: Math.max(0, target.offsetTop - 8),
        behavior: reduceMotion ? "auto" : "smooth",
      });
    }
    target.querySelector<HTMLElement>(".settings-group__title")?.focus({
      preventScroll: true,
    });
  };

  const handleContentScroll = () => {
    if (Date.now() < programmaticScrollUntilRef.current) return;
    const container = scrollRef.current;
    if (!container) return;
    const sections = Array.from(
      container.querySelectorAll<HTMLElement>("[data-settings-section]"),
    );
    if (sections.length === 0) return;
    let current = sections[0].dataset.settingsSection;
    const atBottom =
      container.scrollTop + container.clientHeight >= container.scrollHeight - 4;
    if (atBottom) {
      current = sections[sections.length - 1].dataset.settingsSection;
    } else {
      for (const section of sections) {
        if (section.offsetTop - container.scrollTop <= 64) {
          current = section.dataset.settingsSection;
        }
      }
    }
    if (current) setActiveSection(current as SettingsSectionId);
  };

  const renderFeedback = (
    feedback: { tone: "success" | "error"; message: string } | null,
  ) =>
    feedback && (
      <p
        className={`settings-feedback settings-feedback--${feedback.tone}`}
        role={feedback.tone === "error" ? "alert" : "status"}
      >
        {feedback.message}
      </p>
    );

  return (
    <>
      {isOpen && (
        <section
          className="workspace-panel ui-page settings-page"
          aria-label="Settings panel"
        >
          <header className="ui-page-header">
            <div className="ui-page-header__titles">
              <h2 className="ui-page-title">Settings</h2>
              <p className="ui-page-subtitle">Changes save automatically.</p>
            </div>
          </header>

          {error && (
            <div className="ui-callout ui-callout--danger settings-page__error" role="alert">
              <Icon name="circleExclamation" />
              <span>{error}</span>
            </div>
          )}

          <div className="settings-layout">
            <nav className="settings-nav" aria-label="Settings sections">
              {SETTINGS_SECTIONS.map((section) => (
                <button
                  key={section.id}
                  type="button"
                  className="settings-nav__item"
                  aria-current={activeSection === section.id ? "true" : undefined}
                  onClick={() => scrollToSection(section.id)}
                >
                  {section.label}
                </button>
              ))}
            </nav>

            <div
              className="settings-content"
              ref={scrollRef}
              onScroll={handleContentScroll}
            >
              <div className="settings-content__inner">
                <SettingsGroup id="app" title="App">
                  <SettingRow
                    label="Theme"
                    help="Built-in palette. Choosing one clears an active custom theme."
                  >
                    <SettingsSelect
                      ariaLabel="Theme preset"
                      value={selectedBuiltInTheme}
                      onValueChange={(value) =>
                        setFormData({ ...formData, theme: value })
                      }
                      disabled={loading}
                      options={BUILT_IN_THEME_OPTIONS.map((theme) => ({
                        value: theme.id,
                        label: theme.label,
                      }))}
                    />
                  </SettingRow>

                  <SettingRow
                    label="Custom theme"
                    help={
                      selectedCustomTheme ? (
                        <>
                          {getCustomThemeDescription(selectedCustomTheme)}
                          <span
                            className="settings-row__path ui-mono"
                            title={selectedCustomTheme.filePath}
                          >
                            {selectedCustomTheme.filePath}
                          </span>
                        </>
                      ) : (
                        "A theme file layered on top of its built-in base palette."
                      )
                    }
                  >
                    <SettingsSelect
                      ariaLabel="Custom theme"
                      value={selectedCustomThemeId}
                      onValueChange={(value) =>
                        setFormData({
                          ...formData,
                          theme: value || selectedBuiltInTheme,
                        })
                      }
                      disabled={loading}
                      options={[
                        { value: "", label: "None" },
                        ...customThemes.map((theme) => ({
                          value: theme.id,
                          label: theme.name,
                        })),
                      ]}
                    />
                  </SettingRow>

                  <SettingRow
                    label="Theme files"
                    stacked
                    help={
                      <>
                        {customThemes.length === 0
                          ? "No custom themes loaded. "
                          : `${customThemes.length} custom ${customThemes.length === 1 ? "theme" : "themes"} loaded. `}
                        Drop JSON files here with <code>baseTheme</code> and{" "}
                        <code>variables</code> keys, then reload.
                        <span
                          className="settings-row__path ui-mono"
                          title={themesDirectory || undefined}
                        >
                          {themesDirectory || "Themes folder unavailable"}
                        </span>
                      </>
                    }
                  >
                    <SimmButton
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => void handleOpenThemesFolder()}
                      disabled={openingThemesFolder || !themesDirectory}
                    >
                      {openingThemesFolder ? "Opening…" : "Open Themes Folder"}
                    </SimmButton>
                    <SimmButton
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => void handleReloadThemes()}
                      disabled={reloadingThemes}
                    >
                      {reloadingThemes ? "Reloading…" : "Reload Theme Files"}
                    </SimmButton>
                  </SettingRow>
                  {renderFeedback(themeFeedback)}

                  <SettingRow
                    label="App mode"
                    help="Power User adds separate Steam branch installs to Add Environment. Everything else is the same in both modes."
                  >
                    <SettingsSelect
                      ariaLabel="App mode"
                      value={formData.experienceMode}
                      onValueChange={(value) => {
                        const nextMode = value as ExperienceMode;
                        setFormData({
                          ...formData,
                          experienceMode: nextMode,
                          showAdvancedGameTools:
                            nextMode === "powerUser"
                              ? true
                              : formData.showAdvancedGameTools,
                        });
                      }}
                      disabled={loading}
                      options={[
                        { value: "player", label: "Player" },
                        { value: "powerUser", label: "Power User" },
                      ]}
                    />
                  </SettingRow>

                  <SettingsToggle
                    label="Show advanced Steam branch installs"
                    description="Offer separate Steam branch installs in Add Environment."
                    checked={formData.showAdvancedGameTools}
                    onChange={(checked) =>
                      setFormData({
                        ...formData,
                        showAdvancedGameTools: checked,
                        experienceMode: checked ? "powerUser" : formData.experienceMode,
                      })
                    }
                  />

                  {onRunSetupGuide && (
                    <SettingRow
                      label="Setup guide"
                      help="Revisit the Player and Power User choices. Installed mods and environments stay as they are."
                    >
                      <SimmButton
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={onRunSetupGuide}
                      >
                        Run Setup Guide Again
                      </SimmButton>
                    </SettingRow>
                  )}
                </SettingsGroup>

                <SettingsGroup id="updates" title="Updates">
                  <SettingsToggle
                    label="Automatically check for updates"
                    description="Check environments and mods in the background at the interval below."
                    checked={formData.autoCheckUpdates !== false}
                    onChange={(checked) =>
                      setFormData({
                        ...formData,
                        autoCheckUpdates: checked,
                      })
                    }
                  />

                  <SettingRow
                    label="Check interval"
                    labelFor="settings-update-interval"
                    help="1 to 1440 minutes. Default 60."
                  >
                    <div className="settings-number">
                      <Input
                        id="settings-update-interval"
                        type="number"
                        value={formData.updateCheckInterval || 60}
                        onChange={(e) =>
                          setFormData({
                            ...formData,
                            updateCheckInterval: parseInt(e.target.value) || 60,
                          })
                        }
                        min="1"
                        max="1440"
                      />
                      <span className="settings-number__unit">minutes</span>
                    </div>
                  </SettingRow>

                  <SettingRow
                    label="App update channel"
                    help="Stable gets production releases. Beta gets prerelease builds."
                  >
                    <SettingsSelect
                      ariaLabel="App update channel"
                      value={formData.appUpdateChannel}
                      onValueChange={(value) =>
                        setFormData({
                          ...formData,
                          appUpdateChannel: value as "stable" | "beta",
                        })
                      }
                      options={[
                        { value: "stable", label: "Stable" },
                        { value: "beta", label: "Beta" },
                      ]}
                    />
                  </SettingRow>

                  <SettingRow
                    label="App updates"
                    help="Check the selected channel now, even when automatic checks are off."
                  >
                    <SimmButton
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => window.dispatchEvent(new CustomEvent("simm:check-app-update"))}
                    >
                      Check for App Updates
                    </SimmButton>
                  </SettingRow>

                  <SettingRow
                    label="Environment and mod updates"
                    help="Check every installed environment now."
                  >
                    <SimmButton
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => void runCheckAllUpdates()}
                      disabled={checkingAllUpdates}
                    >
                      {checkingAllUpdates ? "Checking…" : "Check All Updates"}
                    </SimmButton>
                  </SettingRow>

                  <SettingRow label="Release service" help={releaseApiDetail}>
                    <span
                      className={`ui-status ui-status--${releaseApiTone}`}
                      title={releaseApiError || undefined}
                    >
                      {releaseApiLabel}
                    </span>
                  </SettingRow>
                </SettingsGroup>

                <SettingsGroup id="downloads" title="Downloads & storage">
                  <SettingRow
                    label="Download folder"
                    labelFor="settings-download-dir"
                    help="New environments and downloads are stored here."
                  >
                    <div className="settings-path-control">
                      <Input
                        id="settings-download-dir"
                        type="text"
                        className="ui-mono"
                        value={formData.defaultDownloadDir}
                        onChange={(e) =>
                          setFormData({
                            ...formData,
                            defaultDownloadDir: e.target.value,
                          })
                        }
                        placeholder={"C:\\DevEnvironments"}
                      />
                      <SimmButton
                        type="button"
                        variant="outline"
                        onClick={() => void openDirectoryPicker()}
                      >
                        Browse
                      </SimmButton>
                    </div>
                  </SettingRow>

                  <SettingRow
                    label="Parallel downloads"
                    labelFor="settings-max-downloads"
                    help="More finish sooner but use more bandwidth and disk. 1 to 10."
                  >
                    <div className="settings-number">
                      <Input
                        id="settings-max-downloads"
                        type="number"
                        value={formData.maxConcurrentDownloads}
                        onChange={(e) =>
                          setFormData({
                            ...formData,
                            maxConcurrentDownloads:
                              parseInt(e.target.value) || 2,
                          })
                        }
                        min="1"
                        max="10"
                      />
                      <span className="settings-number__unit">at once</span>
                    </div>
                  </SettingRow>

                  <SettingRow
                    label="DepotDownloader"
                    help={
                      <>
                        {depotStatusDetail}
                        {depotDownloader?.path && (
                          <span
                            className="settings-row__path ui-mono"
                            title={depotDownloader.path}
                          >
                            {depotDownloader.path}
                          </span>
                        )}
                      </>
                    }
                  >
                    <span className={`ui-status ui-status--${depotInstalled ? "ok" : "warn"}`}>
                      {depotStatusLabel}
                    </span>
                    <SimmButton
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={refreshDepotDownloader}
                      aria-label="Refresh DepotDownloader status"
                    >
                      Refresh
                    </SimmButton>
                  </SettingRow>

                  <SettingRow
                    label="Database backups to keep"
                    labelFor="settings-backup-count"
                    help="Older snapshots beyond this count are removed. Default 10."
                  >
                    <div className="settings-number">
                      <Input
                        id="settings-backup-count"
                        type="number"
                        value={formData.databaseBackupCount ?? 10}
                        onChange={(e) =>
                          setFormData({
                            ...formData,
                            databaseBackupCount: normalizeDatabaseBackupCount(
                              e.target.value,
                            ),
                          })
                        }
                        min="1"
                        max="100"
                      />
                      <span className="settings-number__unit">backups</span>
                    </div>
                  </SettingRow>

                  <SettingRow
                    label="Database"
                    stacked
                    help="SIMM backs up its database before upgrades and migrations. Repair adds missing schema after switching between installed and development builds."
                  >
                    <SimmButton
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => void handleBackupDatabase()}
                      disabled={backingUpDatabase || repairingDatabase}
                    >
                      {backingUpDatabase ? "Backing Up…" : "Back Up Database"}
                    </SimmButton>
                    <SimmButton
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => void handleOpenBackupsFolder()}
                      disabled={openingBackupsFolder || repairingDatabase}
                    >
                      {openingBackupsFolder ? "Opening…" : "Open Backups Folder"}
                    </SimmButton>
                    <SimmButton
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => void handleRepairDatabase()}
                      disabled={repairingDatabase || backingUpDatabase}
                    >
                      {repairingDatabase ? "Repairing…" : "Repair Database"}
                    </SimmButton>
                  </SettingRow>
                  {renderFeedback(databaseBackupFeedback)}
                </SettingsGroup>

                <SettingsGroup id="mods" title="Mods & cache">
                  <SettingRow
                    label="Preferred MelonLoader version"
                    help="Installed into new environments SIMM creates."
                  >
                    <SettingsSelect
                      ariaLabel="Preferred MelonLoader version"
                      value={formData.melonLoaderVersion || ""}
                      onValueChange={(value) =>
                        setFormData({
                          ...formData,
                          melonLoaderVersion: value,
                        })
                      }
                      disabled={loadingVersions}
                      options={[
                        {
                          value: "",
                          label: "None (manual install)",
                        },
                        ...(loadingVersions
                          ? [
                              {
                                value: "__loading",
                                label: "Loading versions…",
                                disabled: true,
                              },
                            ]
                          : melonLoaderVersions.map((version) => ({
                              value: version.tag,
                              label: version.name,
                            }))),
                      ]}
                    />
                  </SettingRow>

                  <SettingsToggle
                    label="Auto-install after download"
                    description="Install MelonLoader automatically when an environment finishes downloading."
                    checked={formData.autoInstallMelonLoader || false}
                    onChange={(checked) =>
                      setFormData({
                        ...formData,
                        autoInstallMelonLoader: checked,
                      })
                    }
                  />

                  <SettingRow
                    label="Mod icon cache limit"
                    labelFor="settings-icon-cache"
                    help="Disk budget for cached mod icons. Default 500 MB."
                  >
                    <div className="settings-number">
                      <Input
                        id="settings-icon-cache"
                        type="number"
                        value={formData.modIconCacheLimitMb ?? 500}
                        onChange={(e) =>
                          setFormData({
                            ...formData,
                            modIconCacheLimitMb: normalizeModIconCacheLimitMb(
                              e.target.value,
                            ),
                          })
                        }
                        min="100"
                        max="8192"
                      />
                      <span className="settings-number__unit">MB</span>
                    </div>
                  </SettingRow>
                </SettingsGroup>

                <SettingsGroup id="security" title="Security">
                  <SettingsToggle
                    label="Scan downloads"
                    description="Run MLVScan on supported downloads before they enter the Mod Library."
                    checked={formData.enableSecurityScanner ?? true}
                    onChange={(checked) =>
                      setFormData({
                        ...formData,
                        enableSecurityScanner: checked,
                      })
                    }
                  />
                  <SettingsToggle
                    label="Auto-install scanner"
                    description="Let SIMM install or repair MLVScan when a scan needs it."
                    checked={formData.autoInstallSecurityScanner ?? true}
                    onChange={(checked) =>
                      setFormData({
                        ...formData,
                        autoInstallSecurityScanner: checked,
                      })
                    }
                  />
                  <SettingsToggle
                    label="Block critical findings"
                    description="Stop a download when MLVScan reports a critical risk."
                    checked={formData.blockCriticalScans ?? true}
                    onChange={(checked) =>
                      setFormData({
                        ...formData,
                        blockCriticalScans: checked,
                      })
                    }
                  />
                  <SettingsToggle
                    label="Prompt on high-risk results"
                    description="Ask before continuing when a scan needs review."
                    checked={formData.promptOnHighScans ?? true}
                    onChange={(checked) =>
                      setFormData({
                        ...formData,
                        promptOnHighScans: checked,
                      })
                    }
                  />
                  <SettingsToggle
                    label="Show scan results in lists"
                    description="Mark mods that need review or could not be scanned in the Mod Library and Mods."
                    checked={formData.showSecurityScanBadges ?? true}
                    onChange={(checked) =>
                      setFormData({
                        ...formData,
                        showSecurityScanBadges: checked,
                      })
                    }
                  />

                  <SettingRow
                    label="MLVScan"
                    help={
                      securityScannerStatus?.installed
                        ? scannerDetail
                        : "The setup guide normally installs MLVScan. Use Fallback Install if that failed."
                    }
                  >
                    <span className={`ui-status ui-status--${scannerTone}`}>{scannerLabel}</span>
                    <SimmButton
                      type="button"
                      variant="outline"
                      size="sm"
                      aria-label="Refresh MLVScan status"
                      disabled={
                        loadingSecurityScannerStatus || installingSecurityScanner
                      }
                      onClick={async () => {
                        setLoadingSecurityScannerStatus(true);
                        try {
                          const status =
                            await ApiService.getSecurityScannerStatus();
                          setSecurityScannerStatus(status);
                        } catch (err) {
                          setError(
                            err instanceof Error
                              ? err.message
                              : "Failed to refresh the security scanner status",
                          );
                        } finally {
                          setLoadingSecurityScannerStatus(false);
                        }
                      }}
                    >
                      {loadingSecurityScannerStatus ? "Refreshing…" : "Refresh"}
                    </SimmButton>
                    {!securityScannerStatus?.installed && (
                      <SimmButton
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={installingSecurityScanner || loadingSecurityScannerStatus}
                        onClick={async () => {
                          setInstallingSecurityScanner(true);
                          try {
                            const status =
                              await ApiService.installSecurityScanner();
                            setSecurityScannerStatus(status);
                          } catch (err) {
                            setError(
                              err instanceof Error
                                ? err.message
                                : "Failed to install the security scanner",
                            );
                          } finally {
                            setInstallingSecurityScanner(false);
                          }
                        }}
                      >
                        {installingSecurityScanner ? "Installing…" : "Fallback Install"}
                      </SimmButton>
                    )}
                  </SettingRow>
                  {securityScannerStatus?.lastError && (
                    <p className="settings-feedback settings-feedback--error" role="alert">
                      {securityScannerStatus.lastError}
                    </p>
                  )}
                </SettingsGroup>

                <SettingsGroup id="diagnostics" title="Diagnostics">
                  <SettingRow
                    label="Log level"
                    help="Minimum detail SIMM writes to its own log file."
                  >
                    <SettingsSelect
                      ariaLabel="Log level"
                      value={formData.logLevel || "info"}
                      onValueChange={(value) =>
                        setFormData({
                          ...formData,
                          logLevel: value as SettingsFormData["logLevel"],
                        })
                      }
                      options={[
                        { value: "debug", label: "Debug" },
                        { value: "info", label: "Info" },
                        { value: "warn", label: "Warning" },
                        { value: "error", label: "Error" },
                      ]}
                    />
                  </SettingRow>

                  {telemetryAvailable && <TelemetrySettingsPanel />}

                  {formData.platform === "linux" && (
                    <>
                      <SettingRow
                        label="Linux readiness"
                        help="Steam, Protontricks, DepotDownloader, MLVScan, and desktop link checks. Repair after moving the AppImage or changing desktop defaults."
                        stacked
                      >
                        <span className={`ui-status ui-status--${linuxReadinessTone}`}>
                          {linuxReadinessSummary}
                        </span>
                        <SimmButton
                          type="button"
                          variant="outline"
                          size="sm"
                          aria-label="Refresh Linux readiness"
                          onClick={() => void handleRefreshLinuxReadiness()}
                          disabled={loadingLinuxReadiness}
                        >
                          {loadingLinuxReadiness ? "Checking…" : "Refresh"}
                        </SimmButton>
                        <SimmButton
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => void handleRepairLinuxDesktopIntegration()}
                          disabled={repairingLinuxDesktopIntegration}
                        >
                          {repairingLinuxDesktopIntegration
                            ? "Repairing…"
                            : "Repair Desktop Links"}
                        </SimmButton>
                      </SettingRow>
                      {((linuxReadinessStatus?.checks.length ?? 0) > 0 ||
                        (linuxReadinessStatus?.schemeHandlers.length ?? 0) > 0) && (
                        <ul className="settings-checks" aria-label="Linux readiness checks">
                          {(linuxReadinessStatus?.checks ?? []).map((check) => (
                            <li className="settings-check" key={check.id}>
                              <span className="settings-check__label">{check.label}</span>
                              <span
                                className="settings-check__detail"
                                title={check.path || check.command || undefined}
                              >
                                {check.detail}
                              </span>
                              <span className={`ui-status ui-status--${getReadinessTone(check.status)}`}>
                                {getReadinessStatusLabel(check.status)}
                              </span>
                            </li>
                          ))}
                          {(linuxReadinessStatus?.schemeHandlers ?? []).map((scheme) => (
                            <li className="settings-check" key={scheme.scheme}>
                              <span className="settings-check__label">{scheme.scheme}:// handler</span>
                              <span
                                className="settings-check__detail"
                                title={scheme.handler || undefined}
                              >
                                {scheme.detail}
                              </span>
                              <span className={`ui-status ui-status--${scheme.ready ? "ok" : "warn"}`}>
                                {scheme.ready ? "SIMM" : "Needs repair"}
                              </span>
                            </li>
                          ))}
                        </ul>
                      )}
                      {renderFeedback(linuxReadinessFeedback)}
                    </>
                  )}
                </SettingsGroup>

                <SettingsGroup id="window" title="Window">
                  <WindowBehaviorSettingsPanel />
                </SettingsGroup>
              </div>
            </div>
          </div>
        </section>
      )}

      {showDirectoryPicker && (
        <Dialog open={showDirectoryPicker} onOpenChange={(open) => {
          if (!open) {
            setShowDirectoryPicker(false);
          }
        }}>
          <SimmDialogContent
            nested
            className="settings-directory-dialog"
            showCloseButton={false}
          >
            <DialogHeader className="modal-header settings-directory-dialog__header">
              <DialogTitle>Select download directory</DialogTitle>
              <SimmButton
                variant="ghost"
                size="icon-sm"
                className="modal-close"
                onClick={() => setShowDirectoryPicker(false)}
                aria-label="Close directory picker"
              >
                <Icon name="times" />
              </SimmButton>
            </DialogHeader>

            <div className="settings-directory-dialog__body">
              <div className="settings-directory-dialog__field">
                <label htmlFor="settings-directory-path">Current path</label>
                <div className="settings-path-control">
                  <Input
                    id="settings-directory-path"
                    type="text"
                    className="ui-mono"
                    value={directoryPath}
                    onChange={(e) => setDirectoryPath(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        void loadDirectory(directoryPath);
                      }
                    }}
                    placeholder={"C:\\Users\\YourName"}
                  />
                  <SimmButton
                    type="button"
                    variant="outline"
                    onClick={() => void loadDirectory(directoryPath)}
                    disabled={browsing}
                  >
                    {browsing ? "Loading…" : "Go to Path"}
                  </SimmButton>
                </div>
              </div>

              <div className="settings-directory-dialog__list" role="list" aria-label="Folders" aria-busy={browsing}>
                {browsing ? (
                  <div className="settings-directory-dialog__skeleton" aria-hidden="true">
                    <span />
                    <span />
                    <span />
                  </div>
                ) : (
                  <>
                    {getParentPath(directoryPath) && (
                      <div role="listitem">
                        <SimmButton
                          type="button"
                          variant="ghost"
                          className="settings-directory-row h-auto"
                          onClick={() =>
                            void loadDirectory(getParentPath(directoryPath) || "")
                          }
                        >
                          <Icon name="arrowUp" />
                          <span>Parent folder</span>
                        </SimmButton>
                      </div>
                    )}
                    {directoryList.length === 0 ? (
                      <div className="ui-empty settings-directory-dialog__empty" role="listitem">
                        <p className="ui-empty__copy">
                          {directoryPath
                            ? "No subfolders here. Select this folder or create one below."
                            : "Enter a path above, then press Go to Path."}
                        </p>
                      </div>
                    ) : (
                      directoryList.map((dir) => (
                        <div role="listitem" key={dir.path}>
                          <SimmButton
                            type="button"
                            variant="ghost"
                            className="settings-directory-row h-auto"
                            onClick={() => void loadDirectory(dir.path)}
                          >
                            <Icon name="folder" />
                            <span className="ui-truncate">{dir.name}</span>
                          </SimmButton>
                        </div>
                      ))
                    )}
                  </>
                )}
              </div>

              <div className="settings-directory-dialog__field">
                <label htmlFor="settings-new-folder">
                  Create a folder in the current location
                </label>
                <div className="settings-path-control">
                  <Input
                    id="settings-new-folder"
                    type="text"
                    value={newFolderName}
                    onChange={(e) => setNewFolderName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && newFolderName.trim()) {
                        void handleCreateFolder();
                      }
                    }}
                    placeholder="Folder name"
                    disabled={creatingFolder || !directoryPath}
                  />
                  <SimmButton
                    type="button"
                    variant="outline"
                    onClick={() => void handleCreateFolder()}
                    disabled={
                      creatingFolder || !newFolderName.trim() || !directoryPath
                    }
                  >
                    {creatingFolder ? "Creating…" : "Create Folder"}
                  </SimmButton>
                </div>
              </div>
            </div>

            <div className="settings-directory-dialog__footer">
              <SimmButton
                type="button"
                variant="outline"
                onClick={() => setShowDirectoryPicker(false)}
              >
                Cancel
              </SimmButton>
              <SimmButton
                type="button"
                onClick={() => handleDirectorySelect(directoryPath)}
                disabled={!directoryPath}
              >
                Select This Directory
              </SimmButton>
            </div>
          </SimmDialogContent>
        </Dialog>
      )}
    </>
  );
}
