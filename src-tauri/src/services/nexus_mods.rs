use anyhow::Result;
use serde_json::Value;
use std::collections::HashSet;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::RwLock;

macro_rules! eprintln {
    ($($arg:tt)*) => {{
        crate::utils::logging::route_stderr_log(format!($($arg)*));
    }};
}

#[derive(Clone)]
pub struct NexusModsService {
    api_key: Arc<RwLock<Option<String>>>,
}

impl NexusModsService {
    pub fn new() -> Self {
        Self {
            api_key: Arc::new(RwLock::new(None)),
        }
    }

    pub async fn set_api_key(&self, api_key: String) {
        *self.api_key.write().await = Some(api_key);
    }

    pub async fn clear_api_key(&self) {
        *self.api_key.write().await = None;
    }

    pub async fn get_api_key_optional(&self) -> Option<String> {
        self.api_key.read().await.clone()
    }

    async fn graphql_request(&self, query: &str, variables: Value) -> Result<Value> {
        let api_key = self.get_api_key_optional().await;
        let response = nexus_api::execute_graphql(api_key.as_deref(), query, Some(&variables))
            .await
            .map_err(|e| anyhow::anyhow!("Nexus GraphQL crate request failed: {}", e))?;

        Ok(response.data.unwrap_or_else(|| serde_json::json!({})))
    }

    async fn resolve_game_by_input(&self, game_input: &str) -> Result<(String, String)> {
        if let Ok(id) = game_input.parse::<u32>() {
            let data = self
                .graphql_request(
                    r#"
                    query ResolveGameById($id: ID!) {
                        game(id: $id) {
                            id
                            domainName
                        }
                    }
                "#,
                    serde_json::json!({ "id": id.to_string() }),
                )
                .await?;

            let game = data
                .get("game")
                .ok_or_else(|| anyhow::anyhow!("Game not found for id {}", id))?;
            let resolved_id = game
                .get("id")
                .and_then(|v| v.as_i64())
                .map(|v| v.to_string())
                .or_else(|| {
                    game.get("id")
                        .and_then(|v| v.as_str())
                        .map(|s| s.to_string())
                })
                .ok_or_else(|| anyhow::anyhow!("Missing game id in GraphQL response"))?;
            let domain = game
                .get("domainName")
                .and_then(|v| v.as_str())
                .unwrap_or(game_input)
                .to_string();
            return Ok((resolved_id, domain));
        }

        let data = self
            .graphql_request(
                r#"
                query ResolveGameByDomain($domainName: String!) {
                    game(domainName: $domainName) {
                        id
                        domainName
                    }
                }
            "#,
                serde_json::json!({ "domainName": game_input }),
            )
            .await?;

        let game = data
            .get("game")
            .ok_or_else(|| anyhow::anyhow!("Game not found for domain {}", game_input))?;
        let resolved_id = game
            .get("id")
            .and_then(|v| v.as_i64())
            .map(|v| v.to_string())
            .or_else(|| {
                game.get("id")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string())
            })
            .ok_or_else(|| anyhow::anyhow!("Missing game id in GraphQL response"))?;
        let domain = game
            .get("domainName")
            .and_then(|v| v.as_str())
            .unwrap_or(game_input)
            .to_string();
        Ok((resolved_id, domain))
    }

    fn map_mod_node_to_legacy_shape(mod_node: &Value) -> Value {
        let author = mod_node
            .get("author")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
            .or_else(|| {
                mod_node
                    .get("uploader")
                    .and_then(|u| u.get("name"))
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string())
            });

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

        if !camel_collapsed.is_empty()
            && !variants
                .iter()
                .any(|v| v.eq_ignore_ascii_case(&camel_collapsed))
        {
            variants.push(camel_collapsed);
        }

        if !normalized_separators.is_empty()
            && !variants
                .iter()
                .any(|v| v.eq_ignore_ascii_case(&normalized_separators))
        {
            variants.push(normalized_separators);
        }

        let collapsed = original.replace([' ', '_', '-'], "");
        if !collapsed.is_empty() && !variants.iter().any(|v| v.eq_ignore_ascii_case(&collapsed)) {
            variants.push(collapsed);
        }

        variants
    }

    fn normalize_search_text(value: &str) -> String {
        value
            .chars()
            .filter(|ch| !matches!(ch, ' ' | '_' | '-'))
            .flat_map(|ch| ch.to_lowercase())
            .collect::<String>()
    }

    fn matches_query_locally(mod_entry: &Value, query: &str) -> bool {
        let normalized_query = Self::normalize_search_text(query);
        if normalized_query.is_empty() {
            return true;
        }

        ["name", "summary", "author"]
            .iter()
            .filter_map(|field| mod_entry.get(*field).and_then(|value| value.as_str()))
            .any(|value| Self::normalize_search_text(value).contains(&normalized_query))
    }

    /// Get list of all games supported by NexusMods
    pub async fn get_games(&self) -> Result<Vec<Value>> {
        let data = self
            .graphql_request(
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
            )
            .await?;

        let games = data
            .get("games")
            .and_then(|v| v.get("nodes"))
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();

        Ok(games
            .into_iter()
            .map(|game| {
                serde_json::json!({
                    "id": game.get("id"),
                    "domain_name": game.get("domainName"),
                    "name": game.get("name"),
                    "genre": game.get("genre"),
                    "mods": game.get("modCount"),
                    "collections": game.get("collectionCount")
                })
            })
            .collect())
    }

    /// Search for mods on NexusMods using GraphQL API v2
    /// Note: Runtime filtering is not done at search time since NexusMods uses separate files
    /// for different runtimes rather than tags. Files should be filtered by runtime when displayed.
    pub async fn search_mods(&self, game_domain: &str, query: &str) -> Result<Vec<Value>> {
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
        let mut merged = Vec::new();
        let mut seen_ids = HashSet::new();

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

            for mod_entry in mods {
                let key = mod_entry
                    .get("modId")
                    .and_then(|value| value.as_u64())
                    .map(|value| value.to_string())
                    .unwrap_or_else(|| mod_entry.to_string());
                if seen_ids.insert(key) {
                    merged.push(mod_entry);
                }
            }
        }

        Ok(merged
            .into_iter()
            .filter(|mod_entry| Self::matches_query_locally(mod_entry, query))
            .collect())
    }

    /// Get latest added mods using GraphQL API v2
    pub async fn get_latest_added_mods(&self, game_id: &str) -> Result<Vec<Value>> {
        let (_resolved_id, domain_name) = self.resolve_game_by_input(game_id).await?;
        let data = self
            .graphql_request(
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
            )
            .await?;

        let nodes = data
            .get("mods")
            .and_then(|v| v.get("nodes"))
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();
        Ok(nodes
            .into_iter()
            .map(|n| Self::map_mod_node_to_legacy_shape(&n))
            .collect())
    }

    /// Get latest updated mods using GraphQL API v2
    pub async fn get_latest_updated_mods(&self, game_id: &str) -> Result<Vec<Value>> {
        let (_resolved_id, domain_name) = self.resolve_game_by_input(game_id).await?;
        let data = self
            .graphql_request(
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
            )
            .await?;

        let nodes = data
            .get("mods")
            .and_then(|v| v.get("nodes"))
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();
        Ok(nodes
            .into_iter()
            .map(|n| Self::map_mod_node_to_legacy_shape(&n))
            .collect())
    }

    /// Get trending mods using GraphQL API v2
    pub async fn get_trending_mods(&self, game_id: &str) -> Result<Vec<Value>> {
        let (_resolved_id, domain_name) = self.resolve_game_by_input(game_id).await?;
        let data = self
            .graphql_request(
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
            )
            .await?;

        let nodes = data
            .get("mods")
            .and_then(|v| v.get("nodes"))
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();
        Ok(nodes
            .into_iter()
            .map(|n| Self::map_mod_node_to_legacy_shape(&n))
            .collect())
    }

    /// Get mod details by ID
    pub async fn get_mod(&self, game_id: &str, mod_id: u32) -> Result<Value> {
        let (resolved_game_id, _domain_name) = self.resolve_game_by_input(game_id).await?;
        let data = self
            .graphql_request(
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
            )
            .await?;

        let mod_node = data
            .get("mod")
            .cloned()
            .unwrap_or_else(|| serde_json::json!({}));
        Ok(Self::map_mod_node_to_legacy_shape(&mod_node))
    }

    /// Get mod files by mod ID
    pub async fn get_mod_files(&self, game_id: &str, mod_id: u32) -> Result<Vec<Value>> {
        let (resolved_game_id, _domain_name) = self.resolve_game_by_input(game_id).await?;
        let data = self
            .graphql_request(
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
            )
            .await?;

        let files = data
            .get("modFiles")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();
        Ok(files
            .into_iter()
            .map(|f| Self::map_file_node_to_legacy_shape(&f))
            .collect())
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
            match self
                .check_mod_update(game_domain, mod_id, &current_version)
                .await
            {
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

    pub async fn get_oauth_download_links(
        &self,
        access_token: &str,
        game_id: &str,
        mod_id: u32,
        file_id: u32,
    ) -> Result<Vec<String>> {
        let (resolved_game_id, _) = self.resolve_game_by_input(game_id).await?;
        let game_id_i64 = resolved_game_id.parse::<i64>().map_err(|e| {
            anyhow::anyhow!("Invalid resolved game id '{}': {}", resolved_game_id, e)
        })?;

        let game_query = r#"query($id: ID) { game(id: $id) { domainName } }"#;
        let game_vars = serde_json::json!({ "id": game_id_i64.to_string() });
        let game_data = self.graphql_request(game_query, game_vars).await?;
        let domain = game_data
            .get("game")
            .and_then(|g| g.get("domainName"))
            .and_then(|v| v.as_str())
            .ok_or_else(|| anyhow::anyhow!("Missing game domainName for game {}", game_id_i64))?;

        let endpoint = format!(
            "https://api.nexusmods.com/v1/games/{}/mods/{}/files/{}/download_link.json",
            domain, mod_id, file_id
        );
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(30))
            .build()
            .map_err(|e| {
                anyhow::anyhow!("Failed to build Nexus OAuth download link client: {}", e)
            })?;

        let response = client
            .get(endpoint)
            .bearer_auth(access_token)
            .header("Application-Name", "SIMM")
            .header("Application-Version", env!("CARGO_PKG_VERSION"))
            .send()
            .await
            .map_err(|e| anyhow::anyhow!("Failed Nexus OAuth download link request: {}", e))?;

        let status = response.status();
        let body = response.text().await.map_err(|e| {
            anyhow::anyhow!("Failed to read Nexus OAuth download link response: {}", e)
        })?;

        if !status.is_success() {
            return Err(anyhow::anyhow!(
                "Nexus OAuth download-link request failed ({}): {}",
                status,
                body
            ));
        }

        let value = serde_json::from_str::<serde_json::Value>(&body).map_err(|e| {
            anyhow::anyhow!("Failed to parse Nexus OAuth download link response: {}", e)
        })?;

        let arr = value
            .as_array()
            .ok_or_else(|| anyhow::anyhow!("Nexus download-link response was not an array"))?;
        let links: Vec<String> = arr
            .iter()
            .filter_map(|item| {
                item.get("URI")
                    .or_else(|| item.get("uri"))
                    .and_then(|v| v.as_str())
            })
            .map(|uri| uri.to_string())
            .collect();

        if links.is_empty() {
            return Err(anyhow::anyhow!("No Nexus OAuth download links returned"));
        }

        Ok(links)
    }

    /// Download mod file by mod ID and file ID using OAuth access token
    pub async fn download_mod_file(
        &self,
        access_token: &str,
        game_id: &str,
        mod_id: u32,
        file_id: u32,
    ) -> Result<Vec<u8>> {
        let first_url = self
            .get_oauth_download_links(access_token, game_id, mod_id, file_id)
            .await?
            .into_iter()
            .next()
            .ok_or_else(|| {
                anyhow::anyhow!("No Nexus download links returned for file {}", file_id)
            })?;

        let downloaded = nexus_api::download_from_url(&first_url, None)
            .await
            .map_err(|e| anyhow::anyhow!("Failed to download Nexus file via crate: {}", e))?;

        Ok(downloaded.bytes)
    }
}

impl Default for NexusModsService {
    fn default() -> Self {
        Self::new()
    }
}
