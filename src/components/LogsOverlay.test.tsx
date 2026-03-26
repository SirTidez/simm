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

vi.mock('../services/api', () => ({
  ApiService: apiMocks,
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: listenMock,
}));

vi.mock('@tauri-apps/plugin-dialog', () => ({
  save: saveMock,
}));

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

describe('LogsOverlay', () => {
  const originalInnerWidth = window.innerWidth;

  beforeEach(() => {
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
      expect(apiMocks.readLogFile).toHaveBeenCalledWith('C:/Games/Schedule I/Logs/Session-latest.log');
    });
    const viewerHeader = container.querySelector('.logs-panel__viewer-header');
    expect(viewerHeader).toBeTruthy();
    expect(within(viewerHeader as HTMLElement).getByRole('heading', { name: 'Session-latest.log' })).toBeTruthy();
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
