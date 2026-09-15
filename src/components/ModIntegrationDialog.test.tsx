import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ModIntegrationDialog } from './ModIntegrationDialog';
import type { Environment, ModIntegrationConfig, ModIntegrationRequestRecord } from '../types';

const apiMocks = vi.hoisted(() => ({
  getModIntegrationConfig: vi.fn(),
  setModIntegrationPolicy: vi.fn(),
  setModIntegrationPort: vi.fn(),
  listModIntegrationRequests: vi.fn(),
  resolveModIntegrationRequest: vi.fn(),
}));

vi.mock('../services/api', () => ({ ApiService: apiMocks }));

const environment: Environment = {
  id: 'env-1',
  name: 'Beta - Mono',
  appId: '3164500',
  branch: 'beta',
  outputDir: 'C:\\Games\\Schedule I',
  runtime: 'Mono',
  status: 'completed',
};

const config: ModIntegrationConfig = {
  environmentId: environment.id,
  policy: 'ask',
  protocolVersion: 1,
  port: 43871,
  bridgeConfigPath: 'C:\\Games\\Schedule I\\UserData\\SIMM\\mod-integration.json',
  configured: true,
  listening: true,
  pendingRequestCount: 1,
};

const request: ModIntegrationRequestRecord = {
  id: 'request-1',
  environmentId: environment.id,
  operation: 'requestUpdate',
  status: 'awaiting-user-approval',
  modFileName: 'Example.dll',
  modName: 'Example Mod',
  currentVersion: '1.0.0',
  targetVersion: '1.1.0',
  source: 'thunderstore',
  message: 'SIMM is waiting for the user to approve this update.',
  createdAt: '2026-09-13T12:00:00Z',
  updatedAt: '2026-09-13T12:00:00Z',
};

describe('ModIntegrationDialog', () => {
  beforeEach(() => {
    apiMocks.getModIntegrationConfig.mockReset().mockResolvedValue(config);
    apiMocks.setModIntegrationPolicy.mockReset().mockImplementation(async (_environmentId, policy) => ({
      ...config,
      policy,
      configured: policy !== 'disabled',
      listening: policy !== 'disabled',
    }));
    apiMocks.setModIntegrationPort.mockReset().mockImplementation(async (_environmentId, port) => ({
      ...config,
      port,
    }));
    apiMocks.listModIntegrationRequests.mockReset().mockResolvedValue([request]);
    apiMocks.resolveModIntegrationRequest.mockReset().mockResolvedValue({
      ...request,
      status: 'queued',
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    cleanup();
  });

  it('shows the per-install policy, local endpoint, and pending request', async () => {
    render(<ModIntegrationDialog isOpen={true} environment={environment} onClose={vi.fn()} />);

    expect(await screen.findByRole('heading', { name: 'Mod Integration' })).toBeTruthy();
    expect(screen.getByText('Beta - Mono')).toBeTruthy();
    expect(screen.getByRole('spinbutton', { name: 'Port' })).toHaveValue(43871);
    expect(screen.queryByText('127.0.0.1:43871')).toBeNull();
    expect(screen.getAllByText('Example Mod')).toHaveLength(2);
    expect(screen.getByRole('button', { name: 'Approve' })).toBeTruthy();
  });

  it('updates the loopback port without exposing an address', async () => {
    render(<ModIntegrationDialog isOpen={true} environment={environment} onClose={vi.fn()} />);

    const portInput = await screen.findByRole('spinbutton', { name: 'Port' });
    fireEvent.change(portInput, { target: { value: '43872' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save port' }));

    await waitFor(() => {
      expect(apiMocks.setModIntegrationPort).toHaveBeenCalledWith('env-1', 43872);
    });
    expect(screen.queryByText(/127\.0\.0\.1/)).toBeNull();
  });

  it('saves an automatic policy and approves a pending request', async () => {
    render(<ModIntegrationDialog isOpen={true} environment={environment} onClose={vi.fn()} />);
    await screen.findAllByText('Example Mod');

    fireEvent.click(screen.getByText('Queue automatically'));
    fireEvent.click(screen.getByRole('button', { name: 'Save policy' }));
    await waitFor(() => {
      expect(apiMocks.setModIntegrationPolicy).toHaveBeenCalledWith('env-1', 'automatic');
    });

    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() => {
      expect(apiMocks.resolveModIntegrationRequest).toHaveBeenCalledWith('request-1', true);
    });
  });

  it('routes an unmanaged mod request to source selection without approving an update', async () => {
    const managementRequest: ModIntegrationRequestRecord = {
      ...request,
      id: 'management-1',
      operation: 'requestManagement',
      status: 'awaiting-user-source',
      targetVersion: undefined,
      source: 'local',
      message: 'SIMM is waiting for the user to choose a source.',
    };
    const onManageRequest = vi.fn();
    apiMocks.listModIntegrationRequests.mockResolvedValue([managementRequest]);

    render(
      <ModIntegrationDialog
        isOpen={true}
        environment={environment}
        onClose={vi.fn()}
        onManageRequest={onManageRequest}
      />,
    );

    await screen.findAllByText('Example Mod');
    fireEvent.click(screen.getByRole('button', { name: 'Choose source' }));

    expect(onManageRequest).toHaveBeenCalledWith(managementRequest);
    expect(apiMocks.resolveModIntegrationRequest).not.toHaveBeenCalled();
  });

  it('does not replace an unsaved policy choice when request status refreshes', async () => {
    vi.useFakeTimers();
    render(<ModIntegrationDialog isOpen={true} environment={environment} onClose={vi.fn()} />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    fireEvent.click(screen.getByText('Queue automatically'));
    expect(screen.getByRole('radio', { name: /Queue automatically/i })).toHaveAttribute('aria-checked', 'true');

    await act(async () => {
      vi.advanceTimersByTime(2_000);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(apiMocks.getModIntegrationConfig).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('radio', { name: /Queue automatically/i })).toHaveAttribute('aria-checked', 'true');
  });
});
