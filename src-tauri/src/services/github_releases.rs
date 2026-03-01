use anyhow::{Context, Result};

const DEFAULT_RELEASE_API_BASE_URL: &str = "https://api.lockwirelabs.dev";

#[derive(Clone)]
pub struct GitHubReleasesService {
    client: reqwest::Client,
    base_url: String,
}

impl GitHubReleasesService {
    pub fn new() -> Self {
        let base_url = std::env::var("LOCKWIRE_RELEASES_API_BASE_URL")
            .unwrap_or_else(|_| DEFAULT_RELEASE_API_BASE_URL.to_string())
            .trim_end_matches('/')
            .to_string();

        let client = reqwest::Client::builder()
            .user_agent("SIMM/1.0.0")
            .build()
            .unwrap_or_else(|_| reqwest::Client::new());

        Self { client, base_url }
    }

    fn latest_endpoint(owner: &str, repo: &str, include_prereleases: bool) -> Result<&'static str> {
        match (owner.to_ascii_lowercase().as_str(), repo.to_ascii_lowercase().as_str()) {
            ("lavagang", "melonloader") => {
                if include_prereleases {
                    Ok("/releases/melonloader/latest/prerelease")
                } else {
                    Ok("/releases/melonloader/latest/stable")
                }
            }
            ("ifbars", "s1api") => Ok("/releases/s1api/latest"),
            ("ifbars", "mlvscan") => Ok("/releases/mlvscan/latest"),
            _ => Err(anyhow::anyhow!(
                "Unsupported release source: {}/{}",
                owner,
                repo
            )),
        }
    }

    pub async fn get_health(&self) -> Result<serde_json::Value> {
        self.get_json("/health").await
    }

    fn all_endpoint(owner: &str, repo: &str) -> Result<&'static str> {
        match (owner.to_ascii_lowercase().as_str(), repo.to_ascii_lowercase().as_str()) {
            ("lavagang", "melonloader") => Ok("/releases/melonloader/all"),
            ("ifbars", "s1api") => Ok("/releases/s1api/all"),
            ("ifbars", "mlvscan") => Ok("/releases/mlvscan/all"),
            _ => Err(anyhow::anyhow!(
                "Unsupported release source: {}/{}",
                owner,
                repo
            )),
        }
    }

    async fn get_json(&self, endpoint: &str) -> Result<serde_json::Value> {
        let url = format!("{}{}", self.base_url, endpoint);
        let response = self
            .client
            .get(&url)
            .send()
            .await
            .with_context(|| format!("Failed to fetch release API endpoint {}", endpoint))?;

        let status = response.status();
        let body = response
            .text()
            .await
            .with_context(|| format!("Failed to read response body for {}", endpoint))?;

        if !status.is_success() {
            return Err(anyhow::anyhow!(
                "Release API request failed ({} {})",
                status.as_u16(),
                endpoint
            ));
        }

        serde_json::from_str::<serde_json::Value>(&body)
            .with_context(|| format!("Invalid JSON from release API endpoint {}", endpoint))
    }

    fn extract_release(value: serde_json::Value) -> Option<serde_json::Value> {
        if value.get("tag_name").is_some() {
            return Some(value);
        }

        for key in ["release", "data", "item"] {
            if let Some(candidate) = value.get(key) {
                if candidate.get("tag_name").is_some() {
                    return Some(candidate.clone());
                }
            }
        }

        None
    }

    fn extract_release_list(value: serde_json::Value) -> Vec<serde_json::Value> {
        if let Some(items) = value.as_array() {
            return items.to_vec();
        }

        for key in ["releases", "items", "data"] {
            if let Some(items) = value.get(key).and_then(|v| v.as_array()) {
                return items.to_vec();
            }
        }

        Vec::new()
    }

    fn normalize_release_list(
        mut releases: Vec<serde_json::Value>,
        include_prereleases: bool,
    ) -> Vec<serde_json::Value> {
        releases.retain(|release| !release.get("draft").and_then(|v| v.as_bool()).unwrap_or(false));

        if !include_prereleases {
            releases.retain(|release| {
                !release
                    .get("prerelease")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false)
            });
        }

        releases.sort_by(|a, b| {
            let a_time = a
                .get("published_at")
                .and_then(|v| v.as_str())
                .unwrap_or_default();
            let b_time = b
                .get("published_at")
                .and_then(|v| v.as_str())
                .unwrap_or_default();
            b_time.cmp(a_time)
        });

        releases
    }

    pub async fn get_latest_release(
        &self,
        owner: &str,
        repo: &str,
        include_prereleases: bool,
    ) -> Result<Option<serde_json::Value>> {
        let endpoint = Self::latest_endpoint(owner, repo, include_prereleases)?;
        let payload = self.get_json(endpoint).await?;
        Ok(Self::extract_release(payload))
    }

    pub async fn get_all_releases(
        &self,
        owner: &str,
        repo: &str,
        include_prereleases: bool,
    ) -> Result<Vec<serde_json::Value>> {
        let endpoint = Self::all_endpoint(owner, repo)?;
        let payload = self.get_json(endpoint).await?;
        let releases = Self::extract_release_list(payload);
        Ok(Self::normalize_release_list(releases, include_prereleases))
    }

    pub async fn get_all_releases_with_latest(
        &self,
        owner: &str,
        repo: &str,
        include_prereleases: bool,
    ) -> Result<Vec<serde_json::Value>> {
        let mut releases = self
            .get_all_releases(owner, repo, include_prereleases)
            .await?;

        if let Some(latest) = self
            .get_latest_release(owner, repo, include_prereleases)
            .await?
        {
            let latest_tag = latest
                .get("tag_name")
                .and_then(|v| v.as_str())
                .unwrap_or_default();

            let exists = releases.iter().any(|release| {
                release
                    .get("tag_name")
                    .and_then(|v| v.as_str())
                    .unwrap_or_default()
                    == latest_tag
            });

            if !exists {
                releases.push(latest);
            }
        }

        Ok(Self::normalize_release_list(releases, include_prereleases))
    }

    pub async fn download_release_asset(&self, url: &str) -> Result<Vec<u8>> {
        let response = self
            .client
            .get(url)
            .send()
            .await
            .context("Failed to download asset")?;

        if !response.status().is_success() {
            return Err(anyhow::anyhow!(
                "Failed to download asset: {}",
                response.status()
            ));
        }

        let bytes = response
            .bytes()
            .await
            .context("Failed to read response body")?;

        Ok(bytes.to_vec())
    }

    pub fn get_zip_asset_url(&self, release: &serde_json::Value) -> Option<String> {
        if let Some(assets) = release.get("assets").and_then(|a| a.as_array()) {
            for asset in assets {
                if let Some(name) = asset.get("name").and_then(|n| n.as_str()) {
                    if name.to_lowercase().ends_with(".zip") {
                        if let Some(url) = asset
                            .get("browser_download_url")
                            .and_then(|u| u.as_str())
                        {
                            return Some(url.to_string());
                        }
                    }
                }
            }
        }
        None
    }

    pub fn get_melonloader_x64_asset_url(&self, release: &serde_json::Value) -> Option<String> {
        if let Some(assets) = release.get("assets").and_then(|a| a.as_array()) {
            for asset in assets {
                if let Some(name) = asset.get("name").and_then(|n| n.as_str()) {
                    let name_lower = name.to_lowercase();
                    if name_lower.ends_with(".zip")
                        && (name_lower.contains(".x64")
                            || name_lower.contains("-x64")
                            || name_lower.contains("_x64"))
                        && !name_lower.contains(".so")
                        && !name_lower.contains("linux")
                        && !name_lower.contains("macos")
                        && !name_lower.contains("osx")
                    {
                        if let Some(url) = asset
                            .get("browser_download_url")
                            .and_then(|u| u.as_str())
                        {
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
        let service = GitHubReleasesService::new();
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
        let service = GitHubReleasesService::new();
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
}
