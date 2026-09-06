import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";

import {
  Settings,
  normalizeDatabaseBackupCount,
  normalizeModIconCacheLimitMb,
} from "./Settings";

const settingsStoreMocks = vi.hoisted(() => ({
  useSettingsStore: vi.fn(),
}));

const environmentStoreMocks = vi.hoisted(() => ({
  useEnvironmentStore: vi.fn(),
}));

const apiMocks = vi.hoisted(() => ({
  getReleaseApiHealth: vi.fn(),
  getLinuxReadinessStatus: vi.fn(),
  repairLinuxDesktopIntegration: vi.fn(),
  getAvailableMelonLoaderVersions: vi.fn(),
  getSecurityScannerStatus: vi.fn(),
  installSecurityScanner: vi.fn(),
  browseDirectory: vi.fn(),
  createDirectory: vi.fn(),
  backupDatabase: vi.fn(),
  getHomeDirectory: vi.fn(),
  getBackupsDirectory: vi.fn(),
  getTelemetryCapability: vi.fn(),
  openPath: vi.fn(),
}));

vi.mock("../stores/settingsStore", () => ({
  useSettingsStore: settingsStoreMocks.useSettingsStore,
}));

vi.mock("../stores/environmentStore", () => ({
  useEnvironmentStore: environmentStoreMocks.useEnvironmentStore,
}));

vi.mock("../services/api", () => ({
  ApiService: apiMocks,
}));

vi.mock("../services/updateCheckCoordinator", () => ({
  batchUpdateCheckRef: { current: false },
  lastUpdateCheckTimeRef: { current: 0 },
  notifyBatchUpdateCheckStarted: vi.fn(),
}));

describe("normalizeModIconCacheLimitMb", () => {
  it("clamps below the minimum", () => {
    expect(normalizeModIconCacheLimitMb(0)).toBe(100);
    expect(normalizeModIconCacheLimitMb("99")).toBe(100);
  });

  it("clamps above the maximum", () => {
    expect(normalizeModIconCacheLimitMb(9000)).toBe(8192);
    expect(normalizeModIconCacheLimitMb("100000")).toBe(8192);
  });

  it("returns integer value inside bounds", () => {
    expect(normalizeModIconCacheLimitMb(512.9)).toBe(512);
    expect(normalizeModIconCacheLimitMb("2048")).toBe(2048);
  });

  it("falls back to default when value is not numeric", () => {
    expect(normalizeModIconCacheLimitMb(undefined)).toBe(500);
    expect(normalizeModIconCacheLimitMb("invalid")).toBe(500);
  });
});

describe("normalizeDatabaseBackupCount", () => {
  it("clamps below the minimum", () => {
    expect(normalizeDatabaseBackupCount(0)).toBe(1);
    expect(normalizeDatabaseBackupCount("0")).toBe(1);
  });

  it("clamps above the maximum", () => {
    expect(normalizeDatabaseBackupCount(999)).toBe(100);
    expect(normalizeDatabaseBackupCount("250")).toBe(100);
  });

  it("falls back to the default when value is invalid", () => {
    expect(normalizeDatabaseBackupCount(undefined)).toBe(10);
    expect(normalizeDatabaseBackupCount("invalid")).toBe(10);
  });
});

describe("Settings", () => {
  const refreshThemes = vi.fn();

  beforeEach(() => {
    refreshThemes.mockReset();
    refreshThemes.mockResolvedValue(undefined);
    settingsStoreMocks.useSettingsStore.mockReturnValue({
      settings: {
        defaultDownloadDir: "C:\\Games",
        maxConcurrentDownloads: 2,
        theme: "modern-blue",
        melonLoaderVersion: "",
        autoInstallMelonLoader: false,
        updateCheckInterval: 60,
        autoCheckUpdates: true,
        logLevel: "info",
        modIconCacheLimitMb: 500,
        databaseBackupCount: 10,
      },
      customThemes: [
        {
          id: "sunset",
          name: "Sunset",
          baseTheme: "dark",
          filePath: "C:\\Users\\SirTidez\\SIMM\\themes\\sunset.json",
          variables: {
            "--app-bg-color": "#1b120f",
          },
        },
      ],
      themesDirectory: "C:\\Users\\SirTidez\\SIMM\\themes",
      depotDownloader: null,
      loading: false,
      updateSettings: vi.fn().mockResolvedValue(undefined),
      refreshDepotDownloader: vi.fn().mockResolvedValue(undefined),
      refreshThemes,
    });

    environmentStoreMocks.useEnvironmentStore.mockReturnValue({
      environments: [{ id: "env-1", status: "completed" }],
      checkAllUpdates: vi.fn().mockResolvedValue(undefined),
    });

    apiMocks.getReleaseApiHealth.mockResolvedValue({});
    apiMocks.getLinuxReadinessStatus.mockResolvedValue({
      platform: "linux",
      available: true,
      summary: "ready",
      checks: [],
      schemeHandlers: [],
    });
    apiMocks.repairLinuxDesktopIntegration.mockResolvedValue({
      platform: "linux",
      available: true,
      summary: "ready",
      checks: [],
      schemeHandlers: [],
    });
    apiMocks.getAvailableMelonLoaderVersions.mockResolvedValue([]);
    apiMocks.getSecurityScannerStatus.mockResolvedValue({
      enabled: true,
      autoInstall: true,
      installed: false,
    });
    apiMocks.installSecurityScanner.mockResolvedValue({
      enabled: true,
      autoInstall: true,
      installed: true,
      installMethod: "managed",
      installedVersion: "1.0.0",
      latestVersion: "1.0.0",
      schemaVersion: "1",
      executablePath: "C:\\Users\\SirTidez\\SIMM\\tools\\mlvscan.exe",
    });
    apiMocks.browseDirectory.mockResolvedValue({
      currentPath: "C:\\Games",
      directories: [{ name: "Downloads", path: "C:\\Games\\Downloads" }],
    });
    apiMocks.createDirectory.mockResolvedValue({
      success: true,
      path: "C:\\Games\\New Folder",
    });
    apiMocks.backupDatabase.mockResolvedValue({
      success: true,
      path: "C:\\Users\\SirTidez\\SIMM\\backups\\SIMM-db-backup-manual-20260326-034426.db",
    });
    apiMocks.getHomeDirectory.mockResolvedValue("C:\\Users\\SirTidez\\SIMM");
    apiMocks.getBackupsDirectory.mockResolvedValue("C:\\Users\\SirTidez\\SIMM\\backups");
    apiMocks.getTelemetryCapability.mockResolvedValue({ available: true });
    apiMocks.openPath.mockResolvedValue(undefined);
  });

  it("hides telemetry controls when backend capability is unavailable", async () => {
    apiMocks.getTelemetryCapability.mockResolvedValueOnce({ available: false });
    render(<Settings isOpen={true} onClose={vi.fn()} />);

    await waitFor(() => {
      expect(screen.queryByText("Live Telemetry")).toBeNull();
      expect(screen.queryByRole("switch", { name: /collect local telemetry/i })).toBeNull();
    });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  it("shows Stable before persisted settings finish loading", () => {
    settingsStoreMocks.useSettingsStore.mockReturnValue({
      settings: null,
      customThemes: [],
      themesDirectory: "",
      depotDownloader: null,
      loading: true,
      updateSettings: vi.fn().mockResolvedValue(undefined),
      refreshDepotDownloader: vi.fn().mockResolvedValue(undefined),
      refreshThemes: vi.fn().mockResolvedValue(undefined),
    });

    render(<Settings isOpen={true} onClose={vi.fn()} />);

    const channelControl = screen.getByRole("combobox", {
      name: /app update channel/i,
    });
    expect(channelControl.textContent).toContain("Stable");
    expect(channelControl.textContent).not.toContain("Beta");

    const status = screen.getByText("App Update Channel").closest(
      ".settings-inline-status",
    );
    expect(status).not.toBeNull();
    expect(within(status as HTMLElement).getByText("Stable")).toBeTruthy();
    expect(within(status as HTMLElement).queryByText("Beta")).toBeNull();
  });

  it("opens the directory picker from the sidebar and browses the current path", async () => {
    render(<Settings isOpen={true} onClose={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: /^browse$/i }));

    expect(
      await screen.findByRole("heading", {
        name: /select download directory/i,
      }),
    ).toBeTruthy();
    await waitFor(() => {
      expect(apiMocks.browseDirectory).toHaveBeenCalledWith("C:\\Games");
    });
  });

  it("creates a folder from the directory picker and refreshes the listing", async () => {
    render(<Settings isOpen={true} onClose={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: /^browse$/i }));
    await screen.findByRole("heading", { name: /select download directory/i });

    fireEvent.change(
      screen.getByLabelText(/create a folder in the current location/i),
      {
        target: { value: "New Folder" },
      },
    );
    fireEvent.click(screen.getByRole("button", { name: /create folder/i }));

    await waitFor(() => {
      expect(apiMocks.createDirectory).toHaveBeenCalledWith(
        "C:\\Games\\New Folder",
      );
    });
    await waitFor(() => {
      expect(apiMocks.browseDirectory).toHaveBeenCalledTimes(2);
    });
  });

  it("shows separate built-in and custom theme selectors", async () => {
    render(<Settings isOpen={true} onClose={vi.fn()} />);

    fireEvent.click(screen.getByRole("combobox", { name: /theme preset/i }));
    expect(await screen.findByRole("option", { name: "Modern Blue" })).toBeTruthy();
    expect(screen.getByRole("option", { name: "Dark" })).toBeTruthy();
    expect(screen.getByRole("option", { name: "Light" })).toBeTruthy();
    fireEvent.keyDown(document, { key: "Escape" });

    fireEvent.click(screen.getByRole("combobox", { name: /custom theme/i }));
    expect(await screen.findByRole("option", { name: "None" })).toBeTruthy();
    expect(screen.getByRole("option", { name: "Sunset" })).toBeTruthy();
    expect(screen.getByText(/drop json files here/i)).toBeTruthy();
    expect(screen.getByText(/sunset/i)).toBeTruthy();
  });

  it("keeps the settings page rendered after toggling auto-install and does not enter a save loop", async () => {
    vi.useFakeTimers();

    const updateSettingsSpy = vi.fn();

    settingsStoreMocks.useSettingsStore.mockImplementation(() => {
      const [settingsState, setSettingsState] = React.useState({
        defaultDownloadDir: "C:\\Games",
        maxConcurrentDownloads: 2,
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
        logLevel: "info",
        modIconCacheLimitMb: 500,
        databaseBackupCount: 10,
        appUpdate: { channel: "beta" as const },
      });

      return {
        settings: settingsState,
        customThemes: [],
        themesDirectory: "C:\\Users\\SirTidez\\SIMM\\themes",
        depotDownloader: null,
        loading: false,
        updateSettings: async (updates: any) => {
          updateSettingsSpy(updates);
          setSettingsState((previous) => ({
            ...previous,
            ...updates,
            appUpdate: updates.appUpdate
              ? {
                  ...(previous.appUpdate ?? {}),
                  ...updates.appUpdate,
                }
              : previous.appUpdate,
          }));
        },
        refreshDepotDownloader: vi.fn().mockResolvedValue(undefined),
        refreshThemes: vi.fn().mockResolvedValue(undefined),
      };
    });

    render(<Settings isOpen={true} onClose={vi.fn()} />);

    const toggle = screen.getByRole("switch", {
      name: /auto-install after download/i,
    });

    fireEvent.click(toggle);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(600);
    });

    expect(updateSettingsSpy).toHaveBeenCalledTimes(1);

    expect(
      screen.getByText("Adjust appearance, downloads, updates, and tooling."),
    ).toBeTruthy();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
    });

    expect(updateSettingsSpy).toHaveBeenCalledTimes(1);
    expect(
      screen.getByRole("switch", {
        name: /auto-install after download/i,
      }),
    ).toBeTruthy();
  });

  it("flushes a pending settings edit when the workspace closes", async () => {
    const updateSettingsSpy = vi.fn().mockResolvedValue(undefined);
    settingsStoreMocks.useSettingsStore.mockReturnValue({
      settings: {
        defaultDownloadDir: "C:\\Games",
        maxConcurrentDownloads: 2,
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
        logLevel: "info",
        modIconCacheLimitMb: 500,
        databaseBackupCount: 10,
        appUpdate: { channel: "beta" as const },
      },
      customThemes: [],
      themesDirectory: "C:\\Users\\SirTidez\\SIMM\\themes",
      depotDownloader: null,
      loading: false,
      updateSettings: updateSettingsSpy,
      refreshDepotDownloader: vi.fn().mockResolvedValue(undefined),
      refreshThemes: vi.fn().mockResolvedValue(undefined),
    });

    const { rerender } = render(<Settings isOpen={true} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole("switch", { name: /auto-install after download/i }));
    rerender(<Settings isOpen={false} onClose={vi.fn()} />);

    await waitFor(() => {
      expect(updateSettingsSpy).toHaveBeenCalledWith(
        expect.objectContaining({ autoInstallMelonLoader: false }),
      );
    });
  });

  it("preserves a Linux platform value when saving settings", async () => {
    vi.useFakeTimers();

    const updateSettingsSpy = vi.fn().mockResolvedValue(undefined);
    settingsStoreMocks.useSettingsStore.mockReturnValue({
      settings: {
        defaultDownloadDir: "/home/sirtidez/SIMM",
        maxConcurrentDownloads: 2,
        platform: "linux" as const,
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
        logLevel: "info",
        modIconCacheLimitMb: 500,
        databaseBackupCount: 10,
        appUpdate: { channel: "beta" as const },
      },
      customThemes: [],
      themesDirectory: "/home/sirtidez/SIMM/themes",
      depotDownloader: null,
      loading: false,
      updateSettings: updateSettingsSpy,
      refreshDepotDownloader: vi.fn().mockResolvedValue(undefined),
      refreshThemes,
    });

    render(<Settings isOpen={true} onClose={vi.fn()} />);

    fireEvent.click(
      screen.getByRole("switch", {
        name: /auto-install after download/i,
      }),
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(600);
    });

    expect(updateSettingsSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        autoInstallMelonLoader: false,
        platform: "linux",
        language: "english",
      }),
    );
  });

  it("shows Linux readiness status and repairs desktop links", async () => {
    settingsStoreMocks.useSettingsStore.mockReturnValue({
      settings: {
        defaultDownloadDir: "/home/sirtidez/SIMM",
        maxConcurrentDownloads: 2,
        platform: "linux" as const,
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
        logLevel: "info",
        modIconCacheLimitMb: 500,
        databaseBackupCount: 10,
        appUpdate: { channel: "beta" as const },
      },
      customThemes: [],
      themesDirectory: "/home/sirtidez/SIMM/themes",
      depotDownloader: {
        installed: true,
        path: "/home/sirtidez/.local/bin/DepotDownloader",
        method: "manual",
      },
      loading: false,
      updateSettings: vi.fn().mockResolvedValue(undefined),
      refreshDepotDownloader: vi.fn().mockResolvedValue(undefined),
      refreshThemes,
    });
    apiMocks.getLinuxReadinessStatus.mockResolvedValueOnce({
      platform: "linux",
      available: true,
      summary: "warning",
      checks: [
        {
          id: "protontricks",
          label: "Protontricks",
          status: "ready",
          detail: "Protontricks is available.",
        },
      ],
      schemeHandlers: [
        {
          scheme: "nxm",
          handler: "vortex.desktop",
          ready: false,
          detail: "nxm:// is currently registered to vortex.desktop.",
        },
      ],
    });
    apiMocks.repairLinuxDesktopIntegration.mockResolvedValueOnce({
      platform: "linux",
      available: true,
      summary: "ready",
      checks: [],
      schemeHandlers: [
        {
          scheme: "nxm",
          handler: "com.s1devenvmanager.app.desktop",
          ready: true,
          detail: "nxm:// is registered to SIMM.",
        },
      ],
    });

    render(<Settings isOpen={true} onClose={vi.fn()} />);

    expect(await screen.findByText("Linux Readiness")).toBeTruthy();
    expect(await screen.findByText("Protontricks")).toBeTruthy();
    expect(await screen.findByText("nxm:// handler")).toBeTruthy();

    fireEvent.click(
      screen.getByRole("button", { name: /repair desktop links/i }),
    );

    await waitFor(() => {
      expect(apiMocks.repairLinuxDesktopIntegration).toHaveBeenCalledTimes(1);
    });
    expect(
      await screen.findByText(/re-registered simm desktop links/i),
    ).toBeTruthy();
  });

  it("creates a manual database backup from settings", async () => {
    render(<Settings isOpen={true} onClose={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: /back up database/i }));

    await waitFor(() => {
      expect(apiMocks.backupDatabase).toHaveBeenCalledTimes(1);
    });

    expect(await screen.findByText(/backup created at/i)).toBeTruthy();
  });

  it("opens the backups folder from settings", async () => {
    render(<Settings isOpen={true} onClose={vi.fn()} />);

    fireEvent.click(
      screen.getByRole("button", { name: /open backups folder/i }),
    );

    await waitFor(() => {
      expect(apiMocks.getBackupsDirectory).toHaveBeenCalledTimes(1);
    });
    expect(apiMocks.getHomeDirectory).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(apiMocks.openPath).toHaveBeenCalledWith(
        "C:\\Users\\SirTidez\\SIMM\\backups",
      );
    });
  });

  it("dispatches a manual app-update request for the selected channel", async () => {
    const requestListener = vi.fn();
    window.addEventListener("simm:check-app-update", requestListener);

    render(<Settings isOpen={true} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /check for app updates/i }));

    expect(requestListener).toHaveBeenCalledTimes(1);
    window.removeEventListener("simm:check-app-update", requestListener);
  });

  it("opens the themes folder from settings", async () => {
    render(<Settings isOpen={true} onClose={vi.fn()} />);

    fireEvent.click(
      screen.getByRole("button", { name: /open themes folder/i }),
    );

    await waitFor(() => {
      expect(apiMocks.openPath).toHaveBeenCalledWith(
        "C:\\Users\\SirTidez\\SIMM\\themes",
      );
    });
  });

  it("reloads theme files from settings", async () => {
    render(<Settings isOpen={true} onClose={vi.fn()} />);

    fireEvent.click(
      screen.getByRole("button", { name: /reload theme files/i }),
    );

    await waitFor(() => {
      expect(refreshThemes).toHaveBeenCalledTimes(1);
    });
    expect(await screen.findByText(/reloaded theme files from disk/i)).toBeTruthy();
  });

  it("offers a fallback MLVScan install action when the scanner is missing", async () => {
    render(<Settings isOpen={true} onClose={vi.fn()} />);

    const fallbackButton = await screen.findByRole("button", {
      name: /fallback install/i,
    });
    fireEvent.click(fallbackButton);

    await waitFor(() => {
      expect(apiMocks.installSecurityScanner).toHaveBeenCalledTimes(1);
    });
  });

  it("saves app mode and advanced game tool preferences", async () => {
    vi.useFakeTimers();
    const updateSettingsSpy = vi.fn().mockResolvedValue(undefined);
    settingsStoreMocks.useSettingsStore.mockReturnValue({
      settings: {
        defaultDownloadDir: "C:\\Games",
        maxConcurrentDownloads: 2,
        theme: "modern-blue",
        melonLoaderVersion: "",
        autoInstallMelonLoader: false,
        updateCheckInterval: 60,
        autoCheckUpdates: true,
        logLevel: "info",
        modIconCacheLimitMb: 500,
        databaseBackupCount: 10,
        experienceMode: "powerUser",
        showAdvancedGameTools: true,
        setupGuideCompleted: true,
      },
      customThemes: [],
      themesDirectory: "C:\\Users\\SirTidez\\SIMM\\themes",
      depotDownloader: null,
      loading: false,
      updateSettings: updateSettingsSpy,
      refreshDepotDownloader: vi.fn().mockResolvedValue(undefined),
      refreshThemes,
    });

    render(<Settings isOpen={true} onClose={vi.fn()} onRunSetupGuide={vi.fn()} />);

    fireEvent.click(screen.getByRole("combobox", { name: /app mode/i }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    const playerOption = screen.getByRole("option", { name: "Player" });
    fireEvent.pointerEnter(playerOption, { pointerType: "touch" });
    fireEvent.click(playerOption);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(600);
    });

    expect(updateSettingsSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        experienceMode: "player",
        showAdvancedGameTools: true,
        setupGuideCompleted: true,
      }),
    );

    fireEvent.click(
      screen.getByRole("switch", {
        name: /show advanced steam branch installs/i,
      }),
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(600);
    });

    expect(updateSettingsSpy).toHaveBeenLastCalledWith(
      expect.objectContaining({
        experienceMode: "player",
        showAdvancedGameTools: false,
        setupGuideCompleted: true,
      }),
    );

    expect(screen.getByRole("button", { name: /run setup guide again/i })).toBeTruthy();
  });
});
