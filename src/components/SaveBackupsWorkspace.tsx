import { useCallback, useEffect, useMemo, useState } from 'react';
import { open, save } from '@tauri-apps/plugin-dialog';
import { Dialog, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

import { ApiService } from '../services/api';
import type { GameSaveAccount, GameSaveBackup, GameSaveRestorePreview, GameSaveSlot } from '../types';
import { getErrorMessage } from '../utils/errors';
import { AnchoredContextMenu } from './AnchoredContextMenu';
import { Icon } from './Icon';
import { SimmButton, SimmDialogContent } from './primitives';

const formatBytes = (bytes: number) => {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)) - 1, units.length - 1);
  return `${(bytes / (1024 ** (index + 1))).toFixed(index > 0 ? 1 : 0)} ${units[index]}`;
};

const formatTimestamp = (value: string | null) => {
  if (!value) return 'Not available';
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime())
    ? value
    : parsed.toLocaleString(undefined, {
      month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit',
    });
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

type SavesSelectOption = { value: string; label: string };

const RETENTION_OPTIONS: SavesSelectOption[] = [
  { value: 'all', label: 'All backups' },
  { value: '3', label: '3 newest' },
  { value: '5', label: '5 newest' },
  { value: '10', label: '10 newest' },
  { value: '20', label: '20 newest' },
];

function SavesSelect({ value, options, onValueChange, disabled, className, size, id, label, title }: {
  value: string;
  options: SavesSelectOption[];
  onValueChange: (value: string) => void;
  disabled?: boolean;
  className?: string;
  size?: 'sm' | 'default';
  id?: string;
  label?: string;
  title?: string;
}) {
  return (
    <Select
      items={options}
      value={value}
      disabled={disabled}
      onValueChange={(next) => { if (typeof next === 'string') onValueChange(next); }}
    >
      <SelectTrigger id={id} size={size} className={className} aria-label={label} title={title}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent align="start">
        <SelectGroup>
          {options.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}
        </SelectGroup>
      </SelectContent>
    </Select>
  );
}

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
  return details.length > 0 ? details.join(' · ') : `${formatBytes(slot.sizeBytes)} · Changed ${formatTimestamp(slot.lastModified)}`;
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
    return index === 0 ? `${formatted} (latest)` : formatted;
  }
  return `${formatTimestamp(backup.lastModified)} (legacy backup)`;
};

function SaveDetail({ label, value }: { label: string; value: string | null }) {
  if (!value) return null;
  return <><dt>{label}</dt><dd>{value}</dd></>;
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

const restorePreviewRows = (preview: GameSaveRestorePreview): Array<[string, string, string]> => [
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

const timeOf = (value: string | null) => {
  if (!value) return null;
  const parsed = new Date(value).getTime();
  return Number.isNaN(parsed) ? null : parsed;
};

/** Restoring an older save is the one case that needs a warning: progress since then is replaced. */
const restoreLosesProgress = (preview: GameSaveRestorePreview) => {
  if (!preview.current.exists) return false;
  const current = timeOf(preview.current.lastPlayedAt) ?? timeOf(preview.current.lastModified);
  const restored = timeOf(preview.restored.lastPlayedAt) ?? timeOf(preview.restored.lastModified);
  return current !== null && restored !== null && restored < current;
};

export function SaveBackupsWorkspace(_props: { onClose: () => void }) {
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
  const [folderMenu, setFolderMenu] = useState<{ x: number; y: number } | null>(null);

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

  const losesProgress = pendingRestore ? restoreLosesProgress(pendingRestore.preview) : false;

  return (
    <section className="save-backups-workspace workspace-panel ui-page" aria-label="Saves">
      <header className="ui-page-header">
        <div className="ui-page-header__titles">
          <h1 className="ui-page-title">Saves</h1>
          {selectedAccount && (
            <p className="ui-page-subtitle save-backups-workspace__location" title={selectedAccount.path}>
              <code>{selectedAccount.path}</code>
            </p>
          )}
        </div>
        <div className="ui-toolbar">
          {status?.available && status.accounts.length > 0 && selectedAccount && (
            <SavesSelect
              className="save-backups-workspace__account"
              label="Steam account"
              title={`Steam ID ${selectedAccount.steamId}`}
              value={selectedAccount.steamId}
              options={status.accounts.map((account) => ({ value: account.steamId, label: accountLabel(account) }))}
              onValueChange={setSelectedSteamId}
              disabled={selectionLocked}
            />
          )}
          <SimmButton
            type="button"
            variant="ghost"
            size="icon"
            onClick={() => void refresh()}
            disabled={loading || selectionLocked}
            aria-label="Refresh saves"
            title="Refresh saves"
          >
            <Icon name="rotate" spin={loading} />
          </SimmButton>
          <SimmButton
            type="button"
            variant="ghost"
            size="icon"
            disabled={!selectedAccount}
            aria-label="Open folders"
            aria-haspopup="menu"
            aria-expanded={folderMenu !== null}
            title="Open folders"
            onClick={(event) => {
              const rect = event.currentTarget.getBoundingClientRect();
              setFolderMenu((current) => current ? null : { x: rect.right - 208, y: rect.bottom + 4 });
            }}
          >
            <Icon name="folderOpen" />
          </SimmButton>
        </div>
      </header>

      {error && (
        <div className="ui-callout ui-callout--danger save-backups-workspace__message" role="alert">
          <Icon name="circleExclamation" />
          <span>{error}</span>
        </div>
      )}
      {notice && (
        <div className="save-backups-workspace__notice" role="status">
          <Icon name="check" />
          <span>{notice}</span>
          <SimmButton type="button" variant="ghost" size="icon-sm" aria-label="Dismiss message" onClick={() => setNotice(null)}>
            <Icon name="times" />
          </SimmButton>
        </div>
      )}

      {loading && !status ? (
        <div className="save-backups-workspace__loading" role="status" aria-label="Inspecting local save slots">
          {[0, 1, 2, 3, 4].map((index) => <span key={index} className="save-backups-workspace__skeleton" />)}
        </div>
      ) : !status?.available ? (
        <div className="ui-empty">
          <span className="ui-empty__emblem" aria-hidden="true"><Icon name="save" /></span>
          <p className="ui-empty__title">No Schedule I saves found</p>
          <p className="ui-empty__copy">{status?.message ?? 'Start Schedule I once so it creates its save folder, then refresh.'}</p>
          <SimmButton type="button" variant="secondary" onClick={() => void refresh()} disabled={loading}>
            <Icon name="rotate" /> Refresh
          </SimmButton>
        </div>
      ) : !selectedAccount ? (
        <div className="ui-empty">
          <span className="ui-empty__emblem" aria-hidden="true"><Icon name="userCircle" /></span>
          <p className="ui-empty__title">No Steam save account found</p>
          <p className="ui-empty__copy">Start Schedule I once, then refresh this page to find its local save folders.</p>
          <SimmButton type="button" variant="secondary" onClick={() => void refresh()} disabled={loading}>
            <Icon name="rotate" /> Refresh
          </SimmButton>
        </div>
      ) : (
        <div className="save-backups-workspace__layout">
          <section className="save-backups-workspace__slot-list" aria-labelledby="save-slots-heading">
            <h2 id="save-slots-heading" className="save-backups-workspace__list-title">
              Save slots
              <span>{localSaveCount} of {selectedAccount.slots.length} in use</span>
            </h2>
            <ul className="save-backups-workspace__slots">
              {selectedAccount.slots.map((slot) => {
                const selected = slot.slotNumber === selectedSlotNumber;
                return (
                  <li key={slot.slotNumber}>
                    <button
                      type="button"
                      className={`save-backups-workspace__slot${selected ? ' save-backups-workspace__slot--selected' : ''}${slot.exists ? '' : ' save-backups-workspace__slot--missing'}`}
                      onClick={() => setSelectedSlotNumber(slot.slotNumber)}
                      disabled={selectionLocked}
                      aria-current={selected ? 'true' : undefined}
                    >
                      <span className="save-backups-workspace__slot-number">{slot.slotNumber}</span>
                      <span className="save-backups-workspace__slot-name ui-truncate">{slot.exists ? slotLabel(slot) : 'Empty slot'}</span>
                      {slot.exists && !slot.backup && <span className="ui-tag">No backup</span>}
                      <span className="save-backups-workspace__slot-meta ui-truncate">{slot.exists ? slotSummary(slot) : 'No local save data'}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>

          <section className="save-backups-workspace__detail" aria-label="Selected save slot details">
            {selectedSlot && (
              <>
                <header className="save-backups-workspace__detail-header">
                  <div className="save-backups-workspace__detail-titles">
                    <h2 className="save-backups-workspace__detail-title">{selectedSlot.exists ? slotLabel(selectedSlot) : `Slot ${selectedSlot.slotNumber}`}</h2>
                    <div className="ui-meta">
                      <span>Slot {selectedSlot.slotNumber}</span>
                      {selectedSlot.exists ? (
                        <>
                          <span>{formatBytes(selectedSlot.sizeBytes)}</span>
                          <span>Changed {formatTimestamp(selectedSlot.lastModified)}</span>
                        </>
                      ) : <span>Empty</span>}
                    </div>
                  </div>
                  <div className="save-backups-workspace__detail-actions">
                    <SimmButton type="button" variant="secondary" disabled={!selectedSlot.exists || busy} onClick={() => void handleExport()}>
                      <Icon name={exportInProgress ? 'spinner' : 'download'} spin={exportInProgress} />
                      {exportInProgress ? 'Exporting…' : 'Export ZIP'}
                    </SimmButton>
                    <SimmButton type="button" disabled={!selectedSlot.exists || busy} onClick={() => void handleBackup()}>
                      <Icon name={backupInProgress ? 'spinner' : 'save'} spin={backupInProgress} />
                      {backupInProgress ? 'Backing Up…' : 'Back Up Now'}
                    </SimmButton>
                  </div>
                </header>

                {selectedSlot.exists && (selectedSlot.cashBalance !== null || selectedSlot.onlineBalance !== null || selectedSlot.netWorth !== null || selectedSlot.rank !== null || selectedSlot.totalXp !== null || selectedSlot.createdAt || selectedSlot.lastPlayedAt || selectedSlot.lastSaveVersion) && (
                  <section className="save-backups-workspace__section" aria-label="Game save details">
                    <h3 className="ui-section-title">Save</h3>
                    <dl className="ui-kv save-backups-workspace__facts">
                      {selectedSlot.cashBalance !== null && <SaveDetail label="Cash balance" value={formatCurrency(selectedSlot.cashBalance)} />}
                      {selectedSlot.onlineBalance !== null && <SaveDetail label="Bank balance" value={formatCurrency(selectedSlot.onlineBalance)} />}
                      {selectedSlot.netWorth !== null && <SaveDetail label="Net worth" value={formatCurrency(selectedSlot.netWorth)} />}
                      <SaveDetail label="Rank" value={rankLabel(selectedSlot)} />
                      {selectedSlot.totalXp !== null && <SaveDetail label="Total XP" value={formatNumber(selectedSlot.totalXp)} />}
                      {selectedSlot.createdAt && <SaveDetail label="Created" value={formatTimestamp(selectedSlot.createdAt)} />}
                      {selectedSlot.lastPlayedAt && <SaveDetail label="Last played" value={formatTimestamp(selectedSlot.lastPlayedAt)} />}
                      {selectedSlot.lastSaveVersion && <SaveDetail label="Save version" value={selectedSlot.lastSaveVersion} />}
                      <dt>Location</dt>
                      <dd className="ui-mono save-backups-workspace__path" title={selectedSlot.path}>{selectedSlot.path}</dd>
                    </dl>
                  </section>
                )}

                <section className="save-backups-workspace__section" aria-label="Backup options">
                  <h3 className="ui-section-title">Backups</h3>
                  <dl className="ui-kv save-backups-workspace__facts">
                    <dt>Available</dt>
                    <dd>
                      {selectedSlot.backups.length === 0
                        ? 'No backup yet'
                        : `${selectedSlot.backups.length} ${selectedSlot.backups.length === 1 ? 'backup' : 'backups'}${selectedGameBackup ? ` · latest ${formatBytes(selectedGameBackup.sizeBytes)}` : ''}`}
                    </dd>
                    <dt><label htmlFor="save-backups-retention">Keep</label></dt>
                    <dd>
                      <SavesSelect
                        id="save-backups-retention"
                        size="sm"
                        className="save-backups-workspace__inline-select"
                        value={backupRetentionLimit === null ? 'all' : String(backupRetentionLimit)}
                        options={RETENTION_OPTIONS}
                        onValueChange={(next) => setBackupRetentionLimit(next === 'all' ? null : Number(next))}
                        disabled={selectionLocked}
                        title="Applies when you back up. SIMM keeps the newest game-style snapshots."
                      />
                    </dd>
                  </dl>
                </section>

                <section className="save-backups-workspace__section" aria-label="Restore options">
                  <h3 className="ui-section-title">Restore</h3>
                  <p className="save-backups-workspace__hint">
                    You see a preview of the changes first. SIMM backs up the current save before replacing it, so you can roll back.
                  </p>
                  <div className="save-backups-workspace__restore-row">
                    {selectedGameBackup ? (
                      <SavesSelect
                        className="save-backups-workspace__restore-select"
                        label="Select a game backup version to restore"
                        value={selectedGameBackup.path}
                        options={selectedSlot.backups.map((backup, index) => ({ value: backup.path, label: backupVersionLabel(backup, index) }))}
                        onValueChange={setSelectedBackupPath}
                        disabled={selectionLocked}
                      />
                    ) : (
                      <span className="save-backups-workspace__hint">Back up this slot to restore it later.</span>
                    )}
                    <SimmButton type="button" variant="secondary" disabled={!selectedGameBackup || busy} onClick={() => void handleRestoreGameBackup()}>
                      <Icon name={previewInProgress ? 'spinner' : 'rotateLeft'} spin={previewInProgress} />
                      Restore Game Backup…
                    </SimmButton>
                    <SimmButton type="button" variant="ghost" disabled={busy} onClick={() => void handleRestoreZip()}>
                      <Icon name="upload" />
                      Restore From ZIP…
                    </SimmButton>
                  </div>
                </section>
              </>
            )}
          </section>
        </div>
      )}

      {folderMenu && selectedAccount && (
        <AnchoredContextMenu
          id="save-folder-actions"
          x={folderMenu.x}
          y={folderMenu.y}
          onClose={() => setFolderMenu(null)}
          items={[
            { key: 'saves', label: 'Open Save Folder', icon: 'folderOpen', onSelect: () => void handleOpenSaveFolder() },
            { key: 'backups', label: 'Open Backup Folder', icon: 'folderOpen', onSelect: () => void handleOpenGameBackupFolder() },
          ]}
        />
      )}

      <Dialog open={pendingRestore !== null} onOpenChange={(isOpen) => { if (!isOpen && !restoreInProgress) setPendingRestore(null); }}>
        <SimmDialogContent className="app-dialog save-restore-preview" showCloseButton={false} aria-label="Save restore preview">
          <DialogHeader className="modal-header app-dialog__header">
            <div className="app-dialog__heading"><DialogTitle>Review save changes</DialogTitle></div>
            <SimmButton variant="ghost" size="icon-sm" className="modal-close" onClick={() => setPendingRestore(null)} disabled={restoreInProgress} aria-label="Close restore preview"><Icon name="times" /></SimmButton>
          </DialogHeader>
          {pendingRestore && <div className="app-dialog__body save-restore-preview__body">
            <DialogDescription>
              {pendingRestore.preview.sourceLabel} will replace SaveGame_{pendingRestore.preview.slotNumber}.
            </DialogDescription>
            {losesProgress && (
              <div className="ui-callout ui-callout--warn save-restore-preview__callout">
                <Icon name="triangleExclamation" />
                <span>
                  This backup is older than the current save. Progress since
                  {' '}{formatTimestamp(pendingRestore.preview.restored.lastPlayedAt ?? pendingRestore.preview.restored.lastModified)} will be replaced.
                </span>
              </div>
            )}
            <table className="ui-table save-restore-preview__table">
              <thead><tr><th scope="col">Field</th><th scope="col">Change</th></tr></thead>
              <tbody>{restorePreviewRows(pendingRestore.preview).map(([field, current, restored]) => (
                <tr key={field} className={current === restored ? 'save-restore-preview__row--same' : 'save-restore-preview__row--changed'}>
                  <th scope="row">{field}</th>
                  <td>
                    {current === restored ? (
                      <span className="save-restore-preview__same">{current}</span>
                    ) : (
                      <span className="save-restore-preview__change">
                        <span>{current}</span>
                        <span className="save-restore-preview__arrow" aria-label="becomes">→</span>
                        <strong>{restored}</strong>
                      </span>
                    )}
                  </td>
                </tr>
              ))}</tbody>
            </table>
            <p className="save-restore-preview__note">SIMM first creates and checks a rollback backup of the current save.</p>
          </div>}
          <DialogFooter className="app-dialog__footer"><div className="app-dialog__actions">
            <SimmButton type="button" variant="ghost" onClick={() => setPendingRestore(null)} disabled={restoreInProgress}>Cancel</SimmButton>
            <SimmButton type="button" onClick={() => void handleConfirmRestore()} disabled={restoreInProgress}>
              <Icon name={restoreInProgress ? 'spinner' : 'rotateLeft'} spin={restoreInProgress} /> {restoreInProgress ? 'Restoring…' : 'Restore This Save'}
            </SimmButton>
          </div></DialogFooter>
        </SimmDialogContent>
      </Dialog>
    </section>
  );
}
