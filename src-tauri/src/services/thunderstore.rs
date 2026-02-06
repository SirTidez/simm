use anyhow::{Context, Result};
use reqwest::Client;
use serde_json::Value;

const THUNDERSTORE_API_BASE: &str = "https://thunderstore.io/api/v1";

#[derive(Clone)]
pub struct ThunderStoreService {
    client: Client,
}

impl ThunderStoreService {
    pub fn new() -> Self {
        Self {
            client: Client::builder()
                .user_agent("Schedule-I-DevEnvManager/1.0.0")
                .build()
                .unwrap_or_else(|_| Client::new()),
        }
    }

    pub async fn search_packages_filtered_by_runtime(
        &self,
        game_id: &str,
        runtime: &str,
        query: Option<&str>,
    ) -> Result<Vec<serde_json::Value>> {
        // Use community-specific endpoint for Schedule I
        let base_url = if game_id == "schedule-i" {
            format!("https://thunderstore.io/c/{}/api/v1/package/", game_id)
        } else {
            format!("{}/package/", THUNDERSTORE_API_BASE)
        };

        let mut url = base_url;
        if let Some(q) = query {
            url = format!("{}?q={}", url, urlencoding::encode(q));
        }

        let response = self.client
            .get(&url)
            .send()
            .await
            .context("Failed to search Thunderstore packages")?;

        if !response.status().is_success() {
            return Err(anyhow::anyhow!("Thunderstore API returned {}", response.status()));
        }

        let mut packages: Vec<Value> = response.json().await
            .context("Failed to parse Thunderstore response")?;

        // Apply local query filtering (community endpoints may ignore `q`)
        if let Some(q) = query {
            let query_lower = q.trim().to_lowercase();
            if !query_lower.is_empty() {
                packages.retain(|pkg| {
                    let name = pkg.get("name")
                        .and_then(|n| n.as_str())
                        .unwrap_or("")
                        .to_lowercase();
                    let full_name = pkg.get("latest")
                        .and_then(|l| l.get("full_name"))
                        .and_then(|n| n.as_str())
                        .unwrap_or("")
                        .to_lowercase();
                    let owner = pkg.get("owner")
                        .and_then(|o| o.as_str())
                        .unwrap_or("")
                        .to_lowercase();
                    let description = pkg.get("latest")
                        .and_then(|l| l.get("description"))
                        .and_then(|d| d.as_str())
                        .or_else(|| {
                            pkg.get("versions")
                                .and_then(|v| v.as_array())
                                .and_then(|v| v.first())
                                .and_then(|v| v.get("description"))
                                .and_then(|d| d.as_str())
                        })
                        .unwrap_or("")
                        .to_lowercase();

                    name.contains(&query_lower)
                        || full_name.contains(&query_lower)
                        || owner.contains(&query_lower)
                        || description.contains(&query_lower)
                });
            }
        }

        // Filter by runtime if specified
        if runtime != "unknown" {
            let runtime_lower = runtime.to_lowercase();
            let other_runtime = if runtime_lower == "il2cpp" { "mono" } else { "il2cpp" };

            packages.retain(|pkg| {
                let name = pkg.get("name")
                    .and_then(|n| n.as_str())
                    .unwrap_or("")
                    .to_lowercase();
                let full_name = pkg.get("latest")
                    .and_then(|l| l.get("full_name"))
                    .and_then(|n| n.as_str())
                    .unwrap_or("")
                    .to_lowercase();

                // Check categories/tags for runtime compatibility
                // Packages can have categories like "il2cpp", "mono", "client-side", etc.
                let has_target_runtime_category = pkg.get("categories")
                    .and_then(|c| c.as_array())
                    .map(|cats| {
                        cats.iter().any(|cat| {
                            cat.as_str()
                                .map(|s| s.to_lowercase() == runtime_lower)
                                .unwrap_or(false)
                        })
                    })
                    .unwrap_or(false);

                let has_other_runtime_category = pkg.get("categories")
                    .and_then(|c| c.as_array())
                    .map(|cats| {
                        cats.iter().any(|cat| {
                            cat.as_str()
                                .map(|s| s.to_lowercase() == other_runtime)
                                .unwrap_or(false)
                        })
                    })
                    .unwrap_or(false);

                // Exclude if explicitly has the other runtime as a category
                if has_other_runtime_category && !has_target_runtime_category {
                    return false;
                }

                // Include if has target runtime category
                if has_target_runtime_category {
                    return true;
                }

                // Exclude if explicitly mentions other runtime in name
                if name.contains(&other_runtime) || full_name.contains(&other_runtime) {
                    return false;
                }

                // Include if mentions target runtime, or if no runtime specified (assume compatible)
                name.contains(&runtime_lower) || full_name.contains(&runtime_lower) ||
                (!name.contains("il2cpp") && !name.contains("mono") &&
                 !full_name.contains("il2cpp") && !full_name.contains("mono"))
            });
        }

        // Filter out deprecated packages
        packages.retain(|pkg| {
            !pkg.get("is_deprecated").and_then(|d| d.as_bool()).unwrap_or(false) &&
            !pkg.get("latest")
                .and_then(|l| l.get("is_deprecated"))
                .and_then(|d| d.as_bool())
                .unwrap_or(false)
        });

        Ok(packages)
    }

    pub async fn get_package(&self, package_uuid: &str, game_id: Option<&str>) -> Result<Option<serde_json::Value>> {
        // Use community-specific endpoint for Schedule I, otherwise use base API
        let url = if let Some(gid) = game_id {
            if gid == "schedule-i" {
                format!("https://thunderstore.io/c/{}/api/v1/package/{}/", gid, package_uuid)
            } else {
                format!("{}/package/{}/", THUNDERSTORE_API_BASE, package_uuid)
            }
        } else {
            format!("{}/package/{}/", THUNDERSTORE_API_BASE, package_uuid)
        };

        let response = self.client
            .get(&url)
            .send()
            .await
            .context("Failed to fetch Thunderstore package")?;

        if response.status() == 404 {
            return Ok(None);
        }

        if !response.status().is_success() {
            return Err(anyhow::anyhow!("Thunderstore API returned {}", response.status()));
        }

        let package: Value = response.json().await
            .context("Failed to parse Thunderstore package")?;

        Ok(Some(package))
    }

    pub async fn download_package(&self, package_uuid: &str, game_id: Option<&str>) -> Result<Vec<u8>> {
        // First get package info to find download URL
        let package = self.get_package(package_uuid, game_id).await?
            .ok_or_else(|| anyhow::anyhow!("Package not found"))?;

        // Get latest version download URL (versions array is directly on package, not under "latest")
        let download_url = package
            .get("versions")
            .and_then(|v| v.as_array())
            .and_then(|v| v.first())
            .and_then(|v| v.get("download_url"))
            .and_then(|u| u.as_str())
            .ok_or_else(|| anyhow::anyhow!("Download URL not found in package versions"))?;

        let response = self.client
            .get(download_url)
            .send()
            .await
            .context("Failed to download package")?;

        if !response.status().is_success() {
            return Err(anyhow::anyhow!("Failed to download package: {}", response.status()));
        }

        let bytes = response.bytes().await
            .context("Failed to read response body")?;

        Ok(bytes.to_vec())
    }
}

impl Default for ThunderStoreService {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn extract_package_id(package: &serde_json::Value) -> Option<String> {
        for key in ["uuid4", "uuid", "package_uuid", "packageId", "package_id"] {
            if let Some(value) = package.get(key).and_then(|v| v.as_str()) {
                return Some(value.to_string());
            }
        }
        None
    }

    #[tokio::test]
    async fn live_search_and_fetch_package() -> Result<()> {
        let service = ThunderStoreService::new();
        let packages = service
            .search_packages_filtered_by_runtime("schedule-i", "unknown", None)
            .await?;
        assert!(!packages.is_empty(), "Expected Thunderstore packages");

        let package_id = packages
            .iter()
            .find_map(extract_package_id)
            .ok_or_else(|| anyhow::anyhow!("No package ID found in Thunderstore response"))?;

        let package = service
            .get_package(&package_id, Some("schedule-i"))
            .await?
            .ok_or_else(|| anyhow::anyhow!("Package not found for id {}", package_id))?;

        assert!(package.get("name").is_some());
        Ok(())
    }
}
