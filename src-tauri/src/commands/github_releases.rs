use crate::services::github_releases::GitHubReleasesService;
use sqlx::SqlitePool;
use std::sync::Arc;
use tauri::State;

fn github_service(_db: State<'_, Arc<SqlitePool>>) -> GitHubReleasesService {
    GitHubReleasesService::new()
}

#[tauri::command]
pub async fn get_latest_melon_loader_release(
    db: State<'_, Arc<SqlitePool>>,
) -> Result<Option<serde_json::Value>, String> {
    let service = github_service(db);
    service
        .get_latest_release("LavaGang", "MelonLoader", false)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_all_melon_loader_releases(
    db: State<'_, Arc<SqlitePool>>,
) -> Result<Vec<serde_json::Value>, String> {
    let service = github_service(db);
    service
        .get_all_releases_with_latest("LavaGang", "MelonLoader", false)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_latest_s1api_release(
    db: State<'_, Arc<SqlitePool>>,
) -> Result<Option<serde_json::Value>, String> {
    let service = github_service(db);
    service
        .get_latest_release("ifBars", "S1API", false)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_all_s1api_releases(
    db: State<'_, Arc<SqlitePool>>,
) -> Result<Vec<serde_json::Value>, String> {
    let service = github_service(db);
    service
        .get_all_releases_with_latest("ifBars", "S1API", false)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_latest_mlvscan_release(
    db: State<'_, Arc<SqlitePool>>,
) -> Result<Option<serde_json::Value>, String> {
    let service = github_service(db);
    service
        .get_latest_release("ifBars", "MLVScan", false)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_all_mlvscan_releases(
    db: State<'_, Arc<SqlitePool>>,
) -> Result<Vec<serde_json::Value>, String> {
    let service = github_service(db);
    service
        .get_all_releases_with_latest("ifBars", "MLVScan", false)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_release_api_health(
    db: State<'_, Arc<SqlitePool>>,
) -> Result<serde_json::Value, String> {
    let service = github_service(db);
    service.get_health().await.map_err(|e| e.to_string())
}
