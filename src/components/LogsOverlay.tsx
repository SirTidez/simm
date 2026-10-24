import { memo, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
import { createAsyncListenerScope } from '../services/events';
import type { Environment } from '../types';
import { AnchoredContextMenu, type AnchoredContextMenuItem } from './AnchoredContextMenu';
import { Icon } from './Icon';
import { SimmButton } from './primitives';
import { useModLibraryStore } from '../stores/modLibraryStore';
import { ModThumbnail, type ModArtwork } from './media/ModThumbnail';
import { useLibraryArtwork } from './useLibraryArtwork';
import { getEffectiveLevel, type EffectiveLevel } from '../utils/logLevel';

const INITIAL_LOG_LINE_LIMIT = 4000;
const LOG_LINE_CHUNK_SIZE = 4000;
const LOG_FILE_CACHE_LIMIT = 10;
// Keep in step with .logs-panel__line in logs.css: meta line + one content line.
const LOG_ROW_ESTIMATED_HEIGHT = 46;
const LOG_ROW_CONTENT_LINE_HEIGHT = 18;
const LOG_ROW_WRAP_CHARACTER_ESTIMATE = 120;
const LOG_ROW_OVERSCAN = 14;
const LOG_LOAD_OLDER_THRESHOLD = LOG_ROW_ESTIMATED_HEIGHT * 8;

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

interface LogWatchUpdate {
  sourcePath: string;
  sessionId: number;
  lines: LogLine[];
}

interface CachedLogFile {
  size: number;
  modified: string | null;
  loadedLimit: number;
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

type LogsSelectOption<TValue extends string> = {
  value: TValue;
  label: string;
};

const LOG_LEVEL_OPTIONS: LogsSelectOption<LogLevelFilter>[] = [
  { value: 'ALL', label: 'All levels' },
  { value: 'ERROR', label: 'Error' },
  { value: 'WARN', label: 'Warning' },
  { value: 'INFO', label: 'Info' },
  { value: 'DEBUG', label: 'Debug' },
];

const LOG_CATEGORY_OPTIONS: LogsSelectOption<LogCategoryFilter>[] = [
  { value: 'ALL', label: 'All categories' },
  { value: 'melonloader', label: 'MelonLoader' },
  { value: 'mod', label: 'Mods' },
  { value: 'general', label: 'General' },
];

const TIME_PERIOD_OPTIONS: LogsSelectOption<TimePeriod>[] = [
  { value: 'all', label: 'Any time' },
  { value: 'last5min', label: 'Last 5 minutes' },
  { value: 'last15min', label: 'Last 15 minutes' },
  { value: 'last1hour', label: 'Last hour' },
  { value: 'custom', label: 'Custom range' },
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

function estimateLogRowHeight(line: LogLine): number {
  const visualContentLines = line.content.split('\n').reduce((total, segment) => (
    total + Math.max(1, Math.ceil(segment.length / LOG_ROW_WRAP_CHARACTER_ESTIMATE))
  ), 0);

  return LOG_ROW_ESTIMATED_HEIGHT + Math.max(0, visualContentLines - 1) * LOG_ROW_CONTENT_LINE_HEIGHT;
}

function buildLogRowOffsets(lines: LogLine[]): number[] {
  const offsets = [0];
  let totalHeight = 0;

  for (const line of lines) {
    totalHeight += estimateLogRowHeight(line);
    offsets.push(totalHeight);
  }

  return offsets;
}

function findLogRowIndexAtOffset(offsets: number[], targetOffset: number): number {
  let low = 0;
  let high = Math.max(0, offsets.length - 1);

  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (offsets[mid + 1] <= targetOffset) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }

  return low;
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
  label,
  value,
  options,
  onValueChange,
}: {
  id: string;
  label: string;
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
      <SelectTrigger id={id} className="logs-panel__select" aria-label={label}>
        <SelectValue>
          {(selectedValue) =>
            options.find((option) => option.value === selectedValue)?.label
            || options.find((option) => option.value === value)?.label
            || options[0]?.label
          }
        </SelectValue>
      </SelectTrigger>
      <SelectContent align="start">
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

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const DATE_FORMAT = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
const DATE_TIME_FORMAT = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
});

function formatFileDate(value: string | null): string {
  if (!value) return 'Unknown date';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Unknown date' : DATE_FORMAT.format(date);
}

function formatModifiedDate(value: string | null): string {
  if (!value) return 'Unknown';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Unknown' : DATE_TIME_FORMAT.format(date);
}

function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return `${count.toLocaleString('en-US')} ${count === 1 ? singular : plural}`;
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
  artwork,
  line,
  searchQuery,
  selected,
  setRowRef,
  onModFilter,
  onSelect,
}: {
  artwork: ModArtwork | null;
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
      className={[
        'logs-panel__line',
        `logs-panel__line--${effectiveLevel.toLowerCase()}`,
        selected ? 'logs-panel__line--selected' : '',
      ].filter(Boolean).join(' ')}
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
        <span className="logs-panel__line-number">{line.lineNumber}</span>
        <span className="logs-panel__line-timestamp">{line.timestamp ?? '—'}</span>
        <span className={`logs-panel__line-level logs-panel__line-level--${effectiveLevel.toLowerCase()}`}>
          {getLevelLabel(effectiveLevel)}
        </span>
        {line.modTag ? (
          <button
            type="button"
            tabIndex={-1}
            className="logs-panel__mod-chip"
            title={`Show only ${line.modTag}`}
            onClick={(event) => {
              event.stopPropagation();
              onModFilter(line, key);
            }}
          >
            {artwork && <ModThumbnail {...artwork} name={line.modTag} size={16} />}
            <span className="ui-truncate">{line.modTag}</span>
          </button>
        ) : (
          <span className="logs-panel__line-category">{getCategoryLabel(line.category)}</span>
        )}
      </div>
      <div className="logs-panel__line-content">{highlightText(line.content, searchQuery)}</div>
    </div>
  );
});

const LogStream = memo(function LogStream({
  containerRef,
  error,
  getArtwork,
  isLiveFile,
  loading,
  loadingOlder,
  logLineCount,
  onKeyDown,
  onLoadOlder,
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
  getArtwork: (name: string | null | undefined) => ModArtwork | null;
  isLiveFile: boolean;
  loading: boolean;
  loadingOlder: boolean;
  logLineCount: number;
  onKeyDown: (event: React.KeyboardEvent<HTMLDivElement>) => void;
  onLoadOlder: () => void;
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
    const atBottom = Math.abs(scrollHeight - clientHeight - scrollTop) < 12;
    onScrollStateChange(atBottom);
    if (!atBottom && scrollHeight > clientHeight && scrollTop <= LOG_LOAD_OLDER_THRESHOLD) {
      onLoadOlder();
    }

    if (scrollFrameRef.current !== null) {
      return;
    }

    scrollFrameRef.current = requestAnimationFrame(() => {
      scrollFrameRef.current = null;
      updateScrollMetrics(container);
    });
  }, [containerRef, onLoadOlder, onScrollStateChange, updateScrollMetrics]);

  const setRowRef = useCallback((key: string, element: HTMLDivElement | null) => {
    if (element) {
      rowRefs.current[key] = element;
    } else {
      delete rowRefs.current[key];
    }
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

  const rowOffsets = useMemo(() => buildLogRowOffsets(visibleLines), [visibleLines]);
  const totalEstimatedHeight = rowOffsets[rowOffsets.length - 1] ?? 0;
  const effectiveStreamViewportHeight = scrollMetrics.height > 0 ? scrollMetrics.height : 720;
  const virtualStartIndex = Math.max(
    0,
    findLogRowIndexAtOffset(rowOffsets, scrollMetrics.top) - LOG_ROW_OVERSCAN,
  );
  const virtualEndIndex = Math.min(
    visibleLines.length,
    findLogRowIndexAtOffset(rowOffsets, scrollMetrics.top + effectiveStreamViewportHeight) + LOG_ROW_OVERSCAN + 1,
  );
  const virtualLines = visibleLines.slice(virtualStartIndex, virtualEndIndex);
  const virtualTopPadding = rowOffsets[virtualStartIndex] ?? 0;
  const virtualBottomPadding = Math.max(0, totalEstimatedHeight - (rowOffsets[virtualEndIndex] ?? totalEstimatedHeight));

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
        <div className="ui-empty logs-panel__empty" role="alert">
          <span className="ui-empty__emblem" aria-hidden="true"><Icon name="triangleExclamation" /></span>
          <p className="ui-empty__title">Could not read this log</p>
          <p className="ui-empty__copy">{error}</p>
          <p className="ui-empty__copy">Check that the file still exists, then choose Reload from the More menu.</p>
        </div>
      ) : loading && logLineCount === 0 ? (
        <div className="logs-panel__skeleton" role="status">
          <span className="sr-only">Loading log file</span>
          {Array.from({ length: 8 }, (_, index) => (
            <div key={index} className="logs-panel__skeleton-row" aria-hidden="true">
              <span className="logs-panel__skeleton-bar logs-panel__skeleton-bar--meta" />
              <span className="logs-panel__skeleton-bar" style={{ width: `${50 + ((index * 17) % 45)}%` }} />
            </div>
          ))}
        </div>
      ) : !selectedLogFile ? (
        <div className="ui-empty logs-panel__empty">
          <span className="ui-empty__emblem" aria-hidden="true"><Icon name="fileLines" /></span>
          <p className="ui-empty__title">No logs yet</p>
          <p className="ui-empty__copy">MelonLoader writes Latest.log when the game starts. Play this environment once, then come back here to read it.</p>
        </div>
      ) : visibleLines.length === 0 ? (
        <div className="ui-empty logs-panel__empty">
          <span className="ui-empty__emblem" aria-hidden="true"><Icon name={logLineCount === 0 ? 'fileLines' : 'filter'} /></span>
          <p className="ui-empty__title">{logLineCount === 0 ? 'No log content yet' : 'No lines match the current filters'}</p>
          <p className="ui-empty__copy">
            {logLineCount === 0
              ? (isLiveFile ? 'New lines appear here as soon as the game writes output.' : 'This file exists but contains no readable log lines.')
              : 'Clear the search or choose Reset Filters to see every line again.'}
          </p>
        </div>
      ) : (
        <>
          {loadingOlder ? (
            <div className="logs-panel__load-older" role="status">
              <Icon name="fas fa-spinner fa-spin" />
              Loading earlier entries
            </div>
          ) : null}
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
                artwork={getArtwork(line.modTag)}
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

export function LogsOverlay({ isOpen, environmentId, onOpenModLibraryView }: Props) {
  const { library: sharedLibrary, ensureLibrary } = useModLibraryStore();
  const getModArtwork = useLibraryArtwork();
  const [logFiles, setLogFiles] = useState<LogFile[]>([]);
  const [selectedLogPath, setSelectedLogPath] = useState<string | null>(null);
  const [logLines, setLogLines] = useState<LogLine[]>([]);
  const [selectedLineKey, setSelectedLineKey] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
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
  const isWatchingRef = useRef(isWatching);
  const watchedPathRef = useRef(watchedPath);
  const watchedSessionIdRef = useRef<number | null>(null);

  useEffect(() => {
    isWatchingRef.current = isWatching;
    watchedPathRef.current = watchedPath;
  }, [isWatching, watchedPath]);
  const [autoScroll, setAutoScroll] = useState(true);
  const [isAtBottom, setIsAtBottom] = useState(true);
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const [openingModView, setOpeningModView] = useState(false);
  const [actionMenu, setActionMenu] = useState<{ id: string; x: number; y: number; items: AnchoredContextMenuItem[] } | null>(null);

  const logContainerRef = useRef<HTMLDivElement>(null);
  const rowRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const toastTimeoutRef = useRef<number | null>(null);
  const logFileCacheRef = useRef<Map<string, CachedLogFile>>(new Map());
  const displayedLogPathRef = useRef<string | null>(null);
  const selectedLogPathRef = useRef<string | null>(null);
  const loadedLogLineLimitRef = useRef(INITIAL_LOG_LINE_LIMIT);
  const loadingOlderRef = useRef(false);
  const watchGenerationRef = useRef(0);
  const watchOperationRef = useRef<Promise<void>>(Promise.resolve());

  const selectedLogFile = useMemo(
    () => logFiles.find((file) => file.path === selectedLogPath) ?? null,
    [logFiles, selectedLogPath],
  );

  useEffect(() => {
    selectedLogPathRef.current = selectedLogPath;
  }, [selectedLogPath]);

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

  const getCachedLogFile = useCallback((file: LogFile): CachedLogFile | null => {
    const cached = logFileCacheRef.current.get(file.path);
    if (!cached) return null;

    if (cached.size !== file.size || cached.modified !== file.modified) {
      logFileCacheRef.current.delete(file.path);
      return null;
    }

    logFileCacheRef.current.delete(file.path);
    logFileCacheRef.current.set(file.path, cached);
    return cached;
  }, []);

  const cacheLogLines = useCallback((file: LogFile, lines: LogLine[], loadedLimit = loadedLogLineLimitRef.current): LogLine[] => {
    const existing = logFileCacheRef.current.get(file.path);
    const stableLines = existing && areLogLinesEqual(existing.lines, lines) ? existing.lines : lines;

    logFileCacheRef.current.set(file.path, {
      size: file.size,
      modified: file.modified,
      loadedLimit,
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
    for (const line of visibleLines) {
      const level = getEffectiveLevel(line);
      if (level === 'ERROR') errors += 1;
      if (level === 'WARN') warnings += 1;
    }
    return {
      errors,
      warnings,
      visible: visibleLines.length,
    };
  }, [visibleLines]);

  const hasActiveFilters = filterLevel !== 'ALL'
    || filterCategory !== 'ALL'
    || timePeriod !== 'all'
    || searchQuery.trim() !== ''
    || selectedModTag !== null;

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

  const scrollLineIntoView = (line: LogLine, block: ScrollLogicalPosition = 'nearest') => {
    const key = getLineKey(line);
    const renderedRow = rowRefs.current[key];
    if (renderedRow) {
      renderedRow.scrollIntoView({ block });
      return;
    }

    const targetIndex = visibleLines.findIndex((candidate) => getLineKey(candidate) === key);
    if (targetIndex >= 0 && logContainerRef.current) {
      const rowOffsets = buildLogRowOffsets(visibleLines);
      logContainerRef.current.scrollTo({
        top: Math.max(0, (rowOffsets[targetIndex] ?? 0) - LOG_ROW_ESTIMATED_HEIGHT),
        behavior: 'auto',
      });
    }
  };

  useEffect(() => {
    setLogFiles([]);
    setSelectedLogPath(null);
    setLogLines([]);
    setLoadingOlder(false);
    loadingOlderRef.current = false;
    loadedLogLineLimitRef.current = INITIAL_LOG_LINE_LIMIT;
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

    const generation = ++watchGenerationRef.current;
    const sessionId = watchedSessionIdRef.current;
    if (sessionId !== null) {
      watchOperationRef.current = watchOperationRef.current
        .catch(() => undefined)
        .then(async () => {
          await ApiService.stopWatchingLog(sessionId);
          if (generation !== watchGenerationRef.current) return;
          isWatchingRef.current = false;
          watchedPathRef.current = null;
          if (watchedSessionIdRef.current === sessionId) {
            watchedSessionIdRef.current = null;
          }
          setIsWatching(false);
          setWatchedPath(null);
        })
        .catch((err) => {
          if (generation === watchGenerationRef.current) {
            console.error('Failed to stop watching log file during environment switch:', err);
          }
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
      loadedLogLineLimitRef.current = INITIAL_LOG_LINE_LIMIT;
      setLogLines([]);
      const lines = await ApiService.readLogFile(logPath, INITIAL_LOG_LINE_LIMIT);
      if (selectedLogPathRef.current !== logPath) return;
      const stableLines = file ? cacheLogLines(file, lines, INITIAL_LOG_LINE_LIMIT) : lines;
      showLogLines(stableLines, logPath);
    } catch (err) {
      if (selectedLogPathRef.current !== logPath) return;
      setError(err instanceof Error ? err.message : 'Failed to load log file');
      displayedLogPathRef.current = null;
      setLogLines([]);
    } finally {
      if (selectedLogPathRef.current === logPath) {
        setLoading(false);
      }
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

      const cachedFile = getCachedLogFile(selectedLogFile);
      const cachedLines = cachedFile?.lines ?? null;
      if (cachedLines) {
        loadedLogLineLimitRef.current = cachedFile?.loadedLimit ?? INITIAL_LOG_LINE_LIMIT;
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
        loadedLogLineLimitRef.current = INITIAL_LOG_LINE_LIMIT;
        const lines = await ApiService.readLogFile(selectedLogFile.path, INITIAL_LOG_LINE_LIMIT);
        if (cancelled) return;
        const stableLines = cacheLogLines(selectedLogFile, lines, INITIAL_LOG_LINE_LIMIT);
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
  }, [cacheLogLines, getCachedLogFile, isLiveLogFile, resetLogViewport, selectedLogFile, showLogLines]);

  const selectLogFile = (logPath: string) => {
    if (logPath === selectedLogPath) {
      return;
    }
    const nextFile = logFiles.find((file) => file.path === logPath) ?? null;
    const cachedFile = nextFile ? getCachedLogFile(nextFile) : null;
    const cachedLines = cachedFile?.lines ?? null;

    resetLogViewport();
    setError(null);
    if (cachedLines) {
      loadedLogLineLimitRef.current = cachedFile?.loadedLimit ?? INITIAL_LOG_LINE_LIMIT;
      setLoading(false);
      showLogLines(cachedLines, logPath);
    } else {
      loadedLogLineLimitRef.current = INITIAL_LOG_LINE_LIMIT;
      displayedLogPathRef.current = null;
      setLogLines([]);
    }
    setSelectedLogPath(logPath);
  };

  useEffect(() => {
    const generation = ++watchGenerationRef.current;
    const targetPath = selectedLogFile && isLiveLogFile(selectedLogFile)
      ? selectedLogFile.path
      : null;

    // Tauri owns a single global watcher. Serialize source transitions so a
    // delayed A start cannot win after the user has selected B.
    watchOperationRef.current = watchOperationRef.current
      .catch(() => undefined)
      .then(async () => {
        if (generation !== watchGenerationRef.current) return;

        const currentPath = watchedPathRef.current;
        if (currentPath && currentPath !== targetPath) {
          const sessionId = watchedSessionIdRef.current;
          if (sessionId !== null) {
            await ApiService.stopWatchingLog(sessionId);
          }
          if (generation !== watchGenerationRef.current) return;
          isWatchingRef.current = false;
          watchedPathRef.current = null;
          if (watchedSessionIdRef.current === sessionId) {
            watchedSessionIdRef.current = null;
          }
          setIsWatching(false);
          setWatchedPath(null);
        }

        if (!targetPath) return;
        if (watchedPathRef.current === targetPath && isWatchingRef.current) return;

        const session = await ApiService.watchLogFile(targetPath);
        if (generation !== watchGenerationRef.current) {
          // This queued operation was superseded before it completed. The
          // next serialized operation will establish the current source.
          await ApiService.stopWatchingLog(session.sessionId);
          return;
        }

        isWatchingRef.current = true;
        watchedPathRef.current = targetPath;
        watchedSessionIdRef.current = session.sessionId;
        setIsWatching(true);
        setWatchedPath(targetPath);
      })
      .catch((err) => {
        if (generation === watchGenerationRef.current) {
          console.error('Failed to synchronize live log watching:', err);
        }
      });
  }, [isLiveLogFile, isWatching, selectedLogFile, watchedPath]);

  useEffect(() => {
    if (!isWatching || !watchedPath) return;

    const sourcePath = watchedPath;
    const sessionId = watchedSessionIdRef.current;
    if (sessionId === null) return;
    const listeners = createAsyncListenerScope((error) => {
      console.error('Failed to bind log-update listener:', error);
    });
    listeners.register(() => listen<LogWatchUpdate>('log-update', (event) => {
        // Both source and session are immutable backend identities. Checking
        // them protects against an event emitted by A after B is selected,
        // including a later watch of the same source path.
        if (
          !listeners.isActive()
          || event.payload.sourcePath !== sourcePath
          || event.payload.sessionId !== sessionId
          || selectedLogPathRef.current !== sourcePath
          || watchedPathRef.current !== sourcePath
          || watchedSessionIdRef.current !== sessionId
        ) {
          return;
        }
        setLogLines((current) => {
          const nextLines = [...current, ...event.payload.lines].slice(-loadedLogLineLimitRef.current);
          const sourceFile = logFiles.find((file) => file.path === sourcePath);
          if (sourceFile) {
            cacheLogLines(sourceFile, nextLines, loadedLogLineLimitRef.current);
          }
          return nextLines;
        });
      }));

    return () => {
      listeners.dispose();
    };
  }, [cacheLogLines, isWatching, logFiles, watchedPath]);

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
    const container = logContainerRef.current;
    if (!container || !isLiveFile) return;
    if (autoScroll && isAtBottom) {
      container.scrollTop = container.scrollHeight;
    }
  }, [autoScroll, isAtBottom, isLiveFile, visibleLines.length]);

  useEffect(() => {
    if (!isOpen) return;
    return () => {
      const generation = ++watchGenerationRef.current;
      const sessionId = watchedSessionIdRef.current;
      if (sessionId === null) return;
      watchOperationRef.current = watchOperationRef.current
        .catch(() => undefined)
        .then(async () => {
          await ApiService.stopWatchingLog(sessionId);
          if (generation !== watchGenerationRef.current) return;
          isWatchingRef.current = false;
          watchedPathRef.current = null;
          if (watchedSessionIdRef.current === sessionId) {
            watchedSessionIdRef.current = null;
          }
          setIsWatching(false);
          setWatchedPath(null);
        })
        .catch((err) => {
          if (generation === watchGenerationRef.current) {
            console.error('Failed to stop watching log file:', err);
          }
        });
    };
  }, [isOpen]);

  const loadOlderLogEntries = useCallback(() => {
    if (!selectedLogFile || loadingOlderRef.current) return;
    const firstLoadedLineNumber = logLines[0]?.lineNumber ?? 1;
    if (firstLoadedLineNumber <= 1) return;

    const container = logContainerRef.current;
    const previousScrollHeight = container?.scrollHeight ?? 0;
    const previousScrollTop = container?.scrollTop ?? 0;
    const nextLimit = loadedLogLineLimitRef.current + LOG_LINE_CHUNK_SIZE;

    loadingOlderRef.current = true;
    setLoadingOlder(true);

    void ApiService.readLogFile(selectedLogFile.path, nextLimit)
      .then((lines) => {
        const currentPath = selectedLogFile.path;
        if (selectedLogPathRef.current !== currentPath) return;
        loadedLogLineLimitRef.current = nextLimit;
        const stableLines = cacheLogLines(selectedLogFile, lines, nextLimit);
        displayedLogPathRef.current = currentPath;
        setLogLines((current) => (areLogLinesEqual(current, stableLines) ? current : stableLines));
        setAutoScroll(false);
        setIsAtBottom(false);
        requestAnimationFrame(() => {
          const latestContainer = logContainerRef.current;
          if (!latestContainer || displayedLogPathRef.current !== currentPath) return;
          const heightDelta = latestContainer.scrollHeight - previousScrollHeight;
          latestContainer.scrollTop = Math.max(0, previousScrollTop + heightDelta);
        });
      })
      .catch((err) => {
        if (selectedLogPathRef.current !== selectedLogFile.path) return;
        setError(err instanceof Error ? err.message : 'Failed to load earlier log entries');
      })
      .finally(() => {
        loadingOlderRef.current = false;
        if (selectedLogPathRef.current !== selectedLogFile.path) return;
        setLoadingOlder(false);
      });
  }, [cacheLogLines, logLines, selectedLogFile]);

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
      const library = sharedLibrary ?? await ensureLibrary();
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
    if (event.key === 'Escape' && selectedLineKey) {
      event.preventDefault();
      setSelectedLineKey(null);
      return;
    }
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


  const openActionMenu = (
    id: string,
    event: React.MouseEvent<HTMLElement>,
    items: AnchoredContextMenuItem[],
  ) => {
    const rect = event.currentTarget.getBoundingClientRect();
    setActionMenu((current) => (current?.id === id ? null : { id, x: rect.left, y: rect.bottom + 4, items }));
  };

  const fileMenuItems: AnchoredContextMenuItem[] = [
    {
      key: 'open-file',
      label: 'Open File',
      icon: 'fas fa-file-lines',
      disabled: !selectedLogFile,
      onSelect: () => {
        if (selectedLogFile) void ApiService.openPath(selectedFilePath);
      },
    },
    {
      key: 'open-folder',
      label: 'Open Folder',
      icon: 'fas fa-folder-open',
      disabled: !selectedLogFile,
      onSelect: () => {
        if (selectedLogFile) void ApiService.revealPath(selectedFilePath);
      },
    },
    {
      key: 'reload',
      label: 'Reload',
      icon: 'fas fa-rotate',
      disabled: !selectedLogFile || loading,
      separatorBefore: true,
      onSelect: () => {
        if (selectedLogFile) void reloadSelectedLogFile(selectedLogFile.path);
      },
    },
  ];

  const lineMenuItems: AnchoredContextMenuItem[] = [
    {
      key: 'jump-newest',
      label: selectedLine?.modTag ? `Jump to Newest ${selectedLine.modTag} Line` : 'Jump to Newest Line',
      icon: 'fas fa-arrow-down',
      disabled: visibleLines.length === 0,
      onSelect: handleJumpToNewestRelevantLine,
    },
    {
      key: 'open-library',
      label: openingModView ? 'Opening…' : 'Open in Mod Library',
      icon: 'fas fa-layer-group',
      disabled: !selectedModContext || openingModView || !onOpenModLibraryView,
      onSelect: () => {
        if (selectedModContext) void handleOpenModLibraryView(selectedModContext.modTag);
      },
    },
  ];

  const isModSelected = (modTag: string) => (
    selectedModTag !== null && normalizeModTag(selectedModTag) === normalizeModTag(modTag)
  );

  const renderSourceRow = (file: LogFile) => {
    const selected = selectedLogPath === file.path;
    const shared = isSharedPlayerLogFile(file);
    return (
      <button
        key={file.path}
        type="button"
        className="logs-panel__source"
        aria-current={selected ? 'true' : undefined}
        title={file.path}
        onClick={() => selectLogFile(file.path)}
      >
        <span className="logs-panel__source-name">{file.name}</span>
        {file.isLatest ? (
          <span className="logs-panel__source-flag logs-panel__source-flag--live">Live</span>
        ) : shared ? (
          <span className="logs-panel__source-flag">Shared</span>
        ) : null}
        <span className="logs-panel__source-meta">
          {formatFileSize(file.size)} · {formatFileDate(file.modified)}
        </span>
      </button>
    );
  };

  if (!isOpen) return null;

  return (
    <div className="workspace-panel logs-panel">
      <div className={`logs-panel__shell ${selectedLine ? 'logs-panel__shell--inspecting' : ''}`}>
        <aside className="logs-panel__rail" aria-label="Log sources">
          <section className="logs-panel__rail-section">
            <h3 className="ui-section-title logs-panel__rail-title">Current</h3>
            <div className="logs-panel__source-list">
              {currentFiles.map(renderSourceRow)}
              {!loading && currentFiles.length === 0 && (
                <p className="logs-panel__rail-empty">No current log. It appears after the next launch.</p>
              )}
            </div>
          </section>

          <section className="logs-panel__rail-section">
            <h3 className="ui-section-title logs-panel__rail-title">Archived</h3>
            <div className="logs-panel__source-list">
              {archivedFiles.map(renderSourceRow)}
              {!loading && archivedFiles.length === 0 && (
                <p className="logs-panel__rail-empty">No archived logs yet.</p>
              )}
            </div>
          </section>

          <section className="logs-panel__rail-section">
            <div className="logs-panel__rail-title-row">
              <h3 className="ui-section-title logs-panel__rail-title">Mod activity</h3>
              {selectedModTag && (
                <button type="button" className="logs-panel__rail-clear" onClick={() => setSelectedModTag(null)}>
                  Clear
                </button>
              )}
            </div>
            <div className="logs-panel__source-list">
              {modActivity.map((item) => (
                <button
                  key={item.modTag}
                  type="button"
                  className="logs-panel__mod"
                  aria-pressed={isModSelected(item.modTag)}
                  title={`${item.modTag}: ${pluralize(item.count, 'line')}, ${pluralize(item.errorCount, 'error')}, last at ${formatRelativeTime(item.lastLogTime)}`}
                  onClick={() => setSelectedModTag((current) => (current && normalizeModTag(current) === normalizeModTag(item.modTag) ? null : item.modTag))}
                >
                  <ModThumbnail {...getModArtwork(item.modTag)} name={item.modTag} size={20} />
                  <span className="logs-panel__mod-name">{item.modTag}</span>
                  {item.errorCount > 0 && (
                    <span className="logs-panel__mod-errors">
                      <Icon name="fas fa-circle-exclamation" aria-hidden="true" />
                      {item.errorCount}
                      <span className="sr-only"> errors</span>
                    </span>
                  )}
                  <span className="logs-panel__mod-count">
                    {item.count}
                    <span className="sr-only"> lines</span>
                  </span>
                </button>
              ))}
              {!loading && modActivity.length === 0 && (
                <p className="logs-panel__rail-empty">No mod-tagged lines in this file.</p>
              )}
            </div>
          </section>
        </aside>

        <section className="logs-panel__viewer" aria-label="Log viewer">
          <header className="logs-panel__viewer-header">
            <div className="logs-panel__viewer-titles">
              <h3 className="logs-panel__viewer-title" title={selectedLogFile?.path}>
                {selectedLogFile?.name ?? 'No log selected'}
              </h3>
              {selectedLogFile && (
                <p className="ui-meta logs-panel__file-meta">
                  {isLiveFile && <span className="ui-status ui-status--ok">{isWatching ? 'Live' : 'Current'}</span>}
                  <span>{formatFileSize(selectedLogFile.size)}</span>
                  <span>Modified {formatModifiedDate(selectedLogFile.modified)}</span>
                </p>
              )}
            </div>
            <div className="ui-toolbar__group logs-panel__header-actions">
              {isLiveFile && (
                <SimmButton
                  type="button"
                  variant="outline"
                  className="logs-panel__follow-toggle"
                  aria-pressed={autoScroll}
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
              <SimmButton
                type="button"
                variant="secondary"
                onClick={() => void handleExport()}
                disabled={!selectedLogFile || exporting}
                title="Export the lines that match the current filters"
              >
                <Icon name={exporting ? 'fas fa-spinner fa-spin' : 'fas fa-download'} data-icon="inline-start" />
                {exporting ? 'Exporting…' : 'Export'}
              </SimmButton>
              <SimmButton
                type="button"
                variant="ghost"
                size="icon"
                aria-label="More log actions"
                aria-haspopup="menu"
                aria-expanded={actionMenu?.id === 'logs-file-actions'}
                onClick={(event) => openActionMenu('logs-file-actions', event, fileMenuItems)}
              >
                <Icon name="fas fa-ellipsis-h" />
              </SimmButton>
            </div>
          </header>

          <div className="ui-toolbar logs-panel__filters">
            <div className="logs-panel__search">
              <Icon name="fas fa-search" aria-hidden="true" />
              <Input
                type="search"
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
                placeholder="Search log lines"
                aria-label="Search log lines"
              />
            </div>
            <LogsToolbarSelect
              id="logs-level-filter"
              label="Level"
              value={filterLevel}
              options={LOG_LEVEL_OPTIONS}
              onValueChange={setFilterLevel}
            />
            <LogsToolbarSelect
              id="logs-category-filter"
              label="Category"
              value={filterCategory}
              options={LOG_CATEGORY_OPTIONS}
              onValueChange={setFilterCategory}
            />
            <LogsToolbarSelect
              id="logs-time-filter"
              label="Time"
              value={timePeriod}
              options={TIME_PERIOD_OPTIONS}
              onValueChange={setTimePeriod}
            />
            {timePeriod === 'custom' && (
              <div className="ui-toolbar__group logs-panel__custom-range">
                <Input
                  type="text"
                  value={customTimeStart}
                  onChange={(event) => setCustomTimeStart(event.target.value)}
                  placeholder="From HH:MM:SS.mmm"
                  aria-label="Custom range start"
                />
                <Input
                  type="text"
                  value={customTimeEnd}
                  onChange={(event) => setCustomTimeEnd(event.target.value)}
                  placeholder="To HH:MM:SS.mmm"
                  aria-label="Custom range end"
                />
              </div>
            )}
            {selectedModTag && (
              <SimmButton
                type="button"
                variant="outline"
                size="sm"
                className="logs-panel__active-filter"
                onClick={() => setSelectedModTag(null)}
                title="Clear mod filter"
              >
                <span>Mod: {selectedModTag}</span>
                <Icon name="fas fa-times" data-icon="inline-end" />
              </SimmButton>
            )}
            <span className="ui-toolbar__spacer" />
            <p className="logs-panel__summary" aria-live="polite">
              <span>{pluralize(summaryCounts.visible, 'line')}</span>
              <span className={summaryCounts.errors > 0 ? 'logs-panel__summary-errors' : undefined}>
                {pluralize(summaryCounts.errors, 'error')}
              </span>
              <span className={summaryCounts.warnings > 0 ? 'logs-panel__summary-warnings' : undefined}>
                {pluralize(summaryCounts.warnings, 'warning')}
              </span>
            </p>
            {hasActiveFilters && (
              <SimmButton type="button" variant="ghost" size="sm" onClick={resetFilters}>
                Reset Filters
              </SimmButton>
            )}
          </div>

          <div className="logs-panel__viewer-body">
            <LogStream
              containerRef={logContainerRef}
              error={error}
              getArtwork={getModArtwork}
              isLiveFile={isLiveFile}
              loading={loading}
              loadingOlder={loadingOlder}
              logLineCount={logLines.length}
              onKeyDown={handleViewerKeyDown}
              onLoadOlder={loadOlderLogEntries}
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
                <SimmButton type="button" variant="secondary" size="sm" className="logs-panel__jump-live-button" onClick={jumpToLive}>
                  <Icon name="fas fa-arrow-down" data-icon="inline-start" />
                  Jump to Live
                </SimmButton>
              </div>
            )}
          </div>
        </section>

        {selectedLine && (
          <aside className="logs-panel__inspector" aria-label="Selected line">
            <header className="logs-panel__inspector-head">
              {selectedLine.modTag && (
                <ModThumbnail {...getModArtwork(selectedLine.modTag)} name={selectedLine.modTag} size={24} />
              )}
              <div className="logs-panel__inspector-titles">
                <h3>Line {selectedLine.lineNumber}</h3>
                <p className="ui-meta">
                  <span className={`logs-panel__line-level logs-panel__line-level--${getEffectiveLevel(selectedLine).toLowerCase()}`}>
                    {getLevelLabel(getEffectiveLevel(selectedLine))}
                  </span>
                  <span className="ui-mono">{selectedLine.timestamp ?? 'No timestamp'}</span>
                </p>
              </div>
              <SimmButton
                type="button"
                variant="ghost"
                size="icon-sm"
                className="logs-panel__inspector-close"
                aria-label="Close Inspector"
                title="Close (Esc)"
                onClick={() => setSelectedLineKey(null)}
              >
                <Icon name="fas fa-times" />
              </SimmButton>
            </header>

            <pre className="logs-panel__inspector-content">{selectedLine.content}</pre>

            <div className="ui-toolbar logs-panel__inspector-actions">
              <SimmButton type="button" variant="secondary" size="sm" onClick={() => void handleCopySelectedLine()}>
                <Icon name="fas fa-copy" data-icon="inline-start" />
                Copy Line
              </SimmButton>
              {selectedLine.modTag && (
                isModSelected(selectedLine.modTag) ? (
                  <SimmButton type="button" variant="outline" size="sm" onClick={() => setSelectedModTag(null)}>
                    <Icon name="fas fa-filter-circle-xmark" data-icon="inline-start" />
                    Clear Mod Filter
                  </SimmButton>
                ) : (
                  <SimmButton type="button" variant="outline" size="sm" onClick={() => setSelectedModTag(selectedLine.modTag)}>
                    <Icon name="fas fa-filter" data-icon="inline-start" />
                    Filter to Mod
                  </SimmButton>
                )
              )}
              <SimmButton
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label="More line actions"
                aria-haspopup="menu"
                aria-expanded={actionMenu?.id === 'logs-line-actions'}
                onClick={(event) => openActionMenu('logs-line-actions', event, lineMenuItems)}
              >
                <Icon name="fas fa-ellipsis-h" />
              </SimmButton>
            </div>

            <div className="logs-panel__inspector-facts">
            <section className="ui-inspector__section logs-panel__inspector-details">
              <h4 className="ui-section-title">Details</h4>
              <dl className="ui-kv">
                <dt>Category</dt>
                <dd>{getCategoryLabel(selectedLine.category)}</dd>
                <dt>Mod</dt>
                <dd>{selectedLine.modTag ?? 'None'}</dd>
                <dt>File</dt>
                <dd className="ui-mono logs-panel__file-path">{selectedLogFile?.name ?? 'Unknown'}</dd>
              </dl>
            </section>

            {selectedModContext && (
              <section className="ui-inspector__section logs-panel__inspector-mod">
                <h4 className="ui-section-title">{selectedModContext.modTag} in this log</h4>
                <dl className="ui-kv">
                  <dt>Lines</dt>
                  <dd className="ui-num">{selectedModContext.count}</dd>
                  <dt>Errors</dt>
                  <dd className="ui-num">{selectedModContext.errorCount}</dd>
                  <dt>Last seen</dt>
                  <dd>{formatRelativeTime(selectedModContext.lastLogTime)}</dd>
                </dl>
              </section>
            )}
            </div>
          </aside>
        )}
      </div>

      {actionMenu && (
        <AnchoredContextMenu
          id={actionMenu.id}
          x={actionMenu.x}
          y={actionMenu.y}
          items={actionMenu.items}
          onClose={() => setActionMenu(null)}
        />
      )}

      {toastMessage && (
        <div className="logs-panel__toast" role="status" aria-live="polite">
          {toastMessage}
        </div>
      )}
    </div>
  );
}
