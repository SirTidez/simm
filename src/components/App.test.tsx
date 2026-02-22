import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { App } from './App';
import type { ReactNode } from 'react';

const invokeMock = vi.hoisted(() => vi.fn());

vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock,
}));

vi.mock('../stores/environmentStore', () => ({
  EnvironmentStoreProvider: ({ children }: { children: ReactNode }) => children,
}));

vi.mock('../stores/settingsStore', () => ({
  SettingsStoreProvider: ({ children }: { children: ReactNode }) => children,
}));

vi.mock('../utils/logger', () => ({
  interceptConsole: vi.fn(),
}));

vi.mock('./ErrorBoundary', () => ({
  ErrorBoundary: ({ children }: { children: ReactNode }) => children,
}));

vi.mock('./EnvironmentList', () => ({
  EnvironmentList: ({ onInitialDetectionComplete }: { onInitialDetectionComplete?: () => void }) => (
    <button onClick={onInitialDetectionComplete}>Finish Detection</button>
  ),
}));

vi.mock('./EnvironmentCreationWizard', () => ({
  EnvironmentCreationWizard: ({ onClose }: { onClose: () => void }) => (
    <div>
      <span>Wizard Overlay</span>
      <button onClick={onClose}>Close Wizard</button>
    </div>
  ),
}));

vi.mock('./ModLibraryOverlay', () => ({
  ModLibraryOverlay: ({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) =>
    isOpen ? (
      <div>
        <span>Mod Library Overlay</span>
        <button onClick={onClose}>Close Mod Library</button>
      </div>
    ) : null,
}));

vi.mock('./SteamAccountOverlay', () => ({
  SteamAccountOverlay: ({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) =>
    isOpen ? (
      <div>
        <span>Steam Overlay</span>
        <button onClick={onClose}>Close Steam</button>
      </div>
    ) : null,
}));

vi.mock('./HelpOverlay', () => ({
  HelpOverlay: ({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) =>
    isOpen ? (
      <div>
        <span>Help Overlay</span>
        <button onClick={onClose}>Close Help</button>
      </div>
    ) : null,
}));

vi.mock('./WelcomeOverlay', () => ({
  WelcomeOverlay: ({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) =>
    isOpen ? (
      <div>
        <span>Welcome Overlay</span>
        <button onClick={onClose}>Close Welcome</button>
      </div>
    ) : null,
}));

vi.mock('./Settings', () => ({
  Settings: () => <button>Settings</button>,
}));

vi.mock('./Footer', () => ({
  Footer: () => <div>Footer</div>,
}));

describe('App', () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockResolvedValue(false);
  });

  afterEach(() => {
    cleanup();
  });

  it('hides startup splash when initial detection completes', async () => {
    render(<App />);

    expect(screen.getByText('Detecting game and MelonLoader versions')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Finish Detection' }));

    await waitFor(() => {
      expect(screen.queryByText('Detecting game and MelonLoader versions')).toBeNull();
    });
  });

  it('opens and closes overlays from sidebar/header controls', async () => {
    render(<App />);

    fireEvent.click(screen.getByRole('button', { name: 'Mod Library' }));
    expect(await screen.findByText('Mod Library Overlay')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Close Mod Library' }));
    await waitFor(() => expect(screen.queryByText('Mod Library Overlay')).toBeNull());

    fireEvent.click(screen.getByRole('button', { name: 'New Environment' }));
    expect(await screen.findByText('Wizard Overlay')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Close Wizard' }));
    await waitFor(() => expect(screen.queryByText('Wizard Overlay')).toBeNull());

    fireEvent.click(screen.getByRole('button', { name: 'Accounts' }));
    expect(await screen.findByText('Steam Overlay')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Close Steam' }));
    await waitFor(() => expect(screen.queryByText('Steam Overlay')).toBeNull());

    fireEvent.click(screen.getByRole('button', { name: 'Help' }));
    expect(await screen.findByText('Help Overlay')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Close Help' }));
    await waitFor(() => expect(screen.queryByText('Help Overlay')).toBeNull());
  });
});
