use crate::services::environment::EnvironmentService;
use crate::services::filesystem_watcher::FileSystemWatcherService;
use crate::types::{schedule_i_config, AppConfig, Environment, EnvironmentStatus};
use crate::utils::validation::{
    validate_app_id, validate_branch_name, validate_directory_path, validate_environment_name,
};
use sqlx::SqlitePool;
use std::sync::Arc;
use tauri::{AppHandle, State};
use tokio::sync::Mutex as AsyncMutex;

fn normalize_path(path: &str) -> String {
    let trimmed = path.trim_end_matches(['\\', '/']);
    #[cfg(windows)]
    {
        trimmed.replace('/', "\\").to_ascii_lowercase()
    }
    #[cfg(not(windows))]
    {
        trimmed.to_string()
    }
}

fn environment_status_rank(status: &EnvironmentStatus) -> u8 {
    match status {
        EnvironmentStatus::Completed => 4,
        EnvironmentStatus::Downloading => 3,
        EnvironmentStatus::NotDownloaded => 2,
        EnvironmentStatus::Unavailable => 1,
        EnvironmentStatus::Error => 0,
    }
}

fn should_replace_existing_for_path(existing: &Environment, candidate: &Environment) -> bool {
    let existing_is_steam = existing.environment_type == Some(crate::types::EnvironmentType::Steam)
        || existing.id.starts_with("steam-");
    let candidate_is_steam = candidate.environment_type
        == Some(crate::types::EnvironmentType::Steam)
        || candidate.id.starts_with("steam-");

    if candidate_is_steam != existing_is_steam {
        return candidate_is_steam;
    }

    let existing_rank = environment_status_rank(&existing.status);
    let candidate_rank = environment_status_rank(&candidate.status);
    if candidate_rank != existing_rank {
        return candidate_rank > existing_rank;
    }

    let existing_updated = existing
        .last_updated
        .map(|dt| dt.timestamp())
        .unwrap_or_default();
    let candidate_updated = candidate
        .last_updated
        .map(|dt| dt.timestamp())
        .unwrap_or_default();
    if candidate_updated != existing_updated {
        return candidate_updated > existing_updated;
    }

    candidate.id < existing.id
}

fn parse_updates_object(
    updates: serde_json::Value,
) -> Result<std::collections::HashMap<String, serde_json::Value>, String> {
    if let Some(map) = updates.as_object() {
        Ok(map.iter().map(|(k, v)| (k.clone(), v.clone())).collect())
    } else {
        Err("Updates must be an object".to_string())
    }
}

async fn create_environment_impl(
    db: Arc<SqlitePool>,
    app_id: String,
    branch: String,
    output_dir: String,
    name: Option<String>,
    description: Option<String>,
) -> Result<Environment, String> {
    if !validate_app_id(&app_id) {
        return Err("Invalid AppID format".to_string());
    }

    if !validate_branch_name(&branch) {
        return Err("Invalid branch name".to_string());
    }

    if let Some(ref n) = name {
        if !validate_environment_name(n) {
            return Err("Invalid environment name".to_string());
        }
    }

    let validated_dir = validate_directory_path(&output_dir, None).map_err(|e| e.to_string())?;
    let service = EnvironmentService::new(db).map_err(|e| e.to_string())?;
    service
        .create_environment(app_id, branch, validated_dir, name, description)
        .await
        .map_err(|e| e.to_string())
}

async fn update_environment_impl(
    db: Arc<SqlitePool>,
    id: String,
    updates: serde_json::Value,
) -> Result<Environment, String> {
    let updates_map = parse_updates_object(updates)?;
    let service = EnvironmentService::new(db).map_err(|e| e.to_string())?;
    service
        .update_environment(&id, updates_map)
        .await
        .map_err(|e| e.to_string())
}

async fn delete_environment_impl(
    db: Arc<SqlitePool>,
    id: String,
    delete_files: bool,
) -> Result<bool, String> {
    let service = EnvironmentService::new(db).map_err(|e| e.to_string())?;
    service
        .delete_environment(&id, delete_files)
        .await
        .map_err(|e| e.to_string())
}

/// Start filesystem watchers for an environment's Mods/Plugins/UserLibs (reused by get_environments and create_*).
async fn start_watchers_for_env(
    watcher_guard: &FileSystemWatcherService,
    env_id: &str,
    output_dir: &str,
) {
    let mods_dir = std::path::Path::new(output_dir).join("Mods");
    let plugins_dir = std::path::Path::new(output_dir).join("Plugins");
    let userlibs_dir = std::path::Path::new(output_dir).join("UserLibs");
    let _ = watcher_guard
        .start_watching(env_id, mods_dir.to_str().unwrap_or(""), "mods")
        .await;
    let _ = watcher_guard
        .start_watching(env_id, plugins_dir.to_str().unwrap_or(""), "plugins")
        .await;
    let _ = watcher_guard
        .start_watching(env_id, userlibs_dir.to_str().unwrap_or(""), "userlibs")
        .await;
}

#[tauri::command]
pub async fn get_environments(
    db: State<'_, Arc<SqlitePool>>,
    watcher: State<'_, Arc<AsyncMutex<FileSystemWatcherService>>>,
    app: AppHandle,
) -> Result<Vec<Environment>, String> {
    let service = EnvironmentService::new(db.inner().clone()).map_err(|e| e.to_string())?;
    let mut envs = service
        .get_environments()
        .await
        .map_err(|e| e.to_string())?;

    let steam_service = crate::services::steam::SteamService::new();
    let detected_steam_installation = steam_service
        .detect_steam_installations()
        .await
        .ok()
        .and_then(|installations| installations.into_iter().next());

    // De-duplicate any environments that point to the same install path before
    // attempting status reconciliation/upserts to avoid unique-path write conflicts.
    let mut keeper_by_path: std::collections::HashMap<String, Environment> =
        std::collections::HashMap::new();
    let mut duplicate_ids_to_remove: std::collections::HashSet<String> =
        std::collections::HashSet::new();

    for env in &envs {
        let key = normalize_path(&env.output_dir);
        if let Some(existing) = keeper_by_path.get(&key).cloned() {
            if should_replace_existing_for_path(&existing, env) {
                duplicate_ids_to_remove.insert(existing.id.clone());
                duplicate_ids_to_remove.remove(&env.id);
                keeper_by_path.insert(key, env.clone());
            } else {
                duplicate_ids_to_remove.insert(env.id.clone());
            }
        } else {
            keeper_by_path.insert(key, env.clone());
        }
    }

    if !duplicate_ids_to_remove.is_empty() {
        for duplicate_id in &duplicate_ids_to_remove {
            // App initialization may have armed this raw row before this
            // reconciliation pass.  Remove the watcher before its DB record
            // and snapshot cache disappear.
            let watcher_guard = watcher.lock().await;
            let _ = watcher_guard.stop_watching_environment(duplicate_id).await;
            let _ = service.hard_delete_environment_record(duplicate_id).await;
        }
        envs.retain(|env| !duplicate_ids_to_remove.contains(&env.id));
    }

    for env in envs.iter_mut() {
        let is_steam = env.environment_type == Some(crate::types::EnvironmentType::Steam)
            || env.id.starts_with("steam-");
        if !is_steam {
            continue;
        }

        let is_current_path_valid =
            crate::services::steam::SteamService::validate_steam_installation(
                std::path::Path::new(&env.output_dir),
            )
            .unwrap_or(false);

        if is_current_path_valid {
            let output_path = std::path::Path::new(&env.output_dir);
            let data_dir = output_path.join("Schedule I_Data");
            let has_mono_bleeding_edge = data_dir.join("MonoBleedingEdge").exists();
            let has_il2cpp_data = data_dir.join("il2cpp_data").exists();
            let has_game_assembly = output_path.join("GameAssembly.dll").exists();

            let runtime_from_files =
                crate::services::environment::EnvironmentService::infer_runtime_from_installation_path(
                    output_path,
                );
            let installation = crate::services::steam::SteamInstallation {
                path: env.output_dir.clone(),
                executable_path: output_path
                    .join("Schedule I.exe")
                    .to_string_lossy()
                    .to_string(),
                app_id: crate::services::steam::SteamService::get_steam_app_id(),
                steamapps_dir: env.steamapps_dir.clone(),
                manifest_path: env.steam_manifest_path.clone(),
            };
            let detected_branch = steam_service
                .detect_installed_branch_for_installation(&installation)
                .await
                .ok()
                .flatten()
                .unwrap_or_else(|| {
                    crate::services::environment::EnvironmentService::branch_for_runtime(
                        &runtime_from_files,
                    )
                });
            let detected_runtime =
                crate::services::environment::EnvironmentService::runtime_for_branch(
                    &detected_branch,
                )
                .unwrap_or(runtime_from_files);

            let mut changed = false;
            let mut reconciliation_updates = Vec::new();
            if env.runtime != detected_runtime {
                log::info!(
                    "Steam env {} runtime changed: {:?} -> {:?} (markers: mono_bleeding_edge={}, il2cpp_data={}, gameassembly={})",
                    env.id,
                    env.runtime,
                    detected_runtime,
                    has_mono_bleeding_edge,
                    has_il2cpp_data,
                    has_game_assembly
                );
                env.runtime = detected_runtime;
                reconciliation_updates.push((
                    "runtime".to_string(),
                    serde_json::json!(match env.runtime {
                        crate::types::Runtime::Il2cpp => "IL2CPP",
                        crate::types::Runtime::Mono => "Mono",
                    }),
                ));
                changed = true;
            }

            if env.branch != detected_branch {
                log::info!(
                    "Steam env {} branch changed: {} -> {}",
                    env.id,
                    env.branch,
                    detected_branch
                );
                env.branch = detected_branch;
                reconciliation_updates
                    .push(("branch".to_string(), serde_json::json!(env.branch.clone())));
                changed = true;
            }

            if !matches!(env.status, crate::types::EnvironmentStatus::Completed) {
                env.status = crate::types::EnvironmentStatus::Completed;
                env.last_updated = Some(chrono::Utc::now());
                reconciliation_updates.push(("status".to_string(), serde_json::json!("completed")));
                changed = true;
            }

            if changed {
                if let Err(err) = service
                    .update_environment(&env.id, reconciliation_updates)
                    .await
                {
                    log::warn!(
                        "Failed to persist Steam environment reconciliation for {}: {}",
                        env.id,
                        err
                    );
                }
            }
            continue;
        }

        if let Some(installation) = &detected_steam_installation {
            if normalize_path(&env.output_dir) != normalize_path(&installation.path)
                || !matches!(env.status, crate::types::EnvironmentStatus::Completed)
            {
                let mut reconciliation_updates = Vec::new();
                if env.output_dir != installation.path {
                    env.output_dir = installation.path.clone();
                    reconciliation_updates.push((
                        "outputDir".to_string(),
                        serde_json::json!(env.output_dir.clone()),
                    ));
                }
                if env.steamapps_dir != installation.steamapps_dir {
                    env.steamapps_dir = installation.steamapps_dir.clone();
                    reconciliation_updates.push((
                        "steamappsDir".to_string(),
                        serde_json::json!(env.steamapps_dir.clone()),
                    ));
                }
                if env.steam_manifest_path != installation.manifest_path {
                    env.steam_manifest_path = installation.manifest_path.clone();
                    reconciliation_updates.push((
                        "steamManifestPath".to_string(),
                        serde_json::json!(env.steam_manifest_path.clone()),
                    ));
                }
                let runtime_from_files = crate::services::environment::EnvironmentService::infer_runtime_from_installation_path(
                    std::path::Path::new(&installation.path),
                );
                let detected_branch = steam_service
                    .detect_installed_branch_for_installation(installation)
                    .await
                    .ok()
                    .flatten()
                    .unwrap_or_else(|| {
                        crate::services::environment::EnvironmentService::branch_for_runtime(
                            &runtime_from_files,
                        )
                    });
                let reconciled_runtime =
                    crate::services::environment::EnvironmentService::runtime_for_branch(
                        &detected_branch,
                    )
                    .unwrap_or(runtime_from_files);
                if env.runtime != reconciled_runtime {
                    env.runtime = reconciled_runtime;
                    reconciliation_updates.push((
                        "runtime".to_string(),
                        serde_json::json!(match env.runtime {
                            crate::types::Runtime::Il2cpp => "IL2CPP",
                            crate::types::Runtime::Mono => "Mono",
                        }),
                    ));
                }
                if env.branch != detected_branch {
                    env.branch = detected_branch;
                    reconciliation_updates
                        .push(("branch".to_string(), serde_json::json!(env.branch.clone())));
                }
                if !matches!(env.status, crate::types::EnvironmentStatus::Completed) {
                    env.status = crate::types::EnvironmentStatus::Completed;
                    reconciliation_updates
                        .push(("status".to_string(), serde_json::json!("completed")));
                }
                env.last_updated = Some(chrono::Utc::now());
                if let Err(err) = service
                    .update_environment(&env.id, reconciliation_updates)
                    .await
                {
                    log::warn!(
                        "Failed to persist Steam environment path reconciliation for {}: {}",
                        env.id,
                        err
                    );
                }
            }
        } else if !matches!(env.status, crate::types::EnvironmentStatus::Unavailable) {
            env.status = crate::types::EnvironmentStatus::Unavailable;
            env.last_updated = Some(chrono::Utc::now());
            if let Err(err) = service
                .update_environment(
                    &env.id,
                    vec![("status".to_string(), serde_json::json!("unavailable"))],
                )
                .await
            {
                log::warn!(
                    "Failed to persist Steam environment unavailable status for {}: {}",
                    env.id,
                    err
                );
            }
        }
    }

    let has_steam_env = envs.iter().any(|env| {
        env.environment_type == Some(crate::types::EnvironmentType::Steam)
            || env.id.starts_with("steam-")
    });

    // Auto-detect and create Steam environment only if none exists
    if !has_steam_env {
        if let Some(installation) = detected_steam_installation {
            let steam_env = service
                .create_steam_environment(installation.path, None, None)
                .await;
            if let Ok(env) = steam_env {
                let watcher_guard = watcher.lock().await;
                start_watchers_for_env(&watcher_guard, &env.id, &env.output_dir).await;
                envs.push(env);
                crate::services::runtime_update_scheduler::request_reschedule(&app);
            }
        }
    }

    // Sort environments: Steam environments first, then DepotDownloader
    envs.sort_by(|a, b| {
        let a_is_steam = a.environment_type == Some(crate::types::EnvironmentType::Steam);
        let b_is_steam = b.environment_type == Some(crate::types::EnvironmentType::Steam);
        match (a_is_steam, b_is_steam) {
            (true, false) => std::cmp::Ordering::Less, // Steam comes first
            (false, true) => std::cmp::Ordering::Greater, // Steam comes first
            _ => std::cmp::Ordering::Equal,            // Maintain original order for same type
        }
    });

    Ok(envs)
}

#[tauri::command]
pub async fn get_environment(
    db: State<'_, Arc<SqlitePool>>,
    id: String,
) -> Result<Option<Environment>, String> {
    let service = EnvironmentService::new(db.inner().clone()).map_err(|e| e.to_string())?;
    service
        .get_environment(&id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn create_environment(
    db: State<'_, Arc<SqlitePool>>,
    watcher: State<'_, Arc<AsyncMutex<FileSystemWatcherService>>>,
    app_id: String,
    branch: String,
    output_dir: String,
    name: Option<String>,
    description: Option<String>,
    app: AppHandle,
) -> Result<Environment, String> {
    let env = create_environment_impl(
        db.inner().clone(),
        app_id,
        branch,
        output_dir,
        name,
        description,
    )
    .await?;

    let watcher_guard = watcher.lock().await;
    start_watchers_for_env(&watcher_guard, &env.id, &env.output_dir).await;
    crate::services::runtime_update_scheduler::request_reschedule(&app);

    Ok(env)
}

#[tauri::command]
pub async fn update_environment(
    db: State<'_, Arc<SqlitePool>>,
    id: String,
    updates: serde_json::Value,
    app: AppHandle,
) -> Result<Environment, String> {
    let environment = update_environment_impl(db.inner().clone(), id, updates).await?;
    crate::services::runtime_update_scheduler::request_reschedule(&app);
    Ok(environment)
}

#[tauri::command]
pub async fn delete_environment(
    db: State<'_, Arc<SqlitePool>>,
    watcher: State<'_, Arc<AsyncMutex<FileSystemWatcherService>>>,
    id: String,
    delete_files: Option<bool>,
    app: AppHandle,
) -> Result<bool, String> {
    let service = EnvironmentService::new(db.inner().clone()).map_err(|e| e.to_string())?;
    let existing_env = service
        .get_environment(&id)
        .await
        .map_err(|e| e.to_string())?;
    let is_steam_env = existing_env.as_ref().is_some_and(|env| {
        env.environment_type == Some(crate::types::EnvironmentType::Steam)
            || env.id.starts_with("steam-")
    });

    // Validate before stopping watchers so a rejected destructive request leaves
    // the environment fully operational. The service validates once more just
    // before `remove_dir_all`.
    if delete_files.unwrap_or(false) {
        if let Some(env) = existing_env.as_ref() {
            if !is_steam_env {
                service
                    .validate_environment_file_deletion(env)
                    .await
                    .map_err(|e| e.to_string())?;
            }
        }
    }

    if !is_steam_env {
        // Stop watching directories before deleting non-Steam environments.
        let watcher_guard = watcher.lock().await;
        let _ = watcher_guard.stop_watching_environment(&id).await;
    }

    let deleted = delete_environment_impl(
        db.inner().clone(),
        id.clone(),
        delete_files.unwrap_or(false),
    )
    .await;

    let deleted = match deleted {
        Ok(deleted) => deleted,
        Err(error) => {
            // A pre-commit file/DB failure must not leave a surviving environment
            // unwatched. A post-commit finalization error is also truthful, but its
            // environment row is gone and the staged tree is owned by the durable
            // recovery journal, so never resurrect watchers from the stale snapshot.
            if !is_steam_env {
                if let Ok(Some(env)) = service.get_environment(&id).await {
                    let watcher_guard = watcher.lock().await;
                    start_watchers_for_env(&watcher_guard, &env.id, &env.output_dir).await;
                }
            }
            return Err(error);
        }
    };

    if is_steam_env {
        // Steam delete action clears metadata only; keep watchers active and aligned.
        if let Some(updated_env) = service
            .get_environment(&id)
            .await
            .map_err(|e| e.to_string())?
        {
            let watcher_guard = watcher.lock().await;
            start_watchers_for_env(&watcher_guard, &updated_env.id, &updated_env.output_dir).await;
        }
    }

    crate::services::runtime_update_scheduler::request_reschedule(&app);

    Ok(deleted)
}

#[tauri::command]
pub async fn get_schedule1_config() -> Result<AppConfig, String> {
    Ok(schedule_i_config())
}

#[tauri::command]
pub async fn detect_steam_installations() -> Result<serde_json::Value, String> {
    use crate::services::steam::SteamService;

    let service = SteamService::new();
    let installations = service
        .detect_steam_installations()
        .await
        .map_err(|e| e.to_string())?;

    Ok(serde_json::json!(installations))
}

#[tauri::command]
pub async fn create_steam_environment(
    db: State<'_, Arc<SqlitePool>>,
    watcher: State<'_, Arc<AsyncMutex<FileSystemWatcherService>>>,
    steam_path: String,
    name: Option<String>,
    description: Option<String>,
    app: AppHandle,
) -> Result<Environment, String> {
    let service = EnvironmentService::new(db.inner().clone()).map_err(|e| e.to_string())?;
    let env = service
        .create_steam_environment(steam_path.clone(), name, description)
        .await
        .map_err(|e| e.to_string())?;

    let watcher_guard = watcher.lock().await;
    start_watchers_for_env(&watcher_guard, &env.id, &env.output_dir).await;
    crate::services::runtime_update_scheduler::request_reschedule(&app);

    Ok(env)
}

#[tauri::command]
pub async fn import_local_environment(
    db: State<'_, Arc<SqlitePool>>,
    watcher: State<'_, Arc<AsyncMutex<FileSystemWatcherService>>>,
    local_path: String,
    name: Option<String>,
    description: Option<String>,
    app: AppHandle,
) -> Result<Environment, String> {
    let service = EnvironmentService::new(db.inner().clone()).map_err(|e| e.to_string())?;
    let env = service
        .create_local_environment(local_path, name, description)
        .await
        .map_err(|e| e.to_string())?;

    let watcher_guard = watcher.lock().await;
    start_watchers_for_env(&watcher_guard, &env.id, &env.output_dir).await;
    crate::services::runtime_update_scheduler::request_reschedule(&app);

    Ok(env)
}

#[cfg(test)]
mod tests {
    use super::{
        create_environment_impl, delete_environment_impl, parse_updates_object,
        update_environment_impl,
    };
    use crate::services::environment::EnvironmentService;
    use crate::test_helpers::init_test_pool_with_temp_data_dir;
    use crate::types::schedule_i_config;
    use serial_test::serial;
    use tempfile::tempdir;

    #[test]
    fn parse_updates_object_requires_object_payload() {
        let good = parse_updates_object(serde_json::json!({"name":"New Name"})).expect("map");
        assert_eq!(good.get("name"), Some(&serde_json::json!("New Name")));

        let bad =
            parse_updates_object(serde_json::json!(["not", "object"])).expect_err("expected error");
        assert_eq!(bad, "Updates must be an object");
    }

    #[tokio::test]
    #[serial]
    async fn create_update_delete_environment_impl_roundtrip() {
        let (_temp, _guard, pool) = init_test_pool_with_temp_data_dir().await.expect("pool");
        let env_root = tempdir().expect("env temp");

        let created = create_environment_impl(
            pool.clone(),
            schedule_i_config().app_id,
            "main".to_string(),
            env_root.path().join("env-a").to_string_lossy().to_string(),
            Some("Env A".to_string()),
            Some("desc".to_string()),
        )
        .await
        .expect("create");
        assert_eq!(created.name, "Env A");
        let created_path = std::path::Path::new(&created.output_dir);
        tokio::fs::create_dir_all(created_path.join(".DepotDownloader"))
            .await
            .expect("receipt");
        tokio::fs::write(created_path.join("Schedule I.exe"), b"game")
            .await
            .expect("executable");

        let updated = update_environment_impl(
            pool.clone(),
            created.id.clone(),
            serde_json::json!({"name":"Env A Updated"}),
        )
        .await
        .expect("update");
        assert_eq!(updated.name, "Env A Updated");

        let deleted = delete_environment_impl(pool.clone(), created.id.clone(), true)
            .await
            .expect("delete");
        assert!(deleted);

        let service = EnvironmentService::new(pool.clone()).expect("service");
        let after = service.get_environment(&created.id).await.expect("query");
        assert!(after.is_none());
    }
}
