import React, { useState, useEffect } from 'react';
import { ApiService } from '../services/api';
import type { Environment } from '../types';
import { save } from '@tauri-apps/plugin-dialog';

interface LogFile {
  name: string;
  path: string;
  size: number;
  modified: string | null;
  isLatest: boolean;
}

interface LogLine {
  lineNumber: number;
  content: string;
  level: string | null;
  timestamp: string | null;
}

interface Props {
  isOpen: boolean;
  onClose: () => void;
  environmentId: string;
  environment: Environment;
}

export function LogsOverlay({ isOpen, onClose, environmentId, environment }: Props) {
  const [logFiles, setLogFiles] = useState<LogFile[]>([]);
  const [selectedLogFile, setSelectedLogFile] = useState<LogFile | null>(null);
  const [logLines, setLogLines] = useState<LogLine[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filterLevel, setFilterLevel] = useState<string>('ALL');
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [exporting, setExporting] = useState(false);

  useEffect(() => {
    if (isOpen) {
      loadLogFiles();
    } else {
      // Reset state when closing
      setLogFiles([]);
      setSelectedLogFile(null);
      setLogLines([]);
      setFilterLevel('ALL');
      setSearchQuery('');
      setError(null);
    }
  }, [isOpen, environmentId]);

  useEffect(() => {
    if (selectedLogFile) {
      loadLogFile(selectedLogFile.path);
    }
  }, [selectedLogFile]);

  const loadLogFiles = async () => {
    try {
      setLoading(true);
      setError(null);
      const files = await ApiService.getLogFiles(environmentId);
      setLogFiles(files);
      
      // Auto-select Latest.log if available
      const latestLog = files.find(f => f.isLatest);
      if (latestLog) {
        setSelectedLogFile(latestLog);
      } else if (files.length > 0) {
        setSelectedLogFile(files[0]);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load log files');
      console.error('Failed to load log files:', err);
    } finally {
      setLoading(false);
    }
  };

  const loadLogFile = async (logPath: string, maxLines?: number) => {
    try {
      setLoading(true);
      setError(null);
      const lines = await ApiService.readLogFile(logPath, maxLines);
      setLogLines(lines);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load log file');
      console.error('Failed to load log file:', err);
    } finally {
      setLoading(false);
    }
  };

  const handleExport = async () => {
    if (!selectedLogFile) return;

    try {
      setExporting(true);
      
      // Use Tauri's save dialog
      const filePath = await save({
        defaultPath: `meloader-logs-${new Date().toISOString().split('T')[0]}.txt`,
        filters: [{
          name: 'Text Files',
          extensions: ['txt']
        }]
      });

      if (!filePath) {
        return; // User cancelled
      }

      await ApiService.exportLogs(
        selectedLogFile.path,
        filterLevel === 'ALL' ? null : filterLevel,
        searchQuery.trim() || null,
        filePath
      );

      alert('Logs exported successfully!');
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Failed to export logs';
      setError(errorMessage);
      alert(`Failed to export logs: ${errorMessage}`);
      console.error('Failed to export logs:', err);
    } finally {
      setExporting(false);
    }
  };

  const filteredLines = logLines.filter(line => {
    // Filter by level
    if (filterLevel !== 'ALL') {
      if (!line.level || line.level.toUpperCase() !== filterLevel.toUpperCase()) {
        return false;
      }
    }

    // Filter by search query
    if (searchQuery.trim()) {
      const query = searchQuery.toLowerCase();
      if (!line.content.toLowerCase().includes(query)) {
        return false;
      }
    }

    return true;
  });

  const getLevelColor = (level: string | null): string => {
    if (!level) return '#888';
    const upper = level.toUpperCase();
    switch (upper) {
      case 'ERROR':
      case 'FATAL':
        return '#ff4444';
      case 'WARN':
      case 'WARNING':
        return '#ffaa00';
      case 'INFO':
        return '#4a90e2';
      case 'DEBUG':
      case 'TRACE':
        return '#888';
      default:
        return '#fff';
    }
  };

  if (!isOpen) return null;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content mods-overlay" onClick={(e) => e.stopPropagation()} style={{ width: '90vw', maxWidth: '1400px', height: '90vh', display: 'flex', flexDirection: 'column' }}>
        <div className="modal-header">
          <h2>MelonLoader Logs - {environment.name}</h2>
          <button className="modal-close" onClick={onClose}>×</button>
        </div>

        <div className="mods-content" style={{ display: 'flex', flex: 1, gap: '1rem', overflow: 'hidden', minHeight: 0, padding: 0 }}>
          {/* Log Files Sidebar */}
          <div style={{ width: '250px', borderRight: '1px solid #3a3a3a', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
            <div style={{ padding: '1rem', borderBottom: '1px solid #3a3a3a' }}>
              <h3 style={{ margin: 0, fontSize: '1rem' }}>Log Files</h3>
            </div>
            <div style={{ flex: 1, overflowY: 'auto', padding: '0.5rem' }}>
              {loading && logFiles.length === 0 ? (
                <div style={{ padding: '1rem', textAlign: 'center', color: '#888' }}>
                  <i className="fas fa-spinner fa-spin"></i> Loading...
                </div>
              ) : logFiles.length === 0 ? (
                <div style={{ padding: '1rem', textAlign: 'center', color: '#888' }}>
                  No log files found
                </div>
              ) : (
                logFiles.map((file) => (
                  <button
                    key={file.path}
                    onClick={() => setSelectedLogFile(file)}
                    style={{
                      width: '100%',
                      padding: '0.75rem',
                      marginBottom: '0.5rem',
                      textAlign: 'left',
                      backgroundColor: selectedLogFile?.path === file.path ? '#3a3a3a' : '#2a2a2a',
                      border: selectedLogFile?.path === file.path ? '1px solid #4a90e2' : '1px solid #3a3a3a',
                      borderRadius: '4px',
                      color: '#fff',
                      cursor: 'pointer',
                      transition: 'all 0.2s',
                    }}
                    onMouseEnter={(e) => {
                      if (selectedLogFile?.path !== file.path) {
                        e.currentTarget.style.backgroundColor = '#333';
                      }
                    }}
                    onMouseLeave={(e) => {
                      if (selectedLogFile?.path !== file.path) {
                        e.currentTarget.style.backgroundColor = '#2a2a2a';
                      }
                    }}
                  >
                    <div style={{ fontWeight: file.isLatest ? 'bold' : 'normal', marginBottom: '0.25rem' }}>
                      {file.name}
                    </div>
                    <div style={{ fontSize: '0.75rem', color: '#888' }}>
                      {file.isLatest && <span style={{ color: '#4a90e2' }}>Latest • </span>}
                      {(file.size / 1024).toFixed(1)} KB
                      {file.modified && (
                        <> • {new Date(file.modified).toLocaleDateString()}</>
                      )}
                    </div>
                  </button>
                ))
              )}
            </div>
          </div>

          {/* Log Content */}
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', minWidth: 0 }}>
            {/* Filters and Search */}
            <div style={{ padding: '1rem', borderBottom: '1px solid #3a3a3a', display: 'flex', gap: '1rem', alignItems: 'center', flexWrap: 'wrap' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <label style={{ color: '#aaa', fontSize: '0.875rem' }}>Level:</label>
                <select
                  value={filterLevel}
                  onChange={(e) => setFilterLevel(e.target.value)}
                  style={{
                    padding: '0.5rem',
                    backgroundColor: '#2a2a2a',
                    border: '1px solid #3a3a3a',
                    borderRadius: '4px',
                    color: '#fff',
                    fontSize: '0.875rem',
                  }}
                >
                  <option value="ALL">All Levels</option>
                  <option value="ERROR">Error</option>
                  <option value="WARN">Warning</option>
                  <option value="INFO">Info</option>
                  <option value="DEBUG">Debug</option>
                </select>
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flex: 1, minWidth: '200px' }}>
                <label style={{ color: '#aaa', fontSize: '0.875rem' }}>Search:</label>
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Search log content..."
                  style={{
                    flex: 1,
                    padding: '0.5rem',
                    backgroundColor: '#2a2a2a',
                    border: '1px solid #3a3a3a',
                    borderRadius: '4px',
                    color: '#fff',
                    fontSize: '0.875rem',
                  }}
                />
              </div>

              <button
                onClick={handleExport}
                disabled={!selectedLogFile || exporting}
                className="btn btn-primary"
                style={{ whiteSpace: 'nowrap' }}
              >
                {exporting ? (
                  <>
                    <i className="fas fa-spinner fa-spin" style={{ marginRight: '0.5rem' }}></i>
                    Exporting...
                  </>
                ) : (
                  <>
                    <i className="fas fa-download" style={{ marginRight: '0.5rem' }}></i>
                    Export
                  </>
                )}
              </button>

              <button
                onClick={() => selectedLogFile && loadLogFile(selectedLogFile.path)}
                disabled={!selectedLogFile || loading}
                className="btn btn-secondary"
                title="Refresh"
              >
                <i className="fas fa-sync-alt"></i>
              </button>
            </div>

            {/* Log Content Display */}
            <div style={{ flex: 1, overflow: 'auto', padding: '1rem', fontFamily: 'monospace', fontSize: '0.875rem', lineHeight: '1.5', backgroundColor: '#1a1a1a' }}>
              {error ? (
                <div style={{ color: '#ff4444', padding: '1rem' }}>
                  <i className="fas fa-exclamation-circle" style={{ marginRight: '0.5rem' }}></i>
                  {error}
                </div>
              ) : loading && logLines.length === 0 ? (
                <div style={{ color: '#888', padding: '1rem', textAlign: 'center' }}>
                  <i className="fas fa-spinner fa-spin"></i> Loading log file...
                </div>
              ) : filteredLines.length === 0 ? (
                <div style={{ color: '#888', padding: '1rem', textAlign: 'center' }}>
                  {logLines.length === 0 ? 'No log content' : 'No lines match the current filters'}
                </div>
              ) : (
                <div>
                  {filteredLines.map((line, idx) => (
                    <div
                      key={`${line.lineNumber}-${idx}`}
                      style={{
                        padding: '0.25rem 0',
                        borderBottom: '1px solid #2a2a2a',
                        display: 'flex',
                        gap: '1rem',
                        alignItems: 'flex-start',
                      }}
                    >
                      <span style={{ color: '#666', minWidth: '60px', fontSize: '0.75rem' }}>
                        {line.lineNumber}
                      </span>
                      {line.level && (
                        <span
                          style={{
                            color: getLevelColor(line.level),
                            minWidth: '60px',
                            fontWeight: 'bold',
                            fontSize: '0.75rem',
                          }}
                        >
                          [{line.level}]
                        </span>
                      )}
                      <span
                        style={{
                          color: '#fff',
                          flex: 1,
                          wordBreak: 'break-word',
                          whiteSpace: 'pre-wrap',
                        }}
                        dangerouslySetInnerHTML={{
                          __html: searchQuery.trim()
                            ? line.content.replace(
                                new RegExp(`(${searchQuery.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi'),
                                '<mark style="background-color: #ffaa00; color: #000;">$1</mark>'
                              )
                            : line.content,
                        }}
                      />
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Footer with stats */}
            <div style={{ padding: '0.75rem 1rem', borderTop: '1px solid #3a3a3a', backgroundColor: '#2a2a2a', fontSize: '0.875rem', color: '#888' }}>
              Showing {filteredLines.length} of {logLines.length} lines
              {filterLevel !== 'ALL' && ` (filtered by ${filterLevel})`}
              {searchQuery.trim() && ` (searching for "${searchQuery}")`}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

