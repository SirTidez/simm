import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppDialogProvider, useAppDialogs } from './AppDialogProvider';

afterEach(cleanup);

describe('AppDialogProvider', () => {
  it('keeps a queued destructive decision unapproved when the previous dialog closes', async () => {
    const first = vi.fn();
    const second = vi.fn();
    function Actions() {
      const { confirm } = useAppDialogs();
      return <button onClick={() => {
        void confirm('Restart Steam?', { title: 'Restart', okLabel: 'Restart Steam' }).then(first);
        void confirm('Delete the exact selected profile?', { title: 'Delete profile' }).then(second);
      }}>Begin</button>;
    }
    render(<AppDialogProvider><Actions /></AppDialogProvider>);
    fireEvent.click(screen.getByRole('button', { name: 'Begin' }));
    const restart = await screen.findByRole('alertdialog', { name: 'Restart' });
    expect(restart).toHaveClass('app-dialog');
    fireEvent.click(within(restart).getByRole('button', { name: 'Restart Steam' }));
    const deletion = await screen.findByRole('alertdialog', { name: 'Delete profile' });
    expect(first).toHaveBeenCalledWith(true);
    expect(second).not.toHaveBeenCalled();
    fireEvent.click(within(deletion).getByRole('button', { name: 'Cancel' }));
    await vi.waitFor(() => expect(second).toHaveBeenCalledWith(false));
  });

  it('cancels pending approvals on unmount', async () => {
    const result = vi.fn();
    function Action() {
      const { confirm } = useAppDialogs();
      return <button onClick={() => void confirm('Approve exact file?', { title: 'Security review' }).then(result)}>Review</button>;
    }
    const view = render(<AppDialogProvider><Action /></AppDialogProvider>);
    fireEvent.click(screen.getByRole('button', { name: 'Review' }));
    await screen.findByRole('alertdialog', { name: 'Security review' });
    view.unmount();
    await vi.waitFor(() => expect(result).toHaveBeenCalledWith(false));
  });

  it('shows errors in the app-themed message dialog', async () => {
    function Action() {
      const { message } = useAppDialogs();
      return <button onClick={() => void message('The launch request was rejected.', { title: 'Launch failed', kind: 'error' })}>Launch</button>;
    }
    render(<AppDialogProvider><Action /></AppDialogProvider>);
    fireEvent.click(screen.getByRole('button', { name: 'Launch' }));
    const error = await screen.findByRole('dialog', { name: 'Launch failed' });
    expect(error).toHaveClass('app-dialog--danger');
    expect(error).toHaveTextContent('The launch request was rejected.');
    fireEvent.click(within(error).getByRole('button', { name: 'OK' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
