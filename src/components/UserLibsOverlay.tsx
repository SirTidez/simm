import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent } from 'react';
import { open } from '@tauri-apps/plugin-dialog';

import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';

import { ApiService } from '../services/api';
import type { Environment } from '../types';
import { AnchoredContextMenu, type AnchoredContextMenuItem } from './AnchoredContextMenu';
import { ConfirmOverlay } from './ConfirmOverlay';
import { Icon } from './Icon';
import { ModThumbnail, type ModArtwork, type ModThumbnailSize } from './media/ModThumbnail';
import { useModArtwork } from './media/useModArtwork';
import { SimmButton } from './primitives';

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
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Library artwork when the file belongs to a known mod, otherwise a neutral type glyph in the same box. */
function AssetThumbnail({
  artwork,
  name,
  glyph,
  size,
}: {
  artwork: ModArtwork | null;
  name: string;
  glyph: string;
  size: ModThumbnailSize;
}) {
  if (artwork) return <ModThumbnail {...artwork} name={name} size={size} />;
  return (
    <span className="ui-thumb" style={{ '--ui-thumb-size': `${size}px` } as CSSProperties} aria-hidden="true">
      <Icon name={glyph} />
    </span>
  );
}

/** True when a click landed on a control inside a row (switch, button), not on the row itself. */
function isInteractiveTarget(target: EventTarget | null, row: HTMLElement): boolean {
  if (!(target instanceof Element)) return false;
  const control = target.closest('button, a, input, select, textarea, [role="switch"], [role="checkbox"]');
  return Boolean(control && row.contains(control));
}

export function UserLibsOverlay({ isOpen, environmentId, onUserLibsChanged }: Props) {
  const [userLibs, setUserLibs] = useState<UserLibInfo[]>([]);
  const lookupArtwork = useModArtwork();
  const userLibArtwork = (userLib: UserLibInfo) => lookupArtwork(userLib.fileName) ?? lookupArtwork(userLib.name);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [userLibsDirectory, setUserLibsDirectory] = useState('');
  const [environment, setEnvironment] = useState<Environment | null>(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedUserLibKey, setSelectedUserLibKey] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; items: AnchoredContextMenuItem[] } | null>(null);
  const [uploading, setUploading] = useState(false);
  const [deletingUserLibKey, setDeletingUserLibKey] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<UserLibInfo | null>(null);
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
      setPendingDelete(null);
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

  const handleDeleteUserLib = useCallback(async (userLib: UserLibInfo) => {
    const userLibKey = getUserLibKey(userLib);
    setDeletingUserLibKey(userLibKey);
    setError(null);

    try {
      await ApiService.deleteUserLib(environmentId, userLib.path);
      await loadUserLibs();
      onUserLibsChanged?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete UserLib');
    } finally {
      setDeletingUserLibKey(null);
      setPendingDelete(null);
    }
  }, [environmentId, loadUserLibs, onUserLibsChanged]);

  const handleUploadClick = useCallback(async () => {
    if (!environment) {
      setError('Environment not loaded');
      return;
    }

    setUploading(true);
    setError(null);

    try {
      const selected = await open({
        multiple: false,
        filters: [{
          name: 'UserLib Files',
          extensions: ['dll', 'zip'],
        }],
        title: 'Select UserLib File',
      }) as string | { path: string; name?: string } | null;

      if (!selected) {
        setUploading(false);
        return;
      }

      const filePath = typeof selected === 'string' ? selected : selected.path;
      const fileName = typeof selected === 'string'
        ? selected.split(/[/\\]/).pop() || 'unknown'
        : selected.name || selected.path.split(/[/\\]/).pop() || 'unknown';

      const result = await ApiService.uploadUserLib(
        environmentId,
        filePath,
        fileName,
        environment.runtime
      );

      if (!result.success) {
        setError(result.error || 'Failed to upload UserLib');
        return;
      }

      await loadUserLibs();
      onUserLibsChanged?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to upload UserLib');
    } finally {
      setUploading(false);
    }
  }, [environment, environmentId, loadUserLibs, onUserLibsChanged]);

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
          icon: userLib.disabled ? 'toggleOn' : 'toggleOff',
          onSelect: () => void handleToggleUserLib(userLib),
        },
        {
          key: 'open-folder',
          label: 'Open Folder',
          icon: 'folderOpen',
          onSelect: () => void handleOpenFolder(),
        },
        {
          key: 'delete',
          label: 'Delete',
          icon: 'trash',
          danger: true,
          onSelect: () => setPendingDelete(userLib),
        },
      ],
    });
  };

  if (!isOpen) return null;

  return (
    <>
      <ConfirmOverlay
        isOpen={!!pendingDelete}
        onClose={() => setPendingDelete(null)}
        onConfirm={() => {
          if (pendingDelete) {
            void handleDeleteUserLib(pendingDelete);
          }
        }}
        title="Delete UserLib"
        message={pendingDelete ? `Delete "${pendingDelete.name}" from this environment?` : ''}
        confirmText="Delete UserLib"
        cancelText="Cancel"
      />

      <div className={`env-assets ui-split${userLibs.length === 0 && !loading ? ' env-assets--solo' : ''}`}>
        <section className="env-assets__main" aria-label="UserLibs">
          <div className="env-assets__head">
            <div className="ui-toolbar env-assets__bar">
              <div className="env-assets-search">
                <Icon name="search" className="env-assets-search__icon" />
                <Input
                  type="search"
                  value={searchTerm}
                  onChange={(event) => setSearchTerm(event.target.value)}
                  placeholder="Search user libraries"
                  aria-label="Search user libraries"
                />
              </div>
              <SimmButton
                type="button"
                variant="ghost"
                size="icon"
                aria-label="Reload UserLibs"
                title="Reload UserLibs"
                onClick={() => void loadUserLibs()}
                disabled={loading}
              >
                <Icon name={loading ? 'fas fa-spinner fa-spin' : 'rotate'} />
              </SimmButton>
              <span className="ui-toolbar__spacer" />
              <div className="ui-toolbar__group env-assets__actions">
                <SimmButton type="button" variant="secondary" onClick={() => void handleOpenFolder()}>
                  <Icon name="folderOpen" />
                  Open Folder
                </SimmButton>
                <SimmButton type="button" variant="default" onClick={() => void handleUploadClick()} disabled={uploading}>
                  <Icon name={uploading ? 'fas fa-spinner fa-spin' : 'plus'} />
                  {uploading ? 'Adding...' : 'Add UserLib'}
                </SimmButton>
              </div>
            </div>
            {userLibsDirectory && (
              <p className="env-assets__summary ui-truncate" title={userLibsDirectory}>
                {userLibs.length} {userLibs.length === 1 ? 'library' : 'libraries'}
                {disabledCount > 0 ? ` · ${disabledCount} disabled` : ''}
                {' · '}
                <code className="ui-mono">{userLibsDirectory}</code>
              </p>
            )}
          </div>

          <div className="env-assets__content">
            {error && (
              <div className="env-assets__notices">
                <div className="ui-callout ui-callout--danger env-assets-error" role="alert">
                  <span className="env-assets-error__text">{error}</span>
                  <span className="ui-toolbar__group">
                    <SimmButton type="button" variant="outline" size="sm" onClick={() => void loadUserLibs()}>
                      Retry
                    </SimmButton>
                    <SimmButton type="button" variant="ghost" size="sm" onClick={() => setError(null)}>
                      Dismiss
                    </SimmButton>
                  </span>
                </div>
              </div>
            )}
            {loading && userLibs.length === 0 && (
              <div className="env-assets-skeleton" aria-busy="true" aria-label="Loading UserLibs">
                {Array.from({ length: 4 }, (_, index) => (
                  <div key={index} className="env-assets-skeleton__row">
                    <Skeleton className="env-assets-skeleton__icon" />
                    <div className="env-assets-skeleton__text">
                      <Skeleton className="env-assets-skeleton__line" />
                      <Skeleton className="env-assets-skeleton__line env-assets-skeleton__line--short" />
                    </div>
                  </div>
                ))}
              </div>
            )}
            {!error && !loading && userLibs.length === 0 && (
              <div className="ui-empty env-assets-empty">
                <span className="ui-empty__emblem" aria-hidden="true"><Icon name="book" /></span>
                <h3 className="ui-empty__title">No UserLibs in this environment</h3>
                <p className="ui-empty__copy">
                  UserLibs are shared libraries that mods and plugins depend on. MelonLoader loads them first.
                  Most arrive with the mods that need them; add one here only when a mod asks for it.
                </p>
                <div className="env-assets-empty__actions">
                  <SimmButton type="button" variant="secondary" onClick={() => void handleUploadClick()} disabled={uploading}>
                    {uploading ? 'Adding...' : 'Add UserLib File'}
                  </SimmButton>
                </div>
              </div>
            )}
            {!loading && userLibs.length > 0 && filteredUserLibs.length === 0 && (
              <div className="ui-empty env-assets-empty">
                <span className="ui-empty__emblem" aria-hidden="true"><Icon name="search" /></span>
                <h3 className="ui-empty__title">No UserLibs match</h3>
                <p className="ui-empty__copy">Nothing in this environment matches &quot;{searchTerm.trim()}&quot;.</p>
                <div className="env-assets-empty__actions">
                  <SimmButton type="button" variant="secondary" onClick={() => setSearchTerm('')}>
                    Clear Search
                  </SimmButton>
                </div>
              </div>
            )}
            {filteredUserLibs.length > 0 && (
              <table className="ui-table env-assets-table">
                <colgroup>
                  <col />
                  <col className="env-assets-table__col-type" />
                  <col className="env-assets-table__col-size" />
                  <col className="env-assets-table__col-status" />
                  <col className="env-assets-table__col-toggle" />
                </colgroup>
                <thead>
                  <tr>
                    <th scope="col">Name</th>
                    <th scope="col">Type</th>
                    <th scope="col" className="env-assets-table__num">Size</th>
                    <th scope="col">Status</th>
                    <th scope="col" className="env-assets-table__toggle">Enabled</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredUserLibs.map((userLib) => {
                    const userLibKey = getUserLibKey(userLib);
                    const isSelected = selectedUserLibKey === userLibKey;
                    return (
                      <tr
                        key={userLibKey}
                        className={`ui-row env-assets-row${userLib.disabled ? ' env-assets-row--disabled' : ''}`}
                        aria-selected={isSelected}
                        onClick={(event) => {
                          if (isInteractiveTarget(event.target, event.currentTarget)) return;
                          setSelectedUserLibKey(userLibKey);
                        }}
                        onContextMenu={(event) => openContextMenu(event, userLib)}
                      >
                        <td>
                          <button
                            type="button"
                            className="env-assets-row__open"
                            aria-pressed={isSelected}
                            onClick={() => setSelectedUserLibKey(userLibKey)}
                          >
                            <AssetThumbnail
                              artwork={userLibArtwork(userLib)}
                              name={userLib.name}
                              glyph={userLib.isDirectory ? 'folderTree' : 'book'}
                              size={32}
                            />
                            <span className="env-assets-row__text">
                              <span className="env-assets-row__name">{userLib.name}</span>
                              {userLib.fileName !== userLib.name && (
                                <span className="env-assets-row__desc">{userLib.fileName}</span>
                              )}
                            </span>
                          </button>
                        </td>
                        <td className="env-assets-row__muted">{userLib.isDirectory ? 'Folder' : 'File'}</td>
                        <td className="env-assets-row__muted env-assets-table__num">
                          {userLib.isDirectory && userLib.size === undefined ? '—' : formatFileSize(userLib.size)}
                        </td>
                        <td>{userLib.disabled && <span className="ui-tag">Disabled</span>}</td>
                        <td className="env-assets-table__toggle">
                          <Switch
                            checked={!userLib.disabled}
                            disabled={togglingUserLibKey === userLibKey}
                            aria-label={`${userLib.name} enabled`}
                            onCheckedChange={() => void handleToggleUserLib(userLib)}
                          />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        </section>

        <aside className="ui-inspector env-assets__inspector" aria-label="UserLib details">
          {!selectedUserLib && (
            <div className="ui-empty env-assets-empty env-assets-empty--inspector">
              <p className="ui-empty__copy">Select a user library to see its file details and actions.</p>
            </div>
          )}
          {selectedUserLib && (
            <>
              <div className="env-assets-inspector__head">
                <AssetThumbnail
                  artwork={userLibArtwork(selectedUserLib)}
                  name={selectedUserLib.name}
                  glyph={selectedUserLib.isDirectory ? 'folderTree' : 'book'}
                  size={48}
                />
                <div className="env-assets-inspector__titles">
                  <h3 className="env-assets-inspector__title">{selectedUserLib.name}</h3>
                  <div className="ui-meta">
                    <span>{selectedUserLib.isDirectory ? 'Folder' : 'File'}</span>
                    {selectedUserLib.size !== undefined && <span>{formatFileSize(selectedUserLib.size)}</span>}
                  </div>
                  <div className="env-assets-inspector__status">
                    {selectedUserLib.disabled
                      ? <span className="ui-tag">Disabled</span>
                      : <span className="ui-status ui-status--ok">Enabled</span>}
                  </div>
                </div>
              </div>

              <div className="env-assets-inspector__actions">
                <SimmButton
                  type="button"
                  variant={selectedUserLib.disabled ? 'secondary' : 'outline'}
                  onClick={() => void handleToggleUserLib(selectedUserLib)}
                  disabled={togglingUserLibKey === getUserLibKey(selectedUserLib)}
                >
                  <Icon name={selectedUserLib.disabled ? 'toggleOn' : 'toggleOff'} />
                  {selectedUserLib.disabled ? 'Enable' : 'Disable'}
                </SimmButton>
                <SimmButton type="button" variant="outline" onClick={() => void handleOpenFolder()}>
                  <Icon name="folderOpen" />
                  Open Folder
                </SimmButton>
              </div>

              <section className="ui-inspector__section">
                <h4 className="ui-section-title">Details</h4>
                <dl className="ui-kv">
                  <dt>Type</dt>
                  <dd>{selectedUserLib.isDirectory ? 'Folder' : 'File'}</dd>
                  <dt>Size</dt>
                  <dd>{formatFileSize(selectedUserLib.size)}</dd>
                  <dt>File</dt>
                  <dd className="ui-mono">{selectedUserLib.fileName}</dd>
                  <dt>Path</dt>
                  <dd className="ui-mono">{selectedUserLib.path}</dd>
                </dl>
              </section>

              <div className="ui-danger-zone env-assets-danger">
                <SimmButton
                  type="button"
                  variant="destructive"
                  onClick={() => setPendingDelete(selectedUserLib)}
                  disabled={deletingUserLibKey === getUserLibKey(selectedUserLib)}
                >
                  <Icon name="trash" />
                  Delete
                </SimmButton>
                <p className="env-assets-danger__note">
                  Deletes it from the UserLibs folder of {environment?.name || 'this environment'}. Mods that need it may stop loading.
                </p>
              </div>
            </>
          )}
        </aside>

        {contextMenu && (
          <AnchoredContextMenu
            x={contextMenu.x}
            y={contextMenu.y}
            items={contextMenu.items}
            onClose={() => setContextMenu(null)}
          />
        )}
      </div>
    </>
  );
}
