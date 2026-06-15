use crate::commands::nexus_mods::normalize_nexus_game_id;
use crate::events;
use crate::services::environment::EnvironmentService;
use crate::services::github_releases::GitHubReleasesService;
use crate::services::mod_update::ModUpdateService;
use crate::services::mods::ModsService;
use crate::services::nexus_mods::NexusModsService;
use crate::services::settings::SettingsService;
use crate::services::thunderstore::ThunderStoreService;
use crate::services::update_check::UpdateCheckService;
use crate::types::{ModMetadata, ModSource, UpdateCheckResult};
use once_cell::sync::Lazy;
use sqlx::SqlitePool;
use std::collections::HashSet;
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

fn build_environment_update_fields_from_result(
    result: &UpdateCheckResult,
) -> Vec<(String, serde_json::Value)> {
    let mut updates = Vec::new();
    updates.push((
        "lastUpdateCheck".to_string(),
        serde_json::json!(result.checked_at.timestamp()),
    ));
    updates.push((
        "updateAvailable".to_string(),
        serde_json::json!(result.update_available),
    ));

    if let Some(ref current_manifest_id) = result.current_manifest_id {
        updates.push((
            "lastManifestId".to_string(),
            serde_json::json!(current_manifest_id),
        ));
    }

    if let Some(ref remote_manifest_id) = result.remote_manifest_id {
        updates.push((
            "remoteManifestId".to_string(),
            serde_json::json!(remote_manifest_id),
        ));
    }

    updates.push((
        "remoteBuildId".to_string(),
        result
            .remote_build_id
            .as_ref()
            .map(|value| serde_json::json!(value))
            .unwrap_or(serde_json::Value::Null),
    ));

    if let Some(ref current_game_version) = result.current_game_version {
        updates.push((
            "currentGameVersion".to_string(),
            serde_json::json!(current_game_version),
        ));
    }

    updates.push((
        "updateGameVersion".to_string(),
        result
            .update_game_version
            .as_ref()
            .map(|value| serde_json::json!(value))
            .unwrap_or(serde_json::Value::Null),
    ));

    updates
}

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
        .filter(|r| {
            r.get("updateAvailable")
                .and_then(|v| v.as_bool())
                .unwrap_or(false)
        })
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

fn extract_package_uuid(package: &serde_json::Value) -> Option<String> {
    for key in ["uuid4", "uuid", "package_uuid", "packageId", "package_id"] {
        if let Some(value) = package.get(key).and_then(|v| v.as_str()) {
            return Some(value.to_string());
        }
    }

    package
        .get("latest")
        .and_then(|v| v.get("uuid4"))
        .and_then(|v| v.as_str())
        .map(|v| v.to_string())
}

fn is_s1api_thunderstore_source_id(source_id: Option<&str>) -> bool {
    matches!(
        source_id.map(|value| value.trim().to_ascii_lowercase()),
        Some(value) if value == "ifbars/s1api" || value == "ifbars/s1api_forked"
    )
}

fn extract_thunderstore_icon(
    package: &serde_json::Value,
    source_id: Option<&str>,
) -> Option<String> {
    select_latest_thunderstore_version(package, source_id)
        .and_then(|v| v.get("icon"))
        .and_then(|v| v.as_str())
        .or_else(|| {
            package
                .get("latest")
                .and_then(|v| v.get("icon"))
                .and_then(|v| v.as_str())
        })
        .or_else(|| package.get("icon").and_then(|v| v.as_str()))
        .or_else(|| package.get("icon_url").and_then(|v| v.as_str()))
        .map(|v| v.to_string())
}

fn extract_numeric_version_parts(value: &str) -> Vec<u32> {
    let mut parts = Vec::new();
    let mut current = String::new();
    let core = value
        .trim_start_matches(['v', 'V'])
        .split(['-', '+'])
        .next()
        .unwrap_or_default();

    for ch in core.chars() {
        if ch.is_ascii_digit() {
            current.push(ch);
        } else if !current.is_empty() {
            parts.push(current.parse::<u32>().unwrap_or(0));
            current.clear();
        }
    }

    if !current.is_empty() {
        parts.push(current.parse::<u32>().unwrap_or(0));
    }

    parts
}

fn compare_standard_thunderstore_versions(left: &str, right: &str) -> std::cmp::Ordering {
    let left_parts = extract_numeric_version_parts(left);
    let right_parts = extract_numeric_version_parts(right);
    let max_len = left_parts.len().max(right_parts.len());

    for index in 0..max_len {
        match left_parts
            .get(index)
            .copied()
            .unwrap_or(0)
            .cmp(&right_parts.get(index).copied().unwrap_or(0))
        {
            std::cmp::Ordering::Equal => continue,
            ordering => return ordering,
        }
    }

    let left_lower = left.to_ascii_lowercase();
    let right_lower = right.to_ascii_lowercase();
    let has_prerelease = |value: &str| {
        [
            "alpha",
            "beta",
            "preview",
            "pre",
            "rc",
            "nightly",
            "experimental",
            "dev",
            "test",
        ]
        .iter()
        .any(|marker| value.contains(marker))
    };

    match (has_prerelease(&left_lower), has_prerelease(&right_lower)) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => left
            .trim_start_matches(['v', 'V'])
            .cmp(right.trim_start_matches(['v', 'V'])),
    }
}

fn compare_s1api_revision_versions(left: &str, right: &str) -> std::cmp::Ordering {
    let expand = |value: &str| {
        let normalized = value.trim_start_matches(['v', 'V']).to_string();
        let core = normalized.split(['-', '+']).next().unwrap_or_default();
        let mut segments = core.split('.').collect::<Vec<_>>();
        if let Some(patch) = segments.get(2).copied() {
            if patch.len() > 1 && patch.chars().all(|ch| ch.is_ascii_digit()) {
                let mut expanded = Vec::with_capacity(segments.len() + 1);
                expanded.extend(segments.iter().take(2).copied());
                expanded.push(&patch[..1]);
                expanded.push(&patch[1..]);
                expanded.extend(segments.iter().skip(3).copied());
                segments = expanded;
            }
        }

        segments
            .into_iter()
            .filter(|segment| !segment.is_empty())
            .map(|segment| segment.parse::<u32>().unwrap_or(0))
            .collect::<Vec<u32>>()
    };

    let left_parts = expand(left);
    let right_parts = expand(right);
    let max_len = left_parts.len().max(right_parts.len());

    for index in 0..max_len {
        match left_parts
            .get(index)
            .copied()
            .unwrap_or(0)
            .cmp(&right_parts.get(index).copied().unwrap_or(0))
        {
            std::cmp::Ordering::Equal => continue,
            ordering => return ordering,
        }
    }

    let left_lower = left.to_ascii_lowercase();
    let right_lower = right.to_ascii_lowercase();
    let has_prerelease = |value: &str| {
        [
            "alpha",
            "beta",
            "preview",
            "pre",
            "rc",
            "nightly",
            "experimental",
            "dev",
            "test",
        ]
        .iter()
        .any(|marker| value.contains(marker))
    };

    match (has_prerelease(&left_lower), has_prerelease(&right_lower)) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => left
            .trim_start_matches(['v', 'V'])
            .cmp(right.trim_start_matches(['v', 'V'])),
    }
}

fn compare_thunderstore_versions(
    source_id: Option<&str>,
    left: &str,
    right: &str,
) -> std::cmp::Ordering {
    if is_s1api_thunderstore_source_id(source_id) {
        return compare_s1api_revision_versions(left, right);
    }

    compare_standard_thunderstore_versions(left, right)
}

fn select_latest_thunderstore_version<'a>(
    package: &'a serde_json::Value,
    source_id: Option<&str>,
) -> Option<&'a serde_json::Value> {
    package
        .get("versions")
        .and_then(|v| v.as_array())
        .and_then(|versions| {
            versions.iter().max_by(|left, right| {
                let left_version = left
                    .get("version_number")
                    .and_then(|v| v.as_str())
                    .unwrap_or_default();
                let right_version = right
                    .get("version_number")
                    .and_then(|v| v.as_str())
                    .unwrap_or_default();

                match compare_thunderstore_versions(source_id, left_version, right_version) {
                    std::cmp::Ordering::Equal => {
                        let left_updated = left
                            .get("date_updated")
                            .or_else(|| left.get("date_created"))
                            .and_then(|v| v.as_str())
                            .unwrap_or_default();
                        let right_updated = right
                            .get("date_updated")
                            .or_else(|| right.get("date_created"))
                            .and_then(|v| v.as_str())
                            .unwrap_or_default();
                        left_updated.cmp(right_updated)
                    }
                    ordering => ordering,
                }
            })
        })
}

async fn resolve_thunderstore_package_by_source_id(
    thunderstore_service: &ThunderStoreService,
    source_id: &str,
) -> Option<serde_json::Value> {
    if let Ok(Some(package)) = thunderstore_service
        .get_package(source_id, Some("schedule-i"))
        .await
    {
        return Some(package);
    }

    let (owner, name) = source_id.split_once('/')?;

    let candidates = thunderstore_service
        .search_packages_filtered_by_runtime("schedule-i", "unknown", Some(name))
        .await
        .ok()?;

    let matching = candidates.into_iter().find(|pkg| {
        let pkg_owner = pkg.get("owner").and_then(|v| v.as_str()).unwrap_or("");
        let pkg_name = pkg.get("name").and_then(|v| v.as_str()).unwrap_or("");
        pkg_owner.eq_ignore_ascii_case(owner) && pkg_name.eq_ignore_ascii_case(name)
    })?;

    let package_uuid = extract_package_uuid(&matching)?;
    thunderstore_service
        .get_package(&package_uuid, Some("schedule-i"))
        .await
        .ok()?
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
    let env = env_service
        .get_environment(&environment_id)
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "Environment not found".to_string())?;

    if !manual {
        let mut settings_service =
            SettingsService::new(db.inner().clone()).map_err(|e| e.to_string())?;
        let settings = settings_service
            .load_settings()
            .await
            .map_err(|e| e.to_string())?;
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
    let result = update_service
        .check_update_for_environment(&env)
        .await
        .map_err(|e| e.to_string())?;

    if let Err(e) = env_service
        .update_environment(
            &environment_id,
            build_environment_update_fields_from_result(&result),
        )
        .await
    {
        log::warn!(
            "[UpdateCheck] Failed to persist update state for environment {}: {:#}",
            environment_id,
            e
        );
    }

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
    let env_service =
        Arc::new(EnvironmentService::new(db.inner().clone()).map_err(|e| e.to_string())?);
    let envs = env_service
        .get_environments()
        .await
        .map_err(|e| e.to_string())?;

    let manual = manual.unwrap_or(false);
    let mut settings_service =
        SettingsService::new(db.inner().clone()).map_err(|e| e.to_string())?;
    let settings = settings_service
        .load_settings()
        .await
        .map_err(|e| e.to_string())?;
    let interval_minutes = settings.update_check_interval.unwrap_or(60) as i64;
    let nexus_game_id = normalize_nexus_game_id(settings.nexus_mods_game_id.as_deref());
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
    let results = update_service
        .check_all_environments(&envs_to_check)
        .await
        .map_err(|e| e.to_string())?;

    // Persist and emit environment update-check results before running the slower mod update scan.
    for (env_id, result) in &results {
        if let Err(e) = env_service
            .update_environment(env_id, build_environment_update_fields_from_result(result))
            .await
        {
            log::warn!(
                "[UpdateCheck] Failed to update environment {}: {:#}",
                env_id,
                e
            );
        }

        let _ = events::emit_update_check_complete(&app, env_id.clone(), result.clone());
        if result.update_available {
            let _ = events::emit_update_available(&app, env_id.clone(), result.clone());
        }
    }

    // Also check tracked library mod updates once, then project the result to installed environments.
    let mod_update_service = get_mod_update_service().await?;
    let mods_service = Arc::new(ModsService::new(db.inner().clone()));
    let thunderstore_service = get_thunderstore_service(db.inner().clone()).await?;
    let nexus_mods_service = get_nexus_mods_service(db.inner().clone()).await?;
    let github_service = get_github_service(db.inner().clone()).await?;

    // Filter to only completed environments and check mod updates in parallel
    let completed_envs: Vec<_> = envs
        .iter()
        .filter(|env| matches!(env.status, crate::types::EnvironmentStatus::Completed))
        .collect();

    let mut seen_storage_ids = HashSet::new();
    let mut library_thunderstore_targets: Vec<(String, String, Option<String>)> = Vec::new();
    if let Ok(library) = mods_service.get_mod_library().await {
        for entry in library.downloaded {
            if !matches!(entry.source, Some(ModSource::Thunderstore)) {
                continue;
            }

            if entry.icon_url.is_some() && entry.icon_cache_path.is_some() {
                continue;
            }

            let Some(source_id) = entry
                .source_id
                .clone()
                .filter(|value| !value.trim().is_empty())
            else {
                continue;
            };

            if seen_storage_ids.insert(entry.storage_id.clone()) {
                library_thunderstore_targets.push((
                    entry.storage_id,
                    source_id,
                    entry.source_version.clone(),
                ));
            }
        }
    }

    let _ = events::emit_mod_metadata_refresh_status(&app, 1);
    match mod_update_service
        .check_library_mod_updates(
            mods_service.as_ref(),
            &thunderstore_service,
            &nexus_mods_service,
            &nexus_game_id,
            &github_service,
        )
        .await
    {
        Ok(mut updates_by_env) => {
            log::info!("[UpdateCheck] Successfully checked tracked library mod updates");
            for env in &completed_envs {
                let updates =
                    build_mod_updates_payload(&updates_by_env.remove(&env.id).unwrap_or_default());
                let count = updates.len();
                let _ = events::emit_mod_updates_checked(&app, env.id.clone(), count, updates);
            }
        }
        Err(e) => {
            log::warn!(
                "[UpdateCheck] Failed to check tracked library mod updates: {}",
                e
            );
        }
    }
    let _ = events::emit_mod_metadata_refresh_status(&app, 0);

    // Backfill missing Thunderstore metadata/icons for downloaded library entries.
    let library_backfill_total = library_thunderstore_targets.len();
    if library_backfill_total > 0 {
        let _ = events::emit_mod_metadata_refresh_status(&app, library_backfill_total);
    }
    for (index, (storage_id, source_id, source_version)) in
        library_thunderstore_targets.into_iter().enumerate()
    {
        if let Some(package) =
            resolve_thunderstore_package_by_source_id(&thunderstore_service, &source_id).await
        {
            let now = chrono::Utc::now();
            let icon_url = extract_thunderstore_icon(&package, Some(&source_id));
            let icon_cache_path = mods_service
                .cache_icon_for_metadata(icon_url.as_deref())
                .await;

            let existing_metadata =
                match mods_service.load_storage_metadata_by_id(&storage_id).await {
                    Ok(existing) => existing,
                    Err(error) => {
                        log::warn!(
                            "[UpdateCheck] Failed to load existing metadata for {}: {}",
                            storage_id,
                            error
                        );
                        continue;
                    }
                };

            let mut metadata_update = existing_metadata.unwrap_or(ModMetadata {
                source: None,
                source_id: None,
                source_version: None,
                author: None,
                mod_name: None,
                source_url: None,
                summary: None,
                icon_url: None,
                icon_cache_path: None,
                downloads: None,
                likes_or_endorsements: None,
                updated_at: None,
                tags: None,
                installed_version: None,
                library_added_at: None,
                installed_at: None,
                last_update_check: None,
                metadata_last_refreshed: None,
                update_available: None,
                remote_version: None,
                detected_runtime: None,
                runtime_match: None,
                mod_storage_id: None,
                managed_paths: None,
                security_scan: None,
            });

            metadata_update.source = Some(ModSource::Thunderstore);
            metadata_update.source_id = Some(source_id.clone());
            if source_version.is_some() {
                metadata_update.source_version = source_version;
            }
            if let Some(author) = package
                .get("owner")
                .and_then(|v| v.as_str())
                .map(|v| v.to_string())
            {
                metadata_update.author = Some(author);
            }
            if let Some(mod_name) = package
                .get("name")
                .and_then(|v| v.as_str())
                .map(|v| v.to_string())
            {
                metadata_update.mod_name = Some(mod_name);
            }
            if let Some(source_url) = package
                .get("package_url")
                .and_then(|v| v.as_str())
                .map(|v| v.to_string())
            {
                metadata_update.source_url = Some(source_url);
            }
            if let Some(summary) = select_latest_thunderstore_version(&package, Some(&source_id))
                .and_then(|v| v.get("description"))
                .and_then(|v| v.as_str())
                .map(|v| v.to_string())
            {
                metadata_update.summary = Some(summary);
            }
            if icon_url.is_some() {
                metadata_update.icon_url = icon_url;
            }
            if icon_cache_path.is_some() {
                metadata_update.icon_cache_path = icon_cache_path;
            }
            if let Some(downloads) =
                package
                    .get("versions")
                    .and_then(|v| v.as_array())
                    .map(|versions| {
                        versions
                            .iter()
                            .map(|ver| ver.get("downloads").and_then(|v| v.as_u64()).unwrap_or(0))
                            .sum::<u64>()
                    })
            {
                metadata_update.downloads = Some(downloads);
            }
            if let Some(likes_or_endorsements) =
                package.get("rating_score").and_then(|v| v.as_i64())
            {
                metadata_update.likes_or_endorsements = Some(likes_or_endorsements);
            }
            if let Some(updated_at) = package
                .get("date_updated")
                .and_then(|v| v.as_str())
                .map(|v| v.to_string())
            {
                metadata_update.updated_at = Some(updated_at);
            }
            if let Some(tags) = package
                .get("categories")
                .and_then(|v| v.as_array())
                .map(|arr| {
                    arr.iter()
                        .filter_map(|v| v.as_str().map(|s| s.to_string()))
                        .collect::<Vec<String>>()
                })
                .filter(|tags| !tags.is_empty())
            {
                metadata_update.tags = Some(tags);
            }
            metadata_update.metadata_last_refreshed = Some(now);
            metadata_update.mod_storage_id = Some(storage_id.clone());

            if let Err(error) = mods_service
                .upsert_storage_metadata_by_id(&storage_id, metadata_update)
                .await
            {
                log::warn!(
                    "[UpdateCheck] Failed to backfill library metadata for {}: {}",
                    storage_id,
                    error
                );
            }
        }

        let remaining = library_backfill_total.saturating_sub(index + 1);
        let _ = events::emit_mod_metadata_refresh_status(&app, remaining);
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
    let env = env_service
        .get_environment(&environment_id)
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
    use super::{
        build_mod_updates_payload, compare_thunderstore_versions, extract_mod_name_for_event,
        get_github_service, select_latest_thunderstore_version,
    };
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
        assert_eq!(
            updates[0].get("modFileName").and_then(|v| v.as_str()),
            Some("A.dll")
        );
        assert_eq!(
            updates[0].get("source").and_then(|v| v.as_str()),
            Some("github")
        );
    }

    #[test]
    fn compare_thunderstore_versions_uses_revision_suffix_ordering_for_s1api() {
        assert_eq!(
            compare_thunderstore_versions(Some("ifBars/S1API"), "3.0.22", "3.0.3"),
            std::cmp::Ordering::Less
        );
        assert_eq!(
            compare_thunderstore_versions(Some("ifBars/S1API"), "3.0.32", "3.0.4"),
            std::cmp::Ordering::Less
        );
        assert_eq!(
            compare_thunderstore_versions(Some("ifBars/S1API"), "3.0.4", "3.0.32"),
            std::cmp::Ordering::Greater
        );
    }

    #[test]
    fn compare_thunderstore_versions_keeps_semver_for_non_s1api_packages() {
        assert_eq!(
            compare_thunderstore_versions(Some("example/mod"), "1.0.9", "1.0.10"),
            std::cmp::Ordering::Less
        );
        assert_eq!(
            compare_thunderstore_versions(Some("example/mod"), "1.0.10", "1.0.9"),
            std::cmp::Ordering::Greater
        );
    }

    #[test]
    fn select_latest_thunderstore_version_uses_revision_suffix_ordering_for_s1api() {
        let package = serde_json::json!({
            "versions": [
                {
                    "uuid4": "r2",
                    "version_number": "3.0.22",
                    "date_updated": "2026-04-01T00:00:00Z"
                },
                {
                    "uuid4": "r3",
                    "version_number": "3.0.3",
                    "date_updated": "2026-04-02T00:00:00Z"
                },
                {
                    "uuid4": "r2-next",
                    "version_number": "3.0.32",
                    "date_updated": "2026-04-03T00:00:00Z"
                },
                {
                    "uuid4": "r4",
                    "version_number": "3.0.4",
                    "date_updated": "2026-04-04T00:00:00Z"
                }
            ]
        });

        let selected = select_latest_thunderstore_version(&package, Some("ifBars/S1API"))
            .expect("selected version");

        assert_eq!(selected.get("uuid4").and_then(|v| v.as_str()), Some("r4"));
    }

    #[test]
    fn select_latest_thunderstore_version_keeps_semver_for_non_s1api_packages() {
        let package = serde_json::json!({
            "versions": [
                {
                    "uuid4": "stable-9",
                    "version_number": "1.0.9",
                    "date_updated": "2026-04-01T00:00:00Z"
                },
                {
                    "uuid4": "stable-10",
                    "version_number": "1.0.10",
                    "date_updated": "2026-04-02T00:00:00Z"
                }
            ]
        });

        let selected = select_latest_thunderstore_version(&package, Some("example/mod"))
            .expect("selected version");

        assert_eq!(
            selected.get("uuid4").and_then(|v| v.as_str()),
            Some("stable-10")
        );
    }
}
