use crate::services::thunderstore::ThunderStoreService;
use once_cell::sync::Lazy;
use sqlx::SqlitePool;
use std::sync::Arc;
use tauri::State;
use tokio::sync::Mutex as AsyncMutex;

static THUNDERSTORE_SERVICE: Lazy<AsyncMutex<Option<Arc<ThunderStoreService>>>> =
    Lazy::new(|| AsyncMutex::new(None));

async fn get_thunderstore_service(db: Arc<SqlitePool>) -> Result<Arc<ThunderStoreService>, String> {
    let _ = db;
    let mut service = THUNDERSTORE_SERVICE.lock().await;
    if service.is_none() {
        *service = Some(Arc::new(ThunderStoreService::new()));
    }
    Ok(service.as_ref().unwrap().clone())
}

#[tauri::command]
pub async fn search_thunderstore_packages(
    db: State<'_, Arc<SqlitePool>>,
    game_id: String,
    runtime: String,
    query: Option<String>,
) -> Result<Vec<serde_json::Value>, String> {
    let service = get_thunderstore_service(db.inner().clone()).await?;
    service
        .search_packages_filtered_by_runtime(&game_id, &runtime, query.as_deref())
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_thunderstore_package(
    db: State<'_, Arc<SqlitePool>>,
    package_uuid: String,
    game_id: Option<String>,
) -> Result<Option<serde_json::Value>, String> {
    let service = get_thunderstore_service(db.inner().clone()).await?;
    service
        .get_package(&package_uuid, game_id.as_deref())
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn download_thunderstore_package(
    db: State<'_, Arc<SqlitePool>>,
    package_uuid: String,
    game_id: Option<String>,
) -> Result<String, String> {
    let service = get_thunderstore_service(db.inner().clone()).await?;
    let bytes = service
        .download_package(&package_uuid, game_id.as_deref())
        .await
        .map_err(|e| e.to_string())?;

    // Save to temp file
    let temp_dir = std::env::temp_dir();
    let temp_file = temp_dir.join(format!("thunderstore-{}.zip", package_uuid));
    tokio::fs::write(&temp_file, bytes)
        .await
        .map_err(|e| format!("Failed to save downloaded file: {}", e))?;

    Ok(temp_file.to_string_lossy().to_string())
}
