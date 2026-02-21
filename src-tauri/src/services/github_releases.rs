use anyhow::{Context, Result};
use octocrab::Octocrab;
use std::env;
use std::sync::Arc;
use tokio::sync::RwLock;

#[derive(Clone)]
pub struct GitHubReleasesService {
    client: Arc<RwLock<Option<Octocrab>>>,
    token: Arc<RwLock<Option<String>>>,
}

fn build_client_from_token(token: &Option<String>) -> Option<Octocrab> {
    if let Some(ref token_val) = token {
        Octocrab::builder()
            .personal_token(token_val.clone())
            .build()
            .ok()
    } else {
        Octocrab::builder().build().ok()
    }
}

impl GitHubReleasesService {
    pub fn new() -> Self {
        Self::with_token(None)
    }

    pub fn with_token(token: Option<String>) -> Self {
        // Try token parameter first, then env var
        // NEVER log the token value - only log that authentication is being used
        let token = token.or_else(|| env::var("GITHUB_TOKEN").ok());
        let client = build_client_from_token(&token);

        Self {
            client: Arc::new(RwLock::new(client)),
            token: Arc::new(RwLock::new(token)),
        }
    }

    /// Update the GitHub token. Pass None to explicitly disable authentication
    /// (ignoring any GITHUB_TOKEN environment variable). Pass Some(token) to use a specific token.
    pub async fn set_token(&self, token: Option<String>) {
        *self.token.write().await = token.clone();
        *self.client.write().await = build_client_from_token(&token);
    }

    pub async fn get_latest_release(&self, owner: &str, repo: &str, include_prereleases: bool) -> Result<Option<serde_json::Value>> {
        let client = self.client.read().await.clone()
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
        let client = self.client.read().await.clone()
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

        // Add authentication if available.
        // NEVER log the token value.
        if let Some(token) = self.token.read().await.as_ref() {
            request = request.bearer_auth(token);
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
impl GitHubReleasesService {
    /// Creates a service with no client/token for unit tests that don't need API access.
    /// Avoids Octocrab builder which requires a Tokio runtime.
    fn for_testing() -> Self {
        Self {
            client: Arc::new(RwLock::new(None)),
            token: Arc::new(RwLock::new(None)),
        }
    }

    pub async fn current_token_for_testing(&self) -> Option<String> {
        self.token.read().await.clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serial_test::serial;

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

    #[test]
    fn get_zip_asset_url_picks_first_zip() {
        let service = GitHubReleasesService::for_testing();
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
        let service = GitHubReleasesService::for_testing();
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
        let service = GitHubReleasesService::for_testing();
        let release = serde_json::json!({ "assets": [] });
        assert!(service.get_zip_asset_url(&release).is_none());
    }

    #[tokio::test]
    #[serial]
    async fn with_token_none_uses_env_token_by_default() {
        let _guard = EnvVarGuard::set("GITHUB_TOKEN", "env-token");
        let service = GitHubReleasesService::with_token(None);

        let token = service.token.read().await.clone();
        assert_eq!(token.as_deref(), Some("env-token"));
    }

    #[tokio::test]
    #[serial]
    async fn set_token_none_explicitly_disables_auth_even_with_env_token() {
        let _guard = EnvVarGuard::set("GITHUB_TOKEN", "env-token");
        let service = GitHubReleasesService::new();

        service.set_token(None).await;

        let token = service.token.read().await.clone();
        assert!(token.is_none());
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
