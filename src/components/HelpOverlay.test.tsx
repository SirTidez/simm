import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { HelpOverlay } from './HelpOverlay';

describe('HelpOverlay', () => {
  it('renders quick actions and routes them through callbacks', () => {
    const onClose = vi.fn();
    const onOpenWizard = vi.fn();
    const onOpenSettings = vi.fn();
    const onOpenAccounts = vi.fn();

    render(
      <HelpOverlay
        isOpen={true}
        onClose={onClose}
        onOpenWizard={onOpenWizard}
        onOpenSettings={onOpenSettings}
        onOpenAccounts={onOpenAccounts}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: /create environment/i }));
    fireEvent.click(screen.getByRole('button', { name: /open settings/i }));
    fireEvent.click(screen.getByRole('button', { name: /open accounts/i }));

    expect(onOpenWizard).toHaveBeenCalledTimes(1);
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
    expect(onOpenAccounts).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/where to start/i)).toBeTruthy();
  });

  it('closes on escape', () => {
    const onClose = vi.fn();

    render(
      <HelpOverlay
        isOpen={true}
        onClose={onClose}
        onOpenWizard={vi.fn()}
        onOpenSettings={vi.fn()}
        onOpenAccounts={vi.fn()}
      />
    );

    fireEvent.keyDown(document, { key: 'Escape' });

    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
