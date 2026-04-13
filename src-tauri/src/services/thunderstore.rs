use anyhow::{Context, Result};
use serde_json::Value;
use std::cmp::Ordering;

#[derive(Clone)]
pub struct ThunderStoreService;

impl ThunderStoreService {
    pub fn new() -> Self {
        Self
    }

    fn normalize_version_token(value: &str) -> String {
        value
            .trim()
            .trim_start_matches(['v', 'V'])
            .to_ascii_lowercase()
    }

    fn extract_thunderstore_numeric_parts(value: &str) -> Vec<u32> {
        let normalized = Self::normalize_version_token(value);
        let core = normalized.split(['-', '+']).next().unwrap_or_default();
        core.split('.')
            .filter(|segment| !segment.is_empty())
            .map(|segment| segment.parse::<u32>().unwrap_or(0))
            .collect()
    }

    fn compare_versions(left: &str, right: &str) -> Ordering {
        let left_parts = Self::extract_thunderstore_numeric_parts(left);
        let right_parts = Self::extract_thunderstore_numeric_parts(right);
        let len = left_parts.len().max(right_parts.len());

        for index in 0..len {
            let left_part = left_parts.get(index).copied().unwrap_or(0);
            let right_part = right_parts.get(index).copied().unwrap_or(0);
            match left_part.cmp(&right_part) {
                Ordering::Equal => {}
                ordering => return ordering,
            }
        }

        let left_lower = Self::normalize_version_token(left);
        let right_lower = Self::normalize_version_token(right);
        let left_prerelease = left_lower.contains("alpha")
            || left_lower.contains("beta")
            || left_lower.contains("preview")
            || left_lower.contains("pre")
            || left_lower.contains("rc");
        let right_prerelease = right_lower.contains("alpha")
            || right_lower.contains("beta")
            || right_lower.contains("preview")
            || right_lower.contains("pre")
            || right_lower.contains("rc");
        match (left_prerelease, right_prerelease) {
            (true, false) => Ordering::Less,
            (false, true) => Ordering::Greater,
            _ => Ordering::Equal,
        }
    }

    fn select_package_version<'a>(
        versions: &'a [Value],
        version_uuid: Option<&str>,
    ) -> Option<&'a Value> {
        if let Some(target_version_uuid) = version_uuid {
            return versions.iter().find(|version| {
                version.get("uuid4").and_then(|value| value.as_str()) == Some(target_version_uuid)
            });
        }

        versions.iter().max_by(|left, right| {
            let left_version = left
                .get("version_number")
                .and_then(|value| value.as_str())
                .unwrap_or_default();
            let right_version = right
                .get("version_number")
                .and_then(|value| value.as_str())
                .unwrap_or_default();
            match Self::compare_versions(left_version, right_version) {
                Ordering::Equal => {
                    let left_updated = left
                        .get("date_updated")
                        .or_else(|| left.get("date_created"))
                        .and_then(|value| value.as_str())
                        .unwrap_or_default();
                    let right_updated = right
                        .get("date_updated")
                        .or_else(|| right.get("date_created"))
                        .and_then(|value| value.as_str())
                        .unwrap_or_default();
                    left_updated.cmp(right_updated)
                }
                ordering => ordering,
            }
        })
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
                    let name = pkg
                        .get("name")
                        .and_then(|n| n.as_str())
                        .unwrap_or("")
                        .to_lowercase();
                    let full_name = pkg
                        .get("latest")
                        .and_then(|l| l.get("full_name"))
                        .and_then(|n| n.as_str())
                        .unwrap_or("")
                        .to_lowercase();
                    let owner = pkg
                        .get("owner")
                        .and_then(|o| o.as_str())
                        .unwrap_or("")
                        .to_lowercase();
                    let description = pkg
                        .get("latest")
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
            let other_runtime = if runtime_lower == "il2cpp" {
                "mono"
            } else {
                "il2cpp"
            };

            packages.retain(|pkg| {
                let name = pkg
                    .get("name")
                    .and_then(|n| n.as_str())
                    .unwrap_or("")
                    .to_lowercase();
                let full_name = pkg
                    .get("latest")
                    .and_then(|l| l.get("full_name"))
                    .and_then(|n| n.as_str())
                    .unwrap_or("")
                    .to_lowercase();

                // Check categories/tags for runtime compatibility
                // Packages can have categories like "il2cpp", "mono", "client-side", etc.
                let has_target_runtime_category = pkg
                    .get("categories")
                    .and_then(|c| c.as_array())
                    .map(|cats| {
                        cats.iter().any(|cat| {
                            cat.as_str()
                                .map(|s| s.to_lowercase() == runtime_lower)
                                .unwrap_or(false)
                        })
                    })
                    .unwrap_or(false);

                let has_other_runtime_category = pkg
                    .get("categories")
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
                name.contains(&runtime_lower)
                    || full_name.contains(&runtime_lower)
                    || (!name.contains("il2cpp")
                        && !name.contains("mono")
                        && !full_name.contains("il2cpp")
                        && !full_name.contains("mono"))
            });
        }

        // Filter out deprecated packages
        packages.retain(|pkg| {
            !pkg.get("is_deprecated")
                .and_then(|d| d.as_bool())
                .unwrap_or(false)
                && !pkg
                    .get("latest")
                    .and_then(|l| l.get("is_deprecated"))
                    .and_then(|d| d.as_bool())
                    .unwrap_or(false)
        });

        Ok(packages)
    }

    pub async fn get_package(
        &self,
        package_uuid: &str,
        game_id: Option<&str>,
    ) -> Result<Option<serde_json::Value>> {
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

    pub async fn download_package(
        &self,
        package_uuid: &str,
        game_id: Option<&str>,
        version_uuid: Option<&str>,
    ) -> Result<Vec<u8>> {
        // First get package info to find download URL
        let package = self
            .get_package(package_uuid, game_id)
            .await?
            .ok_or_else(|| anyhow::anyhow!("Package not found"))?;

        let versions = package
            .get("versions")
            .and_then(|v| v.as_array())
            .ok_or_else(|| anyhow::anyhow!("Download URL not found in package versions"))?;

        let selected_version = Self::select_package_version(versions, version_uuid)
            .ok_or_else(|| anyhow::anyhow!("Selected package version was not found"))?;

        let download_url = selected_version
            .get("download_url")
            .and_then(|u| u.as_str())
            .ok_or_else(|| anyhow::anyhow!("Download URL not found in package version"))?;

        let response = thunderstore_api::request_url("GET", download_url, None, None)
            .await
            .map_err(|e| {
                anyhow::anyhow!("Thunderstore crate absolute download request failed: {}", e)
            })?;

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

    #[test]
    fn select_package_version_prefers_highest_semver_when_no_uuid_is_provided() {
        let versions = vec![
            serde_json::json!({
                "uuid4": "v1",
                "version_number": "1.1.0",
                "date_updated": "2026-04-01T00:00:00Z"
            }),
            serde_json::json!({
                "uuid4": "v2",
                "version_number": "1.3.0",
                "date_updated": "2026-04-02T00:00:00Z"
            }),
            serde_json::json!({
                "uuid4": "v3",
                "version_number": "1.2.5",
                "date_updated": "2026-04-03T00:00:00Z"
            }),
        ];

        let selected =
            ThunderStoreService::select_package_version(&versions, None).expect("selected version");

        assert_eq!(
            selected.get("uuid4").and_then(|value| value.as_str()),
            Some("v2")
        );
    }

    #[test]
    fn select_package_version_prefers_requested_uuid_over_latest_version() {
        let versions = vec![
            serde_json::json!({
                "uuid4": "old",
                "version_number": "1.0.0",
                "date_updated": "2026-04-01T00:00:00Z"
            }),
            serde_json::json!({
                "uuid4": "new",
                "version_number": "2.0.0",
                "date_updated": "2026-04-02T00:00:00Z"
            }),
        ];

        let selected = ThunderStoreService::select_package_version(&versions, Some("old"))
            .expect("selected version");

        assert_eq!(
            selected
                .get("version_number")
                .and_then(|value| value.as_str()),
            Some("1.0.0")
        );
    }

    #[test]
    fn select_package_version_keeps_normal_semver_for_multi_digit_patch_numbers() {
        let versions = vec![
            serde_json::json!({
                "uuid4": "stable-9",
                "version_number": "1.0.9",
                "date_updated": "2026-04-01T00:00:00Z"
            }),
            serde_json::json!({
                "uuid4": "stable-10",
                "version_number": "1.0.10",
                "date_updated": "2026-04-02T00:00:00Z"
            }),
        ];

        let selected =
            ThunderStoreService::select_package_version(&versions, None).expect("selected version");

        assert_eq!(
            selected.get("uuid4").and_then(|value| value.as_str()),
            Some("stable-10")
        );
        assert_eq!(
            selected
                .get("version_number")
                .and_then(|value| value.as_str()),
            Some("1.0.10")
        );
    }
}
