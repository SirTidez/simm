use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::RwLock;
use tokio::fs::{self, OpenOptions};
use tokio::io::AsyncWriteExt;
use anyhow::{Context, Result};
use chrono::{DateTime, Utc, Local};
use crate::types::LogLevel;

pub struct LoggerService {
    log_level: Arc<RwLock<LogLevel>>,
    logs_dir: PathBuf,
    server_log_file: PathBuf, // Server/backend log file for this session
    app_log_file: PathBuf, // App/frontend log file for this session
    retention_days: Arc<RwLock<u32>>,
}

impl LoggerService {
    pub fn new() -> Result<Self> {
        // Use SIMM/logs directory
        let logs_dir = crate::utils::directory_init::initialize_simm_directory()?
            .0
            .join("logs");

        std::fs::create_dir_all(&logs_dir)?;

        // Generate log filenames once for this session
        let now = Local::now();
        let timestamp = now.format("%Y-%m-%d-%H-%M-%S");
        let server_filename = format!("server-{}.log", timestamp);
        let app_filename = format!("app-{}.log", timestamp);
        let server_log_file = logs_dir.join(server_filename);
        let app_log_file = logs_dir.join(app_filename);

        Ok(Self {
            log_level: Arc::new(RwLock::new(LogLevel::Info)),
            logs_dir,
            server_log_file,
            app_log_file,
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

        let level_str = format!("{:?}", level);
        let timestamp = Utc::now();
        let local_time = timestamp.with_timezone(&Local);

        let _log_entry = serde_json::json!({
            "timestamp": timestamp.to_rfc3339(),
            "level": level_str.clone(),
            "message": message,
            "data": data
        });

        // Print to console (for dev mode)
        println!("[{}] {}", level_str, message);

        // Write to file
        let log_line = if let Some(d) = data {
            format!("[{}] [{}] {} | Data: {}\n",
                local_time.format("%Y-%m-%d %H:%M:%S"),
                level_str,
                message,
                serde_json::to_string(&d).unwrap_or_default()
            )
        } else {
            format!("[{}] [{}] {}\n",
                local_time.format("%Y-%m-%d %H:%M:%S"),
                level_str,
                message
            )
        };

        // Use the server log file path stored at initialization
        if let Err(e) = self.write_to_file(&self.server_log_file, &log_line).await {
            eprintln!("Failed to write to server log file: {}", e);
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

        file.write_all(content.as_bytes()).await
            .context("Failed to write to log file")?;

        file.flush().await
            .context("Failed to flush log file")?;

        Ok(())
    }

    async fn cleanup_old_logs(logs_dir: &PathBuf, retention_days: u32) -> Result<()> {
        let cutoff_time = Utc::now() - chrono::Duration::days(retention_days as i64);

        let mut entries = fs::read_dir(logs_dir).await?;
        while let Some(entry) = entries.next_entry().await? {
            let path = entry.path();

            if path.is_file() {
                let file_name = path.file_name()
                    .and_then(|n| n.to_str())
                    .unwrap_or("");

                // Only process our log files (server-*.log, app-*.log, or legacy log-*.log)
                let is_log_file = (file_name.starts_with("server-") ||
                                  file_name.starts_with("app-") ||
                                  file_name.starts_with("log-")) &&
                                  file_name.ends_with(".log");

                if is_log_file {
                    let metadata = fs::metadata(&path).await?;
                    if let Ok(modified) = metadata.modified() {
                        let modified_time: DateTime<Utc> = modified.into();
                        if modified_time < cutoff_time {
                            let _ = fs::remove_file(&path).await;
                            eprintln!("[Logger] Deleted old log file: {:?}", path);
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
            LogLevel::Warn => matches!(current_level, LogLevel::Debug | LogLevel::Info | LogLevel::Warn),
            LogLevel::Error => true,
        }
    }

    #[allow(dead_code)]
    pub async fn log_backend(&self, level: LogLevel, message: &str, data: Option<serde_json::Value>) {
        self.log(level, &format!("[Backend] {}", message), data).await;
    }

    pub async fn log_frontend(&self, level: LogLevel, message: &str, data: Option<serde_json::Value>) {
        let current_level = self.log_level.read().await.clone();
        if !self.should_log(level.clone(), current_level.clone()) {
            return;
        }

        let level_str = format!("{:?}", level);
        let timestamp = Utc::now();
        let local_time = timestamp.with_timezone(&Local);

        // Print to console (for dev mode)
        println!("[App] [{}] {}", level_str, message);

        // Write to app log file
        let log_line = if let Some(d) = data {
            format!("[{}] [{}] {} | Data: {}\n",
                local_time.format("%Y-%m-%d %H:%M:%S"),
                level_str,
                message,
                serde_json::to_string(&d).unwrap_or_default()
            )
        } else {
            format!("[{}] [{}] {}\n",
                local_time.format("%Y-%m-%d %H:%M:%S"),
                level_str,
                message
            )
        };

        // Use the app log file path stored at initialization
        if let Err(e) = self.write_to_file(&self.app_log_file, &log_line).await {
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
    pub async fn log_game_version(&self, level: LogLevel, message: &str, data: Option<serde_json::Value>) {
        self.log(level, &format!("[GameVersion] {}", message), data).await;
    }

    #[allow(dead_code)]
    pub async fn log_update_check(&self, level: LogLevel, message: &str, data: Option<serde_json::Value>) {
        self.log(level, &format!("[UpdateCheck] {}", message), data).await;
    }

    #[allow(dead_code)]
    pub async fn log_melon_loader(&self, level: LogLevel, message: &str, data: Option<serde_json::Value>) {
        self.log(level, &format!("[MelonLoader] {}", message), data).await;
    }

    #[allow(dead_code)]
    pub async fn log_websocket(&self, level: LogLevel, message: &str, data: Option<serde_json::Value>) {
        self.log(level, &format!("[WebSocket] {}", message), data).await;
    }

    /// Get list of available log files
    pub async fn list_log_files(&self) -> Result<Vec<String>> {
        let mut log_files = Vec::new();
        let mut entries = fs::read_dir(&self.logs_dir).await?;

        while let Some(entry) = entries.next_entry().await? {
            let path = entry.path();
            if path.is_file() {
                if let Some(file_name) = path.file_name().and_then(|n| n.to_str()) {
                    // Include server-*, app-*, and legacy log-* files
                    let is_log_file = (file_name.starts_with("server-") ||
                                      file_name.starts_with("app-") ||
                                      file_name.starts_with("log-")) &&
                                      file_name.ends_with(".log");
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

        fs::read_to_string(&file_path).await
            .context("Failed to read log file")
    }
}

impl Default for LoggerService {
    fn default() -> Self {
        Self::new().expect("Failed to create LoggerService")
    }
}
