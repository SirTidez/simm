use std::path::PathBuf;
use std::sync::Arc;

use sqlx::SqlitePool;
use tauri::{AppHandle, Runtime, State};

use crate::events;
use crate::services::mod_profiles::ModProfilesService;
use crate::services::settings::RuntimeSettingsState;
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

async fn managed_mod_profiles_service(
    db: Arc<SqlitePool>,
    runtime_settings: &RuntimeSettingsState,
) -> ModProfilesService {
    ModProfilesService::new(db).with_runtime_settings(runtime_settings.snapshot().await)
}

#[tauri::command]
pub async fn list_mod_profiles(
    db: State<'_, Arc<SqlitePool>>,
    runtime_settings: State<'_, RuntimeSettingsState>,
) -> Result<Vec<StoredModProfile>, String> {
    managed_mod_profiles_service(db.inner().clone(), runtime_settings.inner())
        .await
        .list_profiles()
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn get_mod_profile(
    db: State<'_, Arc<SqlitePool>>,
    runtime_settings: State<'_, RuntimeSettingsState>,
    profile_id: String,
) -> Result<StoredModProfile, String> {
    managed_mod_profiles_service(db.inner().clone(), runtime_settings.inner())
        .await
        .get_profile(&profile_id)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn save_mod_profile(
    db: State<'_, Arc<SqlitePool>>,
    runtime_settings: State<'_, RuntimeSettingsState>,
    request: ModProfileSaveRequest,
) -> Result<StoredModProfile, String> {
    managed_mod_profiles_service(db.inner().clone(), runtime_settings.inner())
        .await
        .save_profile(request)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn capture_mod_profile(
    db: State<'_, Arc<SqlitePool>>,
    runtime_settings: State<'_, RuntimeSettingsState>,
    request: ModProfileCaptureRequest,
) -> Result<StoredModProfile, String> {
    managed_mod_profiles_service(db.inner().clone(), runtime_settings.inner())
        .await
        .capture_profile(request)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn import_mod_profile_to_library(
    db: State<'_, Arc<SqlitePool>>,
    runtime_settings: State<'_, RuntimeSettingsState>,
    manifest: ModProfileManifest,
) -> Result<StoredModProfile, String> {
    managed_mod_profiles_service(db.inner().clone(), runtime_settings.inner())
        .await
        .import_profile_manifest(manifest)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn export_mod_profile_from_library(
    db: State<'_, Arc<SqlitePool>>,
    runtime_settings: State<'_, RuntimeSettingsState>,
    request: ModProfileExportRequest,
) -> Result<ModProfileManifest, String> {
    managed_mod_profiles_service(db.inner().clone(), runtime_settings.inner())
        .await
        .export_profile_manifest(request)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn delete_mod_profile(
    db: State<'_, Arc<SqlitePool>>,
    runtime_settings: State<'_, RuntimeSettingsState>,
    profile_id: String,
) -> Result<(), String> {
    managed_mod_profiles_service(db.inner().clone(), runtime_settings.inner())
        .await
        .delete_profile(&profile_id)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn preview_mod_profile_apply(
    db: State<'_, Arc<SqlitePool>>,
    runtime_settings: State<'_, RuntimeSettingsState>,
    profile_id: String,
    target_environment_id: String,
) -> Result<ModProfileImportPlan, String> {
    managed_mod_profiles_service(db.inner().clone(), runtime_settings.inner())
        .await
        .preview_profile_apply(&profile_id, target_environment_id)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn apply_mod_profile<R: Runtime>(
    app: AppHandle<R>,
    db: State<'_, Arc<SqlitePool>>,
    runtime_settings: State<'_, RuntimeSettingsState>,
    profile_id: String,
    target_environment_id: String,
) -> Result<ModProfileApplyResult, String> {
    let result = managed_mod_profiles_service(db.inner().clone(), runtime_settings.inner())
        .await
        .apply_profile(&profile_id, target_environment_id.clone())
        .await
        .map_err(|error| error.to_string())?;

    emit_profile_apply_events(&app, target_environment_id);
    Ok(result)
}

#[tauri::command]
pub async fn export_environment_profile(
    db: State<'_, Arc<SqlitePool>>,
    runtime_settings: State<'_, RuntimeSettingsState>,
    environment_id: String,
) -> Result<ModProfileManifest, String> {
    managed_mod_profiles_service(db.inner().clone(), runtime_settings.inner())
        .await
        .export_environment_profile(&environment_id)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn save_mod_profile_file(
    db: State<'_, Arc<SqlitePool>>,
    runtime_settings: State<'_, RuntimeSettingsState>,
    manifest: ModProfileManifest,
    destination: String,
) -> Result<(), String> {
    managed_mod_profiles_service(db.inner().clone(), runtime_settings.inner())
        .await
        .save_manifest_to_file(manifest, PathBuf::from(destination))
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn read_mod_profile_file(
    db: State<'_, Arc<SqlitePool>>,
    runtime_settings: State<'_, RuntimeSettingsState>,
    source: String,
) -> Result<ModProfileManifest, String> {
    managed_mod_profiles_service(db.inner().clone(), runtime_settings.inner())
        .await
        .read_manifest_from_file(PathBuf::from(source))
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn preview_mod_profile_import(
    db: State<'_, Arc<SqlitePool>>,
    runtime_settings: State<'_, RuntimeSettingsState>,
    manifest: ModProfileManifest,
    target_environment_id: Option<String>,
) -> Result<ModProfileImportPlan, String> {
    managed_mod_profiles_service(db.inner().clone(), runtime_settings.inner())
        .await
        .preview_import(manifest, target_environment_id)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn apply_mod_profile_import<R: Runtime>(
    app: AppHandle<R>,
    db: State<'_, Arc<SqlitePool>>,
    runtime_settings: State<'_, RuntimeSettingsState>,
    request: ModProfileApplyRequest,
) -> Result<ModProfileApplyResult, String> {
    let target_environment_id = request.target_environment_id.clone();
    let result = managed_mod_profiles_service(db.inner().clone(), runtime_settings.inner())
        .await
        .apply_import(request)
        .await
        .map_err(|error| error.to_string())?;

    emit_profile_apply_events(&app, target_environment_id);

    Ok(result)
}
