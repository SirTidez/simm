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
import { Checkbox } from '@/components/ui/checkbox';
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
            <DialogTitle>{waitingForAuth ? 'Waiting for Steam Approval' : 'Authenticate with Steam'}</DialogTitle>
            <DialogDescription>
              {required
                ? 'SIMM needs Steam authorization to manage this Schedule I install.'
                : 'Only needed for Steam branch installs that SIMM downloads itself.'}
            </DialogDescription>
          </div>
          {!required && (
            <SimmButton variant="ghost" size="icon-sm" className="modal-close" onClick={onClose} aria-label="Close Steam authentication dialog">
              <Icon name="times" />
            </SimmButton>
          )}
        </DialogHeader>

        {waitingForAuth ? (
          <div className="auth-modal__waiting">
            <div className="auth-modal__spinner" aria-hidden="true"></div>
            <div className="auth-modal__waiting-copy">
              <h3>Approve the Steam login</h3>
              <p>{authMessage || 'Please approve the login request in the Steam Mobile App.'}</p>
              <p className="auth-modal__muted">
                The download continues automatically as soon as Steam confirms the session.
              </p>
            </div>

            {error && <div className="ui-callout ui-callout--danger auth-modal__error" role="alert">{error}</div>}

            {!required && (
              <div className="auth-modal__actions">
                <SimmButton type="button" variant="outline" onClick={onClose}>
                  Close
                </SimmButton>
              </div>
            )}
          </div>
        ) : (
          <form className="auth-modal__form" onSubmit={handleSubmit}>
            <div className="ui-tabs-line auth-modal__tabs" role="tablist" aria-label="Steam authentication method">
              <button
                type="button"
                role="tab"
                aria-selected={authMode === 'qr'}
                className="ui-tabs-line__tab"
                onClick={() => handleAuthModeChange('qr')}
                disabled={loading}
              >
                <Icon name="mobileScreenButton" />
                QR Code
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={authMode === 'password'}
                className="ui-tabs-line__tab"
                onClick={() => handleAuthModeChange('password')}
                disabled={loading}
              >
                <Icon name="lock" />
                Password
              </button>
            </div>

            <div className="auth-modal__body">
              <p className="auth-modal__expect">
                {authMode === 'qr'
                  ? 'Start the QR login, then scan the code below with the Steam Mobile App.'
                  : 'Enter your Steam account details. If Steam Guard asks for approval, confirm it in the Steam Mobile App or enter the code below.'}
              </p>

              {error && <div className="ui-callout ui-callout--danger auth-modal__error" role="alert">{error}</div>}

              {authMode === 'qr' ? (
                <pre className={qrOutputClassName} aria-live="polite" data-testid="steam-auth-qr-output">
                  {qrDisplayLines.length > 0
                    ? qrDisplayLines.join('\n')
                    : 'Select “Start QR Login” below to generate a QR code.'}
                </pre>
              ) : (
                <div className="auth-modal__fields">
                  <div className="auth-modal__field">
                    <label htmlFor="auth-steam-username">Steam username</label>
                    <Input
                      id="auth-steam-username"
                      type="text"
                      value={username}
                      onChange={(event) => setUsername(event.target.value)}
                      required
                      autoComplete="username"
                    />
                  </div>

                  <div className="auth-modal__field">
                    <label htmlFor="auth-steam-password">Steam password</label>
                    <Input
                      id="auth-steam-password"
                      type="password"
                      value={password}
                      onChange={(event) => setPassword(event.target.value)}
                      required
                      autoComplete="current-password"
                    />
                  </div>

                  <div className="auth-modal__field">
                    <label htmlFor="auth-steam-guard">Steam Guard code <span className="auth-modal__optional">(optional)</span></label>
                    <Input
                      id="auth-steam-guard"
                      type="text"
                      value={steamGuard}
                      onChange={(event) => setSteamGuard(event.target.value)}
                      placeholder="Only if Steam asks for one"
                      maxLength={5}
                      autoComplete="one-time-code"
                    />
                  </div>
                </div>
              )}

              {authMode === 'qr' ? (
                <p className="auth-modal__note">
                  <Icon name="lock" />
                  <span>SIMM keeps only your Steam account name. DepotDownloader remembers the session for future installs.</span>
                </p>
              ) : (
                <label className="auth-modal__remember">
                  <Checkbox
                    checked={saveCredentials}
                    onCheckedChange={(checked) => setSaveCredentials(checked === true)}
                    aria-label="Remember credentials securely"
                  />
                  <span className="auth-modal__remember-copy">
                    <span>Remember credentials securely</span>
                    <small>Stored encrypted on this device for future Steam authorization.</small>
                  </span>
                </label>
              )}
            </div>

            <div className="auth-modal__actions">
              {!required && (
                <SimmButton type="button" variant="outline" onClick={onClose}>
                  Cancel
                </SimmButton>
              )}
              <SimmButton type="submit" disabled={submitDisabled}>
                {loading && <Icon name="spinner" spin />}
                {loading ? 'Authenticating…' : authMode === 'qr' ? (qrListenerReady ? 'Start QR Login' : 'Preparing QR Login') : 'Authenticate with Steam'}
              </SimmButton>
            </div>
          </form>
        )}
      </SimmDialogContent>
    </Dialog>
  );
}
