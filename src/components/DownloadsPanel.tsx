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

function isIndeterminate(download: TrackedDownload) {
  return (
    download.kind !== 'game' &&
    (download.status === 'downloading' || download.status === 'queued' || download.status === 'validating')
  );
}

export function DownloadsPanel() {
  const { downloads } = useDownloadStatusStore();

  const summary = useMemo(() => {
    return downloads.reduce(
      (aggregate, download) => {
        if (typeof download.totalFiles === 'number') {
          aggregate.total += download.totalFiles;
        }
        if (typeof download.downloadedFiles === 'number') {
          aggregate.downloaded += download.downloadedFiles;
        }
        return aggregate;
      },
      { downloaded: 0, total: 0 }
    );
  }, [downloads]);

  return (
    <section className="downloads-panel" aria-label="Downloads">
      <div className="downloads-panel__header">
        <h3>Downloads</h3>
        <span className="downloads-panel__count">{downloads.length}</span>
      </div>

      {downloads.length === 0 ? (
        <p className="downloads-panel__empty">No active or recent downloads.</p>
      ) : (
        <div className="downloads-panel__list">
          {downloads.map((download) => (
            <article className="downloads-panel__row" key={download.id}>
              <div className="downloads-panel__row-top">
                <div className="downloads-panel__label-block">
                  <span className="downloads-panel__label">{download.label}</span>
                  <span className="downloads-panel__context">
                    {kindLabel(download.kind)} • {download.contextLabel}
                  </span>
                </div>
                <span className={`downloads-panel__status downloads-panel__status--${download.status}`}>
                  {statusLabel(download.status)}
                </span>
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

              <div className="downloads-panel__meta">
                {download.kind === 'game' ? (
                  <>
                    <span>{Math.round(download.progress)}%</span>
                    {typeof download.downloadedFiles === 'number' && typeof download.totalFiles === 'number' && (
                      <span>{download.downloadedFiles} / {download.totalFiles} files</span>
                    )}
                  </>
                ) : (
                  <>
                    {typeof download.downloadedFiles === 'number' && typeof download.totalFiles === 'number' && (
                      <span>{download.downloadedFiles} / {download.totalFiles} file{download.totalFiles === 1 ? '' : 's'}</span>
                    )}
                    {download.message && <span>{download.message}</span>}
                  </>
                )}
                {download.error && <span className="downloads-panel__error">{download.error}</span>}
              </div>
            </article>
          ))}
        </div>
      )}

      <div className="downloads-panel__summary">
        {summary.downloaded} / {summary.total} files downloaded
      </div>
    </section>
  );
}
