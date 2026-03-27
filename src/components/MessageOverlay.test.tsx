import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import { MessageOverlay } from './MessageOverlay';

describe('MessageOverlay', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  afterEach(() => {
    cleanup();
  });

  it('renders success state and closes on OK', () => {
    const onClose = vi.fn();

    render(
      <MessageOverlay
        isOpen={true}
        onClose={onClose}
        title="Environment Updated"
        message="The environment was updated successfully."
        type="success"
      />
    );

    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(screen.getByText('Environment Updated')).toBeTruthy();
    expect(screen.getByText('Completed')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'OK' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('renders error state with danger styling', () => {
    render(
      <MessageOverlay
        isOpen={true}
        onClose={() => {}}
        title="Download Failed"
        message="SIMM could not complete the download."
        type="error"
        isNested={true}
      />
    );

    const dialog = screen.getByRole('dialog');
    expect(dialog.className).toContain('app-dialog--nested');
    expect(dialog.className).toContain('app-dialog--danger');
    expect(screen.getByText('Attention Required')).toBeTruthy();
  });

  it('closes on escape', () => {
    const onClose = vi.fn();

    render(
      <MessageOverlay
        isOpen={true}
        onClose={onClose}
        title="Heads Up"
        message="Review this information."
      />
    );

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
