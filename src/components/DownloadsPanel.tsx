import { useMemo } from 'react';

import type { TrackedDownload } from '../types';
import { useDownloadStatusStore } from '../stores/downloadStatusStore';

function statusLabel(status: TrackedDownload['status']) {
  switch (status) {
    case 'queued':
      return 'Queued';
    case 'downloading':
      return 'Downloading';
    case 'validating':
      return 'Validating';
    case 'completed':
      return 'Completed';
    case 'error':
      return 'Failed';
    case 'cancelled':
      return 'Cancelled';
    default:
      return status;
  }
}

function kindLabel(kind: TrackedDownload['kind']) {
  switch (kind) {
    case 'game':
      return 'Game';
    case 'mod':
      return 'Mod';
    case 'plugin':
      return 'Plugin';
    case 'framework':
      return 'Framework';
    default:
      return kind;
  }
}

function kindIcon(kind: TrackedDownload['kind']) {
  switch (kind) {
    case 'game':
      return 'fas fa-gamepad';
    case 'mod':
      return 'fas fa-puzzle-piece';
    case 'plugin':
      return 'fas fa-plug';
    case 'framework':
      return 'fas fa-cubes';
    default:
      return 'fas fa-file';
  }
}

function isActiveStatus(status: TrackedDownload['status']) {
  return status === 'queued' || status === 'downloading' || status === 'validating';
}

function isIndeterminate(download: TrackedDownload) {
  return (
    download.kind !== 'game' &&
    (download.status === 'downloading' || download.status === 'queued' || download.status === 'validating')
  );
}

function progressText(download: TrackedDownload) {
  if (download.kind === 'game') {
    if (hasUsableFileCounts(download)) {
      return `${Math.round(download.progress)}% • ${download.downloadedFiles} / ${download.totalFiles} files`;
    }
    return `${Math.round(download.progress)}%`;
  }

  if (hasUsableFileCounts(download)) {
    return `${download.downloadedFiles} / ${download.totalFiles} file${download.totalFiles === 1 ? '' : 's'}`;
  }

  return download.message || statusLabel(download.status);
}

function hasUsableFileCounts(download: Pick<TrackedDownload, 'downloadedFiles' | 'totalFiles'>) {
  const downloaded = typeof download.downloadedFiles === 'number' ? download.downloadedFiles : Number.NaN;
  const total = typeof download.totalFiles === 'number' ? download.totalFiles : Number.NaN;
  return Number.isFinite(downloaded) && Number.isFinite(total) && total > 0;
}

function renderDownloadRow(download: TrackedDownload) {
  const recentRow = !isActiveStatus(download.status);
  return (
    <article className={`downloads-panel__row downloads-panel__row--${download.status} ${recentRow ? 'downloads-panel__row--recent' : 'downloads-panel__row--active'}`} key={download.id}>
      <div className="downloads-panel__row-top">
        <span className="downloads-panel__label">{download.label}</span>
      </div>

      <div className="downloads-panel__row-meta">
        <span className="downloads-panel__kind">
          <i className={kindIcon(download.kind)} aria-hidden="true"></i>
          {kindLabel(download.kind)}
        </span>
        <span className={`downloads-panel__status downloads-panel__status--${download.status}`}>
          {statusLabel(download.status)}
        </span>
        <span className="downloads-panel__context" title={download.contextLabel}>{download.contextLabel}</span>
      </div>

      <div className="downloads-panel__row-middle">
        <span className="downloads-panel__progress-text">{progressText(download)}</span>
      </div>

      <div className="downloads-panel__progress-bar">
        <div
          className={
            isIndeterminate(download)
              ? 'downloads-panel__progress-fill downloads-panel__progress-fill--indeterminate'
              : 'downloads-panel__progress-fill'
          }
          style={isIndeterminate(download) ? undefined : { width: `${Math.min(100, Math.max(0, download.progress))}%` }}
        />
      </div>

      {(download.message || download.error) && (
        <div className="downloads-panel__row-bottom">
          {download.message && !isIndeterminate(download) && <span>{download.message}</span>}
          {download.error && <span className="downloads-panel__error">{download.error}</span>}
        </div>
      )}
    </article>
  );
}

export function DownloadsPanel() {
  const { downloads } = useDownloadStatusStore();

  const { activeDownloads, recentDownloads, summary } = useMemo(() => {
    const grouped = downloads.reduce(
      (aggregate, download) => {
        if (typeof download.totalFiles === 'number') {
          aggregate.summary.totalFiles += download.totalFiles;
        }
        if (typeof download.downloadedFiles === 'number') {
          aggregate.summary.downloadedFiles += download.downloadedFiles;
        }

        if (isActiveStatus(download.status)) {
          aggregate.activeDownloads.push(download);
        } else {
          aggregate.recentDownloads.push(download);
        }

        return aggregate;
      },
      {
        activeDownloads: [] as TrackedDownload[],
        recentDownloads: [] as TrackedDownload[],
        summary: {
          activeCount: 0,
          recentCount: 0,
          downloadedFiles: 0,
          totalFiles: 0,
        },
      }
    );

    grouped.summary.activeCount = grouped.activeDownloads.length;
    grouped.summary.recentCount = grouped.recentDownloads.length;

    return grouped;
  }, [downloads]);

  return (
    <section className="downloads-panel" aria-label="Downloads">
      <div className="downloads-panel__header">
        <div className="downloads-panel__header-copy">
          <h3>Downloads</h3>
          <p>Track active transfers and the most recent results.</p>
        </div>
        <span className="downloads-panel__count">{summary.activeCount}</span>
      </div>

      <div className="downloads-panel__summary-strip">
        <div className="downloads-panel__summary-chip">
          <span>Active</span>
          <strong>{summary.activeCount}</strong>
        </div>
        <div className="downloads-panel__summary-chip">
          <span>Recent</span>
          <strong>{summary.recentCount}</strong>
        </div>
        <div className="downloads-panel__summary-chip downloads-panel__summary-chip--files">
          <span>Files</span>
          <strong>{summary.totalFiles > 0 ? `${summary.downloadedFiles}/${summary.totalFiles}` : '0'}</strong>
        </div>
      </div>

      {downloads.length === 0 ? (
        <p className="downloads-panel__empty">Active and recent downloads will appear here while SIMM is working.</p>
      ) : (
        <div className="downloads-panel__sections">
          {activeDownloads.length > 0 && (
            <div className="downloads-panel__section">
              <div className="downloads-panel__section-header">Active</div>
              <div className="downloads-panel__list">
                {activeDownloads.map(renderDownloadRow)}
              </div>
            </div>
          )}

          {recentDownloads.length > 0 && (
            <div className="downloads-panel__section">
              <div className="downloads-panel__section-header">Recent</div>
              <div className="downloads-panel__list">
                {recentDownloads.map(renderDownloadRow)}
              </div>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
