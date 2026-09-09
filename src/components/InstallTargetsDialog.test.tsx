import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { InstallTargetsDialog } from './InstallTargetsDialog';

describe('InstallTargetsDialog', () => {
  afterEach(() => {
    cleanup();
  });

  it('uses the backend runtime value, including legacy MONO casing, for row labels and quick actions', () => {
    render(
      <InstallTargetsDialog
        isOpen={true}
        title="Install"
        entries={[{
          storageId: 'storage-1',
          displayName: 'Example Mod',
          files: ['Example.dll'],
          attachedUserLibs: [],
          source: 'nexusmods',
          managed: true,
          installedIn: [],
          availableRuntimes: ['Mono'],
          storageIdsByRuntime: { Mono: 'storage-1' },
          installedInByRuntime: { Mono: [] },
          filesByRuntime: { Mono: ['Example.dll'] },
        }]}
        compatibleEnvironments={[
          {
            id: 'env-alt-beta',
            name: 'Alternate Beta',
            description: '',
            appId: '3164500',
            branch: 'alternate-beta',
            outputDir: 'C:/envs/alt-beta',
            runtime: 'MONO',
            status: 'completed',
          },
        ]}
        excludedEnvironments={[]}
        lockedEnvironmentIds={[]}
        mode="select"
        selectedEnvironmentIds={new Set<string>()}
        onToggleEnvironment={vi.fn()}
        onSelectAllCompatible={vi.fn()}
        onSelectRuntime={vi.fn()}
        onClear={vi.fn()}
        onClose={vi.fn()}
        onConfirm={vi.fn()}
        installing={false}
      />,
    );

    expect(screen.getByText('Mono • alternate-beta')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'All Mono' })).not.toBeDisabled();
    expect(screen.getByRole('button', { name: 'All IL2CPP' })).toBeDisabled();
  });

  it('does not offer a fake cancellation path while installation is in progress', () => {
    const onClose = vi.fn();
    render(
      <InstallTargetsDialog
        isOpen={true}
        title="Install"
        entries={[{
          storageId: 'storage-1',
          displayName: 'Example Mod',
          files: ['Example.dll'],
          attachedUserLibs: [],
          source: 'local',
          managed: true,
          installedIn: [],
          availableRuntimes: ['IL2CPP'],
          storageIdsByRuntime: { IL2CPP: 'storage-1' },
          installedInByRuntime: { IL2CPP: [] },
          filesByRuntime: { IL2CPP: ['Example.dll'] },
        }]}
        compatibleEnvironments={[]}
        excludedEnvironments={[]}
        lockedEnvironmentIds={[]}
        mode="select"
        selectedEnvironmentIds={new Set<string>()}
        onToggleEnvironment={vi.fn()}
        onSelectAllCompatible={vi.fn()}
        onSelectRuntime={vi.fn()}
        onClear={vi.fn()}
        onClose={onClose}
        onConfirm={vi.fn()}
        installing={true}
      />,
    );

    const closeButton = screen.getByRole('button', { name: 'Close install target dialog' });
    expect(closeButton).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Installation in progress' })).toBeDisabled();
    fireEvent.click(closeButton);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('disables bulk runtime buttons when all matching environments are locked', () => {
    render(
      <InstallTargetsDialog
        isOpen={true}
        title="Install"
        entries={[{
          storageId: 'storage-1',
          displayName: 'Example Mod',
          files: ['Example.dll'],
          attachedUserLibs: [],
          source: 'nexusmods',
          managed: true,
          installedIn: [],
          availableRuntimes: ['Mono'],
          storageIdsByRuntime: { Mono: 'storage-1' },
          installedInByRuntime: { Mono: [] },
          filesByRuntime: { Mono: ['Example.dll'] },
        }]}
        compatibleEnvironments={[
          {
            id: 'env-alt',
            name: 'Alternate',
            description: '',
            appId: '3164500',
            branch: 'alternate',
            outputDir: 'C:/envs/alternate',
            runtime: 'Mono',
            status: 'completed',
          },
        ]}
        excludedEnvironments={[]}
        lockedEnvironmentIds={['env-alt']}
        mode="select"
        selectedEnvironmentIds={new Set<string>(['env-alt'])}
        onToggleEnvironment={vi.fn()}
        onSelectAllCompatible={vi.fn()}
        onSelectRuntime={vi.fn()}
        onClear={vi.fn()}
        onClose={vi.fn()}
        onConfirm={vi.fn()}
        installing={false}
      />,
    );

    expect(screen.getByRole('button', { name: 'All Mono' })).toBeDisabled();
  });
});
