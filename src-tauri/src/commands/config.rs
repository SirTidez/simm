use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::Mutex as AsyncMutex;
use once_cell::sync::Lazy;
use crate::services::config::ConfigService;
use crate::services::environment::EnvironmentService;
use serde::{Deserialize, Serialize};

static CONFIG_SERVICE: Lazy<AsyncMutex<Option<Arc<ConfigService>>>> = Lazy::new(|| AsyncMutex::new(None));
static ENV_SERVICE: Lazy<AsyncMutex<Option<Arc<EnvironmentService>>>> = Lazy::new(|| AsyncMutex::new(None));

async fn get_config_service() -> Result<Arc<ConfigService>, String> {
    let mut service = CONFIG_SERVICE.lock().await;
    if service.is_none() {
        *service = Some(Arc::new(ConfigService::new()));
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

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigUpdate {
    pub section: String,
    pub key: String,
    pub value: String,
}

#[tauri::command]
pub async fn get_config_files(
    environment_id: String,
) -> Result<Vec<crate::services::config::ConfigFile>, String> {
    let env_service = get_env_service().await?;
    let config_service = get_config_service().await?;

    // Get the environment to find the game directory
    let environment = env_service
        .get_environment(&environment_id)
        .await
        .map_err(|e| format!("Failed to get environment: {}", e))?
        .ok_or_else(|| "Environment not found".to_string())?;

    // Get all config files
    let config_files = config_service
        .get_config_files(&environment.output_dir)
        .await
        .map_err(|e| format!("Failed to get config files: {}", e))?;

    Ok(config_files)
}

#[tauri::command]
pub async fn get_grouped_config(
    environment_id: String,
) -> Result<HashMap<String, Vec<crate::services::config::ConfigSection>>, String> {
    let env_service = get_env_service().await?;
    let config_service = get_config_service().await?;

    // Get the environment
    let environment = env_service
        .get_environment(&environment_id)
        .await
        .map_err(|e| format!("Failed to get environment: {}", e))?
        .ok_or_else(|| "Environment not found".to_string())?;

    // Get config files
    let config_files = config_service
        .get_config_files(&environment.output_dir)
        .await
        .map_err(|e| format!("Failed to get config files: {}", e))?;

    // Find MelonPreferences.cfg
    let melon_prefs = config_files
        .iter()
        .find(|cf| cf.file_type == crate::services::config::ConfigFileType::MelonPreferences);

    if let Some(prefs) = melon_prefs {
        Ok(config_service.group_by_mod(prefs))
    } else {
        Ok(HashMap::new())
    }
}

#[tauri::command]
pub async fn update_config(
    file_path: String,
    updates: Vec<ConfigUpdate>,
) -> Result<(), String> {
    let config_service = get_config_service().await?;

    // Convert updates to nested HashMap
    let mut update_map: HashMap<String, HashMap<String, String>> = HashMap::new();

    for update in updates {
        update_map
            .entry(update.section)
            .or_insert_with(HashMap::new)
            .insert(update.key, update.value);
    }

    // Update the config file
    config_service
        .update_config_file(&file_path, update_map)
        .await
        .map_err(|e| format!("Failed to update config: {}", e))?;

    Ok(())
}
