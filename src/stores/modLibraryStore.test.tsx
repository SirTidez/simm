import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useEffect } from "react";
import { ModLibraryStoreProvider, useModLibraryStore } from "./modLibraryStore";

const apiMocks = vi.hoisted(() => ({
  getModLibrary: vi.fn(),
}));

let modsChangedHandler: (() => void) | null = null;
let modsSnapshotHandler: (() => void) | null = null;
let metadataRefreshHandler:
  ((status: { activeCount: number; running: boolean }) => void) | null = null;
const eventMocks = vi.hoisted(() => ({
  onModsChanged: vi.fn(),
  onModsSnapshotUpdated: vi.fn(),
  onPluginsChanged: vi.fn(),
  onUserLibsChanged: vi.fn(),
  onModUpdatesChecked: vi.fn(),
  onModMetadataRefreshStatus: vi.fn(),
}));

vi.mock("../services/api", () => ({ ApiService: apiMocks }));
vi.mock("../services/events", () => eventMocks);

function LibraryProbe({ label }: { label: string }) {
  const { library, ensureLibrary, version } = useModLibraryStore();

  useEffect(() => {
    void ensureLibrary();
  }, [ensureLibrary]);

  return (
    <output>{`${label}:${library?.downloaded.length ?? 0}:${version}`}</output>
  );
}

function LibraryActions() {
  const { ensureLibrary, refreshLibrary } = useModLibraryStore();
  return (
    <>
      <button onClick={() => void ensureLibrary()}>Ensure library</button>
      <button onClick={() => void refreshLibrary()}>Refresh library</button>
    </>
  );
}

describe("ModLibraryStoreProvider", () => {
  beforeEach(() => {
    modsChangedHandler = null;
    modsSnapshotHandler = null;
    metadataRefreshHandler = null;
    apiMocks.getModLibrary.mockReset();
    Object.values(eventMocks).forEach((listener) => listener.mockReset());
    apiMocks.getModLibrary.mockResolvedValue({ downloaded: [] });
    eventMocks.onModsChanged.mockImplementation(async (handler) => {
      modsChangedHandler = handler;
      return () => {};
    });
    eventMocks.onModsSnapshotUpdated.mockImplementation(async (handler) => {
      modsSnapshotHandler = handler;
      return () => {};
    });
    eventMocks.onModMetadataRefreshStatus.mockImplementation(
      async (handler) => {
        metadataRefreshHandler = handler;
        return () => {};
      },
    );
    [
      eventMocks.onPluginsChanged,
      eventMocks.onUserLibsChanged,
      eventMocks.onModUpdatesChecked,
    ].forEach((listener) => listener.mockResolvedValue(() => {}));
  });

  afterEach(cleanup);

  it("shares one initial snapshot request between passive consumers", async () => {
    render(
      <ModLibraryStoreProvider>
        <LibraryProbe label="first" />
        <LibraryProbe label="second" />
      </ModLibraryStoreProvider>,
    );

    await waitFor(() =>
      expect(apiMocks.getModLibrary).toHaveBeenCalledTimes(1),
    );
    expect(await screen.findByText("first:0:0")).toBeTruthy();
    expect(screen.getByText("second:0:0")).toBeTruthy();
  });

  it("settles a raw mods edge with one bounded refresh when no snapshot event follows", async () => {
    apiMocks.getModLibrary
      .mockResolvedValueOnce({ downloaded: [] })
      .mockResolvedValueOnce({ downloaded: [] });

    render(
      <ModLibraryStoreProvider>
        <LibraryProbe label="library" />
        <LibraryActions />
      </ModLibraryStoreProvider>,
    );

    await screen.findByText("library:0:0");
    await waitFor(() => expect(modsChangedHandler).not.toBeNull());
    await act(async () => {
      modsChangedHandler?.();
    });

    await waitFor(() =>
      expect(apiMocks.getModLibrary).toHaveBeenCalledTimes(2),
    );
    expect(await screen.findByText("library:0:1")).toBeTruthy();

    // The raw-edge refresh clears staleRef. A later ensure and additional
    // microtasks must not restart the refresh loop.
    await act(async () => {
      await Promise.resolve();
      screen.getByRole("button", { name: "Ensure library" }).click();
      await Promise.resolve();
    });
    expect(apiMocks.getModLibrary).toHaveBeenCalledTimes(2);
  });

  it("bounds a raw edge plus snapshot-complete burst to one authoritative follow-up", async () => {
    let resolveRawRefresh: (value: { downloaded: unknown[] }) => void = () => {};
    apiMocks.getModLibrary
      .mockResolvedValueOnce({ downloaded: [] })
      .mockReturnValueOnce(
        new Promise((resolve) => {
          resolveRawRefresh = resolve;
        }),
      )
      .mockResolvedValueOnce({ downloaded: [{ storageId: "new-entry" }] });

    render(
      <ModLibraryStoreProvider>
        <LibraryProbe label="library" />
        <LibraryActions />
      </ModLibraryStoreProvider>,
    );

    await screen.findByText("library:0:0");
    await waitFor(() => expect(modsChangedHandler).not.toBeNull());
    await waitFor(() => expect(modsSnapshotHandler).not.toBeNull());
    await act(async () => {
      modsChangedHandler?.();
      modsSnapshotHandler?.();
    });
    expect(apiMocks.getModLibrary).toHaveBeenCalledTimes(2);

    await act(async () => {
      resolveRawRefresh({ downloaded: [] });
    });

    await waitFor(() =>
      expect(apiMocks.getModLibrary).toHaveBeenCalledTimes(3),
    );
    expect(await screen.findByText("library:1:2")).toBeTruthy();

    await act(async () => {
      await Promise.resolve();
      screen.getByRole("button", { name: "Ensure library" }).click();
      await Promise.resolve();
    });
    expect(apiMocks.getModLibrary).toHaveBeenCalledTimes(3);
  });

  it("reuses a current snapshot for sequential ensures while explicit refresh bypasses it", async () => {
    render(
      <ModLibraryStoreProvider>
        <LibraryProbe label="library" />
        <LibraryActions />
      </ModLibraryStoreProvider>,
    );

    await screen.findByText("library:0:0");
    expect(apiMocks.getModLibrary).toHaveBeenCalledTimes(1);

    await act(async () => {
      screen.getByRole("button", { name: "Ensure library" }).click();
    });
    expect(apiMocks.getModLibrary).toHaveBeenCalledTimes(1);

    await act(async () => {
      screen.getByRole("button", { name: "Refresh library" }).click();
    });
    await waitFor(() =>
      expect(apiMocks.getModLibrary).toHaveBeenCalledTimes(2),
    );
  });

  it("runs one follow-up request when a change invalidates an in-flight snapshot", async () => {
    let resolveFirstRequest: (value: {
      downloaded: unknown[];
    }) => void = () => {};
    apiMocks.getModLibrary
      .mockReturnValueOnce(
        new Promise((resolve) => {
          resolveFirstRequest = resolve;
        }),
      )
      .mockResolvedValueOnce({ downloaded: [{ storageId: "fresh-entry" }] });

    render(
      <ModLibraryStoreProvider>
        <LibraryProbe label="library" />
      </ModLibraryStoreProvider>,
    );

    await waitFor(() =>
      expect(apiMocks.getModLibrary).toHaveBeenCalledTimes(1),
    );
    await waitFor(() => expect(modsChangedHandler).not.toBeNull());
    await act(async () => {
      modsChangedHandler?.();
      resolveFirstRequest({ downloaded: [] });
    });

    await waitFor(() =>
      expect(apiMocks.getModLibrary).toHaveBeenCalledTimes(2),
    );
    expect(await screen.findByText("library:1:1")).toBeTruthy();
  });

  it("refreshes once when metadata work transitions from running to idle", async () => {
    apiMocks.getModLibrary
      .mockResolvedValueOnce({ downloaded: [] })
      .mockResolvedValueOnce({ downloaded: [{ storageId: "metadata-entry" }] });

    render(
      <ModLibraryStoreProvider>
        <LibraryProbe label="library" />
      </ModLibraryStoreProvider>,
    );

    await screen.findByText("library:0:0");
    await waitFor(() => expect(metadataRefreshHandler).not.toBeNull());
    await act(async () => {
      metadataRefreshHandler?.({ activeCount: 1, running: true });
      metadataRefreshHandler?.({ activeCount: 0, running: false });
    });

    await waitFor(() =>
      expect(apiMocks.getModLibrary).toHaveBeenCalledTimes(2),
    );
    expect(await screen.findByText("library:1:1")).toBeTruthy();
  });

  it("cleans up each shared library event listener on unmount", async () => {
    const unlisteners = Array.from({ length: 6 }, () => vi.fn());
    eventMocks.onModsChanged.mockResolvedValueOnce(unlisteners[0]);
    eventMocks.onModsSnapshotUpdated.mockResolvedValueOnce(unlisteners[1]);
    eventMocks.onPluginsChanged.mockResolvedValueOnce(unlisteners[2]);
    eventMocks.onUserLibsChanged.mockResolvedValueOnce(unlisteners[3]);
    eventMocks.onModUpdatesChecked.mockResolvedValueOnce(unlisteners[4]);
    eventMocks.onModMetadataRefreshStatus.mockResolvedValueOnce(unlisteners[5]);

    const { unmount } = render(
      <ModLibraryStoreProvider>
        <LibraryProbe label="library" />
      </ModLibraryStoreProvider>,
    );

    await screen.findByText("library:0:0");
    await waitFor(() =>
      expect(eventMocks.onModMetadataRefreshStatus).toHaveBeenCalled(),
    );
    unmount();

    unlisteners.forEach((unlisten) =>
      expect(unlisten).toHaveBeenCalledTimes(1),
    );
  });
});
