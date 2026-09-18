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
      className="melonloader-update-toast"
      role="status"
      aria-live="polite"
      aria-labelledby="melonloader-update-toast-title"
    >
      <header className="melonloader-update-toast__header">
        <div>
          <span className="melonloader-update-toast__eyebrow">Stable release available</span>
          <strong id="melonloader-update-toast-title">MelonLoader {notice.latestVersion}</strong>
        </div>
        <SimmIconButton
          className="window-control-btn melonloader-update-toast__dismiss"
          onClick={onDismiss}
          aria-label="Dismiss MelonLoader update notice"
          title="Dismiss this release"
        >
          <Icon name="times" />
        </SimmIconButton>
      </header>

      <p>
        A newer stable MelonLoader release is available for{' '}
        {notice.targets.length === 1 ? '1 environment' : `${notice.targets.length} environments`}.
        Nightly builds are not included in this notification.
      </p>

      <div className="melonloader-update-toast__targets" aria-label="Environments with an available MelonLoader update">
        {visibleNames.join(', ')}
        {remainingCount > 0 ? `, and ${remainingCount} more` : ''}
      </div>

      <footer className="melonloader-update-toast__actions">
        <SimmButton type="button" className="btn btn-primary btn-small" onClick={onReview}>
          Review environments
        </SimmButton>
      </footer>
    </section>
  );
}
