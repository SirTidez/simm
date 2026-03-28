import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { SecurityScanReportPage } from './SecurityScanReportPage';

describe('SecurityScanReportPage', () => {
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
      expect(screen.getByText('Security Findings')).toBeTruthy();
    } finally {
      errorSpy.mockRestore();
    }
  });
});
