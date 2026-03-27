import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
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
  getAvailableMelonLoaderVersions: vi.fn(),
  getSecurityScannerStatus: vi.fn(),
  installSecurityScanner: vi.fn(),
  browseDirectory: vi.fn(),
  createDirectory: vi.fn(),
  backupDatabase: vi.fn(),
  getHomeDirectory: vi.fn(),
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

vi.mock("./EnvironmentList", () => ({
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
  beforeEach(() => {
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
      depotDownloader: null,
      loading: false,
      updateSettings: vi.fn().mockResolvedValue(undefined),
      refreshDepotDownloader: vi.fn().mockResolvedValue(undefined),
    });

    environmentStoreMocks.useEnvironmentStore.mockReturnValue({
      environments: [{ id: "env-1", status: "completed" }],
      checkAllUpdates: vi.fn().mockResolvedValue(undefined),
    });

    apiMocks.getReleaseApiHealth.mockResolvedValue({});
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
    apiMocks.openPath.mockResolvedValue(undefined);
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
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

  it("only exposes built-in theme presets", async () => {
    render(<Settings isOpen={true} onClose={vi.fn()} />);

    const themeField = screen
      .getByText(/theme preset/i)
      .closest(".settings-field");
    const select = themeField?.querySelector(
      "select",
    ) as HTMLSelectElement | null;

    expect(select).toBeTruthy();
    if (!select) {
      throw new Error("Theme preset select not found");
    }
    const optionValues = Array.from(select.options).map(
      (option) => option.value,
    );

    expect(optionValues).toEqual(["modern-blue", "dark", "light"]);
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
      expect(apiMocks.getHomeDirectory).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      expect(apiMocks.openPath).toHaveBeenCalledWith(
        "C:\\Users\\SirTidez\\SIMM\\backups",
      );
    });
  });
});
