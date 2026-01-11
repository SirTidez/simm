use crate::services::mod_update::ModUpdateService;
use crate::services::mods::ModsService;
use crate::services::environment::EnvironmentService;
use crate::services::thunderstore::ThunderStoreService;
use crate::services::nexus_mods::NexusModsService;
use std::sync::Arc;
use tokio::sync::Mutex as AsyncMutex;
use once_cell::sync::Lazy;

static MOD_UPDATE_SERVICE: Lazy<AsyncMutex<Option<Arc<ModUpdateService>>>> = Lazy::new(|| AsyncMutex::new(None));
static MODS_SERVICE: Lazy<AsyncMutex<Option<Arc<ModsService>>>> = Lazy::new(|| AsyncMutex::new(None));
static ENV_SERVICE: Lazy<AsyncMutex<Option<Arc<EnvironmentService>>>> = Lazy::new(|| AsyncMutex::new(None));
static THUNDERSTORE_SERVICE: Lazy<AsyncMutex<Option<Arc<ThunderStoreService>>>> = Lazy::new(|| AsyncMutex::new(None));
static NEXUS_MODS_SERVICE: Lazy<AsyncMutex<Option<Arc<NexusModsService>>>> = Lazy::new(|| AsyncMutex::new(None));

async fn get_mod_update_service() -> Result<Arc<ModUpdateService>, String> {
    let mut service = MOD_UPDATE_SERVICE.lock().await;
    if service.is_none() {
        *service = Some(Arc::new(ModUpdateService::new()));
    }
    Ok(service.as_ref().unwrap().clone())
}

async fn get_mods_service() -> Result<Arc<ModsService>, String> {
    let mut service = MODS_SERVICE.lock().await;
    if service.is_none() {
        *service = Some(Arc::new(ModsService::new()));
    }
    Ok(service.as_ref().unwrap().clone())
}

async fn get_env_service() -> Result<Arc<EnvironmentService>, String> {
    let mut service = ENV_SERVICE.lock().await;
    if service.is_none() {
        *service = Some(Arc::new(EnvironmentService::new().map_err(|e| e.to_string())?));
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

async fn get_nexus_mods_service() -> Result<Arc<NexusModsService>, String> {
    use crate::services::settings::SettingsService;
    
    static SETTINGS_SERVICE: Lazy<AsyncMutex<Option<Arc<AsyncMutex<SettingsService>>>>> = Lazy::new(|| AsyncMutex::new(None));
    
    async fn get_settings_service() -> Result<Arc<AsyncMutex<SettingsService>>, String> {
        let mut service = SETTINGS_SERVICE.lock().await;
        if service.is_none() {
            *service = Some(Arc::new(AsyncMutex::new(SettingsService::new().map_err(|e| e.to_string())?)));
        }
        Ok(service.as_ref().unwrap().clone())
    }
    
    let mut service = NEXUS_MODS_SERVICE.lock().await;
    if service.is_none() {
        let nexus_service = Arc::new(NexusModsService::new());
        
        // Try to load API key from encrypted storage
        let settings_service = get_settings_service().await?;
        let settings = settings_service.lock().await;
        if let Ok(Some(api_key)) = settings.get_nexus_mods_api_key().await {
            nexus_service.set_api_key(api_key).await;
        }
        
        *service = Some(nexus_service);
    }
    Ok(service.as_ref().unwrap().clone())
}

#[tauri::command]
pub async fn check_mod_updates(environment_id: String) -> Result<Vec<serde_json::Value>, String> {
    let mod_update_service = get_mod_update_service().await?;
    let mods_service = get_mods_service().await?;
    let env_service = get_env_service().await?;
    let thunderstore_service = get_thunderstore_service().await?;
    let nexus_mods_service = get_nexus_mods_service().await?;
    
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

