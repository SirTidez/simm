import { useMemo, useState } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import { Textarea } from '@/components/ui/textarea';
import { useEnvironmentStore } from '../stores/environmentStore';
import { ApiService } from '../services/api';
import type { ModProfileImportPlan, ModProfileManifest } from '../types';
import { Icon } from './Icon';
import { SimmButton } from './primitives';
import { WorkspacePageHeader } from './WorkspacePageHeader';

interface ProfileImportWorkspaceProps {
  onClose?: () => void;
}

const statusLabels: Record<string, string> = {
  alreadyInstalled: 'Installed',
  readyToInstall: 'Ready',
  needsDownload: 'Download needed',
  manualRequired: 'Manual',
  runtimeMismatch: 'Runtime mismatch',
  unsupported: 'Unsupported',
};

function parseManifest(value: string): ModProfileManifest {
  const parsed = JSON.parse(value) as ModProfileManifest;
  if (!parsed || parsed.kind !== 'simm.profile' || parsed.schemaVersion !== 1) {
    throw new Error('Paste a SIMM profile export with schemaVersion 1.');
  }
  if (!parsed.profile || !Array.isArray(parsed.items)) {
    throw new Error('Profile export is missing profile details or items.');
  }
  return parsed;
}

export function ProfileImportWorkspace({ onClose }: ProfileImportWorkspaceProps) {
  const { environments } = useEnvironmentStore();
  const completedEnvironments = useMemo(
    () => environments.filter((environment) => environment.status === 'completed'),
    [environments],
  );
  const [profileText, setProfileText] = useState('');
  const [profileSource, setProfileSource] = useState<string | null>(null);
  const [targetEnvironmentId, setTargetEnvironmentId] = useState(completedEnvironments[0]?.id ?? '');
  const [plan, setPlan] = useState<ModProfileImportPlan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [applyMessage, setApplyMessage] = useState<string | null>(null);

  const selectedTarget = completedEnvironments.find((environment) => environment.id === targetEnvironmentId) ?? null;

  const loadManifest = async (): Promise<ModProfileManifest> => {
    if (profileSource) {
      return ApiService.readModProfileFile(profileSource);
    }
    return parseManifest(profileText);
  };

  const handleChooseProfileFile = async () => {
    setBusy(true);
    setError(null);
    setApplyMessage(null);
    try {
      const selected = await open({
        multiple: false,
        filters: [{ name: 'SIMM Profile', extensions: ['json'] }],
      });
      if (!selected || Array.isArray(selected)) return;

      const manifest = await ApiService.readModProfileFile(selected);
      setProfileSource(selected);
      setProfileText(JSON.stringify(manifest, null, 2));
      const nextPlan = await ApiService.previewModProfileImport(manifest, targetEnvironmentId || null);
      setPlan(nextPlan);
    } catch (err) {
      setPlan(null);
      setError(err instanceof Error ? err.message : 'Failed to load profile file.');
    } finally {
      setBusy(false);
    }
  };

  const handlePreview = async () => {
    setBusy(true);
    setError(null);
    setApplyMessage(null);
    try {
      const manifest = await loadManifest();
      const nextPlan = await ApiService.previewModProfileImport(manifest, targetEnvironmentId || null);
      setPlan(nextPlan);
    } catch (err) {
      setPlan(null);
      setError(err instanceof Error ? err.message : 'Failed to preview profile import.');
    } finally {
      setBusy(false);
    }
  };

  const handleApply = async () => {
    if (!targetEnvironmentId) {
      setError('Choose a target environment before applying the profile.');
      return;
    }
    setBusy(true);
    setError(null);
    setApplyMessage(null);
    try {
      const manifest = await loadManifest();
      const result = await ApiService.applyModProfileImport({
        manifest,
        targetEnvironmentId,
      });
      setPlan(result.plan);
      setApplyMessage(`Installed ${result.installed}; ${result.unresolved} unresolved.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to apply profile import.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="profile-workspace workspace-collection-shell">
      <WorkspacePageHeader
        eyebrow="Profiles"
        title="Import Profile"
        description="Preview a shared SIMM profile before changing an environment."
      />

      <div className="profile-workspace__layout">
        <section className="profile-workspace__panel">
          <div className="profile-workspace__toolbar">
            <label className="profile-workspace__field">
              <span>Target environment</span>
              <select
                value={targetEnvironmentId}
                onChange={(event) => setTargetEnvironmentId(event.target.value)}
              >
                <option value="">Preview without target</option>
                {completedEnvironments.map((environment) => (
                  <option key={environment.id} value={environment.id}>
                    {environment.name} ({environment.runtime})
                  </option>
                ))}
              </select>
            </label>
            {selectedTarget && (
              <div className="profile-workspace__target-summary">
                <strong>{selectedTarget.name}</strong>
                <span>{selectedTarget.runtime} on {selectedTarget.branch}</span>
              </div>
            )}
          </div>

          <div className="profile-workspace__file-row">
            <SimmButton type="button" variant="secondary" className="btn btn-secondary" onClick={handleChooseProfileFile} disabled={busy}>
              <Icon name="folderOpen" />
              Choose Profile JSON
            </SimmButton>
            {profileSource && <span title={profileSource}>{profileSource}</span>}
          </div>

          <Textarea
            className="profile-workspace__input"
            value={profileText}
            onChange={(event) => {
              setProfileSource(null);
              setProfileText(event.target.value);
            }}
            placeholder="Paste a SIMM profile JSON export..."
          />

          {error && <div className="profile-workspace__notice profile-workspace__notice--error">{error}</div>}
          {applyMessage && <div className="profile-workspace__notice profile-workspace__notice--success">{applyMessage}</div>}

          <div className="profile-workspace__actions">
            <SimmButton type="button" variant="secondary" className="btn btn-secondary" onClick={onClose} disabled={!onClose}>
              Close
            </SimmButton>
            <SimmButton type="button" variant="secondary" className="btn btn-secondary" onClick={handlePreview} disabled={busy || (!profileText.trim() && !profileSource)}>
              <Icon name={busy ? 'spinner' : 'search'} />
              Preview
            </SimmButton>
            <SimmButton type="button" className="btn btn-primary" onClick={handleApply} disabled={busy || (!profileText.trim() && !profileSource) || !targetEnvironmentId || !plan}>
              <Icon name={busy ? 'spinner' : 'download'} />
              Apply Ready Items
            </SimmButton>
          </div>
        </section>

        <aside className="profile-workspace__panel profile-workspace__plan">
          {plan ? (
            <>
              <div className="profile-workspace__plan-header">
                <div>
                  <span className="workspace-eyebrow">Profile</span>
                  <h2>{plan.profile.name}</h2>
                  <p>{plan.profile.runtime} on {plan.profile.branch}</p>
                </div>
              </div>
              <div className="profile-workspace__summary-grid">
                <div><span>Total</span><strong>{plan.summary.total}</strong></div>
                <div><span>Ready</span><strong>{plan.summary.readyToInstall}</strong></div>
                <div><span>Installed</span><strong>{plan.summary.alreadyInstalled}</strong></div>
                <div><span>Manual</span><strong>{plan.summary.manualRequired + plan.summary.needsDownload + plan.summary.runtimeMismatches}</strong></div>
              </div>
              <div className="profile-workspace__items">
                {plan.items.map((item, index) => (
                  <article key={`${item.item.name}-${index}`} className={`profile-workspace__item profile-workspace__item--${item.status}`}>
                    <div>
                      <strong>{item.item.name}</strong>
                      <span>{item.item.source || item.item.itemType}{item.item.sourceVersion ? ` - ${item.item.sourceVersion}` : ''}</span>
                    </div>
                    <span>{statusLabels[item.status] || item.status}</span>
                    <p>{item.message}</p>
                  </article>
                ))}
              </div>
            </>
          ) : (
            <div className="profile-workspace__empty">
              <Icon name="fileCircleQuestion" />
              <strong>No profile preview yet</strong>
              <span>Paste a shared profile and preview it to see what SIMM can install.</span>
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}
