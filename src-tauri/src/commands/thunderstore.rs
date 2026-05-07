use crate::services::thunderstore::{shared_thunderstore_service, ThunderStoreService};
use sqlx::SqlitePool;
use std::sync::Arc;
use tauri::{AppHandle, State};

fn sanitize_temp_component(value: &str) -> String {
    let sanitized: String = value
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' {
                ch
            } else {
                '-'
            }
        })
        .collect();

    let trimmed = sanitized.trim_matches('-');
    if trimmed.is_empty() {
        "selected-version".to_string()
    } else {
        trimmed.to_string()
    }
}

async fn get_thunderstore_service(db: Arc<SqlitePool>) -> Result<Arc<ThunderStoreService>, String> {
    let _ = db;
    Ok(shared_thunderstore_service())
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
pub async fn search_thunderstore_packages_by_runtime(
    db: State<'_, Arc<SqlitePool>>,
    game_id: String,
    query: Option<String>,
) -> Result<serde_json::Value, String> {
    let service = get_thunderstore_service(db.inner().clone()).await?;
    service
        .search_packages_grouped_by_runtime(&game_id, query.as_deref())
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn refresh_thunderstore_package_cache(
    db: State<'_, Arc<SqlitePool>>,
    game_id: String,
) -> Result<serde_json::Value, String> {
    let service = get_thunderstore_service(db.inner().clone()).await?;
    let refresh = service
        .refresh_community_cache_manually(&game_id, None)
        .await
        .map_err(|e| e.to_string())?;
    Ok(serde_json::json!({
        "packageCount": refresh.packages.len(),
        "manualRefreshThrottled": refresh.manually_throttled,
        "retryAfterSeconds": refresh.retry_after_seconds,
        "stats": service.request_stats().await,
    }))
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
    let package = service
        .get_package(&package_uuid, game_id.as_deref())
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "Package not found".to_string())?;
    let label = package
        .get("name")
        .and_then(|value| value.as_str())
        .map(|name| format!("{}.zip", name))
        .unwrap_or_else(|| format!("{}.zip", package_uuid));
    let icon_url = package
        .get("versions")
        .and_then(|value| value.as_array())
        .and_then(|versions| {
            version_uuid
                .as_deref()
                .and_then(|selected_uuid| {
                    versions.iter().find(|version| {
                        version
                            .get("uuid4")
                            .and_then(|value| value.as_str())
                            == Some(selected_uuid)
                    })
                })
                .or_else(|| versions.first())
        })
        .and_then(|version| version.get("icon").and_then(|value| value.as_str()))
        .or_else(|| package.get("latest").and_then(|latest| latest.get("icon")).and_then(|value| value.as_str()))
        .or_else(|| package.get("icon").and_then(|value| value.as_str()))
        .or_else(|| package.get("icon_url").and_then(|value| value.as_str()))
        .map(|value| value.to_string());
    let tracked_download = crate::services::tracked_downloads::start_file_download_with_icon(
        crate::services::tracked_downloads::new_download_id("thunderstore"),
        crate::types::TrackedDownloadKind::Mod,
        label,
        "Thunderstore",
        icon_url,
        None,
        Some("Downloading archive".to_string()),
    );
    let _ = crate::services::tracked_downloads::emit(&app, tracked_download.clone());

    let bytes = service
        .download_package_version(&package, version_uuid.as_deref())
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
    let version_suffix = version_uuid
        .as_deref()
        .map(sanitize_temp_component)
        .map(|value| format!("-{}", value))
        .unwrap_or_default();
    let temp_file = temp_dir.join(format!(
        "thunderstore-{}{}.zip",
        package_uuid, version_suffix
    ));
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

#[tauri::command]
pub async fn get_thunderstore_request_stats(
    db: State<'_, Arc<SqlitePool>>,
) -> Result<serde_json::Value, String> {
    let service = get_thunderstore_service(db.inner().clone()).await?;
    serde_json::to_value(service.request_stats().await).map_err(|e| e.to_string())
}
