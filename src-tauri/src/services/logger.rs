use crate::types::LogLevel;
use anyhow::{Context, Result};
use chrono::{DateTime, Local, Utc};
use once_cell::sync::Lazy;
use regex::{Captures, Regex};
use std::path::PathBuf;
use std::sync::Arc;
use tokio::fs::{self, OpenOptions};
use tokio::io::AsyncWriteExt;
use tokio::sync::RwLock;

static SESSION_LOG_FILENAME: Lazy<String> = Lazy::new(|| {
    let now = Local::now();
    format!("SIMM-log-{}.log", now.format("%Y-%m-%d-%H-%M-%S"))
});
static WINDOWS_PATH_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r#"(?i)\b[a-z]:\\(?:[^\\/:*?"<>|\r\n]+\\)*[^\\/:*?"<>|\r\n]*"#)
        .expect("windows path regex")
});
static USERNAME_KEY_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r#"(?i)\b(username|user|login)\s*[:=]\s*(?:"[^"]*"|[^\s,|]+)"#)
        .expect("username key regex")
});
static USERNAME_ARG_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r#"(?i)(-username\s+)(\S+)"#).expect("username arg regex"));
static SECRET_KEY_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r#"(?i)\b(password|steamguard|token|api[-_ ]?key)\s*[:=]\s*(?:"[^"]*"|[^\s,|]+)"#)
        .expect("secret key regex")
});
static SECRET_ARG_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r#"(?i)(-(?:password|steamguard|token|api-key)\s+)(\S+)"#).expect("secret arg regex")
});
static EMAIL_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r#"(?i)\b[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}\b"#).expect("email regex")
});

pub struct LoggerService {
    log_level: Arc<RwLock<LogLevel>>,
    logs_dir: PathBuf,
    session_log_file: PathBuf, // Unified app log file for this session
    retention_days: Arc<RwLock<u32>>,
}

impl LoggerService {
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

        sanitized = WINDOWS_PATH_RE
            .replace_all(&sanitized, |caps: &Captures| {
                Self::summarize_path(caps.get(0).map(|m| m.as_str()).unwrap_or_default())
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

        sanitized
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
                        let lower_key = key.to_ascii_lowercase();
                        let sanitized_value = if lower_key.contains("password")
                            || lower_key.contains("steamguard")
                            || lower_key.contains("token")
                            || lower_key.contains("api_key")
                            || lower_key.contains("apikey")
                            || lower_key == "username"
                            || lower_key == "login"
                            || lower_key == "user"
                        {
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

        Ok(Self {
            log_level: Arc::new(RwLock::new(LogLevel::Info)),
            logs_dir,
            session_log_file,
            retention_days: Arc::new(RwLock::new(7)), // Default 7 days
        })
    }

    pub async fn set_log_level(&self, level: LogLevel) {
        *self.log_level.write().await = level;
    }

    pub async fn set_retention_days(&self, days: u32) {
        *self.retention_days.write().await = days;
    }

    pub async fn get_retention_days(&self) -> u32 {
        *self.retention_days.read().await
    }

    pub async fn log(&self, level: LogLevel, message: &str, data: Option<serde_json::Value>) {
        let current_level = self.log_level.read().await.clone();
        if !self.should_log(level.clone(), current_level.clone()) {
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
        if let Err(e) = self.write_to_file(&self.session_log_file, &log_line).await {
            eprintln!("Failed to write to app log file: {}", e);
        }

        // Periodically cleanup old logs (do it async without blocking)
        let logs_dir = self.logs_dir.clone();
        let retention = *self.retention_days.read().await;
        tokio::spawn(async move {
            let _ = Self::cleanup_old_logs(&logs_dir, retention).await;
        });
    }

    async fn write_to_file(&self, file_path: &PathBuf, content: &str) -> Result<()> {
        let mut file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(file_path)
            .await
            .context("Failed to open log file")?;

        file.write_all(content.as_bytes())
            .await
            .context("Failed to write to log file")?;

        file.flush().await.context("Failed to flush log file")?;

        Ok(())
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

    fn should_log(&self, message_level: LogLevel, current_level: LogLevel) -> bool {
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
        let current_level = self.log_level.read().await.clone();
        if !self.should_log(level.clone(), current_level.clone()) {
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
        if let Err(e) = self.write_to_file(&self.session_log_file, &log_line).await {
            eprintln!("Failed to write to app log file: {}", e);
        }

        // Periodically cleanup old logs (do it async without blocking)
        let logs_dir = self.logs_dir.clone();
        let retention = *self.retention_days.read().await;
        tokio::spawn(async move {
            let _ = Self::cleanup_old_logs(&logs_dir, retention).await;
        });
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
