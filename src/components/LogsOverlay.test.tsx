import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

import { LogsOverlay } from './LogsOverlay';
import type { Environment } from '../types';

const apiMocks = vi.hoisted(() => ({
  getLogFiles: vi.fn(),
  readLogFile: vi.fn(),
  watchLogFile: vi.fn(),
  stopWatchingLog: vi.fn(),
  exportLogs: vi.fn(),
  getModLibrary: vi.fn(),
  openPath: vi.fn(),
  revealPath: vi.fn(),
}));

const listenMock = vi.hoisted(() => vi.fn(async () => () => {}));
const saveMock = vi.hoisted(() => vi.fn());
const modLibraryStoreMocks = vi.hoisted(() => ({ useModLibraryStore: vi.fn() }));

vi.mock('../services/api', () => ({
  ApiService: apiMocks,
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: listenMock,
}));

vi.mock('@tauri-apps/plugin-dialog', () => ({
  save: saveMock,
}));
vi.mock('../stores/modLibraryStore', () => ({ useModLibraryStore: modLibraryStoreMocks.useModLibraryStore }));

const environment: Environment = {
  id: 'env-1',
  name: 'Steam Installation',
  appId: '3164500',
  branch: 'main',
  outputDir: 'C:/Games/Schedule I',
  runtime: 'Mono',
  status: 'completed',
};

function makeLogFile(overrides: Partial<{
  name: string;
  path: string;
  size: number;
  modified: string | null;
  isLatest: boolean;
}> = {}) {
  return {
    name: 'Session.log',
    path: 'C:/Games/Schedule I/Logs/Session.log',
    size: 1024,
    modified: '2026-03-24T18:00:00.000Z',
    isLatest: false,
    ...overrides,
  };
}

function makeLogLine(overrides: Partial<{
  lineNumber: number;
  content: string;
  level: string | null;
  timestamp: string | null;
  modTag: string | null;
  category: 'melonloader' | 'mod' | 'general';
}> = {}) {
  return {
    lineNumber: 1,
    content: 'Loader initialized',
    level: 'INFO',
    timestamp: '18:00:00.000',
    modTag: null,
    category: 'melonloader' as const,
    ...overrides,
  };
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('LogsOverlay', () => {
  const originalInnerWidth = window.innerWidth;

  beforeEach(() => {
    modLibraryStoreMocks.useModLibraryStore.mockReset();
    modLibraryStoreMocks.useModLibraryStore.mockReturnValue({
      library: null,
      ensureLibrary: apiMocks.getModLibrary,
    });
    Object.defineProperty(window, 'innerWidth', {
      configurable: true,
      writable: true,
      value: originalInnerWidth,
    });
    apiMocks.getLogFiles.mockReset();
    apiMocks.readLogFile.mockReset();
    apiMocks.watchLogFile.mockReset();
    apiMocks.stopWatchingLog.mockReset();
    apiMocks.exportLogs.mockReset();
    apiMocks.getModLibrary.mockReset();
    apiMocks.openPath.mockReset();
    apiMocks.revealPath.mockReset();
    listenMock.mockReset();
    saveMock.mockReset();

    apiMocks.watchLogFile.mockResolvedValue(undefined);
    apiMocks.stopWatchingLog.mockResolvedValue(undefined);
    apiMocks.openPath.mockResolvedValue(undefined);
    apiMocks.revealPath.mockResolvedValue(undefined);
    apiMocks.getModLibrary.mockResolvedValue({ downloaded: [] });
    listenMock.mockResolvedValue(() => {});
  });

  afterEach(() => {
    cleanup();
  });

  it('prefers the latest environment log when selecting the initial source', async () => {
    apiMocks.getLogFiles.mockResolvedValue([
      makeLogFile({
        name: 'Player.log',
        path: 'C:/Users/User/AppData/LocalLow/TVGS/Schedule I/Player.log',
        isLatest: false,
      }),
      makeLogFile({
        name: 'Session-latest.log',
        path: 'C:/Games/Schedule I/Logs/Session-latest.log',
        isLatest: true,
      }),
      makeLogFile({
        name: 'Archived.log',
        path: 'C:/Games/Schedule I/Logs/Archived.log',
        isLatest: false,
      }),
    ]);
    apiMocks.readLogFile.mockResolvedValue([makeLogLine()]);

    const { container } = render(
      <LogsOverlay
        isOpen={true}
        onClose={() => {}}
        environmentId="env-1"
        environment={environment}
      />
    );

    await waitFor(() => {
      expect(apiMocks.readLogFile).toHaveBeenCalledWith('C:/Games/Schedule I/Logs/Session-latest.log', 4000);
    });
    const viewerHeader = container.querySelector('.logs-panel__viewer-header');
    expect(viewerHeader).toBeTruthy();
    expect(within(viewerHeader as HTMLElement).getByRole('heading', { name: 'Session-latest.log' })).toBeTruthy();
  });

  it('shows a loading state immediately after selecting a different log file', async () => {
    const archivedLoad = createDeferred<Array<ReturnType<typeof makeLogLine>>>();
    apiMocks.getLogFiles.mockResolvedValue([
      makeLogFile({
        name: 'Session-latest.log',
        path: 'C:/Games/Schedule I/Logs/Session-latest.log',
        isLatest: true,
      }),
      makeLogFile({
        name: 'Archived.log',
        path: 'C:/Games/Schedule I/Logs/Archived.log',
        isLatest: false,
      }),
    ]);
    apiMocks.readLogFile
      .mockResolvedValueOnce([
        makeLogLine({
          lineNumber: 1,
          content: 'Initial latest log line',
        }),
      ])
      .mockImplementationOnce(() => archivedLoad.promise);

    render(
      <LogsOverlay
        isOpen={true}
        onClose={() => {}}
        environmentId="env-1"
        environment={environment}
      />
    );

    expect(await screen.findByText('Initial latest log line')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /Archived\.log/i }));

    expect(await screen.findByText('Loading log file')).toBeTruthy();
    expect(screen.queryByText('Initial latest log line')).toBeNull();

    archivedLoad.resolve([
      makeLogLine({
        lineNumber: 2,
        content: 'Archived log line loaded',
      }),
    ]);

    expect(await screen.findByText('Archived log line loaded')).toBeTruthy();
  });

  it('uses cached archived log content when switching back to an unchanged file', async () => {
    apiMocks.getLogFiles.mockResolvedValue([
      makeLogFile({
        name: 'Session.log',
        path: 'C:/Games/Schedule I/Logs/Session.log',
        size: 1024,
        modified: '2026-03-24T18:00:00.000Z',
        isLatest: false,
      }),
      makeLogFile({
        name: 'Archived.log',
        path: 'C:/Games/Schedule I/Logs/Archived.log',
        size: 2048,
        modified: '2026-03-23T18:00:00.000Z',
        isLatest: false,
      }),
    ]);
    apiMocks.readLogFile
      .mockResolvedValueOnce([
        makeLogLine({
          lineNumber: 1,
          content: 'Cached session log line',
        }),
      ])
      .mockResolvedValueOnce([
        makeLogLine({
          lineNumber: 2,
          content: 'Archived log line',
        }),
      ]);

    render(
      <LogsOverlay
        isOpen={true}
        onClose={() => {}}
        environmentId="env-1"
        environment={environment}
      />
    );

    expect(await screen.findByText('Cached session log line')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /Archived\.log/i }));
    expect(await screen.findByText('Archived log line')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /Session\.log/i }));

    expect(await screen.findByText('Cached session log line')).toBeTruthy();
    expect(apiMocks.readLogFile).toHaveBeenCalledTimes(2);
    expect(screen.queryByText('Loading log file')).toBeNull();
  });

  it('shows cached latest log content immediately while revalidating it with the backend', async () => {
    const latestReload = createDeferred<Array<ReturnType<typeof makeLogLine>>>();
    apiMocks.getLogFiles.mockResolvedValue([
      makeLogFile({
        name: 'Latest.log',
        path: 'C:/Games/Schedule I/Logs/Latest.log',
        size: 1024,
        modified: '2026-03-24T18:00:00.000Z',
        isLatest: true,
      }),
      makeLogFile({
        name: 'Archived.log',
        path: 'C:/Games/Schedule I/Logs/Archived.log',
        size: 2048,
        modified: '2026-03-23T18:00:00.000Z',
        isLatest: false,
      }),
    ]);
    apiMocks.readLogFile
      .mockResolvedValueOnce([
        makeLogLine({
          lineNumber: 1,
          content: 'Cached latest log line',
        }),
      ])
      .mockResolvedValueOnce([
        makeLogLine({
          lineNumber: 2,
          content: 'Archived log line',
        }),
      ])
      .mockImplementationOnce(() => latestReload.promise);

    render(
      <LogsOverlay
        isOpen={true}
        onClose={() => {}}
        environmentId="env-1"
        environment={environment}
      />
    );

    expect(await screen.findByText('Cached latest log line')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /Archived\.log/i }));
    expect(await screen.findByText('Archived log line')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /Latest\.log/i }));

    expect(await screen.findByText('Cached latest log line')).toBeTruthy();
    expect(apiMocks.readLogFile).toHaveBeenCalledTimes(3);

    latestReload.resolve([
      makeLogLine({
        lineNumber: 3,
        content: 'Fresh latest log line',
      }),
    ]);

    expect(await screen.findByText('Fresh latest log line')).toBeTruthy();
  });

  it('keeps the rendered latest log rows stable when revalidation returns unchanged content', async () => {
    const latestReload = createDeferred<Array<ReturnType<typeof makeLogLine>>>();
    const latestLine = makeLogLine({
      lineNumber: 1,
      content: 'Stable latest log line',
    });

    apiMocks.getLogFiles.mockResolvedValue([
      makeLogFile({
        name: 'Latest.log',
        path: 'C:/Games/Schedule I/Logs/Latest.log',
        size: 1024,
        modified: '2026-03-24T18:00:00.000Z',
        isLatest: true,
      }),
      makeLogFile({
        name: 'Archived.log',
        path: 'C:/Games/Schedule I/Logs/Archived.log',
        size: 2048,
        modified: '2026-03-23T18:00:00.000Z',
        isLatest: false,
      }),
    ]);
    apiMocks.readLogFile
      .mockResolvedValueOnce([latestLine])
      .mockResolvedValueOnce([
        makeLogLine({
          lineNumber: 2,
          content: 'Archived log line',
        }),
      ])
      .mockImplementationOnce(() => latestReload.promise);

    render(
      <LogsOverlay
        isOpen={true}
        onClose={() => {}}
        environmentId="env-1"
        environment={environment}
      />
    );

    expect(await screen.findByText('Stable latest log line')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /Archived\.log/i }));
    expect(await screen.findByText('Archived log line')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /Latest\.log/i }));
    expect(await screen.findByText('Stable latest log line')).toBeTruthy();

    const renderedLine = screen.getByText('Stable latest log line').closest('.logs-panel__line');
    expect(renderedLine).toBeTruthy();
    expect(screen.getByText('Stable latest log line').closest('.logs-panel__line')).toBe(renderedLine);

    latestReload.resolve([
      makeLogLine({
        lineNumber: 1,
        content: 'Stable latest log line',
      }),
    ]);

    await waitFor(() => {
      expect(apiMocks.readLogFile).toHaveBeenCalledTimes(3);
    });
    expect(screen.getByText('Stable latest log line').closest('.logs-panel__line')).toBe(renderedLine);
  });

  it('keeps the last ten archived log files cached and evicts only the oldest entry', async () => {
    const files = Array.from({ length: 11 }, (_, index) => {
      const logNumber = index + 1;
      return makeLogFile({
        name: `Log-${logNumber}.log`,
        path: `C:/Games/Schedule I/Logs/Log-${logNumber}.log`,
        size: 1000 + logNumber,
        modified: `2026-03-24T18:${String(logNumber).padStart(2, '0')}:00.000Z`,
        isLatest: false,
      });
    });

    apiMocks.getLogFiles.mockResolvedValue(files);
    apiMocks.readLogFile.mockImplementation(async (logPath: string) => {
      const pathParts = logPath.split('/');
      const name = pathParts[pathParts.length - 1] ?? logPath;
      return [
        makeLogLine({
          lineNumber: 1,
          content: `Loaded ${name}`,
        }),
      ];
    });

    render(
      <LogsOverlay
        isOpen={true}
        onClose={() => {}}
        environmentId="env-1"
        environment={environment}
      />
    );

    expect(await screen.findByText('Loaded Log-1.log')).toBeTruthy();

    for (let logNumber = 2; logNumber <= 11; logNumber += 1) {
      fireEvent.click(screen.getByRole('button', { name: new RegExp(`Log-${logNumber}\\.log`, 'i') }));
      expect(await screen.findByText(`Loaded Log-${logNumber}.log`)).toBeTruthy();
    }

    expect(apiMocks.readLogFile).toHaveBeenCalledTimes(11);

    fireEvent.click(screen.getByRole('button', { name: /Log-2\.log/i }));
    expect(await screen.findByText('Loaded Log-2.log')).toBeTruthy();
    expect(apiMocks.readLogFile).toHaveBeenCalledTimes(11);

    fireEvent.click(screen.getByRole('button', { name: /Log-1\.log/i }));
    expect(await screen.findByText('Loaded Log-1.log')).toBeTruthy();
    await waitFor(() => {
      expect(apiMocks.readLogFile).toHaveBeenCalledTimes(12);
    });
  });

  it('reloads cached log content when the file metadata changes', async () => {
    apiMocks.getLogFiles
      .mockResolvedValueOnce([
        makeLogFile({
          name: 'Session.log',
          path: 'C:/Games/Schedule I/Logs/Session.log',
          size: 1024,
          modified: '2026-03-24T18:00:00.000Z',
          isLatest: false,
        }),
      ])
      .mockResolvedValueOnce([
        makeLogFile({
          name: 'Session.log',
          path: 'C:/Games/Schedule I/Logs/Session.log',
          size: 2048,
          modified: '2026-03-24T18:05:00.000Z',
          isLatest: false,
        }),
      ]);
    apiMocks.readLogFile
      .mockResolvedValueOnce([
        makeLogLine({
          lineNumber: 1,
          content: 'Original session log line',
        }),
      ])
      .mockResolvedValueOnce([
        makeLogLine({
          lineNumber: 2,
          content: 'Updated session log line',
        }),
      ]);

    const { rerender } = render(
      <LogsOverlay
        isOpen={true}
        onClose={() => {}}
        environmentId="env-1"
        environment={environment}
      />
    );

    expect(await screen.findByText('Original session log line')).toBeTruthy();

    rerender(
      <LogsOverlay
        isOpen={false}
        onClose={() => {}}
        environmentId="env-1"
        environment={environment}
      />
    );
    rerender(
      <LogsOverlay
        isOpen={true}
        onClose={() => {}}
        environmentId="env-1"
        environment={environment}
      />
    );

    expect(await screen.findByText('Updated session log line')).toBeTruthy();
    expect(apiMocks.readLogFile).toHaveBeenCalledTimes(2);
  });

  it('clears stale log sources before loading the next environment', async () => {
    const nextEnvironment = {
      ...environment,
      id: 'env-2',
      name: 'Depot Installation',
      outputDir: 'C:/Games/Schedule I Depot',
    };
    const env2Files = createDeferred<Array<ReturnType<typeof makeLogFile>>>();

    apiMocks.getLogFiles
      .mockResolvedValueOnce([
        makeLogFile({
          name: 'Env1-latest.log',
          path: 'C:/Games/Schedule I/Logs/Env1-latest.log',
          isLatest: true,
        }),
        makeLogFile({
          name: 'Env1-archived.log',
          path: 'C:/Games/Schedule I/Logs/Env1-archived.log',
          isLatest: false,
        }),
      ])
      .mockImplementationOnce(() => env2Files.promise);
    apiMocks.readLogFile.mockResolvedValue([makeLogLine()]);

    const { rerender } = render(
      <LogsOverlay
        isOpen={true}
        onClose={() => {}}
        environmentId="env-1"
        environment={environment}
      />
    );

    expect(await screen.findByRole('heading', { name: 'Env1-latest.log' })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Env1-archived\.log/i })).toBeTruthy();

    rerender(
      <LogsOverlay
        isOpen={true}
        onClose={() => {}}
        environmentId="env-2"
        environment={nextEnvironment}
      />
    );

    await waitFor(() => {
      expect(screen.queryByRole('button', { name: /Env1-latest\.log/i })).toBeNull();
      expect(screen.queryByRole('button', { name: /Env1-archived\.log/i })).toBeNull();
    });

    env2Files.resolve([
      makeLogFile({
        name: 'Env2-latest.log',
        path: 'C:/Games/Schedule I Depot/Logs/Env2-latest.log',
        isLatest: true,
      }),
      makeLogFile({
        name: 'Env2-archived.log',
        path: 'C:/Games/Schedule I Depot/Logs/Env2-archived.log',
        isLatest: false,
      }),
    ]);

    expect(await screen.findByRole('heading', { name: 'Env2-latest.log' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /Env2-archived\.log/i }));

    await waitFor(() => {
      expect(apiMocks.readLogFile).toHaveBeenLastCalledWith('C:/Games/Schedule I Depot/Logs/Env2-archived.log', 4000);
    });
  });

  it('filters by mod activity and resets back to the full visible set', async () => {
    apiMocks.getLogFiles.mockResolvedValue([
      makeLogFile({
        name: 'Session-latest.log',
        path: 'C:/Games/Schedule I/Logs/Session-latest.log',
        isLatest: true,
      }),
    ]);
    apiMocks.readLogFile.mockResolvedValue([
      makeLogLine({
        lineNumber: 1,
        content: 'CoolMod loaded successfully',
        modTag: 'CoolMod',
        category: 'mod',
      }),
      makeLogLine({
        lineNumber: 2,
        content: 'AnotherMod threw an error',
        modTag: 'AnotherMod',
        category: 'mod',
        level: 'ERROR',
      }),
      makeLogLine({
        lineNumber: 3,
        content: 'MelonLoader bootstrap finished',
        modTag: null,
        category: 'melonloader',
      }),
    ]);

    const { container } = render(
      <LogsOverlay
        isOpen={true}
        onClose={() => {}}
        environmentId="env-1"
        environment={environment}
      />
    );

    expect(await screen.findByText('CoolMod loaded successfully')).toBeTruthy();
    const modActivitySection = [...container.querySelectorAll('.logs-panel__rail-card, .logs-panel__rail-section')]
      .find((card) => card.textContent?.includes('Mod Activity'));
    expect(modActivitySection).toBeTruthy();
    fireEvent.click(within(modActivitySection as HTMLElement).getByRole('button', { name: /CoolMod/i }));

    await waitFor(() => {
      expect(screen.getByText('Mod: CoolMod')).toBeTruthy();
    });
    expect(screen.queryByText('AnotherMod threw an error')).toBeNull();
    expect(screen.queryByText('MelonLoader bootstrap finished')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Reset Filters' }));

    await waitFor(() => {
      expect(screen.getByText('AnotherMod threw an error')).toBeTruthy();
      expect(screen.getByText('MelonLoader bootstrap finished')).toBeTruthy();
    });
  });

  it('toggles live follow state and updates the inspector when a row is selected', async () => {
    apiMocks.getLogFiles.mockResolvedValue([
      makeLogFile({
        name: 'Session-latest.log',
        path: 'C:/Games/Schedule I/Logs/Session-latest.log',
        isLatest: true,
      }),
    ]);
    apiMocks.readLogFile.mockResolvedValue([
      makeLogLine({
        lineNumber: 11,
        content: 'CoolMod loaded successfully',
        modTag: 'CoolMod',
        category: 'mod',
      }),
      makeLogLine({
        lineNumber: 12,
        content: 'CoolMod warning: fallback path engaged',
        modTag: 'CoolMod',
        category: 'mod',
        level: 'WARN',
      }),
    ]);

    const { container } = render(
      <LogsOverlay
        isOpen={true}
        onClose={() => {}}
        environmentId="env-1"
        environment={environment}
      />
    );

    expect(await screen.findByRole('button', { name: 'Pause Live' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Pause Live' }));
    expect(await screen.findByRole('button', { name: 'Follow Live' })).toBeTruthy();

    const logRows = container.querySelectorAll('.logs-panel__line');
    expect(logRows.length).toBeGreaterThan(1);
    fireEvent.click(logRows[1] as HTMLElement);

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Line 12' })).toBeTruthy();
    });
  });

  it('shows the jump-to-live overlay only after scrolling off the bottom of a live log', async () => {
    apiMocks.getLogFiles.mockResolvedValue([
      makeLogFile({
        name: 'Session-latest.log',
        path: 'C:/Games/Schedule I/Logs/Session-latest.log',
        isLatest: true,
      }),
    ]);
    apiMocks.readLogFile.mockResolvedValue([
      makeLogLine({
        lineNumber: 1,
        content: 'Latest line 1',
        category: 'general',
      }),
      makeLogLine({
        lineNumber: 2,
        content: 'Latest line 2',
        category: 'general',
      }),
    ]);

    const { container } = render(
      <LogsOverlay
        isOpen={true}
        onClose={() => {}}
        environmentId="env-1"
        environment={environment}
      />
    );

    await screen.findByText('Latest line 2');
    expect(container.querySelector('.logs-panel__jump-live-button')).toBeNull();

    const stream = container.querySelector('.logs-panel__stream') as HTMLDivElement | null;
    expect(stream).toBeTruthy();

    if (stream) {
      Object.defineProperty(stream, 'scrollHeight', {
        configurable: true,
        value: 1000,
      });
      Object.defineProperty(stream, 'clientHeight', {
        configurable: true,
        value: 300,
      });
      Object.defineProperty(stream, 'scrollTop', {
        configurable: true,
        value: 400,
        writable: true,
      });
      fireEvent.scroll(stream);
    }

    await waitFor(() => {
      expect(container.querySelector('.logs-panel__jump-live-button')).toBeTruthy();
    });
  });

  it('renders each log entry as a metadata row followed by a full-width content row', async () => {
    apiMocks.getLogFiles.mockResolvedValue([
      makeLogFile({
        name: 'Session-latest.log',
        path: 'C:/Games/Schedule I/Logs/Session-latest.log',
        isLatest: true,
      }),
    ]);
    apiMocks.readLogFile.mockResolvedValue([
      makeLogLine({
        lineNumber: 173,
        timestamp: '18:16:12.245',
        level: 'INFO',
        category: 'general',
        modTag: 'PackRat',
        content: 'Registering backpack save file for player.',
      }),
    ]);

    const { container } = render(
      <LogsOverlay
        isOpen={true}
        onClose={() => {}}
        environmentId="env-1"
        environment={environment}
      />
    );

    await screen.findByText('Registering backpack save file for player.');
    const row = container.querySelector('.logs-panel__line');
    expect(row).toBeTruthy();
    const directChildren = row ? Array.from(row.children) : [];
    expect(directChildren).toHaveLength(2);
    expect(directChildren[0]?.classList.contains('logs-panel__line-meta')).toBe(true);
    expect(directChildren[1]?.classList.contains('logs-panel__line-content')).toBe(true);
  });

  it('uses backend warning severity even when recovered IL2CPP messages contain failed text', async () => {
    apiMocks.getLogFiles.mockResolvedValue([
      makeLogFile({
        name: 'Session-latest.log',
        path: 'C:/Games/Schedule I/Logs/Session-latest.log',
        isLatest: true,
      }),
    ]);
    apiMocks.readLogFile.mockResolvedValue([
      makeLogLine({
        lineNumber: 184,
        timestamp: '23:49:03.471',
        level: 'WARN',
        category: 'melonloader',
        modTag: null,
        content: '[Il2CppInterop] Failed to init IL2CPP patch backend for void UnityEngine.WaitForSeconds::.ctor(float seconds), using normal patch handlers: Derived classes must provide an implementation.',
      }),
    ]);

    render(
      <LogsOverlay
        isOpen={true}
        onClose={() => {}}
        environmentId="env-1"
        environment={environment}
      />
    );

    expect(await screen.findByText(/Failed to init IL2CPP patch backend/)).toBeTruthy();
    expect(screen.getByText('Warning')).toBeTruthy();
    expect(screen.queryByText('Error')).toBeNull();
  });

  it('virtualizes large log files instead of mounting every line at once', async () => {
    apiMocks.getLogFiles.mockResolvedValue([
      makeLogFile({
        name: 'Session-latest.log',
        path: 'C:/Games/Schedule I/Logs/Session-latest.log',
        isLatest: true,
      }),
    ]);
    apiMocks.readLogFile.mockResolvedValue(
      Array.from({ length: 500 }, (_, index) => makeLogLine({
        lineNumber: index + 1,
        content: `Large log line ${index + 1}`,
        category: 'general',
      })),
    );

    const { container } = render(
      <LogsOverlay
        isOpen={true}
        onClose={() => {}}
        environmentId="env-1"
        environment={environment}
      />
    );

    expect(await screen.findByText('Large log line 1')).toBeTruthy();
    expect(screen.queryByText(/500 Lines loaded/)).toBeNull();
    expect(container.querySelectorAll('.logs-panel__line').length).toBeLessThan(80);
    expect(container.querySelector('.logs-panel__virtual-spacer')).toBeTruthy();
  });

  it('accounts for merged multi-line log entry height while virtualizing', async () => {
    const stackTrace = Array.from({ length: 80 }, (_, index) => (
      `   at Example.Namespace.Type.Method${index}() in <00000000000000000000000000000000>:0`
    )).join('\n');

    apiMocks.getLogFiles.mockResolvedValue([
      makeLogFile({
        name: 'Session-latest.log',
        path: 'C:/Games/Schedule I/Logs/Session-latest.log',
        isLatest: true,
      }),
    ]);
    apiMocks.readLogFile.mockResolvedValue([
      makeLogLine({
        lineNumber: 1,
        content: `Merged IL2CPP exception\n${stackTrace}`,
        category: 'melonloader',
        level: 'ERROR',
      }),
      ...Array.from({ length: 99 }, (_, index) => makeLogLine({
        lineNumber: index + 2,
        content: `Following live line ${index + 2}`,
        category: 'general',
      })),
    ]);

    const { container } = render(
      <LogsOverlay
        isOpen={true}
        onClose={() => {}}
        environmentId="env-1"
        environment={environment}
      />
    );

    expect(await screen.findByText(/Merged IL2CPP exception/)).toBeTruthy();
    const spacers = Array.from(container.querySelectorAll('.logs-panel__virtual-spacer')) as HTMLDivElement[];
    const spacerHeights = spacers.map((spacer) => Number.parseFloat(spacer.style.height || '0'));
    expect(Math.max(...spacerHeights)).toBeGreaterThan(4800);
  });

  it('loads an older log chunk when scrolling near the top of a tailed file', async () => {
    const olderLoad = createDeferred<Array<ReturnType<typeof makeLogLine>>>();
    apiMocks.getLogFiles.mockResolvedValue([
      makeLogFile({
        name: 'Session-latest.log',
        path: 'C:/Games/Schedule I/Logs/Session-latest.log',
        isLatest: true,
      }),
    ]);
    apiMocks.readLogFile
      .mockResolvedValueOnce(
        Array.from({ length: 4000 }, (_, index) => makeLogLine({
          lineNumber: index + 101,
          content: `Tailed log line ${index + 101}`,
          category: 'general',
        })),
      )
      .mockImplementationOnce(() => olderLoad.promise);

    const { container } = render(
      <LogsOverlay
        isOpen={true}
        onClose={() => {}}
        environmentId="env-1"
        environment={environment}
      />
    );

    expect(await screen.findByText('Tailed log line 101')).toBeTruthy();

    const stream = container.querySelector('.logs-panel__stream') as HTMLDivElement | null;
    expect(stream).toBeTruthy();

    if (stream) {
      Object.defineProperty(stream, 'scrollHeight', {
        configurable: true,
        value: 240000,
      });
      Object.defineProperty(stream, 'clientHeight', {
        configurable: true,
        value: 720,
      });
      Object.defineProperty(stream, 'scrollTop', {
        configurable: true,
        value: 100,
        writable: true,
      });
      fireEvent.scroll(stream);
    }

    await waitFor(() => {
      expect(apiMocks.readLogFile).toHaveBeenLastCalledWith('C:/Games/Schedule I/Logs/Session-latest.log', 8000);
    });

    olderLoad.resolve(
      Array.from({ length: 4100 }, (_, index) => makeLogLine({
        lineNumber: index + 1,
        content: `Expanded log line ${index + 1}`,
        category: 'general',
      })),
    );

    await waitFor(() => {
      expect(screen.getAllByText('4100').length).toBeGreaterThan(0);
    });
  });

  it('does not load older entries when a tailed live log is already at the bottom', async () => {
    apiMocks.getLogFiles.mockResolvedValue([
      makeLogFile({
        name: 'Session-latest.log',
        path: 'C:/Games/Schedule I/Logs/Session-latest.log',
        isLatest: true,
      }),
    ]);
    apiMocks.readLogFile.mockResolvedValue(
      Array.from({ length: 10 }, (_, index) => makeLogLine({
        lineNumber: index + 101,
        content: `Visible live line ${index + 101}`,
        category: 'general',
      })),
    );

    const { container } = render(
      <LogsOverlay
        isOpen={true}
        onClose={() => {}}
        environmentId="env-1"
        environment={environment}
      />
    );

    expect(await screen.findByText('Visible live line 101')).toBeTruthy();

    const stream = container.querySelector('.logs-panel__stream') as HTMLDivElement | null;
    expect(stream).toBeTruthy();

    if (stream) {
      Object.defineProperty(stream, 'scrollHeight', {
        configurable: true,
        value: 720,
      });
      Object.defineProperty(stream, 'clientHeight', {
        configurable: true,
        value: 720,
      });
      Object.defineProperty(stream, 'scrollTop', {
        configurable: true,
        value: 0,
        writable: true,
      });
      fireEvent.scroll(stream);
    }

    await waitFor(() => {
      expect(apiMocks.readLogFile).toHaveBeenCalledTimes(1);
    });
    expect(screen.queryByText('Loading earlier entries')).toBeNull();
  });

  it('keeps edge-case metadata visible for missing timestamps and long mod tags', async () => {
    apiMocks.getLogFiles.mockResolvedValue([
      makeLogFile({
        name: 'Session-latest.log',
        path: 'C:/Games/Schedule I/Logs/Session-latest.log',
        isLatest: true,
      }),
    ]);
    apiMocks.readLogFile.mockResolvedValue([
      makeLogLine({
        lineNumber: 301,
        timestamp: null,
        level: 'WARN',
        category: 'mod',
        modTag: 'ExtremelyVerbosePackRatDebugInstrumentationSuite',
        content: 'A very long warning message still needs to wrap cleanly underneath the metadata row.',
      }),
    ]);

    const { container } = render(
      <LogsOverlay
        isOpen={true}
        onClose={() => {}}
        environmentId="env-1"
        environment={environment}
      />
    );

    await screen.findByText('A very long warning message still needs to wrap cleanly underneath the metadata row.');
    expect(screen.getByText('—')).toBeTruthy();
    const modChip = container.querySelector('.logs-panel__mod-chip');
    expect(modChip?.textContent).toBe('ExtremelyVerbosePackRatDebugInstrumentationSuite');
  });

  it('collapses the inspector at tighter widths, shows a mini summary, and auto-expands on selection', async () => {
    Object.defineProperty(window, 'innerWidth', {
      configurable: true,
      writable: true,
      value: 1100,
    });
    window.dispatchEvent(new Event('resize'));

    apiMocks.getLogFiles.mockResolvedValue([
      makeLogFile({
        name: 'Session-latest.log',
        path: 'C:/Games/Schedule I/Logs/Session-latest.log',
        isLatest: true,
      }),
    ]);
    apiMocks.readLogFile.mockResolvedValue([
      makeLogLine({
        lineNumber: 21,
        content: 'CoolMod loaded successfully',
        modTag: 'CoolMod',
        category: 'mod',
      }),
      makeLogLine({
        lineNumber: 22,
        content: 'MelonLoader bootstrap finished',
        modTag: null,
        category: 'melonloader',
      }),
    ]);

    const { container } = render(
      <LogsOverlay
        isOpen={true}
        onClose={() => {}}
        environmentId="env-1"
        environment={environment}
      />
    );

    await screen.findByText('CoolMod loaded successfully');

    expect(screen.getByRole('button', { name: 'Expand Inspector' })).toBeTruthy();
    const collapsedInspector = container.querySelector('.logs-panel__inspector--collapsed');
    expect(collapsedInspector).toBeTruthy();
    expect(within(collapsedInspector as HTMLElement).getByText('No selection')).toBeTruthy();
    expect(within(collapsedInspector as HTMLElement).getByText('Errors')).toBeTruthy();
    expect(within(collapsedInspector as HTMLElement).getByText('Warnings')).toBeTruthy();

    const logRows = container.querySelectorAll('.logs-panel__line');
    fireEvent.click(logRows[0] as HTMLElement);

    await waitFor(() => {
      expect(container.querySelector('.logs-panel__inspector--collapsed')).toBeNull();
      expect(screen.getByRole('heading', { name: 'Line 21' })).toBeTruthy();
      expect(screen.getByRole('button', { name: 'Collapse Inspector' })).toBeTruthy();
    });
  });
});
