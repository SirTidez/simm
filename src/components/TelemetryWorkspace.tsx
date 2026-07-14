import { useCallback, useEffect, useMemo, useState } from 'react';
import { ApiService } from '../services/api';
import { onLiveTelemetryEvent, onLiveTelemetryStatus } from '../services/events';
import { useEnvironmentStore } from '../stores/environmentStore';
import type { LiveTelemetryEvent, LiveTelemetryStatus, TelemetryPreferences } from '../types';
import { Icon } from './Icon';
import { SimmButton } from './primitives';
import { WorkspacePageHeader } from './WorkspacePageHeader';

export function TelemetryWorkspace({ onClose }: { onClose: () => void }) {
  const { environments } = useEnvironmentStore();
  const [preferences, setPreferences] = useState<TelemetryPreferences | null>(null);
  const [events, setEvents] = useState<LiveTelemetryEvent[]>([]);
  const [statuses, setStatuses] = useState<LiveTelemetryStatus[]>([]);
  const [environmentId, setEnvironmentId] = useState('');
  const [severity, setSeverity] = useState('all');
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const [nextPreferences, nextStatuses, nextEvents] = await Promise.all([
      ApiService.getTelemetryPreferences(),
      ApiService.getLiveTelemetryStatus(),
      ApiService.listLiveTelemetryEvents(environmentId || null, 500),
    ]);
    setPreferences(nextPreferences);
    setStatuses(nextStatuses);
    setEvents(nextEvents);
  }, [environmentId]);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    let unlistenEvent: (() => void) | undefined;
    let unlistenStatus: (() => void) | undefined;
    void onLiveTelemetryEvent(() => void refresh()).then((unlisten) => { unlistenEvent = unlisten; });
    void onLiveTelemetryStatus(() => void refresh()).then((unlisten) => { unlistenStatus = unlisten; });
    return () => { unlistenEvent?.(); unlistenStatus?.(); };
  }, [refresh]);

  const filteredEvents = useMemo(() => events.filter((event) => severity === 'all' || event.severity === severity), [events, severity]);
  const activeCount = statuses.filter((status) => status.monitoring).length;

  const updatePreferences = async (updates: Partial<TelemetryPreferences>) => {
    setBusy(true);
    try {
      const next = await ApiService.saveTelemetryPreferences(updates);
      setPreferences(next);
      await refresh();
    } finally { setBusy(false); }
  };

  const clearHistory = async () => {
    setBusy(true);
    try {
      await ApiService.clearLiveTelemetryHistory(environmentId || null);
      setFeedback('Local telemetry history cleared.');
      await refresh();
    } finally { setBusy(false); }
  };

  const previewExport = async () => {
    setBusy(true);
    try {
      const exported = await ApiService.exportLiveTelemetryHistory(environmentId || null);
      setFeedback(`Prepared anonymous preview: ${exported.sessions.length} session(s), ${exported.sessions.reduce((total, session) => total + session.events.length, 0)} event(s).`);
    } finally { setBusy(false); }
  };

  return (
    <section className="telemetry-workspace">
      <WorkspacePageHeader eyebrow="Diagnostics" title="Live Telemetry" description="Local, opt-in session diagnostics captured while a registered game installation is running.">
        <div className="telemetry-workspace__header-actions">
          <span className={`telemetry-workspace__status ${activeCount > 0 ? 'telemetry-workspace__status--active' : ''}`}>
            <Icon name={activeCount > 0 ? 'waveSquare' : 'pause'} /> {activeCount > 0 ? `${activeCount} monitoring` : 'Waiting for game'}
          </span>
          <SimmButton variant="ghost" size="icon-sm" onClick={onClose} aria-label="Close telemetry"><Icon name="times" /></SimmButton>
        </div>
      </WorkspacePageHeader>

      <div className="telemetry-workspace__controls">
        <label className="telemetry-workspace__toggle">
          <input type="checkbox" checked={preferences?.collectionEnabled ?? false} disabled={busy} onChange={(event) => void updatePreferences({ collectionEnabled: event.target.checked })} />
          <span>Collect local telemetry</span>
        </label>
        <label className="telemetry-workspace__toggle">
          <input type="checkbox" checked={preferences?.errorExcerptsEnabled ?? false} disabled={busy || !preferences?.collectionEnabled} onChange={(event) => void updatePreferences({ errorExcerptsEnabled: event.target.checked })} />
          <span>Include sanitized readable excerpts</span>
        </label>
        <label>Retention
          <select value={preferences?.retentionDays ?? 30} disabled={busy} onChange={(event) => void updatePreferences({ retentionDays: Number(event.target.value) })}>
            <option value={7}>7 days</option><option value={14}>14 days</option><option value={30}>30 days</option><option value={90}>90 days</option>
          </select>
        </label>
        <label>Window close
          <select value={preferences?.closeBehavior ?? 'ask'} disabled={busy} onChange={(event) => void updatePreferences({ closeBehavior: event.target.value as 'ask' | 'tray' | 'quit' })}>
            <option value="ask">Ask every time</option><option value="tray">Hide to tray</option><option value="quit">Quit SIMM</option>
          </select>
        </label>
      </div>

      <div className="telemetry-workspace__filters">
        <select value={environmentId} onChange={(event) => setEnvironmentId(event.target.value)} aria-label="Telemetry environment">
          <option value="">All environments</option>
          {environments.map((environment) => <option key={environment.id} value={environment.id}>{environment.name}</option>)}
        </select>
        <select value={severity} onChange={(event) => setSeverity(event.target.value)} aria-label="Telemetry severity">
          <option value="all">All severities</option><option value="WARN">Warnings</option><option value="ERROR">Errors</option><option value="FATAL">Fatal</option>
        </select>
        <div className="telemetry-workspace__spacer" />
        <SimmButton className="btn btn-secondary btn-small" disabled={busy} onClick={() => void previewExport()}><Icon name="copy" /> Preview export</SimmButton>
        <SimmButton className="btn btn-secondary btn-small" disabled={busy} onClick={() => void clearHistory()}><Icon name="trash" /> Clear history</SimmButton>
      </div>
      {feedback && <p className="telemetry-workspace__feedback" role="status">{feedback}</p>}

      <div className="telemetry-workspace__sessions">
        {statuses.length === 0 ? <p>No telemetry sessions have been recorded yet.</p> : statuses.map((status) => {
          const environment = environments.find((entry) => entry.id === status.environmentId);
          return <div key={status.environmentId} className="telemetry-session-row">
            <div><strong>{environment?.name ?? status.environmentId}</strong><span>{status.monitoring ? 'Monitoring Latest.log' : 'Not running'}</span></div>
            <span>{status.eventCount} events</span><span>{status.lastEventAt ?? 'No events'}</span>
          </div>;
        })}
      </div>

      <div className="telemetry-workspace__event-list" aria-live="polite">
        {filteredEvents.length === 0 ? <p>No matching warnings or errors in local history.</p> : filteredEvents.map((event) => (
          <article key={event.eventId} className={`telemetry-event telemetry-event--${event.severity.toLowerCase()}`}>
            <div className="telemetry-event__meta"><strong>{event.severity}</strong><span>{event.modName ?? event.attribution}</span><span>{event.occurredAt}</span></div>
            <code>{event.fingerprint}</code>
            {event.message && <pre>{event.message}</pre>}
          </article>
        ))}
      </div>
    </section>
  );
}
