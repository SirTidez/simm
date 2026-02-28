import React, { useState } from 'react';
import { ApiService } from '../services/api';
import { useSettingsStore } from '../stores/settingsStore';

interface Props {
  isOpen: boolean;
  onClose: () => void;
  onAuthenticated: (credentials: { username: string; password: string; steamGuard: string; saveCredentials: boolean }) => void;
  required: boolean;
  waitingForAuth?: boolean;
  authMessage?: string;
  isNested?: boolean;
}

export function AuthenticationModal({
  isOpen,
  onClose,
  onAuthenticated,
  required,
  waitingForAuth = false,
  authMessage,
  isNested = false,
}: Props) {
  const { updateSettings } = useSettingsStore();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [steamGuard, setSteamGuard] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saveCredentials, setSaveCredentials] = useState(true);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);

    try {
      // Authenticate with Steam using DepotDownloader (separate authentication step)
      // This stores the session via -remember-password for future downloads
      const result = await ApiService.authenticate(username, password, steamGuard, saveCredentials);
      
      if (result.success) {
        // Save credentials (encrypted) if requested
        if (saveCredentials && username && password) {
          await ApiService.saveCredentials(username, password);
          await updateSettings({ steamUsername: username });
        }

        // Pass credentials to parent component
        onAuthenticated({
          username,
          password,
          steamGuard,
          saveCredentials
        });
        onClose();
      } else {
        if (result.requiresSteamGuard) {
          setError('Steam Guard approval required. Please approve the login on your Steam Mobile App.');
          setLoading(false);
        } else {
          setError(result.message || 'Authentication failed');
          setLoading(false);
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Authentication failed');
      setLoading(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div
      className={`modal-overlay${isNested ? ' modal-overlay-nested' : ''}`}
      onClick={required ? undefined : onClose}
    >
      <div
        className={`modal-content${isNested ? ' modal-content-nested' : ''}`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <h2>Steam Authentication Required</h2>
          {!required && (
            <button className="modal-close" onClick={onClose}>×</button>
          )}
        </div>

        {waitingForAuth ? (
          <div className="auth-waiting">
            <div className="loading-spinner" style={{ margin: '2rem auto', width: '48px', height: '48px', border: '4px solid #3a3a3a', borderTop: '4px solid #646cff', borderRadius: '50%', animation: 'spin 1s linear infinite' }}></div>
            <h3 style={{ textAlign: 'center', marginTop: '1rem' }}>Waiting for Steam Authentication</h3>
            <p style={{ textAlign: 'center', color: '#cccccc', marginTop: '0.5rem' }}>
              {authMessage || 'Please approve the login request on your Steam Mobile App'}
            </p>
            <p style={{ textAlign: 'center', fontSize: '0.9rem', color: '#888', marginTop: '1rem' }}>
              The download will start automatically once you approve the login.
            </p>
            {error && <div className="error-message" style={{ marginTop: '1rem' }}>{error}</div>}
          </div>
        ) : (
          <form onSubmit={handleSubmit}>
            {error && <div className="error-message">{error}</div>}

          <div className="form-group">
            <label>Steam Username</label>
            <input
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="Your Steam username"
              required
              autoComplete="username"
            />
          </div>

          <div className="form-group">
            <label>Steam Password</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Your Steam password"
              required
              autoComplete="current-password"
            />
          </div>

          <div className="form-group">
            <label>Steam Guard Code (if required)</label>
            <input
              type="text"
              value={steamGuard}
              onChange={(e) => setSteamGuard(e.target.value)}
              placeholder="Enter 2FA code from Steam Mobile App"
              maxLength={5}
            />
            <small>Leave blank if you don't have Steam Guard enabled</small>
          </div>

          <div className="form-group">
            <label>
              <input
                type="checkbox"
                checked={saveCredentials}
                onChange={(e) => setSaveCredentials(e.target.checked)}
              />
              Save credentials securely (encrypted)
            </label>
          </div>

          <div className="modal-actions">
            {!required && (
              <button type="button" onClick={onClose} className="btn btn-secondary">
                Cancel
              </button>
            )}
            <button type="submit" className="btn btn-primary" disabled={loading || !username || !password}>
              {loading ? 'Authenticating...' : 'Authenticate'}
            </button>
          </div>

          <div className="info-box" style={{ marginTop: '1rem', fontSize: '0.9rem' }}>
            <p><strong>Note:</strong> Your credentials are encrypted and stored locally. They are only used to authenticate with Steam for downloading game branches.</p>
          </div>
        </form>
        )}
      </div>
    </div>
  );
}
