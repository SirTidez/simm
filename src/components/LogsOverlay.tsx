import { type CSSProperties, type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { save } from '@tauri-apps/plugin-dialog';

import { ApiService } from '../services/api';
import type { Environment } from '../types';

const INSPECTOR_COLLAPSE_BREAKPOINT = 1240;

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
  onOpenModLibraryView?: (focus: { storageId: string; modTag: string }) => void;
}

type TimePeriod = 'all' | 'last5min' | 'last15min' | 'last1hour' | 'custom';
type LogLevelFilter = 'ALL' | 'ERROR' | 'WARN' | 'INFO' | 'DEBUG';
type LogCategoryFilter = 'ALL' | 'melonloader' | 'mod' | 'general';
type EffectiveLevel = 'ERROR' | 'WARN' | 'INFO' | 'DEBUG';

interface ModActivityItem {
  modTag: string;
  count: number;
  errorCount: number;
  lastLogTime: string | null;
}

function normalizeModTag(modTag: string): string {
  return modTag.replace(/\s+/g, '').toLowerCase();
}

function getLineKey(line: LogLine): string {
  return `${line.lineNumber}-${line.timestamp ?? 'none'}-${line.modTag ?? 'none'}-${line.content}`;
}

function getEffectiveLevel(line: LogLine): EffectiveLevel {
  const sourceText = `${line.level ?? ''} ${line.content}`.toLowerCase();

  if (/\berror\b|\bfatal\b/.test(sourceText)) return 'ERROR';
  if (/\bwarn(ing)?\b/.test(sourceText)) return 'WARN';
  if (/\bdebug\b|\btrace\b/.test(sourceText)) return 'DEBUG';
  return 'INFO';
}

function getLevelLabel(level: EffectiveLevel): string {
  switch (level) {
    case 'ERROR':
      return 'Error';
    case 'WARN':
      return 'Warning';
    case 'DEBUG':
      return 'Debug';
    default:
      return 'Info';
  }
}

function getCategoryLabel(category: LogLine['category']): string {
  switch (category) {
    case 'melonloader':
      return 'MelonLoader';
    case 'mod':
      return 'Mods';
    default:
      return 'General';
  }
}

function getCategoryIcon(category: LogLine['category']): string {
  switch (category) {
    case 'melonloader':
      return 'fa-cog';
    case 'mod':
      return 'fa-puzzle-piece';
    default:
      return 'fa-file-lines';
  }
}

function getModColor(modTag: string): string {
  const colors = [
    '#74a7ff',
    '#ff8bc7',
    '#7ed489',
    '#ffba6f',
    '#b198ff',
    '#63d9c8',
    '#ff7d7d',
    '#80d3ff',
    '#dbcb72',
    '#85b8ff',
    '#cfa3ff',
    '#6fd3a6',
  ];
  const normalized = normalizeModTag(modTag);
  let hash = 0;
  for (let index = 0; index < normalized.length; index += 1) {
    hash = normalized.charCodeAt(index) + ((hash << 5) - hash);
  }
  return colors[Math.abs(hash) % colors.length];
}

function getModAccentStyle(modTag: string): CSSProperties {
  return { '--logs-mod-accent': getModColor(modTag) } as CSSProperties;
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatModifiedDate(value: string | null): string {
  if (!value) return 'Unknown';
  return new Date(value).toLocaleString();
}

function highlightText(text: string, query: string): ReactNode {
  const trimmedQuery = query.trim();
  if (!trimmedQuery) return text;

  const escaped = trimmedQuery.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(escaped, 'gi');
  const matches = [...text.matchAll(regex)];

  if (matches.length === 0) return text;

  const pieces: ReactNode[] = [];
  let previousIndex = 0;

  for (const match of matches) {
    const start = match.index ?? 0;
    const matchedText = match[0] ?? '';
    if (start > previousIndex) {
      pieces.push(text.slice(previousIndex, start));
    }
    pieces.push(
      <mark key={`${start}-${matchedText}`} className="logs-panel__highlight">
        {matchedText}
      </mark>
    );
    previousIndex = start + matchedText.length;
  }

  if (previousIndex < text.length) {
    pieces.push(text.slice(previousIndex));
  }

  return pieces;
}

function parseTime(timestamp: string): Date | null {
  const match = timestamp.match(/(\d{2}):(\d{2}):(\d{2})\.(\d{3})/);
  if (!match) return null;

  const now = new Date();
  const parsed = new Date(now);
  parsed.setHours(
    Number.parseInt(match[1], 10),
    Number.parseInt(match[2], 10),
    Number.parseInt(match[3], 10),
    Number.parseInt(match[4], 10),
  );

  if (parsed > now) {
    parsed.setDate(parsed.getDate() - 1);
  }

  return parsed;
}

function formatRelativeTime(timestamp: string | null): string {
  if (!timestamp) return 'Unknown';
  const parsed = parseTime(timestamp);
  return parsed ? parsed.toLocaleTimeString() : timestamp;
}

function formatVisibleCount(count: number): string {
  return `${count} ${count === 1 ? 'Line' : 'Lines'}`;
}

export function LogsOverlay({ isOpen, environmentId, environment, onOpenModLibraryView }: Props) {
  const [logFiles, setLogFiles] = useState<LogFile[]>([]);
  const [selectedLogPath, setSelectedLogPath] = useState<string | null>(null);
  const [logLines, setLogLines] = useState<LogLine[]>([]);
  const [selectedLineKey, setSelectedLineKey] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filterLevel, setFilterLevel] = useState<LogLevelFilter>('ALL');
  const [filterCategory, setFilterCategory] = useState<LogCategoryFilter>('ALL');
  const [searchQuery, setSearchQuery] = useState('');
  const [timePeriod, setTimePeriod] = useState<TimePeriod>('all');
  const [customTimeStart, setCustomTimeStart] = useState('');
  const [customTimeEnd, setCustomTimeEnd] = useState('');
  const [selectedModTag, setSelectedModTag] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [isWatching, setIsWatching] = useState(false);
  const [watchedPath, setWatchedPath] = useState<string | null>(null);
  const [autoScroll, setAutoScroll] = useState(true);
  const [isAtBottom, setIsAtBottom] = useState(true);
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const [openingModView, setOpeningModView] = useState(false);
  const [shouldCollapseInspector, setShouldCollapseInspector] = useState<boolean>(() => window.innerWidth <= INSPECTOR_COLLAPSE_BREAKPOINT);
  const [isInspectorCollapsed, setIsInspectorCollapsed] = useState<boolean>(() => window.innerWidth <= INSPECTOR_COLLAPSE_BREAKPOINT);

  const logContainerRef = useRef<HTMLDivElement>(null);
  const rowRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const toastTimeoutRef = useRef<number | null>(null);

  const selectedLogFile = useMemo(
    () => logFiles.find((file) => file.path === selectedLogPath) ?? null,
    [logFiles, selectedLogPath],
  );

  const isSharedPlayerLogFile = (file: LogFile | null): boolean => {
    if (!file) return false;
    const normalizedPath = file.path.replace(/\\/g, '/').toLowerCase();
    return normalizedPath.endsWith('/player.log') || normalizedPath.endsWith('/player-prev.log');
  };

  const isLiveLogFile = (file: LogFile | null): boolean => {
    if (!file) return false;
    const normalizedPath = file.path.replace(/\\/g, '/').toLowerCase();
    return file.isLatest || normalizedPath.endsWith('/player.log');
  };

  const showToast = (message: string) => {
    setToastMessage(message);
    if (toastTimeoutRef.current) {
      clearTimeout(toastTimeoutRef.current);
    }
    toastTimeoutRef.current = window.setTimeout(() => {
      setToastMessage(null);
      toastTimeoutRef.current = null;
    }, 4000);
  };

  const currentFiles = useMemo(
    () => logFiles.filter((file) => file.isLatest || isSharedPlayerLogFile(file)),
    [logFiles],
  );

  const archivedFiles = useMemo(
    () => logFiles.filter((file) => !file.isLatest && !isSharedPlayerLogFile(file)),
    [logFiles],
  );

  const modActivity = useMemo<ModActivityItem[]>(() => {
    const byTag = new Map<string, ModActivityItem>();
    for (const line of logLines) {
      if (!line.modTag) continue;
      const normalized = normalizeModTag(line.modTag);
      const existing = byTag.get(normalized);
      const effectiveLevel = getEffectiveLevel(line);
      if (existing) {
        existing.count += 1;
        if (effectiveLevel === 'ERROR') {
          existing.errorCount += 1;
        }
        existing.lastLogTime = line.timestamp ?? existing.lastLogTime;
        if (line.modTag.length > existing.modTag.length) {
          existing.modTag = line.modTag;
        }
      } else {
        byTag.set(normalized, {
          modTag: line.modTag,
          count: 1,
          errorCount: effectiveLevel === 'ERROR' ? 1 : 0,
          lastLogTime: line.timestamp,
        });
      }
    }
    return [...byTag.values()].sort((left, right) => {
      if (right.count !== left.count) return right.count - left.count;
      return left.modTag.localeCompare(right.modTag);
    });
  }, [logLines]);

  const visibleLines = useMemo(() => {
    return logLines.filter((line) => {
      const effectiveLevel = getEffectiveLevel(line);
      if (filterLevel !== 'ALL' && effectiveLevel !== filterLevel) {
        return false;
      }

      if (filterCategory !== 'ALL' && line.category !== filterCategory) {
        return false;
      }

      if (selectedModTag && (!line.modTag || normalizeModTag(line.modTag) !== normalizeModTag(selectedModTag))) {
        return false;
      }

      if (searchQuery.trim()) {
        const query = searchQuery.toLowerCase();
        const searchable = `${line.content} ${line.modTag ?? ''} ${line.timestamp ?? ''}`.toLowerCase();
        if (!searchable.includes(query)) {
          return false;
        }
      }

      if (timePeriod === 'all' || !line.timestamp) {
        return true;
      }

      const logTime = parseTime(line.timestamp);
      if (!logTime) return true;
      const now = new Date();

      if (timePeriod === 'last5min') {
        return logTime >= new Date(now.getTime() - 5 * 60 * 1000);
      }

      if (timePeriod === 'last15min') {
        return logTime >= new Date(now.getTime() - 15 * 60 * 1000);
      }

      if (timePeriod === 'last1hour') {
        return logTime >= new Date(now.getTime() - 60 * 60 * 1000);
      }

      if (!customTimeStart && !customTimeEnd) return true;
      const startTime = customTimeStart ? parseTime(customTimeStart) : null;
      const endTime = customTimeEnd ? parseTime(customTimeEnd) : null;
      if (startTime && logTime < startTime) return false;
      if (endTime && logTime > endTime) return false;
      return true;
    });
  }, [customTimeEnd, customTimeStart, filterCategory, filterLevel, logLines, searchQuery, selectedModTag, timePeriod]);

  const selectedLine = useMemo(
    () => visibleLines.find((line) => getLineKey(line) === selectedLineKey) ?? null,
    [selectedLineKey, visibleLines],
  );

  const summaryCounts = useMemo(() => {
    let errors = 0;
    let warnings = 0;
    const mods = new Set<string>();
    for (const line of visibleLines) {
      const level = getEffectiveLevel(line);
      if (level === 'ERROR') errors += 1;
      if (level === 'WARN') warnings += 1;
      if (line.modTag) {
        mods.add(normalizeModTag(line.modTag));
      }
    }
    return {
      errors,
      warnings,
      mods: mods.size,
      visible: visibleLines.length,
    };
  }, [visibleLines]);

  const selectedModContext = useMemo(() => {
    const modTag = selectedLine?.modTag ?? selectedModTag;
    if (!modTag) return null;
    const normalized = normalizeModTag(modTag);
    const matching = logLines.filter((line) => line.modTag && normalizeModTag(line.modTag) === normalized);
    if (matching.length === 0) return null;
    return {
      modTag,
      count: matching.length,
      errorCount: matching.filter((line) => getEffectiveLevel(line) === 'ERROR').length,
      lastLogTime: matching[matching.length - 1]?.timestamp ?? null,
    };
  }, [logLines, selectedLine?.modTag, selectedModTag]);

  const selectedFilePath = selectedLogFile?.path ?? '';
  const isLiveFile = isLiveLogFile(selectedLogFile);
  const showCollapsedInspector = shouldCollapseInspector && isInspectorCollapsed;

  const reloadSelectedLogFile = async (logPath: string) => {
    try {
      setLoading(true);
      setError(null);
      const lines = await ApiService.readLogFile(logPath);
      setLogLines(lines);
      setSelectedLineKey(null);
      setAutoScroll(true);
      setIsAtBottom(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load log file');
      setLogLines([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!isOpen) return;

    let cancelled = false;
    const loadLogFiles = async () => {
      try {
        setLoading(true);
        setError(null);
        const files = await ApiService.getLogFiles(environmentId);
        if (cancelled) return;

        setLogFiles(files);
        setSelectedLogPath((current) => {
          if (current && files.some((file) => file.path === current)) {
            return current;
          }
          return (
            files.find((file) => file.isLatest)?.path
            ?? files.find((file) => isSharedPlayerLogFile(file))?.path
            ?? files[0]?.path
            ?? null
          );
        });
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to load log files');
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    };

    void loadLogFiles();

    return () => {
      cancelled = true;
    };
  }, [environmentId, isOpen]);

  useEffect(() => {
    const syncInspectorLayout = () => {
      const compact = window.innerWidth <= INSPECTOR_COLLAPSE_BREAKPOINT;
      setShouldCollapseInspector(compact);
      if (!compact) {
        setIsInspectorCollapsed(false);
      } else if (!selectedLineKey) {
        setIsInspectorCollapsed(true);
      }
    };

    syncInspectorLayout();
    window.addEventListener('resize', syncInspectorLayout);
    return () => window.removeEventListener('resize', syncInspectorLayout);
  }, [selectedLineKey]);

  useEffect(() => {
    if (!isOpen) return;
    return () => {
      if (toastTimeoutRef.current) {
        clearTimeout(toastTimeoutRef.current);
        toastTimeoutRef.current = null;
      }
    };
  }, [isOpen]);

  useEffect(() => {
    if (!selectedLogFile) return;

    let cancelled = false;
    const loadSelectedLogFile = async () => {
      try {
        setLoading(true);
        setError(null);
        const lines = await ApiService.readLogFile(selectedLogFile.path);
        if (cancelled) return;
        setLogLines(lines);
        setSelectedLineKey(null);
        setAutoScroll(true);
        setIsAtBottom(true);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to load log file');
          setLogLines([]);
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    };

    void loadSelectedLogFile();

    return () => {
      cancelled = true;
    };
  }, [selectedLogFile]);

  useEffect(() => {
    if (!selectedLogFile) return;

    const syncWatching = async () => {
      try {
        if (isLiveLogFile(selectedLogFile)) {
          if (watchedPath === selectedLogFile.path && isWatching) {
            return;
          }
          if (isWatching && watchedPath && watchedPath !== selectedLogFile.path) {
            await ApiService.stopWatchingLog();
          }
          await ApiService.watchLogFile(selectedLogFile.path);
          setIsWatching(true);
          setWatchedPath(selectedLogFile.path);
        } else if (isWatching) {
          await ApiService.stopWatchingLog();
          setIsWatching(false);
          setWatchedPath(null);
        }
      } catch (err) {
        console.error('Failed to synchronize live log watching:', err);
      }
    };

    void syncWatching();
  }, [isWatching, selectedLogFile, watchedPath]);

  useEffect(() => {
    if (!isWatching) return;

    let unlisten: (() => void) | null = null;
    const bindListener = async () => {
      unlisten = await listen<{ lines: LogLine[] }>('log-update', (event) => {
        setLogLines((current) => [...current, ...event.payload.lines]);
      });
    };

    void bindListener();

    return () => {
      if (unlisten) {
        unlisten();
      }
    };
  }, [isWatching]);

  useEffect(() => {
    if (selectedModTag && !modActivity.some((item) => normalizeModTag(item.modTag) === normalizeModTag(selectedModTag))) {
      setSelectedModTag(null);
    }
  }, [modActivity, selectedModTag]);

  useEffect(() => {
    if (selectedLineKey && !visibleLines.some((line) => getLineKey(line) === selectedLineKey)) {
      setSelectedLineKey(null);
    }
  }, [selectedLineKey, visibleLines]);

  useEffect(() => {
    if (shouldCollapseInspector && selectedLineKey) {
      setIsInspectorCollapsed(false);
    }
  }, [selectedLineKey, shouldCollapseInspector]);

  useEffect(() => {
    const container = logContainerRef.current;
    if (!container || !isLiveFile) return;
    if (autoScroll && isAtBottom) {
      container.scrollTop = container.scrollHeight;
    }
  }, [autoScroll, isAtBottom, isLiveFile, visibleLines.length]);

  useEffect(() => {
    if (!isOpen) return;
    return () => {
      if (isWatching) {
        void ApiService.stopWatchingLog().catch((err) => {
          console.error('Failed to stop watching log file:', err);
        });
      }
    };
  }, [isOpen, isWatching]);

  const handleScroll = () => {
    if (!logContainerRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = logContainerRef.current;
    const atBottom = Math.abs(scrollHeight - clientHeight - scrollTop) < 12;
    setIsAtBottom(atBottom);
    if (isLiveFile) {
      setAutoScroll(atBottom);
    }
  };

  const jumpToLive = () => {
    if (!logContainerRef.current) return;
    logContainerRef.current.scrollTo({ top: logContainerRef.current.scrollHeight, behavior: 'smooth' });
    setIsAtBottom(true);
    setAutoScroll(true);
  };

  const handleExport = async () => {
    if (!selectedLogFile) return;

    try {
      setExporting(true);
      const destination = await save({
        defaultPath: `meloader-logs-${new Date().toISOString().split('T')[0]}.txt`,
        filters: [{ name: 'Text Files', extensions: ['txt'] }],
      });
      if (!destination) return;

      await ApiService.exportLogs(
        selectedLogFile.path,
        filterLevel === 'ALL' ? null : filterLevel,
        filterCategory === 'ALL' ? null : filterCategory,
        searchQuery.trim() || null,
        selectedModTag,
        timePeriod === 'all' ? null : timePeriod,
        timePeriod === 'custom' ? customTimeStart.trim() || null : null,
        timePeriod === 'custom' ? customTimeEnd.trim() || null : null,
        destination,
      );
      showToast('Filtered logs exported successfully.');
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to export logs';
      setError(message);
      showToast(`Export failed: ${message}`);
    } finally {
      setExporting(false);
    }
  };

  const handleOpenModLibraryView = async (modTag: string) => {
    if (!onOpenModLibraryView) return;

    try {
      setOpeningModView(true);
      const library = await ApiService.getModLibrary();
      const normalizedTag = normalizeModTag(modTag);
      const remoteSources = new Set(['thunderstore', 'nexusmods', 'github']);
      const matches = library.downloaded.filter((entry) => {
        const source = entry.source ?? 'unknown';
        return remoteSources.has(source) && normalizeModTag(entry.displayName) === normalizedTag;
      });

      if (matches.length === 0) {
        showToast('No matching online/downloaded mod was found for this tag.');
        return;
      }

      const preferredMatch = matches.find((entry) => entry.installedIn?.includes(environmentId)) ?? matches[0];
      onOpenModLibraryView({
        storageId: preferredMatch.storageId,
        modTag,
      });
    } catch (err) {
      console.error('Failed to open mod library view from logs:', err);
      showToast('Failed to open the mod in Mod Library.');
    } finally {
      setOpeningModView(false);
    }
  };

  const handleCopySelectedLine = async () => {
    if (!selectedLine) return;
    try {
      await navigator.clipboard.writeText(selectedLine.content);
      showToast('Copied selected line.');
    } catch (err) {
      console.error('Failed to copy log line:', err);
      showToast('Copy failed.');
    }
  };

  const handleJumpToNewestRelevantLine = () => {
    const targetMod = selectedLine?.modTag ?? selectedModTag;
    const candidate = targetMod
      ? [...visibleLines].reverse().find((line) => line.modTag && normalizeModTag(line.modTag) === normalizeModTag(targetMod))
      : visibleLines[visibleLines.length - 1];

    if (!candidate) return;

    const key = getLineKey(candidate);
    setSelectedLineKey(key);
    rowRefs.current[key]?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  };

  const resetFilters = () => {
    setFilterLevel('ALL');
    setFilterCategory('ALL');
    setTimePeriod('all');
    setCustomTimeStart('');
    setCustomTimeEnd('');
    setSearchQuery('');
    setSelectedModTag(null);
  };

  const handleViewerKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (visibleLines.length === 0) return;
    const currentIndex = selectedLine ? visibleLines.findIndex((line) => getLineKey(line) === getLineKey(selectedLine)) : -1;

    if (event.key === 'ArrowDown') {
      event.preventDefault();
      const nextLine = visibleLines[Math.min(currentIndex + 1, visibleLines.length - 1)] ?? visibleLines[0];
      const nextKey = getLineKey(nextLine);
      setSelectedLineKey(nextKey);
      rowRefs.current[nextKey]?.scrollIntoView({ block: 'nearest' });
    }

    if (event.key === 'ArrowUp') {
      event.preventDefault();
      const nextLine = currentIndex <= 0 ? visibleLines[0] : visibleLines[currentIndex - 1];
      const nextKey = getLineKey(nextLine);
      setSelectedLineKey(nextKey);
      rowRefs.current[nextKey]?.scrollIntoView({ block: 'nearest' });
    }
  };

  if (!isOpen) return null;

  return (
    <div className="modal-content workspace-panel logs-panel">
      <div className="modal-header logs-panel__header">
        <div className="logs-panel__header-title">
          <div className="logs-panel__header-title-row">
            <h2>Logs</h2>
            <div className="logs-panel__header-pills">
              <span className="logs-panel__header-pill">{logFiles.length} Sources</span>
              <span className="logs-panel__header-pill">{modActivity.length} Mods</span>
            </div>
          </div>
          <p className="logs-panel__subtitle">
            Review live and archived environment logs for {environment.name}.
          </p>
        </div>
      </div>

      <div
        className={[
          'logs-panel__shell',
          shouldCollapseInspector ? 'logs-panel__shell--compact' : '',
          showCollapsedInspector ? 'logs-panel__shell--inspector-collapsed' : '',
        ].filter(Boolean).join(' ')}
      >
        <aside className="logs-panel__rail">
          <section className="logs-panel__rail-section logs-panel__rail-section--list">
            <div className="logs-panel__section-heading">
              <span>Current / Live</span>
            </div>
            <div className="logs-panel__source-list">
              {currentFiles.map((file) => (
                <button
                  key={file.path}
                  type="button"
                  className={`logs-panel__source-button ${selectedLogPath === file.path ? 'logs-panel__source-button--active' : ''}`}
                  onClick={() => setSelectedLogPath(file.path)}
                >
                  <div className="logs-panel__source-head">
                    <strong>{file.name}</strong>
                    <div className="logs-panel__source-badges">
                      {file.isLatest && <span className="logs-panel__badge logs-panel__badge--live">Live</span>}
                      {isSharedPlayerLogFile(file) && <span className="logs-panel__badge">Shared</span>}
                    </div>
                  </div>
                  <span>{formatFileSize(file.size)}</span>
                  <span>{file.modified ? new Date(file.modified).toLocaleDateString() : 'Unknown date'}</span>
                </button>
              ))}
              {!loading && currentFiles.length === 0 && (
                <div className="logs-panel__empty-small">No current log files.</div>
              )}
            </div>
          </section>

          <section className="logs-panel__rail-section logs-panel__rail-section--list">
            <div className="logs-panel__section-heading">
              <span>Archived Logs</span>
            </div>
            <div className="logs-panel__source-list">
              {archivedFiles.map((file) => (
                <button
                  key={file.path}
                  type="button"
                  className={`logs-panel__source-button ${selectedLogPath === file.path ? 'logs-panel__source-button--active' : ''}`}
                  onClick={() => setSelectedLogPath(file.path)}
                >
                  <div className="logs-panel__source-head">
                    <strong>{file.name}</strong>
                  </div>
                  <span>{formatFileSize(file.size)}</span>
                  <span>{file.modified ? new Date(file.modified).toLocaleDateString() : 'Unknown date'}</span>
                </button>
              ))}
              {!loading && archivedFiles.length === 0 && (
                <div className="logs-panel__empty-small">No archived log files.</div>
              )}
            </div>
          </section>

          <section className="logs-panel__rail-section logs-panel__rail-section--list">
            <div className="logs-panel__section-heading">
              <span>Mod Activity</span>
              {selectedModTag && (
                <button type="button" className="logs-panel__clear-link" onClick={() => setSelectedModTag(null)}>
                  Clear
                </button>
              )}
            </div>
            <div className="logs-panel__mod-activity">
              {modActivity.map((item) => (
                <button
                  key={item.modTag}
                  type="button"
                  className={`logs-panel__mod-button ${selectedModTag && normalizeModTag(selectedModTag) === normalizeModTag(item.modTag) ? 'logs-panel__mod-button--active' : ''}`}
                  onClick={() => setSelectedModTag((current) => (current && normalizeModTag(current) === normalizeModTag(item.modTag) ? null : item.modTag))}
                  style={getModAccentStyle(item.modTag)}
                >
                  <div className="logs-panel__mod-head">
                    <span>{item.modTag}</span>
                    <strong>{item.count}</strong>
                  </div>
                  <div className="logs-panel__mod-meta">
                    <span>{item.errorCount} errors</span>
                    <span>{formatRelativeTime(item.lastLogTime)}</span>
                  </div>
                </button>
              ))}
              {!loading && modActivity.length === 0 && (
                <div className="logs-panel__empty-small">No mod-tagged lines in this file.</div>
              )}
            </div>
          </section>
        </aside>

        <section className="logs-panel__viewer">
          <header className="logs-panel__viewer-header">
            <div>
              <span className="settings-eyebrow">Selected File</span>
              <div className="logs-panel__viewer-title-row">
                <h3>{selectedLogFile?.name ?? 'No log file selected'}</h3>
                {isLiveFile && <span className="logs-panel__badge logs-panel__badge--live">Follow Live</span>}
                {selectedLogFile && isSharedPlayerLogFile(selectedLogFile) && <span className="logs-panel__badge">Shared Player.log</span>}
              </div>
              <p className="logs-panel__file-meta">
                {selectedLogFile
                  ? `${formatModifiedDate(selectedLogFile.modified)} • ${formatFileSize(selectedLogFile.size)} • ${formatVisibleCount(logLines.length)} loaded`
                  : 'Choose a log source from the rail.'}
              </p>
            </div>
            <div className="logs-panel__header-actions">
              <button type="button" className="btn btn-secondary" onClick={() => selectedLogFile && void ApiService.openPath(selectedFilePath)} disabled={!selectedLogFile}>
                <i className="fas fa-file-lines"></i>
                Open File
              </button>
              <button type="button" className="btn btn-secondary" onClick={() => selectedLogFile && void ApiService.revealPath(selectedFilePath)} disabled={!selectedLogFile}>
                <i className="fas fa-folder-open"></i>
                Open Folder
              </button>
              <button type="button" className="btn btn-secondary" onClick={() => selectedLogFile && void reloadSelectedLogFile(selectedLogFile.path)} disabled={!selectedLogFile || loading}>
                <i className={loading ? 'fas fa-spinner fa-spin' : 'fas fa-rotate'}></i>
                Reload
              </button>
              <button type="button" className="btn btn-primary" onClick={() => void handleExport()} disabled={!selectedLogFile || exporting}>
                <i className={exporting ? 'fas fa-spinner fa-spin' : 'fas fa-download'}></i>
                {exporting ? 'Exporting…' : 'Export'}
              </button>
            </div>
          </header>

          <div className="logs-panel__utility-bar">
            <div className="logs-panel__toolbar">
              <div className="logs-panel__toolbar-group logs-panel__toolbar-group--search">
                <i className="fas fa-search"></i>
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(event) => setSearchQuery(event.target.value)}
                  placeholder="Search log lines"
                />
              </div>

              <div className="logs-panel__toolbar-group">
                <label htmlFor="logs-level-filter">Level</label>
                <select id="logs-level-filter" value={filterLevel} onChange={(event) => setFilterLevel(event.target.value as LogLevelFilter)}>
                  <option value="ALL">All Levels</option>
                  <option value="ERROR">Error</option>
                  <option value="WARN">Warning</option>
                  <option value="INFO">Info</option>
                  <option value="DEBUG">Debug</option>
                </select>
              </div>

              <div className="logs-panel__toolbar-group">
                <label htmlFor="logs-category-filter">Category</label>
                <select id="logs-category-filter" value={filterCategory} onChange={(event) => setFilterCategory(event.target.value as LogCategoryFilter)}>
                  <option value="ALL">All Categories</option>
                  <option value="melonloader">MelonLoader</option>
                  <option value="mod">Mods</option>
                  <option value="general">General</option>
                </select>
              </div>

              <div className="logs-panel__toolbar-group">
                <label htmlFor="logs-time-filter">Time</label>
                <select id="logs-time-filter" value={timePeriod} onChange={(event) => setTimePeriod(event.target.value as TimePeriod)}>
                  <option value="all">All Time</option>
                  <option value="last5min">Last 5 Minutes</option>
                  <option value="last15min">Last 15 Minutes</option>
                  <option value="last1hour">Last Hour</option>
                  <option value="custom">Custom Range</option>
                </select>
              </div>

              {timePeriod === 'custom' && (
                <div className="logs-panel__toolbar-group logs-panel__toolbar-group--custom">
                  <input
                    type="text"
                    value={customTimeStart}
                    onChange={(event) => setCustomTimeStart(event.target.value)}
                    placeholder="Start HH:MM:SS.mmm"
                  />
                  <input
                    type="text"
                    value={customTimeEnd}
                    onChange={(event) => setCustomTimeEnd(event.target.value)}
                    placeholder="End HH:MM:SS.mmm"
                  />
                </div>
              )}

              {selectedModTag && (
                <button type="button" className="logs-panel__active-filter" onClick={() => setSelectedModTag(null)} style={getModAccentStyle(selectedModTag)}>
                  <span>Mod: {selectedModTag}</span>
                  <i className="fas fa-times"></i>
                </button>
              )}

              {isLiveFile && (
                <button
                  type="button"
                  className={`logs-panel__follow-toggle ${autoScroll ? 'logs-panel__follow-toggle--active' : ''}`}
                  onClick={() => {
                    if (autoScroll) {
                      setAutoScroll(false);
                      return;
                    }
                    jumpToLive();
                  }}
                >
                  <i className={`fas ${autoScroll ? 'fa-pause' : 'fa-play'}`}></i>
                  {autoScroll ? 'Pause Live' : 'Follow Live'}
                </button>
              )}
            </div>

            <div className="logs-panel__summary">
              <div className="logs-panel__summary-metrics">
                <div className="logs-panel__summary-pill">
                  <span>Errors</span>
                  <strong>{summaryCounts.errors}</strong>
                </div>
                <div className="logs-panel__summary-pill">
                  <span>Warnings</span>
                  <strong>{summaryCounts.warnings}</strong>
                </div>
                <div className="logs-panel__summary-pill">
                  <span>Mods</span>
                  <strong>{summaryCounts.mods}</strong>
                </div>
                <div className="logs-panel__summary-pill">
                  <span>Visible Lines</span>
                  <strong>{summaryCounts.visible}</strong>
                </div>
              </div>
              <div className="logs-panel__summary-actions">
                <button type="button" className="btn btn-secondary btn-small" onClick={() => setFilterLevel('ERROR')}>
                  Show Errors
                </button>
                <button type="button" className="btn btn-secondary btn-small" onClick={() => setFilterLevel('WARN')}>
                  Show Warnings
                </button>
                <button type="button" className="btn btn-secondary btn-small" onClick={resetFilters}>
                  Reset Filters
                </button>
              </div>
            </div>
          </div>

          <div className="logs-panel__viewer-body">
            <div
              ref={logContainerRef}
              className="logs-panel__stream"
              onKeyDown={handleViewerKeyDown}
              onScroll={handleScroll}
              tabIndex={0}
              role="listbox"
              aria-label="Log lines"
            >
              {error ? (
                <div className="logs-panel__empty-state logs-panel__empty-state--error">
                  <i className="fas fa-triangle-exclamation"></i>
                  <strong>Failed to load logs</strong>
                  <p>{error}</p>
                </div>
              ) : loading && logLines.length === 0 ? (
                <div className="logs-panel__empty-state">
                  <i className="fas fa-spinner fa-spin"></i>
                  <strong>Loading log file</strong>
                  <p>Fetching the latest lines for this environment.</p>
                </div>
              ) : !selectedLogFile ? (
                <div className="logs-panel__empty-state">
                  <i className="fas fa-file-lines"></i>
                  <strong>Select a log source</strong>
                  <p>Choose a live or archived log from the rail to begin reviewing output.</p>
                </div>
              ) : visibleLines.length === 0 ? (
                <div className="logs-panel__empty-state">
                  <i className={`fas ${logLines.length === 0 ? 'fa-wave-square' : 'fa-filter-circle-xmark'}`}></i>
                  <strong>{logLines.length === 0 ? 'No log content yet' : 'No lines match the current filters'}</strong>
                  <p>
                    {logLines.length === 0
                      ? (isLiveFile ? 'Live file selected. New lines will appear here when the game writes output.' : 'This file is present but does not contain readable log lines.')
                      : 'Adjust the filters, search, or mod scope to widen the result set.'}
                  </p>
                </div>
              ) : (
                visibleLines.map((line) => {
                  const key = getLineKey(line);
                  const effectiveLevel = getEffectiveLevel(line);
                  const isSelected = key === selectedLineKey;
                  return (
                    <div
                      key={key}
                      ref={(element) => {
                        rowRefs.current[key] = element;
                      }}
                      role="option"
                      aria-selected={isSelected}
                      tabIndex={-1}
                      className={`logs-panel__line ${isSelected ? 'logs-panel__line--selected' : ''}`}
                      onClick={() => setSelectedLineKey(key)}
                      onDoubleClick={() => {
                        setSelectedLineKey(key);
                        if (line.modTag) {
                          setSelectedModTag(line.modTag);
                        }
                      }}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault();
                          setSelectedLineKey(key);
                        }
                      }}
                    >
                      <div className="logs-panel__line-meta">
                        <div className="logs-panel__line-meta-main">
                          <span className="logs-panel__line-number">{line.lineNumber}</span>
                          <span className="logs-panel__line-timestamp">{line.timestamp ?? '—'}</span>
                          <span className={`logs-panel__line-level logs-panel__line-level--${effectiveLevel.toLowerCase()}`}>
                            {getLevelLabel(effectiveLevel)}
                          </span>
                          <span className={`logs-panel__line-category logs-panel__line-category--${line.category}`}>
                            <i className={`fas ${getCategoryIcon(line.category)}`}></i>
                            {getCategoryLabel(line.category)}
                          </span>
                        </div>
                        {line.modTag && (
                          <button
                            type="button"
                            className="logs-panel__mod-chip"
                            style={getModAccentStyle(line.modTag)}
                            onClick={(event) => {
                              event.stopPropagation();
                              setSelectedModTag(line.modTag);
                              setSelectedLineKey(key);
                            }}
                          >
                            {line.modTag}
                          </button>
                        )}
                      </div>
                      <div className="logs-panel__line-content">{highlightText(line.content, searchQuery)}</div>
                    </div>
                  );
                })
              )}
            </div>
            {!isAtBottom && isLiveFile && (
              <div className="logs-panel__jump-live-overlay">
                <button type="button" className="logs-panel__jump-live-button" onClick={jumpToLive}>
                  <i className="fas fa-arrow-down"></i>
                  Jump to Live
                </button>
              </div>
            )}
          </div>
        </section>

        <aside className={`logs-panel__inspector ${showCollapsedInspector ? 'logs-panel__inspector--collapsed' : ''}`}>
          <div className="logs-panel__inspector-toolbar">
            <span className="settings-eyebrow">Inspector</span>
            {shouldCollapseInspector && (
              <button
                type="button"
                className="btn btn-secondary btn-small"
                onClick={() => setIsInspectorCollapsed((current) => !current)}
                aria-label={showCollapsedInspector ? 'Expand Inspector' : 'Collapse Inspector'}
              >
                <i className={`fas ${showCollapsedInspector ? 'fa-angles-left' : 'fa-angles-right'}`}></i>
                {showCollapsedInspector ? 'Expand' : 'Collapse'}
              </button>
            )}
          </div>

          {showCollapsedInspector ? (
            <section className="logs-panel__inspector-card logs-panel__inspector-card--collapsed">
              {selectedLine ? (
                <>
                  <div className="logs-panel__section-inline-title">
                    <span className="settings-eyebrow">Selected Entry</span>
                  </div>
                  <div className="logs-panel__inspector-head logs-panel__inspector-head--stacked">
                    <h3>Line {selectedLine.lineNumber}</h3>
                    <span className={`logs-panel__line-level logs-panel__line-level--${getEffectiveLevel(selectedLine).toLowerCase()}`}>
                      {getLevelLabel(getEffectiveLevel(selectedLine))}
                    </span>
                  </div>
                  <div className="logs-panel__inspector-meta">
                    <span>{selectedLine.timestamp ?? 'No timestamp'}</span>
                    <span>{getCategoryLabel(selectedLine.category)}</span>
                  </div>
                  {selectedLine.modTag && (
                    <span className="logs-panel__badge logs-panel__badge--summary" style={getModAccentStyle(selectedLine.modTag)}>
                      {selectedLine.modTag}
                    </span>
                  )}
                  <p className="logs-panel__context-note">Selection ready. Expand to inspect, copy, or open related mod context.</p>
                </>
              ) : (
                <>
                  <div className="logs-panel__inspector-placeholder logs-panel__inspector-placeholder--compact">
                    <h3>No selection</h3>
                    <p>Select a line to inspect it.</p>
                  </div>
                  <div className="logs-panel__summary-mini">
                    <div>
                      <span>Errors</span>
                      <strong>{summaryCounts.errors}</strong>
                    </div>
                    <div>
                      <span>Warnings</span>
                      <strong>{summaryCounts.warnings}</strong>
                    </div>
                    <div>
                      <span>Mods</span>
                      <strong>{summaryCounts.mods}</strong>
                    </div>
                    <div>
                      <span>Lines</span>
                      <strong>{summaryCounts.visible}</strong>
                    </div>
                  </div>
                </>
              )}
            </section>
          ) : (
            <>
              <section className="logs-panel__inspector-card">
                <div className="logs-panel__section-inline-title">
                  <span className="settings-eyebrow">Selected Entry</span>
                </div>
                {selectedLine ? (
                  <>
                    <div className="logs-panel__inspector-head">
                      <h3>Line {selectedLine.lineNumber}</h3>
                      <span className={`logs-panel__line-level logs-panel__line-level--${getEffectiveLevel(selectedLine).toLowerCase()}`}>
                        {getLevelLabel(getEffectiveLevel(selectedLine))}
                      </span>
                    </div>
                    <div className="logs-panel__inspector-meta">
                      <span>{selectedLine.timestamp ?? 'No timestamp'}</span>
                      <span>{getCategoryLabel(selectedLine.category)}</span>
                    </div>
                    <pre className="logs-panel__inspector-content">{selectedLine.content}</pre>
                  </>
                ) : (
                  <>
                    <div className="logs-panel__inspector-placeholder">
                      <h3>No entry selected</h3>
                      <p>Select a log line to inspect it, copy it, or focus its mod context.</p>
                    </div>
                    <div className="logs-panel__summary-mini">
                      <div>
                        <span>Errors</span>
                        <strong>{summaryCounts.errors}</strong>
                      </div>
                      <div>
                        <span>Warnings</span>
                        <strong>{summaryCounts.warnings}</strong>
                      </div>
                      <div>
                        <span>Mods</span>
                        <strong>{summaryCounts.mods}</strong>
                      </div>
                      <div>
                        <span>Lines</span>
                        <strong>{summaryCounts.visible}</strong>
                      </div>
                    </div>
                  </>
                )}
                <div className="logs-panel__quick-actions logs-panel__quick-actions--compact">
                  <button type="button" className="btn btn-secondary" onClick={() => void handleCopySelectedLine()} disabled={!selectedLine}>
                    <i className="fas fa-copy"></i>
                    Copy Line
                  </button>
                  <button
                    type="button"
                    className="btn btn-secondary"
                    onClick={() => selectedLine?.modTag && setSelectedModTag(selectedLine.modTag)}
                    disabled={!selectedLine?.modTag}
                  >
                    <i className="fas fa-filter"></i>
                    Filter to Mod
                  </button>
                  <button type="button" className="btn btn-secondary" onClick={() => setSelectedModTag(null)} disabled={!selectedModTag}>
                    <i className="fas fa-filter-circle-xmark"></i>
                    Clear Filter
                  </button>
                  <button type="button" className="btn btn-secondary" onClick={handleJumpToNewestRelevantLine} disabled={visibleLines.length === 0}>
                    <i className="fas fa-arrow-down"></i>
                    Jump to Live
                  </button>
                </div>
              </section>

              <section className="logs-panel__inspector-card">
                <div className="logs-panel__section-inline-title">
                  <span className="settings-eyebrow">Context</span>
                </div>
                {selectedLogFile ? (
                  <>
                    <div className="logs-panel__inspector-head">
                      <h3>File Context</h3>
                      <div className="logs-panel__inspector-meta logs-panel__inspector-meta--badges">
                        {selectedLogFile.isLatest && <span>Latest</span>}
                        {isSharedPlayerLogFile(selectedLogFile) && <span>Shared</span>}
                        {isLiveFile && <span>Live</span>}
                      </div>
                    </div>
                    <p className="logs-panel__context-note">{selectedLogFile.name}</p>
                    <p className="logs-panel__file-path" title={selectedLogFile.path}>
                      {selectedLogFile.path}
                    </p>
                    {selectedModContext ? (
                      <div className="logs-panel__context-block">
                        <div className="logs-panel__inspector-head">
                          <h3>{selectedModContext.modTag}</h3>
                          <span className="logs-panel__badge">{selectedModContext.count} hits</span>
                        </div>
                        <div className="logs-panel__inspector-metrics">
                          <div>
                            <span>Errors</span>
                            <strong>{selectedModContext.errorCount}</strong>
                          </div>
                          <div>
                            <span>Last Seen</span>
                            <strong>{formatRelativeTime(selectedModContext.lastLogTime)}</strong>
                          </div>
                        </div>
                        <button
                          type="button"
                          className="btn btn-secondary"
                          onClick={() => void handleOpenModLibraryView(selectedModContext.modTag)}
                          disabled={openingModView || !onOpenModLibraryView}
                        >
                          <i className="fas fa-layer-group"></i>
                          {openingModView ? 'Opening…' : 'Open in Mod Library'}
                        </button>
                      </div>
                    ) : (
                      <p className="logs-panel__context-note">No mod tag is associated with the current selection.</p>
                    )}
                  </>
                ) : (
                  <p>No file selected.</p>
                )}
              </section>
            </>
          )}
        </aside>
      </div>

      {toastMessage && (
        <div className="logs-panel__toast" role="status" aria-live="polite">
          {toastMessage}
        </div>
      )}
    </div>
  );
}
