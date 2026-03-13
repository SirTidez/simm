use crate::commands::nexus_mods::get_valid_nexus_access_token;
use crate::events;
use crate::services::environment::EnvironmentService;
use crate::services::github_releases::GitHubReleasesService;
use crate::services::mod_update::ModUpdateService;
use crate::services::mods::ModsService;
use crate::services::nexus_mods::NexusModsService;
use crate::services::thunderstore::ThunderStoreService;
use crate::types::ModSource;
use once_cell::sync::Lazy;
use sqlx::SqlitePool;
use std::path::Path;
use std::sync::Arc;
use tauri::{AppHandle, State};
use tokio::sync::Mutex as AsyncMutex;

static MOD_UPDATE_SERVICE: Lazy<AsyncMutex<Option<Arc<ModUpdateService>>>> =
    Lazy::new(|| AsyncMutex::new(None));
static THUNDERSTORE_SERVICE: Lazy<AsyncMutex<Option<Arc<ThunderStoreService>>>> =
    Lazy::new(|| AsyncMutex::new(None));
static NEXUS_MODS_SERVICE: Lazy<AsyncMutex<Option<Arc<NexusModsService>>>> =
    Lazy::new(|| AsyncMutex::new(None));
static GITHUB_SERVICE: Lazy<AsyncMutex<Option<Arc<GitHubReleasesService>>>> =
    Lazy::new(|| AsyncMutex::new(None));

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

async fn get_thunderstore_service(db: Arc<SqlitePool>) -> Result<Arc<ThunderStoreService>, String> {
    let _ = db;
    let mut service = THUNDERSTORE_SERVICE.lock().await;
    if service.is_none() {
        *service = Some(Arc::new(ThunderStoreService::new()));
    }
    Ok(service.as_ref().unwrap().clone())
}

async fn get_nexus_mods_service(db: Arc<SqlitePool>) -> Result<Arc<NexusModsService>, String> {
    let _ = db;
    let mut service = NEXUS_MODS_SERVICE.lock().await;
    if service.is_none() {
        *service = Some(Arc::new(NexusModsService::new()));
    }
    Ok(service.as_ref().unwrap().clone())
}

async fn get_github_service(db: Arc<SqlitePool>) -> Result<Arc<GitHubReleasesService>, String> {
    let _ = db;
    let github_service = {
        let mut service = GITHUB_SERVICE.lock().await;
        if service.is_none() {
            *service = Some(Arc::new(GitHubReleasesService::new()));
        }
        service.as_ref().unwrap().clone()
    };
    Ok(github_service)
}

#[tauri::command]
pub async fn check_mod_updates(
    db: State<'_, Arc<SqlitePool>>,
    app: AppHandle,
    environment_id: String,
) -> Result<Vec<serde_json::Value>, String> {
    let mod_update_service = get_mod_update_service().await?;
    let mods_service = ModsService::new(db.inner().clone());
    let env_service = EnvironmentService::new(db.inner().clone()).map_err(|e| e.to_string())?;
    let thunderstore_service = get_thunderstore_service(db.inner().clone()).await?;
    let nexus_mods_service = get_nexus_mods_service(db.inner().clone()).await?;
    let github_service = get_github_service(db.inner().clone()).await?;

    let mut active_count = 0usize;
    if let Ok(Some(env)) = env_service.get_environment(&environment_id).await {
        if !env.output_dir.is_empty() {
            active_count = mods_service
                .list_mods(&env.output_dir)
                .await
                .ok()
                .and_then(|value| {
                    value
                        .get("mods")
                        .and_then(|mods| mods.as_array())
                        .map(|mods| mods.len())
                })
                .unwrap_or(0);
        }
    }

    let _ = events::emit_mod_metadata_refresh_status(&app, active_count);

    let result = mod_update_service
        .check_mod_updates(
            &environment_id,
            &env_service,
            &mods_service,
            &thunderstore_service,
            &nexus_mods_service,
            &github_service,
        )
        .await
        .map_err(|e| e.to_string());

    if let Err(error) = mod_update_service
        .backfill_missing_thunderstore_library_icons(&mods_service, &thunderstore_service)
        .await
    {
        log::warn!(
            "Failed to backfill Thunderstore library icons after mod update check: {}",
            error
        );
    }

    let _ = events::emit_mod_metadata_refresh_status(&app, 0);
    result
}

#[tauri::command]
pub async fn update_mod(
    app: AppHandle,
    db: State<'_, Arc<SqlitePool>>,
    environment_id: String,
    mod_file_name: String,
) -> Result<serde_json::Value, String> {
    let mod_update_service = get_mod_update_service().await?;
    let mods_service = ModsService::new(db.inner().clone());
    let env_service = EnvironmentService::new(db.inner().clone()).map_err(|e| e.to_string())?;
    let thunderstore_service = get_thunderstore_service(db.inner().clone()).await?;
    let nexus_mods_service = get_nexus_mods_service(db.inner().clone()).await?;
    let github_service = get_github_service(db.inner().clone()).await?;
    let nexus_access_token = get_valid_nexus_access_token(db.inner().clone()).await.ok();

    mod_update_service
        .update_mod(
            &app,
            &environment_id,
            &mod_file_name,
            &env_service,
            &mods_service,
            &thunderstore_service,
            &nexus_mods_service,
            nexus_access_token.as_deref(),
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
    use super::get_github_service;
    use super::map_mod_source;
    use crate::db::initialize_pool;
    use crate::types::ModSource;
    use serial_test::serial;
    use std::sync::Arc;
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
        assert_eq!(
            map_mod_source(Some(ModSource::Thunderstore)),
            "thunderstore"
        );
        assert_eq!(map_mod_source(Some(ModSource::Nexusmods)), "nexusmods");
        assert_eq!(map_mod_source(Some(ModSource::Github)), "github");
        assert_eq!(map_mod_source(Some(ModSource::Local)), "local");
        assert_eq!(map_mod_source(Some(ModSource::Unknown)), "unknown");
        assert_eq!(map_mod_source(None), "unknown");
    }

    #[tokio::test]
    #[serial]
    async fn get_github_service_returns_singleton_instance() {
        let temp = tempdir().expect("temp dir");
        let data_dir = temp.path().join("simmrust");
        let _data_guard =
            EnvVarGuard::set("SIMMRUST_DATA_DIR", data_dir.to_string_lossy().as_ref());

        let pool = initialize_pool().await.expect("pool");
        let first = get_github_service(pool.clone())
            .await
            .expect("first service");
        let second = get_github_service(pool.clone())
            .await
            .expect("second service");

        assert!(Arc::ptr_eq(&first, &second));
    }
}
