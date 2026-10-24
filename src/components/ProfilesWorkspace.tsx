import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { open, save } from '@tauri-apps/plugin-dialog';
import { useAppDialogs } from './AppDialogProvider';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { ApiService } from '../services/api';
import {
  normalizeCollectionIdentity,
  normalizeCollectionVersion,
  resolveCollectionNexusFileForRuntime,
  updateCollectionProfileFromLibrary,
} from '../services/collectionProfile';
import { useOptionalDownloadStatusStore } from '../stores/downloadStatusStore';
import { useEnvironmentStore } from '../stores/environmentStore';
import { getErrorMessage } from '../utils/errors';
import type {
  Environment,
  ModProfileApplyResult,
  ModProfileImportPlan,
  ModProfileManifest,
  ModProfileCollectionItem,
  ModProfileItem,
  NexusCollectionModFile,
  Runtime,
  StoredModProfile,
} from '../types';
import { AnchoredContextMenu, type AnchoredContextMenuItem } from './AnchoredContextMenu';
import { Icon } from './Icon';
import { SimmButton } from './primitives';
import { ModThumbnail, ThumbnailStack, type ModArtwork } from './media/ModThumbnail';
import { useLibraryArtwork } from './useLibraryArtwork';

type RuntimeKey = 'IL2CPP' | 'MONO';

type NexusDownloadAccess = {
  connected: boolean;
  canDirectDownload: boolean;
  requiresSiteConfirmation: boolean;
};

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

function requireCompleteProfileApply(result: ModProfileApplyResult, profileName: string): void {
  if (result.unresolved > 0) {
    const details = result.messages.length > 0
      ? result.messages.join(' ')
      : 'Review the profile preview and retry after correcting the reported file operation.';
    throw new Error(`Could not finish applying ${profileName}: ${result.unresolved} file operation(s) failed. ${details}`);
  }
}

function unavailableProfileItemCount(plan: ModProfileImportPlan): number {
  return plan.summary.needsDownload
    + plan.summary.manualRequired
    + plan.summary.runtimeMismatches
    + plan.summary.unsupported;
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

function collectionProfileItemMatches(
  collectionItem: ModProfileCollectionItem,
  profileItem: ModProfileItem,
): boolean {
  if (
    profileItem.nexusFileId
    && profileItem.nexusFileId === collectionItem.nexusFileId
  ) {
    return true;
  }

  if (
    collectionItem.nexusModId
    && profileItem.sourceId === String(collectionItem.nexusModId)
    && normalizeCollectionVersion(profileItem.sourceVersion) === normalizeCollectionVersion(collectionItem.requestedVersion)
  ) {
    return true;
  }

  return normalizeCollectionIdentity(profileItem.name) === normalizeCollectionIdentity(collectionItem.requestedName)
    && normalizeCollectionVersion(profileItem.sourceVersion) === normalizeCollectionVersion(collectionItem.requestedVersion);
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

function effectiveNexusDownloadAccess(
  status: Awaited<ReturnType<typeof ApiService.getNexusOAuthStatus>>,
): NexusDownloadAccess {
  const connected = Boolean(status.connected);
  const isPremium = connected && Boolean(status.account?.isPremium);
  return {
    connected,
    canDirectDownload: connected && (isPremium || Boolean(status.account?.canDirectDownload)),
    requiresSiteConfirmation:
      connected && !isPremium && Boolean(status.account?.requiresSiteConfirmation),
  };
}

interface ProfilesWorkspaceProps {
  preferredEnvironmentId?: string | null;
  initialProfileId?: string | null;
}

function formatFileSize(bytes: number | null | undefined): string {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes <= 0) return 'Size unavailable';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function collectionSourceLabel(
  collectionItem: ModProfileCollectionItem,
  profileItem: ModProfileItem,
): string {
  const source = collectionItem.sourceChoice === 'library'
    ? profileItem.source
    : collectionItem.sourceChoice;
  return source === 'thunderstore' ? 'Thunderstore' : 'Nexus Mods';
}

function sourceLabel(source: string | null | undefined): string {
  switch (source) {
    case 'thunderstore': return 'Thunderstore';
    case 'nexusmods': return 'Nexus Mods';
    case 'github': return 'GitHub';
    case null:
    case undefined:
    case '':
    case 'local': return 'Local';
    default: return source.charAt(0).toUpperCase() + source.slice(1);
  }
}

function itemFileIdentity(item: ModProfileItem): string {
  return item.fileName ?? item.sourceId ?? item.storageId ?? 'No file identity';
}

type ProfileFlow = 'apply' | 'create' | 'update' | null;

type ProfilesSelectOption = { value: string; label: string; disabled?: boolean };

/** Environment picker on the shared Select; an empty value shows "Choose environment". */
function ProfilesEnvironmentSelect({ label, value, options, onValueChange, disabled }: {
  label: string;
  value: string;
  options: ProfilesSelectOption[];
  onValueChange: (value: string) => void;
  disabled?: boolean;
}) {
  return (
    <Select
      items={options}
      value={value || null}
      disabled={disabled}
      onValueChange={(next) => { if (typeof next === 'string') onValueChange(next); }}
    >
      <SelectTrigger className="profiles-field__select" aria-label={label}>
        <SelectValue placeholder="Choose environment" />
      </SelectTrigger>
      <SelectContent align="start">
        <SelectGroup>
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value} disabled={option.disabled}>{option.label}</SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  );
}

export function ProfilesWorkspace({ preferredEnvironmentId, initialProfileId }: ProfilesWorkspaceProps) {
  const { confirm } = useAppDialogs();
  const { environments, loading: environmentsLoading, refreshEnvironments } = useEnvironmentStore();
  const downloadStatusStore = useOptionalDownloadStatusStore();
  const getModArtwork = useLibraryArtwork();
  const itemArtwork = useCallback((item: ModProfileItem): ModArtwork | null => (
    getModArtwork(item.name)
    ?? getModArtwork(item.fileName)
    ?? getModArtwork(item.sourceId?.split('/').pop())
  ), [getModArtwork]);
  /** The Nexus collection tile, which SIMM keeps on the collection's download record. */
  const collectionArtwork = useCallback((profile: StoredModProfile): ModArtwork | null => {
    const collection = profile.manifest.collection;
    if (!collection) return null;
    const aggregateId = `collection:${collection.slug}:${collection.revisionNumber}`;
    const download = downloadStatusStore?.downloads.find((entry) =>
      entry.kind === 'collection'
      && (entry.id === aggregateId || entry.profileId === profile.id)
      && (entry.iconUrl || entry.iconCachePath)
    );
    return download ? { iconUrl: download.iconUrl, iconCachePath: download.iconCachePath } : null;
  }, [downloadStatusStore?.downloads]);
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
  const [renameValue, setRenameValue] = useState('');
  const [renaming, setRenaming] = useState(false);
  const [flow, setFlow] = useState<ProfileFlow>(null);
  const [moreMenu, setMoreMenu] = useState<{ x: number; y: number } | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [createEnvironmentId, setCreateEnvironmentId] = useState<string>('');
  const [createProfileName, setCreateProfileName] = useState('');
  const [createDraftManifest, setCreateDraftManifest] = useState<ModProfileManifest | null>(null);
  const [createSelectedItemKeys, setCreateSelectedItemKeys] = useState<Set<string>>(() => new Set());
  const [nexusDownloadAccess, setNexusDownloadAccess] = useState<NexusDownloadAccess | null>(null);
  const [collectionFileSizes, setCollectionFileSizes] = useState<Record<string, number>>({});
  const profilesLoadGenerationRef = useRef(0);
  const targetSelectionGenerationRef = useRef(0);
  const createSelectionGenerationRef = useRef(0);
  const lastHandledInitialProfileIdRef = useRef<string | null | undefined>(undefined);
  const lastAppliedPreferredEnvironmentIdRef = useRef<string | null>(null);
  const preferredEnvironment = useMemo(
    () => environments.find((environment) => environment.id === preferredEnvironmentId) ?? null,
    [environments, preferredEnvironmentId],
  );

  const loadProfiles = useCallback(async () => {
    const generation = ++profilesLoadGenerationRef.current;
    setProfilesLoading(true);
    setError(null);
    try {
      const loaded = await ApiService.listModProfiles();
      if (generation !== profilesLoadGenerationRef.current) return;
      setProfiles(loaded);
      setSelectedProfileId((current) => {
        if (
          initialProfileId
          && lastHandledInitialProfileIdRef.current !== initialProfileId
          && loaded.some((profile) => profile.id === initialProfileId)
        ) {
          lastHandledInitialProfileIdRef.current = initialProfileId;
          return initialProfileId;
        }
        if (current && loaded.some((profile) => profile.id === current)) return current;
        const preferredRuntime = preferredEnvironment ? runtimeKey(preferredEnvironment.runtime) : selectedRuntime;
        const sameRuntime = loaded.find((profile) =>
          runtimeKey(profile.runtime) === preferredRuntime && profile.isDefault
        ) ?? loaded.find((profile) => runtimeKey(profile.runtime) === preferredRuntime);
        return sameRuntime?.id ?? loaded[0]?.id ?? null;
      });
    } catch (err) {
      if (generation !== profilesLoadGenerationRef.current) return;
      setError(getErrorMessage(err, 'Failed to load profiles.'));
    } finally {
      if (generation === profilesLoadGenerationRef.current) {
        setProfilesLoading(false);
      }
    }
  }, [initialProfileId, preferredEnvironment, selectedRuntime]);

  useEffect(() => {
    void loadProfiles();
  }, [loadProfiles]);

  useEffect(() => {
    const handleProfilesUpdated = () => void loadProfiles();
    window.addEventListener('mod-profiles-updated', handleProfilesUpdated);
    return () => window.removeEventListener('mod-profiles-updated', handleProfilesUpdated);
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
    if (lastAppliedPreferredEnvironmentIdRef.current === preferredEnvironment.id) return;
    lastAppliedPreferredEnvironmentIdRef.current = preferredEnvironment.id;
    const preferredRuntime = runtimeKey(preferredEnvironment.runtime);
    setSelectedRuntime(preferredRuntime);
    setTargetEnvironmentId(preferredEnvironment.id);
    setSelectedProfileId((current) => {
      if (
        initialProfileId
        && profiles.some((profile) => profile.id === initialProfileId)
      ) {
        return initialProfileId;
      }
      if (current) {
        const currentProfile = profiles.find((profile) => profile.id === current);
        if (currentProfile && runtimeKey(currentProfile.runtime) === preferredRuntime) return current;
      }
      return profiles.find((profile) => runtimeKey(profile.runtime) === preferredRuntime && profile.isDefault)?.id
        ?? profiles.find((profile) => runtimeKey(profile.runtime) === preferredRuntime)?.id
        ?? current;
    });
  }, [initialProfileId, preferredEnvironment, profiles, userChoseTarget]);

  useEffect(() => {
    if (selectedProfile && runtimeKey(selectedProfile.runtime) !== selectedRuntime) {
      setSelectedRuntime(runtimeKey(selectedProfile.runtime));
    }
    setRenameValue(selectedProfile?.name ?? '');
    setRenaming(false);
    setPlan(null);
    setNotice(null);
  }, [selectedProfile, selectedRuntime]);

  useLayoutEffect(() => {
    targetSelectionGenerationRef.current += 1;
  }, [selectedProfileId, targetEnvironmentId]);

  const selectCreateEnvironment = useCallback((environmentId: string) => {
    createSelectionGenerationRef.current += 1;
    setCreateEnvironmentId(environmentId);
    setCreateDraftManifest(null);
    setCreateSelectedItemKeys(new Set());
  }, []);

  useEffect(() => {
    if (!selectedProfile || userChoseTarget) return;
    const currentTarget = environments.find((environment) => environment.id === targetEnvironmentId);
    if (currentTarget && isCompatibleEnvironment(currentTarget, selectedProfile)) return;
    const completed = compatibleEnvironments.find((environment) => environment.status === 'completed');
    setTargetEnvironmentId((completed ?? compatibleEnvironments[0])?.id ?? '');
  }, [compatibleEnvironments, environments, selectedProfile, targetEnvironmentId, userChoseTarget]);

  const profileItems = selectedProfile?.manifest.items ?? [];
  const selectedCollection = selectedProfile?.manifest.collection ?? null;
  const selectedCollectionItems = selectedCollection?.items ?? [];
  const selectedCollectionReadyCount = selectedCollectionItems.filter((item) => item.selected && item.status === 'ready').length;
  const selectedCollectionIncludedCount = selectedCollectionItems.filter((item) => item.selected).length;
  const selectedCollectionDisabledCount = selectedCollectionItems.filter((collectionItem) =>
    collectionItem.selected
    && profileItems.some((profileItem) =>
      collectionProfileItemMatches(collectionItem, profileItem)
      && profileItem.enabled === false
    )
  ).length;
  const selectedCollectionDownload = useMemo(() => {
    if (!selectedCollection) return null;
    const aggregateId = `collection:${selectedCollection.slug}:${selectedCollection.revisionNumber}`;
    return downloadStatusStore?.downloads.find((download) =>
      download.kind === 'collection'
      && (download.id === aggregateId || download.profileId === selectedProfile?.id)
    ) ?? null;
  }, [downloadStatusStore?.downloads, selectedCollection, selectedProfile?.id]);
  const selectedCollectionDownloadActive = selectedCollectionDownload
    ? ['queued', 'downloading', 'validating'].includes(selectedCollectionDownload.status)
    : false;
  const selectedProfileActiveCount = selectedProfile?.activeEnvironmentIds?.length ?? 0;
  const createDraftItems = createDraftManifest?.items ?? [];
  const createSelectedCount = createDraftItems.filter((item, index) =>
    createSelectedItemKeys.has(profileItemKey(item, index))
  ).length;

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

  const refreshNexusDownloadAccess = useCallback(async () => {
    const status = await ApiService.getNexusOAuthStatus();
    const access = effectiveNexusDownloadAccess(status);
    setNexusDownloadAccess(access);
    return access;
  }, []);

  useEffect(() => {
    if (!selectedCollection) {
      setNexusDownloadAccess(null);
      return;
    }

    let active = true;
    const refresh = async () => {
      try {
        const status = await ApiService.getNexusOAuthStatus();
        if (active) setNexusDownloadAccess(effectiveNexusDownloadAccess(status));
      } catch {
        if (active) setNexusDownloadAccess({
          connected: false,
          canDirectDownload: false,
          requiresSiteConfirmation: false,
        });
      }
    };
    const handleOAuthResult = () => void refresh();
    void refresh();
    window.addEventListener('nexus-oauth-result', handleOAuthResult);
    return () => {
      active = false;
      window.removeEventListener('nexus-oauth-result', handleOAuthResult);
    };
  }, [selectedCollection]);

  useEffect(() => {
    if (!selectedCollection) {
      setCollectionFileSizes({});
      return;
    }

    let active = true;
    void ApiService.getNexusCollectionRevisionPlan(
      selectedCollection.slug,
      selectedCollection.revisionNumber,
    ).then((revision) => {
      if (!active) return;
      setCollectionFileSizes(Object.fromEntries(
        revision.modFiles.flatMap((file) =>
          typeof file.sizeInBytes === 'number' && file.sizeInBytes > 0
            ? [[String(file.fileId), file.sizeInBytes]]
            : []
        ),
      ));
    }).catch(() => {
      if (active) setCollectionFileSizes({});
    });

    return () => {
      active = false;
    };
  }, [selectedCollection]);

  const saveCollectionProfile = useCallback(async (profile: StoredModProfile) => {
    const saved = await ApiService.saveModProfile({
      profileId: profile.id,
      name: profile.name,
      runtime: profile.runtime === 'MONO' ? 'Mono' : profile.runtime,
      manifest: profile.manifest,
    });
    await loadProfiles();
    setSelectedProfileId(saved.id);
    return saved;
  }, [loadProfiles]);

  const setCollectionItemStatus = useCallback(async (
    profile: StoredModProfile,
    key: string,
    status: ModProfileCollectionItem['status'],
    statusMessage: string,
  ) => {
    const collection = profile.manifest.collection;
    if (!collection) return profile;
    return saveCollectionProfile({
      ...profile,
      manifest: {
        ...profile.manifest,
        collection: {
          ...collection,
          items: collection.items.map((item) => item.key === key
            ? { ...item, status, statusMessage }
            : item),
        },
      },
    });
  }, [saveCollectionProfile]);

  const setCollectionProfileItemEnabled = useCallback(async (
    collectionItem: ModProfileCollectionItem,
    enabled: boolean,
  ) => {
    if (!selectedProfile?.manifest.collection) {
      throw new Error('Choose a collection profile first.');
    }
    if (collectionItem.status !== 'ready') {
      throw new Error('Download this collection mod before changing whether the profile installs it.');
    }

    const profileItemIndex = selectedProfile.manifest.items.findIndex((item) =>
      collectionProfileItemMatches(collectionItem, item)
    );
    if (profileItemIndex < 0) {
      throw new Error('SIMM could not match this collection entry to its profile item.');
    }

    const items = selectedProfile.manifest.items.map((item, index) =>
      index === profileItemIndex ? { ...item, enabled } : item
    );
    const saved = await saveCollectionProfile({
      ...selectedProfile,
      manifest: {
        ...selectedProfile.manifest,
        items,
      },
    });
    window.dispatchEvent(new CustomEvent('mod-profiles-updated', {
      detail: { profileId: saved.id },
    }));

    return enabled
      ? `${collectionItem.requestedName} will be installed the next time this profile is applied.`
      : `${collectionItem.requestedName} will remain downloaded but will be removed or omitted the next time this profile is applied.`;
  }, [saveCollectionProfile, selectedProfile]);

  const downloadCollectionProfileItem = useCallback(async (collectionItem: ModProfileCollectionItem) => {
    if (!selectedProfile) throw new Error('Choose a collection profile first.');
    const runtime = selectedProfile.runtime === 'IL2CPP' ? 'IL2CPP' : 'Mono';

    if (collectionItem.sourceChoice === 'nexusmods') {
      if (!collectionItem.nexusModId) {
        throw new Error('This collection item does not expose a Nexus mod ID.');
      }
      const collectionFileId = Number(collectionItem.collectionFileId ?? collectionItem.nexusFileId);
      if (!Number.isFinite(collectionFileId) || collectionFileId <= 0) {
        throw new Error('This collection item does not expose a valid Nexus file ID.');
      }
      const currentProfileItem = selectedProfile.manifest.items.find((item) =>
        item.nexusFileId === collectionItem.nexusFileId
        || (
          item.sourceId === String(collectionItem.nexusModId)
          && item.sourceVersion === collectionItem.requestedVersion
        ),
      );
      const sourceFile: NexusCollectionModFile = {
        collectionRevisionModId: collectionItem.key,
        modId: collectionItem.nexusModId,
        fileId: collectionFileId,
        modName: collectionItem.requestedName,
        author: collectionItem.requestedAuthor ?? undefined,
        fileName: currentProfileItem?.fileName || collectionItem.requestedName,
        version: collectionItem.requestedVersion,
        optional: collectionItem.optional,
        available: true,
      };
      const nexusFiles = await ApiService.getNexusModsModFiles('schedule1', collectionItem.nexusModId);
      const resolvedFile = resolveCollectionNexusFileForRuntime(sourceFile, nexusFiles, runtime);
      if (!resolvedFile) {
        throw new Error(`Nexus does not expose an exact ${collectionItem.requestedVersion} file for ${runtime}.`);
      }
      const fileId = resolvedFile.fileId;
      let workingProfile = selectedProfile;
      if (String(fileId) !== collectionItem.nexusFileId) {
        workingProfile = await saveCollectionProfile({
          ...selectedProfile,
          manifest: {
            ...selectedProfile.manifest,
            items: selectedProfile.manifest.items.map((item) => item === currentProfileItem
              ? { ...item, fileName: resolvedFile.fileName, nexusFileId: String(fileId), runtime }
              : item),
            collection: selectedProfile.manifest.collection ? {
              ...selectedProfile.manifest.collection,
              items: selectedProfile.manifest.collection.items.map((item) => item.key === collectionItem.key
                ? {
                  ...item,
                  collectionFileId: item.collectionFileId ?? String(collectionFileId),
                  nexusFileId: String(fileId),
                  runtimeMismatch: false,
                }
                : item),
            } : undefined,
          },
        });
      }

      const access = await refreshNexusDownloadAccess();
      if (!access.canDirectDownload) {
        if (!access.connected) {
          throw new Error('Nexus login is required before this collection file can be downloaded. Open Accounts to sign in.');
        }
        await ApiService.beginNexusManualDownloadSession({
          kind: 'library',
          modId: collectionItem.nexusModId,
          fileId,
          gameId: 'schedule1',
          runtime,
        });
        await setCollectionItemStatus(
          workingProfile,
          collectionItem.key,
          'manualRequired',
          `Nexus opened exact ${runtime} file ${fileId}. Confirm it on the website; SIMM will attach the returned file to this profile.`,
        );
        return `Opened the exact ${runtime} file for ${collectionItem.requestedName} on Nexus.`;
      }

      workingProfile = await setCollectionItemStatus(
        workingProfile,
        collectionItem.key,
        'downloading',
        `Downloading exact Nexus file ${fileId} for the ${runtime} profile.`,
      );
      try {
        let result = await ApiService.downloadNexusModToLibrary(
          collectionItem.nexusModId,
          fileId,
          runtime,
        );
        if (!result.success && result.securityScanConfirmationRequired && !result.securityScanBlocked) {
          const confirmed = await confirm(
            `SIMM's security scan found items that require review for ${collectionItem.requestedName} (${runtime}). Continue with this exact Nexus file anyway?`,
            { title: `Security review required · ${runtime}`, kind: 'warning' },
          );
          if (!confirmed) {
            await setCollectionItemStatus(
              workingProfile,
              collectionItem.key,
              'manualRequired',
              'Download paused because the security review was not approved.',
            );
            return null;
          }
          result = await ApiService.downloadNexusModToLibrary(
            collectionItem.nexusModId,
            fileId,
            runtime,
            true,
          );
        }

        if (!result.success) {
          throw new Error(result.securityScanBlocked
            ? `The security policy blocked this exact ${runtime} Nexus file.`
            : result.error || `Nexus did not complete the exact ${runtime} file download.`);
        }

        const library = await ApiService.getModLibrary();
        workingProfile = updateCollectionProfileFromLibrary(workingProfile, library.downloaded);
        const syncedItem = workingProfile.manifest.collection?.items.find((item) => item.key === collectionItem.key);
        if (syncedItem?.status !== 'ready') {
          throw new Error('The file downloaded, but SIMM could not attach the exact Nexus file to this profile. Refresh the library and retry.');
        }
        await saveCollectionProfile(workingProfile);
        window.dispatchEvent(new CustomEvent('library-updated'));
        return `${collectionItem.requestedName} ${collectionItem.requestedVersion} is downloaded and ready in this profile.`;
      } catch (err) {
        await setCollectionItemStatus(
          workingProfile,
          collectionItem.key,
          'error',
          getErrorMessage(err, `Nexus did not complete the exact ${runtime} file download.`),
        ).catch(() => undefined);
        throw err;
      }
    }

    const match = collectionItem.thunderstoreMatch;
    if (!match) throw new Error('No exact Thunderstore match is stored for this collection item.');
    if (collectionItem.runtimeMismatch) {
      const confirmed = await confirm(
        `${collectionItem.requestedName} ${collectionItem.requestedVersion} is an exact name, author, and version match, but it targets ${match.runtime} while this profile targets ${runtime}. Download it anyway?`,
        { title: 'Runtime mismatch', kind: 'warning' },
      );
      if (!confirmed) return null;
    }

    let workingProfile = await setCollectionItemStatus(
      selectedProfile,
      collectionItem.key,
      'downloading',
      `Downloading exact Thunderstore version ${collectionItem.requestedVersion}.`,
    );
    try {
      let result = await ApiService.downloadThunderstoreToLibrary(
        match.packageUuid,
        runtime,
        undefined,
        match.versionUuid,
      );
      if (!result.success && result.securityScanConfirmationRequired && !result.securityScanBlocked) {
        const confirmed = await confirm(
          `SIMM's security scan found items that require review for ${collectionItem.requestedName}. Continue with this exact Thunderstore file anyway?`,
          { title: 'Security review required', kind: 'warning' },
        );
        if (confirmed) {
          result = await ApiService.downloadThunderstoreToLibrary(
            match.packageUuid,
            runtime,
            true,
            match.versionUuid,
          );
        } else {
          await setCollectionItemStatus(
            workingProfile,
            collectionItem.key,
            'manualRequired',
            'Download paused because the security review was not approved.',
          );
          return null;
        }
      }
      if (!result.success) {
        throw new Error(result.securityScanBlocked
          ? 'The security policy blocked this Thunderstore file.'
          : 'Thunderstore did not complete the exact-version download.');
      }
      const library = await ApiService.getModLibrary();
      workingProfile = updateCollectionProfileFromLibrary(workingProfile, library.downloaded);
      await saveCollectionProfile(workingProfile);
      window.dispatchEvent(new CustomEvent('library-updated'));
      return `${collectionItem.requestedName} ${collectionItem.requestedVersion} is ready in this profile.`;
    } catch (err) {
      await setCollectionItemStatus(
        workingProfile,
        collectionItem.key,
        'error',
        getErrorMessage(err, 'Thunderstore did not complete the download.'),
      ).catch(() => undefined);
      throw err;
    }
  }, [refreshNexusDownloadAccess, saveCollectionProfile, selectedProfile, setCollectionItemStatus, confirm]);

  useEffect(() => {
    const handleManualDownloadResult = (event: Event) => {
      const detail = (event as CustomEvent<{ success?: boolean; result?: { fileId?: number }; fileId?: number }>).detail;
      if (!detail?.success || !selectedProfile?.manifest.collection) return;
      const returnedFileId = detail.result?.fileId ?? detail.fileId;
      if (returnedFileId && !selectedProfile.manifest.collection.items.some((item) => item.nexusFileId === String(returnedFileId))) {
        return;
      }
      void (async () => {
        const library = await ApiService.getModLibrary();
        const synced = updateCollectionProfileFromLibrary(selectedProfile, library.downloaded);
        if (synced !== selectedProfile) await saveCollectionProfile(synced);
      })();
    };
    window.addEventListener('nexus-manual-download-result', handleManualDownloadResult);
    return () => window.removeEventListener('nexus-manual-download-result', handleManualDownloadResult);
  }, [saveCollectionProfile, selectedProfile]);

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

  const confirmProfileRemovals = useCallback(async (profile: StoredModProfile, targetId: string) => {
    const targetGeneration = targetSelectionGenerationRef.current;
    const nextPlan = await ApiService.previewModProfileApply(profile.id, targetId);
    if (targetGeneration !== targetSelectionGenerationRef.current) return null;
    setPlan(nextPlan);
    if (nextPlan.removals.length === 0) return nextPlan;

    const permanent = nextPlan.removals.filter((removal) => !removal.recoverable);
    const retained = nextPlan.removals.length - permanent.length;
    const permanentNames = permanent.map((removal) => removal.item.name).join('\n• ');
    const warning = [
      `Switching to ${profile.name} will remove ${nextPlan.removals.length} tracked item(s) from this game installation.`,
      retained > 0 ? `${retained} item(s) have a shared-library copy and can be installed again later.` : '',
      permanent.length > 0
        ? `${permanent.length} item(s) have no shared-library copy and will be permanently deleted:\n• ${permanentNames}`
        : '',
      'Unavailable profile items will be omitted and will not block activation. Continue?',
    ].filter(Boolean).join('\n\n');
    const confirmed = await confirm(warning, {
      title: permanent.length > 0 ? 'Profile switch will delete files' : 'Switch profile',
      kind: 'warning',
    });
    return confirmed ? nextPlan : null;
  }, [confirm]);

  const applyProfile = useCallback(async () => {
    const profile = requireSelection();
    const targetId = targetEnvironmentId;
    const targetGeneration = targetSelectionGenerationRef.current;
    const approvedPlan = await confirmProfileRemovals(profile, targetId);
    if (!approvedPlan) return null;
    const result = await ApiService.applyModProfile(profile.id, targetId);
    if (targetGeneration !== targetSelectionGenerationRef.current) {
      return null;
    }
    setPlan(result.plan);
    await refreshEnvironments();
    await loadProfiles();
    requireCompleteProfileApply(result, profile.name);
    const unavailable = unavailableProfileItemCount(result.plan);
    return `Applied ${profile.name}. Installed ${result.installed}, removed ${result.removed ?? 0}${unavailable > 0 ? `, omitted ${unavailable} unavailable item(s)` : ''}.`;
  }, [confirmProfileRemovals, loadProfiles, refreshEnvironments, requireSelection, targetEnvironmentId]);

  const applyAndLaunch = useCallback(async () => {
    const profile = requireSelection();
    const targetId = targetEnvironmentId;
    const targetGeneration = targetSelectionGenerationRef.current;
    const approvedPlan = await confirmProfileRemovals(profile, targetId);
    if (!approvedPlan) return null;
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
    requireCompleteProfileApply(result, profile.name);
    const launch = await ApiService.launchGame(targetId, 'steam');
    return launch.success
      ? `Applied ${profile.name} and launched the game.`
      : `Applied ${profile.name}, but launch did not complete.`;
  }, [confirmProfileRemovals, loadProfiles, refreshEnvironments, requireSelection, targetEnvironmentId]);

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

  const exportProfile = useCallback(async (includeDisabled: boolean) => {
    if (!selectedProfile) throw new Error('Choose a profile first.');
    const destination = await save({
      title: 'Save SIMM profile',
      defaultPath: profileFileName(selectedProfile.name),
      filters: [{ name: 'SIMM profile', extensions: ['json'] }],
    });
    if (!destination) return null;
    const manifest = await ApiService.exportModProfileFromLibrary({
      profileId: selectedProfile.id,
      includeDisabled,
    });
    await ApiService.saveModProfileFile(manifest, destination);
    return `Exported ${manifest.profile.name}.`;
  }, [selectedProfile]);

  const captureNewProfile = useCallback(async () => {
    if (!createEnvironmentId) throw new Error('Choose a source environment first.');
    const targetId = createEnvironmentId;
    const targetGeneration = createSelectionGenerationRef.current;
    const name = createProfileName.trim();
    if (!name) throw new Error('Name the captured profile first.');
    const captured = await ApiService.captureModProfile({
      environmentId: targetId,
      name,
      includeDisabled: true,
    });
    if (targetGeneration !== createSelectionGenerationRef.current) return null;
    await loadProfiles();
    setSelectedProfileId(captured.id);
    setSelectedRuntime(runtimeKey(captured.runtime));
    setCreateDraftManifest(null);
    setCreateSelectedItemKeys(new Set());
    setCreateProfileName('');
    setFlow(null);
    return `Captured ${captured.name}.`;
  }, [createEnvironmentId, createProfileName, loadProfiles]);

  const loadCreateDraft = useCallback(async (environmentId: string) => {
    if (!environmentId) throw new Error('Choose a source environment first.');
    const targetGeneration = createSelectionGenerationRef.current;
    setFlow('create');
    const manifest = await ApiService.exportEnvironmentProfile(environmentId);
    if (targetGeneration !== createSelectionGenerationRef.current) return null;
    setCreateDraftManifest(manifest);
    setCreateSelectedItemKeys(new Set(manifest.items.map((item, index) => profileItemKey(item, index))));
    setCreateProfileName((current) => current.trim() || manifest.profile.name);
    return null;
  }, []);

  const openCreateProfile = useCallback(async () => {
    setFlow('create');
    setMoreMenu(null);
    const sourceId = createEnvironmentId
      || targetEnvironmentId
      || (environments.find((environment) => environment.status === 'completed') ?? environments[0])?.id
      || '';
    if (!sourceId) return null;
    if (sourceId !== createEnvironmentId) {
      selectCreateEnvironment(sourceId);
    } else if (createDraftManifest) {
      return null;
    }
    return loadCreateDraft(sourceId);
  }, [createDraftManifest, createEnvironmentId, environments, loadCreateDraft, selectCreateEnvironment, targetEnvironmentId]);

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
    setFlow(null);
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
    setFlow(null);
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
    setRenaming(false);
    return `Renamed profile to ${updated.name}.`;
  }, [loadProfiles, renameValue, selectedProfile]);

  const duplicateProfile = useCallback(async () => {
    if (!selectedProfile) throw new Error('Choose a profile first.');
    const name = `${selectedProfile.name} copy`;
    const runtime = runtimeForSave(runtimeKey(selectedProfile.runtime));
    const saved = await ApiService.saveModProfile({
      name,
      runtime,
      manifest: {
        ...selectedProfile.manifest,
        profileId: null,
        isDefault: false,
        createdAt: null,
        updatedAt: null,
        profile: {
          ...selectedProfile.manifest.profile,
          name,
          runtime,
        },
      },
    });
    await loadProfiles();
    setSelectedProfileId(saved.id);
    return `Created ${saved.name}.`;
  }, [loadProfiles, selectedProfile]);

  const deleteProfile = useCallback(async () => {
    if (!selectedProfile) throw new Error('Choose a profile first.');
    if (selectedProfile.isDefault) throw new Error('Default runtime profiles cannot be deleted.');
    if (selectedProfileActiveCount > 0) {
      throw new Error('Apply another profile to every active environment before deleting this one.');
    }
    const confirmed = await confirm(
      `Delete ${selectedProfile.name}?`,
      { title: 'Delete profile', kind: 'warning' },
    );
    if (!confirmed) return null;
    await ApiService.deleteModProfile(selectedProfile.id);
    await loadProfiles();
    return `Deleted ${selectedProfile.name}.`;
  }, [loadProfiles, selectedProfile, selectedProfileActiveCount, confirm]);


  useEffect(() => {
    if (flow !== 'apply' || !selectedProfile || !targetEnvironmentId) return;
    const targetGeneration = targetSelectionGenerationRef.current;
    let active = true;
    setPreviewLoading(true);
    ApiService.previewModProfileApply(selectedProfile.id, targetEnvironmentId)
      .then((nextPlan) => {
        if (active && targetGeneration === targetSelectionGenerationRef.current) setPlan(nextPlan);
      })
      .catch((err) => {
        if (active) setError(getErrorMessage(err, 'Could not preview this profile.'));
      })
      .finally(() => {
        if (active) setPreviewLoading(false);
      });
    return () => {
      active = false;
      setPreviewLoading(false);
    };
  }, [flow, selectedProfile, targetEnvironmentId]);

  const busy = busyAction !== null;
  const deleteBlocked = !selectedProfile || selectedProfile.isDefault || selectedProfileActiveCount > 0;
  const targetEnvironment = environments.find((environment) => environment.id === targetEnvironmentId) ?? null;
  const installRows = plan?.items.filter((row) => row.status === 'readyToInstall') ?? [];
  const unchangedRows = plan?.items.filter((row) => row.status === 'alreadyInstalled') ?? [];
  const unavailableRows = plan?.items.filter((row) => row.status !== 'readyToInstall' && row.status !== 'alreadyInstalled') ?? [];
  const removalRows = plan?.removals ?? [];
  const permanentRemovalCount = removalRows.filter((removal) => !removal.recoverable).length;

  const moreMenuItems: AnchoredContextMenuItem[] = selectedProfile ? [
    {
      key: 'rename',
      label: 'Rename…',
      icon: 'penToSquare',
      disabled: busy,
      onSelect: () => {
        setRenameValue(selectedProfile.name);
        setRenaming(true);
      },
    },
    {
      key: 'duplicate',
      label: 'Duplicate',
      icon: 'copy',
      disabled: busy,
      onSelect: () => void runAction('duplicate', duplicateProfile),
    },
    {
      key: 'update',
      label: 'Update From Environment…',
      icon: 'rotate',
      disabled: busy,
      onSelect: () => setFlow('update'),
    },
    {
      key: 'export',
      label: 'Export JSON…',
      icon: 'download',
      disabled: busy,
      onSelect: () => void runAction('export', () => exportProfile(false)),
    },
    {
      key: 'export-disabled',
      label: 'Export JSON With Disabled Items…',
      icon: 'download',
      disabled: busy,
      onSelect: () => void runAction('export', () => exportProfile(true)),
    },
    {
      key: 'delete',
      label: 'Delete…',
      icon: 'trash',
      danger: true,
      disabled: busy || deleteBlocked,
      onSelect: () => void runAction('delete', deleteProfile),
    },
  ] : [];

  const renderTargetSelect = (label: string) => (
    <div className="profiles-field">
      <span aria-hidden="true">{label}</span>
      <ProfilesEnvironmentSelect
        label={label}
        value={targetEnvironmentId}
        onValueChange={(environmentId) => {
          setTargetEnvironmentId(environmentId);
          setUserChoseTarget(true);
        }}
        disabled={!selectedProfile || environmentsLoading || busy}
        options={environments.map((environment) => {
          const compatible = isCompatibleEnvironment(environment, selectedProfile);
          return {
            value: environment.id,
            label: `${environment.name}${compatible ? '' : ` (${runtimeLabel(environment.runtime)}, not compatible)`}`,
            disabled: !compatible,
          };
        })}
      />
    </div>
  );

  const renderDiffItem = (item: ModProfileItem, detail?: string) => (
    <span className="profiles-diff__item">
      <ModThumbnail {...itemArtwork(item)} name={item.name} size={20} />
      <span className="profiles-diff__item-text">
        <strong className="ui-truncate" title={item.name}>{item.name}</strong>
        <small>{detail ?? `${itemTypeLabel(item)} · ${sourceLabel(item.source)}`}</small>
      </span>
    </span>
  );

  const renderApplyFlow = () => (
    <section className="profiles-flow" aria-label="Apply preview">
      <div className="profiles-flow__bar">
        {renderTargetSelect('Target environment')}
        <SimmButton
          type="button"
          variant="ghost"
          size="icon"
          onClick={() => void runAction('preview', previewProfile)}
          disabled={!selectedProfile || !targetEnvironmentId || busy}
          aria-label="Refresh preview"
          title="Refresh preview"
        >
          <Icon name="rotate" spin={busyAction === 'preview' || previewLoading} />
        </SimmButton>
        <span className="ui-toolbar__spacer" />
        <SimmButton type="button" variant="ghost" onClick={() => setFlow(null)} disabled={busy}>
          Cancel
        </SimmButton>
        <SimmButton
          type="button"
          variant="secondary"
          onClick={() => void runAction('applyLaunch', applyAndLaunch)}
          disabled={!selectedProfile || !targetEnvironmentId || busy}
        >
          <Icon name={busyAction === 'applyLaunch' ? 'spinner' : 'play'} spin={busyAction === 'applyLaunch'} />
          Apply & Launch
        </SimmButton>
        <SimmButton
          type="button"
          onClick={() => void runAction('apply', applyProfile)}
          disabled={!selectedProfile || !targetEnvironmentId || busy}
        >
          {busyAction === 'apply' && <Icon name="spinner" spin />}
          Apply
        </SimmButton>
      </div>

      {compatibleEnvironments.length === 0 && !environmentsLoading ? (
        <div className="ui-empty">
          <span className="ui-empty__emblem" aria-hidden="true"><Icon name="cubes" /></span>
          <p className="ui-empty__title">No {selectedProfile ? runtimeLabel(selectedProfile.runtime) : ''} environment</p>
          <p className="ui-empty__copy">Profiles only apply to environments with the same runtime. Add an environment with this runtime first.</p>
        </div>
      ) : !targetEnvironmentId ? (
        <p className="profiles-flow__hint">Choose an environment to see what applying this profile changes.</p>
      ) : !plan ? (
        <p className="profiles-flow__hint" role="status">
          <Icon name="spinner" spin /> Checking {targetEnvironment?.name ?? 'the environment'}…
        </p>
      ) : (
        <>
          <p className="profiles-flow__summary">
            {installRows.length} to install · {removalRows.length} to remove
            {permanentRemovalCount > 0 ? ` (${permanentRemovalCount} permanent)` : ''}
            {' · '}{unavailableRows.length} unavailable · {unchangedRows.length} unchanged
          </p>

          {installRows.length > 0 && (
            <div className="profiles-diff">
              <h3 className="ui-section-title">Install</h3>
              <ul className="profiles-diff__list">
                {installRows.map((row, index) => (
                  <li key={`${profileItemKey(row.item, index)}-install`} className="profiles-diff__row" title={row.message}>
                    <Icon name="plus" className="profiles-diff__sign" />
                    {renderDiffItem(row.item)}
                    <span className="profiles-diff__note">From library</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {removalRows.length > 0 && (
            <div className="profiles-diff">
              <h3 className="ui-section-title">Remove</h3>
              <ul className="profiles-diff__list">
                {removalRows.map((removal, index) => (
                  <li key={`${profileItemKey(removal.item, index)}-removal`} className="profiles-diff__row" title={removal.message}>
                    <Icon name="minus" className="profiles-diff__sign" />
                    {renderDiffItem(removal.item)}
                    <span className={`profiles-diff__note${removal.recoverable ? '' : ' profiles-diff__note--danger'}`}>
                      {removal.recoverable ? 'Library copy kept' : 'Deleted permanently'}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {unavailableRows.length > 0 && (
            <div className="profiles-diff">
              <h3 className="ui-section-title">Unavailable, will be skipped</h3>
              <ul className="profiles-diff__list">
                {unavailableRows.map((row, index) => (
                  <li key={`${profileItemKey(row.item, index)}-unavailable`} className="profiles-diff__row">
                    <Icon name="triangleExclamation" className="profiles-diff__sign profiles-diff__sign--warn" />
                    {renderDiffItem(row.item, row.message)}
                    <span className="profiles-diff__note profiles-diff__note--warn">{statusLabels[row.status] ?? row.status}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {unchangedRows.length > 0 && (
            <details className="profiles-diff profiles-diff--unchanged">
              <summary className="ui-section-title">
                <Icon name="chevronRight" className="profiles-diff__chevron" />
                Already installed ({unchangedRows.length})
              </summary>
              <ul className="profiles-diff__list">
                {unchangedRows.map((row, index) => (
                  <li key={`${profileItemKey(row.item, index)}-unchanged`} className="profiles-diff__row">
                    <Icon name="check" className="profiles-diff__sign" />
                    {renderDiffItem(row.item)}
                    <span className="profiles-diff__note">Unchanged</span>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </>
      )}
    </section>
  );

  const renderUpdateFlow = () => (
    <section className="profiles-flow" aria-label="Update profile from environment">
      <div className="profiles-flow__bar">
        {renderTargetSelect('Source environment')}
        <span className="ui-toolbar__spacer" />
        <SimmButton type="button" variant="ghost" onClick={() => setFlow(null)} disabled={busy}>
          Cancel
        </SimmButton>
        <SimmButton
          type="button"
          onClick={() => void runAction('captureUpdate', updateSelectedFromTarget)}
          disabled={!selectedProfile || !targetEnvironmentId || busy}
        >
          {busyAction === 'captureUpdate' && <Icon name="spinner" spin />}
          Update Profile
        </SimmButton>
      </div>
      <p className="profiles-flow__hint">
        Replaces the items in {selectedProfile?.name ?? 'this profile'} with everything installed in
        {' '}{targetEnvironment?.name ?? 'the chosen environment'}, including disabled items.
      </p>
    </section>
  );

  const renderItemsTable = () => {
    if (profileItems.length === 0) {
      return (
        <div className="ui-empty">
          <span className="ui-empty__emblem" aria-hidden="true"><Icon name="boxOpen" /></span>
          <p className="ui-empty__title">This profile has no items</p>
          <p className="ui-empty__copy">Update it from an environment to capture the mods, plugins, and UserLibs installed there.</p>
          <SimmButton type="button" variant="secondary" onClick={() => setFlow('update')} disabled={busy}>
            Update From Environment…
          </SimmButton>
        </div>
      );
    }

    return (
      <table className="ui-table profiles-items" aria-label="Profile items">
        <thead>
          <tr>
            <th scope="col">Name</th>
            <th scope="col" className="profiles-items__col-type">Type</th>
            <th scope="col" className="profiles-items__col-source">Source</th>
            <th scope="col" className="profiles-items__col-state">State</th>
            {selectedCollection && <th scope="col" className="profiles-items__col-action"><span className="sr-only">Actions</span></th>}
          </tr>
        </thead>
        <tbody>
          {profileItems.map((item, index) => {
            const collectionItem = selectedCollectionItems.find((entry) => collectionProfileItemMatches(entry, item));
            const collectionActionBusy = collectionItem ? busyAction === `collection-${collectionItem.key}` : false;
            const collectionEnableBusy = collectionItem ? busyAction === `collection-enable-${collectionItem.key}` : false;
            const isNexusCollectionItem = collectionItem?.sourceChoice === 'nexusmods';
            const nexusAccessChecking = Boolean(isNexusCollectionItem && nexusDownloadAccess === null);
            const canDownloadNexusDirectly = Boolean(isNexusCollectionItem && nexusDownloadAccess?.canDirectDownload);
            const nexusLoginRequired = Boolean(isNexusCollectionItem && nexusDownloadAccess && !nexusDownloadAccess.connected);
            const collectionReady = collectionItem?.status === 'ready';
            const collectionSize = collectionItem
              ? formatFileSize(collectionItem.requestedSizeInBytes ?? collectionFileSizes[collectionItem.nexusFileId])
              : null;
            const collectionMeta = collectionItem
              ? [collectionSize, collectionSourceLabel(collectionItem, item)].filter(Boolean).join(' · ')
              : null;
            const collectionState = collectionItem
              ? collectionReady
                ? { label: 'Ready', tone: 'ok' }
                : collectionItem.status === 'downloading'
                  ? { label: 'Downloading', tone: 'info' }
                  : collectionItem.status === 'error'
                    ? { label: 'Download failed', tone: 'danger' }
                    : !collectionItem.selected
                      ? { label: 'Not selected', tone: 'muted' }
                      : nexusLoginRequired
                        ? { label: 'Login required', tone: 'warn' }
                        : { label: 'Download available', tone: 'muted' }
              : null;
            return (
              <tr key={`${itemIdentity(item)}-${index}`} className="ui-row">
                <td className="profiles-items__name">
                  <span className="profiles-items__name-cell">
                    <ModThumbnail {...itemArtwork(item)} name={item.name} size={24} />
                    <span className="profiles-items__name-text">
                      <strong className="ui-truncate" title={item.name}>{item.name}</strong>
                      <small className="ui-truncate">
                        {collectionItem
                          ? `${collectionItem.requestedVersion} · Nexus file ${collectionItem.nexusFileId}${collectionItem.requestedAuthor ? ` · ${collectionItem.requestedAuthor}` : ''}`
                          : itemFileIdentity(item)}
                      </small>
                    </span>
                  </span>
                </td>
                <td>{itemTypeLabel(item)}</td>
                <td>{collectionMeta ?? sourceLabel(item.source)}</td>
                <td title={collectionItem?.statusMessage ?? undefined}>
                  {collectionState ? (
                    <span className={`ui-status ui-status--${collectionState.tone}`}>{collectionState.label}</span>
                  ) : item.enabled === false ? (
                    <span className="ui-tag">Disabled</span>
                  ) : null}
                </td>
                {selectedCollection && (
                  <td className="profiles-items__action">
                    {collectionItem && collectionItem.selected && collectionReady && (
                      <div
                        className="profiles-items__toggle"
                        title="Choose whether this downloaded mod is installed when the profile is applied."
                      >
                        <Switch
                          size="sm"
                          checked={item.enabled !== false}
                          disabled={busy}
                          aria-label={`Install ${collectionItem.requestedName} with this profile`}
                          onCheckedChange={(checked) => void runAction(
                            `collection-enable-${collectionItem.key}`,
                            () => setCollectionProfileItemEnabled(collectionItem, Boolean(checked)),
                          )}
                        />
                        <span>{collectionEnableBusy ? 'Saving…' : item.enabled === false ? 'Skipped' : 'Install'}</span>
                      </div>
                    )}
                    {collectionItem && collectionItem.selected && collectionItem.status !== 'ready' && (
                      <SimmButton
                        type="button"
                        size="sm"
                        variant="secondary"
                        disabled={busy || nexusAccessChecking || nexusLoginRequired}
                        title={nexusLoginRequired ? 'Sign in to Nexus Mods from Accounts first.' : undefined}
                        onClick={() => void runAction(`collection-${collectionItem.key}`, () => downloadCollectionProfileItem(collectionItem))}
                      >
                        <Icon
                          name={collectionActionBusy || nexusAccessChecking ? 'spinner' : isNexusCollectionItem && !canDownloadNexusDirectly ? 'arrowUpRightFromSquare' : 'download'}
                          spin={collectionActionBusy || nexusAccessChecking}
                        />
                        {collectionActionBusy
                          ? 'Downloading…'
                          : nexusAccessChecking
                            ? 'Checking Nexus…'
                            : isNexusCollectionItem && !canDownloadNexusDirectly
                              ? nexusLoginRequired ? 'Sign In Required' : 'Open Nexus'
                              : collectionItem.runtimeMismatch
                                ? 'Download Anyway'
                                : collectionItem.status === 'error'
                                  ? 'Retry'
                                  : 'Download'}
                      </SimmButton>
                    )}
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    );
  };

  const renderCreateFlow = () => (
    <section className="profiles-detail" aria-label="Create profile">
      <header className="profiles-detail__header">
        <div className="profiles-detail__titles">
          <h2 className="profiles-detail__title">New profile</h2>
          <p className="profiles-detail__hint">Start from what is installed in an environment, then keep only the items you want.</p>
        </div>
        <div className="profiles-detail__actions">
          <SimmButton
            type="button"
            variant="ghost"
            onClick={() => {
              setFlow(null);
              setCreateDraftManifest(null);
              setCreateSelectedItemKeys(new Set());
            }}
            disabled={busy}
          >
            Cancel
          </SimmButton>
          <SimmButton
            type="button"
            variant="secondary"
            onClick={() => void runAction('captureNew', captureNewProfile)}
            disabled={!createEnvironmentId || !createProfileName.trim() || busy}
            title="Capture every item in the environment, including disabled ones"
          >
            {busyAction === 'captureNew' && <Icon name="spinner" spin />}
            Capture Full Snapshot
          </SimmButton>
          <SimmButton
            type="button"
            onClick={() => void runAction('createSelected', createSelectedProfile)}
            disabled={!createDraftManifest || createSelectedCount === 0 || !createProfileName.trim() || busy}
          >
            {busyAction === 'createSelected' && <Icon name="spinner" spin />}
            Create Profile
          </SimmButton>
        </div>
      </header>

      <div className="profiles-form">
        <div className="profiles-field">
          <span aria-hidden="true">Source environment</span>
          <ProfilesEnvironmentSelect
            label="Source environment"
            value={createEnvironmentId}
            onValueChange={(environmentId) => {
              selectCreateEnvironment(environmentId);
              if (environmentId) void runAction('createLoad', () => loadCreateDraft(environmentId));
            }}
            disabled={environmentsLoading || busy}
            options={environments.map((environment) => ({
              value: environment.id,
              label: environment.name.toLowerCase().includes(runtimeLabel(environment.runtime).toLowerCase())
                ? environment.name
                : `${environment.name} (${runtimeLabel(environment.runtime)})`,
            }))}
          />
        </div>
        <label className="profiles-field profiles-field--grow">
          <span>Profile name</span>
          <Input
            value={createProfileName}
            onChange={(event) => setCreateProfileName(event.target.value)}
            placeholder="New profile name"
            disabled={!createEnvironmentId || busy}
          />
        </label>
      </div>

      <div className="profiles-checklist">
        <div className="profiles-checklist__bar">
          <span className="ui-muted">
            {busyAction === 'createLoad' || busyAction === 'createOpen'
              ? 'Loading items…'
              : `${createSelectedCount} of ${createDraftItems.length} selected`}
          </span>
          <span className="ui-toolbar__spacer" />
          <SimmButton
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setCreateSelectedItemKeys(new Set(createDraftItems.map((item, index) => profileItemKey(item, index))))}
            disabled={busy || createDraftItems.length === 0}
          >
            Select All
          </SimmButton>
          <SimmButton
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setCreateSelectedItemKeys(new Set())}
            disabled={busy || createDraftItems.length === 0}
          >
            Select None
          </SimmButton>
        </div>
        {createDraftItems.length > 0 ? (
          <ul className="profiles-checklist__list" aria-label="Create profile items">
            {createDraftItems.map((item, index) => {
              const key = profileItemKey(item, index);
              return (
                <li key={key}>
                  <label className="profiles-checklist__item">
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
                      disabled={busy}
                    />
                    <span className="profiles-checklist__name ui-truncate">{item.name}</span>
                    <span className="profiles-checklist__meta ui-truncate">{itemTypeLabel(item)} · {itemFileIdentity(item)}</span>
                  </label>
                </li>
              );
            })}
          </ul>
        ) : (
          <div className="ui-empty">
            <span className="ui-empty__emblem" aria-hidden="true"><Icon name={createEnvironmentId ? 'boxOpen' : 'cubes'} /></span>
            <p className="ui-empty__title">{createEnvironmentId ? 'Nothing installed yet' : 'Choose a source environment'}</p>
            <p className="ui-empty__copy">
              {createEnvironmentId
                ? 'Install mods, plugins, or UserLibs in this environment, or choose another one.'
                : 'Its installed mods, plugins, and UserLibs become the starting point for the new profile.'}
            </p>
          </div>
        )}
      </div>

    </section>
  );

  const renderProfileDetail = (profile: StoredModProfile) => (
    <section className="profiles-detail" aria-label="Selected profile">
      <header className="profiles-detail__header">
        <div className="profiles-detail__titles">
          {renaming ? (
            <form
              className="profiles-rename"
              onSubmit={(event) => {
                event.preventDefault();
                void runAction('rename', renameProfile);
              }}
            >
              <Input
                aria-label="Profile name"
                value={renameValue}
                onChange={(event) => setRenameValue(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Escape') {
                    setRenaming(false);
                    setRenameValue(profile.name);
                  }
                }}
                disabled={busy}
                autoFocus
              />
              <SimmButton
                type="submit"
                size="sm"
                disabled={busy || !renameValue.trim() || renameValue.trim() === profile.name}
              >
                {busyAction === 'rename' && <Icon name="spinner" spin />}
                Save Name
              </SimmButton>
              <SimmButton
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => {
                  setRenaming(false);
                  setRenameValue(profile.name);
                }}
                disabled={busy}
              >
                Cancel
              </SimmButton>
            </form>
          ) : (
            <div className="profiles-detail__name-row">
              {(() => {
                const tile = collectionArtwork(profile);
                return tile ? <ModThumbnail {...tile} name={profile.name} size={32} className="profiles-detail__tile" /> : null;
              })()}
              <h2 className="profiles-detail__title" title={profile.name}>{profile.name}</h2>
              {profile.isDefault && <span className="ui-tag">Default</span>}
            </div>
          )}
          <div className="ui-meta">
            <span>{runtimeLabel(profile.runtime)}</span>
            <span>{profileItems.length} {profileItems.length === 1 ? 'item' : 'items'}</span>
            <span>
              {activeProfileEnvironments.length > 0
                ? `Used by ${activeProfileEnvironments.map((environment) => environment.name).join(', ')}`
                : 'Not used by any environment'}
            </span>
          </div>
        </div>
        <div className="profiles-detail__actions">
          {flow === null && (
            <SimmButton type="button" onClick={() => setFlow('apply')} disabled={busy}>
              Apply to Environment…
            </SimmButton>
          )}
          <SimmButton
            type="button"
            variant="outline"
            size="icon"
            aria-label="More profile actions"
            aria-haspopup="menu"
            aria-expanded={moreMenu !== null}
            title="More profile actions"
            onClick={(event) => {
              const rect = event.currentTarget.getBoundingClientRect();
              setMoreMenu((current) => current ? null : { x: rect.right - 224, y: rect.bottom + 4 });
            }}
          >
            <Icon name="ellipsisH" />
          </SimmButton>
        </div>
      </header>

      {selectedCollection && (
        <div className="profiles-detail__collection" aria-label="Collection profile status">
          <div className="ui-meta">
            <span>Nexus collection, revision {selectedCollection.revisionNumber}</span>
            <span>{selectedCollectionReadyCount} / {selectedCollectionIncludedCount} ready</span>
            <span>{selectedCollectionDisabledCount} disabled for install</span>
            <a href={selectedCollection.sourceUrl} target="_blank" rel="noopener noreferrer" className="profiles-detail__link">
              Open on Nexus Mods
              <Icon name="arrowUpRightFromSquare" />
            </a>
          </div>
          {selectedCollectionDownloadActive && selectedCollectionDownload && (
            <div className="profiles-detail__progress">
              <span className="ui-muted">
                Downloading {selectedCollectionDownload.downloadedFiles ?? selectedCollectionReadyCount}
                {' / '}{selectedCollectionDownload.totalFiles ?? selectedCollectionIncludedCount}
                {' · '}{Math.round(selectedCollectionDownload.progress)}%
              </span>
              <div
                className="profiles-detail__progress-track"
                role="progressbar"
                aria-label={`${selectedCollection.name} download progress`}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(selectedCollectionDownload.progress)}
              >
                <span style={{ width: `${Math.min(100, Math.max(0, selectedCollectionDownload.progress))}%` }} />
              </div>
            </div>
          )}
        </div>
      )}

      <div className="profiles-detail__body">
        {flow === 'apply' ? renderApplyFlow() : (
          <>
            {flow === 'update' && renderUpdateFlow()}
            {renderItemsTable()}
          </>
        )}
      </div>
    </section>
  );

  return (
    <section className="profiles-workspace workspace-panel ui-page" aria-label="Profiles workspace">
      <header className="ui-page-header">
        <div className="ui-page-header__titles">
          <h1 className="ui-page-title">Profiles</h1>
        </div>
        <div className="ui-toolbar">
          <SimmButton
            type="button"
            variant="ghost"
            onClick={() => void runAction('import', importProfile)}
            disabled={busy}
          >
            <Icon name={busyAction === 'import' ? 'spinner' : 'upload'} spin={busyAction === 'import'} />
            Import JSON
          </SimmButton>
          <SimmButton
            type="button"
            variant="secondary"
            onClick={() => void runAction('createOpen', openCreateProfile)}
            disabled={busy || flow === 'create'}
          >
            <Icon name="plus" />
            New Profile
          </SimmButton>
        </div>
      </header>

      <div className="profiles-workspace__layout">
        <aside className="profiles-list" aria-label="Profile library">
          {profilesLoading && profiles.length === 0 ? (
            <div className="profiles-list__loading" role="status" aria-label="Loading profiles">
              {[0, 1, 2, 3].map((index) => <Skeleton key={index} className="profiles-list__skeleton" />)}
            </div>
          ) : profiles.length === 0 ? (
            <div className="ui-empty">
              <span className="ui-empty__emblem" aria-hidden="true"><Icon name="layerGroup" /></span>
              <p className="ui-empty__title">No profiles yet</p>
              <p className="ui-empty__copy">Create one from an environment or import a shared JSON file.</p>
            </div>
          ) : groupedProfiles.map((group) => (
            <section key={group.key} className="profiles-list__group" aria-label={`${group.label} profiles`}>
              <h2 className="profiles-list__group-title">
                {group.label}
                <span>{group.profiles.length}</span>
              </h2>
              {group.profiles.length === 0 ? (
                <p className="profiles-list__empty">No {group.label} profiles.</p>
              ) : (
                <ul className="profiles-list__items">
                  {group.profiles.map((profile) => {
                    const active = profile.id === selectedProfileId;
                    const inUse = (profile.activeEnvironmentIds?.length ?? 0) > 0;
                    const tile = collectionArtwork(profile);
                    return (
                      <li key={profile.id}>
                        <button
                          type="button"
                          className={`profiles-workspace__profile-row${active ? ' profiles-workspace__profile-row--active' : ''}`}
                          aria-current={active ? 'true' : undefined}
                          onClick={() => {
                            setSelectedProfileId(profile.id);
                            setSelectedRuntime(runtimeKey(profile.runtime));
                            setUserChoseTarget(false);
                            if (flow === 'create') setFlow(null);
                          }}
                          disabled={busy}
                        >
                          <span className="profiles-workspace__profile-name ui-truncate" title={profile.name}>{profile.name}</span>
                          {profile.isDefault && <span className="ui-tag">Default</span>}
                          <span className="profiles-workspace__profile-meta">
                            {tile ? (
                              <ModThumbnail {...tile} name={profile.name} size={20} className="profiles-workspace__tile" />
                            ) : profile.manifest.items.length > 0 && (
                              <ThumbnailStack
                                size={20}
                                max={4}
                                items={profile.manifest.items.map((item) => ({
                                  ...itemArtwork(item),
                                  name: item.name,
                                }))}
                              />
                            )}
                            {profile.manifest.items.length} {profile.manifest.items.length === 1 ? 'item' : 'items'}
                            {inUse ? ' · In use' : ''}
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>
          ))}
        </aside>

        <div className="profiles-workspace__main">
          {error && (
            <div className="ui-callout ui-callout--danger profiles-workspace__message" role="alert">
              <Icon name="circleExclamation" />
              <span>{error}</span>
            </div>
          )}
          {notice && (
            <div className="profiles-workspace__notice" role="status">
              <Icon name="check" />
              <span>{notice}</span>
              <SimmButton type="button" variant="ghost" size="icon-sm" aria-label="Dismiss message" onClick={() => setNotice(null)}>
                <Icon name="times" />
              </SimmButton>
            </div>
          )}
          {flow === 'create'
            ? renderCreateFlow()
            : selectedProfile
              ? renderProfileDetail(selectedProfile)
              : !profilesLoading && (
                <div className="ui-empty">
                  <span className="ui-empty__emblem" aria-hidden="true"><Icon name="layerGroup" /></span>
                  <p className="ui-empty__title">Choose a profile</p>
                  <p className="ui-empty__copy">Select a profile on the left to see its items and apply it to an environment.</p>
                </div>
              )}
        </div>
      </div>

      {moreMenu && selectedProfile && (
        <AnchoredContextMenu
          id="profile-more-actions"
          x={moreMenu.x}
          y={moreMenu.y}
          items={moreMenuItems}
          onClose={() => setMoreMenu(null)}
        />
      )}
    </section>
  );
}
