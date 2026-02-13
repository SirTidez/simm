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

#[derive(Debug, Clone, Serialize, Deserialize)]
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
    Error,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum EnvironmentType {
    Steam,
    DepotDownloader,
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
    pub nexus_mods_game_id: Option<String>,
    pub nexus_mods_app_slug: Option<String>,
    pub thunderstore_game_id: Option<String>,
    pub auto_update_mods: Option<bool>,
    pub mod_update_check_interval: Option<u32>, // minutes
    pub custom_theme: Option<CustomTheme>,
    pub log_retention_days: Option<u32>, // Number of days to keep log files (default: 7)
                                         // Note: github_token is NOT stored here - it's stored encrypted separately
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Theme {
    Light,
    Dark,
    #[serde(rename = "modern-blue")]
    ModernBlue,
    Custom,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomTheme {
    pub app_bg_color: String,
    pub app_text_color: String,
    pub header_bg_color: String,
    pub border_color: String,
    pub card_bg_color: String,
    pub card_border_color: String,
    pub text_secondary: String,
    pub input_bg_color: String,
    pub input_border_color: String,
    pub input_text_color: String,
    pub btn_secondary_bg: String,
    pub btn_secondary_hover: String,
    pub btn_secondary_text: String,
    pub btn_secondary_border: String,
    pub info_box_bg: String,
    pub info_box_border: String,
    pub warning_box_bg: String,
    pub warning_box_border: String,
    pub info_panel_bg: String,
    pub info_panel_border: String,
    pub modal_overlay: String,
    pub bg_gradient: String,
    pub bg_pattern: String,
    pub badge_gray: String,
    pub badge_blue: String,
    pub badge_orange_red: String,
    pub badge_yellow: String,
    pub badge_green: String,
    pub badge_red: String,
    pub badge_orange: String,
    pub badge_cyan: String,
    pub update_version_color: String,
    pub update_version_bg: String,
    pub primary_btn_color: String,
    pub primary_btn_hover: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LogLevel {
    Debug,
    Info,
    Warn,
    Error,
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
    pub installed_version: Option<String>,
    #[serde(with = "chrono::serde::ts_seconds_option")]
    pub installed_at: Option<DateTime<Utc>>,
    #[serde(with = "chrono::serde::ts_seconds_option")]
    pub last_update_check: Option<DateTime<Utc>>,
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
    pub installed_version: Option<String>,
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
            installed_version: Some("v1.0.0".to_string()),
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
}
