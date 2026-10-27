import { useState } from 'react';
import { useAppDialogs } from './AppDialogProvider';
import { SimmButton } from './primitives';
import { ApiService } from '../services/api';
import { downloadProfileItem } from '../services/profileDownloads';
import { getErrorMessage } from '../utils/errors';
import type { StoredModProfile } from '../types';

export function ProfileSourceDownloads({ profile, disabled, onBusyChange }: {
  profile: StoredModProfile;
  disabled: boolean;
  onBusyChange: (busy: boolean) => void;
}) {
  const { confirm } = useAppDialogs();
  const [busy, setBusy] = useState(false);
  const [messages, setMessages] = useState<string[]>([]);
  const [current, setCurrent] = useState<string | null>(null);

  async function downloadMissing() {
    setBusy(true);
    onBusyChange(true);
    setMessages([]);
    const results: string[] = [];
    try {
      const preview = await ApiService.previewModProfileImport(profile.manifest, null);
      let completed = 0;
      for (const entry of preview.items) {
        if (!entry.item.enabled || entry.status === 'readyToInstall' || entry.status === 'alreadyInstalled') continue;
        setCurrent(entry.item.name);
        try {
          const result = await downloadProfileItem(entry.item, profile.runtime === 'IL2CPP' ? 'IL2CPP' : 'Mono', (name) => confirm(
            `SIMM's security scan requires review for ${name}. Continue with this exact file?`,
            { title: 'Security review required', kind: 'warning' },
          ));
          if (result === 'manual') {
            results.push(`${entry.item.name}: confirm this file on Nexus. After it returns to SIMM, choose Download missing mods again to continue.`);
            break;
          }
          completed++;
        } catch (error) { results.push(`${entry.item.name}: ${getErrorMessage(error, 'Download failed.')}`); }
      }
      results.unshift(`${completed} ${completed === 1 ? 'mod added' : 'mods added'} to the library. Review Apply to Environment to install available items.`);
      window.dispatchEvent(new CustomEvent('library-updated'));
    } catch (error) { results.push(getErrorMessage(error, 'Could not check missing mods.')); }
    finally { setMessages(results); setCurrent(null); setBusy(false); onBusyChange(false); }
  }

  return <div className="profile-source-downloads">
    <SimmButton variant="secondary" disabled={disabled || busy} onClick={() => void downloadMissing()}>
      {busy ? `Downloading ${current ?? 'mod list'}…` : 'Download missing mods'}
    </SimmButton>
    {messages.length > 0 && <ul aria-live="polite">{messages.map((m, i) => <li key={i}>{m}</li>)}</ul>}
  </div>;
}
