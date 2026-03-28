use crate::services::app_update::fetch_app_update_status;
use crate::services::nexus_mods::NexusModsService;
use crate::services::settings::SettingsService;
use sqlx::SqlitePool;
use std::sync::Arc;
use tauri::State;

#[tauri::command]
pub async fn get_app_update_status(
    db: State<'_, Arc<SqlitePool>>,
    current_version: String,
) -> Result<serde_json::Value, String> {
    let mut settings_service =
        SettingsService::new(db.inner().clone()).map_err(|e| e.to_string())?;
    let settings = settings_service
        .load_settings()
        .await
        .map_err(|e| e.to_string())?;

    let nexus_service = NexusModsService::new();
    let persisted_api_key = settings_service
        .get_nexus_mods_api_key()
        .await
        .map_err(|e| e.to_string())?;
    if let Some(api_key) = persisted_api_key.or(settings.nexus_mods_api_key.clone()) {
        nexus_service.set_api_key(api_key).await;
    }

    let status = fetch_app_update_status(&nexus_service, &settings, &current_version)
        .await
        .map_err(|e| e.to_string())?;
    serde_json::to_value(status).map_err(|e| e.to_string())
}
