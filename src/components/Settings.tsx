import { useState, useEffect, useRef } from "react";
import { useSettingsStore } from "../stores/settingsStore";
import { useEnvironmentStore } from "../stores/environmentStore";
import { ApiService } from "../services/api";
import {
  batchUpdateCheckRef,
  lastUpdateCheckTimeRef,
  notifyBatchUpdateCheckStarted,
} from "./EnvironmentList";
import type { CustomThemeDefinition, SecurityScannerStatus } from "../types";
import type { Settings as AppSettings } from "../types";
import type { ExperienceMode } from "../types";
import { resolveExperienceMode, resolveShowAdvancedGameTools } from "../utils/uxSettings";
import { Icon } from './Icon';
import { SimmButton } from './primitives';
import { WorkspacePageHeader } from './WorkspacePageHeader';

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
        return parsed.toLocaleString();
      }
      return candidate;
    }
  }

  return null;
}

function buildFormDataFromSettings(settings: AppSettings): SettingsFormData {
  return {
    defaultDownloadDir: settings.defaultDownloadDir || "",
    maxConcurrentDownloads: settings.maxConcurrentDownloads || 2,
    platform: "windows",
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
    appUpdateChannel: settings.appUpdate?.channel ?? "beta",
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
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      className="settings-toggle settings-toggle-button"
      onClick={() => onChange(!checked)}
      disabled={disabled}
    >
      <span className="settings-toggle__control" aria-hidden="true"></span>
      <span>
        <strong>{label}</strong>
        <small>{description}</small>
      </span>
    </button>
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
    appUpdateChannel: "beta",
    logLevel: "info" as "debug" | "info" | "warn" | "error",
    modIconCacheLimitMb: 500,
    databaseBackupCount: 10,
    experienceMode: "powerUser",
    showAdvancedGameTools: true,
  });
  const [error, setError] = useState<string | null>(null);
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
  const [openingThemesFolder, setOpeningThemesFolder] = useState(false);
  const [reloadingThemes, setReloadingThemes] = useState(false);
  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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

  // Auto-save with debouncing
  useEffect(() => {
    if (!settings) return; // Don't save on initial load

    const currentPersistedFormData = buildFormDataFromSettings(settings);
    if (areFormDataEqual(formData, currentPersistedFormData)) {
      return;
    }

    // Clear existing timeout
    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current);
    }

    // Set new timeout to save after 500ms of no changes
    saveTimeoutRef.current = setTimeout(async () => {
      try {
        setError(null);
        // Always set platform to 'windows' and language to 'english' since they're not user-configurable
        const normalizedFormData = {
          defaultDownloadDir: formData.defaultDownloadDir,
          maxConcurrentDownloads: formData.maxConcurrentDownloads,
          theme: formData.theme,
          melonLoaderVersion: formData.melonLoaderVersion,
          autoInstallMelonLoader: formData.autoInstallMelonLoader,
          enableSecurityScanner: formData.enableSecurityScanner,
          autoInstallSecurityScanner: formData.autoInstallSecurityScanner,
          blockCriticalScans: formData.blockCriticalScans,
          promptOnHighScans: formData.promptOnHighScans,
          showSecurityScanBadges: formData.showSecurityScanBadges,
          updateCheckInterval: formData.updateCheckInterval,
          autoCheckUpdates: formData.autoCheckUpdates,
          appUpdate: {
            ...(settings?.appUpdate ?? {}),
            channel: formData.appUpdateChannel,
          },
          logLevel: formData.logLevel,
          modIconCacheLimitMb: normalizeModIconCacheLimitMb(
            formData.modIconCacheLimitMb,
          ),
          databaseBackupCount: normalizeDatabaseBackupCount(
            formData.databaseBackupCount,
          ),
          experienceMode: formData.experienceMode,
          showAdvancedGameTools: formData.showAdvancedGameTools,
          setupGuideCompleted: true,
          platform: "windows" as const,
          language: "english",
        };
        await updateSettings(normalizedFormData);
      } catch (err) {
        setError(
          err instanceof Error ? err.message : "Failed to save settings",
        );
      }
    }, 500);

    // Cleanup on unmount
    return () => {
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current);
      }
    };
  }, [formData, settings, updateSettings]);

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

  const depotStatusLabel = depotDownloader ? "Installed" : "Missing";
  const releaseApiLastUpdated = extractReleaseApiLastUpdated(releaseApiHealth);
  const releaseApiTone = checkingReleaseApi
    ? "checking"
    : releaseApiError
      ? "offline"
      : "online";
  const releaseApiLabel = checkingReleaseApi
    ? "Checking"
    : releaseApiError
      ? "Offline"
      : "Online";
  const depotStatusDetail = depotDownloader
    ? depotDownloader.method
      ? `Managed via ${depotDownloader.method}`
      : "Managed automatically for advanced branch installs"
    : "Installed automatically when advanced branch installs need it";
  const releaseApiDetail = checkingReleaseApi
    ? "Checking release metadata"
    : releaseApiError
      ? "Unable to reach release metadata"
      : releaseApiLastUpdated
        ? `Last updated ${releaseApiLastUpdated}`
        : "Release metadata available";

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
      const homeDirectory = await ApiService.getHomeDirectory();
      const normalizedHome = homeDirectory.replace(/[\\/]+$/, "");
      await ApiService.openPath(`${normalizedHome}\\backups`);
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

  const selectedCustomTheme =
    customThemes.find((theme) => theme.id === formData.theme) ?? null;
  const selectedBuiltInTheme = getActiveBuiltInTheme(formData.theme, customThemes);
  const selectedCustomThemeId = selectedCustomTheme?.id || "";

  return (
    <>
      {isOpen && (
        <section
          className="modal-content workspace-panel settings-panel"
          aria-label="Settings panel"
        >
          <WorkspacePageHeader
            eyebrow="Workspace"
            title="Settings"
            description="Adjust appearance, download locations, update checks, diagnostics, and setup defaults."
          />

          {error && <div className="settings-error-banner">{error}</div>}

          <div className="settings-content settings-content--desktop">
            <div className="settings-overview">
              <div className="settings-overview__copy">
                <span className="settings-eyebrow">Application Settings</span>
                <h3>Adjust appearance, downloads, updates, and tooling.</h3>
                <p>
                  Changes save automatically. Use this pane to keep SIMM’s
                  environment setup, update cadence, and theme behavior aligned
                  with your workflow.
                </p>
              </div>
              <div className="settings-overview__statusline">
                <span
                  className={`settings-status-pill settings-status-pill--${releaseApiTone}`}
                  title={releaseApiError || undefined}
                >
                  <Icon name={
                      checkingReleaseApi
                        ? "fas fa-spinner fa-spin"
                        : releaseApiError
                          ? "fas fa-exclamation-circle"
                          : "fas fa-check-circle"
                    }
                   />
                  GitHub API {releaseApiLabel}
                </span>
              </div>
            </div>

            <div className="settings-shell settings-shell--single">
              <section className="settings-sheet">
                <div className="settings-subsection">
                  <div className="settings-subsection__header">
                    <div>
                      <span className="settings-section__eyebrow">
                        Interface
                      </span>
                      <h3>
                        <Icon name="fas fa-sliders" /> App defaults
                      </h3>
                    </div>
                    <p>
                      Pick a built-in palette, optionally layer a custom theme
                      file on top, then choose how much diagnostic detail SIMM
                      writes while it runs.
                    </p>
                  </div>

                  <div className="settings-field-grid">
                    <div className="settings-field">
                      <label>Theme preset</label>
                      <select
                        value={selectedBuiltInTheme}
                        onChange={(e) =>
                          setFormData({ ...formData, theme: e.target.value })
                        }
                        disabled={loading}
                      >
                        {BUILT_IN_THEME_OPTIONS.map((theme) => (
                          <option key={theme.id} value={theme.id}>
                            {theme.label}
                          </option>
                        ))}
                      </select>
                      <small>
                        Choosing a built-in preset clears any active custom
                        theme override.
                      </small>
                    </div>

                    <div className="settings-field">
                      <label>Custom theme</label>
                      <select
                        value={selectedCustomThemeId}
                        onChange={(e) =>
                          setFormData({
                            ...formData,
                            theme: e.target.value || selectedBuiltInTheme,
                          })
                        }
                        disabled={loading}
                      >
                        <option value="">None</option>
                        {customThemes.map((theme) => (
                          <option key={theme.id} value={theme.id}>
                            {theme.name}
                          </option>
                        ))}
                      </select>
                      <small>
                        JSON files inside the themes folder appear here after
                        reload and apply on top of the <code>baseTheme</code>{" "}
                        defined inside each file.
                      </small>
                    </div>

                    <div className="settings-field">
                      <label>Log level</label>
                      <select
                        value={formData.logLevel || "info"}
                        onChange={(e) =>
                          setFormData({
                            ...formData,
                            logLevel: e.target.value as any,
                          })
                        }
                      >
                        <option value="debug">Debug</option>
                        <option value="info">Info</option>
                        <option value="warn">Warning</option>
                        <option value="error">Error</option>
                      </select>
                      <small>
                        Minimum log detail written to disk for SIMM
                        troubleshooting.
                      </small>
                    </div>

                    <div className="settings-field">
                      <label>App mode</label>
                      <select
                        value={formData.experienceMode}
                        onChange={(e) => {
                          const nextMode = e.target.value as ExperienceMode;
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
                      >
                        <option value="player">Player</option>
                        <option value="powerUser">Power User</option>
                      </select>
                      <small>
                        Player keeps common mod-management actions prominent.
                        Power User keeps separate branch installs and tooling visible.
                      </small>
                    </div>

                    <div className="settings-field settings-field--toggle">
                      <SettingsToggle
                        label="Show advanced Steam branch installs"
                        description="Show separate Steam branch install options inside Add Game."
                        checked={formData.showAdvancedGameTools}
                        onChange={(checked) =>
                          setFormData({
                            ...formData,
                            showAdvancedGameTools: checked,
                            experienceMode: checked ? "powerUser" : formData.experienceMode,
                          })
                        }
                      />
                    </div>

                    {onRunSetupGuide && (
                      <div className="settings-field settings-field--span">
                        <label>Setup guide</label>
                        <SimmButton
                          type="button"
                          className="btn btn-secondary"
                          onClick={onRunSetupGuide}
                        >
                          <Icon name="sliders" />
                          Run setup guide again
                        </SimmButton>
                        <small>
                          Revisit Player and Power User choices without changing
                          installed mods or environments.
                        </small>
                      </div>
                    )}
                  </div>

                  <div className="settings-inline-status-grid">
                    <div className="settings-inline-status settings-inline-status--path">
                      <span>Themes Folder</span>
                      <strong title={themesDirectory || undefined}>
                        {themesDirectory || "Unavailable"}
                      </strong>
                      <small>
                        Drop JSON files here with <code>baseTheme</code> and{" "}
                        <code>variables</code> keys. SIMM layers them over a
                        built-in base palette.
                      </small>
                    </div>

                    <div className="settings-inline-status">
                      <span>Theme Files</span>
                      <strong>
                        {customThemes.length === 0
                          ? "No custom themes"
                          : `${customThemes.length} loaded`}
                      </strong>
                      <small>
                        {customThemes.length === 0
                          ? "Create a .json file in the themes folder and reload to register it."
                          : "Custom themes can override any CSS variable already used by the app."}
                      </small>
                    </div>

                    <div className="settings-inline-status settings-inline-status--path">
                      <span>Selected Theme</span>
                      <strong title={selectedCustomTheme?.filePath || undefined}>
                        {selectedCustomTheme
                          ? selectedCustomTheme.name
                          : BUILT_IN_THEME_OPTIONS.find(
                              (theme) => theme.id === formData.theme,
                            )?.label || formData.theme}
                      </strong>
                      <small>
                        {selectedCustomTheme
                          ? `${getCustomThemeDescription(selectedCustomTheme)} from ${selectedCustomTheme.filePath}`
                          : "Built-in palettes are stored in the app bundle and can be used as custom theme bases."}
                      </small>
                    </div>

                    <div className="settings-inline-status settings-inline-status--action">
                      <span>Theme File Actions</span>
                      <strong>Manage JSON themes</strong>
                      <small>
                        Open the folder to edit files directly, then reload to
                        rescan the directory without restarting SIMM.
                      </small>
                      <div className="settings-backup-panel__actions">
                        <SimmButton
                          type="button"
                          onClick={() => void handleOpenThemesFolder()}
                          disabled={openingThemesFolder || !themesDirectory}
                          className="btn btn-secondary btn-small"
                        >
                          {openingThemesFolder
                            ? "Opening..."
                            : "Open Themes Folder"}
                        </SimmButton>
                        <SimmButton
                          type="button"
                          onClick={() => void handleReloadThemes()}
                          disabled={reloadingThemes}
                          className="btn btn-secondary btn-small"
                        >
                          {reloadingThemes ? "Reloading..." : "Reload Theme Files"}
                        </SimmButton>
                      </div>
                    </div>
                  </div>

                  {themeFeedback && (
                    <div
                      className={`settings-inline-feedback settings-inline-feedback--${themeFeedback.tone}`}
                      role={themeFeedback.tone === "error" ? "alert" : "status"}
                    >
                      {themeFeedback.message}
                    </div>
                  )}
                </div>

                <hr className="settings-divider" />

                <div className="settings-subsection">
                  <div className="settings-subsection__header">
                    <div>
                      <span className="settings-section__eyebrow">
                        Install Defaults
                      </span>
                      <h3>
                        <Icon name="fas fa-folder-tree" /> Downloads,
                        storage, and loader setup
                      </h3>
                    </div>
                    <p>
                      Control where installs stage by default, how many
                      transfers SIMM runs at once, and which MelonLoader version
                      new environments prefer.
                    </p>
                  </div>

                  <div className="settings-field-grid">
                    <div className="settings-field settings-field--span">
                      <label>Default download directory</label>
                      <div className="settings-inline-row">
                        <input
                          type="text"
                          value={formData.defaultDownloadDir}
                          onChange={(e) =>
                            setFormData({
                              ...formData,
                              defaultDownloadDir: e.target.value,
                            })
                          }
                          placeholder="C:\DevEnvironments"
                        />
                        <SimmButton
                          type="button"
                          onClick={() => void openDirectoryPicker()}
                          className="btn btn-secondary"
                        >
                          Browse
                        </SimmButton>
                      </div>
                      <small>
                        New downloads and extracted install payloads default to
                        this path.
                      </small>
                    </div>

                    <div className="settings-field settings-field--compact">
                      <label>Max concurrent downloads</label>
                      <input
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
                      <small>
                        Higher values improve throughput but use more bandwidth
                        and disk I/O.
                      </small>
                    </div>

                    <div className="settings-field">
                      <label>Preferred MelonLoader version</label>
                      <select
                        value={formData.melonLoaderVersion || ""}
                        onChange={(e) =>
                          setFormData({
                            ...formData,
                            melonLoaderVersion: e.target.value,
                          })
                        }
                        disabled={loadingVersions}
                      >
                        <option value="">None (Manual Installation)</option>
                        {loadingVersions ? (
                          <option disabled>Loading versions...</option>
                        ) : (
                          melonLoaderVersions.map((version) => (
                            <option key={version.tag} value={version.tag}>
                              {version.name}
                            </option>
                          ))
                        )}
                      </select>
                      <small>
                        Use this version when creating new managed environments.
                      </small>
                    </div>

                    <div className="settings-field settings-field--toggle">
                      <SettingsToggle
                        label="Auto-install after download"
                        description="Apply MelonLoader automatically when an environment finishes downloading."
                        checked={formData.autoInstallMelonLoader || false}
                        onChange={(checked) =>
                          setFormData({
                            ...formData,
                            autoInstallMelonLoader: checked,
                          })
                        }
                      />
                    </div>
                  </div>

                  <div className="settings-inline-status-grid">
                    <div className="settings-inline-status">
                      <span>DepotDownloader</span>
                      <strong>{depotStatusLabel}</strong>
                      <small>{depotStatusDetail}</small>
                    </div>
                    {depotDownloader?.path && (
                      <div className="settings-inline-status settings-inline-status--path">
                        <span>Detected Path</span>
                        <strong title={depotDownloader.path}>
                          {depotDownloader.path}
                        </strong>
                      </div>
                    )}
                    <div className="settings-inline-status settings-inline-status--action">
                      <span>Tooling Check</span>
                      <button
                        onClick={refreshDepotDownloader}
                        className="btn btn-secondary btn-small"
                      >
                        Refresh
                      </button>
                    </div>
                  </div>
                </div>

                <hr className="settings-divider" />

                <div className="settings-subsection">
                  <div className="settings-subsection__header">
                    <div>
                      <span className="settings-section__eyebrow">
                        Updates & Maintenance
                      </span>
                      <h3>
                        <Icon name="fas fa-rotate" /> Cadence, cache, and
                        service state
                      </h3>
                    </div>
                    <p>
                      Balance background checks, cache size, and manual update
                      runs without leaving the main settings sheet.
                    </p>
                  </div>

                  <div className="settings-field-grid">
                    <div className="settings-field settings-field--toggle">
                      <SettingsToggle
                        label="Automatically check for updates"
                        description="Run background update checks using the interval below."
                        checked={formData.autoCheckUpdates !== false}
                        onChange={(checked) =>
                          setFormData({
                            ...formData,
                            autoCheckUpdates: checked,
                          })
                        }
                      />
                    </div>

                    <div className="settings-field settings-field--compact">
                      <label>Check interval (minutes)</label>
                      <input
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
                      <small>Allowed range: 1 to 1440 minutes.</small>
                    </div>

                    <div className="settings-field settings-field--compact">
                      <label>App update channel</label>
                      <select
                        value={formData.appUpdateChannel}
                        onChange={(e) =>
                          setFormData({
                            ...formData,
                            appUpdateChannel: e.target.value as "stable" | "beta",
                          })
                        }
                      >
                        <option value="stable">Stable</option>
                        <option value="beta">Beta</option>
                      </select>
                      <small>
                        Stable uses production releases. Beta opts this app into prerelease updater manifests.
                      </small>
                    </div>

                    <div className="settings-field settings-field--compact">
                      <label>Mod icon cache limit (MB)</label>
                      <input
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
                      <small>
                        Disk budget for cached mod icons. Default is 500 MB.
                      </small>
                    </div>

                    <div className="settings-field settings-field--compact">
                      <label>Database backups to keep</label>
                      <input
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
                      <small>
                        Automatic and manual backups prune the oldest snapshots
                        above this count.
                      </small>
                    </div>

                    <div className="settings-field settings-field--compact">
                      <label>Manual batch actions</label>
                      <SimmButton
                        type="button"
                        onClick={() => void runCheckAllUpdates()}
                        disabled={checkingAllUpdates}
                        className="btn btn-secondary"
                      >
                        {checkingAllUpdates
                          ? "Checking..."
                          : "Check All Updates"}
                      </SimmButton>
                      <small>
                        Run an immediate check across all completed
                        environments.
                      </small>
                    </div>
                  </div>

                  <div className="settings-inline-status-grid">
                    <div className="settings-inline-status">
                      <span>Release API</span>
                      <strong>
                        <span
                          className={`settings-status-pill settings-status-pill--${releaseApiTone}`}
                          title={releaseApiError || undefined}
                        >
                          <Icon name={
                              checkingReleaseApi
                                ? "fas fa-spinner fa-spin"
                                : releaseApiError
                                  ? "fas fa-exclamation-circle"
                                  : "fas fa-check-circle"
                            }
                           />
                          {releaseApiLabel}
                        </span>
                      </strong>
                      <small>{releaseApiDetail}</small>
                    </div>
                    <div className="settings-inline-status">
                      <span>Update Checks</span>
                      <strong>
                        {formData.autoCheckUpdates ? "Enabled" : "Disabled"}
                      </strong>
                      <small>
                        {formData.autoCheckUpdates
                          ? "Background checks follow the configured interval."
                          : "Checks only run when you trigger them manually."}
                      </small>
                    </div>
                    <div className="settings-inline-status">
                      <span>App Update Channel</span>
                      <strong>{formData.appUpdateChannel === "beta" ? "Beta" : "Stable"}</strong>
                      <small>
                        {formData.appUpdateChannel === "beta"
                          ? "Checks the beta updater manifest and prerelease builds."
                          : "Checks the stable updater manifest and production releases."}
                      </small>
                    </div>
                  </div>

                  <div className="settings-backup-panel">
                    <div className="settings-backup-panel__header">
                      <div>
                        <span className="settings-section__eyebrow">
                          Database Backups
                        </span>
                        <h4>Snapshots before upgrades and migrations</h4>
                      </div>
                      <p>
                        SIMM automatically backs up the SQLite database before
                        app-version upgrades and migration work. You can also
                        create a manual snapshot at any time.
                      </p>
                    </div>

                    <div className="settings-backup-panel__actions">
                      <SimmButton
                        type="button"
                        onClick={() => void handleBackupDatabase()}
                        disabled={backingUpDatabase}
                        className="btn btn-secondary"
                      >
                        {backingUpDatabase
                          ? "Backing Up..."
                          : "Back Up Database"}
                      </SimmButton>
                      <SimmButton
                        type="button"
                        onClick={() => void handleOpenBackupsFolder()}
                        disabled={openingBackupsFolder}
                        className="btn btn-secondary"
                      >
                        {openingBackupsFolder
                          ? "Opening..."
                          : "Open Backups Folder"}
                      </SimmButton>
                    </div>

                    {databaseBackupFeedback && (
                      <div
                        className={`settings-inline-feedback settings-inline-feedback--${databaseBackupFeedback.tone}`}
                        role={
                          databaseBackupFeedback.tone === "error"
                            ? "alert"
                            : "status"
                        }
                      >
                        {databaseBackupFeedback.message}
                      </div>
                    )}
                  </div>
                </div>
                <hr className="settings-divider" />

                <div className="settings-subsection">
                  <div className="settings-subsection__header">
                    <div>
                      <span className="settings-section__eyebrow">MLVScan</span>
                      <h3>
                        <Icon name="fas fa-shield-virus" /> Security
                        scanning and trust signals
                      </h3>
                    </div>
                    <p>
                      Control when SIMM runs MLVScan, how aggressive the safety
                      gates are, and whether scan badges appear in the library
                      and installed mod views.
                    </p>
                  </div>

                  <div className="settings-field-grid">
                    <div className="settings-field settings-field--toggle">
                      <SettingsToggle
                        label="Enable download-time scanning"
                        description="Run MLVScan against supported downloads before they enter the library."
                        checked={formData.enableSecurityScanner ?? true}
                        onChange={(checked) =>
                          setFormData({
                            ...formData,
                            enableSecurityScanner: checked,
                          })
                        }
                      />
                    </div>

                    <div className="settings-field settings-field--toggle">
                      <SettingsToggle
                        label="Auto-install scanner"
                        description="Let SIMM acquire or repair the scanner when download safety checks need it."
                        checked={formData.autoInstallSecurityScanner ?? true}
                        onChange={(checked) =>
                          setFormData({
                            ...formData,
                            autoInstallSecurityScanner: checked,
                          })
                        }
                      />
                    </div>

                    <div className="settings-field settings-field--toggle">
                      <SettingsToggle
                        label="Block critical findings"
                        description="Stop downloads automatically when MLVScan reports a critical risk."
                        checked={formData.blockCriticalScans ?? true}
                        onChange={(checked) =>
                          setFormData({
                            ...formData,
                            blockCriticalScans: checked,
                          })
                        }
                      />
                    </div>

                    <div className="settings-field settings-field--toggle">
                      <SettingsToggle
                        label="Prompt on high-risk results"
                        description="Require manual confirmation before continuing when a scan needs review."
                        checked={formData.promptOnHighScans ?? true}
                        onChange={(checked) =>
                          setFormData({
                            ...formData,
                            promptOnHighScans: checked,
                          })
                        }
                      />
                    </div>

                    <div className="settings-field settings-field--toggle">
                      <SettingsToggle
                        label="Show scan badges"
                        description="Display verified, review, and unavailable states across library and installed mod cards."
                        checked={formData.showSecurityScanBadges ?? true}
                        onChange={(checked) =>
                          setFormData({
                            ...formData,
                            showSecurityScanBadges: checked,
                          })
                        }
                      />
                    </div>
                  </div>

                  <div className="settings-inline-status-grid">
                    <div className="settings-inline-status">
                      <span>Scanner Status</span>
                      <strong>
                        {loadingSecurityScannerStatus
                          ? "Checking"
                          : securityScannerStatus?.installed
                            ? "Installed"
                            : "Not Installed"}
                      </strong>
                      <small>
                        {securityScannerStatus?.installedVersion
                          ? `Installed ${securityScannerStatus.installedVersion}`
                          : "Install the scanner to enforce download safety checks."}
                      </small>
                    </div>
                    <div className="settings-inline-status">
                      <span>Install Method</span>
                      <strong>
                        {securityScannerStatus?.installMethod || "None"}
                      </strong>
                      <small>
                        {securityScannerStatus?.latestVersion
                          ? `Latest ${securityScannerStatus.latestVersion}`
                          : "Release metadata unavailable"}
                      </small>
                    </div>
                    <div className="settings-inline-status settings-inline-status--action">
                      <span>Scanner Management</span>
                      <strong>Prepared by setup guide</strong>
                      <small>
                        The first-run guide installs MLVScan automatically.
                        Use the fallback action here if setup failed or the
                        scanner is still missing.
                      </small>
                      <div className="settings-backup-panel__actions">
                        <SimmButton
                          type="button"
                          className="btn btn-secondary btn-small"
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
                          {loadingSecurityScannerStatus
                            ? "Refreshing..."
                            : "Refresh"}
                        </SimmButton>
                        {!securityScannerStatus?.installed && (
                          <SimmButton
                            type="button"
                            className="btn btn-secondary btn-small"
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
                            {installingSecurityScanner
                              ? "Installing..."
                              : "Fallback Install"}
                          </SimmButton>
                        )}
                      </div>
                    </div>
                  </div>

                  {securityScannerStatus?.lastError && (
                    <div
                      className="settings-inline-feedback settings-inline-feedback--error"
                      role="alert"
                    >
                      {securityScannerStatus.lastError}
                    </div>
                  )}
                </div>
              </section>
            </div>
          </div>
        </section>
      )}

      {/* Directory Picker Modal */}
      {showDirectoryPicker && (
        <div
          className="modal-overlay modal-overlay-nested"
          onClick={() => setShowDirectoryPicker(false)}
        >
          <div
            className="modal-content modal-content-nested wizard-directory-dialog settings-directory-dialog"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="modal-header">
              <h2>Select Download Directory</h2>
              <button
                className="modal-close"
                onClick={() => setShowDirectoryPicker(false)}
                aria-label="Close directory picker"
              >
                ×
              </button>
            </div>

            <div className="wizard-directory-dialog__body">
              <div className="wizard-directory-dialog__overview">
                <span className="settings-eyebrow">Directory Browser</span>
                <h3>Choose the default download location</h3>
                <p>
                  Browse folders, create a new subdirectory if needed, and
                  confirm the current location when you are ready.
                </p>
              </div>

              <div className="settings-field-card settings-field-card--full">
                <label htmlFor="settings-directory-path">Current path</label>
                <div className="settings-inline-field">
                  <input
                    id="settings-directory-path"
                    type="text"
                    value={directoryPath}
                    onChange={(e) => setDirectoryPath(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        void loadDirectory(directoryPath);
                      }
                    }}
                    placeholder="C:\\Users\\YourName"
                  />
                  <SimmButton
                    type="button"
                    onClick={() => void loadDirectory(directoryPath)}
                    className="btn btn-secondary"
                    disabled={browsing}
                  >
                    <Icon name={
                        browsing
                          ? "fas fa-spinner fa-spin"
                          : "fas fa-location-crosshairs"
                      }
                      aria-hidden="true"
                     />
                    {browsing ? "Loading…" : "Go to Path"}
                  </SimmButton>
                </div>
              </div>

              <div className="settings-field-card settings-field-card--full">
                <label htmlFor="settings-new-folder">
                  Create a folder in the current location
                </label>
                <div className="settings-inline-field">
                  <input
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
                    className="btn btn-secondary"
                    onClick={() => void handleCreateFolder()}
                    disabled={
                      creatingFolder || !newFolderName.trim() || !directoryPath
                    }
                  >
                    <Icon name={
                        creatingFolder
                          ? "fas fa-spinner fa-spin"
                          : "fas fa-folder-plus"
                      }
                      aria-hidden="true"
                     />
                    {creatingFolder ? "Creating…" : "Create Folder"}
                  </SimmButton>
                </div>
              </div>

              <div className="wizard-directory-dialog__list" role="list">
                {browsing ? (
                  <div className="wizard-empty-card">
                    <Icon name="fas fa-spinner fa-spin" />
                    <strong>Loading directories</strong>
                    <p>SIMM is reading the current folder contents.</p>
                  </div>
                ) : (
                  <>
                    {getParentPath(directoryPath) && (
                      <button
                        type="button"
                        className="wizard-directory-row wizard-directory-row--parent"
                        onClick={() =>
                          void loadDirectory(getParentPath(directoryPath) || "")
                        }
                      >
                        <Icon name="fas fa-arrow-up" />
                        <span>Parent Directory</span>
                      </button>
                    )}
                    {directoryList.length === 0 ? (
                      <div className="wizard-empty-card">
                        <Icon name="fas fa-folder-open" />
                        <strong>No subdirectories found</strong>
                        <p>
                          This location does not contain any folders that SIMM
                          can browse into right now.
                        </p>
                      </div>
                    ) : (
                      directoryList.map((dir) => (
                        <button
                          key={dir.path}
                          type="button"
                          className="wizard-directory-row"
                          onClick={() => void loadDirectory(dir.path)}
                        >
                          <Icon name="fas fa-folder" />
                          <span>{dir.name}</span>
                        </button>
                      ))
                    )}
                  </>
                )}
              </div>

              <div className="wizard-panel__actions wizard-panel__actions--dialog">
                <SimmButton
                  type="button"
                  onClick={() => setShowDirectoryPicker(false)}
                  className="btn btn-secondary"
                >
                  Cancel
                </SimmButton>
                <SimmButton
                  type="button"
                  onClick={() => handleDirectorySelect(directoryPath)}
                  className="btn btn-primary"
                  disabled={!directoryPath}
                >
                  Select This Directory
                </SimmButton>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
