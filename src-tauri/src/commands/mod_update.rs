use crate::services::mod_update::ModUpdateService;
use crate::services::mods::ModsService;
use crate::services::environment::EnvironmentService;
use crate::services::thunderstore::ThunderStoreService;
use crate::services::nexus_mods::NexusModsService;
use crate::services::github_releases::GitHubReleasesService;
use crate::services::settings::SettingsService;
use crate::types::ModSource;
use sqlx::SqlitePool;
use std::path::Path;
use std::sync::Arc;
use tauri::State;
use tokio::sync::Mutex as AsyncMutex;
use once_cell::sync::Lazy;

static MOD_UPDATE_SERVICE: Lazy<AsyncMutex<Option<Arc<ModUpdateService>>>> = Lazy::new(|| AsyncMutex::new(None));
static THUNDERSTORE_SERVICE: Lazy<AsyncMutex<Option<Arc<ThunderStoreService>>>> = Lazy::new(|| AsyncMutex::new(None));
static NEXUS_MODS_SERVICE: Lazy<AsyncMutex<Option<Arc<NexusModsService>>>> = Lazy::new(|| AsyncMutex::new(None));
static GITHUB_SERVICE: Lazy<AsyncMutex<Option<Arc<GitHubReleasesService>>>> = Lazy::new(|| AsyncMutex::new(None));

fn map_mod_source(source: Option<ModSource>) -> &'static str {
    match source {
        Some(ModSource::Thunderstore) => "thunderstore",
        Some(ModSource::Nexusmods) => "nexusmods",
        Some(ModSource::Github) => "github",
        Some(ModSource::Local) => "local",
        Some(ModSource::Unknown) | None => "unknown",
    }
}

async fn get_mod_update_service() -> Result<Arc<ModUpdateService>, String> {
    let mut service = MOD_UPDATE_SERVICE.lock().await;
    if service.is_none() {
        *service = Some(Arc::new(ModUpdateService::new()));
    }
    Ok(service.as_ref().unwrap().clone())
}

async fn get_thunderstore_service() -> Result<Arc<ThunderStoreService>, String> {
    let mut service = THUNDERSTORE_SERVICE.lock().await;
    if service.is_none() {
        *service = Some(Arc::new(ThunderStoreService::new()));
    }
    Ok(service.as_ref().unwrap().clone())
}

async fn get_nexus_mods_service(db: Arc<SqlitePool>) -> Result<Arc<NexusModsService>, String> {
    let nexus_service = {
        let mut service = NEXUS_MODS_SERVICE.lock().await;
        if service.is_none() {
            *service = Some(Arc::new(NexusModsService::new()));
        }
        service.as_ref().unwrap().clone()
    };
    let settings_service = SettingsService::new(db).map_err(|e| e.to_string())?;
    match settings_service.get_nexus_mods_api_key().await {
        Ok(Some(api_key)) => {
            nexus_service.set_api_key(api_key).await;
        }
        Ok(None) => {}
        Err(e) => {
            log::warn!("Failed to get Nexus Mods API key: {:?}", e);
        }
    }
    Ok(nexus_service)
}

async fn get_github_service(db: Arc<SqlitePool>) -> Result<Arc<GitHubReleasesService>, String> {
    let github_service = {
        let mut service = GITHUB_SERVICE.lock().await;
        if service.is_none() {
            *service = Some(Arc::new(GitHubReleasesService::new()));
        }
        service.as_ref().unwrap().clone()
    };
    // Fetch token on every call so settings changes take effect without app restart
    let settings_service = SettingsService::new(db).map_err(|e| e.to_string())?;
    match settings_service.get_github_token().await {
        Ok(Some(token)) => github_service.set_token(Some(token)).await,
        Ok(None) => github_service.set_token(None).await,
        Err(e) => {
            log::warn!("Failed to get GitHub token: {:?}", e);
        }
    }
    Ok(github_service)
}

#[tauri::command]
pub async fn check_mod_updates(
    db: State<'_, Arc<SqlitePool>>,
    environment_id: String,
) -> Result<Vec<serde_json::Value>, String> {
    let mod_update_service = get_mod_update_service().await?;
    let mods_service = ModsService::new(db.inner().clone());
    let env_service = EnvironmentService::new(db.inner().clone()).map_err(|e| e.to_string())?;
    let thunderstore_service = get_thunderstore_service().await?;
    let nexus_mods_service = get_nexus_mods_service(db.inner().clone()).await?;
    let github_service = get_github_service(db.inner().clone()).await?;

    mod_update_service.check_mod_updates(
        &environment_id,
        &env_service,
        &mods_service,
        &thunderstore_service,
        &nexus_mods_service,
        &github_service,
    )
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn update_mod(
    db: State<'_, Arc<SqlitePool>>,
    environment_id: String,
    mod_file_name: String,
) -> Result<serde_json::Value, String> {
    let mod_update_service = get_mod_update_service().await?;
    let mods_service = ModsService::new(db.inner().clone());
    let env_service = EnvironmentService::new(db.inner().clone()).map_err(|e| e.to_string())?;
    let thunderstore_service = get_thunderstore_service().await?;
    let nexus_mods_service = get_nexus_mods_service(db.inner().clone()).await?;
    let github_service = get_github_service(db.inner().clone()).await?;

    mod_update_service
        .update_mod(
            &environment_id,
            &mod_file_name,
            &env_service,
            &mods_service,
            &thunderstore_service,
            &nexus_mods_service,
            &github_service,
        )
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_mod_updates_summary(
    db: State<'_, Arc<SqlitePool>>,
    environment_id: String,
) -> Result<serde_json::Value, String> {
    let env_service = EnvironmentService::new(db.inner().clone()).map_err(|e| e.to_string())?;
    let env = env_service
        .get_environment(&environment_id)
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "Environment not found".to_string())?;

    if env.output_dir.is_empty() {
        return Ok(serde_json::json!({ "count": 0, "updates": [] }));
    }

    let mods_dir = Path::new(&env.output_dir).join("Mods");
    let mods_service = ModsService::new(db.inner().clone());
    let metadata = mods_service
        .load_mod_metadata(&mods_dir)
        .await
        .map_err(|e| e.to_string())?;

    let updates: Vec<serde_json::Value> = metadata
        .into_iter()
        .filter(|(_, meta)| meta.update_available == Some(true))
        .map(|(file_name, meta)| {
            serde_json::json!({
                "modFileName": file_name,
                "modName": meta.mod_name.unwrap_or_else(|| file_name.clone()),
                "currentVersion": meta.source_version.or(meta.installed_version).unwrap_or_default(),
                "latestVersion": meta.remote_version.unwrap_or_default(),
                "source": map_mod_source(meta.source)
            })
        })
        .collect();

    let count = updates.len();
    Ok(serde_json::json!({ "count": count, "updates": updates }))
}

#[tauri::command]
pub async fn get_all_mod_updates_summary(
    db: State<'_, Arc<SqlitePool>>,
) -> Result<Vec<serde_json::Value>, String> {
    let env_service = EnvironmentService::new(db.inner().clone()).map_err(|e| e.to_string())?;
    let envs = env_service
        .get_environments()
        .await
        .map_err(|e| e.to_string())?;

    let completed_envs: Vec<_> = envs
        .into_iter()
        .filter(|e| matches!(e.status, crate::types::EnvironmentStatus::Completed))
        .collect();

    let mods_service = ModsService::new(db.inner().clone());
    let mut results = Vec::new();

    for env in completed_envs {
        if env.output_dir.is_empty() {
            results.push(serde_json::json!({
                "environmentId": env.id,
                "environmentName": env.name,
                "count": 0,
                "updates": []
            }));
            continue;
        }

        let mods_dir = Path::new(&env.output_dir).join("Mods");
        let metadata = mods_service
            .load_mod_metadata(&mods_dir)
            .await
            .unwrap_or_default();

        let updates: Vec<serde_json::Value> = metadata
            .into_iter()
            .filter(|(_, meta)| meta.update_available == Some(true))
            .map(|(file_name, meta)| {
                serde_json::json!({
                    "modFileName": file_name,
                    "modName": meta.mod_name.unwrap_or_else(|| file_name.clone()),
                    "currentVersion": meta.source_version.or(meta.installed_version).unwrap_or_default(),
                    "latestVersion": meta.remote_version.unwrap_or_default(),
                    "source": map_mod_source(meta.source)
                })
            })
            .collect();

        let count = updates.len();
        results.push(serde_json::json!({
            "environmentId": env.id,
            "environmentName": env.name,
            "count": count,
            "updates": updates
        }));
    }

    Ok(results)
}

#[cfg(test)]
mod tests {
    use super::map_mod_source;
    use super::get_github_service;
    use crate::db::initialize_pool;
    use crate::services::settings::SettingsService;
    use crate::types::ModSource;
    use serial_test::serial;
    use tempfile::tempdir;

    struct EnvVarGuard {
        key: &'static str,
        original: Option<String>,
    }

    impl EnvVarGuard {
        fn set(key: &'static str, value: &str) -> Self {
            let original = std::env::var(key).ok();
            std::env::set_var(key, value);
            Self { key, original }
        }

        fn unset(key: &'static str) -> Self {
            let original = std::env::var(key).ok();
            std::env::remove_var(key);
            Self { key, original }
        }
    }

    impl Drop for EnvVarGuard {
        fn drop(&mut self) {
            if let Some(value) = &self.original {
                std::env::set_var(self.key, value);
            } else {
                std::env::remove_var(self.key);
            }
        }
    }

    #[test]
    fn map_mod_source_includes_all_supported_sources() {
        assert_eq!(map_mod_source(Some(ModSource::Thunderstore)), "thunderstore");
        assert_eq!(map_mod_source(Some(ModSource::Nexusmods)), "nexusmods");
        assert_eq!(map_mod_source(Some(ModSource::Github)), "github");
        assert_eq!(map_mod_source(Some(ModSource::Local)), "local");
        assert_eq!(map_mod_source(Some(ModSource::Unknown)), "unknown");
        assert_eq!(map_mod_source(None), "unknown");
    }

    #[tokio::test]
    #[serial]
    async fn get_github_service_refreshes_token_changes_without_restart() {
        let temp = tempdir().expect("temp dir");
        let data_dir = temp.path().join("simmrust");
        let _data_guard = EnvVarGuard::set("SIMMRUST_DATA_DIR", data_dir.to_string_lossy().as_ref());
        let _token_guard = EnvVarGuard::unset("GITHUB_TOKEN");

        let pool = initialize_pool().await.expect("pool");
        let settings = SettingsService::new(pool.clone()).expect("settings service");

        let service = get_github_service(pool.clone()).await.expect("github service");
        assert_eq!(service.current_token_for_testing().await, None);

        settings
            .save_github_token("token-one".to_string())
            .await
            .expect("save token");
        let service = get_github_service(pool.clone()).await.expect("github service after save");
        assert_eq!(
            service.current_token_for_testing().await.as_deref(),
            Some("token-one")
        );

        settings.clear_github_token().await.expect("clear token");
        let service = get_github_service(pool.clone()).await.expect("github service after clear");
        assert_eq!(service.current_token_for_testing().await, None);
    }

    #[tokio::test]
    #[serial]
    async fn get_github_service_none_setting_disables_env_token_fallback() {
        let temp = tempdir().expect("temp dir");
        let data_dir = temp.path().join("simmrust");
        let _data_guard = EnvVarGuard::set("SIMMRUST_DATA_DIR", data_dir.to_string_lossy().as_ref());
        let _token_guard = EnvVarGuard::set("GITHUB_TOKEN", "env-token");

        let pool = initialize_pool().await.expect("pool");
        let settings = SettingsService::new(pool.clone()).expect("settings service");
        settings.clear_github_token().await.expect("clear token");

        let service = get_github_service(pool.clone()).await.expect("github service");
        assert_eq!(service.current_token_for_testing().await, None);
    }
}
