use crate::services::fomod::FomodService;
use once_cell::sync::Lazy;
use std::path::Path;
use std::sync::Arc;
use tokio::sync::Mutex;

static FOMOD_SERVICE: Lazy<Arc<Mutex<FomodService>>> =
    Lazy::new(|| Arc::new(Mutex::new(FomodService::new())));

async fn get_fomod_service() -> Result<Arc<Mutex<FomodService>>, String> {
    Ok(Arc::clone(&FOMOD_SERVICE))
}

#[tauri::command]
pub async fn detect_fomod(zip_path: String) -> Result<serde_json::Value, String> {
    let service = get_fomod_service().await?;
    let service = service.lock().await;

    let result = service
        .detect_fomod(Path::new(&zip_path))
        .map_err(|e| e.to_string())?;

    Ok(serde_json::json!(result))
}

#[tauri::command]
pub async fn parse_fomod_xml(zip_path: String) -> Result<serde_json::Value, String> {
    let service = get_fomod_service().await?;
    let service = service.lock().await;

    let config = service
        .parse_fomod_xml(Path::new(&zip_path))
        .map_err(|e| e.to_string())?;

    Ok(serde_json::json!(config))
}
