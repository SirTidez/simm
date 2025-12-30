use tauri::{AppHandle, Emitter};
use crate::types::DownloadProgress;
use crate::types::UpdateCheckResult;

pub fn emit_progress(app: &AppHandle, progress: DownloadProgress) -> Result<(), tauri::Error> {
    app.emit("download_progress", serde_json::json!({
        "downloadId": progress.download_id.clone(),
        "progress": progress
    }))
}

pub fn emit_complete(app: &AppHandle, download_id: String, manifest_id: Option<String>) -> Result<(), tauri::Error> {
    app.emit("download_complete", serde_json::json!({ 
        "downloadId": download_id,
        "manifestId": manifest_id
    }))
}

pub fn emit_error(app: &AppHandle, download_id: String, error: String) -> Result<(), tauri::Error> {
    app.emit("download_error", serde_json::json!({ "downloadId": download_id, "error": error }))
}

pub fn emit_auth_waiting(app: &AppHandle, download_id: String, message: String) -> Result<(), tauri::Error> {
    app.emit("auth_waiting", serde_json::json!({ "downloadId": download_id, "message": message }))
}

pub fn emit_auth_success(app: &AppHandle, download_id: String) -> Result<(), tauri::Error> {
    app.emit("auth_success", serde_json::json!({ "downloadId": download_id }))
}

pub fn emit_auth_error(app: &AppHandle, download_id: String, error: String) -> Result<(), tauri::Error> {
    app.emit("auth_error", serde_json::json!({ "downloadId": download_id, "error": error }))
}

pub fn emit_melonloader_installing(app: &AppHandle, download_id: String, message: String) -> Result<(), tauri::Error> {
    app.emit("melonloader_installing", serde_json::json!({ "downloadId": download_id, "message": message }))
}

pub fn emit_melonloader_installed(app: &AppHandle, download_id: String, message: String, version: Option<String>) -> Result<(), tauri::Error> {
    app.emit("melonloader_installed", serde_json::json!({ 
        "downloadId": download_id, 
        "message": message,
        "version": version
    }))
}

pub fn emit_melonloader_error(app: &AppHandle, download_id: String, message: String) -> Result<(), tauri::Error> {
    app.emit("melonloader_error", serde_json::json!({ "downloadId": download_id, "message": message }))
}

pub fn emit_update_available(app: &AppHandle, environment_id: String, update_result: UpdateCheckResult) -> Result<(), tauri::Error> {
    app.emit("update_available", serde_json::json!({ 
        "environmentId": environment_id,
        "updateResult": update_result
    }))
}

pub fn emit_update_check_complete(app: &AppHandle, environment_id: String, update_result: UpdateCheckResult) -> Result<(), tauri::Error> {
    app.emit("update_check_complete", serde_json::json!({ 
        "environmentId": environment_id,
        "updateResult": update_result
    }))
}

pub fn emit_mods_changed(app: &AppHandle, environment_id: String) -> Result<(), tauri::Error> {
    app.emit("mods_changed", serde_json::json!({ "environmentId": environment_id }))
}

pub fn emit_plugins_changed(app: &AppHandle, environment_id: String) -> Result<(), tauri::Error> {
    app.emit("plugins_changed", serde_json::json!({ "environmentId": environment_id }))
}

pub fn emit_userlibs_changed(app: &AppHandle, environment_id: String) -> Result<(), tauri::Error> {
    app.emit("userlibs_changed", serde_json::json!({ "environmentId": environment_id }))
}

