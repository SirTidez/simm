import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';

import { ApiService } from '../services/api';
import type { Environment } from '../types';
import { AnchoredContextMenu, type AnchoredContextMenuItem } from './AnchoredContextMenu';

interface UserLibInfo {
  name: string;
  fileName: string;
  path: string;
  size?: number;
  isDirectory: boolean;
  disabled?: boolean;
}

interface Props {
  isOpen: boolean;
  onClose: () => void;
  environmentId: string;
  onUserLibsChanged?: () => void;
}

function getUserLibKey(userLib: UserLibInfo): string {
  return `${userLib.fileName}::${userLib.path}`;
}

function formatFileSize(bytes?: number): string {
  if (bytes === undefined) return 'Unknown';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(2)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export function UserLibsOverlay({ isOpen, onClose, environmentId, onUserLibsChanged }: Props) {
  const [userLibs, setUserLibs] = useState<UserLibInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [userLibsDirectory, setUserLibsDirectory] = useState('');
  const [environment, setEnvironment] = useState<Environment | null>(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedUserLibKey, setSelectedUserLibKey] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; items: AnchoredContextMenuItem[] } | null>(null);
  const [togglingUserLibKey, setTogglingUserLibKey] = useState<string | null>(null);
  const loadRequestTokenRef = useRef(0);

  const loadEnvironment = useCallback(async (requestToken = loadRequestTokenRef.current) => {
    try {
      const env = await ApiService.getEnvironment(environmentId);
      if (requestToken !== loadRequestTokenRef.current) return;
      setEnvironment(env);
    } catch (err) {
      if (requestToken !== loadRequestTokenRef.current) return;
      console.error('Failed to load environment:', err);
    }
  }, [environmentId]);

  const loadUserLibs = useCallback(async (requestToken = loadRequestTokenRef.current) => {
    setLoading(true);
    setError(null);

    try {
      const result = await ApiService.getUserLibs(environmentId);
      if (requestToken !== loadRequestTokenRef.current) return;
      setUserLibs(result.userLibs);
      setUserLibsDirectory(result.userLibsDirectory);
    } catch (err) {
      if (requestToken !== loadRequestTokenRef.current) return;
      setUserLibs([]);
      setError(err instanceof Error ? err.message : 'Failed to load UserLibs');
    } finally {
      if (requestToken === loadRequestTokenRef.current) {
        setLoading(false);
      }
    }
  }, [environmentId]);

  useEffect(() => {
    if (!isOpen || !environmentId) {
      loadRequestTokenRef.current += 1;
      setUserLibs([]);
      setError(null);
      setUserLibsDirectory('');
      setEnvironment(null);
      setSearchTerm('');
      setSelectedUserLibKey(null);
      setContextMenu(null);
      return;
    }

    const requestToken = loadRequestTokenRef.current + 1;
    loadRequestTokenRef.current = requestToken;
    void loadEnvironment(requestToken);
    void loadUserLibs(requestToken);
  }, [environmentId, isOpen, loadEnvironment, loadUserLibs]);

  const filteredUserLibs = useMemo(() => {
    const normalizedQuery = searchTerm.trim().toLowerCase();
    if (!normalizedQuery) {
      return userLibs;
    }

    return userLibs.filter((userLib) => (
      userLib.name.toLowerCase().includes(normalizedQuery)
      || userLib.fileName.toLowerCase().includes(normalizedQuery)
      || userLib.path.toLowerCase().includes(normalizedQuery)
      || (userLib.isDirectory ? 'directory' : 'file').includes(normalizedQuery)
    ));
  }, [searchTerm, userLibs]);

  useEffect(() => {
    if (filteredUserLibs.length === 0) {
      setSelectedUserLibKey(null);
      return;
    }

    if (!selectedUserLibKey || !filteredUserLibs.some((userLib) => getUserLibKey(userLib) === selectedUserLibKey)) {
      setSelectedUserLibKey(getUserLibKey(filteredUserLibs[0]));
    }
  }, [filteredUserLibs, selectedUserLibKey]);

  const selectedUserLib = useMemo(() => (
    filteredUserLibs.find((userLib) => getUserLibKey(userLib) === selectedUserLibKey)
      || userLibs.find((userLib) => getUserLibKey(userLib) === selectedUserLibKey)
      || null
  ), [filteredUserLibs, selectedUserLibKey, userLibs]);

  const disabledCount = userLibs.filter((userLib) => userLib.disabled).length;

  const handleOpenFolder = async () => {
    try {
      await ApiService.openUserLibsFolder(environmentId);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to open UserLibs folder');
    }
  };

  const handleToggleUserLib = useCallback(async (userLib: UserLibInfo) => {
    const userLibKey = getUserLibKey(userLib);
    setTogglingUserLibKey(userLibKey);
    setError(null);

    try {
      if (userLib.disabled) {
        await ApiService.enableUserLib(environmentId, userLib.path);
      } else {
        await ApiService.disableUserLib(environmentId, userLib.path);
      }

      await loadUserLibs();
      onUserLibsChanged?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : `Failed to ${userLib.disabled ? 'enable' : 'disable'} UserLib`);
    } finally {
      setTogglingUserLibKey(null);
    }
  }, [environmentId, loadUserLibs, onUserLibsChanged]);

  const openContextMenu = (event: ReactMouseEvent, userLib: UserLibInfo) => {
    event.preventDefault();
    setSelectedUserLibKey(getUserLibKey(userLib));
    setContextMenu({
      x: event.clientX,
      y: event.clientY,
      items: [
        {
          key: userLib.disabled ? 'enable' : 'disable',
          label: userLib.disabled ? 'Enable' : 'Disable',
          icon: userLib.disabled ? 'fas fa-toggle-on' : 'fas fa-toggle-off',
          onSelect: () => void handleToggleUserLib(userLib),
        },
        {
          key: 'open-folder',
          label: 'Open Folder',
          icon: 'fas fa-folder-open',
          onSelect: () => void handleOpenFolder(),
        },
        {
          key: 'reload',
          label: 'Reload',
          icon: 'fas fa-rotate',
          onSelect: () => void loadUserLibs(),
        },
      ],
    });
  };

  if (!isOpen) return null;

  return (
    <div className="mods-overlay workspace-collection-shell">
      <div className="modal-header">
        <h2>User Libraries</h2>
      </div>

      <div className="workspace-collection">
        <div className="workspace-collection__main">
          <div className="workspace-collection__header">
            <div className="workspace-collection__nav">
              <div className="workspace-collection__toolbar-group workspace-collection__toolbar-group--summary">
                <strong>{environment?.name || 'Environment'}</strong>
                <span>{environment?.runtime || 'Unknown'} • Runtime support libraries</span>
              </div>

              <div className="workspace-collection__summary">
                <div className="workspace-collection__summary-chip">
                  <span>UserLibs</span>
                  <strong>{userLibs.length}</strong>
                </div>
                <div className="workspace-collection__summary-chip">
                  <span>Disabled</span>
                  <strong>{disabledCount}</strong>
                </div>
                <div className="workspace-collection__summary-chip">
                  <span>Folder</span>
                  <strong>{userLibsDirectory ? 'Ready' : 'Unavailable'}</strong>
                </div>
              </div>
            </div>

            <div className="workspace-collection__toolbar">
              <div className="workspace-collection__toolbar-search">
                <input
                  type="text"
                  value={searchTerm}
                  onChange={(event) => setSearchTerm(event.target.value)}
                  placeholder="Search user libraries"
                />
              </div>
              <div className="workspace-collection__toolbar-group">
                <button type="button" className="btn btn-secondary btn-small" onClick={() => void handleOpenFolder()}>
                  Open Folder
                </button>
                <button type="button" className="btn btn-secondary btn-small" onClick={() => void loadUserLibs()} disabled={loading}>
                  Reload
                </button>
              </div>
            </div>

            {userLibsDirectory && (
              <div className="workspace-collection__toolbar-group workspace-collection__toolbar-group--path">
                <span className="workspace-collection__path-label">UserLibs Directory</span>
                <code className="workspace-collection__path-value">{userLibsDirectory}</code>
              </div>
            )}
          </div>

          <div className="workspace-collection__content">
            {error && <div className="workspace-collection__empty workspace-collection__empty--error">{error}</div>}
            {!error && loading && <div className="workspace-collection__empty">Loading user libraries...</div>}
            {!error && !loading && userLibs.length === 0 && (
              <div className="workspace-collection__empty">No user libraries found for this environment.</div>
            )}
            {!error && !loading && userLibs.length > 0 && filteredUserLibs.length === 0 && (
              <div className="workspace-collection__empty">No user libraries match this search.</div>
            )}
            {!error && !loading && filteredUserLibs.length > 0 && (
              <div className="workspace-collection__list">
                {filteredUserLibs.map((userLib) => {
                  const userLibKey = getUserLibKey(userLib);
                  const isSelected = selectedUserLibKey === userLibKey;
                  return (
                    <div
                      key={userLibKey}
                      className={`workspace-collection__row workspace-file-row ${isSelected ? 'workspace-collection__row--selected' : ''}`}
                      role="button"
                      tabIndex={0}
                      onClick={() => setSelectedUserLibKey(userLibKey)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault();
                          setSelectedUserLibKey(userLibKey);
                        }
                      }}
                      onContextMenu={(event) => openContextMenu(event, userLib)}
                    >
                      <div className="workspace-file-row__icon">
                        <i className={userLib.isDirectory ? 'fas fa-folder-tree' : 'fas fa-file-code'} aria-hidden="true"></i>
                      </div>
                      <div className="workspace-collection__row-body">
                        <div className="workspace-collection__row-title">{userLib.name}</div>
                        <div className="workspace-collection__row-meta">
                          {userLib.disabled ? (
                            <span className="workspace-pill workspace-pill--danger">Disabled</span>
                          ) : (
                            <span className="workspace-pill workspace-pill--success">Enabled</span>
                          )}
                          <span className="workspace-pill">{userLib.isDirectory ? 'Directory' : 'File'}</span>
                          <span className="workspace-pill">{formatFileSize(userLib.size)}</span>
                        </div>
                        <p className="workspace-collection__row-summary">{userLib.fileName}</p>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        <aside className="workspace-collection__inspector">
          {!selectedUserLib && (
            <div className="workspace-collection__inspector-empty">
              Select a user library to review its role and environment actions.
            </div>
          )}
          {selectedUserLib && (
            <div className="workspace-inspector-card">
              <div className="workspace-inspector-card__header workspace-inspector-card__header--file">
                <div className="workspace-file-row__icon workspace-file-row__icon--large">
                  <i className={selectedUserLib.isDirectory ? 'fas fa-folder-tree' : 'fas fa-file-code'} aria-hidden="true"></i>
                </div>
                <div>
                  <h3>{selectedUserLib.name}</h3>
                  <div className="workspace-inspector-card__subtle">
                    {selectedUserLib.isDirectory ? 'Directory' : 'File'} • {formatFileSize(selectedUserLib.size)}
                  </div>
                </div>
              </div>

              <div className="workspace-inspector-card__metrics">
                <div><span>Status</span><strong>{selectedUserLib.disabled ? 'Disabled' : 'Enabled'}</strong></div>
                <div><span>Type</span><strong>{selectedUserLib.isDirectory ? 'Directory' : 'File'}</strong></div>
                <div><span>Size</span><strong>{formatFileSize(selectedUserLib.size)}</strong></div>
              </div>

              <div className="workspace-inspector-card__field">
                <label>File Name</label>
                <div className="workspace-inspector-card__value">{selectedUserLib.fileName}</div>
              </div>

              <div className="workspace-inspector-card__field">
                <label>Path</label>
                <div className="workspace-inspector-card__value workspace-inspector-card__value--path">{selectedUserLib.path}</div>
              </div>

              <div className="workspace-inspector-card__actions">
                <button
                  className={selectedUserLib.disabled ? 'btn btn-primary' : 'btn btn-secondary'}
                  onClick={() => void handleToggleUserLib(selectedUserLib)}
                  disabled={togglingUserLibKey === getUserLibKey(selectedUserLib)}
                >
                  {selectedUserLib.disabled ? 'Enable' : 'Disable'}
                </button>
                <button className="btn btn-secondary" onClick={() => void handleOpenFolder()}>
                  Open Folder
                </button>
                <button className="btn btn-secondary" onClick={() => void loadUserLibs()} disabled={loading}>
                  Reload
                </button>
              </div>
            </div>
          )}
        </aside>
      </div>

      {contextMenu && (
        <AnchoredContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          items={contextMenu.items}
          onClose={() => setContextMenu(null)}
        />
      )}
    </div>
  );
}
