import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProfilesWorkspace } from './ProfilesWorkspace';
import type { Environment, ModProfileSaveRequest, StoredModProfile } from '../types';

const storeMocks = vi.hoisted(() => ({
  useEnvironmentStore: vi.fn(),
  useOptionalDownloadStatusStore: vi.fn(),
}));

const apiMocks = vi.hoisted(() => ({
  listModProfiles: vi.fn(),
  previewModProfileApply: vi.fn(),
  applyModProfile: vi.fn(),
  launchGame: vi.fn(),
  exportModProfileFromLibrary: vi.fn(),
  exportEnvironmentProfile: vi.fn(),
  saveModProfileFile: vi.fn(),
  readModProfileFile: vi.fn(),
  importModProfileToLibrary: vi.fn(),
  captureModProfile: vi.fn(),
  saveModProfile: vi.fn(),
  deleteModProfile: vi.fn(),
  getNexusOAuthStatus: vi.fn(),
  getNexusModsModFiles: vi.fn(),
  beginNexusManualDownloadSession: vi.fn(),
  downloadNexusModToLibrary: vi.fn(),
  downloadThunderstoreToLibrary: vi.fn(),
  getModLibrary: vi.fn(),
  getNexusCollectionRevisionPlan: vi.fn(),
}));

const dialogMocks = vi.hoisted(() => ({
  confirm: vi.fn(),
  open: vi.fn(),
  save: vi.fn(),
}));

vi.mock('../stores/environmentStore', () => ({
  useEnvironmentStore: storeMocks.useEnvironmentStore,
}));

vi.mock('../stores/downloadStatusStore', () => ({
  useOptionalDownloadStatusStore: storeMocks.useOptionalDownloadStatusStore,
}));

vi.mock('../services/api', () => ({
  ApiService: apiMocks,
}));

vi.mock('@tauri-apps/plugin-dialog', () => dialogMocks);

const environments: Environment[] = [
  {
    id: 'il2cpp-env',
    name: 'IL2CPP Test',
    appId: '3164500',
    branch: 'alternate',
    outputDir: 'C:/Games/IL2CPP',
    status: 'completed',
    runtime: 'IL2CPP',
  },
  {
    id: 'mono-env',
    name: 'Mono Test',
    appId: '3164500',
    branch: 'alternate',
    outputDir: 'C:/Games/Mono',
    status: 'completed',
    runtime: 'Mono',
  },
];

const profiles: StoredModProfile[] = [
  {
    id: 'profile-il2cpp',
    name: 'Default IL2CPP',
    runtime: 'IL2CPP',
    isDefault: true,
    activeEnvironmentIds: ['il2cpp-env'],
    createdAt: '2026-06-18T00:00:00Z',
    updatedAt: '2026-06-18T00:00:00Z',
    manifest: {
      schemaVersion: 1,
      kind: 'simm.profile',
      profileId: 'profile-il2cpp',
      isDefault: true,
      profile: {
        name: 'Default IL2CPP',
        game: 'schedule-i',
        runtime: 'IL2CPP',
        branch: 'alternate',
        exportedAt: '2026-06-18T00:00:00Z',
      },
      items: [
        {
          itemType: 'mod',
          name: 'IL2CPP Mod',
          fileName: 'Il2CppMod.dll',
          required: true,
          enabled: true,
          runtime: 'IL2CPP',
          source: 'local',
        },
      ],
    },
  },
  {
    id: 'profile-mono',
    name: 'Default Mono',
    runtime: 'Mono',
    isDefault: true,
    activeEnvironmentIds: ['mono-env'],
    createdAt: '2026-06-18T00:00:00Z',
    updatedAt: '2026-06-18T00:00:00Z',
    manifest: {
      schemaVersion: 1,
      kind: 'simm.profile',
      profileId: 'profile-mono',
      isDefault: true,
      profile: {
        name: 'Default Mono',
        game: 'schedule-i',
        runtime: 'Mono',
        branch: 'alternate',
        exportedAt: '2026-06-18T00:00:00Z',
      },
      items: [
        {
          itemType: 'plugin',
          name: 'Mono Plugin',
          fileName: 'MonoPlugin.dll',
          required: true,
          enabled: false,
          runtime: 'Mono',
          source: 'local',
        },
      ],
    },
  },
];

const plan = {
  profile: profiles[0].manifest.profile,
  targetEnvironmentId: 'il2cpp-env',
  items: [
    {
      item: profiles[0].manifest.items[0],
      status: 'alreadyInstalled',
      resolvedStorageId: null,
      message: 'Already installed.',
    },
  ],
  removals: [],
  summary: {
    total: 1,
    alreadyInstalled: 1,
    readyToInstall: 0,
    needsDownload: 0,
    manualRequired: 0,
    runtimeMismatches: 0,
    unsupported: 0,
  },
} as const;

describe('ProfilesWorkspace', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    storeMocks.useEnvironmentStore.mockReturnValue({
      environments,
      loading: false,
      refreshEnvironments: vi.fn().mockResolvedValue(undefined),
    });
    storeMocks.useOptionalDownloadStatusStore.mockReturnValue(null);
    apiMocks.listModProfiles.mockResolvedValue(profiles);
    apiMocks.previewModProfileApply.mockResolvedValue(plan);
    apiMocks.applyModProfile.mockResolvedValue({
      plan,
      installed: 0,
      removed: 0,
      skipped: 1,
      unresolved: 0,
      messages: [],
    });
    apiMocks.launchGame.mockResolvedValue({ success: true });
    apiMocks.exportModProfileFromLibrary.mockResolvedValue(profiles[0].manifest);
    apiMocks.exportEnvironmentProfile.mockResolvedValue(profiles[1].manifest);
    apiMocks.saveModProfileFile.mockResolvedValue(undefined);
    apiMocks.saveModProfile.mockResolvedValue({
      ...profiles[1],
      id: 'created-profile',
      name: 'Custom Mono',
      isDefault: false,
    });
    apiMocks.readModProfileFile.mockResolvedValue(profiles[1].manifest);
    apiMocks.importModProfileToLibrary.mockResolvedValue(profiles[1]);
    apiMocks.deleteModProfile.mockResolvedValue(undefined);
    apiMocks.getNexusOAuthStatus.mockResolvedValue({
      connected: true,
      account: {
        isPremium: false,
        canDirectDownload: false,
        requiresSiteConfirmation: true,
      },
    });
    apiMocks.getNexusModsModFiles.mockResolvedValue([]);
    apiMocks.beginNexusManualDownloadSession.mockResolvedValue({ success: true });
    apiMocks.downloadNexusModToLibrary.mockResolvedValue({ success: true, storageId: 'downloaded-nexus-mod' });
    apiMocks.downloadThunderstoreToLibrary.mockResolvedValue({ success: true, storageId: 'downloaded-thunderstore-mod' });
    apiMocks.getModLibrary.mockResolvedValue({ downloaded: [] });
    apiMocks.getNexusCollectionRevisionPlan.mockResolvedValue({
      slug: 'example',
      revisionId: 'revision-1',
      revisionNumber: 1,
      modFiles: [],
      externalResources: [],
    });
    dialogMocks.confirm.mockResolvedValue(true);
    dialogMocks.open.mockResolvedValue('C:/tmp/import-profile.json');
    dialogMocks.save.mockResolvedValue('C:/tmp/profile.json');
  });

  afterEach(() => {
    cleanup();
  });

  it('launches after applying the available portion when a profile item is not downloaded', async () => {
    apiMocks.applyModProfile.mockResolvedValue({
      plan: {
        ...plan,
        items: [{ ...plan.items[0], status: 'needsDownload' }],
        summary: { ...plan.summary, alreadyInstalled: 0, needsDownload: 1 },
      },
      installed: 0,
      removed: 0,
      skipped: 1,
      unresolved: 0,
      messages: ['Required mod was omitted because it is not downloaded.'],
    });
    render(<ProfilesWorkspace />);
    await screen.findByRole('button', { name: /Default IL2CPP/i });
    fireEvent.click(screen.getByRole('button', { name: /Apply & Launch/i }));
    await waitFor(() => expect(apiMocks.launchGame).toHaveBeenCalledWith('il2cpp-env', 'steam'));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('reports an incomplete apply with actionable fallback text when no details are returned', async () => {
    apiMocks.applyModProfile.mockResolvedValue({
      plan,
      installed: 0,
      removed: 0,
      skipped: 0,
      unresolved: 1,
      messages: [],
    });
    render(<ProfilesWorkspace />);
    await waitFor(() => expect(screen.getByRole('button', { name: /^Apply$/i })).not.toBeDisabled());
    fireEvent.click(screen.getByRole('button', { name: /^Apply$/i }));
    expect(await screen.findByText(/Could not finish applying.*correcting the reported file operation/)).toBeTruthy();
    expect(screen.queryByText(/^Applied Default IL2CPP/)).toBeNull();
    expect(apiMocks.launchGame).not.toHaveBeenCalled();
  });

  it('renders both runtime profile groups and disables incompatible targets', async () => {
    render(<ProfilesWorkspace />);

    expect(await screen.findByRole('button', { name: /Default IL2CPP/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Default Mono/i })).toBeTruthy();
    expect(screen.getAllByText(/Default Profile/i).length).toBeGreaterThanOrEqual(2);

    const targetSelect = screen.getByLabelText(/target environment/i);
    const monoOption = within(targetSelect).getByRole('option', { name: /Mono Test/i }) as HTMLOptionElement;
    expect(monoOption.disabled).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: /Default Mono/i }));
    await waitFor(() => expect(screen.getByLabelText(/target environment/i)).toHaveValue('mono-env'));
  });

  it('initializes from the preferred environment runtime', async () => {
    render(<ProfilesWorkspace preferredEnvironmentId="mono-env" />);

    expect(await screen.findByRole('button', { name: /Default Mono/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Default IL2CPP/i })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Default Mono' })).toBeTruthy();
    expect(screen.getByLabelText(/target environment/i)).toHaveValue('mono-env');
  });

  it('selects a requested collection profile when opened from Downloads', async () => {
    const collectionProfile: StoredModProfile = {
      ...profiles[1],
      id: 'profile-collection',
      name: 'Example Collection (Revision 1)',
      isDefault: false,
      manifest: {
        ...profiles[1].manifest,
        profile: { ...profiles[1].manifest.profile, name: 'Example Collection (Revision 1)' },
        collection: {
          slug: 'example',
          name: 'Example Collection',
          revisionNumber: 1,
          sourceUrl: 'https://next.nexusmods.com/schedule1/collections/example',
          items: [{
            key: 'item-1',
            nexusModId: 42,
            nexusFileId: '100',
            requestedName: 'Example Mod',
            requestedAuthor: 'Example Author',
            requestedVersion: '1.0.0',
            optional: false,
            selected: true,
            sourceChoice: 'nexusmods',
            status: 'manualRequired',
            statusMessage: 'Exact Nexus file 100 must be downloaded from Nexus.',
          }],
        },
        items: [{
          itemType: 'mod',
          name: 'Example Mod',
          required: true,
          enabled: true,
          source: 'nexusmods',
          sourceId: '42',
          sourceVersion: '1.0.0',
          nexusFileId: '100',
        }],
      },
    };
    apiMocks.listModProfiles.mockResolvedValue([...profiles, collectionProfile]);
    storeMocks.useOptionalDownloadStatusStore.mockReturnValue({
      downloads: [{
        id: 'collection:example:1',
        kind: 'collection',
        label: 'Example Collection',
        contextLabel: 'Revision 1 collection profile',
        status: 'downloading',
        progress: 35,
        downloadedFiles: 0,
        totalFiles: 1,
        startedAt: Date.now(),
        profileId: 'profile-collection',
        persistent: true,
      }],
    });

    render(
      <ProfilesWorkspace
        initialProfileId="profile-collection"
        preferredEnvironmentId="il2cpp-env"
      />,
    );

    expect(await screen.findByRole('heading', { name: 'Example Collection (Revision 1)' })).toBeTruthy();
    expect(screen.getByText(/0 \/ 1 ready/i)).toBeTruthy();
    expect(screen.getByText(/Downloading 0 \/ 1 · 35%/i)).toBeTruthy();
    expect(screen.getByRole('progressbar', { name: 'Example Collection download progress' })).toHaveAttribute('aria-valuenow', '35');
    expect(screen.queryByRole('switch', { name: 'Install Example Mod with this profile' })).toBeNull();
    const openNexus = await screen.findByRole('button', { name: /Open Nexus/i });
    fireEvent.click(openNexus);

    await waitFor(() => {
      expect(apiMocks.beginNexusManualDownloadSession).toHaveBeenCalledWith({
        kind: 'library',
        modId: 42,
        fileId: 100,
        gameId: 'schedule1',
        runtime: 'Mono',
      });
    });

  });

  it('keeps downloaded collection mods while allowing their profile installation to be disabled', async () => {
    let collectionProfile: StoredModProfile = {
      ...profiles[1],
      id: 'profile-ready-collection',
      name: 'Ready Collection (Revision 1, Mono)',
      isDefault: false,
      activeEnvironmentIds: [],
      manifest: {
        ...profiles[1].manifest,
        profileId: 'profile-ready-collection',
        profile: {
          ...profiles[1].manifest.profile,
          name: 'Ready Collection (Revision 1, Mono)',
          runtime: 'Mono',
        },
        collection: {
          slug: 'ready-example',
          name: 'Ready Collection',
          revisionNumber: 1,
          sourceUrl: 'https://next.nexusmods.com/schedule1/collections/ready-example',
          items: [{
            key: 'ready-item-1',
            nexusModId: 42,
            nexusFileId: '100',
            requestedName: 'Example Mod',
            requestedAuthor: 'Example Author',
            requestedVersion: '1.0.0',
            optional: false,
            selected: true,
            sourceChoice: 'nexusmods',
            status: 'ready',
            statusMessage: 'Exact Nexus version is available in the shared library.',
          }],
        },
        items: [{
          itemType: 'mod',
          name: 'Example Mod',
          required: true,
          enabled: true,
          runtime: 'Mono',
          source: 'nexusmods',
          sourceId: '42',
          sourceVersion: '1.0.0',
          nexusFileId: '100',
          storageId: 'example-mod-1-0-0-file-100',
        }],
      },
    };
    apiMocks.listModProfiles.mockImplementation(async () => [...profiles, collectionProfile]);
    apiMocks.saveModProfile.mockImplementation(async (request: ModProfileSaveRequest) => {
      collectionProfile = {
        ...collectionProfile,
        id: request.profileId ?? collectionProfile.id,
        name: request.name,
        runtime: request.runtime,
        manifest: request.manifest,
      };
      return collectionProfile;
    });

    render(
      <ProfilesWorkspace
        initialProfileId="profile-ready-collection"
        preferredEnvironmentId="mono-env"
      />,
    );

    await screen.findByRole('heading', { name: 'Ready Collection (Revision 1, Mono)' });
    const installSwitch = await screen.findByRole('switch', {
      name: 'Install Example Mod with this profile',
    });
    expect(installSwitch).toHaveAttribute('aria-checked', 'true');

    fireEvent.click(installSwitch);

    await waitFor(() => {
      const saveCalls = apiMocks.saveModProfile.mock.calls;
      const savedRequest = saveCalls[saveCalls.length - 1]?.[0] as ModProfileSaveRequest | undefined;
      expect(savedRequest?.manifest.items[0].enabled).toBe(false);
      expect(savedRequest?.manifest.collection?.items[0]).toMatchObject({
        selected: true,
        status: 'ready',
      });
    });
    await waitFor(() => {
      expect(installSwitch).toHaveAttribute('aria-checked', 'false');
      expect(screen.getByText(/1 disabled for install/i)).toBeTruthy();
      expect(screen.getByText(/will remain downloaded but will be removed or omitted/i)).toBeTruthy();
    });

    fireEvent.click(installSwitch);

    await waitFor(() => {
      const saveCalls = apiMocks.saveModProfile.mock.calls;
      const savedRequest = saveCalls[saveCalls.length - 1]?.[0] as ModProfileSaveRequest | undefined;
      expect(savedRequest?.manifest.items[0].enabled).toBe(true);
      expect(installSwitch).toHaveAttribute('aria-checked', 'true');
      expect(screen.getByText(/0 disabled for install/i)).toBeTruthy();
    });
  });

  it('downloads an exact Nexus collection file in-app for premium users and attaches it to the profile', async () => {
    const collectionProfile: StoredModProfile = {
      ...profiles[1],
      id: 'profile-premium-collection',
      name: 'Premium Collection (Revision 2, Mono)',
      isDefault: false,
      activeEnvironmentIds: [],
      manifest: {
        ...profiles[1].manifest,
        profileId: 'profile-premium-collection',
        profile: {
          ...profiles[1].manifest.profile,
          name: 'Premium Collection (Revision 2, Mono)',
          runtime: 'Mono',
        },
        collection: {
          slug: 'premium-example',
          name: 'Premium Collection',
          revisionNumber: 2,
          sourceUrl: 'https://next.nexusmods.com/schedule1/collections/premium-example',
          items: [{
            key: 'premium-item-1',
            nexusModId: 42,
            nexusFileId: '100',
            requestedName: 'Example Mod',
            requestedAuthor: 'Example Author',
            requestedVersion: '1.0.0',
            optional: false,
            selected: true,
            sourceChoice: 'nexusmods',
            status: 'manualRequired',
            statusMessage: 'Exact Nexus file 100 is still required.',
          }],
        },
        items: [{
          itemType: 'mod',
          name: 'Example Mod',
          required: true,
          enabled: true,
          runtime: 'Mono',
          source: 'nexusmods',
          sourceId: '42',
          sourceVersion: '1.0.0',
          nexusFileId: '100',
        }],
      },
    };
    apiMocks.listModProfiles.mockResolvedValue([...profiles, collectionProfile]);
    apiMocks.getNexusOAuthStatus.mockResolvedValue({
      connected: true,
      account: {
        isPremium: true,
        canDirectDownload: false,
        requiresSiteConfirmation: true,
      },
    });
    apiMocks.downloadNexusModToLibrary.mockResolvedValue({
      success: true,
      storageId: 'example-mod-1-0-0-file-100',
    });
    apiMocks.getModLibrary.mockResolvedValue({
      downloaded: [{
        storageId: 'example-mod-1-0-0-file-100',
        displayName: 'Example Mod',
        files: ['ExampleMod.dll'],
        attachedUserLibs: [],
        source: 'nexusmods',
        sourceId: '42',
        nexusFileId: '100',
        sourceVersion: '1.0.0',
        sourceUrl: 'https://www.nexusmods.com/schedule1/mods/42',
        author: 'Example Author',
        managed: true,
        installedIn: [],
        availableRuntimes: ['Mono'],
        storageIdsByRuntime: { Mono: 'example-mod-1-0-0-file-100' },
        installedInByRuntime: { Mono: [] },
        filesByRuntime: { Mono: ['ExampleMod.dll'] },
      }],
    });
    apiMocks.getNexusCollectionRevisionPlan.mockResolvedValue({
      slug: 'premium-example',
      revisionId: 'revision-2',
      revisionNumber: 2,
      modFiles: [{
        collectionRevisionModId: 'premium-item-1',
        modId: 42,
        fileId: 100,
        modName: 'Example Mod',
        author: 'Example Author',
        fileName: 'ExampleMod.zip',
        version: '1.0.0',
        optional: false,
        sizeInBytes: 2048,
        available: true,
      }],
      externalResources: [],
    });
    apiMocks.saveModProfile.mockImplementation(async (request: ModProfileSaveRequest) => ({
      ...collectionProfile,
      id: request.profileId ?? collectionProfile.id,
      name: request.name,
      runtime: request.runtime,
      manifest: request.manifest,
    }));

    render(
      <ProfilesWorkspace
        initialProfileId="profile-premium-collection"
        preferredEnvironmentId="mono-env"
      />,
    );

    expect(await screen.findByText('Download available')).toBeTruthy();
    expect(screen.getByText('2 KB · Nexus')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /^Download$/i }));

    await waitFor(() => {
      expect(apiMocks.downloadNexusModToLibrary).toHaveBeenCalledWith(42, 100, 'Mono');
    });
    await waitFor(() => {
      expect(apiMocks.saveModProfile.mock.calls.some((call) => {
        const request = call[0] as ModProfileSaveRequest;
        return request.manifest.collection?.items.some((item) =>
          item.key === 'premium-item-1' && item.status === 'ready'
        ) && request.manifest.items.some((item) =>
          item.nexusFileId === '100' && item.storageId === 'example-mod-1-0-0-file-100'
        );
      })).toBe(true);
    });
    expect(apiMocks.beginNexusManualDownloadSession).not.toHaveBeenCalled();
  });

  it('repairs a Mono collection item with the exact-version Mono Nexus file', async () => {
    const collectionProfile: StoredModProfile = {
      ...profiles[1],
      id: 'profile-runtime-collection',
      name: 'Runtime Collection (Revision 3, Mono)',
      isDefault: false,
      activeEnvironmentIds: [],
      manifest: {
        ...profiles[1].manifest,
        profileId: 'profile-runtime-collection',
        profile: {
          ...profiles[1].manifest.profile,
          name: 'Runtime Collection (Revision 3, Mono)',
          runtime: 'Mono',
        },
        collection: {
          slug: 'runtime-example',
          name: 'Runtime Collection',
          revisionNumber: 3,
          sourceUrl: 'https://next.nexusmods.com/schedule1/collections/runtime-example',
          items: [{
            key: 'runtime-item-1',
            nexusModId: 42,
            nexusFileId: '7588',
            requestedName: 'Better Counter-Offer UI',
            requestedAuthor: 'Example Author',
            requestedVersion: '3.4.1',
            optional: false,
            selected: true,
            sourceChoice: 'nexusmods',
            status: 'manualRequired',
            statusMessage: 'Exact Nexus file 7588 is still required.',
          }],
        },
        items: [{
          itemType: 'mod',
          name: 'Better Counter-Offer UI',
          fileName: 'Better Counter-Offer UI IL2CPP.zip',
          required: true,
          enabled: true,
          runtime: 'Mono',
          source: 'nexusmods',
          sourceId: '42',
          sourceVersion: '3.4.1',
          nexusFileId: '7588',
        }],
      },
    };
    let savedProfile = collectionProfile;
    let library = { downloaded: [] as Array<{
      storageId: string;
      displayName: string;
      files: string[];
      attachedUserLibs: string[];
      source: 'nexusmods';
      sourceId: string;
      nexusFileId: string;
      sourceVersion: string;
      sourceUrl: string;
      author: string;
      managed: boolean;
      installedIn: string[];
      availableRuntimes: ['Mono'];
      storageIdsByRuntime: { Mono: string };
      installedInByRuntime: { Mono: string[] };
      filesByRuntime: { Mono: string[] };
    }> };
    apiMocks.listModProfiles.mockResolvedValue([...profiles, collectionProfile]);
    apiMocks.getNexusOAuthStatus.mockResolvedValue({
      connected: true,
      account: { isPremium: true, canDirectDownload: true, requiresSiteConfirmation: false },
    });
    apiMocks.getNexusCollectionRevisionPlan.mockResolvedValue({
      slug: 'runtime-example',
      revisionId: 'revision-3',
      revisionNumber: 3,
      modFiles: [{
        collectionRevisionModId: 'runtime-item-1',
        modId: 42,
        fileId: 7588,
        modName: 'Better Counter-Offer UI',
        author: 'Example Author',
        fileName: 'Better Counter-Offer UI IL2CPP.zip',
        version: '3.4.1',
        optional: false,
        available: true,
      }],
      externalResources: [],
    });
    apiMocks.getNexusModsModFiles.mockResolvedValue([
      {
        file_id: 7588,
        name: 'Better Counter-Offer UI IL2CPP',
        version: '3.4.1',
        category_id: 1,
        category_name: 'MAIN',
        is_primary: true,
        size: 2048,
        file_name: 'Better Counter-Offer UI IL2CPP.zip',
        uploaded_timestamp: 10,
        mod_version: '3.4.1',
      },
      {
        file_id: 7589,
        name: 'Better Counter-Offer UI Mono',
        version: '3.4.1',
        category_id: 1,
        category_name: 'MAIN',
        is_primary: false,
        size: 2048,
        file_name: 'Better Counter-Offer UI Mono.zip',
        uploaded_timestamp: 11,
        mod_version: '3.4.1',
      },
      {
        file_id: 7590,
        name: 'Better Counter-Offer UI Mono',
        version: '3.5.0',
        category_id: 1,
        category_name: 'MAIN',
        is_primary: true,
        size: 2048,
        file_name: 'Better Counter-Offer UI Mono 3.5.0.zip',
        uploaded_timestamp: 12,
        mod_version: '3.5.0',
      },
    ]);
    apiMocks.getModLibrary.mockImplementation(async () => library);
    apiMocks.downloadNexusModToLibrary.mockImplementation(async (_modId, fileId) => {
      expect(fileId).toBe(7589);
      library = {
        downloaded: [{
          storageId: 'counter-offer-mono-3-4-1',
          displayName: 'Better Counter-Offer UI',
          files: ['BetterCounterOfferUI.dll'],
          attachedUserLibs: [],
          source: 'nexusmods',
          sourceId: '42',
          nexusFileId: '7589',
          sourceVersion: '3.4.1',
          sourceUrl: 'https://www.nexusmods.com/schedule1/mods/42',
          author: 'Example Author',
          managed: true,
          installedIn: [],
          availableRuntimes: ['Mono'],
          storageIdsByRuntime: { Mono: 'counter-offer-mono-3-4-1' },
          installedInByRuntime: { Mono: [] },
          filesByRuntime: { Mono: ['BetterCounterOfferUI.dll'] },
        }],
      };
      return { success: true, storageId: 'counter-offer-mono-3-4-1' };
    });
    apiMocks.saveModProfile.mockImplementation(async (request: ModProfileSaveRequest) => {
      savedProfile = {
        ...savedProfile,
        name: request.name,
        runtime: request.runtime,
        manifest: request.manifest,
      };
      return savedProfile;
    });

    render(
      <ProfilesWorkspace
        initialProfileId="profile-runtime-collection"
        preferredEnvironmentId="mono-env"
      />,
    );

    fireEvent.click(await screen.findByRole('button', { name: /^Download$/i }));

    await waitFor(() => {
      expect(apiMocks.downloadNexusModToLibrary).toHaveBeenCalledWith(42, 7589, 'Mono');
    });
    await waitFor(() => {
      expect(apiMocks.saveModProfile.mock.calls.some(([request]) =>
        request.manifest.collection?.items.some((item: {
          key: string;
          collectionFileId?: string | null;
          nexusFileId: string;
          status: string;
        }) =>
          item.key === 'runtime-item-1'
          && item.collectionFileId === '7588'
          && item.nexusFileId === '7589'
          && item.status === 'ready'
        )
        && request.manifest.items.some((item: {
          nexusFileId?: string | null;
          storageId?: string | null;
        }) =>
          item.nexusFileId === '7589'
          && item.storageId === 'counter-offer-mono-3-4-1'
        )
      )).toBe(true);
    });
    expect(apiMocks.downloadNexusModToLibrary).not.toHaveBeenCalledWith(42, 7590, 'Mono');
  });

  it('allows selecting another profile after consuming an initially requested profile', async () => {
    const collectionProfile: StoredModProfile = {
      ...profiles[1],
      id: 'profile-collection',
      name: 'Example Collection (Revision 1)',
      isDefault: false,
      manifest: {
        ...profiles[1].manifest,
        profile: {
          ...profiles[1].manifest.profile,
          name: 'Example Collection (Revision 1)',
        },
      },
    };
    apiMocks.listModProfiles.mockResolvedValue([...profiles, collectionProfile]);

    render(
      <ProfilesWorkspace
        initialProfileId="profile-collection"
        preferredEnvironmentId="il2cpp-env"
      />,
    );

    expect(await screen.findByRole('heading', { name: 'Example Collection (Revision 1)' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Default Mono/i }));

    expect(await screen.findByRole('heading', { name: 'Default Mono' })).toBeTruthy();
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Default Mono/i })).toHaveClass(
        'profiles-workspace__profile-row--active',
      );
    });
  });

  it('uses the supported Tauri confirmation before deleting a custom profile', async () => {
    const customProfile: StoredModProfile = {
      ...profiles[1],
      id: 'profile-custom',
      name: 'Custom Mono Profile',
      isDefault: false,
      activeEnvironmentIds: [],
      manifest: {
        ...profiles[1].manifest,
        profile: {
          ...profiles[1].manifest.profile,
          name: 'Custom Mono Profile',
        },
      },
    };
    apiMocks.listModProfiles.mockResolvedValue([...profiles, customProfile]);

    render(<ProfilesWorkspace initialProfileId="profile-custom" />);

    expect(await screen.findByRole('heading', { name: 'Custom Mono Profile' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));

    await waitFor(() => {
      expect(dialogMocks.confirm).toHaveBeenCalledWith(
        'Delete Custom Mono Profile?',
        { title: 'Delete profile', kind: 'warning' },
      );
      expect(apiMocks.deleteModProfile).toHaveBeenCalledWith('profile-custom');
    });
  });

  it('does not label un-previewed default profile items as unsupported', async () => {
    render(<ProfilesWorkspace />);

    await screen.findByRole('button', { name: /Default IL2CPP/i });

    expect(screen.getByText('Tracked')).toBeTruthy();
    expect(screen.queryByText('Unsupported')).toBeNull();
  });

  it('lists environments currently using the selected profile in the header', async () => {
    render(<ProfilesWorkspace />);

    await screen.findByRole('button', { name: /Default IL2CPP/i });

    expect(screen.getByText('Used by')).toBeTruthy();
    expect(screen.getByText('IL2CPP Test')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /Default Mono/i }));

    await waitFor(() => expect(screen.getByText('Mono Test')).toBeTruthy());
  });

  it('exports full-state JSON when disabled items are included', async () => {
    render(<ProfilesWorkspace />);

    await screen.findByRole('button', { name: /Default IL2CPP/i });
    fireEvent.click(screen.getByRole('checkbox', { name: /include disabled items/i }));
    fireEvent.click(screen.getByRole('button', { name: /Export JSON/i }));

    await waitFor(() => {
      expect(apiMocks.exportModProfileFromLibrary).toHaveBeenCalledWith({
        profileId: 'profile-il2cpp',
        includeDisabled: true,
      });
    });
    expect(apiMocks.saveModProfileFile).toHaveBeenCalledWith(profiles[0].manifest, 'C:/tmp/profile.json');
  });

  it('keeps profile import visible in the library without crowding the apply toolbar', async () => {
    render(<ProfilesWorkspace />);

    const library = screen.getByRole('complementary', { name: /profile library/i });
    const toolbar = document.querySelector('.profiles-workspace__toolbar');
    const importButton = within(library).getByRole('button', { name: /Import JSON/i });

    expect(toolbar).not.toContainElement(importButton);
    fireEvent.click(importButton);

    await waitFor(() => {
      expect(dialogMocks.open).toHaveBeenCalledWith({
        title: 'Choose SIMM profile JSON',
        multiple: false,
        filters: [{ name: 'SIMM profile', extensions: ['json'] }],
      });
    });
    expect(apiMocks.readModProfileFile).toHaveBeenCalledWith('C:/tmp/import-profile.json');
    expect(apiMocks.importModProfileToLibrary).toHaveBeenCalledWith(profiles[1].manifest);
    expect(await screen.findByText('Imported Default Mono.')).toBeTruthy();
  });

  it('applies a profile before launching the selected environment', async () => {
    render(<ProfilesWorkspace />);

    await screen.findByRole('button', { name: /Default IL2CPP/i });
    fireEvent.click(screen.getByRole('button', { name: /Apply & Launch/i }));

    await waitFor(() => {
      expect(apiMocks.applyModProfile).toHaveBeenCalledWith('profile-il2cpp', 'il2cpp-env');
    });
    await waitFor(() => {
      expect(apiMocks.launchGame).toHaveBeenCalledWith('il2cpp-env', 'steam');
    });
  });

  it('freezes the target selector while a profile apply is in flight', async () => {
    let resolveApply: (() => void) | undefined;
    apiMocks.applyModProfile.mockImplementationOnce(() => new Promise((resolve) => {
      resolveApply = () => resolve({
        plan,
        installed: 0,
        skipped: 1,
        unresolved: 0,
        messages: [],
      });
    }));

    render(<ProfilesWorkspace />);
    await screen.findByRole('button', { name: /Default IL2CPP/i });
    fireEvent.click(screen.getByRole('button', { name: /^Apply$/i }));

    await waitFor(() => {
      expect(apiMocks.applyModProfile).toHaveBeenCalledWith('profile-il2cpp', 'il2cpp-env');
    });
    expect(screen.getByLabelText(/target environment/i)).toBeDisabled();

    resolveApply?.();
    await waitFor(() => expect(screen.getByLabelText(/target environment/i)).not.toBeDisabled());
  });

  it('previews removals, identifies permanent loss, and requires confirmation before applying', async () => {
    apiMocks.previewModProfileApply.mockResolvedValue({
      ...plan,
      removals: [
        {
          item: {
            itemType: 'mod',
            name: 'Local Only Mod',
            fileName: 'LocalOnly.dll',
            required: true,
            enabled: true,
            runtime: 'IL2CPP',
            source: 'local',
          },
          recoverable: false,
          message: 'Will be permanently removed from this environment because SIMM has no library copy to restore.',
        },
      ],
    });
    dialogMocks.confirm.mockResolvedValueOnce(false);

    render(<ProfilesWorkspace />);
    await screen.findByRole('button', { name: /Default IL2CPP/i });
    fireEvent.click(screen.getByRole('button', { name: /^Apply$/i }));

    await waitFor(() => expect(dialogMocks.confirm).toHaveBeenCalled());
    const [warning, options] = dialogMocks.confirm.mock.calls[0];
    expect(warning).toContain('Local Only Mod');
    expect(warning).toContain('permanently deleted');
    expect(options).toEqual({ title: 'Profile switch will delete files', kind: 'warning' });
    expect(apiMocks.applyModProfile).not.toHaveBeenCalled();
    const inspector = screen.getByRole('complementary', { name: /selected profile/i });
    expect(within(inspector).getByText('Environment changes')).toBeTruthy();
    expect(within(inspector).getByText(/1 removed.*1 permanent/)).toBeTruthy();
    expect(screen.getByRole('table', { name: /profile items/i })).toHaveTextContent('IL2CPP Mod');
  });

  it('creates a new profile from selected target items', async () => {
    apiMocks.exportEnvironmentProfile.mockResolvedValue({
      ...profiles[1].manifest,
      profile: {
        ...profiles[1].manifest.profile,
        name: 'Mono Test Profile',
        environmentId: 'mono-env',
      },
      items: [
        profiles[1].manifest.items[0],
        {
          itemType: 'plugin',
          name: 'Mono Extra',
          fileName: 'MonoExtra.dll',
          required: false,
          enabled: true,
          runtime: 'Mono',
          source: 'local',
        },
      ],
    });

    render(<ProfilesWorkspace preferredEnvironmentId="mono-env" />);

    await screen.findByRole('button', { name: /Default Mono/i });
    await waitFor(() => {
      expect(screen.getByLabelText(/target environment/i)).toHaveValue('mono-env');
    });
    fireEvent.click(screen.getByRole('button', { name: /^Create Profile$/i }));
    await screen.findByRole('checkbox', { name: /Mono Extra/i });
    expect(apiMocks.exportEnvironmentProfile).toHaveBeenCalledWith('mono-env');
    fireEvent.change(screen.getByPlaceholderText('New profile name'), {
      target: { value: 'Custom Mono' },
    });

    const extraItem = screen.getByRole('checkbox', { name: /Mono Extra/i });
    fireEvent.click(extraItem);
    fireEvent.click(screen.getByRole('button', { name: /Create Selected Profile/i }));

    await waitFor(() => {
      expect(apiMocks.saveModProfile).toHaveBeenCalledWith(expect.objectContaining({
        name: 'Custom Mono',
        runtime: 'Mono',
        manifest: expect.objectContaining({
          isDefault: false,
          items: [
            expect.objectContaining({ name: 'Mono Plugin' }),
          ],
        }),
      }));
    });
  });

  it('shows string backend errors when profile loading fails', async () => {
    apiMocks.listModProfiles.mockRejectedValueOnce('Failed to parse stored profile default-mono');

    render(<ProfilesWorkspace />);

    expect(await screen.findByRole('alert')).toHaveTextContent('Failed to parse stored profile default-mono');
  });
});
