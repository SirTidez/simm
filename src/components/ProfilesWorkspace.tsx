import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { open, save } from '@tauri-apps/plugin-dialog';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { ApiService } from '../services/api';
import { useEnvironmentStore } from '../stores/environmentStore';
import { getErrorMessage } from '../utils/errors';
import type {
  Environment,
  ModProfileImportPlan,
  ModProfileImportPlanItem,
  ModProfileManifest,
  ModProfileItem,
  Runtime,
  StoredModProfile,
} from '../types';
import { Icon } from './Icon';
import { SimmButton } from './primitives';
import { WorkspacePageHeader } from './WorkspacePageHeader';

type RuntimeKey = 'IL2CPP' | 'MONO';

const runtimeOptions: Array<{ key: RuntimeKey; label: string }> = [
  { key: 'IL2CPP', label: 'IL2CPP' },
  { key: 'MONO', label: 'Mono' },
];

const statusLabels: Record<string, string> = {
  alreadyInstalled: 'Installed',
  readyToInstall: 'Ready',
  needsDownload: 'Download needed',
  manualRequired: 'Manual',
  runtimeMismatch: 'Runtime mismatch',
  unsupported: 'Unsupported',
};

function runtimeKey(runtime: Runtime | string | null | undefined): RuntimeKey {
  return String(runtime ?? '').toLowerCase().includes('mono') ? 'MONO' : 'IL2CPP';
}

function runtimeForSave(runtime: RuntimeKey): Runtime {
  return runtime === 'MONO' ? 'Mono' : 'IL2CPP';
}

function runtimeLabel(runtime: Runtime | string | null | undefined): string {
  return runtimeKey(runtime) === 'MONO' ? 'Mono' : 'IL2CPP';
}

function itemTypeLabel(item: ModProfileItem): string {
  if (item.itemType === 'userlib') return 'UserLib';
  return item.itemType.charAt(0).toUpperCase() + item.itemType.slice(1);
}

function itemIdentity(item: ModProfileItem): string {
  return item.storageId
    ?? item.sourceId
    ?? item.fileName
    ?? item.name;
}

function profileItemKey(item: ModProfileItem, index: number): string {
  return [
    item.itemType,
    item.storageId ?? '',
    item.source ?? '',
    item.sourceId ?? '',
    item.fileName ?? '',
    item.name,
    index,
  ].join('|');
}

function profileFileName(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return `${slug || 'simm-profile'}.json`;
}

function isCompatibleEnvironment(environment: Environment, profile: StoredModProfile | null): boolean {
  return Boolean(profile) && runtimeKey(environment.runtime) === runtimeKey(profile?.runtime);
}

function planItemStatusClass(item: ModProfileImportPlanItem): string {
  return item.status.replace(/[A-Z]/g, (match) => `-${match.toLowerCase()}`);
}

interface ProfilesWorkspaceProps {
  preferredEnvironmentId?: string | null;
}

export function ProfilesWorkspace({ preferredEnvironmentId }: ProfilesWorkspaceProps) {
  const { environments, loading: environmentsLoading, refreshEnvironments } = useEnvironmentStore();
  const [profiles, setProfiles] = useState<StoredModProfile[]>([]);
  const [profilesLoading, setProfilesLoading] = useState(true);
  const [selectedRuntime, setSelectedRuntime] = useState<RuntimeKey>('IL2CPP');
  const [selectedProfileId, setSelectedProfileId] = useState<string | null>(null);
  const [targetEnvironmentId, setTargetEnvironmentId] = useState<string>('');
  const [userChoseTarget, setUserChoseTarget] = useState(false);
  const [plan, setPlan] = useState<ModProfileImportPlan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [includeDisabledExport, setIncludeDisabledExport] = useState(false);
  const [renameValue, setRenameValue] = useState('');
  const [createPanelOpen, setCreatePanelOpen] = useState(false);
  const [createProfileName, setCreateProfileName] = useState('');
  const [createDraftManifest, setCreateDraftManifest] = useState<ModProfileManifest | null>(null);
  const [createSelectedItemKeys, setCreateSelectedItemKeys] = useState<Set<string>>(() => new Set());
  const [captureName, setCaptureName] = useState('');
  const targetSelectionGenerationRef = useRef(0);
  const preferredEnvironment = useMemo(
    () => environments.find((environment) => environment.id === preferredEnvironmentId) ?? null,
    [environments, preferredEnvironmentId],
  );

  const loadProfiles = useCallback(async () => {
    setProfilesLoading(true);
    setError(null);
    try {
      const loaded = await ApiService.listModProfiles();
      setProfiles(loaded);
      setSelectedProfileId((current) => {
        if (current && loaded.some((profile) => profile.id === current)) return current;
        const preferredRuntime = preferredEnvironment ? runtimeKey(preferredEnvironment.runtime) : selectedRuntime;
        const sameRuntime = loaded.find((profile) =>
          runtimeKey(profile.runtime) === preferredRuntime && profile.isDefault
        ) ?? loaded.find((profile) => runtimeKey(profile.runtime) === preferredRuntime);
        return sameRuntime?.id ?? loaded[0]?.id ?? null;
      });
    } catch (err) {
      setError(getErrorMessage(err, 'Failed to load profiles.'));
    } finally {
      setProfilesLoading(false);
    }
  }, [preferredEnvironment, selectedRuntime]);

  useEffect(() => {
    void loadProfiles();
  }, [loadProfiles]);

  useEffect(() => {
    if (!environmentsLoading && environments.length === 0) {
      void refreshEnvironments();
    }
  }, [environments.length, environmentsLoading, refreshEnvironments]);

  const groupedProfiles = useMemo(
    () => runtimeOptions.map((option) => ({
      ...option,
      profiles: profiles.filter((profile) => runtimeKey(profile.runtime) === option.key),
    })),
    [profiles],
  );

  const selectedProfile = useMemo(
    () => profiles.find((profile) => profile.id === selectedProfileId) ?? null,
    [profiles, selectedProfileId],
  );

  const compatibleEnvironments = useMemo(
    () => environments.filter((environment) => isCompatibleEnvironment(environment, selectedProfile)),
    [environments, selectedProfile],
  );

  const activeProfileEnvironments = useMemo(() => {
    const activeIds = new Set(selectedProfile?.activeEnvironmentIds ?? []);
    if (activeIds.size === 0) return [];
    return environments.filter((environment) => activeIds.has(environment.id));
  }, [environments, selectedProfile]);

  useEffect(() => {
    if (!preferredEnvironment || userChoseTarget || profiles.length === 0) return;
    const preferredRuntime = runtimeKey(preferredEnvironment.runtime);
    setSelectedRuntime(preferredRuntime);
    setTargetEnvironmentId(preferredEnvironment.id);
    setSelectedProfileId((current) => {
      if (current) {
        const currentProfile = profiles.find((profile) => profile.id === current);
        if (currentProfile && runtimeKey(currentProfile.runtime) === preferredRuntime) return current;
      }
      return profiles.find((profile) => runtimeKey(profile.runtime) === preferredRuntime && profile.isDefault)?.id
        ?? profiles.find((profile) => runtimeKey(profile.runtime) === preferredRuntime)?.id
        ?? current;
    });
  }, [preferredEnvironment, profiles, userChoseTarget]);

  useEffect(() => {
    if (selectedProfile && runtimeKey(selectedProfile.runtime) !== selectedRuntime) {
      setSelectedRuntime(runtimeKey(selectedProfile.runtime));
    }
    setRenameValue(selectedProfile?.name ?? '');
    setCaptureName('');
    setPlan(null);
    setNotice(null);
  }, [selectedProfile, selectedRuntime]);

  useLayoutEffect(() => {
    targetSelectionGenerationRef.current += 1;
  }, [selectedProfileId, targetEnvironmentId]);

  useEffect(() => {
    setCreateDraftManifest(null);
    setCreateSelectedItemKeys(new Set());
  }, [targetEnvironmentId]);

  useEffect(() => {
    if (!selectedProfile || userChoseTarget) return;
    const currentTarget = environments.find((environment) => environment.id === targetEnvironmentId);
    if (currentTarget && isCompatibleEnvironment(currentTarget, selectedProfile)) return;
    const completed = compatibleEnvironments.find((environment) => environment.status === 'completed');
    setTargetEnvironmentId((completed ?? compatibleEnvironments[0])?.id ?? '');
  }, [compatibleEnvironments, environments, selectedProfile, targetEnvironmentId, userChoseTarget]);

  const profileItems = selectedProfile?.manifest.items ?? [];
  const selectedProfileActiveCount = selectedProfile?.activeEnvironmentIds?.length ?? 0;
  const createDraftItems = createDraftManifest?.items ?? [];
  const createSelectedCount = createDraftItems.filter((item, index) =>
    createSelectedItemKeys.has(profileItemKey(item, index))
  ).length;
  const hasPreviewPlan = plan !== null;
  const planRows = plan?.items ?? profileItems.map((item) => ({
    item,
    status: 'unsupported' as const,
    resolvedStorageId: item.storageId,
    message: item.enabled === false
      ? 'Disabled in this profile.'
      : 'Tracked by this profile. Preview against a target environment to resolve install status.',
  }));

  const runAction = useCallback(async (actionName: string, action: () => Promise<string | null | void>) => {
    setBusyAction(actionName);
    setError(null);
    setNotice(null);
    try {
      const message = await action();
      if (message) setNotice(message);
    } catch (err) {
      setError(getErrorMessage(err, 'Profile action failed.'));
    } finally {
      setBusyAction(null);
    }
  }, []);

  const requireSelection = useCallback(() => {
    if (!selectedProfile) {
      throw new Error('Choose a profile first.');
    }
    if (!targetEnvironmentId) {
      throw new Error('Choose a compatible target environment first.');
    }
    return selectedProfile;
  }, [selectedProfile, targetEnvironmentId]);

  const previewProfile = useCallback(async () => {
    const profile = requireSelection();
    const targetId = targetEnvironmentId;
    const targetGeneration = targetSelectionGenerationRef.current;
    const nextPlan = await ApiService.previewModProfileApply(profile.id, targetId);
    if (targetGeneration !== targetSelectionGenerationRef.current) return null;
    setPlan(nextPlan);
    return 'Profile preview refreshed.';
  }, [requireSelection, targetEnvironmentId]);

  const applyProfile = useCallback(async () => {
    const profile = requireSelection();
    const targetId = targetEnvironmentId;
    const targetGeneration = targetSelectionGenerationRef.current;
    const result = await ApiService.applyModProfile(profile.id, targetId);
    if (targetGeneration !== targetSelectionGenerationRef.current) {
      return null;
    }
    setPlan(result.plan);
    await refreshEnvironments();
    await loadProfiles();
    return `Applied ${profile.name}. Installed ${result.installed}, skipped ${result.skipped}, unresolved ${result.unresolved}.`;
  }, [loadProfiles, refreshEnvironments, requireSelection, targetEnvironmentId]);

  const applyAndLaunch = useCallback(async () => {
    const profile = requireSelection();
    const targetId = targetEnvironmentId;
    const targetGeneration = targetSelectionGenerationRef.current;
    const result = await ApiService.applyModProfile(profile.id, targetId);
    if (targetGeneration !== targetSelectionGenerationRef.current) {
      return null;
    }
    setPlan(result.plan);
    await refreshEnvironments();
    await loadProfiles();
    if (targetGeneration !== targetSelectionGenerationRef.current) {
      return null;
    }
    const launch = await ApiService.launchGame(targetId, 'steam');
    return launch.success
      ? `Applied ${profile.name} and launched the game.`
      : `Applied ${profile.name}, but launch did not complete.`;
  }, [loadProfiles, refreshEnvironments, requireSelection, targetEnvironmentId]);

  const importProfile = useCallback(async () => {
    const selected = await open({
      title: 'Choose SIMM profile JSON',
      multiple: false,
      filters: [{ name: 'SIMM profile', extensions: ['json'] }],
    });
    if (!selected || Array.isArray(selected)) return null;
    const imported = await ApiService.importModProfileToLibrary(await ApiService.readModProfileFile(selected));
    await loadProfiles();
    setSelectedProfileId(imported.id);
    setSelectedRuntime(runtimeKey(imported.runtime));
    return `Imported ${imported.name}.`;
  }, [loadProfiles]);

  const exportProfile = useCallback(async () => {
    if (!selectedProfile) throw new Error('Choose a profile first.');
    const destination = await save({
      title: 'Save SIMM profile',
      defaultPath: profileFileName(selectedProfile.name),
      filters: [{ name: 'SIMM profile', extensions: ['json'] }],
    });
    if (!destination) return null;
    const manifest = await ApiService.exportModProfileFromLibrary({
      profileId: selectedProfile.id,
      includeDisabled: includeDisabledExport,
    });
    await ApiService.saveModProfileFile(manifest, destination);
    return `Exported ${manifest.profile.name}.`;
  }, [includeDisabledExport, selectedProfile]);

  const captureNewProfile = useCallback(async () => {
    if (!targetEnvironmentId) throw new Error('Choose a compatible target environment first.');
    const targetId = targetEnvironmentId;
    const targetGeneration = targetSelectionGenerationRef.current;
    const name = captureName.trim();
    if (!name) throw new Error('Name the captured profile first.');
    const captured = await ApiService.captureModProfile({
      environmentId: targetId,
      name,
      includeDisabled: true,
    });
    if (targetGeneration !== targetSelectionGenerationRef.current) return null;
    await loadProfiles();
    setSelectedProfileId(captured.id);
    setSelectedRuntime(runtimeKey(captured.runtime));
    return `Captured ${captured.name}.`;
  }, [captureName, loadProfiles, targetEnvironmentId]);

  const loadCreateDraft = useCallback(async () => {
    if (!targetEnvironmentId) throw new Error('Choose a compatible target environment first.');
    const targetId = targetEnvironmentId;
    const targetGeneration = targetSelectionGenerationRef.current;
    setCreatePanelOpen(true);
    const manifest = await ApiService.exportEnvironmentProfile(targetId);
    if (targetGeneration !== targetSelectionGenerationRef.current) return null;
    setCreateDraftManifest(manifest);
    setCreateSelectedItemKeys(new Set(manifest.items.map((item, index) => profileItemKey(item, index))));
    setCreateProfileName((current) => current.trim() || manifest.profile.name);
    return `Loaded ${manifest.items.length} target items.`;
  }, [targetEnvironmentId]);

  const openCreateProfile = useCallback(async () => {
    if (!targetEnvironmentId) throw new Error('Choose a compatible target environment first.');
    setCreatePanelOpen(true);
    if (createDraftManifest) return null;
    return loadCreateDraft();
  }, [createDraftManifest, loadCreateDraft, targetEnvironmentId]);

  const createSelectedProfile = useCallback(async () => {
    if (!createDraftManifest) throw new Error('Load target items first.');
    const name = createProfileName.trim();
    if (!name) throw new Error('Name the profile first.');
    const selectedItems = createDraftManifest.items.filter((item, index) =>
      createSelectedItemKeys.has(profileItemKey(item, index))
    );
    if (selectedItems.length === 0) throw new Error('Choose at least one item for the profile.');
    const runtime = runtimeForSave(runtimeKey(createDraftManifest.profile.runtime));
    const saved = await ApiService.saveModProfile({
      name,
      runtime,
      manifest: {
        ...createDraftManifest,
        profileId: null,
        isDefault: false,
        createdAt: null,
        updatedAt: null,
        profile: {
          ...createDraftManifest.profile,
          name,
          runtime,
          exportedAt: new Date().toISOString(),
        },
        items: selectedItems.map((item) => ({
          ...item,
          enabled: item.enabled ?? true,
          runtime: item.runtime ?? runtime,
        })),
      },
    });
    await loadProfiles();
    setSelectedProfileId(saved.id);
    setSelectedRuntime(runtimeKey(saved.runtime));
    setCreateDraftManifest(null);
    setCreateSelectedItemKeys(new Set());
    setCreateProfileName('');
    setCreatePanelOpen(false);
    return `Created ${saved.name}.`;
  }, [createDraftManifest, createProfileName, createSelectedItemKeys, loadProfiles]);

  const updateSelectedFromTarget = useCallback(async () => {
    if (!selectedProfile || !targetEnvironmentId) throw new Error('Choose a profile and compatible target environment first.');
    const targetId = targetEnvironmentId;
    const targetGeneration = targetSelectionGenerationRef.current;
    const captured = await ApiService.captureModProfile({
      environmentId: targetId,
      profileId: selectedProfile.id,
      name: selectedProfile.name,
      includeDisabled: true,
    });
    if (targetGeneration !== targetSelectionGenerationRef.current) return null;
    await loadProfiles();
    setSelectedProfileId(captured.id);
    return `Updated ${captured.name} from the selected environment.`;
  }, [loadProfiles, selectedProfile, targetEnvironmentId]);

  const renameProfile = useCallback(async () => {
    if (!selectedProfile) throw new Error('Choose a profile first.');
    const name = renameValue.trim();
    if (!name) throw new Error('Profile name cannot be empty.');
    const updated = await ApiService.saveModProfile({
      profileId: selectedProfile.id,
      name,
      runtime: runtimeForSave(runtimeKey(selectedProfile.runtime)),
      manifest: {
        ...selectedProfile.manifest,
        profile: {
          ...selectedProfile.manifest.profile,
          name,
        },
      },
    });
    await loadProfiles();
    setSelectedProfileId(updated.id);
    return `Renamed profile to ${updated.name}.`;
  }, [loadProfiles, renameValue, selectedProfile]);

  const deleteProfile = useCallback(async () => {
    if (!selectedProfile) throw new Error('Choose a profile first.');
    if (selectedProfile.isDefault) throw new Error('Default runtime profiles cannot be deleted.');
    if (selectedProfileActiveCount > 0) {
      throw new Error('Apply another profile to every active environment before deleting this one.');
    }
    if (!window.confirm(`Delete ${selectedProfile.name}?`)) return null;
    await ApiService.deleteModProfile(selectedProfile.id);
    await loadProfiles();
    return `Deleted ${selectedProfile.name}.`;
  }, [loadProfiles, selectedProfile, selectedProfileActiveCount]);

  return (
    <section className="profiles-workspace modal-content workspace-panel" aria-label="Profiles workspace">
      <WorkspacePageHeader
        eyebrow="Profiles"
        title="Profiles"
        description="Switch, capture, import, and export runtime-locked mod sets."
      >
        <SimmButton
          type="button"
          variant="secondary"
          className="btn btn-secondary"
          onClick={() => void runAction('import', importProfile)}
          disabled={busyAction !== null}
        >
          <Icon name="upload" />
          Import JSON
        </SimmButton>
      </WorkspacePageHeader>

      {error && <div className="profiles-workspace__alert profiles-workspace__alert--error" role="alert">{error}</div>}
      {notice && <div className="profiles-workspace__alert profiles-workspace__alert--success" role="status">{notice}</div>}

      <div className="profiles-workspace__layout">
        <aside className="profiles-workspace__rail" aria-label="Profile library">
          <div className="profiles-workspace__library-header">
            <span className="workspace-eyebrow">Profile Library</span>
            <small>IL2CPP and Mono</small>
          </div>
          <div className="profiles-workspace__profile-list" role="list" aria-label="Profiles">
            {profilesLoading ? (
              <div className="profiles-workspace__empty" role="status">Loading profiles...</div>
            ) : profiles.length === 0 ? (
              <div className="profiles-workspace__empty">No profiles yet.</div>
            ) : groupedProfiles.map((group) => (
              <div key={group.key} className="profiles-workspace__profile-section">
                <div className="profiles-workspace__profile-section-title">
                  <span>{group.label}</span>
                  <small>{group.profiles.length}</small>
                </div>
                {group.profiles.length === 0 ? (
                  <div className="profiles-workspace__empty profiles-workspace__empty--compact">No {group.label} profiles.</div>
                ) : group.profiles.map((profile) => (
                  <SimmButton
                    key={profile.id}
                    type="button"
                    variant="ghost"
                    className={`profiles-workspace__profile-row ${profile.id === selectedProfileId ? 'profiles-workspace__profile-row--active' : ''}`}
                    onClick={() => {
                      setSelectedProfileId(profile.id);
                      setSelectedRuntime(runtimeKey(profile.runtime));
                      setUserChoseTarget(false);
                    }}
                    disabled={busyAction !== null}
                  >
                    <span className="profiles-workspace__profile-copy">
                      <strong>{profile.name}</strong>
                      <small>{profile.manifest.items.length} tracked items</small>
                    </span>
                    <span className="profiles-workspace__profile-badges">
                      <span className="profiles-workspace__runtime-badge">{runtimeLabel(profile.runtime)}</span>
                      {profile.isDefault && <span className="profiles-workspace__default-badge">Default Profile</span>}
                    </span>
                  </SimmButton>
                ))}
              </div>
            ))}
          </div>
        </aside>

        <main className="profiles-workspace__main">
          <div className="profiles-workspace__toolbar">
            <label className="profiles-workspace__field">
              <span>Target environment</span>
              <select
                value={targetEnvironmentId}
                onChange={(event) => {
                  setTargetEnvironmentId(event.target.value);
                  setUserChoseTarget(true);
                }}
                disabled={!selectedProfile || environmentsLoading || busyAction !== null}
              >
                <option value="">Choose target</option>
                {environments.map((environment) => {
                  const compatible = isCompatibleEnvironment(environment, selectedProfile);
                  return (
                    <option key={environment.id} value={environment.id} disabled={!compatible}>
                      {environment.name} - {runtimeLabel(environment.runtime)}{compatible ? '' : ' (incompatible)'}
                    </option>
                  );
                })}
              </select>
            </label>
            <SimmButton
              type="button"
              variant="secondary"
              className="btn btn-secondary"
              onClick={() => void runAction('preview', previewProfile)}
              disabled={!selectedProfile || !targetEnvironmentId || busyAction !== null}
            >
              <Icon name={busyAction === 'preview' ? 'spinner' : 'search'} />
              Preview
            </SimmButton>
            <SimmButton
              type="button"
              className="btn btn-primary"
              onClick={() => void runAction('apply', applyProfile)}
              disabled={!selectedProfile || !targetEnvironmentId || busyAction !== null}
            >
              <Icon name={busyAction === 'apply' ? 'spinner' : 'check'} />
              Apply
            </SimmButton>
            <SimmButton
              type="button"
              variant="secondary"
              className="btn btn-secondary"
              onClick={() => void runAction('applyLaunch', applyAndLaunch)}
              disabled={!selectedProfile || !targetEnvironmentId || busyAction !== null}
            >
              <Icon name={busyAction === 'applyLaunch' ? 'spinner' : 'play'} />
              Apply & Launch
            </SimmButton>
            <SimmButton
              type="button"
              variant="secondary"
              className="btn btn-secondary"
              onClick={() => void runAction('createOpen', openCreateProfile)}
              disabled={!targetEnvironmentId || busyAction !== null}
            >
              <Icon name={busyAction === 'createOpen' ? 'spinner' : 'plus'} />
              Create Profile
            </SimmButton>
          </div>

          {plan && (
            <div className="profiles-workspace__summary" aria-label="Apply preview summary">
              <span>Total <strong>{plan.summary.total}</strong></span>
              <span>Ready <strong>{plan.summary.readyToInstall}</strong></span>
              <span>Installed <strong>{plan.summary.alreadyInstalled}</strong></span>
              <span>Manual <strong>{plan.summary.manualRequired + plan.summary.needsDownload}</strong></span>
              <span>Mismatch <strong>{plan.summary.runtimeMismatches}</strong></span>
            </div>
          )}

          {createPanelOpen && (
            <div className="profiles-workspace__create-panel" aria-label="Create profile">
              <div className="profiles-workspace__create-panel-header">
                <div>
                  <span className="workspace-eyebrow">Create profile</span>
                  <h3>Choose target items</h3>
                </div>
                <SimmButton
                  type="button"
                  variant="secondary"
                  className="btn btn-secondary"
                  onClick={() => {
                    setCreatePanelOpen(false);
                    setCreateDraftManifest(null);
                    setCreateSelectedItemKeys(new Set());
                  }}
                  disabled={busyAction !== null}
                >
                  <Icon name="times" />
                  Close
                </SimmButton>
              </div>

              <div className="profiles-workspace__create-grid">
                <label className="profiles-workspace__field">
                  <span>Profile name</span>
                  <Input
                    value={createProfileName}
                    onChange={(event) => setCreateProfileName(event.target.value)}
                    placeholder="New profile name"
                    disabled={!targetEnvironmentId || busyAction !== null}
                  />
                </label>
                <div className="profiles-workspace__create-actions">
                  <SimmButton
                    type="button"
                    variant="secondary"
                    className="btn btn-secondary"
                    onClick={() => void runAction('createLoad', loadCreateDraft)}
                    disabled={!targetEnvironmentId || busyAction !== null}
                  >
                    <Icon name={busyAction === 'createLoad' ? 'spinner' : 'list'} />
                    Reload Target Items
                  </SimmButton>
                  <span>{createSelectedCount}/{createDraftItems.length} selected</span>
                </div>
              </div>

              {createDraftItems.length > 0 ? (
                <>
                  <div className="profiles-workspace__create-actions">
                    <SimmButton
                      type="button"
                      variant="secondary"
                      className="btn btn-secondary"
                      onClick={() => setCreateSelectedItemKeys(new Set(createDraftItems.map((item, index) => profileItemKey(item, index))))}
                      disabled={busyAction !== null}
                    >
                      All
                    </SimmButton>
                    <SimmButton
                      type="button"
                      variant="secondary"
                      className="btn btn-secondary"
                      onClick={() => setCreateSelectedItemKeys(new Set())}
                      disabled={busyAction !== null}
                    >
                      None
                    </SimmButton>
                  </div>
                  <div className="profiles-workspace__create-list" aria-label="Create profile items">
                    {createDraftItems.map((item, index) => {
                      const key = profileItemKey(item, index);
                      return (
                        <label key={key} className="profiles-workspace__create-item">
                          <Checkbox
                            checked={createSelectedItemKeys.has(key)}
                            onCheckedChange={(checked) => {
                              setCreateSelectedItemKeys((current) => {
                                const next = new Set(current);
                                if (checked) next.add(key);
                                else next.delete(key);
                                return next;
                              });
                            }}
                            disabled={busyAction !== null}
                          />
                          <span>
                            <strong>{item.name}</strong>
                            <small>{itemTypeLabel(item)} - {item.fileName ?? item.sourceId ?? item.storageId ?? 'No file identity'}</small>
                          </span>
                        </label>
                      );
                    })}
                  </div>
                </>
              ) : (
                <div className="profiles-workspace__empty profiles-workspace__empty--compact">Load target items to choose what belongs in this profile.</div>
              )}

              <SimmButton
                type="button"
                className="btn btn-primary"
                onClick={() => void runAction('createSelected', createSelectedProfile)}
                disabled={!createDraftManifest || createSelectedCount === 0 || !createProfileName.trim() || busyAction !== null}
              >
                <Icon name={busyAction === 'createSelected' ? 'spinner' : 'plus'} />
                Create Selected Profile
              </SimmButton>
            </div>
          )}

          <div className="profiles-workspace__table" role="table" aria-label="Profile items">
            <div className="profiles-workspace__table-head" role="row">
              <span>Name</span>
              <span>Details</span>
              <span>State</span>
            </div>
            <div className="profiles-workspace__table-body">
              {selectedProfile ? planRows.map((row, index) => (
                <div
                  key={`${itemIdentity(row.item)}-${index}`}
                  className={`profiles-workspace__table-row profiles-workspace__table-row--${hasPreviewPlan ? planItemStatusClass(row) : 'tracked'}`}
                  role="row"
                >
                  <span>
                    <strong>{row.item.name}</strong>
                    <small>{row.item.fileName ?? row.item.sourceId ?? row.item.storageId ?? 'No file identity'}</small>
                  </span>
                  <span>
                    <strong>{itemTypeLabel(row.item)}</strong>
                    <small>{row.item.source ?? 'local'}</small>
                  </span>
                  <span title={row.message}>
                    <strong>{row.item.enabled === false ? 'Disabled' : 'Enabled'}</strong>
                    <small>{hasPreviewPlan ? (statusLabels[row.status] ?? row.status) : 'Tracked'}</small>
                  </span>
                </div>
              )) : (
                <div className="profiles-workspace__empty">Choose a profile to inspect its items.</div>
              )}
            </div>
          </div>
        </main>

        <aside className="profiles-workspace__inspector" aria-label="Selected profile">
          <div className="profiles-workspace__inspector-header">
            <span className="workspace-eyebrow">Selected</span>
            <h3>{selectedProfile?.name ?? 'No profile selected'}</h3>
            {selectedProfile && <p>{runtimeLabel(selectedProfile.runtime)} profile with {profileItems.length} tracked items.</p>}
            {selectedProfile && (
              <div className="profiles-workspace__active-envs">
                <strong>Used by</strong>
                {activeProfileEnvironments.length > 0 ? (
                  <span>{activeProfileEnvironments.map((environment) => environment.name).join(', ')}</span>
                ) : (
                  <span>No environments currently use this profile.</span>
                )}
              </div>
            )}
          </div>

          <label className="profiles-workspace__field">
            <span>Rename</span>
            <Input
              value={renameValue}
              onChange={(event) => setRenameValue(event.target.value)}
              disabled={!selectedProfile || busyAction !== null}
            />
          </label>
          <SimmButton
            type="button"
            variant="secondary"
            className="btn btn-secondary"
            onClick={() => void runAction('rename', renameProfile)}
            disabled={!selectedProfile || busyAction !== null || renameValue.trim() === selectedProfile?.name}
          >
            <Icon name={busyAction === 'rename' ? 'spinner' : 'penToSquare'} />
            Rename
          </SimmButton>

          <div className="profiles-workspace__rule">
            <strong>Runtime lock</strong>
            <span>{selectedProfile ? `${runtimeLabel(selectedProfile.runtime)} profiles only apply to ${runtimeLabel(selectedProfile.runtime)} environments.` : 'Choose a profile to see compatible environments.'}</span>
          </div>

          <label className="profiles-workspace__checkbox">
            <Checkbox
              checked={includeDisabledExport}
              onCheckedChange={(checked) => setIncludeDisabledExport(Boolean(checked))}
            />
            <span>Include disabled items in JSON export</span>
          </label>

          <SimmButton
            type="button"
            variant="secondary"
            className="btn btn-secondary"
            onClick={() => void runAction('export', exportProfile)}
            disabled={!selectedProfile || busyAction !== null}
          >
            <Icon name={busyAction === 'export' ? 'spinner' : 'download'} />
            Export JSON
          </SimmButton>

          <SimmButton
            type="button"
            variant="secondary"
            className="btn btn-secondary"
            onClick={() => void runAction('captureUpdate', updateSelectedFromTarget)}
            disabled={!selectedProfile || !targetEnvironmentId || busyAction !== null}
          >
            <Icon name={busyAction === 'captureUpdate' ? 'spinner' : 'save'} />
            Capture Into Selected
          </SimmButton>

          <div className="profiles-workspace__section">
            <span className="workspace-eyebrow">Capture snapshot</span>
            <label className="profiles-workspace__field">
              <span>Snapshot name</span>
              <Input
                value={captureName}
                onChange={(event) => setCaptureName(event.target.value)}
                placeholder="Profile name"
                disabled={!targetEnvironmentId || busyAction !== null}
              />
            </label>
            <SimmButton
              type="button"
              variant="secondary"
              className="btn btn-secondary"
              onClick={() => void runAction('captureNew', captureNewProfile)}
              disabled={!targetEnvironmentId || !captureName.trim() || busyAction !== null}
            >
              <Icon name={busyAction === 'captureNew' ? 'spinner' : 'plus'} />
              Capture Full Snapshot
            </SimmButton>
          </div>

          <SimmButton
            type="button"
            variant="destructive"
            className="btn btn-danger"
            onClick={() => void runAction('delete', deleteProfile)}
            disabled={!selectedProfile || selectedProfile.isDefault || selectedProfileActiveCount > 0 || busyAction !== null}
          >
            <Icon name={busyAction === 'delete' ? 'spinner' : 'trash'} />
            Delete
          </SimmButton>
        </aside>
      </div>
    </section>
  );
}
