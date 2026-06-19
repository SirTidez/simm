use std::path::PathBuf;
use std::sync::Arc;

use sqlx::SqlitePool;
use tauri::{AppHandle, Runtime, State};

use crate::events;
use crate::services::mod_profiles::ModProfilesService;
use crate::types::{
    ModProfileApplyRequest, ModProfileApplyResult, ModProfileCaptureRequest,
    ModProfileExportRequest, ModProfileImportPlan, ModProfileManifest, ModProfileSaveRequest,
    StoredModProfile,
};

fn emit_profile_apply_events<R: Runtime>(app: &AppHandle<R>, environment_id: String) {
    if let Err(error) = events::emit_mods_changed(app, environment_id.clone()) {
        log::warn!("Failed to emit mods_changed after profile apply: {}", error);
    }
    if let Err(error) = events::emit_plugins_changed(app, environment_id.clone()) {
        log::warn!(
            "Failed to emit plugins_changed after profile apply: {}",
            error
        );
    }
    if let Err(error) = events::emit_userlibs_changed(app, environment_id) {
        log::warn!(
            "Failed to emit userlibs_changed after profile apply: {}",
            error
        );
    }
}

#[tauri::command]
pub async fn list_mod_profiles(
    db: State<'_, Arc<SqlitePool>>,
) -> Result<Vec<StoredModProfile>, String> {
    ModProfilesService::new(db.inner().clone())
        .list_profiles()
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn get_mod_profile(
    db: State<'_, Arc<SqlitePool>>,
    profile_id: String,
) -> Result<StoredModProfile, String> {
    ModProfilesService::new(db.inner().clone())
        .get_profile(&profile_id)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn save_mod_profile(
    db: State<'_, Arc<SqlitePool>>,
    request: ModProfileSaveRequest,
) -> Result<StoredModProfile, String> {
    ModProfilesService::new(db.inner().clone())
        .save_profile(request)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn capture_mod_profile(
    db: State<'_, Arc<SqlitePool>>,
    request: ModProfileCaptureRequest,
) -> Result<StoredModProfile, String> {
    ModProfilesService::new(db.inner().clone())
        .capture_profile(request)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn import_mod_profile_to_library(
    db: State<'_, Arc<SqlitePool>>,
    manifest: ModProfileManifest,
) -> Result<StoredModProfile, String> {
    ModProfilesService::new(db.inner().clone())
        .import_profile_manifest(manifest)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn export_mod_profile_from_library(
    db: State<'_, Arc<SqlitePool>>,
    request: ModProfileExportRequest,
) -> Result<ModProfileManifest, String> {
    ModProfilesService::new(db.inner().clone())
        .export_profile_manifest(request)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn delete_mod_profile(
    db: State<'_, Arc<SqlitePool>>,
    profile_id: String,
) -> Result<(), String> {
    ModProfilesService::new(db.inner().clone())
        .delete_profile(&profile_id)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn preview_mod_profile_apply(
    db: State<'_, Arc<SqlitePool>>,
    profile_id: String,
    target_environment_id: String,
) -> Result<ModProfileImportPlan, String> {
    ModProfilesService::new(db.inner().clone())
        .preview_profile_apply(&profile_id, target_environment_id)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn apply_mod_profile<R: Runtime>(
    app: AppHandle<R>,
    db: State<'_, Arc<SqlitePool>>,
    profile_id: String,
    target_environment_id: String,
) -> Result<ModProfileApplyResult, String> {
    let result = ModProfilesService::new(db.inner().clone())
        .apply_profile(&profile_id, target_environment_id.clone())
        .await
        .map_err(|error| error.to_string())?;

    emit_profile_apply_events(&app, target_environment_id);
    Ok(result)
}

#[tauri::command]
pub async fn export_environment_profile(
    db: State<'_, Arc<SqlitePool>>,
    environment_id: String,
) -> Result<ModProfileManifest, String> {
    ModProfilesService::new(db.inner().clone())
        .export_environment_profile(&environment_id)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn save_mod_profile_file(
    db: State<'_, Arc<SqlitePool>>,
    manifest: ModProfileManifest,
    destination: String,
) -> Result<(), String> {
    ModProfilesService::new(db.inner().clone())
        .save_manifest_to_file(manifest, PathBuf::from(destination))
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn read_mod_profile_file(
    db: State<'_, Arc<SqlitePool>>,
    source: String,
) -> Result<ModProfileManifest, String> {
    ModProfilesService::new(db.inner().clone())
        .read_manifest_from_file(PathBuf::from(source))
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn preview_mod_profile_import(
    db: State<'_, Arc<SqlitePool>>,
    manifest: ModProfileManifest,
    target_environment_id: Option<String>,
) -> Result<ModProfileImportPlan, String> {
    ModProfilesService::new(db.inner().clone())
        .preview_import(manifest, target_environment_id)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn apply_mod_profile_import<R: Runtime>(
    app: AppHandle<R>,
    db: State<'_, Arc<SqlitePool>>,
    request: ModProfileApplyRequest,
) -> Result<ModProfileApplyResult, String> {
    let target_environment_id = request.target_environment_id.clone();
    let result = ModProfilesService::new(db.inner().clone())
        .apply_import(request)
        .await
        .map_err(|error| error.to_string())?;

    emit_profile_apply_events(&app, target_environment_id);

    Ok(result)
}
