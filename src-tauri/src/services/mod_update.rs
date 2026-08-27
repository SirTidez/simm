use crate::services::environment::EnvironmentService;
use crate::services::github_releases::GitHubReleasesService;
use crate::services::mods::ModsService;
use crate::services::nexus_mods::NexusModsService;
use crate::services::thunderstore::ThunderStoreService;
use anyhow::{Context, Result};
use serde_json::Value;
use std::cmp::Ordering;
use std::collections::{HashMap, HashSet};
use std::path::Path;
use tauri::{AppHandle, Runtime};

#[derive(Clone)]
pub struct ModUpdateService;

enum ProviderUpdateInstallResult {
    Installed {
        response: serde_json::Value,
        report: Option<crate::types::SecurityScanReport>,
    },
    EarlyResponse(serde_json::Value),
}

#[derive(Clone)]
struct ManagedLibraryUpdateCandidate {
    file_name: String,
    storage_id: String,
    metadata: crate::types::ModMetadata,
}

impl ModUpdateService {
    pub fn new() -> Self {
        Self
    }

    fn cached_update_check_result(
        file_name: &str,
        metadata: &crate::types::ModMetadata,
        source: &str,
    ) -> Option<serde_json::Value> {
        if metadata.update_available != Some(true) {
            return None;
        }

        Some(serde_json::json!({
            "modFileName": file_name,
            "modName": metadata.mod_name.clone().unwrap_or_else(|| file_name.to_string()),
            "updateAvailable": true,
            "currentVersion": metadata.source_version.clone().or_else(|| metadata.installed_version.clone()).unwrap_or_default(),
            "latestVersion": metadata.remote_version.clone().unwrap_or_default(),
            "source": source,
        }))
    }

    fn recent_update_check_is_reusable(
        metadata: &crate::types::ModMetadata,
        now: chrono::DateTime<chrono::Utc>,
    ) -> bool {
        metadata
            .last_update_check
            .is_some_and(|checked_at| now.signed_duration_since(checked_at).num_minutes() < 60)
            && metadata
                .remote_version
                .as_deref()
                .is_some_and(|value| !value.is_empty())
    }

    fn sync_refreshed_metadata_fields(
        target: &mut crate::types::ModMetadata,
        updated: &crate::types::ModMetadata,
    ) {
        target.last_update_check = updated.last_update_check;
        target.update_available = updated.update_available;
        target.remote_version = updated.remote_version.clone();
        target.summary = updated.summary.clone();
        target.icon_url = updated.icon_url.clone();
        target.icon_cache_path = updated.icon_cache_path.clone();
        target.downloads = updated.downloads;
        target.likes_or_endorsements = updated.likes_or_endorsements;
        target.updated_at = updated.updated_at.clone();
        target.tags = updated.tags.clone();
        target.metadata_last_refreshed = updated.metadata_last_refreshed;
    }

    fn representative_library_entry_path(
        entry: &crate::types::ModLibraryEntry,
        runtime_label: &str,
    ) -> String {
        entry
            .files_by_runtime
            .get(runtime_label)
            .and_then(|files| files.first())
            .or_else(|| entry.files.first())
            .or_else(|| entry.attached_userlibs.first())
            .or_else(|| entry.attached_userdata.first())
            .cloned()
            .unwrap_or_else(|| entry.display_name.clone())
    }

    fn build_managed_library_update_candidates(
        library: &crate::types::ModLibraryResult,
        environment_id: &str,
        runtime_label: &str,
        processed_storage_ids: &HashSet<String>,
    ) -> Vec<ManagedLibraryUpdateCandidate> {
        let mut seen_storage_ids = processed_storage_ids.clone();
        let mut candidates = Vec::new();

        for entry in &library.downloaded {
            if !entry.managed {
                continue;
            }

            let installed_for_runtime = entry
                .installed_in_by_runtime
                .get(runtime_label)
                .map(|env_ids| env_ids.iter().any(|env_id| env_id == environment_id))
                .unwrap_or_else(|| {
                    entry
                        .installed_in
                        .iter()
                        .any(|env_id| env_id == environment_id)
                });
            if !installed_for_runtime {
                continue;
            }

            let storage_id = entry
                .storage_ids_by_runtime
                .get(runtime_label)
                .cloned()
                .unwrap_or_else(|| entry.storage_id.clone());
            if storage_id.trim().is_empty() || !seen_storage_ids.insert(storage_id.clone()) {
                continue;
            }

            let Some(source) = entry.source.clone() else {
                continue;
            };
            let Some(source_id) = entry
                .source_id
                .clone()
                .filter(|value| !value.trim().is_empty())
            else {
                continue;
            };

            let metadata = crate::types::ModMetadata {
                source: Some(source),
                source_id: Some(source_id),
                source_version: entry.source_version.clone(),
                author: entry.author.clone(),
                mod_name: Some(entry.display_name.clone()),
                source_url: entry.source_url.clone(),
                summary: entry.summary.clone(),
                icon_url: entry.icon_url.clone(),
                icon_cache_path: entry.icon_cache_path.clone(),
                downloads: entry.downloads,
                likes_or_endorsements: entry.likes_or_endorsements,
                updated_at: entry.updated_at.clone(),
                tags: entry.tags.clone(),
                installed_version: entry.installed_version.clone(),
                library_added_at: entry.library_added_at,
                installed_at: entry.installed_at,
                last_update_check: None,
                metadata_last_refreshed: None,
                update_available: entry.update_available,
                remote_version: entry.remote_version.clone(),
                detected_runtime: match runtime_label {
                    "IL2CPP" => Some(crate::types::Runtime::Il2cpp),
                    "Mono" => Some(crate::types::Runtime::Mono),
                    _ => None,
                },
                runtime_match: None,
                mod_storage_id: Some(storage_id.clone()),
                managed_paths: None,
                security_scan: entry.security_scan.clone(),
            };

            candidates.push(ManagedLibraryUpdateCandidate {
                file_name: Self::representative_library_entry_path(entry, runtime_label),
                storage_id,
                metadata,
            });
        }

        candidates
    }

    pub async fn check_library_mod_updates(
        &self,
        mods_service: &ModsService,
        thunderstore_service: &ThunderStoreService,
        nexus_mods_service: &NexusModsService,
        nexus_game_id: &str,
        github_service: &GitHubReleasesService,
    ) -> Result<HashMap<String, Vec<serde_json::Value>>> {
        use crate::types::{ModMetadata, ModSource, Runtime};
        use chrono::Utc;

        let library = mods_service.get_mod_library().await?;
        let mut updates_by_env: HashMap<String, Vec<serde_json::Value>> = HashMap::new();
        let mut update_results_by_storage_id: HashMap<String, Option<serde_json::Value>> =
            HashMap::new();
        let now = Utc::now();

        for entry in &library.downloaded {
            if !entry.managed {
                continue;
            }

            let mut runtime_storage_pairs: Vec<(String, String)> = entry
                .storage_ids_by_runtime
                .iter()
                .map(|(runtime, storage_id)| (runtime.clone(), storage_id.clone()))
                .collect();
            if runtime_storage_pairs.is_empty() {
                runtime_storage_pairs.push((
                    entry
                        .available_runtimes
                        .first()
                        .cloned()
                        .unwrap_or_else(|| "Unknown".to_string()),
                    entry.storage_id.clone(),
                ));
            }

            for (runtime_label, storage_id) in runtime_storage_pairs {
                if storage_id.trim().is_empty() {
                    continue;
                }

                let maybe_result = if let Some(cached_result) =
                    update_results_by_storage_id.get(&storage_id)
                {
                    cached_result.clone()
                } else {
                    let storage_metadata = mods_service
                        .load_storage_metadata_by_id(&storage_id)
                        .await?
                        .unwrap_or_else(|| ModMetadata {
                            source: entry.source.clone(),
                            source_id: entry.source_id.clone(),
                            source_version: entry.source_version.clone(),
                            author: entry.author.clone(),
                            mod_name: Some(entry.display_name.clone()),
                            source_url: entry.source_url.clone(),
                            summary: entry.summary.clone(),
                            icon_url: entry.icon_url.clone(),
                            icon_cache_path: entry.icon_cache_path.clone(),
                            downloads: entry.downloads,
                            likes_or_endorsements: entry.likes_or_endorsements,
                            updated_at: entry.updated_at.clone(),
                            tags: entry.tags.clone(),
                            installed_version: entry.installed_version.clone(),
                            library_added_at: entry.library_added_at,
                            installed_at: entry.installed_at,
                            last_update_check: None,
                            metadata_last_refreshed: None,
                            update_available: entry.update_available,
                            remote_version: entry.remote_version.clone(),
                            detected_runtime: match runtime_label.as_str() {
                                "IL2CPP" => Some(Runtime::Il2cpp),
                                "Mono" => Some(Runtime::Mono),
                                _ => None,
                            },
                            runtime_match: None,
                            mod_storage_id: Some(storage_id.clone()),
                            managed_paths: None,
                            security_scan: entry.security_scan.clone(),
                        });
                    let Some(source) = storage_metadata.source.clone() else {
                        update_results_by_storage_id.insert(storage_id.clone(), None);
                        continue;
                    };
                    if matches!(source, ModSource::Local | ModSource::Unknown) {
                        update_results_by_storage_id.insert(storage_id.clone(), None);
                        continue;
                    }
                    let Some(source_id) = storage_metadata
                        .source_id
                        .clone()
                        .filter(|value| !value.trim().is_empty())
                    else {
                        update_results_by_storage_id.insert(storage_id.clone(), None);
                        continue;
                    };

                    let metadata = ModMetadata {
                        source: Some(source.clone()),
                        source_id: Some(source_id.clone()),
                        source_version: storage_metadata.source_version.clone(),
                        author: storage_metadata
                            .author
                            .clone()
                            .or_else(|| entry.author.clone()),
                        mod_name: storage_metadata
                            .mod_name
                            .clone()
                            .or_else(|| Some(entry.display_name.clone())),
                        source_url: storage_metadata
                            .source_url
                            .clone()
                            .or_else(|| entry.source_url.clone()),
                        summary: storage_metadata
                            .summary
                            .clone()
                            .or_else(|| entry.summary.clone()),
                        icon_url: storage_metadata
                            .icon_url
                            .clone()
                            .or_else(|| entry.icon_url.clone()),
                        icon_cache_path: storage_metadata
                            .icon_cache_path
                            .clone()
                            .or_else(|| entry.icon_cache_path.clone()),
                        downloads: storage_metadata.downloads.or(entry.downloads),
                        likes_or_endorsements: storage_metadata
                            .likes_or_endorsements
                            .or(entry.likes_or_endorsements),
                        updated_at: storage_metadata
                            .updated_at
                            .clone()
                            .or_else(|| entry.updated_at.clone()),
                        tags: storage_metadata.tags.clone().or_else(|| entry.tags.clone()),
                        installed_version: storage_metadata
                            .installed_version
                            .clone()
                            .or_else(|| entry.installed_version.clone()),
                        library_added_at: storage_metadata
                            .library_added_at
                            .or(entry.library_added_at),
                        installed_at: storage_metadata.installed_at.or(entry.installed_at),
                        last_update_check: storage_metadata.last_update_check,
                        metadata_last_refreshed: storage_metadata.metadata_last_refreshed,
                        update_available: storage_metadata
                            .update_available
                            .or(entry.update_available),
                        remote_version: storage_metadata
                            .remote_version
                            .clone()
                            .or_else(|| entry.remote_version.clone()),
                        detected_runtime: match runtime_label.as_str() {
                            "IL2CPP" => Some(Runtime::Il2cpp),
                            "Mono" => Some(Runtime::Mono),
                            _ => None,
                        },
                        runtime_match: None,
                        mod_storage_id: Some(storage_id.clone()),
                        managed_paths: storage_metadata.managed_paths.clone(),
                        security_scan: storage_metadata
                            .security_scan
                            .clone()
                            .or_else(|| entry.security_scan.clone()),
                    };

                    let (updated_metadata, maybe_result) = self
                        .refresh_update_metadata(
                            &Self::representative_library_entry_path(entry, &runtime_label),
                            metadata,
                            &runtime_label,
                            now,
                            mods_service,
                            thunderstore_service,
                            nexus_mods_service,
                            nexus_game_id,
                            github_service,
                        )
                        .await?;

                    if let Err(error) = mods_service
                        .upsert_storage_metadata_by_id(&storage_id, updated_metadata)
                        .await
                    {
                        log::warn!(
                            "Failed to sync library update metadata to storage {}: {}",
                            storage_id,
                            error
                        );
                    }

                    update_results_by_storage_id.insert(storage_id.clone(), maybe_result.clone());
                    maybe_result
                };

                let Some(result) = maybe_result else {
                    continue;
                };
                if result
                    .get("updateAvailable")
                    .and_then(|value| value.as_bool())
                    != Some(true)
                {
                    continue;
                }

                let installed_envs = entry
                    .installed_in_by_runtime
                    .get(&runtime_label)
                    .filter(|envs| !envs.is_empty())
                    .cloned()
                    .unwrap_or_else(|| entry.installed_in.clone());

                for environment_id in installed_envs {
                    updates_by_env
                        .entry(environment_id)
                        .or_default()
                        .push(result.clone());
                }
            }
        }

        Ok(updates_by_env)
    }

    async fn refresh_update_metadata(
        &self,
        file_name: &str,
        mut metadata: crate::types::ModMetadata,
        runtime_label: &str,
        now: chrono::DateTime<chrono::Utc>,
        mods_service: &ModsService,
        thunderstore_service: &ThunderStoreService,
        nexus_mods_service: &NexusModsService,
        nexus_game_id: &str,
        github_service: &GitHubReleasesService,
    ) -> Result<(crate::types::ModMetadata, Option<serde_json::Value>)> {
        use crate::types::ModSource;

        let source = metadata.source.clone();
        let source_id = metadata.source_id.clone();
        let current_version = metadata.source_version.clone();

        let result = if let Some(ModSource::Thunderstore) = source {
            if let Some(source_id) = source_id {
                metadata.last_update_check = Some(now);

                if let Ok((_, package)) = self
                    .resolve_thunderstore_package(
                        thunderstore_service,
                        &source_id,
                        Some(runtime_label),
                    )
                    .await
                {
                    if let Some(latest_package_version) =
                        Self::select_latest_thunderstore_version(&package, Some(&source_id), None)
                    {
                        let latest_version = latest_package_version
                            .get("version_number")
                            .and_then(|v| v.as_str())
                            .map(|s| s.to_string())
                            .unwrap_or_default();
                        let update_available = Self::versions_differ_for_thunderstore(
                            Some(&source_id),
                            current_version.as_deref(),
                            &latest_version,
                        );

                        metadata.update_available = Some(update_available);
                        metadata.remote_version = Some(latest_version.clone());
                        metadata.summary = latest_package_version
                            .get("description")
                            .and_then(|v| v.as_str())
                            .map(|s| s.to_string())
                            .or_else(|| {
                                package
                                    .get("latest")
                                    .and_then(|v| v.get("description"))
                                    .and_then(|v| v.as_str())
                                    .map(|s| s.to_string())
                            });
                        metadata.icon_url = Self::extract_package_icon(&package, Some(&source_id));
                        metadata.icon_cache_path = mods_service
                            .cache_icon_for_metadata(metadata.icon_url.as_deref())
                            .await
                            .or_else(|| metadata.icon_cache_path.clone());
                        metadata.downloads = package
                            .get("versions")
                            .and_then(|v| v.as_array())
                            .map(|versions| {
                                versions
                                    .iter()
                                    .map(|ver| {
                                        ver.get("downloads").and_then(|v| v.as_u64()).unwrap_or(0)
                                    })
                                    .sum::<u64>()
                            });
                        metadata.likes_or_endorsements =
                            package.get("rating_score").and_then(|v| v.as_i64());
                        metadata.updated_at = package
                            .get("date_updated")
                            .and_then(|v| v.as_str())
                            .map(|s| s.to_string());
                        metadata.tags = package
                            .get("categories")
                            .and_then(|v| v.as_array())
                            .map(|arr| {
                                arr.iter()
                                    .filter_map(|v| v.as_str().map(|s| s.to_string()))
                                    .collect::<Vec<String>>()
                            })
                            .filter(|tags| !tags.is_empty());
                        metadata.metadata_last_refreshed = Some(now);

                        Some(serde_json::json!({
                            "modFileName": file_name,
                            "updateAvailable": update_available,
                            "currentVersion": current_version,
                            "latestVersion": latest_version,
                            "source": "thunderstore",
                            "packageInfo": package
                        }))
                    } else {
                        metadata.update_available = Some(false);
                        None
                    }
                } else {
                    None
                }
            } else {
                None
            }
        } else if let Some(ModSource::Nexusmods) = source {
            if let Some(mod_id_str) = source_id {
                if Self::recent_update_check_is_reusable(&metadata, now) {
                    let cached =
                        Self::cached_update_check_result(file_name, &metadata, "nexusmods");
                    return Ok((metadata, cached));
                }

                metadata.last_update_check = Some(now);

                if let Ok(mod_id) = mod_id_str.parse::<u32>() {
                    if let Ok(mod_info) = nexus_mods_service.get_mod(nexus_game_id, mod_id).await {
                        let latest_version = nexus_mods_service
                            .get_mod_files(nexus_game_id, mod_id)
                            .await
                            .ok()
                            .and_then(|files| {
                                Self::select_best_nexus_file_for_update(
                                    &files,
                                    runtime_label,
                                    current_version.as_deref(),
                                )
                            })
                            .and_then(|file| {
                                file.get("version")
                                    .or_else(|| file.get("mod_version"))
                                    .and_then(|v| v.as_str())
                                    .map(|s| s.to_string())
                            })
                            .or_else(|| {
                                mod_info
                                    .get("version")
                                    .and_then(|v| v.as_str())
                                    .map(|s| s.to_string())
                            });

                        if let Some(latest_version) = latest_version {
                            let update_available =
                                Self::versions_differ(current_version.as_deref(), &latest_version);

                            metadata.update_available = Some(update_available);
                            metadata.remote_version = Some(latest_version.clone());
                            metadata.summary = mod_info
                                .get("summary")
                                .and_then(|v| v.as_str())
                                .map(|s| s.to_string());
                            metadata.icon_url = mod_info
                                .get("picture_url")
                                .or_else(|| mod_info.get("pictureUrl"))
                                .and_then(|v| v.as_str())
                                .map(|s| s.to_string());
                            metadata.icon_cache_path = mods_service
                                .cache_icon_for_metadata(metadata.icon_url.as_deref())
                                .await
                                .or_else(|| metadata.icon_cache_path.clone());
                            metadata.downloads = mod_info
                                .get("mod_downloads")
                                .or_else(|| mod_info.get("downloads"))
                                .and_then(|v| v.as_u64());
                            metadata.likes_or_endorsements = mod_info
                                .get("endorsement_count")
                                .or_else(|| mod_info.get("endorsements"))
                                .and_then(|v| v.as_i64());
                            metadata.updated_at = mod_info
                                .get("updated_at")
                                .or_else(|| mod_info.get("updatedAt"))
                                .and_then(|v| v.as_str())
                                .map(|s| s.to_string());
                            metadata.metadata_last_refreshed = Some(now);

                            Some(serde_json::json!({
                                "modFileName": file_name,
                                "updateAvailable": update_available,
                                "currentVersion": current_version,
                                "latestVersion": latest_version,
                                "source": "nexusmods",
                                "packageInfo": mod_info
                            }))
                        } else {
                            metadata.update_available = Some(false);
                            None
                        }
                    } else {
                        None
                    }
                } else {
                    None
                }
            } else {
                None
            }
        } else if let Some(ModSource::Github) = source {
            if let Some(repo) = source_id {
                metadata.last_update_check = Some(now);

                let parts: Vec<&str> = repo.split('/').collect();
                if parts.len() == 2 {
                    let owner = parts[0];
                    let repo_name = parts[1];

                    if let Ok(Some(latest_release)) = github_service
                        .get_latest_release(owner, repo_name, false)
                        .await
                    {
                        if let Some(latest_version) = latest_release
                            .get("tag_name")
                            .and_then(|v| v.as_str())
                            .map(|s| s.to_string())
                        {
                            let update_available =
                                Self::versions_differ(current_version.as_deref(), &latest_version);

                            metadata.update_available = Some(update_available);
                            metadata.remote_version = Some(latest_version.clone());
                            metadata.summary = latest_release
                                .get("body")
                                .and_then(|v| v.as_str())
                                .map(|s| s.to_string());
                            metadata.icon_cache_path = mods_service
                                .cache_icon_for_metadata(metadata.icon_url.as_deref())
                                .await
                                .or_else(|| metadata.icon_cache_path.clone());
                            metadata.updated_at = latest_release
                                .get("published_at")
                                .or_else(|| latest_release.get("created_at"))
                                .and_then(|v| v.as_str())
                                .map(|s| s.to_string());
                            metadata.metadata_last_refreshed = Some(now);

                            Some(serde_json::json!({
                                "modFileName": file_name,
                                "modName": metadata.mod_name.clone().unwrap_or_else(|| file_name.to_string()),
                                "updateAvailable": update_available,
                                "currentVersion": current_version,
                                "latestVersion": latest_version,
                                "source": "github",
                                "packageInfo": latest_release
                            }))
                        } else {
                            metadata.update_available = Some(false);
                            None
                        }
                    } else {
                        None
                    }
                } else {
                    None
                }
            } else {
                None
            }
        } else {
            None
        };

        Ok((metadata, result))
    }

    pub async fn check_mod_updates(
        &self,
        environment_id: &str,
        env_service: &EnvironmentService,
        mods_service: &ModsService,
        thunderstore_service: &ThunderStoreService,
        nexus_mods_service: &NexusModsService,
        nexus_game_id: &str,
        github_service: &GitHubReleasesService,
    ) -> Result<Vec<serde_json::Value>> {
        use crate::types::ModMetadata;
        use chrono::Utc;

        let env = env_service
            .get_environment(environment_id)
            .await
            .context("Failed to get environment")?
            .ok_or_else(|| anyhow::anyhow!("Environment not found"))?;

        if env.output_dir.is_empty() {
            return Err(anyhow::anyhow!("Output directory not set"));
        }

        // Get mods list
        let mods_result = mods_service.list_mods(&env.output_dir).await?;
        let mods_array = mods_result
            .get("mods")
            .and_then(|m| m.as_array())
            .ok_or_else(|| anyhow::anyhow!("Invalid mods list format"))?;

        // Load metadata
        let mods_dir = Path::new(&env.output_dir).join("Mods");
        let mut all_metadata: HashMap<String, ModMetadata> = mods_service
            .load_mod_metadata(&mods_dir)
            .await
            .unwrap_or_else(|_| HashMap::new());
        let mut storage_metadata_updates: HashMap<String, ModMetadata> = HashMap::new();
        let mut processed_storage_ids: HashSet<String> = HashSet::new();

        let mut results = Vec::new();
        let now = Utc::now();
        let runtime_label = Self::runtime_label(&env.runtime);

        // Check each mod for updates
        for mod_info in mods_array {
            if let Some(file_name) = mod_info.get("fileName").and_then(|n| n.as_str()) {
                if let Some(metadata) = all_metadata.get_mut(file_name) {
                    let (updated_metadata, maybe_result) = self
                        .refresh_update_metadata(
                            file_name,
                            metadata.clone(),
                            runtime_label,
                            now,
                            mods_service,
                            thunderstore_service,
                            nexus_mods_service,
                            nexus_game_id,
                            github_service,
                        )
                        .await?;

                    *metadata = updated_metadata.clone();

                    if let Some(storage_id) = updated_metadata.mod_storage_id.clone() {
                        processed_storage_ids.insert(storage_id.clone());
                        storage_metadata_updates.insert(storage_id, updated_metadata.clone());
                    }

                    if let Some(result) = maybe_result {
                        results.push(result);
                    }
                }
            }
        }

        let library = mods_service.get_mod_library().await?;
        let managed_library_candidates = Self::build_managed_library_update_candidates(
            &library,
            environment_id,
            runtime_label,
            &processed_storage_ids,
        );

        for candidate in managed_library_candidates {
            let (updated_metadata, maybe_result) = self
                .refresh_update_metadata(
                    &candidate.file_name,
                    candidate.metadata,
                    runtime_label,
                    now,
                    mods_service,
                    thunderstore_service,
                    nexus_mods_service,
                    nexus_game_id,
                    github_service,
                )
                .await?;

            processed_storage_ids.insert(candidate.storage_id.clone());
            storage_metadata_updates.insert(candidate.storage_id.clone(), updated_metadata.clone());

            for existing_metadata in all_metadata.values_mut() {
                if existing_metadata.mod_storage_id.as_deref()
                    == Some(candidate.storage_id.as_str())
                {
                    Self::sync_refreshed_metadata_fields(existing_metadata, &updated_metadata);
                }
            }

            if let Some(result) = maybe_result {
                results.push(result);
            }
        }

        for (storage_id, metadata_update) in storage_metadata_updates {
            if let Err(error) = mods_service
                .upsert_storage_metadata_by_id(&storage_id, metadata_update)
                .await
            {
                log::warn!(
                    "Failed to sync refreshed metadata to storage {}: {}",
                    storage_id,
                    error
                );
            }
        }

        // Save updated metadata back to file
        mods_service
            .save_mod_metadata(&mods_dir, &all_metadata)
            .await?;

        Ok(results)
    }

    pub async fn backfill_missing_thunderstore_library_icons(
        &self,
        mods_service: &ModsService,
        thunderstore_service: &ThunderStoreService,
    ) -> Result<usize> {
        use crate::types::{ModMetadata, ModSource};
        use chrono::Utc;

        let library = mods_service.get_mod_library().await?;
        let mut seen_storage_ids = HashSet::new();
        let mut updated = 0usize;

        for entry in library.downloaded {
            if !matches!(entry.source, Some(ModSource::Thunderstore)) {
                continue;
            }

            if entry.icon_url.is_some() && entry.icon_cache_path.is_some() {
                continue;
            }

            if !seen_storage_ids.insert(entry.storage_id.clone()) {
                continue;
            }

            let Some(source_id) = entry
                .source_id
                .clone()
                .filter(|value| !value.trim().is_empty())
            else {
                continue;
            };

            let Ok((_, package)) = self
                .resolve_thunderstore_package(thunderstore_service, &source_id, None)
                .await
            else {
                continue;
            };

            let now = Utc::now();
            let icon_url = Self::extract_package_icon(&package, Some(&source_id));
            let icon_cache_path = mods_service
                .cache_icon_for_metadata(icon_url.as_deref())
                .await;

            let metadata_update = ModMetadata {
                source: Some(ModSource::Thunderstore),
                source_id: Some(source_id.clone()),
                source_version: entry.source_version.clone(),
                author: package
                    .get("owner")
                    .and_then(|v| v.as_str())
                    .map(|v| v.to_string()),
                mod_name: package
                    .get("name")
                    .and_then(|v| v.as_str())
                    .map(|v| v.to_string()),
                source_url: package
                    .get("package_url")
                    .and_then(|v| v.as_str())
                    .map(|v| v.to_string()),
                summary: Self::select_latest_thunderstore_version(&package, Some(&source_id), None)
                    .and_then(|v| v.get("description"))
                    .and_then(|v| v.as_str())
                    .map(|v| v.to_string()),
                icon_url,
                icon_cache_path,
                downloads: package
                    .get("versions")
                    .and_then(|v| v.as_array())
                    .map(|versions| {
                        versions
                            .iter()
                            .map(|ver| ver.get("downloads").and_then(|v| v.as_u64()).unwrap_or(0))
                            .sum::<u64>()
                    }),
                likes_or_endorsements: package.get("rating_score").and_then(|v| v.as_i64()),
                updated_at: package
                    .get("date_updated")
                    .and_then(|v| v.as_str())
                    .map(|v| v.to_string()),
                tags: package
                    .get("categories")
                    .and_then(|v| v.as_array())
                    .map(|arr| {
                        arr.iter()
                            .filter_map(|v| v.as_str().map(|s| s.to_string()))
                            .collect::<Vec<String>>()
                    })
                    .filter(|tags| !tags.is_empty()),
                installed_version: None,
                library_added_at: None,
                installed_at: None,
                last_update_check: Some(now),
                metadata_last_refreshed: Some(now),
                update_available: None,
                remote_version: None,
                detected_runtime: None,
                runtime_match: None,
                mod_storage_id: Some(entry.storage_id.clone()),
                managed_paths: None,
                security_scan: None,
            };

            match mods_service
                .upsert_storage_metadata_by_id(&entry.storage_id, metadata_update.clone())
                .await
            {
                Ok(_) => {
                    updated = updated.saturating_add(1);
                }
                Err(error) => {
                    log::warn!(
                        "Failed to backfill Thunderstore metadata for storage {} (source {}, icon {:?}): {}",
                        entry.storage_id,
                        source_id,
                        metadata_update.icon_url,
                        error
                    );
                }
            }
        }

        Ok(updated)
    }

    fn runtime_label(runtime: &crate::types::Runtime) -> &'static str {
        match runtime {
            crate::types::Runtime::Il2cpp => "IL2CPP",
            crate::types::Runtime::Mono => "Mono",
        }
    }

    fn extract_package_uuid(package: &Value) -> Option<String> {
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

    fn extract_package_icon(package: &Value, source_id: Option<&str>) -> Option<String> {
        Self::select_latest_thunderstore_version(package, source_id, None)
            .and_then(|version| version.get("icon"))
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

    fn select_latest_thunderstore_version<'a>(
        package: &'a Value,
        source_id: Option<&str>,
        preferred_version: Option<&str>,
    ) -> Option<&'a Value> {
        let versions = package.get("versions").and_then(|v| v.as_array())?;

        if let Some(preferred) = preferred_version {
            if let Some(exact) = versions.iter().find(|version| {
                version
                    .get("version_number")
                    .and_then(|v| v.as_str())
                    .map(|candidate| {
                        Self::compare_thunderstore_versions(source_id, candidate, preferred)
                            == Ordering::Equal
                    })
                    .unwrap_or(false)
            }) {
                return Some(exact);
            }
        }

        versions.iter().max_by(|left, right| {
            let left_version = left
                .get("version_number")
                .and_then(|v| v.as_str())
                .unwrap_or_default();
            let right_version = right
                .get("version_number")
                .and_then(|v| v.as_str())
                .unwrap_or_default();
            match Self::compare_thunderstore_versions(source_id, left_version, right_version) {
                Ordering::Equal => {
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
    }

    fn normalize_thunderstore_package_name(name: &str) -> String {
        let mut normalized = name.trim().to_string();

        loop {
            let lower = normalized.to_ascii_lowercase();
            let suffix = [
                " (mono)",
                " [mono]",
                "_mono",
                "-mono",
                " mono",
                " (il2cpp)",
                " [il2cpp]",
                "_il2cpp",
                "-il2cpp",
                " il2cpp",
            ]
            .iter()
            .find(|suffix| lower.ends_with(**suffix))
            .copied();

            let Some(suffix) = suffix else {
                break;
            };

            normalized.truncate(normalized.len().saturating_sub(suffix.len()));
            normalized = normalized.trim().to_string();
        }

        normalized
    }

    async fn resolve_thunderstore_package(
        &self,
        thunderstore_service: &ThunderStoreService,
        source_id: &str,
        preferred_runtime: Option<&str>,
    ) -> Result<(String, Value)> {
        if let Ok(Some(package)) = thunderstore_service
            .get_package(source_id, Some("schedule-i"))
            .await
        {
            return Ok((source_id.to_string(), package));
        }

        let (owner, name) = source_id
            .split_once('/')
            .ok_or_else(|| anyhow::anyhow!("Invalid Thunderstore source id: {}", source_id))?;

        let normalized_name = Self::normalize_thunderstore_package_name(name);
        let candidates = thunderstore_service
            .search_packages_filtered_by_runtime(
                "schedule-i",
                preferred_runtime.unwrap_or("unknown"),
                Some(&normalized_name),
            )
            .await
            .context("Failed to search Thunderstore packages while resolving update")?;

        let normalized_target = normalized_name.to_ascii_lowercase();
        let raw_target = name.to_ascii_lowercase();
        let owner_lower = owner.to_ascii_lowercase();
        let owner_matches = |pkg: &Value| {
            pkg.get("owner")
                .and_then(|v| v.as_str())
                .map(|value| value.eq_ignore_ascii_case(owner))
                .unwrap_or(false)
        };
        let normalized_pkg_name = |pkg: &Value| {
            Self::normalize_thunderstore_package_name(
                pkg.get("name").and_then(|v| v.as_str()).unwrap_or(""),
            )
            .to_ascii_lowercase()
        };
        let raw_pkg_name = |pkg: &Value| {
            pkg.get("name")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_ascii_lowercase()
        };

        let matching = candidates
            .iter()
            .find(|pkg| owner_matches(pkg) && normalized_pkg_name(pkg) == normalized_target)
            .cloned()
            .or_else(|| {
                candidates
                    .iter()
                    .find(|pkg| owner_matches(pkg) && raw_pkg_name(pkg) == raw_target)
                    .cloned()
            })
            .or_else(|| {
                candidates
                    .iter()
                    .find(|pkg| {
                        owner_matches(pkg) && {
                            let pkg_name = normalized_pkg_name(pkg);
                            pkg_name.contains(&normalized_target)
                                || normalized_target.contains(&pkg_name)
                        }
                    })
                    .cloned()
            })
            .or_else(|| {
                let owner_matches: Vec<_> = candidates
                    .iter()
                    .filter(|pkg| {
                        pkg.get("owner")
                            .and_then(|v| v.as_str())
                            .map(|value| value.to_ascii_lowercase() == owner_lower)
                            .unwrap_or(false)
                    })
                    .cloned()
                    .collect();
                if owner_matches.len() == 1 {
                    owner_matches.into_iter().next()
                } else {
                    None
                }
            });

        let package = matching.ok_or_else(|| {
            anyhow::anyhow!(
                "Could not resolve Thunderstore package from source id {}",
                source_id
            )
        })?;

        let package_uuid = Self::extract_package_uuid(&package)
            .ok_or_else(|| anyhow::anyhow!("Unable to determine Thunderstore package UUID"))?;

        let package = thunderstore_service
            .get_package(&package_uuid, Some("schedule-i"))
            .await
            .context("Failed to fetch resolved Thunderstore package")?
            .ok_or_else(|| anyhow::anyhow!("Resolved Thunderstore package no longer exists"))?;

        Ok((package_uuid, package))
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

    fn extract_s1api_revision_parts(value: &str) -> Vec<u32> {
        let core = value
            .trim_start_matches(['v', 'V'])
            .split(['-', '+'])
            .next()
            .unwrap_or_default();

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
            .collect()
    }

    fn is_prerelease_marker(value: &str) -> bool {
        let lower = value.to_ascii_lowercase();
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
        .any(|marker| lower.contains(marker))
    }

    fn compare_s1api_revision_versions(current: &str, latest: &str) -> Ordering {
        let current_parts = Self::extract_s1api_revision_parts(current);
        let latest_parts = Self::extract_s1api_revision_parts(latest);
        let max_len = current_parts.len().max(latest_parts.len());

        for index in 0..max_len {
            let current_value = current_parts.get(index).copied().unwrap_or(0);
            let latest_value = latest_parts.get(index).copied().unwrap_or(0);
            match current_value.cmp(&latest_value) {
                Ordering::Equal => continue,
                ordering => return ordering,
            }
        }

        match (
            Self::is_prerelease_marker(current),
            Self::is_prerelease_marker(latest),
        ) {
            (true, false) => Ordering::Less,
            (false, true) => Ordering::Greater,
            _ => current
                .trim_start_matches(['v', 'V'])
                .cmp(latest.trim_start_matches(['v', 'V'])),
        }
    }

    fn compare_thunderstore_versions(
        source_id: Option<&str>,
        current: &str,
        latest: &str,
    ) -> Ordering {
        if Self::is_s1api_thunderstore_source_id(source_id) {
            return Self::compare_s1api_revision_versions(current, latest);
        }

        Self::compare_versions(current, latest)
    }

    fn compare_versions(current: &str, latest: &str) -> Ordering {
        let current_parts = Self::extract_numeric_version_parts(current);
        let latest_parts = Self::extract_numeric_version_parts(latest);
        let max_len = current_parts.len().max(latest_parts.len());

        for index in 0..max_len {
            let current_value = current_parts.get(index).copied().unwrap_or(0);
            let latest_value = latest_parts.get(index).copied().unwrap_or(0);
            match current_value.cmp(&latest_value) {
                Ordering::Equal => continue,
                ordering => return ordering,
            }
        }

        match (
            Self::is_prerelease_marker(current),
            Self::is_prerelease_marker(latest),
        ) {
            (true, false) => Ordering::Less,
            (false, true) => Ordering::Greater,
            _ => current
                .trim_start_matches(['v', 'V'])
                .cmp(latest.trim_start_matches(['v', 'V'])),
        }
    }

    fn file_version_string(file: &Value) -> String {
        file.get("version")
            .or_else(|| file.get("mod_version"))
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string()
    }

    fn is_runtime_compatible_nexus_file(file: &Value, runtime_label: &str) -> bool {
        let runtime_lower = runtime_label.to_lowercase();
        let file_name = file
            .get("file_name")
            .or_else(|| file.get("name"))
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_lowercase();

        if runtime_lower == "il2cpp" {
            file_name.contains("il2cpp") || file_name.contains("main") || file_name.contains("beta")
        } else {
            file_name.contains("mono") || file_name.contains("alternate")
        }
    }

    fn select_best_nexus_file_for_update(
        files: &[Value],
        runtime_label: &str,
        _current_version: Option<&str>,
    ) -> Option<Value> {
        let compatible: Vec<Value> = files
            .iter()
            .filter(|f| Self::is_runtime_compatible_nexus_file(f, runtime_label))
            .cloned()
            .collect();

        let pool: Vec<Value> = if compatible.is_empty() {
            files.to_vec()
        } else {
            compatible
        };

        pool.into_iter().max_by(|left, right| {
            let left_version = Self::file_version_string(left);
            let right_version = Self::file_version_string(right);
            match Self::compare_versions(&left_version, &right_version) {
                Ordering::Equal => {
                    let left_primary = left
                        .get("is_primary")
                        .and_then(|v| v.as_bool())
                        .unwrap_or(false);
                    let right_primary = right
                        .get("is_primary")
                        .and_then(|v| v.as_bool())
                        .unwrap_or(false);
                    left_primary.cmp(&right_primary)
                }
                ordering => ordering,
            }
        })
    }

    fn nexus_manual_confirmation_required_response(
        message: String,
        nexus_game_domain: &str,
        mod_id: u32,
        file_id: u32,
        runtime_label: &str,
    ) -> serde_json::Value {
        serde_json::json!({
            "success": false,
            "error": message,
            "errorCode": "nexus_manual_confirmation_required",
            "requiresManualDownload": true,
            "gameId": nexus_game_domain,
            "modId": mod_id,
            "fileId": file_id,
            "runtime": runtime_label,
            "recoveryUrl": format!(
                "https://www.nexusmods.com/{}/mods/{}?tab=files",
                nexus_game_domain,
                mod_id
            )
        })
    }

    async fn prepare_downloaded_update_security_scan(
        settings: &crate::types::Settings,
        temp_path: &Path,
        metadata: serde_json::Value,
        security_override: bool,
    ) -> Result<crate::commands::mods::SecurityGateResult> {
        crate::commands::mods::prepare_security_scan_with_settings(
            settings,
            temp_path.to_string_lossy().as_ref(),
            Some(metadata),
            security_override,
        )
        .await
        .map_err(anyhow::Error::msg)
    }

    async fn run_security_gated_provider_install<F, Fut>(
        settings: &crate::types::Settings,
        temp_path: &Path,
        metadata: serde_json::Value,
        security_override: bool,
        operation: &str,
        install: F,
    ) -> Result<ProviderUpdateInstallResult>
    where
        F: FnOnce(Option<serde_json::Value>) -> Fut,
        Fut: std::future::Future<Output = Result<serde_json::Value>>,
    {
        let (metadata, report) = match Self::prepare_downloaded_update_security_scan(
            settings,
            temp_path,
            metadata,
            security_override,
        )
        .await
        {
            Ok(crate::commands::mods::SecurityGateResult::Continue { metadata, report }) => {
                (metadata, report)
            }
            Ok(crate::commands::mods::SecurityGateResult::EarlyResponse(response)) => {
                let _ = tokio::fs::remove_file(temp_path).await;
                return Ok(ProviderUpdateInstallResult::EarlyResponse(response));
            }
            Err(error) => {
                let _ = tokio::fs::remove_file(temp_path).await;
                return Err(error);
            }
        };

        let response = install(metadata).await;
        let _ = tokio::fs::remove_file(temp_path).await;
        let response = response?;
        let response = Self::require_successful_install_response(response, operation)?;
        Ok(ProviderUpdateInstallResult::Installed { response, report })
    }

    fn require_successful_install_response(
        response: serde_json::Value,
        operation: &str,
    ) -> Result<serde_json::Value> {
        match response.get("success").and_then(|value| value.as_bool()) {
            Some(true) => Ok(response),
            Some(false) => Err(anyhow::anyhow!(
                "{} failed: {}",
                operation,
                response
                    .get("error")
                    .or_else(|| response.get("message"))
                    .and_then(|value| value.as_str())
                    .unwrap_or("installer returned success: false")
            )),
            None => Err(anyhow::anyhow!(
                "{} returned an invalid install response without success: true",
                operation
            )),
        }
    }

    pub async fn update_mod<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        environment_id: &str,
        mod_file_name: &str,
        env_service: &EnvironmentService,
        mods_service: &ModsService,
        thunderstore_service: &ThunderStoreService,
        nexus_mods_service: &NexusModsService,
        nexus_game_id: &str,
        nexus_access_token: Option<&str>,
        github_service: &GitHubReleasesService,
        settings: &crate::types::Settings,
        security_override: bool,
    ) -> Result<serde_json::Value> {
        use crate::types::ModSource;

        let env = env_service
            .get_environment(environment_id)
            .await
            .context("Failed to get environment")?
            .ok_or_else(|| anyhow::anyhow!("Environment not found"))?;

        if env.output_dir.is_empty() {
            return Err(anyhow::anyhow!("Output directory not set"));
        }

        let mods_dir = Path::new(&env.output_dir).join("Mods");
        let metadata_map = mods_service
            .load_mod_metadata(&mods_dir)
            .await
            .unwrap_or_default();
        let metadata = metadata_map
            .get(mod_file_name)
            .cloned()
            .ok_or_else(|| anyhow::anyhow!("Mod metadata not found for {}", mod_file_name))?;

        let source = metadata
            .source
            .ok_or_else(|| anyhow::anyhow!("Mod source is unknown"))?;
        let source_id = metadata
            .source_id
            .ok_or_else(|| anyhow::anyhow!("Mod source id is missing"))?;
        let runtime_label = Self::runtime_label(&env.runtime);

        let temp_file_name = format!(
            "mod-update-{}-{}",
            environment_id,
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or_default()
        );

        match source {
            ModSource::Thunderstore => {
                let (package_uuid, package) = self
                    .resolve_thunderstore_package(
                        thunderstore_service,
                        &source_id,
                        Some(runtime_label),
                    )
                    .await?;

                let latest_package_version = Self::select_latest_thunderstore_version(
                    &package,
                    Some(&source_id),
                    metadata.remote_version.as_deref(),
                )
                .ok_or_else(|| {
                    anyhow::anyhow!("Thunderstore package has no version information")
                })?;
                let latest_version = latest_package_version
                    .get("version_number")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| {
                        anyhow::anyhow!("Thunderstore package has no version information")
                    })?;
                if !Self::versions_differ_for_thunderstore(
                    Some(&source_id),
                    metadata.source_version.as_deref(),
                    &latest_version,
                ) {
                    return Ok(serde_json::json!({
                        "success": true,
                        "message": "Already up to date",
                        "alreadyUpToDate": true
                    }));
                }

                let tracked_download = crate::services::tracked_downloads::start_file_download(
                    crate::services::tracked_downloads::new_download_id("mod-update-thunderstore"),
                    crate::types::TrackedDownloadKind::Mod,
                    format!("{}.zip", package_uuid),
                    format!("Update -> {}", env.name),
                    Some("Downloading update".to_string()),
                );
                let _ = crate::services::tracked_downloads::emit(app, tracked_download.clone());

                let bytes = thunderstore_service
                    .download_package(
                        &package_uuid,
                        Some("schedule-i"),
                        latest_package_version.get("uuid4").and_then(|v| v.as_str()),
                    )
                    .await
                    .map_err(|error| {
                        let message = format!("Failed to download Thunderstore update: {}", error);
                        let _ = crate::services::tracked_downloads::emit(
                            app,
                            crate::services::tracked_downloads::fail_file_download(
                                &tracked_download,
                                message.clone(),
                                Some("Download failed".to_string()),
                            ),
                        );
                        anyhow::anyhow!(message)
                    })?;
                let temp_path = std::env::temp_dir().join(format!("{}.zip", temp_file_name));
                tokio::fs::write(&temp_path, bytes).await.map_err(|error| {
                    let message = format!("Failed to write Thunderstore update archive: {}", error);
                    let _ = crate::services::tracked_downloads::emit(
                        app,
                        crate::services::tracked_downloads::fail_file_download(
                            &tracked_download,
                            message.clone(),
                            Some("Download failed".to_string()),
                        ),
                    );
                    anyhow::anyhow!(message)
                })?;
                let _ = crate::services::tracked_downloads::emit(
                    app,
                    crate::services::tracked_downloads::complete_file_download(
                        &tracked_download,
                        Some("Update archive downloaded".to_string()),
                    ),
                );

                let owner = package.get("owner").and_then(|v| v.as_str()).unwrap_or("");
                let name = package.get("name").and_then(|v| v.as_str()).unwrap_or("");
                let source_id = if !owner.is_empty() && !name.is_empty() {
                    format!("{}/{}", owner, name)
                } else {
                    source_id
                };

                let metadata_json = serde_json::json!({
                    "source": "thunderstore",
                    "sourceId": source_id,
                    "sourceVersion": latest_version,
                    "sourceUrl": package.get("package_url").and_then(|v| v.as_str()).unwrap_or_default(),
                    "modName": name,
                    "author": owner,
                    "summary": latest_package_version
                        .get("description")
                        .and_then(|v| v.as_str())
                        .unwrap_or_default(),
                    "iconUrl": Self::extract_package_icon(&package, Some(&source_id))
                        .unwrap_or_default(),
                    "downloads": package
                        .get("versions")
                        .and_then(|v| v.as_array())
                        .map(|versions| {
                            versions
                                .iter()
                                .map(|ver| ver.get("downloads").and_then(|v| v.as_u64()).unwrap_or(0))
                                .sum::<u64>()
                        })
                        .unwrap_or(0),
                    "likesOrEndorsements": package
                        .get("rating_score")
                        .and_then(|v| v.as_i64())
                        .unwrap_or(0),
                    "updatedAt": package
                        .get("date_updated")
                        .and_then(|v| v.as_str())
                        .unwrap_or_default(),
                    "tags": package
                        .get("categories")
                        .and_then(|v| v.as_array())
                        .map(|arr| {
                            arr.iter()
                                .filter_map(|v| v.as_str())
                                .collect::<Vec<&str>>()
                        })
                        .unwrap_or_default(),
                });

                let temp_path_string = temp_path.to_string_lossy().to_string();
                let archive_file_name = format!("{}.zip", package_uuid);
                let install_result = Self::run_security_gated_provider_install(
                    settings,
                    &temp_path,
                    metadata_json,
                    security_override,
                    "Thunderstore mod update installation",
                    |metadata| {
                        mods_service.install_zip_mod(
                            &env.output_dir,
                            &temp_path_string,
                            &archive_file_name,
                            runtime_label,
                            &env.branch,
                            metadata,
                        )
                    },
                )
                .await?;
                let (response, security_report) = match install_result {
                    ProviderUpdateInstallResult::Installed { response, report } => {
                        (response, report)
                    }
                    ProviderUpdateInstallResult::EarlyResponse(response) => return Ok(response),
                };
                Ok(crate::commands::mods::finalize_security_scan_response(
                    mods_service,
                    response,
                    security_report.as_ref(),
                    "installing a Thunderstore mod update",
                )
                .await)
            }
            ModSource::Nexusmods => {
                let mod_id = source_id
                    .parse::<u32>()
                    .context("Invalid Nexus mod id in metadata")?;
                let (_resolved_game_id, nexus_game_domain) = nexus_mods_service
                    .resolve_game_identity(nexus_game_id)
                    .await
                    .context("Failed to resolve Nexus game identity")?;

                let files = nexus_mods_service
                    .get_mod_files(nexus_game_id, mod_id)
                    .await
                    .context("Failed to fetch Nexus mod files")?;
                let target_file = Self::select_best_nexus_file_for_update(
                    &files,
                    runtime_label,
                    metadata.source_version.as_deref(),
                )
                .ok_or_else(|| anyhow::anyhow!("No Nexus file available for update"))?;

                let file_id = target_file
                    .get("file_id")
                    .and_then(|v| v.as_u64())
                    .ok_or_else(|| anyhow::anyhow!("Nexus file is missing file_id"))?
                    as u32;
                let latest_version = target_file
                    .get("version")
                    .or_else(|| target_file.get("mod_version"))
                    .and_then(|v| v.as_str())
                    .unwrap_or_default()
                    .to_string();

                if !latest_version.is_empty()
                    && !Self::versions_differ(metadata.source_version.as_deref(), &latest_version)
                {
                    return Ok(serde_json::json!({
                        "success": true,
                        "message": "Already up to date",
                        "alreadyUpToDate": true
                    }));
                }

                let Some(access_token) = nexus_access_token else {
                    return Ok(serde_json::json!({
                        "success": false,
                        "error": "Nexus OAuth login required to download updates",
                        "errorCode": "nexus_auth_required",
                        "recoveryUrl": "accounts"
                    }));
                };
                let original_file_name = target_file
                    .get("file_name")
                    .or_else(|| target_file.get("name"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("nexus-update.zip");
                let tracked_download = crate::services::tracked_downloads::start_file_download(
                    crate::services::tracked_downloads::new_download_id("mod-update-nexus"),
                    crate::types::TrackedDownloadKind::Mod,
                    original_file_name.to_string(),
                    format!("Update -> {}", env.name),
                    Some("Downloading update".to_string()),
                );
                let _ = crate::services::tracked_downloads::emit(app, tracked_download.clone());

                let bytes = match nexus_mods_service
                    .download_mod_file(access_token, nexus_game_id, mod_id, file_id)
                    .await
                {
                    Ok(bytes) => bytes,
                    Err(error) => {
                        let message = format!("Failed to download Nexus update: {}", error);
                        let _ = crate::services::tracked_downloads::emit(
                            app,
                            crate::services::tracked_downloads::fail_file_download(
                                &tracked_download,
                                message.clone(),
                                Some("Download failed".to_string()),
                            ),
                        );

                        let normalized = message.to_ascii_lowercase();
                        if normalized.contains("premium")
                            || normalized.contains("site confirmation")
                            || normalized.contains("requires website confirmation")
                            || normalized.contains("download-link request failed (403)")
                            || normalized.contains("forbidden")
                        {
                            return Ok(Self::nexus_manual_confirmation_required_response(
                                message,
                                &nexus_game_domain,
                                mod_id,
                                file_id,
                                runtime_label,
                            ));
                        }

                        return Err(anyhow::anyhow!(message));
                    }
                };
                let extension = Path::new(original_file_name)
                    .extension()
                    .and_then(|v| v.to_str())
                    .unwrap_or("zip");
                let temp_path =
                    std::env::temp_dir().join(format!("{}.{}", temp_file_name, extension));
                tokio::fs::write(&temp_path, bytes).await.map_err(|error| {
                    let message = format!("Failed to write Nexus update file: {}", error);
                    let _ = crate::services::tracked_downloads::emit(
                        app,
                        crate::services::tracked_downloads::fail_file_download(
                            &tracked_download,
                            message.clone(),
                            Some("Download failed".to_string()),
                        ),
                    );
                    anyhow::anyhow!(message)
                })?;
                let _ = crate::services::tracked_downloads::emit(
                    app,
                    crate::services::tracked_downloads::complete_file_download(
                        &tracked_download,
                        Some("Update file downloaded".to_string()),
                    ),
                );

                let mod_info = nexus_mods_service.get_mod(nexus_game_id, mod_id).await.ok();
                let metadata_json = serde_json::json!({
                    "source": "nexusmods",
                    "sourceId": source_id,
                    "sourceVersion": latest_version,
                    "sourceUrl": format!(
                        "https://www.nexusmods.com/{}/mods/{}",
                        nexus_game_domain,
                        mod_id
                    ),
                    "modName": mod_info.as_ref().and_then(|m| m.get("name")).and_then(|v| v.as_str()).unwrap_or_default(),
                    "author": mod_info.as_ref().and_then(|m| m.get("author")).and_then(|v| v.as_str()).unwrap_or_default(),
                });

                let temp_path_string = temp_path.to_string_lossy().to_string();
                let install_result = Self::run_security_gated_provider_install(
                    settings,
                    &temp_path,
                    metadata_json,
                    security_override,
                    "Nexus mod update installation",
                    |metadata| async {
                        if extension.eq_ignore_ascii_case("dll") {
                            mods_service
                                .install_dll_mod(
                                    &env.output_dir,
                                    &temp_path_string,
                                    runtime_label,
                                    metadata,
                                )
                                .await
                        } else {
                            mods_service
                                .install_zip_mod(
                                    &env.output_dir,
                                    &temp_path_string,
                                    original_file_name,
                                    runtime_label,
                                    &env.branch,
                                    metadata,
                                )
                                .await
                        }
                    },
                )
                .await?;
                let (response, security_report) = match install_result {
                    ProviderUpdateInstallResult::Installed { response, report } => {
                        (response, report)
                    }
                    ProviderUpdateInstallResult::EarlyResponse(response) => return Ok(response),
                };
                Ok(crate::commands::mods::finalize_security_scan_response(
                    mods_service,
                    response,
                    security_report.as_ref(),
                    "installing a Nexus mod update",
                )
                .await)
            }
            ModSource::Github => {
                let (owner, repo) = source_id
                    .split_once('/')
                    .ok_or_else(|| anyhow::anyhow!("Invalid GitHub source id"))?;
                let release = github_service
                    .get_latest_release(owner, repo, false)
                    .await
                    .context("Failed to fetch latest GitHub release")?
                    .ok_or_else(|| anyhow::anyhow!("No release found for GitHub source"))?;
                let latest_version = release
                    .get("tag_name")
                    .and_then(|v| v.as_str())
                    .unwrap_or_default()
                    .to_string();

                if !latest_version.is_empty()
                    && !Self::versions_differ(metadata.source_version.as_deref(), &latest_version)
                {
                    return Ok(serde_json::json!({
                        "success": true,
                        "message": "Already up to date",
                        "alreadyUpToDate": true
                    }));
                }

                let asset_url = github_service.get_zip_asset_url(&release).ok_or_else(|| {
                    anyhow::anyhow!("No ZIP asset found for latest GitHub release")
                })?;
                let tracked_download = crate::services::tracked_downloads::start_file_download(
                    crate::services::tracked_downloads::new_download_id("mod-update-github"),
                    crate::types::TrackedDownloadKind::Mod,
                    "github-update.zip",
                    format!("Update -> {}", env.name),
                    Some("Downloading update".to_string()),
                );
                let _ = crate::services::tracked_downloads::emit(app, tracked_download.clone());

                let bytes = github_service
                    .download_release_asset(&asset_url)
                    .await
                    .map_err(|error| {
                        let message = format!("Failed to download GitHub release asset: {}", error);
                        let _ = crate::services::tracked_downloads::emit(
                            app,
                            crate::services::tracked_downloads::fail_file_download(
                                &tracked_download,
                                message.clone(),
                                Some("Download failed".to_string()),
                            ),
                        );
                        anyhow::anyhow!(message)
                    })?;
                let temp_path = std::env::temp_dir().join(format!("{}.zip", temp_file_name));
                tokio::fs::write(&temp_path, bytes).await.map_err(|error| {
                    let message = format!("Failed to write GitHub update archive: {}", error);
                    let _ = crate::services::tracked_downloads::emit(
                        app,
                        crate::services::tracked_downloads::fail_file_download(
                            &tracked_download,
                            message.clone(),
                            Some("Download failed".to_string()),
                        ),
                    );
                    anyhow::anyhow!(message)
                })?;
                let _ = crate::services::tracked_downloads::emit(
                    app,
                    crate::services::tracked_downloads::complete_file_download(
                        &tracked_download,
                        Some("Update archive downloaded".to_string()),
                    ),
                );

                let metadata_json = serde_json::json!({
                    "source": "github",
                    "sourceId": source_id,
                    "sourceVersion": latest_version,
                    "sourceUrl": format!("https://github.com/{}/{}", owner, repo),
                    "modName": metadata.mod_name.unwrap_or_else(|| mod_file_name.to_string()),
                    "author": owner,
                });

                let temp_path_string = temp_path.to_string_lossy().to_string();
                let install_result = Self::run_security_gated_provider_install(
                    settings,
                    &temp_path,
                    metadata_json,
                    security_override,
                    "GitHub mod update installation",
                    |metadata| {
                        mods_service.install_zip_mod(
                            &env.output_dir,
                            &temp_path_string,
                            "github-update.zip",
                            runtime_label,
                            &env.branch,
                            metadata,
                        )
                    },
                )
                .await?;
                let (response, security_report) = match install_result {
                    ProviderUpdateInstallResult::Installed { response, report } => {
                        (response, report)
                    }
                    ProviderUpdateInstallResult::EarlyResponse(response) => return Ok(response),
                };
                Ok(crate::commands::mods::finalize_security_scan_response(
                    mods_service,
                    response,
                    security_report.as_ref(),
                    "installing a GitHub mod update",
                )
                .await)
            }
            ModSource::Local | ModSource::Unknown => Ok(serde_json::json!({
                "success": false,
                "error": "This mod source does not support automatic updates",
                "errorCode": "unsupported_source"
            })),
        }
    }

    fn versions_differ(current: Option<&str>, latest: &str) -> bool {
        match current {
            Some(value) => Self::compare_versions(value, latest) == Ordering::Less,
            None => true,
        }
    }

    fn versions_differ_for_thunderstore(
        source_id: Option<&str>,
        current: Option<&str>,
        latest: &str,
    ) -> bool {
        match current {
            Some(value) => {
                Self::compare_thunderstore_versions(source_id, value, latest) == Ordering::Less
            }
            None => true,
        }
    }
}

impl Default for ModUpdateService {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::mods::{
        blocked_security_scan_report_for_test, install_security_scan_test_hook,
    };
    use crate::db::initialize_pool;
    use crate::services::environment::EnvironmentService;
    use crate::services::github_releases::GitHubReleasesService;
    use crate::services::mods::ModsService;
    use crate::services::nexus_mods::NexusModsService;
    use crate::services::settings::SettingsService;
    use crate::services::thunderstore::ThunderStoreService;
    use crate::types::{
        schedule_i_config, ModLibraryEntry, ModLibraryResult, ModMetadata, ModSource,
    };
    use serial_test::serial;
    use std::collections::{HashMap, HashSet};
    use std::sync::atomic::{AtomicUsize, Ordering as AtomicOrdering};
    use std::sync::Arc;
    use tauri::test::mock_app;
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

    fn make_library_entry(overrides: impl FnOnce(&mut ModLibraryEntry)) -> ModLibraryEntry {
        let mut entry = ModLibraryEntry {
            storage_id: "storage-1".to_string(),
            display_name: "SteamNetworkLib".to_string(),
            files: Vec::new(),
            attached_userlibs: vec!["SteamNetworkLib.dll".to_string()],
            attached_userdata: Vec::new(),
            source: Some(ModSource::Thunderstore),
            source_id: Some("ifBars/SteamNetworkLib_Mono".to_string()),
            source_version: Some("1.2.1".to_string()),
            source_url: Some(
                "https://thunderstore.io/c/schedule-i/p/ifBars/SteamNetworkLib_Mono/".to_string(),
            ),
            summary: Some("Steam networking library".to_string()),
            icon_url: None,
            icon_cache_path: None,
            downloads: None,
            likes_or_endorsements: None,
            updated_at: None,
            tags: None,
            installed_version: Some("1.2.1".to_string()),
            library_added_at: None,
            installed_at: None,
            author: Some("ifBars".to_string()),
            update_available: None,
            remote_version: None,
            managed: true,
            installed_in: vec!["env-mono".to_string()],
            available_runtimes: vec!["Mono".to_string()],
            storage_ids_by_runtime: HashMap::from([("Mono".to_string(), "storage-1".to_string())]),
            installed_in_by_runtime: HashMap::from([(
                "Mono".to_string(),
                vec!["env-mono".to_string()],
            )]),
            files_by_runtime: HashMap::from([(
                "Mono".to_string(),
                vec!["SteamNetworkLib.dll".to_string()],
            )]),
            security_scan: None,
        };
        overrides(&mut entry);
        entry
    }

    #[test]
    fn install_response_requires_explicit_success() {
        let success = ModUpdateService::require_successful_install_response(
            serde_json::json!({ "success": true, "storageId": "stored-mod" }),
            "test install",
        )
        .expect("success: true should be accepted");
        assert_eq!(success["storageId"], serde_json::json!("stored-mod"));

        let failed = ModUpdateService::require_successful_install_response(
            serde_json::json!({ "success": false, "error": "archive could not be installed" }),
            "test install",
        )
        .expect_err("success: false must not be treated as an installed update");
        assert!(failed
            .to_string()
            .contains("archive could not be installed"));

        let malformed = ModUpdateService::require_successful_install_response(
            serde_json::json!({ "storageId": "stored-mod" }),
            "test install",
        )
        .expect_err("an install response without success must fail closed");
        assert!(malformed.to_string().contains("without success: true"));
    }

    #[tokio::test]
    #[serial]
    async fn provider_update_gate_blocks_once_before_invoking_the_installer() -> Result<()> {
        let temp = tempdir()?;
        let update_archive = temp.path().join("blocked-provider-update.zip");
        tokio::fs::write(&update_archive, b"provider-update").await?;
        let scan_hook = install_security_scan_test_hook(
            update_archive.to_string_lossy().to_string(),
            blocked_security_scan_report_for_test(),
        );
        let installer_calls = Arc::new(AtomicUsize::new(0));
        let calls_for_installer = Arc::clone(&installer_calls);
        let settings = SettingsService::default_settings();

        let result = ModUpdateService::run_security_gated_provider_install(
            &settings,
            &update_archive,
            serde_json::json!({ "source": "github", "sourceId": "example/update" }),
            false,
            "test provider update installation",
            move |_metadata| {
                calls_for_installer.fetch_add(1, AtomicOrdering::SeqCst);
                async { Ok(serde_json::json!({ "success": true })) }
            },
        )
        .await?;

        assert!(matches!(
            result,
            ProviderUpdateInstallResult::EarlyResponse(_)
        ));
        assert_eq!(scan_hook.call_count(), 1);
        assert_eq!(installer_calls.load(AtomicOrdering::SeqCst), 0);
        assert!(!update_archive.exists());

        Ok(())
    }

    #[test]
    fn nexus_manual_confirmation_response_includes_pending_session_target() {
        let response = ModUpdateService::nexus_manual_confirmation_required_response(
            "Failed to download Nexus update: forbidden".to_string(),
            "schedule1",
            1777,
            42,
            "IL2CPP",
        );

        assert_eq!(response["requiresManualDownload"], serde_json::json!(true));
        assert_eq!(
            response["errorCode"],
            serde_json::json!("nexus_manual_confirmation_required")
        );
        assert_eq!(response["gameId"], serde_json::json!("schedule1"));
        assert_eq!(response["modId"], serde_json::json!(1777));
        assert_eq!(response["fileId"], serde_json::json!(42));
        assert_eq!(response["runtime"], serde_json::json!("IL2CPP"));
        assert_eq!(
            response["recoveryUrl"],
            serde_json::json!("https://www.nexusmods.com/schedule1/mods/1777?tab=files")
        );
    }

    #[tokio::test]
    #[serial]
    async fn check_mod_updates_requires_output_dir() -> Result<()> {
        let temp = tempdir()?;
        let data_dir = temp.path().join("simmrust");
        let _guard = EnvVarGuard::set("SIMMRUST_DATA_DIR", data_dir.to_string_lossy().as_ref());
        let pool = initialize_pool().await?;
        let env_service = EnvironmentService::new(pool.clone())?;
        let mods_service = ModsService::new(pool.clone());
        let thunderstore_service = ThunderStoreService::new();
        let nexus_mods_service = NexusModsService::new();
        let github_service = GitHubReleasesService::new();

        let env = env_service
            .create_environment(
                schedule_i_config().app_id,
                "main".to_string(),
                temp.path()
                    .join("managed-environment")
                    .to_string_lossy()
                    .to_string(),
                None,
                None,
            )
            .await?;
        // Environment creation now establishes a canonical, owned directory
        // marker. Model the later incomplete configuration explicitly instead
        // of creating an invalid managed root with an empty path.
        let env = env_service
            .update_environment(
                &env.id,
                [(
                    "outputDir".to_string(),
                    serde_json::Value::String(String::new()),
                )],
            )
            .await?;
        assert!(env.output_dir.is_empty());

        let service = ModUpdateService::new();
        let err = service
            .check_mod_updates(
                &env.id,
                &env_service,
                &mods_service,
                &thunderstore_service,
                &nexus_mods_service,
                "schedule1",
                &github_service,
            )
            .await
            .expect_err("expected output dir error");

        assert!(err.to_string().contains("Output directory not set"));

        Ok(())
    }

    #[tokio::test]
    #[serial]
    async fn update_mod_returns_error_for_missing_environment() -> Result<()> {
        let temp = tempdir()?;
        let data_dir = temp.path().join("simmrust");
        let _guard = EnvVarGuard::set("SIMMRUST_DATA_DIR", data_dir.to_string_lossy().as_ref());
        let pool = initialize_pool().await?;
        let env_service = EnvironmentService::new(pool.clone())?;
        let mods_service = ModsService::new(pool.clone());
        let thunderstore_service = ThunderStoreService::new();
        let nexus_mods_service = NexusModsService::new();
        let github_service = GitHubReleasesService::new();
        let app = mock_app();
        let settings = SettingsService::default_settings();

        let service = ModUpdateService::new();
        let err = service
            .update_mod(
                &app.handle(),
                "missing-env",
                "missing.dll",
                &env_service,
                &mods_service,
                &thunderstore_service,
                &nexus_mods_service,
                "schedule1",
                None,
                &github_service,
                &settings,
                false,
            )
            .await
            .expect_err("expected missing environment error");
        assert!(err.to_string().contains("Environment not found"));

        Ok(())
    }

    #[test]
    fn versions_differ_normalizes_v_prefix() {
        assert!(!ModUpdateService::versions_differ(Some("v1.2.3"), "1.2.3"));
        assert!(!ModUpdateService::versions_differ(Some("1.2.3"), "V1.2.3"));
        assert!(ModUpdateService::versions_differ(Some("1.2.3"), "1.2.4"));
        assert!(ModUpdateService::versions_differ(None, "1.0.0"));
    }

    #[test]
    fn versions_differ_does_not_flag_newer_beta_as_outdated_against_older_stable() {
        assert!(!ModUpdateService::versions_differ(
            Some("1.1.0-beta"),
            "1.0.2",
        ));
    }

    #[test]
    fn versions_differ_treats_same_core_stable_as_newer_than_numbered_prerelease() {
        assert!(ModUpdateService::versions_differ(
            Some("1.1.0-beta.1"),
            "1.1.0",
        ));
    }

    #[test]
    fn s1api_thunderstore_versions_treat_appended_patch_digits_as_revision_suffixes() {
        assert!(ModUpdateService::versions_differ_for_thunderstore(
            Some("ifBars/S1API"),
            Some("3.0.22"),
            "3.0.3",
        ));
        assert!(ModUpdateService::versions_differ_for_thunderstore(
            Some("ifBars/S1API"),
            Some("3.0.32"),
            "3.0.4",
        ));
        assert!(ModUpdateService::versions_differ_for_thunderstore(
            Some("ifBars/S1API"),
            Some("3.0.3"),
            "3.0.32",
        ));
        assert!(!ModUpdateService::versions_differ_for_thunderstore(
            Some("ifBars/S1API"),
            Some("3.0.4"),
            "3.0.32",
        ));
    }

    #[test]
    fn non_s1api_thunderstore_versions_keep_normal_semver_ordering() {
        assert!(ModUpdateService::versions_differ_for_thunderstore(
            Some("example/mod"),
            Some("1.0.9"),
            "1.0.10",
        ));
        assert!(!ModUpdateService::versions_differ_for_thunderstore(
            Some("example/mod"),
            Some("1.0.10"),
            "1.0.9",
        ));
    }

    #[test]
    fn extract_package_latest_version_prefers_highest_version_over_payload_order() {
        let package = serde_json::json!({
            "versions": [
                {
                    "uuid4": "older-version",
                    "version_number": "1.1.0",
                    "date_updated": "2025-01-01T00:00:00Z",
                    "description": "Older release"
                },
                {
                    "uuid4": "latest-version",
                    "version_number": "1.2.0",
                    "date_updated": "2025-01-10T00:00:00Z",
                    "description": "Latest release"
                }
            ]
        });

        assert_eq!(
            ModUpdateService::select_latest_thunderstore_version(
                &package,
                Some("example/mod"),
                None,
            )
            .and_then(|version| version.get("version_number"))
            .and_then(|value| value.as_str()),
            Some("1.2.0")
        );
        assert_eq!(
            ModUpdateService::select_latest_thunderstore_version(
                &package,
                Some("example/mod"),
                None,
            )
            .and_then(|version| version.get("uuid4"))
            .and_then(|value| value.as_str()),
            Some("latest-version")
        );
    }

    #[test]
    fn select_best_nexus_file_for_update_offers_prerelease_when_newer_than_stable() {
        let files = vec![
            serde_json::json!({
                "file_id": 1,
                "file_name": "Pack Rat Main.zip",
                "version": "1.0.6-4.4.3",
                "is_primary": true
            }),
            serde_json::json!({
                "file_id": 2,
                "file_name": "Pack Rat Beta.zip",
                "version": "1.0.7r2",
                "is_primary": false
            }),
        ];

        let selected =
            ModUpdateService::select_best_nexus_file_for_update(&files, "IL2CPP", Some("1.0.0"))
                .expect("selected nexus file");

        assert_eq!(selected.get("file_id").and_then(|v| v.as_u64()), Some(2));
    }

    #[test]
    fn select_best_nexus_file_for_update_keeps_beta_track_for_beta_installs() {
        let files = vec![
            serde_json::json!({
                "file_id": 10,
                "file_name": "Example Main.zip",
                "version": "1.0.2",
                "is_primary": true
            }),
            serde_json::json!({
                "file_id": 11,
                "file_name": "Example Beta.zip",
                "version": "1.1.0-beta",
                "is_primary": false
            }),
        ];

        let selected = ModUpdateService::select_best_nexus_file_for_update(
            &files,
            "IL2CPP",
            Some("1.1.0-beta"),
        )
        .expect("selected nexus file");

        assert_eq!(selected.get("file_id").and_then(|v| v.as_u64()), Some(11));
    }

    #[test]
    fn extract_package_icon_prefers_version_icon() {
        let package = serde_json::json!({
            "icon": "https://example.com/top.png",
            "versions": [
                {
                    "icon": "https://example.com/version.png"
                }
            ]
        });

        let icon = ModUpdateService::extract_package_icon(&package, Some("example/mod"));
        assert_eq!(icon.as_deref(), Some("https://example.com/version.png"));
    }

    #[test]
    fn select_latest_thunderstore_version_prefers_highest_version_over_response_order() {
        let package = serde_json::json!({
            "versions": [
                {
                    "uuid4": "older",
                    "version_number": "1.2.0",
                    "date_updated": "2026-04-01T00:00:00Z"
                },
                {
                    "uuid4": "latest",
                    "version_number": "1.4.0",
                    "date_updated": "2026-04-02T00:00:00Z"
                },
                {
                    "uuid4": "middle",
                    "version_number": "1.3.0",
                    "date_updated": "2026-04-03T00:00:00Z"
                }
            ]
        });

        let selected = ModUpdateService::select_latest_thunderstore_version(
            &package,
            Some("example/mod"),
            None,
        )
        .expect("selected version");

        assert_eq!(
            selected.get("uuid4").and_then(|value| value.as_str()),
            Some("latest")
        );
    }

    #[test]
    fn select_latest_thunderstore_version_uses_revision_suffix_ordering_for_s1api() {
        let package = serde_json::json!({
            "versions": [
                {
                    "uuid4": "patched-r2",
                    "version_number": "3.0.22",
                    "date_updated": "2026-04-01T00:00:00Z"
                },
                {
                    "uuid4": "patched-r3",
                    "version_number": "3.0.3",
                    "date_updated": "2026-04-02T00:00:00Z"
                },
                {
                    "uuid4": "patched-r2-next",
                    "version_number": "3.0.32",
                    "date_updated": "2026-04-03T00:00:00Z"
                },
                {
                    "uuid4": "patched-r4",
                    "version_number": "3.0.4",
                    "date_updated": "2026-04-04T00:00:00Z"
                }
            ]
        });

        let selected = ModUpdateService::select_latest_thunderstore_version(
            &package,
            Some("ifBars/S1API"),
            None,
        )
        .expect("selected version");

        assert_eq!(
            selected.get("uuid4").and_then(|value| value.as_str()),
            Some("patched-r4")
        );
        assert_eq!(
            selected
                .get("version_number")
                .and_then(|value| value.as_str()),
            Some("3.0.4")
        );
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

        let selected = ModUpdateService::select_latest_thunderstore_version(
            &package,
            Some("example/mod"),
            None,
        )
        .expect("selected version");

        assert_eq!(
            selected.get("uuid4").and_then(|value| value.as_str()),
            Some("stable-10")
        );
    }

    #[test]
    fn select_latest_thunderstore_version_can_pin_a_previously_surfaced_version() {
        let package = serde_json::json!({
            "versions": [
                {
                    "uuid4": "older",
                    "version_number": "1.2.0",
                    "date_updated": "2026-04-01T00:00:00Z"
                },
                {
                    "uuid4": "latest",
                    "version_number": "1.4.0",
                    "date_updated": "2026-04-02T00:00:00Z"
                }
            ]
        });

        let selected = ModUpdateService::select_latest_thunderstore_version(
            &package,
            Some("example/mod"),
            Some("1.2.0"),
        )
        .expect("selected version");

        assert_eq!(
            selected.get("uuid4").and_then(|value| value.as_str()),
            Some("older")
        );
    }

    #[test]
    fn normalize_thunderstore_package_name_strips_runtime_suffixes() {
        assert_eq!(
            ModUpdateService::normalize_thunderstore_package_name("Cartel_Enforcer_MONO"),
            "Cartel_Enforcer"
        );
        assert_eq!(
            ModUpdateService::normalize_thunderstore_package_name("ScheduleToolbox-IL2CPP"),
            "ScheduleToolbox"
        );
        assert_eq!(
            ModUpdateService::normalize_thunderstore_package_name("Pack Rat (Mono)"),
            "Pack Rat"
        );
    }

    #[test]
    fn managed_library_update_candidates_include_userlibs_only_entries() {
        let library = ModLibraryResult {
            downloaded: vec![make_library_entry(|_| {})],
        };

        let candidates = ModUpdateService::build_managed_library_update_candidates(
            &library,
            "env-mono",
            "Mono",
            &HashSet::new(),
        );

        assert_eq!(candidates.len(), 1);
        assert_eq!(candidates[0].file_name, "SteamNetworkLib.dll");
        assert_eq!(candidates[0].storage_id, "storage-1");
        assert_eq!(
            candidates[0].metadata.source_id.as_deref(),
            Some("ifBars/SteamNetworkLib_Mono")
        );
        assert_eq!(
            candidates[0].metadata.detected_runtime,
            Some(crate::types::Runtime::Mono)
        );
    }

    #[test]
    fn managed_library_update_candidates_skip_processed_or_wrong_runtime_entries() {
        let mono_entry = make_library_entry(|_| {});
        let il2cpp_entry = make_library_entry(|entry| {
            entry.storage_id = "storage-2".to_string();
            entry.source_id = Some("ifBars/SteamNetworkLib_Il2Cpp".to_string());
            entry.installed_in = vec!["env-il2cpp".to_string()];
            entry.available_runtimes = vec!["IL2CPP".to_string()];
            entry.storage_ids_by_runtime =
                HashMap::from([("IL2CPP".to_string(), "storage-2".to_string())]);
            entry.installed_in_by_runtime =
                HashMap::from([("IL2CPP".to_string(), vec!["env-il2cpp".to_string()])]);
            entry.files_by_runtime = HashMap::from([(
                "IL2CPP".to_string(),
                vec!["SteamNetworkLib.dll".to_string()],
            )]);
        });
        let library = ModLibraryResult {
            downloaded: vec![mono_entry, il2cpp_entry],
        };

        let processed = HashSet::from(["storage-1".to_string()]);
        let candidates = ModUpdateService::build_managed_library_update_candidates(
            &library, "env-mono", "Mono", &processed,
        );

        assert!(candidates.is_empty());
    }

    #[tokio::test]
    #[serial]
    async fn check_mod_updates_returns_empty_for_no_mods() -> Result<()> {
        let temp = tempdir()?;
        let data_dir = temp.path().join("simmrust");
        let _guard = EnvVarGuard::set("SIMMRUST_DATA_DIR", data_dir.to_string_lossy().as_ref());
        let pool = initialize_pool().await?;
        let env_service = EnvironmentService::new(pool.clone())?;
        let mods_service = ModsService::new(pool.clone());
        let thunderstore_service = ThunderStoreService::new();
        let nexus_mods_service = NexusModsService::new();
        let github_service = GitHubReleasesService::new();

        let output_dir = temp.path().join("envs").join("env-1");
        let env = env_service
            .create_environment(
                schedule_i_config().app_id,
                "main".to_string(),
                output_dir.to_string_lossy().to_string(),
                None,
                None,
            )
            .await?;

        let service = ModUpdateService::new();
        let results = service
            .check_mod_updates(
                &env.id,
                &env_service,
                &mods_service,
                &thunderstore_service,
                &nexus_mods_service,
                "schedule1",
                &github_service,
            )
            .await?;
        assert!(results.is_empty());

        Ok(())
    }

    fn extract_package_id(package: &serde_json::Value) -> Option<String> {
        for key in ["uuid4", "uuid", "package_uuid", "packageId", "package_id"] {
            if let Some(value) = package.get(key).and_then(|v| v.as_str()) {
                return Some(value.to_string());
            }
        }
        None
    }

    #[tokio::test]
    #[serial]
    #[ignore]
    async fn check_mod_updates_detects_thunderstore_updates() -> Result<()> {
        let temp = tempdir()?;
        let data_dir = temp.path().join("simmrust");
        let _guard = EnvVarGuard::set("SIMMRUST_DATA_DIR", data_dir.to_string_lossy().as_ref());
        let pool = initialize_pool().await?;
        let env_service = EnvironmentService::new(pool.clone())?;
        let mods_service = ModsService::new(pool.clone());
        let thunderstore_service = ThunderStoreService::new();
        let nexus_mods_service = NexusModsService::new();
        let github_service = GitHubReleasesService::new();

        let output_dir = temp.path().join("envs").join("env-live");
        let env = env_service
            .create_environment(
                schedule_i_config().app_id,
                "main".to_string(),
                output_dir.to_string_lossy().to_string(),
                None,
                None,
            )
            .await?;

        let packages = thunderstore_service
            .search_packages_filtered_by_runtime("schedule-i", "unknown", None)
            .await?;
        let package_id = packages
            .iter()
            .find_map(extract_package_id)
            .ok_or_else(|| anyhow::anyhow!("No Thunderstore package ID found"))?;

        let mods_dir = output_dir.join("Mods");
        tokio::fs::create_dir_all(&mods_dir).await?;
        tokio::fs::write(mods_dir.join("Example.dll"), b"data").await?;

        let mut metadata = std::collections::HashMap::new();
        metadata.insert(
            "Example.dll".to_string(),
            ModMetadata {
                source: Some(ModSource::Thunderstore),
                source_id: Some(package_id),
                source_version: Some("0.0.0".to_string()),
                author: None,
                mod_name: Some("Example".to_string()),
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
            },
        );
        mods_service.save_mod_metadata(&mods_dir, &metadata).await?;

        let service = ModUpdateService::new();
        let results = service
            .check_mod_updates(
                &env.id,
                &env_service,
                &mods_service,
                &thunderstore_service,
                &nexus_mods_service,
                "schedule1",
                &github_service,
            )
            .await?;

        assert!(!results.is_empty());
        let entry = results.first().expect("update result");
        assert_eq!(
            entry.get("modFileName").and_then(|v| v.as_str()),
            Some("Example.dll")
        );
        assert_eq!(
            entry.get("source").and_then(|v| v.as_str()),
            Some("thunderstore")
        );

        Ok(())
    }
}
