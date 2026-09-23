import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { confirm, open, save } from '@tauri-apps/plugin-dialog';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
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
  ModProfileImportPlanItem,
  ModProfileManifest,
  ModProfileCollectionItem,
  ModProfileItem,
  NexusCollectionModFile,
  Runtime,
  StoredModProfile,
} from '../types';
import { Icon } from './Icon';
import { SimmButton } from './primitives';
import { WorkspacePageHeader } from './WorkspacePageHeader';

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

function planItemStatusClass(item: ModProfileImportPlanItem): string {
  return item.status.replace(/[A-Z]/g, (match) => `-${match.toLowerCase()}`);
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
  return source === 'thunderstore' ? 'Thunderstore' : 'Nexus';
}

export function ProfilesWorkspace({ preferredEnvironmentId, initialProfileId }: ProfilesWorkspaceProps) {
  const { environments, loading: environmentsLoading, refreshEnvironments } = useEnvironmentStore();
  const downloadStatusStore = useOptionalDownloadStatusStore();
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
  const [nexusDownloadAccess, setNexusDownloadAccess] = useState<NexusDownloadAccess | null>(null);
  const [collectionFileSizes, setCollectionFileSizes] = useState<Record<string, number>>({});
  const profilesLoadGenerationRef = useRef(0);
  const targetSelectionGenerationRef = useRef(0);
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
  }, [refreshNexusDownloadAccess, saveCollectionProfile, selectedProfile, setCollectionItemStatus]);

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
  }, []);

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
    const confirmed = await confirm(
      `Delete ${selectedProfile.name}?`,
      { title: 'Delete profile', kind: 'warning' },
    );
    if (!confirmed) return null;
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
      />

      {error && <div className="profiles-workspace__alert profiles-workspace__alert--error" role="alert">{error}</div>}
      {notice && <div className="profiles-workspace__alert profiles-workspace__alert--success" role="status">{notice}</div>}

      <div className="profiles-workspace__layout">
        <aside className="profiles-workspace__rail" aria-label="Profile library">
          <div className="profiles-workspace__library-header">
            <span className="workspace-eyebrow">Profile Library</span>
            <small>IL2CPP and Mono</small>
          </div>
          <div className="profiles-workspace__library-actions">
            <SimmButton
              type="button"
              variant="secondary"
              className="btn btn-secondary"
              onClick={() => void runAction('import', importProfile)}
              disabled={busyAction !== null}
            >
              <Icon name={busyAction === 'import' ? 'spinner' : 'upload'} />
              Import JSON
            </SimmButton>
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

          {selectedCollection && (
            <div className="profiles-workspace__collection-summary" aria-label="Collection profile status">
              <div>
                <span className="workspace-eyebrow">Nexus collection</span>
                <strong>{selectedCollection.name} · Revision {selectedCollection.revisionNumber}</strong>
                <small>
                  {selectedCollectionReadyCount} / {selectedCollectionIncludedCount} ready
                  {' · '}{selectedCollectionDisabledCount} disabled for install · Exact versions retained.
                </small>
                {selectedCollectionDownloadActive && selectedCollectionDownload && (
                  <div className="profiles-workspace__collection-progress">
                    <small>
                      Downloading {selectedCollectionDownload.downloadedFiles ?? selectedCollectionReadyCount}
                      {' / '}{selectedCollectionDownload.totalFiles ?? selectedCollectionIncludedCount}
                      {' · '}{Math.round(selectedCollectionDownload.progress)}%
                    </small>
                    <div
                      className="profiles-workspace__collection-progress-track"
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
              <a href={selectedCollection.sourceUrl} target="_blank" rel="noopener noreferrer" className="btn btn-secondary">
                <Icon name="arrowUpRightFromSquare" />
                Open collection
              </a>
            </div>
          )}

          {plan && (
            <div className="profiles-workspace__summary" aria-label="Apply preview summary">
              <span>Total <strong>{plan.summary.total}</strong></span>
              <span>Ready <strong>{plan.summary.readyToInstall}</strong></span>
              <span>Installed <strong>{plan.summary.alreadyInstalled}</strong></span>
              <span>Unavailable <strong>{unavailableProfileItemCount(plan)}</strong></span>
              <span>Remove <strong>{plan.removals.length}</strong></span>
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
              {selectedProfile ? planRows.map((row, index) => {
                const collectionItem = selectedCollectionItems.find((item) => collectionProfileItemMatches(item, row.item));
                const collectionActionBusy = collectionItem ? busyAction === `collection-${collectionItem.key}` : false;
                const collectionEnableBusy = collectionItem ? busyAction === `collection-enable-${collectionItem.key}` : false;
                const isNexusCollectionItem = collectionItem?.sourceChoice === 'nexusmods';
                const nexusAccessChecking = Boolean(isNexusCollectionItem && nexusDownloadAccess === null);
                const canDownloadNexusDirectly = Boolean(isNexusCollectionItem && nexusDownloadAccess?.canDirectDownload);
                const nexusLoginRequired = Boolean(isNexusCollectionItem && nexusDownloadAccess && !nexusDownloadAccess.connected);
                const collectionReady = collectionItem?.status === 'ready';
                const collectionSource = collectionItem
                  ? collectionSourceLabel(collectionItem, row.item)
                  : null;
                const collectionSize = collectionItem
                  ? formatFileSize(
                    collectionItem.requestedSizeInBytes
                      ?? collectionFileSizes[collectionItem.nexusFileId],
                  )
                  : null;
                const collectionStateLabel = collectionItem
                  ? collectionReady
                    ? 'Ready'
                    : collectionItem.status === 'downloading'
                      ? 'Downloading'
                      : !collectionItem.selected
                        ? 'Not selected'
                        : nexusLoginRequired
                          ? 'Login required'
                          : 'Download available'
                  : null;
                const collectionMeta = collectionItem
                  ? [collectionSize, collectionSource].filter(Boolean).join(' · ')
                  : null;
                return (
                  <div
                    key={`${itemIdentity(row.item)}-${index}`}
                    className={`profiles-workspace__table-row profiles-workspace__table-row--${collectionItem?.status ?? (hasPreviewPlan ? planItemStatusClass(row) : 'tracked')}`}
                    role="row"
                  >
                    <span>
                      <strong>{row.item.name}</strong>
                      <small>{collectionItem
                        ? `${collectionItem.requestedVersion} · Nexus file ${collectionItem.nexusFileId}${collectionItem.requestedAuthor ? ` · ${collectionItem.requestedAuthor}` : ''}`
                        : row.item.fileName ?? row.item.sourceId ?? row.item.storageId ?? 'No file identity'}</small>
                    </span>
                    <span>
                      <strong>{itemTypeLabel(row.item)}</strong>
                      {!collectionItem && <small>{row.item.source ?? 'local'}</small>}
                    </span>
                    <span title={collectionItem?.statusMessage ?? row.message}>
                      <strong className={collectionItem
                        ? `profiles-workspace__collection-state profiles-workspace__collection-state--${collectionReady ? 'ready' : 'not-ready'}`
                        : undefined}
                      >
                        {collectionItem && <Icon name={collectionReady ? 'check' : 'times'} />}
                        {collectionItem
                          ? collectionStateLabel
                          : row.item.enabled === false ? 'Disabled' : 'Enabled'}
                      </strong>
                      <small>{collectionMeta ?? (hasPreviewPlan ? (statusLabels[row.status] ?? row.status) : 'Tracked')}</small>
                      {collectionItem && collectionItem.selected && collectionReady && (
                        <div
                          className="profiles-workspace__collection-install-toggle"
                          title="Choose whether this downloaded mod is installed when the profile is applied."
                        >
                          <Switch
                            size="sm"
                            checked={row.item.enabled !== false}
                            disabled={busyAction !== null}
                            aria-label={`Install ${collectionItem.requestedName} with this profile`}
                            onCheckedChange={(checked) => void runAction(
                              `collection-enable-${collectionItem.key}`,
                              () => setCollectionProfileItemEnabled(collectionItem, Boolean(checked)),
                            )}
                          />
                          <span>{collectionEnableBusy ? 'Saving…' : row.item.enabled === false ? 'Disabled' : 'Install'}</span>
                        </div>
                      )}
                      {collectionItem && collectionItem.selected && collectionItem.status !== 'ready' && (
                        <SimmButton
                          type="button"
                          size="sm"
                          variant="secondary"
                          disabled={busyAction !== null || nexusAccessChecking || nexusLoginRequired}
                          title={nexusLoginRequired ? 'Sign in to Nexus Mods from Accounts first.' : undefined}
                          onClick={() => void runAction(`collection-${collectionItem.key}`, () => downloadCollectionProfileItem(collectionItem))}
                        >
                          <Icon name={collectionActionBusy || nexusAccessChecking ? 'spinner' : isNexusCollectionItem && !canDownloadNexusDirectly ? 'arrowUpRightFromSquare' : 'download'} />
                          {collectionActionBusy
                            ? 'Downloading…'
                            : nexusAccessChecking
                              ? 'Checking Nexus…'
                              : isNexusCollectionItem && !canDownloadNexusDirectly
                                ? nexusLoginRequired ? 'Sign in required' : 'Open Nexus'
                                : collectionItem.runtimeMismatch
                                  ? 'Download anyway'
                                  : collectionItem.status === 'error'
                                    ? 'Retry'
                                    : 'Download'}
                        </SimmButton>
                      )}
                    </span>
                  </div>
                );
              }) : (
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

          {plan && plan.removals.length > 0 && (
            <details className="profiles-workspace__removals">
              <summary>
                <span>
                  <strong>Environment changes</strong>
                  <small>
                    {plan.removals.length} removed
                    {plan.removals.some((removal) => !removal.recoverable)
                      ? ` · ${plan.removals.filter((removal) => !removal.recoverable).length} permanent`
                      : ' · library copies retained'}
                  </small>
                </span>
              </summary>
              <div className="profiles-workspace__removal-list">
                {plan.removals.map((removal, index) => (
                  <div key={`${profileItemKey(removal.item, index)}-removal`} title={removal.message}>
                    <strong>{removal.item.name}</strong>
                    <small>{removal.recoverable ? 'Library copy retained' : 'Permanent removal'}</small>
                  </div>
                ))}
              </div>
            </details>
          )}

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
