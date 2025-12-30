use anyhow::{Context, Result};
use crate::services::mods::ModsService;
use crate::services::environment::EnvironmentService;
use crate::services::thunderstore::ThunderStoreService;
use std::collections::HashMap;
use std::path::Path;
use tokio::fs;

#[derive(Clone)]
pub struct ModUpdateService;

impl ModUpdateService {
    pub fn new() -> Self {
        Self
    }

    pub async fn check_mod_updates(&self, environment_id: &str, env_service: &EnvironmentService, mods_service: &ModsService, thunderstore_service: &ThunderStoreService) -> Result<Vec<serde_json::Value>> {
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
        let mut all_metadata: HashMap<String, serde_json::Value> = HashMap::new();
        
        if metadata_file.exists() {
            if let Ok(content) = fs::read_to_string(&metadata_file).await {
                if let Ok(metadata) = serde_json::from_str::<HashMap<String, serde_json::Value>>(&content) {
                    all_metadata = metadata;
                }
            }
        }

        let mut results = Vec::new();

        // Check each mod for updates
        for mod_info in mods_array {
            if let Some(file_name) = mod_info.get("fileName").and_then(|n| n.as_str()) {
                if let Some(metadata) = all_metadata.get(file_name) {
                    let source = metadata.get("source")
                        .and_then(|s| s.as_str());
                    let source_id = metadata.get("sourceId")
                        .and_then(|s| s.as_str());
                    let current_version = metadata.get("sourceVersion")
                        .and_then(|v| v.as_str());

                    if let Some("thunderstore") = source {
                        if let Some(uuid) = source_id {
                            // Check Thunderstore for updates
                            if let Ok(Some(package)) = thunderstore_service.get_package(uuid).await {
                                if let Some(latest_version) = package
                                    .get("latest")
                                    .and_then(|l| l.get("versions"))
                                    .and_then(|v| v.as_array())
                                    .and_then(|v| v.first())
                                    .and_then(|v| v.get("version_number"))
                                    .and_then(|v| v.as_str())
                                {
                                    let update_available = current_version.map(|cv| cv != latest_version).unwrap_or(true);
                                    
                                    results.push(serde_json::json!({
                                        "modFileName": file_name,
                                        "updateAvailable": update_available,
                                        "currentVersion": current_version,
                                        "latestVersion": latest_version,
                                        "source": "thunderstore",
                                        "packageInfo": package
                                    }));
                                }
                            }
                        }
                    }
                }
            }
        }

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
