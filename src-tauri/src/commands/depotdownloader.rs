use crate::types::DepotDownloaderInfo;

#[tauri::command]
pub async fn detect_depot_downloader() -> Result<DepotDownloaderInfo, String> {
    crate::utils::depot_downloader_detector::detect_depot_downloader()
        .await
        .map_err(|e| e.to_string())
}

