import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProfileImportWorkspace } from './ProfileImportWorkspace';

const storeMocks = vi.hoisted(() => ({
  useEnvironmentStore: vi.fn(),
}));

const apiMocks = vi.hoisted(() => ({
  previewModProfileImport: vi.fn(),
  applyModProfileImport: vi.fn(),
  readModProfileFile: vi.fn(),
}));

const dialogMocks = vi.hoisted(() => ({
  open: vi.fn(),
}));

vi.mock('../stores/environmentStore', () => ({
  useEnvironmentStore: storeMocks.useEnvironmentStore,
}));

vi.mock('../services/api', () => ({
  ApiService: apiMocks,
}));

vi.mock('@tauri-apps/plugin-dialog', () => dialogMocks);

const manifest = {
  schemaVersion: 1,
  kind: 'simm.profile',
  profile: {
    name: 'Co-op Main',
    game: 'schedule-i',
    runtime: 'Mono',
    branch: 'alternate',
    exportedAt: '2026-05-31T00:00:00Z',
  },
  items: [
    {
      itemType: 'mod',
      name: 'CustomTV',
      required: true,
      enabled: true,
      source: 'thunderstore',
      sourceId: 'CustomTV/CustomTV',
      sourceVersion: '1.6.4',
      runtime: 'Mono',
    },
  ],
};

const plan = {
  profile: manifest.profile,
  targetEnvironmentId: 'env-1',
  items: [
    {
      item: manifest.items[0],
      status: 'readyToInstall',
      resolvedStorageId: 'storage-1',
      message: 'Downloaded library entry is ready to install.',
    },
  ],
  summary: {
    total: 1,
    alreadyInstalled: 0,
    readyToInstall: 1,
    needsDownload: 0,
    manualRequired: 0,
    runtimeMismatches: 0,
    unsupported: 0,
  },
};

describe('ProfileImportWorkspace', () => {
  beforeEach(() => {
    storeMocks.useEnvironmentStore.mockReturnValue({
      environments: [
        {
          id: 'env-1',
          name: 'Mono Env',
          branch: 'alternate',
          runtime: 'Mono',
          status: 'completed',
        },
      ],
    });
    apiMocks.previewModProfileImport.mockResolvedValue(plan);
    apiMocks.applyModProfileImport.mockResolvedValue({
      plan,
      installed: 1,
      skipped: 0,
      unresolved: 0,
      messages: [],
    });
    apiMocks.readModProfileFile.mockResolvedValue(manifest);
    dialogMocks.open.mockResolvedValue('C:\\Profiles\\coop.json');
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('previews pasted profile JSON against the selected environment', async () => {
    render(<ProfileImportWorkspace />);

    fireEvent.change(screen.getByPlaceholderText(/paste a simm profile/i), {
      target: { value: JSON.stringify(manifest) },
    });
    fireEvent.click(screen.getByRole('button', { name: /preview/i }));

    await waitFor(() => {
      expect(apiMocks.previewModProfileImport).toHaveBeenCalledWith(manifest, 'env-1');
    });
    expect(await screen.findByText('CustomTV')).toBeInTheDocument();
    expect(screen.getAllByText('Ready').length).toBeGreaterThan(0);
  });

  it('applies ready profile items after preview', async () => {
    render(<ProfileImportWorkspace />);

    fireEvent.change(screen.getByPlaceholderText(/paste a simm profile/i), {
      target: { value: JSON.stringify(manifest) },
    });
    fireEvent.click(screen.getByRole('button', { name: /preview/i }));
    await screen.findByText('CustomTV');
    fireEvent.click(screen.getByRole('button', { name: /apply ready items/i }));

    await waitFor(() => {
      expect(apiMocks.applyModProfileImport).toHaveBeenCalledWith({
        manifest,
        targetEnvironmentId: 'env-1',
      });
    });
    expect(await screen.findByText('Installed 1; 0 unresolved.')).toBeInTheDocument();
  });

  it('loads and previews a selected profile JSON file', async () => {
    render(<ProfileImportWorkspace />);

    fireEvent.click(screen.getByRole('button', { name: /choose profile json/i }));

    await waitFor(() => {
      expect(dialogMocks.open).toHaveBeenCalledWith({
        multiple: false,
        filters: [{ name: 'SIMM Profile', extensions: ['json'] }],
      });
      expect(apiMocks.readModProfileFile).toHaveBeenCalledWith('C:\\Profiles\\coop.json');
      expect(apiMocks.previewModProfileImport).toHaveBeenCalledWith(manifest, 'env-1');
    });
    expect(await screen.findByText('CustomTV')).toBeInTheDocument();
  });
});
