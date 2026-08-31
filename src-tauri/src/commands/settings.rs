use crate::services::logger::LoggerService;
use crate::services::settings::{RuntimeSettingsState, SettingsService};
use crate::types::{CustomThemeDefinition, Settings};
use sqlx::SqlitePool;
use std::sync::Arc;
use tauri::State;

/// Refreshes process-owned public settings only after a durable operation has
/// succeeded. This keeps repair from leaving runtime behavior on an obsolete
/// snapshot when migrations or recovery changed the settings row.
async fn reload_runtime_settings_from_database(
    pool: Arc<SqlitePool>,
    runtime_settings: &RuntimeSettingsState,
) -> Result<Settings, String> {
    let mut service = SettingsService::new(pool).map_err(|error| error.to_string())?;
    let settings = service
        .load_settings()
        .await
        .map_err(|error| error.to_string())?;
    runtime_settings.replace(settings.clone()).await;
    LoggerService::apply_settings(&settings);
    log::info!("[Settings] Reloaded cached public settings after durable database repair");
    Ok(settings)
}

#[tauri::command]
pub async fn get_settings(
    _db: State<'_, Arc<SqlitePool>>,
    runtime_settings: State<'_, RuntimeSettingsState>,
) -> Result<Settings, String> {
    let settings = runtime_settings.snapshot().await;
    LoggerService::apply_settings(&settings);
    Ok(settings)
}

#[tauri::command]
pub async fn save_settings(
    db: State<'_, Arc<SqlitePool>>,
    runtime_settings: State<'_, RuntimeSettingsState>,
    updates: serde_json::Value,
) -> Result<(), String> {
    let settings = runtime_settings
        .save_settings(db.inner().as_ref(), updates)
        .await
        .map_err(|e| e.to_string())?;
    LoggerService::apply_settings(&settings);

    Ok(())
}

#[tauri::command]
pub async fn backup_database(db: State<'_, Arc<SqlitePool>>) -> Result<String, String> {
    let backup_path = crate::db::create_database_backup(db.inner().as_ref(), "manual")
        .await
        .map_err(|e| e.to_string())?;
    Ok(backup_path.to_string_lossy().to_string())
}

#[tauri::command]
pub async fn repair_database(
    db: State<'_, Arc<SqlitePool>>,
    runtime_settings: State<'_, RuntimeSettingsState>,
) -> Result<String, String> {
    let backup_path = crate::db::repair_database(db.inner().as_ref())
        .await
        .map_err(|e| e.to_string())?;
    reload_runtime_settings_from_database(db.inner().clone(), runtime_settings.inner()).await?;
    Ok(backup_path.to_string_lossy().to_string())
}

#[tauri::command]
pub async fn get_custom_themes(
    db: State<'_, Arc<SqlitePool>>,
) -> Result<Vec<CustomThemeDefinition>, String> {
    let service = SettingsService::new(db.inner().clone()).map_err(|e| e.to_string())?;
    service
        .list_custom_themes()
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_themes_directory(db: State<'_, Arc<SqlitePool>>) -> Result<String, String> {
    let service = SettingsService::new(db.inner().clone()).map_err(|e| e.to_string())?;
    let dir = service.get_themes_directory().map_err(|e| e.to_string())?;
    Ok(dir.to_string_lossy().to_string())
}

#[tauri::command]
pub async fn save_credentials(
    db: State<'_, Arc<SqlitePool>>,
    runtime_settings: State<'_, RuntimeSettingsState>,
    username: String,
    password: String,
) -> Result<(), String> {
    let service = SettingsService::new(db.inner().clone()).map_err(|e| e.to_string())?;
    service
        .save_credentials(username.clone(), password)
        .await
        .map_err(|e| e.to_string())?;
    runtime_settings
        .save_settings(
            db.inner().as_ref(),
            serde_json::json!({
                "steamUsername": username,
                "depotDownloaderRememberedSession": true
            }),
        )
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn clear_credentials(
    db: State<'_, Arc<SqlitePool>>,
    runtime_settings: State<'_, RuntimeSettingsState>,
) -> Result<(), String> {
    let service = SettingsService::new(db.inner().clone()).map_err(|e| e.to_string())?;
    runtime_settings
        .save_settings(
            db.inner().as_ref(),
            serde_json::json!({
                "steamUsername": null,
                "depotDownloaderRememberedSession": false
            }),
        )
        .await
        .map_err(|e| e.to_string())?;
    // Disable session reuse durably before deleting the encrypted password.
    // If secret deletion fails, the dormant secret remains inaccessible to
    // automatic downloads instead of leaving a stale reuse marker enabled.
    service
        .clear_credentials()
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn save_nexus_mods_api_key(
    db: State<'_, Arc<SqlitePool>>,
    api_key: String,
) -> Result<(), String> {
    let service = SettingsService::new(db.inner().clone()).map_err(|e| e.to_string())?;
    service
        .save_nexus_mods_api_key(api_key)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_nexus_mods_api_key(
    db: State<'_, Arc<SqlitePool>>,
) -> Result<Option<String>, String> {
    let service = SettingsService::new(db.inner().clone()).map_err(|e| e.to_string())?;
    service
        .get_nexus_mods_api_key()
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn has_nexus_mods_api_key(db: State<'_, Arc<SqlitePool>>) -> Result<bool, String> {
    let service = SettingsService::new(db.inner().clone()).map_err(|e| e.to_string())?;
    let api_key = service
        .get_nexus_mods_api_key()
        .await
        .map_err(|e| e.to_string())?;
    Ok(api_key.is_some())
}

#[tauri::command]
pub async fn clear_nexus_mods_api_key(db: State<'_, Arc<SqlitePool>>) -> Result<(), String> {
    let service = SettingsService::new(db.inner().clone()).map_err(|e| e.to_string())?;
    service
        .clear_nexus_mods_api_key()
        .await
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::initialize_pool;
    use crate::services::settings::SettingsService;
    use serial_test::serial;
    use tempfile::tempdir;

    struct EnvVarGuard {
        original: Option<String>,
    }

    impl EnvVarGuard {
        fn set(value: &str) -> Self {
            let original = std::env::var("SIMMRUST_DATA_DIR").ok();
            std::env::set_var("SIMMRUST_DATA_DIR", value);
            Self { original }
        }
    }

    impl Drop for EnvVarGuard {
        fn drop(&mut self) {
            if let Some(value) = &self.original {
                std::env::set_var("SIMMRUST_DATA_DIR", value);
            } else {
                std::env::remove_var("SIMMRUST_DATA_DIR");
            }
        }
    }

    #[tokio::test]
    #[serial]
    async fn durable_reload_replaces_runtime_settings_only_when_invoked() -> anyhow::Result<()> {
        let temp = tempdir()?;
        let _guard = EnvVarGuard::set(temp.path().to_string_lossy().as_ref());
        let pool = initialize_pool().await?;
        let mut service = SettingsService::new(pool.clone())?;
        let original = service.load_settings().await?;
        let runtime = RuntimeSettingsState::new(original.clone());

        service
            .save_settings(serde_json::json!({ "language": "de" }))
            .await?;
        assert_ne!(runtime.snapshot().await.language, "de");

        let reloaded = reload_runtime_settings_from_database(pool, &runtime)
            .await
            .map_err(anyhow::Error::msg)?;
        assert_eq!(reloaded.language, "de");
        assert_eq!(runtime.snapshot().await.language, "de");
        Ok(())
    }
}
