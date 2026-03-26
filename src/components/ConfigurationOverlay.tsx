import { useCallback, useEffect, useMemo, useRef, useState, type WheelEvent as ReactWheelEvent } from 'react';

import { ConfirmOverlay } from './ConfirmOverlay';
import { ApiService } from '../services/api';
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
const ALL_SECTIONS_TAB = '__all__';

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

function hasDirtyDraft(drafts: Record<string, FileDraft>) {
  return Object.values(drafts).some((draft) => draft.dirty);
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

export function ConfigurationOverlay({ isOpen, onClose, environmentId, environment }: Props) {
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

  const filteredCatalog = useMemo(() => {
    const query = fileFilter.trim().toLowerCase();
    if (!query) return catalog;

    return catalog.filter((file) =>
      file.name.toLowerCase().includes(query) ||
      file.path.toLowerCase().includes(query) ||
      file.relativePath.toLowerCase().includes(query) ||
      file.groupName.toLowerCase().includes(query)
    );
  }, [catalog, fileFilter]);

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

  const handleCloseRequest = () => {
    if (hasDirtyDraft(drafts)) {
      requestConfirm(
        'Discard Unsaved Changes?',
        'Closing the configuration editor will discard any unsaved drafts for this session.',
        onClose
      );
      return;
    }

    onClose();
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

      <div className="modal-header">
        <div>
          <h2>Configuration</h2>
          <p className="config-editor__subtitle">
            Manage loader, mod, and auxiliary configuration files for {environment.name}.
          </p>
        </div>
        <div className="config-editor__header-actions">
          <button className="btn btn-secondary btn-small" onClick={handleCloseRequest}>
            <i className="fas fa-arrow-left"></i>
            Back
          </button>
        </div>
      </div>

      {error && <div className="settings-error-banner">{error}</div>}

      <div className="config-editor__shell">
        <aside className="config-explorer">
          <div className="config-explorer__overview">
            <div className="config-explorer__overview-head">
              <span className="settings-eyebrow">Files</span>
              <div className="config-explorer__overview-pills">
                <span className="config-explorer__overview-pill">
                  {catalog.length} file{catalog.length === 1 ? '' : 's'}
                </span>
                <span className="config-explorer__overview-pill">
                  {dirtyCount} draft{dirtyCount === 1 ? '' : 's'}
                </span>
              </div>
            </div>
            <p>Browse loader, MelonPreferences, and UserData config files.</p>
          </div>

          <div className="config-explorer__search">
            <i className="fas fa-search"></i>
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
                <i className="fas fa-spinner fa-spin"></i>
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
                      {group.files.map((file) => {
                        const draft = drafts[file.path];
                        const selected = file.path === selectedFilePath;
                        return (
                          <div key={file.path} className="config-explorer__file-stack">
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
                              <div className="config-explorer__file-badges">
                                <span className="settings-chip">
                                  {file.fileType === 'LoaderConfig'
                                    ? 'Loader'
                                    : file.fileType === 'MelonPreferences'
                                      ? 'Melon'
                                      : file.fileType === 'Json'
                                        ? 'JSON'
                                        : 'CFG'}
                                </span>
                                <span className="settings-chip settings-chip--muted">{file.supportsStructuredEdit ? 'Structured' : 'Raw only'}</span>
                              </div>
                              <div className="config-explorer__file-path" title={file.relativePath}>
                                {file.relativePath}
                              </div>
                            </button>
                            {selected && (
                              <button
                                type="button"
                                className={`config-explorer__subentry ${editorMode === 'raw' ? 'config-explorer__subentry--active' : ''}`}
                                onClick={() => handleSelectFile(file, 'raw')}
                              >
                                <i className="fas fa-code"></i>
                                <span>Raw Editor</span>
                                {!file.supportsStructuredEdit && <span className="settings-chip settings-chip--muted">Default</span>}
                              </button>
                            )}
                          </div>
                        );
                      })}
                    </section>
                  ) : null
                )}

                {otherCatalogGroups.length > 0 && (
                  <section className="config-explorer__group">
                    <div className="config-explorer__group-label">Other Config Files</div>
                    {otherCatalogGroups.map(([groupName, files]) => (
                      <div key={groupName} className="config-explorer__nested-group">
                        <div className="config-explorer__nested-label">{groupName}</div>
                        {files.map((file) => {
                          const draft = drafts[file.path];
                          const selected = file.path === selectedFilePath;
                          return (
                            <div key={file.path} className="config-explorer__file-stack">
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
                                <div className="config-explorer__file-badges">
                                  <span className="settings-chip">{file.fileType === 'Json' ? 'JSON' : 'CFG'}</span>
                                  <span className="settings-chip settings-chip--muted">{file.supportsStructuredEdit ? 'Structured' : 'Raw only'}</span>
                                </div>
                                <div className="config-explorer__file-path" title={file.relativePath}>
                                  {file.relativePath}
                                </div>
                              </button>
                              {selected && (
                                <button
                                  type="button"
                                  className={`config-explorer__subentry ${editorMode === 'raw' ? 'config-explorer__subentry--active' : ''}`}
                                  onClick={() => handleSelectFile(file, 'raw')}
                                >
                                  <i className="fas fa-code"></i>
                                  <span>Raw Editor</span>
                                  {!file.supportsStructuredEdit && <span className="settings-chip settings-chip--muted">Default</span>}
                                </button>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    ))}
                  </section>
                )}

                {!loadingCatalog && filteredCatalog.length === 0 && (
                  <div className="config-editor__empty">
                    <i className="fas fa-file-circle-question"></i>
                    <strong>No config files found</strong>
                    <p>Try a different search term or verify that this environment has generated config files.</p>
                  </div>
                )}
              </>
            )}
          </div>
        </aside>

        <section className={`config-workspace ${activeDocument?.parseWarnings.length ? 'config-workspace--with-warning' : ''}`}>
          {!selectedFilePath ? (
            <div className="config-editor__empty config-editor__empty--workspace">
              <i className="fas fa-sliders"></i>
              <strong>Select a configuration file</strong>
              <p>Choose a file from the explorer to inspect and edit its current settings.</p>
            </div>
          ) : loadingDocument && !activeDocument ? (
            <div className="config-editor__empty config-editor__empty--workspace">
              <i className="fas fa-spinner fa-spin"></i>
              <strong>Loading configuration file</strong>
            </div>
          ) : activeDocument && activeDraft ? (
            <>
              <header className="config-workspace__header">
                <div className="config-workspace__identity">
                  <div className="config-workspace__title-row">
                    <span className="settings-eyebrow">Selected File</span>
                    <h3>{activeDocument.summary.name}</h3>
                    <div className="config-workspace__badges">
                      <span className="settings-chip">
                        {activeDocument.summary.fileType === 'LoaderConfig'
                          ? 'Loader Config'
                          : activeDocument.summary.fileType === 'MelonPreferences'
                            ? 'MelonPreferences'
                            : activeDocument.summary.fileType === 'Json'
                              ? 'JSON Config'
                              : 'Other CFG'}
                      </span>
                      <span className="settings-chip settings-chip--muted">{structuredAvailable ? 'Structured Ready' : 'Structured Disabled'}</span>
                    </div>
                  </div>
                  <div className="config-workspace__meta-row">
                    <span className="config-workspace__path" title={activeDocument.summary.path}>
                      {activeDocument.summary.path}
                    </span>
                    <span>Modified {formatRelativeTimestamp(activeDocument.summary.lastModified)}</span>
                    <span>{activeDocument.summary.entryCount} values</span>
                  </div>
                </div>

                <div className="config-workspace__actions">
                  <button type="button" className="btn btn-secondary" onClick={() => void ApiService.openPath(activeDocument.summary.path)}>
                    <i className="fas fa-file-lines"></i>
                    Open File
                  </button>
                  <button type="button" className="btn btn-secondary" onClick={() => void ApiService.revealPath(activeDocument.summary.path)}>
                    <i className="fas fa-folder-open"></i>
                    Open Folder
                  </button>
                  <button type="button" className="btn btn-secondary" onClick={() => void handleReload()} disabled={loadingDocument || saving}>
                    <i className={loadingDocument ? 'fas fa-spinner fa-spin' : 'fas fa-rotate'}></i>
                    Reload
                  </button>
                  <button type="button" className="btn btn-secondary" onClick={handleDiscard} disabled={!activeDraft.dirty || saving}>
                    <i className="fas fa-rotate-left"></i>
                    Discard Draft
                  </button>
                  <button type="button" className="btn btn-primary" onClick={() => void handleSave()} disabled={!activeDraft.dirty || saving}>
                    <i className={saving ? 'fas fa-spinner fa-spin' : 'fas fa-save'}></i>
                    {saving ? 'Saving…' : 'Save'}
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
                          <i className="fas fa-chevron-left"></i>
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
                          <i className="fas fa-chevron-right"></i>
                        </button>
                      )}
                    </div>
                  </div>

                  <div className="config-editor__search config-editor__search--workspace">
                    <i className="fas fa-search"></i>
                    <input
                      type="text"
                      value={sectionFilter}
                      onChange={(e) => setSectionFilter(e.target.value)}
                      placeholder="Filter keys or comments"
                    />
                  </div>
                </div>
              ) : (
                <div className="config-workspace__toolbar config-workspace__toolbar--raw">
                  <div className="config-workspace__toolbar-main">
                    <div className="config-editor__mode-note">
                      {structuredAvailable
                        ? 'Raw editing stays available for exact formatting and manual edits.'
                        : 'This file stays in raw mode because structured editing is not available.'}
                    </div>
                  </div>
                </div>
              )}

              {activeDocument.parseWarnings.length > 0 && (
                <div className="config-editor__warning">
                  <i className="fas fa-triangle-exclamation"></i>
                  <span className="settings-chip">
                    Raw Fallback
                  </span>
                  <div>
                    <strong>Raw editing is safer for part of this file.</strong>
                    <p>{activeDocument.parseWarnings[0]}</p>
                  </div>
                </div>
              )}

              <div className={`config-workspace__body ${editorMode === 'raw' ? 'config-workspace__body--raw' : 'config-workspace__body--structured'}`}>
                {editorMode === 'structured' ? (
                  <div className="config-structured">
                    <div className="config-structured__sheet">
                      <div className="config-structured__header">
                        <div>
                          <span className="settings-eyebrow">Structured Editor</span>
                          <h4>
                            {activeSectionId && activeSectionId !== ALL_SECTIONS_TAB
                              ? sectionTabs.find((section) => section.id === activeSectionId)?.name || 'Settings'
                              : 'Settings in this file'}
                          </h4>
                          <p>
                            {visibleSections.length} section{visibleSections.length === 1 ? '' : 's'} · {visibleEntryCount}{' '}
                            setting{visibleEntryCount === 1 ? '' : 's'}
                          </p>
                        </div>
                      </div>

                      <div className="config-structured__sections">
                        {visibleSections.length === 0 ? (
                          <div className="config-editor__empty config-editor__empty--workspace">
                            <i className="fas fa-sliders"></i>
                            <strong>No matching settings</strong>
                            <p>Adjust the search or switch sections to widen the result set.</p>
                          </div>
                        ) : (
                          visibleSections.map((section) => (
                            <article key={section.id} className="config-section-card">
                              <div className="config-section-card__header">
                                <div className="config-section-card__title">
                                  <h4>{section.name}</h4>
                                  <p>{formatSettingCount(section.entries.length)}</p>
                                </div>
                                <div className="config-section-card__header-actions">
                                  <button type="button" className="btn btn-secondary btn-small" onClick={() => handleAddEntry(section.id)}>
                                    <i className="fas fa-plus"></i>
                                    Add Entry
                                  </button>
                                  <button type="button" className="btn btn-secondary btn-small" onClick={() => handleDeleteSection(section.id)}>
                                    <i className="fas fa-trash"></i>
                                    Remove Section
                                  </button>
                                </div>
                              </div>

                              <div className="config-entry-table">
                                <div className="config-entry-table__head">
                                  <span>Key</span>
                                  <span>Value</span>
                                  <span>Comment</span>
                                  <span>Actions</span>
                                </div>

                                <div className="config-section-card__entries">
                                  {section.entries.map((entry) => (
                                    <div key={entry.id} className="config-entry-row">
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

                                      <div className="config-entry-row__value">
                                        <input
                                          id={`config-value-${section.id}-${entry.id}`}
                                          type="text"
                                          aria-label={`Value for ${entry.key || 'new entry'}`}
                                          value={entry.value}
                                          onChange={(e) => handleEntryChange(section.id, entry.id, 'value', e.target.value)}
                                        />
                                      </div>

                                      <div className="config-entry-row__comment">
                                        <textarea
                                          id={`config-comment-${section.id}-${entry.id}`}
                                          aria-label={`Comment for ${entry.key || 'new entry'}`}
                                          value={entry.comment}
                                          onChange={(e) => handleEntryChange(section.id, entry.id, 'comment', e.target.value)}
                                          rows={2}
                                          placeholder="Optional inline comment"
                                        />
                                      </div>

                                      <div className="config-entry-row__actions">
                                        <button
                                          type="button"
                                          className="btn btn-secondary btn-small"
                                          aria-label={`Delete ${entry.key || 'entry'}`}
                                          onClick={() => handleDeleteEntry(section.id, entry.id)}
                                        >
                                          <i className="fas fa-trash"></i>
                                        </button>
                                      </div>
                                    </div>
                                  ))}
                                </div>
                              </div>
                            </article>
                          ))
                        )}
                      </div>
                    </div>
                  </div>
                ) : (
                  <div className="config-raw">
                    <div className="config-raw__header">
                      <span className="settings-eyebrow">Raw Editor</span>
                      <h4>{activeDocument.summary.name}</h4>
                      <p>Edit the file directly when exact formatting matters or structured editing is not available.</p>
                    </div>
                    <textarea
                      className="config-raw__textarea"
                      value={activeDraft.rawContent}
                      onChange={(e) => handleRawChange(e.target.value)}
                      spellCheck={false}
                    />
                  </div>
                )}
              </div>
            </>
          ) : null}
        </section>
      </div>
    </div>
  );
}
