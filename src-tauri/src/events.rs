use crate::types::{DownloadProgress, TrackedDownload, UpdateCheckResult};
use tauri::{AppHandle, Emitter, Runtime};

pub fn emit_progress<R: Runtime>(
    app: &AppHandle<R>,
    progress: DownloadProgress,
) -> Result<(), tauri::Error> {
    app.emit(
        "download_progress",
        serde_json::json!({
            "downloadId": progress.download_id.clone(),
            "progress": progress
        }),
    )
}

pub fn emit_complete<R: Runtime>(
    app: &AppHandle<R>,
    download_id: String,
    manifest_id: Option<String>,
) -> Result<(), tauri::Error> {
    app.emit(
        "download_complete",
        serde_json::json!({
            "downloadId": download_id,
            "manifestId": manifest_id
        }),
    )
}

pub fn emit_error<R: Runtime>(
    app: &AppHandle<R>,
    download_id: String,
    error: String,
) -> Result<(), tauri::Error> {
    app.emit(
        "download_error",
        serde_json::json!({ "downloadId": download_id, "error": error }),
    )
}

pub fn emit_auth_waiting<R: Runtime>(
    app: &AppHandle<R>,
    download_id: String,
    message: String,
) -> Result<(), tauri::Error> {
    app.emit(
        "auth_waiting",
        serde_json::json!({ "downloadId": download_id, "message": message }),
    )
}

pub fn emit_auth_success<R: Runtime>(
    app: &AppHandle<R>,
    download_id: String,
) -> Result<(), tauri::Error> {
    app.emit(
        "auth_success",
        serde_json::json!({ "downloadId": download_id }),
    )
}

pub fn emit_auth_error<R: Runtime>(
    app: &AppHandle<R>,
    download_id: String,
    error: String,
) -> Result<(), tauri::Error> {
    app.emit(
        "auth_error",
        serde_json::json!({ "downloadId": download_id, "error": error }),
    )
}

pub fn emit_melonloader_installing<R: Runtime>(
    app: &AppHandle<R>,
    download_id: String,
    message: String,
) -> Result<(), tauri::Error> {
    app.emit(
        "melonloader_installing",
        serde_json::json!({ "downloadId": download_id, "message": message }),
    )
}

pub fn emit_melonloader_installed<R: Runtime>(
    app: &AppHandle<R>,
    download_id: String,
    message: String,
    version: Option<String>,
) -> Result<(), tauri::Error> {
    app.emit(
        "melonloader_installed",
        serde_json::json!({
            "downloadId": download_id,
            "message": message,
            "version": version
        }),
    )
}

pub fn emit_melonloader_error<R: Runtime>(
    app: &AppHandle<R>,
    download_id: String,
    message: String,
) -> Result<(), tauri::Error> {
    app.emit(
        "melonloader_error",
        serde_json::json!({ "downloadId": download_id, "message": message }),
    )
}

pub fn emit_update_available<R: Runtime>(
    app: &AppHandle<R>,
    environment_id: String,
    update_result: UpdateCheckResult,
) -> Result<(), tauri::Error> {
    app.emit(
        "update_available",
        serde_json::json!({
            "environmentId": environment_id,
            "updateResult": update_result
        }),
    )
}

pub fn emit_update_check_complete<R: Runtime>(
    app: &AppHandle<R>,
    environment_id: String,
    update_result: UpdateCheckResult,
) -> Result<(), tauri::Error> {
    app.emit(
        "update_check_complete",
        serde_json::json!({
            "environmentId": environment_id,
            "updateResult": update_result
        }),
    )
}

pub fn emit_mods_changed<R: Runtime>(
    app: &AppHandle<R>,
    environment_id: String,
) -> Result<(), tauri::Error> {
    app.emit(
        "mods_changed",
        serde_json::json!({ "environmentId": environment_id }),
    )
}

pub fn emit_mods_snapshot_updated<R: Runtime>(
    app: &AppHandle<R>,
    environment_id: String,
    snapshot: serde_json::Value,
) -> Result<(), tauri::Error> {
    app.emit(
        "mods_snapshot_updated",
        serde_json::json!({
            "environmentId": environment_id,
            "snapshot": snapshot
        }),
    )
}

pub fn emit_plugins_changed<R: Runtime>(
    app: &AppHandle<R>,
    environment_id: String,
) -> Result<(), tauri::Error> {
    app.emit(
        "plugins_changed",
        serde_json::json!({ "environmentId": environment_id }),
    )
}

pub fn emit_userlibs_changed<R: Runtime>(
    app: &AppHandle<R>,
    environment_id: String,
) -> Result<(), tauri::Error> {
    app.emit(
        "userlibs_changed",
        serde_json::json!({ "environmentId": environment_id }),
    )
}

pub fn emit_mod_updates_checked<R: Runtime>(
    app: &AppHandle<R>,
    environment_id: String,
    count: usize,
    updates: Vec<serde_json::Value>,
) -> Result<(), tauri::Error> {
    app.emit(
        "mod_updates_checked",
        serde_json::json!({
            "environmentId": environment_id,
            "count": count,
            "updates": updates
        }),
    )
}

pub fn emit_mod_metadata_refresh_status<R: Runtime>(
    app: &AppHandle<R>,
    active_count: usize,
) -> Result<(), tauri::Error> {
    app.emit(
        "mod_metadata_refresh_status",
        serde_json::json!({
            "activeCount": active_count,
            "running": active_count > 0
        }),
    )
}

pub fn emit_tracked_download_updated<R: Runtime>(
    app: &AppHandle<R>,
    download: TrackedDownload,
) -> Result<(), tauri::Error> {
    app.emit("tracked_download_updated", download)
}
