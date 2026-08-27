import { useCallback, useEffect, useMemo, useState } from 'react';
import { Dialog, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { ApiService } from '../services/api';
import { onLiveTelemetryEvent, onLiveTelemetryStatus } from '../services/events';
import { useEnvironmentStore } from '../stores/environmentStore';
import type { LiveTelemetryEvent, LiveTelemetryExport, LiveTelemetryStatus, TelemetryCapability, TelemetryModCaptureMode, TelemetryModPolicyItem, TelemetryPreferences, TelemetryUploadPreview, TelemetryUploadReceipt } from '../types';
import { ConfirmOverlay } from './ConfirmOverlay';
import { Icon } from './Icon';
import { SimmButton, SimmDialogContent } from './primitives';
import { WorkspacePageHeader } from './WorkspacePageHeader';

export function TelemetryWorkspace({ onClose }: { onClose: () => void }) {
  const { environments } = useEnvironmentStore();
  const [preferences, setPreferences] = useState<TelemetryPreferences | null>(null);
  const [capability, setCapability] = useState<TelemetryCapability | null>(null);
  const [events, setEvents] = useState<LiveTelemetryEvent[]>([]);
  const [statuses, setStatuses] = useState<LiveTelemetryStatus[]>([]);
  const [uploads, setUploads] = useState<TelemetryUploadReceipt[]>([]);
  const [captureHistory, setCaptureHistory] = useState<LiveTelemetryExport | null>(null);
  const [environmentId, setEnvironmentId] = useState('');
  const [severity, setSeverity] = useState('all');
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [feedbackTone, setFeedbackTone] = useState<'status' | 'error'>('status');
  const [exportPreview, setExportPreview] = useState<TelemetryUploadPreview | null>(null);
  const [clearConfirmationOpen, setClearConfirmationOpen] = useState(false);
  const [modPolicyOpen, setModPolicyOpen] = useState(false);
  const [modPolicies, setModPolicies] = useState<TelemetryModPolicyItem[]>([]);
  const [modRuleScopes, setModRuleScopes] = useState<Record<string, 'environment' | 'global'>>({});

  const refresh = useCallback(async () => {
    try {
      const nextCapability = await ApiService.getTelemetryCapability();
      setCapability(nextCapability);
      if (!nextCapability.available) {
        setFeedback('Telemetry is not available in this SIMM package.');
        setFeedbackTone('error');
        return;
      }
      const [nextPreferences, nextStatuses, nextEvents, nextUploads, nextCaptureHistory] = await Promise.all([
        ApiService.getTelemetryPreferences(),
        ApiService.getLiveTelemetryStatus(),
        ApiService.listLiveTelemetryEvents(environmentId || null, 500),
        ApiService.listTelemetryUploads(),
        ApiService.exportLiveTelemetryHistory(environmentId || null),
      ]);
      setPreferences(nextPreferences);
      setStatuses(nextStatuses);
      setEvents(nextEvents);
      setUploads(nextUploads);
      setCaptureHistory(nextCaptureHistory);
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : 'Failed to refresh local telemetry. Retry when SIMM is ready.');
      setFeedbackTone('error');
    }
  }, [environmentId]);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    let disposed = false;
    let unlistenEvent: (() => void) | undefined;
    let unlistenStatus: (() => void) | undefined;
    void onLiveTelemetryEvent(() => void refresh()).then((unlisten) => {
      if (disposed) unlisten(); else unlistenEvent = unlisten;
    }).catch((error) => reportActionError(error, 'Failed to listen for telemetry events.'));
    void onLiveTelemetryStatus(() => void refresh()).then((unlisten) => {
      if (disposed) unlisten(); else unlistenStatus = unlisten;
    }).catch((error) => reportActionError(error, 'Failed to listen for telemetry status updates.'));
    return () => { disposed = true; unlistenEvent?.(); unlistenStatus?.(); };
  }, [refresh]);

  const filteredEvents = useMemo(
    () => events.filter((event) => severity === 'all' || event.severity === severity),
    [events, severity],
  );
  const activeCount = statuses.filter((status) => status.monitoring).length;
  const capturedSessionCount = captureHistory?.sessions.length ?? 0;
  const capturedModCount = captureHistory?.sessions.reduce((count, session) => count + session.mods.length, 0) ?? 0;
  const collectionEnabled = preferences?.collectionEnabled ?? false;
  const uploadEnabled = preferences?.uploadEnabled ?? false;
  const telemetryAvailable = capability?.available ?? false;
  const failedUpload = uploads.find((upload) => upload.state === 'failed');
  const queuedUploadCount = uploads.filter((upload) => upload.state === 'pending' || upload.state === 'failed').length;
  const latestUpload = uploads[0];
  const syncLabel = !collectionEnabled
    ? 'Collection off'
    : !uploadEnabled
      ? 'Local only'
      : failedUpload
        ? 'Queued retry pending'
        : queuedUploadCount > 0
          ? `${queuedUploadCount} queued for update check`
        : latestUpload?.state === 'accepted'
          ? 'Last update-check sync accepted'
          : 'Queued for update check';

  const reportActionError = (error: unknown, fallback: string) => {
    setFeedback(error instanceof Error ? error.message : fallback);
    setFeedbackTone('error');
  };

  const updatePreferences = async (updates: Partial<TelemetryPreferences>) => {
    setBusy(true);
    try {
      const next = await ApiService.saveTelemetryPreferences(updates);
      setPreferences(next);
      await refresh();
    } catch (error) {
      reportActionError(error, 'Failed to update telemetry consent.');
    } finally { setBusy(false); }
  };

  const clearHistory = async () => {
    setBusy(true);
    try {
      await ApiService.clearLiveTelemetryHistory(environmentId || null);
      setFeedback('Local telemetry history cleared. Future sessions remain unaffected.');
      setFeedbackTone('status');
      await refresh();
    } catch (error) {
      reportActionError(error, 'Failed to clear local telemetry history.');
    } finally { setBusy(false); }
  };

  const viewExport = async () => {
    setBusy(true);
    try {
      const preview = await ApiService.previewTelemetryUpload(environmentId || null);
      setExportPreview(preview);
    } catch (error) {
      reportActionError(error, 'Failed to prepare the telemetry export preview.');
    } finally { setBusy(false); }
  };

  const openModPolicyManager = async () => {
    if (!environmentId) {
      setFeedback('Choose an environment before managing its mod telemetry rules.');
      return;
    }
    setBusy(true);
    try {
      const policies = await ApiService.listTelemetryModPolicies(environmentId);
      setModPolicies(policies);
      setModPolicyOpen(true);
    } catch (error) {
      reportActionError(error, 'Failed to load mod telemetry rules.');
    } finally { setBusy(false); }
  };

  const ruleScopeFor = (policy: TelemetryModPolicyItem): 'environment' | 'global' => (
    modRuleScopes[policy.modEntry.modKey]
      ?? (policy.environmentOverride ? 'environment' : 'global')
  );

  const saveModPolicy = async (policy: TelemetryModPolicyItem, value: 'automatic' | TelemetryModCaptureMode) => {
    const scope = ruleScopeFor(policy);
    setBusy(true);
    try {
      await ApiService.saveTelemetryModRule({
        modKey: policy.modEntry.modKey,
        environmentId: scope === 'environment' ? environmentId : null,
        mode: value === 'automatic' ? null : value,
      });
      const policies = await ApiService.listTelemetryModPolicies(environmentId);
      setModPolicies(policies);
      await refresh();
    } catch (error) {
      reportActionError(error, 'Failed to save the mod telemetry rule.');
    } finally { setBusy(false); }
  };

  const uploadQueuedTelemetryForTesting = async () => {
    setBusy(true);
    try {
      const receipts = await ApiService.flushQueuedTelemetryUploads();
      const accepted = receipts.filter((receipt) => receipt.state === 'accepted').length;
      const failed = receipts.filter((receipt) => receipt.state === 'failed').length;
      setFeedback(failed > 0
        ? `${accepted} queued upload${accepted === 1 ? '' : 's'} accepted; ${failed} still need${failed === 1 ? 's' : ''} an update-check retry.`
        : receipts.length > 0
          ? `${accepted} queued upload${accepted === 1 ? '' : 's'} accepted.`
          : 'There is no queued telemetry to upload.');
      setFeedbackTone(failed > 0 ? 'error' : 'status');
      await refresh();
    } catch (error) {
      reportActionError(error, 'Failed to retry queued telemetry uploads.');
    } finally { setBusy(false); }
  };

  const retryFailedUpload = async () => {
    if (!failedUpload) return;
    setBusy(true);
    try {
      const receipt = await ApiService.retryTelemetryUpload(failedUpload.id);
      setFeedback(receipt.state === 'accepted' ? 'Telemetry upload accepted.' : 'Telemetry upload remains queued for retry.');
      setFeedbackTone(receipt.state === 'accepted' ? 'status' : 'error');
      await refresh();
    } catch (error) {
      reportActionError(error, 'Failed to retry the telemetry upload.');
    } finally { setBusy(false); }
  };

  return (
    <section className="telemetry-workspace modal-content workspace-panel">
      <WorkspacePageHeader
        eyebrow="Diagnostics"
        title="Local telemetry"
        description="Review captured warnings and errors. Completed sessions queue locally and sync with update checks."
      >
        <div className="telemetry-workspace__header-actions">
          <span className={`telemetry-workspace__status ${activeCount > 0 ? 'telemetry-workspace__status--active' : ''}`}>
            <Icon name={activeCount > 0 ? 'waveSquare' : 'pause'} /> {activeCount > 0 ? `${activeCount} monitoring` : 'Waiting for game'}
          </span>
          <SimmButton variant="ghost" size="icon-sm" onClick={onClose} aria-label="Close telemetry"><Icon name="times" /></SimmButton>
        </div>
      </WorkspacePageHeader>

      <section className="telemetry-workspace__preferences" aria-label="Telemetry controls">
        <div className="telemetry-preference-group">
          <span className="telemetry-preference-group__label">Collection</span>
          <label className="telemetry-workspace__toggle">
            <input type="checkbox" checked={collectionEnabled} disabled={busy} onChange={(event) => void updatePreferences({ collectionEnabled: event.target.checked })} />
            <span>Capture local events</span>
          </label>
        </div>
        <div className="telemetry-preference-group">
          <span className="telemetry-preference-group__label">Development mods</span>
          <label className="telemetry-workspace__toggle">
            <input type="checkbox" checked={preferences?.protectLocalMods ?? true} disabled={busy} onChange={(event) => void updatePreferences({ protectLocalMods: event.target.checked })} />
            <span>Keep local or unmanaged mods local by default</span>
          </label>
        </div>
        <div className="telemetry-preference-group">
          <span className="telemetry-preference-group__label">Upload</span>
          <label className="telemetry-workspace__toggle">
            <input type="checkbox" checked={uploadEnabled} disabled={busy || !collectionEnabled} onChange={(event) => void updatePreferences({ uploadEnabled: event.target.checked })} />
            <span>Queue completed sessions for update-check sync</span>
          </label>
        </div>
        <div className="telemetry-preference-group">
          <span className="telemetry-preference-group__label">Details</span>
          <label className="telemetry-workspace__toggle">
            <input type="checkbox" checked={preferences?.errorExcerptsEnabled ?? false} disabled={busy || !collectionEnabled} onChange={(event) => void updatePreferences({ errorExcerptsEnabled: event.target.checked })} />
            <span>Include sanitized excerpts</span>
          </label>
        </div>
        <label className="telemetry-retention">Keep local history
          <select value={preferences?.retentionDays ?? 30} disabled={busy} onChange={(event) => void updatePreferences({ retentionDays: Number(event.target.value) })}>
            <option value={7}>7 days</option><option value={14}>14 days</option><option value={30}>30 days</option><option value={90}>90 days</option>
          </select>
        </label>
      </section>

      <section className="telemetry-workspace__toolbar" aria-label="Telemetry filters and actions">
        <div className={`telemetry-sync-status ${failedUpload ? 'telemetry-sync-status--attention' : uploadEnabled ? 'telemetry-sync-status--enabled' : ''}`}>
          <Icon name={failedUpload ? 'triangleExclamation' : uploadEnabled ? 'circleCheck' : 'lock'} />
          <span>{syncLabel}</span>
          {failedUpload && <span>Retries with the next update check.</span>}
        </div>
        <div className="telemetry-capture-summary" aria-label="Captured telemetry summary">
          <span><strong>{capturedSessionCount}</strong> ended {capturedSessionCount === 1 ? 'session' : 'sessions'}</span>
          <span><strong>{capturedModCount}</strong> mod entries</span>
        </div>
        <div className="telemetry-workspace__spacer" />
        <select value={environmentId} onChange={(event) => setEnvironmentId(event.target.value)} aria-label="Telemetry environment">
          <option value="">All environments</option>
          {environments.map((environment) => <option key={environment.id} value={environment.id}>{environment.name}</option>)}
        </select>
        <select value={severity} onChange={(event) => setSeverity(event.target.value)} aria-label="Telemetry severity">
          <option value="all">All severities</option><option value="WARN">Warnings</option><option value="ERROR">Errors</option><option value="FATAL">Fatal</option>
        </select>
        <SimmButton className="btn btn-secondary btn-small" disabled={busy || !telemetryAvailable || !environmentId} onClick={() => void openModPolicyManager()}><Icon name="cog" /> Manage mod data</SimmButton>
        <SimmButton className="btn btn-secondary btn-small" disabled={busy || !telemetryAvailable || !collectionEnabled} onClick={() => void viewExport()}><Icon name="copy" /> View export</SimmButton>
        {/* TEST-ONLY: remove this direct upload control before shipping telemetry. */}
        <SimmButton className="btn btn-secondary btn-small telemetry-workspace__test-upload" disabled={busy || !telemetryAvailable || !collectionEnabled || !uploadEnabled} onClick={() => void uploadQueuedTelemetryForTesting()}><Icon name="upload" /> Test-only: upload now</SimmButton>
        <SimmButton className="btn btn-danger btn-small" disabled={busy || !telemetryAvailable || events.length === 0} onClick={() => setClearConfirmationOpen(true)}><Icon name="trash" /> Clear history</SimmButton>
      </section>

      {feedback && <p className="telemetry-workspace__feedback" role={feedbackTone === 'error' ? 'alert' : 'status'}>{feedback}</p>}
      {feedbackTone === 'error' && <SimmButton className="btn btn-secondary btn-small" disabled={busy} onClick={() => void refresh()}><Icon name="rotate" /> Retry refresh</SimmButton>}
      {failedUpload && <SimmButton className="btn btn-secondary btn-small" disabled={busy || !collectionEnabled || !uploadEnabled} onClick={() => void retryFailedUpload()}><Icon name="rotate" /> Retry failed upload</SimmButton>}

      <div className="telemetry-workspace__history">
        <section className="telemetry-workspace__sessions" aria-label="Telemetry sessions">
          <header className="telemetry-workspace__section-heading"><span>Monitoring</span><strong>{activeCount > 0 ? `${activeCount} active` : `${statuses.length} tracked`}</strong></header>
          {statuses.length === 0 ? <p className="telemetry-workspace__empty-copy">No registered environments are being monitored right now.</p> : statuses.map((status) => {
            const environment = environments.find((entry) => entry.id === status.environmentId);
            return <div key={status.environmentId} className="telemetry-session-row">
              <div><strong>{environment?.name ?? status.environmentId}</strong><span>{status.monitoring ? 'Monitoring Latest.log' : 'Not running'}</span></div>
              <span>{status.eventCount} events</span><span>{status.lastEventAt ?? 'No events'}</span>
            </div>;
          })}
        </section>

        <section className="telemetry-workspace__event-list" aria-live="polite" aria-label="Telemetry event history">
          <header className="telemetry-workspace__section-heading"><span>Warnings and errors</span><strong>{filteredEvents.length} shown</strong></header>
          {filteredEvents.length === 0 ? (
            <div className="telemetry-workspace__empty-copy telemetry-workspace__empty-copy--events">
              <h3>{collectionEnabled ? 'No captured warnings or errors' : 'Local collection is off'}</h3>
              <p>{collectionEnabled
                ? capturedSessionCount > 0
                  ? `${capturedSessionCount} ended ${capturedSessionCount === 1 ? 'session has' : 'sessions have'} been captured with ${capturedModCount} mod entries. No warnings or errors were recorded.`
                  : 'New events and mod snapshots will appear here while a registered environment is running.'
                : 'Enable collection to keep a local diagnostic history.'}</p>
            </div>
          ) : filteredEvents.map((event) => (
            <article key={event.eventId} className={`telemetry-event telemetry-event--${event.severity.toLowerCase()}`}>
              <div className="telemetry-event__meta"><strong>{event.severity}</strong><span>{event.modName ?? event.attribution}</span><time dateTime={event.occurredAt}>{event.occurredAt}</time></div>
              <div className="telemetry-event__identity"><span>{event.errorClass || 'unclassified'}</span><span>{event.errorCode ?? 'no code'}</span><code>{event.fingerprint}</code></div>
              {event.message && <pre>{event.message}</pre>}
            </article>
          ))}
        </section>
      </div>

      <Dialog open={exportPreview !== null} onOpenChange={(open) => { if (!open) setExportPreview(null); }}>
        <SimmDialogContent className="app-dialog telemetry-export-viewer" showCloseButton={false} aria-label="Local telemetry export">
          <DialogHeader className="modal-header app-dialog__header">
            <div className="app-dialog__heading"><span className="app-dialog__eyebrow">Local export</span><DialogTitle>What SIMM shares</DialogTitle></div>
            <SimmButton variant="ghost" size="icon-sm" className="modal-close" onClick={() => setExportPreview(null)} aria-label="Close local telemetry export"><Icon name="times" /></SimmButton>
          </DialogHeader>
          {exportPreview && <div className="app-dialog__body telemetry-export-viewer__body">
            <DialogDescription>Completed sessions wait locally until the next update check. This view is for inspection only; it never sends data or changes your consent.</DialogDescription>
            <div className="telemetry-export-viewer__metrics">
              <div><span>Ended sessions</span><strong>{exportPreview.sessionCount}</strong></div>
              <div><span>Mod entries</span><strong>{captureHistory?.sessions.reduce((count, session) => count + session.mods.length, 0) ?? 0}</strong></div>
              <div><span>Warnings and errors</span><strong>{exportPreview.eventCount}</strong></div>
              <div><span>Diagnostic details</span><strong>{preferences?.errorExcerptsEnabled ? 'Sanitized' : 'Structured only'}</strong></div>
            </div>
            <ul className="telemetry-export-viewer__exclusions">{exportPreview.exclusions.map((exclusion) => <li key={exclusion}>{exclusion}</li>)}</ul>
            <details className="telemetry-export-viewer__raw"><summary>Inspect exact export JSON</summary><pre tabIndex={0}>{exportPreview.payload}</pre></details>
          </div>}
          <DialogFooter className="app-dialog__footer"><div className="app-dialog__actions"><SimmButton className="btn btn-primary" onClick={() => setExportPreview(null)}>Done</SimmButton></div></DialogFooter>
        </SimmDialogContent>
      </Dialog>

      <Dialog open={modPolicyOpen} onOpenChange={(open) => { if (!open) setModPolicyOpen(false); }}>
        <SimmDialogContent className="app-dialog telemetry-mod-policy-dialog" showCloseButton={false} aria-label="Telemetry mod data rules">
          <DialogHeader className="modal-header app-dialog__header">
            <div className="app-dialog__heading"><span className="app-dialog__eyebrow">Development privacy</span><DialogTitle>Manage mod data</DialogTitle></div>
            <SimmButton variant="ghost" size="icon-sm" className="modal-close" onClick={() => setModPolicyOpen(false)} aria-label="Close mod data rules"><Icon name="times" /></SimmButton>
          </DialogHeader>
          <div className="app-dialog__body telemetry-mod-policy-dialog__body">
            <DialogDescription>Choose what SIMM keeps and shares for each installed mod. “Local only” remains in this device’s history but is removed from every upload preview and queued payload.</DialogDescription>
            <p className="telemetry-mod-policy-dialog__environment">Rules shown for <strong>{environments.find((environment) => environment.id === environmentId)?.name ?? 'this environment'}</strong>. A global rule applies to every environment; an environment rule takes precedence.</p>
            <div className="telemetry-mod-policy-dialog__list">
              {modPolicies.length === 0 ? <p className="telemetry-workspace__empty-copy">No installed mods were found for this environment.</p> : modPolicies.map((policy) => {
                const scope = ruleScopeFor(policy);
                const selectedMode = scope === 'environment'
                  ? (policy.environmentOverride ?? 'automatic')
                  : (policy.globalOverride ?? 'automatic');
                return <article className="telemetry-mod-policy-row" key={policy.modEntry.modKey}>
                  <div className="telemetry-mod-policy-row__details">
                    <strong>{policy.modEntry.name}</strong>
                    <span>{policy.modEntry.fileName} · {policy.modEntry.source ?? 'local'} · {policy.modEntry.managed ? 'Managed' : 'Unmanaged'}</span>
                    <small>Effective: {policy.effectiveMode.replace('_', ' ')}{policy.automaticReason ? ` · ${policy.automaticReason}` : ''}</small>
                  </div>
                  <div className="telemetry-mod-policy-row__controls">
                    <label>Scope<select value={scope} disabled={busy} onChange={(event) => setModRuleScopes((current) => ({ ...current, [policy.modEntry.modKey]: event.target.value as 'environment' | 'global' }))}><option value="environment">This environment</option><option value="global">All environments</option></select></label>
                    <label>Data<select value={selectedMode} disabled={busy} onChange={(event) => void saveModPolicy(policy, event.target.value as 'automatic' | TelemetryModCaptureMode)}><option value="automatic">Automatic</option><option value="share">Share</option><option value="local_only">Local only</option><option value="ignore">Ignore</option></select></label>
                  </div>
                </article>;
              })}
            </div>
          </div>
          <DialogFooter className="app-dialog__footer"><div className="app-dialog__actions"><SimmButton className="btn btn-primary" onClick={() => setModPolicyOpen(false)}>Done</SimmButton></div></DialogFooter>
        </SimmDialogContent>
      </Dialog>

      <ConfirmOverlay
        isOpen={clearConfirmationOpen}
        onClose={() => setClearConfirmationOpen(false)}
        onConfirm={() => void clearHistory()}
        title="Clear local telemetry history?"
        message="This permanently removes the captured warnings and errors shown here. It does not change collection, upload, or excerpt permissions."
        confirmText="Clear local history"
        tone="danger"
      />
    </section>
  );
}
