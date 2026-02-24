import React, { useState, useEffect, useRef, useMemo } from 'react';
import { listen } from '@tauri-apps/api/event';
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
  modTag: string | null;
  category: 'melonloader' | 'mod' | 'general';
}

interface Props {
  isOpen: boolean;
  onClose: () => void;
  environmentId: string;
  environment: Environment;
}

type TimePeriod = 'all' | 'last5min' | 'last15min' | 'last1hour' | 'custom';

interface ModCardData {
  modTag: string;
  logCount: number;
  lastLogTime: string | null;
  errorCount: number;
}

function highlightText(text: string, query: string): React.ReactNode {
  const q = query.trim();
  if (!q) return text;

  // Escape regex special chars in the query
  const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(escaped, 'gi');

  const parts: React.ReactNode[] = [];
  let lastIndex = 0;

  // matchAll requires a global or sticky regex; we use 'gi'
  for (const match of text.matchAll(re)) {
    const index = match.index ?? 0;
    const matchedText = match[0] ?? '';

    if (index > lastIndex) {
      parts.push(text.slice(lastIndex, index));
    }

    parts.push(
      <mark key={index} style={{ backgroundColor: '#ffaa00', color: '#000' }}>
        {matchedText}
      </mark>
    );

    lastIndex = index + matchedText.length;
  }

  // If no matches, return original string to avoid creating an empty array
  if (parts.length === 0) return text;

  if (lastIndex < text.length) {
    parts.push(text.slice(lastIndex));
  }

  return parts;
}

export function LogsOverlay({ isOpen, onClose, environmentId, environment }: Props) {
  const [logFiles, setLogFiles] = useState<LogFile[]>([]);
  const [selectedLogFile, setSelectedLogFile] = useState<LogFile | null>(null);
  const [logLines, setLogLines] = useState<LogLine[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filterLevel, setFilterLevel] = useState<string>('ALL');
  const [filterCategory, setFilterCategory] = useState<string>('ALL');
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [exporting, setExporting] = useState(false);
  const [isWatching, setIsWatching] = useState(false);
  const [autoScroll, setAutoScroll] = useState(true);
  const [timePeriod, setTimePeriod] = useState<TimePeriod>('all');
  const [customTimeStart, setCustomTimeStart] = useState<string>('');
  const [customTimeEnd, setCustomTimeEnd] = useState<string>('');
  const [selectedModTag, setSelectedModTag] = useState<string | null>(null);
  const [showModCard, setShowModCard] = useState(false);
  const logContainerRef = useRef<HTMLDivElement>(null);
  const scrollTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  // Normalize mod tag for comparison (handles space variations)
  const normalizeModTag = (modTag: string): string => {
    return modTag.replace(/\s+/g, '').toLowerCase();
  };

  // Generate consistent colors for mod tags
  const getModColor = (modTag: string): string => {
    const colors = [
      '#4a90e2', '#e24a90', '#90e24a', '#e2904a', '#904ae2', '#4ae290',
      '#e24a4a', '#4ae24a', '#4a4ae2', '#e2e24a', '#e24ae2', '#4ae2e2',
    ];
    // Use normalized tag for consistent colors
    const normalizedTag = normalizeModTag(modTag);
    let hash = 0;
    for (let i = 0; i < normalizedTag.length; i++) {
      hash = normalizedTag.charCodeAt(i) + ((hash << 5) - hash);
    }
    return colors[Math.abs(hash) % colors.length];
  };

  // Extract unique mod tags (normalized to handle space variations)
  const modTags = useMemo(() => {
    const tagMap = new Map<string, { tag: string; count: number }>();

    logLines.forEach(line => {
      if (line.modTag) {
        const normalized = normalizeModTag(line.modTag);
        const existing = tagMap.get(normalized);

        if (existing) {
          // Keep the most common variation
          existing.count++;
          // If this variation is more common, use it
          if (line.modTag.length > existing.tag.length) {
            // Prefer the longer version (with spaces)
            existing.tag = line.modTag;
          }
        } else {
          tagMap.set(normalized, { tag: line.modTag, count: 1 });
        }
      }
    });

    return Array.from(tagMap.values())
      .map(entry => entry.tag)
      .sort();
  }, [logLines]);

  // Calculate mod card data
  const modCardData: ModCardData | null = useMemo(() => {
    if (!selectedModTag) return null;

    const normalizedSelectedTag = normalizeModTag(selectedModTag);
    const modLogs = logLines.filter(line =>
      line.modTag && normalizeModTag(line.modTag) === normalizedSelectedTag
    );
    const errorLogs = modLogs.filter(line =>
      line.level && ['ERROR', 'FATAL'].includes(line.level.toUpperCase())
    );
    const lastLog = modLogs.length > 0 ? modLogs[modLogs.length - 1] : null;

    return {
      modTag: selectedModTag,
      logCount: modLogs.length,
      lastLogTime: lastLog?.timestamp || null,
      errorCount: errorLogs.length,
    };
  }, [selectedModTag, logLines]);

  useEffect(() => {
    if (isOpen) {
      loadLogFiles();
    } else {
      // Reset state when closing
      if (isWatching) {
        stopWatching();
      }
      setLogFiles([]);
      setSelectedLogFile(null);
      setLogLines([]);
      setFilterLevel('ALL');
      setFilterCategory('ALL');
      setSearchQuery('');
      setError(null);
      setTimePeriod('all');
      setSelectedModTag(null);
      setShowModCard(false);
    }
  }, [isOpen, environmentId]);

  useEffect(() => {
    if (selectedLogFile) {
      loadLogFile(selectedLogFile.path);

      // Auto-start watching if it's Latest.log
      if (selectedLogFile.isLatest && !isWatching) {
        startWatching(selectedLogFile.path);
      } else if (!selectedLogFile.isLatest && isWatching) {
        stopWatching();
      }
    }
  }, [selectedLogFile]);

  // Listen for log updates
  useEffect(() => {
    let unlisten: (() => void) | null = null;

    const setupListener = async () => {
      unlisten = await listen<{ lines: LogLine[] }>('log-update', (event) => {
        const newLines = event.payload.lines;
        setLogLines(prev => [...prev, ...newLines]);
      });
    };

    if (isWatching) {
      setupListener();
    }

    return () => {
      if (unlisten) {
        unlisten();
      }
    };
  }, [isWatching]);

  // Auto-scroll logic
  useEffect(() => {
    if (autoScroll && logContainerRef.current) {
      logContainerRef.current.scrollTop = logContainerRef.current.scrollHeight;
    }
  }, [logLines, autoScroll]);

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

  const startWatching = async (logPath: string) => {
    try {
      await ApiService.watchLogFile(logPath);
      setIsWatching(true);
    } catch (err) {
      console.error('Failed to start watching log file:', err);
    }
  };

  const stopWatching = async () => {
    try {
      await ApiService.stopWatchingLog();
      setIsWatching(false);
    } catch (err) {
      console.error('Failed to stop watching log file:', err);
    }
  };

  const handleScroll = () => {
    if (logContainerRef.current) {
      const { scrollTop, scrollHeight, clientHeight } = logContainerRef.current;
      const isAtBottom = Math.abs(scrollHeight - clientHeight - scrollTop) < 10;

      if (isAtBottom !== autoScroll) {
        setAutoScroll(isAtBottom);
      }
    }
  };

  const handleExport = async () => {
    if (!selectedLogFile) return;

    try {
      setExporting(true);

      const filePath = await save({
        defaultPath: `meloader-logs-${new Date().toISOString().split('T')[0]}.txt`,
        filters: [{
          name: 'Text Files',
          extensions: ['txt']
        }]
      });

      if (!filePath) {
        return;
      }

      await ApiService.exportLogs(
        selectedLogFile.path,
        filterLevel === 'ALL' ? null : filterLevel,
        searchQuery.trim() || null,
        (showModCard && selectedModTag) ? selectedModTag : null,
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

  const parseTime = (timestamp: string): Date | null => {
    // Parse HH:MM:SS.mmm format
    const match = timestamp.match(/(\d{2}):(\d{2}):(\d{2})\.(\d{3})/);
    if (!match) return null;

    const now = new Date();
    const hours = parseInt(match[1], 10);
    const minutes = parseInt(match[2], 10);
    const seconds = parseInt(match[3], 10);
    const milliseconds = parseInt(match[4], 10);

    const logDate = new Date(now);
    logDate.setHours(hours, minutes, seconds, milliseconds);

    // If log time is in the future, assume it's from previous day
    if (logDate > now) {
      logDate.setDate(logDate.getDate() - 1);
    }

    return logDate;
  };

  const filterByTimePeriod = (line: LogLine): boolean => {
    if (timePeriod === 'all' || !line.timestamp) return true;

    const logTime = parseTime(line.timestamp);
    if (!logTime) return true;

    const now = new Date();

    if (timePeriod === 'last5min') {
      const fiveMinAgo = new Date(now.getTime() - 5 * 60 * 1000);
      return logTime >= fiveMinAgo;
    } else if (timePeriod === 'last15min') {
      const fifteenMinAgo = new Date(now.getTime() - 15 * 60 * 1000);
      return logTime >= fifteenMinAgo;
    } else if (timePeriod === 'last1hour') {
      const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);
      return logTime >= oneHourAgo;
    } else if (timePeriod === 'custom') {
      if (!customTimeStart && !customTimeEnd) return true;

      const startTime = customTimeStart ? parseTime(customTimeStart) : null;
      const endTime = customTimeEnd ? parseTime(customTimeEnd) : null;

      if (startTime && logTime < startTime) return false;
      if (endTime && logTime > endTime) return false;
      return true;
    }

    return true;
  };

  const filteredLines = logLines.filter(line => {
    // Filter by level
    if (filterLevel !== 'ALL') {
      if (!line.level || line.level.toUpperCase() !== filterLevel.toUpperCase()) {
        return false;
      }
    }

    // Filter by category
    if (filterCategory !== 'ALL') {
      if (line.category !== filterCategory.toLowerCase()) {
        return false;
      }
    }

    // Filter by mod tag (normalized comparison)
    if (selectedModTag && showModCard) {
      if (!line.modTag || normalizeModTag(line.modTag) !== normalizeModTag(selectedModTag)) {
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

    // Filter by time period
    if (!filterByTimePeriod(line)) {
      return false;
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

  const getCategoryIcon = (category: string): string => {
    switch (category) {
      case 'melonloader':
        return 'fa-cog';
      case 'mod':
        return 'fa-puzzle-piece';
      default:
        return 'fa-file-alt';
    }
  };

  const handleModTagClick = (modTag: string) => {
    setSelectedModTag(modTag);
    setShowModCard(true);
  };

  if (!isOpen) return null;

  return (
    <div className="mods-overlay" style={{ height: '100%', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <div className="modal-header" style={{ borderBottom: '1px solid #3a3a3a', padding: '0.9rem 1.25rem' }}>
        <div>
          <h2 style={{ margin: 0 }}>
            Logs - {environment.name}
            {isWatching && <span style={{ marginLeft: '0.5rem', fontSize: '0.9rem', color: '#4a90e2' }}>
              <i className="fas fa-circle" style={{ fontSize: '0.5rem', marginRight: '0.25rem' }}></i> Live
            </span>}
          </h2>
          <p style={{ margin: '0.35rem 0 0 0', color: '#888', fontSize: '0.8rem' }}>
            Inspect MelonLoader and mod logs with live filtering.
          </p>
        </div>
        <button className="btn btn-secondary btn-small" onClick={onClose}>
          <i className="fas fa-arrow-left" style={{ marginRight: '0.4rem' }}></i>
          Back
        </button>
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

            {/* Mod Tags Sidebar */}
            {modTags.length > 0 && (
              <>
                <div style={{ padding: '0.75rem 1rem', borderTop: '1px solid #3a3a3a', borderBottom: '1px solid #3a3a3a', backgroundColor: '#2a2a2a' }}>
                  <h4 style={{ margin: 0, fontSize: '0.9rem' }}>Mod Tags</h4>
                </div>
                <div style={{ maxHeight: '200px', overflowY: 'auto', padding: '0.5rem' }}>
                  {modTags.map(tag => (
                    <button
                      key={tag}
                      onClick={() => handleModTagClick(tag)}
                      style={{
                        width: '100%',
                        padding: '0.5rem',
                        marginBottom: '0.25rem',
                        textAlign: 'left',
                        backgroundColor: selectedModTag === tag && showModCard ? '#3a3a3a' : '#2a2a2a',
                        border: `1px solid ${getModColor(tag)}`,
                        borderRadius: '4px',
                        color: getModColor(tag),
                        cursor: 'pointer',
                        fontSize: '0.85rem',
                        transition: 'all 0.2s',
                      }}
                      onMouseEnter={(e) => {
                        e.currentTarget.style.backgroundColor = '#333';
                      }}
                      onMouseLeave={(e) => {
                        if (selectedModTag !== tag || !showModCard) {
                          e.currentTarget.style.backgroundColor = '#2a2a2a';
                        }
                      }}
                    >
                      <i className="fas fa-puzzle-piece" style={{ marginRight: '0.5rem', fontSize: '0.75rem' }}></i>
                      {tag}
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>

          {/* Log Content */}
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', minWidth: 0 }}>
            {/* Filters and Search */}
            <div style={{ padding: '1rem', borderBottom: '1px solid #3a3a3a', display: 'flex', gap: '1rem', alignItems: 'center', flexWrap: 'wrap' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <label style={{ color: '#aaa', fontSize: '0.875rem' }}>Time:</label>
                <select
                  value={timePeriod}
                  onChange={(e) => setTimePeriod(e.target.value as TimePeriod)}
                  style={{
                    padding: '0.5rem',
                    backgroundColor: '#2a2a2a',
                    border: '1px solid #3a3a3a',
                    borderRadius: '4px',
                    color: '#fff',
                    fontSize: '0.875rem',
                  }}
                >
                  <option value="all">All Time</option>
                  <option value="last5min">Last 5 Minutes</option>
                  <option value="last15min">Last 15 Minutes</option>
                  <option value="last1hour">Last Hour</option>
                  <option value="custom">Custom Range</option>
                </select>
              </div>

              {timePeriod === 'custom' && (
                <>
                  <input
                    type="text"
                    placeholder="Start HH:MM:SS.mmm"
                    value={customTimeStart}
                    onChange={(e) => setCustomTimeStart(e.target.value)}
                    style={{
                      padding: '0.5rem',
                      backgroundColor: '#2a2a2a',
                      border: '1px solid #3a3a3a',
                      borderRadius: '4px',
                      color: '#fff',
                      fontSize: '0.875rem',
                      width: '150px',
                    }}
                  />
                  <input
                    type="text"
                    placeholder="End HH:MM:SS.mmm"
                    value={customTimeEnd}
                    onChange={(e) => setCustomTimeEnd(e.target.value)}
                    style={{
                      padding: '0.5rem',
                      backgroundColor: '#2a2a2a',
                      border: '1px solid #3a3a3a',
                      borderRadius: '4px',
                      color: '#fff',
                      fontSize: '0.875rem',
                      width: '150px',
                    }}
                  />
                </>
              )}

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

              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <label style={{ color: '#aaa', fontSize: '0.875rem' }}>Category:</label>
                <select
                  value={filterCategory}
                  onChange={(e) => setFilterCategory(e.target.value)}
                  style={{
                    padding: '0.5rem',
                    backgroundColor: '#2a2a2a',
                    border: '1px solid #3a3a3a',
                    borderRadius: '4px',
                    color: '#fff',
                    fontSize: '0.875rem',
                  }}
                >
                  <option value="ALL">All Categories</option>
                  <option value="melonloader">MelonLoader</option>
                  <option value="mod">Mods</option>
                  <option value="general">General</option>
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

              {selectedLogFile?.isLatest && autoScroll && (
                <button
                  onClick={() => setAutoScroll(false)}
                  className="btn btn-secondary"
                  title="Pause auto-scroll"
                  style={{ whiteSpace: 'nowrap' }}
                >
                  <i className="fas fa-pause"></i> Pause
                </button>
              )}

              {selectedLogFile?.isLatest && !autoScroll && (
                <button
                  onClick={() => setAutoScroll(true)}
                  className="btn btn-secondary"
                  title="Resume auto-scroll"
                  style={{ whiteSpace: 'nowrap' }}
                >
                  <i className="fas fa-play"></i> Resume
                </button>
              )}

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
            <div
              ref={logContainerRef}
              onScroll={handleScroll}
              style={{ flex: 1, overflow: 'auto', padding: '1rem', fontFamily: 'monospace', fontSize: '0.875rem', lineHeight: '1.5', backgroundColor: '#1a1a1a' }}
            >
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
                        gap: '0.75rem',
                        alignItems: 'flex-start',
                      }}
                    >
                      <span style={{ color: '#666', minWidth: '50px', fontSize: '0.75rem' }}>
                        {line.lineNumber}
                      </span>

                      {line.timestamp && (
                        <span style={{ color: '#888', minWidth: '100px', fontSize: '0.75rem', fontFamily: 'monospace' }}>
                          {line.timestamp}
                        </span>
                      )}

                      <i
                        className={`fas ${getCategoryIcon(line.category)}`}
                        style={{ color: '#666', fontSize: '0.75rem', marginTop: '0.2rem' }}
                        title={line.category}
                      ></i>

                      {line.modTag && (
                        <button
                          onClick={() => handleModTagClick(line.modTag!)}
                          style={{
                            padding: '0.1rem 0.4rem',
                            backgroundColor: 'transparent',
                            border: `1px solid ${getModColor(line.modTag)}`,
                            borderRadius: '3px',
                            color: getModColor(line.modTag),
                            fontSize: '0.75rem',
                            cursor: 'pointer',
                            fontFamily: 'monospace',
                            transition: 'all 0.2s',
                          }}
                          onMouseEnter={(e) => {
                            e.currentTarget.style.backgroundColor = getModColor(line.modTag!);
                            e.currentTarget.style.color = '#000';
                          }}
                          onMouseLeave={(e) => {
                            e.currentTarget.style.backgroundColor = 'transparent';
                            e.currentTarget.style.color = getModColor(line.modTag!);
                          }}
                        >
                          [{line.modTag}]
                        </button>
                      )}

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
                      >
                        {highlightText(line.content, searchQuery)}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Footer with stats */}
            <div style={{ padding: '0.75rem 1rem', borderTop: '1px solid #3a3a3a', backgroundColor: '#2a2a2a', fontSize: '0.875rem', color: '#888' }}>
              Showing {filteredLines.length} of {logLines.length} lines
              {filterLevel !== 'ALL' && ` (filtered by ${filterLevel})`}
              {filterCategory !== 'ALL' && ` (filtered by ${filterCategory})`}
              {searchQuery.trim() && ` (searching for "${searchQuery}")`}
              {timePeriod !== 'all' && ` (time: ${timePeriod})`}
            </div>
          </div>

          {/* Mod Detail Card */}
          {showModCard && modCardData && (
            <div style={{ width: '300px', borderLeft: '1px solid #3a3a3a', display: 'flex', flexDirection: 'column', overflow: 'hidden', backgroundColor: '#2a2a2a' }}>
              <div style={{ padding: '1rem', borderBottom: '1px solid #3a3a3a', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <h3 style={{ margin: 0, fontSize: '1rem', color: getModColor(modCardData.modTag) }}>
                  {modCardData.modTag}
                </h3>
                <button
                  onClick={() => {
                    setShowModCard(false);
                    setSelectedModTag(null);
                  }}
                  style={{
                    background: 'none',
                    border: 'none',
                    color: '#888',
                    cursor: 'pointer',
                    fontSize: '1.25rem',
                    padding: 0,
                  }}
                >
                  ×
                </button>
              </div>

              <div style={{ padding: '1rem', flex: 1, overflowY: 'auto' }}>
                <div style={{ marginBottom: '1.5rem' }}>
                  <h4 style={{ fontSize: '0.9rem', color: '#aaa', marginBottom: '0.5rem' }}>Statistics</h4>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '0.5rem', backgroundColor: '#1a1a1a', borderRadius: '4px' }}>
                      <span style={{ color: '#888', fontSize: '0.85rem' }}>Total Logs:</span>
                      <span style={{ color: '#fff', fontWeight: 'bold' }}>{modCardData.logCount}</span>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '0.5rem', backgroundColor: '#1a1a1a', borderRadius: '4px' }}>
                      <span style={{ color: '#888', fontSize: '0.85rem' }}>Errors:</span>
                      <span style={{ color: modCardData.errorCount > 0 ? '#ff4444' : '#4a90e2', fontWeight: 'bold' }}>
                        {modCardData.errorCount}
                      </span>
                    </div>
                    {modCardData.lastLogTime && (
                      <div style={{ display: 'flex', justifyContent: 'space-between', padding: '0.5rem', backgroundColor: '#1a1a1a', borderRadius: '4px' }}>
                        <span style={{ color: '#888', fontSize: '0.85rem' }}>Last Log:</span>
                        <span style={{ color: '#fff', fontSize: '0.85rem' }}>{modCardData.lastLogTime}</span>
                      </div>
                    )}
                  </div>
                </div>

                <div>
                  <h4 style={{ fontSize: '0.9rem', color: '#aaa', marginBottom: '0.5rem' }}>Actions</h4>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                    <button
                      onClick={() => {
                        // Filter to show only this mod's logs
                        setShowModCard(false);
                      }}
                      className="btn btn-secondary"
                      style={{ width: '100%', justifyContent: 'flex-start' }}
                    >
                      <i className="fas fa-filter" style={{ marginRight: '0.5rem' }}></i>
                      View Logs Only
                    </button>
                    <button
                      onClick={() => {
                        setSelectedModTag(null);
                        setShowModCard(false);
                      }}
                      className="btn btn-secondary"
                      style={{ width: '100%', justifyContent: 'flex-start' }}
                    >
                      <i className="fas fa-times" style={{ marginRight: '0.5rem' }}></i>
                      Hide Filter
                    </button>
                  </div>
                </div>
              </div>
            </div>
          )}
      </div>
    </div>
  );
}
