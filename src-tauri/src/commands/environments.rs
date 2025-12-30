use crate::services::environment::EnvironmentService;
use crate::types::{Environment, AppConfig, schedule_i_config};
use crate::utils::validation::{validate_app_id, validate_branch_name, validate_environment_name, validate_directory_path};
use std::sync::Arc;
use tokio::sync::Mutex as AsyncMutex;
use once_cell::sync::Lazy;

static ENV_SERVICE: Lazy<AsyncMutex<Option<Arc<EnvironmentService>>>> = Lazy::new(|| AsyncMutex::new(None));

async fn get_env_service() -> Result<Arc<EnvironmentService>, String> {
    let mut service = ENV_SERVICE.lock().await;
    if service.is_none() {
        *service = Some(Arc::new(EnvironmentService::new().map_err(|e| e.to_string())?));
    }
    Ok(service.as_ref().unwrap().clone())
}

#[tauri::command]
pub async fn get_environments() -> Result<Vec<Environment>, String> {
    let service = get_env_service().await?;
    let mut envs = service.get_environments()
        .await
        .map_err(|e| e.to_string())?;
    
    // Auto-detect and create Steam environments if they don't exist
    let steam_service = crate::services::steam::SteamService::new();
    if let Ok(steam_installations) = steam_service.detect_steam_installations().await {
        for installation in steam_installations {
            // Check if we already have a Steam environment for this path
            let existing = envs.iter().any(|env| {
                env.environment_type == Some(crate::types::EnvironmentType::Steam) &&
                env.output_dir == installation.path
            });
            
            if !existing {
                // Create Steam environment automatically
                if let Ok(steam_env) = service.create_steam_environment(
                    installation.path,
                    None,
                    None,
                ).await {
                    envs.push(steam_env);
                }
            }
        }
    }
    
    // Sort environments: Steam environments first, then DepotDownloader
    envs.sort_by(|a, b| {
        let a_is_steam = a.environment_type == Some(crate::types::EnvironmentType::Steam);
        let b_is_steam = b.environment_type == Some(crate::types::EnvironmentType::Steam);
        match (a_is_steam, b_is_steam) {
            (true, false) => std::cmp::Ordering::Less,  // Steam comes first
            (false, true) => std::cmp::Ordering::Greater, // Steam comes first
            _ => std::cmp::Ordering::Equal, // Maintain original order for same type
        }
    });
    
    Ok(envs)
}

#[tauri::command]
pub async fn get_environment(id: String) -> Result<Option<Environment>, String> {
    let service = get_env_service().await?;
    service.get_environment(&id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn create_environment(
    app_id: String,
    branch: String,
    output_dir: String,
    name: Option<String>,
    description: Option<String>,
) -> Result<Environment, String> {
    // Validate inputs
    if !validate_app_id(&app_id) {
        return Err("Invalid AppID format".to_string());
    }

    if !validate_branch_name(&branch) {
        return Err("Invalid branch name".to_string());
    }

    if let Some(ref n) = name {
        if !validate_environment_name(n) {
            return Err("Invalid environment name".to_string());
        }
    }

    let validated_dir = validate_directory_path(&output_dir, None)
        .map_err(|e| e.to_string())?;

    let service = get_env_service().await?;
    service.create_environment(
        app_id,
        branch,
        validated_dir,
        name,
        description,
    )
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn update_environment(
    id: String,
    updates: serde_json::Value,
) -> Result<Environment, String> {
    let service = get_env_service().await?;
    
    let updates_map: std::collections::HashMap<String, serde_json::Value> = 
        if let Some(map) = updates.as_object() {
            map.iter()
                .map(|(k, v)| (k.clone(), v.clone()))
                .collect()
        } else {
            return Err("Updates must be an object".to_string());
        };

    service.update_environment(&id, updates_map)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn delete_environment(id: String) -> Result<bool, String> {
    let service = get_env_service().await?;
    service.delete_environment(&id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_schedule1_config() -> Result<AppConfig, String> {
    Ok(schedule_i_config())
}

#[tauri::command]
pub async fn detect_steam_installations() -> Result<serde_json::Value, String> {
    use crate::services::steam::SteamService;
    
    let service = SteamService::new();
    let installations = service.detect_steam_installations()
        .await
        .map_err(|e| e.to_string())?;
    
    Ok(serde_json::json!(installations))
}

#[tauri::command]
pub async fn create_steam_environment(
    steam_path: String,
    name: Option<String>,
    description: Option<String>,
) -> Result<Environment, String> {
    let service = get_env_service().await?;
    service.create_steam_environment(steam_path, name, description)
        .await
        .map_err(|e| e.to_string())
}
