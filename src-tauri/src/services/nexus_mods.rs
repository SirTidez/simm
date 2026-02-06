use anyhow::{Context, Result};
use reqwest::Client;
use serde_json::Value;
use std::sync::Arc;
use tokio::sync::RwLock;

const NEXUS_MODS_API_BASE: &str = "https://api.nexusmods.com/v1";

#[derive(Clone)]
pub struct NexusModsService {
    client: Arc<Client>,
    api_key: Arc<RwLock<Option<String>>>,
    validation_result: Arc<RwLock<Option<Value>>>,
}

impl NexusModsService {
    pub fn new() -> Self {
        Self {
            client: Arc::new(Client::builder()
                .user_agent("Schedule-I-DevEnvManager/1.0.0")
                .build()
                .unwrap_or_else(|_| Client::new())),
            api_key: Arc::new(RwLock::new(None)),
            validation_result: Arc::new(RwLock::new(None)),
        }
    }

    pub async fn set_api_key(&self, api_key: String) {
        *self.api_key.write().await = Some(api_key);
        // Clear validation result when API key changes
        *self.validation_result.write().await = None;
    }

    pub async fn clear_api_key(&self) {
        *self.api_key.write().await = None;
        *self.validation_result.write().await = None;
    }

    pub async fn get_api_key_optional(&self) -> Option<String> {
        self.api_key.read().await.clone()
    }

    pub async fn validate_api_key(&self) -> Result<Value> {
        let api_key = self.api_key.read().await.clone()
            .ok_or_else(|| anyhow::anyhow!("API key not set"))?;

        // Use NexusMods REST API to validate
        let response = self.client
            .get("https://api.nexusmods.com/v1/users/validate.json")
            .header("apikey", &api_key)
            .header("Application-Name", "Schedule-I-DevEnvManager")
            .header("Application-Version", "1.0.0")
            .header("Protocol-Version", "1")
            .send()
            .await
            .context("Failed to validate API key")?;

        if !response.status().is_success() {
            return Err(anyhow::anyhow!("Invalid API key: {}", response.status()));
        }

        let validation: Value = response.json().await
            .context("Failed to parse validation response")?;

        // Store validation result
        *self.validation_result.write().await = Some(validation.clone());

        Ok(validation)
    }

    pub async fn get_rate_limits(&self) -> Result<Value> {
        let api_key = self.api_key.read().await.clone()
            .ok_or_else(|| anyhow::anyhow!("API key not set"))?;

        // Get rate limit info from headers
        let response = self.client
            .get("https://api.nexusmods.com/v1/users/validate.json")
            .header("apikey", &api_key)
            .header("Application-Name", "Schedule-I-DevEnvManager")
            .header("Application-Version", "1.0.0")
            .header("Protocol-Version", "1")
            .send()
            .await
            .context("Failed to get rate limits")?;

        let daily = response.headers()
            .get("x-rl-daily-limit")
            .and_then(|v| v.to_str().ok())
            .and_then(|s| s.parse::<u32>().ok())
            .unwrap_or(0);

        let hourly = response.headers()
            .get("x-rl-hourly-limit")
            .and_then(|v| v.to_str().ok())
            .and_then(|s| s.parse::<u32>().ok())
            .unwrap_or(0);

        Ok(serde_json::json!({
            "daily": daily,
            "hourly": hourly
        }))
    }

    #[allow(dead_code)]
    pub async fn get_validation_result(&self) -> Option<Value> {
        self.validation_result.read().await.clone()
    }

    /// Get API key from internal storage or return error
    async fn get_api_key(&self) -> Result<String> {
        self.api_key.read().await.clone()
            .ok_or_else(|| anyhow::anyhow!("API key not set"))
    }

    /// Get list of all games supported by NexusMods
    pub async fn get_games(&self) -> Result<Vec<Value>> {
        let api_key = self.get_api_key().await?;

        let url = format!("{}/games.json", NEXUS_MODS_API_BASE);

        let response = self.client
            .get(&url)
            .header("apikey", &api_key)
            .header("Application-Name", "Schedule-I-DevEnvManager")
            .header("Application-Version", "1.0.0")
            .header("Protocol-Version", "1")
            .send()
            .await
            .context("Failed to fetch games list")?;

        if !response.status().is_success() {
            return Err(anyhow::anyhow!("NexusMods API returned {}", response.status()));
        }

        let games: Vec<Value> = response.json().await
            .context("Failed to parse games list response")?;

        Ok(games)
    }

    /// Search for mods on NexusMods using GraphQL API v2
    /// Note: Runtime filtering is not done at search time since NexusMods uses separate files
    /// for different runtimes rather than tags. Files should be filtered by runtime when displayed.
    pub async fn search_mods(
        &self,
        game_domain: &str,
        query: &str,
    ) -> Result<Vec<Value>> {
        let api_key = self.get_api_key().await?;

        // Use GraphQL API v2 for searching
        let graphql_url = "https://api.nexusmods.com/v2/graphql";

        // Build proper GraphQL query for mod search using ModsFilter
        let graphql_query = serde_json::json!({
            "query": r#"
                query SearchMods($filter: ModsFilter, $offset: Int, $count: Int) {
                    mods(filter: $filter, offset: $offset, count: $count) {
                        nodes {
                            modId
                            name
                            summary
                            pictureUrl
                            thumbnailUrl
                            endorsements
                            downloads
                            version
                            author
                            updatedAt
                            createdAt
                            game {
                                domainName
                                name
                            }
                            uploader {
                                name
                                memberId
                            }
                        }
                        totalCount
                        nodesCount
                    }
                }
            "#,
            "variables": {
                "filter": {
                    "gameDomainName": [{"value": game_domain, "op": "EQUALS"}],
                    "nameStemmed": [{"value": query, "op": "MATCHES"}]
                },
                "offset": 0,
                "count": 100
            }
        });

        let response = self.client
            .post(graphql_url)
            .header("apikey", &api_key)
            .header("Application-Name", "Schedule-I-DevEnvManager")
            .header("Application-Version", "1.0.0")
            .header("Content-Type", "application/json")
            .json(&graphql_query)
            .send()
            .await
            .context("Failed to send GraphQL search request")?;

        if !response.status().is_success() {
            let status = response.status();
            let error_body = response.text().await.unwrap_or_else(|_| "Unable to read error response".to_string());

            return Err(anyhow::anyhow!(
                "NexusMods GraphQL API returned {} for game domain '{}'. Error: {}",
                status,
                game_domain,
                error_body
            ));
        }

        let response_data: Value = response.json().await
            .context("Failed to parse GraphQL response")?;

        // Check for GraphQL errors
        if let Some(errors) = response_data.get("errors") {
            return Err(anyhow::anyhow!(
                "GraphQL query returned errors: {}",
                errors
            ));
        }

        // Extract mods from GraphQL response
        let mods = response_data
            .get("data")
            .and_then(|d| d.get("mods"))
            .and_then(|m| m.get("nodes"))
            .and_then(|n| n.as_array())
            .map(|arr| arr.clone())
            .unwrap_or_default();

        Ok(mods)
    }

    /// Get latest added mods using REST API v1
    pub async fn get_latest_added_mods(&self, game_id: &str) -> Result<Vec<Value>> {
        let api_key = self.get_api_key().await?;

        let url = format!("{}/games/{}/mods/latest_added.json", NEXUS_MODS_API_BASE, game_id);

        let response = self.client
            .get(&url)
            .header("apikey", &api_key)
            .header("Application-Name", "Schedule-I-DevEnvManager")
            .header("Application-Version", "1.0.0")
            .header("Protocol-Version", "1")
            .send()
            .await
            .context("Failed to fetch latest added mods")?;

        if !response.status().is_success() {
            return Err(anyhow::anyhow!("NexusMods API returned {}", response.status()));
        }

        let mods: Vec<Value> = response.json().await
            .context("Failed to parse latest added mods response")?;

        Ok(mods)
    }

    /// Get latest updated mods using REST API v1
    pub async fn get_latest_updated_mods(&self, game_id: &str) -> Result<Vec<Value>> {
        let api_key = self.get_api_key().await?;

        let url = format!("{}/games/{}/mods/latest_updated.json", NEXUS_MODS_API_BASE, game_id);

        let response = self.client
            .get(&url)
            .header("apikey", &api_key)
            .header("Application-Name", "Schedule-I-DevEnvManager")
            .header("Application-Version", "1.0.0")
            .header("Protocol-Version", "1")
            .send()
            .await
            .context("Failed to fetch latest updated mods")?;

        if !response.status().is_success() {
            return Err(anyhow::anyhow!("NexusMods API returned {}", response.status()));
        }

        let mods: Vec<Value> = response.json().await
            .context("Failed to parse latest updated mods response")?;

        Ok(mods)
    }

    /// Get trending mods using REST API v1
    pub async fn get_trending_mods(&self, game_id: &str) -> Result<Vec<Value>> {
        let api_key = self.get_api_key().await?;

        let url = format!("{}/games/{}/mods/trending.json", NEXUS_MODS_API_BASE, game_id);

        let response = self.client
            .get(&url)
            .header("apikey", &api_key)
            .header("Application-Name", "Schedule-I-DevEnvManager")
            .header("Application-Version", "1.0.0")
            .header("Protocol-Version", "1")
            .send()
            .await
            .context("Failed to fetch trending mods")?;

        if !response.status().is_success() {
            return Err(anyhow::anyhow!("NexusMods API returned {}", response.status()));
        }

        let mods: Vec<Value> = response.json().await
            .context("Failed to parse trending mods response")?;

        Ok(mods)
    }

    /// Get mod details by ID
    pub async fn get_mod(&self, game_id: &str, mod_id: u32) -> Result<Value> {
        let api_key = self.get_api_key().await?;

        let url = format!("{}/games/{}/mods/{}.json", NEXUS_MODS_API_BASE, game_id, mod_id);

        let response = self.client
            .get(&url)
            .header("apikey", &api_key)
            .header("Application-Name", "Schedule-I-DevEnvManager")
            .header("Application-Version", "1.0.0")
            .header("Protocol-Version", "1")
            .send()
            .await
            .context("Failed to fetch NexusMods mod")?;

        if !response.status().is_success() {
            return Err(anyhow::anyhow!("NexusMods API returned {}", response.status()));
        }

        let mod_data: Value = response.json().await
            .context("Failed to parse NexusMods mod response")?;

        Ok(mod_data)
    }

    /// Get mod files by mod ID
    pub async fn get_mod_files(&self, game_id: &str, mod_id: u32) -> Result<Vec<Value>> {
        let api_key = self.get_api_key().await?;

        let url = format!("{}/games/{}/mods/{}/files.json", NEXUS_MODS_API_BASE, game_id, mod_id);

        let response = self.client
            .get(&url)
            .header("apikey", &api_key)
            .header("Application-Name", "Schedule-I-DevEnvManager")
            .header("Application-Version", "1.0.0")
            .header("Protocol-Version", "1")
            .send()
            .await
            .context("Failed to fetch NexusMods mod files")?;

        if !response.status().is_success() {
            return Err(anyhow::anyhow!("NexusMods API returned {}", response.status()));
        }

        let response_data: Value = response.json().await
            .context("Failed to parse NexusMods mod files response")?;

        // The API returns an object with a "files" array, not a direct array
        let files = response_data
            .get("files")
            .and_then(|f| f.as_array())
            .map(|arr| arr.clone())
            .unwrap_or_default();

        Ok(files)
    }

    /// Check if a mod has an update available
    /// Compares the current_version with the latest version on NexusMods
    pub async fn check_mod_update(
        &self,
        game_domain: &str,
        mod_id: u32,
        current_version: &str,
    ) -> Result<Value> {
        // Get the latest mod info from NexusMods
        let mod_data = self.get_mod(game_domain, mod_id).await?;

        let latest_version = mod_data
            .get("version")
            .and_then(|v| v.as_str())
            .unwrap_or("");

        let has_update = latest_version != current_version && !latest_version.is_empty();

        Ok(serde_json::json!({
            "hasUpdate": has_update,
            "currentVersion": current_version,
            "latestVersion": latest_version,
            "modId": mod_id,
            "modName": mod_data.get("name").and_then(|n| n.as_str()).unwrap_or(""),
            "updatedAt": mod_data.get("updated_timestamp"),
        }))
    }

    /// Batch check multiple mods for updates
    /// Returns a list of mods with update information
    pub async fn check_mods_for_updates(
        &self,
        game_domain: &str,
        mods: Vec<(u32, String)>, // Vec of (mod_id, current_version)
    ) -> Result<Vec<Value>> {
        let mut results = Vec::new();

        for (mod_id, current_version) in mods {
            match self.check_mod_update(game_domain, mod_id, &current_version).await {
                Ok(update_info) => results.push(update_info),
                Err(e) => {
                    // Log error but continue checking other mods
                    eprintln!("Failed to check update for mod {}: {}", mod_id, e);
                    results.push(serde_json::json!({
                        "hasUpdate": false,
                        "currentVersion": current_version,
                        "latestVersion": "",
                        "modId": mod_id,
                        "error": e.to_string(),
                    }));
                }
            }
        }

        Ok(results)
    }

    /// Download mod file by mod ID and file ID
    pub async fn download_mod_file(
        &self,
        game_id: &str,
        mod_id: u32,
        file_id: u32,
    ) -> Result<Vec<u8>> {
        let api_key = self.get_api_key().await?;

        // First get download link
        let url = format!("{}/games/{}/mods/{}/files/{}/download_link.json",
            NEXUS_MODS_API_BASE, game_id, mod_id, file_id);

        let response = self.client
            .get(&url)
            .header("apikey", &api_key)
            .header("Application-Name", "Schedule-I-DevEnvManager")
            .header("Application-Version", "1.0.0")
            .header("Protocol-Version", "1")
            .send()
            .await
            .context("Failed to get download link")?;

        if !response.status().is_success() {
            return Err(anyhow::anyhow!("Failed to get download link: {}", response.status()));
        }

        let download_data: Value = response.json().await
            .context("Failed to parse download link response")?;

        // Log the response for debugging
        eprintln!("[NexusMods] Download link response: {}", serde_json::to_string_pretty(&download_data).unwrap_or_default());

        // The response is an array of download link objects
        let download_url = download_data
            .as_array()
            .and_then(|arr| arr.first())
            .and_then(|obj| obj.get("URI"))
            .and_then(|u| u.as_str())
            .ok_or_else(|| anyhow::anyhow!("Download URL not found in response. Response was: {}", download_data))?;

        // Download the file
        let file_response = self.client
            .get(download_url)
            .header("apikey", &api_key)
            .header("Application-Name", "Schedule-I-DevEnvManager")
            .header("Application-Version", "1.0.0")
            .header("Protocol-Version", "1")
            .send()
            .await
            .context("Failed to download mod file")?;

        if !file_response.status().is_success() {
            return Err(anyhow::anyhow!("Failed to download file: {}", file_response.status()));
        }

        let bytes = file_response.bytes().await
            .context("Failed to read response body")?;

        Ok(bytes.to_vec())
    }
}

impl Default for NexusModsService {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::get_data_dir;
    use crate::services::settings::SettingsService;
    use serial_test::serial;
    use sqlx::sqlite::SqliteConnectOptions;
    use sqlx::SqlitePool;
    use std::str::FromStr;
    use std::sync::Arc;

    async fn resolve_api_key() -> Result<Option<String>> {
        if let Ok(key) = std::env::var("NEXUSMODS_API_KEY") {
            if !key.trim().is_empty() {
                return Ok(Some(key));
            }
        }

        let data_dir = match get_data_dir() {
            Ok(dir) => dir,
            Err(_) => return Ok(None),
        };
        let db_path = data_dir.join("simmrust.db");
        if !db_path.exists() {
            return Ok(None);
        }

        let db_url = format!("sqlite://{}", db_path.to_string_lossy().replace('\\', "/"));
        let options = SqliteConnectOptions::from_str(&db_url)
            .context("Failed to build sqlite options")?
            .read_only(true);
        let pool = SqlitePool::connect_with(options)
            .await
            .context("Failed to open settings database")?;
        let service = SettingsService::new(Arc::new(pool))?;

        match service.get_nexus_mods_api_key().await {
            Ok(Some(key)) if !key.trim().is_empty() => Ok(Some(key)),
            Ok(_) => Ok(None),
            Err(_) => Ok(None),
        }
    }

    #[tokio::test]
    #[serial]
    async fn live_validate_api_key_and_rate_limits() -> Result<()> {
        let api_key = match resolve_api_key().await? {
            Some(key) => key,
            None => return Ok(()),
        };

        let service = NexusModsService::new();
        service.set_api_key(api_key).await;

        let validation = service.validate_api_key().await?;
        assert!(validation.is_object());

        let limits = service.get_rate_limits().await?;
        assert!(limits.get("daily").is_some());
        assert!(limits.get("hourly").is_some());

        Ok(())
    }
}
