use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DepotDownloadOptions {
    pub app_id: String,
    pub branch: String,
    pub output_dir: String,
    pub username: Option<String>,
    pub password: Option<String>,
    /// Whether the caller explicitly permits DepotDownloader to retain its
    /// session. This must only be set for credentials already stored through
    /// SIMM's durable credential flow; a username alone is not consent.
    #[serde(default)]
    pub remember_credentials: bool,
    pub steam_guard: Option<String>,
    pub validate: Option<bool>,
    pub os: Option<Platform>,
    pub language: Option<String>,
    pub max_downloads: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
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
    /// Unique to one attempt, even when an environment reuses download_id.
    /// Frontends use this to distinguish an immediate retry from a duplicate
    /// event emitted by the preceding attempt.
    pub operation_id: String,
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
    pub icon_url: Option<String>,
    pub icon_cache_path: Option<String>,
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
    pub steamapps_dir: Option<String>,
    #[serde(default)]
    pub steam_manifest_path: Option<String>,
    #[serde(default)]
    pub environment_type: Option<EnvironmentType>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GameSaveSlot {
    pub slot_number: u8,
    pub organization_name: Option<String>,
    pub cash_balance: Option<f64>,
    pub online_balance: Option<f64>,
    pub net_worth: Option<f64>,
    pub rank: Option<u32>,
    pub tier: Option<u32>,
    pub total_xp: Option<u64>,
    pub created_at: Option<String>,
    pub last_played_at: Option<String>,
    pub last_save_version: Option<String>,
    pub path: String,
    pub exists: bool,
    pub size_bytes: u64,
    pub last_modified: Option<String>,
    pub backup: Option<GameSaveBackup>,
    pub backups: Vec<GameSaveBackup>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GameSaveBackup {
    pub path: String,
    pub size_bytes: u64,
    pub last_modified: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GameSaveAccount {
    pub steam_id: String,
    pub display_name: Option<String>,
    pub path: String,
    pub backup_path: String,
    pub slots: Vec<GameSaveSlot>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GameSaveBackupStatus {
    pub available: bool,
    pub source_path: String,
    pub accounts: Vec<GameSaveAccount>,
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GameSaveBackupResult {
    pub steam_id: String,
    pub slot_number: u8,
    pub backup: GameSaveBackup,
    pub pruned_backup_count: u16,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GameSaveBackupExportResult {
    pub steam_id: String,
    pub slot_number: u8,
    pub path: String,
    pub size_bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GameSaveRestoreResult {
    pub steam_id: String,
    pub slot_number: u8,
    pub path: String,
    pub size_bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GameSaveRestorePreview {
    pub steam_id: String,
    pub slot_number: u8,
    pub source_label: String,
    pub source_path: String,
    /// An opaque, backend-issued identity for the exact backup inspected by the
    /// preview. The restore command revalidates its account, slot, snapshot ID,
    /// and content fingerprint before it mutates a save slot.
    pub restore_token: Option<String>,
    pub current: GameSaveSlot,
    pub restored: GameSaveSlot,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub enum Runtime {
    #[serde(
        rename = "IL2CPP",
        alias = "il2cpp",
        alias = "Il2Cpp",
        alias = "Il2cpp"
    )]
    Il2cpp,
    #[serde(rename = "MONO", alias = "Mono", alias = "mono")]
    Mono,
}

impl Runtime {
    /// Canonical runtime spelling for persisted keys and IPC-adjacent comparisons.
    /// Keep all string-to-runtime handling here so callers cannot disagree about
    /// `Mono` versus the serialized `MONO` form.
    pub const fn canonical_label(&self) -> &'static str {
        match self {
            Self::Il2cpp => "IL2CPP",
            Self::Mono => "Mono",
        }
    }

    /// Parses runtime labels case-insensitively. Branch names deliberately do
    /// not participate: a custom branch must use the runtime already persisted
    /// on its environment rather than being guessed from its name.
    pub fn parse_label(value: &str) -> Option<Self> {
        match value.trim().to_ascii_lowercase().as_str() {
            "il2cpp" => Some(Self::Il2cpp),
            "mono" => Some(Self::Mono),
            _ => None,
        }
    }
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
pub struct AppUpdateSettings {
    pub last_checked_at: Option<String>,
    pub last_seen_version_raw: Option<String>,
    pub last_seen_version_normalized: Option<String>,
    pub last_resolved_url: Option<String>,
    pub snoozed_until: Option<String>,
    pub skipped_version_normalized: Option<String>,
    pub channel: Option<AppUpdateChannel>,
    /// Per-channel update state. The flat fields above remain for settings
    /// written by older releases and are used as a migration fallback.
    #[serde(default)]
    pub by_channel: Option<HashMap<AppUpdateChannel, AppUpdateChannelPreferences>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AppUpdateChannelPreferences {
    pub last_checked_at: Option<String>,
    pub last_seen_version_raw: Option<String>,
    pub last_seen_version_normalized: Option<String>,
    pub last_resolved_url: Option<String>,
    pub snoozed_until: Option<String>,
    pub skipped_version_normalized: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "lowercase")]
pub enum AppUpdateChannel {
    Stable,
    Beta,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ExperienceMode {
    Player,
    PowerUser,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppStartupState {
    pub simm_directory_created: bool,
    pub database_created: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum LinuxReadinessCheckStatus {
    Ready,
    Warning,
    Missing,
    Unknown,
    NotApplicable,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LinuxReadinessCheck {
    pub id: String,
    pub label: String,
    pub status: LinuxReadinessCheckStatus,
    pub detail: String,
    pub command: Option<String>,
    pub path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LinuxDesktopSchemeStatus {
    pub scheme: String,
    pub handler: Option<String>,
    pub ready: bool,
    pub detail: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LinuxReadinessStatus {
    pub platform: Platform,
    pub available: bool,
    pub summary: LinuxReadinessCheckStatus,
    pub checks: Vec<LinuxReadinessCheck>,
    pub scheme_handlers: Vec<LinuxDesktopSchemeStatus>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub default_download_dir: String,
    pub depot_downloader_path: Option<String>,
    pub steam_username: Option<String>,
    /// Whether DepotDownloader has a user-approved remembered login session.
    /// Kept separate from the public username because a username alone is not
    /// sufficient consent to reuse DepotDownloader's credential store.
    pub depot_downloader_remembered_session: Option<bool>,
    pub max_concurrent_downloads: u32,
    pub platform: Platform,
    pub language: String,
    pub theme: String,
    pub melon_loader_version: Option<String>,
    pub auto_install_melon_loader: Option<bool>,
    pub enable_security_scanner: Option<bool>,
    pub auto_install_security_scanner: Option<bool>,
    pub block_critical_scans: Option<bool>,
    pub prompt_on_high_scans: Option<bool>,
    pub show_security_scan_badges: Option<bool>,
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
    pub app_update: Option<AppUpdateSettings>,
    pub experience_mode: Option<ExperienceMode>,
    pub show_advanced_game_tools: Option<bool>,
    #[serde(default)]
    pub window_close_behavior: Option<WindowCloseBehavior>,
    pub setup_guide_completed: Option<bool>,
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
#[serde(rename_all = "camelCase")]
pub struct NexusDependencyCandidate {
    pub mod_id: String,
    pub mod_name: String,
    pub mod_file_id: String,
    pub mod_file_name: String,
    pub version_id: String,
    pub version_game_scoped_id: String,
    pub version: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NexusDependencyRequirement {
    pub id: String,
    pub candidates: Vec<NexusDependencyCandidate>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NexusModFileDependencies {
    pub source_version_id: String,
    pub requirements: Vec<NexusDependencyRequirement>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomThemeDefinition {
    pub id: String,
    pub name: String,
    pub base_theme: String,
    pub file_path: String,
    pub variables: HashMap<String, String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
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
    pub runtime: Runtime,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub runtime_switch: Option<RuntimeSwitchResult>,
    pub app_id: String,
    #[serde(with = "chrono::serde::ts_seconds")]
    pub checked_at: DateTime<Utc>,
    pub error: Option<String>,
    pub current_game_version: Option<String>,
    pub update_game_version: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeSwitchResult {
    pub environment_id: String,
    pub environment_name: String,
    pub previous_branch: String,
    pub branch: String,
    pub previous_runtime: Runtime,
    pub runtime: Runtime,
    pub disabled_items: usize,
    pub installed_items: usize,
    pub missing_items: Vec<String>,
    pub errors: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
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
pub struct TelemetryPreferences {
    #[serde(default)]
    pub collection_enabled: bool,
    #[serde(default)]
    pub upload_enabled: bool,
    #[serde(default)]
    pub error_excerpts_enabled: bool,
    #[serde(default = "default_telemetry_retention_days")]
    pub retention_days: u32,
    #[serde(default = "default_protect_local_mods")]
    pub protect_local_mods: bool,
    pub updated_at: Option<String>,
}

fn default_telemetry_retention_days() -> u32 {
    30
}

fn default_protect_local_mods() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub enum WindowCloseBehavior {
    Tray,
    #[default]
    Ask,
    Quit,
}

impl Default for TelemetryPreferences {
    fn default() -> Self {
        Self {
            collection_enabled: false,
            upload_enabled: false,
            error_excerpts_enabled: false,
            retention_days: default_telemetry_retention_days(),
            protect_local_mods: default_protect_local_mods(),
            updated_at: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TelemetryPreferencesUpdate {
    pub collection_enabled: Option<bool>,
    pub upload_enabled: Option<bool>,
    pub error_excerpts_enabled: Option<bool>,
    pub retention_days: Option<u32>,
    pub protect_local_mods: Option<bool>,
}

impl TelemetryPreferencesUpdate {
    pub fn field_count(&self) -> usize {
        [
            self.collection_enabled.is_some(),
            self.upload_enabled.is_some(),
            self.error_excerpts_enabled.is_some(),
            self.retention_days.is_some(),
            self.protect_local_mods.is_some(),
        ]
        .into_iter()
        .filter(|present| *present)
        .count()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TelemetryCapability {
    /// A package capability, reported by the backend which owns the command
    /// surface. Collection still requires the separate persisted opt-in.
    pub available: bool,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TelemetrySessionEndReason {
    GameExited,
    CollectionDisabled,
    EnvironmentRemoved,
    InterruptedProcessRunning,
    InterruptedProcessMissing,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum TelemetryModCaptureMode {
    #[default]
    Share,
    LocalOnly,
    Ignore,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TelemetryModPolicyItem {
    pub mod_entry: ModTelemetryModEntry,
    pub automatic_mode: TelemetryModCaptureMode,
    pub automatic_reason: Option<String>,
    pub effective_mode: TelemetryModCaptureMode,
    pub global_override: Option<TelemetryModCaptureMode>,
    pub environment_override: Option<TelemetryModCaptureMode>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TelemetryModRuleUpdate {
    pub mod_key: String,
    pub environment_id: Option<String>,
    /// None removes the override at the supplied scope and returns to automatic handling.
    pub mode: Option<TelemetryModCaptureMode>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveTelemetrySession {
    pub session_id: String,
    pub environment_id: String,
    pub started_at: String,
    pub ended_at: Option<String>,
    #[serde(default)]
    pub end_reason: Option<TelemetrySessionEndReason>,
    pub environment: ModTelemetryEnvironment,
    pub mods: Vec<ModTelemetryModEntry>,
    pub monitoring: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveTelemetryEvent {
    pub event_id: String,
    pub session_id: String,
    pub environment_id: String,
    pub occurred_at: String,
    pub severity: String,
    pub attribution: String,
    pub mod_key: Option<String>,
    pub mod_name: Option<String>,
    pub fingerprint: String,
    #[serde(default)]
    pub error_class: String,
    #[serde(default)]
    pub error_code: Option<String>,
    pub message: Option<String>,
    pub source: String,
    pub line_number: Option<u32>,
    pub origin: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveTelemetryStatus {
    pub environment_id: String,
    pub running: bool,
    pub monitoring: bool,
    pub active_session_id: Option<String>,
    pub event_count: u64,
    pub last_event_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveTelemetryExport {
    pub schema_version: u32,
    pub exported_at: String,
    pub sessions: Vec<LiveTelemetryExportSession>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveTelemetryExportSession {
    pub session_id: String,
    pub started_at: String,
    pub ended_at: Option<String>,
    pub environment: ModTelemetryEnvironment,
    pub mods: Vec<ModTelemetryModEntry>,
    pub events: Vec<LiveTelemetryExportEvent>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveTelemetryExportEvent {
    pub event_id: String,
    pub occurred_at: String,
    pub severity: String,
    pub attribution: String,
    pub mod_key: Option<String>,
    pub mod_name: Option<String>,
    pub fingerprint: String,
    #[serde(default)]
    pub error_class: String,
    #[serde(default)]
    pub error_code: Option<String>,
    pub message: Option<String>,
    pub source: String,
    pub line_number: Option<u32>,
    pub origin: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TelemetryUploadEnvelope {
    pub schema_version: u32,
    pub upload_id: String,
    pub exported_at: String,
    #[serde(default)]
    pub diagnostic_text_consent: bool,
    pub sessions: Vec<LiveTelemetryExportSession>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TelemetryUploadPreview {
    pub upload_id: String,
    pub payload: String,
    pub session_count: u64,
    pub event_count: u64,
    pub exclusions: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum TelemetryUploadState {
    Pending,
    Sending,
    Accepted,
    Failed,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TelemetryUploadReceipt {
    pub id: String,
    pub upload_id: String,
    pub state: TelemetryUploadState,
    pub attempts: u32,
    pub last_error_code: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModTelemetryCaptureRequest {
    pub environment_id: String,
    pub max_log_lines: Option<usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModTelemetryEnvironment {
    pub app_id: String,
    pub branch: String,
    pub runtime: Runtime,
    pub s1_version: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModTelemetryModEntry {
    pub mod_key: String,
    pub name: String,
    pub file_name: String,
    pub version: Option<String>,
    pub source: Option<ModSource>,
    pub author: Option<String>,
    pub managed: bool,
    pub disabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModTelemetrySourceError {
    pub mod_key: Option<String>,
    pub mod_name: String,
    pub level: String,
    pub error_class: String,
    pub error_code: Option<String>,
    pub message: Option<String>,
    pub timestamp: Option<String>,
    pub source: Option<String>,
    pub line_number: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModTelemetrySnapshot {
    pub schema_version: u32,
    pub snapshot_id: String,
    pub created_at: String,
    pub environment: ModTelemetryEnvironment,
    pub mods: Vec<ModTelemetryModEntry>,
    pub errors: Vec<ModTelemetrySourceError>,
    pub upload_ready: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModTelemetrySnapshotSummary {
    pub snapshot_id: String,
    pub environment_id: String,
    pub created_at: String,
    pub runtime: Runtime,
    pub s1_version: Option<String>,
    pub mod_count: usize,
    pub error_count: usize,
    pub upload_ready: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum SecurityScanState {
    Verified,
    Review,
    Unavailable,
    Disabled,
    Skipped,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub enum SecurityFindingSeverity {
    Low,
    Medium,
    High,
    Critical,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub enum SecurityScanDispositionClassification {
    #[serde(rename = "Clean")]
    Clean,
    #[serde(rename = "Suspicious")]
    Suspicious,
    #[serde(rename = "KnownThreat")]
    KnownThreat,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SecurityScanDisposition {
    pub classification: SecurityScanDispositionClassification,
    pub headline: String,
    pub summary: String,
    #[serde(default)]
    pub blocking_recommended: bool,
    pub primary_threat_family_id: Option<String>,
    #[serde(default)]
    pub related_finding_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SecurityScanSummary {
    pub state: SecurityScanState,
    pub verified: bool,
    #[serde(default)]
    pub disposition: Option<SecurityScanDisposition>,
    pub highest_severity: Option<SecurityFindingSeverity>,
    pub total_findings: usize,
    pub threat_family_count: usize,
    #[serde(with = "chrono::serde::ts_seconds_option")]
    pub scanned_at: Option<DateTime<Utc>>,
    pub scanner_version: Option<String>,
    pub schema_version: Option<String>,
    pub status_message: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SecurityScanPolicy {
    pub enabled: bool,
    pub requires_confirmation: bool,
    pub blocked: bool,
    pub prompt_on_high_findings: bool,
    pub block_critical_findings: bool,
    pub status_message: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SecurityScanFileReport {
    pub file_name: String,
    pub display_path: String,
    pub sha256_hash: Option<String>,
    pub highest_severity: Option<SecurityFindingSeverity>,
    pub total_findings: usize,
    pub threat_family_count: usize,
    pub result: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SecurityScanReport {
    pub summary: SecurityScanSummary,
    pub policy: SecurityScanPolicy,
    pub files: Vec<SecurityScanFileReport>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SecurityScannerStatus {
    pub enabled: bool,
    pub auto_install: bool,
    pub installed: bool,
    pub install_method: Option<String>,
    pub installed_version: Option<String>,
    pub latest_version: Option<String>,
    pub schema_version: Option<String>,
    pub executable_path: Option<String>,
    pub update_available: Option<bool>,
    pub last_error: Option<String>,
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
    #[serde(
        default,
        rename = "managedPaths",
        alias = "symlinkPaths",
        alias = "symlink_paths",
        alias = "managed_paths"
    )]
    pub managed_paths: Option<Vec<String>>,
    pub security_scan: Option<SecurityScanSummary>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModLibraryEntry {
    pub storage_id: String,
    pub display_name: String,
    pub files: Vec<String>,
    #[serde(default, rename = "attachedUserLibs")]
    pub attached_userlibs: Vec<String>,
    #[serde(default, rename = "attachedUserData")]
    pub attached_userdata: Vec<String>,
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
    pub security_scan: Option<SecurityScanSummary>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModLibraryResult {
    pub downloaded: Vec<ModLibraryEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModProfileManifest {
    pub schema_version: u32,
    pub kind: String,
    #[serde(default)]
    pub profile_id: Option<String>,
    #[serde(default)]
    pub is_default: Option<bool>,
    #[serde(default)]
    pub created_at: Option<String>,
    #[serde(default)]
    pub updated_at: Option<String>,
    pub profile: ModProfileInfo,
    #[serde(default)]
    pub items: Vec<ModProfileItem>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModProfileInfo {
    pub name: String,
    pub game: String,
    pub environment_id: Option<String>,
    pub runtime: Runtime,
    pub branch: String,
    pub game_version: Option<String>,
    pub exported_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ModProfileItemType {
    Mod,
    Plugin,
    Userlib,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModProfileItem {
    pub item_type: ModProfileItemType,
    pub name: String,
    pub file_name: Option<String>,
    pub required: bool,
    #[serde(default = "default_profile_item_enabled")]
    pub enabled: bool,
    pub source: Option<ModSource>,
    pub source_id: Option<String>,
    pub source_version: Option<String>,
    pub source_url: Option<String>,
    pub runtime: Option<Runtime>,
    pub storage_id: Option<String>,
    pub nexus_file_id: Option<String>,
    pub manual_reason: Option<String>,
}

fn default_profile_item_enabled() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredModProfile {
    pub id: String,
    pub name: String,
    pub runtime: Runtime,
    pub is_default: bool,
    #[serde(default)]
    pub active_environment_ids: Vec<String>,
    pub manifest: ModProfileManifest,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModProfileCaptureRequest {
    pub environment_id: String,
    pub name: Option<String>,
    #[serde(default)]
    pub profile_id: Option<String>,
    #[serde(default)]
    pub include_disabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModProfileSaveRequest {
    pub profile_id: Option<String>,
    pub name: String,
    pub runtime: Runtime,
    pub manifest: ModProfileManifest,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModProfileExportRequest {
    pub profile_id: String,
    pub include_disabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModProfileImportPlan {
    pub profile: ModProfileInfo,
    pub target_environment_id: Option<String>,
    pub items: Vec<ModProfileImportPlanItem>,
    pub summary: ModProfileImportSummary,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ModProfileImportStatus {
    AlreadyInstalled,
    ReadyToInstall,
    NeedsDownload,
    ManualRequired,
    RuntimeMismatch,
    Unsupported,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModProfileImportPlanItem {
    pub item: ModProfileItem,
    pub status: ModProfileImportStatus,
    pub resolved_storage_id: Option<String>,
    pub message: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModProfileImportSummary {
    pub total: usize,
    pub already_installed: usize,
    pub ready_to_install: usize,
    pub needs_download: usize,
    pub manual_required: usize,
    pub runtime_mismatches: usize,
    pub unsupported: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModProfileApplyRequest {
    pub manifest: ModProfileManifest,
    pub target_environment_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModProfileApplyResult {
    pub plan: ModProfileImportPlan,
    pub installed: usize,
    pub skipped: usize,
    pub unresolved: usize,
    pub messages: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalModSourceVersionOption {
    pub key: String,
    pub version: String,
    pub runtime: Option<String>,
    pub updated_at: Option<String>,
    pub is_latest: bool,
    pub label: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalModSourcePreview {
    pub source: ModSource,
    pub source_id: String,
    pub source_url: String,
    pub display_name: String,
    pub author: Option<String>,
    pub summary: Option<String>,
    pub icon_url: Option<String>,
    pub downloads: Option<u64>,
    pub likes_or_endorsements: Option<i64>,
    pub updated_at: Option<String>,
    pub versions: Vec<LocalModSourceVersionOption>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalModOwnershipCandidate {
    pub id: String,
    pub bucket: String,
    pub relative_path: String,
    pub file_name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DepotDownloaderInfo {
    pub installed: bool,
    pub path: Option<String>,
    pub version: Option<String>,
    pub method: Option<DetectionMethod>,
    pub can_auto_install: bool,
    pub install_help_url: String,
    pub install_hint: String,
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
    fn runtime_deserializes_legacy_mono_aliases() {
        assert_eq!(
            serde_json::from_str::<Runtime>("\"Mono\"").expect("deserialize Mono"),
            Runtime::Mono
        );
        assert_eq!(
            serde_json::from_str::<Runtime>("\"mono\"").expect("deserialize mono"),
            Runtime::Mono
        );
        assert_eq!(
            serde_json::from_str::<Runtime>("\"MONO\"").expect("deserialize MONO"),
            Runtime::Mono
        );
    }

    #[test]
    fn runtime_label_normalizer_is_case_insensitive_and_does_not_infer_branches() {
        assert_eq!(Runtime::parse_label("MONO"), Some(Runtime::Mono));
        assert_eq!(Runtime::parse_label("Mono"), Some(Runtime::Mono));
        assert_eq!(Runtime::parse_label("il2CPP"), Some(Runtime::Il2cpp));
        assert_eq!(Runtime::parse_label("feature-1"), None);
        assert_eq!(Runtime::Mono.canonical_label(), "Mono");
    }

    #[test]
    fn mod_library_entry_serializes_camel_case_fields() {
        let entry = ModLibraryEntry {
            storage_id: "s-1".to_string(),
            display_name: "Example".to_string(),
            files: vec!["Example.dll".to_string()],
            attached_userlibs: vec!["Config/Example.json".to_string()],
            attached_userdata: vec!["Profile/save.dat".to_string()],
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
            security_scan: None,
        };

        let json = serde_json::to_value(entry).expect("serialize");
        assert!(json.get("storageId").is_some());
        assert!(json.get("displayName").is_some());
        assert!(json.get("attachedUserLibs").is_some());
        assert!(json.get("attachedUserData").is_some());
        assert!(json.get("sourceId").is_some());
        assert!(json.get("availableRuntimes").is_some());
        assert!(json.get("attachedUserlibs").is_none());
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
            icon_url: Some("https://example.com/icon.png".to_string()),
            icon_cache_path: Some("C:/Users/test/SIMM/cache/mod-icons/icon.png".to_string()),
            message: Some("Downloading archive".to_string()),
            error: None,
            started_at,
            finished_at: None,
        };

        let json = serde_json::to_value(entry).expect("serialize");
        assert!(json.get("contextLabel").is_some());
        assert!(json.get("downloadedFiles").is_some());
        assert!(json.get("totalFiles").is_some());
        assert!(json.get("iconUrl").is_some());
        assert!(json.get("iconCachePath").is_some());
        assert!(json.get("startedAt").is_some());
        assert!(json.get("finishedAt").is_some());
        assert!(json.get("context_label").is_none());
    }

    #[test]
    fn app_update_settings_preserve_legacy_flat_fields_and_serialize_per_channel_state() {
        let legacy: AppUpdateSettings = serde_json::from_value(serde_json::json!({
            "channel": "beta",
            "lastSeenVersionNormalized": "0.8.6"
        }))
        .expect("legacy settings deserialize");
        assert_eq!(legacy.channel, Some(AppUpdateChannel::Beta));
        assert!(legacy.by_channel.is_none());

        let mut by_channel = HashMap::new();
        by_channel.insert(
            AppUpdateChannel::Stable,
            AppUpdateChannelPreferences {
                skipped_version_normalized: Some("0.8.6".to_string()),
                ..Default::default()
            },
        );
        let settings = AppUpdateSettings {
            last_checked_at: None,
            last_seen_version_raw: None,
            last_seen_version_normalized: None,
            last_resolved_url: None,
            snoozed_until: None,
            skipped_version_normalized: None,
            channel: Some(AppUpdateChannel::Stable),
            by_channel: Some(by_channel),
        };
        let json = serde_json::to_value(settings).expect("settings serialize");
        assert_eq!(
            json["byChannel"]["stable"]["skippedVersionNormalized"],
            "0.8.6"
        );
    }
}
