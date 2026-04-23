use crate::utils::http_identity;
use crate::utils::logging::{error_with_location, warn_with_location};
use anyhow::Result;
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::{Mutex as AsyncMutex, RwLock};

const NEXUS_GRAPHQL_ENDPOINT: &str = "https://api.nexusmods.com/v2/graphql";
const NEXUS_WEB_BASE: &str = "https://www.nexusmods.com";
const SEARCH_CACHE_TTL: Duration = Duration::from_secs(10 * 60);
const BROWSE_CACHE_TTL: Duration = Duration::from_secs(30 * 60);
const MOD_INFO_CACHE_TTL: Duration = Duration::from_secs(60 * 60);
const MOD_FILES_CACHE_TTL: Duration = Duration::from_secs(60 * 60);
const GAME_IDENTITY_CACHE_TTL: Duration = Duration::from_secs(24 * 60 * 60);
const GAMES_CACHE_TTL: Duration = Duration::from_secs(24 * 60 * 60);

#[derive(Clone)]
pub struct NexusModsService {
    client: reqwest::Client,
    api_key: Arc<RwLock<Option<String>>>,
    request_locks: Arc<AsyncMutex<HashMap<String, Arc<AsyncMutex<()>>>>>,
    game_identity_cache: Arc<RwLock<HashMap<String, CachedValue<(String, String)>>>>,
    games_cache: Arc<RwLock<Option<CachedValue<Vec<Value>>>>>,
    search_cache: Arc<RwLock<HashMap<String, CachedValue<Vec<Value>>>>>,
    browse_cache: Arc<RwLock<HashMap<String, CachedValue<Vec<Value>>>>>,
    mod_cache: Arc<RwLock<HashMap<String, CachedValue<Value>>>>,
    mod_files_cache: Arc<RwLock<HashMap<String, CachedValue<Vec<Value>>>>>,
    latest_rate_limits: Arc<RwLock<Option<nexus_api::RateLimits>>>,
}

#[derive(Clone)]
struct CachedValue<T> {
    loaded_at: Instant,
    value: T,
}

impl NexusModsService {
    pub fn new() -> Self {
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(30))
            .user_agent(http_identity::user_agent())
            .build()
            .expect("failed to build Nexus Mods HTTP client");

        Self {
            client,
            api_key: Arc::new(RwLock::new(None)),
            request_locks: Arc::new(AsyncMutex::new(HashMap::new())),
            game_identity_cache: Arc::new(RwLock::new(HashMap::new())),
            games_cache: Arc::new(RwLock::new(None)),
            search_cache: Arc::new(RwLock::new(HashMap::new())),
            browse_cache: Arc::new(RwLock::new(HashMap::new())),
            mod_cache: Arc::new(RwLock::new(HashMap::new())),
            mod_files_cache: Arc::new(RwLock::new(HashMap::new())),
            latest_rate_limits: Arc::new(RwLock::new(None)),
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

    pub async fn latest_rate_limits(&self) -> Option<nexus_api::RateLimits> {
        self.latest_rate_limits.read().await.clone()
    }

    async fn request_lock(&self, key: &str) -> Arc<AsyncMutex<()>> {
        let mut locks = self.request_locks.lock().await;
        locks
            .entry(key.to_string())
            .or_insert_with(|| Arc::new(AsyncMutex::new(())))
            .clone()
    }

    async fn cached_map_get<T: Clone>(
        cache: &RwLock<HashMap<String, CachedValue<T>>>,
        key: &str,
        ttl: Duration,
    ) -> Option<T> {
        cache.read().await.get(key).and_then(|entry| {
            if entry.loaded_at.elapsed() < ttl {
                Some(entry.value.clone())
            } else {
                None
            }
        })
    }

    async fn cached_map_set<T>(
        cache: &RwLock<HashMap<String, CachedValue<T>>>,
        key: String,
        value: T,
    ) {
        cache.write().await.insert(
            key,
            CachedValue {
                loaded_at: Instant::now(),
                value,
            },
        );
    }

    fn parse_u32_header(headers: &reqwest::header::HeaderMap, names: &[&str]) -> Option<u32> {
        names.iter().find_map(|name| {
            headers
                .get(*name)
                .and_then(|value| value.to_str().ok())
                .and_then(|value| value.trim().parse::<u32>().ok())
        })
    }

    fn parse_u64_header(headers: &reqwest::header::HeaderMap, names: &[&str]) -> Option<u64> {
        names.iter().find_map(|name| {
            headers
                .get(*name)
                .and_then(|value| value.to_str().ok())
                .and_then(|value| value.trim().parse::<u64>().ok())
        })
    }

    fn parse_rate_limits(headers: &reqwest::header::HeaderMap) -> Option<nexus_api::RateLimits> {
        let hourly_limit =
            Self::parse_u32_header(headers, &["x-rl-hourly-limit", "x-ratelimit-hourly-limit"]);
        let hourly_remaining = Self::parse_u32_header(
            headers,
            &["x-rl-hourly-remaining", "x-ratelimit-hourly-remaining"],
        );
        let hourly_reset =
            Self::parse_u64_header(headers, &["x-rl-hourly-reset", "x-ratelimit-hourly-reset"]);
        let daily_limit =
            Self::parse_u32_header(headers, &["x-rl-daily-limit", "x-ratelimit-daily-limit"]);
        let daily_remaining = Self::parse_u32_header(
            headers,
            &["x-rl-daily-remaining", "x-ratelimit-daily-remaining"],
        );
        let daily_reset =
            Self::parse_u64_header(headers, &["x-rl-daily-reset", "x-ratelimit-daily-reset"]);

        if hourly_limit.is_none()
            && hourly_remaining.is_none()
            && hourly_reset.is_none()
            && daily_limit.is_none()
            && daily_remaining.is_none()
            && daily_reset.is_none()
        {
            None
        } else {
            Some(nexus_api::RateLimits {
                hourly_limit,
                hourly_remaining,
                hourly_reset,
                daily_limit,
                daily_remaining,
                daily_reset,
            })
        }
    }

    async fn graphql_request(&self, query: &str, variables: Value) -> Result<Value> {
        let query = query.trim();
        if query.is_empty() {
            return Err(anyhow::anyhow!("Nexus GraphQL query is empty"));
        }

        let api_key = self.get_api_key_optional().await;
        let mut request = self
            .client
            .post(NEXUS_GRAPHQL_ENDPOINT)
            .header(reqwest::header::CONTENT_TYPE, "application/json")
            .header(reqwest::header::ACCEPT, "application/json")
            .header(reqwest::header::USER_AGENT, http_identity::user_agent())
            .header("Application-Name", http_identity::APP_NAME)
            .header("Application-Version", http_identity::APP_VERSION);

        if let Some(key) = api_key.as_deref().filter(|key| !key.trim().is_empty()) {
            request = request.bearer_auth(key).header("apikey", key);
        }

        let response = request
            .json(&serde_json::json!({
                "query": query,
                "variables": variables,
            }))
            .send()
            .await
            .map_err(|e| {
                let message = format!("Nexus GraphQL request failed: {}", e);
                error_with_location(&message);
                anyhow::anyhow!(message)
            })?;

        let status = response.status();
        if let Some(rate_limits) = Self::parse_rate_limits(response.headers()) {
            *self.latest_rate_limits.write().await = Some(rate_limits);
        }

        let text = response.text().await.map_err(|e| {
            let message = format!("Failed to read Nexus GraphQL response: {}", e);
            error_with_location(&message);
            anyhow::anyhow!(message)
        })?;
        let result: nexus_api::GraphQLResponse = if text.trim().is_empty() {
            nexus_api::GraphQLResponse::default()
        } else {
            serde_json::from_str(&text).map_err(|e| {
                let message = format!("Invalid Nexus GraphQL response: {}", e);
                error_with_location(&message);
                anyhow::anyhow!(message)
            })?
        };

        if !status.is_success()
            || result
                .errors
                .as_ref()
                .is_some_and(|errors| !errors.is_empty())
        {
            let message = result
                .errors
                .as_ref()
                .and_then(|errors| errors.first())
                .map(|error| error.message.clone())
                .unwrap_or_else(|| status.to_string());
            let message = format!("Nexus GraphQL request failed ({}): {}", status, message);
            error_with_location(&message);
            return Err(anyhow::anyhow!(message));
        }

        Ok(result.data.unwrap_or_else(|| serde_json::json!({})))
    }

    async fn resolve_game_by_input_uncached(&self, game_input: &str) -> Result<(String, String)> {
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

    async fn resolve_game_by_input(&self, game_input: &str) -> Result<(String, String)> {
        let cache_key = game_input.trim().to_ascii_lowercase();
        if let Some(value) = Self::cached_map_get(
            &self.game_identity_cache,
            &cache_key,
            GAME_IDENTITY_CACHE_TTL,
        )
        .await
        {
            return Ok(value);
        }

        let lock = self
            .request_lock(&format!("game-identity:{}", cache_key))
            .await;
        let _guard = lock.lock().await;
        if let Some(value) = Self::cached_map_get(
            &self.game_identity_cache,
            &cache_key,
            GAME_IDENTITY_CACHE_TTL,
        )
        .await
        {
            return Ok(value);
        }

        let resolved = self.resolve_game_by_input_uncached(game_input).await?;
        Self::cached_map_set(&self.game_identity_cache, cache_key, resolved.clone()).await;
        Self::cached_map_set(
            &self.game_identity_cache,
            resolved.0.to_ascii_lowercase(),
            resolved.clone(),
        )
        .await;
        Self::cached_map_set(
            &self.game_identity_cache,
            resolved.1.to_ascii_lowercase(),
            resolved.clone(),
        )
        .await;
        Ok(resolved)
    }

    pub async fn resolve_game_identity(&self, game_input: &str) -> Result<(String, String)> {
        self.resolve_game_by_input(game_input).await
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
        if let Some(cached) = self.games_cache.read().await.as_ref().and_then(|entry| {
            if entry.loaded_at.elapsed() < GAMES_CACHE_TTL {
                Some(entry.value.clone())
            } else {
                None
            }
        }) {
            return Ok(cached);
        }

        let lock = self.request_lock("games").await;
        let _guard = lock.lock().await;
        if let Some(cached) = self.games_cache.read().await.as_ref().and_then(|entry| {
            if entry.loaded_at.elapsed() < GAMES_CACHE_TTL {
                Some(entry.value.clone())
            } else {
                None
            }
        }) {
            return Ok(cached);
        }

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

        let mapped = games
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
            .collect::<Vec<_>>();

        *self.games_cache.write().await = Some(CachedValue {
            loaded_at: Instant::now(),
            value: mapped.clone(),
        });

        Ok(mapped)
    }

    /// Search for mods on NexusMods using GraphQL API v2
    /// Note: Runtime filtering is not done at search time since NexusMods uses separate files
    /// for different runtimes rather than tags. Files should be filtered by runtime when displayed.
    pub async fn search_mods(&self, game_domain: &str, query: &str) -> Result<Vec<Value>> {
        let cache_key = format!(
            "search:{}:{}",
            game_domain.trim().to_ascii_lowercase(),
            query.trim().to_ascii_lowercase()
        );
        if let Some(cached) =
            Self::cached_map_get(&self.search_cache, &cache_key, SEARCH_CACHE_TTL).await
        {
            return Ok(cached);
        }

        let lock = self.request_lock(&cache_key).await;
        let _guard = lock.lock().await;
        if let Some(cached) =
            Self::cached_map_get(&self.search_cache, &cache_key, SEARCH_CACHE_TTL).await
        {
            return Ok(cached);
        }

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

        let result = merged
            .into_iter()
            .filter(|mod_entry| Self::matches_query_locally(mod_entry, query))
            .collect::<Vec<_>>();

        Self::cached_map_set(&self.search_cache, cache_key, result.clone()).await;
        Ok(result)
    }

    /// Get latest added mods using GraphQL API v2
    pub async fn get_latest_added_mods(&self, game_id: &str) -> Result<Vec<Value>> {
        let (_resolved_id, domain_name) = self.resolve_game_by_input(game_id).await?;
        let cache_key = format!("latest-added:{}", domain_name.to_ascii_lowercase());
        if let Some(cached) =
            Self::cached_map_get(&self.browse_cache, &cache_key, BROWSE_CACHE_TTL).await
        {
            return Ok(cached);
        }

        let lock = self.request_lock(&cache_key).await;
        let _guard = lock.lock().await;
        if let Some(cached) =
            Self::cached_map_get(&self.browse_cache, &cache_key, BROWSE_CACHE_TTL).await
        {
            return Ok(cached);
        }

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
        let result = nodes
            .into_iter()
            .map(|n| Self::map_mod_node_to_legacy_shape(&n))
            .collect::<Vec<_>>();
        Self::cached_map_set(&self.browse_cache, cache_key, result.clone()).await;
        Ok(result)
    }

    /// Get latest updated mods using GraphQL API v2
    pub async fn get_latest_updated_mods(&self, game_id: &str) -> Result<Vec<Value>> {
        let (_resolved_id, domain_name) = self.resolve_game_by_input(game_id).await?;
        let cache_key = format!("latest-updated:{}", domain_name.to_ascii_lowercase());
        if let Some(cached) =
            Self::cached_map_get(&self.browse_cache, &cache_key, BROWSE_CACHE_TTL).await
        {
            return Ok(cached);
        }

        let lock = self.request_lock(&cache_key).await;
        let _guard = lock.lock().await;
        if let Some(cached) =
            Self::cached_map_get(&self.browse_cache, &cache_key, BROWSE_CACHE_TTL).await
        {
            return Ok(cached);
        }

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
        let result = nodes
            .into_iter()
            .map(|n| Self::map_mod_node_to_legacy_shape(&n))
            .collect::<Vec<_>>();
        Self::cached_map_set(&self.browse_cache, cache_key, result.clone()).await;
        Ok(result)
    }

    /// Get trending mods using GraphQL API v2
    pub async fn get_trending_mods(&self, game_id: &str) -> Result<Vec<Value>> {
        let (_resolved_id, domain_name) = self.resolve_game_by_input(game_id).await?;
        let cache_key = format!("trending:{}", domain_name.to_ascii_lowercase());
        if let Some(cached) =
            Self::cached_map_get(&self.browse_cache, &cache_key, BROWSE_CACHE_TTL).await
        {
            return Ok(cached);
        }

        let lock = self.request_lock(&cache_key).await;
        let _guard = lock.lock().await;
        if let Some(cached) =
            Self::cached_map_get(&self.browse_cache, &cache_key, BROWSE_CACHE_TTL).await
        {
            return Ok(cached);
        }

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
        let result = nodes
            .into_iter()
            .map(|n| Self::map_mod_node_to_legacy_shape(&n))
            .collect::<Vec<_>>();
        Self::cached_map_set(&self.browse_cache, cache_key, result.clone()).await;
        Ok(result)
    }

    /// Get mod details by ID
    pub async fn get_mod(&self, game_id: &str, mod_id: u32) -> Result<Value> {
        let (resolved_game_id, _domain_name) = self.resolve_game_by_input(game_id).await?;
        let cache_key = format!("mod:{}:{}", resolved_game_id, mod_id);
        if let Some(cached) =
            Self::cached_map_get(&self.mod_cache, &cache_key, MOD_INFO_CACHE_TTL).await
        {
            return Ok(cached);
        }

        let lock = self.request_lock(&cache_key).await;
        let _guard = lock.lock().await;
        if let Some(cached) =
            Self::cached_map_get(&self.mod_cache, &cache_key, MOD_INFO_CACHE_TTL).await
        {
            return Ok(cached);
        }

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
        let result = Self::map_mod_node_to_legacy_shape(&mod_node);
        Self::cached_map_set(&self.mod_cache, cache_key, result.clone()).await;
        Ok(result)
    }

    /// Get mod files by mod ID
    pub async fn get_mod_files(&self, game_id: &str, mod_id: u32) -> Result<Vec<Value>> {
        let (resolved_game_id, _domain_name) = self.resolve_game_by_input(game_id).await?;
        let cache_key = format!("mod-files:{}:{}", resolved_game_id, mod_id);
        if let Some(cached) =
            Self::cached_map_get(&self.mod_files_cache, &cache_key, MOD_FILES_CACHE_TTL).await
        {
            return Ok(cached);
        }

        let lock = self.request_lock(&cache_key).await;
        let _guard = lock.lock().await;
        if let Some(cached) =
            Self::cached_map_get(&self.mod_files_cache, &cache_key, MOD_FILES_CACHE_TTL).await
        {
            return Ok(cached);
        }

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
        let result = files
            .into_iter()
            .map(|f| Self::map_file_node_to_legacy_shape(&f))
            .collect::<Vec<_>>();
        Self::cached_map_set(&self.mod_files_cache, cache_key, result.clone()).await;
        Ok(result)
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
                    warn_with_location(format!(
                        "Failed to check Nexus update for mod {} in {}: {}",
                        mod_id, game_domain, e
                    ));
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
        let (_resolved_game_id, domain) = self.resolve_game_by_input(game_id).await?;

        let endpoint = format!(
            "https://api.nexusmods.com/v1/games/{}/mods/{}/files/{}/download_link.json",
            domain, mod_id, file_id
        );
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(30))
            .build()
            .map_err(|e| {
                let message = format!("Failed to build Nexus OAuth download link client: {}", e);
                error_with_location(&message);
                anyhow::anyhow!(message)
            })?;

        let response = client
            .get(endpoint)
            .bearer_auth(access_token)
            .header(reqwest::header::USER_AGENT, http_identity::user_agent())
            .header("Application-Name", http_identity::APP_NAME)
            .header("Application-Version", http_identity::APP_VERSION)
            .send()
            .await
            .map_err(|e| {
                let message = format!("Failed Nexus OAuth download link request: {}", e);
                error_with_location(&message);
                anyhow::anyhow!(message)
            })?;

        let status = response.status();
        let body = response.text().await.map_err(|e| {
            let message = format!("Failed to read Nexus OAuth download link response: {}", e);
            error_with_location(&message);
            anyhow::anyhow!(message)
        })?;

        if !status.is_success() {
            let message = format!(
                "Nexus OAuth download-link request failed ({}): {}",
                status, body
            );
            error_with_location(&message);
            return Err(anyhow::anyhow!(message));
        }

        let value = serde_json::from_str::<serde_json::Value>(&body).map_err(|e| {
            let message = format!("Failed to parse Nexus OAuth download link response: {}", e);
            error_with_location(&message);
            anyhow::anyhow!(message)
        })?;

        let arr = value.as_array().ok_or_else(|| {
            let message = "Nexus download-link response was not an array";
            error_with_location(message);
            anyhow::anyhow!(message)
        })?;
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
            let message = "No Nexus OAuth download links returned";
            error_with_location(message);
            return Err(anyhow::anyhow!(message));
        }

        Ok(links)
    }

    pub async fn download_from_url(
        &self,
        url: &str,
        access_token: Option<&str>,
    ) -> Result<Vec<u8>> {
        let parsed = reqwest::Url::parse(url).map_err(|e| {
            let message = format!("Invalid Nexus download URL: {}", e);
            error_with_location(&message);
            anyhow::anyhow!(message)
        })?;
        if parsed.scheme() != "https" {
            let message = "Nexus download URL must use HTTPS";
            error_with_location(message);
            return Err(anyhow::anyhow!(message));
        }

        let mut request = self
            .client
            .get(parsed)
            .header(reqwest::header::USER_AGENT, http_identity::user_agent())
            .header(reqwest::header::ACCEPT, "application/octet-stream,*/*")
            .header(reqwest::header::REFERER, NEXUS_WEB_BASE)
            .header("Application-Name", http_identity::APP_NAME)
            .header("Application-Version", http_identity::APP_VERSION);

        if let Some(token) = access_token.filter(|token| !token.trim().is_empty()) {
            request = request.bearer_auth(token);
        }

        let response = request.send().await.map_err(|e| {
            let message = format!("Nexus download request failed: {}", e);
            error_with_location(&message);
            anyhow::anyhow!(message)
        })?;
        let status = response.status();
        if !status.is_success() {
            let message = format!("Nexus download request failed ({})", status);
            error_with_location(&message);
            return Err(anyhow::anyhow!(message));
        }

        let bytes = response.bytes().await.map_err(|e| {
            let message = format!("Failed to read Nexus download response: {}", e);
            error_with_location(&message);
            anyhow::anyhow!(message)
        })?;
        Ok(bytes.to_vec())
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
                let message = format!("No Nexus download links returned for file {}", file_id);
                error_with_location(&message);
                anyhow::anyhow!(message)
            })?;

        self.download_from_url(&first_url, None).await
    }
}

impl Default for NexusModsService {
    fn default() -> Self {
        Self::new()
    }
}
