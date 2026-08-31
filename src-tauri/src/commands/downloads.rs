use crate::services::depot_downloader::DepotDownloaderService;
use crate::services::environment::EnvironmentService;
use crate::services::settings::{RuntimeSettingsState, SettingsService};
use crate::types::{DepotDownloadOptions, DownloadProgress};
use once_cell::sync::Lazy;
use serde::Deserialize;
use sqlx::SqlitePool;
use std::sync::Arc;
use tauri::{AppHandle, State};
use tokio::sync::Mutex as AsyncMutex;

static DOWNLOAD_SERVICE: Lazy<AsyncMutex<Option<Arc<DepotDownloaderService>>>> =
    Lazy::new(|| AsyncMutex::new(None));

/// Credentials supplied for one DepotDownloader child only. They are never
/// persisted by this command and are passed to the child's stdin, not argv.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OneTimeDownloadCredentials {
    pub username: Option<String>,
    pub password: Option<String>,
    pub steam_guard: Option<String>,
    #[serde(default)]
    pub save_credentials: bool,
}

fn non_empty_credential(value: Option<String>) -> Option<String> {
    value.filter(|value| !value.trim().is_empty())
}

fn should_remember_credentials(
    remembered_session_exists: bool,
    one_time_credentials: Option<&OneTimeDownloadCredentials>,
) -> bool {
    remembered_session_exists
        && one_time_credentials
            .map(|credentials| credentials.save_credentials)
            .unwrap_or(true)
}

async fn get_download_service() -> Result<Arc<DepotDownloaderService>, String> {
    let mut service = DOWNLOAD_SERVICE.lock().await;
    if service.is_none() {
        *service = Some(Arc::new(DepotDownloaderService::new()));
    }
    Ok(service.as_ref().unwrap().clone())
}

pub(crate) async fn shutdown_downloads(app: &AppHandle) {
    let service = DOWNLOAD_SERVICE.lock().await.as_ref().cloned();
    let Some(service) = service else {
        return;
    };

    let report = service
        .shutdown(
            app,
            crate::services::depot_downloader::DEPOT_SHUTDOWN_TIMEOUT,
        )
        .await;
    if !report.interrupted_download_ids.is_empty() {
        log::warn!(
            "[DepotDownloader] Interrupted downloads during app shutdown: {}",
            report.interrupted_download_ids.join(", ")
        );
    }
    if !report.timed_out_download_ids.is_empty() {
        log::warn!(
            "[DepotDownloader] Shutdown deadline elapsed for downloads: {}",
            report.timed_out_download_ids.join(", ")
        );
    }
}

pub(crate) async fn reconcile_interrupted_downloads(
    pool: Arc<SqlitePool>,
) -> Result<Vec<String>, String> {
    DepotDownloaderService::reconcile_interrupted_downloads(pool)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn start_download(
    db: State<'_, Arc<SqlitePool>>,
    runtime_settings: State<'_, RuntimeSettingsState>,
    environment_id: String,
    app: AppHandle,
    one_time_credentials: Option<OneTimeDownloadCredentials>,
) -> Result<serde_json::Value, String> {
    let env_service = EnvironmentService::new(db.inner().clone()).map_err(|e| e.to_string())?;
    let env = env_service
        .get_environment(&environment_id)
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "Environment not found".to_string())?;

    let settings_service = SettingsService::new(db.inner().clone()).map_err(|e| e.to_string())?;
    let settings = runtime_settings.snapshot().await;
    log::debug!("[Settings] Download startup using cached public settings snapshot");

    let credentials = settings_service
        .get_credentials()
        .await
        .map_err(|e| e.to_string())?;

    // The explicit remembered-session setting is the durable opt-in that lets
    // DepotDownloader reuse its own credential store. Do not infer that
    // consent from a public username or an encrypted password alone.
    // An explicit one-time handoff is non-persistent unless it also carries
    // the save decision and the durable session marker confirms that save.
    // A username, password, or caller-provided boolean alone never enables
    // DepotDownloader's own credential persistence.
    let remember_credentials = should_remember_credentials(
        settings
            .depot_downloader_remembered_session
            .unwrap_or(false),
        one_time_credentials.as_ref(),
    );
    let saved_username = credentials.map(|(username, _)| username);
    let one_time_username = one_time_credentials
        .as_ref()
        .and_then(|credentials| non_empty_credential(credentials.username.clone()));
    let username = one_time_username
        .or(saved_username)
        .or_else(|| settings.steam_username.clone())
        .ok_or_else(|| "Steam authentication required. Please authenticate first.".to_string())?;
    let one_time_password = one_time_credentials
        .as_ref()
        .and_then(|credentials| non_empty_credential(credentials.password.clone()));
    let one_time_steam_guard =
        one_time_credentials.and_then(|credentials| non_empty_credential(credentials.steam_guard));

    let depot_platform =
        DepotDownloaderService::resolve_depot_platform(&env.app_id, settings.platform.clone());

    let options = DepotDownloadOptions {
        app_id: env.app_id,
        branch: env.branch,
        output_dir: env.output_dir,
        username: Some(username),
        password: one_time_password,
        remember_credentials,
        steam_guard: one_time_steam_guard,
        validate: None,
        os: Some(depot_platform),
        language: Some(settings.language),
        max_downloads: Some(settings.max_concurrent_downloads),
    };

    let download_service = get_download_service().await?;
    // Persist the lifecycle transition before spawning the process so a fast
    // completion cannot be overwritten by this command's initial status write.
    env_service
        .update_environment(
            &environment_id,
            vec![("status".to_string(), serde_json::json!("downloading"))],
        )
        .await
        .map_err(|e| e.to_string())?;

    if let Err(error) = download_service
        .start_download(environment_id.clone(), options, app)
        .await
    {
        if let Err(rollback_error) = env_service
            .update_environment(
                &environment_id,
                vec![(
                    "status".to_string(),
                    serde_json::to_value(&env.status).expect("environment status serializes"),
                )],
            )
            .await
        {
            log::warn!(
                "[DepotDownloader] Failed to restore environment {} after download startup failed: {:#}",
                environment_id,
                rollback_error
            );
        }
        return Err(error.to_string());
    }

    Ok(serde_json::json!({ "success": true, "downloadId": environment_id }))
}

#[tauri::command]
pub async fn cancel_download(download_id: String, app: AppHandle) -> Result<bool, String> {
    let download_service = get_download_service().await?;
    download_service
        .cancel_download(&download_id, &app)
        .await
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::{should_remember_credentials, OneTimeDownloadCredentials};

    #[test]
    fn one_time_save_false_never_enables_depot_credential_persistence() {
        let one_time = OneTimeDownloadCredentials {
            username: Some("demo-user".to_string()),
            password: Some("dummy-password".to_string()),
            steam_guard: Some("dummy-guard".to_string()),
            save_credentials: false,
        };

        assert!(!should_remember_credentials(true, Some(&one_time)));
        assert!(!should_remember_credentials(false, Some(&one_time)));
        assert!(should_remember_credentials(true, None));
    }
}

#[tauri::command]
pub async fn get_download_progress(
    download_id: String,
) -> Result<Option<DownloadProgress>, String> {
    let download_service = get_download_service().await?;
    Ok(download_service.get_progress(&download_id).await)
}
