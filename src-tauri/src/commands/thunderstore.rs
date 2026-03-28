use crate::services::thunderstore::ThunderStoreService;
use once_cell::sync::Lazy;
use sqlx::SqlitePool;
use std::sync::Arc;
use tauri::{AppHandle, State};
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
    app: AppHandle,
    package_uuid: String,
    game_id: Option<String>,
    version_uuid: Option<String>,
) -> Result<String, String> {
    let service = get_thunderstore_service(db.inner().clone()).await?;
    let label = service
        .get_package(&package_uuid, game_id.as_deref())
        .await
        .ok()
        .flatten()
        .and_then(|package| {
            package
                .get("name")
                .and_then(|value| value.as_str())
                .map(|name| format!("{}.zip", name))
        })
        .unwrap_or_else(|| format!("{}.zip", package_uuid));
    let tracked_download = crate::services::tracked_downloads::start_file_download(
        crate::services::tracked_downloads::new_download_id("thunderstore"),
        crate::types::TrackedDownloadKind::Mod,
        label,
        "Thunderstore",
        Some("Downloading archive".to_string()),
    );
    let _ = crate::services::tracked_downloads::emit(&app, tracked_download.clone());

    let bytes = service
        .download_package(&package_uuid, game_id.as_deref(), version_uuid.as_deref())
        .await
        .map_err(|e| {
            let _ = crate::services::tracked_downloads::emit(
                &app,
                crate::services::tracked_downloads::fail_file_download(
                    &tracked_download,
                    e.to_string(),
                    Some("Download failed".to_string()),
                ),
            );
            e.to_string()
        })?;

    // Save to temp file
    let temp_dir = std::env::temp_dir();
    let temp_file = temp_dir.join(format!("thunderstore-{}.zip", package_uuid));
    tokio::fs::write(&temp_file, bytes).await.map_err(|e| {
        let message = format!("Failed to save downloaded file: {}", e);
        let _ = crate::services::tracked_downloads::emit(
            &app,
            crate::services::tracked_downloads::fail_file_download(
                &tracked_download,
                message.clone(),
                Some("Download failed".to_string()),
            ),
        );
        message
    })?;
    let _ = crate::services::tracked_downloads::emit(
        &app,
        crate::services::tracked_downloads::complete_file_download(
            &tracked_download,
            Some("Archive downloaded".to_string()),
        ),
    );

    Ok(temp_file.to_string_lossy().to_string())
}
