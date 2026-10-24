import { useGameLaunchStore, type GameLaunchAttempt } from '../stores/gameLaunchStore';
import { Icon } from './Icon';
import { SimmButton, SimmIconButton } from './primitives';

export function launchStatusCopy(attempt: GameLaunchAttempt): string {
  if (attempt.detail) return attempt.detail;
  if (attempt.state === 'exited') return 'Schedule I closed before MelonLoader startup was confirmed.';
  if (attempt.snapshot?.processState === 'running') return attempt.snapshot.loaderState === 'notInstalled' ? 'Schedule I is running.' : 'Schedule I is running; MelonLoader has not been confirmed.';
  if (attempt.snapshot?.processState === 'unknown') return 'SIMM could not inspect whether Schedule I is running. Startup remains unconfirmed.';
  if (attempt.state === 'unconfirmed') return 'SIMM could not confirm that Schedule I started.';
  return 'SIMM is checking for the selected game process and startup log.';
}

interface GameLaunchStatusViewProps {
  attempts: ReadonlyMap<string, GameLaunchAttempt>;
  onViewLogs: (environmentId: string) => void;
  checkAgain: (environmentId: string) => void;
  dismissNotice: (environmentId: string) => void;
}

export function GameLaunchStatus({ onViewLogs }: { onViewLogs: (environmentId: string) => void }) {
  const { attempts, checkAgain, dismissNotice } = useGameLaunchStore();
  return <GameLaunchStatusView attempts={attempts} checkAgain={checkAgain} dismissNotice={dismissNotice} onViewLogs={onViewLogs} />;
}

export function GameLaunchStatusView({ attempts, checkAgain, dismissNotice, onViewLogs }: GameLaunchStatusViewProps) {
  const visible = [...attempts.values()].filter((attempt) => !attempt.noticeDismissed && ['checking', 'slow', 'unconfirmed', 'exited'].includes(attempt.state));
  if (visible.length === 0) return null;
  return (
    <section className="game-launch-status" aria-label="Game launch status">
      {visible.map((attempt) => {
        const checking = attempt.state === 'checking';
        return (
          <div key={attempt.attemptId} className="game-launch-status__notice" role="status" aria-live="polite" aria-atomic="true">
            <Icon name={checking ? 'spinner' : 'circleInfo'} spin={checking} className="game-launch-status__icon" aria-hidden="true" />
            <div className="game-launch-status__content">
              <div className="game-launch-status__title">
                <strong>{attempt.state === 'slow' ? 'Schedule I is taking longer to start' : checking ? 'Starting Schedule I' : 'Schedule I startup status'}</strong>
                <span className="game-launch-status__environment">{attempt.environmentName}</span>
              </div>
              <p className="game-launch-status__body">{launchStatusCopy(attempt)}</p>
              {attempt.snapshot?.diagnostic ? <p className="game-launch-status__detail">{attempt.snapshot.diagnostic}</p> : null}
              {attempt.snapshot?.logPath ? <span className="game-launch-status__path">{attempt.snapshot.logPath}</span> : null}
            </div>
            <div className="game-launch-status__actions">
              {['unconfirmed', 'exited'].includes(attempt.state) ? <SimmButton variant="ghost" size="sm" onClick={() => checkAgain(attempt.environmentId)}>Check Again</SimmButton> : null}
              <SimmButton variant="secondary" size="sm" onClick={() => onViewLogs(attempt.environmentId)}>View Logs</SimmButton>
              <SimmIconButton aria-label="Dismiss" title="Dismiss" onClick={() => dismissNotice(attempt.environmentId)}>
                <Icon name="times" />
              </SimmIconButton>
            </div>
          </div>
        );
      })}
    </section>
  );
}
