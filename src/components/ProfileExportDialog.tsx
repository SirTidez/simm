import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import type { ModProfileItem, ModProfileManifest } from '../types';
import { Icon } from './Icon';
import { SimmButton, SimmDialogContent } from './primitives';

interface ProfileExportDialogProps {
  open: boolean;
  loading: boolean;
  saving: boolean;
  manifest: ModProfileManifest | null;
  profileName: string;
  selectedItemKeys: Set<string>;
  inputId: string;
  saveDisabled: boolean;
  onClose: () => void;
  onProfileNameChange: (value: string) => void;
  onToggleItem: (item: ModProfileItem, index: number, checked: boolean) => void;
  onSave: () => void;
}

function profileItemKey(item: ModProfileItem, index: number): string {
  return [
    item.itemType,
    item.name,
    item.fileName ?? '',
    item.sourceId ?? '',
    item.sourceVersion ?? '',
    index,
  ].join('|');
}

function profileItemTypeLabel(item: ModProfileItem): string {
  if (item.itemType === 'userlib') return 'UserLib';
  return item.itemType.charAt(0).toUpperCase() + item.itemType.slice(1);
}

function countSelectedItems(manifest: ModProfileManifest | null, selectedItemKeys: Set<string>) {
  return (manifest?.items ?? []).reduce(
    (counts, item, index) => {
      if (selectedItemKeys.has(profileItemKey(item, index))) {
        counts.selected += 1;
        if (item.itemType === 'mod') counts.mods += 1;
        if (item.itemType === 'plugin') counts.plugins += 1;
        if (item.manualReason) counts.manual += 1;
      }
      return counts;
    },
    { selected: 0, mods: 0, plugins: 0, manual: 0 },
  );
}

export function ProfileExportDialog({
  open,
  loading,
  saving,
  manifest,
  profileName,
  selectedItemKeys,
  inputId,
  saveDisabled,
  onClose,
  onProfileNameChange,
  onToggleItem,
  onSave,
}: ProfileExportDialogProps) {
  const counts = countSelectedItems(manifest, selectedItemKeys);

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => {
      if (!nextOpen) onClose();
    }}>
      <SimmDialogContent className="app-dialog profile-export-dialog" showCloseButton={false}>
        <DialogHeader className="modal-header">
          <DialogTitle>Export Profile</DialogTitle>
          <SimmButton
            type="button"
            variant="ghost"
            size="icon-sm"
            className="modal-close"
            onClick={onClose}
            aria-label="Close profile export"
          >
            <Icon name="times" />
          </SimmButton>
        </DialogHeader>
        <div className="app-dialog__body profile-export-dialog__body">
          <DialogDescription>
            Review what will be included, adjust the exported profile, then save a JSON file you can share.
          </DialogDescription>
          {loading || !manifest ? (
            <div className="profile-export-dialog__loading" role="status">
              <Icon name="spinner" />
              Preparing profile...
            </div>
          ) : (
            <>
              <div className="profile-export-dialog__field">
                <label htmlFor={inputId}>Profile name</label>
                <Input
                  id={inputId}
                  value={profileName}
                  onChange={(event) => onProfileNameChange(event.target.value)}
                />
              </div>
              <div className="profile-export-dialog__summary-grid">
                <div><span>Selected</span><strong>{counts.selected}</strong></div>
                <div><span>Mods</span><strong>{counts.mods}</strong></div>
                <div><span>Plugins</span><strong>{counts.plugins}</strong></div>
                <div><span>Manual</span><strong>{counts.manual}</strong></div>
              </div>
              <div className="profile-export-dialog__items" role="list" aria-label="Profile items">
                {manifest.items.map((item, index) => {
                  const key = profileItemKey(item, index);
                  return (
                    <label key={key} className="profile-export-dialog__item" role="listitem">
                      <Checkbox
                        checked={selectedItemKeys.has(key)}
                        onCheckedChange={(value) => onToggleItem(item, index, Boolean(value))}
                      />
                      <span className="profile-export-dialog__item-main">
                        <strong>{item.name}</strong>
                        <span>
                          {profileItemTypeLabel(item)}
                          {item.source ? ` - ${item.source}` : ''}
                          {item.sourceVersion ? ` - ${item.sourceVersion}` : ''}
                        </span>
                        {item.manualReason && <em>{item.manualReason}</em>}
                      </span>
                    </label>
                  );
                })}
              </div>
            </>
          )}
          <DialogFooter className="app-dialog__footer">
            <SimmButton
              type="button"
              variant="secondary"
              className="btn btn-secondary"
              onClick={onClose}
            >
              Cancel
            </SimmButton>
            <SimmButton
              type="button"
              className="btn btn-primary"
              onClick={onSave}
              disabled={saveDisabled}
            >
              <Icon name={saving ? 'spinner' : 'download'} />
              Export JSON
            </SimmButton>
          </DialogFooter>
        </div>
      </SimmDialogContent>
    </Dialog>
  );
}
