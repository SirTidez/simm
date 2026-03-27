use crate::services::settings::SettingsService;
use crate::types::{
    Environment, ModLibraryEntry, ModLibraryResult, ModMetadata, ModSource,
    SecurityFindingSeverity, SecurityScanDisposition, SecurityScanDispositionClassification,
    SecurityScanPolicy, SecurityScanReport, SecurityScanState, SecurityScanSummary,
};
use anyhow::{Context, Result};
use chrono::{DateTime, TimeZone, Utc};
use once_cell::sync::Lazy;
use regex::Regex;
use reqwest::header::CONTENT_LENGTH;
use sha2::{Digest, Sha256};
use sqlx::SqlitePool;
use std::collections::{HashMap, HashSet};
use std::fs::File;
use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;
use tokio::fs;
#[cfg(target_os = "windows")]
use tokio::process::Command;
use unrar::Archive;
use uuid::Uuid;
use zip::ZipArchive;

macro_rules! eprintln {
    ($($arg:tt)*) => {{
        crate::utils::logging::route_stderr_log(format!($($arg)*));
    }};
}

const STORAGE_METADATA_FILE: &str = ".storage-metadata.json";
const STORAGE_SECURITY_SCAN_FILE: &str = ".security-scan.json";
const RUNTIME_IL2CPP: &str = "IL2CPP";
const RUNTIME_MONO: &str = "Mono";
const MAX_ICON_BYTES: usize = 5 * 1024 * 1024;
const ICON_FETCH_TIMEOUT_SECONDS: u64 = 15;

static RUNTIME_SUFFIX_PATTERNS: Lazy<Vec<Regex>> = Lazy::new(|| {
    vec![
        Regex::new(r"(?i)\s*[\(\[]\s*(mono|il2cpp)\s*[\)\]]\s*$").expect("runtime suffix regex"),
        Regex::new(r"(?i)\s*[-_]\s*(mono|il2cpp)\s*$").expect("runtime suffix regex"),
        Regex::new(r"(?i)\s+(mono|il2cpp)\s*$").expect("runtime suffix regex"),
    ]
});

#[derive(Clone)]
pub struct ModsService {
    pool: Arc<SqlitePool>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ModInfo {
    name: String,
    file_name: String,
    path: String,
    version: Option<String>,
    source: Option<ModSource>,
    source_url: Option<String>,
    disabled: Option<bool>,
    mod_storage_id: Option<String>,
    managed: bool,
    summary: Option<String>,
    icon_url: Option<String>,
    icon_cache_path: Option<String>,
    downloads: Option<u64>,
    likes_or_endorsements: Option<i64>,
    updated_at: Option<String>,
    tags: Option<Vec<String>>,
    #[serde(with = "chrono::serde::ts_seconds_option")]
    installed_at: Option<chrono::DateTime<chrono::Utc>>,
    security_scan: Option<crate::types::SecurityScanSummary>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ModsListResult {
    mods: Vec<ModInfo>,
    mods_directory: String,
    count: usize,
}

impl ModsService {
    pub fn new(pool: Arc<SqlitePool>) -> Self {
        Self { pool }
    }

    fn get_mods_directory(&self, output_dir: &str) -> PathBuf {
        Path::new(output_dir).join("Mods")
    }

    fn get_plugins_directory(&self, output_dir: &str) -> PathBuf {
        Path::new(output_dir).join("Plugins")
    }

    fn normalize_path(path: &str) -> String {
        path.replace('/', "\\")
            .trim_end_matches(['\\', '/'])
            .to_ascii_lowercase()
    }

    async fn environment_id_for_dir(&self, game_dir: &str) -> Result<Option<String>> {
        if game_dir.is_empty() {
            return Ok(None);
        }

        let normalized_game_dir = Self::normalize_path(game_dir);
        let normalized_query = sqlx::query_scalar::<_, String>(
            "SELECT id FROM environments WHERE normalized_output_dir = ? OR output_dir = ? LIMIT 1",
        )
        .bind(normalized_game_dir)
        .bind(game_dir)
        .fetch_optional(&*self.pool)
        .await;

        let id = match normalized_query {
            Ok(id) => id,
            Err(err)
                if err
                    .to_string()
                    .to_lowercase()
                    .contains("no such column: normalized_output_dir") =>
            {
                let rows = sqlx::query_as::<_, (String, String)>(
                    "SELECT id, output_dir FROM environments",
                )
                .fetch_all(&*self.pool)
                .await
                .context("Failed to resolve environment id")?;

                rows.into_iter()
                    .find(|(_, output_dir)| {
                        Self::normalize_path(output_dir) == Self::normalize_path(game_dir)
                    })
                    .map(|(id, _)| id)
            }
            Err(err) => return Err(err).context("Failed to resolve environment id"),
        };

        Ok(id)
    }

    fn runtime_label(runtime: &crate::types::Runtime) -> &'static str {
        match runtime {
            crate::types::Runtime::Il2cpp => RUNTIME_IL2CPP,
            crate::types::Runtime::Mono => RUNTIME_MONO,
        }
    }

    fn normalize_runtime_suffix_token(value: &str) -> String {
        let mut normalized = value.trim().to_string();
        loop {
            let mut changed = false;
            for pattern in RUNTIME_SUFFIX_PATTERNS.iter() {
                let next = pattern.replace(&normalized, "").trim().to_string();
                if next != normalized {
                    normalized = next;
                    changed = true;
                }
            }
            if !changed {
                break;
            }
        }
        normalized
    }

    fn normalize_thunderstore_source_id(source_id: &str) -> String {
        if let Some((owner, name)) = source_id.split_once('/') {
            return format!(
                "{}/{}",
                owner.trim(),
                Self::normalize_runtime_suffix_token(name)
            );
        }

        Self::normalize_runtime_suffix_token(source_id)
    }

    fn storage_metadata_path(&self, storage_path: &Path) -> PathBuf {
        storage_path.join(STORAGE_METADATA_FILE)
    }

    fn metadata_string(metadata: Option<&serde_json::Value>, key: &str) -> Option<String> {
        metadata
            .and_then(|m| m.get(key))
            .and_then(|v| v.as_str())
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
    }

    fn metadata_u64(metadata: Option<&serde_json::Value>, key: &str) -> Option<u64> {
        metadata.and_then(|m| m.get(key)).and_then(|v| v.as_u64())
    }

    fn metadata_i64(metadata: Option<&serde_json::Value>, key: &str) -> Option<i64> {
        metadata.and_then(|m| m.get(key)).and_then(|v| v.as_i64())
    }

    fn metadata_tags(metadata: Option<&serde_json::Value>) -> Option<Vec<String>> {
        let raw = metadata
            .and_then(|m| m.get("tags"))
            .and_then(|v| v.as_array())?;

        let tags: Vec<String> = raw
            .iter()
            .filter_map(|v| v.as_str().map(|s| s.trim().to_string()))
            .filter(|s| !s.is_empty())
            .collect();

        if tags.is_empty() {
            None
        } else {
            Some(tags)
        }
    }

    fn metadata_value_is_valid(value: &serde_json::Value) -> bool {
        match value {
            serde_json::Value::Null => false,
            serde_json::Value::String(text) => !text.trim().is_empty(),
            _ => true,
        }
    }

    fn metadata_field<'a>(
        metadata: &'a serde_json::Value,
        keys: &[&str],
    ) -> Option<&'a serde_json::Value> {
        keys.iter().find_map(|key| {
            metadata
                .get(*key)
                .filter(|value| Self::metadata_value_is_valid(value))
        })
    }

    fn metadata_string_value(value: &serde_json::Value) -> Option<String> {
        match value {
            serde_json::Value::String(value) => {
                let trimmed = value.trim();
                if trimmed.is_empty() {
                    None
                } else {
                    Some(trimmed.to_string())
                }
            }
            serde_json::Value::Number(value) => Some(value.to_string()),
            serde_json::Value::Bool(value) => Some(value.to_string()),
            _ => None,
        }
    }

    fn metadata_bool_value(value: &serde_json::Value) -> Option<bool> {
        match value {
            serde_json::Value::Bool(value) => Some(*value),
            serde_json::Value::Number(value) => value.as_i64().map(|v| v != 0),
            serde_json::Value::String(value) => {
                let normalized = value.trim().to_ascii_lowercase();
                match normalized.as_str() {
                    "true" | "1" | "yes" | "y" => Some(true),
                    "false" | "0" | "no" | "n" => Some(false),
                    _ => None,
                }
            }
            _ => None,
        }
    }

    fn metadata_u64_value(value: &serde_json::Value) -> Option<u64> {
        match value {
            serde_json::Value::Number(value) => value.as_u64().or_else(|| {
                value
                    .as_i64()
                    .and_then(|v| if v >= 0 { Some(v as u64) } else { None })
            }),
            serde_json::Value::String(value) => value.trim().parse::<u64>().ok(),
            _ => None,
        }
    }

    fn metadata_i64_value(value: &serde_json::Value) -> Option<i64> {
        match value {
            serde_json::Value::Number(value) => value
                .as_i64()
                .or_else(|| value.as_u64().and_then(|v| i64::try_from(v).ok())),
            serde_json::Value::String(value) => value.trim().parse::<i64>().ok(),
            _ => None,
        }
    }

    fn metadata_datetime_value(value: &serde_json::Value) -> Option<DateTime<Utc>> {
        match value {
            serde_json::Value::Number(value) => value
                .as_i64()
                .and_then(|seconds| Utc.timestamp_opt(seconds, 0).single()),
            serde_json::Value::String(value) => {
                let trimmed = value.trim();
                if trimmed.is_empty() {
                    return None;
                }

                if let Ok(seconds) = trimmed.parse::<i64>() {
                    return Utc.timestamp_opt(seconds, 0).single();
                }

                DateTime::parse_from_rfc3339(trimmed)
                    .ok()
                    .map(|parsed| parsed.with_timezone(&Utc))
            }
            _ => None,
        }
    }

    fn metadata_tags_value(value: &serde_json::Value) -> Option<Vec<String>> {
        let tags = match value {
            serde_json::Value::Array(values) => values
                .iter()
                .filter_map(Self::metadata_string_value)
                .collect::<Vec<_>>(),
            serde_json::Value::String(value) => value
                .split(',')
                .map(|item| item.trim().to_string())
                .filter(|item| !item.is_empty())
                .collect::<Vec<_>>(),
            _ => Vec::new(),
        };

        if tags.is_empty() {
            None
        } else {
            Some(tags)
        }
    }

    fn metadata_string_from_keys(metadata: &serde_json::Value, keys: &[&str]) -> Option<String> {
        Self::metadata_field(metadata, keys).and_then(Self::metadata_string_value)
    }

    fn metadata_bool_from_keys(metadata: &serde_json::Value, keys: &[&str]) -> Option<bool> {
        Self::metadata_field(metadata, keys).and_then(Self::metadata_bool_value)
    }

    fn metadata_u64_from_keys(metadata: &serde_json::Value, keys: &[&str]) -> Option<u64> {
        Self::metadata_field(metadata, keys).and_then(Self::metadata_u64_value)
    }

    fn metadata_i64_from_keys(metadata: &serde_json::Value, keys: &[&str]) -> Option<i64> {
        Self::metadata_field(metadata, keys).and_then(Self::metadata_i64_value)
    }

    fn metadata_datetime_from_keys(
        metadata: &serde_json::Value,
        keys: &[&str],
    ) -> Option<DateTime<Utc>> {
        Self::metadata_field(metadata, keys).and_then(Self::metadata_datetime_value)
    }

    fn metadata_tags_from_keys(metadata: &serde_json::Value, keys: &[&str]) -> Option<Vec<String>> {
        Self::metadata_field(metadata, keys).and_then(Self::metadata_tags_value)
    }

    fn parse_mod_source_compat(raw: &str) -> Option<ModSource> {
        let normalized = raw.trim().to_ascii_lowercase().replace(['_', '-', ' '], "");

        match normalized.as_str() {
            "local" => Some(ModSource::Local),
            "thunderstore" => Some(ModSource::Thunderstore),
            "nexusmods" | "nexus" => Some(ModSource::Nexusmods),
            "github" => Some(ModSource::Github),
            "unknown" => Some(ModSource::Unknown),
            _ => None,
        }
    }

    fn parse_runtime_compat(raw: &str) -> Option<crate::types::Runtime> {
        let normalized = raw.trim().to_ascii_lowercase().replace(['_', '-', ' '], "");

        match normalized.as_str() {
            "il2cpp" => Some(crate::types::Runtime::Il2cpp),
            "mono" => Some(crate::types::Runtime::Mono),
            _ => None,
        }
    }

    fn parse_security_scan_state_compat(raw: &str) -> Option<SecurityScanState> {
        match raw
            .trim()
            .to_ascii_lowercase()
            .replace(['_', '-', ' '], "")
            .as_str()
        {
            "verified" => Some(SecurityScanState::Verified),
            "review" => Some(SecurityScanState::Review),
            "unavailable" => Some(SecurityScanState::Unavailable),
            "disabled" => Some(SecurityScanState::Disabled),
            "skipped" => Some(SecurityScanState::Skipped),
            _ => None,
        }
    }

    fn parse_security_finding_severity_compat(raw: &str) -> Option<SecurityFindingSeverity> {
        match raw
            .trim()
            .to_ascii_lowercase()
            .replace(['_', '-', ' '], "")
            .as_str()
        {
            "low" => Some(SecurityFindingSeverity::Low),
            "medium" => Some(SecurityFindingSeverity::Medium),
            "high" => Some(SecurityFindingSeverity::High),
            "critical" => Some(SecurityFindingSeverity::Critical),
            _ => None,
        }
    }

    fn parse_security_disposition_classification_compat(
        raw: &str,
    ) -> Option<SecurityScanDispositionClassification> {
        match raw
            .trim()
            .to_ascii_lowercase()
            .replace(['_', '-', ' '], "")
            .as_str()
        {
            "clean" => Some(SecurityScanDispositionClassification::Clean),
            "suspicious" => Some(SecurityScanDispositionClassification::Suspicious),
            "knownthreat" => Some(SecurityScanDispositionClassification::KnownThreat),
            _ => None,
        }
    }

    fn parse_security_scan_disposition_compat(
        value: &serde_json::Value,
    ) -> Option<SecurityScanDisposition> {
        if let Ok(disposition) = serde_json::from_value::<SecurityScanDisposition>(value.clone()) {
            return Some(disposition);
        }

        if !value.is_object() {
            return None;
        }

        let classification = Self::metadata_string_from_keys(value, &["classification"])
            .and_then(|raw| Self::parse_security_disposition_classification_compat(&raw))?;

        Some(SecurityScanDisposition {
            classification,
            headline: Self::metadata_string_from_keys(value, &["headline"]).unwrap_or_default(),
            summary: Self::metadata_string_from_keys(value, &["summary"]).unwrap_or_default(),
            blocking_recommended: Self::metadata_bool_from_keys(
                value,
                &["blockingRecommended", "blocking_recommended"],
            )
            .unwrap_or(false),
            primary_threat_family_id: Self::metadata_string_from_keys(
                value,
                &["primaryThreatFamilyId", "primary_threat_family_id"],
            ),
            related_finding_ids: Self::metadata_tags_from_keys(
                value,
                &["relatedFindingIds", "related_finding_ids"],
            )
            .unwrap_or_default(),
        })
    }

    fn parse_security_scan_summary_compat(
        value: &serde_json::Value,
    ) -> Option<SecurityScanSummary> {
        if let Ok(summary) = serde_json::from_value::<SecurityScanSummary>(value.clone()) {
            return Some(summary);
        }

        if !value.is_object() {
            return None;
        }

        let state = Self::metadata_string_from_keys(value, &["state"])
            .and_then(|raw| Self::parse_security_scan_state_compat(&raw))?;

        Some(SecurityScanSummary {
            state: state.clone(),
            verified: Self::metadata_bool_from_keys(value, &["verified"])
                .unwrap_or(matches!(state, SecurityScanState::Verified)),
            disposition: value
                .get("disposition")
                .and_then(Self::parse_security_scan_disposition_compat),
            highest_severity: Self::metadata_string_from_keys(
                value,
                &["highestSeverity", "highest_severity"],
            )
            .and_then(|raw| Self::parse_security_finding_severity_compat(&raw)),
            total_findings: Self::metadata_u64_from_keys(
                value,
                &["totalFindings", "total_findings"],
            )
            .unwrap_or(0) as usize,
            threat_family_count: Self::metadata_u64_from_keys(
                value,
                &["threatFamilyCount", "threat_family_count"],
            )
            .unwrap_or(0) as usize,
            scanned_at: Self::metadata_datetime_from_keys(value, &["scannedAt", "scanned_at"]),
            scanner_version: Self::metadata_string_from_keys(
                value,
                &["scannerVersion", "scanner_version"],
            ),
            schema_version: Self::metadata_string_from_keys(
                value,
                &["schemaVersion", "schema_version"],
            ),
            status_message: Self::metadata_string_from_keys(
                value,
                &["statusMessage", "status_message"],
            ),
        })
    }

    fn security_scan_summary_from_metadata(
        value: &serde_json::Value,
    ) -> Option<SecurityScanSummary> {
        Self::metadata_field(value, &["securityScan", "security_scan"])
            .and_then(Self::parse_security_scan_summary_compat)
    }

    fn parse_storage_metadata_compat(value: &serde_json::Value) -> Option<ModMetadata> {
        if !value.is_object() {
            return None;
        }

        let source = Self::metadata_string_from_keys(value, &["source"])
            .and_then(|raw| Self::parse_mod_source_compat(&raw));
        let detected_runtime = Self::metadata_string_from_keys(
            value,
            &["detectedRuntime", "detected_runtime", "runtime"],
        )
        .and_then(|raw| Self::parse_runtime_compat(&raw));

        Some(ModMetadata {
            source,
            source_id: Self::metadata_string_from_keys(value, &["sourceId", "source_id"]),
            source_version: Self::metadata_string_from_keys(
                value,
                &["sourceVersion", "source_version"],
            ),
            author: Self::metadata_string_from_keys(value, &["author"]),
            mod_name: Self::metadata_string_from_keys(value, &["modName", "mod_name", "name"]),
            source_url: Self::metadata_string_from_keys(value, &["sourceUrl", "source_url"]),
            summary: Self::metadata_string_from_keys(value, &["summary", "description"]),
            icon_url: Self::metadata_string_from_keys(
                value,
                &["iconUrl", "icon_url", "pictureURL", "pictureUrl", "icon"],
            ),
            icon_cache_path: Self::metadata_string_from_keys(
                value,
                &["iconCachePath", "icon_cache_path"],
            ),
            downloads: Self::metadata_u64_from_keys(
                value,
                &["downloads", "modDownloads", "downloadCount"],
            ),
            likes_or_endorsements: Self::metadata_i64_from_keys(
                value,
                &[
                    "likesOrEndorsements",
                    "likes_or_endorsements",
                    "endorsementCount",
                    "endorsements",
                ],
            ),
            updated_at: Self::metadata_string_from_keys(
                value,
                &["updatedAt", "updated_at", "updatedTime", "dateUpdated"],
            ),
            tags: Self::metadata_tags_from_keys(value, &["tags", "categories"]),
            installed_version: Self::metadata_string_from_keys(
                value,
                &["installedVersion", "installed_version", "version"],
            ),
            library_added_at: Self::metadata_datetime_from_keys(
                value,
                &["libraryAddedAt", "library_added_at"],
            ),
            installed_at: Self::metadata_datetime_from_keys(
                value,
                &["installedAt", "installed_at"],
            ),
            last_update_check: Self::metadata_datetime_from_keys(
                value,
                &["lastUpdateCheck", "last_update_check"],
            ),
            metadata_last_refreshed: Self::metadata_datetime_from_keys(
                value,
                &["metadataLastRefreshed", "metadata_last_refreshed"],
            ),
            update_available: Self::metadata_bool_from_keys(
                value,
                &["updateAvailable", "update_available"],
            ),
            remote_version: Self::metadata_string_from_keys(
                value,
                &["remoteVersion", "remote_version"],
            ),
            detected_runtime,
            runtime_match: Self::metadata_bool_from_keys(value, &["runtimeMatch", "runtime_match"]),
            mod_storage_id: Self::metadata_string_from_keys(
                value,
                &["modStorageId", "mod_storage_id", "storageId", "storage_id"],
            ),
            symlink_paths: Self::metadata_tags_from_keys(value, &["symlinkPaths", "symlink_paths"]),
            security_scan: Self::security_scan_summary_from_metadata(value),
        })
    }

    fn mod_metadata_with_storage_id(storage_id: String) -> ModMetadata {
        ModMetadata {
            source: None,
            source_id: None,
            source_version: None,
            author: None,
            mod_name: None,
            source_url: None,
            summary: None,
            icon_url: None,
            icon_cache_path: None,
            downloads: None,
            likes_or_endorsements: None,
            updated_at: None,
            tags: None,
            installed_version: None,
            library_added_at: None,
            installed_at: None,
            last_update_check: None,
            metadata_last_refreshed: None,
            update_available: None,
            remote_version: None,
            detected_runtime: None,
            runtime_match: None,
            mod_storage_id: Some(storage_id),
            symlink_paths: None,
            security_scan: None,
        }
    }

    fn infer_storage_id_from_index(
        index: &HashMap<String, Vec<String>>,
        file_name: &str,
    ) -> Option<String> {
        let mut matches = HashSet::new();
        for variant in Self::tracked_name_variants(file_name) {
            if let Some(ids) = index.get(&variant.to_lowercase()) {
                for id in ids {
                    matches.insert(id.clone());
                }
            }
        }

        if matches.len() == 1 {
            matches.into_iter().next()
        } else {
            None
        }
    }

    async fn build_storage_file_index(&self, storage_root: &Path) -> HashMap<String, Vec<String>> {
        let mut index: HashMap<String, Vec<String>> = HashMap::new();

        let mut entries = match fs::read_dir(storage_root).await {
            Ok(entries) => entries,
            Err(_) => return index,
        };

        while let Ok(Some(entry)) = entries.next_entry().await {
            let entry_path = entry.path();
            let metadata = match entry.metadata().await {
                Ok(metadata) => metadata,
                Err(_) => continue,
            };

            if !metadata.is_dir() {
                continue;
            }

            let storage_id = entry_path
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or("")
                .trim()
                .to_string();
            if storage_id.is_empty() {
                continue;
            }

            let files = match self.collect_storage_files(&entry_path).await {
                Ok(files) => files,
                Err(_) => continue,
            };

            for file_name in files {
                index
                    .entry(file_name.to_lowercase())
                    .or_default()
                    .push(storage_id.clone());
            }
        }

        index
    }

    async fn build_storage_file_index_if_needed(
        &self,
        storage_root: &Path,
        index: &mut Option<HashMap<String, Vec<String>>>,
    ) {
        if index.is_none() {
            *index = Some(self.build_storage_file_index(storage_root).await);
        }
    }

    async fn infer_storage_id_from_symlink(
        &self,
        mod_file_path: &Path,
        storage_root: &Path,
    ) -> Option<String> {
        let metadata = fs::symlink_metadata(mod_file_path).await.ok()?;
        if !metadata.file_type().is_symlink() {
            return None;
        }

        let link_target = fs::read_link(mod_file_path).await.ok()?;
        let resolved_target = if link_target.is_absolute() {
            link_target
        } else {
            mod_file_path.parent()?.join(link_target)
        };

        let canonical_target = match fs::canonicalize(&resolved_target).await {
            Ok(path) => path,
            Err(_) => resolved_target,
        };

        let canonical_storage_root = match fs::canonicalize(storage_root).await {
            Ok(path) => path,
            Err(_) => storage_root.to_path_buf(),
        };

        let relative = canonical_target
            .strip_prefix(&canonical_storage_root)
            .ok()?;
        match relative.components().next() {
            Some(Component::Normal(value)) => {
                let storage_id = value.to_string_lossy().trim().to_string();
                if storage_id.is_empty() {
                    None
                } else {
                    Some(storage_id)
                }
            }
            _ => None,
        }
    }

    async fn recover_mod_metadata_from_storage(
        &self,
        mods_directory: &Path,
        metadata: &mut HashMap<String, ModMetadata>,
    ) -> Result<bool> {
        let storage_root = self.get_mods_storage_dir().await?;
        let mut storage_file_index: Option<HashMap<String, Vec<String>>> = None;

        let mut entries = match fs::read_dir(mods_directory).await {
            Ok(entries) => entries,
            Err(_) => return Ok(false),
        };

        let mut changed = false;

        while let Some(entry) = entries.next_entry().await? {
            let path = entry.path();
            if !path.is_file() {
                continue;
            }

            let file_name = path
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or("")
                .to_string();
            if file_name.is_empty() {
                continue;
            }

            let lower_name = file_name.to_lowercase();
            if !lower_name.ends_with(".dll") && !lower_name.ends_with(".dll.disabled") {
                continue;
            }

            let canonical_name = if lower_name.ends_with(".dll.disabled") {
                file_name.trim_end_matches(".disabled").to_string()
            } else {
                file_name.clone()
            };

            let existing = metadata
                .get(&canonical_name)
                .cloned()
                .or_else(|| metadata.get(&file_name).cloned());

            let mut effective = existing.clone();
            let mut storage_id = effective
                .as_ref()
                .and_then(|meta| meta.mod_storage_id.clone());

            if storage_id.is_none() {
                storage_id = self
                    .infer_storage_id_from_symlink(&path, &storage_root)
                    .await;

                if storage_id.is_none() {
                    self.build_storage_file_index_if_needed(&storage_root, &mut storage_file_index)
                        .await;

                    if let Some(index) = storage_file_index.as_ref() {
                        storage_id = Self::infer_storage_id_from_index(index, &canonical_name);
                    }
                }
            }

            let Some(storage_id) = storage_id else {
                continue;
            };

            let mut should_mark_changed = existing.is_none();
            let mut metadata_value = effective
                .take()
                .unwrap_or_else(|| Self::mod_metadata_with_storage_id(storage_id.clone()));

            if metadata_value.mod_storage_id.is_none() {
                metadata_value.mod_storage_id = Some(storage_id.clone());
                should_mark_changed = true;
            }

            if let Ok(Some(storage_meta)) = self
                .load_storage_metadata(&storage_root.join(&storage_id))
                .await
            {
                if metadata_value.source.is_none()
                    || metadata_value.source_id.is_none()
                    || metadata_value.source_version.is_none()
                    || metadata_value.mod_name.is_none()
                    || metadata_value.source_url.is_none()
                    || metadata_value.summary.is_none()
                    || metadata_value.icon_url.is_none()
                    || metadata_value.icon_cache_path.is_none()
                    || metadata_value.downloads.is_none()
                    || metadata_value.likes_or_endorsements.is_none()
                    || metadata_value.updated_at.is_none()
                    || metadata_value.tags.is_none()
                    || metadata_value.detected_runtime.is_none()
                    || metadata_value.runtime_match.is_none()
                {
                    should_mark_changed = true;
                }

                metadata_value = Self::merge_metadata(metadata_value, storage_meta);
            }

            if should_mark_changed {
                metadata.insert(canonical_name, metadata_value);
                changed = true;
            }
        }

        Ok(changed)
    }

    async fn get_mod_icon_cache_dir(&self) -> Result<PathBuf> {
        let cache_dir = crate::db::get_data_dir()?.join("cache").join("mod-icons");
        fs::create_dir_all(&cache_dir)
            .await
            .context("Failed to create mod icon cache directory")?;
        Ok(cache_dir)
    }

    async fn enforce_mod_icon_cache_limit(&self) -> Result<()> {
        let cache_dir = self.get_mod_icon_cache_dir().await?;
        let mut settings_service = SettingsService::new(self.pool.clone())
            .context("Failed to create settings service for icon cache limit")?;
        let settings = settings_service
            .load_settings()
            .await
            .context("Failed to load settings for icon cache limit")?;

        let max_mb = settings.mod_icon_cache_limit_mb.unwrap_or(500) as u64;
        let max_bytes = max_mb.saturating_mul(1024).saturating_mul(1024);

        let mut files: Vec<(PathBuf, u64, std::time::SystemTime)> = Vec::new();
        let mut total_size = 0u64;
        let mut entries = fs::read_dir(&cache_dir)
            .await
            .context("Failed to read mod icon cache directory")?;

        while let Some(entry) = entries.next_entry().await? {
            let path = entry.path();
            let meta = entry.metadata().await?;
            if !meta.is_file() {
                continue;
            }
            let size = meta.len();
            let modified = meta.modified().unwrap_or(std::time::SystemTime::UNIX_EPOCH);
            total_size = total_size.saturating_add(size);
            files.push((path, size, modified));
        }

        if total_size <= max_bytes {
            return Ok(());
        }

        files.sort_by_key(|(_, _, modified)| *modified);
        for (path, size, _) in files {
            if total_size <= max_bytes {
                break;
            }
            if fs::remove_file(&path).await.is_ok() {
                total_size = total_size.saturating_sub(size);
            }
        }

        Ok(())
    }

    async fn cache_icon_from_url(&self, icon_url: Option<&str>) -> Option<String> {
        let icon_url = icon_url?.trim();
        if icon_url.is_empty() {
            return None;
        }

        let parsed = reqwest::Url::parse(icon_url).ok()?;
        if parsed.scheme() != "https" {
            return None;
        }

        let mut hasher = Sha256::new();
        hasher.update(icon_url.as_bytes());
        let hash = hex::encode(hasher.finalize());

        let ext = parsed
            .path_segments()
            .and_then(|mut segments| segments.next_back())
            .and_then(|segment| {
                segment
                    .rsplit_once('.')
                    .map(|(_, e)| e.to_ascii_lowercase())
            })
            .filter(|e| ["png", "jpg", "jpeg", "webp", "gif"].contains(&e.as_str()))
            .unwrap_or_else(|| "img".to_string());

        let cache_dir = self.get_mod_icon_cache_dir().await.ok()?;
        let file_path = cache_dir.join(format!("{}.{}", hash, ext));
        if file_path.exists() {
            return Some(file_path.to_string_lossy().to_string());
        }

        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(ICON_FETCH_TIMEOUT_SECONDS))
            .build()
            .ok()?;

        let mut response = client.get(parsed).send().await.ok()?;
        if !response.status().is_success() {
            return None;
        }

        if let Some(content_length) = response
            .headers()
            .get(CONTENT_LENGTH)
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.parse::<u64>().ok())
        {
            if content_length == 0 || content_length > MAX_ICON_BYTES as u64 {
                return None;
            }
        }

        let mut bytes = Vec::new();
        loop {
            match response.chunk().await {
                Ok(Some(chunk)) => {
                    bytes.extend_from_slice(&chunk);
                    if bytes.len() > MAX_ICON_BYTES {
                        return None;
                    }
                }
                Ok(None) => break,
                Err(_) => return None,
            }
        }

        if bytes.is_empty() {
            return None;
        }

        if fs::write(&file_path, &bytes).await.is_err() {
            return None;
        }

        let _ = self.enforce_mod_icon_cache_limit().await;
        Some(file_path.to_string_lossy().to_string())
    }

    pub async fn cache_icon_for_metadata(&self, icon_url: Option<&str>) -> Option<String> {
        self.cache_icon_from_url(icon_url).await
    }

    async fn normalize_icon_reference_for_compare(
        &self,
        icon_ref: &str,
        cache_dir: &Path,
    ) -> String {
        let trimmed = icon_ref.trim();
        if trimmed.is_empty() {
            return String::new();
        }

        let raw_path = Path::new(trimmed);
        let candidate = if raw_path.is_absolute() {
            raw_path.to_path_buf()
        } else {
            cache_dir.join(raw_path)
        };

        let normalized = match fs::canonicalize(&candidate).await {
            Ok(path) => path,
            Err(_) => candidate,
        };

        normalized
            .to_string_lossy()
            .replace('\\', "/")
            .to_ascii_lowercase()
    }

    async fn remove_icon_cache_if_orphaned(
        &self,
        icon_cache_path: Option<&str>,
        excluding_storage_id: &str,
    ) -> Result<()> {
        let Some(icon_path) = icon_cache_path.map(|s| s.trim()).filter(|s| !s.is_empty()) else {
            return Ok(());
        };

        let cache_dir = self.get_mod_icon_cache_dir().await?;
        let normalized_icon_path = self
            .normalize_icon_reference_for_compare(icon_path, &cache_dir)
            .await;

        let rows = sqlx::query_as::<_, (String, String)>(
            "SELECT environment_id, data FROM mod_metadata WHERE kind = 'mods'",
        )
        .fetch_all(&*self.pool)
        .await
        .context("Failed to load mod metadata for icon cache pruning")?;

        for (_, data) in rows {
            let Ok(meta) = serde_json::from_str::<ModMetadata>(&data) else {
                continue;
            };

            if meta.mod_storage_id.as_deref() == Some(excluding_storage_id) {
                continue;
            }

            let Some(candidate) = meta.icon_cache_path.as_deref() else {
                continue;
            };

            let normalized_candidate = self
                .normalize_icon_reference_for_compare(candidate, &cache_dir)
                .await;
            if normalized_candidate == normalized_icon_path {
                return Ok(());
            }
        }

        let storage_root = self.get_mods_storage_dir().await?;
        if let Ok(mut entries) = fs::read_dir(&storage_root).await {
            while let Ok(Some(entry)) = entries.next_entry().await {
                let candidate_storage_id = entry.file_name().to_string_lossy().to_string();
                if candidate_storage_id == excluding_storage_id {
                    continue;
                }

                if let Ok(Some(meta)) = self.load_storage_metadata(&entry.path()).await {
                    let Some(candidate) = meta.icon_cache_path.as_deref() else {
                        continue;
                    };

                    let normalized_candidate = self
                        .normalize_icon_reference_for_compare(candidate, &cache_dir)
                        .await;
                    if normalized_candidate == normalized_icon_path {
                        return Ok(());
                    }
                }
            }
        }

        let cache_dir_canonical = match fs::canonicalize(&cache_dir).await {
            Ok(path) => path,
            Err(error) => {
                log::warn!(
                    "Failed to canonicalize icon cache directory {} while pruning orphan {}: {}",
                    cache_dir.display(),
                    icon_path,
                    error
                );
                return Ok(());
            }
        };

        let raw_candidate = Path::new(icon_path);
        let candidate_path = if raw_candidate.is_absolute() {
            raw_candidate.to_path_buf()
        } else {
            cache_dir.join(raw_candidate)
        };

        if !candidate_path.exists() {
            return Ok(());
        }

        let canonical_candidate = match fs::canonicalize(&candidate_path).await {
            Ok(path) => path,
            Err(error) => {
                log::warn!(
                    "Failed to canonicalize orphan icon candidate {}: {}",
                    candidate_path.display(),
                    error
                );
                return Ok(());
            }
        };

        if !canonical_candidate.starts_with(&cache_dir_canonical) {
            log::warn!(
                "Skipping orphan icon cleanup outside cache directory: {}",
                canonical_candidate.display()
            );
            return Ok(());
        }

        if let Err(error) = fs::remove_file(&canonical_candidate).await {
            log::warn!(
                "Failed to remove orphan icon cache file {}: {}",
                canonical_candidate.display(),
                error
            );
        }

        Ok(())
    }

    async fn load_storage_metadata(&self, storage_path: &Path) -> Result<Option<ModMetadata>> {
        let metadata_file = self.storage_metadata_path(storage_path);
        if !metadata_file.exists() {
            return Ok(None);
        }

        let content = fs::read_to_string(&metadata_file)
            .await
            .context("Failed to read storage metadata file")?;
        match serde_json::from_str::<ModMetadata>(&content) {
            Ok(mut metadata) => {
                if let Some(summary) = self.load_security_scan_report_summary(storage_path).await? {
                    metadata.security_scan = Some(summary);
                }

                Ok(Some(metadata))
            }
            Err(parse_error) => {
                let migrated = serde_json::from_str::<serde_json::Value>(&content)
                    .ok()
                    .and_then(|value| Self::parse_storage_metadata_compat(&value));

                if let Some(mut metadata) = migrated {
                    if let Some(summary) =
                        self.load_security_scan_report_summary(storage_path).await?
                    {
                        metadata.security_scan = Some(summary);
                    }

                    if let Err(save_error) =
                        self.save_storage_metadata(storage_path, &metadata).await
                    {
                        log::warn!(
                            "Failed to persist migrated storage metadata for {}: {}",
                            metadata_file.display(),
                            save_error
                        );
                    }

                    return Ok(Some(metadata));
                }

                log::warn!(
                    "Skipping unreadable storage metadata file {}: {}",
                    metadata_file.display(),
                    parse_error
                );
                Ok(None)
            }
        }
    }

    async fn save_storage_metadata(
        &self,
        storage_path: &Path,
        metadata: &ModMetadata,
    ) -> Result<()> {
        let metadata_file = self.storage_metadata_path(storage_path);
        let serialized =
            serde_json::to_string(metadata).context("Failed to serialize storage metadata")?;
        fs::write(&metadata_file, serialized)
            .await
            .context("Failed to write storage metadata file")?;
        Ok(())
    }

    fn storage_security_scan_path(&self, storage_path: &Path) -> PathBuf {
        storage_path.join(STORAGE_SECURITY_SCAN_FILE)
    }

    fn validated_storage_path(storage_root: &Path, storage_id: &str) -> Result<PathBuf> {
        let mut components = Path::new(storage_id).components();
        match (components.next(), components.next()) {
            (Some(Component::Normal(_)), None) => Ok(storage_root.join(storage_id)),
            _ => Err(anyhow::anyhow!("Invalid storage id: {}", storage_id)),
        }
    }

    async fn load_security_scan_report_summary(
        &self,
        storage_path: &Path,
    ) -> Result<Option<SecurityScanSummary>> {
        let report_path = self.storage_security_scan_path(storage_path);
        if !report_path.exists() {
            return Ok(None);
        }

        let content = match fs::read_to_string(&report_path).await {
            Ok(content) => content,
            Err(error) => {
                log::warn!(
                    "Skipping unreadable security scan report {}: {}",
                    report_path.display(),
                    error
                );
                return Ok(None);
            }
        };

        if let Ok(report) = serde_json::from_str::<SecurityScanReport>(&content) {
            return Ok(Some(report.summary));
        }

        let summary = serde_json::from_str::<serde_json::Value>(&content)
            .ok()
            .and_then(|value| {
                value
                    .get("summary")
                    .and_then(Self::parse_security_scan_summary_compat)
            });

        Ok(summary)
    }

    fn build_summary_only_security_scan_report(summary: SecurityScanSummary) -> SecurityScanReport {
        let status_message = summary.status_message.clone();
        let disposition = summary
            .disposition
            .as_ref()
            .map(|value| value.classification);
        let enabled = !matches!(summary.state, SecurityScanState::Disabled);
        let blocked = matches!(
            disposition,
            Some(SecurityScanDispositionClassification::KnownThreat)
        );
        let requires_confirmation = matches!(summary.state, SecurityScanState::Review)
            || matches!(
                disposition,
                Some(SecurityScanDispositionClassification::Suspicious)
            );

        SecurityScanReport {
            summary,
            policy: SecurityScanPolicy {
                enabled,
                requires_confirmation,
                blocked,
                prompt_on_high_findings: false,
                block_critical_findings: false,
                status_message,
            },
            files: Vec::new(),
        }
    }

    async fn resolve_storage_security_scan_summary(
        &self,
        storage_id: &str,
        fallback: Option<SecurityScanSummary>,
    ) -> Result<Option<SecurityScanSummary>> {
        let storage_root = self.get_mods_storage_dir().await?;
        let storage_path = match Self::validated_storage_path(&storage_root, storage_id) {
            Ok(path) => path,
            Err(error) => {
                log::warn!(
                    "Skipping security scan lookup for invalid storage id {}: {}",
                    storage_id,
                    error
                );
                return Ok(fallback);
            }
        };

        if let Some(summary) = self
            .load_security_scan_report_summary(&storage_path)
            .await?
        {
            return Ok(Some(summary));
        }

        if let Some(metadata) = self.load_storage_metadata(&storage_path).await? {
            if metadata.security_scan.is_some() {
                return Ok(metadata.security_scan);
            }
        }

        Ok(fallback)
    }

    pub async fn save_security_scan_report(
        &self,
        storage_id: &str,
        report: &SecurityScanReport,
    ) -> Result<()> {
        let storage_root = self.get_mods_storage_dir().await?;
        let storage_path = Self::validated_storage_path(&storage_root, storage_id)?;
        fs::create_dir_all(&storage_path)
            .await
            .context("Failed to create storage directory for security scan report")?;

        let report_path = self.storage_security_scan_path(&storage_path);
        let serialized =
            serde_json::to_string(report).context("Failed to serialize security scan report")?;
        fs::write(&report_path, serialized)
            .await
            .context("Failed to write security scan report")?;
        Ok(())
    }

    pub async fn get_security_scan_report(
        &self,
        storage_id: &str,
    ) -> Result<Option<SecurityScanReport>> {
        let storage_root = self.get_mods_storage_dir().await?;
        let storage_path = Self::validated_storage_path(&storage_root, storage_id)?;
        let report_path = self.storage_security_scan_path(&storage_path);
        if report_path.exists() {
            let content = fs::read_to_string(&report_path)
                .await
                .context("Failed to read security scan report")?;
            let report = serde_json::from_str::<SecurityScanReport>(&content)
                .context("Failed to parse security scan report")?;
            return Ok(Some(report));
        }

        let fallback_summary = self
            .load_storage_metadata(&storage_path)
            .await?
            .and_then(|metadata| metadata.security_scan);

        Ok(fallback_summary.map(Self::build_summary_only_security_scan_report))
    }

    pub async fn upsert_storage_metadata_by_id(
        &self,
        storage_id: &str,
        incoming: ModMetadata,
    ) -> Result<()> {
        let storage_root = self.get_mods_storage_dir().await?;
        let storage_path = Self::validated_storage_path(&storage_root, storage_id)?;

        let existing = self.load_storage_metadata(&storage_path).await?;
        let mut next = if let Some(existing) = existing {
            Self::merge_metadata(incoming, existing)
        } else {
            incoming
        };

        next.mod_storage_id = Some(storage_id.to_string());
        fs::create_dir_all(&storage_path).await?;

        self.save_storage_metadata(&storage_path, &next).await
    }

    fn merge_metadata(mut primary: ModMetadata, fallback: ModMetadata) -> ModMetadata {
        if primary.source.is_none() {
            primary.source = fallback.source;
        }
        if primary.source_id.is_none() {
            primary.source_id = fallback.source_id;
        }
        if primary.source_version.is_none() {
            primary.source_version = fallback.source_version;
        }
        if primary.author.is_none() {
            primary.author = fallback.author;
        }
        if primary.mod_name.is_none() {
            primary.mod_name = fallback.mod_name;
        }
        if primary.source_url.is_none() {
            primary.source_url = fallback.source_url;
        }
        if primary.summary.is_none() {
            primary.summary = fallback.summary;
        }
        if primary.icon_url.is_none() {
            primary.icon_url = fallback.icon_url;
        }
        if primary.icon_cache_path.is_none() {
            primary.icon_cache_path = fallback.icon_cache_path;
        }
        if primary.downloads.is_none() {
            primary.downloads = fallback.downloads;
        }
        if primary.likes_or_endorsements.is_none() {
            primary.likes_or_endorsements = fallback.likes_or_endorsements;
        }
        if primary.updated_at.is_none() {
            primary.updated_at = fallback.updated_at;
        }
        if primary.tags.is_none() {
            primary.tags = fallback.tags;
        }
        if primary.installed_version.is_none() {
            primary.installed_version = fallback.installed_version;
        }
        if primary.library_added_at.is_none() {
            primary.library_added_at = fallback.library_added_at;
        }
        if primary.installed_at.is_none() {
            primary.installed_at = fallback.installed_at;
        }
        if primary.last_update_check.is_none() {
            primary.last_update_check = fallback.last_update_check;
        }
        if primary.metadata_last_refreshed.is_none() {
            primary.metadata_last_refreshed = fallback.metadata_last_refreshed;
        }
        if primary.update_available.is_none() {
            primary.update_available = fallback.update_available;
        }
        if primary.remote_version.is_none() {
            primary.remote_version = fallback.remote_version;
        }
        if primary.detected_runtime.is_none() {
            primary.detected_runtime = fallback.detected_runtime;
        }
        if primary.runtime_match.is_none() {
            primary.runtime_match = fallback.runtime_match;
        }
        if primary.mod_storage_id.is_none() {
            primary.mod_storage_id = fallback.mod_storage_id;
        }
        if primary.symlink_paths.is_none() {
            primary.symlink_paths = fallback.symlink_paths;
        }
        if primary.security_scan.is_none() {
            primary.security_scan = fallback.security_scan;
        }
        primary
    }

    fn security_scan_summary_priority(summary: &SecurityScanSummary) -> u8 {
        match summary
            .disposition
            .as_ref()
            .map(|value| value.classification)
        {
            Some(SecurityScanDispositionClassification::KnownThreat) => 7,
            Some(SecurityScanDispositionClassification::Suspicious) => 6,
            Some(SecurityScanDispositionClassification::Clean) => 2,
            None => match summary.state {
                SecurityScanState::Review => 5,
                SecurityScanState::Unavailable => 4,
                SecurityScanState::Verified => 3,
                SecurityScanState::Skipped => 1,
                SecurityScanState::Disabled => 0,
            },
        }
    }

    fn security_finding_severity_priority(severity: &SecurityFindingSeverity) -> u8 {
        match severity {
            SecurityFindingSeverity::Critical => 4,
            SecurityFindingSeverity::High => 3,
            SecurityFindingSeverity::Medium => 2,
            SecurityFindingSeverity::Low => 1,
        }
    }

    fn aggregate_security_scan_summary(
        current: Option<SecurityScanSummary>,
        next: Option<SecurityScanSummary>,
    ) -> Option<SecurityScanSummary> {
        match (current, next) {
            (None, None) => None,
            (Some(summary), None) | (None, Some(summary)) => Some(summary),
            (Some(current), Some(next)) => {
                let (primary, secondary) = if Self::security_scan_summary_priority(&next)
                    > Self::security_scan_summary_priority(&current)
                {
                    (next, current)
                } else {
                    (current, next)
                };

                let highest_severity = match (
                    primary.highest_severity.clone(),
                    secondary.highest_severity.clone(),
                ) {
                    (Some(left), Some(right)) => {
                        if Self::security_finding_severity_priority(&right)
                            > Self::security_finding_severity_priority(&left)
                        {
                            Some(right)
                        } else {
                            Some(left)
                        }
                    }
                    (Some(value), None) | (None, Some(value)) => Some(value),
                    (None, None) => None,
                };

                Some(SecurityScanSummary {
                    state: primary.state.clone(),
                    verified: primary.verified && secondary.verified,
                    disposition: primary.disposition.clone(),
                    highest_severity,
                    total_findings: primary.total_findings.max(secondary.total_findings),
                    threat_family_count: primary
                        .threat_family_count
                        .max(secondary.threat_family_count),
                    scanned_at: primary.scanned_at.or(secondary.scanned_at),
                    scanner_version: primary
                        .scanner_version
                        .clone()
                        .or(secondary.scanner_version.clone()),
                    schema_version: primary
                        .schema_version
                        .clone()
                        .or(secondary.schema_version.clone()),
                    status_message: primary
                        .status_message
                        .clone()
                        .or(secondary.status_message.clone()),
                })
            }
        }
    }

    async fn collect_storage_files(&self, storage_path: &Path) -> Result<Vec<String>> {
        let mut files = Vec::new();

        let mods_dir = storage_path.join("Mods");
        if mods_dir.exists() {
            let mut entries = fs::read_dir(&mods_dir)
                .await
                .context("Failed to read storage mods directory")?;
            while let Some(entry) = entries.next_entry().await? {
                let path = entry.path();
                if !path.is_file() {
                    continue;
                }
                let file_name = path.file_name().and_then(|v| v.to_str()).unwrap_or("");
                let lower_name = file_name.to_lowercase();
                if lower_name.ends_with(".dll") || lower_name.ends_with(".dll.disabled") {
                    files.push(file_name.to_string());
                }
            }
        }

        let plugins_dir = storage_path.join("Plugins");
        if plugins_dir.exists() {
            let mut entries = fs::read_dir(&plugins_dir)
                .await
                .context("Failed to read storage plugins directory")?;
            while let Some(entry) = entries.next_entry().await? {
                let path = entry.path();
                if !path.is_file() {
                    continue;
                }
                let file_name = path.file_name().and_then(|v| v.to_str()).unwrap_or("");
                let lower_name = file_name.to_lowercase();
                if lower_name.ends_with(".dll") || lower_name.ends_with(".dll.disabled") {
                    files.push(file_name.to_string());
                }
            }
        }

        let userlibs_dir = storage_path.join("UserLibs");
        if userlibs_dir.exists() {
            let mut entries = fs::read_dir(&userlibs_dir)
                .await
                .context("Failed to read storage userlibs directory")?;
            while let Some(entry) = entries.next_entry().await? {
                let path = entry.path();
                let file_name = path.file_name().and_then(|v| v.to_str()).unwrap_or("");
                if !file_name.is_empty() {
                    files.push(file_name.to_string());
                }
            }
        }

        Ok(files)
    }

    fn detect_available_runtimes(
        &self,
        files: &[String],
        metadata_runtime: Option<crate::types::Runtime>,
    ) -> Vec<String> {
        if let Some(runtime) = metadata_runtime {
            return vec![Self::runtime_label(&runtime).to_string()];
        }

        let mut has_il2cpp = false;
        let mut has_mono = false;
        for file in files {
            match self.detect_mod_runtime_from_name(file) {
                RUNTIME_IL2CPP => has_il2cpp = true,
                RUNTIME_MONO => has_mono = true,
                _ => {}
            }
        }

        if has_il2cpp && has_mono {
            return vec![RUNTIME_IL2CPP.to_string(), RUNTIME_MONO.to_string()];
        }
        if has_il2cpp {
            return vec![RUNTIME_IL2CPP.to_string()];
        }
        if has_mono {
            return vec![RUNTIME_MONO.to_string()];
        }

        vec![RUNTIME_IL2CPP.to_string(), RUNTIME_MONO.to_string()]
    }

    fn build_files_by_runtime(
        &self,
        files: &[String],
        available_runtimes: &[String],
    ) -> HashMap<String, Vec<String>> {
        let mut map: HashMap<String, Vec<String>> = HashMap::new();
        for runtime in available_runtimes {
            map.insert(runtime.clone(), Vec::new());
        }

        for file in files {
            let file_runtime = self.detect_mod_runtime_from_name(file);
            if file_runtime == RUNTIME_IL2CPP {
                if let Some(list) = map.get_mut(RUNTIME_IL2CPP) {
                    list.push(file.clone());
                }
                continue;
            }
            if file_runtime == RUNTIME_MONO {
                if let Some(list) = map.get_mut(RUNTIME_MONO) {
                    list.push(file.clone());
                }
                continue;
            }

            for runtime in available_runtimes {
                if let Some(list) = map.get_mut(runtime) {
                    list.push(file.clone());
                }
            }
        }

        map
    }

    fn is_s1api_component_file(&self, file_name: &str) -> bool {
        let lower_name = file_name.to_lowercase();
        lower_name == "s1api.mono.melonloader.dll"
            || lower_name == "s1api.il2cpp.melonloader.dll"
            || (lower_name.starts_with("s1api")
                && lower_name.ends_with(".dll")
                && lower_name.contains('.'))
    }

    /// Generate a unique mod ID for mod storage
    fn generate_mod_id(&self) -> String {
        Uuid::new_v4().to_string()
    }

    /// Find existing mod installation by source_id and source_version
    /// Returns the mod_storage_id if found, None otherwise
    pub async fn find_existing_mod_installation(
        &self,
        game_dir: &str,
        source_id: &Option<String>,
        source_version: &Option<String>,
    ) -> Result<Option<String>> {
        if source_id.is_none() || source_version.is_none() {
            // Can't match without source_id and source_version
            return Ok(None);
        }

        self.reconcile_tracked_mod_state().await?;

        let mods_directory = self.get_mods_directory(game_dir);
        let mod_metadata = self.load_mod_metadata(&mods_directory).await?;

        // Search through metadata to find a matching mod
        for (_, meta) in mod_metadata.iter() {
            if let (
                Some(existing_source_id),
                Some(existing_source_version),
                Some(existing_storage_id),
            ) = (&meta.source_id, &meta.source_version, &meta.mod_storage_id)
            {
                if existing_source_id == source_id.as_ref().unwrap()
                    && existing_source_version == source_version.as_ref().unwrap()
                {
                    eprintln!(
                        "[DEBUG] Found existing installation of {} version {} with storage_id: {}",
                        existing_source_id, existing_source_version, existing_storage_id
                    );
                    return Ok(Some(existing_storage_id.clone()));
                }
            }
        }

        Ok(None)
    }

    /// Find existing mod storage by source_id and source_version across all environments
    pub async fn find_existing_mod_storage_by_source_version(
        &self,
        source_id: &str,
        source_version: &str,
        runtime: Option<crate::types::Runtime>,
    ) -> Result<Option<String>> {
        let rows = sqlx::query_as::<_, (String, String)>(
            "SELECT environment_id, data FROM mod_metadata WHERE kind = 'mods'",
        )
        .fetch_all(&*self.pool)
        .await
        .context("Failed to load mod metadata for storage lookup")?;

        let mut storage_meta: HashMap<String, ModMetadata> = HashMap::new();
        for (_, data) in rows {
            if let Ok(meta) = serde_json::from_str::<ModMetadata>(&data) {
                if let Some(storage_id) = meta.mod_storage_id.clone() {
                    storage_meta.entry(storage_id).or_insert(meta);
                }
            }
        }

        let storage_dir = self.get_mods_storage_dir().await?;
        if !storage_dir.exists() {
            return Ok(None);
        }

        let mut entries = fs::read_dir(&storage_dir)
            .await
            .context("Failed to read mod storage directory")?;

        while let Some(entry) = entries.next_entry().await? {
            let entry_path = entry.path();
            let metadata = entry.metadata().await?;
            if !metadata.is_dir() {
                continue;
            }

            let storage_id = entry_path
                .file_name()
                .and_then(|v| v.to_str())
                .unwrap_or("")
                .to_string();
            if storage_id.is_empty() {
                continue;
            }

            let mut template_meta = storage_meta
                .get(&storage_id)
                .cloned()
                .unwrap_or(ModMetadata {
                    source: None,
                    source_id: None,
                    source_version: None,
                    author: None,
                    mod_name: None,
                    source_url: None,
                    summary: None,
                    icon_url: None,
                    icon_cache_path: None,
                    downloads: None,
                    likes_or_endorsements: None,
                    updated_at: None,
                    tags: None,
                    installed_version: None,
                    library_added_at: None,
                    installed_at: None,
                    last_update_check: None,
                    metadata_last_refreshed: None,
                    update_available: None,
                    remote_version: None,
                    detected_runtime: None,
                    runtime_match: None,
                    mod_storage_id: None,
                    symlink_paths: None,
                    security_scan: None,
                });

            if let Some(storage_meta_file) = self.load_storage_metadata(&entry_path).await? {
                template_meta = Self::merge_metadata(storage_meta_file, template_meta);
            }

            if template_meta.source_id.as_deref() != Some(source_id)
                || template_meta.source_version.as_deref() != Some(source_version)
            {
                continue;
            }

            let files = self.collect_storage_files(&entry_path).await?;
            let available_runtimes =
                self.detect_available_runtimes(&files, template_meta.detected_runtime.clone());

            let supports_runtime = match runtime {
                Some(ref rt) => {
                    let label = Self::runtime_label(rt);
                    available_runtimes.iter().any(|r| r == label)
                }
                None => {
                    available_runtimes.iter().any(|r| r == RUNTIME_IL2CPP)
                        && available_runtimes.iter().any(|r| r == RUNTIME_MONO)
                }
            };

            if supports_runtime {
                return Ok(Some(storage_id));
            }
        }

        Ok(None)
    }

    async fn find_metadata_template_for_storage_id(
        &self,
        storage_id: &str,
    ) -> Result<Option<ModMetadata>> {
        let rows = sqlx::query_as::<_, (String, String)>(
            "SELECT environment_id, data FROM mod_metadata WHERE kind = 'mods'",
        )
        .fetch_all(&*self.pool)
        .await
        .context("Failed to load mod metadata for template lookup")?;

        for (_, data) in rows {
            if let Ok(meta) = serde_json::from_str::<ModMetadata>(&data) {
                if meta.mod_storage_id.as_deref() == Some(storage_id) {
                    return Ok(Some(meta));
                }
            }
        }

        let storage_dir = self.get_mods_storage_dir().await?;
        let storage_path = Self::validated_storage_path(&storage_dir, storage_id)?;
        if storage_path.exists() {
            if let Some(meta) = self.load_storage_metadata(&storage_path).await? {
                return Ok(Some(meta));
            }
        }

        Ok(None)
    }

    /// Get the mods storage directory from settings
    async fn get_mods_storage_dir(&self) -> Result<PathBuf> {
        let mut settings_service =
            SettingsService::new(self.pool.clone()).context("Failed to create settings service")?;
        let settings = settings_service
            .load_settings()
            .await
            .context("Failed to load settings")?;

        let storage_dir = PathBuf::from(settings.default_download_dir).join("Mods");
        fs::create_dir_all(&storage_dir)
            .await
            .context("Failed to create mods storage directory")?;
        Ok(storage_dir)
    }

    /// Creates a symbolic link for a file.
    pub async fn create_symlink_file(&self, src: &Path, dst: &Path) -> Result<()> {
        let src_owned = src.to_owned();
        let dst_owned = dst.to_owned();
        tokio::task::spawn_blocking(move || {
            #[cfg(target_os = "windows")]
            {
                std::os::windows::fs::symlink_file(&src_owned, &dst_owned).map_err(|e| {
                    eprintln!("[create_symlink_file] Failed to create file symlink from {:?} to {:?}: {:?}", 
                             src_owned, dst_owned, e);
                    anyhow::anyhow!("Failed to create file symlink from {:?} to {:?}: {}", 
                                   src_owned, dst_owned, e)
                })?;
            }
            #[cfg(target_family = "unix")]
            {
                std::os::unix::fs::symlink(&src_owned, &dst_owned).map_err(|e| {
                    eprintln!("[create_symlink_file] Failed to create file symlink from {:?} to {:?}: {:?}", 
                             src_owned, dst_owned, e);
                    anyhow::anyhow!("Failed to create file symlink from {:?} to {:?}: {}", 
                                   src_owned, dst_owned, e)
                })?;
            }
            eprintln!("[create_symlink_file] Successfully created symlink from {:?} to {:?}", src_owned, dst_owned);
            Ok(())
        })
        .await?
    }

    /// Creates a symbolic link for a directory.
    pub async fn create_symlink_dir(&self, src: &Path, dst: &Path) -> Result<()> {
        let src_owned = src.to_owned();
        let dst_owned = dst.to_owned();
        tokio::task::spawn_blocking(move || {
            #[cfg(target_os = "windows")]
            {
                std::os::windows::fs::symlink_dir(&src_owned, &dst_owned).context(format!(
                    "Failed to create directory symlink from {:?} to {:?}",
                    src_owned, dst_owned
                ))?;
            }
            #[cfg(target_family = "unix")]
            {
                std::os::unix::fs::symlink(&src_owned, &dst_owned).context(format!(
                    "Failed to create directory symlink from {:?} to {:?}",
                    src_owned, dst_owned
                ))?;
            }
            Ok(())
        })
        .await?
    }

    /// Removes a symbolic link.
    pub async fn remove_symlink(&self, path: &Path) -> Result<()> {
        let path_owned = path.to_owned();
        tokio::task::spawn_blocking(move || -> Result<()> {
            #[cfg(target_os = "windows")]
            {
                let metadata = std::fs::symlink_metadata(&path_owned)
                    .context(format!("Failed to read metadata for {:?}", path_owned))?;
                if metadata.file_type().is_dir() {
                    std::fs::remove_dir(&path_owned).context(format!(
                        "Failed to remove directory symlink: {:?}",
                        path_owned
                    ))?;
                } else {
                    std::fs::remove_file(&path_owned)
                        .context(format!("Failed to remove file symlink: {:?}", path_owned))?;
                }
            }
            #[cfg(target_family = "unix")]
            {
                std::fs::remove_file(&path_owned)
                    .context(format!("Failed to remove symlink: {:?}", path_owned))?;
            }
            Ok(())
        })
        .await?
    }

    /// Checks if a path is a symbolic link.
    pub async fn is_symlink(&self, path: &Path) -> Result<bool> {
        let path_owned = path.to_owned();
        tokio::task::spawn_blocking(move || {
            let metadata = std::fs::symlink_metadata(&path_owned)
                .context(format!("Failed to read metadata for {:?}", path_owned))?;
            Ok(metadata.file_type().is_symlink())
        })
        .await?
    }

    async fn path_exists_or_symlink(&self, path: &Path) -> bool {
        tokio::fs::symlink_metadata(path).await.is_ok()
    }

    /// Resolves a symbolic link to its target path.
    #[allow(dead_code)]
    pub async fn resolve_symlink(&self, path: &Path) -> Result<PathBuf> {
        let path_owned = path.to_owned();
        tokio::task::spawn_blocking(move || {
            std::fs::read_link(&path_owned)
                .context(format!("Failed to resolve symlink: {:?}", path_owned))
        })
        .await?
    }

    async fn remove_path_if_exists(&self, path: &Path) -> Result<bool> {
        if !self.path_exists_or_symlink(path).await {
            return Ok(false);
        }

        let meta = fs::symlink_metadata(path).await?;
        if meta.file_type().is_symlink() {
            self.remove_symlink(path).await?;
            return Ok(true);
        }
        if meta.is_file() {
            fs::remove_file(path).await?;
            return Ok(true);
        }
        if meta.is_dir() {
            fs::remove_dir_all(path).await?;
            return Ok(true);
        }

        Ok(false)
    }

    fn tracked_name_variants(name: &str) -> Vec<String> {
        if name.ends_with(".disabled") {
            vec![
                name.to_string(),
                name.trim_end_matches(".disabled").to_string(),
            ]
        } else {
            vec![name.to_string(), format!("{name}.disabled")]
        }
    }

    fn storage_contains_expected_file(files: &HashSet<String>, file_name: &str) -> bool {
        Self::tracked_name_variants(file_name)
            .into_iter()
            .map(|name| name.to_lowercase())
            .any(|name| files.contains(&name))
    }

    async fn tracked_entry_exists_in_environment(
        &self,
        output_dir: &str,
        file_name: &str,
        symlink_paths: Option<&Vec<String>>,
    ) -> bool {
        let mods_dir = self.get_mods_directory(output_dir);
        let plugins_dir = self.get_plugins_directory(output_dir);
        let userlibs_dir = Path::new(output_dir).join("UserLibs");

        let mut candidate_paths: Vec<PathBuf> = Vec::new();
        for variant in Self::tracked_name_variants(file_name) {
            candidate_paths.push(mods_dir.join(&variant));
            candidate_paths.push(plugins_dir.join(&variant));
            candidate_paths.push(userlibs_dir.join(&variant));
        }

        if let Some(paths) = symlink_paths {
            for path in paths {
                for variant in Self::tracked_name_variants(path) {
                    candidate_paths.push(PathBuf::from(variant));
                }
            }
        }

        for path in candidate_paths {
            if self.path_exists_or_symlink(&path).await {
                return true;
            }
        }

        false
    }

    pub async fn reconcile_tracked_mod_state(&self) -> Result<Vec<String>> {
        #[derive(Clone)]
        struct ReconcileEntry {
            environment_id: String,
            file_name: String,
            mod_storage_id: Option<String>,
            symlink_paths: Option<Vec<String>>,
        }

        let rows = sqlx::query_as::<_, (String, String, String)>(
            "SELECT environment_id, file_name, data FROM mod_metadata WHERE kind = 'mods'",
        )
        .fetch_all(&*self.pool)
        .await
        .context("Failed to load mod metadata for reconciliation")?;

        if rows.is_empty() {
            return Ok(Vec::new());
        }

        let mut entries: Vec<ReconcileEntry> = Vec::new();
        for (environment_id, file_name, data) in rows {
            if let Ok(meta) = serde_json::from_str::<ModMetadata>(&data) {
                entries.push(ReconcileEntry {
                    environment_id,
                    file_name,
                    mod_storage_id: meta.mod_storage_id,
                    symlink_paths: meta.symlink_paths,
                });
            }
        }

        if entries.is_empty() {
            return Ok(Vec::new());
        }

        let env_rows = sqlx::query_as::<_, (String, String)>("SELECT id, data FROM environments")
            .fetch_all(&*self.pool)
            .await
            .context("Failed to load environments for reconciliation")?;

        let mut env_output_dirs: HashMap<String, String> = HashMap::new();
        for (env_id, data) in env_rows {
            if let Ok(env) = serde_json::from_str::<Environment>(&data) {
                env_output_dirs.insert(env_id, env.output_dir);
            }
        }

        let mut entries_by_storage: HashMap<String, Vec<(String, String)>> = HashMap::new();
        for entry in &entries {
            if let Some(storage_id) = entry.mod_storage_id.as_ref() {
                entries_by_storage
                    .entry(storage_id.clone())
                    .or_default()
                    .push((entry.environment_id.clone(), entry.file_name.clone()));
            }
        }

        let storage_root = self.get_mods_storage_dir().await?;
        let mut broken_storage_ids: HashSet<String> = HashSet::new();
        for (storage_id, storage_entries) in &entries_by_storage {
            let storage_path = storage_root.join(storage_id);
            if !storage_path.exists() {
                broken_storage_ids.insert(storage_id.clone());
                continue;
            }

            let storage_meta = fs::metadata(&storage_path)
                .await
                .context("Failed to read storage metadata during reconciliation")?;
            if !storage_meta.is_dir() {
                broken_storage_ids.insert(storage_id.clone());
                continue;
            }

            let files = self.collect_storage_files(&storage_path).await?;
            if files.is_empty() {
                broken_storage_ids.insert(storage_id.clone());
                continue;
            }

            let storage_file_set: HashSet<String> =
                files.into_iter().map(|f| f.to_lowercase()).collect();
            let missing_base_file = storage_entries.iter().any(|(_, file_name)| {
                !Self::storage_contains_expected_file(&storage_file_set, file_name)
            });
            if missing_base_file {
                broken_storage_ids.insert(storage_id.clone());
            }
        }

        let mut rows_to_delete: HashSet<(String, String)> = HashSet::new();
        let mut affected_env_ids: HashSet<String> = HashSet::new();
        for entry in &entries {
            if let Some(storage_id) = entry.mod_storage_id.as_ref() {
                if broken_storage_ids.contains(storage_id) {
                    rows_to_delete.insert((entry.environment_id.clone(), entry.file_name.clone()));
                    affected_env_ids.insert(entry.environment_id.clone());
                    continue;
                }
            }

            let output_dir = match env_output_dirs.get(&entry.environment_id) {
                Some(output_dir) => output_dir,
                None => {
                    rows_to_delete.insert((entry.environment_id.clone(), entry.file_name.clone()));
                    affected_env_ids.insert(entry.environment_id.clone());
                    continue;
                }
            };

            let entry_exists = self
                .tracked_entry_exists_in_environment(
                    output_dir,
                    &entry.file_name,
                    entry.symlink_paths.as_ref(),
                )
                .await;
            if !entry_exists {
                rows_to_delete.insert((entry.environment_id.clone(), entry.file_name.clone()));
                affected_env_ids.insert(entry.environment_id.clone());
            }
        }

        if rows_to_delete.is_empty() {
            return Ok(Vec::new());
        }

        let mut tx = self
            .pool
            .begin()
            .await
            .context("Failed to begin reconciliation transaction")?;

        for (environment_id, file_name) in rows_to_delete {
            sqlx::query(
                "DELETE FROM mod_metadata WHERE environment_id = ? AND kind = 'mods' AND file_name = ?",
            )
            .bind(&environment_id)
            .bind(&file_name)
            .execute(&mut *tx)
            .await
            .context("Failed to delete stale mod metadata entry")?;
        }

        tx.commit()
            .await
            .context("Failed to commit reconciliation transaction")?;

        let mut affected: Vec<String> = affected_env_ids.into_iter().collect();
        affected.sort();
        Ok(affected)
    }

    pub async fn load_mod_metadata(
        &self,
        mods_directory: &Path,
    ) -> Result<HashMap<String, ModMetadata>> {
        let game_dir = mods_directory
            .parent()
            .and_then(|p| p.to_str())
            .unwrap_or("");
        let env_id = self.environment_id_for_dir(game_dir).await?;
        let mut metadata = HashMap::new();

        if let Some(env_id) = env_id {
            let rows = sqlx::query_as::<_, (String, String)>(
                "SELECT file_name, data FROM mod_metadata WHERE environment_id = ? AND kind = 'mods'",
            )
            .bind(&env_id)
            .fetch_all(&*self.pool)
            .await
            .context("Failed to load mod metadata")?;

            for (file_name, data) in rows {
                if let Ok(entry) = serde_json::from_str::<ModMetadata>(&data) {
                    metadata.insert(file_name, entry);
                }
            }
        }

        if metadata.is_empty() {
            if let Ok(file_metadata) = self.load_mod_metadata_from_file(mods_directory).await {
                if !file_metadata.is_empty() {
                    self.save_mod_metadata(mods_directory, &file_metadata)
                        .await?;
                    metadata = file_metadata;
                }
            }
        }

        if let Ok(repaired) = self
            .recover_mod_metadata_from_storage(mods_directory, &mut metadata)
            .await
        {
            if repaired {
                if let Err(err) = self.save_mod_metadata(mods_directory, &metadata).await {
                    log::warn!(
                        "Failed to persist recovered mod metadata for {}: {}",
                        mods_directory.display(),
                        err
                    );
                }
            }
        }

        Ok(metadata)
    }

    async fn load_mod_metadata_from_file(
        &self,
        mods_directory: &Path,
    ) -> Result<HashMap<String, ModMetadata>> {
        let metadata_file = mods_directory.join(".mods-metadata.json");
        if !metadata_file.exists() {
            return Ok(HashMap::new());
        }

        let content = fs::read_to_string(&metadata_file)
            .await
            .context("Failed to read mod metadata file")?;
        let metadata: HashMap<String, ModMetadata> =
            serde_json::from_str(&content).context("Failed to parse mod metadata file")?;
        Ok(metadata)
    }

    pub async fn save_mod_metadata(
        &self,
        mods_directory: &Path,
        metadata: &HashMap<String, ModMetadata>,
    ) -> Result<()> {
        let game_dir = mods_directory
            .parent()
            .and_then(|p| p.to_str())
            .unwrap_or("");
        let env_id = match self.environment_id_for_dir(game_dir).await? {
            Some(id) => id,
            None => {
                log::warn!(
                    "Skipping mod metadata save; environment not found for {}",
                    game_dir
                );
                return Ok(());
            }
        };

        let mut tx = self
            .pool
            .begin()
            .await
            .context("Failed to begin transaction for mod metadata")?;

        sqlx::query("DELETE FROM mod_metadata WHERE environment_id = ? AND kind = 'mods'")
            .bind(&env_id)
            .execute(&mut *tx)
            .await
            .context("Failed to clear mod metadata")?;

        for (file_name, meta) in metadata {
            let serialized =
                serde_json::to_string(meta).context("Failed to serialize mod metadata")?;
            sqlx::query(
                "INSERT INTO mod_metadata (environment_id, kind, file_name, data) VALUES (?, 'mods', ?, ?) \
                 ON CONFLICT(environment_id, kind, file_name) DO UPDATE SET data = excluded.data",
            )
            .bind(&env_id)
            .bind(file_name)
            .bind(serialized)
            .execute(&mut *tx)
            .await
            .context("Failed to save mod metadata")?;
        }

        tx.commit()
            .await
            .context("Failed to commit mod metadata transaction")?;
        Ok(())
    }

    pub async fn extract_mod_version(&self, dll_path: &Path) -> Option<String> {
        // Method 1: Use PowerShell on Windows to get file version
        #[cfg(target_os = "windows")]
        {
            if let Ok(version) = self.extract_version_powershell(dll_path).await {
                if !version.is_empty() && version != "null" {
                    return Some(version);
                }
            }
        }

        // Method 2: Try to read version from DLL binary
        if let Ok(version) = self.extract_version_from_binary(dll_path).await {
            return Some(version);
        }

        None
    }

    #[cfg(target_os = "windows")]
    async fn extract_version_powershell(&self, dll_path: &Path) -> Result<String> {
        #[allow(unused_imports)] // Required for CommandExt trait methods
        use std::os::windows::process::CommandExt;

        let path_str = dll_path.to_string_lossy().replace('\'', "''");

        let _output = Command::new("powershell")
            .arg("-Command")
            .arg(&format!(
                "(Get-Item '{}').VersionInfo.FileVersion",
                path_str
            ))
            .creation_flags(0x08000000) // CREATE_NO_WINDOW flag
            .output()
            .await
            .context("Failed to execute PowerShell command")?;

        if _output.status.success() {
            let version = String::from_utf8_lossy(&_output.stdout).trim().to_string();
            if !version.is_empty() && version != "null" {
                return Ok(version);
            }
        }

        Err(anyhow::anyhow!("PowerShell version extraction failed"))
    }

    async fn extract_version_from_binary(&self, dll_path: &Path) -> Result<String> {
        let content = fs::read(dll_path)
            .await
            .context("Failed to read DLL file")?;

        // Read first 1MB to search for version strings
        let search_len = std::cmp::min(content.len(), 1024 * 1024);
        let text = String::from_utf8_lossy(&content[..search_len]);

        // Look for AssemblyVersion or AssemblyFileVersion
        let assembly_version_re =
            Regex::new(r#"AssemblyVersion[^\x00]*?([0-9]+\.[0-9]+(?:\.[0-9]+(?:\.[0-9]+)?)?)"#)
                .context("Failed to compile regex")?;

        if let Some(caps) = assembly_version_re.captures(&text) {
            if let Some(version) = caps.get(1) {
                return Ok(version.as_str().to_string());
            }
        }

        let file_version_re =
            Regex::new(r#"AssemblyFileVersion[^\x00]*?([0-9]+\.[0-9]+(?:\.[0-9]+(?:\.[0-9]+)?)?)"#)
                .context("Failed to compile regex")?;

        if let Some(caps) = file_version_re.captures(&text) {
            if let Some(version) = caps.get(1) {
                return Ok(version.as_str().to_string());
            }
        }

        // Fallback: look for any version-like pattern
        let version_pattern = Regex::new(r#"\b([0-9]+\.[0-9]+\.[0-9]+(?:\.[0-9]+)?)\b"#)
            .context("Failed to compile regex")?;

        for cap in version_pattern.captures_iter(&text) {
            if let Some(version) = cap.get(1) {
                let version_str = version.as_str();
                let parts: Vec<&str> = version_str.split('.').collect();
                // Avoid very large numbers that might be timestamps
                if parts.len() >= 2 {
                    if let Ok(major) = parts[0].parse::<u32>() {
                        if major < 1000 {
                            return Ok(version_str.to_string());
                        }
                    }
                }
            }
        }

        Err(anyhow::anyhow!("No version found in DLL binary"))
    }

    pub async fn list_mods(&self, game_dir: &str) -> Result<serde_json::Value> {
        let mods_directory = self.get_mods_directory(game_dir);

        if !mods_directory.exists() {
            return Ok(serde_json::json!({
                "mods": [],
                "modsDirectory": mods_directory.to_string_lossy().to_string(),
                "count": 0
            }));
        }

        let mut entries = fs::read_dir(&mods_directory)
            .await
            .context("Failed to read Mods directory")?;

        let mut dll_files = Vec::new();
        while let Some(entry) = entries.next_entry().await? {
            let path = entry.path();
            if path.is_file() {
                // Extract file name from path before converting to string
                let file_name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
                let path_string = path.to_string_lossy().to_string();
                let lower_name = file_name.to_lowercase();
                if lower_name.ends_with(".dll") || lower_name.ends_with(".dll.disabled") {
                    dll_files.push((path_string, file_name.to_string()));
                }
            }
        }

        // Load metadata
        let metadata = self
            .load_mod_metadata(&mods_directory)
            .await
            .unwrap_or_else(|_| HashMap::new());

        let mut mods = Vec::new();
        for (file_path, file_name) in dll_files {
            let is_disabled = file_name.to_lowercase().ends_with(".disabled");
            let original_file_name = if is_disabled {
                file_name.replace(".disabled", "")
            } else {
                file_name.clone()
            };

            let mod_name = original_file_name.replace(".dll", "").replace(".DLL", "");

            // Get metadata
            let file_metadata = metadata
                .get(&original_file_name)
                .or_else(|| metadata.get(&file_name))
                .cloned();

            // Extract version if not disabled and not in metadata
            // Prefer source_version (from Thunderstore) over installed_version (extracted from DLL)
            let version = if let Some(ref meta) = file_metadata {
                meta.source_version
                    .clone()
                    .or(meta.installed_version.clone())
            } else if !is_disabled {
                self.extract_mod_version(Path::new(&file_path)).await
            } else {
                None
            };

            let source = file_metadata.as_ref().and_then(|m| m.source.clone());
            let source_url = file_metadata.as_ref().and_then(|m| m.source_url.clone());
            let mod_storage_id = file_metadata
                .as_ref()
                .and_then(|m| m.mod_storage_id.clone());
            let managed = mod_storage_id.is_some();
            let summary = file_metadata.as_ref().and_then(|m| m.summary.clone());
            let icon_url = file_metadata.as_ref().and_then(|m| m.icon_url.clone());
            let icon_cache_path = file_metadata
                .as_ref()
                .and_then(|m| m.icon_cache_path.clone());
            let downloads = file_metadata.as_ref().and_then(|m| m.downloads);
            let likes_or_endorsements =
                file_metadata.as_ref().and_then(|m| m.likes_or_endorsements);
            let updated_at = file_metadata.as_ref().and_then(|m| m.updated_at.clone());
            let tags = file_metadata.as_ref().and_then(|m| m.tags.clone());
            let installed_at = file_metadata.as_ref().and_then(|m| m.installed_at);
            let security_scan = if let Some(storage_id) = mod_storage_id.as_deref() {
                self.resolve_storage_security_scan_summary(
                    storage_id,
                    file_metadata.as_ref().and_then(|m| m.security_scan.clone()),
                )
                .await?
            } else {
                file_metadata.as_ref().and_then(|m| m.security_scan.clone())
            };

            mods.push(ModInfo {
                name: mod_name.clone(),
                file_name: original_file_name,
                path: file_path,
                version,
                source,
                source_url,
                disabled: Some(is_disabled),
                mod_storage_id,
                managed,
                summary,
                icon_url,
                icon_cache_path,
                downloads,
                likes_or_endorsements,
                updated_at,
                tags,
                installed_at,
                security_scan,
            });
        }

        let result = ModsListResult {
            mods_directory: mods_directory.to_string_lossy().to_string(),
            count: mods.len(),
            mods,
        };

        Ok(serde_json::to_value(result)?)
    }

    async fn load_environment(&self, env_id: &str) -> Result<Environment> {
        let row = sqlx::query_scalar::<_, String>("SELECT data FROM environments WHERE id = ?")
            .bind(env_id)
            .fetch_optional(&*self.pool)
            .await
            .context("Failed to query environment")?;

        let data = row.ok_or_else(|| anyhow::anyhow!("Environment not found"))?;
        serde_json::from_str::<Environment>(&data).context("Failed to parse environment")
    }

    pub async fn get_mod_library(&self) -> Result<ModLibraryResult> {
        self.reconcile_tracked_mod_state().await?;

        let storage_dir = self.get_mods_storage_dir().await?;
        if !storage_dir.exists() {
            return Ok(ModLibraryResult {
                downloaded: Vec::new(),
            });
        }

        let mut metadata_rows = sqlx::query_as::<_, (String, String)>(
            "SELECT environment_id, data FROM mod_metadata WHERE kind = 'mods'",
        )
        .fetch_all(&*self.pool)
        .await
        .context("Failed to load mod metadata for library")?;

        let env_rows = sqlx::query_as::<_, (String, String)>("SELECT id, data FROM environments")
            .fetch_all(&*self.pool)
            .await
            .context("Failed to load environments for library")?;
        let mut env_runtime_by_id: HashMap<String, crate::types::Runtime> = HashMap::new();
        for (env_id, data) in env_rows {
            if let Ok(env) = serde_json::from_str::<Environment>(&data) {
                env_runtime_by_id.insert(env_id, env.runtime);
            }
        }

        let mut storage_meta: HashMap<String, (ModMetadata, Vec<String>)> = HashMap::new();
        for (env_id, data) in metadata_rows.drain(..) {
            if let Ok(meta) = serde_json::from_str::<ModMetadata>(&data) {
                if let Some(storage_id) = meta.mod_storage_id.clone() {
                    let entry = storage_meta
                        .entry(storage_id)
                        .or_insert_with(|| (meta.clone(), Vec::new()));
                    if !entry.1.contains(&env_id) {
                        entry.1.push(env_id);
                    }
                }
            }
        }

        let mut entries = fs::read_dir(&storage_dir)
            .await
            .context("Failed to read mod storage directory")?;
        let mut grouped: HashMap<String, ModLibraryEntry> = HashMap::new();

        while let Some(entry) = entries.next_entry().await? {
            let entry_path = entry.path();
            let metadata = entry.metadata().await?;
            if !metadata.is_dir() {
                continue;
            }

            let storage_id = entry_path
                .file_name()
                .and_then(|v| v.to_str())
                .unwrap_or("")
                .to_string();
            if storage_id.is_empty() {
                continue;
            }

            let files = self.collect_storage_files(&entry_path).await?;
            if files.is_empty() {
                continue;
            }

            let (template, installed_in) =
                storage_meta.get(&storage_id).cloned().unwrap_or_else(|| {
                    (
                        ModMetadata {
                            source: None,
                            source_id: None,
                            source_version: None,
                            author: None,
                            mod_name: None,
                            source_url: None,
                            summary: None,
                            icon_url: None,
                            icon_cache_path: None,
                            downloads: None,
                            likes_or_endorsements: None,
                            updated_at: None,
                            tags: None,
                            installed_version: None,
                            library_added_at: None,
                            installed_at: None,
                            last_update_check: None,
                            metadata_last_refreshed: None,
                            update_available: None,
                            remote_version: None,
                            detected_runtime: None,
                            runtime_match: None,
                            mod_storage_id: None,
                            symlink_paths: None,
                            security_scan: None,
                        },
                        Vec::new(),
                    )
                });

            let mut template_meta = template.clone();
            if let Some(storage_meta_file) = self.load_storage_metadata(&entry_path).await? {
                template_meta = Self::merge_metadata(storage_meta_file, template_meta);
            }

            let mut display_name = template_meta.mod_name.clone().unwrap_or_else(|| {
                files
                    .get(0)
                    .cloned()
                    .unwrap_or_else(|| storage_id.clone())
                    .replace(".dll", "")
                    .replace(".DLL", "")
                    .replace(".disabled", "")
            });

            let is_thunderstore = template_meta
                .source
                .as_ref()
                .is_some_and(|source| matches!(source, ModSource::Thunderstore));
            if is_thunderstore {
                display_name = Self::normalize_runtime_suffix_token(&display_name);
            }

            let available_runtimes =
                self.detect_available_runtimes(&files, template_meta.detected_runtime.clone());
            let files_by_runtime = self.build_files_by_runtime(&files, &available_runtimes);

            let mut storage_ids_by_runtime = HashMap::new();
            for runtime in &available_runtimes {
                storage_ids_by_runtime.insert(runtime.clone(), storage_id.clone());
            }

            let mut installed_in_by_runtime: HashMap<String, Vec<String>> = HashMap::new();
            for env_id in &installed_in {
                if let Some(runtime) = env_runtime_by_id.get(env_id) {
                    let label = Self::runtime_label(runtime).to_string();
                    installed_in_by_runtime
                        .entry(label)
                        .or_default()
                        .push(env_id.clone());
                }
            }

            let installed_version = template_meta
                .source_version
                .clone()
                .or(template_meta.installed_version.clone());
            let managed = template_meta.mod_storage_id.is_some();
            let mut key_name = template_meta
                .mod_name
                .clone()
                .unwrap_or_else(|| display_name.clone());
            let mut source_id_key = template_meta.source_id.clone().unwrap_or_default();
            let mut version_key = template_meta
                .source_version
                .clone()
                .or(template_meta.installed_version.clone())
                .unwrap_or_default();

            if is_thunderstore {
                key_name = Self::normalize_runtime_suffix_token(&key_name);
                source_id_key = Self::normalize_thunderstore_source_id(&source_id_key);
                version_key = Self::normalize_runtime_suffix_token(&version_key);
            }

            let key = format!("{}::{}::{}", key_name, source_id_key, version_key);

            let entry = grouped.entry(key).or_insert_with(|| ModLibraryEntry {
                storage_id: storage_id.clone(),
                display_name: display_name.clone(),
                files: files.clone(),
                source: template_meta.source.clone(),
                source_id: template_meta.source_id.clone(),
                source_version: template_meta.source_version.clone(),
                source_url: template_meta.source_url.clone(),
                summary: template_meta.summary.clone(),
                icon_url: template_meta.icon_url.clone(),
                icon_cache_path: template_meta.icon_cache_path.clone(),
                downloads: template_meta.downloads,
                likes_or_endorsements: template_meta.likes_or_endorsements,
                updated_at: template_meta.updated_at.clone(),
                tags: template_meta.tags.clone(),
                installed_version: installed_version.clone(),
                library_added_at: template_meta.library_added_at,
                installed_at: template_meta.installed_at,
                author: template_meta.author.clone(),
                update_available: template_meta.update_available,
                remote_version: template_meta.remote_version.clone(),
                managed,
                installed_in: installed_in.clone(),
                available_runtimes: available_runtimes.clone(),
                storage_ids_by_runtime: storage_ids_by_runtime.clone(),
                installed_in_by_runtime: installed_in_by_runtime.clone(),
                files_by_runtime: files_by_runtime.clone(),
                security_scan: template_meta.security_scan.clone(),
            });

            if entry.summary.is_none() {
                entry.summary = template_meta.summary.clone();
            }
            if entry.icon_url.is_none() {
                entry.icon_url = template_meta.icon_url.clone();
            }
            if entry.icon_cache_path.is_none() {
                entry.icon_cache_path = template_meta.icon_cache_path.clone();
            }
            if entry.downloads.is_none() {
                entry.downloads = template_meta.downloads;
            }
            if entry.likes_or_endorsements.is_none() {
                entry.likes_or_endorsements = template_meta.likes_or_endorsements;
            }
            if entry.updated_at.is_none() {
                entry.updated_at = template_meta.updated_at.clone();
            }
            if entry.tags.is_none() {
                entry.tags = template_meta.tags.clone();
            }
            if entry.library_added_at.is_none() {
                entry.library_added_at = template_meta.library_added_at;
            }
            if entry.installed_at.is_none() {
                entry.installed_at = template_meta.installed_at;
            }
            entry.security_scan = Self::aggregate_security_scan_summary(
                entry.security_scan.clone(),
                template_meta.security_scan.clone(),
            );

            let mut file_set: HashSet<String> = entry.files.iter().cloned().collect();
            for file in files {
                file_set.insert(file);
            }
            entry.files = file_set.into_iter().collect();

            let mut installed_set: HashSet<String> = entry.installed_in.iter().cloned().collect();
            for env_id in installed_in {
                installed_set.insert(env_id);
            }
            entry.installed_in = installed_set.into_iter().collect();

            let mut runtime_set: HashSet<String> =
                entry.available_runtimes.iter().cloned().collect();
            for runtime in &available_runtimes {
                runtime_set.insert(runtime.clone());
            }
            entry.available_runtimes = runtime_set.into_iter().collect();

            for (runtime, storage_id) in storage_ids_by_runtime {
                entry
                    .storage_ids_by_runtime
                    .entry(runtime)
                    .or_insert(storage_id);
            }

            for (runtime, env_ids) in installed_in_by_runtime {
                let list = entry
                    .installed_in_by_runtime
                    .entry(runtime)
                    .or_insert_with(Vec::new);
                let mut env_set: HashSet<String> = list.iter().cloned().collect();
                for env_id in env_ids {
                    env_set.insert(env_id);
                }
                *list = env_set.into_iter().collect();
            }

            for (runtime, file_list) in files_by_runtime {
                let list = entry
                    .files_by_runtime
                    .entry(runtime)
                    .or_insert_with(Vec::new);
                let mut file_set: HashSet<String> = list.iter().cloned().collect();
                for file in file_list {
                    file_set.insert(file);
                }
                *list = file_set.into_iter().collect();
            }
        }

        let mut downloaded: Vec<ModLibraryEntry> = grouped.into_values().collect();
        downloaded.sort_by(|a, b| {
            a.display_name
                .to_lowercase()
                .cmp(&b.display_name.to_lowercase())
        });

        Ok(ModLibraryResult { downloaded })
    }

    pub async fn store_mod_archive(
        &self,
        file_path: &str,
        original_file_name: &str,
        runtime: Option<crate::types::Runtime>,
        metadata: Option<serde_json::Value>,
        target: Option<String>,
    ) -> Result<serde_json::Value> {
        let archive_path = Path::new(file_path);
        if !archive_path.exists() {
            return Err(anyhow::anyhow!("File not found"));
        }

        let source_id = metadata.as_ref().and_then(|m| {
            m.get("sourceId")
                .and_then(|s| s.as_str())
                .map(|s| s.to_string())
        });
        let source_version = metadata.as_ref().and_then(|m| {
            m.get("sourceVersion")
                .and_then(|s| s.as_str())
                .map(|s| s.to_string())
        });

        if let (Some(ref source_id), Some(ref source_version)) =
            (source_id.as_ref(), source_version.as_ref())
        {
            if let Ok(Some(existing_id)) = self
                .find_existing_mod_storage_by_source_version(
                    source_id,
                    source_version,
                    runtime.clone(),
                )
                .await
            {
                return Ok(serde_json::json!({
                    "success": true,
                    "storageId": existing_id,
                    "alreadyStored": true,
                }));
            }
        }

        let mod_id = self.generate_mod_id();
        let mod_storage_dir = self.get_mods_storage_dir().await?;
        let mod_storage_base = mod_storage_dir.join(&mod_id);
        let mod_storage_mods = mod_storage_base.join("Mods");
        let mod_storage_plugins = mod_storage_base.join("Plugins");
        let mod_storage_userlibs = mod_storage_base.join("UserLibs");

        fs::create_dir_all(&mod_storage_mods)
            .await
            .context("Failed to create mod storage Mods directory")?;
        fs::create_dir_all(&mod_storage_plugins)
            .await
            .context("Failed to create mod storage Plugins directory")?;
        fs::create_dir_all(&mod_storage_userlibs)
            .await
            .context("Failed to create mod storage UserLibs directory")?;

        let file_ext = archive_path
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .to_lowercase();

        let mut installed_files = Vec::new();
        if file_ext == "dll" {
            let file_name = if !original_file_name.is_empty() {
                original_file_name.to_string()
            } else {
                archive_path
                    .file_name()
                    .and_then(|n| n.to_str())
                    .unwrap_or("mod.dll")
                    .to_string()
            };
            let target_dir = match target.as_deref() {
                Some("plugins") => &mod_storage_plugins,
                _ => &mod_storage_mods,
            };

            let dest_path = target_dir.join(&file_name);
            fs::copy(&archive_path, &dest_path)
                .await
                .context("Failed to store DLL file")?;
            installed_files.push(file_name);
        } else {
            let temp_dir = std::env::temp_dir().join(format!(
                "mod-store-{}",
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_secs()
            ));
            fs::create_dir_all(&temp_dir).await?;

            let runtime_label = runtime.as_ref().map(|r| Self::runtime_label(r));
            let result = match file_ext.as_str() {
                "rar" => {
                    self.extract_and_install_rar(
                        archive_path,
                        &mod_storage_mods,
                        &mod_storage_plugins,
                        &mod_storage_userlibs,
                        &temp_dir,
                        runtime_label,
                    )
                    .await
                }
                "zip" | _ => {
                    self.extract_and_install_zip(
                        archive_path,
                        &mod_storage_mods,
                        &mod_storage_plugins,
                        &mod_storage_userlibs,
                        &temp_dir,
                        runtime_label,
                    )
                    .await
                }
            };

            let _ = fs::remove_dir_all(&temp_dir).await;
            installed_files = result?;
        }

        let metadata_ref = metadata.as_ref();

        let source_str = metadata_ref.and_then(|m| m.get("source").and_then(|s| s.as_str()));

        let mod_source = match source_str {
            Some("thunderstore") => Some(ModSource::Thunderstore),
            Some("nexusmods") => Some(ModSource::Nexusmods),
            Some("github") => Some(ModSource::Github),
            Some("unknown") => Some(ModSource::Unknown),
            Some("local") => Some(ModSource::Local),
            _ => None,
        };

        let mod_name = Self::metadata_string(metadata_ref, "modName");
        let author = Self::metadata_string(metadata_ref, "author");
        let source_url = Self::metadata_string(metadata_ref, "sourceUrl");
        let summary = Self::metadata_string(metadata_ref, "summary");
        let icon_url = Self::metadata_string(metadata_ref, "iconUrl");
        let icon_cache_path = self.cache_icon_from_url(icon_url.as_deref()).await;
        let downloads = Self::metadata_u64(metadata_ref, "downloads");
        let likes_or_endorsements = Self::metadata_i64(metadata_ref, "likesOrEndorsements")
            .or_else(|| Self::metadata_i64(metadata_ref, "endorsementCount"))
            .or_else(|| Self::metadata_i64(metadata_ref, "ratingScore"));
        let updated_at = Self::metadata_string(metadata_ref, "updatedAt");
        let tags = Self::metadata_tags(metadata_ref);

        let storage_metadata = ModMetadata {
            source: mod_source,
            source_id,
            source_version: source_version.clone(),
            author,
            mod_name,
            source_url,
            summary,
            icon_url,
            icon_cache_path,
            downloads,
            likes_or_endorsements,
            updated_at,
            tags,
            installed_version: source_version,
            library_added_at: Some(Utc::now()),
            installed_at: None,
            last_update_check: None,
            metadata_last_refreshed: None,
            update_available: None,
            remote_version: None,
            detected_runtime: runtime,
            runtime_match: None,
            mod_storage_id: Some(mod_id.clone()),
            symlink_paths: None,
            security_scan: metadata_ref.and_then(Self::security_scan_summary_from_metadata),
        };

        self.save_storage_metadata(&mod_storage_base, &storage_metadata)
            .await?;

        Ok(serde_json::json!({
            "success": true,
            "storageId": mod_id,
            "installedFiles": installed_files,
        }))
    }

    async fn install_storage_entries(
        &self,
        source_dir: &Path,
        dest_dir: &Path,
        allow_dirs: bool,
        runtime_label: &str,
        template_meta: &Option<ModMetadata>,
        storage_id: &str,
        metadata_map: &mut HashMap<String, ModMetadata>,
        installed_files: &mut Vec<String>,
        env_runtime: &crate::types::Runtime,
    ) -> Result<()> {
        if !source_dir.exists() {
            eprintln!(
                "[install_storage_entries] Source dir does not exist: {}",
                source_dir.display()
            );
            return Ok(());
        }

        let mut file_count = 0usize;
        let mut storage_entries = fs::read_dir(source_dir)
            .await
            .context("Failed to read storage directory")?;
        while let Some(entry) = storage_entries.next_entry().await? {
            file_count += 1;
            let path = entry.path();
            let file_name = path.file_name().and_then(|v| v.to_str()).unwrap_or("");
            if file_name.is_empty() {
                continue;
            }

            let metadata = fs::metadata(&path).await?;
            if metadata.is_dir() && !allow_dirs {
                continue;
            }

            let file_runtime = self.detect_mod_runtime_from_name(file_name);
            eprintln!("[install_storage_entries] Processing file: {}, detected runtime: {}, target runtime: {}", 
                     file_name, file_runtime, runtime_label);
            if file_runtime != "unknown" && file_runtime != runtime_label {
                eprintln!("[install_storage_entries] Skipping file {} due to runtime mismatch (file: {}, env: {})", 
                         file_name, file_runtime, runtime_label);
                continue;
            }

            let dest_path = dest_dir.join(file_name);
            if self.path_exists_or_symlink(&dest_path).await {
                let meta = fs::symlink_metadata(&dest_path).await?;
                if meta.file_type().is_symlink() {
                    self.remove_symlink(&dest_path).await?;
                } else if meta.is_file() {
                    fs::remove_file(&dest_path).await?;
                } else if meta.is_dir() {
                    fs::remove_dir_all(&dest_path).await?;
                }
            }

            if metadata.is_dir() {
                eprintln!(
                    "[install_storage_entries] Creating directory symlink: {} -> {}",
                    path.display(),
                    dest_path.display()
                );
                self.create_symlink_dir(&path, &dest_path)
                    .await
                    .with_context(|| {
                        format!(
                            "Failed to create directory symlink for storage entry {}",
                            file_name
                        )
                    })?;
                installed_files.push(file_name.to_string());
                eprintln!("[install_storage_entries] Successfully created directory symlink and added {} to installed_files", file_name);
            } else {
                eprintln!(
                    "[install_storage_entries] Creating file symlink: {} -> {}",
                    path.display(),
                    dest_path.display()
                );
                self.create_symlink_file(&path, &dest_path)
                    .await
                    .with_context(|| {
                        format!(
                            "Failed to create file symlink for storage entry {}",
                            file_name
                        )
                    })?;
                installed_files.push(file_name.to_string());
                eprintln!("[install_storage_entries] Successfully created file symlink and added {} to installed_files", file_name);
            }

            let detected_runtime = match file_runtime {
                RUNTIME_IL2CPP => Some(crate::types::Runtime::Il2cpp),
                RUNTIME_MONO => Some(crate::types::Runtime::Mono),
                _ => None,
            };
            let runtime_match = detected_runtime.as_ref().map(|dr| match (dr, env_runtime) {
                (crate::types::Runtime::Il2cpp, crate::types::Runtime::Il2cpp) => true,
                (crate::types::Runtime::Mono, crate::types::Runtime::Mono) => true,
                _ => false,
            });

            let mut meta = metadata_map.get(file_name).cloned().unwrap_or(ModMetadata {
                source: template_meta.as_ref().and_then(|t| t.source.clone()),
                source_id: template_meta.as_ref().and_then(|t| t.source_id.clone()),
                source_version: template_meta
                    .as_ref()
                    .and_then(|t| t.source_version.clone()),
                author: template_meta.as_ref().and_then(|t| t.author.clone()),
                mod_name: template_meta.as_ref().and_then(|t| t.mod_name.clone()),
                source_url: template_meta.as_ref().and_then(|t| t.source_url.clone()),
                summary: template_meta.as_ref().and_then(|t| t.summary.clone()),
                icon_url: template_meta.as_ref().and_then(|t| t.icon_url.clone()),
                icon_cache_path: template_meta
                    .as_ref()
                    .and_then(|t| t.icon_cache_path.clone()),
                downloads: template_meta.as_ref().and_then(|t| t.downloads),
                likes_or_endorsements: template_meta.as_ref().and_then(|t| t.likes_or_endorsements),
                updated_at: template_meta.as_ref().and_then(|t| t.updated_at.clone()),
                tags: template_meta.as_ref().and_then(|t| t.tags.clone()),
                installed_version: template_meta
                    .as_ref()
                    .and_then(|t| t.installed_version.clone()),
                library_added_at: template_meta.as_ref().and_then(|t| t.library_added_at),
                installed_at: None,
                last_update_check: None,
                metadata_last_refreshed: None,
                update_available: None,
                remote_version: None,
                detected_runtime: None,
                runtime_match: None,
                mod_storage_id: None,
                symlink_paths: None,
                security_scan: template_meta.as_ref().and_then(|t| t.security_scan.clone()),
            });

            if let Some(template) = template_meta.as_ref() {
                meta.source = template.source.clone();
                meta.source_id = template.source_id.clone();
                meta.source_version = template.source_version.clone();
                meta.author = template.author.clone();
                meta.mod_name = template.mod_name.clone();
                meta.source_url = template.source_url.clone();
                meta.summary = template.summary.clone();
                meta.icon_url = template.icon_url.clone();
                meta.icon_cache_path = template.icon_cache_path.clone();
                meta.downloads = template.downloads;
                meta.likes_or_endorsements = template.likes_or_endorsements;
                meta.updated_at = template.updated_at.clone();
                meta.tags = template.tags.clone();
                meta.library_added_at = template.library_added_at;
                meta.metadata_last_refreshed = template.metadata_last_refreshed;
                meta.security_scan = template.security_scan.clone();
            }
            meta.installed_version = template_meta
                .as_ref()
                .and_then(|t| t.installed_version.clone())
                .or(self.extract_mod_version(&path).await);
            meta.detected_runtime = detected_runtime;
            meta.runtime_match = runtime_match;
            meta.mod_storage_id = Some(storage_id.to_string());
            meta.symlink_paths = Some(vec![dest_path.to_string_lossy().to_string()]);
            meta.installed_at = Some(Utc::now());
            metadata_map.insert(file_name.to_string(), meta);
        }

        eprintln!(
            "[install_storage_entries] Processed {} entries from {}, installed {} files",
            file_count,
            source_dir.display(),
            installed_files.len()
        );

        Ok(())
    }

    pub async fn install_storage_mod_to_envs(
        &self,
        storage_id: &str,
        environment_ids: Vec<String>,
    ) -> Result<serde_json::Value> {
        let storage_dir = self.get_mods_storage_dir().await?;
        let storage_base = Self::validated_storage_path(&storage_dir, storage_id)?;
        if !storage_base.exists() {
            return Err(anyhow::anyhow!(
                "Mod storage not found at: {}",
                storage_base.display()
            ));
        }

        let storage_mods = storage_base.join("Mods");
        let storage_plugins = storage_base.join("Plugins");
        let storage_userlibs = storage_base.join("UserLibs");

        // Debug logging to help diagnose issues
        eprintln!(
            "[install_storage_mod_to_envs] Storage base: {}",
            storage_base.display()
        );
        eprintln!(
            "[install_storage_mod_to_envs] Mods dir exists: {}, path: {}",
            storage_mods.exists(),
            storage_mods.display()
        );
        eprintln!(
            "[install_storage_mod_to_envs] Plugins dir exists: {}, path: {}",
            storage_plugins.exists(),
            storage_plugins.display()
        );
        eprintln!(
            "[install_storage_mod_to_envs] UserLibs dir exists: {}, path: {}",
            storage_userlibs.exists(),
            storage_userlibs.display()
        );

        let template_meta = self
            .find_metadata_template_for_storage_id(storage_id)
            .await?;
        let mut results = Vec::new();

        for env_id in environment_ids {
            let env = self.load_environment(&env_id).await?;
            let runtime_label = Self::runtime_label(&env.runtime);

            let mods_dir = self.get_mods_directory(&env.output_dir);
            let plugins_dir = self.get_plugins_directory(&env.output_dir);
            let userlibs_dir = Path::new(&env.output_dir).join("UserLibs");

            fs::create_dir_all(&mods_dir)
                .await
                .context("Failed to create mods directory")?;
            fs::create_dir_all(&plugins_dir)
                .await
                .context("Failed to create plugins directory")?;
            fs::create_dir_all(&userlibs_dir)
                .await
                .context("Failed to create userlibs directory")?;

            let mut metadata_map = self
                .load_mod_metadata(&mods_dir)
                .await
                .unwrap_or_else(|_| HashMap::new());
            let mut installed_files = Vec::new();

            self.install_storage_entries(
                &storage_mods,
                &mods_dir,
                false,
                runtime_label,
                &template_meta,
                storage_id,
                &mut metadata_map,
                &mut installed_files,
                &env.runtime,
            )
            .await?;
            self.install_storage_entries(
                &storage_plugins,
                &plugins_dir,
                false,
                runtime_label,
                &template_meta,
                storage_id,
                &mut metadata_map,
                &mut installed_files,
                &env.runtime,
            )
            .await?;
            self.install_storage_entries(
                &storage_userlibs,
                &userlibs_dir,
                true,
                runtime_label,
                &template_meta,
                storage_id,
                &mut metadata_map,
                &mut installed_files,
                &env.runtime,
            )
            .await?;

            if installed_files.is_empty() {
                return Err(anyhow::anyhow!(
                    "No mod files found in storage {}. Checked: Mods(exists={}), Plugins(exists={}), UserLibs(exists={}). This usually means the mod archive was empty or contained no .dll files.",
                    storage_id,
                    storage_mods.exists(),
                    storage_plugins.exists(),
                    storage_userlibs.exists()
                ));
            }

            eprintln!(
                "[install_storage_mod_to_envs] Installed {} files for env {}",
                installed_files.len(),
                env_id
            );

            self.save_mod_metadata(&mods_dir, &metadata_map).await?;
            results.push(serde_json::json!({
                "environmentId": env_id,
                "installedFiles": installed_files,
            }));
        }

        Ok(serde_json::json!({ "results": results }))
    }

    pub async fn uninstall_storage_mod_from_envs(
        &self,
        storage_id: &str,
        environment_ids: Vec<String>,
    ) -> Result<serde_json::Value> {
        let mut results = Vec::new();

        for env_id in environment_ids {
            let env = self.load_environment(&env_id).await?;
            let mods_dir = self.get_mods_directory(&env.output_dir);
            let plugins_dir = self.get_plugins_directory(&env.output_dir);
            let userlibs_dir = Path::new(&env.output_dir).join("UserLibs");
            let mut metadata_map = self
                .load_mod_metadata(&mods_dir)
                .await
                .unwrap_or_else(|_| HashMap::new());

            let mut removed_files = Vec::new();
            let file_entries: Vec<(String, Option<Vec<String>>)> = metadata_map
                .iter()
                .filter_map(|(file_name, meta)| {
                    if meta.mod_storage_id.as_deref() == Some(storage_id) {
                        Some((file_name.clone(), meta.symlink_paths.clone()))
                    } else {
                        None
                    }
                })
                .collect();

            for (file_name, symlink_paths) in file_entries {
                let mut removed = false;
                if let Some(paths) = symlink_paths {
                    for path_str in paths {
                        let path = Path::new(&path_str);
                        let disabled_path = if path_str.ends_with(".disabled") {
                            None
                        } else {
                            Some(PathBuf::from(format!("{}.disabled", path_str)))
                        };
                        if let Ok(did_remove) = self.remove_path_if_exists(path).await {
                            removed |= did_remove;
                        }
                        if let Some(disabled) = disabled_path {
                            if let Ok(did_remove) = self.remove_path_if_exists(&disabled).await {
                                removed |= did_remove;
                            }
                        }
                    }
                } else {
                    let candidate_paths = vec![
                        mods_dir.join(&file_name),
                        plugins_dir.join(&file_name),
                        userlibs_dir.join(&file_name),
                    ];

                    for path in candidate_paths {
                        let disabled_path = if file_name.ends_with(".disabled") {
                            None
                        } else {
                            Some(PathBuf::from(format!(
                                "{}.disabled",
                                path.to_string_lossy()
                            )))
                        };
                        if let Ok(did_remove) = self.remove_path_if_exists(&path).await {
                            removed |= did_remove;
                        }
                        if let Some(disabled) = disabled_path {
                            if let Ok(did_remove) = self.remove_path_if_exists(&disabled).await {
                                removed |= did_remove;
                            }
                        }
                    }
                }

                if removed {
                    removed_files.push(file_name.clone());
                }
                metadata_map.remove(&file_name);
            }

            self.save_mod_metadata(&mods_dir, &metadata_map).await?;

            results.push(serde_json::json!({
                "environmentId": env_id,
                "removedFiles": removed_files,
            }));
        }

        Ok(serde_json::json!({ "results": results }))
    }

    pub async fn delete_downloaded_mod(&self, storage_id: &str) -> Result<serde_json::Value> {
        let rows = sqlx::query_as::<_, (String, String)>(
            "SELECT environment_id, data FROM mod_metadata WHERE kind = 'mods'",
        )
        .fetch_all(&*self.pool)
        .await
        .context("Failed to load mod metadata for deletion")?;

        let mut env_ids = Vec::new();
        for (env_id, data) in rows {
            if let Ok(meta) = serde_json::from_str::<ModMetadata>(&data) {
                if meta.mod_storage_id.as_deref() == Some(storage_id) {
                    env_ids.push(env_id);
                }
            }
        }

        env_ids.sort();
        env_ids.dedup();

        if !env_ids.is_empty() {
            self.uninstall_storage_mod_from_envs(storage_id, env_ids.clone())
                .await?;
        }

        let storage_dir = self.get_mods_storage_dir().await?;
        let storage_path = Self::validated_storage_path(&storage_dir, storage_id)?;
        let storage_meta = if storage_path.exists() {
            self.load_storage_metadata(&storage_path).await?
        } else {
            None
        };
        if storage_path.exists() {
            tokio::fs::remove_dir_all(&storage_path)
                .await
                .context("Failed to remove downloaded mod files")?;
        }

        self.remove_icon_cache_if_orphaned(
            storage_meta
                .as_ref()
                .and_then(|m| m.icon_cache_path.as_deref()),
            storage_id,
        )
        .await?;

        Ok(serde_json::json!({
            "deleted": true,
            "removedFrom": env_ids
        }))
    }

    pub async fn count_mods(&self, game_dir: &str) -> Result<u32> {
        let result = self.list_mods(game_dir).await?;
        let count = result.get("count").and_then(|v| v.as_u64()).unwrap_or(0) as u32;

        Ok(count)
    }

    pub async fn delete_mod(&self, game_dir: &str, mod_file_name: &str) -> Result<()> {
        let mods_directory = self.get_mods_directory(game_dir);
        let mod_path = mods_directory.join(mod_file_name);
        let disabled_path = mods_directory.join(format!("{}.disabled", mod_file_name));

        // Security: Ensure the file is within the mods directory and ends with .dll
        if !mod_file_name.to_lowercase().ends_with(".dll") {
            return Err(anyhow::anyhow!("Invalid mod file"));
        }

        let file_to_delete = if mod_path.exists() {
            mod_path
        } else if disabled_path.exists() {
            disabled_path
        } else {
            return Err(anyhow::anyhow!("Mod file not found"));
        };

        // Verify it's actually a file
        let metadata = fs::metadata(&file_to_delete).await?;
        if !metadata.is_file() {
            return Err(anyhow::anyhow!("Path is not a file"));
        }

        fs::remove_file(&file_to_delete)
            .await
            .context("Failed to delete mod file")?;

        // Remove from metadata
        let mut metadata_map = self
            .load_mod_metadata(&mods_directory)
            .await
            .unwrap_or_else(|_| HashMap::new());
        metadata_map.remove(mod_file_name);
        self.save_mod_metadata(&mods_directory, &metadata_map)
            .await?;

        Ok(())
    }

    pub async fn disable_mod(&self, game_dir: &str, mod_file_name: &str) -> Result<()> {
        let mods_directory = self.get_mods_directory(game_dir);
        let mod_path = mods_directory.join(mod_file_name);
        let disabled_path = mods_directory.join(format!("{}.disabled", mod_file_name));

        // Security: Ensure the file is within the mods directory and ends with .dll
        if !mod_file_name.to_lowercase().ends_with(".dll") {
            return Err(anyhow::anyhow!("Invalid mod file"));
        }

        if !mod_path.exists() {
            return Err(anyhow::anyhow!("Mod file not found"));
        }

        if disabled_path.exists() {
            return Err(anyhow::anyhow!("Mod is already disabled"));
        }

        // Verify it's actually a file
        let metadata = fs::metadata(&mod_path).await?;
        if !metadata.is_file() {
            return Err(anyhow::anyhow!("Path is not a file"));
        }

        // Rename the file
        fs::rename(&mod_path, &disabled_path)
            .await
            .context("Failed to disable mod")?;

        Ok(())
    }

    pub async fn enable_mod(&self, game_dir: &str, mod_file_name: &str) -> Result<()> {
        let mods_directory = self.get_mods_directory(game_dir);
        let disabled_path = mods_directory.join(format!("{}.disabled", mod_file_name));
        let mod_path = mods_directory.join(mod_file_name);

        // Security: Ensure the file is within the mods directory and ends with .dll
        if !mod_file_name.to_lowercase().ends_with(".dll") {
            return Err(anyhow::anyhow!("Invalid mod file"));
        }

        if !disabled_path.exists() {
            return Err(anyhow::anyhow!("Disabled mod file not found"));
        }

        if mod_path.exists() {
            return Err(anyhow::anyhow!("Mod file already exists (not disabled)"));
        }

        // Verify it's actually a file
        let metadata = fs::metadata(&disabled_path).await?;
        if !metadata.is_file() {
            return Err(anyhow::anyhow!("Path is not a file"));
        }

        // Rename the file back
        fs::rename(&disabled_path, &mod_path)
            .await
            .context("Failed to enable mod")?;

        Ok(())
    }

    pub async fn install_zip_mod(
        &self,
        game_dir: &str,
        zip_path: &str,
        _file_name: &str,
        runtime: &str,
        _branch: &str,
        metadata: Option<serde_json::Value>,
    ) -> Result<serde_json::Value> {
        eprintln!("[DEBUG] install_zip_mod: Starting symlink-based installation");
        eprintln!("[DEBUG] install_zip_mod called with runtime: '{}'", runtime);

        // Create game directories if they don't exist (for symlinks)
        let mods_directory = self.get_mods_directory(game_dir);
        let plugins_directory = self.get_plugins_directory(game_dir);
        let userlibs_directory = Path::new(game_dir).join("UserLibs");

        fs::create_dir_all(&mods_directory).await?;
        fs::create_dir_all(&plugins_directory).await?;
        fs::create_dir_all(&userlibs_directory).await?;

        // Create temp directory for extraction
        let temp_dir = std::env::temp_dir().join(format!(
            "mod-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_secs()
        ));

        fs::create_dir_all(&temp_dir).await?;

        // Check for Thunderstore manifest.json
        let archive_path = Path::new(zip_path);
        let thunderstore_manifest = self.extract_thunderstore_manifest(archive_path);

        // If we found a Thunderstore manifest, log it and prepare to use it
        let mut effective_metadata = metadata.clone();
        if let Some(ref manifest) = thunderstore_manifest {
            eprintln!("[DEBUG] Found Thunderstore manifest.json");
            eprintln!(
                "[DEBUG] Manifest contents: {}",
                serde_json::to_string_pretty(manifest).unwrap_or_default()
            );

            // Override metadata with Thunderstore data while preserving upstream card fields.
            let mut ts_metadata = effective_metadata
                .as_ref()
                .and_then(|v| v.as_object())
                .cloned()
                .unwrap_or_default();
            ts_metadata.insert(
                "source".to_string(),
                serde_json::Value::String("thunderstore".to_string()),
            );

            if let Some(name) = manifest.get("name").and_then(|v| v.as_str()) {
                ts_metadata.insert(
                    "modName".to_string(),
                    serde_json::Value::String(name.to_string()),
                );
            }

            if let Some(version) = manifest.get("version_number").and_then(|v| v.as_str()) {
                ts_metadata.insert(
                    "sourceVersion".to_string(),
                    serde_json::Value::String(version.to_string()),
                );
            }

            if let Some(author) = manifest.get("author").and_then(|v| v.as_str()) {
                ts_metadata.insert(
                    "author".to_string(),
                    serde_json::Value::String(author.to_string()),
                );
            }

            if let Some(website) = manifest.get("website_url").and_then(|v| v.as_str()) {
                ts_metadata.insert(
                    "sourceUrl".to_string(),
                    serde_json::Value::String(website.to_string()),
                );
            }

            if let Some(description) = manifest.get("description").and_then(|v| v.as_str()) {
                ts_metadata.insert(
                    "summary".to_string(),
                    serde_json::Value::String(description.to_string()),
                );
            }

            // Create source ID from author/name
            if let (Some(author), Some(name)) = (
                manifest.get("author").and_then(|v| v.as_str()),
                manifest.get("name").and_then(|v| v.as_str()),
            ) {
                let source_id = format!("{}/{}", author, name);
                ts_metadata.insert("sourceId".to_string(), serde_json::Value::String(source_id));
            }

            effective_metadata = Some(serde_json::Value::Object(ts_metadata));
        }

        // Extract source_id and source_version for duplicate detection
        let source_id = effective_metadata.as_ref().and_then(|m| {
            m.get("sourceId")
                .and_then(|s| s.as_str())
                .map(|s| s.to_string())
        });
        let source_version = effective_metadata.as_ref().and_then(|m| {
            m.get("sourceVersion")
                .and_then(|s| s.as_str())
                .map(|s| s.to_string())
        });

        // Check if we already have this mod/version installed
        let existing_mod_id = self
            .find_existing_mod_installation(game_dir, &source_id, &source_version)
            .await?;

        // If mod is already installed, skip extraction and just ensure symlinks exist
        if let Some(existing_id) = existing_mod_id {
            eprintln!("[DEBUG] install_zip_mod: Mod/version already installed with mod_id: {}, skipping extraction", existing_id);

            let mod_storage_dir = self.get_mods_storage_dir().await?;
            let mod_storage_base = mod_storage_dir.join(&existing_id);
            let mod_storage_mods = mod_storage_base.join("Mods");
            let mod_storage_plugins = mod_storage_base.join("Plugins");
            let mod_storage_userlibs = mod_storage_base.join("UserLibs");

            // Clean up temp directory (we don't need it)
            let _ = fs::remove_dir_all(&temp_dir).await;

            // Create symlinks if they don't exist (skip extraction)
            let mut symlink_paths = Vec::new();

            // For Mods directory - create symlinks if they don't exist
            if mod_storage_mods.exists() {
                let mut entries = fs::read_dir(&mod_storage_mods).await?;
                while let Some(entry) = entries.next_entry().await? {
                    let entry_path = entry.path();
                    let metadata = fs::metadata(&entry_path).await?;
                    if metadata.is_file() {
                        let file_name = entry_path
                            .file_name()
                            .and_then(|n| n.to_str())
                            .unwrap_or("");
                        let symlink_path = mods_directory.join(file_name);

                        // Only create symlink if it doesn't exist
                        if !self.path_exists_or_symlink(&symlink_path).await {
                            eprintln!("[DEBUG] install_zip_mod: Creating symlink for already-installed file: {:?} -> {:?}", entry_path, symlink_path);
                            if let Ok(_) =
                                self.create_symlink_file(&entry_path, &symlink_path).await
                            {
                                symlink_paths.push(symlink_path.to_string_lossy().to_string());
                            }
                        } else {
                            // Symlink already exists
                            symlink_paths.push(symlink_path.to_string_lossy().to_string());
                        }
                    }
                }
            }

            // Similar logic for Plugins and UserLibs
            if mod_storage_plugins.exists() {
                let mut entries = fs::read_dir(&mod_storage_plugins).await?;
                while let Some(entry) = entries.next_entry().await? {
                    let entry_path = entry.path();
                    let metadata = fs::metadata(&entry_path).await?;
                    if metadata.is_file() {
                        let file_name = entry_path
                            .file_name()
                            .and_then(|n| n.to_str())
                            .unwrap_or("");
                        let symlink_path = plugins_directory.join(file_name);
                        if !self.path_exists_or_symlink(&symlink_path).await {
                            if let Ok(_) =
                                self.create_symlink_file(&entry_path, &symlink_path).await
                            {
                                symlink_paths.push(symlink_path.to_string_lossy().to_string());
                            }
                        } else {
                            symlink_paths.push(symlink_path.to_string_lossy().to_string());
                        }
                    }
                }
            }

            if mod_storage_userlibs.exists() {
                let mut entries = fs::read_dir(&mod_storage_userlibs).await?;
                while let Some(entry) = entries.next_entry().await? {
                    let entry_path = entry.path();
                    let metadata = fs::metadata(&entry_path).await?;
                    let file_name = entry_path
                        .file_name()
                        .and_then(|n| n.to_str())
                        .unwrap_or("");
                    let symlink_path = userlibs_directory.join(file_name);
                    if metadata.is_dir() {
                        if !self.path_exists_or_symlink(&symlink_path).await {
                            if let Ok(_) = self.create_symlink_dir(&entry_path, &symlink_path).await
                            {
                                symlink_paths.push(symlink_path.to_string_lossy().to_string());
                            }
                        } else {
                            symlink_paths.push(symlink_path.to_string_lossy().to_string());
                        }
                    } else if metadata.is_file() {
                        if !self.path_exists_or_symlink(&symlink_path).await {
                            if let Ok(_) =
                                self.create_symlink_file(&entry_path, &symlink_path).await
                            {
                                symlink_paths.push(symlink_path.to_string_lossy().to_string());
                            }
                        } else {
                            symlink_paths.push(symlink_path.to_string_lossy().to_string());
                        }
                    }
                }
            }

            if mod_storage_mods.exists() {
                let template_meta = self
                    .find_metadata_template_for_storage_id(&existing_id)
                    .await?;
                let mut metadata_map = self
                    .load_mod_metadata(&mods_directory)
                    .await
                    .unwrap_or_else(|_| HashMap::new());

                let mut entries = fs::read_dir(&mod_storage_mods).await?;
                while let Some(entry) = entries.next_entry().await? {
                    let entry_path = entry.path();
                    let metadata = fs::metadata(&entry_path).await?;
                    if metadata.is_file() {
                        let file_name = entry_path
                            .file_name()
                            .and_then(|n| n.to_str())
                            .unwrap_or("");
                        let mut meta =
                            metadata_map.get(file_name).cloned().unwrap_or(ModMetadata {
                                source: template_meta.as_ref().and_then(|t| t.source.clone()),
                                source_id: template_meta.as_ref().and_then(|t| t.source_id.clone()),
                                source_version: template_meta
                                    .as_ref()
                                    .and_then(|t| t.source_version.clone()),
                                author: template_meta.as_ref().and_then(|t| t.author.clone()),
                                mod_name: template_meta.as_ref().and_then(|t| t.mod_name.clone()),
                                source_url: template_meta
                                    .as_ref()
                                    .and_then(|t| t.source_url.clone()),
                                summary: template_meta.as_ref().and_then(|t| t.summary.clone()),
                                icon_url: template_meta.as_ref().and_then(|t| t.icon_url.clone()),
                                icon_cache_path: template_meta
                                    .as_ref()
                                    .and_then(|t| t.icon_cache_path.clone()),
                                downloads: template_meta.as_ref().and_then(|t| t.downloads),
                                likes_or_endorsements: template_meta
                                    .as_ref()
                                    .and_then(|t| t.likes_or_endorsements),
                                updated_at: template_meta
                                    .as_ref()
                                    .and_then(|t| t.updated_at.clone()),
                                tags: template_meta.as_ref().and_then(|t| t.tags.clone()),
                                installed_version: template_meta
                                    .as_ref()
                                    .and_then(|t| t.installed_version.clone()),
                                library_added_at: template_meta
                                    .as_ref()
                                    .and_then(|t| t.library_added_at),
                                installed_at: None,
                                last_update_check: None,
                                metadata_last_refreshed: None,
                                update_available: None,
                                remote_version: None,
                                detected_runtime: template_meta
                                    .as_ref()
                                    .and_then(|t| t.detected_runtime.clone()),
                                runtime_match: template_meta.as_ref().and_then(|t| t.runtime_match),
                                mod_storage_id: None,
                                symlink_paths: None,
                                security_scan: template_meta
                                    .as_ref()
                                    .and_then(|t| t.security_scan.clone()),
                            });

                        if let Some(template) = template_meta.as_ref() {
                            meta.source = template.source.clone();
                            meta.source_id = template.source_id.clone();
                            meta.source_version = template.source_version.clone();
                            meta.author = template.author.clone();
                            meta.mod_name = template.mod_name.clone();
                            meta.source_url = template.source_url.clone();
                            meta.summary = template.summary.clone();
                            meta.icon_url = template.icon_url.clone();
                            meta.icon_cache_path = template.icon_cache_path.clone();
                            meta.downloads = template.downloads;
                            meta.likes_or_endorsements = template.likes_or_endorsements;
                            meta.updated_at = template.updated_at.clone();
                            meta.tags = template.tags.clone();
                            meta.library_added_at = template.library_added_at;
                            meta.metadata_last_refreshed = template.metadata_last_refreshed;
                            meta.detected_runtime = template.detected_runtime.clone();
                            meta.runtime_match = template.runtime_match;
                            meta.security_scan = template.security_scan.clone();
                        }

                        meta.installed_version = template_meta
                            .as_ref()
                            .and_then(|t| t.installed_version.clone())
                            .or(self.extract_mod_version(&entry_path).await);
                        meta.mod_storage_id = Some(existing_id.clone());
                        meta.installed_at = Some(Utc::now());

                        metadata_map.insert(file_name.to_string(), meta);
                    }
                }

                self.save_mod_metadata(&mods_directory, &metadata_map)
                    .await?;
            }

            // Return success - mod is already installed, symlinks verified
            return Ok(serde_json::json!({
                "success": true,
                "message": "Mod already installed, symlinks verified",
                "alreadyInstalled": true,
                "storageId": existing_id
            }));
        }

        // New installation - generate new mod_id and proceed with normal flow
        let mod_id = self.generate_mod_id();
        eprintln!("[DEBUG] install_zip_mod: Generated new mod_id: {}", mod_id);

        // Get mod storage directory
        let mod_storage_dir = self.get_mods_storage_dir().await?;
        let mod_storage_base = mod_storage_dir.join(&mod_id);
        let mod_storage_mods = mod_storage_base.join("Mods");
        let mod_storage_plugins = mod_storage_base.join("Plugins");
        let mod_storage_userlibs = mod_storage_base.join("UserLibs");

        // Create mod storage directories
        fs::create_dir_all(&mod_storage_mods)
            .await
            .context("Failed to create mod storage Mods directory")?;
        fs::create_dir_all(&mod_storage_plugins)
            .await
            .context("Failed to create mod storage Plugins directory")?;
        fs::create_dir_all(&mod_storage_userlibs)
            .await
            .context("Failed to create mod storage UserLibs directory")?;

        // Detect file type and call appropriate extraction function
        let file_ext = archive_path
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .to_lowercase();

        eprintln!("[DEBUG] Archive file: {}", zip_path);
        eprintln!("[DEBUG] Detected extension: {}", file_ext);

        // Extract to storage (extraction methods now copy to mod_storage_base instead of game directories)
        let installed_files = match file_ext.as_str() {
            "rar" => {
                eprintln!("[DEBUG] Using RAR extraction");
                match self
                    .extract_and_install_rar(
                        archive_path,
                        &mod_storage_mods,
                        &mod_storage_plugins,
                        &mod_storage_userlibs,
                        &temp_dir,
                        Some(runtime),
                    )
                    .await
                {
                    Ok(files) => files,
                    Err(e) => {
                        let _ = fs::remove_dir_all(&temp_dir).await;
                        let error_msg = format!("RAR extraction failed: {}", e);
                        eprintln!("[ERROR] {}", error_msg);
                        return Ok(serde_json::json!({
                            "success": false,
                            "error": error_msg
                        }));
                    }
                }
            }
            "zip" | _ => {
                eprintln!("[DEBUG] Using ZIP extraction");
                // Default to ZIP extraction for .zip files and unknown extensions
                match self
                    .extract_and_install_zip(
                        archive_path,
                        &mod_storage_mods,
                        &mod_storage_plugins,
                        &mod_storage_userlibs,
                        &temp_dir,
                        Some(runtime),
                    )
                    .await
                {
                    Ok(files) => files,
                    Err(e) => {
                        let _ = fs::remove_dir_all(&temp_dir).await;
                        let error_msg = format!("ZIP extraction failed: {}", e);
                        eprintln!("[ERROR] {}", error_msg);
                        return Ok(serde_json::json!({
                            "success": false,
                            "error": error_msg
                        }));
                    }
                }
            }
        };

        // Clean up temp directory
        let _ = fs::remove_dir_all(&temp_dir).await;

        // Create symlinks for all installed files
        let mut symlink_paths = Vec::new();
        eprintln!(
            "[DEBUG] install_zip_mod: Creating symlinks for {} files",
            installed_files.len()
        );

        // Walk through mod storage and create symlinks
        // For Mods directory
        if mod_storage_mods.exists() {
            let mut entries = fs::read_dir(&mod_storage_mods).await?;
            while let Some(entry) = entries.next_entry().await? {
                let entry_path = entry.path();
                let metadata = fs::metadata(&entry_path).await?;

                if metadata.is_file() {
                    let file_name = entry_path
                        .file_name()
                        .and_then(|n| n.to_str())
                        .unwrap_or("");
                    let symlink_path = mods_directory.join(file_name);

                    eprintln!(
                        "[DEBUG] install_zip_mod: Preparing symlink for {}: {:?} -> {:?}",
                        file_name, entry_path, symlink_path
                    );

                    // Remove existing symlink/file if it exists
                    if self.path_exists_or_symlink(&symlink_path).await {
                        eprintln!(
                            "[DEBUG] install_zip_mod: Removing existing file/symlink at {:?}",
                            symlink_path
                        );
                        if self.is_symlink(&symlink_path).await.unwrap_or(false) {
                            self.remove_symlink(&symlink_path).await?;
                        } else {
                            fs::remove_file(&symlink_path).await?;
                        }
                    }

                    // Verify source file exists
                    if !entry_path.exists() {
                        eprintln!(
                            "[ERROR] install_zip_mod: Source file does not exist: {:?}",
                            entry_path
                        );
                        return Err(anyhow::anyhow!(
                            "Source file does not exist: {:?}",
                            entry_path
                        ));
                    }

                    // Create symlink
                    eprintln!(
                        "[DEBUG] install_zip_mod: Creating symlink: {:?} -> {:?}",
                        entry_path, symlink_path
                    );
                    match self.create_symlink_file(&entry_path, &symlink_path).await {
                        Ok(_) => {
                            symlink_paths.push(symlink_path.to_string_lossy().to_string());
                            eprintln!("[DEBUG] install_zip_mod: Successfully created symlink {:?} -> {:?}", symlink_path, entry_path);
                        }
                        Err(e) => {
                            eprintln!("[ERROR] install_zip_mod: Failed to create symlink: {}", e);
                            eprintln!(
                                "[ERROR] install_zip_mod: Source: {:?}, Destination: {:?}",
                                entry_path, symlink_path
                            );
                            // On Windows, symlinks require admin privileges or Developer Mode
                            // Return a more helpful error message
                            return Err(anyhow::anyhow!("Failed to create symlink for {}: {}. On Windows, symlinks require administrator privileges or Developer Mode. Error details: {}", file_name, symlink_path.display(), e));
                        }
                    }
                }
            }
        }

        // For Plugins directory
        if mod_storage_plugins.exists() {
            let mut entries = fs::read_dir(&mod_storage_plugins).await?;
            while let Some(entry) = entries.next_entry().await? {
                let entry_path = entry.path();
                let metadata = fs::metadata(&entry_path).await?;

                if metadata.is_file() {
                    let file_name = entry_path
                        .file_name()
                        .and_then(|n| n.to_str())
                        .unwrap_or("");
                    let symlink_path = plugins_directory.join(file_name);

                    // Remove existing symlink/file if it exists
                    if self.path_exists_or_symlink(&symlink_path).await {
                        if self.is_symlink(&symlink_path).await.unwrap_or(false) {
                            self.remove_symlink(&symlink_path).await?;
                        } else {
                            fs::remove_file(&symlink_path).await?;
                        }
                    }

                    // Create symlink
                    match self.create_symlink_file(&entry_path, &symlink_path).await {
                        Ok(_) => {
                            symlink_paths.push(symlink_path.to_string_lossy().to_string());
                            eprintln!(
                                "[DEBUG] install_zip_mod: Created symlink {:?} -> {:?}",
                                symlink_path, entry_path
                            );
                        }
                        Err(e) => {
                            return Err(anyhow::anyhow!("Failed to create symlink for {}: {}. On Windows, symlinks require administrator privileges or Developer Mode. Error: {}", file_name, symlink_path.display(), e));
                        }
                    }
                }
            }
        }

        // For UserLibs directory (recursive - handle directories)
        if mod_storage_userlibs.exists() {
            // UserLibs can contain directories, so we need recursive symlink handling
            // For now, just handle files at the root level
            let mut entries = fs::read_dir(&mod_storage_userlibs).await?;
            while let Some(entry) = entries.next_entry().await? {
                let entry_path = entry.path();
                let metadata = fs::metadata(&entry_path).await?;
                let file_name = entry_path
                    .file_name()
                    .and_then(|n| n.to_str())
                    .unwrap_or("");
                let symlink_path = userlibs_directory.join(file_name);

                if metadata.is_dir() {
                    // For directories, create directory symlink
                    if self.path_exists_or_symlink(&symlink_path).await {
                        if self.is_symlink(&symlink_path).await.unwrap_or(false) {
                            self.remove_symlink(&symlink_path).await?;
                        } else {
                            fs::remove_dir_all(&symlink_path).await?;
                        }
                    }
                    match self.create_symlink_dir(&entry_path, &symlink_path).await {
                        Ok(_) => {
                            symlink_paths.push(symlink_path.to_string_lossy().to_string());
                        }
                        Err(e) => {
                            return Err(anyhow::anyhow!("Failed to create directory symlink for {}: {}. On Windows, symlinks require administrator privileges or Developer Mode. Error: {}", file_name, symlink_path.display(), e));
                        }
                    }
                } else {
                    // For files, create file symlink
                    if self.path_exists_or_symlink(&symlink_path).await {
                        if self.is_symlink(&symlink_path).await.unwrap_or(false) {
                            self.remove_symlink(&symlink_path).await?;
                        } else {
                            fs::remove_file(&symlink_path).await?;
                        }
                    }
                    match self.create_symlink_file(&entry_path, &symlink_path).await {
                        Ok(_) => {
                            symlink_paths.push(symlink_path.to_string_lossy().to_string());
                        }
                        Err(e) => {
                            return Err(anyhow::anyhow!("Failed to create symlink for {}: {}. On Windows, symlinks require administrator privileges or Developer Mode. Error: {}", file_name, symlink_path.display(), e));
                        }
                    }
                }
            }
        }

        // Update metadata
        let mut mod_metadata = self
            .load_mod_metadata(&mods_directory)
            .await
            .unwrap_or_else(|_| HashMap::new());

        // Extract metadata from effective metadata (includes Thunderstore manifest if found)
        // Note: source_id and source_version were already extracted earlier for duplicate detection
        let source_str = effective_metadata
            .as_ref()
            .and_then(|m| m.get("source").and_then(|s| s.as_str()));

        // Log the source we're setting for debugging
        eprintln!(
            "[DEBUG] install_zip_mod: metadata source = {:?}",
            source_str
        );

        let mod_source = match source_str {
            Some("thunderstore") => Some(ModSource::Thunderstore),
            Some("nexusmods") => Some(ModSource::Nexusmods),
            Some("github") => Some(ModSource::Github),
            Some("unknown") => Some(ModSource::Unknown),
            Some("local") => Some(ModSource::Local),
            _ => Some(ModSource::Local),
        };

        eprintln!("[DEBUG] install_zip_mod: mod_source = {:?}", mod_source);
        // source_id and source_version are already extracted above for duplicate detection
        let metadata_ref = effective_metadata.as_ref();
        let source_url = Self::metadata_string(metadata_ref, "sourceUrl");
        let mod_name = Self::metadata_string(metadata_ref, "modName");
        let author = Self::metadata_string(metadata_ref, "author");
        let summary = Self::metadata_string(metadata_ref, "summary");
        let icon_url = Self::metadata_string(metadata_ref, "iconUrl");
        let icon_cache_path = self.cache_icon_from_url(icon_url.as_deref()).await;
        let downloads = Self::metadata_u64(metadata_ref, "downloads");
        let likes_or_endorsements = Self::metadata_i64(metadata_ref, "likesOrEndorsements")
            .or_else(|| Self::metadata_i64(metadata_ref, "endorsementCount"))
            .or_else(|| Self::metadata_i64(metadata_ref, "ratingScore"));
        let updated_at = Self::metadata_string(metadata_ref, "updatedAt");
        let tags = Self::metadata_tags(metadata_ref);

        // Detect runtime from environment
        let env_runtime = match runtime {
            "IL2CPP" => crate::types::Runtime::Il2cpp,
            "Mono" => crate::types::Runtime::Mono,
            _ => crate::types::Runtime::Mono, // Default to Mono
        };

        // Try to get runtime from metadata first (user may have selected it)
        let metadata_detected_runtime = effective_metadata
            .as_ref()
            .and_then(|m| m.get("detectedRuntime").and_then(|s| s.as_str()));

        eprintln!(
            "[DEBUG] install_zip_mod: metadata_detected_runtime = {:?}",
            metadata_detected_runtime
        );

        for file_name in &installed_files {
            // Detect runtime from metadata or file name
            let detected_runtime_str = metadata_detected_runtime
                .unwrap_or_else(|| self.detect_mod_runtime_from_name(file_name));
            let detected_runtime = match detected_runtime_str.to_lowercase().as_str() {
                "il2cpp" => Some(crate::types::Runtime::Il2cpp),
                "mono" => Some(crate::types::Runtime::Mono),
                _ => None,
            };

            // Check if runtime matches
            let runtime_match = detected_runtime
                .as_ref()
                .map(|dr| match (dr, &env_runtime) {
                    (crate::types::Runtime::Il2cpp, crate::types::Runtime::Il2cpp) => true,
                    (crate::types::Runtime::Mono, crate::types::Runtime::Mono) => true,
                    _ => false,
                });

            if let Some(meta) = mod_metadata.get_mut(file_name) {
                // Update existing metadata
                eprintln!("[DEBUG] Updating existing metadata for: {}", file_name);
                eprintln!("[DEBUG] Old source: {:?}", meta.source);
                meta.installed_at = Some(Utc::now());
                // Update source info if provided
                if let Some(src) = mod_source.clone() {
                    meta.source = Some(src.clone());
                    eprintln!("[DEBUG] New source: {:?}", src);
                }
                if source_id.is_some() {
                    meta.source_id = source_id.clone();
                }
                if source_version.is_some() {
                    meta.source_version = source_version.clone();
                }
                if source_url.is_some() {
                    meta.source_url = source_url.clone();
                }
                if mod_name.is_some() {
                    meta.mod_name = mod_name.clone();
                }
                if author.is_some() {
                    meta.author = author.clone();
                }
                if summary.is_some() {
                    meta.summary = summary.clone();
                }
                if icon_url.is_some() {
                    meta.icon_url = icon_url.clone();
                }
                if icon_cache_path.is_some() {
                    meta.icon_cache_path = icon_cache_path.clone();
                }
                if downloads.is_some() {
                    meta.downloads = downloads;
                }
                if likes_or_endorsements.is_some() {
                    meta.likes_or_endorsements = likes_or_endorsements;
                }
                if updated_at.is_some() {
                    meta.updated_at = updated_at.clone();
                }
                if tags.is_some() {
                    meta.tags = tags.clone();
                }
                // Update runtime detection
                meta.detected_runtime = detected_runtime.clone();
                meta.runtime_match = runtime_match;
                // Update storage info
                meta.mod_storage_id = Some(mod_id.clone());
                meta.symlink_paths = Some(symlink_paths.clone());
                meta.security_scan = metadata_ref
                    .and_then(Self::security_scan_summary_from_metadata)
                    .or(meta.security_scan.clone());
                if meta.library_added_at.is_none() {
                    meta.library_added_at = Some(Utc::now());
                }
                meta.metadata_last_refreshed = Some(Utc::now());
            } else {
                // Create new metadata entry
                // Extract version from storage file
                let storage_file_path = mod_storage_mods.join(file_name);
                let installed_version = self.extract_mod_version(&storage_file_path).await;
                let new_meta = ModMetadata {
                    source: mod_source.clone(),
                    source_id: source_id.clone(),
                    source_version: source_version.clone(),
                    author: author.clone(),
                    mod_name: mod_name.clone(),
                    source_url: source_url.clone(),
                    summary: summary.clone(),
                    icon_url: icon_url.clone(),
                    icon_cache_path: icon_cache_path.clone(),
                    downloads,
                    likes_or_endorsements,
                    updated_at: updated_at.clone(),
                    tags: tags.clone(),
                    installed_version: installed_version,
                    library_added_at: Some(Utc::now()),
                    installed_at: Some(Utc::now()),
                    last_update_check: None,
                    metadata_last_refreshed: Some(Utc::now()),
                    update_available: None,
                    remote_version: None,
                    detected_runtime: detected_runtime.clone(),
                    runtime_match,
                    mod_storage_id: Some(mod_id.clone()),
                    symlink_paths: Some(symlink_paths.clone()),
                    security_scan: metadata_ref.and_then(Self::security_scan_summary_from_metadata),
                };
                mod_metadata.insert(file_name.clone(), new_meta);
            }
        }

        self.save_mod_metadata(&mods_directory, &mod_metadata)
            .await?;

        // Also save storage metadata so the library can access runtime info
        // Use the first mod's detected runtime for the storage entry
        let first_meta = mod_metadata.values().next();
        if let Some(meta) = first_meta {
            self.save_storage_metadata(&mod_storage_base, meta).await?;
        }

        // Return the actual source that was installed, not hardcoded "local"
        let response_source = match mod_source {
            Some(ModSource::Thunderstore) => "thunderstore",
            Some(ModSource::Nexusmods) => "nexusmods",
            Some(ModSource::Github) => "github",
            Some(ModSource::Unknown) => "unknown",
            Some(ModSource::Local) => "local",
            _ => "unknown",
        };

        eprintln!(
            "[DEBUG] install_zip_mod complete. Returning success with installed_files: {:?}",
            installed_files
        );
        Ok(serde_json::json!({
            "success": true,
            "installedFiles": installed_files,
            "source": response_source,
            "storageId": mod_id
        }))
    }

    fn extract_thunderstore_manifest(&self, zip_path: &Path) -> Option<serde_json::Value> {
        // Try to extract and parse manifest.json from the ZIP
        let file = File::open(zip_path).ok()?;
        let mut archive = ZipArchive::new(file).ok()?;

        // Look for manifest.json at root level
        for i in 0..archive.len() {
            let mut file = archive.by_index(i).ok()?;
            let file_name = file.name();

            // Check if it's manifest.json at root (no directory prefix)
            if file_name == "manifest.json" || file_name.ends_with("/manifest.json") {
                let mut contents = String::new();
                if file.read_to_string(&mut contents).is_ok() {
                    if let Ok(manifest) = serde_json::from_str::<serde_json::Value>(&contents) {
                        return Some(manifest);
                    }
                }
            }
        }

        None
    }

    async fn extract_and_install_zip(
        &self,
        zip_path: &Path,
        mods_dir: &Path,
        plugins_dir: &Path,
        userlibs_dir: &Path,
        temp_dir: &Path,
        runtime: Option<&str>,
    ) -> Result<Vec<String>> {
        let file = File::open(zip_path).context("Failed to open zip file")?;

        let mut archive = ZipArchive::new(file).context("Failed to read zip archive")?;

        // Extract all files to temp directory
        // First, collect all file data synchronously (before any await)
        let mut file_data = Vec::new();
        for i in 0..archive.len() {
            let mut file = archive
                .by_index(i)
                .context("Failed to read file from archive")?;

            let file_name = file.name().to_string();
            let is_dir = file_name.ends_with('/');

            let mut buffer = Vec::new();
            if !is_dir {
                file.read_to_end(&mut buffer)
                    .context("Failed to read file data from archive")?;
            }

            file_data.push((file_name, is_dir, buffer));
        }

        // Now do async operations with the collected data
        for (file_name, is_dir, buffer) in file_data {
            let outpath = temp_dir.join(&file_name);

            if is_dir {
                fs::create_dir_all(&outpath).await?;
            } else {
                if let Some(p) = outpath.parent() {
                    fs::create_dir_all(p).await?;
                }
                let mut outfile = fs::File::create(&outpath).await?;
                tokio::io::AsyncWriteExt::write_all(&mut outfile, &buffer).await?;
            }
        }

        let mut installed_files = Vec::new();

        let content_root = self.resolve_archive_content_root(temp_dir).await?;

        // Detect if this archive has IL2CPP/Mono subdirectories (runtime-specific structure)
        let (has_il2cpp_dir, has_mono_dir) = self.detect_runtime_directories(&content_root).await?;

        // Copy files from temp directory to appropriate locations
        let mut entries = fs::read_dir(&content_root).await?;
        while let Some(entry) = entries.next_entry().await? {
            let entry_path = entry.path();
            let file_name = entry_path
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("");

            let metadata = fs::metadata(&entry_path).await?;

            if metadata.is_dir() {
                let dir_name = file_name.to_lowercase();

                // Handle runtime-specific directories (e.g., "IL2CPP", "Mono")
                if has_il2cpp_dir || has_mono_dir {
                    // This archive has runtime-specific structure
                    let dir_runtime = self.detect_mod_runtime_from_name(file_name);
                    let should_process = match runtime {
                        Some(target) => dir_runtime == target,
                        None => dir_runtime == RUNTIME_IL2CPP || dir_runtime == RUNTIME_MONO,
                    };

                    if should_process {
                        // Process the runtime-specific directory
                        let mods_path = entry_path.join("mods");
                        let plugins_path = entry_path.join("plugins");
                        let userlibs_path = entry_path.join("userlibs");

                        if mods_path.exists() {
                            self.copy_directory_filtered(
                                &mods_path,
                                mods_dir,
                                runtime,
                                &mut installed_files,
                            )
                            .await?;
                        }
                        if plugins_path.exists() {
                            self.copy_directory_filtered(
                                &plugins_path,
                                plugins_dir,
                                runtime,
                                &mut installed_files,
                            )
                            .await?;
                        }
                        if userlibs_path.exists() {
                            Box::pin(self.copy_directory_recursive(&userlibs_path, userlibs_dir))
                                .await?;
                        }

                        // Also copy any DLLs directly in this runtime directory
                        let mut runtime_entries = fs::read_dir(&entry_path).await?;
                        while let Some(runtime_entry) = runtime_entries.next_entry().await? {
                            let runtime_entry_path = runtime_entry.path();
                            let runtime_file_name = runtime_entry_path
                                .file_name()
                                .and_then(|n| n.to_str())
                                .unwrap_or("");

                            if runtime_entry_path.is_file()
                                && runtime_file_name.to_lowercase().ends_with(".dll")
                            {
                                let dest_path = mods_dir.join(runtime_file_name);
                                fs::copy(&runtime_entry_path, &dest_path).await?;
                                installed_files.push(runtime_file_name.to_string());
                            }
                        }
                    }
                    continue;
                }

                // Standard structure without runtime-specific folders
                if dir_name == "mods" {
                    self.copy_directory_filtered(
                        &entry_path,
                        mods_dir,
                        runtime,
                        &mut installed_files,
                    )
                    .await?;
                } else if dir_name == "plugins" {
                    self.copy_directory_filtered(
                        &entry_path,
                        plugins_dir,
                        runtime,
                        &mut installed_files,
                    )
                    .await?;
                } else if dir_name == "userlibs" {
                    Box::pin(self.copy_directory_recursive(&entry_path, userlibs_dir)).await?;
                }
            } else if file_name.to_lowercase().ends_with(".dll") {
                // Check runtime match
                let file_runtime = self.detect_mod_runtime_from_name(file_name);
                let matches_runtime = match runtime {
                    Some(target) => file_runtime == target || file_runtime == "unknown",
                    None => true,
                };
                if matches_runtime {
                    let dest_path = mods_dir.join(file_name);
                    fs::copy(&entry_path, &dest_path).await?;
                    installed_files.push(file_name.to_string());
                }
            }
        }

        eprintln!(
            "[DEBUG] ZIP extraction complete. Installed files: {:?}",
            installed_files
        );
        Ok(installed_files)
    }

    async fn extract_and_install_rar(
        &self,
        rar_path: &Path,
        mods_dir: &Path,
        plugins_dir: &Path,
        userlibs_dir: &Path,
        temp_dir: &Path,
        runtime: Option<&str>,
    ) -> Result<Vec<String>> {
        // Extract RAR archive synchronously to avoid Send issues
        // The unrar crate is not Send, so we do all extraction before any async operations
        {
            let mut archive = Archive::new(rar_path.to_str().unwrap())
                .open_for_processing()
                .context("Failed to open RAR archive")?;

            let temp_dir_str = temp_dir
                .to_str()
                .ok_or_else(|| anyhow::anyhow!("Invalid temp directory path"))?;

            // Process all entries in the archive synchronously
            while let Some(header) = archive.read_header().context("Failed to read RAR header")? {
                let entry = header.entry();
                let is_dir = entry.is_directory();

                if is_dir {
                    archive = header.skip().context("Failed to skip directory entry")?;
                } else {
                    // Extract file to temp directory
                    archive = header
                        .extract_with_base(temp_dir_str)
                        .context("Failed to extract RAR file")?;
                }
            }
        } // Archive is dropped here, before any async operations

        let mut installed_files = Vec::new();

        let content_root = self.resolve_archive_content_root(temp_dir).await?;

        // Detect if this archive has IL2CPP/Mono subdirectories (runtime-specific structure)
        let (has_il2cpp_dir, has_mono_dir) = self.detect_runtime_directories(&content_root).await?;

        // Now do async operations to copy files from temp directory to appropriate locations
        let mut entries = fs::read_dir(&content_root).await?;
        while let Some(entry) = entries.next_entry().await? {
            let entry_path = entry.path();
            let file_name = entry_path
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("");

            let metadata = fs::metadata(&entry_path).await?;

            if metadata.is_dir() {
                let dir_name = file_name.to_lowercase();

                // Handle runtime-specific directories (e.g., "IL2CPP", "Mono")
                if has_il2cpp_dir || has_mono_dir {
                    // This archive has runtime-specific structure
                    let dir_runtime = self.detect_mod_runtime_from_name(file_name);
                    let should_process = match runtime {
                        Some(target) => dir_runtime == target,
                        None => dir_runtime == RUNTIME_IL2CPP || dir_runtime == RUNTIME_MONO,
                    };

                    if should_process {
                        // Process the runtime-specific directory
                        let mods_path = entry_path.join("mods");
                        let plugins_path = entry_path.join("plugins");
                        let userlibs_path = entry_path.join("userlibs");

                        if mods_path.exists() {
                            self.copy_directory_filtered(
                                &mods_path,
                                mods_dir,
                                runtime,
                                &mut installed_files,
                            )
                            .await?;
                        }
                        if plugins_path.exists() {
                            self.copy_directory_filtered(
                                &plugins_path,
                                plugins_dir,
                                runtime,
                                &mut installed_files,
                            )
                            .await?;
                        }
                        if userlibs_path.exists() {
                            Box::pin(self.copy_directory_recursive(&userlibs_path, userlibs_dir))
                                .await?;
                        }

                        // Also copy any DLLs directly in this runtime directory
                        let mut runtime_entries = fs::read_dir(&entry_path).await?;
                        while let Some(runtime_entry) = runtime_entries.next_entry().await? {
                            let runtime_entry_path = runtime_entry.path();
                            let runtime_file_name = runtime_entry_path
                                .file_name()
                                .and_then(|n| n.to_str())
                                .unwrap_or("");

                            if runtime_entry_path.is_file()
                                && runtime_file_name.to_lowercase().ends_with(".dll")
                            {
                                let dest_path = mods_dir.join(runtime_file_name);
                                fs::copy(&runtime_entry_path, &dest_path).await?;
                                installed_files.push(runtime_file_name.to_string());
                            }
                        }
                    }
                    continue;
                }

                // Standard structure without runtime-specific folders
                if dir_name == "mods" {
                    self.copy_directory_filtered(
                        &entry_path,
                        mods_dir,
                        runtime,
                        &mut installed_files,
                    )
                    .await?;
                } else if dir_name == "plugins" {
                    self.copy_directory_filtered(
                        &entry_path,
                        plugins_dir,
                        runtime,
                        &mut installed_files,
                    )
                    .await?;
                } else if dir_name == "userlibs" {
                    Box::pin(self.copy_directory_recursive(&entry_path, userlibs_dir)).await?;
                }
            } else if file_name.to_lowercase().ends_with(".dll") {
                // Check runtime match
                let file_runtime = self.detect_mod_runtime_from_name(file_name);
                let matches_runtime = match runtime {
                    Some(target) => file_runtime == target || file_runtime == "unknown",
                    None => true,
                };
                if matches_runtime {
                    let dest_path = mods_dir.join(file_name);
                    fs::copy(&entry_path, &dest_path).await?;
                    installed_files.push(file_name.to_string());
                }
            }
        }

        Ok(installed_files)
    }

    fn detect_mod_runtime_from_name(&self, name: &str) -> &str {
        let lower = name.to_lowercase();
        if lower.contains("mono") {
            "Mono"
        } else if lower.contains("il2cpp") {
            "IL2CPP"
        } else {
            "unknown"
        }
    }

    async fn resolve_archive_content_root(&self, temp_dir: &Path) -> Result<PathBuf> {
        let mut current = temp_dir.to_path_buf();

        for _ in 0..8 {
            let mut entries = fs::read_dir(&current).await?;
            let mut child_dirs: Vec<PathBuf> = Vec::new();
            let mut has_direct_content = false;

            while let Some(entry) = entries.next_entry().await? {
                let path = entry.path();
                let file_name = path
                    .file_name()
                    .and_then(|n| n.to_str())
                    .unwrap_or("")
                    .to_lowercase();
                let meta = entry.metadata().await?;

                if meta.is_dir() {
                    if file_name == "mods"
                        || file_name == "plugins"
                        || file_name == "userlibs"
                        || self.detect_mod_runtime_from_name(&file_name) != "unknown"
                    {
                        has_direct_content = true;
                    }
                    child_dirs.push(path);
                } else if file_name.ends_with(".dll") {
                    has_direct_content = true;
                }
            }

            if has_direct_content || child_dirs.len() != 1 {
                return Ok(current);
            }

            current = child_dirs.remove(0);
        }

        Ok(current)
    }

    /// Detects if the temp directory contains runtime-specific directories (IL2CPP, Mono)
    /// Returns (has_il2cpp_dir, has_mono_dir)
    async fn detect_runtime_directories(&self, temp_dir: &Path) -> Result<(bool, bool)> {
        let mut has_il2cpp = false;
        let mut has_mono = false;

        if let Ok(mut entries) = fs::read_dir(temp_dir).await {
            while let Some(entry) = entries.next_entry().await? {
                let path = entry.path();
                if path.is_dir() {
                    if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
                        let runtime = self.detect_mod_runtime_from_name(name);
                        if runtime == "IL2CPP" {
                            has_il2cpp = true;
                        } else if runtime == "Mono" {
                            has_mono = true;
                        }
                    }
                }
            }
        }

        Ok((has_il2cpp, has_mono))
    }

    async fn copy_directory_filtered(
        &self,
        source: &Path,
        dest: &Path,
        runtime: Option<&str>,
        installed_files: &mut Vec<String>,
    ) -> Result<()> {
        fs::create_dir_all(dest).await?;

        let mut entries = fs::read_dir(source).await?;
        while let Some(entry) = entries.next_entry().await? {
            let entry_path = entry.path();
            let file_name = entry_path
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("");

            let dest_path = dest.join(file_name);

            let metadata = fs::metadata(&entry_path).await?;
            if metadata.is_dir() {
                Box::pin(self.copy_directory_filtered(
                    &entry_path,
                    &dest_path,
                    runtime,
                    installed_files,
                ))
                .await?;
            } else if file_name.to_lowercase().ends_with(".dll") {
                let file_runtime = self.detect_mod_runtime_from_name(file_name);
                let matches_runtime = match runtime {
                    Some(target) => file_runtime == target || file_runtime == "unknown",
                    None => true,
                };
                if matches_runtime {
                    fs::copy(&entry_path, &dest_path).await?;
                    installed_files.push(file_name.to_string());
                }
            } else {
                fs::copy(&entry_path, &dest_path).await?;
            }
        }

        Ok(())
    }

    async fn copy_directory_recursive(&self, source: &Path, dest: &Path) -> Result<()> {
        fs::create_dir_all(dest).await?;

        let mut entries = fs::read_dir(source).await?;
        while let Some(entry) = entries.next_entry().await? {
            let entry_path = entry.path();
            let file_name = entry_path
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("");

            let dest_path = dest.join(file_name);

            let metadata = fs::metadata(&entry_path).await?;
            if metadata.is_dir() {
                Box::pin(self.copy_directory_recursive(&entry_path, &dest_path)).await?;
            } else {
                fs::copy(&entry_path, &dest_path).await?;
            }
        }

        Ok(())
    }

    pub async fn install_dll_mod(
        &self,
        game_dir: &str,
        dll_path: &str,
        runtime: &str,
        metadata: Option<serde_json::Value>,
    ) -> Result<serde_json::Value> {
        eprintln!("[DEBUG] install_dll_mod: Starting symlink-based installation");

        // Extract source_id and source_version for duplicate detection
        let source_id = metadata.as_ref().and_then(|m| {
            m.get("sourceId")
                .and_then(|s| s.as_str())
                .map(|s| s.to_string())
        });
        let source_version = metadata.as_ref().and_then(|m| {
            m.get("sourceVersion")
                .and_then(|s| s.as_str())
                .map(|s| s.to_string())
        });

        // Check if we already have this mod/version installed
        let existing_mod_id = self
            .find_existing_mod_installation(game_dir, &source_id, &source_version)
            .await?;

        // Use existing mod_id or generate a new one
        let mod_id = if let Some(existing_id) = existing_mod_id {
            eprintln!(
                "[DEBUG] install_dll_mod: Reusing existing installation with mod_id: {}",
                existing_id
            );
            existing_id
        } else {
            let new_id = self.generate_mod_id();
            eprintln!("[DEBUG] install_dll_mod: Generated new mod_id: {}", new_id);
            new_id
        };

        // Get mod storage directory
        let mod_storage_dir = self.get_mods_storage_dir().await?;
        let mod_storage_base = mod_storage_dir.join(&mod_id);
        let mod_storage_mods = mod_storage_base.join("Mods");
        fs::create_dir_all(&mod_storage_mods)
            .await
            .context("Failed to create mod storage directory")?;

        // Create game directory if it doesn't exist (for symlink)
        let mods_directory = self.get_mods_directory(game_dir);
        fs::create_dir_all(&mods_directory).await?;

        let source_path = Path::new(dll_path);
        let file_name = source_path
            .file_name()
            .and_then(|n| n.to_str())
            .ok_or_else(|| anyhow::anyhow!("Invalid DLL path"))?;

        if !file_name.to_lowercase().ends_with(".dll") {
            return Ok(serde_json::json!({
                "success": false,
                "error": "Only .dll files are allowed"
            }));
        }

        // Copy DLL to mod storage
        let storage_path = mod_storage_mods.join(file_name);
        fs::copy(source_path, &storage_path)
            .await
            .context("Failed to copy DLL file to storage")?;
        eprintln!(
            "[DEBUG] install_dll_mod: Copied DLL to storage: {:?}",
            storage_path
        );

        // Create symlink in game directory
        let symlink_path = mods_directory.join(file_name);

        // Remove existing symlink/file if it exists
        if self.path_exists_or_symlink(&symlink_path).await {
            if self.is_symlink(&symlink_path).await.unwrap_or(false) {
                self.remove_symlink(&symlink_path).await?;
            } else {
                fs::remove_file(&symlink_path).await?;
            }
        }

        // Create symlink from game directory to storage location
        self.create_symlink_file(&storage_path, &symlink_path)
            .await
            .context("Failed to create symlink")?;
        eprintln!(
            "[DEBUG] install_dll_mod: Created symlink: {:?} -> {:?}",
            symlink_path, storage_path
        );

        // Extract version from the storage file
        let version = self.extract_mod_version(&storage_path).await;

        // Try to get runtime from metadata first (user may have selected it)
        let metadata_runtime = metadata
            .as_ref()
            .and_then(|m| m.get("detectedRuntime").and_then(|s| s.as_str()));

        eprintln!(
            "[DEBUG] install_dll_mod: metadata_runtime = {:?}",
            metadata_runtime
        );

        // Detect runtime from metadata or file name
        let detected_runtime_str =
            metadata_runtime.unwrap_or_else(|| self.detect_mod_runtime_from_name(file_name));
        let detected_runtime = match detected_runtime_str.to_lowercase().as_str() {
            "il2cpp" => Some(crate::types::Runtime::Il2cpp),
            "mono" => Some(crate::types::Runtime::Mono),
            _ => None,
        };

        eprintln!(
            "[DEBUG] install_dll_mod: detected_runtime = {:?}",
            detected_runtime
        );

        // Detect runtime from environment
        let env_runtime = match runtime {
            "IL2CPP" => crate::types::Runtime::Il2cpp,
            "Mono" => crate::types::Runtime::Mono,
            _ => crate::types::Runtime::Mono, // Default to Mono
        };

        // Check if runtime matches
        let runtime_match = detected_runtime
            .as_ref()
            .map(|dr| match (dr, &env_runtime) {
                (crate::types::Runtime::Il2cpp, crate::types::Runtime::Il2cpp) => true,
                (crate::types::Runtime::Mono, crate::types::Runtime::Mono) => true,
                _ => false,
            });

        // Extract metadata from provided metadata if available
        let source_str = metadata
            .as_ref()
            .and_then(|m| m.get("source").and_then(|s| s.as_str()));

        let mod_source = match source_str {
            Some("thunderstore") => ModSource::Thunderstore,
            Some("nexusmods") => ModSource::Nexusmods,
            Some("github") => ModSource::Github,
            Some("unknown") => ModSource::Unknown,
            _ => ModSource::Local,
        };

        // source_id and source_version are already extracted above for duplicate detection
        let metadata_ref = metadata.as_ref();
        let source_url = Self::metadata_string(metadata_ref, "sourceUrl");
        let mod_name = Self::metadata_string(metadata_ref, "modName");
        let author = Self::metadata_string(metadata_ref, "author");
        let summary = Self::metadata_string(metadata_ref, "summary");
        let icon_url = Self::metadata_string(metadata_ref, "iconUrl");
        let icon_cache_path = self.cache_icon_from_url(icon_url.as_deref()).await;
        let downloads = Self::metadata_u64(metadata_ref, "downloads");
        let likes_or_endorsements = Self::metadata_i64(metadata_ref, "likesOrEndorsements")
            .or_else(|| Self::metadata_i64(metadata_ref, "endorsementCount"))
            .or_else(|| Self::metadata_i64(metadata_ref, "ratingScore"));
        let updated_at = Self::metadata_string(metadata_ref, "updatedAt");
        let tags = Self::metadata_tags(metadata_ref);

        // Update metadata
        let mut mod_metadata = self
            .load_mod_metadata(&mods_directory)
            .await
            .unwrap_or_else(|_| HashMap::new());

        mod_metadata.insert(
            file_name.to_string(),
            ModMetadata {
                source: Some(mod_source),
                source_id,
                source_version,
                author,
                mod_name,
                source_url,
                summary,
                icon_url,
                icon_cache_path,
                downloads,
                likes_or_endorsements,
                updated_at,
                tags,
                installed_version: version,
                library_added_at: Some(Utc::now()),
                installed_at: Some(Utc::now()),
                last_update_check: None,
                metadata_last_refreshed: Some(Utc::now()),
                update_available: None,
                remote_version: None,
                detected_runtime,
                runtime_match,
                mod_storage_id: Some(mod_id.clone()),
                symlink_paths: Some(vec![symlink_path.to_string_lossy().to_string()]),
                security_scan: metadata_ref.and_then(Self::security_scan_summary_from_metadata),
            },
        );

        self.save_mod_metadata(&mods_directory, &mod_metadata)
            .await?;

        // Also save storage metadata so the library can access runtime info
        let storage_metadata = mod_metadata.get(file_name).cloned();
        if let Some(meta) = storage_metadata {
            self.save_storage_metadata(&mod_storage_base, &meta).await?;
        }

        Ok(serde_json::json!({
            "success": true,
            "fileName": file_name,
            "storageId": mod_id
        }))
    }

    /// Clean up duplicate/unused mod storage directories
    /// Removes directories that aren't referenced by any environment's metadata
    pub async fn cleanup_duplicate_mod_storage(&self) -> Result<serde_json::Value> {
        use crate::services::environment::EnvironmentService;

        let mod_storage_dir = self.get_mods_storage_dir().await?;

        if !mod_storage_dir.exists() {
            return Ok(serde_json::json!({
                "success": true,
                "removed": 0,
                "message": "Mod storage directory does not exist"
            }));
        }

        // Get all environments
        let env_service = EnvironmentService::new(self.pool.clone())
            .context("Failed to create environment service")?;
        let environments = env_service
            .get_environments()
            .await
            .context("Failed to get environments")?;

        // Collect all mod_storage_id values that are actually in use
        let mut used_storage_ids = std::collections::HashSet::new();

        for env in &environments {
            if env.output_dir.is_empty() {
                continue;
            }

            let mods_directory = self.get_mods_directory(&env.output_dir);
            if !mods_directory.exists() {
                continue;
            }

            // Load metadata for this environment
            if let Ok(metadata) = self.load_mod_metadata(&mods_directory).await {
                for (_file_name, mod_meta) in metadata.iter() {
                    if let Some(storage_id) = &mod_meta.mod_storage_id {
                        used_storage_ids.insert(storage_id.clone());
                    }
                }
            }
        }

        eprintln!(
            "[DEBUG] cleanup_duplicate_mod_storage: Found {} storage IDs in use",
            used_storage_ids.len()
        );

        // List all directories in mod storage
        let mut removed_count = 0;
        let mut errors = Vec::new();

        let mut entries = fs::read_dir(&mod_storage_dir)
            .await
            .context("Failed to read mod storage directory")?;

        while let Some(entry) = entries.next_entry().await? {
            let entry_path = entry.path();
            let metadata = fs::metadata(&entry_path).await?;

            if metadata.is_dir() {
                if let Some(dir_name) = entry_path.file_name().and_then(|n| n.to_str()) {
                    // Check if this directory is referenced in any metadata
                    if !used_storage_ids.contains(dir_name) {
                        eprintln!("[DEBUG] cleanup_duplicate_mod_storage: Removing unused directory: {:?}", entry_path);
                        match fs::remove_dir_all(&entry_path).await {
                            Ok(_) => {
                                removed_count += 1;
                                eprintln!("[DEBUG] cleanup_duplicate_mod_storage: Successfully removed: {:?}", entry_path);
                            }
                            Err(e) => {
                                let error_msg = format!("Failed to remove {:?}: {}", entry_path, e);
                                eprintln!("[ERROR] cleanup_duplicate_mod_storage: {}", error_msg);
                                errors.push(error_msg);
                            }
                        }
                    }
                }
            }
        }

        let result = serde_json::json!({
            "success": errors.is_empty(),
            "removed": removed_count,
            "errors": errors
        });

        if !errors.is_empty() {
            eprintln!(
                "[WARN] cleanup_duplicate_mod_storage: Completed with {} errors",
                errors.len()
            );
        } else {
            eprintln!(
                "[DEBUG] cleanup_duplicate_mod_storage: Successfully removed {} unused directories",
                removed_count
            );
        }

        Ok(result)
    }

    pub async fn install_s1api(
        &self,
        game_dir: &str,
        zip_path: &str,
        runtime: &str,
        branch: &str,
        version: &str,
    ) -> Result<serde_json::Value> {
        // Prepare metadata for GitHub installation (for duplicate detection)
        let metadata = serde_json::json!({
            "source": "github",
            "sourceId": "ifBars/S1API",
            "sourceVersion": version,
            "sourceUrl": "https://github.com/ifBars/S1API",
            "modName": "S1API",
            "author": "ScheduleI-Dev",
        });

        // Install S1API using the ZIP mod installation method with metadata for duplicate detection
        let result = self
            .install_zip_mod(
                game_dir,
                zip_path,
                "S1API.zip",
                runtime,
                branch,
                Some(metadata),
            )
            .await?;

        Ok(result)
    }

    pub async fn uninstall_s1api(&self, game_dir: &str) -> Result<serde_json::Value> {
        let mods_directory = self.get_mods_directory(game_dir);
        let plugins_directory = self.get_plugins_directory(game_dir);

        let mut files_to_remove = Vec::new();

        // Check for S1API component files
        let mono_file = mods_directory.join("S1API.Mono.MelonLoader.dll");
        let il2cpp_file = mods_directory.join("S1API.IL2CPP.MelonLoader.dll");
        let mono_disabled = mods_directory.join("S1API.Mono.MelonLoader.dll.disabled");
        let il2cpp_disabled = mods_directory.join("S1API.IL2CPP.MelonLoader.dll.disabled");
        let plugin_file = plugins_directory.join("S1API.dll");

        if mono_file.exists() {
            files_to_remove.push(mono_file);
        }
        if il2cpp_file.exists() {
            files_to_remove.push(il2cpp_file);
        }
        if mono_disabled.exists() {
            files_to_remove.push(mono_disabled);
        }
        if il2cpp_disabled.exists() {
            files_to_remove.push(il2cpp_disabled);
        }
        if plugin_file.exists() {
            files_to_remove.push(plugin_file);
        }

        // Remove all files
        for file in &files_to_remove {
            let _ = fs::remove_file(file).await;
        }

        // Remove from metadata
        let mut metadata = self
            .load_mod_metadata(&mods_directory)
            .await
            .unwrap_or_else(|_| HashMap::new());
        let keys_to_remove: Vec<String> = metadata
            .keys()
            .filter(|key| self.is_s1api_component_file(key))
            .cloned()
            .collect();
        for key in keys_to_remove {
            metadata.remove(&key);
        }
        self.save_mod_metadata(&mods_directory, &metadata).await?;

        Ok(serde_json::json!({
            "success": true,
            "message": "S1API uninstalled successfully"
        }))
    }

    pub async fn get_s1api_installation_status(
        &self,
        game_dir: &str,
        runtime: &str,
    ) -> Result<serde_json::Value> {
        let mods_directory = self.get_mods_directory(game_dir);
        let plugins_directory = self.get_plugins_directory(game_dir);

        if !mods_directory.exists() {
            return Ok(serde_json::json!({
                "installed": false,
                "enabled": false
            }));
        }

        // Check for S1API component files
        let mono_file = mods_directory.join("S1API.Mono.MelonLoader.dll");
        let il2cpp_file = mods_directory.join("S1API.IL2CPP.MelonLoader.dll");
        let mono_disabled = mods_directory.join("S1API.Mono.MelonLoader.dll.disabled");
        let il2cpp_disabled = mods_directory.join("S1API.IL2CPP.MelonLoader.dll.disabled");

        // Check for S1API plugin
        let mut plugin_file: Option<String> = None;
        if plugins_directory.exists() {
            let plugin_path = plugins_directory.join("S1API.dll");
            if plugin_path.exists() {
                plugin_file = Some(plugin_path.to_string_lossy().to_string());
            }
        }

        let has_mono = mono_file.exists();
        let has_il2cpp = il2cpp_file.exists();
        let has_mono_disabled = mono_disabled.exists();
        let has_il2cpp_disabled = il2cpp_disabled.exists();
        let has_plugin = plugin_file.is_some();

        let installed =
            has_mono || has_il2cpp || has_mono_disabled || has_il2cpp_disabled || has_plugin;

        if !installed {
            return Ok(serde_json::json!({
                "installed": false,
                "enabled": false
            }));
        }

        // Determine if enabled based on runtime
        let enabled = match runtime {
            "Mono" => has_mono && !has_il2cpp,
            "IL2CPP" => has_il2cpp && !has_mono,
            _ => has_mono || has_il2cpp,
        };

        // Try to extract version from metadata or DLL
        let mut version: Option<String> = None;
        let metadata = self
            .load_mod_metadata(&mods_directory)
            .await
            .unwrap_or_else(|_| HashMap::new());

        let runtime_lower = runtime.to_lowercase();
        let mut runtime_match: Option<&ModMetadata> = None;
        for (file_name, meta) in metadata.iter() {
            let lower_name = file_name.to_lowercase();
            if !self.is_s1api_component_file(&lower_name) {
                continue;
            }
            if runtime_lower == "mono" && lower_name.contains("mono") {
                runtime_match = Some(meta);
                break;
            }
            if runtime_lower == "il2cpp" && lower_name.contains("il2cpp") {
                runtime_match = Some(meta);
                break;
            }
            if runtime_match.is_none() {
                runtime_match = Some(meta);
            }
        }

        if let Some(meta) = runtime_match {
            // Check installed_version first, then fall back to source_version
            version = meta
                .installed_version
                .clone()
                .or_else(|| meta.source_version.clone());
        }

        if version.is_none() && enabled {
            if runtime == "Mono" && has_mono {
                version = self.extract_mod_version(&mono_file).await;
            } else if runtime == "IL2CPP" && has_il2cpp {
                version = self.extract_mod_version(&il2cpp_file).await;
            } else if has_mono {
                version = self.extract_mod_version(&mono_file).await;
            } else if has_il2cpp {
                version = self.extract_mod_version(&il2cpp_file).await;
            }
        }

        Ok(serde_json::json!({
            "installed": true,
            "enabled": enabled,
            "version": version,
            "monoFile": if has_mono || has_mono_disabled {
                Some(if has_mono { mono_file.to_string_lossy().to_string() } else { mono_disabled.to_string_lossy().to_string() })
            } else { None },
            "il2cppFile": if has_il2cpp || has_il2cpp_disabled {
                Some(if has_il2cpp { il2cpp_file.to_string_lossy().to_string() } else { il2cpp_disabled.to_string_lossy().to_string() })
            } else { None },
            "pluginFile": plugin_file
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::initialize_pool;
    use crate::services::environment::EnvironmentService;
    use crate::services::settings::SettingsService;
    use crate::types::{
        schedule_i_config, ModMetadata, ModSource, Runtime, SecurityScanDisposition,
        SecurityScanDispositionClassification, SecurityScanFileReport, SecurityScanPolicy,
        SecurityScanReport, SecurityScanState, SecurityScanSummary,
    };
    use serial_test::serial;
    use std::fs::File;
    use std::io::Write;
    use tempfile::tempdir;
    use tokio::fs;
    use zip::write::FileOptions;
    use zip::ZipWriter;

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
    fn parse_storage_metadata_compat_uses_alias_when_primary_is_invalid() {
        let raw = serde_json::json!({
            "iconUrl": null,
            "pictureUrl": "https://example.com/alias.png",
            "downloads": "",
            "modDownloads": 42
        });

        let parsed = ModsService::parse_storage_metadata_compat(&raw)
            .expect("metadata should parse with valid aliases");

        assert_eq!(
            parsed.icon_url.as_deref(),
            Some("https://example.com/alias.png")
        );
        assert_eq!(parsed.downloads, Some(42));
    }

    #[tokio::test]
    #[serial]
    async fn remove_icon_cache_if_orphaned_skips_paths_outside_cache_dir() -> Result<()> {
        let temp = tempdir()?;
        let data_dir = temp.path().join("simmrust");
        let _guard = EnvVarGuard::set("SIMMRUST_DATA_DIR", data_dir.to_string_lossy().as_ref());
        let pool = initialize_pool().await?;
        let service = ModsService::new(pool);

        let outside_file = temp.path().join("outside-icon.png");
        fs::write(&outside_file, b"icon-bytes").await?;

        service
            .remove_icon_cache_if_orphaned(
                Some(outside_file.to_string_lossy().as_ref()),
                "storage-1",
            )
            .await?;

        assert!(outside_file.exists(), "outside file should not be deleted");
        Ok(())
    }
    fn sample_metadata(
        storage_id: Option<&str>,
        source_id: Option<&str>,
        source_version: Option<&str>,
    ) -> ModMetadata {
        ModMetadata {
            source: Some(ModSource::Local),
            source_id: source_id.map(|s| s.to_string()),
            source_version: source_version.map(|s| s.to_string()),
            author: None,
            mod_name: Some("Example".to_string()),
            source_url: None,
            summary: None,
            icon_url: None,
            icon_cache_path: None,
            downloads: None,
            likes_or_endorsements: None,
            updated_at: None,
            tags: None,
            installed_version: None,
            library_added_at: None,
            installed_at: None,
            last_update_check: None,
            metadata_last_refreshed: None,
            update_available: None,
            remote_version: None,
            detected_runtime: None,
            runtime_match: None,
            mod_storage_id: storage_id.map(|s| s.to_string()),
            symlink_paths: None,
            security_scan: None,
        }
    }

    #[tokio::test]
    #[serial]
    async fn load_mod_metadata_falls_back_to_file() -> Result<()> {
        let temp = tempdir()?;
        let data_dir = temp.path().join("simmrust");
        let _guard = EnvVarGuard::set("SIMMRUST_DATA_DIR", data_dir.to_string_lossy().as_ref());
        let pool = initialize_pool().await?;
        let service = ModsService::new(pool);

        let game_dir = temp.path().join("game");
        let mods_dir = game_dir.join("Mods");
        fs::create_dir_all(&mods_dir).await?;

        let mut metadata = HashMap::new();
        metadata.insert(
            "Example.dll".to_string(),
            sample_metadata(Some("storage-1"), Some("local"), Some("1.0.0")),
        );
        fs::write(
            mods_dir.join(".mods-metadata.json"),
            serde_json::to_string(&metadata)?,
        )
        .await?;

        let loaded = service.load_mod_metadata(&mods_dir).await?;
        assert!(loaded.contains_key("Example.dll"));

        Ok(())
    }

    #[tokio::test]
    #[serial]
    async fn load_mod_metadata_recovers_storage_metadata_when_db_is_empty() -> Result<()> {
        let temp = tempdir()?;
        let data_dir = temp.path().join("simmrust");
        let _guard = EnvVarGuard::set("SIMMRUST_DATA_DIR", data_dir.to_string_lossy().as_ref());
        let pool = initialize_pool().await?;
        let env_service = EnvironmentService::new(pool.clone())?;
        let service = ModsService::new(pool.clone());

        let download_dir = temp.path().join("downloads");
        let mut settings_service = SettingsService::new(pool.clone())?;
        settings_service
            .save_settings(serde_json::json!({
                "defaultDownloadDir": download_dir.to_string_lossy().to_string()
            }))
            .await?;

        let output_dir = temp.path().join("envs").join("env-storage-recovery");
        let _env = env_service
            .create_environment(
                schedule_i_config().app_id,
                "main".to_string(),
                output_dir.to_string_lossy().to_string(),
                None,
                None,
            )
            .await?;

        let storage_id = "storage-recovery-1";
        let storage_base = download_dir.join("Mods").join(storage_id);
        let storage_mods = storage_base.join("Mods");
        fs::create_dir_all(&storage_mods).await?;
        fs::write(storage_mods.join("RecoveredManaged.dll"), b"managed-bytes").await?;

        let mut storage_meta =
            sample_metadata(Some(storage_id), Some("owner/recovered"), Some("1.0.0"));
        storage_meta.source = Some(ModSource::Thunderstore);
        storage_meta.mod_name = Some("Recovered Managed".to_string());
        storage_meta.icon_url = Some("https://example.com/icon.png".to_string());
        storage_meta.summary = Some("Recovered metadata from storage".to_string());
        service
            .save_storage_metadata(&storage_base, &storage_meta)
            .await?;

        let mods_dir = output_dir.join("Mods");
        fs::create_dir_all(&mods_dir).await?;
        fs::write(mods_dir.join("RecoveredManaged.dll"), b"managed-bytes").await?;

        let loaded = service.load_mod_metadata(&mods_dir).await?;
        let recovered = loaded
            .get("RecoveredManaged.dll")
            .expect("recovered metadata entry");

        assert_eq!(recovered.mod_storage_id.as_deref(), Some(storage_id));
        assert_eq!(recovered.source_id.as_deref(), Some("owner/recovered"));
        assert!(matches!(recovered.source, Some(ModSource::Thunderstore)));
        assert_eq!(
            recovered.icon_url.as_deref(),
            Some("https://example.com/icon.png")
        );

        Ok(())
    }

    #[tokio::test]
    #[serial]
    async fn list_mods_uses_metadata_values() -> Result<()> {
        let temp = tempdir()?;
        let data_dir = temp.path().join("simmrust");
        let _guard = EnvVarGuard::set("SIMMRUST_DATA_DIR", data_dir.to_string_lossy().as_ref());
        let pool = initialize_pool().await?;
        let env_service = EnvironmentService::new(pool.clone())?;
        let service = ModsService::new(pool.clone());

        let output_dir = temp.path().join("envs").join("env-1");
        let _env = env_service
            .create_environment(
                schedule_i_config().app_id,
                "main".to_string(),
                output_dir.to_string_lossy().to_string(),
                None,
                None,
            )
            .await?;

        let mods_dir = output_dir.join("Mods");
        fs::create_dir_all(&mods_dir).await?;
        fs::write(mods_dir.join("Example.dll"), b"data").await?;

        let mut metadata = HashMap::new();
        metadata.insert(
            "Example.dll".to_string(),
            sample_metadata(None, Some("local"), Some("1.2.3")),
        );
        service.save_mod_metadata(&mods_dir, &metadata).await?;

        let result = service
            .list_mods(output_dir.to_string_lossy().as_ref())
            .await?;
        let count = result.get("count").and_then(|v| v.as_u64()).unwrap_or(0);
        assert_eq!(count, 1);

        let mods = result
            .get("mods")
            .and_then(|v| v.as_array())
            .expect("mods array");
        let entry = mods.first().expect("mod entry");
        assert_eq!(
            entry.get("fileName").and_then(|v| v.as_str()),
            Some("Example.dll")
        );
        assert_eq!(entry.get("version").and_then(|v| v.as_str()), Some("1.2.3"));
        assert_eq!(entry.get("managed").and_then(|v| v.as_bool()), Some(false));

        Ok(())
    }

    #[tokio::test]
    #[serial]
    async fn list_mods_marks_recovered_storage_entries_as_managed() -> Result<()> {
        let temp = tempdir()?;
        let data_dir = temp.path().join("simmrust");
        let _guard = EnvVarGuard::set("SIMMRUST_DATA_DIR", data_dir.to_string_lossy().as_ref());
        let pool = initialize_pool().await?;
        let env_service = EnvironmentService::new(pool.clone())?;
        let service = ModsService::new(pool.clone());

        let download_dir = temp.path().join("downloads");
        let mut settings_service = SettingsService::new(pool.clone())?;
        settings_service
            .save_settings(serde_json::json!({
                "defaultDownloadDir": download_dir.to_string_lossy().to_string()
            }))
            .await?;

        let output_dir = temp.path().join("envs").join("env-managed-recovery");
        let _env = env_service
            .create_environment(
                schedule_i_config().app_id,
                "main".to_string(),
                output_dir.to_string_lossy().to_string(),
                None,
                None,
            )
            .await?;

        let storage_id = "storage-managed-recovery";
        let storage_base = download_dir.join("Mods").join(storage_id);
        let storage_mods = storage_base.join("Mods");
        fs::create_dir_all(&storage_mods).await?;
        fs::write(storage_mods.join("RecoveredManaged.dll"), b"managed-bytes").await?;

        let mut storage_meta =
            sample_metadata(Some(storage_id), Some("owner/recovered"), Some("1.0.0"));
        storage_meta.source = Some(ModSource::Thunderstore);
        storage_meta.mod_name = Some("Recovered Managed".to_string());
        service
            .save_storage_metadata(&storage_base, &storage_meta)
            .await?;

        let mods_dir = output_dir.join("Mods");
        fs::create_dir_all(&mods_dir).await?;
        fs::write(mods_dir.join("RecoveredManaged.dll"), b"managed-bytes").await?;

        let result = service
            .list_mods(output_dir.to_string_lossy().as_ref())
            .await?;
        let mods = result
            .get("mods")
            .and_then(|value| value.as_array())
            .expect("mods array");

        let entry = mods
            .iter()
            .find(|item| {
                item.get("fileName").and_then(|value| value.as_str())
                    == Some("RecoveredManaged.dll")
            })
            .expect("recovered managed mod");

        assert_eq!(
            entry.get("managed").and_then(|value| value.as_bool()),
            Some(true)
        );
        assert_eq!(
            entry.get("source").and_then(|value| value.as_str()),
            Some("thunderstore")
        );

        Ok(())
    }

    #[tokio::test]
    #[serial]
    async fn reconcile_tracked_mod_state_removes_missing_env_entries() -> Result<()> {
        let temp = tempdir()?;
        let data_dir = temp.path().join("simmrust");
        let _guard = EnvVarGuard::set("SIMMRUST_DATA_DIR", data_dir.to_string_lossy().as_ref());
        let pool = initialize_pool().await?;
        let env_service = EnvironmentService::new(pool.clone())?;
        let service = ModsService::new(pool.clone());

        let output_dir = temp.path().join("envs").join("env-stale");
        let env = env_service
            .create_environment(
                schedule_i_config().app_id,
                "main".to_string(),
                output_dir.to_string_lossy().to_string(),
                None,
                None,
            )
            .await?;

        let mods_dir = output_dir.join("Mods");
        fs::create_dir_all(&mods_dir).await?;

        let mut metadata = HashMap::new();
        metadata.insert(
            "Ghost.dll".to_string(),
            sample_metadata(None, Some("ghost"), Some("1.0.0")),
        );
        service.save_mod_metadata(&mods_dir, &metadata).await?;

        let affected = service.reconcile_tracked_mod_state().await?;
        assert_eq!(affected, vec![env.id.clone()]);

        let loaded = service.load_mod_metadata(&mods_dir).await?;
        assert!(loaded.is_empty());

        Ok(())
    }

    #[tokio::test]
    #[serial]
    async fn reconcile_tracked_mod_state_removes_broken_storage_references_across_envs(
    ) -> Result<()> {
        let temp = tempdir()?;
        let data_dir = temp.path().join("simmrust");
        let _guard = EnvVarGuard::set("SIMMRUST_DATA_DIR", data_dir.to_string_lossy().as_ref());
        let pool = initialize_pool().await?;
        let env_service = EnvironmentService::new(pool.clone())?;
        let service = ModsService::new(pool.clone());

        let download_dir = temp.path().join("downloads");
        let mut settings_service = SettingsService::new(pool.clone())?;
        settings_service
            .save_settings(serde_json::json!({
                "defaultDownloadDir": download_dir.to_string_lossy().to_string()
            }))
            .await?;

        let output_a = temp.path().join("envs").join("env-a");
        let output_b = temp.path().join("envs").join("env-b");
        let env_a = env_service
            .create_environment(
                schedule_i_config().app_id,
                "main".to_string(),
                output_a.to_string_lossy().to_string(),
                None,
                None,
            )
            .await?;
        let env_b = env_service
            .create_environment(
                schedule_i_config().app_id,
                "beta".to_string(),
                output_b.to_string_lossy().to_string(),
                None,
                None,
            )
            .await?;

        let mods_a = output_a.join("Mods");
        let mods_b = output_b.join("Mods");
        fs::create_dir_all(&mods_a).await?;
        fs::create_dir_all(&mods_b).await?;
        fs::write(mods_a.join("Shared.dll"), b"data").await?;
        fs::write(mods_b.join("Shared.dll"), b"data").await?;

        let mut meta_a = HashMap::new();
        meta_a.insert(
            "Shared.dll".to_string(),
            sample_metadata(Some("storage-broken"), Some("shared"), Some("1.0.0")),
        );
        let mut meta_b = HashMap::new();
        meta_b.insert(
            "Shared.dll".to_string(),
            sample_metadata(Some("storage-broken"), Some("shared"), Some("1.0.0")),
        );
        service.save_mod_metadata(&mods_a, &meta_a).await?;
        service.save_mod_metadata(&mods_b, &meta_b).await?;

        let broken_storage_mods = service
            .get_mods_storage_dir()
            .await?
            .join("storage-broken")
            .join("Mods");
        fs::create_dir_all(&broken_storage_mods).await?;
        fs::write(broken_storage_mods.join("Different.dll"), b"data").await?;

        let mut affected = service.reconcile_tracked_mod_state().await?;
        affected.sort();

        let mut expected = vec![env_a.id.clone(), env_b.id.clone()];
        expected.sort();
        assert_eq!(affected, expected);

        let loaded_a = service.load_mod_metadata(&mods_a).await?;
        let loaded_b = service.load_mod_metadata(&mods_b).await?;
        assert!(loaded_a.is_empty());
        assert!(loaded_b.is_empty());

        Ok(())
    }

    #[tokio::test]
    #[serial]
    async fn list_mods_includes_s1api_in_normal_listing() -> Result<()> {
        let temp = tempdir()?;
        let data_dir = temp.path().join("simmrust");
        let _guard = EnvVarGuard::set("SIMMRUST_DATA_DIR", data_dir.to_string_lossy().as_ref());
        let pool = initialize_pool().await?;
        let env_service = EnvironmentService::new(pool.clone())?;
        let service = ModsService::new(pool.clone());

        let output_dir = temp.path().join("envs").join("env-s1api");
        let _env = env_service
            .create_environment(
                schedule_i_config().app_id,
                "main".to_string(),
                output_dir.to_string_lossy().to_string(),
                None,
                None,
            )
            .await?;

        let mods_dir = output_dir.join("Mods");
        fs::create_dir_all(&mods_dir).await?;
        fs::write(mods_dir.join("S1API.Mono.MelonLoader.dll"), b"data").await?;

        let result = service
            .list_mods(output_dir.to_string_lossy().as_ref())
            .await?;
        let count = result.get("count").and_then(|v| v.as_u64()).unwrap_or(0);
        assert_eq!(count, 1);

        let mods = result
            .get("mods")
            .and_then(|v| v.as_array())
            .expect("mods array");
        assert_eq!(mods.len(), 1);
        assert_eq!(
            mods[0].get("fileName").and_then(|v| v.as_str()),
            Some("S1API.Mono.MelonLoader.dll")
        );

        Ok(())
    }

    #[tokio::test]
    #[serial]
    async fn count_mods_includes_s1api() -> Result<()> {
        let temp = tempdir()?;
        let data_dir = temp.path().join("simmrust");
        let _guard = EnvVarGuard::set("SIMMRUST_DATA_DIR", data_dir.to_string_lossy().as_ref());
        let pool = initialize_pool().await?;
        let env_service = EnvironmentService::new(pool.clone())?;
        let service = ModsService::new(pool.clone());

        let output_dir = temp.path().join("envs").join("env-2");
        let _env = env_service
            .create_environment(
                schedule_i_config().app_id,
                "main".to_string(),
                output_dir.to_string_lossy().to_string(),
                None,
                None,
            )
            .await?;

        let mods_dir = output_dir.join("Mods");
        fs::create_dir_all(&mods_dir).await?;
        fs::write(mods_dir.join("Example.dll"), b"data").await?;
        fs::write(mods_dir.join("S1API.Mono.MelonLoader.dll"), b"data").await?;

        let mut metadata = HashMap::new();
        metadata.insert(
            "Example.dll".to_string(),
            sample_metadata(None, None, Some("1.0.0")),
        );
        service.save_mod_metadata(&mods_dir, &metadata).await?;

        let count = service
            .count_mods(output_dir.to_string_lossy().as_ref())
            .await?;
        assert_eq!(count, 2);

        Ok(())
    }

    #[tokio::test]
    #[serial]
    async fn count_mods_includes_multiple_s1api_component_files() -> Result<()> {
        let temp = tempdir()?;
        let data_dir = temp.path().join("simmrust");
        let _guard = EnvVarGuard::set("SIMMRUST_DATA_DIR", data_dir.to_string_lossy().as_ref());
        let pool = initialize_pool().await?;
        let env_service = EnvironmentService::new(pool.clone())?;
        let service = ModsService::new(pool.clone());

        let output_dir = temp.path().join("envs").join("env-2b");
        let _env = env_service
            .create_environment(
                schedule_i_config().app_id,
                "main".to_string(),
                output_dir.to_string_lossy().to_string(),
                None,
                None,
            )
            .await?;

        let mods_dir = output_dir.join("Mods");
        fs::create_dir_all(&mods_dir).await?;
        fs::write(mods_dir.join("S1API.Mono.MelonLoader.dll"), b"data").await?;
        fs::write(mods_dir.join("S1API.IL2CPP.MelonLoader.dll"), b"data").await?;

        let count = service
            .count_mods(output_dir.to_string_lossy().as_ref())
            .await?;
        assert_eq!(count, 2);

        Ok(())
    }

    #[tokio::test]
    async fn disable_and_enable_mod_renames_files() -> Result<()> {
        let temp = tempdir()?;
        let service = ModsService::new(Arc::new(SqlitePool::connect_lazy("sqlite::memory:")?));

        let mods_dir = temp.path().join("Mods");
        fs::create_dir_all(&mods_dir).await?;
        let mod_path = mods_dir.join("Example.dll");
        fs::write(&mod_path, b"data").await?;

        service
            .disable_mod(temp.path().to_string_lossy().as_ref(), "Example.dll")
            .await?;
        assert!(!mod_path.exists());
        assert!(mods_dir.join("Example.dll.disabled").exists());

        service
            .enable_mod(temp.path().to_string_lossy().as_ref(), "Example.dll")
            .await?;
        assert!(mod_path.exists());
        assert!(!mods_dir.join("Example.dll.disabled").exists());

        Ok(())
    }

    #[tokio::test]
    #[serial]
    async fn delete_mod_removes_file_and_metadata() -> Result<()> {
        let temp = tempdir()?;
        let data_dir = temp.path().join("simmrust");
        let _guard = EnvVarGuard::set("SIMMRUST_DATA_DIR", data_dir.to_string_lossy().as_ref());
        let pool = initialize_pool().await?;
        let env_service = EnvironmentService::new(pool.clone())?;
        let service = ModsService::new(pool.clone());

        let output_dir = temp.path().join("envs").join("env-3");
        let env = env_service
            .create_environment(
                schedule_i_config().app_id,
                "main".to_string(),
                output_dir.to_string_lossy().to_string(),
                None,
                None,
            )
            .await?;

        let mods_dir = output_dir.join("Mods");
        fs::create_dir_all(&mods_dir).await?;
        fs::write(mods_dir.join("Example.dll"), b"data").await?;

        let mut metadata = HashMap::new();
        metadata.insert(
            "Example.dll".to_string(),
            sample_metadata(None, None, Some("1.0.0")),
        );
        service.save_mod_metadata(&mods_dir, &metadata).await?;

        service
            .delete_mod(output_dir.to_string_lossy().as_ref(), "Example.dll")
            .await?;

        assert!(!mods_dir.join("Example.dll").exists());

        let count: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM mod_metadata WHERE environment_id = ?")
                .bind(&env.id)
                .fetch_one(&*pool)
                .await?;
        assert_eq!(count, 0);

        Ok(())
    }

    #[tokio::test]
    #[serial]
    async fn find_existing_mod_storage_by_source_version_finds_match() -> Result<()> {
        let temp = tempdir()?;
        let data_dir = temp.path().join("simmrust");
        let _guard = EnvVarGuard::set("SIMMRUST_DATA_DIR", data_dir.to_string_lossy().as_ref());
        let pool = initialize_pool().await?;
        let env_service = EnvironmentService::new(pool.clone())?;
        let service = ModsService::new(pool.clone());

        let download_dir = temp.path().join("downloads");
        let mut settings_service = SettingsService::new(pool.clone())?;
        settings_service
            .save_settings(serde_json::json!({
                "defaultDownloadDir": download_dir.to_string_lossy().to_string()
            }))
            .await?;

        let output_dir = temp.path().join("envs").join("env-4");
        let env = env_service
            .create_environment(
                schedule_i_config().app_id,
                "main".to_string(),
                output_dir.to_string_lossy().to_string(),
                None,
                None,
            )
            .await?;

        let metadata = sample_metadata(Some("storage-1"), Some("source-id"), Some("1.0.0"));
        let serialized = serde_json::to_string(&metadata)?;
        sqlx::query(
            "INSERT INTO mod_metadata (environment_id, kind, file_name, data) VALUES (?, 'mods', ?, ?)",
        )
        .bind(&env.id)
        .bind("Example.dll")
        .bind(serialized)
        .execute(&*pool)
        .await?;

        let storage_mods_dir = download_dir.join("Mods").join("storage-1").join("Mods");
        fs::create_dir_all(&storage_mods_dir).await?;
        fs::write(storage_mods_dir.join("Example.dll"), b"data").await?;

        let found = service
            .find_existing_mod_storage_by_source_version("source-id", "1.0.0", None)
            .await?;
        assert_eq!(found.as_deref(), Some("storage-1"));

        Ok(())
    }

    #[tokio::test]
    async fn detect_mod_runtime_from_name_parses_keywords() -> Result<()> {
        let service = ModsService::new(Arc::new(SqlitePool::connect_lazy("sqlite::memory:")?));

        assert_eq!(
            service.detect_mod_runtime_from_name("Example.Mono.dll"),
            "Mono"
        );
        assert_eq!(
            service.detect_mod_runtime_from_name("Example.IL2CPP.dll"),
            "IL2CPP"
        );
        assert_eq!(
            service.detect_mod_runtime_from_name("Example.dll"),
            "unknown"
        );

        Ok(())
    }

    #[tokio::test]
    async fn detect_runtime_directories_finds_runtime_dirs() -> Result<()> {
        let temp = tempdir()?;
        let il2cpp_dir = temp.path().join("IL2CPP");
        let mono_dir = temp.path().join("Mono");
        fs::create_dir_all(&il2cpp_dir).await?;
        fs::create_dir_all(&mono_dir).await?;

        let service = ModsService::new(Arc::new(SqlitePool::connect_lazy("sqlite::memory:")?));
        let (has_il2cpp, has_mono) = service.detect_runtime_directories(temp.path()).await?;
        assert!(has_il2cpp);
        assert!(has_mono);

        Ok(())
    }

    #[tokio::test]
    async fn resolve_archive_content_root_unwraps_single_top_level_wrapper() -> Result<()> {
        let temp = tempdir()?;
        let wrapper = temp.path().join("WrappedPackage");
        let il2cpp_dir = wrapper.join("IL2CPP");
        let mono_dir = wrapper.join("Mono");
        fs::create_dir_all(&il2cpp_dir).await?;
        fs::create_dir_all(&mono_dir).await?;
        fs::write(temp.path().join("README.txt"), b"wrapper readme").await?;

        let service = ModsService::new(Arc::new(SqlitePool::connect_lazy("sqlite::memory:")?));
        let root = service.resolve_archive_content_root(temp.path()).await?;

        assert_eq!(root, wrapper);
        let (has_il2cpp, has_mono) = service.detect_runtime_directories(&root).await?;
        assert!(has_il2cpp);
        assert!(has_mono);

        Ok(())
    }

    #[tokio::test]
    async fn extract_thunderstore_manifest_parses_manifest() -> Result<()> {
        let temp = tempdir()?;
        let zip_path = temp.path().join("mod.zip");
        let manifest = serde_json::json!({
            "name": "Example",
            "version_number": "1.0.0",
            "author": "Tester"
        });

        let file = File::create(&zip_path)?;
        let mut zip = ZipWriter::new(file);
        zip.start_file("manifest.json", FileOptions::default())?;
        zip.write_all(serde_json::to_string(&manifest)?.as_bytes())?;
        zip.finish()?;

        let service = ModsService::new(Arc::new(SqlitePool::connect_lazy("sqlite::memory:")?));
        let parsed = service
            .extract_thunderstore_manifest(&zip_path)
            .expect("manifest parsed");
        assert_eq!(parsed.get("name").and_then(|v| v.as_str()), Some("Example"));

        Ok(())
    }

    #[tokio::test]
    #[serial]
    async fn install_zip_mod_invalid_zip_returns_error() -> Result<()> {
        let temp = tempdir()?;
        let data_dir = temp.path().join("simmrust");
        let _data_guard =
            EnvVarGuard::set("SIMMRUST_DATA_DIR", data_dir.to_string_lossy().as_ref());
        let _home_guard =
            EnvVarGuard::set("SIMMRUST_HOME_DIR", temp.path().to_string_lossy().as_ref());
        let pool = initialize_pool().await?;
        let service = ModsService::new(pool);

        let game_dir = temp.path().join("game");
        fs::create_dir_all(&game_dir).await?;
        let zip_path = temp.path().join("invalid.zip");
        fs::write(&zip_path, b"not a zip").await?;

        let result = service
            .install_zip_mod(
                game_dir.to_string_lossy().as_ref(),
                zip_path.to_string_lossy().as_ref(),
                "invalid.zip",
                "IL2CPP",
                "main",
                None,
            )
            .await?;
        assert_eq!(result.get("success").and_then(|v| v.as_bool()), Some(false));
        assert!(result
            .get("error")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .contains("zip"));

        Ok(())
    }

    #[tokio::test]
    #[serial]
    async fn install_dll_mod_persists_selected_runtime_to_storage_metadata() -> Result<()> {
        let temp = tempdir()?;
        let data_dir = temp.path().join("simmrust");
        let _data_guard =
            EnvVarGuard::set("SIMMRUST_DATA_DIR", data_dir.to_string_lossy().as_ref());
        let _home_guard =
            EnvVarGuard::set("SIMMRUST_HOME_DIR", temp.path().to_string_lossy().as_ref());
        let pool = initialize_pool().await?;
        let env_service = EnvironmentService::new(pool.clone())?;
        let service = ModsService::new(pool.clone());

        let download_dir = temp.path().join("downloads");
        let mut settings_service = SettingsService::new(pool.clone())?;
        settings_service
            .save_settings(serde_json::json!({
                "defaultDownloadDir": download_dir.to_string_lossy().to_string()
            }))
            .await?;

        let output_dir = temp.path().join("envs").join("env-runtime-dll");
        let _env = env_service
            .create_environment(
                schedule_i_config().app_id,
                "main".to_string(),
                output_dir.to_string_lossy().to_string(),
                None,
                None,
            )
            .await?;

        let source_dll = temp.path().join("MonoOnly.dll");
        fs::write(&source_dll, b"not-a-real-dotnet-assembly").await?;

        let result = service
            .install_dll_mod(
                output_dir.to_string_lossy().as_ref(),
                source_dll.to_string_lossy().as_ref(),
                "IL2CPP",
                Some(serde_json::json!({
                    "source": "unknown",
                    "detectedRuntime": "Mono"
                })),
            )
            .await?;

        assert_eq!(result.get("success").and_then(|v| v.as_bool()), Some(true));

        let mods_dir = output_dir.join("Mods");
        let metadata = service.load_mod_metadata(&mods_dir).await?;
        let env_meta = metadata.get("MonoOnly.dll").expect("env metadata entry");
        assert!(matches!(env_meta.detected_runtime, Some(Runtime::Mono)));
        assert_eq!(env_meta.runtime_match, Some(false));

        let storage_id = env_meta
            .mod_storage_id
            .clone()
            .expect("storage id should be present");
        let storage_dir = download_dir.join("Mods").join(storage_id);
        let storage_meta = service
            .load_storage_metadata(&storage_dir)
            .await?
            .expect("storage metadata should exist");

        assert!(matches!(storage_meta.detected_runtime, Some(Runtime::Mono)));
        assert_eq!(storage_meta.runtime_match, Some(false));

        Ok(())
    }

    #[tokio::test]
    #[serial]
    async fn install_zip_mod_persists_selected_runtime_to_storage_metadata() -> Result<()> {
        let temp = tempdir()?;
        let data_dir = temp.path().join("simmrust");
        let _data_guard =
            EnvVarGuard::set("SIMMRUST_DATA_DIR", data_dir.to_string_lossy().as_ref());
        let _home_guard =
            EnvVarGuard::set("SIMMRUST_HOME_DIR", temp.path().to_string_lossy().as_ref());
        let pool = initialize_pool().await?;
        let env_service = EnvironmentService::new(pool.clone())?;
        let service = ModsService::new(pool.clone());

        let download_dir = temp.path().join("downloads");
        let mut settings_service = SettingsService::new(pool.clone())?;
        settings_service
            .save_settings(serde_json::json!({
                "defaultDownloadDir": download_dir.to_string_lossy().to_string()
            }))
            .await?;

        let output_dir = temp.path().join("envs").join("env-runtime-zip");
        let _env = env_service
            .create_environment(
                schedule_i_config().app_id,
                "main".to_string(),
                output_dir.to_string_lossy().to_string(),
                None,
                None,
            )
            .await?;

        let zip_path = temp.path().join("AmbiguousMod.zip");
        let file = File::create(&zip_path)?;
        let mut zip = ZipWriter::new(file);
        zip.start_file("AmbiguousMod.dll", FileOptions::default())?;
        zip.write_all(b"not-a-real-dotnet-assembly")?;
        zip.finish()?;

        let result = service
            .install_zip_mod(
                output_dir.to_string_lossy().as_ref(),
                zip_path.to_string_lossy().as_ref(),
                "AmbiguousMod.zip",
                "IL2CPP",
                "main",
                Some(serde_json::json!({
                    "source": "unknown",
                    "detectedRuntime": "Mono"
                })),
            )
            .await?;

        assert_eq!(result.get("success").and_then(|v| v.as_bool()), Some(true));

        let mods_dir = output_dir.join("Mods");
        let metadata = service.load_mod_metadata(&mods_dir).await?;
        let env_meta = metadata
            .get("AmbiguousMod.dll")
            .expect("env metadata entry for zip install");
        assert!(matches!(env_meta.detected_runtime, Some(Runtime::Mono)));
        assert_eq!(env_meta.runtime_match, Some(false));

        let storage_id = env_meta
            .mod_storage_id
            .clone()
            .expect("storage id should be present");
        let storage_dir = download_dir.join("Mods").join(storage_id);
        let storage_meta = service
            .load_storage_metadata(&storage_dir)
            .await?
            .expect("storage metadata should exist");

        assert!(matches!(storage_meta.detected_runtime, Some(Runtime::Mono)));
        assert_eq!(storage_meta.runtime_match, Some(false));

        Ok(())
    }

    #[tokio::test]
    #[serial]
    async fn get_mod_library_uses_storage_metadata_runtime_for_ambiguous_files() -> Result<()> {
        let temp = tempdir()?;
        let data_dir = temp.path().join("simmrust");
        let _data_guard =
            EnvVarGuard::set("SIMMRUST_DATA_DIR", data_dir.to_string_lossy().as_ref());
        let pool = initialize_pool().await?;
        let env_service = EnvironmentService::new(pool.clone())?;
        let service = ModsService::new(pool.clone());

        let download_dir = temp.path().join("downloads");
        let mut settings_service = SettingsService::new(pool.clone())?;
        settings_service
            .save_settings(serde_json::json!({
                "defaultDownloadDir": download_dir.to_string_lossy().to_string()
            }))
            .await?;

        let output_dir = temp.path().join("envs").join("env-library-runtime");
        let _env = env_service
            .create_environment(
                schedule_i_config().app_id,
                "main".to_string(),
                output_dir.to_string_lossy().to_string(),
                None,
                None,
            )
            .await?;

        let mods_dir = output_dir.join("Mods");
        fs::create_dir_all(&mods_dir).await?;
        fs::write(mods_dir.join("AmbiguousMod.dll"), b"data").await?;

        let storage_id = "storage-runtime-projection";
        let mut env_meta = sample_metadata(Some(storage_id), Some("example/source"), Some("1.0.0"));
        env_meta.mod_name = Some("Ambiguous Mod".to_string());
        env_meta.detected_runtime = None;

        let mut env_metadata = HashMap::new();
        env_metadata.insert("AmbiguousMod.dll".to_string(), env_meta.clone());
        service.save_mod_metadata(&mods_dir, &env_metadata).await?;

        let storage_base = download_dir.join("Mods").join(storage_id);
        let storage_mods = storage_base.join("Mods");
        fs::create_dir_all(&storage_mods).await?;
        fs::write(storage_mods.join("AmbiguousMod.dll"), b"data").await?;

        let mut storage_meta = env_meta;
        storage_meta.detected_runtime = Some(Runtime::Mono);
        storage_meta.runtime_match = Some(false);
        service
            .save_storage_metadata(&storage_base, &storage_meta)
            .await?;

        let library = service.get_mod_library().await?;
        let entry = library
            .downloaded
            .iter()
            .find(|item| item.storage_id == storage_id)
            .expect("library entry for storage id");

        assert_eq!(entry.available_runtimes.len(), 1);
        assert_eq!(entry.available_runtimes[0], "Mono");
        assert!(entry.files_by_runtime.contains_key("Mono"));
        assert!(!entry.files_by_runtime.contains_key("IL2CPP"));
        assert_eq!(
            entry.storage_ids_by_runtime.get("Mono").map(|s| s.as_str()),
            Some(storage_id)
        );
        assert!(!entry.storage_ids_by_runtime.contains_key("IL2CPP"));

        Ok(())
    }

    #[tokio::test]
    #[serial]
    async fn load_storage_metadata_migrates_legacy_runtime_and_source_values() -> Result<()> {
        let temp = tempdir()?;
        let data_dir = temp.path().join("simmrust");
        let _data_guard =
            EnvVarGuard::set("SIMMRUST_DATA_DIR", data_dir.to_string_lossy().as_ref());
        let pool = initialize_pool().await?;
        let service = ModsService::new(pool);

        let storage_dir = temp.path().join("storage").join("legacy-entry");
        fs::create_dir_all(&storage_dir).await?;
        let metadata_path = storage_dir.join(STORAGE_METADATA_FILE);

        fs::write(
            &metadata_path,
            serde_json::json!({
                "source": "Nexus Mods",
                "sourceId": "12345",
                "modName": "Legacy Mod",
                "detectedRuntime": "Mono",
                "runtimeMatch": true,
                "modStorageId": "legacy-entry",
                "installedAt": "2026-03-05T10:00:00Z"
            })
            .to_string(),
        )
        .await?;

        let parsed = service
            .load_storage_metadata(&storage_dir)
            .await?
            .expect("storage metadata should parse");

        assert!(matches!(parsed.source, Some(ModSource::Nexusmods)));
        assert!(matches!(parsed.detected_runtime, Some(Runtime::Mono)));
        assert_eq!(parsed.mod_name.as_deref(), Some("Legacy Mod"));
        assert_eq!(parsed.mod_storage_id.as_deref(), Some("legacy-entry"));
        assert!(parsed.installed_at.is_some());

        let normalized_content = fs::read_to_string(&metadata_path).await?;
        let normalized = serde_json::from_str::<ModMetadata>(&normalized_content)?;
        assert!(matches!(normalized.detected_runtime, Some(Runtime::Mono)));

        Ok(())
    }

    #[tokio::test]
    #[serial]
    async fn load_storage_metadata_prefers_report_summary_disposition() -> Result<()> {
        let temp = tempdir()?;
        let data_dir = temp.path().join("simmrust");
        let _data_guard =
            EnvVarGuard::set("SIMMRUST_DATA_DIR", data_dir.to_string_lossy().as_ref());
        let pool = initialize_pool().await?;
        let service = ModsService::new(pool.clone());

        let download_dir = temp.path().join("downloads");
        let mut settings_service = SettingsService::new(pool)?;
        settings_service
            .save_settings(serde_json::json!({
                "defaultDownloadDir": download_dir.to_string_lossy().to_string()
            }))
            .await?;

        let storage_dir = download_dir.join("Mods").join("report-wins");
        fs::create_dir_all(&storage_dir).await?;

        let stale_summary = serde_json::json!({
            "state": "review",
            "verified": false,
            "highestSeverity": "Medium",
            "totalFindings": 2,
            "threatFamilyCount": 0,
            "statusMessage": "Legacy rule hits"
        });

        fs::write(
            storage_dir.join(STORAGE_METADATA_FILE),
            serde_json::json!({
                "source": "local",
                "modStorageId": "report-wins",
                "modName": "Report Wins",
                "securityScan": stale_summary
            })
            .to_string(),
        )
        .await?;

        let report = SecurityScanReport {
            summary: SecurityScanSummary {
                state: SecurityScanState::Verified,
                verified: true,
                disposition: Some(SecurityScanDisposition {
                    classification: SecurityScanDispositionClassification::Clean,
                    headline: "Clean".to_string(),
                    summary: "Disposition is clean.".to_string(),
                    blocking_recommended: false,
                    primary_threat_family_id: None,
                    related_finding_ids: Vec::new(),
                }),
                highest_severity: Some(SecurityFindingSeverity::Medium),
                total_findings: 2,
                threat_family_count: 0,
                scanned_at: None,
                scanner_version: Some("1.0.0".to_string()),
                schema_version: Some("1".to_string()),
                status_message: Some("Disposition is clean.".to_string()),
            },
            policy: SecurityScanPolicy {
                enabled: true,
                requires_confirmation: false,
                blocked: false,
                prompt_on_high_findings: false,
                block_critical_findings: false,
                status_message: Some("Disposition is clean.".to_string()),
            },
            files: vec![SecurityScanFileReport {
                file_name: "ReportWins.dll".to_string(),
                display_path: "Mods/ReportWins.dll".to_string(),
                sha256_hash: None,
                highest_severity: Some(SecurityFindingSeverity::Medium),
                total_findings: 2,
                threat_family_count: 0,
                result: serde_json::json!({
                    "findings": [
                        {
                            "id": "legacy-medium",
                            "severity": "Medium",
                            "description": "Legacy heuristic match"
                        }
                    ],
                    "disposition": {
                        "classification": "Clean",
                        "headline": "Clean",
                        "summary": "Disposition is clean.",
                        "blockingRecommended": false,
                        "relatedFindingIds": []
                    }
                }),
            }],
        };

        service
            .save_security_scan_report("report-wins", &report)
            .await?;

        let parsed = service
            .load_storage_metadata(&storage_dir)
            .await?
            .expect("storage metadata should parse");

        let disposition = parsed
            .security_scan
            .and_then(|summary| summary.disposition)
            .expect("disposition should come from stored report");
        assert_eq!(
            disposition.classification,
            SecurityScanDispositionClassification::Clean
        );

        Ok(())
    }

    #[tokio::test]
    #[serial]
    async fn load_storage_metadata_ignores_unreadable_security_scan_report() -> Result<()> {
        let temp = tempdir()?;
        let service = ModsService::new(Arc::new(SqlitePool::connect_lazy("sqlite::memory:")?));

        let storage_dir = temp.path().join("storage").join("unreadable-sidecar");
        fs::create_dir_all(&storage_dir).await?;
        fs::write(
            storage_dir.join(STORAGE_METADATA_FILE),
            serde_json::json!({
                "source": "local",
                "modStorageId": "unreadable-sidecar",
                "modName": "Unreadable Sidecar"
            })
            .to_string(),
        )
        .await?;
        fs::create_dir_all(storage_dir.join(STORAGE_SECURITY_SCAN_FILE)).await?;

        let metadata = service
            .load_storage_metadata(&storage_dir)
            .await?
            .expect("storage metadata should still load");

        assert_eq!(metadata.mod_name.as_deref(), Some("Unreadable Sidecar"));
        assert!(metadata.security_scan.is_none());

        Ok(())
    }

    #[test]
    fn build_summary_only_security_scan_report_preserves_review_confirmation() {
        let report = ModsService::build_summary_only_security_scan_report(SecurityScanSummary {
            state: SecurityScanState::Review,
            verified: false,
            disposition: None,
            highest_severity: Some(SecurityFindingSeverity::High),
            total_findings: 2,
            threat_family_count: 1,
            scanned_at: None,
            scanner_version: Some("1.0.0".to_string()),
            schema_version: Some("1".to_string()),
            status_message: Some("Needs review".to_string()),
        });

        assert!(report.policy.requires_confirmation);
        assert!(!report.policy.blocked);
    }

    #[tokio::test]
    #[serial]
    async fn get_security_scan_report_falls_back_to_summary_when_report_file_missing() -> Result<()>
    {
        let temp = tempdir()?;
        let data_dir = temp.path().join("simmrust");
        let _data_guard =
            EnvVarGuard::set("SIMMRUST_DATA_DIR", data_dir.to_string_lossy().as_ref());
        let pool = initialize_pool().await?;
        let service = ModsService::new(pool.clone());

        let download_dir = temp.path().join("downloads");
        let mut settings_service = SettingsService::new(pool)?;
        settings_service
            .save_settings(serde_json::json!({
                "defaultDownloadDir": download_dir.to_string_lossy().to_string()
            }))
            .await?;

        let storage_dir = download_dir.join("Mods").join("summary-only");
        fs::create_dir_all(&storage_dir).await?;
        fs::write(
            storage_dir.join(STORAGE_METADATA_FILE),
            serde_json::json!({
                "source": "local",
                "modStorageId": "summary-only",
                "modName": "Summary Only",
                "securityScan": {
                    "state": "verified",
                    "verified": true,
                    "disposition": {
                        "classification": "Clean",
                        "headline": "Clean",
                        "summary": "No malware identified.",
                        "blockingRecommended": false,
                        "relatedFindingIds": []
                    },
                    "totalFindings": 0,
                    "threatFamilyCount": 0,
                    "statusMessage": "No malware identified."
                }
            })
            .to_string(),
        )
        .await?;

        let report = service
            .get_security_scan_report("summary-only")
            .await?
            .expect("summary-only fallback report");

        assert!(report.files.is_empty());
        assert_eq!(report.summary.state, SecurityScanState::Verified);
        assert_eq!(
            report
                .summary
                .disposition
                .as_ref()
                .map(|value| value.classification),
            Some(SecurityScanDispositionClassification::Clean)
        );

        Ok(())
    }

    #[tokio::test]
    #[serial]
    async fn security_scan_report_rejects_invalid_storage_ids() -> Result<()> {
        let temp = tempdir()?;
        let data_dir = temp.path().join("simmrust");
        let _data_guard =
            EnvVarGuard::set("SIMMRUST_DATA_DIR", data_dir.to_string_lossy().as_ref());
        let pool = initialize_pool().await?;
        let service = ModsService::new(pool.clone());

        let download_dir = temp.path().join("downloads");
        let mut settings_service = SettingsService::new(pool)?;
        settings_service
            .save_settings(serde_json::json!({
                "defaultDownloadDir": download_dir.to_string_lossy().to_string()
            }))
            .await?;

        let report = SecurityScanReport {
            summary: SecurityScanSummary {
                state: SecurityScanState::Verified,
                verified: true,
                disposition: None,
                highest_severity: None,
                total_findings: 0,
                threat_family_count: 0,
                scanned_at: None,
                scanner_version: None,
                schema_version: None,
                status_message: None,
            },
            policy: SecurityScanPolicy {
                enabled: true,
                requires_confirmation: false,
                blocked: false,
                prompt_on_high_findings: false,
                block_critical_findings: false,
                status_message: None,
            },
            files: Vec::new(),
        };

        let save_error = service
            .save_security_scan_report("../escape", &report)
            .await
            .expect_err("invalid storage ids should be rejected");
        assert!(save_error.to_string().contains("Invalid storage id"));

        let get_error = service
            .get_security_scan_report("../escape")
            .await
            .expect_err("invalid storage ids should be rejected");
        assert!(get_error.to_string().contains("Invalid storage id"));

        Ok(())
    }

    #[tokio::test]
    #[serial]
    async fn list_mods_prefers_storage_report_summary_over_stale_env_metadata() -> Result<()> {
        let temp = tempdir()?;
        let data_dir = temp.path().join("simmrust");
        let _data_guard =
            EnvVarGuard::set("SIMMRUST_DATA_DIR", data_dir.to_string_lossy().as_ref());
        let pool = initialize_pool().await?;
        let env_service = EnvironmentService::new(pool.clone())?;
        let service = ModsService::new(pool.clone());

        let download_dir = temp.path().join("downloads");
        let mut settings_service = SettingsService::new(pool.clone())?;
        settings_service
            .save_settings(serde_json::json!({
                "defaultDownloadDir": download_dir.to_string_lossy().to_string()
            }))
            .await?;

        let output_dir = temp.path().join("envs").join("env-security-summary");
        let _env = env_service
            .create_environment(
                schedule_i_config().app_id,
                "main".to_string(),
                output_dir.to_string_lossy().to_string(),
                None,
                None,
            )
            .await?;

        let mods_dir = output_dir.join("Mods");
        fs::create_dir_all(&mods_dir).await?;
        fs::write(mods_dir.join("DispositionWins.dll"), b"data").await?;

        let storage_id = "disposition-wins";
        let mut env_meta = sample_metadata(Some(storage_id), Some("example/source"), Some("1.0.0"));
        env_meta.mod_name = Some("Disposition Wins".to_string());
        env_meta.security_scan = Some(SecurityScanSummary {
            state: SecurityScanState::Review,
            verified: false,
            disposition: None,
            highest_severity: Some(SecurityFindingSeverity::Medium),
            total_findings: 1,
            threat_family_count: 0,
            scanned_at: None,
            scanner_version: None,
            schema_version: None,
            status_message: Some("Legacy rule-only summary".to_string()),
        });

        let mut env_metadata = HashMap::new();
        env_metadata.insert("DispositionWins.dll".to_string(), env_meta);
        service.save_mod_metadata(&mods_dir, &env_metadata).await?;

        let storage_dir = download_dir.join("Mods").join(storage_id);
        fs::create_dir_all(storage_dir.join("Mods")).await?;
        fs::write(
            storage_dir.join("Mods").join("DispositionWins.dll"),
            b"data",
        )
        .await?;
        fs::write(
            storage_dir.join(STORAGE_METADATA_FILE),
            serde_json::json!({
                "source": "local",
                "modStorageId": storage_id,
                "modName": "Disposition Wins"
            })
            .to_string(),
        )
        .await?;

        service
            .save_security_scan_report(
                storage_id,
                &SecurityScanReport {
                    summary: SecurityScanSummary {
                        state: SecurityScanState::Verified,
                        verified: true,
                        disposition: Some(SecurityScanDisposition {
                            classification: SecurityScanDispositionClassification::Clean,
                            headline: "Clean".to_string(),
                            summary: "Disposition is clean.".to_string(),
                            blocking_recommended: false,
                            primary_threat_family_id: None,
                            related_finding_ids: Vec::new(),
                        }),
                        highest_severity: Some(SecurityFindingSeverity::Medium),
                        total_findings: 1,
                        threat_family_count: 0,
                        scanned_at: None,
                        scanner_version: Some("1.0.0".to_string()),
                        schema_version: Some("1".to_string()),
                        status_message: Some("Disposition is clean.".to_string()),
                    },
                    policy: SecurityScanPolicy {
                        enabled: true,
                        requires_confirmation: false,
                        blocked: false,
                        prompt_on_high_findings: false,
                        block_critical_findings: false,
                        status_message: Some("Disposition is clean.".to_string()),
                    },
                    files: vec![SecurityScanFileReport {
                        file_name: "DispositionWins.dll".to_string(),
                        display_path: "Mods/DispositionWins.dll".to_string(),
                        sha256_hash: None,
                        highest_severity: Some(SecurityFindingSeverity::Medium),
                        total_findings: 1,
                        threat_family_count: 0,
                        result: serde_json::json!({
                            "findings": [
                                {
                                    "id": "rule-medium",
                                    "severity": "Medium",
                                    "description": "Rule hit"
                                }
                            ],
                            "disposition": {
                                "classification": "Clean",
                                "headline": "Clean",
                                "summary": "Disposition is clean.",
                                "blockingRecommended": false,
                                "relatedFindingIds": []
                            }
                        }),
                    }],
                },
            )
            .await?;

        let result = service
            .list_mods(output_dir.to_string_lossy().as_ref())
            .await?;
        let mods = result
            .get("mods")
            .and_then(|value| value.as_array())
            .expect("mods array");
        let security_scan = mods[0]
            .get("securityScan")
            .cloned()
            .expect("security scan summary should be present");
        let summary = serde_json::from_value::<SecurityScanSummary>(security_scan)?;

        assert_eq!(summary.state, SecurityScanState::Verified);
        assert_eq!(
            summary
                .disposition
                .as_ref()
                .map(|value| value.classification),
            Some(SecurityScanDispositionClassification::Clean)
        );

        Ok(())
    }

    #[tokio::test]
    #[serial]
    async fn get_mod_library_ignores_unreadable_storage_metadata_files() -> Result<()> {
        let temp = tempdir()?;
        let data_dir = temp.path().join("simmrust");
        let _data_guard =
            EnvVarGuard::set("SIMMRUST_DATA_DIR", data_dir.to_string_lossy().as_ref());
        let pool = initialize_pool().await?;
        let service = ModsService::new(pool.clone());

        let download_dir = temp.path().join("downloads");
        let mut settings_service = SettingsService::new(pool)?;
        settings_service
            .save_settings(serde_json::json!({
                "defaultDownloadDir": download_dir.to_string_lossy().to_string()
            }))
            .await?;

        let storage_id = "broken-storage";
        let storage_mods = download_dir.join("Mods").join(storage_id).join("Mods");
        fs::create_dir_all(&storage_mods).await?;
        fs::write(storage_mods.join("BrokenExample.dll"), b"binary").await?;
        fs::write(
            download_dir
                .join("Mods")
                .join(storage_id)
                .join(STORAGE_METADATA_FILE),
            "{not valid json",
        )
        .await?;

        let library = service.get_mod_library().await?;
        assert!(library
            .downloaded
            .iter()
            .any(|entry| entry.storage_id == storage_id));

        Ok(())
    }

    #[tokio::test]
    #[serial]
    async fn get_mod_library_keeps_distinct_entries_for_distinct_installed_versions() -> Result<()>
    {
        let temp = tempdir()?;
        let data_dir = temp.path().join("simmrust");
        let _data_guard =
            EnvVarGuard::set("SIMMRUST_DATA_DIR", data_dir.to_string_lossy().as_ref());
        let pool = initialize_pool().await?;
        let env_service = EnvironmentService::new(pool.clone())?;
        let service = ModsService::new(pool.clone());

        let download_dir = temp.path().join("downloads");
        let mut settings_service = SettingsService::new(pool.clone())?;
        settings_service
            .save_settings(serde_json::json!({
                "defaultDownloadDir": download_dir.to_string_lossy().to_string()
            }))
            .await?;

        let output_dir = temp.path().join("envs").join("env-library-version");
        let _env = env_service
            .create_environment(
                schedule_i_config().app_id,
                "main".to_string(),
                output_dir.to_string_lossy().to_string(),
                None,
                None,
            )
            .await?;

        let mods_dir = output_dir.join("Mods");
        fs::create_dir_all(&mods_dir).await?;
        fs::write(mods_dir.join("Example-v1.dll"), b"data-v1").await?;
        fs::write(mods_dir.join("Example-v2.dll"), b"data-v2").await?;

        let mut metadata_v1 = sample_metadata(Some("storage-v1"), Some("example/mod"), None);
        metadata_v1.mod_name = Some("Example Multi".to_string());
        metadata_v1.installed_version = Some("1.0.0".to_string());

        let mut metadata_v2 = sample_metadata(Some("storage-v2"), Some("example/mod"), None);
        metadata_v2.mod_name = Some("Example Multi".to_string());
        metadata_v2.installed_version = Some("2.0.0".to_string());

        let mut env_metadata = HashMap::new();
        env_metadata.insert("Example-v1.dll".to_string(), metadata_v1.clone());
        env_metadata.insert("Example-v2.dll".to_string(), metadata_v2.clone());
        service.save_mod_metadata(&mods_dir, &env_metadata).await?;

        let storage_v1 = download_dir.join("Mods").join("storage-v1").join("Mods");
        let storage_v2 = download_dir.join("Mods").join("storage-v2").join("Mods");
        fs::create_dir_all(&storage_v1).await?;
        fs::create_dir_all(&storage_v2).await?;
        fs::write(storage_v1.join("Example-v1.dll"), b"data-v1").await?;
        fs::write(storage_v2.join("Example-v2.dll"), b"data-v2").await?;

        let library = service.get_mod_library().await?;
        let matching: Vec<_> = library
            .downloaded
            .iter()
            .filter(|entry| entry.display_name == "Example Multi")
            .collect();

        assert_eq!(matching.len(), 2);

        Ok(())
    }

    #[tokio::test]
    #[serial]
    async fn get_mod_library_groups_thunderstore_runtime_split_variants() -> Result<()> {
        let temp = tempdir()?;
        let data_dir = temp.path().join("simmrust");
        let _data_guard =
            EnvVarGuard::set("SIMMRUST_DATA_DIR", data_dir.to_string_lossy().as_ref());
        let pool = initialize_pool().await?;
        let env_service = EnvironmentService::new(pool.clone())?;
        let service = ModsService::new(pool.clone());

        let download_dir = temp.path().join("downloads");
        let mut settings_service = SettingsService::new(pool.clone())?;
        settings_service
            .save_settings(serde_json::json!({
                "defaultDownloadDir": download_dir.to_string_lossy().to_string()
            }))
            .await?;

        let il2cpp_output_dir = temp.path().join("envs").join("env-thunderstore-il2cpp");
        let il2cpp_env = env_service
            .create_environment(
                schedule_i_config().app_id.clone(),
                "main".to_string(),
                il2cpp_output_dir.to_string_lossy().to_string(),
                None,
                None,
            )
            .await?;

        let mono_output_dir = temp.path().join("envs").join("env-thunderstore-mono");
        let mono_env = env_service
            .create_environment(
                schedule_i_config().app_id,
                "alternate".to_string(),
                mono_output_dir.to_string_lossy().to_string(),
                None,
                None,
            )
            .await?;

        let il2cpp_mods_dir = il2cpp_output_dir.join("Mods");
        let mono_mods_dir = mono_output_dir.join("Mods");
        fs::create_dir_all(&il2cpp_mods_dir).await?;
        fs::create_dir_all(&mono_mods_dir).await?;
        fs::write(il2cpp_mods_dir.join("S1FuelMod.IL2CPP.dll"), b"il2cpp").await?;
        fs::write(mono_mods_dir.join("S1FuelMod.Mono.dll"), b"mono").await?;

        let mut il2cpp_meta = sample_metadata(
            Some("storage-s1fuel-il2cpp"),
            Some("S1FuelModTeam/S1FuelMod-IL2CPP"),
            Some("1.3.1-IL2CPP"),
        );
        il2cpp_meta.source = Some(ModSource::Thunderstore);
        il2cpp_meta.mod_name = Some("S1FuelMod-IL2CPP".to_string());
        il2cpp_meta.author = Some("S1FuelModTeam".to_string());
        il2cpp_meta.security_scan = Some(SecurityScanSummary {
            state: SecurityScanState::Verified,
            verified: true,
            disposition: Some(SecurityScanDisposition {
                classification: SecurityScanDispositionClassification::Clean,
                headline: "Clean".to_string(),
                summary: "Safe runtime variant".to_string(),
                blocking_recommended: false,
                primary_threat_family_id: None,
                related_finding_ids: Vec::new(),
            }),
            highest_severity: None,
            total_findings: 0,
            threat_family_count: 0,
            scanned_at: None,
            scanner_version: Some("1.0.0".to_string()),
            schema_version: Some("1".to_string()),
            status_message: Some("No malware identified.".to_string()),
        });

        let mut mono_meta = sample_metadata(
            Some("storage-s1fuel-mono"),
            Some("S1FuelModTeam/S1FuelMod-Mono"),
            Some("1.3.1-Mono"),
        );
        mono_meta.source = Some(ModSource::Thunderstore);
        mono_meta.mod_name = Some("S1FuelMod-Mono".to_string());
        mono_meta.author = Some("S1FuelModTeam".to_string());
        mono_meta.security_scan = Some(SecurityScanSummary {
            state: SecurityScanState::Review,
            verified: false,
            disposition: Some(SecurityScanDisposition {
                classification: SecurityScanDispositionClassification::Suspicious,
                headline: "Suspicious".to_string(),
                summary: "Potentially malicious runtime variant".to_string(),
                blocking_recommended: false,
                primary_threat_family_id: None,
                related_finding_ids: vec!["finding-1".to_string()],
            }),
            highest_severity: Some(SecurityFindingSeverity::High),
            total_findings: 1,
            threat_family_count: 1,
            scanned_at: None,
            scanner_version: Some("1.0.0".to_string()),
            schema_version: Some("1".to_string()),
            status_message: Some("Potentially malicious runtime variant".to_string()),
        });

        let mut il2cpp_metadata = HashMap::new();
        il2cpp_metadata.insert("S1FuelMod.IL2CPP.dll".to_string(), il2cpp_meta);
        service
            .save_mod_metadata(&il2cpp_mods_dir, &il2cpp_metadata)
            .await?;

        let mut mono_metadata = HashMap::new();
        mono_metadata.insert("S1FuelMod.Mono.dll".to_string(), mono_meta);
        service
            .save_mod_metadata(&mono_mods_dir, &mono_metadata)
            .await?;

        let storage_il2cpp = download_dir
            .join("Mods")
            .join("storage-s1fuel-il2cpp")
            .join("Mods");
        let storage_mono = download_dir
            .join("Mods")
            .join("storage-s1fuel-mono")
            .join("Mods");
        fs::create_dir_all(&storage_il2cpp).await?;
        fs::create_dir_all(&storage_mono).await?;
        fs::write(storage_il2cpp.join("S1FuelMod.IL2CPP.dll"), b"il2cpp").await?;
        fs::write(storage_mono.join("S1FuelMod.Mono.dll"), b"mono").await?;

        let library = service.get_mod_library().await?;
        let matching: Vec<_> = library
            .downloaded
            .iter()
            .filter(|entry| entry.display_name == "S1FuelMod")
            .collect();

        assert_eq!(matching.len(), 1);
        let entry = matching[0];
        assert!(entry
            .available_runtimes
            .iter()
            .any(|runtime| runtime == "IL2CPP"));
        assert!(entry
            .available_runtimes
            .iter()
            .any(|runtime| runtime == "Mono"));
        assert_eq!(
            entry
                .storage_ids_by_runtime
                .get("IL2CPP")
                .map(|value| value.as_str()),
            Some("storage-s1fuel-il2cpp")
        );
        assert_eq!(
            entry
                .storage_ids_by_runtime
                .get("Mono")
                .map(|value| value.as_str()),
            Some("storage-s1fuel-mono")
        );
        assert!(entry
            .installed_in_by_runtime
            .get("IL2CPP")
            .is_some_and(|items| items.contains(&il2cpp_env.id)));
        assert!(entry
            .installed_in_by_runtime
            .get("Mono")
            .is_some_and(|items| items.contains(&mono_env.id)));
        assert_eq!(
            entry
                .security_scan
                .as_ref()
                .and_then(|summary| summary.disposition.as_ref())
                .map(|value| value.classification),
            Some(SecurityScanDispositionClassification::Suspicious)
        );

        Ok(())
    }

    #[tokio::test]
    #[serial]
    async fn uninstall_storage_mod_from_envs_removes_files() -> Result<()> {
        let temp = tempdir()?;
        let data_dir = temp.path().join("simmrust");
        let _data_guard =
            EnvVarGuard::set("SIMMRUST_DATA_DIR", data_dir.to_string_lossy().as_ref());
        let pool = initialize_pool().await?;
        let env_service = EnvironmentService::new(pool.clone())?;
        let service = ModsService::new(pool.clone());

        let output_dir = temp.path().join("envs").join("env-5");
        let env = env_service
            .create_environment(
                schedule_i_config().app_id,
                "main".to_string(),
                output_dir.to_string_lossy().to_string(),
                None,
                None,
            )
            .await?;

        let mods_dir = output_dir.join("Mods");
        fs::create_dir_all(&mods_dir).await?;
        fs::write(mods_dir.join("Example.dll"), b"data").await?;

        let mut metadata = HashMap::new();
        metadata.insert(
            "Example.dll".to_string(),
            sample_metadata(Some("storage-1"), Some("source"), Some("1.0.0")),
        );
        service.save_mod_metadata(&mods_dir, &metadata).await?;

        let result = service
            .uninstall_storage_mod_from_envs("storage-1", vec![env.id.clone()])
            .await?;
        let removed = result
            .get("results")
            .and_then(|v| v.as_array())
            .and_then(|arr| arr.first())
            .and_then(|v| v.get("removedFiles"))
            .and_then(|v| v.as_array())
            .map(|arr| arr.len())
            .unwrap_or(0);
        assert_eq!(removed, 1);
        assert!(!mods_dir.join("Example.dll").exists());

        let count: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM mod_metadata WHERE environment_id = ?")
                .bind(&env.id)
                .fetch_one(&*pool)
                .await?;
        assert_eq!(count, 0);

        Ok(())
    }

    #[tokio::test]
    #[serial]
    async fn delete_downloaded_mod_removes_storage_dir() -> Result<()> {
        let temp = tempdir()?;
        let data_dir = temp.path().join("simmrust");
        let _data_guard =
            EnvVarGuard::set("SIMMRUST_DATA_DIR", data_dir.to_string_lossy().as_ref());
        let _home_guard =
            EnvVarGuard::set("SIMMRUST_HOME_DIR", temp.path().to_string_lossy().as_ref());
        let pool = initialize_pool().await?;
        let env_service = EnvironmentService::new(pool.clone())?;
        let service = ModsService::new(pool.clone());

        let output_dir = temp.path().join("envs").join("env-6");
        let env = env_service
            .create_environment(
                schedule_i_config().app_id,
                "main".to_string(),
                output_dir.to_string_lossy().to_string(),
                None,
                None,
            )
            .await?;

        let mods_dir = output_dir.join("Mods");
        fs::create_dir_all(&mods_dir).await?;
        fs::write(mods_dir.join("Example.dll"), b"data").await?;

        let storage_dir = service.get_mods_storage_dir().await?.join("storage-2");
        fs::create_dir_all(&storage_dir).await?;
        fs::write(storage_dir.join("file.txt"), b"data").await?;

        let mut metadata = HashMap::new();
        metadata.insert(
            "Example.dll".to_string(),
            sample_metadata(Some("storage-2"), Some("source"), Some("1.0.0")),
        );
        service.save_mod_metadata(&mods_dir, &metadata).await?;

        let result = service.delete_downloaded_mod("storage-2").await?;
        assert_eq!(result.get("deleted").and_then(|v| v.as_bool()), Some(true));
        assert!(!storage_dir.exists());
        assert!(!mods_dir.join("Example.dll").exists());

        let count: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM mod_metadata WHERE environment_id = ?")
                .bind(&env.id)
                .fetch_one(&*pool)
                .await?;
        assert_eq!(count, 0);

        Ok(())
    }

    #[tokio::test]
    async fn delete_mod_rejects_invalid_filename() -> Result<()> {
        let temp = tempdir()?;
        let service = ModsService::new(Arc::new(SqlitePool::connect_lazy("sqlite::memory:")?));

        let err = service
            .delete_mod(temp.path().to_string_lossy().as_ref(), "not-a-mod.txt")
            .await
            .expect_err("expected invalid mod file error");
        assert!(err.to_string().contains("Invalid mod file"));

        Ok(())
    }

    #[tokio::test]
    async fn create_symlink_file_errors_when_parent_missing() -> Result<()> {
        let temp = tempdir()?;
        let service = ModsService::new(Arc::new(SqlitePool::connect_lazy("sqlite::memory:")?));

        let src = temp.path().join("src.txt");
        fs::write(&src, b"data").await?;
        let dst = temp.path().join("missing").join("dst.txt");

        let err = service
            .create_symlink_file(&src, &dst)
            .await
            .expect_err("expected symlink error");
        assert!(err.to_string().contains("Failed to create file symlink"));

        Ok(())
    }

    #[tokio::test]
    async fn create_symlink_dir_errors_when_parent_missing() -> Result<()> {
        let temp = tempdir()?;
        let service = ModsService::new(Arc::new(SqlitePool::connect_lazy("sqlite::memory:")?));

        let src = temp.path().join("srcdir");
        fs::create_dir_all(&src).await?;
        let dst = temp.path().join("missing").join("dstdir");

        let err = service
            .create_symlink_dir(&src, &dst)
            .await
            .expect_err("expected symlink error");
        assert!(err
            .to_string()
            .contains("Failed to create directory symlink"));

        Ok(())
    }

    #[tokio::test]
    async fn install_storage_entries_propagates_symlink_failures() -> Result<()> {
        let temp = tempdir()?;
        let service = ModsService::new(Arc::new(SqlitePool::connect_lazy("sqlite::memory:")?));

        let source_dir = temp.path().join("storage").join("Mods");
        fs::create_dir_all(&source_dir).await?;
        fs::write(source_dir.join("Example.dll"), b"data").await?;

        let dest_dir = temp.path().join("missing").join("Mods");
        let mut metadata_map = HashMap::new();
        let mut installed_files = Vec::new();

        let err = service
            .install_storage_entries(
                &source_dir,
                &dest_dir,
                false,
                "unknown",
                &None,
                "storage-1",
                &mut metadata_map,
                &mut installed_files,
                &Runtime::Il2cpp,
            )
            .await
            .expect_err("expected symlink installation failure");

        assert!(err
            .to_string()
            .contains("Failed to create file symlink for storage entry Example.dll"));
        assert!(installed_files.is_empty());
        assert!(metadata_map.is_empty());

        Ok(())
    }

    #[tokio::test]
    async fn is_symlink_returns_false_for_regular_file() -> Result<()> {
        let temp = tempdir()?;
        let service = ModsService::new(Arc::new(SqlitePool::connect_lazy("sqlite::memory:")?));

        let path = temp.path().join("file.txt");
        fs::write(&path, b"data").await?;

        let is_link = service.is_symlink(&path).await?;
        assert!(!is_link);

        Ok(())
    }

    #[tokio::test]
    async fn resolve_symlink_returns_error_for_regular_file() -> Result<()> {
        let temp = tempdir()?;
        let service = ModsService::new(Arc::new(SqlitePool::connect_lazy("sqlite::memory:")?));

        let path = temp.path().join("file.txt");
        fs::write(&path, b"data").await?;

        let err = service
            .resolve_symlink(&path)
            .await
            .expect_err("expected resolve error");
        assert!(err.to_string().contains("Failed to resolve symlink"));

        Ok(())
    }

    #[tokio::test]
    async fn remove_symlink_removes_regular_file() -> Result<()> {
        let temp = tempdir()?;
        let service = ModsService::new(Arc::new(SqlitePool::connect_lazy("sqlite::memory:")?));

        let path = temp.path().join("file.txt");
        fs::write(&path, b"data").await?;

        service.remove_symlink(&path).await?;
        assert!(!path.exists());

        Ok(())
    }
}
