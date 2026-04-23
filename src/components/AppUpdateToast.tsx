import { useMemo, useState } from 'react';
import { Icon } from './Icon';

type AppUpdateToastProps = {
  currentVersion: string;
  latestVersion: string;
  onUpdate: () => void;
  onSkip: () => void;
  onSnooze: (days: number) => void;
  onDismiss: () => void;
};

const formatSnoozeLabel = (days: number) => (days === 1 ? '1 day' : `${days} days`);

export function AppUpdateToast({
  currentVersion,
  latestVersion,
  onUpdate,
  onSkip,
  onSnooze,
  onDismiss,
}: AppUpdateToastProps) {
  const [snoozeDays, setSnoozeDays] = useState(7);
  const snoozeLabel = useMemo(() => formatSnoozeLabel(snoozeDays), [snoozeDays]);

  return (
    <section className="app-update-toast" role="status" aria-live="polite">
      <header className="app-update-toast__header">
        <div>
          <span className="app-update-toast__eyebrow">Update ready</span>
          <strong>SIMM update available</strong>
        </div>
        <button
          type="button"
          className="window-control-btn app-update-toast__dismiss"
          onClick={onDismiss}
          aria-label="Dismiss app update notice"
        >
          <Icon name="times" />
        </button>
      </header>

      <p className="app-update-toast__summary">
        A newer SIMM build is ready to download and install.
      </p>

      <dl className="app-update-toast__versions">
        <div>
          <dt>Current version</dt>
          <dd>{currentVersion}</dd>
        </div>
        <div>
          <dt>Available version</dt>
          <dd>{latestVersion}</dd>
        </div>
      </dl>

      <div className="app-update-toast__snooze">
        <div className="app-update-toast__snooze-header">
          <label htmlFor="app-update-snooze-range">Remind me again in</label>
          <span>{snoozeLabel}</span>
        </div>
        <input
          id="app-update-snooze-range"
          className="app-update-toast__slider"
          type="range"
          min={1}
          max={14}
          step={1}
          value={snoozeDays}
          onChange={(event) => setSnoozeDays(Number(event.target.value))}
          aria-label="Snooze app update reminder"
        />
        <div className="app-update-toast__slider-scale" aria-hidden="true">
          <span>1 day</span>
          <span>2 weeks</span>
        </div>
      </div>

      <footer className="app-update-toast__actions">
        <button type="button" className="btn btn-primary" onClick={onUpdate}>
          Update
        </button>
        <button type="button" className="btn btn-secondary" onClick={() => onSnooze(snoozeDays)}>
          Snooze
        </button>
        <button type="button" className="btn btn-secondary" onClick={onSkip}>
          Skip this version
        </button>
      </footer>
    </section>
  );
}
