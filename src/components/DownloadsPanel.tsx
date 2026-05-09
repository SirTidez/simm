import { useMemo } from 'react';

import { Progress } from '@/components/ui/progress';

import type { TrackedDownload } from '../types';
import { useDownloadStatusStore } from '../stores/downloadStatusStore';
import { Icon } from './Icon';
import type { IconName } from './icons';
import { resolveImageSource } from './modCardHelpers';
import { SimmBadge, SimmButton } from './primitives';

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

function kindIcon(kind: TrackedDownload['kind']): IconName {
  switch (kind) {
    case 'game':
      return 'gamepad';
    case 'mod':
      return 'puzzlePiece';
    case 'plugin':
      return 'plug';
    case 'framework':
      return 'cubes';
    default:
      return 'file';
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

interface DownloadsPanelProps {
  presentation?: 'panel' | 'popup';
  onClose?: () => void;
}

function progressText(download: TrackedDownload) {
  if (download.kind === 'game') {
    if (hasUsableFileCounts(download)) {
      return `${Math.round(download.progress)}% - ${download.downloadedFiles} / ${download.totalFiles} files`;
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

function getProgressValue(download: TrackedDownload) {
  return Math.min(100, Math.max(0, download.progress));
}

function renderDownloadRow(download: TrackedDownload) {
  const recentRow = !isActiveStatus(download.status);
  const localIcon = resolveImageSource(download.iconCachePath);
  const remoteIcon = resolveImageSource(download.iconUrl);
  const iconSource = localIcon || remoteIcon;
  const indeterminate = isIndeterminate(download);

  return (
    <article className={`downloads-panel__row downloads-panel__row--${download.status} ${recentRow ? 'downloads-panel__row--recent' : 'downloads-panel__row--active'}`} key={download.id}>
      <div className="downloads-panel__row-main">
        <div className="downloads-panel__identity">
          {iconSource ? (
            <img
              src={iconSource}
              alt=""
              className="downloads-panel__icon-image"
              aria-hidden="true"
              onError={(event) => {
                if (remoteIcon && event.currentTarget.src !== remoteIcon) {
                  event.currentTarget.src = remoteIcon;
                  return;
                }
                event.currentTarget.style.display = 'none';
              }}
            />
          ) : (
            <span className="downloads-panel__icon" aria-hidden="true">
              <Icon name={kindIcon(download.kind)} />
            </span>
          )}
          <span className="downloads-panel__label">
            {download.label}
            <span className="downloads-panel__context" title={download.contextLabel}> - {download.contextLabel}</span>
          </span>
        </div>

        <SimmBadge
          variant={isActiveStatus(download.status) ? 'secondary' : 'outline'}
          className={`downloads-panel__status-text downloads-panel__status-text--${download.status}`}
        >
          {isActiveStatus(download.status) ? progressText(download) : statusLabel(download.status)}
        </SimmBadge>
      </div>

      <Progress
        value={indeterminate ? null : getProgressValue(download)}
        className={`downloads-panel__progress-bar${indeterminate ? ' downloads-panel__progress-bar--indeterminate' : ''}`}
        aria-label={`${download.label} download progress`}
      />

      {(download.message || download.error) && (
        <div className="downloads-panel__row-bottom">
          {download.message && !isIndeterminate(download) && download.status !== 'completed' && <span>{download.message}</span>}
          {download.error && <span className="downloads-panel__error">{download.error}</span>}
        </div>
      )}
    </article>
  );
}

export function DownloadsPanel({ presentation = 'panel', onClose }: DownloadsPanelProps = {}) {
  const { downloads } = useDownloadStatusStore();

  const { activeDownloads, recentDownloads } = useMemo(() => {
    const grouped = downloads.reduce(
      (aggregate, download) => {
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
      }
    );

    return grouped;
  }, [downloads]);

  const visibleRecentDownloads = presentation === 'popup' ? recentDownloads.slice(0, 2) : recentDownloads;

  return (
    <section className={`downloads-panel downloads-panel--${presentation}`} aria-label="Downloads">
      <div className="downloads-panel__header">
        <div className="downloads-panel__header-copy">
          <h3>Downloads</h3>
        </div>
        <div className="downloads-panel__header-actions">
          {onClose && (
            <SimmButton
              type="button"
              variant="ghost"
              size="icon-sm"
              className="downloads-panel__close"
              onClick={onClose}
              aria-label="Close downloads"
            >
              <Icon name="times" />
            </SimmButton>
          )}
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

          {visibleRecentDownloads.length > 0 && (
            <div className="downloads-panel__section">
              <div className="downloads-panel__section-header">Recent</div>
              <div className="downloads-panel__list">
                {visibleRecentDownloads.map(renderDownloadRow)}
              </div>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
