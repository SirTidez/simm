import { useEffect, useRef, useState } from 'react';
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

    void loadNexusStatus();
  }, [isOpen]);

  useEffect(() => {
    return () => {
      if (oauthTimeoutRef.current) {
        window.clearTimeout(oauthTimeoutRef.current);
        oauthTimeoutRef.current = null;
      }
    };
  }, []);

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

  const steamConnected = Boolean(settings?.steamUsername);
  const steamIdentity = settings?.steamUsername || 'Steam not connected';
  const steamSummary = steamConnected
    ? 'Protected Steam branches are ready for depot access, and you can refresh the Steam session here whenever credentials or Steam Guard requirements change.'
    : 'No Steam account is connected yet. Authenticate with Steam here when SIMM needs access to protected branches or depot downloads.';
  const steamActionNote = steamConnected
    ? 'Refresh the stored Steam session if branch downloads start prompting again or Steam changes its approval requirements.'
    : 'SIMM only uses Steam credentials for protected branch authentication and stores them locally in encrypted form if you choose to remember them.';
  const nexusExpiry = nexusStatus.connected && nexusStatus.expiresAt
    ? new Date(nexusStatus.expiresAt * 1000).toLocaleString()
    : null;
  const nexusIdentity = nexusStatus.account?.name || 'Connected account';

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
        className="modal-content workspace-panel accounts-panel"
        aria-label="Account panel"
      >
        <div className="modal-header">
          <h2>Accounts</h2>
          <button className="modal-close" onClick={onClose} aria-label="Close accounts panel">×</button>
        </div>

        <div className="accounts-pane">
          <div className="accounts-overview">
            <div className="accounts-overview__copy">
              <span className="accounts-eyebrow">Connected Services</span>
              <h3>Manage Steam and Nexus access for protected downloads.</h3>
              <p>Keep account links healthy, verify what capabilities are available, and understand how SIMM stores credentials on this machine.</p>
            </div>
          </div>

          <section className="account-service-card">
            <div className="account-service-card__header">
              <div className="account-service-card__identity">
                <div className="account-service-card__icon">
                  <i className="fab fa-steam-symbol"></i>
                </div>
                <div>
                  <span className="accounts-eyebrow">Steam Account</span>
                  <h3>{steamIdentity}</h3>
                  <p>{steamSummary}</p>
                </div>
              </div>
            </div>

            <div className="account-inline-pills">
              <span className={`account-status-pill account-status-pill--${steamConnected ? 'connected' : 'disconnected'}`}>
                <i className={steamConnected ? 'fas fa-check-circle' : 'fas fa-exclamation-circle'}></i>
                {steamConnected ? 'Connected' : 'Not connected'}
              </span>
              <span className="account-capability-pill">
                <i className="fab fa-steam-symbol"></i>
                Protected branch access
              </span>
              <span className="account-capability-pill">
                <i className="fas fa-lock"></i>
                Encrypted local storage
              </span>
            </div>

            {!steamConnected && (
              <div className="account-disconnected-note">
                Authenticate here when SIMM needs protected Steam access. If Steam Guard prompts appear, approve them and SIMM will continue automatically.
              </div>
            )}

            <div className="account-service-card__actions">
              <button onClick={() => setShowAuthModal(true)} className="btn btn-primary">
                <i className={steamConnected ? 'fas fa-sync-alt' : 'fas fa-sign-in-alt'}></i>
                {steamConnected ? 'Refresh Steam Access' : 'Authenticate with Steam'}
              </button>
              <span className="account-action-note">{steamActionNote}</span>
            </div>
          </section>

          <section className="account-service-card">
            <div className="account-service-card__header">
              <div className="account-service-card__identity">
                <div className="account-service-card__icon">
                  <i className="fas fa-download"></i>
                </div>
                <div>
                  <span className="accounts-eyebrow">Nexus Mods</span>
                  <h3>{nexusStatus.connected ? nexusIdentity : 'Nexus not connected'}</h3>
                  <p>Nexus browsing works without signing in, but authenticated access unlocks manager downloads and premium features when the account allows them.</p>
                </div>
              </div>
            </div>

            <div className="account-inline-pills">
              <span className={`account-status-pill account-status-pill--${nexusStatus.connected ? 'connected' : 'disconnected'}`}>
                <i className={nexusStatus.connected ? 'fas fa-user-check' : 'fas fa-user-slash'}></i>
                {nexusStatus.connected ? 'Connected' : 'Disconnected'}
              </span>
              <span className="account-capability-pill">
                <i className="fas fa-id-badge"></i>
                {tierLabel}
              </span>
              <span className="account-capability-pill">
                <i className={nexusStatus.account?.canDirectDownload ? 'fas fa-bolt' : 'fas fa-globe'}></i>
                {capabilityLabel}
              </span>
              {typeof nexusStatus.account?.memberId === 'number' && (
                <span className="account-capability-pill">
                  <i className="fas fa-hashtag"></i>
                  Member {nexusStatus.account.memberId}
                </span>
              )}
              {nexusExpiry && (
                <span className="account-capability-pill">
                  <i className="fas fa-clock"></i>
                  Expires {nexusExpiry}
                </span>
              )}
            </div>

            {!nexusStatus.connected && (
              <div className="account-disconnected-note">
                You can still browse and search Nexus content without linking an account. Sign in here when you want manager downloads or need SIMM to handle the site authorization flow for you.
              </div>
            )}

            {nexusError && <div className="account-service-error">{nexusError}</div>}

            <div className="account-service-card__actions">
              {nexusStatus.connected ? (
                <button onClick={handleNexusLogout} className="btn btn-secondary" disabled={nexusBusy}>
                  <i className={nexusBusy ? 'fas fa-spinner fa-spin' : 'fas fa-sign-out-alt'}></i>
                  {nexusBusy ? 'Working...' : 'Logout from Nexus'}
                </button>
              ) : (
                <button onClick={handleNexusLogin} className="btn btn-primary" disabled={nexusBusy}>
                  <i className={nexusBusy ? 'fas fa-spinner fa-spin' : 'fas fa-sign-in-alt'}></i>
                  {nexusBusy ? 'Waiting for Nexus authorization...' : 'Login with Nexus'}
                </button>
              )}
              <span className="account-action-note">Free accounts confirm each download on the website. Premium accounts can use direct manager downloads when available.</span>
            </div>
          </section>

          <section className="account-note-card">
            <div className="account-note-card__icon">
              <i className="fas fa-shield-alt"></i>
            </div>
            <div className="account-note-card__content">
              <span className="accounts-eyebrow">Security & Storage</span>
              <h3>Credentials stay on this machine</h3>
              <p>SIMM stores linked-account credentials locally and encrypted. Steam credentials are only used for branch access, and Nexus tokens are only used for authenticated download flows.</p>
            </div>
          </section>
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
