use crate::services::auth::AuthService;
use crate::services::settings::{RuntimeSettingsState, SettingsService};
use crate::utils::logging::error_with_location;
use once_cell::sync::Lazy;
use sqlx::SqlitePool;
use std::sync::Arc;
use tauri::{AppHandle, State};
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
    runtime_settings: State<'_, RuntimeSettingsState>,
) -> Result<serde_json::Value, String> {
    let auth_service = get_auth_service().await?;
    let save_credentials = save_credentials.unwrap_or(false);
    let result = auth_service
        .authenticate(
            username.clone(),
            password.clone(),
            steam_guard,
            save_credentials,
        )
        .await
        .map_err(|e| {
            error_with_location(format!(
                "Steam auth command failed for user credential flow: {}",
                e
            ));
            e.to_string()
        })?;

    if result.success {
        // Save credentials if requested
        if save_credentials {
            if let Some(pwd) = password {
                let settings_service =
                    SettingsService::new(db.inner().clone()).map_err(|e| e.to_string())?;
                settings_service
                    .save_credentials(username.clone(), pwd)
                    .await
                    .map_err(|e| {
                        error_with_location(format!(
                            "Steam auth succeeded but saving credentials failed: {}",
                            e
                        ));
                        e.to_string()
                    })?;

                let mut updates = serde_json::Map::new();
                updates.insert("steamUsername".to_string(), serde_json::json!(username));
                runtime_settings
                    .save_settings(db.inner().as_ref(), serde_json::Value::Object(updates))
                    .await
                    .map_err(|e| {
                        error_with_location(format!(
                            "Steam auth succeeded but persisting steamUsername failed: {}",
                            e
                        ));
                        e.to_string()
                    })?;
            }
        }

        Ok(serde_json::json!({
            "success": true,
            "message": if save_credentials {
                "Authentication successful. Session stored for future downloads."
            } else {
                "Authentication successful. Credentials and the DepotDownloader session were not saved."
            }
        }))
    } else {
        Ok(serde_json::json!({
            "success": false,
            "error": result.error,
            "requiresSteamGuard": result.requires_steam_guard
        }))
    }
}

#[tauri::command]
pub async fn authenticate_qr(
    db: State<'_, Arc<SqlitePool>>,
    app: AppHandle,
    save_credentials: Option<bool>,
    runtime_settings: State<'_, RuntimeSettingsState>,
) -> Result<serde_json::Value, String> {
    let auth_service = get_auth_service().await?;
    let save_credentials = save_credentials.unwrap_or(false);
    let result = auth_service
        .authenticate_qr(app, save_credentials)
        .await
        .map_err(|e| {
            error_with_location(format!("Steam QR auth command failed: {}", e));
            e.to_string()
        })?;

    if result.success {
        let username = result.username.clone().ok_or_else(|| {
            "QR login succeeded, but SIMM could not detect the Steam account name.".to_string()
        })?;

        if save_credentials {
            let mut updates = serde_json::Map::new();
            updates.insert(
                "steamUsername".to_string(),
                serde_json::json!(username.clone()),
            );
            runtime_settings
                .save_settings(db.inner().as_ref(), serde_json::Value::Object(updates))
                .await
                .map_err(|e| {
                    error_with_location(format!(
                        "Steam QR auth succeeded but persisting steamUsername failed: {}",
                        e
                    ));
                    e.to_string()
                })?;
        }

        Ok(serde_json::json!({
            "success": true,
            "message": if save_credentials {
                "QR authentication successful. DepotDownloader session stored for future downloads."
            } else {
                "QR authentication successful. The DepotDownloader session was not saved."
            },
            "username": username
        }))
    } else {
        Ok(serde_json::json!({
            "success": false,
            "error": result.error,
            "requiresSteamGuard": result.requires_steam_guard
        }))
    }
}
