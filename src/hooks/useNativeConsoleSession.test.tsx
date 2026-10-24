import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiService } from '../services/api';
import { onModsChanged, onPluginsChanged } from '../services/events';
import type { NativeConsoleSnapshot } from '../types';
import { useNativeConsoleSession } from './useNativeConsoleSession';

vi.mock('../services/api', () => ({ ApiService: { openNativeConsole: vi.fn(), getNativeConsoleSnapshot: vi.fn() } }));
vi.mock('../services/events', async (importOriginal) => ({
  ...await importOriginal<typeof import('../services/events')>(),
  onModsChanged: vi.fn(), onPluginsChanged: vi.fn(),
}));

const value = (version: string) => ({
  environment: { id: 'env' }, status: 'docked',
  entries: [{ name: 'Mod', version, enabled: true, kind: 'Mod' }],
} as NativeConsoleSnapshot);
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
};
let mods: (event: { environmentId: string }) => void;
let plugins: (event: { environmentId: string }) => void;
let unlistenMods = vi.fn<() => void>();
let unlistenPlugins = vi.fn<() => void>();
const flush = () => act(async () => {});
const tick = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

beforeEach(() => {
  vi.useFakeTimers();
  vi.resetAllMocks();
  unlistenMods = vi.fn(); unlistenPlugins = vi.fn();
  vi.mocked(onModsChanged).mockImplementation(async (handler) => { mods = handler; return unlistenMods; });
  vi.mocked(onPluginsChanged).mockImplementation(async (handler) => { plugins = handler; return unlistenPlugins; });
  vi.mocked(ApiService.openNativeConsole).mockResolvedValue();
  vi.mocked(ApiService.getNativeConsoleSnapshot).mockResolvedValue(value('1.0'));
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe('automatic native console inventory', () => {
  it('does not let an older poll overwrite a saved presentation or layout', async () => {
    const { result } = renderHook(() => useNativeConsoleSession('env'));
    await flush();
    const old = deferred<NativeConsoleSnapshot>();
    vi.mocked(ApiService.getNativeConsoleSnapshot).mockImplementationOnce(() => old.promise);
    await tick(1000);
    const updated = { ...value('2.0'), presentation: 'popout' as const, preferences: { sidebarWidth: 440 } } as NativeConsoleSnapshot;
    act(() => result.current.setSnapshot(updated));
    await act(async () => old.resolve(value('1.0')));
    expect(result.current.snapshot).toEqual(updated);
  });
  it('filters environment events and combines mod/plugin bursts into one scan', async () => {
    const { result } = renderHook(() => useNativeConsoleSession('env'));
    await flush();
    expect(result.current.ready).toBe(true);
    act(() => { mods({ environmentId: 'another' }); plugins({ environmentId: 'another' }); });
    await tick(250);
    expect(ApiService.openNativeConsole).toHaveBeenCalledTimes(1);
    const updated = { ...value('2.0'), entries: [{ ...value('2.0').entries[0], enabled: false }] };
    vi.mocked(ApiService.getNativeConsoleSnapshot).mockResolvedValue(updated);
    act(() => { mods({ environmentId: 'env' }); plugins({ environmentId: 'env' }); mods({ environmentId: 'env' }); });
    await tick(199);
    expect(ApiService.openNativeConsole).toHaveBeenCalledTimes(1);
    await tick(1);
    expect(ApiService.openNativeConsole).toHaveBeenCalledTimes(2);
    expect(ApiService.openNativeConsole).toHaveBeenLastCalledWith('env', false);
    expect(result.current.snapshot?.entries[0]).toMatchObject({ version: '2.0', enabled: false });
  });

  it('retains one trailing scan for changes during initialization without overlapping scans', async () => {
    const initial = deferred<void>();
    vi.mocked(ApiService.openNativeConsole).mockImplementationOnce(() => initial.promise);
    vi.mocked(ApiService.getNativeConsoleSnapshot).mockResolvedValueOnce(value('1.0')).mockResolvedValue(value('2.0'));
    const { result } = renderHook(() => useNativeConsoleSession('env'));
    await flush();
    act(() => mods({ environmentId: 'env' })); await tick(200);
    act(() => plugins({ environmentId: 'env' })); await tick(200);
    expect(ApiService.openNativeConsole).toHaveBeenCalledTimes(1);
    await act(async () => { initial.resolve(); });
    expect(ApiService.openNativeConsole).toHaveBeenCalledTimes(2);
    expect(result.current.snapshot?.entries[0].version).toBe('2.0');
    expect(result.current.refreshing).toBe(false);
  });

  it('does not let a delayed status poll overwrite a newer inventory refresh', async () => {
    const oldPoll = deferred<NativeConsoleSnapshot>();
    const { result } = renderHook(() => useNativeConsoleSession('env'));
    await flush();
    vi.mocked(ApiService.getNativeConsoleSnapshot).mockImplementationOnce(() => oldPoll.promise).mockResolvedValue(value('2.0'));
    await tick(1000);
    act(() => mods({ environmentId: 'env' })); await tick(200);
    expect(result.current.snapshot?.entries[0].version).toBe('2.0');
    await act(async () => oldPoll.resolve(value('1.0')));
    expect(result.current.snapshot?.entries[0].version).toBe('2.0');
  });

  it('ignores old environment work and disposes its listeners on navigation', async () => {
    const old = deferred<void>();
    vi.mocked(ApiService.openNativeConsole).mockImplementationOnce(() => old.promise);
    const view = renderHook(({ id }) => useNativeConsoleSession(id), { initialProps: { id: 'old' } });
    await flush();
    const oldChanged = mods;
    view.rerender({ id: 'new' }); await flush();
    expect(unlistenMods).toHaveBeenCalledOnce();
    await act(async () => { oldChanged({ environmentId: 'old' }); old.resolve(); });
    await tick(250);
    expect(vi.mocked(ApiService.openNativeConsole).mock.calls.map(([id]) => id)).toEqual(['old', 'new']);
    expect(ApiService.getNativeConsoleSnapshot).toHaveBeenCalledWith('new');
    expect(ApiService.getNativeConsoleSnapshot).not.toHaveBeenCalledWith('old');
    view.unmount();
    expect(unlistenMods).toHaveBeenCalledTimes(2);
    expect(unlistenPlugins).toHaveBeenCalledTimes(2);
  });

  it('disposes a subscription that registers after unmount and cancels queued work', async () => {
    const late = deferred<() => void>();
    vi.mocked(onPluginsChanged).mockImplementationOnce((handler) => { plugins = handler; return late.promise; });
    const view = renderHook(() => useNativeConsoleSession('env'));
    await flush();
    act(() => mods({ environmentId: 'env' }));
    view.unmount();
    await act(async () => late.resolve(unlistenPlugins));
    act(() => plugins({ environmentId: 'env' }));
    await tick(2000);
    expect(unlistenMods).toHaveBeenCalledOnce();
    expect(unlistenPlugins).toHaveBeenCalledOnce();
    expect(ApiService.openNativeConsole).not.toHaveBeenCalled();
  });

  it('retains the displayed inventory after a failed refresh and recovers on the next change', async () => {
    const { result } = renderHook(() => useNativeConsoleSession('env'));
    await flush();
    vi.mocked(ApiService.openNativeConsole).mockRejectedValueOnce(new Error('File busy'));
    act(() => mods({ environmentId: 'env' })); await tick(200);
    expect(result.current.error).toContain('File busy');
    expect(result.current.snapshot?.entries[0].version).toBe('1.0');
    vi.mocked(ApiService.getNativeConsoleSnapshot).mockResolvedValue(value('3.0'));
    act(() => plugins({ environmentId: 'env' })); await tick(200);
    expect(result.current.snapshot?.entries[0].version).toBe('3.0');
    expect(result.current.error).toBeNull();
  });
});
