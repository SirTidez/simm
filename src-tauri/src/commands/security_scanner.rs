use crate::services::environment::EnvironmentService;
use crate::services::mods::ModsService;
use crate::services::security_scanner::SecurityScannerService;
use crate::services::settings::RuntimeSettingsState;
use crate::types::{SecurityScanReport, SecurityScannerStatus, Settings};
use sqlx::SqlitePool;
use std::path::Path;
use std::sync::Arc;
use tauri::State;

pub(crate) async fn scan_artifact_for_security_with_settings(
    settings: &Settings,
    file_path: &str,
) -> Result<SecurityScanReport, String> {
    let scanner_service = SecurityScannerService::new();
    scanner_service
        .scan_artifact(Path::new(file_path), settings)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_security_scanner_status(
    runtime_settings: State<'_, RuntimeSettingsState>,
) -> Result<SecurityScannerStatus, String> {
    let settings = runtime_settings.snapshot().await;
    let scanner_service = SecurityScannerService::new();
    scanner_service
        .get_status(&settings)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn install_security_scanner(
    runtime_settings: State<'_, RuntimeSettingsState>,
) -> Result<SecurityScannerStatus, String> {
    let settings = runtime_settings.snapshot().await;
    let scanner_service = SecurityScannerService::new();
    scanner_service
        .install_latest(&settings)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_mod_security_scan_report(
    db: State<'_, Arc<SqlitePool>>,
    runtime_settings: State<'_, RuntimeSettingsState>,
    storage_id: String,
) -> Result<Option<SecurityScanReport>, String> {
    let mods_service = ModsService::new(db.inner().clone())
        .with_runtime_settings(runtime_settings.snapshot().await);
    mods_service
        .get_security_scan_report(&storage_id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn scan_installed_mod_for_security(
    db: State<'_, Arc<SqlitePool>>,
    runtime_settings: State<'_, RuntimeSettingsState>,
    environment_id: String,
    file_name: String,
) -> Result<SecurityScanReport, String> {
    let env_service = EnvironmentService::new(db.inner().clone()).map_err(|e| e.to_string())?;
    let env = env_service
        .get_environment(&environment_id)
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "Environment not found".to_string())?;

    if env.output_dir.is_empty() {
        return Err("Output directory not set".to_string());
    }

    let settings = runtime_settings.snapshot().await;
    let mods_service = ModsService::new(db.inner().clone()).with_runtime_settings(settings.clone());
    let installed_path = mods_service
        .resolve_installed_mod_path(&env.output_dir, &file_name)
        .await
        .map_err(|e| e.to_string())?;
    let report = scan_artifact_for_security_with_settings(
        &settings,
        installed_path.to_string_lossy().as_ref(),
    )
    .await?;

    mods_service
        .persist_installed_mod_security_scan_summary(
            &env.output_dir,
            &file_name,
            report.summary.clone(),
        )
        .await
        .map_err(|e| e.to_string())?;

    Ok(report)
}
