use std::sync::Arc;

use sqlx::SqlitePool;
use tauri::State;

use crate::services::telemetry::TelemetryService;
use crate::types::{
    LiveTelemetryEvent, LiveTelemetryExport, LiveTelemetryStatus, ModTelemetryCaptureRequest,
    ModTelemetrySnapshot, ModTelemetrySnapshotSummary, TelemetryPreferences,
    TelemetryPreferencesUpdate,
};

#[tauri::command]
pub async fn get_telemetry_preferences(
    db: State<'_, Arc<SqlitePool>>,
) -> Result<TelemetryPreferences, String> {
    TelemetryService::new(db.inner().clone())
        .get_preferences()
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn save_telemetry_preferences(
    db: State<'_, Arc<SqlitePool>>,
    updates: TelemetryPreferencesUpdate,
) -> Result<TelemetryPreferences, String> {
    TelemetryService::new(db.inner().clone())
        .save_preferences(updates)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn capture_mod_telemetry_snapshot(
    db: State<'_, Arc<SqlitePool>>,
    request: ModTelemetryCaptureRequest,
) -> Result<ModTelemetrySnapshot, String> {
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
    TelemetryService::new(db.inner().clone())
        .delete_snapshot(&snapshot_id)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn get_live_telemetry_status(
    db: State<'_, Arc<SqlitePool>>,
) -> Result<Vec<LiveTelemetryStatus>, String> {
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
    TelemetryService::new(db.inner().clone())
        .export_live_history(environment_id)
        .await
        .map_err(|error| error.to_string())
}
