import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useNativeConsoleViewport } from './useNativeConsoleViewport';
import { ApiService } from '../services/api';

vi.mock('../services/api', () => ({ ApiService: { updateNativeConsoleViewport: vi.fn().mockResolvedValue(undefined) } }));
let element: HTMLDivElement;
const bounds = (x: number, y: number, width: number, height: number) => ({ x, y, left: x, top: y, right: x + width, bottom: y + height, width, height, toJSON() {} });
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  element = document.createElement('div');
  element.getBoundingClientRect = () => bounds(224, 120, 600, 400);
  document.body.append(element);
});
afterEach(() => { cleanup(); element.remove(); vi.unstubAllGlobals(); });

describe('native console workspace visibility', () => {
  it('hides the companion when its tab is inactive and restores the same viewport on return', async () => {
    const view = renderHook(({ active }) => useNativeConsoleViewport('env', { current: element }, active, vi.fn()), { initialProps: { active: true } });
    await waitFor(() => expect(ApiService.updateNativeConsoleViewport).toHaveBeenLastCalledWith('env', expect.objectContaining({ visible: true })));
    view.rerender({ active: false });
    expect(ApiService.updateNativeConsoleViewport).toHaveBeenLastCalledWith('env', expect.objectContaining({ visible: false }));
    view.rerender({ active: true });
    await waitFor(() => expect(ApiService.updateNativeConsoleViewport).toHaveBeenLastCalledWith('env', expect.objectContaining({ visible: true, width: 600, height: 400 })));
  });
  it('reports the actual pane and hides it for an overlapping dialog, then restores it', async () => {
    const reportError = vi.fn();
    const view = renderHook(() => useNativeConsoleViewport('env', { current: element }, true, reportError));
    await waitFor(() => expect(ApiService.updateNativeConsoleViewport).toHaveBeenLastCalledWith('env', expect.objectContaining({ x: 224, y: 120, width: 600, height: 400, visible: true })));
    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    dialog.getBoundingClientRect = () => bounds(300, 150, 200, 200);
    act(() => { document.body.append(dialog); });
    await waitFor(() => expect(ApiService.updateNativeConsoleViewport).toHaveBeenLastCalledWith('env', expect.objectContaining({ visible: false })));
    act(() => dialog.remove());
    await waitFor(() => expect(ApiService.updateNativeConsoleViewport).toHaveBeenLastCalledWith('env', expect.objectContaining({ visible: true })));
    view.unmount();
    expect(ApiService.updateNativeConsoleViewport).toHaveBeenLastCalledWith('env', expect.objectContaining({ visible: false }));
    const revisions = vi.mocked(ApiService.updateNativeConsoleViewport).mock.calls.map(([, viewport]) => viewport.revision);
    expect(revisions.every((value, index) => index === 0 || value > revisions[index - 1])).toBe(true);
    expect(reportError).toHaveBeenLastCalledWith(null);
  });
  it('keeps the console visible for a sidebar confirmation outside the pane', async () => {
    const reportError = vi.fn();
    renderHook(() => useNativeConsoleViewport('env', { current: element }, true, reportError));
    await waitFor(() => expect(ApiService.updateNativeConsoleViewport).toHaveBeenCalled());
    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'alertdialog');
    dialog.getBoundingClientRect = () => bounds(850, 450, 250, 150);
    act(() => document.body.append(dialog));
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(ApiService.updateNativeConsoleViewport).toHaveBeenLastCalledWith('env', expect.objectContaining({ visible: true }));
    dialog.remove();
  });
});
