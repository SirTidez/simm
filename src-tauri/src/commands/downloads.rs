use crate::services::depot_downloader::DepotDownloaderService;
use crate::services::environment::EnvironmentService;
use crate::types::{DepotDownloadOptions, DownloadProgress};
use tauri::AppHandle;
use std::sync::Arc;
use tokio::sync::Mutex as AsyncMutex;
use once_cell::sync::Lazy;

static DOWNLOAD_SERVICE: Lazy<AsyncMutex<Option<Arc<DepotDownloaderService>>>> = Lazy::new(|| AsyncMutex::new(None));
static ENV_SERVICE: Lazy<AsyncMutex<Option<Arc<EnvironmentService>>>> = Lazy::new(|| AsyncMutex::new(None));

async fn get_download_service() -> Result<Arc<DepotDownloaderService>, String> {
    let mut service = DOWNLOAD_SERVICE.lock().await;
    if service.is_none() {
        *service = Some(Arc::new(DepotDownloaderService::new()));
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

#[tauri::command]
pub async fn start_download(
    environment_id: String,
    app: AppHandle,
) -> Result<serde_json::Value, String> {
    let env_service = get_env_service().await?;
    let env = env_service.get_environment(&environment_id)
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "Environment not found".to_string())?;

    let mut settings_service = crate::services::settings::SettingsService::new()
        .map_err(|e| e.to_string())?;
    let settings = settings_service.load_settings()
        .await
        .map_err(|e| e.to_string())?;

    let credentials = settings_service.get_credentials()
        .await
        .map_err(|e| e.to_string())?;

    let username = credentials
        .and_then(|(u, _)| Some(u))
        .or_else(|| settings.steam_username.clone())
        .ok_or_else(|| "Steam authentication required. Please authenticate first.".to_string())?;

    let options = DepotDownloadOptions {
        app_id: env.app_id,
        branch: env.branch,
        output_dir: env.output_dir,
        username: Some(username),
        password: None, // Don't pass password - let -remember-password handle it
        steam_guard: None,
        validate: None,
        os: Some(settings.platform),
        language: Some(settings.language),
        max_downloads: Some(settings.max_concurrent_downloads),
    };

    let download_service = get_download_service().await?;
    download_service.start_download(environment_id.clone(), options, app)
        .await
        .map_err(|e| e.to_string())?;

    // Update environment status
    env_service.update_environment(&environment_id, vec![
        ("status".to_string(), serde_json::json!("downloading")),
    ]).await.map_err(|e| e.to_string())?;

    Ok(serde_json::json!({ "success": true, "downloadId": environment_id }))
}

#[tauri::command]
pub async fn cancel_download(download_id: String) -> Result<bool, String> {
    let download_service = get_download_service().await?;
    download_service.cancel_download(&download_id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_download_progress(download_id: String) -> Result<Option<DownloadProgress>, String> {
    let download_service = get_download_service().await?;
    Ok(download_service.get_progress(&download_id).await)
}

