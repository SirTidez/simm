import { useCallback, useEffect, useMemo, useState } from 'react';
import { open, save } from '@tauri-apps/plugin-dialog';
import { Dialog, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';

import { ApiService } from '../services/api';
import type { GameSaveAccount, GameSaveBackup, GameSaveRestorePreview, GameSaveSlot } from '../types';
import { getErrorMessage } from '../utils/errors';
import { Icon } from './Icon';
import { SimmButton, SimmDialogContent } from './primitives';
import { WorkspacePageHeader } from './WorkspacePageHeader';

const formatBytes = (bytes: number) => {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)) - 1, units.length - 1);
  return `${(bytes / (1024 ** (index + 1))).toFixed(index > 0 ? 1 : 0)} ${units[index]}`;
};

const formatTimestamp = (value: string | null) => {
  if (!value) return 'Not available';
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString();
};

const formatCurrency = (value: number) => new Intl.NumberFormat(undefined, {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 0,
}).format(value);

const formatNumber = (value: number) => new Intl.NumberFormat().format(value);

const formatCompactCurrency = (value: number) => new Intl.NumberFormat(undefined, {
  style: 'currency',
  currency: 'USD',
  notation: 'compact',
  maximumFractionDigits: 1,
}).format(value);

const formatShortDate = (value: string) => {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime())
    ? value
    : parsed.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
};

const accountLabel = (account: GameSaveAccount) => account.displayName ?? `Steam ID ${account.steamId}`;

const slotLabel = (slot: GameSaveSlot) => slot.organizationName ?? `Slot ${slot.slotNumber}`;

const rankNames = [
  'Street Rat',
  'Hoodlum',
  'Peddler',
  'Hustler',
  'Bagman',
  'Enforcer',
  'Shot Caller',
  'Block Boss',
  'Underlord',
  'Baron',
  'Kingpin',
];

const toRomanNumeral = (value: number) => {
  if (!Number.isInteger(value) || value < 1 || value > 3999) return String(value);
  const numerals: Array<[number, string]> = [
    [1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'], [100, 'C'], [90, 'XC'],
    [50, 'L'], [40, 'XL'], [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I'],
  ];
  let remaining = value;
  let result = '';
  for (const [amount, numeral] of numerals) {
    while (remaining >= amount) {
      result += numeral;
      remaining -= amount;
    }
  }
  return result;
};

const rankLabel = (slot: GameSaveSlot) => {
  if (slot.rank === null) return null;
  const name = rankNames[slot.rank] ?? `Rank ${slot.rank}`;
  return slot.tier === null ? name : `${name} ${toRomanNumeral(slot.tier)}`;
};

const slotSummary = (slot: GameSaveSlot) => {
  const details = [
    slot.netWorth !== null ? `${formatCompactCurrency(slot.netWorth)} net worth` : null,
    slot.lastPlayedAt ? `Played ${formatShortDate(slot.lastPlayedAt)}` : null,
  ].filter((detail): detail is string => detail !== null);
  return details.length > 0 ? details.join(' · ') : `${formatBytes(slot.sizeBytes)} · ${formatTimestamp(slot.lastModified)}`;
};

const exportFileName = (steamId: string, slotNumber: number) => {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  return `schedule-i-${steamId}-save-${slotNumber}-${timestamp}.zip`;
};

const backupVersionLabel = (backup: GameSaveBackup, index: number) => {
  const pathSegments = backup.path.split(/[\\/]/).filter(Boolean);
  const folderName = pathSegments[pathSegments.length - 1] ?? 'Game backup';
  const timestamp = folderName.match(/^(\d{4}-\d{2}-\d{2})_(\d{2}-\d{2}-\d{2})(?:-.+)?$/);
  if (timestamp) {
    const date = new Date(`${timestamp[1]}T${timestamp[2].replace(/-/g, ':')}`);
    const formatted = Number.isNaN(date.getTime())
      ? `${timestamp[1]} ${timestamp[2].replace(/-/g, ':')}`
      : date.toLocaleString(undefined, {
        month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit',
      });
    return `${index === 0 ? 'Latest' : 'Backup'} · ${formatted}`;
  }
  return `Legacy backup — ${formatTimestamp(backup.lastModified)}`;
};

function SaveDetail({ label, value }: { label: string; value: string | null }) {
  if (!value) return null;
  return <div className="save-backups-workspace__game-detail"><span>{label}</span><strong>{value}</strong></div>;
}

type PendingRestore = {
  preview: GameSaveRestorePreview;
  source: 'gameBackup' | 'zip';
  zipPath?: string;
};

const previewText = (value: string | null) => value ?? '—';
const previewCurrency = (value: number | null) => value === null ? '—' : formatCurrency(value);
const previewNumber = (value: number | null) => value === null ? '—' : formatNumber(value);
const previewTimestamp = (value: string | null) => value ? formatTimestamp(value) : '—';

const restorePreviewRows = (preview: GameSaveRestorePreview) => [
  ['Organisation', previewText(preview.current.organizationName), previewText(preview.restored.organizationName)],
  ['Cash balance', previewCurrency(preview.current.cashBalance), previewCurrency(preview.restored.cashBalance)],
  ['Bank balance', previewCurrency(preview.current.onlineBalance), previewCurrency(preview.restored.onlineBalance)],
  ['Net worth', previewCurrency(preview.current.netWorth), previewCurrency(preview.restored.netWorth)],
  ['Rank', previewText(rankLabel(preview.current)), previewText(rankLabel(preview.restored))],
  ['Total XP', previewNumber(preview.current.totalXp), previewNumber(preview.restored.totalXp)],
  ['Created', previewTimestamp(preview.current.createdAt), previewTimestamp(preview.restored.createdAt)],
  ['Last played', previewTimestamp(preview.current.lastPlayedAt), previewTimestamp(preview.restored.lastPlayedAt)],
  ['Save version', previewText(preview.current.lastSaveVersion), previewText(preview.restored.lastSaveVersion)],
  ['Save size', preview.current.exists ? formatBytes(preview.current.sizeBytes) : 'Empty slot', preview.restored.exists ? formatBytes(preview.restored.sizeBytes) : 'Unavailable'],
];

export function SaveBackupsWorkspace({ onClose }: { onClose: () => void }) {
  const [status, setStatus] = useState<Awaited<ReturnType<typeof ApiService.getGameSaveBackupStatus>> | null>(null);
  const [selectedSteamId, setSelectedSteamId] = useState<string | null>(null);
  const [selectedSlotNumber, setSelectedSlotNumber] = useState(1);
  const [selectedBackupPath, setSelectedBackupPath] = useState<string | null>(null);
  const [backupRetentionLimit, setBackupRetentionLimit] = useState<number | null>(10);
  const [loading, setLoading] = useState(true);
  const [backupInProgress, setBackupInProgress] = useState(false);
  const [exportInProgress, setExportInProgress] = useState(false);
  const [previewInProgress, setPreviewInProgress] = useState(false);
  const [restoreInProgress, setRestoreInProgress] = useState(false);
  const [pendingRestore, setPendingRestore] = useState<PendingRestore | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const nextStatus = await ApiService.getGameSaveBackupStatus();
      setStatus(nextStatus);
      setSelectedSteamId((current) => (
        nextStatus.accounts.some((account) => account.steamId === current)
          ? current
          : nextStatus.accounts[0]?.steamId ?? null
      ));
    } catch (requestError) {
      setError(getErrorMessage(requestError, 'Could not inspect Schedule I save data.'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const selectedAccount = useMemo<GameSaveAccount | null>(() => (
    status?.accounts.find((account) => account.steamId === selectedSteamId) ?? null
  ), [selectedSteamId, status?.accounts]);
  const selectedSlot = useMemo<GameSaveSlot | null>(() => (
    selectedAccount?.slots.find((slot) => slot.slotNumber === selectedSlotNumber) ?? null
  ), [selectedAccount, selectedSlotNumber]);
  const selectedGameBackup = useMemo<GameSaveBackup | null>(() => (
    selectedSlot?.backups.find((backup) => backup.path === selectedBackupPath)
      ?? selectedSlot?.backups[0]
      ?? null
  ), [selectedBackupPath, selectedSlot]);
  const localSaveCount = selectedAccount?.slots.filter((slot) => slot.exists).length ?? 0;
  const busy = backupInProgress || exportInProgress || previewInProgress || restoreInProgress;
  // Keep the identity displayed by the confirmation dialog stable. The backend
  // independently verifies the opaque token, but disabling the selectors makes
  // it impossible for the visible account/slot to drift while a destructive
  // restore is awaiting confirmation.
  const selectionLocked = busy || pendingRestore !== null;

  const handleBackup = async () => {
    if (!selectedAccount || !selectedSlot?.exists) return;
    setBackupInProgress(true);
    setError(null);
    setNotice(null);
    try {
      const result = await ApiService.createGameSaveBackup(
        selectedAccount.steamId,
        selectedSlot.slotNumber,
        backupRetentionLimit,
      );
      const pruningNotice = result.prunedBackupCount > 0
        ? ` Removed ${result.prunedBackupCount} older ${result.prunedBackupCount === 1 ? 'backup' : 'backups'}.`
        : '';
      setNotice(`Created a game-compatible backup for ${slotLabel(selectedSlot)}.${pruningNotice}`);
      await refresh();
    } catch (requestError) {
      setError(getErrorMessage(requestError, 'Could not update the game save backup.'));
    } finally {
      setBackupInProgress(false);
    }
  };

  const handleOpenGameBackupFolder = async () => {
    if (!selectedAccount) return;
    try {
      await ApiService.openPath(selectedAccount.backupPath);
    } catch (requestError) {
      setError(getErrorMessage(requestError, 'Could not open the game backup folder.'));
    }
  };

  const handleOpenSaveFolder = async () => {
    if (!selectedAccount) return;
    try {
      await ApiService.openPath(selectedAccount.path);
    } catch (requestError) {
      setError(getErrorMessage(requestError, 'Could not open the Schedule I save folder.'));
    }
  };

  const handleExport = async () => {
    if (!selectedAccount || !selectedSlot?.exists) return;

    const destination = await save({
      title: `Export ${slotLabel(selectedSlot)} as ZIP`,
      defaultPath: exportFileName(selectedAccount.steamId, selectedSlot.slotNumber),
      filters: [{ name: 'ZIP archive', extensions: ['zip'] }],
    });
    if (!destination) return;

    setExportInProgress(true);
    setError(null);
    setNotice(null);
    try {
      const result = await ApiService.exportGameSaveBackup(selectedAccount.steamId, selectedSlot.slotNumber, destination);
      setNotice(`Exported ${slotLabel(selectedSlot)} as ${formatBytes(result.sizeBytes)} ZIP.`);
    } catch (requestError) {
      setError(getErrorMessage(requestError, 'Could not export the game save ZIP.'));
    } finally {
      setExportInProgress(false);
    }
  };

  const handleRestoreGameBackup = async () => {
    if (!selectedAccount || !selectedSlot || !selectedGameBackup || busy) return;
    setPreviewInProgress(true);
    setError(null);
    setNotice(null);
    try {
      const preview = await ApiService.previewGameSaveBackupRestore(
        selectedAccount.steamId,
        selectedSlot.slotNumber,
        selectedGameBackup.path,
      );
      setPendingRestore({ preview, source: 'gameBackup' });
    } catch (requestError) {
      setError(getErrorMessage(requestError, 'Could not preview the game backup.'));
    } finally {
      setPreviewInProgress(false);
    }
  };

  const handleRestoreZip = async () => {
    if (!selectedAccount || !selectedSlot || busy) return;
    const selection = await open({
      title: `Restore ${slotLabel(selectedSlot)} from ZIP`,
      directory: false,
      multiple: false,
      filters: [{ name: 'ZIP archive', extensions: ['zip'] }],
    });
    if (!selection || Array.isArray(selection)) return;

    setPreviewInProgress(true);
    setError(null);
    setNotice(null);
    try {
      const preview = await ApiService.previewGameSaveZipRestore(selectedAccount.steamId, selectedSlot.slotNumber, selection);
      setPendingRestore({ preview, source: 'zip', zipPath: selection });
    } catch (requestError) {
      setError(getErrorMessage(requestError, 'Could not preview the save ZIP.'));
    } finally {
      setPreviewInProgress(false);
    }
  };

  const handleConfirmRestore = async () => {
    if (!pendingRestore) return;

    setRestoreInProgress(true);
    setError(null);
    setNotice(null);
    try {
      if (pendingRestore.source === 'gameBackup') {
        if (!pendingRestore.preview.restoreToken) {
          throw new Error('The backup preview is missing its restore identity. Preview the backup again.');
        }
        await ApiService.restoreGameSaveBackup(
          pendingRestore.preview.steamId,
          pendingRestore.preview.slotNumber,
          pendingRestore.preview.restoreToken,
        );
      } else if (pendingRestore.zipPath) {
        await ApiService.restoreGameSaveFromZip(pendingRestore.preview.steamId, pendingRestore.preview.slotNumber, pendingRestore.zipPath);
      }
      setNotice(`Restored ${slotLabel(pendingRestore.preview.restored)} from ${pendingRestore.preview.sourceLabel}.`);
      setPendingRestore(null);
      await refresh();
    } catch (requestError) {
      setError(getErrorMessage(requestError, 'Could not restore the selected save.'));
    } finally {
      setRestoreInProgress(false);
    }
  };

  return (
    <section className="save-backups-workspace workspace-panel">
      <WorkspacePageHeader
        eyebrow="Recovery"
        title="Save Management"
        description="Inspect, back up, export, and explicitly restore the five Schedule I save slots."
      >
        <SimmButton type="button" className="btn btn-secondary btn-small" onClick={() => void refresh()} disabled={loading || selectionLocked}>
          <Icon name="rotate" /> Refresh
        </SimmButton>
        <SimmButton type="button" className="btn btn-secondary btn-small" onClick={() => void handleOpenSaveFolder()} disabled={!selectedAccount}>
          <Icon name="folderOpen" /> Open saves
        </SimmButton>
        <SimmButton type="button" className="btn btn-secondary btn-small" onClick={() => void handleOpenGameBackupFolder()} disabled={!selectedAccount}>
          <Icon name="folderOpen" /> Open game backups
        </SimmButton>
        <SimmButton type="button" variant="ghost" size="icon-sm" onClick={onClose} aria-label="Close save management">
          <Icon name="times" />
        </SimmButton>
      </WorkspacePageHeader>

      {error && <div className="save-backups-workspace__alert save-backups-workspace__alert--error" role="alert">{error}</div>}
      {notice && <div className="save-backups-workspace__alert save-backups-workspace__alert--success" role="status">{notice}</div>}

      {loading ? (
        <div className="save-backups-workspace__empty" role="status">Inspecting local save slots…</div>
      ) : !status?.available ? (
        <div className="save-backups-workspace__empty">
          <Icon name="circleInfo" />
          <strong>Save management is not available yet</strong>
          <span>{status?.message ?? 'No local Schedule I save data was found.'}</span>
        </div>
      ) : !selectedAccount ? (
        <div className="save-backups-workspace__empty">
          <Icon name="folderOpen" />
          <strong>No Steam save account found</strong>
          <span>Start Schedule I once, then refresh this page to find its local save folders.</span>
        </div>
      ) : (
        <>
          <section className="save-backups-workspace__context" aria-label="Selected save account">
            <div className="save-backups-workspace__location">
              <strong className="save-backups-workspace__location-title">Schedule I save location</strong>
              <code className="save-backups-workspace__location-path" title={selectedAccount.path}>{selectedAccount.path}</code>
            </div>
            <label>
              <span>Steam account</span>
              <select value={selectedAccount.steamId} onChange={(event) => setSelectedSteamId(event.target.value)} disabled={selectionLocked}>
                {status.accounts.map((account) => <option key={account.steamId} value={account.steamId}>{accountLabel(account)}</option>)}
              </select>
              <small>{selectedAccount.displayName ? `Steam ID ${selectedAccount.steamId}` : 'Steam display name is unavailable for this profile.'}</small>
            </label>
            <label className="save-backups-workspace__retention" title="Applies only when you explicitly create a backup. SIMM keeps the newest game-style snapshots.">
              <span>Keep backups</span>
              <select
                value={backupRetentionLimit ?? 'all'}
                onChange={(event) => setBackupRetentionLimit(event.target.value === 'all' ? null : Number(event.target.value))}
                disabled={selectionLocked}
              >
                <option value="all">Keep all</option>
                <option value="3">3 newest</option>
                <option value="5">5 newest</option>
                <option value="10">10 newest</option>
                <option value="20">20 newest</option>
              </select>
              <small>Applies when you create a backup.</small>
            </label>
          </section>

          <div className="save-backups-workspace__layout">
            <section className="save-backups-workspace__slot-list" aria-labelledby="save-slots-heading">
              <header className="save-backups-workspace__section-heading">
                <div><span>Game saves</span><h3 id="save-slots-heading">Save slots</h3></div>
                <strong>{localSaveCount} {localSaveCount === 1 ? 'slot' : 'slots'}</strong>
              </header>
              <div className="save-backups-workspace__slots">
                {selectedAccount.slots.map((slot) => {
                  const selected = slot.slotNumber === selectedSlotNumber;
                  return (
                    <SimmButton
                      key={slot.slotNumber}
                      type="button"
                      variant="ghost"
                      className={`save-backups-workspace__slot${selected ? ' save-backups-workspace__slot--selected' : ''}${slot.exists ? '' : ' save-backups-workspace__slot--missing'}`}
                      onClick={() => setSelectedSlotNumber(slot.slotNumber)}
                      disabled={selectionLocked}
                      aria-current={selected ? 'page' : undefined}
                    >
                      <span className="save-backups-workspace__slot-number">{slot.slotNumber}</span>
                      <span className="save-backups-workspace__slot-copy">
                        <strong>{slot.exists ? slotLabel(slot) : 'Empty slot'}</strong>
                        <small>{slot.exists ? slotSummary(slot) : 'No local save data'}</small>
                      </span>
                      <span className={`save-backups-workspace__backup-state${slot.backup ? ' save-backups-workspace__backup-state--ready' : ''}`}>
                        <Icon name={slot.backup ? 'check' : 'minus'} /> {slot.backup ? 'Backed up' : 'No backup'}
                      </span>
                    </SimmButton>
                  );
                })}
              </div>
            </section>

            <aside className="save-backups-workspace__inspector" aria-label="Selected save slot details">
              <header className="save-backups-workspace__section-heading">
                <div><span>Selected slot</span><h3>{selectedSlot ? slotLabel(selectedSlot) : 'Slot'}</h3></div>
                <Icon name="save" />
              </header>
              {selectedSlot && (
                <div className="save-backups-workspace__inspector-body">
                  <div className="save-backups-workspace__detail-row"><span>Current save</span><strong>{selectedSlot.exists ? formatBytes(selectedSlot.sizeBytes) : 'Not present'}</strong></div>
                  <div className="save-backups-workspace__detail-row"><span>Last changed</span><strong>{selectedSlot.exists ? formatTimestamp(selectedSlot.lastModified) : '—'}</strong></div>
                  {(selectedSlot.cashBalance !== null || selectedSlot.onlineBalance !== null || selectedSlot.netWorth !== null || selectedSlot.rank !== null || selectedSlot.totalXp !== null || selectedSlot.createdAt || selectedSlot.lastPlayedAt || selectedSlot.lastSaveVersion) && (
                    <section className="save-backups-workspace__game-details" aria-label="Game save details">
                      {selectedSlot.cashBalance !== null && <SaveDetail label="Cash balance" value={formatCurrency(selectedSlot.cashBalance)} />}
                      {selectedSlot.onlineBalance !== null && <SaveDetail label="Bank balance" value={formatCurrency(selectedSlot.onlineBalance)} />}
                      {selectedSlot.netWorth !== null && <SaveDetail label="Net worth" value={formatCurrency(selectedSlot.netWorth)} />}
                      <SaveDetail label="Rank" value={rankLabel(selectedSlot)} />
                      {selectedSlot.totalXp !== null && <SaveDetail label="Total XP" value={formatNumber(selectedSlot.totalXp)} />}
                      {selectedSlot.createdAt && <SaveDetail label="Created" value={formatTimestamp(selectedSlot.createdAt)} />}
                      {selectedSlot.lastPlayedAt && <SaveDetail label="Last played" value={formatTimestamp(selectedSlot.lastPlayedAt)} />}
                      {selectedSlot.lastSaveVersion && <SaveDetail label="Save version" value={selectedSlot.lastSaveVersion} />}
                    </section>
                  )}
                  <div className="save-backups-workspace__backup-detail">
                    <div className="save-backups-workspace__backup-summary">
                      <span>{selectedSlot.backups.length === 1 ? 'Game backup' : 'Game backups'}</span>
                      {selectedGameBackup && <small>{selectedSlot.backups.length} available · {formatBytes(selectedGameBackup.sizeBytes)}</small>}
                    </div>
                    {selectedGameBackup ? (
                      <label className="save-backups-workspace__backup-picker">
                        <span className="sr-only">Game backup version</span>
                        <select
                          value={selectedGameBackup.path}
                          onChange={(event) => setSelectedBackupPath(event.target.value)}
                          disabled={selectionLocked}
                          aria-label="Select a game backup version to restore"
                        >
                          {selectedSlot.backups.map((backup, index) => (
                            <option key={backup.path} value={backup.path}>{backupVersionLabel(backup, index)}</option>
                          ))}
                        </select>
                      </label>
                    ) : <strong className="save-backups-workspace__backup-empty">No backup yet</strong>}
                  </div>
                  <div className="save-backups-workspace__path-row">
                    <p className="save-backups-workspace__path" title={selectedSlot.path}>{selectedSlot.path}</p>
                    <span
                      className="save-backups-workspace__info-hint"
                      tabIndex={0}
                      role="img"
                      aria-label="Backup and restore information"
                      title={`Game backups are timestamped snapshots in backups\\SaveGame_${selectedSlot.slotNumber}. Restores create an automatic rollback backup before replacing the active save.`}
                    >
                      <Icon name="circleInfo" />
                    </span>
                  </div>
                  <section className="save-backups-workspace__action-group" aria-label="Backup options">
                    <span>Backup</span>
                    <div className="save-backups-workspace__inspector-actions">
                      <SimmButton type="button" className="btn btn-primary" disabled={!selectedSlot.exists || busy} onClick={() => void handleBackup()}>
                        <Icon name={backupInProgress ? 'spinner' : 'save'} spin={backupInProgress} />
                        {backupInProgress ? 'Updating backup…' : `Back up ${slotLabel(selectedSlot)}`}
                      </SimmButton>
                      <SimmButton type="button" className="btn btn-secondary" disabled={!selectedSlot.exists || busy} onClick={() => void handleExport()}>
                        <Icon name={exportInProgress ? 'spinner' : 'download'} spin={exportInProgress} />
                        {exportInProgress ? 'Exporting ZIP…' : 'Export ZIP'}
                      </SimmButton>
                    </div>
                  </section>
                  <section className="save-backups-workspace__action-group" aria-label="Restore options">
                    <span>Restore</span>
                    <p className="save-backups-workspace__restore-note">Choose a source to preview its changes before replacing this slot.</p>
                    <div className="save-backups-workspace__inspector-actions">
                      <SimmButton type="button" className="btn btn-secondary" disabled={!selectedGameBackup || busy} onClick={() => void handleRestoreGameBackup()}>
                        <Icon name={restoreInProgress ? 'spinner' : 'rotateLeft'} spin={restoreInProgress} />
                        {restoreInProgress ? 'Restoring…' : 'Restore game backup'}
                      </SimmButton>
                      <SimmButton type="button" className="btn btn-secondary" disabled={busy} onClick={() => void handleRestoreZip()}>
                        <Icon name={restoreInProgress ? 'spinner' : 'upload'} spin={restoreInProgress} />
                        {restoreInProgress ? 'Restoring…' : 'Restore ZIP'}
                      </SimmButton>
                    </div>
                  </section>
                </div>
              )}
            </aside>
          </div>
        </>
      )}

      <Dialog open={pendingRestore !== null} onOpenChange={(isOpen) => { if (!isOpen && !restoreInProgress) setPendingRestore(null); }}>
        <SimmDialogContent className="app-dialog save-restore-preview" showCloseButton={false} aria-label="Save restore preview">
          <DialogHeader className="modal-header app-dialog__header">
            <div className="app-dialog__heading"><span className="app-dialog__eyebrow">Restore preview</span><DialogTitle>Review save changes</DialogTitle></div>
            <SimmButton variant="ghost" size="icon-sm" className="modal-close" onClick={() => setPendingRestore(null)} disabled={restoreInProgress} aria-label="Close restore preview"><Icon name="times" /></SimmButton>
          </DialogHeader>
          {pendingRestore && <div className="app-dialog__body save-restore-preview__body">
            <DialogDescription>{pendingRestore.preview.sourceLabel} will replace SaveGame_{pendingRestore.preview.slotNumber}. Review the current and restored values below.</DialogDescription>
            <div className="save-restore-preview__table-wrap">
              <table>
                <thead><tr><th scope="col">Field</th><th scope="col">Current</th><th scope="col">Restored</th></tr></thead>
                <tbody>{restorePreviewRows(pendingRestore.preview).map(([field, current, restored]) => (
                  <tr key={field} className={current === restored ? 'save-restore-preview__row--same' : 'save-restore-preview__row--changed'}>
                    <th scope="row">{field}</th><td>{current}</td><td>{restored}</td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
            <p className="save-restore-preview__warning"><Icon name="triangleExclamation" /> Restoring replaces the active slot. SIMM will first create and validate an automatic rollback backup.</p>
          </div>}
          <DialogFooter className="app-dialog__footer"><div className="app-dialog__actions">
            <SimmButton type="button" className="btn btn-secondary" onClick={() => setPendingRestore(null)} disabled={restoreInProgress}>Cancel</SimmButton>
            <SimmButton type="button" className="btn btn-primary" onClick={() => void handleConfirmRestore()} disabled={restoreInProgress}>
              <Icon name={restoreInProgress ? 'spinner' : 'rotateLeft'} spin={restoreInProgress} /> {restoreInProgress ? 'Restoring…' : 'Restore this save'}
            </SimmButton>
          </div></DialogFooter>
        </SimmDialogContent>
      </Dialog>
    </section>
  );
}
