import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { ApiService } from '../services/api';
import { useSettingsStore } from '../stores/settingsStore';

interface Props {
  isOpen: boolean;
  onClose: () => void;
  onAuthenticated: (credentials: { username: string; password: string; steamGuard: string; saveCredentials: boolean }) => void;
  required: boolean;
  waitingForAuth?: boolean;
  authMessage?: string;
  nested?: boolean;
}

export function AuthenticationModal({
  isOpen,
  onClose,
  onAuthenticated,
  required,
  waitingForAuth = false,
  authMessage,
  nested = false,
}: Props) {
  const { updateSettings } = useSettingsStore();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [steamGuard, setSteamGuard] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saveCredentials, setSaveCredentials] = useState(true);
  const isMountedRef = useRef(true);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setLoading(true);
    setError(null);

    try {
      const result = await ApiService.authenticate(username, password, steamGuard, saveCredentials);

      if (result.success) {
        if (saveCredentials && username && password) {
          await ApiService.saveCredentials(username, password);
          await updateSettings({ steamUsername: username });
        }

        onAuthenticated({
          username,
          password,
          steamGuard,
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
          setError(result.message || 'Authentication failed');
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

  const overlayClass = nested ? 'modal-overlay modal-overlay-nested' : 'modal-overlay';
  const contentClass = nested ? 'modal-content modal-content-nested auth-modal auth-modal--nested' : 'modal-content auth-modal';

  const modalElement = (
    <div className={overlayClass} onClick={required ? undefined : onClose}>
      <div
        className={`${contentClass} ${required ? 'auth-modal--required' : ''}`}
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Steam authentication dialog"
      >
        <div className="modal-header auth-modal__header">
          <div className="auth-modal__heading">
            <span className="settings-eyebrow">Steam Access</span>
            <h2>{waitingForAuth ? 'Waiting for Steam Approval' : 'Authenticate with Steam'}</h2>
            <p>
              {required
                ? 'Protected branch downloads need Steam authentication before SIMM can continue.'
                : 'Connect Steam when SIMM needs access to protected branches and depot downloads.'}
            </p>
          </div>
          {!required && (
            <button className="modal-close" onClick={onClose} aria-label="Close Steam authentication dialog">
              ×
            </button>
          )}
        </div>

        <div className="auth-modal__status-strip" aria-hidden={waitingForAuth}>
          <div className="auth-modal__status-pill">
            <i className="fas fa-shield-halved"></i>
            Protected branches
          </div>
          <div className="auth-modal__status-pill">
            <i className="fas fa-lock"></i>
            Stored locally
          </div>
          <div className="auth-modal__status-pill">
            <i className="fas fa-mobile-screen-button"></i>
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
                  <button type="button" className="btn btn-secondary" onClick={onClose}>
                    Close
                  </button>
                </div>
              )}
            </div>
          </div>
        ) : (
          <div className="auth-modal__body">
            <aside className="auth-modal__panel auth-modal__panel--intro">
              <div className="auth-modal__panel-copy">
                <span className="settings-eyebrow">Why SIMM needs this</span>
                <h3>Use Steam only when branch access requires it.</h3>
                <p>
                  SIMM uses Steam credentials only to authenticate protected depot access for branch downloads. This does not affect normal browsing or local workspace management.
                </p>
              </div>

              <div className="auth-modal__security-grid">
                <div className="auth-modal__security-card">
                  <span>Storage</span>
                  <strong>Encrypted locally</strong>
                </div>
                <div className="auth-modal__security-card">
                  <span>Use case</span>
                  <strong>Steam depot access</strong>
                </div>
                <div className="auth-modal__security-card">
                  <span>Approval</span>
                  <strong>Steam Guard if prompted</strong>
                </div>
              </div>

              <div className="settings-callout auth-modal__callout">
                <strong>What to expect</strong>
                <p>Enter your Steam account details, then approve the session in Steam if Guard prompts appear.</p>
              </div>
            </aside>

            <form className="auth-modal__panel auth-modal__panel--form" onSubmit={handleSubmit}>
              {error && <div className="error-message auth-modal__error-banner">{error}</div>}

              <div className="auth-modal__fields">
                <div className="form-group">
                  <label htmlFor="auth-steam-username">Steam Username</label>
                  <input
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
                  <input
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
                  <input
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

                <div className="settings-field auth-modal__preference">
                  <label className="settings-toggle">
                    <input
                      type="checkbox"
                      checked={saveCredentials}
                      onChange={(event) => setSaveCredentials(event.target.checked)}
                    />
                    <span className="settings-toggle__control"></span>
                    <span>
                      <strong>Remember credentials securely</strong>
                      <small>Store this Steam login locally in encrypted form for future protected downloads.</small>
                    </span>
                  </label>
                </div>
              </div>

              <div className="auth-modal__actions">
                {!required && (
                  <button type="button" onClick={onClose} className="btn btn-secondary">
                    Cancel
                  </button>
                )}
                <button type="submit" className="btn btn-primary" disabled={loading || !username || !password}>
                  <i className={loading ? 'fas fa-spinner fa-spin' : 'fas fa-right-to-bracket'}></i>
                  {loading ? 'Authenticating…' : 'Authenticate with Steam'}
                </button>
              </div>
            </form>
          </div>
        )}
      </div>
    </div>
  );

  if (typeof document === 'undefined' || !document.body) {
    return modalElement;
  }

  return createPortal(modalElement, document.body);
}
