import { useState, useEffect } from 'react';
import { useSettingsStore } from '../stores/settingsStore';
import { AuthenticationModal } from './AuthenticationModal';
import { ApiService } from '../services/api';

export function SteamAccountOverlay({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) {
  const { settings, refreshSettings } = useSettingsStore();
  const [showAuthModal, setShowAuthModal] = useState(false);
  const [nexusModsApiKeySet, setNexusModsApiKeySet] = useState(false);
  const [nexusModsUser, setNexusModsUser] = useState<{ name: string; isPremium: boolean; isSupporter: boolean } | null>(null);
  const [nexusModsRateLimits, setNexusModsRateLimits] = useState<{ daily: number; hourly: number } | null>(null);
  const [nexusModsApiKey, setNexusModsApiKey] = useState('');
  const [validatingNexusMods, setValidatingNexusMods] = useState(false);
  const [nexusModsError, setNexusModsError] = useState<string | null>(null);
  const [releaseApiHealth, setReleaseApiHealth] = useState<Record<string, unknown> | null>(null);
  const [releaseApiError, setReleaseApiError] = useState<string | null>(null);
  const [checkingReleaseApi, setCheckingReleaseApi] = useState(false);

  useEffect(() => {
    if (!isOpen) return;

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !showAuthModal) {
        onClose();
      }
    };

    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [isOpen, onClose, showAuthModal]);

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

  useEffect(() => {
    if (!isOpen) return;

    const loadReleaseApiHealth = async () => {
      setCheckingReleaseApi(true);
      setReleaseApiError(null);
      try {
        const health = await ApiService.getReleaseApiHealth();
        setReleaseApiHealth(health);
      } catch (err) {
        setReleaseApiHealth(null);
        setReleaseApiError(err instanceof Error ? err.message : 'Release API is unavailable');
      } finally {
        setCheckingReleaseApi(false);
      }
    };

    loadReleaseApiHealth();
  }, [isOpen]);

  const extractReleaseApiLastUpdated = (health: Record<string, unknown> | null): string | null => {
    if (!health) return null;

    const candidates = [
      health.lastUpdated,
      health.last_updated,
      health.updatedAt,
      health.updated_at,
      health.timestamp,
      (health as any).data?.lastUpdated,
      (health as any).data?.last_updated,
      (health as any).data?.updatedAt,
      (health as any).data?.updated_at,
    ];

    for (const candidate of candidates) {
      if (typeof candidate === 'string' && candidate.trim().length > 0) {
        const parsed = new Date(candidate);
        if (!Number.isNaN(parsed.getTime())) {
          return parsed.toLocaleString();
        }
        return candidate;
      }
    }

    return null;
  };

  const releaseApiLastUpdated = extractReleaseApiLastUpdated(releaseApiHealth);

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
      <section
        className="modal-content steam-account-overlay"
        style={{
          width: '100%',
          height: '100%',
          maxWidth: 'none',
          margin: 0,
          borderRadius: '0.75rem',
          display: 'flex',
          flexDirection: 'column'
        }}
        aria-label="Account panel"
      >
          <div className="modal-header">
            <h2>Accounts</h2>
            <button className="modal-close" onClick={onClose} aria-label="Close accounts panel">×</button>
          </div>

          <div className="steam-account-content" style={{ flex: 1, overflowY: 'auto' }}>
            {settings?.steamUsername ? (
              <div className="steam-account-info">
                <div className="steam-account-avatar">
                  <i className="fas fa-user-circle"></i>
                </div>
                <div className="steam-account-details">
                  <div className="steam-account-username">
                    <strong>Account:</strong>
                    <span>{settings.steamUsername}</span>
                  </div>
                  <div className="steam-account-status">
                    <i className="fas fa-check-circle" style={{ color: '#4caf50', marginRight: '0.5rem' }}></i>
                    <span>Connected</span>
                  </div>
                </div>
              </div>
            ) : (
              <div className="steam-account-not-authenticated">
                <i className="fas fa-exclamation-triangle" style={{ fontSize: '2rem', color: '#ffaa00', marginBottom: '1rem' }}></i>
                <p>No Steam account connected</p>
                <p style={{ color: '#888', fontSize: '0.9rem', marginTop: '0.5rem' }}>
                  Connect Steam to download protected branches.
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
                    Reconnect Steam
                  </>
                ) : (
                  <>
                    <i className="fas fa-sign-in-alt" style={{ marginRight: '0.5rem' }}></i>
                    Connect Steam
                  </>
                )}
              </button>
            </div>

            <div className="steam-account-note">
              <p>
                <i className="fas fa-info-circle" style={{ marginRight: '0.5rem', color: '#646cff' }}></i>
                Credentials are encrypted and kept local. They are only used for Steam branch access.
              </p>
            </div>

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
                <i className="fas fa-server"></i>
                LockWire Release API
              </h3>

              {checkingReleaseApi ? (
                <div style={{
                  padding: '0.75rem',
                  backgroundColor: '#1f2d46',
                  borderRadius: '4px',
                  border: '1px solid #2a4d7d'
                }}>
                  <i className="fas fa-spinner fa-spin" style={{ marginRight: '0.5rem' }}></i>
                  Checking API health...
                </div>
              ) : releaseApiError ? (
                <div style={{
                  padding: '0.75rem',
                  backgroundColor: '#3a1a1a',
                  borderRadius: '4px',
                  border: '1px solid #5a2a2a',
                  color: '#ff9b9b'
                }}>
                  <i className="fas fa-exclamation-circle" style={{ marginRight: '0.5rem' }}></i>
                  Release API unavailable: {releaseApiError}
                </div>
              ) : (
                <div style={{
                  padding: '0.75rem',
                  backgroundColor: '#1a3a1a',
                  borderRadius: '4px',
                  border: '1px solid #2a5a2a'
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                    <i className="fas fa-check-circle" style={{ color: '#4caf50' }}></i>
                    <span>Release API online</span>
                  </div>
                  {releaseApiLastUpdated && (
                    <div style={{ marginTop: '0.5rem', color: '#b8c4d9', fontSize: '0.85rem' }}>
                      Last updated: {releaseApiLastUpdated}
                    </div>
                  )}
                </div>
              )}
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
                NexusMods Access
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
                      <span>NexusMods API key is saved (encrypted)</span>
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
                           Save API Key
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
                Used for searching and downloading mods from NexusMods. Get your key from{' '}
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
      </section>

      {showAuthModal && (
        <AuthenticationModal
          isOpen={showAuthModal}
          onClose={() => setShowAuthModal(false)}
          onAuthenticated={handleAuthenticated}
          required={false}
          nested={true}
        />
      )}
    </>
  );
}
