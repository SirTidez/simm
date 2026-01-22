use crate::services::environment::EnvironmentService;
use crate::services::filesystem_watcher::FileSystemWatcherService;
use crate::types::{Environment, AppConfig, schedule_i_config};
use crate::utils::validation::{validate_app_id, validate_branch_name, validate_environment_name, validate_directory_path};
use std::sync::Arc;
use tokio::sync::Mutex as AsyncMutex;
use once_cell::sync::Lazy;
use tauri::State;

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
    watcher: State<'_, Arc<AsyncMutex<FileSystemWatcherService>>>,
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
    let env = service.create_environment(
        app_id,
        branch,
        validated_dir.clone(),
        name,
        description,
    )
    .await
    .map_err(|e| e.to_string())?;

    // Start watching mods/plugins/userlibs directories
    let watcher_guard = watcher.lock().await;
    let mods_dir = std::path::Path::new(&validated_dir).join("Mods");
    let plugins_dir = std::path::Path::new(&validated_dir).join("Plugins");
    let userlibs_dir = std::path::Path::new(&validated_dir).join("UserLibs");
    
    let _ = watcher_guard.start_watching(&env.id, mods_dir.to_str().unwrap_or(""), "mods").await;
    let _ = watcher_guard.start_watching(&env.id, plugins_dir.to_str().unwrap_or(""), "plugins").await;
    let _ = watcher_guard.start_watching(&env.id, userlibs_dir.to_str().unwrap_or(""), "userlibs").await;

    Ok(env)
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
pub async fn delete_environment(
    watcher: State<'_, Arc<AsyncMutex<FileSystemWatcherService>>>,
    id: String,
    delete_files: Option<bool>,
) -> Result<bool, String> {
    // Stop watching directories before deleting
    let watcher_guard = watcher.lock().await;
    let _ = watcher_guard.stop_watching_environment(&id).await;
    drop(watcher_guard);

    let service = get_env_service().await?;
    service.delete_environment(&id, delete_files.unwrap_or(false))
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
    watcher: State<'_, Arc<AsyncMutex<FileSystemWatcherService>>>,
    steam_path: String,
    name: Option<String>,
    description: Option<String>,
) -> Result<Environment, String> {
    let service = get_env_service().await?;
    let env = service.create_steam_environment(steam_path.clone(), name, description)
        .await
        .map_err(|e| e.to_string())?;

    // Start watching mods/plugins/userlibs directories
    let watcher_guard = watcher.lock().await;
    let mods_dir = std::path::Path::new(&steam_path).join("Mods");
    let plugins_dir = std::path::Path::new(&steam_path).join("Plugins");
    let userlibs_dir = std::path::Path::new(&steam_path).join("UserLibs");

    let _ = watcher_guard.start_watching(&env.id, mods_dir.to_str().unwrap_or(""), "mods").await;
    let _ = watcher_guard.start_watching(&env.id, plugins_dir.to_str().unwrap_or(""), "plugins").await;
    let _ = watcher_guard.start_watching(&env.id, userlibs_dir.to_str().unwrap_or(""), "userlibs").await;

    Ok(env)
}

#[tauri::command]
pub async fn import_local_environment(
    watcher: State<'_, Arc<AsyncMutex<FileSystemWatcherService>>>,
    local_path: String,
    name: Option<String>,
    description: Option<String>,
) -> Result<Environment, String> {
    let service = get_env_service().await?;
    let env = service.create_local_environment(local_path.clone(), name, description)
        .await
        .map_err(|e| e.to_string())?;

    // Start watching mods/plugins/userlibs directories
    let watcher_guard = watcher.lock().await;
    let mods_dir = std::path::Path::new(&local_path).join("Mods");
    let plugins_dir = std::path::Path::new(&local_path).join("Plugins");
    let userlibs_dir = std::path::Path::new(&local_path).join("UserLibs");

    let _ = watcher_guard.start_watching(&env.id, mods_dir.to_str().unwrap_or(""), "mods").await;
    let _ = watcher_guard.start_watching(&env.id, plugins_dir.to_str().unwrap_or(""), "plugins").await;
    let _ = watcher_guard.start_watching(&env.id, userlibs_dir.to_str().unwrap_or(""), "userlibs").await;

    Ok(env)
}
