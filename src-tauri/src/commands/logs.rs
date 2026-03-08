use crate::services::environment::EnvironmentService;
use crate::services::logger::LoggerService;
use crate::services::logs::LogsService;
use crate::types::LogLevel;
use once_cell::sync::Lazy;
use sqlx::SqlitePool;
use std::sync::Arc;
use tauri::{AppHandle, State};
use tokio::sync::Mutex as AsyncMutex;

static LOGS_SERVICE: Lazy<AsyncMutex<Option<Arc<LogsService>>>> =
    Lazy::new(|| AsyncMutex::new(None));

async fn get_logs_service() -> std::result::Result<Arc<LogsService>, String> {
    let mut service = LOGS_SERVICE.lock().await;
    if service.is_none() {
        *service = Some(Arc::new(LogsService::new()));
    }
    Ok(service.as_ref().unwrap().clone())
}

async fn get_logger_service() -> Result<Arc<LoggerService>, String> {
    // Create a new logger instance
    // Note: Multiple instances are safe because they all write to the same
    // log files in ~/SIMM/logs/ and file operations are atomic
    LoggerService::new()
        .map(|logger| Arc::new(logger))
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_log_files(
    db: State<'_, Arc<SqlitePool>>,
    environment_id: String,
) -> Result<Vec<serde_json::Value>, String> {
    let env_service = EnvironmentService::new(db.inner().clone()).map_err(|e| e.to_string())?;
    let env = env_service
        .get_environment(&environment_id)
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "Environment not found".to_string())?;

    let logs_service = get_logs_service().await?;
    let log_files = logs_service
        .list_log_files(&env.output_dir)
        .await
        .map_err(|e| e.to_string())?;

    Ok(log_files
        .iter()
        .map(|f| {
            serde_json::json!({
                "name": f.name,
                "path": f.path,
                "size": f.size,
                "modified": f.modified,
                "isLatest": f.is_latest,
            })
        })
        .collect())
}

#[tauri::command]
pub async fn read_log_file(
    log_path: String,
    max_lines: Option<usize>,
) -> Result<Vec<serde_json::Value>, String> {
    let logs_service = get_logs_service().await?;
    let log_lines = logs_service
        .read_log_file(&log_path, max_lines)
        .await
        .map_err(|e| e.to_string())?;

    Ok(log_lines
        .iter()
        .map(|l| {
            serde_json::json!({
                "lineNumber": l.line_number,
                "content": l.content,
                "level": l.level,
                "timestamp": l.timestamp,
                "modTag": l.mod_tag,
                "category": l.category,
            })
        })
        .collect())
}

#[tauri::command]
pub async fn watch_log_file(app_handle: AppHandle, log_path: String) -> Result<(), String> {
    let logs_service = get_logs_service().await?;

    // Spawn a task to watch the file
    tokio::spawn(async move {
        if let Err(e) = logs_service.watch_log_file(&log_path, app_handle).await {
            eprintln!("Error watching log file: {}", e);
        }
    });

    Ok(())
}

#[tauri::command]
pub async fn stop_watching_log() -> Result<(), String> {
    let logs_service = get_logs_service().await?;
    logs_service.stop_watching().await;
    Ok(())
}

#[tauri::command]
pub async fn export_logs(
    log_path: String,
    filter_level: Option<String>,
    search_query: Option<String>,
    filter_mod_tag: Option<String>,
    output_path: String,
) -> Result<(), String> {
    let logs_service = get_logs_service().await?;
    logs_service
        .export_logs(
            &log_path,
            filter_level.as_deref(),
            search_query.as_deref(),
            filter_mod_tag.as_deref(),
            &output_path,
        )
        .await
        .map_err(|e| e.to_string())
}

// App logging commands (not game logs)
#[tauri::command]
pub async fn log_frontend_message(
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
pub async fn set_app_log_level(level: String) -> Result<(), String> {
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
pub async fn set_app_log_retention_days(days: u32) -> Result<(), String> {
    let logger = get_logger_service().await?;
    logger.set_retention_days(days).await;
    Ok(())
}

#[tauri::command]
pub async fn get_app_log_retention_days() -> Result<u32, String> {
    let logger = get_logger_service().await?;
    Ok(logger.get_retention_days().await)
}

#[tauri::command]
pub async fn list_app_log_files() -> Result<Vec<String>, String> {
    let logger = get_logger_service().await?;
    logger.list_log_files().await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn read_app_log_file(filename: String) -> Result<String, String> {
    let logger = get_logger_service().await?;
    logger
        .read_log_file(&filename)
        .await
        .map_err(|e| e.to_string())
}
