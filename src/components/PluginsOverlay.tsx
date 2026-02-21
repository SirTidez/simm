import { useState, useEffect } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import { ApiService } from '../services/api';
import { ConfirmOverlay } from './ConfirmOverlay';

interface PluginInfo {
  name: string;
  fileName: string;
  path: string;
  version?: string;
  source?: 'local' | 'thunderstore' | 'nexusmods' | 'github' | 'unknown';
  relatedMod?: string;
}

interface Props {
  isOpen: boolean;
  onClose: () => void;
  environmentId: string;
  onPluginsChanged?: () => void;
}

export function PluginsOverlay({ isOpen, onClose, environmentId, onPluginsChanged }: Props) {
  const [plugins, setPlugins] = useState<PluginInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pluginsDirectory, setPluginsDirectory] = useState<string>('');
  const [deletingPlugin, setDeletingPlugin] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [pendingUpload, setPendingUpload] = useState<{ file: null; runtimeMismatch: { detected: 'IL2CPP' | 'Mono' | 'unknown'; environment: 'IL2CPP' | 'Mono'; warning: string } } | null>(null);
  const [environment, setEnvironment] = useState<import('../types').Environment | null>(null);

  useEffect(() => {
    if (isOpen && environmentId) {
      loadEnvironment();
      loadPlugins();
    } else {
      // Reset state when closing
      setPlugins([]);
      setError(null);
      setPluginsDirectory('');
      setEnvironment(null);
    }
  }, [isOpen, environmentId]);

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
      const normalizedPlugins = result.plugins.map(plugin => ({
        ...plugin,
        source: plugin.source as PluginInfo['source']
      }));
      setPlugins(normalizedPlugins);
      setPluginsDirectory(result.pluginsDirectory);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load plugins');
      setPlugins([]);
    } finally {
      setLoading(false);
    }
  };

  const handleDeletePlugin = async (plugin: PluginInfo) => {
    if (!confirm(`Are you sure you want to delete "${plugin.name}"?`)) {
      return;
    }

    setDeletingPlugin(plugin.fileName);
    try {
      await ApiService.deletePlugin(environmentId, plugin.fileName);
      // Reload plugins list after deletion
      await loadPlugins();
      // Notify parent that plugins changed (so it can refresh the count)
      if (onPluginsChanged) {
        onPluginsChanged();
      }
    } catch (err) {
      alert(`Failed to delete plugin: ${err instanceof Error ? err.message : 'Unknown error'}`);
    } finally {
      setDeletingPlugin(null);
    }
  };

  const handleOpenFolder = async () => {
    try {
      await ApiService.openPluginsFolder(environmentId);
    } catch (err) {
      alert(`Failed to open plugins folder: ${err instanceof Error ? err.message : 'Unknown error'}`);
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
      // Use Tauri dialog to select file
      const selected = await open({
        multiple: false,
        filters: [{
          name: 'Plugin Files',
          extensions: ['dll', 'zip']
        }],
        title: 'Select Plugin File',
      }) as string | { path: string; name?: string } | null;

      if (!selected) {
        // User cancelled
        setUploading(false);
        return;
      }

      // Handle both string path and FileEntry object
      let filePath: string;
      let fileName: string;

      if (typeof selected === 'string') {
        filePath = selected;
        fileName = selected.split(/[/\\]/).pop() || 'unknown';
      } else {
        filePath = selected.path;
        fileName = selected.name || filePath.split(/[/\\]/).pop() || 'unknown';
      }

      // Call upload with file path and runtime
      const result = await ApiService.uploadPlugin(
        environmentId,
        filePath,
        fileName,
        environment.runtime
      );

      if (result.success) {
        // Check for runtime mismatch - plugin is already installed, just show warning
        if (result.runtimeMismatch && result.runtimeMismatch.requiresConfirmation) {
          // Store the mismatch info to show confirmation dialog
          setPendingUpload({ file: null, runtimeMismatch: result.runtimeMismatch });
          // Plugin is already installed, so we can proceed with success handling
          // but show the warning dialog first
        } else {
          // No mismatch - proceed with success handling
          await handleUploadSuccess();
        }
      } else {
        setError(result.error || 'Failed to upload plugin');
        setUploading(false);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to upload plugin');
      setUploading(false);
    }
  };

  const handleUploadSuccess = async () => {
    // Reload plugins list after successful upload
    await loadPlugins();
    // Notify parent that plugins changed
    if (onPluginsChanged) {
      onPluginsChanged();
    }
    setUploading(false);
    setPendingUpload(null);
  };

  const handleRuntimeMismatchConfirm = async () => {
    // Plugin is already installed, just acknowledge and continue
    setPendingUpload(null);
    await handleUploadSuccess();
  };

  const handleRuntimeMismatchCancel = () => {
    // Plugin is already installed, but user canceled acknowledgment
    // Still reload plugins since it was installed
    setPendingUpload(null);
    handleUploadSuccess();
  };

  if (!isOpen) return null;

  return (
    <>
      <ConfirmOverlay
        isOpen={!!pendingUpload}
        onClose={handleRuntimeMismatchCancel}
        onConfirm={handleRuntimeMismatchConfirm}
        title="Runtime Mismatch Warning"
        message={pendingUpload?.runtimeMismatch.warning || ''}
        confirmText="Continue Anyway"
        cancelText="Cancel"
      />
      <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content mods-overlay" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>Installed Plugins</h2>
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
              {pluginsDirectory && (
                <p style={{ margin: 0, color: '#888', fontSize: '0.875rem' }}>
                  <i className="fas fa-folder" style={{ marginRight: '0.5rem' }}></i>
                  {pluginsDirectory}
                </p>
              )}
            </div>
            <div style={{ display: 'flex', gap: '0.5rem' }}>
              <button
                onClick={handleUploadClick}
                className="btn btn-primary"
                disabled={uploading}
                title="Upload a plugin file (.dll, .zip, or .rar)"
              >
                {uploading ? (
                  <>
                    <i className="fas fa-spinner fa-spin" style={{ marginRight: '0.5rem' }}></i>
                    Uploading...
                  </>
                ) : (
                  <>
                    <i className="fas fa-upload" style={{ marginRight: '0.5rem' }}></i>
                    Add Plugin
                  </>
                )}
              </button>
              <button
                onClick={handleOpenFolder}
                className="btn btn-secondary"
                title="Open plugins folder in file explorer"
              >
                <i className="fas fa-folder-open" style={{ marginRight: '0.5rem' }}></i>
                Open Folder
              </button>
            </div>
          </div>

          {!loading && (
            <div style={{ padding: '0 1.25rem 1.25rem', maxHeight: '500px', overflowY: 'auto' }}>
              <div style={{ display: 'grid', gap: '1rem' }}>
                {/* Regular Plugins List */}
                {plugins.length === 0 ? (
                  <div style={{ padding: '2rem', textAlign: 'center', color: '#888' }}>
                    <i className="fas fa-box-open" style={{ fontSize: '2rem', marginBottom: '1rem' }}></i>
                    <p>No other plugins found</p>
                    <p style={{ fontSize: '0.875rem', marginTop: '0.5rem' }}>
                      Plugins should be placed in the Plugins directory as .dll files
                    </p>
                  </div>
                ) : (
                  plugins.map((plugin) => (
                    <div
                      key={plugin.fileName}
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
                        <h3 style={{ margin: 0, marginBottom: '0.5rem', fontSize: '1rem', color: '#fff' }}>
                          {plugin.name}
                        </h3>
                        <div style={{ display: 'flex', gap: '1rem', alignItems: 'center', fontSize: '0.875rem', color: '#888', flexWrap: 'wrap' }}>
                          <span>
                            <i className="fas fa-file-code" style={{ marginRight: '0.25rem' }}></i>
                            {plugin.fileName}
                          </span>
                          {plugin.version && (
                            <span>
                              <i className="fas fa-tag" style={{ marginRight: '0.25rem' }}></i>
                              Version: {plugin.version}
                            </span>
                          )}
                          {plugin.source && (
                            <span>
                              <i className="fas fa-download" style={{ marginRight: '0.25rem' }}></i>
                              Source: {plugin.source}
                            </span>
                          )}
                        </div>
                      </div>
                      <div style={{ display: 'flex', gap: '0.5rem' }}>
                        <button
                          onClick={() => handleDeletePlugin(plugin)}
                          className="btn btn-danger btn-small"
                          disabled={deletingPlugin === plugin.fileName}
                          title="Delete plugin"
                        >
                          {deletingPlugin === plugin.fileName ? (
                            <i className="fas fa-spinner fa-spin"></i>
                          ) : (
                            <i className="fas fa-trash"></i>
                          )}
                        </button>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
          )}
        </div>
      </div>
      </div>

    </>
  );
}
