use crate::services::update_check::UpdateCheckService;
use crate::services::environment::EnvironmentService;
use crate::services::mod_update::ModUpdateService;
use crate::services::mods::ModsService;
use crate::services::thunderstore::ThunderStoreService;
use crate::services::nexus_mods::NexusModsService;
use crate::services::github_releases::GitHubReleasesService;
use crate::services::settings::SettingsService;
use crate::types::UpdateCheckResult;
use crate::events;
use tauri::{AppHandle, State};
use sqlx::SqlitePool;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::collections::HashMap;
use tokio::sync::Mutex as AsyncMutex;
use once_cell::sync::Lazy;

static MOD_UPDATE_SERVICE: Lazy<AsyncMutex<Option<Arc<ModUpdateService>>>> = Lazy::new(|| AsyncMutex::new(None));
static THUNDERSTORE_SERVICE: Lazy<AsyncMutex<Option<Arc<ThunderStoreService>>>> = Lazy::new(|| AsyncMutex::new(None));
static NEXUS_MODS_SERVICE: Lazy<AsyncMutex<Option<Arc<NexusModsService>>>> = Lazy::new(|| AsyncMutex::new(None));
static GITHUB_SERVICE: Lazy<AsyncMutex<Option<Arc<GitHubReleasesService>>>> = Lazy::new(|| AsyncMutex::new(None));

fn extract_mod_name_for_event(result: &serde_json::Value) -> String {
    result
        .get("packageInfo")
        .and_then(|p| p.get("name"))
        .and_then(|v| v.as_str())
        .or_else(|| result.get("modName").and_then(|v| v.as_str()))
        .or_else(|| result.get("modFileName").and_then(|v| v.as_str()))
        .unwrap_or("")
        .to_string()
}

fn build_mod_updates_payload(results: &[serde_json::Value]) -> Vec<serde_json::Value> {
    results
        .iter()
        .filter(|r| r.get("updateAvailable").and_then(|v| v.as_bool()).unwrap_or(false))
        .map(|r| {
            serde_json::json!({
                "modFileName": r.get("modFileName").and_then(|v| v.as_str()).unwrap_or(""),
                "modName": extract_mod_name_for_event(r),
                "currentVersion": r.get("currentVersion").and_then(|v| v.as_str()).unwrap_or(""),
                "latestVersion": r.get("latestVersion").and_then(|v| v.as_str()).unwrap_or(""),
                "source": r.get("source").and_then(|v| v.as_str()).unwrap_or("unknown")
            })
        })
        .collect()
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
    let nexus_service = {
        let mut service = NEXUS_MODS_SERVICE.lock().await;
        if service.is_none() {
            *service = Some(Arc::new(NexusModsService::new()));
        }
        service.as_ref().unwrap().clone()
    };

    let settings_service = SettingsService::new(db).map_err(|e| e.to_string())?;
    match settings_service.get_nexus_mods_api_key().await {
        Ok(Some(api_key)) => nexus_service.set_api_key(api_key).await,
        Ok(None) => nexus_service.clear_api_key().await,
        Err(_) => nexus_service.clear_api_key().await,
    }

    Ok(nexus_service)
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
pub async fn check_update(
    db: State<'_, Arc<SqlitePool>>,
    app: AppHandle,
    environment_id: String,
    manual: Option<bool>,
) -> Result<serde_json::Value, String> {
    let env_service = EnvironmentService::new(db.inner().clone()).map_err(|e| e.to_string())?;
    let manual = manual.unwrap_or(false);
    let env = env_service.get_environment(&environment_id)
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "Environment not found".to_string())?;

    if !manual {
        let mut settings_service = SettingsService::new(db.inner().clone()).map_err(|e| e.to_string())?;
        let settings = settings_service.load_settings().await.map_err(|e| e.to_string())?;
        let interval_minutes = settings.update_check_interval.unwrap_or(60) as i64;
        let now = chrono::Utc::now();
        if let Some(last_check) = env.last_update_check {
            if now.signed_duration_since(last_check).num_minutes() < interval_minutes {
                return serde_json::to_value(UpdateCheckResult {
                    update_available: env.update_available.unwrap_or(false),
                    current_manifest_id: env.last_manifest_id.clone(),
                    remote_manifest_id: env.remote_manifest_id.clone(),
                    remote_build_id: env.remote_build_id.clone(),
                    branch: env.branch.clone(),
                    app_id: env.app_id.clone(),
                    checked_at: last_check,
                    error: None,
                    current_game_version: env.current_game_version.clone(),
                    update_game_version: env.update_game_version.clone(),
                })
                .map_err(|e| e.to_string());
            }
        }
    }

    let update_service = UpdateCheckService::new(db.inner().clone());
    let result = update_service.check_update_for_environment(&env)
        .await
        .map_err(|e| e.to_string())?;

    // Emit update check complete event
    let _ = events::emit_update_check_complete(&app, environment_id.clone(), result.clone());

    // Emit update available event if an update is available
    if result.update_available {
        let _ = events::emit_update_available(&app, environment_id, result.clone());
    }

    serde_json::to_value(result).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn check_all_updates(
    db: State<'_, Arc<SqlitePool>>,
    app: AppHandle,
    manual: Option<bool>,
) -> Result<Vec<serde_json::Value>, String> {
    let env_service = Arc::new(EnvironmentService::new(db.inner().clone()).map_err(|e| e.to_string())?);
    let envs = env_service.get_environments()
        .await
        .map_err(|e| e.to_string())?;

    let manual = manual.unwrap_or(false);
    let mut settings_service = SettingsService::new(db.inner().clone()).map_err(|e| e.to_string())?;
    let settings = settings_service.load_settings().await.map_err(|e| e.to_string())?;
    let interval_minutes = settings.update_check_interval.unwrap_or(60) as i64;
    let now = chrono::Utc::now();
    let envs_to_check: Vec<_> = if manual {
        envs.clone()
    } else {
        envs.iter()
            .filter(|env| {
                env.last_update_check
                    .map(|last| now.signed_duration_since(last).num_minutes() >= interval_minutes)
                    .unwrap_or(true)
            })
            .cloned()
            .collect()
    };

    let update_service = UpdateCheckService::new(db.inner().clone());
    let results = update_service.check_all_environments(&envs_to_check)
        .await
        .map_err(|e| e.to_string())?;

    // Also check mod updates for completed environments (in parallel)
    let mod_update_service = get_mod_update_service().await?;
    let mods_service = Arc::new(ModsService::new(db.inner().clone()));
    let thunderstore_service = get_thunderstore_service(db.inner().clone()).await?;
    let nexus_mods_service = get_nexus_mods_service(db.inner().clone()).await?;
    let github_service = get_github_service(db.inner().clone()).await?;

    // Filter to only completed environments and check mod updates in parallel
    let completed_envs: Vec<_> = envs.iter()
        .filter(|env| matches!(env.status, crate::types::EnvironmentStatus::Completed))
        .collect();

    let mut env_mod_counts: HashMap<String, usize> = HashMap::new();
    let mut total_mods_refreshing = 0usize;
    for env in &completed_envs {
        let count = match mods_service.list_mods(&env.output_dir).await {
            Ok(value) => value
                .get("mods")
                .and_then(|m| m.as_array())
                .map(|m| m.len())
                .unwrap_or(0),
            Err(_) => 0,
        };
        env_mod_counts.insert(env.id.clone(), count);
        total_mods_refreshing = total_mods_refreshing.saturating_add(count);
    }

    let refresh_counter = Arc::new(AtomicUsize::new(total_mods_refreshing));
    let _ = events::emit_mod_metadata_refresh_status(&app, total_mods_refreshing);

    // Check mod updates for all completed environments in parallel
    let app_handle = app.clone();
    let mod_update_tasks: Vec<_> = completed_envs.iter().map(|env| {
        let env_id = env.id.clone();
        let env_mod_count = env_mod_counts.get(&env.id).copied().unwrap_or(0);
        let app = app_handle.clone();
        let mod_update_service = mod_update_service.clone();
        let mods_service = mods_service.clone();
        let env_service = env_service.clone();
        let thunderstore_service = thunderstore_service.clone();
        let nexus_mods_service = nexus_mods_service.clone();
        let github_service = github_service.clone();
        let refresh_counter = refresh_counter.clone();

        tokio::spawn(async move {
            match mod_update_service.check_mod_updates(
                &env_id,
                env_service.as_ref(),
                mods_service.as_ref(),
                &thunderstore_service,
                &nexus_mods_service,
                &github_service,
            )
            .await {
                Ok(results) => {
                    eprintln!("[UpdateCheck] Successfully checked mod updates for environment {}", env_id);
                    // Build minimal payload for mods that need updating
                    let updates = build_mod_updates_payload(&results);
                    let count = updates.len();
                    let _ = events::emit_mod_updates_checked(&app, env_id, count, updates);
                }
                Err(e) => {
                    // Log but don't fail - mod updates are nice to have but not critical
                    eprintln!("[UpdateCheck] Failed to check mod updates for environment {}: {}", env_id, e);
                }
            }

            let remaining = loop {
                let current = refresh_counter.load(Ordering::SeqCst);
                let next = current.saturating_sub(env_mod_count);
                if refresh_counter
                    .compare_exchange(current, next, Ordering::SeqCst, Ordering::SeqCst)
                    .is_ok()
                {
                    break next;
                }
            };
            let _ = events::emit_mod_metadata_refresh_status(&app, remaining);
        })
    }).collect();

    // Wait for all mod update checks to complete (but don't fail if they error)
    for task in mod_update_tasks {
        let _ = task.await;
    }

    // Update environments with the results and emit events
    for (env_id, result) in &results {
        let mut updates = Vec::new();
        updates.push(("lastUpdateCheck".to_string(), serde_json::json!(result.checked_at.timestamp())));
        updates.push(("updateAvailable".to_string(), serde_json::json!(result.update_available)));

        if let Some(ref remote_manifest_id) = result.remote_manifest_id {
            updates.push(("remoteManifestId".to_string(), serde_json::json!(remote_manifest_id)));
        }

        if let Some(ref remote_build_id) = result.remote_build_id {
            updates.push(("remoteBuildId".to_string(), serde_json::json!(remote_build_id)));
        }

        if let Some(ref current_game_version) = result.current_game_version {
            updates.push(("currentGameVersion".to_string(), serde_json::json!(current_game_version)));
        }

        if let Some(ref update_game_version) = result.update_game_version {
            updates.push(("updateGameVersion".to_string(), serde_json::json!(update_game_version)));
        }

        // Update the environment
        if let Err(e) = env_service.update_environment(env_id, updates).await {
            eprintln!("[UpdateCheck] Failed to update environment {}: {:#}", env_id, e);
        }

        // Emit update check complete event
        let _ = events::emit_update_check_complete(&app, env_id.clone(), result.clone());

        // Emit update available event if an update is available
        if result.update_available {
            let _ = events::emit_update_available(&app, env_id.clone(), result.clone());
        }
    }

    let mut response = Vec::new();
    for (env_id, result) in results {
        // Flatten the result to match frontend expectations: { environmentId, ...UpdateCheckResult }
        response.push(serde_json::json!({
            "environmentId": env_id,
            "updateAvailable": result.update_available,
            "currentManifestId": result.current_manifest_id,
            "remoteManifestId": result.remote_manifest_id,
            "remoteBuildId": result.remote_build_id,
            "branch": result.branch,
            "appId": result.app_id,
            "checkedAt": result.checked_at.timestamp(),
            "error": result.error,
            "currentGameVersion": result.current_game_version,
            "updateGameVersion": result.update_game_version,
        }));
    }

    Ok(response)
}

#[tauri::command]
pub async fn get_update_status(
    db: State<'_, Arc<SqlitePool>>,
    environment_id: String,
) -> Result<serde_json::Value, String> {
    let env_service = EnvironmentService::new(db.inner().clone()).map_err(|e| e.to_string())?;
    let env = env_service.get_environment(&environment_id)
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "Environment not found".to_string())?;

    Ok(serde_json::json!({
        "updateAvailable": env.update_available.unwrap_or(false),
        "lastUpdateCheck": env.last_update_check,
        "remoteManifestId": env.remote_manifest_id,
        "remoteBuildId": env.remote_build_id,
        "currentManifestId": env.last_manifest_id
    }))
}

#[cfg(test)]
mod tests {
    use super::{build_mod_updates_payload, extract_mod_name_for_event, get_github_service};
    use crate::db::initialize_pool;
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

    #[tokio::test]
    #[serial]
    async fn get_github_service_returns_singleton_instance() {
        let temp = tempdir().expect("temp dir");
        let data_dir = temp.path().join("simmrust");
        let _data_guard = EnvVarGuard::set("SIMMRUST_DATA_DIR", data_dir.to_string_lossy().as_ref());

        let pool = initialize_pool().await.expect("pool");
        let first = get_github_service(pool.clone()).await.expect("first service");
        let second = get_github_service(pool.clone()).await.expect("second service");

        assert!(Arc::ptr_eq(&first, &second));
    }

    #[test]
    fn extract_mod_name_for_event_prefers_package_then_mod_name_then_file_name() {
        let from_package = serde_json::json!({
            "packageInfo": {"name": "Pkg Name"},
            "modName": "Meta Name",
            "modFileName": "File.dll"
        });
        assert_eq!(extract_mod_name_for_event(&from_package), "Pkg Name");

        let from_meta = serde_json::json!({
            "modName": "Meta Name",
            "modFileName": "File.dll"
        });
        assert_eq!(extract_mod_name_for_event(&from_meta), "Meta Name");

        let from_file = serde_json::json!({
            "modFileName": "File.dll"
        });
        assert_eq!(extract_mod_name_for_event(&from_file), "File.dll");
    }

    #[test]
    fn build_mod_updates_payload_only_includes_available_updates() {
        let results = vec![
            serde_json::json!({
                "modFileName": "A.dll",
                "modName": "A",
                "updateAvailable": true,
                "currentVersion": "1.0.0",
                "latestVersion": "1.1.0",
                "source": "github"
            }),
            serde_json::json!({
                "modFileName": "B.dll",
                "modName": "B",
                "updateAvailable": false,
                "currentVersion": "1.0.0",
                "latestVersion": "1.0.0",
                "source": "thunderstore"
            }),
        ];

        let updates = build_mod_updates_payload(&results);
        assert_eq!(updates.len(), 1);
        assert_eq!(updates[0].get("modFileName").and_then(|v| v.as_str()), Some("A.dll"));
        assert_eq!(updates[0].get("source").and_then(|v| v.as_str()), Some("github"));
    }
}
