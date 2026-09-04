use std::collections::{HashMap, HashSet};
use std::fs::File;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::SystemTime;

use anyhow::{Context, Result};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use chrono::{DateTime, Local, NaiveDate, Utc};
use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::fs;
use tokio::sync::Mutex;
use zip::write::FileOptions;
use zip::{CompressionMethod, ZipArchive, ZipWriter};

use crate::services::fomod::ArchiveBudget;
use crate::types::{
    GameSaveAccount, GameSaveBackup, GameSaveBackupExportResult, GameSaveBackupResult,
    GameSaveBackupStatus, GameSaveRestorePreview, GameSaveRestoreResult, GameSaveSlot,
};

const SAVE_SLOT_COUNT: u8 = 5;
const STEAM_PROFILE_TIMEOUT_SECONDS: u64 = 2;

static STEAM_DISPLAY_NAME_CACHE: Lazy<Mutex<HashMap<String, String>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));
static SAVE_SLOT_OPERATION_LOCKS: Lazy<Mutex<HashMap<String, Arc<Mutex<()>>>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

#[derive(Default)]
struct SaveSlotDetails {
    organization_name: Option<String>,
    cash_balance: Option<f64>,
    online_balance: Option<f64>,
    net_worth: Option<f64>,
    rank: Option<u32>,
    tier: Option<u32>,
    total_xp: Option<u64>,
    created_at: Option<String>,
    last_played_at: Option<String>,
    last_save_version: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GameBackupRestoreToken {
    steam_id: String,
    slot_number: u8,
    snapshot_id: String,
    content_fingerprint: String,
}

pub struct SaveBackupsService;

impl SaveBackupsService {
    pub fn new() -> Self {
        Self
    }

    pub async fn get_status(&self) -> Result<GameSaveBackupStatus> {
        let source_path = match schedule_i_saves_dir() {
            Ok(path) => path,
            Err(error) => {
                return Ok(GameSaveBackupStatus {
                    available: false,
                    source_path: String::new(),
                    accounts: Vec::new(),
                    message: Some(error.to_string()),
                });
            }
        };
        let source_path_text = source_path.to_string_lossy().to_string();

        if !source_path.is_dir() {
            return Ok(GameSaveBackupStatus {
                available: false,
                source_path: source_path_text,
                accounts: Vec::new(),
                message: Some(
                    "Schedule I save data was not found for this Windows user.".to_string(),
                ),
            });
        }

        Ok(GameSaveBackupStatus {
            available: true,
            source_path: source_path_text,
            accounts: list_accounts(&source_path).await?,
            message: None,
        })
    }

    pub async fn create_backup(
        &self,
        steam_id: &str,
        slot_number: u8,
        retention_limit: Option<u16>,
    ) -> Result<GameSaveBackupResult> {
        validate_steam_id(steam_id)?;
        validate_slot_number(slot_number)?;
        validate_retention_limit(retention_limit)?;
        let _operation_guard = lock_save_slot(steam_id, slot_number).await;
        ensure_schedule_i_not_running("create a save backup").await?;

        let account_path = schedule_i_saves_dir()?.join(steam_id);
        let source = slot_path(&account_path, slot_number);
        if !source.is_dir() {
            anyhow::bail!(
                "Save slot {} was not found for account {}",
                slot_number,
                steam_id
            );
        }

        let backup_slot_root = slot_path(&account_path.join("backups"), slot_number);
        fs::create_dir_all(&backup_slot_root)
            .await
            .context("Failed to create the game's save backup directory")?;
        let destination = create_backup_snapshot(&source, &backup_slot_root, "manual").await?;

        let pruned_backup_count =
            prune_game_backups(&backup_slot_root, retention_limit, Some(&destination)).await?;

        // Do not re-discover "the latest" backup here: when the requested source is
        // corrupt, returning an older snapshot would misidentify the operation. The
        // exact finalised path is the only acceptable result for this request.
        let backup = game_backup_from_path(&destination).await?;
        Ok(GameSaveBackupResult {
            steam_id: steam_id.to_string(),
            slot_number,
            backup,
            pruned_backup_count,
        })
    }

    pub async fn export_backup(
        &self,
        steam_id: &str,
        slot_number: u8,
        destination_path: &str,
    ) -> Result<GameSaveBackupExportResult> {
        validate_steam_id(steam_id)?;
        validate_slot_number(slot_number)?;
        let _operation_guard = lock_save_slot(steam_id, slot_number).await;
        ensure_schedule_i_not_running("export a save backup").await?;

        let source = slot_path(&schedule_i_saves_dir()?.join(steam_id), slot_number);
        if !source.is_dir() {
            anyhow::bail!(
                "Save slot {} was not found for account {}",
                slot_number,
                steam_id
            );
        }

        let destination = zip_destination_path(destination_path)?;
        let destination_parent = destination
            .parent()
            .context("Choose a destination folder for the ZIP export")?;
        let canonical_source = source
            .canonicalize()
            .context("Could not resolve the selected Schedule I save slot")?;
        let canonical_destination_parent = destination_parent
            .canonicalize()
            .context("The selected ZIP destination folder no longer exists")?;
        if canonical_destination_parent.starts_with(&canonical_source) {
            anyhow::bail!("Choose a ZIP destination outside the selected save folder")
        }
        if destination.exists() {
            anyhow::bail!("A file already exists at the selected ZIP destination")
        }

        let file_name = destination
            .file_name()
            .and_then(|value| value.to_str())
            .context("Choose a file name for the ZIP export")?;
        let staging = destination_parent.join(format!(
            ".{file_name}.simm-{}.partial",
            uuid::Uuid::new_v4()
        ));

        let source_fingerprint_before = backup_content_fingerprint(&source).await?;
        let source_for_export = source.clone();
        let staging_for_export = staging.clone();
        let export_result = tokio::task::spawn_blocking(move || {
            write_save_slot_zip(&source_for_export, &staging_for_export)
        })
        .await
        .context("Save ZIP export task stopped unexpectedly")?;
        if let Err(error) = export_result {
            let _ = fs::remove_file(&staging).await;
            return Err(error);
        }
        let source_fingerprint_after = match backup_content_fingerprint(&source).await {
            Ok(fingerprint) => fingerprint,
            Err(error) => {
                let _ = fs::remove_file(&staging).await;
                return Err(error);
            }
        };
        if source_fingerprint_after != source_fingerprint_before {
            let _ = fs::remove_file(&staging).await;
            anyhow::bail!(
                "The save changed while SIMM was exporting it; close Schedule I and try again"
            )
        }

        fs::rename(&staging, &destination)
            .await
            .context("Failed to finalize the save ZIP export")?;
        let size_bytes = fs::metadata(&destination)
            .await
            .context("Failed to read the completed save ZIP export")?
            .len();
        Ok(GameSaveBackupExportResult {
            steam_id: steam_id.to_string(),
            slot_number,
            path: destination.to_string_lossy().to_string(),
            size_bytes,
        })
    }

    pub async fn restore_from_game_backup(
        &self,
        steam_id: &str,
        slot_number: u8,
        restore_token: &str,
    ) -> Result<GameSaveRestoreResult> {
        validate_steam_id(steam_id)?;
        validate_slot_number(slot_number)?;
        let _operation_guard = lock_save_slot(steam_id, slot_number).await;
        ensure_schedule_i_not_running("restore a save backup").await?;

        let account_path = schedule_i_saves_dir()?.join(steam_id);
        let backup_slot_root = slot_path(&account_path.join("backups"), slot_number);
        let source =
            resolve_backup_restore_token(restore_token, steam_id, slot_number, &backup_slot_root)
                .await?;
        let destination = slot_path(&account_path, slot_number);

        restore_directory_to_slot(
            Path::new(&source.path),
            &destination,
            &backup_slot_root,
            backup_is_legacy(&source, &backup_slot_root),
        )
        .await?;
        restored_save_result(steam_id, slot_number, &destination).await
    }

    pub async fn preview_game_backup_restore(
        &self,
        steam_id: &str,
        slot_number: u8,
        backup_path: Option<&str>,
    ) -> Result<GameSaveRestorePreview> {
        validate_steam_id(steam_id)?;
        validate_slot_number(slot_number)?;
        let _operation_guard = lock_save_slot(steam_id, slot_number).await;

        let account_path = schedule_i_saves_dir()?.join(steam_id);
        let backup_slot_root = slot_path(&account_path.join("backups"), slot_number);
        let source = select_game_backup(&backup_slot_root, backup_path)
            .await?
            .with_context(|| {
                format!("No valid game backup exists for save slot {}", slot_number)
            })?;

        restore_preview(
            steam_id,
            slot_number,
            game_backup_source_label(&source),
            source.path.clone(),
            Some(issue_backup_restore_token(steam_id, slot_number, &source).await?),
            &slot_path(&account_path, slot_number),
            Path::new(&source.path),
        )
        .await
    }

    pub async fn restore_from_zip(
        &self,
        steam_id: &str,
        slot_number: u8,
        zip_path: &str,
    ) -> Result<GameSaveRestoreResult> {
        validate_steam_id(steam_id)?;
        validate_slot_number(slot_number)?;
        let _operation_guard = lock_save_slot(steam_id, slot_number).await;
        ensure_schedule_i_not_running("restore a save backup").await?;
        let zip_path = restore_zip_path(zip_path)?;
        if !zip_path.is_file() {
            anyhow::bail!("The selected ZIP file was not found")
        }

        let account_path = schedule_i_saves_dir()?.join(steam_id);
        let destination = slot_path(&account_path, slot_number);
        let staging = restore_staging_path(&destination, slot_number);
        let zip_for_restore = zip_path.clone();
        let staging_for_restore = staging.clone();
        let extraction = tokio::task::spawn_blocking(move || {
            extract_save_zip(&zip_for_restore, &staging_for_restore, slot_number)
        })
        .await
        .context("Save ZIP restore task stopped unexpectedly")?;
        if let Err(error) = extraction {
            let _ = fs::remove_dir_all(&staging).await;
            return Err(error);
        }

        if let Err(error) = validate_save_directory(&staging, "The staged ZIP restore").await {
            let _ = remove_directory_if_exists(&staging).await;
            return Err(error);
        }
        if let Err(error) = ensure_schedule_i_not_running("restore a save backup").await {
            let _ = remove_directory_if_exists(&staging).await;
            return Err(error);
        }
        create_rollback_backup_if_present(
            &destination,
            &slot_path(&account_path.join("backups"), slot_number),
        )
        .await?;
        replace_slot_with_staging(&destination, &staging, slot_number).await?;
        restored_save_result(steam_id, slot_number, &destination).await
    }

    pub async fn preview_zip_restore(
        &self,
        steam_id: &str,
        slot_number: u8,
        zip_path: &str,
    ) -> Result<GameSaveRestorePreview> {
        validate_steam_id(steam_id)?;
        validate_slot_number(slot_number)?;
        let _operation_guard = lock_save_slot(steam_id, slot_number).await;
        let zip_path = restore_zip_path(zip_path)?;
        if !zip_path.is_file() {
            anyhow::bail!("The selected ZIP file was not found")
        }

        let preview_path = std::env::temp_dir().join(format!(
            "simm-save-restore-preview-{}",
            uuid::Uuid::new_v4()
        ));
        let zip_for_preview = zip_path.clone();
        let preview_for_extract = preview_path.clone();
        let extraction = tokio::task::spawn_blocking(move || {
            extract_save_zip(&zip_for_preview, &preview_for_extract, slot_number)
        })
        .await
        .context("Save ZIP preview task stopped unexpectedly")?;
        if let Err(error) = extraction {
            let _ = fs::remove_dir_all(&preview_path).await;
            return Err(error);
        }

        let account_path = schedule_i_saves_dir()?.join(steam_id);
        let file_name = zip_path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("selected ZIP");
        let preview = restore_preview(
            steam_id,
            slot_number,
            format!("ZIP: {file_name}"),
            zip_path.to_string_lossy().to_string(),
            None,
            &slot_path(&account_path, slot_number),
            &preview_path,
        )
        .await;
        let cleanup = remove_directory_if_exists(&preview_path).await;
        cleanup.context("Failed to clear the temporary save ZIP preview")?;
        preview
    }
}

fn schedule_i_saves_dir() -> Result<PathBuf> {
    if let Ok(override_path) = std::env::var("SIMMRUST_SCHEDULE_I_SAVES_DIR") {
        let trimmed = override_path.trim();
        if !trimmed.is_empty() {
            return Ok(PathBuf::from(trimmed));
        }
    }

    #[cfg(target_os = "windows")]
    {
        let local_app_data = dirs::data_local_dir()
            .context("Could not determine the current user's Local AppData directory")?;
        let app_data = local_app_data
            .parent()
            .context("Could not determine the current user's AppData directory")?;
        Ok(app_data
            .join("LocalLow")
            .join("TVGS")
            .join("Schedule I")
            .join("Saves"))
    }

    #[cfg(not(target_os = "windows"))]
    {
        anyhow::bail!("Schedule I save backups are currently available on Windows only")
    }
}

fn validate_steam_id(steam_id: &str) -> Result<()> {
    if steam_id.is_empty()
        || !steam_id.bytes().all(|byte| byte.is_ascii_digit())
        || steam_id.contains(['/', '\\'])
        || steam_id == "."
        || steam_id == ".."
    {
        anyhow::bail!("Invalid Steam account identifier")
    }
    Ok(())
}

fn validate_slot_number(slot_number: u8) -> Result<()> {
    if !(1..=SAVE_SLOT_COUNT).contains(&slot_number) {
        anyhow::bail!("Save slot must be between 1 and {}", SAVE_SLOT_COUNT)
    }
    Ok(())
}

fn validate_retention_limit(retention_limit: Option<u16>) -> Result<()> {
    if let Some(limit) = retention_limit {
        if !(1..=100).contains(&limit) {
            anyhow::bail!("Keep between 1 and 100 game backups, or choose to keep all backups")
        }
    }
    Ok(())
}

fn slot_path(root: &Path, slot_number: u8) -> PathBuf {
    root.join(format!("SaveGame_{}", slot_number))
}

fn zip_destination_path(destination_path: &str) -> Result<PathBuf> {
    let destination_path = destination_path.trim();
    if destination_path.is_empty() {
        anyhow::bail!("Choose a destination for the save ZIP export")
    }

    let mut destination = PathBuf::from(destination_path);
    if !destination.is_absolute() {
        anyhow::bail!("Choose an absolute destination path for the save ZIP export")
    }
    if !destination
        .extension()
        .is_some_and(|extension| extension.eq_ignore_ascii_case("zip"))
    {
        destination.set_extension("zip");
    }
    Ok(destination)
}

fn restore_zip_path(zip_path: &str) -> Result<PathBuf> {
    let zip_path = zip_path.trim();
    if zip_path.is_empty() {
        anyhow::bail!("Choose a ZIP file to restore")
    }
    let path = PathBuf::from(zip_path);
    if !path.is_absolute()
        || !path
            .extension()
            .is_some_and(|extension| extension.eq_ignore_ascii_case("zip"))
    {
        anyhow::bail!("Choose a valid ZIP file to restore")
    }
    Ok(path)
}

fn restore_staging_path(destination: &Path, slot_number: u8) -> PathBuf {
    destination.with_file_name(format!(
        "SaveGame_{slot_number}.simm-restore-{}",
        uuid::Uuid::new_v4()
    ))
}

async fn lock_save_slot(steam_id: &str, slot_number: u8) -> tokio::sync::OwnedMutexGuard<()> {
    let key = format!("{steam_id}:{slot_number}");
    let slot_lock = {
        let mut locks = SAVE_SLOT_OPERATION_LOCKS.lock().await;
        locks
            .entry(key)
            .or_insert_with(|| Arc::new(Mutex::new(())))
            .clone()
    };
    slot_lock.lock_owned().await
}

async fn ensure_schedule_i_not_running(action: &str) -> Result<()> {
    #[cfg(target_os = "windows")]
    {
        let running = tokio::task::spawn_blocking(|| {
            std::process::Command::new("powershell")
                .args([
                    "-NoProfile",
                    "-NonInteractive",
                    "-Command",
                    "if (Get-Process -Name 'Schedule I' -ErrorAction SilentlyContinue) { exit 0 } else { exit 1 }",
                ])
                .status()
        })
        .await
        .context("Schedule I process check stopped unexpectedly")?
        .context("Could not check whether Schedule I is running")?
        .success();
        if running {
            anyhow::bail!(
                "Close Schedule I before asking SIMM to {action}; changing live save files could create an inconsistent or lost save"
            )
        }
    }
    Ok(())
}

fn is_link_or_reparse_point(metadata: &std::fs::Metadata) -> bool {
    if metadata.file_type().is_symlink() {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0400;
        return metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0;
    }
    #[cfg(not(windows))]
    {
        false
    }
}

async fn validate_save_directory(path: &Path, subject: &str) -> Result<()> {
    let root_metadata = fs::symlink_metadata(path)
        .await
        .with_context(|| format!("{subject} was not found"))?;
    if is_link_or_reparse_point(&root_metadata) || !root_metadata.is_dir() {
        anyhow::bail!("{subject} must be a real save directory, not a link or file")
    }

    let game_path = path.join("Game.json");
    let game_metadata = fs::symlink_metadata(&game_path)
        .await
        .with_context(|| format!("{subject} is missing required Game.json"))?;
    if is_link_or_reparse_point(&game_metadata) || !game_metadata.is_file() {
        anyhow::bail!("{subject} has an unsafe or invalid Game.json")
    }
    let game_contents = fs::read(&game_path)
        .await
        .with_context(|| format!("Failed to read {subject}'s Game.json"))?;
    serde_json::from_slice::<serde_json::Value>(&game_contents)
        .with_context(|| format!("{subject} has invalid Game.json"))?;

    validate_save_directory_children(path, subject).await
}

async fn validate_save_directory_children(path: &Path, subject: &str) -> Result<()> {
    let mut pending_directories = vec![path.to_path_buf()];
    while let Some(directory) = pending_directories.pop() {
        let mut entries = fs::read_dir(&directory)
            .await
            .with_context(|| format!("Failed to inspect {subject}"))?;
        while let Some(entry) = entries.next_entry().await? {
            let entry_path = entry.path();
            let metadata = fs::symlink_metadata(&entry_path).await?;
            if is_link_or_reparse_point(&metadata) {
                anyhow::bail!(
                    "{subject} contains an unsupported symbolic link or reparse point: {}",
                    entry_path.display()
                )
            }
            if metadata.is_dir() {
                pending_directories.push(entry_path);
            }
        }
    }
    Ok(())
}

fn snapshot_name() -> String {
    Local::now().format("%Y-%m-%d_%H-%M-%S").to_string()
}

fn is_snapshot_name(name: &str) -> bool {
    let prefix = name.get(..19).unwrap_or_default();
    NaiveDate::parse_from_str(prefix.get(..10).unwrap_or_default(), "%Y-%m-%d").is_ok()
        && prefix.as_bytes().get(10) == Some(&b'_')
        && prefix
            .get(11..)
            .is_some_and(|time| chrono::NaiveTime::parse_from_str(time, "%H-%M-%S").is_ok())
        && name
            .get(19..)
            .is_some_and(|suffix| suffix.is_empty() || suffix.starts_with('-'))
}

async fn create_backup_snapshot(
    source: &Path,
    backup_slot_root: &Path,
    kind: &str,
) -> Result<PathBuf> {
    validate_save_directory(source, "The source save").await?;
    let source_fingerprint_before = backup_content_fingerprint(source).await?;
    fs::create_dir_all(backup_slot_root)
        .await
        .context("Failed to create the game's save backup directory")?;

    let base_name = snapshot_name();
    let snapshot_name = format!("{base_name}-{kind}-{}", uuid::Uuid::new_v4());
    let destination = backup_slot_root.join(&snapshot_name);
    let staging = backup_slot_root.join(format!(".{snapshot_name}.simm-partial"));
    if let Err(error) = copy_directory_recursive(source, &staging).await {
        let _ = remove_directory_if_exists(&staging).await;
        return Err(error).context("Failed to stage the game save backup");
    }
    if let Err(error) = validate_save_directory(&staging, "The staged game backup").await {
        let _ = remove_directory_if_exists(&staging).await;
        return Err(error);
    }
    let source_fingerprint_after = match backup_content_fingerprint(source).await {
        Ok(fingerprint) => fingerprint,
        Err(error) => {
            let _ = remove_directory_if_exists(&staging).await;
            return Err(error);
        }
    };
    let staged_fingerprint = match backup_content_fingerprint(&staging).await {
        Ok(fingerprint) => fingerprint,
        Err(error) => {
            let _ = remove_directory_if_exists(&staging).await;
            return Err(error);
        }
    };
    if source_fingerprint_after != source_fingerprint_before
        || staged_fingerprint != source_fingerprint_before
    {
        let _ = remove_directory_if_exists(&staging).await;
        anyhow::bail!("The save changed while SIMM was copying it; close Schedule I and try again")
    }
    fs::rename(&staging, &destination)
        .await
        .context("Failed to finalize the game save backup")?;
    Ok(destination)
}

async fn create_rollback_backup_if_present(
    destination: &Path,
    backup_slot_root: &Path,
) -> Result<()> {
    if !destination.exists() {
        return Ok(());
    }
    create_backup_snapshot(destination, backup_slot_root, "pre-restore")
        .await
        .context("Could not create a validated rollback backup before restore")?;
    Ok(())
}

async fn copy_legacy_backup_payload(source: &Path, destination: &Path) -> Result<()> {
    fs::create_dir_all(destination).await?;
    let mut entries = fs::read_dir(source).await?;
    while let Some(entry) = entries.next_entry().await? {
        let name = entry.file_name();
        let source_path = entry.path();
        let metadata = fs::symlink_metadata(&source_path).await?;
        if is_link_or_reparse_point(&metadata) {
            anyhow::bail!(
                "Legacy game backup contains an unsupported symbolic link or reparse point: {}",
                source_path.display()
            )
        }
        if metadata.is_dir() && is_snapshot_name(&name.to_string_lossy()) {
            // A legacy root may also contain newer timestamped snapshots. They are
            // manager data, not part of the save payload selected for restoration.
            continue;
        }
        let destination_path = destination.join(name);
        if metadata.is_dir() {
            Box::pin(copy_legacy_backup_payload(&source_path, &destination_path)).await?;
        } else {
            fs::copy(&source_path, &destination_path).await?;
        }
    }
    Ok(())
}

async fn restore_directory_to_slot(
    source: &Path,
    destination: &Path,
    backup_slot_root: &Path,
    legacy_root: bool,
) -> Result<()> {
    let slot_number = slot_number_from_path(destination)?;
    let staging = restore_staging_path(destination, slot_number);
    let stage_result = if legacy_root {
        copy_legacy_backup_payload(source, &staging).await
    } else {
        copy_directory_recursive(source, &staging).await
    };
    if let Err(error) = stage_result {
        let _ = remove_directory_if_exists(&staging).await;
        return Err(error).context("Failed to stage the selected game backup");
    }
    if let Err(error) = validate_save_directory(&staging, "The staged game backup").await {
        let _ = remove_directory_if_exists(&staging).await;
        return Err(error);
    }
    if let Err(error) = ensure_schedule_i_not_running("restore a save backup").await {
        let _ = remove_directory_if_exists(&staging).await;
        return Err(error);
    }
    create_rollback_backup_if_present(destination, backup_slot_root).await?;
    replace_slot_with_staging(destination, &staging, slot_number).await
}

async fn replace_slot_with_staging(
    destination: &Path,
    staging: &Path,
    slot_number: u8,
) -> Result<()> {
    let previous = destination.with_file_name(format!(
        "SaveGame_{slot_number}.simm-previous-{}",
        uuid::Uuid::new_v4()
    ));

    if destination.exists() {
        fs::rename(destination, &previous)
            .await
            .context("Failed to stage the current save before restore")?;
    }
    if let Err(error) = fs::rename(staging, destination).await {
        if previous.exists() {
            let _ = fs::rename(&previous, destination).await;
        }
        return Err(error).context("Failed to activate the restored save");
    }
    if let Err(error) = remove_directory_if_exists(&previous).await {
        // The restored slot is already active. Keep the rollback snapshot and leave
        // the old staging directory for manual recovery rather than reporting a
        // failed restore after the destructive step completed.
        log::warn!(
            "Restored save slot {} but could not remove transient previous slot {}: {}",
            slot_number,
            previous.display(),
            error
        );
    }
    Ok(())
}

async fn remove_directory_if_exists(path: &Path) -> Result<()> {
    if !path.exists() {
        return Ok(());
    }
    let metadata = fs::symlink_metadata(path).await?;
    if is_link_or_reparse_point(&metadata) {
        match fs::remove_file(path).await {
            Ok(()) => return Ok(()),
            Err(file_error) => {
                fs::remove_dir(path).await.with_context(|| {
                    format!(
                        "Failed to remove link/reparse point {} (file removal error: {})",
                        path.display(),
                        file_error
                    )
                })?;
                return Ok(());
            }
        }
    }
    if metadata.is_dir() {
        fs::remove_dir_all(path).await?;
    } else {
        fs::remove_file(path).await?;
    }
    Ok(())
}

async fn restored_save_result(
    steam_id: &str,
    slot_number: u8,
    destination: &Path,
) -> Result<GameSaveRestoreResult> {
    let metadata = fs::metadata(destination)
        .await
        .context("Restored save folder was not found")?;
    Ok(GameSaveRestoreResult {
        steam_id: steam_id.to_string(),
        slot_number,
        path: destination.to_string_lossy().to_string(),
        size_bytes: if metadata.is_dir() {
            directory_size(destination).await?
        } else {
            0
        },
    })
}

async fn restore_preview(
    steam_id: &str,
    slot_number: u8,
    source_label: String,
    source_path: String,
    restore_token: Option<String>,
    current_path: &Path,
    restored_path: &Path,
) -> Result<GameSaveRestorePreview> {
    Ok(GameSaveRestorePreview {
        steam_id: steam_id.to_string(),
        slot_number,
        source_label,
        source_path,
        restore_token,
        current: read_game_save_slot(current_path, slot_number).await?,
        restored: read_game_save_slot(restored_path, slot_number).await?,
    })
}

async fn read_game_save_slot(path: &Path, slot_number: u8) -> Result<GameSaveSlot> {
    let metadata = fs::metadata(path).await.ok();
    let exists = metadata.as_ref().is_some_and(|entry| entry.is_dir());
    let details = if exists {
        read_save_slot_details(path).await
    } else {
        SaveSlotDetails::default()
    };
    Ok(GameSaveSlot {
        slot_number,
        organization_name: details.organization_name,
        cash_balance: details.cash_balance,
        online_balance: details.online_balance,
        net_worth: details.net_worth,
        rank: details.rank,
        tier: details.tier,
        total_xp: details.total_xp,
        created_at: details.created_at,
        last_played_at: details.last_played_at,
        last_save_version: details.last_save_version,
        path: path.to_string_lossy().to_string(),
        exists,
        size_bytes: if exists {
            directory_size(path).await?
        } else {
            0
        },
        last_modified: metadata
            .and_then(|entry| entry.modified().ok())
            .map(format_time),
        backup: None,
        backups: Vec::new(),
    })
}

fn slot_number_from_path(path: &Path) -> Result<u8> {
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or_default();
    let number = name
        .strip_prefix("SaveGame_")
        .and_then(|value| value.parse::<u8>().ok());
    let number = number.context("Could not determine the selected save slot")?;
    validate_slot_number(number)?;
    Ok(number)
}

async fn list_accounts(source_root: &Path) -> Result<Vec<GameSaveAccount>> {
    let mut accounts = Vec::new();
    let mut entries = fs::read_dir(source_root).await?;
    while let Some(entry) = entries.next_entry().await? {
        let metadata = entry.metadata().await?;
        if !metadata.is_dir() {
            continue;
        }
        let steam_id = entry.file_name().to_string_lossy().to_string();
        if validate_steam_id(&steam_id).is_err() {
            continue;
        }
        let account_path = entry.path();
        let backup_path = account_path.join("backups");
        let mut slots = Vec::with_capacity(SAVE_SLOT_COUNT as usize);
        for slot_number in 1..=SAVE_SLOT_COUNT {
            let path = slot_path(&account_path, slot_number);
            let metadata = fs::metadata(&path).await.ok();
            let exists = metadata.as_ref().is_some_and(|entry| entry.is_dir());
            let details = if exists {
                read_save_slot_details(&path).await
            } else {
                SaveSlotDetails::default()
            };
            let backups = read_valid_game_backups(&slot_path(&backup_path, slot_number)).await?;
            slots.push(GameSaveSlot {
                slot_number,
                organization_name: details.organization_name,
                cash_balance: details.cash_balance,
                online_balance: details.online_balance,
                net_worth: details.net_worth,
                rank: details.rank,
                tier: details.tier,
                total_xp: details.total_xp,
                created_at: details.created_at,
                last_played_at: details.last_played_at,
                last_save_version: details.last_save_version,
                path: path.to_string_lossy().to_string(),
                exists,
                size_bytes: if exists {
                    directory_size(&path).await?
                } else {
                    0
                },
                last_modified: metadata
                    .and_then(|entry| entry.modified().ok())
                    .map(format_time),
                backup: backups.first().cloned(),
                backups,
            });
        }
        accounts.push(GameSaveAccount {
            steam_id,
            display_name: None,
            path: account_path.to_string_lossy().to_string(),
            backup_path: backup_path.to_string_lossy().to_string(),
            slots,
        });
    }
    accounts.sort_by(|left, right| left.steam_id.cmp(&right.steam_id));

    for account in &mut accounts {
        account.display_name = resolve_steam_display_name(&account.steam_id).await;
    }

    Ok(accounts)
}

async fn read_save_slot_details(save_slot_path: &Path) -> SaveSlotDetails {
    let (game_data, money_data, rank_data, metadata, local_inventory) = tokio::join!(
        read_save_json(save_slot_path.join("Game.json")),
        read_save_json(save_slot_path.join("Money.json")),
        read_save_json(save_slot_path.join("Rank.json")),
        read_save_json(save_slot_path.join("Metadata.json")),
        read_save_json(
            save_slot_path
                .join("Players")
                .join("Player_0")
                .join("Inventory.json")
        ),
    );

    SaveSlotDetails {
        organization_name: organization_name_from_json(game_data.as_ref()),
        cash_balance: cash_balance_from_inventory(local_inventory.as_ref()),
        online_balance: json_number(money_data.as_ref(), "OnlineBalance"),
        net_worth: json_number(money_data.as_ref(), "Networth"),
        rank: json_unsigned(rank_data.as_ref(), "Rank").and_then(|value| u32::try_from(value).ok()),
        tier: json_unsigned(rank_data.as_ref(), "Tier").and_then(|value| u32::try_from(value).ok()),
        total_xp: json_unsigned(rank_data.as_ref(), "TotalXP"),
        created_at: game_date_from_json(metadata.as_ref(), "CreationDate"),
        last_played_at: game_date_from_json(metadata.as_ref(), "LastPlayedDate"),
        last_save_version: json_string(metadata.as_ref(), "LastSaveVersion"),
    }
}

async fn read_save_json(path: PathBuf) -> Option<serde_json::Value> {
    let contents = fs::read_to_string(path).await.ok()?;
    serde_json::from_str(&contents).ok()
}

fn organization_name_from_json(data: Option<&serde_json::Value>) -> Option<String> {
    let organization_name = data?.get("OrganisationName")?.as_str()?.trim();
    (!organization_name.is_empty()).then(|| organization_name.to_string())
}

fn json_string(data: Option<&serde_json::Value>, field: &str) -> Option<String> {
    let value = data?.get(field)?.as_str()?.trim();
    (!value.is_empty()).then(|| value.to_string())
}

fn json_number(data: Option<&serde_json::Value>, field: &str) -> Option<f64> {
    data?.get(field)?.as_f64()
}

fn json_unsigned(data: Option<&serde_json::Value>, field: &str) -> Option<u64> {
    data?.get(field)?.as_u64()
}

fn cash_balance_from_inventory(inventory: Option<&serde_json::Value>) -> Option<f64> {
    inventory?
        .get("Items")?
        .as_array()?
        .iter()
        .filter_map(|item| item.as_str())
        .filter_map(|item| serde_json::from_str::<serde_json::Value>(item).ok())
        .find(|item| item.get("DataType").and_then(serde_json::Value::as_str) == Some("CashData"))?
        .get("CashBalance")?
        .as_f64()
}

fn game_date_from_json(data: Option<&serde_json::Value>, field: &str) -> Option<String> {
    let value = data?.get(field)?;
    let year = u32::try_from(value.get("Year")?.as_u64()?).ok()? as i32;
    let month = u32::try_from(value.get("Month")?.as_u64()?).ok()?;
    let day = u32::try_from(value.get("Day")?.as_u64()?).ok()?;
    let hour = u32::try_from(value.get("Hour")?.as_u64()?).ok()?;
    let minute = u32::try_from(value.get("Minute")?.as_u64()?).ok()?;
    let second = u32::try_from(value.get("Second")?.as_u64()?).ok()?;
    NaiveDate::from_ymd_opt(year, month, day)?
        .and_hms_opt(hour, minute, second)
        .map(|date_time| date_time.format("%Y-%m-%dT%H:%M:%S").to_string())
}

async fn resolve_steam_display_name(steam_id: &str) -> Option<String> {
    if let Some(display_name) = STEAM_DISPLAY_NAME_CACHE.lock().await.get(steam_id).cloned() {
        return Some(display_name);
    }

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(
            STEAM_PROFILE_TIMEOUT_SECONDS,
        ))
        .user_agent("SIMM Save Backups")
        .build()
        .ok()?;
    let url = format!("https://steamcommunity.com/profiles/{steam_id}?xml=1");
    let response = client.get(url).send().await.ok()?;
    if !response.status().is_success() {
        return None;
    }

    let profile_xml = response.text().await.ok()?;
    let display_name = extract_steam_display_name(&profile_xml)?;
    STEAM_DISPLAY_NAME_CACHE
        .lock()
        .await
        .insert(steam_id.to_string(), display_name.clone());
    Some(display_name)
}

fn extract_steam_display_name(profile_xml: &str) -> Option<String> {
    let value = profile_xml
        .split_once("<steamID>")?
        .1
        .split_once("</steamID>")?
        .0
        .trim();
    let value = value
        .strip_prefix("<![CDATA[")
        .and_then(|content| content.strip_suffix("]]>"))
        .unwrap_or(value)
        .trim();
    if value.is_empty() {
        return None;
    }

    Some(
        value
            .replace("&amp;", "&")
            .replace("&lt;", "<")
            .replace("&gt;", ">")
            .replace("&quot;", "\"")
            .replace("&apos;", "'"),
    )
}

#[cfg(test)]
async fn read_backup(path: &Path) -> Result<Option<GameSaveBackup>> {
    Ok(read_valid_game_backups(path).await?.into_iter().next())
}

async fn read_valid_game_backups(backup_slot_root: &Path) -> Result<Vec<GameSaveBackup>> {
    match fs::metadata(backup_slot_root).await {
        Ok(metadata) if metadata.is_dir() => {}
        Ok(_) | Err(_) => return Ok(Vec::new()),
    }

    let mut snapshots = Vec::new();
    let mut entries = fs::read_dir(backup_slot_root)
        .await
        .context("Failed to inspect the game's save backup folder")?;
    while let Some(entry) = entries.next_entry().await? {
        let entry_path = entry.path();
        let entry_metadata = fs::symlink_metadata(&entry_path).await?;
        if entry_metadata.is_dir()
            && !is_link_or_reparse_point(&entry_metadata)
            && is_snapshot_name(&entry.file_name().to_string_lossy())
            && validate_save_directory(&entry_path, "A game backup")
                .await
                .is_ok()
        {
            snapshots.push((entry.file_name().to_string_lossy().to_string(), entry_path));
        }
    }

    snapshots.sort_by(|left, right| right.0.cmp(&left.0));
    let mut backups = Vec::with_capacity(snapshots.len() + 1);
    for (_, snapshot) in snapshots {
        backups.push(game_backup_from_path(&snapshot).await?);
    }

    if validate_save_directory(backup_slot_root, "The legacy game backup")
        .await
        .is_ok()
    {
        // Older SIMM builds stored a save directly in SaveGame_N. Keep it available for
        // recovery without treating the parent folder as a timestamped game snapshot.
        backups.push(game_backup_from_path(backup_slot_root).await?);
    }

    Ok(backups)
}

async fn game_backup_from_path(path: &Path) -> Result<GameSaveBackup> {
    validate_save_directory(path, "The selected game backup").await?;
    let metadata = fs::symlink_metadata(path)
        .await
        .context("Failed to read the selected game backup")?;
    Ok(GameSaveBackup {
        path: path.to_string_lossy().to_string(),
        size_bytes: directory_size(path).await?,
        last_modified: metadata.modified().ok().map(format_time),
    })
}

fn backup_is_legacy(backup: &GameSaveBackup, backup_slot_root: &Path) -> bool {
    Path::new(&backup.path) == backup_slot_root
}

async fn backup_content_fingerprint(path: &Path) -> Result<String> {
    let mut hasher = Sha256::new();
    hash_save_tree(path, path, &mut hasher).await?;
    Ok(hex::encode(hasher.finalize()))
}

async fn hash_save_tree(root: &Path, path: &Path, hasher: &mut Sha256) -> Result<()> {
    let mut pending_directories = vec![path.to_path_buf()];
    let mut entries = Vec::new();
    while let Some(directory) = pending_directories.pop() {
        let mut directory_entries = fs::read_dir(&directory).await?;
        while let Some(entry) = directory_entries.next_entry().await? {
            let child = entry.path();
            let metadata = fs::symlink_metadata(&child).await?;
            if is_link_or_reparse_point(&metadata) {
                anyhow::bail!(
                    "The selected game backup contains an unsupported symbolic link or reparse point: {}",
                    child.display()
                )
            }
            if metadata.is_dir() {
                pending_directories.push(child.clone());
            }
            entries.push((child, metadata));
        }
    }
    entries.sort_by(|left, right| {
        left.0
            .strip_prefix(root)
            .unwrap_or(&left.0)
            .cmp(right.0.strip_prefix(root).unwrap_or(&right.0))
    });
    for (child, metadata) in entries {
        let relative = child.strip_prefix(root)?;
        hasher.update(relative.to_string_lossy().as_bytes());
        hasher.update([0]);
        if metadata.is_dir() {
            hasher.update(b"dir");
        } else if metadata.is_file() {
            hasher.update(b"file");
            hasher.update(metadata.len().to_le_bytes());
            let contents = fs::read(&child).await?;
            hasher.update(contents);
        } else {
            anyhow::bail!("The selected game backup contains an unsupported file type")
        }
    }
    Ok(())
}

async fn issue_backup_restore_token(
    steam_id: &str,
    slot_number: u8,
    backup: &GameSaveBackup,
) -> Result<String> {
    let snapshot_id = Path::new(&backup.path)
        .file_name()
        .and_then(|name| name.to_str())
        .context("The selected game backup has no snapshot identity")?;
    let token = GameBackupRestoreToken {
        steam_id: steam_id.to_string(),
        slot_number,
        snapshot_id: snapshot_id.to_string(),
        content_fingerprint: backup_content_fingerprint(Path::new(&backup.path)).await?,
    };
    let encoded = serde_json::to_vec(&token).context("Failed to issue the backup restore token")?;
    Ok(URL_SAFE_NO_PAD.encode(encoded))
}

async fn resolve_backup_restore_token(
    encoded_token: &str,
    steam_id: &str,
    slot_number: u8,
    backup_slot_root: &Path,
) -> Result<GameSaveBackup> {
    let bytes = URL_SAFE_NO_PAD
        .decode(encoded_token)
        .context("The restore preview identity is invalid; preview the backup again")?;
    let token: GameBackupRestoreToken = serde_json::from_slice(&bytes)
        .context("The restore preview identity is invalid; preview the backup again")?;
    if token.steam_id != steam_id || token.slot_number != slot_number {
        anyhow::bail!("The restore preview belongs to a different account or save slot")
    }
    let source = read_valid_game_backups(backup_slot_root)
        .await?
        .into_iter()
        .find(|backup| {
            Path::new(&backup.path)
                .file_name()
                .and_then(|name| name.to_str())
                == Some(token.snapshot_id.as_str())
        })
        .context("The selected game backup is no longer available; preview it again")?;
    if backup_content_fingerprint(Path::new(&source.path)).await? != token.content_fingerprint {
        anyhow::bail!("The selected game backup changed after preview; preview it again")
    }
    Ok(source)
}

async fn select_game_backup(
    backup_slot_root: &Path,
    requested_backup_path: Option<&str>,
) -> Result<Option<GameSaveBackup>> {
    let backups = read_valid_game_backups(backup_slot_root).await?;
    Ok(match requested_backup_path {
        Some(path) => backups.into_iter().find(|backup| backup.path == path),
        None => backups.into_iter().next(),
    })
}

fn game_backup_source_label(backup: &GameSaveBackup) -> String {
    let name = Path::new(&backup.path)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("selected backup");
    if name.starts_with("SaveGame_") {
        "Legacy game backup".to_string()
    } else {
        format!("Game backup: {name}")
    }
}

async fn prune_game_backups(
    backup_slot_root: &Path,
    retention_limit: Option<u16>,
    protected_backup: Option<&Path>,
) -> Result<u16> {
    let Some(limit) = retention_limit else {
        return Ok(0);
    };

    let mut snapshots = Vec::new();
    let mut entries = fs::read_dir(backup_slot_root)
        .await
        .context("Failed to inspect the game's save backup folder")?;
    while let Some(entry) = entries.next_entry().await? {
        let path = entry.path();
        if entry.metadata().await?.is_dir()
            && fs::metadata(path.join("Game.json"))
                .await
                .is_ok_and(|metadata| metadata.is_file())
        {
            snapshots.push((entry.file_name().to_string_lossy().to_string(), path));
        }
    }
    snapshots.sort_by(|left, right| right.0.cmp(&left.0));

    // Always preserve the snapshot created by this explicit request, even if an
    // old system clock left another snapshot with a future-looking folder name.
    let mut retained = HashSet::new();
    if let Some(protected_backup) = protected_backup {
        if snapshots.iter().any(|(_, path)| path == protected_backup) {
            retained.insert(protected_backup.to_path_buf());
        }
    }
    for (_, path) in &snapshots {
        if retained.len() >= limit as usize {
            break;
        }
        retained.insert(path.clone());
    }

    let mut pruned = 0;
    for (_, path) in snapshots {
        if retained.contains(&path) {
            continue;
        }
        fs::remove_dir_all(&path).await.with_context(|| {
            format!(
                "Failed to remove the older game backup at {}",
                path.display()
            )
        })?;
        pruned += 1;
    }
    Ok(pruned)
}

async fn directory_size(path: &Path) -> Result<u64> {
    let mut total = 0;
    let mut entries = fs::read_dir(path).await?;
    while let Some(entry) = entries.next_entry().await? {
        let entry_path = entry.path();
        let metadata = fs::symlink_metadata(&entry_path).await?;
        if metadata.file_type().is_symlink() {
            continue;
        }
        if metadata.is_dir() {
            total += Box::pin(directory_size(&entry_path)).await?;
        } else {
            total += metadata.len();
        }
    }
    Ok(total)
}

async fn copy_directory_recursive(source: &Path, destination: &Path) -> Result<()> {
    fs::create_dir_all(destination).await?;
    let mut entries = fs::read_dir(source).await?;
    while let Some(entry) = entries.next_entry().await? {
        let source_path = entry.path();
        let metadata = fs::symlink_metadata(&source_path).await?;
        if metadata.file_type().is_symlink() {
            log::warn!(
                "Skipping symbolic link while creating Schedule I save backup: {}",
                source_path.display()
            );
            continue;
        }
        let destination_path = destination.join(entry.file_name());
        if metadata.is_dir() {
            Box::pin(copy_directory_recursive(&source_path, &destination_path)).await?;
        } else {
            fs::copy(&source_path, &destination_path)
                .await
                .with_context(|| {
                    format!(
                        "Failed to copy Schedule I save file {}",
                        source_path.display()
                    )
                })?;
        }
    }
    Ok(())
}

fn write_save_slot_zip(source: &Path, destination: &Path) -> Result<()> {
    let file = File::create(destination)
        .with_context(|| format!("Failed to create save ZIP export {}", destination.display()))?;
    let mut archive = ZipWriter::new(file);
    let zip_root = source
        .parent()
        .context("Could not determine the save folder's parent directory")?;
    write_directory_to_zip(&mut archive, source, zip_root)?;
    archive
        .finish()
        .context("Failed to finish the save ZIP export")?;
    Ok(())
}

fn extract_save_zip(zip_path: &Path, destination: &Path, slot_number: u8) -> Result<()> {
    extract_save_zip_with_budget(
        zip_path,
        destination,
        slot_number,
        &mut ArchiveBudget::default(),
    )
}

fn extract_save_zip_with_budget(
    zip_path: &Path,
    destination: &Path,
    slot_number: u8,
    budget: &mut ArchiveBudget,
) -> Result<()> {
    let zip_file = File::open(zip_path)
        .with_context(|| format!("Failed to open save ZIP {}", zip_path.display()))?;
    let mut archive = ZipArchive::new(zip_file).context("Failed to read the save ZIP")?;
    let root = format!("SaveGame_{slot_number}/");
    let has_slot_root = archive
        .file_names()
        .any(|name| name.replace('\\', "/").starts_with(&root));

    for index in 0..archive.len() {
        let mut entry = archive.by_index(index)?;
        if entry
            .unix_mode()
            .is_some_and(|mode| mode & 0o170000 == 0o120000)
        {
            anyhow::bail!("Save ZIP contains an unsupported symbolic link")
        }

        let name = entry.name().replace('\\', "/");
        let relative_name = if has_slot_root {
            name.strip_prefix(&root)
                .context("Save ZIP contains files outside the selected save folder")?
        } else {
            name.as_str()
        }
        .trim_end_matches('/');
        if relative_name.is_empty() {
            continue;
        }
        budget.account(relative_name, entry.size())?;
        let output_path = safe_zip_output_path(destination, relative_name)?;
        if entry.is_dir() {
            std::fs::create_dir_all(&output_path)?;
            continue;
        }

        let parent = output_path
            .parent()
            .context("Invalid save ZIP entry path")?;
        std::fs::create_dir_all(parent)?;
        budget
            .copy_entry_to_path(relative_name, &mut entry, &output_path)
            .with_context(|| format!("Failed to restore {} from the save ZIP", relative_name))?;
    }

    if !destination.join("Game.json").is_file() {
        anyhow::bail!("The ZIP does not contain a valid Schedule I save folder")
    }
    Ok(())
}

fn safe_zip_output_path(destination: &Path, name: &str) -> Result<PathBuf> {
    if name.starts_with('/')
        || name
            .split('/')
            .any(|part| part.is_empty() || part == "." || part == "..")
    {
        anyhow::bail!("Save ZIP contains an unsafe file path")
    }
    let mut output = destination.to_path_buf();
    for component in name.split('/') {
        if component.contains(':') {
            anyhow::bail!("Save ZIP contains an unsafe file path")
        }
        output.push(component);
    }
    Ok(output)
}

fn write_directory_to_zip(
    archive: &mut ZipWriter<File>,
    source: &Path,
    zip_root: &Path,
) -> Result<()> {
    let options = FileOptions::default()
        .compression_method(CompressionMethod::Deflated)
        .unix_permissions(0o644);
    let relative_directory = zip_path(source.strip_prefix(zip_root)?);
    archive
        .add_directory(format!("{relative_directory}/"), options)
        .context("Failed to add a save directory to the ZIP export")?;

    for entry in std::fs::read_dir(source)
        .with_context(|| format!("Failed to read save directory {}", source.display()))?
    {
        let entry = entry?;
        let path = entry.path();
        let metadata = std::fs::symlink_metadata(&path)?;
        if metadata.file_type().is_symlink() {
            log::warn!(
                "Skipping symbolic link while exporting Schedule I save: {}",
                path.display()
            );
            continue;
        }

        if metadata.is_dir() {
            write_directory_to_zip(archive, &path, zip_root)?;
            continue;
        }

        archive
            .start_file(zip_path(path.strip_prefix(zip_root)?), options)
            .with_context(|| format!("Failed to add {} to the save ZIP export", path.display()))?;
        let mut file = File::open(&path)
            .with_context(|| format!("Failed to read save file {}", path.display()))?;
        let mut buffer = [0_u8; 64 * 1024];
        loop {
            let bytes_read = file.read(&mut buffer)?;
            if bytes_read == 0 {
                break;
            }
            archive.write_all(&buffer[..bytes_read])?;
        }
    }
    Ok(())
}

fn zip_path(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

fn format_time(value: SystemTime) -> String {
    DateTime::<Utc>::from(value).to_rfc3339()
}

#[cfg(test)]
mod tests {
    use super::{
        backup_content_fingerprint, cash_balance_from_inventory, create_backup_snapshot,
        extract_save_zip, extract_save_zip_with_budget, extract_steam_display_name,
        game_backup_from_path, game_date_from_json, issue_backup_restore_token, json_number,
        json_unsigned, lock_save_slot, organization_name_from_json, prune_game_backups,
        read_backup, read_valid_game_backups, resolve_backup_restore_token,
        restore_directory_to_slot, restore_preview, restore_staging_path, safe_zip_output_path,
        select_game_backup, slot_path, validate_slot_number, validate_steam_id,
        write_save_slot_zip,
    };
    use crate::services::fomod::ArchiveBudget;
    use std::io::{Read, Write};
    use std::path::Path;
    use std::time::Duration;
    use tempfile::tempdir;

    fn write_game_json(path: &Path, organization_name: &str) {
        std::fs::create_dir_all(path).expect("save directory");
        std::fs::write(
            path.join("Game.json"),
            format!(r#"{{"OrganisationName":"{organization_name}"}}"#),
        )
        .expect("game json");
    }

    #[test]
    fn steam_ids_are_kept_inside_the_save_root() {
        assert!(validate_steam_id("76561198000000000").is_ok());
        assert!(validate_steam_id("not-a-steam-id").is_err());
        assert!(validate_steam_id("../outside").is_err());
        assert!(validate_steam_id("nested/profile").is_err());
    }

    #[test]
    fn game_backup_slots_are_limited_to_the_five_supported_slots() {
        assert!(validate_slot_number(1).is_ok());
        assert!(validate_slot_number(5).is_ok());
        assert!(validate_slot_number(0).is_err());
        assert!(validate_slot_number(6).is_err());
        assert_eq!(
            slot_path(Path::new("C:/Saves"), 2),
            Path::new("C:/Saves/SaveGame_2")
        );
    }

    #[test]
    fn restore_staging_paths_are_unique_per_operation() {
        let destination = Path::new("C:/saves/SaveGame_3");
        let first = restore_staging_path(destination, 3);
        let second = restore_staging_path(destination, 3);

        assert_ne!(first, second);
        assert_eq!(first.parent(), destination.parent());
        assert!(first.file_name().is_some_and(|name| name
            .to_string_lossy()
            .starts_with("SaveGame_3.simm-restore-")));
    }

    #[tokio::test]
    async fn save_slot_operations_serialize_only_the_same_account_slot() {
        let steam_id = format!("test-{}", uuid::Uuid::new_v4());
        let first = lock_save_slot(&steam_id, 1).await;

        assert!(
            tokio::time::timeout(Duration::from_millis(20), lock_save_slot(&steam_id, 1))
                .await
                .is_err()
        );
        assert!(
            tokio::time::timeout(Duration::from_millis(20), lock_save_slot(&steam_id, 2))
                .await
                .is_ok()
        );

        drop(first);
        assert!(
            tokio::time::timeout(Duration::from_millis(20), lock_save_slot(&steam_id, 1))
                .await
                .is_ok()
        );
    }

    #[test]
    fn steam_profile_xml_yields_the_persona_name() {
        let profile = "<profile><steamID><![CDATA[SIMM &amp; Friends]]></steamID></profile>";
        assert_eq!(
            extract_steam_display_name(profile).as_deref(),
            Some("SIMM & Friends")
        );
    }

    #[test]
    fn game_data_yields_the_organization_name() {
        let game_data: serde_json::Value =
            serde_json::from_str(r#"{ "OrganisationName": "Testing" }"#).expect("game data");
        assert_eq!(
            organization_name_from_json(Some(&game_data)).as_deref(),
            Some("Testing")
        );
        assert_eq!(organization_name_from_json(None), None);
    }

    #[test]
    fn save_json_yields_cash_progress_and_dates() {
        let money: serde_json::Value =
            serde_json::from_str(r#"{ "OnlineBalance": 202597.953125, "Networth": 11182234.0 }"#)
                .expect("money data");
        let rank: serde_json::Value =
            serde_json::from_str(r#"{ "Rank": 10, "Tier": 28, "TotalXP": 120720 }"#)
                .expect("rank data");
        let metadata: serde_json::Value = serde_json::from_str(
            r#"{ "LastPlayedDate": { "Year": 2026, "Month": 4, "Day": 14, "Hour": 16, "Minute": 31, "Second": 29 } }"#,
        )
        .expect("metadata");
        let inventory: serde_json::Value = serde_json::from_str(
            r#"{ "Items": ["{\"DataType\":\"CashData\",\"CashBalance\":83072.0}"] }"#,
        )
        .expect("inventory");

        assert_eq!(
            json_number(Some(&money), "OnlineBalance"),
            Some(202597.953125)
        );
        assert_eq!(cash_balance_from_inventory(Some(&inventory)), Some(83072.0));
        assert_eq!(json_unsigned(Some(&rank), "TotalXP"), Some(120720));
        assert_eq!(
            game_date_from_json(Some(&metadata), "LastPlayedDate").as_deref(),
            Some("2026-04-14T16:31:29")
        );
    }

    #[test]
    fn zip_export_preserves_the_game_save_folder_and_contents() {
        let temporary_directory = tempdir().expect("temporary directory");
        let save_slot = temporary_directory.path().join("SaveGame_2");
        let nested_directory = save_slot.join("Nested");
        std::fs::create_dir_all(&nested_directory).expect("nested save directory");
        std::fs::write(save_slot.join("save.json"), b"save data").expect("save file");
        std::fs::write(nested_directory.join("state.dat"), b"nested data").expect("nested file");
        let destination = temporary_directory.path().join("export.zip");

        write_save_slot_zip(&save_slot, &destination).expect("write save ZIP");

        let file = std::fs::File::open(destination).expect("open ZIP");
        let mut archive = zip::ZipArchive::new(file).expect("read ZIP");
        let mut save_file = archive
            .by_name("SaveGame_2/save.json")
            .expect("save ZIP entry");
        let mut contents = String::new();
        save_file
            .read_to_string(&mut contents)
            .expect("read ZIP entry");
        assert_eq!(contents, "save data");
        drop(save_file);
        assert!(archive.by_name("SaveGame_2/Nested/state.dat").is_ok());
    }

    #[test]
    fn zip_restore_extracts_the_selected_save_folder() {
        let temporary_directory = tempdir().expect("temporary directory");
        let save_slot = temporary_directory.path().join("SaveGame_2");
        std::fs::create_dir_all(save_slot.join("Nested")).expect("nested save directory");
        std::fs::write(
            save_slot.join("Game.json"),
            b"{\"OrganisationName\":\"Testing\"}",
        )
        .expect("game data");
        std::fs::write(save_slot.join("Nested/state.dat"), b"nested data").expect("nested data");
        let archive_path = temporary_directory.path().join("export.zip");
        let restored_slot = temporary_directory.path().join("restored");

        write_save_slot_zip(&save_slot, &archive_path).expect("write save ZIP");
        extract_save_zip(&archive_path, &restored_slot, 2).expect("restore save ZIP");

        assert_eq!(
            std::fs::read_to_string(restored_slot.join("Game.json")).expect("restored game data"),
            "{\"OrganisationName\":\"Testing\"}"
        );
        assert_eq!(
            std::fs::read(restored_slot.join("Nested/state.dat")).expect("restored nested data"),
            b"nested data"
        );
    }

    #[test]
    fn zip_restore_rejects_unsafe_entry_paths() {
        assert!(safe_zip_output_path(Path::new("C:/restore"), "../outside").is_err());
        assert!(safe_zip_output_path(Path::new("C:/restore"), "C:/outside").is_err());
        assert!(safe_zip_output_path(Path::new("C:/restore"), "Game.json").is_ok());
    }

    #[test]
    fn zip_restore_enforces_archive_resource_limits() {
        let temporary_directory = tempdir().expect("temporary directory");
        let archive_path = temporary_directory.path().join("oversized.zip");
        let destination = temporary_directory.path().join("restored");
        let file = std::fs::File::create(&archive_path).expect("create ZIP");
        let mut archive = zip::ZipWriter::new(file);
        archive
            .start_file("Game.json", zip::write::FileOptions::default())
            .expect("start Game.json");
        archive.write_all(b"{}").expect("write Game.json");
        archive.finish().expect("finish ZIP");

        let mut budget = ArchiveBudget::with_test_limits(10, 1, 10, 8);
        let error = extract_save_zip_with_budget(&archive_path, &destination, 1, &mut budget)
            .expect_err("oversized save entry must be rejected");

        assert!(error.to_string().contains("expanded-size limit"));
        assert!(!destination.join("Game.json").exists());
    }

    #[tokio::test]
    async fn restore_preview_compares_the_current_and_restored_save_details() {
        let temporary_directory = tempdir().expect("temporary directory");
        let current = temporary_directory.path().join("SaveGame_1");
        let restored = temporary_directory.path().join("backup-SaveGame_1");
        std::fs::create_dir_all(&current).expect("current save directory");
        std::fs::create_dir_all(&restored).expect("restored save directory");
        std::fs::write(
            current.join("Game.json"),
            r#"{ "OrganisationName": "Current" }"#,
        )
        .expect("current game data");
        std::fs::write(
            restored.join("Game.json"),
            r#"{ "OrganisationName": "Restored" }"#,
        )
        .expect("restored game data");
        std::fs::write(
            current.join("Money.json"),
            r#"{ "OnlineBalance": 120.0, "Networth": 500.0 }"#,
        )
        .expect("current money data");
        std::fs::write(
            restored.join("Money.json"),
            r#"{ "OnlineBalance": 90.0, "Networth": 320.0 }"#,
        )
        .expect("restored money data");

        let preview = restore_preview(
            "76561198000000000",
            1,
            "Game backup".to_string(),
            restored.to_string_lossy().to_string(),
            None,
            &current,
            &restored,
        )
        .await
        .expect("restore preview");

        assert_eq!(
            preview.current.organization_name.as_deref(),
            Some("Current")
        );
        assert_eq!(
            preview.restored.organization_name.as_deref(),
            Some("Restored")
        );
        assert_eq!(preview.current.online_balance, Some(120.0));
        assert_eq!(preview.restored.net_worth, Some(320.0));
    }

    #[tokio::test]
    async fn game_backup_detection_uses_the_latest_valid_timestamped_snapshot() {
        let temporary_directory = tempdir().expect("temporary directory");
        let backup_slot_root = temporary_directory.path().join("SaveGame_3");
        let invalid_snapshot = backup_slot_root.join("2025-08-11_20-12-00");
        let older_snapshot = backup_slot_root.join("2025-08-11_20-08-25");
        let latest_snapshot = backup_slot_root.join("2025-08-11_20-11-13");
        std::fs::create_dir_all(&invalid_snapshot).expect("invalid snapshot directory");
        std::fs::create_dir_all(&older_snapshot).expect("older snapshot directory");
        std::fs::create_dir_all(&latest_snapshot).expect("latest snapshot directory");
        std::fs::write(older_snapshot.join("Game.json"), "{}").expect("older game data");
        std::fs::write(latest_snapshot.join("Game.json"), "{}").expect("latest game data");

        let backup = read_backup(&backup_slot_root)
            .await
            .expect("inspect game backup")
            .expect("valid game backup");

        assert!(backup.path.ends_with("2025-08-11_20-11-13"));

        let backups = read_valid_game_backups(&backup_slot_root)
            .await
            .expect("list game backups");
        assert_eq!(backups.len(), 2);
        assert!(backups[0].path.ends_with("2025-08-11_20-11-13"));
        assert!(backups[1].path.ends_with("2025-08-11_20-08-25"));

        let selected = select_game_backup(&backup_slot_root, Some(&backups[1].path))
            .await
            .expect("select game backup")
            .expect("selected game backup");
        assert_eq!(selected.path, backups[1].path);
        assert!(
            select_game_backup(&backup_slot_root, Some("C:/not-a-game-backup"))
                .await
                .expect("reject unknown game backup")
                .is_none()
        );
    }

    #[tokio::test]
    async fn retention_keeps_the_newest_game_style_snapshots() {
        let temporary_directory = tempdir().expect("temporary directory");
        let backup_slot_root = temporary_directory.path().join("SaveGame_1");
        let oldest = backup_slot_root.join("2025-08-10_04-13-07");
        let newest = backup_slot_root.join("2025-08-11_20-11-13");
        let incomplete = backup_slot_root.join("2025-08-12_10-00-00");
        for snapshot in [&oldest, &newest, &incomplete] {
            std::fs::create_dir_all(snapshot).expect("snapshot directory");
        }
        std::fs::write(oldest.join("Game.json"), "{}").expect("older game data");
        std::fs::write(newest.join("Game.json"), "{}").expect("newer game data");

        assert_eq!(
            prune_game_backups(&backup_slot_root, Some(1), None)
                .await
                .expect("prune backups"),
            1
        );
        assert!(!oldest.exists());
        assert!(newest.exists());
        assert!(incomplete.exists());

        let newly_created = backup_slot_root.join("2025-08-12_11-00-00");
        let future_dated = backup_slot_root.join("2030-01-01_00-00-00");
        std::fs::create_dir_all(&newly_created).expect("new snapshot directory");
        std::fs::create_dir_all(&future_dated).expect("future snapshot directory");
        std::fs::write(newly_created.join("Game.json"), "{}").expect("new game data");
        std::fs::write(future_dated.join("Game.json"), "{}").expect("future game data");

        assert_eq!(
            prune_game_backups(&backup_slot_root, Some(1), Some(&newly_created))
                .await
                .expect("prune with protected backup"),
            2
        );
        assert!(newly_created.exists());
        assert!(!newest.exists());
        assert!(!future_dated.exists());
    }

    #[tokio::test]
    async fn restore_token_rejects_a_backup_changed_after_preview() {
        let temporary_directory = tempdir().expect("temporary directory");
        let backup_root = temporary_directory.path().join("backups/SaveGame_2");
        let snapshot = backup_root.join("2026-08-20_12-00-00");
        write_game_json(&snapshot, "Before preview");
        let backup = game_backup_from_path(&snapshot)
            .await
            .expect("backup identity");
        let token = issue_backup_restore_token("76561198000000000", 2, &backup)
            .await
            .expect("preview token");

        write_game_json(&snapshot, "Changed after preview");
        let error = resolve_backup_restore_token(&token, "76561198000000000", 2, &backup_root)
            .await
            .expect_err("changed backup must require a new preview");
        assert!(error.to_string().contains("changed after preview"));
    }

    #[tokio::test]
    async fn legacy_restore_excludes_nested_snapshots_and_creates_a_rollback_backup() {
        let temporary_directory = tempdir().expect("temporary directory");
        let account = temporary_directory.path().join("76561198000000000");
        let destination = account.join("SaveGame_1");
        let backup_root = account.join("backups/SaveGame_1");
        write_game_json(&destination, "Current save");
        write_game_json(&backup_root, "Legacy save");
        write_game_json(&backup_root.join("2026-08-20_12-00-00"), "Nested snapshot");

        restore_directory_to_slot(&backup_root, &destination, &backup_root, true)
            .await
            .expect("restore legacy save");

        let restored =
            std::fs::read_to_string(destination.join("Game.json")).expect("restored game data");
        assert!(restored.contains("Legacy save"));
        assert!(
            !destination.join("2026-08-20_12-00-00").exists(),
            "nested snapshot must remain backup-manager data, not live save payload"
        );
        let rollback = std::fs::read_dir(&backup_root)
            .expect("backup entries")
            .filter_map(Result::ok)
            .map(|entry| entry.path())
            .find(|path| {
                path.file_name()
                    .is_some_and(|name| name.to_string_lossy().contains("pre-restore"))
            })
            .expect("automatic rollback snapshot");
        assert!(std::fs::read_to_string(rollback.join("Game.json"))
            .expect("rollback game data")
            .contains("Current save"));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn validation_rejects_symlinked_game_json_before_copy_or_restore() {
        let temporary_directory = tempdir().expect("temporary directory");
        let save = temporary_directory.path().join("SaveGame_1");
        let outside = temporary_directory.path().join("outside-Game.json");
        std::fs::create_dir_all(&save).expect("save directory");
        std::fs::write(&outside, b"{}").expect("outside data");
        std::os::unix::fs::symlink(&outside, save.join("Game.json")).expect("game link");

        let error = super::validate_save_directory(&save, "The selected game backup")
            .await
            .expect_err("symlinked Game.json must be rejected");
        assert!(error.to_string().contains("unsafe or invalid Game.json"));
    }

    #[tokio::test]
    async fn fingerprint_changes_when_nested_payload_changes() {
        let temporary_directory = tempdir().expect("temporary directory");
        let save = temporary_directory.path().join("SaveGame_1");
        write_game_json(&save, "Fingerprint");
        std::fs::create_dir_all(save.join("Nested")).expect("nested directory");
        std::fs::write(save.join("Nested/state.bin"), b"first").expect("nested payload");
        let initial = backup_content_fingerprint(&save)
            .await
            .expect("initial fingerprint");
        std::fs::write(save.join("Nested/state.bin"), b"second").expect("changed payload");
        let changed = backup_content_fingerprint(&save)
            .await
            .expect("changed fingerprint");
        assert_ne!(initial, changed);
    }

    #[tokio::test]
    async fn corrupt_source_backup_returns_its_exact_error_without_selecting_an_older_snapshot() {
        let temporary_directory = tempdir().expect("temporary directory");
        let source = temporary_directory.path().join("SaveGame_1");
        let backup_root = temporary_directory.path().join("backups/SaveGame_1");
        std::fs::create_dir_all(&source).expect("source directory");
        std::fs::write(source.join("Game.json"), b"not valid JSON").expect("corrupt game data");
        write_game_json(
            &backup_root.join("2026-08-20_12-00-00"),
            "Older valid backup",
        );

        let error = create_backup_snapshot(&source, &backup_root, "manual")
            .await
            .expect_err("corrupt source must not be converted into an older backup result");
        assert!(error.to_string().contains("invalid Game.json"));
        assert_eq!(
            std::fs::read_dir(&backup_root)
                .expect("backup entries")
                .filter_map(Result::ok)
                .count(),
            1,
            "the pre-existing snapshot must not be misreported as the requested backup"
        );
    }
}
