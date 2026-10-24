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

export function PluginsOverlay({ isOpen, environmentId, onPluginsChanged }: Props) {
  const [plugins, setPlugins] = useState<PluginInfo[]>([]);
  const lookupArtwork = useModArtwork();
  const pluginArtwork = (plugin: PluginInfo) =>
    lookupArtwork(plugin.relatedMod) ?? lookupArtwork(plugin.fileName) ?? lookupArtwork(plugin.name);
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
  const environmentGenerationRef = useRef(0);

  const loadEnvironment = useCallback(async (generation = environmentGenerationRef.current) => {
    const requestedEnvironmentId = environmentId;
    try {
      const env = await ApiService.getEnvironment(requestedEnvironmentId);
      if (generation !== environmentGenerationRef.current) return;
      setEnvironment(env);
    } catch (err) {
      console.error('Failed to load environment:', err);
    }
  }, [environmentId]);

  const loadPlugins = useCallback(async (generation = environmentGenerationRef.current) => {
    const requestedEnvironmentId = environmentId;
    setLoading(true);
    setError(null);

    try {
      const result = await ApiService.getPlugins(requestedEnvironmentId);
      if (generation !== environmentGenerationRef.current) return;
      setPlugins(result.plugins.map((plugin) => ({
        ...plugin,
        source: plugin.source as PluginInfo['source'],
      })));
      setPluginsDirectory(result.pluginsDirectory);
    } catch (err) {
      if (generation !== environmentGenerationRef.current) return;
      setPlugins([]);
      setError(err instanceof Error ? err.message : 'Failed to load plugins');
    } finally {
      if (generation === environmentGenerationRef.current) setLoading(false);
    }
  }, [environmentId]);

  useEffect(() => {
    const generation = ++environmentGenerationRef.current;
    if (!isOpen || !environmentId) {
      setPlugins([]);
      setPluginsDirectory('');
      setEnvironment(null);
      setError(null);
      setSearchTerm('');
      setSelectedPluginKey(null);
      setContextMenu(null);
      setPendingDelete(null);
      setPendingUpload(null);
      setUploading(false);
      return;
    }

    void loadEnvironment(generation);
    void loadPlugins(generation);
  }, [environmentId, isOpen, loadEnvironment, loadPlugins]);

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
    const generation = environmentGenerationRef.current;
    const requestedEnvironmentId = environmentId;
    try {
      await ApiService.openPluginsFolder(requestedEnvironmentId);
    } catch (err) {
      if (generation !== environmentGenerationRef.current) return;
      setError(err instanceof Error ? err.message : 'Failed to open plugins folder');
    }
  };

  const handleTogglePlugin = async (plugin: PluginInfo) => {
    const generation = environmentGenerationRef.current;
    const requestedEnvironmentId = environmentId;
    const pluginKey = getPluginKey(plugin);
    setTogglingPluginKey(pluginKey);
    setError(null);

    try {
      if (plugin.disabled) {
        await ApiService.enablePlugin(requestedEnvironmentId, plugin.fileName);
      } else {
        await ApiService.disablePlugin(requestedEnvironmentId, plugin.fileName);
      }

      if (generation !== environmentGenerationRef.current) return;
      await loadPlugins(generation);
      if (generation === environmentGenerationRef.current) onPluginsChanged?.();
    } catch (err) {
      if (generation !== environmentGenerationRef.current) return;
      setError(err instanceof Error ? err.message : `Failed to ${plugin.disabled ? 'enable' : 'disable'} plugin`);
    } finally {
      if (generation === environmentGenerationRef.current) setTogglingPluginKey(null);
    }
  };

  const handleDeletePlugin = async (plugin: PluginInfo) => {
    const generation = environmentGenerationRef.current;
    const requestedEnvironmentId = environmentId;
    const pluginKey = getPluginKey(plugin);
    setDeletingPluginKey(pluginKey);
    setError(null);

    try {
      await ApiService.deletePlugin(requestedEnvironmentId, plugin.fileName);
      if (generation !== environmentGenerationRef.current) return;
      await loadPlugins(generation);
      if (generation === environmentGenerationRef.current) onPluginsChanged?.();
    } catch (err) {
      if (generation !== environmentGenerationRef.current) return;
      setError(err instanceof Error ? err.message : 'Failed to delete plugin');
    } finally {
      if (generation === environmentGenerationRef.current) setDeletingPluginKey(null);
    }
  };

  const handleUploadClick = async () => {
    const generation = environmentGenerationRef.current;
    const requestedEnvironmentId = environmentId;
    const requestedEnvironment = environment;

    if (!requestedEnvironment) {
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
        return;
      }

      if (generation !== environmentGenerationRef.current) return;

      const filePath = typeof selected === 'string' ? selected : selected.path;
      const fileName = typeof selected === 'string'
        ? selected.split(/[/\\]/).pop() || 'unknown'
        : selected.name || selected.path.split(/[/\\]/).pop() || 'unknown';

      const result = await ApiService.uploadPlugin(
        requestedEnvironmentId,
        filePath,
        fileName,
        requestedEnvironment.runtime
      );

      if (generation !== environmentGenerationRef.current) return;

      if (!result.success) {
        setError(result.error || 'Failed to upload plugin');
        return;
      }

      if (result.runtimeMismatch?.requiresConfirmation) {
        setPendingUpload({
          runtimeMismatch: result.runtimeMismatch,
        });
        return;
      }

      await loadPlugins(generation);
      if (generation === environmentGenerationRef.current) onPluginsChanged?.();
    } catch (err) {
      if (generation !== environmentGenerationRef.current) return;
      setError(err instanceof Error ? err.message : 'Failed to upload plugin');
    } finally {
      if (generation === environmentGenerationRef.current) setUploading(false);
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
          icon: plugin.disabled ? 'toggleOn' : 'toggleOff',
          onSelect: () => void handleTogglePlugin(plugin),
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

      <div className={`env-assets ui-split${plugins.length === 0 && !loading ? ' env-assets--solo' : ''}`}>
        <section className="env-assets__main" aria-label="Plugins">
          <div className="env-assets__head">
            <div className="ui-toolbar env-assets__bar">
              <div className="env-assets-search">
                <Icon name="search" className="env-assets-search__icon" />
                <Input
                  type="search"
                  value={searchTerm}
                  onChange={(event) => setSearchTerm(event.target.value)}
                  placeholder="Search plugins"
                  aria-label="Search plugins"
                />
              </div>
              <SimmButton
                type="button"
                variant="ghost"
                size="icon"
                aria-label="Reload plugins"
                title="Reload plugins"
                onClick={() => void loadPlugins()}
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
                <SimmButton type="button" variant="default" onClick={handleUploadClick} disabled={uploading}>
                  <Icon name={uploading ? 'fas fa-spinner fa-spin' : 'plus'} />
                  {uploading ? 'Adding...' : 'Add Plugin'}
                </SimmButton>
              </div>
            </div>
            {pluginsDirectory && (
              <p className="env-assets__summary ui-truncate" title={pluginsDirectory}>
                {plugins.length} {plugins.length === 1 ? 'plugin' : 'plugins'}
                {disabledCount > 0 ? ` · ${disabledCount} disabled` : ''}
                {' · '}
                <code className="ui-mono">{pluginsDirectory}</code>
              </p>
            )}
          </div>

          <div className="env-assets__content">
            {error && (
              <div className="env-assets__notices">
                <div className="ui-callout ui-callout--danger env-assets-error" role="alert">
                  <span className="env-assets-error__text">{error}</span>
                  <span className="ui-toolbar__group">
                    <SimmButton type="button" variant="outline" size="sm" onClick={() => void loadPlugins()}>
                      Retry
                    </SimmButton>
                    <SimmButton type="button" variant="ghost" size="sm" onClick={() => setError(null)}>
                      Dismiss
                    </SimmButton>
                  </span>
                </div>
              </div>
            )}
            {loading && plugins.length === 0 && (
              <div className="env-assets-skeleton" aria-busy="true" aria-label="Loading plugins">
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
            {!error && !loading && plugins.length === 0 && (
              <div className="ui-empty env-assets-empty">
                <span className="ui-empty__emblem" aria-hidden="true"><Icon name="plug" /></span>
                <h3 className="ui-empty__title">No plugins in this environment</h3>
                <p className="ui-empty__copy">
                  Plugins are MelonLoader plugins that load before mods, such as MLVScan or runtime fixes.
                  Add a .dll or .zip and SIMM places it in this environment&apos;s Plugins folder.
                </p>
                <div className="env-assets-empty__actions">
                  <SimmButton type="button" variant="secondary" onClick={handleUploadClick} disabled={uploading}>
                    {uploading ? 'Adding...' : 'Add Plugin File'}
                  </SimmButton>
                </div>
              </div>
            )}
            {!loading && plugins.length > 0 && filteredPlugins.length === 0 && (
              <div className="ui-empty env-assets-empty">
                <span className="ui-empty__emblem" aria-hidden="true"><Icon name="search" /></span>
                <h3 className="ui-empty__title">No plugins match</h3>
                <p className="ui-empty__copy">Nothing in this environment matches &quot;{searchTerm.trim()}&quot;.</p>
                <div className="env-assets-empty__actions">
                  <SimmButton type="button" variant="secondary" onClick={() => setSearchTerm('')}>
                    Clear Search
                  </SimmButton>
                </div>
              </div>
            )}
            {filteredPlugins.length > 0 && (
              <table className="ui-table env-assets-table">
                <colgroup>
                  <col />
                  <col className="env-assets-table__col-source" />
                  <col className="env-assets-table__col-version" />
                  <col className="env-assets-table__col-status" />
                  <col className="env-assets-table__col-toggle" />
                </colgroup>
                <thead>
                  <tr>
                    <th scope="col">Name</th>
                    <th scope="col">Source</th>
                    <th scope="col">Version</th>
                    <th scope="col">Status</th>
                    <th scope="col" className="env-assets-table__toggle">Enabled</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredPlugins.map((plugin) => {
                    const pluginKey = getPluginKey(plugin);
                    const isSelected = selectedPluginKey === pluginKey;
                    return (
                      <tr
                        key={pluginKey}
                        className={`ui-row env-assets-row${plugin.disabled ? ' env-assets-row--disabled' : ''}`}
                        aria-selected={isSelected}
                        onClick={(event) => {
                          if (isInteractiveTarget(event.target, event.currentTarget)) return;
                          setSelectedPluginKey(pluginKey);
                        }}
                        onContextMenu={(event) => openContextMenu(event, plugin)}
                      >
                        <td>
                          <button
                            type="button"
                            className="env-assets-row__open"
                            aria-pressed={isSelected}
                            onClick={() => setSelectedPluginKey(pluginKey)}
                          >
                            <AssetThumbnail artwork={pluginArtwork(plugin)} name={plugin.name} glyph="plug" size={32} />
                            <span className="env-assets-row__text">
                              <span className="env-assets-row__name">{plugin.name}</span>
                              <span className="env-assets-row__desc">{plugin.fileName}</span>
                            </span>
                          </button>
                        </td>
                        <td className="env-assets-row__muted">{getPluginSourceLabel(plugin.source)}</td>
                        <td className="env-assets-row__version ui-mono">{plugin.version || '—'}</td>
                        <td>{plugin.disabled && <span className="ui-tag">Disabled</span>}</td>
                        <td className="env-assets-table__toggle">
                          <Switch
                            checked={!plugin.disabled}
                            disabled={togglingPluginKey === pluginKey}
                            aria-label={`${plugin.name} enabled`}
                            onCheckedChange={() => void handleTogglePlugin(plugin)}
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

        <aside className="ui-inspector env-assets__inspector" aria-label="Plugin details">
          {!selectedPlugin && (
            <div className="ui-empty env-assets-empty env-assets-empty--inspector">
              <p className="ui-empty__copy">Select a plugin to see its file details and actions.</p>
            </div>
          )}
          {selectedPlugin && (
            <>
              <div className="env-assets-inspector__head">
                <AssetThumbnail artwork={pluginArtwork(selectedPlugin)} name={selectedPlugin.name} glyph="plug" size={48} />
                <div className="env-assets-inspector__titles">
                  <h3 className="env-assets-inspector__title">{selectedPlugin.name}</h3>
                  <div className="ui-meta">
                    <span>{getPluginSourceLabel(selectedPlugin.source)}</span>
                    {selectedPlugin.version && <span className="ui-mono">{selectedPlugin.version}</span>}
                  </div>
                  <div className="env-assets-inspector__status">
                    {selectedPlugin.disabled
                      ? <span className="ui-tag">Disabled</span>
                      : <span className="ui-status ui-status--ok">Enabled</span>}
                  </div>
                </div>
              </div>

              <div className="env-assets-inspector__actions">
                <SimmButton
                  type="button"
                  variant={selectedPlugin.disabled ? 'secondary' : 'outline'}
                  onClick={() => void handleTogglePlugin(selectedPlugin)}
                  disabled={togglingPluginKey === getPluginKey(selectedPlugin)}
                >
                  <Icon name={selectedPlugin.disabled ? 'toggleOn' : 'toggleOff'} />
                  {selectedPlugin.disabled ? 'Enable' : 'Disable'}
                </SimmButton>
                <SimmButton type="button" variant="outline" onClick={() => void handleOpenFolder()}>
                  <Icon name="folderOpen" />
                  Open Folder
                </SimmButton>
              </div>

              <section className="ui-inspector__section">
                <h4 className="ui-section-title">Details</h4>
                <dl className="ui-kv">
                  <dt>Version</dt>
                  <dd className="ui-mono">{selectedPlugin.version || 'Unknown'}</dd>
                  <dt>Source</dt>
                  <dd>{getPluginSourceLabel(selectedPlugin.source)}</dd>
                  {selectedPlugin.relatedMod && (
                    <>
                      <dt>Used by</dt>
                      <dd>{selectedPlugin.relatedMod}</dd>
                    </>
                  )}
                  <dt>File</dt>
                  <dd className="ui-mono">{selectedPlugin.fileName}</dd>
                  <dt>Path</dt>
                  <dd className="ui-mono">{selectedPlugin.path}</dd>
                </dl>
              </section>

              <div className="ui-danger-zone env-assets-danger">
                <SimmButton
                  type="button"
                  variant="destructive"
                  onClick={() => setPendingDelete(selectedPlugin)}
                  disabled={deletingPluginKey === getPluginKey(selectedPlugin)}
                >
                  <Icon name="trash" />
                  Delete
                </SimmButton>
                <p className="env-assets-danger__note">
                  Deletes the file from the Plugins folder of {environment?.name || 'this environment'}.
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
