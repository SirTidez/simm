use crate::types::LogLevel;
use anyhow::{Context, Result};
use chrono::{DateTime, Local, Utc};
use log::LevelFilter;
use once_cell::sync::Lazy;
use regex::{Captures, Regex};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::RwLock;
use tokio::fs::{self, OpenOptions};
use tokio::io::AsyncWriteExt;
use tokio::sync::Mutex;

static SESSION_LOG_FILENAME: Lazy<String> = Lazy::new(|| {
    let now = Local::now();
    format!("SIMM-log-{}.log", now.format("%Y-%m-%d-%H-%M-%S"))
});
static SHARED_LOG_LEVEL: Lazy<RwLock<LogLevel>> = Lazy::new(|| RwLock::new(LogLevel::Warn));
static SHARED_RETENTION_DAYS: Lazy<RwLock<u32>> = Lazy::new(|| RwLock::new(7));
static SHARED_LOG_FILE: Lazy<Mutex<Option<tokio::fs::File>>> = Lazy::new(|| Mutex::new(None));
static PENDING_LOG_WRITES: AtomicUsize = AtomicUsize::new(0);
static LAST_LOG_CLEANUP_UNIX_SECS: AtomicU64 = AtomicU64::new(0);
const LOG_FLUSH_INTERVAL: usize = 64;
const LOG_CLEANUP_INTERVAL_SECS: u64 = 6 * 60 * 60;
static WINDOWS_PATH_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r#"(?i)\b[a-z]:[\\/](?:[^\\/:*?"<>|\s]+[\\/])*[^\\/:*?"<>|\s]*"#)
        .expect("windows path regex")
});
static FILE_URI_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r#"(?i)\bfile://[^\s"'<>|\r\n]+"#).expect("file URI regex"));
static UNIX_PATH_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r#"(?m)(^|[^A-Za-z0-9_.-])(/(?:[^\s"'<>|,;:!?()\[\]{}\r\n]+/?)+)"#)
        .expect("unix path regex")
});
static USERNAME_KEY_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r#"(?i)\b(username|user|login)\s*[:=]\s*(?:"[^"]*"|[^\s,|]+)"#)
        .expect("username key regex")
});
static USERNAME_ARG_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r#"(?i)(-username\s+)(\S+)"#).expect("username arg regex"));
static SECRET_KEY_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r#"(?i)\b(password|pass|steamguard|token|access[-_ ]?token|refresh[-_ ]?token|id[-_ ]?token|api[-_ ]?key|nexus[-_ ]?api[-_ ]?key|authorization|secret|credentials?|cookie|set[-_ ]?cookie)\s*[:=]\s*(?:"[^"]*"|[^\s,|]+)"#)
        .expect("secret key regex")
});
static JSON_SECRET_KEY_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(
        r#"(?i)(["'](?:username|user|login|password|pass|steamguard|token|access[-_ ]?token|refresh[-_ ]?token|id[-_ ]?token|api[-_ ]?key|nexus[-_ ]?api[-_ ]?key|authorization|secret|credentials?|cookie|set[-_ ]?cookie)["']\s*:\s*)(?:"[^"]*"|[^\s,|}\]]+)"#,
    )
    .expect("JSON secret key regex")
});
static SECRET_ARG_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r#"(?i)(-(?:password|pass|steamguard|token|access-token|refresh-token|id-token|api-key|nexus-api-key|authorization|secret|credential|cookie)\s+)(\S+)"#)
        .expect("secret arg regex")
});
static EMAIL_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r#"(?i)\b[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}\b"#).expect("email regex")
});

pub struct LoggerService {
    logs_dir: PathBuf,
    session_log_file: PathBuf, // Unified app log file for this session
}

impl LoggerService {
    fn runtime_log_level(configured_level: LogLevel) -> LogLevel {
        configured_level
    }

    fn read_log_level() -> LogLevel {
        *SHARED_LOG_LEVEL
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn read_retention_days() -> u32 {
        *SHARED_RETENTION_DAYS
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn write_log_level(level: LogLevel) {
        let mut current = SHARED_LOG_LEVEL
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        *current = level;
    }

    fn write_retention_days(days: u32) {
        let mut current = SHARED_RETENTION_DAYS
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        *current = days;
    }

    pub fn level_filter(level: LogLevel) -> LevelFilter {
        match level {
            // Debug is intentionally not Trace: dependency trace streams (for
            // example Hyper's idle-pool maintenance) are extremely noisy and
            // can dominate long-running sessions without helping app-level
            // diagnosis.
            LogLevel::Debug => LevelFilter::Debug,
            LogLevel::Info => LevelFilter::Info,
            LogLevel::Warn => LevelFilter::Warn,
            LogLevel::Error => LevelFilter::Error,
        }
    }

    pub fn current_log_level() -> LogLevel {
        Self::read_log_level()
    }

    pub fn apply_settings(settings: &crate::types::Settings) {
        let level = Self::runtime_log_level(settings.log_level.unwrap_or(LogLevel::Warn));
        let retention_days = settings.log_retention_days.unwrap_or(7);
        Self::write_log_level(level);
        Self::write_retention_days(retention_days);
        log::set_max_level(Self::level_filter(level));
    }

    fn summarize_path(path: &str) -> String {
        let trimmed = path.trim_matches('"');
        let tail = trimmed
            .rsplit(['\\', '/'])
            .find(|segment| !segment.is_empty())
            .unwrap_or("");

        if tail.is_empty() {
            "<path>".to_string()
        } else {
            format!("<path:{}>", tail)
        }
    }

    pub fn sanitize_log_text(input: &str) -> String {
        let mut sanitized = input.replace("\r\n", "\n");

        sanitized = FILE_URI_RE
            .replace_all(&sanitized, |caps: &Captures| {
                Self::summarize_path(caps.get(0).map(|m| m.as_str()).unwrap_or_default())
            })
            .to_string();
        sanitized = WINDOWS_PATH_RE
            .replace_all(&sanitized, |caps: &Captures| {
                Self::summarize_path(caps.get(0).map(|m| m.as_str()).unwrap_or_default())
            })
            .to_string();
        sanitized = UNIX_PATH_RE
            .replace_all(&sanitized, |caps: &Captures| {
                format!(
                    "{}{}",
                    caps.get(1).map(|m| m.as_str()).unwrap_or_default(),
                    Self::summarize_path(caps.get(2).map(|m| m.as_str()).unwrap_or_default())
                )
            })
            .to_string();
        sanitized = EMAIL_RE
            .replace_all(&sanitized, "<redacted-email>")
            .to_string();
        sanitized = USERNAME_ARG_RE
            .replace_all(&sanitized, "${1}<redacted>")
            .to_string();
        sanitized = SECRET_ARG_RE
            .replace_all(&sanitized, "${1}<redacted>")
            .to_string();
        sanitized = USERNAME_KEY_RE
            .replace_all(&sanitized, |caps: &Captures| {
                format!(
                    "{}=<redacted>",
                    caps.get(1).map(|m| m.as_str()).unwrap_or("username")
                )
            })
            .to_string();
        sanitized = SECRET_KEY_RE
            .replace_all(&sanitized, |caps: &Captures| {
                format!(
                    "{}=<redacted>",
                    caps.get(1).map(|m| m.as_str()).unwrap_or("secret")
                )
            })
            .to_string();
        sanitized = JSON_SECRET_KEY_RE
            .replace_all(&sanitized, "${1}\"<redacted>\"")
            .to_string();

        sanitized
    }

    fn is_sensitive_data_key(key: &str) -> bool {
        let normalized = key
            .chars()
            .filter(|character| character.is_ascii_alphanumeric())
            .flat_map(char::to_lowercase)
            .collect::<String>();

        matches!(
            normalized.as_str(),
            "username"
                | "user"
                | "login"
                | "password"
                | "pass"
                | "steamguard"
                | "token"
                | "accesstoken"
                | "refreshtoken"
                | "idtoken"
                | "apikey"
                | "authorization"
                | "secret"
                | "credentials"
                | "credential"
                | "cookie"
                | "setcookie"
        ) || normalized.ends_with("password")
            || normalized.ends_with("token")
            || normalized.ends_with("apikey")
            || normalized.ends_with("secret")
            || normalized.ends_with("credential")
    }

    fn sanitize_log_data(data: serde_json::Value) -> serde_json::Value {
        match data {
            serde_json::Value::String(value) => {
                serde_json::Value::String(Self::sanitize_log_text(&value))
            }
            serde_json::Value::Array(values) => serde_json::Value::Array(
                values
                    .into_iter()
                    .map(Self::sanitize_log_data)
                    .collect::<Vec<_>>(),
            ),
            serde_json::Value::Object(map) => serde_json::Value::Object(
                map.into_iter()
                    .map(|(key, value)| {
                        let sanitized_value = if Self::is_sensitive_data_key(&key) {
                            serde_json::Value::String("<redacted>".to_string())
                        } else {
                            Self::sanitize_log_data(value)
                        };
                        (key, sanitized_value)
                    })
                    .collect(),
            ),
            other => other,
        }
    }

    pub fn new() -> Result<Self> {
        // Use SIMM/logs directory
        let logs_dir = crate::utils::directory_init::initialize_simm_directory()?
            .0
            .join("logs");

        std::fs::create_dir_all(&logs_dir)?;

        // Use one process-global session filename per app launch
        let session_log_file = logs_dir.join(SESSION_LOG_FILENAME.as_str());
        log::set_max_level(Self::level_filter(Self::read_log_level()));

        Ok(Self {
            logs_dir,
            session_log_file,
        })
    }

    pub async fn set_log_level(&self, level: LogLevel) {
        let level = Self::runtime_log_level(level);
        Self::write_log_level(level);
        log::set_max_level(Self::level_filter(level));
    }

    pub async fn set_retention_days(&self, days: u32) {
        Self::write_retention_days(days);
    }

    pub async fn get_retention_days(&self) -> u32 {
        Self::read_retention_days()
    }

    pub async fn log(&self, level: LogLevel, message: &str, data: Option<serde_json::Value>) {
        let current_level = Self::read_log_level();
        if !Self::should_log(level, current_level) {
            return;
        }

        let sanitized_message = Self::sanitize_log_text(message);
        let sanitized_data = data.map(Self::sanitize_log_data);

        let level_str = format!("{:?}", level);
        let timestamp = Utc::now();
        let local_time = timestamp.with_timezone(&Local);

        let _log_entry = serde_json::json!({
            "timestamp": timestamp.to_rfc3339(),
            "level": level_str.clone(),
            "message": sanitized_message,
            "data": sanitized_data.clone()
        });

        // Write to file
        let log_line = if let Some(d) = sanitized_data {
            format!(
                "[{}] [{}] {} | Data: {}\n",
                local_time.format("%Y-%m-%d %H:%M:%S"),
                level_str,
                sanitized_message,
                serde_json::to_string(&d).unwrap_or_default()
            )
        } else {
            format!(
                "[{}] [{}] {}\n",
                local_time.format("%Y-%m-%d %H:%M:%S"),
                level_str,
                sanitized_message
            )
        };

        // Use the session log file path stored at initialization
        if let Err(e) = self
            .write_to_file(
                &self.session_log_file,
                &log_line,
                matches!(level, LogLevel::Warn | LogLevel::Error),
            )
            .await
        {
            eprintln!("Failed to write to app log file: {}", e);
        }

        self.maybe_schedule_log_cleanup();
    }

    async fn write_to_file(&self, file_path: &PathBuf, content: &str, flush: bool) -> Result<()> {
        let mut shared_file = SHARED_LOG_FILE.lock().await;
        if shared_file.is_none() {
            *shared_file = Some(
                OpenOptions::new()
                    .create(true)
                    .append(true)
                    .open(file_path)
                    .await
                    .context("Failed to open log file")?,
            );
        }
        let file = shared_file.as_mut().expect("shared log file initialized");

        file.write_all(content.as_bytes())
            .await
            .context("Failed to write to log file")?;

        let pending = PENDING_LOG_WRITES.fetch_add(1, Ordering::Relaxed) + 1;
        if flush || pending >= LOG_FLUSH_INTERVAL {
            file.flush().await.context("Failed to flush log file")?;
            PENDING_LOG_WRITES.store(0, Ordering::Relaxed);
        }

        Ok(())
    }

    fn maybe_schedule_log_cleanup(&self) {
        let now = Utc::now().timestamp().max(0) as u64;
        let last = LAST_LOG_CLEANUP_UNIX_SECS.load(Ordering::Relaxed);
        if now.saturating_sub(last) < LOG_CLEANUP_INTERVAL_SECS
            || LAST_LOG_CLEANUP_UNIX_SECS
                .compare_exchange(last, now, Ordering::Relaxed, Ordering::Relaxed)
                .is_err()
        {
            return;
        }

        let logs_dir = self.logs_dir.clone();
        let retention = Self::read_retention_days();
        tokio::spawn(async move {
            if let Err(error) = Self::cleanup_old_logs(&logs_dir, retention).await {
                eprintln!("[Logger] Failed to clean up old logs: {}", error);
            }
        });
    }

    async fn cleanup_old_logs(logs_dir: &PathBuf, retention_days: u32) -> Result<()> {
        let cutoff_time = Utc::now() - chrono::Duration::days(retention_days as i64);

        let mut entries = fs::read_dir(logs_dir).await?;
        while let Some(entry) = entries.next_entry().await? {
            let path = entry.path();

            if path.is_file() {
                let file_name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");

                // Only process current app logs and legacy app log files
                let is_log_file = (file_name.starts_with("SIMM-log-")
                    || file_name.starts_with("server-")
                    || file_name.starts_with("app-")
                    || file_name.starts_with("log-"))
                    && file_name.ends_with(".log");

                if is_log_file {
                    let metadata = fs::metadata(&path).await?;
                    if let Ok(modified) = metadata.modified() {
                        let modified_time: DateTime<Utc> = modified.into();
                        if modified_time < cutoff_time {
                            let _ = fs::remove_file(&path).await;
                            eprintln!(
                                "[Logger] Deleted old log file: {}",
                                Self::sanitize_log_text(&path.to_string_lossy())
                            );
                        }
                    }
                }
            }
        }

        Ok(())
    }

    pub fn should_log(message_level: LogLevel, current_level: LogLevel) -> bool {
        match message_level {
            LogLevel::Debug => matches!(current_level, LogLevel::Debug),
            LogLevel::Info => matches!(current_level, LogLevel::Debug | LogLevel::Info),
            LogLevel::Warn => matches!(
                current_level,
                LogLevel::Debug | LogLevel::Info | LogLevel::Warn
            ),
            LogLevel::Error => true,
        }
    }

    #[allow(dead_code)]
    pub async fn log_backend(
        &self,
        level: LogLevel,
        message: &str,
        data: Option<serde_json::Value>,
    ) {
        self.log(level, &format!("[Backend] {}", message), data)
            .await;
    }

    pub async fn log_frontend(
        &self,
        level: LogLevel,
        message: &str,
        data: Option<serde_json::Value>,
    ) {
        let current_level = Self::read_log_level();
        if !Self::should_log(level, current_level) {
            return;
        }

        let level_str = format!("{:?}", level);
        let timestamp = Utc::now();
        let local_time = timestamp.with_timezone(&Local);
        let tagged_message = format!("[App] {}", Self::sanitize_log_text(message));
        let sanitized_data = data.map(Self::sanitize_log_data);

        // Write to the unified session log file
        let log_line = if let Some(d) = sanitized_data {
            format!(
                "[{}] [{}] {} | Data: {}\n",
                local_time.format("%Y-%m-%d %H:%M:%S"),
                level_str,
                tagged_message,
                serde_json::to_string(&d).unwrap_or_default()
            )
        } else {
            format!(
                "[{}] [{}] {}\n",
                local_time.format("%Y-%m-%d %H:%M:%S"),
                level_str,
                tagged_message
            )
        };

        // Use the app log file path stored at initialization
        if let Err(e) = self
            .write_to_file(
                &self.session_log_file,
                &log_line,
                matches!(level, LogLevel::Warn | LogLevel::Error),
            )
            .await
        {
            eprintln!("Failed to write to app log file: {}", e);
        }

        self.maybe_schedule_log_cleanup();
    }

    #[allow(dead_code)]
    pub async fn log_game_version(
        &self,
        level: LogLevel,
        message: &str,
        data: Option<serde_json::Value>,
    ) {
        self.log(level, &format!("[GameVersion] {}", message), data)
            .await;
    }

    #[allow(dead_code)]
    pub async fn log_update_check(
        &self,
        level: LogLevel,
        message: &str,
        data: Option<serde_json::Value>,
    ) {
        self.log(level, &format!("[UpdateCheck] {}", message), data)
            .await;
    }

    #[allow(dead_code)]
    pub async fn log_melon_loader(
        &self,
        level: LogLevel,
        message: &str,
        data: Option<serde_json::Value>,
    ) {
        self.log(level, &format!("[MelonLoader] {}", message), data)
            .await;
    }

    #[allow(dead_code)]
    pub async fn log_websocket(
        &self,
        level: LogLevel,
        message: &str,
        data: Option<serde_json::Value>,
    ) {
        self.log(level, &format!("[WebSocket] {}", message), data)
            .await;
    }

    /// Get list of available log files
    pub async fn list_log_files(&self) -> Result<Vec<String>> {
        let mut log_files = Vec::new();
        let mut entries = fs::read_dir(&self.logs_dir).await?;

        while let Some(entry) = entries.next_entry().await? {
            let path = entry.path();
            if path.is_file() {
                if let Some(file_name) = path.file_name().and_then(|n| n.to_str()) {
                    // Include current SIMM-log-* files and legacy log files
                    let is_log_file = (file_name.starts_with("SIMM-log-")
                        || file_name.starts_with("server-")
                        || file_name.starts_with("app-")
                        || file_name.starts_with("log-"))
                        && file_name.ends_with(".log");
                    if is_log_file {
                        log_files.push(file_name.to_string());
                    }
                }
            }
        }

        log_files.sort();
        log_files.reverse(); // Most recent first
        Ok(log_files)
    }

    /// Read a specific log file
    pub async fn read_log_file(&self, filename: &str) -> Result<String> {
        let file_path = self.logs_dir.join(filename);

        // Security check: ensure filename doesn't contain path traversal
        if filename.contains("..") || filename.contains('/') || filename.contains('\\') {
            return Err(anyhow::anyhow!("Invalid filename"));
        }

        fs::read_to_string(&file_path)
            .await
            .context("Failed to read log file")
    }
}

impl Default for LoggerService {
    fn default() -> Self {
        Self::new().expect("Failed to create LoggerService")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serial_test::serial;
    use tempfile::tempdir;

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
    fn should_log_respects_thresholds() {
        assert!(LoggerService::should_log(LogLevel::Error, LogLevel::Error));
        assert!(LoggerService::should_log(LogLevel::Warn, LogLevel::Info));
        assert!(LoggerService::should_log(LogLevel::Debug, LogLevel::Debug));
        assert!(!LoggerService::should_log(LogLevel::Debug, LogLevel::Info));
        assert!(!LoggerService::should_log(LogLevel::Info, LogLevel::Warn));
    }

    #[test]
    fn sanitize_log_text_redacts_windows_unix_and_file_uri_paths() {
        let sanitized = LoggerService::sanitize_log_text(
            "C:/Users/Alice/secret.txt C:\\Users\\Alice\\secret.txt /home/alice/secret.txt file:///tmp/secret.txt",
        );

        assert!(!sanitized.contains("Alice"));
        assert!(!sanitized.contains("/home/alice"));
        assert!(!sanitized.contains("file:///"));
    }

    #[test]
    fn sanitize_log_text_redacts_unix_paths_after_non_whitespace_delimiters() {
        let sanitized = LoggerService::sanitize_log_text(
            "setting=/home/alice/private.txt; cache=/var/lib/simm/cache.db",
        );

        assert!(!sanitized.contains("/home/alice"));
        assert!(!sanitized.contains("/var/lib/simm"));
        assert!(sanitized.contains("setting=<path:private.txt>"));
    }

    #[test]
    fn sanitize_log_data_recursively_redacts_nested_secret_keys() {
        let sanitized = LoggerService::sanitize_log_data(serde_json::json!({
            "outer": [
                { "Password": "secret-password", "tokenCount": 3 },
                { "nested": { "nexusApiKey": "secret-key", "refresh_token": "secret-token" } }
            ],
            "username": "steam-user",
            "passwordHint": "harmless lookalike"
        }));

        assert_eq!(sanitized["outer"][0]["Password"], "<redacted>");
        assert_eq!(sanitized["outer"][0]["tokenCount"], 3);
        assert_eq!(sanitized["outer"][1]["nested"]["nexusApiKey"], "<redacted>");
        assert_eq!(
            sanitized["outer"][1]["nested"]["refresh_token"],
            "<redacted>"
        );
        assert_eq!(sanitized["username"], "<redacted>");
        assert_eq!(sanitized["passwordHint"], "harmless lookalike");
    }

    #[test]
    fn sanitize_log_text_redacts_quoted_json_secret_keys() {
        let sanitized = LoggerService::sanitize_log_text(
            r#"payload={"password":"secret-pass","apiKey":"secret-key","refresh_token":"refresh-value","accessToken":"access-value","idToken":"id-value","authorization":"Bearer secret","cookie":"session=secret","credential":"secret-credential","nexusApiKey":"nexus-key","tokenCount":2}"#,
        );

        for secret in [
            "secret-pass",
            "secret-key",
            "refresh-value",
            "access-value",
            "id-value",
            "Bearer secret",
            "session=secret",
            "secret-credential",
            "nexus-key",
        ] {
            assert!(
                !sanitized.contains(secret),
                "secret {secret} leaked into text log"
            );
        }
        assert!(sanitized.contains("tokenCount"));
    }

    #[tokio::test]
    #[serial]
    async fn logger_service_honors_runtime_log_level_configuration() -> Result<()> {
        let temp = tempdir()?;
        let _guard = EnvVarGuard::set("SIMMRUST_HOME_DIR", temp.path().to_string_lossy().as_ref());

        let logger_a = LoggerService::new()?;
        let logger_b = LoggerService::new()?;

        logger_a.set_log_level(LogLevel::Debug).await;
        logger_a.set_retention_days(14).await;

        assert_eq!(LoggerService::current_log_level(), LogLevel::Debug);
        assert_eq!(
            LoggerService::level_filter(LoggerService::current_log_level()),
            LevelFilter::Debug
        );
        assert_eq!(logger_b.get_retention_days().await, 14);

        logger_b.set_log_level(LogLevel::Error).await;
        logger_b.set_retention_days(7).await;

        assert_eq!(LoggerService::current_log_level(), LogLevel::Error);
        assert_eq!(logger_a.get_retention_days().await, 7);

        Ok(())
    }
}
