import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { InstallTargetsDialog } from './InstallTargetsDialog';

describe('InstallTargetsDialog', () => {
  afterEach(() => {
    cleanup();
  });

  it('uses normalized runtime values for both row labels and quick actions', () => {
    render(
      <InstallTargetsDialog
        isOpen={true}
        title="Install"
        entry={{
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
        }}
        compatibleEnvironments={[
          {
            id: 'env-alt-beta',
            name: 'Alternate Beta',
            description: '',
            appId: '3164500',
            branch: 'alternate-beta',
            outputDir: 'C:/envs/alt-beta',
            runtime: 'IL2CPP',
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

  it('disables bulk runtime buttons when all matching environments are locked', () => {
    render(
      <InstallTargetsDialog
        isOpen={true}
        title="Install"
        entry={{
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
        }}
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
