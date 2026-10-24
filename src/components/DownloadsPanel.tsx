import { useCallback, useMemo, useState } from 'react';

import { Progress } from '@/components/ui/progress';

import type { TrackedDownload } from '../types';
import { useDownloadStatusStore } from '../stores/downloadStatusStore';
import { useEnvironmentStore } from '../stores/environmentStore';
import { getErrorMessage } from '../utils/errors';
import { Icon } from './Icon';
import type { IconName } from './icons';
import { GameArt } from './media/GameArt';
import { ModThumbnail } from './media/ModThumbnail';
import { SimmButton } from './primitives';

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
    case 'collection':
      return 'layerGroup';
    default:
      return 'file';
  }
}

function isActiveStatus(status: TrackedDownload['status']) {
  return status === 'queued' || status === 'downloading' || status === 'validating';
}

function isIndeterminate(download: TrackedDownload) {
  const active = download.status === 'downloading' || download.status === 'queued' || download.status === 'validating';
  return active && (download.kind !== 'game' || !hasUsableByteCounts(download));
}

interface DownloadsPanelProps {
  presentation?: 'panel' | 'popup';
  onClose?: () => void;
  onOpenProfile?: (profileId: string) => void;
}

function progressText(download: TrackedDownload) {
  if (download.kind === 'game') {
    if (hasUsableByteCounts(download)) {
      const percent = Math.min(isActiveStatus(download.status) ? 99 : 100, Math.round(download.progress));
      return `${percent}% · ${formatBytes(download.downloadedBytes!)} of ${formatBytes(download.totalBytes!)}`;
    }
    if (typeof download.downloadedBytes === 'number' && download.downloadedBytes > 0) {
      return `${formatBytes(download.downloadedBytes)} downloaded`;
    }
    if (isActiveStatus(download.status)) {
      return 'Calculating total…';
    }
    if (hasUsableFileCounts(download)) {
      return `${Math.round(download.progress)}%`;
    }
    return `${Math.round(download.progress)}%`;
  }

  if (hasUsableFileCounts(download)) {
    return `${download.downloadedFiles} / ${download.totalFiles} file${download.totalFiles === 1 ? '' : 's'}`;
  }

  return download.message || statusLabel(download.status);
}

function formatBytes(bytes: number) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = Math.max(0, bytes);
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const precision = value >= 100 || unitIndex === 0 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(precision)} ${units[unitIndex]}`;
}

function hasUsableByteCounts(download: Pick<TrackedDownload, 'downloadedBytes' | 'totalBytes'>) {
  const downloaded = typeof download.downloadedBytes === 'number' ? download.downloadedBytes : Number.NaN;
  const total = typeof download.totalBytes === 'number' ? download.totalBytes : Number.NaN;
  return Number.isFinite(downloaded) && Number.isFinite(total) && downloaded >= 0 && total > 0;
}

function hasUsableFileCounts(download: Pick<TrackedDownload, 'downloadedFiles' | 'totalFiles'>) {
  const downloaded = typeof download.downloadedFiles === 'number' ? download.downloadedFiles : Number.NaN;
  const total = typeof download.totalFiles === 'number' ? download.totalFiles : Number.NaN;
  return Number.isFinite(downloaded) && Number.isFinite(total) && total > 0;
}

function getProgressValue(download: TrackedDownload) {
  return Math.min(100, Math.max(0, download.progress));
}

function gameEnvironmentId(download: TrackedDownload) {
  return download.kind === 'game' && download.id.startsWith('game:') ? download.id.slice('game:'.length) : null;
}

interface DownloadRowProps {
  download: TrackedDownload;
  /** Steam app id of the environment a game download belongs to. */
  gameAppId?: string | null;
  onOpenProfile?: (profileId: string) => void;
  onCancel?: (environmentId: string) => void;
  cancelling: boolean;
}

function DownloadMedia({ download, gameAppId }: { download: TrackedDownload; gameAppId?: string | null }) {
  if (download.kind === 'game' && gameAppId) {
    // The kind icon sits underneath, so it shows again if the art cannot load (offline).
    return (
      <span className="downloads-panel__media downloads-panel__media--wide" aria-hidden="true">
        <Icon name={kindIcon(download.kind)} />
        <GameArt appId={gameAppId} className="downloads-panel__game-art" />
      </span>
    );
  }
  if (download.iconUrl || download.iconCachePath) {
    return (
      <ModThumbnail
        iconUrl={download.iconUrl}
        iconCachePath={download.iconCachePath}
        name={download.label}
        size={32}
        className={`downloads-panel__thumb${download.kind === 'collection' ? ' downloads-panel__thumb--banner' : ''}`}
      />
    );
  }
  return (
    <span className="downloads-panel__media" aria-hidden="true">
      <Icon name={kindIcon(download.kind)} />
    </span>
  );
}

function DownloadRow({ download, gameAppId, onOpenProfile, onCancel, cancelling }: DownloadRowProps) {
  const active = isActiveStatus(download.status);
  const indeterminate = isIndeterminate(download);
  const cancelEnvironmentId = active && onCancel ? gameEnvironmentId(download) : null;
  const showMessage = Boolean(download.message)
    && active
    && (download.kind === 'game' || !indeterminate);
  const stateText = active ? progressText(download) : statusLabel(download.status);

  return (
    <li className={`downloads-panel__row downloads-panel__row--${download.status}`}>
      <DownloadMedia download={download} gameAppId={gameAppId} />

      <div className="downloads-panel__body">
        <span className="downloads-panel__label" title={download.label}>{download.label}</span>
        <div className="downloads-panel__meta">
          <span className="downloads-panel__context" title={download.contextLabel}>{download.contextLabel}</span>
          <span className={`downloads-panel__state downloads-panel__state--${download.status}`}>{stateText}</span>
        </div>
        {active && (
          <Progress
            value={indeterminate ? null : getProgressValue(download)}
            className={`downloads-panel__progress-bar${indeterminate ? ' downloads-panel__progress-bar--indeterminate' : ''}`}
            aria-label={`${download.label} download progress`}
          />
        )}
        {showMessage && <span className="downloads-panel__message" title={download.message}>{download.message}</span>}
        {download.error && <p className="downloads-panel__error" title={download.error}>{download.error}</p>}
      </div>

      {cancelEnvironmentId ? (
        <SimmButton
          type="button"
          variant="ghost"
          size="sm"
          className="downloads-panel__action"
          onClick={() => onCancel?.(cancelEnvironmentId)}
          disabled={cancelling}
          aria-label={`Cancel ${download.label} download`}
        >
          {cancelling ? 'Cancelling…' : 'Cancel'}
        </SimmButton>
      ) : download.profileId ? (
        <SimmButton
          type="button"
          variant="ghost"
          size="sm"
          className="downloads-panel__action"
          onClick={() => onOpenProfile?.(download.profileId!)}
          aria-label={`Open ${download.label} profile`}
          title="Open the collection profile"
        >
          Open
        </SimmButton>
      ) : null}
    </li>
  );
}

export function DownloadsPanel({ presentation = 'panel', onClose, onOpenProfile }: DownloadsPanelProps = {}) {
  const { downloads } = useDownloadStatusStore();
  const { cancelDownload, environments } = useEnvironmentStore();
  const [cancellingIds, setCancellingIds] = useState<Set<string>>(() => new Set());
  const [cancelError, setCancelError] = useState<string | null>(null);

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

  const handleCancel = useCallback(async (environmentId: string) => {
    setCancelError(null);
    setCancellingIds((current) => new Set(current).add(environmentId));
    try {
      await cancelDownload(environmentId);
    } catch (err) {
      setCancelError(`Could not cancel the download: ${getErrorMessage(err, 'Unknown error')}`);
    } finally {
      setCancellingIds((current) => {
        const next = new Set(current);
        next.delete(environmentId);
        return next;
      });
    }
  }, [cancelDownload]);

  const visibleRecentDownloads = presentation === 'popup' ? recentDownloads.slice(0, 3) : recentDownloads;

  const renderRows = (rows: TrackedDownload[]) => (
    <ul className="downloads-panel__list">
      {rows.map((download) => (
        <DownloadRow
          key={download.id}
          download={download}
          gameAppId={(environments ?? []).find((environment) => environment.id === gameEnvironmentId(download))?.appId ?? null}
          onOpenProfile={onOpenProfile}
          onCancel={(environmentId) => void handleCancel(environmentId)}
          cancelling={cancellingIds.has(gameEnvironmentId(download) ?? '')}
        />
      ))}
    </ul>
  );

  return (
    <section className={`downloads-panel downloads-panel--${presentation}`} aria-label="Downloads">
      <header className="downloads-panel__header">
        <h2 className="downloads-panel__title">Downloads</h2>
        {activeDownloads.length > 0 && <span className="downloads-panel__count">{activeDownloads.length} active</span>}
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
      </header>

      {cancelError && <p className="downloads-panel__error downloads-panel__error--banner" role="alert">{cancelError}</p>}

      {downloads.length === 0 ? (
        <div className="ui-empty downloads-panel__empty">
          <span className="ui-empty__emblem" aria-hidden="true"><Icon name="download" /></span>
          <p className="ui-empty__title">No downloads right now.</p>
          <p className="ui-empty__copy">Mod, framework, and game downloads show their progress here while you keep working.</p>
        </div>
      ) : (
        <div className="downloads-panel__sections">
          {activeDownloads.length > 0 && (
            <section className="downloads-panel__section" aria-label="Active downloads">
              <h3 className="downloads-panel__section-title">Active</h3>
              {renderRows(activeDownloads)}
            </section>
          )}

          {visibleRecentDownloads.length > 0 && (
            <section className="downloads-panel__section" aria-label="Recent downloads">
              <h3 className="downloads-panel__section-title">Recent</h3>
              {renderRows(visibleRecentDownloads)}
            </section>
          )}
        </div>
      )}
    </section>
  );
}
