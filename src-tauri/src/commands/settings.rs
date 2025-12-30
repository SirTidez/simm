use crate::services::settings::SettingsService;
use crate::types::Settings;
use std::sync::Arc;
use tokio::sync::Mutex as AsyncMutex;
use once_cell::sync::Lazy;

static SETTINGS_SERVICE: Lazy<AsyncMutex<Option<Arc<AsyncMutex<SettingsService>>>>> = Lazy::new(|| AsyncMutex::new(None));

async fn get_settings_service() -> Result<Arc<AsyncMutex<SettingsService>>, String> {
    let mut service = SETTINGS_SERVICE.lock().await;
    if service.is_none() {
        *service = Some(Arc::new(AsyncMutex::new(SettingsService::new().map_err(|e| e.to_string())?)));
    }
    Ok(service.as_ref().unwrap().clone())
}

#[tauri::command]
pub async fn get_settings() -> Result<Settings, String> {
    let service = get_settings_service().await?;
    let mut service = service.lock().await;
    service.load_settings()
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn save_settings(updates: serde_json::Value) -> Result<(), String> {
    let service = get_settings_service().await?;
    let mut service = service.lock().await;
    service.save_settings(updates)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn save_credentials(username: String, password: String) -> Result<(), String> {
    let service = get_settings_service().await?;
    let service = service.lock().await;
    service.save_credentials(username, password)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn clear_credentials() -> Result<(), String> {
    let service = get_settings_service().await?;
    let service = service.lock().await;
    service.clear_credentials()
        .await
        .map_err(|e| e.to_string())
}

/// Set GitHub API token securely (encrypted storage)
/// The token is never logged or displayed
#[tauri::command]
pub async fn set_github_token(token: String) -> Result<(), String> {
    let service = get_settings_service().await?;
    let service = service.lock().await;
    service.save_github_token(token)
        .await
        .map_err(|e| e.to_string())
}

/// Check if GitHub token is set (returns boolean, never the token itself)
#[tauri::command]
pub async fn has_github_token() -> Result<bool, String> {
    let service = get_settings_service().await?;
    let service = service.lock().await;
    let token = service.get_github_token()
        .await
        .map_err(|e| e.to_string())?;
    Ok(token.is_some())
}

/// Clear GitHub token
#[tauri::command]
pub async fn clear_github_token() -> Result<(), String> {
    let service = get_settings_service().await?;
    let service = service.lock().await;
    service.clear_github_token()
        .await
        .map_err(|e| e.to_string())
}

