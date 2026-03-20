import { useState, useEffect, useRef } from 'react';
import { useSettingsStore } from '../stores/settingsStore';
import { AuthenticationModal } from './AuthenticationModal';
import { ApiService } from '../services/api';

interface NexusOAuthStatus {
  connected: boolean;
  expiresAt?: number;
  account?: {
    name?: string;
    memberId?: number;
    isPremium?: boolean;
    isSupporter?: boolean;
    canDirectDownload?: boolean;
    requiresSiteConfirmation?: boolean;
  };
}

export function SteamAccountOverlay({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) {
  const { settings, refreshSettings } = useSettingsStore();
  const [showAuthModal, setShowAuthModal] = useState(false);
  const [releaseApiHealth, setReleaseApiHealth] = useState<Record<string, unknown> | null>(null);
  const [releaseApiError, setReleaseApiError] = useState<string | null>(null);
  const [checkingReleaseApi, setCheckingReleaseApi] = useState(false);
  const [nexusStatus, setNexusStatus] = useState<NexusOAuthStatus>({ connected: false });
  const [nexusBusy, setNexusBusy] = useState(false);
  const [nexusError, setNexusError] = useState<string | null>(null);
  const oauthTimeoutRef = useRef<number | null>(null);

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

  useEffect(() => {
    if (!isOpen) return;

    const loadNexusStatus = async () => {
      try {
        const status = await ApiService.getNexusOAuthStatus();
        setNexusStatus(status);
      } catch (err) {
        console.error('Failed to load Nexus OAuth status:', err);
        setNexusStatus({ connected: false });
      }
    };

    loadNexusStatus();
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

  useEffect(() => {
    return () => {
      if (oauthTimeoutRef.current) {
        window.clearTimeout(oauthTimeoutRef.current);
        oauthTimeoutRef.current = null;
      }
    };
  }, []);

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

  const tierLabel = !nexusStatus.connected
    ? 'Unauthenticated'
    : nexusStatus.account?.isPremium
      ? 'Premium'
      : nexusStatus.account?.isSupporter
        ? 'Supporter'
        : 'Free';

  const capabilityLabel = !nexusStatus.connected
    ? 'Nexus login required for downloads'
    : nexusStatus.account?.canDirectDownload
      ? 'Direct manager downloads'
      : 'Website confirmation required';

  const loadNexusStatus = async () => {
    const status = await ApiService.getNexusOAuthStatus();
    setNexusStatus(status);
  };

  const clearOAuthTimeout = () => {
    if (oauthTimeoutRef.current) {
      window.clearTimeout(oauthTimeoutRef.current);
      oauthTimeoutRef.current = null;
    }
  };

  const startOAuthTimeout = () => {
    clearOAuthTimeout();
    oauthTimeoutRef.current = window.setTimeout(() => {
      setNexusBusy(false);
      setNexusError('Nexus login timed out. Please try again.');
    }, 120000);
  };

  useEffect(() => {
    const handleOAuthResult = async (event: Event) => {
      const detail = (event as CustomEvent<{ success: boolean; error?: string }>).detail;
      clearOAuthTimeout();

      if (detail?.success) {
        try {
          await loadNexusStatus();
          setNexusError(null);
        } catch (error) {
          setNexusError(error instanceof Error ? error.message : 'Failed to refresh Nexus status');
        } finally {
          setNexusBusy(false);
        }
        return;
      }

      setNexusBusy(false);
      setNexusError(detail?.error || 'Failed to complete Nexus OAuth login');
    };

    window.addEventListener('nexus-oauth-result', handleOAuthResult as EventListener);
    return () => {
      window.removeEventListener('nexus-oauth-result', handleOAuthResult as EventListener);
    };
  }, []);

  const handleNexusLogin = async () => {
    setNexusBusy(true);
    setNexusError(null);
    try {
      await ApiService.beginNexusOAuthLogin(false);
      startOAuthTimeout();
    } catch (err) {
      clearOAuthTimeout();
      setNexusBusy(false);
      setNexusError(err instanceof Error ? err.message : 'Failed to start Nexus OAuth login');
    }
  };

  const handleNexusLogout = async () => {
    setNexusBusy(true);
    setNexusError(null);
    try {
      clearOAuthTimeout();
      await ApiService.logoutNexusOAuth();
      await loadNexusStatus();
    } catch (err) {
      setNexusError(err instanceof Error ? err.message : 'Failed to logout from Nexus OAuth');
    } finally {
      setNexusBusy(false);
    }
  };

  const handleAuthenticated = async () => {
    setShowAuthModal(false);
    await refreshSettings();
  };

  if (!isOpen) return null;

  return (
    <>
      <section
        className="modal-content steam-account-overlay workspace-panel"
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
            <h3 style={{ margin: '0 0 1rem 0', fontSize: '1rem', fontWeight: '600', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <i className="fab fa-github"></i>
              GitHub API Status
            </h3>

            <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', flexWrap: 'wrap' }}>
              <span
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '0.4rem',
                  padding: '0.28rem 0.6rem',
                  borderRadius: '999px',
                  fontSize: '0.78rem',
                  fontWeight: 600,
                  border: checkingReleaseApi ? '1px solid #2a4d7d' : releaseApiError ? '1px solid #5a2a2a' : '1px solid #2a5a2a',
                  backgroundColor: checkingReleaseApi ? '#1f2d46' : releaseApiError ? '#3a1a1a' : '#1a3a1a',
                  color: checkingReleaseApi ? '#9cc4ff' : releaseApiError ? '#ff9b9b' : '#9be2a6'
                }}
                title={releaseApiError || undefined}
              >
                <i className={checkingReleaseApi ? 'fas fa-spinner fa-spin' : releaseApiError ? 'fas fa-exclamation-circle' : 'fas fa-check-circle'}></i>
                {checkingReleaseApi ? 'Checking' : releaseApiError ? 'Offline' : 'Online'}
              </span>

              {releaseApiLastUpdated && !checkingReleaseApi && (
                <span style={{ color: '#9aa4b2', fontSize: '0.82rem' }}>
                  Last updated: {releaseApiLastUpdated}
                </span>
              )}
            </div>
          </div>

          <div style={{
            marginTop: '1.5rem',
            paddingTop: '1.5rem',
            borderTop: '1px solid #3a3a3a'
          }}>
            <h3 style={{ margin: '0 0 1rem 0', fontSize: '1rem', fontWeight: '600', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <i className="fas fa-download"></i>
              NexusMods Access
            </h3>

            <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', flexWrap: 'wrap', marginBottom: '0.9rem' }}>
              <span style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '0.4rem',
                padding: '0.28rem 0.6rem',
                borderRadius: '999px',
                fontSize: '0.78rem',
                fontWeight: 600,
                border: '1px solid #2a5a2a',
                backgroundColor: nexusStatus.connected ? '#1a3a1a' : '#3a1a1a',
                color: nexusStatus.connected ? '#9be2a6' : '#ff9b9b'
              }}>
                <i className={nexusStatus.connected ? 'fas fa-user-check' : 'fas fa-user-slash'}></i>
                {tierLabel}
              </span>
              <span style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '0.4rem',
                padding: '0.28rem 0.6rem',
                borderRadius: '999px',
                fontSize: '0.78rem',
                fontWeight: 600,
                border: '1px solid #3a3a3a',
                backgroundColor: '#1f232c',
                color: '#cbd5e1'
              }}>
                <i className={nexusStatus.account?.canDirectDownload ? 'fas fa-bolt' : 'fas fa-globe'}></i>
                {capabilityLabel}
              </span>
            </div>

            {nexusStatus.connected ? (
              <div style={{ padding: '0.75rem', backgroundColor: '#1a3a1a', borderRadius: '4px', border: '1px solid #2a5a2a', marginBottom: '1rem' }}>
                <div style={{ fontSize: '0.85rem', color: '#ccc', marginBottom: '0.65rem' }}>
                  <div><strong>User:</strong> {nexusStatus.account?.name || 'Connected'}</div>
                </div>
                <button onClick={handleNexusLogout} className="btn btn-secondary" disabled={nexusBusy} style={{ width: '100%' }}>
                  {nexusBusy ? 'Working...' : 'Logout from Nexus'}
                </button>
              </div>
            ) : (
              <button onClick={handleNexusLogin} className="btn btn-primary" disabled={nexusBusy} style={{ width: '100%' }}>
                {nexusBusy ? (
                  <>
                    <i className="fas fa-spinner fa-spin" style={{ marginRight: '0.5rem' }}></i>
                    Waiting for Nexus authorization...
                  </>
                ) : (
                  <>
                    <i className="fas fa-sign-in-alt" style={{ marginRight: '0.5rem' }}></i>
                    Login with Nexus
                  </>
                )}
              </button>
            )}

            {nexusError && (
              <div style={{
                color: '#ff6b6b',
                fontSize: '0.75rem',
                marginTop: '0.75rem',
                padding: '0.4rem 0.6rem',
                backgroundColor: '#3a1a1a',
                borderRadius: '4px'
              }}>
                {nexusError}
              </div>
            )}

            <p style={{ color: '#888', fontSize: '0.85rem', marginTop: '0.5rem', lineHeight: '1.4' }}>
              Nexus browsing/search works without login. Nexus login is required for downloads. Free accounts require website confirmation per download.
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
