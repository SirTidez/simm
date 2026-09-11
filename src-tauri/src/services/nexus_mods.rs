use crate::types::{
    NexusCollectionExternalResource, NexusCollectionModFile, NexusCollectionRevisionPlan,
    NexusCollectionsPage, NexusDependencyCandidate, NexusDependencyRequirement,
    NexusModFileDependencies, NexusModsPage,
};
use crate::utils::http_identity;
use crate::utils::logging::{error_with_location, warn_with_location};
use anyhow::Result;
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::{Mutex as AsyncMutex, RwLock};

const NEXUS_GRAPHQL_ENDPOINT: &str = "https://api.nexusmods.com/v2/graphql";
const NEXUS_V3_API_BASE: &str = "https://api.nexusmods.com";
const NEXUS_WEB_BASE: &str = "https://www.nexusmods.com";
const SEARCH_CACHE_TTL: Duration = Duration::from_secs(10 * 60);
const BROWSE_CACHE_TTL: Duration = Duration::from_secs(30 * 60);
const MOD_INFO_CACHE_TTL: Duration = Duration::from_secs(60 * 60);
const MOD_FILES_CACHE_TTL: Duration = Duration::from_secs(60 * 60);
const GAME_IDENTITY_CACHE_TTL: Duration = Duration::from_secs(24 * 60 * 60);
const GAMES_CACHE_TTL: Duration = Duration::from_secs(24 * 60 * 60);
const NEXUS_CONNECT_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Clone)]
pub struct NexusModsService {
    client: reqwest::Client,
    api_key: Arc<RwLock<Option<String>>>,
    request_locks: Arc<AsyncMutex<HashMap<String, Arc<AsyncMutex<()>>>>>,
    game_identity_cache: Arc<RwLock<HashMap<String, CachedValue<(String, String)>>>>,
    games_cache: Arc<RwLock<Option<CachedValue<Vec<Value>>>>>,
    search_cache: Arc<RwLock<HashMap<String, CachedValue<Vec<Value>>>>>,
    catalog_cache: Arc<RwLock<HashMap<String, CachedValue<NexusModsPage>>>>,
    collection_catalog_cache: Arc<RwLock<HashMap<String, CachedValue<NexusCollectionsPage>>>>,
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
            .connect_timeout(NEXUS_CONNECT_TIMEOUT)
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
            catalog_cache: Arc::new(RwLock::new(HashMap::new())),
            collection_catalog_cache: Arc::new(RwLock::new(HashMap::new())),
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

    async fn v3_get_json(&self, access_token: &str, path: &str) -> Result<Value> {
        let endpoint = format!("{NEXUS_V3_API_BASE}{path}");
        let response = self
            .client
            .get(&endpoint)
            .bearer_auth(access_token)
            .header(reqwest::header::ACCEPT, "application/json")
            .header("Application-Name", http_identity::APP_NAME)
            .header("Application-Version", http_identity::APP_VERSION)
            .send()
            .await
            .map_err(|error| anyhow::anyhow!("Nexus v3 request failed: {error}"))?;

        let status = response.status();
        let body = response
            .text()
            .await
            .map_err(|error| anyhow::anyhow!("Failed to read Nexus v3 response: {error}"))?;

        if !status.is_success() {
            return Err(anyhow::anyhow!(
                "Nexus v3 request failed ({status}): {}",
                body.trim()
            ));
        }

        serde_json::from_str(&body)
            .map_err(|error| anyhow::anyhow!("Invalid Nexus v3 response: {error}"))
    }

    fn v3_data(value: &Value) -> &Value {
        value.get("data").unwrap_or(value)
    }

    fn json_string(value: Option<&Value>) -> String {
        value
            .and_then(|entry| entry.as_str().map(str::to_string))
            .or_else(|| value.and_then(|entry| entry.as_i64().map(|id| id.to_string())))
            .or_else(|| value.and_then(|entry| entry.as_u64().map(|id| id.to_string())))
            .unwrap_or_default()
    }

    fn parse_materialized_dependencies(
        source_version_id: String,
        value: &Value,
    ) -> NexusModFileDependencies {
        let requirements = Self::v3_data(value)
            .get("dependencies")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .map(|definition| {
                let candidates = definition
                    .get("candidate_mod_files")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .flat_map(|candidate_file| {
                        let mod_value = candidate_file.get("mod");
                        let mod_id = Self::json_string(mod_value.and_then(|mod_value| {
                            mod_value
                                .get("game_scoped_id")
                                .or_else(|| mod_value.get("id"))
                        }));
                        let mod_name = Self::json_string(
                            mod_value.and_then(|mod_value| mod_value.get("name")),
                        );
                        let mod_file_id = Self::json_string(candidate_file.get("id"));
                        let mod_file_name = Self::json_string(candidate_file.get("name"));

                        candidate_file
                            .get("candidate_versions")
                            .and_then(Value::as_array)
                            .into_iter()
                            .flatten()
                            .map(move |version| NexusDependencyCandidate {
                                mod_id: mod_id.clone(),
                                mod_name: mod_name.clone(),
                                mod_file_id: mod_file_id.clone(),
                                mod_file_name: mod_file_name.clone(),
                                version_id: Self::json_string(version.get("id")),
                                version_game_scoped_id: Self::json_string(
                                    version.get("game_scoped_id"),
                                ),
                                version: Self::json_string(version.get("version")),
                            })
                    })
                    .collect::<Vec<_>>();

                NexusDependencyRequirement {
                    id: Self::json_string(definition.get("id")),
                    candidates,
                }
            })
            .collect::<Vec<_>>();

        NexusModFileDependencies {
            source_version_id,
            requirements,
        }
    }

    async fn resolve_v3_mod_file_version_id(
        &self,
        access_token: &str,
        game_domain: &str,
        legacy_mod_id: u32,
        legacy_file_id: u32,
    ) -> Result<String> {
        let game_domain = urlencoding::encode(game_domain);
        let mod_response = self
            .v3_get_json(
                access_token,
                &format!("/games/{game_domain}/mods/{legacy_mod_id}"),
            )
            .await?;
        let mod_id = Self::json_string(Self::v3_data(&mod_response).get("id"));
        if mod_id.is_empty() {
            return Err(anyhow::anyhow!(
                "Nexus v3 did not return an identifier for mod {legacy_mod_id}"
            ));
        }

        let files = self
            .v3_get_json(access_token, &format!("/mods/{mod_id}/files"))
            .await?;
        let files = Self::v3_data(&files)
            .get("mod_files")
            .and_then(Value::as_array)
            .ok_or_else(|| anyhow::anyhow!("Nexus v3 did not return mod files"))?;

        let legacy_file_id = legacy_file_id.to_string();
        for file in files {
            let mod_file_id = Self::json_string(file.get("id"));
            if mod_file_id.is_empty() {
                continue;
            }

            let versions = self
                .v3_get_json(access_token, &format!("/mod-files/{mod_file_id}/versions"))
                .await?;
            let Some(versions) = Self::v3_data(&versions)
                .get("versions")
                .and_then(Value::as_array)
            else {
                continue;
            };

            if let Some(version) = versions
                .iter()
                .find(|version| Self::json_string(version.get("game_scoped_id")) == legacy_file_id)
            {
                let version_id = Self::json_string(version.get("id"));
                if !version_id.is_empty() {
                    return Ok(version_id);
                }
            }
        }

        Err(anyhow::anyhow!(
            "Nexus v3 could not map file {legacy_file_id} on mod {legacy_mod_id} to a published file version"
        ))
    }

    /// Resolve the public, file-version dependency candidates for a legacy Nexus file id.
    pub async fn get_mod_file_dependencies(
        &self,
        access_token: &str,
        game_domain: &str,
        mod_id: u32,
        file_id: u32,
    ) -> Result<NexusModFileDependencies> {
        let source_version_id = self
            .resolve_v3_mod_file_version_id(access_token, game_domain, mod_id, file_id)
            .await?;
        let response = self
            .v3_get_json(
                access_token,
                &format!("/mod-file-versions/{source_version_id}/dependencies/ranges/materialized"),
            )
            .await?;

        Ok(Self::parse_materialized_dependencies(
            source_version_id,
            &response,
        ))
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
            "description": mod_node.get("description"),
            "picture_url": mod_node.get("pictureUrl"),
            "thumbnail_url": mod_node.get("thumbnailUrl"),
            "endorsement_count": mod_node.get("endorsements"),
            "mod_downloads": mod_node.get("downloads"),
            "unique_downloads": mod_node.get("downloads"),
            "version": mod_node.get("version"),
            "author": author,
            "original_author": mod_node.get("author"),
            "uploader": mod_node.get("uploader").and_then(|u| u.get("name")),
            "uploader_member_id": mod_node.get("uploader").and_then(|u| u.get("memberId")),
            "category_name": mod_node.get("category"),
            "contains_adult_content": mod_node.get("adultContent"),
            "status": mod_node.get("status"),
            "direct_download_enabled": mod_node.get("directDownloadEnabled"),
            "supports_vortex": mod_node.get("supportsVortex"),
            "tags": mod_node.get("tags").and_then(|tags| tags.as_array()).map(|tags| {
                tags.iter()
                    .filter_map(|tag| tag.get("name").and_then(|name| name.as_str()))
                    .collect::<Vec<_>>()
            }),
            "updated_at": mod_node.get("updatedAt"),
            "updated_time": mod_node.get("updatedAt"),
            "created_at": mod_node.get("createdAt"),
            "uploaded_time": mod_node.get("createdAt")
        })
    }

    fn map_file_node_to_legacy_shape(file_node: &Value) -> Value {
        serde_json::json!({
            "file_id": file_node.get("fileId"),
            "file_name": file_node.get("name"),
            "name": file_node.get("name"),
            "version": file_node.get("version"),
            "category_id": file_node.get("categoryId"),
            "category_name": file_node.get("category"),
            "size": file_node.get("sizeInBytes").or_else(|| file_node.get("size")),
            "is_primary": file_node.get("primary").and_then(|v| v.as_bool()).unwrap_or(false)
                || file_node.get("primary").and_then(|v| v.as_i64()).unwrap_or(0) > 0,
            "uri": file_node.get("uri"),
            "uploaded_timestamp": file_node.get("date"),
            "mod_version": file_node.get("version"),
            "description": file_node.get("description"),
            "detected_file_extension": file_node.get("detectedFileExtension"),
            "total_downloads": file_node.get("totalDownloads"),
            "unique_downloads": file_node.get("uniqueDownloads")
        })
    }

    fn catalog_sort(sort: &str, has_query: bool) -> Value {
        match sort {
            "popularity" => serde_json::json!([{"downloads": {"direction": "DESC"}}]),
            "newest" => serde_json::json!([{"createdAt": {"direction": "DESC"}}]),
            "relevance" if has_query => {
                serde_json::json!([{"relevance": {"direction": "DESC"}}])
            }
            _ => serde_json::json!([{"updatedAt": {"direction": "DESC"}}]),
        }
    }

    fn collection_catalog_sort(sort: &str, has_query: bool) -> Value {
        match sort {
            "popularity" => serde_json::json!([{"downloads": {"direction": "DESC"}}]),
            "newest" => serde_json::json!([{"createdAt": {"direction": "DESC"}}]),
            "relevance" if has_query => {
                serde_json::json!([{"relevance": {"direction": "DESC"}}])
            }
            _ => serde_json::json!([{"updatedAt": {"direction": "DESC"}}]),
        }
    }

    pub async fn browse_mods_page(
        &self,
        game_id: &str,
        query: &str,
        sort: &str,
        offset: u32,
        count: u32,
    ) -> Result<NexusModsPage> {
        let (_resolved_id, domain_name) = self.resolve_game_by_input(game_id).await?;
        let trimmed_query = query.trim();
        let page_size = count.clamp(1, 100);
        let cache_key = format!(
            "catalog:{}:{}:{}:{}:{}",
            domain_name.to_ascii_lowercase(),
            trimmed_query.to_ascii_lowercase(),
            sort,
            offset,
            page_size
        );
        if let Some(cached) =
            Self::cached_map_get(&self.catalog_cache, &cache_key, SEARCH_CACHE_TTL).await
        {
            return Ok(cached);
        }

        let lock = self.request_lock(&cache_key).await;
        let _guard = lock.lock().await;
        if let Some(cached) =
            Self::cached_map_get(&self.catalog_cache, &cache_key, SEARCH_CACHE_TTL).await
        {
            return Ok(cached);
        }

        let mut filter = serde_json::json!({
            "gameDomainName": [{"value": domain_name, "op": "EQUALS"}]
        });
        if !trimmed_query.is_empty() {
            filter["nameStemmed"] = serde_json::json!([{"value": trimmed_query, "op": "MATCHES"}]);
        }

        let data = self
            .graphql_request(
                r#"
                query BrowseModsPage($filter: ModsFilter, $sort: [ModsSort!], $offset: Int, $count: Int) {
                    mods(filter: $filter, sort: $sort, offset: $offset, count: $count) {
                        totalCount
                        nodesCount
                        nodes {
                            modId
                            name
                            summary
                            description
                            pictureUrl
                            thumbnailUrl
                            endorsements
                            downloads
                            version
                            author
                            adultContent
                            status
                            category
                            directDownloadEnabled
                            supportsVortex
                            tags { name }
                            updatedAt
                            createdAt
                            uploader { name memberId }
                        }
                    }
                }
                "#,
                serde_json::json!({
                    "filter": filter,
                    "sort": Self::catalog_sort(sort, !trimmed_query.is_empty()),
                    "offset": offset,
                    "count": page_size
                }),
            )
            .await?;

        let mods_node = data.get("mods").cloned().unwrap_or_default();
        let total_count = mods_node
            .get("totalCount")
            .and_then(Value::as_u64)
            .unwrap_or(0);
        let mods = mods_node
            .get("nodes")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .map(|node| Self::map_mod_node_to_legacy_shape(&node))
            .collect::<Vec<_>>();
        let loaded_through = u64::from(offset) + mods.len() as u64;
        let page = NexusModsPage {
            mods,
            total_count,
            offset,
            count: page_size,
            has_more: loaded_through < total_count,
        };
        Self::cached_map_set(&self.catalog_cache, cache_key, page.clone()).await;
        Ok(page)
    }

    pub async fn browse_collections_page(
        &self,
        game_id: &str,
        query: &str,
        sort: &str,
        offset: u32,
        count: u32,
    ) -> Result<NexusCollectionsPage> {
        let (_resolved_id, domain_name) = self.resolve_game_by_input(game_id).await?;
        let trimmed_query = query.trim();
        let page_size = count.clamp(1, 100);
        let cache_key = format!(
            "collection-catalog:{}:{}:{}:{}:{}",
            domain_name.to_ascii_lowercase(),
            trimmed_query.to_ascii_lowercase(),
            sort,
            offset,
            page_size
        );
        if let Some(cached) =
            Self::cached_map_get(&self.collection_catalog_cache, &cache_key, SEARCH_CACHE_TTL).await
        {
            return Ok(cached);
        }

        let lock = self.request_lock(&cache_key).await;
        let _guard = lock.lock().await;
        if let Some(cached) =
            Self::cached_map_get(&self.collection_catalog_cache, &cache_key, SEARCH_CACHE_TTL).await
        {
            return Ok(cached);
        }

        let mut filter = serde_json::json!({
            "gameDomain": [{"value": domain_name, "op": "EQUALS"}],
            "hasPublishedRevision": [{"value": true, "op": "EQUALS"}]
        });
        if !trimmed_query.is_empty() {
            filter["generalSearch"] =
                serde_json::json!([{"value": trimmed_query, "op": "WILDCARD"}]);
        }

        let data = self
            .graphql_request(
                r#"
                query BrowseCollectionsPage($filter: CollectionsSearchFilter, $sort: [CollectionsSearchSort!], $offset: Int, $count: Int) {
                    collectionsV2(filter: $filter, sort: $sort, offset: $offset, count: $count) {
                        totalCount
                        nodesCount
                        nodes {
                            id
                            slug
                            name
                            summary
                            category { name }
                            overallRating
                            overallRatingCount
                            endorsements
                            totalDownloads
                            firstPublishedAt
                            updatedAt
                            latestPublishedRevision {
                                adultContent
                                fileSize
                                modCount
                                revisionNumber
                                updatedAt
                            }
                            game { id domainName name }
                            user { memberId avatar name }
                            tileImage { url altText thumbnailUrl(size: small) }
                        }
                    }
                }
                "#,
                serde_json::json!({
                    "filter": filter,
                    "sort": Self::collection_catalog_sort(sort, !trimmed_query.is_empty()),
                    "offset": offset,
                    "count": page_size
                }),
            )
            .await?;

        let collections_node = data.get("collectionsV2").cloned().unwrap_or_default();
        let total_count = collections_node
            .get("totalCount")
            .and_then(Value::as_u64)
            .unwrap_or(0);
        let collections = collections_node
            .get("nodes")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let loaded_through = u64::from(offset) + collections.len() as u64;
        let page = NexusCollectionsPage {
            collections,
            total_count,
            offset,
            count: page_size,
            has_more: loaded_through < total_count,
        };
        Self::cached_map_set(&self.collection_catalog_cache, cache_key, page.clone()).await;
        Ok(page)
    }

    fn parse_optional_u32(value: Option<&Value>) -> Option<u32> {
        value
            .and_then(Value::as_u64)
            .and_then(|value| u32::try_from(value).ok())
            .or_else(|| {
                value
                    .and_then(Value::as_str)
                    .and_then(|value| value.parse::<u32>().ok())
            })
    }

    fn parse_optional_u64(value: Option<&Value>) -> Option<u64> {
        value.and_then(Value::as_u64).or_else(|| {
            value
                .and_then(Value::as_str)
                .and_then(|value| value.parse().ok())
        })
    }

    fn parse_collection_revision_plan(
        slug: &str,
        revision_number: u32,
        revision: &Value,
    ) -> NexusCollectionRevisionPlan {
        let mod_files = revision
            .get("modFiles")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .map(|entry| {
                let file = entry.get("file").filter(|value| !value.is_null());
                let mod_value = file.and_then(|file| file.get("mod"));
                let file_id = Self::parse_optional_u32(
                    entry
                        .get("fileId")
                        .or_else(|| file.and_then(|file| file.get("fileId"))),
                )
                .unwrap_or_default();
                NexusCollectionModFile {
                    collection_revision_mod_id: Self::json_string(entry.get("id")),
                    mod_id: Self::parse_optional_u32(file.and_then(|file| file.get("modId"))),
                    file_id,
                    game_id: Self::parse_optional_u32(entry.get("gameId")),
                    mod_name: mod_value
                        .and_then(|value| value.get("name"))
                        .and_then(Value::as_str)
                        .unwrap_or("Unavailable Nexus mod")
                        .to_string(),
                    file_name: file
                        .and_then(|value| value.get("name"))
                        .and_then(Value::as_str)
                        .unwrap_or("Unavailable Nexus file")
                        .to_string(),
                    version: file
                        .and_then(|value| value.get("version"))
                        .and_then(Value::as_str)
                        .or_else(|| entry.get("version").and_then(Value::as_str))
                        .unwrap_or_default()
                        .to_string(),
                    optional: entry
                        .get("optional")
                        .and_then(Value::as_bool)
                        .unwrap_or(false),
                    update_policy: entry
                        .get("updatePolicy")
                        .and_then(Value::as_str)
                        .map(str::to_string),
                    size_in_bytes: Self::parse_optional_u64(
                        file.and_then(|value| value.get("sizeInBytes")),
                    ),
                    uri: file
                        .and_then(|value| value.get("uri"))
                        .and_then(Value::as_str)
                        .map(str::to_string),
                    available: file.is_some() && file_id > 0,
                }
            })
            .collect();

        let external_resources = revision
            .get("externalResources")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .map(|entry| NexusCollectionExternalResource {
                id: Self::json_string(entry.get("id")),
                name: entry
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or("External resource")
                    .to_string(),
                optional: entry
                    .get("optional")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
                resource_type: entry
                    .get("resourceType")
                    .and_then(Value::as_str)
                    .unwrap_or("EXTERNAL")
                    .to_string(),
                resource_url: entry
                    .get("resourceUrl")
                    .and_then(Value::as_str)
                    .map(str::to_string),
                version: entry
                    .get("version")
                    .and_then(Value::as_str)
                    .map(str::to_string),
                author: entry
                    .get("author")
                    .and_then(Value::as_str)
                    .map(str::to_string),
            })
            .collect();

        NexusCollectionRevisionPlan {
            slug: slug.to_string(),
            revision_id: Self::json_string(revision.get("id")),
            revision_number: Self::parse_optional_u32(revision.get("revisionNumber"))
                .unwrap_or(revision_number),
            total_size: Self::parse_optional_u64(revision.get("totalSize")),
            mod_files,
            external_resources,
        }
    }

    pub async fn get_collection_revision_plan(
        &self,
        slug: &str,
        revision_number: u32,
    ) -> Result<NexusCollectionRevisionPlan> {
        let data = self
            .graphql_request(
                r#"
                query CollectionRevisionPlan($slug: String!, $revision: Int!) {
                    collectionRevision(slug: $slug, revision: $revision, viewAdultContent: true) {
                        id
                        revisionNumber
                        totalSize
                        modFiles {
                            id
                            fileId
                            gameId
                            optional
                            updatePolicy
                            version
                            file {
                                fileId
                                modId
                                name
                                version
                                sizeInBytes
                                uri
                                mod { name }
                            }
                        }
                        externalResources {
                            id
                            name
                            optional
                            resourceType
                            resourceUrl
                            version
                            author
                        }
                    }
                }
                "#,
                serde_json::json!({
                    "slug": slug,
                    "revision": revision_number,
                }),
            )
            .await?;
        let revision = data
            .get("collectionRevision")
            .filter(|value| !value.is_null())
            .ok_or_else(|| {
                anyhow::anyhow!(
                    "Nexus collection '{}' revision {} was not found",
                    slug,
                    revision_number
                )
            })?;

        Ok(Self::parse_collection_revision_plan(
            slug,
            revision_number,
            revision,
        ))
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
                        category
                        sizeInBytes
                        size
                        primary
                        uri
                        date
                        description
                        detectedFileExtension
                        totalDownloads
                        uniqueDownloads
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
            .connect_timeout(NEXUS_CONNECT_TIMEOUT)
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

#[cfg(test)]
mod tests {
    use super::*;

    fn env_u32(key: &str) -> Result<Option<u32>> {
        std::env::var(key)
            .ok()
            .filter(|value| !value.trim().is_empty())
            .map(|value| {
                value
                    .trim()
                    .parse::<u32>()
                    .map_err(|error| anyhow::anyhow!("Invalid {key}: {error}"))
            })
            .transpose()
    }

    fn looks_like_archive(bytes: &[u8]) -> bool {
        bytes.starts_with(b"PK\x03\x04")
            || bytes.starts_with(b"PK\x05\x06")
            || bytes.starts_with(b"PK\x07\x08")
            || bytes.starts_with(b"Rar!\x1a\x07")
            || bytes.starts_with(&[0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c])
    }

    #[test]
    fn parses_materialized_dependency_candidates() {
        let response = serde_json::json!({
            "data": {
                "dependencies": [
                    {
                        "id": "required-api",
                        "candidate_mod_files": [
                            {
                                "id": "api-file",
                                "name": "S1API",
                                "mod": {
                                    "id": "api-mod-internal",
                                    "game_scoped_id": "42",
                                    "name": "S1API"
                                },
                                "candidate_versions": [
                                    {
                                        "id": "api-version-internal",
                                        "game_scoped_id": "420",
                                        "version": "3.0.5"
                                    }
                                ]
                            }
                        ]
                    }
                ]
            }
        });

        let parsed = NexusModsService::parse_materialized_dependencies(
            "source-version".to_string(),
            &response,
        );

        assert_eq!(parsed.source_version_id, "source-version");
        assert_eq!(parsed.requirements.len(), 1);
        assert_eq!(parsed.requirements[0].id, "required-api");
        assert_eq!(parsed.requirements[0].candidates.len(), 1);
        assert_eq!(parsed.requirements[0].candidates[0].mod_id, "42");
        assert_eq!(
            parsed.requirements[0].candidates[0].version_game_scoped_id,
            "420"
        );
    }

    #[test]
    fn maps_rich_catalog_metadata_to_frontend_shape() {
        let mapped = NexusModsService::map_mod_node_to_legacy_shape(&serde_json::json!({
            "modId": 2573,
            "name": "No Employee Collisions",
            "summary": "Stops collisions",
            "description": "Details",
            "downloads": 21,
            "adultContent": false,
            "status": "published",
            "category": "Employees",
            "directDownloadEnabled": false,
            "supportsVortex": true,
            "tags": [{"name": "Gameplay"}],
            "uploader": {"name": "Uploader", "memberId": 42}
        }));

        assert_eq!(mapped["mod_id"], 2573);
        assert_eq!(mapped["description"], "Details");
        assert_eq!(mapped["category_name"], "Employees");
        assert_eq!(mapped["contains_adult_content"], false);
        assert_eq!(mapped["supports_vortex"], true);
        assert_eq!(mapped["tags"], serde_json::json!(["Gameplay"]));
        assert_eq!(mapped["uploader_member_id"], 42);
    }

    #[test]
    fn maps_catalog_sorts_and_defaults_relevance_without_a_query() {
        assert_eq!(
            NexusModsService::catalog_sort("popularity", false),
            serde_json::json!([{"downloads": {"direction": "DESC"}}])
        );
        assert_eq!(
            NexusModsService::catalog_sort("relevance", true),
            serde_json::json!([{"relevance": {"direction": "DESC"}}])
        );
        assert_eq!(
            NexusModsService::catalog_sort("relevance", false),
            serde_json::json!([{"updatedAt": {"direction": "DESC"}}])
        );
        assert_eq!(
            NexusModsService::collection_catalog_sort("popularity", false),
            serde_json::json!([{"downloads": {"direction": "DESC"}}])
        );
        assert_eq!(
            NexusModsService::collection_catalog_sort("relevance", true),
            serde_json::json!([{"relevance": {"direction": "DESC"}}])
        );
        assert_eq!(
            NexusModsService::collection_catalog_sort("relevance", false),
            serde_json::json!([{"updatedAt": {"direction": "DESC"}}])
        );
    }

    #[test]
    fn maps_collection_revision_to_exact_staging_plan() {
        let plan = NexusModsService::parse_collection_revision_plan(
            "example-collection",
            4,
            &serde_json::json!({
                "id": "revision-4",
                "revisionNumber": 4,
                "totalSize": "4096",
                "modFiles": [
                    {
                        "id": "revision-mod-1",
                        "fileId": 9001,
                        "gameId": 7381,
                        "optional": false,
                        "updatePolicy": "EXACT",
                        "version": "2.0.0",
                        "file": {
                            "fileId": 9001,
                            "modId": 42,
                            "name": "Example Mod 2.0",
                            "version": "2.0.0",
                            "sizeInBytes": "2048",
                            "uri": "nxm://schedule1/mods/42/files/9001",
                            "mod": { "name": "Example Mod" }
                        }
                    },
                    {
                        "id": "revision-mod-missing",
                        "fileId": 9002,
                        "gameId": 7381,
                        "optional": true,
                        "version": "1.0.0",
                        "file": null
                    }
                ],
                "externalResources": [{
                    "id": "external-1",
                    "name": "Manual prerequisite",
                    "optional": false,
                    "resourceType": "WEBSITE",
                    "resourceUrl": "https://example.com/prerequisite",
                    "version": "1.0",
                    "author": "Example Author"
                }]
            }),
        );

        assert_eq!(plan.slug, "example-collection");
        assert_eq!(plan.revision_id, "revision-4");
        assert_eq!(plan.revision_number, 4);
        assert_eq!(plan.total_size, Some(4096));
        assert_eq!(plan.mod_files.len(), 2);
        assert_eq!(plan.mod_files[0].mod_id, Some(42));
        assert_eq!(plan.mod_files[0].file_id, 9001);
        assert_eq!(plan.mod_files[0].size_in_bytes, Some(2048));
        assert!(plan.mod_files[0].available);
        assert!(!plan.mod_files[1].available);
        assert!(plan.mod_files[1].optional);
        assert_eq!(plan.external_resources.len(), 1);
        assert!(!plan.external_resources[0].optional);
    }

    #[tokio::test]
    #[ignore = "Queries live Nexus Mods Schedule I collection metadata"]
    async fn live_schedule_i_collection_catalog_returns_revision_metadata() -> Result<()> {
        let service = NexusModsService::new();
        let page = service
            .browse_collections_page("schedule1", "", "updated", 0, 2)
            .await?;

        assert!(page.total_count > 0, "Expected a Nexus collection catalog");
        assert_eq!(page.collections.len(), 2);
        assert!(page.collections.iter().all(|entry| {
            entry.get("slug").and_then(Value::as_str).is_some()
                && entry.get("latestPublishedRevision").is_some()
                && entry.get("user").is_some()
        }));
        Ok(())
    }

    #[tokio::test]
    #[ignore = "Queries a live Nexus Mods Schedule I collection revision"]
    async fn live_schedule_i_collection_revision_returns_exact_file_ids() -> Result<()> {
        let service = NexusModsService::new();
        let page = service
            .browse_collections_page("schedule1", "", "updated", 0, 10)
            .await?;
        let collection = page
            .collections
            .iter()
            .find(|entry| {
                entry
                    .get("latestPublishedRevision")
                    .and_then(|revision| revision.get("revisionNumber"))
                    .and_then(Value::as_u64)
                    .is_some()
            })
            .ok_or_else(|| anyhow::anyhow!("No published Schedule I collection found"))?;
        let slug = collection
            .get("slug")
            .and_then(Value::as_str)
            .ok_or_else(|| anyhow::anyhow!("Collection slug missing"))?;
        let revision_number = collection["latestPublishedRevision"]["revisionNumber"]
            .as_u64()
            .and_then(|value| u32::try_from(value).ok())
            .ok_or_else(|| anyhow::anyhow!("Collection revision missing"))?;
        let plan = service
            .get_collection_revision_plan(slug, revision_number)
            .await?;

        assert_eq!(plan.slug, slug);
        assert_eq!(plan.revision_number, revision_number);
        assert!(plan.mod_files.iter().all(|file| file.file_id > 0));
        Ok(())
    }

    #[tokio::test]
    #[ignore = "Queries live Nexus Mods Schedule I metadata"]
    async fn live_schedule_i_catalog_page_returns_total_and_rich_metadata() -> Result<()> {
        let service = NexusModsService::new();
        let page = service
            .browse_mods_page("schedule1", "", "updated", 0, 2)
            .await?;

        assert!(page.total_count > 2, "Expected a paginated Nexus catalog");
        assert_eq!(page.mods.len(), 2);
        assert!(page.has_more);
        assert!(page.mods.iter().all(|entry| {
            entry.get("mod_id").and_then(Value::as_u64).is_some()
                && entry.get("status").and_then(Value::as_str).is_some()
                && entry.get("description").is_some()
        }));
        Ok(())
    }

    #[tokio::test]
    #[ignore = "Queries live Nexus Mods Schedule I metadata"]
    async fn live_schedule_i_metadata_query_returns_files() -> Result<()> {
        let service = NexusModsService::new();
        let mods = service.get_latest_updated_mods("schedule1").await?;
        assert!(!mods.is_empty(), "Expected Nexus Schedule I mods");

        let mod_id = mods
            .iter()
            .find_map(|entry| entry.get("mod_id").and_then(|value| value.as_u64()))
            .ok_or_else(|| anyhow::anyhow!("No Nexus Schedule I mod id returned"))?
            as u32;
        let files = service.get_mod_files("schedule1", mod_id).await?;

        assert!(
            files.iter().any(|file| file
                .get("file_id")
                .and_then(|value| value.as_u64())
                .is_some()),
            "Expected Nexus Schedule I file metadata for mod {mod_id}"
        );
        Ok(())
    }

    #[tokio::test]
    #[ignore = "Requires SIMM_NEXUS_LIVE_ACCESS_TOKEN, SIMM_NEXUS_LIVE_MOD_ID, and SIMM_NEXUS_LIVE_FILE_ID"]
    async fn live_oauth_downloads_configured_schedule_i_file() -> Result<()> {
        let Some(access_token) = std::env::var("SIMM_NEXUS_LIVE_ACCESS_TOKEN")
            .ok()
            .filter(|value| !value.trim().is_empty())
        else {
            eprintln!("Skipping Nexus download smoke: SIMM_NEXUS_LIVE_ACCESS_TOKEN is not set.");
            return Ok(());
        };
        let Some(mod_id) = env_u32("SIMM_NEXUS_LIVE_MOD_ID")? else {
            eprintln!("Skipping Nexus download smoke: SIMM_NEXUS_LIVE_MOD_ID is not set.");
            return Ok(());
        };
        let Some(file_id) = env_u32("SIMM_NEXUS_LIVE_FILE_ID")? else {
            eprintln!("Skipping Nexus download smoke: SIMM_NEXUS_LIVE_FILE_ID is not set.");
            return Ok(());
        };

        let service = NexusModsService::new();
        let bytes = service
            .download_mod_file(&access_token, "schedule1", mod_id, file_id)
            .await?;

        assert!(bytes.len() > 128, "Expected Nexus download bytes");
        assert!(
            looks_like_archive(&bytes),
            "Expected Nexus download to have a known archive signature"
        );
        Ok(())
    }
}
