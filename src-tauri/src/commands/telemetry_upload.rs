use std::sync::Arc;

use sqlx::SqlitePool;
use tauri::State;

use crate::services::{
    telemetry::ensure_telemetry_feature_enabled, telemetry_upload::TelemetryUploadService,
};
use crate::types::{TelemetryUploadPreview, TelemetryUploadReceipt};

#[tauri::command]
pub async fn preview_telemetry_upload(
    db: State<'_, Arc<SqlitePool>>,
    environment_id: Option<String>,
) -> Result<TelemetryUploadPreview, String> {
    ensure_telemetry_feature_enabled().map_err(|error| error.to_string())?;
    TelemetryUploadService::new(db.inner().clone())
        .preview_upload(environment_id)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn queue_telemetry_upload(
    db: State<'_, Arc<SqlitePool>>,
    preview_payload: String,
) -> Result<TelemetryUploadReceipt, String> {
    ensure_telemetry_feature_enabled().map_err(|error| error.to_string())?;
    TelemetryUploadService::new(db.inner().clone())
        .queue_reviewed_upload(&preview_payload)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn list_telemetry_uploads(
    db: State<'_, Arc<SqlitePool>>,
) -> Result<Vec<TelemetryUploadReceipt>, String> {
    ensure_telemetry_feature_enabled().map_err(|error| error.to_string())?;
    TelemetryUploadService::new(db.inner().clone())
        .list_uploads()
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn flush_queued_telemetry_uploads(
    db: State<'_, Arc<SqlitePool>>,
) -> Result<Vec<TelemetryUploadReceipt>, String> {
    ensure_telemetry_feature_enabled().map_err(|error| error.to_string())?;
    TelemetryUploadService::new(db.inner().clone())
        .flush_queued_uploads()
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn retry_telemetry_upload(
    db: State<'_, Arc<SqlitePool>>,
    id: String,
) -> Result<TelemetryUploadReceipt, String> {
    ensure_telemetry_feature_enabled().map_err(|error| error.to_string())?;
    TelemetryUploadService::new(db.inner().clone())
        .retry_upload(&id)
        .await
        .map_err(|error| error.to_string())
}
