use crate::services::config::ConfigService;
use crate::services::environment::EnvironmentService;
use crate::types::{ConfigDocument, ConfigEditOperation, ConfigFileSummary};
use once_cell::sync::Lazy;
use sqlx::SqlitePool;
use std::sync::Arc;
use tauri::State;
use tokio::sync::Mutex as AsyncMutex;

static CONFIG_SERVICE: Lazy<AsyncMutex<Option<Arc<ConfigService>>>> =
    Lazy::new(|| AsyncMutex::new(None));

async fn get_config_service() -> Result<Arc<ConfigService>, String> {
    let mut service = CONFIG_SERVICE.lock().await;
    if service.is_none() {
        *service = Some(Arc::new(ConfigService::new()));
    }
    Ok(service.as_ref().unwrap().clone())
}

#[tauri::command]
pub async fn get_config_catalog(
    db: State<'_, Arc<SqlitePool>>,
    environment_id: String,
) -> Result<Vec<ConfigFileSummary>, String> {
    let env_service = EnvironmentService::new(db.inner().clone()).map_err(|e| e.to_string())?;
    let config_service = get_config_service().await?;

    let environment = env_service
        .get_environment(&environment_id)
        .await
        .map_err(|e| format!("Failed to get environment: {}", e))?
        .ok_or_else(|| "Environment not found".to_string())?;

    config_service
        .get_config_catalog(&environment.output_dir)
        .await
        .map_err(|e| format!("Failed to get config catalog: {}", e))
}

#[tauri::command]
pub async fn get_config_document(
    db: State<'_, Arc<SqlitePool>>,
    environment_id: String,
    file_path: String,
) -> Result<ConfigDocument, String> {
    let env_service = EnvironmentService::new(db.inner().clone()).map_err(|e| e.to_string())?;
    let config_service = get_config_service().await?;

    let environment = env_service
        .get_environment(&environment_id)
        .await
        .map_err(|e| format!("Failed to get environment: {}", e))?
        .ok_or_else(|| "Environment not found".to_string())?;

    config_service
        .get_config_document(&environment.output_dir, &file_path)
        .await
        .map_err(|e| format!("Failed to load config document: {}", e))
}

#[tauri::command]
pub async fn apply_config_edits(
    db: State<'_, Arc<SqlitePool>>,
    environment_id: String,
    file_path: String,
    operations: Vec<ConfigEditOperation>,
) -> Result<(), String> {
    let env_service = EnvironmentService::new(db.inner().clone()).map_err(|e| e.to_string())?;
    let config_service = get_config_service().await?;
    let environment = env_service
        .get_environment(&environment_id)
        .await
        .map_err(|e| format!("Failed to get environment: {}", e))?
        .ok_or_else(|| "Environment not found".to_string())?;
    let document = config_service
        .get_config_document(&environment.output_dir, &file_path)
        .await
        .map_err(|e| format!("Failed to load config document: {}", e))?;

    config_service
        .apply_config_edits(&document.summary.path, operations)
        .await
        .map_err(|e| format!("Failed to apply config edits: {}", e))
}

#[tauri::command]
pub async fn save_raw_config(
    db: State<'_, Arc<SqlitePool>>,
    environment_id: String,
    file_path: String,
    content: String,
) -> Result<(), String> {
    let env_service = EnvironmentService::new(db.inner().clone()).map_err(|e| e.to_string())?;
    let config_service = get_config_service().await?;
    let environment = env_service
        .get_environment(&environment_id)
        .await
        .map_err(|e| format!("Failed to get environment: {}", e))?
        .ok_or_else(|| "Environment not found".to_string())?;
    let document = config_service
        .get_config_document(&environment.output_dir, &file_path)
        .await
        .map_err(|e| format!("Failed to load config document: {}", e))?;

    config_service
        .save_raw_config(&document.summary.path, &content)
        .await
        .map_err(|e| format!("Failed to save raw config: {}", e))
}
