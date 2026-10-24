import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  Environment,
  ModIntegrationConfig,
  ModIntegrationPolicy,
  ModIntegrationRequestRecord,
} from '../types';
import { ApiService } from '../services/api';
import { Dialog, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { SimmButton, SimmDialogContent } from './primitives';
import { Icon } from './Icon';

type ModIntegrationDialogProps = {
  isOpen: boolean;
  environment: Environment;
  onClose: () => void;
  onManageRequest?: (request: ModIntegrationRequestRecord) => void;
};

const policyOptions: Array<{
  value: ModIntegrationPolicy;
  title: string;
  description: string;
}> = [
  {
    value: 'disabled',
    title: 'Disabled',
    description: 'Mods cannot ask SIMM for updates or management.',
  },
  {
    value: 'ask',
    title: 'Ask first',
    description: 'Each update request waits here for your approval.',
  },
  {
    value: 'automatic',
    title: 'Queue automatically',
    description: 'Verified updates are queued without asking. Management still needs your source choice.',
  },
];

function requestStatusLabel(status: ModIntegrationRequestRecord['status']): string {
  return status.split('-').map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`).join(' ');
}

function requestStatusTone(status: ModIntegrationRequestRecord['status']): 'ok' | 'warn' | 'danger' | 'muted' {
  if (status === 'up-to-date' || status === 'managed' || status === 'already-managed') return 'ok';
  if (status === 'queued' || status === 'awaiting-user-approval' || status === 'awaiting-user-source') return 'warn';
  if (status === 'failed' || status === 'denied' || status === 'invalid') return 'danger';
  return 'muted';
}

export function ModIntegrationDialog({
  isOpen,
  environment,
  onClose,
  onManageRequest,
}: ModIntegrationDialogProps) {
  const [config, setConfig] = useState<ModIntegrationConfig | null>(null);
  const [requests, setRequests] = useState<ModIntegrationRequestRecord[]>([]);
  const [selectedPolicy, setSelectedPolicy] = useState<ModIntegrationPolicy>('disabled');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [resolvingId, setResolvingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const loadInFlight = useRef(false);
  const policyDirty = useRef(false);

  const load = useCallback(async (showLoading = false) => {
    if (loadInFlight.current) return;
    loadInFlight.current = true;
    if (showLoading) setLoading(true);
    try {
      const [nextConfig, nextRequests] = await Promise.all([
        ApiService.getModIntegrationConfig(environment.id),
        ApiService.listModIntegrationRequests(environment.id),
      ]);
      setConfig(nextConfig);
      if (!policyDirty.current) {
        setSelectedPolicy(nextConfig.policy);
      }
      setRequests(nextRequests);
      setError(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    } finally {
      loadInFlight.current = false;
      if (showLoading) setLoading(false);
    }
  }, [environment.id]);

  useEffect(() => {
    if (!isOpen) return undefined;
    void load(true);
    const interval = window.setInterval(() => void load(false), 2_000);
    return () => window.clearInterval(interval);
  }, [isOpen, load]);

  const pendingRequests = useMemo(
    () => requests.filter((request) => (
      request.status === 'awaiting-user-approval' || request.status === 'awaiting-user-source'
    )),
    [requests],
  );

  const savePolicy = async () => {
    setSaving(true);
    setError(null);
    try {
      const next = await ApiService.setModIntegrationPolicy(environment.id, selectedPolicy);
      policyDirty.current = false;
      setConfig(next);
      setSelectedPolicy(next.policy);
      await load(false);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : String(saveError));
    } finally {
      setSaving(false);
    }
  };

  const resolveRequest = async (requestId: string, approve: boolean) => {
    setResolvingId(requestId);
    setError(null);
    try {
      await ApiService.resolveModIntegrationRequest(requestId, approve);
      await load(false);
    } catch (resolveError) {
      setError(resolveError instanceof Error ? resolveError.message : String(resolveError));
    } finally {
      setResolvingId(null);
    }
  };

  const connectionStatus = !config
    ? null
    : config.listening
      ? { tone: 'ok', label: 'Connected' }
      : config.policy !== 'disabled'
        ? { tone: 'warn', label: 'Not listening' }
        : { tone: 'muted', label: 'Off' };

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <SimmDialogContent className="app-dialog mod-integration-dialog" showCloseButton={false}>
        <DialogHeader className="modal-header app-dialog__header">
          <div className="app-dialog__heading">
            <DialogTitle>Mod Integration</DialogTitle>
            <div className="ui-meta">
              <span>{environment.name}</span>
              {connectionStatus && (
                <span className={`ui-status ui-status--${connectionStatus.tone}`}>{connectionStatus.label}</span>
              )}
            </div>
          </div>
          <SimmButton
            variant="ghost"
            size="icon-sm"
            className="modal-close"
            onClick={onClose}
            aria-label="Close mod integration settings"
          >
            <Icon name="times" />
          </SimmButton>
        </DialogHeader>

        <div className="app-dialog__body mod-integration-dialog__body">
          {error && (
            <div className="ui-callout ui-callout--danger" role="alert">
              <span>{error}</span>
            </div>
          )}

          {loading ? (
            <div className="mod-integration-dialog__loading" role="status" aria-label="Loading integration settings">
              <span className="loading-skeleton env-skeleton env-skeleton--row" aria-hidden="true" />
              <span className="loading-skeleton env-skeleton env-skeleton--row" aria-hidden="true" />
              <span className="loading-skeleton env-skeleton env-skeleton--row" aria-hidden="true" />
            </div>
          ) : (
            <>
              {pendingRequests.length > 0 && (
                <section className="mod-integration-dialog__section" aria-labelledby="mod-integration-pending">
                  <h3 id="mod-integration-pending" className="ui-section-title">
                    Needs your decision ({pendingRequests.length})
                  </h3>
                  <ul className="mod-integration-list">
                    {pendingRequests.map((request) => (
                      <li key={request.id} className="mod-integration-list__row">
                        <div className="mod-integration-list__main">
                          <strong className="ui-truncate">{request.modName}</strong>
                          <span className="ui-meta">
                            <span className="ui-mono">
                              {request.currentVersion || 'Unknown version'}
                              {request.targetVersion ? ` → ${request.targetVersion}` : ''}
                            </span>
                            {request.operation === 'requestManagement'
                              ? <span className="ui-mono ui-truncate">{request.modFileName}</span>
                              : request.source ? <span>{request.source}</span> : null}
                          </span>
                        </div>
                        <div className="mod-integration-list__actions">
                          <SimmButton
                            variant="secondary"
                            size="sm"
                            onClick={() => void resolveRequest(request.id, false)}
                            disabled={resolvingId === request.id}
                          >
                            Deny
                          </SimmButton>
                          {request.operation === 'requestManagement' ? (
                            <SimmButton
                              size="sm"
                              onClick={() => onManageRequest?.(request)}
                              disabled={resolvingId === request.id || !onManageRequest}
                            >
                              Choose source
                            </SimmButton>
                          ) : (
                            <SimmButton
                              size="sm"
                              onClick={() => void resolveRequest(request.id, true)}
                              disabled={resolvingId === request.id}
                            >
                              Approve
                            </SimmButton>
                          )}
                        </div>
                      </li>
                    ))}
                  </ul>
                  <p className="mod-integration-dialog__hint">
                    Local mods are only linked to a source you choose.
                  </p>
                </section>
              )}

              <section className="mod-integration-dialog__section" aria-labelledby="mod-integration-policy">
                <h3 id="mod-integration-policy" className="ui-section-title">
                  What may mods in this environment ask SIMM to do?
                </h3>
                <RadioGroup
                  className="mod-integration-policy-list"
                  value={selectedPolicy}
                  onValueChange={(value) => {
                    policyDirty.current = true;
                    setSelectedPolicy(value as ModIntegrationPolicy);
                  }}
                  aria-label="Mod integration request policy"
                >
                  {policyOptions.map((option) => (
                    <label key={option.value} className="mod-integration-policy">
                      <RadioGroupItem value={option.value} />
                      <span>
                        <strong>{option.title}</strong>
                        <small>{option.description}</small>
                      </span>
                    </label>
                  ))}
                </RadioGroup>
                <p className="mod-integration-dialog__hint">
                  Saving a new policy rotates this environment’s private connection token. Sign-in details are never shared with mods.
                </p>
              </section>

              {config && config.policy !== 'disabled' && (
                <section className="mod-integration-dialog__section" aria-labelledby="mod-integration-connection">
                  <h3 id="mod-integration-connection" className="ui-section-title">Local connection</h3>
                  {config.connectionError && (
                    <div className="ui-callout ui-callout--danger" role="alert">
                      <span>{config.connectionError}</span>
                    </div>
                  )}
                  <dl className="ui-kv">
                    <dt>Port</dt>
                    <dd>Port {config.port} · managed automatically</dd>
                    <dt>Protocol</dt>
                    <dd>v{config.protocolVersion} · this computer only</dd>
                    {config.bridgeConfigPath && (
                      <>
                        <dt>Bridge file</dt>
                        <dd className="ui-mono ui-truncate" title={config.bridgeConfigPath}>{config.bridgeConfigPath}</dd>
                      </>
                    )}
                  </dl>
                </section>
              )}

              <section className="mod-integration-dialog__section" aria-labelledby="mod-integration-history">
                <h3 id="mod-integration-history" className="ui-section-title">Recent requests</h3>
                {requests.length === 0 ? (
                  <p className="mod-integration-dialog__hint">
                    No requests yet. Mods that support SIMM integration appear here when they ask for an update.
                  </p>
                ) : (
                  <ul className="mod-integration-list">
                    {requests.slice(0, 12).map((request) => (
                      <li key={request.id} className="mod-integration-list__row">
                        <div className="mod-integration-list__main">
                          <strong className="ui-truncate">{request.modName}</strong>
                          <span className="ui-subtle ui-truncate">{request.message || request.modFileName}</span>
                        </div>
                        <span className={`ui-status ui-status--${requestStatusTone(request.status)}`}>
                          {requestStatusLabel(request.status)}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            </>
          )}
        </div>

        <DialogFooter className="app-dialog__footer">
          <div className="app-dialog__actions">
            <SimmButton variant="secondary" onClick={onClose}>
              Close
            </SimmButton>
            <SimmButton
              onClick={() => void savePolicy()}
              disabled={loading || saving || selectedPolicy === config?.policy}
            >
              {saving && <Icon name="spinner" spin />}
              {saving ? 'Saving…' : 'Save Policy'}
            </SimmButton>
          </div>
        </DialogFooter>
      </SimmDialogContent>
    </Dialog>
  );
}
