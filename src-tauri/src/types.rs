use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DepotDownloadOptions {
    pub app_id: String,
    pub branch: String,
    pub output_dir: String,
    pub username: Option<String>,
    pub password: Option<String>,
    pub steam_guard: Option<String>,
    pub validate: Option<bool>,
    pub os: Option<Platform>,
    pub language: Option<String>,
    pub max_downloads: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Platform {
    Windows,
    Macos,
    Linux,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadProgress {
    pub download_id: String,
    pub status: DownloadStatus,
    pub progress: f64, // 0-100
    pub downloaded_files: Option<u64>,
    pub total_files: Option<u64>,
    pub speed: Option<String>,
    pub eta: Option<String>,
    pub message: Option<String>,
    pub error: Option<String>,
    pub manifest_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DownloadStatus {
    Queued,
    Downloading,
    Validating,
    Completed,
    Error,
    Cancelled,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TrackedDownloadKind {
    Game,
    Mod,
    Plugin,
    Framework,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrackedDownload {
    pub id: String,
    pub kind: TrackedDownloadKind,
    pub label: String,
    pub context_label: String,
    pub status: DownloadStatus,
    pub progress: f64,
    pub downloaded_files: Option<u64>,
    pub total_files: Option<u64>,
    pub message: Option<String>,
    pub error: Option<String>,
    #[serde(with = "chrono::serde::ts_milliseconds")]
    pub started_at: DateTime<Utc>,
    #[serde(with = "chrono::serde::ts_milliseconds_option")]
    pub finished_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Environment {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    pub app_id: String,
    pub branch: String,
    pub output_dir: String,
    pub runtime: Runtime,
    pub status: EnvironmentStatus,
    #[serde(with = "chrono::serde::ts_seconds_option")]
    pub last_updated: Option<DateTime<Utc>>,
    pub size: Option<u64>,
    pub last_manifest_id: Option<String>,
    #[serde(with = "chrono::serde::ts_seconds_option")]
    pub last_update_check: Option<DateTime<Utc>>,
    pub update_available: Option<bool>,
    pub remote_manifest_id: Option<String>,
    pub remote_build_id: Option<String>,
    pub current_game_version: Option<String>,
    pub update_game_version: Option<String>,
    pub melon_loader_version: Option<String>,
    #[serde(default)]
    pub environment_type: Option<EnvironmentType>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "UPPERCASE")]
pub enum Runtime {
    Il2cpp,
    Mono,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EnvironmentStatus {
    NotDownloaded,
    Downloading,
    Completed,
    Unavailable,
    Error,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum EnvironmentType {
    Steam,
    DepotDownloader,
    Local,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppConfig {
    pub app_id: String,
    pub name: String,
    pub branches: Vec<BranchConfig>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchConfig {
    pub name: String,
    pub display_name: String,
    pub runtime: Runtime,
    pub requires_auth: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub default_download_dir: String,
    pub depot_downloader_path: Option<String>,
    pub steam_username: Option<String>,
    pub max_concurrent_downloads: u32,
    pub platform: Platform,
    pub language: String,
    pub theme: Theme,
    pub melon_loader_version: Option<String>,
    pub auto_install_melon_loader: Option<bool>,
    pub update_check_interval: Option<u32>, // minutes
    pub auto_check_updates: Option<bool>,
    pub log_level: Option<LogLevel>,
    pub nexus_mods_api_key: Option<String>,
    pub nexus_mods_rate_limits: Option<NexusRateLimits>,
    pub nexus_mods_game_id: Option<String>,
    pub nexus_mods_app_slug: Option<String>,
    pub thunderstore_game_id: Option<String>,
    pub auto_update_mods: Option<bool>,
    pub mod_update_check_interval: Option<u32>, // minutes
    pub mod_icon_cache_limit_mb: Option<u32>,
    pub database_backup_count: Option<u32>,
    pub log_retention_days: Option<u32>, // Number of days to keep log files (default: 7)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NexusRateLimits {
    pub daily: u32,
    pub hourly: u32,
    pub daily_remaining: Option<u32>,
    pub hourly_remaining: Option<u32>,
    pub daily_used: Option<u32>,
    pub hourly_used: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Theme {
    Light,
    Dark,
    #[serde(rename = "modern-blue")]
    ModernBlue,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LogLevel {
    Debug,
    Info,
    Warn,
    Error,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub enum ConfigFileType {
    #[serde(rename = "MelonPreferences", alias = "melonPreferences")]
    MelonPreferences,
    #[serde(rename = "LoaderConfig", alias = "loaderConfig")]
    LoaderConfig,
    #[serde(rename = "Json", alias = "json")]
    Json,
    #[serde(rename = "Other", alias = "other")]
    Other,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigEntry {
    pub key: String,
    pub value: String,
    pub comment: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigSection {
    pub name: String,
    pub entries: Vec<ConfigEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigGroup {
    pub id: String,
    pub label: String,
    pub section_names: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigFileSummary {
    pub name: String,
    pub path: String,
    pub file_type: ConfigFileType,
    pub format: String,
    pub relative_path: String,
    pub group_name: String,
    pub last_modified: Option<i64>,
    pub section_count: usize,
    pub entry_count: usize,
    pub supports_structured_edit: bool,
    pub supports_raw_edit: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigDocument {
    pub summary: ConfigFileSummary,
    pub raw_content: String,
    pub sections: Vec<ConfigSection>,
    pub parse_warnings: Vec<String>,
    #[serde(default)]
    pub groups: Vec<ConfigGroup>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum ConfigEditOperation {
    SetValue {
        section: String,
        key: String,
        value: String,
    },
    SetComment {
        section: String,
        key: String,
        comment: Option<String>,
    },
    AddSection {
        section: String,
    },
    DeleteSection {
        section: String,
    },
    AddEntry {
        section: String,
        key: String,
        value: String,
        comment: Option<String>,
    },
    DeleteEntry {
        section: String,
        key: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateCheckResult {
    pub update_available: bool,
    pub current_manifest_id: Option<String>,
    pub remote_manifest_id: Option<String>,
    pub remote_build_id: Option<String>,
    pub branch: String,
    pub app_id: String,
    #[serde(with = "chrono::serde::ts_seconds")]
    pub checked_at: DateTime<Utc>,
    pub error: Option<String>,
    pub current_game_version: Option<String>,
    pub update_game_version: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ModSource {
    Local,
    Thunderstore,
    Nexusmods,
    Github,
    Unknown,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModMetadata {
    pub source: Option<ModSource>,
    pub source_id: Option<String>,
    pub source_version: Option<String>,
    pub author: Option<String>,
    pub mod_name: Option<String>,
    pub source_url: Option<String>,
    pub summary: Option<String>,
    pub icon_url: Option<String>,
    pub icon_cache_path: Option<String>,
    pub downloads: Option<u64>,
    pub likes_or_endorsements: Option<i64>,
    pub updated_at: Option<String>,
    pub tags: Option<Vec<String>>,
    pub installed_version: Option<String>,
    #[serde(with = "chrono::serde::ts_seconds_option")]
    pub library_added_at: Option<DateTime<Utc>>,
    #[serde(with = "chrono::serde::ts_seconds_option")]
    pub installed_at: Option<DateTime<Utc>>,
    #[serde(with = "chrono::serde::ts_seconds_option")]
    pub last_update_check: Option<DateTime<Utc>>,
    #[serde(with = "chrono::serde::ts_seconds_option")]
    pub metadata_last_refreshed: Option<DateTime<Utc>>,
    pub update_available: Option<bool>,
    pub remote_version: Option<String>,
    pub detected_runtime: Option<Runtime>,
    pub runtime_match: Option<bool>,
    pub mod_storage_id: Option<String>,
    pub symlink_paths: Option<Vec<String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModLibraryEntry {
    pub storage_id: String,
    pub display_name: String,
    pub files: Vec<String>,
    pub source: Option<ModSource>,
    pub source_id: Option<String>,
    pub source_version: Option<String>,
    pub source_url: Option<String>,
    pub summary: Option<String>,
    pub icon_url: Option<String>,
    pub icon_cache_path: Option<String>,
    pub downloads: Option<u64>,
    pub likes_or_endorsements: Option<i64>,
    pub updated_at: Option<String>,
    pub tags: Option<Vec<String>>,
    pub installed_version: Option<String>,
    #[serde(with = "chrono::serde::ts_seconds_option")]
    pub library_added_at: Option<DateTime<Utc>>,
    #[serde(with = "chrono::serde::ts_seconds_option")]
    pub installed_at: Option<DateTime<Utc>>,
    pub author: Option<String>,
    pub update_available: Option<bool>,
    pub remote_version: Option<String>,
    pub managed: bool,
    pub installed_in: Vec<String>,
    pub available_runtimes: Vec<String>,
    pub storage_ids_by_runtime: std::collections::HashMap<String, String>,
    pub installed_in_by_runtime: std::collections::HashMap<String, Vec<String>>,
    pub files_by_runtime: std::collections::HashMap<String, Vec<String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModLibraryResult {
    pub downloaded: Vec<ModLibraryEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DepotDownloaderInfo {
    pub installed: bool,
    pub path: Option<String>,
    pub version: Option<String>,
    pub method: Option<DetectionMethod>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DetectionMethod {
    Path,
    Winget,
    Homebrew,
    Manual,
}

// Schedule I configuration function
pub fn schedule_i_config() -> AppConfig {
    AppConfig {
        app_id: "3164500".to_string(),
        name: "Schedule I".to_string(),
        branches: vec![
            BranchConfig {
                name: "main".to_string(),
                display_name: "Main (IL2CPP)".to_string(),
                runtime: Runtime::Il2cpp,
                requires_auth: true,
            },
            BranchConfig {
                name: "beta".to_string(),
                display_name: "Beta (IL2CPP)".to_string(),
                runtime: Runtime::Il2cpp,
                requires_auth: true,
            },
            BranchConfig {
                name: "alternate".to_string(),
                display_name: "Alternate (Mono)".to_string(),
                runtime: Runtime::Mono,
                requires_auth: true,
            },
            BranchConfig {
                name: "alternate-beta".to_string(),
                display_name: "Alternate Beta (Mono)".to_string(),
                runtime: Runtime::Mono,
                requires_auth: true,
            },
        ],
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mod_source_serializes_as_lowercase() {
        assert_eq!(
            serde_json::to_string(&ModSource::Thunderstore).expect("serialize"),
            "\"thunderstore\""
        );
        assert_eq!(
            serde_json::to_string(&ModSource::Nexusmods).expect("serialize"),
            "\"nexusmods\""
        );
        assert_eq!(
            serde_json::to_string(&ModSource::Github).expect("serialize"),
            "\"github\""
        );
    }

    #[test]
    fn runtime_serializes_as_uppercase() {
        assert_eq!(
            serde_json::to_string(&Runtime::Il2cpp).expect("serialize"),
            "\"IL2CPP\""
        );
        assert_eq!(
            serde_json::to_string(&Runtime::Mono).expect("serialize"),
            "\"MONO\""
        );
    }

    #[test]
    fn mod_library_entry_serializes_camel_case_fields() {
        let entry = ModLibraryEntry {
            storage_id: "s-1".to_string(),
            display_name: "Example".to_string(),
            files: vec!["Example.dll".to_string()],
            source: Some(ModSource::Github),
            source_id: Some("owner/repo".to_string()),
            source_version: Some("v1.0.0".to_string()),
            source_url: Some("https://example.com".to_string()),
            summary: Some("Example summary".to_string()),
            icon_url: Some("https://example.com/icon.png".to_string()),
            icon_cache_path: Some("C:/Users/test/SIMM/cache/mod-icons/icon.png".to_string()),
            downloads: Some(42),
            likes_or_endorsements: Some(10),
            updated_at: Some("2026-03-05T00:00:00Z".to_string()),
            tags: Some(vec!["utility".to_string()]),
            installed_version: Some("v1.0.0".to_string()),
            library_added_at: None,
            installed_at: None,
            author: Some("Author".to_string()),
            update_available: Some(true),
            remote_version: Some("v1.1.0".to_string()),
            managed: true,
            installed_in: vec!["env-1".to_string()],
            available_runtimes: vec!["Mono".to_string()],
            storage_ids_by_runtime: std::collections::HashMap::new(),
            installed_in_by_runtime: std::collections::HashMap::new(),
            files_by_runtime: std::collections::HashMap::new(),
        };

        let json = serde_json::to_value(entry).expect("serialize");
        assert!(json.get("storageId").is_some());
        assert!(json.get("displayName").is_some());
        assert!(json.get("sourceId").is_some());
        assert!(json.get("availableRuntimes").is_some());
        assert!(json.get("storage_ids_by_runtime").is_none());
    }

    #[test]
    fn tracked_download_serializes_camel_case_fields() {
        let started_at = Utc::now();
        let entry = TrackedDownload {
            id: "download-1".to_string(),
            kind: TrackedDownloadKind::Mod,
            label: "ExampleMod.zip".to_string(),
            context_label: "Thunderstore".to_string(),
            status: DownloadStatus::Downloading,
            progress: 0.0,
            downloaded_files: Some(0),
            total_files: Some(1),
            message: Some("Downloading archive".to_string()),
            error: None,
            started_at,
            finished_at: None,
        };

        let json = serde_json::to_value(entry).expect("serialize");
        assert!(json.get("contextLabel").is_some());
        assert!(json.get("downloadedFiles").is_some());
        assert!(json.get("totalFiles").is_some());
        assert!(json.get("startedAt").is_some());
        assert!(json.get("finishedAt").is_some());
        assert!(json.get("context_label").is_none());
    }
}
