import React, { useEffect, useRef, useState } from 'react';

import { ApiService } from '../services/api';
import { onSteamAuthQrLine } from '../services/events';
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Icon } from './Icon';
import { SimmButton, SimmDialogContent } from './primitives';

interface Props {
  isOpen: boolean;
  onClose: () => void;
  onAuthenticated: (credentials: { username: string; password: string; steamGuard: string; saveCredentials: boolean }) => void;
  required: boolean;
  initialMode?: AuthMode;
  waitingForAuth?: boolean;
  authMessage?: string;
  nested?: boolean;
}

type AuthMode = 'qr' | 'password';

const QR_REFRESH_MARKERS = [
  'Use the Steam Mobile App',
  'The QR code has changed',
];

function appendQrDisplayLine(currentLines: string[], line: string): string[] {
  if (QR_REFRESH_MARKERS.some((marker) => line.includes(marker))) {
    return [];
  }

  if (line.trim().length === 0) {
    return currentLines;
  }

  return [...currentLines, line].slice(-80);
}

function normalizeQrDisplayLines(lines: string[]): string[] {
  const nonEmptyLines = lines.filter((line) => line.trim().length > 0);
  if (nonEmptyLines.length === 0) return lines;

  const commonIndent = Math.min(
    ...nonEmptyLines.map((line) => line.match(/^\s*/)?.[0].length ?? 0)
  );

  return lines.map((line) => line.slice(commonIndent).trimEnd());
}

export function AuthenticationModal({
  isOpen,
  onClose,
  onAuthenticated,
  required,
  initialMode = 'qr',
  waitingForAuth = false,
  authMessage,
  nested = false,
}: Props) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [steamGuard, setSteamGuard] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [authMode, setAuthMode] = useState<AuthMode>(initialMode);
  const [qrLines, setQrLines] = useState<string[]>([]);
  const [qrListenerReady, setQrListenerReady] = useState(false);
  const [saveCredentials, setSaveCredentials] = useState(true);
  const isMountedRef = useRef(true);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!isOpen) return;
    setAuthMode(initialMode);
    setError(null);
    setQrLines([]);
    if (initialMode === 'qr') {
      setSaveCredentials(true);
    }
  }, [initialMode, isOpen]);

  useEffect(() => {
    if (!isOpen) {
      setQrListenerReady(false);
      return;
    }

    let disposed = false;
    let cleanupListener: (() => void) | null = null;
    setQrListenerReady(false);

    onSteamAuthQrLine((data) => {
      if (!isMountedRef.current) return;
      setQrLines((currentLines) => {
        return appendQrDisplayLine(currentLines, data.line);
      });
    }).then((cleanup) => {
      if (disposed) {
        cleanup();
      } else {
        cleanupListener = cleanup;
        setQrListenerReady(true);
      }
    }).catch((err) => {
      if (!disposed && isMountedRef.current) {
        setError(err instanceof Error ? err.message : 'Failed to prepare Steam QR listener');
      }
    });

    return () => {
      disposed = true;
      cleanupListener?.();
    };
  }, [isOpen]);

  const handleAuthModeChange = (mode: AuthMode) => {
    setAuthMode(mode);
    setError(null);
    if (mode === 'qr') {
      setSaveCredentials(true);
    }
  };

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setLoading(true);
    setError(null);
    if (authMode === 'qr') {
      setQrLines([]);
    }

    try {
      const result = authMode === 'qr'
        ? await ApiService.authenticateQr(saveCredentials)
        : await ApiService.authenticate(username, password, steamGuard.trim() || undefined, saveCredentials);

      if (result.success) {
        const authenticatedUsername = authMode === 'qr' ? result.username || '' : username;

        onAuthenticated({
          username: authenticatedUsername,
          password: authMode === 'password' ? password : '',
          steamGuard: authMode === 'password' ? steamGuard : '',
          saveCredentials,
        });
        if (isMountedRef.current) {
          setLoading(false);
        }
        onClose();
        return;
      }

      if (result.requiresSteamGuard) {
        if (isMountedRef.current) {
          setError('Steam Guard approval required. Approve the login in the Steam Mobile App, then SIMM will continue automatically.');
        }
      } else {
        if (isMountedRef.current) {
          setError(result.error || result.message || 'Authentication failed');
        }
      }
    } catch (err) {
      if (isMountedRef.current) {
        setError(err instanceof Error ? err.message : 'Authentication failed');
      }
    } finally {
      if (isMountedRef.current) {
        setLoading(false);
      }
    }
  };

  if (!isOpen) return null;

  const contentClass = nested ? 'auth-modal auth-modal--nested' : 'auth-modal';
  const submitDisabled = loading
    || (authMode === 'password' && (!username || !password))
    || (authMode === 'qr' && !qrListenerReady);
  const qrDisplayLines = normalizeQrDisplayLines(qrLines);
  const qrOutputClassName = typeof navigator !== 'undefined' && /Windows/i.test(navigator.userAgent)
    ? 'auth-modal__qr-output auth-modal__qr-output--windows'
    : 'auth-modal__qr-output';

  return (
    <Dialog open={isOpen} onOpenChange={(open) => {
      if (!open && !required) {
        onClose();
      }
    }}>
      <SimmDialogContent
        nested={nested}
        className={`${contentClass} ${required ? 'auth-modal--required' : ''}`}
        showCloseButton={false}
      >
        <DialogHeader className="modal-header auth-modal__header">
          <div className="auth-modal__heading">
            <span className="settings-eyebrow">Steam Access</span>
            <DialogTitle>{waitingForAuth ? 'Waiting for Steam Approval' : 'Authenticate with Steam'}</DialogTitle>
            <DialogDescription>
              {required
                ? 'Authenticate with Steam to authorize SIMM to manage your Schedule I game install.'
                : 'Connect Steam when SIMM needs authorization for advanced Schedule I installs.'}
            </DialogDescription>
          </div>
          {!required && (
            <SimmButton variant="ghost" size="icon-sm" className="modal-close" onClick={onClose} aria-label="Close Steam authentication dialog">
              ×
            </SimmButton>
          )}
        </DialogHeader>

        <div className="auth-modal__status-strip" aria-hidden={waitingForAuth}>
          <div className="auth-modal__status-pill">
            <Icon name="fas fa-shield-halved" />
            Steam authorization
          </div>
          <div className="auth-modal__status-pill">
            <Icon name="fas fa-lock" />
            Stored locally
          </div>
          <div className="auth-modal__status-pill">
            <Icon name="fas fa-mobile-screen-button" />
            Steam Guard may be required
          </div>
        </div>

        {waitingForAuth ? (
          <div className="auth-modal__waiting">
            <div className="auth-modal__waiting-card">
              <div className="auth-modal__spinner" aria-hidden="true"></div>
              <div className="auth-modal__waiting-copy">
                <h3>Approve the Steam login</h3>
                <p>{authMessage || 'Please approve the login request in the Steam Mobile App.'}</p>
                <p className="auth-modal__waiting-note">
                  The download will continue automatically as soon as Steam confirms the session.
                </p>
              </div>

              {error && <div className="error-message auth-modal__error-banner">{error}</div>}

              {!required && (
                <div className="auth-modal__actions auth-modal__actions--waiting">
                  <SimmButton type="button" className="btn btn-secondary" onClick={onClose}>
                    Close
                  </SimmButton>
                </div>
              )}
            </div>
          </div>
        ) : (
          <div className="auth-modal__body">
            <aside className="auth-modal__panel auth-modal__panel--intro">
              <div className="auth-modal__panel-copy">
                <span className="settings-eyebrow">Why SIMM needs this</span>
                <h3>Authorize SIMM for Schedule I install management.</h3>
                <p>
                  SIMM uses Steam credentials only when advanced Steam install actions need approval. This does not affect normal browsing or local workspace management.
                </p>
              </div>

              <div className="auth-modal__security-grid">
                <div className="auth-modal__security-card">
                  <span>Storage</span>
                  <strong>Encrypted locally</strong>
                </div>
                <div className="auth-modal__security-card">
                  <span>Use case</span>
                  <strong>Schedule I access</strong>
                </div>
                <div className="auth-modal__security-card">
                  <span>Approval</span>
                  <strong>Steam Guard if prompted</strong>
                </div>
              </div>

              <div className="settings-callout auth-modal__callout">
                <strong>What to expect</strong>
                <p>{authMode === 'qr'
                  ? 'Scan the QR code with the Steam Mobile App. SIMM stores the remembered DepotDownloader session name for future installs.'
                  : 'Enter your Steam account details, then approve the session in Steam if Guard prompts appear.'}</p>
              </div>
            </aside>

            <form className="auth-modal__panel auth-modal__panel--form" onSubmit={handleSubmit}>
              {error && <div className="error-message auth-modal__error-banner">{error}</div>}

              <div className="auth-modal__fields">
                <div className="auth-modal__mode-toggle" role="tablist" aria-label="Steam authentication method">
                  <button
                    type="button"
                    role="tab"
                    aria-selected={authMode === 'qr'}
                    className={authMode === 'qr' ? 'auth-modal__mode-button auth-modal__mode-button--active' : 'auth-modal__mode-button'}
                    onClick={() => handleAuthModeChange('qr')}
                    disabled={loading}
                  >
                    <Icon name="fas fa-mobile-screen-button" />
                    QR Code
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={authMode === 'password'}
                    className={authMode === 'password' ? 'auth-modal__mode-button auth-modal__mode-button--active' : 'auth-modal__mode-button'}
                    onClick={() => handleAuthModeChange('password')}
                    disabled={loading}
                  >
                    <Icon name="fas fa-lock" />
                    Password
                  </button>
                </div>

                {authMode === 'qr' ? (
                  <div className="auth-modal__qr-panel">
                    <div className="auth-modal__qr-header">
                      <Icon name="fas fa-mobile-screen-button" />
                      <div>
                        <strong>Steam Mobile QR login</strong>
                        <small>Start the QR session, then scan the code shown here with the Steam Mobile App.</small>
                      </div>
                    </div>
                    <pre className={qrOutputClassName} aria-live="polite" data-testid="steam-auth-qr-output">
                      {qrDisplayLines.length > 0
                        ? qrDisplayLines.join('\n')
                        : 'Select “Start QR Login” below to generate a QR code.'}
                    </pre>
                  </div>
                ) : (
                  <>
                    <div className="form-group">
                      <label htmlFor="auth-steam-username">Steam Username</label>
                      <Input
                        id="auth-steam-username"
                        type="text"
                        value={username}
                        onChange={(event) => setUsername(event.target.value)}
                        placeholder="Enter your Steam username"
                        required
                        autoComplete="username"
                      />
                    </div>

                    <div className="form-group">
                      <label htmlFor="auth-steam-password">Steam Password</label>
                      <Input
                        id="auth-steam-password"
                        type="password"
                        value={password}
                        onChange={(event) => setPassword(event.target.value)}
                        placeholder="Enter your Steam password"
                        required
                        autoComplete="current-password"
                      />
                    </div>

                    <div className="form-group">
                      <label htmlFor="auth-steam-guard">Steam Guard Code <span className="auth-modal__optional">Optional</span></label>
                      <Input
                        id="auth-steam-guard"
                        type="text"
                        value={steamGuard}
                        onChange={(event) => setSteamGuard(event.target.value)}
                        placeholder="Enter the Steam Guard code if Steam requests one"
                        maxLength={5}
                        autoComplete="one-time-code"
                      />
                      <small className="auth-modal__helper">Only required when Steam asks for a mobile or email verification code.</small>
                    </div>
                  </>
                )}

                <div className="settings-field auth-modal__preference">
                  <div
                    className="settings-toggle settings-toggle-button"
                    onClick={(event) => {
                      if (authMode === 'qr') return;
                      if ((event.target as HTMLElement).closest('[data-slot="switch"]')) return;
                      setSaveCredentials((checked) => !checked);
                    }}
                  >
                    <Switch
                      checked={saveCredentials}
                      onCheckedChange={setSaveCredentials}
                      disabled={authMode === 'qr'}
                      aria-label="Remember credentials securely"
                      className="settings-toggle__switch"
                    />
                    <span className="settings-toggle__copy">
                      <strong>{authMode === 'qr' ? 'Remember QR session' : 'Remember credentials securely'}</strong>
                      <small>{authMode === 'qr'
                        ? 'DepotDownloader stores the remembered session, and SIMM stores only the account name needed to reuse it.'
                        : 'Store this Steam login locally in encrypted form for future Steam authorization.'}</small>
                    </span>
                  </div>
                </div>
              </div>

              <div className="auth-modal__actions">
                {!required && (
                  <SimmButton type="button" onClick={onClose} className="btn btn-secondary">
                    Cancel
                  </SimmButton>
                )}
                <SimmButton type="submit" className="btn btn-primary" disabled={submitDisabled}>
                  <Icon name={loading ? 'fas fa-spinner fa-spin' : authMode === 'qr' ? 'fas fa-mobile-screen-button' : 'fas fa-right-to-bracket'} spin={loading} />
                  {loading ? 'Authenticating…' : authMode === 'qr' ? (qrListenerReady ? 'Start QR Login' : 'Preparing QR Login') : 'Authenticate with Steam'}
                </SimmButton>
              </div>
            </form>
          </div>
        )}
      </SimmDialogContent>
    </Dialog>
  );
}
