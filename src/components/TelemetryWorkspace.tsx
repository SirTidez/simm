import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Dialog, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { ApiService } from '../services/api';
import { createAsyncListenerScope, onLiveTelemetryEvent, onLiveTelemetryStatus } from '../services/events';
import { useEnvironmentStore } from '../stores/environmentStore';
import type { LiveTelemetryEvent, LiveTelemetryExport, LiveTelemetryStatus, TelemetryCapability, TelemetryModCaptureMode, TelemetryModPolicyItem, TelemetryPreferences, TelemetryUploadPreview, TelemetryUploadReceipt } from '../types';
import { ConfirmOverlay } from './ConfirmOverlay';
import { Icon } from './Icon';
import { SimmButton, SimmDialogContent } from './primitives';
import { ModThumbnail } from './media/ModThumbnail';
import { useLibraryArtwork } from './useLibraryArtwork';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Switch } from '@/components/ui/switch';
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

const TELEMETRY_TIME_FORMAT = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
});

function formatTelemetryTime(value: string): string {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : TELEMETRY_TIME_FORMAT.format(parsed);
}

type TelemetrySelectOption = { value: string; label: string };

const SEVERITY_OPTIONS: TelemetrySelectOption[] = [
  { value: 'all', label: 'All levels' },
  { value: 'WARN', label: 'Warnings' },
  { value: 'ERROR', label: 'Errors' },
  { value: 'FATAL', label: 'Fatal' },
];
const RETENTION_OPTIONS: TelemetrySelectOption[] = [7, 14, 30, 90].map((days) => ({ value: String(days), label: `${days} days` }));
const RULE_SCOPE_OPTIONS: TelemetrySelectOption[] = [
  { value: 'environment', label: 'This environment' },
  { value: 'global', label: 'All environments' },
];
const DATA_RULE_OPTIONS: TelemetrySelectOption[] = [
  { value: 'automatic', label: 'Automatic' },
  { value: 'share', label: 'Share' },
  { value: 'local_only', label: 'Local only' },
  { value: 'ignore', label: 'Ignore' },
];
// The shared Select treats an empty string as "no value", so "All environments" uses a sentinel.
const ALL_ENVIRONMENTS = '__all__';

function TelemetrySelect({ label, value, options, onValueChange, disabled, size, className }: {
  label: string;
  value: string;
  options: TelemetrySelectOption[];
  onValueChange: (value: string) => void;
  disabled?: boolean;
  size?: 'sm' | 'default';
  className?: string;
}) {
  return (
    <Select
      items={options}
      value={value}
      disabled={disabled}
      onValueChange={(next) => { if (typeof next === 'string') onValueChange(next); }}
    >
      <SelectTrigger size={size} className={className} aria-label={label}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent align="start">
        <SelectGroup>
          {options.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}
        </SelectGroup>
      </SelectContent>
    </Select>
  );
}

function describeSeverity(severity: string): { label: string; tone: 'danger' | 'warn' | 'info' } {
  const normalized = severity.toLowerCase();
  if (normalized.startsWith('fatal')) return { label: 'Fatal', tone: 'danger' };
  if (normalized.startsWith('err')) return { label: 'Error', tone: 'danger' };
  if (normalized.startsWith('warn')) return { label: 'Warning', tone: 'warn' };
  return { label: severity.charAt(0).toUpperCase() + severity.slice(1).toLowerCase(), tone: 'info' };
}

export function TelemetryWorkspace({ onClose }: { onClose: () => void }) {
  const { environments } = useEnvironmentStore();
  const getModArtwork = useLibraryArtwork();
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
  const [preferencesOpen, setPreferencesOpen] = useState(false);
  const [moreMenuOpen, setMoreMenuOpen] = useState(false);
  const refreshGenerationRef = useRef(0);

  const reportActionError = useCallback((error: unknown, fallback: string) => {
    setFeedback(error instanceof Error ? error.message : fallback);
    setFeedbackTone('error');
  }, []);

  const refresh = useCallback(async () => {
    const refreshGeneration = ++refreshGenerationRef.current;
    try {
      const nextCapability = await ApiService.getTelemetryCapability();
      if (refreshGeneration !== refreshGenerationRef.current) return;
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
      if (refreshGeneration !== refreshGenerationRef.current) return;
      setPreferences(nextPreferences);
      setStatuses(nextStatuses);
      setEvents(nextEvents);
      setUploads(nextUploads);
      setCaptureHistory(nextCaptureHistory);
    } catch (error) {
      if (refreshGeneration !== refreshGenerationRef.current) return;
      setFeedback(error instanceof Error ? error.message : 'Failed to refresh local telemetry. Retry when SIMM is ready.');
      setFeedbackTone('error');
    }
  }, [environmentId]);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    const listeners = createAsyncListenerScope((error) => {
      reportActionError(error, 'Failed to listen for telemetry updates.');
    });
    listeners.register(() => onLiveTelemetryEvent(() => {
      if (listeners.isActive()) void refresh();
    }));
    listeners.register(() => onLiveTelemetryStatus(() => {
      if (listeners.isActive()) void refresh();
    }));
    return () => {
      refreshGenerationRef.current += 1;
      listeners.dispose();
    };
  }, [refresh, reportActionError]);

  // Escape leaves the workspace, like Settings, Accounts, and Help, unless a
  // dialog, popover, or menu on this page is open and should close first.
  // Capture phase: runs before the popup closes itself, so an open layer wins.
  useEffect(() => {
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      if (exportPreview || modPolicyOpen || clearConfirmationOpen || preferencesOpen || moreMenuOpen) return;
      if (document.querySelector('[data-slot="popover-content"], [data-slot="dropdown-menu-content"], [data-slot="select-content"], [role="dialog"], [role="alertdialog"]')) return;
      onClose();
    };
    document.addEventListener('keydown', handleEscape, true);
    return () => document.removeEventListener('keydown', handleEscape, true);
  }, [clearConfirmationOpen, exportPreview, modPolicyOpen, moreMenuOpen, onClose, preferencesOpen]);

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

  const environmentOptions = useMemo<TelemetrySelectOption[]>(() => [
    { value: ALL_ENVIRONMENTS, label: 'All environments' },
    ...environments.map((environment) => ({ value: environment.id, label: environment.name })),
  ], [environments]);
  const selectedEnvironmentName = environments.find((environment) => environment.id === environmentId)?.name;
  const retentionDays = preferences?.retentionDays ?? 30;
  const showDeveloperUpload = import.meta.env.DEV;

  return (
    <section className="workspace-panel ui-page telemetry-workspace" aria-label="Telemetry">
      <header className="ui-page-header">
        <div className="ui-page-header__titles">
          <h2 className="ui-page-title">Telemetry</h2>
          <div className="ui-meta telemetry-status" aria-label="Telemetry status">
            <span className={`ui-status ${collectionEnabled && activeCount > 0 ? 'ui-status--ok' : 'ui-status--muted'}`}>
              {!collectionEnabled ? 'Collection off' : activeCount > 0 ? `${activeCount} monitoring` : 'Waiting for game'}
            </span>
            <span>{collectionEnabled ? syncLabel : 'Nothing is recorded'}</span>
            {failedUpload && (
              <span className="telemetry-status__attention">
                Upload failed, retries with the next update check
                <SimmButton variant="link" disabled={busy || !collectionEnabled || !uploadEnabled} onClick={() => void retryFailedUpload()}>Retry Failed Upload</SimmButton>
              </span>
            )}
          </div>
        </div>
        <div className="ui-toolbar">
          <Popover open={preferencesOpen} onOpenChange={setPreferencesOpen}>
            <PopoverTrigger
              render={<button type="button" data-slot="button" data-variant="outline" data-size="default" disabled={!telemetryAvailable} />}
            >
              <Icon name="sliders" /> Preferences
            </PopoverTrigger>
            <PopoverContent align="end" className="telemetry-preferences" aria-label="Telemetry controls">
              <TelemetrySwitchRow
                label="Capture local events"
                checked={collectionEnabled}
                disabled={busy}
                onChange={(checked) => void updatePreferences({ collectionEnabled: checked })}
              />
              <TelemetrySwitchRow
                label="Keep local and unmanaged mods local"
                help="Development mods stay out of uploads unless you share them."
                checked={preferences?.protectLocalMods ?? true}
                disabled={busy}
                onChange={(checked) => void updatePreferences({ protectLocalMods: checked })}
              />
              <TelemetrySwitchRow
                label="Queue sessions for upload"
                help="Completed sessions sync with the next update check."
                checked={uploadEnabled}
                disabled={busy || !collectionEnabled}
                onChange={(checked) => void updatePreferences({ uploadEnabled: checked })}
              />
              <TelemetrySwitchRow
                label="Include sanitized excerpts"
                checked={preferences?.errorExcerptsEnabled ?? false}
                disabled={busy || !collectionEnabled}
                onChange={(checked) => void updatePreferences({ errorExcerptsEnabled: checked })}
              />
              <div className="telemetry-preferences__row">
                <span className="telemetry-preferences__label">Keep local history</span>
                <TelemetrySelect
                  label="Keep local history"
                  className="telemetry-preferences__select"
                  value={String(retentionDays)}
                  options={RETENTION_OPTIONS}
                  disabled={busy}
                  onValueChange={(next) => void updatePreferences({ retentionDays: Number(next) })}
                />
              </div>
            </PopoverContent>
          </Popover>
          <SimmButton variant="outline" disabled={busy || !telemetryAvailable || !collectionEnabled} onClick={() => void viewExport()}>View Export</SimmButton>
          <DropdownMenu open={moreMenuOpen} onOpenChange={setMoreMenuOpen}>
            <DropdownMenuTrigger
              render={<button type="button" data-slot="button" data-variant="ghost" data-size="icon" aria-label="More telemetry actions" />}
            >
              <Icon name="ellipsisH" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="telemetry-menu">
              {showDeveloperUpload && (
                <>
                  <DropdownMenuGroup>
                    <DropdownMenuLabel>Developer</DropdownMenuLabel>
                    <DropdownMenuItem
                      disabled={busy || !telemetryAvailable || !collectionEnabled || !uploadEnabled}
                      onClick={() => void uploadQueuedTelemetryForTesting()}
                    >
                      Upload Queued Sessions Now
                    </DropdownMenuItem>
                  </DropdownMenuGroup>
                  <DropdownMenuSeparator />
                </>
              )}
              <DropdownMenuItem
                disabled={busy || !telemetryAvailable}
                onClick={() => void openModPolicyManager()}
              >
                Manage Mod Data…
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                variant="destructive"
                disabled={busy || !telemetryAvailable || events.length === 0}
                onClick={() => setClearConfirmationOpen(true)}
              >
                Clear History…
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </header>

      {feedback && (
        <div className={`telemetry-feedback${feedbackTone === 'error' ? ' telemetry-feedback--error' : ''}`}>
          <p role={feedbackTone === 'error' ? 'alert' : 'status'}>{feedback}</p>
          {feedbackTone === 'error' && <SimmButton variant="outline" size="sm" disabled={busy} onClick={() => void refresh()}>Retry Refresh</SimmButton>}
        </div>
      )}

      <div className="telemetry-layout">
        <section className="telemetry-environments" aria-label="Telemetry sessions">
          <h3 className="telemetry-heading">Environments</h3>
          {statuses.length === 0 ? (
            <p className="telemetry-environments__empty">No registered environments are being monitored. Start a game from SIMM to begin.</p>
          ) : statuses.map((status) => {
            const environment = environments.find((entry) => entry.id === status.environmentId);
            return (
              <div key={status.environmentId} className="telemetry-environment">
                <div className="telemetry-environment__title">
                  <strong className="ui-truncate">{environment?.name ?? status.environmentId}</strong>
                  <span className={`ui-status ${status.monitoring ? 'ui-status--ok' : 'ui-status--muted'}`}>{status.monitoring ? 'Monitoring' : 'Not running'}</span>
                </div>
                <span className="telemetry-environment__meta">
                  {status.eventCount} {status.eventCount === 1 ? 'event' : 'events'}
                  {status.lastEventAt ? ` · last ${formatTelemetryTime(status.lastEventAt)}` : ''}
                </span>
              </div>
            );
          })}
        </section>

        <section className="telemetry-events" aria-label="Telemetry event history">
          <div className="ui-toolbar telemetry-events__toolbar">
            <TelemetrySelect
              label="Telemetry environment"
              className="telemetry-events__select"
              value={environmentId || ALL_ENVIRONMENTS}
              options={environmentOptions}
              onValueChange={(next) => setEnvironmentId(next === ALL_ENVIRONMENTS ? '' : next)}
            />
            <TelemetrySelect
              label="Telemetry severity"
              className="telemetry-events__select"
              value={severity}
              options={SEVERITY_OPTIONS}
              onValueChange={setSeverity}
            />
            <span className="ui-toolbar__spacer" />
            <span className="telemetry-events__count">{filteredEvents.length} shown</span>
          </div>

          <div className="telemetry-events__list" aria-live="polite">
            {filteredEvents.length === 0 ? (
              <div className="ui-empty">
                <span className="ui-empty__emblem" aria-hidden="true"><Icon name={collectionEnabled ? 'waveSquare' : 'toggleOff'} /></span>
                <h3 className="ui-empty__title">{collectionEnabled ? 'No warnings or errors' : 'Local collection is off'}</h3>
                <p className="ui-empty__copy">{collectionEnabled
                  ? capturedSessionCount > 0
                    ? `${capturedSessionCount} ended ${capturedSessionCount === 1 ? 'session was' : 'sessions were'} captured with ${capturedModCount} mod entries and no warnings or errors.`
                    : 'Warnings and errors appear here while a registered environment is running.'
                  : 'Turn on Capture local events in Preferences to keep a local diagnostic history.'}</p>
              </div>
            ) : filteredEvents.map((event) => {
              const level = describeSeverity(event.severity);
              return (
                <article key={event.eventId} className="telemetry-event">
                  <div className="telemetry-event__head">
                    <span className={`ui-status ui-status--${level.tone}`}>{level.label}</span>
                    <span className="telemetry-event__source">
                      {event.modName && <ModThumbnail {...getModArtwork(event.modName)} name={event.modName} size={20} />}
                      <strong className="ui-truncate">{event.modName ?? event.attribution}</strong>
                    </span>
                    <time className="telemetry-event__time" dateTime={event.occurredAt}>{formatTelemetryTime(event.occurredAt)}</time>
                  </div>
                  {event.message && <pre className="telemetry-event__message">{event.message}</pre>}
                  <div className="ui-meta telemetry-event__identity">
                    <span>{event.errorClass || 'Unclassified'}</span>
                    {event.errorCode && <span>{event.errorCode}</span>}
                    <span className="ui-mono">{event.fingerprint}</span>
                  </div>
                </article>
              );
            })}
          </div>
        </section>
      </div>

      <Dialog open={exportPreview !== null} onOpenChange={(open) => { if (!open) setExportPreview(null); }}>
        <SimmDialogContent className="app-dialog telemetry-export-viewer" showCloseButton={false} aria-label="Local telemetry export">
          <DialogHeader className="modal-header app-dialog__header">
            <div className="app-dialog__heading"><DialogTitle>What SIMM shares</DialogTitle></div>
            <SimmButton variant="ghost" size="icon-sm" className="modal-close" onClick={() => setExportPreview(null)} aria-label="Close local telemetry export"><Icon name="times" /></SimmButton>
          </DialogHeader>
          {exportPreview && <div className="app-dialog__body telemetry-export-viewer__body">
            <DialogDescription>Completed sessions wait on this device until the next update check. This view only inspects the export; it never sends data or changes your consent.</DialogDescription>
            <dl className="ui-kv telemetry-export-viewer__facts">
              <dt>Ended sessions</dt><dd className="ui-num">{exportPreview.sessionCount}</dd>
              <dt>Mod entries</dt><dd className="ui-num">{captureHistory?.sessions.reduce((count, session) => count + session.mods.length, 0) ?? 0}</dd>
              <dt>Warnings and errors</dt><dd className="ui-num">{exportPreview.eventCount}</dd>
              <dt>Diagnostic details</dt><dd>{preferences?.errorExcerptsEnabled ? 'Sanitized excerpts' : 'Structured only'}</dd>
            </dl>
            {exportPreview.exclusions.length > 0 && (
              <div className="telemetry-export-viewer__exclusions">
                <h3 className="ui-section-title">Left out of the export</h3>
                <ul>{exportPreview.exclusions.map((exclusion) => <li key={exclusion}>{exclusion}</li>)}</ul>
              </div>
            )}
            <details className="telemetry-export-viewer__raw"><summary>Inspect exact export JSON</summary><pre tabIndex={0}>{exportPreview.payload}</pre></details>
          </div>}
          <DialogFooter className="app-dialog__footer"><div className="app-dialog__actions"><SimmButton onClick={() => setExportPreview(null)}>Done</SimmButton></div></DialogFooter>
        </SimmDialogContent>
      </Dialog>

      <Dialog open={modPolicyOpen} onOpenChange={(open) => { if (!open) setModPolicyOpen(false); }}>
        <SimmDialogContent className="app-dialog telemetry-mod-policy-dialog" showCloseButton={false} aria-label="Telemetry mod data rules">
          <DialogHeader className="modal-header app-dialog__header">
            <div className="app-dialog__heading"><DialogTitle>Manage mod data</DialogTitle></div>
            <SimmButton variant="ghost" size="icon-sm" className="modal-close" onClick={() => setModPolicyOpen(false)} aria-label="Close mod data rules"><Icon name="times" /></SimmButton>
          </DialogHeader>
          <div className="app-dialog__body telemetry-mod-policy-dialog__body">
            <DialogDescription>
              Choose what SIMM keeps and shares for each mod in <strong>{selectedEnvironmentName ?? 'this environment'}</strong>. “Local only” stays in this device’s history and is removed from every upload. An environment rule overrides a rule for all environments.
            </DialogDescription>
            {modPolicies.length === 0 ? (
              <div className="ui-empty">
                <span className="ui-empty__emblem" aria-hidden="true"><Icon name="puzzlePiece" /></span>
                <p className="ui-empty__copy">No installed mods were found for this environment.</p>
              </div>
            ) : (
              <div className="telemetry-mod-policy-dialog__table">
                <table className="ui-table">
                  <thead>
                    <tr><th scope="col">Mod</th><th scope="col">Applies to</th><th scope="col">Data</th></tr>
                  </thead>
                  <tbody>
                    {modPolicies.map((policy) => {
                      const scope = ruleScopeFor(policy);
                      const selectedMode = scope === 'environment'
                        ? (policy.environmentOverride ?? 'automatic')
                        : (policy.globalOverride ?? 'automatic');
                      return (
                        <tr className="ui-row" key={policy.modEntry.modKey}>
                          <td>
                            <div className="telemetry-mod-policy__mod">
                              <ModThumbnail
                                {...(getModArtwork(policy.modEntry.name) ?? getModArtwork(policy.modEntry.fileName))}
                                name={policy.modEntry.name}
                                size={20}
                              />
                              <div className="telemetry-mod-policy__text">
                                <div className="telemetry-mod-policy__name">{policy.modEntry.name}</div>
                                <div className="telemetry-mod-policy__meta">
                                  {policy.modEntry.managed ? 'Managed' : 'Unmanaged'} · effective: {policy.effectiveMode.replace('_', ' ')}{policy.automaticReason ? ` (${policy.automaticReason})` : ''}
                                </div>
                              </div>
                            </div>
                          </td>
                          <td>
                            <TelemetrySelect
                              label={`Rule scope for ${policy.modEntry.name}`}
                              size="sm"
                              className="telemetry-mod-policy__select"
                              value={scope}
                              options={RULE_SCOPE_OPTIONS}
                              disabled={busy}
                              onValueChange={(next) => setModRuleScopes((current) => ({ ...current, [policy.modEntry.modKey]: next as 'environment' | 'global' }))}
                            />
                          </td>
                          <td>
                            <TelemetrySelect
                              label={`Data rule for ${policy.modEntry.name}`}
                              size="sm"
                              className="telemetry-mod-policy__select"
                              value={selectedMode}
                              options={DATA_RULE_OPTIONS}
                              disabled={busy}
                              onValueChange={(next) => void saveModPolicy(policy, next as 'automatic' | TelemetryModCaptureMode)}
                            />
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
          <DialogFooter className="app-dialog__footer"><div className="app-dialog__actions"><SimmButton onClick={() => setModPolicyOpen(false)}>Done</SimmButton></div></DialogFooter>
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

function TelemetrySwitchRow({ label, help, checked, disabled, onChange }: {
  label: string;
  help?: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="telemetry-preferences__row" data-disabled={disabled ? 'true' : undefined}>
      <span className="telemetry-preferences__copy">
        <span className="telemetry-preferences__label">{label}</span>
        {help && <span className="telemetry-preferences__help">{help}</span>}
      </span>
      <Switch className="telemetry-switch" checked={checked} disabled={disabled} onCheckedChange={onChange} aria-label={label} />
    </label>
  );
}
