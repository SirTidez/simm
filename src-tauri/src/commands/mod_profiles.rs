use std::path::PathBuf;
use std::sync::Arc;

use sqlx::SqlitePool;
use tauri::{AppHandle, Runtime, State};

use crate::events;
use crate::services::mod_profiles::ModProfilesService;
use crate::types::{
    ModProfileApplyRequest, ModProfileApplyResult, ModProfileImportPlan, ModProfileManifest,
};

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

    if result.installed > 0 {
        if let Err(error) = events::emit_mods_changed(&app, target_environment_id.clone()) {
            log::warn!(
                "Failed to emit mods_changed after profile import: {}",
                error
            );
        }
        if let Err(error) = events::emit_plugins_changed(&app, target_environment_id.clone()) {
            log::warn!(
                "Failed to emit plugins_changed after profile import: {}",
                error
            );
        }
        if let Err(error) = events::emit_userlibs_changed(&app, target_environment_id) {
            log::warn!(
                "Failed to emit userlibs_changed after profile import: {}",
                error
            );
        }
    }

    Ok(result)
}
