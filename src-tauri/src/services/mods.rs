use crate::services::fomod::{FomodInstallEntry, FomodService};
use crate::services::nexus_mods::NexusModsService;
use crate::services::settings::SettingsService;
use crate::services::thunderstore::shared_thunderstore_service;
use crate::types::{
    Environment, LocalModOwnershipCandidate, LocalModSourcePreview, LocalModSourceVersionOption,
    ModLibraryEntry, ModLibraryResult, ModMetadata, ModSource, SecurityFindingSeverity,
    SecurityScanDisposition, SecurityScanDispositionClassification, SecurityScanPolicy,
    SecurityScanReport, SecurityScanState, SecurityScanSummary,
};
use anyhow::{Context, Result};
use chrono::{DateTime, TimeZone, Utc};
use flate2::read::GzDecoder;
use once_cell::sync::Lazy;
use regex::Regex;
use reqwest::header::CONTENT_LENGTH;
use sha2::{Digest, Sha256};
use sqlx::SqlitePool;
use std::collections::{HashMap, HashSet};
use std::fs::File;
use std::io::{copy, Read};
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;
use tokio::fs;
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
const COPY_FALLBACK_MARKER_FILE: &str = ".simm-copy-fallback.json";
const RUNTIME_IL2CPP: &str = "IL2CPP";
const RUNTIME_MONO: &str = "Mono";
const MAX_ICON_BYTES: usize = 5 * 1024 * 1024;
const ICON_FETCH_TIMEOUT_SECONDS: u64 = 15;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum FomodDestinationKind {
    Mods,
    Plugins,
    UserLibs,
    UserData,
}

#[derive(Default)]
struct StoragePayloadSummary {
    primary_files: Vec<String>,
    attached_userlibs: Vec<String>,
    attached_userdata: Vec<String>,
}

#[derive(Debug, Clone)]
enum LinkedSourceProvider {
    Thunderstore {
        game_id: String,
        owner: String,
        package_name: String,
        normalized_url: String,
    },
    NexusMods {
        game_id: String,
        mod_id: u32,
        normalized_url: String,
    },
}

fn archive_format_for_path(path: &Path) -> &'static str {
    if let Ok(mut file) = File::open(path) {
        let mut signature = [0u8; 8];
        if let Ok(count) = file.read(&mut signature) {
            if count >= 4
                && signature[0] == 0x50
                && signature[1] == 0x4b
                && matches!(signature[2], 0x03 | 0x05 | 0x07)
                && matches!(signature[3], 0x04 | 0x06 | 0x08)
            {
                return "zip";
            }
            if count >= 6 && signature[..6] == [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c] {
                return "7z";
            }
            if count >= 7 && signature[..7] == [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x00] {
                return "rar";
            }
            if count >= 8 && signature[..8] == [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x01, 0x00] {
                return "rar";
            }
            if count >= 2 && signature[..2] == [0x4d, 0x5a] {
                return "dll";
            }
        }
    }

    let file_name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if file_name.ends_with(".tar.gz") || file_name.ends_with(".tgz") {
        return "tar.gz";
    }

    match path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "7z" => "7z",
        "rar" => "rar",
        "zip" => "zip",
        "dll" => "dll",
        _ => "zip",
    }
}

fn safe_archive_relative_path(entry_name: &str) -> std::result::Result<PathBuf, String> {
    let normalized_entry_name = entry_name.replace('\\', "/");
    if normalized_entry_name.contains(':') {
        return Err(format!(
            "Archive entry contains an unsafe path: {}",
            entry_name
        ));
    }

    let path = Path::new(&normalized_entry_name);
    if path.as_os_str().is_empty() || path.is_absolute() {
        return Err(format!(
            "Archive entry contains an unsafe path: {}",
            entry_name
        ));
    }

    let mut relative = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Normal(value) => relative.push(value),
            Component::CurDir => {}
            _ => {
                return Err(format!(
                    "Archive entry contains an unsafe path: {}",
                    entry_name
                ))
            }
        }
    }

    if relative.as_os_str().is_empty() {
        Err(format!(
            "Archive entry contains an unsafe path: {}",
            entry_name
        ))
    } else {
        Ok(relative)
    }
}

fn validate_rar_entry_path(entry_path: &Path) -> Result<()> {
    let entry_name = entry_path.to_string_lossy();
    safe_archive_relative_path(entry_name.as_ref())
        .map(|_| ())
        .map_err(|error| anyhow::anyhow!(error))
}

#[derive(Debug, Clone)]
struct LocalSourcePreviewResolved {
    preview: LocalModSourcePreview,
    metadata: ModMetadata,
}

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
    author: Option<String>,
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

    fn get_userlibs_directory(&self, output_dir: &str) -> PathBuf {
        Path::new(output_dir).join("UserLibs")
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

    /// Parses user-supplied runtime strings (case-insensitive). Returns `None` if unknown.
    fn parse_runtime_string(runtime: &str) -> Option<crate::types::Runtime> {
        match runtime.trim().to_ascii_lowercase().as_str() {
            "il2cpp" => Some(crate::types::Runtime::Il2cpp),
            "mono" => Some(crate::types::Runtime::Mono),
            _ => None,
        }
    }

    /// Resolves target runtime for zip install: explicit parse first, else same chain as
    /// `install_storage_mod_to_envs` (branch config → installation inference → persisted env).
    async fn resolve_env_runtime_for_zip_install(
        &self,
        game_dir: &str,
        branch: &str,
        runtime_param: &str,
    ) -> Result<crate::types::Runtime> {
        if let Some(r) = Self::parse_runtime_string(runtime_param) {
            return Ok(r);
        }
        if let Some(env_id) = self.environment_id_for_dir(game_dir).await? {
            let env = self.load_environment(&env_id).await?;
            let resolved = crate::services::environment::EnvironmentService::runtime_for_branch(
                &env.branch,
            )
            .or_else(|| {
                if env.output_dir.is_empty() {
                    None
                } else {
                    Some(
                        crate::services::environment::EnvironmentService::infer_runtime_from_installation_path(
                            Path::new(&env.output_dir),
                        ),
                    )
                }
            })
            .unwrap_or(env.runtime.clone());
            return Ok(resolved);
        }
        let from_branch =
            crate::services::environment::EnvironmentService::runtime_for_branch(branch);
        let from_path = if game_dir.is_empty() {
            None
        } else {
            Some(
                crate::services::environment::EnvironmentService::infer_runtime_from_installation_path(
                    Path::new(game_dir),
                ),
            )
        };
        Ok(from_branch
            .or(from_path)
            .unwrap_or(crate::types::Runtime::Mono))
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

    fn normalize_local_link_name(value: &str) -> String {
        Self::normalize_runtime_suffix_token(
            value
                .trim_end_matches(".disabled")
                .trim_end_matches(".dll")
                .trim_end_matches(".DLL"),
        )
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() {
                ch.to_ascii_lowercase()
            } else {
                ' '
            }
        })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
    }

    fn names_materially_differ(local_name: &str, remote_name: &str) -> bool {
        let local = Self::normalize_local_link_name(local_name);
        let remote = Self::normalize_local_link_name(remote_name);
        if local.is_empty() || remote.is_empty() {
            return false;
        }

        local != remote
    }

    fn parse_linked_source_provider(&self, source_url: &str) -> Result<LinkedSourceProvider> {
        let parsed = reqwest::Url::parse(source_url.trim())
            .context("Source URL must be a valid full URL")?;
        let scheme = parsed.scheme().to_ascii_lowercase();
        if scheme != "http" && scheme != "https" {
            return Err(anyhow::anyhow!(
                "Only full http/https source URLs are supported"
            ));
        }

        let host = parsed
            .host_str()
            .unwrap_or_default()
            .trim()
            .to_ascii_lowercase();
        let segments: Vec<&str> = parsed
            .path_segments()
            .map(|parts| parts.filter(|part| !part.is_empty()).collect())
            .unwrap_or_default();

        if host == "thunderstore.io" {
            if segments.len() < 5 || segments[0] != "c" || segments[2] != "p" {
                return Err(anyhow::anyhow!(
                    "Thunderstore URLs must point to a package page"
                ));
            }

            return Ok(LinkedSourceProvider::Thunderstore {
                game_id: segments[1].to_string(),
                owner: segments[3].to_string(),
                package_name: segments[4].to_string(),
                normalized_url: format!(
                    "https://thunderstore.io/c/{}/p/{}/{}/",
                    segments[1], segments[3], segments[4]
                ),
            });
        }

        if host == "www.nexusmods.com" || host == "nexusmods.com" {
            if segments.len() < 3 || segments[1] != "mods" {
                return Err(anyhow::anyhow!("Nexus Mods URLs must point to a mod page"));
            }

            let mod_id = segments[2]
                .parse::<u32>()
                .context("Invalid Nexus Mods mod id")?;
            return Ok(LinkedSourceProvider::NexusMods {
                game_id: segments[0].to_string(),
                mod_id,
                normalized_url: format!(
                    "https://www.nexusmods.com/{}/mods/{}",
                    segments[0], mod_id
                ),
            });
        }

        Err(anyhow::anyhow!(
            "Only Thunderstore and Nexus Mods URLs are supported for linking"
        ))
    }

    fn infer_runtime_label_from_text(value: &str) -> Option<String> {
        match value.trim().to_ascii_lowercase().as_str() {
            text if text.contains("il2cpp") => Some(RUNTIME_IL2CPP.to_string()),
            text if text.contains("mono") => Some(RUNTIME_MONO.to_string()),
            _ => None,
        }
    }

    async fn resolve_local_mod_source_preview(
        &self,
        source_url: &str,
    ) -> Result<LocalSourcePreviewResolved> {
        match self.parse_linked_source_provider(source_url)? {
            LinkedSourceProvider::Thunderstore {
                game_id,
                owner,
                package_name,
                normalized_url,
            } => {
                let service = shared_thunderstore_service();
                let packages = service
                    .search_packages_filtered_by_runtime(&game_id, "unknown", Some(&package_name))
                    .await
                    .context("Failed to query Thunderstore package metadata")?;

                let owner_lower = owner.to_ascii_lowercase();
                let package_lower = package_name.to_ascii_lowercase();
                let normalized_url_lower = normalized_url.to_ascii_lowercase();
                let package = packages
                    .into_iter()
                    .find(|package| {
                        let package_owner = package
                            .get("owner")
                            .and_then(|value| value.as_str())
                            .unwrap_or_default()
                            .to_ascii_lowercase();
                        let package_name_value = package
                            .get("name")
                            .and_then(|value| value.as_str())
                            .unwrap_or_default()
                            .to_ascii_lowercase();
                        let package_url = package
                            .get("package_url")
                            .and_then(|value| value.as_str())
                            .unwrap_or_default()
                            .trim_end_matches('/')
                            .to_ascii_lowercase();

                        (package_owner == owner_lower && package_name_value == package_lower)
                            || package_url == normalized_url_lower.trim_end_matches('/')
                    })
                    .ok_or_else(|| anyhow::anyhow!("Thunderstore package not found"))?;

                let display_name = package
                    .get("name")
                    .and_then(|value| value.as_str())
                    .unwrap_or(&package_name)
                    .to_string();
                let author = package
                    .get("owner")
                    .and_then(|value| value.as_str())
                    .map(|value| value.to_string());
                let summary = package
                    .get("latest")
                    .and_then(|value| value.get("description"))
                    .and_then(|value| value.as_str())
                    .map(|value| value.to_string())
                    .or_else(|| {
                        package
                            .get("versions")
                            .and_then(|value| value.as_array())
                            .and_then(|versions| versions.first())
                            .and_then(|value| value.get("description"))
                            .and_then(|value| value.as_str())
                            .map(|value| value.to_string())
                    });
                let icon_url = package
                    .get("latest")
                    .and_then(|value| value.get("icon"))
                    .and_then(|value| value.as_str())
                    .map(|value| value.to_string())
                    .or_else(|| {
                        package
                            .get("icon")
                            .or_else(|| package.get("icon_url"))
                            .and_then(|value| value.as_str())
                            .map(|value| value.to_string())
                    });
                let downloads = package
                    .get("versions")
                    .and_then(|value| value.as_array())
                    .map(|versions| {
                        versions.iter().fold(0_u64, |acc, version| {
                            acc.saturating_add(
                                version
                                    .get("downloads")
                                    .and_then(|value| value.as_u64())
                                    .unwrap_or(0),
                            )
                        })
                    });
                let likes_or_endorsements =
                    package.get("rating_score").and_then(|value| value.as_i64());
                let updated_at = package
                    .get("date_updated")
                    .and_then(|value| value.as_str())
                    .map(|value| value.to_string());
                let versions = package
                    .get("versions")
                    .and_then(|value| value.as_array())
                    .map(|versions| {
                        versions
                            .iter()
                            .enumerate()
                            .filter_map(|(index, version)| {
                                let key = version.get("uuid4")?.as_str()?.to_string();
                                let version_number = version
                                    .get("version_number")
                                    .and_then(|value| value.as_str())?
                                    .to_string();
                                let label = version
                                    .get("full_name")
                                    .and_then(|value| value.as_str())
                                    .map(|value| value.to_string());
                                let runtime = label
                                    .as_deref()
                                    .and_then(Self::infer_runtime_label_from_text)
                                    .or_else(|| {
                                        version
                                            .get("name")
                                            .and_then(|value| value.as_str())
                                            .and_then(Self::infer_runtime_label_from_text)
                                    });
                                let updated = version
                                    .get("date_updated")
                                    .and_then(|value| value.as_str())
                                    .map(|value| value.to_string())
                                    .or_else(|| {
                                        version
                                            .get("date_created")
                                            .and_then(|value| value.as_str())
                                            .map(|value| value.to_string())
                                    });

                                Some(LocalModSourceVersionOption {
                                    key,
                                    version: version_number,
                                    runtime,
                                    updated_at: updated,
                                    is_latest: index == 0,
                                    label,
                                })
                            })
                            .collect::<Vec<_>>()
                    })
                    .unwrap_or_default();

                let metadata = ModMetadata {
                    source: Some(ModSource::Thunderstore),
                    source_id: Some(format!("{}/{}", owner, package_name)),
                    source_version: None,
                    author: author.clone(),
                    mod_name: Some(display_name.clone()),
                    source_url: Some(
                        package
                            .get("package_url")
                            .and_then(|value| value.as_str())
                            .unwrap_or(&normalized_url)
                            .to_string(),
                    ),
                    summary: summary.clone(),
                    icon_url: icon_url.clone(),
                    icon_cache_path: None,
                    downloads,
                    likes_or_endorsements,
                    updated_at: updated_at.clone(),
                    tags: package
                        .get("categories")
                        .and_then(|value| value.as_array())
                        .map(|tags| {
                            tags.iter()
                                .filter_map(|tag| tag.as_str().map(|value| value.to_string()))
                                .collect::<Vec<_>>()
                        })
                        .filter(|tags| !tags.is_empty()),
                    installed_version: None,
                    library_added_at: None,
                    installed_at: None,
                    last_update_check: None,
                    metadata_last_refreshed: Some(Utc::now()),
                    update_available: None,
                    remote_version: None,
                    detected_runtime: None,
                    runtime_match: None,
                    mod_storage_id: None,
                    symlink_paths: None,
                    security_scan: None,
                };

                Ok(LocalSourcePreviewResolved {
                    preview: LocalModSourcePreview {
                        source: ModSource::Thunderstore,
                        source_id: metadata.source_id.clone().unwrap_or_default(),
                        source_url: metadata.source_url.clone().unwrap_or(normalized_url),
                        display_name,
                        author,
                        summary,
                        icon_url,
                        downloads,
                        likes_or_endorsements,
                        updated_at,
                        versions,
                    },
                    metadata,
                })
            }
            LinkedSourceProvider::NexusMods {
                game_id,
                mod_id,
                normalized_url,
            } => {
                let service = NexusModsService::new();
                let mod_data = service
                    .get_mod(&game_id, mod_id)
                    .await
                    .context("Failed to query Nexus Mods metadata")?;
                let files = service
                    .get_mod_files(&game_id, mod_id)
                    .await
                    .context("Failed to query Nexus Mods versions")?;

                let display_name = mod_data
                    .get("name")
                    .and_then(|value| value.as_str())
                    .unwrap_or("Unknown mod")
                    .to_string();
                let author = mod_data
                    .get("author")
                    .and_then(|value| value.as_str())
                    .map(|value| value.to_string());
                let summary = mod_data
                    .get("summary")
                    .and_then(|value| value.as_str())
                    .map(|value| value.to_string());
                let icon_url = mod_data
                    .get("picture_url")
                    .and_then(|value| value.as_str())
                    .map(|value| value.to_string());
                let downloads = mod_data
                    .get("mod_downloads")
                    .and_then(|value| value.as_u64());
                let likes_or_endorsements = mod_data
                    .get("endorsement_count")
                    .and_then(|value| value.as_i64());
                let updated_at = mod_data
                    .get("updated_time")
                    .or_else(|| mod_data.get("uploaded_time"))
                    .and_then(|value| value.as_str())
                    .map(|value| value.to_string());

                let mut versions = files
                    .into_iter()
                    .filter_map(|file| {
                        let file_id = file.get("file_id")?.as_u64()?;
                        let version = file
                            .get("version")
                            .or_else(|| file.get("mod_version"))
                            .and_then(|value| value.as_str())?
                            .to_string();
                        let label = file
                            .get("name")
                            .or_else(|| file.get("file_name"))
                            .and_then(|value| value.as_str())
                            .map(|value| value.to_string());
                        let runtime = label
                            .as_deref()
                            .and_then(Self::infer_runtime_label_from_text)
                            .or_else(|| {
                                file.get("category_name")
                                    .and_then(|value| value.as_str())
                                    .and_then(Self::infer_runtime_label_from_text)
                            });
                        let updated = file
                            .get("updated_time")
                            .and_then(|value| value.as_str())
                            .map(|value| value.to_string())
                            .or_else(|| {
                                file.get("uploaded_timestamp")
                                    .and_then(|value| value.as_i64())
                                    .and_then(|timestamp| Utc.timestamp_opt(timestamp, 0).single())
                                    .map(|value| value.to_rfc3339())
                            });
                        let is_latest = file
                            .get("is_primary")
                            .and_then(|value| value.as_bool())
                            .unwrap_or(false);

                        Some(LocalModSourceVersionOption {
                            key: file_id.to_string(),
                            version,
                            runtime,
                            updated_at: updated,
                            is_latest,
                            label,
                        })
                    })
                    .collect::<Vec<_>>();
                versions.sort_by(|left, right| {
                    right
                        .is_latest
                        .cmp(&left.is_latest)
                        .then_with(|| right.updated_at.cmp(&left.updated_at))
                        .then_with(|| right.version.cmp(&left.version))
                });

                let metadata = ModMetadata {
                    source: Some(ModSource::Nexusmods),
                    source_id: Some(mod_id.to_string()),
                    source_version: None,
                    author: author.clone(),
                    mod_name: Some(display_name.clone()),
                    source_url: Some(normalized_url.clone()),
                    summary: summary.clone(),
                    icon_url: icon_url.clone(),
                    icon_cache_path: None,
                    downloads,
                    likes_or_endorsements,
                    updated_at: updated_at.clone(),
                    tags: None,
                    installed_version: None,
                    library_added_at: None,
                    installed_at: None,
                    last_update_check: None,
                    metadata_last_refreshed: Some(Utc::now()),
                    update_available: None,
                    remote_version: None,
                    detected_runtime: None,
                    runtime_match: None,
                    mod_storage_id: None,
                    symlink_paths: None,
                    security_scan: None,
                };

                Ok(LocalSourcePreviewResolved {
                    preview: LocalModSourcePreview {
                        source: ModSource::Nexusmods,
                        source_id: metadata.source_id.clone().unwrap_or_default(),
                        source_url: normalized_url,
                        display_name,
                        author,
                        summary,
                        icon_url,
                        downloads,
                        likes_or_endorsements,
                        updated_at,
                        versions,
                    },
                    metadata,
                })
            }
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

    async fn infer_storage_id_from_symlink(
        &self,
        mod_file_path: &Path,
        storage_root: &Path,
    ) -> Option<String> {
        let metadata = fs::symlink_metadata(mod_file_path).await.ok()?;
        if !metadata.file_type().is_symlink() {
            if !metadata.is_file() {
                return None;
            }

            let file_name = mod_file_path.file_name()?;
            let mut matches = Vec::new();
            let mut entries = fs::read_dir(storage_root).await.ok()?;
            while let Some(entry) = entries.next_entry().await.ok()? {
                let entry_path = entry.path();
                if !entry.metadata().await.ok()?.is_dir() {
                    continue;
                }

                for bucket in ["Mods", "Plugins", "UserLibs"] {
                    let candidate = entry_path.join(bucket).join(file_name);
                    let Ok(candidate_metadata) = fs::metadata(&candidate).await else {
                        continue;
                    };
                    if !candidate_metadata.is_file() {
                        continue;
                    }
                    if Self::metadata_is_same_file(&metadata, &candidate_metadata)
                        || Self::paths_are_same_hard_link(mod_file_path, &candidate)
                    {
                        if let Some(storage_id) =
                            entry_path.file_name().and_then(|value| value.to_str())
                        {
                            matches.push(storage_id.to_string());
                        }
                    }
                }
            }

            matches.sort();
            matches.dedup();
            return (matches.len() == 1).then(|| matches.remove(0));
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

    async fn path_belongs_to_storage_source(&self, path: &Path, source_path: &Path) -> bool {
        let metadata = match fs::symlink_metadata(path).await {
            Ok(value) => value,
            Err(_) => return false,
        };
        if !metadata.file_type().is_symlink() {
            return false;
        }

        let link_target = match fs::read_link(path).await {
            Ok(value) => value,
            Err(_) => return false,
        };
        let resolved_target = if link_target.is_absolute() {
            link_target
        } else {
            match path.parent() {
                Some(parent) => parent.join(link_target),
                None => return false,
            }
        };

        let canonical_target = match fs::canonicalize(&resolved_target).await {
            Ok(value) => value,
            Err(_) => resolved_target,
        };
        let canonical_source = match fs::canonicalize(source_path).await {
            Ok(value) => value,
            Err(_) => source_path.to_path_buf(),
        };
        let source_is_dir = match fs::metadata(source_path).await {
            Ok(value) => value.is_dir(),
            Err(_) => false,
        };

        if source_is_dir {
            canonical_target.starts_with(&canonical_source)
        } else {
            canonical_target == canonical_source
        }
    }

    async fn path_matches_storage_source(&self, path: &Path, source_path: &Path) -> bool {
        let metadata = match fs::symlink_metadata(path).await {
            Ok(value) => value,
            Err(_) => return false,
        };

        if metadata.file_type().is_symlink() {
            return self.path_belongs_to_storage_source(path, source_path).await;
        }

        if !metadata.is_file() {
            return false;
        }

        let source_metadata = match fs::metadata(source_path).await {
            Ok(value) if value.is_file() => value,
            _ => return false,
        };

        if metadata.len() != source_metadata.len() {
            return false;
        }

        match (fs::read(path).await, fs::read(source_path).await) {
            (Ok(path_bytes), Ok(source_bytes)) => path_bytes == source_bytes,
            _ => false,
        }
    }

    async fn ensure_storage_symlinks_recursive(
        &self,
        source_dir: &Path,
        dest_dir: &Path,
        allow_dirs: bool,
        overwrite_existing: bool,
        symlink_paths: &mut Vec<String>,
    ) -> Result<()> {
        if !source_dir.exists() {
            return Ok(());
        }

        fs::create_dir_all(dest_dir).await?;

        let mut entries = fs::read_dir(source_dir).await?;
        while let Some(entry) = entries.next_entry().await? {
            let entry_path = entry.path();
            let file_name = entry_path
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or("");
            if file_name.is_empty() {
                continue;
            }

            let metadata = fs::metadata(&entry_path).await?;
            let dest_path = dest_dir.join(file_name);

            if metadata.is_dir() && !allow_dirs {
                Box::pin(self.ensure_storage_symlinks_recursive(
                    &entry_path,
                    &dest_path,
                    false,
                    overwrite_existing,
                    symlink_paths,
                ))
                .await?;
                continue;
            }

            if self.path_exists_or_symlink(&dest_path).await {
                if !overwrite_existing {
                    symlink_paths.push(dest_path.to_string_lossy().to_string());
                    continue;
                }

                let existing_meta = fs::symlink_metadata(&dest_path).await?;
                if existing_meta.file_type().is_symlink() {
                    self.remove_symlink(&dest_path).await?;
                } else if existing_meta.is_file() {
                    fs::remove_file(&dest_path).await?;
                } else if existing_meta.is_dir() {
                    fs::remove_dir_all(&dest_path).await?;
                }
            }

            if metadata.is_dir() {
                self.create_symlink_dir(&entry_path, &dest_path).await?;
            } else {
                self.create_symlink_file(&entry_path, &dest_path).await?;
            }
            symlink_paths.push(dest_path.to_string_lossy().to_string());
        }

        Ok(())
    }

    async fn recover_mod_metadata_from_storage(
        &self,
        mods_directory: &Path,
        metadata: &mut HashMap<String, ModMetadata>,
    ) -> Result<bool> {
        let storage_root = self.get_mods_storage_dir().await?;

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

    async fn find_confident_storage_metadata_by_file_name(
        &self,
        file_name: &str,
    ) -> Result<Option<ModMetadata>> {
        let storage_root = self.get_mods_storage_dir().await?;
        if !storage_root.exists() {
            return Ok(None);
        }

        let index = self.build_storage_file_index(&storage_root).await;
        let Some(storage_id) = Self::infer_storage_id_from_index(&index, file_name) else {
            return Ok(None);
        };

        let storage_path = Self::validated_storage_path(&storage_root, &storage_id)?;
        self.load_storage_metadata(&storage_path).await
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

    async fn load_storage_metadata_for_listing(&self, storage_id: &str) -> Option<ModMetadata> {
        let storage_root = match self.get_mods_storage_dir().await {
            Ok(storage_root) => storage_root,
            Err(error) => {
                log::warn!(
                    "Skipping storage metadata lookup for {}: {}",
                    storage_id,
                    error
                );
                return None;
            }
        };

        let storage_path = match Self::validated_storage_path(&storage_root, storage_id) {
            Ok(storage_path) => storage_path,
            Err(error) => {
                log::warn!(
                    "Skipping storage metadata lookup for invalid storage id {}: {}",
                    storage_id,
                    error
                );
                return None;
            }
        };

        match self.load_storage_metadata(&storage_path).await {
            Ok(metadata) => metadata,
            Err(error) => {
                log::warn!(
                    "Skipping storage metadata lookup for {}: {}",
                    storage_id,
                    error
                );
                None
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

    fn safe_installed_mod_relative_path(file_name: &str) -> Result<PathBuf> {
        let trimmed = file_name.trim();
        if trimmed.is_empty() {
            return Err(anyhow::anyhow!("Installed mod path is empty"));
        }

        let path = Path::new(trimmed);
        if path.is_absolute() {
            return Err(anyhow::anyhow!("Installed mod path is unsafe"));
        }

        let mut relative = PathBuf::new();
        for component in path.components() {
            match component {
                std::path::Component::Normal(value) => relative.push(value),
                std::path::Component::CurDir => {}
                _ => return Err(anyhow::anyhow!("Installed mod path is unsafe")),
            }
        }

        if relative.as_os_str().is_empty() {
            Err(anyhow::anyhow!("Installed mod path is unsafe"))
        } else {
            Ok(relative)
        }
    }

    pub async fn resolve_installed_mod_path(
        &self,
        game_dir: &str,
        file_name: &str,
    ) -> Result<PathBuf> {
        let relative_path = Self::safe_installed_mod_relative_path(file_name)?;
        let mods_directory = self.get_mods_directory(game_dir);
        let active_path = mods_directory.join(&relative_path);
        if active_path.exists() {
            return Ok(active_path);
        }

        let mut disabled_relative_path = relative_path.clone();
        let disabled_file_name = disabled_relative_path
            .file_name()
            .and_then(|value| value.to_str())
            .ok_or_else(|| anyhow::anyhow!("Unsafe installed mod path"))?;
        disabled_relative_path.set_file_name(format!("{disabled_file_name}.disabled"));
        let disabled_path = mods_directory.join(disabled_relative_path);
        if disabled_path.exists() {
            return Ok(disabled_path);
        }

        Err(anyhow::anyhow!("Installed mod file not found"))
    }

    pub async fn persist_installed_mod_security_scan_summary(
        &self,
        game_dir: &str,
        file_name: &str,
        summary: SecurityScanSummary,
    ) -> Result<()> {
        let mods_directory = self.get_mods_directory(game_dir);
        let resolved_path = self.resolve_installed_mod_path(game_dir, file_name).await?;
        let metadata_key = Self::metadata_key_for_resolved_mod(&mods_directory, &resolved_path)?;
        let mut metadata = self.load_mod_metadata(&mods_directory).await?;
        let entry = metadata
            .entry(metadata_key.clone())
            .or_insert_with(|| ModMetadata {
                source: Some(ModSource::Local),
                source_id: None,
                source_version: None,
                author: None,
                mod_name: Path::new(&metadata_key)
                    .file_name()
                    .and_then(|value| value.to_str())
                    .map(|value| value.replace(".dll", "").replace(".DLL", "")),
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

        entry.security_scan = Some(summary);
        self.save_mod_metadata(&mods_directory, &metadata).await
    }

    fn metadata_key_for_resolved_mod(
        mods_directory: &Path,
        resolved_path: &Path,
    ) -> Result<String> {
        let relative = resolved_path
            .strip_prefix(mods_directory)
            .context("Resolved mod path is outside the Mods directory")?;
        let mut key = relative.to_string_lossy().replace('\\', "/");
        if let Some(active_key) = key.strip_suffix(".disabled") {
            key = active_key.to_string();
        }
        Ok(key)
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

    pub async fn load_storage_metadata_by_id(
        &self,
        storage_id: &str,
    ) -> Result<Option<ModMetadata>> {
        let storage_root = self.get_mods_storage_dir().await?;
        let storage_path = Self::validated_storage_path(&storage_root, storage_id)?;
        self.load_storage_metadata(&storage_path).await
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
            self.collect_storage_files_recursive(&mods_dir, true, &mut files)
                .await?;
        }

        let plugins_dir = storage_path.join("Plugins");
        if plugins_dir.exists() {
            self.collect_storage_files_recursive(&plugins_dir, true, &mut files)
                .await?;
        }

        let userlibs_dir = storage_path.join("UserLibs");
        if userlibs_dir.exists() {
            self.collect_storage_files_recursive(&userlibs_dir, false, &mut files)
                .await?;
        }

        let userdata_dir = storage_path.join("UserData");
        if userdata_dir.exists() {
            self.collect_storage_files_recursive(&userdata_dir, false, &mut files)
                .await?;
        }

        Ok(files)
    }

    async fn collect_storage_payload_summary(
        &self,
        storage_path: &Path,
    ) -> Result<StoragePayloadSummary> {
        let mut summary = StoragePayloadSummary::default();

        let mods_dir = storage_path.join("Mods");
        if mods_dir.exists() {
            self.collect_storage_relative_files_recursive(
                &mods_dir,
                &mods_dir,
                true,
                &mut summary.primary_files,
            )
            .await?;
        }

        let plugins_dir = storage_path.join("Plugins");
        if plugins_dir.exists() {
            self.collect_storage_relative_files_recursive(
                &plugins_dir,
                &plugins_dir,
                true,
                &mut summary.primary_files,
            )
            .await?;
        }

        let userlibs_dir = storage_path.join("UserLibs");
        if userlibs_dir.exists() {
            self.collect_storage_relative_entries_recursive(
                &userlibs_dir,
                &userlibs_dir,
                &mut summary.attached_userlibs,
            )
            .await?;
        }

        let userdata_dir = storage_path.join("UserData");
        if userdata_dir.exists() {
            self.collect_storage_relative_entries_recursive(
                &userdata_dir,
                &userdata_dir,
                &mut summary.attached_userdata,
            )
            .await?;
        }

        Ok(summary)
    }

    async fn collect_storage_relative_files_recursive(
        &self,
        root: &Path,
        dir: &Path,
        dll_only: bool,
        files: &mut Vec<String>,
    ) -> Result<()> {
        let mut pending = vec![dir.to_path_buf()];

        while let Some(current) = pending.pop() {
            let mut entries = fs::read_dir(&current).await.with_context(|| {
                format!("Failed to read storage directory {}", current.display())
            })?;

            while let Some(entry) = entries.next_entry().await? {
                let path = entry.path();
                let metadata = fs::metadata(&path).await?;
                if metadata.is_dir() {
                    pending.push(path);
                    continue;
                }

                let Ok(relative) = path.strip_prefix(root) else {
                    continue;
                };
                let normalized = relative.to_string_lossy().replace('\\', "/");
                if normalized.is_empty() {
                    continue;
                }

                if dll_only {
                    let lower_name = normalized.to_lowercase();
                    if lower_name.ends_with(".dll") || lower_name.ends_with(".dll.disabled") {
                        files.push(normalized);
                    }
                } else {
                    files.push(normalized);
                }
            }
        }

        Ok(())
    }

    async fn collect_storage_files_recursive(
        &self,
        dir: &Path,
        dll_only: bool,
        files: &mut Vec<String>,
    ) -> Result<()> {
        let mut pending = vec![dir.to_path_buf()];

        while let Some(current) = pending.pop() {
            let mut entries = fs::read_dir(&current).await.with_context(|| {
                format!("Failed to read storage directory {}", current.display())
            })?;

            while let Some(entry) = entries.next_entry().await? {
                let path = entry.path();
                let metadata = fs::metadata(&path).await?;
                if metadata.is_dir() {
                    pending.push(path);
                    continue;
                }

                let file_name = path.file_name().and_then(|v| v.to_str()).unwrap_or("");
                if file_name.is_empty() {
                    continue;
                }

                if dll_only {
                    let lower_name = file_name.to_lowercase();
                    if lower_name.ends_with(".dll") || lower_name.ends_with(".dll.disabled") {
                        files.push(file_name.to_string());
                    }
                } else {
                    files.push(file_name.to_string());
                }
            }
        }

        Ok(())
    }

    async fn collect_storage_relative_entries_recursive(
        &self,
        root: &Path,
        dir: &Path,
        entries: &mut Vec<String>,
    ) -> Result<()> {
        let mut pending = vec![dir.to_path_buf()];

        while let Some(current) = pending.pop() {
            let mut read_dir = match fs::read_dir(&current).await {
                Ok(read_dir) => read_dir,
                Err(_) => continue,
            };

            while let Some(entry) = read_dir.next_entry().await? {
                let path = entry.path();
                let metadata = match entry.metadata().await {
                    Ok(metadata) => metadata,
                    Err(_) => continue,
                };

                if metadata.is_dir() {
                    pending.push(path.clone());
                    continue;
                }

                let Ok(relative) = path.strip_prefix(root) else {
                    continue;
                };

                let normalized = relative.to_string_lossy().replace('\\', "/");
                if !normalized.is_empty() {
                    entries.push(normalized);
                }
            }
        }

        Ok(())
    }

    async fn collect_mod_dll_entries_recursive(
        &self,
        root: &Path,
    ) -> Result<Vec<(String, String)>> {
        let mut pending = vec![root.to_path_buf()];
        let mut dll_files: Vec<(String, String)> = Vec::new();

        while let Some(current) = pending.pop() {
            let mut entries = fs::read_dir(&current)
                .await
                .with_context(|| format!("Failed to read Mods directory {}", current.display()))?;

            while let Some(entry) = entries.next_entry().await? {
                let path = entry.path();
                let metadata = entry.metadata().await?;

                if metadata.is_dir() {
                    pending.push(path);
                    continue;
                }

                let Ok(relative) = path.strip_prefix(root) else {
                    continue;
                };
                let relative_path = relative.to_string_lossy().replace('\\', "/");
                if relative_path.is_empty() {
                    continue;
                }

                let lower_name = relative_path.to_ascii_lowercase();
                if lower_name.ends_with(".dll") || lower_name.ends_with(".dll.disabled") {
                    dll_files.push((path.to_string_lossy().to_string(), relative_path));
                }
            }
        }

        Ok(dll_files)
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

    fn detect_zip_available_runtimes(&self, zip_path: &Path) -> Option<Vec<String>> {
        let file = File::open(zip_path).ok()?;
        let mut archive = ZipArchive::new(file).ok()?;
        let mut runtime_detection_files = Vec::new();

        for index in 0..archive.len() {
            let entry = archive.by_index(index).ok()?;
            let name = entry.name();
            if name.to_ascii_lowercase().ends_with(".dll") {
                runtime_detection_files.push(name.to_string());
            }
        }

        Some(self.detect_available_runtimes(&runtime_detection_files, None))
    }

    fn build_archive_runtime_mismatch_error(
        archive_name: &str,
        requested_runtime: &str,
        available_runtimes: &[String],
    ) -> String {
        format!(
            "{} does not contain files for the selected environment runtime ({}). The archive appears to support {}. Pick an environment with a matching runtime or use the matching archive for this environment.",
            archive_name,
            requested_runtime,
            available_runtimes.join(" and ")
        )
    }

    fn runtime_detection_files<'a>(&self, summary: &'a StoragePayloadSummary) -> &'a [String] {
        if summary.primary_files.is_empty() {
            &summary.attached_userlibs
        } else {
            &summary.primary_files
        }
    }

    fn storage_entry_supports_runtime(&self, entry_name: &str, runtime_label: &str) -> bool {
        let file_runtime = self.detect_mod_runtime_from_name(entry_name);
        file_runtime == "unknown" || file_runtime == runtime_label
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

    async fn storage_supports_runtime(
        &self,
        storage_root: &Path,
        storage_id: &str,
        metadata: &ModMetadata,
        requested_runtime: Option<&crate::types::Runtime>,
    ) -> Result<bool> {
        let Some(requested_runtime) = requested_runtime else {
            return Ok(true);
        };

        if let Some(detected_runtime) = metadata.detected_runtime.as_ref() {
            return Ok(detected_runtime == requested_runtime);
        }

        let storage_path = Self::validated_storage_path(storage_root, storage_id)?;
        if !storage_path.exists() {
            return Ok(false);
        }

        let payload_summary = self.collect_storage_payload_summary(&storage_path).await?;
        let available_runtimes = self.detect_available_runtimes(
            self.runtime_detection_files(&payload_summary),
            metadata.detected_runtime.clone(),
        );

        Ok(available_runtimes
            .iter()
            .any(|runtime| runtime == Self::runtime_label(requested_runtime)))
    }

    /// Find existing mod installation by source_id and source_version
    /// Returns the mod_storage_id if found, None otherwise
    pub async fn find_existing_mod_installation(
        &self,
        game_dir: &str,
        source_id: &Option<String>,
        source_version: &Option<String>,
        runtime: Option<crate::types::Runtime>,
    ) -> Result<Option<String>> {
        if source_id.is_none() || source_version.is_none() {
            // Can't match without source_id and source_version
            return Ok(None);
        }

        self.reconcile_tracked_mod_state().await?;

        let mods_directory = self.get_mods_directory(game_dir);
        let mod_metadata = self.load_mod_metadata(&mods_directory).await?;
        let storage_root = self.get_mods_storage_dir().await?;

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
                    let supports_runtime = self
                        .storage_supports_runtime(
                            &storage_root,
                            existing_storage_id,
                            meta,
                            runtime.as_ref(),
                        )
                        .await?;
                    log::debug!(
                        "Found installed source/version candidate: storage_id={}, source_id={}, source_version={}, requested_runtime={:?}, detected_runtime={:?}, supports_runtime={}",
                        existing_storage_id,
                        existing_source_id,
                        existing_source_version,
                        runtime,
                        meta.detected_runtime,
                        supports_runtime
                    );
                    if !supports_runtime {
                        continue;
                    }
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
        log::debug!(
            "Checking existing mod storage by source/version: source_id={}, source_version={}, requested_runtime={:?}",
            source_id,
            source_version,
            runtime
        );
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

            let payload_summary = self.collect_storage_payload_summary(&entry_path).await?;
            let available_runtimes = self.detect_available_runtimes(
                self.runtime_detection_files(&payload_summary),
                template_meta.detected_runtime.clone(),
            );

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

            log::debug!(
                "Candidate storage match for source/version: storage_id={}, detected_runtime={:?}, available_runtimes={:?}, supports_runtime={}, files={:?}",
                storage_id,
                template_meta.detected_runtime,
                available_runtimes,
                supports_runtime,
                self.runtime_detection_files(&payload_summary)
            );

            if supports_runtime {
                log::debug!(
                    "Reusing existing storage for source/version/runtime: storage_id={}, source_id={}, source_version={}, requested_runtime={:?}",
                    storage_id,
                    source_id,
                    source_version,
                    runtime
                );
                return Ok(Some(storage_id));
            }
        }

        log::debug!(
            "No existing storage found for source/version/runtime: source_id={}, source_version={}, requested_runtime={:?}",
            source_id,
            source_version,
            runtime
        );
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

    /// Creates a managed file link.
    /// On Windows, falls back to a hard link or a copied file when symlink privileges are unavailable.
    pub async fn create_symlink_file(&self, src: &Path, dst: &Path) -> Result<()> {
        let src_owned = src.to_owned();
        let dst_owned = dst.to_owned();
        tokio::task::spawn_blocking(move || {
            let materialized_via = {
            #[cfg(target_os = "windows")]
            {
                match std::os::windows::fs::symlink_file(&src_owned, &dst_owned) {
                    Ok(()) => "symlink",
                    Err(symlink_error)
                        if matches!(symlink_error.raw_os_error(), Some(1314) | Some(5)) =>
                    {
                        match std::fs::hard_link(&src_owned, &dst_owned) {
                            Ok(()) => {
                                log::warn!(
                                    "Symlink privilege unavailable for {}. Used hard-link fallback.",
                                    dst_owned.display()
                                );
                                "hard link"
                            }
                            Err(hard_link_error) => {
                                std::fs::copy(&src_owned, &dst_owned)
                                    .map_err(|copy_error| {
                                        anyhow::anyhow!(
                                            "Failed to create file symlink from {:?} to {:?}: {}. Hard-link fallback failed: {}. Copy fallback failed: {}",
                                            src_owned,
                                            dst_owned,
                                            symlink_error,
                                            hard_link_error,
                                            copy_error
                                        )
                                    })?;
                                log::warn!(
                                    "Symlink privilege unavailable for {}. Hard-link fallback failed: {}. Used copy fallback.",
                                    dst_owned.display(),
                                    hard_link_error
                                );
                                "copied file"
                            }
                        }
                    }
                    Err(e) => {
                        return Err(anyhow::anyhow!(
                            "Failed to create file symlink from {:?} to {:?}: {}",
                            src_owned,
                            dst_owned,
                            e
                        ));
                    }
                }
            }
            #[cfg(target_family = "unix")]
            {
                std::os::unix::fs::symlink(&src_owned, &dst_owned).map_err(|e| {
                    anyhow::anyhow!(
                        "Failed to create file symlink from {:?} to {:?}: {}",
                        src_owned,
                        dst_owned,
                        e
                    )
                })?;
                "symlink"
            }
            };
            eprintln!(
                "[create_symlink_file] Successfully materialized managed file from {:?} to {:?} via {}",
                src_owned,
                dst_owned,
                materialized_via
            );
            Ok(())
        })
        .await?
    }

    /// Creates a symbolic link for a directory.
    pub async fn create_symlink_dir(&self, src: &Path, dst: &Path) -> Result<()> {
        #[cfg(target_os = "windows")]
        {
            match std::os::windows::fs::symlink_dir(src, dst) {
                Ok(()) => return Ok(()),
                Err(error) if matches!(error.raw_os_error(), Some(1314) | Some(5)) => {
                    log::warn!(
                        "Symlink privilege unavailable for {}. Used directory copy fallback.",
                        dst.display()
                    );
                    self.copy_directory_recursive(src, dst).await?;
                    self.write_copy_fallback_marker(src, dst).await?;
                    return Ok(());
                }
                Err(error) => {
                    return Err(error).context(format!(
                        "Failed to create directory symlink from {:?} to {:?}",
                        src, dst
                    ));
                }
            }
        }

        #[cfg(target_family = "unix")]
        {
            let src_owned = src.to_owned();
            let dst_owned = dst.to_owned();
            tokio::task::spawn_blocking(move || {
                std::os::unix::fs::symlink(&src_owned, &dst_owned).context(format!(
                    "Failed to create directory symlink from {:?} to {:?}",
                    src_owned, dst_owned
                ))?;
                Ok(())
            })
            .await?
        }
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

    #[cfg(target_os = "windows")]
    fn metadata_is_same_file(_left: &std::fs::Metadata, _right: &std::fs::Metadata) -> bool {
        false
    }

    #[cfg(target_os = "windows")]
    fn file_identity(path: &Path) -> Option<(u32, u32, u32, u32)> {
        use std::iter;
        use std::os::windows::ffi::OsStrExt;
        use std::ptr;
        use winapi::um::fileapi::{
            CreateFileW, GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION, OPEN_EXISTING,
        };
        use winapi::um::handleapi::{CloseHandle, INVALID_HANDLE_VALUE};
        use winapi::um::winbase::FILE_FLAG_BACKUP_SEMANTICS;
        use winapi::um::winnt::{
            FILE_READ_ATTRIBUTES, FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE,
        };

        let wide_path: Vec<u16> = path
            .as_os_str()
            .encode_wide()
            .chain(iter::once(0))
            .collect();
        let handle = unsafe {
            CreateFileW(
                wide_path.as_ptr(),
                FILE_READ_ATTRIBUTES,
                FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                ptr::null_mut(),
                OPEN_EXISTING,
                FILE_FLAG_BACKUP_SEMANTICS,
                ptr::null_mut(),
            )
        };
        if handle == INVALID_HANDLE_VALUE {
            return None;
        }

        let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
        let ok = unsafe { GetFileInformationByHandle(handle, &mut info) };
        unsafe {
            CloseHandle(handle);
        }
        if ok == 0 || info.nNumberOfLinks <= 1 {
            return None;
        }

        Some((
            info.dwVolumeSerialNumber,
            info.nFileIndexHigh,
            info.nFileIndexLow,
            info.nNumberOfLinks,
        ))
    }

    #[cfg(target_os = "windows")]
    fn paths_are_same_hard_link(left: &Path, right: &Path) -> bool {
        match (Self::file_identity(left), Self::file_identity(right)) {
            (Some(left), Some(right)) => left == right,
            _ => false,
        }
    }

    #[cfg(not(target_os = "windows"))]
    fn metadata_is_same_file(left: &std::fs::Metadata, right: &std::fs::Metadata) -> bool {
        use std::os::unix::fs::MetadataExt;

        left.ino() == right.ino() && left.dev() == right.dev()
    }

    #[cfg(not(target_os = "windows"))]
    fn paths_are_same_hard_link(left: &Path, right: &Path) -> bool {
        match (std::fs::metadata(left), std::fs::metadata(right)) {
            (Ok(left), Ok(right)) if left.is_file() && right.is_file() => {
                Self::metadata_is_same_file(&left, &right)
            }
            _ => false,
        }
    }

    async fn path_is_hard_link_to_storage_source(&self, path: &Path, source_path: &Path) -> bool {
        let path_metadata = match fs::metadata(path).await {
            Ok(value) if value.is_file() => value,
            _ => return false,
        };
        let source_metadata = match fs::metadata(source_path).await {
            Ok(value) if value.is_file() => value,
            _ => return false,
        };

        Self::metadata_is_same_file(&path_metadata, &source_metadata)
            || Self::paths_are_same_hard_link(path, source_path)
    }

    fn tracked_candidate_paths(
        &self,
        output_dir: &str,
        file_name: &str,
        symlink_paths: Option<&Vec<String>>,
    ) -> Vec<PathBuf> {
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

        candidate_paths
    }

    async fn tracked_entry_owned_by_storage(
        &self,
        output_dir: &str,
        file_name: &str,
        storage_id: &str,
        symlink_paths: Option<&Vec<String>>,
        storage_root: &Path,
    ) -> bool {
        for path in self.tracked_candidate_paths(output_dir, file_name, symlink_paths) {
            if self
                .infer_storage_id_from_symlink(&path, storage_root)
                .await
                .as_deref()
                == Some(storage_id)
            {
                return true;
            }

            let storage_base = storage_root.join(storage_id);
            if let Some(source_path) =
                self.storage_source_path_for_env_path(&storage_base, output_dir, &path)
            {
                if self
                    .path_has_copy_fallback_marker(&path, &source_path, storage_id)
                    .await
                {
                    return true;
                }

                if self
                    .path_is_hard_link_to_storage_source(&path, &source_path)
                    .await
                {
                    return true;
                }
            }
        }

        false
    }

    async fn load_metadata_rows_for_storage(
        &self,
        output_dir: &str,
        storage_id: &str,
    ) -> Result<Vec<(String, String, ModMetadata)>> {
        let Some(env_id) = self.environment_id_for_dir(output_dir).await? else {
            return Ok(Vec::new());
        };

        let rows = sqlx::query_as::<_, (String, String, String)>(
            "SELECT kind, file_name, data FROM mod_metadata WHERE environment_id = ?",
        )
        .bind(&env_id)
        .fetch_all(&*self.pool)
        .await
        .context("Failed to load metadata rows for storage")?;

        Ok(rows
            .into_iter()
            .filter_map(|(kind, file_name, data)| {
                let meta = serde_json::from_str::<ModMetadata>(&data).ok()?;
                (meta.mod_storage_id.as_deref() == Some(storage_id))
                    .then_some((kind, file_name, meta))
            })
            .collect())
    }

    async fn load_raw_mod_metadata_entry(
        &self,
        output_dir: &str,
        file_name: &str,
    ) -> Result<Option<ModMetadata>> {
        let Some(env_id) = self.environment_id_for_dir(output_dir).await? else {
            return Ok(None);
        };

        let candidates = [file_name.to_string(), format!("{}.disabled", file_name)];
        for candidate in candidates {
            let row = sqlx::query_scalar::<_, String>(
                "SELECT data FROM mod_metadata WHERE environment_id = ? AND kind = 'mods' AND file_name = ? LIMIT 1",
            )
            .bind(&env_id)
            .bind(&candidate)
            .fetch_optional(&*self.pool)
            .await
            .context("Failed to load raw mod metadata entry")?;

            if let Some(data) = row {
                if let Ok(meta) = serde_json::from_str::<ModMetadata>(&data) {
                    return Ok(Some(meta));
                }
            }
        }

        Ok(None)
    }

    async fn try_load_raw_mod_metadata_entry(
        &self,
        output_dir: &str,
        file_name: &str,
    ) -> Option<ModMetadata> {
        match self
            .load_raw_mod_metadata_entry(output_dir, file_name)
            .await
        {
            Ok(entry) => entry,
            Err(error) => {
                log::debug!(
                    "Skipping managed metadata lookup for {} in {}: {}",
                    file_name,
                    output_dir,
                    error
                );
                None
            }
        }
    }

    fn storage_row_default_path(
        &self,
        output_dir: &str,
        kind: &str,
        file_name: &str,
    ) -> Option<PathBuf> {
        match kind {
            "mods" => Some(self.get_mods_directory(output_dir).join(file_name)),
            "plugins" => Some(self.get_plugins_directory(output_dir).join(file_name)),
            "userlibs" => Some(Path::new(output_dir).join("UserLibs").join(file_name)),
            "userdata" => Some(Path::new(output_dir).join("UserData").join(file_name)),
            _ => None,
        }
    }

    fn storage_source_path_for_env_path(
        &self,
        storage_base: &Path,
        output_dir: &str,
        env_path: &Path,
    ) -> Option<PathBuf> {
        let relative = env_path.strip_prefix(output_dir).ok()?;
        let mut components = relative.components();
        let bucket = match components.next()?.as_os_str().to_string_lossy().as_ref() {
            value if value.eq_ignore_ascii_case("Mods") => "Mods",
            value if value.eq_ignore_ascii_case("Plugins") => "Plugins",
            value if value.eq_ignore_ascii_case("UserLibs") => "UserLibs",
            value if value.eq_ignore_ascii_case("UserData") => "UserData",
            _ => return None,
        };

        let mut source_path = storage_base.join(bucket);
        let tail: Vec<String> = components
            .map(|component| component.as_os_str().to_string_lossy().to_string())
            .collect();
        if tail.is_empty() {
            return None;
        }

        for (index, component) in tail.iter().enumerate() {
            if index == tail.len() - 1 {
                source_path.push(component.trim_end_matches(".disabled"));
            } else {
                source_path.push(component);
            }
        }

        Some(source_path)
    }

    fn active_and_disabled_paths(&self, path: &Path) -> (PathBuf, PathBuf) {
        let path_string = path.to_string_lossy().to_string();
        if path_string.to_ascii_lowercase().ends_with(".disabled") {
            let active =
                PathBuf::from(path_string[..path_string.len() - ".disabled".len()].to_string());
            (active, path.to_path_buf())
        } else {
            (
                path.to_path_buf(),
                PathBuf::from(format!("{}.disabled", path_string)),
            )
        }
    }

    async fn toggle_storage_paths(
        &self,
        output_dir: &str,
        storage_id: &str,
        disable: bool,
    ) -> Result<bool> {
        let rows = self
            .load_metadata_rows_for_storage(output_dir, storage_id)
            .await?;
        if rows.is_empty() {
            return Ok(false);
        }

        let mut candidate_paths: HashSet<PathBuf> = HashSet::new();
        for (kind, file_name, meta) in rows {
            if let Some(paths) = meta.symlink_paths {
                for path in paths {
                    candidate_paths.insert(PathBuf::from(path));
                }
            } else if let Some(path) = self.storage_row_default_path(output_dir, &kind, &file_name)
            {
                candidate_paths.insert(path);
            }
        }

        let mut changed = false;
        for path in candidate_paths {
            let (active_path, disabled_path) = self.active_and_disabled_paths(&path);
            let from_path = if disable {
                &active_path
            } else {
                &disabled_path
            };
            let to_path = if disable {
                &disabled_path
            } else {
                &active_path
            };

            if !self.path_exists_or_symlink(from_path).await
                || self.path_exists_or_symlink(to_path).await
            {
                continue;
            }

            fs::rename(from_path, to_path).await.with_context(|| {
                format!(
                    "Failed to {} managed path {}",
                    if disable { "disable" } else { "enable" },
                    from_path.display()
                )
            })?;
            changed = true;
        }

        Ok(changed)
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

            if let Some(storage_id) = entry.mod_storage_id.as_deref() {
                let entry_owned = self
                    .tracked_entry_owned_by_storage(
                        output_dir,
                        &entry.file_name,
                        storage_id,
                        entry.symlink_paths.as_ref(),
                        &storage_root,
                    )
                    .await;
                if !entry_owned {
                    rows_to_delete.insert((entry.environment_id.clone(), entry.file_name.clone()));
                    affected_env_ids.insert(entry.environment_id.clone());
                }
                continue;
            }

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

        let storage_root = self.get_mods_storage_dir().await?;
        let mut metadata_changed = false;
        if !game_dir.is_empty() && !metadata.is_empty() {
            let mut stale_managed_entries = Vec::new();
            for (file_name, meta) in &metadata {
                let Some(storage_id) = meta.mod_storage_id.as_deref() else {
                    continue;
                };
                let owned = self
                    .tracked_entry_owned_by_storage(
                        game_dir,
                        file_name,
                        storage_id,
                        meta.symlink_paths.as_ref(),
                        &storage_root,
                    )
                    .await;
                if !owned {
                    stale_managed_entries.push(file_name.clone());
                }
            }

            if !stale_managed_entries.is_empty() {
                for file_name in stale_managed_entries {
                    metadata.remove(&file_name);
                }
                metadata_changed = true;
            }
        }

        if let Ok(repaired) = self
            .recover_mod_metadata_from_storage(mods_directory, &mut metadata)
            .await
        {
            metadata_changed |= repaired;
        }

        if metadata_changed {
            if let Err(err) = self.save_mod_metadata(mods_directory, &metadata).await {
                log::warn!(
                    "Failed to persist recovered mod metadata for {}: {}",
                    mods_directory.display(),
                    err
                );
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
        if let Ok(version) = self.extract_version_from_binary(dll_path).await {
            return Some(version);
        }

        None
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

        let dll_files = self
            .collect_mod_dll_entries_recursive(&mods_directory)
            .await?;

        // Load metadata
        let metadata = self
            .load_mod_metadata(&mods_directory)
            .await
            .unwrap_or_else(|_| HashMap::new());

        let mut mods = Vec::new();
        for (file_path, relative_path) in dll_files {
            let is_disabled = relative_path.to_lowercase().ends_with(".disabled");
            let original_relative_path = if is_disabled {
                relative_path.replace(".disabled", "")
            } else {
                relative_path.clone()
            };
            let original_file_name = Path::new(&original_relative_path)
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or(&original_relative_path)
                .to_string();
            let current_file_name = Path::new(&relative_path)
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or(&relative_path)
                .to_string();

            let mod_name = original_file_name.replace(".dll", "").replace(".DLL", "");

            // Get metadata
            let file_metadata = metadata
                .get(&original_relative_path)
                .or_else(|| metadata.get(&relative_path))
                .or_else(|| metadata.get(&original_file_name))
                .or_else(|| metadata.get(&current_file_name))
                .cloned();

            let mod_storage_id = file_metadata
                .as_ref()
                .and_then(|m| m.mod_storage_id.clone());
            let managed = mod_storage_id.is_some();
            let storage_metadata = if let Some(storage_id) = mod_storage_id.as_deref() {
                self.load_storage_metadata_for_listing(storage_id).await
            } else {
                None
            };
            let confident_hint_metadata = if managed {
                None
            } else {
                self.find_confident_storage_metadata_by_file_name(&original_file_name)
                    .await
                    .ok()
                    .flatten()
            };
            let display_metadata = match (managed, storage_metadata.clone(), file_metadata.clone())
            {
                (true, Some(storage), Some(file)) => Some(Self::merge_metadata(storage, file)),
                (true, Some(storage), None) => Some(storage),
                (_, _, file) => file,
            };

            // Prefer source_version (from package metadata) over installed_version (extracted from DLL).
            let version = display_metadata.as_ref().and_then(|meta| {
                meta.source_version
                    .clone()
                    .or(meta.installed_version.clone())
            });

            let source = display_metadata
                .as_ref()
                .and_then(|m| m.source.clone())
                .or_else(|| {
                    if managed {
                        None
                    } else {
                        Some(ModSource::Local)
                    }
                });
            let source_url = display_metadata
                .as_ref()
                .and_then(|m| m.source_url.clone())
                .or_else(|| {
                    confident_hint_metadata
                        .as_ref()
                        .and_then(|m| m.source_url.clone())
                });
            let author = display_metadata
                .as_ref()
                .and_then(|m| m.author.clone())
                .or_else(|| {
                    confident_hint_metadata
                        .as_ref()
                        .and_then(|meta| meta.author.clone())
                });
            let summary = display_metadata
                .as_ref()
                .and_then(|m| m.summary.clone())
                .or_else(|| {
                    confident_hint_metadata
                        .as_ref()
                        .and_then(|meta| meta.summary.clone())
                });
            let icon_url = display_metadata
                .as_ref()
                .and_then(|m| m.icon_url.clone())
                .or_else(|| {
                    confident_hint_metadata
                        .as_ref()
                        .and_then(|meta| meta.icon_url.clone())
                });
            let icon_cache_path = display_metadata
                .as_ref()
                .and_then(|m| m.icon_cache_path.clone())
                .or_else(|| {
                    confident_hint_metadata
                        .as_ref()
                        .and_then(|meta| meta.icon_cache_path.clone())
                });
            let downloads = display_metadata.as_ref().and_then(|m| m.downloads);
            let likes_or_endorsements = display_metadata
                .as_ref()
                .and_then(|m| m.likes_or_endorsements);
            let updated_at = display_metadata.as_ref().and_then(|m| m.updated_at.clone());
            let tags = display_metadata.as_ref().and_then(|m| m.tags.clone());
            let installed_at = file_metadata.as_ref().and_then(|m| m.installed_at);
            let security_scan = if let Some(storage_id) = mod_storage_id.as_deref() {
                self.resolve_storage_security_scan_summary(
                    storage_id,
                    file_metadata
                        .as_ref()
                        .and_then(|m| m.security_scan.clone())
                        .or_else(|| {
                            storage_metadata
                                .as_ref()
                                .and_then(|m| m.security_scan.clone())
                        }),
                )
                .await?
            } else {
                file_metadata.as_ref().and_then(|m| m.security_scan.clone())
            };

            mods.push(ModInfo {
                name: mod_name.clone(),
                file_name: original_relative_path,
                path: file_path,
                version,
                source,
                source_url,
                author,
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

    async fn ensure_linkable_local_mod(
        &self,
        game_dir: &str,
        file_name: &str,
    ) -> Result<(PathBuf, HashMap<String, ModMetadata>, Option<ModMetadata>)> {
        let mods_directory = self.get_mods_directory(game_dir);
        let metadata_map = self.load_mod_metadata(&mods_directory).await?;
        let entry_metadata = metadata_map.get(file_name).cloned();

        if entry_metadata
            .as_ref()
            .and_then(|meta| meta.mod_storage_id.as_ref())
            .is_some()
        {
            return Err(anyhow::anyhow!("Managed mods cannot be linked manually"));
        }

        let active_path = mods_directory.join(file_name);
        let disabled_path = mods_directory.join(format!("{}.disabled", file_name));
        if !active_path.exists() && !disabled_path.exists() {
            return Err(anyhow::anyhow!("Installed mod file not found"));
        }

        Ok((mods_directory, metadata_map, entry_metadata))
    }

    fn normalize_link_candidate_id(bucket: &str, relative_path: &str) -> String {
        format!("{}:{}", bucket, relative_path.replace('\\', "/"))
    }

    fn parse_link_candidate_id(candidate_id: &str) -> Option<(&str, &str)> {
        let (bucket, relative_path) = candidate_id.split_once(':')?;
        if relative_path.trim().is_empty() {
            return None;
        }
        Some((bucket, relative_path))
    }

    fn bucket_root_for_game_dir(&self, game_dir: &str, bucket: &str) -> Option<PathBuf> {
        match bucket {
            "mods" => Some(self.get_mods_directory(game_dir)),
            "plugins" => Some(self.get_plugins_directory(game_dir)),
            "userlibs" => Some(Path::new(game_dir).join("UserLibs")),
            "userdata" => Some(Path::new(game_dir).join("UserData")),
            _ => None,
        }
    }

    async fn collect_local_link_candidates_from_bucket(
        &self,
        bucket: &str,
        root: &Path,
        selected_file_name: &str,
        seeds: &[String],
        metadata_map: &HashMap<String, ModMetadata>,
        candidates: &mut Vec<LocalModOwnershipCandidate>,
    ) -> Result<()> {
        if !root.exists() {
            return Ok(());
        }

        let mut directories = vec![root.to_path_buf()];
        while let Some(current_dir) = directories.pop() {
            let mut entries = fs::read_dir(&current_dir).await?;
            while let Some(entry) = entries.next_entry().await? {
                let path = entry.path();
                let meta = entry.metadata().await?;
                if meta.is_dir() {
                    directories.push(path);
                    continue;
                }

                let file_name = path
                    .file_name()
                    .and_then(|value| value.to_str())
                    .unwrap_or_default()
                    .to_string();
                if file_name.is_empty() || file_name == selected_file_name {
                    continue;
                }

                let relative_path = path
                    .strip_prefix(root)
                    .unwrap_or(&path)
                    .to_string_lossy()
                    .replace('\\', "/");
                let relative_path_windows = relative_path.replace('/', "\\");
                if metadata_map
                    .get(&relative_path)
                    .or_else(|| metadata_map.get(&relative_path_windows))
                    .or_else(|| metadata_map.get(&file_name))
                    .and_then(|value| value.mod_storage_id.as_ref())
                    .is_some()
                {
                    continue;
                }

                let normalized_name = Self::normalize_local_link_name(&file_name);
                let normalized_relative_path = Self::normalize_local_link_name(&relative_path);
                if normalized_name.is_empty() && normalized_relative_path.is_empty() {
                    continue;
                }

                let matches_seed = seeds.iter().any(|seed| {
                    !seed.is_empty()
                        && ((normalized_name == *seed
                            || normalized_name.contains(seed)
                            || seed.contains(&normalized_name))
                            || (normalized_relative_path == *seed
                                || normalized_relative_path.contains(seed)
                                || seed.contains(&normalized_relative_path)))
                });
                if !matches_seed {
                    continue;
                }

                candidates.push(LocalModOwnershipCandidate {
                    id: Self::normalize_link_candidate_id(bucket, &relative_path),
                    bucket: bucket.to_string(),
                    relative_path,
                    file_name,
                });
            }
        }

        Ok(())
    }

    pub async fn preview_local_mod_source_link(
        &self,
        game_dir: &str,
        file_name: &str,
        source_url: &str,
    ) -> Result<LocalModSourcePreview> {
        let _ = self.ensure_linkable_local_mod(game_dir, file_name).await?;
        let resolved = self.resolve_local_mod_source_preview(source_url).await?;
        Ok(resolved.preview)
    }

    pub async fn get_local_mod_existing_source_hint(
        &self,
        game_dir: &str,
        file_name: &str,
    ) -> Result<Option<LocalModSourcePreview>> {
        let _ = self.ensure_linkable_local_mod(game_dir, file_name).await?;
        let Some(metadata) = self
            .find_confident_storage_metadata_by_file_name(file_name)
            .await?
        else {
            return Ok(None);
        };

        let Some(source_url) = metadata.source_url.as_deref() else {
            return Ok(None);
        };

        let resolved = self.resolve_local_mod_source_preview(source_url).await?;
        Ok(Some(resolved.preview))
    }

    pub async fn get_local_mod_ownership_candidates(
        &self,
        game_dir: &str,
        file_name: &str,
        linked_name: Option<&str>,
    ) -> Result<Vec<LocalModOwnershipCandidate>> {
        let (_, metadata_map, _) = self.ensure_linkable_local_mod(game_dir, file_name).await?;
        let mut seeds = vec![Self::normalize_local_link_name(file_name)];
        if let Some(name) = linked_name {
            let normalized = Self::normalize_local_link_name(name);
            if !normalized.is_empty() && !seeds.contains(&normalized) {
                seeds.push(normalized);
            }
        }

        let mut candidates = Vec::new();
        self.collect_local_link_candidates_from_bucket(
            "mods",
            &self.get_mods_directory(game_dir),
            file_name,
            &seeds,
            &metadata_map,
            &mut candidates,
        )
        .await?;
        self.collect_local_link_candidates_from_bucket(
            "plugins",
            &self.get_plugins_directory(game_dir),
            file_name,
            &seeds,
            &metadata_map,
            &mut candidates,
        )
        .await?;
        self.collect_local_link_candidates_from_bucket(
            "userlibs",
            &Path::new(game_dir).join("UserLibs"),
            file_name,
            &seeds,
            &metadata_map,
            &mut candidates,
        )
        .await?;
        self.collect_local_link_candidates_from_bucket(
            "userdata",
            &Path::new(game_dir).join("UserData"),
            file_name,
            &seeds,
            &metadata_map,
            &mut candidates,
        )
        .await?;
        candidates.sort_by(|left, right| {
            left.bucket
                .cmp(&right.bucket)
                .then_with(|| left.relative_path.cmp(&right.relative_path))
        });
        Ok(candidates)
    }

    async fn copy_selected_local_link_candidates_to_storage(
        &self,
        game_dir: &str,
        allowed_candidate_ids: &HashSet<String>,
        owned_file_ids: &[String],
        storage_mods: &Path,
        storage_plugins: &Path,
        storage_userlibs: &Path,
        storage_userdata: &Path,
    ) -> Result<()> {
        for candidate_id in owned_file_ids {
            if !allowed_candidate_ids.contains(candidate_id) {
                continue;
            }
            let Some((bucket, relative_path)) = Self::parse_link_candidate_id(candidate_id) else {
                continue;
            };
            let Some(source_root) = self.bucket_root_for_game_dir(game_dir, bucket) else {
                continue;
            };
            let source_path = source_root.join(relative_path);
            if !source_path.exists() {
                continue;
            }

            let destination_root = match bucket {
                "mods" => storage_mods,
                "plugins" => storage_plugins,
                "userlibs" => storage_userlibs,
                "userdata" => storage_userdata,
                _ => continue,
            };
            let destination_path = destination_root.join(relative_path);
            if let Some(parent) = destination_path.parent() {
                fs::create_dir_all(parent).await?;
            }
            fs::copy(&source_path, &destination_path)
                .await
                .with_context(|| {
                    format!(
                        "Failed to copy selected ownership candidate into storage: {}",
                        relative_path
                    )
                })?;
        }

        Ok(())
    }

    pub async fn promote_local_mod_to_managed(
        &self,
        game_dir: &str,
        file_name: &str,
        source_url: &str,
        selected_version: &str,
        owned_file_ids: &[String],
    ) -> Result<serde_json::Value> {
        let (mods_directory, _, existing_meta) =
            self.ensure_linkable_local_mod(game_dir, file_name).await?;
        let env_id = self
            .environment_id_for_dir(game_dir)
            .await?
            .ok_or_else(|| anyhow::anyhow!("Environment not found"))?;
        let resolved = self.resolve_local_mod_source_preview(source_url).await?;
        if selected_version.trim().is_empty() {
            return Err(anyhow::anyhow!("Selected version is required"));
        }

        let mut storage_metadata = resolved.metadata.clone();
        storage_metadata.source_version = Some(selected_version.trim().to_string());
        storage_metadata.installed_version = Some(selected_version.trim().to_string());
        storage_metadata.installed_at = Some(Utc::now());
        storage_metadata.library_added_at = Some(Utc::now());
        storage_metadata.metadata_last_refreshed = Some(Utc::now());
        storage_metadata.icon_cache_path = self
            .cache_icon_from_url(storage_metadata.icon_url.as_deref())
            .await;

        let mod_storage_dir = self.get_mods_storage_dir().await?;
        let storage_id = self.generate_mod_id();
        let storage_base = mod_storage_dir.join(&storage_id);
        let storage_mods = storage_base.join("Mods");
        let storage_plugins = storage_base.join("Plugins");
        let storage_userlibs = storage_base.join("UserLibs");
        let storage_userdata = storage_base.join("UserData");
        fs::create_dir_all(&storage_mods).await?;
        fs::create_dir_all(&storage_plugins).await?;
        fs::create_dir_all(&storage_userlibs).await?;
        fs::create_dir_all(&storage_userdata).await?;

        let selected_source_path = mods_directory.join(file_name);
        let selected_disabled_path = mods_directory.join(format!("{}.disabled", file_name));
        let (selected_existing_path, selected_was_disabled) = if selected_source_path.exists() {
            (selected_source_path, false)
        } else if selected_disabled_path.exists() {
            (selected_disabled_path, true)
        } else {
            return Err(anyhow::anyhow!("Installed mod file not found"));
        };

        fs::copy(&selected_existing_path, storage_mods.join(file_name))
            .await
            .context("Failed to copy selected mod into storage")?;

        let allowed_candidate_ids: HashSet<String> = self
            .get_local_mod_ownership_candidates(
                game_dir,
                file_name,
                Some(&resolved.preview.display_name),
            )
            .await?
            .into_iter()
            .map(|candidate| candidate.id)
            .collect();
        self.copy_selected_local_link_candidates_to_storage(
            game_dir,
            &allowed_candidate_ids,
            owned_file_ids,
            &storage_mods,
            &storage_plugins,
            &storage_userlibs,
            &storage_userdata,
        )
        .await?;

        if let Some(summary) = existing_meta.and_then(|meta| meta.security_scan) {
            storage_metadata.security_scan = Some(summary);
        }
        storage_metadata.mod_storage_id = Some(storage_id.clone());
        self.save_storage_metadata(&storage_base, &storage_metadata)
            .await?;

        self.install_storage_mod_to_envs(&storage_id, vec![env_id])
            .await?;
        if selected_was_disabled {
            self.disable_mod(game_dir, file_name).await?;
        }

        Ok(serde_json::json!({
            "success": true,
            "storageId": storage_id,
            "nameMismatchRequiresConfirmation": resolved
                .metadata
                .mod_name
                .as_ref()
                .map(|remote_name| Self::names_materially_differ(file_name, remote_name))
                .unwrap_or(false),
        }))
    }

    pub async fn get_mod_library(&self) -> Result<ModLibraryResult> {
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

            let payload_summary = self.collect_storage_payload_summary(&entry_path).await?;
            if payload_summary.primary_files.is_empty()
                && payload_summary.attached_userlibs.is_empty()
                && payload_summary.attached_userdata.is_empty()
            {
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
                payload_summary
                    .primary_files
                    .get(0)
                    .or_else(|| payload_summary.attached_userlibs.get(0))
                    .or_else(|| payload_summary.attached_userdata.get(0))
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

            let runtime_files = if payload_summary.primary_files.is_empty() {
                &payload_summary.attached_userlibs
            } else {
                &payload_summary.primary_files
            };
            let available_runtimes = self
                .detect_available_runtimes(runtime_files, template_meta.detected_runtime.clone());
            let files_by_runtime = self.build_files_by_runtime(runtime_files, &available_runtimes);

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
            let merged_into_existing = grouped.contains_key(&key);
            let key_for_debug = if merged_into_existing {
                Some(key.clone())
            } else {
                None
            };

            let entry = grouped.entry(key).or_insert_with(|| ModLibraryEntry {
                storage_id: storage_id.clone(),
                display_name: display_name.clone(),
                files: payload_summary.primary_files.clone(),
                attached_userlibs: payload_summary.attached_userlibs.clone(),
                attached_userdata: payload_summary.attached_userdata.clone(),
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

            if merged_into_existing {
                log::debug!(
                    "Merging storage into existing library entry: key={}, storage_id={}, display_name={}, source_id={:?}, source_version={:?}, available_runtimes={:?}, storage_ids_by_runtime={:?}",
                    key_for_debug.as_deref().unwrap_or_default(),
                    storage_id,
                    display_name,
                    template_meta.source_id,
                    template_meta.source_version,
                    available_runtimes,
                    storage_ids_by_runtime
                );
            }

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
            for file in payload_summary.primary_files {
                file_set.insert(file);
            }
            entry.files = file_set.into_iter().collect();

            let mut userlib_set: HashSet<String> =
                entry.attached_userlibs.iter().cloned().collect();
            for path in payload_summary.attached_userlibs {
                userlib_set.insert(path);
            }
            entry.attached_userlibs = userlib_set.into_iter().collect();

            let mut userdata_set: HashSet<String> =
                entry.attached_userdata.iter().cloned().collect();
            for path in payload_summary.attached_userdata {
                userdata_set.insert(path);
            }
            entry.attached_userdata = userdata_set.into_iter().collect();

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
            log::debug!(
                "Storing mod archive: original_file_name={}, source_id={}, source_version={}, requested_runtime={:?}, target={:?}",
                original_file_name,
                source_id,
                source_version,
                runtime,
                target
            );
            if let Ok(Some(existing_id)) = self
                .find_existing_mod_storage_by_source_version(
                    source_id,
                    source_version,
                    runtime.clone(),
                )
                .await
            {
                log::debug!(
                    "Store mod archive resolved to existing storage: original_file_name={}, source_id={}, source_version={}, requested_runtime={:?}, storage_id={}",
                    original_file_name,
                    source_id,
                    source_version,
                    runtime,
                    existing_id
                );
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
        let mod_storage_userdata = mod_storage_base.join("UserData");

        fs::create_dir_all(&mod_storage_mods)
            .await
            .context("Failed to create mod storage Mods directory")?;
        fs::create_dir_all(&mod_storage_plugins)
            .await
            .context("Failed to create mod storage Plugins directory")?;
        fs::create_dir_all(&mod_storage_userlibs)
            .await
            .context("Failed to create mod storage UserLibs directory")?;
        fs::create_dir_all(&mod_storage_userdata)
            .await
            .context("Failed to create mod storage UserData directory")?;

        let file_ext = archive_format_for_path(archive_path);

        let mut installed_files = Vec::new();
        if file_ext == "dll" {
            let bucket_target =
                Self::resolve_direct_file_bucket_target(target.as_deref(), archive_path);
            let file_name = if !original_file_name.is_empty() {
                original_file_name.to_string()
            } else {
                archive_path
                    .file_name()
                    .and_then(|n| n.to_str())
                    .unwrap_or("mod.dll")
                    .to_string()
            };
            let target_dir = match bucket_target {
                FomodDestinationKind::Plugins => &mod_storage_plugins,
                FomodDestinationKind::UserLibs => &mod_storage_userlibs,
                FomodDestinationKind::UserData => &mod_storage_userdata,
                FomodDestinationKind::Mods => &mod_storage_mods,
            };

            let dest_path = target_dir.join(&file_name);
            fs::copy(&archive_path, &dest_path)
                .await
                .context("Failed to store DLL file")?;
            installed_files.push(file_name);
        } else {
            let temp_dir = std::env::temp_dir().join(format!("mod-store-{}", Uuid::new_v4()));
            fs::create_dir_all(&temp_dir).await?;

            let runtime_label = runtime.as_ref().map(|r| Self::runtime_label(r));
            let result = match file_ext {
                "7z" => {
                    self.extract_and_install_7z(
                        archive_path,
                        &mod_storage_mods,
                        &mod_storage_plugins,
                        &mod_storage_userlibs,
                        &mod_storage_userdata,
                        &temp_dir,
                        runtime_label,
                    )
                    .await
                }
                "tar.gz" => {
                    self.extract_and_install_tar_gz(
                        archive_path,
                        &mod_storage_mods,
                        &mod_storage_plugins,
                        &mod_storage_userlibs,
                        &mod_storage_userdata,
                        &temp_dir,
                        runtime_label,
                    )
                    .await
                }
                "rar" => {
                    self.extract_and_install_rar(
                        archive_path,
                        &mod_storage_mods,
                        &mod_storage_plugins,
                        &mod_storage_userlibs,
                        &mod_storage_userdata,
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
                        &mod_storage_userdata,
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

        log::debug!(
            "Stored new mod archive: original_file_name={}, storage_id={}, source_id={:?}, source_version={:?}, requested_runtime={:?}, installed_files={:?}",
            original_file_name,
            mod_id,
            storage_metadata.source_id,
            storage_metadata.source_version,
            storage_metadata.detected_runtime,
            installed_files
        );

        Ok(serde_json::json!({
            "success": true,
            "storageId": mod_id,
            "installedFiles": installed_files,
        }))
    }

    async fn install_storage_entries(
        &self,
        source_root: &Path,
        source_dir: &Path,
        dest_dir: &Path,
        allow_dirs: bool,
        runtime_label: &str,
        template_meta: &Option<ModMetadata>,
        storage_id: &str,
        metadata_map: &mut HashMap<String, ModMetadata>,
        installed_files: &mut Vec<String>,
        warnings: &mut Vec<String>,
        env_runtime: &crate::types::Runtime,
    ) -> Result<()> {
        if !source_dir.exists() {
            eprintln!(
                "[install_storage_entries] Source dir does not exist: {}",
                source_dir.display()
            );
            return Ok(());
        }

        fs::create_dir_all(dest_dir)
            .await
            .context("Failed to create destination directory for storage installation")?;

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
            let relative_entry = path
                .strip_prefix(source_root)
                .ok()
                .map(|value| value.to_string_lossy().replace('\\', "/"))
                .unwrap_or_else(|| file_name.to_string());
            let file_runtime = self.detect_mod_runtime_from_name(&relative_entry);
            eprintln!("[install_storage_entries] Processing file: {}, detected runtime: {}, target runtime: {}",
                     relative_entry, file_runtime, runtime_label);

            if !self.storage_entry_supports_runtime(&relative_entry, runtime_label) {
                eprintln!("[install_storage_entries] Skipping file {} due to runtime mismatch (file: {}, env: {})",
                         relative_entry, file_runtime, runtime_label);
                continue;
            }

            if metadata.is_dir() && !allow_dirs {
                let dest_path = dest_dir.join(file_name);
                Box::pin(self.install_storage_entries(
                    source_root,
                    &path,
                    &dest_path,
                    false,
                    runtime_label,
                    template_meta,
                    storage_id,
                    metadata_map,
                    installed_files,
                    warnings,
                    env_runtime,
                ))
                .await?;
                continue;
            }

            let dest_path = dest_dir.join(file_name);
            if self.path_exists_or_symlink(&dest_path).await {
                let remove_result: Result<()> = async {
                    let meta = fs::symlink_metadata(&dest_path).await?;
                    if meta.file_type().is_symlink() {
                        self.remove_symlink(&dest_path).await?;
                    } else if meta.is_file() {
                        fs::remove_file(&dest_path).await?;
                    } else if meta.is_dir() {
                        fs::remove_dir_all(&dest_path).await?;
                    }
                    Ok(())
                }
                .await;

                if let Err(err) = remove_result {
                    warnings.push(format!(
                        "Skipped {}: failed to replace existing destination ({})",
                        dest_path.display(),
                        err
                    ));
                    continue;
                }
            }

            if metadata.is_dir() {
                eprintln!(
                    "[install_storage_entries] Creating directory symlink: {} -> {}",
                    path.display(),
                    dest_path.display()
                );
                if let Err(err) = self
                    .create_symlink_dir(&path, &dest_path)
                    .await
                    .with_context(|| {
                        format!(
                            "Failed to create directory symlink for storage entry {}",
                            file_name
                        )
                    })
                {
                    warnings.push(format!("Skipped {}: {}", dest_path.display(), err));
                    continue;
                }
                installed_files.push(relative_entry.clone());
                eprintln!("[install_storage_entries] Successfully created directory symlink and added {} to installed_files", file_name);
            } else {
                eprintln!(
                    "[install_storage_entries] Creating file symlink: {} -> {}",
                    path.display(),
                    dest_path.display()
                );
                if let Err(err) = self
                    .create_symlink_file(&path, &dest_path)
                    .await
                    .with_context(|| {
                        format!(
                            "Failed to create file symlink for storage entry {}",
                            file_name
                        )
                    })
                {
                    warnings.push(format!("Skipped {}: {}", dest_path.display(), err));
                    continue;
                }
                installed_files.push(relative_entry.clone());
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

            let mut meta = metadata_map
                .get(&relative_entry)
                .cloned()
                .unwrap_or(ModMetadata {
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
                    likes_or_endorsements: template_meta
                        .as_ref()
                        .and_then(|t| t.likes_or_endorsements),
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
            metadata_map.insert(relative_entry, meta);
        }

        eprintln!(
            "[install_storage_entries] Processed {} entries from {}, installed {} files",
            file_count,
            source_dir.display(),
            installed_files.len()
        );

        Ok(())
    }

    async fn remove_storage_payload_entries(
        &self,
        source_dir: &Path,
        dest_dir: &Path,
        removed_entries: &mut HashSet<String>,
    ) -> Result<()> {
        if !source_dir.exists() {
            return Ok(());
        }

        let mut entries = fs::read_dir(source_dir)
            .await
            .context("Failed to read storage directory for uninstall cleanup")?;
        while let Some(entry) = entries.next_entry().await? {
            let source_path = entry.path();
            let file_name = source_path
                .file_name()
                .and_then(|v| v.to_str())
                .unwrap_or("");
            if file_name.is_empty() {
                continue;
            }

            let dest_path = dest_dir.join(file_name);
            let metadata = fs::metadata(&source_path).await?;

            if metadata.is_dir() {
                Box::pin(self.remove_storage_payload_entries(
                    &source_path,
                    &dest_path,
                    removed_entries,
                ))
                .await?;

                if self.path_exists_or_symlink(&dest_path).await {
                    let should_remove = match fs::symlink_metadata(&dest_path).await {
                        Ok(dest_meta) if dest_meta.file_type().is_symlink() => {
                            self.path_belongs_to_storage_source(&dest_path, &source_path)
                                .await
                        }
                        Ok(dest_meta) if dest_meta.is_dir() => {
                            let mut dir_entries = fs::read_dir(&dest_path).await?;
                            dir_entries.next_entry().await?.is_none()
                        }
                        Ok(_) => false,
                        Err(_) => false,
                    };

                    if should_remove {
                        let _ = self.remove_path_if_exists(&dest_path).await?;
                    }
                }

                continue;
            }

            let mut removed = false;
            if self
                .path_matches_storage_source(&dest_path, &source_path)
                .await
            {
                if let Ok(did_remove) = self.remove_path_if_exists(&dest_path).await {
                    removed |= did_remove;
                }
            }
            let disabled_path = if file_name.ends_with(".disabled") {
                None
            } else {
                Some(PathBuf::from(format!(
                    "{}.disabled",
                    dest_path.to_string_lossy()
                )))
            };
            if let Some(disabled) = disabled_path {
                if self
                    .path_matches_storage_source(&disabled, &source_path)
                    .await
                {
                    if let Ok(did_remove) = self.remove_path_if_exists(&disabled).await {
                        removed |= did_remove;
                    }
                }
            }

            if removed {
                removed_entries.insert(file_name.to_string());
            }
        }

        Ok(())
    }

    fn warning_indicates_locked_target(warning: &str) -> bool {
        let lower = warning.to_ascii_lowercase();
        lower.contains("being used by another process")
            || lower.contains("sharing violation")
            || lower.contains("access is denied")
            || lower.contains("permission denied")
            || lower.contains("resource busy")
            || lower.contains("text file busy")
            || lower.contains("os error 32")
            || lower.contains("os error 5")
    }

    fn environment_game_process_is_running(env_output_dir: &Path) -> bool {
        let target = env_output_dir.to_string_lossy().to_string();
        if target.trim().is_empty() {
            return false;
        }

        #[cfg(windows)]
        {
            let script = r#"
$target = $env:SIMM_ENV_OUTPUT_DIR
if (-not $target) { exit 1 }
$target = [System.IO.Path]::GetFullPath($target)
$processes = Get-CimInstance Win32_Process -Filter "Name = 'Schedule I.exe'" -ErrorAction SilentlyContinue
foreach ($process in $processes) {
  $path = $process.ExecutablePath
  if (-not $path) { continue }
  $dir = Split-Path -Parent $path
  if (-not $dir) { continue }
  if ([System.StringComparer]::OrdinalIgnoreCase.Equals([System.IO.Path]::GetFullPath($dir), $target)) {
    exit 0
  }
}
exit 1
"#;

            return std::process::Command::new("powershell")
                .args(["-NoProfile", "-NonInteractive", "-Command", script])
                .env("SIMM_ENV_OUTPUT_DIR", &target)
                .output()
                .map(|output| output.status.success())
                .unwrap_or(false);
        }

        #[cfg(unix)]
        {
            return std::process::Command::new("pgrep")
                .args(["-f", &target])
                .output()
                .map(|output| output.status.success() && !output.stdout.is_empty())
                .unwrap_or(false);
        }

        #[cfg(not(any(windows, unix)))]
        {
            false
        }
    }

    fn build_storage_install_failure_message(
        storage_id: &str,
        env: &Environment,
        warnings: &[String],
        storage_mods_exists: bool,
        storage_plugins_exists: bool,
        storage_userlibs_exists: bool,
        storage_userdata_exists: bool,
        environment_running: bool,
    ) -> String {
        let first_warning = warnings.first().cloned().unwrap_or_default();
        let locked_warnings: Vec<&String> = warnings
            .iter()
            .filter(|warning| Self::warning_indicates_locked_target(warning))
            .collect();

        if !locked_warnings.is_empty() {
            let running_reason = if environment_running {
                format!(" Schedule I is currently running for {}.", env.name)
            } else {
                format!(
                    " This usually means Schedule I is still running for {}.",
                    env.name
                )
            };

            return format!(
                "Failed to install this mod into {} because SIMM could not replace one or more files in that environment. Windows reported that the destination files are in use.{} Close the game and then try again. Other possible causes include an open MelonLoader console, another tool watching the Mods folder, File Explorer or an IDE holding the file, or antivirus scanning the environment.\n\nFirst file error: {}",
                env.name,
                running_reason,
                first_warning
            );
        }

        if !warnings.is_empty() {
            return format!(
                "Failed to install this mod into {}. SIMM tried to copy files from storage {}, but every install step was skipped.\n\nFirst file error: {}\n\nChecked storage folders: Mods(exists={}), Plugins(exists={}), UserLibs(exists={}), UserData(exists={}).",
                env.name,
                storage_id,
                first_warning,
                storage_mods_exists,
                storage_plugins_exists,
                storage_userlibs_exists,
                storage_userdata_exists
            );
        }

        format!(
            "No mod files found in storage {}. Checked: Mods(exists={}), Plugins(exists={}), UserLibs(exists={}), UserData(exists={}). This usually means the mod archive was empty or contained no supported mod files.",
            storage_id,
            storage_mods_exists,
            storage_plugins_exists,
            storage_userlibs_exists,
            storage_userdata_exists
        )
    }

    pub async fn install_storage_mod_to_envs(
        &self,
        storage_id: &str,
        environment_ids: Vec<String>,
    ) -> Result<serde_json::Value> {
        log::debug!(
            "Installing storage mod to environments: storage_id={}, environment_ids={:?}",
            storage_id,
            environment_ids
        );
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
        let storage_userdata = storage_base.join("UserData");

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
        eprintln!(
            "[install_storage_mod_to_envs] UserData dir exists: {}, path: {}",
            storage_userdata.exists(),
            storage_userdata.display()
        );

        let template_meta = self
            .find_metadata_template_for_storage_id(storage_id)
            .await?;
        let mut results = Vec::new();

        let payload_summary = self.collect_storage_payload_summary(&storage_base).await?;
        let storage_metadata_on_disk = self.load_storage_metadata(&storage_base).await?;
        let storage_metadata_runtime = storage_metadata_on_disk
            .as_ref()
            .and_then(|m| m.detected_runtime.clone());
        let storage_available_runtimes = self.detect_available_runtimes(
            self.runtime_detection_files(&payload_summary),
            storage_metadata_runtime,
        );

        let mut resolved_env_installs: Vec<(Environment, crate::types::Runtime, &'static str)> =
            Vec::new();
        for env_id in &environment_ids {
            let env = self.load_environment(env_id).await?;
            let env_runtime = crate::services::environment::EnvironmentService::runtime_for_branch(
                &env.branch,
            )
            .or_else(|| {
                if env.output_dir.is_empty() {
                    None
                } else {
                    Some(
                        crate::services::environment::EnvironmentService::infer_runtime_from_installation_path(
                            Path::new(&env.output_dir),
                        ),
                    )
                }
            })
            .unwrap_or(env.runtime.clone());
            let runtime_label = Self::runtime_label(&env_runtime);
            if !storage_available_runtimes
                .iter()
                .any(|r| r == Self::runtime_label(&env_runtime))
            {
                return Err(anyhow::anyhow!(
                    "Mod storage {} is not compatible with environment {} (resolved runtime {:?} / {}). Storage supports these runtimes: {:?} (from metadata/files).",
                    storage_id,
                    env_id,
                    env_runtime,
                    runtime_label,
                    storage_available_runtimes
                ));
            }
            resolved_env_installs.push((env, env_runtime, runtime_label));
        }

        for (env, env_runtime, runtime_label) in resolved_env_installs {
            let env_id = env.id.clone();
            log::debug!(
                "Installing storage into environment: storage_id={}, environment_id={}, branch={}, resolved_runtime={}, storage_metadata_detected_runtime={:?}",
                storage_id,
                env_id,
                env.branch,
                runtime_label,
                storage_metadata_on_disk
                    .as_ref()
                    .and_then(|meta| meta.detected_runtime.clone())
            );

            let mods_dir = self.get_mods_directory(&env.output_dir);
            let plugins_dir = self.get_plugins_directory(&env.output_dir);
            let userlibs_dir = Path::new(&env.output_dir).join("UserLibs");
            let userdata_dir = Path::new(&env.output_dir).join("UserData");

            fs::create_dir_all(&mods_dir)
                .await
                .context("Failed to create mods directory")?;
            fs::create_dir_all(&plugins_dir)
                .await
                .context("Failed to create plugins directory")?;
            fs::create_dir_all(&userlibs_dir)
                .await
                .context("Failed to create userlibs directory")?;
            fs::create_dir_all(&userdata_dir)
                .await
                .context("Failed to create userdata directory")?;

            let mut metadata_map = self
                .load_mod_metadata(&mods_dir)
                .await
                .unwrap_or_else(|_| HashMap::new());
            let mut installed_files = Vec::new();
            let mut warnings = Vec::new();

            self.install_storage_entries(
                &storage_mods,
                &storage_mods,
                &mods_dir,
                false,
                runtime_label,
                &template_meta,
                storage_id,
                &mut metadata_map,
                &mut installed_files,
                &mut warnings,
                &env_runtime,
            )
            .await?;
            self.install_storage_entries(
                &storage_plugins,
                &storage_plugins,
                &plugins_dir,
                false,
                runtime_label,
                &template_meta,
                storage_id,
                &mut metadata_map,
                &mut installed_files,
                &mut warnings,
                &env_runtime,
            )
            .await?;
            self.install_storage_entries(
                &storage_userlibs,
                &storage_userlibs,
                &userlibs_dir,
                true,
                runtime_label,
                &template_meta,
                storage_id,
                &mut metadata_map,
                &mut installed_files,
                &mut warnings,
                &env_runtime,
            )
            .await?;
            self.install_storage_entries(
                &storage_userdata,
                &storage_userdata,
                &userdata_dir,
                true,
                runtime_label,
                &template_meta,
                storage_id,
                &mut metadata_map,
                &mut installed_files,
                &mut warnings,
                &env_runtime,
            )
            .await?;

            if installed_files.is_empty() {
                let environment_running =
                    Self::environment_game_process_is_running(Path::new(&env.output_dir));
                return Err(anyhow::anyhow!(
                    Self::build_storage_install_failure_message(
                        storage_id,
                        &env,
                        &warnings,
                        storage_mods.exists(),
                        storage_plugins.exists(),
                        storage_userlibs.exists(),
                        storage_userdata.exists(),
                        environment_running,
                    )
                ));
            }

            eprintln!(
                "[install_storage_mod_to_envs] Installed {} files for env {}",
                installed_files.len(),
                env_id
            );
            let all_symlink_paths: Vec<String> = metadata_map
                .values()
                .filter(|meta| meta.mod_storage_id.as_deref() == Some(storage_id))
                .flat_map(|meta| meta.symlink_paths.clone().unwrap_or_default())
                .collect::<HashSet<_>>()
                .into_iter()
                .collect();
            if !all_symlink_paths.is_empty() {
                for meta in metadata_map.values_mut() {
                    if meta.mod_storage_id.as_deref() == Some(storage_id) {
                        meta.symlink_paths = Some(all_symlink_paths.clone());
                    }
                }
            }
            log::debug!(
                "Completed storage install for environment: storage_id={}, environment_id={}, runtime={}, installed_files={:?}, warnings={:?}",
                storage_id,
                env_id,
                runtime_label,
                installed_files,
                warnings
            );

            self.save_mod_metadata(&mods_dir, &metadata_map).await?;
            results.push(serde_json::json!({
                "environmentId": env_id,
                "installedFiles": installed_files,
                "warnings": warnings,
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
        let storage_dir = self.get_mods_storage_dir().await?;
        let storage_base = Self::validated_storage_path(&storage_dir, storage_id)?;

        for env_id in environment_ids {
            let env = self.load_environment(&env_id).await?;
            let mods_dir = self.get_mods_directory(&env.output_dir);
            let plugins_dir = self.get_plugins_directory(&env.output_dir);
            let userlibs_dir = Path::new(&env.output_dir).join("UserLibs");
            let userdata_dir = Path::new(&env.output_dir).join("UserData");
            let mut metadata_map = self
                .load_mod_metadata(&mods_dir)
                .await
                .unwrap_or_else(|_| HashMap::new());

            let mut removed_files: HashSet<String> = HashSet::new();
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
                        let matches_source_path = if let Some(source_path) = self
                            .storage_source_path_for_env_path(&storage_base, &env.output_dir, path)
                        {
                            self.path_matches_storage_source(path, &source_path).await
                        } else {
                            false
                        };
                        if self
                            .infer_storage_id_from_symlink(path, &storage_dir)
                            .await
                            .as_deref()
                            == Some(storage_id)
                            || matches_source_path
                        {
                            if let Ok(did_remove) = self.remove_path_if_exists(path).await {
                                removed |= did_remove;
                            }
                        }
                        if let Some(disabled) = disabled_path {
                            let matches_disabled_source_path = if let Some(source_path) = self
                                .storage_source_path_for_env_path(
                                    &storage_base,
                                    &env.output_dir,
                                    &disabled,
                                ) {
                                self.path_matches_storage_source(&disabled, &source_path)
                                    .await
                            } else {
                                false
                            };
                            if self
                                .infer_storage_id_from_symlink(&disabled, &storage_dir)
                                .await
                                .as_deref()
                                == Some(storage_id)
                                || matches_disabled_source_path
                            {
                                if let Ok(did_remove) = self.remove_path_if_exists(&disabled).await
                                {
                                    removed |= did_remove;
                                }
                            }
                        }
                    }
                } else {
                    let candidate_paths = vec![
                        (
                            mods_dir.join(&file_name),
                            storage_base.join("Mods").join(&file_name),
                        ),
                        (
                            plugins_dir.join(&file_name),
                            storage_base.join("Plugins").join(&file_name),
                        ),
                        (
                            userlibs_dir.join(&file_name),
                            storage_base.join("UserLibs").join(&file_name),
                        ),
                        (
                            userdata_dir.join(&file_name),
                            storage_base.join("UserData").join(&file_name),
                        ),
                    ];

                    for (path, source_path) in candidate_paths {
                        let disabled_path = if file_name.ends_with(".disabled") {
                            None
                        } else {
                            Some(PathBuf::from(format!(
                                "{}.disabled",
                                path.to_string_lossy()
                            )))
                        };
                        if self.path_matches_storage_source(&path, &source_path).await {
                            if let Ok(did_remove) = self.remove_path_if_exists(&path).await {
                                removed |= did_remove;
                            }
                        }
                        if let Some(disabled) = disabled_path {
                            if self
                                .path_matches_storage_source(&disabled, &source_path)
                                .await
                            {
                                if let Ok(did_remove) = self.remove_path_if_exists(&disabled).await
                                {
                                    removed |= did_remove;
                                }
                            }
                        }
                    }
                }

                if removed {
                    removed_files.insert(file_name.clone());
                }
                metadata_map.remove(&file_name);
            }

            self.remove_storage_payload_entries(
                &storage_base.join("Mods"),
                &mods_dir,
                &mut removed_files,
            )
            .await?;
            self.remove_storage_payload_entries(
                &storage_base.join("Plugins"),
                &plugins_dir,
                &mut removed_files,
            )
            .await?;
            self.remove_storage_payload_entries(
                &storage_base.join("UserLibs"),
                &userlibs_dir,
                &mut removed_files,
            )
            .await?;
            self.remove_storage_payload_entries(
                &storage_base.join("UserData"),
                &userdata_dir,
                &mut removed_files,
            )
            .await?;

            self.save_mod_metadata(&mods_dir, &metadata_map).await?;

            results.push(serde_json::json!({
                "environmentId": env_id,
                "removedFiles": removed_files.into_iter().collect::<Vec<_>>(),
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

        let managed_meta = self
            .try_load_raw_mod_metadata_entry(game_dir, mod_file_name)
            .await;
        let env_id = self.environment_id_for_dir(game_dir).await?;
        if let Some(storage_id) = managed_meta
            .as_ref()
            .and_then(|meta| meta.mod_storage_id.clone())
        {
            if let Some(env_id) = env_id {
                let uninstall_result = self
                    .uninstall_storage_mod_from_envs(&storage_id, vec![env_id])
                    .await?;
                let removed_any = uninstall_result
                    .get("results")
                    .and_then(|value| value.as_array())
                    .is_some_and(|results| {
                        results.iter().any(|result| {
                            result
                                .get("removedFiles")
                                .and_then(|value| value.as_array())
                                .is_some_and(|files| !files.is_empty())
                        })
                    });
                if removed_any {
                    return Ok(());
                }
            }
        }

        if let Some(meta) = managed_meta.as_ref() {
            let mut removed_any = false;
            let mut candidate_paths: HashSet<PathBuf> = self
                .tracked_candidate_paths(game_dir, mod_file_name, meta.symlink_paths.as_ref())
                .into_iter()
                .collect();
            candidate_paths.insert(mod_path.clone());
            candidate_paths.insert(disabled_path.clone());

            for path in candidate_paths {
                removed_any |= self.remove_path_if_exists(&path).await?;
            }

            if removed_any {
                let mut metadata_map = self
                    .load_mod_metadata(&mods_directory)
                    .await
                    .unwrap_or_else(|_| HashMap::new());
                metadata_map.remove(mod_file_name);
                self.save_mod_metadata(&mods_directory, &metadata_map)
                    .await?;
                return Ok(());
            }
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

        if let Some(storage_id) = self
            .try_load_raw_mod_metadata_entry(game_dir, mod_file_name)
            .await
            .and_then(|meta| meta.mod_storage_id)
        {
            if self
                .toggle_storage_paths(game_dir, &storage_id, true)
                .await?
            {
                return Ok(());
            }
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

        if let Some(storage_id) = self
            .try_load_raw_mod_metadata_entry(game_dir, mod_file_name)
            .await
            .and_then(|meta| meta.mod_storage_id)
        {
            if self
                .toggle_storage_paths(game_dir, &storage_id, false)
                .await?
            {
                return Ok(());
            }
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
        branch: &str,
        metadata: Option<serde_json::Value>,
    ) -> Result<serde_json::Value> {
        eprintln!("[DEBUG] install_zip_mod: Starting symlink-based installation");
        eprintln!("[DEBUG] install_zip_mod called with runtime: '{}'", runtime);

        // Create game directories if they don't exist (for symlinks)
        let mods_directory = self.get_mods_directory(game_dir);
        let plugins_directory = self.get_plugins_directory(game_dir);
        let userlibs_directory = Path::new(game_dir).join("UserLibs");
        let userdata_directory = Path::new(game_dir).join("UserData");

        fs::create_dir_all(&mods_directory).await?;
        fs::create_dir_all(&plugins_directory).await?;
        fs::create_dir_all(&userlibs_directory).await?;
        fs::create_dir_all(&userdata_directory).await?;

        // Single canonical runtime for duplicate detection, extraction, symlinks, and metadata
        let normalized_runtime = self
            .resolve_env_runtime_for_zip_install(game_dir, branch, runtime)
            .await?;
        let normalized_runtime_label = Self::runtime_label(&normalized_runtime);
        eprintln!(
            "[DEBUG] install_zip_mod: normalized_runtime={:?} label={}",
            normalized_runtime, normalized_runtime_label
        );

        // Create temp directory for extraction
        let temp_dir = std::env::temp_dir().join(format!("mod-{}", Uuid::new_v4()));

        fs::create_dir_all(&temp_dir).await?;

        // Check for Thunderstore manifest.json
        let archive_path = Path::new(zip_path);
        if let Some(available_runtimes) = self.detect_zip_available_runtimes(archive_path) {
            if !available_runtimes
                .iter()
                .any(|runtime| runtime == normalized_runtime_label)
            {
                let _ = fs::remove_dir_all(&temp_dir).await;
                return Ok(serde_json::json!({
                    "success": false,
                    "error": Self::build_archive_runtime_mismatch_error(
                        _file_name,
                        normalized_runtime_label,
                        &available_runtimes,
                    )
                }));
            }
        }

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

        // Check if we already have this mod/version installed (canonical runtime)
        let existing_mod_id = self
            .find_existing_mod_installation(
                game_dir,
                &source_id,
                &source_version,
                Some(normalized_runtime.clone()),
            )
            .await?;

        // If mod is already installed, skip extraction and just ensure symlinks exist
        if let Some(existing_id) = existing_mod_id {
            eprintln!("[DEBUG] install_zip_mod: Mod/version already installed with mod_id: {}, skipping extraction", existing_id);

            let mod_storage_dir = self.get_mods_storage_dir().await?;
            let mod_storage_base = mod_storage_dir.join(&existing_id);
            let mod_storage_mods = mod_storage_base.join("Mods");
            let mod_storage_plugins = mod_storage_base.join("Plugins");
            let mod_storage_userlibs = mod_storage_base.join("UserLibs");
            let mod_storage_userdata = mod_storage_base.join("UserData");

            // Clean up temp directory (we don't need it)
            let _ = fs::remove_dir_all(&temp_dir).await;

            let env_runtime = normalized_runtime.clone();
            let runtime_label = normalized_runtime_label;
            let template_meta = self
                .find_metadata_template_for_storage_id(&existing_id)
                .await?;
            let mut metadata_map = self
                .load_mod_metadata(&mods_directory)
                .await
                .unwrap_or_else(|_| HashMap::new());
            let mut installed_files = Vec::new();
            let mut warnings = Vec::new();

            self.install_storage_entries(
                &mod_storage_mods,
                &mod_storage_mods,
                &mods_directory,
                false,
                runtime_label,
                &template_meta,
                &existing_id,
                &mut metadata_map,
                &mut installed_files,
                &mut warnings,
                &env_runtime,
            )
            .await?;
            self.install_storage_entries(
                &mod_storage_plugins,
                &mod_storage_plugins,
                &plugins_directory,
                false,
                runtime_label,
                &template_meta,
                &existing_id,
                &mut metadata_map,
                &mut installed_files,
                &mut warnings,
                &env_runtime,
            )
            .await?;
            self.install_storage_entries(
                &mod_storage_userlibs,
                &mod_storage_userlibs,
                &userlibs_directory,
                true,
                runtime_label,
                &template_meta,
                &existing_id,
                &mut metadata_map,
                &mut installed_files,
                &mut warnings,
                &env_runtime,
            )
            .await?;
            self.install_storage_entries(
                &mod_storage_userdata,
                &mod_storage_userdata,
                &userdata_directory,
                true,
                runtime_label,
                &template_meta,
                &existing_id,
                &mut metadata_map,
                &mut installed_files,
                &mut warnings,
                &env_runtime,
            )
            .await?;

            self.save_mod_metadata(&mods_directory, &metadata_map)
                .await?;

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
        let mod_storage_userdata = mod_storage_base.join("UserData");

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
        fs::create_dir_all(&mod_storage_userdata)
            .await
            .context("Failed to create mod storage UserData directory")?;

        // Detect file type and call appropriate extraction function
        let file_ext = archive_format_for_path(archive_path);

        eprintln!("[DEBUG] Archive file: {}", zip_path);
        eprintln!("[DEBUG] Detected extension: {}", file_ext);

        // Extract to storage (extraction methods now copy to mod_storage_base instead of game directories)
        let installed_files = match file_ext {
            "7z" => {
                eprintln!("[DEBUG] Using 7z extraction");
                match self
                    .extract_and_install_7z(
                        archive_path,
                        &mod_storage_mods,
                        &mod_storage_plugins,
                        &mod_storage_userlibs,
                        &mod_storage_userdata,
                        &temp_dir,
                        Some(normalized_runtime_label),
                    )
                    .await
                {
                    Ok(files) => files,
                    Err(e) => {
                        let _ = fs::remove_dir_all(&temp_dir).await;
                        let error_msg = format!("7z extraction failed: {}", e);
                        eprintln!("[ERROR] {}", error_msg);
                        return Ok(serde_json::json!({
                            "success": false,
                            "error": error_msg
                        }));
                    }
                }
            }
            "tar.gz" => {
                eprintln!("[DEBUG] Using tar.gz extraction");
                match self
                    .extract_and_install_tar_gz(
                        archive_path,
                        &mod_storage_mods,
                        &mod_storage_plugins,
                        &mod_storage_userlibs,
                        &mod_storage_userdata,
                        &temp_dir,
                        Some(normalized_runtime_label),
                    )
                    .await
                {
                    Ok(files) => files,
                    Err(e) => {
                        let _ = fs::remove_dir_all(&temp_dir).await;
                        let error_msg = format!("tar.gz extraction failed: {}", e);
                        eprintln!("[ERROR] {}", error_msg);
                        return Ok(serde_json::json!({
                            "success": false,
                            "error": error_msg
                        }));
                    }
                }
            }
            "rar" => {
                eprintln!("[DEBUG] Using RAR extraction");
                match self
                    .extract_and_install_rar(
                        archive_path,
                        &mod_storage_mods,
                        &mod_storage_plugins,
                        &mod_storage_userlibs,
                        &mod_storage_userdata,
                        &temp_dir,
                        Some(normalized_runtime_label),
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
                        &mod_storage_userdata,
                        &temp_dir,
                        Some(normalized_runtime_label),
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

        self.ensure_storage_symlinks_recursive(
            &mod_storage_mods,
            &mods_directory,
            false,
            true,
            &mut symlink_paths,
        )
        .await?;
        self.ensure_storage_symlinks_recursive(
            &mod_storage_plugins,
            &plugins_directory,
            false,
            true,
            &mut symlink_paths,
        )
        .await?;
        self.ensure_storage_symlinks_recursive(
            &mod_storage_userlibs,
            &userlibs_directory,
            true,
            true,
            &mut symlink_paths,
        )
        .await?;
        self.ensure_storage_symlinks_recursive(
            &mod_storage_userdata,
            &userdata_directory,
            true,
            true,
            &mut symlink_paths,
        )
        .await?;

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

        let env_runtime = normalized_runtime.clone();

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

        // Also save storage metadata so the library can access runtime info even if the
        // installed payload only lives in UserLibs and did not generate a Mods metadata row.
        let storage_runtime = match metadata_detected_runtime
            .map(|value| value.to_lowercase())
            .as_deref()
        {
            Some("il2cpp") => Some(crate::types::Runtime::Il2cpp),
            Some("mono") => Some(crate::types::Runtime::Mono),
            _ => Some(normalized_runtime.clone()),
        };
        let fallback_storage_meta = ModMetadata {
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
            installed_version: source_version.clone(),
            library_added_at: Some(Utc::now()),
            installed_at: Some(Utc::now()),
            last_update_check: None,
            metadata_last_refreshed: Some(Utc::now()),
            update_available: None,
            remote_version: None,
            detected_runtime: storage_runtime,
            runtime_match: None,
            mod_storage_id: Some(mod_id.clone()),
            symlink_paths: Some(symlink_paths.clone()),
            security_scan: metadata_ref.and_then(Self::security_scan_summary_from_metadata),
        };
        if let Some(meta) = mod_metadata
            .values()
            .find(|meta| meta.mod_storage_id.as_deref() == Some(mod_id.as_str()))
        {
            self.save_storage_metadata(&mod_storage_base, meta).await?;
        } else {
            self.save_storage_metadata(&mod_storage_base, &fallback_storage_meta)
                .await?;
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

    fn is_ignored_thunderstore_package_entry(file_name: &str) -> bool {
        matches!(
            file_name.to_ascii_lowercase().as_str(),
            "manifest.json" | "readme.md" | "changelog.md" | "license" | "license.md" | "icon.png"
        )
    }

    async fn copy_loose_archive_payload_to_mods(
        &self,
        entry_path: &Path,
        file_name: &str,
        mods_dir: &Path,
        runtime: Option<&str>,
        installed_files: &mut Vec<String>,
    ) -> Result<()> {
        let dest_path = mods_dir.join(file_name);
        let metadata = fs::metadata(entry_path).await?;

        if metadata.is_dir() {
            Box::pin(self.copy_directory_filtered(
                entry_path,
                &dest_path,
                runtime,
                installed_files,
            ))
            .await?;
            return Ok(());
        }

        let lower_name = file_name.to_ascii_lowercase();
        if lower_name.ends_with(".dll") {
            let file_runtime = self.detect_mod_runtime_from_name(file_name);
            let matches_runtime = match runtime {
                Some(target) => file_runtime == target || file_runtime == "unknown",
                None => true,
            };
            if !matches_runtime {
                return Ok(());
            }
            installed_files.push(file_name.to_string());
        }

        if let Some(parent) = dest_path.parent() {
            fs::create_dir_all(parent).await?;
        }
        fs::copy(entry_path, &dest_path).await?;
        Ok(())
    }

    async fn extract_and_install_zip(
        &self,
        zip_path: &Path,
        mods_dir: &Path,
        plugins_dir: &Path,
        userlibs_dir: &Path,
        userdata_dir: &Path,
        temp_dir: &Path,
        runtime: Option<&str>,
    ) -> Result<Vec<String>> {
        let file = File::open(zip_path).context("Failed to open zip file")?;

        let mut archive = ZipArchive::new(file).context("Failed to read zip archive")?;

        // Extract directly to disk so large archives are not buffered in memory.
        for i in 0..archive.len() {
            let mut file = archive
                .by_index(i)
                .context("Failed to read file from archive")?;

            let file_name = file.name().to_string();
            let relative_path = safe_archive_relative_path(&file_name)
                .map_err(anyhow::Error::msg)
                .context("Unsafe path in zip archive")?;
            let outpath = temp_dir.join(relative_path);
            let is_dir = file.is_dir() || file_name.ends_with('/');

            if is_dir {
                std::fs::create_dir_all(&outpath).context("Failed to create archive directory")?;
            } else {
                if let Some(p) = outpath.parent() {
                    std::fs::create_dir_all(p)
                        .context("Failed to create archive parent directory")?;
                }
                let mut outfile =
                    File::create(&outpath).context("Failed to create extracted archive file")?;
                copy(&mut file, &mut outfile).context("Failed to extract archive file")?;
            }
        }

        let mut installed_files = Vec::new();

        let content_root = self.resolve_archive_content_root(temp_dir).await?;
        let is_thunderstore_package = content_root.join("manifest.json").exists();

        if let Some(fomod_files) = self
            .try_extract_fomod_content(
                &content_root,
                mods_dir,
                plugins_dir,
                userlibs_dir,
                userdata_dir,
                runtime,
            )
            .await?
        {
            eprintln!(
                "[DEBUG] ZIP extraction used FOMOD mapping. Installed files: {:?}",
                fomod_files
            );
            return Ok(fomod_files);
        }

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
                    let is_runtime_dir =
                        dir_runtime == RUNTIME_IL2CPP || dir_runtime == RUNTIME_MONO;
                    let should_process = match runtime {
                        Some(target) => dir_runtime == target,
                        None => is_runtime_dir,
                    };

                    if is_runtime_dir && should_process {
                        // Process the runtime-specific directory
                        let mods_path = entry_path.join("mods");
                        let plugins_path = entry_path.join("plugins");
                        let userlibs_path = entry_path.join("userlibs");
                        let userdata_path = entry_path.join("userdata");

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
                        if userdata_path.exists() {
                            Box::pin(self.copy_directory_recursive(&userdata_path, userdata_dir))
                                .await?;
                        }

                        // Copy any loose files/folders in the selected runtime directory into Mods.
                        let mut runtime_entries = fs::read_dir(&entry_path).await?;
                        while let Some(runtime_entry) = runtime_entries.next_entry().await? {
                            let runtime_entry_path = runtime_entry.path();
                            let runtime_file_name = runtime_entry_path
                                .file_name()
                                .and_then(|n| n.to_str())
                                .unwrap_or("");

                            let runtime_lower_name = runtime_file_name.to_ascii_lowercase();
                            if matches!(
                                runtime_lower_name.as_str(),
                                "mods" | "plugins" | "userlibs" | "userdata"
                            ) {
                                continue;
                            }
                            if is_thunderstore_package
                                && Self::is_ignored_thunderstore_package_entry(runtime_file_name)
                            {
                                continue;
                            }

                            self.copy_loose_archive_payload_to_mods(
                                &runtime_entry_path,
                                runtime_file_name,
                                mods_dir,
                                runtime,
                                &mut installed_files,
                            )
                            .await?;
                        }
                    }
                    if is_runtime_dir {
                        continue;
                    }
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
                } else if dir_name == "userdata" {
                    Box::pin(self.copy_directory_recursive(&entry_path, userdata_dir)).await?;
                } else if !is_thunderstore_package
                    || !Self::is_ignored_thunderstore_package_entry(file_name)
                {
                    self.copy_loose_archive_payload_to_mods(
                        &entry_path,
                        file_name,
                        mods_dir,
                        runtime,
                        &mut installed_files,
                    )
                    .await?;
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
            } else if !is_thunderstore_package
                || !Self::is_ignored_thunderstore_package_entry(file_name)
            {
                self.copy_loose_archive_payload_to_mods(
                    &entry_path,
                    file_name,
                    mods_dir,
                    runtime,
                    &mut installed_files,
                )
                .await?;
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
        userdata_dir: &Path,
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
                validate_rar_entry_path(&entry.filename)?;

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
        let is_thunderstore_package = content_root.join("manifest.json").exists();

        if let Some(fomod_files) = self
            .try_extract_fomod_content(
                &content_root,
                mods_dir,
                plugins_dir,
                userlibs_dir,
                userdata_dir,
                runtime,
            )
            .await?
        {
            return Ok(fomod_files);
        }

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
                    let is_runtime_dir =
                        dir_runtime == RUNTIME_IL2CPP || dir_runtime == RUNTIME_MONO;
                    let should_process = match runtime {
                        Some(target) => dir_runtime == target,
                        None => is_runtime_dir,
                    };

                    if is_runtime_dir && should_process {
                        // Process the runtime-specific directory
                        let mods_path = entry_path.join("mods");
                        let plugins_path = entry_path.join("plugins");
                        let userlibs_path = entry_path.join("userlibs");
                        let userdata_path = entry_path.join("userdata");

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
                        if userdata_path.exists() {
                            Box::pin(self.copy_directory_recursive(&userdata_path, userdata_dir))
                                .await?;
                        }

                        // Copy any loose files/folders in the selected runtime directory into Mods.
                        let mut runtime_entries = fs::read_dir(&entry_path).await?;
                        while let Some(runtime_entry) = runtime_entries.next_entry().await? {
                            let runtime_entry_path = runtime_entry.path();
                            let runtime_file_name = runtime_entry_path
                                .file_name()
                                .and_then(|n| n.to_str())
                                .unwrap_or("");

                            let runtime_lower_name = runtime_file_name.to_ascii_lowercase();
                            if matches!(
                                runtime_lower_name.as_str(),
                                "mods" | "plugins" | "userlibs" | "userdata"
                            ) {
                                continue;
                            }
                            if is_thunderstore_package
                                && Self::is_ignored_thunderstore_package_entry(runtime_file_name)
                            {
                                continue;
                            }

                            self.copy_loose_archive_payload_to_mods(
                                &runtime_entry_path,
                                runtime_file_name,
                                mods_dir,
                                runtime,
                                &mut installed_files,
                            )
                            .await?;
                        }
                    }
                    if is_runtime_dir {
                        continue;
                    }
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
                } else if dir_name == "userdata" {
                    Box::pin(self.copy_directory_recursive(&entry_path, userdata_dir)).await?;
                } else if !is_thunderstore_package
                    || !Self::is_ignored_thunderstore_package_entry(file_name)
                {
                    self.copy_loose_archive_payload_to_mods(
                        &entry_path,
                        file_name,
                        mods_dir,
                        runtime,
                        &mut installed_files,
                    )
                    .await?;
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
            } else if !is_thunderstore_package
                || !Self::is_ignored_thunderstore_package_entry(file_name)
            {
                self.copy_loose_archive_payload_to_mods(
                    &entry_path,
                    file_name,
                    mods_dir,
                    runtime,
                    &mut installed_files,
                )
                .await?;
            }
        }

        Ok(installed_files)
    }

    async fn extract_and_install_7z(
        &self,
        archive_path: &Path,
        mods_dir: &Path,
        plugins_dir: &Path,
        userlibs_dir: &Path,
        userdata_dir: &Path,
        temp_dir: &Path,
        runtime: Option<&str>,
    ) -> Result<Vec<String>> {
        let archive_path = archive_path.to_path_buf();
        let extract_dir = temp_dir.to_path_buf();
        tokio::task::spawn_blocking(move || {
            sevenz_rust::decompress_file_with_extract_fn(
                &archive_path,
                &extract_dir,
                |entry, reader, _dest| {
                    if entry.name().is_empty() && entry.is_directory() {
                        return Ok(true);
                    }
                    let relative_path = safe_archive_relative_path(entry.name())
                        .map_err(sevenz_rust::Error::other)?;
                    let output_path = extract_dir.join(relative_path);

                    if entry.is_directory() {
                        std::fs::create_dir_all(&output_path).map_err(sevenz_rust::Error::io)?;
                    } else {
                        if let Some(parent) = output_path.parent() {
                            std::fs::create_dir_all(parent).map_err(sevenz_rust::Error::io)?;
                        }
                        let mut output =
                            File::create(&output_path).map_err(sevenz_rust::Error::io)?;
                        std::io::copy(reader, &mut output).map_err(sevenz_rust::Error::io)?;
                    }

                    Ok(true)
                },
            )
            .context("Failed to extract 7z archive")
        })
        .await??;

        let mut installed_files = Vec::new();

        let content_root = self.resolve_archive_content_root(temp_dir).await?;
        let is_thunderstore_package = content_root.join("manifest.json").exists();

        if let Some(fomod_files) = self
            .try_extract_fomod_content(
                &content_root,
                mods_dir,
                plugins_dir,
                userlibs_dir,
                userdata_dir,
                runtime,
            )
            .await?
        {
            return Ok(fomod_files);
        }

        let (has_il2cpp_dir, has_mono_dir) = self.detect_runtime_directories(&content_root).await?;

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

                if has_il2cpp_dir || has_mono_dir {
                    let dir_runtime = self.detect_mod_runtime_from_name(file_name);
                    let is_runtime_dir =
                        dir_runtime == RUNTIME_IL2CPP || dir_runtime == RUNTIME_MONO;
                    let should_process = match runtime {
                        Some(target) => dir_runtime == target,
                        None => is_runtime_dir,
                    };

                    if is_runtime_dir && should_process {
                        let mods_path = entry_path.join("mods");
                        let plugins_path = entry_path.join("plugins");
                        let userlibs_path = entry_path.join("userlibs");
                        let userdata_path = entry_path.join("userdata");

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
                        if userdata_path.exists() {
                            Box::pin(self.copy_directory_recursive(&userdata_path, userdata_dir))
                                .await?;
                        }

                        let mut runtime_entries = fs::read_dir(&entry_path).await?;
                        while let Some(runtime_entry) = runtime_entries.next_entry().await? {
                            let runtime_entry_path = runtime_entry.path();
                            let runtime_file_name = runtime_entry_path
                                .file_name()
                                .and_then(|n| n.to_str())
                                .unwrap_or("");

                            let runtime_lower_name = runtime_file_name.to_ascii_lowercase();
                            if matches!(
                                runtime_lower_name.as_str(),
                                "mods" | "plugins" | "userlibs" | "userdata"
                            ) {
                                continue;
                            }
                            if is_thunderstore_package
                                && Self::is_ignored_thunderstore_package_entry(runtime_file_name)
                            {
                                continue;
                            }

                            self.copy_loose_archive_payload_to_mods(
                                &runtime_entry_path,
                                runtime_file_name,
                                mods_dir,
                                runtime,
                                &mut installed_files,
                            )
                            .await?;
                        }
                    }
                    if is_runtime_dir {
                        continue;
                    }
                }

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
                } else if dir_name == "userdata" {
                    Box::pin(self.copy_directory_recursive(&entry_path, userdata_dir)).await?;
                } else if !is_thunderstore_package
                    || !Self::is_ignored_thunderstore_package_entry(file_name)
                {
                    self.copy_loose_archive_payload_to_mods(
                        &entry_path,
                        file_name,
                        mods_dir,
                        runtime,
                        &mut installed_files,
                    )
                    .await?;
                }
            } else if file_name.to_lowercase().ends_with(".dll") {
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
            } else if !is_thunderstore_package
                || !Self::is_ignored_thunderstore_package_entry(file_name)
            {
                self.copy_loose_archive_payload_to_mods(
                    &entry_path,
                    file_name,
                    mods_dir,
                    runtime,
                    &mut installed_files,
                )
                .await?;
            }
        }

        Ok(installed_files)
    }

    async fn extract_and_install_tar_gz(
        &self,
        archive_path: &Path,
        mods_dir: &Path,
        plugins_dir: &Path,
        userlibs_dir: &Path,
        userdata_dir: &Path,
        temp_dir: &Path,
        runtime: Option<&str>,
    ) -> Result<Vec<String>> {
        let archive_path = archive_path.to_path_buf();
        let extract_dir = temp_dir.to_path_buf();
        tokio::task::spawn_blocking(move || -> Result<()> {
            let file = File::open(&archive_path).context("Failed to open tar.gz archive")?;
            let decoder = GzDecoder::new(file);
            let mut archive = tar::Archive::new(decoder);

            for entry in archive.entries().context("Failed to read tar.gz archive")? {
                let mut entry = entry.context("Failed to read tar.gz entry")?;
                let entry_path = entry.path().context("Failed to read tar.gz entry path")?;
                let entry_name = entry_path.to_string_lossy().replace('\\', "/");
                let relative_path = safe_archive_relative_path(&entry_name)
                    .map_err(|error| anyhow::anyhow!(error))?;
                let output_path = extract_dir.join(relative_path);

                let entry_type = entry.header().entry_type();
                if entry_type.is_dir() {
                    std::fs::create_dir_all(&output_path).with_context(|| {
                        format!("Failed to create directory {}", output_path.display())
                    })?;
                } else if entry_type.is_file() {
                    if let Some(parent) = output_path.parent() {
                        std::fs::create_dir_all(parent).with_context(|| {
                            format!("Failed to create directory {}", parent.display())
                        })?;
                    }
                    entry.unpack(&output_path).with_context(|| {
                        format!("Failed to extract tar.gz file {}", output_path.display())
                    })?;
                }
            }

            Ok(())
        })
        .await??;

        self.install_extracted_archive_content(
            temp_dir,
            mods_dir,
            plugins_dir,
            userlibs_dir,
            userdata_dir,
            runtime,
        )
        .await
    }

    async fn install_extracted_archive_content(
        &self,
        temp_dir: &Path,
        mods_dir: &Path,
        plugins_dir: &Path,
        userlibs_dir: &Path,
        userdata_dir: &Path,
        runtime: Option<&str>,
    ) -> Result<Vec<String>> {
        let mut installed_files = Vec::new();

        let content_root = self.resolve_archive_content_root(temp_dir).await?;
        let is_thunderstore_package = content_root.join("manifest.json").exists();

        if let Some(fomod_files) = self
            .try_extract_fomod_content(
                &content_root,
                mods_dir,
                plugins_dir,
                userlibs_dir,
                userdata_dir,
                runtime,
            )
            .await?
        {
            return Ok(fomod_files);
        }

        let (has_il2cpp_dir, has_mono_dir) = self.detect_runtime_directories(&content_root).await?;

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

                if has_il2cpp_dir || has_mono_dir {
                    let dir_runtime = self.detect_mod_runtime_from_name(file_name);
                    let is_runtime_dir =
                        dir_runtime == RUNTIME_IL2CPP || dir_runtime == RUNTIME_MONO;
                    let should_process = match runtime {
                        Some(target) => dir_runtime == target,
                        None => is_runtime_dir,
                    };

                    if is_runtime_dir && should_process {
                        let mods_path = entry_path.join("mods");
                        let plugins_path = entry_path.join("plugins");
                        let userlibs_path = entry_path.join("userlibs");
                        let userdata_path = entry_path.join("userdata");

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
                        if userdata_path.exists() {
                            Box::pin(self.copy_directory_recursive(&userdata_path, userdata_dir))
                                .await?;
                        }

                        let mut runtime_entries = fs::read_dir(&entry_path).await?;
                        while let Some(runtime_entry) = runtime_entries.next_entry().await? {
                            let runtime_entry_path = runtime_entry.path();
                            let runtime_file_name = runtime_entry_path
                                .file_name()
                                .and_then(|n| n.to_str())
                                .unwrap_or("");

                            let runtime_lower_name = runtime_file_name.to_ascii_lowercase();
                            if matches!(
                                runtime_lower_name.as_str(),
                                "mods" | "plugins" | "userlibs" | "userdata"
                            ) {
                                continue;
                            }
                            if is_thunderstore_package
                                && Self::is_ignored_thunderstore_package_entry(runtime_file_name)
                            {
                                continue;
                            }

                            self.copy_loose_archive_payload_to_mods(
                                &runtime_entry_path,
                                runtime_file_name,
                                mods_dir,
                                runtime,
                                &mut installed_files,
                            )
                            .await?;
                        }
                    }
                    if is_runtime_dir {
                        continue;
                    }
                }

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
                } else if dir_name == "userdata" {
                    Box::pin(self.copy_directory_recursive(&entry_path, userdata_dir)).await?;
                } else if !is_thunderstore_package
                    || !Self::is_ignored_thunderstore_package_entry(file_name)
                {
                    self.copy_loose_archive_payload_to_mods(
                        &entry_path,
                        file_name,
                        mods_dir,
                        runtime,
                        &mut installed_files,
                    )
                    .await?;
                }
            } else if file_name.to_lowercase().ends_with(".dll") {
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
            } else if !is_thunderstore_package
                || !Self::is_ignored_thunderstore_package_entry(file_name)
            {
                self.copy_loose_archive_payload_to_mods(
                    &entry_path,
                    file_name,
                    mods_dir,
                    runtime,
                    &mut installed_files,
                )
                .await?;
            }
        }

        Ok(installed_files)
    }

    async fn try_extract_fomod_content(
        &self,
        content_root: &Path,
        mods_dir: &Path,
        plugins_dir: &Path,
        userlibs_dir: &Path,
        userdata_dir: &Path,
        runtime: Option<&str>,
    ) -> Result<Option<Vec<String>>> {
        let Some(config_path) = Self::find_fomod_config_path(content_root) else {
            return Ok(None);
        };

        let fomod_service = FomodService::new();
        let config = fomod_service.parse_fomod_xml_path(&config_path)?;
        let entries = fomod_service.build_install_entries(&config, runtime)?;
        if entries.is_empty() {
            return Ok(None);
        }

        let mut installed_files = Vec::new();
        let mut copied_any = false;
        for entry in &entries {
            if let (Some(target_runtime), Some(entry_runtime)) = (runtime, entry.runtime.as_deref())
            {
                if !entry_runtime.eq_ignore_ascii_case(target_runtime) {
                    continue;
                }
            }

            self.copy_fomod_install_entry(
                content_root,
                mods_dir,
                plugins_dir,
                userlibs_dir,
                userdata_dir,
                entry,
                runtime,
                &mut installed_files,
                &mut copied_any,
            )
            .await?;
        }

        if copied_any {
            Ok(Some(installed_files))
        } else {
            Ok(None)
        }
    }

    fn find_fomod_config_path(content_root: &Path) -> Option<PathBuf> {
        let candidates = [
            content_root.join("fomod").join("ModuleConfig.xml"),
            content_root.join("fomod").join("moduleconfig.xml"),
            content_root.join("fomod").join("Script.xml"),
            content_root.join("fomod").join("script.xml"),
        ];

        candidates.into_iter().find(|path| path.exists())
    }

    async fn copy_fomod_install_entry(
        &self,
        content_root: &Path,
        mods_dir: &Path,
        plugins_dir: &Path,
        userlibs_dir: &Path,
        userdata_dir: &Path,
        entry: &FomodInstallEntry,
        runtime: Option<&str>,
        installed_files: &mut Vec<String>,
        copied_any: &mut bool,
    ) -> Result<()> {
        let source_relative = Self::validated_fomod_relative_path(&entry.source)?;
        let source_path = content_root.join(&source_relative);
        if !source_path.exists() {
            eprintln!(
                "[FOMOD] Skipping missing source path from installer mapping: {}",
                source_path.display()
            );
            return Ok(());
        }

        let (destination_kind, destination_relative, explicit_file_target) =
            self.resolve_fomod_destination(entry)?;
        let destination_root = match destination_kind {
            FomodDestinationKind::Mods => mods_dir,
            FomodDestinationKind::Plugins => plugins_dir,
            FomodDestinationKind::UserLibs => userlibs_dir,
            FomodDestinationKind::UserData => userdata_dir,
        };

        if entry.is_folder {
            let dest_dir = if destination_relative.as_os_str().is_empty() {
                destination_root.to_path_buf()
            } else {
                destination_root.join(&destination_relative)
            };

            self.copy_fomod_directory(
                &source_path,
                &dest_dir,
                destination_kind,
                runtime,
                installed_files,
                copied_any,
            )
            .await?;
            return Ok(());
        }

        let source_name = source_path
            .file_name()
            .and_then(|value| value.to_str())
            .ok_or_else(|| anyhow::anyhow!("Invalid FOMOD source file path"))?;

        let destination_path = if explicit_file_target {
            destination_root.join(&destination_relative)
        } else if destination_relative.as_os_str().is_empty() {
            destination_root.join(source_name)
        } else {
            destination_root
                .join(&destination_relative)
                .join(source_name)
        };

        if let Some(target_runtime) = runtime {
            let file_runtime = self.detect_mod_runtime_from_name(source_name);
            if file_runtime != "unknown" && !file_runtime.eq_ignore_ascii_case(target_runtime) {
                return Ok(());
            }
        }

        if let Some(parent) = destination_path.parent() {
            fs::create_dir_all(parent).await?;
        }
        fs::copy(&source_path, &destination_path).await?;
        let installed_name = destination_path
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or(source_name);
        self.track_fomod_installed_file(destination_kind, installed_name, installed_files);
        *copied_any = true;
        Ok(())
    }

    async fn copy_fomod_directory(
        &self,
        source: &Path,
        dest: &Path,
        destination_kind: FomodDestinationKind,
        runtime: Option<&str>,
        installed_files: &mut Vec<String>,
        copied_any: &mut bool,
    ) -> Result<()> {
        fs::create_dir_all(dest).await?;

        let mut entries = fs::read_dir(source).await?;
        while let Some(entry) = entries.next_entry().await? {
            let entry_path = entry.path();
            let file_name = entry_path
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or("");
            let dest_path = dest.join(file_name);
            let metadata = fs::metadata(&entry_path).await?;

            if metadata.is_dir() {
                Box::pin(self.copy_fomod_directory(
                    &entry_path,
                    &dest_path,
                    destination_kind,
                    runtime,
                    installed_files,
                    copied_any,
                ))
                .await?;
                continue;
            }

            if let Some(target_runtime) = runtime {
                let file_runtime = self.detect_mod_runtime_from_name(file_name);
                if file_runtime != "unknown" && !file_runtime.eq_ignore_ascii_case(target_runtime) {
                    continue;
                }
            }

            if let Some(parent) = dest_path.parent() {
                fs::create_dir_all(parent).await?;
            }
            fs::copy(&entry_path, &dest_path).await?;
            self.track_fomod_installed_file(destination_kind, file_name, installed_files);
            *copied_any = true;
        }

        Ok(())
    }

    fn resolve_fomod_destination(
        &self,
        entry: &FomodInstallEntry,
    ) -> Result<(FomodDestinationKind, PathBuf, bool)> {
        let _validated_source = Self::validated_fomod_relative_path(&entry.source)?;
        let destination = Self::normalize_fomod_path_value(&entry.destination);
        let source = Self::normalize_fomod_path_value(&entry.source);

        let (destination_kind, stripped_destination) = if !destination.is_empty() {
            if Self::path_targets_bucket(&destination, "plugins") {
                (
                    FomodDestinationKind::Plugins,
                    Self::strip_bucket_prefix(&destination, "plugins"),
                )
            } else if Self::path_targets_bucket(&destination, "userlibs") {
                (
                    FomodDestinationKind::UserLibs,
                    Self::strip_bucket_prefix(&destination, "userlibs"),
                )
            } else if Self::path_targets_bucket(&destination, "userdata") {
                (
                    FomodDestinationKind::UserData,
                    Self::strip_bucket_prefix(&destination, "userdata"),
                )
            } else if Self::path_targets_bucket(&destination, "mods") {
                (
                    FomodDestinationKind::Mods,
                    Self::strip_bucket_prefix(&destination, "mods"),
                )
            } else {
                return Err(anyhow::anyhow!(
                    "Unsupported FOMOD destination path: {}",
                    entry.destination
                ));
            }
        } else if Self::path_targets_bucket(&source, "plugins") {
            (
                FomodDestinationKind::Plugins,
                Self::strip_bucket_prefix(&source, "plugins"),
            )
        } else if Self::path_targets_bucket(&source, "userlibs") {
            (
                FomodDestinationKind::UserLibs,
                Self::strip_bucket_prefix(&source, "userlibs"),
            )
        } else if Self::path_targets_bucket(&source, "userdata") {
            (
                FomodDestinationKind::UserData,
                Self::strip_bucket_prefix(&source, "userdata"),
            )
        } else {
            (
                FomodDestinationKind::Mods,
                Self::strip_bucket_prefix(&source, "mods"),
            )
        };

        let explicit_file_target = !entry.is_folder
            && !stripped_destination.is_empty()
            && Path::new(&stripped_destination)
                .extension()
                .and_then(|value| value.to_str())
                .is_some();

        Ok((
            destination_kind,
            Self::validated_fomod_relative_path(&stripped_destination)?,
            explicit_file_target,
        ))
    }

    fn track_fomod_installed_file(
        &self,
        destination_kind: FomodDestinationKind,
        file_name: &str,
        installed_files: &mut Vec<String>,
    ) {
        if matches!(
            destination_kind,
            FomodDestinationKind::UserLibs | FomodDestinationKind::UserData
        ) {
            return;
        }

        let lower = file_name.to_ascii_lowercase();
        if lower.ends_with(".dll") || lower.ends_with(".exe") {
            installed_files.push(file_name.to_string());
        }
    }

    fn path_targets_bucket(path: &str, bucket: &str) -> bool {
        if path.is_empty() {
            return false;
        }
        path.eq_ignore_ascii_case(bucket)
            || path
                .to_ascii_lowercase()
                .starts_with(&(bucket.to_string() + "/"))
            || path.to_ascii_lowercase().contains(&format!("/{bucket}/"))
    }

    fn parse_bucket_target(target: Option<&str>) -> Option<FomodDestinationKind> {
        match target.map(|value| value.trim().to_ascii_lowercase()) {
            Some(value) if value == "mods" => Some(FomodDestinationKind::Mods),
            Some(value) if value == "plugins" => Some(FomodDestinationKind::Plugins),
            Some(value) if value == "userlibs" => Some(FomodDestinationKind::UserLibs),
            Some(value) if value == "userdata" => Some(FomodDestinationKind::UserData),
            _ => None,
        }
    }

    fn infer_bucket_target_from_path(path: &Path) -> Option<FomodDestinationKind> {
        path.components().find_map(|component| {
            let value = component.as_os_str().to_string_lossy();
            if value.eq_ignore_ascii_case("plugins") {
                Some(FomodDestinationKind::Plugins)
            } else if value.eq_ignore_ascii_case("userlibs") {
                Some(FomodDestinationKind::UserLibs)
            } else if value.eq_ignore_ascii_case("userdata") {
                Some(FomodDestinationKind::UserData)
            } else if value.eq_ignore_ascii_case("mods") {
                Some(FomodDestinationKind::Mods)
            } else {
                None
            }
        })
    }

    fn resolve_direct_file_bucket_target(
        target: Option<&str>,
        source_path: &Path,
    ) -> FomodDestinationKind {
        Self::parse_bucket_target(target)
            .or_else(|| Self::infer_bucket_target_from_path(source_path))
            .unwrap_or(FomodDestinationKind::Mods)
    }

    fn strip_bucket_prefix(path: &str, bucket: &str) -> String {
        let parts: Vec<&str> = path
            .trim_matches('/')
            .split('/')
            .filter(|part| !part.is_empty())
            .collect();
        if let Some(index) = parts
            .iter()
            .position(|part| part.eq_ignore_ascii_case(bucket))
        {
            return parts[index + 1..].join("/");
        }
        path.trim_matches('/').to_string()
    }

    fn normalize_fomod_path_value(path: &str) -> String {
        path.replace('\\', "/")
            .trim_start_matches("./")
            .trim_matches('/')
            .to_string()
    }

    fn validated_fomod_relative_path(path: &str) -> Result<PathBuf> {
        let normalized = Self::normalize_fomod_path_value(path);
        let candidate = Self::path_buf_from_forward_slashes(&normalized);

        if candidate.is_absolute() {
            return Err(anyhow::anyhow!("Invalid absolute FOMOD path: {}", path));
        }

        if !candidate
            .components()
            .all(|component| matches!(component, Component::Normal(_)))
        {
            return Err(anyhow::anyhow!("Invalid FOMOD relative path: {}", path));
        }

        Ok(candidate)
    }

    fn path_buf_from_forward_slashes(path: &str) -> PathBuf {
        let mut buffer = PathBuf::new();
        for component in path.split('/').filter(|value| !value.is_empty()) {
            buffer.push(component);
        }
        buffer
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

    async fn write_copy_fallback_marker(&self, source: &Path, dest: &Path) -> Result<()> {
        let marker = serde_json::json!({
            "sourcePath": source.to_string_lossy(),
        });
        fs::write(dest.join(COPY_FALLBACK_MARKER_FILE), marker.to_string())
            .await
            .context("Failed to write copy fallback marker")
    }

    async fn path_has_copy_fallback_marker(
        &self,
        path: &Path,
        expected_source_path: &Path,
        storage_id: &str,
    ) -> bool {
        let metadata = match fs::metadata(path).await {
            Ok(value) if value.is_dir() => value,
            _ => return false,
        };
        if !metadata.is_dir() {
            return false;
        }

        let marker = match fs::read_to_string(path.join(COPY_FALLBACK_MARKER_FILE)).await {
            Ok(value) => value,
            Err(_) => return false,
        };
        let Some(source_path) = serde_json::from_str::<serde_json::Value>(&marker)
            .ok()
            .and_then(|value| {
                value
                    .get("sourcePath")
                    .and_then(|path| path.as_str())
                    .map(str::to_string)
            })
        else {
            return false;
        };

        if !source_path.contains(storage_id) {
            return false;
        }

        match (
            std::fs::canonicalize(PathBuf::from(source_path)),
            std::fs::canonicalize(expected_source_path),
        ) {
            (Ok(actual), Ok(expected)) => actual == expected,
            _ => false,
        }
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
        let requested_runtime = match runtime {
            "IL2CPP" => Some(crate::types::Runtime::Il2cpp),
            "Mono" => Some(crate::types::Runtime::Mono),
            _ => None,
        };
        let existing_mod_id = self
            .find_existing_mod_installation(
                game_dir,
                &source_id,
                &source_version,
                requested_runtime.clone(),
            )
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
        let mod_storage_plugins = mod_storage_base.join("Plugins");
        let mod_storage_userlibs = mod_storage_base.join("UserLibs");
        fs::create_dir_all(&mod_storage_mods)
            .await
            .context("Failed to create mod storage directory")?;
        fs::create_dir_all(&mod_storage_plugins)
            .await
            .context("Failed to create plugin storage directory")?;
        fs::create_dir_all(&mod_storage_userlibs)
            .await
            .context("Failed to create userlib storage directory")?;

        // Create game directory if it doesn't exist (for symlink)
        let mods_directory = self.get_mods_directory(game_dir);
        let plugins_directory = self.get_plugins_directory(game_dir);
        let userlibs_directory = self.get_userlibs_directory(game_dir);
        fs::create_dir_all(&mods_directory).await?;
        fs::create_dir_all(&plugins_directory).await?;
        fs::create_dir_all(&userlibs_directory).await?;

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

        let bucket_target = Self::resolve_direct_file_bucket_target(None, source_path);

        // Copy DLL to mod storage
        let (storage_root, install_root) = match bucket_target {
            FomodDestinationKind::Plugins => (&mod_storage_plugins, &plugins_directory),
            FomodDestinationKind::UserLibs => (&mod_storage_userlibs, &userlibs_directory),
            FomodDestinationKind::UserData => (&mod_storage_mods, &mods_directory),
            FomodDestinationKind::Mods => (&mod_storage_mods, &mods_directory),
        };
        let storage_path = storage_root.join(file_name);
        fs::copy(source_path, &storage_path)
            .await
            .context("Failed to copy DLL file to storage")?;
        eprintln!(
            "[DEBUG] install_dll_mod: Copied DLL to storage: {:?}",
            storage_path
        );

        // Create symlink in game directory
        let symlink_path = install_root.join(file_name);

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

    #[test]
    fn build_storage_install_failure_message_describes_locked_environment() {
        let env = Environment {
            id: "env-alt".to_string(),
            name: "Alternate".to_string(),
            description: None,
            app_id: schedule_i_config().app_id,
            branch: "alternate".to_string(),
            output_dir: r"C:\Games\Alternate".to_string(),
            runtime: Runtime::Mono,
            status: crate::types::EnvironmentStatus::Completed,
            last_updated: None,
            size: None,
            last_manifest_id: None,
            last_update_check: None,
            update_available: None,
            remote_manifest_id: None,
            remote_build_id: None,
            current_game_version: None,
            update_game_version: None,
            melon_loader_version: None,
            steamapps_dir: None,
            steam_manifest_path: None,
            environment_type: None,
        };

        let message = ModsService::build_storage_install_failure_message(
            "storage-1",
            &env,
            &[String::from(
                r"Skipped C:\Games\Alternate\Mods\Example.dll: failed to replace existing destination (The process cannot access the file because it is being used by another process. (os error 32))",
            )],
            true,
            true,
            true,
            true,
            true,
        );

        assert!(message.contains("Alternate"));
        assert!(message.contains("currently running"));
        assert!(message.contains("being used by another process"));
        assert!(message.contains("MelonLoader"));
    }

    #[tokio::test]
    #[serial]
    async fn remove_icon_cache_if_orphaned_skips_paths_outside_cache_dir() -> Result<()> {
        let temp = tempdir()?;
        let data_dir = temp.path().join("simmrust");
        let _guard = EnvVarGuard::set("SIMMRUST_DATA_DIR", data_dir.to_string_lossy().as_ref());
        let pool = initialize_pool().await?;
        let service = ModsService::new(pool);
        let download_dir = temp.path().join("downloads");
        let mut settings_service = SettingsService::new(service.pool.clone())?;
        settings_service
            .save_settings(serde_json::json!({
                "defaultDownloadDir": download_dir.to_string_lossy().to_string()
            }))
            .await?;

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

    fn write_zip_fixture(zip_path: &Path, files: &[(&str, &[u8])]) -> Result<()> {
        let file = File::create(zip_path)?;
        let mut zip = ZipWriter::new(file);
        for (path, contents) in files {
            zip.start_file(*path, FileOptions::default())?;
            zip.write_all(contents)?;
        }
        zip.finish()?;
        Ok(())
    }

    #[tokio::test]
    #[serial]
    async fn load_mod_metadata_falls_back_to_file() -> Result<()> {
        let temp = tempdir()?;
        let data_dir = temp.path().join("simmrust");
        let _guard = EnvVarGuard::set("SIMMRUST_DATA_DIR", data_dir.to_string_lossy().as_ref());
        let pool = initialize_pool().await?;
        let service = ModsService::new(pool.clone());
        let download_dir = temp.path().join("downloads");
        let mut settings_service = SettingsService::new(pool)?;
        settings_service
            .save_settings(serde_json::json!({
                "defaultDownloadDir": download_dir.to_string_lossy().to_string()
            }))
            .await?;

        let game_dir = temp.path().join("game");
        let mods_dir = game_dir.join("Mods");
        fs::create_dir_all(&mods_dir).await?;
        fs::write(mods_dir.join("Example.dll"), b"data").await?;

        let mut metadata = HashMap::new();
        metadata.insert(
            "Example.dll".to_string(),
            sample_metadata(None, Some("local"), Some("1.0.0")),
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
    async fn load_mod_metadata_does_not_recover_plain_file_copies_from_library_storage(
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
        storage_meta.author = Some("Recovered Author".to_string());
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
        assert!(
            !loaded.contains_key("RecoveredManaged.dll"),
            "plain local copies should not auto-recover managed metadata from library storage"
        );

        Ok(())
    }

    #[tokio::test]
    #[serial]
    async fn list_mods_uses_metadata_values() -> Result<()> {
        let temp = tempdir()?;
        let data_dir = temp.path().join("simmrust");
        let _guard = EnvVarGuard::set("SIMMRUST_DATA_DIR", data_dir.to_string_lossy().as_ref());
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
    async fn list_mods_uses_storage_metadata_for_managed_display_fields() -> Result<()> {
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

        let output_dir = temp.path().join("envs").join("env-managed-display");
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

        let storage_id = "managed-display";
        let mut env_metadata = HashMap::new();
        env_metadata.insert(
            "ManagedDisplay.dll".to_string(),
            sample_metadata(Some(storage_id), Some("local"), Some("1.0.0")),
        );
        service.save_mod_metadata(&mods_dir, &env_metadata).await?;

        let storage_dir = download_dir.join("Mods").join(storage_id);
        fs::create_dir_all(storage_dir.join("Mods")).await?;
        let storage_file = storage_dir.join("Mods").join("ManagedDisplay.dll");
        fs::write(&storage_file, b"data").await?;
        fs::write(
            storage_dir.join(STORAGE_METADATA_FILE),
            serde_json::json!({
                "source": "nexusmods",
                "modStorageId": storage_id,
                "modName": "Managed Display",
                "author": "xvilho",
                "summary": "A popup will appear if your mod list has changed since you last saved.",
                "iconUrl": "https://example.test/icon.png",
                "downloads": 42,
                "endorsementCount": 7,
                "updatedAt": "2026-03-05T10:00:00Z",
                "tags": ["utility"]
            })
            .to_string(),
        )
        .await?;
        service
            .create_symlink_file(&storage_file, &mods_dir.join("ManagedDisplay.dll"))
            .await?;
        if !service
            .is_symlink(&mods_dir.join("ManagedDisplay.dll"))
            .await?
        {
            return Ok(());
        }

        let result = service
            .list_mods(output_dir.to_string_lossy().as_ref())
            .await?;
        let mods = result
            .get("mods")
            .and_then(|v| v.as_array())
            .expect("mods array");
        let entry = mods.first().expect("mod entry");

        assert_eq!(entry.get("managed").and_then(|v| v.as_bool()), Some(true));
        assert_eq!(
            entry.get("source").and_then(|v| v.as_str()),
            Some("nexusmods")
        );
        assert_eq!(entry.get("author").and_then(|v| v.as_str()), Some("xvilho"));
        assert_eq!(
            entry.get("summary").and_then(|v| v.as_str()),
            Some("A popup will appear if your mod list has changed since you last saved.")
        );
        assert_eq!(
            entry.get("iconUrl").and_then(|v| v.as_str()),
            Some("https://example.test/icon.png")
        );
        assert_eq!(entry.get("downloads").and_then(|v| v.as_u64()), Some(42));
        assert_eq!(
            entry.get("likesOrEndorsements").and_then(|v| v.as_i64()),
            Some(7)
        );
        assert_eq!(
            entry.get("updatedAt").and_then(|v| v.as_str()),
            Some("2026-03-05T10:00:00Z")
        );

        Ok(())
    }

    #[tokio::test]
    #[serial]
    async fn list_mods_tolerates_invalid_managed_storage_id() -> Result<()> {
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

        let output_dir = temp.path().join("env-invalid-storage-id");
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
        let outside_storage_file = download_dir
            .join("bad-storage-id")
            .join("Mods")
            .join("BadStorage.dll");
        fs::create_dir_all(outside_storage_file.parent().expect("storage parent")).await?;
        fs::write(&outside_storage_file, b"data").await?;
        std::fs::hard_link(&outside_storage_file, mods_dir.join("BadStorage.dll"))?;

        let mut metadata = HashMap::new();
        metadata.insert(
            "BadStorage.dll".to_string(),
            sample_metadata(Some("../bad-storage-id"), Some("local"), Some("1.0.0")),
        );
        service.save_mod_metadata(&mods_dir, &metadata).await?;

        let result = service
            .list_mods(output_dir.to_string_lossy().as_ref())
            .await?;
        let mods = result
            .get("mods")
            .and_then(|value| value.as_array())
            .expect("mods array");
        assert_eq!(mods.len(), 1);
        assert_eq!(
            mods[0].get("fileName").and_then(|value| value.as_str()),
            Some("BadStorage.dll")
        );
        assert_eq!(
            mods[0].get("managed").and_then(|value| value.as_bool()),
            Some(true)
        );

        Ok(())
    }

    #[tokio::test]
    #[serial]
    async fn list_mods_keeps_plain_file_copies_local_even_when_library_has_matching_storage(
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
        storage_meta.author = Some("Recovered Author".to_string());
        storage_meta.mod_name = Some("Recovered Managed".to_string());
        storage_meta.summary = Some("Recovered display metadata.".to_string());
        storage_meta.icon_url = Some("https://example.test/recovered.png".to_string());
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
            .expect("plain copied mod");

        assert_eq!(
            entry.get("managed").and_then(|value| value.as_bool()),
            Some(false)
        );
        assert_eq!(
            entry.get("source").and_then(|value| value.as_str()),
            Some("local")
        );
        assert_eq!(entry.get("version").and_then(|value| value.as_str()), None);
        assert_eq!(
            entry.get("author").and_then(|value| value.as_str()),
            Some("Recovered Author")
        );
        assert_eq!(
            entry.get("summary").and_then(|value| value.as_str()),
            Some("Recovered display metadata.")
        );
        assert_eq!(
            entry.get("iconUrl").and_then(|value| value.as_str()),
            Some("https://example.test/recovered.png")
        );
        assert!(
            entry.get("sourceUrl").is_none()
                || entry.get("sourceUrl").is_some_and(|value| value.is_null())
        );
        assert!(
            entry.get("securityScan").is_none()
                || entry
                    .get("securityScan")
                    .is_some_and(|value| value.is_null())
        );

        Ok(())
    }

    #[tokio::test]
    #[serial]
    async fn load_mod_metadata_prunes_stale_managed_entries_for_plain_local_copies() -> Result<()> {
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

        let output_dir = temp.path().join("envs").join("env-stale-local-copy");
        let env = env_service
            .create_environment(
                schedule_i_config().app_id,
                "main".to_string(),
                output_dir.to_string_lossy().to_string(),
                None,
                None,
            )
            .await?;

        let storage_id = "storage-stale-local-copy";
        let storage_base = download_dir.join("Mods").join(storage_id);
        let storage_mods = storage_base.join("Mods");
        fs::create_dir_all(&storage_mods).await?;
        fs::write(storage_mods.join("RecoveredManaged.dll"), b"managed-bytes").await?;

        let mut storage_meta =
            sample_metadata(Some(storage_id), Some("owner/recovered"), Some("1.0.0"));
        storage_meta.source = Some(ModSource::Thunderstore);
        storage_meta.author = Some("Recovered Author".to_string());
        storage_meta.mod_name = Some("Recovered Managed".to_string());
        service
            .save_storage_metadata(&storage_base, &storage_meta)
            .await?;

        let mods_dir = output_dir.join("Mods");
        fs::create_dir_all(&mods_dir).await?;
        fs::write(mods_dir.join("RecoveredManaged.dll"), b"managed-bytes").await?;

        let mut metadata = HashMap::new();
        let mut stale_meta =
            sample_metadata(Some(storage_id), Some("owner/recovered"), Some("1.0.0"));
        stale_meta.source = Some(ModSource::Thunderstore);
        stale_meta.author = Some("Recovered Author".to_string());
        stale_meta.security_scan = Some(SecurityScanSummary {
            state: SecurityScanState::Verified,
            verified: true,
            disposition: None,
            highest_severity: None,
            total_findings: 0,
            threat_family_count: 0,
            scanned_at: None,
            scanner_version: None,
            schema_version: None,
            status_message: Some("Verified".to_string()),
        });
        metadata.insert("RecoveredManaged.dll".to_string(), stale_meta);
        service.save_mod_metadata(&mods_dir, &metadata).await?;

        let loaded = service.load_mod_metadata(&mods_dir).await?;
        assert!(
            !loaded.contains_key("RecoveredManaged.dll"),
            "stale managed metadata should be pruned once the environment file is a plain local copy"
        );

        let count: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM mod_metadata WHERE environment_id = ? AND kind = 'mods' AND file_name = ?",
        )
        .bind(&env.id)
        .bind("RecoveredManaged.dll")
        .fetch_one(&*pool)
        .await?;
        assert_eq!(count, 0);

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
        let download_dir = temp.path().join("downloads");
        let mut settings_service = SettingsService::new(pool.clone())?;
        settings_service
            .save_settings(serde_json::json!({
                "defaultDownloadDir": download_dir.to_string_lossy().to_string()
            }))
            .await?;

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
    #[serial]
    async fn list_and_count_mods_include_nested_mod_entries() -> Result<()> {
        let temp = tempdir()?;
        let data_dir = temp.path().join("simmrust");
        let _guard = EnvVarGuard::set("SIMMRUST_DATA_DIR", data_dir.to_string_lossy().as_ref());
        let pool = initialize_pool().await?;
        let env_service = EnvironmentService::new(pool.clone())?;
        let service = ModsService::new(pool.clone());

        let output_dir = temp.path().join("envs").join("env-nested-mods");
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
        fs::create_dir_all(mods_dir.join("Mono")).await?;
        fs::create_dir_all(mods_dir.join("Net35")).await?;
        fs::write(mods_dir.join("Mono").join("Shared.dll"), b"mono").await?;
        fs::write(mods_dir.join("Net35").join("Shared.dll"), b"net35").await?;

        let mut metadata = HashMap::new();
        metadata.insert(
            "Mono/Shared.dll".to_string(),
            sample_metadata(Some("storage-mono"), None, Some("1.0.0")),
        );
        metadata.insert(
            "Net35/Shared.dll".to_string(),
            sample_metadata(Some("storage-net35"), None, Some("1.1.0")),
        );
        service.save_mod_metadata(&mods_dir, &metadata).await?;

        let result = service
            .list_mods(output_dir.to_string_lossy().as_ref())
            .await?;
        let mods = result
            .get("mods")
            .and_then(|value| value.as_array())
            .expect("mods array");
        let mut file_names = mods
            .iter()
            .filter_map(|entry| entry.get("fileName").and_then(|value| value.as_str()))
            .map(|value| value.to_string())
            .collect::<Vec<_>>();
        file_names.sort();

        assert_eq!(
            file_names,
            vec![
                "Mono/Shared.dll".to_string(),
                "Net35/Shared.dll".to_string()
            ]
        );
        assert_eq!(
            result.get("count").and_then(|value| value.as_u64()),
            Some(2)
        );

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
    async fn disable_and_enable_managed_mod_toggles_companion_plugin_files() -> Result<()> {
        let temp = tempdir()?;
        let data_dir = temp.path().join("simmrust");
        let _guard = EnvVarGuard::set("SIMMRUST_DATA_DIR", data_dir.to_string_lossy().as_ref());
        let pool = initialize_pool().await?;
        let env_service = EnvironmentService::new(pool.clone())?;
        let service = ModsService::new(pool.clone());

        let output_dir = temp.path().join("envs").join("env-managed-toggle");
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
        let plugins_dir = output_dir.join("Plugins");
        fs::create_dir_all(&mods_dir).await?;
        fs::create_dir_all(&plugins_dir).await?;

        let storage_root = service.get_mods_storage_dir().await?;
        let storage_mods_dir = storage_root.join("managed-storage").join("Mods");
        let storage_plugins_dir = storage_root.join("managed-storage").join("Plugins");
        fs::create_dir_all(&storage_mods_dir).await?;
        fs::create_dir_all(&storage_plugins_dir).await?;

        let storage_mod_path = storage_mods_dir.join("ManagedMod.dll");
        let storage_plugin_path = storage_plugins_dir.join("LoaderPlugin.dll");
        fs::write(&storage_mod_path, b"data").await?;
        fs::write(&storage_plugin_path, b"data").await?;

        let mod_path = mods_dir.join("ManagedMod.dll");
        let plugin_path = plugins_dir.join("LoaderPlugin.dll");
        service
            .create_symlink_file(&storage_mod_path, &mod_path)
            .await?;
        service
            .create_symlink_file(&storage_plugin_path, &plugin_path)
            .await?;

        let mut metadata = HashMap::new();
        let mut mod_meta = sample_metadata(Some("managed-storage"), None, Some("1.0.0"));
        mod_meta.symlink_paths = Some(vec![
            mod_path.to_string_lossy().to_string(),
            plugin_path.to_string_lossy().to_string(),
        ]);
        metadata.insert("ManagedMod.dll".to_string(), mod_meta);

        service.save_mod_metadata(&mods_dir, &metadata).await?;

        service
            .disable_mod(output_dir.to_string_lossy().as_ref(), "ManagedMod.dll")
            .await?;
        assert!(!mod_path.exists());
        assert!(!plugin_path.exists());
        assert!(mods_dir.join("ManagedMod.dll.disabled").exists());
        assert!(plugins_dir.join("LoaderPlugin.dll.disabled").exists());

        service
            .enable_mod(output_dir.to_string_lossy().as_ref(), "ManagedMod.dll")
            .await?;
        assert!(mod_path.exists());
        assert!(plugin_path.exists());
        assert!(!mods_dir.join("ManagedMod.dll.disabled").exists());
        assert!(!plugins_dir.join("LoaderPlugin.dll.disabled").exists());

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
    async fn delete_managed_mod_removes_companion_plugin_files() -> Result<()> {
        let temp = tempdir()?;
        let data_dir = temp.path().join("simmrust");
        let _guard = EnvVarGuard::set("SIMMRUST_DATA_DIR", data_dir.to_string_lossy().as_ref());
        let pool = initialize_pool().await?;
        let env_service = EnvironmentService::new(pool.clone())?;
        let service = ModsService::new(pool.clone());

        let output_dir = temp.path().join("envs").join("env-managed-delete");
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
        let plugins_dir = output_dir.join("Plugins");
        fs::create_dir_all(&mods_dir).await?;
        fs::create_dir_all(&plugins_dir).await?;

        let mod_path = mods_dir.join("ManagedMod.dll");
        let plugin_path = plugins_dir.join("LoaderPlugin.dll");
        fs::write(&mod_path, b"data").await?;
        fs::write(&plugin_path, b"data").await?;

        let mut metadata = HashMap::new();
        let mut mod_meta = sample_metadata(Some("managed-storage"), None, Some("1.0.0"));
        mod_meta.symlink_paths = Some(vec![
            mod_path.to_string_lossy().to_string(),
            plugin_path.to_string_lossy().to_string(),
        ]);
        metadata.insert("ManagedMod.dll".to_string(), mod_meta);
        service.save_mod_metadata(&mods_dir, &metadata).await?;

        service
            .delete_mod(output_dir.to_string_lossy().as_ref(), "ManagedMod.dll")
            .await?;

        assert!(!mod_path.exists());
        assert!(!plugin_path.exists());

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
    #[serial]
    async fn find_existing_mod_storage_by_source_version_uses_nested_runtime_paths() -> Result<()> {
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

        let output_dir = temp.path().join("envs").join("env-nested-runtime");
        let env = env_service
            .create_environment(
                schedule_i_config().app_id,
                "main".to_string(),
                output_dir.to_string_lossy().to_string(),
                None,
                None,
            )
            .await?;

        let metadata = sample_metadata(
            Some("storage-runtime-nested"),
            Some("source-id"),
            Some("1.0.0"),
        );
        let serialized = serde_json::to_string(&metadata)?;
        sqlx::query(
            "INSERT INTO mod_metadata (environment_id, kind, file_name, data) VALUES (?, 'mods', ?, ?)",
        )
        .bind(&env.id)
        .bind("Example.Mono.dll")
        .bind(serialized)
        .execute(&*pool)
        .await?;

        let storage_mods_dir = download_dir
            .join("Mods")
            .join("storage-runtime-nested")
            .join("Mods")
            .join("Mono");
        fs::create_dir_all(&storage_mods_dir).await?;
        fs::write(storage_mods_dir.join("Example.Mono.dll"), b"data").await?;

        let mono_match = service
            .find_existing_mod_storage_by_source_version("source-id", "1.0.0", Some(Runtime::Mono))
            .await?;
        let il2cpp_match = service
            .find_existing_mod_storage_by_source_version(
                "source-id",
                "1.0.0",
                Some(Runtime::Il2cpp),
            )
            .await?;

        assert_eq!(mono_match.as_deref(), Some("storage-runtime-nested"));
        assert_eq!(il2cpp_match, None);

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
    async fn extract_and_install_zip_rejects_traversal_entries() -> Result<()> {
        let temp = tempdir()?;
        let zip_path = temp.path().join("malicious.zip");
        write_zip_fixture(&zip_path, &[("../escape.txt", b"owned")])?;

        let extract_dir = temp.path().join("extract");
        let mods_dir = temp.path().join("mods");
        let plugins_dir = temp.path().join("plugins");
        let userlibs_dir = temp.path().join("userlibs");
        let userdata_dir = temp.path().join("userdata");
        fs::create_dir_all(&extract_dir).await?;
        fs::create_dir_all(&mods_dir).await?;
        fs::create_dir_all(&plugins_dir).await?;
        fs::create_dir_all(&userlibs_dir).await?;
        fs::create_dir_all(&userdata_dir).await?;

        let service = ModsService::new(Arc::new(SqlitePool::connect_lazy("sqlite::memory:")?));
        let result = service
            .extract_and_install_zip(
                &zip_path,
                &mods_dir,
                &plugins_dir,
                &userlibs_dir,
                &userdata_dir,
                &extract_dir,
                None,
            )
            .await;

        assert!(result.is_err());
        assert!(!temp.path().join("escape.txt").exists());

        Ok(())
    }

    #[tokio::test]
    async fn extract_and_install_zip_preserves_safe_nested_entries() -> Result<()> {
        let temp = tempdir()?;
        let zip_path = temp.path().join("mod.zip");
        write_zip_fixture(&zip_path, &[("Mods/Example.dll", b"dll")])?;

        let extract_dir = temp.path().join("extract");
        let mods_dir = temp.path().join("mods");
        let plugins_dir = temp.path().join("plugins");
        let userlibs_dir = temp.path().join("userlibs");
        let userdata_dir = temp.path().join("userdata");
        fs::create_dir_all(&extract_dir).await?;
        fs::create_dir_all(&mods_dir).await?;
        fs::create_dir_all(&plugins_dir).await?;
        fs::create_dir_all(&userlibs_dir).await?;
        fs::create_dir_all(&userdata_dir).await?;

        let service = ModsService::new(Arc::new(SqlitePool::connect_lazy("sqlite::memory:")?));
        let installed = service
            .extract_and_install_zip(
                &zip_path,
                &mods_dir,
                &plugins_dir,
                &userlibs_dir,
                &userdata_dir,
                &extract_dir,
                None,
            )
            .await?;

        assert!(mods_dir.join("Example.dll").exists());
        assert!(installed.iter().any(|file| file == "Example.dll"));

        Ok(())
    }

    #[test]
    fn validate_rar_entry_path_rejects_unsafe_paths() {
        for entry_name in [
            "../escape.dll",
            r"..\escape.dll",
            "/tmp/escape.dll",
            r"C:\Users\Public\escape.dll",
            "",
        ] {
            let err = validate_rar_entry_path(Path::new(entry_name))
                .expect_err("expected unsafe RAR entry path to be rejected");
            assert!(
                err.to_string().contains("unsafe path"),
                "unexpected error for {entry_name:?}: {err}"
            );
        }
    }

    #[test]
    fn validate_rar_entry_path_allows_safe_nested_paths() -> Result<()> {
        validate_rar_entry_path(Path::new("Mods/Example.dll"))?;
        validate_rar_entry_path(Path::new(r"Plugins\Nested\Example.dll"))?;
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
        let service = ModsService::new(pool.clone());
        let download_dir = temp.path().join("downloads");
        let mut settings_service = SettingsService::new(pool)?;
        settings_service
            .save_settings(serde_json::json!({
                "defaultDownloadDir": download_dir.to_string_lossy().to_string()
            }))
            .await?;

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
    async fn install_zip_mod_extracts_7z_archives() -> Result<()> {
        let temp = tempdir()?;
        let data_dir = temp.path().join("simmrust");
        let _data_guard =
            EnvVarGuard::set("SIMMRUST_DATA_DIR", data_dir.to_string_lossy().as_ref());
        let _home_guard =
            EnvVarGuard::set("SIMMRUST_HOME_DIR", temp.path().to_string_lossy().as_ref());
        let pool = initialize_pool().await?;
        let service = ModsService::new(pool.clone());
        let download_dir = temp.path().join("downloads");
        let mut settings_service = SettingsService::new(pool)?;
        settings_service
            .save_settings(serde_json::json!({
                "defaultDownloadDir": download_dir.to_string_lossy().to_string()
            }))
            .await?;

        let payload_dir = temp.path().join("payload");
        let payload_mods = payload_dir.join("Mods");
        fs::create_dir_all(&payload_mods).await?;
        fs::write(payload_mods.join("SevenZipExample.dll"), b"assembly").await?;
        let archive_path = temp.path().join("SevenZipExample.7z");
        sevenz_rust::compress_to_path(&payload_dir, &archive_path)?;

        let game_dir = temp.path().join("game");
        fs::create_dir_all(&game_dir).await?;
        let result = service
            .install_zip_mod(
                game_dir.to_string_lossy().as_ref(),
                archive_path.to_string_lossy().as_ref(),
                "SevenZipExample.7z",
                "IL2CPP",
                "main",
                None,
            )
            .await?;

        assert_eq!(result.get("success").and_then(|v| v.as_bool()), Some(true));
        assert!(
            service
                .path_exists_or_symlink(&game_dir.join("Mods").join("SevenZipExample.dll"))
                .await
        );

        Ok(())
    }

    #[tokio::test]
    #[serial]
    async fn install_zip_mod_extracts_tar_gz_archives() -> Result<()> {
        let temp = tempdir()?;
        let data_dir = temp.path().join("simmrust");
        let _data_guard =
            EnvVarGuard::set("SIMMRUST_DATA_DIR", data_dir.to_string_lossy().as_ref());
        let _home_guard =
            EnvVarGuard::set("SIMMRUST_HOME_DIR", temp.path().to_string_lossy().as_ref());
        let pool = initialize_pool().await?;
        let service = ModsService::new(pool.clone());
        let download_dir = temp.path().join("downloads");
        let mut settings_service = SettingsService::new(pool)?;
        settings_service
            .save_settings(serde_json::json!({
                "defaultDownloadDir": download_dir.to_string_lossy().to_string()
            }))
            .await?;

        let payload_dll = temp.path().join("TarGzExample.dll");
        fs::write(&payload_dll, b"assembly").await?;
        let archive_path = temp.path().join("TarGzExample.tar.gz");
        {
            let archive_file = File::create(&archive_path)?;
            let encoder =
                flate2::write::GzEncoder::new(archive_file, flate2::Compression::default());
            let mut archive = tar::Builder::new(encoder);
            archive.append_path_with_name(&payload_dll, "Mods/TarGzExample.dll")?;
            let encoder = archive.into_inner()?;
            encoder.finish()?;
        }

        let game_dir = temp.path().join("game");
        fs::create_dir_all(&game_dir).await?;
        let result = service
            .install_zip_mod(
                game_dir.to_string_lossy().as_ref(),
                archive_path.to_string_lossy().as_ref(),
                "TarGzExample.tar.gz",
                "IL2CPP",
                "main",
                None,
            )
            .await?;

        assert_eq!(result.get("success").and_then(|v| v.as_bool()), Some(true));
        assert!(
            service
                .path_exists_or_symlink(&game_dir.join("Mods").join("TarGzExample.dll"))
                .await
        );

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
    async fn install_zip_mod_keeps_distinct_storage_for_same_version_across_runtimes() -> Result<()>
    {
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

        let output_dir = temp.path().join("envs").join("env-runtime-collision");
        let _env = env_service
            .create_environment(
                schedule_i_config().app_id,
                "main".to_string(),
                output_dir.to_string_lossy().to_string(),
                None,
                None,
            )
            .await?;

        let il2cpp_zip = temp.path().join("Example-IL2CPP.zip");
        write_zip_fixture(&il2cpp_zip, &[("Example.IL2CPP.dll", b"il2cpp-runtime")])?;
        let mono_zip = temp.path().join("Example-Mono.zip");
        write_zip_fixture(&mono_zip, &[("Example.Mono.dll", b"mono-runtime")])?;

        let shared_metadata = serde_json::json!({
            "source": "nexusmods",
            "sourceId": "runtime-collision",
            "sourceVersion": "1.0.0"
        });

        let il2cpp_result = service
            .install_zip_mod(
                output_dir.to_string_lossy().as_ref(),
                il2cpp_zip.to_string_lossy().as_ref(),
                "Example-IL2CPP.zip",
                "IL2CPP",
                "main",
                Some(shared_metadata.clone()),
            )
            .await?;
        let mono_result = service
            .install_zip_mod(
                output_dir.to_string_lossy().as_ref(),
                mono_zip.to_string_lossy().as_ref(),
                "Example-Mono.zip",
                "Mono",
                "main",
                Some(shared_metadata),
            )
            .await?;

        let il2cpp_storage_id = il2cpp_result
            .get("storageId")
            .and_then(|value| value.as_str())
            .expect("IL2CPP storage id");
        let mono_storage_id = mono_result
            .get("storageId")
            .and_then(|value| value.as_str())
            .expect("Mono storage id");

        assert_ne!(il2cpp_storage_id, mono_storage_id);
        assert_ne!(
            mono_result
                .get("alreadyInstalled")
                .and_then(|value| value.as_bool()),
            Some(true)
        );
        assert!(download_dir
            .join("Mods")
            .join(il2cpp_storage_id)
            .join("Mods")
            .join("Example.IL2CPP.dll")
            .exists());
        assert!(download_dir
            .join("Mods")
            .join(mono_storage_id)
            .join("Mods")
            .join("Example.Mono.dll")
            .exists());

        Ok(())
    }

    #[tokio::test]
    #[serial]
    async fn disable_and_enable_mod_reject_non_dll_managed_entries() -> Result<()> {
        let temp = tempdir()?;
        let data_dir = temp.path().join("simmrust");
        let _guard = EnvVarGuard::set("SIMMRUST_DATA_DIR", data_dir.to_string_lossy().as_ref());
        let pool = initialize_pool().await?;
        let env_service = EnvironmentService::new(pool.clone())?;
        let service = ModsService::new(pool.clone());

        let output_dir = temp.path().join("envs").join("env-managed-non-dll");
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

        let active_path = mods_dir.join("notes.txt");
        fs::write(&active_path, b"notes").await?;

        let mut metadata = HashMap::new();
        let mut meta = sample_metadata(Some("managed-storage"), None, None);
        meta.symlink_paths = Some(vec![active_path.to_string_lossy().to_string()]);
        metadata.insert("notes.txt".to_string(), meta.clone());
        service.save_mod_metadata(&mods_dir, &metadata).await?;

        let disable_err = service
            .disable_mod(output_dir.to_string_lossy().as_ref(), "notes.txt")
            .await
            .expect_err("non-dll managed entry should be rejected");
        assert!(disable_err.to_string().contains("Invalid mod file"));
        assert!(active_path.exists());
        assert!(!mods_dir.join("notes.txt.disabled").exists());

        fs::remove_file(&active_path).await?;
        let disabled_path = mods_dir.join("notes.txt.disabled");
        fs::write(&disabled_path, b"notes").await?;
        service.save_mod_metadata(&mods_dir, &metadata).await?;

        let enable_err = service
            .enable_mod(output_dir.to_string_lossy().as_ref(), "notes.txt")
            .await
            .expect_err("non-dll managed entry should be rejected");
        assert!(enable_err.to_string().contains("Invalid mod file"));
        assert!(!active_path.exists());
        assert!(disabled_path.exists());

        Ok(())
    }

    #[tokio::test]
    #[serial]
    async fn install_zip_mod_links_userdata_on_first_install() -> Result<()> {
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

        let output_dir = temp.path().join("envs").join("env-userdata");
        let _env = env_service
            .create_environment(
                schedule_i_config().app_id,
                "main".to_string(),
                output_dir.to_string_lossy().to_string(),
                None,
                None,
            )
            .await?;

        let zip_path = temp.path().join("WithUserData.zip");
        write_zip_fixture(
            &zip_path,
            &[
                ("Example.dll", b"runtime"),
                ("UserData/MyFeature/config.json", br#"{"enabled":true}"#),
            ],
        )?;

        let result = service
            .install_zip_mod(
                output_dir.to_string_lossy().as_ref(),
                zip_path.to_string_lossy().as_ref(),
                "WithUserData.zip",
                "IL2CPP",
                "main",
                Some(serde_json::json!({
                    "source": "local"
                })),
            )
            .await?;

        assert_eq!(result.get("success").and_then(|v| v.as_bool()), Some(true));

        let installed_config = output_dir
            .join("UserData")
            .join("MyFeature")
            .join("config.json");
        assert!(installed_config.exists());

        let metadata = service.load_mod_metadata(&output_dir.join("Mods")).await?;
        let meta = metadata.get("Example.dll").expect("mod metadata");
        let symlink_paths = meta.symlink_paths.as_ref().expect("symlink paths");
        assert!(
            symlink_paths.iter().any(|path| {
                path.ends_with("UserData\\MyFeature") || path.ends_with("UserData/MyFeature")
            }),
            "expected UserData symlink path, got {:?}",
            symlink_paths
        );

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
    async fn get_mod_library_detects_nested_storage_files_for_fomod_archives() -> Result<()> {
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

        let storage_dir = service.get_mods_storage_dir().await?.join("nested-fomod");
        fs::create_dir_all(storage_dir.join("Mods").join("IL2CPP")).await?;
        fs::create_dir_all(storage_dir.join("Mods").join("Mono")).await?;
        fs::write(
            storage_dir
                .join("Mods")
                .join("IL2CPP")
                .join("PackRat.IL2CPP.dll"),
            b"il2cpp",
        )
        .await?;
        fs::write(
            storage_dir
                .join("Mods")
                .join("Mono")
                .join("PackRat.Mono.dll"),
            b"mono",
        )
        .await?;

        let mut storage_meta = sample_metadata(Some("nested-fomod"), Some("1629"), Some("1.0.7r2"));
        storage_meta.mod_name = Some("Pack Rat".to_string());
        storage_meta.source = Some(ModSource::Nexusmods);
        service
            .save_storage_metadata(&storage_dir, &storage_meta)
            .await?;

        let library = service.get_mod_library().await?;
        let entry = library
            .downloaded
            .iter()
            .find(|item| item.storage_id == "nested-fomod")
            .expect("library entry for nested fomod storage");

        assert!(entry
            .files
            .iter()
            .any(|file| file == "IL2CPP/PackRat.IL2CPP.dll"));
        assert!(entry
            .files
            .iter()
            .any(|file| file == "Mono/PackRat.Mono.dll"));
        assert_eq!(
            entry
                .files_by_runtime
                .get("IL2CPP")
                .cloned()
                .unwrap_or_default(),
            vec!["IL2CPP/PackRat.IL2CPP.dll".to_string()]
        );
        assert_eq!(
            entry
                .files_by_runtime
                .get("Mono")
                .cloned()
                .unwrap_or_default(),
            vec!["Mono/PackRat.Mono.dll".to_string()]
        );
        assert!(entry
            .available_runtimes
            .iter()
            .any(|runtime| runtime == "IL2CPP"));
        assert!(entry
            .available_runtimes
            .iter()
            .any(|runtime| runtime == "Mono"));

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
    async fn persist_installed_mod_security_scan_summary_updates_local_metadata() -> Result<()> {
        let temp = tempdir()?;
        let data_dir = temp.path().join("simmrust");
        let _data_guard =
            EnvVarGuard::set("SIMMRUST_DATA_DIR", data_dir.to_string_lossy().as_ref());
        let pool = initialize_pool().await?;
        let env_service = EnvironmentService::new(pool.clone())?;
        let service = ModsService::new(pool.clone());

        let output_dir = temp.path().join("envs").join("env-local-scan");
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
        fs::write(mods_dir.join("LocalOnly.dll"), b"data").await?;

        let summary = SecurityScanSummary {
            state: SecurityScanState::Verified,
            verified: true,
            disposition: None,
            highest_severity: None,
            total_findings: 0,
            threat_family_count: 0,
            scanned_at: Some(chrono::Utc::now()),
            scanner_version: Some("1.2.3".to_string()),
            schema_version: Some("2026-03".to_string()),
            status_message: Some("MLVScan classified this file as safe.".to_string()),
        };

        service
            .persist_installed_mod_security_scan_summary(
                output_dir.to_string_lossy().as_ref(),
                "LocalOnly.dll",
                summary.clone(),
            )
            .await?;

        let metadata = service.load_mod_metadata(&mods_dir).await?;
        assert_eq!(
            metadata
                .get("LocalOnly.dll")
                .and_then(|meta| meta.security_scan.as_ref())
                .map(|scan| scan.state.clone()),
            Some(SecurityScanState::Verified)
        );

        Ok(())
    }

    #[tokio::test]
    #[serial]
    async fn persist_installed_mod_security_scan_summary_propagates_metadata_load_errors(
    ) -> Result<()> {
        let temp = tempdir()?;
        let data_dir = temp.path().join("simmrust");
        let _data_guard =
            EnvVarGuard::set("SIMMRUST_DATA_DIR", data_dir.to_string_lossy().as_ref());
        let pool = initialize_pool().await?;
        let env_service = EnvironmentService::new(pool.clone())?;
        let service = ModsService::new(pool.clone());

        let valid_download_dir = temp.path().join("downloads");
        let mut settings_service = SettingsService::new(pool.clone())?;
        settings_service
            .save_settings(serde_json::json!({
                "defaultDownloadDir": valid_download_dir.to_string_lossy().to_string()
            }))
            .await?;

        let output_dir = temp.path().join("env-load-error");
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
        fs::write(mods_dir.join("ScanMe.dll"), b"scan").await?;
        fs::write(mods_dir.join("KeepMe.dll"), b"keep").await?;

        let mut metadata = HashMap::new();
        metadata.insert(
            "ScanMe.dll".to_string(),
            sample_metadata(None, Some("local"), Some("1.0.0")),
        );
        metadata.insert(
            "KeepMe.dll".to_string(),
            sample_metadata(None, Some("local"), Some("2.0.0")),
        );
        service.save_mod_metadata(&mods_dir, &metadata).await?;

        let blocker_path = temp.path().join("download-dir-is-a-file");
        fs::write(&blocker_path, b"not a directory").await?;
        settings_service
            .save_settings(serde_json::json!({
                "defaultDownloadDir": blocker_path.to_string_lossy().to_string()
            }))
            .await?;

        let result = service
            .persist_installed_mod_security_scan_summary(
                output_dir.to_string_lossy().as_ref(),
                "ScanMe.dll",
                SecurityScanSummary {
                    state: SecurityScanState::Verified,
                    verified: true,
                    disposition: None,
                    highest_severity: None,
                    total_findings: 0,
                    threat_family_count: 0,
                    scanned_at: None,
                    scanner_version: None,
                    schema_version: None,
                    status_message: Some("Verified".to_string()),
                },
            )
            .await;

        assert!(
            result.is_err(),
            "metadata load errors should propagate instead of replacing existing metadata"
        );

        let row_count: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM mod_metadata WHERE environment_id = ? AND kind = 'mods'",
        )
        .bind(&env.id)
        .fetch_one(&*pool)
        .await?;
        assert_eq!(row_count, 2, "existing metadata should remain intact");

        Ok(())
    }

    #[tokio::test]
    #[serial]
    async fn resolve_installed_mod_path_rejects_traversal() -> Result<()> {
        let temp = tempdir()?;
        let data_dir = temp.path().join("simmrust");
        let _data_guard =
            EnvVarGuard::set("SIMMRUST_DATA_DIR", data_dir.to_string_lossy().as_ref());
        let pool = initialize_pool().await?;
        let service = ModsService::new(pool.clone());

        let output_dir = temp.path().join("envs").join("env-local-scan");
        let err = service
            .resolve_installed_mod_path(
                output_dir.to_string_lossy().as_ref(),
                "../Plugins/Escape.dll",
            )
            .await
            .expect_err("expected traversal path to be rejected");

        assert!(err.to_string().contains("unsafe"));

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
        let storage_file = storage_dir.join("Mods").join("DispositionWins.dll");
        fs::write(&storage_file, b"data").await?;
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
        tokio::fs::remove_file(mods_dir.join("DispositionWins.dll")).await?;
        service
            .create_symlink_file(&storage_file, &mods_dir.join("DispositionWins.dll"))
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
        service
            .save_storage_metadata(&download_dir.join("Mods").join("storage-v1"), &metadata_v1)
            .await?;
        service
            .save_storage_metadata(&download_dir.join("Mods").join("storage-v2"), &metadata_v2)
            .await?;

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
        let il2cpp_storage_file = storage_il2cpp.join("S1FuelMod.IL2CPP.dll");
        let mono_storage_file = storage_mono.join("S1FuelMod.Mono.dll");
        fs::write(&il2cpp_storage_file, b"il2cpp").await?;
        fs::write(&mono_storage_file, b"mono").await?;
        service
            .save_storage_metadata(
                &download_dir.join("Mods").join("storage-s1fuel-il2cpp"),
                &il2cpp_metadata["S1FuelMod.IL2CPP.dll"],
            )
            .await?;
        service
            .save_storage_metadata(
                &download_dir.join("Mods").join("storage-s1fuel-mono"),
                &mono_metadata["S1FuelMod.Mono.dll"],
            )
            .await?;
        service
            .create_symlink_file(
                &il2cpp_storage_file,
                &il2cpp_mods_dir.join("S1FuelMod.IL2CPP.dll"),
            )
            .await?;
        service
            .create_symlink_file(
                &mono_storage_file,
                &mono_mods_dir.join("S1FuelMod.Mono.dll"),
            )
            .await?;

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
        let download_dir = temp.path().join("downloads");
        let mut settings_service = SettingsService::new(pool.clone())?;
        settings_service
            .save_settings(serde_json::json!({
                "defaultDownloadDir": download_dir.to_string_lossy().to_string()
            }))
            .await?;

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
        let storage_root = service.get_mods_storage_dir().await?;
        let storage_mods_dir = storage_root.join("storage-1").join("Mods");
        fs::create_dir_all(&storage_mods_dir).await?;
        let storage_file = storage_mods_dir.join("Example.dll");
        fs::write(&storage_file, b"data").await?;

        let env_mod_path = mods_dir.join("Example.dll");
        service
            .create_symlink_file(&storage_file, &env_mod_path)
            .await?;

        let mut metadata = HashMap::new();
        let mut meta = sample_metadata(Some("storage-1"), Some("source"), Some("1.0.0"));
        meta.symlink_paths = Some(vec![env_mod_path.to_string_lossy().to_string()]);
        metadata.insert("Example.dll".to_string(), meta);
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
        assert!(!env_mod_path.exists());

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
    async fn uninstall_storage_mod_from_envs_preserves_unrelated_files_in_shared_directories(
    ) -> Result<()> {
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

        let output_dir = temp.path().join("envs").join("env-shared");
        let env = env_service
            .create_environment(
                schedule_i_config().app_id,
                "main".to_string(),
                output_dir.to_string_lossy().to_string(),
                None,
                None,
            )
            .await?;

        let mods_dir = output_dir.join("Mods").join("Shared");
        fs::create_dir_all(&mods_dir).await?;
        fs::write(mods_dir.join("Owned.dll"), b"owned").await?;
        fs::write(mods_dir.join("Keep.dll"), b"keep").await?;

        let storage_dir = service.get_mods_storage_dir().await?.join("storage-shared");
        let storage_mods_dir = storage_dir.join("Mods").join("Shared");
        fs::create_dir_all(&storage_mods_dir).await?;
        fs::write(storage_mods_dir.join("Owned.dll"), b"owned").await?;

        let mut metadata = HashMap::new();
        metadata.insert(
            "Shared/Owned.dll".to_string(),
            sample_metadata(Some("storage-shared"), Some("source"), Some("1.0.0")),
        );
        service
            .save_mod_metadata(&output_dir.join("Mods"), &metadata)
            .await?;

        service
            .uninstall_storage_mod_from_envs("storage-shared", vec![env.id.clone()])
            .await?;

        assert!(!mods_dir.join("Owned.dll").exists());
        assert!(mods_dir.join("Keep.dll").exists());
        assert!(mods_dir.exists());

        Ok(())
    }

    #[tokio::test]
    #[serial]
    async fn uninstall_storage_mod_from_envs_preserves_paths_now_owned_by_other_storage(
    ) -> Result<()> {
        let temp = tempdir()?;
        let data_dir = temp.path().join("simmrust");
        let _data_guard =
            EnvVarGuard::set("SIMMRUST_DATA_DIR", data_dir.to_string_lossy().as_ref());
        let pool = initialize_pool().await?;
        let env_service = EnvironmentService::new(pool.clone())?;
        let service = ModsService::new(pool.clone());

        let download_dir = temp.path().join("downloads");
        let mut settings_service = SettingsService::new(pool)?;
        settings_service
            .save_settings(serde_json::json!({
                "defaultDownloadDir": download_dir.to_string_lossy().to_string()
            }))
            .await?;

        let output_dir = temp.path().join("envs").join("env-owned-by-other-storage");
        let env = env_service
            .create_environment(
                schedule_i_config().app_id,
                "main".to_string(),
                output_dir.to_string_lossy().to_string(),
                None,
                None,
            )
            .await?;

        let storage_root = service.get_mods_storage_dir().await?;
        let old_storage = storage_root.join("storage-old");
        let new_storage = storage_root.join("storage-new");
        fs::create_dir_all(old_storage.join("Mods")).await?;
        fs::create_dir_all(new_storage.join("Mods")).await?;
        fs::write(old_storage.join("Mods").join("Shared.dll"), b"old").await?;
        fs::write(new_storage.join("Mods").join("Shared.dll"), b"new").await?;

        let env_mod_path = output_dir.join("Mods").join("Shared.dll");
        fs::create_dir_all(env_mod_path.parent().expect("mods dir")).await?;
        service
            .create_symlink_file(&new_storage.join("Mods").join("Shared.dll"), &env_mod_path)
            .await?;

        let mut metadata = HashMap::new();
        let mut meta = sample_metadata(Some("storage-old"), Some("source"), Some("1.0.0"));
        meta.symlink_paths = Some(vec![env_mod_path.to_string_lossy().to_string()]);
        metadata.insert("Shared.dll".to_string(), meta);
        service
            .save_mod_metadata(&output_dir.join("Mods"), &metadata)
            .await?;

        service
            .uninstall_storage_mod_from_envs("storage-old", vec![env.id.clone()])
            .await?;

        assert!(
            service.path_exists_or_symlink(&env_mod_path).await,
            "environment path should remain because it now points at a different storage entry"
        );
        assert_eq!(
            service
                .infer_storage_id_from_symlink(&env_mod_path, &storage_root)
                .await
                .as_deref(),
            Some("storage-new")
        );

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
        let download_dir = temp.path().join("downloads");
        let mut settings_service = SettingsService::new(pool.clone())?;
        settings_service
            .save_settings(serde_json::json!({
                "defaultDownloadDir": download_dir.to_string_lossy().to_string()
            }))
            .await?;

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

        let storage_dir = service.get_mods_storage_dir().await?.join("storage-2");
        let storage_mods_dir = storage_dir.join("Mods");
        fs::create_dir_all(&storage_mods_dir).await?;
        let storage_file = storage_mods_dir.join("Example.dll");
        fs::write(&storage_file, b"data").await?;

        let env_mod_path = mods_dir.join("Example.dll");
        service
            .create_symlink_file(&storage_file, &env_mod_path)
            .await?;

        let mut metadata = HashMap::new();
        let mut meta = sample_metadata(Some("storage-2"), Some("source"), Some("1.0.0"));
        meta.symlink_paths = Some(vec![env_mod_path.to_string_lossy().to_string()]);
        metadata.insert("Example.dll".to_string(), meta);
        service.save_mod_metadata(&mods_dir, &metadata).await?;

        let result = service.delete_downloaded_mod("storage-2").await?;
        assert_eq!(result.get("deleted").and_then(|v| v.as_bool()), Some(true));
        assert!(!storage_dir.exists());
        assert!(!env_mod_path.exists());

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
    async fn install_storage_entries_creates_destination_directory_and_materializes_file(
    ) -> Result<()> {
        let temp = tempdir()?;
        let service = ModsService::new(Arc::new(SqlitePool::connect_lazy("sqlite::memory:")?));

        let source_dir = temp.path().join("storage").join("Mods");
        fs::create_dir_all(&source_dir).await?;
        fs::write(source_dir.join("Example.dll"), b"data").await?;

        let dest_dir = temp.path().join("missing").join("Mods");
        let mut metadata_map = HashMap::new();
        let mut installed_files = Vec::new();
        let mut warnings = Vec::new();

        service
            .install_storage_entries(
                &source_dir,
                &source_dir,
                &dest_dir,
                false,
                "unknown",
                &None,
                "storage-1",
                &mut metadata_map,
                &mut installed_files,
                &mut warnings,
                &Runtime::Il2cpp,
            )
            .await?;

        let installed_path = dest_dir.join("Example.dll");
        let installed_meta = fs::symlink_metadata(&installed_path).await?;

        assert!(dest_dir.exists());
        assert!(
            installed_meta.file_type().is_symlink() || installed_meta.is_file(),
            "install should create either a symlink or a regular fallback file"
        );
        assert_eq!(fs::read(&installed_path).await?, b"data");
        assert_eq!(installed_files, vec!["Example.dll".to_string()]);
        assert!(metadata_map.contains_key("Example.dll"));
        assert!(warnings.is_empty());

        Ok(())
    }

    #[tokio::test]
    async fn install_storage_entries_keeps_bucket_qualified_metadata_keys() -> Result<()> {
        let temp = tempdir()?;
        let service = ModsService::new(Arc::new(SqlitePool::connect_lazy("sqlite::memory:")?));

        let source_dir = temp.path().join("storage").join("Mods");
        fs::create_dir_all(source_dir.join("Mono")).await?;
        fs::create_dir_all(source_dir.join("Net35")).await?;
        fs::write(source_dir.join("Mono").join("Shared.dll"), b"mono").await?;
        fs::write(source_dir.join("Net35").join("Shared.dll"), b"net35").await?;

        let dest_dir = temp.path().join("missing").join("Mods");
        let mut metadata_map = HashMap::new();
        let mut installed_files = Vec::new();
        let mut warnings = Vec::new();

        service
            .install_storage_entries(
                &source_dir,
                &source_dir,
                &dest_dir,
                false,
                "Mono",
                &None,
                "storage-1",
                &mut metadata_map,
                &mut installed_files,
                &mut warnings,
                &Runtime::Mono,
            )
            .await?;

        let mut installed_files_sorted = installed_files.clone();
        installed_files_sorted.sort();
        assert_eq!(
            installed_files_sorted,
            vec![
                "Mono/Shared.dll".to_string(),
                "Net35/Shared.dll".to_string()
            ]
        );
        assert!(metadata_map.contains_key("Mono/Shared.dll"));
        assert!(metadata_map.contains_key("Net35/Shared.dll"));
        assert!(warnings.is_empty());

        Ok(())
    }

    #[tokio::test]
    #[serial]
    async fn store_mod_archive_extracts_fomod_runtime_variants_to_storage() -> Result<()> {
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

        let zip_path = temp.path().join("PackRat-Fomod.zip");
        write_zip_fixture(
            &zip_path,
            &[
                (
                    "fomod/moduleconfig.xml",
                    br#"
<config>
  <moduleName>Pack Rat</moduleName>
  <installSteps order="Explicit">
    <installStep name="Runtime">
      <optionalFileGroups order="Explicit">
        <group name="Runtime" type="SelectExactlyOne">
          <plugins order="Explicit">
            <plugin name="IL2CPP">
              <description>IL2CPP runtime</description>
              <files>
                <file source="IL2CPP/PackRat.IL2CPP.dll" destination="Mods" />
              </files>
            </plugin>
            <plugin name="Mono">
              <description>Mono runtime</description>
              <files>
                <file source="Mono/PackRat.Mono.dll" destination="Mods" />
              </files>
            </plugin>
          </plugins>
        </group>
      </optionalFileGroups>
    </installStep>
  </installSteps>
</config>
"#,
                ),
                ("IL2CPP/PackRat.IL2CPP.dll", b"il2cpp-bytes"),
                ("Mono/PackRat.Mono.dll", b"mono-bytes"),
            ],
        )?;

        let stored = service
            .store_mod_archive(
                zip_path.to_string_lossy().as_ref(),
                "PackRat-Fomod.zip",
                None,
                Some(serde_json::json!({
                    "source": "nexusmods",
                    "sourceId": "1629",
                    "sourceVersion": "1.0.7r2"
                })),
                None,
            )
            .await?;

        let storage_id = stored
            .get("storageId")
            .and_then(|value| value.as_str())
            .expect("storage id");
        let storage_dir = service.get_mods_storage_dir().await?.join(storage_id);

        assert!(storage_dir.join("Mods").join("PackRat.IL2CPP.dll").exists());
        assert!(storage_dir.join("Mods").join("PackRat.Mono.dll").exists());

        Ok(())
    }

    #[tokio::test]
    #[serial]
    async fn store_mod_archive_honors_requested_runtime_for_fomod_mods() -> Result<()> {
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

        let zip_path = temp.path().join("RuntimeSpecific-Fomod.zip");
        write_zip_fixture(
            &zip_path,
            &[
                (
                    "fomod/moduleconfig.xml",
                    br#"
<config>
  <moduleName>Runtime Specific</moduleName>
  <installSteps order="Explicit">
    <installStep name="Runtime">
      <optionalFileGroups order="Explicit">
        <group name="Runtime" type="SelectExactlyOne">
          <plugins order="Explicit">
            <plugin name="IL2CPP">
              <files>
                <file source="IL2CPP/RuntimeSpecific.IL2CPP.dll" destination="Mods" />
              </files>
            </plugin>
            <plugin name="Mono">
              <files>
                <file source="Mono/RuntimeSpecific.Mono.dll" destination="Mods" />
              </files>
            </plugin>
          </plugins>
        </group>
      </optionalFileGroups>
    </installStep>
  </installSteps>
</config>
"#,
                ),
                ("IL2CPP/RuntimeSpecific.IL2CPP.dll", b"il2cpp-bytes"),
                ("Mono/RuntimeSpecific.Mono.dll", b"mono-bytes"),
            ],
        )?;

        let stored = service
            .store_mod_archive(
                zip_path.to_string_lossy().as_ref(),
                "RuntimeSpecific-Fomod.zip",
                Some(Runtime::Mono),
                Some(serde_json::json!({
                    "source": "nexusmods",
                    "sourceId": "runtime-specific",
                    "sourceVersion": "1.0.0"
                })),
                None,
            )
            .await?;

        let storage_id = stored
            .get("storageId")
            .and_then(|value| value.as_str())
            .expect("storage id");
        let storage_dir = service.get_mods_storage_dir().await?.join(storage_id);

        assert!(storage_dir
            .join("Mods")
            .join("RuntimeSpecific.Mono.dll")
            .exists());
        assert!(!storage_dir
            .join("Mods")
            .join("RuntimeSpecific.IL2CPP.dll")
            .exists());

        Ok(())
    }

    #[tokio::test]
    #[serial]
    async fn try_extract_fomod_content_returns_none_when_no_payload_is_materialized() -> Result<()>
    {
        let temp = tempdir()?;
        let data_dir = temp.path().join("simmrust");
        let _data_guard =
            EnvVarGuard::set("SIMMRUST_DATA_DIR", data_dir.to_string_lossy().as_ref());
        let pool = initialize_pool().await?;
        let service = ModsService::new(pool);

        let content_root = temp.path().join("content");
        fs::create_dir_all(content_root.join("fomod")).await?;
        fs::write(
            content_root.join("fomod").join("moduleconfig.xml"),
            br#"
<config>
  <moduleName>Missing Payload</moduleName>
  <requiredInstallFiles>
    <files>
      <file source="Missing/Example.dll" destination="Mods" />
    </files>
  </requiredInstallFiles>
</config>
"#,
        )
        .await?;

        let mods_dir = temp.path().join("mods");
        let plugins_dir = temp.path().join("plugins");
        let userlibs_dir = temp.path().join("userlibs");
        let userdata_dir = temp.path().join("userdata");
        fs::create_dir_all(&mods_dir).await?;
        fs::create_dir_all(&plugins_dir).await?;
        fs::create_dir_all(&userlibs_dir).await?;
        fs::create_dir_all(&userdata_dir).await?;

        let result = service
            .try_extract_fomod_content(
                &content_root,
                &mods_dir,
                &plugins_dir,
                &userlibs_dir,
                &userdata_dir,
                None,
            )
            .await?;

        assert!(result.is_none());
        Ok(())
    }

    #[tokio::test]
    async fn resolve_fomod_destination_uses_explicit_destination_over_source_layout() -> Result<()>
    {
        let pool = SqlitePool::connect_lazy("sqlite::memory:")?;
        let service = ModsService::new(Arc::new(pool));
        let entry = FomodInstallEntry {
            source: "Plugins/Example.dll".to_string(),
            destination: "Mods".to_string(),
            is_folder: false,
            priority: 0,
            runtime: None,
        };

        let (kind, relative, explicit_file_target) = service.resolve_fomod_destination(&entry)?;

        assert_eq!(kind, FomodDestinationKind::Mods);
        assert!(relative.as_os_str().is_empty());
        assert!(!explicit_file_target);
        Ok(())
    }

    #[tokio::test]
    async fn resolve_fomod_destination_rejects_unsafe_paths() -> Result<()> {
        let pool = SqlitePool::connect_lazy("sqlite::memory:")?;
        let service = ModsService::new(Arc::new(pool));
        let entry = FomodInstallEntry {
            source: "../outside/Example.dll".to_string(),
            destination: "Mods".to_string(),
            is_folder: false,
            priority: 0,
            runtime: None,
        };

        let error = service
            .resolve_fomod_destination(&entry)
            .expect_err("expected unsafe FOMOD source path to be rejected");
        assert!(error.to_string().contains("Invalid FOMOD relative path"));
        Ok(())
    }

    #[tokio::test]
    async fn resolve_fomod_destination_strips_nested_bucket_segment() -> Result<()> {
        let pool = SqlitePool::connect_lazy("sqlite::memory:")?;
        let service = ModsService::new(Arc::new(pool));
        let entry = FomodInstallEntry {
            source: "data/Plugins/Subdir/Example.dll".to_string(),
            destination: String::new(),
            is_folder: false,
            priority: 0,
            runtime: None,
        };

        let (kind, relative, explicit_file_target) = service.resolve_fomod_destination(&entry)?;

        assert_eq!(kind, FomodDestinationKind::Plugins);
        assert_eq!(relative, PathBuf::from("Subdir").join("Example.dll"));
        assert!(explicit_file_target);
        Ok(())
    }

    #[tokio::test]
    #[serial]
    async fn get_mod_library_attaches_userlibs_to_the_owning_mod() -> Result<()> {
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

        let storage_dir = service.get_mods_storage_dir().await?.join("userlibs-owned");
        fs::create_dir_all(storage_dir.join("Mods")).await?;
        fs::create_dir_all(storage_dir.join("UserLibs").join("Config")).await?;
        fs::write(storage_dir.join("Mods").join("Example.dll"), b"mod").await?;
        fs::write(
            storage_dir
                .join("UserLibs")
                .join("Config")
                .join("settings.json"),
            br#"{"enabled":true}"#,
        )
        .await?;

        let mut storage_meta = sample_metadata(
            Some("userlibs-owned"),
            Some("example/source"),
            Some("1.0.0"),
        );
        storage_meta.mod_name = Some("Example Mod".to_string());
        service
            .save_storage_metadata(&storage_dir, &storage_meta)
            .await?;

        let library = service.get_mod_library().await?;
        let entry = library
            .downloaded
            .iter()
            .find(|item| item.storage_id == "userlibs-owned")
            .expect("library entry for userlibs-owned storage");

        assert_eq!(entry.files, vec!["Example.dll".to_string()]);
        assert_eq!(
            entry.attached_userlibs,
            vec!["Config/settings.json".to_string()]
        );

        Ok(())
    }

    #[tokio::test]
    #[serial]
    async fn get_local_mod_ownership_candidates_includes_nested_bucket_files() -> Result<()> {
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

        let output_dir = temp.path().join("envs").join("env-local-link-candidates");
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
        let userdata_dir = output_dir.join("UserData").join("MyFeature");
        let userlibs_dir = output_dir.join("UserLibs").join("MyFeature");
        fs::create_dir_all(&mods_dir).await?;
        fs::create_dir_all(&userdata_dir).await?;
        fs::create_dir_all(&userlibs_dir).await?;
        fs::write(mods_dir.join("MyFeature.dll"), b"mod").await?;
        fs::write(userdata_dir.join("config.json"), br#"{"enabled":true}"#).await?;
        fs::write(userlibs_dir.join("helper.dll"), b"helper").await?;

        let candidates = service
            .get_local_mod_ownership_candidates(
                output_dir.to_string_lossy().as_ref(),
                "MyFeature.dll",
                Some("MyFeature"),
            )
            .await?;

        assert!(candidates.iter().any(|candidate| {
            candidate.bucket == "userdata" && candidate.relative_path == "MyFeature/config.json"
        }));
        assert!(candidates.iter().any(|candidate| {
            candidate.bucket == "userlibs" && candidate.relative_path == "MyFeature/helper.dll"
        }));

        Ok(())
    }

    #[tokio::test]
    async fn copy_selected_local_link_candidates_to_storage_copies_userdata_files() -> Result<()> {
        let temp = tempdir()?;
        let service = ModsService::new(Arc::new(SqlitePool::connect_lazy("sqlite::memory:")?));

        let game_dir = temp.path().join("game");
        let source_userdata = game_dir.join("UserData").join("MyFeature");
        fs::create_dir_all(&source_userdata).await?;
        fs::write(source_userdata.join("state.json"), br#"{"debug":true}"#).await?;

        let storage_root = temp.path().join("storage");
        let storage_mods = storage_root.join("Mods");
        let storage_plugins = storage_root.join("Plugins");
        let storage_userlibs = storage_root.join("UserLibs");
        let storage_userdata = storage_root.join("UserData");
        fs::create_dir_all(&storage_mods).await?;
        fs::create_dir_all(&storage_plugins).await?;
        fs::create_dir_all(&storage_userlibs).await?;
        fs::create_dir_all(&storage_userdata).await?;

        let candidate_id =
            ModsService::normalize_link_candidate_id("userdata", "MyFeature/state.json");
        let allowed = HashSet::from([candidate_id.clone()]);
        service
            .copy_selected_local_link_candidates_to_storage(
                game_dir.to_string_lossy().as_ref(),
                &allowed,
                &[candidate_id],
                &storage_mods,
                &storage_plugins,
                &storage_userlibs,
                &storage_userdata,
            )
            .await?;

        assert!(storage_userdata
            .join("MyFeature")
            .join("state.json")
            .exists());

        Ok(())
    }

    #[tokio::test]
    async fn try_extract_fomod_content_tracks_destination_file_names_for_renamed_files(
    ) -> Result<()> {
        let temp = tempdir()?;
        let service = ModsService::new(Arc::new(SqlitePool::connect_lazy("sqlite::memory:")?));

        let content_root = temp.path().join("content");
        fs::create_dir_all(content_root.join("fomod")).await?;
        fs::create_dir_all(content_root.join("data")).await?;
        fs::write(content_root.join("data").join("Original.dll"), b"renamed").await?;
        fs::write(
            content_root.join("fomod").join("moduleconfig.xml"),
            r#"
<config>
  <moduleName>Rename Test</moduleName>
  <installSteps order="Explicit">
    <installStep name="Required">
      <requiredInstallFiles>
        <file source="data/Original.dll" destination="Mods/Renamed.dll" />
      </requiredInstallFiles>
    </installStep>
  </installSteps>
</config>
"#,
        )
        .await?;

        let mods_dir = temp.path().join("mods");
        let plugins_dir = temp.path().join("plugins");
        let userlibs_dir = temp.path().join("userlibs");
        let userdata_dir = temp.path().join("userdata");
        fs::create_dir_all(&mods_dir).await?;
        fs::create_dir_all(&plugins_dir).await?;
        fs::create_dir_all(&userlibs_dir).await?;
        fs::create_dir_all(&userdata_dir).await?;

        let installed_files = service
            .try_extract_fomod_content(
                &content_root,
                &mods_dir,
                &plugins_dir,
                &userlibs_dir,
                &userdata_dir,
                None,
            )
            .await?
            .expect("fomod extraction should materialize files");

        assert_eq!(installed_files, vec!["Renamed.dll".to_string()]);
        assert!(mods_dir.join("Renamed.dll").exists());
        assert!(!mods_dir.join("Original.dll").exists());

        Ok(())
    }

    #[tokio::test]
    #[serial]
    async fn install_storage_mod_to_envs_installs_nested_mono_storage_files() -> Result<()> {
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

        let mono_output_dir = temp.path().join("envs").join("env-mono");
        let mono_env = env_service
            .create_environment(
                schedule_i_config().app_id,
                "alternate-beta".to_string(),
                mono_output_dir.to_string_lossy().to_string(),
                None,
                None,
            )
            .await?;
        let mut stale_env = mono_env.clone();
        stale_env.runtime = Runtime::Il2cpp;
        env_service.upsert_environment(&stale_env).await?;

        let storage_base = download_dir.join("Mods").join("storage-mono-nested");
        let nested_mods_dir = storage_base.join("Mods").join("Net35");
        fs::create_dir_all(&nested_mods_dir).await?;
        fs::write(nested_mods_dir.join("ScheduleToolbox.dll"), b"mono").await?;

        let mut storage_meta = sample_metadata(
            Some("storage-mono-nested"),
            Some("Author/ScheduleToolbox"),
            Some("1.2.0"),
        );
        storage_meta.source = Some(ModSource::Thunderstore);
        storage_meta.mod_name = Some("ScheduleToolbox".to_string());
        storage_meta.author = Some("Author".to_string());
        storage_meta.detected_runtime = Some(Runtime::Mono);
        service
            .save_storage_metadata(&storage_base, &storage_meta)
            .await?;

        service
            .install_storage_mod_to_envs("storage-mono-nested", vec![stale_env.id.clone()])
            .await?;

        let installed_path = mono_output_dir
            .join("Mods")
            .join("Net35")
            .join("ScheduleToolbox.dll");
        assert!(service.path_exists_or_symlink(&installed_path).await);

        Ok(())
    }

    #[tokio::test]
    #[serial]
    async fn install_storage_mod_to_envs_skips_nested_runtime_folder_for_other_runtime(
    ) -> Result<()> {
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

        let mono_output_dir = temp.path().join("envs").join("env-mono-runtime-split");
        let mono_env = env_service
            .create_environment(
                schedule_i_config().app_id,
                "alternate-beta".to_string(),
                mono_output_dir.to_string_lossy().to_string(),
                None,
                None,
            )
            .await?;

        let storage_base = download_dir.join("Mods").join("storage-runtime-split");
        let mono_storage_dir = storage_base.join("Mods").join("Mono");
        let il2cpp_storage_dir = storage_base.join("Mods").join("IL2CPP");
        fs::create_dir_all(&mono_storage_dir).await?;
        fs::create_dir_all(&il2cpp_storage_dir).await?;
        fs::write(mono_storage_dir.join("RuntimeNeutral.dll"), b"mono").await?;
        fs::write(il2cpp_storage_dir.join("RuntimeNeutral.dll"), b"il2cpp").await?;

        let mut storage_meta = sample_metadata(
            Some("storage-runtime-split"),
            Some("Author/RuntimeNeutral"),
            Some("1.0.0"),
        );
        storage_meta.source = Some(ModSource::Thunderstore);
        storage_meta.mod_name = Some("RuntimeNeutral".to_string());
        storage_meta.author = Some("Author".to_string());
        service
            .save_storage_metadata(&storage_base, &storage_meta)
            .await?;

        service
            .install_storage_mod_to_envs("storage-runtime-split", vec![mono_env.id.clone()])
            .await?;

        let mono_installed_path = mono_output_dir
            .join("Mods")
            .join("Mono")
            .join("RuntimeNeutral.dll");
        let il2cpp_installed_path = mono_output_dir
            .join("Mods")
            .join("IL2CPP")
            .join("RuntimeNeutral.dll");

        assert!(service.path_exists_or_symlink(&mono_installed_path).await);
        assert!(!service.path_exists_or_symlink(&il2cpp_installed_path).await);
        assert_eq!(fs::read(&mono_installed_path).await?, b"mono");

        Ok(())
    }

    #[tokio::test]
    #[serial]
    async fn install_zip_mod_installs_nested_fomod_payloads_on_first_install() -> Result<()> {
        let temp = tempdir()?;
        let data_dir = temp.path().join("simmrust");
        let _data_guard =
            EnvVarGuard::set("SIMMRUST_DATA_DIR", data_dir.to_string_lossy().as_ref());
        let _home_guard =
            EnvVarGuard::set("SIMMRUST_HOME_DIR", temp.path().to_string_lossy().as_ref());
        let pool = initialize_pool().await?;
        let service = ModsService::new(pool.clone());

        let download_dir = temp.path().join("downloads");
        let mut settings_service = SettingsService::new(pool)?;
        settings_service
            .save_settings(serde_json::json!({
                "defaultDownloadDir": download_dir.to_string_lossy().to_string()
            }))
            .await?;

        let output_dir = temp.path().join("envs").join("env-fomod-initial-nested");
        fs::create_dir_all(&output_dir).await?;

        let zip_path = temp.path().join("NestedFomod.zip");
        write_zip_fixture(
            &zip_path,
            &[
                (
                    "fomod/moduleconfig.xml",
                    br#"
<config>
  <moduleName>Nested Install</moduleName>
  <installSteps order="Explicit">
    <installStep name="Required">
      <requiredInstallFiles>
        <file source="data/Net35/Nested.dll" destination="Mods/Net35" />
      </requiredInstallFiles>
    </installStep>
  </installSteps>
</config>
"#,
                ),
                ("data/Net35/Nested.dll", b"nested"),
            ],
        )?;

        let result = service
            .install_zip_mod(
                output_dir.to_string_lossy().as_ref(),
                zip_path.to_string_lossy().as_ref(),
                "NestedFomod.zip",
                "Mono",
                "alternate",
                Some(serde_json::json!({
                    "source": "nexusmods",
                    "sourceId": "nested-fomod-test",
                    "sourceVersion": "1.0.0"
                })),
            )
            .await?;

        assert_eq!(
            result.get("success").and_then(|value| value.as_bool()),
            Some(true)
        );

        let installed_path = output_dir.join("Mods").join("Net35").join("Nested.dll");
        let installed_meta = fs::symlink_metadata(&installed_path).await?;
        assert!(
            installed_meta.file_type().is_symlink() || installed_meta.is_file(),
            "nested initial install should create a symlink or a regular fallback file"
        );
        assert_eq!(fs::read(&installed_path).await?, b"nested");

        Ok(())
    }

    #[tokio::test]
    #[serial]
    async fn store_mod_archive_installs_loose_thunderstore_payloads_without_package_metadata(
    ) -> Result<()> {
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

        let output_dir = temp
            .path()
            .join("envs")
            .join("env-thunderstore-extra-payload");
        let env = env_service
            .create_environment(
                schedule_i_config().app_id,
                "alternate".to_string(),
                output_dir.to_string_lossy().to_string(),
                None,
                None,
            )
            .await?;

        let zip_path = temp.path().join("DomsExpandedIngredientsAndEffects.zip");
        write_zip_fixture(
            &zip_path,
            &[
                (
                    "manifest.json",
                    br#"{"name":"DomsExpandedIngredientsAndEffects","version_number":"1.2.0","website_url":"","description":"fixture","dependencies":[]}"#,
                ),
                ("README.md", b"readme"),
                ("CHANGELOG.md", b"changes"),
                ("LICENSE.md", b"license"),
                ("icon.png", b"png"),
                ("DomsExpandedIngredientsAndEffects-Mono.dll", b"mono"),
                ("DomsCustomEffects/Icons/Airhorn.png", b"airhorn"),
                ("DomsCustomEffects/Sounds/Party.wav", b"party"),
            ],
        )?;

        let stored = service
            .store_mod_archive(
                zip_path.to_string_lossy().as_ref(),
                "DomsExpandedIngredientsAndEffects.zip",
                Some(Runtime::Mono),
                Some(serde_json::json!({
                    "source": "thunderstore",
                    "sourceId": "dom/example",
                    "sourceVersion": "1.2.0",
                    "modName": "Dom's Enhanced Effects"
                })),
                None,
            )
            .await?;

        let storage_id = stored
            .get("storageId")
            .and_then(|value| value.as_str())
            .expect("storage id");
        let storage_base = service.get_mods_storage_dir().await?.join(storage_id);
        let staged_dll = storage_base
            .join("Mods")
            .join("DomsExpandedIngredientsAndEffects-Mono.dll");
        let staged_asset = storage_base
            .join("Mods")
            .join("DomsCustomEffects")
            .join("Icons")
            .join("Airhorn.png");
        assert!(staged_dll.exists());
        assert!(staged_asset.exists());
        assert_eq!(fs::read(&staged_asset).await?, b"airhorn");
        assert!(!storage_base.join("Mods").join("manifest.json").exists());
        assert!(!storage_base.join("Mods").join("README.md").exists());
        assert!(!storage_base.join("Mods").join("CHANGELOG.md").exists());
        assert!(!storage_base.join("Mods").join("LICENSE.md").exists());
        assert!(!storage_base.join("Mods").join("icon.png").exists());

        service
            .install_storage_mod_to_envs(storage_id, vec![env.id.clone()])
            .await?;

        let installed_asset = output_dir
            .join("Mods")
            .join("DomsCustomEffects")
            .join("Icons")
            .join("Airhorn.png");
        assert!(service.path_exists_or_symlink(&installed_asset).await);
        assert_eq!(fs::read(&installed_asset).await?, b"airhorn");
        assert!(!output_dir.join("Mods").join("manifest.json").exists());
        assert!(!output_dir.join("Mods").join("README.md").exists());

        service
            .uninstall_storage_mod_from_envs(storage_id, vec![env.id.clone()])
            .await?;

        assert!(!service.path_exists_or_symlink(&installed_asset).await);
        assert!(
            !service
                .path_exists_or_symlink(
                    &output_dir
                        .join("Mods")
                        .join("DomsExpandedIngredientsAndEffects-Mono.dll"),
                )
                .await
        );

        Ok(())
    }

    #[tokio::test]
    #[serial]
    async fn store_mod_archive_extracts_zip_even_when_download_name_ends_with_dll() -> Result<()> {
        let temp = tempdir()?;
        let data_dir = temp.path().join("simmrust");
        let _data_guard =
            EnvVarGuard::set("SIMMRUST_DATA_DIR", data_dir.to_string_lossy().as_ref());
        let _home_guard =
            EnvVarGuard::set("SIMMRUST_HOME_DIR", temp.path().to_string_lossy().as_ref());
        let pool = initialize_pool().await?;
        let service = ModsService::new(pool.clone());

        let download_dir = temp.path().join("downloads");
        let mut settings_service = SettingsService::new(pool.clone())?;
        settings_service
            .save_settings(serde_json::json!({
                "defaultDownloadDir": download_dir.to_string_lossy().to_string()
            }))
            .await?;

        let misleading_zip_path = temp.path().join("Empire-S1API.dll");
        write_zip_fixture(
            &misleading_zip_path,
            &[("Empire-S1API.dll", b"managed dll")],
        )?;

        let stored = service
            .store_mod_archive(
                misleading_zip_path.to_string_lossy().as_ref(),
                "Empire-S1API.dll",
                Some(Runtime::Il2cpp),
                Some(serde_json::json!({
                    "source": "nexusmods",
                    "sourceId": "1437",
                    "sourceVersion": "2.3.0",
                    "modName": "Empire 2.0 - Resurrected"
                })),
                None,
            )
            .await?;

        let storage_id = stored
            .get("storageId")
            .and_then(|value| value.as_str())
            .expect("storage id");
        let storage_base = service.get_mods_storage_dir().await?.join(storage_id);
        let staged_dll = storage_base.join("Mods").join("Empire-S1API.dll");

        assert_eq!(fs::read(&staged_dll).await?, b"managed dll");

        Ok(())
    }

    #[tokio::test]
    #[serial]
    async fn install_zip_mod_installs_loose_reused_thunderstore_payloads_from_nexusmods(
    ) -> Result<()> {
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

        let output_dir = temp.path().join("envs").join("env-nexus-loose-payload");
        let _env = env_service
            .create_environment(
                schedule_i_config().app_id,
                "alternate".to_string(),
                output_dir.to_string_lossy().to_string(),
                None,
                None,
            )
            .await?;

        let zip_path = temp.path().join("NexusThunderstoreStyle.zip");
        write_zip_fixture(
            &zip_path,
            &[
                (
                    "manifest.json",
                    br#"{"name":"DomsExpandedIngredientsAndEffects","version_number":"1.2.0","website_url":"","description":"fixture","dependencies":[]}"#,
                ),
                ("README.md", b"readme"),
                ("CHANGELOG.md", b"changes"),
                ("LICENSE.md", b"license"),
                ("icon.png", b"png"),
                ("DomsExpandedIngredientsAndEffects-Mono.dll", b"mono"),
                ("DomsCustomEffects/Icons/Airhorn.png", b"airhorn"),
                ("DomsCustomEffects/Sounds/Party.wav", b"party"),
            ],
        )?;

        let result = service
            .install_zip_mod(
                output_dir.to_string_lossy().as_ref(),
                zip_path.to_string_lossy().as_ref(),
                "NexusThunderstoreStyle.zip",
                "Mono",
                "alternate",
                Some(serde_json::json!({
                    "source": "nexusmods",
                    "sourceId": "schedule1/1777",
                    "sourceVersion": "1.2.0",
                    "modName": "Dom's Enhanced Effects"
                })),
            )
            .await?;

        assert_eq!(
            result.get("success").and_then(|value| value.as_bool()),
            Some(true)
        );
        let installed_dll = output_dir
            .join("Mods")
            .join("DomsExpandedIngredientsAndEffects-Mono.dll");
        let installed_asset = output_dir
            .join("Mods")
            .join("DomsCustomEffects")
            .join("Icons")
            .join("Airhorn.png");
        assert!(service.path_exists_or_symlink(&installed_dll).await);
        assert!(service.path_exists_or_symlink(&installed_asset).await);
        assert_eq!(fs::read(&installed_asset).await?, b"airhorn");
        assert!(!output_dir.join("Mods").join("manifest.json").exists());
        assert!(!output_dir.join("Mods").join("README.md").exists());

        Ok(())
    }

    #[tokio::test]
    #[serial]
    async fn install_zip_mod_installs_loose_reused_thunderstore_payloads_for_manual_archives(
    ) -> Result<()> {
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

        let output_dir = temp.path().join("envs").join("env-manual-loose-payload");
        let _env = env_service
            .create_environment(
                schedule_i_config().app_id,
                "alternate".to_string(),
                output_dir.to_string_lossy().to_string(),
                None,
                None,
            )
            .await?;

        let zip_path = temp.path().join("ManualThunderstoreStyle.zip");
        write_zip_fixture(
            &zip_path,
            &[
                (
                    "manifest.json",
                    br#"{"name":"DomsExpandedIngredientsAndEffects","version_number":"1.2.0","website_url":"","description":"fixture","dependencies":[]}"#,
                ),
                ("README.md", b"readme"),
                ("DomsExpandedIngredientsAndEffects-Mono.dll", b"mono"),
                ("DomsCustomEffects/Sounds/Party.wav", b"party"),
            ],
        )?;

        let result = service
            .install_zip_mod(
                output_dir.to_string_lossy().as_ref(),
                zip_path.to_string_lossy().as_ref(),
                "ManualThunderstoreStyle.zip",
                "Mono",
                "alternate",
                None,
            )
            .await?;

        assert_eq!(
            result.get("success").and_then(|value| value.as_bool()),
            Some(true)
        );
        let installed_asset = output_dir
            .join("Mods")
            .join("DomsCustomEffects")
            .join("Sounds")
            .join("Party.wav");
        assert!(service.path_exists_or_symlink(&installed_asset).await);
        assert_eq!(fs::read(&installed_asset).await?, b"party");
        assert!(!output_dir.join("Mods").join("manifest.json").exists());
        assert!(!output_dir.join("Mods").join("README.md").exists());

        Ok(())
    }

    #[tokio::test]
    #[serial]
    async fn install_zip_mod_reports_runtime_mismatch_for_mono_only_manual_archive_on_il2cpp_env(
    ) -> Result<()> {
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

        let output_dir = temp.path().join("envs").join("env-il2cpp-manual-mismatch");
        let _env = env_service
            .create_environment(
                schedule_i_config().app_id,
                "main".to_string(),
                output_dir.to_string_lossy().to_string(),
                None,
                None,
            )
            .await?;

        let zip_path = temp
            .path()
            .join("DomsExpandedIngredientsAndEffects-1777-1-2-0-1775557696 (1).zip");
        write_zip_fixture(
            &zip_path,
            &[
                (
                    "manifest.json",
                    br#"{"name":"DomsExpandedIngredientsAndEffects","version_number":"1.2.0","website_url":"https://github.com/dommakarov1/DomsExpandedIngredientsAndEffects","description":"fixture","dependencies":["LavaGang-MelonLoader-0.7.2"]}"#,
                ),
                ("README.md", b"readme"),
                ("DomsExpandedIngredientsAndEffects-Mono.dll", b"mono"),
                ("DomsCustomEffects/Icons/Airhorn.png", b"airhorn"),
                ("DomsCustomEffects/Sounds/Party.wav", b"party"),
            ],
        )?;

        let result = service
            .install_zip_mod(
                output_dir.to_string_lossy().as_ref(),
                zip_path.to_string_lossy().as_ref(),
                "DomsExpandedIngredientsAndEffects-1777-1-2-0-1775557696 (1).zip",
                "IL2CPP",
                "main",
                None,
            )
            .await?;

        assert_eq!(
            result.get("success").and_then(|value| value.as_bool()),
            Some(false)
        );
        let error = result
            .get("error")
            .and_then(|value| value.as_str())
            .unwrap_or_default();
        assert!(error.contains("Mono"));
        assert!(error.contains("IL2CPP"));
        assert!(error.contains("DomsExpandedIngredientsAndEffects"));

        Ok(())
    }

    #[tokio::test]
    #[serial]
    async fn store_mod_archive_preserves_plugin_and_userlib_buckets_for_thunderstore_packages(
    ) -> Result<()> {
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

        let plugin_env_dir = temp.path().join("envs").join("env-meshvault-storage");
        let plugin_env = env_service
            .create_environment(
                schedule_i_config().app_id,
                "main".to_string(),
                plugin_env_dir.to_string_lossy().to_string(),
                None,
                None,
            )
            .await?;
        let userlib_env_dir = temp.path().join("envs").join("env-s1mapi-storage");
        let userlib_env = env_service
            .create_environment(
                schedule_i_config().app_id,
                "main".to_string(),
                userlib_env_dir.to_string_lossy().to_string(),
                None,
                None,
            )
            .await?;

        let meshvault_zip = temp.path().join("MeshVault.zip");
        write_zip_fixture(
            &meshvault_zip,
            &[
                (
                    "manifest.json",
                    br#"{"name":"MeshVault","version_number":"1.0.9","website_url":"","description":"fixture","dependencies":[]}"#,
                ),
                ("README.md", b"readme"),
                ("Plugins/MeshVault.Il2Cpp.dll", b"il2cpp"),
                ("Plugins/MeshVault.Mono.dll", b"mono"),
            ],
        )?;

        let meshvault_stored = service
            .store_mod_archive(
                meshvault_zip.to_string_lossy().as_ref(),
                "MeshVault.zip",
                Some(Runtime::Il2cpp),
                Some(serde_json::json!({
                    "source": "thunderstore",
                    "sourceId": "hdlmrell/MeshVault",
                    "sourceVersion": "1.0.9",
                    "modName": "MeshVault"
                })),
                None,
            )
            .await?;

        let meshvault_storage_id = meshvault_stored
            .get("storageId")
            .and_then(|value| value.as_str())
            .expect("meshvault storage id");
        let meshvault_storage_base = service
            .get_mods_storage_dir()
            .await?
            .join(meshvault_storage_id);
        assert!(meshvault_storage_base
            .join("Plugins")
            .join("MeshVault.Il2Cpp.dll")
            .exists());
        assert!(!meshvault_storage_base
            .join("Mods")
            .join("MeshVault.Il2Cpp.dll")
            .exists());

        service
            .install_storage_mod_to_envs(meshvault_storage_id, vec![plugin_env.id.clone()])
            .await?;

        assert!(
            service
                .path_exists_or_symlink(
                    &plugin_env_dir.join("Plugins").join("MeshVault.Il2Cpp.dll"),
                )
                .await
        );
        assert!(
            !service
                .path_exists_or_symlink(&plugin_env_dir.join("Mods").join("MeshVault.Il2Cpp.dll"),)
                .await
        );

        let s1mapi_zip = temp.path().join("S1MAPI.zip");
        write_zip_fixture(
            &s1mapi_zip,
            &[
                (
                    "manifest.json",
                    br#"{"name":"S1MAPI","version_number":"1.0.0","website_url":"","description":"fixture","dependencies":[]}"#,
                ),
                ("README.md", b"readme"),
                ("UserLibs/S1MAPI_Il2Cpp.dll", b"il2cpp"),
                ("UserLibs/S1MAPI_Mono.dll", b"mono"),
            ],
        )?;

        let s1mapi_stored = service
            .store_mod_archive(
                s1mapi_zip.to_string_lossy().as_ref(),
                "S1MAPI.zip",
                Some(Runtime::Il2cpp),
                Some(serde_json::json!({
                    "source": "thunderstore",
                    "sourceId": "ifBars/S1MAPI",
                    "sourceVersion": "1.0.0",
                    "modName": "S1MAPI"
                })),
                None,
            )
            .await?;

        let s1mapi_storage_id = s1mapi_stored
            .get("storageId")
            .and_then(|value| value.as_str())
            .expect("s1mapi storage id");
        let s1mapi_storage_base = service
            .get_mods_storage_dir()
            .await?
            .join(s1mapi_storage_id);
        assert!(s1mapi_storage_base
            .join("UserLibs")
            .join("S1MAPI_Il2Cpp.dll")
            .exists());
        assert!(!s1mapi_storage_base
            .join("Mods")
            .join("S1MAPI_Il2Cpp.dll")
            .exists());

        service
            .install_storage_mod_to_envs(s1mapi_storage_id, vec![userlib_env.id.clone()])
            .await?;

        assert!(
            service
                .path_exists_or_symlink(
                    &userlib_env_dir.join("UserLibs").join("S1MAPI_Il2Cpp.dll"),
                )
                .await
        );
        assert!(
            !service
                .path_exists_or_symlink(&userlib_env_dir.join("Mods").join("S1MAPI_Il2Cpp.dll"),)
                .await
        );

        Ok(())
    }

    #[tokio::test]
    #[serial]
    async fn install_zip_mod_places_meshvault_plugins_in_plugins_directory() -> Result<()> {
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

        let output_dir = temp.path().join("envs").join("env-meshvault-nexus");
        let _env = env_service
            .create_environment(
                schedule_i_config().app_id,
                "main".to_string(),
                output_dir.to_string_lossy().to_string(),
                None,
                None,
            )
            .await?;

        let zip_path = temp.path().join("MeshVault-Nexus.zip");
        write_zip_fixture(
            &zip_path,
            &[
                (
                    "manifest.json",
                    br#"{"name":"MeshVault","version_number":"1.0.9","website_url":"","description":"fixture","dependencies":[]}"#,
                ),
                ("README.md", b"readme"),
                ("Plugins/MeshVault.Il2Cpp.dll", b"il2cpp"),
                ("Plugins/MeshVault.Mono.dll", b"mono"),
            ],
        )?;

        let result = service
            .install_zip_mod(
                output_dir.to_string_lossy().as_ref(),
                zip_path.to_string_lossy().as_ref(),
                "MeshVault-Nexus.zip",
                "IL2CPP",
                "main",
                Some(serde_json::json!({
                    "source": "nexusmods",
                    "sourceId": "schedule1/meshvault",
                    "sourceVersion": "1.0.9",
                    "modName": "MeshVault"
                })),
            )
            .await?;

        assert_eq!(
            result.get("success").and_then(|value| value.as_bool()),
            Some(true)
        );
        assert!(
            service
                .path_exists_or_symlink(&output_dir.join("Plugins").join("MeshVault.Il2Cpp.dll"),)
                .await
        );
        assert!(
            !service
                .path_exists_or_symlink(&output_dir.join("Mods").join("MeshVault.Il2Cpp.dll"),)
                .await
        );

        Ok(())
    }

    #[tokio::test]
    #[serial]
    async fn install_zip_mod_places_s1mapi_libraries_in_userlibs_directory() -> Result<()> {
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

        let output_dir = temp.path().join("envs").join("env-s1mapi-manual");
        let _env = env_service
            .create_environment(
                schedule_i_config().app_id,
                "main".to_string(),
                output_dir.to_string_lossy().to_string(),
                None,
                None,
            )
            .await?;

        let zip_path = temp.path().join("S1MAPI-Manual.zip");
        write_zip_fixture(
            &zip_path,
            &[
                (
                    "manifest.json",
                    br#"{"name":"S1MAPI","version_number":"1.0.0","website_url":"","description":"fixture","dependencies":[]}"#,
                ),
                ("README.md", b"readme"),
                ("UserLibs/S1MAPI_Il2Cpp.dll", b"il2cpp"),
                ("UserLibs/S1MAPI_Mono.dll", b"mono"),
            ],
        )?;

        let result = service
            .install_zip_mod(
                output_dir.to_string_lossy().as_ref(),
                zip_path.to_string_lossy().as_ref(),
                "S1MAPI-Manual.zip",
                "IL2CPP",
                "main",
                None,
            )
            .await?;

        assert_eq!(
            result.get("success").and_then(|value| value.as_bool()),
            Some(true)
        );
        assert!(
            service
                .path_exists_or_symlink(&output_dir.join("UserLibs").join("S1MAPI_Il2Cpp.dll"),)
                .await
        );
        assert!(
            !service
                .path_exists_or_symlink(&output_dir.join("Mods").join("S1MAPI_Il2Cpp.dll"),)
                .await
        );

        Ok(())
    }

    #[tokio::test]
    #[serial]
    async fn install_dll_mod_infers_plugins_bucket_from_source_path() -> Result<()> {
        let temp = tempdir()?;
        let data_dir = temp.path().join("simmrust");
        let _data_guard =
            EnvVarGuard::set("SIMMRUST_DATA_DIR", data_dir.to_string_lossy().as_ref());
        let _home_guard =
            EnvVarGuard::set("SIMMRUST_HOME_DIR", temp.path().to_string_lossy().as_ref());
        let pool = initialize_pool().await?;
        let service = ModsService::new(pool);

        let game_dir = temp.path().join("env-dll-plugin");
        fs::create_dir_all(&game_dir).await?;
        let source_dir = temp.path().join("incoming").join("Plugins");
        fs::create_dir_all(&source_dir).await?;
        let source_dll = source_dir.join("MeshVault.Il2Cpp.dll");
        fs::write(&source_dll, b"plugin").await?;

        let result = service
            .install_dll_mod(
                game_dir.to_string_lossy().as_ref(),
                source_dll.to_string_lossy().as_ref(),
                "IL2CPP",
                None,
            )
            .await?;

        assert_eq!(
            result.get("success").and_then(|value| value.as_bool()),
            Some(true)
        );
        assert!(game_dir
            .join("Plugins")
            .join("MeshVault.Il2Cpp.dll")
            .exists());
        assert!(!game_dir.join("Mods").join("MeshVault.Il2Cpp.dll").exists());

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
