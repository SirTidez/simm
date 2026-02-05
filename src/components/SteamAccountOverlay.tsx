import React, { useState, useEffect } from 'react';
import { useSettingsStore } from '../stores/settingsStore';
import { AuthenticationModal } from './AuthenticationModal';
import { ApiService } from '../services/api';

export function SteamAccountOverlay({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) {
  const { settings, refreshSettings } = useSettingsStore();
  const [showAuthModal, setShowAuthModal] = useState(false);
  const [githubTokenSet, setGithubTokenSet] = useState(false);
  const [githubToken, setGithubToken] = useState('');
  const [validatingGithub, setValidatingGithub] = useState(false);
  const [githubError, setGithubError] = useState<string | null>(null);
  const [nexusModsApiKeySet, setNexusModsApiKeySet] = useState(false);
  const [nexusModsUser, setNexusModsUser] = useState<{ name: string; isPremium: boolean; isSupporter: boolean } | null>(null);
  const [nexusModsRateLimits, setNexusModsRateLimits] = useState<{ daily: number; hourly: number } | null>(null);
  const [nexusModsApiKey, setNexusModsApiKey] = useState('');
  const [validatingNexusMods, setValidatingNexusMods] = useState(false);
  const [nexusModsError, setNexusModsError] = useState<string | null>(null);

  // Check if GitHub token is set on mount
  useEffect(() => {
    if (!isOpen) return;

    const checkGithubToken = async () => {
      try {
        const hasToken = await ApiService.hasGitHubToken();
        setGithubTokenSet(hasToken);
      } catch (err) {
        console.error('Failed to check GitHub token:', err);
      }
    };
    checkGithubToken();
  }, [isOpen]);

  // Check NexusMods API key status on mount
  useEffect(() => {
    if (!isOpen) return;

    const checkNexusModsStatus = async () => {
      try {
        const hasKey = await ApiService.hasNexusModsApiKey();
        setNexusModsApiKeySet(hasKey);

        if (hasKey) {
          // Try to get rate limits to verify key is still valid
          try {
            const rateLimits = await ApiService.getNexusModsRateLimits();
            setNexusModsRateLimits(rateLimits);
          } catch (err) {
            console.error('Failed to get NexusMods rate limits:', err);
          }
        }
      } catch (err) {
        console.error('Failed to check NexusMods API key:', err);
      }
    };
    checkNexusModsStatus();
  }, [isOpen]);

  const handleValidateNexusModsApiKey = async () => {
    if (!nexusModsApiKey.trim()) {
      setNexusModsError('Please enter an API key');
      return;
    }

    setValidatingNexusMods(true);
    setNexusModsError(null);

    try {
      const result = await ApiService.validateNexusModsApiKey(nexusModsApiKey.trim());

      if (result.success) {
        setNexusModsApiKeySet(true);
        setNexusModsUser(result.user || null);
        setNexusModsRateLimits(result.rateLimits || null);
        setNexusModsApiKey(''); // Clear input
        await refreshSettings();
      } else {
        setNexusModsError(result.error || 'Failed to validate API key');
      }
    } catch (err) {
      setNexusModsError(err instanceof Error ? err.message : 'Failed to validate API key');
    } finally {
      setValidatingNexusMods(false);
    }
  };

  const handleValidateGithubToken = async () => {
    if (!githubToken.trim()) {
      setGithubError('Please enter a GitHub token');
      return;
    }

    setValidatingGithub(true);
    setGithubError(null);

    try {
      await ApiService.setGitHubToken(githubToken.trim());
      setGithubTokenSet(true);
      setGithubToken(''); // Clear input
      await refreshSettings();
    } catch (err) {
      setGithubError(err instanceof Error ? err.message : 'Failed to set GitHub token');
    } finally {
      setValidatingGithub(false);
    }
  };

  const handleRemoveGithubToken = async () => {
    if (!confirm('Are you sure you want to remove your GitHub token?')) {
      return;
    }

    try {
      await ApiService.removeGitHubToken();
      setGithubTokenSet(false);
      await refreshSettings();
    } catch (err) {
      console.error('Failed to remove GitHub token:', err);
    }
  };

  const handleRemoveNexusModsApiKey = async () => {
    if (!confirm('Are you sure you want to remove your NexusMods API key?')) {
      return;
    }

    try {
      await ApiService.removeNexusModsApiKey();
      setNexusModsApiKeySet(false);
      setNexusModsUser(null);
      setNexusModsRateLimits(null);
      await refreshSettings();
    } catch (err) {
      console.error('Failed to remove NexusMods API key:', err);
    }
  };

  const handleAuthenticated = async () => {
    setShowAuthModal(false);
    // Refresh settings to get updated steamUsername
    await refreshSettings();
  };

  if (!isOpen) return null;

  return (
    <>
      <div className="modal-overlay" onClick={onClose}>
        <div className="modal-content steam-account-overlay" onClick={(e) => e.stopPropagation()}>
          <div className="modal-header">
            <h2>Steam Account</h2>
            <button className="modal-close" onClick={onClose}>×</button>
          </div>

          <div className="steam-account-content">
            {settings?.steamUsername ? (
              <div className="steam-account-info">
                <div className="steam-account-avatar">
                  <i className="fas fa-user-circle"></i>
                </div>
                <div className="steam-account-details">
                  <div className="steam-account-username">
                    <strong>Username:</strong>
                    <span>{settings.steamUsername}</span>
                  </div>
                  <div className="steam-account-status">
                    <i className="fas fa-check-circle" style={{ color: '#4caf50', marginRight: '0.5rem' }}></i>
                    <span>Authenticated</span>
                  </div>
                </div>
              </div>
            ) : (
              <div className="steam-account-not-authenticated">
                <i className="fas fa-exclamation-triangle" style={{ fontSize: '2rem', color: '#ffaa00', marginBottom: '1rem' }}></i>
                <p>No Steam account authenticated</p>
                <p style={{ color: '#888', fontSize: '0.9rem', marginTop: '0.5rem' }}>
                  Authenticate with Steam to download game branches
                </p>
              </div>
            )}

            <div className="steam-account-actions">
              <button
                onClick={() => setShowAuthModal(true)}
                className="btn btn-primary"
                style={{ width: '100%' }}
              >
                {settings?.steamUsername ? (
                  <>
                    <i className="fas fa-sync-alt" style={{ marginRight: '0.5rem' }}></i>
                    Re-authenticate with Steam
                  </>
                ) : (
                  <>
                    <i className="fas fa-sign-in-alt" style={{ marginRight: '0.5rem' }}></i>
                    Authenticate with Steam
                  </>
                )}
              </button>
            </div>

            <div className="steam-account-note">
              <p>
                <i className="fas fa-info-circle" style={{ marginRight: '0.5rem', color: '#646cff' }}></i>
                Your credentials are encrypted and stored locally. They are only used to authenticate with Steam for downloading game branches.
              </p>
            </div>

            {/* GitHub Authentication Status */}
            <div style={{
              marginTop: '1.5rem',
              paddingTop: '1.5rem',
              borderTop: '1px solid #3a3a3a'
            }}>
              <h3 style={{
                margin: '0 0 1rem 0',
                fontSize: '1rem',
                fontWeight: '600',
                display: 'flex',
                alignItems: 'center',
                gap: '0.5rem'
              }}>
                <i className="fab fa-github"></i>
                GitHub Authentication
              </h3>
              {githubTokenSet ? (
                <div style={{
                  padding: '0.75rem',
                  backgroundColor: '#1a3a1a',
                  borderRadius: '4px',
                  border: '1px solid #2a5a2a',
                  marginBottom: '1rem'
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                      <i className="fas fa-check-circle" style={{ color: '#4caf50' }}></i>
                      <span>GitHub API token is set (encrypted)</span>
                    </div>
                    <button
                      onClick={handleRemoveGithubToken}
                      className="btn btn-secondary btn-small"
                      style={{ padding: '0.25rem 0.5rem', fontSize: '0.75rem' }}
                    >
                      <i className="fas fa-trash" style={{ marginRight: '0.25rem' }}></i>
                      Remove
                    </button>
                  </div>
                </div>
              ) : (
                <div>
                  <div style={{
                    padding: '0.75rem',
                    backgroundColor: '#3a2a1a',
                    borderRadius: '4px',
                    border: '1px solid #5a3a2a',
                    color: '#888',
                    marginBottom: '1rem'
                  }}>
                    <i className="fas fa-exclamation-circle" style={{ marginRight: '0.5rem', color: '#ffaa00' }}></i>
                    GitHub API token not set
                  </div>
                  <div style={{ marginBottom: '1rem' }}>
                    <input
                      type="password"
                      placeholder="Enter your GitHub Personal Access Token"
                      value={githubToken}
                      onChange={(e) => setGithubToken(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          handleValidateGithubToken();
                        }
                      }}
                      style={{
                        width: '100%',
                        padding: '0.5rem',
                        backgroundColor: '#1a1a1a',
                        border: '1px solid #3a3a3a',
                        borderRadius: '4px',
                        color: '#fff',
                        fontSize: '0.875rem',
                        marginBottom: '0.5rem'
                      }}
                      disabled={validatingGithub}
                    />
                    {githubError && (
                      <div style={{
                        color: '#ff6b6b',
                        fontSize: '0.75rem',
                        marginBottom: '0.5rem',
                        padding: '0.25rem 0.5rem',
                        backgroundColor: '#3a1a1a',
                        borderRadius: '4px'
                      }}>
                        {githubError}
                      </div>
                    )}
                    <button
                      onClick={handleValidateGithubToken}
                      className="btn btn-primary"
                      disabled={validatingGithub || !githubToken.trim()}
                      style={{ width: '100%' }}
                    >
                      {validatingGithub ? (
                        <>
                          <i className="fas fa-spinner fa-spin" style={{ marginRight: '0.5rem' }}></i>
                          Setting...
                        </>
                      ) : (
                        <>
                          <i className="fas fa-key" style={{ marginRight: '0.5rem' }}></i>
                          Set Token
                        </>
                      )}
                    </button>
                  </div>
                </div>
              )}
              <p style={{
                color: '#888',
                fontSize: '0.85rem',
                marginTop: '0.5rem',
                lineHeight: '1.4'
              }}>
                Used for authenticated GitHub API requests to fetch MelonLoader releases. Get your token from{' '}
                <a
                  href="https://github.com/settings/tokens"
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{ color: '#4a90e2', textDecoration: 'underline' }}
                >
                  GitHub Settings
                </a>
                . Token is encrypted and never displayed or logged.
              </p>
            </div>

            {/* NexusMods Authentication Status */}
            <div style={{
              marginTop: '1.5rem',
              paddingTop: '1.5rem',
              borderTop: '1px solid #3a3a3a'
            }}>
              <h3 style={{
                margin: '0 0 1rem 0',
                fontSize: '1rem',
                fontWeight: '600',
                display: 'flex',
                alignItems: 'center',
                gap: '0.5rem'
              }}>
                <i className="fas fa-download"></i>
                NexusMods Authentication
              </h3>
              {nexusModsApiKeySet ? (
                <div style={{
                  padding: '0.75rem',
                  backgroundColor: '#1a3a1a',
                  borderRadius: '4px',
                  border: '1px solid #2a5a2a',
                  marginBottom: '1rem'
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.5rem' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                      <i className="fas fa-check-circle" style={{ color: '#4caf50' }}></i>
                      <span>NexusMods API key is set (encrypted)</span>
                    </div>
                    <button
                      onClick={handleRemoveNexusModsApiKey}
                      className="btn btn-secondary btn-small"
                      style={{ padding: '0.25rem 0.5rem', fontSize: '0.75rem' }}
                    >
                      <i className="fas fa-trash" style={{ marginRight: '0.25rem' }}></i>
                      Remove
                    </button>
                  </div>
                  {nexusModsUser && (
                    <div style={{ fontSize: '0.85rem', color: '#ccc', marginTop: '0.5rem' }}>
                      <div><strong>User:</strong> {nexusModsUser.name}</div>
                      {nexusModsUser.isPremium && (
                        <div style={{ color: '#ffd700', marginTop: '0.25rem' }}>
                          <i className="fas fa-crown" style={{ marginRight: '0.25rem' }}></i>
                          Premium Member
                        </div>
                      )}
                      {nexusModsUser.isSupporter && (
                        <div style={{ color: '#4a90e2', marginTop: '0.25rem' }}>
                          <i className="fas fa-heart" style={{ marginRight: '0.25rem' }}></i>
                          Supporter
                        </div>
                      )}
                    </div>
                  )}
                  {nexusModsRateLimits && (
                    <div style={{ fontSize: '0.85rem', color: '#888', marginTop: '0.5rem' }}>
                      <div><strong>Rate Limits:</strong> Daily: {nexusModsRateLimits.daily}, Hourly: {nexusModsRateLimits.hourly}</div>
                    </div>
                  )}
                </div>
              ) : (
                <div>
                  <div style={{
                    padding: '0.75rem',
                    backgroundColor: '#3a2a1a',
                    borderRadius: '4px',
                    border: '1px solid #5a3a2a',
                    color: '#888',
                    marginBottom: '1rem'
                  }}>
                    <i className="fas fa-exclamation-circle" style={{ marginRight: '0.5rem', color: '#ffaa00' }}></i>
                    NexusMods API key not set
                  </div>
                  <div style={{ marginBottom: '1rem' }}>
                    <input
                      type="password"
                      placeholder="Enter your NexusMods API key"
                      value={nexusModsApiKey}
                      onChange={(e) => setNexusModsApiKey(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          handleValidateNexusModsApiKey();
                        }
                      }}
                      style={{
                        width: '100%',
                        padding: '0.5rem',
                        backgroundColor: '#1a1a1a',
                        border: '1px solid #3a3a3a',
                        borderRadius: '4px',
                        color: '#fff',
                        fontSize: '0.875rem',
                        marginBottom: '0.5rem'
                      }}
                      disabled={validatingNexusMods}
                    />
                    {nexusModsError && (
                      <div style={{
                        color: '#ff6b6b',
                        fontSize: '0.75rem',
                        marginBottom: '0.5rem',
                        padding: '0.25rem 0.5rem',
                        backgroundColor: '#3a1a1a',
                        borderRadius: '4px'
                      }}>
                        {nexusModsError}
                      </div>
                    )}
                    <button
                      onClick={handleValidateNexusModsApiKey}
                      className="btn btn-primary"
                      disabled={validatingNexusMods || !nexusModsApiKey.trim()}
                      style={{ width: '100%' }}
                    >
                      {validatingNexusMods ? (
                        <>
                          <i className="fas fa-spinner fa-spin" style={{ marginRight: '0.5rem' }}></i>
                          Validating...
                        </>
                      ) : (
                        <>
                          <i className="fas fa-key" style={{ marginRight: '0.5rem' }}></i>
                          Set API Key
                        </>
                      )}
                    </button>
                  </div>
                </div>
              )}
              <p style={{
                color: '#888',
                fontSize: '0.85rem',
                marginTop: '0.5rem',
                lineHeight: '1.4'
              }}>
                Used for searching and downloading mods from NexusMods. Get your API key from{' '}
                <a
                  href="https://www.nexusmods.com/users/myaccount?tab=api"
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{ color: '#4a90e2', textDecoration: 'underline' }}
                >
                  your NexusMods account page
                </a>
                . API key is encrypted and never displayed or logged.
              </p>
            </div>
          </div>
        </div>
      </div>

      {showAuthModal && (
        <AuthenticationModal
          isOpen={showAuthModal}
          onClose={() => setShowAuthModal(false)}
          onAuthenticated={handleAuthenticated}
          required={false}
        />
      )}
    </>
  );
}
