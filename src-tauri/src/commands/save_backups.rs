use crate::services::save_backups::SaveBackupsService;
use crate::types::{
    GameSaveBackupExportResult, GameSaveBackupResult, GameSaveBackupStatus, GameSaveRestorePreview,
    GameSaveRestoreResult,
};

#[tauri::command]
pub async fn get_game_save_backup_status() -> Result<GameSaveBackupStatus, String> {
    SaveBackupsService::new()
        .get_status()
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn create_game_save_backup(
    steam_id: String,
    slot_number: u8,
    retention_limit: Option<u16>,
) -> Result<GameSaveBackupResult, String> {
    SaveBackupsService::new()
        .create_backup(&steam_id, slot_number, retention_limit)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn export_game_save_backup(
    steam_id: String,
    slot_number: u8,
    destination_path: String,
) -> Result<GameSaveBackupExportResult, String> {
    SaveBackupsService::new()
        .export_backup(&steam_id, slot_number, &destination_path)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn restore_game_save_backup(
    steam_id: String,
    slot_number: u8,
    restore_token: String,
) -> Result<GameSaveRestoreResult, String> {
    SaveBackupsService::new()
        .restore_from_game_backup(&steam_id, slot_number, &restore_token)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn restore_game_save_from_zip(
    steam_id: String,
    slot_number: u8,
    zip_path: String,
) -> Result<GameSaveRestoreResult, String> {
    SaveBackupsService::new()
        .restore_from_zip(&steam_id, slot_number, &zip_path)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn preview_game_save_backup_restore(
    steam_id: String,
    slot_number: u8,
    backup_path: Option<String>,
) -> Result<GameSaveRestorePreview, String> {
    SaveBackupsService::new()
        .preview_game_backup_restore(&steam_id, slot_number, backup_path.as_deref())
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn preview_game_save_zip_restore(
    steam_id: String,
    slot_number: u8,
    zip_path: String,
) -> Result<GameSaveRestorePreview, String> {
    SaveBackupsService::new()
        .preview_zip_restore(&steam_id, slot_number, &zip_path)
        .await
        .map_err(|error| error.to_string())
}
