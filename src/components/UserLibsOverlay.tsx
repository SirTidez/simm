import React, { useState, useEffect } from 'react';
import { ApiService } from '../services/api';

interface UserLibInfo {
  name: string;
  fileName: string;
  path: string;
  size?: number;
  isDirectory: boolean;
}

interface Props {
  isOpen: boolean;
  onClose: () => void;
  environmentId: string;
  onUserLibsChanged?: () => void;
}

export function UserLibsOverlay({ isOpen, onClose, environmentId, onUserLibsChanged }: Props) {
  const [userLibs, setUserLibs] = useState<UserLibInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [userLibsDirectory, setUserLibsDirectory] = useState<string>('');

  useEffect(() => {
    if (isOpen && environmentId) {
      loadUserLibs();
    } else {
      // Reset state when closing
      setUserLibs([]);
      setError(null);
      setUserLibsDirectory('');
    }
  }, [isOpen, environmentId]);

  const loadUserLibs = async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await ApiService.getUserLibs(environmentId);
      setUserLibs(result.userLibs);
      setUserLibsDirectory(result.userLibsDirectory);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load UserLibs');
      setUserLibs([]);
    } finally {
      setLoading(false);
    }
  };

  const handleOpenFolder = async () => {
    try {
      await ApiService.openUserLibsFolder(environmentId);
    } catch (err) {
      alert(`Failed to open UserLibs folder: ${err instanceof Error ? err.message : 'Unknown error'}`);
    }
  };

  const formatFileSize = (bytes?: number): string => {
    if (!bytes) return '';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(2)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  };

  if (!isOpen) return null;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content mods-overlay" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>UserLibs</h2>
          <button className="modal-close" onClick={onClose}>×</button>
        </div>

        <div className="mods-content">
          {error && (
            <div className="error-message" style={{ margin: '0 1.25rem', padding: '0.75rem', backgroundColor: '#dc3545', color: '#fff', borderRadius: '4px' }}>
              {error}
            </div>
          )}

          <div className="mods-actions" style={{ padding: '0 1.25rem', marginBottom: '1rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '1rem' }}>
            <div style={{ flex: 1 }}>
              {userLibsDirectory && (
                <p style={{ margin: 0, color: '#888', fontSize: '0.875rem' }}>
                  <i className="fas fa-folder" style={{ marginRight: '0.5rem' }}></i>
                  {userLibsDirectory}
                </p>
              )}
            </div>
            <div style={{ display: 'flex', gap: '0.5rem' }}>
              <button
                onClick={handleOpenFolder}
                className="btn btn-secondary"
                title="Open UserLibs folder in file explorer"
              >
                <i className="fas fa-folder-open" style={{ marginRight: '0.5rem' }}></i>
                Open Folder
              </button>
            </div>
          </div>

          {loading ? (
            <div style={{ padding: '2rem', textAlign: 'center', color: '#888' }}>
              <i className="fas fa-spinner fa-spin" style={{ fontSize: '2rem', marginBottom: '1rem' }}></i>
              <p>Loading UserLibs...</p>
            </div>
          ) : userLibs.length === 0 ? (
            <div style={{ padding: '2rem', textAlign: 'center', color: '#888' }}>
              <i className="fas fa-box-open" style={{ fontSize: '2rem', marginBottom: '1rem' }}></i>
              <p>No UserLibs found</p>
              <p style={{ fontSize: '0.875rem', marginTop: '0.5rem' }}>
                UserLibs are extracted from mod archives and placed in the UserLibs directory
              </p>
            </div>
          ) : (
            <div style={{ padding: '0 1.25rem 1.25rem', maxHeight: '500px', overflowY: 'auto' }}>
              <div style={{ display: 'grid', gap: '1rem' }}>
                {userLibs.map((userLib) => (
                  <div
                    key={userLib.fileName}
                    className="mod-card"
                    style={{
                      backgroundColor: '#2a2a2a',
                      border: '1px solid #3a3a3a',
                      borderRadius: '8px',
                      padding: '1rem',
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center'
                    }}
                  >
                    <div style={{ flex: 1 }}>
                      <h3 style={{ margin: 0, marginBottom: '0.5rem', fontSize: '1.1rem', color: '#fff', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                        {userLib.isDirectory ? (
                          <i className="fas fa-folder" style={{ color: '#ffa500' }}></i>
                        ) : (
                          <i className="fas fa-file" style={{ color: '#888' }}></i>
                        )}
                        {userLib.name}
                      </h3>
                      <div style={{ display: 'flex', gap: '1rem', alignItems: 'center', fontSize: '0.875rem', color: '#888', flexWrap: 'wrap' }}>
                        <span>
                          <i className="fas fa-file-code" style={{ marginRight: '0.25rem' }}></i>
                          {userLib.fileName}
                        </span>
                        {userLib.size !== undefined && (
                          <span>
                            <i className="fas fa-weight" style={{ marginRight: '0.25rem' }}></i>
                            {formatFileSize(userLib.size)}
                          </span>
                        )}
                        {userLib.isDirectory && (
                          <span style={{ 
                            display: 'inline-flex', 
                            alignItems: 'center', 
                            padding: '0.25rem 0.5rem', 
                            borderRadius: '4px', 
                            backgroundColor: '#ffa50020',
                            color: '#ffa500',
                            border: '1px solid #ffa50040'
                          }}>
                            <i className="fas fa-folder" style={{ marginRight: '0.25rem', fontSize: '0.75rem' }}></i>
                            Directory
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

