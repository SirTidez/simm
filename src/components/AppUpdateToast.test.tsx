import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AppUpdateToast } from './AppUpdateToast';

describe('AppUpdateToast', () => {
  it('renders versions and forwards actions', async () => {
    const onUpdate = vi.fn();
    const onSkip = vi.fn();
    const onSnooze = vi.fn();
    const onDismiss = vi.fn();

    render(
      <AppUpdateToast
        currentVersion="0.7.8"
        latestVersion="0.7.9-beta"
        onUpdate={onUpdate}
        onSkip={onSkip}
        onSnooze={onSnooze}
        onDismiss={onDismiss}
      />,
    );

    expect(screen.getByText('0.7.8')).toBeTruthy();
    expect(screen.getByText('0.7.9-beta')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Update' }));
    expect(onUpdate).toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: /Later/ }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Remind Me in 2 Weeks' }));
    expect(onSnooze).toHaveBeenCalledWith(14);

    fireEvent.click(screen.getByRole('button', { name: /Later/ }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Skip This Version' }));
    expect(onSkip).toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: /Dismiss app update notice/i }));
    expect(onDismiss).toHaveBeenCalled();
  });
});
