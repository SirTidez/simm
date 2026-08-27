import { render, screen, waitFor } from '@testing-library/react';
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

vi.mock('../services/api', () => ({ ApiService: telemetryApi }));
vi.mock('../services/events', () => ({
  onLiveTelemetryEvent: vi.fn(async () => () => {}),
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
  });

  it('shows a visible recovery error when backend capability lookup is rejected', async () => {
    telemetryApi.getTelemetryCapability.mockRejectedValueOnce(new Error('Telemetry capability unavailable'));

    render(<TelemetryWorkspace onClose={() => undefined} />);

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('Telemetry capability unavailable');
    });
    expect(screen.getByRole('button', { name: /retry refresh/i })).toBeVisible();
  });
});
