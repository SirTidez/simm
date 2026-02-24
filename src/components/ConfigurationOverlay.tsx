import { useState, useEffect } from 'react';
import { ApiService } from '../services/api';
import type { Environment, ConfigFile, ConfigSection, ConfigUpdate } from '../types';

interface Props {
  isOpen: boolean;
  onClose: () => void;
  environmentId: string;
  environment: Environment;
}

export function ConfigurationOverlay({ isOpen, onClose, environmentId, environment }: Props) {
  const [configFiles, setConfigFiles] = useState<ConfigFile[]>([]);
  const [groupedConfig, setGroupedConfig] = useState<Record<string, ConfigSection[]>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedMod, setSelectedMod] = useState<string | null>(null);
  const [editedValues, setEditedValues] = useState<Record<string, Record<string, string>>>({});
  const [hasChanges, setHasChanges] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (isOpen) {
      loadConfigFiles();
    }
  }, [isOpen, environmentId]);

  const loadConfigFiles = async () => {
    setLoading(true);
    setError(null);
    try {
      // Get all config files
      const files = await ApiService.getConfigFiles(environmentId);
      setConfigFiles(files);

      // Get grouped config for MelonPreferences
      const grouped = await ApiService.getGroupedConfig(environmentId);
      setGroupedConfig(grouped);

      // Auto-select first mod or loader settings
      const modNames = Object.keys(grouped);
      if (modNames.length > 0 && !selectedMod) {
        setSelectedMod(modNames[0]);
      } else {
        // Check if Loader.cfg exists
        const loaderCfg = files.find(f => f.fileType === 'LoaderConfig');
        if (loaderCfg && !selectedMod) {
          setSelectedMod('_loader_settings');
        }
      }
    } catch (err) {
      console.error('Failed to load config files:', err);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  const handleValueChange = (section: string, key: string, value: string) => {
    setEditedValues(prev => ({
      ...prev,
      [section]: {
        ...(prev[section] || {}),
        [key]: value,
      },
    }));
    setHasChanges(true);
  };

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      // Determine which config file to update
      let filePath: string;
      if (selectedMod === '_loader_settings') {
        const loaderCfg = configFiles.find(f => f.fileType === 'LoaderConfig');
        if (!loaderCfg) {
          throw new Error('Loader.cfg not found');
        }
        filePath = loaderCfg.path;
      } else {
        const melonPrefs = configFiles.find(f => f.fileType === 'MelonPreferences');
        if (!melonPrefs) {
          throw new Error('MelonPreferences.cfg not found');
        }
        filePath = melonPrefs.path;
      }

      // Convert editedValues to ConfigUpdate array
      const updates: ConfigUpdate[] = [];
      for (const [section, entries] of Object.entries(editedValues)) {
        for (const [key, value] of Object.entries(entries)) {
          updates.push({ section, key, value });
        }
      }

      // Save changes
      await ApiService.updateConfig(filePath, updates);

      // Reset state
      setEditedValues({});
      setHasChanges(false);

      // Reload config
      await loadConfigFiles();
    } catch (err) {
      console.error('Failed to save config:', err);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const handleDiscard = () => {
    setEditedValues({});
    setHasChanges(false);
  };

  const getCurrentSections = (): ConfigSection[] => {
    if (selectedMod === '_loader_settings') {
      const loaderCfg = configFiles.find(f => f.fileType === 'LoaderConfig');
      return loaderCfg?.sections || [];
    } else if (selectedMod) {
      return groupedConfig[selectedMod] || [];
    }
    return [];
  };

  const getDisplayValue = (section: string, key: string, originalValue: string): string => {
    return editedValues[section]?.[key] ?? originalValue;
  };

  if (!isOpen) return null;

  return (
    <div className="config-overlay" style={{ height: '100%', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      {/* Header */}
      <div className="modal-header" style={{ borderBottom: '1px solid #3a3a3a', padding: '0.9rem 1.25rem' }}>
          <div>
            <h2 style={{ margin: 0 }}>Configuration - {environment.name}</h2>
            <p style={{ margin: '0.35rem 0 0 0', color: '#888', fontSize: '0.8rem' }}>
              Edit loader and mod configuration values for this environment.
            </p>
          </div>
          <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
            {hasChanges && (
              <>
                <button
                  onClick={handleDiscard}
                  disabled={saving}
                    className="btn btn-secondary"
                    style={{ fontSize: '0.875rem' }}
                  >
                    Revert Draft
                  </button>
                <button
                  onClick={handleSave}
                  disabled={saving}
                  className="btn btn-primary"
                  style={{ fontSize: '0.875rem' }}
                >
                  {saving ? (
                    <>
                      <i className="fas fa-spinner fa-spin" style={{ marginRight: '0.5rem' }}></i>
                      Saving...
                    </>
                  ) : (
                    <>
                      <i className="fas fa-save" style={{ marginRight: '0.5rem' }}></i>
                      Save Draft
                    </>
                  )}
                </button>
              </>
            )}
            <button className="btn btn-secondary btn-small" onClick={onClose}>
              <i className="fas fa-arrow-left" style={{ marginRight: '0.4rem' }}></i>
              Back
            </button>
          </div>
        </div>

        {/* Content */}
      <div style={{ flex: 1, display: 'flex', overflow: 'hidden', minHeight: 0 }}>
          {/* Left Sidebar - Mod List */}
          <div style={{ width: '250px', borderRight: '1px solid #3a3a3a', overflowY: 'auto', backgroundColor: '#1a1a1a' }}>
            {/* Loader Settings */}
            {configFiles.some(f => f.fileType === 'LoaderConfig') && (
              <div
                onClick={() => setSelectedMod('_loader_settings')}
                style={{
                  padding: '1rem',
                  cursor: 'pointer',
                  borderBottom: '1px solid #3a3a3a',
                  backgroundColor: selectedMod === '_loader_settings' ? '#2a2a2a' : 'transparent',
                  transition: 'background-color 0.2s'
                }}
                onMouseEnter={(e) => {
                  if (selectedMod !== '_loader_settings') {
                    e.currentTarget.style.backgroundColor = '#232323';
                  }
                }}
                onMouseLeave={(e) => {
                  if (selectedMod !== '_loader_settings') {
                    e.currentTarget.style.backgroundColor = 'transparent';
                  }
                }}
              >
                <div style={{ fontWeight: '600', color: '#fff', fontSize: '0.9rem' }}>
                  <i className="fas fa-cog" style={{ marginRight: '0.5rem', color: '#4a90e2' }}></i>
                  Loader Settings
                </div>
                <div style={{ fontSize: '0.75rem', color: '#888', marginTop: '0.25rem' }}>
                  MelonLoader Configuration
                </div>
              </div>
            )}

            {/* Mod Configurations */}
            {Object.keys(groupedConfig).sort().map(modName => (
              <div
                key={modName}
                onClick={() => setSelectedMod(modName)}
                style={{
                  padding: '1rem',
                  cursor: 'pointer',
                  borderBottom: '1px solid #3a3a3a',
                  backgroundColor: selectedMod === modName ? '#2a2a2a' : 'transparent',
                  transition: 'background-color 0.2s'
                }}
                onMouseEnter={(e) => {
                  if (selectedMod !== modName) {
                    e.currentTarget.style.backgroundColor = '#232323';
                  }
                }}
                onMouseLeave={(e) => {
                  if (selectedMod !== modName) {
                    e.currentTarget.style.backgroundColor = 'transparent';
                  }
                }}
              >
                <div style={{ fontWeight: '600', color: '#fff', fontSize: '0.9rem' }}>
                  <i className="fas fa-cube" style={{ marginRight: '0.5rem', color: '#7c3aed' }}></i>
                  {modName}
                </div>
                <div style={{ fontSize: '0.75rem', color: '#888', marginTop: '0.25rem' }}>
                  {groupedConfig[modName].length} section{groupedConfig[modName].length !== 1 ? 's' : ''}
                </div>
              </div>
            ))}

            {Object.keys(groupedConfig).length === 0 && !configFiles.some(f => f.fileType === 'LoaderConfig') && !loading && (
              <div style={{ padding: '1rem', color: '#888', fontSize: '0.875rem' }}>
                No configuration files found
              </div>
            )}
          </div>

          {/* Right Content - Config Editor */}
          <div style={{ flex: 1, overflowY: 'auto', padding: '1.25rem', backgroundColor: '#0f0f0f' }}>
            {loading && (
              <div style={{ textAlign: 'center', color: '#888', padding: '2rem' }}>
                <i className="fas fa-spinner fa-spin" style={{ fontSize: '2rem', marginBottom: '1rem' }}></i>
                <div>Loading configuration...</div>
              </div>
            )}

            {error && (
              <div style={{ backgroundColor: '#dc3545', color: '#fff', padding: '0.75rem', borderRadius: '4px', marginBottom: '1rem' }}>
                <i className="fas fa-exclamation-triangle" style={{ marginRight: '0.5rem' }}></i>
                {error}
              </div>
            )}

            {!loading && !error && selectedMod && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
                {getCurrentSections().map((section, idx) => {
                  // Extract the last part of the section name (category name)
                  const getSectionTitle = (sectionName: string): string => {
                    if (selectedMod === '_loader_settings') {
                      return sectionName;
                    }
                    const parts = sectionName.split('_');
                    return parts.length > 0 ? parts[parts.length - 1] : sectionName;
                  };
                  
                  return (
                    <div key={idx} style={{ backgroundColor: '#1a1a1a', borderRadius: '4px', padding: '1rem', border: '1px solid #3a3a3a' }}>
                      <h3 style={{ fontSize: '1.1rem', fontWeight: '600', color: '#fff', marginBottom: '1rem', paddingBottom: '0.5rem', borderBottom: '1px solid #3a3a3a' }}>
                        {getSectionTitle(section.name)}
                      </h3>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                      {section.entries.map((entry, entryIdx) => (
                        <div key={entryIdx} style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
                          {entry.comment && (
                            <div style={{ fontSize: '0.75rem', color: '#888', fontStyle: 'italic' }}>
                              {entry.comment}
                            </div>
                          )}
                          <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
                            <label style={{ fontSize: '0.875rem', fontWeight: '500', color: '#aaa', minWidth: '200px' }}>
                              {entry.key}
                            </label>
                            <input
                              type="text"
                              value={getDisplayValue(section.name, entry.key, entry.value)}
                              onChange={(e) => handleValueChange(section.name, entry.key, e.target.value)}
                              style={{
                                flex: 1,
                                backgroundColor: '#0f0f0f',
                                border: '1px solid #3a3a3a',
                                borderRadius: '4px',
                                padding: '0.5rem 0.75rem',
                                color: '#fff',
                                fontSize: '0.875rem',
                                transition: 'border-color 0.2s'
                              }}
                              onFocus={(e) => {
                                e.currentTarget.style.borderColor = '#4a90e2';
                              }}
                              onBlur={(e) => {
                                e.currentTarget.style.borderColor = '#3a3a3a';
                              }}
                            />
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                  );
                })}

                {getCurrentSections().length === 0 && (
                  <div style={{ textAlign: 'center', color: '#888', padding: '2rem' }}>
                    No configuration sections found for this mod
                  </div>
                )}
              </div>
            )}

            {!loading && !error && !selectedMod && (
              <div style={{ textAlign: 'center', color: '#888', padding: '2rem' }}>
                Select a mod from the left to view and edit its configuration
              </div>
            )}
          </div>
        </div>
    </div>
  );
}
