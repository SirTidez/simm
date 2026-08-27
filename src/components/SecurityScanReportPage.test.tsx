import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { SecurityScanReportPage } from './SecurityScanReportPage';

describe('SecurityScanReportPage', () => {
  afterEach(() => {
    cleanup();
  });

  it('returns to the previous workspace from the report page', () => {
    const onReturn = vi.fn();

    render(
      <SecurityScanReportPage
        title="Security Findings - Example"
        report={{
          summary: {
            state: 'verified',
            verified: true,
            totalFindings: 0,
            threatFamilyCount: 0,
          },
          policy: {
            enabled: true,
            requiresConfirmation: false,
            blocked: false,
            promptOnHighFindings: false,
            blockCriticalFindings: false,
          },
          files: [],
        }}
        onReturn={onReturn}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /Back/i }));

    expect(onReturn).toHaveBeenCalledTimes(1);
  });

  it('catches confirmation failures and keeps the page open', async () => {
    const onReturn = vi.fn();
    const onConfirm = vi.fn().mockRejectedValue(new Error('blocked'));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      render(
        <SecurityScanReportPage
          title="Security Findings - Example"
          report={{
            summary: {
              state: 'review',
              verified: false,
              totalFindings: 1,
              threatFamilyCount: 0,
            },
            policy: {
              enabled: true,
              requiresConfirmation: true,
              blocked: false,
              promptOnHighFindings: false,
              blockCriticalFindings: false,
            },
            files: [],
          }}
          onConfirm={onConfirm}
          onReturn={onReturn}
        />,
      );

      fireEvent.click(screen.getByRole('button', { name: 'Continue Anyway' }));

      await waitFor(() => {
        expect(onConfirm).toHaveBeenCalledTimes(1);
        expect(errorSpy).toHaveBeenCalled();
      });
      expect(onReturn).not.toHaveBeenCalled();
      expect(screen.getByText('Security Findings - Example')).toBeTruthy();
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('locks Back until the confirmed continuation has completed', async () => {
    let finishConfirmation: (() => void) | undefined;
    const onConfirm = vi.fn(() => new Promise<void>((resolve) => {
      finishConfirmation = resolve;
    }));
    const onReturn = vi.fn();

    render(
      <SecurityScanReportPage
        title="Security Findings - Example"
        report={{
          summary: { state: 'review', verified: false, totalFindings: 1, threatFamilyCount: 0 },
          policy: {
            enabled: true,
            requiresConfirmation: true,
            blocked: false,
            promptOnHighFindings: false,
            blockCriticalFindings: false,
          },
          files: [],
        }}
        onConfirm={onConfirm}
        onReturn={onReturn}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Continue Anyway' }));
    expect(screen.getByRole('button', { name: /Back/i })).toBeDisabled();

    finishConfirmation?.();
    await waitFor(() => expect(onReturn).toHaveBeenCalledTimes(1));
  });
});
