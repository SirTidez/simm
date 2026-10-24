import {
  Dialog,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Checkbox } from '@/components/ui/checkbox';
import type { Environment, ModLibraryEntry } from '../types';
import { SimmButton, SimmDialogContent } from './primitives';
import { Icon } from './Icon';
import { ModThumbnail, ThumbnailStack } from './media/ModThumbnail';

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
  // Runtime is a backend-owned typed value. Branch names are user-selected
  // labels and must never override a detected custom-branch runtime.
  return String(environment.runtime).toLowerCase() === 'mono' ? 'Mono' : 'IL2CPP';
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

  const selectionDisabled = mode === 'installed' || installing;

  return (
    <Dialog open={isOpen} onOpenChange={(open) => {
      if (!open && !installing) {
        onClose();
      }
    }}>
      <SimmDialogContent
        nested
        className="app-dialog lib-install-dialog"
        showCloseButton={false}
      >
        <DialogHeader className="modal-header">
          <div className="lib-install-dialog__heading">
            {entries.length === 1 ? (
              <ModThumbnail
                name={entries[0].displayName}
                iconUrl={entries[0].iconUrl}
                iconCachePath={entries[0].iconCachePath}
                size={32}
              />
            ) : (
              <ThumbnailStack
                size={24}
                items={entries.map((entry) => ({
                  key: entry.storageId,
                  name: entry.displayName,
                  iconUrl: entry.iconUrl,
                  iconCachePath: entry.iconCachePath,
                }))}
              />
            )}
            <DialogTitle>{title}</DialogTitle>
          </div>
          <SimmButton variant="ghost" size="icon-sm" className="modal-close" onClick={onClose} disabled={installing} aria-label="Close install target dialog"><Icon name="times" /></SimmButton>
        </DialogHeader>
        <div className="app-dialog__body lib-install-dialog__body">
          {entries.length > 1 && (
            <p className="lib-install-dialog__mods">
              <strong>{entries.length} downloaded mods:</strong>{' '}
              {entries
                .map((candidate) => candidate.displayName)
                .filter((name, index, all) => all.indexOf(name) === index)
                .join(', ')}
            </p>
          )}

          {note && <p className="lib-install-dialog__note">{note}</p>}

          {mode === 'installed' && (
            <p className="ui-callout ui-callout--info lib-install-dialog__callout">
              This version is already installed in every compatible environment.
            </p>
          )}

          <div className="lib-install-dialog__toolbar">
            <span className="lib-install-dialog__count">
              {compatibleCount} compatible environment{compatibleCount === 1 ? '' : 's'}
            </span>
            <div className="lib-install-dialog__quick" role="group" aria-label="Quick select">
              <SimmButton type="button" variant="ghost" size="sm" onClick={onSelectAllCompatible} disabled={selectionDisabled}>
                All compatible
              </SimmButton>
              <SimmButton type="button" variant="ghost" size="sm" onClick={() => onSelectRuntime('IL2CPP')} disabled={selectionDisabled || byRuntime.IL2CPP.length === 0}>
                All IL2CPP
              </SimmButton>
              <SimmButton type="button" variant="ghost" size="sm" onClick={() => onSelectRuntime('Mono')} disabled={selectionDisabled || byRuntime.Mono.length === 0}>
                All Mono
              </SimmButton>
              <SimmButton type="button" variant="ghost" size="sm" onClick={onClear} disabled={selectionDisabled}>
                Clear
              </SimmButton>
            </div>
          </div>

          <div className="lib-install-dialog__list">
            {compatibleEnvironments.length === 0 ? (
              <p className="lib-install-dialog__empty">
                No environment can run this version. Add an environment with a matching runtime first.
              </p>
            ) : compatibleEnvironments.map((environment) => {
              const isLocked = lockedIds.has(environment.id);
              const runtime = getNormalizedRuntime(environment);
              return (
                <label
                  key={environment.id}
                  className={`lib-install-dialog__row${isLocked ? ' lib-install-dialog__row--locked' : ''}`}
                >
                  <Checkbox
                    checked={selectedEnvironmentIds.has(environment.id)}
                    disabled={isLocked || installing}
                    onCheckedChange={() => onToggleEnvironment(environment.id)}
                  />
                  <span className="lib-install-dialog__name">{environment.name}</span>
                  <span className="lib-install-dialog__meta">
                    {runtime} · {environment.branch}
                  </span>
                  {isLocked && <span className="lib-install-dialog__state">Already installed</span>}
                </label>
              );
            })}
          </div>

          {excludedEnvironments.length > 0 && (
            <p className="lib-install-dialog__note">
              {excludedEnvironments.length} environment{excludedEnvironments.length === 1 ? '' : 's'} hidden because the selected mod version does not support their runtime.
            </p>
          )}
        </div>
        <DialogFooter className="app-dialog__footer">
          <SimmButton type="button" variant="outline" onClick={onClose} disabled={installing}>
            {installing ? 'Installation in progress' : 'Cancel'}
          </SimmButton>
          <SimmButton
            type="button"
            onClick={onConfirm}
            disabled={mode === 'installed' || selectedCount === 0 || installing}
          >
            {mode === 'installed'
              ? 'Already installed'
              : installing
                ? 'Installing…'
                : `Install to selected (${selectedCount})`}
          </SimmButton>
        </DialogFooter>
      </SimmDialogContent>
    </Dialog>
  );
}
