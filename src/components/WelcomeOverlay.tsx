import React, { useState, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';

interface WelcomeOverlayProps {
  isOpen: boolean;
  onClose: () => void;
}

/**
 * Show a welcome modal that explains the created SIMM folder and displays its computed location.
 *
 * When the modal opens, the component attempts to detect the user's home directory and displays a normalized
 * SIMM path; if detection fails, it shows "your home directory\\SIMM".
 *
 * @param isOpen - Whether the modal is visible
 * @param onClose - Callback invoked to close the overlay
 * @returns The modal's JSX when visible, or `null` when not visible
 */
export function WelcomeOverlay({ isOpen, onClose }: WelcomeOverlayProps) {
  const [homePath, setHomePath] = useState<string>('');

  useEffect(() => {
    if (isOpen) {
      // Get home directory via Tauri command
      invoke<string>('get_home_directory')
        .then(setHomePath)
        .catch(() => setHomePath('your home directory'));
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const simmPath = homePath
    ? `${homePath.replace(/[\\/]*$/, '\\')}SIMM`
    : 'your home directory\\SIMM';

  return (
    <div className="modal-overlay" onClick={onClose} style={{ zIndex: 10002 }}>
      <div className="modal-content" onClick={(e) => e.stopPropagation()} style={{ maxWidth: '600px', zIndex: 10003 }}>
        <div className="modal-header">
          <h2>
            <i className="fas fa-folder-open" style={{ marginRight: '0.5rem' }}></i>
            Welcome to Schedule I Mod Manager
          </h2>
          <button className="modal-close" onClick={onClose}>×</button>
        </div>
        <div style={{ padding: '1.5rem' }}>
          <div
            style={{
              padding: '1rem',
              borderRadius: '4px',
              border: '1px solid rgba(59, 130, 246, 0.6)',
              backgroundColor: 'rgba(30, 58, 95, 0.6)',
              color: '#ffffff',
              marginBottom: '1.5rem'
            }}
          >
            <p style={{ margin: '0 0 1rem 0', lineHeight: '1.6' }}>
              We've created a <strong>SIMM</strong> folder in your home directory to help organize your modding files. 
              This folder will be used for downloads, backups, and application logs.
            </p>
            
            <div style={{ marginTop: '1.5rem' }}>
              <h3 style={{ margin: '0 0 0.75rem 0', fontSize: '1.1rem', color: '#ffffff' }}>
                <i className="fas fa-info-circle" style={{ marginRight: '0.5rem' }}></i>
                Folder Location
              </h3>
              <div
                style={{
                  padding: '0.75rem',
                  backgroundColor: 'rgba(0, 0, 0, 0.3)',
                  borderRadius: '4px',
                  fontFamily: 'monospace',
                  fontSize: '0.9rem',
                  wordBreak: 'break-all',
                  marginBottom: '1rem'
                }}
              >
                {simmPath}
              </div>
            </div>

            <div style={{ marginTop: '1.5rem' }}>
              <h3 style={{ margin: '0 0 0.75rem 0', fontSize: '1.1rem', color: '#ffffff' }}>
                <i className="fas fa-folder" style={{ marginRight: '0.5rem' }}></i>
                What's Inside
              </h3>
              <ul style={{ margin: '0', paddingLeft: '1.5rem', lineHeight: '1.8' }}>
                <li>
                  <strong>downloads/</strong> - Temporary files and game downloads
                </li>
                <li>
                  <strong>backups/</strong> - Mod backups and snapshots
                </li>
                <li>
                  <strong>logs/</strong> - Application logs and error reports
                </li>
              </ul>
            </div>

            <div style={{ marginTop: '1.5rem', padding: '0.75rem', backgroundColor: 'rgba(59, 130, 246, 0.2)', borderRadius: '4px' }}>
              <p style={{ margin: '0', fontSize: '0.9rem', fontStyle: 'italic' }}>
                <i className="fas fa-lightbulb" style={{ marginRight: '0.5rem' }}></i>
                <strong>Tip:</strong> You can change the default download directory in Settings if you prefer a different location.
              </p>
            </div>
          </div>
          <div style={{ display: 'flex', gap: '0.75rem', justifyContent: 'flex-end' }}>
            <button className="btn btn-primary" onClick={onClose}>
              Got it!
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
