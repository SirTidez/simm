import {
  Dialog,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import type { Environment, ModLibraryEntry } from '../types';
import { SimmButton, SimmDialogContent } from './primitives';

interface Props {
  isOpen: boolean;
  title: string;
  entries: ModLibraryEntry[];
  compatibleEnvironments: Environment[];
  excludedEnvironments: Environment[];
  lockedEnvironmentIds: string[];
  mode: 'select' | 'installed';
  note?: string;
  selectedEnvironmentIds: Set<string>;
  onToggleEnvironment: (environmentId: string) => void;
  onSelectAllCompatible: () => void;
  onSelectRuntime: (runtime: 'IL2CPP' | 'Mono') => void;
  onClear: () => void;
  onClose: () => void;
  onConfirm: () => void;
  installing: boolean;
}

export function getNormalizedRuntime(environment: Pick<Environment, 'branch' | 'runtime'>): 'IL2CPP' | 'Mono' {
  const normalizedBranch = (environment.branch || '').toLowerCase().replace(/[\s_]+/g, '-');
  if (
    normalizedBranch === 'alternate' ||
    normalizedBranch === 'alternate-beta' ||
    normalizedBranch === 'alternatebeta'
  ) {
    return 'Mono';
  }
  if (normalizedBranch === 'main' || normalizedBranch === 'beta') {
    return 'IL2CPP';
  }
  return environment.runtime === 'IL2CPP' ? 'IL2CPP' : 'Mono';
}

export function InstallTargetsDialog({
  isOpen,
  title,
  entries,
  compatibleEnvironments,
  excludedEnvironments,
  lockedEnvironmentIds,
  mode,
  note,
  selectedEnvironmentIds,
  onToggleEnvironment,
  onSelectAllCompatible,
  onSelectRuntime,
  onClear,
  onClose,
  onConfirm,
  installing,
}: Props) {
  if (!isOpen || entries.length === 0) {
    return null;
  }

  const entry = entries[0];
  const compatibleCount = compatibleEnvironments.length;
  const selectedCount = selectedEnvironmentIds.size;
  const lockedIds = new Set(lockedEnvironmentIds);
  const selectableEnvironments = compatibleEnvironments.filter(
    (environment) => !lockedIds.has(environment.id),
  );
  const byRuntime = {
    IL2CPP: selectableEnvironments.filter((environment) => getNormalizedRuntime(environment) === 'IL2CPP'),
    Mono: selectableEnvironments.filter((environment) => getNormalizedRuntime(environment) === 'Mono'),
  };

  return (
    <Dialog open={isOpen} onOpenChange={(open) => {
      if (!open) {
        onClose();
      }
    }}>
      <SimmDialogContent
        nested
        className="workspace-install-dialog"
        showCloseButton={false}
      >
        <DialogHeader className="modal-header">
          <DialogTitle>{title}</DialogTitle>
          <SimmButton variant="ghost" size="icon-sm" className="modal-close" onClick={onClose} aria-label="Close install target dialog">×</SimmButton>
        </DialogHeader>
        <div className="workspace-install-dialog__body">
          <div className="workspace-install-dialog__summary">
            <strong>
              {entries.length === 1 ? entry.displayName : `${entries.length} downloaded mods`}
            </strong>
            <span>{compatibleCount} compatible environment{compatibleCount === 1 ? '' : 's'}</span>
          </div>

          {entries.length > 1 && (
            <div className="workspace-install-dialog__note">
              {entries
                .map((candidate) => candidate.displayName)
                .filter((name, index, all) => all.indexOf(name) === index)
                .join(', ')}
            </div>
          )}

          {note && <div className="workspace-install-dialog__note">{note}</div>}

          {mode === 'installed' && (
            <div className="workspace-install-dialog__note">
              This version is already installed in every compatible environment.
            </div>
          )}

          <div className="workspace-install-dialog__quick-actions">
            <SimmButton type="button" className="btn btn-secondary btn-small" onClick={onSelectAllCompatible} disabled={mode === 'installed'}>
              All compatible
            </SimmButton>
            <SimmButton type="button" className="btn btn-secondary btn-small" onClick={() => onSelectRuntime('IL2CPP')} disabled={mode === 'installed' || byRuntime.IL2CPP.length === 0}>
              All IL2CPP
            </SimmButton>
            <SimmButton type="button" className="btn btn-secondary btn-small" onClick={() => onSelectRuntime('Mono')} disabled={mode === 'installed' || byRuntime.Mono.length === 0}>
              All Mono
            </SimmButton>
            <SimmButton type="button" className="btn btn-secondary btn-small" onClick={onClear} disabled={mode === 'installed'}>
              Clear
            </SimmButton>
          </div>

          <div className="workspace-install-dialog__list">
            {compatibleEnvironments.map((environment) => {
              const isLocked = lockedIds.has(environment.id);
              const runtime = getNormalizedRuntime(environment);
              return (
              <label
                key={environment.id}
                className="workspace-install-dialog__row"
                style={isLocked ? { opacity: 0.72, cursor: 'default' } : undefined}
              >
                <input
                  type="checkbox"
                  checked={selectedEnvironmentIds.has(environment.id)}
                  disabled={isLocked}
                  onChange={() => onToggleEnvironment(environment.id)}
                />
                <span className="workspace-install-dialog__row-main">
                  <strong>{environment.name}</strong>
                  <span>
                    {runtime} • {environment.branch}
                    {isLocked ? ' • already installed' : ''}
                  </span>
                </span>
              </label>
            )})}
          </div>

          {excludedEnvironments.length > 0 && (
            <div className="workspace-install-dialog__note">
              {excludedEnvironments.length} environment{excludedEnvironments.length === 1 ? '' : 's'} hidden because the selected mod version does not support their runtime.
            </div>
          )}
        </div>
        <DialogFooter className="modal-actions">
          <SimmButton type="button" className="btn btn-secondary" onClick={onClose}>
            Cancel
          </SimmButton>
          <SimmButton
            type="button"
            className="btn btn-primary"
            onClick={onConfirm}
            disabled={mode === 'installed' || selectedCount === 0 || installing}
          >
            {mode === 'installed'
              ? 'Already installed'
              : installing
                ? 'Installing...'
                : `Install to selected (${selectedCount})`}
          </SimmButton>
        </DialogFooter>
      </SimmDialogContent>
    </Dialog>
  );
}
