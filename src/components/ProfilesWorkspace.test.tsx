import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProfilesWorkspace } from './ProfilesWorkspace';
import type { Environment, StoredModProfile } from '../types';

const storeMocks = vi.hoisted(() => ({
  useEnvironmentStore: vi.fn(),
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
}));

const dialogMocks = vi.hoisted(() => ({
  open: vi.fn(),
  save: vi.fn(),
}));

vi.mock('../stores/environmentStore', () => ({
  useEnvironmentStore: storeMocks.useEnvironmentStore,
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
    apiMocks.listModProfiles.mockResolvedValue(profiles);
    apiMocks.previewModProfileApply.mockResolvedValue(plan);
    apiMocks.applyModProfile.mockResolvedValue({
      plan,
      installed: 0,
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
    dialogMocks.save.mockResolvedValue('C:/tmp/profile.json');
  });

  afterEach(() => {
    cleanup();
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

    expect(apiMocks.applyModProfile).toHaveBeenCalledWith('profile-il2cpp', 'il2cpp-env');
    expect(screen.getByLabelText(/target environment/i)).toBeDisabled();

    resolveApply?.();
    await waitFor(() => expect(screen.getByLabelText(/target environment/i)).not.toBeDisabled());
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
