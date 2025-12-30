use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::RwLock;
use anyhow::Result;
use crate::types::LogLevel;

pub struct LoggerService {
    log_level: Arc<RwLock<LogLevel>>,
    log_file: Option<PathBuf>,
}

impl LoggerService {
    pub fn new() -> Result<Self> {
        let data_dir = dirs::data_dir()
            .ok_or_else(|| anyhow::anyhow!("Could not determine data directory"))?
            .join("s1devenvmanager");
        
        std::fs::create_dir_all(&data_dir)?;
        
        Ok(Self {
            log_level: Arc::new(RwLock::new(LogLevel::Info)),
            log_file: Some(data_dir.join("app.log")),
        })
    }

    pub async fn set_log_level(&self, level: LogLevel) {
        *self.log_level.write().await = level;
    }

    pub async fn log(&self, level: LogLevel, message: &str, data: Option<serde_json::Value>) {
        let current_level = self.log_level.read().await.clone();
        if !self.should_log(level.clone(), current_level.clone()) {
            return;
        }

        let level_str = format!("{:?}", level);
        let _log_entry = serde_json::json!({
            "timestamp": chrono::Utc::now().to_rfc3339(),
            "level": level_str.clone(),
            "message": message,
            "data": data
        });

        println!("[{}] {}", level_str, message);
        
        // TODO: Write to log file
    }

    fn should_log(&self, message_level: LogLevel, current_level: LogLevel) -> bool {
        match message_level {
            LogLevel::Debug => matches!(current_level, LogLevel::Debug),
            LogLevel::Info => matches!(current_level, LogLevel::Debug | LogLevel::Info),
            LogLevel::Warn => matches!(current_level, LogLevel::Debug | LogLevel::Info | LogLevel::Warn),
            LogLevel::Error => true,
        }
    }

    pub async fn log_backend(&self, level: LogLevel, message: &str, data: Option<serde_json::Value>) {
        self.log(level, &format!("[Backend] {}", message), data).await;
    }

    pub async fn log_frontend(&self, level: LogLevel, message: &str, data: Option<serde_json::Value>) {
        self.log(level, &format!("[Frontend] {}", message), data).await;
    }

    pub async fn log_game_version(&self, level: LogLevel, message: &str, data: Option<serde_json::Value>) {
        self.log(level, &format!("[GameVersion] {}", message), data).await;
    }

    pub async fn log_update_check(&self, level: LogLevel, message: &str, data: Option<serde_json::Value>) {
        self.log(level, &format!("[UpdateCheck] {}", message), data).await;
    }

    pub async fn log_melon_loader(&self, level: LogLevel, message: &str, data: Option<serde_json::Value>) {
        self.log(level, &format!("[MelonLoader] {}", message), data).await;
    }

    pub async fn log_websocket(&self, level: LogLevel, message: &str, data: Option<serde_json::Value>) {
        self.log(level, &format!("[WebSocket] {}", message), data).await;
    }
}

impl Default for LoggerService {
    fn default() -> Self {
        Self::new().expect("Failed to create LoggerService")
    }
}

