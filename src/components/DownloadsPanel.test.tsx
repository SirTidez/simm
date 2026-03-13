import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { DownloadsPanel } from './DownloadsPanel';

const downloadStatusStoreMocks = vi.hoisted(() => ({
  useDownloadStatusStore: vi.fn(),
}));

vi.mock('../stores/downloadStatusStore', () => ({
  useDownloadStatusStore: downloadStatusStoreMocks.useDownloadStatusStore,
}));

describe('DownloadsPanel', () => {
  it('renders mixed downloads with summary', () => {
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
    expect(screen.getByText('Main Branch')).toBeTruthy();
    expect(screen.getByText('ExampleMod.zip')).toBeTruthy();
    expect(screen.getByText('5 / 11 files downloaded')).toBeTruthy();
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

    const progressFill = document.querySelector('.downloads-panel__progress-fill--indeterminate');
    expect(progressFill).not.toBeNull();
  });

  it('shows the empty state when there are no tracked downloads', () => {
    downloadStatusStoreMocks.useDownloadStatusStore.mockReturnValue({
      downloads: [],
    });

    render(<DownloadsPanel />);

    expect(screen.getByText('No active or recent downloads.')).toBeTruthy();
    expect(screen.getByText('0 / 0 files downloaded')).toBeTruthy();
  });
});
