use crate::services::mod_update::ModUpdateService;
use crate::services::mods::ModsService;
use crate::services::environment::EnvironmentService;
use crate::services::thunderstore::ThunderStoreService;
use crate::services::nexus_mods::NexusModsService;
use crate::services::settings::SettingsService;
use sqlx::SqlitePool;
use std::sync::Arc;
use tauri::State;
use tokio::sync::Mutex as AsyncMutex;
use once_cell::sync::Lazy;

static MOD_UPDATE_SERVICE: Lazy<AsyncMutex<Option<Arc<ModUpdateService>>>> = Lazy::new(|| AsyncMutex::new(None));
static THUNDERSTORE_SERVICE: Lazy<AsyncMutex<Option<Arc<ThunderStoreService>>>> = Lazy::new(|| AsyncMutex::new(None));
static NEXUS_MODS_SERVICE: Lazy<AsyncMutex<Option<Arc<NexusModsService>>>> = Lazy::new(|| AsyncMutex::new(None));

async fn get_mod_update_service() -> Result<Arc<ModUpdateService>, String> {
    let mut service = MOD_UPDATE_SERVICE.lock().await;
    if service.is_none() {
        *service = Some(Arc::new(ModUpdateService::new()));
    }
    Ok(service.as_ref().unwrap().clone())
}

async fn get_thunderstore_service() -> Result<Arc<ThunderStoreService>, String> {
    let mut service = THUNDERSTORE_SERVICE.lock().await;
    if service.is_none() {
        *service = Some(Arc::new(ThunderStoreService::new()));
    }
    Ok(service.as_ref().unwrap().clone())
}

async fn get_nexus_mods_service(db: Arc<SqlitePool>) -> Result<Arc<NexusModsService>, String> {
    let nexus_service = {
        let mut service = NEXUS_MODS_SERVICE.lock().await;
        if service.is_none() {
            *service = Some(Arc::new(NexusModsService::new()));
        }
        service.as_ref().unwrap().clone()
    };
    let settings_service = SettingsService::new(db).map_err(|e| e.to_string())?;
    match settings_service.get_nexus_mods_api_key().await {
        Ok(Some(api_key)) => {
            nexus_service.set_api_key(api_key).await;
        }
        Ok(None) => {}
        Err(e) => {
            log::warn!("Failed to get Nexus Mods API key: {:?}", e);
        }
    }
    Ok(nexus_service)
}

#[tauri::command]
pub async fn check_mod_updates(
    db: State<'_, Arc<SqlitePool>>,
    environment_id: String,
) -> Result<Vec<serde_json::Value>, String> {
    let mod_update_service = get_mod_update_service().await?;
    let mods_service = ModsService::new(db.inner().clone());
    let env_service = EnvironmentService::new(db.inner().clone()).map_err(|e| e.to_string())?;
    let thunderstore_service = get_thunderstore_service().await?;
    let nexus_mods_service = get_nexus_mods_service(db.inner().clone()).await?;

    mod_update_service.check_mod_updates(&environment_id, &env_service, &mods_service, &thunderstore_service, &nexus_mods_service)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn update_mod(environment_id: String, mod_file_name: String) -> Result<serde_json::Value, String> {
    let mod_update_service = get_mod_update_service().await?;
    mod_update_service.update_mod(&environment_id, &mod_file_name)
        .await
        .map_err(|e| e.to_string())
}
