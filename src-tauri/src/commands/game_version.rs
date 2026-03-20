use crate::services::environment::EnvironmentService;
use crate::services::game_version::GameVersionService;
use crate::types::{EnvironmentType, Runtime};
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

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtractGameVersionResponse {
    pub version: Option<String>,
    /// Set for Steam installs: branch after reconciliation with appmanifest.
    pub branch: Option<String>,
    /// Set for Steam installs: `IL2CPP` or `Mono` after reconciliation.
    pub runtime: Option<String>,
}

fn runtime_for_response(r: &Runtime) -> String {
    match r {
        Runtime::Il2cpp => "IL2CPP".to_string(),
        Runtime::Mono => "Mono".to_string(),
    }
}

/// Extract game version from a game directory. For Steam environments, reconciles
/// branch/runtime from disk first (same as update checks).
#[tauri::command]
pub async fn extract_game_version(
    db: State<'_, Arc<SqlitePool>>,
    environment_id: String,
) -> Result<ExtractGameVersionResponse, String> {
    let env_service = EnvironmentService::new(db.inner().clone()).map_err(|e| e.to_string())?;
    let mut env = env_service
        .get_environment(&environment_id)
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "Environment not found".to_string())?;

    if env.output_dir.is_empty() {
        return Err("Output directory not set".to_string());
    }

    if let Err(e) = env_service
        .reconcile_steam_env_branch_runtime_from_disk(&mut env)
        .await
    {
        log::warn!(
            "Steam branch/runtime reconcile before version extract failed for {}: {}",
            environment_id,
            e
        );
    }

    let game_version_service = get_game_version_service().await?;
    let version = game_version_service
        .extract_game_version(&env.output_dir)
        .await
        .map_err(|e| e.to_string())?;

    let is_steam = env.environment_type == Some(EnvironmentType::Steam) || env.id.starts_with("steam-");
    let (branch, runtime) = if is_steam {
        (
            Some(env.branch.clone()),
            Some(runtime_for_response(&env.runtime)),
        )
    } else {
        (None, None)
    };

    Ok(ExtractGameVersionResponse {
        version,
        branch,
        runtime,
    })
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
