use anyhow::{Context, Result};
use crate::services::mods::ModsService;
use crate::services::environment::EnvironmentService;
use crate::services::thunderstore::ThunderStoreService;
use crate::services::nexus_mods::NexusModsService;
use crate::services::github_releases::GitHubReleasesService;
use std::collections::HashMap;
use std::path::Path;

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
                        if let Some(uuid) = source_id {
                            // Check Thunderstore for updates (use Schedule I community endpoint)
                            if let Ok(Some(package)) = thunderstore_service.get_package(&uuid, Some("schedule-i")).await {
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
                                        // Normalize versions for comparison (strip 'v' prefix)
                                        let current_normalized = current_version.as_ref().map(|cv| cv.trim_start_matches('v').to_string());
                                        let latest_normalized = latest_version.trim_start_matches('v').to_string();
                                        let update_available = current_normalized
                                            .map(|cv| cv != latest_normalized)
                                            .unwrap_or(true);

                                        // Update metadata with check results
                                        metadata.last_update_check = Some(now);
                                        metadata.update_available = Some(update_available);
                                        metadata.remote_version = Some(latest_version.clone());

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

        // Save updated metadata back to file
        mods_service.save_mod_metadata(&mods_dir, &all_metadata).await?;

        Ok(results)
    }

    pub async fn update_mod(&self, _environment_id: &str, _mod_file_name: &str) -> Result<serde_json::Value> {
        // TODO: Implement mod updating - download new version and replace old one
        Ok(serde_json::json!({
            "success": false,
            "error": "Not implemented"
        }))
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
    async fn update_mod_returns_not_implemented() -> Result<()> {
        let service = ModUpdateService::new();
        let result = service.update_mod("env", "mod").await?;
        assert_eq!(result.get("success").and_then(|v| v.as_bool()), Some(false));
        assert_eq!(result.get("error").and_then(|v| v.as_str()), Some("Not implemented"));
        Ok(())
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
                installed_version: None,
                installed_at: None,
                last_update_check: None,
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
