import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { EnvironmentStatus, ConsolePreferences } from './NativeConsoleWindow';
import { ApiService } from '../services/api';
import type { NativeConsoleSnapshot } from '../types';
import { onModsChanged } from '../services/events';

vi.mock('../services/api', () => ({ ApiService: {
  getEnvironment: vi.fn(),
  getNativeConsoleSnapshot: vi.fn(), closeNativeConsoleGame: vi.fn(),
  retryNativeConsole: vi.fn(), saveNativeConsolePreferences: vi.fn(),
  popOutNativeConsole: vi.fn(),
  openNativeConsole: vi.fn().mockResolvedValue(undefined), updateNativeConsoleViewport: vi.fn().mockResolvedValue(undefined),
  getSettings: vi.fn().mockResolvedValue({ theme: 'dark' }), getCustomThemes: vi.fn().mockResolvedValue([]),
} }));
vi.mock('./LogsOverlay', () => ({ LogsOverlay: ({ focus, active }: { focus: unknown; active: boolean }) => active ? <output data-testid="logs-focus">{JSON.stringify(focus)}</output> : null }));
vi.mock('../utils/theme', () => ({ applyThemeSelection: vi.fn() }));
vi.mock('../services/events', async (importOriginal) => ({
  ...await importOriginal<typeof import('../services/events')>(),
  onModsChanged: vi.fn().mockResolvedValue(() => {}),
  onPluginsChanged: vi.fn().mockResolvedValue(() => {}),
}));
const preferences = { autoOpen: true, showGame: true, showProfile: true, showMods: true, showPaths: false, sidebarWidth: 360 };
const snapshot: NativeConsoleSnapshot = {
  supported: true, environment: { id: 'env', name: 'Development', appId: '3164500', status: 'completed', branch: 'beta', runtime: 'IL2CPP', currentGameVersion: '0.4.7', outputDir: 'C:\\Game' },
  profileName: 'Test profile', profileRuntime: 'IL2CPP', profileUpdatedAt: null,
  entries: [{ name: 'Test mod', version: '1.2', versionSource: 'melonInfo', author: 'Test author', fileName: 'TestMod.dll', enabled: true, kind: 'Mod' }, { name: 'Test plugin', version: '3.4.5.6', versionSource: 'assembly', author: null, fileName: 'Plugin.dll', enabled: false, kind: 'Plugin' }],
  processStartedAt: Date.now() - 90_000, inventoryUpdatedAt: Date.now(),
  preferences, presentation: 'docked', status: 'docked', processId: 123, diagnostic: null,
  messages: { errors: 0, warnings: 0, entries: [], sources: [], omitted: 0, generation: 1, state: 'ready', diagnostic: null },
};
afterEach(cleanup);
beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  vi.clearAllMocks();
  vi.mocked(ApiService.getNativeConsoleSnapshot).mockResolvedValue(snapshot);
  vi.mocked(ApiService.getEnvironment).mockResolvedValue(snapshot.environment);
  vi.mocked(ApiService.closeNativeConsoleGame).mockResolvedValue();
  vi.mocked(ApiService.retryNativeConsole).mockResolvedValue();
  vi.mocked(ApiService.popOutNativeConsole).mockResolvedValue();
  vi.mocked(ApiService.saveNativeConsolePreferences).mockImplementation(async (_environmentId, value) => value);
});

describe('Native Console', () => {
  it('uses the environment page tabs without adding another header or tab bar', async () => {
    const onSelectTab = vi.fn();
    vi.mocked(ApiService.getNativeConsoleSnapshot).mockResolvedValue({ ...snapshot, messages: { ...snapshot.messages, errors: 1 } });
    const view = render(<EnvironmentStatus embedded environmentId="env" onSelectTab={onSelectTab} onBack={vi.fn()} />);
    await screen.findByText('Test profile');
    expect(screen.queryByRole('heading', { name: 'Development' })).toBeNull();
    expect(screen.queryByRole('tablist')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Errors 1' }));
    expect(onSelectTab).toHaveBeenCalledWith('logs');
    expect(await screen.findByTestId('logs-focus')).toBeInTheDocument();
    view.rerender(<EnvironmentStatus embedded initialTab="logs" environmentId="env" onSelectTab={onSelectTab} onBack={vi.fn()} />);
    view.rerender(<EnvironmentStatus embedded initialTab="console" environmentId="env" onSelectTab={onSelectTab} onBack={vi.fn()} />);
    expect(await screen.findByRole('region', { name: 'MelonLoader console' })).toBeInTheDocument();
    expect(ApiService.openNativeConsole).toHaveBeenCalledTimes(1);
    expect(ApiService.closeNativeConsoleGame).not.toHaveBeenCalled();
  });

  it('saves View options only for the selected environment', async () => {
    render(<EnvironmentStatus environmentId="env" onBack={vi.fn()} />);
    await screen.findByText('Test profile');
    fireEvent.click(screen.getByRole('button', { name: 'View options' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Open Console after launch' }));
    await waitFor(() => expect(ApiService.saveNativeConsolePreferences).toHaveBeenCalledWith('env', { ...preferences, autoOpen: false }));
    expect(screen.getByText(/Saved for this environment/)).toBeInTheDocument();
  });

  it('pops out and redocks the existing console without closing or relaunching the game', async () => {
    render(<EnvironmentStatus environmentId="env" onBack={vi.fn()} />);
    await screen.findByText('Test profile');
    vi.mocked(ApiService.getNativeConsoleSnapshot).mockResolvedValue({ ...snapshot, presentation: 'popout', status: 'poppedOut' });
    fireEvent.click(screen.getByRole('button', { name: 'Pop out console' }));
    const dock = await screen.findByRole('button', { name: 'Dock in SIMM' });
    expect(ApiService.popOutNativeConsole).toHaveBeenCalledWith('env');
    expect(screen.getByText('Use Dock in SIMM to return the console here.')).toBeInTheDocument();
    expect(ApiService.updateNativeConsoleViewport).toHaveBeenLastCalledWith('env', expect.objectContaining({ visible: false }));
    vi.mocked(ApiService.getNativeConsoleSnapshot).mockResolvedValue(snapshot);
    fireEvent.click(dock);
    await screen.findByRole('button', { name: 'Pop out console' });
    expect(ApiService.retryNativeConsole).toHaveBeenCalledWith('env');
    expect(ApiService.openNativeConsole).toHaveBeenCalledTimes(1);
    expect(ApiService.closeNativeConsoleGame).not.toHaveBeenCalled();
  });

  it('reports a failed pop-out without claiming the window was restored', async () => {
    vi.mocked(ApiService.popOutNativeConsole).mockRejectedValueOnce(new Error('Console restoration is still pending'));
    render(<EnvironmentStatus environmentId="env" onBack={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Pop out console' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Console restoration is still pending');
    expect(screen.queryByRole('button', { name: 'Dock in SIMM' })).not.toBeInTheDocument();
  });
  it('honors a Logs navigation request while the same environment remains mounted', async () => {
    const view = render(<EnvironmentStatus environmentId="env" onBack={vi.fn()} />);
    await screen.findByText('Test profile');
    view.rerender(<EnvironmentStatus environmentId="env" initialTab="logs" onBack={vi.fn()} />);
    expect(await screen.findByTestId('logs-focus')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Logs' })).toHaveAttribute('aria-selected', 'true');
    expect(ApiService.openNativeConsole).toHaveBeenCalledTimes(1);
  });
  it('keeps Logs and game details accessible without native console support', async () => {
    render(<EnvironmentStatus environmentId="env" environment={snapshot.environment} nativeConsoleSupported={false} onBack={vi.fn()} />);
    expect(await screen.findByTestId('logs-focus')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Logs' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: 'Console' })).toBeDisabled();
    expect(screen.getByRole('region', { name: 'Game details' })).toBeInTheDocument();
    expect(ApiService.openNativeConsole).not.toHaveBeenCalled();
  });
  it('switches tabs and keyboard focus without reopening or closing the native session', async () => {
    render(<EnvironmentStatus environmentId="env" onBack={vi.fn()} />);
    await screen.findByText('Test profile');
    fireEvent.click(screen.getByRole('tab', { name: 'Logs' }));
    expect(screen.getByRole('tab', { name: 'Logs' })).toHaveAttribute('aria-selected', 'true');
    expect(await screen.findByTestId('logs-focus')).toBeInTheDocument();
    expect(screen.getByRole('complementary', { name: 'Environment details' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Close Game' })).toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole('tab', { name: 'Logs' }), { key: 'ArrowLeft' });
    expect(screen.getByRole('tab', { name: 'Console' })).toHaveFocus();
    expect(screen.getByRole('tab', { name: 'Console' })).toHaveAttribute('aria-selected', 'true');
    expect(ApiService.openNativeConsole).toHaveBeenCalledTimes(1);
    expect(ApiService.closeNativeConsoleGame).not.toHaveBeenCalled();
    expect(ApiService.retryNativeConsole).not.toHaveBeenCalled();
  });
  it('opens a row count for its DLL and severity, combines aliases and keeps the selection during updates', async () => {
    const mod = snapshot.entries[0], plugin = snapshot.entries[1];
    const messages: NativeConsoleSnapshot['messages'] = {
      ...snapshot.messages, errors: 3, warnings: 1,
      sources: [
        { source: 'Test_mod', origin: mod, errors: 1, warnings: 0 },
        { source: 'TestMod', origin: mod, errors: 1, warnings: 0 },
        { source: 'Test_plugin', origin: plugin, errors: 1, warnings: 1 },
      ],
      entries: [
        { id: 4, lineNumber: 8, level: 'warning', timestamp: null, source: 'Test_plugin', origin: plugin, message: 'Plugin warning', truncated: false },
        { id: 3, lineNumber: 6, level: 'error', timestamp: null, source: 'Test_plugin', origin: plugin, message: 'Plugin error', truncated: false },
        { id: 2, lineNumber: 4, level: 'error', timestamp: null, source: 'TestMod', origin: mod, message: 'Mod alias error', truncated: false },
        { id: 1, lineNumber: 2, level: 'error', timestamp: null, source: 'Test_mod', origin: mod, message: 'Mod error', truncated: false },
      ],
    };
    vi.mocked(ApiService.getNativeConsoleSnapshot).mockResolvedValue({ ...snapshot, messages });
    render(<EnvironmentStatus environmentId="env" onBack={vi.fn()} />);
    await screen.findByRole('button', { name: 'View errors from mod Test mod (2)' });
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'TestMod.dll' } });
    fireEvent.click(screen.getByRole('button', { name: 'View errors from mod Test mod (2)' }));
    expect(screen.getByRole('tab', { name: 'Logs' })).toHaveAttribute('aria-selected', 'true');
    expect(JSON.parse((await screen.findByTestId('logs-focus')).textContent!)).toMatchObject({ severity: 'ERROR', source: { label: 'Mod · Test mod', tags: ['Test_mod', 'TestMod'] } });
    expect(screen.getByRole('searchbox')).toHaveValue('TestMod.dll');
    const updated = { ...messages, errors: 4, sources: [{ ...messages.sources[0], errors: 2 }, ...messages.sources.slice(1)], entries: [{ ...messages.entries[3], id: 5, message: 'Later mod error' }, ...messages.entries] };
    vi.mocked(ApiService.getNativeConsoleSnapshot).mockResolvedValue({ ...snapshot, messages: updated });
    expect(await screen.findByRole('button', { name: 'View errors from mod Test mod (3)' }, { timeout: 2000 })).toBeInTheDocument();
    expect(JSON.parse(screen.getByTestId('logs-focus').textContent!)).toMatchObject({ severity: 'ERROR', source: { label: 'Mod · Test mod' } });
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'View warnings from plugin Test plugin (1)' }));
    expect(JSON.parse(screen.getByTestId('logs-focus').textContent!)).toMatchObject({ severity: 'WARN', source: { label: 'Plugin · Test plugin', tags: ['Test_plugin'] } });
    fireEvent.click(screen.getByRole('button', { name: 'Errors 4' }));
    expect(JSON.parse(screen.getByTestId('logs-focus').textContent!)).toMatchObject({ severity: 'ERROR', source: null });
    expect(ApiService.retryNativeConsole).not.toHaveBeenCalled();
    expect(ApiService.closeNativeConsoleGame).not.toHaveBeenCalled();
    expect(ApiService.openNativeConsole).toHaveBeenCalledTimes(1);
  });

  it('keeps counts for older messages, separates mod/plugin identity and leaves unmatched output unassigned', async () => {
    const mod = { ...snapshot.entries[0], fileName: 'Shared.dll' }, plugin = { ...snapshot.entries[1], fileName: 'Shared.dll' };
    const messages = { ...snapshot.messages, errors: 10, warnings: 7, omitted: 16, sources: [
      { source: 'Test_mod', origin: mod, errors: 8, warnings: 0 },
      { source: 'Test_plugin', origin: plugin, errors: 2, warnings: 4 },
      { source: 'Unmatched', origin: null, errors: 0, warnings: 3 },
    ] };
    vi.mocked(ApiService.getNativeConsoleSnapshot).mockResolvedValue({ ...snapshot, entries: [mod, plugin], messages });
    render(<EnvironmentStatus environmentId="env" onBack={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'View errors from mod Test mod (8)' }));
    expect(screen.getByRole('button', { name: 'View errors from plugin Test plugin (2)' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'View warnings from mod Test mod (0)' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'View warnings from plugin Test plugin (4)' })).toBeInTheDocument();
    expect(JSON.parse((await screen.findByTestId('logs-focus')).textContent!)).toMatchObject({ severity: 'ERROR', source: { label: 'Mod · Test mod', tags: ['Test_mod'] } });
  });
  it('updates the sidebar message counts from the existing session poll', async () => {
    render(<EnvironmentStatus environmentId="env" onBack={vi.fn()} />);
    expect(await screen.findByRole('button', { name: 'Errors 0' })).toBeInTheDocument();
    vi.mocked(ApiService.getNativeConsoleSnapshot).mockResolvedValue({ ...snapshot, messages: { ...snapshot.messages, errors: 2, warnings: 3 } });
    expect(await screen.findByRole('button', { name: 'Errors 2' }, { timeout: 2000 })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Warnings 3' })).toBeInTheDocument();
    expect(ApiService.retryNativeConsole).not.toHaveBeenCalled();
    expect(ApiService.closeNativeConsoleGame).not.toHaveBeenCalled();
  });
  it('shows session details and requires explicit confirmation before requesting a game close', async () => {
    render(<EnvironmentStatus environmentId="env" onBack={vi.fn()} />);
    expect(await screen.findByText('Test profile')).toBeInTheDocument();
    expect(screen.getByText('Test mod')).toBeInTheDocument();
    expect(screen.getByTitle('MelonInfo version')).toHaveTextContent('1.2');
    expect(screen.getByTitle('Assembly version')).toHaveTextContent('3.4.5.6');
    fireEvent.click(screen.getByRole('button', { name: 'Close Game' }));
    expect(ApiService.closeNativeConsoleGame).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(ApiService.closeNativeConsoleGame).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Close Game' }));
    fireEvent.click(screen.getByRole('button', { name: 'Close game now' }));
    await waitFor(() => expect(ApiService.closeNativeConsoleGame).toHaveBeenCalledWith('env'));
  });
  it('retries attachment without a game launch and reports a close failure', async () => {
    vi.mocked(ApiService.getNativeConsoleSnapshot).mockResolvedValue({ ...snapshot, status: 'unavailable' });
    vi.mocked(ApiService.closeNativeConsoleGame).mockRejectedValue(new Error('Game identity changed'));
    render(<EnvironmentStatus environmentId="env" onBack={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Retry connection' }));
    await waitFor(() => expect(ApiService.retryNativeConsole).toHaveBeenCalledWith('env'));
    fireEvent.click(screen.getByRole('button', { name: 'Close Game' }));
    fireEvent.click(screen.getByRole('button', { name: 'Close game now' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Game identity changed');
  });
  it.each(['after an observed exit', 'without an exit snapshot', 'with a reused PID'] as const)(
    'does not revive the previous close message on relaunch %s', async (transition) => {
      vi.useFakeTimers();
      try {
        vi.mocked(ApiService.getNativeConsoleSnapshot).mockImplementation(async () => ({ ...snapshot }));
        await act(async () => { render(<EnvironmentStatus environmentId="env" onBack={vi.fn()} />); });
        fireEvent.click(screen.getByRole('button', { name: 'Close Game' }));
        await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Close game now' })); });
        expect(screen.getByText('Closing game…')).toBeInTheDocument();
        await act(async () => { await vi.advanceTimersByTimeAsync(11_000); });
        expect(screen.getByText('Game is still running')).toBeInTheDocument();

        if (transition === 'after an observed exit') {
          vi.mocked(ApiService.getNativeConsoleSnapshot).mockResolvedValue({ ...snapshot, status: 'exited' });
          await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
          expect(screen.queryByText('Game is still running')).not.toBeInTheDocument();
        }
        vi.mocked(ApiService.getNativeConsoleSnapshot).mockResolvedValue({
          ...snapshot,
          processId: transition === 'with a reused PID' ? snapshot.processId : 456,
          processStartedAt: snapshot.processStartedAt! + 60_000,
        });
        await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
        expect(screen.getByText(transition === 'with a reused PID' ? '123' : '456')).toBeInTheDocument();
        expect(screen.queryByText('Game is still running')).not.toBeInTheDocument();
        expect(screen.queryByText('Closing game…')).not.toBeInTheDocument();
        expect(ApiService.retryNativeConsole).not.toHaveBeenCalled();
        expect(ApiService.closeNativeConsoleGame).toHaveBeenCalledTimes(1);

        fireEvent.click(screen.getByRole('button', { name: 'Close Game' }));
        await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Close game now' })); });
        expect(screen.getByText('Closing game…')).toBeInTheDocument();
      } finally {
        cleanup();
        vi.useRealTimers();
      }
    },
  );
  it('does not apply a delayed close response to a newer game', async () => {
    vi.useFakeTimers();
    try {
      vi.mocked(ApiService.getNativeConsoleSnapshot).mockImplementation(async () => ({ ...snapshot }));
      let finishClose!: () => void;
      vi.mocked(ApiService.closeNativeConsoleGame).mockImplementationOnce(() => new Promise<void>(resolve => { finishClose = resolve; }));
      await act(async () => { render(<EnvironmentStatus environmentId="env" onBack={vi.fn()} />); });
      fireEvent.click(screen.getByRole('button', { name: 'Close Game' }));
      fireEvent.click(screen.getByRole('button', { name: 'Close game now' }));
      vi.mocked(ApiService.getNativeConsoleSnapshot).mockResolvedValue({ ...snapshot, processId: 456, processStartedAt: snapshot.processStartedAt! + 60_000 });
      await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
      await act(async () => { finishClose(); });
      expect(screen.getByText('456')).toBeInTheDocument();
      expect(screen.queryByText('Closing game…')).not.toBeInTheDocument();
      expect(screen.queryByText('Game is still running')).not.toBeInTheDocument();
      expect(ApiService.closeNativeConsoleGame).toHaveBeenCalledTimes(1);
    } finally {
      cleanup();
      vi.useRealTimers();
    }
  });
  it('does not close the game when the Console component unmounts', async () => {
    const view = render(<EnvironmentStatus environmentId="env" onBack={vi.fn()} />);
    await screen.findByText('Test profile'); view.unmount();
    expect(ApiService.closeNativeConsoleGame).not.toHaveBeenCalled();
    expect(ApiService.updateNativeConsoleViewport).toHaveBeenLastCalledWith('env', expect.objectContaining({ visible: false }));
  });
  it('changes configurable sections without discarding other preferences', () => {
    const changed = vi.fn(); render(<ConsolePreferences value={preferences} onChange={changed} />);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Mods and plugins' }));
    expect(changed).toHaveBeenCalledWith({ ...preferences, showMods: false });
  });
  it('refreshes installed versions without restarting the console connection or closing the game', async () => {
    render(<EnvironmentStatus environmentId="env" onBack={vi.fn()} />);
    await screen.findByText('Test mod');
    vi.mocked(ApiService.getNativeConsoleSnapshot).mockResolvedValue({ ...snapshot, entries: [{ ...snapshot.entries[0], version: '2.0.0' }] });
    fireEvent.click(screen.getByRole('button', { name: 'Refresh inventory' }));
    expect(await screen.findByText('2.0.0')).toBeInTheDocument();
    expect(ApiService.openNativeConsole).toHaveBeenLastCalledWith('env', false);
    expect(ApiService.retryNativeConsole).not.toHaveBeenCalled();
    expect(ApiService.closeNativeConsoleGame).not.toHaveBeenCalled();
  });
  it('updates version and enabled status automatically while preserving the inventory filter', async () => {
    let changed: ((event: { environmentId: string }) => void) | undefined;
    vi.mocked(onModsChanged).mockImplementationOnce(async (handler) => { changed = handler; return () => {}; });
    render(<EnvironmentStatus environmentId="env" onBack={vi.fn()} />);
    await screen.findByText('Test mod');
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'TestMod.dll' } });
    vi.mocked(ApiService.getNativeConsoleSnapshot).mockResolvedValue({ ...snapshot, entries: [{ ...snapshot.entries[0], version: '2.1.0', enabled: false }] });
    changed?.({ environmentId: 'env' });
    expect(await screen.findByText('2.1.0')).toBeInTheDocument();
    expect(screen.getByText('Disabled')).toBeInTheDocument();
    expect(screen.getByRole('searchbox')).toHaveValue('TestMod.dll');
    expect(ApiService.openNativeConsole).toHaveBeenCalledTimes(2);
    expect(ApiService.retryNativeConsole).not.toHaveBeenCalled();
    expect(ApiService.closeNativeConsoleGame).not.toHaveBeenCalled();
  });
  it('filters installed inventory by author and file name, and keeps Back independent of game closure', async () => {
    const back = vi.fn();
    render(<EnvironmentStatus environmentId="env" onBack={back} />);
    await screen.findByText('Test profile');
    expect(screen.getByText('Test author')).toBeInTheDocument();
    expect(screen.getByText('TestMod.dll')).toBeInTheDocument();
    expect(screen.getByText('Disabled')).toBeInTheDocument();
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'plugin.dll' } });
    expect(screen.queryByText('Test mod')).not.toBeInTheDocument();
    expect(screen.getByText('Test plugin')).toBeInTheDocument();
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'test author' } });
    expect(screen.getByText('Test mod')).toBeInTheDocument();
    expect(screen.queryByText('Test plugin')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /^Back$/ }));
    expect(back).toHaveBeenCalledOnce();
    expect(ApiService.closeNativeConsoleGame).not.toHaveBeenCalled();
    expect(ApiService.openNativeConsole).toHaveBeenCalledWith('env', false);
  });
});
