use anyhow::{Context, Result};
use reqwest::Client;
use serde_json::Value;
use std::sync::Arc;
use tokio::sync::RwLock;

const NEXUS_MODS_API_BASE: &str = "https://api.nexusmods.com/v1";
const NEXUS_MODS_GRAPHQL_API: &str = "https://api.nexusmods.com/v2/graphql";

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

        let daily_remaining = response.headers()
            .get("x-rl-daily-remaining")
            .and_then(|v| v.to_str().ok())
            .and_then(|s| s.parse::<u32>().ok())
            .unwrap_or(0);

        let hourly_remaining = response.headers()
            .get("x-rl-hourly-remaining")
            .and_then(|v| v.to_str().ok())
            .and_then(|s| s.parse::<u32>().ok())
            .unwrap_or(0);

        let daily_used = daily.saturating_sub(daily_remaining);
        let hourly_used = hourly.saturating_sub(hourly_remaining);

        Ok(serde_json::json!({
            "daily": daily,
            "hourly": hourly,
            "dailyRemaining": daily_remaining,
            "hourlyRemaining": hourly_remaining,
            "dailyUsed": daily_used,
            "hourlyUsed": hourly_used
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

    async fn graphql_request(&self, query: &str, variables: Value) -> Result<Value> {
        let payload = serde_json::json!({
            "query": query,
            "variables": variables,
        });

        let mut request = self.client
            .post(NEXUS_MODS_GRAPHQL_API)
            .header("Application-Name", "Schedule-I-DevEnvManager")
            .header("Application-Version", "1.0.0")
            .header("Content-Type", "application/json");

        if let Some(api_key) = self.get_api_key_optional().await {
            request = request.header("apikey", api_key);
        }

        let response = request
            .json(&payload)
            .send()
            .await
            .context("Failed to send GraphQL request")?;

        if !response.status().is_success() {
            let status = response.status();
            let error_body = response.text().await.unwrap_or_else(|_| "Unable to read error response".to_string());
            return Err(anyhow::anyhow!("NexusMods GraphQL API returned {}. Error: {}", status, error_body));
        }

        let response_data: Value = response.json().await
            .context("Failed to parse GraphQL response")?;

        if let Some(errors) = response_data.get("errors") {
            return Err(anyhow::anyhow!("GraphQL query returned errors: {}", errors));
        }

        Ok(response_data.get("data").cloned().unwrap_or_else(|| serde_json::json!({})))
    }

    async fn resolve_game_by_input(&self, game_input: &str) -> Result<(String, String)> {
        if let Ok(id) = game_input.parse::<u32>() {
            let data = self.graphql_request(
                r#"
                    query ResolveGameById($id: ID!) {
                        game(id: $id) {
                            id
                            domainName
                        }
                    }
                "#,
                serde_json::json!({ "id": id.to_string() }),
            ).await?;

            let game = data.get("game").ok_or_else(|| anyhow::anyhow!("Game not found for id {}", id))?;
            let resolved_id = game.get("id").and_then(|v| v.as_i64()).map(|v| v.to_string())
                .or_else(|| game.get("id").and_then(|v| v.as_str()).map(|s| s.to_string()))
                .ok_or_else(|| anyhow::anyhow!("Missing game id in GraphQL response"))?;
            let domain = game.get("domainName").and_then(|v| v.as_str()).unwrap_or(game_input).to_string();
            return Ok((resolved_id, domain));
        }

        let data = self.graphql_request(
            r#"
                query ResolveGameByDomain($domainName: String!) {
                    game(domainName: $domainName) {
                        id
                        domainName
                    }
                }
            "#,
            serde_json::json!({ "domainName": game_input }),
        ).await?;

        let game = data.get("game").ok_or_else(|| anyhow::anyhow!("Game not found for domain {}", game_input))?;
        let resolved_id = game.get("id").and_then(|v| v.as_i64()).map(|v| v.to_string())
            .or_else(|| game.get("id").and_then(|v| v.as_str()).map(|s| s.to_string()))
            .ok_or_else(|| anyhow::anyhow!("Missing game id in GraphQL response"))?;
        let domain = game.get("domainName").and_then(|v| v.as_str()).unwrap_or(game_input).to_string();
        Ok((resolved_id, domain))
    }

    fn map_mod_node_to_legacy_shape(mod_node: &Value) -> Value {
        let author = mod_node
            .get("author")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
            .or_else(|| mod_node.get("uploader").and_then(|u| u.get("name")).and_then(|v| v.as_str()).map(|s| s.to_string()));

        serde_json::json!({
            "mod_id": mod_node.get("modId"),
            "name": mod_node.get("name"),
            "summary": mod_node.get("summary"),
            "picture_url": mod_node.get("pictureUrl"),
            "thumbnail_url": mod_node.get("thumbnailUrl"),
            "endorsement_count": mod_node.get("endorsements"),
            "mod_downloads": mod_node.get("downloads"),
            "version": mod_node.get("version"),
            "author": author,
            "updated_at": mod_node.get("updatedAt"),
            "created_at": mod_node.get("createdAt")
        })
    }

    fn map_file_node_to_legacy_shape(file_node: &Value) -> Value {
        serde_json::json!({
            "file_id": file_node.get("fileId"),
            "file_name": file_node.get("name"),
            "name": file_node.get("name"),
            "version": file_node.get("version"),
            "category_id": file_node.get("categoryId"),
            "size": file_node.get("sizeInBytes").or_else(|| file_node.get("size")),
            "is_primary": file_node.get("primary").and_then(|v| v.as_bool()).unwrap_or(false)
                || file_node.get("primary").and_then(|v| v.as_i64()).unwrap_or(0) > 0,
            "uri": file_node.get("uri")
        })
    }

    fn normalize_search_query_variants(query: &str) -> Vec<String> {
        let original = query.trim();
        if original.is_empty() {
            return Vec::new();
        }

        let mut variants: Vec<String> = vec![original.to_string()];

        let mut camel_spaced = String::with_capacity(original.len() + 8);
        let mut prev_is_lower_or_digit = false;
        for ch in original.chars() {
            let is_upper = ch.is_ascii_uppercase();
            let is_lower_or_digit = ch.is_ascii_lowercase() || ch.is_ascii_digit();

            if is_upper && prev_is_lower_or_digit {
                camel_spaced.push(' ');
            }
            camel_spaced.push(ch);
            prev_is_lower_or_digit = is_lower_or_digit;
        }

        let normalized_separators = original
            .replace('_', " ")
            .replace('-', " ")
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ");

        let camel_collapsed = camel_spaced
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ");

        if !camel_collapsed.is_empty() && !variants.iter().any(|v| v.eq_ignore_ascii_case(&camel_collapsed)) {
            variants.push(camel_collapsed);
        }

        if !normalized_separators.is_empty()
            && !variants
                .iter()
                .any(|v| v.eq_ignore_ascii_case(&normalized_separators))
        {
            variants.push(normalized_separators);
        }

        variants
    }

    /// Get list of all games supported by NexusMods
    pub async fn get_games(&self) -> Result<Vec<Value>> {
        let data = self.graphql_request(
            r#"
                query ListGames($count: Int) {
                    games(count: $count) {
                        nodes {
                            id
                            domainName
                            name
                            genre
                            modCount
                            collectionCount
                        }
                    }
                }
            "#,
            serde_json::json!({ "count": 500 }),
        ).await?;

        let games = data
            .get("games")
            .and_then(|v| v.get("nodes"))
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();

        Ok(games.into_iter().map(|game| {
            serde_json::json!({
                "id": game.get("id"),
                "domain_name": game.get("domainName"),
                "name": game.get("name"),
                "genre": game.get("genre"),
                "mods": game.get("modCount"),
                "collections": game.get("collectionCount")
            })
        }).collect())
    }

    /// Search for mods on NexusMods using GraphQL API v2
    /// Note: Runtime filtering is not done at search time since NexusMods uses separate files
    /// for different runtimes rather than tags. Files should be filtered by runtime when displayed.
    pub async fn search_mods(
        &self,
        game_domain: &str,
        query: &str,
    ) -> Result<Vec<Value>> {
        let gql = r#"
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
        "#;

        let search_variants = Self::normalize_search_query_variants(query);
        for variant in search_variants {
            let data = self
                .graphql_request(
                    gql,
                    serde_json::json!({
                        "filter": {
                            "gameDomainName": [{"value": game_domain, "op": "EQUALS"}],
                            "nameStemmed": [{"value": variant, "op": "MATCHES"}]
                        },
                        "offset": 0,
                        "count": 100
                    }),
                )
                .await?;

            let mods = data
                .get("mods")
                .and_then(|m| m.get("nodes"))
                .and_then(|n| n.as_array())
                .cloned()
                .unwrap_or_default();

            if !mods.is_empty() {
                return Ok(mods);
            }
        }

        Ok(Vec::new())
    }

    /// Get latest added mods using GraphQL API v2
    pub async fn get_latest_added_mods(&self, game_id: &str) -> Result<Vec<Value>> {
        let (_resolved_id, domain_name) = self.resolve_game_by_input(game_id).await?;
        let data = self.graphql_request(
            r#"
                query LatestAddedMods($filter: ModsFilter, $sort: [ModsSort!], $count: Int) {
                    mods(filter: $filter, sort: $sort, count: $count) {
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
                        }
                    }
                }
            "#,
            serde_json::json!({
                "filter": { "gameDomainName": [{"value": domain_name, "op": "EQUALS"}] },
                "sort": [{"createdAt": {"direction": "DESC"}}],
                "count": 100
            }),
        ).await?;

        let nodes = data
            .get("mods")
            .and_then(|v| v.get("nodes"))
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();
        Ok(nodes.into_iter().map(|n| Self::map_mod_node_to_legacy_shape(&n)).collect())
    }

    /// Get latest updated mods using GraphQL API v2
    pub async fn get_latest_updated_mods(&self, game_id: &str) -> Result<Vec<Value>> {
        let (_resolved_id, domain_name) = self.resolve_game_by_input(game_id).await?;
        let data = self.graphql_request(
            r#"
                query LatestUpdatedMods($filter: ModsFilter, $sort: [ModsSort!], $count: Int) {
                    mods(filter: $filter, sort: $sort, count: $count) {
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
                        }
                    }
                }
            "#,
            serde_json::json!({
                "filter": { "gameDomainName": [{"value": domain_name, "op": "EQUALS"}] },
                "sort": [{"updatedAt": {"direction": "DESC"}}],
                "count": 100
            }),
        ).await?;

        let nodes = data
            .get("mods")
            .and_then(|v| v.get("nodes"))
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();
        Ok(nodes.into_iter().map(|n| Self::map_mod_node_to_legacy_shape(&n)).collect())
    }

    /// Get trending mods using GraphQL API v2
    pub async fn get_trending_mods(&self, game_id: &str) -> Result<Vec<Value>> {
        let (_resolved_id, domain_name) = self.resolve_game_by_input(game_id).await?;
        let data = self.graphql_request(
            r#"
                query TrendingMods($filter: ModsFilter, $sort: [ModsSort!], $count: Int) {
                    mods(filter: $filter, sort: $sort, count: $count) {
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
                        }
                    }
                }
            "#,
            serde_json::json!({
                "filter": { "gameDomainName": [{"value": domain_name, "op": "EQUALS"}] },
                "sort": [{"endorsements": {"direction": "DESC"}}],
                "count": 100
            }),
        ).await?;

        let nodes = data
            .get("mods")
            .and_then(|v| v.get("nodes"))
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();
        Ok(nodes.into_iter().map(|n| Self::map_mod_node_to_legacy_shape(&n)).collect())
    }

    /// Get mod details by ID
    pub async fn get_mod(&self, game_id: &str, mod_id: u32) -> Result<Value> {
        let (resolved_game_id, _domain_name) = self.resolve_game_by_input(game_id).await?;
        let data = self.graphql_request(
            r#"
                query GetMod($gameId: ID!, $modId: ID!) {
                    mod(gameId: $gameId, modId: $modId) {
                        modId
                        name
                        summary
                        version
                        author
                        uploader {
                            name
                        }
                        updatedAt
                        createdAt
                        endorsements
                        downloads
                        pictureUrl
                        thumbnailUrl
                    }
                }
            "#,
            serde_json::json!({
                "gameId": resolved_game_id,
                "modId": mod_id.to_string()
            }),
        ).await?;

        let mod_node = data.get("mod").cloned().unwrap_or_else(|| serde_json::json!({}));
        Ok(Self::map_mod_node_to_legacy_shape(&mod_node))
    }

    /// Get mod files by mod ID
    pub async fn get_mod_files(&self, game_id: &str, mod_id: u32) -> Result<Vec<Value>> {
        let (resolved_game_id, _domain_name) = self.resolve_game_by_input(game_id).await?;
        let data = self.graphql_request(
            r#"
                query GetModFiles($gameId: ID!, $modId: ID!) {
                    modFiles(gameId: $gameId, modId: $modId) {
                        fileId
                        name
                        version
                        categoryId
                        sizeInBytes
                        size
                        primary
                        uri
                    }
                }
            "#,
            serde_json::json!({
                "gameId": resolved_game_id,
                "modId": mod_id.to_string()
            }),
        ).await?;

        let files = data
            .get("modFiles")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();
        Ok(files.into_iter().map(|f| Self::map_file_node_to_legacy_shape(&f)).collect())
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
    use crate::db::get_database_path;
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

        let db_path = match get_database_path() {
            Ok(path) => path,
            Err(_) => return Ok(None),
        };
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
