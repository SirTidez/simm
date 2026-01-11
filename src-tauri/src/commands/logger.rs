use crate::services::logger::LoggerService;
use crate::types::LogLevel;
use std::sync::Arc;
use tokio::sync::Mutex as AsyncMutex;
use once_cell::sync::Lazy;

static LOGGER_SERVICE: Lazy<AsyncMutex<Option<Arc<LoggerService>>>> = Lazy::new(|| AsyncMutex::new(None));

async fn get_logger_service() -> Result<Arc<LoggerService>, String> {
    let mut service = LOGGER_SERVICE.lock().await;
    if service.is_none() {
        *service = Some(Arc::new(LoggerService::new().map_err(|e| e.to_string())?));
    }
    Ok(service.as_ref().unwrap().clone())
}

#[tauri::command]
pub async fn log_message(
    level: String,
    message: String,
    data: Option<serde_json::Value>,
) -> Result<(), String> {
    let logger = get_logger_service().await?;

    let log_level = match level.to_lowercase().as_str() {
        "debug" => LogLevel::Debug,
        "info" => LogLevel::Info,
        "warn" => LogLevel::Warn,
        "error" => LogLevel::Error,
        _ => LogLevel::Info,
    };

    logger.log(log_level, &message, data).await;
    Ok(())
}

#[tauri::command]
pub async fn log_frontend(
    level: String,
    message: String,
    data: Option<serde_json::Value>,
) -> Result<(), String> {
    let logger = get_logger_service().await?;

    let log_level = match level.to_lowercase().as_str() {
        "debug" => LogLevel::Debug,
        "info" => LogLevel::Info,
        "warn" => LogLevel::Warn,
        "error" => LogLevel::Error,
        _ => LogLevel::Info,
    };

    logger.log_frontend(log_level, &message, data).await;
    Ok(())
}

#[tauri::command]
pub async fn set_log_level(level: String) -> Result<(), String> {
    let logger = get_logger_service().await?;

    let log_level = match level.to_lowercase().as_str() {
        "debug" => LogLevel::Debug,
        "info" => LogLevel::Info,
        "warn" => LogLevel::Warn,
        "error" => LogLevel::Error,
        _ => return Err("Invalid log level".to_string()),
    };

    logger.set_log_level(log_level).await;
    Ok(())
}

#[tauri::command]
pub async fn set_log_retention_days(days: u32) -> Result<(), String> {
    let logger = get_logger_service().await?;
    logger.set_retention_days(days).await;
    Ok(())
}

#[tauri::command]
pub async fn get_log_retention_days() -> Result<u32, String> {
    let logger = get_logger_service().await?;
    Ok(logger.get_retention_days().await)
}

#[tauri::command]
pub async fn list_log_files() -> Result<Vec<String>, String> {
    let logger = get_logger_service().await?;
    logger.list_log_files().await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn read_log_file(filename: String) -> Result<String, String> {
    let logger = get_logger_service().await?;
    logger.read_log_file(&filename).await.map_err(|e| e.to_string())
}
