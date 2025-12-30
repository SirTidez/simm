use crate::services::logs::LogsService;
use crate::services::environment::EnvironmentService;
use std::sync::Arc;
use tokio::sync::Mutex as AsyncMutex;
use once_cell::sync::Lazy;

static LOGS_SERVICE: Lazy<AsyncMutex<Option<Arc<LogsService>>>> = Lazy::new(|| AsyncMutex::new(None));
static ENV_SERVICE: Lazy<AsyncMutex<Option<Arc<EnvironmentService>>>> = Lazy::new(|| AsyncMutex::new(None));

async fn get_logs_service() -> std::result::Result<Arc<LogsService>, String> {
    let mut service = LOGS_SERVICE.lock().await;
    if service.is_none() {
        *service = Some(Arc::new(LogsService::new()));
    }
    Ok(service.as_ref().unwrap().clone())
}

async fn get_env_service() -> std::result::Result<Arc<EnvironmentService>, String> {
    let mut service = ENV_SERVICE.lock().await;
    if service.is_none() {
        *service = Some(Arc::new(EnvironmentService::new().map_err(|e| e.to_string())?));
    }
    Ok(service.as_ref().unwrap().clone())
}

#[tauri::command]
pub async fn get_log_files(environment_id: String) -> Result<Vec<serde_json::Value>, String> {
    let env_service = get_env_service().await?;
    let env = env_service.get_environment(&environment_id)
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "Environment not found".to_string())?;

    let logs_service = get_logs_service().await?;
    let log_files = logs_service.list_log_files(&env.output_dir)
        .await
        .map_err(|e| e.to_string())?;

    Ok(log_files.iter()
        .map(|f| serde_json::json!({
            "name": f.name,
            "path": f.path,
            "size": f.size,
            "modified": f.modified,
            "isLatest": f.is_latest,
        }))
        .collect())
}

#[tauri::command]
pub async fn read_log_file(
    log_path: String,
    max_lines: Option<usize>,
) -> Result<Vec<serde_json::Value>, String> {
    let logs_service = get_logs_service().await?;
    let log_lines = logs_service.read_log_file(&log_path, max_lines)
        .await
        .map_err(|e| e.to_string())?;

    Ok(log_lines.iter()
        .map(|l| serde_json::json!({
            "lineNumber": l.line_number,
            "content": l.content,
            "level": l.level,
            "timestamp": l.timestamp,
        }))
        .collect())
}

#[tauri::command]
pub async fn export_logs(
    log_path: String,
    filter_level: Option<String>,
    search_query: Option<String>,
    output_path: String,
) -> Result<(), String> {
    let logs_service = get_logs_service().await?;
    logs_service.export_logs(
        &log_path,
        filter_level.as_deref(),
        search_query.as_deref(),
        &output_path,
    )
    .await
    .map_err(|e| e.to_string())
}

