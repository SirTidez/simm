import { useState } from 'react';
import { open as chooseFile } from '@tauri-apps/plugin-dialog';
import { Dialog, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { ApiService } from '../services/api';
import type { ExternalModProfileFile, ModProfileManifest, StoredModProfile } from '../types';
import { getErrorMessage } from '../utils/errors';
import { SimmButton, SimmDialogContent } from './primitives';

interface Props {
  onClose: () => void;
  onImported: (profile: StoredModProfile) => Promise<void>;
}

type ProfileFormat = 'simm' | 'shared' | 'vortex';

const formatItems = [
  { value: 'simm', label: 'SIMM profile (.json)' },
  { value: 'shared', label: 'r2modman / Thunderstore / Gale (.r2z)' },
  { value: 'vortex', label: 'Vortex backup (.json)' },
];

const fileFilters = {
  simm: { name: 'SIMM profile', extensions: ['json'] },
  shared: { name: 'Shared profile', extensions: ['r2z', 'r2x', 'zip', 'yaml', 'yml'] },
  vortex: { name: 'Vortex state backup', extensions: ['json'] },
};

function countLabel(count: number, singular: string): string {
  return `${count} ${singular}${count === 1 ? '' : 's'}`;
}

export function ProfileImportDialog({ onClose, onImported }: Props) {
  const [format, setFormat] = useState<ProfileFormat>('simm');
  const [runtime, setRuntime] = useState<'IL2CPP' | 'Mono' | null>(null);
  const [preview, setPreview] = useState<ExternalModProfileFile | null>(null);
  const [profileIndex, setProfileIndex] = useState('0');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [source, setSource] = useState<string | null>(null);
  const manifest: ModProfileManifest | undefined = preview?.profiles[Number(profileIndex)];

  async function readFile() {
    if (format !== 'simm' && !runtime) return;
    setBusy(true);
    setError(null);
    try {
      const selected = await chooseFile({
        title: format === 'simm' ? 'Choose SIMM profile' : format === 'vortex' ? 'Choose Vortex state backup' : 'Choose shared profile',
        multiple: false,
        filters: [fileFilters[format]],
      });
      if (!selected || Array.isArray(selected)) return;
      setPreview(null);
      setSource(selected);
      const result: ExternalModProfileFile = format === 'simm'
        ? { format: 'SIMM', profiles: [await ApiService.readModProfileFile(selected)], warnings: [], omittedFiles: [] }
        : await ApiService.readExternalModProfilesFile(selected, runtime!);
      setPreview(result);
      setProfileIndex('0');
    } catch (err) { setError(getErrorMessage(err, 'Could not read this profile.')); }
    finally { setBusy(false); }
  }

  async function importProfile() {
    if (!manifest) return;
    setBusy(true);
    setError(null);
    try {
      const imported = await ApiService.importModProfileToLibrary(manifest);
      await onImported(imported);
      onClose();
    } catch (err) { setError(getErrorMessage(err, 'Could not import this profile.')); }
    finally { setBusy(false); }
  }

  const runtimeItems = [{ value: 'IL2CPP', label: 'IL2CPP' }, { value: 'Mono', label: 'Mono' }];
  const profileItems = preview?.profiles.map((p, i) => ({ value: String(i), label: p.profile.name })) ?? [];
  return (
    <Dialog open onOpenChange={(next) => { if (!next && !busy) onClose(); }}>
      <SimmDialogContent className="app-dialog profile-import-dialog" showCloseButton={false}>
        <DialogHeader className="modal-header"><DialogTitle>Import Profile</DialogTitle></DialogHeader>
        <div className="app-dialog__body profile-import-dialog__body">
          <DialogDescription>Import a mod list into your profile library, then download missing mods and review Apply to Environment.</DialogDescription>
          <div className="profile-export-dialog__field">
            <span>Profile format</span>
            <Select items={formatItems} value={format} disabled={busy} onValueChange={(v) => {
              if (v !== 'simm' && v !== 'shared' && v !== 'vortex') return;
              setFormat(v); setRuntime(null); setPreview(null); setSource(null); setError(null);
            }}>
              <SelectTrigger aria-label="Profile format"><SelectValue /></SelectTrigger>
              <SelectContent positionerClassName="profile-import-dialog__select-layer"><SelectGroup>{formatItems.map((f) => <SelectItem key={f.value} value={f.value}>{f.label}</SelectItem>)}</SelectGroup></SelectContent>
            </Select>
          </div>
          {format === 'simm' && <p>Choose a profile exported from SIMM (.json). Its saved runtime, versions, and enabled/disabled selections will be preserved.</p>}
          {format === 'shared' && <p>Export your Schedule I profile as a file (.r2z) from r2modman, Thunderstore Mod Manager, or Gale.</p>}
          {format === 'vortex' && <p>In Vortex, open Settings → Workarounds → Create Backup, choose Save copy, and select that JSON here. Use a fresh full backup.</p>}
          {format !== 'simm' && <>
          <div className="profile-export-dialog__field">
            <span>Profile runtime</span>
            <Select items={runtimeItems} value={runtime} disabled={busy} onValueChange={(v) => {
              if (v !== 'IL2CPP' && v !== 'Mono') return;
              setRuntime(v); setPreview(null); setSource(null); setError(null);
            }}>
              <SelectTrigger aria-label="Imported profile runtime"><SelectValue placeholder="Choose IL2CPP or Mono" /></SelectTrigger>
              <SelectContent positionerClassName="profile-import-dialog__select-layer"><SelectGroup>{runtimeItems.map((r) => <SelectItem key={r.value} value={r.value}>{r.label}</SelectItem>)}</SelectGroup></SelectContent>
            </Select>
          </div>
          <p>Choose the runtime used by the source profile. Export files do not reliably identify it.</p>
          </>}
          <SimmButton variant="secondary" disabled={(format !== 'simm' && !runtime) || busy} onClick={() => void readFile()}>{busy ? 'Working…' : 'Choose file…'}</SimmButton>
          {source && <p className="profile-import-dialog__path">{source}</p>}
          {error && <p role="alert" className="ui-alert ui-alert--danger">{error}</p>}
          {preview && manifest && <>
            <p>{preview.format} · {preview.profiles.length} {preview.profiles.length === 1 ? 'profile' : 'profiles'}</p>
            <p>Runtime: {manifest.profile.runtime === 'IL2CPP' ? 'IL2CPP' : 'Mono'}</p>
            <Select items={profileItems} value={profileIndex} disabled={busy} onValueChange={(v) => { if (typeof v === 'string') setProfileIndex(v); }}>
              <SelectTrigger aria-label="Source profile"><SelectValue /></SelectTrigger>
              <SelectContent positionerClassName="profile-import-dialog__select-layer"><SelectGroup>{profileItems.map((p) => <SelectItem key={p.value} value={p.value}>{p.label}</SelectItem>)}</SelectGroup></SelectContent>
            </Select>
            <p>{[
              countLabel(manifest.items.length, 'item'),
              countLabel(manifest.items.filter((i) => i.itemType === 'mod').length, 'mod'),
              countLabel(manifest.items.filter((i) => i.itemType === 'plugin').length, 'plugin'),
              countLabel(manifest.items.filter((i) => i.itemType === 'userlib').length, 'UserLib'),
              `${manifest.items.filter((i) => i.enabled).length} enabled`,
              `${manifest.items.filter((i) => !i.enabled).length} disabled`,
            ].join(' · ')}</p>
            {preview.warnings.length > 0 && <ul className="profile-import-dialog__warnings">{preview.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>}
            {preview.omittedFiles.length > 0 && <details><summary>{preview.omittedFiles.length} files require a separate transfer</summary><ul>{preview.omittedFiles.map((f, i) => <li className="profile-import-dialog__path" key={i}>{f}</li>)}</ul></details>}
            <div className="profile-import-dialog__items">
              <table className="ui-table" aria-label="Imported mod list"><thead><tr><th>Name</th><th>Type</th><th>Version</th><th>State</th></tr></thead><tbody>
                {manifest.items.map((i, n) => <tr key={n}><td>{i.name}<small>{i.manualReason ?? i.sourceId ?? i.fileName}</small></td><td>{i.itemType === 'userlib' ? 'UserLib' : i.itemType === 'plugin' ? 'Plugin' : 'Mod'}</td><td>{i.sourceVersion ?? 'Unknown'}</td><td>{i.enabled ? 'Enabled' : 'Disabled'}</td></tr>)}
              </tbody></table>
            </div>
          </>}
        </div>
        <DialogFooter className="app-dialog__footer">
          <SimmButton variant="ghost" disabled={busy} onClick={onClose}>Cancel</SimmButton>
          <SimmButton disabled={busy || !manifest} onClick={() => void importProfile()}>Import profile</SimmButton>
        </DialogFooter>
      </SimmDialogContent>
    </Dialog>
  );
}
