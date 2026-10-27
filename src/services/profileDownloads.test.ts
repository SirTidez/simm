import { beforeEach, describe, expect, it, vi } from 'vitest';
import { downloadProfileItem } from './profileDownloads';
import type { ModProfileItem } from '../types';

const api = vi.hoisted(() => ({ searchThunderstore: vi.fn(), downloadThunderstoreToLibrary: vi.fn(),
  getNexusModsModFiles: vi.fn(), getNexusOAuthStatus: vi.fn(), beginNexusManualDownloadSession: vi.fn(), downloadNexusModToLibrary: vi.fn() }));
vi.mock('./api', () => ({ ApiService: api }));
const item: ModProfileItem = { itemType: 'mod', name: 'Example', enabled: true, required: true,
  source: 'thunderstore', sourceId: 'Author/Example', sourceVersion: '1.2.3' };
const nexus = { ...item, source: 'nexusmods' as const, sourceId: '42', nexusFileId: '123' };

describe('pinned profile downloads', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    api.searchThunderstore.mockResolvedValue({ packages: [{ uuid4: 'package', owner: 'Author', name: 'Example',
      versions: [{ uuid4: 'new', version_number: '2.0.0' }, { uuid4: 'pinned', version_number: '1.2.3' }] }] });
    api.downloadThunderstoreToLibrary.mockResolvedValue({ success: true });
    api.getNexusModsModFiles.mockResolvedValue([{ file_id: 123, file_name: 'Example-IL2CPP.zip', name: 'Example IL2CPP' }]);
    api.getNexusOAuthStatus.mockResolvedValue({ connected: true, account: { isPremium: true } });
    api.downloadNexusModToLibrary.mockResolvedValue({ success: true });
  });

  it('downloads the exact Thunderstore version rather than the latest', async () => {
    await expect(downloadProfileItem(item, 'IL2CPP', vi.fn())).resolves.toBe('downloaded');
    expect(api.searchThunderstore).toHaveBeenCalledWith('schedule-i', 'Example', 'IL2CPP');
    expect(api.downloadThunderstoreToLibrary).toHaveBeenCalledWith('package', 'IL2CPP', undefined, 'pinned');
  });

  it('does not substitute versions or similarly named packages', async () => {
    await expect(downloadProfileItem({ ...item, sourceVersion: '0.1.0' }, 'Mono', vi.fn())).rejects.toThrow('unavailable');
    await expect(downloadProfileItem({ ...item, sourceId: 'Other/Example' }, 'Mono', vi.fn())).rejects.toThrow('unavailable');
    expect(api.downloadThunderstoreToLibrary).not.toHaveBeenCalled();
  });

  it('requires explicit approval for a security override and never overrides a block', async () => {
    api.downloadThunderstoreToLibrary.mockResolvedValueOnce({ success: false, securityScanConfirmationRequired: true });
    await downloadProfileItem(item, 'Mono', vi.fn().mockResolvedValue(true));
    expect(api.downloadThunderstoreToLibrary).toHaveBeenLastCalledWith('package', 'Mono', true, 'pinned');
    api.downloadThunderstoreToLibrary.mockResolvedValue({ success: false, securityScanBlocked: true, securityScanConfirmationRequired: true });
    const confirm = vi.fn();
    await expect(downloadProfileItem(item, 'Mono', confirm)).rejects.toThrow('security policy');
    expect(confirm).not.toHaveBeenCalled();
  });

  it('does not retry after a declined security review', async () => {
    api.downloadThunderstoreToLibrary.mockResolvedValue({ success: false, securityScanConfirmationRequired: true });
    await expect(downloadProfileItem(item, 'Mono', vi.fn().mockResolvedValue(false))).rejects.toThrow('paused');
    expect(api.downloadThunderstoreToLibrary).toHaveBeenCalledTimes(1);
  });

  it('downloads the original Nexus file by ID', async () => {
    await downloadProfileItem(nexus, 'IL2CPP', vi.fn());
    expect(api.downloadNexusModToLibrary).toHaveBeenCalledWith(42, 123, 'IL2CPP', undefined);
  });

  it('uses a manual Nexus session for accounts without direct downloads', async () => {
    api.getNexusOAuthStatus.mockResolvedValue({ connected: true, account: { isPremium: false, canDirectDownload: false } });
    await expect(downloadProfileItem(nexus, 'IL2CPP', vi.fn())).resolves.toBe('manual');
    expect(api.beginNexusManualDownloadSession).toHaveBeenCalledWith({ kind: 'library', modId: 42, fileId: 123, gameId: 'schedule1', runtime: 'IL2CPP' });
    expect(api.downloadNexusModToLibrary).not.toHaveBeenCalled();
  });

  it('does not replace a Nexus file from the wrong runtime', async () => {
    await expect(downloadProfileItem(nexus, 'Mono', vi.fn())).rejects.toThrow('targets IL2CPP');
    expect(api.downloadNexusModToLibrary).not.toHaveBeenCalled();
  });

  it('reports missing Nexus files and login requirements', async () => {
    api.getNexusModsModFiles.mockResolvedValueOnce([]);
    await expect(downloadProfileItem(nexus, 'IL2CPP', vi.fn())).rejects.toThrow('no longer available');
    api.getNexusOAuthStatus.mockResolvedValue({ connected: false });
    await expect(downloadProfileItem(nexus, 'IL2CPP', vi.fn())).rejects.toThrow('Sign in');
    expect(api.downloadNexusModToLibrary).not.toHaveBeenCalled();
  });
});
