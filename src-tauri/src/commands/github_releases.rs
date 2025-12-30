use crate::services::github_releases::GitHubReleasesService;
use crate::services::settings::SettingsService;
use std::sync::Arc;
use tokio::sync::Mutex as AsyncMutex;
use once_cell::sync::Lazy;

static GITHUB_RELEASES_SERVICE: Lazy<AsyncMutex<Option<Arc<GitHubReleasesService>>>> = Lazy::new(|| AsyncMutex::new(None));

async fn get_github_releases_service() -> Result<Arc<GitHubReleasesService>, String> {
    let mut service = GITHUB_RELEASES_SERVICE.lock().await;
    if service.is_none() {
        // Load GitHub token from encrypted storage
        let settings_service = SettingsService::new().map_err(|e| e.to_string())?;
        let token = settings_service.get_github_token().await.map_err(|e| e.to_string())?;
        *service = Some(Arc::new(GitHubReleasesService::with_token(token)));
    }
    Ok(service.as_ref().unwrap().clone())
}

#[tauri::command]
pub async fn get_latest_melon_loader_release() -> Result<Option<serde_json::Value>, String> {
    let service = get_github_releases_service().await?;
    service.get_latest_release("LavaGang", "MelonLoader", false)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_all_melon_loader_releases() -> Result<Vec<serde_json::Value>, String> {
    let service = get_github_releases_service().await?;
    service.get_all_releases("LavaGang", "MelonLoader", false)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_latest_s1api_release() -> Result<Option<serde_json::Value>, String> {
    let service = get_github_releases_service().await?;
    service.get_latest_release("ifBars", "S1API", false)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_all_s1api_releases() -> Result<Vec<serde_json::Value>, String> {
    let service = get_github_releases_service().await?;
    service.get_all_releases("ifBars", "S1API", false)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_latest_mlvscan_release() -> Result<Option<serde_json::Value>, String> {
    let service = get_github_releases_service().await?;
    service.get_latest_release("ifBars", "MLVScan", false)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_all_mlvscan_releases() -> Result<Vec<serde_json::Value>, String> {
    let service = get_github_releases_service().await?;
    service.get_all_releases("ifBars", "MLVScan", false)
        .await
        .map_err(|e| e.to_string())
}

