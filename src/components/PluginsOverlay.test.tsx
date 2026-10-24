import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { open } from '@tauri-apps/plugin-dialog';

import { PluginsOverlay } from './PluginsOverlay';
import type { Environment } from '../types';

// Library artwork comes from the app-wide Mod Library store; these surfaces render without it here.
vi.mock('./media/useModArtwork', () => ({ useModArtwork: () => () => null }));

const apiMocks = vi.hoisted(() => ({
  getEnvironment: vi.fn(),
  getPlugins: vi.fn(),
  uploadPlugin: vi.fn(),
  deletePlugin: vi.fn(),
  openPluginsFolder: vi.fn(),
  enablePlugin: vi.fn(),
  disablePlugin: vi.fn(),
}));

vi.mock('../services/api', () => ({
  ApiService: apiMocks,
}));

const eventMocks = vi.hoisted(() => ({ onPluginsChanged: vi.fn() }));
vi.mock('../services/events', () => eventMocks);
let pluginsChangedHandler: ((event: { environmentId: string }) => void) | null = null;

vi.mock('@tauri-apps/plugin-dialog', () => ({
  open: vi.fn(),
}));

const openMock = vi.mocked(open);

const baseEnvironment: Environment = {
  id: 'env-1',
  name: 'Test Env',
  appId: '3164500',
  branch: 'main',
  outputDir: 'C:/env',
  runtime: 'IL2CPP',
  status: 'completed',
};

describe('PluginsOverlay', () => {
  beforeEach(() => {
    pluginsChangedHandler = null;
    eventMocks.onPluginsChanged.mockReset();
    eventMocks.onPluginsChanged.mockImplementation(async (handler) => {
      pluginsChangedHandler = handler;
      return () => {};
    });
    apiMocks.getEnvironment.mockReset();
    apiMocks.getPlugins.mockReset();
    apiMocks.uploadPlugin.mockReset();
    apiMocks.deletePlugin.mockReset();
    apiMocks.openPluginsFolder.mockReset();
    apiMocks.enablePlugin.mockReset();
    apiMocks.disablePlugin.mockReset();
    openMock.mockReset();

    apiMocks.getEnvironment.mockResolvedValue(baseEnvironment);
    apiMocks.getPlugins.mockResolvedValue({
      plugins: [
        {
          name: 'MLVScan',
          fileName: 'MLVScan.dll',
          path: 'C:/env/Plugins/MLVScan.dll',
          source: 'local',
          disabled: false,
        },
        {
          name: 'RuntimeFix',
          fileName: 'RuntimeFix.dll',
          path: 'C:/env/Plugins/RuntimeFix.dll',
          source: 'github',
          disabled: true,
        },
      ],
      pluginsDirectory: 'C:/env/Plugins',
      count: 2,
    });
    apiMocks.uploadPlugin.mockResolvedValue({ success: true });
    apiMocks.deletePlugin.mockResolvedValue({ success: true });
    apiMocks.openPluginsFolder.mockResolvedValue({ success: true });
    apiMocks.enablePlugin.mockResolvedValue({ success: true });
    apiMocks.disablePlugin.mockResolvedValue({ success: true });
  });

  afterEach(() => {
    cleanup();
  });

  it('automatically refreshes plugin metadata and disabled status, retaining a trailing change', async () => {
    let finishOld: (value: unknown) => void = () => {};
    apiMocks.getPlugins.mockResolvedValueOnce({ plugins: [{ name: 'Local Plugin', fileName: 'Local.dll', path: 'C:/env/Plugins/Local.dll', author: 'Old author', version: '1.0' }], pluginsDirectory: 'C:/env/Plugins', count: 1 })
      .mockReturnValueOnce(new Promise(resolve => { finishOld = resolve; }))
      .mockResolvedValueOnce({ plugins: [{ name: 'Local Plugin', fileName: 'Local.dll', path: 'C:/env/Plugins/Local.dll.disabled', author: 'New author', version: '2.0', disabled: true }], pluginsDirectory: 'C:/env/Plugins', count: 1 });
    render(<PluginsOverlay isOpen={true} onClose={() => {}} environmentId="env-1" />);
    await screen.findAllByText('Old author');
    await act(async () => { pluginsChangedHandler?.({ environmentId: 'other-env' }); });
    expect(apiMocks.getPlugins).toHaveBeenCalledTimes(1);
    await act(async () => { pluginsChangedHandler?.({ environmentId: 'env-1' }); });
    expect(apiMocks.getPlugins).toHaveBeenCalledTimes(2);
    await act(async () => {
      pluginsChangedHandler?.({ environmentId: 'env-1' });
      pluginsChangedHandler?.({ environmentId: 'env-1' });
      finishOld({ plugins: [], pluginsDirectory: 'C:/env/Plugins', count: 0 });
    });
    expect((await screen.findAllByText('New author')).length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: 'Enable' })).toBeTruthy();
    expect(apiMocks.getPlugins).toHaveBeenCalledTimes(3);
  });

  it('cleans up a plugin listener that registers after unmount', async () => {
    let finishRegistration: (value: () => void) => void = () => {};
    const stop = vi.fn();
    eventMocks.onPluginsChanged.mockReturnValueOnce(new Promise(resolve => { finishRegistration = resolve; }));
    const { unmount } = render(<PluginsOverlay isOpen={true} onClose={() => {}} environmentId="env-1" />);
    unmount();
    await act(async () => { finishRegistration(stop); });
    expect(stop).toHaveBeenCalledOnce();
    expect(apiMocks.getPlugins).not.toHaveBeenCalled();
  });

  it('auto-selects the first plugin and renders inspector details', async () => {
    render(
      <PluginsOverlay
        isOpen={true}
        onClose={() => {}}
        environmentId="env-1"
      />
    );

    expect((await screen.findAllByText('MLVScan.dll')).length).toBeGreaterThan(0);
    expect(screen.getByText(/2 plugins · 1 disabled/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Reload' })).toBeNull();
    expect(await screen.findByText('C:/env/Plugins/MLVScan.dll')).toBeTruthy();
  });

  it('displays a local plugin author and version and supports author searches', async () => {
    apiMocks.getPlugins.mockResolvedValue({
      plugins: [
        { name: 'Local Plugin', fileName: 'Local.dll', path: 'C:/env/Plugins/Local.dll', source: 'local', author: 'Plugin Author', version: '1.8.2' },
        { name: 'Other Plugin', fileName: 'Other.dll', path: 'C:/env/Plugins/Other.dll', source: 'local' },
      ], pluginsDirectory: 'C:/env/Plugins', count: 2,
    });
    const { container } = render(<PluginsOverlay isOpen={true} onClose={() => {}} environmentId="env-1" />);
    await screen.findAllByText('Local Plugin');
    const row = container.querySelector('.env-assets-table tbody tr');
    expect(row?.textContent).toContain('Plugin Author');
    expect(row?.textContent).toContain('1.8.2');
    fireEvent.change(screen.getByPlaceholderText('Search plugins'), { target: { value: 'plugin author' } });
    expect(screen.queryByText('Other Plugin')).toBeNull();
    expect(screen.getAllByText('Local Plugin').length).toBeGreaterThan(0);
  });

  it('filters plugins from the toolbar search', async () => {
    render(
      <PluginsOverlay
        isOpen={true}
        onClose={() => {}}
        environmentId="env-1"
      />
    );

    fireEvent.change(await screen.findByPlaceholderText('Search plugins'), {
      target: { value: 'runtime' },
    });

    await waitFor(() => {
      expect(screen.queryAllByText('MLVScan.dll')).toHaveLength(0);
      expect(screen.getAllByText('RuntimeFix.dll').length).toBeGreaterThan(0);
    });
  });

  it('keeps the newer environment inventory when an older request resolves last', async () => {
    type PluginResponse = {
      plugins: Array<{ name: string; fileName: string; path: string }>;
      pluginsDirectory: string;
      count: number;
    };
    let resolveA: ((value: PluginResponse) => void) | undefined;
    let resolveB: ((value: PluginResponse) => void) | undefined;
    apiMocks.getEnvironment.mockImplementation(async (environmentId: string) => ({
      ...baseEnvironment,
      id: environmentId,
      name: environmentId === 'env-a' ? 'Environment A' : 'Environment B',
    }));
    apiMocks.getPlugins.mockImplementation((environmentId: string) => new Promise((resolve) => {
      if (environmentId === 'env-a') resolveA = resolve;
      else resolveB = resolve;
    }));

    const { rerender } = render(
      <PluginsOverlay isOpen={true} onClose={() => {}} environmentId="env-a" />,
    );
    await waitFor(() => expect(resolveA).toBeTypeOf('function'));
    rerender(<PluginsOverlay isOpen={true} onClose={() => {}} environmentId="env-b" />);
    await waitFor(() => expect(resolveB).toBeTypeOf('function'));

    await act(async () => {
      resolveB?.({
        plugins: [{ name: 'Plugin B', fileName: 'PluginB.dll', path: 'C:/B/PluginB.dll' }],
        pluginsDirectory: 'C:/B',
        count: 1,
      });
    });
    expect((await screen.findAllByText('PluginB.dll')).length).toBeGreaterThan(0);

    await act(async () => {
      resolveA?.({
        plugins: [{ name: 'Plugin A', fileName: 'PluginA.dll', path: 'C:/A/PluginA.dll' }],
        pluginsDirectory: 'C:/A',
        count: 1,
      });
    });

    expect(screen.getAllByText('PluginB.dll').length).toBeGreaterThan(0);
    expect(screen.queryByText('PluginA.dll')).toBeNull();
  });

  it('toggles plugin state from the inspector', async () => {
    render(
      <PluginsOverlay
        isOpen={true}
        onClose={() => {}}
        environmentId="env-1"
      />
    );

    fireEvent.click((await screen.findAllByText('RuntimeFix'))[0]);
    fireEvent.click(screen.getByRole('button', { name: 'Enable' }));

    await waitFor(() => {
      expect(apiMocks.enablePlugin).toHaveBeenCalledWith('env-1', 'RuntimeFix.dll');
    });
  });

  it('toggles plugin state from the row switch', async () => {
    render(
      <PluginsOverlay
        isOpen={true}
        onClose={() => {}}
        environmentId="env-1"
      />
    );

    fireEvent.click(await screen.findByRole('switch', { name: 'MLVScan enabled' }));

    await waitFor(() => {
      expect(apiMocks.disablePlugin).toHaveBeenCalledWith('env-1', 'MLVScan.dll');
    });
  });

  it('deletes a plugin only after confirmation', async () => {
    const onPluginsChanged = vi.fn();
    render(
      <PluginsOverlay
        isOpen={true}
        onClose={() => {}}
        environmentId="env-1"
        onPluginsChanged={onPluginsChanged}
      />
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Delete' }));
    expect(apiMocks.deletePlugin).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByRole('button', { name: 'Delete Plugin' }));

    await waitFor(() => {
      expect(apiMocks.deletePlugin).toHaveBeenCalledWith('env-1', 'MLVScan.dll');
      expect(onPluginsChanged).toHaveBeenCalled();
    });
  });

  it('teaches what plugins are when the environment has none', async () => {
    apiMocks.getPlugins.mockResolvedValue({ plugins: [], pluginsDirectory: 'C:/env/Plugins', count: 0 });
    render(
      <PluginsOverlay
        isOpen={true}
        onClose={() => {}}
        environmentId="env-1"
      />
    );

    expect(await screen.findByText('No plugins in this environment')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Add Plugin File' })).toBeTruthy();
  });

  it('uploads plugin and notifies parent on success', async () => {
    const onPluginsChanged = vi.fn();
    openMock.mockResolvedValueOnce('C:/plugins/NewPlugin.dll');

    render(
      <PluginsOverlay
        isOpen={true}
        onClose={() => {}}
        environmentId="env-1"
        onPluginsChanged={onPluginsChanged}
      />
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Add Plugin' }));

    await waitFor(() => {
      expect(apiMocks.uploadPlugin).toHaveBeenCalledWith(
        'env-1',
        'C:/plugins/NewPlugin.dll',
        'NewPlugin.dll',
        'IL2CPP'
      );
    });

    await waitFor(() => {
      expect(onPluginsChanged).toHaveBeenCalled();
    });
  });

  it('shows runtime mismatch confirmation and continues', async () => {
    const onPluginsChanged = vi.fn();
    openMock.mockResolvedValueOnce('C:/plugins/MismatchPlugin.dll');
    apiMocks.uploadPlugin.mockResolvedValueOnce({
      success: true,
      runtimeMismatch: {
        detected: 'Mono',
        environment: 'IL2CPP',
        warning: 'Runtime mismatch',
        requiresConfirmation: true,
      },
    });

    render(
      <PluginsOverlay
        isOpen={true}
        onClose={() => {}}
        environmentId="env-1"
        onPluginsChanged={onPluginsChanged}
      />
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Add Plugin' }));
    expect(await screen.findByText('Runtime Mismatch Warning')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Continue Anyway' }));

    await waitFor(() => {
      expect(onPluginsChanged).toHaveBeenCalled();
    });
  });
});
