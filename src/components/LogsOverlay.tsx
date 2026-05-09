import { memo, type CSSProperties, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { save } from '@tauri-apps/plugin-dialog';

import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

import { ApiService } from '../services/api';
import type { Environment } from '../types';
import { Icon } from './Icon';
import { SimmBadge, SimmButton } from './primitives';
import { WorkspacePageHeader } from './WorkspacePageHeader';

const INSPECTOR_COLLAPSE_BREAKPOINT = 1240;
const INITIAL_LOG_LINE_LIMIT = 4000;
const LOG_FILE_CACHE_LIMIT = 10;
const LOG_ROW_ESTIMATED_HEIGHT = 58;
const LOG_ROW_OVERSCAN = 14;

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

interface CachedLogFile {
  size: number;
  modified: string | null;
  lines: LogLine[];
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

type LogsSelectOption<TValue extends string> = {
  value: TValue;
  label: string;
};

const LOG_LEVEL_OPTIONS: LogsSelectOption<LogLevelFilter>[] = [
  { value: 'ALL', label: 'All Levels' },
  { value: 'ERROR', label: 'Error' },
  { value: 'WARN', label: 'Warning' },
  { value: 'INFO', label: 'Info' },
  { value: 'DEBUG', label: 'Debug' },
];

const LOG_CATEGORY_OPTIONS: LogsSelectOption<LogCategoryFilter>[] = [
  { value: 'ALL', label: 'All Categories' },
  { value: 'melonloader', label: 'MelonLoader' },
  { value: 'mod', label: 'Mods' },
  { value: 'general', label: 'General' },
];

const TIME_PERIOD_OPTIONS: LogsSelectOption<TimePeriod>[] = [
  { value: 'all', label: 'All Time' },
  { value: 'last5min', label: 'Last 5 Minutes' },
  { value: 'last15min', label: 'Last 15 Minutes' },
  { value: 'last1hour', label: 'Last Hour' },
  { value: 'custom', label: 'Custom Range' },
];

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

function areLogLinesEqual(left: LogLine[], right: LogLine[]): boolean {
  if (left === right) return true;
  if (left.length !== right.length) return false;

  for (let index = 0; index < left.length; index += 1) {
    const leftLine = left[index];
    const rightLine = right[index];
    if (
      leftLine.lineNumber !== rightLine.lineNumber
      || leftLine.content !== rightLine.content
      || leftLine.level !== rightLine.level
      || leftLine.timestamp !== rightLine.timestamp
      || leftLine.modTag !== rightLine.modTag
      || leftLine.category !== rightLine.category
    ) {
      return false;
    }
  }

  return true;
}

function LogsToolbarSelect<TValue extends string>({
  id,
  value,
  options,
  onValueChange,
}: {
  id: string;
  value: TValue;
  options: LogsSelectOption<TValue>[];
  onValueChange: (value: TValue) => void;
}) {
  return (
    <Select
      value={value}
      onValueChange={(nextValue) => {
        if (typeof nextValue === 'string') {
          onValueChange(nextValue as TValue);
        }
      }}
    >
      <SelectTrigger id={id} className="logs-panel__select">
        <SelectValue>
          {(selectedValue) =>
            options.find((option) => option.value === selectedValue)?.label
            || options.find((option) => option.value === value)?.label
            || options[0]?.label
          }
        </SelectValue>
      </SelectTrigger>
      <SelectContent className="logs-panel__select-content" align="start">
        <SelectGroup>
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  );
}

function areLogFilesEqual(left: LogFile[], right: LogFile[]): boolean {
  if (left === right) return true;
  if (left.length !== right.length) return false;

  for (let index = 0; index < left.length; index += 1) {
    const leftFile = left[index];
    const rightFile = right[index];
    if (
      leftFile.name !== rightFile.name
      || leftFile.path !== rightFile.path
      || leftFile.size !== rightFile.size
      || leftFile.modified !== rightFile.modified
      || leftFile.isLatest !== rightFile.isLatest
    ) {
      return false;
    }
  }

  return true;
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

const LogStreamRow = memo(function LogStreamRow({
  line,
  searchQuery,
  selected,
  setRowRef,
  onModFilter,
  onSelect,
}: {
  line: LogLine;
  searchQuery: string;
  selected: boolean;
  setRowRef: (key: string, element: HTMLDivElement | null) => void;
  onModFilter: (line: LogLine, key: string) => void;
  onSelect: (key: string) => void;
}) {
  const key = getLineKey(line);
  const effectiveLevel = getEffectiveLevel(line);

  return (
    <div
      ref={(element) => {
        setRowRef(key, element);
      }}
      role="option"
      aria-selected={selected}
      tabIndex={-1}
      className={`logs-panel__line ${selected ? 'logs-panel__line--selected' : ''}`}
      onClick={() => onSelect(key)}
      onDoubleClick={() => {
        onSelect(key);
        if (line.modTag) {
          onModFilter(line, key);
        }
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onSelect(key);
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
            <Icon name={`fas ${getCategoryIcon(line.category)}`} />
            {getCategoryLabel(line.category)}
          </span>
        </div>
        {line.modTag ? (
          <SimmButton
            type="button"
            variant="ghost"
            size="xs"
            className="logs-panel__mod-chip"
            style={getModAccentStyle(line.modTag)}
            onClick={(event) => {
              event.stopPropagation();
              onModFilter(line, key);
            }}
          >
            {line.modTag}
          </SimmButton>
        ) : null}
      </div>
      <div className="logs-panel__line-content">{highlightText(line.content, searchQuery)}</div>
    </div>
  );
});

const LogStream = memo(function LogStream({
  containerRef,
  error,
  isLiveFile,
  loading,
  logLineCount,
  onKeyDown,
  onModFilter,
  onScrollStateChange,
  onSelectLine,
  rowRefs,
  searchQuery,
  selectedLineKey,
  selectedLogFile,
  visibleLines,
}: {
  containerRef: React.MutableRefObject<HTMLDivElement | null>;
  error: string | null;
  isLiveFile: boolean;
  loading: boolean;
  logLineCount: number;
  onKeyDown: (event: React.KeyboardEvent<HTMLDivElement>) => void;
  onModFilter: (line: LogLine, key: string) => void;
  onScrollStateChange: (atBottom: boolean) => void;
  onSelectLine: (key: string) => void;
  rowRefs: React.MutableRefObject<Record<string, HTMLDivElement | null>>;
  searchQuery: string;
  selectedLineKey: string | null;
  selectedLogFile: LogFile | null;
  visibleLines: LogLine[];
}) {
  const [scrollMetrics, setScrollMetrics] = useState({ top: 0, height: 0 });
  const scrollFrameRef = useRef<number | null>(null);

  const updateScrollMetrics = useCallback((container: HTMLDivElement) => {
    const nextTop = container.scrollTop;
    const nextHeight = container.clientHeight;
    setScrollMetrics((current) => (
      current.top === nextTop && current.height === nextHeight
        ? current
        : { top: nextTop, height: nextHeight }
    ));
  }, []);

  const handleScroll = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;

    const { scrollTop, scrollHeight, clientHeight } = container;
    onScrollStateChange(Math.abs(scrollHeight - clientHeight - scrollTop) < 12);

    if (scrollFrameRef.current !== null) {
      return;
    }

    scrollFrameRef.current = requestAnimationFrame(() => {
      scrollFrameRef.current = null;
      updateScrollMetrics(container);
    });
  }, [containerRef, onScrollStateChange, updateScrollMetrics]);

  const setRowRef = useCallback((key: string, element: HTMLDivElement | null) => {
    rowRefs.current[key] = element;
  }, [rowRefs]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const syncViewport = () => updateScrollMetrics(container);

    syncViewport();
    if (typeof ResizeObserver !== 'undefined') {
      const resizeObserver = new ResizeObserver(syncViewport);
      resizeObserver.observe(container);
      return () => resizeObserver.disconnect();
    }

    window.addEventListener('resize', syncViewport);
    return () => window.removeEventListener('resize', syncViewport);
  }, [containerRef, selectedLogFile?.path, updateScrollMetrics]);

  useEffect(() => () => {
    if (scrollFrameRef.current !== null) {
      cancelAnimationFrame(scrollFrameRef.current);
      scrollFrameRef.current = null;
    }
  }, []);

  const effectiveStreamViewportHeight = scrollMetrics.height > 0 ? scrollMetrics.height : 720;
  const virtualStartIndex = Math.max(0, Math.floor(scrollMetrics.top / LOG_ROW_ESTIMATED_HEIGHT) - LOG_ROW_OVERSCAN);
  const virtualEndIndex = Math.min(
    visibleLines.length,
    Math.ceil((scrollMetrics.top + effectiveStreamViewportHeight) / LOG_ROW_ESTIMATED_HEIGHT) + LOG_ROW_OVERSCAN,
  );
  const virtualLines = visibleLines.slice(virtualStartIndex, virtualEndIndex);
  const virtualTopPadding = virtualStartIndex * LOG_ROW_ESTIMATED_HEIGHT;
  const virtualBottomPadding = Math.max(0, (visibleLines.length - virtualEndIndex) * LOG_ROW_ESTIMATED_HEIGHT);

  return (
    <div
      ref={containerRef}
      className="logs-panel__stream"
      onKeyDown={onKeyDown}
      onScroll={handleScroll}
      tabIndex={0}
      role="listbox"
      aria-label="Log lines"
    >
      {error ? (
        <div className="logs-panel__empty-state logs-panel__empty-state--error">
          <Icon name="fas fa-triangle-exclamation" />
          <strong>Failed to load logs</strong>
          <p>{error}</p>
        </div>
      ) : loading && logLineCount === 0 ? (
        <div className="logs-panel__empty-state">
          <Icon name="fas fa-spinner fa-spin" />
          <strong>Loading log file</strong>
          <p>Fetching the latest lines for this environment.</p>
        </div>
      ) : !selectedLogFile ? (
        <div className="logs-panel__empty-state">
          <Icon name="fas fa-file-lines" />
          <strong>Select a log source</strong>
          <p>Choose a live or archived log from the rail to begin reviewing output.</p>
        </div>
      ) : visibleLines.length === 0 ? (
        <div className="logs-panel__empty-state">
          <Icon name={`fas ${logLineCount === 0 ? 'fa-wave-square' : 'fa-filter-circle-xmark'}`} />
          <strong>{logLineCount === 0 ? 'No log content yet' : 'No lines match the current filters'}</strong>
          <p>
            {logLineCount === 0
              ? (isLiveFile ? 'Live file selected. New lines will appear here when the game writes output.' : 'This file is present but does not contain readable log lines.')
              : 'Adjust the filters, search, or mod scope to widen the result set.'}
          </p>
        </div>
      ) : (
        <>
          {virtualTopPadding > 0 ? (
            <div
              aria-hidden="true"
              className="logs-panel__virtual-spacer"
              style={{ height: virtualTopPadding }}
            />
          ) : null}
          {virtualLines.map((line) => {
            const key = getLineKey(line);
            return (
              <LogStreamRow
                key={key}
                line={line}
                searchQuery={searchQuery}
                selected={key === selectedLineKey}
                setRowRef={setRowRef}
                onModFilter={onModFilter}
                onSelect={onSelectLine}
              />
            );
          })}
          {virtualBottomPadding > 0 ? (
            <div
              aria-hidden="true"
              className="logs-panel__virtual-spacer"
              style={{ height: virtualBottomPadding }}
            />
          ) : null}
        </>
      )}
    </div>
  );
});

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
  const logFileCacheRef = useRef<Map<string, CachedLogFile>>(new Map());
  const displayedLogPathRef = useRef<string | null>(null);

  const selectedLogFile = useMemo(
    () => logFiles.find((file) => file.path === selectedLogPath) ?? null,
    [logFiles, selectedLogPath],
  );

  const isSharedPlayerLogFile = (file: LogFile | null): boolean => {
    if (!file) return false;
    const normalizedPath = file.path.replace(/\\/g, '/').toLowerCase();
    return normalizedPath.endsWith('/player.log') || normalizedPath.endsWith('/player-prev.log');
  };

  const isLiveLogFile = useCallback((file: LogFile | null): boolean => {
    if (!file) return false;
    const normalizedPath = file.path.replace(/\\/g, '/').toLowerCase();
    return file.isLatest || normalizedPath.endsWith('/player.log');
  }, []);

  const getCachedLogLines = useCallback((file: LogFile): LogLine[] | null => {
    const cached = logFileCacheRef.current.get(file.path);
    if (!cached) return null;

    if (cached.size !== file.size || cached.modified !== file.modified) {
      logFileCacheRef.current.delete(file.path);
      return null;
    }

    logFileCacheRef.current.delete(file.path);
    logFileCacheRef.current.set(file.path, cached);
    return cached.lines;
  }, []);

  const cacheLogLines = useCallback((file: LogFile, lines: LogLine[]): LogLine[] => {
    const existing = logFileCacheRef.current.get(file.path);
    const stableLines = existing && areLogLinesEqual(existing.lines, lines) ? existing.lines : lines;

    logFileCacheRef.current.set(file.path, {
      size: file.size,
      modified: file.modified,
      lines: stableLines,
    });

    while (logFileCacheRef.current.size > LOG_FILE_CACHE_LIMIT) {
      const oldestPath = logFileCacheRef.current.keys().next().value;
      if (!oldestPath) break;
      logFileCacheRef.current.delete(oldestPath);
    }

    return stableLines;
  }, []);

  const resetLogViewport = useCallback(() => {
    setSelectedLineKey(null);
  }, []);

  const showLogLines = useCallback((lines: LogLine[], logPath: string) => {
    displayedLogPathRef.current = logPath;
    setLogLines((current) => (areLogLinesEqual(current, lines) ? current : lines));
    setAutoScroll(true);
    setIsAtBottom(true);
    requestAnimationFrame(() => {
      if (logContainerRef.current) {
        logContainerRef.current.scrollTop = logContainerRef.current.scrollHeight;
      }
    });
  }, []);

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

  const scrollLineIntoView = (line: LogLine, block: ScrollLogicalPosition = 'nearest') => {
    const key = getLineKey(line);
    const renderedRow = rowRefs.current[key];
    if (renderedRow) {
      renderedRow.scrollIntoView({ block });
      return;
    }

    const targetIndex = visibleLines.findIndex((candidate) => getLineKey(candidate) === key);
    if (targetIndex >= 0 && logContainerRef.current) {
      logContainerRef.current.scrollTo({
        top: Math.max(0, targetIndex * LOG_ROW_ESTIMATED_HEIGHT - LOG_ROW_ESTIMATED_HEIGHT),
        behavior: 'auto',
      });
    }
  };

  useEffect(() => {
    setLogFiles([]);
    setSelectedLogPath(null);
    setLogLines([]);
    setSelectedLineKey(null);
    setLoading(false);
    setError(null);
    setSelectedModTag(null);
    setExporting(false);
    setOpeningModView(false);
    setAutoScroll(true);
    setIsAtBottom(true);
    displayedLogPathRef.current = null;
    logFileCacheRef.current.clear();

    if (toastTimeoutRef.current) {
      clearTimeout(toastTimeoutRef.current);
      toastTimeoutRef.current = null;
    }
    setToastMessage(null);

    if (isWatching || watchedPath) {
      void ApiService.stopWatchingLog().catch((err) => {
        console.error('Failed to stop watching log file during environment switch:', err);
      });
    }
    setIsWatching(false);
    setWatchedPath(null);
  }, [environmentId]);

  const reloadSelectedLogFile = async (logPath: string) => {
    const file = logFiles.find((item) => item.path === logPath) ?? null;

    try {
      setLoading(true);
      setError(null);
      resetLogViewport();
      setLogLines([]);
      const lines = await ApiService.readLogFile(logPath, INITIAL_LOG_LINE_LIMIT);
      const stableLines = file ? cacheLogLines(file, lines) : lines;
      showLogLines(stableLines, logPath);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load log file');
      displayedLogPathRef.current = null;
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

        setLogFiles((current) => (areLogFilesEqual(current, files) ? current : files));
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
      resetLogViewport();
      setError(null);

      const cachedLines = getCachedLogLines(selectedLogFile);
      if (cachedLines) {
        setLoading(false);
        showLogLines(cachedLines, selectedLogFile.path);
        if (!isLiveLogFile(selectedLogFile)) {
          return;
        }
      }

      try {
        if (!cachedLines) {
          setLoading(true);
        }
        if (!cachedLines && displayedLogPathRef.current !== selectedLogFile.path) {
          setLogLines([]);
        }
        const lines = await ApiService.readLogFile(selectedLogFile.path, INITIAL_LOG_LINE_LIMIT);
        if (cancelled) return;
        const stableLines = cacheLogLines(selectedLogFile, lines);
        showLogLines(stableLines, selectedLogFile.path);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to load log file');
          displayedLogPathRef.current = null;
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
  }, [cacheLogLines, getCachedLogLines, isLiveLogFile, resetLogViewport, selectedLogFile, showLogLines]);

  const selectLogFile = (logPath: string) => {
    if (logPath === selectedLogPath) {
      return;
    }
    const nextFile = logFiles.find((file) => file.path === logPath) ?? null;
    const cachedLines = nextFile ? getCachedLogLines(nextFile) : null;

    resetLogViewport();
    setError(null);
    if (cachedLines) {
      setLoading(false);
      showLogLines(cachedLines, logPath);
    } else {
      displayedLogPathRef.current = null;
      setLogLines([]);
    }
    setSelectedLogPath(logPath);
  };

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
  }, [isLiveLogFile, isWatching, selectedLogFile, watchedPath]);

  useEffect(() => {
    if (!isWatching) return;

    let unlisten: (() => void) | null = null;
    const bindListener = async () => {
      unlisten = await listen<{ lines: LogLine[] }>('log-update', (event) => {
        setLogLines((current) => {
          const nextLines = [...current, ...event.payload.lines].slice(-INITIAL_LOG_LINE_LIMIT);
          if (selectedLogFile) {
            cacheLogLines(selectedLogFile, nextLines);
          }
          return nextLines;
        });
      });
    };

    void bindListener();

    return () => {
      if (unlisten) {
        unlisten();
      }
    };
  }, [cacheLogLines, isWatching, selectedLogFile]);

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

  const handleStreamScrollStateChange = useCallback((atBottom: boolean) => {
    setIsAtBottom(atBottom);
    if (isLiveFile) {
      setAutoScroll(atBottom);
    }
  }, [isLiveFile]);

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

  const handleStreamLineSelect = useCallback((key: string) => {
    setSelectedLineKey(key);
  }, []);

  const handleStreamModFilter = useCallback((line: LogLine, key: string) => {
    setSelectedModTag(line.modTag);
    setSelectedLineKey(key);
  }, []);

  const handleJumpToNewestRelevantLine = () => {
    const targetMod = selectedLine?.modTag ?? selectedModTag;
    const candidate = targetMod
      ? [...visibleLines].reverse().find((line) => line.modTag && normalizeModTag(line.modTag) === normalizeModTag(targetMod))
      : visibleLines[visibleLines.length - 1];

    if (!candidate) return;

    const key = getLineKey(candidate);
    setSelectedLineKey(key);
    scrollLineIntoView(candidate, 'center');
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
      scrollLineIntoView(nextLine);
    }

    if (event.key === 'ArrowUp') {
      event.preventDefault();
      const nextLine = currentIndex <= 0 ? visibleLines[0] : visibleLines[currentIndex - 1];
      const nextKey = getLineKey(nextLine);
      setSelectedLineKey(nextKey);
      scrollLineIntoView(nextLine);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="modal-content workspace-panel logs-panel">
      <WorkspacePageHeader
        eyebrow={environment.name}
        title="Logs"
        description={`Review live and archived logs, mod activity, and selected log lines for ${environment.name}.`}
      />

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
                <SimmButton
                  key={file.path}
                  type="button"
                  variant="ghost"
                  className={`logs-panel__source-button ${selectedLogPath === file.path ? 'logs-panel__source-button--active' : ''}`}
                  onClick={() => selectLogFile(file.path)}
                >
                  <div className="logs-panel__source-head">
                    <strong>{file.name}</strong>
                    <div className="logs-panel__source-badges">
                      {file.isLatest && <SimmBadge className="logs-panel__badge logs-panel__badge--live">Live</SimmBadge>}
                      {isSharedPlayerLogFile(file) && <SimmBadge className="logs-panel__badge">Shared</SimmBadge>}
                    </div>
                  </div>
                  <span>{formatFileSize(file.size)}</span>
                  <span>{file.modified ? new Date(file.modified).toLocaleDateString() : 'Unknown date'}</span>
                </SimmButton>
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
                <SimmButton
                  key={file.path}
                  type="button"
                  variant="ghost"
                  className={`logs-panel__source-button ${selectedLogPath === file.path ? 'logs-panel__source-button--active' : ''}`}
                  onClick={() => selectLogFile(file.path)}
                >
                  <div className="logs-panel__source-head">
                    <strong>{file.name}</strong>
                  </div>
                  <span>{formatFileSize(file.size)}</span>
                  <span>{file.modified ? new Date(file.modified).toLocaleDateString() : 'Unknown date'}</span>
                </SimmButton>
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
                <SimmButton type="button" variant="ghost" size="xs" className="logs-panel__clear-link" onClick={() => setSelectedModTag(null)}>
                  Clear
                </SimmButton>
              )}
            </div>
            <div className="logs-panel__mod-activity">
              {modActivity.map((item) => (
                <SimmButton
                  key={item.modTag}
                  type="button"
                  variant="ghost"
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
                </SimmButton>
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
              <div className="logs-panel__viewer-title-row">
                <h3>{selectedLogFile?.name ?? 'No log file selected'}</h3>
              </div>
              <p className="logs-panel__file-meta">
                {selectedLogFile
                  ? `${formatModifiedDate(selectedLogFile.modified)} • ${formatFileSize(selectedLogFile.size)}`
                  : 'Choose a log source from the rail.'}
              </p>
            </div>
            <div className="logs-panel__header-actions">
              <SimmButton type="button" variant="outline" size="sm" className="logs-panel__viewer-action" onClick={() => selectedLogFile && void ApiService.openPath(selectedFilePath)} disabled={!selectedLogFile}>
                <Icon name="fas fa-file-lines" data-icon="inline-start" />
                Open File
              </SimmButton>
              <SimmButton type="button" variant="outline" size="sm" className="logs-panel__viewer-action" onClick={() => selectedLogFile && void ApiService.revealPath(selectedFilePath)} disabled={!selectedLogFile}>
                <Icon name="fas fa-folder-open" data-icon="inline-start" />
                Open Folder
              </SimmButton>
              <SimmButton type="button" variant="outline" size="sm" className="logs-panel__viewer-action" onClick={() => selectedLogFile && void reloadSelectedLogFile(selectedLogFile.path)} disabled={!selectedLogFile || loading}>
                <Icon name={loading ? 'fas fa-spinner fa-spin' : 'fas fa-rotate'} data-icon="inline-start" />
                Reload
              </SimmButton>
              <SimmButton type="button" variant="secondary" size="sm" className="logs-panel__viewer-action logs-panel__viewer-action--primary" onClick={() => void handleExport()} disabled={!selectedLogFile || exporting}>
                <Icon name={exporting ? 'fas fa-spinner fa-spin' : 'fas fa-download'} data-icon="inline-start" />
                {exporting ? 'Exporting…' : 'Export'}
              </SimmButton>
            </div>
          </header>

          <div className="logs-panel__utility-bar">
            <div className="logs-panel__toolbar">
              <div className="logs-panel__toolbar-group logs-panel__toolbar-group--search">
                <Icon name="fas fa-search" />
                <Input
                  type="text"
                  value={searchQuery}
                  onChange={(event) => setSearchQuery(event.target.value)}
                  placeholder="Search log lines"
                />
              </div>

              <div className="logs-panel__toolbar-group">
                <label htmlFor="logs-level-filter">Level</label>
                <LogsToolbarSelect
                  id="logs-level-filter"
                  value={filterLevel}
                  options={LOG_LEVEL_OPTIONS}
                  onValueChange={setFilterLevel}
                />
              </div>

              <div className="logs-panel__toolbar-group">
                <label htmlFor="logs-category-filter">Category</label>
                <LogsToolbarSelect
                  id="logs-category-filter"
                  value={filterCategory}
                  options={LOG_CATEGORY_OPTIONS}
                  onValueChange={setFilterCategory}
                />
              </div>

              <div className="logs-panel__toolbar-group">
                <label htmlFor="logs-time-filter">Time</label>
                <LogsToolbarSelect
                  id="logs-time-filter"
                  value={timePeriod}
                  options={TIME_PERIOD_OPTIONS}
                  onValueChange={setTimePeriod}
                />
              </div>

              {timePeriod === 'custom' && (
                <div className="logs-panel__toolbar-group logs-panel__toolbar-group--custom">
                  <Input
                    type="text"
                    value={customTimeStart}
                    onChange={(event) => setCustomTimeStart(event.target.value)}
                    placeholder="Start HH:MM:SS.mmm"
                  />
                  <Input
                    type="text"
                    value={customTimeEnd}
                    onChange={(event) => setCustomTimeEnd(event.target.value)}
                    placeholder="End HH:MM:SS.mmm"
                  />
                </div>
              )}

              {selectedModTag && (
                <SimmButton type="button" variant="outline" size="sm" className="logs-panel__active-filter" onClick={() => setSelectedModTag(null)} style={getModAccentStyle(selectedModTag)}>
                  <span>Mod: {selectedModTag}</span>
                  <Icon name="fas fa-times" data-icon="inline-end" />
                </SimmButton>
              )}

              {isLiveFile && (
                <SimmButton
                  type="button"
                  variant="outline"
                  size="sm"
                  className={`logs-panel__follow-toggle ${autoScroll ? 'logs-panel__follow-toggle--active' : ''}`}
                  onClick={() => {
                    if (autoScroll) {
                      setAutoScroll(false);
                      return;
                    }
                    jumpToLive();
                  }}
                >
                  <Icon name={`fas ${autoScroll ? 'fa-pause' : 'fa-play'}`} data-icon="inline-start" />
                  {autoScroll ? 'Pause Live' : 'Follow Live'}
                </SimmButton>
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
                  <span>Lines</span>
                  <strong>{summaryCounts.visible}</strong>
                </div>
              </div>
              <div className="logs-panel__summary-actions">
                <SimmButton type="button" variant="outline" size="xs" className="logs-panel__summary-action" onClick={() => setFilterLevel('ERROR')}>
                  Errors
                </SimmButton>
                <SimmButton type="button" variant="outline" size="xs" className="logs-panel__summary-action" onClick={() => setFilterLevel('WARN')}>
                  Warnings
                </SimmButton>
                <SimmButton type="button" variant="outline" size="xs" className="logs-panel__summary-action" onClick={resetFilters}>
                  Reset Filters
                </SimmButton>
              </div>
            </div>
          </div>

          <div className="logs-panel__viewer-body">
            <LogStream
              containerRef={logContainerRef}
              error={error}
              isLiveFile={isLiveFile}
              loading={loading}
              logLineCount={logLines.length}
              onKeyDown={handleViewerKeyDown}
              onModFilter={handleStreamModFilter}
              onScrollStateChange={handleStreamScrollStateChange}
              onSelectLine={handleStreamLineSelect}
              rowRefs={rowRefs}
              searchQuery={searchQuery}
              selectedLineKey={selectedLineKey}
              selectedLogFile={selectedLogFile}
              visibleLines={visibleLines}
            />
            {!isAtBottom && isLiveFile && (
              <div className="logs-panel__jump-live-overlay">
                <SimmButton type="button" variant="outline" size="sm" className="logs-panel__jump-live-button" onClick={jumpToLive}>
                  <Icon name="fas fa-arrow-down" data-icon="inline-start" />
                  Jump to Live
                </SimmButton>
              </div>
            )}
          </div>
        </section>

        <aside className={`logs-panel__inspector ${showCollapsedInspector ? 'logs-panel__inspector--collapsed' : ''}`}>
          <div className="logs-panel__inspector-toolbar">
            <span className="settings-eyebrow">Inspector</span>
            {shouldCollapseInspector && (
              <SimmButton
                type="button"
                variant="outline"
                size="xs"
                className="logs-panel__inspector-toggle"
                onClick={() => setIsInspectorCollapsed((current) => !current)}
                aria-label={showCollapsedInspector ? 'Expand Inspector' : 'Collapse Inspector'}
              >
                <Icon name={`fas ${showCollapsedInspector ? 'fa-angles-left' : 'fa-angles-right'}`} />
                {showCollapsedInspector ? 'Expand' : 'Collapse'}
              </SimmButton>
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
                    <SimmBadge className="logs-panel__badge logs-panel__badge--summary" style={getModAccentStyle(selectedLine.modTag)}>
                      {selectedLine.modTag}
                    </SimmBadge>
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
                  <SimmButton
                    type="button"
                    variant="outline"
                    size="sm"
                    className="logs-panel__inspector-action"
                    onClick={() => void handleCopySelectedLine()}
                    disabled={!selectedLine}
                  >
                    <Icon name="fas fa-copy" />
                    Copy Line
                  </SimmButton>
                  <SimmButton
                    type="button"
                    variant="outline"
                    size="sm"
                    className="logs-panel__inspector-action"
                    onClick={() => selectedLine?.modTag && setSelectedModTag(selectedLine.modTag)}
                    disabled={!selectedLine?.modTag}
                  >
                    <Icon name="fas fa-filter" />
                    Filter to Mod
                  </SimmButton>
                  <SimmButton
                    type="button"
                    variant="outline"
                    size="sm"
                    className="logs-panel__inspector-action"
                    onClick={() => setSelectedModTag(null)}
                    disabled={!selectedModTag}
                  >
                    <Icon name="fas fa-filter-circle-xmark" />
                    Clear Filter
                  </SimmButton>
                  <SimmButton
                    type="button"
                    variant="outline"
                    size="sm"
                    className="logs-panel__inspector-action"
                    onClick={handleJumpToNewestRelevantLine}
                    disabled={visibleLines.length === 0}
                  >
                    <Icon name="fas fa-arrow-down" />
                    Jump to Live
                  </SimmButton>
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
                        {selectedLogFile.isLatest && <SimmBadge>Latest</SimmBadge>}
                        {isSharedPlayerLogFile(selectedLogFile) && <SimmBadge>Shared</SimmBadge>}
                        {isLiveFile && <SimmBadge>Live</SimmBadge>}
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
                          <SimmBadge className="logs-panel__badge">{selectedModContext.count} hits</SimmBadge>
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
                        <SimmButton
                          type="button"
                          variant="outline"
                          size="sm"
                          className="logs-panel__inspector-action logs-panel__inspector-action--wide"
                          onClick={() => void handleOpenModLibraryView(selectedModContext.modTag)}
                          disabled={openingModView || !onOpenModLibraryView}
                        >
                          <Icon name="fas fa-layer-group" />
                          {openingModView ? 'Opening…' : 'Open in Mod Library'}
                        </SimmButton>
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
