import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GameLaunchCoordinator } from './gameLaunchStore';
import type { ApiService } from '../services/api';
import type { Environment, GameLaunchInspection } from '../types';

const environment: Environment = { id: 'one', name: 'Original environment', outputDir: 'C:/one', appId: '3164500', branch: 'main', runtime: 'Mono', status: 'completed' };
const snapshot = (processState: GameLaunchInspection['processState'] = 'notRunning', loaderState: GameLaunchInspection['loaderState'] = 'noLog'): GameLaunchInspection => ({ environmentId: 'one', launchStartedAt: 1234, processState, loaderState, logPath: 'C:/one/MelonLoader/Latest.log', modifiedAt: null, diagnostic: null });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }
let coordinator: GameLaunchCoordinator;
const makeApi = () => ({ launchGame: vi.fn<typeof ApiService.launchGame>().mockResolvedValue({ success: true, launchStartedAt: 1234 }), inspectGameLaunch: vi.fn<typeof ApiService.inspectGameLaunch>().mockResolvedValue(snapshot()), confirm: vi.fn<(...args: unknown[]) => Promise<boolean>>().mockResolvedValue(false), message: vi.fn<(...args: unknown[]) => Promise<void>>().mockResolvedValue(undefined), log: vi.fn<(message: string, data: unknown) => void>() });
let api: ReturnType<typeof makeApi>;
const state = () => coordinator.getSnapshot().get('one');
const flush = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(100_000); api = makeApi(); coordinator = new GameLaunchCoordinator(api); coordinator.setEnvironments([environment]); });
afterEach(() => { coordinator.dispose(); vi.useRealTimers(); });

describe('shared process-aware launch observation', () => {
  it('deduplicates shell/card requests, goes slow at 20 seconds and recovers at 22 without relaunch', async () => {
    await Promise.all([coordinator.requestLaunch(environment, 'steam'), coordinator.requestLaunch(environment, 'steam')]);
    await flush();
    expect(api.launchGame).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(state()?.state).toBe('slow');
    expect(api.message).not.toHaveBeenCalled();
    api.inspectGameLaunch.mockResolvedValue(snapshot('running', 'confirmed'));
    await vi.advanceTimersByTimeAsync(2_000);
    expect(state()?.state).toBe('confirmed');
    expect(api.launchGame).toHaveBeenCalledTimes(1);
    expect(api.inspectGameLaunch).toHaveBeenLastCalledWith('one', 1234);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not overlap a slow snapshot and starts its budget after accepted dispatch', async () => {
    const dispatch = deferred<{ success: boolean; launchStartedAt: number }>(); api.launchGame.mockReturnValue(dispatch.promise);
    const request = coordinator.requestLaunch(environment, 'steam');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(state()?.state).toBe('dispatching');
    dispatch.resolve({ success: true, launchStartedAt: 1234 }); await request;
    const inspection = deferred<GameLaunchInspection>(); api.inspectGameLaunch.mockReturnValue(inspection.promise);
    await vi.advanceTimersByTimeAsync(2_000);
    const calls = api.inspectGameLaunch.mock.calls.length;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(api.inspectGameLaunch).toHaveBeenCalledTimes(calls);
    inspection.resolve(snapshot()); await flush();
    expect(state()?.state).toBe('checking');
  });

  it.each(['running', 'notRunning', 'unknown'] as const)('ends bounded observation neutrally for %s and ignores responses after expiry', async (process) => {
    api.inspectGameLaunch.mockResolvedValue(snapshot(process));
    await coordinator.requestLaunch(environment, 'steam');
    await vi.advanceTimersByTimeAsync(120_000);
    expect(state()?.state).toBe('unconfirmed');
    expect(state()?.snapshot?.processState).toBe(process);
    expect(vi.getTimerCount()).toBe(0);
    expect(api.message).not.toHaveBeenCalled();
  });

  it('requires the intended process even with a fresh marker and rejects stale logs', async () => {
    api.inspectGameLaunch.mockResolvedValue(snapshot('notRunning', 'confirmed'));
    await coordinator.requestLaunch(environment, 'steam'); await flush();
    expect(state()?.state).toBe('checking');
    api.inspectGameLaunch.mockResolvedValue(snapshot('running', 'staleLog'));
    await vi.advanceTimersByTimeAsync(2_000);
    expect(state()?.state).toBe('checking');
    api.inspectGameLaunch.mockResolvedValue(snapshot('unknown', 'confirmed'));
    await vi.advanceTimersByTimeAsync(2_000);
    expect(state()?.state).not.toBe('confirmed');
  });

  it('confirms a matching process without loader warnings when MelonLoader is absent', async () => {
    api.inspectGameLaunch.mockResolvedValue(snapshot('running', 'notInstalled'));
    await coordinator.requestLaunch(environment, 'steam'); await flush();
    expect(state()?.state).toBe('confirmed'); expect(api.message).not.toHaveBeenCalled();
  });

  it('requires two consecutive absences after a process observation, without inferring a crash', async () => {
    api.inspectGameLaunch.mockResolvedValue(snapshot('running'));
    await coordinator.requestLaunch(environment, 'steam'); await flush();
    api.inspectGameLaunch.mockResolvedValue(snapshot()); await vi.advanceTimersByTimeAsync(2_000);
    expect(state()?.state).toBe('checking');
    await vi.advanceTimersByTimeAsync(2_000);
    expect(state()?.state).toBe('exited'); expect(api.message).not.toHaveBeenCalled();
  });

  it('dismisses presentation while continuing observation, and check again never dispatches', async () => {
    await coordinator.requestLaunch(environment, 'steam'); await vi.advanceTimersByTimeAsync(20_000);
    coordinator.dismissNotice('one'); expect(state()?.noticeDismissed).toBe(true);
    await vi.advanceTimersByTimeAsync(100_000);
    coordinator.checkAgain('one'); await flush();
    expect(state()?.state).toBe('checking'); expect(state()?.noticeDismissed).toBe(false);
    expect(api.launchGame).toHaveBeenCalledTimes(1);
    expect(api.inspectGameLaunch).toHaveBeenLastCalledWith('one', 1234);
  });

  it.each(['remove', 'path', 'unmount'] as const)('discards in-flight results and timers on %s', async (change) => {
    const result = deferred<GameLaunchInspection>(); api.inspectGameLaunch.mockReturnValue(result.promise);
    await coordinator.requestLaunch(environment, 'steam');
    if (change === 'unmount') coordinator.dispose(); else coordinator.setEnvironments(change === 'remove' ? [] : [{ ...environment, outputDir: 'C:/changed' }]);
    result.resolve(snapshot('running', 'confirmed')); await flush();
    expect(coordinator.getSnapshot().size).toBe(0); expect(vi.getTimerCount()).toBe(0);
  });

  it('captures environment identity and keeps inspection/log errors qualified', async () => {
    api.inspectGameLaunch.mockRejectedValue(new Error('inspection denied'));
    await coordinator.requestLaunch(environment, 'steam'); await flush();
    coordinator.setEnvironments([{ ...environment, name: 'Renamed' }]);
    expect(state()?.environmentName).toBe('Original environment');
    expect(state()?.snapshot?.processState).toBe('unknown');
    expect(state()?.snapshot?.diagnostic).toContain('inspection denied');
    await vi.advanceTimersByTimeAsync(120_000); expect(state()?.state).toBe('unconfirmed');
  });

  it('rechecks a later explicit launch and blocks another dispatch while running or unknown', async () => {
    await coordinator.requestLaunch(environment, 'steam'); await vi.advanceTimersByTimeAsync(120_000);
    api.inspectGameLaunch.mockResolvedValue(snapshot('unknown'));
    await coordinator.requestLaunch(environment, 'steam');
    expect(api.launchGame).toHaveBeenCalledTimes(1); expect(state()?.state).toBe('unconfirmed');
    api.inspectGameLaunch.mockResolvedValue(snapshot());
    await coordinator.requestLaunch(environment, 'steam');
    expect(api.launchGame).toHaveBeenCalledTimes(2);
  });

  it('keeps restart approval explicit and deduplicates while waiting for that decision', async () => {
    api.launchGame.mockRejectedValueOnce(new Error("Steam needs to reload SIMM's shortcut"));
    const decision = deferred<boolean>(); api.confirm.mockReturnValue(decision.promise);
    const request = coordinator.requestLaunch(environment, 'steam'); await flush();
    await coordinator.requestLaunch(environment, 'steam');
    expect(api.launchGame).toHaveBeenCalledTimes(1);
    decision.resolve(true); await request;
    expect(api.launchGame).toHaveBeenNthCalledWith(2, 'one', 'steam_restart');
    expect(api.confirm).toHaveBeenCalledTimes(1);
  });

  it('shows a themed actual dispatch failure but does not start observation', async () => {
    api.launchGame.mockRejectedValue(new Error('dispatch rejected'));
    await coordinator.requestLaunch(environment, 'steam');
    expect(state()?.state).toBe('failed'); expect(api.message).toHaveBeenCalled();
    expect(api.inspectGameLaunch).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });
  it('ignores an in-flight success after the observation deadline', async () => {
    const inspection = deferred<GameLaunchInspection>(); api.inspectGameLaunch.mockReturnValue(inspection.promise);
    await coordinator.requestLaunch(environment, 'steam');
    await vi.advanceTimersByTimeAsync(120_000);
    inspection.resolve(snapshot('running', 'confirmed')); await flush();
    expect(state()?.state).toBe('unconfirmed'); expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps the original timestamp and serializes check-again with an in-flight request', async () => {
    const inspection = deferred<GameLaunchInspection>(); api.inspectGameLaunch.mockReturnValueOnce(inspection.promise);
    await coordinator.requestLaunch(environment, 'steam');
    coordinator.checkAgain('one'); expect(api.inspectGameLaunch).toHaveBeenCalledTimes(1);
    inspection.resolve(snapshot('running', 'confirmed')); await flush();
    expect(state()?.state).toBe('checking');
    await vi.advanceTimersByTimeAsync(2_000);
    expect(api.inspectGameLaunch).toHaveBeenLastCalledWith('one', 1234);
    expect(api.launchGame).toHaveBeenCalledTimes(1);
  });

  it('does not interpret unknown process inspection as a second absence', async () => {
    api.inspectGameLaunch.mockResolvedValue(snapshot('running'));
    await coordinator.requestLaunch(environment, 'steam'); await flush();
    api.inspectGameLaunch.mockResolvedValue(snapshot()); await vi.advanceTimersByTimeAsync(2_000);
    api.inspectGameLaunch.mockResolvedValue(snapshot('unknown')); await vi.advanceTimersByTimeAsync(2_000);
    api.inspectGameLaunch.mockResolvedValue(snapshot()); await vi.advanceTimersByTimeAsync(2_000);
    expect(state()?.state).toBe('checking');
  });

  it('cancels a pending restart decision when the environment path changes', async () => {
    api.launchGame.mockRejectedValueOnce(new Error("Steam needs to reload SIMM's shortcut"));
    const decision = deferred<boolean>(); api.confirm.mockReturnValue(decision.promise);
    const request = coordinator.requestLaunch(environment, 'steam'); await flush();
    coordinator.setEnvironments([{ ...environment, outputDir: 'C:/changed' }]);
    decision.resolve(true); await request;
    expect(api.launchGame).toHaveBeenCalledTimes(1); expect(state()).toBeUndefined();
  });

});
