import type { Environment, ModLibraryEntry } from '../types';

interface Props {
  isOpen: boolean;
  title: string;
  entry: ModLibraryEntry | null;
  compatibleEnvironments: Environment[];
  excludedEnvironments: Environment[];
  lockedEnvironmentIds: string[];
  mode: 'select' | 'installed';
  selectedEnvironmentIds: Set<string>;
  onToggleEnvironment: (environmentId: string) => void;
  onSelectAllCompatible: () => void;
  onSelectRuntime: (runtime: 'IL2CPP' | 'Mono') => void;
  onClear: () => void;
  onClose: () => void;
  onConfirm: () => void;
  installing: boolean;
}

function getNormalizedRuntime(environment: Pick<Environment, 'branch' | 'runtime'>): 'IL2CPP' | 'Mono' {
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
  entry,
  compatibleEnvironments,
  excludedEnvironments,
  lockedEnvironmentIds,
  mode,
  selectedEnvironmentIds,
  onToggleEnvironment,
  onSelectAllCompatible,
  onSelectRuntime,
  onClear,
  onClose,
  onConfirm,
  installing,
}: Props) {
  if (!isOpen || !entry) {
    return null;
  }

  const compatibleCount = compatibleEnvironments.length;
  const selectedCount = selectedEnvironmentIds.size;
  const lockedIds = new Set(lockedEnvironmentIds);
  const byRuntime = {
    IL2CPP: compatibleEnvironments.filter((environment) => getNormalizedRuntime(environment) === 'IL2CPP'),
    Mono: compatibleEnvironments.filter((environment) => getNormalizedRuntime(environment) === 'Mono'),
  };

  return (
    <div className="modal-overlay modal-overlay-nested" onClick={onClose}>
      <div className="modal-content modal-content-nested workspace-install-dialog" onClick={(event) => event.stopPropagation()}>
        <div className="modal-header">
          <h2>{title}</h2>
          <button className="modal-close" onClick={onClose} aria-label="Close install target dialog">×</button>
        </div>
        <div className="workspace-install-dialog__body">
          <div className="workspace-install-dialog__summary">
            <strong>{entry.displayName}</strong>
            <span>{compatibleCount} compatible environment{compatibleCount === 1 ? '' : 's'}</span>
          </div>

          {mode === 'installed' && (
            <div className="workspace-install-dialog__note">
              This version is already installed in every compatible environment.
            </div>
          )}

          <div className="workspace-install-dialog__quick-actions">
            <button type="button" className="btn btn-secondary btn-small" onClick={onSelectAllCompatible} disabled={mode === 'installed'}>
              All compatible
            </button>
            <button type="button" className="btn btn-secondary btn-small" onClick={() => onSelectRuntime('IL2CPP')} disabled={mode === 'installed' || byRuntime.IL2CPP.length === 0}>
              All IL2CPP
            </button>
            <button type="button" className="btn btn-secondary btn-small" onClick={() => onSelectRuntime('Mono')} disabled={mode === 'installed' || byRuntime.Mono.length === 0}>
              All Mono
            </button>
            <button type="button" className="btn btn-secondary btn-small" onClick={onClear} disabled={mode === 'installed'}>
              Clear
            </button>
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
        <div className="modal-actions">
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button
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
          </button>
        </div>
      </div>
    </div>
  );
}
