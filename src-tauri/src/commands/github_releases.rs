use crate::services::github_releases::GitHubReleasesService;
use sqlx::SqlitePool;
use std::sync::Arc;
use tauri::State;

fn github_service(_db: State<'_, Arc<SqlitePool>>) -> GitHubReleasesService {
    GitHubReleasesService::new()
}

async fn get_latest_release_logged(
    service: &GitHubReleasesService,
    owner: &str,
    repo: &str,
) -> Result<Option<serde_json::Value>, String> {
    log::debug!("Fetching latest release metadata for {}/{}", owner, repo);

    match service.get_latest_release(owner, repo, false).await {
        Ok(release) => {
            if let Some(tag_name) = release
                .as_ref()
                .and_then(|value| value.get("tag_name"))
                .and_then(|value| value.as_str())
            {
                log::debug!(
                    "Resolved latest release metadata for {}/{} as {}",
                    owner,
                    repo,
                    tag_name
                );
            } else {
                log::warn!("No latest release metadata returned for {}/{}", owner, repo);
            }
            Ok(release)
        }
        Err(error) => {
            log::error!(
                "Failed to fetch latest release metadata for {}/{}: {}",
                owner,
                repo,
                error
            );
            Err(error.to_string())
        }
    }
}

async fn get_all_releases_logged(
    service: &GitHubReleasesService,
    owner: &str,
    repo: &str,
) -> Result<Vec<serde_json::Value>, String> {
    log::debug!("Fetching all release metadata for {}/{}", owner, repo);

    match service.get_all_releases_with_latest(owner, repo, false).await {
        Ok(releases) => {
            log::debug!(
                "Resolved {} release entries for {}/{}",
                releases.len(),
                owner,
                repo
            );
            Ok(releases)
        }
        Err(error) => {
            log::error!(
                "Failed to fetch release list for {}/{}: {}",
                owner,
                repo,
                error
            );
            Err(error.to_string())
        }
    }
}

#[tauri::command]
pub async fn get_latest_melon_loader_release(
    db: State<'_, Arc<SqlitePool>>,
) -> Result<Option<serde_json::Value>, String> {
    let service = github_service(db);
    get_latest_release_logged(&service, "LavaGang", "MelonLoader").await
}

#[tauri::command]
pub async fn get_all_melon_loader_releases(
    db: State<'_, Arc<SqlitePool>>,
) -> Result<Vec<serde_json::Value>, String> {
    let service = github_service(db);
    get_all_releases_logged(&service, "LavaGang", "MelonLoader").await
}

#[tauri::command]
pub async fn get_latest_s1api_release(
    db: State<'_, Arc<SqlitePool>>,
) -> Result<Option<serde_json::Value>, String> {
    let service = github_service(db);
    get_latest_release_logged(&service, "ifBars", "S1API").await
}

#[tauri::command]
pub async fn get_all_s1api_releases(
    db: State<'_, Arc<SqlitePool>>,
) -> Result<Vec<serde_json::Value>, String> {
    let service = github_service(db);
    get_all_releases_logged(&service, "ifBars", "S1API").await
}

#[tauri::command]
pub async fn get_latest_mlvscan_release(
    db: State<'_, Arc<SqlitePool>>,
) -> Result<Option<serde_json::Value>, String> {
    let service = github_service(db);
    get_latest_release_logged(&service, "ifBars", "MLVScan").await
}

#[tauri::command]
pub async fn get_all_mlvscan_releases(
    db: State<'_, Arc<SqlitePool>>,
) -> Result<Vec<serde_json::Value>, String> {
    let service = github_service(db);
    get_all_releases_logged(&service, "ifBars", "MLVScan").await
}

#[tauri::command]
pub async fn get_release_api_health(
    db: State<'_, Arc<SqlitePool>>,
) -> Result<serde_json::Value, String> {
    let service = github_service(db);
    service.get_health().await.map_err(|e| e.to_string())
}
