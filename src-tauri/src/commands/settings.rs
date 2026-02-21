use crate::services::settings::SettingsService;
use crate::types::Settings;
use sqlx::SqlitePool;
use std::sync::Arc;
use tauri::State;

#[tauri::command]
pub async fn get_settings(db: State<'_, Arc<SqlitePool>>) -> Result<Settings, String> {
    let mut service = SettingsService::new(db.inner().clone()).map_err(|e| e.to_string())?;
    service.load_settings().await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn save_settings(
    db: State<'_, Arc<SqlitePool>>,
    updates: serde_json::Value,
) -> Result<(), String> {
    let mut service = SettingsService::new(db.inner().clone()).map_err(|e| e.to_string())?;
    service.save_settings(updates).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn save_credentials(
    db: State<'_, Arc<SqlitePool>>,
    username: String,
    password: String,
) -> Result<(), String> {
    let service = SettingsService::new(db.inner().clone()).map_err(|e| e.to_string())?;
    service.save_credentials(username, password).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn clear_credentials(db: State<'_, Arc<SqlitePool>>) -> Result<(), String> {
    let service = SettingsService::new(db.inner().clone()).map_err(|e| e.to_string())?;
    service.clear_credentials().await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn set_github_token(
    db: State<'_, Arc<SqlitePool>>,
    token: String,
) -> Result<(), String> {
    let service = SettingsService::new(db.inner().clone()).map_err(|e| e.to_string())?;
    service.save_github_token(token).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn has_github_token(db: State<'_, Arc<SqlitePool>>) -> Result<bool, String> {
    let service = SettingsService::new(db.inner().clone()).map_err(|e| e.to_string())?;
    let token = service.get_github_token().await.map_err(|e| e.to_string())?;
    Ok(token.is_some())
}

#[tauri::command]
pub async fn clear_github_token(db: State<'_, Arc<SqlitePool>>) -> Result<(), String> {
    let service = SettingsService::new(db.inner().clone()).map_err(|e| e.to_string())?;
    service.clear_github_token().await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn save_nexus_mods_api_key(
    db: State<'_, Arc<SqlitePool>>,
    api_key: String,
) -> Result<(), String> {
    let service = SettingsService::new(db.inner().clone()).map_err(|e| e.to_string())?;
    service.save_nexus_mods_api_key(api_key).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_nexus_mods_api_key(
    db: State<'_, Arc<SqlitePool>>,
) -> Result<Option<String>, String> {
    let service = SettingsService::new(db.inner().clone()).map_err(|e| e.to_string())?;
    service.get_nexus_mods_api_key().await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn has_nexus_mods_api_key(db: State<'_, Arc<SqlitePool>>) -> Result<bool, String> {
    let service = SettingsService::new(db.inner().clone()).map_err(|e| e.to_string())?;
    let api_key = service.get_nexus_mods_api_key().await.map_err(|e| e.to_string())?;
    Ok(api_key.is_some())
}

#[tauri::command]
pub async fn clear_nexus_mods_api_key(db: State<'_, Arc<SqlitePool>>) -> Result<(), String> {
    let service = SettingsService::new(db.inner().clone()).map_err(|e| e.to_string())?;
    service.clear_nexus_mods_api_key().await.map_err(|e| e.to_string())
}