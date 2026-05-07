import { useCallback, useEffect, useMemo, useRef, useState, type WheelEvent as ReactWheelEvent } from 'react';
import CodeMirror from '@uiw/react-codemirror';
import { RangeSetBuilder } from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from '@codemirror/view';

import { ConfirmOverlay } from './ConfirmOverlay';
import { ApiService } from '../services/api';
import { Icon } from './Icon';
import { WorkspacePageHeader } from './WorkspacePageHeader';
import type {
  ConfigDocument,
  ConfigEditOperation,
  ConfigFileSummary,
  ConfigSection,
  Environment,
} from '../types';

interface Props {
  isOpen: boolean;
  onClose: () => void;
  environmentId: string;
  environment: Environment;
}

type EditorMode = 'structured' | 'raw';
type ConfigValueKind = 'boolean' | 'number' | 'text' | 'empty';
const ALL_SECTIONS_TAB = '__all__';

const rawConfigEditorTheme = EditorView.theme(
  {
    '&': {
      height: '100%',
      width: '100%',
      minWidth: '0',
      backgroundColor: '#08111f',
      color: '#eef5ff',
      fontSize: '0.86rem',
      display: 'flex',
      flexDirection: 'column',
    },
    '.cm-scroller': {
      flex: '1 1 auto',
      minHeight: '0',
      minWidth: '0',
      width: '100%',
      fontFamily: '"Courier New", monospace',
      lineHeight: '1.55',
      overflowX: 'auto',
      overflowY: 'auto',
    },
    '.cm-content': {
      minHeight: '100%',
      padding: '0.78rem 0.92rem',
      caretColor: '#eef5ff',
    },
    '.cm-focused': {
      outline: 'none',
    },
    '.cm-line': {
      padding: '0',
      overflowWrap: 'anywhere',
    },
    '.cm-selectionBackground': {
      backgroundColor: 'rgba(96, 145, 216, 0.38) !important',
    },
    '.cm-activeLine': {
      backgroundColor: 'rgba(52, 82, 124, 0.18)',
    },
    '.cm-gutters': {
      display: 'none',
    },
    '.raw-config-token--comment': {
      color: '#82a3c8',
    },
    '.raw-config-token--section': {
      color: '#7db5ff',
      fontWeight: '700',
    },
    '.raw-config-token--key': {
      color: '#cfe2ff',
    },
    '.raw-config-token--operator': {
      color: '#7894b8',
    },
    '.raw-config-token--string': {
      color: '#f5d493',
    },
    '.raw-config-token--boolean': {
      color: '#81d6ac',
    },
    '.raw-config-token--number': {
      color: '#b9a4ff',
    },
  },
  { dark: true }
);

function markRawToken(builder: RangeSetBuilder<Decoration>, from: number, to: number, className: string) {
  if (to > from) {
    builder.add(from, to, Decoration.mark({ class: className }));
  }
}

function addRawValueDecorations(builder: RangeSetBuilder<Decoration>, lineFrom: number, valueOffset: number, value: string) {
  const tokenPattern = /("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\btrue\b|\bfalse\b|-?\b\d+(?:\.\d+)?\b)/gi;
  let match: RegExpExecArray | null;

  while ((match = tokenPattern.exec(value)) !== null) {
    const token = match[0];
    const from = lineFrom + valueOffset + match.index;
    const className = /^(true|false)$/i.test(token)
      ? 'raw-config-token--boolean'
      : /^-?\d/.test(token)
        ? 'raw-config-token--number'
        : 'raw-config-token--string';

    markRawToken(builder, from, from + token.length, className);
  }
}

function buildRawConfigDecorations(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();

  for (const { from, to } of view.visibleRanges) {
    let line = view.state.doc.lineAt(from);

    while (line.from <= to) {
      const text = line.text;
      const trimmedLine = text.trimStart();
      const leadingLength = text.length - trimmedLine.length;

      if (trimmedLine.startsWith('#') || trimmedLine.startsWith(';')) {
        markRawToken(builder, line.from + leadingLength, line.to, 'raw-config-token--comment');
      } else {
        const sectionMatch = text.match(/^(\s*)(\[[^\]]+\])/);
        if (sectionMatch) {
          const sectionStart = line.from + sectionMatch[1].length;
          markRawToken(builder, sectionStart, sectionStart + sectionMatch[2].length, 'raw-config-token--section');
        }

        const assignmentMatch = text.match(/^(\s*)([^=]+?)(\s*=\s*)(.*)$/);
        if (assignmentMatch) {
          const keyStart = line.from + assignmentMatch[1].length;
          const keyEnd = keyStart + assignmentMatch[2].trimEnd().length;
          const operatorStart = line.from + assignmentMatch[1].length + assignmentMatch[2].length;
          const operatorEnd = operatorStart + assignmentMatch[3].length;
          const valueOffset = assignmentMatch[1].length + assignmentMatch[2].length + assignmentMatch[3].length;

          markRawToken(builder, keyStart, keyEnd, 'raw-config-token--key');
          markRawToken(builder, operatorStart, operatorEnd, 'raw-config-token--operator');
          addRawValueDecorations(builder, line.from, valueOffset, assignmentMatch[4]);
        }
      }

      if (line.to >= view.state.doc.length) break;
      line = view.state.doc.line(line.number + 1);
    }
  }

  return builder.finish();
}

const rawConfigHighlighting = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = buildRawConfigDecorations(view);
    }

    update(update: ViewUpdate) {
      if (update.docChanged || update.viewportChanged) {
        this.decorations = buildRawConfigDecorations(update.view);
      }
    }
  },
  {
    decorations: (plugin) => plugin.decorations,
  }
);

interface EditableEntry {
  id: string;
  key: string;
  value: string;
  comment: string;
  isNew: boolean;
  originalKey: string | null;
}

interface EditableSection {
  id: string;
  name: string;
  isNew: boolean;
  originalName: string | null;
  entries: EditableEntry[];
}

interface FileDraft {
  sections: EditableSection[];
  rawContent: string;
  dirty: boolean;
  dirtyMode: EditorMode | null;
}

interface PendingConfirm {
  title: string;
  message: string;
  onConfirm: () => void;
}

interface ConfigExplorerSectionMatch {
  id: string;
  name: string;
  entries: EditableEntry[];
  sectionMatches: boolean;
}

function createEditorId(prefix: string) {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}-${Date.now().toString(36)}`;
}

function buildEditableSections(sections: ConfigSection[]): EditableSection[] {
  return sections.map((section) => ({
    id: createEditorId('section'),
    name: section.name,
    isNew: false,
    originalName: section.name,
    entries: section.entries.map((entry) => ({
      id: createEditorId('entry'),
      key: entry.key,
      value: entry.value,
      comment: entry.comment || '',
      isNew: false,
      originalKey: entry.key,
    })),
  }));
}

function createDraft(document: ConfigDocument): FileDraft {
  return {
    sections: buildEditableSections(document.sections),
    rawContent: document.rawContent,
    dirty: false,
    dirtyMode: null,
  };
}

function toConfigSections(sections: EditableSection[]): ConfigSection[] {
  return sections.map((section) => ({
    name: section.name,
    entries: section.entries.map((entry) => ({
      key: entry.key,
      value: entry.value,
      comment: entry.comment || undefined,
    })),
  }));
}

function formatRelativeTimestamp(timestamp?: number) {
  if (!timestamp) return 'Unknown';
  return new Date(timestamp).toLocaleString();
}

function formatSettingCount(count: number) {
  return `${count} ${count === 1 ? 'Setting' : 'Settings'}`;
}

function getConfigValueKind(value: string): ConfigValueKind {
  const trimmedValue = value.trim();
  if (!trimmedValue) return 'empty';
  if (/^(true|false)$/i.test(trimmedValue)) return 'boolean';
  if (/^-?\d+(\.\d+)?$/.test(trimmedValue)) return 'number';
  return 'text';
}

function formatValueKind(kind: ConfigValueKind) {
  switch (kind) {
    case 'boolean':
      return 'Boolean';
    case 'number':
      return 'Number';
    case 'empty':
      return 'Empty';
    case 'text':
    default:
      return 'Text';
  }
}

function getBooleanValue(value: string) {
  const normalizedValue = value.trim().toLowerCase();
  if (normalizedValue === 'true') return true;
  if (normalizedValue === 'false') return false;
  return null;
}

function getPreferredConfigFilePath(catalog: ConfigFileSummary[], currentSelection: string | null) {
  if (currentSelection && catalog.some((file) => file.path === currentSelection)) {
    return currentSelection;
  }

  return (
    catalog.find((file) => file.fileType === 'MelonPreferences')?.path ||
    catalog.find((file) => file.fileType === 'LoaderConfig')?.path ||
    catalog[0]?.path ||
    null
  );
}

function buildConfigDocumentSearchText(document: ConfigDocument) {
  const sectionText = document.sections
    .flatMap((section) => [
      section.name,
      ...section.entries.flatMap((entry) => [entry.key, entry.value, entry.comment || '']),
    ])
    .join('\n');

  return [
    document.summary.name,
    document.summary.path,
    document.summary.relativePath,
    document.summary.groupName,
    document.rawContent,
    sectionText,
  ].join('\n').toLowerCase();
}

function buildConfigDraftSearchText(draft: FileDraft) {
  const sectionText = draft.sections
    .flatMap((section) => [
      section.name,
      ...section.entries.flatMap((entry) => [entry.key, entry.value, entry.comment]),
    ])
    .join('\n');

  return [draft.rawContent, sectionText].join('\n').toLowerCase();
}

function getConfigExplorerMatches(draft: FileDraft | undefined, query: string): ConfigExplorerSectionMatch[] {
  if (!draft || !query) return [];

  return draft.sections
    .map((section) => {
      const sectionMatches = section.name.toLowerCase().includes(query);
      const entries = section.entries.filter((entry) =>
        entry.key.toLowerCase().includes(query) ||
        entry.value.toLowerCase().includes(query) ||
        entry.comment.toLowerCase().includes(query)
      );

      if (!sectionMatches && entries.length === 0) {
        return null;
      }

      return {
        id: section.id,
        name: section.name,
        entries: sectionMatches ? section.entries : entries,
        sectionMatches,
      };
    })
    .filter((section): section is ConfigExplorerSectionMatch => Boolean(section));
}

function buildOperations(originalSections: ConfigSection[], draftSections: EditableSection[]): ConfigEditOperation[] {
  const operations: ConfigEditOperation[] = [];
  const originalSectionMap = new Map(originalSections.map((section) => [section.name, section]));
  const draftSectionNames = new Set(draftSections.map((section) => section.name.trim()));

  for (const originalSection of originalSections) {
    if (!draftSectionNames.has(originalSection.name)) {
      operations.push({ kind: 'deleteSection', section: originalSection.name });
    }
  }

  for (const draftSection of draftSections) {
    const draftSectionName = draftSection.name.trim();
    const originalSection = draftSection.originalName ? originalSectionMap.get(draftSection.originalName) : undefined;

    if (!originalSection) {
      operations.push({ kind: 'addSection', section: draftSectionName });
      for (const entry of draftSection.entries) {
        operations.push({
          kind: 'addEntry',
          section: draftSectionName,
          key: entry.key.trim(),
          value: entry.value,
          comment: entry.comment.trim() || null,
        });
      }
      continue;
    }

    const originalEntryMap = new Map(originalSection.entries.map((entry) => [entry.key, entry]));
    const draftEntryKeys = new Set(draftSection.entries.map((entry) => entry.key.trim()));

    for (const originalEntry of originalSection.entries) {
      if (!draftEntryKeys.has(originalEntry.key)) {
        operations.push({
          kind: 'deleteEntry',
          section: originalSection.name,
          key: originalEntry.key,
        });
      }
    }

    for (const draftEntry of draftSection.entries) {
      const draftKey = draftEntry.key.trim();
      const originalEntry = draftEntry.originalKey ? originalEntryMap.get(draftEntry.originalKey) : undefined;

      if (!originalEntry) {
        operations.push({
          kind: 'addEntry',
          section: originalSection.name,
          key: draftKey,
          value: draftEntry.value,
          comment: draftEntry.comment.trim() || null,
        });
        continue;
      }

      if (originalEntry.value !== draftEntry.value) {
        operations.push({
          kind: 'setValue',
          section: originalSection.name,
          key: originalEntry.key,
          value: draftEntry.value,
        });
      }

      const originalComment = (originalEntry.comment || '').trim();
      const nextComment = draftEntry.comment.trim();
      if (originalComment !== nextComment) {
        operations.push({
          kind: 'setComment',
          section: originalSection.name,
          key: originalEntry.key,
          comment: nextComment || null,
        });
      }
    }
  }

  return operations;
}

function validateStructuredDraft(sections: EditableSection[]) {
  const seenSections = new Set<string>();

  for (const section of sections) {
    const sectionName = section.name.trim();
    if (!sectionName) return 'Section names cannot be empty.';
    if (seenSections.has(sectionName)) return `Section '${sectionName}' appears more than once.`;
    seenSections.add(sectionName);

    const seenKeys = new Set<string>();
    for (const entry of section.entries) {
      const key = entry.key.trim();
      if (!key) return `Section '${sectionName}' has an entry without a key.`;
      if (seenKeys.has(key)) return `Section '${sectionName}' contains duplicate key '${key}'.`;
      seenKeys.add(key);
    }
  }

  return null;
}

interface ConfigEntryValueEditorProps {
  sectionId: string;
  entry: EditableEntry;
  onChange: (sectionId: string, entryId: string, field: 'key' | 'value' | 'comment', value: string) => void;
}

function ConfigEntryValueEditor({ sectionId, entry, onChange }: ConfigEntryValueEditorProps) {
  const valueKind = getConfigValueKind(entry.value);
  const booleanValue = getBooleanValue(entry.value);

  if (valueKind === 'boolean') {
    return (
      <div className="config-entry-row__value-control">
        <div className="config-entry-row__value-heading">
          <span>Value</span>
          <span className="config-entry-row__value-kind">{formatValueKind(valueKind)}</span>
        </div>
        <div className="config-entry-row__boolean-group" role="group" aria-label={`Value for ${entry.key || 'new entry'}`}>
          <button
            type="button"
            className={`config-entry-row__boolean-option ${booleanValue === true ? 'config-entry-row__boolean-option--active' : ''}`}
            onClick={() => onChange(sectionId, entry.id, 'value', 'true')}
          >
            True
          </button>
          <button
            type="button"
            className={`config-entry-row__boolean-option ${booleanValue === false ? 'config-entry-row__boolean-option--active' : ''}`}
            onClick={() => onChange(sectionId, entry.id, 'value', 'false')}
          >
            False
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="config-entry-row__value-control">
      <div className="config-entry-row__value-heading">
        <label htmlFor={`config-value-${sectionId}-${entry.id}`}>Value</label>
        <span className="config-entry-row__value-kind">{formatValueKind(valueKind)}</span>
      </div>
      <input
        id={`config-value-${sectionId}-${entry.id}`}
        type="text"
        inputMode={valueKind === 'number' ? 'decimal' : 'text'}
        aria-label={`Value for ${entry.key || 'new entry'}`}
        value={entry.value}
        onChange={(event) => onChange(sectionId, entry.id, 'value', event.target.value)}
        placeholder={valueKind === 'empty' ? 'Enter value' : undefined}
      />
    </div>
  );
}

export function ConfigurationOverlay({ isOpen, environmentId, environment }: Props) {
  const [catalog, setCatalog] = useState<ConfigFileSummary[]>([]);
  const [documentCache, setDocumentCache] = useState<Record<string, ConfigDocument>>({});
  const [drafts, setDrafts] = useState<Record<string, FileDraft>>({});
  const [selectedFilePath, setSelectedFilePath] = useState<string | null>(null);
  const [editorMode, setEditorMode] = useState<EditorMode>('structured');
  const [fileFilter, setFileFilter] = useState('');
  const [sectionFilter, setSectionFilter] = useState('');
  const [activeSectionId, setActiveSectionId] = useState<string | null>(null);
  const [loadingCatalog, setLoadingCatalog] = useState(false);
  const [loadingDocument, setLoadingDocument] = useState(false);
  const [loadingFileSearchContents, setLoadingFileSearchContents] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingConfirm, setPendingConfirm] = useState<PendingConfirm | null>(null);
  const selectedFilePathRef = useRef<string | null>(null);
  const sectionTabsRef = useRef<HTMLDivElement | null>(null);
  const [sectionTabOverflow, setSectionTabOverflow] = useState({ left: false, right: false });

  const activeDocument = selectedFilePath ? documentCache[selectedFilePath] ?? null : null;
  const activeDraft = selectedFilePath ? drafts[selectedFilePath] ?? null : null;

  useEffect(() => {
    selectedFilePathRef.current = selectedFilePath;
  }, [selectedFilePath]);

  useEffect(() => {
    if (!isOpen) return;
    setCatalog([]);
    setDocumentCache({});
    setDrafts({});
    setSelectedFilePath(null);
    setEditorMode('structured');
    setFileFilter('');
    setSectionFilter('');
    setActiveSectionId(null);
    setError(null);
  }, [environmentId, isOpen]);

  useEffect(() => {
    if (!isOpen) return;

    let cancelled = false;
    const loadCatalog = async () => {
      setLoadingCatalog(true);
      setError(null);

      try {
        const nextCatalog = await ApiService.getConfigCatalog(environmentId);
        if (cancelled) return;

        setCatalog(nextCatalog);
        setSelectedFilePath((currentSelection) => getPreferredConfigFilePath(nextCatalog, currentSelection));
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to load configuration catalog');
        }
      } finally {
        if (!cancelled) {
          setLoadingCatalog(false);
        }
      }
    };

    void loadCatalog();

    return () => {
      cancelled = true;
    };
  }, [environmentId, isOpen]);

  useEffect(() => {
    if (!isOpen || !selectedFilePath) return;
    if (documentCache[selectedFilePath]) {
      const cached = documentCache[selectedFilePath];
      const draft = drafts[selectedFilePath];
      setEditorMode(draft?.dirtyMode ?? (cached.summary.supportsStructuredEdit ? 'structured' : 'raw'));
      return;
    }

    let cancelled = false;
    const loadDocument = async () => {
      const requestedFilePath = selectedFilePath;
      setLoadingDocument(true);
      setError(null);
      try {
        const document = await ApiService.getConfigDocument(environmentId, requestedFilePath);
        if (cancelled) return;

        setDocumentCache((current) => ({ ...current, [requestedFilePath]: document }));
        setDrafts((current) => current[requestedFilePath] ? current : { ...current, [requestedFilePath]: createDraft(document) });
        const draft = drafts[requestedFilePath];
        if (selectedFilePathRef.current === requestedFilePath) {
          setEditorMode(draft?.dirtyMode ?? (document.summary.supportsStructuredEdit ? 'structured' : 'raw'));
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to load configuration file');
        }
      } finally {
        if (!cancelled) {
          setLoadingDocument(false);
        }
      }
    };

    void loadDocument();

    return () => {
      cancelled = true;
    };
  }, [documentCache, drafts, environmentId, isOpen, selectedFilePath]);

  useEffect(() => {
    if (!isOpen || loadingCatalog || fileFilter.trim() === '') {
      setLoadingFileSearchContents(false);
      return;
    }

    const uncachedFiles = catalog.filter((file) => !documentCache[file.path]);
    if (uncachedFiles.length === 0) {
      setLoadingFileSearchContents(false);
      return;
    }

    let cancelled = false;
    const loadSearchContents = async () => {
      setLoadingFileSearchContents(true);

      const loadedDocuments = await Promise.allSettled(
        uncachedFiles.map(async (file) => ApiService.getConfigDocument(environmentId, file.path))
      );
      if (cancelled) return;

      const nextDocuments: Record<string, ConfigDocument> = {};
      for (const result of loadedDocuments) {
        if (result.status === 'fulfilled') {
          nextDocuments[result.value.summary.path] = result.value;
        }
      }

      if (Object.keys(nextDocuments).length > 0) {
        setDocumentCache((current) => ({ ...current, ...nextDocuments }));
        setDrafts((current) => {
          const nextDrafts = { ...current };
          for (const [filePath, document] of Object.entries(nextDocuments)) {
            if (!nextDrafts[filePath]) {
              nextDrafts[filePath] = createDraft(document);
            }
          }
          return nextDrafts;
        });
      }

      setLoadingFileSearchContents(false);
    };

    void loadSearchContents();

    return () => {
      cancelled = true;
    };
  }, [catalog, documentCache, environmentId, fileFilter, isOpen, loadingCatalog]);

  const filteredCatalog = useMemo(() => {
    const query = fileFilter.trim().toLowerCase();
    if (!query) return catalog;

    return catalog.filter((file) => {
      const summaryMatches =
        file.name.toLowerCase().includes(query) ||
        file.path.toLowerCase().includes(query) ||
        file.relativePath.toLowerCase().includes(query) ||
        file.groupName.toLowerCase().includes(query);

      if (summaryMatches) return true;

      const draft = drafts[file.path];
      if (draft && buildConfigDraftSearchText(draft).includes(query)) {
        return true;
      }

      const document = documentCache[file.path];
      return document ? buildConfigDocumentSearchText(document).includes(query) : false;
    });
  }, [catalog, documentCache, drafts, fileFilter]);
  const fileSearchQuery = fileFilter.trim().toLowerCase();

  const catalogGroups = useMemo(() => ({
    loader: filteredCatalog.filter((file) => file.fileType === 'LoaderConfig'),
    melon: filteredCatalog.filter((file) => file.fileType === 'MelonPreferences'),
    other: filteredCatalog.filter((file) => file.fileType === 'Other' || file.fileType === 'Json'),
  }), [filteredCatalog]);

  const otherCatalogGroups = useMemo(() => {
    const grouped = new Map<string, ConfigFileSummary[]>();
    for (const file of catalogGroups.other) {
      const key = file.groupName || 'Other Config Files';
      const current = grouped.get(key) || [];
      current.push(file);
      grouped.set(key, current);
    }
    return Array.from(grouped.entries()).sort(([a], [b]) => a.localeCompare(b));
  }, [catalogGroups.other]);

  const sectionTabs = useMemo(() => activeDraft?.sections ?? [], [activeDraft]);
  const rawEditorExtensions = useMemo(() => [rawConfigEditorTheme, EditorView.lineWrapping, rawConfigHighlighting], []);
  const activeSection = useMemo(
    () =>
      activeSectionId && activeSectionId !== ALL_SECTIONS_TAB
        ? sectionTabs.find((section) => section.id === activeSectionId) ?? null
        : null,
    [activeSectionId, sectionTabs]
  );
  const visibleSections = useMemo(() => {
    if (!activeDraft) return [];

    const query = sectionFilter.trim().toLowerCase();
    const sourceSections =
      activeSectionId && activeSectionId !== ALL_SECTIONS_TAB
        ? activeDraft.sections.filter((section) => section.id === activeSectionId)
        : activeDraft.sections;

    return sourceSections
      .map((section) => {
        if (!query) return section;

        const sectionMatches = section.name.toLowerCase().includes(query);
        const entries = section.entries.filter((entry) =>
          entry.key.toLowerCase().includes(query) ||
          entry.value.toLowerCase().includes(query) ||
          entry.comment.toLowerCase().includes(query)
        );

        if (sectionMatches && entries.length === 0) {
          return section;
        }

        if (entries.length === 0) {
          return null;
        }

        return { ...section, entries };
      })
      .filter((section): section is EditableSection => Boolean(section));
  }, [activeDraft, activeSectionId, sectionFilter]);

  const dirtyCount = useMemo(() => Object.values(drafts).filter((draft) => draft.dirty).length, [drafts]);
  const visibleEntryCount = useMemo(
    () => visibleSections.reduce((total, section) => total + section.entries.length, 0),
    [visibleSections]
  );
  const structuredAvailable = activeDocument?.summary.supportsStructuredEdit ?? false;

  const updateSectionTabOverflow = useCallback(() => {
    const element = sectionTabsRef.current;
    if (!element) {
      setSectionTabOverflow({ left: false, right: false });
      return;
    }

    const { scrollLeft, scrollWidth, clientWidth } = element;
    const maxScrollLeft = Math.max(0, scrollWidth - clientWidth);
    setSectionTabOverflow({
      left: scrollLeft > 2,
      right: scrollLeft < maxScrollLeft - 2,
    });
  }, []);

  const scrollSectionTabs = useCallback((delta: number) => {
    const element = sectionTabsRef.current;
    if (!element) return;
    element.scrollBy({ left: delta, behavior: 'smooth' });
  }, []);

  const handleSectionTabsWheel = useCallback((event: ReactWheelEvent<HTMLDivElement>) => {
    const element = sectionTabsRef.current;
    if (!element) return;

    const horizontalDelta = Math.abs(event.deltaX);
    const verticalDelta = Math.abs(event.deltaY);
    if (verticalDelta === 0 && horizontalDelta === 0) return;

    if (horizontalDelta > 0 || verticalDelta > 0) {
      event.preventDefault();
      element.scrollBy({
        left: horizontalDelta > verticalDelta ? event.deltaX : event.deltaY,
        behavior: 'auto',
      });
    }
  }, []);

  const updateActiveDraft = (updater: (draft: FileDraft) => FileDraft, dirtyMode: EditorMode) => {
    if (!selectedFilePath) return;
    setDrafts((current) => {
      const existingDraft = current[selectedFilePath];
      if (!existingDraft) return current;

      return {
        ...current,
        [selectedFilePath]: {
          ...updater(existingDraft),
          dirty: true,
          dirtyMode,
        },
      };
    });
  };

  const requestConfirm = (title: string, message: string, onConfirmAction: () => void) => {
    setPendingConfirm({ title, message, onConfirm: onConfirmAction });
  };

  useEffect(() => {
    if (!activeDraft) {
      setActiveSectionId(null);
      return;
    }

    if (activeDraft.sections.length === 0) {
      setActiveSectionId(null);
      return;
    }

    if (!activeSectionId || (activeSectionId !== ALL_SECTIONS_TAB && !activeDraft.sections.some((section) => section.id === activeSectionId))) {
      setActiveSectionId(ALL_SECTIONS_TAB);
    }
  }, [activeDraft, activeSectionId, selectedFilePath]);

  useEffect(() => {
    const element = sectionTabsRef.current;
    if (!element || editorMode !== 'structured') {
      setSectionTabOverflow({ left: false, right: false });
      return;
    }

    const syncOverflow = () => updateSectionTabOverflow();
    syncOverflow();
    element.addEventListener('scroll', syncOverflow, { passive: true });
    window.addEventListener('resize', syncOverflow);

    const resizeObserver = typeof ResizeObserver !== 'undefined'
      ? new ResizeObserver(syncOverflow)
      : null;
    resizeObserver?.observe(element);

    return () => {
      element.removeEventListener('scroll', syncOverflow);
      window.removeEventListener('resize', syncOverflow);
      resizeObserver?.disconnect();
    };
  }, [editorMode, sectionTabs, updateSectionTabOverflow]);

  const applyFileSelection = (file: ConfigFileSummary, preferredMode: EditorMode = 'structured') => {
    const nextMode = file.supportsStructuredEdit && preferredMode === 'structured' ? 'structured' : 'raw';
    setSelectedFilePath(file.path);
    setEditorMode(nextMode);
    setSectionFilter('');
    setActiveSectionId(null);
  };

  const handleSelectFile = (file: ConfigFileSummary, preferredMode: EditorMode = 'structured') => {
    if (file.path === selectedFilePath) {
      if ((preferredMode === 'raw' || !file.supportsStructuredEdit) && editorMode !== 'raw') {
        handleModeChange('raw');
      } else if (preferredMode === 'structured' && file.supportsStructuredEdit && editorMode !== 'structured') {
        handleModeChange('structured');
      }
      return;
    }

    if (activeDraft?.dirty) {
      requestConfirm(
        'Switch File?',
        'This file has unsaved changes. Switching files will keep the draft, but it will not be saved until you return and apply it.',
        () => {
          applyFileSelection(file, preferredMode);
        }
      );
      return;
    }

    applyFileSelection(file, preferredMode);
  };

  const handleSelectExplorerMatch = (file: ConfigFileSummary, sectionId?: string) => {
    const selectMatch = () => {
      const nextMode = file.supportsStructuredEdit ? 'structured' : 'raw';
      setSelectedFilePath(file.path);
      setEditorMode(nextMode);
      setSectionFilter('');
      setActiveSectionId(sectionId ?? null);
    };

    if (file.path === selectedFilePath) {
      if (file.supportsStructuredEdit && editorMode !== 'structured') {
        handleModeChange('structured');
      }
      setSectionFilter('');
      setActiveSectionId(sectionId ?? null);
      return;
    }

    if (activeDraft?.dirty) {
      setPendingConfirm({
        title: 'Discard unsaved draft?',
        message: 'Switching configuration files will leave the current unsaved draft in memory. You can return to it from the explorer before saving.',
        onConfirm: () => {
          setPendingConfirm(null);
          selectMatch();
        },
      });
      return;
    }

    selectMatch();
  };

  const handleReload = async () => {
    if (!selectedFilePath) return;
    const requestedFilePath = selectedFilePath;

    const reloadFile = async () => {
      setLoadingDocument(true);
      setError(null);
      try {
        const document = await ApiService.getConfigDocument(environmentId, requestedFilePath);
        setDocumentCache((current) => ({ ...current, [requestedFilePath]: document }));
        setDrafts((current) => ({ ...current, [requestedFilePath]: createDraft(document) }));
        if (selectedFilePathRef.current === requestedFilePath && !document.summary.supportsStructuredEdit) {
          setEditorMode('raw');
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to reload configuration file');
      } finally {
        setLoadingDocument(false);
      }
    };

    if (activeDraft?.dirty) {
      requestConfirm(
        'Reload File?',
        'Reloading will discard the unsaved draft for this file and restore the current content from disk.',
        () => {
          void reloadFile();
        }
      );
      return;
    }

    await reloadFile();
  };

  const handleDiscard = () => {
    if (!selectedFilePath || !activeDocument) return;
    setDrafts((current) => ({ ...current, [selectedFilePath]: createDraft(activeDocument) }));
  };

  const handleModeChange = (nextMode: EditorMode) => {
    if (!activeDocument || !activeDraft || nextMode === editorMode) return;

    if (activeDraft.dirty && activeDraft.dirtyMode && activeDraft.dirtyMode !== nextMode) {
      requestConfirm(
        'Discard Current Draft?',
        `Switching to ${nextMode === 'raw' ? 'Raw' : 'Structured'} mode will discard the unsaved ${activeDraft.dirtyMode} draft for this file.`,
        () => {
          if (!selectedFilePath) return;
          setDrafts((current) => ({ ...current, [selectedFilePath]: createDraft(activeDocument) }));
          setEditorMode(nextMode);
        }
      );
      return;
    }

    setEditorMode(nextMode);
  };

  const handleDeleteSection = (sectionId: string) => {
    updateActiveDraft((draft) => ({
      ...draft,
      sections: draft.sections.filter((section) => section.id !== sectionId),
    }), 'structured');
  };

  const handleAddEntry = (sectionId: string) => {
    updateActiveDraft((draft) => ({
      ...draft,
      sections: draft.sections.map((section) =>
        section.id === sectionId
          ? {
              ...section,
              entries: [
                ...section.entries,
                {
                  id: createEditorId('entry'),
                  key: '',
                  value: '',
                  comment: '',
                  isNew: true,
                  originalKey: null,
                },
              ],
            }
          : section
      ),
    }), 'structured');
  };

  const handleDeleteEntry = (sectionId: string, entryId: string) => {
    updateActiveDraft((draft) => ({
      ...draft,
      sections: draft.sections.map((section) =>
        section.id === sectionId
          ? { ...section, entries: section.entries.filter((entry) => entry.id !== entryId) }
          : section
      ),
    }), 'structured');
  };

  const handleEntryChange = (
    sectionId: string,
    entryId: string,
    field: 'key' | 'value' | 'comment',
    value: string
  ) => {
    updateActiveDraft((draft) => ({
      ...draft,
      sections: draft.sections.map((section) =>
        section.id === sectionId
          ? {
              ...section,
              entries: section.entries.map((entry) =>
                entry.id === entryId ? { ...entry, [field]: value } : entry
              ),
            }
          : section
      ),
    }), 'structured');
  };

  const handleRawChange = (value: string) => {
    updateActiveDraft((draft) => ({
      ...draft,
      rawContent: value,
    }), 'raw');
  };

  const handleSave = async () => {
    if (!selectedFilePath || !activeDocument || !activeDraft) return;
    const requestedFilePath = selectedFilePath;

    setSaving(true);
    setError(null);

    try {
      if (editorMode === 'raw') {
        await ApiService.saveRawConfig(environmentId, requestedFilePath, activeDraft.rawContent);
      } else {
        const validationError = validateStructuredDraft(activeDraft.sections);
        if (validationError) {
          setError(validationError);
          setSaving(false);
          return;
        }

        const operations = buildOperations(activeDocument.sections, activeDraft.sections);
        await ApiService.applyConfigEdits(environmentId, requestedFilePath, operations);
      }

      const savedDocument: ConfigDocument = {
        ...activeDocument,
        rawContent: editorMode === 'raw' ? activeDraft.rawContent : activeDocument.rawContent,
        sections: editorMode === 'raw' ? activeDocument.sections : toConfigSections(activeDraft.sections),
      };
      setDocumentCache((current) => ({ ...current, [requestedFilePath]: savedDocument }));
      setDrafts((current) => ({ ...current, [requestedFilePath]: createDraft(savedDocument) }));

      try {
        const [nextCatalog, nextDocument] = await Promise.all([
          ApiService.getConfigCatalog(environmentId),
          ApiService.getConfigDocument(environmentId, requestedFilePath),
        ]);

        setCatalog(nextCatalog);
        setDocumentCache((current) => ({ ...current, [requestedFilePath]: nextDocument }));
        setDrafts((current) => ({ ...current, [requestedFilePath]: createDraft(nextDocument) }));
        if (selectedFilePathRef.current === requestedFilePath) {
          setEditorMode((currentMode) => (
            currentMode === 'structured' && !nextDocument.summary.supportsStructuredEdit
              ? 'raw'
              : currentMode
          ));
        }
      } catch (err) {
        setError(
          err instanceof Error
            ? `Changes saved, but SIMM could not refresh the editor state: ${err.message}`
            : 'Changes saved, but SIMM could not refresh the editor state.'
        );
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save configuration changes');
    } finally {
      setSaving(false);
    }
  };

  const renderExplorerFile = (file: ConfigFileSummary) => {
    const draft = drafts[file.path];
    const selected = file.path === selectedFilePath;
    const matches = getConfigExplorerMatches(draft, fileSearchQuery);
    const showMatchTree = fileSearchQuery.length > 0 && matches.length > 0;

    return (
      <div key={file.path} className={`config-explorer__file-stack ${showMatchTree ? 'config-explorer__file-stack--tree' : ''}`}>
        <button
          type="button"
          className={`config-explorer__file ${selected ? 'config-explorer__file--active' : ''}`}
          onClick={() => handleSelectFile(file)}
        >
          <div className="config-explorer__file-head">
            <strong>{file.name}</strong>
            {draft?.dirty && <span className="config-editor__dirty-dot" aria-label="Unsaved changes" />}
          </div>
          <div className="config-explorer__file-meta">
            <span>{file.sectionCount} section{file.sectionCount === 1 ? '' : 's'}</span>
            <span>{formatSettingCount(file.entryCount)}</span>
          </div>
          <div className="config-explorer__file-path" title={file.relativePath}>
            {file.relativePath}
          </div>
        </button>

        {showMatchTree && (
          <div className="config-explorer__match-tree" aria-label={`Matches in ${file.name}`}>
            {matches.map((section) => (
              <div key={section.id} className="config-explorer__match-section">
                <button
                  type="button"
                  className="config-explorer__match-section-button"
                  onClick={() => handleSelectExplorerMatch(file, section.id)}
                >
                  <Icon name="fas fa-folder-tree" />
                  <span>{section.name}</span>
                </button>
                {section.entries.length > 0 && (
                  <div className="config-explorer__match-entries">
                    {section.entries.slice(0, 8).map((entry) => (
                      <button
                        key={entry.id}
                        type="button"
                        className="config-explorer__match-entry"
                        onClick={() => handleSelectExplorerMatch(file, section.id)}
                        title={`${entry.key} = ${entry.value}`}
                      >
                        <span className="config-explorer__match-entry-key">{entry.key}</span>
                        <span className="config-explorer__match-entry-value">{entry.value}</span>
                      </button>
                    ))}
                    {section.entries.length > 8 && (
                      <button
                        type="button"
                        className="config-explorer__match-more"
                        onClick={() => handleSelectExplorerMatch(file, section.id)}
                      >
                        {section.entries.length - 8} more
                      </button>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    );
  };

  if (!isOpen) return null;

  return (
    <div className="modal-content workspace-panel config-editor config-editor--workspace">
      <ConfirmOverlay
        isOpen={Boolean(pendingConfirm)}
        onClose={() => setPendingConfirm(null)}
        onConfirm={() => {
          if (!pendingConfirm) return;
          pendingConfirm.onConfirm();
        }}
        title={pendingConfirm?.title || ''}
        message={pendingConfirm?.message || ''}
        confirmText="Continue"
        cancelText="Cancel"
        isNested
      />

      <WorkspacePageHeader
        eyebrow={environment.name}
        title="Configuration"
        description={`Browse files, edit structured settings, and keep raw config fallbacks available for ${environment.name}.`}
      />

      {error && <div className="settings-error-banner">{error}</div>}

      <div className="config-editor__shell">
        <aside className="config-explorer">
          <div className="config-explorer__overview">
            <div className="config-explorer__overview-head">
              <span className="settings-eyebrow">Files</span>
              <div className="config-explorer__overview-stats">
                <span>{catalog.length} file{catalog.length === 1 ? '' : 's'}</span>
                <span>{dirtyCount} draft{dirtyCount === 1 ? '' : 's'}</span>
              </div>
            </div>
          </div>

          <div className="config-explorer__search">
            <Icon name="fas fa-search" />
            <input
              type="text"
              value={fileFilter}
              onChange={(e) => setFileFilter(e.target.value)}
              placeholder="Search config files"
            />
          </div>

          <div className="config-explorer__list">
            {loadingCatalog ? (
              <div className="config-editor__empty">
                <Icon name="fas fa-spinner fa-spin" />
                <strong>Loading configuration catalog</strong>
              </div>
            ) : (
              <>
                {[
                  { label: 'Loader', files: catalogGroups.loader },
                  { label: 'MelonPreferences', files: catalogGroups.melon },
                ].map((group) =>
                  group.files.length > 0 ? (
                    <section key={group.label} className="config-explorer__group">
                      <div className="config-explorer__group-label">{group.label}</div>
                      {group.files.map((file) => renderExplorerFile(file))}
                    </section>
                  ) : null
                )}

                {otherCatalogGroups.length > 0 && (
                  <section className="config-explorer__group">
                    <div className="config-explorer__group-label">Other Config Files</div>
                    {otherCatalogGroups.map(([groupName, files]) => (
                      <div key={groupName} className="config-explorer__nested-group">
                        <div className="config-explorer__nested-label">{groupName}</div>
                        {files.map((file) => renderExplorerFile(file))}
                      </div>
                    ))}
                  </section>
                )}

                {!loadingCatalog && filteredCatalog.length === 0 && (
                  <div className="config-editor__empty">
                    <Icon name={loadingFileSearchContents ? 'fas fa-spinner fa-spin' : 'fas fa-file-circle-question'} />
                    <strong>{loadingFileSearchContents ? 'Searching file contents' : 'No config files found'}</strong>
                    <p>{loadingFileSearchContents ? 'Checking entries, values, comments, and raw config text.' : 'Try a different search term or verify that this environment has generated config files.'}</p>
                  </div>
                )}
              </>
            )}
          </div>
        </aside>

        <section className={`config-workspace ${activeDocument?.parseWarnings.length ? 'config-workspace--with-warning' : ''} ${editorMode === 'raw' ? 'config-workspace--raw' : ''}`}>
          {!selectedFilePath ? (
            <div className="config-editor__empty config-editor__empty--workspace">
              <Icon name="fas fa-sliders" />
              <strong>Select a configuration file</strong>
              <p>Choose a file from the explorer to inspect and edit its current settings.</p>
            </div>
          ) : loadingDocument && !activeDocument ? (
            <div className="config-editor__empty config-editor__empty--workspace">
              <Icon name="fas fa-spinner fa-spin" />
              <strong>Loading configuration file</strong>
            </div>
          ) : activeDocument && activeDraft ? (
            <>
              <header className="config-workspace__header">
                <div className="config-workspace__identity">
                  <div className="config-workspace__title-row">
                    <h3 title={activeDocument.summary.path}>{activeDocument.summary.name}</h3>
                    <div className="config-workspace__mode-switch" role="group" aria-label="Editor mode">
                      <button
                        type="button"
                        className={`config-workspace__mode-button ${editorMode === 'structured' ? 'config-workspace__mode-button--active' : ''}`}
                        onClick={() => handleModeChange('structured')}
                        disabled={!structuredAvailable}
                      >
                        Structured
                      </button>
                      <button
                        type="button"
                        className={`config-workspace__mode-button ${editorMode === 'raw' ? 'config-workspace__mode-button--active' : ''}`}
                        onClick={() => handleModeChange('raw')}
                      >
                        Raw
                      </button>
                    </div>
                  </div>
                </div>

                <div className="config-workspace__actions">
                  <div className="config-workspace__state">
                    <span>{activeDocument.summary.entryCount} values</span>
                    <span>{activeDocument.summary.sectionCount} sections</span>
                    <span>Modified {formatRelativeTimestamp(activeDocument.summary.lastModified)}</span>
                  </div>
                  <button type="button" className="btn btn-secondary" onClick={() => void ApiService.openPath(activeDocument.summary.path)}>
                    <Icon name="fas fa-file-lines" />
                    Open File
                  </button>
                  <button type="button" className="btn btn-secondary" onClick={() => void ApiService.revealPath(activeDocument.summary.path)}>
                    <Icon name="fas fa-folder-open" />
                    Open Folder
                  </button>
                  <button type="button" className="btn btn-secondary" onClick={() => void handleReload()} disabled={loadingDocument || saving}>
                    <Icon name={loadingDocument ? 'fas fa-spinner fa-spin' : 'fas fa-rotate'} />
                    Reload
                  </button>
                </div>
              </header>

              {editorMode === 'structured' ? (
                <div className="config-workspace__toolbar">
                  <div className="config-workspace__toolbar-main">
                    <div className={`config-workspace__section-tabs-shell ${sectionTabOverflow.left ? 'config-workspace__section-tabs-shell--left' : ''} ${sectionTabOverflow.right ? 'config-workspace__section-tabs-shell--right' : ''}`}>
                      {sectionTabOverflow.left && (
                        <button
                          type="button"
                          className="config-workspace__section-tabs-shift config-workspace__section-tabs-shift--left"
                          aria-label="Show earlier sections"
                          onClick={() => scrollSectionTabs(-240)}
                        >
                          <Icon name="fas fa-chevron-left" />
                        </button>
                      )}
                      <div
                        ref={sectionTabsRef}
                        className="config-workspace__section-tabs"
                        onWheel={handleSectionTabsWheel}
                      >
                        {sectionTabs.length > 1 && (
                          <button
                            type="button"
                            className={`config-workspace__section-tab ${activeSectionId === ALL_SECTIONS_TAB ? 'config-workspace__section-tab--active' : ''}`}
                            onClick={() => setActiveSectionId(ALL_SECTIONS_TAB)}
                          >
                            All Sections
                          </button>
                        )}
                        {sectionTabs.map((section) => (
                          <button
                            key={section.id}
                            type="button"
                            className={`config-workspace__section-tab ${activeSectionId === section.id ? 'config-workspace__section-tab--active' : ''}`}
                            onClick={() => setActiveSectionId(section.id)}
                          >
                            {section.name}
                          </button>
                        ))}
                      </div>
                      {sectionTabOverflow.right && (
                        <button
                          type="button"
                          className="config-workspace__section-tabs-shift config-workspace__section-tabs-shift--right"
                          aria-label="Show later sections"
                          onClick={() => scrollSectionTabs(240)}
                        >
                          <Icon name="fas fa-chevron-right" />
                        </button>
                      )}
                    </div>
                  </div>

                  <div className="config-workspace__toolbar-actions">
                    <div className="config-editor__search config-editor__search--workspace">
                      <Icon name="fas fa-search" />
                      <input
                        type="text"
                        value={sectionFilter}
                        onChange={(e) => setSectionFilter(e.target.value)}
                        placeholder="Filter settings"
                      />
                    </div>
                    {activeSectionId && activeSectionId !== ALL_SECTIONS_TAB && (
                      <button
                        type="button"
                        className="btn btn-secondary btn-small"
                        onClick={() => handleAddEntry(activeSectionId)}
                      >
                        <Icon name="fas fa-plus" />
                        Add Entry
                      </button>
                    )}
                  </div>
                </div>
              ) : null}

              {activeDocument.parseWarnings.length > 0 && (
                <div className="config-editor__warning">
                  <Icon name="fas fa-triangle-exclamation" />
                  <span className="settings-chip">
                    Raw Fallback
                  </span>
                  <div>
                    <strong>Structured editing is unavailable for part of this file.</strong>
                    <p>{activeDocument.parseWarnings[0]}</p>
                  </div>
                </div>
              )}

              <div className={`config-workspace__body ${editorMode === 'raw' ? 'config-workspace__body--raw' : 'config-workspace__body--structured'}`}>
                {editorMode === 'structured' ? (
                  <div className="config-structured">
                    <div className="config-structured__sheet">
                      {activeSection && (
                        <div className="config-structured__header">
                          <div>
                            <h4>{activeSection.name}</h4>
                            <p>{formatSettingCount(visibleEntryCount)}</p>
                          </div>
                          <div className="config-structured__header-actions">
                            <button
                              type="button"
                              className="btn btn-danger btn-small"
                              onClick={() => handleDeleteSection(activeSection.id)}
                            >
                              <Icon name="fas fa-trash" />
                              Remove Section
                            </button>
                          </div>
                        </div>
                      )}

                      <div className="config-structured__sections">
                        {visibleSections.length === 0 ? (
                          <div className="config-editor__empty config-editor__empty--workspace">
                            <Icon name="fas fa-sliders" />
                            <strong>No matching settings</strong>
                            <p>Adjust the search or switch sections to widen the result set.</p>
                          </div>
                        ) : (
                          visibleSections.map((section) => (
                            <article key={section.id} className={`config-section-card ${activeSection ? 'config-section-card--active-section' : ''}`}>
                              {!activeSection && (
                                <div className="config-section-card__header">
                                  <div className="config-section-card__title">
                                    <h4>{section.name}</h4>
                                    <p>{formatSettingCount(section.entries.length)}</p>
                                  </div>
                                  <div className="config-section-card__header-actions">
                                    <button type="button" className="btn btn-secondary btn-small" onClick={() => handleAddEntry(section.id)}>
                                      <Icon name="fas fa-plus" />
                                      Add Entry
                                    </button>
                                    <button type="button" className="btn btn-danger btn-small" onClick={() => handleDeleteSection(section.id)}>
                                      <Icon name="fas fa-trash" />
                                      Remove Section
                                    </button>
                                  </div>
                                </div>
                              )}

                              <div className="config-section-card__entries">
                                {section.entries.map((entry) => (
                                  <div key={entry.id} className="config-entry-row">
                                    <div className="config-entry-row__header">
                                      <div className="config-entry-row__key">
                                        {entry.isNew ? (
                                          <>
                                            <label htmlFor={`config-key-${section.id}-${entry.id}`}>Key</label>
                                            <input
                                              id={`config-key-${section.id}-${entry.id}`}
                                              type="text"
                                              value={entry.key}
                                              onChange={(e) => handleEntryChange(section.id, entry.id, 'key', e.target.value)}
                                              placeholder="settingName"
                                            />
                                          </>
                                        ) : (
                                          <div className="config-entry-row__key-label" title={entry.key}>
                                            {entry.key}
                                          </div>
                                        )}
                                      </div>

                                      <button
                                        type="button"
                                        className="config-entry-row__delete"
                                        aria-label={`Delete ${entry.key || 'entry'}`}
                                        onClick={() => handleDeleteEntry(section.id, entry.id)}
                                      >
                                        <Icon name="fas fa-trash" />
                                      </button>
                                    </div>

                                    <div className="config-entry-row__value">
                                      <ConfigEntryValueEditor
                                        sectionId={section.id}
                                        entry={entry}
                                        onChange={handleEntryChange}
                                      />
                                    </div>

                                    <div className="config-entry-row__comment">
                                      <label htmlFor={`config-comment-${section.id}-${entry.id}`}>Comment</label>
                                      <textarea
                                        id={`config-comment-${section.id}-${entry.id}`}
                                        aria-label={`Comment for ${entry.key || 'new entry'}`}
                                        value={entry.comment}
                                        onChange={(e) => handleEntryChange(section.id, entry.id, 'comment', e.target.value)}
                                        rows={2}
                                        placeholder="Optional inline comment"
                                      />
                                    </div>
                                  </div>
                                ))}
                              </div>
                            </article>
                          ))
                        )}
                      </div>
                    </div>
                  </div>
                ) : (
                  <div className="config-raw">
                    <div className="config-raw__editor">
                      <CodeMirror
                        value={activeDraft.rawContent}
                        height="100%"
                        width="100%"
                        minWidth="0"
                        maxHeight="100%"
                        maxWidth="100%"
                        basicSetup={false}
                        extensions={rawEditorExtensions}
                        onChange={handleRawChange}
                        aria-label="Raw config content"
                      />
                    </div>
                  </div>
                )}
              </div>
              <footer className="config-workspace__draft-bar">
                <div className="config-workspace__draft-state">
                  <span className={`config-workspace__draft-indicator ${activeDraft.dirty ? 'config-workspace__draft-indicator--dirty' : ''}`} />
                  <strong>{activeDraft.dirty ? 'Unsaved draft' : 'No unsaved changes'}</strong>
                  <span>{dirtyCount} draft{dirtyCount === 1 ? '' : 's'}</span>
                  <span>{visibleEntryCount} visible setting{visibleEntryCount === 1 ? '' : 's'}</span>
                </div>
                <div className="config-workspace__draft-actions">
                  <button type="button" className="btn btn-secondary" onClick={handleDiscard} disabled={!activeDraft.dirty || saving}>
                    <Icon name="fas fa-rotate-left" />
                    Discard
                  </button>
                  <button
                    type="button"
                    className="btn btn-primary"
                    aria-label="Save"
                    onClick={() => void handleSave()}
                    disabled={!activeDraft.dirty || saving}
                  >
                    <Icon name={saving ? 'fas fa-spinner fa-spin' : 'fas fa-save'} />
                    {saving ? 'Saving...' : 'Save Changes'}
                  </button>
                </div>
              </footer>
            </>
          ) : null}
        </section>
      </div>
    </div>
  );
}
