use anyhow::{Context, Result};
use crate::services::mods::ModsService;
use crate::services::environment::EnvironmentService;
use crate::services::thunderstore::ThunderStoreService;
use crate::services::nexus_mods::NexusModsService;
use std::collections::HashMap;
use std::path::Path;

#[derive(Clone)]
pub struct ModUpdateService;

impl ModUpdateService {
    pub fn new() -> Self {
        Self
    }

    pub async fn check_mod_updates(&self, environment_id: &str, env_service: &EnvironmentService, mods_service: &ModsService, thunderstore_service: &ThunderStoreService, nexus_mods_service: &NexusModsService) -> Result<Vec<serde_json::Value>> {
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
        let metadata_file = mods_dir.join(".mods-metadata.json");
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
