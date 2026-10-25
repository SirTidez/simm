import {
  Suspense,
  lazy,
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from 'react';

import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';

import { AnchoredContextMenu, type AnchoredContextMenuItem } from './AnchoredContextMenu';
import { ConfirmOverlay } from './ConfirmOverlay';
import { ApiService } from '../services/api';
import { Icon } from './Icon';
import { SimmButton } from './primitives';
import { ModThumbnail } from './media/ModThumbnail';
import { useLibraryArtwork } from './useLibraryArtwork';
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
const ConfigRawEditor = lazy(() => import('./ConfigRawEditor').then((module) => ({ default: module.ConfigRawEditor })));

type OpenMenuHandler = (id: string, event: ReactMouseEvent<HTMLElement>, items: AnchoredContextMenuItem[]) => void;

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

const DATE_TIME_FORMAT = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
});

function formatRelativeTimestamp(timestamp?: number) {
  if (!timestamp) return 'Unknown';
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? 'Unknown' : DATE_TIME_FORMAT.format(date);
}

function formatSettingCount(count: number) {
  return `${count} ${count === 1 ? 'setting' : 'settings'}`;
}

function formatSectionCount(count: number) {
  return `${count} ${count === 1 ? 'section' : 'sections'}`;
}

function getConfigValueKind(value: string): ConfigValueKind {
  const trimmedValue = value.trim();
  if (!trimmedValue) return 'empty';
  if (/^(true|false)$/i.test(trimmedValue)) return 'boolean';
  if (/^-?\d+(\.\d+)?$/.test(trimmedValue)) return 'number';
  return 'text';
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

function textMatchesQuery(value: string, query: string): boolean {
  return value.toLowerCase().includes(query);
}

function getConfigExplorerMatches(draft: FileDraft | undefined, query: string): ConfigExplorerSectionMatch[] {
  if (!draft || !query) return [];

  const matches: ConfigExplorerSectionMatch[] = [];
  for (const section of draft.sections) {
    const sectionMatches = textMatchesQuery(section.name, query);
    const entries = section.entries.filter((entry) =>
      textMatchesQuery(entry.key, query) ||
      textMatchesQuery(entry.value, query) ||
      textMatchesQuery(entry.comment, query)
    );

    if (!sectionMatches && entries.length === 0) {
      continue;
    }

    matches.push({
      id: section.id,
      name: section.name,
      entries: sectionMatches ? section.entries : entries,
      sectionMatches,
    });
  }

  return matches;
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

const ConfigEntryValueEditor = memo(function ConfigEntryValueEditor({ sectionId, entry, onChange }: ConfigEntryValueEditorProps) {
  const valueKind = getConfigValueKind(entry.value);
  const booleanValue = getBooleanValue(entry.value);
  const valueLabel = `Value for ${entry.key || 'new entry'}`;

  if (valueKind === 'boolean') {
    return (
      <div className="config-prop__bool">
        <Switch
          checked={booleanValue === true}
          onCheckedChange={(checked) => onChange(sectionId, entry.id, 'value', checked ? 'true' : 'false')}
          aria-label={valueLabel}
        />
        <span className="config-prop__bool-text" aria-hidden="true">{booleanValue ? 'True' : 'False'}</span>
      </div>
    );
  }

  return (
    <Input
      id={`config-value-${sectionId}-${entry.id}`}
      type="text"
      className={`config-prop__input ${valueKind === 'number' ? 'config-prop__input--number' : ''}`}
      inputMode={valueKind === 'number' ? 'decimal' : 'text'}
      aria-label={valueLabel}
      value={entry.value}
      onChange={(event) => onChange(sectionId, entry.id, 'value', event.target.value)}
      placeholder={valueKind === 'empty' ? 'Empty' : undefined}
      spellCheck={false}
    />
  );
});

interface ConfigEntryRowProps {
  sectionId: string;
  entry: EditableEntry;
  onChange: ConfigEntryValueEditorProps['onChange'];
  onDelete: (sectionId: string, entryId: string) => void;
  onOpenMenu: OpenMenuHandler;
}

const ConfigEntryRow = memo(function ConfigEntryRow({ sectionId, entry, onChange, onDelete, onOpenMenu }: ConfigEntryRowProps) {
  const [editingComment, setEditingComment] = useState(false);
  const keyInputId = `config-key-${sectionId}-${entry.id}`;
  const commentInputId = `config-comment-${sectionId}-${entry.id}`;
  const entryLabel = entry.key || 'entry';

  useEffect(() => {
    if (!editingComment) return;
    // Wait for the menu that opened the editor to hand focus back first.
    const timeoutId = window.setTimeout(() => document.getElementById(commentInputId)?.focus(), 0);
    return () => window.clearTimeout(timeoutId);
  }, [commentInputId, editingComment]);

  const handleKeyChange = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    onChange(sectionId, entry.id, 'key', event.target.value);
  }, [entry.id, onChange, sectionId]);

  const handleCommentChange = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    onChange(sectionId, entry.id, 'comment', event.target.value);
  }, [entry.id, onChange, sectionId]);

  const handleCommentKeyDown = useCallback((event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter' || event.key === 'Escape') {
      event.preventDefault();
      setEditingComment(false);
    }
  }, []);

  const handleOpenMenu = (event: ReactMouseEvent<HTMLElement>) => {
    onOpenMenu(`config-entry-${entry.id}`, event, [
      {
        key: 'comment',
        label: entry.comment ? 'Edit Comment' : 'Add Comment',
        icon: 'fas fa-pen-to-square',
        onSelect: () => setEditingComment(true),
      },
      {
        key: 'delete',
        label: 'Delete Entry',
        icon: 'fas fa-trash',
        danger: true,
        separatorBefore: true,
        onSelect: () => onDelete(sectionId, entry.id),
      },
    ]);
  };

  return (
    <div className={`config-prop ${entry.isNew ? 'config-prop--new' : ''}`}>
      <div className="config-prop__key">
        {entry.isNew ? (
          <Input
            id={keyInputId}
            type="text"
            className="config-prop__key-input"
            aria-label="Key"
            value={entry.key}
            onChange={handleKeyChange}
            placeholder="settingName"
            spellCheck={false}
          />
        ) : (
          <span className="config-prop__key-text" title={entry.key}>
            {entry.key}
          </span>
        )}
        {editingComment ? (
          <Input
            id={commentInputId}
            type="text"
            className="config-prop__comment-input"
            aria-label={`Comment for ${entryLabel}`}
            value={entry.comment}
            onChange={handleCommentChange}
            onBlur={() => setEditingComment(false)}
            onKeyDown={handleCommentKeyDown}
            placeholder="Comment written above this setting"
          />
        ) : entry.comment ? (
          <button
            type="button"
            className="config-prop__comment"
            title="Edit comment"
            onClick={() => setEditingComment(true)}
          >
            {entry.comment}
          </button>
        ) : null}
      </div>

      <div className="config-prop__value">
        <ConfigEntryValueEditor sectionId={sectionId} entry={entry} onChange={onChange} />
      </div>

      <SimmButton
        type="button"
        variant="ghost"
        size="icon-sm"
        className="config-prop__more"
        aria-label={`More actions for ${entryLabel}`}
        aria-haspopup="menu"
        onClick={handleOpenMenu}
      >
        <Icon name="fas fa-ellipsis-h" />
      </SimmButton>
    </div>
  );
});

export function ConfigurationOverlay({ isOpen, environmentId }: Props) {
  const getModArtwork = useLibraryArtwork();
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
  const draftRevisionRef = useRef<Map<string, number>>(new Map());
  const [actionMenu, setActionMenu] = useState<{ id: string; x: number; y: number; items: AnchoredContextMenuItem[] } | null>(null);

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

    const timeoutId = window.setTimeout(() => {
      void loadSearchContents();
    }, 250);

    return () => {
      cancelled = true;
      window.clearTimeout(timeoutId);
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
  const visibleSections = useMemo(() => {
    if (!activeDraft) return [];

    const query = sectionFilter.trim().toLowerCase();
    const sourceSections =
      activeSectionId && activeSectionId !== ALL_SECTIONS_TAB
        ? activeDraft.sections.filter((section) => section.id === activeSectionId)
        : activeDraft.sections;

    const nextSections: EditableSection[] = [];
    for (const section of sourceSections) {
      if (!query) {
        nextSections.push(section);
        continue;
      }

      const sectionMatches = textMatchesQuery(section.name, query);
      const entries = section.entries.filter((entry) =>
        textMatchesQuery(entry.key, query) ||
        textMatchesQuery(entry.value, query) ||
        textMatchesQuery(entry.comment, query)
      );

      if (sectionMatches && entries.length === 0) {
        nextSections.push(section);
        continue;
      }

      if (entries.length === 0) {
        continue;
      }

      nextSections.push({ ...section, entries });
    }

    return nextSections;
  }, [activeDraft, activeSectionId, sectionFilter]);

  const dirtyCount = useMemo(() => Object.values(drafts).filter((draft) => draft.dirty).length, [drafts]);
  const structuredAvailable = activeDocument?.summary.supportsStructuredEdit ?? false;

  const openActionMenu = useCallback<OpenMenuHandler>((id, event, items) => {
    const rect = event.currentTarget.getBoundingClientRect();
    setActionMenu((current) => (current?.id === id ? null : { id, x: rect.left, y: rect.bottom + 4, items }));
  }, []);

  const updateActiveDraft = useCallback((updater: (draft: FileDraft) => FileDraft, dirtyMode: EditorMode) => {
    const currentSelectedFilePath = selectedFilePathRef.current;
    if (!currentSelectedFilePath) return;
    draftRevisionRef.current.set(
      currentSelectedFilePath,
      (draftRevisionRef.current.get(currentSelectedFilePath) ?? 0) + 1,
    );
    setDrafts((current) => {
      const existingDraft = current[currentSelectedFilePath];
      if (!existingDraft) return current;

      return {
        ...current,
        [currentSelectedFilePath]: {
          ...updater(existingDraft),
          dirty: true,
          dirtyMode,
        },
      };
    });
  }, []);

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

  const handleDeleteSection = useCallback((sectionId: string) => {
    updateActiveDraft((draft) => ({
      ...draft,
      sections: draft.sections.filter((section) => section.id !== sectionId),
    }), 'structured');
  }, [updateActiveDraft]);

  const handleAddEntry = useCallback((sectionId: string) => {
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
  }, [updateActiveDraft]);

  const handleDeleteEntry = useCallback((sectionId: string, entryId: string) => {
    updateActiveDraft((draft) => ({
      ...draft,
      sections: draft.sections.map((section) =>
        section.id === sectionId
          ? { ...section, entries: section.entries.filter((entry) => entry.id !== entryId) }
          : section
      ),
    }), 'structured');
  }, [updateActiveDraft]);

  const handleEntryChange = useCallback((
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
  }, [updateActiveDraft]);

  const handleRawChange = useCallback((value: string) => {
    updateActiveDraft((draft) => ({
      ...draft,
      rawContent: value,
    }), 'raw');
  }, [updateActiveDraft]);

  const handleSave = async () => {
    if (!selectedFilePath || !activeDocument || !activeDraft) return;
    const requestedFilePath = selectedFilePath;
    const saveRevision = draftRevisionRef.current.get(requestedFilePath) ?? 0;

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
      if ((draftRevisionRef.current.get(requestedFilePath) ?? 0) === saveRevision) {
        setDrafts((current) => ({ ...current, [requestedFilePath]: createDraft(savedDocument) }));
      }

      try {
        const [nextCatalog, nextDocument] = await Promise.all([
          ApiService.getConfigCatalog(environmentId),
          ApiService.getConfigDocument(environmentId, requestedFilePath),
        ]);

        setCatalog(nextCatalog);
        setDocumentCache((current) => ({ ...current, [requestedFilePath]: nextDocument }));
        if ((draftRevisionRef.current.get(requestedFilePath) ?? 0) === saveRevision) {
          setDrafts((current) => ({ ...current, [requestedFilePath]: createDraft(nextDocument) }));
        }
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
      <div key={file.path} className="config-explorer__item">
        <button
          type="button"
          className="config-explorer__file"
          aria-current={selected ? 'true' : undefined}
          title={`${file.relativePath} · ${formatSectionCount(file.sectionCount)} · ${formatSettingCount(file.entryCount)}`}
          onClick={() => handleSelectFile(file)}
        >
          <span className="config-explorer__file-name">
            <span className="config-explorer__file-label">{file.name}</span>
            {draft?.dirty && (
              <>
                <span className="config-explorer__dirty" aria-hidden="true" />
                <span className="sr-only">, unsaved changes</span>
              </>
            )}
          </span>
          <span className="config-explorer__file-path">{file.relativePath}</span>
        </button>

        {showMatchTree && (
          <div className="config-explorer__matches" aria-label={`Matches in ${file.name}`}>
            {matches.map((section) => (
              <div key={section.id} className="config-explorer__match-section">
                <button
                  type="button"
                  className="config-explorer__match config-explorer__match--section"
                  onClick={() => handleSelectExplorerMatch(file, section.id)}
                >
                  <Icon name="fas fa-folder-tree" aria-hidden="true" />
                  <span>{section.name}</span>
                </button>
                {section.entries.slice(0, 8).map((entry) => (
                  <button
                    key={entry.id}
                    type="button"
                    className="config-explorer__match"
                    onClick={() => handleSelectExplorerMatch(file, section.id)}
                    title={`${entry.key} = ${entry.value}`}
                  >
                    <span className="config-explorer__match-key">{entry.key}</span>
                    <span className="config-explorer__match-value">{entry.value}</span>
                  </button>
                ))}
                {section.entries.length > 8 && (
                  <button
                    type="button"
                    className="config-explorer__match config-explorer__match--more"
                    onClick={() => handleSelectExplorerMatch(file, section.id)}
                  >
                    {section.entries.length - 8} more
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    );
  };

  const fileMenuItems = (document: ConfigDocument): AnchoredContextMenuItem[] => [
    {
      key: 'open-file',
      label: 'Open File',
      icon: 'fas fa-file-lines',
      onSelect: () => void ApiService.openPath(document.summary.path),
    },
    {
      key: 'open-folder',
      label: 'Open Folder',
      icon: 'fas fa-folder-open',
      onSelect: () => void ApiService.revealPath(document.summary.path),
    },
    {
      key: 'reload',
      label: 'Reload from Disk',
      icon: 'fas fa-rotate',
      disabled: loadingDocument || saving,
      separatorBefore: true,
      onSelect: () => void handleReload(),
    },
  ];

  const sectionMenuItems = (section: EditableSection): AnchoredContextMenuItem[] => [
    {
      key: 'remove-section',
      label: 'Remove Section',
      icon: 'fas fa-trash',
      danger: true,
      onSelect: () => handleDeleteSection(section.id),
    },
  ];

  const otherDraftCount = dirtyCount - (activeDraft?.dirty ? 1 : 0);
  const sectionSelectLabel = (value: string | null) => {
    if (!value || value === ALL_SECTIONS_TAB) return 'All sections';
    return sectionTabs.find((section) => section.id === value)?.name ?? 'All sections';
  };

  if (!isOpen) return null;

  return (
    <div className="workspace-panel config-editor">
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

      <div className="config-editor__shell">
        <aside className="config-explorer" aria-label="Config files">
          <div className="config-explorer__search">
            <Icon name="fas fa-search" aria-hidden="true" />
            <Input
              type="search"
              value={fileFilter}
              onChange={(e) => setFileFilter(e.target.value)}
              placeholder="Search config files"
              aria-label="Search config files"
            />
          </div>

          <div className="config-explorer__list">
            {loadingCatalog ? (
              <div className="config-explorer__skeleton" role="status">
                <span className="sr-only">Loading configuration catalog</span>
                {Array.from({ length: 5 }, (_, index) => (
                  <div key={index} className="config-explorer__skeleton-row" aria-hidden="true">
                    <span className="config-skeleton-bar" style={{ width: `${55 + ((index * 13) % 35)}%` }} />
                    <span className="config-skeleton-bar config-skeleton-bar--thin" />
                  </div>
                ))}
              </div>
            ) : (
              <>
                {[
                  { label: 'Loader', files: catalogGroups.loader },
                  { label: 'MelonPreferences', files: catalogGroups.melon },
                ].map((group) =>
                  group.files.length > 0 ? (
                    <section key={group.label} className="config-explorer__group">
                      <h3 className="ui-section-title config-explorer__group-title">{group.label}</h3>
                      {group.files.map((file) => renderExplorerFile(file))}
                    </section>
                  ) : null
                )}

                {otherCatalogGroups.length > 0 && (
                  <section className="config-explorer__group">
                    <h3 className="ui-section-title config-explorer__group-title">Mod configs</h3>
                    {otherCatalogGroups.map(([groupName, files]) => (
                      <div key={groupName} className="config-explorer__subgroup">
                        <p className="config-explorer__subgroup-label">
                          <ModThumbnail {...getModArtwork(groupName)} name={groupName} size={20} />
                          <span className="ui-truncate">{groupName}</span>
                        </p>
                        {files.map((file) => renderExplorerFile(file))}
                      </div>
                    ))}
                  </section>
                )}

                {filteredCatalog.length === 0 && (
                  <div className="ui-empty config-explorer__empty" role={loadingFileSearchContents ? 'status' : undefined}>
                    <span className="ui-empty__emblem" aria-hidden="true">
                      <Icon name={loadingFileSearchContents || catalog.length > 0 ? 'search' : 'sliders'} />
                    </span>
                    <p className="ui-empty__title">
                      {loadingFileSearchContents ? 'Searching file contents' : catalog.length === 0 ? 'No config files yet' : 'No matching files'}
                    </p>
                    <p className="ui-empty__copy">
                      {loadingFileSearchContents
                        ? 'Checking keys, values, comments, and raw text.'
                        : catalog.length === 0
                          ? 'MelonLoader and mods create their config files the first time the game runs. Play once, then return here.'
                          : 'Try a different search term.'}
                    </p>
                  </div>
                )}
              </>
            )}
          </div>
        </aside>

        <section className={`config-workspace ${editorMode === 'raw' ? 'config-workspace--raw' : ''}`} aria-label="Config editor">
          {error && (
            <div className="ui-callout ui-callout--danger config-workspace__error" role="alert">
              <Icon name="fas fa-triangle-exclamation" aria-hidden="true" />
              <span>{error}</span>
            </div>
          )}

          {!selectedFilePath ? (
            <div className="ui-empty config-workspace__empty">
              <span className="ui-empty__emblem" aria-hidden="true"><Icon name="fileCode" /></span>
              <p className="ui-empty__title">Select a config file</p>
              <p className="ui-empty__copy">Choose a file on the left to see and edit its settings.</p>
            </div>
          ) : loadingDocument && !activeDocument ? (
            <div className="config-workspace__skeleton" role="status">
              <span className="sr-only">Loading configuration file</span>
              {Array.from({ length: 6 }, (_, index) => (
                <div key={index} className="config-workspace__skeleton-row" aria-hidden="true">
                  <span className="config-skeleton-bar" style={{ width: `${30 + ((index * 11) % 25)}%` }} />
                  <span className="config-skeleton-bar config-skeleton-bar--field" />
                </div>
              ))}
            </div>
          ) : activeDocument && activeDraft ? (
            <>
              <header className="config-workspace__header">
                <div className="config-workspace__titles">
                  <h3 className="config-workspace__title" title={activeDocument.summary.path}>{activeDocument.summary.name}</h3>
                  <p className="ui-meta config-workspace__meta">
                    <span className="ui-mono config-workspace__path" title={activeDocument.summary.path}>{activeDocument.summary.relativePath}</span>
                    <span>{formatSettingCount(activeDocument.summary.entryCount)}</span>
                    <span>{formatSectionCount(activeDocument.summary.sectionCount)}</span>
                    <span>Modified {formatRelativeTimestamp(activeDocument.summary.lastModified)}</span>
                  </p>
                </div>
                <div className="config-workspace__mode-switch" role="group" aria-label="Editor mode">
                  <SimmButton
                    type="button"
                    variant="ghost"
                    className="config-workspace__mode-button"
                    aria-pressed={editorMode === 'structured'}
                    onClick={() => handleModeChange('structured')}
                    disabled={!structuredAvailable}
                  >
                    Structured
                  </SimmButton>
                  <SimmButton
                    type="button"
                    variant="ghost"
                    className="config-workspace__mode-button"
                    aria-pressed={editorMode === 'raw'}
                    onClick={() => handleModeChange('raw')}
                  >
                    Raw
                  </SimmButton>
                </div>
                <SimmButton
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label="More file actions"
                  aria-haspopup="menu"
                  aria-expanded={actionMenu?.id === 'config-file-actions'}
                  onClick={(event) => openActionMenu('config-file-actions', event, fileMenuItems(activeDocument))}
                >
                  <Icon name={loadingDocument ? 'fas fa-spinner fa-spin' : 'fas fa-ellipsis-h'} />
                </SimmButton>
              </header>

              {activeDocument.parseWarnings.length > 0 && (
                <div className="ui-callout ui-callout--warn config-workspace__warning">
                  <Icon name="fas fa-triangle-exclamation" aria-hidden="true" />
                  <div>
                    <strong>Structured editing is unavailable for part of this file.</strong>
                    <p>{activeDocument.parseWarnings[0]} Edit it in Raw mode instead.</p>
                  </div>
                </div>
              )}

              {editorMode === 'structured' && (
                <div className="ui-toolbar config-workspace__toolbar">
                  {sectionTabs.length > 1 && (
                    <Select
                      value={activeSectionId ?? ALL_SECTIONS_TAB}
                      onValueChange={(nextValue) => {
                        if (typeof nextValue === 'string') setActiveSectionId(nextValue);
                      }}
                    >
                      <SelectTrigger className="config-workspace__section-select" aria-label="Section">
                        <SelectValue>{(value) => sectionSelectLabel(typeof value === 'string' ? value : activeSectionId)}</SelectValue>
                      </SelectTrigger>
                      <SelectContent align="start">
                        <SelectGroup>
                          <SelectItem value={ALL_SECTIONS_TAB}>All sections</SelectItem>
                          {sectionTabs.map((section) => (
                            <SelectItem key={section.id} value={section.id}>
                              {section.name}
                            </SelectItem>
                          ))}
                        </SelectGroup>
                      </SelectContent>
                    </Select>
                  )}
                  <div className="config-workspace__filter">
                    <Icon name="fas fa-search" aria-hidden="true" />
                    <Input
                      type="search"
                      value={sectionFilter}
                      onChange={(e) => setSectionFilter(e.target.value)}
                      placeholder="Filter settings"
                      aria-label="Filter settings"
                    />
                  </div>
                </div>
              )}

              <div className={`config-workspace__body ${editorMode === 'raw' ? 'config-workspace__body--raw' : 'config-workspace__body--structured'}`}>
                {editorMode === 'structured' ? (
                  visibleSections.length === 0 ? (
                    <div className="ui-empty">
                      <span className="ui-empty__emblem" aria-hidden="true">
                        <Icon name={activeDraft.sections.length === 0 ? 'sliders' : 'filter'} />
                      </span>
                      <p className="ui-empty__title">{activeDraft.sections.length === 0 ? 'This file has no settings yet' : 'No matching settings'}</p>
                      <p className="ui-empty__copy">
                        {activeDraft.sections.length === 0
                          ? 'Switch to Raw to write the file by hand.'
                          : 'Clear the filter or pick another section.'}
                      </p>
                    </div>
                  ) : (
                    visibleSections.map((section) => (
                      <section key={section.id} className="config-section" aria-labelledby={`config-section-${section.id}`}>
                        <header className="config-section__head">
                          {(() => {
                            const artwork = getModArtwork(section.name);
                            return artwork ? <ModThumbnail {...artwork} name={section.name} size={20} /> : null;
                          })()}
                          <h4 id={`config-section-${section.id}`} className="config-section__title">{section.name}</h4>
                          <span className="config-section__count">{formatSettingCount(section.entries.length)}</span>
                          <span className="ui-toolbar__spacer" />
                          <SimmButton
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="config-section__action"
                            onClick={() => handleAddEntry(section.id)}
                          >
                            <Icon name="fas fa-plus" data-icon="inline-start" />
                            Add Entry
                          </SimmButton>
                          <SimmButton
                            type="button"
                            variant="ghost"
                            size="icon-sm"
                            className="config-section__action"
                            aria-label={`More actions for section ${section.name}`}
                            aria-haspopup="menu"
                            onClick={(event) => openActionMenu(`config-section-${section.id}`, event, sectionMenuItems(section))}
                          >
                            <Icon name="fas fa-ellipsis-h" />
                          </SimmButton>
                        </header>
                        <div className="config-section__rows">
                          {section.entries.length === 0 ? (
                            <p className="config-section__empty">No settings in this section. Choose Add Entry to create one.</p>
                          ) : (
                            section.entries.map((entry) => (
                              <ConfigEntryRow
                                key={entry.id}
                                sectionId={section.id}
                                entry={entry}
                                onChange={handleEntryChange}
                                onDelete={handleDeleteEntry}
                                onOpenMenu={openActionMenu}
                              />
                            ))
                          )}
                        </div>
                      </section>
                    ))
                  )
                ) : (
                  <div className="config-raw__editor">
                    <Suspense
                      fallback={(
                        <div className="config-workspace__skeleton" role="status">
                          <span className="sr-only">Loading raw editor</span>
                        </div>
                      )}
                    >
                      <ConfigRawEditor
                        value={activeDraft.rawContent}
                        onChange={handleRawChange}
                      />
                    </Suspense>
                  </div>
                )}
              </div>

              <footer className="config-workspace__draft-bar">
                <p className="config-workspace__draft-state">
                  <span
                    className={`config-workspace__draft-dot ${activeDraft.dirty ? 'config-workspace__draft-dot--dirty' : ''}`}
                    aria-hidden="true"
                  />
                  <span className="config-workspace__draft-label">{activeDraft.dirty ? 'Unsaved changes' : 'No unsaved changes'}</span>
                  {otherDraftCount > 0 && (
                    <span className="config-workspace__draft-other">
                      {otherDraftCount} other {otherDraftCount === 1 ? 'file has' : 'files have'} unsaved drafts
                    </span>
                  )}
                </p>
                <SimmButton type="button" variant="secondary" onClick={handleDiscard} disabled={!activeDraft.dirty || saving}>
                  Discard
                </SimmButton>
                <SimmButton
                  type="button"
                  variant="default"
                  aria-label="Save"
                  onClick={() => void handleSave()}
                  disabled={!activeDraft.dirty || saving}
                >
                  <Icon name={saving ? 'fas fa-spinner fa-spin' : 'fas fa-save'} data-icon="inline-start" />
                  {saving ? 'Saving…' : 'Save Changes'}
                </SimmButton>
              </footer>
            </>
          ) : null}
        </section>
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
    </div>
  );
}
