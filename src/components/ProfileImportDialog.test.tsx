import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ProfileImportDialog } from './ProfileImportDialog';
import type { ModProfileManifest } from '../types';

const mocks = vi.hoisted(() => ({ open: vi.fn(), read: vi.fn(), readSimm: vi.fn(), import: vi.fn() }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: mocks.open }));
vi.mock('../services/api', () => ({ ApiService: { readExternalModProfilesFile: mocks.read, readModProfileFile: mocks.readSimm, importModProfileToLibrary: mocks.import } }));
const manifest: ModProfileManifest = { schemaVersion: 1, kind: 'simm.profile', profile: { name: 'From Vortex', game: 'schedule-i', runtime: 'Mono', branch: '', exportedAt: '' },
  items: [{ itemType: 'mod', name: 'Example', sourceVersion: '1.2.3', required: true, enabled: false, source: 'nexusmods', sourceId: '42', nexusFileId: '123' }] };
const preview = { format: 'Vortex state backup', profiles: [manifest], warnings: ['Installer choices require review.'], omittedFiles: ['UserData/config.cfg'] };

beforeEach(() => { vi.resetAllMocks(); mocks.open.mockResolvedValue('C:/backup.json'); mocks.read.mockResolvedValue(preview); mocks.readSimm.mockResolvedValue(manifest); mocks.import.mockResolvedValue({ id: 'new', manifest }); });
afterEach(cleanup);

async function chooseFormat(name: string) {
  fireEvent.click(screen.getByRole('combobox', { name: 'Profile format' }));
  const option = await screen.findByRole('option', { name });
  fireEvent.pointerEnter(option, { pointerType: 'touch' });
  fireEvent.click(option);
}

async function chooseRuntime() {
  fireEvent.click(screen.getByRole('combobox', { name: 'Imported profile runtime' }));
  const option = await screen.findByRole('option', { name: 'Mono' });
  fireEvent.pointerEnter(option, { pointerType: 'touch' });
  fireEvent.click(option);
}

it('requires an explicit runtime and previews without saving or installing', async () => {
  render(<ProfileImportDialog onClose={vi.fn()} onImported={vi.fn()} />);
  await chooseFormat('Vortex backup (.json)');
  expect(screen.getByRole('button', { name: 'Choose file…' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Import profile' })).toBeDisabled();
  await chooseRuntime();
  fireEvent.click(screen.getByRole('button', { name: 'Choose file…' }));
  expect(await screen.findByText('1.2.3')).toBeVisible();
  expect(mocks.read).toHaveBeenCalledWith('C:/backup.json', 'Mono');
  expect(screen.getByText('Installer choices require review.')).toBeVisible();
  fireEvent.click(screen.getByText('1 files require a separate transfer'));
  expect(screen.getByText('UserData/config.cfg')).toBeVisible();
  expect(mocks.import).not.toHaveBeenCalled();
});

it('imports only the chosen Vortex profile and keeps its disabled mods', async () => {
  const second = { ...manifest, profile: { ...manifest.profile, name: 'Second profile' } };
  mocks.read.mockResolvedValue({ ...preview, profiles: [manifest, second] });
  const imported = { id: 'selected', manifest: second };
  mocks.import.mockResolvedValue(imported);
  const onImported = vi.fn(); const onClose = vi.fn();
  render(<ProfileImportDialog onClose={onClose} onImported={onImported} />);
  await chooseFormat('Vortex backup (.json)');
  await chooseRuntime();
  fireEvent.click(screen.getByRole('button', { name: 'Choose file…' }));
  await screen.findByText('1.2.3');
  fireEvent.click(screen.getByRole('combobox', { name: 'Source profile' }));
  const option = await screen.findByRole('option', { name: 'Second profile' });
  fireEvent.pointerEnter(option, { pointerType: 'touch' });
  fireEvent.click(option);
  fireEvent.click(screen.getByRole('button', { name: 'Import profile' }));
  await waitFor(() => expect(onImported).toHaveBeenCalledWith(imported));
  expect(mocks.import).toHaveBeenCalledWith(second);
  expect(second.items[0].enabled).toBe(false);
  expect(onClose).toHaveBeenCalled();
});

it('shows actual read errors and never imports a failed preview', async () => {
  mocks.read.mockRejectedValue('This profile is for Valheim, not Schedule I');
  render(<ProfileImportDialog onClose={vi.fn()} onImported={vi.fn()} />);
  await chooseFormat('Vortex backup (.json)');
  await chooseRuntime();
  fireEvent.click(screen.getByRole('button', { name: 'Choose file…' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Valheim');
  expect(screen.getByRole('button', { name: 'Import profile' })).toBeDisabled();
  expect(mocks.import).not.toHaveBeenCalled();
});

it('keeps cancellation free of profile mutations', async () => {
  mocks.open.mockResolvedValue(null);
  const onClose = vi.fn();
  render(<ProfileImportDialog onClose={onClose} onImported={vi.fn()} />);
  fireEvent.click(screen.getByRole('button', { name: 'Choose file…' }));
  await waitFor(() => expect(mocks.open).toHaveBeenCalled());
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(onClose).toHaveBeenCalled();
  expect(mocks.import).not.toHaveBeenCalled();
  expect(mocks.read).not.toHaveBeenCalled();
  expect(mocks.readSimm).not.toHaveBeenCalled();
});

it('offers SIMM first and preserves its full saved manifest without requesting a runtime override', async () => {
  const native: ModProfileManifest = { ...manifest,
    profile: { ...manifest.profile, name: 'SIMM export', runtime: 'IL2CPP', branch: 'beta', gameVersion: '0.4.7f12' },
    items: [manifest.items[0], { ...manifest.items[0], itemType: 'plugin', name: 'Loader plugin', enabled: true },
      { ...manifest.items[0], itemType: 'userlib', name: 'Shared library', enabled: true }],
    collection: { slug: 'example', name: 'Collection', revisionNumber: 3, sourceUrl: 'https://www.nexusmods.com/games/schedule1/collections/example', items: [] },
  };
  mocks.readSimm.mockResolvedValue(native);
  render(<ProfileImportDialog onClose={vi.fn()} onImported={vi.fn()} />);
  expect(screen.getByRole('combobox', { name: 'Profile format' })).toHaveTextContent('SIMM profile (.json)');
  expect(screen.queryByRole('combobox', { name: 'Imported profile runtime' })).toBeNull();
  expect(screen.getByRole('button', { name: 'Choose file…' })).toBeEnabled();
  fireEvent.click(screen.getByRole('button', { name: 'Choose file…' }));
  expect(await screen.findByText('Runtime: IL2CPP')).toBeVisible();
  expect(mocks.open).toHaveBeenCalledWith({ title: 'Choose SIMM profile', multiple: false, filters: [{ name: 'SIMM profile', extensions: ['json'] }] });
  expect(mocks.readSimm).toHaveBeenCalledWith('C:/backup.json');
  expect(mocks.read).not.toHaveBeenCalled();
  expect(screen.getByText(/3 items · 1 mod · 1 plugin · 1 UserLib · 2 enabled · 1 disabled/)).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: 'Import profile' }));
  await waitFor(() => expect(mocks.import).toHaveBeenCalledWith(native));
});

it('clears the old preview when changing formats and requires a runtime for shared exports', async () => {
  render(<ProfileImportDialog onClose={vi.fn()} onImported={vi.fn()} />);
  fireEvent.click(screen.getByRole('button', { name: 'Choose file…' }));
  await screen.findByText('Runtime: Mono');
  await chooseFormat('r2modman / Thunderstore / Gale (.r2z)');
  expect(screen.getByRole('button', { name: 'Import profile' })).toBeDisabled();
  expect(screen.queryByRole('table')).toBeNull();
  expect(screen.getByRole('button', { name: 'Choose file…' })).toBeDisabled();
  await chooseRuntime();
  fireEvent.click(screen.getByRole('button', { name: 'Choose file…' }));
  await waitFor(() => expect(mocks.read).toHaveBeenCalledWith('C:/backup.json', 'Mono'));
  expect(mocks.open).toHaveBeenLastCalledWith({ title: 'Choose shared profile', multiple: false, filters: [{ name: 'Shared profile', extensions: ['r2z', 'r2x', 'zip', 'yaml', 'yml'] }] });
});

it('shows SIMM JSON validation errors without falling back to another importer', async () => {
  mocks.readSimm.mockRejectedValue('Unsupported profile schema version 99');
  render(<ProfileImportDialog onClose={vi.fn()} onImported={vi.fn()} />);
  fireEvent.click(screen.getByRole('button', { name: 'Choose file…' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Unsupported profile schema version 99');
  expect(screen.getByRole('button', { name: 'Import profile' })).toBeDisabled();
  expect(mocks.read).not.toHaveBeenCalled();
  expect(mocks.import).not.toHaveBeenCalled();
});
