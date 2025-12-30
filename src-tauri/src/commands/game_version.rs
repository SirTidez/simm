use crate::services::game_version::GameVersionService;
use crate::services::environment::EnvironmentService;
use std::sync::Arc;
use tokio::sync::Mutex as AsyncMutex;
use once_cell::sync::Lazy;

static GAME_VERSION_SERVICE: Lazy<AsyncMutex<Option<Arc<GameVersionService>>>> = Lazy::new(|| AsyncMutex::new(None));
static ENV_SERVICE: Lazy<AsyncMutex<Option<Arc<EnvironmentService>>>> = Lazy::new(|| AsyncMutex::new(None));

async fn get_game_version_service() -> Result<Arc<GameVersionService>, String> {
    let mut service = GAME_VERSION_SERVICE.lock().await;
    if service.is_none() {
        *service = Some(Arc::new(GameVersionService::new()));
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

/// Extract game version from a game directory
#[tauri::command]
pub async fn extract_game_version(environment_id: String) -> Result<Option<String>, String> {
    let env_service = get_env_service().await?;
    let env = env_service.get_environment(&environment_id)
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "Environment not found".to_string())?;

    if env.output_dir.is_empty() {
        return Err("Output directory not set".to_string());
    }

    let game_version_service = get_game_version_service().await?;
    game_version_service.extract_game_version(&env.output_dir)
        .await
        .map_err(|e| e.to_string())
}

/// Extract game version directly from a directory path (useful for testing or manual checks)
#[tauri::command]
pub async fn extract_game_version_from_path(game_dir: String) -> Result<Option<String>, String> {
    let game_version_service = get_game_version_service().await?;
    game_version_service.extract_game_version(&game_dir)
        .await
        .map_err(|e| e.to_string())
}

