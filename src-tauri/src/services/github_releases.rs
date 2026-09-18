use crate::utils::http_identity;
use anyhow::{Context, Result};
use std::collections::HashSet;
use std::time::Duration;

const DEFAULT_RELEASE_API_BASE_URL: &str = "https://api.lockwirelabs.dev";
const MELONLOADER_NIGHTLY_RUNS_URL: &str = "https://api.github.com/repos/LavaGang/MelonLoader/actions/workflows/5411546/runs?branch=alpha-development&event=push&status=success&per_page=5";
const MELONLOADER_NIGHTLY_ARTIFACT_NAME: &str = "MelonLoader.Windows.x64.CI.Release.zip";
const PROVIDER_REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
const PROVIDER_CONNECT_TIMEOUT: Duration = Duration::from_secs(10);

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
            .user_agent(http_identity::user_agent())
            .connect_timeout(PROVIDER_CONNECT_TIMEOUT)
            .timeout(PROVIDER_REQUEST_TIMEOUT)
            .build()
            .expect("Failed to build releases HTTP client");

        Self { client, base_url }
    }

    fn latest_endpoint(owner: &str, repo: &str, include_prereleases: bool) -> Result<&'static str> {
        match (
            owner.to_ascii_lowercase().as_str(),
            repo.to_ascii_lowercase().as_str(),
        ) {
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
        match (
            owner.to_ascii_lowercase().as_str(),
            repo.to_ascii_lowercase().as_str(),
        ) {
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
        self.get_absolute_json(&url, endpoint).await
    }

    async fn get_absolute_json(&self, url: &str, description: &str) -> Result<serde_json::Value> {
        let response = self
            .client
            .get(url)
            .send()
            .await
            .with_context(|| format!("Failed to fetch {}", description))?;

        let status = response.status();
        let body = response
            .text()
            .await
            .with_context(|| format!("Failed to read response body for {}", description))?;

        if !status.is_success() {
            return Err(anyhow::anyhow!(
                "Release API request failed ({} {})",
                status.as_u16(),
                description
            ));
        }

        serde_json::from_str::<serde_json::Value>(&body)
            .with_context(|| format!("Invalid JSON from {}", description))
    }

    fn melonloader_nightly_release(run: &serde_json::Value) -> Option<serde_json::Value> {
        let run_id = run.get("id")?.as_u64()?;
        let run_name = run.get("name")?.as_str()?.trim();
        let tag_name = run_name
            .split_once('|')
            .map(|(tag, _)| tag)
            .unwrap_or(run_name)
            .trim();

        if tag_name.is_empty() || !tag_name.to_ascii_lowercase().contains("-ci.") {
            return None;
        }

        let name = run_name
            .split_once('|')
            .map(|(_, description)| description.trim())
            .filter(|description| !description.is_empty())
            .unwrap_or("MelonLoader nightly build");
        let published_at = run
            .get("created_at")
            .or_else(|| run.get("updated_at"))
            .and_then(|value| value.as_str())
            .unwrap_or_default();
        let html_url = run
            .get("html_url")
            .and_then(|value| value.as_str())
            .unwrap_or("https://github.com/LavaGang/MelonLoader/actions");
        let download_url = format!(
            "https://nightly.link/LavaGang/MelonLoader/actions/runs/{}/{}",
            run_id, MELONLOADER_NIGHTLY_ARTIFACT_NAME
        );

        Some(serde_json::json!({
            "tag_name": tag_name,
            "name": name,
            "body": format!("Nightly build from successful workflow run {}.", run_id),
            "published_at": published_at,
            "prerelease": true,
            "draft": false,
            "isNightly": true,
            "html_url": html_url,
            "workflow_run_id": run_id,
            "assets": [{
                "name": MELONLOADER_NIGHTLY_ARTIFACT_NAME,
                "browser_download_url": download_url
            }]
        }))
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
        releases.retain(|release| {
            !release
                .get("draft")
                .and_then(|v| v.as_bool())
                .unwrap_or(false)
        });

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

    pub async fn get_melonloader_nightly_builds(&self) -> Result<Vec<serde_json::Value>> {
        let payload = self
            .get_absolute_json(
                MELONLOADER_NIGHTLY_RUNS_URL,
                "MelonLoader nightly workflow runs",
            )
            .await?;
        let runs = payload
            .get("workflow_runs")
            .and_then(|value| value.as_array())
            .ok_or_else(|| {
                anyhow::anyhow!("MelonLoader nightly response did not contain workflow runs")
            })?;

        let mut seen_tags = HashSet::new();
        let mut releases = runs
            .iter()
            .filter_map(Self::melonloader_nightly_release)
            .filter(|release| {
                release
                    .get("tag_name")
                    .and_then(|value| value.as_str())
                    .map(|tag| seen_tags.insert(tag.to_string()))
                    .unwrap_or(false)
            })
            .collect::<Vec<_>>();

        releases.sort_by(|a, b| {
            let a_time = a
                .get("published_at")
                .and_then(|value| value.as_str())
                .unwrap_or_default();
            let b_time = b
                .get("published_at")
                .and_then(|value| value.as_str())
                .unwrap_or_default();
            b_time.cmp(a_time)
        });

        Ok(releases)
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
                        if let Some(url) =
                            asset.get("browser_download_url").and_then(|u| u.as_str())
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
                        if let Some(url) =
                            asset.get("browser_download_url").and_then(|u| u.as_str())
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

    #[test]
    fn s1api_release_endpoints_use_lockwire_routes() {
        assert_eq!(
            GitHubReleasesService::latest_endpoint("ifBars", "S1API", false)
                .expect("latest endpoint"),
            "/releases/s1api/latest"
        );
        assert_eq!(
            GitHubReleasesService::all_endpoint("ifBars", "S1API").expect("all endpoint"),
            "/releases/s1api/all"
        );
    }

    #[test]
    fn melonloader_nightly_release_maps_successful_workflow_metadata() {
        let release = GitHubReleasesService::melonloader_nightly_release(&serde_json::json!({
            "id": 33964714377_u64,
            "name": "0.7.4-ci.2581 | Backported Changes to v0.7.4 Hotfix",
            "created_at": "2026-09-05T11:57:49Z",
            "html_url": "https://github.com/LavaGang/MelonLoader/actions/runs/33964714377"
        }))
        .expect("nightly release");

        assert_eq!(release["tag_name"], "0.7.4-ci.2581");
        assert_eq!(release["name"], "Backported Changes to v0.7.4 Hotfix");
        assert_eq!(release["prerelease"], true);
        assert_eq!(release["isNightly"], true);
        assert_eq!(
            release["assets"][0]["browser_download_url"],
            "https://nightly.link/LavaGang/MelonLoader/actions/runs/33964714377/MelonLoader.Windows.x64.CI.Release.zip"
        );
    }

    #[test]
    fn melonloader_nightly_release_rejects_unversioned_workflow_runs() {
        let release = GitHubReleasesService::melonloader_nightly_release(&serde_json::json!({
            "id": 42,
            "name": "Documentation build",
            "created_at": "2026-09-05T11:57:49Z"
        }));

        assert!(release.is_none());
    }
}
