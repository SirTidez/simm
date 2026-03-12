use crate::services::auth::AuthService;
use crate::services::settings::SettingsService;
use once_cell::sync::Lazy;
use sqlx::SqlitePool;
use std::sync::Arc;
use tauri::State;
use tokio::sync::Mutex as AsyncMutex;

static AUTH_SERVICE: Lazy<AsyncMutex<Option<Arc<AuthService>>>> =
    Lazy::new(|| AsyncMutex::new(None));

async fn get_auth_service() -> Result<Arc<AuthService>, String> {
    let mut service = AUTH_SERVICE.lock().await;
    if service.is_none() {
        *service = Some(Arc::new(AuthService::new()));
    }
    Ok(service.as_ref().unwrap().clone())
}

#[tauri::command]
pub async fn authenticate(
    db: State<'_, Arc<SqlitePool>>,
    username: String,
    password: Option<String>,
    steam_guard: Option<String>,
    save_credentials: Option<bool>,
) -> Result<serde_json::Value, String> {
    let auth_service = get_auth_service().await?;
    let result = auth_service
        .authenticate(username.clone(), password.clone(), steam_guard)
        .await
        .map_err(|e| e.to_string())?;

    if result.success {
        // Save credentials if requested
        if save_credentials.unwrap_or(false) {
            if let Some(pwd) = password {
                let mut settings_service =
                    SettingsService::new(db.inner().clone()).map_err(|e| e.to_string())?;
                settings_service
                    .save_credentials(username.clone(), pwd)
                    .await
                    .map_err(|e| e.to_string())?;

                let mut updates = serde_json::Map::new();
                updates.insert("steamUsername".to_string(), serde_json::json!(username));
                settings_service
                    .save_settings(serde_json::Value::Object(updates))
                    .await
                    .map_err(|e| e.to_string())?;
            }
        }

        Ok(serde_json::json!({
            "success": true,
            "message": "Authentication successful. Session stored for future downloads."
        }))
    } else {
        Ok(serde_json::json!({
            "success": false,
            "error": result.error,
            "requiresSteamGuard": result.requires_steam_guard
        }))
    }
}
