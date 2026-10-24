import { useState } from 'react';
import { AnchoredContextMenu } from './AnchoredContextMenu';
import { Icon } from './Icon';
import { SimmButton, SimmIconButton } from './primitives';

type AppUpdateToastProps = {
  currentVersion: string;
  latestVersion: string;
  onUpdate: () => void;
  onSkip: () => void;
  onSnooze: (days: number) => void;
  onDismiss: () => void;
};

const snoozeOptions: Array<{ days: number; label: string }> = [
  { days: 1, label: 'Remind Me Tomorrow' },
  { days: 3, label: 'Remind Me in 3 Days' },
  { days: 7, label: 'Remind Me in 1 Week' },
  { days: 14, label: 'Remind Me in 2 Weeks' },
];

export function AppUpdateToast({
  currentVersion,
  latestVersion,
  onUpdate,
  onSkip,
  onSnooze,
  onDismiss,
}: AppUpdateToastProps) {
  const [laterMenu, setLaterMenu] = useState<{ x: number; y: number } | null>(null);

  return (
    <section
      className="app-update-toast notice-toast"
      role="status"
      aria-live="polite"
      aria-labelledby="app-update-toast-title"
    >
      <header className="notice-toast__header">
        <strong id="app-update-toast-title" className="notice-toast__title">SIMM update available</strong>
        <SimmIconButton
          className="notice-toast__dismiss"
          onClick={onDismiss}
          aria-label="Dismiss app update notice"
        >
          <Icon name="times" />
        </SimmIconButton>
      </header>

      <p className="notice-toast__body">
        Version <strong>{latestVersion}</strong> is ready to install. You have <span>{currentVersion}</span>.
      </p>

      <footer className="notice-toast__actions">
        <SimmButton
          type="button"
          variant="ghost"
          size="sm"
          aria-haspopup="menu"
          aria-expanded={laterMenu !== null}
          onClick={(event) => {
            const rect = event.currentTarget.getBoundingClientRect();
            setLaterMenu((current) => current ? null : { x: rect.left, y: rect.top - 4 - 6 * 32 });
          }}
        >
          Later
          <Icon name="chevronDown" />
        </SimmButton>
        <SimmButton type="button" size="sm" onClick={onUpdate}>
          Update
        </SimmButton>
      </footer>

      {laterMenu && (
        <AnchoredContextMenu
          id="app-update-later-menu"
          x={laterMenu.x}
          y={laterMenu.y}
          onClose={() => setLaterMenu(null)}
          items={[
            ...snoozeOptions.map((option) => ({
              key: `snooze-${option.days}`,
              label: option.label,
              icon: 'clock',
              onSelect: () => onSnooze(option.days),
            })),
            { key: 'skip', label: 'Skip This Version', icon: 'ban', onSelect: onSkip },
          ]}
        />
      )}
    </section>
  );
}
