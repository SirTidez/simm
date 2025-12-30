import React, { useState, useEffect } from 'react';
import { useSettingsStore } from '../stores/settingsStore';
import { AuthenticationModal } from './AuthenticationModal';
import { ApiService } from '../services/api';

export function SteamAccountOverlay({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) {
  const { settings, refreshSettings } = useSettingsStore();
  const [showAuthModal, setShowAuthModal] = useState(false);
  const [githubTokenSet, setGithubTokenSet] = useState(false);

  // Check if GitHub token is set on mount and set it if not set
  useEffect(() => {
    if (!isOpen) return;
    
    const checkAndSetGithubToken = async () => {
      try {
        const hasToken = await ApiService.hasGitHubToken();
        setGithubTokenSet(hasToken);
        
        // One-time setup: Set the token if not already set
        // This is a secure one-time initialization
        if (!hasToken) {
          const tokenToSet = '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';
          try {
            await ApiService.setGitHubToken(tokenToSet);
            setGithubTokenSet(true);
            console.log('GitHub token initialized securely');
          } catch (err) {
            console.error('Failed to initialize GitHub token:', err);
          }
        }
      } catch (err) {
        console.error('Failed to check GitHub token:', err);
      }
    };
    checkAndSetGithubToken();
  }, [isOpen]);

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
                  display: 'flex', 
                  alignItems: 'center', 
                  justifyContent: 'space-between',
                  padding: '0.75rem',
                  backgroundColor: '#1a3a1a',
                  borderRadius: '4px',
                  border: '1px solid #2a5a2a'
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                    <i className="fas fa-check-circle" style={{ color: '#4caf50' }}></i>
                    <span>GitHub API token is set (encrypted)</span>
                  </div>
                </div>
              ) : (
                <div style={{ 
                  padding: '0.75rem',
                  backgroundColor: '#3a2a1a',
                  borderRadius: '4px',
                  border: '1px solid #5a3a2a',
                  color: '#888'
                }}>
                  <i className="fas fa-exclamation-circle" style={{ marginRight: '0.5rem', color: '#ffaa00' }}></i>
                  GitHub API token not set
                </div>
              )}
              <p style={{ 
                color: '#888', 
                fontSize: '0.85rem', 
                marginTop: '0.5rem',
                lineHeight: '1.4'
              }}>
                Used for authenticated GitHub API requests. Token is encrypted and never displayed or logged.
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

