import type { MelonLoaderUpdateNotice } from '../types';
import { Icon } from './Icon';
import { SimmButton, SimmIconButton } from './primitives';

type MelonLoaderUpdateToastProps = {
  notice: MelonLoaderUpdateNotice;
  onReview: () => void;
  onDismiss: () => void;
};

export function MelonLoaderUpdateToast({
  notice,
  onReview,
  onDismiss,
}: MelonLoaderUpdateToastProps) {
  const environmentNames = notice.targets.map((target) => target.environmentName);
  const visibleNames = environmentNames.slice(0, 3);
  const remainingCount = environmentNames.length - visibleNames.length;

  return (
    <section
      className="melonloader-update-toast notice-toast"
      role="status"
      aria-live="polite"
      aria-labelledby="melonloader-update-toast-title"
    >
      <header className="notice-toast__header">
        <strong id="melonloader-update-toast-title" className="notice-toast__title">MelonLoader {notice.latestVersion}</strong>
        <SimmIconButton
          className="notice-toast__dismiss"
          onClick={onDismiss}
          aria-label="Dismiss MelonLoader update notice"
          title="Dismiss this release"
        >
          <Icon name="times" />
        </SimmIconButton>
      </header>

      <p className="notice-toast__body">
        New stable release for{' '}
        <span>
          {visibleNames.join(', ')}
        </span>
        {remainingCount > 0 ? ` and ${remainingCount} more` : ''}.
      </p>

      <footer className="notice-toast__actions">
        <SimmButton type="button" size="sm" onClick={onReview}>
          Review Environments
        </SimmButton>
      </footer>
    </section>
  );
}
