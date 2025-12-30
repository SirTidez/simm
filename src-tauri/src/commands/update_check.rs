use crate::services::update_check::UpdateCheckService;
use crate::services::environment::EnvironmentService;
use std::sync::Arc;
use tokio::sync::Mutex as AsyncMutex;
use once_cell::sync::Lazy;

static UPDATE_CHECK_SERVICE: Lazy<AsyncMutex<Option<Arc<UpdateCheckService>>>> = Lazy::new(|| AsyncMutex::new(None));
static ENV_SERVICE: Lazy<AsyncMutex<Option<Arc<EnvironmentService>>>> = Lazy::new(|| AsyncMutex::new(None));

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

#[tauri::command]
pub async fn check_update(environment_id: String) -> Result<serde_json::Value, String> {
    let env_service = get_env_service().await?;
    let env = env_service.get_environment(&environment_id)
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "Environment not found".to_string())?;

    let update_service = get_update_check_service().await?;
    let result = update_service.check_update_for_environment(&env)
        .await
        .map_err(|e| e.to_string())?;

    serde_json::to_value(result).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn check_all_updates() -> Result<Vec<serde_json::Value>, String> {
    let env_service = get_env_service().await?;
    let envs = env_service.get_environments()
        .await
        .map_err(|e| e.to_string())?;

    let update_service = get_update_check_service().await?;
    let results = update_service.check_all_environments(&envs)
        .await
        .map_err(|e| e.to_string())?;

    // Update environments with the results
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
    }

    let mut response = Vec::new();
    for (env_id, result) in results {
        response.push(serde_json::json!({
            "environmentId": env_id,
            "updateResult": result
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

