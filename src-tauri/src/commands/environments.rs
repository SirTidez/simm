use crate::services::environment::EnvironmentService;
use crate::services::filesystem_watcher::FileSystemWatcherService;
use crate::types::{Environment, AppConfig, schedule_i_config};
use crate::utils::validation::{validate_app_id, validate_branch_name, validate_environment_name, validate_directory_path};
use sqlx::SqlitePool;
use std::sync::Arc;
use tokio::sync::Mutex as AsyncMutex;
use tauri::State;

/// Start filesystem watchers for an environment's Mods/Plugins/UserLibs (reused by get_environments and create_*).
async fn start_watchers_for_env(
    watcher_guard: &FileSystemWatcherService,
    env_id: &str,
    output_dir: &str,
) {
    let mods_dir = std::path::Path::new(output_dir).join("Mods");
    let plugins_dir = std::path::Path::new(output_dir).join("Plugins");
    let userlibs_dir = std::path::Path::new(output_dir).join("UserLibs");
    let _ = watcher_guard.start_watching(env_id, mods_dir.to_str().unwrap_or(""), "mods").await;
    let _ = watcher_guard.start_watching(env_id, plugins_dir.to_str().unwrap_or(""), "plugins").await;
    let _ = watcher_guard.start_watching(env_id, userlibs_dir.to_str().unwrap_or(""), "userlibs").await;
}

#[tauri::command]
pub async fn get_environments(
    db: State<'_, Arc<SqlitePool>>,
    watcher: State<'_, Arc<AsyncMutex<FileSystemWatcherService>>>,
) -> Result<Vec<Environment>, String> {
    let service = EnvironmentService::new(db.inner().clone()).map_err(|e| e.to_string())?;
    let mut envs = service.get_environments()
        .await
        .map_err(|e| e.to_string())?;

    let normalize_path = |path: &str| {
        path.replace('/', "\\")
            .trim_end_matches(['\\', '/'])
            .to_ascii_lowercase()
    };

    let has_steam_env = envs.iter().any(|env| {
        env.environment_type == Some(crate::types::EnvironmentType::Steam)
            || env.id.starts_with("steam-")
    });

    // Auto-detect and create Steam environment only if none exists
    if !has_steam_env {
        let steam_service = crate::services::steam::SteamService::new();
        if let Ok(steam_installations) = steam_service.detect_steam_installations().await {
            if let Some(installation) = steam_installations.first() {
                let steam_env = service
                    .create_steam_environment(installation.path.clone(), None, None)
                    .await;
                if let Ok(env) = steam_env {
                    let watcher_guard = watcher.lock().await;
                    start_watchers_for_env(&watcher_guard, &env.id, &env.output_dir).await;
                    envs.push(env);
                }
            }
        }
    }

    // De-duplicate Steam environments by normalized path
    let mut seen_steam_paths = std::collections::HashSet::new();
    envs.retain(|env| {
        if env.environment_type == Some(crate::types::EnvironmentType::Steam)
            || env.id.starts_with("steam-")
        {
            let key = normalize_path(&env.output_dir);
            if seen_steam_paths.contains(&key) {
                return false;
            }
            seen_steam_paths.insert(key);
        }
        true
    });

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
pub async fn get_environment(db: State<'_, Arc<SqlitePool>>, id: String) -> Result<Option<Environment>, String> {
    let service = EnvironmentService::new(db.inner().clone()).map_err(|e| e.to_string())?;
    service.get_environment(&id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn create_environment(
    db: State<'_, Arc<SqlitePool>>,
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

    let service = EnvironmentService::new(db.inner().clone()).map_err(|e| e.to_string())?;
    let env = service.create_environment(
        app_id,
        branch,
        validated_dir.clone(),
        name,
        description,
    )
    .await
    .map_err(|e| e.to_string())?;

    let watcher_guard = watcher.lock().await;
    start_watchers_for_env(&watcher_guard, &env.id, &validated_dir).await;

    Ok(env)
}

#[tauri::command]
pub async fn update_environment(
    db: State<'_, Arc<SqlitePool>>,
    id: String,
    updates: serde_json::Value,
) -> Result<Environment, String> {
    let service = EnvironmentService::new(db.inner().clone()).map_err(|e| e.to_string())?;

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
    db: State<'_, Arc<SqlitePool>>,
    watcher: State<'_, Arc<AsyncMutex<FileSystemWatcherService>>>,
    id: String,
) -> Result<bool, String> {
    // Stop watching directories before deleting
    let watcher_guard = watcher.lock().await;
    let _ = watcher_guard.stop_watching_environment(&id).await;
    drop(watcher_guard);

    let service = EnvironmentService::new(db.inner().clone()).map_err(|e| e.to_string())?;
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
    db: State<'_, Arc<SqlitePool>>,
    watcher: State<'_, Arc<AsyncMutex<FileSystemWatcherService>>>,
    steam_path: String,
    name: Option<String>,
    description: Option<String>,
) -> Result<Environment, String> {
    let service = EnvironmentService::new(db.inner().clone()).map_err(|e| e.to_string())?;
    let env = service.create_steam_environment(steam_path.clone(), name, description)
        .await
        .map_err(|e| e.to_string())?;

    let watcher_guard = watcher.lock().await;
    start_watchers_for_env(&watcher_guard, &env.id, &env.output_dir).await;

    Ok(env)
}
