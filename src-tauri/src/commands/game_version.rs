use crate::services::environment::EnvironmentService;
use crate::services::game_version::GameVersionService;
use once_cell::sync::Lazy;
use sqlx::SqlitePool;
use std::sync::Arc;
use tauri::State;
use tokio::sync::Mutex as AsyncMutex;

static GAME_VERSION_SERVICE: Lazy<AsyncMutex<Option<Arc<GameVersionService>>>> =
    Lazy::new(|| AsyncMutex::new(None));

async fn get_game_version_service() -> Result<Arc<GameVersionService>, String> {
    let mut service = GAME_VERSION_SERVICE.lock().await;
    if service.is_none() {
        *service = Some(Arc::new(GameVersionService::new()));
    }
    Ok(service.as_ref().unwrap().clone())
}

/// Extract game version from a game directory
#[tauri::command]
pub async fn extract_game_version(
    db: State<'_, Arc<SqlitePool>>,
    environment_id: String,
) -> Result<Option<String>, String> {
    let env_service = EnvironmentService::new(db.inner().clone()).map_err(|e| e.to_string())?;
    let env = env_service
        .get_environment(&environment_id)
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "Environment not found".to_string())?;

    if env.output_dir.is_empty() {
        return Err("Output directory not set".to_string());
    }

    let game_version_service = get_game_version_service().await?;
    game_version_service
        .extract_game_version(&env.output_dir)
        .await
        .map_err(|e| e.to_string())
}

/// Extract game version directly from a directory path (useful for testing or manual checks)
#[tauri::command]
pub async fn extract_game_version_from_path(game_dir: String) -> Result<Option<String>, String> {
    let game_version_service = get_game_version_service().await?;
    game_version_service
        .extract_game_version(&game_dir)
        .await
        .map_err(|e| e.to_string())
}
