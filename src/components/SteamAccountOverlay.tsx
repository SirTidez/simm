import { useEffect, useRef, useState } from 'react';
import { useSettingsStore } from '../stores/settingsStore';
import { AuthenticationModal } from './AuthenticationModal';
import { ApiService } from '../services/api';
import { Icon } from './Icon';
import { SimmButton } from './primitives';

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

type SteamAuthMode = 'qr' | 'password';

const DATE_TIME_FORMAT = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
});

export function SteamAccountOverlay({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) {
  const { settings, refreshSettings } = useSettingsStore();
  const [showAuthModal, setShowAuthModal] = useState(false);
  const [steamAuthMode, setSteamAuthMode] = useState<SteamAuthMode>('qr');
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

  const tierLabel = nexusStatus.account?.isPremium
    ? 'Premium'
    : nexusStatus.account?.isSupporter
      ? 'Supporter'
      : 'Free';

  const capabilityLabel = nexusStatus.account?.canDirectDownload
    ? 'Direct downloads in SIMM'
    : 'Confirm each download on the website';

  const steamConnected = Boolean(settings?.steamUsername);
  const nexusExpiry = nexusStatus.connected && nexusStatus.expiresAt
    ? DATE_TIME_FORMAT.format(new Date(nexusStatus.expiresAt * 1000))
    : null;
  const nexusIdentity = nexusStatus.account?.name || 'Connected account';
  // One primary action per surface: the first service that still needs a sign-in.
  const primaryService: 'steam' | 'nexus' | null = !steamConnected
    ? 'steam'
    : !nexusStatus.connected
      ? 'nexus'
      : null;

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

  const openSteamAuth = (mode: SteamAuthMode) => {
    setSteamAuthMode(mode);
    setShowAuthModal(true);
  };

  if (!isOpen) return null;

  return (
    <>
      <section
        className="workspace-panel ui-page accounts-page"
        aria-label="Account panel"
      >
        <header className="ui-page-header">
          <div className="ui-page-header__titles">
            <h2 className="ui-page-title">Accounts</h2>
            <p className="ui-page-subtitle">Sign-ins SIMM uses for Steam branch installs and Nexus Mods downloads.</p>
          </div>
        </header>

        <div className="ui-page-body">
          <div className="accounts-list">
            <section className="account-service" aria-labelledby="account-service-steam">
              <div className="account-service__icon" aria-hidden="true">
                <Icon name="steamSymbol" />
              </div>
              <div className="account-service__main">
                <div className="account-service__title">
                  <h3 id="account-service-steam">Steam</h3>
                  <span className={`ui-status ${steamConnected ? 'ui-status--ok' : 'ui-status--muted'}`}>
                    {steamConnected ? 'Connected' : 'Not connected'}
                  </span>
                </div>
                {steamConnected && (
                  <div className="ui-meta account-service__meta">
                    <span>Signed in as <strong>{settings?.steamUsername}</strong></span>
                  </div>
                )}
                <p className="account-service__purpose">
                  Only needed for Steam branch installs that SIMM downloads itself. Your normal Steam install works without it.
                </p>
              </div>
              <div className="account-service__actions">
                <SimmButton
                  onClick={() => openSteamAuth('qr')}
                  variant={primaryService === 'steam' ? 'default' : 'outline'}
                >
                  <Icon name="mobileScreenButton" />
                  {steamConnected ? 'Refresh with QR Login' : 'Login with Steam QR'}
                </SimmButton>
                <SimmButton onClick={() => openSteamAuth('password')} variant="ghost">
                  Password Login
                </SimmButton>
              </div>
            </section>

            <section className="account-service" aria-labelledby="account-service-nexus">
              <div className="account-service__icon" aria-hidden="true">
                <Icon name="download" />
              </div>
              <div className="account-service__main">
                <div className="account-service__title">
                  <h3 id="account-service-nexus">Nexus Mods</h3>
                  <span className={`ui-status ${nexusStatus.connected ? 'ui-status--ok' : 'ui-status--muted'}`}>
                    {nexusStatus.connected ? 'Connected' : 'Not connected'}
                  </span>
                </div>
                {nexusStatus.connected && (
                  <div className="ui-meta account-service__meta">
                    <strong>{nexusIdentity}</strong>
                    <span>{tierLabel}</span>
                    <span>{capabilityLabel}</span>
                  </div>
                )}
                {nexusStatus.connected && (typeof nexusStatus.account?.memberId === 'number' || nexusExpiry) && (
                  <div className="ui-meta account-service__meta">
                    {typeof nexusStatus.account?.memberId === 'number' && (
                      <span>Member {nexusStatus.account.memberId}</span>
                    )}
                    {nexusExpiry && <span>Session expires {nexusExpiry}</span>}
                  </div>
                )}
                <p className="account-service__purpose">
                  Needed to download from Nexus Mods. Browsing and search work without signing in.
                </p>
                {nexusError && (
                  <div className="ui-callout ui-callout--danger account-service__error" role="alert">
                    {nexusError}
                  </div>
                )}
              </div>
              <div className="account-service__actions">
                {nexusStatus.connected ? (
                  <SimmButton onClick={handleNexusLogout} variant="outline" disabled={nexusBusy}>
                    {nexusBusy && <Icon name="spinner" spin />}
                    {nexusBusy ? 'Working...' : 'Logout from Nexus'}
                  </SimmButton>
                ) : (
                  <SimmButton
                    onClick={handleNexusLogin}
                    variant={primaryService === 'nexus' ? 'default' : 'outline'}
                    disabled={nexusBusy}
                  >
                    {nexusBusy && <Icon name="spinner" spin />}
                    {nexusBusy ? 'Waiting for Nexus authorization...' : 'Login with Nexus'}
                  </SimmButton>
                )}
              </div>
            </section>

            <p className="accounts-note">
              <Icon name="lock" />
              <span>
                Credentials and tokens stay on this device, encrypted. Steam QR sign-in keeps only the account name; DepotDownloader holds the session.
              </span>
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
          initialMode={steamAuthMode}
          nested={true}
        />
      )}
    </>
  );
}
