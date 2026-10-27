import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ProfileSourceDownloads } from './ProfileSourceDownloads';
import { AppDialogProvider } from './AppDialogProvider';
import type { StoredModProfile } from '../types';

const mocks = vi.hoisted(() => ({ preview: vi.fn(), download: vi.fn() }));
vi.mock('../services/api', () => ({ ApiService: { previewModProfileImport: mocks.preview } }));
vi.mock('../services/profileDownloads', () => ({ downloadProfileItem: mocks.download }));
const item = { itemType: 'mod' as const, name: 'First', source: 'thunderstore' as const, sourceId: 'Author/First', sourceVersion: '1.0.0', required: true, enabled: true };
const profile: StoredModProfile = { id: 'test', name: 'Imported', runtime: 'Mono', isDefault: false, activeEnvironmentIds: [], createdAt: '', updatedAt: '',
  manifest: { kind: 'simm.profile', schemaVersion: 1, profile: { name: 'Imported', runtime: 'Mono', game: 'schedule-i', branch: '', exportedAt: '' }, items: [item] } };
beforeEach(() => { vi.resetAllMocks(); mocks.download.mockResolvedValue('downloaded'); });
afterEach(cleanup);
function show() {
  const onBusyChange = vi.fn();
  render(<AppDialogProvider><ProfileSourceDownloads profile={profile} disabled={false} onBusyChange={onBusyChange} /></AppDialogProvider>);
  fireEvent.click(screen.getByRole('button', { name: 'Download missing mods' }));
  return onBusyChange;
}

it('downloads only missing enabled mods and freezes other profile actions during the batch', async () => {
  mocks.preview.mockResolvedValue({ items: [
    { item, status: 'needsDownload' },
    { item: { ...item, name: 'Disabled', enabled: false }, status: 'needsDownload' },
    { item: { ...item, name: 'Ready' }, status: 'readyToInstall' },
  ] });
  const busy = show();
  await screen.findByText(/1 mod added/);
  expect(mocks.download).toHaveBeenCalledTimes(1);
  expect(mocks.download).toHaveBeenCalledWith(item, 'Mono', expect.any(Function));
  expect(busy.mock.calls).toEqual([[true], [false]]);
});

it('stops after opening one manual Nexus session', async () => {
  mocks.preview.mockResolvedValue({ items: [{ item, status: 'needsDownload' }, { item: { ...item, name: 'Next' }, status: 'needsDownload' }] });
  mocks.download.mockResolvedValue('manual');
  show();
  await screen.findByText(/confirm this file on Nexus/);
  expect(mocks.download).toHaveBeenCalledTimes(1);
});

it('reports individual failures and continues the remaining downloads', async () => {
  mocks.preview.mockResolvedValue({ items: [{ item, status: 'needsDownload' }, { item: { ...item, name: 'Next' }, status: 'needsDownload' }] });
  mocks.download.mockRejectedValueOnce('Pinned version is unavailable');
  show();
  expect(await screen.findByText('First: Pinned version is unavailable')).toBeVisible();
  await waitFor(() => expect(mocks.download).toHaveBeenCalledTimes(2));
  expect(screen.getByText(/1 mod added/)).toBeVisible();
});
