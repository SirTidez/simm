use crate::{db, utils::http_identity};
use anyhow::{Context, Result};
use flate2::read::GzDecoder;
use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    cmp::Ordering,
    collections::HashMap,
    error::Error,
    fmt,
    io::Read,
    path::PathBuf,
    sync::Arc,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tokio::{
    fs,
    sync::{Mutex as AsyncMutex, RwLock},
};

const THUNDERSTORE_BASE_URL: &str = "https://thunderstore.io";
const PACKAGE_LISTING_MEMORY_TTL: Duration = Duration::from_secs(15 * 60);
const PACKAGE_LISTING_REFRESH_INTERVAL: Duration = Duration::from_secs(60 * 60);
const PACKAGE_LISTING_MANUAL_REFRESH_COOLDOWN: Duration = Duration::from_secs(60);
const PACKAGE_LISTING_STALE_FALLBACK_TTL: Duration = Duration::from_secs(7 * 24 * 60 * 60);
const PACKAGE_DETAIL_MEMORY_TTL: Duration = Duration::from_secs(30 * 60);
const API_ISSUE_COOLDOWN: Duration = Duration::from_secs(5 * 60);

static SHARED_THUNDERSTORE_SERVICE: Lazy<Arc<ThunderStoreService>> =
    Lazy::new(|| Arc::new(ThunderStoreService::new()));

#[derive(Clone)]
pub struct ThunderStoreService {
    client: reqwest::Client,
    community_package_cache: Arc<RwLock<HashMap<String, CachedCommunityPackages>>>,
    package_cache: Arc<RwLock<HashMap<String, CachedPackage>>>,
    community_fetch_locks: Arc<AsyncMutex<HashMap<String, Arc<AsyncMutex<()>>>>>,
    package_fetch_locks: Arc<AsyncMutex<HashMap<String, Arc<AsyncMutex<()>>>>>,
    community_api_cooldowns: Arc<RwLock<HashMap<String, Instant>>>,
    manual_community_refresh_attempts: Arc<RwLock<HashMap<String, Instant>>>,
    request_stats: Arc<RwLock<ThunderstoreRequestStats>>,
}

#[derive(Clone)]
struct CachedCommunityPackages {
    loaded_at: Instant,
    saved_at_unix_secs: u64,
    packages: Vec<Value>,
}

#[derive(Clone)]
struct CachedPackage {
    loaded_at: Instant,
    package: Value,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThunderstoreRequestStats {
    listing_index_requests: u64,
    listing_chunk_requests: u64,
    package_detail_requests: u64,
    download_requests: u64,
    conditional_not_modified: u64,
    memory_cache_hits: u64,
    disk_cache_hits: u64,
    stale_disk_fallbacks: u64,
    forbidden_responses: u64,
    rate_limited_responses: u64,
}

pub struct ThunderstoreCommunityRefresh {
    pub packages: Vec<Value>,
    pub manually_throttled: bool,
    pub retry_after_seconds: Option<u64>,
}

#[derive(Clone, Copy)]
enum ThunderstoreRequestKind {
    ListingIndex,
    ListingChunk,
    PackageDetail,
    Download,
}

#[derive(Clone, Copy)]
enum CommunityCachePolicy {
    AllowStale,
    RefreshIfOlderThan(Duration),
}

#[derive(Clone)]
struct ThunderstoreHttpResponse {
    status: reqwest::StatusCode,
    bytes: Vec<u8>,
    last_modified: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct DiskCommunityCache {
    saved_at_unix_secs: u64,
    last_modified: Option<String>,
    chunk_urls: Vec<String>,
    packages: Vec<Value>,
}

#[derive(Debug)]
pub struct ThunderstoreApiIssue {
    status: u16,
    code: String,
    context: &'static str,
}

impl ThunderstoreApiIssue {
    fn new(status: reqwest::StatusCode, url: &str, context: &'static str) -> Self {
        let mut hasher = Sha256::new();
        hasher.update(format!("{}:{}:{}", status.as_u16(), context, url));
        let hash = hex::encode(hasher.finalize());
        let code = format!(
            "TS-{}-{}",
            status.as_u16(),
            hash.chars()
                .take(6)
                .collect::<String>()
                .to_ascii_uppercase()
        );

        Self {
            status: status.as_u16(),
            code,
            context,
        }
    }

    fn is_rate_or_block(&self) -> bool {
        self.status == 403 || self.status == 429
    }
}

impl fmt::Display for ThunderstoreApiIssue {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let reason = match self.status {
            403 => "Thunderstore is refusing SIMM's request right now.",
            429 => "Thunderstore is rate limiting SIMM right now.",
            _ => "Thunderstore API is having issues right now.",
        };

        write!(
            f,
            "{} Please wait a few minutes and try again. If this keeps happening, send SIMM support this error code: {}. Context: {}.",
            reason, self.code, self.context
        )
    }
}

impl Error for ThunderstoreApiIssue {}

pub fn shared_thunderstore_service() -> Arc<ThunderStoreService> {
    SHARED_THUNDERSTORE_SERVICE.clone()
}

impl ThunderStoreService {
    pub fn new() -> Self {
        let client = reqwest::Client::builder()
            .user_agent(http_identity::user_agent())
            .redirect(reqwest::redirect::Policy::limited(5))
            .build()
            .expect("failed to build Thunderstore HTTP client");

        Self {
            client,
            community_package_cache: Arc::new(RwLock::new(HashMap::new())),
            package_cache: Arc::new(RwLock::new(HashMap::new())),
            community_fetch_locks: Arc::new(AsyncMutex::new(HashMap::new())),
            package_fetch_locks: Arc::new(AsyncMutex::new(HashMap::new())),
            community_api_cooldowns: Arc::new(RwLock::new(HashMap::new())),
            manual_community_refresh_attempts: Arc::new(RwLock::new(HashMap::new())),
            request_stats: Arc::new(RwLock::new(ThunderstoreRequestStats::default())),
        }
    }

    pub async fn request_stats(&self) -> ThunderstoreRequestStats {
        self.request_stats.read().await.clone()
    }

    async fn record_request(&self, kind: ThunderstoreRequestKind) {
        let mut stats = self.request_stats.write().await;
        match kind {
            ThunderstoreRequestKind::ListingIndex => stats.listing_index_requests += 1,
            ThunderstoreRequestKind::ListingChunk => stats.listing_chunk_requests += 1,
            ThunderstoreRequestKind::PackageDetail => stats.package_detail_requests += 1,
            ThunderstoreRequestKind::Download => stats.download_requests += 1,
        }
    }

    async fn record_status(&self, status: reqwest::StatusCode) {
        let mut stats = self.request_stats.write().await;
        match status {
            reqwest::StatusCode::NOT_MODIFIED => stats.conditional_not_modified += 1,
            reqwest::StatusCode::FORBIDDEN => stats.forbidden_responses += 1,
            reqwest::StatusCode::TOO_MANY_REQUESTS => stats.rate_limited_responses += 1,
            _ => {}
        }
    }

    async fn record_memory_cache_hit(&self) {
        self.request_stats.write().await.memory_cache_hits += 1;
    }

    async fn record_disk_cache_hit(&self) {
        self.request_stats.write().await.disk_cache_hits += 1;
    }

    async fn record_stale_disk_fallback(&self) {
        self.request_stats.write().await.stale_disk_fallbacks += 1;
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

    fn decode_gzip_json<T>(bytes: &[u8], context: &'static str) -> Result<T>
    where
        T: serde::de::DeserializeOwned,
    {
        let decoded = if bytes.starts_with(&[0x1f, 0x8b]) {
            let mut decoder = GzDecoder::new(bytes);
            let mut decoded = Vec::new();
            decoder
                .read_to_end(&mut decoded)
                .with_context(|| format!("Failed to gunzip Thunderstore {}", context))?;
            decoded
        } else {
            bytes.to_vec()
        };

        serde_json::from_slice(&decoded)
            .with_context(|| format!("Failed to parse Thunderstore {}", context))
    }

    async fn get_bytes(
        &self,
        url: &str,
        accept: &'static str,
        kind: ThunderstoreRequestKind,
        if_modified_since: Option<&str>,
        context: &'static str,
    ) -> Result<ThunderstoreHttpResponse> {
        self.record_request(kind).await;

        let mut request = self.client.get(url).header(reqwest::header::ACCEPT, accept);
        if let Some(last_modified) = if_modified_since {
            request = request.header(reqwest::header::IF_MODIFIED_SINCE, last_modified);
        }

        let response = request
            .send()
            .await
            .with_context(|| format!("Thunderstore request failed for {}", url))?;

        let status = response.status();
        self.record_status(status).await;

        if status == reqwest::StatusCode::NOT_MODIFIED {
            return Ok(ThunderstoreHttpResponse {
                status,
                bytes: Vec::new(),
                last_modified: None,
            });
        }

        if !status.is_success() {
            return Err(ThunderstoreApiIssue::new(status, url, context).into());
        }

        let last_modified = response
            .headers()
            .get(reqwest::header::LAST_MODIFIED)
            .and_then(|value| value.to_str().ok())
            .map(|value| value.to_string());
        let bytes = response
            .bytes()
            .await
            .with_context(|| format!("Failed to read Thunderstore response for {}", url))?;

        Ok(ThunderstoreHttpResponse {
            status,
            bytes: bytes.to_vec(),
            last_modified,
        })
    }

    fn community_package_listing_index_url(game_id: &str) -> String {
        format!(
            "{}/c/{}/api/v1/package-listing-index/",
            THUNDERSTORE_BASE_URL,
            game_id.trim_matches('/')
        )
    }

    fn community_package_read_url(game_id: &str, package_uuid: &str) -> String {
        format!(
            "{}/c/{}/api/v1/package/{}/",
            THUNDERSTORE_BASE_URL,
            game_id.trim_matches('/'),
            package_uuid.trim_matches('/')
        )
    }

    fn package_read_url(package_uuid: &str) -> String {
        format!(
            "{}/api/v1/package/{}/",
            THUNDERSTORE_BASE_URL,
            package_uuid.trim_matches('/')
        )
    }

    fn cache_key_for_community(game_id: &str) -> Result<String> {
        let cache_key = game_id.trim().trim_matches('/').to_ascii_lowercase();
        if cache_key.is_empty() {
            return Err(anyhow::anyhow!("Thunderstore community id is required"));
        }
        Ok(cache_key)
    }

    fn sanitize_cache_component(value: &str) -> String {
        let sanitized: String = value
            .chars()
            .map(|ch| {
                if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' {
                    ch
                } else {
                    '-'
                }
            })
            .collect();
        sanitized.trim_matches('-').to_string()
    }

    fn current_unix_secs() -> u64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|value| value.as_secs())
            .unwrap_or_default()
    }

    fn disk_cache_age(cache: &DiskCommunityCache) -> Duration {
        Duration::from_secs(Self::current_unix_secs().saturating_sub(cache.saved_at_unix_secs))
    }

    fn cached_community_age(cache: &CachedCommunityPackages) -> Duration {
        Duration::from_secs(Self::current_unix_secs().saturating_sub(cache.saved_at_unix_secs))
    }

    fn cache_is_usable_for_policy(age: Duration, policy: CommunityCachePolicy) -> bool {
        match policy {
            CommunityCachePolicy::AllowStale => age < PACKAGE_LISTING_STALE_FALLBACK_TTL,
            CommunityCachePolicy::RefreshIfOlderThan(max_age) => age < max_age,
        }
    }

    fn cached_community_from_disk(cache: &DiskCommunityCache) -> CachedCommunityPackages {
        CachedCommunityPackages {
            loaded_at: Instant::now(),
            saved_at_unix_secs: cache.saved_at_unix_secs,
            packages: cache.packages.clone(),
        }
    }

    fn cached_community_from_refreshed(cache: &DiskCommunityCache) -> CachedCommunityPackages {
        CachedCommunityPackages {
            loaded_at: Instant::now(),
            saved_at_unix_secs: cache.saved_at_unix_secs,
            packages: cache.packages.clone(),
        }
    }

    fn community_cache_path(cache_key: &str) -> Result<PathBuf> {
        Ok(db::get_data_dir()?
            .join("cache")
            .join("thunderstore")
            .join("communities")
            .join(format!(
                "{}.json",
                Self::sanitize_cache_component(cache_key)
            )))
    }

    async fn read_disk_cache(cache_key: &str) -> Option<DiskCommunityCache> {
        let path = Self::community_cache_path(cache_key).ok()?;
        let content = fs::read_to_string(path).await.ok()?;
        serde_json::from_str::<DiskCommunityCache>(&content).ok()
    }

    async fn write_disk_cache(cache_key: &str, cache: &DiskCommunityCache) -> Result<()> {
        let path = Self::community_cache_path(cache_key)?;
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).await.with_context(|| {
                format!(
                    "Failed to create Thunderstore cache dir {}",
                    parent.display()
                )
            })?;
        }
        let serialized =
            serde_json::to_string(cache).context("Failed to serialize Thunderstore cache")?;
        fs::write(&path, serialized)
            .await
            .with_context(|| format!("Failed to write Thunderstore cache {}", path.display()))?;
        Ok(())
    }

    async fn community_fetch_lock(&self, cache_key: &str) -> Arc<AsyncMutex<()>> {
        let mut locks = self.community_fetch_locks.lock().await;
        locks
            .entry(cache_key.to_string())
            .or_insert_with(|| Arc::new(AsyncMutex::new(())))
            .clone()
    }

    async fn package_fetch_lock(&self, cache_key: &str) -> Arc<AsyncMutex<()>> {
        let mut locks = self.package_fetch_locks.lock().await;
        locks
            .entry(cache_key.to_string())
            .or_insert_with(|| Arc::new(AsyncMutex::new(())))
            .clone()
    }

    async fn community_in_cooldown(&self, cache_key: &str) -> bool {
        self.community_api_cooldowns
            .read()
            .await
            .get(cache_key)
            .is_some_and(|until| Instant::now() < *until)
    }

    async fn set_community_cooldown(&self, cache_key: &str) {
        self.community_api_cooldowns
            .write()
            .await
            .insert(cache_key.to_string(), Instant::now() + API_ISSUE_COOLDOWN);
    }

    async fn manual_community_refresh_retry_after(&self, cache_key: &str) -> Option<Duration> {
        let attempts = self.manual_community_refresh_attempts.read().await;
        let last_attempt = attempts.get(cache_key)?;
        let elapsed = last_attempt.elapsed();
        if elapsed < PACKAGE_LISTING_MANUAL_REFRESH_COOLDOWN {
            Some(PACKAGE_LISTING_MANUAL_REFRESH_COOLDOWN - elapsed)
        } else {
            None
        }
    }

    async fn mark_manual_community_refresh_attempt(&self, cache_key: &str) {
        self.manual_community_refresh_attempts
            .write()
            .await
            .insert(cache_key.to_string(), Instant::now());
    }

    fn package_cache_key(package_uuid: &str, game_id: Option<&str>) -> String {
        format!(
            "{}:{}",
            game_id
                .unwrap_or("global")
                .trim_matches('/')
                .to_ascii_lowercase(),
            package_uuid.trim_matches('/').to_ascii_lowercase()
        )
    }

    fn extract_package_uuid(package: &Value) -> Option<String> {
        for key in ["uuid4", "uuid", "package_uuid", "packageId", "package_id"] {
            if let Some(value) = package.get(key).and_then(|value| value.as_str()) {
                return Some(value.to_string());
            }
        }
        None
    }

    async fn cache_packages_by_uuid(&self, game_id: &str, packages: &[Value]) {
        let mut cache = self.package_cache.write().await;
        for package in packages {
            if let Some(uuid) = Self::extract_package_uuid(package) {
                cache.insert(
                    Self::package_cache_key(&uuid, Some(game_id)),
                    CachedPackage {
                        loaded_at: Instant::now(),
                        package: package.clone(),
                    },
                );
            }
        }
    }

    async fn fetch_community_packages_uncached(
        &self,
        game_id: &str,
        disk_cache: Option<&DiskCommunityCache>,
    ) -> Result<DiskCommunityCache> {
        let index_url = Self::community_package_listing_index_url(game_id);
        let index_response = self
            .get_bytes(
                &index_url,
                "application/json, application/octet-stream, */*",
                ThunderstoreRequestKind::ListingIndex,
                disk_cache.and_then(|cache| cache.last_modified.as_deref()),
                "package listing index",
            )
            .await?;

        if index_response.status == reqwest::StatusCode::NOT_MODIFIED {
            let mut cache = disk_cache
                .cloned()
                .ok_or_else(|| anyhow::anyhow!("Thunderstore returned 304 without cached data"))?;
            cache.saved_at_unix_secs = Self::current_unix_secs();
            return Ok(cache);
        }

        let chunk_urls: Vec<String> =
            Self::decode_gzip_json(&index_response.bytes, "package listing index")?;

        let mut packages = Vec::new();
        for chunk_url in &chunk_urls {
            let parsed = reqwest::Url::parse(chunk_url).with_context(|| {
                format!(
                    "Invalid Thunderstore package listing chunk URL: {}",
                    chunk_url
                )
            })?;
            if parsed.scheme() != "https" {
                return Err(anyhow::anyhow!(
                    "Thunderstore package listing chunk URL must use HTTPS: {}",
                    chunk_url
                ));
            }

            let chunk_response = self
                .get_bytes(
                    chunk_url,
                    "application/json, application/octet-stream, */*",
                    ThunderstoreRequestKind::ListingChunk,
                    None,
                    "package listing chunk",
                )
                .await?;
            let mut chunk_packages: Vec<Value> =
                Self::decode_gzip_json(&chunk_response.bytes, "package listing chunk")?;
            packages.append(&mut chunk_packages);
        }

        Ok(DiskCommunityCache {
            saved_at_unix_secs: Self::current_unix_secs(),
            last_modified: index_response
                .last_modified
                .or_else(|| disk_cache.and_then(|cache| cache.last_modified.clone())),
            chunk_urls,
            packages,
        })
    }

    fn is_rate_or_block_error(error: &anyhow::Error) -> bool {
        error
            .chain()
            .find_map(|cause| cause.downcast_ref::<ThunderstoreApiIssue>())
            .is_some_and(ThunderstoreApiIssue::is_rate_or_block)
    }

    async fn get_community_packages_with_policy(
        &self,
        game_id: &str,
        policy: CommunityCachePolicy,
    ) -> Result<Vec<Value>> {
        let cache_key = Self::cache_key_for_community(game_id)?;

        {
            let cache = self.community_package_cache.read().await;
            if let Some(cached) = cache.get(&cache_key) {
                let age = Self::cached_community_age(cached);
                let memory_is_recent = matches!(policy, CommunityCachePolicy::AllowStale)
                    && cached.loaded_at.elapsed() < PACKAGE_LISTING_MEMORY_TTL;
                if Self::cache_is_usable_for_policy(age, policy) || memory_is_recent {
                    self.record_memory_cache_hit().await;
                    return Ok(cached.packages.clone());
                }
            }
        }

        let lock = self.community_fetch_lock(&cache_key).await;
        let _guard = lock.lock().await;

        {
            let cache = self.community_package_cache.read().await;
            if let Some(cached) = cache.get(&cache_key) {
                let age = Self::cached_community_age(cached);
                let memory_is_recent = matches!(policy, CommunityCachePolicy::AllowStale)
                    && cached.loaded_at.elapsed() < PACKAGE_LISTING_MEMORY_TTL;
                if Self::cache_is_usable_for_policy(age, policy) || memory_is_recent {
                    self.record_memory_cache_hit().await;
                    return Ok(cached.packages.clone());
                }
            }
        }

        let disk_cache = Self::read_disk_cache(&cache_key).await;
        if let Some(cache) = disk_cache.as_ref() {
            let age = Self::disk_cache_age(cache);
            if Self::cache_is_usable_for_policy(age, policy) {
                self.record_disk_cache_hit().await;
                self.community_package_cache
                    .write()
                    .await
                    .insert(cache_key.clone(), Self::cached_community_from_disk(cache));
                self.cache_packages_by_uuid(&cache_key, &cache.packages)
                    .await;
                return Ok(cache.packages.clone());
            }

            if self.community_in_cooldown(&cache_key).await
                && Self::disk_cache_age(cache) < PACKAGE_LISTING_STALE_FALLBACK_TTL
            {
                self.record_stale_disk_fallback().await;
                self.community_package_cache
                    .write()
                    .await
                    .insert(cache_key.clone(), Self::cached_community_from_disk(cache));
                self.cache_packages_by_uuid(&cache_key, &cache.packages)
                    .await;
                return Ok(cache.packages.clone());
            }
        }

        match self
            .fetch_community_packages_uncached(&cache_key, disk_cache.as_ref())
            .await
        {
            Ok(cache) => {
                if let Err(error) = Self::write_disk_cache(&cache_key, &cache).await {
                    log::warn!("Failed to write Thunderstore disk cache: {}", error);
                }
                self.community_package_cache.write().await.insert(
                    cache_key.clone(),
                    Self::cached_community_from_refreshed(&cache),
                );
                self.cache_packages_by_uuid(&cache_key, &cache.packages)
                    .await;
                Ok(cache.packages)
            }
            Err(error) => {
                if Self::is_rate_or_block_error(&error) {
                    self.set_community_cooldown(&cache_key).await;
                }
                if let Some(cache) = disk_cache {
                    if Self::is_rate_or_block_error(&error)
                        && Self::disk_cache_age(&cache) < PACKAGE_LISTING_STALE_FALLBACK_TTL
                    {
                        self.record_stale_disk_fallback().await;
                        log::warn!(
                            "Using stale Thunderstore package listing cache for {} after API issue: {}",
                            cache_key,
                            error
                        );
                        self.community_package_cache
                            .write()
                            .await
                            .insert(cache_key.clone(), Self::cached_community_from_disk(&cache));
                        self.cache_packages_by_uuid(&cache_key, &cache.packages)
                            .await;
                        return Ok(cache.packages);
                    }
                }
                Err(error)
            }
        }
    }

    async fn get_community_packages(&self, game_id: &str) -> Result<Vec<Value>> {
        self.get_community_packages_with_policy(game_id, CommunityCachePolicy::AllowStale)
            .await
    }

    pub async fn warm_community_cache(&self, game_id: &str) -> Result<Vec<Value>> {
        self.get_community_packages_with_policy(game_id, CommunityCachePolicy::AllowStale)
            .await
    }

    pub async fn refresh_community_cache_if_stale(
        &self,
        game_id: &str,
        max_age: Option<Duration>,
    ) -> Result<Vec<Value>> {
        self.get_community_packages_with_policy(
            game_id,
            CommunityCachePolicy::RefreshIfOlderThan(
                max_age.unwrap_or(PACKAGE_LISTING_REFRESH_INTERVAL),
            ),
        )
        .await
    }

    async fn get_stale_safe_cached_community_packages(
        &self,
        cache_key: &str,
    ) -> Option<Vec<Value>> {
        {
            let cache = self.community_package_cache.read().await;
            if let Some(cached) = cache.get(cache_key) {
                if Self::cached_community_age(cached) < PACKAGE_LISTING_STALE_FALLBACK_TTL {
                    self.record_memory_cache_hit().await;
                    return Some(cached.packages.clone());
                }
            }
        }

        let disk_cache = Self::read_disk_cache(cache_key).await?;
        if Self::disk_cache_age(&disk_cache) < PACKAGE_LISTING_STALE_FALLBACK_TTL {
            self.record_disk_cache_hit().await;
            self.community_package_cache.write().await.insert(
                cache_key.to_string(),
                Self::cached_community_from_disk(&disk_cache),
            );
            self.cache_packages_by_uuid(cache_key, &disk_cache.packages)
                .await;
            return Some(disk_cache.packages);
        }

        None
    }

    pub async fn refresh_community_cache_manually(
        &self,
        game_id: &str,
        max_age: Option<Duration>,
    ) -> Result<ThunderstoreCommunityRefresh> {
        let cache_key = Self::cache_key_for_community(game_id)?;

        if let Some(retry_after) = self.manual_community_refresh_retry_after(&cache_key).await {
            if let Some(packages) = self
                .get_stale_safe_cached_community_packages(&cache_key)
                .await
            {
                return Ok(ThunderstoreCommunityRefresh {
                    packages,
                    manually_throttled: true,
                    retry_after_seconds: Some(retry_after.as_secs().max(1)),
                });
            }

            return Err(anyhow::anyhow!(
                "Thunderstore package cache was refreshed less than a minute ago. Please wait {} seconds before trying again.",
                retry_after.as_secs().max(1)
            ));
        }

        self.mark_manual_community_refresh_attempt(&cache_key).await;
        let packages = self
            .refresh_community_cache_if_stale(game_id, max_age)
            .await?;
        Ok(ThunderstoreCommunityRefresh {
            packages,
            manually_throttled: false,
            retry_after_seconds: None,
        })
    }

    fn query_matches_package(pkg: &Value, query: &str) -> bool {
        let query_lower = query.trim().to_lowercase();
        if query_lower.is_empty() {
            return true;
        }

        let contains_query = |value: Option<&str>| {
            value
                .unwrap_or_default()
                .to_lowercase()
                .contains(&query_lower)
        };

        contains_query(pkg.get("name").and_then(|value| value.as_str()))
            || contains_query(pkg.get("full_name").and_then(|value| value.as_str()))
            || contains_query(pkg.get("owner").and_then(|value| value.as_str()))
            || contains_query(
                pkg.get("latest")
                    .and_then(|latest| latest.get("full_name"))
                    .and_then(|value| value.as_str()),
            )
            || contains_query(
                pkg.get("latest")
                    .and_then(|latest| latest.get("description"))
                    .and_then(|value| value.as_str()),
            )
            || contains_query(
                pkg.get("versions")
                    .and_then(|value| value.as_array())
                    .and_then(|versions| versions.first())
                    .and_then(|version| version.get("description"))
                    .and_then(|value| value.as_str()),
            )
    }

    fn package_matches_runtime(pkg: &Value, runtime: &str) -> bool {
        if runtime.eq_ignore_ascii_case("unknown") {
            return true;
        }

        let runtime_lower = runtime.to_lowercase();
        let other_runtime = if runtime_lower == "il2cpp" {
            "mono"
        } else {
            "il2cpp"
        };
        let name = pkg
            .get("name")
            .and_then(|n| n.as_str())
            .unwrap_or("")
            .to_lowercase();
        let full_name = pkg
            .get("full_name")
            .or_else(|| pkg.get("latest").and_then(|l| l.get("full_name")))
            .and_then(|n| n.as_str())
            .unwrap_or("")
            .to_lowercase();

        let categories = pkg
            .get("categories")
            .and_then(|c| c.as_array())
            .map(|cats| {
                cats.iter()
                    .filter_map(|cat| cat.as_str())
                    .map(|cat| cat.to_lowercase())
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();

        let has_target_runtime_category = categories.iter().any(|cat| cat == &runtime_lower);
        let has_other_runtime_category = categories.iter().any(|cat| cat == other_runtime);

        if has_other_runtime_category && !has_target_runtime_category {
            return false;
        }

        if has_target_runtime_category {
            return true;
        }

        if name.contains(other_runtime) || full_name.contains(other_runtime) {
            return false;
        }

        name.contains(&runtime_lower)
            || full_name.contains(&runtime_lower)
            || (!name.contains("il2cpp")
                && !name.contains("mono")
                && !full_name.contains("il2cpp")
                && !full_name.contains("mono"))
    }

    fn package_is_active(pkg: &Value) -> bool {
        !pkg.get("is_deprecated")
            .and_then(|d| d.as_bool())
            .unwrap_or(false)
            && !pkg
                .get("latest")
                .and_then(|l| l.get("is_deprecated"))
                .and_then(|d| d.as_bool())
                .unwrap_or(false)
    }

    fn apply_common_package_filters(packages: Vec<Value>, query: Option<&str>) -> Vec<Value> {
        packages
            .into_iter()
            .filter(Self::package_is_active)
            .filter(|pkg| query.is_none_or(|query| Self::query_matches_package(pkg, query)))
            .collect()
    }

    pub async fn search_packages_filtered_by_runtime(
        &self,
        game_id: &str,
        runtime: &str,
        query: Option<&str>,
    ) -> Result<Vec<Value>> {
        let packages =
            Self::apply_common_package_filters(self.get_community_packages(game_id).await?, query);
        Ok(packages
            .into_iter()
            .filter(|pkg| Self::package_matches_runtime(pkg, runtime))
            .collect())
    }

    pub async fn search_packages_grouped_by_runtime(
        &self,
        game_id: &str,
        query: Option<&str>,
    ) -> Result<Value> {
        let packages =
            Self::apply_common_package_filters(self.get_community_packages(game_id).await?, query);
        let il2cpp = packages
            .iter()
            .filter(|pkg| Self::package_matches_runtime(pkg, "IL2CPP"))
            .cloned()
            .collect::<Vec<_>>();
        let mono = packages
            .iter()
            .filter(|pkg| Self::package_matches_runtime(pkg, "Mono"))
            .cloned()
            .collect::<Vec<_>>();
        Ok(serde_json::json!({
            "IL2CPP": il2cpp,
            "Mono": mono,
        }))
    }

    async fn get_cached_package(&self, cache_key: &str) -> Option<Value> {
        let cache = self.package_cache.read().await;
        cache.get(cache_key).and_then(|cached| {
            if cached.loaded_at.elapsed() < PACKAGE_DETAIL_MEMORY_TTL {
                Some(cached.package.clone())
            } else {
                None
            }
        })
    }

    async fn find_package_in_community_listing(
        &self,
        package_uuid: &str,
        game_id: &str,
    ) -> Result<Option<Value>> {
        let packages = self.get_community_packages(game_id).await?;
        let uuid = package_uuid.trim_matches('/');
        Ok(packages.into_iter().find(|package| {
            Self::extract_package_uuid(package)
                .as_deref()
                .is_some_and(|candidate| candidate.eq_ignore_ascii_case(uuid))
        }))
    }

    pub async fn get_package(
        &self,
        package_uuid: &str,
        game_id: Option<&str>,
    ) -> Result<Option<Value>> {
        if package_uuid.contains('/') {
            return Ok(None);
        }

        let cache_key = Self::package_cache_key(package_uuid, game_id);
        if let Some(package) = self.get_cached_package(&cache_key).await {
            self.record_memory_cache_hit().await;
            return Ok(Some(package));
        }

        if let Some(gid) = game_id {
            if let Some(package) = self
                .find_package_in_community_listing(package_uuid, gid)
                .await?
            {
                self.package_cache.write().await.insert(
                    cache_key,
                    CachedPackage {
                        loaded_at: Instant::now(),
                        package: package.clone(),
                    },
                );
                return Ok(Some(package));
            }
        }

        let lock = self.package_fetch_lock(&cache_key).await;
        let _guard = lock.lock().await;
        if let Some(package) = self.get_cached_package(&cache_key).await {
            self.record_memory_cache_hit().await;
            return Ok(Some(package));
        }

        let url = if let Some(gid) = game_id {
            Self::community_package_read_url(gid, package_uuid)
        } else {
            Self::package_read_url(package_uuid)
        };

        let response = self
            .get_bytes(
                &url,
                "application/json, application/octet-stream, */*",
                ThunderstoreRequestKind::PackageDetail,
                None,
                "package detail",
            )
            .await;

        let response = match response {
            Ok(response) => response,
            Err(error) => {
                if error
                    .chain()
                    .find_map(|cause| cause.downcast_ref::<ThunderstoreApiIssue>())
                    .is_some_and(|issue| issue.status == 404)
                {
                    return Ok(None);
                }
                return Err(error);
            }
        };

        let package: Value = serde_json::from_slice(&response.bytes)
            .context("Failed to parse Thunderstore package response")?;
        self.package_cache.write().await.insert(
            cache_key,
            CachedPackage {
                loaded_at: Instant::now(),
                package: package.clone(),
            },
        );
        Ok(Some(package))
    }

    pub async fn download_package_version(
        &self,
        package: &Value,
        version_uuid: Option<&str>,
    ) -> Result<Vec<u8>> {
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

        let response = self
            .get_bytes(
                download_url,
                "application/octet-stream, application/zip, */*",
                ThunderstoreRequestKind::Download,
                None,
                "package download",
            )
            .await?;

        Ok(response.bytes)
    }

    pub async fn download_package(
        &self,
        package_uuid: &str,
        game_id: Option<&str>,
        version_uuid: Option<&str>,
    ) -> Result<Vec<u8>> {
        let package = self
            .get_package(package_uuid, game_id)
            .await?
            .ok_or_else(|| anyhow::anyhow!("Package not found"))?;
        self.download_package_version(&package, version_uuid).await
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

    fn extract_package_id(package: &Value) -> Option<String> {
        ThunderStoreService::extract_package_uuid(package)
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

    #[test]
    fn thunderstore_api_issue_formats_reportable_code() {
        let issue = ThunderstoreApiIssue::new(
            reqwest::StatusCode::TOO_MANY_REQUESTS,
            "https://thunderstore.io/c/schedule-i/api/v1/package-listing-index/",
            "package listing index",
        );
        let message = issue.to_string();
        assert!(message.contains("rate limiting SIMM"));
        assert!(message.contains("TS-429-"));
        assert!(message.contains("package listing index"));
    }

    #[test]
    fn community_cache_policy_allows_stale_reads_but_refresh_policy_expires_hourly() {
        assert!(ThunderStoreService::cache_is_usable_for_policy(
            Duration::from_secs(6 * 60 * 60),
            CommunityCachePolicy::AllowStale,
        ));
        assert!(!ThunderStoreService::cache_is_usable_for_policy(
            Duration::from_secs(6 * 60 * 60),
            CommunityCachePolicy::RefreshIfOlderThan(Duration::from_secs(60 * 60)),
        ));
        assert!(ThunderStoreService::cache_is_usable_for_policy(
            Duration::from_secs(30 * 60),
            CommunityCachePolicy::RefreshIfOlderThan(Duration::from_secs(60 * 60)),
        ));
    }

    #[tokio::test]
    async fn manual_refresh_throttle_returns_cached_packages_without_network() {
        let service = ThunderStoreService::new();
        let cache_key = "schedule-i";
        service.community_package_cache.write().await.insert(
            cache_key.to_string(),
            CachedCommunityPackages {
                loaded_at: Instant::now(),
                saved_at_unix_secs: ThunderStoreService::current_unix_secs()
                    .saturating_sub(2 * 60 * 60),
                packages: vec![serde_json::json!({
                    "uuid4": "cached-package",
                    "name": "CachedPackage",
                })],
            },
        );
        service
            .mark_manual_community_refresh_attempt(cache_key)
            .await;

        let refresh = service
            .refresh_community_cache_manually(cache_key, Some(Duration::from_secs(0)))
            .await
            .expect("manual refresh should return cached packages while throttled");

        assert!(refresh.manually_throttled);
        assert_eq!(refresh.packages.len(), 1);
        assert!(refresh.retry_after_seconds.is_some_and(|value| value > 0));
        assert_eq!(service.request_stats().await.listing_index_requests, 0);
    }
}
