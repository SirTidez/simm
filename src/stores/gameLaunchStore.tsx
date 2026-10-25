import { createContext, type ReactNode, useContext, useLayoutEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { ApiService } from '../services/api';
import { logger } from '../services/logger';
import { getErrorMessage, isSteamShortcutReloadError } from '../utils/errors';
import { useAppDialogs } from '../components/AppDialogProvider';
import { useEnvironmentStore } from './environmentStore';
import type { Environment, GameLaunchInspection } from '../types';

export type LaunchMethod = 'steam' | 'steam_restart' | 'direct';
export type LaunchState = 'dispatching' | 'checking' | 'slow' | 'confirmed' | 'unconfirmed' | 'exited' | 'failed';
export interface GameLaunchAttempt {
  attemptId: number;
  environmentId: string;
  environmentName: string;
  outputDir: string;
  method: LaunchMethod;
  launchStartedAt: number | null;
  windowStartedAt: number | null;
  state: LaunchState;
  snapshot: GameLaunchInspection | null;
  noticeDismissed: boolean;
  detail?: string;
}
interface Control {
  attempt: GameLaunchAttempt;
  generation: number;
  inFlight: boolean;
  stopped: boolean;
  observedProcess: boolean;
  absentCount: number;
  timers: Set<ReturnType<typeof setTimeout>>;
}
type Dependencies = Pick<typeof ApiService, 'launchGame' | 'inspectGameLaunch'> & ReturnType<typeof useAppDialogs> & { log: (message: string, data: unknown) => void };
export const isLaunchPending = (attempt?: GameLaunchAttempt) => !!attempt && ['dispatching', 'checking', 'slow'].includes(attempt.state);

// One owner for shell/card requests; observation does not depend on telemetry or workspace lifetime.
export class GameLaunchCoordinator {
  private snapshot: ReadonlyMap<string, GameLaunchAttempt> = new Map();
  private controls = new Map<string, Control>();
  private environments = new Map<string, string>();
  private listeners = new Set<() => void>();
  private nextId = 1;
  private disposed = false;
  constructor(private readonly dependencies: Dependencies) {}
  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  activate() { this.disposed = false; }
  setEnvironments(environments: readonly Environment[]) {
    this.environments = new Map(environments.map((environment) => [environment.id, environment.outputDir]));
    for (const [id, control] of this.controls) {
      if (this.environments.get(id) !== control.attempt.outputDir) this.remove(control);
    }
  }
  dispose() {
    this.disposed = true;
    for (const control of this.controls.values()) this.stop(control);
    this.controls.clear(); this.snapshot = new Map(); this.listeners.clear();
  }
  private current(control: Control) {
    return !this.disposed && this.controls.get(control.attempt.environmentId) === control && this.environments.get(control.attempt.environmentId) === control.attempt.outputDir;
  }
  private publish(control: Control, patch: Partial<GameLaunchAttempt>) {
    if (!this.current(control)) return;
    const previous = control.attempt;
    control.attempt = { ...previous, ...patch };
    const next = control.attempt;
    if (previous.state !== next.state || previous.snapshot?.processState !== next.snapshot?.processState || previous.snapshot?.loaderState !== next.snapshot?.loaderState) {
      this.dependencies.log('Game launch observation', {
        attemptId: next.attemptId, environmentId: next.environmentId, method: next.method, state: next.state,
        elapsedMs: next.windowStartedAt === null ? 0 : Date.now() - next.windowStartedAt,
        processState: next.snapshot?.processState, loaderState: next.snapshot?.loaderState, modifiedAt: next.snapshot?.modifiedAt,
      });
    }
    this.snapshot = new Map(this.snapshot).set(next.environmentId, next);
    this.listeners.forEach((listener) => listener());
  }
  private stop(control: Control) {
    control.stopped = true; control.generation++;
    control.timers.forEach(clearTimeout); control.timers.clear();
  }
  private remove(control: Control) {
    this.stop(control); this.controls.delete(control.attempt.environmentId);
    const next = new Map(this.snapshot); next.delete(control.attempt.environmentId); this.snapshot = next;
    this.listeners.forEach((listener) => listener());
  }
  private timer(control: Control, milliseconds: number, callback: () => void) {
    const timer = setTimeout(() => { control.timers.delete(timer); if (this.current(control) && !control.stopped) callback(); }, milliseconds);
    control.timers.add(timer);
  }
  private unknown(control: Control, error: unknown): GameLaunchInspection {
    return { environmentId: control.attempt.environmentId, launchStartedAt: control.attempt.launchStartedAt!, processState: 'unknown', loaderState: 'unavailable', logPath: control.attempt.snapshot?.logPath ?? '', modifiedAt: null, diagnostic: getErrorMessage(error, 'Launch inspection is unavailable.') };
  }
  private async inspect(control: Control): Promise<GameLaunchInspection> {
    try {
      const result = await this.dependencies.inspectGameLaunch(control.attempt.environmentId, control.attempt.launchStartedAt!);
      if (result.environmentId !== control.attempt.environmentId || result.launchStartedAt !== control.attempt.launchStartedAt) throw new Error('Launch inspection belongs to another attempt.');
      return result;
    } catch (error) { return this.unknown(control, error); }
  }
  requestLaunch = async (environment: Environment, method: LaunchMethod): Promise<void> => {
    if (this.disposed || this.environments.get(environment.id) !== environment.outputDir) return;
    const previous = this.controls.get(environment.id);
    if (previous && isLaunchPending(previous.attempt)) return;
    const control: Control = { attempt: { attemptId: this.nextId++, environmentId: environment.id, environmentName: environment.name, outputDir: environment.outputDir, method, launchStartedAt: null, windowStartedAt: null, state: 'dispatching', snapshot: null, noticeDismissed: false }, generation: 0, inFlight: false, stopped: false, observedProcess: false, absentCount: 0, timers: new Set() };
    if (previous) this.stop(previous);
    this.controls.set(environment.id, control); this.publish(control, {}); // Reserve synchronously before the first await.
    if (previous?.attempt.launchStartedAt != null) {
      control.attempt.launchStartedAt = previous.attempt.launchStartedAt;
      const observation = await this.inspect(control);
      if (!this.current(control)) return;
      if (observation.processState !== 'notRunning') {
        this.publish(control, { state: 'unconfirmed', snapshot: observation, detail: observation.processState === 'running' ? 'Schedule I is already running for this environment. No additional launch request was sent.' : 'SIMM could not check whether Schedule I is still running. No additional launch request was sent.' });
        this.stop(control); return;
      }
    }
    try {
      let result;
      try { result = await this.dependencies.launchGame(environment.id, method); }
      catch (error) {
        if (!this.current(control)) return;
        const text = getErrorMessage(error, 'Failed to launch this environment.');
        if (method !== 'steam' || !isSteamShortcutReloadError(text)) throw error;
        const approved = await this.dependencies.confirm(`${text}\n\nRestart Steam now and retry the launch?`, { title: `Restart Steam: ${environment.name}`, kind: 'warning', okLabel: 'Restart Steam' });
        if (!this.current(control)) return;
        if (!approved) { this.remove(control); return; }
        this.publish(control, { method: 'steam_restart' });
        result = await this.dependencies.launchGame(environment.id, 'steam_restart');
      }
      if (!this.current(control)) return;
      if (!result.success) throw new Error('Launch request was not accepted.');
      this.publish(control, { launchStartedAt: result.launchStartedAt ?? Date.now() });
      this.observe(control);
    } catch (error) {
      if (!this.current(control)) return;
      const text = getErrorMessage(error, 'Failed to launch this environment.');
      this.publish(control, { state: 'failed', detail: text }); this.stop(control);
      await this.dependencies.message(text, { title: `Launch Failed: ${environment.name}`, kind: 'error' });
    }
  };
  private observe(control: Control) {
    this.stop(control); control.stopped = false; control.absentCount = 0;
    this.publish(control, { state: 'checking', windowStartedAt: Date.now(), noticeDismissed: false, detail: undefined });
    this.timer(control, 20_000, () => { this.publish(control, { state: 'slow' }); });
    this.timer(control, 120_000, () => { this.publish(control, { state: 'unconfirmed' }); this.stop(control); });
    if (!control.inFlight) void this.poll(control);
  }
  private async poll(control: Control) {
    if (!this.current(control) || control.stopped || control.inFlight) return;
    const generation = control.generation;
    const startedAt = Date.now(); control.inFlight = true;
    try {
      const observation = await this.inspect(control);
      if (!this.current(control) || control.stopped || control.generation !== generation) return;
      let state: LaunchState = Date.now() - control.attempt.windowStartedAt! >= 20_000 ? 'slow' : 'checking';
      if (observation.processState === 'running') { control.observedProcess = true; control.absentCount = 0; }
      else if (observation.processState === 'notRunning' && control.observedProcess) control.absentCount++;
      else control.absentCount = 0;
      if (observation.processState === 'running' && ['confirmed', 'notInstalled'].includes(observation.loaderState)) state = 'confirmed';
      else if (control.absentCount >= 2) state = 'exited';
      this.publish(control, { snapshot: observation, state });
      if (state === 'confirmed' || state === 'exited') this.stop(control);
    } finally {
      control.inFlight = false;
      if (this.current(control) && !control.stopped) this.timer(control, Math.max(0, 2_000 - (Date.now() - startedAt)), () => { void this.poll(control); });
    }
  }
  checkAgain = (environmentId: string) => {
    const control = this.controls.get(environmentId);
    if (!control || !this.current(control) || control.attempt.launchStartedAt == null || control.attempt.state === 'dispatching') return;
    this.observe(control);
  };
  dismissNotice = (environmentId: string) => { const control = this.controls.get(environmentId); if (control) this.publish(control, { noticeDismissed: true }); };
}

interface GameLaunchStore {
  attempts: ReadonlyMap<string, GameLaunchAttempt>;
  requestLaunch: GameLaunchCoordinator['requestLaunch'];
  checkAgain: GameLaunchCoordinator['checkAgain'];
  dismissNotice: GameLaunchCoordinator['dismissNotice'];
}
const GameLaunchContext = createContext<GameLaunchStore | null>(null);
export function GameLaunchStoreProvider({ children }: { children: ReactNode }) {
  const { environments } = useEnvironmentStore();
  const dialogs = useAppDialogs();
  const [coordinator] = useState(() => new GameLaunchCoordinator({ launchGame: (...args) => ApiService.launchGame(...args), inspectGameLaunch: (...args) => ApiService.inspectGameLaunch(...args), ...dialogs, log: (message, data) => logger.info(message, data) }));
  const attempts = useSyncExternalStore(coordinator.subscribe, coordinator.getSnapshot, coordinator.getSnapshot);
  useLayoutEffect(() => { coordinator.activate(); return () => coordinator.dispose(); }, [coordinator]);
  useLayoutEffect(() => { coordinator.setEnvironments(environments); }, [coordinator, environments]);
  const value = useMemo(() => ({ attempts, requestLaunch: coordinator.requestLaunch, checkAgain: coordinator.checkAgain, dismissNotice: coordinator.dismissNotice }), [attempts, coordinator]);
  return <GameLaunchContext.Provider value={value}>{children}</GameLaunchContext.Provider>;
}
export function useGameLaunchStore() {
  const context = useContext(GameLaunchContext);
  if (!context) throw new Error('useGameLaunchStore requires GameLaunchStoreProvider');
  return context;
}
