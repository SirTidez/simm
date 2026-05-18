import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

import { DownloadsPanel } from './DownloadsPanel';

const downloadStatusStoreMocks = vi.hoisted(() => ({
  useDownloadStatusStore: vi.fn(),
}));

vi.mock('../stores/downloadStatusStore', () => ({
  useDownloadStatusStore: downloadStatusStoreMocks.useDownloadStatusStore,
}));

describe('DownloadsPanel', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('renders active and recent downloads in separate groups', () => {
    downloadStatusStoreMocks.useDownloadStatusStore.mockReturnValue({
      downloads: [
        {
          id: 'game-1',
          kind: 'game',
          label: 'Main Branch',
          contextLabel: 'Game download',
          status: 'downloading',
          progress: 40,
          downloadedFiles: 4,
          totalFiles: 10,
          iconUrl: 'https://example.com/main-branch.png',
          startedAt: Date.now(),
        },
        {
          id: 'mod-1',
          kind: 'mod',
          label: 'ExampleMod.zip',
          contextLabel: 'Thunderstore',
          status: 'completed',
          progress: 100,
          downloadedFiles: 1,
          totalFiles: 1,
          message: 'Archive downloaded',
          startedAt: Date.now() - 1000,
          finishedAt: Date.now(),
        },
      ],
    });

    render(<DownloadsPanel />);

    expect(screen.getByText('Downloads')).toBeTruthy();
    expect(screen.getAllByText('Active').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Recent').length).toBeGreaterThan(0);
    expect(screen.getByText('Main Branch')).toBeTruthy();
    expect(screen.getByText('ExampleMod.zip')).toBeTruthy();
    expect(document.querySelector('.downloads-panel__icon-image')).not.toBeNull();
    expect(screen.getByText('40% - 4 / 10 files')).toBeTruthy();
  });

  it('renders an indeterminate bar for active non-game downloads', () => {
    downloadStatusStoreMocks.useDownloadStatusStore.mockReturnValue({
      downloads: [
        {
          id: 'framework-1',
          kind: 'framework',
          label: 'MelonLoader.zip',
          contextLabel: 'Main Branch',
          status: 'downloading',
          progress: 0,
          downloadedFiles: 0,
          totalFiles: 1,
          startedAt: Date.now(),
        },
      ],
    });

    render(<DownloadsPanel />);

    const progressBar = document.querySelector('.downloads-panel__progress-bar--indeterminate');
    expect(progressBar).not.toBeNull();
    expect(progressBar?.querySelector('[data-slot="progress-indicator"]')).not.toBeNull();
  });

  it('shows an error row inside recent downloads', () => {
    downloadStatusStoreMocks.useDownloadStatusStore.mockReturnValue({
      downloads: [
        {
          id: 'plugin-1',
          kind: 'plugin',
          label: 'RuntimeFix.dll',
          contextLabel: 'GitHub',
          status: 'error',
          progress: 60,
          message: 'Download failed',
          error: 'Network connection lost',
          startedAt: Date.now() - 1000,
          finishedAt: Date.now(),
        },
      ],
    });

    render(<DownloadsPanel />);

    expect(screen.getAllByText('Recent').length).toBeGreaterThan(0);
    expect(screen.getByText('Network connection lost')).toBeTruthy();
  });

  it('shows the empty state when there are no tracked downloads', () => {
    downloadStatusStoreMocks.useDownloadStatusStore.mockReturnValue({
      downloads: [],
    });

    render(<DownloadsPanel />);

    expect(screen.getByText('Active and recent downloads will appear here while SIMM is working.')).toBeTruthy();
    expect(screen.queryByText('0')).toBeNull();
  });
});
