import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MelonLoaderUpdateToast } from './MelonLoaderUpdateToast';

describe('MelonLoaderUpdateToast', () => {
  it('summarizes affected environments and exposes review and dismiss actions', () => {
    const onReview = vi.fn();
    const onDismiss = vi.fn();
    render(
      <MelonLoaderUpdateToast
        notice={{
          latestVersion: 'v0.7.4',
          releaseName: 'MelonLoader v0.7.4',
          releaseUrl: 'https://example.com',
          targets: [
            { environmentId: 'beta', environmentName: 'Beta', currentVersion: '0.7.3', runtime: 'IL2CPP' },
            { environmentId: 'alternate', environmentName: 'Alternate Beta', currentVersion: '0.7.3', runtime: 'MONO' },
          ],
        }}
        onReview={onReview}
        onDismiss={onDismiss}
      />,
    );

    expect(screen.getByText('MelonLoader v0.7.4')).toBeInTheDocument();
    expect(screen.getByText('Beta, Alternate Beta')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Review environments' }));
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss MelonLoader update notice' }));
    expect(onReview).toHaveBeenCalledTimes(1);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
