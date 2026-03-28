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

impl ModUpdateService {
    pub fn new() -> Self {
        Self
    }

    pub async fn check_mod_updates(
        &self,
        environment_id: &str,
        env_service: &EnvironmentService,
        mods_service: &ModsService,
        thunderstore_service: &ThunderStoreService,
        nexus_mods_service: &NexusModsService,
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

        let mut results = Vec::new();
        let now = Utc::now();

        // Check each mod for updates
        for mod_info in mods_array {
            if let Some(file_name) = mod_info.get("fileName").and_then(|n| n.as_str()) {
                if let Some(metadata) = all_metadata.get_mut(file_name) {
                    let source = metadata.source.clone();
                    let source_id = metadata.source_id.clone();
                    let current_version = metadata.source_version.clone();

                    if let Some(crate::types::ModSource::Thunderstore) = source {
                        if let Some(source_id) = source_id {
                            // Check Thunderstore for updates (use Schedule I community endpoint)
                            if let Ok((_, package)) = self
                                .resolve_thunderstore_package(thunderstore_service, &source_id)
                                .await
                            {
                                // Versions array is directly on package, not under "latest"
                                if let Some(latest_version) = package
                                    .get("versions")
                                    .and_then(|v| v.as_array())
                                    .and_then(|v| v.first())
                                    .and_then(|v| v.get("version_number"))
                                    .and_then(|v| v.as_str())
                                    .map(|s| s.to_string())
                                {
                                    let update_available = Self::versions_differ(
                                        current_version.as_deref(),
                                        &latest_version,
                                    );

                                    // Update metadata with check results
                                    metadata.last_update_check = Some(now);
                                    metadata.update_available = Some(update_available);
                                    metadata.remote_version = Some(latest_version.clone());
                                    metadata.summary = package
                                        .get("versions")
                                        .and_then(|v| v.as_array())
                                        .and_then(|v| v.first())
                                        .and_then(|v| v.get("description"))
                                        .and_then(|v| v.as_str())
                                        .map(|s| s.to_string())
                                        .or_else(|| {
                                            package
                                                .get("latest")
                                                .and_then(|v| v.get("description"))
                                                .and_then(|v| v.as_str())
                                                .map(|s| s.to_string())
                                        });
                                    metadata.icon_url = Self::extract_package_icon(&package);
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
                                                    ver.get("downloads")
                                                        .and_then(|v| v.as_u64())
                                                        .unwrap_or(0)
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
                                    if let Some(storage_id) = metadata.mod_storage_id.clone() {
                                        storage_metadata_updates
                                            .insert(storage_id, metadata.clone());
                                    }

                                    results.push(serde_json::json!({
                                        "modFileName": file_name,
                                        "updateAvailable": update_available,
                                        "currentVersion": current_version,
                                        "latestVersion": latest_version,
                                        "source": "thunderstore",
                                        "packageInfo": package
                                    }));
                                } else {
                                    // No version found, still update check time
                                    metadata.last_update_check = Some(now);
                                    metadata.update_available = Some(false);
                                }
                            } else {
                                // Failed to fetch package, still update check time
                                metadata.last_update_check = Some(now);
                            }
                        }
                    } else if let Some(crate::types::ModSource::Nexusmods) = source {
                        if let Some(mod_id_str) = source_id {
                            // Parse mod ID
                            if let Ok(mod_id) = mod_id_str.parse::<u32>() {
                                let game_id = "schedule1";
                                // Check NexusMods for updates
                                if let Ok(mod_info) =
                                    nexus_mods_service.get_mod(game_id, mod_id).await
                                {
                                    let latest_version = nexus_mods_service
                                        .get_mod_files(game_id, mod_id)
                                        .await
                                        .ok()
                                        .and_then(|files| {
                                            Self::select_best_nexus_file_for_update(
                                                &files,
                                                Self::runtime_label(&env.runtime),
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
                                        let update_available = Self::versions_differ(
                                            current_version.as_deref(),
                                            &latest_version,
                                        );

                                        // Update metadata with check results
                                        metadata.last_update_check = Some(now);
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
                                        if let Some(storage_id) = metadata.mod_storage_id.clone() {
                                            storage_metadata_updates
                                                .insert(storage_id, metadata.clone());
                                        }

                                        results.push(serde_json::json!({
                                            "modFileName": file_name,
                                            "updateAvailable": update_available,
                                            "currentVersion": current_version,
                                            "latestVersion": latest_version,
                                            "source": "nexusmods",
                                            "packageInfo": mod_info
                                        }));
                                    } else {
                                        // No version found, still update check time
                                        metadata.last_update_check = Some(now);
                                        metadata.update_available = Some(false);
                                    }
                                } else {
                                    // Failed to fetch mod, still update check time
                                    metadata.last_update_check = Some(now);
                                }
                            }
                        }
                    } else if let Some(crate::types::ModSource::Github) = source {
                        if let Some(repo) = source_id {
                            // Parse owner/repo from source_id (e.g., "ifBars/S1API")
                            let parts: Vec<&str> = repo.split('/').collect();
                            if parts.len() == 2 {
                                let owner = parts[0];
                                let repo_name = parts[1];

                                // Check GitHub for latest release
                                if let Ok(Some(latest_release)) = github_service
                                    .get_latest_release(owner, repo_name, false)
                                    .await
                                {
                                    if let Some(latest_version) = latest_release
                                        .get("tag_name")
                                        .and_then(|v| v.as_str())
                                        .map(|s| s.to_string())
                                    {
                                        let update_available = Self::versions_differ(
                                            current_version.as_deref(),
                                            &latest_version,
                                        );

                                        // Update metadata with check results
                                        metadata.last_update_check = Some(now);
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
                                        if let Some(storage_id) = metadata.mod_storage_id.clone() {
                                            storage_metadata_updates
                                                .insert(storage_id, metadata.clone());
                                        }

                                        results.push(serde_json::json!({
                                            "modFileName": file_name,
                                            "modName": metadata.mod_name.clone().unwrap_or_else(|| file_name.to_string()),
                                            "updateAvailable": update_available,
                                            "currentVersion": current_version,
                                            "latestVersion": latest_version,
                                            "source": "github",
                                            "packageInfo": latest_release
                                        }));
                                    } else {
                                        // No version found, still update check time
                                        metadata.last_update_check = Some(now);
                                        metadata.update_available = Some(false);
                                    }
                                } else {
                                    // Failed to fetch release, still update check time
                                    metadata.last_update_check = Some(now);
                                }
                            }
                        }
                    }
                }
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
                .resolve_thunderstore_package(thunderstore_service, &source_id)
                .await
            else {
                continue;
            };

            let now = Utc::now();
            let icon_url = Self::extract_package_icon(&package);
            let icon_cache_path = mods_service
                .cache_icon_for_metadata(icon_url.as_deref())
                .await;

            let metadata_update = ModMetadata {
                source: Some(ModSource::Thunderstore),
                source_id: Some(source_id.clone()),
                source_version: Self::extract_package_latest_version(&package),
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
                summary: package
                    .get("versions")
                    .and_then(|v| v.as_array())
                    .and_then(|v| v.first())
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
                symlink_paths: None,
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

    fn extract_package_latest_version(package: &Value) -> Option<String> {
        package
            .get("versions")
            .and_then(|v| v.as_array())
            .and_then(|v| v.first())
            .and_then(|v| v.get("version_number"))
            .and_then(|v| v.as_str())
            .map(|v| v.to_string())
    }

    fn extract_package_icon(package: &Value) -> Option<String> {
        package
            .get("versions")
            .and_then(|v| v.as_array())
            .and_then(|v| v.first())
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

    async fn resolve_thunderstore_package(
        &self,
        thunderstore_service: &ThunderStoreService,
        source_id: &str,
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

        let candidates = thunderstore_service
            .search_packages_filtered_by_runtime("schedule-i", "unknown", Some(name))
            .await
            .context("Failed to search Thunderstore packages while resolving update")?;

        let matching = candidates.into_iter().find(|pkg| {
            let pkg_owner = pkg.get("owner").and_then(|v| v.as_str()).unwrap_or("");
            let pkg_name = pkg.get("name").and_then(|v| v.as_str()).unwrap_or("");
            pkg_owner.eq_ignore_ascii_case(owner) && pkg_name.eq_ignore_ascii_case(name)
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

    pub async fn update_mod<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        environment_id: &str,
        mod_file_name: &str,
        env_service: &EnvironmentService,
        mods_service: &ModsService,
        thunderstore_service: &ThunderStoreService,
        nexus_mods_service: &NexusModsService,
        nexus_access_token: Option<&str>,
        github_service: &GitHubReleasesService,
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
                    .resolve_thunderstore_package(thunderstore_service, &source_id)
                    .await?;

                let latest_version =
                    Self::extract_package_latest_version(&package).ok_or_else(|| {
                        anyhow::anyhow!("Thunderstore package has no version information")
                    })?;
                if !Self::versions_differ(metadata.source_version.as_deref(), &latest_version) {
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
                    .download_package(&package_uuid, Some("schedule-i"), None)
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
                    "summary": package
                        .get("versions")
                        .and_then(|v| v.as_array())
                        .and_then(|v| v.first())
                        .and_then(|v| v.get("description"))
                        .and_then(|v| v.as_str())
                        .unwrap_or_default(),
                    "iconUrl": Self::extract_package_icon(&package).unwrap_or_default(),
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

                let result = mods_service
                    .install_zip_mod(
                        &env.output_dir,
                        &temp_path.to_string_lossy(),
                        &format!("{}.zip", package_uuid),
                        runtime_label,
                        &env.branch,
                        Some(metadata_json),
                    )
                    .await;
                let _ = tokio::fs::remove_file(&temp_path).await;
                result.map_err(|e| anyhow::anyhow!(e.to_string()))?;

                Ok(serde_json::json!({ "success": true }))
            }
            ModSource::Nexusmods => {
                let mod_id = source_id
                    .parse::<u32>()
                    .context("Invalid Nexus mod id in metadata")?;

                let files = nexus_mods_service
                    .get_mod_files("schedule1", mod_id)
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
                    .download_mod_file(access_token, "schedule1", mod_id, file_id)
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
                        {
                            return Ok(serde_json::json!({
                                "success": false,
                                "error": message,
                                "errorCode": "nexus_manual_confirmation_required",
                                "requiresManualDownload": true,
                                "recoveryUrl": format!("https://www.nexusmods.com/schedule1/mods/{}?tab=files", mod_id)
                            }));
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

                let mod_info = nexus_mods_service.get_mod("schedule1", mod_id).await.ok();
                let metadata_json = serde_json::json!({
                    "source": "nexusmods",
                    "sourceId": source_id,
                    "sourceVersion": latest_version,
                    "sourceUrl": format!("https://www.nexusmods.com/schedule1/mods/{}", mod_id),
                    "modName": mod_info.as_ref().and_then(|m| m.get("name")).and_then(|v| v.as_str()).unwrap_or_default(),
                    "author": mod_info.as_ref().and_then(|m| m.get("author")).and_then(|v| v.as_str()).unwrap_or_default(),
                });

                let result = if extension.eq_ignore_ascii_case("dll") {
                    mods_service
                        .install_dll_mod(
                            &env.output_dir,
                            &temp_path.to_string_lossy(),
                            runtime_label,
                            Some(metadata_json),
                        )
                        .await
                } else {
                    mods_service
                        .install_zip_mod(
                            &env.output_dir,
                            &temp_path.to_string_lossy(),
                            original_file_name,
                            runtime_label,
                            &env.branch,
                            Some(metadata_json),
                        )
                        .await
                };
                let _ = tokio::fs::remove_file(&temp_path).await;
                result.map_err(|e| anyhow::anyhow!(e.to_string()))?;

                Ok(serde_json::json!({ "success": true }))
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

                let result = mods_service
                    .install_zip_mod(
                        &env.output_dir,
                        &temp_path.to_string_lossy(),
                        "github-update.zip",
                        runtime_label,
                        &env.branch,
                        Some(metadata_json),
                    )
                    .await;
                let _ = tokio::fs::remove_file(&temp_path).await;
                result.map_err(|e| anyhow::anyhow!(e.to_string()))?;

                Ok(serde_json::json!({ "success": true }))
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
}

impl Default for ModUpdateService {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::initialize_pool;
    use crate::services::environment::EnvironmentService;
    use crate::services::github_releases::GitHubReleasesService;
    use crate::services::mods::ModsService;
    use crate::services::nexus_mods::NexusModsService;
    use crate::services::thunderstore::ThunderStoreService;
    use crate::types::{schedule_i_config, ModMetadata, ModSource};
    use serial_test::serial;
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
                "".to_string(),
                None,
                None,
            )
            .await?;

        let service = ModUpdateService::new();
        let err = service
            .check_mod_updates(
                &env.id,
                &env_service,
                &mods_service,
                &thunderstore_service,
                &nexus_mods_service,
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
                None,
                &github_service,
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

        let icon = ModUpdateService::extract_package_icon(&package);
        assert_eq!(icon.as_deref(), Some("https://example.com/version.png"));
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
                symlink_paths: None,
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
