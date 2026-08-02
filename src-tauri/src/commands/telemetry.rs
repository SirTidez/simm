use std::sync::Arc;

use sqlx::SqlitePool;
use tauri::{AppHandle, Emitter, State};

use crate::services::telemetry::{ensure_telemetry_feature_enabled, TelemetryService};
use crate::services::telemetry_upload::TelemetryUploadService;
use crate::types::{
    LiveTelemetryEvent, LiveTelemetryExport, LiveTelemetryStatus, ModTelemetryCaptureRequest,
    ModTelemetrySnapshot, ModTelemetrySnapshotSummary, TelemetryModPolicyItem,
    TelemetryModRuleUpdate, TelemetryPreferences, TelemetryPreferencesUpdate,
};

#[tauri::command]
pub async fn get_telemetry_preferences(
    db: State<'_, Arc<SqlitePool>>,
) -> Result<TelemetryPreferences, String> {
    ensure_telemetry_feature_enabled().map_err(|error| error.to_string())?;
    TelemetryService::new(db.inner().clone())
        .get_preferences()
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn save_telemetry_preferences(
    db: State<'_, Arc<SqlitePool>>,
    app: AppHandle,
    updates: TelemetryPreferencesUpdate,
) -> Result<TelemetryPreferences, String> {
    ensure_telemetry_feature_enabled().map_err(|error| error.to_string())?;
    let policy_changed = updates.protect_local_mods.is_some();
    let preferences = TelemetryService::new(db.inner().clone())
        .save_preferences(updates)
        .await
        .map_err(|error| error.to_string())?;

    if policy_changed {
        TelemetryUploadService::new(db.inner().clone())
            .discard_unaccepted_uploads()
            .await
            .map_err(|error| error.to_string())?;
    }

    if let Err(error) = app.emit("telemetry_preferences_changed", &preferences) {
        log::warn!(
            "Failed to notify the live telemetry monitor about preference changes: {}",
            error
        );
    }

    Ok(preferences)
}

#[tauri::command]
pub async fn list_telemetry_mod_policies(
    db: State<'_, Arc<SqlitePool>>,
    environment_id: String,
) -> Result<Vec<TelemetryModPolicyItem>, String> {
    ensure_telemetry_feature_enabled().map_err(|error| error.to_string())?;
    TelemetryService::new(db.inner().clone())
        .list_mod_policies(&environment_id)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn save_telemetry_mod_rule(
    db: State<'_, Arc<SqlitePool>>,
    update: TelemetryModRuleUpdate,
) -> Result<(), String> {
    ensure_telemetry_feature_enabled().map_err(|error| error.to_string())?;
    TelemetryService::new(db.inner().clone())
        .save_mod_rule(update)
        .await
        .map_err(|error| error.to_string())?;
    TelemetryUploadService::new(db.inner().clone())
        .discard_unaccepted_uploads()
        .await
        .map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn capture_mod_telemetry_snapshot(
    db: State<'_, Arc<SqlitePool>>,
    request: ModTelemetryCaptureRequest,
) -> Result<ModTelemetrySnapshot, String> {
    ensure_telemetry_feature_enabled().map_err(|error| error.to_string())?;
    TelemetryService::new(db.inner().clone())
        .capture_snapshot(request)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn list_mod_telemetry_snapshots(
    db: State<'_, Arc<SqlitePool>>,
    environment_id: Option<String>,
) -> Result<Vec<ModTelemetrySnapshotSummary>, String> {
    ensure_telemetry_feature_enabled().map_err(|error| error.to_string())?;
    TelemetryService::new(db.inner().clone())
        .list_snapshots(environment_id)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn get_mod_telemetry_snapshot(
    db: State<'_, Arc<SqlitePool>>,
    snapshot_id: String,
) -> Result<ModTelemetrySnapshot, String> {
    ensure_telemetry_feature_enabled().map_err(|error| error.to_string())?;
    TelemetryService::new(db.inner().clone())
        .get_snapshot(&snapshot_id)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn delete_mod_telemetry_snapshot(
    db: State<'_, Arc<SqlitePool>>,
    snapshot_id: String,
) -> Result<(), String> {
    ensure_telemetry_feature_enabled().map_err(|error| error.to_string())?;
    TelemetryService::new(db.inner().clone())
        .delete_snapshot(&snapshot_id)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn get_live_telemetry_status(
    db: State<'_, Arc<SqlitePool>>,
) -> Result<Vec<LiveTelemetryStatus>, String> {
    ensure_telemetry_feature_enabled().map_err(|error| error.to_string())?;
    TelemetryService::new(db.inner().clone())
        .get_live_status()
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn list_live_telemetry_events(
    db: State<'_, Arc<SqlitePool>>,
    environment_id: Option<String>,
    limit: Option<u32>,
) -> Result<Vec<LiveTelemetryEvent>, String> {
    ensure_telemetry_feature_enabled().map_err(|error| error.to_string())?;
    TelemetryService::new(db.inner().clone())
        .list_live_events(environment_id, limit)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn clear_live_telemetry_history(
    db: State<'_, Arc<SqlitePool>>,
    environment_id: Option<String>,
) -> Result<(), String> {
    ensure_telemetry_feature_enabled().map_err(|error| error.to_string())?;
    TelemetryService::new(db.inner().clone())
        .clear_live_history(environment_id)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn export_live_telemetry_history(
    db: State<'_, Arc<SqlitePool>>,
    environment_id: Option<String>,
) -> Result<LiveTelemetryExport, String> {
    ensure_telemetry_feature_enabled().map_err(|error| error.to_string())?;
    TelemetryService::new(db.inner().clone())
        .export_live_history(environment_id)
        .await
        .map_err(|error| error.to_string())
}
