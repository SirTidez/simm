import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  Environment,
  ModIntegrationConfig,
  ModIntegrationPolicy,
  ModIntegrationRequestRecord,
} from '../types';
import { ApiService } from '../services/api';
import { Dialog, DialogHeader, DialogTitle } from '@/components/ui/dialog';
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
    description: 'Mods cannot ask SIMM to check for updates or request management.',
  },
  {
    value: 'ask',
    title: 'Ask first',
    description: 'Show each update request here and wait for your approval.',
  },
  {
    value: 'automatic',
    title: 'Queue automatically',
    description: 'Queue verified updates automatically; management still requires your source choice.',
  },
];

function requestStatusLabel(status: ModIntegrationRequestRecord['status']): string {
  return status.split('-').map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`).join(' ');
}

function requestStatusTone(status: ModIntegrationRequestRecord['status']): string {
  if (status === 'up-to-date' || status === 'managed' || status === 'already-managed') return 'success';
  if (status === 'queued' || status === 'awaiting-user-approval' || status === 'awaiting-user-source') return 'warning';
  if (status === 'failed' || status === 'denied' || status === 'invalid') return 'danger';
  return 'neutral';
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
  const [portDraft, setPortDraft] = useState('43871');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savingPort, setSavingPort] = useState(false);
  const [resolvingId, setResolvingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const loadInFlight = useRef(false);
  const policyDirty = useRef(false);
  const portDirty = useRef(false);

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
      if (!portDirty.current) {
        setPortDraft(String(nextConfig.port));
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

  const numericPort = Number(portDraft);
  const portIsValid = /^\d+$/.test(portDraft)
    && Number.isInteger(numericPort)
    && numericPort >= 1
    && numericPort <= 65535;

  const savePort = async () => {
    if (!portIsValid) {
      setError('The bridge port must be between 1 and 65535.');
      return;
    }
    setSavingPort(true);
    setError(null);
    try {
      const next = await ApiService.setModIntegrationPort(environment.id, numericPort);
      portDirty.current = false;
      setConfig(next);
      setPortDraft(String(next.port));
      await load(false);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : String(saveError));
    } finally {
      setSavingPort(false);
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

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <SimmDialogContent className="mod-integration-dialog" showCloseButton={false}>
        <DialogHeader className="modal-header">
          <div>
            <span className="workspace-section-eyebrow">Local mod requests</span>
            <DialogTitle>Mod Integration</DialogTitle>
          </div>
          <SimmButton
            variant="ghost"
            size="icon-sm"
            className="modal-close"
            onClick={onClose}
            aria-label="Close mod integration settings"
          >
            ×
          </SimmButton>
        </DialogHeader>

        <div className="mod-integration-dialog__body">
          <section className="mod-integration-dialog__intro">
            <div>
              <h3>{environment.name}</h3>
              <p>
                Choose whether mods in this installation may ask SIMM to check for updates or
                request management. SIMM keeps provider sign-in details private, verifies the
                calling file, and never adopts a local source without your choice.
              </p>
            </div>
            <span className={`integration-state integration-state--${config?.listening ? 'ready' : config && config.policy !== 'disabled' ? 'warning' : 'off'}`}>
              <Icon name={config?.listening ? 'fas fa-plug' : config && config.policy !== 'disabled' ? 'fas fa-exclamation-triangle' : 'fas fa-toggle-off'} />
              {config?.listening ? 'API ready' : config && config.policy !== 'disabled' ? 'Needs attention' : 'Off'}
            </span>
          </section>

          {error && (
            <div className="mod-integration-dialog__error" role="alert">
              <Icon name="fas fa-exclamation-triangle" />
              <span>{error}</span>
            </div>
          )}

          {loading ? (
            <div className="mod-integration-dialog__loading" role="status">
              <Icon name="fas fa-spinner fa-spin" />
              Loading integration settings…
            </div>
          ) : (
            <>
              <section className="mod-integration-dialog__section">
                <div className="mod-integration-dialog__section-heading">
                  <div>
                    <h4>Request policy</h4>
                    <p>This setting applies only to this game installation.</p>
                  </div>
                </div>
                <RadioGroup
                  className="mod-integration-policy-grid"
                  value={selectedPolicy}
                  onValueChange={(value) => {
                    policyDirty.current = true;
                    setSelectedPolicy(value as ModIntegrationPolicy);
                  }}
                  aria-label="Mod integration request policy"
                >
                  {policyOptions.map((option) => (
                    <label
                      key={option.value}
                      className={`mod-integration-policy${selectedPolicy === option.value ? ' mod-integration-policy--selected' : ''}`}
                    >
                      <RadioGroupItem value={option.value} />
                      <span>
                        <strong>{option.title}</strong>
                        <small>{option.description}</small>
                      </span>
                    </label>
                  ))}
                </RadioGroup>
                <div className="mod-integration-dialog__policy-actions">
                  <span>
                    Enabling or changing the policy rotates this installation’s private connection token.
                  </span>
                  <SimmButton
                    className="btn btn-primary"
                    onClick={() => void savePolicy()}
                    disabled={saving || selectedPolicy === config?.policy}
                  >
                    {saving ? <Icon name="fas fa-spinner fa-spin" /> : <Icon name="fas fa-shield-alt" />}
                    {saving ? 'Saving…' : 'Save policy'}
                  </SimmButton>
                </div>
              </section>

              {config && config.policy !== 'disabled' && (
                <section className="mod-integration-dialog__section mod-integration-dialog__connection">
                  <div className="mod-integration-dialog__section-heading">
                    <div>
                      <h4>Local connection</h4>
                      <p>Protocol v{config.protocolVersion}; connections from outside this computer are refused.</p>
                    </div>
                    <div className="mod-integration-dialog__port-editor">
                      <label htmlFor="mod-integration-port">
                        <span>Port</span>
                        <input
                          id="mod-integration-port"
                          type="number"
                          min="1"
                          max="65535"
                          step="1"
                          inputMode="numeric"
                          value={portDraft}
                          onChange={(event) => {
                            portDirty.current = true;
                            setPortDraft(event.target.value);
                          }}
                          aria-invalid={!portIsValid}
                        />
                      </label>
                      <SimmButton
                        variant="secondary"
                        className="btn btn-secondary btn-small"
                        onClick={() => void savePort()}
                        disabled={savingPort || !portIsValid || numericPort === config.port}
                      >
                        {savingPort ? <Icon name="fas fa-spinner fa-spin" /> : <Icon name="fas fa-save" />}
                        {savingPort ? 'Saving…' : 'Save port'}
                      </SimmButton>
                    </div>
                  </div>
                  {config.connectionError && (
                    <div className="mod-integration-dialog__connection-error" role="alert">
                      <Icon name="fas fa-exclamation-triangle" />
                      <span>{config.connectionError}</span>
                    </div>
                  )}
                  {config.bridgeConfigPath && (
                    <>
                      <div className="mod-integration-dialog__path" title={config.bridgeConfigPath}>
                        <Icon name="fas fa-file-alt" />
                        <span>{config.bridgeConfigPath}</span>
                      </div>
                      <p className="mod-integration-dialog__port-hint">
                        You can also change the numeric <code>port</code> in this bridge file. SIMM detects valid changes while it is running.
                      </p>
                    </>
                  )}
                </section>
              )}

              {pendingRequests.length > 0 && (
                <section className="mod-integration-dialog__section">
                  <div className="mod-integration-dialog__section-heading">
                    <div>
                      <h4>Needs your decision</h4>
                      <p>Update requests can be approved here. Local mods must be linked to a source you choose.</p>
                    </div>
                    <span className="badge badge-warning">{pendingRequests.length}</span>
                  </div>
                  <div className="mod-integration-request-list">
                    {pendingRequests.map((request) => (
                      <article key={request.id} className="mod-integration-request mod-integration-request--pending">
                        <div>
                          <strong>{request.modName}</strong>
                          <span>
                            {request.currentVersion || 'Unknown version'}
                            {request.targetVersion ? ` → ${request.targetVersion}` : ''}
                            {request.operation === 'requestManagement'
                              ? ` · ${request.modFileName}`
                              : request.source ? ` · ${request.source}` : ''}
                          </span>
                        </div>
                        <div className="mod-integration-request__actions">
                          <SimmButton
                            variant="secondary"
                            className="btn btn-secondary btn-small"
                            onClick={() => void resolveRequest(request.id, false)}
                            disabled={resolvingId === request.id}
                          >
                            Deny
                          </SimmButton>
                          {request.operation === 'requestManagement' ? (
                            <SimmButton
                              className="btn btn-primary btn-small"
                              onClick={() => onManageRequest?.(request)}
                              disabled={resolvingId === request.id || !onManageRequest}
                            >
                              Choose source
                            </SimmButton>
                          ) : (
                            <SimmButton
                              className="btn btn-primary btn-small"
                              onClick={() => void resolveRequest(request.id, true)}
                              disabled={resolvingId === request.id}
                            >
                              Approve
                            </SimmButton>
                          )}
                        </div>
                      </article>
                    ))}
                  </div>
                </section>
              )}

              <section className="mod-integration-dialog__section mod-integration-dialog__history">
                <div className="mod-integration-dialog__section-heading">
                  <div>
                    <h4>Recent requests</h4>
                    <p>Read-only update checks are not retained.</p>
                  </div>
                  {config && config.pendingRequestCount > 0 && (
                    <span className="badge badge-warning">{config.pendingRequestCount} pending</span>
                  )}
                </div>
                {requests.length === 0 ? (
                  <div className="mod-integration-dialog__empty">
                    <Icon name="fas fa-box-open" />
                    <span>No mod requests yet.</span>
                  </div>
                ) : (
                  <div className="mod-integration-history-list">
                    {requests.slice(0, 12).map((request) => (
                      <div key={request.id} className="mod-integration-history-row">
                        <div>
                          <strong>{request.modName}</strong>
                          <span>{request.message || request.modFileName}</span>
                        </div>
                        <span className={`integration-request-status integration-request-status--${requestStatusTone(request.status)}`}>
                          {requestStatusLabel(request.status)}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </section>
            </>
          )}
        </div>
      </SimmDialogContent>
    </Dialog>
  );
}
