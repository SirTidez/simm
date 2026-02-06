use anyhow::{Context, Result};
use octocrab::Octocrab;
use std::env;

#[derive(Clone)]
pub struct GitHubReleasesService {
    client: Option<Octocrab>,
    token: Option<String>,
}

impl GitHubReleasesService {
    pub fn new() -> Self {
        Self::with_token(None)
    }

    pub fn with_token(token: Option<String>) -> Self {
        // Try token parameter first, then env var
        // NEVER log the token value - only log that authentication is being used
        let token = token
            .or_else(|| env::var("GITHUB_TOKEN").ok());

        let client = if let Some(ref token_val) = token {
            // Token is present - use it but never log it
            Octocrab::builder()
                .personal_token(token_val.clone())
                .build()
                .ok()
        } else {
            Octocrab::builder().build().ok()
        };

        Self { client, token }
    }

    pub async fn get_latest_release(&self, owner: &str, repo: &str, include_prereleases: bool) -> Result<Option<serde_json::Value>> {
        let client = self.client.as_ref()
            .ok_or_else(|| anyhow::anyhow!("Failed to initialize GitHub client"))?;

        let releases = client
            .repos(owner, repo)
            .releases()
            .list()
            .per_page(10)
            .send()
            .await
            .context("Failed to fetch releases")?;

        let mut filtered: Vec<_> = releases.items.into_iter().collect();

        if !include_prereleases {
            filtered.retain(|r| !r.prerelease);
        }

        if filtered.is_empty() {
            return Ok(None);
        }

        let latest = &filtered[0];
        Ok(Some(serde_json::json!({
            "tag_name": latest.tag_name,
            "name": latest.name.as_ref().unwrap_or(&latest.tag_name),
            "published_at": latest.published_at,
            "prerelease": latest.prerelease,
            "assets": latest.assets.iter().map(|asset| serde_json::json!({
                "name": asset.name,
                "browser_download_url": asset.browser_download_url,
                "size": asset.size,
                "content_type": &asset.content_type
            })).collect::<Vec<_>>(),
                "body": latest.body.as_ref().map(|s| s.as_str())
        })))
    }

    pub async fn get_all_releases(&self, owner: &str, repo: &str, include_prereleases: bool) -> Result<Vec<serde_json::Value>> {
        let client = self.client.as_ref()
            .ok_or_else(|| anyhow::anyhow!("Failed to initialize GitHub client"))?;

        let releases = client
            .repos(owner, repo)
            .releases()
            .list()
            .per_page(100)
            .send()
            .await
            .context("Failed to fetch releases")?;

        let mut filtered: Vec<_> = releases.items.into_iter().collect();

        if !include_prereleases {
            filtered.retain(|r| !r.prerelease);
        }

        Ok(filtered.into_iter().map(|release| {
            serde_json::json!({
                "tag_name": release.tag_name,
                "name": release.name.as_ref().unwrap_or(&release.tag_name),
                "published_at": release.published_at,
                "prerelease": release.prerelease,
                "assets": release.assets.iter().map(|asset| serde_json::json!({
                    "name": asset.name,
                    "browser_download_url": asset.browser_download_url,
                    "size": asset.size,
                    "content_type": &asset.content_type
                })).collect::<Vec<_>>(),
                "body": release.body.as_ref().map(|s| s.as_str())
            })
        }).collect())
    }

    pub async fn download_release_asset(&self, url: &str) -> Result<Vec<u8>> {
        let client = reqwest::Client::builder()
            .user_agent("Schedule-I-DevEnvManager/1.0.0")
            .build()
            .context("Failed to create HTTP client")?;

        let mut request = client.get(url);

        // Add authentication if available (try stored token, then env var)
        // NEVER log the token value
        if let Some(token) = self.token.as_ref() {
            request = request.bearer_auth(token);
        } else if let Ok(env_token) = env::var("GITHUB_TOKEN") {
            request = request.bearer_auth(&env_token);
        }

        let response = request
            .send()
            .await
            .context("Failed to download asset")?;

        if !response.status().is_success() {
            return Err(anyhow::anyhow!("Failed to download asset: {}", response.status()));
        }

        let bytes = response.bytes().await
            .context("Failed to read response body")?;

        Ok(bytes.to_vec())
    }

    pub fn get_zip_asset_url(&self, release: &serde_json::Value) -> Option<String> {
        if let Some(assets) = release.get("assets").and_then(|a| a.as_array()) {
            for asset in assets {
                if let Some(name) = asset.get("name").and_then(|n| n.as_str()) {
                    if name.to_lowercase().ends_with(".zip") {
                        if let Some(url) = asset.get("browser_download_url").and_then(|u| u.as_str()) {
                            return Some(url.to_string());
                        }
                    }
                }
            }
        }
        None
    }

    /// Get the Windows x64 ZIP asset URL for MelonLoader releases
    /// Looks for assets named like "MelonLoader.x64.zip" or "MelonLoader-x64.zip"
    pub fn get_melonloader_x64_asset_url(&self, release: &serde_json::Value) -> Option<String> {
        if let Some(assets) = release.get("assets").and_then(|a| a.as_array()) {
            for asset in assets {
                if let Some(name) = asset.get("name").and_then(|n| n.as_str()) {
                    let name_lower = name.to_lowercase();
                    // Look for Windows x64 assets - common patterns:
                    // - MelonLoader.x64.zip
                    // - MelonLoader-x64.zip
                    // - MelonLoader_x64.zip
                    // - MelonLoader.x64-<version>.zip
                    if name_lower.ends_with(".zip")
                        && (name_lower.contains(".x64") || name_lower.contains("-x64") || name_lower.contains("_x64"))
                        && !name_lower.contains(".so") // Exclude Linux files
                        && !name_lower.contains("linux")
                        && !name_lower.contains("macos")
                        && !name_lower.contains("osx") {
                        if let Some(url) = asset.get("browser_download_url").and_then(|u| u.as_str()) {
                            return Some(url.to_string());
                        }
                    }
                }
            }
        }
        None
    }
}

impl Default for GitHubReleasesService {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn get_zip_asset_url_picks_first_zip() {
        let service = GitHubReleasesService { client: None, token: None };
        let release = serde_json::json!({
            "assets": [
                {"name": "file.tar.gz", "browser_download_url": "https://example.com/file.tar.gz"},
                {"name": "alpha.zip", "browser_download_url": "https://example.com/alpha.zip"},
                {"name": "beta.zip", "browser_download_url": "https://example.com/beta.zip"}
            ]
        });

        let url = service.get_zip_asset_url(&release);
        assert_eq!(url.as_deref(), Some("https://example.com/alpha.zip"));
    }

    #[test]
    fn get_melonloader_x64_asset_url_filters_non_windows_assets() {
        let service = GitHubReleasesService { client: None, token: None };
        let release = serde_json::json!({
            "assets": [
                {"name": "MelonLoader.linux.x64.zip", "browser_download_url": "https://example.com/linux.zip"},
                {"name": "MelonLoader.x64.zip", "browser_download_url": "https://example.com/windows.zip"},
                {"name": "MelonLoader.macos.x64.zip", "browser_download_url": "https://example.com/macos.zip"}
            ]
        });

        let url = service.get_melonloader_x64_asset_url(&release);
        assert_eq!(url.as_deref(), Some("https://example.com/windows.zip"));
    }

    #[test]
    fn get_zip_asset_url_returns_none_when_missing() {
        let service = GitHubReleasesService { client: None, token: None };
        let release = serde_json::json!({ "assets": [] });
        assert!(service.get_zip_asset_url(&release).is_none());
    }

    /// Performs a real GitHub API request. Run with: cargo test -- --ignored
    #[tokio::test]
    #[ignore]
    async fn live_get_latest_release_returns_data() -> Result<()> {
        let service = GitHubReleasesService::new();
        let release = service
            .get_latest_release("tauri-apps", "tauri", false)
            .await?;

        let release = release.expect("expected release data");
        assert!(release.get("tag_name").is_some());

        Ok(())
    }

    /// Performs a real GitHub API request. Run with: cargo test -- --ignored
    #[tokio::test]
    #[ignore]
    async fn live_get_latest_release_invalid_repo_errors() -> Result<()> {
        let service = GitHubReleasesService::new();
        let result = service
            .get_latest_release("tauri-apps", "this-repo-should-not-exist-123", false)
            .await;

        assert!(result.is_err());
        Ok(())
    }
}
