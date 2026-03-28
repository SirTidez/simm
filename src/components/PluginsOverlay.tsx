import { useEffect, useMemo, useState, type MouseEvent as ReactMouseEvent } from 'react';
import { open } from '@tauri-apps/plugin-dialog';

import { ApiService } from '../services/api';
import type { Environment } from '../types';
import { AnchoredContextMenu, type AnchoredContextMenuItem } from './AnchoredContextMenu';
import { ConfirmOverlay } from './ConfirmOverlay';

interface PluginInfo {
  name: string;
  fileName: string;
  path: string;
  version?: string;
  source?: 'local' | 'thunderstore' | 'nexusmods' | 'github' | 'unknown';
  relatedMod?: string;
  disabled?: boolean;
}

interface Props {
  isOpen: boolean;
  onClose: () => void;
  environmentId: string;
  onPluginsChanged?: () => void;
}

function getPluginKey(plugin: PluginInfo): string {
  return `${plugin.fileName}::${plugin.path}`;
}

function getPluginSourceLabel(source?: PluginInfo['source']): string {
  switch (source) {
    case 'thunderstore':
      return 'Thunderstore';
    case 'nexusmods':
      return 'Nexus Mods';
    case 'github':
      return 'GitHub';
    case 'local':
      return 'Local';
    default:
      return 'Unknown';
  }
}

export function PluginsOverlay({ isOpen, onClose, environmentId, onPluginsChanged }: Props) {
  const [plugins, setPlugins] = useState<PluginInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pluginsDirectory, setPluginsDirectory] = useState('');
  const [environment, setEnvironment] = useState<Environment | null>(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedPluginKey, setSelectedPluginKey] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; items: AnchoredContextMenuItem[] } | null>(null);
  const [uploading, setUploading] = useState(false);
  const [deletingPluginKey, setDeletingPluginKey] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<PluginInfo | null>(null);
  const [pendingUpload, setPendingUpload] = useState<{
    runtimeMismatch: {
      detected: 'IL2CPP' | 'Mono' | 'unknown';
      environment: 'IL2CPP' | 'Mono';
      warning: string;
    };
  } | null>(null);
  const [togglingPluginKey, setTogglingPluginKey] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen || !environmentId) {
      setPlugins([]);
      setPluginsDirectory('');
      setEnvironment(null);
      setError(null);
      setSearchTerm('');
      setSelectedPluginKey(null);
      setContextMenu(null);
      setPendingDelete(null);
      return;
    }

    void loadEnvironment();
    void loadPlugins();
  }, [environmentId, isOpen]);

  const loadEnvironment = async () => {
    try {
      const env = await ApiService.getEnvironment(environmentId);
      setEnvironment(env);
    } catch (err) {
      console.error('Failed to load environment:', err);
    }
  };

  const loadPlugins = async () => {
    setLoading(true);
    setError(null);

    try {
      const result = await ApiService.getPlugins(environmentId);
      setPlugins(result.plugins.map((plugin) => ({
        ...plugin,
        source: plugin.source as PluginInfo['source'],
      })));
      setPluginsDirectory(result.pluginsDirectory);
    } catch (err) {
      setPlugins([]);
      setError(err instanceof Error ? err.message : 'Failed to load plugins');
    } finally {
      setLoading(false);
    }
  };

  const filteredPlugins = useMemo(() => {
    const normalizedQuery = searchTerm.trim().toLowerCase();
    if (!normalizedQuery) {
      return plugins;
    }

    return plugins.filter((plugin) => (
      plugin.name.toLowerCase().includes(normalizedQuery)
      || plugin.fileName.toLowerCase().includes(normalizedQuery)
      || plugin.path.toLowerCase().includes(normalizedQuery)
      || getPluginSourceLabel(plugin.source).toLowerCase().includes(normalizedQuery)
      || (plugin.relatedMod || '').toLowerCase().includes(normalizedQuery)
      || (plugin.version || '').toLowerCase().includes(normalizedQuery)
    ));
  }, [plugins, searchTerm]);

  useEffect(() => {
    if (filteredPlugins.length === 0) {
      setSelectedPluginKey(null);
      return;
    }

    if (!selectedPluginKey || !filteredPlugins.some((plugin) => getPluginKey(plugin) === selectedPluginKey)) {
      setSelectedPluginKey(getPluginKey(filteredPlugins[0]));
    }
  }, [filteredPlugins, selectedPluginKey]);

  const selectedPlugin = useMemo(() => (
    filteredPlugins.find((plugin) => getPluginKey(plugin) === selectedPluginKey)
      || plugins.find((plugin) => getPluginKey(plugin) === selectedPluginKey)
      || null
  ), [filteredPlugins, plugins, selectedPluginKey]);

  const disabledCount = plugins.filter((plugin) => plugin.disabled).length;

  const handleOpenFolder = async () => {
    try {
      await ApiService.openPluginsFolder(environmentId);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to open plugins folder');
    }
  };

  const handleTogglePlugin = async (plugin: PluginInfo) => {
    const pluginKey = getPluginKey(plugin);
    setTogglingPluginKey(pluginKey);
    setError(null);

    try {
      if (plugin.disabled) {
        await ApiService.enablePlugin(environmentId, plugin.fileName);
      } else {
        await ApiService.disablePlugin(environmentId, plugin.fileName);
      }

      await loadPlugins();
      onPluginsChanged?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : `Failed to ${plugin.disabled ? 'enable' : 'disable'} plugin`);
    } finally {
      setTogglingPluginKey(null);
    }
  };

  const handleDeletePlugin = async (plugin: PluginInfo) => {
    const pluginKey = getPluginKey(plugin);
    setDeletingPluginKey(pluginKey);
    setError(null);

    try {
      await ApiService.deletePlugin(environmentId, plugin.fileName);
      await loadPlugins();
      onPluginsChanged?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete plugin');
    } finally {
      setDeletingPluginKey(null);
    }
  };

  const handleUploadClick = async () => {
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
          name: 'Plugin Files',
          extensions: ['dll', 'zip'],
        }],
        title: 'Select Plugin File',
      }) as string | { path: string; name?: string } | null;

      if (!selected) {
        setUploading(false);
        return;
      }

      const filePath = typeof selected === 'string' ? selected : selected.path;
      const fileName = typeof selected === 'string'
        ? selected.split(/[/\\]/).pop() || 'unknown'
        : selected.name || selected.path.split(/[/\\]/).pop() || 'unknown';

      const result = await ApiService.uploadPlugin(
        environmentId,
        filePath,
        fileName,
        environment.runtime
      );

      if (!result.success) {
        setError(result.error || 'Failed to upload plugin');
        setUploading(false);
        return;
      }

      if (result.runtimeMismatch?.requiresConfirmation) {
        setPendingUpload({
          runtimeMismatch: result.runtimeMismatch,
        });
        return;
      }

      await loadPlugins();
      onPluginsChanged?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to upload plugin');
    } finally {
      setUploading(false);
    }
  };

  const handleRuntimeMismatchClose = async () => {
    setPendingUpload(null);
    await loadPlugins();
    onPluginsChanged?.();
  };

  const openContextMenu = (event: ReactMouseEvent, plugin: PluginInfo) => {
    event.preventDefault();
    setSelectedPluginKey(getPluginKey(plugin));
    setContextMenu({
      x: event.clientX,
      y: event.clientY,
      items: [
        {
          key: plugin.disabled ? 'enable' : 'disable',
          label: plugin.disabled ? 'Enable' : 'Disable',
          icon: plugin.disabled ? 'fas fa-toggle-on' : 'fas fa-toggle-off',
          onSelect: () => void handleTogglePlugin(plugin),
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
          onSelect: () => void loadPlugins(),
        },
        {
          key: 'delete',
          label: 'Delete',
          icon: 'fas fa-trash',
          danger: true,
          onSelect: () => setPendingDelete(plugin),
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
            void handleDeletePlugin(pendingDelete);
          }
        }}
        title="Delete Plugin"
        message={pendingDelete ? `Delete "${pendingDelete.name}" from this environment?` : ''}
        confirmText="Delete Plugin"
        cancelText="Cancel"
      />
      <ConfirmOverlay
        isOpen={!!pendingUpload}
        onClose={() => {
          void handleRuntimeMismatchClose();
        }}
        onConfirm={() => {}}
        title="Runtime Mismatch Warning"
        message={pendingUpload?.runtimeMismatch.warning || ''}
        confirmText="Continue Anyway"
        cancelText="Close"
      />

      <div className="mods-overlay workspace-collection-shell">
        <div className="modal-header">
          <h2>Plugins</h2>
        </div>

        <div className="workspace-collection">
          <div className="workspace-collection__main">
            <div className="workspace-collection__header">
              <div className="workspace-collection__nav">
                <div className="workspace-collection__toolbar-group workspace-collection__toolbar-group--summary">
                  <strong>{environment?.name || 'Environment'}</strong>
                  <span>{environment?.runtime || 'Unknown'} • Plugin inventory</span>
                </div>

                <div className="workspace-collection__summary">
                  <div className="workspace-collection__summary-chip">
                    <span>Plugins</span>
                    <strong>{plugins.length}</strong>
                  </div>
                  <div className="workspace-collection__summary-chip">
                    <span>Disabled</span>
                    <strong>{disabledCount}</strong>
                  </div>
                  <div className="workspace-collection__summary-chip">
                    <span>Folder</span>
                    <strong>{pluginsDirectory ? 'Ready' : 'Unavailable'}</strong>
                  </div>
                </div>
              </div>

              <div className="workspace-collection__toolbar">
                <div className="workspace-collection__toolbar-search">
                  <input
                    type="text"
                    value={searchTerm}
                    onChange={(event) => setSearchTerm(event.target.value)}
                    placeholder="Search plugins"
                  />
                </div>
                <div className="workspace-collection__toolbar-group">
                  <button onClick={handleUploadClick} className="btn btn-primary btn-small" disabled={uploading}>
                    {uploading ? 'Uploading...' : 'Add Plugin'}
                  </button>
                  <button type="button" className="btn btn-secondary btn-small" onClick={() => void handleOpenFolder()}>
                    Open Folder
                  </button>
                  <button type="button" className="btn btn-secondary btn-small" onClick={() => void loadPlugins()} disabled={loading}>
                    Reload
                  </button>
                </div>
              </div>

              {pluginsDirectory && (
                <div className="workspace-collection__toolbar-group workspace-collection__toolbar-group--path">
                  <span className="workspace-collection__path-label">Plugins Directory</span>
                  <code className="workspace-collection__path-value">{pluginsDirectory}</code>
                </div>
              )}
            </div>

            <div className="workspace-collection__content">
              {error && <div className="workspace-collection__empty workspace-collection__empty--error">{error}</div>}
              {!error && loading && <div className="workspace-collection__empty">Loading plugins...</div>}
              {!error && !loading && plugins.length === 0 && (
                <div className="workspace-collection__empty">No plugins detected for this environment.</div>
              )}
              {!error && !loading && plugins.length > 0 && filteredPlugins.length === 0 && (
                <div className="workspace-collection__empty">No plugins match this search.</div>
              )}
              {!error && !loading && filteredPlugins.length > 0 && (
                <div className="workspace-collection__list">
                  {filteredPlugins.map((plugin) => {
                    const pluginKey = getPluginKey(plugin);
                    const isSelected = selectedPluginKey === pluginKey;
                    return (
                      <div
                        key={pluginKey}
                        className={`workspace-collection__row workspace-file-row ${isSelected ? 'workspace-collection__row--selected' : ''}`}
                        role="button"
                        tabIndex={0}
                        onClick={() => setSelectedPluginKey(pluginKey)}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter' || event.key === ' ') {
                            event.preventDefault();
                            setSelectedPluginKey(pluginKey);
                          }
                        }}
                        onContextMenu={(event) => openContextMenu(event, plugin)}
                      >
                        <div className="workspace-file-row__icon">
                          <i className="fas fa-plug" aria-hidden="true"></i>
                        </div>
                        <div className="workspace-collection__row-body">
                          <div className="workspace-collection__row-title">{plugin.name}</div>
                          <div className="workspace-collection__row-meta">
                            {plugin.disabled ? (
                              <span className="workspace-pill workspace-pill--danger">Disabled</span>
                            ) : (
                              <span className="workspace-pill workspace-pill--success">Enabled</span>
                            )}
                            <span className="workspace-pill workspace-pill--source">{getPluginSourceLabel(plugin.source)}</span>
                            {plugin.version && <span className="workspace-pill">{plugin.version}</span>}
                            {plugin.relatedMod && <span className="workspace-pill">Mod: {plugin.relatedMod}</span>}
                          </div>
                          <p className="workspace-collection__row-summary">{plugin.fileName}</p>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>

          <aside className="workspace-collection__inspector">
            {!selectedPlugin && (
              <div className="workspace-collection__inspector-empty">
                Select a plugin to review file details and environment actions.
              </div>
            )}
            {selectedPlugin && (
              <div className="workspace-inspector-card">
                <div className="workspace-inspector-card__header workspace-inspector-card__header--file">
                  <div className="workspace-file-row__icon workspace-file-row__icon--large">
                    <i className="fas fa-plug" aria-hidden="true"></i>
                  </div>
                  <div>
                    <h3>{selectedPlugin.name}</h3>
                    <div className="workspace-inspector-card__subtle">
                      {getPluginSourceLabel(selectedPlugin.source)} {selectedPlugin.version ? `• ${selectedPlugin.version}` : ''}
                    </div>
                  </div>
                </div>

                <div className="workspace-inspector-card__metrics">
                  <div><span>Status</span><strong>{selectedPlugin.disabled ? 'Disabled' : 'Enabled'}</strong></div>
                  <div><span>Runtime</span><strong>{environment?.runtime || 'Unknown'}</strong></div>
                  <div><span>Version</span><strong>{selectedPlugin.version || 'Unknown'}</strong></div>
                </div>

                <div className="workspace-inspector-card__field">
                  <label>File Name</label>
                  <div className="workspace-inspector-card__value">{selectedPlugin.fileName}</div>
                </div>

                {selectedPlugin.relatedMod && (
                  <div className="workspace-inspector-card__field">
                    <label>Related Mod</label>
                    <div className="workspace-inspector-card__value">{selectedPlugin.relatedMod}</div>
                  </div>
                )}

                <div className="workspace-inspector-card__field">
                  <label>Path</label>
                  <div className="workspace-inspector-card__value workspace-inspector-card__value--path">{selectedPlugin.path}</div>
                </div>

                <div className="workspace-inspector-card__actions">
                  <button
                    className={selectedPlugin.disabled ? 'btn btn-primary' : 'btn btn-secondary'}
                    onClick={() => void handleTogglePlugin(selectedPlugin)}
                    disabled={togglingPluginKey === getPluginKey(selectedPlugin)}
                  >
                    {selectedPlugin.disabled ? 'Enable' : 'Disable'}
                  </button>
                  <button className="btn btn-secondary" onClick={() => setPendingDelete(selectedPlugin)} disabled={deletingPluginKey === getPluginKey(selectedPlugin)}>
                    Delete
                  </button>
                  <button className="btn btn-secondary" onClick={() => void handleOpenFolder()}>
                    Open Folder
                  </button>
                  <button className="btn btn-secondary" onClick={() => void loadPlugins()} disabled={loading}>
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
    </>
  );
}
