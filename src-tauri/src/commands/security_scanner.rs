use crate::services::mods::ModsService;
use crate::services::security_scanner::SecurityScannerService;
use crate::services::settings::SettingsService;
use crate::types::{SecurityScanReport, SecurityScannerStatus, Settings};
use sqlx::SqlitePool;
use std::path::Path;
use std::sync::Arc;
use tauri::State;

async fn load_settings(db: Arc<SqlitePool>) -> Result<Settings, String> {
    let mut service = SettingsService::new(db).map_err(|e| e.to_string())?;
    service.load_settings().await.map_err(|e| e.to_string())
}

pub(crate) async fn scan_artifact_for_security(
    db: Arc<SqlitePool>,
    file_path: &str,
) -> Result<SecurityScanReport, String> {
    let settings = load_settings(db).await?;
    let scanner_service = SecurityScannerService::new();
    scanner_service
        .scan_artifact(Path::new(file_path), &settings)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_security_scanner_status(
    db: State<'_, Arc<SqlitePool>>,
) -> Result<SecurityScannerStatus, String> {
    let settings = load_settings(db.inner().clone()).await?;
    let scanner_service = SecurityScannerService::new();
    scanner_service
        .get_status(&settings)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn install_security_scanner(
    db: State<'_, Arc<SqlitePool>>,
) -> Result<SecurityScannerStatus, String> {
    let settings = load_settings(db.inner().clone()).await?;
    let scanner_service = SecurityScannerService::new();
    scanner_service
        .install_latest(&settings)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_mod_security_scan_report(
    db: State<'_, Arc<SqlitePool>>,
    storage_id: String,
) -> Result<Option<SecurityScanReport>, String> {
    let mods_service = ModsService::new(db.inner().clone());
    mods_service
        .get_security_scan_report(&storage_id)
        .await
        .map_err(|e| e.to_string())
}
