import { lazy, Suspense, useCallback, useEffect, useId, useRef, useState, type CSSProperties } from 'react';
import { ApiService } from '../services/api';
import type { Environment, NativeConsoleMessageOrigin, NativeConsolePreferences, NativeConsoleSnapshot } from '../types';
import { useNativeConsoleViewport } from '../hooks/useNativeConsoleViewport';
import { useNativeConsoleSession } from '../hooks/useNativeConsoleSession';
import { SimmButton } from './primitives';
import { Icon } from './Icon';
import { NativeConsoleMessages } from './NativeConsoleMessages';
import type { LogsFocus } from './LogsOverlay';
import { nativeConsoleOriginCounts, nativeConsoleOriginKey } from '../utils/nativeConsoleMessages';

const statusText: Record<NativeConsoleSnapshot['status'], string> = {
  waitingForGame: 'Waiting for game', waitingForConsole: 'Waiting for console',
  docked: 'Connected', poppedOut: 'Open in its own window', detached: 'Disconnected', exited: 'Game closed', unavailable: 'Unavailable',
};
const EnvironmentLogs = lazy(async () => ({ default: (await import('./LogsOverlay')).LogsOverlay }));

export function ConsolePreferences({ value, disabled, onChange }: {
  value: NativeConsolePreferences;
  disabled?: boolean;
  onChange: (value: NativeConsolePreferences) => void;
}) {
  const options = [
    ['autoOpen', 'Open Console after launch'], ['showGame', 'Game details'],
    ['showProfile', 'Profile details'], ['showMods', 'Mods and plugins'], ['showPaths', 'Game folder'],
  ] as const;
  return <fieldset className="native-console-preferences" disabled={disabled}>
    <legend>View options</legend>
    <p className="native-console-note">Choose sidebar details, width and when this view opens. Saved for this environment.</p>
    {options.map(([key, label]) => <label key={key}>
      <input type="checkbox" checked={value[key]} onChange={(event) => onChange({ ...value, [key]: event.target.checked })} />
      <span>{label}</span>
    </label>)}
    <label className="native-console-preferences__width"><span>Sidebar width</span>
      <select value={value.sidebarWidth} onChange={(event) => onChange({ ...value, sidebarWidth: Number(event.target.value) })}>
        <option value={280}>Compact</option><option value={360}>Standard</option>
        <option value={440}>Wide</option><option value={520}>Extra wide</option>
      </select>
    </label>
  </fieldset>;
}

export function NativeConsoleSettings() {
  return <section className="settings-section">
    <h3>Console · Windows</h3>
    <p>Choose an environment, then open Console → View options to set its sidebar layout and automatic opening after launch. Each environment keeps its own preferences.</p>
  </section>;
}

function formatDate(value: string | number | null | undefined) {
  if (value == null) return 'Unknown';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Unknown' : date.toLocaleString();
}
function uptime(start: number, now: number) {
  const seconds = Math.max(0, Math.floor((now - start) / 1000));
  return `${Math.floor(seconds / 3600).toString().padStart(2, '0')}:${Math.floor(seconds / 60 % 60).toString().padStart(2, '0')}:${(seconds % 60).toString().padStart(2, '0')}`;
}

export function EnvironmentStatus({ environmentId, environment, initialTab = 'console', nativeConsoleSupported = true, embedded = false, onSelectTab, onBack, onOpenModLibraryView }: {
  environmentId: string; environment?: Environment; initialTab?: 'console' | 'logs'; onBack: () => void;
  nativeConsoleSupported?: boolean;
  embedded?: boolean;
  onSelectTab?: (tab: 'console' | 'logs') => void;
  onOpenModLibraryView?: (focus: { storageId: string; modTag: string }) => void;
}) {
  const { snapshot, setSnapshot, ready, refreshing: inventoryRefreshing, refresh: refreshInventory, error: sessionError } = useNativeConsoleSession(environmentId, nativeConsoleSupported);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);
  const [viewportError, setViewportError] = useState<string | null>(null);
  const [closeRequestedAt, setCloseRequestedAt] = useState<number | null>(null);
  const [showLayout, setShowLayout] = useState(false);
  const viewOptions = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (showLayout) {
      viewOptions.current?.scrollIntoView?.({ block: 'start' });
      viewOptions.current?.focus({ preventScroll: true });
    }
  }, [showLayout]);
  const [filter, setFilter] = useState('');
  const [tab, setTab] = useState(nativeConsoleSupported ? initialTab : 'logs');
  const [logsMounted, setLogsMounted] = useState(initialTab === 'logs' || !nativeConsoleSupported);
  const [logsFocus, setLogsFocus] = useState<LogsFocus | null>(null);
  const [logSidebar, setLogSidebar] = useState<HTMLDivElement | null>(null);
  useEffect(() => {
    const requestedTab = nativeConsoleSupported ? initialTab : 'logs';
    setTab(requestedTab);
    if (requestedTab === 'logs') setLogsMounted(true);
  }, [initialTab, nativeConsoleSupported]);
  const statusId = useId();
  const [fallbackEnvironment, setFallbackEnvironment] = useState(environment);
  const focusSequence = useRef(0);
  useEffect(() => {
    if (environment) { setFallbackEnvironment(environment); return; }
    let disposed = false;
    void ApiService.getEnvironment(environmentId).then(value => { if (!disposed) setFallbackEnvironment(value); }).catch(() => {});
    return () => { disposed = true; };
  }, [environment, environmentId]);
  const now = Date.now();
  const pane = useRef<HTMLDivElement>(null);
  const reportError = useCallback((error: unknown) => setError(String(error)), []);
  const reportViewportError = useCallback((error: unknown) => setViewportError(error == null ? null : `Console position: ${String(error)}`), []);
  useNativeConsoleViewport(environmentId, pane, ready && tab === 'console' && snapshot?.presentation !== 'popout', reportViewportError);
  const currentEnvironment = snapshot?.environment ?? environment ?? fallbackEnvironment;
  const selectTab = (value: 'console' | 'logs') => { if (value === 'console' && !nativeConsoleSupported) return; setTab(value); if (value === 'logs') setLogsMounted(true); onSelectTab?.(value); };
  const showLogs = (level: 'error' | 'warning' | 'all', origin?: NativeConsoleMessageOrigin) => {
    const sources = origin ? (snapshot?.messages.sources ?? [])
      .filter(source => source.origin && nativeConsoleOriginKey(source.origin) === nativeConsoleOriginKey(origin))
      .flatMap(source => source.source ? [source.source] : []) : [];
    setLogsFocus({ id: ++focusSequence.current, severity: level === 'error' ? 'ERROR' : level === 'warning' ? 'WARN' : 'ALL',
      source: origin ? { label: `${origin.kind} · ${origin.name}`, tags: sources.length ? sources : [origin.name] } : null });
    selectTab('logs');
  };

  const save = async (preferences: NativeConsolePreferences) => {
    setBusy(true); setError(null);
    try {
      const value = await ApiService.saveNativeConsolePreferences(environmentId, preferences);
      setSnapshot((snapshot) => snapshot ? { ...snapshot, preferences: value } : snapshot);
    } catch (error) { reportError(error); }
    finally { setBusy(false); }
  };
  const retry = async () => {
    setBusy(true); setError(null); setCloseRequestedAt(null);
    try {
      if (ready) await ApiService.retryNativeConsole(environmentId);
      else { refreshInventory(); return; }
      setSnapshot(await ApiService.getNativeConsoleSnapshot(environmentId));
    } catch (error) { reportError(error); }
    finally { setBusy(false); }
  };
  const closeGame = async () => {
    setConfirmClose(false); setBusy(true); setError(null);
    try { await ApiService.closeNativeConsoleGame(environmentId); setCloseRequestedAt(Date.now()); }
    catch (error) { reportError(error); }
    finally { setBusy(false); }
  };
  const popOut = async () => {
    setBusy(true); setError(null);
    try {
      await ApiService.popOutNativeConsole(environmentId);
      setSnapshot(await ApiService.getNativeConsoleSnapshot(environmentId));
    } catch (error) { reportError(error); }
    finally { setBusy(false); }
  };
  const poppedOut = snapshot?.presentation === 'popout';
  const running = !!snapshot?.processId && snapshot.status !== 'exited';
  const preferences = snapshot?.preferences;
  const entries = snapshot?.entries ?? [];
  const messageCounts = nativeConsoleOriginCounts(snapshot?.messages?.sources ?? []);
  const visibleEntries = entries.filter((entry) => [entry.name, entry.author, entry.fileName, entry.version].some((value) => value?.toLowerCase().includes(filter.trim().toLowerCase())));
  const style = { '--console-sidebar-width': `${preferences?.sidebarWidth ?? 360}px` } as CSSProperties;
  const canRetry = nativeConsoleSupported && (!snapshot || ['unavailable', 'detached', 'exited'].includes(snapshot.status));
  return <section className={`environment-status workspace-panel${embedded ? ' environment-status--embedded' : ''}`} style={style} aria-label="Environment status">
    <header className="environment-status-header ui-toolbar">
      {!embedded ? <><SimmButton className="btn btn-secondary" variant="outline" size="sm" onClick={onBack} aria-label="Back"><Icon name="fas fa-arrow-left" /></SimmButton>
      <div className="environment-status-title"><h1>{currentEnvironment?.name ?? 'Loading environment…'}</h1></div></> : null}
      <span className={`environment-status-state ${running ? 'is-running' : ''}`} role="status"><i />{running ? 'Running' : snapshot?.status === 'exited' ? 'Stopped' : 'Waiting'}</span>
      <SimmButton className="btn btn-secondary" variant="outline" size="sm" disabled={!preferences} onClick={() => setShowLayout((visible) => !visible)} aria-expanded={showLayout} aria-controls={`${statusId}-view-options`}
        title={nativeConsoleSupported ? 'Choose sidebar details, width and automatic opening after launch' : 'View options are available on Windows'}><Icon name="fas fa-sliders" />View options</SimmButton>
    </header>
    <div className="native-console-workspace">
      <div className="environment-status-content">
        {!embedded && <div className="environment-status-tabs" role="tablist" aria-label="Environment status views">
          {(['console', 'logs'] as const).map(value => <SimmButton className="environment-status-tab" key={value} id={`${statusId}-${value}-tab`} role="tab" aria-selected={tab === value} aria-controls={`${statusId}-${value}-panel`} tabIndex={tab === value ? 0 : -1} disabled={value === 'console' && !nativeConsoleSupported} title={value === 'console' && !nativeConsoleSupported ? 'Native console is available on Windows' : undefined}
            variant="ghost" onClick={() => selectTab(value)} onKeyDown={event => {
              if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
                event.preventDefault(); const next = event.key === 'Home' ? 'console' : event.key === 'End' ? 'logs' : value === 'console' ? 'logs' : 'console';
                const supportedNext = nativeConsoleSupported ? next : 'logs';
                selectTab(supportedNext); document.getElementById(`${statusId}-${supportedNext}-tab`)?.focus();
              }
            }}>{value === 'console' ? 'Console' : 'Logs'}</SimmButton>)}
        </div>}
      <div className="environment-status-console" id={`${statusId}-console-panel`} role={embedded ? 'region' : 'tabpanel'} aria-label={embedded ? 'MelonLoader console' : undefined} aria-labelledby={embedded ? undefined : `${statusId}-console-tab`} hidden={tab !== 'console'}>
        <header className="native-console-toolbar"><strong>MelonLoader console</strong><div className="native-console-toolbar-actions"><span>{snapshot ? statusText[snapshot.status] : 'Connecting…'}</span>
          {nativeConsoleSupported ? <SimmButton className="btn btn-secondary" variant="outline" size="sm" disabled={busy || (!poppedOut && snapshot?.status !== 'docked')}
            onClick={() => void (poppedOut ? retry() : popOut())} title={poppedOut ? 'Return the native console to this view' : 'Restore the native console window and its window controls'}>
            <Icon name={poppedOut ? 'fas fa-window-restore' : 'fas fa-external-link-alt'} />{poppedOut ? 'Dock in SIMM' : 'Pop out console'}</SimmButton> : null}
        </div></header>
        <div ref={pane} className="native-console-pane" aria-label="Native MelonLoader console">
          {snapshot?.status !== 'docked' || poppedOut ? <div className="native-console-placeholder" role="status"><Icon name="fas fa-terminal" /><strong>{snapshot ? statusText[snapshot.status] : 'Connecting…'}</strong>{poppedOut && running ? <span>Use Dock in SIMM to return the console here.</span> : null}</div> : null}
        </div>
        <div className="native-console-caption">{poppedOut ? 'Native window · Selection, resizing and window controls' : 'Native selection · Esc to clear selection'}</div>
      </div>
      <div className="environment-status-logs" id={`${statusId}-logs-panel`} role={embedded ? 'region' : 'tabpanel'} aria-label={embedded ? 'Logs' : undefined} aria-labelledby={embedded ? undefined : `${statusId}-logs-tab`} hidden={tab !== 'logs'}>
        {logsMounted && currentEnvironment ? <Suspense fallback={<p role="status">Loading logs…</p>}><EnvironmentLogs isOpen={true} active={tab === 'logs'} embedded sidebarTarget={tab === 'logs' ? logSidebar : null}
          onClose={onBack} environmentId={environmentId} environment={currentEnvironment} focus={logsFocus} launchStartedAt={snapshot?.processStartedAt}
          logGeneration={snapshot?.messages.state === 'ready' || snapshot?.messages.state === 'reading' ? snapshot.messages.generation : 0} onOpenModLibraryView={onOpenModLibraryView} /></Suspense> : null}
      </div>
      </div>
      <aside className="native-console-sidebar" aria-label="Environment details">
        <div className="native-console-details" role="region" aria-label="Session details" tabIndex={0}>
          {error || sessionError ? <p role="alert" className="native-console-error">{error || sessionError}</p> : null}
          {viewportError ? <p role="alert" className="native-console-error">{viewportError}</p> : null}
          {snapshot?.diagnostic ? <details className="native-console-diagnostic"><summary>Connection details</summary><p>{snapshot.diagnostic}</p></details> : null}
          {showLayout && preferences ? <div id={`${statusId}-view-options`} ref={viewOptions} tabIndex={-1}><ConsolePreferences value={preferences} disabled={busy} onChange={(value) => void save(value)} /></div> : null}
          {snapshot?.messages ? <NativeConsoleMessages key={environmentId} value={snapshot.messages} onViewLogs={level => showLogs(level)} /> : null}
          <div ref={setLogSidebar} className="environment-status-log-details" hidden={tab !== 'logs'} />
          <section aria-label="Session"><h2>Session</h2><dl>
            <dt>Status</dt><dd>{running ? 'Running' : snapshot?.status === 'exited' ? 'Stopped' : 'Waiting'}</dd>
            <dt>Process ID</dt><dd>{snapshot?.processId ?? '—'}</dd>
            <dt>Started</dt><dd>{snapshot?.processStartedAt ? formatDate(snapshot.processStartedAt) : '—'}</dd>
            <dt>Uptime</dt><dd className="environment-status-time">{running && snapshot?.processStartedAt ? uptime(snapshot.processStartedAt, now) : '—'}</dd>
          </dl></section>
          {(preferences?.showGame ?? true) && currentEnvironment ? <section aria-label="Game details"><h2>Game</h2><dl>
            <dt>Version</dt><dd>{currentEnvironment.currentGameVersion || 'Unknown'}</dd>
            <dt>Branch</dt><dd>{currentEnvironment.branch}</dd>
            <dt>Runtime</dt><dd>{currentEnvironment.runtime}</dd>
            <dt>MelonLoader</dt><dd>{currentEnvironment.melonLoaderVersion || 'Not detected'}</dd>
            <dt>Steam app ID</dt><dd>{currentEnvironment.appId}</dd>
            <dt>Install</dt><dd>{currentEnvironment.environmentType?.toLowerCase() === 'steam' ? 'Steam' : 'Custom'}</dd>
          </dl></section> : null}
          {preferences?.showProfile && snapshot ? <section aria-label="Active profile"><h2>Profile</h2><dl>
            <dt>Name</dt><dd>{snapshot.profileName || 'None applied'}</dd>
            {snapshot.profileRuntime ? <><dt>Runtime</dt><dd>{snapshot.profileRuntime}</dd></> : null}
            {snapshot.profileUpdatedAt ? <><dt>Updated</dt><dd>{formatDate(snapshot.profileUpdatedAt)}</dd></> : null}
          </dl></section> : null}
          {preferences?.showPaths && snapshot ? <section aria-label="Game folder"><h2>Game folder</h2><p className="native-console-path">{snapshot.environment.outputDir}</p></section> : null}
          {preferences?.showMods && snapshot ? <>
            <div className="environment-status-inventory"><label htmlFor="console-mod-filter">Installed inventory</label><input id="console-mod-filter" type="search" placeholder="Filter mods and plugins" value={filter} onChange={(event) => setFilter(event.target.value)} /><small>Updated {formatDate(snapshot.inventoryUpdatedAt)}</small><SimmButton className="btn btn-secondary" variant="outline" size="sm" disabled={busy || inventoryRefreshing} onClick={refreshInventory}>Refresh inventory</SimmButton></div>
            {['Mod', 'Plugin'].map((kind) => {
              const all = entries.filter((entry) => entry.kind === kind);
              const filtered = visibleEntries.filter((entry) => entry.kind === kind);
              return <section key={kind} aria-label={kind === 'Mod' ? 'Installed mods' : 'Installed plugins'}>
                <h2>{kind === 'Mod' ? 'Mods' : 'Plugins'} <small>{all.filter((entry) => entry.enabled).length} enabled / {all.length}</small></h2>
                {filtered.length ? <ul className="native-console-mods">{filtered.map((entry, index) => {
                  const counts = messageCounts.get(nativeConsoleOriginKey(entry)) ?? { errors: 0, warnings: 0 };
                  return <li key={`${entry.fileName ?? entry.name}:${index}`} className={entry.enabled ? '' : 'is-disabled'}>
                  <div className="native-console-mod-title"><strong>{entry.name}</strong><span title={entry.versionSource === 'melonInfo' ? 'MelonInfo version' : entry.versionSource === 'assembly' ? 'Assembly version' : entry.versionSource === 'installMetadata' ? 'Install metadata version' : 'No readable version metadata'}>{entry.version || 'Unknown version'}</span></div>
                  {entry.author ? <span>{entry.author}</span> : null}
                  {entry.fileName ? <span className="native-console-path">{entry.fileName}</span> : null}
                  {!entry.enabled ? <span>Disabled</span> : null}
                  <div className="native-console-entry-counts" aria-label={`${entry.name} messages`}>
                    <SimmButton className="btn btn-secondary" variant="outline" size="sm" disabled={!counts.errors} aria-label={`View errors from ${entry.kind.toLowerCase()} ${entry.name} (${counts.errors})`} onClick={() => showLogs('error', entry)}>Errors <strong>{counts.errors}</strong></SimmButton>
                    <SimmButton className="btn btn-secondary" variant="outline" size="sm" disabled={!counts.warnings} aria-label={`View warnings from ${entry.kind.toLowerCase()} ${entry.name} (${counts.warnings})`} onClick={() => showLogs('warning', entry)}>Warnings <strong>{counts.warnings}</strong></SimmButton>
                  </div>
                </li>; })}</ul> : <p className="native-console-note">{filter ? 'No matches' : 'None installed'}</p>}
              </section>;
            })}
          </> : null}
        </div>
        <footer className="native-console-actions">
          {confirmClose ? <div role="alertdialog" aria-label="Close Schedule I?" aria-describedby="console-close-description">
            <strong>Close Schedule I?</strong><p id="console-close-description">Unsaved progress may be lost.</p>
            <div className="native-console-button-row"><SimmButton className="btn btn-danger" variant="destructive" onClick={() => void closeGame()}>Close game now</SimmButton><SimmButton className="btn btn-secondary" variant="outline" onClick={() => setConfirmClose(false)}>Cancel</SimmButton></div>
          </div> : <>
            {closeRequestedAt && snapshot?.status !== 'exited' ? <p role="status">{now - closeRequestedAt > 10_000 ? 'Game is still running' : 'Closing game…'}</p> : null}
            <div className="native-console-button-row">{canRetry ? <SimmButton className="btn btn-secondary" variant="outline" disabled={busy} onClick={() => void retry()}>Retry connection</SimmButton> : null}
              <SimmButton className="btn btn-danger" variant="destructive" disabled={busy || !running} onClick={() => setConfirmClose(true)}>Close Game</SimmButton></div>
          </>}
        </footer>
      </aside>
    </div>
  </section>;
}
