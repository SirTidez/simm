use anyhow::{Context, Result};
use serde_json::Value;

#[derive(Clone)]
pub struct ThunderStoreService;

impl ThunderStoreService {
    pub fn new() -> Self {
        Self
    }

    fn crate_download_path_from_url(download_url: &str) -> Result<String> {
        let parsed = reqwest::Url::parse(download_url)
            .with_context(|| format!("Failed to parse Thunderstore download URL: {}", download_url))?;
        let host = parsed.host_str().unwrap_or_default().to_lowercase();

        if host != "thunderstore.io" && host != "www.thunderstore.io" {
            // TODO: Migrate to thunderstore-api-crate: allow absolute URL requests (or configurable hosts) for download URLs.
            // Why: crate mode currently only supports thunderstore.io path-based requests and must fail fast for unsupported hosts.
            // Reference: C:\Users\SirTidez\WebstormProjects\nexusapitests\crates\thunderstore-api\src\lib.rs (request)
            return Err(anyhow::anyhow!(
                "Thunderstore crate mode does not support non-thunderstore.io download hosts: {}",
                host
            ));
        }

        let mut path_and_query = parsed.path().to_string();
        if let Some(query) = parsed.query() {
            path_and_query.push('?');
            path_and_query.push_str(query);
        }

        Ok(path_and_query)
    }

    pub async fn search_packages_filtered_by_runtime(
        &self,
        game_id: &str,
        runtime: &str,
        query: Option<&str>,
    ) -> Result<Vec<serde_json::Value>> {
        let path = if game_id == "schedule-i" {
            format!("/c/{}/api/v1/package/", game_id)
        } else {
            "/api/v1/package/".to_string()
        };

        let query_pairs = query
            .map(|q| vec![("q".to_string(), q.to_string())])
            .unwrap_or_default();
        let query_ref = if query_pairs.is_empty() {
            None
        } else {
            Some(query_pairs.as_slice())
        };

        let response = thunderstore_api::request("GET", &path, query_ref, None)
            .await
            .map_err(|e| anyhow::anyhow!("Thunderstore crate request failed: {}", e))?;

        if !(200..300).contains(&response.status) {
            return Err(anyhow::anyhow!(
                "Thunderstore API returned {} for path {}",
                response.status,
                path
            ));
        }

        let mut packages: Vec<Value> = serde_json::from_slice::<Vec<Value>>(&response.body)
            .context("Failed to parse Thunderstore crate response body")?;

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
        let path = if let Some(gid) = game_id {
            if gid == "schedule-i" {
                format!("/c/{}/api/v1/package/{}/", gid, package_uuid)
            } else {
                format!("/api/v1/package/{}/", package_uuid)
            }
        } else {
            format!("/api/v1/package/{}/", package_uuid)
        };

        let response = thunderstore_api::request("GET", &path, None, None)
            .await
            .map_err(|e| anyhow::anyhow!("Thunderstore crate request failed: {}", e))?;

        if response.status == 404 {
            return Ok(None);
        }

        if !(200..300).contains(&response.status) {
            return Err(anyhow::anyhow!(
                "Thunderstore API returned {} for path {}",
                response.status,
                path
            ));
        }

        let package: Value = serde_json::from_slice(&response.body)
            .context("Failed to parse Thunderstore package from crate response")?;

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

        let path_and_query = Self::crate_download_path_from_url(download_url)?;

        let response = thunderstore_api::request("GET", &path_and_query, None, None)
            .await
            .map_err(|e| anyhow::anyhow!("Thunderstore crate download request failed: {}", e))?;

        if !(200..300).contains(&response.status) {
            return Err(anyhow::anyhow!(
                "Failed to download package via crate: status {}",
                response.status
            ));
        }

        Ok(response.body)
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

    #[test]
    fn crate_download_path_supports_thunderstore_url() {
        let url = "https://thunderstore.io/package/download/SirTidez/PackRat/1.0.3/";
        let path = ThunderStoreService::crate_download_path_from_url(url).expect("path conversion");
        assert_eq!(path, "/package/download/SirTidez/PackRat/1.0.3/");
    }

    #[test]
    fn crate_download_path_keeps_query_params() {
        let url = "https://www.thunderstore.io/package/download/SirTidez/PackRat/1.0.3/?token=abc";
        let path = ThunderStoreService::crate_download_path_from_url(url).expect("path conversion");
        assert_eq!(path, "/package/download/SirTidez/PackRat/1.0.3/?token=abc");
    }

    #[test]
    fn crate_download_path_rejects_non_thunderstore_host() {
        let url = "https://cdn.example.com/package/download/SirTidez/PackRat/1.0.3/";
        let err = ThunderStoreService::crate_download_path_from_url(url)
            .expect_err("expected unsupported host error");
        assert!(err.to_string().contains("non-thunderstore.io"));
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
    #[ignore]
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
