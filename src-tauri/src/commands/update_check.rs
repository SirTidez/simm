use crate::services::update_check::UpdateCheckService;
use crate::services::environment::EnvironmentService;
use crate::services::mod_update::ModUpdateService;
use crate::services::mods::ModsService;
use crate::services::thunderstore::ThunderStoreService;
use crate::services::nexus_mods::NexusModsService;
use crate::services::settings::SettingsService;
use crate::events;
use tauri::AppHandle;
use std::sync::Arc;
use tokio::sync::Mutex as AsyncMutex;
use once_cell::sync::Lazy;

static UPDATE_CHECK_SERVICE: Lazy<AsyncMutex<Option<Arc<UpdateCheckService>>>> = Lazy::new(|| AsyncMutex::new(None));
static ENV_SERVICE: Lazy<AsyncMutex<Option<Arc<EnvironmentService>>>> = Lazy::new(|| AsyncMutex::new(None));
static MOD_UPDATE_SERVICE: Lazy<AsyncMutex<Option<Arc<ModUpdateService>>>> = Lazy::new(|| AsyncMutex::new(None));
static MODS_SERVICE: Lazy<AsyncMutex<Option<Arc<ModsService>>>> = Lazy::new(|| AsyncMutex::new(None));
static THUNDERSTORE_SERVICE: Lazy<AsyncMutex<Option<Arc<ThunderStoreService>>>> = Lazy::new(|| AsyncMutex::new(None));
static NEXUS_MODS_SERVICE: Lazy<AsyncMutex<Option<Arc<NexusModsService>>>> = Lazy::new(|| AsyncMutex::new(None));

async fn get_update_check_service() -> Result<Arc<UpdateCheckService>, String> {
    let mut service = UPDATE_CHECK_SERVICE.lock().await;
    if service.is_none() {
        *service = Some(Arc::new(UpdateCheckService::new()));
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

async fn get_thunderstore_service() -> Result<Arc<ThunderStoreService>, String> {
    let mut service = THUNDERSTORE_SERVICE.lock().await;
    if service.is_none() {
        *service = Some(Arc::new(ThunderStoreService::new()));
    }
    Ok(service.as_ref().unwrap().clone())
}

async fn get_nexus_mods_service() -> Result<Arc<NexusModsService>, String> {
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
pub async fn check_update(
    app: AppHandle,
    environment_id: String
) -> Result<serde_json::Value, String> {
    let env_service = get_env_service().await?;
    let env = env_service.get_environment(&environment_id)
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "Environment not found".to_string())?;

    let update_service = get_update_check_service().await?;
    let result = update_service.check_update_for_environment(&env)
        .await
        .map_err(|e| e.to_string())?;

    // Emit update check complete event
    let _ = events::emit_update_check_complete(&app, environment_id.clone(), result.clone());
    
    // Emit update available event if an update is available
    if result.update_available {
        let _ = events::emit_update_available(&app, environment_id, result.clone());
    }

    serde_json::to_value(result).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn check_all_updates(
    app: AppHandle
) -> Result<Vec<serde_json::Value>, String> {
    let env_service = get_env_service().await?;
    let envs = env_service.get_environments()
        .await
        .map_err(|e| e.to_string())?;

    let update_service = get_update_check_service().await?;
    let results = update_service.check_all_environments(&envs)
        .await
        .map_err(|e| e.to_string())?;

    // Also check mod updates for completed environments (in parallel)
    let mod_update_service = get_mod_update_service().await?;
    let mods_service = get_mods_service().await?;
    let thunderstore_service = get_thunderstore_service().await?;
    let nexus_mods_service = get_nexus_mods_service().await?;
    
    // Filter to only completed environments and check mod updates in parallel
    let completed_envs: Vec<_> = envs.iter()
        .filter(|env| matches!(env.status, crate::types::EnvironmentStatus::Completed))
        .collect();
    
    // Check mod updates for all completed environments in parallel
    let mod_update_tasks: Vec<_> = completed_envs.iter().map(|env| {
        let env_id = env.id.clone();
        let mod_update_service = mod_update_service.clone();
        let mods_service = mods_service.clone();
        let env_service = env_service.clone();
        let thunderstore_service = thunderstore_service.clone();
        let nexus_mods_service = nexus_mods_service.clone();
        
        tokio::spawn(async move {
            match mod_update_service.check_mod_updates(&env_id, &env_service, &mods_service, &thunderstore_service, &nexus_mods_service).await {
                Ok(_) => {
                    eprintln!("[UpdateCheck] Successfully checked mod updates for environment {}", env_id);
                }
                Err(e) => {
                    // Log but don't fail - mod updates are nice to have but not critical
                    eprintln!("[UpdateCheck] Failed to check mod updates for environment {}: {}", env_id, e);
                }
            }
        })
    }).collect();
    
    // Wait for all mod update checks to complete (but don't fail if they error)
    for task in mod_update_tasks {
        let _ = task.await;
    }

    // Update environments with the results and emit events
    for (env_id, result) in &results {
        let mut updates = Vec::new();
        updates.push(("lastUpdateCheck".to_string(), serde_json::json!(result.checked_at.timestamp())));
        updates.push(("updateAvailable".to_string(), serde_json::json!(result.update_available)));
        
        if let Some(ref remote_manifest_id) = result.remote_manifest_id {
            updates.push(("remoteManifestId".to_string(), serde_json::json!(remote_manifest_id)));
        }
        
        if let Some(ref remote_build_id) = result.remote_build_id {
            updates.push(("remoteBuildId".to_string(), serde_json::json!(remote_build_id)));
        }
        
        if let Some(ref current_game_version) = result.current_game_version {
            updates.push(("currentGameVersion".to_string(), serde_json::json!(current_game_version)));
        }
        
        if let Some(ref update_game_version) = result.update_game_version {
            updates.push(("updateGameVersion".to_string(), serde_json::json!(update_game_version)));
        }

        // Update the environment
        if let Err(e) = env_service.update_environment(env_id, updates).await {
            eprintln!("[UpdateCheck] Failed to update environment {}: {}", env_id, e);
        }
        
        // Emit update check complete event
        let _ = events::emit_update_check_complete(&app, env_id.clone(), result.clone());
        
        // Emit update available event if an update is available
        if result.update_available {
            let _ = events::emit_update_available(&app, env_id.clone(), result.clone());
        }
    }

    let mut response = Vec::new();
    for (env_id, result) in results {
        // Flatten the result to match frontend expectations: { environmentId, ...UpdateCheckResult }
        response.push(serde_json::json!({
            "environmentId": env_id,
            "updateAvailable": result.update_available,
            "currentManifestId": result.current_manifest_id,
            "remoteManifestId": result.remote_manifest_id,
            "remoteBuildId": result.remote_build_id,
            "branch": result.branch,
            "appId": result.app_id,
            "checkedAt": result.checked_at.timestamp(),
            "error": result.error,
            "currentGameVersion": result.current_game_version,
            "updateGameVersion": result.update_game_version,
        }));
    }

    Ok(response)
}

#[tauri::command]
pub async fn get_update_status(environment_id: String) -> Result<serde_json::Value, String> {
    let env_service = get_env_service().await?;
    let env = env_service.get_environment(&environment_id)
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "Environment not found".to_string())?;

    Ok(serde_json::json!({
        "updateAvailable": env.update_available.unwrap_or(false),
        "lastUpdateCheck": env.last_update_check,
        "remoteManifestId": env.remote_manifest_id,
        "remoteBuildId": env.remote_build_id,
        "currentManifestId": env.last_manifest_id
    }))
}

