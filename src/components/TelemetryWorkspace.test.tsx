import { act, render, screen, waitFor } from '@testing-library/react';
import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TelemetryWorkspace } from './TelemetryWorkspace';

const telemetryApi = vi.hoisted(() => ({
  getTelemetryCapability: vi.fn(),
  getTelemetryPreferences: vi.fn(),
  getLiveTelemetryStatus: vi.fn(),
  listLiveTelemetryEvents: vi.fn(),
  listTelemetryUploads: vi.fn(),
  exportLiveTelemetryHistory: vi.fn(),
}));
const telemetryEvents = vi.hoisted(() => ({
  eventHandler: null as (() => void) | null,
}));

vi.mock('../services/api', () => ({ ApiService: telemetryApi }));
vi.mock('../services/events', () => ({
  createAsyncListenerScope: (onError?: (error: unknown) => void) => {
    let disposed = false;
    const unlisteners = new Set<() => void>();
    return {
      register: (subscribe: () => Promise<() => void>) => {
        void subscribe().then((unlisten) => {
          if (disposed) unlisten(); else unlisteners.add(unlisten);
        }).catch(onError);
      },
      dispose: () => {
        disposed = true;
        unlisteners.forEach((unlisten) => unlisten());
        unlisteners.clear();
      },
      isActive: () => !disposed,
    };
  },
  onLiveTelemetryEvent: vi.fn(async (handler: () => void) => {
    telemetryEvents.eventHandler = handler;
    return () => {};
  }),
  onLiveTelemetryStatus: vi.fn(async () => () => {}),
}));
vi.mock('../stores/environmentStore', () => ({
  useEnvironmentStore: () => ({ environments: [] }),
}));
vi.mock('./ConfirmOverlay', () => ({ ConfirmOverlay: () => null }));
vi.mock('./WorkspacePageHeader', () => ({ WorkspacePageHeader: ({ title }: { title: string }) => <h1>{title}</h1> }));
vi.mock('./Icon', () => ({ Icon: () => null }));
vi.mock('./primitives', () => ({
  SimmButton: ({ children, ...props }: ButtonHTMLAttributes<HTMLButtonElement>) => <button {...props}>{children}</button>,
  SimmDialogContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

describe('TelemetryWorkspace', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    telemetryEvents.eventHandler = null;
    telemetryApi.getTelemetryCapability.mockResolvedValue({ available: true });
    telemetryApi.getTelemetryPreferences.mockResolvedValue({
      collectionEnabled: true, uploadEnabled: false, errorExcerptsEnabled: false,
      retentionDays: 7, protectLocalMods: true,
    });
    telemetryApi.getLiveTelemetryStatus.mockResolvedValue([]);
    telemetryApi.listLiveTelemetryEvents.mockResolvedValue([]);
    telemetryApi.listTelemetryUploads.mockResolvedValue([]);
    telemetryApi.exportLiveTelemetryHistory.mockResolvedValue({
      schemaVersion: 1, exportedAt: '2026-09-03T00:00:00.000Z', sessions: [],
    });
  });

  it('shows a visible recovery error when backend capability lookup is rejected', async () => {
    telemetryApi.getTelemetryCapability.mockRejectedValueOnce(new Error('Telemetry capability unavailable'));

    render(<TelemetryWorkspace onClose={() => undefined} />);

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('Telemetry capability unavailable');
    });
    expect(screen.getByRole('button', { name: /retry refresh/i })).toBeVisible();
  });

  it('does not let an older overlapping refresh replace newer event data', async () => {
    render(<TelemetryWorkspace onClose={() => undefined} />);
    await waitFor(() => expect(telemetryEvents.eventHandler).not.toBeNull());
    await waitFor(() => expect(telemetryApi.listLiveTelemetryEvents).toHaveBeenCalledTimes(1));

    let resolveOlder: (events: unknown[]) => void = () => {};
    telemetryApi.listLiveTelemetryEvents
      .mockReturnValueOnce(new Promise((resolve) => { resolveOlder = resolve; }))
      .mockResolvedValueOnce([{
        eventId: 'new-event', sessionId: 'session', environmentId: 'environment',
        occurredAt: '2026-09-03T00:00:02.000Z', severity: 'ERROR', attribution: 'system',
        fingerprint: 'new', errorClass: 'new-error', message: 'new diagnostic',
        source: 'Latest.log', origin: 'live',
      }]);

    act(() => telemetryEvents.eventHandler?.());
    await waitFor(() => expect(telemetryApi.listLiveTelemetryEvents).toHaveBeenCalledTimes(2));
    act(() => telemetryEvents.eventHandler?.());
    await waitFor(() => expect(screen.getByText('new diagnostic')).toBeVisible());

    await act(async () => {
      resolveOlder([{
        eventId: 'old-event', sessionId: 'session', environmentId: 'environment',
        occurredAt: '2026-09-03T00:00:01.000Z', severity: 'ERROR', attribution: 'system',
        fingerprint: 'old', errorClass: 'old-error', message: 'old diagnostic',
        source: 'Latest.log', origin: 'live',
      }]);
    });

    expect(screen.getByText('new diagnostic')).toBeVisible();
    expect(screen.queryByText('old diagnostic')).not.toBeInTheDocument();
  });
});
