import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import { ConfirmOverlay } from './ConfirmOverlay';

describe('ConfirmOverlay', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  afterEach(() => {
    cleanup();
  });

  it('renders title, message, and actions and confirms before closing', () => {
    const onClose = vi.fn();
    const onConfirm = vi.fn();

    render(
      <ConfirmOverlay
        isOpen={true}
        onClose={onClose}
        onConfirm={onConfirm}
        title="Remove Environment"
        message="Remove this environment from SIMM?"
        confirmText="Remove"
      />
    );

    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(screen.getByText('Remove Environment')).toBeTruthy();
    expect(screen.getByText('Remove this environment from SIMM?')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));

    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('renders nested and destructive styling', () => {
    render(
      <ConfirmOverlay
        isOpen={true}
        onClose={() => {}}
        onConfirm={() => {}}
        title="Delete Plugin"
        message="Delete this plugin?"
        confirmText="Delete Plugin"
        isNested={true}
      />
    );

    const dialog = screen.getByRole('dialog');
    expect(dialog.className).toContain('app-dialog--nested');
    expect(dialog.className).toContain('app-dialog--danger');
  });

  it('closes on escape', () => {
    const onClose = vi.fn();

    render(
      <ConfirmOverlay
        isOpen={true}
        onClose={onClose}
        onConfirm={() => {}}
        title="Confirm"
        message="Continue?"
      />
    );

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('renders optional body content inside the dialog body', () => {
    render(
      <ConfirmOverlay
        isOpen={true}
        onClose={() => {}}
        onConfirm={() => {}}
        title="Remove Environment"
        message="Remove this environment from SIMM?"
        bodyContent={<label>Also delete files from disk</label>}
      />
    );

    expect(screen.getByText('Also delete files from disk')).toBeTruthy();
  });
});
