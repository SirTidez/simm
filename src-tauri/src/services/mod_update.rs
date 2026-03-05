use anyhow::{Context, Result};
use crate::services::mods::ModsService;
use crate::services::environment::EnvironmentService;
use crate::services::thunderstore::ThunderStoreService;
use crate::services::nexus_mods::NexusModsService;
use crate::services::github_releases::GitHubReleasesService;
use std::collections::{HashMap, HashSet};
use std::path::Path;
use serde_json::Value;

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

        let env = env_service.get_environment(environment_id)
            .await
            .context("Failed to get environment")?
            .ok_or_else(|| anyhow::anyhow!("Environment not found"))?;

        if env.output_dir.is_empty() {
            return Err(anyhow::anyhow!("Output directory not set"));
        }

        // Get mods list
        let mods_result = mods_service.list_mods(&env.output_dir).await?;
        let mods_array = mods_result.get("mods")
            .and_then(|m| m.as_array())
            .ok_or_else(|| anyhow::anyhow!("Invalid mods list format"))?;

        // Load metadata
        let mods_dir = Path::new(&env.output_dir).join("Mods");
        let mut all_metadata: HashMap<String, ModMetadata> = mods_service.load_mod_metadata(&mods_dir).await
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
                                    let update_available = current_version.as_ref().map(|cv| cv != &latest_version).unwrap_or(true);

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
                                                .map(|ver| ver.get("downloads").and_then(|v| v.as_u64()).unwrap_or(0))
                                                .sum::<u64>()
                                        });
                                    metadata.likes_or_endorsements = package
                                        .get("rating_score")
                                        .and_then(|v| v.as_i64());
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
                                        storage_metadata_updates.insert(storage_id, metadata.clone());
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
                                if let Ok(mod_info) = nexus_mods_service.get_mod(game_id, mod_id).await {
                                    // Get latest version from mod info
                                    if let Some(latest_version) = mod_info
                                        .get("version")
                                        .and_then(|v| v.as_str())
                                        .map(|s| s.to_string())
                                    {
                                        let update_available = current_version.as_ref().map(|cv| cv != &latest_version).unwrap_or(true);

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
                                            storage_metadata_updates.insert(storage_id, metadata.clone());
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
                                if let Ok(Some(latest_release)) = github_service.get_latest_release(owner, repo_name, false).await {
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
                                            storage_metadata_updates.insert(storage_id, metadata.clone());
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
        mods_service.save_mod_metadata(&mods_dir, &all_metadata).await?;

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

            let Some(source_id) = entry.source_id.clone().filter(|value| !value.trim().is_empty()) else {
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
                likes_or_endorsements: package
                    .get("rating_score")
                    .and_then(|v| v.as_i64()),
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
            };

            if mods_service
                .upsert_storage_metadata_by_id(&entry.storage_id, metadata_update)
                .await
                .is_ok()
            {
                updated = updated.saturating_add(1);
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
        if let Ok(Some(package)) = thunderstore_service.get_package(source_id, Some("schedule-i")).await {
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

    fn select_nexus_file_for_runtime(
        files: &[Value],
        runtime_label: &str,
    ) -> Option<Value> {
        let runtime_lower = runtime_label.to_lowercase();
        let compatible: Vec<Value> = files
            .iter()
            .filter(|f| {
                let file_name = f
                    .get("file_name")
                    .or_else(|| f.get("name"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_lowercase();
                if runtime_lower == "il2cpp" {
                    file_name.contains("il2cpp")
                        || file_name.contains("main")
                        || file_name.contains("beta")
                } else {
                    file_name.contains("mono") || file_name.contains("alternate")
                }
            })
            .cloned()
            .collect();

        if !compatible.is_empty() {
            if let Some(primary) = compatible
                .iter()
                .find(|f| f.get("is_primary").and_then(|v| v.as_bool()).unwrap_or(false))
            {
                return Some(primary.clone());
            }
            return compatible.first().cloned();
        }

        files
            .iter()
            .find(|f| f.get("is_primary").and_then(|v| v.as_bool()).unwrap_or(false))
            .cloned()
            .or_else(|| files.first().cloned())
    }

    pub async fn update_mod(
        &self,
        environment_id: &str,
        mod_file_name: &str,
        env_service: &EnvironmentService,
        mods_service: &ModsService,
        thunderstore_service: &ThunderStoreService,
        nexus_mods_service: &NexusModsService,
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

                let latest_version = Self::extract_package_latest_version(&package)
                    .ok_or_else(|| anyhow::anyhow!("Thunderstore package has no version information"))?;
                if !Self::versions_differ(metadata.source_version.as_deref(), &latest_version) {
                    return Ok(serde_json::json!({
                        "success": true,
                        "message": "Already up to date",
                        "alreadyUpToDate": true
                    }));
                }

                let bytes = thunderstore_service
                    .download_package(&package_uuid, Some("schedule-i"))
                    .await
                    .context("Failed to download Thunderstore update")?;
                let temp_path = std::env::temp_dir().join(format!("{}.zip", temp_file_name));
                tokio::fs::write(&temp_path, bytes)
                    .await
                    .context("Failed to write Thunderstore update archive")?;

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
                let target_file = Self::select_nexus_file_for_runtime(&files, runtime_label)
                    .ok_or_else(|| anyhow::anyhow!("No Nexus file available for update"))?;

                let file_id = target_file
                    .get("file_id")
                    .and_then(|v| v.as_u64())
                    .ok_or_else(|| anyhow::anyhow!("Nexus file is missing file_id"))? as u32;
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

                let bytes = nexus_mods_service
                    .download_mod_file("schedule1", mod_id, file_id)
                    .await
                    .context("Failed to download Nexus update")?;
                let original_file_name = target_file
                    .get("file_name")
                    .or_else(|| target_file.get("name"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("nexus-update.zip");
                let extension = Path::new(original_file_name)
                    .extension()
                    .and_then(|v| v.to_str())
                    .unwrap_or("zip");
                let temp_path = std::env::temp_dir().join(format!("{}.{}", temp_file_name, extension));
                tokio::fs::write(&temp_path, bytes)
                    .await
                    .context("Failed to write Nexus update file")?;

                let mod_info = nexus_mods_service
                    .get_mod("schedule1", mod_id)
                    .await
                    .ok();
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

                let asset_url = github_service
                    .get_zip_asset_url(&release)
                    .ok_or_else(|| anyhow::anyhow!("No ZIP asset found for latest GitHub release"))?;
                let bytes = github_service
                    .download_release_asset(&asset_url)
                    .await
                    .context("Failed to download GitHub release asset")?;
                let temp_path = std::env::temp_dir().join(format!("{}.zip", temp_file_name));
                tokio::fs::write(&temp_path, bytes)
                    .await
                    .context("Failed to write GitHub update archive")?;

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
                "error": "This mod source does not support automatic updates"
            })),
        }
    }

    fn versions_differ(current: Option<&str>, latest: &str) -> bool {
        let normalized_latest = latest.trim_start_matches('v').trim_start_matches('V');
        match current {
            Some(value) => {
                let normalized_current = value.trim_start_matches('v').trim_start_matches('V');
                normalized_current != normalized_latest
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
    use crate::db::initialize_pool;
    use crate::services::environment::EnvironmentService;
    use crate::services::mods::ModsService;
    use crate::services::nexus_mods::NexusModsService;
    use crate::services::thunderstore::ThunderStoreService;
    use crate::types::{schedule_i_config, ModMetadata, ModSource};
    use crate::services::github_releases::GitHubReleasesService;
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

        let service = ModUpdateService::new();
        let err = service
            .update_mod(
                "missing-env",
                "missing.dll",
                &env_service,
                &mods_service,
                &thunderstore_service,
                &nexus_mods_service,
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
        assert_eq!(entry.get("modFileName").and_then(|v| v.as_str()), Some("Example.dll"));
        assert_eq!(entry.get("source").and_then(|v| v.as_str()), Some("thunderstore"));

        Ok(())
    }
}
