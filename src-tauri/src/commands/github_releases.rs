use crate::services::github_releases::GitHubReleasesService;
use crate::services::settings::SettingsService;
use sqlx::SqlitePool;
use std::sync::Arc;
use tauri::State;

async fn github_service(db: State<'_, Arc<SqlitePool>>) -> Result<GitHubReleasesService, String> {
    let settings_service = SettingsService::new(db.inner().clone()).map_err(|e| e.to_string())?;
    let token = settings_service.get_github_token().await.map_err(|e| e.to_string())?;
    Ok(GitHubReleasesService::with_token(token))
}

#[tauri::command]
pub async fn get_latest_melon_loader_release(
    db: State<'_, Arc<SqlitePool>>,
) -> Result<Option<serde_json::Value>, String> {
    let service = github_service(db).await?;
    service.get_latest_release("LavaGang", "MelonLoader", false)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_all_melon_loader_releases(
    db: State<'_, Arc<SqlitePool>>,
) -> Result<Vec<serde_json::Value>, String> {
    let service = github_service(db).await?;
    service.get_all_releases("LavaGang", "MelonLoader", false)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_latest_s1api_release(
    db: State<'_, Arc<SqlitePool>>,
) -> Result<Option<serde_json::Value>, String> {
    let service = github_service(db).await?;
    service.get_latest_release("ifBars", "S1API", false)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_all_s1api_releases(
    db: State<'_, Arc<SqlitePool>>,
) -> Result<Vec<serde_json::Value>, String> {
    let service = github_service(db).await?;
    service.get_all_releases("ifBars", "S1API", false)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_latest_mlvscan_release(
    db: State<'_, Arc<SqlitePool>>,
) -> Result<Option<serde_json::Value>, String> {
    let service = github_service(db).await?;
    service.get_latest_release("ifBars", "MLVScan", false)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_all_mlvscan_releases(
    db: State<'_, Arc<SqlitePool>>,
) -> Result<Vec<serde_json::Value>, String> {
    let service = github_service(db).await?;
    service.get_all_releases("ifBars", "MLVScan", false)
        .await
        .map_err(|e| e.to_string())
}
