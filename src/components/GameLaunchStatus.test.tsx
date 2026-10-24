import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { GameLaunchStatus } from './GameLaunchStatus';
import type { GameLaunchAttempt } from '../stores/gameLaunchStore';
const store = vi.hoisted(() => ({ attempts: new Map(), checkAgain: vi.fn(), dismissNotice: vi.fn() }));
afterEach(cleanup);
vi.mock('../stores/gameLaunchStore', () => ({ useGameLaunchStore: () => store }));
const attempt: GameLaunchAttempt = { attemptId: 1, environmentId: 'captured', environmentName: 'Original environment', outputDir: 'C:/game', method: 'steam', launchStartedAt: 100, windowStartedAt: 100, state: 'slow', snapshot: { environmentId: 'captured', launchStartedAt: 100, processState: 'notRunning', loaderState: 'noLog', logPath: 'C:/game/MelonLoader/Latest.log', modifiedAt: null, diagnostic: null }, noticeDismissed: false };
beforeEach(() => { store.attempts = new Map([['captured', attempt]]); vi.clearAllMocks(); });
it('uses neutral nonmodal feedback with accessible actions bound to the captured environment', () => {
  const logs = vi.fn(); render(<GameLaunchStatus onViewLogs={logs} />);
  expect(screen.getByRole('status')).toHaveAttribute('aria-live', 'polite');
  expect(screen.getByText('Schedule I is taking longer to start')).toBeInTheDocument();
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'View Logs' })); expect(logs).toHaveBeenCalledWith('captured');
  fireEvent.click(screen.getByRole('button', { name: 'Dismiss' })); expect(store.dismissNotice).toHaveBeenCalledWith('captured');
});
it.each([
  ['running', 'Schedule I is running; MelonLoader has not been confirmed.'],
  ['notRunning', 'SIMM could not confirm that Schedule I started.'],
  ['unknown', 'SIMM could not inspect whether Schedule I is running. Startup remains unconfirmed.'],
] as const)('qualifies the deadline result for %s and checks again without a launch action', (processState, copy) => {
  store.attempts = new Map([['captured', { ...attempt, state: 'unconfirmed', snapshot: { ...attempt.snapshot!, processState } }]]);
  render(<GameLaunchStatus onViewLogs={vi.fn()} />); expect(screen.getByText(copy)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Check Again' })); expect(store.checkAgain).toHaveBeenCalledWith('captured');
  expect(screen.queryByRole('button', { name: /relaunch/i })).not.toBeInTheDocument();
});
it('describes an early exit neutrally and exposes inspection diagnostics', () => {
  store.attempts = new Map([['captured', { ...attempt, state: 'exited', snapshot: { ...attempt.snapshot!, diagnostic: 'Log access unavailable' } }]]);
  render(<GameLaunchStatus onViewLogs={vi.fn()} />);
  expect(screen.getByText('Schedule I closed before MelonLoader startup was confirmed.')).toBeInTheDocument();
  expect(screen.getByText('Log access unavailable')).toBeInTheDocument();
});
it('clears late confirmation or dismissal without moving keyboard focus', () => {
  const { rerender } = render(<><input aria-label="Focus sentinel" /><GameLaunchStatus onViewLogs={vi.fn()} /></>);
  screen.getByRole('textbox').focus();
  store.attempts = new Map([['captured', { ...attempt, state: 'confirmed' }]]);
  rerender(<><input aria-label="Focus sentinel" /><GameLaunchStatus onViewLogs={vi.fn()} /></>);
  expect(screen.queryByRole('status')).not.toBeInTheDocument(); expect(screen.getByRole('textbox')).toHaveFocus();
  store.attempts = new Map([['captured', { ...attempt, noticeDismissed: true }]]);
  rerender(<><input aria-label="Focus sentinel" /><GameLaunchStatus onViewLogs={vi.fn()} /></>);
  expect(screen.queryByRole('status')).not.toBeInTheDocument();
});
it('retains long environment names and paths in a wrapping themed surface', () => {
  const name = 'Environment '.repeat(50); const path = 'C:/' + 'nested/'.repeat(80) + 'Latest.log';
  store.attempts = new Map([['captured', { ...attempt, environmentName: name, snapshot: { ...attempt.snapshot!, logPath: path } }]]);
  const { container } = render(<GameLaunchStatus onViewLogs={vi.fn()} />);
  expect(screen.getByText(name.trim())).toBeInTheDocument(); expect(screen.getByText(path)).toBeInTheDocument();
  expect(container.querySelector('.game-launch-status')).toBeInTheDocument();
});
